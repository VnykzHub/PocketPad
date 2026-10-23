/**
 * Game lifecycle owner (D3-SDK-01, D3-RT-04; FR-7.17, FR-9.1, FR-9.2).
 *
 * `GameHost` binds one loaded `Game` to the fixed loop:
 *
 *   idle → start(): init(ctx) → playing ⇄ paused → dispose() → disposed
 *                    └─ init/simulate/render throws → failed (loop stopped)
 *
 * Per tick the loop polls the mapper once and calls the bound `simulate`
 * hook, which integrates tilt for every slot, updates the input reader, drains
 * the event queue (delivering `onEvent` before `simulate`) and runs
 * `game.simulate`. `render` runs once per frame. Hooks are bound at
 * construction, so the frame path allocates nothing beyond what the game
 * itself does (PR-9.3).
 *
 * The host passes only the `GameContext`; the host client, sockets and DOM
 * never reach the game (FR-7.17). `dispose()` is idempotent and always stops
 * the loop before calling `game.dispose()` exactly once.
 */
import type {
  AssetLibrary,
  Game,
  GameAudio,
  GameContext,
  GameDebug,
  GameRenderer3D,
  GameWorld3D,
  JsonValue,
  SaveApi,
} from "@lanpad/sdk";
import type { InputMapper } from "../input/InputMapper.js";
import { TiltIntegrator } from "../input/TiltIntegrator.js";
import type { InputSnapshot } from "../input/types.js";
import { FixedLoop } from "../loop/FixedLoop.js";
import type { FrameStats, LoopHooks } from "../loop/types.js";
import { createGameContext, takePendingSave } from "./GameContext.js";
import { GameEventQueue, SnapshotInputReader } from "./InputReader.js";

export type GameHostPhase = "idle" | "starting" | "playing" | "paused" | "failed" | "disposed";

/** Optional pause/resume an audio bus may offer (AudioBus does). */
export interface PausableAudio extends GameAudio {
  pause?(): void;
  resume?(): unknown;
}

export interface GameHostDeps {
  readonly game: Game;
  readonly renderer: GameRenderer3D;
  readonly audio: PausableAudio;
  readonly mapper: InputMapper;
  readonly now: () => number;
  readonly raf: (cb: (t: number) => void) => number;
  readonly cancel: (id: number) => void;
  readonly serverNow?: () => number | null;
  readonly debug?: GameDebug;
  readonly seed?: number;
  readonly eventCapacity?: number;
  /** Host-provided save API; absent means the game runs without persistence. */
  readonly save?: SaveApi;
  /** Manifest slug; binds the installed save capability (stage knows it). */
  readonly gameId?: string;
  /** Spec-23 asset library; absent when the game has no `assets.json`. */
  readonly assets?: AssetLibrary;
  /** Spec-22 world; advanced once per fixed tick and disposed by the host. */
  readonly world?: GameWorld3D;
  /** Receives the loop's reused stats object (overlay, dynamic resolution). */
  readonly onFrameStats?: (stats: FrameStats) => void;
  /** Called once when the game throws; the loop is already stopped. */
  readonly onError?: (error: unknown) => void;
}

const noServerTime = (): number | null => null;
/** Protocol maximum; the host keeps one tilt integrator per slot (D6-RT-01). */
const TILT_SLOT_COUNT = 8;

export class GameHost {
  readonly game: Game;
  readonly loop: FixedLoop;
  readonly events: GameEventQueue;
  readonly input: SnapshotInputReader;

  private contextValue: GameContext;
  private readonly audio: PausableAudio;
  private readonly world: GameWorld3D | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly tiltIntegrators: TiltIntegrator[] = [];
  private phaseValue: GameHostPhase = "idle";
  private errorValue: unknown = null;

  constructor(deps: GameHostDeps) {
    this.game = deps.game;
    this.audio = deps.audio;
    this.world = deps.world;
    this.onError = deps.onError;
    for (let slot = 0; slot < TILT_SLOT_COUNT; slot += 1) {
      this.tiltIntegrators.push(new TiltIntegrator());
    }
    this.events = new GameEventQueue(deps.eventCapacity);
    this.input = new SnapshotInputReader(this.events);
    this.contextValue = createGameContext({
      manifest: deps.game.manifest,
      input: this.input,
      renderer: deps.renderer,
      audio: deps.audio,
      serverNow: deps.serverNow ?? noServerTime,
      ...(deps.debug === undefined ? {} : { debug: deps.debug }),
      ...(deps.seed === undefined ? {} : { seed: deps.seed }),
      ...(deps.save === undefined ? {} : { save: deps.save }),
      ...(deps.gameId === undefined ? {} : { gameId: deps.gameId }),
      ...(deps.assets === undefined ? {} : { assets: deps.assets }),
      ...(deps.world === undefined ? {} : { world: deps.world }),
    });

    const onFrameStats = deps.onFrameStats;
    const hooks: LoopHooks = {
      simulate: this.simulateTick,
      render: this.renderFrame,
      ...(onFrameStats === undefined ? {} : { onFrameStats }),
    };
    this.loop = new FixedLoop(hooks, {
      now: deps.now,
      raf: deps.raf,
      cancel: deps.cancel,
      mapper: deps.mapper,
    });
  }

  /**
   * The game context. It is rebuilt once during `start()` if an installed
   * save provider was async and resolved a store, so `game.init` always sees
   * the final `ctx.save` (15 §5.5).
   */
  get context(): GameContext {
    return this.contextValue;
  }

  get phase(): GameHostPhase {
    return this.phaseValue;
  }

  /** The error that moved the host to `failed`, else null. */
  get error(): unknown {
    return this.errorValue;
  }

  /**
   * Runs `game.init(ctx)` then starts the loop. Rejects (and moves to
   * `failed`) if init throws; a second call is a no-op.
   */
  async start(): Promise<void> {
    if (this.phaseValue !== "idle") return;
    this.phaseValue = "starting";
    try {
      // An async save provider (OPFS/IndexedDB open) resolves before init;
      // failure leaves `ctx.save` undefined rather than failing the game.
      const pendingSave = takePendingSave(this.contextValue);
      if (pendingSave !== undefined) {
        const save = await pendingSave;
        if (this.phaseValue !== "starting") return; // disposed while opening
        if (save !== undefined) {
          this.contextValue = Object.freeze({ ...this.contextValue, save });
        }
      }
      await this.game.init(this.contextValue);
    } catch (error) {
      this.fail(error);
      throw error;
    }
    if (this.phaseValue !== "starting") return; // disposed during init
    this.phaseValue = "playing";
    this.loop.start();
  }

  /** Stops simulation (hidden tab, menus); frames keep rendering. */
  pause(): void {
    if (this.phaseValue !== "playing") return;
    this.phaseValue = "paused";
    this.loop.pause();
    this.audio.pause?.();
  }

  resume(): void {
    if (this.phaseValue !== "paused") return;
    this.phaseValue = "playing";
    this.loop.resume();
    void this.audio.resume?.();
  }

  /** Queues a controller event for the next tick (D5 routes server events here). */
  pushEvent(slot: number, name: string, data: JsonValue): void {
    this.events.push(slot, name, data);
  }

  /** Idempotent: stops the loop, then calls `game.dispose()` once. */
  dispose(): void {
    if (this.phaseValue === "disposed") return;
    this.phaseValue = "disposed";
    this.loop.stop();
    this.events.clear();
    try {
      this.game.dispose();
    } catch {
      // A throwing dispose must not block host teardown.
    }
    try {
      // Spec 22 §3: the host disposes the world exactly once; both the game
      // and the host may call it, so `dispose()` is idempotent.
      this.world?.dispose();
    } catch {
      // World teardown must not block host teardown either.
    }
  }

  private fail(error: unknown): void {
    if (this.phaseValue === "failed" || this.phaseValue === "disposed") return;
    this.phaseValue = "failed";
    this.errorValue = error;
    this.loop.stop();
    this.onError?.(error);
  }

  private readonly simulateTick = (dt: number, snapshot: InputSnapshot): void => {
    if (this.phaseValue !== "playing") return;
    try {
      // Spec 22 §3: clips and camera follow advance once per fixed tick,
      // before the game's simulate sees the world.
      this.world?.update(dt);
      this.updateTilt(dt, snapshot);
      this.input.update(snapshot);
      const events = this.events.drain();
      const onEvent = this.game.onEvent;
      if (onEvent !== undefined) {
        for (let index = 0; index < events.length; index += 1) {
          const event = events[index];
          if (event !== undefined) onEvent.call(this.game, event.slot, event.name, event.data);
        }
      }
      this.game.simulate(dt, snapshot);
    } catch (error) {
      this.fail(error);
    }
  };

  /**
   * Advances one `TiltIntegrator` per slot and publishes the pooled angles into
   * the player state before `game.simulate` (D6-RT-01; FR-7.5, FR-8.5).
   *
   * `InputMapper` already pools a `tilt` object on every slot, so the frame
   * path only copies three numbers. A snapshot from another source (trace
   * replay, test fake) may omit it; then the integrator's own pooled state is
   * attached once by reference, which also allocates nothing per tick.
   */
  private updateTilt(dt: number, snapshot: InputSnapshot): void {
    const players = snapshot.players;
    const integrators = this.tiltIntegrators;
    const count = Math.min(players.length, integrators.length);
    for (let index = 0; index < count; index += 1) {
      const player = players[index];
      const integrator = integrators[index];
      if (player === undefined || integrator === undefined) {
        continue;
      }
      const tilt = integrator.update(player, dt);
      const target = player.tilt;
      if (target === undefined) {
        player.tilt = tilt;
      } else {
        target.angleX = tilt.angleX;
        target.angleY = tilt.angleY;
        target.available = tilt.available;
      }
    }
  }

  private readonly renderFrame = (alpha: number): void => {
    if (this.phaseValue !== "playing" && this.phaseValue !== "paused") return;
    try {
      this.game.render(alpha);
    } catch (error) {
      this.fail(error);
    }
  };
}

/** Minimal `document` surface for visibility handling (tests pass a fake). */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface Pausable {
  pause(): void;
  resume(): void;
}

/**
 * Pauses on `visibilitychange` → hidden and resumes when visible again
 * (FR-9.2). The loop itself never reads the DOM; this adapter does. Returns a
 * detach function.
 */
export function attachVisibilityPause(source: VisibilitySource, target: Pausable): () => void {
  const listener = (): void => {
    if (source.hidden) {
      target.pause();
    } else {
      target.resume();
    }
  };
  source.addEventListener("visibilitychange", listener);
  return () => source.removeEventListener("visibilitychange", listener);
}

/**
 * Coin Run host adapter (GAME-PF-01/03/04; D3-SDK-01, A12).
 *
 * This is the module `loadGame` imports from `game.manifest.json`: a default
 * `(manifest) => Game` factory. It consumes `GameContext` only (FR-7.17):
 * presence comes from `GameControllerState.connected`, layouts go through
 * `ctx.layouts`, movement/coins/checkpoints/goal run on the fixed simulation
 * tick, and drawing goes through the flat 2D surface `render.ts` resolves.
 *
 * Round flow (GAME-PF-04):
 *
 *   lobby -> countdown -> playing -> results -> (rematch) countdown
 *
 * The match starts when the manifest's `minPlayers` connected slots are
 * present, so a fresh phone with a tick-0 all-zero packet is enough. During
 * `playing` only connected slots are simulated; a slot that disconnects has
 * its layout cleared and its body idled, and a later packet re-applies the
 * layout once (FR-8.2, FR-5.4). The first goal touch freezes play and opens
 * the results screen for every player; any A/B/X/Y edge during results, or a
 * `rematch` controller event, resets the pooled world in place (PR-9.4).
 *
 * The adapter owns all mutable state and reuses every object per tick: one
 * `World`, one `CameraState`, one `HudCache`, pooled commands/contacts and a
 * reused render state. `simulate` and `render` allocate nothing.
 */
import type {
  Game,
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameManifest,
  JsonValue,
} from "@lanpad/sdk";
import { CAMERA_FALLBACK_ASPECT, createCamera, updateCamera } from "./camera.js";
import type { CameraState } from "./camera.js";
import { COIN_RUN_CONFIG } from "./config.js";
import { buildResultsContent, HudCache, type ResultsContent } from "./hud.js";
import { readCommand } from "./input.js";
import levelData from "./level-01.json";
import { validateLevel } from "./level.js";
import { stepPlayer } from "./player.js";
import { drawCoinRun, resolveRenderer2D, type Renderer2DLike } from "./render.js";
import type { CoinRunRenderState } from "./render.js";
import { World } from "./world.js";

/** Layout document ids shipped in `layouts/` (GAME-PF-01). */
export const PF_DPAD_LAYOUT_ID = "pf-dpad-v1";
export const PF_STICK_LAYOUT_ID = "pf-stick-v1";

/** Countdown length before play and after a rematch, in milliseconds. */
export const COIN_RUN_COUNTDOWN_MS = 3000;

/** Coarse round phase; mirrors the plan's four phases. */
export type CoinRunPhase = "lobby" | "countdown" | "playing" | "results";

/** Rematch accepts any A/B/X/Y edge, the same mask the phone layouts expose. */
const ACTION_BUTTON_MASK = 0x0f;

/** Phase codes for the debug overlay (stable across releases). */
const PHASE_CODE: Record<CoinRunPhase, number> = {
  lobby: 0,
  countdown: 1,
  playing: 2,
  results: 3,
};

/**
 * Layout assignment for a 1-based slot. Slots alternate the d-pad and stick
 * documents so a two-player couch always exercises both shipped layouts; the
 * ids themselves come from the manifest files, never from a slug switch.
 */
export function layoutIdForSlot(slot: number): string {
  return slot % 2 === 1 ? PF_DPAD_LAYOUT_ID : PF_STICK_LAYOUT_ID;
}

/** Optional factory arguments for tests and per-scene tuning. */
export interface CoinRunGameOptions {
  /** Level override; defaults to the shipped `level-01.json`. */
  readonly level?: unknown;
  /** Overrides `COIN_RUN_COUNTDOWN_MS`; 0 starts play immediately. */
  readonly countdownMs?: number;
  /** Camera aspect override; defaults to the 16:9 TV profile. */
  readonly aspect?: number;
}

/** The adapter's observable state, used by tests and the debug overlay. */
export interface CoinRunGame extends Game {
  /** The running world after `init`, null before init and after dispose. */
  readonly world: World | null;
  readonly phase: CoinRunPhase;
  /** Results content after the first goal touch, null otherwise. */
  readonly lastResults: ResultsContent | null;
  /** Slots whose layout has been requested, in request order. */
  readonly laidOutSlots: ReadonlyArray<number>;
  /** One bit per connected slot (bit N = slot N). */
  readonly connectedMask: number;
  /** Team coin count collected this round. */
  readonly coinsCollected: number;
  /** Per-slot coin contributions indexed by slot - 1. */
  readonly scores: ReadonlyArray<number>;
  /** Milliseconds of `playing` time this round. */
  readonly elapsedMs: number;
}

/** Reused camera target; `updateCamera` reads it without allocating. */
interface MutableCameraTarget {
  x: number;
  active: boolean;
  connected: boolean;
}

/** Mutable view of the render state the game owns and refills per frame. */
type MutableRenderState = {
  -readonly [K in keyof CoinRunRenderState]: CoinRunRenderState[K];
};

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * A slot participates while its controller is connected (FR-8.2). The flag is
 * set by the first accepted packet even when its tick and state are zero, so
 * presence never depends on input values or clock sync.
 */
function isConnectedSlot(player: GameControllerState, maxPlayers: number): boolean {
  return (
    player.connected &&
    Number.isInteger(player.slot) &&
    player.slot >= 1 &&
    player.slot <= maxPlayers
  );
}

/**
 * Creates the Coin Run `Game`. The default export is the frozen `GameModule`
 * shape; the optional second argument exists for tests only.
 */
export function createCoinRunGame(
  manifest: GameManifest,
  options: CoinRunGameOptions = {},
): CoinRunGame {
  const maxPlayers = Math.max(
    1,
    Math.min(manifest.maxPlayers, COIN_RUN_CONFIG.maxPlayers),
  );
  const configuredCountdown = options.countdownMs;
  const countdownMs =
    configuredCountdown !== undefined && isFiniteNonNegative(configuredCountdown)
      ? configuredCountdown
      : COIN_RUN_COUNTDOWN_MS;
  const aspect = options.aspect ?? CAMERA_FALLBACK_ASPECT;

  let ctx: GameContext | null = null;
  let world: World | null = null;
  let camera: CameraState | null = null;
  let hud: HudCache | null = null;
  let surface: Renderer2DLike | null = null;
  let renderState: MutableRenderState | null = null;
  let disposed = false;

  let phase: CoinRunPhase = "lobby";
  let countdownRemainingMs = 0;
  let elapsedMs = 0;
  let connectedMask = 0;
  let connectedCount = 0;
  /** One bit per slot that currently has the layout applied. */
  let seenMask = 0;
  let layoutErrorCount = 0;
  let lastResults: ResultsContent | null = null;

  /** Per-slot coin contributions; indexed by slot - 1 (GAME-PF-04). */
  const scores: number[] = [];
  const laidOutSlots: number[] = [];
  const cameraTargets: MutableCameraTarget[] = [];
  for (let index = 0; index < COIN_RUN_CONFIG.maxPlayers; index += 1) {
    scores.push(0);
    cameraTargets.push({ x: 0, active: false, connected: false });
  }

  function applyLayout(slot: number): void {
    laidOutSlots.push(slot);
    const layouts = ctx?.layouts;
    if (layouts === undefined) return;
    try {
      layouts.set(slot, layoutIdForSlot(slot));
    } catch {
      // A missing layout API must never break the match (D5 seam).
      layoutErrorCount += 1;
    }
  }

  function clearLayout(slot: number): void {
    const layouts = ctx?.layouts;
    if (layouts === undefined) return;
    try {
      layouts.clear(slot);
    } catch {
      layoutErrorCount += 1;
    }
  }

  /** Stops an idle body when its controller leaves; nothing is destroyed. */
  function idlePlayer(slot: number): void {
    const player = world?.players[slot - 1];
    if (player === undefined) return;
    player.command.moveX = 0;
    player.command.jumpPressed = false;
    player.body.vx = 0;
    player.body.vy = 0;
  }

  /**
   * Tracks connection edges from this tick's snapshot. `seenMask` guarantees
   * exactly one layout request per connection and one clear per disconnect,
   * with no allocation on the per-tick path (FR-8.2, FR-5.4).
   */
  function observePlayers(input: GameInputSnapshot): void {
    const players = input.players;
    let presentMask = 0;
    let presentCount = 0;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      const bit = 1 << player.slot;
      if ((presentMask & bit) !== 0) continue;
      presentMask |= bit;
      presentCount += 1;
      if ((seenMask & bit) !== 0) continue;
      seenMask |= bit;
      applyLayout(player.slot);
    }

    let gone = seenMask & ~presentMask;
    while (gone !== 0) {
      const bit = gone & -gone;
      gone &= gone - 1;
      const slot = 31 - Math.clz32(bit);
      seenMask &= ~bit;
      clearLayout(slot);
      idlePlayer(slot);
    }

    connectedMask = presentMask;
    connectedCount = presentCount;
  }

  function updateCameraTargets(): void {
    if (world === null) return;
    for (let index = 0; index < cameraTargets.length; index += 1) {
      const target = cameraTargets[index];
      const player = world.players[index];
      if (target === undefined || player === undefined) continue;
      target.x = player.body.x;
      target.active = player.body.active;
      target.connected = (connectedMask & (1 << (index + 1))) !== 0;
    }
  }

  function beginCountdown(): void {
    phase = "countdown";
    countdownRemainingMs = countdownMs;
  }

  function finishRound(): void {
    const current = world;
    if (current === null) return;
    phase = "results";
    lastResults = buildResultsContent(
      current.coinsCollected,
      current.coins.length,
      elapsedMs,
      scores,
      connectedMask,
    );
  }

  /** Resets level, coins, checkpoints, score and time in place (PR-9.4). */
  function rematch(): void {
    if (world === null) return;
    world.reset();
    for (let index = 0; index < scores.length; index += 1) {
      scores[index] = 0;
    }
    elapsedMs = 0;
    lastResults = null;
    beginCountdown();
  }

  /** Advances every connected slot once; first goal touch ends the round. */
  function stepPlayers(input: GameInputSnapshot, dt: number): void {
    const current = world;
    if (current === null) return;
    const players = input.players;
    for (let index = 0; index < players.length; index += 1) {
      const inputState = players[index];
      if (inputState === undefined || !isConnectedSlot(inputState, maxPlayers)) continue;
      const player = current.players[inputState.slot - 1];
      if (player === undefined || !player.body.active) continue;

      readCommand(inputState, player.command);
      stepPlayer(player, current, dt);
      const collected = current.collectCoins(player);
      if (collected > 0) {
        scores[inputState.slot - 1] = (scores[inputState.slot - 1] ?? 0) + collected;
      }
      current.activateCheckpoint(player);
      if (current.reachGoal(player)) {
        finishRound();
        return;
      }
    }
  }

  /** True when any connected slot carries an A/B/X/Y press edge this tick. */
  function hasActionPress(input: GameInputSnapshot): boolean {
    const players = input.players;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      if ((player.edges & ACTION_BUTTON_MASK) !== 0) return true;
    }
    return false;
  }

  function updateDebug(): void {
    if (ctx === null || world === null) return;
    ctx.debug.setCounter("players", connectedCount);
    ctx.debug.setCounter("coins", world.coinsCollected);
    ctx.debug.setCounter("phase", PHASE_CODE[phase]);
    ctx.debug.setCounter("layoutErrors", layoutErrorCount);
  }

  const game: CoinRunGame = {
    manifest,

    get world(): World | null {
      return world;
    },
    get phase(): CoinRunPhase {
      return phase;
    },
    get lastResults(): ResultsContent | null {
      return lastResults;
    },
    get laidOutSlots(): ReadonlyArray<number> {
      return laidOutSlots;
    },
    get connectedMask(): number {
      return connectedMask;
    },
    get coinsCollected(): number {
      return world?.coinsCollected ?? 0;
    },
    get scores(): ReadonlyArray<number> {
      return scores;
    },
    get elapsedMs(): number {
      return elapsedMs;
    },

    init(context: GameContext): void {
      ctx = context;
      disposed = false;
      surface = resolveRenderer2D(context.renderer);
      phase = "lobby";
      countdownRemainingMs = 0;
      elapsedMs = 0;
      connectedMask = 0;
      connectedCount = 0;
      seenMask = 0;
      layoutErrorCount = 0;
      lastResults = null;
      laidOutSlots.length = 0;
      for (let index = 0; index < scores.length; index += 1) {
        scores[index] = 0;
      }

      const validation = validateLevel(options.level ?? levelData);
      if (!validation.ok) {
        throw new Error(`Coin Run level is invalid: ${validation.errors.join("; ")}`);
      }
      const built = new World(validation.level);
      world = built;
      const view = createCamera(validation.level.width, aspect);
      camera = view;
      const cache = new HudCache(maxPlayers);
      hud = cache;
      renderState = {
        world: built,
        camera: view,
        hud: cache,
        phase,
        elapsedMs: 0,
        countdownMs: 0,
        results: null,
        connectedMask: 0,
        scores,
      };
      updateCameraTargets();
      updateDebug();
    },

    simulate(dt: number, input: GameInputSnapshot): void {
      if (disposed || world === null || camera === null) return;
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

      observePlayers(input);
      updateCameraTargets();
      updateCamera(camera, step, cameraTargets, cameraTargets.length);

      if (phase === "results") {
        if (hasActionPress(input)) rematch();
        updateDebug();
        return;
      }

      if (phase === "lobby" && connectedCount >= manifest.minPlayers) {
        beginCountdown();
      }

      if (phase === "countdown") {
        countdownRemainingMs -= step * 1000;
        if (countdownRemainingMs <= 0) {
          countdownRemainingMs = 0;
          phase = "playing";
          elapsedMs = 0;
        }
      }

      if (phase === "playing" && step > 0) {
        elapsedMs += step * 1000;
        stepPlayers(input, step);
      }

      updateDebug();
    },

    render(alpha: number): void {
      const state = renderState;
      if (
        disposed ||
        state === null ||
        world === null ||
        camera === null ||
        hud === null ||
        surface === null
      ) {
        return;
      }
      const blend = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
      state.world = world;
      state.camera = camera;
      state.hud = hud;
      state.phase = phase;
      state.elapsedMs = elapsedMs;
      state.countdownMs = countdownRemainingMs;
      state.results = lastResults;
      state.connectedMask = connectedMask;
      state.scores = scores;
      drawCoinRun(surface, state, blend);
    },

    onEvent(slot: number, name: string, data: JsonValue): void {
      void slot;
      void data;
      if (disposed) return;
      if (name === "rematch" && phase === "results") {
        rematch();
      } else if (name === "start" && phase === "lobby") {
        beginCountdown();
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      world = null;
      camera = null;
      hud = null;
      surface = null;
      renderState = null;
      ctx = null;
      connectedMask = 0;
      connectedCount = 0;
      seenMask = 0;
    },
  };

  return game;
}

/** Frozen `GameModule` shape consumed by `loadGame`. */
export default createCoinRunGame;

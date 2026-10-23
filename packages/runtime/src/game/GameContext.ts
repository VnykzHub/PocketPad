/**
 * The game-facing context (D3-RT-04; FR-7.17, G8).
 *
 * `createGameContext` assembles exactly the members of the SDK's
 * `GameContext`: input reader, renderer, audio, seeded RNG, debug counters,
 * capability stubs and `serverNow()`. It is frozen and carries no socket,
 * `ws`, `fetch` or DOM reference; the host client stays in `main.ts`.
 *
 * D5/D6 capabilities (`panels`, `layouts`, `haptics`, `events`) are owned by
 * the host shell, which calls `installRuntimeCapabilities()` before the game
 * starts. Explicit deps win over the registry. Until a capability is
 * installed, calling it throws `CapabilityUnavailableError` so a game fails
 * loudly instead of silently doing nothing.
 *
 * `save` (spec 15) is different: it is optional in the SDK contract and
 * has no throwing fallback. When the host cannot provide storage the member
 * is absent and the game feature-detects `ctx.save === undefined` (15 §3.8).
 */
import type {
  GameAudio,
  GameContext,
  GameDebug,
  GameEvents,
  GameHaptics,
  GameLayouts,
  GameManifest,
  GamePanels,
  GameRenderer3D,
  GameRng,
  SaveApi,
} from "@lanpad/sdk";
import type { SnapshotInputReader } from "./InputReader.js";

export class CapabilityUnavailableError extends Error {
  constructor(capability: string, stage: string) {
    super(`ctx.${capability} is not available until ${stage}.`);
    this.name = "CapabilityUnavailableError";
  }
}

/**
 * mulberry32: tiny, fast, deterministic 32-bit PRNG. Same seed → same
 * sequence, which replays and trace tests rely on.
 */
export function createRng(seed: number): GameRng {
  const initial = seed >>> 0;
  let state = initial;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed: initial,
    next,
    int(min: number, max: number): number {
      const low = Math.ceil(Math.min(min, max));
      const high = Math.floor(Math.max(min, max));
      return low + Math.floor(next() * (high - low + 1));
    },
  };
}

/** Debug counters; the overlay reads `counters` (D7 extends the display). */
export interface GameDebugCounters extends GameDebug {
  readonly counters: ReadonlyMap<string, number>;
}

export function createDebugCounters(enabled: boolean): GameDebugCounters {
  const counters = new Map<string, number>();
  return {
    enabled,
    counters,
    setCounter(name: string, value: number): void {
      if (!enabled) return;
      counters.set(name, value);
    },
  };
}

const unavailablePanels: GamePanels = Object.freeze({
  set(): void {
    throw new CapabilityUnavailableError("panels", "D5");
  },
  show(): void {
    throw new CapabilityUnavailableError("panels", "D5");
  },
  clear(): void {
    throw new CapabilityUnavailableError("panels", "D5");
  },
});

const unavailableLayouts: GameLayouts = Object.freeze({
  set(): void {
    throw new CapabilityUnavailableError("layouts", "D5");
  },
  clear(): void {
    throw new CapabilityUnavailableError("layouts", "D5");
  },
});

const unavailableHaptics: GameHaptics = Object.freeze({
  pulse(): void {
    throw new CapabilityUnavailableError("haptics", "D6");
  },
});

const unavailableEvents: GameEvents = Object.freeze({
  on(): () => void {
    throw new CapabilityUnavailableError("events", "D5");
  },
  onAny(): () => void {
    throw new CapabilityUnavailableError("events", "D5");
  },
});

/** The D5/D7 event surface added to the runtime context. */
export interface RuntimeGameContext extends GameContext {
  /** Named controller-event subscriptions (D5 contract 7). */
  readonly events: GameEvents;
}

/** Context a save provider needs to bind storage to the running game. */
export interface SaveCapabilityContext {
  readonly manifest: GameManifest;
  /** Host-resolved manifest slug; absent means no persistence. */
  readonly gameId?: string;
}

/** A provider may open storage asynchronously; `undefined` means no save. */
export type SaveCapabilityResult =
  | SaveApi
  | undefined
  | Promise<SaveApi | undefined>;

/**
 * Either a ready `SaveApi` or a per-game factory. Hosts that only know the
 * game id when the stage opens pass the factory (15 §3.8: no throwing stub).
 * An async factory is resolved by `GameHost` before `game.init`, so a store
 * that cannot open leaves `ctx.save` undefined (15 §5.5 tier 3).
 */
export type SaveCapability =
  | SaveApi
  | ((context: SaveCapabilityContext) => SaveCapabilityResult);

/** Live capabilities the host shell installs before the game starts. */
export interface RuntimeCapabilities {
  readonly panels?: GamePanels;
  readonly layouts?: GameLayouts;
  readonly haptics?: GameHaptics;
  readonly events?: GameEvents;
  readonly save?: SaveCapability;
}

let installedCapabilities: RuntimeCapabilities = {};

/**
 * Installs the host-owned D5/D6 capabilities for subsequently created game
 * contexts. Call once from the host shell before `gameHost.start()`.
 */
export function installRuntimeCapabilities(capabilities: RuntimeCapabilities): void {
  installedCapabilities = { ...capabilities };
}

/** Removes installed capabilities (host teardown or tests). */
export function clearRuntimeCapabilities(): void {
  installedCapabilities = {};
}

/**
 * Internal handoff for an async save provider. The promise never rejects:
 * a failed open means "no persistence", not a failed game boot. `GameHost`
 * awaits it before `game.init` and then rebuilds the frozen context with the
 * resolved member.
 */
const pendingSaves = new WeakMap<
  GameContext,
  Promise<SaveApi | undefined>
>();

/** Internal: the pending async save result for `context`, if any. */
export function takePendingSave(
  context: GameContext,
): Promise<SaveApi | undefined> | undefined {
  return pendingSaves.get(context);
}

function isPromiseLike(
  value: unknown,
): value is PromiseLike<SaveApi | undefined> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export interface GameContextDeps {
  readonly manifest: GameManifest;
  readonly input: SnapshotInputReader;
  readonly renderer: GameRenderer3D;
  readonly audio: GameAudio;
  /** Host clock → server clock; the host client supplies it, not the game. */
  readonly serverNow: () => number | null;
  readonly debug?: GameDebug;
  /** RNG seed; defaults to 1 so tests are deterministic. */
  readonly seed?: number;
  readonly panels?: GamePanels;
  readonly layouts?: GameLayouts;
  readonly haptics?: GameHaptics;
  readonly events?: GameEvents;
  /** Explicit save API; wins over an installed save capability. */
  readonly save?: SaveApi;
  /** Host-resolved manifest slug, used to bind an installed save provider. */
  readonly gameId?: string;
}

export function createGameContext(deps: GameContextDeps): RuntimeGameContext {
  const serverNow = deps.serverNow;
  // A save failure leaves `save` undefined; there is deliberately no
  // throwing fallback (15 §3.8).
  const explicitSave = deps.save;
  const installedSave = installedCapabilities.save;
  let providedSave: SaveApi | undefined;
  let pendingSave: Promise<SaveApi | undefined> | undefined;
  if (explicitSave !== undefined) {
    providedSave = explicitSave;
  } else if (typeof installedSave === "function") {
    try {
      const resolved = installedSave({
        manifest: deps.manifest,
        ...(deps.gameId === undefined ? {} : { gameId: deps.gameId }),
      });
      if (isPromiseLike(resolved)) {
        // GameHost awaits this before `game.init`; a rejection is "no save".
        pendingSave = Promise.resolve(resolved).then(
          (value) => value,
          () => undefined,
        );
      } else {
        providedSave = resolved;
      }
    } catch {
      // A failing provider means "no persistence", never a failed boot.
      providedSave = undefined;
    }
  } else {
    providedSave = installedSave;
  }
  const context: RuntimeGameContext = Object.freeze({
    manifest: deps.manifest,
    input: deps.input,
    renderer: deps.renderer,
    audio: deps.audio,
    rng: createRng(deps.seed ?? 1),
    debug: deps.debug ?? createDebugCounters(false),
    panels: deps.panels ?? installedCapabilities.panels ?? unavailablePanels,
    layouts: deps.layouts ?? installedCapabilities.layouts ?? unavailableLayouts,
    haptics: deps.haptics ?? installedCapabilities.haptics ?? unavailableHaptics,
    events: deps.events ?? installedCapabilities.events ?? unavailableEvents,
    ...(providedSave === undefined ? {} : { save: providedSave }),
    serverNow: (): number | null => serverNow(),
  });
  if (pendingSave !== undefined && providedSave === undefined) {
    pendingSaves.set(context, pendingSave);
  }
  return context;
}

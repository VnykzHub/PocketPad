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
 * starts. `GameHost` is frozen in this wave and constructs the context
 * without dependency overrides, so the registry is the seam; when GameHost
 * gains explicit `panels/layouts/haptics/events` deps, pass them there and
 * drop the registry. Until a capability is installed, calling it throws
 * `CapabilityUnavailableError` so a game fails loudly instead of silently
 * doing nothing.
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

/** Live capabilities the host shell installs before the game starts. */
export interface RuntimeCapabilities {
  readonly panels?: GamePanels;
  readonly layouts?: GameLayouts;
  readonly haptics?: GameHaptics;
  readonly events?: GameEvents;
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
}

export function createGameContext(deps: GameContextDeps): RuntimeGameContext {
  const serverNow = deps.serverNow;
  return Object.freeze({
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
    serverNow: (): number | null => serverNow(),
  });
}

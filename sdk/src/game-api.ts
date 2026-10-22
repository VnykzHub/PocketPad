/**
 * @lanpad/sdk game API (D3-SDK-01; FR-7.17, FR-10.3, G8).
 *
 * This is the whole surface a game sees. A game module default-exports a
 * factory `(manifest) => Game`; the host runtime validates the manifest,
 * imports `entry` relative to it, calls the factory, then drives the game:
 *
 *   init(ctx) once → simulate(dt, input) at a fixed 60 Hz → render(alpha) once
 *   per display frame → dispose() exactly once on unload.
 *
 * Boundary rules:
 * - No socket, fetch, packet or decoder type appears here (FR-7.17). Input is
 *   `GameInputSnapshot`; controller UGC arrives as `GameEvent`s.
 * - The SDK has zero dependencies, so the runtime types are restated
 *   structurally. The runtime type-checks that its concrete renderer, audio
 *   bus and input snapshot satisfy these interfaces.
 * - Pooled objects: the snapshot, player states and events are reused across
 *   ticks. Copy anything you retain past the current call.
 * - D5/D6 fill `panels`, `layouts` and `haptics`; until then they throw a
 *   clear "not available" error. The context shape only grows additively.
 */
import type { LayoutDocument } from "./layout.js";
import type { GameManifest } from "./manifest.js";

/** Opaque JSON payload (controller events, panel content, layouts). */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Host-integrated tilt for one slot (D6-RT-01; FR-7.5, FR-8.5).
 *
 * The controller sends rates only; the host integrates them per game tick, so
 * `angleX`/`angleY` are already in degrees and clamped to ±30°. `available` is
 * false while motion is inactive; the angles then decay toward 0.
 */
export interface GameTiltState {
  /** Integrated pitch in degrees, clamped to ±30°. */
  readonly angleX: number;
  /** Integrated yaw/roll in degrees, clamped to ±30°. */
  readonly angleY: number;
  /** False while motion is inactive (angles decay toward 0). */
  readonly available: boolean;
}

/** Latest mapped input for one slot (SPEC §7.5). */
export interface GameControllerState {
  /** Slot number, 1..8. */
  readonly slot: number;
  /**
   * A controller is connected on this slot (FR-8.2, FR-5.4). True from the
   * first accepted packet, including a tick-0 all-zero packet, until the host
   * resets the slot. Games use this, never `tick` or input heuristics, to
   * decide whether a player is present.
   */
  readonly connected: boolean;
  /** u16 button levels; bit numbers come from the layout (FR-7.2). */
  readonly buttons: number;
  /** u16 press edges since the previous tick; each press is seen once (FR-7.12). */
  readonly edges: number;
  /** Sticks, -1..1. */
  readonly lx: number;
  readonly ly: number;
  readonly rx: number;
  readonly ry: number;
  /** Degrees/second (SPEC §7.5, FR-7.5). */
  readonly gyro: { readonly x: number; readonly y: number; readonly z: number };
  /**
   * Motion data is active for this slot (D6-RT-01; FR-7.6). Offer a non-gyro
   * fallback when it is false.
   */
  readonly gyroActive: boolean;
  /**
   * The controller recentered its gyro in this packet (D6-RT-01; FR-7.6).
   * Level flag: true only until the next packet without it.
   */
  readonly gyroRecentered: boolean;
  /**
   * Host-integrated tilt angles (D6-RT-01; FR-7.5). The runtime host always
   * populates it in game input; optional here so hand-built snapshots (traces,
   * unit fakes) written before D6 still satisfy the type.
   */
  readonly tilt?: GameTiltState;
  /** Triggers, 0..1. */
  readonly triggers: { readonly lt: number; readonly rt: number };
  /** Controller send time on the server clock (A3), not the host tick. */
  readonly tick: number;
}

/** All slots at one host simulation tick. Pooled: copy what you retain. */
export interface GameInputSnapshot {
  /** Host simulation tick. */
  readonly tick: number;
  /** Slots 1..N in fixed order; index = slot - 1. */
  readonly players: ReadonlyArray<GameControllerState>;
}

/** A named controller event (D5 UGC path). `data` is opaque JSON. */
export interface GameEvent {
  readonly slot: number;
  readonly name: string;
  readonly data: JsonValue;
}

/** Read-only view of the tick's input; the loop polls exactly once per tick. */
export interface GameInputReader {
  /** The snapshot passed to the current/last `simulate`. */
  readonly snapshot: GameInputSnapshot;
  /** Returns `snapshot`; polling is done by the host loop, never the game. */
  poll(): GameInputSnapshot;
  /** One slot's state, or undefined outside 1..N. No allocation. */
  player(slot: number): GameControllerState | undefined;
  /** Events drained for this tick; empty until D5 routes controller events. */
  events(): ReadonlyArray<GameEvent>;
}

/** Shared renderer surface a game may use. Sizing is owned by the host. */
export interface GameRendererBase {
  readonly backend: "webgl2" | "canvas2d";
  beginFrame(alpha: number): void;
  endFrame(): void;
  readonly drawCalls: number;
  readonly textureMemoryMB: number;
}

/** 3D API (E12 may swap the backend; games never see which). */
export interface GameRenderer3D extends GameRendererBase {
  setCamera(position: Vec3, target: Vec3): void;
  drawCube(position: Vec3, size: number, color: string, rotationY: number): void;
}

/** Audio after the start-screen gesture (FR-9.11). Silent no-ops while locked. */
export interface GameAudio {
  playSfx(id: string, opts?: { volume?: number; rate?: number }): void;
  playMusic(id: string, opts?: { loop?: boolean; fadeMs?: number }): void;
  stopMusic(fadeMs?: number): void;
  /** AudioContext clock in seconds; schedule rhythm against this (C8). */
  now(): number;
  readonly unlocked: boolean;
  readonly latencyHint: "interactive" | "balanced";
}

/** Seeded deterministic RNG (mulberry32) for replays and tests. */
export interface GameRng {
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
}

/** Per-game debug counters shown by `?debug=1` (D7 extends the overlay). */
export interface GameDebug {
  readonly enabled: boolean;
  setCounter(name: string, value: number): void;
}

/**
 * Private per-slot panels (D5; FR-8.1, FR-8.4, SR-13).
 *
 * Content is addressed to exactly one slot and never broadcast. The
 * controller renders it with `textContent` only, so a game cannot inject
 * markup. `null` is the documented clear value.
 */
export interface GamePanels {
  /** Sets one slot's panel content; `null` clears it. */
  set(slot: number, content: JsonValue): void;
  /** Alias for `set`; kept for D3 callers. */
  show(slot: number, content: JsonValue): void;
  /** Clears one slot's panel (equivalent to `set(slot, null)`). */
  clear(slot: number): void;
}

/** Layout hot-swap (D5; FR-8.2, D5 contracts 1, 2, 7, 8). */
export interface GameLayouts {
  /**
   * Sets one slot's layout or every slot's layout. The document form is
   * validated by the host; the string form addresses a layout the host has
   * registered (typically one of the manifest's `layouts` files).
   */
  set(target: number | "all", layout: LayoutDocument | string): void;
  /**
   * Forgets the host's layout state for the target slots. The protocol has no
   * layout-clear frame, so controllers keep showing their last layout until
   * the next `set`.
   */
  clear(target: number | "all"): void;
}

/** Haptics (D6; FR-8.7). Patterns are never stored or logged (SR-12). */
export interface GameHaptics {
  /** Plays a 1..8 step pattern, in ms, on one slot or every controller. */
  pulse(target: number | "all", pattern: ReadonlyArray<number>): void;
}

/** Named controller-event subscriptions (D5; FR-7.12). */
export interface GameEvents {
  /** Registers a handler for one event name; returns an unsubscribe function. */
  on(name: string, handler: (event: GameEvent) => void): () => void;
  /** Receives events that have no named handler. */
  onAny(handler: (event: GameEvent) => void): () => void;
}

/**
 * Everything a game receives. There is deliberately no socket, `ws`, `fetch`
 * or DOM member (FR-7.17).
 */
export interface GameContext {
  readonly manifest: GameManifest;
  readonly input: GameInputReader;
  readonly renderer: GameRenderer3D;
  readonly audio: GameAudio;
  readonly rng: GameRng;
  readonly debug: GameDebug;
  readonly panels: GamePanels;
  readonly layouts: GameLayouts;
  readonly haptics: GameHaptics;
  /** Named controller-event subscriptions (D5). */
  readonly events: GameEvents;
  /** Estimated server clock in ms, or null before the host joined a room. */
  serverNow(): number | null;
}

/** The game contract (frozen in D3; P4 finalizes the SDK). */
export interface Game {
  readonly manifest: GameManifest;
  init(ctx: GameContext): void | Promise<void>;
  /** One fixed 1/60 s step. Must not allocate per tick (PR-9.3). */
  simulate(dt: number, input: GameInputSnapshot): void;
  /** One display frame; `alpha` in [0, 1) interpolates sim states. */
  render(alpha: number): void;
  /** Controller event delivered before `simulate` of the same tick. */
  onEvent?(slot: number, name: string, data: JsonValue): void;
  /** Release timers, listeners and GPU resources. Called once. */
  dispose(): void;
}

/** Shape of a game's `entry` module. */
export interface GameModule {
  default: (manifest: GameManifest) => Game;
}

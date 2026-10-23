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

/** Unit quaternion projection (spec 02 owns the math conventions). */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
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

/**
 * Device features reported by the renderer (spec 04; 18 §3.4 fixes this
 * union). A game branches on these, never on `backend`, for correctness.
 */
export type EngineFeature =
  | "compute"
  | "storage-buffers"
  | "timestamp-query"
  | "float-render-target"
  | "texture-array"
  | "msaa4"
  | "compressed-astc"
  | "compressed-etc2"
  | "compressed-s3tc";

/**
 * Renderer capability snapshot (spec 04 is authoritative).
 *
 * Taken once after device creation and quality selection; it does not change
 * during a session. `renderer.capabilities === undefined` means the host
 * cannot report them, so assume the lowest supported tier; it is never a
 * reason to skip a fallback path.
 */
export interface RendererCapabilities {
  readonly backend: "webgpu" | "webgl2" | "canvas2d";
  readonly features: ReadonlySet<EngineFeature>;
  readonly quality: "off" | "low" | "medium" | "high";
  readonly maxTextureSize: number;
  readonly maxTextureLayers: number;
  readonly maxBindGroups: number;
  readonly maxUniformBufferBytes: number;
  readonly maxSamples: 1 | 4;
  readonly anisotropy: number;
  readonly directionalLights: number;
  readonly pointLights: number;
  readonly shadowCascades: 0 | 2 | 3;
  readonly supportsPost: boolean;
  readonly supportsTimestamps: boolean;
}

/**
 * Shared renderer surface a game may use. Sizing is owned by the host.
 *
 * `webgpu` is additive in 18 §3.4; games keep working on every older backend.
 * `capabilities` is absent when the host cannot report a snapshot.
 */
export interface GameRendererBase {
  readonly backend: "webgpu" | "webgl2" | "canvas2d";
  /**
   * Capability snapshot (spec 04). `undefined` means assume the lowest
   * supported tier; absence is the feature test, never a throwing stub.
   */
  readonly capabilities?: RendererCapabilities;
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

/** Packed debug color, `0xRRGGBBAA` (spec 16). */
export type DebugColor = number;

/**
 * Immediate-mode debug drawing (spec 16 is authoritative; 18 §3.4 fixes the
 * member as `debug.draw?`).
 *
 * Writes into preallocated buffers; the renderer flushes once per frame.
 * `undefined` when the profiler is stripped from the production build, so a
 * game must never require it for correctness.
 */
export interface DebugDraw {
  readonly enabled: boolean;
  line(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: DebugColor,
  ): void;
  box(
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    color: DebugColor,
  ): void;
  sphere(cx: number, cy: number, cz: number, radius: number, color: DebugColor): void;
  ray(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    length: number,
    color: DebugColor,
  ): void;
  /** Dev-only; the caller supplies the string. Capacity-limited per frame. */
  text(x: number, y: number, z: number, text: string, color: DebugColor): void;
  /** Called by the renderer once per frame; resets counts, keeps capacity. */
  flush(): void;
  /** Capacity-overflow counter, cumulative. */
  readonly dropped: number;
}

/** Per-game debug counters shown by `?debug=1` (D7 extends the overlay). */
export interface GameDebug {
  readonly enabled: boolean;
  setCounter(name: string, value: number): void;
  /**
   * Debug drawing (spec 16). `undefined` when the profiler is stripped from
   * the production build; `if (ctx.debug.draw)` is the feature test.
   */
  readonly draw?: DebugDraw;
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

/* ------------------------------------------------------------------------
 * GameContext v2 additive projections (18 §3.4).
 *
 * Every interface below restates a game-facing engine shape structurally:
 * the SDK imports nothing from `packages/` and a game never sees an engine
 * internal (FR-7.17). The numbered spec named on each block is authoritative
 * for fields, limits and semantics; this file fixes only the minimum surface
 * 18 §3.4 requires, and it grows additively.
 *
 * Availability: an additive member is absent (`undefined`) when the host
 * cannot provide it. `if (ctx.scene)` / `if (ctx.assets)` is the feature
 * test; none of these is ever a throwing stub.
 * --------------------------------------------------------------------- */

/* -- Assets (spec 06) --------------------------------------------------- */

/** 06 §3.1. The engine's asset kinds; the SDK exposes the same eight. */
export type AssetKind =
  | "mesh"
  | "texture"
  | "material"
  | "audio"
  | "font"
  | "json"
  | "scene"
  | "animation";

/** 06 §3.1. */
export type AssetState = "queued" | "loading" | "ready" | "failed" | "disposed";

/** 06 §5.11. `code` is the engine AssetErrorCode, widened to string for games. */
export interface AssetFailure {
  readonly id: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** 06 §3.3/§4.4. Byte-accurate progress for the active batch. */
export interface AssetProgress {
  readonly fetched: number;
  readonly declared: number;
  readonly determinate: boolean;
  readonly state: "idle" | "loading" | "ready" | "failed";
  readonly loadedCount: number;
  readonly totalCount: number;
  readonly currentId: string | null;
}

/**
 * Handle to one asset (spec 06 is authoritative for decoding, refcounting
 * and eviction). `value` is valid only while `state` is "ready"; reading it
 * earlier throws the engine's not-ready error rather than returning undefined.
 */
export interface AssetHandle<T = unknown> {
  readonly id: string;
  readonly kind: AssetKind;
  readonly state: AssetState;
  readonly value: T;
  retain(): AssetHandle<T>;
  release(): void;
  readonly failed: AssetFailure | null;
}

/**
 * Asset library projection (spec 06 owns decoding, budgets and eviction).
 * `ctx.assets === undefined` until the asset pipeline is installed. This is a
 * structural subset of the engine library, so the runtime passes it directly.
 */
export interface AssetLibrary {
  load<T = unknown>(id: string): Promise<AssetHandle<T>>;
  get<T = unknown>(id: string): AssetHandle<T> | undefined;
  readonly loadedBytes: number;
  readonly budgetBytes: number;
  readonly progress: AssetProgress;
  dispose(): void;
}

/* -- Scene (spec 03) ---------------------------------------------------- */

/** Dense entity slot index (spec 03); runtime-local, never persisted. */
export type EntityId = number;

/** Immutable entity handle (spec 03); two handles match iff both fields match. */
export interface Entity {
  readonly id: EntityId;
  readonly generation: number;
}

/** Local transform (specs 02/03): metres, unit quaternion, unitless scale. */
export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/**
 * Component registration descriptor, projected from spec 03.
 *
 * The engine descriptor also carries an id, serialization codecs and reset
 * hooks; spec 03 is authoritative. The SDK fixes only the identity and
 * factory a game needs to pass a descriptor back to `Scene`.
 */
export interface ComponentType<T> {
  readonly name: string;
  create(): T;
}

/**
 * Engine scene projection (spec 03 owns storage, query semantics and limits).
 *
 * `ctx.scene === undefined` on Canvas2D-only games and before the engine
 * scene exists. When present the host renders the scene before
 * `game.render(alpha)`, and an entity is engine-rendered or game-rendered,
 * never both. `query` writes into the caller's array and allocates nothing.
 */
export interface Scene {
  createEntity(): Entity;
  destroyEntity(entity: Entity): void;
  isAlive(entity: Entity): boolean;
  add<T>(entity: Entity, component: ComponentType<T>, value: T): void;
  get<T>(entity: Entity, component: ComponentType<T>): T | undefined;
  remove<T>(entity: Entity, component: ComponentType<T>): void;
  query(out: Entity[], ...components: ComponentType<unknown>[]): Entity[];
  dispose(): void;
}

/* -- Animation (spec 08) ------------------------------------------------ */

/** Playback loop mode (spec 08; ping-pong is M2). */
export type ClipLoopMode = "repeat" | "once" | "ping-pong";

/** Clip projection; spec 08 owns tracks, events and sampling. */
export interface AnimationClip {
  readonly name: string;
  /** Seconds, greater than zero. */
  readonly duration: number;
  readonly loop: ClipLoopMode;
}

/** Skeleton projection; spec 08 owns the bind pose and joint layout. */
export interface Skeleton {
  /** Stable asset identity, when the asset declares one. */
  readonly id?: string;
  readonly jointCount: number;
}

/** Playback options (subset of spec 08's `PlayOptions`). */
export interface AnimationPlayOptions {
  readonly loop?: ClipLoopMode;
  /** 0..10; default 1. */
  readonly speed?: number;
  /** 0..1; default 1. */
  readonly weight?: number;
  /** 0..10 seconds. */
  readonly fadeInSeconds?: number;
  /** Default true. */
  readonly restart?: boolean;
  /** Layer index; default 0. */
  readonly layer?: number;
}

/** A running playback action; spec 08 owns crossfade and phase rules. */
export interface AnimationAction {
  readonly layer: number;
  /** Seconds into the source. */
  time: number;
  weight: number;
  speed: number;
  readonly running: boolean;
  stop(fadeOutSeconds?: number): void;
}

/** One animation instance bound to one live entity (spec 08). */
export interface AnimationInstance {
  readonly id: number;
  readonly entity: Entity;
  readonly skeleton: Skeleton;
  play(source: AnimationClip, options?: AnimationPlayOptions): AnimationAction;
  getAction(layer: number): AnimationAction | null;
  stop(layer?: number, fadeOutSeconds?: number): void;
  setLayerWeight(layer: number, weight: number): void;
}

/** Animation event copied into a caller-owned array (spec 08). */
export interface AnimationEvent {
  readonly entity: Entity;
  readonly name: string;
  /** Clip-local time, seconds. */
  readonly time: number;
}

/** Debug counters (subset of spec 08's `AnimationStats`). */
export interface AnimationStats {
  readonly instanceCount: number;
  readonly activeActionCount: number;
  /** Last update duration, milliseconds; debug only. */
  readonly updateMs: number;
}

/**
 * Animation API (spec 08 is authoritative). `ctx.animation === undefined`
 * until the animation package is installed. When present, call `update(dt)`
 * exactly once per simulation tick, after setting playback parameters.
 */
export interface AnimationApi {
  createInstance(entity: Entity, skeleton: Skeleton): AnimationInstance;
  destroyInstance(instance: AnimationInstance): void;
  getInstance(entity: Entity): AnimationInstance | null;
  /** Advances every instance exactly once per fixed tick. */
  update(dt: number): void;
  /** Copies queued events into `out`; returns the count copied. */
  drainEvents(out: AnimationEvent[]): number;
  /** FNV-1a 32 over the canonical pose/action stream; replay probe. */
  stateHash(): number;
  readonly stats: AnimationStats;
  dispose(): void;
}

/* -- World streaming (spec 12) ------------------------------------------ */

/** Grid coordinates of one world cell (spec 00 §3.5). */
export interface WorldCellId {
  readonly cx: number;
  readonly cy: number;
}

/** Canonical cell key, `"cx,cy"` with no spaces (e.g. `"12,-3"`). */
export type CellKey = `${number},${number}`;

/** Public cell projection (spec 00 §3.5; spec 12 maps internal states). */
export interface WorldCell {
  readonly id: WorldCellId;
  readonly key: CellKey;
  /** 0 = richest. */
  readonly lod: 0 | 1 | 2 | 3;
  readonly state: "unloaded" | "loading" | "resident" | "evicting";
  readonly bytes: number;
}

/** Streaming counters (subset of spec 12's `StreamStats`). */
export interface StreamStats {
  readonly residentCells: number;
  readonly pendingLoads: number;
  readonly residentBytes: number;
}

/**
 * World streamer projection (spec 12 owns residency, budgets and LOD).
 * `ctx.world === undefined` for non-streaming games. The game never calls
 * `update`; the host advances residency once per fixed tick.
 */
export interface WorldStreamer {
  getCell(key: CellKey): WorldCell | undefined;
  cellAt(x: number, z: number): WorldCell | undefined;
  /** Reused snapshot, valid until the host's next tick. */
  readonly resident: readonly WorldCell[];
  /** False when the cell is missing or the pin cap is reached. */
  pin(key: CellKey): boolean;
  unpin(key: CellKey): void;
  /** 0..3; greater than zero coarsens LODs sooner. Presentation only. */
  setLodBias(bias: number): void;
  setSimRadius(meters: number): void;
  readonly stats: StreamStats;
  stop(): void;
  dispose(): void;
}

/* -- UI and text (spec 13) ---------------------------------------------- */

/** Node kinds (spec 13 §3.1). */
export type UiNodeKind =
  | "group"
  | "rect"
  | "image"
  | "text"
  | "button"
  | "toggle"
  | "slider"
  | "list"
  | "scroll"
  | "world-label"
  | "custom";

/** UI node projection (spec 13 owns layout, style, focus and accessibility). */
export interface UiNode {
  readonly id: string;
  readonly kind: UiNodeKind;
  readonly children: readonly UiNode[];
  visible: boolean;
  interactive: boolean;
  disabled: boolean;
  /** Literal text; use `textKey` for localized text. */
  text: string;
  textKey: string;
}

/** Node creation options (subset of spec 13's `UiNodeInit`). */
export interface UiNodeInit {
  readonly id?: string;
  readonly text?: string;
  readonly textKey?: string;
  readonly interactive?: boolean;
  readonly visible?: boolean;
}

/** Loaded font (spec 13); `id` is an engine asset id, never a URL. */
export interface FontHandle {
  readonly id: string;
  readonly family: string;
  readonly kind: "msdf" | "bitmap" | "woff2";
  readonly supportsShaping: boolean;
}

/**
 * Engine UI projection (spec 13 is authoritative). `ctx.ui === undefined`
 * when the game draws only through `ctx.renderer`; no HTML, CSS or DOM node
 * crosses this boundary.
 */
export interface GameUi {
  readonly root: UiNode;
  create(kind: UiNodeKind, init?: UiNodeInit): UiNode;
  destroy(node: UiNode): void;
  mount(node: UiNode, parent?: UiNode): void;
  loadFont(id: string): Promise<FontHandle>;
  loadScreen(id: string): Promise<UiNode>;
  show(node: UiNode): void;
  hide(node: UiNode): void;
  /** 1.0 .. 2.0, default 1.0. */
  setTextScale(scale: number): void;
  dispose(): void;
}

/* -- Action-mapped input (spec 10; reserved by 18 §3.4) ----------------- */

/** Pooled action state; copy fields to retain past the tick (spec 10). */
export interface ActionState {
  readonly pressed: boolean;
  /** Bit 0 = action press; bit i+1 = binding i (16-bit mask). */
  readonly edges: number;
  readonly released: boolean;
  readonly releaseEdges: number;
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * Action reader (spec 10 is authoritative; 18 §3.4 reserves the member for
 * SDK 1.0, so do not depend on it). `ctx.actions === undefined` until the
 * keyboard/mouse/gamepad mapping layer is installed.
 */
export interface ActionReader {
  readonly actions: readonly ActionState[];
  action(name: string): ActionState | undefined;
}

/* -- Save/load (spec 15) ------------------------------------------------ */

/** Stable save failure codes (spec 15; codes may be added, never removed). */
export type SaveErrorCode =
  | "E_SAVE_FORMAT"
  | "E_SAVE_VERSION"
  | "E_SAVE_HASH"
  | "E_SAVE_GAME"
  | "E_SAVE_QUOTA"
  | "E_SAVE_IO"
  | "E_SAVE_MIGRATION"
  | "E_SAVE_SLOT"
  | "E_SAVE_UNSUPPORTED";

/** Redacted failure; never contains payload bytes or secrets (spec 15). */
export interface SaveError {
  readonly code: SaveErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
}

/** Result union used by every `SaveApi` call (spec 15). */
export type SaveResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SaveError };

/**
 * Slot metadata projection (spec 15 §3.5 is authoritative; the engine view
 * carries more hash and flag fields). Times are epoch milliseconds UTC:
 * `createdAtUnixMs` is the header's seconds times 1000, `updatedAtUnixMs` is
 * the storage commit time.
 */
export interface SaveSlot {
  readonly slotId: string;
  readonly gameId: string;
  readonly formatVersion: number;
  readonly gameVersion: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  /** Stored (possibly compressed) bytes. */
  readonly payloadBytes: number;
  readonly payloadUncompressedBytes: number;
  /** Total save-file bytes. */
  readonly bytes: number;
  /** Structural, version and gameId checks passed. */
  readonly readable: boolean;
  /** Why `readable` is false; never means the slot was deleted. */
  readonly error: SaveErrorCode | null;
}

/**
 * Save/load projection (spec 15 is authoritative). `ctx.save === undefined`
 * when storage is unavailable; feature-detect and run without persistence.
 * `read` returns the decompressed game payload; `write` takes raw payload
 * bytes and the host supplies the game and SDK versions.
 */
export interface SaveApi {
  readonly gameId: string;
  list(): Promise<SaveResult<readonly SaveSlot[]>>;
  read(slotId: string): Promise<SaveResult<Uint8Array>>;
  write(slotId: string, payload: Uint8Array): Promise<SaveResult<SaveSlot>>;
  remove(slotId: string): Promise<SaveResult<void>>;
}

/**
 * Everything a game receives. There is deliberately no socket, `ws`, `fetch`
 * or DOM member (FR-7.17).
 *
 * Frozen members are always present. The additive members below are absent
 * (`undefined`) when the host cannot provide them; `if (ctx.assets)` is the
 * feature test, never a throwing stub. The context shape only grows
 * additively (18 §3.4).
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

  /** Engine assets (spec 06). `undefined` until the asset pipeline exists. */
  readonly assets?: AssetLibrary;
  /** Engine scene (spec 03). `undefined` on Canvas2D-only games. */
  readonly scene?: Scene;
  /** Animation (spec 08). `undefined` before the animation package lands. */
  readonly animation?: AnimationApi;
  /** World streaming (spec 12). `undefined` for non-streaming games. */
  readonly world?: WorldStreamer;
  /** Engine UI (spec 13). `undefined` when the game uses only `renderer`. */
  readonly ui?: GameUi;
  /** Action-mapped input (spec 10; reserved by 18 §3.4). Do not depend on it. */
  readonly actions?: ActionReader;
  /** Save/load (spec 15). `undefined` when storage is unavailable. */
  readonly save?: SaveApi;
}

/* -- Compile-time contract checks (18 §3.4) ----------------------------- */

type ContractAssert<T extends true> = T;
type IsAssignable<From, To> = [From] extends [To] ? true : false;

type AdditiveMember = "assets" | "scene" | "animation" | "world" | "ui" | "actions" | "save";

type FrozenMember =
  | "manifest"
  | "input"
  | "renderer"
  | "audio"
  | "rng"
  | "debug"
  | "panels"
  | "layouts"
  | "haptics"
  | "events"
  | "serverNow";

/** A context with only the frozen members is still a valid `GameContext`. */
type AdditiveMembersMayBeAbsent = ContractAssert<
  IsAssignable<Omit<GameContext, AdditiveMember>, GameContext>
>;

/** Every additive member is optional, so an empty object satisfies it. */
type AdditiveMembersAreOptional = ContractAssert<
  IsAssignable<Record<never, never>, Pick<GameContext, AdditiveMember>>
>;

/** Dropping any frozen member must not produce a `GameContext`. */
type FrozenMemberIsRequired<K extends FrozenMember> = IsAssignable<
  Omit<GameContext, K>,
  GameContext
> extends false
  ? true
  : false;
type FrozenMembersAreRequired = ContractAssert<
  FrozenMemberIsRequired<FrozenMember> extends true ? true : false
>;

/** Nested additive members obey the same absence rule. */
type RendererCapabilitiesOptional = ContractAssert<
  IsAssignable<Record<never, never>, Pick<GameRendererBase, "capabilities">>
>;
type DebugDrawOptional = ContractAssert<
  IsAssignable<Record<never, never>, Pick<GameDebug, "draw">>
>;
type WebgpuBackendAccepted = ContractAssert<IsAssignable<"webgpu", GameRendererBase["backend"]>>;

/**
 * Compile-time evidence for 18 §3.4. Every field is the literal type `true`;
 * a violated rule fails `tsc` at the alias that defines it. Types erase, so
 * this adds no runtime code and no bundle bytes.
 */
export type GameContextV2Contract = {
  readonly additiveMembersMayBeAbsent: AdditiveMembersMayBeAbsent;
  readonly additiveMembersAreOptional: AdditiveMembersAreOptional;
  readonly frozenMembersAreRequired: FrozenMembersAreRequired;
  readonly rendererCapabilitiesOptional: RendererCapabilitiesOptional;
  readonly debugDrawOptional: DebugDrawOptional;
  readonly webgpuBackendAccepted: WebgpuBackendAccepted;
};

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

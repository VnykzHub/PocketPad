/**
 * Input subsystem contract (spec 10, `docs/engine/10-input.md` §3–§4).
 *
 * Declaration only. This wave ships no listeners, polling, phone adapter,
 * action resolution or rebinding implementation; W1 adds those behind these
 * declarations without widening the public surface.
 *
 * Frozen and additive-only. The spec is authoritative for semantics; this
 * file is authoritative for the TypeScript shape. No DOM type crosses this
 * boundary: `InputTarget` and `GamepadReadout` are opaque structural seams
 * that the DOM modules unwrap. No protocol type is imported: the runtime
 * adapter decodes phone packets and calls `PhoneInputAdapter`.
 */

import type { EngineErrorCode } from "@lanpad/engine-core";

/* -------------------------------------------------------------------------
 * 1. Devices and sources (10 §3.1)
 * ---------------------------------------------------------------------- */

export type InputDeviceKind = "phone" | "keyboard" | "pointer" | "gamepad";

export type InputActionKind = "button" | "axis" | "vector2";

/** Phone stick/trigger selector. `ly`/`ry` are +down (screen convention). */
export type PhoneAxisName = "lx" | "ly" | "rx" | "ry" | "lt" | "rt";

export type Component = "x" | "y";

/** Absolute position, accumulated motion, or accumulated wheel delta. */
export type PointerAxisName = "x" | "y" | "dx" | "dy" | "wheel";

/** Pointer buttons: bit 0 left, bit 1 middle, bit 2 right. */
export type PointerButton = 0 | 1 | 2;

export interface PhoneButtonSource {
  readonly device: "phone";
  /** Room slot 0..7, or the resolving player's slot. */
  readonly slot: number | "self";
  readonly channel: "button";
  /** Layout-defined channel bit, 0..15. */
  readonly bit: number;
}

export interface PhoneAxisSource {
  readonly device: "phone";
  readonly slot: number | "self";
  readonly channel: "axis";
  readonly axis: PhoneAxisName;
  /**
   * Default: `lx`/`rx` -> `x`, `ly`/`ry` -> `y`. `lt`/`rt` require one on a
   * vector2 action (10 §5.8.3).
   */
  readonly component?: Component;
  /** Finite, -4..4; default 1. */
  readonly scale?: number;
}

export interface KeyboardSource {
  readonly device: "keyboard";
  /** Physical `KeyboardEvent.code`, e.g. "KeyW", "ArrowUp", "Space". */
  readonly code: string;
  readonly component?: Component;
  /** Finite, -4..4; default 1. */
  readonly scale?: number;
}

export interface PointerSource {
  readonly device: "pointer";
  /** Exactly one of `axis`/`button` must be set. */
  readonly axis?: PointerAxisName;
  readonly button?: PointerButton;
  readonly component?: Component;
  /** Finite, -4..4; default 1. */
  readonly scale?: number;
}

export interface GamepadSource {
  readonly device: "gamepad";
  /** Browser pad index 0..3, or the resolving player's assigned pad. */
  readonly pad: number | "self";
  /** Exactly one of `button`/`axis` must be set. Standard mapping 0..16. */
  readonly button?: number;
  /** Standard mapping 0..3. */
  readonly axis?: number;
  readonly component?: Component;
  /** Finite, -4..4; default 1. */
  readonly scale?: number;
}

export type InputBinding =
  | PhoneButtonSource
  | PhoneAxisSource
  | KeyboardSource
  | PointerSource
  | GamepadSource;

/** 00 §3.4 sketch name for a single device source; same union as `InputBinding`. */
export type InputSource = InputBinding;

/** 00 §3.4 sketch name for a device kind; same union as `InputDeviceKind`. */
export type InputDevice = InputDeviceKind;

/* -------------------------------------------------------------------------
 * 2. Actions and state (10 §3.2)
 * ---------------------------------------------------------------------- */

/** At most one member; its type must match the action kind (10 §5.8). */
export interface ActionOutput {
  /** 0..15 -> synthesized controller bit. */
  readonly button?: number;
  /** vector2 -> lx/ly or rx/ry. */
  readonly stick?: "left" | "right";
  /** axis/button -> one trigger value. */
  readonly trigger?: "lt" | "rt";
  /** axis/vector2 -> one stick component. */
  readonly axis?: "lx" | "ly" | "rx" | "ry";
}

export interface InputAction {
  /** `^[a-z][a-z0-9_.-]{0,47}$`, unique, case-sensitive. */
  readonly name: string;
  readonly kind: InputActionKind;
  /** 1..15 (16-bit edge budget: bit 0 aggregate, bits 1..15 bindings). */
  readonly bindings: readonly InputBinding[];
  /** 0..0.9; default 0.15 for stick pairs. */
  readonly deadzone?: number;
  /** 0.01..1; default 0.5. */
  readonly threshold?: number;
  /** 0..0.5; default 0.1. */
  readonly hysteresis?: number;
  /** vector2 only; default false. Stored y is negated when true (10 §5.8.5). */
  readonly yUp?: boolean;
  readonly output?: ActionOutput;
}

/**
 * Pooled; invalid after the next `poll`. Copy fields to retain.
 *
 * `edges`/`releaseEdges` are 16-bit masks: bit 0 is the action aggregate,
 * bit `i + 1` is binding `i`.
 */
export interface ActionState {
  readonly pressed: boolean;
  readonly edges: number;
  readonly released: boolean;
  readonly releaseEdges: number;
  /** vector2 -1..1; axis actions store the signed value here. */
  readonly x: number;
  /** vector2 -1..1 (negated when the action is `yUp`). */
  readonly y: number;
  /** button 0..1; axis |x|; vector magnitude 0..1. */
  readonly value: number;
}

export interface InputMap {
  readonly actions: readonly InputAction[];
  readonly names: readonly string[];
  /** -1 when unknown; no allocation. */
  indexOf(name: string): number;
  /** Fills `out` from the router's current frame; returns `out`. Allocation-free. */
  poll(out: ActionState[]): ActionState[];
}

/* -------------------------------------------------------------------------
 * 3. Raw snapshots (10 §3.3)
 * ---------------------------------------------------------------------- */

/**
 * Structurally identical to the decoded phone packet. Produced by the
 * runtime adapter; the engine never sees protocol bytes.
 */
export interface PhoneInputSample {
  readonly slot: number;
  readonly connected: boolean;
  /** u16 level bitmask. */
  readonly buttons: number;
  /** u16 press edges, OR-accumulated by the sender. */
  readonly edges: number;
  /** -1..1, +right. */
  readonly lx: number;
  /** -1..1, +down. */
  readonly ly: number;
  readonly rx: number;
  readonly ry: number;
  /** Degrees/second. */
  readonly gyro: { readonly x: number; readonly y: number; readonly z: number };
  readonly gyroActive: boolean;
  readonly gyroRecentered: boolean;
  readonly triggers: { readonly lt: number; readonly rt: number };
  /** u32, wrap-safe. */
  readonly tick: number;
}

export interface PointerSnapshot {
  /** CSS px in the target, +right. */
  readonly x: number;
  /** CSS px, +down. */
  readonly y: number;
  /** Motion accumulated since the previous poll, px. */
  readonly dx: number;
  readonly dy: number;
  /** Wheel delta accumulated since the previous poll. */
  readonly wheel: number;
  /** Bit 0 left, bit 1 middle, bit 2 right. */
  readonly buttons: number;
  /** Press edges this tick. */
  readonly edges: number;
  readonly inside: boolean;
  /** Pointer lock active. */
  readonly locked: boolean;
}

export interface GamepadSnapshot {
  /** `navigator.getGamepads()` index. */
  readonly index: number;
  /** Diagnostic only. */
  readonly id: string;
  readonly mapping: "standard" | "non-standard";
  readonly connected: boolean;
  /** Bit = pressed, standard buttons 0..16. */
  readonly buttons: number;
  /** Press edges since the previous poll. */
  readonly edges: number;
  readonly releaseEdges: number;
  readonly triggerValues: { readonly lt: number; readonly rt: number };
  /** Four standard axes, reused array. */
  readonly axes: readonly number[];
}

export interface FocusSnapshot {
  readonly focused: boolean;
  readonly visible: boolean;
  readonly pointerLocked: boolean;
  /** -1 when the page has never blurred. */
  readonly lastBlurTick: number;
}

/* -------------------------------------------------------------------------
 * 4. The unified frame (10 §3.4)
 * ---------------------------------------------------------------------- */

/** Structurally identical to SDK `GameControllerState`; no SDK import. */
export interface ControllerView {
  /** Engine slot 0..7. The runtime adapter maps to SDK slots 1..8. */
  slot: number;
  readonly connected: boolean;
  buttons: number;
  edges: number;
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  gyro: { x: number; y: number; z: number };
  gyroActive: boolean;
  gyroRecentered: boolean;
  tilt?: { angleX: number; angleY: number; available: boolean };
  triggers: { lt: number; rt: number };
  tick: number;
}

export interface PlayerInput {
  readonly slot: number;
  readonly connected: boolean;
  readonly device: InputDeviceKind | "none";
  readonly actions: readonly ActionState[];
  /** Pooled. For a phone player this is the phone sample, identity-preserved. */
  readonly controller: ControllerView;
}

/** Allocation-free named action lookup over a pooled frame. */
export interface ActionReader {
  readonly actions: readonly ActionState[];
  action(name: string): ActionState | undefined;
}

export interface InputFrame extends ActionReader {
  readonly tick: number;
  /** Always `slots` entries (default 8), in engine slot order 0..7. */
  readonly players: readonly PlayerInput[];
  /** The local player's actions: keyboard-assigned player, else player 0. */
  readonly actions: readonly ActionState[];
  readonly pointer: PointerSnapshot;
  readonly focus: FocusSnapshot;
  player(slot: number): PlayerInput | undefined;
}

/**
 * Frozen SDK-shaped snapshot (SDK slots 1..8) fed to the legacy
 * `SnapshotInputReader` by the runtime adapter. The engine's own frame uses
 * `ControllerView.slot` 0..7; the adapter owns the +1 mapping.
 */
export interface InputSnapshot {
  readonly tick: number;
  /** Fixed order: SDK index = slot - 1. */
  readonly players: readonly ControllerView[];
}

/* -------------------------------------------------------------------------
 * 5. DOM-free host seams (10 §3.5; DOM types withheld by contract rule)
 * ---------------------------------------------------------------------- */

/**
 * Opaque event target. `kind` tells the router which listener set to install;
 * only the DOM modules in spec 10 §5.1 may read `native`. A runtime passes
 * `{ kind: "window", native: window }` or
 * `{ kind: "element", native: canvas }`.
 */
export interface InputTarget {
  readonly kind: "window" | "element";
  readonly native: unknown;
}

/** Minimal `GamepadButton` readout; native Gamepad objects never cross in. */
export interface GamepadButtonReadout {
  readonly pressed: boolean;
  readonly value: number;
}

/** Minimal `Gamepad` readout for the `createGamepads` test seam. */
export interface GamepadReadout {
  readonly index: number;
  readonly id: string;
  readonly mapping: "standard" | "non-standard";
  readonly connected: boolean;
  readonly buttons: readonly GamepadButtonReadout[];
  readonly axes: readonly number[];
}

/* -------------------------------------------------------------------------
 * 6. Router options and API (10 §3.5)
 * ---------------------------------------------------------------------- */

export interface FixedAssignment {
  /** Slot 0..7. */
  readonly keyboard?: number;
  /** Pad index -> slot 0..7. */
  readonly gamepads?: Readonly<Record<number, number>>;
}

/** Action-map subset of the router options; reused by map compilation. */
export interface InputMapOptions {
  /** Default: `defaultDesktopMap()` (10 §5.9). */
  readonly actions?: readonly InputAction[];
  /** 0..0.9; default 0.15. */
  readonly stickDeadzone?: number;
  /** 0..0.9; default 0.05. */
  readonly triggerDeadzone?: number;
  /** Default 1; scales `dx`/`dy` action values. */
  readonly pointerSensitivity?: number;
  /** Host-loaded user overrides (10 §4.2). */
  readonly bindings?: BindingOverlay;
}

export interface InputRouterOptions extends InputMapOptions {
  /** 1..8, default 8. */
  readonly slots?: number;
  readonly fixed?: FixedAssignment;
  /** Default "replace". */
  readonly conflictPolicy?: "replace" | "reject";
  /** Persistence; optional. The engine never touches storage itself. */
  readonly store?: BindingStore;
  /** Default `DEFAULT_RESERVED_KEYS`. */
  readonly reservedKeys?: readonly string[];
  /** Event target; default is the window. */
  readonly target?: InputTarget;
  /** Default false. */
  readonly preventContextMenu?: boolean;
  /** `performance.now` test seam. */
  readonly clock?: () => number;
  /** Test seam; returns browser-like reads, never retained. */
  readonly createGamepads?: () => readonly (GamepadReadout | null)[];
}

/** Runtime adapter entry points for decoded phone samples. */
export interface PhoneInputAdapter {
  /** Called when an InputFwd is decoded. */
  applyPhoneSample(slot: number, sample: PhoneInputSample, receivedAtMs: number): void;
  setPhoneConnected(slot: number, connected: boolean): void;
  setTilt(slot: number, tilt: ControllerView["tilt"]): void;
}

export interface InputRouter extends PhoneInputAdapter {
  readonly frame: InputFrame;
  readonly map: InputMap;
  /** Sorted by slot; changes only when the device topology changes. */
  readonly assignment: readonly AssignmentEntry[];
  readonly capturing: boolean;

  attach(target?: InputTarget): void;
  detach(): void;
  /** Exactly once per simulation tick, before `game.simulate`. Idempotent per tick. */
  poll(tick: number): InputFrame;

  beginCapture(
    action: string,
    bindingIndex: number,
    device: InputDeviceKind,
    timeoutMs?: number,
  ): Promise<RebindResult>;
  cancelCapture(): void;
  setBindings(overlay: BindingOverlay): void;
  saveBindings(): Promise<void>;

  /** Device events allocate; emitted on real events only, never per frame. */
  subscribe(listener: (event: InputDeviceEvent) => void): () => void;
  reset(): void;
  dispose(): void;
}

/* -------------------------------------------------------------------------
 * 7. Assignment and events (10 §3.6)
 * ---------------------------------------------------------------------- */

export interface AssignmentEntry {
  readonly slot: number;
  readonly device: InputDeviceKind;
  /** "keyboard" | "pointer" | "gamepad:0" | "phone:3". */
  readonly deviceId: string;
}

/** 00 §3.4 sketch name for one player's assignment; same shape. */
export type DeviceAssignment = AssignmentEntry;

export type InputDeviceEvent =
  | {
      readonly type: "press";
      readonly device: InputDeviceKind;
      readonly slot: number;
      readonly code: string;
    }
  | {
      readonly type: "release";
      readonly device: InputDeviceKind;
      readonly slot: number;
      readonly code: string;
    }
  | { readonly type: "gamepad-connected"; readonly index: number }
  | { readonly type: "gamepad-disconnected"; readonly index: number }
  | { readonly type: "focus-changed"; readonly focused: boolean }
  | { readonly type: "capture"; readonly result: RebindResult };

/* -------------------------------------------------------------------------
 * 8. Rebinding and persistence (10 §3.7, §4.2)
 * ---------------------------------------------------------------------- */

export type RebindFailure =
  | "cancelled"
  | "reserved"
  | "conflict"
  | "unsupported"
  | "timeout"
  | "busy";

export type RebindResult =
  | {
      readonly ok: true;
      readonly action: string;
      readonly binding: number;
      readonly device: InputDeviceKind;
      readonly code: string;
    }
  | {
      readonly ok: false;
      readonly reason: RebindFailure;
      readonly conflict?: { readonly action: string; readonly binding: number };
    };

/**
 * One action's replacement binding list, or `null` to restore the base map.
 * Each key replaces the entire list (10 §4.2).
 */
export type BindingOverlay = Readonly<Record<string, readonly InputBinding[] | null>>;

export interface BindingStore {
  /** Host shell supplies persistence; the engine never writes storage. */
  save(overlay: BindingOverlay): Promise<void>;
}

/* -------------------------------------------------------------------------
 * 9. Config documents (10 §4.1, §4.2)
 * ---------------------------------------------------------------------- */

/** `input.map.json`: UTF-8 JSON <= 32 KB, format version 1. */
export interface ActionMapDocument {
  readonly formatVersion: 1;
  /** 0..64 actions; unique names. */
  readonly actions: readonly InputAction[];
}

/** `input-bindings.json`: UTF-8 JSON <= 16 KB, format version 1. */
export interface BindingOverlayDocument {
  readonly formatVersion: 1;
  /** ISO-8601 UTC with milliseconds; informational only in v1. */
  readonly updatedAt?: string;
  /** 0..64 entries. */
  readonly bindings: BindingOverlay;
}

/* -------------------------------------------------------------------------
 * 10. Errors (10 §3.9) — additive codes over core's union, not a parallel one
 * ---------------------------------------------------------------------- */

/**
 * Core now owns the six `E_INPUT_*` codes (00 §5.9); this is a narrow view of
 * the frozen union, not a parallel namespace.
 */
export type InputErrorCode = Extract<EngineErrorCode, `E_INPUT_${string}`>;

export interface InputError extends Omit<EngineError, "code" | "layer"> {
  readonly code: InputErrorCode;
  readonly layer: "input";
}

/** Map/overlay validation failure carrying a JSON path such as `actions[3].deadzone`. */
export interface InputValidationError extends InputError {
  readonly code: "E_INPUT_FORMAT";
  readonly path: string;
}

/* -------------------------------------------------------------------------
 * 11. Runtime constant declarations (values in `src/version.ts`)
 * ---------------------------------------------------------------------- */

export const INPUT_MAP_VERSION: 1;
export const INPUT_BINDINGS_VERSION: 1;
export const INPUT_TRACE_VERSION: 1;

export const INPUT_MAP_MAX_BYTES: 32768;
export const INPUT_BINDINGS_MAX_BYTES: 16384;
export const INPUT_MAX_ACTIONS: 64;
export const INPUT_MAX_BINDINGS_PER_ACTION: 15;
export const INPUT_MAX_OVERLAY_ENTRIES: 64;
export const INPUT_EDGE_BITS: 16;
export const INPUT_MAX_SLOTS: 8;
export const INPUT_MAX_GAMEPADS: 4;
export const INPUT_GAMEPAD_BUTTON_COUNT: 17;
export const INPUT_GAMEPAD_AXIS_COUNT: 4;
export const INPUT_MAX_DEADZONE: 0.9;
export const INPUT_MIN_THRESHOLD: 0.01;
export const INPUT_MAX_THRESHOLD: 1;
export const INPUT_MAX_HYSTERESIS: 0.5;
export const INPUT_MAX_ABS_SCALE: 4;
export const INPUT_KEY_ID_LIMIT: 256;

export const DEFAULT_STICK_DEADZONE: 0.15;
export const DEFAULT_TRIGGER_DEADZONE: 0.05;
export const DEFAULT_ACTION_THRESHOLD: 0.5;
export const DEFAULT_ACTION_HYSTERESIS: 0.1;
export const DEFAULT_POINTER_SENSITIVITY: 1;
export const DEFAULT_CAPTURE_TIMEOUT_MS: 10000;
export const CAPTURE_AXIS_THRESHOLD: 0.6;
export const GAMEPAD_SCAN_INTERVAL_TICKS: 60;

export const POINTER_MOTION_FULL_DEFLECTION_PX: 100;
export const POINTER_WHEEL_LINE_PX: 16;
export const POINTER_WHEEL_PAGE_PX: 100;
export const POINTER_WHEEL_FULL_DEFLECTION: 100;

export const INPUT_ACTION_NAME_PATTERN: string;
export const DEFAULT_RESERVED_KEYS: readonly ["Escape", "F5", "F11", "F12", "Tab"];
export const INPUT_ERROR_CODES: readonly [
  "E_INPUT_FORMAT",
  "E_INPUT_CONFLICT",
  "E_INPUT_RESERVED",
  "E_INPUT_CAPTURE",
  "E_INPUT_TICK",
  "E_INPUT_DEVICE",
];

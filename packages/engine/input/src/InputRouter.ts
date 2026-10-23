/**
 * The input router (10 §3.5, §5.2).
 *
 * Node/no-DOM core: events arrive through structural listeners installed by
 * `attach`; phone samples and gamepad/pointer snapshots arrive through the
 * contract seams. `poll(tick)` is called exactly once per simulation tick and
 * is allocation-free after construction. Decreasing ticks throw
 * `E_INPUT_TICK` unless `strictTicks: false` is set (production tolerance).
 */

import type {
  AssignmentEntry,
  BindingOverlay,
  BindingStore,
  ControllerView,
  GamepadReadout,
  GamepadSnapshot,
  InputAction,
  InputActionKind,
  InputBinding,
  InputDeviceEvent,
  InputDeviceKind,
  InputRouter,
  InputRouterOptions,
  InputTarget,
  PhoneInputSample,
  PointerSnapshot,
  RebindResult,
} from "./contracts/input.js";
import { InputFormatError, InputTickError } from "./errors.js";
import { validateActions, validateBindingOverlay } from "./map/validate.js";
import { defaultDesktopMap } from "./map/defaultMap.js";
import { compileActionMap } from "./map/compile.js";
import type { CompiledAction, CompiledBinding, CompiledMap } from "./map/compile.js";
import { radialDeadzoneInto, scalarDeadzone } from "./resolve/Deadzone.js";
import type { MutablePair } from "./resolve/Deadzone.js";
import {
  createActionReading,
  createResolvedActionState,
  resetActionReading,
  resolveAction,
} from "./resolve/ResolveAction.js";
import type { ActionReading, ResolvedActionState } from "./resolve/ResolveAction.js";
import {
  createControllerView,
  InputFrameImpl,
  InputMapView,
  zeroActionState,
  zeroControllerView,
} from "./InputFrame.js";
import type { MutableControllerView } from "./InputFrame.js";
import { KeyboardState } from "./devices/Keyboard.js";
import { PointerState } from "./devices/Pointer.js";
import { GamepadState } from "./devices/Gamepad.js";
import { FocusState } from "./devices/Focus.js";
import { computeAssignment } from "./devices/Assignment.js";
import {
  bindingCode,
  buildGamepadAxisBinding,
  buildGamepadButtonBinding,
  buildKeyboardBinding,
  buildPointerButtonBinding,
  buildPointerWheelBinding,
  rebindInActions,
} from "./devices/Rebind.js";
import { PhoneAdapterImpl } from "./phone/PhoneAdapter.js";
import {
  CAPTURE_AXIS_THRESHOLD,
  DEFAULT_CAPTURE_TIMEOUT_MS,
  DEFAULT_POINTER_SENSITIVITY,
  DEFAULT_RESERVED_KEYS,
  DEFAULT_STICK_DEADZONE,
  DEFAULT_TRIGGER_DEADZONE,
  GAMEPAD_SCAN_INTERVAL_TICKS,
  INPUT_MAX_GAMEPADS,
  INPUT_MAX_SLOTS,
  POINTER_MOTION_FULL_DEFLECTION_PX,
  POINTER_WHEEL_FULL_DEFLECTION,
  POINTER_WHEEL_LINE_PX,
  POINTER_WHEEL_PAGE_PX,
} from "./version.js";

/** Implementation-only router options; the frozen contract is untouched. */
export interface EngineInputRouterOptions extends InputRouterOptions {
  /** Default true: a decreasing/non-integer tick throws `E_INPUT_TICK`. */
  readonly strictTicks?: boolean;
  /** Default true: bound Space/arrows prevent page scrolling. */
  readonly preventDefault?: boolean;
  /** Absolute pointer normalization width; inferred for elements when absent. */
  readonly pointerWidth?: number;
  /** Absolute pointer normalization height; inferred for elements when absent. */
  readonly pointerHeight?: number;
  /** Default true: call setPointerCapture/releasePointerCapture (10 §5.5). */
  readonly capturePointer?: boolean;
}

export interface InputRouterStats {
  conflicts: number;
  ignoredOverlayActions: number;
  nonStandardPads: number;
  invalidGamepadSnapshots: number;
  invalidPhoneSamples: number;
  unknownKeyCodes: number;
  keyFallbacks: number;
  storeErrors: number;
  listenerErrors: number;
  captureTimeouts: number;
  deviceErrors: number;
}

interface BuiltState {
  overlay: BindingOverlay;
  actions: InputAction[];
  compiled: CompiledMap;
  readings: ActionReading[][];
  prevEngaged: Uint8Array[][];
  prevAggregate: boolean[][];
  resolved: ResolvedActionState[];
}

interface CaptureState {
  actionIndex: number;
  bindingIndex: number;
  actionName: string;
  kind: InputActionKind;
  device: InputDeviceKind;
  oldBinding: InputBinding;
  resolve: (result: RebindResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface InstalledListener {
  type: string;
  handler: (event: unknown) => void;
  options?: unknown;
}

interface EventEmitterLike {
  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: unknown,
  ): void;
}

const WHEEL_LISTENER_OPTIONS = { passive: false };
const PREVENT_KEYS = new Set([
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parsePadIndex(deviceId: string): number {
  if (!deviceId.startsWith("gamepad:")) return -1;
  const index = Number(deviceId.slice(8));
  return Number.isInteger(index) ? index : -1;
}

function sameAssignment(
  a: readonly AssignmentEntry[],
  b: readonly AssignmentEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined || right === undefined) return false;
    if (
      left.slot !== right.slot ||
      left.device !== right.device ||
      left.deviceId !== right.deviceId
    ) {
      return false;
    }
  }
  return true;
}

function lowestSetBit(mask: number): number {
  for (let bit = 0; bit < 17; bit += 1) {
    if (((mask >>> bit) & 1) === 1) return bit;
  }
  return -1;
}

function defaultClock(): number {
  const performanceLike = (
    globalThis as unknown as { performance?: { now?: () => number } }
  ).performance;
  if (performanceLike !== undefined && typeof performanceLike.now === "function") {
    return performanceLike.now();
  }
  return Date.now();
}

function defaultInputTarget(): InputTarget | undefined {
  const candidate = globalThis as unknown as {
    addEventListener?: unknown;
    removeEventListener?: unknown;
  };
  if (
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  ) {
    return { kind: "window", native: globalThis };
  }
  return undefined;
}

function emitterOf(native: unknown): EventEmitterLike | undefined {
  if (typeof native !== "object" || native === null) return undefined;
  const record = native as Record<string, unknown>;
  if (
    typeof record.addEventListener === "function" &&
    typeof record.removeEventListener === "function"
  ) {
    return native as EventEmitterLike;
  }
  return undefined;
}

function documentHidden(): boolean {
  const doc = (
    globalThis as unknown as {
      document?: { hidden?: unknown; visibilityState?: unknown };
    }
  ).document;
  if (doc === undefined) return false;
  if (typeof doc.hidden === "boolean") return doc.hidden;
  return doc.visibilityState === "hidden";
}

function documentPointerLocked(): boolean {
  const doc = (
    globalThis as unknown as { document?: { pointerLockElement?: unknown } }
  ).document;
  if (doc === undefined) return false;
  return doc.pointerLockElement !== undefined && doc.pointerLockElement !== null;
}

function readField(event: unknown, name: string): unknown {
  if (typeof event !== "object" || event === null) return undefined;
  return (event as Record<string, unknown>)[name];
}

function readString(event: unknown, name: string): string | undefined {
  const value = readField(event, name);
  return typeof value === "string" ? value : undefined;
}

function readNumber(event: unknown, name: string): number | undefined {
  const value = readField(event, name);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(event: unknown, name: string): boolean | undefined {
  const value = readField(event, name);
  return typeof value === "boolean" ? value : undefined;
}

function preventDefaultOf(event: unknown): void {
  const fn = readField(event, "preventDefault");
  if (typeof fn === "function") fn.call(event);
}

function mapKeyFallback(key: string): string | undefined {
  if (key === " " || key === "Spacebar") return "Space";
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (upper >= "A" && upper <= "Z") return `Key${upper}`;
    if (key >= "0" && key <= "9") return `Digit${key}`;
  }
  switch (key) {
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
    case "Enter":
    case "Escape":
    case "Tab":
    case "Backspace":
    case "Delete":
      return key;
    default:
      return undefined;
  }
}

function normalizeKeyboardCode(
  event: unknown,
  stats: InputRouterStats,
): string | undefined {
  const code = readString(event, "code");
  if (code !== undefined && code.length > 0) return code;
  const key = readString(event, "key");
  if (key === undefined || key.length === 0) {
    stats.unknownKeyCodes += 1;
    return undefined;
  }
  const mapped = mapKeyFallback(key);
  if (mapped !== undefined) {
    stats.keyFallbacks += 1;
    return mapped;
  }
  stats.unknownKeyCodes += 1;
  return undefined;
}

function gamepadIndexFromEvent(event: unknown): number {
  const gamepad = readField(event, "gamepad");
  const index = readNumber(gamepad, "index");
  return index !== undefined && index >= 0 ? index : -1;
}

function applyStick(
  view: MutableControllerView,
  leftX: number,
  leftY: number,
  rightX: number,
  rightY: number,
  hasLeft: boolean,
  hasRight: boolean,
): void {
  if (hasLeft) {
    const leftLength = Math.hypot(leftX, leftY);
    const leftScale = leftLength > 1 ? 1 / leftLength : 1;
    view.lx = leftX * leftScale;
    view.ly = leftY * leftScale;
  }
  if (hasRight) {
    const rightLength = Math.hypot(rightX, rightY);
    const rightScale = rightLength > 1 ? 1 / rightLength : 1;
    view.rx = rightX * rightScale;
    view.ry = rightY * rightScale;
  }
}

/**
 * Concrete router. Build with `createInputRouter`; the class is exported for
 * test seams not present in the frozen contract.
 */
export class InputRouterImpl implements InputRouter {
  readonly frame: InputFrameImpl;
  readonly map: InputMapView;
  readonly stats: InputRouterStats = {
    conflicts: 0,
    ignoredOverlayActions: 0,
    nonStandardPads: 0,
    invalidGamepadSnapshots: 0,
    invalidPhoneSamples: 0,
    unknownKeyCodes: 0,
    keyFallbacks: 0,
    storeErrors: 0,
    listenerErrors: 0,
    captureTimeouts: 0,
    deviceErrors: 0,
  };

  /** Wall-clock start of the last capture; diagnostic only. */
  captureStartedAt = -1;

  private readonly slots: number;
  private readonly strictTicks: boolean;
  private readonly preventDefaultPolicy: boolean;
  private readonly preventContextMenu: boolean;
  private readonly capturePointer: boolean;
  private readonly conflictPolicy: "replace" | "reject";
  private readonly reserved: Set<string>;
  private readonly store: BindingStore | undefined;
  private readonly clock: () => number;
  private readonly createGamepads: (() => readonly (GamepadReadout | null)[]) | undefined;
  private readonly fixedKeyboard: number | undefined;
  private readonly fixedGamepads: Readonly<Record<number, number>> | undefined;
  private readonly stickDeadzone: number;
  private readonly triggerDeadzone: number;
  private readonly pointerSensitivity: number;
  private readonly targetDefault: InputTarget | undefined;

  private readonly keyboard = new KeyboardState();
  private readonly pointer = new PointerState();
  private readonly gamepads = new GamepadState();
  private readonly focus = new FocusState();
  private readonly phone: PhoneAdapterImpl;

  private baseActions: InputAction[] = [];
  private kindsMap = new Map<string, InputActionKind>();
  private overlay: BindingOverlay = {};
  private actions: InputAction[] = [];
  private compiled: CompiledMap;
  private readings: ActionReading[][];
  private prevEngaged: Uint8Array[][];
  private prevAggregate: boolean[][];
  private resolvedScratch: ResolvedActionState[];
  private syntheticControllers: MutableControllerView[];

  private assignmentEntries: AssignmentEntry[] = [];
  private slotDevice: (InputDeviceKind | "none")[] = [];
  private slotDeviceId: string[] = [];
  private slotPad: number[] = [];
  private playerDevices: (InputDeviceKind | "none")[] = [];
  private playerDeviceIds: string[] = [];

  private readonly phoneSlotBuffer: number[] = [];
  private readonly padBuffer: number[] = [];
  private readonly connectedBuffer: number[] = [];
  private readonly disconnectedBuffer: number[] = [];
  private pairScratch: MutablePair = { x: 0, y: 0 };

  private pointerWidth = 0;
  private pointerHeight = 0;
  private pointerBoundsExplicit = false;

  private lastTick = -1;
  private lastScanTick = -GAMEPAD_SCAN_INTERVAL_TICKS;
  private assignmentDirty = false;
  private localSlot = 0;
  private preventCodes = new Set<string>();

  private attached = false;
  private disposed = false;
  private currentEmitter: EventEmitterLike | undefined = undefined;
  private currentNative: unknown = undefined;
  private installed: InstalledListener[] = [];
  private readonly listeners = new Set<(event: InputDeviceEvent) => void>();
  private capture: CaptureState | null = null;
  private lastClientX: number | undefined = undefined;
  private lastClientY: number | undefined = undefined;

  constructor(options: EngineInputRouterOptions = {}) {
    const slots = options.slots ?? INPUT_MAX_SLOTS;
    if (!Number.isInteger(slots) || slots < 1 || slots > INPUT_MAX_SLOTS) {
      throw new InputFormatError("slots", `slots must be 1..${INPUT_MAX_SLOTS}`);
    }
    this.slots = slots;
    this.strictTicks = options.strictTicks !== false;
    this.preventDefaultPolicy = options.preventDefault !== false;
    this.preventContextMenu = options.preventContextMenu === true;
    this.capturePointer = options.capturePointer !== false;
    this.conflictPolicy = options.conflictPolicy ?? "replace";
    if (this.conflictPolicy !== "replace" && this.conflictPolicy !== "reject") {
      throw new InputFormatError(
        "conflictPolicy",
        'conflictPolicy must be "replace" or "reject"',
      );
    }
    this.reserved = new Set(options.reservedKeys ?? DEFAULT_RESERVED_KEYS);
    this.store = options.store;
    this.clock = options.clock ?? defaultClock;
    this.createGamepads = options.createGamepads;
    this.fixedKeyboard = options.fixed?.keyboard;
    this.fixedGamepads = options.fixed?.gamepads;
    this.stickDeadzone = readDeadzoneOption(
      options.stickDeadzone,
      "stickDeadzone",
      DEFAULT_STICK_DEADZONE,
    );
    this.triggerDeadzone = readDeadzoneOption(
      options.triggerDeadzone,
      "triggerDeadzone",
      DEFAULT_TRIGGER_DEADZONE,
    );
    const sensitivity = options.pointerSensitivity ?? DEFAULT_POINTER_SENSITIVITY;
    if (!Number.isFinite(sensitivity) || sensitivity < 0) {
      throw new InputFormatError(
        "pointerSensitivity",
        "pointerSensitivity must be a finite non-negative number",
      );
    }
    this.pointerSensitivity = sensitivity;
    this.targetDefault = options.target;
    this.pointerWidth = validExtent(options.pointerWidth);
    this.pointerHeight = validExtent(options.pointerHeight);
    this.pointerBoundsExplicit =
      this.pointerWidth > 0 || this.pointerHeight > 0;

    this.phone = new PhoneAdapterImpl(slots);
    this.baseActions = validateActions(options.actions ?? defaultDesktopMap());
    this.kindsMap = new Map<string, InputActionKind>();
    for (const action of this.baseActions) this.kindsMap.set(action.name, action.kind);

    const state = this.buildState(options.bindings ?? {});
    this.overlay = state.overlay;
    this.actions = state.actions;
    this.compiled = state.compiled;
    this.readings = state.readings;
    this.prevEngaged = state.prevEngaged;
    this.prevAggregate = state.prevAggregate;
    this.resolvedScratch = state.resolved;

    this.frame = new InputFrameImpl(slots, this.actions.length);
    this.syntheticControllers = [];
    for (let slot = 0; slot < slots; slot += 1) {
      const view = createControllerView(slot);
      this.syntheticControllers.push(view);
      const player = this.frame.players[slot];
      if (player !== undefined) player.controller = view;
    }
    this.map = new InputMapView(() => this.frame.actions);
    this.map.setActions(this.actions, this.compiled.names);
    this.frame.setActionNames(this.compiled.names);
    this.buildPreventCodes();

    this.slotDevice = new Array(slots).fill("none");
    this.slotDeviceId = new Array(slots).fill("");
    this.slotPad = new Array(slots).fill(-1);
    this.playerDevices = new Array(slots).fill("none");
    this.playerDeviceIds = new Array(slots).fill("");
    this.recomputeAssignment();
  }

  get assignment(): readonly AssignmentEntry[] {
    return this.assignmentEntries;
  }

  get capturing(): boolean {
    return this.capture !== null;
  }

  /** Current overlay (read-only use; mutate through rebind/setBindings). */
  get bindings(): BindingOverlay {
    return this.overlay;
  }

  /* -----------------------------------------------------------------------
   * Construction-time state
   * -------------------------------------------------------------------- */

  private buildState(overlay: BindingOverlay): BuiltState {
    const normalized = validateBindingOverlay(overlay, this.kindsMap);
    const effective = this.applyOverlay(normalized);
    const validated = validateActions(effective);
    const compiled = compileActionMap(validated, {
      keyId: (code) => this.keyboard.register(code),
    });

    const readings: ActionReading[][] = [];
    for (const plan of compiled.plans) {
      const row: ActionReading[] = [];
      for (let i = 0; i < plan.bindings.length; i += 1) {
        row.push(createActionReading());
      }
      readings.push(row);
    }

    const prevEngaged: Uint8Array[][] = [];
    const prevAggregate: boolean[][] = [];
    for (let slot = 0; slot < this.slots; slot += 1) {
      const engagedRow: Uint8Array[] = [];
      const aggregateRow: boolean[] = [];
      for (const plan of compiled.plans) {
        engagedRow.push(new Uint8Array(plan.bindings.length));
        aggregateRow.push(false);
      }
      prevEngaged.push(engagedRow);
      prevAggregate.push(aggregateRow);
    }

    const resolved: ResolvedActionState[] = [];
    for (let i = 0; i < compiled.plans.length; i += 1) {
      resolved.push(createResolvedActionState());
    }

    return {
      overlay: normalized,
      actions: validated,
      compiled,
      readings,
      prevEngaged,
      prevAggregate,
      resolved,
    };
  }

  private applyOverlay(overlay: BindingOverlay): InputAction[] {
    const effective: InputAction[] = [];
    for (const action of this.baseActions) {
      const value = overlay[action.name];
      if (value === undefined || value === null) {
        effective.push(action);
      } else {
        effective.push({ ...action, bindings: value });
      }
    }
    for (const key of Object.keys(overlay)) {
      if (!this.kindsMap.has(key)) this.stats.ignoredOverlayActions += 1;
    }
    return effective;
  }

  private buildPreventCodes(): void {
    this.preventCodes = new Set<string>();
    for (const action of this.actions) {
      for (const binding of action.bindings) {
        if (binding.device === "keyboard" && PREVENT_KEYS.has(binding.code)) {
          this.preventCodes.add(binding.code);
        }
      }
    }
  }

  private setBindingsInternal(overlay: BindingOverlay): void {
    const state = this.buildState(overlay);
    this.overlay = state.overlay;
    this.actions = state.actions;
    this.compiled = state.compiled;
    this.readings = state.readings;
    this.prevEngaged = state.prevEngaged;
    this.prevAggregate = state.prevAggregate;
    this.resolvedScratch = state.resolved;
    this.buildPreventCodes();
    this.map.setActions(this.actions, this.compiled.names);
    this.frame.setActionNames(this.compiled.names);
  }

  /* -----------------------------------------------------------------------
   * Assignment
   * -------------------------------------------------------------------- */

  private isFixedPad(index: number): boolean {
    if (this.fixedGamepads === undefined) return false;
    return Object.prototype.hasOwnProperty.call(this.fixedGamepads, String(index));
  }

  private presentPadCount(): number {
    let count = 0;
    for (let index = 0; index < INPUT_MAX_GAMEPADS; index += 1) {
      const record = this.gamepads.record(index);
      if (record !== undefined && record.present) count += 1;
    }
    return count;
  }

  private recomputeAssignment(): void {
    this.phone.connectedSlots(this.phoneSlotBuffer);
    this.padBuffer.length = 0;
    for (let index = 0; index < INPUT_MAX_GAMEPADS; index += 1) {
      if (this.gamepads.isEligible(index, this.isFixedPad(index))) {
        this.padBuffer.push(index);
      }
    }
    const result = computeAssignment({
      slots: this.slots,
      phones: this.phoneSlotBuffer,
      keyboardAvailable: true,
      pads: this.padBuffer,
      fixedKeyboard: this.fixedKeyboard,
      fixedGamepads: this.fixedGamepads,
      previous: this.assignmentEntries,
    });
    this.stats.conflicts += result.conflicts;
    if (!sameAssignment(this.assignmentEntries, result.entries)) {
      this.assignmentEntries = result.entries;
      this.rebuildAssignmentLookups();
    }
    this.phone.topologyDirty = false;
    this.gamepads.topologyDirty = false;
    this.assignmentDirty = false;
  }

  private rebuildAssignmentLookups(): void {
    this.slotDevice.fill("none");
    this.slotDeviceId.fill("");
    this.slotPad.fill(-1);
    let keyboardSlot = -1;
    for (const entry of this.assignmentEntries) {
      if (
        !Number.isInteger(entry.slot) ||
        entry.slot < 0 ||
        entry.slot >= this.slots
      ) {
        continue;
      }
      this.slotDevice[entry.slot] = entry.device;
      this.slotDeviceId[entry.slot] = entry.deviceId;
      if (entry.device === "gamepad") {
        const pad = parsePadIndex(entry.deviceId);
        if (pad >= 0) this.slotPad[entry.slot] = pad;
      } else if (entry.device === "keyboard") {
        keyboardSlot = entry.slot;
      }
    }
    this.localSlot = keyboardSlot >= 0 ? keyboardSlot : 0;
    this.frame.setLocalSlot(this.localSlot);
  }

  /* -----------------------------------------------------------------------
   * Poll
   * -------------------------------------------------------------------- */

  poll(tick: number): InputFrameImpl {
    if (this.disposed) return this.frame;
    if (!Number.isInteger(tick) || tick < 0) {
      throw new InputTickError(`tick must be a non-negative integer, got ${tick}`);
    }
    if (tick === this.lastTick) return this.frame;
    if (tick < this.lastTick) {
      if (this.strictTicks) {
        throw new InputTickError(
          `tick ${tick} is older than the last polled tick ${this.lastTick}`,
        );
      }
      return this.frame;
    }
    this.lastTick = tick;
    this.focus.notePoll(tick);

    this.scanGamepads(tick);
    this.drainGamepadEvents();
    if (
      this.phone.topologyDirty ||
      this.gamepads.topologyDirty ||
      this.assignmentDirty
    ) {
      this.recomputeAssignment();
    }

    this.resolveAll();
    this.phone.publishEdges();
    this.updateFrame(tick);
    // The frame above is built with the old map; a captured pad press is
    // consumed by the capture and the new bindings apply from the next poll.
    this.checkGamepadCapture();
    this.clearPerTick();

    this.stats.nonStandardPads = this.gamepads.nonStandardPads;
    this.stats.invalidGamepadSnapshots = this.gamepads.invalidSnapshots;
    this.stats.invalidPhoneSamples = this.phone.invalidSamples;
    return this.frame;
  }

  private scanGamepads(tick: number): void {
    if (this.createGamepads === undefined) return;
    const present = this.presentPadCount();
    if (
      present === 0 &&
      tick - this.lastScanTick < GAMEPAD_SCAN_INTERVAL_TICKS
    ) {
      return;
    }
    const readouts = this.createGamepads();
    this.gamepads.applyReadouts(readouts);
    this.lastScanTick = tick;
  }

  private drainGamepadEvents(): void {
    this.connectedBuffer.length = 0;
    this.disconnectedBuffer.length = 0;
    this.gamepads.drainEvents(this.connectedBuffer, this.disconnectedBuffer);
    for (const index of this.connectedBuffer) {
      this.emit({ type: "gamepad-connected", index });
    }
    for (const index of this.disconnectedBuffer) {
      this.emit({ type: "gamepad-disconnected", index });
    }
  }

  private clearPerTick(): void {
    this.keyboard.clearPending();
    this.pointer.clearAfterPoll();
    this.gamepads.clearPending();
  }

  private updateFrame(tick: number): void {
    this.frame.tick = tick;
    this.frame.setLocalSlot(this.localSlot);

    const pointer = this.frame.pointer;
    pointer.x = this.pointer.x;
    pointer.y = this.pointer.y;
    pointer.dx = this.pointer.dx;
    pointer.dy = this.pointer.dy;
    pointer.wheel = this.pointer.wheel;
    pointer.buttons = this.pointer.buttons;
    pointer.edges = this.pointer.pressPending;
    pointer.inside = this.pointer.inside;
    pointer.locked = this.pointer.locked;

    const focus = this.frame.focus;
    focus.focused = this.focus.focused;
    focus.visible = this.focus.visible;
    focus.pointerLocked = this.pointer.locked;
    focus.lastBlurTick = this.focus.lastBlurTick;

    for (let slot = 0; slot < this.slots; slot += 1) {
      const device = this.slotDevice[slot];
      if (device === "keyboard" || device === "gamepad") {
        this.synthesizeSlot(slot, device);
      }
    }
  }

  /* -----------------------------------------------------------------------
   * Resolution
   * -------------------------------------------------------------------- */

  private clearPrevious(slot: number): void {
    const engaged = this.prevEngaged[slot];
    if (engaged !== undefined) {
      for (const row of engaged) row.fill(0);
    }
    const aggregate = this.prevAggregate[slot];
    if (aggregate !== undefined) {
      for (let i = 0; i < aggregate.length; i += 1) aggregate[i] = false;
    }
  }

  private zeroSlot(slot: number): void {
    const player = this.frame.players[slot];
    if (player === undefined) return;
    player.connected = false;
    player.device = "none";
    // One-shot release edges for actions held when a non-phone device
    // disappears (10 §5.6). A lost phone synthesizes no button-up (§5.14):
    // its view is already zeroed and consumers treat disconnected as all-up.
    const synthesizeReleases = this.playerDevices[slot] !== "phone";
    for (const action of player.actions) {
      if (synthesizeReleases && action.pressed) {
        action.pressed = false;
        action.released = true;
        action.edges = 0;
        action.releaseEdges = 1;
        action.x = 0;
        action.y = 0;
        action.value = 0;
      } else {
        zeroActionState(action);
      }
    }
    const synthetic = this.syntheticControllers[slot];
    if (synthetic !== undefined) {
      zeroControllerView(synthetic);
      player.controller = synthetic;
    }
    this.clearPrevious(slot);
    this.playerDevices[slot] = "none";
    this.playerDeviceIds[slot] = "";
  }

  private beginPlayer(
    slot: number,
    device: InputDeviceKind,
    deviceId: string,
  ): void {
    if (
      this.playerDevices[slot] !== device ||
      this.playerDeviceIds[slot] !== deviceId
    ) {
      this.clearPrevious(slot);
      this.playerDevices[slot] = device;
      this.playerDeviceIds[slot] = deviceId;
    }
  }

  private resolveAll(): void {
    for (let slot = 0; slot < this.slots; slot += 1) {
      const device = this.slotDevice[slot] ?? "none";
      const player = this.frame.players[slot];
      if (player === undefined) continue;

      if (device === "none") {
        this.zeroSlot(slot);
        continue;
      }

      if (device === "phone") {
        const view = this.phone.view(slot);
        if (!this.phone.isConnected(slot) || view === undefined) {
          this.zeroSlot(slot);
          continue;
        }
        this.beginPlayer(slot, "phone", this.slotDeviceId[slot] ?? `phone:${slot}`);
        player.connected = true;
        player.device = "phone";
        player.controller = view;
        this.resolvePlayerActions(slot, "phone");
        continue;
      }

      this.beginPlayer(
        slot,
        device,
        this.slotDeviceId[slot] ?? `${device}:${slot}`,
      );
      player.connected = true;
      player.device = device;
      const synthetic = this.syntheticControllers[slot];
      if (synthetic !== undefined) player.controller = synthetic;
      this.resolvePlayerActions(slot, device);
    }
  }

  private resolvePlayerActions(slot: number, device: InputDeviceKind): void {
    const player = this.frame.players[slot];
    if (player === undefined) return;
    const engagedRow = this.prevEngaged[slot];
    const aggregateRow = this.prevAggregate[slot];
    if (engagedRow === undefined || aggregateRow === undefined) return;

    for (let actionIndex = 0; actionIndex < this.compiled.plans.length; actionIndex += 1) {
      const plan = this.compiled.plans[actionIndex];
      const state = player.actions[actionIndex];
      if (plan === undefined || state === undefined) continue;

      this.computePairs(plan, slot);
      const readings = this.readings[actionIndex];
      if (readings === undefined || readings.length !== plan.bindings.length) continue;
      for (let bindingIndex = 0; bindingIndex < plan.bindings.length; bindingIndex += 1) {
        const reading = readings[bindingIndex];
        const binding = plan.bindings[bindingIndex];
        if (reading === undefined || binding === undefined) continue;
        resetActionReading(reading);
        reading.digital = binding.digital;
        reading.scaleX = binding.scale;
        reading.scaleY = binding.scale;
        this.fillReading(plan, binding, slot, device, reading);
      }

      const previous = engagedRow[actionIndex];
      const out = this.resolvedScratch[actionIndex];
      if (previous === undefined || out === undefined) continue;
      const aggregate = resolveAction(
        plan.kind,
        plan.threshold,
        plan.hysteresis,
        plan.yUp,
        readings,
        previous,
        aggregateRow[actionIndex] === true,
        out,
      );
      aggregateRow[actionIndex] = aggregate;

      state.pressed = out.pressed;
      state.edges = out.edges;
      state.released = out.released;
      state.releaseEdges = out.releaseEdges;
      state.x = out.x;
      state.y = out.y;
      state.value = out.value;
    }
  }

  private computePairs(plan: CompiledAction, slot: number): void {
    for (let pairIndex = 0; pairIndex < plan.pairs.length; pairIndex += 1) {
      const pair = plan.pairs[pairIndex];
      if (pair === undefined) continue;
      let x = 0;
      let y = 0;
      if (pair.device === "phone") {
        const target = pair.index === -1 ? slot : pair.index;
        if (this.phone.isConnected(target)) {
          const view = this.phone.view(target);
          if (view !== undefined) {
            if (pair.pair === 0) {
              x = view.lx;
              y = view.ly;
            } else {
              x = view.rx;
              y = view.ry;
            }
          }
        }
      } else {
        const pad = pair.index === -1 ? (this.slotPad[slot] ?? -1) : pair.index;
        const record = pad >= 0 ? this.gamepads.record(pad) : undefined;
        if (
          record !== undefined &&
          record.present &&
          record.connected &&
          record.mapping === "standard"
        ) {
          const firstAxis = pair.pair === 0 ? 0 : 2;
          x = record.axes[firstAxis] ?? 0;
          y = record.axes[firstAxis + 1] ?? 0;
        }
      }
      const deadzone = plan.deadzone ?? this.stickDeadzone;
      radialDeadzoneInto(x, y, deadzone, this.pairScratch);
      plan.pairX[pairIndex] = this.pairScratch.x;
      plan.pairY[pairIndex] = this.pairScratch.y;
    }
  }

  private setReadingValue(
    plan: CompiledAction,
    binding: CompiledBinding,
    reading: ActionReading,
    value: number,
  ): void {
    if (plan.kind === "vector2") {
      if (binding.contribution === "y") {
        reading.hasY = true;
        reading.y = value;
        reading.scaleY = binding.scale;
      } else {
        reading.hasX = true;
        reading.x = value;
        reading.scaleX = binding.scale;
      }
      return;
    }
    reading.hasX = true;
    reading.x = value;
    reading.scaleX = binding.scale;
  }

  private fillReading(
    plan: CompiledAction,
    binding: CompiledBinding,
    slot: number,
    device: InputDeviceKind,
    reading: ActionReading,
  ): void {
    const capture = this.capture;
    if (capture !== null && capture.device === binding.device) return;
    switch (binding.device) {
      case "phone": {
        const target = binding.phoneSlot === -1 ? slot : binding.phoneSlot;
        if (!this.phone.isConnected(target)) return;
        const view = this.phone.view(target);
        if (view === undefined) return;
        if (binding.phoneBit >= 0) {
          const level = (view.buttons >>> binding.phoneBit) & 1;
          const value = scalarDeadzone(level, plan.deadzone ?? 0);
          reading.pendingPress = this.phone.pendingPress(target, binding.phoneBit);
          this.setReadingValue(plan, binding, reading, value);
          return;
        }
        if (binding.phoneTrigger) {
          const raw =
            binding.phoneAxis === 4 ? view.triggers.lt : view.triggers.rt;
          const value = scalarDeadzone(
            raw,
            plan.deadzone ?? this.triggerDeadzone,
          );
          this.setReadingValue(plan, binding, reading, value);
          return;
        }
        if (binding.pair < 0) return;
        const raw =
          binding.pairComponent === "y"
            ? (plan.pairY[binding.pair] ?? 0)
            : (plan.pairX[binding.pair] ?? 0);
        this.setReadingValue(plan, binding, reading, raw);
        return;
      }

      case "keyboard": {
        if (device !== "keyboard" || slot !== this.localSlot) return;
        if (binding.keyId < 0) return;
        const value = scalarDeadzone(
          this.keyboard.isDown(binding.keyId) ? 1 : 0,
          plan.deadzone ?? 0,
        );
        reading.pendingPress = this.keyboard.isPressPending(binding.keyId);
        reading.pendingRelease = this.keyboard.isReleasePending(binding.keyId);
        this.setReadingValue(plan, binding, reading, value);
        return;
      }

      case "pointer": {
        if (slot !== this.localSlot) return;
        if (binding.pointerButton >= 0) {
          const bit = 1 << binding.pointerButton;
          const level = (this.pointer.buttons & bit) !== 0 ? 1 : 0;
          const value = scalarDeadzone(level, plan.deadzone ?? 0);
          reading.pendingPress = (this.pointer.pressPending & bit) !== 0;
          reading.pendingRelease = (this.pointer.releasePending & bit) !== 0;
          this.setReadingValue(plan, binding, reading, value);
          return;
        }
        let raw = 0;
        switch (binding.pointerAxis) {
          case 0:
            raw =
              this.pointerWidth > 0
                ? clampSigned((this.pointer.x / this.pointerWidth) * 2 - 1)
                : 0;
            break;
          case 1:
            raw =
              this.pointerHeight > 0
                ? clampSigned((this.pointer.y / this.pointerHeight) * 2 - 1)
                : 0;
            break;
          case 2:
            raw = clampSigned(
              (this.pointer.dx * this.pointerSensitivity) /
                POINTER_MOTION_FULL_DEFLECTION_PX,
            );
            break;
          case 3:
            raw = clampSigned(
              (this.pointer.dy * this.pointerSensitivity) /
                POINTER_MOTION_FULL_DEFLECTION_PX,
            );
            break;
          case 4:
            raw = clampSigned(
              this.pointer.wheel / POINTER_WHEEL_FULL_DEFLECTION,
            );
            break;
          default:
            raw = 0;
        }
        const value = scalarDeadzone(raw, plan.deadzone ?? 0);
        this.setReadingValue(plan, binding, reading, value);
        return;
      }

      case "gamepad": {
        const pad =
          binding.padIndex === -1 ? (this.slotPad[slot] ?? -1) : binding.padIndex;
        if (pad < 0) return;
        const record = this.gamepads.record(pad);
        if (
          record === undefined ||
          !record.present ||
          !record.connected ||
          record.mapping !== "standard"
        ) {
          return;
        }
        if (binding.padButton >= 0) {
          let raw: number;
          let deadzone: number;
          if (binding.padButton === 6 || binding.padButton === 7) {
            raw =
              binding.padButton === 6 ? record.triggerLt : record.triggerRt;
            deadzone = plan.deadzone ?? this.triggerDeadzone;
          } else {
            raw = (record.buttons >>> binding.padButton) & 1;
            deadzone = plan.deadzone ?? 0;
          }
          const value = scalarDeadzone(raw, deadzone);
          const bit = 1 << binding.padButton;
          reading.pendingPress = (record.pressPending & bit) !== 0;
          reading.pendingRelease = (record.releasePending & bit) !== 0;
          this.setReadingValue(plan, binding, reading, value);
          return;
        }
        if (binding.pair < 0) return;
        const raw =
          binding.pairComponent === "y"
            ? (plan.pairY[binding.pair] ?? 0)
            : (plan.pairX[binding.pair] ?? 0);
        this.setReadingValue(plan, binding, reading, raw);
        return;
      }

      default:
        return;
    }
  }

  /* -----------------------------------------------------------------------
   * Synthesis
   * -------------------------------------------------------------------- */

  private synthesizeSlot(slot: number, device: InputDeviceKind): void {
    const player = this.frame.players[slot];
    const view = this.syntheticControllers[slot];
    if (player === undefined || view === undefined) return;

    zeroControllerView(view);
    view.connected = true;
    view.tick = this.frame.tick;

    let leftX = 0;
    let leftY = 0;
    let rightX = 0;
    let rightY = 0;
    let hasLeftStick = false;
    let hasRightStick = false;

    for (let actionIndex = 0; actionIndex < this.compiled.plans.length; actionIndex += 1) {
      const plan = this.compiled.plans[actionIndex];
      const state = player.actions[actionIndex];
      if (plan === undefined || state === undefined) continue;
      const output = plan.output;
      if (output === undefined) continue;

      if (output.button !== undefined && state.pressed) {
        const bit = 1 << output.button;
        view.buttons |= bit;
        if ((state.edges & 1) !== 0) view.edges |= bit;
      }
      if (output.stick !== undefined) {
        const stickY = plan.yUp ? -state.y : state.y;
        if (output.stick === "left") {
          hasLeftStick = true;
          leftX += state.x;
          leftY += stickY;
        } else {
          hasRightStick = true;
          rightX += state.x;
          rightY += stickY;
        }
      }
      if (output.trigger !== undefined) {
        const value = clamp01(state.value);
        if (output.trigger === "lt") {
          view.triggers.lt = Math.max(view.triggers.lt, value);
        } else {
          view.triggers.rt = Math.max(view.triggers.rt, value);
        }
      }
      if (output.axis !== undefined) {
        // Axis output reads signed x; a vector's y component reads the
        // pre-yUp value for ly/ry.
        const isY = output.axis === "ly" || output.axis === "ry";
        const value =
          plan.kind !== "axis" && isY
            ? (plan.yUp ? -state.y : state.y)
            : state.x;
        switch (output.axis) {
          case "lx":
            view.lx = value;
            break;
          case "ly":
            view.ly = value;
            break;
          case "rx":
            view.rx = value;
            break;
          case "ry":
            view.ry = value;
            break;
        }
      }
    }

    applyStick(
      view,
      leftX,
      leftY,
      rightX,
      rightY,
      hasLeftStick,
      hasRightStick,
    );
    player.connected = true;
    player.device = device;
    player.controller = view;
  }

  /* -----------------------------------------------------------------------
   * Seams and DOM bridge
   * -------------------------------------------------------------------- */

  setKeyboardKey(code: string, down: boolean, repeat = false): void {
    if (down) {
      if (repeat) return;
      if (this.capture !== null) {
        if (this.handleCaptureKey(code)) return;
        // Keyboard capture consumes every keyboard event, not only the one
        // that completes it (10 §5.11 step 2).
        if (this.capture !== null && this.capture.device === "keyboard") return;
      }
      this.keyboard.keyDown(code);
      return;
    }
    if (this.capture !== null && this.capture.device === "keyboard") return;
    this.keyboard.keyUp(code);
  }

  setPointerSnapshot(snapshot: PointerSnapshot): void {
    this.pointer.applySnapshot(snapshot);
  }

  setGamepadSnapshot(snapshot: GamepadSnapshot): void {
    this.gamepads.applySnapshot(snapshot);
  }

  setGamepadDisconnected(index: number): void {
    this.gamepads.disconnectIndex(index);
  }

  setPointerBounds(width: number, height: number): void {
    if (Number.isFinite(width) && width > 0) this.pointerWidth = width;
    if (Number.isFinite(height) && height > 0) this.pointerHeight = height;
    this.pointerBoundsExplicit = true;
  }

  setFocused(focused: boolean): void {
    if (focused) {
      if (this.focus.setFocused(true)) {
        this.emit({ type: "focus-changed", focused: true });
      }
      return;
    }
    this.handleBlur();
  }

  setVisible(visible: boolean): void {
    const changed = this.focus.setVisible(visible);
    if (!visible) this.releaseLocalInput();
    if (changed) {
      this.emit({ type: "focus-changed", focused: this.focus.focused });
    }
  }

  setPointerLocked(locked: boolean): void {
    this.pointer.setLocked(locked);
    this.focus.setPointerLocked(locked);
  }

  private handleBlur(): void {
    const changed = this.focus.setFocused(false);
    this.releaseLocalInput();
    if (changed) this.emit({ type: "focus-changed", focused: false });
  }

  private releaseLocalInput(): void {
    this.keyboard.releaseAll();
    this.pointer.blur();
    if (this.capture !== null) {
      this.finishCapture({ ok: false, reason: "cancelled" });
    }
  }

  private shouldPreventKey(code: string): boolean {
    return (
      this.preventDefaultPolicy &&
      code !== "Tab" &&
      !this.reserved.has(code) &&
      this.preventCodes.has(code)
    );
  }

  attach(target?: InputTarget): void {
    if (this.disposed) return;
    if (this.attached) {
      this.removeListeners();
      this.keyboard.releaseAll();
      this.pointer.blur();
      this.attached = false;
    }
    this.keyboard.clearPending();
    this.pointer.clearAfterPoll();

    const chosen = target ?? this.targetDefault ?? defaultInputTarget();
    if (chosen === undefined) {
      this.stats.deviceErrors += 1;
      return;
    }
    const emitter = emitterOf(chosen.native);
    if (emitter === undefined) {
      this.stats.deviceErrors += 1;
      return;
    }
    this.currentEmitter = emitter;
    this.currentNative = chosen.native;
    this.attached = true;
    this.installListeners(emitter);
    if (chosen.kind === "element" && !this.pointerBoundsExplicit) {
      this.inferPointerBounds(chosen.native);
    }
  }

  detach(): void {
    if (this.attached) {
      this.removeListeners();
      this.keyboard.releaseAll();
      this.pointer.blur();
      this.attached = false;
    }
    if (this.capture !== null) {
      this.finishCapture({ ok: false, reason: "cancelled" });
    }
  }

  private inferPointerBounds(native: unknown): void {
    if (typeof native !== "object" || native === null) return;
    const record = native as Record<string, unknown>;
    const width = record.clientWidth;
    const height = record.clientHeight;
    if (typeof width === "number" && width > 0) this.pointerWidth = width;
    if (typeof height === "number" && height > 0) this.pointerHeight = height;
  }

  private installListeners(emitter: EventEmitterLike): void {
    this.listen(emitter, "keydown", (event) => this.onKeyDown(event));
    this.listen(emitter, "keyup", (event) => this.onKeyUp(event));
    this.listen(emitter, "pointerdown", (event) => this.onPointerDown(event));
    this.listen(emitter, "pointerup", (event) => this.onPointerUp(event));
    this.listen(emitter, "pointermove", (event) => this.onPointerMove(event));
    this.listen(emitter, "pointerenter", () => {
      this.pointer.setInside(true);
      this.lastClientX = undefined;
      this.lastClientY = undefined;
    });
    this.listen(emitter, "pointerleave", () => {
      this.pointer.setInside(false);
      this.lastClientX = undefined;
      this.lastClientY = undefined;
    });
    this.listen(emitter, "pointercancel", () => this.pointer.blur());
    this.listen(
      emitter,
      "wheel",
      (event) => this.onWheel(event),
      WHEEL_LISTENER_OPTIONS,
    );
    this.listen(emitter, "contextmenu", (event) => this.onContextMenu(event));
    this.listen(emitter, "blur", () => this.handleBlur());
    this.listen(emitter, "focus", () => this.setFocused(true));
    this.listen(emitter, "visibilitychange", () => this.onVisibilityChange());
    this.listen(emitter, "pointerlockchange", () =>
      this.setPointerLocked(documentPointerLocked()),
    );
    this.listen(emitter, "pointerlockerror", () => this.setPointerLocked(false));
    this.listen(emitter, "gamepadconnected", () => {
      this.gamepads.topologyDirty = true;
    });
    this.listen(emitter, "gamepaddisconnected", (event) => {
      const index = gamepadIndexFromEvent(event);
      if (index >= 0) this.setGamepadDisconnected(index);
      this.gamepads.topologyDirty = true;
    });
  }

  private listen(
    emitter: EventEmitterLike,
    type: string,
    handler: (event: unknown) => void,
    options?: unknown,
  ): void {
    emitter.addEventListener(type, handler, options);
    this.installed.push(
      options === undefined ? { type, handler } : { type, handler, options },
    );
  }

  private removeListeners(): void {
    const emitter = this.currentEmitter;
    if (emitter !== undefined) {
      for (const listener of this.installed) {
        emitter.removeEventListener(
          listener.type,
          listener.handler,
          listener.options,
        );
      }
    }
    this.installed.length = 0;
    this.currentEmitter = undefined;
    this.currentNative = undefined;
  }

  /** Pointer capture is best-effort: absence or refusal is counted, not fatal. */
  private nativePointerCapture(event: unknown, set: boolean): void {
    const native = this.currentNative;
    if (typeof native !== "object" || native === null) return;
    const method = set ? "setPointerCapture" : "releasePointerCapture";
    const fn = (native as Record<string, unknown>)[method];
    const pointerId = readNumber(event, "pointerId");
    if (typeof fn !== "function" || pointerId === undefined) return;
    try {
      (fn as (this: unknown, pointerId: number) => void).call(native, pointerId);
    } catch {
      this.stats.deviceErrors += 1;
    }
  }

  private onKeyDown(event: unknown): void {
    const code = normalizeKeyboardCode(event, this.stats);
    if (code === undefined) return;
    if (this.shouldPreventKey(code)) preventDefaultOf(event);
    this.setKeyboardKey(code, true, readBoolean(event, "repeat") === true);
  }

  private onKeyUp(event: unknown): void {
    const code = normalizeKeyboardCode(event, this.stats);
    if (code === undefined) return;
    if (this.shouldPreventKey(code)) preventDefaultOf(event);
    this.setKeyboardKey(code, false);
  }

  private onPointerDown(event: unknown): void {
    const button = readNumber(event, "button");
    if (button === undefined || button < 0 || button > 2) return;
    if (this.handleCapturePointerButton(button)) return;
    this.pointer.down(button);
    if (this.capturePointer) this.nativePointerCapture(event, true);
  }

  private onPointerUp(event: unknown): void {
    const button = readNumber(event, "button");
    if (button === undefined || button < 0 || button > 2) return;
    if (this.capture !== null && this.capture.device === "pointer") return;
    this.pointer.up(button);
    if (this.capturePointer) this.nativePointerCapture(event, false);
  }

  private onPointerMove(event: unknown): void {
    // Motion alone never captures, but while a pointer capture is pending its
    // events are consumed and must not drive actions (10 §5.11 step 2).
    if (this.capture !== null && this.capture.device === "pointer") return;
    const clientX = readNumber(event, "clientX");
    const clientY = readNumber(event, "clientY");
    const movementX = readNumber(event, "movementX");
    const movementY = readNumber(event, "movementY");

    let dx = 0;
    let dy = 0;
    if (movementX !== undefined) {
      dx = movementX;
    } else if (clientX !== undefined && this.lastClientX !== undefined) {
      dx = clientX - this.lastClientX;
    }
    if (movementY !== undefined) {
      dy = movementY;
    } else if (clientY !== undefined && this.lastClientY !== undefined) {
      dy = clientY - this.lastClientY;
    }
    if (clientX !== undefined) this.lastClientX = clientX;
    if (clientY !== undefined) this.lastClientY = clientY;

    const offsetX = readNumber(event, "offsetX") ?? clientX;
    const offsetY = readNumber(event, "offsetY") ?? clientY;
    this.pointer.move(dx, dy, offsetX, offsetY);
    this.pointer.setInside(true);
  }

  private onWheel(event: unknown): void {
    const deltaY = readNumber(event, "deltaY") ?? 0;
    const deltaMode = readNumber(event, "deltaMode") ?? 0;
    const pixels =
      deltaY *
      (deltaMode === 1
        ? POINTER_WHEEL_LINE_PX
        : deltaMode === 2
          ? POINTER_WHEEL_PAGE_PX
          : 1);
    if (this.handleCapturePointerWheel()) return;
    this.pointer.wheelDelta(pixels);
  }

  private onContextMenu(event: unknown): void {
    if (this.preventContextMenu) preventDefaultOf(event);
  }

  private onVisibilityChange(): void {
    const hidden = documentHidden();
    const changed = this.focus.setVisible(!hidden);
    if (hidden) this.releaseLocalInput();
    if (changed) {
      this.emit({ type: "focus-changed", focused: this.focus.focused });
    }
  }

  /* -----------------------------------------------------------------------
   * Rebinding
   * -------------------------------------------------------------------- */

  beginCapture(
    action: string,
    bindingIndex: number,
    device: InputDeviceKind,
    timeoutMs?: number,
  ): Promise<RebindResult> {
    if (this.disposed) {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    if (this.capture !== null) {
      return Promise.resolve({ ok: false, reason: "busy" });
    }
    if (device === "phone") {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    const actionIndex = this.map.indexOf(action);
    if (actionIndex < 0) {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    const target = this.actions[actionIndex];
    if (
      target === undefined ||
      !Number.isInteger(bindingIndex) ||
      bindingIndex < 0 ||
      bindingIndex >= target.bindings.length
    ) {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    const oldBinding = target.bindings[bindingIndex];
    if (oldBinding === undefined) {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }
    const timeout = timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout < 0) {
      return Promise.resolve({ ok: false, reason: "unsupported" });
    }

    let resolveCapture!: (result: RebindResult) => void;
    const promise = new Promise<RebindResult>((resolve) => {
      resolveCapture = resolve;
    });
    const timer = setTimeout(() => {
      this.stats.captureTimeouts += 1;
      this.finishCapture({ ok: false, reason: "timeout" });
    }, timeout);
    this.captureStartedAt = this.clock();
    this.capture = {
      actionIndex,
      bindingIndex,
      actionName: target.name,
      kind: target.kind,
      device,
      oldBinding,
      resolve: resolveCapture,
      timer,
    };
    // A key held before the capture cannot deliver its keyup while keyboard
    // events are consumed; release it now so it cannot stay stuck.
    if (device === "keyboard") this.keyboard.releaseAll();
    return promise;
  }

  cancelCapture(): void {
    if (this.capture !== null) {
      this.finishCapture({ ok: false, reason: "cancelled" });
    }
  }

  private finishCapture(result: RebindResult): void {
    const capture = this.capture;
    if (capture === null) return;
    clearTimeout(capture.timer);
    this.capture = null;
    capture.resolve(result);
    this.emit({ type: "capture", result });
  }

  private handleCaptureKey(code: string): boolean {
    const capture = this.capture;
    if (capture === null) return false;
    if (code === "Escape") {
      this.finishCapture({ ok: false, reason: "cancelled" });
      return true;
    }
    if (capture.device !== "keyboard") return false;
    if (this.reserved.has(code)) {
      this.finishCapture({ ok: false, reason: "reserved" });
      return true;
    }
    const target = this.actions[capture.actionIndex];
    if (target === undefined) {
      this.finishCapture({ ok: false, reason: "unsupported" });
      return true;
    }
    this.completeCapture(
      capture,
      buildKeyboardBinding(code, capture.oldBinding, target.kind),
    );
    return true;
  }

  private handleCapturePointerButton(button: number): boolean {
    const capture = this.capture;
    if (capture === null || capture.device !== "pointer") return false;
    const target = this.actions[capture.actionIndex];
    if (target === undefined) {
      this.finishCapture({ ok: false, reason: "unsupported" });
      return true;
    }
    this.completeCapture(
      capture,
      buildPointerButtonBinding(button, capture.oldBinding, target.kind),
    );
    return true;
  }

  private handleCapturePointerWheel(): boolean {
    const capture = this.capture;
    if (capture === null || capture.device !== "pointer") return false;
    const target = this.actions[capture.actionIndex];
    if (target === undefined) {
      this.finishCapture({ ok: false, reason: "unsupported" });
      return true;
    }
    this.completeCapture(
      capture,
      buildPointerWheelBinding(capture.oldBinding, target.kind),
    );
    return true;
  }

  private checkGamepadCapture(): void {
    const capture = this.capture;
    if (capture === null || capture.device !== "gamepad") return;
    const target = this.actions[capture.actionIndex];
    if (target === undefined) {
      this.finishCapture({ ok: false, reason: "unsupported" });
      return;
    }
    for (let pad = 0; pad < INPUT_MAX_GAMEPADS; pad += 1) {
      const record = this.gamepads.record(pad);
      if (
        record === undefined ||
        !record.present ||
        !record.connected ||
        record.mapping !== "standard"
      ) {
        continue;
      }
      const pressed = lowestSetBit(record.pressPending & 0x1ffff);
      if (pressed >= 0) {
        this.completeCapture(
          capture,
          buildGamepadButtonBinding(pressed, capture.oldBinding, target.kind),
        );
        return;
      }
      for (let axis = 0; axis < 4; axis += 1) {
        const value = record.axes[axis];
        if (
          value !== undefined &&
          Math.abs(value) > CAPTURE_AXIS_THRESHOLD
        ) {
          this.completeCapture(
            capture,
            buildGamepadAxisBinding(
              axis,
              value,
              capture.oldBinding,
              target.kind,
            ),
          );
          return;
        }
      }
    }
  }

  private completeCapture(capture: CaptureState, candidate: InputBinding): void {
    const outcome = rebindInActions(
      this.actions,
      capture.actionIndex,
      capture.bindingIndex,
      candidate,
      this.conflictPolicy,
    );
    if (!outcome.ok) {
      this.finishCapture({
        ok: false,
        reason: "conflict",
        conflict: outcome.conflict,
      });
      return;
    }

    const overlay: Record<string, readonly InputBinding[] | null> = {
      ...this.overlay,
    };
    for (const change of outcome.changed) {
      const action = this.actions[change.index];
      if (action !== undefined) overlay[action.name] = change.bindings;
    }
    try {
      this.setBindingsInternal(overlay);
    } catch {
      this.finishCapture({ ok: false, reason: "unsupported" });
      return;
    }
    if (outcome.changed.length > 1) this.stats.conflicts += 1;
    this.finishCapture({
      ok: true,
      action: capture.actionName,
      binding: capture.bindingIndex,
      device: candidate.device,
      code: bindingCode(candidate),
    });
  }

  /* -----------------------------------------------------------------------
   * Public contract
   * -------------------------------------------------------------------- */

  applyPhoneSample(
    slot: number,
    sample: PhoneInputSample,
    receivedAtMs: number,
  ): void {
    if (this.disposed) return;
    this.phone.applyPhoneSample(slot, sample, receivedAtMs);
  }

  setPhoneConnected(slot: number, connected: boolean): void {
    if (this.disposed) return;
    this.phone.setPhoneConnected(slot, connected);
  }

  setTilt(slot: number, tilt: ControllerView["tilt"]): void {
    if (this.disposed) return;
    this.phone.setTilt(slot, tilt);
  }

  setBindings(overlay: BindingOverlay): void {
    if (this.disposed) return;
    this.setBindingsInternal(overlay);
  }

  async saveBindings(): Promise<void> {
    if (this.store === undefined) return;
    try {
      await this.store.save(this.overlay);
    } catch {
      this.stats.storeErrors += 1;
    }
  }

  subscribe(listener: (event: InputDeviceEvent) => void): () => void {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: InputDeviceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        this.stats.listenerErrors += 1;
      }
    }
  }

  reset(): void {
    if (this.disposed) return;
    this.keyboard.reset();
    this.pointer.reset();
    this.gamepads.reset();
    this.phone.reset();
    this.focus.reset();
    this.lastClientX = undefined;
    this.lastClientY = undefined;
    this.lastScanTick = -GAMEPAD_SCAN_INTERVAL_TICKS;
    this.cancelCapture();

    for (let slot = 0; slot < this.slots; slot += 1) {
      const player = this.frame.players[slot];
      if (player !== undefined) {
        player.zeroActions();
        player.connected = false;
        player.device = "none";
        const synthetic = this.syntheticControllers[slot];
        if (synthetic !== undefined) {
          zeroControllerView(synthetic);
          player.controller = synthetic;
        }
      }
      this.clearPrevious(slot);
      this.playerDevices[slot] = "none";
      this.playerDeviceIds[slot] = "";
    }
    this.assignmentDirty = false;
    this.recomputeAssignment();
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.disposed = true;
    this.listeners.clear();
  }
}

function readDeadzoneOption(
  value: number | undefined,
  path: string,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > 0.9) {
    throw new InputFormatError(path, `${path} must be 0..0.9`);
  }
  return value;
}

function validExtent(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Build the M0 input router. */
export function createInputRouter(
  options: EngineInputRouterOptions = {},
): InputRouterImpl {
  return new InputRouterImpl(options);
}

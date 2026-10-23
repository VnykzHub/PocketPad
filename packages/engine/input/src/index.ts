/**
 * `@lanpad/engine-input` public entry.
 *
 * The frozen contract types from spec 10 are re-exported unchanged. The
 * implementation below is DOM-free at module load: the DOM bridge installs
 * listeners only when `InputRouter.attach` is called, and every device can be
 * driven through injected snapshots in Node.
 */

export type * from "./contracts/input.js";

export {
  INPUT_MAP_VERSION,
  INPUT_BINDINGS_VERSION,
  INPUT_TRACE_VERSION,
  INPUT_MAP_MAX_BYTES,
  INPUT_BINDINGS_MAX_BYTES,
  INPUT_MAX_ACTIONS,
  INPUT_MAX_BINDINGS_PER_ACTION,
  INPUT_MAX_OVERLAY_ENTRIES,
  INPUT_EDGE_BITS,
  INPUT_MAX_SLOTS,
  INPUT_MAX_GAMEPADS,
  INPUT_GAMEPAD_BUTTON_COUNT,
  INPUT_GAMEPAD_AXIS_COUNT,
  INPUT_MAX_DEADZONE,
  INPUT_MIN_THRESHOLD,
  INPUT_MAX_THRESHOLD,
  INPUT_MAX_HYSTERESIS,
  INPUT_MAX_ABS_SCALE,
  INPUT_KEY_ID_LIMIT,
  DEFAULT_STICK_DEADZONE,
  DEFAULT_TRIGGER_DEADZONE,
  DEFAULT_ACTION_THRESHOLD,
  DEFAULT_ACTION_HYSTERESIS,
  DEFAULT_POINTER_SENSITIVITY,
  DEFAULT_CAPTURE_TIMEOUT_MS,
  CAPTURE_AXIS_THRESHOLD,
  GAMEPAD_SCAN_INTERVAL_TICKS,
  POINTER_MOTION_FULL_DEFLECTION_PX,
  POINTER_WHEEL_LINE_PX,
  POINTER_WHEEL_PAGE_PX,
  POINTER_WHEEL_FULL_DEFLECTION,
  INPUT_ACTION_NAME_PATTERN,
  DEFAULT_RESERVED_KEYS,
  INPUT_ERROR_CODES,
} from "./version.js";

/* Errors ---------------------------------------------------------------- */

export {
  InputEngineError,
  InputFormatError,
  InputConflictError,
  InputTickError,
  inputError,
} from "./errors.js";

/* Action maps ----------------------------------------------------------- */

export {
  validateBinding,
  validateActions,
  validateActionMapDocument,
  parseActionMapJson,
  validateBindingOverlay,
  validateBindingOverlayDocument,
  parseBindingOverlayJson,
} from "./map/validate.js";
export { defaultDesktopMap } from "./map/defaultMap.js";
export { compileActionMap, COMPILED_GAMEPAD_AXIS_COUNT } from "./map/compile.js";
export type {
  CompiledAction,
  CompiledBinding,
  CompiledMap,
  CompiledPair,
  CompileOptions,
  PhoneAxisCode,
  PointerAxisCode,
} from "./map/compile.js";

/* Resolution ------------------------------------------------------------ */

export {
  radialDeadzoneInto,
  applyRadialDeadzone,
  scalarDeadzone,
} from "./resolve/Deadzone.js";
export type { MutablePair } from "./resolve/Deadzone.js";
export {
  createActionReading,
  resetActionReading,
  createResolvedActionState,
  hysteresisEngage,
  resolveAction,
} from "./resolve/ResolveAction.js";
export type {
  ActionReading,
  ResolvedActionState,
} from "./resolve/ResolveAction.js";

/* Frame and devices ----------------------------------------------------- */

export {
  createActionState,
  zeroActionState,
  createControllerView,
  zeroControllerView,
  createPointerSnapshot,
  createFocusSnapshot,
  PlayerInputImpl,
  InputFrameImpl,
  InputMapView,
  copyActionState,
} from "./InputFrame.js";
export type {
  MutableActionState,
  MutableControllerView,
  MutablePointerSnapshot,
  MutableFocusSnapshot,
} from "./InputFrame.js";
export { KeyboardState } from "./devices/Keyboard.js";
export { PointerState } from "./devices/Pointer.js";
export { GamepadState } from "./devices/Gamepad.js";
export type { PadRecord } from "./devices/Gamepad.js";
export { FocusState } from "./devices/Focus.js";
export { computeAssignment } from "./devices/Assignment.js";
export type {
  AssignmentInput,
  AssignmentResult,
} from "./devices/Assignment.js";
export {
  sameSource,
  findBindingConflict,
  buildKeyboardBinding,
  buildPointerButtonBinding,
  buildPointerWheelBinding,
  buildGamepadButtonBinding,
  buildGamepadAxisBinding,
  bindingCode,
  rebindInActions,
} from "./devices/Rebind.js";
export type {
  BindingConflict,
  BindingChange,
  RebindApplyResult,
} from "./devices/Rebind.js";

/* Phone and router ------------------------------------------------------ */

export { PhoneAdapterImpl } from "./phone/PhoneAdapter.js";
export { InputRouterImpl, createInputRouter } from "./InputRouter.js";
export type {
  EngineInputRouterOptions,
  InputRouterStats,
} from "./InputRouter.js";

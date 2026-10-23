/**
 * Public runtime constants for `@lanpad/engine-input`.
 *
 * The matching declarations live in `src/contracts/input.d.ts`; the values
 * here are the single runtime source of truth and must agree with them.
 * Every value is a rule stated by spec 10; none is a measurement.
 */

/** 10 §4.1, §4.4. `input.map.json` format version. */
export const INPUT_MAP_VERSION = 1 as const;

/** 10 §4.2, §4.4. `input-bindings.json` format version. */
export const INPUT_BINDINGS_VERSION = 1 as const;

/** 10 §4.3, §4.4. `input-trace-v1` format version. */
export const INPUT_TRACE_VERSION = 1 as const;

/** 10 §4.1. UTF-8 bytes, hard cap. */
export const INPUT_MAP_MAX_BYTES = 32768 as const;

/** 10 §4.2. UTF-8 bytes, hard cap. */
export const INPUT_BINDINGS_MAX_BYTES = 16384 as const;

/** 10 §4.1. Actions per map. */
export const INPUT_MAX_ACTIONS = 64 as const;

/** 10 §3.2, §4.1. Bindings per action; the 16-bit edge mask reserves bit 0. */
export const INPUT_MAX_BINDINGS_PER_ACTION = 15 as const;

/** 10 §4.2. Overlay keys per file. */
export const INPUT_MAX_OVERLAY_ENTRIES = 64 as const;

/** 10 §3.2. Bits in `edges` / `releaseEdges`. */
export const INPUT_EDGE_BITS = 16 as const;

/** 10 §3.5, §5.10. Slots 0..7; also the default `slots`. */
export const INPUT_MAX_SLOTS = 8 as const;

/** 10 §3.1, §5.6. Standard pad indices 0..3. */
export const INPUT_MAX_GAMEPADS = 4 as const;

/** 10 §5.6. Standard buttons 0..16. */
export const INPUT_GAMEPAD_BUTTON_COUNT = 17 as const;

/** 10 §5.6. Standard axes 0..3. */
export const INPUT_GAMEPAD_AXIS_COUNT = 4 as const;

/** 10 §4.1. `deadzone` upper bound. */
export const INPUT_MAX_DEADZONE = 0.9 as const;

/** 10 §4.1. `threshold` bounds. */
export const INPUT_MIN_THRESHOLD = 0.01 as const;
export const INPUT_MAX_THRESHOLD = 1 as const;

/** 10 §4.1. `hysteresis` upper bound. */
export const INPUT_MAX_HYSTERESIS = 0.5 as const;

/** 10 §3.1. `scale` is finite in -4..4. */
export const INPUT_MAX_ABS_SCALE = 4 as const;

/** 10 §5.4. Compiled key-id table cap. */
export const INPUT_KEY_ID_LIMIT = 256 as const;

/** 10 §5.8.2. Default stick-pair deadzone. */
export const DEFAULT_STICK_DEADZONE = 0.15 as const;

/** 10 §5.8.2. Default trigger deadzone. */
export const DEFAULT_TRIGGER_DEADZONE = 0.05 as const;

/** 10 §3.2, §5.8.4. Default press threshold. */
export const DEFAULT_ACTION_THRESHOLD = 0.5 as const;

/** 10 §3.2, §5.8.4. Default release hysteresis. */
export const DEFAULT_ACTION_HYSTERESIS = 0.1 as const;

/** 10 §3.5, §5.5. Default motion scaling. */
export const DEFAULT_POINTER_SENSITIVITY = 1 as const;

/** 10 §5.11. Capture timeout. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 10000 as const;

/** 10 §5.11. Gamepad axis capture magnitude. */
export const CAPTURE_AXIS_THRESHOLD = 0.6 as const;

/** 10 §5.6. Idle-pad scan cadence (1 Hz at 60 Hz ticks). */
export const GAMEPAD_SCAN_INTERVAL_TICKS = 60 as const;

/** 10 §5.5. Motion pixels for full deflection. */
export const POINTER_MOTION_FULL_DEFLECTION_PX = 100 as const;

/** 10 §5.5. `deltaMode` line/page normalization. */
export const POINTER_WHEEL_LINE_PX = 16 as const;
export const POINTER_WHEEL_PAGE_PX = 100 as const;

/** 10 §5.5. Wheel delta for full deflection. */
export const POINTER_WHEEL_FULL_DEFLECTION = 100 as const;

/** 10 §3.2, §4.1. Action-name pattern. */
export const INPUT_ACTION_NAME_PATTERN = "^[a-z][a-z0-9_.-]{0,47}$";

/** 10 §5.11. Default reserved codes. `Escape` also cancels a capture. */
export const DEFAULT_RESERVED_KEYS = [
  "Escape",
  "F5",
  "F11",
  "F12",
  "Tab",
] as const;

/** 10 §3.9. Additive input codes layered over core `EngineErrorCode`. */
export const INPUT_ERROR_CODES = [
  "E_INPUT_FORMAT",
  "E_INPUT_CONFLICT",
  "E_INPUT_RESERVED",
  "E_INPUT_CAPTURE",
  "E_INPUT_TICK",
  "E_INPUT_DEVICE",
] as const;

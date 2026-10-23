/**
 * Action map and binding overlay validation (10 §4.1, §4.2, §3.9).
 *
 * Every failure throws `InputFormatError` with `code = "E_INPUT_FORMAT"` and
 * the JSON path of the first violation. Unknown fields are ignored and are
 * not copied into the normalized result.
 */

import type {
  ActionMapDocument,
  ActionOutput,
  BindingOverlay,
  BindingOverlayDocument,
  Component,
  GamepadSource,
  InputAction,
  InputActionKind,
  InputBinding,
  KeyboardSource,
  PhoneAxisName,
  PhoneAxisSource,
  PhoneButtonSource,
  PointerAxisName,
  PointerButton,
  PointerSource,
} from "../contracts/input.js";
import {
  INPUT_ACTION_NAME_PATTERN,
  INPUT_BINDINGS_MAX_BYTES,
  INPUT_BINDINGS_VERSION,
  INPUT_GAMEPAD_AXIS_COUNT,
  INPUT_GAMEPAD_BUTTON_COUNT,
  INPUT_MAP_MAX_BYTES,
  INPUT_MAP_VERSION,
  INPUT_MAX_ABS_SCALE,
  INPUT_MAX_ACTIONS,
  INPUT_MAX_BINDINGS_PER_ACTION,
  INPUT_MAX_DEADZONE,
  INPUT_MAX_HYSTERESIS,
  INPUT_MAX_OVERLAY_ENTRIES,
  INPUT_MAX_SLOTS,
  INPUT_MAX_THRESHOLD,
  INPUT_MIN_THRESHOLD,
} from "../version.js";
import { InputFormatError } from "../errors.js";

const ACTION_NAME = new RegExp(INPUT_ACTION_NAME_PATTERN);

const PHONE_AXES: readonly string[] = ["lx", "ly", "rx", "ry", "lt", "rt"];
const POINTER_AXES: readonly string[] = ["x", "y", "dx", "dy", "wheel"];
const STICK_AXES: readonly string[] = ["lx", "ly", "rx", "ry"];
const ACTION_KINDS: readonly string[] = ["button", "axis", "vector2"];
const OUTPUT_KEYS = ["button", "stick", "trigger", "axis"] as const;

const utf8 = new TextEncoder();

function fail(path: string, message: string): never {
  throw new InputFormatError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function assertByteSize(text: string, maxBytes: number, path: string): void {
  if (utf8.encode(text).byteLength > maxBytes) {
    fail(path, `document exceeds ${maxBytes} UTF-8 bytes`);
  }
}

function readComponent(
  value: Record<string, unknown>,
  path: string,
): Component | undefined {
  const component = value.component;
  if (component === undefined) return undefined;
  if (component !== "x" && component !== "y") {
    fail(`${path}.component`, 'component must be "x" or "y"');
  }
  return component;
}

function readScale(value: Record<string, unknown>, path: string): number | undefined {
  const scale = value.scale;
  if (scale === undefined) return undefined;
  if (!isFiniteNumber(scale) || Math.abs(scale) > INPUT_MAX_ABS_SCALE) {
    fail(`${path}.scale`, `scale must be finite in -${INPUT_MAX_ABS_SCALE}..${INPUT_MAX_ABS_SCALE}`);
  }
  return scale;
}

function readSlotSelector(
  value: unknown,
  path: string,
): number | "self" {
  if (value === "self") return "self";
  if (!isIntegerInRange(value, 0, INPUT_MAX_SLOTS - 1)) {
    fail(path, `slot must be "self" or 0..${INPUT_MAX_SLOTS - 1}`);
  }
  return value;
}

function readPadSelector(value: unknown, path: string): number | "self" {
  if (value === "self") return "self";
  if (!isIntegerInRange(value, 0, INPUT_GAMEPAD_AXIS_COUNT - 1)) {
    fail(path, 'pad must be "self" or 0..3');
  }
  return value;
}

/* -------------------------------------------------------------------------
 * Bindings
 * ---------------------------------------------------------------------- */

function validatePhoneBinding(
  value: Record<string, unknown>,
  path: string,
  actionKind: InputActionKind | undefined,
): InputBinding {
  const channel = value.channel;
  if (channel !== "button" && channel !== "axis") {
    fail(`${path}.channel`, 'phone channel must be "button" or "axis"');
  }
  const slot = readSlotSelector(value.slot, `${path}.slot`);

  if (channel === "button") {
    const bit = value.bit;
    if (!isIntegerInRange(bit, 0, 15)) {
      fail(`${path}.bit`, "phone button bit must be an integer 0..15");
    }
    if (actionKind === "vector2") {
      fail(`${path}.component`, "phone button needs an explicit component on a vector2 action");
    }
    const binding: PhoneButtonSource = {
      device: "phone",
      slot,
      channel: "button",
      bit,
    };
    return binding;
  }

  const axis = value.axis;
  if (typeof axis !== "string" || !PHONE_AXES.includes(axis)) {
    fail(`${path}.axis`, "phone axis must be lx, ly, rx, ry, lt or rt");
  }
  const component = readComponent(value, path);
  const scale = readScale(value, path);
  if (
    actionKind === "vector2" &&
    component === undefined &&
    (axis === "lt" || axis === "rt")
  ) {
    fail(`${path}.component`, "phone trigger needs an explicit component on a vector2 action");
  }
  const binding: PhoneAxisSource = {
    device: "phone",
    slot,
    channel: "axis",
    axis: axis as PhoneAxisName,
    ...(component !== undefined ? { component } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
  return binding;
}

function validateKeyboardBinding(
  value: Record<string, unknown>,
  path: string,
  actionKind: InputActionKind | undefined,
): InputBinding {
  const code = value.code;
  if (typeof code !== "string" || code.length === 0) {
    fail(`${path}.code`, "keyboard code must be a non-empty string");
  }
  const component = readComponent(value, path);
  const scale = readScale(value, path);
  if (actionKind === "vector2" && component === undefined) {
    fail(`${path}.component`, "keyboard source needs an explicit component on a vector2 action");
  }
  const binding: KeyboardSource = {
    device: "keyboard",
    code,
    ...(component !== undefined ? { component } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
  return binding;
}

function validatePointerBinding(
  value: Record<string, unknown>,
  path: string,
  actionKind: InputActionKind | undefined,
): InputBinding {
  const hasAxis = value.axis !== undefined;
  const hasButton = value.button !== undefined;
  if (hasAxis === hasButton) {
    fail(path, "pointer binding must set exactly one of axis/button");
  }
  const component = readComponent(value, path);
  const scale = readScale(value, path);

  if (hasAxis) {
    const axis = value.axis;
    if (typeof axis !== "string" || !POINTER_AXES.includes(axis)) {
      fail(`${path}.axis`, "pointer axis must be x, y, dx, dy or wheel");
    }
    if (actionKind === "vector2" && component === undefined) {
      fail(`${path}.component`, "pointer source needs an explicit component on a vector2 action");
    }
    const binding: PointerSource = {
      device: "pointer",
      axis: axis as PointerAxisName,
      ...(component !== undefined ? { component } : {}),
      ...(scale !== undefined ? { scale } : {}),
    };
    return binding;
  }

  const button = value.button;
  if (!isIntegerInRange(button, 0, 2)) {
    fail(`${path}.button`, "pointer button must be 0, 1 or 2");
  }
  if (actionKind === "vector2" && component === undefined) {
    fail(`${path}.component`, "pointer source needs an explicit component on a vector2 action");
  }
  const binding: PointerSource = {
    device: "pointer",
    button: button as PointerButton,
    ...(component !== undefined ? { component } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
  return binding;
}

function validateGamepadBinding(
  value: Record<string, unknown>,
  path: string,
  actionKind: InputActionKind | undefined,
): InputBinding {
  const pad = readPadSelector(value.pad, `${path}.pad`);
  const hasAxis = value.axis !== undefined;
  const hasButton = value.button !== undefined;
  if (hasAxis === hasButton) {
    fail(path, "gamepad binding must set exactly one of axis/button");
  }
  const component = readComponent(value, path);
  const scale = readScale(value, path);

  if (hasButton) {
    const button = value.button;
    if (!isIntegerInRange(button, 0, INPUT_GAMEPAD_BUTTON_COUNT - 1)) {
      fail(`${path}.button`, `gamepad button must be an integer 0..${INPUT_GAMEPAD_BUTTON_COUNT - 1}`);
    }
    if (actionKind === "vector2" && component === undefined) {
      fail(`${path}.component`, "gamepad source needs an explicit component on a vector2 action");
    }
    const binding: GamepadSource = {
      device: "gamepad",
      pad,
      button,
      ...(component !== undefined ? { component } : {}),
      ...(scale !== undefined ? { scale } : {}),
    };
    return binding;
  }

  const axis = value.axis;
  if (!isIntegerInRange(axis, 0, INPUT_GAMEPAD_AXIS_COUNT - 1)) {
    fail(`${path}.axis`, `gamepad axis must be an integer 0..${INPUT_GAMEPAD_AXIS_COUNT - 1}`);
  }
  if (actionKind === "vector2" && component === undefined) {
    fail(`${path}.component`, "gamepad source needs an explicit component on a vector2 action");
  }
  const binding: GamepadSource = {
    device: "gamepad",
    pad,
    axis,
    ...(component !== undefined ? { component } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
  return binding;
}

/**
 * Validates one binding. `actionKind` is `undefined` for overlay documents,
 * where the target action (and therefore its kind) is not known yet; the
 * vector2 component rule is then deferred to `validateBindingOverlay` at
 * apply time.
 */
export function validateBinding(
  value: unknown,
  path: string,
  actionKind?: InputActionKind,
): InputBinding {
  if (!isRecord(value)) fail(path, "binding must be an object");
  const device = value.device;
  if (device === "phone") return validatePhoneBinding(value, path, actionKind);
  if (device === "keyboard") return validateKeyboardBinding(value, path, actionKind);
  if (device === "pointer") return validatePointerBinding(value, path, actionKind);
  if (device === "gamepad") return validateGamepadBinding(value, path, actionKind);
  fail(`${path}.device`, "unknown input device");
}

/* -------------------------------------------------------------------------
 * Actions
 * ---------------------------------------------------------------------- */

function validateOutput(
  value: unknown,
  kind: InputActionKind,
  path: string,
): ActionOutput {
  if (!isRecord(value)) fail(path, "output must be an object");

  const present: string[] = [];
  for (const key of OUTPUT_KEYS) {
    if (value[key] !== undefined) present.push(key);
  }
  if (present.length !== 1) {
    fail(path, "output must set exactly one member");
  }
  const key = present[0];

  if (key === "button") {
    if (kind !== "button") {
      fail(path, "output.button is valid only on a button action");
    }
    const button = value.button;
    if (!isIntegerInRange(button, 0, 15)) {
      fail(path, "output.button must be an integer 0..15");
    }
    return { button };
  }

  if (key === "stick") {
    if (kind !== "vector2") {
      fail(path, "output.stick is valid only on a vector2 action");
    }
    const stick = value.stick;
    if (stick !== "left" && stick !== "right") {
      fail(path, 'output.stick must be "left" or "right"');
    }
    return { stick };
  }

  if (key === "trigger") {
    if (kind !== "axis" && kind !== "button") {
      fail(path, "output.trigger is valid only on an axis or button action");
    }
    const trigger = value.trigger;
    if (trigger !== "lt" && trigger !== "rt") {
      fail(path, 'output.trigger must be "lt" or "rt"');
    }
    return { trigger };
  }

  if (key === "axis") {
    if (kind !== "axis") {
      fail(path, "output.axis is valid only on an axis action");
    }
    const axis = value.axis;
    if (typeof axis !== "string" || !STICK_AXES.includes(axis)) {
      fail(path, "output.axis must be lx, ly, rx or ry");
    }
    return { axis: axis as "lx" | "ly" | "rx" | "ry" };
  }

  fail(path, "output must set exactly one member");
}

interface MutableAction {
  name: string;
  kind: InputActionKind;
  bindings: InputBinding[];
  deadzone?: number;
  threshold?: number;
  hysteresis?: number;
  yUp?: boolean;
  output?: ActionOutput;
}

function validateAction(
  value: unknown,
  path: string,
  seenNames: Set<string>,
): InputAction {
  if (!isRecord(value)) fail(path, "action must be an object");

  const name = value.name;
  if (typeof name !== "string" || !ACTION_NAME.test(name)) {
    fail(`${path}.name`, "action name must match " + INPUT_ACTION_NAME_PATTERN);
  }
  if (seenNames.has(name)) fail(`${path}.name`, "duplicate action name");
  seenNames.add(name);

  const kind = value.kind;
  if (typeof kind !== "string" || !ACTION_KINDS.includes(kind)) {
    fail(`${path}.kind`, "kind must be button, axis or vector2");
  }
  const actionKind = kind as InputActionKind;

  const rawBindings = value.bindings;
  if (!Array.isArray(rawBindings)) fail(`${path}.bindings`, "bindings must be an array");
  if (
    rawBindings.length < 1 ||
    rawBindings.length > INPUT_MAX_BINDINGS_PER_ACTION
  ) {
    fail(
      `${path}.bindings`,
      `bindings must contain 1..${INPUT_MAX_BINDINGS_PER_ACTION} entries`,
    );
  }
  const bindings: InputBinding[] = [];
  for (let index = 0; index < rawBindings.length; index += 1) {
    bindings.push(
      validateBinding(rawBindings[index], `${path}.bindings[${index}]`, actionKind),
    );
  }

  const action: MutableAction = {
    name,
    kind: actionKind,
    bindings,
  };

  const deadzone = value.deadzone;
  if (deadzone !== undefined) {
    if (
      !isFiniteNumber(deadzone) ||
      deadzone < 0 ||
      deadzone > INPUT_MAX_DEADZONE
    ) {
      fail(`${path}.deadzone`, `deadzone must be 0..${INPUT_MAX_DEADZONE}`);
    }
    action.deadzone = deadzone;
  }

  const threshold = value.threshold;
  if (threshold !== undefined) {
    if (
      !isFiniteNumber(threshold) ||
      threshold < INPUT_MIN_THRESHOLD ||
      threshold > INPUT_MAX_THRESHOLD
    ) {
      fail(
        `${path}.threshold`,
        `threshold must be ${INPUT_MIN_THRESHOLD}..${INPUT_MAX_THRESHOLD}`,
      );
    }
    action.threshold = threshold;
  }

  const hysteresis = value.hysteresis;
  if (hysteresis !== undefined) {
    if (
      !isFiniteNumber(hysteresis) ||
      hysteresis < 0 ||
      hysteresis > INPUT_MAX_HYSTERESIS
    ) {
      fail(`${path}.hysteresis`, `hysteresis must be 0..${INPUT_MAX_HYSTERESIS}`);
    }
    action.hysteresis = hysteresis;
  }

  const yUp = value.yUp;
  if (yUp !== undefined) {
    if (actionKind !== "vector2") {
      fail(`${path}.yUp`, "yUp is valid only on a vector2 action");
    }
    if (typeof yUp !== "boolean") fail(`${path}.yUp`, "yUp must be a boolean");
    action.yUp = yUp;
  }

  const output = value.output;
  if (output !== undefined) {
    action.output = validateOutput(output, actionKind, `${path}.output`);
  }

  return action;
}

/** Validates a raw action array (0..64 entries) and normalizes every field. */
export function validateActions(value: unknown): InputAction[] {
  if (!Array.isArray(value)) fail("actions", "actions must be an array");
  if (value.length > INPUT_MAX_ACTIONS) {
    fail("actions", `actions must contain at most ${INPUT_MAX_ACTIONS} entries`);
  }
  const seenNames = new Set<string>();
  const actions: InputAction[] = [];
  for (let index = 0; index < value.length; index += 1) {
    actions.push(validateAction(value[index], `actions[${index}]`, seenNames));
  }
  return actions;
}

/** Validates a parsed `input.map.json` value. */
export function validateActionMapDocument(value: unknown): ActionMapDocument {
  if (!isRecord(value)) fail("$", "action map must be an object");
  if (value.formatVersion !== INPUT_MAP_VERSION) {
    fail("formatVersion", `formatVersion must be ${INPUT_MAP_VERSION}`);
  }
  return {
    formatVersion: INPUT_MAP_VERSION,
    actions: validateActions(value.actions),
  };
}

/** Parses and validates `input.map.json` text, enforcing the 32 KB cap first. */
export function parseActionMapJson(text: string): ActionMapDocument {
  assertByteSize(text, INPUT_MAP_MAX_BYTES, "$");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    fail("$", "invalid JSON");
  }
  return validateActionMapDocument(value);
}

/* -------------------------------------------------------------------------
 * Binding overlay
 * ---------------------------------------------------------------------- */

/**
 * Validates and normalizes an overlay body. When `actionKinds` is supplied,
 * kind-specific rules (the vector2 component requirement) are enforced for
 * known actions; unknown keys are kept and ignored by the router.
 */
export function validateBindingOverlay(
  value: unknown,
  actionKinds?: ReadonlyMap<string, InputActionKind>,
): BindingOverlay {
  if (!isRecord(value)) fail("bindings", "bindings must be an object");
  const keys = Object.keys(value);
  if (keys.length > INPUT_MAX_OVERLAY_ENTRIES) {
    fail("bindings", `overlay must contain at most ${INPUT_MAX_OVERLAY_ENTRIES} entries`);
  }

  const overlay: Record<string, readonly InputBinding[] | null> = {};
  for (const key of keys) {
    const raw = value[key];
    const path = `bindings.${key}`;
    if (raw === null) {
      overlay[key] = null;
      continue;
    }
    if (!Array.isArray(raw)) fail(path, "overlay value must be an array or null");
    if (
      raw.length < 1 ||
      raw.length > INPUT_MAX_BINDINGS_PER_ACTION
    ) {
      fail(
        path,
        `overlay binding list must contain 1..${INPUT_MAX_BINDINGS_PER_ACTION} entries`,
      );
    }
    const kind = actionKinds?.get(key);
    const list: InputBinding[] = [];
    for (let index = 0; index < raw.length; index += 1) {
      list.push(validateBinding(raw[index], `${path}[${index}]`, kind));
    }
    overlay[key] = list;
  }
  return overlay;
}

/** Validates a parsed `input-bindings.json` value. */
export function validateBindingOverlayDocument(
  value: unknown,
): BindingOverlayDocument {
  if (!isRecord(value)) fail("$", "binding overlay must be an object");
  if (value.formatVersion !== INPUT_BINDINGS_VERSION) {
    fail("formatVersion", `formatVersion must be ${INPUT_BINDINGS_VERSION}`);
  }
  const updatedAt = value.updatedAt;
  if (updatedAt !== undefined && typeof updatedAt !== "string") {
    fail("updatedAt", "updatedAt must be an ISO-8601 string");
  }
  return {
    formatVersion: INPUT_BINDINGS_VERSION,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    bindings: validateBindingOverlay(value.bindings),
  };
}

/** Parses and validates `input-bindings.json` text (16 KB cap). */
export function parseBindingOverlayJson(text: string): BindingOverlayDocument {
  assertByteSize(text, INPUT_BINDINGS_MAX_BYTES, "$");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    fail("$", "invalid JSON");
  }
  return validateBindingOverlayDocument(value);
}

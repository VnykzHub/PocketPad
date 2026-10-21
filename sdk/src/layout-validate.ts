/**
 * @lanpad/sdk layout validator (D2-LAYOUT-01, D5-SDK-01; FR-8.1, FR-8.4,
 * FR-7.7, FR-8.10, SR-13, AR-5).
 *
 * The same pure function runs on the host and on the controller: a layout is
 * only rendered after it passes here, so neither side trusts the other's
 * parsing. There is no DOM, network or dependency use.
 *
 * D5 adds the cross-control rules the controller depends on for hot-swap and
 * private panels: a gyro control needs a non-gyro fallback (FR-8.10 groundwork),
 * and every event name must match the wire-safe pattern (SR-13) in addition to
 * the 64-character limit. Event names may be shared across controls; use
 * `layoutEventNames` for the layout-wide list.
 *
 * Error strings are stable and field-addressed (`controls[2].bit: ...`) so the
 * host and controller can surface the same message and tests can lock them.
 * The validator reports every problem in one pass, except for oversized or
 * non-serializable input, which fails fast to bound the work done on hostile
 * documents.
 */

import { tryParseLength, type LayoutDocument } from "./layout.js";
import { isValidEventName } from "./ugc.js";

const MAX_LAYOUT_BYTES = 16_384;
const MIN_CONTROLS = 1;
const MAX_CONTROLS = 24;
const MIN_CONTROL_ID_CHARS = 1;
const MAX_CONTROL_ID_CHARS = 32;
const MIN_LAYOUT_ID_CHARS = 1;
const MAX_LAYOUT_ID_CHARS = 64;
const MIN_EVENT_CHARS = 1;
const MAX_EVENT_CHARS = 64;
const MAX_HAPTIC_STEPS = 8;
const MAX_HAPTIC_MS = 65_535;
const MIN_OPTIONS = 1;
const MAX_OPTIONS = 12;
const MIN_TEXT_LEN = 1;
const MAX_TEXT_LEN = 200;

const CONTROL_TYPES = new Set([
  "button",
  "dpad",
  "stick",
  "trigger",
  "touchpad",
  "slider",
  "gyro",
  "choice",
  "panel",
  "text",
  "canvas",
]);

/**
 * Control types that can act as the non-gyro fallback required by FR-8.10.
 * `panel` is display-only, so a panel does not make a gyro layout playable.
 */
const FALLBACK_CONTROL_TYPES = new Set([
  "button",
  "dpad",
  "stick",
  "trigger",
  "touchpad",
  "slider",
  "choice",
  "text",
  "canvas",
]);

/** Text of the shared event-name rule (D5-SEC-01; SR-13). */
const EVENT_NAME_RULE = "^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$";

const ORIENTATIONS = ["portrait", "landscape", "any"] as const;
const BUTTON_SHAPES = ["circle", "rounded", "square"] as const;
const STICK_AXES = ["left", "right"] as const;
const STICK_MODES = ["floating", "fixed"] as const;
const TRIGGER_CHANNELS = ["lt", "rt"] as const;
const TRIGGER_ORIENTATIONS = ["vertical", "horizontal"] as const;
const SLIDER_DIRECTIONS = ["horizontal", "vertical"] as const;
const SENSOR_GYRO_MODES = ["steer", "aim", "tilt"] as const;

const BACKGROUND_PATTERN = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const DPAD_DIRECTIONS = ["up", "down", "left", "right"] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Matches JSON Schema `minLength`/`maxLength`, which count code points. */
function charLength(text: string): number {
  return Array.from(text).length;
}

/** UTF-8 byte count without depending on `TextEncoder` or `Buffer`. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

/**
 * Measures the document as it would travel on the wire. `null` means the value
 * cannot be serialized (cyclic reference, BigInt, function at the top level).
 */
function serializedByteSize(value: unknown): number | null {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  return serialized === undefined ? null : utf8ByteLength(serialized);
}

function fieldLabel(path: string, field: string): string {
  return path.length === 0 ? field : `${path}.${field}`;
}

function validateStringField(
  record: UnknownRecord,
  field: string,
  path: string,
  errors: string[],
  limits?: { min: number; max: number },
): string | undefined {
  const label = fieldLabel(path, field);
  const value = record[field];

  if (value === undefined) {
    errors.push(`${label}: required`);
    return undefined;
  }
  if (typeof value !== "string") {
    errors.push(`${label}: must be a string`);
    return undefined;
  }
  if (limits !== undefined) {
    const length = charLength(value);
    if (length < limits.min || length > limits.max) {
      errors.push(`${label}: must be ${limits.min}..${limits.max} characters (got ${length})`);
      return undefined;
    }
  }
  return value;
}

/**
 * Validates an event name: 1..64 characters and the wire-safe pattern shared
 * with the event queue (SR-13). Length errors are reported first so existing
 * field-addressed messages stay stable.
 */
function validateEventField(
  record: UnknownRecord,
  path: string,
  errors: string[],
): string | undefined {
  const label = fieldLabel(path, "event");
  const event = validateStringField(record, "event", path, errors, {
    min: MIN_EVENT_CHARS,
    max: MAX_EVENT_CHARS,
  });

  if (event === undefined) {
    return undefined;
  }
  if (!isValidEventName(event)) {
    errors.push(`${label}: must match ${EVENT_NAME_RULE}`);
    return undefined;
  }
  return event;
}

function validateEnumField<T extends string>(
  record: UnknownRecord,
  field: string,
  allowed: readonly T[],
  path: string,
  errors: string[],
  required = true,
): T | undefined {
  const label = fieldLabel(path, field);
  const value = record[field];

  if (value === undefined) {
    if (required) {
      errors.push(`${label}: required`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    errors.push(`${label}: must be a string`);
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    errors.push(
      `${label}: must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`,
    );
    return undefined;
  }
  return value as T;
}

/**
 * Validates a length field and its frozen unit ranges: percent 0..100, pixels
 * 0..4096. Percentages are resolved by the renderer against the documented
 * reference dimension (see layout.ts and layout.schema.json).
 */
function validateLengthField(
  record: UnknownRecord,
  field: string,
  path: string,
  errors: string[],
): void {
  const label = fieldLabel(path, field);
  const value = record[field];

  if (value === undefined) {
    errors.push(`${label}: required`);
    return;
  }
  const parsed = tryParseLength(value);
  if (parsed === null) {
    errors.push(`${label}: must be a percentage ("10%") or pixels ("12px")`);
    return;
  }
  if (parsed.kind === "percent" && parsed.value > 100) {
    errors.push(`${label}: percent must be 0..100 (got ${parsed.value})`);
    return;
  }
  if (parsed.kind === "px" && parsed.value > 4096) {
    errors.push(`${label}: pixels must be 0..4096 (got ${parsed.value})`);
  }
}

/** Validates a protocol button bit and returns it when usable. */
function validateBitValue(
  value: unknown,
  label: string,
  errors: string[],
): number | undefined {
  if (value === undefined) {
    errors.push(`${label}: required`);
    return undefined;
  }
  if (!isIntegerInRange(value, 0, 15)) {
    errors.push(`${label}: must be an integer 0..15`);
    return undefined;
  }
  return value;
}

interface BitAssignment {
  bit: number;
  /** Field relative to the control path, e.g. `bit` or `bits.up`. */
  field: string;
}

/** Registers bits and reports a bit already owned by another control. */
function registerBits(
  controlId: string,
  path: string,
  assignments: BitAssignment[],
  errors: string[],
  bitOwners: Map<number, string>,
): void {
  const localBits = new Set<number>();
  for (const assignment of assignments) {
    // A duplicated bit inside one dpad is reported by the dpad check; do not
    // report it again as a cross-control conflict.
    if (localBits.has(assignment.bit)) {
      continue;
    }
    localBits.add(assignment.bit);

    const owner = bitOwners.get(assignment.bit);
    if (owner === undefined) {
      bitOwners.set(assignment.bit, controlId);
    } else if (owner !== controlId) {
      errors.push(
        `${path}.${assignment.field}: bit ${assignment.bit} is already assigned to control ${JSON.stringify(owner)}`,
      );
    }
  }
}

/** Registers input channels and reports a channel already bound elsewhere. */
function registerChannels(
  controlId: string,
  label: string,
  channels: readonly string[],
  errors: string[],
  channelOwners: Map<string, string>,
): void {
  const conflicts = channels.filter((channel) => {
    const owner = channelOwners.get(channel);
    return owner !== undefined && owner !== controlId;
  });

  if (conflicts.length > 0) {
    const owner = channelOwners.get(conflicts[0] ?? "") ?? "";
    const quoted = conflicts.map((channel) => `"${channel}"`).join("/");
    errors.push(`${label}: channel ${quoted} is already bound by control ${JSON.stringify(owner)}`);
  }

  for (const channel of channels) {
    if (!channelOwners.has(channel)) {
      channelOwners.set(channel, controlId);
    }
  }
}

function validateBaseControl(
  control: UnknownRecord,
  path: string,
  errors: string[],
  seenIds: Set<string>,
): void {
  const id = validateStringField(control, "id", path, errors, {
    min: MIN_CONTROL_ID_CHARS,
    max: MAX_CONTROL_ID_CHARS,
  });
  if (id !== undefined) {
    if (seenIds.has(id)) {
      errors.push(`${path}.id: duplicate control id ${JSON.stringify(id)}`);
    } else {
      seenIds.add(id);
    }
  }

  validateLengthField(control, "x", path, errors);
  validateLengthField(control, "y", path, errors);

  const z = control.z;
  if (z !== undefined && !isFiniteNumber(z)) {
    errors.push(`${path}.z: must be a finite number`);
  }
}

function validateHaptic(control: UnknownRecord, path: string, errors: string[]): void {
  const haptic = control.haptic;
  if (haptic === undefined) {
    return;
  }
  if (!Array.isArray(haptic)) {
    errors.push(`${path}.haptic: must be an array`);
    return;
  }
  if (haptic.length > MAX_HAPTIC_STEPS) {
    errors.push(
      `${path}.haptic: must contain at most ${MAX_HAPTIC_STEPS} durations (got ${haptic.length})`,
    );
  }
  for (let index = 0; index < haptic.length; index += 1) {
    if (!isIntegerInRange(haptic[index], 0, MAX_HAPTIC_MS)) {
      errors.push(`${path}.haptic[${index}]: must be an integer 0..${MAX_HAPTIC_MS}`);
    }
  }
}

function validateDpad(
  control: UnknownRecord,
  controlId: string,
  path: string,
  errors: string[],
  bitOwners: Map<number, string>,
): void {
  validateLengthField(control, "size", path, errors);

  const bits = control.bits;
  if (bits === undefined) {
    errors.push(`${path}.bits: required`);
    return;
  }
  if (!isRecord(bits)) {
    errors.push(`${path}.bits: must be an object`);
    return;
  }

  const assignments: BitAssignment[] = [];
  for (const direction of DPAD_DIRECTIONS) {
    const bit = validateBitValue(bits[direction], `${path}.bits.${direction}`, errors);
    if (bit !== undefined) {
      assignments.push({ bit, field: `bits.${direction}` });
    }
  }

  if (assignments.length === DPAD_DIRECTIONS.length) {
    const uniqueBits = new Set(assignments.map((assignment) => assignment.bit));
    if (uniqueBits.size !== DPAD_DIRECTIONS.length) {
      errors.push(`${path}.bits: up/down/left/right bits must be distinct`);
    }
  }

  registerBits(controlId, path, assignments, errors, bitOwners);
}

function validateChoice(
  control: UnknownRecord,
  path: string,
  errors: string[],
): void {
  validateLengthField(control, "w", path, errors);
  validateLengthField(control, "h", path, errors);
  validateEventField(control, path, errors);

  const options = control.options;
  if (options === undefined) {
    errors.push(`${path}.options: required`);
    return;
  }
  if (!Array.isArray(options)) {
    errors.push(`${path}.options: must be an array`);
    return;
  }

  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    errors.push(
      `${path}.options: must contain ${MIN_OPTIONS}..${MAX_OPTIONS} options (got ${options.length})`,
    );
  }

  const seenValues = new Set<string>();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    const optionPath = `${path}.options[${index}]`;
    if (!isRecord(option)) {
      errors.push(`${optionPath}: must be an object`);
      continue;
    }

    const value = option.value;
    if (value === undefined) {
      errors.push(`${optionPath}.value: required`);
    } else if (typeof value !== "string") {
      errors.push(`${optionPath}.value: must be a string`);
    } else if (seenValues.has(value)) {
      errors.push(`${optionPath}.value: duplicate option value ${JSON.stringify(value)}`);
    } else {
      seenValues.add(value);
    }

    const label = option.label;
    if (label === undefined) {
      errors.push(`${optionPath}.label: required`);
    } else if (typeof label !== "string") {
      errors.push(`${optionPath}.label: must be a string`);
    }
  }
}

function validateControl(
  control: unknown,
  path: string,
  errors: string[],
  seenIds: Set<string>,
  bitOwners: Map<number, string>,
  channelOwners: Map<string, string>,
): void {
  if (!isRecord(control)) {
    errors.push(`${path}: must be an object`);
    return;
  }

  validateBaseControl(control, path, errors, seenIds);

  const type = control.type;
  if (type === undefined) {
    errors.push(`${path}.type: required`);
    return;
  }
  if (typeof type !== "string") {
    errors.push(`${path}.type: must be a string`);
    return;
  }
  if (!CONTROL_TYPES.has(type)) {
    errors.push(`${path}.type: unknown control type ${JSON.stringify(type)}`);
    return;
  }

  const controlId = typeof control.id === "string" ? control.id : path;

  switch (type) {
    case "button": {
      validateStringField(control, "label", path, errors);
      validateEnumField(control, "shape", BUTTON_SHAPES, path, errors);
      validateLengthField(control, "r", path, errors);
      const bit = validateBitValue(control.bit, `${path}.bit`, errors);
      if (bit !== undefined) {
        registerBits(controlId, path, [{ bit, field: "bit" }], errors, bitOwners);
      }
      validateHaptic(control, path, errors);
      break;
    }

    case "dpad": {
      validateDpad(control, controlId, path, errors, bitOwners);
      break;
    }

    case "stick": {
      validateLengthField(control, "size", path, errors);
      const axis = validateEnumField(control, "axis", STICK_AXES, path, errors);
      validateEnumField(control, "mode", STICK_MODES, path, errors);
      const deadzone = control.deadzone;
      if (
        deadzone !== undefined &&
        (!isFiniteNumber(deadzone) || deadzone < 0 || deadzone > 0.5)
      ) {
        errors.push(`${path}.deadzone: must be a number 0..0.5`);
      }
      if (axis !== undefined) {
        const channels = axis === "left" ? ["lx", "ly"] : ["rx", "ry"];
        registerChannels(controlId, `${path}.axis`, channels, errors, channelOwners);
      }
      break;
    }

    case "trigger": {
      validateLengthField(control, "size", path, errors);
      const channel = validateEnumField(control, "channel", TRIGGER_CHANNELS, path, errors);
      validateEnumField(control, "orientation", TRIGGER_ORIENTATIONS, path, errors, false);
      if (channel !== undefined) {
        registerChannels(controlId, `${path}.channel`, [channel], errors, channelOwners);
      }
      break;
    }

    case "touchpad": {
      validateLengthField(control, "w", path, errors);
      validateLengthField(control, "h", path, errors);
      registerChannels(controlId, `${path} (touchpad)`, ["rx", "ry"], errors, channelOwners);
      break;
    }

    case "slider": {
      validateLengthField(control, "w", path, errors);
      validateLengthField(control, "h", path, errors);
      const channel = validateEnumField(control, "channel", TRIGGER_CHANNELS, path, errors);
      validateEnumField(control, "direction", SLIDER_DIRECTIONS, path, errors, false);
      if (channel !== undefined) {
        registerChannels(controlId, `${path}.channel`, [channel], errors, channelOwners);
      }
      break;
    }

    case "gyro": {
      const sensitivity = control.sensitivity;
      if (
        sensitivity !== undefined &&
        (!isFiniteNumber(sensitivity) || sensitivity <= 0)
      ) {
        errors.push(`${path}.sensitivity: must be a positive number`);
      }
      const smoothing = control.smoothing;
      if (
        smoothing !== undefined &&
        (!isFiniteNumber(smoothing) || smoothing < 0 || smoothing > 1)
      ) {
        errors.push(`${path}.smoothing: must be a number 0..1`);
      }
      break;
    }

    case "choice": {
      validateChoice(control, path, errors);
      break;
    }

    case "panel": {
      validateLengthField(control, "w", path, errors);
      validateLengthField(control, "h", path, errors);
      break;
    }

    case "text": {
      validateLengthField(control, "w", path, errors);
      validateLengthField(control, "h", path, errors);
      validateEventField(control, path, errors);
      if (!isIntegerInRange(control.maxLen, MIN_TEXT_LEN, MAX_TEXT_LEN)) {
        if (control.maxLen === undefined) {
          errors.push(`${path}.maxLen: required`);
        } else {
          errors.push(
            `${path}.maxLen: must be an integer ${MIN_TEXT_LEN}..${MAX_TEXT_LEN}`,
          );
        }
      }
      break;
    }

    case "canvas": {
      validateLengthField(control, "w", path, errors);
      validateLengthField(control, "h", path, errors);
      validateEventField(control, path, errors);
      const maxStrokePoints = control.maxStrokePoints;
      if (
        maxStrokePoints !== undefined &&
        (!isFiniteNumber(maxStrokePoints) ||
          !Number.isInteger(maxStrokePoints) ||
          maxStrokePoints < 1)
      ) {
        errors.push(`${path}.maxStrokePoints: must be a positive integer`);
      }
      break;
    }
  }
}

function validateSensors(value: unknown, errors: string[]): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push("sensors: must be an object");
    return;
  }

  validateEnumField(value, "gyro", SENSOR_GYRO_MODES, "sensors", errors, false);

  const sensitivity = value.sensitivity;
  if (sensitivity !== undefined && (!isFiniteNumber(sensitivity) || sensitivity <= 0)) {
    errors.push("sensors.sensitivity: must be a positive number");
  }

  const smoothing = value.smoothing;
  if (smoothing !== undefined && (!isFiniteNumber(smoothing) || smoothing < 0 || smoothing > 1)) {
    errors.push("sensors.smoothing: must be a number 0..1");
  }
}

/**
 * Validates an untrusted layout document. Returns every problem in one pass so
 * an author can fix the file in one edit. The returned layout is the original
 * value: extra properties are preserved, matching the additive schema policy.
 */
export function validateLayout(
  value: unknown,
): { ok: true; layout: LayoutDocument } | { ok: false; errors: string[] } {
  if (!isRecord(value)) {
    return { ok: false, errors: ["layout: must be an object"] };
  }

  const byteSize = serializedByteSize(value);
  if (byteSize === null) {
    return { ok: false, errors: ["layout: must be JSON-serializable"] };
  }
  if (byteSize > MAX_LAYOUT_BYTES) {
    return {
      ok: false,
      errors: [
        `layout: serialized size ${byteSize} bytes exceeds the ${MAX_LAYOUT_BYTES}-byte limit`,
      ],
    };
  }

  const errors: string[] = [];

  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    errors.push("schemaVersion: must be 1 when present");
  }

  validateStringField(value, "id", "", errors, {
    min: MIN_LAYOUT_ID_CHARS,
    max: MAX_LAYOUT_ID_CHARS,
  });
  validateEnumField(value, "orientation", ORIENTATIONS, "", errors);

  const background = value.background;
  if (
    background !== undefined &&
    (typeof background !== "string" || !BACKGROUND_PATTERN.test(background))
  ) {
    errors.push("background: must be a #rgb or #rrggbb colour");
  }

  const controls = value.controls;
  if (controls === undefined) {
    errors.push("controls: required");
  } else if (!Array.isArray(controls)) {
    errors.push("controls: must be an array");
  } else {
    if (controls.length < MIN_CONTROLS || controls.length > MAX_CONTROLS) {
      errors.push(
        `controls: must contain ${MIN_CONTROLS}..${MAX_CONTROLS} entries (got ${controls.length})`,
      );
    }

    const seenIds = new Set<string>();
    const bitOwners = new Map<number, string>();
    const channelOwners = new Map<string, string>();

    for (let index = 0; index < controls.length; index += 1) {
      validateControl(
        controls[index],
        `controls[${index}]`,
        errors,
        seenIds,
        bitOwners,
        channelOwners,
      );
    }

    // FR-8.10 groundwork: a motion layout is only playable when the same
    // layout also offers a non-gyro input control. D6 enforces the runtime
    // fallback flow; the validator rejects documents that can never fall back.
    const gyroPaths: string[] = [];
    let hasFallback = false;
    for (let index = 0; index < controls.length; index += 1) {
      const control = controls[index];
      if (!isRecord(control) || typeof control.type !== "string") {
        continue;
      }
      if (control.type === "gyro") {
        gyroPaths.push(`controls[${index}]`);
      } else if (FALLBACK_CONTROL_TYPES.has(control.type)) {
        hasFallback = true;
      }
    }
    if (!hasFallback) {
      for (const path of gyroPaths) {
        errors.push(
          `${path}.type: gyro control requires a non-gyro fallback control in the same layout`,
        );
      }
    }
  }

  validateSensors(value.sensors, errors);

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, layout: value as unknown as LayoutDocument };
}

/**
 * Returns the layout-wide list of event names emitted by `choice`, `text` and
 * `canvas` controls, unique and in document order. Names may be shared (for
 * example several answer inputs); `panel` is display-only in v1 and never
 * contributes an event name.
 */
export function layoutEventNames(layout: LayoutDocument): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  for (const control of layout.controls) {
    if (control.type !== "choice" && control.type !== "text" && control.type !== "canvas") {
      continue;
    }
    if (!seen.has(control.event)) {
      seen.add(control.event);
      names.push(control.event);
    }
  }

  return names;
}

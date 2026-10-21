/**
 * Binary wire codecs (D0-PROTO-02).
 *
 * Every multi-byte field is little-endian and written through DataView. The
 * package never uses Buffer or Node built-ins so it runs in Node, browsers and
 * Deno (FR-10.1). Exact frame sizes are part of the frozen D0 contract:
 *
 *   Input      26 = type(1) + body(25)
 *   InputFwd   27 = type(1) + slot(1) + body(25)
 *   Ping        5 = type(1) + u32(4)
 *   Pong        9 = type(1) + u32(4) + u32(4)
 *   Haptic     2 + 2n = type(1) + n(1) + n*u16
 *   HapticCmd  3 + 2n = type(1) + slot(1) + n(1) + n*u16
 */
import {
  INPUT_FRAME_BYTES,
  INPUT_FWD_FRAME_BYTES,
  MAX_BINARY_FRAME_BYTES,
  MAX_CONTROLLERS,
  MAX_HAPTIC_STEPS,
  MSG,
} from "./constants.js";
import { ProtocolError } from "./errors.js";

export { ProtocolError } from "./errors.js";
export type { ProtocolErrorCode } from "./errors.js";

const PING_FRAME_BYTES = 5;
const PONG_FRAME_BYTES = 9;
const HAPTIC_HEADER_BYTES = 2;
const HAPTIC_CMD_HEADER_BYTES = 3;

/** Decoded state of one Input frame. Ranges are the wire ranges, not normalised values. */
export interface InputState {
  /**
   * Client estimate of server time in milliseconds at send time, truncated to
   * u32 (amendment A3). This is a timestamp, **not** a frame counter; it wraps
   * every ~49.7 days.
   */
  tick: number;
  /** u16 button level bitfield (FR-7.2). */
  buttons: number;
  /** u16 press-edge bitfield; a sub-tick tap shows as edge set with level clear (FR-7.3). */
  edges: number;
  /** Left stick X, i16 in [-32768, 32767] (FR-7.4). */
  lx: number;
  /** Left stick Y, i16 in [-32768, 32767] (FR-7.4). */
  ly: number;
  /** Right stick / touchpad X, i16 in [-32768, 32767] (FR-7.4, FR-7.7). */
  rx: number;
  /** Right stick / touchpad Y, i16 in [-32768, 32767] (FR-7.4, FR-7.7). */
  ry: number;
  /** Gyro X in degrees/second x10, i16 in [-32768, 32767] (FR-7.5). */
  gx: number;
  /** Gyro Y in degrees/second x10, i16 in [-32768, 32767] (FR-7.5). */
  gy: number;
  /** Gyro Z in degrees/second x10, i16 in [-32768, 32767] (FR-7.5). */
  gz: number;
  /** Left trigger, u8 in [0, 255] (FR-7.4). */
  lt: number;
  /** Right trigger, u8 in [0, 255] (FR-7.4). */
  rt: number;
  /** u8 flag bitfield: bit 0 motion active, bit 1 recentered, bits 2-7 reserved (FR-7.6). */
  flags: number;
}

/** Sequential little-endian writer over a DataView. */
class Writer {
  private offset = 0;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(value: number): void {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  u16(value: number): void {
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  i16(value: number): void {
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }

  u32(value: number): void {
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
  }
}

/** Sequential little-endian reader over a DataView. Reusable for the host hot path. */
class Reader {
  private offset: number;
  private view: DataView;

  constructor(view: DataView, offset = 0) {
    this.view = view;
    this.offset = offset;
  }

  reset(view: DataView, offset = 0): void {
    this.view = view;
    this.offset = offset;
  }

  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  u16(): number {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16(): number {
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }
}

/*
 * Hot-path scratch space. Copying the frame into one reusable buffer lets the
 * *Into decoders reuse a single DataView and Reader, so they allocate nothing
 * after module load (PR-9.3). JavaScript is single-threaded and these functions
 * never call out to user code, so the shared scratch cannot be re-entered.
 */
const scratchBytes = new Uint8Array(MAX_BINARY_FRAME_BYTES);
const scratchView = new DataView(scratchBytes.buffer);
const scratchReader = new Reader(scratchView);

function frameView(frame: Uint8Array): DataView {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
}

function badValue(message: string): never {
  throw new ProtocolError("badValue", message);
}

function finiteInt(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    badValue(`${field} must be a finite number`);
  }
  return Math.trunc(value);
}

function clampInt(value: number, min: number, max: number, field: string): number {
  const truncated = finiteInt(value, field);
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}

function toU32(value: number, field: string): number {
  // JavaScript bitwise operators are signed 32-bit; `>>> 0` yields the u32
  // representation and implements the documented wrap.
  return finiteInt(value, field) >>> 0;
}

function requireIntegerInRange(value: number, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    badValue(`${field} must be an integer in ${min}..${max}`);
  }
  return value;
}

function checkFrame(
  frame: Uint8Array,
  expectedLength: number,
  expectedType: number,
  label: string,
): void {
  if (!(frame instanceof Uint8Array)) {
    throw new ProtocolError("badType", `${label} frame must be a Uint8Array`);
  }
  if (frame.byteLength > MAX_BINARY_FRAME_BYTES) {
    throw new ProtocolError(
      "tooLarge",
      `${label} frame is ${frame.byteLength} bytes; max ${MAX_BINARY_FRAME_BYTES}`,
    );
  }
  if (frame.byteLength !== expectedLength) {
    throw new ProtocolError(
      "badLength",
      `${label} frame is ${frame.byteLength} bytes; expected ${expectedLength}`,
    );
  }
  if (frame[0] !== expectedType) {
    throw new ProtocolError("badType", `${label} frame has the wrong type byte`);
  }
}

function checkVariableFrame(
  frame: Uint8Array,
  expectedType: number,
  label: string,
  minimumLength: number,
): DataView {
  if (!(frame instanceof Uint8Array)) {
    throw new ProtocolError("badType", `${label} frame must be a Uint8Array`);
  }
  if (frame.byteLength > MAX_BINARY_FRAME_BYTES) {
    throw new ProtocolError(
      "tooLarge",
      `${label} frame is ${frame.byteLength} bytes; max ${MAX_BINARY_FRAME_BYTES}`,
    );
  }
  if (frame.byteLength < minimumLength) {
    throw new ProtocolError(
      "badLength",
      `${label} frame is ${frame.byteLength} bytes; minimum ${minimumLength}`,
    );
  }
  if (frame[0] !== expectedType) {
    throw new ProtocolError("badType", `${label} frame has the wrong type byte`);
  }
  return frameView(frame);
}

function emptyInputState(): InputState {
  return {
    tick: 0,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    lt: 0,
    rt: 0,
    flags: 0,
  };
}

/** Writes the 25-byte Input body (everything after the type byte). */
function writeInputBody(writer: Writer, state: InputState): void {
  writer.u32(toU32(state.tick, "tick"));
  writer.u16(clampInt(state.buttons, 0, 0xffff, "buttons"));
  writer.u16(clampInt(state.edges, 0, 0xffff, "edges"));
  writer.i16(clampInt(state.lx, -32768, 32767, "lx"));
  writer.i16(clampInt(state.ly, -32768, 32767, "ly"));
  writer.i16(clampInt(state.rx, -32768, 32767, "rx"));
  writer.i16(clampInt(state.ry, -32768, 32767, "ry"));
  writer.i16(clampInt(state.gx, -32768, 32767, "gx"));
  writer.i16(clampInt(state.gy, -32768, 32767, "gy"));
  writer.i16(clampInt(state.gz, -32768, 32767, "gz"));
  writer.u8(clampInt(state.lt, 0, 0xff, "lt"));
  writer.u8(clampInt(state.rt, 0, 0xff, "rt"));
  writer.u8(clampInt(state.flags, 0, 0xff, "flags"));
}

/** Reads the 25-byte Input body into an existing object. Allocates nothing. */
function readInputBody(reader: Reader, out: InputState): InputState {
  out.tick = reader.u32();
  out.buttons = reader.u16();
  out.edges = reader.u16();
  out.lx = reader.i16();
  out.ly = reader.i16();
  out.rx = reader.i16();
  out.ry = reader.i16();
  out.gx = reader.i16();
  out.gy = reader.i16();
  out.gz = reader.i16();
  out.lt = reader.u8();
  out.rt = reader.u8();
  out.flags = reader.u8();
  return out;
}

function hapticStepCount(durationsMs: readonly number[], label: string): number {
  if (!Array.isArray(durationsMs)) {
    badValue(`${label} durations must be an array`);
  }
  if (durationsMs.length > MAX_HAPTIC_STEPS) {
    badValue(`${label} has ${durationsMs.length} steps; max ${MAX_HAPTIC_STEPS}`);
  }
  return durationsMs.length;
}

function writeDurations(writer: Writer, durationsMs: readonly number[], count: number): void {
  writer.u8(count);
  for (let index = 0; index < count; index += 1) {
    const duration = durationsMs[index];
    if (typeof duration !== "number") {
      badValue(`duration ${index} must be a number`);
    }
    writer.u16(clampInt(duration, 0, 0xffff, `duration ${index}`));
  }
}

/**
 * Returns the frame's type byte, or null for an empty frame. Oversized or
 * unknown frames still report their byte so the transport can choose a close
 * code; decoders below enforce the size and type rules.
 */
export function frameType(frame: Uint8Array): number | null {
  if (!(frame instanceof Uint8Array) || frame.byteLength === 0) {
    return null;
  }
  return frame[0] ?? null;
}

/** Encodes an Input frame: 26 bytes. */
export function encodeInput(state: InputState): Uint8Array {
  const out = new Uint8Array(INPUT_FRAME_BYTES);
  const writer = new Writer(out);
  writer.u8(MSG.Input);
  writeInputBody(writer, state);
  return out;
}

/** Decodes an Input frame, allocating a new state object. */
export function decodeInput(frame: Uint8Array): InputState {
  return decodeInputInto(frame, emptyInputState());
}

/** Decodes an Input frame into `out` without allocating (host hot path). */
export function decodeInputInto(frame: Uint8Array, out: InputState): InputState {
  checkFrame(frame, INPUT_FRAME_BYTES, MSG.Input, "Input");
  scratchBytes.set(frame);
  scratchReader.reset(scratchView, 1);
  return readInputBody(scratchReader, out);
}

/** Encodes an InputFwd frame: 27 bytes (type, slot 1..8, Input body). */
export function encodeInputFwd(slot: number, state: InputState): Uint8Array {
  const slotValue = requireIntegerInRange(slot, 1, MAX_CONTROLLERS, "InputFwd slot");
  const out = new Uint8Array(INPUT_FWD_FRAME_BYTES);
  const writer = new Writer(out);
  writer.u8(MSG.InputFwd);
  writer.u8(slotValue);
  writeInputBody(writer, state);
  return out;
}

/** Decodes an InputFwd frame, allocating slot and state. */
export function decodeInputFwd(frame: Uint8Array): { slot: number; state: InputState } {
  const state = emptyInputState();
  const slot = decodeInputFwdInto(frame, state);
  return { slot, state };
}

/** Decodes an InputFwd frame into `out` and returns the slot without allocating. */
export function decodeInputFwdInto(frame: Uint8Array, out: InputState): number {
  checkFrame(frame, INPUT_FWD_FRAME_BYTES, MSG.InputFwd, "InputFwd");
  const slot = frame[1] ?? 0;
  if (slot < 1 || slot > MAX_CONTROLLERS) {
    badValue(`InputFwd slot ${slot} is outside 1..${MAX_CONTROLLERS}`);
  }
  scratchBytes.set(frame);
  scratchReader.reset(scratchView, 2);
  readInputBody(scratchReader, out);
  return slot;
}

/** Encodes a Ping frame: 5 bytes. */
export function encodePing(clientTimeMs: number): Uint8Array {
  const out = new Uint8Array(PING_FRAME_BYTES);
  const writer = new Writer(out);
  writer.u8(MSG.Ping);
  writer.u32(toU32(clientTimeMs, "clientTimeMs"));
  return out;
}

/** Decodes a Ping frame. */
export function decodePing(frame: Uint8Array): { clientTimeMs: number } {
  checkFrame(frame, PING_FRAME_BYTES, MSG.Ping, "Ping");
  const reader = new Reader(frameView(frame), 1);
  return { clientTimeMs: reader.u32() };
}

/** Encodes a Pong frame: 9 bytes. */
export function encodePong(clientTimeMs: number, serverTimeMs: number): Uint8Array {
  const out = new Uint8Array(PONG_FRAME_BYTES);
  const writer = new Writer(out);
  writer.u8(MSG.Pong);
  writer.u32(toU32(clientTimeMs, "clientTimeMs"));
  writer.u32(toU32(serverTimeMs, "serverTimeMs"));
  return out;
}

/** Decodes a Pong frame. */
export function decodePong(frame: Uint8Array): {
  clientTimeMs: number;
  serverTimeMs: number;
} {
  checkFrame(frame, PONG_FRAME_BYTES, MSG.Pong, "Pong");
  const reader = new Reader(frameView(frame), 1);
  return { clientTimeMs: reader.u32(), serverTimeMs: reader.u32() };
}

/**
 * Encodes a Haptic frame: type, step count, then u16 durations in ms
 * (alternating vibrate/pause). Size is exactly 2 + 2n with n <= 8.
 */
export function encodeHaptic(durationsMs: readonly number[]): Uint8Array {
  const count = hapticStepCount(durationsMs, "Haptic");
  const out = new Uint8Array(HAPTIC_HEADER_BYTES + count * 2);
  const writer = new Writer(out);
  writer.u8(MSG.Haptic);
  writeDurations(writer, durationsMs, count);
  return out;
}

/** Decodes a Haptic frame into its duration list. */
export function decodeHaptic(frame: Uint8Array): number[] {
  const view = checkVariableFrame(frame, MSG.Haptic, "Haptic", HAPTIC_HEADER_BYTES);
  const count = view.getUint8(1);
  if (count > MAX_HAPTIC_STEPS) {
    badValue(`Haptic has ${count} steps; max ${MAX_HAPTIC_STEPS}`);
  }
  const expectedLength = HAPTIC_HEADER_BYTES + count * 2;
  if (frame.byteLength !== expectedLength) {
    throw new ProtocolError(
      "badLength",
      `Haptic frame is ${frame.byteLength} bytes; expected ${expectedLength}`,
    );
  }
  const reader = new Reader(view, HAPTIC_HEADER_BYTES);
  const durationsMs = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    durationsMs[index] = reader.u16();
  }
  return durationsMs;
}

/**
 * Encodes a HapticCmd frame: type, slot, step count, then u16 durations.
 * Slot 0 means "all controllers" (D6); slots 1..8 target one controller.
 * Size is exactly 3 + 2n with n <= 8.
 */
export function encodeHapticCmd(slot: number, durationsMs: readonly number[]): Uint8Array {
  const slotValue = requireIntegerInRange(slot, 0, MAX_CONTROLLERS, "HapticCmd slot");
  const count = hapticStepCount(durationsMs, "HapticCmd");
  const out = new Uint8Array(HAPTIC_CMD_HEADER_BYTES + count * 2);
  const writer = new Writer(out);
  writer.u8(MSG.HapticCmd);
  writer.u8(slotValue);
  writeDurations(writer, durationsMs, count);
  return out;
}

/** Decodes a HapticCmd frame. */
export function decodeHapticCmd(frame: Uint8Array): {
  slot: number;
  durationsMs: number[];
} {
  const view = checkVariableFrame(frame, MSG.HapticCmd, "HapticCmd", HAPTIC_CMD_HEADER_BYTES);
  const slot = view.getUint8(1);
  if (slot > MAX_CONTROLLERS) {
    badValue(`HapticCmd slot ${slot} is outside 0..${MAX_CONTROLLERS}`);
  }
  const count = view.getUint8(2);
  if (count > MAX_HAPTIC_STEPS) {
    badValue(`HapticCmd has ${count} steps; max ${MAX_HAPTIC_STEPS}`);
  }
  const expectedLength = HAPTIC_CMD_HEADER_BYTES + count * 2;
  if (frame.byteLength !== expectedLength) {
    throw new ProtocolError(
      "badLength",
      `HapticCmd frame is ${frame.byteLength} bytes; expected ${expectedLength}`,
    );
  }
  const reader = new Reader(view, HAPTIC_CMD_HEADER_BYTES);
  const durationsMs = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    durationsMs[index] = reader.u16();
  }
  return { slot, durationsMs };
}

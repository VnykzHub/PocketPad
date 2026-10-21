/**
 * Controller input state store (D2-CTRL-03; FR-7.1, FR-7.3, FR-7.4, A3).
 *
 * Holds the controller's level state and its one-shot press edges. Controls
 * call the setters; `SendLoop` snapshots the store into a reusable
 * `InputState` and puts it on the wire. Level state is latest-wins for the
 * host; an edge stays latched until the packet that carries it has been sent
 * (`clearEdges()`), so a press that begins and ends between two sends still
 * reaches the host (FR-7.3).
 *
 * Units at this API boundary:
 * - buttons: protocol bit positions 0..15 (`BUTTON_BITS` in FR-7.2).
 * - axes: normalized deflection in [-1, 1]. The store applies the radial 8%
 *   deadzone and encodes i16 in [-32767, 32767] at snapshot time (FR-7.4).
 * - triggers: normalized in [0, 1]; encoded u8 in [0, 255].
 * - gyro: degrees/second x10 in wire units; D2 leaves these at zero (D6).
 * - flags: u8 bitfield (FR-7.6).
 *
 * `snapshot()` allocates one packet object; the hot path uses
 * `snapshotInto()` with the `SendLoop`'s single reused packet (PR-9.3).
 */
import type { InputState } from "@lanpad/protocol";

/** Radial stick deadzone applied before encoding (FR-7.4). */
export const DEFAULT_STICK_DEADZONE = 0.08;

/** Largest encoded stick value; the wire type allows -32768 but FR-7.4 says 32767. */
export const MAX_AXIS_VALUE = 32767;

/** Largest encoded trigger value (u8). */
export const MAX_TRIGGER_VALUE = 255;

/** Protocol button bits are positions 0..15 (FR-7.2). */
export const BUTTON_BIT_COUNT = 16;

const BUTTON_MASK = 0xffff;
const FLAGS_MASK = 0xff;
const GYRO_MIN = -32768;
const GYRO_MAX = 32767;

export type AxisName = "lx" | "ly" | "rx" | "ry";
export type TriggerChannel = "lt" | "rt";

interface StickPair {
  x: number;
  y: number;
}

/**
 * Scratch target for stick encoding. Module-level so `snapshotInto()` allocates
 * nothing; `encodeStick` only writes plain numbers and never calls out.
 */
const stickScratch: StickPair = { x: 0, y: 0 };

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clampInt16(value: number): number {
  return clamp(Math.trunc(value), GYRO_MIN, GYRO_MAX);
}

/**
 * Applies the radial deadzone and rescales the remaining magnitude so the
 * output spans 0..1 from the deadzone edge to full deflection. Components are
 * clamped to the unit circle first, so out-of-range input cannot produce a
 * vector whose length exceeds 32767.
 */
function encodeStick(x: number, y: number, out: StickPair): void {
  const rawX = clamp(x, -1, 1);
  const rawY = clamp(y, -1, 1);
  const rawMagnitude = Math.hypot(rawX, rawY);

  if (rawMagnitude <= DEFAULT_STICK_DEADZONE) {
    out.x = 0;
    out.y = 0;
    return;
  }

  const magnitude = Math.min(1, rawMagnitude);
  const scaled =
    (magnitude - DEFAULT_STICK_DEADZONE) / (1 - DEFAULT_STICK_DEADZONE);
  const unitX = rawX / rawMagnitude;
  const unitY = rawY / rawMagnitude;

  out.x = Math.round(unitX * scaled * MAX_AXIS_VALUE);
  out.y = Math.round(unitY * scaled * MAX_AXIS_VALUE);
}

function encodeTrigger(value: number): number {
  return Math.round(clamp(value, 0, 1) * MAX_TRIGGER_VALUE);
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

export class InputStore {
  /**
   * Called after any level or edge change. Wire it to
   * `SendLoop.notifyChange()` so a press is sent immediately (FR-7.1). Edge
   * clearing is not an input change and does not fire.
   */
  onChange: (() => void) | null = null;

  private buttons = 0;
  private edges = 0;
  private lx = 0;
  private ly = 0;
  private rx = 0;
  private ry = 0;
  private lt = 0;
  private rt = 0;
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private flags = 0;

  /**
   * Sets or clears one button bit. A down transition also latches the press
   * edge for the next packet; a release never latches an edge (FR-7.3). A
   * repeated `down = true` for a button that is already down is not a new
   * press and does not relatch the edge.
   */
  setButton(bit: number, down: boolean): void {
    if (!Number.isInteger(bit) || bit < 0 || bit >= BUTTON_BIT_COUNT) {
      return;
    }
    const mask = 1 << bit;

    if (down) {
      if ((this.buttons & mask) !== 0) {
        return;
      }
      this.buttons = (this.buttons | mask) & BUTTON_MASK;
      this.edges = (this.edges | mask) & BUTTON_MASK;
    } else {
      if ((this.buttons & mask) === 0) {
        return;
      }
      this.buttons = (this.buttons & ~mask) & BUTTON_MASK;
    }

    this.changed();
  }

  /**
   * Sets a stick axis from normalized deflection in [-1, 1]. The deadzone and
   * i16 encoding happen in `snapshot`/`snapshotInto` so both axes of a stick
   * are considered together (radial deadzone, FR-7.4).
   */
  setAxis(axis: AxisName, value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const next = clamp(value, -1, 1);

    switch (axis) {
      case "lx":
        if (this.lx === next) return;
        this.lx = next;
        break;
      case "ly":
        if (this.ly === next) return;
        this.ly = next;
        break;
      case "rx":
        if (this.rx === next) return;
        this.rx = next;
        break;
      case "ry":
        if (this.ry === next) return;
        this.ry = next;
        break;
      default:
        return;
    }

    this.changed();
  }

  /** Sets a trigger from normalized travel in [0, 1]; encoded u8 on the wire. */
  setTrigger(channel: TriggerChannel, value: number): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const next = clamp(value, 0, 1);

    switch (channel) {
      case "lt":
        if (this.lt === next) return;
        this.lt = next;
        break;
      case "rt":
        if (this.rt === next) return;
        this.rt = next;
        break;
      default:
        return;
    }

    this.changed();
  }

  /** Sets gyro values in wire units (degrees/second x10); zero in D2. */
  setGyro(x: number, y: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return;
    }
    const nextX = clampInt16(x);
    const nextY = clampInt16(y);
    const nextZ = clampInt16(z);
    if (this.gx === nextX && this.gy === nextY && this.gz === nextZ) {
      return;
    }
    this.gx = nextX;
    this.gy = nextY;
    this.gz = nextZ;
    this.changed();
  }

  /** Sets the u8 flag bitfield (FR-7.6). */
  setFlags(flags: number): void {
    if (!Number.isFinite(flags)) {
      return;
    }
    const next = clamp(Math.trunc(flags), 0, FLAGS_MASK);
    if (this.flags === next) {
      return;
    }
    this.flags = next;
    this.changed();
  }

  /**
   * Writes a packet view of the current state, allocating one `InputState`.
   *
   * @param nowMs Timestamp to stamp as `tick`; callers pass the synced server
   *   time estimate (A3), or 0 before the first clock sample. Truncated to u32.
   */
  snapshot(nowMs: number): InputState {
    return this.snapshotInto(emptyInputState(), nowMs);
  }

  /**
   * Writes a packet view into `out` without allocating. Edges are included but
   * not cleared (the send policy clears them only after `send()` returns).
   * Level state is never mutated.
   */
  snapshotInto(out: InputState, nowMs: number): InputState {
    out.tick = Math.trunc(nowMs) >>> 0;
    out.buttons = this.buttons;
    out.edges = this.edges;

    encodeStick(this.lx, this.ly, stickScratch);
    out.lx = stickScratch.x;
    out.ly = stickScratch.y;
    encodeStick(this.rx, this.ry, stickScratch);
    out.rx = stickScratch.x;
    out.ry = stickScratch.y;

    out.gx = this.gx;
    out.gy = this.gy;
    out.gz = this.gz;
    out.lt = encodeTrigger(this.lt);
    out.rt = encodeTrigger(this.rt);
    out.flags = this.flags;
    return out;
  }

  /** Clears every latched press edge; level state is untouched. */
  clearEdges(): void {
    this.edges = 0;
  }

  /**
   * True when any level field or a pending edge is non-zero. The send policy
   * uses this to pick the 60 Hz active cadence over the 10 Hz idle keepalive
   * (FR-7.1).
   */
  hasActiveInput(): boolean {
    return (
      this.buttons !== 0 ||
      this.edges !== 0 ||
      this.lx !== 0 ||
      this.ly !== 0 ||
      this.rx !== 0 ||
      this.ry !== 0 ||
      this.lt !== 0 ||
      this.rt !== 0 ||
      this.gx !== 0 ||
      this.gy !== 0 ||
      this.gz !== 0 ||
      this.flags !== 0
    );
  }

  private changed(): void {
    this.onChange?.();
  }
}

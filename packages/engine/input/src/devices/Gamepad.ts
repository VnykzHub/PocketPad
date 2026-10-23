/**
 * Gamepad state (10 §5.6).
 *
 * Standard mapping only (buttons 0..16, axes 0..3). Pads become assignable
 * after "meaningful input": a pressed button or an axis beyond 0.5. Edges are
 * derived at ingestion (snapshot diff or readout poll) and OR-accumulated
 * until the next poll. Non-standard pads remain diagnostic-only.
 */

import type {
  GamepadReadout,
  GamepadSnapshot,
} from "../contracts/input.js";
import {
  INPUT_GAMEPAD_AXIS_COUNT,
  INPUT_GAMEPAD_BUTTON_COUNT,
  INPUT_MAX_GAMEPADS,
} from "../version.js";

export interface PadRecord {
  index: number;
  present: boolean;
  connected: boolean;
  id: string;
  mapping: "standard" | "non-standard";
  buttons: number;
  triggerLt: number;
  triggerRt: number;
  axes: number[];
  pressPending: number;
  releasePending: number;
  meaningful: boolean;
}

function createPadRecord(index: number): PadRecord {
  return {
    index,
    present: false,
    connected: false,
    id: "",
    mapping: "standard",
    buttons: 0,
    triggerLt: 0,
    triggerRt: 0,
    axes: [0, 0, 0, 0],
    pressPending: 0,
    releasePending: 0,
    meaningful: false,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export class GamepadState {
  private readonly pads: PadRecord[] = [];
  private readonly seen = new Uint8Array(INPUT_MAX_GAMEPADS);

  /** Set when connection state, mapping or meaningfulness changes. */
  topologyDirty = false;
  /** Pads connected since the last drain; allocation only on real events. */
  readonly connectedEvents: number[] = [];
  /** Pads disconnected since the last drain. */
  readonly disconnectedEvents: number[] = [];
  /** Snapshots with an index outside 0..3. */
  invalidSnapshots = 0;
  nonStandardPads = 0;

  constructor() {
    for (let index = 0; index < INPUT_MAX_GAMEPADS; index += 1) {
      this.pads.push(createPadRecord(index));
    }
  }

  record(index: number): PadRecord | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= INPUT_MAX_GAMEPADS) {
      return undefined;
    }
    return this.pads[index];
  }

  /** A pad is assignable when standard, present, and meaningful. */
  isEligible(index: number, ignoreMeaningful = false): boolean {
    const record = this.record(index);
    if (record === undefined) return false;
    return (
      record.present &&
      record.connected &&
      record.mapping === "standard" &&
      (ignoreMeaningful || record.meaningful)
    );
  }

  private markConnected(record: PadRecord): void {
    record.present = true;
    record.connected = true;
    this.connectedEvents.push(record.index);
    this.topologyDirty = true;
  }

  private disconnect(record: PadRecord): void {
    if (!record.present) return;
    record.present = false;
    record.connected = false;
    // A disconnect releases every button still held (10 §5.6).
    record.releasePending |= record.buttons & 0x1ffff;
    record.buttons = 0;
    record.triggerLt = 0;
    record.triggerRt = 0;
    record.axes[0] = 0;
    record.axes[1] = 0;
    record.axes[2] = 0;
    record.axes[3] = 0;
    record.pressPending = 0;
    record.meaningful = false;
    this.disconnectedEvents.push(record.index);
    this.topologyDirty = true;
  }

  /**
   * Applies a runtime-decoded snapshot. Levels are replaced; edges are
   * OR-accumulated until the next poll.
   */
  applySnapshot(snapshot: GamepadSnapshot): void {
    const record = this.record(snapshot.index);
    if (record === undefined) {
      this.invalidSnapshots += 1;
      return;
    }
    if (!snapshot.connected) {
      this.disconnect(record);
      return;
    }
    if (!record.present) this.markConnected(record);
    if (record.mapping !== snapshot.mapping) {
      record.mapping = snapshot.mapping;
      this.topologyDirty = true;
      if (snapshot.mapping === "non-standard") this.nonStandardPads += 1;
    }
    record.id = snapshot.id;
    record.buttons = snapshot.buttons >>> 0;
    record.triggerLt = clamp01(snapshot.triggerValues.lt);
    record.triggerRt = clamp01(snapshot.triggerValues.rt);
    for (let axis = 0; axis < INPUT_GAMEPAD_AXIS_COUNT; axis += 1) {
      const value = snapshot.axes[axis];
      record.axes[axis] = Number.isFinite(value) ? (value as number) : 0;
    }
    record.pressPending |= snapshot.edges & 0x1ffff;
    record.releasePending |= snapshot.releaseEdges & 0x1ffff;
    if (!record.meaningful) {
      let significant = record.buttons !== 0;
      if (!significant) {
        for (let axis = 0; axis < INPUT_GAMEPAD_AXIS_COUNT; axis += 1) {
          const value = record.axes[axis];
          if (value !== undefined && Math.abs(value) > 0.5) {
            significant = true;
            break;
          }
        }
      }
      if (significant) {
        record.meaningful = true;
        this.topologyDirty = true;
      }
    }
  }

  /**
   * Polls the browser-like readout seam. Readouts are borrowed, never
   * retained. Pads missing from this list are disconnected.
   */
  applyReadouts(readouts: readonly (GamepadReadout | null)[]): void {
    this.seen.fill(0);
    for (const readout of readouts) {
      if (readout === null) continue;
      const record = this.record(readout.index);
      if (record === undefined) {
        this.invalidSnapshots += 1;
        continue;
      }
      this.seen[readout.index] = 1;
      if (!readout.connected) {
        this.disconnect(record);
        continue;
      }
      if (!record.present) this.markConnected(record);
      if (record.mapping !== readout.mapping) {
        record.mapping = readout.mapping;
        this.topologyDirty = true;
        if (readout.mapping === "non-standard") this.nonStandardPads += 1;
      }
      record.id = readout.id;

      let buttons = 0;
      for (let i = 0; i < INPUT_GAMEPAD_BUTTON_COUNT; i += 1) {
        const button = readout.buttons[i];
        if (button !== undefined && button.pressed) buttons |= 1 << i;
      }
      const lt = readout.buttons[6];
      const rt = readout.buttons[7];
      record.triggerLt = lt !== undefined ? clamp01(lt.value) : 0;
      record.triggerRt = rt !== undefined ? clamp01(rt.value) : 0;
      for (let axis = 0; axis < INPUT_GAMEPAD_AXIS_COUNT; axis += 1) {
        const value = readout.axes[axis];
        record.axes[axis] = value !== undefined && Number.isFinite(value) ? value : 0;
      }
      const previous = record.buttons;
      record.pressPending |= buttons & ~previous;
      record.releasePending |= previous & ~buttons;
      record.buttons = buttons;

      if (!record.meaningful) {
        let significant = buttons !== 0;
        if (!significant) {
          for (let axis = 0; axis < INPUT_GAMEPAD_AXIS_COUNT; axis += 1) {
            const value = record.axes[axis];
            if (value !== undefined && Math.abs(value) > 0.5) {
              significant = true;
              break;
            }
          }
        }
        if (significant) {
          record.meaningful = true;
          this.topologyDirty = true;
        }
      }
    }

    for (let index = 0; index < INPUT_MAX_GAMEPADS; index += 1) {
      if (this.seen[index] === 1) continue;
      const record = this.pads[index];
      if (record !== undefined) this.disconnect(record);
    }
  }

  /** Disconnects one pad by index (browser `gamepaddisconnected` bridge). */
  disconnectIndex(index: number): void {
    const record = this.record(index);
    if (record !== undefined) this.disconnect(record);
  }

  /** Clears pending edges after one poll has consumed them. */
  clearPending(): void {
    for (const record of this.pads) {
      record.pressPending = 0;
      record.releasePending = 0;
    }
  }

  /** Drains event indexes into the caller's arrays; both arrays are cleared. */
  drainEvents(connected: number[], disconnected: number[]): void {
    for (const index of this.connectedEvents) connected.push(index);
    for (const index of this.disconnectedEvents) disconnected.push(index);
    this.connectedEvents.length = 0;
    this.disconnectedEvents.length = 0;
  }

  reset(): void {
    for (const record of this.pads) {
      record.present = false;
      record.connected = false;
      record.id = "";
      record.mapping = "standard";
      record.buttons = 0;
      record.triggerLt = 0;
      record.triggerRt = 0;
      record.axes[0] = 0;
      record.axes[1] = 0;
      record.axes[2] = 0;
      record.axes[3] = 0;
      record.pressPending = 0;
      record.releasePending = 0;
      record.meaningful = false;
    }
    this.connectedEvents.length = 0;
    this.disconnectedEvents.length = 0;
    this.topologyDirty = true;
  }
}

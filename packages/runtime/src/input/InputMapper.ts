/**
 * Host input mapper (D2-RT-01).
 *
 * Applies the protocol's two different consistency rules per slot:
 *
 * - **Level fields are latest-wins by packet tick** (FR-7.11). A packet whose
 *   u32 tick is older than the accepted tick does not touch buttons, axes,
 *   triggers or gyro. Comparison is wrap-safe across the 49.7-day u32 wrap.
 * - **Press edges always accumulate** (FR-7.12). Every packet's `edges` is
 *   ORed into a per-slot accumulator before the tick check, so a press carried
 *   by a packet that lost the level race is still delivered exactly once at
 *   the next poll. Polling clears the accumulator (FR-7.3).
 *
 * Wire units are converted once, here, to the SPEC §7.5 game-facing units:
 * axes -1..1, triggers 0..1, gyro degrees/second. Games never decode a packet
 * and never see a socket (FR-7.17).
 *
 * **Connectivity is packet-driven** (FR-8.2, FR-5.4): every accepted packet
 * for an in-range slot marks it connected, including a tick-0 all-zero packet
 * sent before clock sync. `reset(slot)` clears it when the host sees a leave.
 * Tick and input values are never used as a presence heuristic.
 *
 * `apply` and `pollAll` are deterministic and allocation-free (PR-9.3). The
 * only clock read is in `getStats`, which is diagnostics, not input policy.
 *
 * D4 dependency: a reconnect may deliver a restarted controller clock. Call
 * `reset(slot)` on rejoin (or resync the clock before `apply`) so the tick
 * baseline is dropped; otherwise the new ticks can compare as stale.
 */
import { MAX_CONTROLLERS, type InputState } from "@lanpad/protocol";
import type {
  ControllerState,
  InputMapperOptions,
  InputSnapshot,
  SlotStats,
} from "./types.js";

/**
 * Internal mutable view of the pooled state. `connected` is readonly to game
 * code but changes through `apply`/`reset`, and the mapper owns the object.
 */
type MutableControllerState = {
  -readonly [K in keyof ControllerState]: ControllerState[K];
};

const AXIS_MAX = 32767;
const TRIGGER_MAX = 255;
const GYRO_WIRE_SCALE = 10;
const BITMASK_16 = 0xffff;
/** `InputState.flags` bit 0: motion data active for this packet (D6, FR-7.6). */
const FLAG_MOTION_ACTIVE = 0x01;
/** `InputState.flags` bit 1: the controller recentered in this packet. */
const FLAG_RECENTERED = 0x02;
/** Half of the u32 range; `(a - b) >>> 0 < HALF_U32` means "a is not older". */
const HALF_U32 = 0x80000000;
const RATE_WINDOW_MS = 1000;
/** 60 Hz packets plus change bursts for one slot; ~8 s of history. */
const RATE_CAPACITY = 512;

interface SlotRecord {
  /** Pooled game-facing object; also the object in `InputSnapshot.players`. */
  readonly state: MutableControllerState;
  /** Latched by every accepted packet; published by `pollAll` (FR-8.2). */
  connected: boolean;
  /** Edges received since the last `pollAll`; separate from `state.edges`. */
  pendingEdges: number;
  hasTick: boolean;
  lastTick: number;
  lastReceivedAtMs: number | null;
  drops: number;
  readonly rateTimes: Float64Array;
  rateCount: number;
  rateHead: number;
}

export class InputMapper {
  private readonly records: SlotRecord[] = [];
  private readonly players: ControllerState[] = [];
  private readonly snapshot: InputSnapshot;
  private readonly deadzone: number;
  /** Packets addressed to a slot outside 1..N; observable via `getStats(slot)`. */
  private invalidSlotDrops = 0;

  constructor(options: InputMapperOptions = {}) {
    const slotCount = options.slots ?? MAX_CONTROLLERS;
    if (
      !Number.isInteger(slotCount) ||
      slotCount < 1 ||
      slotCount > MAX_CONTROLLERS
    ) {
      throw new RangeError(
        `InputMapper slots must be an integer in 1..${MAX_CONTROLLERS}.`,
      );
    }

    const deadzone = options.deadzone ?? 0;
    if (!Number.isFinite(deadzone) || deadzone < 0 || deadzone > 1) {
      throw new RangeError("InputMapper deadzone must be in 0..1.");
    }
    this.deadzone = deadzone;

    for (let slot = 1; slot <= slotCount; slot += 1) {
      const state: MutableControllerState = {
        slot,
        connected: false,
        buttons: 0,
        edges: 0,
        lx: 0,
        ly: 0,
        rx: 0,
        ry: 0,
        gyro: { x: 0, y: 0, z: 0 },
        gyroActive: false,
        gyroRecentered: false,
        // Pooled here so GameHost can integrate in place (D6-RT-01).
        tilt: { angleX: 0, angleY: 0, available: false },
        triggers: { lt: 0, rt: 0 },
        tick: 0,
      };
      this.players.push(state);
      this.records.push({
        state,
        connected: false,
        pendingEdges: 0,
        hasTick: false,
        lastTick: 0,
        lastReceivedAtMs: null,
        drops: 0,
        rateTimes: new Float64Array(RATE_CAPACITY),
        rateCount: 0,
        rateHead: 0,
      });
    }

    this.snapshot = { tick: 0, players: this.players };
  }

  /**
   * Ingest one decoded Input packet for a slot.
   *
   * Out-of-range slots are ignored and counted as drops. Every accepted
   * packet marks the slot connected, including tick 0 and an all-zero state,
   * so a fresh phone is present before clock sync (FR-8.2, FR-5.4). Level
   * fields update only when the packet tick is newer than or equal to the
   * accepted tick; edges update on every packet (FR-7.11, FR-7.12).
   */
  apply(slot: number, packet: InputState, receivedAtMs: number): void {
    const record = this.recordFor(slot);
    if (record === undefined) {
      this.invalidSlotDrops += 1;
      return;
    }

    record.lastReceivedAtMs = receivedAtMs;
    // Presence is the packet itself, never the tick or the decoded values.
    record.connected = true;
    this.recordPacketRate(record, receivedAtMs);

    record.pendingEdges = (record.pendingEdges | packet.edges) & BITMASK_16;

    const tick = packet.tick >>> 0;
    if (record.hasTick && ((tick - record.lastTick) >>> 0) >= HALF_U32) {
      return;
    }

    record.hasTick = true;
    record.lastTick = tick;

    const state = record.state;
    state.buttons = packet.buttons & BITMASK_16;
    state.lx = normalizeAxis(packet.lx);
    state.ly = normalizeAxis(packet.ly);
    state.rx = normalizeAxis(packet.rx);
    state.ry = normalizeAxis(packet.ry);
    state.gyro.x = packet.gx / GYRO_WIRE_SCALE;
    state.gyro.y = packet.gy / GYRO_WIRE_SCALE;
    state.gyro.z = packet.gz / GYRO_WIRE_SCALE;
    state.gyroActive = (packet.flags & FLAG_MOTION_ACTIVE) !== 0;
    state.gyroRecentered = (packet.flags & FLAG_RECENTERED) !== 0;
    state.triggers.lt = normalizeTrigger(packet.lt);
    state.triggers.rt = normalizeTrigger(packet.rt);
    state.tick = tick;
  }

  /**
   * Return the pooled snapshot for this host tick and clear the edge
   * accumulators (FR-7.12). Level fields were stored by `apply`; this only
   * publishes the pending edges and applies the optional host deadzone.
   */
  pollAll(hostTick: number): InputSnapshot {
    this.snapshot.tick = hostTick;
    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index];
      if (record === undefined) {
        continue;
      }
      const state = record.state;
      state.connected = record.connected;
      state.edges = record.pendingEdges;
      record.pendingEdges = 0;
      if (this.deadzone > 0) {
        applyDeadzone(state, this.deadzone);
      }
    }
    return this.snapshot;
  }

  /** Latest polled state for one slot, or undefined outside 1..N. */
  getSlot(slot: number): ControllerState | undefined {
    return this.recordFor(slot)?.state;
  }

  /**
   * Diagnose one slot. `receivedAtMs` and `performance.now()` must share a
   * clock; the runtime's host shell uses `performance.now()`.
   */
  getStats(slot: number): SlotStats {
    const record = this.recordFor(slot);
    if (record === undefined) {
      return {
        lastInputAgeMs: -1,
        packetsPerSecond: 0,
        drops: this.invalidSlotDrops,
      };
    }

    const now = performance.now();
    const receivedAt = record.lastReceivedAtMs;
    return {
      lastInputAgeMs:
        receivedAt === null ? -1 : Math.max(0, now - receivedAt),
      packetsPerSecond: countPacketsInWindow(record, now),
      drops: record.drops,
    };
  }

  /**
   * Clear a slot (player left) or every slot, including connectivity. Pooled
   * objects are reused, so a later packet reconnects the same state object.
   */
  reset(slot?: number): void {
    if (slot === undefined) {
      for (let index = 0; index < this.records.length; index += 1) {
        const record = this.records[index];
        if (record !== undefined) {
          clearRecord(record);
        }
      }
      return;
    }

    const record = this.recordFor(slot);
    if (record !== undefined) {
      clearRecord(record);
    }
  }

  private recordFor(slot: number): SlotRecord | undefined {
    if (!Number.isInteger(slot) || slot < 1 || slot > this.records.length) {
      return undefined;
    }
    return this.records[slot - 1];
  }

  private recordPacketRate(record: SlotRecord, atMs: number): void {
    record.rateTimes[record.rateHead] = atMs;
    record.rateHead = (record.rateHead + 1) % RATE_CAPACITY;
    if (record.rateCount < RATE_CAPACITY) {
      record.rateCount += 1;
    }
  }
}

function clearRecord(record: SlotRecord): void {
  const state = record.state;
  state.connected = false;
  state.buttons = 0;
  state.edges = 0;
  state.lx = 0;
  state.ly = 0;
  state.rx = 0;
  state.ry = 0;
  state.gyro.x = 0;
  state.gyro.y = 0;
  state.gyro.z = 0;
  state.gyroActive = false;
  state.gyroRecentered = false;
  if (state.tilt !== undefined) {
    state.tilt.angleX = 0;
    state.tilt.angleY = 0;
    state.tilt.available = false;
  }
  state.triggers.lt = 0;
  state.triggers.rt = 0;
  state.tick = 0;

  record.connected = false;
  record.pendingEdges = 0;
  record.hasTick = false;
  record.lastTick = 0;
  record.lastReceivedAtMs = null;
  record.drops = 0;
  record.rateCount = 0;
  record.rateHead = 0;
}

function normalizeAxis(value: number): number {
  if (value >= AXIS_MAX) {
    return 1;
  }
  if (value <= -AXIS_MAX) {
    return -1;
  }
  return value / AXIS_MAX;
}

function normalizeTrigger(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= TRIGGER_MAX) {
    return 1;
  }
  return value / TRIGGER_MAX;
}

/**
 * Radial cutoff per stick pair. Values inside the radius go to zero; values
 * outside pass through unscaled because the controller already owns the 8%
 * curve (FR-7.4). Applying this twice is therefore idempotent.
 */
function applyDeadzone(state: ControllerState, deadzone: number): void {
  const left = Math.sqrt(state.lx * state.lx + state.ly * state.ly);
  if (left <= deadzone) {
    state.lx = 0;
    state.ly = 0;
  }

  const right = Math.sqrt(state.rx * state.rx + state.ry * state.ry);
  if (right <= deadzone) {
    state.rx = 0;
    state.ry = 0;
  }
}

function countPacketsInWindow(record: SlotRecord, nowMs: number): number {
  let count = 0;
  for (let index = 0; index < record.rateCount; index += 1) {
    const atMs = record.rateTimes[index];
    if (atMs === undefined) {
      continue;
    }
    const age = nowMs - atMs;
    if (age >= 0 && age <= RATE_WINDOW_MS) {
      count += 1;
    }
  }
  return count;
}

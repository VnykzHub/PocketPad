/**
 * Per-slot statistics and the 1 Hz `stats` stream to the host (D4-SRV-03).
 *
 * The adapter feeds this module from traffic it already sees:
 * - every WS ping it sends (`recordPing`) and the matching `pong`
 *   (`recordPong`) produce RTT and an EWMA of |rtt - previousRtt| (alpha 0.2);
 * - every forwarded Input frame (`recordInput`) feeds the sliding 1 s
 *   packets-per-second count;
 * - every frame dropped for backpressure, a paused host or a stale slot
 *   (`recordDrop`) increments the slot's drop counter.
 *
 * `collect` builds the frozen `SlotStats` shape (one entry per active slot)
 * and `send` delivers it to the host as a normal protocol message. `send` is
 * called by `StatsTicker` every second while a host is attached.
 *
 * Time and the interval are injected so tests never sleep. Nothing here logs,
 * which keeps tokens and PINs out of the stats path by construction (SR-9).
 */
import {
  stringifyJsonMessage,
  type ServerToClientMessage,
  type SlotStats,
} from "@lanpad/protocol";
import type { ControllerSlot, Room } from "../room.js";

/** D4-SRV-03: stats are sent once per second. */
export const STATS_INTERVAL_MS = 1_000;

/** EWMA weight for jitter, matching the spec's 0.2 smoothing coefficient. */
export const JITTER_ALPHA = 0.2;

/** `packetsPerSecond` counts Input frames inside this trailing window. */
export const INPUT_WINDOW_MS = 1_000;

interface SlotTelemetry {
  /** Timestamp of the outstanding ping, or null when no pong is expected. */
  pingSentAt: number | null;
  /** Previous RTT sample, used for the jitter delta. */
  previousRttMs: number | null;
  /** EWMA of |rtt - previousRtt|. */
  jitterMs: number;
  /** Input arrival times inside the current (and previous) window. */
  inputTimestamps: number[];
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Collects per-slot telemetry. Slot records are the source of truth for the
 * counters; the `WeakMap` holds only the transient windows, so a slot that
 * leaves and rejoins starts with a clean window but keeps its `ControllerSlot`
 * history while the record lives.
 */
export class StatsCollector {
  private readonly telemetry = new WeakMap<ControllerSlot, SlotTelemetry>();
  private readonly alpha: number;

  constructor(options: { alpha?: number } = {}) {
    this.alpha = options.alpha ?? JITTER_ALPHA;
  }

  /** Records that a WS ping was sent to an active slot (FR-7.14). */
  recordPing(room: Room, slot: number, now: number): boolean {
    const controller = this.activeController(room, slot);
    if (controller === undefined) {
      return false;
    }
    this.telemetryFor(controller).pingSentAt = now;
    return true;
  }

  /**
   * Records the matching pong and returns the measured RTT in ms. Returns null
   * when no ping is outstanding (unsolicited or late pong) so a stale reply
   * cannot corrupt the EWMA.
   */
  recordPong(room: Room, slot: number, now: number): number | null {
    const controller = this.activeController(room, slot);
    if (controller === undefined) {
      return null;
    }
    const telemetry = this.telemetryFor(controller);
    const sentAt = telemetry.pingSentAt;
    if (sentAt === null) {
      return null;
    }
    telemetry.pingSentAt = null;

    const rttMs = Math.max(0, now - sentAt);
    if (telemetry.previousRttMs !== null) {
      const delta = Math.abs(rttMs - telemetry.previousRttMs);
      telemetry.jitterMs = this.alpha * delta + (1 - this.alpha) * telemetry.jitterMs;
    }
    telemetry.previousRttMs = rttMs;
    controller.rttMs = rttMs;
    controller.jitterMs = telemetry.jitterMs;
    return rttMs;
  }

  /** Counts one forwarded Input frame for the sliding packets/s value. */
  recordInput(room: Room, slot: number, now: number): boolean {
    const controller = this.activeController(room, slot);
    if (controller === undefined) {
      return false;
    }
    const telemetry = this.telemetryFor(controller);
    this.pruneInputs(telemetry, now);
    telemetry.inputTimestamps.push(now);
    return true;
  }

  /**
   * Counts dropped frames (backpressure, paused host or a stale slot). A slot
   * record that still exists is counted even while it is reserved, so a frame
   * that arrives just after `suspend` is attributed to the right player.
   */
  recordDrop(room: Room, slot: number, count = 1): boolean {
    const controller = room.controllers.get(slot);
    if (controller === undefined) {
      return false;
    }
    controller.drops += count > 0 ? count : 0;
    return true;
  }

  /** One `SlotStats` entry per active slot, in ascending slot order. */
  collect(room: Room, now: number): SlotStats[] {
    const controllers = [...room.controllers.values()].sort((left, right) => left.slot - right.slot);
    const slots: SlotStats[] = [];
    for (const controller of controllers) {
      if (controller.peer === null) {
        continue;
      }
      const telemetry = this.telemetry.get(controller);
      const packetsPerSecond = telemetry === undefined ? 0 : this.countInputs(telemetry, now);
      slots.push({
        slot: controller.slot,
        rttMs: nonNegative(controller.rttMs),
        jitterMs: nonNegative(controller.jitterMs),
        lastInputAgeMs: nonNegative(now - controller.lastInputAt),
        packetsPerSecond,
        drops: nonNegative(controller.drops),
      });
    }
    return slots;
  }

  /** The protocol message for one tick; validated at the edge when serialized. */
  message(room: Room, now: number): ServerToClientMessage {
    return { t: "stats", slots: this.collect(room, now) };
  }

  /** Sends one stats frame to the attached host. False when there is no host. */
  send(room: Room, now: number): boolean {
    const host = room.host;
    if (host === null) {
      return false;
    }
    try {
      host.send(stringifyJsonMessage(this.message(room, now)));
      return true;
    } catch {
      // A host whose transport is gone will be reaped by the heartbeat.
      return false;
    }
  }

  private activeController(room: Room, slot: number): ControllerSlot | undefined {
    const controller = room.controllers.get(slot);
    return controller !== undefined && controller.peer !== null ? controller : undefined;
  }

  private telemetryFor(controller: ControllerSlot): SlotTelemetry {
    const existing = this.telemetry.get(controller);
    if (existing !== undefined) {
      return existing;
    }
    const created: SlotTelemetry = {
      pingSentAt: null,
      previousRttMs: null,
      jitterMs: 0,
      inputTimestamps: [],
    };
    this.telemetry.set(controller, created);
    return created;
  }

  private pruneInputs(telemetry: SlotTelemetry, now: number): void {
    const cutoff = now - INPUT_WINDOW_MS;
    while (telemetry.inputTimestamps.length > 0 && (telemetry.inputTimestamps[0] ?? 0) <= cutoff) {
      telemetry.inputTimestamps.shift();
    }
  }

  private countInputs(telemetry: SlotTelemetry, now: number): number {
    this.pruneInputs(telemetry, now);
    return telemetry.inputTimestamps.length;
  }
}

export interface StatsTickerOptions {
  collector: StatsCollector;
  /** Server clock, normally `RoomRegistry.nowMs`. */
  now: () => number;
  /** Defaults to `STATS_INTERVAL_MS` (1 s). */
  intervalMs?: number;
}

/**
 * Drives the 1 Hz stats stream for the rooms that currently have a host. The
 * adapter starts a room on `hostJoined` and stops it when the host socket
 * closes or the room expires. `start` is idempotent per room so a host
 * recovery can call it again without creating a second interval.
 */
export class StatsTicker {
  private readonly collector: StatsCollector;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly timers = new Map<Room, ReturnType<typeof setInterval>>();

  constructor(options: StatsTickerOptions) {
    this.collector = options.collector;
    this.now = options.now;
    this.intervalMs = options.intervalMs ?? STATS_INTERVAL_MS;
  }

  start(room: Room): void {
    if (this.timers.has(room)) {
      return;
    }
    const timer = setInterval(() => {
      this.collector.send(room, this.now());
    }, this.intervalMs);
    timer.unref?.();
    this.timers.set(room, timer);
  }

  stop(room: Room): void {
    const timer = this.timers.get(room);
    if (timer === undefined) {
      return;
    }
    clearInterval(timer);
    this.timers.delete(room);
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /** Sends one frame immediately; used by tests and manual diagnostics. */
  tick(room: Room): boolean {
    return this.collector.send(room, this.now());
  }
}

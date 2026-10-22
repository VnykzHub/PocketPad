/**
 * Haptic command routing and rate limiting (D6-SRV-01).
 *
 * The host sends binary `HapticCmd` (0xA2): `u8 slot, u8 n, u16[n]`. The broker
 * validates the pattern, applies a per-slot 20 Hz token bucket and forwards
 * binary `Haptic` (0x84) with the same durations. Slot 0 targets every
 * connected controller; reserved and absent slots are skipped without error.
 *
 * Patterns are routed, never interpreted, stored or logged (FR-7.9, SR-12).
 * The controller also coalesces at 20 Hz; double limiting is intentional
 * (FR-8.11).
 */
import {
  MAX_CONTROLLERS,
  MAX_HAPTIC_STEPS,
  encodeHaptic,
} from "@lanpad/protocol";
import type { ControllerSlot, Room } from "../room.js";
import { TokenBucket } from "./rateLimit.js";

/** FR-8.11: sustained haptic commands per second for one slot. */
export const HAPTIC_RATE_PER_SECOND = 20;

/**
 * One second's allowance as the immediate burst. The plan names the rate but
 * not a haptic burst; matching the event channel's "one second of capacity"
 * keeps a short pattern sequence intact while still capping sustained traffic.
 */
export const HAPTIC_BURST = 20;

const MAX_DURATION_MS = 0xffff;

/**
 * True for 1..8 integer durations in the u16 range. The D0 codec allows
 * `n = 0` for round-trip properties; an empty command is a no-op and the
 * broker rejects it so a zero-step frame is visible in the drop counter.
 */
export function isValidHapticPattern(durationsMs: readonly number[]): boolean {
  if (!Array.isArray(durationsMs)) {
    return false;
  }
  if (durationsMs.length < 1 || durationsMs.length > MAX_HAPTIC_STEPS) {
    return false;
  }
  for (const duration of durationsMs) {
    if (!Number.isInteger(duration) || duration < 0 || duration > MAX_DURATION_MS) {
      return false;
    }
  }
  return true;
}

function bucketFor(room: Room, slot: number, now: number): TokenBucket {
  let bucket = room.hapticBuckets.get(slot);
  if (bucket === undefined) {
    bucket = new TokenBucket(
      { ratePerSecond: HAPTIC_RATE_PER_SECOND, burst: HAPTIC_BURST },
      now,
    );
    room.hapticBuckets.set(slot, bucket);
  }
  return bucket;
}

function recordDrop(room: Room, controller?: ControllerSlot): void {
  room.hapticDrops += 1;
  if (controller !== undefined) {
    controller.drops += 1;
  }
}

/**
 * Routes one validated host command and returns the number of controllers it
 * reached. Every drop (invalid pattern/slot, missing or reserved target, rate
 * limit, transport failure) increments `room.hapticDrops`; per-target drops
 * also increment the slot's `drops` counter exposed in host stats.
 */
export function routeHaptic(
  room: Room,
  slot: number,
  durationsMs: readonly number[],
  now: number,
): number {
  if (
    !Number.isInteger(slot) ||
    slot < 0 ||
    slot > MAX_CONTROLLERS ||
    !isValidHapticPattern(durationsMs)
  ) {
    recordDrop(room);
    return 0;
  }

  room.lastActivityAt = now;
  const frame = encodeHaptic(durationsMs);

  if (slot === 0) {
    let sent = 0;
    for (const controller of room.controllers.values()) {
      // Reserved slots have no peer; skip them without counting an error.
      if (controller.peer === null) {
        continue;
      }
      if (!bucketFor(room, controller.slot, now).take(now)) {
        recordDrop(room, controller);
        continue;
      }
      try {
        controller.peer.send(frame);
        sent += 1;
      } catch {
        recordDrop(room, controller);
      }
    }
    return sent;
  }

  const controller = room.controllers.get(slot);
  if (controller === undefined) {
    recordDrop(room);
    return 0;
  }
  if (controller.peer === null) {
    // D6-SRV-01: a reserved slot is a counted drop, not an error.
    recordDrop(room, controller);
    return 0;
  }
  if (!bucketFor(room, slot, now).take(now)) {
    recordDrop(room, controller);
    return 0;
  }
  try {
    controller.peer.send(frame);
    return 1;
  } catch {
    recordDrop(room, controller);
    return 0;
  }
}

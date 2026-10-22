/**
 * D6-SRV-01 haptic routing: addressed delivery, slot 0 fan-out, per-slot
 * 20 Hz limiting, validation and the no-storage/no-logging guarantees
 * (FR-8.11, FR-7.9, SR-12). Registry-level: no sockets and an injected clock.
 */
import { describe, expect, test } from "vitest";
import { decodeHaptic } from "@lanpad/protocol";
import {
  HAPTIC_BURST,
  HAPTIC_RATE_PER_SECOND,
  isValidHapticPattern,
} from "../src/room/haptics.js";
import { FakePeer, makeRoomHarness } from "./helpers.js";

function hapticFrames(peer: FakePeer): number[][] {
  return peer.binaryFrames().map((frame) => decodeHaptic(frame));
}

/** Deep scan used to prove a pattern never lands in room state. */
function containsNumber(value: unknown, needle: number, seen = new Set<object>()): boolean {
  if (typeof value === "number") {
    return value === needle;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);

  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (containsNumber(key, needle, seen) || containsNumber(entry, needle, seen)) {
        return true;
      }
    }
    return false;
  }
  if (value instanceof Set) {
    for (const entry of value) {
      if (containsNumber(entry, needle, seen)) {
        return true;
      }
    }
    return false;
  }
  for (const entry of Object.values(value)) {
    if (containsNumber(entry, needle, seen)) {
      return true;
    }
  }
  return false;
}

describe("haptic routing", () => {
  test("[FR-8.11] a host command for slot 2 reaches only slot 2", () => {
    const h = makeRoomHarness({ controllerCount: 3 });

    expect(h.registry.routeHaptic(h.code, 2, [30, 40])).toBe(1);

    expect(hapticFrames(h.controllers[1]!)).toEqual([[30, 40]]);
    expect(h.controllers[0]?.binaryFrames()).toHaveLength(0);
    expect(h.controllers[2]?.binaryFrames()).toHaveLength(0);
  });

  test("[FR-8.11] slot 0 reaches all connected controllers and skips reserved slots", () => {
    const h = makeRoomHarness({ controllerCount: 3 });
    expect(h.registry.suspend(h.code, 2, h.clock.now())).toBe(true);

    expect(h.registry.routeHaptic(h.code, 0, [7, 9])).toBe(2);

    expect(hapticFrames(h.controllers[0]!)).toEqual([[7, 9]]);
    expect(h.controllers[1]?.binaryFrames()).toHaveLength(0);
    expect(hapticFrames(h.controllers[2]!)).toEqual([[7, 9]]);
    // Skipping a reserved slot during a broadcast is not a drop.
    expect(h.registry.getRoom(h.code)?.hapticDrops).toBe(0);
  });

  test("[FR-8.11] 21 rapid commands deliver 20 and refill at 20/s", () => {
    const h = makeRoomHarness({ controllerCount: 2 });

    let delivered = 0;
    for (let index = 0; index < 21; index += 1) {
      delivered += h.registry.routeHaptic(h.code, 1, [10]);
    }

    expect(HAPTIC_RATE_PER_SECOND).toBe(20);
    expect(delivered).toBe(HAPTIC_BURST);
    expect(hapticFrames(h.controllers[0]!)).toHaveLength(20);
    expect(h.registry.getRoom(h.code)?.hapticDrops).toBe(1);
    expect(h.registry.getRoom(h.code)?.controllers.get(1)?.drops).toBe(1);

    // The other slot's bucket is independent.
    expect(h.registry.routeHaptic(h.code, 2, [10])).toBe(1);

    // 20/s refills one command per 50 ms.
    h.clock.advance(50);
    expect(h.registry.routeHaptic(h.code, 1, [10])).toBe(1);
    expect(h.registry.routeHaptic(h.code, 1, [10])).toBe(0);
    expect(h.registry.getRoom(h.code)?.hapticDrops).toBe(2);
  });

  test("[FR-8.11] sustained commands at 20/s are all delivered", () => {
    const h = makeRoomHarness();

    for (let index = 0; index < 40; index += 1) {
      h.clock.advance(50);
      expect(h.registry.routeHaptic(h.code, 1, [5])).toBe(1);
    }

    expect(hapticFrames(h.controllers[0]!)).toHaveLength(40);
  });

  test("[FR-7.9] invalid slots and patterns are dropped before routing", () => {
    const h = makeRoomHarness();
    const invalidPatterns: number[][] = [[], [1, 2, 3, 4, 5, 6, 7, 8, 9], [-1], [1.5], [65_536]];

    for (const pattern of invalidPatterns) {
      expect(h.registry.routeHaptic(h.code, 1, pattern)).toBe(0);
    }
    for (const slot of [-1, 1.5, 9]) {
      expect(h.registry.routeHaptic(h.code, slot, [1])).toBe(0);
    }

    expect(h.controllers[0]?.binaryFrames()).toHaveLength(0);
    expect(h.registry.getRoom(h.code)?.hapticDrops).toBe(invalidPatterns.length + 3);
  });

  test("[FR-8.11] a valid pattern has 1..8 integer u16 durations", () => {
    expect(isValidHapticPattern([0])).toBe(true);
    expect(isValidHapticPattern([65_535])).toBe(true);
    expect(isValidHapticPattern(new Array<number>(8).fill(1))).toBe(true);
    expect(isValidHapticPattern([])).toBe(false);
    expect(isValidHapticPattern(new Array<number>(9).fill(1))).toBe(false);
    expect(isValidHapticPattern([65_536])).toBe(false);
    expect(isValidHapticPattern([1.5])).toBe(false);
  });

  test("[FR-8.11] reserved and absent slots are counted drops, not errors", () => {
    const h = makeRoomHarness();
    expect(h.registry.suspend(h.code, 1, h.clock.now())).toBe(true);

    expect(h.registry.routeHaptic(h.code, 1, [10])).toBe(0);
    expect(h.registry.getRoom(h.code)?.controllers.get(1)?.drops).toBe(1);

    expect(h.registry.routeHaptic(h.code, 5, [10])).toBe(0);
    expect(h.registry.getRoom(h.code)?.hapticDrops).toBe(2);
    expect(h.controllers[0]?.binaryFrames()).toHaveLength(0);
  });

  test("[SR-12] patterns are never stored or logged", () => {
    const h = makeRoomHarness();
    const pattern = [54_321, 54_322];

    expect(h.registry.routeHaptic(h.code, 1, pattern)).toBe(1);
    expect(hapticFrames(h.controllers[0]!)).toEqual([pattern]);

    const room = h.registry.getRoom(h.code);
    if (room === undefined) {
      throw new Error("room fixture disappeared");
    }
    expect(containsNumber(room, 54_321)).toBe(false);
    expect(containsNumber(room, 54_322)).toBe(false);
    expect(JSON.stringify(h.calls)).not.toContain("54321");
    expect(JSON.stringify(h.calls)).not.toContain("54322");
  });

  test("[FR-7.9] an unknown room is ignored", () => {
    const h = makeRoomHarness();
    expect(h.registry.routeHaptic("!!!!", 1, [10])).toBe(0);
  });
});

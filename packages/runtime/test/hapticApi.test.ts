/**
 * D6-RT-01: HapticCmd encoding and the host-side 20 Hz per-target limiter.
 */
import { decodeHapticCmd } from "@lanpad/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { HapticApi, HAPTIC_MIN_INTERVAL_MS } from "../src/game/HapticApi.js";

describe("[FR-8.11] D6-RT-01 HapticApi", () => {
  let nowMs = 0;

  beforeEach(() => {
    nowMs = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("[FR-8.11] pulses one slot immediately with an encoded HapticCmd", () => {
    const frames: Uint8Array[] = [];
    const api = new HapticApi({ send: (frame) => frames.push(frame), now: () => nowMs });

    api.pulse(2, [30, 20]);

    expect(frames).toHaveLength(1);
    expect(decodeHapticCmd(frames[0]!)).toEqual({ slot: 2, durationsMs: [30, 20] });
    expect(api.stats.sent).toBe(1);
  });

  test('"all" uses slot 0', () => {
    const frames: Uint8Array[] = [];
    const api = new HapticApi({ send: (frame) => frames.push(frame), now: () => nowMs });

    api.pulse("all", [15]);

    expect(decodeHapticCmd(frames[0]!)).toEqual({ slot: 0, durationsMs: [15] });
  });

  test("[FR-8.11] pulses inside 50 ms coalesce to the newest pattern", () => {
    const frames: Uint8Array[] = [];
    const api = new HapticApi({ send: (frame) => frames.push(frame), now: () => nowMs });

    api.pulse(1, [10]);
    api.pulse(1, [20]);
    api.pulse(1, [30]);
    expect(frames).toHaveLength(1);
    expect(api.stats.pending).toBe(1);

    nowMs = HAPTIC_MIN_INTERVAL_MS;
    vi.advanceTimersByTime(HAPTIC_MIN_INTERVAL_MS);

    expect(frames).toHaveLength(2);
    expect(decodeHapticCmd(frames[1]!)).toEqual({ slot: 1, durationsMs: [30] });
    expect(api.stats.coalesced).toBe(1);
    expect(api.stats.pending).toBe(0);
  });

  test("[FR-8.11] each target has its own window", () => {
    const frames: Uint8Array[] = [];
    const api = new HapticApi({ send: (frame) => frames.push(frame), now: () => nowMs });

    api.pulse(1, [10]);
    api.pulse(2, [10]);
    api.pulse("all", [10]);

    expect(frames).toHaveLength(3);
    expect(frames.map((frame) => decodeHapticCmd(frame).slot)).toEqual([1, 2, 0]);
  });

  test("invalid targets and patterns throw to the game", () => {
    const api = new HapticApi({ send: () => {}, now: () => nowMs });

    expect(() => api.pulse(0, [10])).toThrow(RangeError);
    expect(() => api.pulse(9, [10])).toThrow(RangeError);
    expect(() => api.pulse(1, [])).toThrow(RangeError);
    expect(() => api.pulse(1, [10, 10, 10, 10, 10, 10, 10, 10, 10])).toThrow(RangeError);
    expect(() => api.pulse(1, [-1])).toThrow(RangeError);
    expect(() => api.pulse(1, [65_536])).toThrow(RangeError);
    expect(api.stats.sent).toBe(0);
  });

  test("a closed socket is counted, not thrown into the tick", () => {
    const api = new HapticApi({
      send: () => {
        throw new Error("socket closed");
      },
      now: () => nowMs,
    });

    expect(() => api.pulse(1, [10])).not.toThrow();
    expect(api.stats.dropped).toBe(1);
    expect(api.stats.sent).toBe(0);
  });

  test("dispose drops pending timers", () => {
    const frames: Uint8Array[] = [];
    const api = new HapticApi({ send: (frame) => frames.push(frame), now: () => nowMs });
    api.pulse(1, [10]);
    api.pulse(1, [20]);
    api.dispose();

    vi.advanceTimersByTime(HAPTIC_MIN_INTERVAL_MS);

    expect(frames).toHaveLength(1);
    expect(api.stats.pending).toBe(0);
  });
});

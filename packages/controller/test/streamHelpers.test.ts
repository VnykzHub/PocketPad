/**
 * Stream E reusable controller helpers: gyro steering mapping, tap-to-beat
 * calibration and shared haptic patterns.
 *
 * These modules are pure (no sensors, DOM or timers), so the tests pin the
 * documented mapping and limits directly. The layout recipes callers copy are
 * covered by `layoutFixtures.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  STEER_DEADZONE_DPS,
  STEER_FULL_SCALE_DPS,
  steerAxisFromRate,
  steerAxisFromWire,
  wireRateToDps,
} from "../src/sensors/steering.js";
import {
  TAP_MAX_SAMPLES,
  TapTempoTracker,
  estimateTapTempo,
} from "../src/controls/tapTempo.js";
import {
  HAPTIC_EVENT_NAMES,
  HAPTIC_PATTERNS,
  hapticPatternFor,
  isHapticEventName,
} from "../src/haptics/patterns.js";

describe("[FR-8.5][FR-8.10] gyro steering mapping", () => {
  it("[FR-8.5] converts wire units (dps x10) back to degrees per second", () => {
    expect(wireRateToDps(200)).toBeCloseTo(20);
    expect(wireRateToDps(-35)).toBeCloseTo(-3.5);
    expect(wireRateToDps(0)).toBe(0);
  });

  it("[FR-8.5] maps deadzone, linear mid-range and full lock", () => {
    expect(steerAxisFromRate(0)).toBe(0);
    expect(steerAxisFromRate(STEER_DEADZONE_DPS)).toBe(0);
    expect(steerAxisFromRate(-STEER_DEADZONE_DPS)).toBe(0);
    expect(steerAxisFromRate(46)).toBeCloseTo(0.5);
    expect(steerAxisFromRate(STEER_FULL_SCALE_DPS)).toBe(1);
    expect(steerAxisFromRate(180)).toBe(1);
    expect(steerAxisFromRate(-180)).toBe(-1);
  });

  it("[FR-8.5] wire helper matches the dps helper and tolerates bad input", () => {
    expect(steerAxisFromWire(460)).toBeCloseTo(0.5);
    expect(steerAxisFromWire(0)).toBe(0);
    expect(steerAxisFromWire(Number.NaN)).toBe(0);
    expect(steerAxisFromWire(Number.POSITIVE_INFINITY)).toBe(0);
    expect(steerAxisFromRate(Number.NaN)).toBe(0);
  });

  it("[FR-8.10] supports invert and keeps output bounded for bad options", () => {
    expect(steerAxisFromWire(460, { invert: true })).toBeCloseTo(-0.5);
    expect(steerAxisFromRate(50, { deadzoneDps: 10, fullScaleDps: 5 })).toBeCloseTo(0.5);
    expect(steerAxisFromRate(50, { deadzoneDps: -4 })).toBeLessThanOrEqual(1);
    expect(steerAxisFromRate(-50, { deadzoneDps: Number.NaN })).toBeGreaterThanOrEqual(-1);
  });
});

describe("[GAME-BT-TEST-01] tap-to-beat calibration", () => {
  it("[GAME-BT-TEST-01] estimates 120 bpm from even taps", () => {
    const estimate = estimateTapTempo([0, 500, 1000, 1500]);

    expect(estimate).not.toBeNull();
    expect(estimate?.intervalMs).toBe(500);
    expect(estimate?.bpm).toBeCloseTo(120);
    expect(estimate?.taps).toBe(4);
    expect(estimate?.spreadMs).toBe(0);
    expect(estimate?.confidence).toBe(1);
  });

  it("[GAME-BT-TEST-01] ignores double taps without losing the beat", () => {
    const estimate = estimateTapTempo([0, 500, 520, 1000, 1500]);

    expect(estimate?.intervalMs).toBe(500);
    expect(estimate?.bpm).toBeCloseTo(120);
    expect(estimate?.confidence).toBe(1);
  });

  it("[GAME-BT-TEST-01] starts a new attempt after a pause longer than 2 s", () => {
    const tracker = new TapTempoTracker();

    expect(tracker.tap(0)).toBeNull();
    expect(tracker.tap(500)).not.toBeNull();
    expect(tracker.tap(3_200)).toBeNull();
    expect(tracker.tapCount).toBe(1);
  });

  it("[GAME-BT-TEST-01] ignores non-finite and out-of-order timestamps", () => {
    const estimate = estimateTapTempo([0, Number.NaN, 500, 400, 1000]);

    expect(estimate?.intervalMs).toBe(500);
    expect(estimate?.taps).toBe(3);
  });

  it("[GAME-BT-TEST-01] reports lower confidence for uneven taps and honours minTaps", () => {
    const uneven = estimateTapTempo([0, 400, 1000]);

    expect(uneven?.intervalMs).toBe(500);
    expect(uneven?.spreadMs).toBe(100);
    expect(uneven?.confidence).toBeCloseTo(0.8);
    expect(estimateTapTempo([0, 500], { minTaps: 3 })).toBeNull();
  });

  it("[GAME-BT-TEST-01] keeps only the most recent taps and resets on demand", () => {
    const taps = Array.from({ length: TAP_MAX_SAMPLES + 2 }, (_, index) => index * 500);
    const estimate = estimateTapTempo(taps);
    expect(estimate?.taps).toBe(TAP_MAX_SAMPLES);

    const tracker = new TapTempoTracker();
    tracker.tap(0);
    tracker.tap(500);
    tracker.reset();
    expect(tracker.tapCount).toBe(0);
    expect(tracker.estimate).toBeNull();
  });
});

describe("[FR-8.11] shared haptic patterns", () => {
  it("[FR-8.11] every named pattern fits one haptic frame", () => {
    for (const name of HAPTIC_EVENT_NAMES) {
      const pattern = HAPTIC_PATTERNS[name];
      expect(pattern.length).toBeGreaterThanOrEqual(1);
      expect(pattern.length).toBeLessThanOrEqual(8);
      for (const step of pattern) {
        expect(Number.isInteger(step)).toBe(true);
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThanOrEqual(65_535);
      }
    }
  });

  it("[FR-8.11] resolves known events to copies and unknown events to null", () => {
    expect(hapticPatternFor("hit")).toEqual([30]);
    expect(hapticPatternFor("countdown")).toEqual([30, 110, 30, 110, 70]);
    expect(isHapticEventName("select")).toBe(true);
    expect(isHapticEventName("Select")).toBe(false);
    expect(hapticPatternFor("no-such-event")).toBeNull();

    const copy = hapticPatternFor("hit");
    copy?.push(999);
    expect(HAPTIC_PATTERNS.hit).toEqual([30]);
  });
});

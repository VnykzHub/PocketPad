/**
 * D6-CTRL-02 sensor tests: screen-axis remap, one-pole smoothing, auto-zero
 * calibration, wire encoding and stop/null-rate behavior.
 *
 * All inputs are synthetic (`{alpha,beta,gamma}` in degrees/second and a fake
 * millisecond clock); no browser API, timer or DOM is involved.
 */
import { describe, expect, it } from "vitest";
import { AxisCalibration } from "../src/sensors/calibration.js";
import {
  DEFAULT_SMOOTHING,
  MAX_SMOOTHING,
  MIN_SMOOTHING,
  OnePoleLowPass,
  clampSmoothing,
} from "../src/sensors/lowPass.js";
import {
  normalizeScreenAngle,
  remapRotationRate,
  type RotationRate,
} from "../src/sensors/remap.js";
import {
  MotionSource,
  clampSensitivity,
  type DeviceRotationRateEvent,
} from "../src/sensors/MotionSource.js";

class FakeMotionTarget {
  readonly listeners = new Set<(event: DeviceRotationRateEvent) => void>();

  addEventListener(
    _type: "devicemotion",
    callback: (event: DeviceRotationRateEvent) => void,
  ): void {
    this.listeners.add(callback);
  }

  removeEventListener(
    _type: "devicemotion",
    callback: (event: DeviceRotationRateEvent) => void,
  ): void {
    this.listeners.delete(callback);
  }

  emit(rotationRate: RotationRate | null): void {
    for (const listener of [...this.listeners]) {
      listener({ rotationRate });
    }
  }
}

function harness(): {
  target: FakeMotionTarget;
  source: MotionSource;
  setNow: (value: number) => void;
  setAngle: (value: number) => void;
} {
  const target = new FakeMotionTarget();
  let now = 0;
  let angle = 0;
  const source = new MotionSource({
    addEventListener: (type, callback) => target.addEventListener(type, callback),
    removeEventListener: (type, callback) => target.removeEventListener(type, callback),
    getScreenAngle: () => angle,
    now: () => now,
  });
  return {
    target,
    source,
    setNow: (value) => {
      now = value;
    },
    setAngle: (value) => {
      angle = value;
    },
  };
}

const ZERO_RATE: RotationRate = { alpha: 0, beta: 0, gamma: 0 };

describe("[E7] remap", () => {
  it("[E7] rotates beta/gamma into screen axes at 0/90/180/270 degrees", () => {
    const rate: RotationRate = { alpha: 10, beta: 20, gamma: 30 };

    expect(remapRotationRate(rate, 0)).toEqual({ x: 30, y: 20, z: 10 });

    const right = remapRotationRate(rate, 90);
    expect(right.x).toBeCloseTo(20, 10);
    expect(right.y).toBeCloseTo(-30, 10);
    expect(right.z).toBe(10);

    const reversed = remapRotationRate(rate, 180);
    expect(reversed.x).toBeCloseTo(-30, 10);
    expect(reversed.y).toBeCloseTo(-20, 10);

    const left = remapRotationRate(rate, 270);
    expect(left.x).toBeCloseTo(-20, 10);
    expect(left.y).toBeCloseTo(30, 10);
  });

  it("[E7] wraps angles and treats null/non-finite components as zero", () => {
    expect(normalizeScreenAngle(370)).toBe(10);
    expect(normalizeScreenAngle(-90)).toBe(270);
    expect(normalizeScreenAngle(Number.NaN)).toBe(0);
    expect(remapRotationRate(rate360(), 360)).toEqual(remapRotationRate(rate360(), 0));
    expect(remapRotationRate({ alpha: null, beta: null, gamma: null }, 90)).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
    expect(remapRotationRate(null, 90)).toEqual({ x: 0, y: 0, z: 0 });
    expect(
      remapRotationRate({ alpha: Number.NaN, beta: 20, gamma: 30 }, 0),
    ).toEqual({ x: 30, y: 20, z: 0 });
  });
});

function rate360(): RotationRate {
  return { alpha: 1, beta: 2, gamma: 3 };
}

describe("[FR-8.5] one-pole low pass", () => {
  it("[FR-8.5] defaults to alpha 0.15 and clamps the documented range", () => {
    expect(DEFAULT_SMOOTHING).toBe(0.15);
    expect(clampSmoothing(undefined)).toBe(DEFAULT_SMOOTHING);
    expect(clampSmoothing(Number.NaN)).toBe(DEFAULT_SMOOTHING);
    expect(clampSmoothing(0)).toBe(MIN_SMOOTHING);
    expect(clampSmoothing(5)).toBe(MAX_SMOOTHING);
  });

  it("[FR-8.5] applies y = alpha*x + (1-alpha)*y per sample", () => {
    const filter = new OnePoleLowPass();
    expect(filter.alpha).toBe(0.15);
    expect(filter.process(100)).toBeCloseTo(15, 10);
    expect(filter.process(100)).toBeCloseTo(27.75, 10);

    filter.setSmoothing(1);
    expect(filter.process(100)).toBeCloseTo(100, 10);

    filter.reset(50);
    expect(filter.value).toBe(50);
    expect(filter.process(Number.NaN)).toBe(50);
  });
});

describe("auto-zero calibration", () => {
  it("averages only samples inside the 500 ms window and excludes the closer", () => {
    const calibration = new AxisCalibration(500);
    calibration.begin(0);
    expect(calibration.isCalibrating).toBe(true);

    expect(calibration.addSample({ x: 10, y: 1, z: -1 }, 0)).toBe(false);
    expect(calibration.addSample({ x: 20, y: 3, z: -3 }, 100)).toBe(false);
    expect(calibration.addSample({ x: 999, y: 999, z: 999 }, 500)).toBe(true);

    expect(calibration.isCalibrating).toBe(false);
    expect(calibration.sampleCount).toBe(2);
    expect(calibration.bias).toEqual({ x: 15, y: 2, z: -2 });
    expect(calibration.apply({ x: 25, y: 2, z: 0 })).toEqual({ x: 10, y: 0, z: 2 });
  });

  it("leaves bias at zero when the window had no samples and clears on begin", () => {
    const calibration = new AxisCalibration(500);
    calibration.begin(0);
    expect(calibration.addSample({ x: 99, y: 99, z: 99 }, 600)).toBe(true);
    expect(calibration.bias).toEqual({ x: 0, y: 0, z: 0 });

    calibration.begin(700);
    expect(calibration.bias).toEqual({ x: 0, y: 0, z: 0 });
    calibration.reset();
    expect(calibration.isCalibrating).toBe(false);
  });
});

describe("[FR-7.5][FR-7.6] MotionSource", () => {
  it("holds zero while calibrating, then subtracts the measured bias", () => {
    const h = harness();
    h.source.start({ smoothing: 1 });

    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    expect(h.source.isCalibrating).toBe(true);
    expect(h.source.latest).toEqual({
      gx: 0,
      gy: 0,
      gz: 0,
      active: true,
      recentered: false,
    });

    h.setNow(600);
    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    expect(h.source.isCalibrating).toBe(false);
    // The still-phone bias (20 dps) was learned during the window.
    expect(h.source.latest.gy).toBe(0);
    expect(h.source.bias.y).toBe(20);
  });

  it("[FR-7.5] encodes calibrated degrees/second x10 into i16 fields", () => {
    const h = harness();
    h.source.start({ smoothing: 1, sensitivity: 1 });
    h.target.emit(ZERO_RATE);
    h.setNow(600);
    h.target.emit(ZERO_RATE); // closes the window with zero bias

    h.target.emit({ alpha: 0, beta: 20, gamma: -3 });
    expect(h.source.latest.gy).toBe(200);
    // The frozen remap is x = gamma, y = beta, z = alpha.
    expect(h.source.latest.gx).toBe(-30);
    expect(h.source.latest.gz).toBe(0);
    expect(h.source.latest.active).toBe(true);
  });

  it("applies screen angle and sensitivity before encoding", () => {
    const h = harness();
    h.source.start({ smoothing: 1, sensitivity: 2 });
    h.target.emit(ZERO_RATE);
    h.setNow(600);
    h.target.emit(ZERO_RATE);

    h.setNow(601);
    h.setAngle(90);
    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    expect(h.source.latest.gx).toBe(400);
    expect(h.source.latest.gy).toBe(0);
  });

  it("[FR-7.5] clamps sensitivity to 0.5..3 and wire values to i16", () => {
    expect(clampSensitivity(undefined)).toBe(1);
    expect(clampSensitivity(Number.NaN)).toBe(1);
    expect(clampSensitivity(0.1)).toBe(0.5);
    expect(clampSensitivity(9)).toBe(3);

    const h = harness();
    h.source.start({ smoothing: 1, sensitivity: 3 });
    h.target.emit(ZERO_RATE);
    h.setNow(600);
    h.target.emit(ZERO_RATE);

    h.target.emit({ alpha: 10_000, beta: -10_000, gamma: 10_000 });
    expect(h.source.latest.gx).toBe(32767);
    expect(h.source.latest.gy).toBe(-32768);
    expect(h.source.latest.gz).toBe(32767);
  });

  it("[FR-8.5] matches the one-pole smoothing configured at start", () => {
    const h = harness();
    h.source.start({ smoothing: 0.5 });
    h.target.emit(ZERO_RATE);
    h.setNow(600);
    h.target.emit(ZERO_RATE);

    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    expect(h.source.latest.gy).toBe(100);
    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    expect(h.source.latest.gy).toBe(150);
  });

  it("[FR-7.6] reports a null rotationRate as an inactive zero sample", () => {
    const h = harness();
    let events = 0;
    h.source.onEvent = () => {
      events += 1;
    };
    h.source.start({ smoothing: 1 });

    h.target.emit(null);
    expect(h.source.latest.active).toBe(false);
    expect(h.source.latest.gx).toBe(0);
    expect(h.source.latest.gy).toBe(0);
    expect(h.source.latest.gz).toBe(0);
    expect(events).toBe(0);

    h.target.emit(ZERO_RATE);
    expect(events).toBe(1);
    expect(h.source.latest.active).toBe(true);
  });

  it("[FR-7.6] recalibrates by zeroing output and exposing the one-shot flag", () => {
    const h = harness();
    h.source.start({ smoothing: 1 });
    h.target.emit(ZERO_RATE);
    h.setNow(600);
    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });

    h.source.recalibrate();
    expect(h.source.latest.recentered).toBe(true);
    expect(h.source.latest.gy).toBe(0);
    expect(h.source.isCalibrating).toBe(true);
    expect(h.source.consumeRecentered()).toBe(true);
    expect(h.source.consumeRecentered()).toBe(false);
    expect(h.source.latest.recentered).toBe(false);

    h.setNow(1200);
    h.target.emit(ZERO_RATE);
    expect(h.source.isCalibrating).toBe(false);
  });

  it("[FR-8.10] stops cleanly, removes its listener and resets the sample", () => {
    const h = harness();
    h.source.start({ smoothing: 1 });
    h.target.emit({ alpha: 0, beta: 20, gamma: 0 });
    expect(h.target.listeners.size).toBe(1);

    h.source.stop();
    expect(h.source.isStarted).toBe(false);
    expect(h.target.listeners.size).toBe(0);
    expect(h.source.latest).toEqual({
      gx: 0,
      gy: 0,
      gz: 0,
      active: false,
      recentered: false,
    });

    h.target.emit(ZERO_RATE);
    expect(h.source.latest.active).toBe(false);
  });

  it("is idempotent on repeated start calls", () => {
    const h = harness();
    h.source.start({ smoothing: 0.5 });
    h.source.start({ smoothing: 1 });
    expect(h.source.isStarted).toBe(true);
    expect(h.target.listeners.size).toBe(1);
  });
});

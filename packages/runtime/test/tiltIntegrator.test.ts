/**
 * D6-RT-01: fixed-step tilt integration, clamp, drift/decay and recenter.
 */
import { describe, expect, test } from "vitest";
import {
  TILT_MAX_ANGLE_DEG,
  TiltIntegrator,
  type TiltInput,
} from "../src/input/TiltIntegrator.js";

function input(
  x: number,
  y: number,
  active = true,
  recentered = false,
): TiltInput {
  return {
    gyro: { x, y, z: 0 },
    gyroActive: active,
    gyroRecentered: recentered,
  };
}

const DT = 1 / 60;

describe("[FR-7.5][FR-7.6][FR-8.5] D6-RT-01 TiltIntegrator", () => {
  test("[FR-7.5] integrates angular rate with the fixed timestep", () => {
    const tilt = new TiltIntegrator();

    tilt.update(input(90, -30), DT);

    expect(tilt.state.available).toBe(true);
    expect(tilt.state.angleX).toBeCloseTo(90 * DT, 6);
    expect(tilt.state.angleY).toBeCloseTo(-30 * DT, 6);
  });

  test("clamps both angles to ±30° by default", () => {
    const tilt = new TiltIntegrator();

    for (let step = 0; step < 120; step += 1) {
      tilt.update(input(300, -300), DT);
    }

    expect(tilt.state.angleX).toBe(TILT_MAX_ANGLE_DEG);
    expect(tilt.state.angleY).toBe(-TILT_MAX_ANGLE_DEG);
  });

  test("clamp is configurable", () => {
    const tilt = new TiltIntegrator({ maxAngleDeg: 5 });
    for (let step = 0; step < 60; step += 1) {
      tilt.update(input(100, 100), DT);
    }
    expect(tilt.state.angleX).toBe(5);
    expect(tilt.state.angleY).toBe(5);
  });

  test("near-zero rate drifts back toward zero", () => {
    const tilt = new TiltIntegrator();
    tilt.update(input(60, 0), DT);
    const held = tilt.state.angleX;
    expect(held).toBeGreaterThan(0);

    tilt.update(input(0, 0), DT);

    expect(tilt.state.angleX).toBeGreaterThan(0);
    expect(tilt.state.angleX).toBeLessThan(held);
  });

  test("[FR-7.6] inactive motion decays the angle and reports unavailable", () => {
    const tilt = new TiltIntegrator();
    for (let step = 0; step < 30; step += 1) {
      tilt.update(input(60, 0), DT);
    }
    const held = tilt.state.angleX;

    tilt.update(input(0, 0, false), DT);

    expect(tilt.state.available).toBe(false);
    expect(tilt.state.angleX).toBeCloseTo(held - 20 * DT, 6);
  });

  test("[FR-7.6] gyroRecentered resets both angles on that tick", () => {
    const tilt = new TiltIntegrator();
    for (let step = 0; step < 10; step += 1) {
      tilt.update(input(60, 60), DT);
    }
    expect(tilt.state.angleX).toBeGreaterThan(0);

    tilt.update(input(60, 0, true, true), DT);

    expect(tilt.state.angleX).toBeCloseTo(60 * DT, 6);
    expect(tilt.state.angleY).toBeCloseTo(0, 6);
  });

  test("[FR-8.5] smoothing and sensitivity scale the integrated rate", () => {
    const smoothed = new TiltIntegrator({ smoothing: 0.5, sensitivity: 2 });
    smoothed.update(input(90, 0), DT);
    expect(smoothed.state.angleX).toBeCloseTo(90 * 0.5 * 2 * DT, 6);

    const sensitive = new TiltIntegrator({ sensitivity: 0.5 });
    sensitive.update(input(90, 0), DT);
    expect(sensitive.state.angleX).toBeCloseTo(90 * 0.5 * DT, 6);
  });

  test("non-positive timesteps are ignored", () => {
    const tilt = new TiltIntegrator();
    tilt.update(input(90, 90), 0);
    tilt.update(input(90, 90), Number.NaN);
    expect(tilt.state.angleX).toBe(0);
    expect(tilt.state.available).toBe(false);
  });

  test("reset returns to the initial state and the state object is pooled", () => {
    const tilt = new TiltIntegrator();
    const state = tilt.state;
    tilt.update(input(90, 90), DT);
    expect(tilt.state).toBe(state);

    tilt.reset();

    expect(state.angleX).toBe(0);
    expect(state.angleY).toBe(0);
    expect(state.available).toBe(false);
  });

  test("invalid options throw", () => {
    expect(() => new TiltIntegrator({ maxAngleDeg: -1 })).toThrow(RangeError);
    expect(() => new TiltIntegrator({ smoothing: 2 })).toThrow(RangeError);
  });
});

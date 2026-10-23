import { describe, expect, test } from "vitest";
import type { GameControllerState } from "@lanpad/sdk";
import { createFakePlayer } from "@lanpad/sdk/testing";
import { TILT_MAZE_CONFIG } from "../src/config.js";
import {
  createAcceleration,
  resetAcceleration,
  resolveAcceleration,
  stickIsActive,
  writeStickAcceleration,
  writeTiltAcceleration,
  type Acceleration,
} from "../src/tilt.js";

/**
 * Tilt-to-acceleration mapping (GAME-TM-HOST-02, GAME-TM-CTRL-02; FR-7.6,
 * FR-8.10, C6, G5).
 *
 * The host integrates controller rates into `player.tilt` (degrees, already
 * clamped). This module only maps degrees to acceleration with y-down screen
 * axes, and lets the stick take over past the layout's 8% deadzone. The same
 * output buffer is reused per tick, so tests assert its contents, not identity.
 */

function player(overrides: Partial<GameControllerState> = {}): GameControllerState {
  return createFakePlayer(1, overrides);
}

function tilt(angleX: number, angleY: number, available = true) {
  return { angleX, angleY, available };
}

function resolved(input: GameControllerState): Acceleration {
  const out = createAcceleration();
  resolveAcceleration(input, TILT_MAZE_CONFIG, out);
  return out;
}

const FULL_TILT_ACCEL = Math.sin((30 * Math.PI) / 180) * TILT_MAZE_CONFIG.accelScale;

describe("tilt mapping", () => {
  test("[FR-7.6][C6][G5] rolling right accelerates +x; tilting forward accelerates up-screen", () => {
    const out = createAcceleration();

    writeTiltAcceleration(tilt(30, 0), false, TILT_MAZE_CONFIG, out);
    expect(out.ax).toBeCloseTo(FULL_TILT_ACCEL, 6);
    expect(out.ay).toBeCloseTo(0, 6);
    expect(out.source).toBe("tilt");

    writeTiltAcceleration(tilt(0, 30), false, TILT_MAZE_CONFIG, out);
    expect(out.ax).toBeCloseTo(0, 6);
    expect(out.ay).toBeCloseTo(-FULL_TILT_ACCEL, 6);
    expect(out.source).toBe("tilt");
  });

  test("[FR-7.6][C6] negative roll and tilt flip both axes", () => {
    const out = createAcceleration();

    writeTiltAcceleration(tilt(-30, 0), false, TILT_MAZE_CONFIG, out);
    expect(out.ax).toBeCloseTo(-FULL_TILT_ACCEL, 6);

    writeTiltAcceleration(tilt(0, -30), false, TILT_MAZE_CONFIG, out);
    expect(out.ay).toBeCloseTo(FULL_TILT_ACCEL, 6);
  });

  test("[FR-7.6] hand-built angles are defensively clamped to the configured limit", () => {
    const out = createAcceleration();

    writeTiltAcceleration(tilt(90, -90), false, TILT_MAZE_CONFIG, out);
    expect(out.ax).toBeCloseTo(FULL_TILT_ACCEL, 6);
    expect(out.ay).toBeCloseTo(FULL_TILT_ACCEL, 6);

    const narrow = { ...TILT_MAZE_CONFIG, recenterClampDeg: 10 };
    writeTiltAcceleration(tilt(45, 0), false, narrow, out);
    expect(out.ax).toBeCloseTo(Math.sin((10 * Math.PI) / 180) * narrow.accelScale, 6);
  });

  test("[FR-7.6] non-finite angles read as level instead of propagating NaN", () => {
    const out = createAcceleration();
    writeTiltAcceleration(
      tilt(Number.NaN, Number.POSITIVE_INFINITY),
      false,
      TILT_MAZE_CONFIG,
      out,
    );
    expect(out.ax).toBe(0);
    expect(out.ay).toBeCloseTo(0, 12);
    expect(out.source).toBe("tilt");
  });
});

describe("stick fallback", () => {
  test("[FR-8.10][C6] stick axes map directly and clamp to the unit square", () => {
    const out = createAcceleration();

    writeStickAcceleration(0.5, -0.25, TILT_MAZE_CONFIG, out);
    expect(out.ax).toBeCloseTo(TILT_MAZE_CONFIG.accelScale * 0.5, 9);
    expect(out.ay).toBeCloseTo(TILT_MAZE_CONFIG.accelScale * -0.25, 9);
    expect(out.source).toBe("stick");

    writeStickAcceleration(2, -3, TILT_MAZE_CONFIG, out);
    expect(out.ax).toBe(TILT_MAZE_CONFIG.accelScale);
    expect(out.ay).toBe(-TILT_MAZE_CONFIG.accelScale);
  });

  test("[FR-8.10] a half stick matches a 30 degree tilt through the same accel scale", () => {
    const tiltOut = createAcceleration();
    const stickOut = createAcceleration();
    writeTiltAcceleration(tilt(30, 30), false, TILT_MAZE_CONFIG, tiltOut);
    writeStickAcceleration(0.5, -0.5, TILT_MAZE_CONFIG, stickOut);
    expect(stickOut.ax).toBeCloseTo(tiltOut.ax, 9);
    expect(stickOut.ay).toBeCloseTo(tiltOut.ay, 9);
  });

  test("[FR-8.10] the stick wins over active tilt once past the 8% deadzone", () => {
    const active = resolved(player({ lx: 0.5, ly: 0, tilt: tilt(20, 0) }));
    expect(active.source).toBe("stick");
    expect(active.ax).toBeCloseTo(450, 9);

    const atDeadzone = resolved(player({ lx: 0.08, ly: 0, tilt: tilt(20, 0) }));
    expect(atDeadzone.source).toBe("tilt");
    expect(atDeadzone.ax).toBeCloseTo(
      Math.sin((20 * Math.PI) / 180) * TILT_MAZE_CONFIG.accelScale,
      9,
    );

    const pastDeadzone = resolved(player({ lx: 0.09, ly: 0, tilt: tilt(20, 0) }));
    expect(pastDeadzone.source).toBe("stick");
    expect(pastDeadzone.ax).toBeCloseTo(TILT_MAZE_CONFIG.accelScale * 0.09, 9);
  });

  test("[FR-8.10] stick activity is magnitude-based across both axes", () => {
    expect(stickIsActive(0.08, 0)).toBe(false);
    expect(stickIsActive(0.09, 0)).toBe(true);
    expect(stickIsActive(0, -0.09)).toBe(true);
    expect(stickIsActive(-0.06, -0.06)).toBe(true);
    expect(stickIsActive(0.05, 0.05)).toBe(false);
  });
});

describe("acceleration source selection", () => {
  test("[FR-8.10][C6] unavailable or freshly recentered tilt produces no acceleration", () => {
    expect(resolved(player({ tilt: tilt(30, 30, false) })).source).toBe("none");
    const recentered = resolved(player({ tilt: tilt(30, 30), gyroRecentered: true }));
    expect(recentered.source).toBe("none");
    expect(recentered.ax).toBe(0);
    expect(recentered.ay).toBe(0);
  });

  test("[FR-8.10] a disconnected controller produces no acceleration", () => {
    const out = resolved(player({ connected: false, lx: 1, ly: 1, tilt: tilt(30, 30) }));
    expect(out.source).toBe("none");
    expect(out.ax).toBe(0);
    expect(out.ay).toBe(0);
  });

  test("[FR-8.10] missing or non-finite tilt falls back to nothing, never NaN", () => {
    expect(resolved(player()).source).toBe("none");
    expect(resolved(player({ tilt: tilt(Number.NaN, 0) })).ax).toBe(0);
    expect(stickIsActive(Number.NaN, 0)).toBe(false);
    expect(stickIsActive(0.5, Number.POSITIVE_INFINITY)).toBe(false);
  });

  test("[FR-8.10] non-finite stick values read as zero when the stick path is taken", () => {
    const out = createAcceleration();
    writeStickAcceleration(Number.NaN, Number.POSITIVE_INFINITY, TILT_MAZE_CONFIG, out);
    expect(out.ax).toBe(0);
    expect(out.ay).toBe(0);
    expect(out.source).toBe("stick");
  });

  test("[C6] resetAcceleration clears every field of a reused buffer", () => {
    const out = createAcceleration();
    writeTiltAcceleration(tilt(30, 30), false, TILT_MAZE_CONFIG, out);
    resetAcceleration(out);
    expect(out.ax).toBe(0);
    expect(out.ay).toBe(0);
    expect(out.source).toBe("none");
  });
});

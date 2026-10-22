import { describe, expect, test } from "vitest";
import {
  CAMERA_DEADZONE,
  CAMERA_FALLBACK_ASPECT,
  CAMERA_SMOOTHING,
  CAMERA_VIEW_HEIGHT,
  cameraLeft,
  cameraRight,
  createCamera,
  isHorizontallyVisible,
  resizeCamera,
  updateCamera,
  viewWidthForAspect,
  worldToScreen,
  type CameraTarget,
} from "../src/camera.js";

/**
 * Camera contract (GAME-PF-05; FR-9.4, PR-9.1, PR-9.3).
 *
 * The camera is pure data: fixed 18-unit vertical view, aspect-derived
 * horizontal width, mean-follow with a 2-unit deadzone, exponential
 * smoothing and clamping to the level bounds. No test reads a pixel or DPR.
 */

const LEVEL_WIDTH = 120;

function target(x: number, active = true, connected = true): CameraTarget {
  return { x, active, connected };
}

/** Runs `ticks` fixed 1/60 s steps; keeps each test's intent local. */
function step(
  camera: ReturnType<typeof createCamera>,
  players: ReadonlyArray<CameraTarget>,
  ticks = 1,
): void {
  for (let index = 0; index < ticks; index += 1) {
    updateCamera(camera, 1 / 60, players, players.length);
  }
}

describe("Coin Run camera", () => {
  test("[FR-9.4] the vertical view is fixed and the horizontal view follows the surface aspect", () => {
    expect(CAMERA_VIEW_HEIGHT).toBe(18);
    expect(viewWidthForAspect(16 / 9)).toBeCloseTo(32, 10);
    expect(viewWidthForAspect(4 / 3)).toBeCloseTo(24, 10);
    const wide = createCamera(LEVEL_WIDTH, 16 / 9);
    const narrow = createCamera(LEVEL_WIDTH, 4 / 3);
    expect(wide.viewHeight).toBe(18);
    expect(wide.viewWidth).toBeCloseTo(32, 10);
    expect(narrow.viewWidth).toBeCloseTo(24, 10);
  });

  test("[FR-9.4] the first update snaps to the mean of active players", () => {
    const camera = createCamera(LEVEL_WIDTH, 16 / 9);
    const players = [target(50), target(70), target(500, false), target(600, true, false)];
    step(camera, players);
    expect(camera.initialized).toBe(true);
    expect(camera.x).toBeCloseTo(60, 10);
    expect(camera.targetX).toBeCloseTo(60, 10);
  });

  test("[FR-9.4] the camera clamps to both level edges and never shows outside", () => {
    const left = createCamera(LEVEL_WIDTH, 16 / 9);
    step(left, [target(-20)]);
    expect(left.x).toBeCloseTo(16, 10);
    expect(cameraLeft(left)).toBeCloseTo(0, 10);

    const right = createCamera(LEVEL_WIDTH, 16 / 9);
    step(right, [target(200)]);
    expect(right.x).toBeCloseTo(104, 10);
    expect(cameraRight(right)).toBeCloseTo(120, 10);
  });

  test("[FR-9.4] a level narrower than the view is centred, not scrolled", () => {
    const camera = createCamera(20, 16 / 9);
    step(camera, [target(0)]);
    expect(camera.viewWidth).toBeGreaterThan(20);
    expect(camera.x).toBeCloseTo(10, 10);
    expect(camera.targetX).toBeCloseTo(10, 10);
  });

  test("[FR-9.4] the deadzone ignores movement smaller than two units", () => {
    const camera = createCamera(LEVEL_WIDTH, 16 / 9);
    step(camera, [target(60)]);
    const before = camera.x;
    step(camera, [target(60 + CAMERA_DEADZONE - 0.01)], 10);
    expect(camera.x).toBeCloseTo(before, 10);
    expect(camera.targetX).toBeCloseTo(60, 10);

    step(camera, [target(60 + CAMERA_DEADZONE + 1)], 1);
    expect(camera.targetX).toBeCloseTo(63, 10);
    expect(camera.x).toBeGreaterThan(before);
  });

  test("[FR-9.4] smoothing approaches the target without overshoot", () => {
    const camera = createCamera(LEVEL_WIDTH, 16 / 9);
    step(camera, [target(60)]);
    const start = camera.x;
    step(camera, [target(80)], 1);
    const expected =
      start + (80 - start) * (1 - Math.exp(-CAMERA_SMOOTHING * (1 / 60)));
    expect(camera.x).toBeCloseTo(expected, 10);
    expect(camera.x).toBeLessThan(80);

    step(camera, [target(80)], 600);
    expect(camera.x).toBeCloseTo(80, 4);
  });

  test("[PR-9.3] `updateCamera` allocates nothing and reads no map/filter", () => {
    // The source contract is allocation-free: the array and camera are caller
    // owned, and the loop is a plain for statement. A frozen array proves the
    // function does not sort, splice or replace it.
    const camera = createCamera(LEVEL_WIDTH, 16 / 9);
    const players = Object.freeze([Object.freeze(target(40)), Object.freeze(target(44))]);
    expect(() => step(camera, players, 20)).not.toThrow();
    expect(camera.x).toBeCloseTo(42, 10);
  });

  test("[FR-9.4] resize recomputes the view width and re-clamps the camera", () => {
    const camera = createCamera(LEVEL_WIDTH, 16 / 9);
    step(camera, [target(110)]);
    expect(camera.x).toBeCloseTo(104, 10);

    resizeCamera(camera, 4 / 3);
    expect(camera.viewWidth).toBeCloseTo(24, 10);
    // A narrower view expands the clamp range to [12, 108]; 104 is inside it,
    // so the camera stays put instead of snapping to the new upper bound.
    expect(camera.x).toBeCloseTo(104, 10);

    resizeCamera(camera, 21 / 9);
    expect(camera.viewWidth).toBeCloseTo(42, 10);
    expect(camera.x).toBeLessThanOrEqual(LEVEL_WIDTH - 21);
  });

  test("[FR-9.4] worldToScreen projects with the surface height and reuses its output", () => {
    const camera = createCamera(LEVEL_WIDTH, 16 / 9);
    step(camera, [target(60)]);
    const out = { x: Number.NaN, y: Number.NaN };
    worldToScreen(camera, 60, 9, 720, out);
    expect(out.x).toBeCloseTo(640, 6);
    expect(out.y).toBeCloseTo(360, 6);

    // Same world point on a taller surface scales uniformly; no fixed pixels.
    worldToScreen(camera, 60, 9, 1080, out);
    expect(out.x).toBeCloseTo(960, 6);
    expect(out.y).toBeCloseTo(540, 6);

    const returned = worldToScreen(camera, 44, 0, 720, out);
    expect(returned).toBe(out);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBeCloseTo(0, 6);
  });

  test("[PR-9.5] horizontal culling is inclusive at the view edge", () => {
    const camera = createCamera(LEVEL_WIDTH, 16 / 9);
    step(camera, [target(60)]);
    expect(isHorizontallyVisible(camera, 44, 0)).toBe(true);
    expect(isHorizontallyVisible(camera, 76, 0)).toBe(true);
    expect(isHorizontallyVisible(camera, 43.9, 0)).toBe(false);
    expect(isHorizontallyVisible(camera, 76.1, 0)).toBe(false);
    expect(isHorizontallyVisible(camera, 43.5, 1)).toBe(true);
  });

  test("[FR-9.4] the default aspect is the documented 16:9 host profile", () => {
    const camera = createCamera(LEVEL_WIDTH);
    expect(camera.viewWidth).toBeCloseTo(CAMERA_VIEW_HEIGHT * CAMERA_FALLBACK_ASPECT, 10);
  });
});

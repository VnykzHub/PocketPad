// @req ER-22-01 — pure world decisions are pinned without a GPU.
import { describe, expect, test } from "vitest";
import {
  DEFAULT_WORLD_LIMITS,
  SKY_PRESET_COLORS,
  clampClipSpeed,
  clampFollowOptions,
  clampFov,
  clampLightIntensity,
  clampSegments,
  computeFollowTarget,
  createWorldCapabilities,
  effectiveShadowTier,
  fogRange,
  horizontalForward,
  quaternionForward,
  shadowMapSize,
  smoothingAlpha,
  tierForBackend,
  yawToQuaternion,
} from "../../src/babylon/world3d/worldMath.js";

describe("world tier and capabilities", () => {
  test("[ER-22-01] WebGPU is high, WebGL2 is reduced", () => {
    expect(tierForBackend("webgpu")).toBe("high");
    expect(tierForBackend("webgl2")).toBe("reduced");
  });

  test("[ER-22-01] capability tiers follow the backend and stay honest", () => {
    const high = createWorldCapabilities("webgpu");
    expect(high).toMatchObject({
      backend: "webgpu",
      tier: "high",
      shadows: true,
      post: true,
      animation: true,
      instances: true,
      // Per-instance tint needs a custom shader; never claim it.
      instanceTint: false,
      maxActors: DEFAULT_WORLD_LIMITS.high.maxActors,
      maxInstances: DEFAULT_WORLD_LIMITS.high.maxInstances,
    });

    const reduced = createWorldCapabilities("webgl2");
    expect(reduced).toMatchObject({
      backend: "webgl2",
      tier: "reduced",
      shadows: true,
      post: false,
      maxActors: DEFAULT_WORLD_LIMITS.reduced.maxActors,
      maxInstances: DEFAULT_WORLD_LIMITS.reduced.maxInstances,
    });
  });

  test("[ER-22-01] positive integer overrides win; invalid overrides fall back", () => {
    expect(
      createWorldCapabilities("webgpu", { maxActors: 4, maxInstances: 8 }),
    ).toMatchObject({ maxActors: 4, maxInstances: 8 });
    expect(
      createWorldCapabilities("webgl2", { maxActors: 0, maxInstances: -1 }),
    ).toMatchObject({
      maxActors: DEFAULT_WORLD_LIMITS.reduced.maxActors,
      maxInstances: DEFAULT_WORLD_LIMITS.reduced.maxInstances,
    });
    expect(createWorldCapabilities("webgl2", { post: true }).post).toBe(true);
  });
});

describe("world clamps", () => {
  test("[ER-22-01] clip speed defaults to 1 and clamps to 0..10", () => {
    expect(clampClipSpeed(undefined)).toBe(1);
    expect(clampClipSpeed(Number.NaN)).toBe(1);
    expect(clampClipSpeed(-2)).toBe(1);
    expect(clampClipSpeed(0)).toBe(0);
    expect(clampClipSpeed(5)).toBe(5);
    expect(clampClipSpeed(10.5)).toBe(10);
  });

  test("[ER-22-01] FOV defaults to 60 and clamps to 20..110", () => {
    expect(clampFov(undefined)).toBe(60);
    expect(clampFov(Number.POSITIVE_INFINITY)).toBe(60);
    expect(clampFov(5)).toBe(20);
    expect(clampFov(200)).toBe(110);
    expect(clampFov(90)).toBe(90);
  });

  test("[ER-22-01] light intensity clamps to 0..10", () => {
    expect(clampLightIntensity(Number.NaN)).toBe(0);
    expect(clampLightIntensity(-3)).toBe(0);
    expect(clampLightIntensity(2)).toBe(2);
    expect(clampLightIntensity(100)).toBe(10);
  });

  test("[ER-22-01] primitive segments clamp to 8..64 and default to 16", () => {
    expect(clampSegments(undefined)).toBe(16);
    expect(clampSegments(1)).toBe(8);
    expect(clampSegments(12.9)).toBe(12);
    expect(clampSegments(200)).toBe(64);
  });

  test("[ER-22-01] follow defaults and bounds", () => {
    expect(clampFollowOptions({})).toEqual({
      distance: 8,
      height: 4,
      lookAhead: 2,
      smoothing: 6,
    });
    expect(
      clampFollowOptions({
        distance: -1,
        height: -5,
        lookAhead: 600,
        smoothing: 100,
      }),
    ).toEqual({ distance: 8, height: -5, lookAhead: 500, smoothing: 60 });
  });

  test("[ER-22-01] fog range defaults and keeps near below far", () => {
    expect(fogRange(undefined, undefined)).toEqual({ near: 10, far: 100 });
    expect(fogRange(5, 50)).toEqual({ near: 5, far: 50 });
    expect(fogRange(20, 5)).toEqual({ near: 20, far: 100 });
    expect(fogRange(-4, Number.NaN)).toEqual({ near: 10, far: 100 });
  });
});

describe("world transforms", () => {
  test("[ER-22-01] yaw becomes a Y-only quaternion", () => {
    const out = { x: 1, y: 1, z: 1, w: 1 };
    yawToQuaternion(0, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    yawToQuaternion(Math.PI / 2, out);
    expect(out.x).toBe(0);
    expect(out.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(out.z).toBe(0);
    expect(out.w).toBeCloseTo(Math.SQRT1_2, 12);
    yawToQuaternion(Number.NaN, out);
    expect(out).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  test("[ER-22-01] forward is -Z rotated by the quaternion (right-handed)", () => {
    const out = { x: 9, y: 9, z: 9 };
    quaternionForward(0, 0, 0, 1, out);
    // The w*w term yields -0; compare numerically so the sign does not matter.
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.y).toBeCloseTo(0, 12);
    expect(out.z).toBe(-1);

    const yaw = { x: 0, y: 0, z: 0, w: 1 };
    yawToQuaternion(Math.PI / 2, yaw);
    quaternionForward(yaw.x, yaw.y, yaw.z, yaw.w, out);
    expect(out.x).toBeCloseTo(-1, 12);
    expect(out.y).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(0, 12);

    yawToQuaternion(Math.PI, yaw);
    quaternionForward(yaw.x, yaw.y, yaw.z, yaw.w, out);
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(1, 12);
  });

  test("[ER-22-01] an unusable quaternion falls back to -Z", () => {
    const out = { x: 9, y: 9, z: 9 };
    quaternionForward(0, 0, 0, 0, out);
    expect(out).toEqual({ x: 0, y: 0, z: -1 });
    quaternionForward(Number.NaN, 0, 0, 1, out);
    expect(out).toEqual({ x: 0, y: 0, z: -1 });
  });

  test("[ER-22-01] horizontal forward drops pitch and renormalizes", () => {
    const out = { x: 9, y: 9, z: 9 };
    // 90° about +X turns -Z into +Y; a ground-plane follow must fall back.
    const half = Math.PI / 4;
    horizontalForward(Math.sin(half), 0, 0, Math.cos(half), out);
    expect(out).toEqual({ x: 0, y: 1, z: -1 });

    const yaw = { x: 0, y: 0, z: 0, w: 1 };
    yawToQuaternion(Math.PI / 2, yaw);
    horizontalForward(yaw.x, yaw.y, yaw.z, yaw.w, out);
    expect(out.x).toBeCloseTo(-1, 12);
    expect(out.z).toBeCloseTo(0, 12);
  });

  test("[ER-22-01] follow target sits behind the actor and looks ahead", () => {
    const out = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 };
    computeFollowTarget(1, 2, 3, 0, -1, 8, 4, 2, out);
    expect(out).toEqual({ px: 1, py: 6, pz: 11, tx: 1, ty: 2, tz: 1 });
  });

  test("[ER-22-01] smoothing is frame-rate independent and bounded", () => {
    expect(smoothingAlpha(0, 1 / 60)).toBe(1);
    expect(smoothingAlpha(6, 0)).toBe(0);
    expect(smoothingAlpha(6, 1 / 60)).toBeCloseTo(
      1 - Math.exp(-6 / 60),
      12,
    );
    // A long frame is capped so a hitch cannot teleport the camera.
    expect(smoothingAlpha(6, 10)).toBeCloseTo(1 - Math.exp(-6 * 0.25), 12);
  });
});

describe("shadow and sky tiers", () => {
  test("[ER-22-01] WebGL2 clamps high shadows to low", () => {
    expect(effectiveShadowTier("high", "webgpu")).toBe("high");
    expect(effectiveShadowTier("high", "webgl2")).toBe("low");
    expect(effectiveShadowTier("low", "webgl2")).toBe("low");
    expect(effectiveShadowTier("off", "webgpu")).toBe("off");
  });

  test("[ER-22-01] shadow map sizes match the tier", () => {
    expect(shadowMapSize("high")).toBe(2048);
    expect(shadowMapSize("low")).toBe(512);
    expect(shadowMapSize("off")).toBe(0);
  });

  test("[ER-22-01] every preset has a full emissive and clear colour", () => {
    for (const preset of ["day", "dusk", "night", "overcast"] as const) {
      expect(SKY_PRESET_COLORS[preset].emissive).toHaveLength(3);
      expect(SKY_PRESET_COLORS[preset].clear).toHaveLength(4);
    }
    expect(SKY_PRESET_COLORS.day.clear[3]).toBe(1);
  });
});

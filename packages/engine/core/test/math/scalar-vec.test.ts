/**
 * 02 §3.2–§3.4 unit tests: scalar helpers and Vec2/Vec3/Vec4.
 * Every test title carries ER-02-01 (vec algebra and aliasing) because that is
 * the acceptance row that exercises this family.
 */

import { describe, expect, test } from "vitest";
import {
  DEG2RAD,
  EPSILON,
  EPSILON_DOUBLE,
  EPSILON_SCALAR,
  HALF_PI,
  PI,
  RAD2DEG,
  TWO_PI,
  approximatelyEqual,
  clamp,
  clamp01,
  degToRad,
  inverseLerp,
  lerp,
  moveTowardAngle,
  radToDeg,
  vec2Add,
  vec2AddScaled,
  vec2Angle,
  vec2ClampLength,
  vec2Copy,
  vec2Create,
  vec2Cross,
  vec2Distance,
  vec2DistanceSq,
  vec2Dot,
  vec2Equals,
  vec2FromAngle,
  vec2Length,
  vec2LengthSq,
  vec2Lerp,
  vec2Max,
  vec2Min,
  vec2Negate,
  vec2Normalize,
  vec2Perp,
  vec2Rotate,
  vec2Scale,
  vec2Set,
  vec2Sub,
  vec3Abs,
  vec3Add,
  vec3AddScaled,
  vec3ClampLength,
  vec3Copy,
  vec3Create,
  vec3Cross,
  vec3Distance,
  vec3DistanceSq,
  vec3Dot,
  vec3Equals,
  vec3Length,
  vec3LengthSq,
  vec3Lerp,
  vec3Max,
  vec3Min,
  vec3Negate,
  vec3Normalize,
  vec3Scale,
  vec3Set,
  vec3Sub,
  vec4Add,
  vec4Copy,
  vec4Create,
  vec4Dot,
  vec4Equals,
  vec4FromVec3,
  vec4Length,
  vec4LengthSq,
  vec4Lerp,
  vec4Normalize,
  vec4Scale,
  vec4Set,
  vec4Sub,
  vec4ToVec3,
  wrapAngle,
} from "../../src/math/index.js";
import type { Vec2, Vec3, Vec4 } from "../../src/math/index.js";
import { expectVec3Close, near } from "./helpers.js";

const EPS = 1e-12;

function v2(x: number, y: number): Vec2 {
  return vec2Create(x, y);
}

function v3(x: number, y: number, z: number): Vec3 {
  return vec3Create(x, y, z);
}

function v4(x: number, y: number, z: number, w: number): Vec4 {
  return vec4Create(x, y, z, w);
}

describe("scalar helpers", () => {
  test("[ER-02-01] epsilon constants are the frozen 02 §3.9 values", () => {
    expect(EPSILON).toBe(1e-6);
    expect(EPSILON_SCALAR).toBe(1e-9);
    expect(EPSILON_DOUBLE).toBe(1e-12);
    expect(PI).toBe(Math.PI);
    expect(TWO_PI).toBe(Math.PI * 2);
    expect(HALF_PI).toBe(Math.PI / 2);
    expect(DEG2RAD).toBe(Math.PI / 180);
    expect(RAD2DEG).toBe(180 / Math.PI);
  });

  test("[ER-02-01] clamp clamps and clamp01 clamps into [0,1]", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(clamp(1, 1, 1)).toBe(1);
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(2)).toBe(1);
    expect(() => clamp(1, 2, 1)).toThrow(RangeError);
  });

  test("[ER-02-01] lerp and inverseLerp are inverses for a non-degenerate interval", () => {
    near(lerp(2, 10, 0.25), 4, EPS);
    near(lerp(2, 10, 0), 2, EPS);
    near(lerp(2, 10, 1), 10, EPS);
    near(inverseLerp(2, 10, 4), 0.25, EPS);
    // No valid interval: the contract fixes 0 rather than NaN/Infinity.
    expect(inverseLerp(3, 3, 3)).toBe(0);
  });

  test("[ER-02-01] degree/radian conversion round-trips", () => {
    near(degToRad(180), PI, EPS);
    near(radToDeg(PI), 180, EPS);
    near(radToDeg(degToRad(37)), 37, EPS);
  });

  test("[ER-02-01] wrapAngle maps to (-PI, PI] and preserves the periodic image", () => {
    near(wrapAngle(0), 0, EPS);
    near(wrapAngle(PI), PI, EPS);
    // -PI is the excluded endpoint; the contract sends it to +PI.
    expect(wrapAngle(-PI)).toBe(PI);
    near(wrapAngle(TWO_PI + 0.5), 0.5, EPS);
    near(wrapAngle(-TWO_PI - 0.5), -0.5, EPS);
    near(wrapAngle(-5 * HALF_PI), -HALF_PI, EPS);
    near(wrapAngle(3 * PI), PI, EPS);
  });

  test("[ER-02-01] moveTowardAngle crosses the wrap in the short direction", () => {
    // 3.0 and -3.0 are 0.283 rad apart across the wrap, not ~6 rad apart.
    expect(moveTowardAngle(3, -3, 0.4)).toBe(-3);
    near(moveTowardAngle(3, -3, 0.1), 3.1, 1e-12);
    near(moveTowardAngle(0.1, 1.5, 0.25), 0.35, EPS);
    near(moveTowardAngle(3, -3, 0), 3, EPS);
    // -PI and PI name the same heading, so there is no distance to travel.
    expect(moveTowardAngle(-PI, PI, 0.1)).toBe(PI);
  });

  test("[ER-02-01] approximatelyEqual uses the scalar epsilon by default", () => {
    expect(approximatelyEqual(1, 1 + 1e-10)).toBe(true);
    expect(approximatelyEqual(1, 1 + 1e-8)).toBe(false);
    expect(approximatelyEqual(1, 1 + 1e-5, 1e-4)).toBe(true);
  });
});

describe("Vec2", () => {
  test("[ER-02-01] create/set/copy keep component order", () => {
    expect(v2(1, 2)).toEqual({ x: 1, y: 2 });
    expect(vec2Create()).toEqual({ x: 0, y: 0 });
    const a = v2(1, 2);
    const out = vec2Create();
    vec2Set(out, 3, 4);
    expect(out).toEqual({ x: 3, y: 4 });
    const copy = vec2Create();
    vec2Copy(copy, a);
    expect(copy).toEqual({ x: 1, y: 2 });
    expect(copy).not.toBe(a);
  });

  test("[ER-02-01] add/sub/scale/addScaled/negate", () => {
    expect(vec2Add(vec2Create(), v2(1, 2), v2(3, 4))).toEqual({ x: 4, y: 6 });
    expect(vec2Sub(vec2Create(), v2(1, 2), v2(3, 4))).toEqual({ x: -2, y: -2 });
    expect(vec2Scale(vec2Create(), v2(1, 2), 3)).toEqual({ x: 3, y: 6 });
    expect(vec2AddScaled(vec2Create(), v2(1, 2), v2(3, 4), 2)).toEqual({
      x: 7,
      y: 10,
    });
    expect(vec2Negate(vec2Create(), v2(1, -2))).toEqual({ x: -1, y: 2 });
  });

  test("[ER-02-01] dot, cross, length and distance", () => {
    near(vec2Dot(v2(1, 2), v2(3, 4)), 11, EPS);
    near(vec2Cross(v2(1, 0), v2(0, 1)), 1, EPS);
    near(vec2LengthSq(v2(3, 4)), 25, EPS);
    near(vec2Length(v2(3, -4)), 5, EPS);
    near(vec2DistanceSq(v2(1, 1), v2(4, 5)), 25, EPS);
    near(vec2Distance(v2(1, 1), v2(4, 5)), 5, EPS);
  });

  test("[ER-02-01] normalize returns the original length and zeroes a zero vector", () => {
    const out = vec2Create();
    expect(vec2Normalize(out, v2(3, 4))).toBe(5);
    near(out.x, 0.6, EPS);
    near(out.y, 0.8, EPS);
    expect(vec2Normalize(out, v2(0, 0))).toBe(0);
    expect(out).toEqual({ x: 0, y: 0 });
  });

  test("[ER-02-01] lerp/min/max/clampLength", () => {
    expect(vec2Lerp(vec2Create(), v2(0, 0), v2(10, 20), 0.5)).toEqual({
      x: 5,
      y: 10,
    });
    expect(vec2Min(vec2Create(), v2(1, 5), v2(3, 2))).toEqual({ x: 1, y: 2 });
    expect(vec2Max(vec2Create(), v2(1, 5), v2(3, 2))).toEqual({ x: 3, y: 5 });
    const clamped = vec2ClampLength(vec2Create(), v2(3, 4), 1);
    near(clamped.x, 0.6, EPS);
    near(clamped.y, 0.8, EPS);
    // A non-positive max collapses to zero rather than flipping direction.
    expect(vec2ClampLength(vec2Create(), v2(3, 4), -1)).toEqual({ x: 0, y: 0 });
  });

  test("[ER-02-01] rotate by +90 degrees is clockwise on the y-down screen", () => {
    const out = vec2Rotate(vec2Create(), v2(1, 0), HALF_PI);
    near(out.x, 0, EPS);
    near(out.y, 1, EPS);
  });

  test("[ER-02-01] angle and fromAngle round-trip in (-PI, PI]", () => {
    near(vec2Angle(v2(0, 1)), HALF_PI, EPS);
    near(vec2Angle(v2(-1, 0)), PI, EPS);
    near(vec2Angle(v2(1, 0)), 0, EPS);
    const direction = vec2Create();
    vec2FromAngle(direction, 0.7, 2);
    near(direction.x, 2 * Math.cos(0.7), EPS);
    near(direction.y, 2 * Math.sin(0.7), EPS);
    near(vec2Length(vec2FromAngle(vec2Create(), -2.1)), 1, EPS);
  });

  test("[ER-02-01] perp is (-y, x) and equals compares component-wise", () => {
    expect(vec2Perp(vec2Create(), v2(2, 3))).toEqual({ x: -3, y: 2 });
    expect(vec2Equals(v2(1, 2), v2(1, 2))).toBe(true);
    expect(vec2Equals(v2(1, 2), v2(1, 2 + 1e-5))).toBe(false);
  });

  test("[ER-02-01] every Vec2 out-parameter accepts an aliased input", () => {
    const ax = 1.5;
    const ay = -2.5;
    const bx = -0.5;
    const by = 4;
    const expectedAdd = vec2Add(vec2Create(), v2(ax, ay), v2(bx, by));
    expect(vec2Add(v2(ax, ay), v2(ax, ay), v2(bx, by))).toEqual(expectedAdd);
    expect(vec2Add(v2(bx, by), v2(ax, ay), v2(bx, by))).toEqual(expectedAdd);

    const expectedRotate = vec2Rotate(vec2Create(), v2(ax, ay), 0.4);
    expect(vec2Rotate(v2(ax, ay), v2(ax, ay), 0.4)).toEqual(expectedRotate);

    const expectedLerp = vec2Lerp(vec2Create(), v2(ax, ay), v2(bx, by), 0.3);
    expect(vec2Lerp(v2(ax, ay), v2(ax, ay), v2(bx, by), 0.3)).toEqual(
      expectedLerp,
    );

    const expectedNormalize = vec2Create();
    vec2Normalize(expectedNormalize, v2(ax, ay));
    const normalized = v2(ax, ay);
    expect(vec2Normalize(normalized, normalized)).toBe(
      vec2Length(v2(ax, ay)),
    );
    expect(vec2Equals(normalized, expectedNormalize)).toBe(true);
  });
});

describe("Vec3", () => {
  test("[ER-02-01] create/set/copy/add/sub/scale/addScaled/negate", () => {
    expect(v3(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
    expect(vec3Create()).toEqual({ x: 0, y: 0, z: 0 });
    const out = vec3Create();
    vec3Set(out, 4, 5, 6);
    expect(out).toEqual({ x: 4, y: 5, z: 6 });
    const copy = vec3Create();
    vec3Copy(copy, out);
    expect(copy).toEqual({ x: 4, y: 5, z: 6 });
    expect(vec3Add(vec3Create(), v3(1, 2, 3), v3(4, 5, 6))).toEqual({
      x: 5,
      y: 7,
      z: 9,
    });
    expect(vec3Sub(vec3Create(), v3(4, 5, 6), v3(1, 2, 3))).toEqual({
      x: 3,
      y: 3,
      z: 3,
    });
    expect(vec3Scale(vec3Create(), v3(1, 2, 3), 2)).toEqual({
      x: 2,
      y: 4,
      z: 6,
    });
    expect(vec3AddScaled(vec3Create(), v3(1, 2, 3), v3(4, 5, 6), -1)).toEqual({
      x: -3,
      y: -3,
      z: -3,
    });
    expect(vec3Negate(vec3Create(), v3(1, -2, 3))).toEqual({
      x: -1,
      y: 2,
      z: -3,
    });
  });

  test("[ER-02-01] cross is right-handed", () => {
    expect(vec3Cross(vec3Create(), v3(1, 0, 0), v3(0, 1, 0))).toEqual({
      x: 0,
      y: 0,
      z: 1,
    });
    expect(vec3Cross(vec3Create(), v3(0, 1, 0), v3(1, 0, 0))).toEqual({
      x: 0,
      y: 0,
      z: -1,
    });
  });

  test("[ER-02-01] dot, lengths and distances", () => {
    near(vec3Dot(v3(1, 2, 3), v3(4, 5, 6)), 32, EPS);
    near(vec3LengthSq(v3(1, 2, 2)), 9, EPS);
    near(vec3Length(v3(1, 2, 2)), 3, EPS);
    near(vec3DistanceSq(v3(1, 1, 1), v3(3, 3, 3)), 12, EPS);
    near(vec3Distance(v3(1, 1, 1), v3(3, 3, 3)), Math.sqrt(12), EPS);
  });

  test("[ER-02-01] normalize/degenerate zero/clampLength", () => {
    const out = vec3Create();
    expect(vec3Normalize(out, v3(1, 2, 2))).toBe(3);
    expectVec3Close(out, v3(1 / 3, 2 / 3, 2 / 3), EPS);
    expect(vec3Normalize(out, v3(0, 0, 0))).toBe(0);
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    const clamped = vec3ClampLength(vec3Create(), v3(3, 4, 0), 1);
    near(clamped.x, 0.6, EPS);
    near(clamped.y, 0.8, EPS);
    expect(vec3ClampLength(vec3Create(), v3(3, 4, 0), 0)).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
  });

  test("[ER-02-01] lerp/min/max/abs and component-wise equals", () => {
    expect(vec3Lerp(vec3Create(), v3(0, 0, 0), v3(2, 4, 6), 0.5)).toEqual({
      x: 1,
      y: 2,
      z: 3,
    });
    expect(vec3Min(vec3Create(), v3(1, 5, -2), v3(3, 2, -4))).toEqual({
      x: 1,
      y: 2,
      z: -4,
    });
    expect(vec3Max(vec3Create(), v3(1, 5, -2), v3(3, 2, -4))).toEqual({
      x: 3,
      y: 5,
      z: -2,
    });
    expect(vec3Abs(vec3Create(), v3(-1, 2, -3))).toEqual({ x: 1, y: 2, z: 3 });
    expect(vec3Equals(v3(1, 2, 3), v3(1, 2, 3))).toBe(true);
    expect(vec3Equals(v3(1, 2, 3), v3(1, 2, 3.001))).toBe(false);
  });

  test("[ER-02-01] every Vec3 out-parameter accepts an aliased input", () => {
    const ax = 1.5;
    const ay = -2.5;
    const az = 0.75;
    const bx = -0.5;
    const by = 4;
    const bz = 2;
    const expectedAdd = vec3Add(vec3Create(), v3(ax, ay, az), v3(bx, by, bz));
    expect(vec3Add(v3(ax, ay, az), v3(ax, ay, az), v3(bx, by, bz))).toEqual(
      expectedAdd,
    );
    expect(vec3Add(v3(bx, by, bz), v3(ax, ay, az), v3(bx, by, bz))).toEqual(
      expectedAdd,
    );

    const expectedCross = vec3Cross(vec3Create(), v3(ax, ay, az), v3(bx, by, bz));
    expect(vec3Cross(v3(ax, ay, az), v3(ax, ay, az), v3(bx, by, bz))).toEqual(
      expectedCross,
    );
    expect(vec3Cross(v3(bx, by, bz), v3(ax, ay, az), v3(bx, by, bz))).toEqual(
      expectedCross,
    );

    const expectedNormalize = vec3Create();
    vec3Normalize(expectedNormalize, v3(ax, ay, az));
    const normalized = v3(ax, ay, az);
    expect(vec3Normalize(normalized, normalized)).toBe(
      vec3Length(v3(ax, ay, az)),
    );
    expect(vec3Equals(normalized, expectedNormalize)).toBe(true);

    const expectedLerp = vec3Lerp(vec3Create(), v3(ax, ay, az), v3(bx, by, bz), 0.3);
    expect(vec3Lerp(v3(ax, ay, az), v3(ax, ay, az), v3(bx, by, bz), 0.3)).toEqual(
      expectedLerp,
    );
  });
});

describe("Vec4", () => {
  test("[ER-02-01] create/set/copy and conversions", () => {
    expect(v4(1, 2, 3, 4)).toEqual({ x: 1, y: 2, z: 3, w: 4 });
    const out = vec4Create();
    vec4Set(out, 5, 6, 7, 8);
    expect(out).toEqual({ x: 5, y: 6, z: 7, w: 8 });
    const copy = vec4Create();
    vec4Copy(copy, out);
    expect(copy).toEqual({ x: 5, y: 6, z: 7, w: 8 });
    const fromVec3 = vec4Create();
    vec4FromVec3(fromVec3, v3(1, 2, 3), 9);
    expect(fromVec3).toEqual({ x: 1, y: 2, z: 3, w: 9 });
    const toVec3 = vec3Create();
    vec4ToVec3(toVec3, fromVec3);
    expect(toVec3).toEqual({ x: 1, y: 2, z: 3 });
  });

  test("[ER-02-01] algebra, lengths, lerp and equals", () => {
    expect(vec4Add(vec4Create(), v4(1, 2, 3, 4), v4(5, 6, 7, 8))).toEqual({
      x: 6,
      y: 8,
      z: 10,
      w: 12,
    });
    expect(vec4Sub(vec4Create(), v4(5, 6, 7, 8), v4(1, 2, 3, 4))).toEqual({
      x: 4,
      y: 4,
      z: 4,
      w: 4,
    });
    expect(vec4Scale(vec4Create(), v4(1, 2, 3, 4), 2)).toEqual({
      x: 2,
      y: 4,
      z: 6,
      w: 8,
    });
    near(vec4Dot(v4(1, 2, 3, 4), v4(5, 6, 7, 8)), 70, EPS);
    near(vec4LengthSq(v4(1, 2, 2, 4)), 25, EPS);
    near(vec4Length(v4(1, 2, 2, 4)), 5, EPS);
    expect(vec4Lerp(vec4Create(), v4(0, 0, 0, 0), v4(2, 4, 6, 8), 0.5)).toEqual({
      x: 1,
      y: 2,
      z: 3,
      w: 4,
    });
    expect(vec4Equals(v4(1, 2, 3, 4), v4(1, 2, 3, 4))).toBe(true);
    expect(vec4Equals(v4(1, 2, 3, 4), v4(1, 2, 3, 4.01))).toBe(false);
  });

  test("[ER-02-01] normalize returns the length and zeroes a zero vector", () => {
    const out = vec4Create();
    expect(vec4Normalize(out, v4(1, 2, 2, 4))).toBe(5);
    near(out.x, 0.2, EPS);
    near(out.y, 0.4, EPS);
    near(out.z, 0.4, EPS);
    near(out.w, 0.8, EPS);
    expect(vec4Normalize(out, v4(0, 0, 0, 0))).toBe(0);
    expect(out).toEqual({ x: 0, y: 0, z: 0, w: 0 });
  });

  test("[ER-02-01] every Vec4 out-parameter accepts an aliased input", () => {
    const ax = 1.5;
    const ay = -2.5;
    const az = 0.75;
    const aw = 2;
    const bx = -0.5;
    const by = 4;
    const bz = 2;
    const bw = -1;
    const expectedAdd = vec4Add(
      vec4Create(),
      v4(ax, ay, az, aw),
      v4(bx, by, bz, bw),
    );
    expect(
      vec4Add(v4(ax, ay, az, aw), v4(ax, ay, az, aw), v4(bx, by, bz, bw)),
    ).toEqual(expectedAdd);
    expect(
      vec4Add(v4(bx, by, bz, bw), v4(ax, ay, az, aw), v4(bx, by, bz, bw)),
    ).toEqual(expectedAdd);

    const expectedNormalize = vec4Create();
    vec4Normalize(expectedNormalize, v4(ax, ay, az, aw));
    const normalized = v4(ax, ay, az, aw);
    expect(vec4Normalize(normalized, normalized)).toBe(
      vec4Length(v4(ax, ay, az, aw)),
    );
    expect(vec4Equals(normalized, expectedNormalize)).toBe(true);

    const expectedLerp = vec4Lerp(
      vec4Create(),
      v4(ax, ay, az, aw),
      v4(bx, by, bz, bw),
      0.25,
    );
    expect(
      vec4Lerp(
        v4(ax, ay, az, aw),
        v4(ax, ay, az, aw),
        v4(bx, by, bz, bw),
        0.25,
      ),
    ).toEqual(expectedLerp);
  });
});

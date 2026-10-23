/**
 * 02 §7 ER-02-01 property tests: Vec2/Vec3/Vec4 algebra matches a scalar
 * reference over 10,000 random inputs, and every out-parameter function gives
 * the same answer when `out` aliases each input.
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  PI,
  vec2Add,
  vec2AddScaled,
  vec2Angle,
  vec2ClampLength,
  vec2Create,
  vec2Cross,
  vec2Distance,
  vec2DistanceSq,
  vec2Dot,
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
  vec2Sub,
  vec3Abs,
  vec3Add,
  vec3AddScaled,
  vec3ClampLength,
  vec3Create,
  vec3Cross,
  vec3Distance,
  vec3DistanceSq,
  vec3Dot,
  vec3Length,
  vec3LengthSq,
  vec3Lerp,
  vec3Max,
  vec3Min,
  vec3Negate,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
  vec4Add,
  vec4Create,
  vec4Dot,
  vec4Length,
  vec4LengthSq,
  vec4Lerp,
  vec4Normalize,
  vec4Scale,
  vec4Sub,
  vec4ToVec3,
} from "../../src/math/index.js";
import { vec2Arb, vec3Arb, vec4Arb } from "./helpers.js";

/** Relative comparison for values built from the same double inputs. */
function expectClose(actual: number, expected: number, label: string): void {
  const tolerance = Math.max(1, Math.abs(expected)) * 1e-9;
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(tolerance);
}

function scalarArb() {
  return fc.double({
    min: -1000,
    max: 1000,
    noNaN: true,
    noDefaultInfinity: true,
  });
}

function positiveArb() {
  return fc.double({
    min: 0,
    max: 1000,
    noNaN: true,
    noDefaultInfinity: true,
  });
}

function angleArb() {
  return fc.double({
    min: -20,
    max: 20,
    noNaN: true,
    noDefaultInfinity: true,
  });
}

describe("Vec2 scalar reference", () => {
  test("[ER-02-01] Vec2 arithmetic matches the scalar reference for 10,000 inputs", () => {
    fc.assert(
      fc.property(
        vec2Arb(),
        vec2Arb(),
        scalarArb(),
        angleArb(),
        positiveArb(),
        (a, b, scalar, radians, maxLength) => {
          const add = vec2Add(vec2Create(), a, b);
          expectClose(add.x, a.x + b.x, "add.x");
          expectClose(add.y, a.y + b.y, "add.y");

          const sub = vec2Sub(vec2Create(), a, b);
          expectClose(sub.x, a.x - b.x, "sub.x");
          expectClose(sub.y, a.y - b.y, "sub.y");

          const scaled = vec2Scale(vec2Create(), a, scalar);
          expectClose(scaled.x, a.x * scalar, "scale.x");
          expectClose(scaled.y, a.y * scalar, "scale.y");

          const addScaled = vec2AddScaled(vec2Create(), a, b, scalar);
          expectClose(addScaled.x, a.x + b.x * scalar, "addScaled.x");
          expectClose(addScaled.y, a.y + b.y * scalar, "addScaled.y");

          const negated = vec2Negate(vec2Create(), a);
          expectClose(negated.x, -a.x, "negate.x");
          expectClose(negated.y, -a.y, "negate.y");

          expectClose(vec2Dot(a, b), a.x * b.x + a.y * b.y, "dot");
          expectClose(vec2Cross(a, b), a.x * b.y - a.y * b.x, "cross");
          expectClose(vec2LengthSq(a), a.x * a.x + a.y * a.y, "lengthSq");
          expectClose(
            vec2Length(a),
            Math.sqrt(a.x * a.x + a.y * a.y),
            "length",
          );
          expectClose(
            vec2DistanceSq(a, b),
            (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y),
            "distanceSq",
          );
          expectClose(
            vec2Distance(a, b),
            Math.sqrt(
              (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y),
            ),
            "distance",
          );

          const length = Math.sqrt(a.x * a.x + a.y * a.y);
          const normalized = vec2Create();
          expectClose(
            vec2Normalize(normalized, a),
            length,
            "normalize length",
          );
          if (length > 0) {
            expectClose(normalized.x, a.x / length, "normalize.x");
            expectClose(normalized.y, a.y / length, "normalize.y");
          } else {
            expect(normalized).toEqual({ x: 0, y: 0 });
          }

          const lerped = vec2Lerp(vec2Create(), a, b, scalar);
          expectClose(lerped.x, a.x + (b.x - a.x) * scalar, "lerp.x");
          expectClose(lerped.y, a.y + (b.y - a.y) * scalar, "lerp.y");

          // Strict comparisons select the second operand on ties, so a `-0`
          // against `+0` tie may carry either zero sign; compare numerically.
          const minimum = vec2Min(vec2Create(), a, b);
          expectClose(minimum.x, Math.min(a.x, b.x), "min.x");
          expectClose(minimum.y, Math.min(a.y, b.y), "min.y");
          const maximum = vec2Max(vec2Create(), a, b);
          expectClose(maximum.x, Math.max(a.x, b.x), "max.x");
          expectClose(maximum.y, Math.max(a.y, b.y), "max.y");

          const clamped = vec2ClampLength(vec2Create(), a, maxLength);
          if (length === 0) {
            // A zero computed length copies the input, including subnormals.
            expect(clamped).toEqual(a);
          } else if (length > maxLength) {
            expectClose(clamped.x, (a.x / length) * maxLength, "clamp.x");
            expectClose(clamped.y, (a.y / length) * maxLength, "clamp.y");
          } else {
            expect(clamped).toEqual(a);
          }

          const rotated = vec2Rotate(vec2Create(), a, radians);
          const c = Math.cos(radians);
          const s = Math.sin(radians);
          expectClose(rotated.x, a.x * c - a.y * s, "rotate.x");
          expectClose(rotated.y, a.x * s + a.y * c, "rotate.y");

          const perp = vec2Perp(vec2Create(), a);
          expect(perp).toEqual({ x: -a.y, y: a.x });

          const angle = Math.atan2(a.y, a.x);
          expect(vec2Angle(a)).toBe(angle <= -PI ? PI : angle);

          const fromAngle = vec2FromAngle(vec2Create(), radians, maxLength);
          expectClose(
            fromAngle.x,
            Math.cos(radians) * maxLength,
            "fromAngle.x",
          );
          expectClose(
            fromAngle.y,
            Math.sin(radians) * maxLength,
            "fromAngle.y",
          );
          expect(vec2FromAngle(vec2Create(), radians)).toEqual({
            x: Math.cos(radians),
            y: Math.sin(radians),
          });
        },
      ),
      { numRuns: 10_000 },
    );
  }, 30_000);
});

describe("Vec3 scalar reference", () => {
  test("[ER-02-01] Vec3 arithmetic matches the scalar reference for 10,000 inputs", () => {
    fc.assert(
      fc.property(
        vec3Arb(),
        vec3Arb(),
        scalarArb(),
        positiveArb(),
        (a, b, scalar, maxLength) => {
          const add = vec3Add(vec3Create(), a, b);
          expectClose(add.x, a.x + b.x, "add.x");
          expectClose(add.y, a.y + b.y, "add.y");
          expectClose(add.z, a.z + b.z, "add.z");

          const sub = vec3Sub(vec3Create(), a, b);
          expectClose(sub.x, a.x - b.x, "sub.x");
          expectClose(sub.y, a.y - b.y, "sub.y");
          expectClose(sub.z, a.z - b.z, "sub.z");

          const scaled = vec3Scale(vec3Create(), a, scalar);
          expectClose(scaled.x, a.x * scalar, "scale.x");
          expectClose(scaled.y, a.y * scalar, "scale.y");
          expectClose(scaled.z, a.z * scalar, "scale.z");

          const addScaled = vec3AddScaled(vec3Create(), a, b, scalar);
          expectClose(addScaled.x, a.x + b.x * scalar, "addScaled.x");
          expectClose(addScaled.y, a.y + b.y * scalar, "addScaled.y");
          expectClose(addScaled.z, a.z + b.z * scalar, "addScaled.z");

          const negated = vec3Negate(vec3Create(), a);
          expect(negated).toEqual({ x: -a.x, y: -a.y, z: -a.z });
          expect(vec3Abs(vec3Create(), a)).toEqual({
            x: Math.abs(a.x),
            y: Math.abs(a.y),
            z: Math.abs(a.z),
          });

          expectClose(
            vec3Dot(a, b),
            a.x * b.x + a.y * b.y + a.z * b.z,
            "dot",
          );

          const cross = vec3Cross(vec3Create(), a, b);
          expectClose(cross.x, a.y * b.z - a.z * b.y, "cross.x");
          expectClose(cross.y, a.z * b.x - a.x * b.z, "cross.y");
          expectClose(cross.z, a.x * b.y - a.y * b.x, "cross.z");

          expectClose(
            vec3LengthSq(a),
            a.x * a.x + a.y * a.y + a.z * a.z,
            "lengthSq",
          );
          expectClose(
            vec3Length(a),
            Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z),
            "length",
          );
          expectClose(
            vec3DistanceSq(a, b),
            (a.x - b.x) * (a.x - b.x) +
              (a.y - b.y) * (a.y - b.y) +
              (a.z - b.z) * (a.z - b.z),
            "distanceSq",
          );
          expectClose(
            vec3Distance(a, b),
            Math.sqrt(
              (a.x - b.x) * (a.x - b.x) +
                (a.y - b.y) * (a.y - b.y) +
                (a.z - b.z) * (a.z - b.z),
            ),
            "distance",
          );

          const length = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
          const normalized = vec3Create();
          expectClose(
            vec3Normalize(normalized, a),
            length,
            "normalize length",
          );
          if (length > 0) {
            expectClose(normalized.x, a.x / length, "normalize.x");
            expectClose(normalized.y, a.y / length, "normalize.y");
            expectClose(normalized.z, a.z / length, "normalize.z");
          } else {
            expect(normalized).toEqual({ x: 0, y: 0, z: 0 });
          }

          const lerped = vec3Lerp(vec3Create(), a, b, scalar);
          expectClose(lerped.x, a.x + (b.x - a.x) * scalar, "lerp.x");
          expectClose(lerped.y, a.y + (b.y - a.y) * scalar, "lerp.y");
          expectClose(lerped.z, a.z + (b.z - a.z) * scalar, "lerp.z");

          const minimum = vec3Min(vec3Create(), a, b);
          expectClose(minimum.x, Math.min(a.x, b.x), "min.x");
          expectClose(minimum.y, Math.min(a.y, b.y), "min.y");
          expectClose(minimum.z, Math.min(a.z, b.z), "min.z");
          const maximum = vec3Max(vec3Create(), a, b);
          expectClose(maximum.x, Math.max(a.x, b.x), "max.x");
          expectClose(maximum.y, Math.max(a.y, b.y), "max.y");
          expectClose(maximum.z, Math.max(a.z, b.z), "max.z");

          const clamped = vec3ClampLength(vec3Create(), a, maxLength);
          if (length === 0) {
            // A zero computed length copies the input, including subnormals.
            expect(clamped).toEqual(a);
          } else if (length > maxLength) {
            expectClose(clamped.x, (a.x / length) * maxLength, "clamp.x");
            expectClose(clamped.y, (a.y / length) * maxLength, "clamp.y");
            expectClose(clamped.z, (a.z / length) * maxLength, "clamp.z");
          } else {
            expect(clamped).toEqual(a);
          }
        },
      ),
      { numRuns: 10_000 },
    );
  }, 30_000);
});

describe("Vec4 scalar reference", () => {
  test("[ER-02-01] Vec4 arithmetic matches the scalar reference for 10,000 inputs", () => {
    fc.assert(
      fc.property(vec4Arb(), vec4Arb(), scalarArb(), (a, b, scalar) => {
        const add = vec4Add(vec4Create(), a, b);
        expectClose(add.x, a.x + b.x, "add.x");
        expectClose(add.y, a.y + b.y, "add.y");
        expectClose(add.z, a.z + b.z, "add.z");
        expectClose(add.w, a.w + b.w, "add.w");

        const sub = vec4Sub(vec4Create(), a, b);
        expectClose(sub.x, a.x - b.x, "sub.x");
        expectClose(sub.y, a.y - b.y, "sub.y");
        expectClose(sub.z, a.z - b.z, "sub.z");
        expectClose(sub.w, a.w - b.w, "sub.w");

        expect(vec4Scale(vec4Create(), a, scalar)).toEqual({
          x: a.x * scalar,
          y: a.y * scalar,
          z: a.z * scalar,
          w: a.w * scalar,
        });

        expectClose(
          vec4Dot(a, b),
          a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w,
          "dot",
        );
        expectClose(
          vec4LengthSq(a),
          a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w,
          "lengthSq",
        );
        expectClose(
          vec4Length(a),
          Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w),
          "length",
        );

        const length = Math.sqrt(
          a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w,
        );
        const normalized = vec4Create();
        expectClose(
          vec4Normalize(normalized, a),
          length,
          "normalize length",
        );
        if (length > 0) {
          expectClose(normalized.x, a.x / length, "normalize.x");
          expectClose(normalized.y, a.y / length, "normalize.y");
          expectClose(normalized.z, a.z / length, "normalize.z");
          expectClose(normalized.w, a.w / length, "normalize.w");
        } else {
          expect(normalized).toEqual({ x: 0, y: 0, z: 0, w: 0 });
        }

        const lerped = vec4Lerp(vec4Create(), a, b, scalar);
        expectClose(lerped.x, a.x + (b.x - a.x) * scalar, "lerp.x");
        expectClose(lerped.y, a.y + (b.y - a.y) * scalar, "lerp.y");
        expectClose(lerped.z, a.z + (b.z - a.z) * scalar, "lerp.z");
        expectClose(lerped.w, a.w + (b.w - a.w) * scalar, "lerp.w");

        expect(vec4ToVec3(vec3Create(), a)).toEqual({
          x: a.x,
          y: a.y,
          z: a.z,
        });
      }),
      { numRuns: 10_000 },
    );
  }, 30_000);
});

describe("Aliasing matrix", () => {
  test("[ER-02-01] Vec2 out-parameter functions tolerate every alias", () => {
    const ax = 1.5;
    const ay = -2.5;
    const bx = -0.5;
    const by = 4;
    const s = 2.25;

    const expectedAdd = vec2Add(
      vec2Create(),
      vec2Create(ax, ay),
      vec2Create(bx, by),
    );
    const aliasAddA = vec2Create(ax, ay);
    expect(vec2Add(aliasAddA, aliasAddA, vec2Create(bx, by))).toEqual(
      expectedAdd,
    );
    const aliasAddB = vec2Create(bx, by);
    expect(vec2Add(aliasAddB, vec2Create(ax, ay), aliasAddB)).toEqual(
      expectedAdd,
    );

    const expectedSub = vec2Sub(
      vec2Create(),
      vec2Create(ax, ay),
      vec2Create(bx, by),
    );
    const aliasSubA = vec2Create(ax, ay);
    expect(vec2Sub(aliasSubA, aliasSubA, vec2Create(bx, by))).toEqual(
      expectedSub,
    );
    const aliasSubB = vec2Create(bx, by);
    expect(vec2Sub(aliasSubB, vec2Create(ax, ay), aliasSubB)).toEqual(
      expectedSub,
    );

    const expectedAddScaled = vec2AddScaled(
      vec2Create(),
      vec2Create(ax, ay),
      vec2Create(bx, by),
      s,
    );
    const aliasScaledA = vec2Create(ax, ay);
    expect(
      vec2AddScaled(aliasScaledA, aliasScaledA, vec2Create(bx, by), s),
    ).toEqual(expectedAddScaled);
    const aliasScaledB = vec2Create(bx, by);
    expect(
      vec2AddScaled(aliasScaledB, vec2Create(ax, ay), aliasScaledB, s),
    ).toEqual(expectedAddScaled);

    const expectedScale = vec2Scale(vec2Create(), vec2Create(ax, ay), s);
    const aliasScale = vec2Create(ax, ay);
    expect(vec2Scale(aliasScale, aliasScale, s)).toEqual(expectedScale);

    const expectedNegate = vec2Negate(vec2Create(), vec2Create(ax, ay));
    const aliasNegate = vec2Create(ax, ay);
    expect(vec2Negate(aliasNegate, aliasNegate)).toEqual(expectedNegate);

    const expectedNormalize = vec2Create();
    const expectedNormalizeLength = vec2Normalize(
      expectedNormalize,
      vec2Create(ax, ay),
    );
    const aliasNormalize = vec2Create(ax, ay);
    expect(vec2Normalize(aliasNormalize, aliasNormalize)).toBe(
      expectedNormalizeLength,
    );
    expect(aliasNormalize).toEqual(expectedNormalize);

    const expectedLerp = vec2Lerp(
      vec2Create(),
      vec2Create(ax, ay),
      vec2Create(bx, by),
      0.3,
    );
    const aliasLerpA = vec2Create(ax, ay);
    expect(vec2Lerp(aliasLerpA, aliasLerpA, vec2Create(bx, by), 0.3)).toEqual(
      expectedLerp,
    );
    const aliasLerpB = vec2Create(bx, by);
    expect(vec2Lerp(aliasLerpB, vec2Create(ax, ay), aliasLerpB, 0.3)).toEqual(
      expectedLerp,
    );

    const expectedClamp = vec2ClampLength(
      vec2Create(),
      vec2Create(ax, ay),
      1,
    );
    const aliasClamp = vec2Create(ax, ay);
    expect(vec2ClampLength(aliasClamp, aliasClamp, 1)).toEqual(expectedClamp);

    const expectedRotate = vec2Rotate(
      vec2Create(),
      vec2Create(ax, ay),
      0.7,
    );
    const aliasRotate = vec2Create(ax, ay);
    expect(vec2Rotate(aliasRotate, aliasRotate, 0.7)).toEqual(expectedRotate);

    const expectedPerp = vec2Perp(vec2Create(), vec2Create(ax, ay));
    const aliasPerp = vec2Create(ax, ay);
    expect(vec2Perp(aliasPerp, aliasPerp)).toEqual(expectedPerp);

    const expectedMin = vec2Min(
      vec2Create(),
      vec2Create(ax, ay),
      vec2Create(bx, by),
    );
    const aliasMinA = vec2Create(ax, ay);
    expect(vec2Min(aliasMinA, aliasMinA, vec2Create(bx, by))).toEqual(
      expectedMin,
    );
    const aliasMinB = vec2Create(bx, by);
    expect(vec2Min(aliasMinB, vec2Create(ax, ay), aliasMinB)).toEqual(
      expectedMin,
    );

    const expectedMax = vec2Max(
      vec2Create(),
      vec2Create(ax, ay),
      vec2Create(bx, by),
    );
    const aliasMaxA = vec2Create(ax, ay);
    expect(vec2Max(aliasMaxA, aliasMaxA, vec2Create(bx, by))).toEqual(
      expectedMax,
    );
    const aliasMaxB = vec2Create(bx, by);
    expect(vec2Max(aliasMaxB, vec2Create(ax, ay), aliasMaxB)).toEqual(
      expectedMax,
    );
  });

  test("[ER-02-01] Vec3 out-parameter functions tolerate every alias", () => {
    const a = () => vec3Create(1.5, -2.5, 0.75);
    const b = () => vec3Create(-0.5, 4, -1.25);
    const s = 2.25;

    const expectedAdd = vec3Add(vec3Create(), a(), b());
    const aliasAddA = a();
    expect(vec3Add(aliasAddA, aliasAddA, b())).toEqual(expectedAdd);
    const aliasAddB = b();
    expect(vec3Add(aliasAddB, a(), aliasAddB)).toEqual(expectedAdd);

    const expectedSub = vec3Sub(vec3Create(), a(), b());
    const aliasSubA = a();
    expect(vec3Sub(aliasSubA, aliasSubA, b())).toEqual(expectedSub);
    const aliasSubB = b();
    expect(vec3Sub(aliasSubB, a(), aliasSubB)).toEqual(expectedSub);

    const expectedAddScaled = vec3AddScaled(vec3Create(), a(), b(), s);
    const aliasScaledA = a();
    expect(vec3AddScaled(aliasScaledA, aliasScaledA, b(), s)).toEqual(
      expectedAddScaled,
    );
    const aliasScaledB = b();
    expect(vec3AddScaled(aliasScaledB, a(), aliasScaledB, s)).toEqual(
      expectedAddScaled,
    );

    const expectedCross = vec3Cross(vec3Create(), a(), b());
    const aliasCrossA = a();
    expect(vec3Cross(aliasCrossA, aliasCrossA, b())).toEqual(expectedCross);
    const aliasCrossB = b();
    expect(vec3Cross(aliasCrossB, a(), aliasCrossB)).toEqual(expectedCross);

    const expectedScale = vec3Scale(vec3Create(), a(), s);
    const aliasScale = a();
    expect(vec3Scale(aliasScale, aliasScale, s)).toEqual(expectedScale);

    const expectedNegate = vec3Negate(vec3Create(), a());
    const aliasNegate = a();
    expect(vec3Negate(aliasNegate, aliasNegate)).toEqual(expectedNegate);

    const expectedAbs = vec3Abs(vec3Create(), b());
    const aliasAbs = b();
    expect(vec3Abs(aliasAbs, aliasAbs)).toEqual(expectedAbs);

    const expectedNormalize = vec3Create();
    const expectedNormalizeLength = vec3Normalize(expectedNormalize, a());
    const aliasNormalize = a();
    expect(vec3Normalize(aliasNormalize, aliasNormalize)).toBe(
      expectedNormalizeLength,
    );
    expect(aliasNormalize).toEqual(expectedNormalize);

    const expectedLerp = vec3Lerp(vec3Create(), a(), b(), 0.3);
    const aliasLerpA = a();
    expect(vec3Lerp(aliasLerpA, aliasLerpA, b(), 0.3)).toEqual(expectedLerp);
    const aliasLerpB = b();
    expect(vec3Lerp(aliasLerpB, a(), aliasLerpB, 0.3)).toEqual(expectedLerp);

    const expectedClamp = vec3ClampLength(vec3Create(), a(), 1);
    const aliasClamp = a();
    expect(vec3ClampLength(aliasClamp, aliasClamp, 1)).toEqual(expectedClamp);

    const expectedMin = vec3Min(vec3Create(), a(), b());
    const aliasMinA = a();
    expect(vec3Min(aliasMinA, aliasMinA, b())).toEqual(expectedMin);
    const aliasMinB = b();
    expect(vec3Min(aliasMinB, a(), aliasMinB)).toEqual(expectedMin);

    const expectedMax = vec3Max(vec3Create(), a(), b());
    const aliasMaxA = a();
    expect(vec3Max(aliasMaxA, aliasMaxA, b())).toEqual(expectedMax);
    const aliasMaxB = b();
    expect(vec3Max(aliasMaxB, a(), aliasMaxB)).toEqual(expectedMax);
  });

  test("[ER-02-01] Vec4 out-parameter functions tolerate every alias", () => {
    const a = () => vec4Create(1.5, -2.5, 0.75, 3);
    const b = () => vec4Create(-0.5, 4, -1.25, 2);
    const s = 2.25;

    const expectedAdd = vec4Add(vec4Create(), a(), b());
    const aliasAddA = a();
    expect(vec4Add(aliasAddA, aliasAddA, b())).toEqual(expectedAdd);
    const aliasAddB = b();
    expect(vec4Add(aliasAddB, a(), aliasAddB)).toEqual(expectedAdd);

    const expectedSub = vec4Sub(vec4Create(), a(), b());
    const aliasSubA = a();
    expect(vec4Sub(aliasSubA, aliasSubA, b())).toEqual(expectedSub);
    const aliasSubB = b();
    expect(vec4Sub(aliasSubB, a(), aliasSubB)).toEqual(expectedSub);

    const expectedScale = vec4Scale(vec4Create(), a(), s);
    const aliasScale = a();
    expect(vec4Scale(aliasScale, aliasScale, s)).toEqual(expectedScale);

    const expectedNormalize = vec4Create();
    const expectedNormalizeLength = vec4Normalize(expectedNormalize, a());
    const aliasNormalize = a();
    expect(vec4Normalize(aliasNormalize, aliasNormalize)).toBe(
      expectedNormalizeLength,
    );
    expect(aliasNormalize).toEqual(expectedNormalize);

    const expectedLerp = vec4Lerp(vec4Create(), a(), b(), 0.3);
    const aliasLerpA = a();
    expect(vec4Lerp(aliasLerpA, aliasLerpA, b(), 0.3)).toEqual(expectedLerp);
    const aliasLerpB = b();
    expect(vec4Lerp(aliasLerpB, a(), aliasLerpB, 0.3)).toEqual(expectedLerp);
  });
});

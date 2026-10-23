/**
 * 02 §3.7 unit tests: Quat algebra, rotation, interpolation and conversions.
 * Every title carries ER-02-04.
 */

import { describe, expect, test } from "vitest";
import {
  PI,
  mat3Create,
  mat4Create,
  mat4FromScale,
  mat4Identity,
  quatAngleBetween,
  quatConjugate,
  quatCopy,
  quatCreate,
  quatDot,
  quatEquals,
  quatFromAxisAngle,
  quatFromEulerYXZ,
  quatFromMat4,
  quatFromTo,
  quatIdentity,
  quatInvert,
  quatLength,
  quatLengthSq,
  quatMultiply,
  quatNlerp,
  quatNormalize,
  quatRotateVec3,
  quatSet,
  quatSlerp,
  quatToMat3,
  quatToMat4,
  vec3Create,
} from "../../src/math/index.js";
import type { Quat, Vec3 } from "../../src/math/index.js";
import {
  at,
  expectQuatEquivalent,
  expectVec3Close,
  m3,
  m4,
  near,
} from "./helpers.js";

function q(x: number, y: number, z: number, w: number): Quat {
  return quatCreate(x, y, z, w);
}

function qz(radians: number): Quat {
  return quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 1), radians);
}

function qx(radians: number): Quat {
  return quatFromAxisAngle(quatCreate(), vec3Create(1, 0, 0), radians);
}

function qy(radians: number): Quat {
  return quatFromAxisAngle(quatCreate(), vec3Create(0, 1, 0), radians);
}

describe("Quat algebra", () => {
  test("[ER-02-04] create defaults to identity; set/copy/identity agree", () => {
    expect(quatCreate()).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(quatIdentity(quatCreate())).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const out = quatCreate();
    quatSet(out, 1, 2, 3, 4);
    expect(out).toEqual({ x: 1, y: 2, z: 3, w: 4 });
    const copy = quatCreate();
    quatCopy(copy, out);
    expect(copy).toEqual({ x: 1, y: 2, z: 3, w: 4 });
    expect(copy).not.toBe(out);
  });

  test("[ER-02-04] multiply is the Hamilton product with out = a * b", () => {
    const a = qz(PI / 2);
    const b = qx(PI / 2);
    const s = Math.SQRT1_2;
    near(quatDot(a, q(0, 0, s, s)), 1, 1e-12);
    near(quatDot(b, q(s, 0, 0, s)), 1, 1e-12);
    const product = quatMultiply(quatCreate(), a, b);
    expectQuatEquivalent(product, q(0.5, 0.5, 0.5, 0.5), 1e-6);
    const reversed = quatMultiply(quatCreate(), b, a);
    expectQuatEquivalent(reversed, q(0.5, -0.5, 0.5, 0.5), 1e-6);
    // Rotating by a then b is b * a.
    const point = vec3Create();
    quatRotateVec3(point, reversed, vec3Create(1, 0, 0));
    expectVec3Close(point, vec3Create(0, 0, 1), 1e-6);
    quatRotateVec3(point, product, vec3Create(1, 0, 0));
    expectVec3Close(point, vec3Create(0, 1, 0), 1e-6);
  });

  test("[ER-02-04] conjugate and inverse cancel rotation", () => {
    const rotation = q(0.5, -0.25, 0.75, 0.5);
    const conjugate = quatConjugate(quatCreate(), rotation);
    expect(conjugate).toEqual({ x: -0.5, y: 0.25, z: -0.75, w: 0.5 });
    const inverse = quatInvert(quatCreate(), rotation);
    const product = quatMultiply(quatCreate(), inverse, rotation);
    expectQuatEquivalent(product, quatCreate(), 1e-12);
    // Invert is conjugate / lengthSq, so it is defined for non-unit input.
    const nonUnit = q(1, 2, 3, 4);
    const inverseNonUnit = quatInvert(quatCreate(), nonUnit);
    expectQuatEquivalent(
      quatMultiply(quatCreate(), inverseNonUnit, nonUnit),
      quatCreate(),
      1e-12,
    );
    // Zero has no inverse; the contract writes identity.
    expect(quatInvert(quatCreate(), q(0, 0, 0, 0))).toEqual({
      x: 0,
      y: 0,
      z: 0,
      w: 1,
    });
  });

  test("[ER-02-04] normalize returns the length and zero writes identity", () => {
    const out = quatCreate();
    expect(quatNormalize(out, q(0, 0, 3, 4))).toBe(5);
    near(out.x, 0, 1e-12);
    near(out.y, 0, 1e-12);
    near(out.z, 0.6, 1e-12);
    near(out.w, 0.8, 1e-12);
    near(quatLength(out), 1, 1e-12);
    expect(quatNormalize(out, q(0, 0, 0, 0))).toBe(0);
    expect(out).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    near(quatLengthSq(q(1, 2, 3, 4)), 30, 1e-12);
    near(quatLength(q(1, 2, 3, 4)), Math.sqrt(30), 1e-12);
    near(quatDot(q(1, 2, 3, 4), q(5, 6, 7, 8)), 70, 1e-12);
  });

  test("[ER-02-04] equals is component-wise, so q and -q differ", () => {
    expect(quatEquals(q(0, 0, 0, 1), q(0, 0, 0, 1))).toBe(true);
    expect(quatEquals(q(0, 0, 0, 1), q(0, 0, 0, -1))).toBe(false);
    expect(quatEquals(q(0, 0, 0, 1), q(0, 0, 0, 1 + 1e-4))).toBe(false);
  });

  test("[ER-02-04] multiply/normalize/rotate accept an aliased out", () => {
    const a = q(0.2, 0.3, 0.4, 0.8);
    const b = q(-0.1, 0.5, 0.2, 0.7);
    const expectedProduct = quatMultiply(quatCreate(), a, b);
    const first = quatCopy(quatCreate(), a);
    expect(quatMultiply(first, first, b)).toBe(first);
    expect(quatEquals(first, expectedProduct, 0)).toBe(true);
    const second = quatCopy(quatCreate(), b);
    expect(quatMultiply(second, a, second)).toBe(second);
    expect(quatEquals(second, expectedProduct, 0)).toBe(true);

    const normalized = quatCopy(quatCreate(), a);
    const expectedNormalize = quatCreate();
    quatNormalize(expectedNormalize, a);
    expect(quatNormalize(normalized, normalized)).toBe(quatLength(a));
    expect(quatEquals(normalized, expectedNormalize, 0)).toBe(true);

    const vector = vec3Create(1, -2, 0.5);
    const expectedVector = vec3Create();
    quatRotateVec3(expectedVector, a, vector);
    expect(quatRotateVec3(vector, a, vector)).toBe(vector);
    expectVec3Close(vector, expectedVector, 0);
  });
});

describe("Quat rotation and conversion", () => {
  test("[ER-02-04] fromAxisAngle rotates about a normalized axis", () => {
    const quat = quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 10), PI / 2);
    expectQuatEquivalent(quat, qz(PI / 2), 1e-12);
    const point = vec3Create();
    quatRotateVec3(point, quat, vec3Create(1, 0, 0));
    expectVec3Close(point, vec3Create(0, 1, 0), 1e-6);
    // Zero axis is the identity.
    expect(quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 0), 1)).toEqual({
      x: 0,
      y: 0,
      z: 0,
      w: 1,
    });
  });

  test("[ER-02-04] fromEulerYXZ is qY * qX * qZ", () => {
    const x = 0.3;
    const y = -0.7;
    const z = 1.1;
    const expected = quatMultiply(
      quatCreate(),
      quatMultiply(quatCreate(), qy(y), qx(x)),
      qz(z),
    );
    const actual = quatFromEulerYXZ(quatCreate(), x, y, z);
    expectQuatEquivalent(actual, expected, 1e-12);
  });

  test("[ER-02-04] quatToMat4 and quatToMat3 agree and normalize input", () => {
    const rotation = quatFromAxisAngle(quatCreate(), vec3Create(1, 2, 3), 0.9);
    const scaled = q(
      rotation.x * 3,
      rotation.y * 3,
      rotation.z * 3,
      rotation.w * 3,
    );
    const matrix4 = quatToMat4(mat4Create(), scaled);
    const matrix3 = quatToMat3(mat3Create(), scaled);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        near(m3(matrix3, row, column), m4(matrix4, row, column), 1e-6);
      }
    }
    // Zero quaternion writes identity in both sizes.
    const zeroMatrix4 = quatToMat4(mat4Create(), q(0, 0, 0, 0));
    near(m4(zeroMatrix4, 0, 0), 1, 0);
    near(m4(zeroMatrix4, 1, 1), 1, 0);
    near(m4(zeroMatrix4, 2, 2), 1, 0);
    near(m4(zeroMatrix4, 3, 3), 1, 0);
    const zeroMatrix3 = quatToMat3(mat3Create(), q(0, 0, 0, 0));
    near(m3(zeroMatrix3, 0, 0), 1, 0);
    near(m3(zeroMatrix3, 2, 2), 1, 0);
  });

  test("[ER-02-04] quatRotateVec3 matches the matrix transform", () => {
    const cases: readonly [Quat, Vec3][] = [
      [qx(0.4), vec3Create(1, 0, 0)],
      [qy(-1.2), vec3Create(0, 0, 1)],
      [qz(2.4), vec3Create(-1, 2, 0.5)],
      [q(0.1, -0.2, 0.3, 0.9), vec3Create(1.5, -2.5, 3.5)],
    ];
    for (const [rotation, vector] of cases) {
      const normalized = quatCreate();
      quatNormalize(normalized, rotation);
      const byQuat = vec3Create();
      quatRotateVec3(byQuat, normalized, vector);
      const matrix = quatToMat4(mat4Create(), normalized);
      const byMatrix = vec3Create();
      const m = matrix.m;
      const x = vector.x;
      const y = vector.y;
      const z = vector.z;
      byMatrix.x = at(m, 0) * x + at(m, 4) * y + at(m, 8) * z;
      byMatrix.y = at(m, 1) * x + at(m, 5) * y + at(m, 9) * z;
      byMatrix.z = at(m, 2) * x + at(m, 6) * y + at(m, 10) * z;
      expectVec3Close(byQuat, byMatrix, 1e-6);
    }
  });

  test("[ER-02-04] quatFromMat4 inverts quatToMat4 and rejects a mirror", () => {
    const rotation = quatFromAxisAngle(
      quatCreate(),
      vec3Create(-1, 2, 0.5),
      1.4,
    );
    const matrix = quatToMat4(mat4Create(), rotation);
    const out = quatCreate();
    expect(quatFromMat4(out, matrix)).toBe(true);
    expectQuatEquivalent(out, rotation, 1e-6);
    expect(out.w).toBeGreaterThanOrEqual(0);

    const mirrored = mat4FromScale(mat4Create(), vec3Create(-1, 1, 1));
    expect(quatFromMat4(quatCreate(), mirrored)).toBe(false);

    const sheared = mat4Identity(mat4Create());
    sheared.m[4] = 0.5;
    expect(quatFromMat4(quatCreate(), sheared)).toBe(false);
  });

  test("[ER-02-04] quatFromTo takes the shortest arc, including opposites", () => {
    const from = vec3Create(1, 0, 0);
    const to = vec3Create(0, 1, 0);
    const rotation = quatFromTo(quatCreate(), from, to);
    const point = vec3Create();
    quatRotateVec3(point, rotation, from);
    expectVec3Close(point, to, 1e-6);
    expect(quatFromTo(quatCreate(), from, from)).toEqual({
      x: 0,
      y: 0,
      z: 0,
      w: 1,
    });
    const opposite = quatFromTo(quatCreate(), from, vec3Create(-1, 0, 0));
    quatRotateVec3(point, opposite, from);
    expectVec3Close(point, vec3Create(-1, 0, 0), 1e-6);
    near(quatAngleBetween(opposite, quatCreate()), PI, 1e-6);
    expect(quatFromTo(quatCreate(), vec3Create(0, 0, 0), to)).toEqual({
      x: 0,
      y: 0,
      z: 0,
      w: 1,
    });
  });
});

describe("Quat interpolation", () => {
  test("[ER-02-04] slerp hits its endpoints exactly and clamps t", () => {
    const a = qz(0.2);
    const b = qx(1.4);
    expect(quatSlerp(quatCreate(), a, b, 0)).toEqual(a);
    expect(quatSlerp(quatCreate(), a, b, 1)).toEqual(b);
    expect(quatSlerp(quatCreate(), a, b, -1)).toEqual(a);
    expect(quatSlerp(quatCreate(), a, b, 2)).toEqual(b);
    const midpoint = quatSlerp(quatCreate(), a, b, 0.5);
    near(quatLength(midpoint), 1, 1e-9);
    near(
      quatAngleBetween(a, midpoint) + quatAngleBetween(midpoint, b),
      quatAngleBetween(a, b),
      1e-6,
    );
  });

  test("[ER-02-04] slerp takes the short way around when the dot is negative", () => {
    const a = quatCreate();
    const b = qz(PI / 3);
    const negated = q(-b.x, -b.y, -b.z, -b.w);
    const fromB = quatSlerp(quatCreate(), a, b, 0.4);
    const fromNegated = quatSlerp(quatCreate(), a, negated, 0.4);
    expectQuatEquivalent(fromB, fromNegated, 1e-9);
    near(quatAngleBetween(a, fromB), 0.4 * (PI / 3), 1e-6);
  });

  test("[ER-02-04] nlerp stays on the unit sphere and is not linear in angle", () => {
    const a = quatCreate();
    const b = qz(PI / 2);
    const out = quatNlerp(quatCreate(), a, b, 0.5);
    near(quatLength(out), 1, 1e-9);
    near(quatAngleBetween(a, out), PI / 4, 1e-6);
    expect(quatNlerp(quatCreate(), a, b, 0)).toEqual(a);
    expect(quatNlerp(quatCreate(), a, b, 1)).toEqual(b);
  });

  test("[ER-02-04] angleBetween is in [0, PI] and ignores the sign", () => {
    const a = qz(0.3);
    // acos near 1 amplifies the last-bit error in the dot product.
    near(quatAngleBetween(a, a), 0, 1e-6);
    near(quatAngleBetween(a, quatCreate()), 0.3, 1e-6);
    const opposite = q(-a.x, -a.y, -a.z, -a.w);
    near(quatAngleBetween(a, opposite), 0, 1e-6);
    near(quatAngleBetween(quatCreate(), qz(PI)), PI, 1e-6);
  });

  test("[ER-02-04] slerp/nlerp accept an aliased out", () => {
    const a = qz(0.2);
    const b = qx(1.1);
    const expectedSlerp = quatSlerp(quatCreate(), a, b, 0.3);
    const aliased = quatCopy(quatCreate(), a);
    expect(quatSlerp(aliased, aliased, b, 0.3)).toBe(aliased);
    expect(quatEquals(aliased, expectedSlerp, 0)).toBe(true);
    const expectedNlerp = quatNlerp(quatCreate(), a, b, 0.3);
    const aliasedB = quatCopy(quatCreate(), b);
    expect(quatNlerp(aliasedB, a, aliasedB, 0.3)).toBe(aliasedB);
    expect(quatEquals(aliasedB, expectedNlerp, 0)).toBe(true);
  });
});

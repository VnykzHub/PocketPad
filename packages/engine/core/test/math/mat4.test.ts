/**
 * 02 §3.5–§3.6 unit tests: Mat3, Mat4, compose/decompose.
 *
 * Titles carry ER-02-02 (matrix algebra, inverse, determinant) or ER-02-03
 * (compose → decompose → compose).
 */

import { describe, expect, test } from "vitest";
import {
  mat3Create,
  mat3Determinant,
  mat3Equals,
  mat3FromMat4,
  mat3Identity,
  mat3Invert,
  mat3Multiply,
  mat3Set,
  mat3TransformVec2,
  mat4Compose,
  mat4Copy,
  mat4Create,
  mat4Decompose,
  mat4Determinant,
  mat4Equals,
  mat4FromAxisAngle,
  mat4FromQuat,
  mat4FromRotationX,
  mat4FromRotationY,
  mat4FromRotationZ,
  mat4FromScale,
  mat4FromTranslation,
  mat4GetRotation,
  mat4GetScale,
  mat4GetTranslation,
  mat4Identity,
  mat4Invert,
  mat4Multiply,
  mat4Set,
  mat4TransformDirection,
  mat4TransformPoint,
  mat4TransformVec4,
  mat4Transpose,
  quatCreate,
  quatEquals,
  quatFromAxisAngle,
  quatToMat4,
  vec2Create,
  vec3Create,
  vec4Create,
} from "../../src/math/index.js";
import type { Mat3, Mat4, Quat, Vec3 } from "../../src/math/index.js";
import {
  at,
  expectQuatEquivalent,
  m3,
  m4,
  near,
  nearRelative,
} from "./helpers.js";

function expectMat4Close(
  actual: Mat4,
  expected: Mat4,
  tolerance: number = 1e-5,
): void {
  for (let i = 0; i < 16; i += 1) {
    near(at(actual.m, i), at(expected.m, i), tolerance, `m[${i}]`);
  }
}

function trs(position: Vec3, rotation: Quat, scale: Vec3): Mat4 {
  return mat4Compose(mat4Create(), position, rotation, scale);
}

function expectRoundTrip(position: Vec3, rotation: Quat, scale: Vec3): void {
  const matrix = trs(position, rotation, scale);
  const outPosition = vec3Create();
  const outRotation = quatCreate();
  const outScale = vec3Create();
  expect(mat4Decompose(outPosition, outRotation, outScale, matrix)).toBe(true);
  expectMat4Close(trs(outPosition, outRotation, outScale), matrix, 1e-5);
}

describe("Mat4 algebra", () => {
  test("[ER-02-02] create is zeroed and identity is the multiplicative neutral", () => {
    const zero = mat4Create();
    for (let i = 0; i < 16; i += 1) {
      expect(at(zero.m, i)).toBe(0);
    }
    const identity = mat4Identity(mat4Create());
    const a = trs(
      vec3Create(1, 2, 3),
      quatFromAxisAngle(quatCreate(), vec3Create(0, 1, 0), 0.7),
      vec3Create(2, 3, 4),
    );
    expect(mat4Equals(mat4Multiply(mat4Create(), identity, a), a)).toBe(true);
    expect(mat4Equals(mat4Multiply(mat4Create(), a, identity), a)).toBe(true);
  });

  test("[ER-02-02] multiply is a matrix product applied on the right", () => {
    const translation = mat4FromTranslation(
      mat4Create(),
      vec3Create(10, 20, 30),
    );
    const scale = mat4FromScale(mat4Create(), vec3Create(2, 3, 4));
    const combined = mat4Multiply(mat4Create(), translation, scale);
    const point = vec3Create();
    mat4TransformPoint(point, combined, vec3Create(1, 1, 1));
    // T * S: scale first, then translate.
    expect(point).toEqual({ x: 12, y: 23, z: 34 });
    // S * T would have scaled the translation instead.
    const reversed = mat4Multiply(mat4Create(), scale, translation);
    mat4TransformPoint(point, reversed, vec3Create(1, 1, 1));
    expect(point).toEqual({ x: 22, y: 63, z: 124 });
  });

  test("[ER-02-02] set and equals use column-major order", () => {
    const matrix = mat4Set(
      mat4Create(),
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
    );
    expect(m4(matrix, 0, 0)).toBe(1);
    expect(m4(matrix, 1, 0)).toBe(2);
    expect(m4(matrix, 0, 1)).toBe(5);
    expect(m4(matrix, 2, 3)).toBe(15);
    expect(m4(matrix, 3, 3)).toBe(16);
    expect(mat4Equals(matrix, matrix)).toBe(true);
    const shifted = mat4Copy(mat4Create(), matrix);
    shifted.m[15] = 16.5;
    expect(mat4Equals(matrix, shifted)).toBe(false);
    expect(mat4Equals(matrix, shifted, 1)).toBe(true);
  });

  test("[ER-02-02] invert round-trips and the determinant is multiplicative", () => {
    const a = trs(
      vec3Create(1, -2, 3.5),
      quatFromAxisAngle(quatCreate(), vec3Create(1, 2, 3), 0.9),
      vec3Create(2, 3, 4),
    );
    const b = trs(
      vec3Create(-4, 5, 0.5),
      quatFromAxisAngle(quatCreate(), vec3Create(-2, 1, 0), 1.2),
      vec3Create(0.5, 1.5, 2.5),
    );
    const inverse = mat4Create();
    expect(mat4Invert(inverse, a)).toBe(true);
    expectMat4Close(
      mat4Multiply(mat4Create(), a, inverse),
      mat4Identity(mat4Create()),
      1e-5,
    );
    expectMat4Close(
      mat4Multiply(mat4Create(), inverse, a),
      mat4Identity(mat4Create()),
      1e-5,
    );
    const product = mat4Multiply(mat4Create(), a, b);
    nearRelative(
      mat4Determinant(product),
      mat4Determinant(a) * mat4Determinant(b),
      1e-6,
      1e-4,
      "det(A*B)",
    );
  });

  test("[ER-02-02] a singular matrix inverts to a zeroed matrix and false", () => {
    const singular = mat4FromScale(mat4Create(), vec3Create(1, 0, 1));
    const out = mat4Create();
    expect(mat4Invert(out, singular)).toBe(false);
    for (let i = 0; i < 16; i += 1) {
      expect(at(out.m, i)).toBe(0);
    }
    expect(mat4Determinant(singular)).toBe(0);
  });

  test("[ER-02-02] transpose is an involution", () => {
    const a = trs(
      vec3Create(3, 4, 5),
      quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 1), 0.3),
      vec3Create(1, 2, 3),
    );
    const twice = mat4Transpose(mat4Create(), mat4Transpose(mat4Create(), a));
    expect(mat4Equals(twice, a, 0)).toBe(true);
  });

  test("[ER-02-02] multiply/invert/transpose/copy accept an aliased out", () => {
    const a = trs(
      vec3Create(1, 2, 3),
      quatFromAxisAngle(quatCreate(), vec3Create(0, 1, 0), 0.6),
      vec3Create(2, 2, 2),
    );
    const b = trs(
      vec3Create(-1, 0, 3),
      quatFromAxisAngle(quatCreate(), vec3Create(1, 0, 0), 0.2),
      vec3Create(1, 3, 1),
    );
    const expectedProduct = mat4Multiply(mat4Create(), a, b);

    const first = mat4Copy(mat4Create(), a);
    expect(mat4Multiply(first, first, b)).toBe(first);
    expectMat4Close(first, expectedProduct, 0);

    const second = mat4Copy(mat4Create(), b);
    expect(mat4Multiply(second, a, second)).toBe(second);
    expectMat4Close(second, expectedProduct, 0);

    const expectedInverse = mat4Create();
    expect(mat4Invert(expectedInverse, a)).toBe(true);
    const inverted = mat4Copy(mat4Create(), a);
    expect(mat4Invert(inverted, inverted)).toBe(true);
    expectMat4Close(inverted, expectedInverse, 0);

    const transposed = mat4Copy(mat4Create(), a);
    expect(mat4Transpose(transposed, transposed)).toBe(transposed);
    expectMat4Close(transposed, mat4Transpose(mat4Create(), a), 0);

    const copied = mat4Copy(mat4Create(), a);
    expect(mat4Copy(copied, copied)).toBe(copied);
    expectMat4Close(copied, a, 0);
  });
});

describe("Mat3", () => {
  function rotationZ90(): Mat3 {
    // Columns of a +90 degree rotation about +Z.
    return mat3Set(mat3Create(), 0, 1, 0, -1, 0, 0, 0, 0, 1);
  }

  test("[ER-02-02] multiply composes linear maps and respects column order", () => {
    const rotation = rotationZ90();
    const scale = mat3Set(mat3Create(), 2, 0, 0, 0, 3, 0, 0, 0, 4);
    const product = mat3Multiply(mat3Create(), rotation, scale);
    expect(m3(product, 0, 0)).toBe(0);
    expect(m3(product, 1, 0)).toBe(2);
    expect(m3(product, 0, 1)).toBe(-3);
    expect(m3(product, 1, 1)).toBe(0);
    expect(m3(product, 2, 2)).toBe(4);
    expect(
      mat3Equals(mat3Multiply(mat3Create(), rotation, scale), product),
    ).toBe(true);
  });

  test("[ER-02-02] determinant and inverse follow the 3x3 cofactor rules", () => {
    const rotation = rotationZ90();
    const scale = mat3Set(mat3Create(), 2, 0, 0, 0, 3, 0, 0, 0, 4);
    near(mat3Determinant(rotation), 1, 1e-6);
    near(mat3Determinant(scale), 24, 1e-6);
    const inverse = mat3Create();
    expect(mat3Invert(inverse, rotation)).toBe(true);
    expect(
      mat3Equals(
        mat3Multiply(mat3Create(), inverse, rotation),
        mat3Identity(mat3Create()),
        1e-6,
      ),
    ).toBe(true);
    // R^-1 is the transpose for a rotation.
    expect(
      mat3Equals(inverse, mat3Set(mat3Create(), 0, -1, 0, 1, 0, 0, 0, 0, 1)),
    ).toBe(true);
  });

  test("[ER-02-02] a singular Mat3 inverts to zero and false", () => {
    const singular = mat3Set(mat3Create(), 1, 0, 0, 0, 0, 0, 0, 0, 1);
    const out = mat3Set(mat3Create(), 9, 9, 9, 9, 9, 9, 9, 9, 9);
    expect(mat3Invert(out, singular)).toBe(false);
    for (let i = 0; i < 9; i += 1) {
      expect(at(out.m, i)).toBe(0);
    }
  });

  test("[ER-02-02] fromMat4 copies the upper-left 3x3", () => {
    const source = mat4Set(
      mat4Create(),
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
    );
    const out = mat3FromMat4(mat3Create(), source);
    expect(m3(out, 0, 0)).toBe(1);
    expect(m3(out, 1, 0)).toBe(2);
    expect(m3(out, 2, 0)).toBe(3);
    expect(m3(out, 0, 1)).toBe(5);
    expect(m3(out, 1, 1)).toBe(6);
    expect(m3(out, 2, 1)).toBe(7);
    expect(m3(out, 0, 2)).toBe(9);
    expect(m3(out, 2, 2)).toBe(11);
  });

  test("[ER-02-02] transformVec2 applies only the 2x2 block", () => {
    const rotation = rotationZ90();
    const point = mat3TransformVec2(vec2Create(), rotation, vec2Create(1, 0));
    near(point.x, 0, 1e-6);
    near(point.y, 1, 1e-6);
  });

  test("[ER-02-02] Mat3 out-parameters accept an aliased input", () => {
    const rotation = rotationZ90();
    const expected = mat3Multiply(mat3Create(), rotation, rotation);
    const aliasedProduct = rotationZ90();
    expect(
      mat3Multiply(aliasedProduct, aliasedProduct, aliasedProduct),
    ).toEqual(expected);
    const expectedInverse = mat3Create();
    expect(mat3Invert(expectedInverse, rotation)).toBe(true);
    const inverted = rotationZ90();
    expect(mat3Invert(inverted, inverted)).toBe(true);
    expect(mat3Equals(inverted, expectedInverse, 0)).toBe(true);
  });
});

describe("Mat4 builders and transforms", () => {
  test("[ER-02-02] fromAxisAngle agrees with quatFromAxisAngle + quatToMat4", () => {
    const axis = vec3Create(1, 2, 3);
    const radians = 0.85;
    const fromAxis = mat4FromAxisAngle(mat4Create(), axis, radians);
    const quat = quatFromAxisAngle(quatCreate(), axis, radians);
    const fromQuat = mat4Create();
    mat4FromQuat(fromQuat, quat);
    expectMat4Close(fromAxis, fromQuat, 1e-6);
    expectMat4Close(
      mat4FromQuat(mat4Create(), quatCreate()),
      mat4Identity(mat4Create()),
      1e-6,
    );
    // A degenerate axis produces the identity, not NaN.
    expectMat4Close(
      mat4FromAxisAngle(mat4Create(), vec3Create(0, 0, 0), 1),
      mat4Identity(mat4Create()),
      0,
    );
    // quatToMat4 is the same builder reachable through Mat4.ts.
    expectMat4Close(mat4FromQuat(mat4Create(), quat), quatToMat4(mat4Create(), quat), 0);
  });

  test("[ER-02-02] axis rotation builders follow the right-hand rule", () => {
    const quarterTurn = Math.PI / 2;
    const xPoint = vec3Create();
    mat4TransformPoint(
      xPoint,
      mat4FromRotationX(mat4Create(), quarterTurn),
      vec3Create(0, 1, 0),
    );
    near(xPoint.x, 0, 1e-6);
    near(xPoint.y, 0, 1e-6);
    near(xPoint.z, 1, 1e-6);

    const yPoint = vec3Create();
    mat4TransformPoint(
      yPoint,
      mat4FromRotationY(mat4Create(), quarterTurn),
      vec3Create(1, 0, 0),
    );
    near(yPoint.x, 0, 1e-6);
    near(yPoint.z, -1, 1e-6);

    const zPoint = vec3Create();
    mat4TransformPoint(
      zPoint,
      mat4FromRotationZ(mat4Create(), quarterTurn),
      vec3Create(1, 0, 0),
    );
    near(zPoint.x, 0, 1e-6);
    near(zPoint.y, 1, 1e-6);
  });

  test("[ER-02-02] transformPoint applies translation; transformDirection does not", () => {
    const matrix = trs(
      vec3Create(10, 20, 30),
      quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 1), Math.PI / 2),
      vec3Create(1, 1, 1),
    );
    const point = vec3Create();
    mat4TransformPoint(point, matrix, vec3Create(1, 0, 0));
    near(point.x, 10, 1e-6);
    near(point.y, 21, 1e-6);
    near(point.z, 30, 1e-6);
    const direction = vec3Create();
    mat4TransformDirection(direction, matrix, vec3Create(1, 0, 0));
    near(direction.x, 0, 1e-6);
    near(direction.y, 1, 1e-6);
    near(direction.z, 0, 1e-6);
  });

  test("[ER-02-02] transformVec4 divides by a finite non-zero w", () => {
    const matrix = mat4Set(
      mat4Create(),
      2,
      0,
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      0,
      2,
      0,
      0,
      0,
      0,
      2,
    );
    const out = vec4Create();
    mat4TransformVec4(out, matrix, vec4Create(2, 4, 6, 4));
    near(out.x, 0.5, 1e-6);
    near(out.y, 1, 1e-6);
    near(out.z, 1.5, 1e-6);
    near(out.w, 1, 1e-6);
  });
});

describe("Mat4 compose/decompose", () => {
  test("[ER-02-03] compose is T * R * S and applies scale before rotation", () => {
    const rotation = quatFromAxisAngle(
      quatCreate(),
      vec3Create(0, 0, 1),
      Math.PI / 2,
    );
    const matrix = trs(vec3Create(10, 20, 30), rotation, vec3Create(2, 3, 4));
    // Column 0 = R * (2,0,0) = (0,2,0); column 1 = R * (0,3,0) = (-3,0,0).
    near(m4(matrix, 0, 0), 0, 1e-6);
    near(m4(matrix, 1, 0), 2, 1e-6);
    near(m4(matrix, 0, 1), -3, 1e-6);
    near(m4(matrix, 1, 1), 0, 1e-6);
    near(m4(matrix, 2, 2), 4, 1e-6);
    expect(m4(matrix, 0, 3)).toBe(10);
    expect(m4(matrix, 1, 3)).toBe(20);
    expect(m4(matrix, 2, 3)).toBe(30);
    expect(m4(matrix, 3, 3)).toBe(1);
    const point = vec3Create();
    mat4TransformPoint(point, matrix, vec3Create(1, 0, 0));
    near(point.x, 10, 1e-6);
    near(point.y, 22, 1e-6);
    near(point.z, 30, 1e-6);
  });

  test("[ER-02-03] compose then decompose then compose reproduces the matrix", () => {
    expectRoundTrip(
      vec3Create(1, 2, 3),
      quatFromAxisAngle(quatCreate(), vec3Create(0, 1, 0), 0.5),
      vec3Create(2, 3, 4),
    );
    expectRoundTrip(
      vec3Create(-4.5, 0.25, 8),
      quatFromAxisAngle(quatCreate(), vec3Create(1, 2, 3), 2.1),
      vec3Create(0.5, 1.5, 3),
    );
    expectRoundTrip(vec3Create(0, 0, 0), quatCreate(), vec3Create(1, 1, 1));
  });

  test("[ER-02-03] a negative scale is folded into scale.x and still round-trips", () => {
    const rotation = quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 1), 0.4);
    const matrix = trs(vec3Create(5, 6, 7), rotation, vec3Create(-2, 3, 4));
    const position = vec3Create();
    const outRotation = quatCreate();
    const scale = vec3Create();
    expect(mat4Decompose(position, outRotation, scale, matrix)).toBe(true);
    near(scale.x, -2, 1e-5);
    near(scale.y, 3, 1e-5);
    near(scale.z, 4, 1e-5);
    expect(position).toEqual({ x: 5, y: 6, z: 7 });
    expectQuatEquivalent(outRotation, rotation, 1e-5);
    expectRoundTrip(vec3Create(5, 6, 7), rotation, vec3Create(-2, 3, 4));
  });

  test("[ER-02-03] singular and sheared matrices fail without writing NaN", () => {
    const zeroScale = mat4FromScale(mat4Create(), vec3Create(1, 0, 1));
    const position = vec3Create(9, 9, 9);
    const rotation = quatCreate();
    const scale = vec3Create(9, 9, 9);
    expect(mat4Decompose(position, rotation, scale, zeroScale)).toBe(false);
    expect(Number.isFinite(position.x)).toBe(true);
    expect(Number.isFinite(rotation.w)).toBe(true);
    expect(Number.isFinite(scale.x)).toBe(true);

    const sheared = mat4Identity(mat4Create());
    sheared.m[4] = 0.25;
    expect(
      mat4Decompose(vec3Create(), quatCreate(), vec3Create(), sheared),
    ).toBe(false);
  });

  test("[ER-02-03] getters return translation, scale and rotation", () => {
    const rotation = quatFromAxisAngle(quatCreate(), vec3Create(0, 0, 1), 1.1);
    const matrix = trs(vec3Create(7, -8, 9), rotation, vec3Create(2, 3, 4));
    const translation = vec3Create();
    mat4GetTranslation(translation, matrix);
    expect(translation).toEqual({ x: 7, y: -8, z: 9 });
    const scale = vec3Create();
    mat4GetScale(scale, matrix);
    near(scale.x, 2, 1e-5);
    near(scale.y, 3, 1e-5);
    near(scale.z, 4, 1e-5);
    const outRotation = quatCreate();
    expect(mat4GetRotation(outRotation, matrix)).toBe(true);
    expectQuatEquivalent(outRotation, rotation, 1e-5);
    // The returned quaternion has w >= 0 (deterministic sign).
    expect(outRotation.w).toBeGreaterThanOrEqual(0);
    expect(quatEquals(outRotation, quatCreate())).toBe(false);
  });

  test("[ER-02-03] getRotation accepts a mirrored (negative-scale) matrix", () => {
    const rotation = quatFromAxisAngle(quatCreate(), vec3Create(1, 0, 0), 0.3);
    const matrix = trs(vec3Create(0, 0, 0), rotation, vec3Create(-1, 1, 1));
    const outRotation = quatCreate();
    expect(mat4GetRotation(outRotation, matrix)).toBe(true);
    expectQuatEquivalent(outRotation, rotation, 1e-5);
  });
});

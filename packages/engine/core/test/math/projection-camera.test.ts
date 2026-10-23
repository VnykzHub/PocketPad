/**
 * 02 §3.6 camera and projection unit tests.
 *
 * ER-02-05: both projection families and the near/far depth mapping.
 * ER-02-06: right-handed lookAt, −Z forward, +Y up, orthonormal basis.
 *
 * Golden fixture values live in `conformance.test.ts`; this file pins the
 * structural properties and the dev argument contracts.
 */

import { describe, expect, test } from "vitest";
import {
  PI,
  mat4Create,
  mat4Identity,
  mat4LookAt,
  mat4OrthographicWebGL2,
  mat4OrthographicWebGPU,
  mat4PerspectiveWebGL2,
  mat4PerspectiveWebGPU,
  mat4TransformVec4,
  vec3Create,
  vec4Create,
} from "../../src/math/index.js";
import type { Mat4, Vec4 } from "../../src/math/index.js";
import { at, m4, near } from "./helpers.js";

function expectMat4Close(
  actual: Mat4,
  expected: Mat4,
  tolerance: number = 1e-6,
): void {
  for (let i = 0; i < 16; i += 1) {
    near(at(actual.m, i), at(expected.m, i), tolerance, `m[${i}]`);
  }
}

function project(matrix: Mat4, x: number, y: number, z: number): Vec4 {
  return mat4TransformVec4(vec4Create(), matrix, vec4Create(x, y, z, 1));
}

function expectOrthonormalRotation(
  matrix: Mat4,
  tolerance: number = 1e-6,
): void {
  const r0x = at(matrix.m, 0);
  const r0y = at(matrix.m, 4);
  const r0z = at(matrix.m, 8);
  const r1x = at(matrix.m, 1);
  const r1y = at(matrix.m, 5);
  const r1z = at(matrix.m, 9);
  const r2x = at(matrix.m, 2);
  const r2y = at(matrix.m, 6);
  const r2z = at(matrix.m, 10);
  near(r0x * r0x + r0y * r0y + r0z * r0z, 1, tolerance);
  near(r1x * r1x + r1y * r1y + r1z * r1z, 1, tolerance);
  near(r2x * r2x + r2y * r2y + r2z * r2z, 1, tolerance);
  near(r0x * r1x + r0y * r1y + r0z * r1z, 0, tolerance);
  near(r0x * r2x + r0y * r2y + r0z * r2z, 0, tolerance);
  near(r1x * r2x + r1y * r2y + r1z * r2z, 0, tolerance);
  // Right-handed: row0 · (row1 × row2) must be +1.
  const crossX = r1y * r2z - r1z * r2y;
  const crossY = r1z * r2x - r1x * r2z;
  const crossZ = r1x * r2y - r1y * r2x;
  near(r0x * crossX + r0y * crossY + r0z * crossZ, 1, tolerance);
}

describe("Perspective projections", () => {
  test("[ER-02-05] WebGL2 perspective maps near to -1 and far to +1", () => {
    const matrix = mat4PerspectiveWebGL2(mat4Create(), PI / 2, 1, 1, 5);
    const nearPoint = project(matrix, 0, 0, -1);
    near(nearPoint.x, 0, 1e-6);
    near(nearPoint.y, 0, 1e-6);
    near(nearPoint.z, -1, 1e-6);
    near(nearPoint.w, 1, 1e-6);
    const farPoint = project(matrix, 0, 0, -5);
    near(farPoint.z, 1, 1e-6);
    near(farPoint.w, 1, 1e-6);
    // fovY = 90 degrees at aspect 1: a point one unit off axis at z = -1 is
    // exactly on the right edge.
    const edge = project(matrix, 1, 0, -1);
    near(edge.x, 1, 1e-6);
    // Depth is stored in the matrix, not implied by position.
    near(m4(matrix, 2, 2), -1.5, 1e-6);
    near(m4(matrix, 2, 3), -2.5, 1e-6);
    near(m4(matrix, 3, 2), -1, 1e-6);
  });

  test("[ER-02-05] WebGPU perspective maps near to 0 and far to +1", () => {
    const matrix = mat4PerspectiveWebGPU(mat4Create(), PI / 2, 1, 1, 5);
    near(project(matrix, 0, 0, -1).z, 0, 1e-6);
    near(project(matrix, 0, 0, -5).z, 1, 1e-6);
    near(m4(matrix, 2, 2), -1.25, 1e-6);
    near(m4(matrix, 2, 3), -1.25, 1e-6);
    // The two families differ only in the depth column.
    const webgl = mat4PerspectiveWebGL2(mat4Create(), PI / 2, 1, 1, 5);
    for (let column = 0; column < 2; column += 1) {
      for (let row = 0; row < 4; row += 1) {
        near(m4(matrix, row, column), m4(webgl, row, column), 0);
      }
    }
  });

  test("[ER-02-05] perspective aspect scales x only", () => {
    const matrix = mat4PerspectiveWebGL2(mat4Create(), PI / 2, 2, 1, 5);
    near(project(matrix, 1, 0, -1).x, 0.5, 1e-6);
    near(project(matrix, 0, 1, -1).y, 1, 1e-6);
    near(m4(matrix, 0, 0), 0.5, 1e-6);
    near(m4(matrix, 1, 1), 1, 1e-6);
  });

  test("[ER-02-05] perspective rejects out-of-range arguments in dev", () => {
    const out = mat4Create();
    expect(() => mat4PerspectiveWebGL2(out, 0, 1, 1, 5)).toThrow(RangeError);
    expect(() => mat4PerspectiveWebGL2(out, PI, 1, 1, 5)).toThrow(RangeError);
    expect(() => mat4PerspectiveWebGL2(out, PI / 2, 0, 1, 5)).toThrow(
      RangeError,
    );
    expect(() => mat4PerspectiveWebGL2(out, PI / 2, 1, 0, 5)).toThrow(
      RangeError,
    );
    expect(() => mat4PerspectiveWebGL2(out, PI / 2, 1, 5, 5)).toThrow(
      RangeError,
    );
    expect(() => mat4PerspectiveWebGPU(out, -0.1, 1, 1, 5)).toThrow(
      RangeError,
    );
  });
});

describe("Orthographic projections", () => {
  test("[ER-02-05] WebGL2 ortho maps the box to [-1,1] on all axes", () => {
    const matrix = mat4OrthographicWebGL2(
      mat4Create(),
      -2,
      2,
      -1,
      1,
      1,
      5,
    );
    const nearCorner = project(matrix, -2, -1, -1);
    near(nearCorner.x, -1, 1e-6);
    near(nearCorner.y, -1, 1e-6);
    near(nearCorner.z, -1, 1e-6);
    const farCorner = project(matrix, 2, 1, -5);
    near(farCorner.x, 1, 1e-6);
    near(farCorner.y, 1, 1e-6);
    near(farCorner.z, 1, 1e-6);
    near(project(matrix, 0, 0, -3).z, 0, 1e-6);
    near(m4(matrix, 2, 2), -0.5, 1e-6);
    near(m4(matrix, 2, 3), -1.5, 1e-6);
    near(m4(matrix, 3, 3), 1, 0);
  });

  test("[ER-02-05] WebGPU ortho maps near to 0 and far to +1", () => {
    const matrix = mat4OrthographicWebGPU(
      mat4Create(),
      -2,
      2,
      -1,
      1,
      1,
      5,
    );
    near(project(matrix, 0, 0, -1).z, 0, 1e-6);
    near(project(matrix, 0, 0, -5).z, 1, 1e-6);
    near(m4(matrix, 2, 2), -0.25, 1e-6);
    near(m4(matrix, 2, 3), -0.25, 1e-6);
    // x/y are identical to the WebGL2 family.
    near(m4(matrix, 0, 0), 0.5, 1e-6);
    near(m4(matrix, 1, 1), 1, 1e-6);
  });

  test("[ER-02-05] ortho rejects a zero-width view in dev", () => {
    const out = mat4Create();
    expect(() => mat4OrthographicWebGL2(out, 1, 1, -1, 1, 1, 5)).toThrow(
      RangeError,
    );
    expect(() => mat4OrthographicWebGPU(out, 1, 1, -1, 1, 1, 5)).toThrow(
      RangeError,
    );
  });
});

describe("lookAt", () => {
  test("[ER-02-06] looking down -Z from +Z is the identity rotation", () => {
    const view = mat4Create();
    mat4LookAt(
      view,
      vec3Create(0, 0, 5),
      vec3Create(0, 0, 0),
      vec3Create(0, 1, 0),
    );
    const expected = mat4Identity(mat4Create());
    expected.m[14] = -5;
    expectMat4Close(view, expected, 1e-6);
    // The target lands on the -Z axis, the eye at the origin.
    const target = project(view, 0, 0, 0);
    near(target.x, 0, 1e-6);
    near(target.y, 0, 1e-6);
    near(target.z, -5, 1e-6);
    near(target.w, 1, 1e-6);
    const eye = project(view, 0, 0, 5);
    near(eye.x, 0, 1e-6);
    near(eye.y, 0, 1e-6);
    near(eye.z, 0, 1e-6);
  });

  test("[ER-02-06] the rotation basis is orthonormal and right-handed", () => {
    const view = mat4Create();
    mat4LookAt(
      view,
      vec3Create(3, 4, 5),
      vec3Create(-1, 2, 0),
      vec3Create(0, 1, 0),
    );
    expectOrthonormalRotation(view);
    // The eye always maps to the origin.
    const eye = project(view, 3, 4, 5);
    near(eye.x, 0, 1e-6);
    near(eye.y, 0, 1e-6);
    near(eye.z, 0, 1e-6);
  });

  test("[ER-02-06] +Y up maps to camera up and forward keeps its length", () => {
    const view = mat4Create();
    mat4LookAt(
      view,
      vec3Create(0, 0, 5),
      vec3Create(0, 0, 0),
      vec3Create(0, 1, 0),
    );
    // A point one unit above the eye is above the camera centre.
    const upPoint = project(view, 0, 1, 5);
    near(upPoint.x, 0, 1e-6);
    near(upPoint.y, 1, 1e-6);
    // The view rotation preserves distances.
    const arbitrary = project(view, 2, 3, 5);
    near(
      Math.sqrt(
        arbitrary.x * arbitrary.x +
          arbitrary.y * arbitrary.y +
          arbitrary.z * arbitrary.z,
      ),
      Math.sqrt(13),
      1e-6,
    );
  });

  test("[ER-02-06] non-unit up is normalized", () => {
    const unitUp = mat4Create();
    const longUp = mat4Create();
    mat4LookAt(
      unitUp,
      vec3Create(1, 2, 3),
      vec3Create(4, -1, 2),
      vec3Create(0, 1, 0),
    );
    mat4LookAt(
      longUp,
      vec3Create(1, 2, 3),
      vec3Create(4, -1, 2),
      vec3Create(0, 7, 0),
    );
    expectMat4Close(longUp, unitUp, 1e-6);
  });

  test("[ER-02-06] eye equal to target is the identity", () => {
    const view = mat4Create();
    mat4LookAt(
      view,
      vec3Create(5, 5, 5),
      vec3Create(5, 5, 5),
      vec3Create(0, 1, 0),
    );
    expectMat4Close(view, mat4Identity(mat4Create()), 0);
  });

  test("[ER-02-06] a zero up falls back to +Y", () => {
    const zeroUp = mat4Create();
    const plusY = mat4Create();
    mat4LookAt(
      zeroUp,
      vec3Create(1, 2, 3),
      vec3Create(4, 5, 6),
      vec3Create(0, 0, 0),
    );
    mat4LookAt(
      plusY,
      vec3Create(1, 2, 3),
      vec3Create(4, 5, 6),
      vec3Create(0, 1, 0),
    );
    expectMat4Close(zeroUp, plusY, 1e-6);
  });

  test("[ER-02-06] a forward parallel to up produces a finite orthonormal view", () => {
    const view = mat4Create();
    mat4LookAt(
      view,
      vec3Create(0, 10, 0),
      vec3Create(0, 0, 0),
      vec3Create(0, 1, 0),
    );
    for (let i = 0; i < 16; i += 1) {
      expect(Number.isFinite(at(view.m, i))).toBe(true);
    }
    expectOrthonormalRotation(view);
    // The target is 10 units straight ahead on -Z.
    const target = project(view, 0, 0, 0);
    near(target.x, 0, 1e-6);
    near(target.y, 0, 1e-6);
    near(target.z, -10, 1e-6);
  });
});

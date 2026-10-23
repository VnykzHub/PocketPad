/**
 * 02 §7 ER-02-02 property tests: mat4 algebra.
 *
 * `mat4Multiply` is associative within 1e-5, `M * I = M` exactly,
 * `M * inverse(M) = I` within 1e-5 for 10,000 well-conditioned TRS matrices,
 * and `det(A*B) = det(A)*det(B)`.
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  mat4Compose,
  mat4Create,
  mat4Determinant,
  mat4Identity,
  mat4Invert,
  mat4Multiply,
} from "../../src/math/index.js";
import type { Mat4 } from "../../src/math/index.js";
import { at, near, nearRelative, trsArb } from "./helpers.js";

function expectMatrixClose(
  actual: Mat4,
  expected: Mat4,
  tolerance: number,
  label: string,
): void {
  for (let index = 0; index < 16; index += 1) {
    near(
      at(actual.m, index),
      at(expected.m, index),
      tolerance,
      `${label} m[${index}]`,
    );
  }
}

function composed(trs: {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  scale: { x: number; y: number; z: number };
}): Mat4 {
  return mat4Compose(mat4Create(), trs.position, trs.rotation, trs.scale);
}

/** Scale away from zero keeps the inverse product well conditioned. */
function invertibleTrsArb() {
  return fc
    .tuple(
      fc.record({
        x: fc.double({
          min: -4,
          max: 4,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        y: fc.double({
          min: -4,
          max: 4,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        z: fc.double({
          min: -4,
          max: 4,
          noNaN: true,
          noDefaultInfinity: true,
        }),
      }),
      fc.record({
        x: fc.double({
          min: -1,
          max: 1,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        y: fc.double({
          min: -1,
          max: 1,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        z: fc.double({
          min: -1,
          max: 1,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        w: fc.double({
          min: -1,
          max: 1,
          noNaN: true,
          noDefaultInfinity: true,
        }),
      }),
      fc.tuple(
        fc.double({
          min: 0.75,
          max: 2,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        fc.double({
          min: 0.75,
          max: 2,
          noNaN: true,
          noDefaultInfinity: true,
        }),
        fc.double({
          min: 0.75,
          max: 2,
          noNaN: true,
          noDefaultInfinity: true,
        }),
      ),
      fc.boolean(),
    )
    .filter(
      ([, rotation]) =>
        rotation.x * rotation.x +
          rotation.y * rotation.y +
          rotation.z * rotation.z +
          rotation.w * rotation.w >
        0.1,
    )
    .map(([position, rotation, scale, flipX]) => ({
      position,
      rotation,
      scale: {
        x: flipX ? -scale[0] : scale[0],
        y: scale[1],
        z: scale[2],
      },
    }));
}

describe("mat4Multiply properties", () => {
  test("[ER-02-02] multiplication is associative within 1e-5", () => {
    fc.assert(
      fc.property(trsArb(), trsArb(), trsArb(), (a, b, c) => {
        const aMatrix = composed(a);
        const bMatrix = composed(b);
        const cMatrix = composed(c);
        const ab = mat4Multiply(mat4Create(), aMatrix, bMatrix);
        const bc = mat4Multiply(mat4Create(), bMatrix, cMatrix);
        const left = mat4Multiply(mat4Create(), ab, cMatrix);
        const right = mat4Multiply(mat4Create(), aMatrix, bc);
        for (let index = 0; index < 16; index += 1) {
          nearRelative(
            at(left.m, index),
            at(right.m, index),
            1e-5,
            1e-5,
            `m[${index}]`,
          );
        }
      }),
      { numRuns: 10_000 },
    );
  });

  test("[ER-02-02] multiplying by the identity is exact", () => {
    fc.assert(
      fc.property(trsArb(), (a) => {
        const matrix = composed(a);
        const identity = mat4Identity(mat4Create());
        expectMatrixClose(
          mat4Multiply(mat4Create(), matrix, identity),
          matrix,
          0,
          "right identity",
        );
        expectMatrixClose(
          mat4Multiply(mat4Create(), identity, matrix),
          matrix,
          0,
          "left identity",
        );
      }),
      { numRuns: 10_000 },
    );
  });

  test("[ER-02-02] M * inverse(M) is the identity within 1e-5", () => {
    fc.assert(
      fc.property(invertibleTrsArb(), (trs) => {
        const matrix = composed(trs);
        const inverse = mat4Create();
        expect(mat4Invert(inverse, matrix)).toBe(true);
        const product = mat4Multiply(mat4Create(), matrix, inverse);
        expectMatrixClose(
          product,
          mat4Identity(mat4Create()),
          1e-5,
          "M * M^-1",
        );
        const reversed = mat4Multiply(mat4Create(), inverse, matrix);
        expectMatrixClose(
          reversed,
          mat4Identity(mat4Create()),
          1e-5,
          "M^-1 * M",
        );
      }),
      { numRuns: 10_000 },
    );
  });

  test("[ER-02-02] determinant is multiplicative", () => {
    fc.assert(
      fc.property(trsArb(), trsArb(), (a, b) => {
        const aMatrix = composed(a);
        const bMatrix = composed(b);
        const product = mat4Multiply(mat4Create(), aMatrix, bMatrix);
        nearRelative(
          mat4Determinant(product),
          mat4Determinant(aMatrix) * mat4Determinant(bMatrix),
          1e-5,
          1e-5,
          "det(A*B)",
        );
      }),
      { numRuns: 10_000 },
    );
  });
});

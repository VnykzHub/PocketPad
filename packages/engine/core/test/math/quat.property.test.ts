/**
 * 02 §7 ER-02-04 property tests: quaternion rotation and interpolation.
 *
 * `quatRotateVec3` must match the matrix path for 10,000 unit quaternions;
 * slerp endpoints are exact and every path is the short arc.
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  mat4Create,
  mat4FromQuat,
  mat4TransformDirection,
  quatAngleBetween,
  quatCreate,
  quatDot,
  quatEquals,
  quatLength,
  quatRotateVec3,
  quatSlerp,
  vec3Create,
} from "../../src/math/index.js";
import type { Quat } from "../../src/math/index.js";
import {
  expectQuatEquivalent,
  expectVec3Close,
  near,
  unitQuatArb,
  unitVec3Arb,
} from "./helpers.js";

function negated(q: Quat): Quat {
  return quatCreate(-q.x, -q.y, -q.z, -q.w);
}

const unitInterval = fc.double({
  min: 0,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

describe("Quaternion rotation properties", () => {
  test("[ER-02-04] quatRotateVec3 matches the matrix path for 10,000 unit quaternions", () => {
    fc.assert(
      fc.property(unitQuatArb(), unitVec3Arb(), (rotation, vector) => {
        const byQuat = quatRotateVec3(vec3Create(), rotation, vector);
        const matrix = mat4FromQuat(mat4Create(), rotation);
        const byMatrix = mat4TransformDirection(vec3Create(), matrix, vector);
        expectVec3Close(byQuat, byMatrix, 1e-6, "rotation path");
        // Rotation preserves length.
        const length = Math.sqrt(
          byQuat.x * byQuat.x + byQuat.y * byQuat.y + byQuat.z * byQuat.z,
        );
        near(length, 1, 1e-6, "preserved length");
      }),
      { numRuns: 10_000 },
    );
  });
});

describe("Quaternion slerp properties", () => {
  test("[ER-02-04] slerp endpoints are exact", () => {
    fc.assert(
      fc.property(unitQuatArb(), unitQuatArb(), (a, b) => {
        expect(quatEquals(quatSlerp(quatCreate(), a, b, 0), a, 0)).toBe(true);
        expect(quatEquals(quatSlerp(quatCreate(), a, b, 1), b, 0)).toBe(true);
        expect(quatLength(quatSlerp(quatCreate(), a, b, 0.37))).toBeCloseTo(
          1,
          7,
        );
      }),
      { numRuns: 10_000 },
    );
  });

  test("[ER-02-04] slerp never takes the long way around", () => {
    fc.assert(
      fc.property(
        unitQuatArb(),
        unitQuatArb(),
        unitInterval,
        (a, b, t) => {
          const total = quatAngleBetween(a, b);
          const out = quatSlerp(quatCreate(), a, b, t);
          const first = quatAngleBetween(a, out);
          const second = quatAngleBetween(out, b);
          expect(first, "first leg").toBeLessThanOrEqual(total + 1e-6);
          expect(second, "second leg").toBeLessThanOrEqual(total + 1e-6);
          near(first + second, total, 1e-4, "short arc split");
        },
      ),
      { numRuns: 10_000 },
    );
  });

  test("[ER-02-04] negating an endpoint does not change the interpolated rotation", () => {
    fc.assert(
      fc.property(
        unitQuatArb(),
        unitQuatArb(),
        unitInterval,
        (a, b, t) => {
          fc.pre(Math.abs(quatDot(a, b)) > 0.1);
          const direct = quatSlerp(quatCreate(), a, b, t);
          const flipped = quatSlerp(quatCreate(), a, negated(b), t);
          expectQuatEquivalent(direct, flipped, 1e-6);
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

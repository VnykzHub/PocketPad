/**
 * 02 §7 ER-02-06 property tests: right-handed lookAt.
 *
 * For 10,000 non-collinear eye/target/up triples, `mat4LookAt` maps the target
 * to -Z, keeps `up` in the camera's +Y hemisphere, and produces an orthonormal
 * right-handed basis within 1e-6.
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  mat4Create,
  mat4LookAt,
  mat4TransformDirection,
  mat4TransformPoint,
  vec3Create,
} from "../../src/math/index.js";
import { m4, near, smallVec3Arb, unitVec3Arb } from "./helpers.js";

function dot(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  return ax * bx + ay * by + az * bz;
}

const distanceArb = fc.double({
  min: 0.5,
  max: 10,
  noNaN: true,
  noDefaultInfinity: true,
});

describe("lookAt properties", () => {
  test("[ER-02-06] target maps to -Z and up stays in the +Y hemisphere", () => {
    fc.assert(
      fc.property(
        smallVec3Arb(),
        unitVec3Arb(),
        unitVec3Arb(),
        distanceArb,
        (eye, forward, up, distance) => {
          fc.pre(
            Math.abs(
              forward.x * up.x + forward.y * up.y + forward.z * up.z,
            ) < 0.95,
          );
          const target = vec3Create(
            eye.x + forward.x * distance,
            eye.y + forward.y * distance,
            eye.z + forward.z * distance,
          );
          const view = mat4LookAt(mat4Create(), eye, target, up);

          const cameraTarget = mat4TransformPoint(vec3Create(), view, target);
          near(cameraTarget.x, 0, 1e-5, "target.x");
          near(cameraTarget.y, 0, 1e-5, "target.y");
          near(cameraTarget.z, -distance, 1e-5, "target.z");

          const cameraEye = mat4TransformPoint(vec3Create(), view, eye);
          near(cameraEye.x, 0, 1e-6, "eye.x");
          near(cameraEye.y, 0, 1e-6, "eye.y");
          near(cameraEye.z, 0, 1e-6, "eye.z");

          const cameraUp = mat4TransformDirection(vec3Create(), view, up);
          expect(cameraUp.y, "up hemisphere").toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  test("[ER-02-06] the view rotation is orthonormal and right-handed", () => {
    fc.assert(
      fc.property(
        smallVec3Arb(),
        unitVec3Arb(),
        unitVec3Arb(),
        distanceArb,
        (eye, forward, up, distance) => {
          fc.pre(
            Math.abs(
              forward.x * up.x + forward.y * up.y + forward.z * up.z,
            ) < 0.95,
          );
          const target = vec3Create(
            eye.x + forward.x * distance,
            eye.y + forward.y * distance,
            eye.z + forward.z * distance,
          );
          const view = mat4LookAt(mat4Create(), eye, target, up);

          const r0x = m4(view, 0, 0);
          const r0y = m4(view, 0, 1);
          const r0z = m4(view, 0, 2);
          const r1x = m4(view, 1, 0);
          const r1y = m4(view, 1, 1);
          const r1z = m4(view, 1, 2);
          const r2x = m4(view, 2, 0);
          const r2y = m4(view, 2, 1);
          const r2z = m4(view, 2, 2);

          near(dot(r0x, r0y, r0z, r0x, r0y, r0z), 1, 1e-6, "row0 length");
          near(dot(r1x, r1y, r1z, r1x, r1y, r1z), 1, 1e-6, "row1 length");
          near(dot(r2x, r2y, r2z, r2x, r2y, r2z), 1, 1e-6, "row2 length");
          near(dot(r0x, r0y, r0z, r1x, r1y, r1z), 0, 1e-6, "row0 . row1");
          near(dot(r0x, r0y, r0z, r2x, r2y, r2z), 0, 1e-6, "row0 . row2");
          near(dot(r1x, r1y, r1z, r2x, r2y, r2z), 0, 1e-6, "row1 . row2");

          const crossX = r1y * r2z - r1z * r2y;
          const crossY = r1z * r2x - r1x * r2z;
          const crossZ = r1x * r2y - r1y * r2x;
          near(
            dot(r0x, r0y, r0z, crossX, crossY, crossZ),
            1,
            1e-6,
            "right-handed determinant",
          );
        },
      ),
      { numRuns: 10_000 },
    );
  });
});

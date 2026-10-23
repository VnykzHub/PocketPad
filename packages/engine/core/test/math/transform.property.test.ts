/**
 * 02 §7 ER-02-03 property tests: compose -> decompose -> compose.
 *
 * The generators cover non-uniform and negative scale and arbitrary unit
 * rotations. Position and scale must round-trip within 1e-6; the rotation must
 * agree with |dot| >= 1 - 1e-6 (q and -q are the same rotation).
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  mat4Compose,
  mat4Create,
  mat4Decompose,
  quatCreate,
  quatLength,
  vec3Create,
} from "../../src/math/index.js";
import { at, near, trsArb } from "./helpers.js";

describe("TRS decomposition properties", () => {
  test("[ER-02-03] compose/decompose/compose round-trips position, scale and rotation", () => {
    fc.assert(
      fc.property(trsArb(), (trs) => {
        const matrix = mat4Compose(
          mat4Create(),
          trs.position,
          trs.rotation,
          trs.scale,
        );
        const position = vec3Create();
        const rotation = quatCreate();
        const scale = vec3Create();
        expect(
          mat4Decompose(position, rotation, scale, matrix),
          "decompose succeeds",
        ).toBe(true);

        near(position.x, trs.position.x, 1e-6, "position.x");
        near(position.y, trs.position.y, 1e-6, "position.y");
        near(position.z, trs.position.z, 1e-6, "position.z");

        near(scale.x, trs.scale.x, 1e-6, "scale.x");
        near(scale.y, trs.scale.y, 1e-6, "scale.y");
        near(scale.z, trs.scale.z, 1e-6, "scale.z");

        const dot =
          (rotation.x * trs.rotation.x +
            rotation.y * trs.rotation.y +
            rotation.z * trs.rotation.z +
            rotation.w * trs.rotation.w) /
          (quatLength(rotation) * quatLength(trs.rotation));
        expect(Math.abs(dot), "rotation dot").toBeGreaterThanOrEqual(
          1 - 1e-6,
        );

        const recomposed = mat4Compose(
          mat4Create(),
          position,
          rotation,
          scale,
        );
        for (let index = 0; index < 16; index += 1) {
          near(
            at(recomposed.m, index),
            at(matrix.m, index),
            2e-5,
            `recomposed m[${index}]`,
          );
        }
      }),
      { numRuns: 10_000 },
    );
  });
});

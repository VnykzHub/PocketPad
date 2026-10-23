/**
 * 02 §7 ER-02-08 property tests: OBB SAT.
 *
 * OBB/OBB SAT must be symmetric, identity-rotation OBBs must agree with the
 * identical AABB, and a 10,000-point brute-force containment scan must never
 * find a point inside both shapes when SAT reports a miss. Containment itself
 * is checked against an explicit local-space projection.
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  aabb3Create,
  aabb3FromCenterHalfExtents,
  obbContainsPoint,
  obbCreate,
  obbGetAxis,
  obbIntersectsAabb,
  obbIntersectsObb,
  obbSet,
  quatCreate,
  vec3Create,
} from "../../src/math/index.js";
import type { Obb, Quat, Vec3 } from "../../src/math/index.js";
import { unitQuatArb } from "./helpers.js";

const centerArb = fc.double({
  min: -2,
  max: 2,
  noNaN: true,
  noDefaultInfinity: true,
});

const halfArb = fc.double({
  min: 0.2,
  max: 1.5,
  noNaN: true,
  noDefaultInfinity: true,
});

function buildObb(center: Vec3, halfExtents: Vec3, rotation: Quat): Obb {
  return obbSet(obbCreate(), center, halfExtents, rotation);
}

function randomObbArb() {
  return fc
    .tuple(
      centerArb,
      centerArb,
      centerArb,
      halfArb,
      halfArb,
      halfArb,
      unitQuatArb(),
    )
    .map(([cx, cy, cz, hx, hy, hz, rotation]) =>
      buildObb(vec3Create(cx, cy, cz), vec3Create(hx, hy, hz), rotation),
    );
}

function localCoordinates(
  box: Obb,
  point: Vec3,
): { x: number; y: number; z: number } {
  const axis = vec3Create();
  const result = { x: 0, y: 0, z: 0 };
  const dx = point.x - box.center.x;
  const dy = point.y - box.center.y;
  const dz = point.z - box.center.z;
  obbGetAxis(axis, box, 0);
  result.x = dx * axis.x + dy * axis.y + dz * axis.z;
  obbGetAxis(axis, box, 1);
  result.y = dx * axis.x + dy * axis.y + dz * axis.z;
  obbGetAxis(axis, box, 2);
  result.z = dx * axis.x + dy * axis.y + dz * axis.z;
  return result;
}

/** Explicit containment in the OBB's local frame. */
function bruteContains(box: Obb, point: Vec3): boolean {
  const local = localCoordinates(box, point);
  return (
    Math.abs(local.x) <= box.halfExtents.x &&
    Math.abs(local.y) <= box.halfExtents.y &&
    Math.abs(local.z) <= box.halfExtents.z
  );
}

function nearBoundary(box: Obb, point: Vec3): boolean {
  const local = localCoordinates(box, point);
  const margin = 1e-7;
  return (
    Math.abs(Math.abs(local.x) - box.halfExtents.x) < margin ||
    Math.abs(Math.abs(local.y) - box.halfExtents.y) < margin ||
    Math.abs(Math.abs(local.z) - box.halfExtents.z) < margin
  );
}

describe("OBB SAT properties", () => {
  test("[ER-02-08] obbIntersectsObb is symmetric for 10,000 random pairs", () => {
    fc.assert(
      fc.property(randomObbArb(), randomObbArb(), (a, b) => {
        const forward = obbIntersectsObb(a, b);
        const backward = obbIntersectsObb(b, a);
        expect(backward).toBe(forward);
      }),
      { numRuns: 10_000 },
    );
  });

  test("[ER-02-08] an identity-rotation OBB matches the same AABB", () => {
    fc.assert(
      fc.property(
        centerArb,
        centerArb,
        centerArb,
        halfArb,
        halfArb,
        halfArb,
        (cx, cy, cz, hx, hy, hz) => {
          const center = vec3Create(cx, cy, cz);
          const halfExtents = vec3Create(hx, hy, hz);
          const box = aabb3FromCenterHalfExtents(
            aabb3Create(),
            center,
            halfExtents,
          );
          const boxAsObb = buildObb(center, halfExtents, quatCreate());
          expect(obbIntersectsAabb(boxAsObb, box)).toBe(true);
          expect(obbIntersectsObb(boxAsObb, boxAsObb)).toBe(true);

          const shifted = buildObb(
            vec3Create(cx + 2 * hx + 0.5, cy, cz),
            halfExtents,
            quatCreate(),
          );
          expect(obbIntersectsAabb(shifted, box)).toBe(false);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  test("[ER-02-08] SAT agrees with a 10,000-point brute-force scan", () => {
    const grid = 22;
    fc.assert(
      fc.property(randomObbArb(), randomObbArb(), (a, b) => {
        const sat = obbIntersectsObb(a, b);
        const middle = vec3Create(
          (a.center.x + b.center.x) * 0.5,
          (a.center.y + b.center.y) * 0.5,
          (a.center.z + b.center.z) * 0.5,
        );
        const reach = vec3Create(
          Math.abs(a.center.x - b.center.x) * 0.5 +
            a.halfExtents.x +
            b.halfExtents.x,
          Math.abs(a.center.y - b.center.y) * 0.5 +
            a.halfExtents.y +
            b.halfExtents.y,
          Math.abs(a.center.z - b.center.z) * 0.5 +
            a.halfExtents.z +
            b.halfExtents.z,
        );
        const point = vec3Create();
        let sampledInsideBoth = false;
        for (let ix = 0; ix < grid && !sampledInsideBoth; ix += 1) {
          const x = middle.x - reach.x + (2 * reach.x * ix) / (grid - 1);
          for (let iy = 0; iy < grid && !sampledInsideBoth; iy += 1) {
            const y = middle.y - reach.y + (2 * reach.y * iy) / (grid - 1);
            for (let iz = 0; iz < grid; iz += 1) {
              const z =
                middle.z - reach.z + (2 * reach.z * iz) / (grid - 1);
              point.x = x;
              point.y = y;
              point.z = z;
              const bruteA = bruteContains(a, point);
              if (!nearBoundary(a, point)) {
                expect(obbContainsPoint(a, point)).toBe(bruteA);
              }
              if (bruteA && bruteContains(b, point)) {
                sampledInsideBoth = true;
                break;
              }
            }
          }
        }
        if (sampledInsideBoth) {
          expect(sat).toBe(true);
        }
      }),
      { numRuns: 20 },
    );
  });
});

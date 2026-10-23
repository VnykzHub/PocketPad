/**
 * 02 §7 ER-02-07 property tests: analytic ray intersection vs a 1,000-sample
 * march with bisection refinement.
 *
 * The march uses the same inclusive membership predicate as the geometry; a
 * bracketing pair is refined by 60 bisection steps so t is comparable at
 * 1e-9. Grazing hits whose chord is shorter than two march steps are excluded
 * before the assertion (`fc.pre`), because no finite sampler can resolve them.
 * A ray that starts inside an AABB returns exactly 0.
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  aabb3Create,
  aabb3FromCenterHalfExtents,
  rayAt,
  rayCreate,
  rayIntersectAabb,
  rayIntersectSphere,
  raySet,
  vec3Create,
} from "../../src/math/index.js";
import type { Aabb3, Ray, Vec3 } from "../../src/math/index.js";
import { near, unitVec3Arb } from "./helpers.js";

const MARCH_SAMPLES = 1_000;
const MARCH_T = 12;
const MARCH_STEP = MARCH_T / (MARCH_SAMPLES - 1);

const coordinateArb = fc.double({
  min: -4,
  max: 4,
  noNaN: true,
  noDefaultInfinity: true,
});

const halfExtentArb = fc.double({
  min: 0.5,
  max: 2,
  noNaN: true,
  noDefaultInfinity: true,
});

const radiusArb = fc.double({
  min: 0.5,
  max: 2,
  noNaN: true,
  noDefaultInfinity: true,
});

function buildRay(origin: Vec3, direction: Vec3): Ray {
  return raySet(rayCreate(), origin, direction);
}

function insideAabb(box: Aabb3, point: Vec3): boolean {
  return (
    point.x >= box.min.x &&
    point.x <= box.max.x &&
    point.y >= box.min.y &&
    point.y <= box.max.y &&
    point.z >= box.min.z &&
    point.z <= box.max.z
  );
}

function insideSphere(center: Vec3, radius: number, point: Vec3): boolean {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const dz = point.z - center.z;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

/**
 * March until the predicate first returns true, then bisect the bracketing
 * pair. Returns -1 when no sample is inside.
 */
function march(ray: Ray, predicate: (point: Vec3) => boolean): number {
  const point = vec3Create();
  if (predicate(rayAt(point, ray, 0))) {
    return 0;
  }
  let previous = 0;
  for (let sample = 1; sample < MARCH_SAMPLES; sample += 1) {
    const t = sample * MARCH_STEP;
    if (predicate(rayAt(point, ray, t))) {
      let low = previous;
      let high = t;
      for (let iteration = 0; iteration < 60; iteration += 1) {
        const middle = (low + high) * 0.5;
        if (predicate(rayAt(point, ray, middle))) {
          high = middle;
        } else {
          low = middle;
        }
      }
      return high;
    }
    previous = t;
  }
  return -1;
}

describe("Ray/AABB property tests", () => {
  test("[ER-02-07] ray/AABB agrees with a 1,000-sample march", () => {
    fc.assert(
      fc.property(
        coordinateArb,
        coordinateArb,
        coordinateArb,
        unitVec3Arb(),
        coordinateArb,
        coordinateArb,
        coordinateArb,
        halfExtentArb,
        halfExtentArb,
        halfExtentArb,
        (ox, oy, oz, direction, cx, cy, cz, hx, hy, hz) => {
          const origin = vec3Create(ox, oy, oz);
          const ray = buildRay(origin, direction);
          const box = aabb3FromCenterHalfExtents(
            aabb3Create(),
            vec3Create(cx, cy, cz),
            vec3Create(hx, hy, hz),
          );
          const analytic = rayIntersectAabb(ray, box);
          const marched = march(ray, (point) => insideAabb(box, point));

          if (analytic === -1) {
            expect(marched).toBe(-1);
            return;
          }
          // Non-grazing hits are guaranteed to cover at least two steps.
          fc.pre(
            analytic + 2 * MARCH_STEP <= MARCH_T &&
              insideAabb(
                box,
                rayAt(vec3Create(), ray, analytic + 2 * MARCH_STEP),
              ),
          );
          expect(marched).toBeGreaterThanOrEqual(0);
          near(marched, analytic, 1e-9, "marched t");
        },
      ),
      { numRuns: 300 },
    );
  });

  test("[ER-02-07] a ray starting inside an AABB returns 0", () => {
    fc.assert(
      fc.property(
        coordinateArb,
        coordinateArb,
        coordinateArb,
        halfExtentArb,
        halfExtentArb,
        halfExtentArb,
        unitVec3Arb(),
        (cx, cy, cz, hx, hy, hz, direction) => {
          const box = aabb3FromCenterHalfExtents(
            aabb3Create(),
            vec3Create(cx, cy, cz),
            vec3Create(hx, hy, hz),
          );
          const origin = vec3Create(
            cx + 0.125 * hx,
            cy - 0.125 * hy,
            cz + 0.0625 * hz,
          );
          expect(rayIntersectAabb(buildRay(origin, direction), box)).toBe(0);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe("Ray/sphere property tests", () => {
  test("[ER-02-07] ray/sphere agrees with a 1,000-sample march", () => {
    fc.assert(
      fc.property(
        coordinateArb,
        coordinateArb,
        coordinateArb,
        unitVec3Arb(),
        coordinateArb,
        coordinateArb,
        coordinateArb,
        radiusArb,
        (ox, oy, oz, direction, cx, cy, cz, radius) => {
          const origin = vec3Create(ox, oy, oz);
          const ray = buildRay(origin, direction);
          const center = vec3Create(cx, cy, cz);
          const analytic = rayIntersectSphere(ray, center, radius);
          const marched = march(ray, (point) =>
            insideSphere(center, radius, point),
          );

          if (analytic === -1) {
            expect(marched).toBe(-1);
            return;
          }
          fc.pre(
            analytic + 2 * MARCH_STEP <= MARCH_T &&
              insideSphere(
                center,
                radius,
                rayAt(vec3Create(), ray, analytic + 2 * MARCH_STEP),
              ),
          );
          expect(marched).toBeGreaterThanOrEqual(0);
          near(marched, analytic, 1e-9, "marched t");
        },
      ),
      { numRuns: 300 },
    );
  });
});

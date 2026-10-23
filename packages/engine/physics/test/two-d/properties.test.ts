/**
 * ER-07-09 — invariants of the frozen 2D solver after the M0 move (07 §5.15).
 *
 * These properties are deliberately different from
 * `packages/runtime/test/physics.test.ts`, which pins individual hand-picked
 * cases. Here fast-check sweeps the input space for the guarantees the engine
 * relies on: full positional correction, finite output for finite input, and
 * monotonic walking on flat ground. The point-level tests remain the
 * authoritative examples; these catch regressions that a fixed example misses.
 */
import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  MAX_SPEED,
  integrate,
  resolveCircleAabb,
  resolveCircleCircle,
  type Aabb,
  type Arena,
  type CircleBody,
  type Contact,
} from "../../src/two-d/index.js";

function coordinateArb() {
  return fc.double({
    min: -500,
    max: 500,
    noNaN: true,
    noDefaultInfinity: true,
  });
}

function sizeArb() {
  return fc.double({
    min: 0.1,
    max: 100,
    noNaN: true,
    noDefaultInfinity: true,
  });
}

function radiusArb() {
  return fc.double({
    min: 0.01,
    max: 20,
    noNaN: true,
    noDefaultInfinity: true,
  });
}

function fractionArb() {
  return fc.double({
    min: 0,
    max: 1,
    noNaN: true,
    noDefaultInfinity: true,
  });
}

/**
 * A face gap as a fraction of the radius. Zero (exactly on the face) is safe
 * because the solver's centre-inside branch is inclusive; non-zero gaps stay
 * well above subnormal scale. At denormal separations the frozen solver's
 * `distSq` underflows and its documented "unreachable" `dist === 0` fallback
 * fires; that predates the move and is out of scope for this property.
 */
function faceOffsetArb() {
  return fc.oneof(
    fc.constant(0),
    fc.double({ min: 0.001, max: 0.99, noNaN: true, noDefaultInfinity: true }),
  );
}

/** Centre separation as a fraction of the radius sum; 0 is exact coincidence. */
function pairSeparationArb() {
  return fc.oneof(
    fc.constant(0),
    fc.double({ min: 0.001, max: 0.99, noNaN: true, noDefaultInfinity: true }),
  );
}

function makeBody(): CircleBody {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 1,
    mass: 1,
    restitution: 0,
    friction: 0,
    active: true,
    id: 1,
  };
}

function makeContact(): Contact {
  return { nx: 0, ny: 0, depth: 0 };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** True when the centre is strictly inside the box (the solver's own test). */
function centreInside(cx: number, cy: number, box: Aabb): boolean {
  return (
    cx > box.x &&
    cx < box.x + box.w &&
    cy > box.y &&
    cy < box.y + box.h
  );
}

/** Distance from a point to the closest point of the box (0 when inside). */
function distanceToBox(cx: number, cy: number, box: Aabb): number {
  const dx = cx - clamp(cx, box.x, box.x + box.w);
  const dy = cy - clamp(cy, box.y, box.y + box.h);
  return Math.hypot(dx, dy);
}

type AabbCase = {
  readonly box: Aabb;
  readonly radius: number;
  readonly cx: number;
  readonly cy: number;
};

/**
 * A box plus a circle that is guaranteed to overlap it: either the centre is
 * inside, or it is within one radius of a face. Corner placements are excluded
 * because they need not overlap.
 */
function overlappingAabbCaseArb() {
  return fc
    .tuple(
      sizeArb(),
      sizeArb(),
      radiusArb(),
      fc.integer({ min: 0, max: 4 }),
      fractionArb(),
      fractionArb(),
      faceOffsetArb(),
    )
    .map(([w, h, radius, mode, alongFace, insideFraction, offset]): AabbCase => {
      const box: Aabb = { x: 0, y: 0, w, h };
      const right = box.x + box.w;
      const bottom = box.y + box.h;
      switch (mode) {
        case 1:
          return { box, radius, cx: box.x - offset * radius, cy: box.y + alongFace * box.h };
        case 2:
          return { box, radius, cx: right + offset * radius, cy: box.y + alongFace * box.h };
        case 3:
          return { box, radius, cx: box.x + alongFace * box.w, cy: box.y - offset * radius };
        case 4:
          return { box, radius, cx: box.x + alongFace * box.w, cy: bottom + offset * radius };
        default:
          return {
            box,
            radius,
            cx: box.x + alongFace * box.w,
            cy: box.y + insideFraction * box.h,
          };
      }
    });
}

type PairCase = {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly ra: number;
  readonly rb: number;
};

/** Two circles whose centres are closer than the sum of radii. */
function overlappingPairArb() {
  return fc
    .tuple(
      coordinateArb(),
      coordinateArb(),
      radiusArb(),
      radiusArb(),
      pairSeparationArb(),
      fc.double({ min: 0, max: Math.PI * 2, noNaN: true, noDefaultInfinity: true }),
    )
    .map(([ax, ay, ra, rb, separationFraction, angle]): PairCase => {
      const distance = (ra + rb) * separationFraction;
      return {
        ax,
        ay,
        bx: ax + Math.cos(angle) * distance,
        by: ay + Math.sin(angle) * distance,
        ra,
        rb,
      };
    });
}

describe("2D solver properties [ER-07-09]", () => {
  test("[ER-07-09] resolveCircleAabb leaves no residual penetration", () => {
    fc.assert(
      fc.property(overlappingAabbCaseArb(), (testCase) => {
        const circle = makeBody();
        circle.x = testCase.cx;
        circle.y = testCase.cy;
        circle.radius = testCase.radius;
        const contact = makeContact();

        expect(resolveCircleAabb(circle, testCase.box, contact)).toBe(true);
        expect(contact.depth).toBeGreaterThanOrEqual(0);
        expect(Math.hypot(contact.nx, contact.ny)).toBeCloseTo(1, 12);
        expect(centreInside(circle.x, circle.y, testCase.box)).toBe(false);
        expect(
          distanceToBox(circle.x, circle.y, testCase.box),
          "the corrected centre must sit at least one radius outside the box",
        ).toBeGreaterThanOrEqual(testCase.radius - 1e-9);
      }),
      { numRuns: 1000 },
    );
  });

  test("[ER-07-09] resolveCircleCircle separates two dynamic circles", () => {
    fc.assert(
      fc.property(overlappingPairArb(), (testCase) => {
        const a = makeBody();
        a.x = testCase.ax;
        a.y = testCase.ay;
        a.radius = testCase.ra;
        a.mass = 1.5;
        const b = makeBody();
        b.id = 2;
        b.x = testCase.bx;
        b.y = testCase.by;
        b.radius = testCase.rb;
        b.mass = 2.5;
        const beforeX = b.x - a.x;
        const beforeY = b.y - a.y;
        const beforeDistance = Math.hypot(beforeX, beforeY);
        const contact = makeContact();

        expect(resolveCircleCircle(a, b, contact)).toBe(true);
        const afterDistance = Math.hypot(b.x - a.x, b.y - a.y);
        expect(afterDistance).toBeGreaterThanOrEqual(
          testCase.ra + testCase.rb - 1e-9,
        );
        expect(contact.depth).toBeCloseTo(
          testCase.ra + testCase.rb - beforeDistance,
          9,
        );
        expect(Math.hypot(contact.nx, contact.ny)).toBeCloseTo(1, 12);
      }),
      { numRuns: 1000 },
    );
  });

  test("[ER-07-09] finite inputs never produce NaN in any solver call", () => {
    const finiteArb = fc.double({
      min: -10_000,
      max: 10_000,
      noNaN: true,
      noDefaultInfinity: true,
    });
    fc.assert(
      fc.property(
        finiteArb,
        finiteArb,
        finiteArb,
        finiteArb,
        fc.double({ min: 0.01, max: 50, noNaN: true, noDefaultInfinity: true }),
        /*
         * Mass is 0 (static), strongly negative (static), or a normal positive
         * value. Subnormal positives make `1 / mass` overflow to Infinity in
         * the frozen solver, which predates the move; normal-scale mass is the
         * contract this invariant covers.
         */
        fc.oneof(
          fc.constant(0),
          fc.double({ min: -5, max: -0.01, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 0.01, max: 100, noNaN: true, noDefaultInfinity: true }),
        ),
        fc.double({ min: -1, max: 2, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -2, max: 2, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 0.05, noNaN: true, noDefaultInfinity: true }),
        (x, y, vx, vy, radius, mass, restitution, friction, dt) => {
          const circle = makeBody();
          circle.x = x;
          circle.y = y;
          circle.vx = vx;
          circle.vy = vy;
          circle.radius = radius;
          circle.mass = mass;
          circle.restitution = restitution;
          circle.friction = friction;

          const box: Aabb = { x: 0, y: 0, w: 10, h: 4 };
          const arena: Arena = {
            minX: -1000,
            maxX: 1000,
            minY: -1000,
            maxY: 1000,
          };
          const other = makeBody();
          other.id = 2;
          other.x = x + 1;
          other.y = y + 1;
          other.radius = radius;
          other.mass = 1;

          const contact = makeContact();
          resolveCircleAabb(circle, box, contact);
          resolveCircleCircle(circle, other, contact);
          integrate(circle, dt, arena);

          for (const value of [
            circle.x,
            circle.y,
            circle.vx,
            circle.vy,
            other.x,
            other.y,
            other.vx,
            other.vy,
            contact.nx,
            contact.ny,
            contact.depth,
          ]) {
            expect(Number.isFinite(value)).toBe(true);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  test("[ER-07-09] a circle walking right on flat ground never moves left or sinks", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 20, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.001, max: 0.05, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.1, max: 60, noNaN: true, noDefaultInfinity: true }),
        (walkSpeed, dt, gravity) => {
          const radius = 0.4;
          const ground: Aabb = { x: -10, y: 0, w: 1000, h: 10 };
          const arena: Arena = {
            minX: -1000,
            maxX: 1000,
            minY: -1000,
            maxY: 1000,
          };
          const circle = makeBody();
          circle.x = 1;
          circle.y = -radius;
          circle.vx = walkSpeed;
          circle.radius = radius;

          for (let tick = 0; tick < 60; tick += 1) {
            const previousX = circle.x;
            circle.vy += gravity * dt;
            integrate(circle, dt, arena);
            expect(resolveCircleAabb(circle, ground)).toBe(true);
            expect(circle.x).toBeGreaterThan(previousX);
            expect(circle.y).toBeLessThanOrEqual(-radius + 1e-9);
          }
          expect(circle.vx).toBeLessThan(MAX_SPEED);
        },
      ),
      { numRuns: 200 },
    );
  });
});

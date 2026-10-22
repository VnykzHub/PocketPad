/**
 * Physics primitives tests (D7-RT-01; C9, PR-9.3, PR-9.4).
 *
 * The world is y-down: a platform's top surface is `box.y`, so a circle
 * resting on it reports a contact normal of (0, -1). Every case uses fixed
 * inputs and a fixed dt, matching the deterministic simulation contract.
 */
import { describe, expect, test } from "vitest";
import {
  MAX_SPEED,
  integrate,
  resolveCircleAabb,
  resolveCircleCircle,
  type Aabb,
  type CircleBody,
  type Contact,
} from "../src/physics/index.js";

const DT = 1 / 60;
const CLOSE = 12;

function makeBody(overrides: Partial<CircleBody> = {}): CircleBody {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 0.5,
    mass: 1,
    restitution: 0,
    friction: 0,
    active: true,
    id: 1,
    ...overrides,
  };
}

function makeContact(): Contact {
  return { nx: 0, ny: 0, depth: 0 };
}

describe("resolveCircleAabb [C9]", () => {
  test("[C9] a head-on wall contact points out of the box and corrects position", () => {
    const box: Aabb = { x: 4, y: 0, w: 1, h: 10 };
    const circle = makeBody({ x: 3.8, y: 5, vx: 6 });
    const contact = makeContact();

    expect(resolveCircleAabb(circle, box, contact)).toBe(true);
    expect(contact.nx).toBeCloseTo(-1, CLOSE);
    expect(contact.ny).toBeCloseTo(0, CLOSE);
    expect(contact.depth).toBeCloseTo(0.3, CLOSE);
    expect(circle.x).toBeCloseTo(3.5, CLOSE);
    expect(circle.y).toBeCloseTo(5, CLOSE);
    // restitution 0 removes the incoming normal velocity
    expect(circle.vx).toBeCloseTo(0, CLOSE);
  });

  test("[C9] restitution 1 reflects a head-on wall impact", () => {
    const box: Aabb = { x: 4, y: 0, w: 1, h: 10 };
    const circle = makeBody({ x: 3.8, y: 5, vx: 6, restitution: 1 });

    expect(resolveCircleAabb(circle, box)).toBe(true);
    expect(circle.x).toBeCloseTo(3.5, CLOSE);
    expect(circle.vx).toBeCloseTo(-6, CLOSE);
  });

  test("[C9] a corner contact uses the diagonal closest-point normal", () => {
    const box: Aabb = { x: 0, y: 0, w: 4, h: 4 };
    const circle = makeBody({ x: -1, y: -1, vx: 1, vy: 1, radius: 2 });
    const contact = makeContact();
    const rootHalf = Math.SQRT1_2;

    expect(resolveCircleAabb(circle, box, contact)).toBe(true);
    expect(contact.nx).toBeCloseTo(-rootHalf, CLOSE);
    expect(contact.ny).toBeCloseTo(-rootHalf, CLOSE);
    expect(contact.depth).toBeCloseTo(2 - Math.SQRT2, CLOSE);
    // Centre is exactly one radius from the corner after correction.
    expect(Math.hypot(circle.x, circle.y)).toBeCloseTo(2, CLOSE);
    // The incoming diagonal is entirely normal, so it is removed.
    expect(circle.vx).toBeCloseTo(0, CLOSE);
    expect(circle.vy).toBeCloseTo(0, CLOSE);
  });

  test("[C9] top landing reports an upward normal and grounded velocity", () => {
    const box: Aabb = { x: 0, y: 16, w: 10, h: 2 };
    const circle = makeBody({ x: 5, y: 15.7, vy: 3, radius: 0.4 });
    const contact = makeContact();

    expect(resolveCircleAabb(circle, box, contact)).toBe(true);
    // y-down: top surface normal is (0, -1); Coin Run's grounded test is
    // `contact.ny < -0.99 && body.vy >= 0`.
    expect(contact.nx).toBeCloseTo(0, CLOSE);
    expect(contact.ny).toBeCloseTo(-1, CLOSE);
    expect(contact.depth).toBeCloseTo(0.1, CLOSE);
    expect(circle.y).toBeCloseTo(15.6, CLOSE);
    expect(circle.vy).toBeGreaterThanOrEqual(0);
    expect(circle.vy).toBeCloseTo(0, CLOSE);
  });

  test("[C9] zero velocity is stable: overlap is corrected without adding speed", () => {
    const box: Aabb = { x: 0, y: 0, w: 4, h: 4 };
    const circle = makeBody({ x: 4.3, y: 2, vx: 0, vy: 0 });
    const contact = makeContact();

    expect(resolveCircleAabb(circle, box, contact)).toBe(true);
    expect(contact.nx).toBeCloseTo(1, CLOSE);
    expect(contact.depth).toBeCloseTo(0.2, CLOSE);
    expect(circle.x).toBeCloseTo(4.5, CLOSE);
    expect(circle.vx).toBe(0);
    expect(circle.vy).toBe(0);
  });

  test("[C9] a centre inside the box leaves through the nearest face", () => {
    const box: Aabb = { x: 0, y: 0, w: 4, h: 4 };
    const circle = makeBody({ x: 2, y: 0.2, radius: 0.5 });
    const contact = makeContact();

    expect(resolveCircleAabb(circle, box, contact)).toBe(true);
    expect(contact.nx).toBeCloseTo(0, CLOSE);
    expect(contact.ny).toBeCloseTo(-1, CLOSE);
    expect(contact.depth).toBeCloseTo(0.7, CLOSE);
    expect(circle.y).toBeCloseTo(-0.5, CLOSE);
  });

  test("[C9] a centre inside near the bottom leaves downward", () => {
    const box: Aabb = { x: 0, y: 0, w: 4, h: 4 };
    const circle = makeBody({ x: 2, y: 3.8, radius: 0.5 });
    const contact = makeContact();

    expect(resolveCircleAabb(circle, box, contact)).toBe(true);
    expect(contact.nx).toBeCloseTo(0, CLOSE);
    expect(contact.ny).toBeCloseTo(1, CLOSE);
    expect(contact.depth).toBeCloseTo(0.7, CLOSE);
    expect(circle.y).toBeCloseTo(4.5, CLOSE);
  });

  test("[C9] no overlap returns false and leaves the contact untouched", () => {
    const box: Aabb = { x: 0, y: 0, w: 4, h: 4 };
    const circle = makeBody({ x: 10, y: 10 });
    const contact: Contact = { nx: 7, ny: 8, depth: 9 };

    expect(resolveCircleAabb(circle, box, contact)).toBe(false);
    expect(contact).toEqual({ nx: 7, ny: 8, depth: 9 });
    expect(circle.x).toBe(10);
    expect(circle.y).toBe(10);
  });

  test("[PR-9.4] an inactive pooled body is skipped", () => {
    const box: Aabb = { x: 0, y: 0, w: 4, h: 4 };
    const circle = makeBody({ x: 3.8, y: 2, active: false });

    expect(resolveCircleAabb(circle, box)).toBe(false);
    expect(circle.x).toBe(3.8);
  });
});

describe("resolveCircleCircle [C9]", () => {
  test("[C9] equal masses with restitution 1 exchange velocity head-on", () => {
    const a = makeBody({ x: 0, y: 0, vx: 10, radius: 1, restitution: 1 });
    const b = makeBody({ x: 1.9, y: 0, vx: 0, radius: 1, restitution: 1, id: 2 });
    const contact = makeContact();

    expect(resolveCircleCircle(a, b, contact)).toBe(true);
    expect(contact.nx).toBeCloseTo(1, CLOSE);
    expect(contact.ny).toBeCloseTo(0, CLOSE);
    expect(contact.depth).toBeCloseTo(0.1, CLOSE);
    expect(a.vx).toBeCloseTo(0, CLOSE);
    expect(b.vx).toBeCloseTo(10, CLOSE);
    // Positional correction splits evenly and separates the pair.
    expect(a.x).toBeCloseTo(-0.05, CLOSE);
    expect(b.x).toBeCloseTo(1.95, CLOSE);
  });

  test("[C9] positional correction is proportional to inverse mass", () => {
    const a = makeBody({ x: 0, y: 0, radius: 1, mass: 3 });
    const b = makeBody({ x: 1.5, y: 0, radius: 1, mass: 1, id: 2 });
    const contact = makeContact();

    expect(resolveCircleCircle(a, b, contact)).toBe(true);
    expect(contact.nx).toBeCloseTo(1, CLOSE);
    expect(contact.depth).toBeCloseTo(0.5, CLOSE);
    // invMassA : invMassB = 1/3 : 1, so a moves 1/8 of the depth, b 3/8.
    expect(a.x).toBeCloseTo(-0.125, CLOSE);
    expect(b.x).toBeCloseTo(1.875, CLOSE);
  });

  test("[C9] a heavy body pushes a light body", () => {
    const heavy = makeBody({ x: 0, y: 0, vx: 10, radius: 1, mass: 10 });
    const light = makeBody({ x: 1.9, y: 0, radius: 1, mass: 1, id: 2 });

    expect(resolveCircleCircle(heavy, light)).toBe(true);
    expect(heavy.vx).toBeCloseTo(9.090909090909092, 9);
    expect(light.vx).toBeCloseTo(9.090909090909092, 9);
    // Momentum is conserved and the heavy body keeps most of its speed.
    expect(10 * heavy.vx + light.vx).toBeCloseTo(100, 9);
    expect(heavy.vx).toBeLessThan(10);
    expect(light.vx).toBeGreaterThan(9);
  });

  test("[C9] coincident centres use a deterministic normal and separate", () => {
    const a = makeBody({ x: 0, y: 0, radius: 0.5 });
    const b = makeBody({ x: 0, y: 0, radius: 0.5, id: 2 });
    const contact = makeContact();

    expect(resolveCircleCircle(a, b, contact)).toBe(true);
    expect(contact.nx).toBeCloseTo(1, CLOSE);
    expect(contact.ny).toBeCloseTo(0, CLOSE);
    expect(contact.depth).toBeCloseTo(1, CLOSE);
    expect(a.x).toBeCloseTo(-0.5, CLOSE);
    expect(b.x).toBeCloseTo(0.5, CLOSE);
  });

  test("[C9] no overlap returns false and leaves the contact untouched", () => {
    const a = makeBody({ x: 0, y: 0, radius: 0.5 });
    const b = makeBody({ x: 5, y: 0, radius: 0.5, id: 2 });
    const contact: Contact = { nx: 7, ny: 8, depth: 9 };

    expect(resolveCircleCircle(a, b, contact)).toBe(false);
    expect(contact).toEqual({ nx: 7, ny: 8, depth: 9 });
  });
});

describe("integrate [C9]", () => {
  test("[C9] advances position with the current velocity (semi-implicit Euler)", () => {
    const arena = { minX: 0, maxX: 100, minY: 0, maxY: 100 };
    const body = makeBody({ x: 1, y: 2, vx: 3, vy: 2 });

    integrate(body, 0.5, arena);

    expect(body.x).toBeCloseTo(2.5, CLOSE);
    expect(body.y).toBeCloseTo(3, CLOSE);
    expect(body.vx).toBeCloseTo(3, CLOSE);
    expect(body.vy).toBeCloseTo(2, CLOSE);
  });

  test("[C9] clamps at arena walls and reflects with restitution", () => {
    const arena = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
    const body = makeBody({ x: 9.8, y: 9.8, vx: 4, vy: 4, restitution: 0.5 });

    integrate(body, 0.1, arena);

    expect(body.x).toBeCloseTo(9.5, CLOSE);
    expect(body.y).toBeCloseTo(9.5, CLOSE);
    expect(body.vx).toBeCloseTo(-2, CLOSE);
    expect(body.vy).toBeCloseTo(-2, CLOSE);
  });

  test("[C9] clamps speed to MAX_SPEED", () => {
    const arena = { minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 };
    const body = makeBody({ vx: MAX_SPEED * 4, vy: MAX_SPEED * 3 });

    integrate(body, DT, arena);

    expect(Math.hypot(body.vx, body.vy)).toBeCloseTo(MAX_SPEED, 9);
    expect(body.vx).toBeCloseTo(MAX_SPEED * 0.8, 6);
    expect(body.vy).toBeCloseTo(MAX_SPEED * 0.6, 6);
  });

  test("[PR-9.4] inactive bodies and non-positive dt do not move", () => {
    const arena = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
    const inactive = makeBody({ x: 1, y: 1, vx: 3, active: false });
    const paused = makeBody({ x: 1, y: 1, vx: 3, id: 2 });

    integrate(inactive, 1, arena);
    integrate(paused, 0, arena);

    expect(inactive.x).toBe(1);
    expect(inactive.vx).toBe(3);
    expect(paused.x).toBe(1);
    expect(paused.vx).toBe(3);
  });
});

describe("determinism and allocation [PR-9.3]", () => {
  test("[PR-9.3] identical state and dt replay to exactly the same trajectory", () => {
    const run = (): CircleBody => {
      const arena = { minX: 0, maxX: 20, minY: 0, maxY: 20 };
      const box: Aabb = { x: 8, y: 10, w: 4, h: 2 };
      const body = makeBody({
        x: 2,
        y: 2,
        vx: 6,
        vy: 3,
        restitution: 0.6,
        friction: 0.2,
      });
      const contact = makeContact();
      for (let step = 0; step < 400; step += 1) {
        integrate(body, DT, arena);
        resolveCircleAabb(body, box, contact);
      }
      return body;
    };

    const first = run();
    const second = run();

    expect(first.x).toBe(second.x);
    expect(first.y).toBe(second.y);
    expect(first.vx).toBe(second.vx);
    expect(first.vy).toBe(second.vy);
    expect(Number.isFinite(first.x)).toBe(true);
    expect(Number.isFinite(first.y)).toBe(true);
  });

  test("[PR-9.3] a preallocated Contact is reused by every resolve call", () => {
    const box: Aabb = { x: 4, y: 0, w: 1, h: 10 };
    const circle = makeBody({ x: 3.8, y: 5, vx: 1 });
    const contact = makeContact();
    const reference = contact;
    let hits = 0;

    for (let call = 0; call < 10_000; call += 1) {
      // Recreate the same overlap without constructing a new Contact.
      circle.x = 3.8;
      circle.vx = 1;
      if (resolveCircleAabb(circle, box, contact)) {
        hits += 1;
      }
    }

    expect(hits).toBe(10_000);
    expect(contact).toBe(reference);
    expect(contact.nx).toBeCloseTo(-1, CLOSE);
    expect(contact.depth).toBeCloseTo(0.3, CLOSE);
  });

  test("[PR-9.3] a preallocated Contact is reused by circle-circle resolution", () => {
    const a = makeBody({ x: 0, y: 0, radius: 0.5 });
    const b = makeBody({ x: 0.8, y: 0, radius: 0.5, id: 2 });
    const contact = makeContact();
    const reference = contact;
    let hits = 0;

    for (let call = 0; call < 10_000; call += 1) {
      a.x = 0;
      b.x = 0.8;
      if (resolveCircleCircle(a, b, contact)) {
        hits += 1;
      }
    }

    expect(hits).toBe(10_000);
    expect(contact).toBe(reference);
    expect(contact.depth).toBeCloseTo(0.2, CLOSE);
  });

  test("[PR-9.4] a deactivated pooled body can be reactivated and reused", () => {
    const arena = { minX: -100, maxX: 100, minY: -100, maxY: 100 };
    const body = makeBody({ x: 0, y: 0, vx: 2, active: false });

    integrate(body, DT, arena);
    expect(body.x).toBe(0);

    body.active = true;
    integrate(body, DT, arena);
    expect(body.x).toBeCloseTo(2 * DT, CLOSE);
  });
});

/**
 * Circle physics primitives (D7-RT-01; C9, PR-9.3).
 *
 * Inputs are plain pooled data. None of these functions allocates: collision
 * results are written into a caller-owned `Contact`, and bodies are mutated in
 * place. Every result is a pure function of the arguments, so a fixed dt and a
 * fixed command sequence replay identically (no wall clock, no `Math.random`).
 *
 * Conventions
 * - y points down. A platform top surface therefore reports normal `(0, -1)`.
 * - `Contact.nx`/`ny` is a unit vector pointing out of the surface: out of the
 *   box for `resolveCircleAabb`, and from `a` toward `b` for
 *   `resolveCircleCircle`. `depth` is a non-negative penetration depth.
 * - Positional correction moves the circle out by the full depth (an AABB is
 *   treated as static/infinite mass).
 * - Bodies with `active === false` are skipped so pooled slots do not collide
 *   while dormant.
 */

import type { Aabb, Arena } from "./Aabb.js";

/** A pooled circular body (D7-RT-01 frozen contract). */
export interface CircleBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  mass: number;
  restitution: number;
  friction: number;
  active: boolean;
  id: number;
}

/** Collision result written into a caller-owned object (no allocation). */
export interface Contact {
  /** Unit x of the contact normal (points out of the surface). */
  nx: number;
  /** Unit y of the contact normal (points out of the surface). */
  ny: number;
  /** Penetration depth; always >= 0. */
  depth: number;
}

/**
 * Runaway-velocity guard for `integrate`, in world units per second.
 * Game tuning (moveSpeed 9, maxFall 30) is far below this; it only stops a
 * NaN-free but exploding simulation from moving bodies across the arena.
 */
export const MAX_SPEED = 1000;

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** Clamp a body's speed magnitude to MAX_SPEED, preserving direction. */
function clampSpeed(body: CircleBody): void {
  const speedSq = body.vx * body.vx + body.vy * body.vy;
  if (speedSq > MAX_SPEED * MAX_SPEED) {
    const scale = MAX_SPEED / Math.sqrt(speedSq);
    body.vx *= scale;
    body.vy *= scale;
  }
}

/**
 * Resolve a circle against a static AABB.
 *
 * When `out` is provided and a collision occurs, its fields are overwritten
 * with the contact normal (out of the box) and depth. On a miss `out` is left
 * untouched and `false` is returned, so a game can test the boolean first.
 *
 * Velocity response: a normal component moving into the surface is removed
 * (or reflected according to `circle.restitution`); tangent motion is damped
 * by `circle.friction` (0..1).
 */
export function resolveCircleAabb(
  circle: CircleBody,
  box: Aabb,
  out?: Contact,
): boolean {
  if (!circle.active || circle.radius <= 0 || box.w <= 0 || box.h <= 0) {
    return false;
  }

  const r = circle.radius;
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const cx = circle.x;
  const cy = circle.y;

  let nx: number;
  let ny: number;
  let depth: number;

  if (cx >= box.x && cx <= right && cy >= box.y && cy <= bottom) {
    // Centre inside: leave through the nearest face. Strict comparisons keep
    // the tie order deterministic (left, right, top, bottom).
    let nearest = cx - box.x;
    nx = -1;
    ny = 0;
    const toRight = right - cx;
    if (toRight < nearest) {
      nearest = toRight;
      nx = 1;
      ny = 0;
    }
    const toTop = cy - box.y;
    if (toTop < nearest) {
      nearest = toTop;
      nx = 0;
      ny = -1;
    }
    const toBottom = bottom - cy;
    if (toBottom < nearest) {
      nearest = toBottom;
      nx = 0;
      ny = 1;
    }
    depth = nearest + r;
    circle.x = cx + nx * depth;
    circle.y = cy + ny * depth;
  } else {
    // Centre outside: closest point on the box gives the outward normal.
    const closestX = cx < box.x ? box.x : cx > right ? right : cx;
    const closestY = cy < box.y ? box.y : cy > bottom ? bottom : cy;
    const dx = cx - closestX;
    const dy = cy - closestY;
    const distSq = dx * dx + dy * dy;
    if (distSq >= r * r) {
      return false;
    }
    const dist = Math.sqrt(distSq);
    if (dist === 0) {
      // Unreachable for a centre outside the box; kept deterministic anyway.
      nx = 1;
      ny = 0;
      depth = r;
    } else {
      const inv = 1 / dist;
      nx = dx * inv;
      ny = dy * inv;
      depth = r - dist;
    }
    circle.x = cx + nx * depth;
    circle.y = cy + ny * depth;
  }

  const vn = circle.vx * nx + circle.vy * ny;
  if (vn < 0) {
    const restitution = circle.restitution > 0 ? circle.restitution : 0;
    const friction = clamp01(circle.friction);
    const tangentX = circle.vx - vn * nx;
    const tangentY = circle.vy - vn * ny;
    circle.vx = tangentX * (1 - friction) - restitution * vn * nx;
    circle.vy = tangentY * (1 - friction) - restitution * vn * ny;
  }

  if (out !== undefined) {
    out.nx = nx;
    out.ny = ny;
    out.depth = depth;
  }
  return true;
}

/**
 * Resolve two circles. The normal points from `a` toward `b`; `a` is pushed
 * along `-n` and `b` along `+n`.
 *
 * Positional correction and the normal impulse are split by inverse mass, so
 * a heavy body moves less than a light one and a zero/negative mass acts as
 * static. Restitution combines with `max`; friction uses the average of the
 * two bodies. The tangent impulse is Coulomb-clamped to `mu * jn`.
 */
export function resolveCircleCircle(
  a: CircleBody,
  b: CircleBody,
  out?: Contact,
): boolean {
  if (a === b || !a.active || !b.active) {
    return false;
  }
  const ra = a.radius;
  const rb = b.radius;
  if (ra <= 0 || rb <= 0) {
    return false;
  }

  const sum = ra + rb;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distSq = dx * dx + dy * dy;
  if (distSq >= sum * sum) {
    return false;
  }

  const dist = Math.sqrt(distSq);
  let nx: number;
  let ny: number;
  if (dist === 0) {
    // Perfect coincidence: pick a fixed axis so the result is deterministic.
    nx = 1;
    ny = 0;
  } else {
    const inv = 1 / dist;
    nx = dx * inv;
    ny = dy * inv;
  }
  const depth = sum - dist;

  const invMassA = a.mass > 0 ? 1 / a.mass : 0;
  const invMassB = b.mass > 0 ? 1 / b.mass : 0;
  const invMassSum = invMassA + invMassB;

  if (invMassSum > 0) {
    const moveA = depth * (invMassA / invMassSum);
    const moveB = depth * (invMassB / invMassSum);
    a.x -= nx * moveA;
    a.y -= ny * moveA;
    b.x += nx * moveB;
    b.y += ny * moveB;

    const rvx = b.vx - a.vx;
    const rvy = b.vy - a.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn < 0) {
      const restitution = Math.max(a.restitution, b.restitution, 0);
      const jn = (-(1 + restitution) * vn) / invMassSum;
      a.vx -= jn * nx * invMassA;
      a.vy -= jn * ny * invMassA;
      b.vx += jn * nx * invMassB;
      b.vy += jn * ny * invMassB;

      // Tangential friction after the normal impulse.
      const rvx2 = b.vx - a.vx;
      const rvy2 = b.vy - a.vy;
      const vn2 = rvx2 * nx + rvy2 * ny;
      let tx = rvx2 - vn2 * nx;
      let ty = rvy2 - vn2 * ny;
      const tangentSq = tx * tx + ty * ty;
      if (tangentSq > 1e-12) {
        const tangentInv = 1 / Math.sqrt(tangentSq);
        tx *= tangentInv;
        ty *= tangentInv;
        const vt = rvx2 * tx + rvy2 * ty;
        let jt = -vt / invMassSum;
        const maxJt = clamp01((a.friction + b.friction) * 0.5) * jn;
        if (jt > maxJt) {
          jt = maxJt;
        } else if (jt < -maxJt) {
          jt = -maxJt;
        }
        a.vx -= jt * tx * invMassA;
        a.vy -= jt * ty * invMassA;
        b.vx += jt * tx * invMassB;
        b.vy += jt * ty * invMassB;
      }
    }
  }

  if (out !== undefined) {
    out.nx = nx;
    out.ny = ny;
    out.depth = depth;
  }
  return true;
}

/**
 * Semi-implicit Euler step with arena walls.
 *
 * Callers apply gravity/acceleration to `vx`/`vy` first; `integrate` advances
 * position with the current velocity, clamps speed, then keeps the circle
 * inside the arena. A wall reverses the incoming normal velocity scaled by
 * `body.restitution`. Bodies that are inactive or a non-positive `dt` are
 * left untouched, which keeps pooled slots and paused frames stable.
 */
export function integrate(body: CircleBody, dt: number, arena: Arena): void {
  if (!body.active || !(dt > 0)) {
    return;
  }

  clampSpeed(body);
  body.x += body.vx * dt;
  body.y += body.vy * dt;

  const r = body.radius;
  const restitution = body.restitution > 0 ? body.restitution : 0;

  if (body.x - r < arena.minX) {
    body.x = arena.minX + r;
    if (body.vx < 0) {
      body.vx = -body.vx * restitution;
    }
  } else if (body.x + r > arena.maxX) {
    body.x = arena.maxX - r;
    if (body.vx > 0) {
      body.vx = -body.vx * restitution;
    }
  }

  if (body.y - r < arena.minY) {
    body.y = arena.minY + r;
    if (body.vy < 0) {
      body.vy = -body.vy * restitution;
    }
  } else if (body.y + r > arena.maxY) {
    body.y = arena.maxY - r;
    if (body.vy > 0) {
      body.vy = -body.vy * restitution;
    }
  }

  clampSpeed(body);
}

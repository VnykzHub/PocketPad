/**
 * Circle-vs-circle bumper collision (GAME-SB-HOST-02, GAME-SB-TEST-01).
 *
 * The game is a game package, so it may not import engine internals
 * (`packages/engine/physics`) and must not pull a physics backend into the
 * host bundle. This is a compact, pure equivalent of the engine's
 * `resolveCircleCircle`: inverse-mass positional correction plus a normal
 * impulse with restitution. Bumpers have equal radii; the `mass` field exists
 * so a heavier body can shove a lighter one (TEST-01) and tests can vary it.
 *
 * The function mutates its two bodies and fills a caller-owned `Contact`, so
 * the per-tick collision pass allocates nothing after warm-up. `Contact` is
 * written only when a contact actually happens; callers test `hit`.
 */

/** One dynamic bumper in normalized arena space. */
export interface CircleBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Mass in arbitrary units; only ratios matter. Must be > 0. */
  mass: number;
  /** Inactive bodies are skipped and never generate a contact. */
  active: boolean;
}

/** Reused collision output; valid only when `hit` is true. */
export interface Contact {
  hit: boolean;
  /** Unit normal pointing from body A toward body B. */
  nx: number;
  ny: number;
  /** Closing speed along the normal before the impulse, units/s. */
  impact: number;
}

/** Allocates one reusable contact record; call once per collision pair. */
export function createContact(): Contact {
  return { hit: false, nx: 0, ny: 0, impact: 0 };
}

/** Inverse mass, treating a non-positive mass as static (infinite mass). */
function inverseMass(body: CircleBody): number {
  return body.mass > 0 && Number.isFinite(body.mass) ? 1 / body.mass : 0;
}

/**
 * Resolves one overlapping pair.
 *
 * - Separates the bodies along the centre line, split by inverse mass, so a
 *   heavy bumper moves less than a light one.
 * - Applies a restitution impulse only when the bodies are closing; a pair
 *   already separating is separated positionally but not kicked.
 * - Identical centres use the +x axis as a deterministic fallback.
 *
 * `out.hit` is false (and the other fields untouched) when the bodies do not
 * overlap or either one is inactive.
 */
export function resolveCircleCircle(
  a: CircleBody,
  b: CircleBody,
  out: Contact,
  restitution: number,
): Contact {
  if (!a.active || !b.active) return out;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const reach = a.radius + b.radius;
  const distSq = dx * dx + dy * dy;
  if (distSq >= reach * reach) return out;

  let nx = 1;
  let ny = 0;
  let dist = 0;
  if (distSq > 0) {
    dist = Math.sqrt(distSq);
    nx = dx / dist;
    ny = dy / dist;
  }

  const invA = inverseMass(a);
  const invB = inverseMass(b);
  const invTotal = invA + invB;
  if (invTotal === 0) return out;

  const penetration = reach - dist;
  a.x -= nx * penetration * (invA / invTotal);
  a.y -= ny * penetration * (invA / invTotal);
  b.x += nx * penetration * (invB / invTotal);
  b.y += ny * penetration * (invB / invTotal);

  const relativeX = b.vx - a.vx;
  const relativeY = b.vy - a.vy;
  const closing = -(relativeX * nx + relativeY * ny);

  out.hit = true;
  out.nx = nx;
  out.ny = ny;
  out.impact = closing > 0 ? closing : 0;

  if (closing > 0) {
    const bounce = Number.isFinite(restitution) ? Math.max(0, restitution) : 0;
    const impulse = ((1 + bounce) * closing) / invTotal;
    a.vx -= impulse * invA * nx;
    a.vy -= impulse * invA * ny;
    b.vx += impulse * invB * nx;
    b.vy += impulse * invB * ny;
  }

  return out;
}

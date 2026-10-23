/**
 * Deadzone math (10 §5.8.2).
 *
 * Radial: inside the deadzone both components are zero; above it the vector
 * is rescaled so the deadzone boundary maps continuously to zero and full
 * deflection maps to magnitude 1. Scalar: the same reshaping per component,
 * preserving sign. Deadzone 0 is an exact pass-through for valid input.
 */

export interface MutablePair {
  x: number;
  y: number;
}

/** Writes the deadzoned pair; never allocates. */
export function radialDeadzoneInto(
  x: number,
  y: number,
  deadzone: number,
  out: MutablePair,
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const dz = deadzone <= 0 ? 0 : deadzone >= 1 ? 1 : deadzone;
  if (dz >= 1) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const magnitude = Math.hypot(x, y);
  if (!(magnitude > dz)) {
    out.x = 0;
    out.y = 0;
    return;
  }
  if (dz === 0) {
    out.x = x;
    out.y = y;
    return;
  }
  const scaled = (magnitude - dz) / (1 - dz);
  // Rescaling can round one ulp above the input near full deflection; a
  // deadzone must never amplify, so clamp the magnitude (direction preserved).
  const bounded = scaled > magnitude ? magnitude : scaled;
  out.x = (x / magnitude) * bounded;
  out.y = (y / magnitude) * bounded;
}

/** Test-friendly allocating form of `radialDeadzoneInto`. */
export function applyRadialDeadzone(
  x: number,
  y: number,
  deadzone: number,
): MutablePair {
  const out: MutablePair = { x: 0, y: 0 };
  radialDeadzoneInto(x, y, deadzone, out);
  return out;
}

/** Scalar deadzone; preserves sign and returns 0 inside the zone. */
export function scalarDeadzone(value: number, deadzone: number): number {
  if (!Number.isFinite(value)) return 0;
  const dz = deadzone <= 0 ? 0 : deadzone >= 1 ? 1 : deadzone;
  if (dz >= 1) return 0;
  const magnitude = Math.abs(value);
  if (magnitude <= dz) return 0;
  if (dz === 0) return value;
  const scaled = (magnitude - dz) / (1 - dz);
  // Never amplify: rounding can exceed the input by one ulp near 1.
  return Math.sign(value) * (scaled > magnitude ? magnitude : scaled);
}

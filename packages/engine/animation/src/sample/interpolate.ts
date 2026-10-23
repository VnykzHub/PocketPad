/**
 * Scalar interpolation helpers (spec 08 §5.4, §5.5).
 *
 * These operate on flat pose arrays so sampling and composition allocate
 * nothing. Quaternion rounding follows spec 02 §3.7: shortest arc, normalized
 * on every write.
 */

/** Linear interpolation of scalar components; `out` may alias `a`/`b`. */
export function lerpInto(
  out: Float32Array,
  outOffset: number,
  a: Float32Array,
  aOffset: number,
  b: Float32Array,
  bOffset: number,
  count: number,
  t: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const av = a[aOffset + i]!;
    out[outOffset + i] = av + (b[bOffset + i]! - av) * t;
  }
}

/** Component-wise copy of `count` floats; `out` may alias `source`. */
export function copyInto(
  out: Float32Array,
  outOffset: number,
  source: Float32Array,
  sourceOffset: number,
  count: number,
): void {
  for (let i = 0; i < count; i += 1) {
    out[outOffset + i] = source[sourceOffset + i]!;
  }
}

/**
 * Shortest-arc normalized linear interpolation of two quaternions stored in
 * flat arrays. Writes a unit quaternion; a degenerate result writes identity.
 */
export function nlerpInto(
  out: Float32Array,
  outOffset: number,
  a: Float32Array,
  aOffset: number,
  b: Float32Array,
  bOffset: number,
  t: number,
): void {
  const ax = a[aOffset]!;
  const ay = a[aOffset + 1]!;
  const az = a[aOffset + 2]!;
  const aw = a[aOffset + 3]!;
  const dot =
    ax * b[bOffset]! +
    ay * b[bOffset + 1]! +
    az * b[bOffset + 2]! +
    aw * b[bOffset + 3]!;
  const sign = dot < 0 ? -1 : 1;
  let x = ax + (b[bOffset]! * sign - ax) * t;
  let y = ay + (b[bOffset + 1]! * sign - ay) * t;
  let z = az + (b[bOffset + 2]! * sign - az) * t;
  let w = aw + (b[bOffset + 3]! * sign - aw) * t;
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    out[outOffset] = 0;
    out[outOffset + 1] = 0;
    out[outOffset + 2] = 0;
    out[outOffset + 3] = 1;
    return;
  }
  const inv = 1 / norm;
  x *= inv;
  y *= inv;
  z *= inv;
  w *= inv;
  out[outOffset] = x;
  out[outOffset + 1] = y;
  out[outOffset + 2] = z;
  out[outOffset + 3] = w;
}

/** Normalizes a quaternion in place; degenerate writes identity. */
export function normalizeQuatAt(values: Float32Array, offset: number): void {
  const x = values[offset]!;
  const y = values[offset + 1]!;
  const z = values[offset + 2]!;
  const w = values[offset + 3]!;
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    values[offset] = 0;
    values[offset + 1] = 0;
    values[offset + 2] = 0;
    values[offset + 3] = 1;
    return;
  }
  const inv = 1 / norm;
  values[offset] = x * inv;
  values[offset + 1] = y * inv;
  values[offset + 2] = z * inv;
  values[offset + 3] = w * inv;
}

/**
 * §4.6 canonical sign: `w >= 0`; when `w == 0`, `x >= 0`. Mutates the copy in
 * a flat array; the caller hashes a scratch copy, never the pose itself.
 */
export function canonicalizeQuatAt(values: Float32Array, offset: number): void {
  const w = values[offset + 3]!;
  const flip = w < 0 || (w === 0 && values[offset]! < 0);
  if (!flip) return;
  values[offset] = -values[offset]!;
  values[offset + 1] = -values[offset + 1]!;
  values[offset + 2] = -values[offset + 2]!;
  values[offset + 3] = -w;
}

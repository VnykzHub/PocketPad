/**
 * Vec3 (02 §3.4). Right-handed, +Y up, −Z forward. Plain mutable data.
 *
 * Every function with an `out` parameter reads its inputs before writing, so
 * `out` may alias any input. No function allocates.
 */

import { EPSILON } from "./constants.js";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Allocates; cold path only. */
export function vec3Create(x: number = 0, y: number = 0, z: number = 0): Vec3 {
  return { x, y, z };
}

export function vec3Set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3Copy(out: Vec3, a: Vec3): Vec3 {
  const x = a.x;
  const y = a.y;
  const z = a.z;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3Add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.x + b.x;
  const y = a.y + b.y;
  const z = a.z + b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3Sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.x - b.x;
  const y = a.y - b.y;
  const z = a.z - b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3Scale(out: Vec3, a: Vec3, scalar: number): Vec3 {
  const x = a.x * scalar;
  const y = a.y * scalar;
  const z = a.z * scalar;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3AddScaled(
  out: Vec3,
  a: Vec3,
  b: Vec3,
  scalar: number,
): Vec3 {
  const x = a.x + b.x * scalar;
  const y = a.y + b.y * scalar;
  const z = a.z + b.z * scalar;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3Negate(out: Vec3, a: Vec3): Vec3 {
  const x = -a.x;
  const y = -a.y;
  const z = -a.z;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3Cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3LengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function vec3Length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function vec3DistanceSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Writes the unit vector and returns the original length; zero writes (0,0,0). */
export function vec3Normalize(out: Vec3, a: Vec3): number {
  const x = a.x;
  const y = a.y;
  const z = a.z;
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length > 0) {
    out.x = x / length;
    out.y = y / length;
    out.z = z / length;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
  }
  return length;
}

export function vec3Lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  const z = a.z + (b.z - a.z) * t;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3Min(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.x < b.x ? a.x : b.x;
  const y = a.y < b.y ? a.y : b.y;
  const z = a.z < b.z ? a.z : b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3Max(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.x > b.x ? a.x : b.x;
  const y = a.y > b.y ? a.y : b.y;
  const z = a.z > b.z ? a.z : b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec3Abs(out: Vec3, a: Vec3): Vec3 {
  const x = Math.abs(a.x);
  const y = Math.abs(a.y);
  const z = Math.abs(a.z);
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** Clamps the length; a non-positive `maxLength` collapses to (0,0,0). */
export function vec3ClampLength(
  out: Vec3,
  a: Vec3,
  maxLength: number,
): Vec3 {
  const x = a.x;
  const y = a.y;
  const z = a.z;
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length <= maxLength || length === 0) {
    out.x = x;
    out.y = y;
    out.z = z;
  } else {
    const scale = maxLength > 0 ? maxLength / length : 0;
    out.x = x * scale;
    out.y = y * scale;
    out.z = z * scale;
  }
  return out;
}

export function vec3Equals(
  a: Vec3,
  b: Vec3,
  epsilon: number = EPSILON,
): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.z - b.z) <= epsilon
  );
}

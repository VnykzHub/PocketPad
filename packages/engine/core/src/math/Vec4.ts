/**
 * Vec4 (02 §3.4). Plain mutable data; every `out` may alias an input.
 */

import { EPSILON } from "./constants.js";
import type { Vec3 } from "./Vec3.js";

export interface Vec4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Allocates; cold path only. */
export function vec4Create(
  x: number = 0,
  y: number = 0,
  z: number = 0,
  w: number = 0,
): Vec4 {
  return { x, y, z, w };
}

export function vec4Set(
  out: Vec4,
  x: number,
  y: number,
  z: number,
  w: number,
): Vec4 {
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function vec4Copy(out: Vec4, a: Vec4): Vec4 {
  const x = a.x;
  const y = a.y;
  const z = a.z;
  const w = a.w;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function vec4FromVec3(out: Vec4, a: Vec3, w: number): Vec4 {
  const x = a.x;
  const y = a.y;
  const z = a.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

/** Drops w, no divide. */
export function vec4ToVec3(out: Vec3, a: Vec4): Vec3 {
  const x = a.x;
  const y = a.y;
  const z = a.z;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vec4Add(out: Vec4, a: Vec4, b: Vec4): Vec4 {
  const x = a.x + b.x;
  const y = a.y + b.y;
  const z = a.z + b.z;
  const w = a.w + b.w;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function vec4Sub(out: Vec4, a: Vec4, b: Vec4): Vec4 {
  const x = a.x - b.x;
  const y = a.y - b.y;
  const z = a.z - b.z;
  const w = a.w - b.w;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function vec4Scale(out: Vec4, a: Vec4, scalar: number): Vec4 {
  const x = a.x * scalar;
  const y = a.y * scalar;
  const z = a.z * scalar;
  const w = a.w * scalar;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function vec4Dot(a: Vec4, b: Vec4): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

export function vec4LengthSq(a: Vec4): number {
  return a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w;
}

export function vec4Length(a: Vec4): number {
  return Math.sqrt(vec4LengthSq(a));
}

/** Writes the unit vector and returns the original length; zero writes (0,0,0,0). */
export function vec4Normalize(out: Vec4, a: Vec4): number {
  const x = a.x;
  const y = a.y;
  const z = a.z;
  const w = a.w;
  const length = Math.sqrt(x * x + y * y + z * z + w * w);
  if (length > 0) {
    out.x = x / length;
    out.y = y / length;
    out.z = z / length;
    out.w = w / length;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 0;
  }
  return length;
}

export function vec4Lerp(out: Vec4, a: Vec4, b: Vec4, t: number): Vec4 {
  const x = a.x + (b.x - a.x) * t;
  const y = a.y + (b.y - a.y) * t;
  const z = a.z + (b.z - a.z) * t;
  const w = a.w + (b.w - a.w) * t;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function vec4Equals(
  a: Vec4,
  b: Vec4,
  epsilon: number = EPSILON,
): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.z - b.z) <= epsilon &&
    Math.abs(a.w - b.w) <= epsilon
  );
}

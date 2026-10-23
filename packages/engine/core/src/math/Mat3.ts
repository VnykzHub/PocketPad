/**
 * Mat3 (02 §3.5): 9 floats, column-major, element (row r, column c) is
 * `m[c * 3 + r]`. Primarily a normal matrix; not an affine 2D transform.
 *
 * Mutating functions read every input element before writing, so `out` may
 * alias `a`.
 */

import { EPSILON } from "./constants.js";
import type { Mat4 } from "./Mat4.js";
import type { Vec2 } from "./Vec2.js";

export interface Mat3 {
  readonly m: Float32Array;
}

/** Allocates a zeroed matrix; cold path only. */
export function mat3Create(): Mat3 {
  return { m: new Float32Array(9) };
}

export function mat3Identity(out: Mat3): Mat3 {
  const m = out.m;
  m[0] = 1;
  m[1] = 0;
  m[2] = 0;
  m[3] = 0;
  m[4] = 1;
  m[5] = 0;
  m[6] = 0;
  m[7] = 0;
  m[8] = 1;
  return out;
}

export function mat3Copy(out: Mat3, a: Mat3): Mat3 {
  const a0 = a.m[0]!;
  const a1 = a.m[1]!;
  const a2 = a.m[2]!;
  const a3 = a.m[3]!;
  const a4 = a.m[4]!;
  const a5 = a.m[5]!;
  const a6 = a.m[6]!;
  const a7 = a.m[7]!;
  const a8 = a.m[8]!;
  const m = out.m;
  m[0] = a0;
  m[1] = a1;
  m[2] = a2;
  m[3] = a3;
  m[4] = a4;
  m[5] = a5;
  m[6] = a6;
  m[7] = a7;
  m[8] = a8;
  return out;
}

/** 9 values, column-major. Missing values are treated as 0. */
export function mat3Set(out: Mat3, ...values: readonly number[]): Mat3 {
  const m = out.m;
  for (let i = 0; i < 9; i += 1) {
    const value = values[i];
    m[i] = value === undefined ? 0 : value;
  }
  return out;
}

/** Upper-left 3×3. */
export function mat3FromMat4(out: Mat3, a: Mat4): Mat3 {
  const am = a.m;
  const m0 = am[0]!;
  const m1 = am[1]!;
  const m2 = am[2]!;
  const m4 = am[4]!;
  const m5 = am[5]!;
  const m6 = am[6]!;
  const m8 = am[8]!;
  const m9 = am[9]!;
  const m10 = am[10]!;
  const m = out.m;
  m[0] = m0;
  m[1] = m1;
  m[2] = m2;
  m[3] = m4;
  m[4] = m5;
  m[5] = m6;
  m[6] = m8;
  m[7] = m9;
  m[8] = m10;
  return out;
}

/** out = a * b. */
export function mat3Multiply(out: Mat3, a: Mat3, b: Mat3): Mat3 {
  const am = a.m;
  const bm = b.m;
  const a0 = am[0]!;
  const a1 = am[1]!;
  const a2 = am[2]!;
  const a3 = am[3]!;
  const a4 = am[4]!;
  const a5 = am[5]!;
  const a6 = am[6]!;
  const a7 = am[7]!;
  const a8 = am[8]!;
  const b0 = bm[0]!;
  const b1 = bm[1]!;
  const b2 = bm[2]!;
  const b3 = bm[3]!;
  const b4 = bm[4]!;
  const b5 = bm[5]!;
  const b6 = bm[6]!;
  const b7 = bm[7]!;
  const b8 = bm[8]!;
  const m = out.m;
  m[0] = a0 * b0 + a3 * b1 + a6 * b2;
  m[1] = a1 * b0 + a4 * b1 + a7 * b2;
  m[2] = a2 * b0 + a5 * b1 + a8 * b2;
  m[3] = a0 * b3 + a3 * b4 + a6 * b5;
  m[4] = a1 * b3 + a4 * b4 + a7 * b5;
  m[5] = a2 * b3 + a5 * b4 + a8 * b5;
  m[6] = a0 * b6 + a3 * b7 + a6 * b8;
  m[7] = a1 * b6 + a4 * b7 + a7 * b8;
  m[8] = a2 * b6 + a5 * b7 + a8 * b8;
  return out;
}

export function mat3Transpose(out: Mat3, a: Mat3): Mat3 {
  const am = a.m;
  const a0 = am[0]!;
  const a1 = am[1]!;
  const a2 = am[2]!;
  const a3 = am[3]!;
  const a4 = am[4]!;
  const a5 = am[5]!;
  const a6 = am[6]!;
  const a7 = am[7]!;
  const a8 = am[8]!;
  const m = out.m;
  m[0] = a0;
  m[1] = a3;
  m[2] = a6;
  m[3] = a1;
  m[4] = a4;
  m[5] = a7;
  m[6] = a2;
  m[7] = a5;
  m[8] = a8;
  return out;
}

/** Returns false and zeroes `out` for a singular matrix. */
export function mat3Invert(out: Mat3, a: Mat3): boolean {
  const am = a.m;
  const a0 = am[0]!;
  const a1 = am[1]!;
  const a2 = am[2]!;
  const a3 = am[3]!;
  const a4 = am[4]!;
  const a5 = am[5]!;
  const a6 = am[6]!;
  const a7 = am[7]!;
  const a8 = am[8]!;
  const det = mat3Determinant(a);
  const m = out.m;
  if (det === 0 || !Number.isFinite(det)) {
    m[0] = 0;
    m[1] = 0;
    m[2] = 0;
    m[3] = 0;
    m[4] = 0;
    m[5] = 0;
    m[6] = 0;
    m[7] = 0;
    m[8] = 0;
    return false;
  }
  const inv = 1 / det;
  m[0] = (a4 * a8 - a5 * a7) * inv;
  m[1] = (a2 * a7 - a1 * a8) * inv;
  m[2] = (a1 * a5 - a2 * a4) * inv;
  m[3] = (a5 * a6 - a3 * a8) * inv;
  m[4] = (a0 * a8 - a2 * a6) * inv;
  m[5] = (a2 * a3 - a0 * a5) * inv;
  m[6] = (a3 * a7 - a4 * a6) * inv;
  m[7] = (a1 * a6 - a0 * a7) * inv;
  m[8] = (a0 * a4 - a1 * a3) * inv;
  return true;
}

export function mat3Determinant(a: Mat3): number {
  const m = a.m;
  const a0 = m[0]!;
  const a1 = m[1]!;
  const a2 = m[2]!;
  const a3 = m[3]!;
  const a4 = m[4]!;
  const a5 = m[5]!;
  const a6 = m[6]!;
  const a7 = m[7]!;
  const a8 = m[8]!;
  return (
    a0 * (a4 * a8 - a5 * a7) -
    a3 * (a1 * a8 - a2 * a7) +
    a6 * (a1 * a5 - a2 * a4)
  );
}

/** Linear 2×2 application on x/y; the third column is ignored. */
export function mat3TransformVec2(out: Vec2, a: Mat3, v: Vec2): Vec2 {
  const m = a.m;
  const x = v.x;
  const y = v.y;
  const rx = m[0]! * x + m[3]! * y;
  const ry = m[1]! * x + m[4]! * y;
  out.x = rx;
  out.y = ry;
  return out;
}

export function mat3Equals(
  a: Mat3,
  b: Mat3,
  epsilon: number = EPSILON,
): boolean {
  const am = a.m;
  const bm = b.m;
  for (let i = 0; i < 9; i += 1) {
    if (Math.abs(am[i]! - bm[i]!) > epsilon) {
      return false;
    }
  }
  return true;
}

/**
 * Mat4 (02 §3.6): 16 floats, column-major, element (row r, column c) is
 * `m[c * 4 + r]`. Column vectors; `mat4Multiply(out, a, b)` is `out = a * b`.
 *
 * Two projection families exist because clip-space depth differs:
 * WebGL2 z ∈ [-1, 1], WebGPU z ∈ [0, 1]. Nothing in this module branches on a
 * backend; the caller picks the family and passes the matching `clip` to
 * `frustumFromViewProjection`.
 */

import { IS_DEV, PI } from "./constants.js";
import { quatFromRotationElements, quatToMat4 } from "./Quat.js";
import type { Quat } from "./Quat.js";
import type { Vec3 } from "./Vec3.js";
import type { Vec4 } from "./Vec4.js";

export interface Mat4 {
  readonly m: Float32Array;
}

/** 02 §3.9: orientation / orthonormal-basis tolerance on a dot product. */
const ORTHONORMAL_TOLERANCE = 1e-5;

/** Allocates a zeroed matrix; cold path only. */
export function mat4Create(): Mat4 {
  return { m: new Float32Array(16) };
}

export function mat4Identity(out: Mat4): Mat4 {
  const m = out.m;
  m[0] = 1;
  m[1] = 0;
  m[2] = 0;
  m[3] = 0;
  m[4] = 0;
  m[5] = 1;
  m[6] = 0;
  m[7] = 0;
  m[8] = 0;
  m[9] = 0;
  m[10] = 1;
  m[11] = 0;
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  m[15] = 1;
  return out;
}

export function mat4Copy(out: Mat4, a: Mat4): Mat4 {
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
  const a9 = am[9]!;
  const a10 = am[10]!;
  const a11 = am[11]!;
  const a12 = am[12]!;
  const a13 = am[13]!;
  const a14 = am[14]!;
  const a15 = am[15]!;
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
  m[9] = a9;
  m[10] = a10;
  m[11] = a11;
  m[12] = a12;
  m[13] = a13;
  m[14] = a14;
  m[15] = a15;
  return out;
}

/** 16 values, column-major. Missing values are treated as 0. */
export function mat4Set(out: Mat4, ...values: readonly number[]): Mat4 {
  const m = out.m;
  for (let i = 0; i < 16; i += 1) {
    const value = values[i];
    m[i] = value === undefined ? 0 : value;
  }
  return out;
}

/** out = a * b. */
export function mat4Multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
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
  const a9 = am[9]!;
  const a10 = am[10]!;
  const a11 = am[11]!;
  const a12 = am[12]!;
  const a13 = am[13]!;
  const a14 = am[14]!;
  const a15 = am[15]!;
  const b0 = bm[0]!;
  const b1 = bm[1]!;
  const b2 = bm[2]!;
  const b3 = bm[3]!;
  const b4 = bm[4]!;
  const b5 = bm[5]!;
  const b6 = bm[6]!;
  const b7 = bm[7]!;
  const b8 = bm[8]!;
  const b9 = bm[9]!;
  const b10 = bm[10]!;
  const b11 = bm[11]!;
  const b12 = bm[12]!;
  const b13 = bm[13]!;
  const b14 = bm[14]!;
  const b15 = bm[15]!;
  const m = out.m;
  m[0] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
  m[1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
  m[2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
  m[3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
  m[4] = a0 * b4 + a4 * b5 + a8 * b6 + a12 * b7;
  m[5] = a1 * b4 + a5 * b5 + a9 * b6 + a13 * b7;
  m[6] = a2 * b4 + a6 * b5 + a10 * b6 + a14 * b7;
  m[7] = a3 * b4 + a7 * b5 + a11 * b6 + a15 * b7;
  m[8] = a0 * b8 + a4 * b9 + a8 * b10 + a12 * b11;
  m[9] = a1 * b8 + a5 * b9 + a9 * b10 + a13 * b11;
  m[10] = a2 * b8 + a6 * b9 + a10 * b10 + a14 * b11;
  m[11] = a3 * b8 + a7 * b9 + a11 * b10 + a15 * b11;
  m[12] = a0 * b12 + a4 * b13 + a8 * b14 + a12 * b15;
  m[13] = a1 * b12 + a5 * b13 + a9 * b14 + a13 * b15;
  m[14] = a2 * b12 + a6 * b13 + a10 * b14 + a14 * b15;
  m[15] = a3 * b12 + a7 * b13 + a11 * b14 + a15 * b15;
  return out;
}

export function mat4Transpose(out: Mat4, a: Mat4): Mat4 {
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
  const a9 = am[9]!;
  const a10 = am[10]!;
  const a11 = am[11]!;
  const a12 = am[12]!;
  const a13 = am[13]!;
  const a14 = am[14]!;
  const a15 = am[15]!;
  const m = out.m;
  m[0] = a0;
  m[1] = a4;
  m[2] = a8;
  m[3] = a12;
  m[4] = a1;
  m[5] = a5;
  m[6] = a9;
  m[7] = a13;
  m[8] = a2;
  m[9] = a6;
  m[10] = a10;
  m[11] = a14;
  m[12] = a3;
  m[13] = a7;
  m[14] = a11;
  m[15] = a15;
  return out;
}

/** Returns false and zeroes `out` for a singular matrix. */
export function mat4Invert(out: Mat4, a: Mat4): boolean {
  const am = a.m;
  const a00 = am[0]!;
  const a01 = am[1]!;
  const a02 = am[2]!;
  const a03 = am[3]!;
  const a10 = am[4]!;
  const a11 = am[5]!;
  const a12 = am[6]!;
  const a13 = am[7]!;
  const a20 = am[8]!;
  const a21 = am[9]!;
  const a22 = am[10]!;
  const a23 = am[11]!;
  const a30 = am[12]!;
  const a31 = am[13]!;
  const a32 = am[14]!;
  const a33 = am[15]!;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det =
    b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const m = out.m;
  if (det === 0 || !Number.isFinite(det)) {
    for (let i = 0; i < 16; i += 1) {
      m[i] = 0;
    }
    return false;
  }
  const inv = 1 / det;
  m[0] = (a11 * b11 - a12 * b10 + a13 * b09) * inv;
  m[1] = (a02 * b10 - a01 * b11 - a03 * b09) * inv;
  m[2] = (a31 * b05 - a32 * b04 + a33 * b03) * inv;
  m[3] = (a22 * b04 - a21 * b05 - a23 * b03) * inv;
  m[4] = (a12 * b08 - a10 * b11 - a13 * b07) * inv;
  m[5] = (a00 * b11 - a02 * b08 + a03 * b07) * inv;
  m[6] = (a32 * b02 - a30 * b05 - a33 * b01) * inv;
  m[7] = (a20 * b05 - a22 * b02 + a23 * b01) * inv;
  m[8] = (a10 * b10 - a11 * b08 + a13 * b06) * inv;
  m[9] = (a01 * b08 - a00 * b10 - a03 * b06) * inv;
  m[10] = (a30 * b04 - a31 * b02 + a33 * b00) * inv;
  m[11] = (a21 * b02 - a20 * b04 - a23 * b00) * inv;
  m[12] = (a11 * b07 - a10 * b09 - a12 * b06) * inv;
  m[13] = (a00 * b09 - a01 * b07 + a02 * b06) * inv;
  m[14] = (a31 * b01 - a30 * b03 - a32 * b00) * inv;
  m[15] = (a20 * b03 - a21 * b01 + a22 * b00) * inv;
  return true;
}

export function mat4Determinant(a: Mat4): number {
  const m = a.m;
  const a00 = m[0]!;
  const a01 = m[1]!;
  const a02 = m[2]!;
  const a03 = m[3]!;
  const a10 = m[4]!;
  const a11 = m[5]!;
  const a12 = m[6]!;
  const a13 = m[7]!;
  const a20 = m[8]!;
  const a21 = m[9]!;
  const a22 = m[10]!;
  const a23 = m[11]!;
  const a30 = m[12]!;
  const a31 = m[13]!;
  const a32 = m[14]!;
  const a33 = m[15]!;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  return b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
}

export function mat4FromTranslation(out: Mat4, translation: Vec3): Mat4 {
  const tx = translation.x;
  const ty = translation.y;
  const tz = translation.z;
  mat4Identity(out);
  const m = out.m;
  m[12] = tx;
  m[13] = ty;
  m[14] = tz;
  return out;
}

export function mat4FromScale(out: Mat4, scale: Vec3): Mat4 {
  const sx = scale.x;
  const sy = scale.y;
  const sz = scale.z;
  const m = out.m;
  m[0] = sx;
  m[1] = 0;
  m[2] = 0;
  m[3] = 0;
  m[4] = 0;
  m[5] = sy;
  m[6] = 0;
  m[7] = 0;
  m[8] = 0;
  m[9] = 0;
  m[10] = sz;
  m[11] = 0;
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  m[15] = 1;
  return out;
}

/** Non-unit input is normalized implicitly; zero produces the identity. */
export function mat4FromQuat(out: Mat4, rotation: Quat): Mat4 {
  return quatToMat4(out, rotation);
}

export function mat4FromAxisAngle(
  out: Mat4,
  axis: Vec3,
  radians: number,
): Mat4 {
  const ax = axis.x;
  const ay = axis.y;
  const az = axis.z;
  const length = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!(length > 0) || !Number.isFinite(length)) {
    return mat4Identity(out);
  }
  const x = ax / length;
  const y = ay / length;
  const z = az / length;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const t = 1 - c;
  const m = out.m;
  m[0] = t * x * x + c;
  m[1] = t * x * y + s * z;
  m[2] = t * x * z - s * y;
  m[3] = 0;
  m[4] = t * x * y - s * z;
  m[5] = t * y * y + c;
  m[6] = t * y * z + s * x;
  m[7] = 0;
  m[8] = t * x * z + s * y;
  m[9] = t * y * z - s * x;
  m[10] = t * z * z + c;
  m[11] = 0;
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  m[15] = 1;
  return out;
}

export function mat4FromRotationX(out: Mat4, radians: number): Mat4 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const m = out.m;
  m[0] = 1;
  m[1] = 0;
  m[2] = 0;
  m[3] = 0;
  m[4] = 0;
  m[5] = c;
  m[6] = s;
  m[7] = 0;
  m[8] = 0;
  m[9] = -s;
  m[10] = c;
  m[11] = 0;
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  m[15] = 1;
  return out;
}

export function mat4FromRotationY(out: Mat4, radians: number): Mat4 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const m = out.m;
  m[0] = c;
  m[1] = 0;
  m[2] = -s;
  m[3] = 0;
  m[4] = 0;
  m[5] = 1;
  m[6] = 0;
  m[7] = 0;
  m[8] = s;
  m[9] = 0;
  m[10] = c;
  m[11] = 0;
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  m[15] = 1;
  return out;
}

export function mat4FromRotationZ(out: Mat4, radians: number): Mat4 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const m = out.m;
  m[0] = c;
  m[1] = s;
  m[2] = 0;
  m[3] = 0;
  m[4] = -s;
  m[5] = c;
  m[6] = 0;
  m[7] = 0;
  m[8] = 0;
  m[9] = 0;
  m[10] = 1;
  m[11] = 0;
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  m[15] = 1;
  return out;
}

/** out = T(position) * R(rotation) * S(scale). */
export function mat4Compose(
  out: Mat4,
  position: Vec3,
  rotation: Quat,
  scale: Vec3,
): Mat4 {
  const px = position.x;
  const py = position.y;
  const pz = position.z;
  const sx = scale.x;
  const sy = scale.y;
  const sz = scale.z;
  quatToMat4(out, rotation);
  const m = out.m;
  m[0] = m[0]! * sx;
  m[1] = m[1]! * sx;
  m[2] = m[2]! * sx;
  m[4] = m[4]! * sy;
  m[5] = m[5]! * sy;
  m[6] = m[6]! * sy;
  m[8] = m[8]! * sz;
  m[9] = m[9]! * sz;
  m[10] = m[10]! * sz;
  m[12] = px;
  m[13] = py;
  m[14] = pz;
  m[15] = 1;
  return out;
}

/**
 * Splits a TRS matrix. Returns false for a singular or sheared matrix; `out`
 * fields then hold the last valid values rather than NaN (02 §3.6).
 *
 * Negative determinant is folded into `scale.x` only, so
 * `compose(decompose(M))` reproduces a TRS `M`.
 */
export function mat4Decompose(
  outPosition: Vec3,
  outRotation: Quat,
  outScale: Vec3,
  a: Mat4,
): boolean {
  const m = a.m;
  const c0x = m[0]!;
  const c0y = m[1]!;
  const c0z = m[2]!;
  const c1x = m[4]!;
  const c1y = m[5]!;
  const c1z = m[6]!;
  const c2x = m[8]!;
  const c2y = m[9]!;
  const c2z = m[10]!;
  const len0 = Math.sqrt(c0x * c0x + c0y * c0y + c0z * c0z);
  const len1 = Math.sqrt(c1x * c1x + c1y * c1y + c1z * c1z);
  const len2 = Math.sqrt(c2x * c2x + c2y * c2y + c2z * c2z);
  if (
    !(len0 > 0) ||
    !(len1 > 0) ||
    !(len2 > 0) ||
    !Number.isFinite(len0) ||
    !Number.isFinite(len1) ||
    !Number.isFinite(len2)
  ) {
    return false;
  }
  const det =
    c0x * (c1y * c2z - c1z * c2y) -
    c0y * (c1x * c2z - c1z * c2x) +
    c0z * (c1x * c2y - c1y * c2x);
  const sign = det < 0 ? -1 : 1;
  const r0x = (c0x / len0) * sign;
  const r0y = (c0y / len0) * sign;
  const r0z = (c0z / len0) * sign;
  const r1x = c1x / len1;
  const r1y = c1y / len1;
  const r1z = c1z / len1;
  const r2x = c2x / len2;
  const r2y = c2y / len2;
  const r2z = c2z / len2;
  if (
    Math.abs(r0x * r1x + r0y * r1y + r0z * r1z) > ORTHONORMAL_TOLERANCE ||
    Math.abs(r0x * r2x + r0y * r2y + r0z * r2z) > ORTHONORMAL_TOLERANCE ||
    Math.abs(r1x * r2x + r1y * r2y + r1z * r2z) > ORTHONORMAL_TOLERANCE
  ) {
    return false;
  }
  // Row-major arguments: (m00, m01, m02, m10, m11, m12, m20, m21, m22).
  if (
    !quatFromRotationElements(
      outRotation,
      r0x,
      r1x,
      r2x,
      r0y,
      r1y,
      r2y,
      r0z,
      r1z,
      r2z,
    )
  ) {
    return false;
  }
  outScale.x = len0 * sign;
  outScale.y = len1;
  outScale.z = len2;
  outPosition.x = m[12]!;
  outPosition.y = m[13]!;
  outPosition.z = m[14]!;
  return true;
}

export function mat4GetTranslation(out: Vec3, a: Mat4): Vec3 {
  const m = a.m;
  out.x = m[12]!;
  out.y = m[13]!;
  out.z = m[14]!;
  return out;
}

export function mat4GetScale(out: Vec3, a: Mat4): Vec3 {
  const m = a.m;
  const c0x = m[0]!;
  const c0y = m[1]!;
  const c0z = m[2]!;
  const c1x = m[4]!;
  const c1y = m[5]!;
  const c1z = m[6]!;
  const c2x = m[8]!;
  const c2y = m[9]!;
  const c2z = m[10]!;
  out.x = Math.sqrt(c0x * c0x + c0y * c0y + c0z * c0z);
  out.y = Math.sqrt(c1x * c1x + c1y * c1y + c1z * c1z);
  out.z = Math.sqrt(c2x * c2x + c2y * c2y + c2z * c2z);
  return out;
}

/** Assumes no shear; returns false when decomposition fails. */
export function mat4GetRotation(out: Quat, a: Mat4): boolean {
  const m = a.m;
  const c0x = m[0]!;
  const c0y = m[1]!;
  const c0z = m[2]!;
  const c1x = m[4]!;
  const c1y = m[5]!;
  const c1z = m[6]!;
  const c2x = m[8]!;
  const c2y = m[9]!;
  const c2z = m[10]!;
  const len0 = Math.sqrt(c0x * c0x + c0y * c0y + c0z * c0z);
  const len1 = Math.sqrt(c1x * c1x + c1y * c1y + c1z * c1z);
  const len2 = Math.sqrt(c2x * c2x + c2y * c2y + c2z * c2z);
  if (
    !(len0 > 0) ||
    !(len1 > 0) ||
    !(len2 > 0) ||
    !Number.isFinite(len0) ||
    !Number.isFinite(len1) ||
    !Number.isFinite(len2)
  ) {
    return false;
  }
  const det =
    c0x * (c1y * c2z - c1z * c2y) -
    c0y * (c1x * c2z - c1z * c2x) +
    c0z * (c1x * c2y - c1y * c2x);
  const sign = det < 0 ? -1 : 1;
  const r0x = (c0x / len0) * sign;
  const r0y = (c0y / len0) * sign;
  const r0z = (c0z / len0) * sign;
  const r1x = c1x / len1;
  const r1y = c1y / len1;
  const r1z = c1z / len1;
  const r2x = c2x / len2;
  const r2y = c2y / len2;
  const r2z = c2z / len2;
  if (
    Math.abs(r0x * r1x + r0y * r1y + r0z * r1z) > ORTHONORMAL_TOLERANCE ||
    Math.abs(r0x * r2x + r0y * r2y + r0z * r2z) > ORTHONORMAL_TOLERANCE ||
    Math.abs(r1x * r2x + r1y * r2y + r1z * r2z) > ORTHONORMAL_TOLERANCE
  ) {
    return false;
  }
  return quatFromRotationElements(
    out,
    r0x,
    r1x,
    r2x,
    r0y,
    r1y,
    r2y,
    r0z,
    r1z,
    r2z,
  );
}

function validatePerspective(
  fnName: string,
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): void {
  if (!IS_DEV) {
    return;
  }
  if (!(fovY > 0) || fovY >= PI) {
    throw new RangeError(`${fnName}: fovY must be in (0, PI)`);
  }
  if (!(aspect > 0)) {
    throw new RangeError(`${fnName}: aspect must be > 0`);
  }
  if (!(near > 0)) {
    throw new RangeError(`${fnName}: near must be > 0`);
  }
  if (!(far > near)) {
    throw new RangeError(`${fnName}: far must be > near`);
  }
}

function validateOrthographic(
  fnName: string,
  left: number,
  right: number,
): void {
  if (IS_DEV && left === right) {
    throw new RangeError(`${fnName}: left must differ from right`);
  }
}

/**
 * Right-handed perspective; NDC z ∈ [-1, 1].
 * `f = 1/tan(fovY/2)`; m[0]=f/aspect, m[5]=f,
 * m[10]=(far+near)/(near−far), m[11]=−1,
 * m[14]=(2·far·near)/(near−far).
 */
export function mat4PerspectiveWebGL2(
  out: Mat4,
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  validatePerspective("mat4PerspectiveWebGL2", fovY, aspect, near, far);
  const f = 1 / Math.tan(fovY * 0.5);
  const m = out.m;
  m[0] = f / aspect;
  m[1] = 0;
  m[2] = 0;
  m[3] = 0;
  m[4] = 0;
  m[5] = f;
  m[6] = 0;
  m[7] = 0;
  m[8] = 0;
  m[9] = 0;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[12] = 0;
  m[13] = 0;
  m[14] = (2 * far * near) / (near - far);
  m[15] = 0;
  return out;
}

/**
 * Right-handed perspective; NDC z ∈ [0, 1].
 * Same m[0]/m[5]/m[11]; m[10]=far/(near−far),
 * m[14]=(far·near)/(near−far).
 */
export function mat4PerspectiveWebGPU(
  out: Mat4,
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  validatePerspective("mat4PerspectiveWebGPU", fovY, aspect, near, far);
  const f = 1 / Math.tan(fovY * 0.5);
  const m = out.m;
  m[0] = f / aspect;
  m[1] = 0;
  m[2] = 0;
  m[3] = 0;
  m[4] = 0;
  m[5] = f;
  m[6] = 0;
  m[7] = 0;
  m[8] = 0;
  m[9] = 0;
  m[10] = far / (near - far);
  m[11] = -1;
  m[12] = 0;
  m[13] = 0;
  m[14] = (far * near) / (near - far);
  m[15] = 0;
  return out;
}

/** m[0]=2/(r−l), m[5]=2/(t−b), m[10]=−2/(f−n), m[15]=1. */
export function mat4OrthographicWebGL2(
  out: Mat4,
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  validateOrthographic("mat4OrthographicWebGL2", left, right);
  const m = out.m;
  m[0] = 2 / (right - left);
  m[1] = 0;
  m[2] = 0;
  m[3] = 0;
  m[4] = 0;
  m[5] = 2 / (top - bottom);
  m[6] = 0;
  m[7] = 0;
  m[8] = 0;
  m[9] = 0;
  m[10] = -2 / (far - near);
  m[11] = 0;
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = -(far + near) / (far - near);
  m[15] = 1;
  return out;
}

/** m[0]=2/(r−l), m[5]=2/(t−b), m[10]=−1/(f−n), m[14]=−n/(f−n), m[15]=1. */
export function mat4OrthographicWebGPU(
  out: Mat4,
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  validateOrthographic("mat4OrthographicWebGPU", left, right);
  const m = out.m;
  m[0] = 2 / (right - left);
  m[1] = 0;
  m[2] = 0;
  m[3] = 0;
  m[4] = 0;
  m[5] = 2 / (top - bottom);
  m[6] = 0;
  m[7] = 0;
  m[8] = 0;
  m[9] = 0;
  m[10] = -1 / (far - near);
  m[11] = 0;
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = -near / (far - near);
  m[15] = 1;
  return out;
}

/**
 * Right-handed view matrix; `up` is normalized internally. Forward is −Z.
 * Degenerate input (eye === target, zero up) writes the identity; a
 * forward/up pair that is parallel falls back to a stable up axis.
 */
export function mat4LookAt(
  out: Mat4,
  eye: Vec3,
  target: Vec3,
  up: Vec3,
): Mat4 {
  const ex = eye.x;
  const ey = eye.y;
  const ez = eye.z;
  const dx = target.x - ex;
  const dy = target.y - ey;
  const dz = target.z - ez;
  const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(dl > 0) || !Number.isFinite(dl)) {
    return mat4Identity(out);
  }
  const fx = dx / dl;
  const fy = dy / dl;
  const fz = dz / dl;
  let ux = up.x;
  let uy = up.y;
  let uz = up.z;
  let ul = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (!(ul > 0) || !Number.isFinite(ul)) {
    ux = 0;
    uy = 1;
    uz = 0;
    ul = 1;
  }
  ux /= ul;
  uy /= ul;
  uz /= ul;
  let sx = fy * uz - fz * uy;
  let sy = fz * ux - fx * uz;
  let sz = fx * uy - fy * ux;
  let sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (!(sl > 1e-12) || !Number.isFinite(sl)) {
    // Forward is parallel to up: pick a stable alternative up.
    if (Math.abs(fy) < 0.9) {
      ux = 0;
      uy = 1;
      uz = 0;
    } else {
      ux = 1;
      uy = 0;
      uz = 0;
    }
    sx = fy * uz - fz * uy;
    sy = fz * ux - fx * uz;
    sz = fx * uy - fy * ux;
    sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (!(sl > 1e-12) || !Number.isFinite(sl)) {
      return mat4Identity(out);
    }
  }
  sx /= sl;
  sy /= sl;
  sz /= sl;
  const ux2 = sy * fz - sz * fy;
  const uy2 = sz * fx - sx * fz;
  const uz2 = sx * fy - sy * fx;
  const m = out.m;
  m[0] = sx;
  m[1] = ux2;
  m[2] = -fx;
  m[3] = 0;
  m[4] = sy;
  m[5] = uy2;
  m[6] = -fy;
  m[7] = 0;
  m[8] = sz;
  m[9] = uz2;
  m[10] = -fz;
  m[11] = 0;
  m[12] = -(sx * ex + sy * ey + sz * ez);
  m[13] = -(ux2 * ex + uy2 * ey + uz2 * ez);
  m[14] = fx * ex + fy * ey + fz * ez;
  m[15] = 1;
  return out;
}

/** Applies the full matrix and divides by w when w is finite and non-zero. */
export function mat4TransformVec4(out: Vec4, a: Mat4, v: Vec4): Vec4 {
  const m = a.m;
  const vx = v.x;
  const vy = v.y;
  const vz = v.z;
  const vw = v.w;
  const x = m[0]! * vx + m[4]! * vy + m[8]! * vz + m[12]! * vw;
  const y = m[1]! * vx + m[5]! * vy + m[9]! * vz + m[13]! * vw;
  const z = m[2]! * vx + m[6]! * vy + m[10]! * vz + m[14]! * vw;
  const w = m[3]! * vx + m[7]! * vy + m[11]! * vz + m[15]! * vw;
  if (Number.isFinite(w) && w !== 0) {
    out.x = x / w;
    out.y = y / w;
    out.z = z / w;
    out.w = w / w;
  } else {
    out.x = x;
    out.y = y;
    out.z = z;
    out.w = w;
  }
  return out;
}

/** Applies with w = 1, then divides by w. */
export function mat4TransformPoint(out: Vec3, a: Mat4, point: Vec3): Vec3 {
  const m = a.m;
  const px = point.x;
  const py = point.y;
  const pz = point.z;
  const x = m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!;
  const y = m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!;
  const z = m[2]! * px + m[6]! * py + m[10]! * pz + m[14]!;
  const w = m[3]! * px + m[7]! * py + m[11]! * pz + m[15]!;
  if (Number.isFinite(w) && w !== 0) {
    out.x = x / w;
    out.y = y / w;
    out.z = z / w;
  } else {
    out.x = x;
    out.y = y;
    out.z = z;
  }
  return out;
}

/** Upper-left 3×3 only; no translation, no divide. */
export function mat4TransformDirection(
  out: Vec3,
  a: Mat4,
  direction: Vec3,
): Vec3 {
  const m = a.m;
  const x = direction.x;
  const y = direction.y;
  const z = direction.z;
  out.x = m[0]! * x + m[4]! * y + m[8]! * z;
  out.y = m[1]! * x + m[5]! * y + m[9]! * z;
  out.z = m[2]! * x + m[6]! * y + m[10]! * z;
  return out;
}

export function mat4Equals(
  a: Mat4,
  b: Mat4,
  epsilon: number = 1e-6,
): boolean {
  const am = a.m;
  const bm = b.m;
  for (let i = 0; i < 16; i += 1) {
    if (Math.abs(am[i]! - bm[i]!) > epsilon) {
      return false;
    }
  }
  return true;
}

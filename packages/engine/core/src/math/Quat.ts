/**
 * Quat (02 §3.7): unit quaternion `(x, y, z, w)` rotating column vectors as
 * `v' = q v q*`.
 *
 * `quatMultiply(out, a, b)` is `a * b`; rotating by `a` then by `b` is
 * `b * a` (the fixture `math-quat-order.json` pins this).
 */

import { DEV_COUNTERS, EPSILON, EPSILON_SCALAR, IS_DEV } from "./constants.js";
import type { Mat3 } from "./Mat3.js";
import type { Mat4 } from "./Mat4.js";
import type { Vec3 } from "./Vec3.js";

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Allocates; default identity. */
export function quatCreate(
  x: number = 0,
  y: number = 0,
  z: number = 0,
  w: number = 1,
): Quat {
  return { x, y, z, w };
}

export function quatIdentity(out: Quat): Quat {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  out.w = 1;
  return out;
}

export function quatSet(
  out: Quat,
  x: number,
  y: number,
  z: number,
  w: number,
): Quat {
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function quatCopy(out: Quat, a: Quat): Quat {
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

/** out = a * b. Rotating by a then b is b * a. */
export function quatMultiply(out: Quat, a: Quat, b: Quat): Quat {
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const aw = a.w;
  const bx = b.x;
  const by = b.y;
  const bz = b.z;
  const bw = b.w;
  const x = aw * bx + ax * bw + ay * bz - az * by;
  const y = aw * by - ax * bz + ay * bw + az * bx;
  const z = aw * bz + ax * by - ay * bx + az * bw;
  const w = aw * bw - ax * bx - ay * by - az * bz;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function quatConjugate(out: Quat, a: Quat): Quat {
  const x = -a.x;
  const y = -a.y;
  const z = -a.z;
  const w = a.w;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

/** Unit inverse; non-unit input returns conjugate / lengthSq. Zero writes identity. */
export function quatInvert(out: Quat, a: Quat): Quat {
  const x = a.x;
  const y = a.y;
  const z = a.z;
  const w = a.w;
  const lengthSq = x * x + y * y + z * z + w * w;
  if (!(lengthSq > 0) || !Number.isFinite(lengthSq)) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return out;
  }
  const inv = 1 / lengthSq;
  out.x = -x * inv;
  out.y = -y * inv;
  out.z = -z * inv;
  out.w = w * inv;
  return out;
}

/** Writes the unit quaternion and returns the original length; zero writes identity. */
export function quatNormalize(out: Quat, a: Quat): number {
  const x = a.x;
  const y = a.y;
  const z = a.z;
  const w = a.w;
  const length = Math.sqrt(x * x + y * y + z * z + w * w);
  if (length > 0 && Number.isFinite(length)) {
    const inv = 1 / length;
    out.x = x * inv;
    out.y = y * inv;
    out.z = z * inv;
    out.w = w * inv;
  } else {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return 0;
  }
  return length;
}

export function quatDot(a: Quat, b: Quat): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

export function quatLengthSq(a: Quat): number {
  return a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w;
}

export function quatLength(a: Quat): number {
  return Math.sqrt(quatLengthSq(a));
}

export function quatFromAxisAngle(
  out: Quat,
  axis: Vec3,
  radians: number,
): Quat {
  const ax = axis.x;
  const ay = axis.y;
  const az = axis.z;
  const length = Math.sqrt(ax * ax + ay * ay + az * az);
  if (!(length > 0) || !Number.isFinite(length)) {
    return quatIdentity(out);
  }
  const inv = 1 / length;
  const half = radians * 0.5;
  const s = Math.sin(half);
  out.x = ax * inv * s;
  out.y = ay * inv * s;
  out.z = az * inv * s;
  out.w = Math.cos(half);
  return out;
}

/**
 * YXZ intrinsic: yaw about +Y, then pitch about local +X, then roll about
 * local +Z; `q = qY * qX * qZ`.
 */
export function quatFromEulerYXZ(
  out: Quat,
  x: number,
  y: number,
  z: number,
): Quat {
  const hx = x * 0.5;
  const hy = y * 0.5;
  const hz = z * 0.5;
  const sx = Math.sin(hx);
  const cx = Math.cos(hx);
  const sy = Math.sin(hy);
  const cy = Math.cos(hy);
  const sz = Math.sin(hz);
  const cz = Math.cos(hz);
  out.x = cy * sx * cz + sy * cx * sz;
  out.y = -cy * sx * sz + sy * cx * cz;
  out.z = cy * cx * sz - sy * sx * cz;
  out.w = cy * cx * cz + sy * sx * sz;
  return out;
}

/** Non-unit input is normalized implicitly; zero writes the identity matrix. */
export function quatToMat3(out: Mat3, a: Quat): Mat3 {
  let x = a.x;
  let y = a.y;
  let z = a.z;
  let w = a.w;
  const lengthSq = x * x + y * y + z * z + w * w;
  if (!(lengthSq > 0) || !Number.isFinite(lengthSq)) {
    if (IS_DEV) {
      DEV_COUNTERS.zeroQuaternion += 1;
    }
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
  const inv = 1 / Math.sqrt(lengthSq);
  x *= inv;
  y *= inv;
  z *= inv;
  w *= inv;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  const m = out.m;
  m[0] = 1 - 2 * (yy + zz);
  m[1] = 2 * (xy + wz);
  m[2] = 2 * (xz - wy);
  m[3] = 2 * (xy - wz);
  m[4] = 1 - 2 * (xx + zz);
  m[5] = 2 * (yz + wx);
  m[6] = 2 * (xz + wy);
  m[7] = 2 * (yz - wx);
  m[8] = 1 - 2 * (xx + yy);
  return out;
}

/** Non-unit input is normalized implicitly; zero writes the identity matrix. */
export function quatToMat4(out: Mat4, a: Quat): Mat4 {
  let x = a.x;
  let y = a.y;
  let z = a.z;
  let w = a.w;
  const lengthSq = x * x + y * y + z * z + w * w;
  if (!(lengthSq > 0) || !Number.isFinite(lengthSq)) {
    if (IS_DEV) {
      DEV_COUNTERS.zeroQuaternion += 1;
    }
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
  const inv = 1 / Math.sqrt(lengthSq);
  x *= inv;
  y *= inv;
  z *= inv;
  w *= inv;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  const m = out.m;
  m[0] = 1 - 2 * (yy + zz);
  m[1] = 2 * (xy + wz);
  m[2] = 2 * (xz - wy);
  m[3] = 0;
  m[4] = 2 * (xy - wz);
  m[5] = 1 - 2 * (xx + zz);
  m[6] = 2 * (yz + wx);
  m[7] = 0;
  m[8] = 2 * (xz + wy);
  m[9] = 2 * (yz - wx);
  m[10] = 1 - 2 * (xx + yy);
  m[11] = 0;
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  m[15] = 1;
  return out;
}

/** Rotates a vector by a unit quaternion; `out` may alias `v`. */
export function quatRotateVec3(out: Vec3, q: Quat, v: Vec3): Vec3 {
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
  const vx = v.x;
  const vy = v.y;
  const vz = v.z;
  // t = 2 * (q.xyz × v); v' = v + qw * t + q.xyz × t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Shortest-arc spherical interpolation; endpoints exact, t clamped to [0,1]. */
export function quatSlerp(out: Quat, a: Quat, b: Quat, t: number): Quat {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  if (tt === 0) {
    return quatCopy(out, a);
  }
  if (tt === 1) {
    return quatCopy(out, b);
  }
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const aw = a.w;
  const bx0 = b.x;
  const by0 = b.y;
  const bz0 = b.z;
  const bw0 = b.w;
  const dot = ax * bx0 + ay * by0 + az * bz0 + aw * bw0;
  const sign = dot < 0 ? -1 : 1;
  const bx = bx0 * sign;
  const by = by0 * sign;
  const bz = bz0 * sign;
  const bw = bw0 * sign;
  const cosTheta = Math.abs(dot) > 1 ? 1 : Math.abs(dot);
  if (cosTheta > 0.9995) {
    // Nearly parallel: normalized lerp avoids dividing by a near-zero sine.
    let x = ax + (bx - ax) * tt;
    let y = ay + (by - ay) * tt;
    let z = az + (bz - az) * tt;
    let w = aw + (bw - aw) * tt;
    const norm = Math.sqrt(x * x + y * y + z * z + w * w);
    if (norm > 0 && Number.isFinite(norm)) {
      const inv = 1 / norm;
      x *= inv;
      y *= inv;
      z *= inv;
      w *= inv;
    } else {
      return quatIdentity(out);
    }
    out.x = x;
    out.y = y;
    out.z = z;
    out.w = w;
    return out;
  }
  const theta = Math.acos(cosTheta);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - tt) * theta) / sinTheta;
  const wb = Math.sin(tt * theta) / sinTheta;
  out.x = wa * ax + wb * bx;
  out.y = wa * ay + wb * by;
  out.z = wa * az + wb * bz;
  out.w = wa * aw + wb * bw;
  return out;
}

/** Normalized linear interpolation; cheaper, not constant-speed. */
export function quatNlerp(out: Quat, a: Quat, b: Quat, t: number): Quat {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  if (tt === 0) {
    return quatCopy(out, a);
  }
  if (tt === 1) {
    return quatCopy(out, b);
  }
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const aw = a.w;
  const dot = ax * b.x + ay * b.y + az * b.z + aw * b.w;
  const sign = dot < 0 ? -1 : 1;
  const bx = b.x * sign;
  const by = b.y * sign;
  const bz = b.z * sign;
  const bw = b.w * sign;
  let x = ax + (bx - ax) * tt;
  let y = ay + (by - ay) * tt;
  let z = az + (bz - az) * tt;
  let w = aw + (bw - aw) * tt;
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    return quatIdentity(out);
  }
  const inv = 1 / norm;
  x *= inv;
  y *= inv;
  z *= inv;
  w *= inv;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

/** Angle in [0, PI] between two unit quaternions. */
export function quatAngleBetween(a: Quat, b: Quat): number {
  const dot = Math.abs(quatDot(a, b));
  return 2 * Math.acos(dot > 1 ? 1 : dot);
}

/**
 * Returns false for a matrix with a mirrored or non-orthogonal basis.
 * The returned quaternion has w >= 0 for deterministic comparison.
 */
export function quatFromMat4(out: Quat, a: Mat4): boolean {
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
  const r0x = c0x / len0;
  const r0y = c0y / len0;
  const r0z = c0z / len0;
  const r1x = c1x / len1;
  const r1y = c1y / len1;
  const r1z = c1z / len1;
  const r2x = c2x / len2;
  const r2y = c2y / len2;
  const r2z = c2z / len2;
  const det =
    r0x * (r1y * r2z - r1z * r2y) -
    r0y * (r1x * r2z - r1z * r2x) +
    r0z * (r1x * r2y - r1y * r2x);
  if (!(det > 0)) {
    return false;
  }
  if (
    Math.abs(r0x * r1x + r0y * r1y + r0z * r1z) > 1e-5 ||
    Math.abs(r0x * r2x + r0y * r2y + r0z * r2z) > 1e-5 ||
    Math.abs(r1x * r2x + r1y * r2y + r1z * r2z) > 1e-5
  ) {
    return false;
  }
  // Row-major arguments: (m00, m01, m02, m10, m11, m12, m20, m21, m22).
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

/**
 * Shortest rotation from unit vector `from` to unit vector `to`; opposite
 * vectors pick a stable perpendicular axis.
 */
export function quatFromTo(out: Quat, from: Vec3, to: Vec3): Quat {
  const fx0 = from.x;
  const fy0 = from.y;
  const fz0 = from.z;
  const tx0 = to.x;
  const ty0 = to.y;
  const tz0 = to.z;
  const fl = Math.sqrt(fx0 * fx0 + fy0 * fy0 + fz0 * fz0);
  const tl = Math.sqrt(tx0 * tx0 + ty0 * ty0 + tz0 * tz0);
  if (!(fl > 0) || !(tl > 0) || !Number.isFinite(fl) || !Number.isFinite(tl)) {
    return quatIdentity(out);
  }
  const fx = fx0 / fl;
  const fy = fy0 / fl;
  const fz = fz0 / fl;
  const tx = tx0 / tl;
  const ty = ty0 / tl;
  const tz = tz0 / tl;
  const dot = fx * tx + fy * ty + fz * tz;
  if (dot >= 1 - EPSILON_SCALAR) {
    return quatIdentity(out);
  }
  if (dot <= -1 + EPSILON_SCALAR) {
    // Stable perpendicular: cross(from, X) unless from is nearly ±X.
    let ax: number;
    let ay: number;
    let az: number;
    if (Math.abs(fx) < 0.9) {
      ax = 0;
      ay = fz;
      az = -fy;
    } else {
      ax = -fz;
      ay = 0;
      az = fx;
    }
    const al = Math.sqrt(ax * ax + ay * ay + az * az);
    if (!(al > 0) || !Number.isFinite(al)) {
      return quatIdentity(out);
    }
    const inv = 1 / al;
    out.x = ax * inv;
    out.y = ay * inv;
    out.z = az * inv;
    out.w = 0;
    return out;
  }
  let x = fy * tz - fz * ty;
  let y = fz * tx - fx * tz;
  let z = fx * ty - fy * tx;
  let w = 1 + dot;
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    return quatIdentity(out);
  }
  const inv = 1 / norm;
  x *= inv;
  y *= inv;
  z *= inv;
  w *= inv;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

/** Component-wise; q and −q are NOT equal. */
export function quatEquals(
  a: Quat,
  b: Quat,
  epsilon: number = EPSILON,
): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.z - b.z) <= epsilon &&
    Math.abs(a.w - b.w) <= epsilon
  );
}

/**
 * Builds a unit quaternion from a row-major rotation basis. Shared by
 * `quatFromMat4` and `mat4Decompose`; the result has w >= 0.
 *
 * @internal Not part of the 02 contract; excluded from the barrel.
 */
export function quatFromRotationElements(
  out: Quat,
  m00: number,
  m01: number,
  m02: number,
  m10: number,
  m11: number,
  m12: number,
  m20: number,
  m21: number,
  m22: number,
): boolean {
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    if (!(s > 0) || !Number.isFinite(s)) {
      return false;
    }
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    if (!(s > 0) || !Number.isFinite(s)) {
      return false;
    }
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    if (!(s > 0) || !Number.isFinite(s)) {
      return false;
    }
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    if (!(s > 0) || !Number.isFinite(s)) {
      return false;
    }
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const norm = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    return false;
  }
  const inv = 1 / norm;
  x *= inv;
  y *= inv;
  z *= inv;
  w *= inv;
  if (w < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return true;
}

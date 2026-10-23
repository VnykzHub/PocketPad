/**
 * Aabb2 / Aabb3 (02 §3.8).
 *
 * Aabb2 is the legacy 2D box: min corner plus positive extents, y-down.
 * Aabb3 stores min/max corners with min <= max per axis. Every function with
 * an `out` parameter reads inputs before writing, so `out` may alias inputs.
 */

import { mat4GetRotation } from "./Mat4.js";
import { quatIdentity } from "./Quat.js";
import type { Mat4 } from "./Mat4.js";
import type { Obb } from "./Obb.js";
import type { Vec2 } from "./Vec2.js";
import type { Vec3 } from "./Vec3.js";

export interface Aabb2 {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Aabb3 {
  min: Vec3;
  max: Vec3;
}

/** Allocates; cold path only. */
export function aabb2Create(
  x: number = 0,
  y: number = 0,
  w: number = 0,
  h: number = 0,
): Aabb2 {
  return { x, y, w, h };
}

export function aabb2Set(
  out: Aabb2,
  x: number,
  y: number,
  w: number,
  h: number,
): Aabb2 {
  out.x = x;
  out.y = y;
  out.w = w;
  out.h = h;
  return out;
}

export function aabb2Copy(out: Aabb2, a: Aabb2): Aabb2 {
  const x = a.x;
  const y = a.y;
  const w = a.w;
  const h = a.h;
  out.x = x;
  out.y = y;
  out.w = w;
  out.h = h;
  return out;
}

export function aabb2FromMinMax(
  out: Aabb2,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Aabb2 {
  out.x = minX;
  out.y = minY;
  out.w = maxX - minX;
  out.h = maxY - minY;
  return out;
}

export function aabb2Center(out: Vec2, a: Aabb2): Vec2 {
  out.x = a.x + a.w * 0.5;
  out.y = a.y + a.h * 0.5;
  return out;
}

/** Inclusive edges. */
export function aabb2ContainsPoint(a: Aabb2, point: Vec2): boolean {
  return (
    point.x >= a.x &&
    point.x <= a.x + a.w &&
    point.y >= a.y &&
    point.y <= a.y + a.h
  );
}

/** Touching counts. */
export function aabb2Intersects(a: Aabb2, b: Aabb2): boolean {
  return (
    a.x <= b.x + b.w &&
    b.x <= a.x + a.w &&
    a.y <= b.y + b.h &&
    b.y <= a.y + a.h
  );
}

/** `out` may alias either input. */
export function aabb2Union(out: Aabb2, a: Aabb2, b: Aabb2): Aabb2 {
  const ax0 = a.x;
  const ay0 = a.y;
  const ax1 = a.x + a.w;
  const ay1 = a.y + a.h;
  const bx0 = b.x;
  const by0 = b.y;
  const bx1 = b.x + b.w;
  const by1 = b.y + b.h;
  const minX = ax0 < bx0 ? ax0 : bx0;
  const minY = ay0 < by0 ? ay0 : by0;
  const maxX = ax1 > bx1 ? ax1 : bx1;
  const maxY = ay1 > by1 ? ay1 : by1;
  out.x = minX;
  out.y = minY;
  out.w = maxX - minX;
  out.h = maxY - minY;
  return out;
}

export function aabb2ClosestPoint(out: Vec2, a: Aabb2, point: Vec2): Vec2 {
  const px = point.x;
  const py = point.y;
  const minX = a.x;
  const minY = a.y;
  const maxX = a.x + a.w;
  const maxY = a.y + a.h;
  out.x = px < minX ? minX : px > maxX ? maxX : px;
  out.y = py < minY ? minY : py > maxY ? maxY : py;
  return out;
}

/** Allocates; cold path only. Zero-min, zero-max. */
export function aabb3Create(): Aabb3 {
  return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
}

export function aabb3Set(out: Aabb3, min: Vec3, max: Vec3): Aabb3 {
  const minX = min.x;
  const minY = min.y;
  const minZ = min.z;
  const maxX = max.x;
  const maxY = max.y;
  const maxZ = max.z;
  out.min.x = minX;
  out.min.y = minY;
  out.min.z = minZ;
  out.max.x = maxX;
  out.max.y = maxY;
  out.max.z = maxZ;
  return out;
}

export function aabb3Copy(out: Aabb3, a: Aabb3): Aabb3 {
  return aabb3Set(out, a.min, a.max);
}

export function aabb3FromCenterHalfExtents(
  out: Aabb3,
  center: Vec3,
  halfExtents: Vec3,
): Aabb3 {
  const cx = center.x;
  const cy = center.y;
  const cz = center.z;
  const hx = halfExtents.x;
  const hy = halfExtents.y;
  const hz = halfExtents.z;
  out.min.x = cx - hx;
  out.min.y = cy - hy;
  out.min.z = cz - hz;
  out.max.x = cx + hx;
  out.max.y = cy + hy;
  out.max.z = cz + hz;
  return out;
}

export function aabb3Center(out: Vec3, a: Aabb3): Vec3 {
  const minX = a.min.x;
  const minY = a.min.y;
  const minZ = a.min.z;
  out.x = (minX + a.max.x) * 0.5;
  out.y = (minY + a.max.y) * 0.5;
  out.z = (minZ + a.max.z) * 0.5;
  return out;
}

export function aabb3HalfExtents(out: Vec3, a: Aabb3): Vec3 {
  const minX = a.min.x;
  const minY = a.min.y;
  const minZ = a.min.z;
  out.x = (a.max.x - minX) * 0.5;
  out.y = (a.max.y - minY) * 0.5;
  out.z = (a.max.z - minZ) * 0.5;
  return out;
}

export function aabb3Size(out: Vec3, a: Aabb3): Vec3 {
  const minX = a.min.x;
  const minY = a.min.y;
  const minZ = a.min.z;
  out.x = a.max.x - minX;
  out.y = a.max.y - minY;
  out.z = a.max.z - minZ;
  return out;
}

/** `out` may alias either input. */
export function aabb3Union(out: Aabb3, a: Aabb3, b: Aabb3): Aabb3 {
  const ax0 = a.min.x;
  const ay0 = a.min.y;
  const az0 = a.min.z;
  const ax1 = a.max.x;
  const ay1 = a.max.y;
  const az1 = a.max.z;
  const bx0 = b.min.x;
  const by0 = b.min.y;
  const bz0 = b.min.z;
  const bx1 = b.max.x;
  const by1 = b.max.y;
  const bz1 = b.max.z;
  out.min.x = ax0 < bx0 ? ax0 : bx0;
  out.min.y = ay0 < by0 ? ay0 : by0;
  out.min.z = az0 < bz0 ? az0 : bz0;
  out.max.x = ax1 > bx1 ? ax1 : bx1;
  out.max.y = ay1 > by1 ? ay1 : by1;
  out.max.z = az1 > bz1 ? az1 : bz1;
  return out;
}

export function aabb3ExpandByPoint(out: Aabb3, a: Aabb3, point: Vec3): Aabb3 {
  const ax0 = a.min.x;
  const ay0 = a.min.y;
  const az0 = a.min.z;
  const ax1 = a.max.x;
  const ay1 = a.max.y;
  const az1 = a.max.z;
  const px = point.x;
  const py = point.y;
  const pz = point.z;
  out.min.x = ax0 < px ? ax0 : px;
  out.min.y = ay0 < py ? ay0 : py;
  out.min.z = az0 < pz ? az0 : pz;
  out.max.x = ax1 > px ? ax1 : px;
  out.max.y = ay1 > py ? ay1 : py;
  out.max.z = az1 > pz ? az1 : pz;
  return out;
}

/** Inclusive. */
export function aabb3ContainsPoint(a: Aabb3, point: Vec3): boolean {
  return (
    point.x >= a.min.x &&
    point.x <= a.max.x &&
    point.y >= a.min.y &&
    point.y <= a.max.y &&
    point.z >= a.min.z &&
    point.z <= a.max.z
  );
}

/** Touching counts. */
export function aabb3IntersectsAabb(a: Aabb3, b: Aabb3): boolean {
  return (
    a.min.x <= b.max.x &&
    b.min.x <= a.max.x &&
    a.min.y <= b.max.y &&
    b.min.y <= a.max.y &&
    a.min.z <= b.max.z &&
    b.min.z <= a.max.z
  );
}

export function aabb3IntersectsSphere(
  a: Aabb3,
  center: Vec3,
  radius: number,
): boolean {
  if (!(radius >= 0)) {
    return false;
  }
  const cx = center.x;
  const cy = center.y;
  const cz = center.z;
  const x = cx < a.min.x ? a.min.x : cx > a.max.x ? a.max.x : cx;
  const y = cy < a.min.y ? a.min.y : cy > a.max.y ? a.max.y : cy;
  const z = cz < a.min.z ? a.min.z : cz > a.max.z ? a.max.z : cz;
  const dx = cx - x;
  const dy = cy - y;
  const dz = cz - z;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

export function aabb3ClosestPoint(out: Vec3, a: Aabb3, point: Vec3): Vec3 {
  const px = point.x;
  const py = point.y;
  const pz = point.z;
  const minX = a.min.x;
  const minY = a.min.y;
  const minZ = a.min.z;
  const maxX = a.max.x;
  const maxY = a.max.y;
  const maxZ = a.max.z;
  out.x = px < minX ? minX : px > maxX ? maxX : px;
  out.y = py < minY ? minY : py > maxY ? maxY : py;
  out.z = pz < minZ ? minZ : pz > maxZ ? maxZ : pz;
  return out;
}

/**
 * Transforms the box into an OBB: the rotation is the matrix's normalized
 * basis, the extents are the box half-extents scaled by |axis scale|, and the
 * center is transformed as a point. A singular or sheared matrix writes an
 * identity rotation with zero extents (the center is still transformed).
 */
export function aabb3Transform(out: Obb, a: Aabb3, matrix: Mat4): Obb {
  const cx = (a.min.x + a.max.x) * 0.5;
  const cy = (a.min.y + a.max.y) * 0.5;
  const cz = (a.min.z + a.max.z) * 0.5;
  const hx = (a.max.x - a.min.x) * 0.5;
  const hy = (a.max.y - a.min.y) * 0.5;
  const hz = (a.max.z - a.min.z) * 0.5;
  const m = matrix.m;
  const px = m[0]! * cx + m[4]! * cy + m[8]! * cz + m[12]!;
  const py = m[1]! * cx + m[5]! * cy + m[9]! * cz + m[13]!;
  const pz = m[2]! * cx + m[6]! * cy + m[10]! * cz + m[14]!;
  const pw = m[3]! * cx + m[7]! * cy + m[11]! * cz + m[15]!;
  if (Number.isFinite(pw) && pw !== 0) {
    out.center.x = px / pw;
    out.center.y = py / pw;
    out.center.z = pz / pw;
  } else {
    out.center.x = px;
    out.center.y = py;
    out.center.z = pz;
  }
  const sx = Math.sqrt(m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!);
  const sy = Math.sqrt(m[4]! * m[4]! + m[5]! * m[5]! + m[6]! * m[6]!);
  const sz = Math.sqrt(m[8]! * m[8]! + m[9]! * m[9]! + m[10]! * m[10]!);
  if (!mat4GetRotation(out.rotation, matrix)) {
    quatIdentity(out.rotation);
    out.halfExtents.x = 0;
    out.halfExtents.y = 0;
    out.halfExtents.z = 0;
    return out;
  }
  out.halfExtents.x = hx * sx;
  out.halfExtents.y = hy * sy;
  out.halfExtents.z = hz * sz;
  return out;
}

/**
 * Plane (02 §3.8): `normal · x + constant = 0`, positive inside (the side the
 * normal points to). Normal is unit length by convention.
 */

import { rayIntersectPlane } from "./Ray.js";
import type { Ray } from "./Ray.js";
import type { Vec3 } from "./Vec3.js";

export interface Plane {
  normal: Vec3;
  constant: number;
}

/** Allocates; cold path only. Defaults to the +Y ground plane at y = 0. */
export function planeCreate(): Plane {
  return { normal: { x: 0, y: 1, z: 0 }, constant: 0 };
}

export function planeSet(out: Plane, normal: Vec3, constant: number): Plane {
  const nx = normal.x;
  const ny = normal.y;
  const nz = normal.z;
  out.normal.x = nx;
  out.normal.y = ny;
  out.normal.z = nz;
  out.constant = constant;
  return out;
}

export function planeCopy(out: Plane, a: Plane): Plane {
  return planeSet(out, a.normal, a.constant);
}

/**
 * Writes the unit normal and returns the original normal length. A zero normal
 * writes the default `(0,1,0)` plane and returns 0.
 */
export function planeNormalize(out: Plane, a: Plane): number {
  const nx = a.normal.x;
  const ny = a.normal.y;
  const nz = a.normal.z;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(length > 0) || !Number.isFinite(length)) {
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
    out.constant = 0;
    return 0;
  }
  out.normal.x = nx / length;
  out.normal.y = ny / length;
  out.normal.z = nz / length;
  out.constant = a.constant / length;
  return length;
}

export function planeFromPointNormal(
  out: Plane,
  point: Vec3,
  normal: Vec3,
): Plane {
  const nx = normal.x;
  const ny = normal.y;
  const nz = normal.z;
  out.normal.x = nx;
  out.normal.y = ny;
  out.normal.z = nz;
  out.constant = -(nx * point.x + ny * point.y + nz * point.z);
  return out;
}

/** False for collinear points; `out` is left untouched in that case. */
export function planeFromPoints(
  out: Plane,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): boolean {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(length > 0) || !Number.isFinite(length)) {
    return false;
  }
  const ux = nx / length;
  const uy = ny / length;
  const uz = nz / length;
  out.normal.x = ux;
  out.normal.y = uy;
  out.normal.z = uz;
  out.constant = -(ux * a.x + uy * a.y + uz * a.z);
  return true;
}

/** Positive inside. */
export function planeDistanceToPoint(a: Plane, point: Vec3): number {
  return (
    a.normal.x * point.x +
    a.normal.y * point.y +
    a.normal.z * point.z +
    a.constant
  );
}

export function planeProjectPoint(out: Vec3, a: Plane, point: Vec3): Vec3 {
  const px = point.x;
  const py = point.y;
  const pz = point.z;
  const distance = planeDistanceToPoint(a, point);
  const nx = a.normal.x;
  const ny = a.normal.y;
  const nz = a.normal.z;
  out.x = px - nx * distance;
  out.y = py - ny * distance;
  out.z = pz - nz * distance;
  return out;
}

/** Same rule as `rayIntersectPlane`: nearest t >= 0, or −1. */
export function planeIntersectRay(a: Plane, ray: Ray): number {
  return rayIntersectPlane(ray, a);
}

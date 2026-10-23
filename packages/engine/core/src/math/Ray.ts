/**
 * Ray (02 §3.8). Direction is unit length by convention.
 *
 * All intersection functions return the nearest `t >= 0` or −1 for a miss.
 * A ray whose origin is already inside a volume returns 0.
 */

import { EPSILON_DOUBLE } from "./constants.js";
import type { Aabb3 } from "./Aabb.js";
import type { Plane } from "./Plane.js";
import type { Vec3 } from "./Vec3.js";

export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

/** Allocates; cold path only. Defaults to origin at (0,0,0), forward −Z. */
export function rayCreate(): Ray {
  return {
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
  };
}

export function raySet(out: Ray, origin: Vec3, direction: Vec3): Ray {
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;
  const dx = direction.x;
  const dy = direction.y;
  const dz = direction.z;
  out.origin.x = ox;
  out.origin.y = oy;
  out.origin.z = oz;
  out.direction.x = dx;
  out.direction.y = dy;
  out.direction.z = dz;
  return out;
}

export function rayCopy(out: Ray, a: Ray): Ray {
  return raySet(out, a.origin, a.direction);
}

export function rayAt(out: Vec3, ray: Ray, t: number): Vec3 {
  out.x = ray.origin.x + ray.direction.x * t;
  out.y = ray.origin.y + ray.direction.y * t;
  out.z = ray.origin.z + ray.direction.z * t;
  return out;
}

/** Closest point on the ray; t clamped to >= 0. */
export function rayClosestPoint(out: Vec3, ray: Ray, point: Vec3): Vec3 {
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const t =
    (point.x - ox) * dx + (point.y - oy) * dy + (point.z - oz) * dz;
  const clamped = t > 0 ? t : 0;
  out.x = ox + dx * clamped;
  out.y = oy + dy * clamped;
  out.z = oz + dz * clamped;
  return out;
}

/** Nearest t >= 0, or −1 for a miss; a ray starting inside returns 0. */
export function rayIntersectSphere(
  ray: Ray,
  center: Vec3,
  radius: number,
): number {
  if (!(radius >= 0)) {
    return -1;
  }
  const ox = ray.origin.x - center.x;
  const oy = ray.origin.y - center.y;
  const oz = ray.origin.z - center.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) {
    return -1;
  }
  const discriminant = b * b - c;
  if (discriminant < 0) {
    return -1;
  }
  const t = -b - Math.sqrt(discriminant);
  return t < 0 ? 0 : t;
}

/** Slab test; nearest t >= 0, or −1. */
export function rayIntersectAabb(ray: Ray, box: Aabb3): number {
  const ox = ray.origin.x;
  const oy = ray.origin.y;
  const oz = ray.origin.z;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  let tMin = -Infinity;
  let tMax = Infinity;

  if (dx === 0) {
    if (ox < box.min.x || ox > box.max.x) {
      return -1;
    }
  } else {
    const inv = 1 / dx;
    let t1 = (box.min.x - ox) * inv;
    let t2 = (box.max.x - ox) * inv;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) {
      tMin = t1;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
  }

  if (dy === 0) {
    if (oy < box.min.y || oy > box.max.y) {
      return -1;
    }
  } else {
    const inv = 1 / dy;
    let t1 = (box.min.y - oy) * inv;
    let t2 = (box.max.y - oy) * inv;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) {
      tMin = t1;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
  }

  if (dz === 0) {
    if (oz < box.min.z || oz > box.max.z) {
      return -1;
    }
  } else {
    const inv = 1 / dz;
    let t1 = (box.min.z - oz) * inv;
    let t2 = (box.max.z - oz) * inv;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }
    if (t1 > tMin) {
      tMin = t1;
    }
    if (t2 < tMax) {
      tMax = t2;
    }
  }

  if (tMin > tMax || tMax < 0) {
    return -1;
  }
  return tMin < 0 ? 0 : tMin;
}

/** −1 when parallel or behind the origin. */
export function rayIntersectPlane(ray: Ray, plane: Plane): number {
  const nx = plane.normal.x;
  const ny = plane.normal.y;
  const nz = plane.normal.z;
  const denom =
    nx * ray.direction.x + ny * ray.direction.y + nz * ray.direction.z;
  if (Math.abs(denom) < EPSILON_DOUBLE) {
    return -1;
  }
  const t = -(
    nx * ray.origin.x +
    ny * ray.origin.y +
    nz * ray.origin.z +
    plane.constant
  ) / denom;
  return t >= 0 ? t : -1;
}

/** Möller–Trumbore; nearest t >= 0, or −1. */
export function rayIntersectTriangle(
  ray: Ray,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  cullBackfaces: boolean,
): number {
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const e1x = b.x - ax;
  const e1y = b.y - ay;
  const e1z = b.z - az;
  const e2x = c.x - ax;
  const e2y = c.y - ay;
  const e2z = c.z - az;
  const dx = ray.direction.x;
  const dy = ray.direction.y;
  const dz = ray.direction.z;
  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (cullBackfaces) {
    if (det < EPSILON_DOUBLE) {
      return -1;
    }
  } else if (Math.abs(det) < EPSILON_DOUBLE) {
    return -1;
  }
  const invDet = 1 / det;
  const sx = ray.origin.x - ax;
  const sy = ray.origin.y - ay;
  const sz = ray.origin.z - az;
  const u = (sx * hx + sy * hy + sz * hz) * invDet;
  if (u < 0 || u > 1) {
    return -1;
  }
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) {
    return -1;
  }
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t >= 0 ? t : -1;
}

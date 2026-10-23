/**
 * Frustum (02 §3.8). Six planes in the order left, right, bottom, top, near,
 * far, all with the positive-inside convention.
 *
 * Extraction reads the rows of the column-major view-projection matrix. Near
 * differs by clip space: WebGL2 `R3 + R2`, WebGPU `R2`. Far is `R3 − R2` for
 * both. The caller must pass the `clip` matching the projection it built.
 */

import { DEV_COUNTERS } from "./constants.js";
import { planeCreate } from "./Plane.js";
import type { Aabb3 } from "./Aabb.js";
import type { Mat4 } from "./Mat4.js";
import type { Obb } from "./Obb.js";
import type { Plane } from "./Plane.js";
import type { Vec3 } from "./Vec3.js";

export interface Frustum {
  readonly planes: readonly [Plane, Plane, Plane, Plane, Plane, Plane];
}

/** Allocates six planes; cold path only. */
export function frustumCreate(): Frustum {
  return {
    planes: [
      planeCreate(),
      planeCreate(),
      planeCreate(),
      planeCreate(),
      planeCreate(),
      planeCreate(),
    ],
  };
}

/** Writes one normalized plane; leaves it raw and counts on a zero normal. */
function setPlane(
  out: Plane,
  a: number,
  b: number,
  c: number,
  d: number,
): void {
  const length = Math.sqrt(a * a + b * b + c * c);
  if (length > 0 && Number.isFinite(length)) {
    const inv = 1 / length;
    out.normal.x = a * inv;
    out.normal.y = b * inv;
    out.normal.z = c * inv;
    out.constant = d * inv;
    return;
  }
  out.normal.x = a;
  out.normal.y = b;
  out.normal.z = c;
  out.constant = d;
  DEV_COUNTERS.frustumNormalizeFailure += 1;
}

/**
 * Extracts normalized planes from a column-major view-projection matrix.
 * Near row: R3+R2 for "webgl"; R2 for "webgpu". Far row: R3−R2 for both.
 */
export function frustumFromViewProjection(
  out: Frustum,
  viewProjection: Mat4,
  clip: "webgl" | "webgpu",
): Frustum {
  const m = viewProjection.m;
  const r0x = m[0]!;
  const r0y = m[4]!;
  const r0z = m[8]!;
  const r0w = m[12]!;
  const r1x = m[1]!;
  const r1y = m[5]!;
  const r1z = m[9]!;
  const r1w = m[13]!;
  const r2x = m[2]!;
  const r2y = m[6]!;
  const r2z = m[10]!;
  const r2w = m[14]!;
  const r3x = m[3]!;
  const r3y = m[7]!;
  const r3z = m[11]!;
  const r3w = m[15]!;
  const planes = out.planes;
  // left, right, bottom, top
  setPlane(planes[0], r3x + r0x, r3y + r0y, r3z + r0z, r3w + r0w);
  setPlane(planes[1], r3x - r0x, r3y - r0y, r3z - r0z, r3w - r0w);
  setPlane(planes[2], r3x + r1x, r3y + r1y, r3z + r1z, r3w + r1w);
  setPlane(planes[3], r3x - r1x, r3y - r1y, r3z - r1z, r3w - r1w);
  // near
  if (clip === "webgl") {
    setPlane(planes[4], r3x + r2x, r3y + r2y, r3z + r2z, r3w + r2w);
  } else {
    setPlane(planes[4], r2x, r2y, r2z, r2w);
  }
  // far
  setPlane(planes[5], r3x - r2x, r3y - r2y, r3z - r2z, r3w - r2w);
  return out;
}

/** Strictly inside all planes. */
export function frustumContainsPoint(frustum: Frustum, point: Vec3): boolean {
  const planes = frustum.planes;
  const px = point.x;
  const py = point.y;
  const pz = point.z;
  for (let i = 0; i < 6; i += 1) {
    const plane = planes[i]!;
    if (
      plane.normal.x * px +
        plane.normal.y * py +
        plane.normal.z * pz +
        plane.constant <=
      0
    ) {
      return false;
    }
  }
  return true;
}

export function frustumIntersectsSphere(
  frustum: Frustum,
  center: Vec3,
  radius: number,
): boolean {
  const planes = frustum.planes;
  const cx = center.x;
  const cy = center.y;
  const cz = center.z;
  for (let i = 0; i < 6; i += 1) {
    const plane = planes[i]!;
    const distance =
      plane.normal.x * cx +
      plane.normal.y * cy +
      plane.normal.z * cz +
      plane.constant;
    if (distance < -radius) {
      return false;
    }
  }
  return true;
}

/** Conservative: false only when fully outside at least one plane. */
export function frustumIntersectsAabb(frustum: Frustum, box: Aabb3): boolean {
  const planes = frustum.planes;
  for (let i = 0; i < 6; i += 1) {
    const plane = planes[i]!;
    const nx = plane.normal.x;
    const ny = plane.normal.y;
    const nz = plane.normal.z;
    const vx = nx >= 0 ? box.max.x : box.min.x;
    const vy = ny >= 0 ? box.max.y : box.min.y;
    const vz = nz >= 0 ? box.max.z : box.min.z;
    if (nx * vx + ny * vy + nz * vz + plane.constant < 0) {
      return false;
    }
  }
  return true;
}

/** Conservative: false only when fully outside at least one plane. */
export function frustumIntersectsObb(frustum: Frustum, box: Obb): boolean {
  let qx = box.rotation.x;
  let qy = box.rotation.y;
  let qz = box.rotation.z;
  let qw = box.rotation.w;
  let qLength = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  if (!(qLength > 0) || !Number.isFinite(qLength)) {
    qx = 0;
    qy = 0;
    qz = 0;
    qw = 1;
    qLength = 1;
  }
  qx /= qLength;
  qy /= qLength;
  qz /= qLength;
  qw /= qLength;
  // Rotation columns, same convention as quatToMat4.
  const c0x = 1 - 2 * (qy * qy + qz * qz);
  const c0y = 2 * (qx * qy + qw * qz);
  const c0z = 2 * (qx * qz - qw * qy);
  const c1x = 2 * (qx * qy - qw * qz);
  const c1y = 1 - 2 * (qx * qx + qz * qz);
  const c1z = 2 * (qy * qz + qw * qx);
  const c2x = 2 * (qx * qz + qw * qy);
  const c2y = 2 * (qy * qz - qw * qx);
  const c2z = 1 - 2 * (qx * qx + qy * qy);
  const hx = box.halfExtents.x;
  const hy = box.halfExtents.y;
  const hz = box.halfExtents.z;
  const cx = box.center.x;
  const cy = box.center.y;
  const cz = box.center.z;
  const planes = frustum.planes;
  for (let i = 0; i < 6; i += 1) {
    const plane = planes[i]!;
    const nx = plane.normal.x;
    const ny = plane.normal.y;
    const nz = plane.normal.z;
    const distance = nx * cx + ny * cy + nz * cz + plane.constant;
    const radius =
      Math.abs(nx * c0x + ny * c0y + nz * c0z) * hx +
      Math.abs(nx * c1x + ny * c1y + nz * c1z) * hy +
      Math.abs(nx * c2x + ny * c2y + nz * c2z) * hz;
    if (distance < -radius) {
      return false;
    }
  }
  return true;
}

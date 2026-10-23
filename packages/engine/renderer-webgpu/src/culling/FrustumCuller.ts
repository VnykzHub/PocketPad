/**
 * Frustum culling (04 §5.12). The culler owns its scratch frustum, matrix,
 * scale and center; `update` and every query are allocation-free.
 */

import {
  frustumCreate,
  frustumFromViewProjection,
  frustumIntersectsSphere,
  mat4GetScale,
  mat4TransformPoint,
  vec3Create,
} from "@lanpad/engine-core";
import type { Mat4, Vec3 } from "@lanpad/engine-core";

export function matrixIsFinite(matrix: Mat4): boolean {
  for (let index = 0; index < 16; index += 1) {
    if (!Number.isFinite(matrix.m[index])) {
      return false;
    }
  }
  return true;
}

/**
 * Absolute slack for the plane test. Plane extraction and the distance dot
 * product are float32, so a sphere that is mathematically tangent can land a
 * few ULPs outside; ER-04-10 keeps tangent spheres visible.
 */
const CULL_EPSILON = 1e-4;

export class FrustumCuller {
  private readonly frustum = frustumCreate();
  private readonly viewProjection: Mat4 = { m: new Float32Array(16) };
  private readonly scale = vec3Create();
  private readonly center = vec3Create();
  private valid = false;

  get isValid(): boolean {
    return this.valid;
  }

  /** Extracts planes from a column-major WebGPU view-projection matrix. */
  update(viewProjection: Mat4): boolean {
    if (!matrixIsFinite(viewProjection)) {
      this.valid = false;
      return false;
    }
    this.viewProjection.m.set(viewProjection.m);
    frustumFromViewProjection(this.frustum, this.viewProjection, "webgpu");
    this.valid = true;
    return true;
  }

  sphereVisible(cx: number, cy: number, cz: number, radius: number): boolean {
    if (!this.valid) {
      return true;
    }
    this.center.x = cx;
    this.center.y = cy;
    this.center.z = cz;
    return frustumIntersectsSphere(
      this.frustum,
      this.center,
      radius + CULL_EPSILON,
    );
  }

  /** Model-space sphere transformed by an affine model matrix. */
  transformedSphereVisible(
    model: Mat4,
    localX: number,
    localY: number,
    localZ: number,
    radius: number,
  ): boolean {
    if (!this.valid) {
      return true;
    }
    this.center.x = localX;
    this.center.y = localY;
    this.center.z = localZ;
    mat4TransformPoint(this.center, model, this.center);
    mat4GetScale(this.scale, model);
    const maxScale = Math.max(
      Math.abs(this.scale.x),
      Math.abs(this.scale.y),
      Math.abs(this.scale.z),
    );
    return this.sphereVisible(
      this.center.x,
      this.center.y,
      this.center.z,
      radius * maxScale,
    );
  }
}

/**
 * Conservative union sphere for a group of instance transforms. Allocates
 * nothing; writes the center into `outCenter` and returns the radius.
 */
export function unionSphereForInstances(
  outCenter: Vec3,
  transforms: Float32Array,
  count: number,
  localX: number,
  localY: number,
  localZ: number,
  localRadius: number,
): number {
  if (count <= 0) {
    outCenter.x = 0;
    outCenter.y = 0;
    outCenter.z = 0;
    return 0;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < count; index += 1) {
    const base = index * 16;
    const x =
      (transforms[base] ?? 0) * localX +
      (transforms[base + 4] ?? 0) * localY +
      (transforms[base + 8] ?? 0) * localZ +
      (transforms[base + 12] ?? 0);
    const y =
      (transforms[base + 1] ?? 0) * localX +
      (transforms[base + 5] ?? 0) * localY +
      (transforms[base + 9] ?? 0) * localZ +
      (transforms[base + 13] ?? 0);
    const z =
      (transforms[base + 2] ?? 0) * localX +
      (transforms[base + 6] ?? 0) * localY +
      (transforms[base + 10] ?? 0) * localZ +
      (transforms[base + 14] ?? 0);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  outCenter.x = (minX + maxX) * 0.5;
  outCenter.y = (minY + maxY) * 0.5;
  outCenter.z = (minZ + maxZ) * 0.5;

  let radius = 0;
  for (let index = 0; index < count; index += 1) {
    const base = index * 16;
    const x =
      (transforms[base] ?? 0) * localX +
      (transforms[base + 4] ?? 0) * localY +
      (transforms[base + 8] ?? 0) * localZ +
      (transforms[base + 12] ?? 0);
    const y =
      (transforms[base + 1] ?? 0) * localX +
      (transforms[base + 5] ?? 0) * localY +
      (transforms[base + 9] ?? 0) * localZ +
      (transforms[base + 13] ?? 0);
    const z =
      (transforms[base + 2] ?? 0) * localX +
      (transforms[base + 6] ?? 0) * localY +
      (transforms[base + 10] ?? 0) * localZ +
      (transforms[base + 14] ?? 0);
    const dx = x - outCenter.x;
    const dy = y - outCenter.y;
    const dz = z - outCenter.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    const c0x = transforms[base] ?? 0;
    const c0y = transforms[base + 1] ?? 0;
    const c0z = transforms[base + 2] ?? 0;
    const c1x = transforms[base + 4] ?? 0;
    const c1y = transforms[base + 5] ?? 0;
    const c1z = transforms[base + 6] ?? 0;
    const c2x = transforms[base + 8] ?? 0;
    const c2y = transforms[base + 9] ?? 0;
    const c2z = transforms[base + 10] ?? 0;
    const maxScale = Math.max(
      Math.sqrt(c0x * c0x + c0y * c0y + c0z * c0z),
      Math.sqrt(c1x * c1x + c1y * c1y + c1z * c1z),
      Math.sqrt(c2x * c2x + c2y * c2y + c2z * c2z),
    );
    const candidate = distance + localRadius * maxScale;
    if (candidate > radius) {
      radius = candidate;
    }
  }
  return radius;
}

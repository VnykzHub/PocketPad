/**
 * Internal slot tables and pure helpers for the Rapier adapter.
 *
 * Nothing in this module is re-exported from the package entry. Handles map
 * to dense slots; a slot is reused only after its generation is bumped, so a
 * stale handle can never resolve to a new object.
 */
import type { Quat, Vec3 } from "@lanpad/engine-core";
import type {
  BodyHandle,
  BodyType,
  ColliderHandle,
  JointHandle,
  ShapeDesc,
} from "../contracts/physics3d.js";
import type * as RAPIER from "@dimforge/rapier3d-compat";

export type ShapeKind = 0 | 1 | 2 | 3;

export const SHAPE_SPHERE: ShapeKind = 0;
export const SHAPE_BOX: ShapeKind = 1;
export const SHAPE_CAPSULE: ShapeKind = 2;
export const SHAPE_TRIMESH: ShapeKind = 3;

export const INVALID_INDEX = -1;

export interface ShapeData {
  readonly kindCode: ShapeKind;
  readonly kind: ShapeDesc["kind"];
  readonly radius: number;
  readonly halfHeight: number;
  readonly halfExtents: Vec3;
  /** Copied trimesh buffers; empty for primitive shapes. */
  readonly vertices: Float32Array | null;
  readonly indices: Uint32Array | null;
  readonly triangleCount: number;
}

export interface BodySlot {
  active: boolean;
  generation: number;
  /** Dense table index; the `index` half of every handle. */
  index: number;
  type: BodyType;
  body: RAPIER.RigidBody | null;
  /** Stable handle for event structs; replaced only when the slot is reused. */
  handle: BodyHandle;
  /** Mirror of the engine sleep overlay; see `step`. */
  sleeping: boolean;
  enabled: boolean;
  userData: number;
  ccd: boolean;
  canSleep: boolean;
  sleepTimer: number;
  /** Gravity scale to restore when a sleeping body wakes (see `step`). */
  sleepGravityScale: number;
  colliderCount: number;
  /** Dense collider slot indices attached to this body. */
  colliderSlots: number[];
  /** Explicit mass in kg; 0 means "derive from collider density". */
  explicitMass: number;
  /** Sum of non-sensor collider volumes, used to scale explicit mass. */
  volume: number;
  vehicleSlot: number;
  characterSlot: number;
  /** Scratch pose buffers, never handed to callers. */
  curPosition: Vec3;
  curRotation: Quat;
  prevPosition: Vec3;
  prevRotation: Quat;
}

export interface ColliderSlot {
  active: boolean;
  generation: number;
  /** Dense table index; the `index` half of every handle. */
  index: number;
  collider: RAPIER.Collider | null;
  bodyIndex: number;
  bodyGeneration: number;
  handle: ColliderHandle;
  shape: ShapeData;
  localPosition: Vec3;
  localRotation: Quat;
  friction: number;
  restitution: number;
  sensor: boolean;
  layer: number;
  mask: number;
  density: number;
  /** Volume of a non-sensor primitive; 0 for sensors and trimeshes. */
  volume: number;
}

export interface JointSlot {
  active: boolean;
  generation: number;
  /** Dense table index; the `index` half of every handle. */
  index: number;
  joint: RAPIER.ImpulseJoint | null;
  handle: JointHandle;
  bodyA: number;
  bodyB: number;
  kind: "fixed" | "ball" | "hinge" | "slider" | "distance";
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
  return { x, y, z, w };
}

export function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

export function isFiniteVec3(value: Vec3): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

export function isFiniteQuat(value: Quat): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z) &&
    Number.isFinite(value.w)
  );
}

/** Normalizes in place; false when the quaternion is zero-length. */
export function normalizeQuatInPlace(value: Quat): boolean {
  const lengthSq =
    value.x * value.x +
    value.y * value.y +
    value.z * value.z +
    value.w * value.w;
  if (!Number.isFinite(lengthSq) || lengthSq < 1e-12) return false;
  const inverse = 1 / Math.sqrt(lengthSq);
  value.x *= inverse;
  value.y *= inverse;
  value.z *= inverse;
  value.w *= inverse;
  return true;
}

export function copyVec3(out: Vec3, value: Vec3): void {
  out.x = value.x;
  out.y = value.y;
  out.z = value.z;
}

export function copyQuat(out: Quat, value: Quat): void {
  out.x = value.x;
  out.y = value.y;
  out.z = value.z;
  out.w = value.w;
}

/** out = a * b (apply b, then a). */
export function quatMultiply(out: Quat, a: Quat, b: Quat): void {
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const aw = a.w;
  const bx = b.x;
  const by = b.y;
  const bz = b.z;
  const bw = b.w;
  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
}

/** Rotates `v` by unit quaternion `q`. */
export function quatRotate(out: Vec3, q: Quat, v: Vec3): void {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  const vx = v.x;
  const vy = v.y;
  const vz = v.z;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  out.x = vx + w * tx + (y * tz - z * ty);
  out.y = vy + w * ty + (z * tx - x * tz);
  out.z = vz + w * tz + (x * ty - y * tx);
}

export function transformPoint(
  out: Vec3,
  position: Vec3,
  rotation: Quat,
  local: Vec3,
): void {
  quatRotate(out, rotation, local);
  out.x += position.x;
  out.y += position.y;
  out.z += position.z;
}

/** True when two unit axes point the same way (dot > 1 - 1e-6). */
export function sameAxis(a: Vec3, b: Vec3): boolean {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return dot > 1 - 1e-6;
}

export function shapeVolume(shape: ShapeData, sensor: boolean): number {
  if (sensor) return 0;
  const pi = Math.PI;
  switch (shape.kindCode) {
    case SHAPE_SPHERE:
      return (4 / 3) * pi * shape.radius * shape.radius * shape.radius;
    case SHAPE_BOX:
      return (
        8 *
        shape.halfExtents.x *
        shape.halfExtents.y *
        shape.halfExtents.z
      );
    case SHAPE_CAPSULE:
      return (
        pi * shape.radius * shape.radius * 2 * shape.halfHeight +
        (4 / 3) * pi * shape.radius * shape.radius * shape.radius
      );
    default:
      return 0;
  }
}

/**
 * World-space AABB for the four supported shapes, computed from slot data so
 * `readCollider` never asks Rapier to allocate.
 */
export function computeWorldAabb(
  outMin: Vec3,
  outMax: Vec3,
  shape: ShapeData,
  localPosition: Vec3,
  localRotation: Quat,
  bodyPosition: Vec3,
  bodyRotation: Quat,
): void {
  const worldRotation = quat();
  quatMultiply(worldRotation, bodyRotation, localRotation);
  const center = vec3();
  transformPoint(center, bodyPosition, bodyRotation, localPosition);

  switch (shape.kindCode) {
    case SHAPE_SPHERE: {
      const r = shape.radius;
      outMin.x = center.x - r;
      outMin.y = center.y - r;
      outMin.z = center.z - r;
      outMax.x = center.x + r;
      outMax.y = center.y + r;
      outMax.z = center.z + r;
      return;
    }
    case SHAPE_BOX: {
      const h = shape.halfExtents;
      const ex = rotatedHalfExtent(worldRotation, h, 0);
      const ey = rotatedHalfExtent(worldRotation, h, 1);
      const ez = rotatedHalfExtent(worldRotation, h, 2);
      outMin.x = center.x - ex;
      outMin.y = center.y - ey;
      outMin.z = center.z - ez;
      outMax.x = center.x + ex;
      outMax.y = center.y + ey;
      outMax.z = center.z + ez;
      return;
    }
    case SHAPE_CAPSULE: {
      const axis = vec3(0, shape.halfHeight, 0);
      const rotated = vec3();
      quatRotate(rotated, worldRotation, axis);
      const r = shape.radius;
      outMin.x = center.x - Math.abs(rotated.x) - r;
      outMin.y = center.y - Math.abs(rotated.y) - r;
      outMin.z = center.z - Math.abs(rotated.z) - r;
      outMax.x = center.x + Math.abs(rotated.x) + r;
      outMax.y = center.y + Math.abs(rotated.y) + r;
      outMax.z = center.z + Math.abs(rotated.z) + r;
      return;
    }
    default: {
      const vertices = shape.vertices;
      if (vertices === null || vertices.length < 3) {
        outMin.x = center.x;
        outMin.y = center.y;
        outMin.z = center.z;
        outMax.x = center.x;
        outMax.y = center.y;
        outMax.z = center.z;
        return;
      }
      const point = vec3();
      const local = vec3();
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i + 2 < vertices.length; i += 3) {
        local.x = vertices[i]!;
        local.y = vertices[i + 1]!;
        local.z = vertices[i + 2]!;
        transformPoint(point, bodyPosition, bodyRotation, local);
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.z < minZ) minZ = point.z;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
        if (point.z > maxZ) maxZ = point.z;
      }
      outMin.x = minX;
      outMin.y = minY;
      outMin.z = minZ;
      outMax.x = maxX;
      outMax.y = maxY;
      outMax.z = maxZ;
    }
  }
}

function rotatedHalfExtent(
  q: Quat,
  half: Vec3,
  row: 0 | 1 | 2,
): number {
  const x2 = q.x + q.x;
  const y2 = q.y + q.y;
  const z2 = q.z + q.z;
  const xx = q.x * x2;
  const xy = q.x * y2;
  const xz = q.x * z2;
  const yy = q.y * y2;
  const yz = q.y * z2;
  const zz = q.z * z2;
  const wx = q.w * x2;
  const wy = q.w * y2;
  const wz = q.w * z2;
  let m0: number;
  let m1: number;
  let m2: number;
  if (row === 0) {
    m0 = 1 - (yy + zz);
    m1 = xy - wz;
    m2 = xz + wy;
  } else if (row === 1) {
    m0 = xy + wz;
    m1 = 1 - (xx + zz);
    m2 = yz - wx;
  } else {
    m0 = xz - wy;
    m1 = yz + wx;
    m2 = 1 - (xx + yy);
  }
  return (
    Math.abs(m0) * half.x +
    Math.abs(m1) * half.y +
    Math.abs(m2) * half.z
  );
}

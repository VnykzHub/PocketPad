/**
 * Obb (02 §3.8): oriented box, unit-quaternion rotation, half extents.
 *
 * Intersection is the 15-axis separating-axis test (Ericson). Touching counts:
 * a box pair is separated only when the projection gap is positive beyond a
 * relative numerical slop, so swapping the arguments cannot flip a tie.
 *
 * The SAT core works on two module-scratch basis arrays instead of allocating
 * per call; the module is reentrancy-free (no callbacks, no recursion), so the
 * scratch is safe. Public functions never expose it.
 */

import { quatCreate } from "./Quat.js";
import type { Aabb3 } from "./Aabb.js";
import type { Quat } from "./Quat.js";
import type { Vec3 } from "./Vec3.js";

export interface Obb {
  center: Vec3;
  halfExtents: Vec3;
  rotation: Quat;
}

/** Column-major basis columns, 9 numbers: col0 at 0, col1 at 3, col2 at 6. */
const BASIS_A = new Float64Array(9);
const BASIS_B = new Float64Array(9);
const BASIS_IDENTITY = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/**
 * Relative slop for every SAT comparison. Swapping the boxes reorders the
 * additions in each radial term; without shared slop a touching pair can round
 * to a tiny positive gap in one order and a tiny negative one in the other.
 */
const SAT_SLOP = 1e-12;

function separatedBy(gap: number, bound: number): boolean {
  return gap > bound + SAT_SLOP * (1 + Math.abs(bound));
}

/** Normalized rotation columns of `q`; a zero quaternion yields the identity. */
function writeBasis(out: Float64Array, q: Quat): void {
  let x = q.x;
  let y = q.y;
  let z = q.z;
  let w = q.w;
  let length = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(length > 0) || !Number.isFinite(length)) {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
    length = 1;
  }
  x /= length;
  y /= length;
  z /= length;
  w /= length;
  out[0] = 1 - 2 * (y * y + z * z);
  out[1] = 2 * (x * y + w * z);
  out[2] = 2 * (x * z - w * y);
  out[3] = 2 * (x * y - w * z);
  out[4] = 1 - 2 * (x * x + z * z);
  out[5] = 2 * (y * z + w * x);
  out[6] = 2 * (x * z + w * y);
  out[7] = 2 * (y * z - w * x);
  out[8] = 1 - 2 * (x * x + y * y);
}

/**
 * True when the boxes are separated on at least one of the 15 axes.
 * `t` is the center delta B − A, given both in A-local and world coordinates.
 */
function separated15(
  tax: number,
  tay: number,
  taz: number,
  twx: number,
  twy: number,
  twz: number,
  eax: number,
  eay: number,
  eaz: number,
  ebx: number,
  eby: number,
  ebz: number,
  a: Float64Array,
  b: Float64Array,
): boolean {
  const r00 = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const r01 = a[0]! * b[3]! + a[1]! * b[4]! + a[2]! * b[5]!;
  const r02 = a[0]! * b[6]! + a[1]! * b[7]! + a[2]! * b[8]!;
  const r10 = a[3]! * b[0]! + a[4]! * b[1]! + a[5]! * b[2]!;
  const r11 = a[3]! * b[3]! + a[4]! * b[4]! + a[5]! * b[5]!;
  const r12 = a[3]! * b[6]! + a[4]! * b[7]! + a[5]! * b[8]!;
  const r20 = a[6]! * b[0]! + a[7]! * b[1]! + a[8]! * b[2]!;
  const r21 = a[6]! * b[3]! + a[7]! * b[4]! + a[8]! * b[5]!;
  const r22 = a[6]! * b[6]! + a[7]! * b[7]! + a[8]! * b[8]!;
  const ar00 = Math.abs(r00);
  const ar01 = Math.abs(r01);
  const ar02 = Math.abs(r02);
  const ar10 = Math.abs(r10);
  const ar11 = Math.abs(r11);
  const ar12 = Math.abs(r12);
  const ar20 = Math.abs(r20);
  const ar21 = Math.abs(r21);
  const ar22 = Math.abs(r22);

  // A's axes.
  if (
    separatedBy(Math.abs(tax), eax + ebx * ar00 + eby * ar01 + ebz * ar02)
  ) {
    return true;
  }
  if (
    separatedBy(Math.abs(tay), eay + ebx * ar10 + eby * ar11 + ebz * ar12)
  ) {
    return true;
  }
  if (
    separatedBy(Math.abs(taz), eaz + ebx * ar20 + eby * ar21 + ebz * ar22)
  ) {
    return true;
  }

  // B's axes.
  if (
    separatedBy(
      Math.abs(twx * b[0]! + twy * b[1]! + twz * b[2]!),
      ebx + eax * ar00 + eay * ar10 + eaz * ar20,
    )
  ) {
    return true;
  }
  if (
    separatedBy(
      Math.abs(twx * b[3]! + twy * b[4]! + twz * b[5]!),
      eby + eax * ar01 + eay * ar11 + eaz * ar21,
    )
  ) {
    return true;
  }
  if (
    separatedBy(
      Math.abs(twx * b[6]! + twy * b[7]! + twz * b[8]!),
      ebz + eax * ar02 + eay * ar12 + eaz * ar22,
    )
  ) {
    return true;
  }

  // Cross axes A0 x B0, A0 x B1, A0 x B2.
  if (
    separatedBy(
      Math.abs(taz * r10 - tay * r20),
      eay * ar20 + eaz * ar10 + eby * ar02 + ebz * ar01,
    )
  ) {
    return true;
  }
  if (
    separatedBy(
      Math.abs(taz * r11 - tay * r21),
      eay * ar21 + eaz * ar11 + ebx * ar02 + ebz * ar00,
    )
  ) {
    return true;
  }
  if (
    separatedBy(
      Math.abs(taz * r12 - tay * r22),
      eay * ar22 + eaz * ar12 + ebx * ar01 + eby * ar00,
    )
  ) {
    return true;
  }
  // A1 x B0, A1 x B1, A1 x B2.
  if (
    separatedBy(
      Math.abs(tax * r20 - taz * r00),
      eax * ar20 + eaz * ar00 + eby * ar12 + ebz * ar11,
    )
  ) {
    return true;
  }
  if (
    separatedBy(
      Math.abs(tax * r21 - taz * r01),
      eax * ar21 + eaz * ar01 + ebx * ar12 + ebz * ar10,
    )
  ) {
    return true;
  }
  if (
    separatedBy(
      Math.abs(tax * r22 - taz * r02),
      eax * ar22 + eaz * ar02 + ebx * ar11 + eby * ar10,
    )
  ) {
    return true;
  }
  // A2 x B0, A2 x B1, A2 x B2.
  if (
    separatedBy(
      Math.abs(tay * r00 - tax * r10),
      eax * ar10 + eay * ar00 + eby * ar22 + ebz * ar21,
    )
  ) {
    return true;
  }
  if (
    separatedBy(
      Math.abs(tay * r01 - tax * r11),
      eax * ar11 + eay * ar01 + ebx * ar22 + ebz * ar20,
    )
  ) {
    return true;
  }
  if (
    separatedBy(
      Math.abs(tay * r02 - tax * r12),
      eax * ar12 + eay * ar02 + ebx * ar21 + eby * ar20,
    )
  ) {
    return true;
  }
  return false;
}

/** Allocates; cold path only. Zero center/extents, identity rotation. */
export function obbCreate(): Obb {
  return {
    center: { x: 0, y: 0, z: 0 },
    halfExtents: { x: 0, y: 0, z: 0 },
    rotation: quatCreate(),
  };
}

export function obbSet(
  out: Obb,
  center: Vec3,
  halfExtents: Vec3,
  rotation: Quat,
): Obb {
  const cx = center.x;
  const cy = center.y;
  const cz = center.z;
  const hx = halfExtents.x;
  const hy = halfExtents.y;
  const hz = halfExtents.z;
  const qx = rotation.x;
  const qy = rotation.y;
  const qz = rotation.z;
  const qw = rotation.w;
  out.center.x = cx;
  out.center.y = cy;
  out.center.z = cz;
  out.halfExtents.x = hx;
  out.halfExtents.y = hy;
  out.halfExtents.z = hz;
  out.rotation.x = qx;
  out.rotation.y = qy;
  out.rotation.z = qz;
  out.rotation.w = qw;
  return out;
}

export function obbCopy(out: Obb, a: Obb): Obb {
  return obbSet(out, a.center, a.halfExtents, a.rotation);
}

/** Writes one local axis (0=x, 1=y, 2=z) rotated to world space. */
export function obbGetAxis(out: Vec3, a: Obb, axis: 0 | 1 | 2): Vec3 {
  writeBasis(BASIS_A, a.rotation);
  const i = axis * 3;
  out.x = BASIS_A[i]!;
  out.y = BASIS_A[i + 1]!;
  out.z = BASIS_A[i + 2]!;
  return out;
}

/** Inclusive. */
export function obbContainsPoint(a: Obb, point: Vec3): boolean {
  const dx = point.x - a.center.x;
  const dy = point.y - a.center.y;
  const dz = point.z - a.center.z;
  writeBasis(BASIS_A, a.rotation);
  const lx = dx * BASIS_A[0]! + dy * BASIS_A[1]! + dz * BASIS_A[2]!;
  const ly = dx * BASIS_A[3]! + dy * BASIS_A[4]! + dz * BASIS_A[5]!;
  const lz = dx * BASIS_A[6]! + dy * BASIS_A[7]! + dz * BASIS_A[8]!;
  return (
    Math.abs(lx) <= a.halfExtents.x &&
    Math.abs(ly) <= a.halfExtents.y &&
    Math.abs(lz) <= a.halfExtents.z
  );
}

/** SAT; touching counts. The AABB is treated as an identity-orientation box. */
export function obbIntersectsAabb(a: Obb, b: Aabb3): boolean {
  writeBasis(BASIS_A, a.rotation);
  const twx = (b.min.x + b.max.x) * 0.5 - a.center.x;
  const twy = (b.min.y + b.max.y) * 0.5 - a.center.y;
  const twz = (b.min.z + b.max.z) * 0.5 - a.center.z;
  const tax = twx * BASIS_A[0]! + twy * BASIS_A[1]! + twz * BASIS_A[2]!;
  const tay = twx * BASIS_A[3]! + twy * BASIS_A[4]! + twz * BASIS_A[5]!;
  const taz = twx * BASIS_A[6]! + twy * BASIS_A[7]! + twz * BASIS_A[8]!;
  const ebx = (b.max.x - b.min.x) * 0.5;
  const eby = (b.max.y - b.min.y) * 0.5;
  const ebz = (b.max.z - b.min.z) * 0.5;
  return !separated15(
    tax,
    tay,
    taz,
    twx,
    twy,
    twz,
    a.halfExtents.x,
    a.halfExtents.y,
    a.halfExtents.z,
    ebx,
    eby,
    ebz,
    BASIS_A,
    BASIS_IDENTITY,
  );
}

/** SAT; touching counts. */
export function obbIntersectsObb(a: Obb, b: Obb): boolean {
  writeBasis(BASIS_A, a.rotation);
  const twx = b.center.x - a.center.x;
  const twy = b.center.y - a.center.y;
  const twz = b.center.z - a.center.z;
  const tax = twx * BASIS_A[0]! + twy * BASIS_A[1]! + twz * BASIS_A[2]!;
  const tay = twx * BASIS_A[3]! + twy * BASIS_A[4]! + twz * BASIS_A[5]!;
  const taz = twx * BASIS_A[6]! + twy * BASIS_A[7]! + twz * BASIS_A[8]!;
  writeBasis(BASIS_B, b.rotation);
  return !separated15(
    tax,
    tay,
    taz,
    twx,
    twy,
    twz,
    a.halfExtents.x,
    a.halfExtents.y,
    a.halfExtents.z,
    b.halfExtents.x,
    b.halfExtents.y,
    b.halfExtents.z,
    BASIS_A,
    BASIS_B,
  );
}

/** Nearest point of the box in world space; returns the input when inside. */
export function obbClosestPoint(out: Vec3, a: Obb, point: Vec3): Vec3 {
  const dx = point.x - a.center.x;
  const dy = point.y - a.center.y;
  const dz = point.z - a.center.z;
  writeBasis(BASIS_A, a.rotation);
  let lx = dx * BASIS_A[0]! + dy * BASIS_A[1]! + dz * BASIS_A[2]!;
  let ly = dx * BASIS_A[3]! + dy * BASIS_A[4]! + dz * BASIS_A[5]!;
  let lz = dx * BASIS_A[6]! + dy * BASIS_A[7]! + dz * BASIS_A[8]!;
  const hx = a.halfExtents.x;
  const hy = a.halfExtents.y;
  const hz = a.halfExtents.z;
  lx = lx < -hx ? -hx : lx > hx ? hx : lx;
  ly = ly < -hy ? -hy : ly > hy ? hy : ly;
  lz = lz < -hz ? -hz : lz > hz ? hz : lz;
  out.x = a.center.x + BASIS_A[0]! * lx + BASIS_A[3]! * ly + BASIS_A[6]! * lz;
  out.y = a.center.y + BASIS_A[1]! * lx + BASIS_A[4]! * ly + BASIS_A[7]! * lz;
  out.z = a.center.z + BASIS_A[2]! * lx + BASIS_A[5]! * ly + BASIS_A[8]! * lz;
  return out;
}

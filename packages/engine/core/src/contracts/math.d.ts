/**
 * Math contract (spec 02). Types and function signatures only.
 *
 * Conventions (02 §3.1), all normative:
 * - Right-handed; +X right, +Y up, +Z toward the viewer; a camera looks down −Z.
 * - Units: metres and seconds. Angles in radians.
 * - `Mat3`/`Mat4` are column-major float32; element (row r, column c) is `m[c*4+r]`.
 * - Column vectors. `mat4Multiply(out,a,b)` means `out = a * b`.
 * - Quaternion `(x,y,z,w)`; `quatMultiply(out,a,b)` means `out = a * b`;
 *   rotating by `a` then `b` is `b * a`.
 * - WebGL2 clip z ∈ [−1,1]; WebGPU clip z ∈ [0,1]. Two explicit families.
 * - `Ray.direction` is unit length by convention.
 * - `Plane` is `normal·x + constant = 0`; inside is positive.
 */

/** Scalar helpers and constants (02 §3.2). */
export const PI: number;
export const TWO_PI: number;
export const HALF_PI: number;
export const DEG2RAD: number;
export const RAD2DEG: number;
/** 1e-6, float32-derived comparisons. */
export const EPSILON: number;
/** 1e-9, pure-double scalar comparisons. */
export const EPSILON_SCALAR: number;
/** 1e-12, pure-double intermediate comparisons. */
export const EPSILON_DOUBLE: number;

export function clamp(value: number, min: number, max: number): number;
export function clamp01(value: number): number;
export function lerp(a: number, b: number, t: number): number;
export function inverseLerp(a: number, b: number, value: number): number;
export function degToRad(degrees: number): number;
export function radToDeg(radians: number): number;
/** Wraps to (-PI, PI]. */
export function wrapAngle(radians: number): number;
/** Moves `current` toward `target` by at most `maxDelta`, across the wrap. */
export function moveTowardAngle(
  current: number,
  target: number,
  maxDelta: number,
): number;
/** Default epsilon is `EPSILON_SCALAR`. */
export function approximatelyEqual(
  a: number,
  b: number,
  epsilon?: number,
): boolean;

/** 02 §3.3. Legacy 2D convention: +Y down, clockwise positive. */
export interface Vec2 {
  x: number;
  y: number;
}

export function vec2Create(x?: number, y?: number): Vec2;
export function vec2Set(out: Vec2, x: number, y: number): Vec2;
export function vec2Copy(out: Vec2, a: Vec2): Vec2;
export function vec2Add(out: Vec2, a: Vec2, b: Vec2): Vec2;
export function vec2Sub(out: Vec2, a: Vec2, b: Vec2): Vec2;
export function vec2Scale(out: Vec2, a: Vec2, scalar: number): Vec2;
export function vec2AddScaled(
  out: Vec2,
  a: Vec2,
  b: Vec2,
  scalar: number,
): Vec2;
export function vec2Negate(out: Vec2, a: Vec2): Vec2;
export function vec2Dot(a: Vec2, b: Vec2): number;
/** Scalar z component. */
export function vec2Cross(a: Vec2, b: Vec2): number;
export function vec2LengthSq(a: Vec2): number;
export function vec2Length(a: Vec2): number;
export function vec2DistanceSq(a: Vec2, b: Vec2): number;
export function vec2Distance(a: Vec2, b: Vec2): number;
/** Writes the unit vector and returns the original length. */
export function vec2Normalize(out: Vec2, a: Vec2): number;
export function vec2Lerp(out: Vec2, a: Vec2, b: Vec2, t: number): Vec2;
export function vec2Min(out: Vec2, a: Vec2, b: Vec2): Vec2;
export function vec2Max(out: Vec2, a: Vec2, b: Vec2): Vec2;
export function vec2ClampLength(
  out: Vec2,
  a: Vec2,
  maxLength: number,
): Vec2;
/** Positive radians rotate clockwise on screen (y-down). */
export function vec2Rotate(out: Vec2, a: Vec2, radians: number): Vec2;
/** Angle in (-PI, PI], measured from +X toward +Y. */
export function vec2Angle(a: Vec2): number;
export function vec2FromAngle(
  out: Vec2,
  radians: number,
  length?: number,
): Vec2;
/** Clockwise +90° perpendicular: (-y, x). */
export function vec2Perp(out: Vec2, a: Vec2): Vec2;
export function vec2Equals(a: Vec2, b: Vec2, epsilon?: number): boolean;

/** 02 §3.4. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec4 {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function vec3Create(x?: number, y?: number, z?: number): Vec3;
export function vec3Set(out: Vec3, x: number, y: number, z: number): Vec3;
export function vec3Copy(out: Vec3, a: Vec3): Vec3;
export function vec3Add(out: Vec3, a: Vec3, b: Vec3): Vec3;
export function vec3Sub(out: Vec3, a: Vec3, b: Vec3): Vec3;
export function vec3Scale(out: Vec3, a: Vec3, scalar: number): Vec3;
export function vec3AddScaled(
  out: Vec3,
  a: Vec3,
  b: Vec3,
  scalar: number,
): Vec3;
export function vec3Negate(out: Vec3, a: Vec3): Vec3;
export function vec3Dot(a: Vec3, b: Vec3): number;
export function vec3Cross(out: Vec3, a: Vec3, b: Vec3): Vec3;
export function vec3LengthSq(a: Vec3): number;
export function vec3Length(a: Vec3): number;
export function vec3DistanceSq(a: Vec3, b: Vec3): number;
export function vec3Distance(a: Vec3, b: Vec3): number;
/** Writes the unit vector and returns the original length; zero writes (0,0,0). */
export function vec3Normalize(out: Vec3, a: Vec3): number;
export function vec3Lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3;
export function vec3Min(out: Vec3, a: Vec3, b: Vec3): Vec3;
export function vec3Max(out: Vec3, a: Vec3, b: Vec3): Vec3;
export function vec3Abs(out: Vec3, a: Vec3): Vec3;
export function vec3ClampLength(
  out: Vec3,
  a: Vec3,
  maxLength: number,
): Vec3;
export function vec3Equals(a: Vec3, b: Vec3, epsilon?: number): boolean;

export function vec4Create(
  x?: number,
  y?: number,
  z?: number,
  w?: number,
): Vec4;
export function vec4Set(
  out: Vec4,
  x: number,
  y: number,
  z: number,
  w: number,
): Vec4;
export function vec4Copy(out: Vec4, a: Vec4): Vec4;
export function vec4FromVec3(out: Vec4, a: Vec3, w: number): Vec4;
/** Drops w, no divide. */
export function vec4ToVec3(out: Vec3, a: Vec4): Vec3;
export function vec4Add(out: Vec4, a: Vec4, b: Vec4): Vec4;
export function vec4Sub(out: Vec4, a: Vec4, b: Vec4): Vec4;
export function vec4Scale(out: Vec4, a: Vec4, scalar: number): Vec4;
export function vec4Dot(a: Vec4, b: Vec4): number;
export function vec4LengthSq(a: Vec4): number;
export function vec4Length(a: Vec4): number;
export function vec4Normalize(out: Vec4, a: Vec4): number;
export function vec4Lerp(out: Vec4, a: Vec4, b: Vec4, t: number): Vec4;
export function vec4Equals(a: Vec4, b: Vec4, epsilon?: number): boolean;

/** 02 §3.5. 9 floats, column-major. */
export interface Mat3 {
  readonly m: Float32Array;
}

export function mat3Create(): Mat3;
export function mat3Identity(out: Mat3): Mat3;
export function mat3Copy(out: Mat3, a: Mat3): Mat3;
/** 9 values, column-major. */
export function mat3Set(out: Mat3, ...values: readonly number[]): Mat3;
/** Upper-left 3×3. */
export function mat3FromMat4(out: Mat3, a: Mat4): Mat3;
/** out = a * b. */
export function mat3Multiply(out: Mat3, a: Mat3, b: Mat3): Mat3;
export function mat3Transpose(out: Mat3, a: Mat3): Mat3;
/** Returns false and zeroes `out` for a singular matrix. */
export function mat3Invert(out: Mat3, a: Mat3): boolean;
export function mat3Determinant(a: Mat3): number;
/** Linear 2×2 application on x/y; the third column is ignored. */
export function mat3TransformVec2(out: Vec2, a: Mat3, v: Vec2): Vec2;
export function mat3Equals(a: Mat3, b: Mat3, epsilon?: number): boolean;

/** 02 §3.6. 16 floats, column-major. */
export interface Mat4 {
  readonly m: Float32Array;
}

export function mat4Create(): Mat4;
export function mat4Identity(out: Mat4): Mat4;
export function mat4Copy(out: Mat4, a: Mat4): Mat4;
/** 16 values, column-major. */
export function mat4Set(out: Mat4, ...values: readonly number[]): Mat4;
/** out = a * b. */
export function mat4Multiply(out: Mat4, a: Mat4, b: Mat4): Mat4;
export function mat4Transpose(out: Mat4, a: Mat4): Mat4;
/** Returns false and zeroes `out` for a singular matrix. */
export function mat4Invert(out: Mat4, a: Mat4): boolean;
export function mat4Determinant(a: Mat4): number;

export function mat4FromTranslation(out: Mat4, translation: Vec3): Mat4;
export function mat4FromScale(out: Mat4, scale: Vec3): Mat4;
export function mat4FromQuat(out: Mat4, rotation: Quat): Mat4;
export function mat4FromAxisAngle(
  out: Mat4,
  axis: Vec3,
  radians: number,
): Mat4;
export function mat4FromRotationX(out: Mat4, radians: number): Mat4;
export function mat4FromRotationY(out: Mat4, radians: number): Mat4;
export function mat4FromRotationZ(out: Mat4, radians: number): Mat4;

/** out = T(position) * R(rotation) * S(scale). */
export function mat4Compose(
  out: Mat4,
  position: Vec3,
  rotation: Quat,
  scale: Vec3,
): Mat4;
/** Returns false for a singular or sheared matrix. */
export function mat4Decompose(
  outPosition: Vec3,
  outRotation: Quat,
  outScale: Vec3,
  a: Mat4,
): boolean;

export function mat4GetTranslation(out: Vec3, a: Mat4): Vec3;
export function mat4GetScale(out: Vec3, a: Mat4): Vec3;
/** Assumes no shear; returns false when decomposition fails. */
export function mat4GetRotation(out: Quat, a: Mat4): boolean;

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
): Mat4;
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
): Mat4;
/** m[0]=2/(r−l), m[5]=2/(t−b), m[10]=−2/(f−n), m[15]=1. */
export function mat4OrthographicWebGL2(
  out: Mat4,
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4;
/** m[0]=2/(r−l), m[5]=2/(t−b), m[10]=−1/(f−n), m[14]=−n/(f−n), m[15]=1. */
export function mat4OrthographicWebGPU(
  out: Mat4,
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4;

/** Right-handed view matrix; `up` is normalized internally. Forward is −Z. */
export function mat4LookAt(
  out: Mat4,
  eye: Vec3,
  target: Vec3,
  up: Vec3,
): Mat4;

/** Applies the full matrix and divides by w when w is finite and non-zero. */
export function mat4TransformVec4(out: Vec4, a: Mat4, v: Vec4): Vec4;
/** Applies with w = 1, then divides by w. */
export function mat4TransformPoint(out: Vec3, a: Mat4, point: Vec3): Vec3;
/** Upper-left 3×3 only; no translation, no divide. */
export function mat4TransformDirection(
  out: Vec3,
  a: Mat4,
  direction: Vec3,
): Vec3;
export function mat4Equals(a: Mat4, b: Mat4, epsilon?: number): boolean;

/** 02 §3.7. Unit quaternion `(x,y,z,w)`. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Default identity. */
export function quatCreate(
  x?: number,
  y?: number,
  z?: number,
  w?: number,
): Quat;
/** (0,0,0,1). */
export function quatIdentity(out: Quat): Quat;
export function quatSet(
  out: Quat,
  x: number,
  y: number,
  z: number,
  w: number,
): Quat;
export function quatCopy(out: Quat, a: Quat): Quat;
/** out = a * b. Rotating by a then b is b * a. */
export function quatMultiply(out: Quat, a: Quat, b: Quat): Quat;
export function quatConjugate(out: Quat, a: Quat): Quat;
/** Unit inverse; non-unit input returns conjugate / lengthSq. */
export function quatInvert(out: Quat, a: Quat): Quat;
/** Writes the unit quaternion and returns the original length. */
export function quatNormalize(out: Quat, a: Quat): number;
export function quatDot(a: Quat, b: Quat): number;
export function quatLengthSq(a: Quat): number;
export function quatLength(a: Quat): number;
export function quatFromAxisAngle(
  out: Quat,
  axis: Vec3,
  radians: number,
): Quat;
/** YXZ intrinsic; q = qY * qX * qZ. */
export function quatFromEulerYXZ(
  out: Quat,
  x: number,
  y: number,
  z: number,
): Quat;
export function quatToMat3(out: Mat3, a: Quat): Mat3;
export function quatToMat4(out: Mat4, a: Quat): Mat4;
/** Rotates a vector by a unit quaternion; `out` may alias `v`. */
export function quatRotateVec3(out: Vec3, q: Quat, v: Vec3): Vec3;
/** Shortest arc; endpoints exact, t clamped to [0,1]. */
export function quatSlerp(out: Quat, a: Quat, b: Quat, t: number): Quat;
export function quatNlerp(out: Quat, a: Quat, b: Quat, t: number): Quat;
/** Angle in [0, PI] between two unit quaternions. */
export function quatAngleBetween(a: Quat, b: Quat): number;
/** False for a mirrored or non-orthogonal basis. */
export function quatFromMat4(out: Quat, a: Mat4): boolean;
/** Shortest rotation from one unit vector to another. */
export function quatFromTo(out: Quat, from: Vec3, to: Vec3): Quat;
/** Component-wise; q and −q are NOT equal. */
export function quatEquals(a: Quat, b: Quat, epsilon?: number): boolean;

/** 02 §3.8. Legacy 2D box: min corner plus positive extents, y-down. */
export interface Aabb2 {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function aabb2Create(
  x?: number,
  y?: number,
  w?: number,
  h?: number,
): Aabb2;
export function aabb2Set(
  out: Aabb2,
  x: number,
  y: number,
  w: number,
  h: number,
): Aabb2;
export function aabb2Copy(out: Aabb2, a: Aabb2): Aabb2;
export function aabb2FromMinMax(
  out: Aabb2,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): Aabb2;
export function aabb2Center(out: Vec2, a: Aabb2): Vec2;
/** Inclusive edges. */
export function aabb2ContainsPoint(a: Aabb2, point: Vec2): boolean;
/** Touching counts. */
export function aabb2Intersects(a: Aabb2, b: Aabb2): boolean;
export function aabb2Union(out: Aabb2, a: Aabb2, b: Aabb2): Aabb2;
export function aabb2ClosestPoint(out: Vec2, a: Aabb2, point: Vec2): Vec2;

/** min <= max per axis. */
export interface Aabb3 {
  min: Vec3;
  max: Vec3;
}

export function aabb3Create(): Aabb3;
export function aabb3Set(out: Aabb3, min: Vec3, max: Vec3): Aabb3;
export function aabb3Copy(out: Aabb3, a: Aabb3): Aabb3;
export function aabb3FromCenterHalfExtents(
  out: Aabb3,
  center: Vec3,
  halfExtents: Vec3,
): Aabb3;
export function aabb3Center(out: Vec3, a: Aabb3): Vec3;
export function aabb3HalfExtents(out: Vec3, a: Aabb3): Vec3;
export function aabb3Size(out: Vec3, a: Aabb3): Vec3;
export function aabb3Union(out: Aabb3, a: Aabb3, b: Aabb3): Aabb3;
export function aabb3ExpandByPoint(out: Aabb3, a: Aabb3, point: Vec3): Aabb3;
/** Inclusive. */
export function aabb3ContainsPoint(a: Aabb3, point: Vec3): boolean;
/** Touching counts. */
export function aabb3IntersectsAabb(a: Aabb3, b: Aabb3): boolean;
export function aabb3IntersectsSphere(
  a: Aabb3,
  center: Vec3,
  radius: number,
): boolean;
export function aabb3ClosestPoint(out: Vec3, a: Aabb3, point: Vec3): Vec3;
export function aabb3Transform(out: Obb, a: Aabb3, matrix: Mat4): Obb;

export interface Obb {
  center: Vec3;
  halfExtents: Vec3;
  rotation: Quat;
}

export function obbCreate(): Obb;
export function obbSet(
  out: Obb,
  center: Vec3,
  halfExtents: Vec3,
  rotation: Quat,
): Obb;
export function obbCopy(out: Obb, a: Obb): Obb;
/** Writes one local axis (0=x, 1=y, 2=z) rotated to world space. */
export function obbGetAxis(out: Vec3, a: Obb, axis: 0 | 1 | 2): Vec3;
/** Inclusive. */
export function obbContainsPoint(a: Obb, point: Vec3): boolean;
/** SAT; touching counts. */
export function obbIntersectsAabb(a: Obb, b: Aabb3): boolean;
/** SAT; touching counts. */
export function obbIntersectsObb(a: Obb, b: Obb): boolean;
export function obbClosestPoint(out: Vec3, a: Obb, point: Vec3): Vec3;

/** Direction is unit length by convention. */
export interface Ray {
  origin: Vec3;
  direction: Vec3;
}

export function rayCreate(): Ray;
export function raySet(out: Ray, origin: Vec3, direction: Vec3): Ray;
export function rayCopy(out: Ray, a: Ray): Ray;
export function rayAt(out: Vec3, ray: Ray, t: number): Vec3;
/** Closest point on the ray; t clamped to >= 0. */
export function rayClosestPoint(out: Vec3, ray: Ray, point: Vec3): Vec3;
/** Nearest t >= 0, or −1 for a miss; a ray starting inside returns 0. */
export function rayIntersectSphere(
  ray: Ray,
  center: Vec3,
  radius: number,
): number;
/** Slab test; nearest t >= 0, or −1. */
export function rayIntersectAabb(ray: Ray, box: Aabb3): number;
/** −1 when parallel or behind the origin. */
export function rayIntersectPlane(ray: Ray, plane: Plane): number;
/** Möller–Trumbore; nearest t >= 0, or −1. */
export function rayIntersectTriangle(
  ray: Ray,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  cullBackfaces: boolean,
): number;

/** normal·x + constant = 0; positive inside. */
export interface Plane {
  normal: Vec3;
  constant: number;
}

export function planeCreate(): Plane;
export function planeSet(out: Plane, normal: Vec3, constant: number): Plane;
export function planeCopy(out: Plane, a: Plane): Plane;
/** Writes the unit normal and returns the original normal length. */
export function planeNormalize(out: Plane, a: Plane): number;
export function planeFromPointNormal(
  out: Plane,
  point: Vec3,
  normal: Vec3,
): Plane;
/** False for collinear points. */
export function planeFromPoints(
  out: Plane,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): boolean;
/** Positive inside (the side the normal points to). */
export function planeDistanceToPoint(a: Plane, point: Vec3): number;
export function planeProjectPoint(
  out: Vec3,
  a: Plane,
  point: Vec3,
): Vec3;
/** Same rule as `rayIntersectPlane`. */
export function planeIntersectRay(a: Plane, ray: Ray): number;

/** Order: left, right, bottom, top, near, far. */
export interface Frustum {
  readonly planes: readonly [Plane, Plane, Plane, Plane, Plane, Plane];
}

export function frustumCreate(): Frustum;
/**
 * Extracts normalized planes from a column-major view-projection matrix.
 * Near row: R3+R2 for "webgl"; R2 for "webgpu". Far row: R3−R2 for both.
 */
export function frustumFromViewProjection(
  out: Frustum,
  viewProjection: Mat4,
  clip: "webgl" | "webgpu",
): Frustum;
/** Strictly inside all planes. */
export function frustumContainsPoint(frustum: Frustum, point: Vec3): boolean;
export function frustumIntersectsSphere(
  frustum: Frustum,
  center: Vec3,
  radius: number,
): boolean;
/** Conservative: false only when fully outside at least one plane. */
export function frustumIntersectsAabb(frustum: Frustum, box: Aabb3): boolean;
export function frustumIntersectsObb(frustum: Frustum, box: Obb): boolean;

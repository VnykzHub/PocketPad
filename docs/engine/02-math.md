# 02 — Math

**Status:** authoritative for the engine's math types and conventions once implemented. This document specifies a target contract; no code in it exists yet.
**Authority:** [`SPEC.md`](../../SPEC.md), [`00-architecture.md`](00-architecture.md) for package boundaries and the frozen type names.
**Package:** `@lanpad/engine-core` at `packages/engine/core` (00 §3.7, §6). The wave brief's shorthand `packages/engine-core` resolves here.

---

## 1. Goal

Give every engine subsystem and every game one math library with unambiguous conventions, stable types and allocation-free hot paths.

The library must answer, without a second document:

- which way is up, which way is forward, and whether a matrix is row- or column-major;
- whether an angle is degrees or radians and which direction is positive;
- whether a quaternion multiplies on the left or the right;
- whether a function allocates, and what happens when `out` aliases an input;
- how close two float32 results are allowed to be.

The player-visible outcome is indirect but strict: cameras never look upside down because two subsystems disagreed about handedness; a 10,000-entity scene does not garbage-collect because a transform helper returned a fresh `Vec3`; physics and rendering agree on the same world-space box; a raycast from a phone-controlled reticle hits what the player sees.

**Scope.** Scalar helpers, `Vec2`, `Vec3`, `Vec4`, `Mat3`, `Mat4`, `Quat`, `Aabb2`, `Aabb3`, `Obb`, `Ray`, `Plane`, `Frustum`, conversion helpers, and their tests. This is the complete M0 math set; later specs consume it and do not extend it without a revision here.

---

## 2. Non-goals

- **Not a SIMD or WASM math library.** M0 is scalar TypeScript with typed-array storage. A SIMD path would be a separate implementation behind the same API, measured before adoption.
- **Not arbitrary precision.** `number` is IEEE-754 double; `Mat3`/`Mat4` storage is `Float32Array`. Big-number or fixed-point math is out of scope.
- **Not geometry processing.** Mesh decimation, CSG, convex hulls, Voronoi and terrain generation belong to tooling or world specs.
- **Not collision resolution.** Intersection predicates are here; contact generation, impulses, constraints and continuous collision belong to spec 07.
- **Not animation blending.** Quaternion slerp is here; pose blending, additive layers and root motion belong to spec 08.
- **Not a general linear-algebra package.** Only the operations the engine and games need are exported. Decompositions for shear, SVD, eigenvalues and general `NxN` matrices are excluded.
- **Not cross-engine bit-identical transcendental results.** `Math.sin`, `Math.cos`, `Math.atan2` and `Math.tan` may differ in the last bits between browsers; 00 §5.8 already scopes determinism to one build and one browser.
- **Not a degrees-first API.** Angles are radians everywhere. Degree conversion helpers exist for game data and UI.

---

## 3. Public interfaces

Everything is exported from `@lanpad/engine-core`; the source modules are listed in §6. Types fixed by 00 §3.2 (`Vec2`, `Vec3`, `Vec4`, `Quat`, `Mat4`) are preserved exactly.

### 3.1 Conventions (normative)

| Topic | Decision | Consequence |
|---|---|---|
| 3D handedness | **Right-handed** | `+X` right, `+Y` up, `+Z` toward the viewer; a camera looks down **−Z** |
| 3D forward | **−Z** | `mat4LookAt` maps `target − eye` to −Z |
| 3D units | **Metres, seconds** | Position and velocity are metres and metres/second; scale is unitless |
| 2D convention | `+X` right, `+Y` **down**, positive angle **clockwise** | Matches Canvas2D and the existing Coin Run / Tilt Maze world; `Vec2` helpers never assume "up" |
| Angles | **Radians**, positive per the row above | `degToRad` / `radToDeg` at data boundaries only |
| Matrix storage | **Column-major**, 16 floats (`Mat4`) or 9 floats (`Mat3`) | Element `(row r, column c)` is `m[c * 4 + r]` for `Mat4` |
| Vector form | **Column vectors** | `v' = M * v`; composition is `M_parent * M_local`; `mat4Multiply(out, a, b)` means `out = a * b` |
| Quaternion form | `(x, y, z, w)`, unit length, rotates column vectors as `v' = q v q*` | `quatMultiply(out, a, b)` means `out = a * b`; rotating by `a` then `b` is `b * a` |
| Euler order | **YXZ intrinsic** (yaw about +Y, then pitch about local +X, then roll about local +Z) | `quatFromEulerYXZ` is the only Euler constructor; other orders are authored by composing axis rotations |
| Primitive direction | `Ray.direction` is **unit length by convention** | Intersection functions return parameter `t` in world units; they do not normalize for you |
| Plane | `normal · x + constant = 0`; **inside is positive** | `planeDistanceToPoint` uses this sign; frustum tests expect positive inside |
| Clip space | WebGL2: z ∈ [−1, 1]; WebGPU: z ∈ [0, 1] | Two explicit projection families; no hidden global switch |
| Precision | Scalars are doubles; matrices are float32 | Comparisons use the tolerances in §3.9 |

A caller that needs a different convention (for example a y-up 2D game) converts at its own boundary. The engine never adds a global "up" flag.

### 3.2 Scalar helpers

```ts
export const PI: number;                 // Math.PI
export const TWO_PI: number;
export const HALF_PI: number;
export const DEG2RAD: number;
export const RAD2DEG: number;
export const EPSILON: number;            // 1e-6, float32-derived comparisons
export const EPSILON_SCALAR: number;     // 1e-9, pure-double scalar comparisons
export const EPSILON_DOUBLE: number;     // 1e-12, pure-double intermediate comparisons

export function clamp(value: number, min: number, max: number): number;
export function clamp01(value: number): number;
export function lerp(a: number, b: number, t: number): number;
export function inverseLerp(a: number, b: number, value: number): number;
export function degToRad(degrees: number): number;
export function radToDeg(radians: number): number;
/** Wrap to (-PI, PI]. */
export function wrapAngle(radians: number): number;
/** Move `current` toward `target` by at most `maxDelta` radians, across the wrap. */
export function moveTowardAngle(current: number, target: number, maxDelta: number): number;
export function approximatelyEqual(a: number, b: number, epsilon?: number): boolean; // default EPSILON_SCALAR
```

`clamp` with `min > max` is undefined in release and throws `RangeError` in dev (`?debug=1` or `NODE_ENV !== "production"`); callers must pass an ordered range.

### 3.3 Vec2

```ts
export interface Vec2 { x: number; y: number; }

export function vec2Create(x?: number, y?: number): Vec2;          // allocates; cold path
export function vec2Set(out: Vec2, x: number, y: number): Vec2;
export function vec2Copy(out: Vec2, a: Vec2): Vec2;
export function vec2Add(out: Vec2, a: Vec2, b: Vec2): Vec2;
export function vec2Sub(out: Vec2, a: Vec2, b: Vec2): Vec2;
export function vec2Scale(out: Vec2, a: Vec2, scalar: number): Vec2;
export function vec2AddScaled(out: Vec2, a: Vec2, b: Vec2, scalar: number): Vec2;
export function vec2Negate(out: Vec2, a: Vec2): Vec2;
export function vec2Dot(a: Vec2, b: Vec2): number;
export function vec2Cross(a: Vec2, b: Vec2): number;              // scalar z
export function vec2LengthSq(a: Vec2): number;
export function vec2Length(a: Vec2): number;
export function vec2DistanceSq(a: Vec2, b: Vec2): number;
export function vec2Distance(a: Vec2, b: Vec2): number;
/** Writes the unit vector and returns the original length; a zero vector writes (0,0) and returns 0. */
export function vec2Normalize(out: Vec2, a: Vec2): number;
export function vec2Lerp(out: Vec2, a: Vec2, b: Vec2, t: number): Vec2;
export function vec2Min(out: Vec2, a: Vec2, b: Vec2): Vec2;
export function vec2Max(out: Vec2, a: Vec2, b: Vec2): Vec2;
export function vec2ClampLength(out: Vec2, a: Vec2, maxLength: number): Vec2;
/** Positive radians rotate clockwise on screen (y-down). */
export function vec2Rotate(out: Vec2, a: Vec2, radians: number): Vec2;
/** Angle of `a` in (-PI, PI], measured from +X toward +Y (clockwise on screen). */
export function vec2Angle(a: Vec2): number;
export function vec2FromAngle(out: Vec2, radians: number, length?: number): Vec2;
/** Clockwise +90° perpendicular: (-y, x). */
export function vec2Perp(out: Vec2, a: Vec2): Vec2;
export function vec2Equals(a: Vec2, b: Vec2, epsilon?: number): boolean;
```

### 3.4 Vec3 and Vec4

```ts
export interface Vec3 { x: number; y: number; z: number; }
export interface Vec4 { x: number; y: number; z: number; w: number; }

export function vec3Create(x?: number, y?: number, z?: number): Vec3;
export function vec3Set(out: Vec3, x: number, y: number, z: number): Vec3;
export function vec3Copy(out: Vec3, a: Vec3): Vec3;
export function vec3Add(out: Vec3, a: Vec3, b: Vec3): Vec3;
export function vec3Sub(out: Vec3, a: Vec3, b: Vec3): Vec3;
export function vec3Scale(out: Vec3, a: Vec3, scalar: number): Vec3;
export function vec3AddScaled(out: Vec3, a: Vec3, b: Vec3, scalar: number): Vec3;
export function vec3Negate(out: Vec3, a: Vec3): Vec3;
export function vec3Dot(a: Vec3, b: Vec3): number;
export function vec3Cross(out: Vec3, a: Vec3, b: Vec3): Vec3;
export function vec3LengthSq(a: Vec3): number;
export function vec3Length(a: Vec3): number;
export function vec3DistanceSq(a: Vec3, b: Vec3): number;
export function vec3Distance(a: Vec3, b: Vec3): number;
/** Writes the unit vector and returns the original length; zero writes (0,0,0) and returns 0. */
export function vec3Normalize(out: Vec3, a: Vec3): number;
export function vec3Lerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3;
export function vec3Min(out: Vec3, a: Vec3, b: Vec3): Vec3;
export function vec3Max(out: Vec3, a: Vec3, b: Vec3): Vec3;
export function vec3Abs(out: Vec3, a: Vec3): Vec3;
export function vec3ClampLength(out: Vec3, a: Vec3, maxLength: number): Vec3;
export function vec3Equals(a: Vec3, b: Vec3, epsilon?: number): boolean;

export function vec4Create(x?: number, y?: number, z?: number, w?: number): Vec4;
export function vec4Set(out: Vec4, x: number, y: number, z: number, w: number): Vec4;
export function vec4Copy(out: Vec4, a: Vec4): Vec4;
export function vec4FromVec3(out: Vec4, a: Vec3, w: number): Vec4;
export function vec4ToVec3(out: Vec3, a: Vec4): Vec3;             // drops w, no divide
export function vec4Add(out: Vec4, a: Vec4, b: Vec4): Vec4;
export function vec4Sub(out: Vec4, a: Vec4, b: Vec4): Vec4;
export function vec4Scale(out: Vec4, a: Vec4, scalar: number): Vec4;
export function vec4Dot(a: Vec4, b: Vec4): number;
export function vec4LengthSq(a: Vec4): number;
export function vec4Length(a: Vec4): number;
export function vec4Normalize(out: Vec4, a: Vec4): number;
export function vec4Lerp(out: Vec4, a: Vec4, b: Vec4, t: number): Vec4;
export function vec4Equals(a: Vec4, b: Vec4, epsilon?: number): boolean;
```

### 3.5 Mat3

```ts
export interface Mat3 { readonly m: Float32Array; }              // 9 floats, column-major

export function mat3Create(): Mat3;                              // allocates
export function mat3Identity(out: Mat3): Mat3;
export function mat3Copy(out: Mat3, a: Mat3): Mat3;
export function mat3Set(out: Mat3, ...values: readonly number[]): Mat3; // 9 values, column-major
export function mat3FromMat4(out: Mat3, a: Mat4): Mat3;          // upper-left 3×3
export function mat3Multiply(out: Mat3, a: Mat3, b: Mat3): Mat3; // out = a * b
export function mat3Transpose(out: Mat3, a: Mat3): Mat3;
/** Returns false and zeroes `out` for a singular matrix. */
export function mat3Invert(out: Mat3, a: Mat3): boolean;
export function mat3Determinant(a: Mat3): number;
/** Linear 2×2 application on x/y; the third column is ignored. */
export function mat3TransformVec2(out: Vec2, a: Mat3, v: Vec2): Vec2;
export function mat3Equals(a: Mat3, b: Mat3, epsilon?: number): boolean;
```

`Mat3` is primarily a normal matrix. It is not an affine 2D transform; 2D games use `Mat4` through `mat4Compose` or plain `Vec2` math.

### 3.6 Mat4

```ts
export interface Mat4 { readonly m: Float32Array; }              // 16 floats, column-major

export function mat4Create(): Mat4;                              // allocates
export function mat4Identity(out: Mat4): Mat4;
export function mat4Copy(out: Mat4, a: Mat4): Mat4;
export function mat4Set(out: Mat4, ...values: readonly number[]): Mat4; // 16 values, column-major
export function mat4Multiply(out: Mat4, a: Mat4, b: Mat4): Mat4; // out = a * b
export function mat4Transpose(out: Mat4, a: Mat4): Mat4;
/** Returns false and zeroes `out` for a singular matrix. */
export function mat4Invert(out: Mat4, a: Mat4): boolean;
export function mat4Determinant(a: Mat4): number;

export function mat4FromTranslation(out: Mat4, translation: Vec3): Mat4;
export function mat4FromScale(out: Mat4, scale: Vec3): Mat4;
export function mat4FromQuat(out: Mat4, rotation: Quat): Mat4;
export function mat4FromAxisAngle(out: Mat4, axis: Vec3, radians: number): Mat4;
export function mat4FromRotationX(out: Mat4, radians: number): Mat4;
export function mat4FromRotationY(out: Mat4, radians: number): Mat4;
export function mat4FromRotationZ(out: Mat4, radians: number): Mat4;

/** out = T(position) * R(rotation) * S(scale). */
export function mat4Compose(out: Mat4, position: Vec3, rotation: Quat, scale: Vec3): Mat4;
/**
 * Splits a TRS matrix. Returns false for a singular or sheared matrix; `out`
 * fields then hold the last valid values rather than NaN.
 */
export function mat4Decompose(
  outPosition: Vec3, outRotation: Quat, outScale: Vec3, a: Mat4
): boolean;

export function mat4GetTranslation(out: Vec3, a: Mat4): Vec3;
export function mat4GetScale(out: Vec3, a: Mat4): Vec3;
/** Assumes no shear; returns false when decomposition fails. */
export function mat4GetRotation(out: Quat, a: Mat4): boolean;

/** Right-handed perspective; NDC z ∈ [-1, 1]. fovY is radians, 0 < fovY < PI. */
export function mat4PerspectiveWebGL2(
  out: Mat4, fovY: number, aspect: number, near: number, far: number
): Mat4;
/** Right-handed perspective; NDC z ∈ [0, 1]. */
export function mat4PerspectiveWebGPU(
  out: Mat4, fovY: number, aspect: number, near: number, far: number
): Mat4;
export function mat4OrthographicWebGL2(
  out: Mat4, left: number, right: number, bottom: number, top: number, near: number, far: number
): Mat4;
export function mat4OrthographicWebGPU(
  out: Mat4, left: number, right: number, bottom: number, top: number, near: number, far: number
): Mat4;

/** Right-handed view matrix; eye looks at target, up is normalized internally. */
export function mat4LookAt(out: Mat4, eye: Vec3, target: Vec3, up: Vec3): Mat4;

/** Applies the full matrix and divides by w when w is finite and non-zero. */
export function mat4TransformVec4(out: Vec4, a: Mat4, v: Vec4): Vec4;
/** Applies the full matrix with w = 1, then divides by w. */
export function mat4TransformPoint(out: Vec3, a: Mat4, point: Vec3): Vec3;
/** Applies the upper-left 3×3 only (no translation, no divide). */
export function mat4TransformDirection(out: Vec3, a: Mat4, direction: Vec3): Vec3;
export function mat4Equals(a: Mat4, b: Mat4, epsilon?: number): boolean;
```

Projection formulas are fixed (column-major, `m[c * 4 + r]`):

| Function | Non-zero terms |
|---|---|
| `mat4PerspectiveWebGL2` | `f = 1/tan(fovY/2)`; `m[0]=f/aspect`, `m[5]=f`, `m[10]=(far+near)/(near−far)`, `m[11]=−1`, `m[14]=(2·far·near)/(near−far)` |
| `mat4PerspectiveWebGPU` | same `f`; `m[0]=f/aspect`, `m[5]=f`, `m[10]=far/(near−far)`, `m[11]=−1`, `m[14]=(far·near)/(near−far)` |
| `mat4OrthographicWebGL2` | `m[0]=2/(r−l)`, `m[5]=2/(t−b)`, `m[10]=−2/(f−n)`, `m[12]=−(r+l)/(r−l)`, `m[13]=−(t+b)/(t−b)`, `m[14]=−(f+n)/(f−n)`, `m[15]=1` |
| `mat4OrthographicWebGPU` | `m[0]=2/(r−l)`, `m[5]=2/(t−b)`, `m[10]=−1/(f−n)`, `m[12]=−(r+l)/(r−l)`, `m[13]=−(t+b)/(t−b)`, `m[14]=−n/(f−n)`, `m[15]=1` |

Each projection returns `out` unchanged and does not throw for invalid inputs in release. In dev, `near <= 0`, `far <= near`, `aspect <= 0`, `fovY <= 0 || fovY >= PI`, or `left === right` throws `RangeError` with the offending parameter name. A game that ships such values has a data bug that must be found at load, not at frame 10,000.

`mat4Decompose` rules:

- Column lengths give scale; a zero-length column makes the matrix singular → `false`.
- Negative determinant means a mirrored basis: the sign is folded into `scale.x` (only x), so `compose(decompose(M))` reproduces `M` for a TRS matrix.
- Rotation is extracted from the scale-divided upper-left 3×3 and normalized; `w` is chosen non-negative so quaternions compare deterministically.

### 3.7 Quat

```ts
export interface Quat { x: number; y: number; z: number; w: number; }

export function quatCreate(x?: number, y?: number, z?: number, w?: number): Quat; // default identity
export function quatIdentity(out: Quat): Quat;                   // (0,0,0,1)
export function quatSet(out: Quat, x: number, y: number, z: number, w: number): Quat;
export function quatCopy(out: Quat, a: Quat): Quat;
export function quatMultiply(out: Quat, a: Quat, b: Quat): Quat; // out = a * b
export function quatConjugate(out: Quat, a: Quat): Quat;
/** Inverse of a unit quaternion; for non-unit input returns conjugate / lengthSq. */
export function quatInvert(out: Quat, a: Quat): Quat;
/** Writes the unit quaternion and returns the original length; zero writes identity and returns 0. */
export function quatNormalize(out: Quat, a: Quat): number;
export function quatDot(a: Quat, b: Quat): number;
export function quatLengthSq(a: Quat): number;
export function quatLength(a: Quat): number;
export function quatFromAxisAngle(out: Quat, axis: Vec3, radians: number): Quat;
/** YXZ intrinsic: yaw about +Y, then pitch about local +X, then roll about local +Z; q = qY * qX * qZ. */
export function quatFromEulerYXZ(out: Quat, x: number, y: number, z: number): Quat;
export function quatToMat3(out: Mat3, a: Quat): Mat3;
export function quatToMat4(out: Mat4, a: Quat): Mat4;
/** Rotates a vector by a unit quaternion; `out` may alias `v`. */
export function quatRotateVec3(out: Vec3, q: Quat, v: Vec3): Vec3;
/** Shortest-arc spherical interpolation; endpoints are exact, t is clamped to [0,1]. */
export function quatSlerp(out: Quat, a: Quat, b: Quat, t: number): Quat;
/** Normalized linear interpolation; cheaper, not constant-speed. */
export function quatNlerp(out: Quat, a: Quat, b: Quat, t: number): Quat;
/** Angle in radians in [0, PI] between two unit quaternions. */
export function quatAngleBetween(a: Quat, b: Quat): number;
/** Returns false for a matrix with a mirrored or non-orthogonal basis. */
export function quatFromMat4(out: Quat, a: Mat4): boolean;
/** Shortest rotation taking unit vector `from` to unit vector `to`; opposite vectors pick a stable perpendicular axis. */
export function quatFromTo(out: Quat, from: Vec3, to: Vec3): Quat;
export function quatEquals(a: Quat, b: Quat, epsilon?: number): boolean; // q and -q are NOT equal
```

`quatSlerp` selects the shorter arc by negating `b` when `dot(a,b) < 0`; for nearly parallel inputs it falls back to `quatNlerp` to avoid division by a near-zero sine.

### 3.8 Primitives

```ts
/** Legacy-compatible 2D box: x/y is the min corner, w/h positive extents, y-down. */
export interface Aabb2 { x: number; y: number; w: number; h: number; }

export function aabb2Create(x?: number, y?: number, w?: number, h?: number): Aabb2;
export function aabb2Set(out: Aabb2, x: number, y: number, w: number, h: number): Aabb2;
export function aabb2Copy(out: Aabb2, a: Aabb2): Aabb2;
export function aabb2FromMinMax(out: Aabb2, minX: number, minY: number, maxX: number, maxY: number): Aabb2;
export function aabb2Center(out: Vec2, a: Aabb2): Vec2;
export function aabb2ContainsPoint(a: Aabb2, point: Vec2): boolean;   // inclusive edges
export function aabb2Intersects(a: Aabb2, b: Aabb2): boolean;         // touching counts
export function aabb2Union(out: Aabb2, a: Aabb2, b: Aabb2): Aabb2;
export function aabb2ClosestPoint(out: Vec2, a: Aabb2, point: Vec2): Vec2;

export interface Aabb3 { min: Vec3; max: Vec3; }                      // min <= max per axis

export function aabb3Create(): Aabb3;
export function aabb3Set(out: Aabb3, min: Vec3, max: Vec3): Aabb3;
export function aabb3Copy(out: Aabb3, a: Aabb3): Aabb3;
export function aabb3FromCenterHalfExtents(out: Aabb3, center: Vec3, halfExtents: Vec3): Aabb3;
export function aabb3Center(out: Vec3, a: Aabb3): Vec3;
export function aabb3HalfExtents(out: Vec3, a: Aabb3): Vec3;
export function aabb3Size(out: Vec3, a: Aabb3): Vec3;
export function aabb3Union(out: Aabb3, a: Aabb3, b: Aabb3): Aabb3;
export function aabb3ExpandByPoint(out: Aabb3, a: Aabb3, point: Vec3): Aabb3;
export function aabb3ContainsPoint(a: Aabb3, point: Vec3): boolean;  // inclusive
export function aabb3IntersectsAabb(a: Aabb3, b: Aabb3): boolean;    // touching counts
export function aabb3IntersectsSphere(a: Aabb3, center: Vec3, radius: number): boolean;
export function aabb3ClosestPoint(out: Vec3, a: Aabb3, point: Vec3): Vec3;
export function aabb3Transform(out: Obb, a: Aabb3, matrix: Mat4): Obb;

export interface Obb { center: Vec3; halfExtents: Vec3; rotation: Quat; }

export function obbCreate(): Obb;
export function obbSet(out: Obb, center: Vec3, halfExtents: Vec3, rotation: Quat): Obb;
export function obbCopy(out: Obb, a: Obb): Obb;
/** Writes one of the three local axes (0 = x, 1 = y, 2 = z) rotated to world space. */
export function obbGetAxis(out: Vec3, a: Obb, axis: 0 | 1 | 2): Vec3;
export function obbContainsPoint(a: Obb, point: Vec3): boolean;      // inclusive
export function obbIntersectsAabb(a: Obb, b: Aabb3): boolean;        // SAT, touching counts
export function obbIntersectsObb(a: Obb, b: Obb): boolean;           // SAT, touching counts
export function obbClosestPoint(out: Vec3, a: Obb, point: Vec3): Vec3;

export interface Ray { origin: Vec3; direction: Vec3; }              // direction unit length

export function rayCreate(): Ray;
export function raySet(out: Ray, origin: Vec3, direction: Vec3): Ray;
export function rayCopy(out: Ray, a: Ray): Ray;
export function rayAt(out: Vec3, ray: Ray, t: number): Vec3;
/** Closest point on the ray; t is clamped to >= 0. */
export function rayClosestPoint(out: Vec3, ray: Ray, point: Vec3): Vec3;
/** Nearest t >= 0, or -1 for a miss. A ray starting inside returns 0. */
export function rayIntersectSphere(ray: Ray, center: Vec3, radius: number): number;
/** Slab test; nearest t >= 0, or -1. */
export function rayIntersectAabb(ray: Ray, box: Aabb3): number;
/** Plane in normal·x + constant = 0 form; -1 when parallel or behind the origin. */
export function rayIntersectPlane(ray: Ray, plane: Plane): number;
/** Möller–Trumbore; nearest t >= 0, or -1. `cullBackfaces` uses the right-hand winding. */
export function rayIntersectTriangle(
  ray: Ray, a: Vec3, b: Vec3, c: Vec3, cullBackfaces: boolean
): number;

export interface Plane { normal: Vec3; constant: number; }

export function planeCreate(): Plane;
export function planeSet(out: Plane, normal: Vec3, constant: number): Plane;
export function planeCopy(out: Plane, a: Plane): Plane;
/** Writes the unit normal and returns the original normal length; a zero normal writes (0,1,0), constant 0, returns 0. */
export function planeNormalize(out: Plane, a: Plane): number;
export function planeFromPointNormal(out: Plane, point: Vec3, normal: Vec3): Plane;
/** Returns false for collinear points; `out` then holds the last valid value. */
export function planeFromPoints(out: Plane, a: Vec3, b: Vec3, c: Vec3): boolean;
/** Positive inside (the side the normal points to). */
export function planeDistanceToPoint(a: Plane, point: Vec3): number;
export function planeProjectPoint(out: Vec3, a: Plane, point: Vec3): Vec3;
export function planeIntersectRay(a: Plane, ray: Ray): number;       // same rule as rayIntersectPlane

export interface Frustum { readonly planes: readonly [Plane, Plane, Plane, Plane, Plane, Plane]; }
// order: left, right, bottom, top, near, far

export function frustumCreate(): Frustum;                            // allocates 6 planes
/**
 * Extracts normalized planes from a column-major view-projection matrix.
 * `clip` selects the near/far rows: "webgl" for z ∈ [-1,1], "webgpu" for z ∈ [0,1].
 */
export function frustumFromViewProjection(
  out: Frustum, viewProjection: Mat4, clip: "webgl" | "webgpu"
): Frustum;
export function frustumContainsPoint(frustum: Frustum, point: Vec3): boolean; // strictly inside all planes
export function frustumIntersectsSphere(frustum: Frustum, center: Vec3, radius: number): boolean;
/** Conservative: false only when the box is fully outside at least one plane. */
export function frustumIntersectsAabb(frustum: Frustum, box: Aabb3): boolean;
export function frustumIntersectsObb(frustum: Frustum, box: Obb): boolean;
```

Frustum extraction (normative, column-major `m[c*4+r]`, row vectors `R0..R3`):

| Plane | WebGL2 | WebGPU |
|---|---|---|
| left | `R3 + R0` | `R3 + R0` |
| right | `R3 − R0` | `R3 − R0` |
| bottom | `R3 + R1` | `R3 + R1` |
| top | `R3 − R1` | `R3 − R1` |
| near | `R3 + R2` | `R2` |
| far | `R3 − R2` | `R3 − R2` |

Each plane is normalized; a non-finite divisor leaves the unnormalized plane and increments a dev counter rather than producing NaN.

### 3.9 Tolerances and equality

| Comparison | Default tolerance | Rationale |
|---|---|---|
| Float32-derived vectors/matrices (`mat4Equals`, `quatEquals`) | `EPSILON = 1e-6` | Relative to unit-scale values; a 16-float multiply accumulates ~1e-7 error |
| Pure-double scalar (`approximatelyEqual`) | `EPSILON_SCALAR = 1e-9` | No storage rounding |
| Pure-double intermediate (`vec3Length` vs reference) | `EPSILON_DOUBLE = 1e-12` | Test-only |
| Orientation / normalized vectors | `1e-5` on dot product | Allows one normalize pass |
| Geometric predicates | Exact sign, but callers may pass `1` as tolerance | No epsilon inflation in the core |

`vec3Equals` and `quatEquals` compare component-wise. `quatEquals(q, -q)` is **false** by design; use `Math.abs(quatDot(a,b)) >= 1 - epsilon` for "same rotation".

### 3.10 Allocation and aliasing rules

- Every function with an `out` parameter writes into it and returns it, except the measurement functions (`vec*Normalize`, `planeNormalize`), which return the original length, and predicates, which return booleans.
- `out` may alias any input. Implementations read all needed input components before writing, or write in an order that is proven safe. This is tested explicitly.
- `*Create` functions allocate and are for boot, load and tests only. They are never called from `onTick`, `updateTransforms`, a render loop or a query.
- No function allocates an intermediate array, object, closure or string. No spread, no `Array.prototype.map/filter/forEach` on a `Float32Array` in a math hot path.
- No module-level mutable scratch vectors. Two calls in the same expression must not share state.
- `Mat3.m` and `Mat4.m` are readonly references to mutable storage. Callers may read elements directly; they must not replace `.m`. Mutating `.m` without calling a math function is allowed only inside serialization and tests.
- No `Math.hypot`: it is slower and its precision behaviour varies. Use `Math.sqrt(x*x + y*y + z*z)`, with overflow-avoidance only where magnitudes can exceed 1e150 (not in engine data).

---

## 4. Data formats

No persisted engine file uses this library directly. Two test-only formats are owned here.

### 4.1 Golden matrix fixture (`packages/engine/core/test/fixtures/math-golden.json`)

```json
{
  "formatVersion": 1,
  "cases": [
    {
      "name": "perspective-webgl2-fov60-aspect16x9-n0.1-f1000",
      "op": "mat4PerspectiveWebGL2",
      "args": [1.0471975511965976, 1.7777777777777777, 0.1, 1000],
      "clip": "webgl",
      "m": ["0x3f2aaaab", "0x00000000", "…"]
    }
  ]
}
```

Rules:

- `m` holds 16 IEEE-754 binary32 words as lowercase hex, column-major. Synthetic values only.
- Golden comparison uses the tolerance in §3.9, not string equality, except where the test explicitly checks exact identity (identity matrix, translation).
- A case names the operation and its arguments so a failure reports the input, not just a diff.
- No production camera or game data appears in the fixture.

### 4.2 Math property corpus

`fast-check` generators in test code, not a data file. Ranges:

- Positions and directions: `[-1e6, 1e6]`, excluding non-finite values.
- Quaternions: arbitrary 4-vectors normalized to unit length; the zero vector maps to identity.
- Scales: `[-100, -1e-3] ∪ [1e-3, 100]` (no zero, no near-zero for inverse tests).
- Angles: `[-4π, 4π]`.
- Matrices for inversion: compose(TRS) with the ranges above, so the matrix is invertible by construction.

---

## 5. Architecture

### 5.1 Modules

```
engine-core/src/math/
  constants.ts     PI, EPSILON, DEG2RAD, clamp/lerp/wrap
  Vec2.ts          interface + functions
  Vec3.ts
  Vec4.ts
  Mat3.ts
  Mat4.ts          storage, composition, projections, view
  Quat.ts
  Aabb.ts          Aabb2 + Aabb3
  Obb.ts
  Ray.ts
  Plane.ts
  Frustum.ts
  index.ts         barrel; the only import path consumers use
```

Each module is a plain set of functions over plain data. There are no classes, no prototypes, no methods on the value types. This keeps values structured-cloneable (worker payloads, save data) and keeps hot paths monomorphic.

### 5.2 Storage layout

| Type | Storage | Why |
|---|---|---|
| `Vec2`, `Vec3`, `Vec4`, `Quat` | Plain object with four/eight-byte-aligned `number` fields | Small, embeddable in components, cloneable, no typed-array allocation per value |
| `Mat3`, `Mat4` | `Float32Array` (9 / 16) | Matches GPU uniform layout; no conversion at upload |
| `Aabb2` | Four numbers in existing `{x,y,w,h}` order | Legacy physics migration without a conversion layer |
| `Aabb3` | Two `Vec3` (min/max) | Fewer fields than center/extents; direct min/max tests |
| `Obb` | center + halfExtents + rotation | Compact, rotation reused by the renderer |
| `Ray` | origin + direction | Conventional and readable |
| `Plane` | normal + constant | Normal/constant form avoids storing a point |
| `Frustum` | Fixed tuple of six `Plane` objects | Allocation at creation only; no per-frame plane creation |

A `Mat4` is uploaded to a `Float32Array` uniform directly. The renderer never transposes on upload: the shader declares column-major matrices and uses `mat4x4<f32>` / `mat4` with the same layout.

### 5.3 Transform composition

```
world = parentWorld * T(position) * R(rotation) * S(scale)
```

- `mat4Compose` writes `T * R * S`; `mat4Multiply(out, parentWorld, local)` writes the world matrix.
- A Transform's local matrix is not cached by the math library. Spec 03 caches world matrices; the math library is stateless.
- Rotation is always a unit quaternion. A non-unit quaternion passed to `mat4FromQuat` is normalized implicitly by the formula; a zero quaternion produces identity in dev and a dev counter increment.
- Scale may be zero or negative. Negative scale mirrors; normals then need the inverse-transpose (`mat3FromMat4(inverse)`), which the renderer owns.

### 5.4 Projection and view

- The engine keeps two projection functions because WebGPU and WebGL2 clip-space depth differ. No code branches on backend to choose a matrix; the renderer picks the function for its own backend and passes the resulting `Mat4` to culling with the matching `clip` argument.
- `mat4LookAt` is right-handed and produces a camera basis whose forward is −Z, right is +X and up is +Y (orthonormalized). It does not roll.
- Culling uses `frustumFromViewProjection(out, viewProjection, clip)` with the same clip argument used to build the projection. A mismatch is a bug; the frustum cannot detect it.
- Object matrices are column-major and world-space. Camera position for audio/physics is `mat4GetTranslation` of the inverse view, or the eye passed to `lookAt`; games should not invert the view matrix per frame.

### 5.5 Hot paths

| Consumer | Functions used per frame | Allocation rule |
|---|---|---|
| Scene transform update (03) | `mat4Compose`, `mat4Multiply` | `out` is the entity's cached world matrix; zero allocation |
| Renderer culling (04/05) | `frustumIntersectsAabb/Obb`, `mat4TransformPoint` | Caller-owned scratch; zero allocation |
| Physics (07) | `vec3*`, `quat*`, `rayIntersect*`, `aabb3*`, `obb*` | Caller-owned body/shape structs; zero allocation |
| Animation (08) | `quatSlerp/Nlerp`, `quatMultiply`, `quatNormalize` | Joint buffers are preallocated; zero allocation |
| Input/camera (10) | `vec2*`, `quatFromEulerYXZ`, `mat4LookAt` | One camera matrix per frame; zero allocation |
| AI (11) | `vec3*`, `rayIntersectAabb`, `planeDistanceToPoint` | Agent scratch preallocated; zero allocation |

A math function that cannot meet a hot-path budget is optimized inside this module; consumers do not inline their own copies. Duplicated math in a consumer is a review failure.

### 5.6 Migration from the existing tree

| Current | Target | Rule |
|---|---|---|
| `packages/runtime/src/physics/Vec2.ts` | `engine-core/src/math/Vec2.ts` | Move the interface; add functions without changing field names |
| `packages/runtime/src/physics/Aabb.ts` | `engine-core/src/math/Aabb.ts` (`Aabb2`) | Keep `{x,y,w,h}` and y-down semantics exactly |
| `packages/runtime/src/physics/collide.ts` | `packages/engine/physics/src/two-d/collide.ts` | Not this spec; uses these types |
| Any local `Vec3` interface in `sdk` | stays duplicated | `sdk` is a zero-dependency leaf (00 §3.6); no import of engine types |

`packages/runtime/src/physics/index.ts` remains a compatibility re-export for one wave, then is deleted at M1.

### 5.7 Determinism

- The same build on the same browser produces bit-identical results for `+`, `-`, `*`, `/` and `sqrt` sequences, because IEEE-754 double arithmetic is deterministic for these operations.
- Transcendentals (`sin`, `cos`, `tan`, `atan2`) may differ in the last bits between browsers. This is accepted by 00 §5.8 and never used inside a replay hash for a value that must match across browsers.
- `Float32Array` stores are deterministic (round-to-nearest-even binary32).
- No math function consults `Math.random`, `Date`, a locale or environment state.

---

## 6. File ownership

**This spec owns:** `docs/engine/02-math.md` and the paths below.

| Path | Contents | Owner |
|---|---|---|
| `packages/engine/core/src/math/constants.ts` | Constants, scalar helpers, tolerances | 02 |
| `packages/engine/core/src/math/Vec2.ts` | `Vec2` and functions | 02 |
| `packages/engine/core/src/math/Vec3.ts` | `Vec3` and functions | 02 |
| `packages/engine/core/src/math/Vec4.ts` | `Vec4` and functions | 02 |
| `packages/engine/core/src/math/Mat3.ts` | `Mat3` and functions | 02 |
| `packages/engine/core/src/math/Mat4.ts` | `Mat4`, TRS, projections, view, transforms | 02 |
| `packages/engine/core/src/math/Quat.ts` | `Quat`, rotation, interpolation, conversion | 02 |
| `packages/engine/core/src/math/Aabb.ts` | `Aabb2`, `Aabb3` | 02 |
| `packages/engine/core/src/math/Obb.ts` | `Obb`, SAT against AABB/OBB | 02 |
| `packages/engine/core/src/math/Ray.ts` | `Ray`, sphere/AABB/plane/triangle intersections | 02 |
| `packages/engine/core/src/math/Plane.ts` | `Plane`, projection, intersection | 02 |
| `packages/engine/core/src/math/Frustum.ts` | Plane extraction and tests | 02 |
| `packages/engine/core/src/math/index.ts` | Barrel export | 02 |
| `packages/engine/core/test/math/*.test.ts` | Unit, aliasing, property, golden tests | 02 |
| `packages/engine/core/test/math/fixtures/math-golden.json` | Golden matrices and transforms | 02 |
| `packages/engine/core/test/math/bench/math.bench.ts` | Allocation and throughput fixture | 02 |
| `packages/runtime/src/physics/Vec2.ts` | Deprecated re-export after migration | integration agent |
| `packages/runtime/src/physics/Aabb.ts` | Deprecated re-export after migration | integration agent |

**Not owned by this spec:** `engine-core/src/scene/**` (03), renderer contracts (04/05), collision/constraints (07), animation blending (08), input (10), AI (11), tooling (16), benchmark page (19). `sdk/src/game-api.ts` keeps its own structural `Vec3` and is not edited here.

---

## 7. Acceptance

**Evidence rule:** every row is PASS only with a recorded build, device, browser version, date and numbers in `docs/RESULTS.md`. Targets are acceptance thresholds, not measurements.

| ID | Criterion | Fixture / method | Hardware / environment | State |
|---|---|---|---|---|
| ER-02-01 | Vec2/Vec3/Vec4 algebra matches a scalar reference for 10,000 random inputs; every function produces the same result when `out` aliases each input | `fast-check`, aliasing matrix | CI Node 20 | PENDING — test authoring |
| ER-02-02 | `mat4Multiply` is associative within 1e-5; `M * I = M`; `M * inverse(M) ≈ I` within 1e-5 for 10,000 invertible TRS matrices; `det(A*B) ≈ det(A)*det(B)` | `mat4.property.test.ts` | CI Node 20 | PENDING |
| ER-02-03 | `compose` → `decompose` → `compose` reproduces position within 1e-6, scale within 1e-6, and rotation within `dot >= 1 − 1e-6`, including negative and non-uniform scale | `transform.property.test.ts` | CI Node 20 | PENDING |
| ER-02-04 | `quatRotateVec3` matches `mat4TransformDirection(mat4FromQuat(q))` within 1e-6 for 10,000 unit quaternions; `quatSlerp` endpoints are exact and its shortest-arc path never takes the long way | `quat.property.test.ts` | CI Node 20 | PENDING |
| ER-02-05 | Perspective and orthographic matrices match `math-golden.json` within 1e-6; WebGL2 maps near/far to −1/+1 and WebGPU maps them to 0/+1 | Golden fixture | CI Node 20 | PENDING — fixture authored with this spec |
| ER-02-06 | `mat4LookAt` maps `target` to −Z, keeps `up` in the camera's +Y hemisphere, and is orthonormal within 1e-6 for 10,000 random eye/target/up triples that are not collinear | `camera.property.test.ts` | CI Node 20 | PENDING |
| ER-02-07 | `rayIntersectAabb` and `rayIntersectSphere` agree with a brute-force 1,000-sample ray march within 1e-9 (hit/miss and t); a ray starting inside an AABB returns 0 | `ray.property.test.ts` | CI Node 20 | PENDING |
| ER-02-08 | OBB/AABB SAT is symmetric and agrees with a 10,000-point brute-force containment/touch check; identity-rotation OBB vs the same AABB returns true | `obb.property.test.ts` | CI Node 20 | PENDING |
| ER-02-09 | Frustum point tests match six explicit plane tests for 10,000 random points; sphere/AABB tests produce no false negatives against 1,000 sampled points | `frustum.property.test.ts` | CI Node 20 | PENDING |
| ER-02-10 | 1,000,000 `vec3Add` and 100,000 `mat4Multiply` calls over preallocated outputs grow the heap by ≤ 64 KiB after warm-up; no `*Create` is called in the loop | `math.bench.ts`, Node 20 `--expose-gc` | CI Node 20 | PENDING |
| ER-02-11 | 10,000,000 `vec3Add` complete in ≤ 75 ms p50 and 1,000,000 `mat4Multiply` in ≤ 250 ms p50, recorded with build hash and adapter | `experiments/e-m0-engine/?mathBench=1` | Desktop Chrome 155, Windows 11 | PENDING — needs the M0 page |
| ER-02-12 | The golden fixture produces identical binary32 words on Chrome 155 and Firefox current for add/multiply/compose/projection; transcendental-dependent cases are excluded and labelled | Golden runner in both browsers | Desktop Chrome 155 + Firefox current, Windows 11 | PENDING — cross-browser run |
| ER-02-13 | TV profile reproduces the golden fixture and records math time inside the 10,000-entity scene | `?mathBench=1&instances=10000` | **PENDING device:** 2020-era Android TV Chromium, Tizen/webOS set | PENDING — no TV hardware |

The throughput numbers in ER-02-11 are deliberately loose acceptance thresholds (roughly 7.5 ns per `vec3Add`, 250 ns per `mat4Multiply`), intended to catch accidental allocation or megamorphic dispatch, not to rank hardware. `docs/RESULTS.md` records the measured values.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | Every function once with hand-computed values; edge cases (zero vector, opposite quaternions, singular matrix, collinear triangle) | `packages/engine/core/test/math/*.test.ts` |
| Property (`fast-check`) | Algebra laws, aliasing, compose/decompose, quaternion/matrix agreement, ray/AABB brute force, OBB SAT symmetry, frustum consistency | `test/math/*.property.test.ts` |
| Golden | Projection/view matrices and fixed transforms as binary32 hex; exact identity/translation cases | `test/math/fixtures/math-golden.json` |
| Integration | One scene uses math types through 03/04 fakes; matrix upload layout matches the renderer contract | `test/math/integration.layout.test.ts` |
| Benchmark | Allocation growth and throughput | `test/math/bench/math.bench.ts`, benchmark page (19) |
| Manual | Cross-browser golden reproduction and TV run | Device matrix, `docs/RESULTS.md` |

Test rules:

- Every title carries its `ER-02-NN` ID.
- Property tests log the failing input through `fast-check`'s shrinker; a tolerance failure is a defect, not a test rewrite.
- Golden fixtures are updated only when this spec's formulas change; an unexplained golden diff blocks the wave.
- No test reads `Math.random`; generators are seeded by `fast-check`.

---

## 9. Dependencies

| Dependency | Why | Status |
|---|---|---|
| `00-architecture.md` | Type names, package path, determinism scope, no-per-frame-allocation rule | Written |
| `01-core-loop-time.md` | None at compile time; simulation time uses `tick * dt`, no math needed | Written in the same wave |
| `03-scene-ecs.md` | First consumer: TRS storage and world matrices | Written in the same wave |
| `04-renderer-webgpu.md` / `05-renderer-webgl2.md` | Projection choice per backend, frustum culling, matrix upload layout | Later |
| `07-physics3d.md` | Ray/AABB/OBB/plane primitives and quaternion integration | Later |
| `08-animation.md` | Quaternion interpolation | Later |
| `19-testing-benchmarks.md` | Benchmark page and result recording | Later |

External dependencies: none. The math module uses only JavaScript built-ins.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | Handedness or clip-space mismatch makes the scene upside down or depth-broken | High if undocumented | Every 3D game wrong | Fixed conventions in §3.1; two explicit projection functions; golden tests that map near/far; renderer passes the matching `clip` to culling |
| R2 | Column-major/row-major confusion at upload | Medium | Transposed world | Single storage layout, shader uses the same layout, integration layout test ER-02-01 |
| R3 | Quaternion order or Euler order differs between animation and input | Medium | Wrong-facing characters/camera | One composition rule (`a * b`), one Euler constructor (YXZ), property test against matrices |
| R4 | `out` aliasing corrupts a component | Medium | Subtle wrong values | Every function reads before writing; aliasing matrix ER-02-01 |
| R5 | Per-frame allocation creeps back through `*Create` | High over time | GC hitches on TV | Hot-path table §5.5, bench ER-02-10, review rule, no class methods returning new values |
| R6 | Float32 matrices lose precision at large open-world coordinates | Medium | Jitter far from origin | Positions stay double in the scene (03); matrices are camera-relative before upload; world-origin rebasing is a streaming/world-spec decision (12) |
| R7 | Epsilon choices hide real geometry errors | Medium | Tunnelling, false culling | Exact sign predicates in core; epsilon only in equality tests; no epsilon in ray t or plane distance |
| R8 | Frustum culling false negatives pop objects | Medium on OBB | Visible popping | Conservative "outside only if fully outside one plane"; brute-force sampled test; renderer can disable culling behind a feature flag |
| R9 | Transcendental differences break a cross-browser replay | Low (scope excludes it) | Replay mismatch | 00 §5.8 scope; replay hashes exclude transcendental-dependent state or are compared per browser |
| R10 | Math API overgrows into a general linear-algebra library | Medium | Maintenance, bundle size | Non-goals list; only functions with a named consumer in the spec index; bundle size recorded per wave |
| R11 | Negative scale breaks normals or decomposition | Medium | Inverted lighting | Mirror sign folded into `scale.x`; renderer uses inverse-transpose normal matrix; test ER-02-03 |

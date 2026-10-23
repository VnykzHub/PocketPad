/**
 * Public math barrel (02 §5.1). Re-exports exactly the frozen surface declared
 * by `src/contracts/math.d.ts`.
 *
 * `constants.ts` and `Quat.ts` are exported by name so the dev diagnostics
 * (`IS_DEV`, `DEV_COUNTERS`) and the internal rotation helper
 * (`quatFromRotationElements`) stay inside the module.
 */

export {
  PI,
  TWO_PI,
  HALF_PI,
  DEG2RAD,
  RAD2DEG,
  EPSILON,
  EPSILON_SCALAR,
  EPSILON_DOUBLE,
  clamp,
  clamp01,
  lerp,
  inverseLerp,
  degToRad,
  radToDeg,
  wrapAngle,
  moveTowardAngle,
  approximatelyEqual,
} from "./constants.js";

export * from "./Vec2.js";
export * from "./Vec3.js";
export * from "./Vec4.js";
export * from "./Mat3.js";
export * from "./Mat4.js";

export type { Quat } from "./Quat.js";
export {
  quatCreate,
  quatIdentity,
  quatSet,
  quatCopy,
  quatMultiply,
  quatConjugate,
  quatInvert,
  quatNormalize,
  quatDot,
  quatLengthSq,
  quatLength,
  quatFromAxisAngle,
  quatFromEulerYXZ,
  quatToMat3,
  quatToMat4,
  quatRotateVec3,
  quatSlerp,
  quatNlerp,
  quatAngleBetween,
  quatFromMat4,
  quatFromTo,
  quatEquals,
} from "./Quat.js";

export * from "./Aabb.js";
export * from "./Obb.js";
export * from "./Ray.js";
export * from "./Plane.js";
export * from "./Frustum.js";

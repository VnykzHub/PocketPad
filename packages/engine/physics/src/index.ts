/**
 * Public entry for `@lanpad/engine-physics` (spec 07, amendment A15).
 *
 * Frozen contract types, runtime constants and the Rapier-backed backend.
 * `createRapierAdapter()` is synchronous; `await initRapierPhysics()` once
 * before the first world, then drive `step(fixedDt)` from the host loop.
 */
export type * from "./contracts/physics3d.js";

/* Frozen 2D solver (07 §5.15). The `./two-d` subpath is the Rapier-free entry. */
export * from "./two-d/index.js";

export {
  PHYSICS_CONTRACT_VERSION,
  PHYSICS_FIXED_DT,
  PHYSICS_DEFAULT_GRAVITY,
  PHYSICS_DEFAULT_SOLVER,
  PHYSICS_DEFAULT_SLEEP,
  PHYSICS_DEFAULT_FRICTION,
  PHYSICS_DEFAULT_RESTITUTION,
  PHYSICS_DEFAULT_DENSITY,
  PHYSICS_DEFAULT_ANGULAR_DAMPING,
  PHYSICS_MAX_DYNAMIC_BODIES,
  PHYSICS_HARD_MAX_DYNAMIC_BODIES,
  PHYSICS_MAX_COLLIDERS,
  PHYSICS_HARD_MAX_COLLIDERS,
  PHYSICS_MAX_COLLIDERS_PER_BODY,
  PHYSICS_MAX_TRIMESH_TRIANGLES,
  PHYSICS_MAX_JOINTS,
  PHYSICS_MAX_WHEELS,
  PHYSICS_MAX_CONTACT_POINTS,
  PHYSICS_MAX_CONTACT_EVENTS,
  PHYSICS_SCRATCH_MEMORY_BYTES,
  PHYSICS_MAX_SCENE_BODIES,
  PHYSICS_MAX_SCENE_COLLIDERS,
  PHYSICS_MAX_LINEAR_SPEED,
  PHYSICS_MAX_ANGULAR_SPEED,
  PHYSICS_POSITION_RANGE,
  PHYSICS_CCD_SPEED_THRESHOLD,
  PHYSICS_MAX_CCD_SWEEPS,
  PHYSICS_SLEEP_LINEAR_THRESHOLD,
  PHYSICS_SLEEP_ANGULAR_THRESHOLD,
  PHYSICS_SLEEP_TIME_TO_SLEEP,
  PHYSICS_RESTITUTION_VELOCITY_THRESHOLD,
  PHYSICS_BAUMGARTE,
  PHYSICS_CONTACT_SLOP,
  PHYSICS_MAX_POSITION_CORRECTION,
  PHYSICS_MAX_CORRECTION_VELOCITY,
  PHYSICS_MAX_LAYERS,
  PHYSICS_DEFAULT_LAYER_MASK,
  PHYSICS_ERROR_CODES,
} from "./version.js";

/* Runtime component written by `syncScene` (07 §3.7). */
export { PreviousTransform } from "./components.js";

/* Errors carry only the four contract codes (07 §5.16). */
export { PhysicsEngineError, physicsError } from "./rapier/errors.js";

/* Rapier adapter (A15). */
export {
  initRapierPhysics,
  isRapierReady,
  RAPIER_VERSION,
} from "./rapier/load.js";
export {
  RapierPhysics3D,
  RapierPhysicsStats,
  createRapierAdapter,
  createRapierWorld,
} from "./rapier/RapierPhysics3D.js";
export type {
  ColliderFilterInfo,
  RapierWorldOptions,
} from "./rapier/RapierPhysics3D.js";

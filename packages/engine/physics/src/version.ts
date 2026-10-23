/**
 * Public runtime constants for `@lanpad/engine-physics`.
 *
 * The matching declarations live in `src/contracts/physics3d.d.ts`; the
 * values here are the single runtime source of truth and must agree with
 * them. Every value is a rule stated by spec 07; none is a measurement.
 */
import type { Vec3 } from "@lanpad/engine-core";
import type { SleepConfig, SolverConfig } from "./contracts/physics3d.js";

/** W0 contract version; additive changes only. */
export const PHYSICS_CONTRACT_VERSION = 1 as const;

/** 07 §4.1, §5.11. The engine fixed step; the world has no accumulator. */
export const PHYSICS_FIXED_DT = 1 / 60;

/** 07 §3.2. Default world gravity. */
export const PHYSICS_DEFAULT_GRAVITY: Readonly<Vec3> = Object.freeze({
  x: 0,
  y: -9.81,
  z: 0,
});

/** 07 §3.2. Default solver configuration; part of the replay metadata. */
export const PHYSICS_DEFAULT_SOLVER: Readonly<SolverConfig> =
  Object.freeze<SolverConfig>({
    velocityIterations: 8,
    positionIterations: 3,
    warmStarting: true,
    substeps: 1,
  });

/** 07 §3.2, §5.12. Default sleep thresholds. */
export const PHYSICS_DEFAULT_SLEEP: Readonly<SleepConfig> =
  Object.freeze<SleepConfig>({
    linearThreshold: 0.05,
    angularThreshold: 0.1,
    timeToSleep: 0.5,
  });

/** 07 §3.1. Default collider friction. */
export const PHYSICS_DEFAULT_FRICTION = 0.6;

/** 07 §3.1. Default collider restitution. */
export const PHYSICS_DEFAULT_RESTITUTION = 0;

/** 07 §3.1. Default collider density, kg/m^3. */
export const PHYSICS_DEFAULT_DENSITY = 1000;

/** 07 §3.1. Default dynamic body angular damping. */
export const PHYSICS_DEFAULT_ANGULAR_DAMPING = 0.05;

/** 07 §4.4. Recommended dynamic-body cap. */
export const PHYSICS_MAX_DYNAMIC_BODIES = 4096;

/** 07 §4.4. Hard dynamic-body cap; beyond it `createBody` drops. */
export const PHYSICS_HARD_MAX_DYNAMIC_BODIES = 16384;

/** 07 §4.4. Recommended collider cap. */
export const PHYSICS_MAX_COLLIDERS = 16384;

/** 07 §4.4. Hard collider cap; beyond it `createCollider` drops. */
export const PHYSICS_HARD_MAX_COLLIDERS = 65536;

/** 07 §4.4. Colliders per body. */
export const PHYSICS_MAX_COLLIDERS_PER_BODY = 32;

/** 07 §4.4. Trimesh triangles per collider. */
export const PHYSICS_MAX_TRIMESH_TRIANGLES = 500000;

/** 07 §4.4. Joints per world. */
export const PHYSICS_MAX_JOINTS = 8192;

/** 07 §4.4. Wheels per vehicle. */
export const PHYSICS_MAX_WHEELS = 4;

/** 07 §4.4, §5.5. Contact points per manifold. */
export const PHYSICS_MAX_CONTACT_POINTS = 4;

/** 07 §4.4. Contact events per step; excess increments `droppedEvents`. */
export const PHYSICS_MAX_CONTACT_EVENTS = 1024;

/** 07 §4.4. Scratch memory per world (32 MiB). */
export const PHYSICS_SCRATCH_MEMORY_BYTES = 33554432;

/** 07 §4.2. Bodies per authored scene block. */
export const PHYSICS_MAX_SCENE_BODIES = 1024;

/** 07 §4.2. Colliders per authored scene block. */
export const PHYSICS_MAX_SCENE_COLLIDERS = 4096;

/** 07 §4.1. Hard linear-speed clamp, m/s. */
export const PHYSICS_MAX_LINEAR_SPEED = 500;

/** 07 §4.1. Hard angular-speed clamp, rad/s. */
export const PHYSICS_MAX_ANGULAR_SPEED = 100;

/** 07 §4.1, §5.17. Supported range from the origin before a rebase, metres. */
export const PHYSICS_POSITION_RANGE = 20000;

/** 07 §5.3. CCD applies above this speed, m/s. */
export const PHYSICS_CCD_SPEED_THRESHOLD = 5;

/** 07 §5.3. CCD sweeps per body per step. */
export const PHYSICS_MAX_CCD_SWEEPS = 4;

/** 07 §5.12. Sleep linear threshold, m/s. */
export const PHYSICS_SLEEP_LINEAR_THRESHOLD = 0.05;

/** 07 §5.12. Sleep angular threshold, rad/s. */
export const PHYSICS_SLEEP_ANGULAR_THRESHOLD = 0.1;

/** 07 §5.12. Time below both thresholds before an island sleeps, seconds. */
export const PHYSICS_SLEEP_TIME_TO_SLEEP = 0.5;

/** 07 §5.6. No restitution below this approach speed, m/s. */
export const PHYSICS_RESTITUTION_VELOCITY_THRESHOLD = 1;

/** 07 §5.6. Baumgarte bias factor for position correction. */
export const PHYSICS_BAUMGARTE = 0.2;

/** 07 §5.6. Allowed penetration before correction, metres. */
export const PHYSICS_CONTACT_SLOP = 0.005;

/** 07 §5.3, §5.6. Maximum position correction per step, metres. */
export const PHYSICS_MAX_POSITION_CORRECTION = 0.2;

/** 07 §5.6. Maximum correction velocity per iteration, m/s. */
export const PHYSICS_MAX_CORRECTION_VELOCITY = 0.2;

/** 07 §3.1. Named-layer indices 0..31. */
export const PHYSICS_MAX_LAYERS = 32;

/** 07 §3.1. Default accepted-layer mask, all 32 bits. */
export const PHYSICS_DEFAULT_LAYER_MASK = 0xffffffff;

/** 07 §5.16. The four core codes this layer may surface. */
export const PHYSICS_ERROR_CODES: readonly [
  "E_CONTRACT",
  "E_STALE_HANDLE",
  "E_ASSET_FORMAT",
  "E_UNSUPPORTED_FEATURE",
] = [
  "E_CONTRACT",
  "E_STALE_HANDLE",
  "E_ASSET_FORMAT",
  "E_UNSUPPORTED_FEATURE",
];

/**
 * 3D physics contract (spec 07, `docs/engine/07-physics3d.md`; amendment A15).
 *
 * Declaration only. This wave ships no solver, no Rapier import, no WASM and
 * no simulation code. The backend lands behind these declarations in a later
 * wave without widening the frozen surface.
 *
 * Shared math, scene and error types come from `@lanpad/engine-core` and are
 * never redeclared here. `Vec3`/`Quat` are the engine's right-handed, +Y-up,
 * −Z-forward types from spec 02; physics adds no second convention.
 *
 * Naming reconciliation for W0:
 * - 07 §3.2 declares the game-facing `PhysicsWorld` class with `step(): void`.
 * - A15 names the backend-neutral `Physics3D` interface. This contract makes
 *   `Physics3D` the explicit-dt adapter world (`step(dt)`) and keeps
 *   `PhysicsWorld` as the 07 fixed-step facade (`step()`). Both expose the
 *   same operations through `Physics3DOperations`.
 */
import type {
  EngineError,
  EngineErrorCode,
  Entity,
  Quat,
  Scene,
  Transform,
  Vec3,
} from "@lanpad/engine-core";

/* -------------------------------------------------------------------------
 * 1. Handles and descriptors (07 §3.1)
 * ---------------------------------------------------------------------- */

/** Opaque generational handle. */
export interface PhysicsHandle {
  readonly index: number;
  readonly generation: number;
}

export type BodyHandle = PhysicsHandle & { readonly __kind: "body" };
export type ColliderHandle = PhysicsHandle & { readonly __kind: "collider" };
export type JointHandle = PhysicsHandle & { readonly __kind: "joint" };
export type VehicleHandle = PhysicsHandle & { readonly __kind: "vehicle" };

export type BodyType =
  | "static"
  | "dynamic"
  | "kinematicPosition"
  | "kinematicVelocity";

/** Body descriptor from 07 §3.1. */
export interface BodyDesc {
  readonly type: BodyType;
  /** Default { x: 0, y: 0, z: 0 }. */
  readonly position?: Vec3;
  /** Default identity; normalized on create. */
  readonly rotation?: Quat;
  /** Default zero; rejected on a static body. */
  readonly linearVelocity?: Vec3;
  /** Default zero; rejected on a static body. */
  readonly angularVelocity?: Vec3;
  /** Kilograms; dynamic only. 0/undefined derives from colliders. */
  readonly mass?: number;
  /** 0..1; default 0. */
  readonly linearDamping?: number;
  /** 0..1; default 0.05. */
  readonly angularDamping?: number;
  /** Default 1. */
  readonly gravityScale?: number;
  /** Default false; see 07 §5.5. */
  readonly ccd?: boolean;
  /** Default true. */
  readonly canSleep?: boolean;
  /** Default true. Disabled bodies do not step or collide. */
  readonly enabled?: boolean;
  /** Opaque u32 tag for the game. */
  readonly userData?: number;
}

/**
 * Brief name for the same descriptor. 07 §3.1 calls it `BodyDesc`; both names
 * compile against one shape, so no parallel descriptor can drift.
 */
export type RigidBodyDesc = BodyDesc;

/**
 * A box is an OBB; an AABB is the same shape on an unrotated body. There is
 * deliberately no separate "aabb" kind (07 §3.1).
 */
export type ShapeDesc =
  | { readonly kind: "sphere"; readonly radius: number }
  | { readonly kind: "box"; readonly halfExtents: Vec3 }
  | {
      readonly kind: "capsule";
      readonly radius: number;
      readonly halfHeight: number;
    }
  | {
      readonly kind: "trimesh";
      /** World-local, 3 floats per vertex. */
      readonly vertices: Float32Array;
      /** Triangle list, 3 indices per triangle. */
      readonly indices: Uint32Array;
      /** `indices.length / 3`, validated on create. */
      readonly triangleCount: number;
    };

export interface ColliderDesc {
  readonly shape: ShapeDesc;
  /** 0..2; default 0.6. */
  readonly friction?: number;
  /** 0..1; default 0. */
  readonly restitution?: number;
  /** kg/m^3; default 1000. Ignored when body mass is set. */
  readonly density?: number;
  /** Default false; triggers events, no contact response. */
  readonly sensor?: boolean;
  /** Named-layer index 0..31; default 0. */
  readonly layer?: number;
  /** u32 accepted layers; default 0xffffffff. */
  readonly mask?: number;
  /** Default zero. */
  readonly localPosition?: Vec3;
  /** Default identity. */
  readonly localRotation?: Quat;
}

/* -------------------------------------------------------------------------
 * 2. World configuration and stats (07 §3.2)
 * ---------------------------------------------------------------------- */

export interface SolverConfig {
  /** 1..16; default 8. */
  readonly velocityIterations: number;
  /** 0..8; default 3. */
  readonly positionIterations: number;
  /** Default true. */
  readonly warmStarting: boolean;
  /** Default 1; part of the replay configuration. */
  readonly substeps: 1 | 2;
}

export interface SleepConfig {
  /** m/s; default 0.05. */
  readonly linearThreshold: number;
  /** rad/s; default 0.1. */
  readonly angularThreshold: number;
  /** Seconds; default 0.5. */
  readonly timeToSleep: number;
}

export interface PhysicsWorldOptions {
  /** Default { x: 0, y: -9.81, z: 0 }. */
  readonly gravity?: Vec3;
  /** Default 1/60; must be the engine DT. */
  readonly fixedDt?: number;
  readonly solver?: Partial<SolverConfig>;
  readonly sleep?: Partial<SleepConfig>;
  /** Names for bits 0..31; default ["default"]. */
  readonly layers?: readonly string[];
  /** Default 4096, hard cap 16384. */
  readonly maxDynamicBodies?: number;
  /** Default 16384, hard cap 65536. */
  readonly maxColliders?: number;
}

export interface PhysicsStats {
  readonly bodyCount: number;
  readonly colliderCount: number;
  readonly awakeBodyCount: number;
  readonly pairCount: number;
  readonly contactCount: number;
  /** Last step, measured; debug only. */
  readonly stepMs: number;
  readonly broadphaseMs: number;
  readonly narrowphaseMs: number;
  readonly solverMs: number;
  readonly droppedEvents: number;
  readonly ccdSweeps: number;
}

/**
 * Fixed-step state required for replay (07 §5.11). `tick` starts at 0 and
 * increments exactly once per `step`; it is not a wall-clock timestamp.
 */
export interface PhysicsFixedStepState {
  readonly fixedDt: number;
  readonly tick: number;
}

/* -------------------------------------------------------------------------
 * 3. Body and collider state (07 §3.2)
 * ---------------------------------------------------------------------- */

export interface BodyState {
  position: Vec3;
  rotation: Quat;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
  sleeping: boolean;
  enabled: boolean;
  mass: number;
  userData: number;
}

export interface ColliderState {
  body: BodyHandle;
  friction: number;
  restitution: number;
  sensor: boolean;
  layer: number;
  mask: number;
  /** World-space AABB, for debugging and broadphase inspection. */
  worldAabbMin: Vec3;
  worldAabbMax: Vec3;
}

/* -------------------------------------------------------------------------
 * 4. Joints (07 §3.3)
 * ---------------------------------------------------------------------- */

export type JointKind = "fixed" | "ball" | "hinge" | "slider" | "distance";

export interface JointLimit {
  /** Radians for a hinge, metres for slider/distance. */
  readonly lower: number;
  readonly upper: number;
  /** Default 0 (hard limit). */
  readonly stiffness?: number;
  /** Default 0. */
  readonly damping?: number;
}

export interface JointMotor {
  /** rad/s for a hinge, m/s for a slider. */
  readonly targetVelocity: number;
  /** >= 0. */
  readonly maxForce: number;
  /** When set, a position servo instead of a velocity motor. */
  readonly targetPosition?: number;
  /** Servo stiffness; default 0. */
  readonly stiffness?: number;
  /** Servo damping; default 0. */
  readonly damping?: number;
}

export type JointDesc =
  | {
      readonly kind: "fixed";
      readonly bodyA: BodyHandle;
      readonly bodyB: BodyHandle;
      readonly anchorA?: Vec3;
      readonly anchorB?: Vec3;
      readonly rotationA?: Quat;
      readonly rotationB?: Quat;
      /** Default false. */
      readonly collideConnected?: boolean;
    }
  | {
      readonly kind: "ball";
      readonly bodyA: BodyHandle;
      readonly bodyB: BodyHandle;
      readonly anchorA?: Vec3;
      readonly anchorB?: Vec3;
      /** Default false. */
      readonly collideConnected?: boolean;
    }
  | {
      readonly kind: "hinge";
      readonly bodyA: BodyHandle;
      readonly bodyB: BodyHandle;
      readonly anchorA?: Vec3;
      readonly anchorB?: Vec3;
      readonly axisA: Vec3;
      readonly axisB: Vec3;
      readonly limit?: JointLimit;
      readonly motor?: JointMotor;
      /** Default false. */
      readonly collideConnected?: boolean;
    }
  | {
      readonly kind: "slider";
      readonly bodyA: BodyHandle;
      readonly bodyB: BodyHandle;
      readonly anchorA?: Vec3;
      readonly anchorB?: Vec3;
      readonly axisA: Vec3;
      readonly axisB: Vec3;
      readonly limit?: JointLimit;
      readonly motor?: JointMotor;
      /** Default false. */
      readonly collideConnected?: boolean;
    }
  | {
      readonly kind: "distance";
      readonly bodyA: BodyHandle;
      readonly bodyB: BodyHandle;
      readonly anchorA?: Vec3;
      readonly anchorB?: Vec3;
      /** Metres, >= 0. */
      readonly length: number;
      /** 0 = rigid distance, > 0 = spring. */
      readonly stiffness?: number;
      /** Spring damping. */
      readonly damping?: number;
      /** Default false. */
      readonly collideConnected?: boolean;
    };

export interface JointState {
  /** Constraint-space error; kind-specific units. */
  error: number;
  /** Last applied motor impulse, for tuning only. */
  motorImpulse: number;
  /** True while the joint's bodies are asleep. */
  sleeping: boolean;
}

/* -------------------------------------------------------------------------
 * 5. Queries (07 §3.4)
 * ---------------------------------------------------------------------- */

export interface QueryFilter {
  /** Query layer index; default 0. */
  readonly layer?: number;
  /** u32 accepted collider layers; default 0xffffffff. */
  readonly mask?: number;
  /** Default false. */
  readonly includeSensors?: boolean;
  readonly excludeBody?: BodyHandle;
  readonly excludeCollider?: ColliderHandle;
}

export interface RaycastInput {
  readonly origin: Vec3;
  /** Need not be normalized; normalized internally. */
  readonly direction: Vec3;
  /** Metres, > 0. */
  readonly maxDistance: number;
  readonly filter?: QueryFilter;
  /** A ray starting inside a shape reports distance 0; default true. */
  readonly solid?: boolean;
}

export interface RaycastHit {
  collider: ColliderHandle;
  body: BodyHandle;
  /** Metres from origin. */
  distance: number;
  /** World space. */
  point: Vec3;
  /** World space, unit, pointing against the ray. */
  normal: Vec3;
  /** -1 for spheres, boxes and capsules. */
  triangleIndex: number;
  sensor: boolean;
}

export interface ShapeCastHit extends RaycastHit {
  /** Distance travelled along the input direction before first contact. */
  travel: number;
}

/* -------------------------------------------------------------------------
 * 6. Character controller (07 §3.5)
 * ---------------------------------------------------------------------- */

export interface CharacterControllerDesc {
  /** > 0. */
  readonly radius: number;
  /** > 0; capsule total height = 2 * (halfHeight + radius). */
  readonly halfHeight: number;
  readonly position: Vec3;
  readonly rotation?: Quat;
  /** 0..89; default 45. */
  readonly slopeLimitDegrees?: number;
  /** Metres; default 0.3. */
  readonly stepOffset?: number;
  /** Metres; default 0.1. */
  readonly snapToGround?: number;
  /** m/s^2 downward; default 9.81. */
  readonly gravity?: number;
  /** Kilograms; default 70. */
  readonly mass?: number;
  /** Max push impulse per tick; default 0. */
  readonly pushForce?: number;
  readonly filter?: QueryFilter;
}

export interface CharacterMoveResult {
  /** Actual displacement this call. */
  moved: Vec3;
  grounded: boolean;
  groundNormal: Vec3;
  hitCeiling: boolean;
  hitWall: boolean;
  /** 0..4. */
  slidCount: number;
}

/**
 * 07 §3.5 declares this as a class. The contract declares its instance
 * surface; the implementation supplies the class and owns the kinematic
 * capsule body.
 */
export interface CharacterController {
  readonly body: BodyHandle;
  move(desiredTranslation: Vec3, dt: number): CharacterMoveResult;
  teleport(position: Vec3, rotation?: Quat): void;
  isGrounded(): boolean;
  setEnabled(enabled: boolean): void;
}

/* -------------------------------------------------------------------------
 * 7. Vehicles (07 §3.6)
 * ---------------------------------------------------------------------- */

export interface VehicleInput {
  /** -1..1, forward positive. */
  readonly throttle: number;
  /** -1..1, right positive. */
  readonly steering: number;
  /** 0..1. */
  readonly brake: number;
  /** 0..1; default 0. */
  readonly handbrake?: number;
}

export interface WheelDesc {
  /** Attachment point in chassis space. */
  readonly localPosition: Vec3;
  /** > 0. */
  readonly radius: number;
  /** > 0. */
  readonly width: number;
  /** > 0. */
  readonly suspensionRestLength: number;
  /** N/m, > 0. */
  readonly suspensionStiffness: number;
  /** N*s/m, > 0. */
  readonly suspensionDamping: number;
  /** Metres, > 0. */
  readonly maxTravel: number;
  readonly steerable: boolean;
  readonly driven: boolean;
  /** 0..2, tyre friction coefficient. */
  readonly friction: number;
}

export interface VehicleDesc {
  /** Dynamic body with at least one box collider. */
  readonly chassis: BodyHandle;
  /** 2 or 4 wheels; order FL, FR, RL, RR when four. */
  readonly wheels: readonly WheelDesc[];
  /** N at the contact patch, > 0. */
  readonly engineForce: number;
  /** N, > 0. */
  readonly reverseForce: number;
  /** N, > 0. */
  readonly brakeForce: number;
  /** 5..60; default 35. */
  readonly maxSteerDegrees: number;
  /** > 0; default 180. */
  readonly steerRateDegreesPerSecond: number;
  /** m/s, > 0. */
  readonly topSpeed: number;
  /** N per (m/s)^2; default 0. */
  readonly downforce?: number;
}

export interface WheelState {
  contact: boolean;
  /** World space; valid when contact. */
  contactPoint: Vec3;
  contactNormal: Vec3;
  /** Current suspension length, metres. */
  suspensionLength: number;
  /** Radians, accumulated for rendering. */
  rotation: number;
  /** Radians. */
  steerAngle: number;
  slipRatio: number;
  slipAngle: number;
  normalForce: number;
  longitudinalForce: number;
  lateralForce: number;
}

export interface VehicleState {
  wheelCount: number;
  /** Chassis forward speed, m/s. */
  speed: number;
  /** Chassis forward axis in world space, local −Z per 02. */
  forward: Vec3;
  /** Fixed array, reused. */
  wheels: readonly WheelState[];
}

/**
 * 07 §3.6 models a vehicle as a `VehicleHandle` plus world-level hooks
 * (`createVehicle`, `setVehicleInput`, `readVehicle`, `destroyVehicle`).
 * This alias keeps the brief's name without inventing a second API path.
 */
export type VehicleController = VehicleHandle;

/* -------------------------------------------------------------------------
 * 8. Scene integration (07 §3.7)
 * ---------------------------------------------------------------------- */

export interface RigidBodyRef {
  readonly body: BodyHandle;
}

/**
 * Additive component required from spec 03 (07 §3.7, §9). Physics writes it
 * in `syncScene`; the renderer interpolates between it and `Transform`.
 */
export interface PreviousTransform {
  position: Vec3;
  rotation: Quat;
}

/* -------------------------------------------------------------------------
 * 9. Events (07 §3.2, §5.5)
 * ---------------------------------------------------------------------- */

/**
 * 07 §3.2 names `ContactEvent` but defines no fields. This is the minimum
 * structural shape its rules require: the collider/body pair. A later spec
 * amendment may add contact point, normal or impulse fields additively.
 */
export interface ContactEvent {
  readonly colliderA: ColliderHandle;
  readonly colliderB: ColliderHandle;
  readonly bodyA: BodyHandle;
  readonly bodyB: BodyHandle;
}

/**
 * 07 §3.2 names `TriggerEvent` and §5.5 requires enter/exit once per pair
 * transition. The minimum shape is pair identity plus the transition.
 */
export interface TriggerEvent extends ContactEvent {
  readonly phase: "enter" | "exit";
}

/* -------------------------------------------------------------------------
 * 10. World operations shared by the adapter and facade (07 §3.2)
 * ---------------------------------------------------------------------- */

/** All world operations except the fixed-step entry point and its state. */
export interface Physics3DOperations {
  readonly stats: PhysicsStats;

  /* Bodies and colliders */
  createBody(desc: BodyDesc): BodyHandle;
  destroyBody(handle: BodyHandle): void;
  createCollider(body: BodyHandle, desc: ColliderDesc): ColliderHandle;
  destroyCollider(handle: ColliderHandle): void;
  setEnabled(body: BodyHandle, enabled: boolean): void;

  /* State; reads copy into caller-owned objects */
  readBody(handle: BodyHandle, out: BodyState): boolean;
  readCollider(handle: ColliderHandle, out: ColliderState): boolean;
  setTransform(body: BodyHandle, position: Vec3, rotation: Quat): void;
  setLinearVelocity(body: BodyHandle, velocity: Vec3): void;
  setAngularVelocity(body: BodyHandle, velocity: Vec3): void;
  applyForce(body: BodyHandle, force: Vec3, wake?: boolean): void;
  applyImpulse(body: BodyHandle, impulse: Vec3, wake?: boolean): void;
  applyTorqueImpulse(body: BodyHandle, impulse: Vec3): void;
  /** Clears accumulated force and torque without stepping. */
  clearForces(body: BodyHandle): void;

  /* Joints */
  createJoint(desc: JointDesc): JointHandle;
  destroyJoint(handle: JointHandle): void;
  setJointMotor(handle: JointHandle, motor: JointMotor | null): void;
  readJoint(handle: JointHandle, out: JointState): boolean;

  /* Vehicles and characters */
  createVehicle(desc: VehicleDesc): VehicleHandle;
  destroyVehicle(handle: VehicleHandle): void;
  setVehicleInput(handle: VehicleHandle, input: VehicleInput): void;
  readVehicle(handle: VehicleHandle, out: VehicleState): boolean;
  createCharacter(desc: CharacterControllerDesc): CharacterController;
  destroyCharacter(controller: CharacterController): void;

  /* Queries */
  raycast(input: RaycastInput, out: RaycastHit): boolean;
  raycastAll(input: RaycastInput, out: RaycastHit[]): number;
  sphereCast(radius: number, input: RaycastInput, out: ShapeCastHit): boolean;
  overlapSphere(
    center: Vec3,
    radius: number,
    query: QueryFilter,
    out: ColliderHandle[],
  ): number;
  overlapBox(
    center: Vec3,
    halfExtents: Vec3,
    rotation: Quat,
    query: QueryFilter,
    out: ColliderHandle[],
  ): number;
  pointQuery(
    point: Vec3,
    query: QueryFilter,
    out: ColliderHandle[],
  ): number;

  /* Scene integration */
  bindTransform(entity: Entity, body: BodyHandle): void;
  unbindTransform(entity: Entity): void;
  /** Writes Transform plus PreviousTransform for every bound entity. */
  syncScene(scene: Scene): void;
  /** Interpolated pose for a camera or attachment; alpha in [0, 1]. */
  sampleTransform(body: BodyHandle, alpha: number, out: Transform): boolean;

  /* Events, drained after step() */
  drainContactEvents(out: ContactEvent[]): number;
  drainTriggerEvents(out: TriggerEvent[]): number;

  /* Determinism and large worlds */
  /** FNV-1a 32 over the canonical stream in 07 §4.3. */
  stateHash(): number;
  /** Between steps only. */
  rebaseOrigin(newOrigin: Vec3): void;

  reset(): void;
  /** Idempotent. */
  dispose(): void;
}

/**
 * Adapter-facing world contract (A15). `step(dt)` is explicit so a backend
 * (custom or Rapier) can be driven by the fixed-step facade. `dt` must be
 * the configured `fixedDt`; no wall-clock delta may enter.
 */
export interface Physics3D
  extends Physics3DOperations,
    PhysicsFixedStepState {
  step(dt: number): void;
}

/**
 * Game-facing world contract from 07 §3.2. It is a facade over a
 * `Physics3D`; `step()` uses `fixedDt` exactly and takes no wall-clock time.
 */
export interface PhysicsWorld
  extends Physics3DOperations,
    PhysicsFixedStepState {
  step(): void;
}

/* -------------------------------------------------------------------------
 * 11. Backend and adapter boundary (A15)
 * ---------------------------------------------------------------------- */

/** A15 permits exactly the custom solver or Rapier behind the contract. */
export type PhysicsBackendKind = "custom" | "rapier";

/**
 * Implementation seam. A backend is a `Physics3D` plus its identity. Rapier
 * lives in its own package/adapter and is loaded there; this contract
 * imports no WASM and no Rapier type.
 */
export interface PhysicsBackend extends Physics3D {
  readonly backend: PhysicsBackendKind;
}

/**
 * Creates a backend. Adapter boot (WASM compilation/initialization for a
 * Rapier adapter) is adapter-owned and happens before `create`; this
 * signature stays synchronous and backend-neutral.
 */
export interface PhysicsAdapter {
  readonly backend: PhysicsBackendKind;
  create(options?: PhysicsWorldOptions): PhysicsBackend;
}

/* -------------------------------------------------------------------------
 * 12. Determinism / replay fields (07 §4.3, §5.11)
 * ---------------------------------------------------------------------- */

/**
 * The metadata a determinism fixture records. `seed` is recorded but unused:
 * 07 §5.11 states physics has no RNG, so the world never reads it. A changed
 * solver configuration or substep count must change the state hash.
 */
export interface PhysicsReplayConfig {
  readonly fixedDt: number;
  readonly ticks: number;
  readonly solver: SolverConfig;
  /** Repeated from `solver.substeps` because 07 §5.11 records it separately. */
  readonly substeps: 1 | 2;
  /** Recorded, never consumed by the physics world. */
  readonly seed?: number;
  /** FNV-1a 32 from 07 §4.3; absent until a fixture records a run. */
  readonly expectedStateHash?: number;
}

/* -------------------------------------------------------------------------
 * 13. Errors (07 §5.16) — core codes only, no parallel namespace
 * ---------------------------------------------------------------------- */

/**
 * 07 §5.16 names exactly these core codes. It defines no additive
 * `E_PHYSICS_*` code, so this is a narrow view of `EngineErrorCode`, not a
 * new union member set. Adding an `E_PHYSICS_*` code would require a core
 * amendment first.
 */
export type PhysicsErrorCode = Extract<
  EngineErrorCode,
  | "E_CONTRACT"
  | "E_STALE_HANDLE"
  | "E_ASSET_FORMAT"
  | "E_UNSUPPORTED_FEATURE"
>;

export interface PhysicsError extends Omit<EngineError, "code" | "layer"> {
  readonly code: PhysicsErrorCode;
  readonly layer: "physics";
}

/* -------------------------------------------------------------------------
 * 14. Runtime constant declarations (values in `src/version.ts`)
 * ---------------------------------------------------------------------- */

/** W0 contract version; additive changes only. */
export const PHYSICS_CONTRACT_VERSION: 1;

/** 07 §4.1, §5.11. The engine fixed step; the world has no accumulator. */
export const PHYSICS_FIXED_DT: number;

/** 07 §3.2. Default world gravity. */
export const PHYSICS_DEFAULT_GRAVITY: Readonly<Vec3>;

/** 07 §3.2. Default solver configuration. */
export const PHYSICS_DEFAULT_SOLVER: Readonly<SolverConfig>;

/** 07 §3.2. Default sleep configuration. */
export const PHYSICS_DEFAULT_SLEEP: Readonly<SleepConfig>;

/** 07 §3.1. Default collider material values. */
export const PHYSICS_DEFAULT_FRICTION: number;
export const PHYSICS_DEFAULT_RESTITUTION: number;
export const PHYSICS_DEFAULT_DENSITY: number;

/** 07 §3.1. Dynamic body default angular damping. */
export const PHYSICS_DEFAULT_ANGULAR_DAMPING: number;

/** 07 §4.4. Recommended and hard body/collider caps. */
export const PHYSICS_MAX_DYNAMIC_BODIES: number;
export const PHYSICS_HARD_MAX_DYNAMIC_BODIES: number;
export const PHYSICS_MAX_COLLIDERS: number;
export const PHYSICS_HARD_MAX_COLLIDERS: number;
export const PHYSICS_MAX_COLLIDERS_PER_BODY: number;
export const PHYSICS_MAX_TRIMESH_TRIANGLES: number;
export const PHYSICS_MAX_JOINTS: number;
export const PHYSICS_MAX_WHEELS: number;
export const PHYSICS_MAX_CONTACT_POINTS: number;
export const PHYSICS_MAX_CONTACT_EVENTS: number;
export const PHYSICS_SCRATCH_MEMORY_BYTES: number;

/** 07 §4.2. Per-scene-block authoring caps. */
export const PHYSICS_MAX_SCENE_BODIES: number;
export const PHYSICS_MAX_SCENE_COLLIDERS: number;

/** 07 §4.1. Speed clamps and supported world range. */
export const PHYSICS_MAX_LINEAR_SPEED: number;
export const PHYSICS_MAX_ANGULAR_SPEED: number;
export const PHYSICS_POSITION_RANGE: number;

/** 07 §5.3, §5.12. CCD and sleep thresholds. */
export const PHYSICS_CCD_SPEED_THRESHOLD: number;
export const PHYSICS_MAX_CCD_SWEEPS: number;
export const PHYSICS_SLEEP_LINEAR_THRESHOLD: number;
export const PHYSICS_SLEEP_ANGULAR_THRESHOLD: number;
export const PHYSICS_SLEEP_TIME_TO_SLEEP: number;

/** 07 §5.6. Restitution and position-correction constants. */
export const PHYSICS_RESTITUTION_VELOCITY_THRESHOLD: number;
export const PHYSICS_BAUMGARTE: number;
export const PHYSICS_CONTACT_SLOP: number;
export const PHYSICS_MAX_POSITION_CORRECTION: number;
export const PHYSICS_MAX_CORRECTION_VELOCITY: number;

/** 07 §3.1, §5.9. Layer count and full u32 mask. */
export const PHYSICS_MAX_LAYERS: number;
export const PHYSICS_DEFAULT_LAYER_MASK: number;

/** 07 §5.16. The four core codes this layer may surface. */
export const PHYSICS_ERROR_CODES: readonly [
  "E_CONTRACT",
  "E_STALE_HANDLE",
  "E_ASSET_FORMAT",
  "E_UNSUPPORTED_FEATURE",
];

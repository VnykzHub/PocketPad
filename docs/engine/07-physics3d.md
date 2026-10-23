# 07 — 3D Physics

**Status:** target contract for the M1 3D physics subsystem. No 3D physics code exists in this tree. The only physics code today is the 2D circle/AABB solver at `packages/runtime/src/physics/`, which migrates unchanged into `packages/engine/physics/src/two-d/` at M0 (00 §5.13). This document is the interface to implement against; it is not a claim of implementation.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product/protocol contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) for the programme rules, [`00-architecture.md`](00-architecture.md) for package boundaries and frozen contracts. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded in [`docs/todos/README.md`](../todos/README.md).
**Package:** `@lanpad/engine-physics`, package root `packages/engine/physics/` (00 §5.3 and §6). This spec owns that directory and its tests. It does not create `packages/physics/`.
**Milestone:** M0 ships only the 2D migration (§5.15). Every 3D item in this spec is M1.

---

## 1. Goal

Give PocketPad games a **deterministic, fixed-step, allocation-free 3D rigid-body simulation** that is good enough for the M1 vertical slice (a city block, a drivable car, a walking character, props, pedestrians) and shaped so the M3 open-world target does not require replacing it.

The player-visible outcome:

- a car can be driven with phone or gamepad input: it accelerates, steers, brakes, takes kerbs and does not tunnel through walls at speed;
- a character walks up steps and slopes, slides along walls, lands from a jump and cannot pass through geometry;
- crates, barrels and debris stack, topple, roll and come to rest instead of jittering forever;
- thrown or launched objects do not pass through thin static geometry;
- 1,000 dynamic bodies and 10,000 static colliders simulate at 60 Hz inside the frame budget, with a replay producing an identical state hash on the same build and browser.

The engineering outcome:

1. one public surface (`PhysicsWorld`) that games code against, so a future solver replacement is invisible;
2. fixed 60 Hz stepping with no wall clock, no `Math.random` and no iteration over hash-ordered containers inside the step;
3. no per-step heap allocation after warm-up (00 §5.10);
4. a measurable decision gate before any third-party physics engine is allowed in (the custom-vs-Rapier rule, §5.10).

**North-star constraint, not a promise.** The Vice City ceiling requires tens of thousands of static colliders, vehicle fleets, pedestrian crowds and a world larger than float32 precision can hold. This spec fixes the architecture for that ceiling (broadphase separation, level-of-detail bodies, origin rebasing) but measures only M1 numbers.

---

## 2. Non-goals

- **No soft body, cloth, fluid, destruction, fracture, or deformable terrain.** These are not M1 and not implied by this contract.
- **No ragdolls.** Spec 08 (animation) and this spec may add joint-driven ragdolls in M2; M1 has joints but no automatic ragdoll pipeline.
- **No general convex hull authoring or dynamic trimesh bodies.** Trimesh colliders are static or kinematic only. Dynamic concave bodies are authored as compounds of boxes/spheres/capsules.
- **No heightfield collider in M1.** Large ground is a trimesh or a compound of boxes. A heightfield shape is an M2 additive shape kind.
- **No networked physics.** State sync, prediction and reconciliation belong to spec 14. This spec guarantees local determinism only.
- **No GPU or worker-thread simulation.** The step runs on the main thread inside `simulate`. Workers may precompute mesh BVHs at load, never step bodies.
- **No cross-browser bit-identical simulation.** Same build, same browser, same input trace must replay identically; 00 §5.8 sets the scope. `Math.sin`/`Math.cos` last-bit differences between engines are accepted.
- **No editor, vehicle tuning UI or collider visual authoring.** Spec 17 owns those; this spec defines the data they write.
- **No third-party physics runtime in M0/M1** (Rapier, Ammo, Cannon, Jolt). The decision rule in §5.10 is the only path in.
- **No replacement of the frozen 2D API.** `CircleBody`, `Contact`, `resolveCircleAabb`, `resolveCircleCircle` and `integrate` keep their current semantics and signatures after the M0 move.
- **No automatic LOD physics in M1.** The hooks exist (sleep, disable, simplified proxy bodies) but automatic distance-based proxy switching is M2.

---

## 3. Public interfaces

All types are backend-neutral and use `engine-core` math (`Vec3`, `Quat`, `Transform`, `Entity`, `Scene`). Signatures are normative in shape. The surface is **frozen after the M1 release**; changes are additive only (new optional fields, new body/shape/joint kinds) or require an engine major plus an amendment.

### 3.1 Handles and descriptors

```ts
import type { Entity, Quat, Scene, Transform, Vec3 } from "@lanpad/engine-core";

/** Opaque generational handle. A stale handle is a counted no-op in production,
 *  and throws EngineError E_STALE_HANDLE in dev (?debug=1). */
export interface PhysicsHandle {
  readonly index: number;
  readonly generation: number;
}
export type BodyHandle = PhysicsHandle & { readonly __kind: "body" };
export type ColliderHandle = PhysicsHandle & { readonly __kind: "collider" };
export type JointHandle = PhysicsHandle & { readonly __kind: "joint" };
export type VehicleHandle = PhysicsHandle & { readonly __kind: "vehicle" };

export type BodyType = "static" | "dynamic" | "kinematicPosition" | "kinematicVelocity";

export interface BodyDesc {
  readonly type: BodyType;
  readonly position?: Vec3;              // default { x: 0, y: 0, z: 0 }
  readonly rotation?: Quat;              // default identity, normalized on create
  readonly linearVelocity?: Vec3;        // default zero; rejected on static
  readonly angularVelocity?: Vec3;       // default zero; rejected on static
  readonly mass?: number;                // kg; dynamic only; 0/undefined = derive from colliders
  readonly linearDamping?: number;       // 0..1, default 0
  readonly angularDamping?: number;      // 0..1, default 0.05
  readonly gravityScale?: number;        // default 1
  readonly ccd?: boolean;                // default false; see §5.5
  readonly canSleep?: boolean;           // default true
  readonly enabled?: boolean;            // default true; disabled bodies do not step or collide
  readonly userData?: number;            // opaque u32 tag for the game
}

/** A box is an OBB; an AABB is the same shape with identity body rotation.
 *  There is deliberately no separate "aabb" kind: one box pair implementation
 *  serves both, and an AABB is authored as a box on an unrotated body. */
export type ShapeDesc =
  | { readonly kind: "sphere"; readonly radius: number }
  | { readonly kind: "box"; readonly halfExtents: Vec3 }
  | { readonly kind: "capsule"; readonly radius: number; readonly halfHeight: number }
  | {
      readonly kind: "trimesh";
      readonly vertices: Float32Array;   // world-local, 3 floats per vertex
      readonly indices: Uint32Array;     // triangle list, 3 indices per triangle
      readonly triangleCount: number;    // indices.length / 3, validated on create
    };

export interface ColliderDesc {
  readonly shape: ShapeDesc;
  readonly friction?: number;            // 0..2, default 0.6
  readonly restitution?: number;         // 0..1, default 0
  readonly density?: number;             // kg/m^3, default 1000; ignored when body mass is set
  readonly sensor?: boolean;             // default false; triggers events, no contact response
  readonly layer?: number;               // named-layer index 0..31, default 0
  readonly mask?: number;                // u32 accepted layers, default 0xffffffff
  readonly localPosition?: Vec3;         // default zero
  readonly localRotation?: Quat;         // default identity
}
```

Rules:

- `radius`, `halfHeight` are `> 0`; `halfExtents` components are `> 0`. Capsule axis is local **+Y** with the segment from `-halfHeight` to `+halfHeight`; total height is `2 * (halfHeight + radius)`.
- A trimesh collider is accepted only on a `static` or `kinematicPosition`/`kinematicVelocity` body. A dynamic trimesh is rejected at `createCollider` with `EngineError(E_ASSET_FORMAT)`.
- A body with no collider exists but collides with nothing. A dynamic body with colliders and `mass: 0` derives mass and inertia from collider density and volume.
- Compound bodies are multiple colliders on one body; there is no compound shape union.
- Colliders and bodies are created only outside the step; creating one during `step()` is a contract violation (`E_CONTRACT` in dev).

### 3.2 World

```ts
export interface SolverConfig {
  readonly velocityIterations: number;   // 1..16, default 8
  readonly positionIterations: number;   // 0..8, default 3
  readonly warmStarting: boolean;        // default true
  readonly substeps: 1 | 2;              // default 1; part of the replay configuration
}

export interface SleepConfig {
  readonly linearThreshold: number;      // m/s, default 0.05
  readonly angularThreshold: number;     // rad/s, default 0.1
  readonly timeToSleep: number;          // seconds, default 0.5
}

export interface PhysicsWorldOptions {
  readonly gravity?: Vec3;               // default { x: 0, y: -9.81, z: 0 }
  readonly fixedDt?: number;             // default 1/60; must be the engine DT
  readonly solver?: Partial<SolverConfig>;
  readonly sleep?: Partial<SleepConfig>;
  readonly layers?: readonly string[];   // names for bits 0..31, default ["default"]
  readonly maxDynamicBodies?: number;    // default 4096, hard cap 16384
  readonly maxColliders?: number;        // default 16384, hard cap 65536
}

export interface PhysicsStats {
  readonly bodyCount: number;
  readonly colliderCount: number;
  readonly awakeBodyCount: number;
  readonly pairCount: number;
  readonly contactCount: number;
  readonly stepMs: number;               // last step, measured, debug only
  readonly broadphaseMs: number;
  readonly narrowphaseMs: number;
  readonly solverMs: number;
  readonly droppedEvents: number;
  readonly ccdSweeps: number;
}

export class PhysicsWorld {
  constructor(options?: PhysicsWorldOptions);

  readonly fixedDt: number;
  readonly stats: PhysicsStats;

  // Bodies and colliders
  createBody(desc: BodyDesc): BodyHandle;
  destroyBody(handle: BodyHandle): void;
  createCollider(body: BodyHandle, desc: ColliderDesc): ColliderHandle;
  destroyCollider(handle: ColliderHandle): void;
  setEnabled(body: BodyHandle, enabled: boolean): void;

  // State. All reads copy into caller-owned objects; no allocation.
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

  // Joints
  createJoint(desc: JointDesc): JointHandle;
  destroyJoint(handle: JointHandle): void;
  setJointMotor(handle: JointHandle, motor: JointMotor | null): void;
  readJoint(handle: JointHandle, out: JointState): boolean;

  // Vehicles and characters
  createVehicle(desc: VehicleDesc): VehicleHandle;
  destroyVehicle(handle: VehicleHandle): void;
  setVehicleInput(handle: VehicleHandle, input: VehicleInput): void;
  readVehicle(handle: VehicleHandle, out: VehicleState): boolean;
  createCharacter(desc: CharacterControllerDesc): CharacterController;
  destroyCharacter(controller: CharacterController): void;

  // Queries
  raycast(input: RaycastInput, out: RaycastHit): boolean;
  raycastAll(input: RaycastInput, out: RaycastHit[]): number;
  sphereCast(radius: number, input: RaycastInput, out: ShapeCastHit): boolean;
  overlapSphere(center: Vec3, radius: number, query: QueryFilter, out: ColliderHandle[]): number;
  overlapBox(
    center: Vec3,
    halfExtents: Vec3,
    rotation: Quat,
    query: QueryFilter,
    out: ColliderHandle[],
  ): number;
  pointQuery(point: Vec3, query: QueryFilter, out: ColliderHandle[]): number;

  // Fixed step, exactly once per engine tick
  step(): void;

  // Scene integration
  bindTransform(entity: Entity, body: BodyHandle): void;
  unbindTransform(entity: Entity): void;
  /** Writes Transform plus PreviousTransform for every bound entity. Call after step(). */
  syncScene(scene: Scene): void;
  /** Interpolated pose for a camera or attachment; alpha in [0, 1]. */
  sampleTransform(body: BodyHandle, alpha: number, out: Transform): boolean;

  // Events, drained after step() by the game
  drainContactEvents(out: ContactEvent[]): number;
  drainTriggerEvents(out: TriggerEvent[]): number;

  // Determinism and large worlds
  /** FNV-1a 32 over the canonical body-state byte stream (§4.3). */
  stateHash(): number;
  /** Subtracts newOrigin from every body, collider and joint anchor. Between steps only. */
  rebaseOrigin(newOrigin: Vec3): void;

  reset(): void;
  dispose(): void;                       // idempotent
}
```

```ts
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
  /** World-space AABB, written for debugging and broadphase inspection. */
  worldAabbMin: Vec3;
  worldAabbMax: Vec3;
}
```

Step contract:

- `step()` uses `fixedDt` exactly. It is called once per engine tick, after input polling and before the game's render-independent logic that depends on new poses.
- The world does **not** read wall-clock time, timers, `Math.random`, DOM or network. Time enters only through the fixed `dt`.
- A second call in the same engine tick is a game bug; it is legal API-wise (the world cannot see ticks) but doubles simulated time and breaks replay expectations.
- `step()` performs the pipeline in §5.3 in the stated order. The order is part of the contract because determinism depends on it.

### 3.3 Joints

```ts
export type JointKind = "fixed" | "ball" | "hinge" | "slider" | "distance";

export interface JointLimit {
  readonly lower: number;                // radians for hinge, metres for slider/distance
  readonly upper: number;
  readonly stiffness?: number;           // default 0 (hard limit)
  readonly damping?: number;             // default 0
}

export interface JointMotor {
  readonly targetVelocity: number;       // rad/s for hinge, m/s for slider
  readonly maxForce: number;             // >= 0
  readonly targetPosition?: number;      // when set, a position servo instead of a velocity motor
  readonly stiffness?: number;           // servo stiffness, default 0
  readonly damping?: number;             // servo damping, default 0
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
      readonly collideConnected?: boolean; // default false
    }
  | {
      readonly kind: "ball";
      readonly bodyA: BodyHandle;
      readonly bodyB: BodyHandle;
      readonly anchorA?: Vec3;
      readonly anchorB?: Vec3;
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
      readonly collideConnected?: boolean;
    }
  | {
      readonly kind: "distance";
      readonly bodyA: BodyHandle;
      readonly bodyB: BodyHandle;
      readonly anchorA?: Vec3;
      readonly anchorB?: Vec3;
      readonly length: number;           // metres, >= 0
      readonly stiffness?: number;       // 0 = rigid distance, > 0 = spring
      readonly damping?: number;         // spring damping
      readonly collideConnected?: boolean;
    };

export interface JointState {
  /** Constraint-space error; interpretation is kind-specific (metres or radians). */
  error: number;
  /** Last applied motor impulse, for tuning only. */
  motorImpulse: number;
  /** True while the joint's bodies are asleep. */
  sleeping: boolean;
}
```

Rules:

- Anchors are in body-local space. A missing anchor is the body origin.
- Joints between two static bodies are rejected. A joint with a destroyed body is destroyed in the same step and counted.
- `collideConnected` defaults to **false**: connected bodies do not generate contacts with each other unless explicitly allowed.
- Hard limits use sequential impulses; soft limits (`stiffness > 0`) use a spring-damper force. Both are deterministic.

### 3.4 Queries

```ts
export interface QueryFilter {
  readonly layer?: number;               // query layer index, default 0
  readonly mask?: number;                // u32 accepted collider layers, default 0xffffffff
  readonly includeSensors?: boolean;     // default false
  readonly excludeBody?: BodyHandle;     // default none
  readonly excludeCollider?: ColliderHandle;
}

export interface RaycastInput {
  readonly origin: Vec3;
  readonly direction: Vec3;              // need not be normalized; normalized internally
  readonly maxDistance: number;          // metres, > 0
  readonly filter?: QueryFilter;
  /** When true, a ray starting inside a shape reports distance 0. Default true. */
  readonly solid?: boolean;
}

export interface RaycastHit {
  collider: ColliderHandle;
  body: BodyHandle;
  distance: number;                      // metres from origin
  point: Vec3;                           // world space
  normal: Vec3;                           // world space, unit, pointing against the ray
  triangleIndex: number;                 // -1 for spheres, boxes and capsules
  sensor: boolean;
}

export interface ShapeCastHit extends RaycastHit {
  /** Distance travelled along the input direction before first contact. */
  travel: number;
}
```

Rules:

- `raycast` writes the nearest hit into `out` and returns `true`; on a miss it leaves `out` untouched and returns `false`.
- `raycastAll` writes hits into caller slots, sorted by ascending distance, ties by ascending collider index; returns the count written. It never allocates. The caller preallocates the array; extra hits are dropped and counted in `stats`.
- `overlapSphere`, `overlapBox` and `pointQuery` fill caller slots; order is ascending collider index for determinism.
- Queries read the **current** world state. Called from `simulate`, they see the previous step's completed state; called after `step()`, they see the new state.
- Queries ignore disabled bodies, sleeping state has no effect on queries, and trimesh hits report `triangleIndex`.
- `sphereCast` is a swept-sphere test along the ray direction; it is the primitive behind the character controller. A `boxCast` may be added additively later.

### 3.5 Character controller

```ts
export interface CharacterControllerDesc {
  readonly radius: number;               // > 0
  readonly halfHeight: number;           // > 0; capsule total height = 2*(halfHeight + radius)
  readonly position: Vec3;
  readonly rotation?: Quat;
  readonly slopeLimitDegrees?: number;   // 0..89, default 45
  readonly stepOffset?: number;          // metres, default 0.3
  readonly snapToGround?: number;        // metres, default 0.1
  readonly gravity?: number;             // m/s^2 downward scalar, default 9.81
  readonly mass?: number;                // kg, default 70; used when pushing dynamic bodies
  readonly pushForce?: number;           // max push impulse per tick, default 0 (no push)
  readonly filter?: QueryFilter;
}

export interface CharacterMoveResult {
  moved: Vec3;                           // actual displacement this call
  grounded: boolean;
  groundNormal: Vec3;
  hitCeiling: boolean;
  hitWall: boolean;
  slidCount: number;                     // 0..4
}

export class CharacterController {
  readonly body: BodyHandle;             // kinematic capsule owned by the controller
  move(desiredTranslation: Vec3, dt: number): CharacterMoveResult;
  teleport(position: Vec3, rotation?: Quat): void;
  isGrounded(): boolean;
  setEnabled(enabled: boolean): void;
}
```

Rules:

- The controller owns a `kinematicPosition` capsule body. Games must not destroy that body directly; `destroyCharacter` does it.
- `move` is called once per tick inside `simulate`; `dt` must equal `world.fixedDt` (a mismatch is clamped to `fixedDt` and counted).
- Gravity is integrated internally as vertical velocity; the caller passes horizontal intent only. A jump sets the internal vertical velocity through the game's own state and the character is allowed to leave the ground.
- The controller never allocates and never reads the clock.

### 3.6 Vehicle

```ts
export interface VehicleInput {
  readonly throttle: number;             // -1..1, forward positive
  readonly steering: number;             // -1..1, right positive
  readonly brake: number;                // 0..1
  readonly handbrake?: number;           // 0..1, default 0
}

export interface WheelDesc {
  readonly localPosition: Vec3;          // attachment point in chassis space
  readonly radius: number;               // > 0
  readonly width: number;                // > 0
  readonly suspensionRestLength: number; // > 0
  readonly suspensionStiffness: number;  // N/m, > 0
  readonly suspensionDamping: number;    // N*s/m, > 0
  readonly maxTravel: number;            // metres, > 0
  readonly steerable: boolean;
  readonly driven: boolean;
  readonly friction: number;             // 0..2, tyre friction coefficient
}

export interface VehicleDesc {
  readonly chassis: BodyHandle;          // dynamic body with at least one box collider
  readonly wheels: readonly WheelDesc[]; // 2 or 4, order FL, FR, RL, RR
  readonly engineForce: number;          // N at the contact patch, > 0
  readonly reverseForce: number;         // N, > 0
  readonly brakeForce: number;           // N, > 0
  readonly maxSteerDegrees: number;      // 5..60, default 35
  readonly steerRateDegreesPerSecond: number; // > 0, default 180
  readonly topSpeed: number;             // m/s, > 0
  readonly downforce?: number;           // N per (m/s)^2, default 0
}

export interface WheelState {
  contact: boolean;
  contactPoint: Vec3;                    // world space, valid when contact
  contactNormal: Vec3;
  suspensionLength: number;              // current, metres
  rotation: number;                      // radians, accumulated for rendering
  steerAngle: number;                    // radians
  slipRatio: number;
  slipAngle: number;
  normalForce: number;
  longitudinalForce: number;
  lateralForce: number;
}

export interface VehicleState {
  wheelCount: number;
  speed: number;                         // chassis forward speed, m/s
  forward: Vec3;                         // chassis forward axis in world space, local −Z per 02
  wheels: readonly WheelState[];         // fixed array, reused
}
```

Rules:

- Vehicles are stepped by `world.step()` in creation order; `setVehicleInput` stores input for the next step.
- A vehicle's wheels are raycasts, not rigid bodies. Wheel state is telemetry only and is never used for network or save state.
- The chassis must have a mass. A vehicle on a kinematic or static chassis is rejected.
- A vehicle is destroyed with its chassis; destroying the chassis destroys the vehicle.

### 3.7 Scene and renderer integration

```ts
export interface RigidBodyRef {
  readonly body: BodyHandle;
}
export interface PreviousTransform {
  position: Vec3;
  rotation: Quat;
}
```

- `bindTransform` requires the entity to have a `Transform`; it records the mapping in a dense table indexed by entity index. Binding a second body to one entity replaces the first.
- `syncScene(scene)` runs after `step()` and, for every bound live entity in ascending body index order:
  1. copies the old `Transform.position/rotation` into `PreviousTransform`;
  2. copies the new body pose into `Transform.position/rotation`;
  3. leaves `Transform.scale` untouched.
- `PreviousTransform` is owned by scene spec 03 as an additive component. The renderer spec 04 interpolates between `PreviousTransform` and `Transform` with the loop alpha. This spec does not define a second interpolation path for ordinary rigid bodies.
- `sampleTransform` exists for cameras and attachment points that are not scene entities; it interpolates the world's own previous/current body pose.
- Animation (spec 08) does not drive physics bodies; a ragdoll bridge, when it lands in M2, writes joint targets and is owned jointly by 07/08.

---

## 4. Data formats

### 4.1 Units, axes and precision

| Property | Rule |
|---|---|
| Length | metres |
| Mass | kilograms |
| Time | seconds; simulation advances in fixed 1/60 s steps |
| Coordinate system | right-handed, **+Y up**, **+X right**, **−Z forward**, **+Z toward the viewer** (02 §3.1) |
| Rotation | unit quaternion `(x, y, z, w)`, normalized on every write |
| Matrices | column-major, 16 floats (engine-core convention) |
| Linear velocity | m/s; hard clamp 500 m/s |
| Angular velocity | rad/s; hard clamp 100 rad/s |
| Position range | ±20,000 m from origin before an origin rebase (§5.17) |
| Legacy 2D | `src/two-d/` keeps the existing **y-down** world convention and is not converted |

The 2D and 3D conventions deliberately differ. The 2D solver is a frozen compatibility surface for Coin Run and future 2D games; the 3D world follows the engine and glTF convention. Mixing them in one world is not supported.

### 4.2 Authoring JSON (physics block inside a scene)

Physics bodies are authored in the scene document owned by specs 03/17. This spec owns the shape and validation of the `physics` block. Adding or changing a required field is a `SCENE_FORMAT_VERSION` bump (00 §4.1).

```json
{
  "physics": {
    "formatVersion": 1,
    "gravity": [0, -9.81, 0],
    "layers": ["default", "world", "vehicle", "character", "prop", "sensor"],
    "bodies": [
      {
        "id": "car-01",
        "type": "dynamic",
        "position": [12.5, 1.2, -3.0],
        "rotation": [0, 0, 0, 1],
        "mass": 1200,
        "linearDamping": 0.05,
        "angularDamping": 0.1,
        "ccd": true,
        "colliders": [
          {
            "shape": { "kind": "box", "halfExtents": [0.9, 0.45, 2.0] },
            "friction": 0.7,
            "restitution": 0.05,
            "layer": 2,
            "mask": 65535,
            "localPosition": [0, 0.45, 0]
          }
        ]
      },
      {
        "id": "kerb-07",
        "type": "static",
        "position": [10, 0, 0],
        "colliders": [
          {
            "shape": { "kind": "box", "halfExtents": [0.15, 0.15, 40] },
            "layer": 1,
            "mask": 65535
          }
        ]
      }
    ],
    "joints": [
      {
        "id": "door-01",
        "kind": "hinge",
        "bodyA": "frame-01",
        "bodyB": "door-01-body",
        "anchorA": [0.9, 0, 0],
        "anchorB": [-0.9, 0, 0],
        "axisA": [0, 1, 0],
        "axisB": [0, 1, 0],
        "limit": { "lower": -1.4, "upper": 0 }
      }
    ],
    "vehicles": [
      {
        "id": "sedan",
        "chassis": "car-01",
        "engineForce": 6000,
        "reverseForce": 3000,
        "brakeForce": 9000,
        "maxSteerDegrees": 35,
        "steerRateDegreesPerSecond": 180,
        "topSpeed": 45,
        "wheels": [
          {
            "localPosition": [-0.8, -0.35, 1.3],
            "radius": 0.34,
            "width": 0.25,
            "suspensionRestLength": 0.3,
            "suspensionStiffness": 35000,
            "suspensionDamping": 4000,
            "maxTravel": 0.25,
            "steerable": true,
            "driven": true,
            "friction": 1.0
          }
        ]
      }
    ]
  }
}
```

Validation rules:

- `formatVersion` must be `1`; unknown versions refuse the scene with `E_ASSET_FORMAT`.
- `id` matches `^[a-z0-9][a-z0-9_.-]{0,63}$` and is unique within the block. Strings are UTF-8, no NUL.
- Every number is finite; quaternions are normalized (a zero quaternion is invalid); `mass` is `> 0` for dynamic bodies.
- `layer` is an index into `layers` (`0..31`); `mask` is a u32.
- At most **1,024 bodies and 4,096 colliders per scene block**. A larger block is authored as multiple cells by streaming (spec 12).
- A trimesh is authored by size only in JSON and loaded from a separate binary asset by id; the JSON never embeds vertex arrays.
- Vehicle wheel order is `FL, FR, RL, RR` when four wheels are present; two-wheel vehicles are `F, R`.
- `gravity` absent means the world default. `fixedDt` is never authored; the engine fixes it at 1/60.

### 4.3 Canonical state hash

`stateHash()` is the determinism probe. It hashes a canonical little-endian byte stream, independent of handle values and allocation order:

1. `u32 bodyCount` (live bodies, including static).
2. For each body in ascending **dense body index**:
   - `f64 position.x, y, z`
   - `f64 rotation.x, y, z, w`
   - `f64 linearVelocity.x, y, z`
   - `f64 angularVelocity.x, y, z`
   - `u32 flags` (bit 0 sleeping, bit 1 enabled, bit 2 has collider)
   - `u32 userData`
3. `u32 colliderCount`, then per collider in ascending dense index: `u32 bodyIndex`, `u32 shapeKind`, `f64 friction`, `f64 restitution`, `u32 layer`, `u32 mask`, `u32 sensor`.

FNV-1a 32 is computed over that stream with a reusable scratch `DataView` (64 KiB max chunk). Static bodies are included so a moved static body changes the hash. Vehicles and character controllers are represented by their bodies; wheel telemetry is excluded.

### 4.4 Limits

| Item | Limit | Behaviour on exceed |
|---|---|---|
| Dynamic bodies | 4,096 recommended, 16,384 hard | `createBody` returns an invalid handle and counts a drop |
| Colliders | 16,384 recommended, 65,536 hard | `createCollider` returns an invalid handle and counts a drop |
| Colliders per body | 32 | `createCollider` rejected |
| Trimesh triangles per collider | 500,000 | `createCollider` rejected |
| Joints | 8,192 | `createJoint` rejected |
| Wheels per vehicle | 4 | descriptor rejected |
| Contact points per manifold | 4 | extra points dropped deterministically |
| Contact events per step | 1,024 | `droppedEvents` increments; events beyond the cap are lost |
| Scratch memory per world | 32 MiB | documented ceiling; exceeding it is an implementation bug |

### 4.5 Versioning

- The runtime `PhysicsWorld` has no persisted binary representation. State is game-owned and saved by spec 15.
- The scene `physics` block is versioned by `SCENE_FORMAT_VERSION` (spec 03/17), not a private counter. This spec's `formatVersion: 1` is the block's own shape version and must match the scene version it ships in.
- Adding optional descriptor fields (a new shape kind, a new joint kind) is additive and does not bump `formatVersion`. Removing or reinterpreting a field does.
- A future baked collision format (e.g. a compressed BVH) must be registered in 00 §4.1 before it is written.

---

## 5. Architecture

### 5.1 Module map

```
packages/engine/physics/
  src/
    index.ts                 public exports only
    world/
      PhysicsWorld.ts        lifecycle, handle tables, step orchestration
      config.ts              defaults, caps, validation
      stats.ts               counters, timing (debug)
    body/
      BodyStore.ts           SoA state, generations, dense index
      BodyBuilder.ts         mass/inertia derivation, validation
    shape/
      sphere.ts box.ts capsule.ts trimesh.ts
      mass.ts                volume and inertia formulas
      aabb.ts                world AABB computation
    broadphase/
      Sap.ts                 persistent sweep-and-prune, pair cache
      MeshBvh.ts             per-trimesh BVH, built at create or in a job
      pairs.ts               deterministic pair keys and ordering
    narrowphase/
      gjk.ts epa.ts          generic convex distance and penetration
      sphereSphere.ts sphereBox.ts boxBox.ts capsuleCapsule.ts
      triangle.ts            sphere/capsule/box vs triangle
      manifold.ts            contact point reduction, feature ids, warm-start cache
    solver/
      islands.ts             union-find islands in dense order
      velocity.ts            sequential impulse solver
      position.ts            split-impulse position correction
      sleep.ts               island sleep/wake
      ccd.ts                 conservative advancement
    constraint/
      fixed.ts ball.ts hinge.ts slider.ts distance.ts
      limits.ts motors.ts
    vehicle/
      RaycastVehicle.ts      chassis, wheels, suspension, tyre model
    character/
      CharacterController.ts move-and-slide, step-up, ground snap, push
    query/
      raycast.ts shapecast.ts overlap.ts
    sync/
      SceneBinding.ts        entity<->body, PreviousTransform writes
    debug/
      draw.ts                optional debug lines through the renderer contract
    two-d/
      Vec2.ts Aabb.ts collide.ts index.ts   M0 migration, frozen semantics
  test/
    fixtures/
    unit/
    property/
    golden/
    integration/
    bench/
```

No file in `src/` may import a renderer backend, the DOM, `@lanpad/protocol`, `@lanpad/sdk`, `@lanpad/runtime` or a game (00 §5.2 D3). `two-d/` imports only its own files.

### 5.2 State layout

- Bodies live in a **dense array**; a handle's `index` is the slot and `generation` increments on destroy/reuse. All solver loops iterate dense order.
- Per-body SoA arrays: `position` (3 f64), `rotation` (4 f64), `linearVelocity` (3 f64), `angularVelocity` (3 f64), `force` (3 f64), `torque` (3 f64), `invMass` (f64), `invInertiaLocal` (3 f64), flags, sleep timer, user data.
- Rotation is stored as four doubles, not as a matrix. World inverse inertia is computed as `R * I⁻¹_local * Rᵀ` only when a body's rotation changed; the result is cached in a 3×3 array.
- Colliders live in their own dense array with `bodyIndex`, local transform, shape index, material, filter and a cached world AABB. Shape data is shared by reference; identical trimeshes are not deduplicated in M1.
- Contacts and manifolds are pooled. A manifold holds up to 4 points with feature ids (`u32`), normal, tangent basis, accumulated normal/tangent impulses and a persisted age. Pools grow at load, never during a step after warm-up.
- Solver scratch arrays (islands, sorted contact indices, impulse deltas) are preallocated to the configured caps.

### 5.3 Step pipeline (normative order)

`step()` executes exactly this sequence:

1. **Begin.** Reset per-step counters and increment `tick`. Events from the previous step are expected to have been drained by the game; undrained events remain queued and count toward the cap.
2. **Forces.** Add `gravity * gravityScale * mass` to each dynamic body's force accumulator; add user forces/torques applied since the last step.
3. **Integrate velocities.** Semi-implicit Euler:
   - `v += (F * invMass) * dt`
   - `v *= 1 / (1 + linearDamping * dt)`
   - `w += (I⁻¹_world * τ) * dt`
   - `w *= 1 / (1 + angularDamping * dt)`
   - clamp `|v| ≤ 500 m/s`, `|w| ≤ 100 rad/s`.
4. **Clear force accumulators** after they have been applied (per-step forces). Impulses applied during the previous tick were already folded into velocity.
5. **Update world AABBs** for every dynamic/kinematic collider whose body moved or was marked dirty; static colliders are updated only when explicitly marked dirty.
6. **Broadphase.** Sweep-and-prune over primitive colliders; trimesh colliders queried through their BVH (§5.4). Produce candidate pairs; filter by layer/mask, body identity, joint `collideConnected` and disabled bodies.
7. **Narrowphase.** For each candidate pair in ascending pair-key order, compute the manifold and update the persistent cache. Sensors generate trigger events instead of contacts.
8. **CCD.** For each `ccd: true` dynamic body with speed above the CCD threshold (default 5 m/s), sweep from the pre-integration pose to the predicted pose against static and kinematic colliders. On a hit, clamp the body to the time of impact, zero the normal velocity component (or apply restitution) and continue the remaining time. At most 4 sweeps per body per step.
9. **Islands.** Union-find over contact pairs and joints. Island order is ascending minimum body index; contacts within an island sort by pair key. Static bodies never join an island.
10. **Solve velocities.** `velocityIterations` passes over all islands; warm start from cached impulses when enabled; solve contact normal, friction (two tangents), joint rows and motors. Restitution is applied only when the approach speed exceeds 1 m/s.
11. **Integrate positions.** `x += v * dt`; `q += 0.5 * quat(w) * q * dt`; normalize `q`.
12. **Solve positions.** `positionIterations` passes using split impulses / position correction with Baumgarte factor 0.2, slop 0.005 m and maximum correction 0.2 m per step. No velocity is injected.
13. **Sleeping.** Update island sleep timers; sleep or wake whole islands (§5.12).
14. **Finalize.** Recompute world AABBs for moved bodies; update vehicle wheel telemetry; write previous/current pose snapshots used by `sampleTransform`; dispatch queued contact/trigger events; update stats.

The order above is normative. Moving CCD after islands, for example, changes penetration and therefore the state hash, and requires a spec revision.

### 5.4 Broadphase

- **Primitive colliders** use a persistent **sweep-and-prune on X**. Each frame the array is updated by a stable insertion sort on `aabb.min.x`; ties break on `collider.index`. The sweep tests the X overlap first, then Y and Z.
- A persistent pair cache (open-addressed hash on `(minIndex << 32) | maxIndex`) avoids redoing narrowphase for unchanged pairs. Pairs are *iterated* by ascending key, never in hash order.
- **Static colliders** are sorted once at creation and rarely move. A static body whose transform is changed is marked dirty and re-sorted; this is legal but expensive, so authoring-time placement is the rule.
- **Trimesh colliders** are excluded from the SAP sweep because their world AABB spans a whole block. Each trimesh owns a median-split BVH over triangles, built at creation (M1: synchronous at load; M2: in a `JobSystem` job). For every primitive collider whose world AABB overlaps a trimesh's world AABB, the broadphase queries that BVH and emits triangle candidates. Static-vs-static pairs are skipped. Trimesh-vs-trimesh is unsupported and rejected by validation.
- **Kinematic bodies** participate like dynamic bodies for broadphase, but are not moved by the solver.
- Broadphase work is time-sliced only at load, never inside a step. `stats.pairCount` is the candidate count after filtering.
- Broadphase targets: 12,000 colliders and 1,000 moving bodies should produce under 20,000 candidate pairs in the M1 benchmark scene.

### 5.5 Shapes and narrowphase

- **Sphere:** analytic contact against sphere, box, capsule and triangle.
- **Box (AABB/OBB):** the local box is an OBB under the body rotation. Box-box uses SAT with 15 axes (3 face A + 3 face B + 9 edge crosses) and deterministic axis tie-breaking by axis index; box-sphere and box-triangle are specialized.
- **Capsule:** local +Y segment; capsule-capsule and capsule-sphere reduce to segment-point/segment-segment distances; capsule-box and capsule-triangle use the closest point on the segment and a sphere test with the capsule radius.
- **Trimesh:** triangle tests only, against sphere, box and capsule. Winding is used for the hit normal; collision is two-sided. Triangle normals are precomputed at BVH build.
- **Generic convex fallback:** GJK for distance and EPA for penetration are implemented so future convex shapes do not require new pair cases. In M1 no public shape uses them; the code must still be tested with a synthetic tetrahedron fixture so it is not dead code.
- **Manifold:** up to 4 contact points, selected by a deterministic reduction (deepest point, then farthest points in the tangent plane, ties by feature id). Feature ids encode shape kind, primitive index and triangle index so warm-start impulses survive across frames.
- **Materials:** friction is the geometric mean `sqrt(muA * muB)`; restitution is `max(eA, eB)`; both clamp to their declared ranges. Static bodies have infinite mass and zero inverse inertia.
- **Triggers (sensors):** no contact response. `TriggerEvent` reports enter/exit once per pair transition; it uses the same narrowphase manifold only to decide overlap, and exits when the pair disappears for one step.

### 5.6 Solver

- Sequential impulse with accumulated impulses. The effective mass for a contact row uses `invMassA + invMassB + n · (I⁻¹A (rA × n) × rA + I⁻¹B (rB × n) × rB)`.
- Normal impulse accumulation clamps at `λ ≥ 0`. Friction uses two tangent directions built deterministically from the normal: pick the world axis with the smallest absolute dot with the normal, cross it with the normal, normalize; the second tangent is `n × t1`.
- Friction cone: `|λ_t| ≤ μ * λ_n_accumulated`, applied per tangent.
- Restitution: bias velocity `-e * max(v_rel·n - 1, 0)`; no restitution below the 1 m/s threshold, which stops resting bodies from buzzing.
- Warm starting: cached impulses are applied at the start of velocity solving and scaled by `dtRatio` (always 1 at fixed dt), then decayed by contact age.
- Position correction uses split impulses: a separate pseudo-velocity pass with Baumgarte bias `(0.2 / dt) * max(penetration - 0.005, 0)`, clamped to 0.2 m/s per iteration. This avoids adding energy.
- Joints use the same row formulation. Hinge has 3 linear + 2 angular rows; slider 2 linear + 3 angular; ball 3 linear; fixed 3 linear + 3 angular; distance 1 linear row.
- Determinism: iteration order is `island → contact index within island → solver row`; no set/map iteration, no floating-point reduction across workers.
- Default iterations (8 velocity, 3 position) are part of M1. A game may raise them in `PhysicsWorldOptions`; the chosen config must be recorded in the replay fixture metadata because it changes the hash.

### 5.7 Vehicles

Raycast-vehicle model (Bullet-style), chosen because it is stable at 60 Hz, cheap, and does not need a joint solver for each wheel:

- Each wheel is a ray from its attachment point along the chassis local **-Y** axis, length `suspensionRestLength + radius`.
- If the ray hits, the suspension length is the hit distance minus the radius, clamped to `[0, suspensionRestLength + maxTravel]`. The spring force is `k * (rest - length) - c * v_vertical`, clamped at `≥ 0`, applied at the contact point along the contact normal.
- Tyre forces are computed in the contact plane:
  - longitudinal: drive force from throttle/engine (or brake), clamped by `mu * normalForce`;
  - lateral: `-lateralSlip * corneringStiffness`, clamped by the remaining friction circle;
  - handbrake raises longitudinal slip and lowers lateral grip on the rear wheels.
- Steering is rate-limited (`steerRateDegreesPerSecond`) and clamped to `maxSteerDegrees`; only `steerable` wheels turn.
- Engine force is reduced linearly to zero at `topSpeed`; reverse force applies when throttle is negative and speed is near zero.
- Downforce, when configured, is `-downforce * speed²` along the chassis local -Y.
- Wheel rotation for rendering is accumulated from `speed / radius * dt`; it is telemetry, never hashed.
- Vehicle update order is creation order and is part of the step.

The M1 fixture is a 4-wheel sedan on a flat plane with a slalom of boxes: it must accelerate to 30 m/s, steer through the slalom without rolling over, brake to a stop, and never tunnel through the 0.15 m kerbs.

### 5.8 Character controller

The controller is a kinematic capsule, not a dynamic body. That makes it deterministic, cheap, and independent of solver tuning. `move(desired, dt)`:

1. Integrate internal vertical velocity: `vy -= gravity * dt` unless grounded; apply any jump velocity the game has set on the controller.
2. Build the desired displacement `desired + (0, vy * dt, 0)`.
3. Shape-cast the capsule along the displacement (up to 4 slides). On each hit, project the remaining displacement onto the contact plane and continue. Stop when the remaining distance is below 1e-4 m.
4. Step-up: if a horizontal slide is blocked and the obstacle height is `≤ stepOffset` and its surface angle is `≤ slopeLimitDegrees`, translate up by the obstacle height, move forward and cast down. This is attempted at most twice per move.
5. Depenetrate: run the capsule overlap at the final pose; push out by at most 0.05 m per iteration, 4 iterations.
6. Ground snap: when grounded or descending, cast down `snapToGround`; if a surface within the slope limit is found, snap and set `grounded`.
7. Slopes: a contact whose normal angle from +Y exceeds `slopeLimitDegrees` is a wall, not ground; gravity keeps the character sliding down it.
8. Pushing: when `pushForce > 0`, each contact with a dynamic body applies an impulse `min(pushForce, mass * penetrationSpeed)` at the contact point. Pushing is deterministic and capped per tick.

The controller queries the completed world state. M1 convention: `simulate` calls `controller.move(...)`, then `world.step()`, then `world.syncScene(scene)`. The controller never reads state from inside the solver.

### 5.9 Collision filtering

- Every collider has a 32-bit `layer` bit index and a 32-bit `mask`. Two colliders interact only when both accept each other: `(a.mask & (1 << b.layer)) !== 0 && (b.mask & (1 << a.layer)) !== 0`.
- Sensors still obey filtering. Triggers use the same rule.
- Joints disable collision between their two bodies unless `collideConnected: true`.
- The `layers` option names bits for tooling and JSON authoring only; the runtime uses bit operations. Duplicate names are rejected.
- Filtering is applied **before** narrowphase. It is also applied to queries through `QueryFilter`.

### 5.10 Custom vs Rapier: the only decision rule

The engine ships a custom solver. Rapier (or any third-party physics runtime) may replace it only when **all** of the following are true:

1. A recorded amendment (**A15 — Physics engine replacement**) exists in `docs/todos/README.md`; it names the version, license and WASM size.
2. A benchmark on the named M1 scene shows the custom solver **more than 2× over** its frame budget after a documented optimization pass, **or** a required capability (e.g. robust large-world CCD, ragdolls, heightfields) cannot be implemented in the custom solver within **15 dev-days** of recorded work.
3. The replacement passes the full public conformance suite in §8, including determinism, vehicle, character and no-tunnelling fixtures, behind the **same `PhysicsWorld` API** with no game changes.
4. The WASM payload keeps the host bundle under the 5 MB gzip hard budget (00 §5.11 / SPEC §11), measured by `npm run size`.
5. Replay determinism is proven on Node 20 and Desktop Chrome 155 for the same build.

If any condition fails, the custom solver stays. There is no per-game engine choice and no dual-path runtime: a game that needs different physics gets a feature in this package, not a second engine. Rapier's WASM is never loaded from a CDN, never fetched from a non-same-origin URL, and never initialized before the game's asset budget is checked.

### 5.11 Determinism rules

Required within one build, one browser, one input trace:

- fixed `dt = 1/60`; no accumulator inside the world;
- no `Math.random`, `Date.now`, `performance.now`, timers or promises inside `step`;
- no worker results applied mid-step; workers may only build BVHs, and the result is applied at the next tick boundary in request-id order;
- no iteration over `Map`/`Set`/object keys in the step; every loop is over dense arrays or sorted indices;
- stable sort ties by index everywhere (broadphase, contacts, islands, manifold points, events);
- `SolverConfig` and `substeps` are part of the replay configuration; changing them changes the hash and must be recorded;
- forces are cleared after each step; impulses are applied immediately to velocity;
- quaternion normalization happens after every integration and after every write;
- `Math.sin`, `Math.cos`, `Math.sqrt` and `Math.atan2` are allowed; cross-engine last-bit differences are out of scope per 00 §5.8.

The determinism fixture records `{ seed (unused), ticks, solver, substeps, bodies, joints, input trace, expectedStateHash }`. Physics has no RNG; the game's seed is irrelevant unless it drives inputs.

### 5.12 Sleeping and islands

- A body sleeps when `|v| < 0.05 m/s` and `|w| < 0.1 rad/s` for 0.5 s (30 ticks). The timer is per body, but sleep is applied per **island**: an island sleeps only when every body in it qualifies, and waking any body wakes its whole island.
- Static bodies never sleep or wake; kinematic bodies never sleep (they can move at any time).
- Wake triggers: `applyForce`, `applyImpulse`, `applyTorqueImpulse`, `setLinearVelocity`, `setAngularVelocity`, `setTransform`, a contact with an awake dynamic body, a joint to an awake body, a character push, and `setEnabled(true)`.
- Sleeping bodies skip integration and narrowphase against other sleeping bodies, but remain in the broadphase and in queries. A sleeping body still collides with an awake body.
- Sleeping is deterministic: island construction uses dense order, and sleep decisions happen at the end of the step after position solving.
- The hash includes the sleeping flag, so a fixture that sleeps at a different tick fails.

### 5.13 Scene and renderer integration

- The scene owns `Transform` (frozen, 00 §3.2). `PreviousTransform` is the additive component this spec requires from 03.
- `syncScene` is the only writer of physics-driven transforms. It runs in `simulate`, after `step()`, before the game reads transforms for its own logic in the next tick.
- The renderer never sees a `PhysicsWorld`. It sees `Transform` and `PreviousTransform` on scene entities and interpolates with the loop alpha. Spec 04 owns that interpolation; this spec only guarantees both components are present and that `PreviousTransform` is exactly the previous tick's pose.
- `sampleTransform` gives cameras and attachment points the same interpolation without a scene entity.
- Debug draw (`debug/draw.ts`) emits line segments through the backend-neutral renderer contract when `?debug=1`; it allocates only on enable and is compiled out of production use. It draws collider wireframes, contact normals and sleeping state.
- Games must not write `Transform` of a bound entity; the value is overwritten at the next `syncScene`. Detach with `unbindTransform` first.

### 5.14 Performance and allocation

- After a warm-up of one step, `step()` performs **zero heap allocations**: no `new`, no array/object literals, no closures, no `map`/`filter`/`forEach`/spread, no string concatenation. Debug counters are numbers, not strings.
- Contact events are pooled structs; `drainContactEvents(out)` copies into the caller's array and recycles the pool.
- Manifold pools grow geometrically at load. If a step exceeds capacity, the world drops contacts in a documented deterministic order (highest pair key first) and increments a counter. Dropping contacts is an implementation failure, not a game-visible feature.
- Timings in `stats` use `performance.now()` only when debug is enabled; `step()` never calls it otherwise. The profile wrapper, not the world, owns the clock.
- Budget target for the M1 benchmark scene: 1,000 dynamic boxes + 10,000 static boxes + one 100k-triangle trimesh, p95 step ≤ **2.5 ms** on Desktop Chrome 155. This is a target, measured in ER-07-05; it is not a current measurement.
- Memory target: ≤ 32 MiB scratch for that scene; ≤ 64 MiB total including shape data.

### 5.15 M0 migration of the 2D solver

The M0 move is mechanical and must preserve behaviour exactly:

| Current | Target |
|---|---|
| `packages/runtime/src/physics/Vec2.ts` | `packages/engine/physics/src/two-d/Vec2.ts` (the `engine-core` math re-export stays per 00 §5.13) |
| `packages/runtime/src/physics/Aabb.ts` | `packages/engine/physics/src/two-d/Aabb.ts` |
| `packages/runtime/src/physics/collide.ts` | `packages/engine/physics/src/two-d/collide.ts` |
| `packages/runtime/src/physics/index.ts` | compatibility re-export in `packages/runtime`, deleted at M1 |

- `CircleBody`, `Contact`, `MAX_SPEED`, `resolveCircleAabb`, `resolveCircleCircle` and `integrate` keep their names, types, y-down convention, full positional correction and allocation-free behaviour.
- The 2D solver does not gain 3D features. `two-d/` imports nothing from `src/` outside its folder.
- Coin Run and Sumo-style games keep their current results; the M0 parity fixture (ER-07-09) is the proof.

### 5.16 Error handling

- Boundary validation (descriptors, JSON, handles) throws `EngineError` with `E_CONTRACT`, `E_STALE_HANDLE`, `E_ASSET_FORMAT` or `E_UNSUPPORTED_FEATURE`. No throw happens inside `step()` in normal operation.
- A stale handle in production is a no-op plus a counter; in dev it throws so tests catch lifetime bugs.
- A non-finite transform, velocity or shape parameter is rejected at creation. A non-finite value appearing mid-step is caught in dev by a NaN guard on body state (once per step, debug builds) and reported with the body index; production clamps to zero and counts it.
- A trimesh with a degenerate triangle (zero area) is accepted with that triangle disabled and a counter; an all-degenerate mesh is rejected.
- Pool exhaustion never throws mid-step; it drops deterministically and increments `stats`.

### 5.17 Large worlds and floating origin

- World positions are JavaScript doubles, so physics is not limited by float32; the renderer's float32 transforms are.
- The supported range before rebasing is ±20,000 m from the origin. Spec 12 calls `world.rebaseOrigin(newOrigin)` at cell boundaries: every body, joint anchor and cached AABB is translated by `-newOrigin` between steps.
- Rebasing must happen at a tick boundary, once, and is part of the tick's deterministic record. A replay must call it at the same tick.
- Vehicles and character controllers are rebased with their chassis/body; wheel local data is unaffected. External game data (camera, streaming) is the caller's responsibility.
- Do not rebase during `step()`.

---

## 6. File ownership

This spec owns exactly one documentation file and the following implementation directory. No other agent writes these paths in the same wave.

| Path | Contents | Wave |
|---|---|---|
| `docs/engine/07-physics3d.md` | this spec | spec wave |
| `packages/engine/physics/package.json` | workspace package `@lanpad/engine-physics`, private, deps `@lanpad/engine-core` only | M0 |
| `packages/engine/physics/src/index.ts` | public exports | M0/M1 |
| `packages/engine/physics/src/two-d/**` | migrated 2D solver, frozen semantics | M0 |
| `packages/engine/physics/src/world/**` | world lifecycle, config, stats | M1 |
| `packages/engine/physics/src/body/**` | body store, mass/inertia | M1 |
| `packages/engine/physics/src/shape/**` | shape data, AABBs, mass properties | M1 |
| `packages/engine/physics/src/broadphase/**` | SAP, mesh BVH, pair cache | M1 |
| `packages/engine/physics/src/narrowphase/**` | primitive and triangle contacts, manifolds | M1 |
| `packages/engine/physics/src/solver/**` | islands, velocity/position solve, sleep, CCD | M1 |
| `packages/engine/physics/src/constraint/**` | joints, limits, motors | M1 |
| `packages/engine/physics/src/vehicle/**` | raycast vehicle | M1 |
| `packages/engine/physics/src/character/**` | character controller | M1 |
| `packages/engine/physics/src/query/**` | raycast, shapecast, overlaps | M1 |
| `packages/engine/physics/src/sync/**` | scene binding, interpolation snapshots | M1 |
| `packages/engine/physics/src/debug/**` | debug draw | M1 |
| `packages/engine/physics/test/**` | unit, property, golden, integration, bench | M0/M1 |

Boundaries:

- The package imports `@lanpad/engine-core` and nothing else (00 §5.2 D2). It does not import assets, renderer, protocol, sdk, runtime or games.
- The package's `package.json`, `tsconfig.json` and root Vitest project entry are integration-agent edits, not feature-agent edits.
- `packages/runtime/src/physics/**` is handed over at M0 and becomes a compatibility re-export; no new implementation lives there.
- Tests use `packages/engine/physics/test/fixtures/**`; another spec may read a fixture but not edit it.

---

## 7. Acceptance

Every row carries an `ER-07-NN` requirement ID that must resolve to a row in `docs/todos/TRACEABILITY.md` once the engine programme is registered. **Evidence rule:** PASS requires a recorded build, device, browser version, date and numbers in `docs/RESULTS.md`. Untested rows are PENDING and name the run needed. No row is claimed from this document.

| ID | Criterion | Fixture / method | Hardware | Evidence state |
|---|---|---|---|---|
| ER-07-01 | `npm run check` exits 0; every test title carries its ID; no test skipped, removed or weakened for the wave | full gate | CI Node 20 | PENDING — first M1 physics wave |
| ER-07-02 | **Deterministic simulation:** a 600-tick fixture with 256 mixed bodies (sphere/box/capsule/trimesh), one vehicle and one character produces the same `stateHash()` on two runs; **changing `velocityIterations` changes it** (the solver knob Rapier 0.21 exposes; `positionIterations`/`warmStarting` are recorded but have no JS mapping — RV-56) | `packages/engine/physics/test/fixtures/determinism-600.json`; run in Node and in Chrome 155 | CI Node 20 + Desktop Chrome 155 | PENDING — Node PASS, browser half PENDING |
| ER-07-03 | **Vehicle fixture:** sedan accelerates to 30 m/s in ≤ 8 s, completes the 150 m slalom without rollover, brakes to < 0.2 m/s, no wheel loses contact for more than 5 consecutive ticks | `test/fixtures/vehicle-slalom.json`, recorded trace + `stateHash` | Desktop Chrome 155, Windows 11 | PENDING — needs the fixture run |
| ER-07-04 | **Character fixture:** a 45° ramp stops horizontal motion within 0.1 m; a 0.3 m step is climbed; a 2 m drop lands grounded; wall sliding penetrates ≤ 0.02 m; ceiling is detected | `test/fixtures/character-course.json` | Desktop Chrome 155, Windows 11 | PENDING — needs the fixture run |
| ER-07-05 | **Step budget:** 1,000 dynamic boxes + 10,000 static boxes + one 100k-triangle trimesh, 600 measured steps after 120 warm-up, p95 `stepMs` ≤ **2.5 ms**, p50 ≤ 1.5 ms | `test/bench/m1-physics.bench.ts`, browser page using `stats.stepMs` | Desktop Chrome 155, Windows 11; GPU/CPU model recorded | PENDING — target, not measured |
| ER-07-06 | **No tunnelling:** a 250 m/s sphere with CCD configured crosses a 0.1 m wall 10,000 times without passing through. The per-body `ccd: false` negative control **cannot be produced on Rapier 0.21**, which applies CCD world-wide via `maxCcdSubsteps`; the fixture records `specConflict` and the test asserts only the no-tunnelling half (RV-75) | `test/fixtures/ccd-wall.json` | CI Node 20 | PENDING — Node PASS with the negative control recorded as a spec conflict |
| ER-07-07 | **Sleeping:** a 64-box stack settles and every body sleeps within 300 ticks; drift over the next 600 ticks ≤ 0.005 m; waking one body wakes exactly its island and no other | `test/fixtures/stack-64.json` + hash | CI Node 20 + Desktop Chrome 155 | PENDING — fixture authored with sleeping |
| ER-07-08 | **Filtering:** a 32-layer matrix fixture produces exactly the expected pair decisions; sensors never generate contact response; joints with `collideConnected: false` do not contact | `test/fixtures/filter-matrix.json` | CI Node 20 | PENDING — fixture authored with layers |
| ER-07-09 | **2D migration parity:** Coin Run's collision fixtures produce identical positions/velocities at tick 300 before and after the move; no 2D API signature changed | `packages/games/platformer/test/**` plus a golden trace | CI Node 20 | PENDING — M0 migration wave |
| ER-07-10 | **Bundle:** `@lanpad/engine-physics` JS **excluding the Rapier payload** ≤ **80 KB gzip**, recorded in the size report; the lazy Rapier payload is separately budgeted at **≤ 2 MiB gzip** (A15 measured 1,644,109 B gz for the installed `rapier.mjs`); host + game total stays ≤ 5 MB gzip; controller bundle unchanged | `npm run size` + `docs/RESULTS.md` A15 row | CI Node 20 | PENDING — criterion amended for A15; package-size gate needs the runtime import |
| ER-07-11 | **Memory:** the ER-07-05 scene uses ≤ 64 MiB total JS heap for physics data; heap growth over 480 frames after warm-up ≤ 256 KiB | Chrome heap snapshot / `performance.memory` on the bench page | Desktop Chrome 155 | PENDING — needs the bench page |
| ER-07-12 | **TV tier:** the M1 physics scene runs at 60 Hz on the TV profile with recorded p95 step and frame times | same bench page, TV profile | **PENDING device:** 2020-era Android TV Chromium and a Tizen/webOS set (SPEC §12) | PENDING — no TV hardware yet |
| ER-07-13 | **Rapier decision (only if invoked):** the §5.10 checklist is recorded with measurements and an amendment before any dependency is added | review + size + determinism runs | as named by the amendment | NOT APPLICABLE until a proposal exists |

Acceptance fixtures are JSON plus a thin harness; they are owned by this spec. A row may not be marked PASS from a specification or a synthetic benchmark on a different machine.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | mass/inertia formulas, AABB transforms, sphere/box/capsule pair cases, manifold reduction, filter truth table, ray/triangle, joint limits, spring force, sleep timers | `packages/engine/physics/test/unit/**` |
| Property (`fast-check`) | transforms round-trip; no NaN for finite inputs; penetration after position solve ≤ slop + 1e-3; energy does not increase for a resting stack; raycast distance ∈ [0, maxDistance]; hash depends only on final state, not creation history | `.../test/property/**` |
| Golden | determinism-600 hash, stack-64 hash, vehicle trace, character trace, CCD trace, 2D parity positions | `.../test/golden/**` |
| Integration | world + fixed loop: one step per tick, pause does not advance, `syncScene` writes both transforms, render interpolation at alpha 0/0.5/1, scene entity destroyed while bound | `.../test/integration/**` |
| Contract | stale handle behaviour, dispose idempotence, create-during-step rejection in dev, no allocation after warm-up | `.../test/unit/lifecycle.test.ts` |
| Benchmark | ER-07-05 scene, p50/p95/max, pair count, contact count, heap growth, browser page reporting `window.__PHYSICS_BENCH__` | `.../test/bench/**` + `experiments/e-m1-physics/` |
| Manual | TV tiers, real-device frame pacing, vehicle feel review | `docs/RESULTS.md` rows |

Rules:

- Every test title carries its `ER-07-*` (or an existing `FR-*`/`PR-*`) tag.
- Integration tests that need the dev server bind `127.0.0.1:0`, wait on messages and never use fixed sleeps. Physics unit tests need no server and must run in Node.
- Real GPU/browser work is measured on the bench page; CI runs the deterministic CPU suite. A browser-only row is never deleted to make CI green.
- Performance rows report p50, p95, max, step count, solver config, adapter/CPU, browser version and build hash. A number without those fields is not evidence.
- The 2D parity test runs before and after the M0 move in the same change.

---

## 9. Dependencies

**Specs**

| Spec | Why |
|---|---|
| 00 | Package boundary, `RenderDevice`/`Scene` contracts, determinism and no-allocation rules, version registry |
| 01 | Fixed loop, `dt`, `alpha`, pause; physics is stepped once per tick |
| 02 | `Vec3`, `Quat`, `Mat4`, ray/plane/AABB helpers, slerp/normalization |
| 03 | `Scene`, `Entity`, `Transform`; **requires the additive `PreviousTransform` component** |
| 04/05 | Debug draw contract only; physics never imports a backend. Skinning/ragdolls are out of scope |
| 06 | Trimesh binary assets are decoded by assets and passed in as typed arrays; physics owns collision, not file parsing |
| 08 | Root motion feeds the character controller in M2; no M1 code dependency |
| 11 | AI navigation raycasts and obstacle queries consume this API in M2 |
| 12 | World cells and `rebaseOrigin` calls for large worlds |
| 15 | Save payloads record body poses through game state; no physics-internal serialization |
| 19 | Benchmark harness, fixture conventions, results template |

**Packages**: `@lanpad/engine-core` only. `@lanpad/engine-physics` must be added to root `workspaces`, `tsconfig` references, Vitest projects and eslint boundary rules by the integration agent (00 §5.16). No third-party runtime dependency.

**Paper trail**: amendment **A14 — Browser-native engine reframe** must be recorded before the M0/M1 engine wave merges (00 §1). Amendment **A15 — Physics engine replacement** exists only if §5.10 is invoked.

**Preconditions for the M1 fixture**: `PreviousTransform` accepted by spec 03; `engine-assets` can hand a decoded trimesh (positions/indices) to `createCollider`; the fixed loop exposes a deterministic tick counter for fixture recording.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| P1 | Solver instability or jitter at 60 Hz ruins vehicle/character feel | High | M1 slice feels broken | Iteration counts, warm starting, split impulses, sleep; vehicle fixture is the tuning loop; reduce to a simpler tyre model if needed |
| P2 | Determinism breaks through hidden iteration/order dependence | High over time | Replay rows fail, debugging is expensive | Dense arrays, sorted ties, canonical hash, CI determinism test, no Map/Set in step |
| P3 | Trimesh BVH cost at city scale blocks the main thread | Medium | Frame spikes on load, failed streaming budget | Build BVH in `JobSystem`, time-slice uploads, prefer compound boxes for authored city blocks; 8 ms long-task gate (SPEC FR-9.10) |
| P4 | Dynamic-vs-trimesh quality is poor without a convex-hull shape | High | Props catch on mesh edges | M1 uses boxes/capsules/spheres for dynamic bodies; convex hull is an M2 additive shape |
| P5 | CCD is expensive or misses thin geometry at extreme speed | Medium | Tunnelling or frame spikes | CCD only for flagged bodies above 5 m/s; conservative advancement; cap at 4 sweeps; test the 250 m/s fixture |
| P6 | Sleeping wakes too eagerly, or never sleeps, wasting CPU | Medium | Jitter or CPU burn | Island sleep, deterministic thresholds, stack fixture, counters in stats |
| P7 | Vehicle tuning consumes weeks and delays M1 | High | Vertical slice slips | Raycast vehicle with a small, documented parameter set; fixture-driven; no per-game suspension models |
| P8 | Character controller interacts badly with dynamic props | Medium | Stuck players, launched crates | Optional capped push force; depenetration pass; slope/step fixtures; props can be made sensors for triggers |
| P9 | `PreviousTransform` is not added by spec 03, so physics-driven entities stutter | Medium | Visible judder at 60/120 Hz | Contract listed in §3.7 and §9; fallback `sampleTransform` for cameras; integration test fails until 03 lands |
| P10 | Float32 render transforms lose precision far from origin | High at M3 scale | Jitter in the open world | Double-precision simulation, `rebaseOrigin` at cell boundaries, renderer-relative transforms; M3 measurement |
| P11 | Custom solver becomes a multi-month sink | Medium | Programme delay | Hard M1 scope, stock shape set, §5.10 decision gate, measured before extending |
| P12 | A third-party engine is added piecemeal, splitting physics paths | Low if gated | Two engines, double bugs | §5.10 requires an amendment, a conformance pass and no game API change; no per-game path |
| P13 | Per-step allocations creep in and cause GC hitches on TV | High over time | Frame spikes, memory pressure | Allocation bench (ER-07-11), review rule, preallocated pools, no `map/filter` in `step` |
| P14 | Joints and motors become a general constraint language | Medium | Scope creep | Five joint kinds, limits and one motor shape; new kinds are additive and need a game requirement |
| P15 | A third-party WASM fallback breaks the 5 MB budget or determinism | Low until invoked | Gate failure | §5.10 conditions 4 and 5; size and replay checks are blocking |

**Fallback if 3D physics slips:** the M1 slice ships with vehicle and character on the primitive set (sphere/box/capsule) and trimesh only for static ground. Dynamic-vs-trimesh quality, convex hulls, heightfields and ragdolls move to M2 without changing the public API. A game that needs them is scheduled after M2, not given a local solver.

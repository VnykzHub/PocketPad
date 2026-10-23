/**
 * Rapier-backed `Physics3D` world (A15, spec 07).
 *
 * The adapter owns the frozen contract: generational handles over dense slot
 * tables, descriptor validation, a fixed explicit `step(dt)`, deterministic
 * state hashing, scene sync and pooled contact/trigger events. Rapier owns
 * integration and collision; this layer maps engine semantics onto it and
 * documents the gaps (see the package report).
 */
import type {
  Entity,
  Quat,
  Scene,
  Transform as TransformData,
  Vec3,
} from "@lanpad/engine-core";
import { Transform } from "@lanpad/engine-core";
import type {
  BodyDesc,
  BodyHandle,
  BodyState,
  BodyType,
  CharacterController,
  CharacterControllerDesc,
  ColliderDesc,
  ColliderHandle,
  ColliderState,
  ContactEvent,
  JointDesc,
  JointHandle,
  JointMotor,
  JointState,
  PhysicsAdapter,
  PhysicsBackend,
  PhysicsErrorCode,
  PhysicsStats,
  PhysicsWorldOptions,
  QueryFilter,
  RaycastHit,
  RaycastInput,
  ShapeCastHit,
  ShapeDesc,
  SleepConfig,
  SolverConfig,
  TriggerEvent,
  VehicleDesc,
  VehicleHandle,
  VehicleInput,
  VehicleState,
} from "../contracts/physics3d.js";
import type * as RAPIER from "@dimforge/rapier3d-compat";
import { PreviousTransform } from "../components.js";
import {
  PHYSICS_CCD_SPEED_THRESHOLD,
  PHYSICS_DEFAULT_ANGULAR_DAMPING,
  PHYSICS_DEFAULT_DENSITY,
  PHYSICS_DEFAULT_FRICTION,
  PHYSICS_DEFAULT_GRAVITY,
  PHYSICS_DEFAULT_LAYER_MASK,
  PHYSICS_DEFAULT_RESTITUTION,
  PHYSICS_DEFAULT_SLEEP,
  PHYSICS_DEFAULT_SOLVER,
  PHYSICS_FIXED_DT,
  PHYSICS_HARD_MAX_COLLIDERS,
  PHYSICS_HARD_MAX_DYNAMIC_BODIES,
  PHYSICS_MAX_CCD_SWEEPS,
  PHYSICS_MAX_COLLIDERS,
  PHYSICS_MAX_COLLIDERS_PER_BODY,
  PHYSICS_MAX_CONTACT_EVENTS,
  PHYSICS_MAX_DYNAMIC_BODIES,
  PHYSICS_MAX_JOINTS,
  PHYSICS_MAX_LAYERS,
  PHYSICS_MAX_LINEAR_SPEED,
  PHYSICS_MAX_ANGULAR_SPEED,
  PHYSICS_MAX_TRIMESH_TRIANGLES,
} from "../version.js";
import { physicsError } from "./errors.js";
import { StateHasher } from "./hash.js";
import type { BodySlot, ColliderSlot, JointSlot, ShapeData } from "./internal.js";
import {
  SHAPE_BOX,
  SHAPE_CAPSULE,
  SHAPE_SPHERE,
  SHAPE_TRIMESH,
  computeWorldAabb,
  copyQuat,
  copyVec3,
  isFiniteNumber,
  isFiniteQuat,
  isFiniteVec3,
  normalizeQuatInPlace,
  quat,
  sameAxis,
  shapeVolume,
  vec3,
} from "./internal.js";
import { RAPIER as RAPIER_MODULE, isRapierReady } from "./load.js";
import { RapierCharacter, accepts } from "./Character.js";
import { RapierVehicle, validateVehicleDesc } from "./Vehicle.js";

const INVALID_BODY_HANDLE: BodyHandle = Object.freeze({
  index: -1,
  generation: 0,
  __kind: "body",
});
const INVALID_COLLIDER_HANDLE: ColliderHandle = Object.freeze({
  index: -1,
  generation: 0,
  __kind: "collider",
});
const INVALID_JOINT_HANDLE: JointHandle = Object.freeze({
  index: -1,
  generation: 0,
  __kind: "joint",
});
const INVALID_VEHICLE_HANDLE: VehicleHandle = Object.freeze({
  index: -1,
  generation: 0,
  __kind: "vehicle",
});

const EMPTY_SHAPE: ShapeData = Object.freeze({
  kindCode: SHAPE_SPHERE,
  kind: "sphere",
  radius: 0,
  halfHeight: 0,
  halfExtents: Object.freeze(vec3()) as Vec3,
  vertices: null,
  indices: null,
  triangleCount: 0,
});

/** Additive adapter options; the frozen contract stays unchanged. */
export interface RapierWorldOptions extends PhysicsWorldOptions {
  /** Enables Rapier's profiler so `stats.*Ms` carry measured values. */
  readonly debug?: boolean;
}

/** Additive counters the concrete adapter exposes beside `PhysicsStats`. */
export class RapierPhysicsStats implements PhysicsStats {
  bodyCount = 0;
  colliderCount = 0;
  awakeBodyCount = 0;
  pairCount = 0;
  contactCount = 0;
  stepMs = 0;
  broadphaseMs = 0;
  narrowphaseMs = 0;
  solverMs = 0;
  droppedEvents = 0;
  ccdSweeps = 0;
  /** Handles rejected as stale since world creation. */
  staleHandles = 0;
  /** Dynamic bodies dropped at the configured cap. */
  droppedBodies = 0;
  /** Colliders dropped at the configured cap. */
  droppedColliders = 0;
  /** Non-finite body states sanitised since world creation. */
  nonFiniteBodies = 0;
  /** Degenerate trimesh triangles accepted (and ignored by Rapier). */
  degenerateTriangles = 0;
}

export interface ColliderFilterInfo {
  layer: number;
  mask: number;
  sensor: boolean;
}

interface MutableContactEvent {
  colliderA: ColliderHandle;
  colliderB: ColliderHandle;
  bodyA: BodyHandle;
  bodyB: BodyHandle;
}

interface MutableTriggerEvent extends MutableContactEvent {
  phase: "enter" | "exit";
}

interface VehicleSlotRecord {
  generation: number;
  vehicle: RapierVehicle | null;
  handle: VehicleHandle;
}

interface SceneBinding {
  entity: Entity;
  body: BodyHandle;
  bodyIndex: number;
}

interface QueryContext {
  flags: number | undefined;
  excludeCollider: RAPIER.Collider | undefined;
  excludeBody: RAPIER.RigidBody | undefined;
  predicate: (collider: RAPIER.Collider) => boolean;
}

/**
 * 30 ticks of 1/60 s sum to 0.49999999999999994 in binary floating point.
 * The tolerance keeps §5.12's "0.5 s (30 ticks)" exact instead of slipping
 * every body to the 31st tick.
 */
const SLEEP_TIMER_TOLERANCE = 1e-9;

function toDynamicType(type: BodyType): RAPIER.RigidBodyType {
  return type === "static"
    ? RAPIER_MODULE.RigidBodyType.Fixed
    : type === "dynamic"
      ? RAPIER_MODULE.RigidBodyType.Dynamic
      : type === "kinematicPosition"
        ? RAPIER_MODULE.RigidBodyType.KinematicPositionBased
        : RAPIER_MODULE.RigidBodyType.KinematicVelocityBased;
}

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

function vecLength(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function pairKey(a: number, b: number): number {
  return a < b ? a * 4294967296 + b : b * 4294967296 + a;
}

function slerpQuat(out: Quat, a: Quat, b: Quat, t: number): void {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let wa: number;
  let wb: number;
  if (dot > 0.9995) {
    wa = 1 - t;
    wb = t;
  } else {
    const theta = Math.acos(dot > 1 ? 1 : dot);
    const sinTheta = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / sinTheta;
    wb = Math.sin(t * theta) / sinTheta;
  }
  out.x = a.x * wa + bx * wb;
  out.y = a.y * wa + by * wb;
  out.z = a.z * wa + bz * wb;
  out.w = a.w * wa + bw * wb;
  if (!normalizeQuatInPlace(out)) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
  }
}

/**
 * Concrete Rapier backend. Construct only after `await initRapierPhysics()`.
 */
export class RapierPhysics3D implements PhysicsBackend {
  readonly backend = "rapier" as const;
  readonly fixedDt: number;
  readonly stats = new RapierPhysicsStats();
  readonly layerNames: readonly string[];
  tick = 0;

  private readonly gravity: Vec3;
  private readonly solver: SolverConfig;
  private readonly sleep: SleepConfig;
  private readonly maxDynamicBodies: number;
  private readonly maxColliders: number;
  private debug: boolean;

  private world: RAPIER.World;
  private eventQueue: RAPIER.EventQueue;
  private disposed = false;
  private stepping = false;

  private readonly bodySlots: BodySlot[] = [];
  private readonly colliderSlots: ColliderSlot[] = [];
  private readonly jointSlots: JointSlot[] = [];
  private readonly vehicleSlots: VehicleSlotRecord[] = [];
  private readonly characters: (RapierCharacter | null)[] = [];
  private readonly freeBodySlots: number[] = [];
  private readonly freeColliderSlots: number[] = [];
  private readonly freeJointSlots: number[] = [];
  private readonly freeVehicleSlots: number[] = [];
  private readonly freeCharacterSlots: number[] = [];

  private bodyIndexByRaw = new Map<number, number>();
  private colliderIndexByRaw = new Map<number, number>();
  private activeBodyCount = 0;
  private activeColliderCount = 0;
  private activeDynamicCount = 0;
  private awakeDynamicCount = 0;
  private activeJointCount = 0;

  private readonly contactPool: MutableContactEvent[] = [];
  private readonly triggerPool: MutableTriggerEvent[] = [];
  private contactPoolCount = 0;
  private triggerPoolCount = 0;
  private readonly activeContacts = new Map<number, number>();
  private readonly activeTriggers = new Map<number, number>();

  /* Island-sleep scratch (07 §5.12), rebuilt only on ticks where a body
   * has reached its sleep timer. Sized to the body table on structural
   * growth, never per tick. */
  private islandParent = new Int32Array(0);
  private islandQualify = new Uint8Array(0);
  private islandAwake = new Uint8Array(0);
  private islandSeen = new Int32Array(0);
  private islandJointHead = new Int32Array(0);
  private islandJointNext = new Int32Array(0);
  private islandJointOther = new Int32Array(0);
  private readonly islandQueue: number[] = [];
  private islandEpoch = 0;
  private islandVisitorIndex = -1;
  private readonly islandVisitor = (other: RAPIER.Collider): void => {
    const parentBody = other.parent();
    if (!parentBody) return;
    const index = this.bodyIndexByRaw.get(parentBody.handle);
    if (index === undefined) return;
    const slot = this.bodySlots[index];
    if (!slot || !slot.active || !slot.enabled || slot.type === "static") {
      return;
    }
    this.islandUnion(this.islandVisitorIndex, index);
    if (this.islandSeen[index] !== this.islandEpoch) {
      this.islandSeen[index] = this.islandEpoch;
      this.islandQueue.push(index);
    }
  };

  private readonly hasher = new StateHasher();
  private readonly scratchVec: Vec3 = vec3();
  private readonly scratchVec2: Vec3 = vec3();
  private readonly scratchQuat: Quat = quat();
  private readonly ray: RAPIER.Ray;
  private readonly castBall: RAPIER.Ball;
  private readonly overlapCuboid: RAPIER.Cuboid;
  private readonly filterInfo: ColliderFilterInfo = {
    layer: 0,
    mask: 0,
    sensor: false,
  };

  private readonly bindingById = new Map<number, SceneBinding>();
  private readonly bindingList: SceneBinding[] = [];
  private readonly compareBindings = (a: SceneBinding, b: SceneBinding) =>
    a.bodyIndex - b.bodyIndex;

  private readonly hooks: RAPIER.PhysicsHooks;
  private readonly onCollisionEvent: (
    handle1: number,
    handle2: number,
    started: boolean,
  ) => void;

  constructor(options?: RapierWorldOptions) {
    if (!isRapierReady()) {
      throw physicsError(
        "E_CONTRACT",
        "Rapier is not initialized: await initRapierPhysics() before creating a world",
      );
    }
    const resolved = resolveOptions(options);
    this.gravity = resolved.gravity;
    this.fixedDt = resolved.fixedDt;
    this.solver = resolved.solver;
    this.sleep = resolved.sleep;
    this.layerNames = resolved.layers;
    this.maxDynamicBodies = resolved.maxDynamicBodies;
    this.maxColliders = resolved.maxColliders;
    this.debug = resolved.debug;

    this.ray = new RAPIER_MODULE.Ray(vec3(), vec3(0, 0, -1));
    this.castBall = new RAPIER_MODULE.Ball(0.5);
    this.overlapCuboid = new RAPIER_MODULE.Cuboid(0.5, 0.5, 0.5);
    this.world = new RAPIER_MODULE.World(this.gravity);
    this.eventQueue = new RAPIER_MODULE.EventQueue(false);
    this.configureWorld();

    for (let i = 0; i < PHYSICS_MAX_CONTACT_EVENTS; i += 1) {
      this.contactPool.push({
        colliderA: INVALID_COLLIDER_HANDLE,
        colliderB: INVALID_COLLIDER_HANDLE,
        bodyA: INVALID_BODY_HANDLE,
        bodyB: INVALID_BODY_HANDLE,
      });
      this.triggerPool.push({
        colliderA: INVALID_COLLIDER_HANDLE,
        colliderB: INVALID_COLLIDER_HANDLE,
        bodyA: INVALID_BODY_HANDLE,
        bodyB: INVALID_BODY_HANDLE,
        phase: "enter",
      });
    }

    this.hooks = {
      filterContactPair: (collider1: number, collider2: number) =>
        this.filterPair(collider1, collider2),
      filterIntersectionPair: (collider1: number, collider2: number) =>
        this.acceptRawPair(collider1, collider2),
    };
    this.onCollisionEvent = (
      handle1: number,
      handle2: number,
      started: boolean,
    ): void => {
      this.recordCollisionEvent(handle1, handle2, started);
    };
  }

  /* ---------------------------------------------------------------- error */

  /** Internal: build a contract-coded error (used by controllers). */
  _error(code: PhysicsErrorCode, message: string): Error {
    return physicsError(code, message);
  }

  /** Internal: the underlying Rapier world. */
  _rapierWorld(): RAPIER.World {
    return this.world;
  }

  /** Internal: Rapier body for a handle, or null when stale. */
  _bodyObject(handle: BodyHandle): RAPIER.RigidBody | null {
    const slot = this.resolveBody(handle);
    return slot?.body ?? null;
  }

  /** Internal: Rapier collider for a handle, or null when stale. */
  _colliderObject(handle: ColliderHandle): RAPIER.Collider | null {
    const slot = this.resolveCollider(handle);
    return slot?.collider ?? null;
  }

  /** Internal: shared scratch info for filter predicates; never retained. */
  _colliderFilterInfo(rawHandle: number): ColliderFilterInfo | null {
    const slot = this.resolveRawCollider(rawHandle);
    if (slot === null) return null;
    this.filterInfo.layer = slot.layer;
    this.filterInfo.mask = slot.mask;
    this.filterInfo.sensor = slot.sensor;
    return this.filterInfo;
  }

  /** Internal: refresh a slot pose after a controller teleport. */
  _syncPose(handle: BodyHandle): void {
    const slot = this.resolveBody(handle);
    const body = slot?.body;
    if (!slot || !body) return;
    body.translation(slot.curPosition);
    body.rotation(slot.curRotation);
    copyVec3(slot.prevPosition, slot.curPosition);
    copyQuat(slot.prevRotation, slot.curRotation);
  }

  /* ---------------------------------------------------------------- bodies */

  createBody(desc: BodyDesc): BodyHandle {
    this.ensureMutable();
    if (
      desc.type !== "static" &&
      desc.type !== "dynamic" &&
      desc.type !== "kinematicPosition" &&
      desc.type !== "kinematicVelocity"
    ) {
      throw this._error("E_CONTRACT", "createBody: unknown body type");
    }
    const type = desc.type;
    const position = desc.position ?? vec3();
    if (!isFiniteVec3(position)) {
      throw this._error("E_CONTRACT", "createBody: position must be finite");
    }
    const rotation = quat();
    if (desc.rotation !== undefined) {
      if (!isFiniteQuat(desc.rotation)) {
        throw this._error("E_CONTRACT", "createBody: rotation must be finite");
      }
      copyQuat(rotation, desc.rotation);
      if (!normalizeQuatInPlace(rotation)) {
        throw this._error("E_CONTRACT", "createBody: rotation must be non-zero");
      }
    }
    const linearVelocity = desc.linearVelocity ?? vec3();
    const angularVelocity = desc.angularVelocity ?? vec3();
    if (!isFiniteVec3(linearVelocity) || !isFiniteVec3(angularVelocity)) {
      throw this._error("E_CONTRACT", "createBody: velocities must be finite");
    }
    if (
      type === "static" &&
      (desc.linearVelocity !== undefined || desc.angularVelocity !== undefined)
    ) {
      throw this._error(
        "E_CONTRACT",
        "createBody: velocity is rejected on a static body",
      );
    }
    if (desc.mass !== undefined && type !== "dynamic" && desc.mass !== 0) {
      throw this._error("E_CONTRACT", "createBody: mass is dynamic-only");
    }
    if (desc.mass !== undefined && (!isFiniteNumber(desc.mass) || desc.mass < 0)) {
      throw this._error("E_CONTRACT", "createBody: mass must be >= 0");
    }
    const linearDamping = desc.linearDamping ?? 0;
    const angularDamping =
      desc.angularDamping ?? PHYSICS_DEFAULT_ANGULAR_DAMPING;
    if (linearDamping < 0 || linearDamping > 1) {
      throw this._error(
        "E_CONTRACT",
        "createBody: linearDamping must be within 0..1",
      );
    }
    if (angularDamping < 0 || angularDamping > 1) {
      throw this._error(
        "E_CONTRACT",
        "createBody: angularDamping must be within 0..1",
      );
    }
    const gravityScale = desc.gravityScale ?? 1;
    if (!isFiniteNumber(gravityScale)) {
      throw this._error("E_CONTRACT", "createBody: gravityScale must be finite");
    }
    if (desc.userData !== undefined && !isU32(desc.userData)) {
      throw this._error(
        "E_CONTRACT",
        "createBody: userData must be an unsigned 32-bit integer",
      );
    }
    if (type === "dynamic" && this.activeDynamicCount >= this.maxDynamicBodies) {
      this.stats.droppedBodies += 1;
      return INVALID_BODY_HANDLE;
    }

    const bodyDesc = new RAPIER_MODULE.RigidBodyDesc(toDynamicType(type))
      .setTranslation(position.x, position.y, position.z)
      .setRotation(rotation)
      .setLinvel(linearVelocity.x, linearVelocity.y, linearVelocity.z)
      .setAngvel(angularVelocity)
      .setLinearDamping(linearDamping)
      .setAngularDamping(angularDamping)
      .setGravityScale(gravityScale)
      .setCcdEnabled(desc.ccd === true)
      .setCanSleep(false)
      .setEnabled(desc.enabled !== false);
    const body = this.world.createRigidBody(bodyDesc);
    const slotIndex = this.allocateBodySlot();
    const slot = this.bodySlots[slotIndex]!;
    slot.active = true;
    slot.type = type;
    slot.body = body;
    slot.handle = this.makeBodyHandle(slotIndex, slot.generation);
    slot.enabled = desc.enabled !== false;
    slot.userData = desc.userData ?? 0;
    slot.ccd = desc.ccd === true;
    slot.canSleep = desc.canSleep !== false;
    slot.sleepTimer = 0;
    slot.sleepGravityScale = gravityScale;
    slot.sleeping = false;
    slot.colliderCount = 0;
    slot.colliderSlots.length = 0;
    slot.explicitMass = type === "dynamic" ? (desc.mass ?? 0) : 0;
    slot.volume = 0;
    slot.vehicleSlot = -1;
    slot.characterSlot = -1;
    copyVec3(slot.curPosition, position);
    copyQuat(slot.curRotation, rotation);
    copyVec3(slot.prevPosition, position);
    copyQuat(slot.prevRotation, rotation);
    this.bodyIndexByRaw.set(body.handle, slotIndex);
    this.activeBodyCount += 1;
    if (type === "dynamic") {
      this.activeDynamicCount += 1;
      if (slot.enabled) this.awakeDynamicCount += 1;
    }
    this.stats.bodyCount = this.activeBodyCount;
    this.stats.awakeBodyCount = this.awakeDynamicCount;
    return slot.handle;
  }

  destroyBody(handle: BodyHandle): void {
    const slot = this.resolveBody(handle);
    if (slot === null) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.characterSlot >= 0) {
      const character = this.characters[slot.characterSlot];
      if (character) {
        if (character.active) {
          this.world.removeCharacterController(character.rawController());
          character.deactivate();
        }
        this.characters[slot.characterSlot] = null;
        this.freeCharacterSlots.push(slot.characterSlot);
      }
      slot.characterSlot = -1;
    }
    if (slot.vehicleSlot >= 0) {
      const record = this.vehicleSlots[slot.vehicleSlot];
      if (record) {
        if (record.vehicle) record.vehicle.deactivate(this);
        record.vehicle = null;
        record.generation += 1;
        record.handle = INVALID_VEHICLE_HANDLE;
        this.freeVehicleSlots.push(slot.vehicleSlot);
      }
      slot.vehicleSlot = -1;
    }
    for (let i = 0; i < this.jointSlots.length; i += 1) {
      const joint = this.jointSlots[i]!;
      if (
        joint.active &&
        (joint.bodyA === slot.index || joint.bodyB === slot.index)
      ) {
        joint.active = false;
        joint.joint = null;
        joint.generation += 1;
        this.activeJointCount -= 1;
        this.freeJointSlots.push(i);
      }
    }
    for (let i = 0; i < slot.colliderSlots.length; i += 1) {
      const collider = this.colliderSlots[slot.colliderSlots[i]!];
      if (collider?.active) this.releaseColliderSlot(collider);
    }
    slot.colliderSlots.length = 0;
    slot.colliderCount = 0;
    const body = slot.body;
    if (body) {
      this.bodyIndexByRaw.delete(body.handle);
      this.world.removeRigidBody(body);
    }
    const wasDynamic = slot.type === "dynamic";
    const wasAwake = !slot.sleeping && slot.enabled;
    slot.active = false;
    slot.body = null;
    slot.generation += 1;
    slot.handle = INVALID_BODY_HANDLE;
    slot.enabled = false;
    this.activeBodyCount -= 1;
    if (wasDynamic) {
      this.activeDynamicCount -= 1;
      if (wasAwake) {
        this.awakeDynamicCount = Math.max(0, this.awakeDynamicCount - 1);
      }
    }
    this.freeBodySlots.push(slot.index);
    this.stats.bodyCount = this.activeBodyCount;
    this.stats.awakeBodyCount = this.awakeDynamicCount;
  }

  setEnabled(handle: BodyHandle, enabled: boolean): void {
    const slot = this.resolveBody(handle);
    const body = slot?.body;
    if (!slot || !body) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.enabled === enabled) return;
    slot.enabled = enabled;
    body.setEnabled(enabled);
    if (enabled && slot.type === "dynamic") {
      // A slept body has its gravity scale zeroed; wake the island through
      // the overlay so the authored scale is restored, not just the flag.
      if (slot.sleeping) this.wakeIsland(slot.index);
      body.wakeUp();
      slot.sleeping = false;
      slot.sleepTimer = 0;
    }
  }

  readBody(handle: BodyHandle, out: BodyState): boolean {
    const slot = this.resolveBody(handle);
    const body = slot?.body;
    if (!slot || !body) return false;
    body.translation(out.position);
    body.rotation(out.rotation);
    body.linvel(out.linearVelocity);
    body.angvel(out.angularVelocity);
    out.sleeping = body.isSleeping();
    out.enabled = slot.enabled;
    out.mass = body.mass();
    out.userData = slot.userData;
    return true;
  }

  setTransform(handle: BodyHandle, position: Vec3, rotation: Quat): void {
    if (!isFiniteVec3(position)) {
      throw this._error("E_CONTRACT", "setTransform: position must be finite");
    }
    const pose = quat();
    if (!isFiniteQuat(rotation)) {
      throw this._error("E_CONTRACT", "setTransform: rotation must be finite");
    }
    copyQuat(pose, rotation);
    if (!normalizeQuatInPlace(pose)) {
      throw this._error("E_CONTRACT", "setTransform: rotation must be non-zero");
    }
    const slot = this.resolveBody(handle);
    const body = slot?.body;
    if (!slot || !body) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.sleeping) this.wakeIsland(slot.index);
    body.setTranslation(position, true);
    body.setRotation(pose, true);
    if (slot.type === "kinematicPosition") {
      body.setNextKinematicTranslation(position);
      body.setNextKinematicRotation(pose);
    }
    copyVec3(slot.curPosition, position);
    copyQuat(slot.curRotation, pose);
    copyVec3(slot.prevPosition, position);
    copyQuat(slot.prevRotation, pose);
    slot.sleeping = false;
    slot.sleepTimer = 0;
  }

  setLinearVelocity(handle: BodyHandle, velocity: Vec3): void {
    if (!isFiniteVec3(velocity)) {
      throw this._error(
        "E_CONTRACT",
        "setLinearVelocity: velocity must be finite",
      );
    }
    const slot = this.resolveBody(handle);
    const body = slot?.body;
    if (!slot || !body) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.type === "static") return;
    if (slot.sleeping) this.wakeIsland(slot.index);
    body.setLinvel(velocity, true);
    slot.sleeping = false;
    slot.sleepTimer = 0;
  }

  setAngularVelocity(handle: BodyHandle, velocity: Vec3): void {
    if (!isFiniteVec3(velocity)) {
      throw this._error(
        "E_CONTRACT",
        "setAngularVelocity: velocity must be finite",
      );
    }
    const slot = this.resolveBody(handle);
    const body = slot?.body;
    if (!slot || !body) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.type === "static") return;
    if (slot.sleeping) this.wakeIsland(slot.index);
    body.setAngvel(velocity, true);
    slot.sleeping = false;
    slot.sleepTimer = 0;
  }

  applyForce(handle: BodyHandle, force: Vec3, wake = true): void {
    if (!isFiniteVec3(force)) {
      throw this._error("E_CONTRACT", "applyForce: force must be finite");
    }
    const slot = this.resolveBody(handle);
    const body = slot?.body;
    if (!slot || !body) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.type !== "dynamic") return;
    if (wake && slot.sleeping) this.wakeIsland(slot.index);
    body.addForce(force, wake);
    if (wake) {
      slot.sleeping = false;
      slot.sleepTimer = 0;
    }
  }

  applyImpulse(handle: BodyHandle, impulse: Vec3, wake = true): void {
    if (!isFiniteVec3(impulse)) {
      throw this._error("E_CONTRACT", "applyImpulse: impulse must be finite");
    }
    const slot = this.resolveBody(handle);
    const body = slot?.body;
    if (!slot || !body) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.type !== "dynamic") return;
    if (wake && slot.sleeping) this.wakeIsland(slot.index);
    body.applyImpulse(impulse, wake);
    if (wake) {
      slot.sleeping = false;
      slot.sleepTimer = 0;
    }
  }

  applyTorqueImpulse(handle: BodyHandle, impulse: Vec3): void {
    if (!isFiniteVec3(impulse)) {
      throw this._error(
        "E_CONTRACT",
        "applyTorqueImpulse: impulse must be finite",
      );
    }
    const slot = this.resolveBody(handle);
    const body = slot?.body;
    if (!slot || !body) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.type !== "dynamic") return;
    if (slot.sleeping) this.wakeIsland(slot.index);
    body.applyTorqueImpulse(impulse, true);
    slot.sleeping = false;
    slot.sleepTimer = 0;
  }

  clearForces(handle: BodyHandle): void {
    const slot = this.resolveBody(handle);
    const body = slot?.body;
    if (!slot || !body) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.type !== "dynamic") return;
    body.resetForces(false);
    body.resetTorques(false);
  }

  /* -------------------------------------------------------------- colliders */

  createCollider(bodyHandle: BodyHandle, desc: ColliderDesc): ColliderHandle {
    this.ensureMutable();
    const bodySlot = this.resolveBody(bodyHandle);
    const body = bodySlot?.body;
    if (!bodySlot || !body) {
      this.stats.staleHandles += 1;
      return INVALID_COLLIDER_HANDLE;
    }
    if (bodySlot.colliderCount >= PHYSICS_MAX_COLLIDERS_PER_BODY) {
      throw this._error(
        "E_CONTRACT",
        `createCollider: a body may have at most ${PHYSICS_MAX_COLLIDERS_PER_BODY} colliders`,
      );
    }
    if (this.activeColliderCount >= this.maxColliders) {
      this.stats.droppedColliders += 1;
      return INVALID_COLLIDER_HANDLE;
    }
    // 07 §3.1: trimesh colliders are static or kinematic only.
    if (desc.shape.kind === "trimesh" && bodySlot.type === "dynamic") {
      throw this._error(
        "E_ASSET_FORMAT",
        "createCollider: a dynamic body cannot hold a trimesh collider",
      );
    }
    const shape = this.makeShape(desc.shape);
    const friction = desc.friction ?? PHYSICS_DEFAULT_FRICTION;
    const restitution = desc.restitution ?? PHYSICS_DEFAULT_RESTITUTION;
    const density = desc.density ?? PHYSICS_DEFAULT_DENSITY;
    if (!isFiniteNumber(friction) || friction < 0 || friction > 2) {
      throw this._error(
        "E_CONTRACT",
        "createCollider: friction must be within 0..2",
      );
    }
    if (!isFiniteNumber(restitution) || restitution < 0 || restitution > 1) {
      throw this._error(
        "E_CONTRACT",
        "createCollider: restitution must be within 0..1",
      );
    }
    if (!isFiniteNumber(density) || density < 0) {
      throw this._error("E_CONTRACT", "createCollider: density must be >= 0");
    }
    const sensor = desc.sensor === true;
    const layer = desc.layer ?? 0;
    const mask = desc.mask ?? PHYSICS_DEFAULT_LAYER_MASK;
    if (!Number.isInteger(layer) || layer < 0 || layer >= PHYSICS_MAX_LAYERS) {
      throw this._error(
        "E_CONTRACT",
        `createCollider: layer must be an integer in 0..${PHYSICS_MAX_LAYERS - 1}`,
      );
    }
    if (!isU32(mask)) {
      throw this._error(
        "E_CONTRACT",
        "createCollider: mask must be an unsigned 32-bit integer",
      );
    }
    const localPosition = desc.localPosition ?? vec3();
    const localRotation = quat();
    if (!isFiniteVec3(localPosition)) {
      throw this._error(
        "E_CONTRACT",
        "createCollider: localPosition must be finite",
      );
    }
    if (desc.localRotation !== undefined) {
      if (!isFiniteQuat(desc.localRotation)) {
        throw this._error(
          "E_CONTRACT",
          "createCollider: localRotation must be finite",
        );
      }
      copyQuat(localRotation, desc.localRotation);
      if (!normalizeQuatInPlace(localRotation)) {
        throw this._error(
          "E_CONTRACT",
          "createCollider: localRotation must be non-zero",
        );
      }
    }
    const volume = shapeVolume(shape, sensor);
    const useExplicitMass =
      bodySlot.type === "dynamic" && bodySlot.explicitMass > 0;
    const colliderDesc = this.makeColliderDesc(shape, {
      friction,
      restitution,
      density: useExplicitMass ? 0 : density,
      sensor,
      localPosition,
      localRotation,
    });
    const collider = this.world.createCollider(colliderDesc, body);
    const slotIndex = this.allocateColliderSlot();
    const slot = this.colliderSlots[slotIndex]!;
    slot.active = true;
    slot.collider = collider;
    slot.bodyIndex = bodySlot.index;
    slot.bodyGeneration = bodySlot.generation;
    slot.handle = this.makeColliderHandle(slotIndex, slot.generation);
    slot.shape = shape;
    copyVec3(slot.localPosition, localPosition);
    copyQuat(slot.localRotation, localRotation);
    slot.friction = friction;
    slot.restitution = restitution;
    slot.sensor = sensor;
    slot.layer = layer;
    slot.mask = mask;
    slot.density = density;
    slot.volume = volume;
    this.colliderIndexByRaw.set(collider.handle, slotIndex);
    bodySlot.colliderSlots.push(slotIndex);
    bodySlot.colliderCount += 1;
    bodySlot.volume += volume;
    this.activeColliderCount += 1;
    this.stats.colliderCount = this.activeColliderCount;
    this.syncBodyMass(bodySlot);
    return slot.handle;
  }

  destroyCollider(handle: ColliderHandle): void {
    const slot = this.resolveCollider(handle);
    if (slot === null) {
      this.stats.staleHandles += 1;
      return;
    }
    this.releaseColliderSlot(slot);
  }

  readCollider(handle: ColliderHandle, out: ColliderState): boolean {
    const slot = this.resolveCollider(handle);
    if (slot === null) return false;
    const bodySlot = this.bodySlots[slot.bodyIndex];
    const body = bodySlot?.body;
    if (!bodySlot || !body) return false;
    body.translation(this.scratchVec);
    body.rotation(this.scratchQuat);
    computeWorldAabb(
      out.worldAabbMin,
      out.worldAabbMax,
      slot.shape,
      slot.localPosition,
      slot.localRotation,
      this.scratchVec,
      this.scratchQuat,
    );
    out.body = bodySlot.handle;
    out.friction = slot.friction;
    out.restitution = slot.restitution;
    out.sensor = slot.sensor;
    out.layer = slot.layer;
    out.mask = slot.mask;
    return true;
  }

  /* ---------------------------------------------------------------- joints */

  createJoint(desc: JointDesc): JointHandle {
    this.ensureMutable();
    if (this.activeJointCount >= PHYSICS_MAX_JOINTS) {
      throw this._error(
        "E_CONTRACT",
        `createJoint: the world holds at most ${PHYSICS_MAX_JOINTS} joints`,
      );
    }
    const slotA = this.resolveBody(desc.bodyA);
    const slotB = this.resolveBody(desc.bodyB);
    if (!slotA || !slotB || !slotA.body || !slotB.body) {
      throw this._error("E_STALE_HANDLE", "createJoint: body handle is stale");
    }
    if (slotA.index === slotB.index) {
      throw this._error(
        "E_CONTRACT",
        "createJoint: bodyA and bodyB must differ",
      );
    }
    const anchorA = desc.anchorA ?? vec3();
    const anchorB = desc.anchorB ?? vec3();
    if (!isFiniteVec3(anchorA) || !isFiniteVec3(anchorB)) {
      throw this._error("E_CONTRACT", "createJoint: anchors must be finite");
    }
    const collideConnected = desc.collideConnected === true;
    let data: RAPIER.JointData;
    let unit: RAPIER.UnitImpulseJoint | null = null;

    switch (desc.kind) {
      case "fixed": {
        const rotationA = this.readRotation(desc.rotationA, "rotationA");
        const rotationB = this.readRotation(desc.rotationB, "rotationB");
        data = RAPIER_MODULE.JointData.fixed(
          anchorA,
          rotationA,
          anchorB,
          rotationB,
        );
        break;
      }
      case "ball":
        data = RAPIER_MODULE.JointData.spherical(anchorA, anchorB);
        break;
      case "hinge": {
        const axisA = this.readAxis(desc.axisA, "axisA");
        const axisB = this.readAxis(desc.axisB, "axisB");
        data = RAPIER_MODULE.JointData.revoluteWithAxes(
          anchorA,
          anchorB,
          axisA,
          axisB,
        );
        break;
      }
      case "slider": {
        const axisA = this.readAxis(desc.axisA, "axisA");
        const axisB = this.readAxis(desc.axisB, "axisB");
        if (!sameAxis(axisA, axisB)) {
          throw this._error(
            "E_UNSUPPORTED_FEATURE",
            "createJoint: slider requires axisA and axisB to point the same way",
          );
        }
        data = RAPIER_MODULE.JointData.prismatic(anchorA, anchorB, axisA);
        break;
      }
      case "distance": {
        if (!isFiniteNumber(desc.length) || desc.length < 0) {
          throw this._error(
            "E_CONTRACT",
            "createJoint: distance length must be >= 0",
          );
        }
        const stiffness = desc.stiffness ?? 0;
        const damping = desc.damping ?? 0;
        if (
          !isFiniteNumber(stiffness) ||
          stiffness < 0 ||
          !isFiniteNumber(damping) ||
          damping < 0
        ) {
          throw this._error(
            "E_CONTRACT",
            "createJoint: stiffness and damping must be >= 0",
          );
        }
        data =
          stiffness > 0
            ? RAPIER_MODULE.JointData.spring(
                desc.length,
                stiffness,
                damping,
                anchorA,
                anchorB,
              )
            : RAPIER_MODULE.JointData.rope(
                Math.max(desc.length, 1e-6),
                anchorA,
                anchorB,
              );
        break;
      }
      default:
        throw this._error("E_CONTRACT", "createJoint: unknown joint kind");
    }

    const rawJoint = this.world.createImpulseJoint(
      data,
      slotA.body,
      slotB.body,
      true,
    );
    rawJoint.setContactsEnabled(collideConnected);
    if (desc.kind === "hinge" || desc.kind === "slider") {
      unit = rawJoint as RAPIER.UnitImpulseJoint;
      if (desc.limit !== undefined) {
        const limit = desc.limit;
        if (
          !isFiniteNumber(limit.lower) ||
          !isFiniteNumber(limit.upper) ||
          limit.lower > limit.upper
        ) {
          throw this._error(
            "E_CONTRACT",
            "createJoint: limit must have finite lower <= upper",
          );
        }
        unit.setLimits(limit.lower, limit.upper);
      }
      if (desc.motor !== undefined) {
        this.applyMotor(unit, desc.motor);
      }
    }

    const slotIndex = this.allocateJointSlot();
    const slot = this.jointSlots[slotIndex]!;
    slot.active = true;
    slot.joint = rawJoint;
    slot.handle = this.makeJointHandle(slotIndex, slot.generation);
    slot.bodyA = slotA.index;
    slot.bodyB = slotB.index;
    slot.kind = desc.kind;
    this.activeJointCount += 1;
    return slot.handle;
  }

  destroyJoint(handle: JointHandle): void {
    const slot = this.resolveJoint(handle);
    if (slot === null) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.joint) this.world.removeImpulseJoint(slot.joint, true);
    slot.active = false;
    slot.joint = null;
    slot.generation += 1;
    this.activeJointCount -= 1;
    this.freeJointSlots.push(slot.index);
  }

  setJointMotor(handle: JointHandle, motor: JointMotor | null): void {
    const slot = this.resolveJoint(handle);
    if (slot === null) {
      this.stats.staleHandles += 1;
      return;
    }
    if (slot.kind !== "hinge" && slot.kind !== "slider") {
      throw this._error(
        "E_UNSUPPORTED_FEATURE",
        `setJointMotor: ${slot.kind} joints have no motor`,
      );
    }
    const unit = slot.joint as RAPIER.UnitImpulseJoint | null;
    if (!unit) return;
    if (motor === null) {
      unit.setMotorMaxForce(0);
      unit.configureMotor(0, 0, 0, 0);
      return;
    }
    this.applyMotor(unit, motor);
  }

  readJoint(handle: JointHandle, out: JointState): boolean {
    const slot = this.resolveJoint(handle);
    if (slot === null) return false;
    const a = this.bodySlots[slot.bodyA];
    const b = this.bodySlots[slot.bodyB];
    const bodyA = a?.body;
    const bodyB = b?.body;
    // Rapier exposes neither constraint error nor applied motor impulse.
    out.error = 0;
    out.motorImpulse = 0;
    out.sleeping =
      bodyA != null &&
      bodyB != null &&
      bodyA.isSleeping() &&
      bodyB.isSleeping();
    return true;
  }

  /* -------------------------------------------------------------- vehicles */

  createVehicle(desc: VehicleDesc): VehicleHandle {
    this.ensureMutable();
    const slot = this.resolveBody(desc.chassis);
    const body = slot?.body;
    if (!slot || !body) {
      throw this._error("E_STALE_HANDLE", "createVehicle: chassis is stale");
    }
    if (slot.type !== "dynamic") {
      throw this._error("E_CONTRACT", "createVehicle: chassis must be dynamic");
    }
    if (slot.vehicleSlot >= 0) {
      throw this._error(
        "E_CONTRACT",
        "createVehicle: chassis already owns a vehicle",
      );
    }
    validateVehicleDesc(this, desc);
    let hasBox = false;
    for (let i = 0; i < slot.colliderSlots.length; i += 1) {
      const collider = this.colliderSlots[slot.colliderSlots[i]!];
      if (collider?.active && collider.shape.kindCode === SHAPE_BOX) {
        hasBox = true;
        break;
      }
    }
    if (!hasBox) {
      throw this._error(
        "E_CONTRACT",
        "createVehicle: chassis needs at least one box collider",
      );
    }
    const mass = body.mass();
    if (!(mass > 0)) {
      throw this._error(
        "E_CONTRACT",
        "createVehicle: chassis must have positive mass",
      );
    }
    const slotIndex = this.allocateVehicleSlot();
    const record = this.vehicleSlots[slotIndex]!;
    const handle = this.makeVehicleHandle(slotIndex, record.generation);
    const vehicle = new RapierVehicle(
      this,
      body,
      mass,
      slot.index,
      desc,
      handle,
    );
    record.vehicle = vehicle;
    record.handle = handle;
    slot.vehicleSlot = slotIndex;
    return handle;
  }

  destroyVehicle(handle: VehicleHandle): void {
    const record = this.resolveVehicle(handle);
    if (record === null) {
      this.stats.staleHandles += 1;
      return;
    }
    const index = this.vehicleSlots.indexOf(record);
    const vehicle = record.vehicle;
    if (vehicle) {
      const slot = this.bodySlots[vehicle.chassisIndex];
      if (slot && slot.vehicleSlot === index) slot.vehicleSlot = -1;
      vehicle.deactivate(this);
    }
    record.vehicle = null;
    record.generation += 1;
    record.handle = INVALID_VEHICLE_HANDLE;
    this.freeVehicleSlots.push(index);
  }

  setVehicleInput(handle: VehicleHandle, input: VehicleInput): void {
    const record = this.resolveVehicle(handle);
    if (record === null || record.vehicle === null) {
      this.stats.staleHandles += 1;
      return;
    }
    record.vehicle.setInput(input);
  }

  readVehicle(handle: VehicleHandle, out: VehicleState): boolean {
    const record = this.resolveVehicle(handle);
    if (record === null || record.vehicle === null) return false;
    record.vehicle.read(out);
    return true;
  }

  /* ------------------------------------------------------------ characters */

  createCharacter(desc: CharacterControllerDesc): CharacterController {
    this.ensureMutable();
    if (!isFiniteNumber(desc.radius) || desc.radius <= 0) {
      throw this._error("E_CONTRACT", "createCharacter: radius must be > 0");
    }
    if (!isFiniteNumber(desc.halfHeight) || desc.halfHeight <= 0) {
      throw this._error(
        "E_CONTRACT",
        "createCharacter: halfHeight must be > 0",
      );
    }
    if (!isFiniteVec3(desc.position)) {
      throw this._error(
        "E_CONTRACT",
        "createCharacter: position must be finite",
      );
    }
    if (desc.rotation !== undefined && !isFiniteQuat(desc.rotation)) {
      throw this._error(
        "E_CONTRACT",
        "createCharacter: rotation must be finite",
      );
    }
    const slope = desc.slopeLimitDegrees ?? 45;
    if (!isFiniteNumber(slope) || slope < 0 || slope > 89) {
      throw this._error(
        "E_CONTRACT",
        "createCharacter: slopeLimitDegrees must be within 0..89",
      );
    }
    const stepOffset = desc.stepOffset ?? 0.3;
    if (!isFiniteNumber(stepOffset) || stepOffset < 0) {
      throw this._error(
        "E_CONTRACT",
        "createCharacter: stepOffset must be >= 0",
      );
    }
    const snap = desc.snapToGround ?? 0.1;
    if (!isFiniteNumber(snap) || snap < 0) {
      throw this._error(
        "E_CONTRACT",
        "createCharacter: snapToGround must be >= 0",
      );
    }
    const gravity = desc.gravity ?? 9.81;
    if (!isFiniteNumber(gravity) || gravity < 0) {
      throw this._error("E_CONTRACT", "createCharacter: gravity must be >= 0");
    }
    const mass = desc.mass ?? 70;
    if (!isFiniteNumber(mass) || mass <= 0) {
      throw this._error("E_CONTRACT", "createCharacter: mass must be > 0");
    }
    const pushForce = desc.pushForce ?? 0;
    if (!isFiniteNumber(pushForce) || pushForce < 0) {
      throw this._error(
        "E_CONTRACT",
        "createCharacter: pushForce must be >= 0",
      );
    }
    if (desc.filter !== undefined) this.validateQueryFilter(desc.filter);
    const character = new RapierCharacter(this, desc);
    const slotIndex = this.allocateCharacterSlot();
    this.characters[slotIndex] = character;
    const bodySlot = this.resolveBody(character.body);
    if (bodySlot) bodySlot.characterSlot = slotIndex;
    return character;
  }

  destroyCharacter(controller: CharacterController): void {
    const index = this.characters.indexOf(controller as RapierCharacter);
    if (index < 0) return;
    const character = this.characters[index];
    if (!character) return;
    if (character.active) {
      this.world.removeCharacterController(character.rawController());
      character.deactivate();
    }
    this.characters[index] = null;
    this.freeCharacterSlots.push(index);
    const bodySlot = this.resolveBody(character.body);
    if (bodySlot) {
      bodySlot.characterSlot = -1;
      this.destroyBody(character.body);
    }
  }

  /* ---------------------------------------------------------------- queries */

  raycast(input: RaycastInput, out: RaycastHit): boolean {
    const query = this.validateRay(input);
    this.ray.origin.x = input.origin.x;
    this.ray.origin.y = input.origin.y;
    this.ray.origin.z = input.origin.z;
    this.ray.dir.x = query.direction.x;
    this.ray.dir.y = query.direction.y;
    this.ray.dir.z = query.direction.z;
    const hit = this.world.castRayAndGetNormal(
      this.ray,
      input.maxDistance,
      input.solid !== false,
      query.context.flags,
      undefined,
      query.context.excludeCollider,
      query.context.excludeBody,
      query.context.predicate,
    );
    if (hit === null) return false;
    const slot = this.resolveRawCollider(hit.collider.handle);
    if (slot === null) return false;
    this.writeRayHit(
      out,
      slot,
      hit.timeOfImpact,
      input.origin,
      query.direction,
      hit.normal,
      hit.featureType,
      hit.featureId,
    );
    return true;
  }

  raycastAll(input: RaycastInput, out: RaycastHit[]): number {
    const query = this.validateRay(input);
    this.ray.origin.x = input.origin.x;
    this.ray.origin.y = input.origin.y;
    this.ray.origin.z = input.origin.z;
    this.ray.dir.x = query.direction.x;
    this.ray.dir.y = query.direction.y;
    this.ray.dir.z = query.direction.z;
    let count = 0;
    this.world.intersectionsWithRay(
      this.ray,
      input.maxDistance,
      input.solid !== false,
      (hit): boolean => {
        const slot = this.resolveRawCollider(hit.collider.handle);
        if (slot === null) return true;
        const record = out[count];
        if (record === undefined) {
          out[count] = {
            collider: slot.handle,
            body: this.bodySlots[slot.bodyIndex]!.handle,
            distance: 0,
            point: vec3(),
            normal: vec3(),
            triangleIndex: -1,
            sensor: false,
          };
        }
        this.writeRayHit(
          out[count]!,
          slot,
          hit.timeOfImpact,
          input.origin,
          query.direction,
          hit.normal,
          hit.featureType,
          hit.featureId,
        );
        count += 1;
        return true;
      },
      query.context.flags,
      undefined,
      query.context.excludeCollider,
      query.context.excludeBody,
      query.context.predicate,
    );
    for (let i = 1; i < count; i += 1) {
      const value = out[i]!;
      let j = i - 1;
      while (j >= 0 && out[j]!.distance > value.distance) {
        out[j + 1] = out[j]!;
        j -= 1;
      }
      out[j + 1] = value;
    }
    out.length = count;
    return count;
  }

  sphereCast(radius: number, input: RaycastInput, out: ShapeCastHit): boolean {
    if (!isFiniteNumber(radius) || radius <= 0) {
      throw this._error("E_CONTRACT", "sphereCast: radius must be > 0");
    }
    const query = this.validateRay(input);
    this.castBall.radius = radius;
    const hit = this.world.castShape(
      input.origin,
      quat(),
      query.direction,
      this.castBall,
      0,
      input.maxDistance,
      true,
      query.context.flags,
      undefined,
      query.context.excludeCollider,
      query.context.excludeBody,
      query.context.predicate,
    );
    if (hit === null) return false;
    const slot = this.resolveRawCollider(hit.collider.handle);
    if (slot === null) return false;
    const travel = hit.time_of_impact;
    this.writeRayHit(
      out,
      slot,
      travel,
      input.origin,
      query.direction,
      hit.normal1,
      3,
      undefined,
    );
    out.travel = travel;
    // Rapier's shape-cast hit exposes no feature id.
    out.triangleIndex = -1;
    return true;
  }

  overlapSphere(
    center: Vec3,
    radius: number,
    query: QueryFilter,
    out: ColliderHandle[],
  ): number {
    if (!isFiniteVec3(center)) {
      throw this._error("E_CONTRACT", "overlapSphere: center must be finite");
    }
    if (!isFiniteNumber(radius) || radius <= 0) {
      throw this._error("E_CONTRACT", "overlapSphere: radius must be > 0");
    }
    const context = this.makeQueryContext(query);
    this.castBall.radius = radius;
    let count = 0;
    this.world.intersectionsWithShape(
      center,
      quat(),
      this.castBall,
      (collider): boolean => {
        const slot = this.resolveRawCollider(collider.handle);
        if (slot !== null) {
          out[count] = slot.handle;
          count += 1;
        }
        return true;
      },
      context.flags,
      undefined,
      context.excludeCollider,
      context.excludeBody,
      context.predicate,
    );
    return this.finishOverlap(out, count);
  }

  overlapBox(
    center: Vec3,
    halfExtents: Vec3,
    rotation: Quat,
    query: QueryFilter,
    out: ColliderHandle[],
  ): number {
    if (!isFiniteVec3(center)) {
      throw this._error("E_CONTRACT", "overlapBox: center must be finite");
    }
    if (!isFiniteBoxExtents(halfExtents)) {
      throw this._error(
        "E_CONTRACT",
        "overlapBox: halfExtents must be finite and > 0",
      );
    }
    const pose = quat();
    if (!isFiniteQuat(rotation)) {
      throw this._error("E_CONTRACT", "overlapBox: rotation must be finite");
    }
    copyQuat(pose, rotation);
    if (!normalizeQuatInPlace(pose)) {
      throw this._error("E_CONTRACT", "overlapBox: rotation must be non-zero");
    }
    this.overlapCuboid.halfExtents.x = halfExtents.x;
    this.overlapCuboid.halfExtents.y = halfExtents.y;
    this.overlapCuboid.halfExtents.z = halfExtents.z;
    const context = this.makeQueryContext(query);
    let count = 0;
    this.world.intersectionsWithShape(
      center,
      pose,
      this.overlapCuboid,
      (collider): boolean => {
        const slot = this.resolveRawCollider(collider.handle);
        if (slot !== null) {
          out[count] = slot.handle;
          count += 1;
        }
        return true;
      },
      context.flags,
      undefined,
      context.excludeCollider,
      context.excludeBody,
      context.predicate,
    );
    return this.finishOverlap(out, count);
  }

  pointQuery(point: Vec3, query: QueryFilter, out: ColliderHandle[]): number {
    if (!isFiniteVec3(point)) {
      throw this._error("E_CONTRACT", "pointQuery: point must be finite");
    }
    const context = this.makeQueryContext(query);
    let count = 0;
    this.world.intersectionsWithPoint(
      point,
      (collider): boolean => {
        const slot = this.resolveRawCollider(collider.handle);
        if (slot !== null) {
          out[count] = slot.handle;
          count += 1;
        }
        return true;
      },
      context.flags,
      undefined,
      context.excludeCollider,
      context.excludeBody,
      context.predicate,
    );
    return this.finishOverlap(out, count);
  }

  /* -------------------------------------------------------- scene integration */

  bindTransform(entity: Entity, body: BodyHandle): void {
    const slot = this.resolveBody(body);
    if (slot === null) {
      throw this._error("E_STALE_HANDLE", "bindTransform: body is stale");
    }
    const existing = this.bindingById.get(entity.id);
    if (existing !== undefined) {
      existing.entity = entity;
      existing.body = body;
      existing.bodyIndex = slot.index;
      return;
    }
    const binding: SceneBinding = { entity, body, bodyIndex: slot.index };
    this.bindingById.set(entity.id, binding);
    this.bindingList.push(binding);
  }

  unbindTransform(entity: Entity): void {
    const binding = this.bindingById.get(entity.id);
    if (binding === undefined) return;
    this.bindingById.delete(entity.id);
    const index = this.bindingList.indexOf(binding);
    if (index >= 0) this.bindingList.splice(index, 1);
  }

  syncScene(scene: Scene): void {
    if (this.bindingList.length === 0) return;
    this.bindingList.sort(this.compareBindings);
    for (let i = this.bindingList.length - 1; i >= 0; i -= 1) {
      const binding = this.bindingList[i]!;
      if (!scene.isAlive(binding.entity)) {
        this.removeBindingAt(i);
        continue;
      }
      const transform = scene.get(binding.entity, Transform);
      if (transform === undefined) {
        this.removeBindingAt(i);
        continue;
      }
      const slot = this.resolveBody(binding.body);
      const body = slot?.body;
      if (!slot || !body) {
        this.removeBindingAt(i);
        continue;
      }
      body.translation(this.scratchVec);
      body.rotation(this.scratchQuat);
      const previous = scene.get(binding.entity, PreviousTransform);
      if (previous === undefined) {
        /* First sync: there is no earlier pose, so interpolation starts here. */
        scene.add(binding.entity, PreviousTransform, {
          position: vec3(
            this.scratchVec.x,
            this.scratchVec.y,
            this.scratchVec.z,
          ),
          rotation: quat(
            this.scratchQuat.x,
            this.scratchQuat.y,
            this.scratchQuat.z,
            this.scratchQuat.w,
          ),
        });
      } else {
        copyVec3(previous.position, transform.position);
        copyQuat(previous.rotation, transform.rotation);
      }
      copyVec3(transform.position, this.scratchVec);
      copyQuat(transform.rotation, this.scratchQuat);
      const dirtyScene = scene as Scene & {
        markTransformDirty?: (entity: Entity) => void;
      };
      dirtyScene.markTransformDirty?.(binding.entity);
    }
  }

  sampleTransform(body: BodyHandle, alpha: number, out: TransformData): boolean {
    const slot = this.resolveBody(body);
    if (slot === null) return false;
    if (!isFiniteNumber(alpha)) {
      throw this._error("E_CONTRACT", "sampleTransform: alpha must be finite");
    }
    const t = Math.min(1, Math.max(0, alpha));
    out.position.x =
      slot.prevPosition.x + (slot.curPosition.x - slot.prevPosition.x) * t;
    out.position.y =
      slot.prevPosition.y + (slot.curPosition.y - slot.prevPosition.y) * t;
    out.position.z =
      slot.prevPosition.z + (slot.curPosition.z - slot.prevPosition.z) * t;
    slerpQuat(out.rotation, slot.prevRotation, slot.curRotation, t);
    return true;
  }

  /* ----------------------------------------------------------------- events */

  drainContactEvents(out: ContactEvent[]): number {
    out.length = 0;
    const count = this.contactPoolCount;
    for (let i = 0; i < count; i += 1) {
      const event = this.contactPool[i]!;
      out.push({
        colliderA: event.colliderA,
        colliderB: event.colliderB,
        bodyA: event.bodyA,
        bodyB: event.bodyB,
      });
    }
    this.contactPoolCount = 0;
    return count;
  }

  drainTriggerEvents(out: TriggerEvent[]): number {
    out.length = 0;
    const count = this.triggerPoolCount;
    for (let i = 0; i < count; i += 1) {
      const event = this.triggerPool[i]!;
      out.push({
        colliderA: event.colliderA,
        colliderB: event.colliderB,
        bodyA: event.bodyA,
        bodyB: event.bodyB,
        phase: event.phase,
      });
    }
    this.triggerPoolCount = 0;
    return count;
  }

  /* ------------------------------------------------------------ determinism */

  stateHash(): number {
    if (this.disposed) return 0;
    const hasher = this.hasher;
    hasher.reset();
    hasher.u32(this.activeBodyCount);
    for (let i = 0; i < this.bodySlots.length; i += 1) {
      const slot = this.bodySlots[i]!;
      const body = slot.body;
      if (!slot.active || !body) continue;
      body.translation(this.scratchVec);
      hasher.f64(this.scratchVec.x);
      hasher.f64(this.scratchVec.y);
      hasher.f64(this.scratchVec.z);
      body.rotation(this.scratchQuat);
      hasher.f64(this.scratchQuat.x);
      hasher.f64(this.scratchQuat.y);
      hasher.f64(this.scratchQuat.z);
      hasher.f64(this.scratchQuat.w);
      body.linvel(this.scratchVec);
      hasher.f64(this.scratchVec.x);
      hasher.f64(this.scratchVec.y);
      hasher.f64(this.scratchVec.z);
      body.angvel(this.scratchVec);
      hasher.f64(this.scratchVec.x);
      hasher.f64(this.scratchVec.y);
      hasher.f64(this.scratchVec.z);
      let flags = 0;
      if (body.isSleeping()) flags |= 1;
      if (slot.enabled) flags |= 2;
      if (slot.colliderCount > 0) flags |= 4;
      hasher.u32(flags);
      hasher.u32(slot.userData);
    }
    hasher.u32(this.activeColliderCount);
    for (let i = 0; i < this.colliderSlots.length; i += 1) {
      const slot = this.colliderSlots[i]!;
      if (!slot.active) continue;
      hasher.u32(slot.bodyIndex);
      hasher.u32(slot.shape.kindCode);
      hasher.f64(slot.friction);
      hasher.f64(slot.restitution);
      hasher.u32(slot.layer);
      hasher.u32(slot.mask);
      hasher.u32(slot.sensor ? 1 : 0);
    }
    return hasher.finish();
  }

  rebaseOrigin(newOrigin: Vec3): void {
    if (this.stepping) {
      throw this._error(
        "E_CONTRACT",
        "rebaseOrigin: call between steps, never inside one",
      );
    }
    if (!isFiniteVec3(newOrigin)) {
      throw this._error("E_CONTRACT", "rebaseOrigin: origin must be finite");
    }
    for (let i = 0; i < this.bodySlots.length; i += 1) {
      const slot = this.bodySlots[i]!;
      const body = slot.body;
      if (!slot.active || !body) continue;
      body.translation(this.scratchVec);
      this.scratchVec.x -= newOrigin.x;
      this.scratchVec.y -= newOrigin.y;
      this.scratchVec.z -= newOrigin.z;
      body.setTranslation(this.scratchVec, false);
      if (slot.type === "kinematicPosition") {
        body.setNextKinematicTranslation(this.scratchVec);
      }
      slot.curPosition.x -= newOrigin.x;
      slot.curPosition.y -= newOrigin.y;
      slot.curPosition.z -= newOrigin.z;
      slot.prevPosition.x -= newOrigin.x;
      slot.prevPosition.y -= newOrigin.y;
      slot.prevPosition.z -= newOrigin.z;
    }
  }

  /* --------------------------------------------------------------- lifecycle */

  step(dt: number): void {
    if (this.disposed) {
      throw this._error("E_CONTRACT", "step: world is disposed");
    }
    if (!isFiniteNumber(dt) || dt !== this.fixedDt) {
      throw this._error(
        "E_CONTRACT",
        `step: dt must equal the configured fixedDt (${this.fixedDt})`,
      );
    }
    if (this.stepping) {
      throw this._error("E_CONTRACT", "step: re-entered");
    }
    this.stepping = true;
    try {
      this.tick += 1;
      this.stats.ccdSweeps = 0;
      this.wakeExternallyWokenBodies();
      const substeps = this.solver.substeps;
      const subDt = dt / substeps;
      for (let substep = 0; substep < substeps; substep += 1) {
        for (let i = 0; i < this.vehicleSlots.length; i += 1) {
          const vehicle = this.vehicleSlots[i]!.vehicle;
          if (vehicle?.active) {
            vehicle.prepare(subDt);
            vehicle.update(subDt);
          }
        }
        this.countCcdSweeps();
        this.world.timestep = subDt;
        this.world.step(this.eventQueue, this.hooks);
      }
      this.eventQueue.drainCollisionEvents(this.onCollisionEvent);
      this.finalizeBodies(dt);
      for (let i = 0; i < this.vehicleSlots.length; i += 1) {
        const vehicle = this.vehicleSlots[i]!.vehicle;
        if (vehicle?.active) vehicle.refreshTelemetry();
      }
      this.updateStats();
    } finally {
      this.stepping = false;
    }
  }

  reset(): void {
    if (this.disposed) return;
    if (this.stepping) {
      throw this._error("E_CONTRACT", "reset: cannot run inside step");
    }
    this.teardownContents();
    this.world.free();
    this.eventQueue.free();
    this.world = new RAPIER_MODULE.World(this.gravity);
    this.eventQueue = new RAPIER_MODULE.EventQueue(false);
    this.configureWorld();
    this.tick = 0;
    this.resetStats();
  }

  dispose(): void {
    if (this.disposed) return;
    this.teardownContents();
    this.world.free();
    this.eventQueue.free();
    this.disposed = true;
  }

  /** Additive: enables or disables profiler timings after creation. */
  setDebug(enabled: boolean): void {
    this.debug = enabled;
    this.world.profilerEnabled = enabled;
    if (!enabled) {
      this.stats.stepMs = 0;
      this.stats.broadphaseMs = 0;
      this.stats.narrowphaseMs = 0;
      this.stats.solverMs = 0;
    }
  }

  /* -------------------------------------------------------------- internals */

  private configureWorld(): void {
    this.world.timestep = this.fixedDt;
    this.world.gravity = this.gravity;
    // RV-56: only two SolverConfig knobs have a Rapier 0.21 mapping.
    // `velocityIterations` drives numSolverIterations and `substeps` is
    // applied as outer substeps in `step`. `positionIterations` has no
    // counterpart (Rapier corrects position through contact softness, not a
    // position-iteration count) and `warmStarting` cannot be disabled: the
    // JS bindings expose no warmstart coefficient or toggle. Both are still
    // validated and recorded in replay metadata, but changing either leaves
    // the state hash unchanged. Do not fake sensitivity for them.
    this.world.integrationParameters.numSolverIterations =
      this.solver.velocityIterations;
    this.world.integrationParameters.maxCcdSubsteps = PHYSICS_MAX_CCD_SWEEPS;
    this.world.profilerEnabled = this.debug;
  }

  private ensureMutable(): void {
    if (this.disposed) {
      throw this._error("E_CONTRACT", "world is disposed");
    }
    if (this.stepping) {
      throw this._error(
        "E_CONTRACT",
        "structural changes are not allowed inside step()",
      );
    }
  }

  private resetStats(): void {
    const stats = this.stats;
    stats.bodyCount = 0;
    stats.colliderCount = 0;
    stats.awakeBodyCount = 0;
    stats.pairCount = 0;
    stats.contactCount = 0;
    stats.stepMs = 0;
    stats.broadphaseMs = 0;
    stats.narrowphaseMs = 0;
    stats.solverMs = 0;
    stats.droppedEvents = 0;
    stats.ccdSweeps = 0;
    stats.droppedBodies = 0;
    stats.droppedColliders = 0;
    stats.nonFiniteBodies = 0;
    stats.degenerateTriangles = 0;
  }

  private teardownContents(): void {
    for (let i = 0; i < this.characters.length; i += 1) {
      const character = this.characters[i];
      if (character?.active) {
        this.world.removeCharacterController(character.rawController());
        character.deactivate();
      }
      this.characters[i] = null;
    }
    for (let i = 0; i < this.vehicleSlots.length; i += 1) {
      const record = this.vehicleSlots[i]!;
      if (record.vehicle) record.vehicle.deactivate(this);
      record.vehicle = null;
      record.generation += 1;
      record.handle = INVALID_VEHICLE_HANDLE;
    }
    for (let i = 0; i < this.bodySlots.length; i += 1) {
      const slot = this.bodySlots[i]!;
      if (slot.active) {
        slot.active = false;
        slot.generation += 1;
      }
      slot.body = null;
      slot.handle = INVALID_BODY_HANDLE;
      slot.colliderSlots.length = 0;
      slot.colliderCount = 0;
      slot.vehicleSlot = -1;
      slot.characterSlot = -1;
    }
    for (let i = 0; i < this.colliderSlots.length; i += 1) {
      const slot = this.colliderSlots[i]!;
      if (slot.active) {
        slot.active = false;
        slot.generation += 1;
      }
      slot.collider = null;
      slot.shape = EMPTY_SHAPE;
    }
    for (let i = 0; i < this.jointSlots.length; i += 1) {
      const slot = this.jointSlots[i]!;
      if (slot.active) {
        slot.active = false;
        slot.generation += 1;
      }
      slot.joint = null;
    }
    this.freeBodySlots.length = 0;
    this.freeColliderSlots.length = 0;
    this.freeJointSlots.length = 0;
    this.freeVehicleSlots.length = 0;
    this.freeCharacterSlots.length = 0;
    for (let i = 0; i < this.bodySlots.length; i += 1) {
      this.freeBodySlots.push(i);
    }
    for (let i = 0; i < this.colliderSlots.length; i += 1) {
      this.freeColliderSlots.push(i);
    }
    for (let i = 0; i < this.jointSlots.length; i += 1) {
      this.freeJointSlots.push(i);
    }
    for (let i = 0; i < this.vehicleSlots.length; i += 1) {
      this.freeVehicleSlots.push(i);
    }
    for (let i = 0; i < this.characters.length; i += 1) {
      this.freeCharacterSlots.push(i);
    }
    this.bodyIndexByRaw = new Map<number, number>();
    this.colliderIndexByRaw = new Map<number, number>();
    this.activeBodyCount = 0;
    this.activeColliderCount = 0;
    this.activeDynamicCount = 0;
    this.awakeDynamicCount = 0;
    this.activeJointCount = 0;
    this.contactPoolCount = 0;
    this.triggerPoolCount = 0;
    this.activeContacts.clear();
    this.activeTriggers.clear();
    this.bindingById.clear();
    this.bindingList.length = 0;
  }

  private allocateBodySlot(): number {
    const free = this.freeBodySlots.pop();
    if (free !== undefined) return free;
    const index = this.bodySlots.length;
    this.bodySlots.push(makeBodySlot(index));
    return index;
  }

  private allocateColliderSlot(): number {
    const free = this.freeColliderSlots.pop();
    if (free !== undefined) return free;
    const index = this.colliderSlots.length;
    this.colliderSlots.push(makeColliderSlot(index));
    return index;
  }

  private allocateJointSlot(): number {
    const free = this.freeJointSlots.pop();
    if (free !== undefined) return free;
    const index = this.jointSlots.length;
    this.jointSlots.push({
      active: false,
      generation: 1,
      index,
      joint: null,
      handle: INVALID_JOINT_HANDLE,
      bodyA: -1,
      bodyB: -1,
      kind: "fixed",
    });
    return index;
  }

  private allocateVehicleSlot(): number {
    const free = this.freeVehicleSlots.pop();
    if (free !== undefined) return free;
    const index = this.vehicleSlots.length;
    this.vehicleSlots.push({
      generation: 1,
      vehicle: null,
      handle: INVALID_VEHICLE_HANDLE,
    });
    return index;
  }

  private allocateCharacterSlot(): number {
    const free = this.freeCharacterSlots.pop();
    if (free !== undefined) return free;
    const index = this.characters.length;
    this.characters.push(null);
    return index;
  }

  private makeBodyHandle(index: number, generation: number): BodyHandle {
    return { index, generation, __kind: "body" };
  }

  private makeColliderHandle(index: number, generation: number): ColliderHandle {
    return { index, generation, __kind: "collider" };
  }

  private makeJointHandle(index: number, generation: number): JointHandle {
    return { index, generation, __kind: "joint" };
  }

  private makeVehicleHandle(index: number, generation: number): VehicleHandle {
    return { index, generation, __kind: "vehicle" };
  }

  private resolveBody(handle: BodyHandle): BodySlot | null {
    if (
      handle === null ||
      typeof handle !== "object" ||
      !Number.isInteger(handle.index) ||
      handle.index < 0 ||
      handle.index >= this.bodySlots.length
    ) {
      return null;
    }
    const slot = this.bodySlots[handle.index]!;
    if (!slot.active || slot.generation !== handle.generation) return null;
    return slot;
  }

  private resolveCollider(handle: ColliderHandle): ColliderSlot | null {
    if (
      handle === null ||
      typeof handle !== "object" ||
      !Number.isInteger(handle.index) ||
      handle.index < 0 ||
      handle.index >= this.colliderSlots.length
    ) {
      return null;
    }
    const slot = this.colliderSlots[handle.index]!;
    if (!slot.active || slot.generation !== handle.generation) return null;
    return slot;
  }

  private resolveJoint(handle: JointHandle): JointSlot | null {
    if (
      handle === null ||
      typeof handle !== "object" ||
      !Number.isInteger(handle.index) ||
      handle.index < 0 ||
      handle.index >= this.jointSlots.length
    ) {
      return null;
    }
    const slot = this.jointSlots[handle.index]!;
    if (!slot.active || slot.generation !== handle.generation) return null;
    return slot;
  }

  private resolveVehicle(handle: VehicleHandle): VehicleSlotRecord | null {
    if (
      handle === null ||
      typeof handle !== "object" ||
      !Number.isInteger(handle.index) ||
      handle.index < 0 ||
      handle.index >= this.vehicleSlots.length
    ) {
      return null;
    }
    const record = this.vehicleSlots[handle.index]!;
    if (record.vehicle === null || record.generation !== handle.generation) {
      return null;
    }
    return record;
  }

  private resolveRawCollider(rawHandle: number): ColliderSlot | null {
    const index = this.colliderIndexByRaw.get(rawHandle);
    if (index === undefined) return null;
    const slot = this.colliderSlots[index]!;
    return slot.active ? slot : null;
  }

  private releaseColliderSlot(slot: ColliderSlot): void {
    const rawHandle = slot.collider?.handle ?? -1;
    if (slot.collider) this.world.removeCollider(slot.collider, true);
    const bodySlot = this.bodySlots[slot.bodyIndex];
    if (bodySlot) {
      const position = bodySlot.colliderSlots.indexOf(slot.index);
      if (position >= 0) bodySlot.colliderSlots.splice(position, 1);
      bodySlot.colliderCount = Math.max(0, bodySlot.colliderCount - 1);
      bodySlot.volume = Math.max(0, bodySlot.volume - slot.volume);
    }
    if (rawHandle >= 0) {
      this.colliderIndexByRaw.delete(rawHandle);
      this.removePairsWithRaw(rawHandle);
    }
    slot.active = false;
    slot.collider = null;
    slot.generation += 1;
    slot.handle = INVALID_COLLIDER_HANDLE;
    slot.shape = EMPTY_SHAPE;
    slot.volume = 0;
    this.activeColliderCount -= 1;
    this.freeColliderSlots.push(slot.index);
    this.stats.colliderCount = this.activeColliderCount;
    if (bodySlot) this.syncBodyMass(bodySlot);
  }

  private removePairsWithRaw(rawHandle: number): void {
    for (const key of this.activeContacts.keys()) {
      const a = Math.floor(key / 4294967296);
      const b = key - a * 4294967296;
      if (a === rawHandle || b === rawHandle) this.activeContacts.delete(key);
    }
    for (const key of this.activeTriggers.keys()) {
      const a = Math.floor(key / 4294967296);
      const b = key - a * 4294967296;
      if (a === rawHandle || b === rawHandle) this.activeTriggers.delete(key);
    }
  }

  private removeBindingAt(index: number): void {
    const binding = this.bindingList[index]!;
    this.bindingById.delete(binding.entity.id);
    this.bindingList.splice(index, 1);
  }

  private syncBodyMass(slot: BodySlot): void {
    if (slot.type !== "dynamic" || slot.explicitMass <= 0) return;
    const body = slot.body;
    if (!body) return;
    if (slot.volume > 0) {
      const density = slot.explicitMass / slot.volume;
      for (let i = 0; i < slot.colliderSlots.length; i += 1) {
        const collider = this.colliderSlots[slot.colliderSlots[i]!];
        if (collider?.active && collider.collider) {
          collider.collider.setDensity(collider.volume > 0 ? density : 0);
        }
      }
      body.recomputeMassPropertiesFromColliders();
      body.setAdditionalMass(0, false);
    } else {
      for (let i = 0; i < slot.colliderSlots.length; i += 1) {
        const collider = this.colliderSlots[slot.colliderSlots[i]!];
        if (collider?.active && collider.collider) {
          collider.collider.setDensity(0);
        }
      }
      body.recomputeMassPropertiesFromColliders();
      body.setAdditionalMass(slot.explicitMass, false);
    }
  }

  private makeShape(shape: ShapeDesc): ShapeData {
    switch (shape.kind) {
      case "sphere": {
        if (!isFiniteNumber(shape.radius) || shape.radius <= 0) {
          throw this._error(
            "E_CONTRACT",
            "createCollider: sphere radius must be > 0",
          );
        }
        return {
          kindCode: SHAPE_SPHERE,
          kind: "sphere",
          radius: shape.radius,
          halfHeight: 0,
          halfExtents: vec3(),
          vertices: null,
          indices: null,
          triangleCount: 0,
        };
      }
      case "box": {
        if (!isFiniteBoxExtents(shape.halfExtents)) {
          throw this._error(
            "E_CONTRACT",
            "createCollider: box halfExtents must be finite and > 0",
          );
        }
        return {
          kindCode: SHAPE_BOX,
          kind: "box",
          radius: 0,
          halfHeight: 0,
          halfExtents: {
            x: shape.halfExtents.x,
            y: shape.halfExtents.y,
            z: shape.halfExtents.z,
          },
          vertices: null,
          indices: null,
          triangleCount: 0,
        };
      }
      case "capsule": {
        if (!isFiniteNumber(shape.radius) || shape.radius <= 0) {
          throw this._error(
            "E_CONTRACT",
            "createCollider: capsule radius must be > 0",
          );
        }
        if (!isFiniteNumber(shape.halfHeight) || shape.halfHeight < 0) {
          throw this._error(
            "E_CONTRACT",
            "createCollider: capsule halfHeight must be >= 0",
          );
        }
        return {
          kindCode: SHAPE_CAPSULE,
          kind: "capsule",
          radius: shape.radius,
          halfHeight: shape.halfHeight,
          halfExtents: vec3(),
          vertices: null,
          indices: null,
          triangleCount: 0,
        };
      }
      case "trimesh":
        return this.makeTrimeshShape(shape);
      default:
        throw this._error("E_CONTRACT", "createCollider: unknown shape kind");
    }
  }

  private makeTrimeshShape(
    shape: Extract<ShapeDesc, { kind: "trimesh" }>,
  ): ShapeData {
    if (
      !(shape.vertices instanceof Float32Array) ||
      !(shape.indices instanceof Uint32Array)
    ) {
      throw this._error(
        "E_ASSET_FORMAT",
        "createCollider: trimesh needs Float32Array vertices and Uint32Array indices",
      );
    }
    const vertices = shape.vertices;
    const indices = shape.indices;
    if (
      vertices.length === 0 ||
      vertices.length % 3 !== 0 ||
      indices.length === 0 ||
      indices.length % 3 !== 0
    ) {
      throw this._error(
        "E_ASSET_FORMAT",
        "createCollider: trimesh buffers must hold complete triangles",
      );
    }
    const triangleCount = indices.length / 3;
    if (shape.triangleCount !== triangleCount) {
      throw this._error(
        "E_ASSET_FORMAT",
        "createCollider: trimesh triangleCount must equal indices.length / 3",
      );
    }
    if (triangleCount > PHYSICS_MAX_TRIMESH_TRIANGLES) {
      throw this._error(
        "E_CONTRACT",
        `createCollider: trimesh exceeds ${PHYSICS_MAX_TRIMESH_TRIANGLES} triangles`,
      );
    }
    const vertexCount = vertices.length / 3;
    for (let i = 0; i < vertices.length; i += 1) {
      if (!Number.isFinite(vertices[i]!)) {
        throw this._error(
          "E_ASSET_FORMAT",
          "createCollider: trimesh vertices must be finite",
        );
      }
    }
    let degenerate = 0;
    for (let t = 0; t < triangleCount; t += 1) {
      const i0 = indices[t * 3]!;
      const i1 = indices[t * 3 + 1]!;
      const i2 = indices[t * 3 + 2]!;
      if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) {
        throw this._error(
          "E_ASSET_FORMAT",
          "createCollider: trimesh index out of range",
        );
      }
      const ax = vertices[i0 * 3]!;
      const ay = vertices[i0 * 3 + 1]!;
      const az = vertices[i0 * 3 + 2]!;
      const bx = vertices[i1 * 3]!;
      const by = vertices[i1 * 3 + 1]!;
      const bz = vertices[i1 * 3 + 2]!;
      const cx = vertices[i2 * 3]!;
      const cy = vertices[i2 * 3 + 1]!;
      const cz = vertices[i2 * 3 + 2]!;
      const ux = bx - ax;
      const uy = by - ay;
      const uz = bz - az;
      const vx = cx - ax;
      const vy = cy - ay;
      const vz = cz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      if (nx * nx + ny * ny + nz * nz < 1e-20) degenerate += 1;
    }
    if (degenerate === triangleCount) {
      throw this._error(
        "E_ASSET_FORMAT",
        "createCollider: trimesh has no non-degenerate triangle",
      );
    }
    this.stats.degenerateTriangles += degenerate;
    return {
      kindCode: SHAPE_TRIMESH,
      kind: "trimesh",
      radius: 0,
      halfHeight: 0,
      halfExtents: vec3(),
      vertices,
      indices,
      triangleCount,
    };
  }

  private makeColliderDesc(
    shape: ShapeData,
    material: {
      friction: number;
      restitution: number;
      density: number;
      sensor: boolean;
      localPosition: Vec3;
      localRotation: Quat;
    },
  ): RAPIER.ColliderDesc {
    let desc: RAPIER.ColliderDesc;
    switch (shape.kindCode) {
      case SHAPE_SPHERE:
        desc = RAPIER_MODULE.ColliderDesc.ball(shape.radius);
        break;
      case SHAPE_BOX:
        desc = RAPIER_MODULE.ColliderDesc.cuboid(
          shape.halfExtents.x,
          shape.halfExtents.y,
          shape.halfExtents.z,
        );
        break;
      case SHAPE_CAPSULE:
        desc = RAPIER_MODULE.ColliderDesc.capsule(
          shape.halfHeight,
          shape.radius,
        );
        break;
      default:
        desc = RAPIER_MODULE.ColliderDesc.trimesh(
          shape.vertices!,
          shape.indices!,
        );
        break;
    }
    return desc
      .setTranslation(
        material.localPosition.x,
        material.localPosition.y,
        material.localPosition.z,
      )
      .setRotation(material.localRotation)
      /*
       * 07 §5.7 requires the geometric mean sqrt(muA * muB). Rapier has no
       * geometric-mean rule, but Multiply(sqrt(muA), sqrt(muB)) is exactly
       * that, so the raw collider stores the square root while every public
       * read (`readCollider`, `stateHash`) still reports the contract value.
       */
      .setFriction(Math.sqrt(material.friction))
      .setFrictionCombineRule(RAPIER_MODULE.CoefficientCombineRule.Multiply)
      .setRestitution(material.restitution)
      .setRestitutionCombineRule(RAPIER_MODULE.CoefficientCombineRule.Max)
      .setDensity(material.density)
      .setSensor(material.sensor)
      .setActiveHooks(
        RAPIER_MODULE.ActiveHooks.FILTER_CONTACT_PAIRS |
          RAPIER_MODULE.ActiveHooks.FILTER_INTERSECTION_PAIRS,
      )
      .setActiveEvents(RAPIER_MODULE.ActiveEvents.COLLISION_EVENTS);
  }

  private readRotation(value: Quat | undefined, label: string): Quat {
    const out = quat();
    if (value === undefined) return out;
    if (!isFiniteQuat(value)) {
      throw this._error("E_CONTRACT", `createJoint: ${label} must be finite`);
    }
    copyQuat(out, value);
    if (!normalizeQuatInPlace(out)) {
      throw this._error("E_CONTRACT", `createJoint: ${label} must be non-zero`);
    }
    return out;
  }

  private readAxis(value: Vec3, label: string): Vec3 {
    if (!isFiniteVec3(value)) {
      throw this._error("E_CONTRACT", `createJoint: ${label} must be finite`);
    }
    const length = vecLength(value.x, value.y, value.z);
    if (length < 1e-6) {
      throw this._error("E_CONTRACT", `createJoint: ${label} must be non-zero`);
    }
    return vec3(value.x / length, value.y / length, value.z / length);
  }

  private applyMotor(unit: RAPIER.UnitImpulseJoint, motor: JointMotor): void {
    if (
      !isFiniteNumber(motor.targetVelocity) ||
      !isFiniteNumber(motor.maxForce) ||
      motor.maxForce < 0 ||
      (motor.targetPosition !== undefined &&
        !isFiniteNumber(motor.targetPosition)) ||
      (motor.stiffness !== undefined &&
        (!isFiniteNumber(motor.stiffness) || motor.stiffness < 0)) ||
      (motor.damping !== undefined &&
        (!isFiniteNumber(motor.damping) || motor.damping < 0))
    ) {
      throw this._error(
        "E_CONTRACT",
        "joint motor fields must be finite and non-negative",
      );
    }
    unit.configureMotorModel(RAPIER_MODULE.MotorModel.ForceBased);
    unit.setMotorMaxForce(motor.maxForce);
    if (motor.targetPosition !== undefined) {
      unit.configureMotorPosition(
        motor.targetPosition,
        motor.stiffness ?? 0,
        motor.damping ?? 0,
      );
    } else {
      unit.configureMotorVelocity(motor.targetVelocity, motor.damping ?? 1);
    }
  }

  private filterPair(
    collider1: number,
    collider2: number,
  ): RAPIER.SolverFlags | null {
    return this.acceptRawPair(collider1, collider2)
      ? RAPIER_MODULE.SolverFlags.COMPUTE_IMPULSE
      : null;
  }

  private acceptRawPair(collider1: number, collider2: number): boolean {
    const a = this.resolveRawCollider(collider1);
    const b = this.resolveRawCollider(collider2);
    if (a === null || b === null) return false;
    return accepts(a.layer, a.mask, b.layer, b.mask);
  }

  private recordCollisionEvent(
    raw1: number,
    raw2: number,
    started: boolean,
  ): void {
    const a = this.resolveRawCollider(raw1);
    const b = this.resolveRawCollider(raw2);
    const bodyA = a ? this.bodySlots[a.bodyIndex] : undefined;
    const bodyB = b ? this.bodySlots[b.bodyIndex] : undefined;
    if (!a || !b || !bodyA || !bodyB) return;
    const key = pairKey(raw1, raw2);
    if (a.sensor || b.sensor) {
      if (started) {
        this.activeTriggers.set(key, 1);
        if (this.triggerPoolCount < PHYSICS_MAX_CONTACT_EVENTS) {
          const event = this.triggerPool[this.triggerPoolCount]!;
          event.colliderA = a.handle;
          event.colliderB = b.handle;
          event.bodyA = bodyA.handle;
          event.bodyB = bodyB.handle;
          event.phase = "enter";
          this.triggerPoolCount += 1;
        } else {
          this.stats.droppedEvents += 1;
        }
      } else {
        this.activeTriggers.delete(key);
        if (this.triggerPoolCount < PHYSICS_MAX_CONTACT_EVENTS) {
          const event = this.triggerPool[this.triggerPoolCount]!;
          event.colliderA = a.handle;
          event.colliderB = b.handle;
          event.bodyA = bodyA.handle;
          event.bodyB = bodyB.handle;
          event.phase = "exit";
          this.triggerPoolCount += 1;
        } else {
          this.stats.droppedEvents += 1;
        }
      }
      return;
    }
    if (started) {
      this.activeContacts.set(key, 1);
      if (this.contactPoolCount < PHYSICS_MAX_CONTACT_EVENTS) {
        const event = this.contactPool[this.contactPoolCount]!;
        event.colliderA = a.handle;
        event.colliderB = b.handle;
        event.bodyA = bodyA.handle;
        event.bodyB = bodyB.handle;
        this.contactPoolCount += 1;
      } else {
        this.stats.droppedEvents += 1;
      }
    } else {
      this.activeContacts.delete(key);
    }
  }

  private countCcdSweeps(): void {
    const thresholdSq =
      PHYSICS_CCD_SPEED_THRESHOLD * PHYSICS_CCD_SPEED_THRESHOLD;
    for (let i = 0; i < this.bodySlots.length; i += 1) {
      const slot = this.bodySlots[i]!;
      const body = slot.body;
      if (!slot.active || !body || slot.type !== "dynamic" || !slot.ccd) {
        continue;
      }
      body.linvel(this.scratchVec);
      const speedSq =
        this.scratchVec.x * this.scratchVec.x +
        this.scratchVec.y * this.scratchVec.y +
        this.scratchVec.z * this.scratchVec.z;
      if (speedSq > thresholdSq) this.stats.ccdSweeps += 1;
    }
  }

  private ensureIslandScratch(count: number, jointEdges: number): void {
    if (this.islandParent.length < count) {
      const size = Math.max(count, this.islandParent.length * 2, 64);
      this.islandParent = new Int32Array(size);
      this.islandQualify = new Uint8Array(size);
      this.islandAwake = new Uint8Array(size);
      this.islandSeen = new Int32Array(size);
      this.islandJointHead = new Int32Array(size);
    }
    if (this.islandJointNext.length < jointEdges) {
      const size = Math.max(jointEdges, this.islandJointNext.length * 2, 64);
      this.islandJointNext = new Int32Array(size);
      this.islandJointOther = new Int32Array(size);
    }
  }

  private islandFind(index: number): number {
    let root = index;
    while (this.islandParent[root] !== root) root = this.islandParent[root]!;
    let node = index;
    while (this.islandParent[node] !== root) {
      const next = this.islandParent[node]!;
      this.islandParent[node] = root;
      node = next;
    }
    return root;
  }

  private islandUnion(a: number, b: number): void {
    const rootA = this.islandFind(a);
    const rootB = this.islandFind(b);
    if (rootA === rootB) return;
    if (rootA < rootB) this.islandParent[rootB] = rootA;
    else this.islandParent[rootA] = rootB;
  }

  /**
   * Reset the island scratch for one walk: union-find parents, joint
   * adjacency (joints bind their bodies into one island) and a fresh
   * visitation epoch. Fixed bodies never join an island; disabled bodies
   * are excluded as well.
   */
  private prepareIslandGraph(): void {
    const count = this.bodySlots.length;
    this.ensureIslandScratch(count, this.jointSlots.length * 2);
    this.islandEpoch += 1;
    if (this.islandEpoch >= 0x7fffffff) {
      this.islandEpoch = 1;
      this.islandSeen.fill(0);
    }
    const parent = this.islandParent;
    for (let i = 0; i < count; i += 1) {
      const slot = this.bodySlots[i]!;
      parent[i] =
        slot.active && slot.enabled && slot.type !== "static" ? i : -1;
    }
    this.islandJointHead.fill(-1, 0, count);
    let edge = 0;
    for (let i = 0; i < this.jointSlots.length; i += 1) {
      const joint = this.jointSlots[i]!;
      if (!joint.active || !joint.joint) continue;
      const a = joint.bodyA;
      const b = joint.bodyB;
      if (a < 0 || b < 0 || parent[a]! < 0 || parent[b]! < 0) continue;
      this.islandJointOther[edge] = b;
      this.islandJointNext[edge] = this.islandJointHead[a]!;
      this.islandJointHead[a] = edge;
      edge += 1;
      this.islandJointOther[edge] = a;
      this.islandJointNext[edge] = this.islandJointHead[b]!;
      this.islandJointHead[b] = edge;
      edge += 1;
      this.islandUnion(a, b);
    }
  }

  /**
   * Wake the whole contact island that contains `startIndex` (07 §5.12:
   * "waking any body wakes its whole island"). Rapier dissolves an island's
   * active set when it sleeps, so waking one member does not reach the
   * others; the persisted contact pairs and joints are walked here instead.
   * Sleeping members also get their gravity scale back: while asleep it is
   * zeroed, because Rapier still integrates a manually slept body for one
   * or two steps after `body.sleep()` (the user change is flushed after the
   * solver) and ER-07-07 allows the island 5 mm of drift over 600 ticks.
   */
  private wakeIsland(startIndex: number): void {
    const start = this.bodySlots[startIndex];
    if (!start || !start.active || start.type === "static" || !start.body) {
      return;
    }
    this.prepareIslandGraph();
    this.islandQueue.length = 0;
    this.islandSeen[startIndex] = this.islandEpoch;
    this.islandQueue.push(startIndex);
    for (let head = 0; head < this.islandQueue.length; head += 1) {
      const index = this.islandQueue[head]!;
      const slot = this.bodySlots[index]!;
      const body = slot.body;
      if (slot.type === "dynamic" && body) {
        if (slot.sleeping) {
          body.wakeUp();
          body.setGravityScale(slot.sleepGravityScale, false);
          slot.sleeping = false;
        }
        // RV-55: a woken body needs a fresh sleep timer.
        slot.sleepTimer = 0;
      }
      for (
        let link = this.islandJointHead[index]!;
        link >= 0;
        link = this.islandJointNext[link]!
      ) {
        const other = this.islandJointOther[link]!;
        if (this.islandSeen[other] !== this.islandEpoch) {
          this.islandSeen[other] = this.islandEpoch;
          this.islandQueue.push(other);
        }
      }
      for (let c = 0; c < slot.colliderSlots.length; c += 1) {
        const collider = this.colliderSlots[slot.colliderSlots[c]!];
        if (!collider?.active || !collider.collider) continue;
        this.islandVisitorIndex = index;
        this.world.contactPairsWith(collider.collider, this.islandVisitor);
        this.islandVisitorIndex = -1;
      }
    }
  }

  /**
   * Catch wakes that did not go through the engine's public API or through
   * `finalizeBodies` (for example a raw Rapier `wakeUp`): a slot we slept
   * whose body is awake again wakes its whole island before the solver runs.
   */
  private wakeExternallyWokenBodies(): void {
    for (let i = 0; i < this.bodySlots.length; i += 1) {
      const slot = this.bodySlots[i]!;
      const body = slot.body;
      if (
        !slot.active ||
        !slot.sleeping ||
        slot.type !== "dynamic" ||
        !body ||
        body.isSleeping()
      ) {
        continue;
      }
      this.wakeIsland(i);
    }
  }

  /**
   * Sleep whole contact islands (07 §5.12).
   *
   * Rapier's island manager knows the real islands, but bodies are created
   * with `setCanSleep(false)` so the engine's own thresholds apply; §5.12
   * then requires the decision to be applied to a whole island, so the
   * island graph is rebuilt here on the ticks where a body has reached its
   * timer — union-find over contact pairs and joints, with fixed bodies
   * never joining — and an island sleeps only when every dynamic member
   * qualifies. Kinematic bodies join islands (Rapier's splitter follows
   * them) but never sleep; a `canSleep: false` body blocks its island from
   * sleeping. The per-island transition itself is not atomic inside Rapier:
   * a manual `body.sleep()` is flushed after the following step's solver,
   * which is why the gravity scale is zeroed alongside it (see below).
   */
  private sleepSettledIslands(): void {
    this.prepareIslandGraph();
    const count = this.bodySlots.length;
    for (let i = 0; i < count; i += 1) {
      this.islandQualify[i] = 1;
      this.islandAwake[i] = 0;
    }

    /* Seed the walk with every awake dynamic body whose timer has run. */
    this.islandQueue.length = 0;
    for (let i = 0; i < count; i += 1) {
      const slot = this.bodySlots[i]!;
      if (slot.type !== "dynamic" || !slot.canSleep || slot.sleeping) continue;
      if (this.islandParent[i]! < 0) continue;
      if (slot.sleepTimer < this.sleep.timeToSleep) continue;
      if (slot.body?.isSleeping()) continue;
      if (this.islandSeen[i] === this.islandEpoch) continue;
      this.islandSeen[i] = this.islandEpoch;
      this.islandQueue.push(i);
    }
    if (this.islandQueue.length === 0) return;

    /* Walk contacts and joints from the seeds to collect whole islands. */
    for (let head = 0; head < this.islandQueue.length; head += 1) {
      const index = this.islandQueue[head]!;
      const slot = this.bodySlots[index]!;
      for (
        let link = this.islandJointHead[index]!;
        link >= 0;
        link = this.islandJointNext[link]!
      ) {
        const other = this.islandJointOther[link]!;
        if (this.islandSeen[other] !== this.islandEpoch) {
          this.islandSeen[other] = this.islandEpoch;
          this.islandQueue.push(other);
        }
      }
      this.islandVisitorIndex = index;
      for (let c = 0; c < slot.colliderSlots.length; c += 1) {
        const collider = this.colliderSlots[slot.colliderSlots[c]!];
        if (!collider?.active || !collider.collider) continue;
        this.world.contactPairsWith(collider.collider, this.islandVisitor);
      }
      this.islandVisitorIndex = -1;
    }

    /* An island sleeps only when every awake dynamic member qualifies. */
    for (let head = 0; head < this.islandQueue.length; head += 1) {
      const index = this.islandQueue[head]!;
      const slot = this.bodySlots[index]!;
      const body = slot.body;
      if (slot.type !== "dynamic" || !body || body.isSleeping()) continue;
      const root = this.islandFind(index);
      this.islandAwake[root] = 1;
      if (
        !slot.canSleep ||
        slot.sleepTimer + SLEEP_TIMER_TOLERANCE < this.sleep.timeToSleep
      ) {
        this.islandQualify[root] = 0;
      }
    }

    for (let head = 0; head < this.islandQueue.length; head += 1) {
      const index = this.islandQueue[head]!;
      const slot = this.bodySlots[index]!;
      if (slot.type !== "dynamic") continue;
      const body = slot.body;
      if (!body || body.isSleeping()) continue;
      const root = this.islandFind(index);
      if (this.islandAwake[root] === 1 && this.islandQualify[root] === 1) {
        body.sleep();
        /*
         * A manual `body.sleep()` is a user change: Rapier flushes it after
         * the following step's solver, so the island is still integrated for
         * one or two steps. Gravity is the only external acceleration on a
         * settled body (velocities are zeroed by `sleep`), so zeroing the
         * gravity scale makes the transition motionless; `wakeIsland`
         * restores the authored scale on the side that wakes. The velocity
         * and contact state are untouched.
         */
        slot.sleepGravityScale = body.gravityScale();
        body.setGravityScale(0, false);
        slot.sleeping = true;
      }
    }
  }

  private finalizeBodies(dt: number): void {
    let sleepCandidate = false;
    for (let i = 0; i < this.bodySlots.length; i += 1) {
      const slot = this.bodySlots[i]!;
      const body = slot.body;
      if (!slot.active || !body) continue;
      copyVec3(slot.prevPosition, slot.curPosition);
      copyQuat(slot.prevRotation, slot.curRotation);
      body.translation(slot.curPosition);
      body.rotation(slot.curRotation);
      body.linvel(this.scratchVec);
      body.angvel(this.scratchVec2);

      const poseFinite =
        isFiniteVec3(slot.curPosition) && isFiniteQuat(slot.curRotation);
      const velocityFinite =
        isFiniteVec3(this.scratchVec) && isFiniteVec3(this.scratchVec2);
      if (!poseFinite || !velocityFinite) {
        this.stats.nonFiniteBodies += 1;
        if (!poseFinite) {
          scrubVec3(slot.curPosition);
          scrubQuat(slot.curRotation);
          body.setTranslation(slot.curPosition, true);
          body.setRotation(slot.curRotation, true);
          copyVec3(slot.prevPosition, slot.curPosition);
          copyQuat(slot.prevRotation, slot.curRotation);
        }
        if (!velocityFinite) {
          scrubVec3(this.scratchVec);
          scrubVec3(this.scratchVec2);
          body.setLinvel(this.scratchVec, false);
          body.setAngvel(this.scratchVec2, false);
        }
      }

      if (slot.type === "dynamic" || slot.type === "kinematicVelocity") {
        const linearSq =
          this.scratchVec.x * this.scratchVec.x +
          this.scratchVec.y * this.scratchVec.y +
          this.scratchVec.z * this.scratchVec.z;
        if (linearSq > PHYSICS_MAX_LINEAR_SPEED * PHYSICS_MAX_LINEAR_SPEED) {
          const scale = PHYSICS_MAX_LINEAR_SPEED / Math.sqrt(linearSq);
          this.scratchVec.x *= scale;
          this.scratchVec.y *= scale;
          this.scratchVec.z *= scale;
          body.setLinvel(this.scratchVec, false);
        }
        const angularSq =
          this.scratchVec2.x * this.scratchVec2.x +
          this.scratchVec2.y * this.scratchVec2.y +
          this.scratchVec2.z * this.scratchVec2.z;
        if (angularSq > PHYSICS_MAX_ANGULAR_SPEED * PHYSICS_MAX_ANGULAR_SPEED) {
          const scale = PHYSICS_MAX_ANGULAR_SPEED / Math.sqrt(angularSq);
          this.scratchVec2.x *= scale;
          this.scratchVec2.y *= scale;
          this.scratchVec2.z *= scale;
          body.setAngvel(this.scratchVec2, false);
        }
      }

      if (slot.type === "dynamic") {
        body.resetForces(false);
        body.resetTorques(false);
        if (slot.canSleep) {
          if (body.isSleeping()) {
            slot.sleeping = true;
          } else {
            // RV-55: a slot we put to sleep that is awake again was woken
            // externally (an impulse, or contact with an awake body). 07
            // §5.12 wakes the whole island, so propagate the wake before the
            // fresh timer below; a stale neighbour timer would otherwise
            // re-sleep the island in the same tick.
            if (slot.sleeping) this.wakeIsland(i);
            const linear = vecLength(
              this.scratchVec.x,
              this.scratchVec.y,
              this.scratchVec.z,
            );
            const angular = vecLength(
              this.scratchVec2.x,
              this.scratchVec2.y,
              this.scratchVec2.z,
            );
            if (
              linear < this.sleep.linearThreshold &&
              angular < this.sleep.angularThreshold
            ) {
              slot.sleepTimer += dt;
              if (
                slot.sleepTimer + SLEEP_TIMER_TOLERANCE >=
                this.sleep.timeToSleep
              ) {
                // The per-body timer only nominates; `sleepSettledIslands`
                // applies the decision to the whole island (§5.12).
                sleepCandidate = true;
              }
            } else {
              slot.sleepTimer = 0;
              slot.sleeping = false;
            }
          }
        } else {
          slot.sleeping = false;
          slot.sleepTimer = 0;
        }
      } else {
        slot.sleeping = false;
      }
    }
    if (sleepCandidate) this.sleepSettledIslands();
    let awake = 0;
    for (let i = 0; i < this.bodySlots.length; i += 1) {
      const slot = this.bodySlots[i]!;
      const body = slot.body;
      if (!slot.active || !body || slot.type !== "dynamic") continue;
      if (slot.enabled && !slot.sleeping && !body.isSleeping()) awake += 1;
    }
    this.awakeDynamicCount = awake;
  }

  private updateStats(): void {
    const stats = this.stats;
    stats.bodyCount = this.activeBodyCount;
    stats.colliderCount = this.activeColliderCount;
    stats.awakeBodyCount = this.awakeDynamicCount;
    stats.contactCount = this.activeContacts.size;
    stats.pairCount = this.activeContacts.size + this.activeTriggers.size;
    if (this.debug) {
      stats.stepMs = this.world.timingStep();
      stats.broadphaseMs = this.world.timingBroadPhase();
      stats.narrowphaseMs = this.world.timingNarrowPhase();
      stats.solverMs = this.world.timingSolver();
    } else {
      stats.stepMs = 0;
      stats.broadphaseMs = 0;
      stats.narrowphaseMs = 0;
      stats.solverMs = 0;
    }
  }

  private validateRay(input: RaycastInput): {
    direction: Vec3;
    context: QueryContext;
  } {
    if (!isFiniteVec3(input.origin)) {
      throw this._error("E_CONTRACT", "raycast: origin must be finite");
    }
    if (!isFiniteVec3(input.direction)) {
      throw this._error("E_CONTRACT", "raycast: direction must be finite");
    }
    const length = vecLength(
      input.direction.x,
      input.direction.y,
      input.direction.z,
    );
    if (length < 1e-9) {
      throw this._error("E_CONTRACT", "raycast: direction must be non-zero");
    }
    if (!isFiniteNumber(input.maxDistance) || input.maxDistance <= 0) {
      throw this._error("E_CONTRACT", "raycast: maxDistance must be > 0");
    }
    return {
      direction: vec3(
        input.direction.x / length,
        input.direction.y / length,
        input.direction.z / length,
      ),
      context: this.makeQueryContext(input.filter),
    };
  }

  private makeQueryContext(filter?: QueryFilter): QueryContext {
    let layer = 0;
    let mask = PHYSICS_DEFAULT_LAYER_MASK;
    let includeSensors = false;
    let excludeBody: RAPIER.RigidBody | undefined;
    let excludeCollider: RAPIER.Collider | undefined;
    if (filter !== undefined) {
      const validated = this.validateQueryFilter(filter);
      layer = validated.layer;
      mask = validated.mask;
      includeSensors = validated.includeSensors;
      if (filter.excludeBody !== undefined) {
        const slot = this.resolveBody(filter.excludeBody);
        excludeBody = slot?.body ?? undefined;
      }
      if (filter.excludeCollider !== undefined) {
        const slot = this.resolveCollider(filter.excludeCollider);
        excludeCollider = slot?.collider ?? undefined;
      }
    }
    const flags = includeSensors
      ? undefined
      : RAPIER_MODULE.QueryFilterFlags.EXCLUDE_SENSORS;
    const predicate = (collider: RAPIER.Collider): boolean => {
      const info = this._colliderFilterInfo(collider.handle);
      if (info === null) return false;
      if (!includeSensors && info.sensor) return false;
      return accepts(layer, mask, info.layer, info.mask);
    };
    return { flags, excludeCollider, excludeBody, predicate };
  }

  private validateQueryFilter(filter: QueryFilter): {
    layer: number;
    mask: number;
    includeSensors: boolean;
  } {
    const layer = filter.layer ?? 0;
    const mask = filter.mask ?? PHYSICS_DEFAULT_LAYER_MASK;
    if (!Number.isInteger(layer) || layer < 0 || layer >= PHYSICS_MAX_LAYERS) {
      throw this._error(
        "E_CONTRACT",
        `query: layer must be an integer in 0..${PHYSICS_MAX_LAYERS - 1}`,
      );
    }
    if (!isU32(mask)) {
      throw this._error(
        "E_CONTRACT",
        "query: mask must be an unsigned 32-bit integer",
      );
    }
    return { layer, mask, includeSensors: filter.includeSensors === true };
  }

  private writeRayHit(
    out: RaycastHit,
    slot: ColliderSlot,
    distance: number,
    origin: Vec3,
    direction: Vec3,
    normal: Vec3,
    featureType: number,
    featureId: number | undefined,
  ): void {
    out.collider = slot.handle;
    out.body = this.bodySlots[slot.bodyIndex]!.handle;
    out.distance = distance;
    out.point.x = origin.x + direction.x * distance;
    out.point.y = origin.y + direction.y * distance;
    out.point.z = origin.z + direction.z * distance;
    out.normal.x = normal.x;
    out.normal.y = normal.y;
    out.normal.z = normal.z;
    const dot =
      out.normal.x * direction.x +
      out.normal.y * direction.y +
      out.normal.z * direction.z;
    if (dot > 0) {
      out.normal.x = -out.normal.x;
      out.normal.y = -out.normal.y;
      out.normal.z = -out.normal.z;
    }
    out.sensor = slot.sensor;
    out.triangleIndex =
      slot.shape.kindCode === SHAPE_TRIMESH &&
      featureType === RAPIER_MODULE.FeatureType.Face &&
      featureId !== undefined
        ? featureId
        : -1;
  }

  private finishOverlap(out: ColliderHandle[], count: number): number {
    for (let i = 1; i < count; i += 1) {
      const value = out[i]!;
      let j = i - 1;
      while (j >= 0 && out[j]!.index > value.index) {
        out[j + 1] = out[j]!;
        j -= 1;
      }
      out[j + 1] = value;
    }
    out.length = count;
    return count;
  }
}

function makeBodySlot(index: number): BodySlot {
  return {
    active: false,
    generation: 1,
    type: "static",
    body: null,
    handle: INVALID_BODY_HANDLE,
    index,
    enabled: true,
    userData: 0,
    ccd: false,
    canSleep: true,
    sleepTimer: 0,
    sleepGravityScale: 1,
    colliderCount: 0,
    colliderSlots: [],
    explicitMass: 0,
    volume: 0,
    vehicleSlot: -1,
    characterSlot: -1,
    curPosition: vec3(),
    curRotation: quat(),
    prevPosition: vec3(),
    prevRotation: quat(),
    sleeping: false,
  };
}

function makeColliderSlot(index: number): ColliderSlot {
  return {
    active: false,
    generation: 1,
    collider: null,
    bodyIndex: -1,
    bodyGeneration: 0,
    handle: INVALID_COLLIDER_HANDLE,
    shape: EMPTY_SHAPE,
    localPosition: vec3(),
    localRotation: quat(),
    friction: PHYSICS_DEFAULT_FRICTION,
    restitution: PHYSICS_DEFAULT_RESTITUTION,
    sensor: false,
    layer: 0,
    mask: PHYSICS_DEFAULT_LAYER_MASK,
    density: PHYSICS_DEFAULT_DENSITY,
    volume: 0,
    index,
  };
}

function isFiniteBoxExtents(value: Vec3): boolean {
  return isFiniteVec3(value) && value.x > 0 && value.y > 0 && value.z > 0;
}

function scrubVec3(value: Vec3): void {
  if (!Number.isFinite(value.x)) value.x = 0;
  if (!Number.isFinite(value.y)) value.y = 0;
  if (!Number.isFinite(value.z)) value.z = 0;
}

function scrubQuat(value: Quat): void {
  if (!isFiniteQuat(value) || !normalizeQuatInPlace(value)) {
    value.x = 0;
    value.y = 0;
    value.z = 0;
    value.w = 1;
  }
}

interface ResolvedOptions {
  gravity: Vec3;
  fixedDt: number;
  solver: SolverConfig;
  sleep: SleepConfig;
  layers: readonly string[];
  maxDynamicBodies: number;
  maxColliders: number;
  debug: boolean;
}

function resolveOptions(options?: RapierWorldOptions): ResolvedOptions {
  const gravity = options?.gravity ?? PHYSICS_DEFAULT_GRAVITY;
  if (!isFiniteVec3(gravity)) {
    throw physicsError("E_CONTRACT", "gravity must be finite");
  }
  const fixedDt = options?.fixedDt ?? PHYSICS_FIXED_DT;
  if (!isFiniteNumber(fixedDt) || fixedDt <= 0) {
    throw physicsError("E_CONTRACT", "fixedDt must be > 0");
  }
  const solverInput = options?.solver;
  const velocityIterations =
    solverInput?.velocityIterations ??
    PHYSICS_DEFAULT_SOLVER.velocityIterations;
  const positionIterations =
    solverInput?.positionIterations ??
    PHYSICS_DEFAULT_SOLVER.positionIterations;
  const warmStarting =
    solverInput?.warmStarting ?? PHYSICS_DEFAULT_SOLVER.warmStarting;
  const substeps = solverInput?.substeps ?? PHYSICS_DEFAULT_SOLVER.substeps;
  if (
    !Number.isInteger(velocityIterations) ||
    velocityIterations < 1 ||
    velocityIterations > 16
  ) {
    throw physicsError(
      "E_CONTRACT",
      "solver.velocityIterations must be an integer in 1..16",
    );
  }
  if (
    !Number.isInteger(positionIterations) ||
    positionIterations < 0 ||
    positionIterations > 8
  ) {
    throw physicsError(
      "E_CONTRACT",
      "solver.positionIterations must be an integer in 0..8",
    );
  }
  if (substeps !== 1 && substeps !== 2) {
    throw physicsError("E_CONTRACT", "solver.substeps must be 1 or 2");
  }
  const sleepInput = options?.sleep;
  const linearThreshold =
    sleepInput?.linearThreshold ?? PHYSICS_DEFAULT_SLEEP.linearThreshold;
  const angularThreshold =
    sleepInput?.angularThreshold ?? PHYSICS_DEFAULT_SLEEP.angularThreshold;
  const timeToSleep =
    sleepInput?.timeToSleep ?? PHYSICS_DEFAULT_SLEEP.timeToSleep;
  if (
    !isFiniteNumber(linearThreshold) ||
    linearThreshold < 0 ||
    !isFiniteNumber(angularThreshold) ||
    angularThreshold < 0 ||
    !isFiniteNumber(timeToSleep) ||
    timeToSleep < 0
  ) {
    throw physicsError(
      "E_CONTRACT",
      "sleep thresholds and timeToSleep must be finite and >= 0",
    );
  }
  const layers = options?.layers ?? ["default"];
  if (layers.length < 1 || layers.length > PHYSICS_MAX_LAYERS) {
    throw physicsError(
      "E_CONTRACT",
      `layers must hold 1..${PHYSICS_MAX_LAYERS} names`,
    );
  }
  for (let i = 0; i < layers.length; i += 1) {
    const name = layers[i]!;
    if (typeof name !== "string" || name.length === 0) {
      throw physicsError("E_CONTRACT", "layer names must be non-empty strings");
    }
    for (let j = 0; j < i; j += 1) {
      if (layers[j] === name) {
        throw physicsError("E_CONTRACT", `duplicate layer name "${name}"`);
      }
    }
  }
  const maxDynamicBodies =
    options?.maxDynamicBodies ?? PHYSICS_MAX_DYNAMIC_BODIES;
  if (
    !Number.isInteger(maxDynamicBodies) ||
    maxDynamicBodies < 1 ||
    maxDynamicBodies > PHYSICS_HARD_MAX_DYNAMIC_BODIES
  ) {
    throw physicsError(
      "E_CONTRACT",
      `maxDynamicBodies must be an integer in 1..${PHYSICS_HARD_MAX_DYNAMIC_BODIES}`,
    );
  }
  const maxColliders = options?.maxColliders ?? PHYSICS_MAX_COLLIDERS;
  if (
    !Number.isInteger(maxColliders) ||
    maxColliders < 1 ||
    maxColliders > PHYSICS_HARD_MAX_COLLIDERS
  ) {
    throw physicsError(
      "E_CONTRACT",
      `maxColliders must be an integer in 1..${PHYSICS_HARD_MAX_COLLIDERS}`,
    );
  }
  return {
    gravity: vec3(gravity.x, gravity.y, gravity.z),
    fixedDt,
    solver: {
      velocityIterations,
      positionIterations,
      warmStarting,
      substeps,
    },
    sleep: { linearThreshold, angularThreshold, timeToSleep },
    layers: Object.freeze([...layers]),
    maxDynamicBodies,
    maxColliders,
    debug: options?.debug === true,
  };
}

/** Creates a Rapier adapter; call `await initRapierPhysics()` first. */
export function createRapierAdapter(): PhysicsAdapter {
  return {
    backend: "rapier",
    create(options?: PhysicsWorldOptions): PhysicsBackend {
      return new RapierPhysics3D(options as RapierWorldOptions | undefined);
    },
  };
}

/** Convenience factory for tests and hosts that already initialized Rapier. */
export function createRapierWorld(options?: RapierWorldOptions): RapierPhysics3D {
  return new RapierPhysics3D(options);
}

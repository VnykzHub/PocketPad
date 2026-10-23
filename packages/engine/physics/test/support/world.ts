/**
 * Shared helpers for the ER-07 adapter tests (spec 07 §8).
 *
 * Everything here is constructed by the test; no fixture value is a
 * measurement. Rapier's WASM must be initialized once per process via
 * `init()` before any world is created.
 */
import { quatCreate, vec3Create } from "@lanpad/engine-core";
import type { Quat, Vec3 } from "@lanpad/engine-core";
import {
  createRapierWorld,
  initRapierPhysics,
  isRapierReady,
} from "../../src/index.js";
import type {
  BodyDesc,
  BodyHandle,
  BodyState,
  ColliderDesc,
  ColliderHandle,
  ColliderState,
  ContactEvent,
  JointState,
  PhysicsWorldOptions,
  RaycastHit,
  ShapeCastHit,
  TriggerEvent,
  VehicleState,
} from "../../src/index.js";
import type { RapierPhysics3D } from "../../src/index.js";

/** Engine fixed step (07 §4.1). */
export const DT = 1 / 60;
export const FULL_MASK = 0xffffffff;

let pending: Promise<void> | null = null;

/** Idempotent Rapier initialization; await this in every test file. */
export function init(): Promise<void> {
  pending ??= initRapierPhysics();
  return pending;
}

/** Convenience world factory that refuses to run before `init()`. */
export function makeWorld(options?: PhysicsWorldOptions): RapierPhysics3D {
  if (!isRapierReady()) {
    throw new Error("physics tests must await init() before creating a world");
  }
  return createRapierWorld(options);
}

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return vec3Create(x, y, z);
}

export function q(x = 0, y = 0, z = 0, w = 1): Quat {
  return quatCreate(x, y, z, w);
}

export interface BodyFixture {
  readonly body: BodyHandle;
  readonly collider: ColliderHandle;
}

export type ColliderOptions = Omit<ColliderDesc, "shape">;
export type BodyOptions = Omit<Partial<BodyDesc>, "type" | "position">;

function createFixture(
  world: RapierPhysics3D,
  body: BodyDesc,
  collider: ColliderDesc,
): BodyFixture {
  const handle = world.createBody(body);
  const colliderHandle = world.createCollider(handle, collider);
  return { body: handle, collider: colliderHandle };
}

/** Static box whose centre is `position`. */
export function staticBox(
  world: RapierPhysics3D,
  position: Vec3,
  halfExtents: Vec3,
  colliderOptions: ColliderOptions = {},
): BodyFixture {
  return createFixture(
    world,
    { type: "static", position },
    { shape: { kind: "box", halfExtents }, ...colliderOptions },
  );
}

/** Ground slab whose top surface is at `top`. */
export function ground(
  world: RapierPhysics3D,
  top = 0,
  halfExtents: Vec3 = v3(50, 0.5, 50),
  colliderOptions: ColliderOptions = {},
): BodyFixture {
  return staticBox(
    world,
    v3(0, top - halfExtents.y, 0),
    halfExtents,
    colliderOptions,
  );
}

export function dynamicBox(
  world: RapierPhysics3D,
  position: Vec3,
  halfExtents: Vec3,
  bodyOptions: BodyOptions = {},
  colliderOptions: ColliderOptions = {},
): BodyFixture {
  return createFixture(
    world,
    { ...bodyOptions, type: "dynamic", position },
    { shape: { kind: "box", halfExtents }, ...colliderOptions },
  );
}

export function dynamicSphere(
  world: RapierPhysics3D,
  position: Vec3,
  radius: number,
  bodyOptions: BodyOptions = {},
  colliderOptions: ColliderOptions = {},
): BodyFixture {
  return createFixture(
    world,
    { ...bodyOptions, type: "dynamic", position },
    { shape: { kind: "sphere", radius }, ...colliderOptions },
  );
}

export function dynamicCapsule(
  world: RapierPhysics3D,
  position: Vec3,
  radius: number,
  halfHeight: number,
  bodyOptions: BodyOptions = {},
  colliderOptions: ColliderOptions = {},
): BodyFixture {
  return createFixture(
    world,
    { ...bodyOptions, type: "dynamic", position },
    { shape: { kind: "capsule", radius, halfHeight }, ...colliderOptions },
  );
}

export function staticTrimesh(
  world: RapierPhysics3D,
  position: Vec3,
  vertices: Float32Array,
  indices: Uint32Array,
  colliderOptions: ColliderOptions = {},
): BodyFixture {
  return createFixture(
    world,
    { type: "static", position },
    {
      shape: {
        kind: "trimesh",
        vertices,
        indices,
        triangleCount: indices.length / 3,
      },
      ...colliderOptions,
    },
  );
}

export function bodyState(): BodyState {
  return {
    position: v3(),
    rotation: q(),
    linearVelocity: v3(),
    angularVelocity: v3(),
    sleeping: false,
    enabled: true,
    mass: 0,
    userData: 0,
  };
}

export function colliderState(): ColliderState {
  return {
    body: { index: -1, generation: 0, __kind: "body" } as BodyHandle,
    friction: 0,
    restitution: 0,
    sensor: false,
    layer: 0,
    mask: 0,
    worldAabbMin: v3(),
    worldAabbMax: v3(),
  };
}

export function jointState(): JointState {
  return { error: 0, motorImpulse: 0, sleeping: false };
}

export function raycastHit(): RaycastHit {
  return {
    collider: {
      index: -1,
      generation: 0,
      __kind: "collider",
    } as ColliderHandle,
    body: { index: -1, generation: 0, __kind: "body" } as BodyHandle,
    distance: 0,
    point: v3(),
    normal: v3(),
    triangleIndex: -1,
    sensor: false,
  };
}

export function shapeCastHit(): ShapeCastHit {
  return { ...raycastHit(), travel: 0 };
}

export function vehicleState(): VehicleState {
  return { wheelCount: 0, speed: 0, forward: v3(0, 0, -1), wheels: [] };
}

export function contactEvents(): ContactEvent[] {
  return [];
}

export function triggerEvents(): TriggerEvent[] {
  return [];
}

export function stepTicks(world: RapierPhysics3D, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) world.step(DT);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function expectVecClose(
  actual: Vec3,
  expected: Vec3,
  epsilon = 1e-6,
): void {
  if (
    Math.abs(actual.x - expected.x) > epsilon ||
    Math.abs(actual.y - expected.y) > epsilon ||
    Math.abs(actual.z - expected.z) > epsilon
  ) {
    throw new Error(
      `expected (${expected.x}, ${expected.y}, ${expected.z}), got (${actual.x}, ${actual.y}, ${actual.z})`,
    );
  }
}

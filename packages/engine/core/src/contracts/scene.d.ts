/**
 * Scene/ECS contract (spec 03). Types and signatures only.
 *
 * Frozen names from 00 §3.2 (`EntityId`, `Entity`, `Transform`, `Scene`) are
 * preserved. Everything else is additive on `EngineScene`.
 */

import type { Mat4, Quat, Vec3 } from "./math.js";

/** Dense slot index; runtime-local, never persisted. */
export type EntityId = number;

/** Immutable handle; two handles match iff id and generation match. */
export interface Entity {
  readonly id: EntityId;
  readonly generation: number;
}

/**
 * Component registration descriptor. Ids 1..4095, built-ins own 1..4 and are
 * never reused. Registration happens at module scope, never inside a tick.
 */
export interface ComponentType<T> {
  readonly id: number;
  /** Unique across the build: ^[a-z][a-z0-9_.-]{0,63}$. */
  readonly name: string;
  /** True iff both `serialize` and `deserialize` are present. */
  readonly serializable: boolean;
  /** Fresh default value; called on entity creation and pool reset. */
  create(): T;
  /** JSON-safe payload. Required when serializable. */
  serialize?(value: T): unknown;
  /** Must return a fresh value, never a reference into `data`. */
  deserialize?(data: unknown): T;
  /** In-place reset for pooling; must overwrite every field of `out`. */
  reset?(out: T, data: unknown): void;
  /** Cleanup hook; once per removal, replacement or entity destroy. */
  onRemove?(value: T, entity: Entity): void;
}

export interface ComponentSpec<T> {
  readonly name: string;
  create(): T;
  serialize?(value: T): unknown;
  deserialize?(data: unknown): T;
  reset?(out: T, data: unknown): void;
  onRemove?(value: T, entity: Entity): void;
}

/** Throws `E_CONTRACT` on a duplicate name or a half codec pair. */
export function defineComponent<T>(spec: ComponentSpec<T>): ComponentType<T>;

/** Local transform; metres, unit quaternion, unitless scale. */
export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}
/** id 1, serializable; implicitly present on every entity. */
export const Transform: ComponentType<Transform>;

/** Read-only hierarchy edge, managed only through `setParent`. */
export interface Parent {
  readonly entity: Entity;
}
/** id 2. */
export const Parent: ComponentType<Parent>;

/** Asset ids, not GPU handles; 04 may add fields. */
export interface Renderable {
  mesh: string;
  material: string;
  visible: boolean;
  layer: number;
}
/** id 3, serializable. */
export const Renderable: ComponentType<Renderable>;

/** Display/debug only; gameplay must not depend on it. */
export interface Name {
  value: string;
}
/** id 4, serializable. */
export const Name: ComponentType<Name>;

/** Frozen 00 §3.2 surface. */
export interface Scene {
  /** Live entities, excluding destroyed slots. */
  readonly aliveCount: number;

  createEntity(): Entity;
  /** Destroys the entity and its subtree, post-order, then frees the slot. */
  destroyEntity(entity: Entity): void;
  isAlive(entity: Entity): boolean;

  add<T>(entity: Entity, type: ComponentType<T>, value: T): void;
  get<T>(entity: Entity, type: ComponentType<T>): T | undefined;
  has<T>(entity: Entity, type: ComponentType<T>): boolean;
  remove<T>(entity: Entity, type: ComponentType<T>): void;

  /** Enabled, alive entities; clears `out` first; writes existing handles. */
  query(out: Entity[], ...types: ComponentType<unknown>[]): Entity[];

  dispose(): void;
}

/** Raw dense storage; valid only until the next structural mutation. */
export interface ComponentColumn<T> {
  readonly type: ComponentType<T>;
  /** Dense ids, valid for indices [0, count). Include disabled entities. */
  readonly entityIds: Uint32Array;
  /** Dense values, valid for indices [0, count); do not mutate. */
  readonly values: readonly T[];
  readonly count: number;
  /** Scene-wide flags indexed by entity id; 1 = enabled. */
  readonly enabled: Uint8Array;
}

export interface SceneStats {
  alive: number;
  capacity: number;
  freeSlots: number;
  components: number;
  dirtyTransforms: number;
  maxDepth: number;
  staleHandleCount: number;
  dirtyReadCount: number;
  rejectedOperationCount: number;
  approxBytes: number;
}

export interface SceneOptions {
  /** Default 256, clamped to [16, 1_048_576]. */
  readonly initialCapacity?: number;
  /** Hard slot limit; default 1_048_576. */
  readonly maxEntities?: number;
  /** Default 64, clamped to [1, 256]. */
  readonly maxHierarchyDepth?: number;
  /** Enables dev throws and invariant counters; default false. */
  readonly devChecks?: boolean;
}

export interface EngineScene extends Scene {
  readonly disposed: boolean;

  queryCount(...types: ComponentType<unknown>[]): number;
  /** Like `query`, but includes disabled entities. */
  queryAll(out: Entity[], ...types: ComponentType<unknown>[]): Entity[];
  /** Raw dense storage; includes disabled entities. */
  column<T>(type: ComponentType<T>): ComponentColumn<T>;

  /** False when rejected (cycle, depth, stale handle). */
  setParent(child: Entity, parent: Entity | null): boolean;
  parentOf(entity: Entity): Entity | null;
  /** Insertion order; includes disabled children. */
  childrenOf(entity: Entity, out: Entity[]): Entity[];
  rootOf(entity: Entity): Entity;

  setEnabled(entity: Entity, enabled: boolean): void;
  isEnabled(entity: Entity): boolean;

  /** Copies the three TRS values and marks the entity dirty. */
  setTransform(
    entity: Entity,
    position: Vec3,
    rotation: Quat,
    scale: Vec3,
  ): void;
  /** Call after mutating a Transform returned by `get`. */
  markTransformDirty(entity: Entity): void;
  /** Recomputes dirty world matrices; returns the count. */
  updateWorldTransforms(): number;
  /** Read-only internal matrix; undefined for a dead entity. */
  worldMatrix(entity: Entity): Mat4 | undefined;

  reserve(type: ComponentType<unknown>, capacity: number): void;
  compact(): void;
  getStats(out: SceneStats): SceneStats;

  serialize(): SceneSnapshot;
  /** Validates fully, then replaces the scene; never partial. */
  load(snapshot: SceneSnapshot): void;
  /** Destroys all entities; allocator generations are preserved. */
  clear(): void;
}

export function createScene(options?: SceneOptions): EngineScene;

/** Index refers to the parent record in the same snapshot; always < own index. */
export interface SerializedEntity {
  readonly parent: number | null;
  /** Omitted when true; present only when disabled. */
  readonly enabled?: false;
  /** Component name to JSON-safe payload. */
  readonly components: Readonly<Record<string, unknown>>;
}

export interface SceneSnapshot {
  readonly formatVersion: 1;
  readonly entities: readonly SerializedEntity[];
}

export interface Prefab {
  readonly formatVersion: 1;
  /** ^[a-z0-9][a-z0-9/_.-]{0,63}$ */
  readonly id: string;
  /** Index of the returned root entity. */
  readonly root: number;
  readonly entities: readonly SerializedEntity[];
}

/** Throws `E_SCENE_FORMAT` on an invalid payload. */
export function parsePrefab(data: unknown): Prefab;
/** Fresh values through `deserialize`; two instances share nothing mutable. */
export function instantiatePrefab(
  scene: EngineScene,
  prefab: Prefab,
  parent?: Entity | null,
): Entity;

export interface EntityPoolOptions {
  /** Eager instances; default 0. */
  readonly initial?: number;
  /** Hard instance cap; default 1_024. */
  readonly max?: number;
  /** Default parent for acquired roots; default null. */
  readonly parent?: Entity | null;
}

export class EntityPool {
  constructor(scene: EngineScene, prefab: Prefab, options?: EntityPoolOptions);
  /** Reset, enabled instance root. Throws `E_SCENE_INVALID` at cap. */
  acquire(parent?: Entity | null): Entity;
  /** Disables every entity in the instance and returns it to the idle list. */
  release(entity: Entity): void;
  dispose(): void;
  readonly active: number;
  readonly idle: number;
  readonly created: number;
}

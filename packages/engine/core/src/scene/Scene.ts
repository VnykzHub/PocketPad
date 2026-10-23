/**
 * The concrete scene (spec 03 §3.4–§3.11, §5).
 *
 * Storage is per-instance; the only process-global state is the append-only
 * component registry. Structural methods are guarded against re-entry so an
 * `onRemove` callback cannot corrupt a destroy or a load.
 */

import type {
  ComponentColumn,
  ComponentType,
  EngineScene,
  Entity,
  Parent as ParentData,
  SceneOptions,
  SceneSnapshot,
  SceneStats,
  Transform as TransformData,
} from "../contracts/scene.js";
import type { Mat4, Quat, Vec3 } from "../contracts/math.js";
import { Parent, Transform } from "./builtins.js";
import { getComponentTypeById, listComponentTypes } from "./component.js";
import { ComponentStore } from "./ComponentStore.js";
import { DEAD_ENTITY, EntityAllocator } from "./EntityAllocator.js";
import { sceneError } from "./errors.js";
import {
  appendChild,
  collectPostOrder,
  isAncestorOrSelf,
  depthOf,
  rootOfId,
  subtreeHeight,
  unlinkFromParent,
  writeChildren,
} from "./Hierarchy.js";
import { runQuery } from "./Query.js";
import { buildSnapshot, decodeSnapshot } from "./Serialization.js";
import { TransformSystem } from "./TransformSystem.js";
import {
  FLAG_WORLD_DIRTY,
  MAX_SNAPSHOT_ENTITIES,
  resolveSceneOptions,
  type ResolvedSceneOptions,
  type SceneCounters,
} from "./types.js";

/** Fixed format depth cap for snapshots/prefabs (03 §4.1). */
const FORMAT_MAX_DEPTH = 64;

interface ParentView {
  entity: Entity;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertVec3(value: unknown, label: string): asserts value is Vec3 {
  if (
    !isObject(value) ||
    typeof value["x"] !== "number" ||
    typeof value["y"] !== "number" ||
    typeof value["z"] !== "number"
  ) {
    throw sceneError("E_CONTRACT", `${label}: expected a Vec3`);
  }
}

function assertQuat(value: unknown, label: string): asserts value is Quat {
  if (
    !isObject(value) ||
    typeof value["x"] !== "number" ||
    typeof value["y"] !== "number" ||
    typeof value["z"] !== "number" ||
    typeof value["w"] !== "number"
  ) {
    throw sceneError("E_CONTRACT", `${label}: expected a Quat`);
  }
}

function assertTransformShape(
  value: unknown,
  label: string,
): asserts value is TransformData {
  if (!isObject(value)) {
    throw sceneError("E_CONTRACT", `${label}: Transform value must be an object`);
  }
  assertVec3(value["position"], `${label}: position`);
  assertQuat(value["rotation"], `${label}: rotation`);
  assertVec3(value["scale"], `${label}: scale`);
}

function finiteVec3(value: Vec3): boolean {
  return (
    Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
  );
}

function finiteQuat(value: Quat): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z) &&
    Number.isFinite(value.w)
  );
}

function isEntityLike(value: unknown): value is Entity {
  if (!isObject(value)) return false;
  const id = value["id"];
  const generation = value["generation"];
  return (
    typeof id === "number" &&
    Number.isInteger(id) &&
    id >= 0 &&
    typeof generation === "number" &&
    Number.isInteger(generation) &&
    generation >= 0
  );
}

function describeHandle(entity: Entity | null | undefined): string {
  if (entity === null || entity === undefined) return String(entity);
  return `id=${String(entity.id)} generation=${String(entity.generation)}`;
}

export class SceneImpl implements EngineScene {
  private readonly resolved: ResolvedSceneOptions;
  private readonly allocator: EntityAllocator;
  private readonly stores: (ComponentStore<unknown> | undefined)[];
  private readonly transformStore: ComponentStore<TransformData>;
  private readonly transformSystem: TransformSystem;
  private readonly counters: SceneCounters = {
    staleHandleCount: 0,
    dirtyReadCount: 0,
    rejectedOperationCount: 0,
  };
  private readonly parentViews: (ParentView | undefined)[];

  private operationDepth = 0;
  private isDisposed = false;

  constructor(options?: SceneOptions) {
    this.resolved = resolveSceneOptions(options);
    this.allocator = new EntityAllocator(
      this.resolved.initialCapacity,
      this.resolved.maxEntities,
    );
    this.parentViews = new Array<ParentView | undefined>(this.allocator.capacity);
    this.stores = [];
    this.transformStore = new ComponentStore<TransformData>(Transform, this.allocator);
    this.stores[Transform.id] = this.transformStore as unknown as ComponentStore<unknown>;
    this.transformSystem = new TransformSystem(
      this.allocator,
      this.transformStore,
      this.counters,
    );
  }

  // ---------------------------------------------------------------- identity

  get aliveCount(): number {
    return this.isDisposed ? 0 : this.allocator.liveCount;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  /** Internal: the pool uses this to decide throw-vs-no-op. */
  get devChecks(): boolean {
    return this.resolved.devChecks;
  }

  /** Internal: pool accounting hook. */
  noteRejectedOperation(): void {
    this.counters.rejectedOperationCount += 1;
  }

  /** Internal: pool accounting hook. */
  noteStaleHandle(): void {
    this.counters.staleHandleCount += 1;
  }

  isAlive(entity: Entity): boolean {
    return !this.isDisposed && this.allocator.isAliveHandle(entity);
  }

  createEntity(): Entity {
    if (this.isDisposed) {
      throw sceneError("E_CONTRACT", "createEntity: scene is disposed");
    }
    if (this.operationDepth > 0) {
      throw sceneError("E_CONTRACT", "createEntity: scene is not re-entrant");
    }
    this.operationDepth = 1;
    try {
      return this.createEntityInternal();
    } finally {
      this.operationDepth = 0;
    }
  }

  private createEntityInternal(): Entity {
    const previousCapacity = this.allocator.capacity;
    const entity = this.allocator.allocate();
    if (this.allocator.capacity !== previousCapacity) this.syncCapacity();
    this.parentViews[entity.id] = { entity: DEAD_ENTITY };
    this.transformStore.add(entity.id, Transform.create(), entity);
    return entity;
  }

  destroyEntity(entity: Entity): void {
    if (!this.enter("destroyEntity")) return;
    try {
      if (!this.checkHandle(entity, "destroyEntity")) return;
      this.destroySubtree(entity.id);
    } finally {
      this.exit();
    }
  }

  private destroySubtree(rootId: number): void {
    const order = this.allocator.postOrder;
    const count = collectPostOrder(this.allocator, rootId, order);
    for (let index = 0; index < count; index += 1) {
      this.destroySlot(order[index]!);
    }
  }

  private destroySlot(id: number): void {
    const handle = this.allocator.handles[id]!;
    const types = listComponentTypes();
    for (let typeIndex = 0; typeIndex < types.length; typeIndex += 1) {
      const type = types[typeIndex]!;
      if (type.id === Parent.id) continue;
      const store = type.id < this.stores.length ? this.stores[type.id] : undefined;
      if (store !== undefined && store.has(id)) store.remove(id, handle);
    }
    unlinkFromParent(this.allocator, id);
    this.parentViews[id] = undefined;
    this.allocator.release(id);
  }

  // -------------------------------------------------------------- components

  add<T>(entity: Entity, type: ComponentType<T>, value: T): void {
    if (!this.enter("add")) return;
    try {
      if (!this.checkHandle(entity, "add")) return;
      this.addInternal(entity, type, value);
    } finally {
      this.exit();
    }
  }

  private addInternal<T>(entity: Entity, type: ComponentType<T>, value: T): void {
    const registered = getComponentTypeById(type.id);
    if ((registered as unknown) !== (type as unknown)) {
      throw sceneError(
        "E_CONTRACT",
        `add: component type ${String(type.name)} is not registered`,
      );
    }
    if ((type as unknown) === (Transform as unknown)) {
      this.addTransform(entity, value as unknown);
      return;
    }
    if ((type as unknown) === (Parent as unknown)) {
      const target = (value as unknown as ParentData | null | undefined)?.entity;
      if (!isEntityLike(target)) {
        throw sceneError("E_CONTRACT", "add: Parent value must carry an entity handle");
      }
      this.setParentInternal(entity, target);
      return;
    }
    this.getOrCreateStore(type).add(entity.id, value, entity);
  }

  private addTransform(entity: Entity, value: unknown): void {
    assertTransformShape(value, "add");
    if (
      !finiteVec3(value.position) ||
      !finiteQuat(value.rotation) ||
      !finiteVec3(value.scale)
    ) {
      this.noteNonFinite("add");
    }
    this.transformStore.add(entity.id, value, entity);
    this.transformSystem.markDirty(entity.id);
  }

  get<T>(entity: Entity, type: ComponentType<T>): T | undefined {
    if (this.isDisposed) {
      this.disposedRead("get");
      return undefined;
    }
    if (!this.allocator.isAliveHandle(entity)) {
      this.staleRead("get", entity);
      return undefined;
    }
    if ((type as unknown) === (Transform as unknown)) {
      return this.transformStore.get(entity.id) as unknown as T | undefined;
    }
    if ((type as unknown) === (Parent as unknown)) {
      if (this.allocator.parent[entity.id]! === -1) return undefined;
      return this.parentViews[entity.id] as unknown as T | undefined;
    }
    return this.storeOf(type)?.get(entity.id) as unknown as T | undefined;
  }

  has<T>(entity: Entity, type: ComponentType<T>): boolean {
    if (this.isDisposed) {
      this.disposedRead("has");
      return false;
    }
    if (!this.allocator.isAliveHandle(entity)) {
      this.staleRead("has", entity);
      return false;
    }
    if ((type as unknown) === (Transform as unknown)) return true;
    if ((type as unknown) === (Parent as unknown)) {
      return this.allocator.parent[entity.id]! !== -1;
    }
    const store = this.storeOf(type);
    return store !== undefined && store.has(entity.id);
  }

  remove<T>(entity: Entity, type: ComponentType<T>): void {
    if (!this.enter("remove")) return;
    try {
      if (!this.checkHandle(entity, "remove")) return;
      if ((type as unknown) === (Transform as unknown)) {
        if (this.resolved.devChecks) {
          throw sceneError("E_SCENE_INVALID", "remove: Transform cannot be removed");
        }
        this.counters.rejectedOperationCount += 1;
        return;
      }
      if ((type as unknown) === (Parent as unknown)) {
        this.setParentInternal(entity, null);
        return;
      }
      const store = this.storeOf(type);
      if (store !== undefined) store.remove(entity.id, entity);
    } finally {
      this.exit();
    }
  }

  column<T>(type: ComponentType<T>): ComponentColumn<T> {
    if (this.isDisposed) {
      throw sceneError("E_CONTRACT", "column: scene is disposed");
    }
    if ((type as unknown) === (Parent as unknown)) {
      throw sceneError("E_CONTRACT", "column: Parent is a virtual component");
    }
    const registered = getComponentTypeById(type.id);
    if ((registered as unknown) !== (type as unknown)) {
      throw sceneError("E_CONTRACT", "column: component type is not registered");
    }
    return this.getOrCreateStore(type).column();
  }

  reserve(type: ComponentType<unknown>, capacity: number): void {
    if (!this.enter("reserve")) return;
    try {
      if ((type as unknown) === (Parent as unknown)) {
        throw sceneError("E_CONTRACT", "reserve: Parent is a virtual component");
      }
      const registered = getComponentTypeById(type.id);
      if (registered !== type) {
        throw sceneError("E_CONTRACT", "reserve: component type is not registered");
      }
      const requested = Number.isFinite(capacity) ? Math.floor(capacity) : 0;
      this.getOrCreateStore(type).reserve(
        Math.min(Math.max(requested, 0), this.resolved.maxEntities),
      );
    } finally {
      this.exit();
    }
  }

  compact(): void {
    if (!this.enter("compact")) return;
    try {
      for (let index = 0; index < this.stores.length; index += 1) {
        this.stores[index]?.compact();
      }
    } finally {
      this.exit();
    }
  }

  // ----------------------------------------------------------------- queries

  query(out: Entity[], ...types: ComponentType<unknown>[]): Entity[] {
    if (this.isDisposed) {
      this.disposedRead("query");
      out.length = 0;
      return out;
    }
    runQuery(this.allocator, this.stores, types, out, false);
    return out;
  }

  queryAll(out: Entity[], ...types: ComponentType<unknown>[]): Entity[] {
    if (this.isDisposed) {
      this.disposedRead("queryAll");
      out.length = 0;
      return out;
    }
    runQuery(this.allocator, this.stores, types, out, true);
    return out;
  }

  queryCount(...types: ComponentType<unknown>[]): number {
    if (this.isDisposed) {
      this.disposedRead("queryCount");
      return 0;
    }
    return runQuery(this.allocator, this.stores, types, null, false);
  }

  // --------------------------------------------------------------- hierarchy

  setParent(child: Entity, parent: Entity | null): boolean {
    if (!this.enter("setParent")) return false;
    try {
      return this.setParentInternal(child, parent);
    } finally {
      this.exit();
    }
  }

  private setParentInternal(child: Entity, parent: Entity | null): boolean {
    if (!this.checkHandle(child, "setParent")) return false;
    const childId = child.id;

    if (parent === null) {
      if (this.allocator.parent[childId]! !== -1) {
        unlinkFromParent(this.allocator, childId);
        this.setParentView(childId, -1);
        this.transformSystem.markDirty(childId);
      }
      return true;
    }

    if (!this.allocator.isAliveHandle(parent)) {
      return this.rejectOperation("setParent: parent handle is stale");
    }
    const parentId = parent.id;
    if (parentId === childId) {
      return this.rejectOperation("setParent: self-parenting is not allowed");
    }
    if (isAncestorOrSelf(this.allocator, childId, parentId)) {
      return this.rejectOperation("setParent: cycle rejected");
    }
    const maxDepth = this.resolved.maxHierarchyDepth;
    if (
      depthOf(this.allocator, parentId) + subtreeHeight(this.allocator, childId) >
      maxDepth
    ) {
      return this.rejectOperation(`setParent: depth cap ${maxDepth} would be exceeded`);
    }

    unlinkFromParent(this.allocator, childId);
    appendChild(this.allocator, childId, parentId);
    this.setParentView(childId, parentId);
    this.transformSystem.markDirty(childId);
    return true;
  }

  private setParentView(id: number, parentId: number): void {
    let view = this.parentViews[id];
    if (view === undefined) {
      view = { entity: DEAD_ENTITY };
      this.parentViews[id] = view;
    }
    view.entity = parentId === -1 ? DEAD_ENTITY : this.allocator.handles[parentId]!;
  }

  parentOf(entity: Entity): Entity | null {
    if (this.isDisposed) {
      this.disposedRead("parentOf");
      return null;
    }
    if (!this.checkHandle(entity, "parentOf")) return null;
    const parentId = this.allocator.parent[entity.id]!;
    return parentId === -1 ? null : this.allocator.handles[parentId]!;
  }

  childrenOf(entity: Entity, out: Entity[]): Entity[] {
    out.length = 0;
    if (this.isDisposed) {
      this.disposedRead("childrenOf");
      return out;
    }
    if (!this.checkHandle(entity, "childrenOf")) return out;
    writeChildren(this.allocator, entity.id, out);
    return out;
  }

  rootOf(entity: Entity): Entity {
    if (this.isDisposed) {
      this.disposedRead("rootOf");
      return DEAD_ENTITY;
    }
    if (!this.checkHandle(entity, "rootOf")) return DEAD_ENTITY;
    return this.allocator.handles[rootOfId(this.allocator, entity.id)]!;
  }

  setEnabled(entity: Entity, enabled: boolean): void {
    if (!this.enter("setEnabled")) return;
    try {
      if (!this.checkHandle(entity, "setEnabled")) return;
      this.allocator.enabled[entity.id] = enabled ? 1 : 0;
    } finally {
      this.exit();
    }
  }

  isEnabled(entity: Entity): boolean {
    if (this.isDisposed) {
      this.disposedRead("isEnabled");
      return false;
    }
    if (!this.allocator.isAliveHandle(entity)) {
      this.staleRead("isEnabled", entity);
      return false;
    }
    return this.allocator.enabled[entity.id] === 1;
  }

  // --------------------------------------------------------------- transform

  setTransform(
    entity: Entity,
    position: Vec3,
    rotation: Quat,
    scale: Vec3,
  ): void {
    if (!this.enter("setTransform")) return;
    try {
      if (!this.checkHandle(entity, "setTransform")) return;
      assertVec3(position, "setTransform: position");
      assertQuat(rotation, "setTransform: rotation");
      assertVec3(scale, "setTransform: scale");
      const current = this.transformStore.get(entity.id);
      if (current === undefined) {
        throw sceneError("E_CONTRACT", "setTransform: entity has no Transform");
      }
      const finite =
        finiteVec3(position) && finiteQuat(rotation) && finiteVec3(scale);
      if (!finite) this.noteNonFinite("setTransform");
      current.position.x = position.x;
      current.position.y = position.y;
      current.position.z = position.z;
      current.rotation.x = rotation.x;
      current.rotation.y = rotation.y;
      current.rotation.z = rotation.z;
      current.rotation.w = rotation.w;
      current.scale.x = scale.x;
      current.scale.y = scale.y;
      current.scale.z = scale.z;
      this.transformSystem.markDirty(entity.id);
    } finally {
      this.exit();
    }
  }

  markTransformDirty(entity: Entity): void {
    if (!this.enter("markTransformDirty")) return;
    try {
      if (!this.checkHandle(entity, "markTransformDirty")) return;
      this.transformSystem.markDirty(entity.id);
    } finally {
      this.exit();
    }
  }

  updateWorldTransforms(): number {
    if (!this.enter("updateWorldTransforms")) return 0;
    try {
      return this.transformSystem.update();
    } finally {
      this.exit();
    }
  }

  worldMatrix(entity: Entity): Mat4 | undefined {
    if (this.isDisposed) return undefined;
    return this.transformSystem.readWorld(entity);
  }

  // ------------------------------------------------------------------ stats

  getStats(out: SceneStats): SceneStats {
    if (this.isDisposed) {
      out.alive = 0;
      out.capacity = 0;
      out.freeSlots = 0;
      out.components = 0;
      out.dirtyTransforms = 0;
      out.maxDepth = 0;
      out.staleHandleCount = this.counters.staleHandleCount;
      out.dirtyReadCount = this.counters.dirtyReadCount;
      out.rejectedOperationCount = this.counters.rejectedOperationCount;
      out.approxBytes = 0;
      return out;
    }

    const allocator = this.allocator;
    let components = 0;
    for (let index = 0; index < this.stores.length; index += 1) {
      const store = this.stores[index];
      if (store !== undefined) components += store.count;
    }

    let dirtyTransforms = 0;
    for (let id = 0; id < allocator.nextId; id += 1) {
      if (allocator.alive[id] === 1 && (allocator.flags[id]! & FLAG_WORLD_DIRTY) !== 0) {
        dirtyTransforms += 1;
      }
    }

    let maxDepth = 0;
    const stack = allocator.updateStack;
    const depths = allocator.heightDepth;
    for (let root = 0; root < allocator.nextId; root += 1) {
      if (allocator.alive[root] !== 1 || allocator.parent[root] !== -1) continue;
      let top = 0;
      stack[top] = root;
      top += 1;
      depths[root] = 1;
      while (top > 0) {
        top -= 1;
        const id = stack[top]!;
        const depth = depths[id]!;
        if (depth > maxDepth) maxDepth = depth;
        for (
          let child = allocator.lastChild[id]!;
          child !== -1;
          child = allocator.prevSibling[child]!
        ) {
          depths[child] = depth + 1;
          stack[top] = child;
          top += 1;
        }
      }
    }

    let approxBytes = allocator.capacity * 43 + allocator.nextId * 96;
    for (let index = 0; index < this.stores.length; index += 1) {
      const store = this.stores[index];
      if (store !== undefined) approxBytes += store.approxBytes();
    }

    out.alive = allocator.liveCount;
    out.capacity = allocator.capacity;
    out.freeSlots = allocator.freeCount;
    out.components = components;
    out.dirtyTransforms = dirtyTransforms;
    out.maxDepth = maxDepth;
    out.staleHandleCount = this.counters.staleHandleCount;
    out.dirtyReadCount = this.counters.dirtyReadCount;
    out.rejectedOperationCount = this.counters.rejectedOperationCount;
    out.approxBytes = approxBytes;
    return out;
  }

  // ------------------------------------------------------------ serialization

  serialize(): SceneSnapshot {
    if (this.isDisposed) {
      throw sceneError("E_CONTRACT", "serialize: scene is disposed");
    }
    return buildSnapshot(this.allocator, this.stores);
  }

  load(snapshot: SceneSnapshot): void {
    if (!this.enter("load")) return;
    try {
      const maxDepth = Math.min(this.resolved.maxHierarchyDepth, FORMAT_MAX_DEPTH);
      const decoded = decodeSnapshot(snapshot, MAX_SNAPSHOT_ENTITIES, maxDepth);
      if (decoded.length > this.resolved.maxEntities) {
        throw sceneError(
          "E_SCENE_FORMAT",
          `load: ${decoded.length} entities exceeds scene capacity ${this.resolved.maxEntities}`,
        );
      }

      this.clearInternal();
      const created = new Array<Entity>(decoded.length);
      for (let index = 0; index < decoded.length; index += 1) {
        created[index] = this.createEntityInternal();
      }
      for (let index = 0; index < decoded.length; index += 1) {
        const parent = decoded[index]!.parent;
        if (parent === null) continue;
        this.linkParentInternal(created[index]!, created[parent]!);
      }
      for (let index = 0; index < decoded.length; index += 1) {
        const record = decoded[index]!;
        const entity = created[index]!;
        for (
          let componentIndex = 0;
          componentIndex < record.components.length;
          componentIndex += 1
        ) {
          const component = record.components[componentIndex]!;
          if ((component.type as unknown) === (Transform as unknown)) {
            this.transformStore.add(
              entity.id,
              component.value as TransformData,
              entity,
            );
          } else {
            this.getOrCreateStore(component.type).add(
              entity.id,
              component.value,
              entity,
            );
          }
        }
        if (!record.enabled) this.allocator.enabled[entity.id] = 0;
        this.transformSystem.markDirty(entity.id);
      }
    } finally {
      this.exit();
    }
  }

  private linkParentInternal(child: Entity, parent: Entity): void {
    unlinkFromParent(this.allocator, child.id);
    appendChild(this.allocator, child.id, parent.id);
    this.setParentView(child.id, parent.id);
    this.transformSystem.markDirty(child.id);
  }

  clear(): void {
    if (!this.enter("clear")) return;
    try {
      this.clearInternal();
    } finally {
      this.exit();
    }
  }

  private clearInternal(): void {
    const nextId = this.allocator.nextId;
    for (let id = 0; id < nextId; id += 1) {
      if (this.allocator.alive[id] === 1) this.destroySlot(id);
    }
    // Deterministic post-clear allocation: pop slot 0 first (ascending ids).
    this.allocator.freeCount = nextId;
    for (let id = 0; id < nextId; id += 1) {
      this.allocator.freeStack[nextId - 1 - id] = id;
    }
  }

  dispose(): void {
    if (this.isDisposed) return;
    if (this.operationDepth > 0) {
      throw sceneError("E_CONTRACT", "dispose: scene is not re-entrant");
    }
    this.operationDepth = 1;
    try {
      this.clearInternal();
      this.isDisposed = true;
      this.stores.length = 0;
      this.parentViews.length = 0;
    } finally {
      this.operationDepth = 0;
    }
  }

  // ---------------------------------------------------------------- internals

  private enter(method: string): boolean {
    if (this.isDisposed) {
      if (this.resolved.devChecks) {
        throw sceneError("E_CONTRACT", `${method}: scene is disposed`);
      }
      return false;
    }
    if (this.operationDepth > 0) {
      throw sceneError("E_CONTRACT", `${method}: scene is not re-entrant`);
    }
    this.operationDepth = 1;
    return true;
  }

  private exit(): void {
    this.operationDepth = 0;
  }

  private disposedRead(method: string): void {
    if (this.resolved.devChecks) {
      throw sceneError("E_CONTRACT", `${method}: scene is disposed`);
    }
  }

  private checkHandle(entity: Entity, method: string): boolean {
    if (this.allocator.isAliveHandle(entity)) return true;
    if (this.resolved.devChecks) {
      throw sceneError(
        "E_STALE_HANDLE",
        `${method}: stale entity handle ${describeHandle(entity)}`,
      );
    }
    this.counters.staleHandleCount += 1;
    return false;
  }

  private staleRead(method: string, entity: Entity): void {
    if (this.resolved.devChecks) {
      throw sceneError(
        "E_STALE_HANDLE",
        `${method}: stale entity handle ${describeHandle(entity)}`,
      );
    }
    this.counters.staleHandleCount += 1;
  }

  private rejectOperation(message: string): false {
    if (this.resolved.devChecks) throw sceneError("E_SCENE_INVALID", message);
    this.counters.rejectedOperationCount += 1;
    return false;
  }

  private noteNonFinite(method: string): void {
    if (this.resolved.devChecks) {
      throw sceneError(
        "E_SCENE_INVALID",
        `${method}: Transform values must be finite`,
      );
    }
    this.counters.rejectedOperationCount += 1;
  }

  private storeOf<T>(type: ComponentType<T>): ComponentStore<T> | undefined {
    return this.stores[type.id] as unknown as ComponentStore<T> | undefined;
  }

  private getOrCreateStore<T>(type: ComponentType<T>): ComponentStore<T> {
    const existing = this.storeOf(type);
    if (existing !== undefined) return existing;
    const store = new ComponentStore<T>(type, this.allocator);
    this.stores[type.id] = store as unknown as ComponentStore<unknown>;
    return store;
  }

  private syncCapacity(): void {
    for (let index = 0; index < this.stores.length; index += 1) {
      this.stores[index]?.ensureSparseCapacity(this.allocator.capacity);
    }
    if (this.parentViews.length < this.allocator.capacity) {
      this.parentViews.length = this.allocator.capacity;
    }
  }
}

/** Creates a new scene with the documented option clamps (03 §3.5). */
export function createScene(options?: SceneOptions): EngineScene {
  return new SceneImpl(options);
}

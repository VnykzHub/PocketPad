# 03 — Scene and ECS

**Status:** authoritative for the engine's scene, entity and component representation once implemented. This document specifies a target contract; no code in it exists yet.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`00-architecture.md`](00-architecture.md) for package boundaries and frozen names, [`01-core-loop-time.md`](01-core-loop-time.md) for the tick boundary, [`02-math.md`](02-math.md) for the transform primitives.
**Package:** `@lanpad/engine-core` at `packages/engine/core` (00 §3.7, §6). The brief's shorthand `packages/engine-core/src/scene/**` resolves to `packages/engine/core/src/scene/**`; no second package is created.

---

## 1. Goal

Give every engine subsystem and every game **one scene representation** for "what exists in the world and where it is".

The scene is deliberately small: identity, component storage, queries, a transform hierarchy and a serialization format. It owns no rendering, no collision, no animation sampling and no gameplay rules. Renderer, physics, animation, audio, AI, streaming, save/load and the editor all consume the same scene instead of inventing parallel entity lists.

The player-visible outcomes:

- a 10,000-entity scene updates its transforms every tick without a garbage-collection hitch and stays well inside the 14 ms frame budget;
- vehicle wheels, character attachments, doors and mounted weapons follow their parents without per-frame matrix allocation;
- renderer, physics and audio agree on the same world matrix for the same entity in the same tick;
- a scene or prefab can be saved, loaded and instanced with no shared mutable state between instances;
- a destroyed entity can never be silently addressed through an old handle.

The engineering outcomes:

- O(1) entity create/destroy, component add/get/remove, and parent changes;
- deterministic dense-array iteration (same build + same operation sequence = same order);
- zero allocation in the per-tick transform pass, in queries and in pooled spawn/despawn;
- one writer path for transforms so hierarchy updates cannot go stale silently.

**Scope.** Entity identity, component registration and storage, queries, the implicit `Transform`, parent/child hierarchy, dirty world-matrix propagation, scene snapshots, prefab instancing, entity pooling, and the integration contracts for renderer/physics/animation. Character controllers, collision, rendering, skinning and streaming are consumers, not part of this spec.

---

## 2. Non-goals

- **Not a renderer.** No culling, sorting, batching, material resolution, GPU upload or draw call. The renderer reads the scene (04/05).
- **Not a physics engine.** No bodies, shapes, contacts or collision queries. Physics defines its own components through `defineComponent` and writes transforms (07).
- **Not an animation system.** Bone buffers, clip sampling, blending and skinning belong to 08. Root motion writes a `Transform`; it does not live here.
- **Not a scripting or reflection system.** Component codecs are explicit functions. There is no decorator metadata, no class-instance serialization and no property inspection.
- **Not an archetype ECS.** Storage is a sparse set per component type. Archetype tables, automatic system scheduling and query caching by archetype are out of scope; they can replace the internals behind the same contract if a measured need appears.
- **Not a multi-threaded ECS.** The scene is main-thread only. Workers receive serialized bytes, never entities, components or scene references (00 §5.6).
- **Not a scene editor.** Selection, gizmos, undo and play-in-editor belong to 17. The editor uses this public API and snapshot format.
- **Not stable entity identity across save/load.** `EntityId` is a runtime slot, not a persistent id. Saves that need stable references must use their own game-level ids (15).
- **Not cross-entity component references in prefabs (v1).** Parent/child links are the only structural references a prefab may carry. Game components that reference other entities resolve those links at runtime after instantiation.
- **Not render interpolation.** The scene exposes the current tick's state. Interpolating between ticks is the renderer's responsibility (04) and may use its own previous-matrix buffer.
- **Not a spatial index.** Frustum culling, broadphase and cell partitioning are owned by 04/07/12.
- **Not a general graph.** Hierarchy is a forest: one parent at most, no cycles, depth ≤ 64.

---

## 3. Public interfaces

Everything below is exported from `@lanpad/engine-core`. Names fixed by 00 §3.2 (`EntityId`, `Entity`, `Transform`, `Scene`) are preserved exactly; everything else is additive on the concrete `EngineScene`.

**Ownership note.** 00 §3.2 lists `ComponentType` among "supporting structures owned by specs 01 and 04". `ComponentType` is the ECS registration contract, so this spec defines it. This is a clarification of ownership, not a change to a frozen name.

### 3.1 Identity

```ts
/** Dense slot index into the scene's storage. Runtime-local, never persisted. */
export type EntityId = number;

/**
 * An entity handle. `id` is the slot; `generation` distinguishes reuses of the
 * same slot. Handles are immutable and are created once per entity lifetime.
 */
export interface Entity {
  readonly id: EntityId;
  readonly generation: number;
}
```

Normative rules:

- `id` is allocated from `[0, maxEntities)` and is only reused after `destroyEntity`.
- `generation` starts at 1, increments on every reuse of the slot, wraps `u32` to 1 (never 0), and is compared by `isAlive`.
- An `Entity` value is a handle, not an owner. Holding one does not keep the entity alive.
- Two handles are the same entity if and only if both `id` and `generation` match.
- The scene stores exactly one handle object per live entity. `query` and `childrenOf` write those existing objects, so a query does not allocate handles.
- Generation wrap after 2³² reuses of one slot is unreachable in a session (about 2.27 years at 60 destroys/s on the same slot). It is still implemented correctly.

### 3.2 Component registration

```ts
export interface ComponentType<T> {
  /** Registration order, 1..4095. Built-ins own 1..4. Never reused. */
  readonly id: number;
  /** Unique across the build: ^[a-z][a-z0-9_.-]{0,63}$. */
  readonly name: string;
  /** True iff both serialize() and deserialize() are present. */
  readonly serializable: boolean;
  /** A fresh default value. Called on entity creation and pool reset. */
  create(): T;
  /** JSON-safe payload. Required when serializable. */
  serialize?(value: T): unknown;
  /** Must return a fresh value, never a reference into `data`. */
  deserialize?(data: unknown): T;
  /** In-place reset for pooling. Must overwrite every field of `out`. */
  reset?(out: T, data: unknown): void;
  /** Cleanup hook. Called once per removal, replacement or entity destroy. */
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

/** Registers a component type. Called at module scope, never in a tick. */
export function defineComponent<T>(spec: ComponentSpec<T>): ComponentType<T>;
```

Rules:

- `name` must be unique in the build. A duplicate throws `EngineError(E_CONTRACT)` at registration time, not at first use.
- Ids are assigned monotonically from 5 upward; built-ins reserve 1–4. A build may register at most 4,096 types.
- `serializable` is derived: `serialize !== undefined && deserialize !== undefined`. Supplying only one throws `E_CONTRACT`.
- The returned descriptor is frozen. The values it creates are not.
- `deserialize` and `reset` must not retain `data` or any nested array/object from it. Two instances of the same prefab must not share mutable state.
- `reset` is optional. A component without `reset` is poolable only at the cost of a fresh `deserialize` per acquire; core components implement it.
- Registration order is deterministic for one build because modules are evaluated in a fixed import graph. Serialized scenes store component **names**, never ids.

### 3.3 Built-in components

```ts
export interface Transform {
  position: Vec3;   // metres
  rotation: Quat;   // unit quaternion, 02 conventions
  scale: Vec3;      // unitless
}
/** id 1, serializable. Implicitly present on every entity. */
export const Transform: ComponentType<Transform>;

export interface Parent {
  readonly entity: Entity;
}
/** id 2. Managed only through setParent(); see §3.7. */
export const Parent: ComponentType<Parent>;

export interface Renderable {
  mesh: string;      // asset id from the asset manifest (06)
  material: string;  // asset id from the asset manifest (06)
  visible: boolean;  // default true
  layer: number;     // integer 0..31, default 0
}
/** id 3, serializable. Minimal scene-side render contract; 04 may add fields. */
export const Renderable: ComponentType<Renderable>;

export interface Name {
  value: string;     // ≤ 128 UTF-8 bytes, display/debug only
}
/** id 4, serializable. */
export const Name: ComponentType<Name>;
```

- `Transform` is added with identity values by `createEntity()`. It cannot be removed; adding it again replaces the value. `setTransform` mutates the existing object in place so references returned by `get` stay valid.
- `Parent` is a read-only view of the hierarchy edge. `add(entity, Parent, value)` is routed to `setParent(entity, value.entity)`; `remove(entity, Parent)` is routed to `setParent(entity, null)`. The stored `Parent` object is owned by the scene and must not be mutated by a caller.
- `Renderable` stores **asset ids**, not GPU handles. The renderer resolves ids to handles through the asset library (06) and owns handle lifetime. The scene never creates, retains or destroys a GPU resource.
- `Name` is optional and for tools/debug/save readability. Gameplay must not depend on it.
- Specs 04, 07, 08 and 12 may define additional built-in components in their own packages with `defineComponent`; they do not modify this file's built-ins.

### 3.4 Scene contract (00 §3.2, restated)

```ts
export interface Scene {
  /** Live entities, excluding destroyed slots. */
  readonly aliveCount: number;

  createEntity(): Entity;
  destroyEntity(entity: Entity): void;
  isAlive(entity: Entity): boolean;

  add<T>(entity: Entity, type: ComponentType<T>, value: T): void;
  get<T>(entity: Entity, type: ComponentType<T>): T | undefined;
  has<T>(entity: Entity, type: ComponentType<T>): boolean;
  remove<T>(entity: Entity, type: ComponentType<T>): void;

  /** Writes matches into a caller-owned array; clears it first. */
  query(out: Entity[], ...types: ComponentType<unknown>[]): Entity[];

  dispose(): void;
}
```

Semantics of the frozen surface:

- `createEntity()` is O(1), allocates a handle and a world matrix (cold path), adds an identity `Transform`, and returns the new handle.
- `destroyEntity(entity)` destroys the entity **and its whole subtree**, depth-first post-order (children before parent), then releases the slot. It is O(subtree + components).
- `isAlive(entity)` is O(1) and false for a stale generation, an out-of-range id, a destroyed entity or a disposed scene.
- `add` on an existing component replaces it: `onRemove(old)` runs before the new value is stored. `add` on an absent component appends it.
- `remove` of an absent component is a no-op with a dev counter. `remove(Transform)` is forbidden (§3.7).
- `get` returns the stored mutable object or `undefined`. For `Transform`, mutation requires `markTransformDirty`.
- `query` returns enabled, alive entities only (disabled entities are a pooling feature; §3.9). It clears `out` and writes handle references; it does not allocate after warm-up.
- `dispose()` is idempotent: it destroys every entity, runs every `onRemove`, releases storage and marks the scene disposed. Later calls are no-ops.

### 3.5 Engine scene extensions

The concrete scene adds the engine-internal surface. These members are additive to 00's `Scene`; a game-facing SDK type may expose only the frozen subset.

```ts
export interface ComponentColumn<T> {
  readonly type: ComponentType<T>;
  /** Dense entity ids, valid for indices [0, count). Read-only. */
  readonly entityIds: Uint32Array;
  /** Dense values, valid for indices [0, count). Read-only; do not mutate. */
  readonly values: readonly T[];
  readonly count: number;
  /** Scene-wide enabled flags indexed by entity id. 1 = enabled. */
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
  /** Initial slot capacity; default 256, clamped to [16, 1_048_576]. */
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

  /** Counts matches without writing them. */
  queryCount(...types: ComponentType<unknown>[]): number;
  /** Like query(), but includes disabled entities. Used by pools and tools. */
  queryAll(out: Entity[], ...types: ComponentType<unknown>[]): Entity[];
  /** Raw dense storage for an engine system. Includes disabled entities. */
  column<T>(type: ComponentType<T>): ComponentColumn<T>;

  /** Returns false when the link is rejected (cycle, depth, stale handle). */
  setParent(child: Entity, parent: Entity | null): boolean;
  parentOf(entity: Entity): Entity | null;
  /** Writes children in insertion order; includes disabled children. */
  childrenOf(entity: Entity, out: Entity[]): Entity[];
  rootOf(entity: Entity): Entity;

  setEnabled(entity: Entity, enabled: boolean): void;
  isEnabled(entity: Entity): boolean;

  /** Copies the three TRS values and marks the entity dirty. */
  setTransform(entity: Entity, position: Vec3, rotation: Quat, scale: Vec3): void;
  /** Call after mutating a Transform returned by get(). */
  markTransformDirty(entity: Entity): void;
  /** Recomputes world matrices for dirty entities. Returns the count. */
  updateWorldTransforms(): number;
  /** Internal matrix; read-only. Undefined for a dead entity. */
  worldMatrix(entity: Entity): Mat4 | undefined;

  /** Preallocates component storage; cold path only. */
  reserve(type: ComponentType<unknown>, capacity: number): void;
  /** Sorts dense arrays by entity id and shrinks capacity; cold path only. */
  compact(): void;
  getStats(out: SceneStats): SceneStats;

  serialize(): SceneSnapshot;
  /** Validates fully, then replaces the scene contents. Never partial. */
  load(snapshot: SceneSnapshot): void;
  /** Destroys all entities; allocator generations are preserved. */
  clear(): void;
}

export function createScene(options?: SceneOptions): EngineScene;
```

### 3.6 Queries and columns

`query(out, ...types)` is the only general-purpose iteration API:

1. `out.length = 0`.
2. With no types, append every enabled alive entity in ascending `id` order.
3. Otherwise choose the **driver** type: the column with the smallest `count`; ties go to the earliest argument. If the driver count is zero, return immediately.
4. Iterate the driver's dense rows in array order. For every other requested type, require an O(1) sparse-set membership hit.
5. Append the scene's existing `Entity` handle for the row.

Rules:

- Iteration order is the driver column's dense order. It is deterministic for a fixed sequence of operations but **not stable across structural changes**: component removal uses swap-remove. A game that needs a canonical order sorts its own results.
- `query` skips disabled entities; `queryAll` does not. Disabling never removes components or changes the hierarchy.
- `queryCount` runs the same selection logic and returns the count without writing an array.
- `column(type)` returns the raw dense arrays and is valid only until the next structural mutation of that component type. It is an engine-internal fast path: renderer, physics and animation may use it; games get `query`/`get`.
- A column includes disabled entities. Hot loops that must skip them check `column.enabled[entityId] === 1`.
- No `Map`/`Set` iteration, callback, closure or intermediate array is used in the query path.

### 3.7 Hierarchy and transforms

Hierarchy is a forest stored in the scene, not a component graph:

- One parent at most; roots have `parentOf() === null`.
- `setParent(child, parent)` validates both handles, rejects self-parenting, cycles and depth over `maxHierarchyDepth`, unlinks the old edge, appends to the new parent's children (insertion order), keeps the child's **local** Transform unchanged, and marks the child's subtree world-dirty.
- `setParent` returns `true` on success. In dev (`devChecks`), a rejected link throws `EngineError(E_SCENE_INVALID)`; in production it returns `false` and increments `rejectedOperationCount`.
- Handle validation order is fixed: a stale **child** is `E_STALE_HANDLE` (the operation's subject is gone); a stale **parent** is `E_SCENE_INVALID` (a link argument is invalid). Tests pin this distinction.
- Depth validation uses the moved subtree's height, not just the child's own depth: `depth(parent) + subtreeHeight(child)` must not exceed `maxHierarchyDepth`, so a moved subtree can never push its descendants past the cap.
- `childrenOf` writes handles in insertion order. Removal from a sibling list is O(1) but preserves order (linked list, not swap-remove).
- Destroying a parent destroys the subtree. There is no implicit reparenting.
- `rootOf(entity)` returns the topmost ancestor, or the entity itself if it is a root.
- Depth is capped at 64 by default. The cap bounds destroy recursion, serialization depth and CPU cache behaviour.

Transform rules:

- Every entity has exactly one `Transform`, created with position `(0,0,0)`, rotation `(0,0,0,1)`, scale `(1,1,1)`.
- `remove(entity, Transform)` is forbidden: dev throws `E_SCENE_INVALID`; production no-ops and increments `rejectedOperationCount`.
- `setTransform` copies the three values into the existing `Transform` object and marks the entity dirty.
- Mutating a `Transform` obtained from `get` requires `markTransformDirty(entity)`. Components other than `Transform` have no derived state and need no such call.
- `markTransformDirty(entity)` sets the entity's local and world dirty bits and marks every descendant world-dirty. It is iterative and allocation-free. If a descendant is already world-dirty, its own subtree is already covered and the walk stops there.
- `updateWorldTransforms()` traverses every root in ascending `id` order and every child list in insertion order, computing only world-dirty entities:
  - `local = mat4Compose(position, rotation, scale)`;
  - `world = parent === null ? local : mat4Multiply(parentWorld, local)`;
  - write the entity's persistent `Mat4`, clear both dirty bits.
- The traversal visits all entities (O(N)) but recomputes only dirty ones (O(D)), so a moved leaf costs one compose + one multiply, while a moved root costs its subtree.
- A fresh entity starts dirty, so the first `updateWorldTransforms()` after creation or load computes it.
- `worldMatrix(entity)` returns the internal `Mat4` for a live entity. Callers must not mutate it. Reading a world-dirty matrix increments `dirtyReadCount` in dev and returns the last computed value; the runtime calls `updateWorldTransforms()` before render, so this counter must stay 0 in normal operation.
- Transform values must be finite. Dev throws `E_SCENE_INVALID` on NaN/Infinity; production stores the value and increments `rejectedOperationCount`.
- The transform system never decomposes matrices and never writes back into `Transform`. Physics and animation own their own integration and call `setTransform`/`markTransformDirty`.

**Tick placement (normative).** The host adapter calls `updateWorldTransforms()` exactly once per fixed tick, after `game.simulate` and after drained job results, before the next render (01 §3.7 step 7). The renderer reads matrices only after that call. A game that renders its own scene state in `render(alpha)` reads the current tick's matrices.

### 3.8 Serialization and prefabs

```ts
export interface SerializedEntity {
  /** Index of the parent in this snapshot, or null for a root. Always < own index. */
  readonly parent: number | null;
  /** Omitted when true; present only when the entity is disabled. */
  readonly enabled?: false;
  /** Component name → JSON-safe payload. */
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

export function parsePrefab(data: unknown): Prefab;
export function instantiatePrefab(
  scene: EngineScene,
  prefab: Prefab,
  parent?: Entity | null
): Entity;
```

Rules:

- `serialize()` emits a pre-order DFS: roots in ascending `id` order, children in insertion order, parent always before child. This makes `parent` a backward index and removes cycles by construction.
- Component key order is deterministic: `transform` first, then every remaining component in ascending `ComponentType.id` order. JSON object insertion order is preserved by `JSON.stringify`.
- `transform` is always written, including identity. `parent` is encoded by the record index, never as a component. `Parent` and the internal child list are never serialized.
- `enabled: false` is written only for disabled entities; enabled entities omit the field. This keeps pooled saves small.
- `load(snapshot)` validates the whole snapshot before mutating the scene, including every component codec, parent indices, depth and limits. On failure it throws `EngineError(E_SCENE_FORMAT)` and leaves the scene untouched. On success it clears the scene, creates entities in record order, applies parents, then applies components. Entity ids after load are runtime-local and may be reused from the free list.
- A missing `transform` component means identity. An unknown component name, an unregistered type, or a non-serializable type is `E_SCENE_FORMAT`.
- `serialize()` throws `E_SCENE_INVALID` if any live entity carries a component without codecs. A dev-only counter names the component and entity.
- Prefabs use the same record shape. `parsePrefab` validates JSON shape, limits, component names and the root index; it requires component types to be registered (load prefabs after module registration). `instantiatePrefab` creates fresh component values through `deserialize`, so two instances share nothing mutable. Cross-entity references inside component payloads are not remapped in v1; only `parent` links are structural.
- `instantiatePrefab` returns the entity for `prefab.root`. If `parent` is supplied, the root is parented to it after the subtree is built.

### 3.9 Pooling

SPEC PR-9.4 requires spawned entities to be pooled. The scene provides slot reuse and a prefab pool; it does not hide a pool behind `createEntity`.

```ts
export interface EntityPoolOptions {
  /** Instances created eagerly; default 0. */
  readonly initial?: number;
  /** Hard instance cap; default 1_024. */
  readonly max?: number;
  /** Default parent for acquired roots; default null (scene root). */
  readonly parent?: Entity | null;
}

export class EntityPool {
  constructor(scene: EngineScene, prefab: Prefab, options?: EntityPoolOptions);
  /** Returns a reset, enabled instance root. Throws E_SCENE_INVALID at cap. */
  acquire(parent?: Entity | null): Entity;
  /** Disables the instance and returns it to the idle list. */
  release(entity: Entity): void;
  dispose(): void;
  readonly active: number;
  readonly idle: number;
  readonly created: number;
}
```

Rules:

- A pool requires a prefab with exactly one root entity (`root` has `parent === null` and no other record has `parent === null`); otherwise the constructor throws `E_SCENE_INVALID`. This makes destroy/release ownership unambiguous.
- `acquire` pops an idle instance or instantiates a new one. It resets every component in the prefab to its prefab value using `reset` when present, otherwise `deserialize` (which allocates), sets every entity in the instance to enabled, applies the requested parent, and returns the root.
- `release` validates that the entity is an instance root owned by this pool, disables **every** entity in the instance (children included), and pushes the instance to the idle list. It does not destroy anything.
- `dispose` destroys every instance the pool created, active or idle. Destroying an instance externally is a contract violation in dev (`E_STALE_HANDLE`) and is tolerated in production by skipping it.
- With core components (all of which implement `reset`), `acquire`/`release` are O(components) and allocate nothing. With a game component that lacks `reset`, the pool still works but allocates on acquire; the dev counter records it.
- Pooled entities are normal entities. `query` excludes them while disabled; `queryAll`, `isAlive` and `childrenOf` still see them. Disabling is a query filter, not a transform cut: a disabled parent still contributes its world matrix to an enabled child.

### 3.10 Error and dev-check semantics

Error codes are from 00 §5.9. Every row is deterministic.

| Situation | Dev (`devChecks: true`) | Production |
|---|---|---|
| Stale or dead handle passed to `get`/`add`/`remove`/`destroy`/`setParent` | throw `E_STALE_HANDLE` | no-op, `staleHandleCount += 1` |
| `remove(entity, Transform)` | throw `E_SCENE_INVALID` | no-op, `rejectedOperationCount += 1` |
| `setParent` cycle, self-parent, depth cap, stale parent | throw `E_SCENE_INVALID` | return `false`, `rejectedOperationCount += 1` |
| Non-finite Transform value | throw `E_SCENE_INVALID` | store, `rejectedOperationCount += 1` |
| `worldMatrix` read while world-dirty | return last matrix, `dirtyReadCount += 1` | return last matrix, `dirtyReadCount += 1` |
| Invalid snapshot/prefab payload | throw `E_SCENE_FORMAT`; scene untouched | throw `E_SCENE_FORMAT`; scene untouched |
| Duplicate component name / half codec pair | throw `E_CONTRACT` at registration | throw `E_CONTRACT` at registration |
| Method on a disposed scene | throw `E_CONTRACT` | no-op |
| Pool exhausted | throw `E_SCENE_INVALID` | throw `E_SCENE_INVALID` |
| Pool release of a non-owned entity | throw `E_SCENE_INVALID` | no-op + counter |

`devChecks` is set by the host from the existing debug flag (`?debug=1`) and by every unit/property test. It is never enabled in a production bundle.

### 3.11 Mutation and ownership rules

- The scene owns entity slots, component storage, hierarchy arrays and world matrices. A `get` result is borrowed: the caller may mutate it but must not retain it past the entity's lifetime.
- `onRemove` is called exactly once per component value: on `remove`, on replacement by `add`, and on entity destroy. It is synchronous on the main thread and must not call `add`/`remove`/`destroyEntity` on the same scene.
- Destroying an entity while iterating a `query` result is allowed only if the loop re-checks `isAlive` before using each subsequent handle. Destroying while iterating a `column` is forbidden.
- A component value may hold references to external resources (for example an `AssetHandle`); `onRemove` is the only place the scene will tell it to release them. The scene never inspects component fields.
- No scene method is re-entrant. A callback (`onRemove`, codec) must not call back into structural scene mutation. A dev guard throws `E_CONTRACT` if it does.

---

## 4. Data formats

This spec owns the scene snapshot and prefab formats. Both are UTF-8 JSON. `SCENE_FORMAT_VERSION = 1` and `PREFAB_FORMAT_VERSION = 1` are recorded in 00 §4.1; a breaking field change bumps the version and adds a migration.

### 4.1 Scene snapshot (`.scene.json`, `formatVersion: 1`)

Synthetic example: a car root, a roof child, and a disabled spare wheel grandchild.

```json
{
  "formatVersion": 1,
  "entities": [
    {
      "parent": null,
      "components": {
        "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "renderable": { "mesh": "meshes/sedan", "material": "materials/car-paint", "visible": true, "layer": 0 },
        "name": { "value": "sedan" }
      }
    },
    {
      "parent": 0,
      "components": {
        "transform": { "position": [0, 0.9, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "name": { "value": "roof" }
      }
    },
    {
      "parent": 1,
      "enabled": false,
      "components": {
        "transform": { "position": [0.9, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "name": { "value": "spare-wheel" }
      }
    }
  ]
}
```

Field rules:

| Field | Type | Rule |
|---|---|---|
| `formatVersion` | integer | Exactly `1`; any other value is `E_SCENE_FORMAT` |
| `entities` | array | ≤ 65,536 records |
| `parent` | integer or null | `0 ≤ parent < own index`, or null; depth ≤ 64 |
| `enabled` | `false` or absent | Present only for disabled entities |
| `components` | object | 1..64 keys (including `transform`); names match `^[a-z][a-z0-9_.-]{0,63}$` |
| `transform.position` | `[x,y,z]` | Finite numbers, metres |
| `transform.rotation` | `[x,y,z,w]` | Finite numbers; not normalized on load |
| `transform.scale` | `[x,y,z]` | Finite numbers; zero and negative allowed |
| `renderable.mesh` / `.material` | string | Manifest id `^[a-z0-9][a-z0-9/_.-]{0,127}$` |
| `renderable.visible` | boolean | Default true when omitted |
| `renderable.layer` | integer | 0..31, default 0 |
| `name.value` | string | ≤ 128 UTF-8 bytes |
| Whole document | bytes | ≤ 32 MiB UTF-8 |

- Unknown **fields** inside a component payload are ignored by core codecs for forward compatibility. Unknown **component names** are refused: the build cannot invent semantics for a component it does not have.
- Unknown top-level fields are ignored.
- Numbers must be finite and JSON-representable; `NaN`, `Infinity` and numeric strings are refused.
- The serializer never writes `-0`; it writes `0`.
- A snapshot is data, never code. Loading uses `JSON.parse` plus validation; no `eval`, no module loading from bytes, no prototype assignment (`__proto__` and `constructor` keys are refused).

### 4.2 Prefab (`.prefab.json`, `formatVersion: 1`)

```json
{
  "formatVersion": 1,
  "id": "props/crate",
  "root": 0,
  "entities": [
    {
      "parent": null,
      "components": {
        "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "renderable": { "mesh": "meshes/crate", "material": "materials/wood", "visible": true, "layer": 0 },
        "name": { "value": "crate" }
      }
    },
    {
      "parent": 0,
      "components": {
        "transform": { "position": [0, 0.5, 0], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "renderable": { "mesh": "meshes/crate-lid", "material": "materials/wood", "visible": true, "layer": 0 }
      }
    }
  ]
}
```

Additional limits: ≤ 1,024 entity records, ≤ 4 MiB UTF-8, `root` a valid record index. `SceneSnapshot` entity/component field rules apply unchanged. Prefabs are immutable after `parsePrefab`; the returned object is frozen at the top level.

### 4.3 Golden fixtures (test-only)

| File | Contents |
|---|---|
| `packages/engine/core/test/scene/fixtures/scene-golden.json` | 50 synthetic entities, depth 5, Transform + Renderable + Name, one disabled entity, two roots |
| `packages/engine/core/test/scene/fixtures/prefab-golden.json` | One 5-entity prefab with two component types and a nested child |

Rules: synthetic values only, no production scene data; `load → serialize` must reproduce the same JSON object and stable key order; a changed fixture is explained by a format change.

---

## 5. Architecture

### 5.1 Modules

```
engine-core/src/scene/
  types.ts            EntityId, Entity, ComponentType, Scene, EngineScene, stats, options
  component.ts        defineComponent, registry, built-in descriptors
  builtins.ts         Transform/Parent/Renderable/Name codecs and defaults
  EntityAllocator.ts  slot allocation, generations, free list, alive checks, handles
  ComponentStore.ts   sparse-set storage per type, add/get/remove/column
  Hierarchy.ts        parent/children linked lists, cycle/depth validation
  TransformSystem.ts  dirty flags, mark, world-matrix pass
  Query.ts            driver selection, query/queryCount/queryAll
  Scene.ts            createScene(), SceneImpl, clear/dispose/stats
  Serialization.ts    snapshot validation, serialize/load, codecs dispatch
  Prefab.ts           parsePrefab, instantiatePrefab
  EntityPool.ts       prefab pool
  index.ts            barrel; the only import path consumers use
```

`engine-core/src/scene/` imports `engine-core/src/math/` and nothing else (00 D1/D2). It does not import a renderer, physics, assets, SDK or protocol package.

### 5.2 Entity storage

```ts
generations : Uint32Array(capacity)
alive       : Uint8Array(capacity)
enabled     : Uint8Array(capacity)
flags       : Uint8Array(capacity)   // bit0 hasWorld, bit1 localDirty, bit2 worldDirty
parent      : Int32Array(capacity)   // -1 = root
firstChild  : Int32Array(capacity)
lastChild   : Int32Array(capacity)
nextSibling : Int32Array(capacity)
prevSibling : Int32Array(capacity)
handles     : (Entity | undefined)[capacity]
world       : (Mat4 | undefined)[capacity]
free        : Uint32Array(capacity)  // LIFO stack of dead slot ids
```

- Capacity starts at `initialCapacity` (default 256) and doubles up to `maxEntities`. Growth copies arrays and is a cold path.
- `createEntity()`: pop `free` if non-empty, else take `nextId`; `generation = (generation + 1) >>> 0`, mapping 0 to 1; mark alive and enabled; allocate one immutable `Entity` handle and one `Float32Array(16)` world matrix; add identity `Transform`; set local+world dirty.
- `destroyEntity()`: resolve grandchildren-first (post-order), call `onRemove` for each component in ascending component id, unlink the parent edge, clear `alive`/`enabled`, drop the component values, push the slot onto `free`. The generation is **not** changed here; it changes on reuse, so handles remain stale between destroy and reuse.
- Slot reuse is LIFO, which is deterministic and keeps the working set warm.
- `clear()` destroys every alive entity but preserves `generations`, `free`, `nextId` and capacity. A handle from before `clear()` stays stale (alive = 0).
- Time and memory: create/destroy O(1) plus subtree/components; `isAlive` O(1).

### 5.3 Component storage

One `ComponentStore<T>` per registered type, created lazily on first `add` or `column`:

```ts
entityIds : Uint32Array(capacity)   // dense entity id per row
values    : (T | undefined)[]       // parallel values
sparse    : Int32Array(entityCapacity) // entity id -> row, -1 = absent
count     : number
```

- `add` on an absent component: append at `count`; `sparse[id] = count`; `count += 1`.
- `add` on an existing component: call `onRemove(old)`, replace `values[row]` in place, keep the row (no reordering). This is the replace semantics of §3.4.
- `remove`: swap the last row into the removed row, update the moved entity's sparse entry, clear the last value (`undefined` so the object can be collected), decrement `count`, set `sparse[id] = -1`, then call `onRemove`.
- `get`/`has`: one sparse lookup. A defensive check `entityIds[row] === id` detects a corrupted sparse array; it is asserted in dev.
- `column` returns the live arrays without copying. They are invalidated by the next structural mutation of that type.
- Growth doubles the dense arrays; `sparse` grows with the entity capacity. `reserve` preallocates both and is a load-time call.
- `compact()` rebuilds every store sorted by entity id and trims capacity to `max(16, nextPow2(aliveCount))`. It is a cold path used after load/clear and by the editor.

### 5.4 Query algorithm

```
query(out, types):
  out.length = 0
  if types.length == 0: append all alive+enabled handles by ascending id; return
  driver = type with smallest store.count (first argument wins ties)
  if driver.count == 0: return
  for row in 0..driver.count-1:
      id = driver.entityIds[row]
      if !alive[id] || !enabled[id]: continue
      for each other type:
          if sparse_other[id] < 0 || entityIds_other[sparse_other[id]] != id: break
      if all matched: out.push(handles[id])
```

- Complexity is O(`min(counts)` × `types.length`) plus output size. A 10,000-entity two-component query touches at most 10,000 rows.
- `queryAll` is identical but omits the `enabled` check.
- `queryCount` runs the same loop without `out`.
- The driver choice means argument order can change iteration order when two columns have equal counts. Engine systems must not rely on it; renderer sorting is explicit.
- `out` is cleared with `out.length = 0`, not `out = []`. The caller owns and reuses the array.

### 5.5 Hierarchy storage

Five `Int32Array`s per scene implement an ordered child list per entity:

- `parent[id]` — parent id or `-1`.
- `firstChild[id]` / `lastChild[id]` — ends of the child list.
- `nextSibling[id]` / `prevSibling[id]` — doubly linked order.

`setParent` is O(1) plus the cycle/depth walk (O(depth), ≤ 64):

1. Resolve both handles; reject stale, self, or a parent that is a descendant of the child (walk `parent` upward from the new parent).
2. Unlink from the old parent's list and append to the new parent's list. Order is insertion order.
3. Depth-check the new parent (`depth(parent) + 1 ≤ maxHierarchyDepth`).
4. Mark the child's subtree world-dirty. Local values are untouched.

`childrenOf` walks `firstChild` → `nextSibling` and writes the scene's handles. Destroy walks the same lists in post-order using a preallocated stack; depth is capped, so a pathological chain cannot overflow the JS stack.

### 5.6 Transform system and tick placement

Flags per slot: `localDirty` (the TRS changed), `worldDirty` (the matrix must be recomputed), `hasWorld` (at least one pass has run).

```
updateWorldTransforms():
  updated = 0
  for id in 0..nextId-1:                       // ascending id
    if !alive[id] or parent[id] != -1: continue
    stack.push(id)
    while stack not empty:
      e = stack.pop()
      if worldDirty[e]:
        local = mat4Compose(transform[e], ...)
        world  = parent[e] == -1 ? local : mul(world[parent[e]], local)
        write world[e]; clear local/world dirty; updated += 1
      push children of e in reverse insertion order   // so they pop in order
  return updated
```

- The traversal is O(N + D) and touches every entity to find dirty descendants; it allocates nothing because the stack is a preallocated `Int32Array`.
- `markTransformDirty(e)`: set local+world dirty on `e`; then walk descendants setting world dirty. If a descendant is already world-dirty, stop descending below it (its subtree was marked when it became dirty).
- `setTransform` is the preferred write path: it copies into the existing `Transform` and calls `markTransformDirty`.
- A game that mutates `get(e, Transform).position.x` directly must call `markTransformDirty(e)`; the dev validation test in §8 catches a missed mark.
- Tick placement is 01 §3.7 step 7: after `game.simulate` and drained job results, before the next render. The renderer never calls it; the host does.
- Physics may call `updateWorldTransforms()` early inside its own step if it needs world-space static shapes for the current tick. Dirty flags make a second call cheap.
- The world matrix is float32 (`Mat4.m`). Transform values are doubles. At large world coordinates the matrix loses precision; camera-relative rendering and origin rebasing are owned by 04/12 (02 §5.4, R6).

### 5.7 Serialization and prefab pipeline

```
serialize():
  validate every live entity has codecs for all components
  DFS roots ascending id, children insertion order
    emit { parent: indexOf(parent) | null, enabled?, components }
    components: transform first, then ascending component id
  return { formatVersion: 1, entities }

load(snapshot):
  validate formatVersion, limits, names, parent indices, depth
  decode every component into temporary values (allocates; cold path)
  clear()
  create entities in record order
  link parents by record index
  apply decoded components
  set enabled flags

instantiatePrefab(scene, prefab, parent?):
  validate root and single-root rule is the pool's job, not the parser's
  create records in order, link parents, decode components
  setParent(rootEntity, parent) when supplied
  return rootEntity
```

- Validation is complete before mutation. A codec throw in the middle of `load` therefore cannot leave a half-built scene.
- Decoding allocates; loading is a cold path. The per-tick path never serializes or instantiates unless a game spawns, and spawning is expected to use `EntityPool`.
- `JSON.stringify` of the returned snapshot is the canonical file form. The serializer does not itself stringify, so tooling can stream or pretty-print without reimplementing the contract.
- Prefab decoding uses the same codecs. `instantiatePrefab` calls `deserialize` per component per instance; `EntityPool` uses `reset` for allocation-free reuse.

### 5.8 Pooling

`EntityPool` keeps two parallel arrays per instance: the root `Entity` and the instance's entity list in prefab-record order. A `Uint32Array` stack of idle instance indices keeps release/acquire O(1) without array growth after `initial`.

- Construction instantiates `initial` instances, disables them and pushes them onto the idle stack.
- `acquire`: pop an idle instance or instantiate a new one (up to `max`); reset every record's components in record order; enable every instance entity; apply the parent; return the root.
- `release`: validate ownership; disable every instance entity; push the instance index. Components keep their last values until the next acquire resets them.
- Reset order is prefab-record order, which is parent-before-child, so a component's `onRemove`/`reset` never observes a half-reset hierarchy.
- `dispose`: destroy every created instance root, clear both arrays, mark the pool disposed. Idempotent.

Pooling is the only place where a live entity is intentionally excluded from `query`; it is still alive for `isAlive`, `childrenOf` and `queryAll`.

### 5.9 Determinism

- Entity ids are dense slots reused LIFO. The same sequence of create/destroy operations yields the same ids in the same build.
- Component dense order is append order; removal is swap-remove. The same add/remove sequence yields the same order.
- Query iteration follows the driver column's dense order; roots in the transform pass follow ascending id; children follow insertion order.
- No `Map`/`Set` iteration, object-key iteration or `Math.random` appears in a query, transform or pooling path. The component registry uses a `Map` only at registration time.
- Float arithmetic follows 02: doubles for TRS, float32 for matrices; deterministic per build and browser, not across browsers (00 §5.8).
- Snapshot serialization is deterministic: DFS order, component id order, no `-0`, no locale-dependent formatting.

### 5.10 Allocation and memory

| Path | Allocates | Notes |
|---|---|---|
| `createEntity` / `destroyEntity` | Yes, cold path | One handle + one `Float32Array(16)` per entity lifetime; destroy does not free them so a reused slot keeps its world buffer |
| `add` / `get` / `has` / `remove` | No, except the caller's value | Replacement reuses the row |
| `query` / `queryCount` / `queryAll` | No after `out` reaches capacity | `out.length = 0`; the caller preallocates |
| `column` | No | Returns existing arrays |
| `setTransform` / `markTransformDirty` | No | Mutates the existing `Transform`, uses the preallocated dirty stack |
| `updateWorldTransforms` | No | Preallocated stack; world matrices preallocated per entity |
| `EntityPool.acquire/release` | No when every component has `reset` | `deserialize` fallback is counted in dev |
| `serialize` / `load` / `instantiatePrefab` | Yes, cold path | JSON objects and decoded values |
| `getStats` | No | Writes into the caller's object |

Approximate steady-state storage per live entity: 4 B generation + 1 B alive + 1 B enabled + 1 B flags + 20 B hierarchy + 8 B handle reference + 64 B matrix + ~32 B handle object ≈ 131 B, plus component objects. `getStats().approxBytes` reports the actual capacity-based estimate; the acceptance row records it rather than asserting a guessed number.

### 5.11 Integration contracts

| Consumer | Reads | Writes | Rule |
|---|---|---|---|
| **Render path (04/05 + runtime encoder)** | `query`/`column(Renderable)`, `worldMatrix`, `Name` (debug) | Nothing | The runtime encoder resolves asset ids through 06, sorts by layer/material/mesh and submits draws; the backend executes them and never imports assets. Never mutates the scene. Interpolation between ticks is render-owned. |
| **Physics (07)** | `worldMatrix`, `column` for static bodies | `setTransform`/`markTransformDirty` for dynamic bodies | Runs inside `simulate`; never holds scene references after the tick unless retained by the game. |
| **Animation (08)** | `worldMatrix` for attachments | Root motion only, via `setTransform` | Bone poses stay in animation-owned buffers; the scene stores no skeleton state. |
| **Audio (09)** | `worldMatrix` for positional sources | Nothing | Reads after the tick's transform update. |
| **AI (11)** | `query`, `worldMatrix` | Agent component state | Decisions on the fixed tick only. |
| **Streaming (12)** | Prefab instantiation, `destroyEntity` on cell unload | Scene contents | Cells instantiate under one root; unloading destroys that root. |
| **Save/load (15)** | Scene snapshot for scene-owned state | `load` on restore | Runtime entity ids are never persisted; game state uses its own ids. |
| **Editor (17)** | Full public API, snapshot/prefab | Scene contents | Undo is editor-owned; it must not depend on entity ids surviving a load. |

The renderer's `Renderable` extraction order does not have to match query order; batching needs a sort. Spec 04 owns the sort key. The only hard rule is that the renderer must not read `worldMatrix` before the tick's `updateWorldTransforms()`.

### 5.12 Threading

- The scene is **main-thread only**. `Entity`, `ComponentType`, component values and `Mat4` are never posted to a worker.
- Serialization produces plain JSON-safe values; a worker may compress or hash the resulting bytes (01 jobs), but the scene read happens on the main thread.
- Worker results that create entities are applied at the tick boundary through the normal public API; they never mutate scene storage from a callback.
- Two scenes may coexist (for example editor preview + play scene) because storage is per-instance. The only global state is the append-only component registry.

---

## 6. File ownership

**This spec owns:** `docs/engine/03-scene-ecs.md` and the paths below. It owns no implementation in this wave.

| Path | Contents | Owner |
|---|---|---|
| `packages/engine/core/src/scene/types.ts` | `EntityId`, `Entity`, `ComponentType`, `Scene`, `EngineScene`, `SceneStats`, `SceneOptions`, `ComponentColumn` | 03 |
| `packages/engine/core/src/scene/component.ts` | `defineComponent`, registry, name/id rules | 03 |
| `packages/engine/core/src/scene/builtins.ts` | `Transform`, `Parent`, `Renderable`, `Name` descriptors and codecs | 03 |
| `packages/engine/core/src/scene/EntityAllocator.ts` | Slot allocation, generations, free list, handles, alive checks | 03 |
| `packages/engine/core/src/scene/ComponentStore.ts` | Sparse-set storage, add/get/remove, column view, reserve/compact | 03 |
| `packages/engine/core/src/scene/Hierarchy.ts` | Parent/child linked lists, cycle and depth validation, post-order destroy | 03 |
| `packages/engine/core/src/scene/TransformSystem.ts` | Dirty bits, `markTransformDirty`, world pass, tick placement helpers | 03 |
| `packages/engine/core/src/scene/Query.ts` | Driver selection, `query`, `queryCount`, `queryAll` | 03 |
| `packages/engine/core/src/scene/Scene.ts` | `createScene`, `SceneImpl`, `clear`, `dispose`, `getStats`, `compact` | 03 |
| `packages/engine/core/src/scene/Serialization.ts` | Snapshot validation, `serialize`, `load`, codec dispatch | 03 |
| `packages/engine/core/src/scene/Prefab.ts` | `parsePrefab`, `instantiatePrefab` | 03 |
| `packages/engine/core/src/scene/EntityPool.ts` | Prefab pool, acquire/release/dispose | 03 |
| `packages/engine/core/src/scene/index.ts` | Barrel export | 03 |
| `packages/engine/core/test/scene/*.test.ts` | Unit, property, golden and integration tests | 03 |
| `packages/engine/core/test/scene/fixtures/scene-golden.json` | Snapshot golden fixture | 03 |
| `packages/engine/core/test/scene/fixtures/prefab-golden.json` | Prefab golden fixture | 03 |
| `packages/engine/core/test/scene/bench/scene10k.bench.ts` | 10,000-entity transform/query benchmark harness | 03 |
| `packages/runtime/src/game/GameContext.ts` | Additive `scene?: Scene` member and runtime assembly | integration agent / spec 18 |
| `packages/runtime/src/game/GameHost.ts` | Call `scene.updateWorldTransforms()` at 01 §3.7 step 7 | integration agent |

**Not owned by this spec:** `engine-core/src/math/**` (02), `engine-core/src/time/**` (01), `engine-core/src/render/contract.ts` (04), renderer packages (04/05), physics components and solvers (07), animation buffers (08), streaming cells (12), save payloads (15), editor UI (17), SDK type restatement (18), benchmark page and RESULTS rows (19).

---

## 7. Acceptance

**Evidence rule:** every row is PASS only with a recorded build, device, browser version, date and numbers in `docs/RESULTS.md`. Targets below are acceptance thresholds, not measurements. A row that has not run says PENDING and names the run it needs.

| ID | Criterion | Fixture / method | Hardware / environment | State |
|---|---|---|---|---|
| ER-03-01 | 100,000 create/destroy cycles reuse slots LIFO, increment generation on every reuse, never leak a slot (`capacity − alive == freeCount`), and make every stale handle return `isAlive === false`; generation wrapping maps to 1 and never 0 | `test/scene/entityAllocator.test.ts` | CI Node 20 | PENDING — test authoring |
| ER-03-02 | `add`/`get`/`has`/`remove` match a reference map for 10,000 random operations; replacement calls `onRemove` exactly once with the old value; removing an absent component is a no-op; `onRemove` order is ascending component id | `test/scene/componentStore.test.ts` + `fast-check` | CI Node 20 | PENDING |
| ER-03-03 | `query` and `queryCount` match a brute-force scan over 500 random scenes (≤ 2,000 entities, 8 component types, 20% disabled); a zero-type query returns all enabled entities in ascending id; `queryAll` includes disabled entities | `test/scene/query.property.test.ts` | CI Node 20 | PENDING |
| ER-03-04 | 10,000 queries over a 10,000-entity three-component scene with a preallocated `out` grow the heap by ≤ 64 KiB after warm-up; no handle objects are allocated | `test/scene/queryAlloc.bench.ts`, Node 20 `--expose-gc` | CI Node 20 | PENDING |
| ER-03-05 | 10,000 random `setParent` operations preserve a forest: no cycles, depth ≤ 64, children in insertion order; cycle/depth/self attempts are rejected; destroying a root destroys the subtree children-first and leaves no live descendant | `test/scene/hierarchy.property.test.ts` | CI Node 20 | PENDING |
| ER-03-06 | For 10,000 random TRS hierarchies, `worldMatrix` equals `mat4Multiply(parentWorld, mat4Compose(local))` within 1e-5; a moved leaf recomputes exactly 1 matrix; a moved root recomputes exactly its subtree; a missed `markTransformDirty` is detected by the dev full-recompute validator | `test/scene/transform.property.test.ts` | CI Node 20 | PENDING |
| ER-03-07 | **10k transform benchmark:** 10,000 entities as 1,000 roots × chains of 10 (depth 10). First pass (all dirty) p95 ≤ **3.0 ms**; steady state with 1% of entities dirtied per tick p95 ≤ **0.5 ms**; 120 warm-up then 600 measured passes; heap growth ≤ 64 KiB; `getStats().approxBytes` recorded | `test/scene/bench/scene10k.bench.ts` and `experiments/e-m0-engine/?bench=scene10k` | Desktop Chrome 155, Windows 11, 1920×1080 CSS, DPR 1; GPU adapter name recorded | PENDING — needs the M0 benchmark page |
| ER-03-08 | **10k query benchmark:** 10,000 entities with Transform + Renderable + Name; a two-component query into a preallocated array p95 ≤ **1.0 ms**; heap growth ≤ 64 KiB over 600 queries | Same page, `?bench=scene10k-query` | Desktop Chrome 155, Windows 11 | PENDING — needs the M0 benchmark page |
| ER-03-09 | `scene-golden.json` loads, serializes and loads again with identical component values, hierarchy and key order; serialization emits parents before children and component ids ascending; `formatVersion: 2` and a forward parent index are refused with `E_SCENE_FORMAT` and leave a non-empty scene unchanged | `test/scene/serialization.test.ts` | CI Node 20 | PENDING — fixture authored with this spec |
| ER-03-10 | One prefab instantiated 1,000 times produces no shared mutable references (mutating one instance's Transform or Renderable does not affect another); `EntityPool` acquires/releases 10,000 times with ≤ 64 KiB heap growth after warm-up, disables every instance entity on release, and excludes them from `query` but not `queryAll` | `test/scene/prefabPool.test.ts` | CI Node 20 | PENDING |
| ER-03-11 | A fake renderer walks 10,000 `Renderable` entities and their world matrices after one update with zero scene-owned allocation; a fake physics system writes 1,000 transforms and exactly those subtrees recompute; neither reads a dirty matrix (`dirtyReadCount === 0`) | `test/scene/integration.test.ts` | CI Node 20 | PENDING |
| ER-03-12 | `npm run check` stays green; no existing Coin Run or Reaction Duel test changes behaviour; the engine scene is opt-in through `GameContext.scene` and the legacy 2D path creates no scene | Existing gate + runtime adapter test | CI Node 20 | PENDING — integration wave |
| ER-03-13 | TV profile runs the 10k fixture: transform p95, query p95 and `approxBytes` recorded; no long task over 8 ms attributable to the scene | Same page, TV profile | **PENDING device:** 2020-era Android TV Chromium and a Tizen/webOS set (SPEC §12) | PENDING — no TV hardware |

The 30 µs/entity allowance in ER-03-07 (3.0 ms / 10,000) is deliberately loose: it catches accidental allocation, megamorphic dispatch and O(N²) dirty propagation, not hardware ranking. The measured value is recorded, never inferred.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | Entity allocator, generation rules, component add/replace/remove, query driver selection, hierarchy edges, dirty flags, codecs, pool state machine | `packages/engine/core/test/scene/*.test.ts` |
| Property (`fast-check`) | Query vs brute force; forest invariants under random parent operations; transform composition and dirty-count exactness; serialization round-trip for random scenes; prefab instance isolation | `test/scene/*.property.test.ts` |
| Golden | `scene-golden.json` and `prefab-golden.json` round-trip with stable key order; malformed snapshots refused without mutation | `test/scene/fixtures/` |
| Integration | Fake renderer and physics consumers; `GameHost` tick order calls `updateWorldTransforms` after simulate and before render; legacy games never create a scene | `test/scene/integration.test.ts`, `packages/runtime/test/loopAdapter.test.ts` (integration agent) |
| Benchmark | 10k transform pass, 10k query, query/pool allocation growth, entity op throughput | `test/scene/bench/scene10k.bench.ts`, `experiments/e-m0-engine/?bench=scene10k` (19) |
| Manual | TV transform/query/memory row | Device matrix, `docs/RESULTS.md` |

Test rules:

- Every title carries its `ER-03-NN` ID; the ID resolves to a traceability row.
- Property tests use a fixed `fast-check` seed in CI; a failure prints the shrunk scene and operation log.
- The dev validator for transforms recomputes every matrix and compares with the cached world matrix within 1e-5. It runs in property tests and `?debug=1` benchmark runs, never in production.
- Allocation tests warm up until the heap is stable, then measure with `--expose-gc`; a failing allocation row is a report, not a skipped correctness test.
- No test uses fixed sleeps or wall-clock time; the benchmark page reports p50, p95, max, frame count, browser version, adapter and build hash.
- A test may read another spec's fixture but may not edit it.

---

## 9. Dependencies

| Dependency | Why | Status |
|---|---|---|
| `00-architecture.md` | Package path, frozen `Entity`/`Transform`/`Scene` names, `ComponentType` clarification, error codes, no-per-frame-allocation rule | Written |
| `01-core-loop-time.md` | The tick boundary, host adapter order, job-result application before the transform pass | Written in the same wave |
| `02-math.md` | `Vec3`, `Quat`, `Mat4`, `mat4Compose`, `mat4Multiply`, tolerances | Written in the same wave |
| `04-renderer-webgpu.md` / `05-renderer-webgl2.md` | Consume `Renderable` and world matrices; own sorting, culling and interpolation | Later |
| `06-assets.md` | Resolves `Renderable.mesh`/`.material` ids; scene stores ids only | Later |
| `07-physics3d.md` | Defines body components, writes transforms, reads world matrices | Later |
| `08-animation.md` | Root motion writes transforms; bone buffers stay outside the scene | Later |
| `12-world-streaming.md` | Instantiates prefabs per cell; unloads by destroying roots | Later |
| `15-save-load.md` | Uses snapshots for scene-owned state; game ids are separate | Later |
| `17-editor.md` | Uses the public API and snapshot/prefab formats | Later |
| `18-game-sdk.md` | Restates `Scene` structurally as `GameContext.scene?`; no engine import in `sdk` | Later |
| `19-testing-benchmarks.md` | Owns the benchmark page, RESULTS rows and traceability registration | Later |

External dependencies: none. The scene uses only JavaScript built-ins and `engine-core` math.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | Query order changes after a component removal and a game depends on it | Medium | Nondeterministic gameplay, replay mismatch | Documented dense-order rule; renderer/physics sort explicitly; `compact()` gives id order after load; property test compares sets, not order |
| R2 | A game mutates `Transform` directly and forgets `markTransformDirty` | High over time | Stale world matrices, visible detachment | `setTransform` is the documented path; dev full-recompute validator counts mismatches; test ER-03-06 |
| R3 | Destroy during iteration corrupts dense storage or uses dead handles | Medium | Crashes, skipped entities, double frees | Documented two-pass rule; post-order subtree destroy; dev stale-handle throws; double destroy is a no-op in production |
| R4 | Hierarchy cycle or runaway depth is authored, causing infinite loops | Medium | Hang or stack overflow | `setParent` cycle/depth validation; snapshot rule `parent < own index`; depth cap 64; iterative destroy |
| R5 | Per-frame allocation creeps in through query results, handles or pools | High over time | GC hitches on TV | One handle per entity; `out.length = 0`; preallocated stacks; `reset` codecs; ER-03-04/07/10 allocation rows |
| R6 | Float32 world matrices jitter at large open-world coordinates | Medium | Visual jitter far from origin | TRS stays double; camera-relative rendering and origin rebasing are 04/12; documented limit |
| R7 | Serialization drifts from the runtime layout | Medium | Corrupt saves, editor/scene mismatch | One snapshot schema, golden round-trip, `formatVersion` gate, validate-before-mutate; codecs tested per built-in |
| R8 | Prefab instances share mutable component state | Medium | One crate's damage affects every crate | `deserialize`/`reset` must return independent values; ER-03-10; pool resets every record |
| R9 | `EntityPool` leaves disabled children visible to a system that bypasses `query` | Medium | Ghost objects, stale physics bodies | Column users must check `column.enabled`; integration test; `queryAll` reserved for pools/tools |
| R10 | Component registry global state leaks between tests or builds | Low | Id collisions, flaky tests | Append-only ids; unique names; duplicate throws at registration; tests define types once at module scope |
| R11 | `query` with an empty `out` array grows it repeatedly | Low | Minor allocation | Callers preallocate; benchmarks start with capacity; `queryCount` for sizing |
| R12 | Renderer reads matrices before the tick update | Medium | One-frame lag, visible lag on attachments | Host order is normative (01 §3.7 step 7); `dirtyReadCount` in dev; integration test |
| R13 | Snapshot size or entity count explodes under the editor | Medium | Long load, memory spike | Limits in §4.1; streaming splits worlds into cells (12); save uses game-level chunks (15) |
| R14 | `ComponentType` ownership is read differently by parallel agents | Low | Duplicate definitions | This spec defines it; 00 amended by note in §3; export path `engine-core/src/scene/types.ts` is single-owner |

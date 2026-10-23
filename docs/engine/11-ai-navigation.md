# 11 — AI and Navigation

**Status:** authoritative for `@lanpad/engine-ai`: navmesh build and serialization, path queries, steering and avoidance, behavior trees, perception, pedestrians and traffic. Written before implementation; nothing in this document is implemented.
**Milestone:** **M2** for the full system. The package exists at M0 as a skeleton only (00 §5.14), and no M0 wave may add AI behaviour.
**Authority:** [`SPEC.md`](../../SPEC.md) for product/protocol budgets, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) for the programme rules, [`00-architecture.md`](00-architecture.md) for layer boundaries and frozen contracts. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded in [`docs/todos/README.md`](../todos/README.md).

---

## 1. Goal

The player-visible outcome: a city where pedestrians walk around buildings, vehicles queue, merge and flow through junctions, and enemies or teammates navigate a multi-level map without walking through walls. It must run at the host's 60 Hz fixed tick alongside rendering, physics and up to eight phone players, and it must replay identically from the same seed and input trace within one build.

The engineering outcomes, in priority order:

1. **One navmesh pipeline.** The editor/tooling bakes navigation, the runtime loads it as per-cell tiles, and both call the same `buildNavMesh` and the same serialized format. There is no second, editor-only representation.
2. **Bounded, allocation-free queries.** A* over the polygon graph with an explicit expansion budget, funnel string-pulling, closest-point, ground raycast and surface move. All scratch is preallocated; a query never allocates.
3. **Behaviour is data.** Behavior trees are JSON; actions and conditions are registered by the game. No engine file names a game, a mission or a character.
4. **Explicit crowd and traffic budgets.** Agents get behavior LOD tiers with staggered ticks, so crowd cost is a counted budget rather than a surprise. Numbers in §7 are targets and stay PENDING until measured.
5. **Deterministic within one build/browser** (the scope limit in 00 §5.8). Update order, RNG streams, path-result application and intersection grants are all defined so a replay hash matches.
6. **Streaming-compatible.** Navigation is tiled per world cell (spec 12). Active agents are constrained to the simulation ring, so a load or unload never changes a decision; a path that would leave the resident set is refused with a specific status rather than silently truncated.

The reference workload is a Vice City-class city block: a vehicle-capable road network, sidewalks and crossings, building interiors on off-mesh links, and a few hundred visible pedestrians. Vice City is the architectural ceiling, not an M2 claim (00 §2).

---

## 2. Non-goals

- **Animation and locomotion playback.** Spec 08 owns clips, blend trees and root motion. AI publishes a locomotion intent (`desiredSpeed`, `desiredHeading`, `gait`) and animation state names; it never touches a skeleton.
- **Rigid-body dynamics and collision response.** Spec 07 owns bodies, vehicles and the character controller. Agents here are kinematic and call physics queries; the engine does not simulate a pedestrian ragdoll.
- **Runtime rebuild of a city navmesh.** Production worlds are baked offline. `buildNavMesh` exists in the package for tests, small dynamic arenas and editor preview, but a shipping open world must not bake 4,096 tiles at boot.
- **Dynamic navmesh cuts.** Moving obstacles are handled by local avoidance; baked geometry is static for a session. Destructible navigation is M3 or later and requires a rebuild policy this spec does not define.
- **Planners beyond behavior trees.** No GOAP, HTN, utility scoring or machine learning in M2. A game may build its own planner on top of `NavMeshQuery` and the perception API.
- **Flying, swimming, climbing or wall-running agents.** Agents are ground/2.5D on navmesh surfaces. Ladders, drops and vaults are off-mesh links with costs and animation flags.
- **Networked AI state, prediction or lockstep.** Spec 14 owns online sync. AI runs on the host only.
- **An editor UI.** Spec 17 owns tooling and the editor. This spec defines the bake settings, the file handoff, the bake report and the preview API.
- **A separate 2D pathfinding engine.** A top-down 2D game bakes a flat navmesh; area costs and blockers cover it. A grid A* is a game-side utility, not an engine subsystem.
- **Cross-browser bit-identical simulation.** Per-build replay only (00 §5.8). Trigonometry and float rounding may differ between engines.
- **Third-party navigation, behaviour-tree or crowd libraries, and WASM.** Zero third-party runtime dependencies (00 G7, D1). No `SharedArrayBuffer` requirement.

---

## 3. Public interfaces

Types are structural and backend-neutral. `Vec3`, `Quat`, `Aabb3`, `Entity`, `ComponentType` and `EngineRng` come from `@lanpad/engine-core` (specs 02 and 03); `PhysicsQuery` is the query facade of spec 07; `CellKey` and its canonicalization are owned by 00 §4.4. The package imports only `engine-core` and `engine-physics` (00 D2).

### 3.1 Limits

```ts
export const NAV_LIMITS = {
  maxPolygonsPerTile: 65_536,
  maxVerticesPerTile: 262_144,
  maxOffMeshLinksPerTile: 4_096,
  maxVertsPerPolygon: 6,
  maxAreaId: 31,                 // 0..31; 31 is permanently blocked
  maxPathPoints: 256,
  defaultAgentPathPoints: 64,
  maxAgentsPerCrowd: 4_096,
  maxTrafficVehicles: 512,
  maxBtNodes: 1_024,
  maxBtDepth: 32,
  maxBtStatefulNodes: 32,
  maxBlackboardFields: 64,
  maxPerceptionTargets: 8,
} as const;
```

### 3.2 Navmesh data and build

`buildNavMesh` is pure, synchronous and Node-safe. It performs no I/O, reads no DOM and is safe to call inside a worker; the `JobSystem` wrapper belongs to the caller (00 §5.6). The same input must produce byte-identical output on the same build/browser.

```ts
export interface NavAgentParams {
  readonly radius: number;             // metres, 0.1..2.0
  readonly height: number;             // metres, 0.5..4.0
  readonly maxSlopeDeg: number;        // 1..60
  readonly maxStepMeters: number;      // 0.05..0.8
  readonly minClearanceMeters: number; // overhead clearance, 0.5..8
}

export interface NavBlocker {
  readonly shape: "aabb" | "obb";
  readonly center: Vec3;
  readonly halfExtents: Vec3;
  readonly rotation?: Quat;            // obb only
}

export interface OffMeshLinkSpec {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly flags: readonly ("bidirectional" | "jump" | "ladder" | "door" | "vault")[];
  readonly areaId?: number;            // default 0
  readonly cost: number;               // 0.1..1000 seconds-equivalent
}

export interface NavBuildInput {
  /** World-space triangles, xyz triplets, 3 vertices per triangle. */
  readonly triangles: Float32Array;
  /** One area id per triangle. 31 or 255 = ignored. */
  readonly triangleArea: Uint8Array;
  readonly blockers: readonly NavBlocker[];
  readonly offMesh: readonly OffMeshLinkSpec[];
  readonly agent: NavAgentParams;
  /** Bake voxel edge in metres, 0.1..1.0. Not the world cell size. */
  readonly cellSizeMeters: number;
  /** Logical tile edge in metres, 8..256; the caller decides tile alignment. */
  readonly tileSizeMeters: number;
  readonly bounds: Aabb3;              // input clip box, usually one world cell
  /** 32 entries, index = area id, 0.1..1000; index 0 defaults to 1.0. */
  readonly areaCosts: readonly number[];
  readonly minRegionAreaMeters2: number; // default 4
  readonly edgeMaxErrorVoxels: number;   // default 1.1
}

export interface NavBuildWarning {
  readonly code: "narrow-portal" | "dropped-island" | "offmesh-unattached" | "degenerate-triangle";
  readonly count: number;
  readonly detail: string;             // no game data, no tokens
}

export interface NavBuildStats {
  readonly polygons: number;
  readonly vertices: number;
  readonly links: number;
  readonly offMeshLinks: number;
  readonly islandsDropped: number;
  readonly buildMs: number;            // reported, never gated in CI
}

export interface NavBuildResult {
  readonly data: NavMeshData;
  readonly stats: NavBuildStats;
  readonly warnings: readonly NavBuildWarning[];
}

/** Opaque runtime view; the serialized layout is §4.1. */
export interface NavMeshData {
  readonly formatVersion: 1;
  readonly tile: CellKey | null;       // null for a standalone one-tile map
  readonly agent: NavAgentParams;
  readonly contentHash: number;        // FNV-1a 32 over the canonical build input
  readonly bounds: Aabb3;
  readonly polygonCount: number;
}

export function buildNavMesh(input: NavBuildInput): NavBuildResult;
export function parseNavMesh(bytes: ArrayBuffer): NavMeshData;    // validates magic/version/bounds
export function serializeNavMesh(data: NavMeshData): ArrayBuffer; // deterministic bytes
```

### 3.3 Tile set and queries

One `NavMeshQuery` exists per system and thread. It owns all scratch. Calling it from two systems at once is a contract violation, caught by a dev assertion.

```ts
export interface NavMeshSet {
  addTile(key: CellKey, mesh: NavMeshData): void;   // stitches cross-tile portals
  removeTile(key: CellKey): void;                    // closes its portals
  hasTile(key: CellKey): boolean;
  readonly tileKeys: readonly CellKey[];             // canonical key order
  createQuery(): NavMeshQuery;
  readonly stats: NavMeshStats;
  dispose(): void;                                   // idempotent
}

export interface NavMeshStats {
  readonly tiles: number;
  readonly polygons: number;
  readonly crossTilePortals: number;
  readonly missingNeighborEdges: number;             // boundary edges with no matching resident tile
}

export type NavPathStatus = "complete" | "partial" | "failed" | "outside-streamed-world";

export interface NavPathOptions {
  readonly areaMask?: number;             // u32; bit i = area i allowed; default 0x7fffffff
  readonly maxExpandedNodes?: number;     // default 4096, hard cap 32768
  readonly allowPartial?: boolean;        // default false
  readonly goalToleranceMeters?: number;  // default 0.25
}

export interface NavPathBuffer {
  readonly points: Float32Array;          // caller-owned xyz triplets
  readonly capacity: number;              // floor(points.length / 3)
  count: number;                          // points written
  lengthMeters: number;
  cost: number;
}

export function createPathBuffer(maxPoints: number): NavPathBuffer; // maxPoints <= 256

export interface NavRaycastHit {
  readonly position: Vec3;
  readonly polygon: number;
  readonly distance: number;
}

export interface NavMeshQuery {
  /** Writes at most out.capacity points. Never allocates. */
  findPath(start: Vec3, end: Vec3, out: NavPathBuffer, options?: NavPathOptions): NavPathStatus;
  closestPoint(point: Vec3, maxDistanceMeters: number, out: Vec3): boolean;
  samplePoint(areaMask: number, rng: EngineRng, out: Vec3): boolean;
  /** Ground raycast along the navmesh surface in XZ. */
  raycast(from: Vec3, to: Vec3, out: NavRaycastHit): boolean;
  /** Slides a point along the surface; used for kinematic movement. */
  moveAlongSurface(from: Vec3, to: Vec3, out: Vec3): void;
}
```

`outside-streamed-world` is returned when either endpoint lies in a cell whose tile is not resident. Active agents must never receive this status in normal play because spec 12 constrains their goals to the simulation ring (§5.8).

### 3.4 Budgeted path requests

Path requests are amortised across ticks. `drain` runs A* under a shared expansion budget, so a long path cannot blow a frame. Results are applied by the caller at a tick boundary in request-id order.

```ts
export interface PathRequestQueue {
  request(agent: NavAgent, goal: Vec3, options?: NavPathOptions): number; // request id > 0
  /** Runs at most maxExpandedNodes total this call. Returns number of results written. */
  drain(tick: number, maxResults: number, maxExpandedNodes: number, out: PathResult[]): number;
  cancel(agent: NavAgent): void;
  readonly pending: number;
  dispose(): void;
}

export interface PathResult {
  agent: NavAgent | null;     // null = unused slot
  requestId: number;
  status: NavPathStatus;
  points: Float32Array;       // view valid until the next drain
  count: number;
  cost: number;
}
```

### 3.5 Agents, crowd and steering

Agent identity is stable across sessions and independent of load order. `localId` is assigned at bake and is unique within a cell; update order is `(cell.cx, cell.cy, localId)`, never ECS order.

```ts
export interface AgentId {
  readonly cell: CellKey;
  readonly localId: number;   // u16, 1..65535; 0 reserved
}

export interface NavAgent {
  readonly id: AgentId;
  position: Vec3;             // feet position on the navmesh
  velocity: Vec3;             // m/s, XZ
  readonly radius: number;
  readonly maxSpeed: number;
  state: "idle" | "moving" | "blocked" | "offmesh";
  readonly path: NavPathBuffer;
  readonly blackboard: Blackboard | null;
}

export interface AgentSpawnSpec {
  readonly id: AgentId;
  readonly position: Vec3;
  readonly radius: number;          // 0.2..1.0
  readonly maxSpeed: number;        // 0.5..8
  readonly behaviorTree?: BehaviorTree;
  readonly blackboardDefaults?: Readonly<Record<string, number>>;
}

export interface CrowdOptions {
  readonly maxAgents: number;              // <= 4096
  readonly focus: () => readonly Vec3[];   // powers behavior LOD; camera + players
  readonly nearRadiusMeters: number;       // default 40
  readonly midRadiusMeters: number;        // default 120
  readonly simRadiusMeters: number;        // default 250; must match spec 12
  readonly avoidanceNeighbors: number;     // default 24, max 32
  readonly seed: number;                   // u32
}

export interface CrowdStats {
  readonly agents: number;
  readonly near: number;
  readonly mid: number;
  readonly far: number;
  readonly blocked: number;
  readonly pathRequests: number;
  readonly avoidanceMs: number;            // rolling p95, 120 ticks
}

export interface Crowd {
  spawn(spec: AgentSpawnSpec): NavAgent | undefined; // undefined when full/invalid
  despawn(agent: NavAgent): void;
  setDestination(agent: NavAgent, goal: Vec3): void; // queues a path request
  stop(agent: NavAgent): void;
  setBehavior(agent: NavAgent, tree: BehaviorTree | null): void;
  /** Called once per fixed tick, after streaming's sim activation and before physics. */
  update(tick: number, dt: number): void;
  readonly agents: readonly NavAgent[];              // canonical update order
  readonly stats: CrowdStats;
  dispose(): void;                                   // idempotent
}
```

Path following, corner cutting and arrival use only `NavMeshQuery`; avoidance never writes a position directly outside `moveAlongSurface`. Turning speed and acceleration are agent fields with fixed defaults (`turnRateRadPerSec` 720 for pedestrians, `accel` 8 m/s²), configurable per spawn.

### 3.6 Behavior trees

```ts
export type BtStatus = "success" | "failure" | "running";

export interface BtAction {
  (ctx: BtContext, agent: NavAgent, dt: number): BtStatus;
}
export interface BtCondition {
  (ctx: BtContext, agent: NavAgent): boolean;
}

export interface BtActionRegistry {
  readonly actions: ReadonlyMap<string, BtAction>;
  readonly conditions: ReadonlyMap<string, BtCondition>;
}

export interface BlackboardSchema {
  readonly fields: readonly {
    readonly name: string;                 // ^[a-z][a-z0-9_]{0,31}$
    readonly type: "number" | "boolean" | "entity" | "vec3";
    readonly default: number;              // vec3 defaults to (0,0,0)
  }[];
}

export interface Blackboard {
  readonly schema: BlackboardSchema;
  number(field: number): number;
  setNumber(field: number, value: number): void;
  boolean(field: number): boolean;
  setBoolean(field: number, value: boolean): void;
  entity(field: number): number;           // game entity id, 0 = none
  setEntity(field: number, value: number): void;
  vec3(field: number, out: Vec3): Vec3;
  setVec3(field: number, x: number, y: number, z: number): void;
}

export function createBlackboard(schema: BlackboardSchema): Blackboard;
export function parseBehaviorTree(json: unknown, registry: BtActionRegistry): BehaviorTree;
export function createBtInstance(tree: BehaviorTree, blackboard: Blackboard): BtInstance;
export function tickBehaviorTree(instance: BtInstance, ctx: BtContext): BtStatus;

export interface BtContext {
  readonly tick: number;
  readonly dt: number;
  readonly world: AiWorld;
  readonly rng: EngineRng;                 // agent-scoped stream
}
```

`BehaviorTree` and `BtInstance` are opaque. Parsing validates the tree, resolves action/condition names against the registry and precomputes a stateful-node table; `tickBehaviorTree` is allocation-free.

### 3.7 Perception

```ts
export interface PerceptionConfig {
  readonly sightRangeMeters: number;        // 1..120
  readonly sightHalfAngleRad: number;      // 0.1..PI
  readonly hearingRadiusMeters: number;    // 0..120
  readonly memorySeconds: number;          // 0.5..30
  readonly updateIntervalTicks: number;    // 1..30; default 6 (10 Hz)
  readonly maxTargetsPerUpdate: number;    // 1..4; default 4
}

export interface PerceivableTarget {
  readonly id: number;                     // game entity id, stable
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly team: number;
  readonly visible: boolean;               // game may force false (stealth, cloak)
}

export interface PerceptionMemory {
  readonly targetId: number;
  readonly lastKnown: Vec3;
  readonly lastSeenTick: number;
  readonly visible: boolean;
  readonly confidence: number;             // 0..1, linear decay over memorySeconds
}

export interface SoundEvent {
  readonly id: number;                     // monotonically increasing per tick
  readonly position: Vec3;
  readonly radius: number;                 // audible radius, 1..200
  readonly loudness: number;               // 0..1
  readonly tick: number;
}

export interface PerceptionSystem {
  register(agent: NavAgent, config: PerceptionConfig): void;
  unregister(agent: NavAgent): void;
  publishSound(event: Omit<SoundEvent, "id" | "tick">): void;
  /** Reads each agent's memory into out; returns count. Never allocates. */
  memory(agent: NavAgent, out: PerceptionMemory[]): number;
  update(tick: number, targets: readonly PerceivableTarget[], world: AiWorld): void;
  readonly stats: PerceptionStats;
  dispose(): void;
}

export interface PerceptionStats {
  readonly visionTests: number;            // distance + angle
  readonly raycasts: number;
  readonly sounds: number;
  readonly updateMs: number;               // rolling p95
}
```

`AiWorld` is the adapter the runtime supplies; it hides the physics package and can be faked in tests:

```ts
export interface AiWorld {
  readonly tick: number;
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, layerMask: number, out: AiRayHit): boolean;
  /** Circle overlap in XZ; writes at most max agents, returns count. */
  overlapAgents(center: Vec3, radius: number, out: NavAgent[], max: number): number;
  readonly soundEvents: readonly SoundEvent[];   // events for this tick, already filtered by age
}
```

### 3.8 Traffic

```ts
export interface Lane {
  readonly id: number;
  readonly points: Float32Array;           // xyz centreline, 2..64 points
  readonly width: number;                  // 2..8 m
  readonly speedLimit: number;             // 1..60 m/s
  readonly next: readonly number[];        // <= 4 successor lane ids
  readonly areaId: number;
}

export interface LaneMovement {
  readonly id: number;
  readonly fromLane: number;
  readonly toLane: number;
  readonly conflictsWith: readonly number[]; // movement ids that cannot run together
}

export interface SignalPhase {
  readonly ticks: number;
  readonly greenMovements: readonly number[];
  readonly yellow: boolean;
}

export interface TrafficNode {
  readonly id: number;
  readonly kind: "priority" | "signal" | "roundabout";
  readonly movements: readonly LaneMovement[];
  readonly cycle?: readonly SignalPhase[];   // signal only
  readonly phaseOffsetTicks?: number;        // default 0
}

export interface LaneGraph {
  readonly formatVersion: 1;
  readonly lanes: readonly Lane[];
  readonly nodes: readonly TrafficNode[];
}

export interface VehicleSpec {
  readonly length: number;        // 3..12 m
  readonly width: number;         // 1.2..3 m
  readonly desiredSpeed: number;  // 1..60 m/s
  readonly maxAccel: number;      // 0.5..6 m/s²
  readonly comfortDecel: number;  // 1..8 m/s²
  readonly timeHeadway: number;   // 0.5..3 s
  readonly minGap: number;        // 1..5 m
}

export interface TrafficVehicle {
  readonly id: number;            // stable per lane/spawn ordinal
  readonly laneId: number;
  s: number;                      // metres along the lane centreline
  speed: number;                  // m/s
  readonly spec: VehicleSpec;
}

export interface TrafficSystem {
  update(tick: number, dt: number): void;
  spawn(laneId: number, sMeters: number, spec: VehicleSpec): TrafficVehicle | undefined;
  despawn(vehicle: TrafficVehicle): void;
  readonly vehicles: readonly TrafficVehicle[];  // (laneId, s, id) order
  readonly stats: TrafficStats;
  dispose(): void;
}

export interface TrafficStats {
  readonly vehicles: number;
  readonly waitingAtNodes: number;
  readonly grants: number;
  readonly deadlockBreaks: number;
  readonly updateMs: number;      // rolling p95
}
```

`LaneGraph` is parsed once by `parseLaneGraph(json: unknown): LaneGraph` with the same validation discipline as behavior trees.

---

## 4. Data formats

Every format below carries an integer `formatVersion`. Readers accept only their current version unless a migration is explicitly named. The four version constants must be added to the version registry in 00 §4.1 in the same change that first implements them:

| Name | Current | Owner | Bump rule |
|---|---|---|---|
| `NAVMESH_FORMAT_VERSION` | 1 | 11 | Any byte-layout or portal-semantics change; old fixtures must keep loading for one milestone |
| `NAV_BUILD_FORMAT_VERSION` | 1 | 11 | Breaking field/meaning change in `nav-build.json` |
| `BT_FORMAT_VERSION` | 1 | 11 | New node type or changed status semantics |
| `LANE_GRAPH_FORMAT_VERSION` | 1 | 11 | Breaking lane/node field change |

Canonicalization rules shared by all four: UTF-8 JSON, no comments, no trailing commas, unknown fields ignored (forward compatibility), unknown required enum values rejected. Positions in navmesh output are quantized to **1 mm** and written as little-endian `float32`; angles are quantized to **0.1°** for hashing. JSON files use metres, seconds and radians unless a field name says otherwise.

### 4.1 `.navmesh` binary (one file = one tile)

Little-endian, `DataView` only, no Node `Buffer`. Header is **96 bytes**; sections follow at 4-byte-aligned offsets, in ascending section-type order.

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | 4 | `magic` | ASCII `PNVM` |
| 4 | u16 | `formatVersion` | 1 |
| 6 | u16 | `headerBytes` | 96 |
| 8 | u32 | `contentHash` | FNV-1a 32 over the canonical build input (§5.2) |
| 12 | u32 | `polygonCount` | ≤ 65,536 |
| 16 | u32 | `vertexCount` | ≤ 262,144 |
| 20 | u32 | `offMeshCount` | ≤ 4,096 |
| 24 | u32 | `flags` | bit 0 = tiled, bit 1 = has off-mesh; others 0 |
| 28 | u32 | `reserved` | 0 |
| 32 | f32 | `agentRadius` | |
| 36 | f32 | `agentHeight` | |
| 40 | f32 | `maxSlopeDeg` | |
| 44 | f32 | `maxStepMeters` | |
| 48 | i32 | `cellX` | tile cell x; 0 for standalone |
| 52 | i32 | `cellY` | tile cell y; 0 for standalone |
| 56 | f32×6 | `bounds` | minX, minY, minZ, maxX, maxY, maxZ |
| 80 | u32 | `sectionCount` | 3 |
| 84 | 12 bytes | `reserved` | 0 |

Section directory entry, 16 bytes each: `u32 type`, `u32 offset` (from file start), `u32 bytes`, `u32 reserved`. Types: **1** vertices, **2** polygons, **3** off-mesh links.

Vertex record, 12 bytes: `f32 x, y, z`.

Polygon record, **36 bytes**:

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | u32 | `firstVertex` | `< vertexCount` |
| 4 | u16 | `vertexCount` | 3..6 |
| 6 | u16 | `areaId` | 0..31; 31 = blocked |
| 8 | u16 | `flags` | bit 0 walkable, bit 1 off-mesh endpoint, bit 2 boundary-closed; others 0 |
| 10 | u16 | `reserved` | 0 |
| 12 | i32×6 | `neighbors` | polygon index or −1; slot order is defined below |

Neighbor slots follow the polygon winding: slot `i` is the edge from vertex `i` to vertex `(i+1) % vertexCount`. A portal's left/right endpoints are recovered at load by matching the shared edge between two polygons (vertex index pairs, sorted, first match wins). This is deterministic, costs at most 36 comparisons per polygon at load, and keeps the file small.

Off-mesh record, **44 bytes**: `u32 polyA`, `u32 polyB` (0xFFFFFFFF = unattached side), `f32 ax, ay, az`, `f32 bx, by, bz`, `u16 flags` (bit 0 bidirectional, 1 jump, 2 ladder, 3 door, 4 vault), `u16 areaId`, `f32 cost`, `u32 reserved`.

Validation on load: magic, version, `headerBytes`, section bounds and alignment, vertex count ≥ 3 per polygon, firstVertex + vertexCount ≤ vertexCount, neighbor indices in range or −1, area id ≤ 31, bounds finite, no NaN. A dev build additionally checks convexity and winding; production trusts the bake. Any failure is `E_NAV_FORMAT` and the tile is refused as a unit.

### 4.2 `nav-build.json` (editor handoff)

```json
{
  "formatVersion": 1,
  "worldId": "vice-slice",
  "tileSizeMeters": 64,
  "agent": {
    "radius": 0.4,
    "height": 1.8,
    "maxSlopeDeg": 45,
    "maxStepMeters": 0.35,
    "minClearanceMeters": 2.0
  },
  "bake": {
    "cellSizeMeters": 0.25,
    "minRegionAreaMeters2": 4,
    "edgeMaxErrorVoxels": 1.1
  },
  "areaCosts": [1.0, 1.0, 1.2, 1.5, 4.0],
  "layers": { "include": ["nav.static", "nav.road"], "exclude": ["nav.ignore"] },
  "offMesh": [
    { "a": [10, 0, 20], "b": [14, 0, 20], "flags": ["bidirectional", "jump"], "cost": 2.5 }
  ]
}
```

Rules: `tileSizeMeters` 8..256; `cellSizeMeters` 0.1..1.0; `areaCosts` length 1..32, each 0.1..1000, index 0 defaults to 1.0; area id 31 is always blocked regardless of cost; `offMesh` ≤ 4,096 per tile and endpoints must lie within the tile bounds + 0.5 m; `flags` values from the fixed set; include/exclude layers are names resolved by the editor (spec 17), not paths. The file sits beside `world.json` and is owned by the editor.

### 4.3 Behavior tree JSON

```json
{
  "formatVersion": 1,
  "id": "pedestrian-flee",
  "blackboard": [
    { "name": "threat", "type": "entity", "default": 0 },
    { "name": "fleeX", "type": "number", "default": 0 }
  ],
  "nodes": [
    { "id": 0, "type": "selector", "children": [1, 2] },
    { "id": 1, "type": "sequence", "children": [3, 4] },
    { "id": 2, "type": "action", "name": "wander", "intervalTicks": 30 },
    { "id": 3, "type": "condition", "name": "seesThreat" },
    { "id": 4, "type": "action", "name": "fleeFromThreat" }
  ],
  "root": 0
}
```

Node types (M2, closed set):

| Type | Children | Fields | Semantics |
|---|---|---|---|
| `sequence` | 1..16 | — | Runs children left to right; first failure stops; running propagates |
| `selector` | 1..16 | — | First success stops; running propagates |
| `parallel` | 1..16 | `successPolicy: "all" \| "one"` | Ticks all children every tick |
| `randomizer` | 1..16 | `weights?: number[]` | Picks one child with the agent RNG on entry |
| `inverter` | 1 | — | Success ↔ failure; running unchanged |
| `succeeder` / `failer` | 1 | — | Forces a terminal status |
| `repeat` | 1 | `times: number` (1..1000) | Resets and re-ticks the child |
| `retry` | 1 | `times: number` (1..1000) | Retries on failure |
| `cooldown` | 1 | `ticks: number` (1..3600) | Blocks re-entry for N ticks after completion |
| `timeout` | 1 | `ticks: number` (1..3600) | Returns failure if the child runs longer |
| `guard` | 1 | `condition: string` | Condition must pass before the child ticks |
| `action` | 0 | `name: string`, `intervalTicks?: number` | Calls a registered action |
| `condition` | 0 | `name: string` | Calls a registered condition |
| `wait` | 0 | `ticks: number` (1..3600) | Running until the count elapses |
| `subtree` | 0 | `tree: string` | Inlined reference; total nodes ≤ 4,096 |

Rules: node ids dense `0..n-1`; `root` is a valid id; no cycles; depth ≤ 32; total nodes ≤ 1,024 (4,096 with subtrees); child count ≤ 16; names match `^[a-z][a-z0-9_.]{0,63}$` and must resolve in the registry at parse time; blackboard fields ≤ 64 with unique names; stateful nodes (`wait`, `cooldown`, `timeout`, `retry`, `repeat`, `randomizer`) ≤ 32 per tree. Unknown fields ignored; unknown node type, unresolved name, bad reference or unknown `formatVersion` = `E_BT_FORMAT`. No code, no expressions, no string evaluation.

### 4.4 Lane graph JSON

```json
{
  "formatVersion": 1,
  "lanes": [
    { "id": 0, "points": [[0,0,0],[0,0,50]], "width": 3.5, "speedLimit": 13.9, "next": [1], "areaId": 1 }
  ],
  "nodes": [
    {
      "id": 0,
      "kind": "signal",
      "movements": [
        { "id": 0, "fromLane": 0, "toLane": 1, "conflictsWith": [2] },
        { "id": 1, "fromLane": 0, "toLane": 2, "conflictsWith": [] },
        { "id": 2, "fromLane": 3, "toLane": 0, "conflictsWith": [0] }
      ],
      "cycle": [
        { "ticks": 900, "greenMovements": [0, 1], "yellow": false },
        { "ticks": 60, "greenMovements": [], "yellow": true },
        { "ticks": 600, "greenMovements": [2], "yellow": false },
        { "ticks": 60, "greenMovements": [], "yellow": true }
      ],
      "phaseOffsetTicks": 0
    }
  ]
}
```

Limits: lanes ≤ 4,096; nodes ≤ 2,048; points 2..64 each; `next` ≤ 4 and all ids valid; `width` 2..8; `speedLimit` 1..60; movements ≤ 32 per node; conflicts symmetric (validator enforces both directions); every lane belongs to at most one incoming and one outgoing movement per node; signal cycle total ticks 1..36,000 and green movement ids valid. Unknown `formatVersion` = `E_LANE_FORMAT`. The lane graph is data; no lane editing UI is implied here (spec 17).

### 4.5 Bake report

`nav-bake-report.json` is written by the bake CLI next to the tiles. It records, per tile: cell key, `contentHash`, polygon/vertex/off-mesh counts, islands dropped, warnings, bake milliseconds and the input hash of `nav-build.json`. CI reads it; the editor displays it. It is a report, never an input to the runtime.

---

## 5. Architecture

### 5.1 Module map

```
packages/engine/ai/src/
  index.ts                     public exports
  types.ts                     shared types and limits
  navmesh/
    Build.ts                   canonicalize → voxelize → regions → contours → polygons → links
    Serialize.ts               .navmesh read/write, content hash, validation
    NavMeshSet.ts              tile registry, cross-tile stitching, portal cache
    Query.ts                   A*, funnel, closest point, raycast, sample, surface move
  path/
    PathQueue.ts               budgeted requests, tick-boundary drain
    PathFollow.ts              corner cutting, arrival, stuck detection
  crowd/
    Crowd.ts                   registry, behaviour LOD, canonical update order
    SpatialHash.ts             deterministic neighbour grid
    Orca.ts                    reciprocal velocity obstacles, 2D LP
  bt/
    Parse.ts                   validation and compile
    Tick.ts                    allocation-free traversal
    Blackboard.ts              typed slots
    Registry.ts                action/condition lookup
  perception/
    Perception.ts              vision, hearing, memory, stagger
    SoundBus.ts                bounded per-tick sound events
  traffic/
    LaneGraph.ts               parse/validate
    Idm.ts                     longitudinal model
    Intersection.ts            reservations, signals, deadlock breaker
    TrafficSystem.ts           ordered update, spawn/despawn
  debug/AiStats.ts             counters and rolling timings
  bake/navBakeCli.ts           Node-safe bake entry (`@lanpad/engine-ai/bake`)
```

The package imports `engine-core` (math, scene types, RNG, jobs interface) and `engine-physics` (raycasts, overlap). It imports no renderer, asset, streaming, UI, runtime, SDK, protocol or game package (00 D2/D3). The runtime adapters that connect `NavMeshSet` to streaming and `AiWorld` to physics are integration files, not part of this package.

### 5.2 Navmesh build

`buildNavMesh` is a deterministic pipeline over canonical input:

1. **Canonicalize.** Drop degenerate triangles (< 1e-6 m²) and area id 31/255. Quantize every coordinate to 1 mm and every slope/step parameter to 0.1°. Sort triangles by `(stable scene object id, triangle index)` supplied by the caller's canonical order; if the caller cannot supply stable ids, sort by quantized vertex tuple then original index. The FNV-1a 32 hash of this canonical byte stream is `contentHash`.
2. **Voxelize.** Rasterize triangle tops into a heightfield at `cellSizeMeters`, producing solid spans. Mark a span walkable when its slope ≤ `maxSlopeDeg`, its top is reachable within `maxStepMeters`, and its clearance ≥ `agentHeight + minClearanceMeters`. Blockers are rasterized as solid. This is a compact heightfield, not a full 3D voxel grid.
3. **Regions.** Build a distance field from non-walkable spans, partition by watershed, then merge regions smaller than `minRegionAreaMeters2` into their lowest-index neighbour. If a region is not convex, apply monotone partitioning. Region order is by `(area id, minimum span index)`, never hash order.
4. **Contours.** Trace walkable borders, simplify XZ with Ramer–Douglas–Peucker to `edgeMaxErrorVoxels`, and take y from the heightfield. Winding is fixed clockwise in XZ (y up); the serializer asserts it.
5. **Polygons.** Ear-clip contours into triangles, then greedily merge adjacent triangles into convex polygons with ≤ 6 vertices. Merge order is by `(minimum vertex index, neighbour index)`. A polygon record stores its vertex range and up to six neighbours.
6. **Adjacency.** Two polygons are neighbours when they share an edge (both vertex indices equal within 1 mm). Portal endpoints are the shared edge endpoints. A portal narrower than `agentRadius` is dropped with a `narrow-portal` warning; narrower than `2 × agentRadius` is kept but warned.
7. **Off-mesh links.** Attach each endpoint to the nearest polygon within 0.5 m; unattached endpoints produce `offmesh-unattached` and the link is dropped. Bidirectional links generate two directed links at query time.
8. **Tile independence.** The bake input is clipped to one tile's bounds. The baker never creates cross-tile links. `NavMeshSet` stitches tiles at load by matching boundary vertices within 1 mm in a deterministic scan order; unmatched boundary edges are closed and counted in `missingNeighborEdges`.
9. **Serialize.** Sections, header, content hash, fixed byte order. Two runs over the same canonical input must produce identical bytes; this is acceptance row ER-11-01.

The pipeline is pure computation. The runtime calls it inside a worker for editor preview and tests; the production path only loads bytes. A 64 m tile with roughly 20,000 input triangles is expected to bake in ≤ 250 ms in a worker; that number is a performance target, not a measurement (§7).

### 5.3 Query algorithms

**Point location.** Each tile builds a uniform 4 m XZ bucket grid over polygon AABBs at load. `closestPoint` scans the buckets around the query and takes the nearest polygon by point-to-polygon distance in XZ, tie-broken by polygon index; the result is clamped to the polygon and its y is interpolated from the polygon plane.

**A\*.** Open and closed sets are `Uint32Array(polygonCount)` stamped with a per-query generation counter, so no clearing is needed. The binary heap is a preallocated `Uint32Array` plus a parallel `Float32Array` of keys. Edge cost is `distance(portalMidpointA, portalMidpointB) × max(areaCost[a], areaCost[b])`; off-mesh links add their `cost`. The heuristic is Euclidean distance to the goal times the minimum allowed area cost (≥ 1), therefore admissible. Tie-break: lower `g`, then lower polygon index. `maxExpandedNodes` per request defaults to 4,096 and hard-caps at 32,768; exceeding it returns `partial` when `allowPartial` is set, otherwise `failed`.

**Funnel.** Simple stupid funnel over the portal corridor produced by A*, with epsilon 1e-4 m. Output points are the taut polyline. `out.capacity` is enforced; truncation returns `partial` and sets `lengthMeters` over the emitted prefix. Portals are oriented by the polygon winding, so left/right assignment is deterministic.

**Raycast.** March the XZ segment through polygons using the bucket grid; at each edge crossing, test whether the crossing lies on the shared edge or leaves the mesh. Returns the first boundary hit. Used for line-of-sight on the ground and for editor diagnostics.

**Surface move.** Project start/end to the nearest polygons, walk the segment through the portal graph in XZ and clamp the final point to the destination polygon. Used by traffic and by kinematic agents; it never teleports across an unloaded boundary.

**Tile stitching.** On `addTile`, boundary edges (polygons with a closed boundary flag) are matched against each resident neighbour's boundary edges by quantized vertex pair. Matches create symmetric neighbour slots and are counted as `crossTilePortals`. On `removeTile`, every link pointing into that tile is replaced by −1 and the boundary flag is restored. A* only crosses resident links, so the path status is a statement about residency, never a silent shortcut.

**Budgeted queue.** `PathRequestQueue.drain` executes requests in request-id order under one shared expansion budget. A request that exhausts the per-call budget is resumed on the next drain from its saved open set. Results are written into caller-owned `PathResult` slots and applied at a tick boundary, sorted by request id. This is the only asynchronous part of pathfinding; no worker is involved, which keeps results deterministic.

### 5.4 Crowd, behaviour LOD and steering

Agents are grouped by distance to the nearest focus point (camera plus each player):

| Tier | Distance | Behaviour | Perception | Avoidance | Movement tick |
|---|---|---|---|---|---|
| NEAR | ≤ `nearRadiusMeters` (40 m) | BT every tick | 10 Hz, LOS raycasts | ORCA | every tick |
| MID | ≤ `midRadiusMeters` (120 m) | BT stride 4 (15 Hz) | distance/angle only | separation | every tick, dt = 1/60 |
| FAR | ≤ `simRadiusMeters` (250 m) | no BT unless `forceBehavior` | none | none, path follow | stride 15 (4 Hz), dt = 15/60 |
| FROZEN | > sim radius | none | none | none | none; state preserved |

Strides are phase-locked to identity, not to load order: an agent ticks when `(localId + tick) % stride === 0`. A skipped movement tick is not accumulated from wall time; the next update uses `dt = stride / 60`, so playback is deterministic and frame-rate independent.

Update order is fixed: resident cells sorted by `(cx, cy)`, agents inside a cell by `localId`. The ECS entity id is never used for ordering. This is the rule that makes behaviour independent of streaming load order and of component-storage layout.

**Path following.** The agent follows its `NavPathBuffer` with corner cutting at `agentRadius`, accelerates at `accel` toward `min(maxSpeed, pathSpeed)` and decelerates into the final point. Arrival within `0.25 m` sets `idle`. Stuck detection: less than 0.1 m of progress over 120 ticks while `moving` sets `blocked` and requests one alternative path with `maxExpandedNodes` doubled; a second failure keeps the agent `blocked` until the game responds. `blocked` is observable through `NavAgent.state`.

**Avoidance.** NEAR agents run a deterministic ORCA solve: preferred velocity from path following, neighbours from the spatial hash (cell edge = 2 × max radius, rebuilt each tick in agent order), at most `avoidanceNeighbors` candidates, sorted by `(distanceSquared, localId)`. The 2D linear program processes half-planes in that order, with at most 32 constraints, and falls back to zero velocity when infeasible. MID agents use a separation term only; FAR agents ignore each other. Density is capped per 4 m² bucket (default 4 agents); spawn requests above the cap are refused, not silently dropped.

**Spawn/despawn.** Streaming activates and deactivates cells (spec 12). On activation, the game spawns agents in cell-local id order; on deactivation, agents are either despawned or frozen in state. `Crowd` never spawns on its own.

### 5.5 Perception

Perception runs at `updateIntervalTicks` per agent, phased by `(localId + tick) % interval === 0`. For each agent:

1. Distance cull against every perceivable target, then angle cull using the agent's facing.
2. Sort surviving targets by `targetId` (not distance) and test at most `maxTargetsPerUpdate` with a physics raycast on the `occluder` layer.
3. Write or refresh memory slots; decay confidence linearly over `memorySeconds`; a visible target refreshes `lastSeenTick`.

Hearing uses a bounded `SoundBus`: at most 64 events per tick (oldest dropped with a counted overflow), events older than 60 ticks discarded, radius check only. Sound events never allocate after the bus is created. Perception never mutates game state; behavior trees read memory through `BtContext` and decide.

Cost control: raycasts stop when the per-tick perception budget is exhausted; remaining agents keep their previous memory and retry next interval. The budget is a fixed raycast count per tick (default 512), counted in `PerceptionStats`.

### 5.6 Traffic

Traffic is a kinematic lane system for city streets. It is deliberately not rigid-body physics.

**Longitudinal model.** Each vehicle follows IDM with fixed parameters from `VehicleSpec`:

```
s* = minGap + max(0, v·T + v·Δv / (2·√(a·b)))
a  = aMax · [1 − (v/v*)⁴ − (s*/s)²]
```

where `s` is the bumper gap, `Δv` the closing speed, `T` the time headway, `aMax` the maximum acceleration and `b` the comfort deceleration. Acceleration is clamped to `[−b·3, aMax]`; integration is explicit Euler at the fixed tick. `v*` is the lane speed limit refined by curvature. Leader search scans the same lane forward, then up to two successor lanes; lane lists are sorted by `(s, id)`.

**Intersections.** A vehicle requests a movement when it is within 20 m of the node stop line. The scheduler grants a deterministic maximal independent set: iteration order `(requestTick, vehicleId)`, a movement is granted when its conflict set is disjoint from all grants this phase. `signal` nodes use their cycle with `phaseTick = (tick + phaseOffsetTicks) % cycleLength`; `priority` nodes use the same greedy grant with no cycle; `roundabout` nodes grant entry when the circulating gap exceeds a fixed threshold. A request waiting more than 1,800 ticks triggers the deadlock breaker: the oldest request is granted, conflicting vehicles re-request at the stop line, and `stats.deadlockBreaks` increments. The breaker is deterministic because the age ordering is total (`requestTick`, `vehicleId`).

**Spawning.** `TrafficSystem.spawn` takes a lane and position supplied by the game or by streaming's cell spawn records. Spawn ordinals are stable per cell, so vehicle ids replay identically regardless of when a cell became resident. A vehicle beyond `despawnRadius` (default 400 m) from every focus and outside the player's visible set is despawned and its state written to the cell record by the game/streaming bridge. Traffic never despawns a vehicle inside the simulation ring.

**Validation.** Dev builds run a circle-overlap check between vehicles each tick and report the first overlap with both ids; production does not pay for it.

### 5.7 Determinism rules

These are mandatory in addition to 00 §5.8:

1. Simulation time enters only as `dt` and `tick`; no `Date.now`, `performance.now`, timers or `Math.random` (lint-banned, 00 §5.16).
2. Agent update order is `(cell.cx, cell.cy, localId)`; traffic order is `(laneId, s, id)`; perception target order is `targetId`; path results are applied by request id.
3. All randomness comes from `EngineRng` streams. Agent-scoped randomness uses `forkAgentRng(worldSeed, cx, cy, localId, stream)` from `engine-core`; cell-scoped spawn and ambient streams use `forkCellRng(worldSeed, cx, cy, stream)` (spec 12 §5.6). Agent stream ids: 0 behaviour, 1 perception, 2 traffic behaviour, 3 effects. Cell stream ids are owned by spec 12. A cell's or agent's stream never depends on spawn order or residency.
4. Behaviour LOD phase is `(localId + tick) % stride`, so which agents think on a tick is fixed.
5. Floating-point comparisons use explicit epsilons (`1e-4 m` for funnel, `1 mm` for stitching). No accumulation of wall-clock deltas.
6. A worker may build a navmesh; it may not tick agents. Results are applied at a tick boundary in sorted order.
7. Replay fixture format for tests: `{ version: 1, engineVersion, sceneId, seed, ticks, spawns: [...], commands: [{tick, agentId, goal}], expectedHash }`, where the hash is FNV-1a over quantized agent positions (mm), velocities (mm/s) and states after the final tick.

### 5.8 Streaming contract

Navigation is tiled by world cell, one tile per cell (spec 12 owns cell residency). Active agents are constrained as follows:

- A `Crowd` only accepts spawns in resident navmesh cells.
- A goal outside the resident set is refused immediately with `outside-streamed-world`; `PathRequestQueue` does not queue it.
- `CrowdOptions.simRadiusMeters` must be ≤ spec 12's simulation radius minus a 16 m margin. The runtime enforces this at boot and refuses the configuration otherwise.
- Agents may stand near a cell boundary whose neighbour tile is absent; their paths simply cannot cross it. The game must keep goals inside the streamed ring; pressing a goal across the boundary is a game bug that surfaces as a status, never as a teleport or a wall-walk.

Because residents are always a superset of the simulation ring by construction, an active agent's decision never depends on which visual LOD is loaded (spec 12 §5.6).

### 5.9 Editor handoff

The editor (spec 17) owns authoring; this spec owns the contract:

- `nav-build.json` is authored per world and stored beside `world.json`. The editor edits agent parameters, bake resolution, area costs, include/exclude layers and off-mesh links.
- The editor previews a bake by calling `buildNavMesh` in a worker through the `@lanpad/engine-ai/bake` entry, then draws polygons, area colours, portals narrower than `2 × agentRadius`, off-mesh links and dropped islands. Preview is diagnostic; the shipped tile is the serialized result.
- The bake is per tile. A tile is dirty when its input hash changes (static geometry, painted areas, off-mesh links, agent parameters). Only dirty tiles rebake.
- `nav-bake-report.json` lists every tile's `contentHash` and warnings. The world manifest stores the expected hash per tile. On load, a mismatch is `E_NAV_STALE`: dev refuses the tile and names it; production logs once, uses the bake and increments a counter, because a stale bake is still better than an agent walking through a wall.
- The bake CLI lives at `@lanpad/engine-ai/bake` (Node-safe, no DOM). `engine-tooling` consumes it to expose `nav-bake`; that is a dev-only tooling → ai edge and must be recorded additively in 00 §5.2 D8 before it lands (see §9).
- The editor never writes `.navmesh` bytes by hand; it calls `serializeNavMesh`, so the editor and runtime share one writer.

### 5.10 Hot paths, memory and budgets

All of `Crowd.update`, `tickBehaviorTree`, `PerceptionSystem.update`, A*, funnel and `TrafficSystem.update` obey the no-per-frame-allocation rule (00 §5.10): no object/array literals, no closures in the loop, no `map`/`filter`/`forEach`/spread, no string building. Scratch is owned by the system:

| Allocation | Size | Owner |
|---|---|---|
| Path buffer per agent | 64 points × 3 × f32 = 768 B (pooled; ≤ 256 points on request) | `Crowd` |
| Blackboard per agent | ≤ 64 fields × 8 B = 512 B | `Crowd` |
| BT instance | 32 state slots × 8 B + status bytes ≈ 300 B | `Crowd` |
| ORCA scratch | fixed arrays sized `maxAgents`, `avoidanceNeighbors` | `Crowd` |
| A* open/closed/heap | 3 × `polygonCount` entries + heap | `NavMeshQuery` |

Target budgets at 60 Hz (all PENDING; §7):

| Work | Target p95 |
|---|---|
| AI tick total (crowd + BT + perception + traffic + path drain) | ≤ 3.5 ms |
| Crowd movement + avoidance: 1,024 agents, 256 NEAR with ORCA | ≤ 1.6 ms |
| Behaviour trees: 256 instances × 32 nodes | ≤ 0.6 ms |
| Perception: 256 agents at 10 Hz, ≤ 512 raycasts/tick | ≤ 0.5 ms |
| Traffic: 128 vehicles, 8 nodes | ≤ 0.4 ms |
| Path-queue drain: ≤ 32,768 expansions/tick | ≤ 0.4 ms |
| Longest main-thread task caused by AI | ≤ 8 ms (00 §5.6) |

These are design ceilings derived from the 14 ms frame target (SPEC §11); they are not measurements and must be replaced by `docs/RESULTS.md` rows when run.

---

## 6. File ownership

Canonical package path is `packages/engine/ai/**` (00 §5.3 and the README spec index). An earlier work brief wrote `packages/ai/**`; that is shorthand for the same package and must not create a second one. This spec owns only the files below plus its own document. Package-local `package.json`, `tsconfig.json`, root workspace, Vitest project and eslint entries are integration-agent changes (00 §5.16), not feature-agent edits.

| Path | Owns |
|---|---|
| `packages/engine/ai/src/index.ts` | public exports; no logic |
| `packages/engine/ai/src/types.ts` | shared types, `NAV_LIMITS` |
| `packages/engine/ai/src/navmesh/Build.ts` | canonicalization, voxelizer, regions, contours, polygonizer |
| `packages/engine/ai/src/navmesh/Serialize.ts` | `.navmesh` read/write, content hash, validation |
| `packages/engine/ai/src/navmesh/NavMeshSet.ts` | tile registry, cross-tile stitching, portal cache |
| `packages/engine/ai/src/navmesh/Query.ts` | A*, funnel, closest point, raycast, sample, surface move |
| `packages/engine/ai/src/path/PathQueue.ts` | budgeted requests and tick-boundary drain |
| `packages/engine/ai/src/path/PathFollow.ts` | corner cutting, arrival, stuck detection |
| `packages/engine/ai/src/crowd/Crowd.ts` | agent registry, behavior LOD, canonical order |
| `packages/engine/ai/src/crowd/SpatialHash.ts` | deterministic neighbour grid |
| `packages/engine/ai/src/crowd/Orca.ts` | reciprocal velocity obstacles |
| `packages/engine/ai/src/bt/Parse.ts` | JSON validation and compile |
| `packages/engine/ai/src/bt/Tick.ts` | allocation-free traversal |
| `packages/engine/ai/src/bt/Blackboard.ts` | typed slots |
| `packages/engine/ai/src/bt/Registry.ts` | action/condition lookup |
| `packages/engine/ai/src/perception/Perception.ts` | vision, hearing, memory, stagger |
| `packages/engine/ai/src/perception/SoundBus.ts` | bounded sound events |
| `packages/engine/ai/src/traffic/LaneGraph.ts` | parse/validate lane graph |
| `packages/engine/ai/src/traffic/Idm.ts` | longitudinal model |
| `packages/engine/ai/src/traffic/Intersection.ts` | reservations, signals, deadlock breaker |
| `packages/engine/ai/src/traffic/TrafficSystem.ts` | ordered update, spawn/despawn |
| `packages/engine/ai/src/debug/AiStats.ts` | counters and rolling timings |
| `packages/engine/ai/src/bake/navBakeCli.ts` | Node-safe bake entry (`./bake`) |
| `packages/engine/ai/test/**` | unit, property, golden, integration fixtures |
| `docs/engine/11-ai-navigation.md` | this spec |

Fixtures owned here: `packages/engine/ai/test/fixtures/nav-build-city.json`, `city-block-01.navmesh`, `paths-64.json`, `behaviours/*.bt.json`, `lane-grid.lanegraph.json`, `replay-crowd-600.json`, `bake-report.expected.json`.

Integration adapters are **not** owned here and are written by the integration agent: `packages/runtime/src/engine/aiWorld.ts` (physics adapter), `packages/runtime/src/engine/navSink.ts` (streaming → `NavMeshSet`), `packages/runtime/src/engine/crowdHost.ts` (spawn records → `Crowd`). The runtime owns composition; this package owns algorithms.

---

## 7. Acceptance

All rows are **PENDING**: no engine code exists yet. A row becomes PASS only with a recorded build, device, browser version, date and numbers in `docs/RESULTS.md` (00 §7 evidence rule). Requirement IDs must be registered in `docs/todos/TRACEABILITY.md` when the engine programme is added there.

| ID | Criterion | Fixture / method | Hardware / run | State |
|---|---|---|---|---|
| ER-11-01 | Two bakes of the same canonical input produce byte-identical `.navmesh` files and the same `contentHash`; changing one area cost changes the hash | `nav-build-city.json` → `buildNavMesh` twice; byte compare + hash | CI Node 20 | PENDING — implements with `Build.ts` |
| ER-11-02 | 64 start/end pairs on `city-block-01.navmesh` return paths whose every segment stays on walkable polygons, whose endpoints are within 0.05 m of the requested points, and whose cost is ≤ 1.02× the Dijkstra reference cost | `paths-64.json`; per-segment point-location sweep | CI Node 20 | PENDING — fixture not yet authored |
| ER-11-03 | The funnel produces the taut path on a U-shaped corridor and a zig-zag portal chain: golden waypoints match within 1e-3 m per coordinate | `golden/funnel-u.json`, `golden/funnel-zigzag.json` | CI Node 20 | PENDING — goldens captured with the implementation |
| ER-11-04 | `closestPoint`, `raycast` and `moveAlongSurface` satisfy 10,000 random-point properties: a projected point is inside some polygon; a raycast hit is on a boundary; a surface move never crosses a closed edge | `property/navQuery.property.test.ts` with `fast-check` | CI Node 20 | PENDING — properties written with the implementation |
| ER-11-05 | 1,024 agents (256 NEAR with ORCA + BT, 384 MID, 384 FAR) tick at p95 ≤ 1.6 ms and produce a stable replay hash over 600 ticks | `replay-crowd-600.json`; browser bench page | Desktop Chrome 155, Windows 11, GPU adapter recorded | PENDING — needs the crowd implementation and the bench run |
| ER-11-06 | 256 behavior-tree instances × 32 nodes tick at p95 ≤ 0.6 ms with zero steady-state allocation | `behaviours/bench-32.bt.json`; debug allocation counter | Desktop Chrome 155, Windows 11 | PENDING — needs the BT implementation |
| ER-11-07 | 128 vehicles over a 4-way signalised intersection and a priority junction run 10,000 ticks with no pair of vehicle circles overlapping by more than 0.1 m and no request waiting more than 1,800 ticks without a grant or a counted deadlock break | `lane-grid.lanegraph.json`, `traffic-replay-10000.json` | CI Node 20 | PENDING — fixture not yet authored |
| ER-11-08 | A 600-tick crowd+traffic replay run twice yields the same FNV-1a state hash; changing the seed changes it | `replay-crowd-600.json` | CI Node 20 + Desktop Chrome 155 | PENDING — fixture authored with the implementation |
| ER-11-09 | Perception for 256 agents at 10 Hz with a 512-raycast/tick cap stays at p95 ≤ 0.5 ms | bench page with a fake `AiWorld` | Desktop Chrome 155, Windows 11 | PENDING — needs the perception implementation |
| ER-11-10 | Path and agent behaviour are independent of tile load order: the same replay with tiles added in forward, reverse and random order produces the same hash | `replay-crowd-600.json` × 3 load orders | CI Node 20 | PENDING — implements with `NavMeshSet` |
| ER-11-11 | A path crossing a cell boundary is `outside-streamed-world` while the neighbour tile is absent; becomes `complete` within one tick after `addTile`; returns to `outside-streamed-world` after `removeTile` | `boundary-tiles.navmesh` fixture | CI Node 20 | PENDING — fixture not yet authored |
| ER-11-12 | `nav-build.json` → bake → serialize → parse → query round-trips with identical `contentHash` and identical path results | `nav-build-city.json` | CI Node 20 | PENDING — implements with `Serialize.ts` |
| ER-11-13 | A 64 m tile bakes in a worker without any main-thread task longer than 8 ms; the editor preview reports progress and cancel | browser bench page + PerformanceObserver `longtask` | Desktop Chrome 155, Windows 11 | PENDING — needs the worker path |
| ER-11-14 | TV tier: 256 agents (128 NEAR) at a 30 Hz AI update stay within 4 ms p95 and the frame target for the tier | same bench page, TV profile | **PENDING device:** 2020-era Android TV Chromium, plus Tizen/webOS set from SPEC §12 | PENDING — no TV hardware yet |
| ER-11-15 | 128 vehicles over 8 nodes and a path queue draining 32,768 expansions per tick stay at p95 ≤ 0.8 ms combined, with no allocation after warm-up | `traffic-replay-10000.json` + `replay-crowd-600.json`; debug allocation counter | Desktop Chrome 155, Windows 11 | PENDING — needs traffic and path-queue implementations |

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | canonicalization, voxel/region/contour steps, polygon records, portal matching, A* ties, funnel edges, closest point, BT node semantics, IDM integration, intersection grants | `packages/engine/ai/test/*.test.ts` |
| Property (`fast-check`) | build determinism over generated triangle soups; path validity over random start/end; portal stitching symmetry; BT parser rejects cycles/depth/unknown names; no vehicle overlap over generated lane graphs | `packages/engine/ai/test/property/*.property.test.ts` |
| Golden | `.navmesh` bytes, content hash, funnel waypoints, bake report | `packages/engine/ai/test/golden/` |
| Integration | `NavMeshSet` + fake streaming add/remove; `AiWorld` over the real 2D physics query; runtime boot with a synthetic cell world | `packages/engine/ai/test/integration/*.test.ts`, `packages/runtime/test/integration/aiBoot.test.ts` |
| Benchmark | crowd, BT, perception, traffic, bake worker page | `packages/engine/ai/test/bench/` served by the spec 19 harness; reports `window.__AI_BENCH__` |
| Manual | TV tier, actual content, editor bake preview usability | `docs/RESULTS.md` rows ER-11-05/09/13/14 |

Rules:

- Every test title carries its `ER-11-NN` ID, or a leading `// @req ER-11-NN`. An ID must resolve to a traceability row.
- Integration tests bind `127.0.0.1:0` where a server is involved and wait on messages, never fixed sleeps. This package's own integration tests use a fake `AiWorld` and fake cell source by default; the real physics adapter is tested in runtime.
- No test is skipped or weakened to land a wave. Hardware-dependent rows are measured in the browser page and recorded manually; they are never asserted from Node.
- Benchmarks report p50, p95, max, sample count, agent/vehicle counts, browser version, adapter and build hash. A number without those fields is not evidence.
- Determinism tests run the same fixture twice in one process and once with shuffled input insertion order; a mismatch names the first differing tick and agent id.

---

## 9. Dependencies

**Specs and packages**

| Dependency | Why | State |
|---|---|---|
| 00 architecture | package boundary, contracts, determinism scope, job and memory rules | Written |
| 01 core loop/time | `FixedLoop`, `EngineFrame`, `EngineRng`, `JobSystem` interface | Written |
| 02 math | `Vec3`, `Quat`, `Aabb3`, epsilons, frustum helpers | Written |
| 03 scene/ECS | entity storage, component registration, stable object ids for canonical bakes | written |
| 06 assets | nav tiles arrive inside spec 12 cell containers; no direct asset kind is required. If standalone `.navmesh` loading is added, `AssetKind` gains `"navmesh"` additively | written |
| 07 physics3d | raycasts, circle/sphere overlap, ground queries, collision layers | Written |
| 12 world streaming | cell residency, simulation radius, cell container `nav` section, `NavMeshSet` add/remove sink | Written alongside this spec |
| 17 editor | authoring UI for `nav-build.json`, preview, dirty-tile tracking | Written |
| 19 testing/benchmarks | bench harness and `window.__AI_BENCH__` reporting | written |

**Implementation prerequisites**

- `engine-core` ships `EngineRng`, `forkCellRng`, `forkAgentRng`, `Aabb3`, `Vec3` and a scene component type registration API. AI stores `NavAgent` as a component; the canonical order still comes from `AgentId`, not the ECS.
- `engine-physics` exposes a stable `PhysicsQuery` with a raycast layer mask and a circle overlap in XZ. AI does not import a concrete physics world.
- Spec 12 provides one `nav` section per simulation cell and calls `NavMeshSet.addTile/removeTile` at cell activation/deactivation. The bytes are a complete `.navmesh` file.
- The runtime integration adapter enforces `CrowdOptions.simRadiusMeters ≤ streaming simRadius − 16 m`.

**Paper-trail prerequisites**

- Add `NAVMESH_FORMAT_VERSION`, `NAV_BUILD_FORMAT_VERSION`, `BT_FORMAT_VERSION`, `LANE_GRAPH_FORMAT_VERSION` to 00 §4.1 in the first implementing change.
- Register ER-11-01..14 in `docs/todos/TRACEABILITY.md` when the engine programme is registered.
- If `engine-tooling` consumes `@lanpad/engine-ai/bake`, record the additive dev-only edge in 00 §5.2 D8 in the same change. Until then, the bake CLI is run directly from the package.
- A14 (browser-native engine reframe) must be recorded before any engine package merges (00 preamble).

**External dependencies:** none. No third-party runtime package, no WASM, no navigation mesh library, no behavior-tree library.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | A JS navmesh bake is too slow for editor iteration or large tiles | Medium | Editor stalls; content pipeline slips | Bake in a worker with progress/cancel; smaller tiles (32 m); offline CLI for full worlds; raise tile count rather than tile size |
| R2 | Runtime generation tempts a game to bake at boot | Medium | Frame hitches, memory spikes | Spec forbids it for shipping worlds; runtime build is limited to test/editor; boot path loads bytes only |
| R3 | Crowd cost on TV exceeds the AI budget | High | 60 Hz target missed | Behaviour LOD, ORCA only NEAR, density caps, agent caps per device tier; degrade to rail-following FAR agents |
| R4 | Traffic deadlocks at unsignalised nodes | Medium | Visible gridlock | Conflict matrix is data; deterministic independent-set grants; counted deadlock breaker after 1,800 ticks; roundabout option |
| R5 | ORCA instability at high density produces jitter or tunnelling | Medium | Ugly crowds; agents clip corners | Density cap per bucket, radius margin, `moveAlongSurface` clamp, stuck detection; fall back to separation-only if avoidance time exceeds budget |
| R6 | Funnel edge cases (collinear portals, duplicate vertices) emit kinked or zero-length paths | Medium | Broken movement | Epsilons and degenerate-collapse rules in §5.3; golden U/zig-zag fixtures; property test over random portal chains |
| R7 | Navmesh and visual geometry drift (stale bake) | High over time | Agents walk through walls or float | Content hash per tile; `E_NAV_STALE` in dev; report on load in production; editor dirty-tile tracking |
| R8 | Cross-tile stitching fails after a geometry edit on one side | Medium | Paths stop at a cell boundary | Bake both touching tiles in the same job; 1 mm match with warning count; CI fixture adds/removes boundary tiles |
| R9 | Determinism breaks through iteration order or RNG reuse | High if unmanaged | Replay mismatches; debugging cost | Canonical orders in §5.7; per-agent/per-cell RNG streams; replay hash in CI; randomized insertion-order test |
| R10 | Perception raycast cost spikes with many agents | Medium | Frame spikes | 10 Hz stagger, target cap, per-tick raycast budget, memory reuse when budget is exhausted |
| R11 | AI goals cross the streamed boundary | Medium | `outside-streamed-world`, agents stall | Constrain goals in game code and BT actions; status is explicit; runtime asserts sim radius; editor warnings for mission goals near the ring |
| R12 | Behavior-tree JSON becomes an unreadable programming language | Medium | Content authors blocked; validation gaps | Closed node set, no expressions, registry resolution at parse, depth/node/state caps, editor visualisation; game logic stays in registered actions |
| R13 | Bake output is not portable across machines (float differences) | Low per 00 §5.8 scope | CI fixture mismatch | Hash is over canonical quantized input, not output floats; goldens are generated on the CI platform; cross-browser determinism is explicitly not promised |
| R14 | AI package drifts into game-specific code | Medium | Platform rot | 00 D10; registry callbacks are the only game seam; review rejects a named character/mission in engine source |
| R15 | M2 scope expands into navigation for destructible/streamed dynamic worlds | High | Nothing ships | Non-goals are normative; dynamic cuts are M3; a game needing them proposes an amendment |



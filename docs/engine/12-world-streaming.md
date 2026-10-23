# 12 — World Streaming

**Status:** authoritative for `@lanpad/engine-streaming`: cell partitioning, LOD selection, budgeted asynchronous load/unload, prioritisation, memory pressure, the world-state store and the Vice City-class ceiling. Written before implementation; nothing in this document is implemented.
**Milestone:** **M2** for the full streamer, matching the frozen-contract status in 00 §3.1 (`WorldCell` declared at M0, implemented at M2). At M0 only the package skeleton and the `WorldCell` type exist (00 §5.14). An M1 vertical slice may preload its single city block or use a reduced residency loader only under a recorded amendment; the streamer defined here is the M2 system. The ceiling target in §5.8 is **M3 evidence**, never a v1 claim.
**Authority:** [`SPEC.md`](../../SPEC.md) for product/protocol budgets, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) for the programme rules, [`00-architecture.md`](00-architecture.md) for layer boundaries and frozen contracts. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded in [`docs/todos/README.md`](../todos/README.md).

---

## 1. Goal

The player-visible outcome: an open world that keeps streaming while the player drives, walks or looks around, with no visible hole at the edge of the loaded area and no frame hitch when a city block appears. A Vice City-scale map (kilometres across, thousands of cells) must be traversable on a browser tab, first on desktop and later within TV memory.

The engineering outcomes:

1. **A fixed cell grid with one identity.** Every streamed thing belongs to exactly one world cell, addressed by the canonical `CellKey` from 00 §4.4. Saves, tooling, navigation (spec 11) and streaming use the same key; a world cannot silently mix cell sizes.
2. **Budgeted, asynchronous residency.** Loading is a state machine with cancellation, priority, a concurrency cap and a hard memory ledger. No streaming task blocks the main thread for more than 8 ms (SPEC FR-9.10, 00 §5.6).
3. **LOD with hysteresis.** Four visual tiers selected by distance to the nearest focus point, with enough hysteresis that a camera hovering on a boundary does not thrash. LOD is presentation; it never changes simulation truth.
4. **Deterministic world state independent of residency.** What is true in the world is held in an always-resident `CellStateStore`, not in the loaded meshes. The same seed and the same player path produce the same state hash whether cells loaded in 10 ms or 500 ms, in forward or reverse order.
5. **A stated ceiling.** The design target is a 4,096 m × 4,096 m world at a 64 m cell, 4,096 cells, ≤ 169 resident cells and ≤ 120 visible draw batches. It is measured only at M3 with `docs/RESULTS.md` evidence.

Streaming is the subsystem that makes the Vice City north star architecturally possible without promising it (00 §2).

---

## 2. Non-goals

- **Content authoring.** Spec 17 owns the editor and world authoring; this spec consumes a baked `world.json` plus per-cell files.
- **Asset decoding and GPU resource creation.** Spec 06 decodes GLB/KTX2/audio; specs 04/05 create and own GPU resources. Streaming orchestrates, retains handles and accounts bytes; it never calls a GPU API.
- **Collision and navigation formats.** Spec 07 owns collision payloads; spec 11 owns `.navmesh` payloads. Streaming treats both as opaque sections and hands them to the owning system.
- **Procedural world generation.** Streaming does not generate terrain, roads or props. A game may implement a `CellSource` that synthesises bytes deterministically, but the engine ships no generator.
- **Networked world state or server-authoritative streaming.** Spec 14 owns online sync. This is a local-first, host-authoritative world.
- **Save file layout.** Spec 15 owns the `.pps` container. This spec defines the `CellStateStore` payload and its version; spec 15 embeds it.
- **Renderer-side occlusion culling, impostors and shadow cascades.** Spec 04 owns those. Streaming supplies per-cell batches and LOD tiers.
- **Editor UI, minimap rendering and world validation UX.** Spec 17.
- **Destructible or morphing terrain that requires rebaking cells at runtime.** Static cell payloads for a session; a game that changes geometry writes state to the state store and swaps a variant only if the content pipeline provides one.
- **Cross-browser bit-identical simulation.** Per-build replay only (00 §5.8). Adaptive LOD may differ per device because it never touches simulation state.
- **A hard TV memory gate before E2.** Budgets stay provisional until measured on real TVs (SPEC PR-11.2, `docs/BUDGETS.md`); this spec defines tiers, not measured ceilings.

---

## 3. Public interfaces

`WorldCell`, `WorldCellId` and the canonical `CellKey` come from 00 §3.5/§4.4 and `@lanpad/engine-core`. The streamer re-exports them; it does not redefine them. `Vec3`, `Quat` and `Aabb3` are from spec 02. `AssetHandle` and `MeshData` are from spec 06. `WorldStreamer` is named in 00 §3.5 and defined here.

### 3.1 Limits and defaults

```ts
export const STREAMING_LIMITS = {
  maxCells: 16_384,
  maxCellSizeMeters: 512,
  minCellSizeMeters: 16,
  maxResidentCells: 4_096,
  maxConcurrentLoads: 16,
  maxPinnedCells: 64,
  maxFocusPoints: 10,
  maxCellCompressedBytes: 8 * 1024 * 1024,
  maxSectionsPerCell: 64,
  maxLoadsStartedPerTick: 4,
  maxLodBands: 4,
  maxWorkers: 2,
} as const;

export const STREAMING_DEFAULTS = {
  cellSizeMeters: 64,
  lodBands: [
    { lod: 0, maxDistanceMeters: 96, hysteresisMeters: 8 },
    { lod: 1, maxDistanceMeters: 160, hysteresisMeters: 12 },
    { lod: 2, maxDistanceMeters: 256, hysteresisMeters: 16 },
    { lod: 3, maxDistanceMeters: 384, hysteresisMeters: 24 },
  ],
  simRadiusMeters: 272,       // spec 11 crowd radius must be <= 272 - 16 = 256
  visualFocusRangeMeters: 400, // farther focuses contribute simulation demand only
  playerGuardMeters: 8,        // never evict a cell this close to a player
  decisionIntervalTicks: 6,
  maxConcurrentLoads: 4,
  maxLoadsStartedPerTick: 1,
  retryBackoffTicks: [15, 30, 60] as const,
  streamerTickMs: 2,
  maxTaskMs: 8,
} as const;
```

### 3.2 World configuration

```ts
export interface LodBand {
  readonly lod: 0 | 1 | 2 | 3;              // 0 = richest
  readonly maxDistanceMeters: number;       // strictly ascending across the four bands
  readonly hysteresisMeters: number;        // >= 0 and < the gap to the next band
}

export interface StreamingBudgets {
  readonly residentBytes: number;           // hard cap across all categories
  readonly textureBytes: number;            // subset of residentBytes
  readonly geometryBytes: number;           // subset of residentBytes
  readonly cpuBytes: number;                // collision + navmesh + state
  readonly maxResidentCells: number;        // <= STREAMING_LIMITS.maxResidentCells
  readonly maxConcurrentLoads: number;
  readonly maxLoadsStartedPerTick: number;
  readonly decisionIntervalTicks: number;
  readonly streamerTickMs: number;
  readonly maxTaskMs: number;
  readonly cacheBytes: number;              // best-effort CacheStorage cap; 0 disables
  readonly cacheEnabled: boolean;
}

export interface CellIndexEntry {
  /** Canonical "cx,cy" from 00 §4.4. */
  readonly key: CellKey;
  readonly cx: number;
  readonly cy: number;
  /**
   * One URL per visual LOD, richest first. Same-origin relative, no "..".
   * Empty string only when the matching `visualBytes` is 0 (not authored);
   * LOD3 is always authored.
   */
  readonly visualUrls: readonly [string, string, string, string];
  /** Collision + nav + static spawn records for the simulation ring. */
  readonly simUrl: string;
  readonly visualBytes: readonly [number, number, number, number];
  readonly simBytes: number;
  /** Composite cell identity used for cache keys and drift detection; §4.3. */
  readonly contentHash: string;
  readonly hasCollision: boolean;
  readonly hasNav: boolean;
}

export interface WorldConfig {
  readonly formatVersion: 1;
  readonly worldId: string;                 // ^[a-z0-9][a-z0-9_-]{0,63}$
  readonly seed: number;                    // u32, forks every world RNG stream
  readonly cellSizeMeters: number;          // 16..512, constant for the world
  readonly origin: Vec3;                    // world position of cell (0,0) corner
  readonly grid: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  };
  readonly lodBands: readonly LodBand[];    // exactly 4, lod 0..3
  readonly budgets: StreamingBudgets;
  readonly cells: readonly CellIndexEntry[]; // <= 16,384, unique canonical keys
}
```

### 3.3 Streamer

```ts
export interface StreamFocus {
  readonly position: Vec3;
  readonly velocity?: Vec3;                 // optional, enables look-ahead
  readonly weight?: number;                 // 0.25..4, default 1
}

export interface StreamView {
  readonly focus: readonly StreamFocus[];   // <= 10 entries
  readonly cameraPosition: Vec3;
  readonly cameraForward: Vec3;             // XZ, normalized
  readonly cameraHalfFovRad?: number;       // default 0.6
}

export interface StreamStats {
  readonly residentCells: number;
  readonly pendingLoads: number;
  readonly queuedCells: number;
  readonly failedCells: number;
  readonly residentBytes: number;
  readonly textureBytes: number;
  readonly geometryBytes: number;
  readonly cpuBytes: number;
  readonly loadsCompleted: number;
  readonly loadsCancelled: number;
  readonly loadsFailed: number;
  readonly evictions: number;
  readonly lodSwitches: number;
  readonly pressureStage: 0 | 1 | 2 | 3;
  readonly streamerTickMsP95: number;       // rolling 120 ticks
}

export type StreamEvent =
  | { readonly type: "cellLoaded"; readonly key: CellKey; readonly lod: 0 | 1 | 2 | 3; readonly bytes: number }
  | { readonly type: "cellEvicted"; readonly key: CellKey; readonly reason: "distance" | "budget" | "pressure" | "stop" }
  | { readonly type: "cellFailed"; readonly key: CellKey; readonly attempts: number; readonly code: string }
  | { readonly type: "pressure"; readonly stage: 1 | 2 | 3; readonly residentBytes: number };

export interface WorldStreamer {
  readonly config: WorldConfig;
  /** Called once per fixed tick, after input polling and before AI/physics. */
  update(tick: number, view: StreamView): void;
  getCell(key: CellKey): WorldCell | undefined;
  /** Cell containing a world XZ position, or undefined outside the grid. */
  cellAt(x: number, z: number): WorldCell | undefined;
  readonly resident: readonly WorldCell[];   // canonical key order, snapshot view
  pin(key: CellKey): boolean;                // false when missing or pin cap reached
  unpin(key: CellKey): void;
  setLodBias(bias: number): void;            // 0..3; >0 coarsens LODs sooner (§5.3)
  setSimRadius(meters: number): void;        // updates sim-group demand
  readonly stateStore: CellStateStore;
  readonly stats: StreamStats;
  on(type: StreamEvent["type"], listener: (event: StreamEvent) => void): () => void;
  stop(): void;                              // cancel loads, release all; idempotent
  dispose(): void;                           // stop + drop references; idempotent
}
```

`update` is the only entry point that mutates residency. It must complete within `budgets.streamerTickMs`; work that would exceed it is deferred to the next tick. `resident` is a reused snapshot array, valid until the next `update`.

`WorldCell.state` (00 §3.5) is the public projection of the internal state machine in §5.5: `queued`, `loading` and `decoding` report `"loading"`; `ready` and `resident` report `"resident"`; `evicting` reports `"evicting"`; `unloaded` and `failed` report `"unloaded"`. `lod` is the applied LOD for a resident cell and the last requested LOD for a cell that has not applied yet (0 if never resident). The projection is what games and the SDK see; the internal states are not part of the public contract.

`setLodBias` and adaptive pressure are presentation-only. They may differ between runs without affecting the replay hash, because the state store is authoritative (§5.6).

### 3.4 World-state store

The state store is always resident for the whole grid. It is the authoritative record of what is true; residency only decides what is drawn and simulated in detail. The store is logically complete but physically sparse: `get` returns a shared immutable default for a cell with no record, and the first write allocates a record. `serialize` emits only allocated or dirty cells when the sparse flag is set (bit 0), and every cell when it is clear.

```ts
export interface EntityStateRecord {
  readonly localId: number;      // u32, assigned at bake, unique within a cell
  readonly kind: number;         // u16, game-defined; 0xFFFF = destroyed
  position: Vec3;
  rotation: Quat;
  readonly state: Uint32Array;   // 4 words, game-defined
}

export interface CellRuntimeState {
  readonly key: CellKey;
  /** Per-cell RNG counter for deterministic streams (§5.6). */
  readonly rngCursor: number;
  readonly flags: Uint32Array;   // 16 words, game-defined
  readonly entities: readonly EntityStateRecord[]; // sorted by localId
  readonly destroyed: readonly number[];           // local ids, sorted
}

export interface CellStateStore {
  get(key: CellKey): CellRuntimeState;
  markDirty(key: CellKey): void;
  readonly dirty: readonly CellKey[];              // canonical key order
  clearDirty(): void;
  /** Engine-owned CSTR payload; the game/runtime save layer stores it opaquely. Spec 15 never parses it. */
  serialize(keys: readonly CellKey[]): ArrayBuffer;
  restore(bytes: ArrayBuffer): void;               // validates magic/version/hash/seed
  dispose(): void;                                 // idempotent
}
```

The store is constructed with the world's `WorldConfig`. `restore` rejects a payload whose `worldSeed` differs from `config.seed` (`E_STATE_WORLD`), whose cell coordinates fall outside the configured grid (`E_STATE_BOUNDS`), or whose ordering or lengths are invalid (`E_STATE_ORDER`). A save is never partially applied: a restore either replaces the whole store or throws.

### 3.5 Sources, sinks and cache

The streamer does no browser I/O itself. The runtime injects a `CellSource` (network + optional cache) and a `StreamSink` (scene, physics, navigation, audio).

```ts
export interface CellCache {
  get(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

export interface CellSource {
  /** Must resolve to the exact byte length declared in the cell header; the streamer validates it. */
  fetchCell(url: string, expectedBytes: number, signal: AbortSignal): Promise<ArrayBuffer>;
  /** Optional; absence disables persistent caching without changing behaviour. */
  readonly cache?: CellCache;
}

export interface CellRenderPayload {
  readonly meshHandles: readonly AssetHandle<MeshData>[]; // already retained by the streamer
  readonly instanceTransforms: Float32Array;              // 16 floats per instance
  readonly instanceMeshIndex: Uint16Array;                // index into meshHandles
  readonly batchMaterialIds: readonly string[];           // <= 4 at LOD0, <= 2 at LOD1+
}

export interface CellContent {
  readonly key: CellKey;
  readonly lod: 0 | 1 | 2 | 3;
  readonly render: CellRenderPayload;
  readonly collisionBytes: ArrayBuffer | null;  // spec 07 format, sim group only
  readonly navBytes: ArrayBuffer | null;        // spec 11 .navmesh, sim group only
  readonly audioEmitters: readonly AudioEmitterRecord[];
  readonly entities: readonly CellEntityRecord[];
}

export interface StreamSink {
  /** Called at a tick boundary; must be synchronous and must not block. */
  onCellActivate(cell: WorldCell, content: CellContent): void;
  onCellDeactivate(key: CellKey): void;
  onCellLodChange(key: CellKey, lod: 0 | 1 | 2 | 3): void;
  onPressure(stage: 1 | 2 | 3, bytesNeeded: number): void;
}
```

`AudioEmitterRecord` and `CellEntityRecord` are supporting structures owned by specs 09 and 03 respectively; their names are fixed here so implementation can start in parallel.

---

## 4. Data formats

All binary formats are little-endian, use `DataView` for reads and writes, and are versioned independently. Version constants are exported from `@lanpad/engine-streaming`:

```ts
export const WORLD_FORMAT_VERSION = 1;
export const CELL_FORMAT_VERSION = 1;
export const CELL_STATE_FORMAT_VERSION = 1;
```

### 4.1 `world.json`

The world manifest is fetched once at boot. It is JSON (UTF-8, ≤ 512 KiB gzip) and is validated against `sdk/schema/world.schema.json` (new, spec 17 owns the schema file; streaming owns the runtime validator). Synthetic example:

```json
{
  "formatVersion": 1,
  "worldId": "example-city",
  "seed": 123456789,
  "cellSizeMeters": 64,
  "origin": { "x": -2048, "y": 0, "z": -2048 },
  "grid": { "minX": -32, "minY": -32, "maxX": 31, "maxY": 31 },
  "lodBands": [
    { "lod": 0, "maxDistanceMeters": 96, "hysteresisMeters": 8 },
    { "lod": 1, "maxDistanceMeters": 160, "hysteresisMeters": 12 },
    { "lod": 2, "maxDistanceMeters": 256, "hysteresisMeters": 16 },
    { "lod": 3, "maxDistanceMeters": 384, "hysteresisMeters": 24 }
  ],
  "budgets": {
    "residentBytes": 134217728,
    "textureBytes": 83886080,
    "geometryBytes": 41943040,
    "cpuBytes": 8388608,
    "maxResidentCells": 192,
    "maxConcurrentLoads": 4,
    "maxLoadsStartedPerTick": 1,
    "decisionIntervalTicks": 6,
    "streamerTickMs": 2,
    "maxTaskMs": 8,
    "cacheBytes": 268435456,
    "cacheEnabled": true
  },
  "cells": [
    {
      "key": "0,0",
      "cx": 0,
      "cy": 0,
      "visualUrls": ["v0.cell", "v1.cell", "v2.cell", "v3.cell"],
      "simUrl": "sim.cell",
      "visualBytes": [1572864, 524288, 131072, 32768],
      "simBytes": 65536,
      "contentHash": "fnv1a32:89abcdef",
      "hasCollision": true,
      "hasNav": true
    }
  ]
}
```

Rules:

- `grid` is inclusive; `(maxX - minX + 1) × (maxY - minY + 1) ≤ 16,384`. Every cell in the rectangle must have exactly one index entry; a missing entry is a hole and is legal only if the game declares it water/void via the `flags` bit in §4.2. The streamer never invents cells.
- `cellSizeMeters` is constant for the world and must be an integer. Cell `(cx, cy)` covers `[origin.x + cx·S, origin.x + (cx+1)·S) × [origin.z + cy·S, origin.z + (cy+1)·S)` where `S` is `cellSizeMeters`. Y is elevation, not a cell axis.
- URLs are resolved relative to the manifest URL, must be same-origin, must not contain `..` or a scheme, and are validated before any fetch.
- `visualUrls[0..3]` each contain either a valid same-origin relative URL or the empty string. The empty string is legal only when the matching `visualBytes[i]` is `0`, meaning that LOD is not authored; the streamer substitutes the next-coarser authored LOD and does not fetch it. `visualUrls[3]` and `visualBytes[3]` must always be authored.
- `simUrl` may be the empty string only when `hasCollision` and `hasNav` are both false; such a cell has visual-only content (distant scenery).
- `contentHash` is a composite identity computed at bake: `fnv1a32(UTF8(key) ‖ 0x00 ‖ h0 ‖ h1 ‖ h2 ‖ h3 ‖ hs)`, where `hi` is the 4-byte little-endian FNV-1a 32 of the uncompressed visual payload for LOD `i` and `hs` is the same for the simulation payload; an unauthored LOD contributes four zero bytes. It is used for cache keys and deploy-drift detection. Each `.cell` header separately hashes its own sections (§4.2). A mismatch of either hash is `E_CELL_HASH` and the cell fails.

### 4.2 `.cell` container

One file per payload: four visual LODs (one file each) and one simulation file. Container header, 64 bytes:

| Offset | Type | Field | Rule |
|---:|---|---|---|
| 0 | `u32` | magic | `0x4C435050` (`"PPCL"`) |
| 4 | `u16` | formatVersion | 1 |
| 6 | `u16` | headerBytes | 64 |
| 8 | `u32` | contentHash | FNV-1a 32 of uncompressed section bytes |
| 12 | `i32` | cx | matches manifest |
| 16 | `i32` | cy | matches manifest |
| 20 | `u16` | cellSizeCm | `cellSizeMeters × 100`; 1,600..51,200 |
| 22 | `u8` | kind | 0 = visual, 1 = simulation |
| 23 | `u8` | lod | 0..3 for visual; `0xFF` for simulation |
| 24 | `u32` | uncompressedBytes | sum of section uncompressed sizes |
| 28 | `u32` | sectionCount | ≤ 64 |
| 32 | `f32` | minX | world-space AABB |
| 36 | `f32` | minY | |
| 40 | `f32` | minZ | |
| 44 | `f32` | maxX | |
| 48 | `f32` | maxY | |
| 52 | `f32` | maxZ | |
| 56 | `u32` | flags | bit 0 hasCollision, 1 hasNav, 2 hasAudio, 3 hasSpawn, 4 water/void, 5 generated |
| 60 | `u32` | reserved | 0 |

Section table entry, 24 bytes, immediately after the header, `sectionCount` entries:

| Offset | Type | Field | Rule |
|---:|---|---|---|
| 0 | `u16` | type | see table below |
| 2 | `u16` | flags | bit 0 gzip, bits 1..15 reserved (0) |
| 4 | `u32` | offset | from file start, 4-byte aligned |
| 8 | `u32` | compressedBytes | |
| 12 | `u32` | uncompressedBytes | |
| 16 | `u16` | sectionVersion | 1 unless the owning spec says otherwise |
| 18 | `u16` | reserved | 0 |
| 20 | `u32` | hash | FNV-1a 32 of uncompressed bytes |

Section types:

| Type | Payload | Owner | Allowed in |
|---:|---|---|---|
| 1 | Mesh batch set (spec 06 GLB sub-assets) | 06 | visual |
| 2 | Texture references (spec 06 asset ids, no bytes) | 06 | visual |
| 3 | Collision payload | 07 | simulation |
| 4 | `.navmesh` tile (spec 11 §4.1) | 11 | simulation |
| 5 | Static spawn records | 12 / 03 | simulation |
| 6 | Audio emitter records | 09 | both |
| 7 | Metadata JSON ≤ 8 KiB UTF-8 | 12 | both |
| 8..32767 | game-defined, opaque | game | both, game validates |
| 32768..65535 | reserved | — | rejected |

Rules:

- Sections are opaque to the streamer; it validates the table (bounds, alignment, no overlap, hash, sizes) and dispatches. A section whose owner rejects it fails the whole cell (`E_CELL_SECTION`).
- `gzip` uses `DecompressionStream("gzip")`; a section whose decompressed length differs from `uncompressedBytes` is rejected. Compression is per section so a worker can decode one batch at a time.
- Visual payloads must contain no collision or nav sections; simulation payloads must contain no mesh or texture sections. Violations are `E_CELL_KIND`.
- A LOD0 visual payload must expose at most 4 batches; LOD1+ at most 2. `batchMaterialIds.length` must equal the batch count. These caps are the streaming side of the draw-call budget; the renderer's frustum and occlusion culling (spec 04) must still keep the frame at ≤ 120 draw calls (SPEC PR-9.1).
- `hasSpawn` and section 5 are required when a cell can spawn dynamic entities; spawn records are fixed 28 bytes: `localId u32, kind u16, flags u16, x/y/z f32, yaw f32, respawnSeconds u16, reserved u16` = 28 bytes.
- The AABB must match the manifest cell bounds in XZ within 0.01 m; it is the renderer's culling hint, not a second source of truth.

### 4.3 Canonical hashing

`fnv1a32(bytes)`: offset basis `0x811c9dc5`, prime `0x01000193`, over the uncompressed byte range; formatted as `"fnv1a32:" + hex8`. The same function hashes `world.json` cell entries during bake and every section at load. Hash comparison is constant-time only where it protects something secret; cell hashes are integrity checks, not security.

### 4.4 `CSTR` state payload

Produced by `CellStateStore.serialize` and stored opaquely by the game/runtime save layer; spec 15 never parses it. Header, 48 bytes:

| Offset | Type | Field |
|---:|---|---|
| 0 | `u32` | magic `0x52545343` (`"CSTR"`) |
| 4 | `u16` | formatVersion (1) |
| 6 | `u16` | headerBytes (48) |
| 8 | `u32` | worldSeed |
| 12 | `u32` | cellCount |
| 16 | `u32` | entityCount |
| 20 | `u32` | payloadBytes (excluding header) |
| 24 | `u32` | contentHash (FNV-1a 32 of payload) |
| 28 | `u32` | flags (bit 0 sparse — cells with no changes omitted) |
| 32..47 | — | reserved (0) |

Payload, in canonical order:

- Cell record, 28 bytes: `cx i32, cy i32, rngCursor u32, flagCount u16, entityCount u16, destroyedCount u16, reserved u16, entitiesOffset u32 (from payload start), destroyedOffset u32`.
- Cell flags: `flagCount × u32` (≤ 16).
- Entity record, 52 bytes: `localId u32, kind u16, flags u16, px f32, py f32, pz f32, qx f32, qy f32, qz f32, qw f32, state0..state3 u32`.
- Destroyed ids: `destroyedCount × u32`, ascending.

Cells are serialized in ascending `(cx, cy)`; entities in ascending `localId`. A restore rejects unsorted or duplicate records (`E_STATE_ORDER`), out-of-bounds offsets, non-finite floats, and a hash mismatch. The format is residency-independent by construction; `rngCursor` continues the cell stream even if the cell was evicted.

### 4.5 Version registry

| Format | Constant | Value | Compatibility rule |
|---|---|---:|---|
| World manifest | `WORLD_FORMAT_VERSION` | 1 | additive fields only; reader rejects unknown major |
| Cell container | `CELL_FORMAT_VERSION` | 1 | new section types additive; header layout frozen |
| State payload | `CELL_STATE_FORMAT_VERSION` | 1 | additive sections only; header layout frozen |
| Spawn record | `SECTION_VERSION_SPAWN` | 1 | fixed 28 bytes |
| Metadata JSON | `SECTION_VERSION_METADATA` | 1 | schema-validated |
| World cell key | `WORLD_CELL_KEY_VERSION` | 1 | canonical `"<cx>,<cy>"`; owned by 12 (00 §4.4) |

These rows must be added to the version registry in 00 §4.1 before implementation. Unknown versions fail closed; there is no best-effort parse.

### 4.6 Bake-time limits

| Item | Limit |
|---|---:|
| Visual payload LOD0 / LOD1 / LOD2 / LOD3 | 1.5 MiB / 512 KiB / 128 KiB / 32 KiB uncompressed |
| Simulation payload | 64 KiB uncompressed |
| Per-cell compressed total | ≤ 8 MiB (`maxCellCompressedBytes`) |
| Sections per file | ≤ 64 |
| Metadata JSON | ≤ 8 KiB |
| Static spawn records per cell | ≤ 4,096 |
| Cell AABB | must equal manifest cell bounds in XZ |
| World manifest | ≤ 512 KiB gzip |

A payload over its LOD limit fails the bake, not the runtime. The runtime enforces the same numbers defensively and reports `E_CELL_SIZE`.

---

## 5. Architecture

### 5.1 Module map

| File | Responsibility |
|---|---|
| `src/World.ts` | `WorldStreamer` facade, tick orchestration, focus handling, event emitter |
| `src/Grid.ts` | `CellKey` parsing/formatting, world↔cell transforms, neighbourhood iteration, bounds checks |
| `src/Index.ts` | `world.json` parse/validate, manifest index, URL resolution, boot-time budget check |
| `src/Lod.ts` | band selection with hysteresis, `lodBias`, effective distances |
| `src/Priority.ts` | focus scoring, candidate selection, deterministic sort, prefetch window |
| `src/Residency.ts` | state machine, admission (start limits, concurrency), cancellation tokens |
| `src/Decode.ts` | section table validation, gzip decode, dispatch to spec 06/07/11 parsers; no `Worker` construction |
| `src/worker/decodeWorker.ts` | browser worker entry; decodes one section per message and posts transferable buffers |
| `src/Apply.ts` | tick-boundary apply queue, time slicing, `StreamSink` calls |
| `src/Memory.ts` | byte ledger, category accounting, pressure stages, eviction policy |
| `src/StateStore.ts` | `CellStateStore`, CSTR serialize/restore, dirty tracking |
| `src/Cache.ts` | cache-key builder and LRU policy; the CacheStorage adapter lives in the runtime |
| `src/Stats.ts` | `StreamStats`, rolling p95, debug counters |
| `src/StreamEvents.ts` | event types, listener registry, error codes |
| `src/index.ts` | public exports only |

No file in this package imports the DOM, `fetch`, `WebSocket`, the renderer, or a game. Browser I/O is injected through `CellSource`/`StreamSink`; the runtime adapter (`packages/runtime/src/engine/streamingWorld.ts`) owns `fetch`, CacheStorage and bus wiring.

### 5.2 Partitioning and ownership

- One world, one cell size. There is no nested grid and no second world coordinate system. The simulation uses metres and the same origin as `world.json`.
- A cell owns its static content: meshes, textures, collision, navmesh tile, spawn records, audio emitters. Dynamic entities that move across cells change the cell they belong to only at save time; during play an entity's home cell is fixed at spawn and used for state ordering.
- Each cell has exactly one visual payload per authored LOD and one simulation payload. A cell may be visual-only (distant scenery) but an entity may not live in a visual-only cell.
- The streamer does not own game objects. It owns handles, bytes and lifecycle callbacks; the sink inserts/removes entities and static bodies.
- Cell size is a bake-time decision recorded in the manifest. Changing it later is a new world version, not a runtime option.

### 5.3 Residency rings and LOD

Four bands, measured from the nearest focus point to the cell AABB in XZ (0 when the focus is inside the cell). With the defaults and 64 m cells:

| Band | Radius | Chebyshev radius | Cells in ring | Incremental cells | Worst-case payload each |
|---|---:|---:|---:|---:|---:|
| LOD0 | 96 m | 2 | 5 × 5 = 25 | 25 | 1.5 MiB |
| LOD1 | 160 m | 3 | 7 × 7 = 49 | 24 | 512 KiB |
| LOD2 | 256 m | 4 | 9 × 9 = 81 | 32 | 128 KiB |
| LOD3 | 384 m | 6 | 13 × 13 = 169 | 88 | 32 KiB |
| Simulation | 272 m | 5 | 11 × 11 = 121 | 121 sim payloads | 64 KiB |

Worst-case resident footprint at the defaults: 25×1.5 + 24×0.5 + 32×0.125 + 88×0.03125 = **56.25 MiB** of visual payload, plus 121×0.0625 = **7.56 MiB** of simulation payload, plus shared atlases ≤ 24 MiB = **87.8 MiB**. This is a design model, not a measurement. It must fit the provisional texture budget of 128 MB and host heap of 358 MB in [`docs/BUDGETS.md`](../BUDGETS.md); TV memory stays PENDING under PR-11.2 and no hard TV fail is set. `maxResidentCells` caps the count independently of bytes, and the memory ledger wins over LOD preference.

LOD selection:

- Effective band distance is `band.maxDistanceMeters × (4 − lodBias) / 4`, with `lodBias ∈ [0, 3]`. A higher bias drops cells to coarser LODs sooner; it never makes a band larger.
- Promotion to a finer LOD requires `distance < maxDistance − hysteresis`; demotion to a coarser LOD requires `distance > maxDistance + hysteresis`. Inside the dead band the current LOD is kept. Hysteresis is per band and must be smaller than the gap to the next band (validated).
- A cell being promoted keeps its current LOD resident until the finer payload applies, so there is no hole during a swap. A cell being demoted keeps the finer payload until the coarser one applies.
- LOD3 is the furthest band; beyond `band[3].maxDistance + hysteresis[3] + cellSize` the cell is evicted. A cell with no authored LOD3 cannot exist (manifest validation).
- Distant focus points (players farther than `visualFocusRangeMeters = 400` from the camera) contribute a simulation demand only; they never raise the visual LOD above 2. This keeps 8-player rooms from loading eight full-quality rings.

### 5.4 Priority and scheduling

Every candidate is assigned a priority class:

| Class | Candidate |
|---:|---|
| 0 | Simulation payload of a cell containing or adjacent to a focus; visual LOD0 within its band |
| 1 | Simulation payload within the simulation radius |
| 2 | Visual LOD1 |
| 3 | Visual LOD2 |
| 4 | Visual LOD3 / prefetch |

Within a class, the score is:

```
score = min over focus f of (distanceXZ(f.position, cellAabb) / clamp(f.weight, 0.25, 4))
if dot(cameraForward, normalize(cellCenter − cameraPosition)) < 0:
    score += 0.25 * cellSizeMeters
if focus.velocity is present:
    lookAhead = f.position + clamp(velocity, 2 s, 64 m) contributes at weight × 0.5
sort by (class, score, cx, cy)
```

The camera-forward penalty demotes behind-camera cells but never removes them; a fast 180° turn must find the ring already resident. The sort is total and deterministic: no hash-map iteration order, no `Array.prototype.sort` instability dependence (the comparator includes `cx, cy`).

Cadence:

- Recompute the candidate set every `decisionIntervalTicks` (6 ticks = 100 ms at 60 Hz), or immediately when a focus moves more than 8 m since the last decision, or when a cell completes and a queued candidate exists.
- Between decisions, completions and evictions still apply; only new starts are gated.
- At most `maxLoadsStartedPerTick` loads start per tick and at most `maxConcurrentLoads` are in flight. Cancellation is instantaneous from the streamer's point of view: the token aborts, the result is dropped, the state returns to `unloaded`.

### 5.5 Asynchronous pipeline

```
unloaded ──admit──▶ queued ──start──▶ loading ──bytes──▶ decoding ──sections──▶ ready ──apply──▶ resident
   ▲                   │                │                   │                     │
   │                   └──cancel────────┴───────────────────┘                     │
   │                                                                              │
   └──────────────────────────── evict / release ◀────────────────────────────────┘
```

State rules:

- `queued` holds a priority and an attempt count, not a promise. Cancelling is O(1).
- `loading` holds an `AbortController`; `fetchCell` must reject with an abort error on signal. The streamer validates the response byte length against the header before decode.
- `decoding` runs in one of 2 workers (`maxWorkers`, fixed at 2 for v1). Each worker decodes one section at a time and posts transferable `ArrayBuffer`s; the main thread never gunzips, never parses GLB, and never touches more than one section per message.
- `ready` is a compact record of decoded handles and offsets, not a scene object. Handles are retained here; if apply is deferred, bytes stay counted.
- `resident` means `StreamSink.onCellActivate` has run. Apply happens only at a tick boundary, in ascending `(cx, cy)` order, and stops when `streamerTickMs` is exhausted. Deferred applies keep the cell in `ready`, counted, and are retried next tick.
- Eviction calls `onCellDeactivate` synchronously at the same tick boundary, in ascending key order, before any new activation. A cell can therefore be deactivated and a different one activated in the same tick, but never the reverse order for the same key.
- Failure: attempt 1 at start, retry after 15 ticks, attempt 2 after 30, attempt 3 after 60. After the third failure the cell is `failed`, emits `cellFailed`, and is retried only if the player re-enters its LOD0 band. Fetch failure is `E_STREAM_FETCH`; every other failure code is preserved in the event.
- `onCellActivate` throwing is a content bug: the streamer releases the cell's handles, counts it failed, and reports `E_CELL_APPLY`. It does not retry the same payload in the same session.
- `stop()` aborts everything, drains the apply queue, deactivates resident cells in key order, and is idempotent. `dispose()` additionally drops the sink and source references.

### 5.6 Determinism

Determinism scope is a single build on a single browser against a recorded input path (00 §5.8). Within that scope:

1. **The state store is authoritative.** Simulation may read `CellRuntimeState`; it may not read meshes, LODs or `getCell()`. `getCell()` is presentation-only and may legitimately be `undefined` for a cell the simulation knows about.
2. **RNG is forked per cell and stream.** `forkCellRng(worldSeed, cx, cy, stream)` is exported from `engine-core`; agent-scoped streams use `forkAgentRng(worldSeed, cx, cy, localId, stream)` and are owned by spec 11. Cell stream ids (spec 12): 0 world/spawn, 1 ambient/props, 2 traffic spawn, 3 mission, 4 weather/effects. Agent stream ids (spec 11): 0 behaviour, 1 perception, 2 traffic behaviour, 3 effects. No system draws from a global stream. A cell's `rngCursor` advances only when that cell is simulated and is saved in CSTR.
3. **Canonical order.** Cells iterate ascending `(cx, cy)`; entities ascending `localId`; spawn records ascending `localId`. Activation and deactivation use the same order. No iteration over a `Map` whose insertion order depends on load completion.
4. **Activation restores, never spawns.** On activation, entities are restored from the state store; spawn records are used only for entities with no record. A cell's visual residency therefore cannot create or destroy simulation state.
5. **Time is tick-indexed.** Streaming completion times, decode durations and applied LODs never feed `simTime`, AI timers, or RNG. This is why adaptive LOD can differ per device without changing the replay hash.
6. **Deactivation freezes.** When a simulation cell leaves the simulation radius, its dynamic entities stop being simulated and their last state stays in the store. Re-entry resumes from that state at the tick the cell activates. The replay oracle therefore uses a fixed player path: the same path produces the same activation ticks and the same hash.
7. **Save hash.** `stateHash = fnv1a32(stateStore.serialize(allCellKeys))`; the harness compares it at fixed tick intervals across two runs and across a forced-eviction run (cells forcibly evicted and reloaded must produce the same hash at the same ticks).

Rule 7's forced-eviction run is the strongest test: it proves residency timing does not leak into simulation.

### 5.7 Memory ledger and pressure

The ledger is updated synchronously at apply and evict; it never samples. Accounted categories:

| Category | Contents | Counted |
|---|---|---|
| `geometryBytes` | vertex/index buffers and instance arrays retained for resident cells | once per handle |
| `textureBytes` | textures referenced by resident cells; shared atlas counted once by asset id | once per asset |
| `cpuBytes` | decoded collision, navmesh tiles, metadata, state records, ready records | per cell |
| `residentBytes` | sum of all categories, including handles shared with the boot set | total |

Thresholds: stage 1 at 85% of `residentBytes`, stage 2 at 95%, stage 3 at 100%. Eviction policy, in order:

1. Cells beyond the unload distance (band 3 + hysteresis + one cell) — reason `distance`.
2. Under pressure: raise `lodBias` by one (max 3), which coarsens bands and shrinks the demand set; evict cells now outside their effective band.
3. Evict the farthest non-pinned cell, coarsest LOD first; ties by descending `(cx, cy)` — reason `pressure`.
4. If still over budget after three ticks, emit `E_STREAM_BUDGET` and continue evicting the farthest non-pinned visual payload regardless of LOD (the simulation-ring floor below still applies). The streamer never evicts a pinned cell and never evicts a cell containing a player or within `playerGuardMeters = 8` of one.
5. Recovery: after 600 consecutive ticks below 80%, lower `lodBias` by one. Bias never goes below 0.

**Simulation ring floor.** A simulation payload inside `simRadiusMeters` is never evicted to make room for a visual payload. Under pressure the streamer coarsens or evicts visuals first. If the simulation ring alone exceeds `residentBytes`, the streamer emits `E_STREAM_SIM_BUDGET`, keeps the ring resident and reports the overage; the game must reduce the simulation radius. This is what makes spec 11's claim true that an active agent's decision never depends on visual residency.

`pin` is the game's escape hatch for mission-critical content (a cutscene interior, a held vehicle). `maxPinnedCells = 64`; pinning past the cap returns `false` and reports nothing. If pins alone exceed `residentBytes`, the streamer calls `onPressure(3, bytes)` and reports `E_STREAM_PIN_BUDGET` but evicts nothing pinned. A game that pins itself into a budget breach is a game bug with a diagnostic, not a reason to break the world.

Persistent cache: disabled in private browsing or when `cacheEnabled` is false. Keys are `${worldId}/v${CELL_FORMAT_VERSION}/${payloadHash}/${name}`. `CacheStorage` failures are swallowed; caching is an optimisation and never a correctness dependency. Trim runs at boot and every 600 ticks to `cacheBytes`, deleting least-recently-used entries; recency is stored in the cache entry's metadata, not IndexedDB.

### 5.8 Vice City-class ceiling (design target, M3 evidence)

| Quantity | Target | Constraint it satisfies |
|---|---:|---|
| World extent | 4,096 m × 4,096 m (16.7 km²) | Vice City-scale landmass |
| Cell size / grid | 64 m / 64 × 64 = 4,096 cells | 169-cell ring at LOD3 |
| LOD tiers | 4 | SPEC FR-9.9 (≥ 3) |
| Resident cells | 169 typical, 256 cap | memory ledger |
| Simulated cells | 121 at 272 m | spec 11 budget |
| Visible draw batches | ≤ 120 (SPEC PR-9.1); ≤ 4 per LOD0 cell, ≤ 2 per LOD1+ | renderer budget with frustum/occlusion culling |
| Payload per LOD0 cell / sim cell | ≤ 1.5 MiB / ≤ 64 KiB | resident footprint |
| Traversal speed | 40 m/s (144 km/h) | prefetch horizon: 384 m / 40 m/s = 9.6 s |
| Streaming decision latency | 100 ms cadence, 2 ms tick budget, 8 ms task | no frame hitch |
| Initial world manifest | ≤ 512 KiB gzip | boot-set budget; total boot set ≤ 5 MB gzip (FR-9.6) |
| Boot set (game + manifest + first ring) | ≤ 5 MB gzip | SPEC FR-9.6 |
| Resident memory | texture ≤ 128 MB, host heap ≤ 358 MB (desktop, provisional) | [`docs/BUDGETS.md`](../BUDGETS.md); TV PENDING (PR-11.2) |

The ceiling is a budget model, not a promise. It becomes evidence only when the M3 slice runs and the numbers land in `docs/RESULTS.md` on named hardware.

### 5.9 Integration points

- **Renderer (04/05):** receives `CellRenderPayload` batches and draws them per cell. Streaming decides which cells exist; the renderer decides what is visible inside them. LOD swaps are cell-level, not per-mesh.
- **Physics (07):** `collisionBytes` are parsed into static bodies at activation and removed at deactivation. A body leaving the simulation ring sleeps; it is never destroyed, because its state lives in CSTR.
- **Navigation (11):** `navBytes` populate the per-tile `NavMeshSet`; tiles are added/removed with the cell. Spec 11's `outside-streamed-world` status is the only correct answer for a path target in a non-simulated cell.
- **Audio (09):** emitters are registered at activation, unregistered at deactivation; one-shots owned by the game are unaffected.
- **Scene/ECS (03):** the sink inserts static entities and spawns dynamic ones from `CellEntityRecord` only when the state store has no record.
- **Runtime host:** `packages/runtime/src/engine/streamingWorld.ts` implements `CellSource` over `fetch`, `CellCache` over CacheStorage, and the `StreamSink` over the scene/physics/nav/audio systems. The runtime decides the focus set from the camera and the 8 player positions.
- **Save/load (15):** embeds the CSTR payload, not the residency list. Loading a save restores the state store before the first `update`.
- **Editor (17):** bakes `world.json`, validates cell bounds and budgets, and must fail the bake on oversized payloads.

### 5.10 Hot-path rules and budgets

- `update` allocates nothing after warm-up. Candidate arrays, priority arrays, the apply queue and stats are preallocated to `maxResidentCells × 4` and reused. The only allowed allocations are on the load path (byte buffers) and on a world reload.
- Cell lookup is a flat `Uint32Array` index over the grid rectangle plus a `Map<CellKey, index>` only for out-of-rectangle safety; `cellAt` is O(1) arithmetic.
- No promise is created per tick. Promises exist only per in-flight fetch/decode.
- Per-frame budget: `streamerTickMs` 2 ms p95, `maxTaskMs` 8 ms hard for any main-thread task, apply ≤ 0.5 ms per cell, worker decode time-sliced by section.
- Stats rolling window is 120 ticks; no timers, no `performance.now()` in simulation logic except the debug-only p95 counter.

---

## 6. File ownership

Canonical package path is `packages/engine/streaming/**` (00 §5.3 and the README spec index). An earlier work brief wrote `packages/streaming/**`; that is shorthand for the same package and must not create a second one. This spec owns only the files below plus its own document. Package-local `package.json`, `tsconfig.json`, root workspace, Vitest project and eslint entries are integration-agent changes (00 §5.16), not feature-agent edits.

| Path | Owns |
|---|---|
| `packages/engine/streaming/src/index.ts` | public exports; no logic |
| `packages/engine/streaming/src/World.ts` | `WorldStreamer` facade, tick orchestration, focus handling, event emitter |
| `packages/engine/streaming/src/Grid.ts` | `CellKey` parse/format, world↔cell transforms, neighbourhood iteration, bounds checks |
| `packages/engine/streaming/src/Index.ts` | `world.json` parse/validate, manifest index, URL resolution, boot-time budget check |
| `packages/engine/streaming/src/Lod.ts` | band selection with hysteresis, `lodBias`, effective distances |
| `packages/engine/streaming/src/Priority.ts` | focus scoring, candidate selection, deterministic sort, prefetch window |
| `packages/engine/streaming/src/Residency.ts` | state machine, admission, concurrency, cancellation tokens |
| `packages/engine/streaming/src/Decode.ts` | section-table validation, gzip decode, dispatch to spec 06/07/11 parsers; no `Worker` construction |
| `packages/engine/streaming/src/worker/decodeWorker.ts` | browser worker entry; decodes one section per message and posts transferable buffers |
| `packages/engine/streaming/src/Apply.ts` | tick-boundary apply queue, time slicing, `StreamSink` calls |
| `packages/engine/streaming/src/Memory.ts` | byte ledger, category accounting, pressure stages, eviction policy |
| `packages/engine/streaming/src/StateStore.ts` | `CellStateStore`, CSTR serialize/restore, dirty tracking |
| `packages/engine/streaming/src/Cache.ts` | cache-key builder and LRU policy; the CacheStorage adapter lives in the runtime |
| `packages/engine/streaming/src/Stats.ts` | `StreamStats`, rolling p95, debug counters |
| `packages/engine/streaming/src/StreamEvents.ts` | event types, listener registry, error codes |
| `packages/engine/streaming/test/**` | unit, property, golden, integration, benchmark fixtures |
| `docs/engine/12-world-streaming.md` | this spec |

Fixtures owned here: `packages/engine/streaming/test/fixtures/world-64x64.world.json` (generated by `test/fixtures/build-world.mjs`, checked in as a golden), `cells/ring/*.cell`, `drive-path-4_8km.json`, `pressure-run.json`, `focus-8p.json`, `lod-oscillation.json`, `source-latency.json`, `golden/state-hash.json`, `golden/cstr/*.bin`.

Integration adapters are **not** owned here and are written by the integration agent: `packages/runtime/src/engine/streamingWorld.ts` (facade wiring), `packages/runtime/src/engine/cellSourceFetch.ts` (`fetch` + abort), `packages/runtime/src/engine/cellCacheStorage.ts` (CacheStorage), `packages/runtime/src/engine/streamingSink.ts` (scene/physics/nav/audio sinks). The runtime owns composition; this package owns algorithms and formats.

---

## 7. Acceptance

All rows are **PENDING**: no engine code exists yet. A row becomes PASS only with a recorded build, device, browser version, date and numbers in `docs/RESULTS.md` (00 §7 evidence rule). Requirement IDs must be registered in `docs/todos/TRACEABILITY.md` when the engine programme is added there.

| ID | Criterion | Fixture / method | Hardware / run | State |
|---|---|---|---|---|
| ER-12-01 | The generated 4,096-cell manifest parses and validates in ≤ 100 ms p95; invalid keys (`+3`, `003`, `-0`), duplicate cells, **every hole** (a missing cell is rejected with `E_WORLD_HOLE` until the manifest carries an explicit water/void flag), a URL with `..` or a scheme, a missing LOD3 and a grid over 16,384 cells are each rejected with the named code | `world-64x64.world.json` + `invalid/*.world.json` | CI Node 20 | PENDING — timing half only |
| ER-12-02 | On `drive-path-4_8km.json` (**4.8 km** at 40 m/s for 120 s at 60 Hz) against a seeded source (`p50 40 ms`, `p95 120 ms`), every cell whose AABB is within 160 m of the camera and in the frustum is `resident` at every tick after a 10 s warm-up; no cell is activated after its nearest distance to the camera falls below 96 m; `stats.failedCells === 0` | `drive-path-4_8km.json` + `source-latency.json` + fake sink | CI Node 20 | PENDING — driven integration test not yet written |
| ER-12-03 | In `pressure-run.json` (5× budget demand, 10,000 ticks) `residentBytes` never exceeds `budgets.residentBytes`; pressure events fire 1→2→3 in order; zero pinned cells are evicted; sim-ring cells are never evicted, so the activation guard defers admissions rather than exceeding the ledger; the ledger returns to 0 after `stop()`; accounted bytes equal the summed retained handle sizes | `pressure-run.json` + instrumented `AssetLibrary` | CI Node 20 | PENDING — unit half PASS, full pressure run PENDING |
| ER-12-04 | A 5-minute bench drive produces no main-thread task longer than 8 ms attributable to streaming (marks around `update` and apply); `update` p95 ≤ 2 ms; apply p95 ≤ 0.5 ms per cell | `test/bench/stream-bench.html`; PerformanceObserver `longtask`; `window.__STREAM_BENCH__` | Desktop Chrome 155, Windows 11, GPU adapter recorded | PENDING — needs implementation |
| ER-12-05 | The same seed and drive replayed twice, plus a run with forced evictions every 120 ticks, produce identical CSTR state hashes at ticks 600, 1200, …, 7200; the same drive with cells offered in forward, reverse and shuffled order produces the same hashes | `drive-path-4_8km.json`; hashes in `golden/state-hash.json` | CI Node 20 | PENDING — fixture authored with the implementation |
| ER-12-06 | A camera oscillating ±2 m across each band boundary for 600 ticks after warm-up produces ≤ 1 LOD switch per cell and zero switches while inside the hysteresis dead band | `lod-oscillation.json` | CI Node 20 | PENDING — needs the LOD selector |
| ER-12-07 | 100 focus teleports over 600 ticks cancel in-flight loads within 2 ticks; no `onCellActivate` fires for a cell outside the demand set after that point; `stop()` leaves zero pending loads, zero retained handles and a zero ledger | `focus-jumps-100.json` | CI Node 20 | PENDING — needs the residency machine |
| ER-12-08 | Generated `.cell` headers with bad magic/version/alignment/overlap/hash/size/kind are rejected as a unit with the named code; 10,000 `fast-check` cases never throw an uncaught exception or read out of bounds | `fast-check` + `invalid/*.cell` | CI Node 20 | PENDING — parser not yet written |
| ER-12-09 | CSTR `serialize → restore → serialize` is byte-identical for a sparse 4,096-cell store and a dense store; unsorted, duplicate, out-of-grid and wrong-seed payloads are rejected; a restored cell resumes the same `rngCursor` | `golden/cstr/*.bin` | CI Node 20 | PENDING — needs `StateStore` |
| ER-12-10 | With a recording `CellCache`, a second drive hits the cache for ≥ 95% of payloads and issues no network fetch; a cache that always throws yields the same final state with only counted warnings | `cache-spy.ts` + `drive-path-4_8km.json` | CI Node 20 | PENDING — needs the cache policy |
| ER-12-11 | Ten focus points (8 players + camera + look-ahead), six beyond `visualFocusRangeMeters`, keep resident cells ≤ 256 and within the ledger; distant players add simulation demand only and never promote a cell above LOD2 | `focus-8p.json` | CI Node 20 | PENDING — needs the priority selector |
| ER-12-12 | A 4,096-cell manifest (≤ 512 KiB gzip) parses and the first LOD0 ring is resident within 3 s on a local server, with byte-accurate progress and total boot set ≤ 5 MB gzip | `world-64x64.world.json` + dev server | Desktop Chrome 155, Windows 11 | PENDING — needs the boot path |
| ER-12-13 | **M3 ceiling dry-run**, not an M2 claim: a 4,096 m × 4,096 m world driven for 2 km at 40 m/s holds frame p95 ≤ 14 ms target / ≤ 20 ms hard, ≤ 120 draw calls, texture memory ≤ 128 MB, host heap ≤ 358 MB, resident cells ≤ 256 | M3 slice scene + `stream-bench.html` | **PENDING device + content:** desktop `pc-win11-rtx3050` first; TV set PENDING | PENDING — M3 content does not exist |
| ER-12-14 | **TV tier:** on a 30 Hz panel class, resident memory stays within the measured TV ceiling, no streaming task exceeds 8 ms, and streamer p95 is ≤ 4 ms | TV bench page | **PENDING device:** 2020-era Android TV Chromium, plus the Tizen/webOS set from SPEC §12 | PENDING — no TV hardware |
| ER-12-15 | The 64×64 editor bake emits `world.json` plus 4,096 cell entries whose declared hashes and byte counts match the payloads; an oversized cell, a missing LOD3, a duplicate key and a hole without the water flag each fail the bake with a named error | `bake-world-64x64` CLI fixture | CI Node 20 | PENDING — depends on spec 17 tooling |

The M3 row is deliberately separated from the M2 rows. A green M2 streamer with a 4,096-cell synthetic world does **not** prove the Vice City ceiling; that needs the M3 slice, its content, and a measured run.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | grid key parse/format, `cellAt`, manifest validation, LOD hysteresis, priority comparator, residency transitions, cancellation, ledger arithmetic, CSTR codec, cache LRU, rolling stats | `packages/engine/streaming/test/*.test.ts` |
| Property (`fast-check`) | generated grids and manifests; URL traversal rejection; random LOD distances produce no thrash; random apply/evict sequences keep the ledger within bounds and never allocate after warm-up; CSTR round-trip; parser fuzz | `packages/engine/streaming/test/property/*.property.test.ts` |
| Golden | manifest error codes, normalized `world.json`, CSTR bytes, fixture state hashes, cell-header rejection codes | `packages/engine/streaming/test/golden/` |
| Integration | fake `CellSource` with seeded latency and a recording sink; runtime adapter over the real dev server, `fetch`, abort and CacheStorage; save/load round-trip through the spec 15 stub | `packages/engine/streaming/test/integration/*.test.ts`, `packages/runtime/test/integration/streamingBoot.test.ts` |
| Benchmark | `update`/apply p95, long tasks, ledger, LOD switches; `window.__STREAM_BENCH__` consumed by the spec 19 harness | `packages/engine/streaming/test/bench/stream-bench.html` |
| Manual | TV memory and frame behaviour, M3 ceiling, visible holes on the city-block drive | `docs/RESULTS.md` rows ER-12-04/13/14 |

Rules:

- Every test title carries its `ER-12-NN` ID, or a leading `// @req ER-12-NN`. An ID must resolve to a traceability row.
- Integration tests bind `127.0.0.1:0` and wait on messages, never fixed sleeps. Package unit tests use fakes and perform no network I/O.
- No test is skipped or weakened to land a wave. Hardware-dependent rows are measured in the browser page and recorded manually; they are never asserted from Node.
- Benchmarks report p50, p95, max, sample count, resident/pending cell counts, browser version, adapter and build hash. A number without those fields is not evidence.
- Determinism tests run the same fixture twice in one process and once with shuffled candidate insertion order; a mismatch names the first differing tick and cell key.
- Fixtures are generated deterministically by `build-world.mjs`; CI compares the checked-in golden rather than regenerating silently.

---

## 9. Dependencies

**Specs and packages**

| Dependency | Why | State |
|---|---|---|
| 00 architecture | package boundary, `WorldCell`/`CellKey`, contract status, determinism scope, jobs and memory rules | Written |
| 01 core loop/time | `FixedLoop`, `EngineFrame`, fixed tick | Written |
| 02 math | `Vec3`, `Quat`, `Aabb3` | Written |
| 03 scene/ECS | static entity insertion, spawn records, stable component storage | written |
| 04 renderer-webgpu / 05 webgl2 | consumes `CellRenderPayload`, owns GPU resources, frustum/occlusion culling | Written |
| 06 assets | `AssetHandle`, `MeshData`, refcounted retention, byte accounting | written |
| 07 physics3d | consumes collision payloads; static bodies at activation | Written |
| 09 audio | consumes audio emitter records | Written |
| 11 ai-navigation | consumes `.navmesh` sections; sim-radius contract | Written alongside this spec |
| 15 save-load | stores the CSTR payload opaquely in `.pps`; the game/runtime supplies the bytes | written |
| 17 editor | bakes `world.json`, validates cell bounds and budgets | Written |
| 19 testing/benchmarks | bench harness and `window.__STREAM_BENCH__` reporting | written |

**Implementation prerequisites**

- `engine-core` exports `EngineRng`, `forkCellRng(worldSeed, cx, cy, stream)`, `forkAgentRng(worldSeed, cx, cy, localId, stream)`, `Aabb3`, `Vec3`, `Quat`, `CellKey` and `WorldCell`. Spec 01 or 00 must own the RNG API; the two stream-id tables are fixed in §5.6.
- `engine-assets` exposes `AssetHandle<T>`, `MeshData`, refcounted retain/release and byte-size reporting. The streamer counts bytes; it never loads or decodes an asset itself.
- The runtime provides a `CellSource` over `fetch` with `AbortSignal`, a `CellCache` over CacheStorage, and a `StreamSink` over scene, physics, navigation and audio.
- `DecompressionStream("gzip")`, `Worker` and `CacheStorage` are available in the target browser; Node tests inject fakes. A missing `DecompressionStream` fails an uncompressed-only tier with `E_STREAM_DECOMPRESS` rather than silently misreading bytes.
- Spec 12 owns `WorldCell` per 00 §5.3; any shape change is a frozen-contract change under 00 §3.1, not an implementation detail.

**Paper-trail prerequisites**

- Add `WORLD_FORMAT_VERSION`, `CELL_FORMAT_VERSION`, `CELL_STATE_FORMAT_VERSION`, `SECTION_VERSION_SPAWN` and `SECTION_VERSION_METADATA` to the version registry in 00 §4.1 in the first implementing change.
- Register ER-12-01..15 in `docs/todos/TRACEABILITY.md` when the engine programme is registered.
- A14 (browser-native engine reframe) must be recorded before any engine package merges (00 preamble).
- The editor bake path (spec 17) must call the streaming validator and hasher in the same change that lands `world.json` writing; a second writer is a contract violation.

**External dependencies:** none. Platform APIs are feature-detected; no third-party runtime package, no WASM, no streaming library.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | A 4,096-cell manifest grows past 512 KiB gzip or parsing hitches at boot | Medium | Boot stalls; FR-9.6 breach | Cap the manifest, split the index per region only under an amendment, parse off the main thread, measure ER-12-12 |
| R2 | The byte ledger drifts from real retained memory | High if unmanaged | Budget breach; TV crashes | Count once per asset id, update synchronously at apply/evict, assert ledger invariants in tests, audit against `AssetLibrary` |
| R3 | Real TV memory is below the provisional desktop numbers | High | Streamed world evicted or crashes on TV | Treat all memory as provisional (PR-11.2), coarsen LODs, reduce the ring, texture tiers; measure E2/TV before any hard fail |
| R4 | Decode or apply blocks the main thread | Medium | Visible hitch; FR-9.10 breach | Worker decode, per-section messages, time-sliced apply, 8 ms cap, coarser stand-in until the payload applies |
| R5 | LOD thrash at a band boundary | Medium | Constant loading; frame churn | Per-band hysteresis validated at load, dead-band tests, `lodBias`; never switch inside the dead band |
| R6 | Fast travel or a camera teleport outruns the streamer | Medium | Holes, falling through the world | Recompute candidates immediately on an 8 m focus move, prefetch along velocity, pin mission cells, apply a low-LOD stand-in rather than block |
| R7 | Residency timing leaks into simulation | High if state lives in loaded payloads | Replay mismatch; save corruption | State store authoritative, activation restores rather than spawns, forced-eviction hash test ER-12-05 |
| R8 | Deploy drift or a missing/partial payload | Medium | Broken cells | Composite content hash, per-section hash, retry backoff 15/30/60 ticks, `cellFailed`, reject the cell as a unit, never partially apply |
| R9 | CacheStorage quota, private mode or eviction | Medium | Cache misses only | Cache is optional; swallow failures; LRU trim; no correctness dependency; measure ER-12-10 |
| R10 | Eight players multiply the visual demand | Medium | Memory blow-up; draw calls | `visualFocusRangeMeters` makes distant players simulation-only; cap focuses at 10; never promote a distant focus above LOD2 |
| R11 | Cell section formats drift from specs 06/07/11 | Medium | Whole cells fail or misparse | `sectionVersion` per section, owner validation, whole-cell rejection, conformance fixtures per section type |
| R12 | `DecompressionStream` is absent on an old TV browser | Low for the named desktop target, Medium on TV | Cells unusable | Feature-detect and fail the tier with `E_STREAM_DECOMPRESS`; ship an uncompressed tier or require a supported browser |
| R13 | Per-cell batch caps still exceed the 120 draw-call budget | Medium | Frame over budget | Frustum and occlusion culling are required (spec 04); coarsen LODs; measure draw calls in ER-12-13 |
| R14 | The simulation ring alone exceeds the byte budget | Medium | Streamer cannot honour both residency and memory | `E_STREAM_SIM_BUDGET`, keep the ring, require the game to reduce `simRadiusMeters`; never evict sim payloads for visuals |
| R15 | `WorldCell.state` projection confuses games | Medium | Games branch on internal states | Document the projection in §3.3, additive state changes only, SDK structural assignability test |
| R16 | Editor bake and runtime disagree about hashes or limits | Medium | Cells fail at load after a bake | One validator and one hasher shared by editor and runtime; bake fails atomically; ER-12-15 |



/**
 * Public contract types for `@lanpad/engine-streaming`, owned by spec 12
 * (`docs/engine/12-world-streaming.md` §3).
 *
 * `CellKey`, `WorldCellId`, `WorldCell` and `CellState` are frozen shapes
 * declared by 00 §3.5/§4.4 in `@lanpad/engine-core`. This module imports them
 * for local use and re-exports them from the package root; it never restates
 * their shape (12 §3: "The streamer re-exports them; it does not redefine
 * them").
 *
 * `AudioEmitterRecord` (spec 09) and `CellEntityRecord` (spec 03) are named by
 * spec 12 §3.5 but their field shapes are owned by those specs. The streamer
 * forwards them opaquely and never reads a field, so they are `unknown` here;
 * this avoids inventing a second definition.
 */

import type { CellKey, Quat, Vec3, WorldCell } from "@lanpad/engine-core";
import type { AssetHandle, MeshData } from "@lanpad/engine-assets";

/** Canonical `"<cx>,<cy>"` cell key and neighbours (00 §3.5/§4.4). */
export type { CellKey, CellState, WorldCell, WorldCellId } from "@lanpad/engine-core";

/** 12 §4.5 version registry: `.cell` container format (owned by `Decode.ts`). */
export const CELL_FORMAT_VERSION = 1;

/** 12 §3.1. */
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

/** 12 §3.1. */
export const STREAMING_DEFAULTS = {
  cellSizeMeters: 64,
  lodBands: [
    { lod: 0, maxDistanceMeters: 96, hysteresisMeters: 8 },
    { lod: 1, maxDistanceMeters: 160, hysteresisMeters: 12 },
    { lod: 2, maxDistanceMeters: 256, hysteresisMeters: 16 },
    { lod: 3, maxDistanceMeters: 384, hysteresisMeters: 24 },
  ],
  simRadiusMeters: 272,
  visualFocusRangeMeters: 400,
  playerGuardMeters: 8,
  decisionIntervalTicks: 6,
  maxConcurrentLoads: 4,
  maxLoadsStartedPerTick: 1,
  retryBackoffTicks: [15, 30, 60] as const,
  streamerTickMs: 2,
  maxTaskMs: 8,
} as const;

/** 12 §3.2. */
export interface LodBand {
  /** 0 = richest. */
  readonly lod: 0 | 1 | 2 | 3;
  /** Strictly ascending across the four bands. */
  readonly maxDistanceMeters: number;
  /** >= 0 and < the gap to the next band. */
  readonly hysteresisMeters: number;
}

/** 12 §3.2. */
export interface StreamingBudgets {
  /** Hard cap across all categories. */
  readonly residentBytes: number;
  /** Subset of residentBytes. */
  readonly textureBytes: number;
  /** Subset of residentBytes. */
  readonly geometryBytes: number;
  /** Collision + navmesh + state. */
  readonly cpuBytes: number;
  readonly maxResidentCells: number;
  readonly maxConcurrentLoads: number;
  readonly maxLoadsStartedPerTick: number;
  readonly decisionIntervalTicks: number;
  readonly streamerTickMs: number;
  readonly maxTaskMs: number;
  /** Best-effort CacheStorage cap; 0 disables. */
  readonly cacheBytes: number;
  readonly cacheEnabled: boolean;
}

/** 12 §3.2. */
export interface CellIndexEntry {
  readonly key: CellKey;
  readonly cx: number;
  readonly cy: number;
  /** One URL per visual LOD, richest first. Empty only when the matching visualBytes is 0. */
  readonly visualUrls: readonly [string, string, string, string];
  /** Collision + nav + static spawn records for the simulation ring. */
  readonly simUrl: string;
  readonly visualBytes: readonly [number, number, number, number];
  readonly simBytes: number;
  readonly contentHash: string;
  readonly hasCollision: boolean;
  readonly hasNav: boolean;
}

/** 12 §3.2. */
export interface WorldConfig {
  readonly formatVersion: 1;
  /** `^[a-z0-9][a-z0-9_-]{0,63}$`. */
  readonly worldId: string;
  /** u32; forks every world RNG stream. */
  readonly seed: number;
  /** 16..512, constant for the world. */
  readonly cellSizeMeters: number;
  /** World position of cell (0,0) corner. */
  readonly origin: Vec3;
  readonly grid: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  };
  /** Exactly 4, lod 0..3. */
  readonly lodBands: readonly LodBand[];
  readonly budgets: StreamingBudgets;
  /** <= 16,384, unique canonical keys. */
  readonly cells: readonly CellIndexEntry[];
}

/** 12 §3.3. */
export interface StreamFocus {
  readonly position: Vec3;
  /** Enables look-ahead. */
  readonly velocity?: Vec3;
  /** 0.25..4, default 1. */
  readonly weight?: number;
}

/** 12 §3.3. */
export interface StreamView {
  /** <= 10 entries. */
  readonly focus: readonly StreamFocus[];
  readonly cameraPosition: Vec3;
  /** XZ, normalized. */
  readonly cameraForward: Vec3;
  /** Default 0.6. */
  readonly cameraHalfFovRad?: number;
}

/** 12 §3.3. */
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
  /** Rolling 120 ticks. */
  readonly streamerTickMsP95: number;
}

/** 12 §3.3. */
export type StreamEvent =
  | {
      readonly type: "cellLoaded";
      readonly key: CellKey;
      readonly lod: 0 | 1 | 2 | 3;
      readonly bytes: number;
    }
  | {
      readonly type: "cellEvicted";
      readonly key: CellKey;
      readonly reason: "distance" | "budget" | "pressure" | "stop";
    }
  | {
      readonly type: "cellFailed";
      readonly key: CellKey;
      readonly attempts: number;
      readonly code: string;
    }
  | {
      readonly type: "pressure";
      readonly stage: 1 | 2 | 3;
      readonly residentBytes: number;
    };

/**
 * Additive diagnostics. 12 §5.7 names `E_STREAM_BUDGET`,
 * `E_STREAM_SIM_BUDGET` and `E_STREAM_PIN_BUDGET`, but the frozen
 * `StreamEvent` union has no variant that can carry an error code, so those
 * conditions are reported through counters here instead of a new event type.
 * Recorded as a spec gap for the owning wave.
 */
export interface StreamDiagnostics {
  readonly budgetBreaches: number;
  readonly simBudgetBreaches: number;
  readonly pinBudgetBreaches: number;
  /** StreamingErrorCode of the first budget breach, or null. */
  readonly lastBudgetCode: string | null;
}

/** 12 §3.3. */
export interface WorldStreamer {
  readonly config: WorldConfig;
  /** Called once per fixed tick, after input polling and before AI/physics. */
  update(tick: number, view: StreamView): void;
  getCell(key: CellKey): WorldCell | undefined;
  /** Cell containing a world XZ position, or undefined outside the grid. */
  cellAt(x: number, z: number): WorldCell | undefined;
  /** Canonical key order; reused snapshot, valid until the next update. */
  readonly resident: readonly WorldCell[];
  pin(key: CellKey): boolean;
  unpin(key: CellKey): void;
  setLodBias(bias: number): void;
  setSimRadius(meters: number): void;
  readonly stateStore: CellStateStore;
  readonly stats: StreamStats;
  on(type: StreamEvent["type"], listener: (event: StreamEvent) => void): () => void;
  stop(): void;
  dispose(): void;
  /** Additive; see `StreamDiagnostics`. */
  readonly diagnostics: StreamDiagnostics;
}

/** 12 §3.4. */
export interface EntityStateRecord {
  /** u32, assigned at bake, unique within a cell. */
  readonly localId: number;
  /** u16, game-defined; 0xFFFF = destroyed. */
  kind: number;
  position: Vec3;
  rotation: Quat;
  /** 4 words, game-defined. */
  readonly state: Uint32Array;
}

/** 12 §3.4. */
export interface CellRuntimeState {
  readonly key: CellKey;
  /** Per-cell RNG counter for deterministic streams (§5.6). */
  readonly rngCursor: number;
  /** 16 words, game-defined. */
  readonly flags: Uint32Array;
  /** Sorted by localId. */
  readonly entities: readonly EntityStateRecord[];
  /** Local ids, sorted. */
  readonly destroyed: readonly number[];
}

/** 12 §3.4. */
export interface CellStateStore {
  get(key: CellKey): CellRuntimeState;
  markDirty(key: CellKey): void;
  /** Canonical key order. */
  readonly dirty: readonly CellKey[];
  clearDirty(): void;
  /** Engine-owned CSTR payload; stored opaquely by the save layer. */
  serialize(keys: readonly CellKey[]): ArrayBuffer;
  /** Validates magic/version/hash/seed; replaces the whole store or throws. */
  restore(bytes: ArrayBuffer): void;
  dispose(): void;
}

/** 12 §3.5. */
export interface CellCache {
  get(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

/** 12 §3.5. */
export interface CellSource {
  /** Must resolve to the exact declared byte length; the streamer validates it. */
  fetchCell(url: string, expectedBytes: number, signal: AbortSignal): Promise<ArrayBuffer>;
  /** Optional; absence disables persistent caching. */
  readonly cache?: CellCache;
}

/** 12 §3.5. */
export interface CellRenderPayload {
  /** Already retained by the streamer. */
  readonly meshHandles: readonly AssetHandle<MeshData>[];
  /** 16 floats per instance. */
  readonly instanceTransforms: Float32Array;
  /** Index into meshHandles. */
  readonly instanceMeshIndex: Uint16Array;
  /** <= 4 at LOD0, <= 2 at LOD1+. */
  readonly batchMaterialIds: readonly string[];
}

/** 12 §3.5, opaque record owned by spec 09. */
export type AudioEmitterRecord = unknown;

/** 12 §3.5, opaque record owned by spec 03. */
export type CellEntityRecord = unknown;

/** 12 §3.5. */
export interface CellContent {
  readonly key: CellKey;
  readonly lod: 0 | 1 | 2 | 3;
  readonly render: CellRenderPayload;
  /** Spec 07 format, sim group only. */
  readonly collisionBytes: ArrayBuffer | null;
  /** Spec 11 `.navmesh`, sim group only. */
  readonly navBytes: ArrayBuffer | null;
  readonly audioEmitters: readonly AudioEmitterRecord[];
  readonly entities: readonly CellEntityRecord[];
}

/** 12 §3.5. */
export interface StreamSink {
  /** Called at a tick boundary; must be synchronous and must not block. */
  onCellActivate(cell: WorldCell, content: CellContent): void;
  onCellDeactivate(key: CellKey): void;
  onCellLodChange(key: CellKey, lod: 0 | 1 | 2 | 3): void;
  onPressure(stage: 1 | 2 | 3, bytesNeeded: number): void;
}

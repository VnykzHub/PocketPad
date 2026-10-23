/**
 * Public surface of `@lanpad/engine-streaming` (spec 12 §5.1).
 *
 * The package exports contracts, validation, planning, accounting, decoding,
 * residency and the `WorldStreamer` factory. It intentionally exports no
 * browser code: the gzip decoder, `CellSource`, `CellCache` and `StreamSink`
 * are supplied by the runtime.
 */

// Contracts. World-cell shapes are canonical in `@lanpad/engine-core` and
// re-exported here (12 §3); the rest of the streaming surface is declared in
// contracts/world.ts.
export type {
  AudioEmitterRecord,
  CellCache,
  CellContent,
  CellEntityRecord,
  CellIndexEntry,
  CellKey,
  CellRenderPayload,
  CellRuntimeState,
  CellSource,
  CellState,
  CellStateStore,
  EntityStateRecord,
  LodBand,
  StreamDiagnostics,
  StreamEvent,
  StreamFocus,
  StreamSink,
  StreamStats,
  StreamView,
  StreamingBudgets,
  WorldCell,
  WorldCellId,
  WorldConfig,
  WorldStreamer,
} from "./contracts/world.js";
export {
  CELL_FORMAT_VERSION,
  STREAMING_DEFAULTS,
  STREAMING_LIMITS,
} from "./contracts/world.js";

// Errors and events.
export type { StreamEventListener, StreamingErrorCode } from "./StreamEvents.js";
export {
  StreamEventBus,
  StreamingError,
  errorCodeOf,
  errorMessageOf,
  isStreamingError,
  streamingError,
} from "./StreamEvents.js";

// Grid and camera-independent geometry.
export type { CellBounds, CellCoord, GridRect } from "./Grid.js";
export {
  CellGrid,
  cellKeyEquals,
  compareCellCoords,
  compareCellKeys,
  formatCellKey,
  isI32,
  parseCellKey,
  sortCellKeys,
  tryParseCellKey,
  unloadDistanceMeters,
} from "./Grid.js";

// LOD selection with hysteresis.
export type { Lod } from "./Lod.js";
export {
  bandAtDistance,
  clampLodBias,
  effectiveMaxDistance,
  selectLod,
  shouldUnload,
  validateLodBands,
} from "./Lod.js";

// Manifest parsing and the world index.
export type { BootBudgetInput, BootBudgetResult, SimPayloadRef, VisualPayloadRef } from "./WorldIndex.js";
export {
  CONTENT_HASH_PATTERN,
  MAX_BOOT_SET_GZIP_BYTES,
  MAX_MANIFEST_GZIP_BYTES,
  SIM_PAYLOAD_BYTE_LIMIT,
  VISUAL_LOD_BYTE_LIMITS,
  WORLD_FORMAT_VERSION,
  WORLD_ID_PATTERN,
  WorldIndex,
  assertBootBudget,
  checkBootBudget,
  parseWorldManifest,
  resolveCellUrl,
  validateRelativeCellUrl,
  validateWorldConfig,
} from "./WorldIndex.js";

// Priority planning.
export type { PriorityCandidate, PriorityClass, PriorityOptions } from "./Priority.js";
export {
  LOOK_AHEAD_MAX_METERS,
  LOOK_AHEAD_SECONDS,
  PriorityPlanner,
  clampFocusWeight,
  comparePriorityCandidates,
  lookAheadPosition,
} from "./Priority.js";

// Byte ledger, pressure and eviction order.
export type {
  CellMemoryBill,
  CellMemoryEntry,
  EvictionCandidate,
  MemoryCategory,
  MemorySnapshot,
  PressureStage,
  SharedAssetUse,
} from "./Memory.js";
export {
  MemoryLedger,
  PRESSURE_RECOVERY_FRACTION,
  PRESSURE_STAGE1_FRACTION,
  PRESSURE_STAGE2_FRACTION,
  comparePressureEviction,
  isPressureRecovered,
  pressureStageOf,
  selectDistanceEvictions,
  selectPressureEvictions,
} from "./Memory.js";

// CSTR state serialization.
export {
  CELL_STATE_FORMAT_VERSION,
  CSTR_CELL_RECORD_BYTES,
  CSTR_ENTITY_RECORD_BYTES,
  CSTR_HEADER_BYTES,
  CSTR_MAGIC,
  CSTR_MAX_ENTITIES_PER_CELL,
  CSTR_MAX_FLAGS,
  CSTR_SPARSE_FLAG,
  WorldStateStore,
} from "./StateStore.js";

// CacheStorage wrapper with an LRU index.
export type { CacheStats, CellCacheStoreOptions } from "./Cache.js";
export { CellCacheStore, LruIndex, buildCacheKey } from "./Cache.js";

// `.cell` decoding.
export type {
  CellAabb,
  CellContainerHeader,
  DecodeCellContext,
  DecodedCell,
  DecodedSection,
  GzipDecoder,
} from "./Decode.js";
export {
  CELL_AABB_TOLERANCE_METERS,
  CELL_CONTAINER_MAGIC,
  CELL_FLAG_GENERATED,
  CELL_FLAG_HAS_AUDIO,
  CELL_FLAG_HAS_COLLISION,
  CELL_FLAG_HAS_NAV,
  CELL_FLAG_HAS_SPAWN,
  CELL_FLAG_WATER_VOID,
  CELL_HEADER_BYTES,
  CELL_MAX_SECTIONS,
  CELL_SECTION_ENTRY_BYTES,
  SECTION_FLAG_GZIP,
  SECTION_TYPE_AUDIO,
  SECTION_TYPE_COLLISION,
  SECTION_TYPE_GAME_MAX,
  SECTION_TYPE_GAME_MIN,
  SECTION_TYPE_MESH,
  SECTION_TYPE_METADATA,
  SECTION_TYPE_NAVMESH,
  SECTION_TYPE_SPAWN,
  SECTION_TYPE_TEXTURE,
  compositeContentHash,
  decodeCell,
} from "./Decode.js";

// Stats.
export type { BudgetBreachCode, EvictionReason, StreamDebugCounters } from "./Stats.js";
export {
  RollingP95,
  STATS_WINDOW_TICKS,
  StreamStatsRecorder,
  freezeStats,
} from "./Stats.js";

// Residency.
export type {
  PayloadKind,
  PayloadMeta,
  PayloadRecord,
  ResidencyLimits,
  ResidencyState,
} from "./Residency.js";
export {
  MAX_LOAD_ATTEMPTS,
  ResidencyTable,
  canTransition,
  payloadId,
  publicCellState,
  retryDelayTicks,
} from "./Residency.js";

// Streamer facade.
export type { PayloadBuilder, PayloadContent, WorldStreamerOptions } from "./World.js";
export { createWorldStreamer, defaultPayloadBuilder } from "./World.js";

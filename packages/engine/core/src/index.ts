/**
 * `@lanpad/engine-core` public entry — W0 contract surface only.
 *
 * This wave exports the frozen contract types from specs 00–04 and the
 * runtime version constants. It contains no loop, math, scene or job
 * algorithms. W1 adds the value exports behind these declarations without
 * changing the declared surface.
 */

export type * from "./contracts/engine.js";
export type {
  EngineFrame,
  FixedLoop,
  FixedLoopOptions,
  PauseReason,
  FrameScheduler,
  FrameStatsView,
  MutableFrameStats,
  HostLoopWiring,
} from "./contracts/time.js";
export type {
  Vec2,
  Vec3,
  Vec4,
  Mat3,
  Mat4,
  Quat,
  Aabb2,
  Aabb3,
  Obb,
  Ray,
  Plane,
  Frustum,
} from "./contracts/math.js";
export type {
  EntityId,
  Entity,
  ComponentType,
  ComponentSpec,
  Scene,
  ComponentColumn,
  SceneStats,
  SceneOptions,
  EngineScene,
  SerializedEntity,
  SceneSnapshot,
  Prefab,
  EntityPoolOptions,
} from "./contracts/scene.js";
export type * from "./contracts/render-device.js";
export type * from "./contracts/save.js";
export type * from "./contracts/world.js";

// W1 implementation values. Types remain contract-owned; where an
// implementation barrel also declares a structurally identical interface,
// the explicit contract export below wins over the star export.
export * from "./math/index.js";
export {
  defineComponent,
  Transform,
  Parent,
  Renderable,
  Name,
  createScene,
  parsePrefab,
  instantiatePrefab,
  EntityPool,
} from "./scene/index.js";
export {
  EngineLoop,
  FrameStatsRing,
  LONG_FRAME_MS,
  OVER_BUDGET_FRAME_MS,
  LoopClock,
  PAUSE_REASON_BITS,
  PAUSE_REASON_COUNT,
  PAUSE_REASON_ORDER,
  PauseReasons,
  HOST_TICK_STEP_IDS,
  runHostTick,
  DEFAULT_MAX_CATCH_UP_STEPS,
  DT_SECONDS,
  TICK_HZ,
} from "./time/index.js";
export {
  JobQueue,
  PRIORITY_NAMES,
  createSyncJobExecutor,
  isJobKind,
  JOB_KINDS,
  isWorkerMessage,
  resultFromWorkerMessage,
  WORKER_PROTOCOL_VERSION,
} from "./jobs/index.js";
export {
  createBrowserScheduler,
  ManualScheduler,
  detectPlatformProfile,
  readPlatformGlobals,
} from "./platform/index.js";
export {
  createSaveHeader,
  decodeSaveFile,
  decodeSaveHeader,
  encodeSaveFile,
  encodeSaveHeader,
  fnv1a32,
  SAVE_DEFAULT_MAX_SLOTS,
  SAVE_FLAG_DEFLATE,
  SAVE_FLAGS_RESERVED_MASK,
  SAVE_FORMAT_VERSION,
  SAVE_GAME_ID_PATTERN,
  SAVE_HEADER_BYTES,
  SAVE_HEADER_MAX_BYTES,
  SAVE_HEADER_PREFIX_BYTES,
  SAVE_MAGIC,
  SAVE_MAX_GAME_ID_BYTES,
  SAVE_MAX_GAME_VERSION_BYTES,
  SAVE_MAX_PAYLOAD_BYTES,
  SAVE_MAX_UNCOMPRESSED_BYTES,
  SAVE_SLOT_ID_PATTERN,
} from "./save/index.js";
export type {
  CreateSaveHeaderInput,
  DecodedSaveFile,
} from "./save/index.js";

export {
  ENGINE_VERSION,
  RENDERER_ABI_VERSION,
  SHADER_ABI_VERSION,
} from "./version.js";

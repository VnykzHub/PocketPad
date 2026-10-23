/**
 * `@lanpad/engine-core` time subtree barrel (spec 01 §5.1).
 *
 * The package entry (`src/index.ts`) is integration-owned. It should export
 * these values explicitly alongside `export type *` from
 * `../contracts/time.js`; the contract declares the same class/function names
 * as types only, so a blanket `export *` from both modules would be ambiguous.
 */
export { EngineLoop } from "./FixedLoop.js";
export {
  FrameStatsRing,
  LONG_FRAME_MS,
  OVER_BUDGET_FRAME_MS,
} from "./FrameStats.js";
export { LoopClock } from "./LoopClock.js";
export {
  PAUSE_REASON_BITS,
  PAUSE_REASON_COUNT,
  PAUSE_REASON_ORDER,
  PauseReasons,
} from "./PauseReasons.js";
export { HOST_TICK_STEP_IDS, runHostTick } from "./HostTick.js";
export type { HostTickStepId, HostTickSteps } from "./HostTick.js";
export {
  DEFAULT_MAX_CATCH_UP_STEPS,
  DT_SECONDS,
  TICK_HZ,
} from "./types.js";

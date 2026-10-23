/**
 * Time-domain types and constants (spec 01 §3).
 *
 * The authoritative declarations are frozen in `../contracts/time.d.ts`; this
 * module re-exports them for the `time/` subtree and owns the constants the
 * accumulator arithmetic needs. It names no browser global.
 */
export type {
  EngineFrame,
  FixedLoop,
  FixedLoopOptions,
  FrameScheduler,
  FrameStatsView,
  HostLoopWiring,
  MutableFrameStats,
  PauseReason,
} from "../contracts/time.js";

/** Simulation rate fixed by 00 §3.1 and 01 §2. M0 is exactly 60 Hz. */
export const TICK_HZ = 60;

/** One fixed simulation step in seconds. */
export const DT_SECONDS = 1 / TICK_HZ;

/** Default death-spiral clamp (01 §3.2): five steps, ~83.3 ms. */
export const DEFAULT_MAX_CATCH_UP_STEPS = 5;

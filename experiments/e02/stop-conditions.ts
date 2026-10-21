/**
 * Pure stop-condition logic for the E2 memory ceiling probe (D1-EXP-03).
 *
 * The page in `probe.ts` owns the destructive work (allocating typed arrays and
 * WebGL textures). This module owns only the decisions, so the rules from
 * SPEC section 20 (E2) and PR-11.2 can be tested in Node without touching a
 * browser or allocating gigabytes:
 *
 * - allocate in fixed steps and benchmark a fixed number of rAF frames;
 * - treat a step as slow when its p95 frame time exceeds 3x the baseline;
 * - stop after two consecutive slow steps;
 * - never count a slow or failed step as stable;
 * - stop safe mode at a fixed cap;
 * - derive budgets at 70% of the measured stable limit.
 *
 * No DOM, timer or network dependency lives here.
 */

export const BYTES_PER_MB = 1024 * 1024;

/** E2 allocates JS heap in 32 MB blocks. */
export const JS_BLOCK_BYTES = 32 * BYTES_PER_MB;

/** Safe mode cap, applied separately to the JS heap and texture phases. */
export const SAFE_LIMIT_BYTES = 512 * BYTES_PER_MB;

/** Fixed rAF benchmark length between allocation steps. */
export const BENCHMARK_FRAME_COUNT = 60;

/** A step is slow when its p95 frame time exceeds this multiple of baseline. */
export const SLOWDOWN_FACTOR = 3;

/** Consecutive slow steps required before the probe stops. */
export const SLOW_STEPS_TO_STOP = 2;

/** E2 texture allocations are 1024x1024 RGBA8. */
export const TEXTURE_SIZE = 1024;
export const TEXTURE_BYTES = TEXTURE_SIZE * TEXTURE_SIZE * 4;

/** Textures allocated per step (16 MB per step at 4 bytes per pixel). */
export const TEXTURES_PER_STEP = 4;

/** PR-11.2: budgets use 70% of the measured stable limit, never the crash point. */
export const BUDGET_PERCENT = 70;

export type StopReason =
  | "allocation-throw"
  | "frame-slowdown"
  | "safe-limit"
  | "user-stop"
  | "webgl-context-lost"
  | "webgl-out-of-memory"
  | "webgl-error";

export interface FrameStats {
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  maxMs: number;
}

/**
 * Nearest-rank percentile. An empty sample set reads as 0 so a page can still
 * render a result instead of throwing; the page separately rejects a baseline
 * with too few frames.
 */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const clamped = Math.min(1, Math.max(0, fraction));
  const rank = Math.ceil(clamped * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index] ?? 0;
}

export function summarizeFrameTimes(samples: readonly number[]): FrameStats {
  if (samples.length === 0) {
    return { sampleCount: 0, p50Ms: 0, p95Ms: 0, meanMs: 0, maxMs: 0 };
  }
  let total = 0;
  let maxMs = samples[0] ?? 0;
  for (const sample of samples) {
    total += sample;
    if (sample > maxMs) maxMs = sample;
  }
  return {
    sampleCount: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    meanMs: total / samples.length,
    maxMs,
  };
}

export interface StepInput {
  /** Frame deltas from the fixed benchmark run after this allocation. */
  frameSamplesMs: readonly number[];
  /** Baseline frame time in ms (p50 of the pre-allocation benchmark). */
  baselineFrameMs: number;
  /** Total bytes allocated for this phase after this step. */
  allocatedBytes: number;
  /** Stable bytes from the previous step; a slow step never advances it. */
  previousStableBytes: number;
  /** Slow-step streak before this step. */
  consecutiveSlowSteps: number;
  safeMode: boolean;
}

export interface StepDecision {
  frame: FrameStats;
  /** True when p95 exceeded `SLOWDOWN_FACTOR` times the baseline. */
  slow: boolean;
  /** Slow-step streak including this step; a stable step resets it to 0. */
  consecutiveSlowSteps: number;
  /** Last stable allocation after this step. */
  stableBytes: number;
  /** Non-null when this step ends the phase. */
  stopReason: StopReason | null;
}

/**
 * Applies the E2 stop rules to one allocation step.
 *
 * Precedence: a confirmed slowdown stops before the safe-limit check, so the
 * report names the instability rather than the cap. A step that is slow is
 * never recorded as stable; the last stable step is the last one before the
 * slow streak began.
 */
export function evaluateStep(input: StepInput): StepDecision {
  const frame = summarizeFrameTimes(input.frameSamplesMs);
  const slow =
    input.baselineFrameMs > 0 &&
    frame.p95Ms > input.baselineFrameMs * SLOWDOWN_FACTOR;
  const consecutiveSlowSteps = slow ? input.consecutiveSlowSteps + 1 : 0;
  const stableBytes = slow ? input.previousStableBytes : input.allocatedBytes;

  let stopReason: StopReason | null = null;
  if (consecutiveSlowSteps >= SLOW_STEPS_TO_STOP) {
    stopReason = "frame-slowdown";
  } else if (input.safeMode && input.allocatedBytes >= SAFE_LIMIT_BYTES) {
    stopReason = "safe-limit";
  }

  return { frame, slow, consecutiveSlowSteps, stableBytes, stopReason };
}

export interface FailedStep {
  stopReason: StopReason;
  /** Never the failed step: the last step that completed stably. */
  stableBytes: number;
  /** Bytes the failed step attempted, including any partial allocation. */
  attemptedBytes: number;
}

/**
 * A failed step (allocation throw, WebGL context loss, GL error) ends the
 * phase without advancing the stable value. Keeping this in one place makes
 * the "never report the crash point" rule testable.
 */
export function recordFailedStep(
  stopReason: StopReason,
  previousStableBytes: number,
  attemptedBytes: number,
): FailedStep {
  return { stopReason, stableBytes: previousStableBytes, attemptedBytes };
}

/** Bytes reserved by `count` 1024x1024 RGBA8 textures. */
export function textureAllocationBytes(count: number): number {
  return count * TEXTURE_BYTES;
}

/** Estimated memory ceiling for one run: stable JS heap plus stable textures. */
export function totalStableBytes(jsStableBytes: number, textureStableBytes: number): number {
  return jsStableBytes + textureStableBytes;
}

/**
 * PR-11.2 budget rule: 70% of a measured stable limit, truncated to whole MB.
 * Whole megabytes keep the probe readout and `docs/BUDGETS.md` in agreement.
 */
export function budget70PercentMb(stableMb: number): number {
  return Math.floor((stableMb * BUDGET_PERCENT) / 100);
}

/** Bytes to MB without rounding, so callers can format consistently. */
export function bytesToMb(bytes: number): number {
  return bytes / BYTES_PER_MB;
}

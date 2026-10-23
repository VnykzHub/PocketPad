/**
 * Fixed-capacity frame statistics ring (spec 01 §3.5).
 *
 * The frame path only writes into preallocated typed arrays and bumps
 * counters. Percentiles are computed lazily in `snapshot()` at most once per
 * recorded frame, using a preallocated scratch array and an in-place insertion
 * sort (default ring n = 240). `snapshot()` writes into the caller-owned
 * object and returns it, so the loop hands subscribers one reused view.
 */
import type { FrameStatsView, MutableFrameStats } from "../contracts/time.js";

/** Display target from spec 16; a frame above this is "long". */
export const LONG_FRAME_MS = 16.7;
/** SPEC hard-fail threshold from spec 16. */
export const OVER_BUDGET_FRAME_MS = 20;

const DEFAULT_CAPACITY = 240;
const MIN_CAPACITY = 8;

/** Nearest-rank index for `p` in [0, 1], clamped to `[0, n - 1]`. */
function nearestRankIndex(sampleCount: number, percentile: number): number {
  const index = Math.ceil(percentile * sampleCount) - 1;
  if (index < 0) {
    return 0;
  }
  if (index >= sampleCount) {
    return sampleCount - 1;
  }
  return index;
}

/** In-place insertion sort of `scratch[0..count)`. No allocation. */
function insertionSort(scratch: Float64Array, count: number): void {
  for (let index = 1; index < count; index += 1) {
    const value = scratch[index] ?? 0;
    let position = index - 1;
    while (position >= 0 && (scratch[position] ?? 0) > value) {
      scratch[position + 1] = scratch[position] ?? 0;
      position -= 1;
    }
    scratch[position + 1] = value;
  }
}

export class FrameStatsRing {
  /** Fixed number of retained samples; at least 8. */
  readonly capacity: number;

  private readonly frameMsRing: Float64Array;
  private readonly workMsRing: Float64Array;
  private readonly simTicksRing: Int32Array;
  private readonly alphaRing: Float64Array;
  private readonly tickRing: Float64Array;
  private readonly scratch: Float64Array;

  private head = 0;
  private count = 0;
  private frames = 0;
  private longFrames = 0;
  private overBudgetFrames = 0;

  private lastFrameMs = 0;
  private lastWorkMs = 0;
  private lastSimTicks = 0;
  private lastAlpha = 0;
  private lastTick = 0;

  private percentilesDirty = true;
  private percentileP50 = 0;
  private percentileP95 = 0;
  private maximumFrameMs = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new RangeError("FrameStatsRing capacity must be a positive finite number");
    }
    this.capacity = Math.max(MIN_CAPACITY, Math.floor(capacity));
    this.frameMsRing = new Float64Array(this.capacity);
    this.workMsRing = new Float64Array(this.capacity);
    this.simTicksRing = new Int32Array(this.capacity);
    this.alphaRing = new Float64Array(this.capacity);
    this.tickRing = new Float64Array(this.capacity);
    this.scratch = new Float64Array(this.capacity);
  }

  record(
    frameMs: number,
    workMs: number,
    simTicks: number,
    alpha: number,
    tick: number,
  ): void {
    const measuredFrameMs = Number.isFinite(frameMs) && frameMs > 0 ? frameMs : 0;
    const measuredWorkMs = Number.isFinite(workMs) && workMs > 0 ? workMs : 0;
    const measuredAlpha = Number.isFinite(alpha) && alpha > 0 ? alpha : 0;
    const measuredTick = Number.isFinite(tick) ? tick : 0;
    const measuredSteps = Number.isFinite(simTicks) ? Math.trunc(simTicks) : 0;

    this.frameMsRing[this.head] = measuredFrameMs;
    this.workMsRing[this.head] = measuredWorkMs;
    this.simTicksRing[this.head] = measuredSteps;
    this.alphaRing[this.head] = measuredAlpha;
    this.tickRing[this.head] = measuredTick;

    this.head += 1;
    if (this.head >= this.capacity) {
      this.head = 0;
    }
    if (this.count < this.capacity) {
      this.count += 1;
    }

    this.frames += 1;
    if (measuredFrameMs > LONG_FRAME_MS) {
      this.longFrames += 1;
    }
    if (measuredFrameMs > OVER_BUDGET_FRAME_MS) {
      this.overBudgetFrames += 1;
    }

    this.lastFrameMs = measuredFrameMs;
    this.lastWorkMs = measuredWorkMs;
    this.lastSimTicks = measuredSteps;
    this.lastAlpha = measuredAlpha;
    this.lastTick = measuredTick;
    this.percentilesDirty = true;
  }

  /** Writes into a caller-owned object; allocates nothing after construction. */
  snapshot(out: MutableFrameStats): FrameStatsView {
    if (this.percentilesDirty) {
      this.computePercentiles();
    }

    out.frameMs = this.lastFrameMs;
    out.workMs = this.lastWorkMs;
    out.simTicks = this.lastSimTicks;
    out.alpha = this.lastAlpha;
    out.tick = this.lastTick;
    out.frames = this.frames;
    out.longFrames = this.longFrames;
    out.overBudgetFrames = this.overBudgetFrames;
    out.p50FrameMs = this.percentileP50;
    out.p95FrameMs = this.percentileP95;
    out.maxFrameMs = this.maximumFrameMs;
    return out;
  }

  /** Clears samples and counters (resume / backend switch). */
  reset(): void {
    this.head = 0;
    this.count = 0;
    this.frames = 0;
    this.longFrames = 0;
    this.overBudgetFrames = 0;
    this.lastFrameMs = 0;
    this.lastWorkMs = 0;
    this.lastSimTicks = 0;
    this.lastAlpha = 0;
    this.lastTick = 0;
    this.percentilesDirty = true;
    this.percentileP50 = 0;
    this.percentileP95 = 0;
    this.maximumFrameMs = 0;
  }

  private computePercentiles(): void {
    const sampleCount = this.count;
    if (sampleCount === 0) {
      this.percentileP50 = 0;
      this.percentileP95 = 0;
      this.maximumFrameMs = 0;
      this.percentilesDirty = false;
      return;
    }

    for (let index = 0; index < sampleCount; index += 1) {
      this.scratch[index] = this.frameMsRing[index] ?? 0;
    }
    insertionSort(this.scratch, sampleCount);

    this.maximumFrameMs = this.scratch[sampleCount - 1] ?? 0;
    this.percentileP50 = this.scratch[nearestRankIndex(sampleCount, 0.5)] ?? 0;
    this.percentileP95 = this.scratch[nearestRankIndex(sampleCount, 0.95)] ?? 0;
    this.percentilesDirty = false;
  }
}

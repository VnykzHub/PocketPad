/**
 * `StreamStats`, the rolling 120-tick p95 and debug counters (spec 12 §3.3,
 * §5.9, `src/Stats.ts`).
 *
 * `stats` returns one preallocated record: reading it allocates nothing,
 * which is what 12 §5.10 requires. The p95 is computed on read from a fixed
 * ring using an in-place selection on a scratch array, so a debug overlay can
 * poll it every frame without creating garbage.
 *
 * The streamer never calls `performance.now()` itself. `recordTick` accepts a
 * duration supplied by the caller's debug clock; without one the p95 stays 0,
 * which is reported honestly rather than guessed.
 */

import type { StreamStats } from "./contracts/world.js";
import type { PressureStage } from "./Memory.js";
import { streamingError } from "./StreamEvents.js";
import type { Lod } from "./Lod.js";

/** 12 §5.10: "Stats rolling window is 120 ticks". */
export const STATS_WINDOW_TICKS = 120;

/**
 * Rolling window over a fixed ring. `p95()` is the smallest value with at
 * least 95% of the samples at or below it (index `ceil(0.95 n) - 1` of the
 * sorted window), matching the bench convention in 12 §7.
 */
export class RollingP95 {
  readonly window: number;
  private readonly samples: Float64Array;
  private readonly scratch: Float64Array;
  private cursor = 0;
  private filled = 0;

  constructor(window: number = STATS_WINDOW_TICKS) {
    if (!Number.isInteger(window) || window <= 0) {
      throw streamingError("E_STREAM_STATE", "rolling window must be a positive integer");
    }
    this.window = window;
    this.samples = new Float64Array(window);
    this.scratch = new Float64Array(window);
  }

  /** Number of samples currently in the window. */
  get count(): number {
    return this.filled;
  }

  push(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw streamingError("E_STREAM_STATE", "tick duration must be finite and >= 0");
    }
    this.samples[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.window;
    if (this.filled < this.window) this.filled += 1;
  }

  /** 0 when the window is empty. Does not mutate the ring. */
  p95(): number {
    if (this.filled === 0) return 0;
    const scratch = this.scratch;
    for (let index = 0; index < this.filled; index += 1) {
      scratch[index] = this.samples[index] ?? 0;
    }
    const k = Math.max(0, Math.ceil(0.95 * this.filled) - 1);
    return selectInPlace(scratch, 0, this.filled - 1, k);
  }

  /** Largest sample in the window; 0 when empty. */
  max(): number {
    let max = 0;
    for (let index = 0; index < this.filled; index += 1) {
      const value = this.samples[index] ?? 0;
      if (value > max) max = value;
    }
    return max;
  }

  reset(): void {
    this.cursor = 0;
    this.filled = 0;
  }
}

/**
 * Quickselect on `values[low..high]`; returns the k-th smallest. Deterministic
 * (last element pivot) and allocation-free.
 */
function selectInPlace(values: Float64Array, low: number, high: number, k: number): number {
  let left = low;
  let right = high;
  while (left < right) {
    const pivot = values[right] ?? 0;
    let store = left;
    for (let index = left; index < right; index += 1) {
      const value = values[index] ?? 0;
      if (value < pivot) {
        values[index] = values[store] ?? 0;
        values[store] = value;
        store += 1;
      }
    }
    values[right] = values[store] ?? 0;
    values[store] = pivot;
    if (store === k) return pivot;
    if (k < store) {
      right = store - 1;
    } else {
      left = store + 1;
    }
  }
  return values[left] ?? 0;
}

/**
 * Debug-only counters. They mirror the diagnostics request in 12 §5.9 and are
 * not part of `StreamStats` because that shape is frozen by the spec.
 */
export interface StreamDebugCounters {
  ticks: number;
  decisions: number;
  candidatesConsidered: number;
  loadsStarted: number;
  retries: number;
  cancels: number;
  evictionsDistance: number;
  evictionsBudget: number;
  evictionsPressure: number;
  evictionsStop: number;
  lodPromotions: number;
  lodDemotions: number;
  budgetBreaches: number;
  simBudgetBreaches: number;
  pinBudgetBreaches: number;
  applyFailures: number;
  /** Most recent `E_STREAM_*_BUDGET` code, or null. */
  lastBudgetCode: BudgetBreachCode | null;
}

export type EvictionReason = "distance" | "budget" | "pressure" | "stop";
export type BudgetBreachCode =
  | "E_STREAM_BUDGET"
  | "E_STREAM_SIM_BUDGET"
  | "E_STREAM_PIN_BUDGET";

/**
 * One recorder per streamer. Gauges are overwritten each update; cumulative
 * counters only grow until `reset`.
 */
export class StreamStatsRecorder {
  residentCells = 0;
  pendingLoads = 0;
  queuedCells = 0;
  failedCells = 0;
  residentBytes = 0;
  textureBytes = 0;
  geometryBytes = 0;
  cpuBytes = 0;
  loadsCompleted = 0;
  loadsCancelled = 0;
  loadsFailed = 0;
  evictions = 0;
  lodSwitches = 0;
  pressureStage: PressureStage = 0;

  private readonly rolling = new RollingP95(STATS_WINDOW_TICKS);
  readonly debug: StreamDebugCounters = {
    ticks: 0,
    decisions: 0,
    candidatesConsidered: 0,
    loadsStarted: 0,
    retries: 0,
    cancels: 0,
    evictionsDistance: 0,
    evictionsBudget: 0,
    evictionsPressure: 0,
    evictionsStop: 0,
    lodPromotions: 0,
    lodDemotions: 0,
    budgetBreaches: 0,
    simBudgetBreaches: 0,
    pinBudgetBreaches: 0,
    applyFailures: 0,
    lastBudgetCode: null,
  };

  /** 12 §3.3: p95 over the last 120 tick durations. */
  get streamerTickMsP95(): number {
    return this.rolling.p95();
  }

  /** The reused `StreamStats` record; valid until the next mutation. */
  get stats(): StreamStats {
    return this;
  }

  get rollingWindow(): RollingP95 {
    return this.rolling;
  }

  /** Called once per `update`; `durationMs` comes from the debug clock. */
  recordTick(durationMs: number): void {
    this.debug.ticks += 1;
    this.rolling.push(durationMs);
  }

  setResidency(
    resident: number,
    pending: number,
    queued: number,
    failed: number,
  ): void {
    this.residentCells = requireCount(resident, "residentCells");
    this.pendingLoads = requireCount(pending, "pendingLoads");
    this.queuedCells = requireCount(queued, "queuedCells");
    this.failedCells = requireCount(failed, "failedCells");
  }

  setMemory(
    snapshot: {
      readonly residentBytes: number;
      readonly textureBytes: number;
      readonly geometryBytes: number;
      readonly cpuBytes: number;
    },
    stage: PressureStage,
  ): void {
    this.residentBytes = requireCount(snapshot.residentBytes, "residentBytes");
    this.textureBytes = requireCount(snapshot.textureBytes, "textureBytes");
    this.geometryBytes = requireCount(snapshot.geometryBytes, "geometryBytes");
    this.cpuBytes = requireCount(snapshot.cpuBytes, "cpuBytes");
    this.setPressureStage(stage);
  }

  setPressureStage(stage: PressureStage): void {
    if (stage !== 0 && stage !== 1 && stage !== 2 && stage !== 3) {
      throw streamingError("E_STREAM_STATE", "pressure stage must be 0..3");
    }
    this.pressureStage = stage;
  }

  recordDecision(candidates: number): void {
    this.debug.decisions += 1;
    this.debug.candidatesConsidered += requireCount(candidates, "candidates");
  }

  recordLoadStarted(): void {
    this.debug.loadsStarted += 1;
  }

  recordLoadCompleted(): void {
    this.loadsCompleted += 1;
  }

  recordLoadCancelled(): void {
    this.loadsCancelled += 1;
    this.debug.cancels += 1;
  }

  recordLoadFailed(): void {
    this.loadsFailed += 1;
  }

  recordRetry(): void {
    this.debug.retries += 1;
  }

  recordApplyFailure(): void {
    this.debug.applyFailures += 1;
  }

  recordEviction(reason: EvictionReason): void {
    this.evictions += 1;
    if (reason === "distance") this.debug.evictionsDistance += 1;
    else if (reason === "budget") this.debug.evictionsBudget += 1;
    else if (reason === "pressure") this.debug.evictionsPressure += 1;
    else this.debug.evictionsStop += 1;
  }

  /** `previous` is undefined when the cell was never resident. */
  recordLodChange(previous: Lod | undefined, next: Lod): void {
    if (previous === next) return;
    this.lodSwitches += 1;
    if (previous !== undefined) {
      if (next < previous) this.debug.lodPromotions += 1;
      else this.debug.lodDemotions += 1;
    }
  }

  recordBudgetBreach(code: BudgetBreachCode): void {
    this.debug.budgetBreaches += 1;
    if (code === "E_STREAM_SIM_BUDGET") this.debug.simBudgetBreaches += 1;
    else if (code === "E_STREAM_PIN_BUDGET") this.debug.pinBudgetBreaches += 1;
    this.debug.lastBudgetCode = code;
  }

  reset(): void {
    this.residentCells = 0;
    this.pendingLoads = 0;
    this.queuedCells = 0;
    this.failedCells = 0;
    this.residentBytes = 0;
    this.textureBytes = 0;
    this.geometryBytes = 0;
    this.cpuBytes = 0;
    this.loadsCompleted = 0;
    this.loadsCancelled = 0;
    this.loadsFailed = 0;
    this.evictions = 0;
    this.lodSwitches = 0;
    this.pressureStage = 0;
    this.rolling.reset();
    this.debug.ticks = 0;
    this.debug.decisions = 0;
    this.debug.candidatesConsidered = 0;
    this.debug.loadsStarted = 0;
    this.debug.retries = 0;
    this.debug.cancels = 0;
    this.debug.evictionsDistance = 0;
    this.debug.evictionsBudget = 0;
    this.debug.evictionsPressure = 0;
    this.debug.evictionsStop = 0;
    this.debug.lodPromotions = 0;
    this.debug.lodDemotions = 0;
    this.debug.budgetBreaches = 0;
    this.debug.simBudgetBreaches = 0;
    this.debug.pinBudgetBreaches = 0;
    this.debug.applyFailures = 0;
    this.debug.lastBudgetCode = null;
  }
}

/** Allocation on purpose: for tests, logs and the bench page only. */
export function freezeStats(stats: StreamStats): StreamStats {
  return {
    residentCells: stats.residentCells,
    pendingLoads: stats.pendingLoads,
    queuedCells: stats.queuedCells,
    failedCells: stats.failedCells,
    residentBytes: stats.residentBytes,
    textureBytes: stats.textureBytes,
    geometryBytes: stats.geometryBytes,
    cpuBytes: stats.cpuBytes,
    loadsCompleted: stats.loadsCompleted,
    loadsCancelled: stats.loadsCancelled,
    loadsFailed: stats.loadsFailed,
    evictions: stats.evictions,
    lodSwitches: stats.lodSwitches,
    pressureStage: stats.pressureStage,
    streamerTickMsP95: stats.streamerTickMsP95,
  };
}

function requireCount(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw streamingError("E_STREAM_STATE", `${what} must be finite and >= 0`);
  }
  return value;
}

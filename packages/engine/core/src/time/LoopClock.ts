/**
 * Fixed-step accumulator arithmetic (spec 01 §3.3).
 *
 * Pure, scheduler-free and deterministic: the caller feeds wall-clock
 * milliseconds and consumes the returned steps. It never reads a clock, so the
 * loop and the property tests share exactly one implementation of the rules.
 *
 * Normative rule set (01 §3.3):
 * 1. `dt = 1 / tickHz` (60 Hz in M0).
 * 2. The accumulator clamps to `maxCatchUpSteps * dt`.
 * 3. `reset(nowMs)` discards accumulated time and re-baselines.
 * 4. Only positive finite deltas contribute; a backwards clock adds nothing.
 * 5. Step count is `floor(accumulator / dt)`, capped at `maxCatchUpSteps`.
 * 6. `alpha` is `accumulator / dt` in [0, 1), zero while paused.
 * 7. `tick` starts at 0 and increments once per `consumeStep()`.
 */
export class LoopClock {
  readonly dt: number;

  /** Death-spiral clamp in fixed steps. */
  readonly maxCatchUpSteps: number;

  private readonly maxAccumulatedSeconds: number;
  private accumulator = 0;
  private tickValue = 0;
  private lastMs = Number.NaN;

  constructor(dtSeconds: number, maxCatchUpSteps: number) {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      throw new RangeError("LoopClock dt must be a positive finite number of seconds");
    }
    if (!Number.isInteger(maxCatchUpSteps) || maxCatchUpSteps < 1) {
      throw new RangeError("LoopClock maxCatchUpSteps must be a positive integer");
    }
    this.dt = dtSeconds;
    this.maxCatchUpSteps = maxCatchUpSteps;
    this.maxAccumulatedSeconds = dtSeconds * maxCatchUpSteps;
  }

  /** Discards accumulated time and re-baselines the wall clock. */
  reset(nowMs: number): void {
    this.lastMs = nowMs;
    this.accumulator = 0;
  }

  /**
   * Adds one frame interval and returns the fixed steps to run, `0..max`.
   * Non-finite or non-positive deltas contribute zero. The first call after
   * construction (no `reset`) only establishes the baseline.
   */
  beginFrame(nowMs: number): number {
    const previousMs = this.lastMs;
    this.lastMs = nowMs;

    if (!Number.isFinite(previousMs)) {
      return 0;
    }

    const deltaMs = nowMs - previousMs;
    if (Number.isFinite(deltaMs) && deltaMs > 0) {
      this.accumulator += deltaMs / 1000;
    }

    if (this.accumulator > this.maxAccumulatedSeconds) {
      this.accumulator = this.maxAccumulatedSeconds;
    } else if (this.accumulator < 0) {
      this.accumulator = 0;
    }

    let steps = Math.floor(this.accumulator / this.dt);
    if (steps > this.maxCatchUpSteps) {
      steps = this.maxCatchUpSteps;
    }
    if (steps < 0) {
      steps = 0;
    }
    return steps;
  }

  /** Consumes one step: `tick += 1`, `accumulator -= dt`. */
  consumeStep(): void {
    if (this.accumulator > 0) {
      this.accumulator -= this.dt;
      if (this.accumulator < 0) {
        this.accumulator = 0;
      }
    }
    this.tickValue += 1;
  }

  /**
   * `accumulator / dt` in [0, 1); zero while paused. A ratio within one
   * `Number.EPSILON` of 1 is reported as 0 and its remainder is carried, so
   * floating-point drift can never hand a renderer `alpha === 1`.
   */
  alpha(paused: boolean): number {
    if (paused) {
      return 0;
    }
    const ratio = this.accumulator / this.dt;
    if (!(ratio > 0) || ratio >= 1 - Number.EPSILON) {
      return 0;
    }
    return ratio;
  }

  get tick(): number {
    return this.tickValue;
  }

  get accumulatorSeconds(): number {
    return this.accumulator;
  }
}

/**
 * Dynamic render-resolution controller (D3-RT-07, FR-9.5).
 *
 * The controller watches frame time and moves the render scale in documented
 * steps. It never touches simulation: the fixed loop keeps ticking at 60 Hz
 * and only the renderer's backing store changes.
 *
 * Rules, all fed from `budgets.ts` (which mirrors `docs/BUDGETS.md`):
 *
 * - more than 20 ms for 30 consecutive frames -> scale -10%; repeat per window
 *   until the 60% floor;
 * - under 12 ms for 120 consecutive frames -> scale +5%; repeat per window
 *   until 100%;
 * - frames between the two thresholds reset both streaks (hysteresis), so a
 *   noisy 15/25 ms sequence cannot oscillate.
 *
 * "No silent quality jumps" is a property of this module:
 *
 * - changes only happen at the documented window boundaries and only by one
 *   documented step (never a snap to the floor or ceiling);
 * - every change increments a counter, records the reason and is delivered to
 *   the optional `onChange` sink, so the overlay and telemetry can show it;
 * - a suspended controller (context loss, tab hidden) keeps its scale and
 *   discards invalid samples; `resume()` resets the streaks so stale frames
 *   cannot trigger a step after recovery.
 *
 * `sample()` allocates nothing on the common path; a `ResolutionChange` object
 * is allocated only when the scale actually changes (at most a handful of
 * times per session).
 */
import {
  FAST_FRAME_COUNT,
  FAST_FRAME_MS,
  RENDER_SCALE_CEILING_PERCENT,
  RENDER_SCALE_FLOOR_PERCENT,
  SCALE_DROP_STEP_PERCENT,
  SCALE_RISE_STEP_PERCENT,
  SLOW_FRAME_COUNT,
  SLOW_FRAME_MS,
} from "./budgets.js";

export type ResolutionChangeReason = "slow-frames" | "fast-frames";
export type ResolutionReason = ResolutionChangeReason | "context-restored" | "initial";
export type ResolutionState = "active" | "suspended";

/** Injectable thresholds; defaults are the D3-RT-07/DOCS values. */
export interface ResolutionThresholds {
  readonly slowFrameMs: number;
  readonly slowFrameCount: number;
  readonly dropStepPercent: number;
  readonly floorPercent: number;
  readonly fastFrameMs: number;
  readonly fastFrameCount: number;
  readonly riseStepPercent: number;
  readonly ceilingPercent: number;
}

export const DEFAULT_RESOLUTION_THRESHOLDS: ResolutionThresholds = Object.freeze({
  slowFrameMs: SLOW_FRAME_MS,
  slowFrameCount: SLOW_FRAME_COUNT,
  dropStepPercent: SCALE_DROP_STEP_PERCENT,
  floorPercent: RENDER_SCALE_FLOOR_PERCENT,
  fastFrameMs: FAST_FRAME_MS,
  fastFrameCount: FAST_FRAME_COUNT,
  riseStepPercent: SCALE_RISE_STEP_PERCENT,
  ceilingPercent: RENDER_SCALE_CEILING_PERCENT,
});

/** A reported quality change. Always one documented step in one direction. */
export interface ResolutionChange {
  /** 1-based change number; monotonic for the controller's lifetime. */
  readonly sequence: number;
  readonly previousPercent: number;
  readonly percent: number;
  readonly previousScale: number;
  readonly scale: number;
  readonly reason: ResolutionChangeReason;
  /** Frames sampled when the change happened. */
  readonly frame: number;
}

export interface ResolutionControllerOptions {
  readonly thresholds?: Partial<ResolutionThresholds>;
  /** Called only when the scale changes (rare); not on every frame. */
  readonly onChange?: (change: ResolutionChange) => void;
  /** Starting percent, clamped to the configured range. Defaults to 100. */
  readonly initialPercent?: number;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

function resolveThresholds(
  overrides: Partial<ResolutionThresholds> | undefined,
): ResolutionThresholds {
  const thresholds: ResolutionThresholds = {
    slowFrameMs: requirePositive(
      overrides?.slowFrameMs ?? DEFAULT_RESOLUTION_THRESHOLDS.slowFrameMs,
      "slowFrameMs",
    ),
    slowFrameCount: requirePositiveInteger(
      overrides?.slowFrameCount ?? DEFAULT_RESOLUTION_THRESHOLDS.slowFrameCount,
      "slowFrameCount",
    ),
    dropStepPercent: requirePositiveInteger(
      overrides?.dropStepPercent ?? DEFAULT_RESOLUTION_THRESHOLDS.dropStepPercent,
      "dropStepPercent",
    ),
    floorPercent: overrides?.floorPercent ?? DEFAULT_RESOLUTION_THRESHOLDS.floorPercent,
    fastFrameMs: requirePositive(
      overrides?.fastFrameMs ?? DEFAULT_RESOLUTION_THRESHOLDS.fastFrameMs,
      "fastFrameMs",
    ),
    fastFrameCount: requirePositiveInteger(
      overrides?.fastFrameCount ?? DEFAULT_RESOLUTION_THRESHOLDS.fastFrameCount,
      "fastFrameCount",
    ),
    riseStepPercent: requirePositiveInteger(
      overrides?.riseStepPercent ?? DEFAULT_RESOLUTION_THRESHOLDS.riseStepPercent,
      "riseStepPercent",
    ),
    ceilingPercent: overrides?.ceilingPercent ?? DEFAULT_RESOLUTION_THRESHOLDS.ceilingPercent,
  };

  if (!(thresholds.fastFrameMs < thresholds.slowFrameMs)) {
    throw new RangeError("fastFrameMs must be below slowFrameMs (hysteresis).");
  }
  if (
    !Number.isFinite(thresholds.floorPercent) ||
    !Number.isFinite(thresholds.ceilingPercent) ||
    thresholds.floorPercent < 1 ||
    thresholds.ceilingPercent > 100 ||
    thresholds.floorPercent > thresholds.ceilingPercent
  ) {
    throw new RangeError(
      "resolution percent range must satisfy 1 <= floor <= ceiling <= 100.",
    );
  }
  return thresholds;
}

/** Renderer surface needed to apply a scale; `Renderer.resize` matches it. */
export interface ResizableRenderer {
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
}

/**
 * Applies the scale to the renderer's backing store: `dpr * scale` is passed
 * as the density, so the backing store becomes `cssWidth * dpr * scale` while
 * the CSS size is unchanged (FR-9.4). The renderer's own `maxRenderHeight` cap
 * still applies afterwards when the TV profile configured one.
 */
export function applyResolutionScale(
  renderer: ResizableRenderer,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  scale: number,
): void {
  const safeScale = Number.isFinite(scale) ? Math.min(Math.max(scale, 0), 1) : 1;
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  renderer.resize(cssWidth, cssHeight, safeDpr * safeScale);
}

export class ResolutionController {
  private readonly thresholds: ResolutionThresholds;
  private readonly onChange: ((change: ResolutionChange) => void) | undefined;

  private percentValue: number;
  private stateValue: ResolutionState = "active";
  private reasonValue: ResolutionReason = "initial";
  private slowStreak = 0;
  private fastStreak = 0;
  private framesSampledValue = 0;
  private dropCountValue = 0;
  private riseCountValue = 0;
  private changeCountValue = 0;
  private sequence = 0;
  private lastChangeValue: ResolutionChange | null = null;

  constructor(options: ResolutionControllerOptions = {}) {
    this.thresholds = resolveThresholds(options.thresholds);
    this.onChange = options.onChange;
    const initial = options.initialPercent ?? this.thresholds.ceilingPercent;
    this.percentValue = Math.min(
      Math.max(initial, this.thresholds.floorPercent),
      this.thresholds.ceilingPercent,
    );
  }

  /** Current render scale in [floor, ceiling]. */
  get scale(): number {
    return this.percentValue / 100;
  }

  /** Current scale as an integer percentage. */
  get percent(): number {
    return this.percentValue;
  }

  get state(): ResolutionState {
    return this.stateValue;
  }

  /** Why the scale is where it is: the last step, or `context-restored`. */
  get reason(): ResolutionReason {
    return this.reasonValue;
  }

  get lastChange(): ResolutionChange | null {
    return this.lastChangeValue;
  }

  get thresholdsInUse(): ResolutionThresholds {
    return this.thresholds;
  }

  get framesSampled(): number {
    return this.framesSampledValue;
  }

  get slowStreakLength(): number {
    return this.slowStreak;
  }

  get fastStreakLength(): number {
    return this.fastStreak;
  }

  get dropCount(): number {
    return this.dropCountValue;
  }

  get riseCount(): number {
    return this.riseCountValue;
  }

  get changeCount(): number {
    return this.changeCountValue;
  }

  /**
   * Records one frame interval in milliseconds. Returns true when the scale
   * changed. Invalid samples (NaN, Infinity, <= 0) and samples taken while
   * suspended are ignored so a paused or context-lost period cannot count as
   * slow frames.
   */
  sample(frameMs: number): boolean {
    if (this.stateValue === "suspended") {
      return false;
    }
    if (!Number.isFinite(frameMs) || frameMs <= 0) {
      return false;
    }
    this.framesSampledValue += 1;

    if (frameMs > this.thresholds.slowFrameMs) {
      this.slowStreak += 1;
      this.fastStreak = 0;
      if (this.slowStreak >= this.thresholds.slowFrameCount) {
        this.slowStreak = 0;
        const next = Math.max(
          this.thresholds.floorPercent,
          this.percentValue - this.thresholds.dropStepPercent,
        );
        return this.commit(next, "slow-frames");
      }
      return false;
    }

    if (frameMs < this.thresholds.fastFrameMs) {
      this.fastStreak += 1;
      this.slowStreak = 0;
      if (this.fastStreak >= this.thresholds.fastFrameCount) {
        this.fastStreak = 0;
        const next = Math.min(
          this.thresholds.ceilingPercent,
          this.percentValue + this.thresholds.riseStepPercent,
        );
        return this.commit(next, "fast-frames");
      }
      return false;
    }

    // Between the thresholds: neutral, which is the hysteresis band.
    this.slowStreak = 0;
    this.fastStreak = 0;
    return false;
  }

  /**
   * Freezes sampling while rendering is invalid (WebGL context loss, hidden
   * document). The scale is preserved; no quality change is made silently.
   */
  suspend(): void {
    this.stateValue = "suspended";
    this.slowStreak = 0;
    this.fastStreak = 0;
  }

  /**
   * Resumes after `suspend()`. Streaks restart so frames from before the pause
   * cannot combine with frames after it, and the reason records the recovery
   * event. The scale itself is unchanged: context recovery must not jump the
   * picture back to full resolution (FR-9.5: recover slowly).
   */
  resume(): void {
    if (this.stateValue !== "suspended") {
      return;
    }
    this.stateValue = "active";
    this.slowStreak = 0;
    this.fastStreak = 0;
    this.reasonValue = "context-restored";
  }

  /** Test/recovery helper: returns to the ceiling and clears all counters. */
  reset(percent: number = this.thresholds.ceilingPercent): void {
    this.percentValue = Math.min(
      Math.max(percent, this.thresholds.floorPercent),
      this.thresholds.ceilingPercent,
    );
    this.stateValue = "active";
    this.reasonValue = "initial";
    this.slowStreak = 0;
    this.fastStreak = 0;
    this.framesSampledValue = 0;
    this.dropCountValue = 0;
    this.riseCountValue = 0;
    this.changeCountValue = 0;
    this.sequence = 0;
    this.lastChangeValue = null;
  }

  private commit(next: number, reason: ResolutionChangeReason): boolean {
    if (next === this.percentValue) {
      return false;
    }
    const previousPercent = this.percentValue;
    this.percentValue = next;
    this.sequence += 1;
    this.changeCountValue += 1;
    if (reason === "slow-frames") {
      this.dropCountValue += 1;
    } else {
      this.riseCountValue += 1;
    }
    this.reasonValue = reason;
    const change: ResolutionChange = {
      sequence: this.sequence,
      previousPercent,
      percent: next,
      previousScale: previousPercent / 100,
      scale: next / 100,
      reason,
      frame: this.framesSampledValue,
    };
    this.lastChangeValue = change;
    this.onChange?.(change);
    return true;
  }
}

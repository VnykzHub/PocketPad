/**
 * One-pole low-pass filter for gyro rates (D6-CTRL-02; FR-8.5).
 *
 * `y = alpha * x + (1 - alpha) * y`, applied per axis. The layout's
 * `smoothing` field (or the gyro control's own field) selects `alpha`; the D6
 * default is 0.15 and the usable range is 0.02..1. A low alpha filters drift
 * but adds lag, so steering layouts may ask for less smoothing (higher alpha).
 */

/** Default layout smoothing (FR-8.5, D6 contract 3). */
export const DEFAULT_SMOOTHING = 0.15;

/** Lowest useful alpha; D6 allows steering layouts to react faster than 0.15. */
export const MIN_SMOOTHING = 0.02;

/** No filtering. */
export const MAX_SMOOTHING = 1;

/**
 * Resolves a layout value to a usable alpha. Missing/non-finite values take
 * the default; everything else is clamped to 0.02..1.
 */
export function clampSmoothing(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SMOOTHING;
  }
  return Math.min(MAX_SMOOTHING, Math.max(MIN_SMOOTHING, value));
}

/** One axis' one-pole filter state. */
export class OnePoleLowPass {
  private smoothing: number;
  private filtered = 0;

  constructor(smoothing: number | undefined = undefined) {
    this.smoothing = clampSmoothing(smoothing);
  }

  /** Current alpha (0.02..1). */
  get alpha(): number {
    return this.smoothing;
  }

  /** Changes alpha without resetting the filter state. */
  setSmoothing(smoothing: number | undefined): void {
    this.smoothing = clampSmoothing(smoothing);
  }

  /** Current filtered value. */
  get value(): number {
    return this.filtered;
  }

  /** Feeds one sample and returns the filtered value. Non-finite input is ignored. */
  process(input: number): number {
    if (!Number.isFinite(input)) {
      return this.filtered;
    }
    this.filtered = this.smoothing * input + (1 - this.smoothing) * this.filtered;
    return this.filtered;
  }

  /** Resets the filter state; `value` defaults to zero. */
  reset(value = 0): void {
    this.filtered = Number.isFinite(value) ? value : 0;
  }
}

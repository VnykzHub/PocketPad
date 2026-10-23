/**
 * Tap-to-beat calibration helper (beat-tap layouts; FR-8.5 adjacent).
 *
 * A rhythm game asks the player to tap the beat a few times. The helper turns
 * those timestamps into a tempo estimate and a consistency figure, so a game
 * can decide whether the taps are good enough to start. It owns no clock and
 * no DOM: callers pass `performance.now()` values in milliseconds.
 *
 * Gaps outside the accepted range are treated as a new attempt rather than a
 * beat: a double-tap (<= 120 ms) is ignored, and a pause longer than 2 s
 * starts a fresh measurement. The estimate uses the median interval and the
 * median absolute deviation (MAD), which resists one mistimed tap.
 */

/** Shortest accepted beat interval; faster taps are treated as double taps. */
export const TAP_MIN_INTERVAL_MS = 120;

/** Longest accepted beat interval; a longer gap starts a new attempt. */
export const TAP_MAX_INTERVAL_MS = 2_000;

/** Minimum taps needed for an estimate (one interval). */
export const TAP_MIN_SAMPLES = 2;

/** Most recent taps kept; older taps are discarded before estimating. */
export const TAP_MAX_SAMPLES = 8;

export interface TapTempoOptions {
  /** Minimum taps required; default 2. Values below 2 are raised to 2. */
  minTaps?: number;
  /** Most recent taps kept; default 8. */
  maxTaps?: number;
}

export interface TapTempoEstimate {
  /** Estimated tempo in beats per minute. */
  bpm: number;
  /** Median interval between taps, in milliseconds. */
  intervalMs: number;
  /** Number of taps that contributed (2..maxTaps). */
  taps: number;
  /** Median absolute deviation of the intervals, in milliseconds. */
  spreadMs: number;
  /**
   * 0..1 consistency score. 1 is perfectly even; 0 is as variable as the
   * interval itself. A game can require, for example, `confidence >= 0.6`.
   */
  confidence: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Estimates tempo from tap timestamps. Non-finite or out-of-order taps are
 * ignored. Returns null until at least `minTaps` usable taps and one interval
 * inside the accepted range exist.
 */
export function estimateTapTempo(
  timestampsMs: readonly number[],
  options: TapTempoOptions = {},
): TapTempoEstimate | null {
  const minTaps = Math.max(2, Math.floor(options.minTaps ?? TAP_MIN_SAMPLES));
  const maxTaps = Math.max(minTaps, Math.floor(options.maxTaps ?? TAP_MAX_SAMPLES));

  const ordered: number[] = [];
  for (const value of timestampsMs) {
    if (!Number.isFinite(value) || value < 0) {
      continue;
    }
    const last = ordered[ordered.length - 1];
    if (last !== undefined && value <= last) {
      continue;
    }
    ordered.push(value);
  }
  if (ordered.length > maxTaps) {
    ordered.splice(0, ordered.length - maxTaps);
  }
  if (ordered.length < minTaps) {
    return null;
  }

  // Split into attempts at pauses longer than the accepted interval.
  let attemptStart = 0;
  for (let index = 1; index <= ordered.length; index += 1) {
    const current = ordered[index];
    const previous = ordered[index - 1];
    const paused =
      index === ordered.length ||
      current === undefined ||
      previous === undefined ||
      current - previous > TAP_MAX_INTERVAL_MS;
    if (paused) {
      const attempt = ordered.slice(attemptStart, index);
      const estimate = estimateAttempt(attempt, minTaps, maxTaps);
      if (estimate !== null) {
        return estimate;
      }
      attemptStart = index;
    }
  }
  return null;
}

function estimateAttempt(
  taps: readonly number[],
  minTaps: number,
  maxTaps: number,
): TapTempoEstimate | null {
  if (taps.length < minTaps) {
    return null;
  }

  const intervals: number[] = [];
  for (let index = 1; index < taps.length; index += 1) {
    const current = taps[index];
    const previous = taps[index - 1];
    if (current === undefined || previous === undefined) {
      continue;
    }
    const gap = current - previous;
    // A double-tap is noise, not a beat; ignore it without resetting.
    if (gap >= TAP_MIN_INTERVAL_MS && gap <= TAP_MAX_INTERVAL_MS) {
      intervals.push(gap);
    }
  }
  if (intervals.length === 0) {
    return null;
  }

  const intervalMs = median(intervals);
  if (intervalMs <= 0) {
    return null;
  }
  const spreadMs = median(intervals.map((value) => Math.abs(value - intervalMs)));
  const confidence = Math.max(0, Math.min(1, 1 - spreadMs / intervalMs));
  return {
    bpm: 60_000 / intervalMs,
    intervalMs,
    taps: Math.min(taps.length, maxTaps),
    spreadMs,
    confidence,
  };
}

/**
 * Stateful wrapper for a calibration screen. `tap(nowMs)` returns the current
 * estimate after every tap (or null until enough taps), and starts a fresh
 * attempt automatically after a pause.
 */
export class TapTempoTracker {
  private readonly timestamps: number[] = [];
  private readonly options: TapTempoOptions;

  constructor(options: TapTempoOptions = {}) {
    this.options = options;
  }

  /** Taps recorded in the current attempt. */
  get tapCount(): number {
    return this.timestamps.length;
  }

  get estimate(): TapTempoEstimate | null {
    return estimateTapTempo(this.timestamps, this.options);
  }

  /** Records a tap and returns the refreshed estimate. */
  tap(nowMs: number): TapTempoEstimate | null {
    if (!Number.isFinite(nowMs)) {
      return this.estimate;
    }
    const last = this.timestamps[this.timestamps.length - 1];
    if (last !== undefined && nowMs - last > TAP_MAX_INTERVAL_MS) {
      this.timestamps.length = 0;
    }
    if (last === undefined || nowMs > last) {
      this.timestamps.push(nowMs);
    }
    const maxTaps = Math.max(2, Math.floor(this.options.maxTaps ?? TAP_MAX_SAMPLES));
    if (this.timestamps.length > maxTaps) {
      this.timestamps.splice(0, this.timestamps.length - maxTaps);
    }
    return this.estimate;
  }

  reset(): void {
    this.timestamps.length = 0;
  }
}

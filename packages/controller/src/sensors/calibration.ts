/**
 * Gyro bias estimation and auto-zero (D6-CTRL-02; D6 contract 4).
 *
 * After every `start()` or `recalibrate()`, the first 500 ms of remapped rates
 * are averaged into a per-axis bias. Motion output is held at zero while the
 * window is open (so a layout never steers with uncalibrated data), and the
 * bias is subtracted from every later sample. A still phone therefore reports
 * about zero after calibration, and Recalibrate removes accumulated drift.
 *
 * Time is passed in by the caller; this module owns no clock and no DOM.
 */

/** Auto-zero window after start/recalibrate (D6 contract 4). */
export const AUTO_ZERO_WINDOW_MS = 500;

export interface AxisRates {
  x: number;
  y: number;
  z: number;
}

export function zeroAxisRates(): AxisRates {
  return { x: 0, y: 0, z: 0 };
}

function isFiniteRate(rate: AxisRates): boolean {
  return (
    Number.isFinite(rate.x) && Number.isFinite(rate.y) && Number.isFinite(rate.z)
  );
}

/**
 * Per-axis mean of the samples seen during the current calibration window.
 *
 * `addSample()` returns true only on the sample that closes the window; the
 * closing sample is not part of the mean because it arrived after the window.
 * If no sample arrived during the window, the bias stays zero (there was
 * nothing to average) and calibration completes on the next sample.
 */
export class AxisCalibration {
  private readonly windowMs: number;
  private startedAtMs: number | null = null;
  private calibrating = false;
  private count = 0;
  private sumX = 0;
  private sumY = 0;
  private sumZ = 0;
  private biasX = 0;
  private biasY = 0;
  private biasZ = 0;

  constructor(windowMs: number = AUTO_ZERO_WINDOW_MS) {
    this.windowMs =
      Number.isFinite(windowMs) && windowMs > 0 ? windowMs : AUTO_ZERO_WINDOW_MS;
  }

  get isCalibrating(): boolean {
    return this.calibrating;
  }

  /** Samples accumulated in the current (or last completed) window. */
  get sampleCount(): number {
    return this.count;
  }

  /** Current bias; zero while calibrating. */
  get bias(): AxisRates {
    return { x: this.biasX, y: this.biasY, z: this.biasZ };
  }

  /** Opens a new window and clears the bias immediately. */
  begin(nowMs: number): void {
    this.startedAtMs = Number.isFinite(nowMs) ? nowMs : 0;
    this.calibrating = true;
    this.count = 0;
    this.sumX = 0;
    this.sumY = 0;
    this.sumZ = 0;
    this.biasX = 0;
    this.biasY = 0;
    this.biasZ = 0;
  }

  /** Drops the window and the bias (sensor stopped). */
  reset(): void {
    this.startedAtMs = null;
    this.calibrating = false;
    this.count = 0;
    this.sumX = 0;
    this.sumY = 0;
    this.sumZ = 0;
    this.biasX = 0;
    this.biasY = 0;
    this.biasZ = 0;
  }

  /**
   * Adds one remapped raw sample at `nowMs`.
   *
   * @returns true when this call completed the window; the caller can then
   *   subtract `bias` from later output.
   */
  addSample(raw: AxisRates, nowMs: number): boolean {
    if (!this.calibrating || this.startedAtMs === null) {
      return false;
    }

    const safeNow = Number.isFinite(nowMs) ? nowMs : this.startedAtMs;
    const elapsed = safeNow - this.startedAtMs;
    if (elapsed < this.windowMs) {
      if (isFiniteRate(raw)) {
        this.sumX += raw.x;
        this.sumY += raw.y;
        this.sumZ += raw.z;
        this.count += 1;
      }
      return false;
    }

    if (this.count > 0) {
      this.biasX = this.sumX / this.count;
      this.biasY = this.sumY / this.count;
      this.biasZ = this.sumZ / this.count;
    }
    this.calibrating = false;
    return true;
  }

  /** Returns `raw - bias`; safe to call while calibrating (bias is zero). */
  apply(raw: AxisRates): AxisRates {
    return {
      x: raw.x - this.biasX,
      y: raw.y - this.biasY,
      z: raw.z - this.biasZ,
    };
  }
}

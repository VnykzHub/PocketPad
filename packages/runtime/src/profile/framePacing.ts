/**
 * Frame pacing diagnostics for the host runtime (D3-RT-07).
 *
 * The fixed loop owns simulation time; this module only classifies the
 * wall-clock frame intervals the loop already measures. It answers three
 * questions for the overlay and for acceptance runs:
 *
 * 1. **Target** — 60 fps (16.7 ms interval) is the default budget from
 *    `docs/BUDGETS.md`.
 * 2. **Floor** — 30 fps (33.3 ms interval) is the minimum acceptable cadence;
 *    frames slower than that are counted as a floor breach, not silently
 *    averaged away.
 * 3. **Panel class** — after a sustained run near 16.7 ms or 33.3 ms the
 *    pacer reports the 60 Hz or 30 Hz budget class. The 30 Hz class is the
 *    conditional row in `docs/BUDGETS.md`; on such a panel dynamic resolution
 *    will sit at its floor by design (D3-RT-07 risk), so the overlay must be
 *    able to show why.
 *
 * This does not throttle or schedule frames. `requestAnimationFrame` still
 * drives the loop; changing the cadence would break the fixed simulation. It
 * also allocates nothing per sample.
 */
import {
  FRAME_FLOOR_FPS,
  FRAME_INTERVAL_30HZ_MS,
  FRAME_INTERVAL_60HZ_MS,
  FRAME_TARGET_FPS,
} from "./budgets.js";

export type FramePacingState = "smooth" | "below-target" | "below-floor";
export type PanelClass = "60hz" | "30hz" | "unknown";

export interface FramePacerOptions {
  /** Defaults to 60 fps. Must be greater than `floorFps`. */
  readonly targetFps?: number;
  /** Defaults to 30 fps (the documented floor). */
  readonly floorFps?: number;
  /** EMA weight, 0..1; default 0.1 (about a 10-frame half-life). */
  readonly smoothing?: number;
  /** Consecutive frames near a cadence before the panel class is reported. */
  readonly panelWindow?: number;
  /** Relative tolerance around the cadence interval; default 0.1 (±10%). */
  readonly panelTolerance?: number;
}

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class FramePacer {
  readonly targetFps: number;
  readonly floorFps: number;
  /**
   * Classification interval. At the documented default rates this is the
   * `docs/BUDGETS.md` value (16.7 / 33.3 ms) rather than `1000 / fps`, which
   * gives rAF timestamp quantisation a small grace and keeps the runtime
   * numbers identical to the budget file.
   */
  readonly targetFrameMs: number;
  readonly floorFrameMs: number;

  private readonly smoothing: number;
  private readonly panelWindow: number;
  private readonly panelTolerance: number;

  private emaMs = 0;
  private instantFpsValue = 0;
  private lastFrameMsValue = 0;
  private stateValue: FramePacingState = "smooth";
  private panelClassValue: PanelClass = "unknown";
  private framesValue = 0;
  private longFramesValue = 0;
  private belowFloorFramesValue = 0;
  private elapsedMsValue = 0;
  private hz60Streak = 0;
  private hz30Streak = 0;

  constructor(options: FramePacerOptions = {}) {
    const targetFps = positiveOr(options.targetFps ?? FRAME_TARGET_FPS, FRAME_TARGET_FPS);
    const floorFps = positiveOr(options.floorFps ?? FRAME_FLOOR_FPS, FRAME_FLOOR_FPS);
    if (floorFps >= targetFps) {
      throw new RangeError("floorFps must be below targetFps.");
    }
    this.targetFps = targetFps;
    this.floorFps = floorFps;
    this.targetFrameMs =
      targetFps === FRAME_TARGET_FPS ? FRAME_INTERVAL_60HZ_MS : 1000 / targetFps;
    this.floorFrameMs =
      floorFps === FRAME_FLOOR_FPS ? FRAME_INTERVAL_30HZ_MS : 1000 / floorFps;
    this.smoothing = clamp(options.smoothing ?? 0.1, 0.001, 1);
    this.panelWindow = Math.max(1, Math.floor(options.panelWindow ?? 60));
    this.panelTolerance = clamp(options.panelTolerance ?? 0.1, 0, 0.5);
  }

  /** Smoothed frames per second; 0 until the first sample. */
  get fps(): number {
    return this.emaMs > 0 ? 1000 / this.emaMs : 0;
  }

  /** Instantaneous fps of the last sample; 0 until the first sample. */
  get instantFps(): number {
    return this.instantFpsValue;
  }

  /** Smoothed frame interval in milliseconds; 0 until the first sample. */
  get emaFrameMs(): number {
    return this.emaMs;
  }

  get lastFrameMs(): number {
    return this.lastFrameMsValue;
  }

  /** Classification of the most recent sample. */
  get state(): FramePacingState {
    return this.stateValue;
  }

  get panelClass(): PanelClass {
    return this.panelClassValue;
  }

  get frames(): number {
    return this.framesValue;
  }

  /** Frames slower than the target interval (includes floor breaches). */
  get longFrames(): number {
    return this.longFramesValue;
  }

  /** Frames slower than the 30 fps floor. */
  get belowFloorFrames(): number {
    return this.belowFloorFramesValue;
  }

  get elapsedMs(): number {
    return this.elapsedMsValue;
  }

  /**
   * Records the interval since the previous frame and returns its pacing
   * state. Values that are not positive finite numbers are ignored.
   */
  sample(intervalMs: number): FramePacingState {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return this.stateValue;
    }

    this.framesValue += 1;
    this.lastFrameMsValue = intervalMs;
    this.elapsedMsValue += intervalMs;
    this.instantFpsValue = 1000 / intervalMs;
    this.emaMs =
      this.emaMs === 0
        ? intervalMs
        : this.emaMs + this.smoothing * (intervalMs - this.emaMs);

    if (intervalMs > this.floorFrameMs) {
      this.stateValue = "below-floor";
      this.belowFloorFramesValue += 1;
      this.longFramesValue += 1;
    } else if (intervalMs > this.targetFrameMs) {
      this.stateValue = "below-target";
      this.longFramesValue += 1;
    } else {
      this.stateValue = "smooth";
    }

    // Cadence class uses the smoothed interval so a one-off hitch does not
    // flip the panel class. The streaks are consecutive, so mixed load or a
    // desktop rAF cap near 120 Hz stays "unknown" rather than being rounded
    // into a panel class it does not have.
    const near60 =
      Math.abs(this.emaMs - FRAME_INTERVAL_60HZ_MS) <=
      FRAME_INTERVAL_60HZ_MS * this.panelTolerance;
    const near30 =
      Math.abs(this.emaMs - FRAME_INTERVAL_30HZ_MS) <=
      FRAME_INTERVAL_30HZ_MS * this.panelTolerance;

    if (near30) {
      this.hz30Streak += 1;
      this.hz60Streak = 0;
    } else if (near60) {
      this.hz60Streak += 1;
      this.hz30Streak = 0;
    } else {
      this.hz30Streak = 0;
      this.hz60Streak = 0;
    }

    if (this.hz30Streak >= this.panelWindow) {
      this.panelClassValue = "30hz";
    } else if (this.hz60Streak >= this.panelWindow) {
      this.panelClassValue = "60hz";
    }

    return this.stateValue;
  }

  /**
   * Clears all measured state. Call this on `pause()`/`resume()` or when a
   * hidden tab becomes visible, so the wall-clock gap is not counted as a
   * long frame. The configured budget is kept.
   */
  reset(): void {
    this.emaMs = 0;
    this.instantFpsValue = 0;
    this.lastFrameMsValue = 0;
    this.stateValue = "smooth";
    this.panelClassValue = "unknown";
    this.framesValue = 0;
    this.longFramesValue = 0;
    this.belowFloorFramesValue = 0;
    this.elapsedMsValue = 0;
    this.hz60Streak = 0;
    this.hz30Streak = 0;
  }
}

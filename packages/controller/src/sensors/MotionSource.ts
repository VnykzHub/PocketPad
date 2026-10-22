/**
 * DeviceMotion rotation-rate source (D6-CTRL-02; FR-7.5, FR-7.6, FR-8.5, E7).
 *
 * The source owns the `devicemotion` listener and turns raw rotation rates
 * into the frozen wire sample:
 *
 *   { gx, gy, gz } i16 degrees/second x10, screen-relative, zero when inactive
 *   active       true while usable sensor data is flowing
 *   recentered   true until the next packet consumes the recalibration flag
 *
 * Pipeline: remap by `screen.orientation.angle` -> one-pole low-pass ->
 * auto-zero bias (first 500 ms after start/recalibrate; output held at zero) ->
 * sensitivity -> dps x10 -> i16 clamp.
 *
 * The controller samples `latest` from its 60 Hz send cadence; it must not send
 * from the `devicemotion` callback, which can fire faster. Every dependency
 * (event target, screen angle, clock) is injected so tests never touch DOM
 * globals and importing this module has no side effects.
 */
import { AxisCalibration } from "./calibration.js";
import { OnePoleLowPass } from "./lowPass.js";
import { remapRotationRate, type RotationRate } from "./remap.js";

/** Encoding multiplier: wire units are degrees/second x10 (FR-7.5). */
export const GYRO_WIRE_SCALE = 10;

/** Wire clamp for one axis (FR-7.5: i16, range +/-3276 dps). */
export const MAX_GYRO_WIRE_VALUE = 32767;
export const MIN_GYRO_WIRE_VALUE = -32768;

/** Sensitivity bounds from D6 contract 3. */
export const DEFAULT_SENSITIVITY = 1;
export const MIN_SENSITIVITY = 0.5;
export const MAX_SENSITIVITY = 3;

/** The frozen sample shape consumed by the gyro control (D6-CTRL-02). */
export interface MotionSample {
  /** Degrees/second x10, screen-relative, i16-clamped. */
  gx: number;
  gy: number;
  gz: number;
  /** True while usable motion data is flowing. */
  active: boolean;
  /** True until the next `consumeRecentered()`; one packet (FR-7.6). */
  recentered: boolean;
}

/** Structural subset of `DeviceMotionEvent` used here (easy to fake in tests). */
export interface DeviceRotationRateEvent {
  readonly rotationRate: RotationRate | null | undefined;
}

export interface MotionSourceDeps {
  addEventListener: (
    type: "devicemotion",
    callback: (event: DeviceRotationRateEvent) => void,
  ) => void;
  removeEventListener: (
    type: "devicemotion",
    callback: (event: DeviceRotationRateEvent) => void,
  ) => void;
  /** Current `screen.orientation.angle` (degrees). */
  getScreenAngle: () => number;
  /** Monotonic milliseconds for the auto-zero window. */
  now: () => number;
}

export interface MotionSourceOptions {
  /** Low-pass alpha (default 0.15, clamped 0.02..1). */
  smoothing?: number | undefined;
  /** Multiplier (default 1, clamped 0.5..3). */
  sensitivity?: number | undefined;
}

/** Resolves a layout sensitivity to the documented 0.5..3 range. */
export function clampSensitivity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SENSITIVITY;
  }
  return Math.min(MAX_SENSITIVITY, Math.max(MIN_SENSITIVITY, value));
}

function encodeAxis(degreesPerSecond: number): number {
  const scaled = Math.round(degreesPerSecond * GYRO_WIRE_SCALE);
  if (scaled < MIN_GYRO_WIRE_VALUE) return MIN_GYRO_WIRE_VALUE;
  if (scaled > MAX_GYRO_WIRE_VALUE) return MAX_GYRO_WIRE_VALUE;
  return scaled;
}

export class MotionSource {
  /**
   * Optional observer called synchronously for every `devicemotion` event that
   * carries a rotation-rate object. The gyro UI uses it to cancel its 1 s
   * no-data timer; it is never used for control flow inside this class.
   */
  onEvent: (() => void) | null = null;

  private readonly deps: MotionSourceDeps;
  private readonly calibration = new AxisCalibration();
  private readonly filterX = new OnePoleLowPass();
  private readonly filterY = new OnePoleLowPass();
  private readonly filterZ = new OnePoleLowPass();
  private readonly sample: MotionSample = {
    gx: 0,
    gy: 0,
    gz: 0,
    active: false,
    recentered: false,
  };

  private sensitivity = DEFAULT_SENSITIVITY;
  private started = false;
  private attached = false;

  constructor(deps: MotionSourceDeps) {
    this.deps = deps;
  }

  /** Latest encoded sample; the object identity is stable until `stop()`. */
  get latest(): MotionSample {
    return this.sample;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /**
   * Starts listening. Calling again updates smoothing/sensitivity without
   * opening a second listener or restarting the calibration window.
   */
  start(options: MotionSourceOptions = {}): void {
    this.filterX.setSmoothing(options.smoothing);
    this.filterY.setSmoothing(options.smoothing);
    this.filterZ.setSmoothing(options.smoothing);
    this.sensitivity = clampSensitivity(options.sensitivity);

    if (this.started) {
      return;
    }

    this.started = true;
    this.resetSample();
    this.calibration.begin(this.deps.now());

    try {
      this.deps.addEventListener("devicemotion", this.handleMotion);
      this.attached = true;
    } catch (error) {
      this.started = false;
      this.calibration.reset();
      throw error;
    }
  }

  /** Stops listening and emits an inactive zero sample. Idempotent. */
  stop(): void {
    if (this.attached) {
      try {
        this.deps.removeEventListener("devicemotion", this.handleMotion);
      } finally {
        this.attached = false;
      }
    }
    this.started = false;
    this.calibration.reset();
    this.filterX.reset();
    this.filterY.reset();
    this.filterZ.reset();
    this.resetSample();
  }

  /**
   * Re-opens the auto-zero window and marks the next packet recentered
   * (FR-7.6, D6 contract 4). No-op when motion is not running.
   */
  recalibrate(): void {
    if (!this.started) {
      return;
    }
    this.calibration.begin(this.deps.now());
    // Hold the wire at zero while the new window runs; the 60 Hz sampler may
    // tick before the next devicemotion event arrives.
    this.sample.gx = 0;
    this.sample.gy = 0;
    this.sample.gz = 0;
    this.sample.recentered = true;
  }

  /**
   * Returns whether a recalibration is pending and clears the one-packet flag.
   * The 60 Hz sampler calls this exactly once per packet.
   */
  consumeRecentered(): boolean {
    const recentered = this.sample.recentered;
    this.sample.recentered = false;
    return recentered;
  }

  /** Test/debug hook: true while the 500 ms auto-zero window is open. */
  get isCalibrating(): boolean {
    return this.calibration.isCalibrating;
  }

  /** Test/debug hook: current bias in remapped degrees/second. */
  get bias(): { x: number; y: number; z: number } {
    return this.calibration.bias;
  }

  private readonly handleMotion = (event: DeviceRotationRateEvent): void => {
    if (!this.started) {
      return;
    }

    const rate = event.rotationRate;
    if (rate === null || rate === undefined) {
      // A null rate is an honest "no data" sample, not an exception (E7).
      this.sample.gx = 0;
      this.sample.gy = 0;
      this.sample.gz = 0;
      this.sample.active = false;
      return;
    }

    this.onEvent?.();

    const now = this.deps.now();
    const remapped = remapRotationRate(rate, this.deps.getScreenAngle());

    // Estimate the raw bias during the first 500 ms. The filters still run so
    // their state matches the phone once the window closes; output is held at
    // zero until calibration completes.
    this.calibration.addSample(remapped, now);

    const filteredX = this.filterX.process(remapped.x);
    const filteredY = this.filterY.process(remapped.y);
    const filteredZ = this.filterZ.process(remapped.z);

    if (this.calibration.isCalibrating) {
      this.sample.gx = 0;
      this.sample.gy = 0;
      this.sample.gz = 0;
      this.sample.active = true;
      return;
    }

    const biased = this.calibration.apply({
      x: filteredX,
      y: filteredY,
      z: filteredZ,
    });

    this.sample.gx = encodeAxis(biased.x * this.sensitivity);
    this.sample.gy = encodeAxis(biased.y * this.sensitivity);
    this.sample.gz = encodeAxis(biased.z * this.sensitivity);
    this.sample.active = true;
  };

  private resetSample(): void {
    this.sample.gx = 0;
    this.sample.gy = 0;
    this.sample.gz = 0;
    this.sample.active = false;
    this.sample.recentered = false;
  }
}

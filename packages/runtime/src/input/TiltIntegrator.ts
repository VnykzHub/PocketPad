/**
 * Host-side tilt integration (D6-RT-01; FR-7.5, FR-8.5, FR-8.11).
 *
 * The controller sends angular rate (degrees/second) and never integrates an
 * angle itself. This class turns one slot's rate into a game-friendly tilt,
 * with the behaviours the plan requires:
 *
 * - fixed-step integration: `angle += rate * dt`;
 * - clamp to ±30° by default (per-game configurable);
 * - drift correction toward 0 while the rate is near zero;
 * - `gyroRecentered` resets both angles on that tick;
 * - inactive motion decays the angles toward 0 and reports `available:false`.
 *
 * Input is the game-facing `ControllerState`, whose `gyro` is already in
 * degrees/second (InputMapper converts the wire's dps×10 once). The state is
 * pooled and reused; `state` exposes the same object every call, so games
 * must copy angles they keep across ticks (PR-9.3).
 *
 * The host owns one integrator per slot; `main.ts` can wire them from the
 * mapper's polled states. There is no socket, DOM or clock dependency here.
 */
import type { ControllerState } from "./types.js";

/** Default clamp from the D6 plan. */
export const TILT_MAX_ANGLE_DEG = 30;
/** Drift correction applied while the rate is near zero (degrees/second). */
export const TILT_DRIFT_DEG_PER_SEC = 0.5;
/** Rates below this magnitude count as "near zero" for drift correction. */
export const TILT_ZERO_RATE_DPS = 0.5;
/** Rate at which angles return to 0 while motion is inactive (degrees/second). */
export const TILT_INACTIVE_DECAY_DEG_PER_SEC = 20;

/** Latest integrated tilt for one slot. Pooled; copy what you retain. */
export interface TiltState {
  /** Integrated pitch in degrees, clamped to ±maxAngleDeg. */
  angleX: number;
  /** Integrated yaw/roll in degrees, clamped to ±maxAngleDeg. */
  angleY: number;
  /** False while motion is inactive (angles decay to 0). */
  available: boolean;
}

export interface TiltIntegratorOptions {
  /** Clamp for both angles; default 30°. */
  readonly maxAngleDeg?: number;
  /** Drift correction near zero rate; default 0.5 °/s. */
  readonly driftDegPerSec?: number;
  /** Inactive decay rate; default 20 °/s (angles reach 0 quickly). */
  readonly inactiveDecayDegPerSec?: number;
  /** Rates at or below this magnitude drift toward 0; default 0.5 dps. */
  readonly zeroRateDps?: number;
  /** Layout `sensors.sensitivity`; multiplies the rate. Default 1. */
  readonly sensitivity?: number;
  /**
   * Layout `sensors.smoothing` in 0..1 (0 = raw, higher = smoother). Applied
   * as an exponential moving average over the rate before integration.
   */
  readonly smoothing?: number;
}

/** The subset of `ControllerState` the integrator reads. */
export type TiltInput = Pick<
  ControllerState,
  "gyro" | "gyroActive" | "gyroRecentered"
>;

function requireNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function requireUnitInterval(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be in 0..1.`);
  }
  return value;
}

function moveTowardZero(value: number, maxDelta: number): number {
  if (value > 0) {
    return Math.max(0, value - maxDelta);
  }
  if (value < 0) {
    return Math.min(0, value + maxDelta);
  }
  return 0;
}

function clampAngle(value: number, maxAngle: number): number {
  if (value > maxAngle) {
    return maxAngle;
  }
  if (value < -maxAngle) {
    return -maxAngle;
  }
  return value;
}

export class TiltIntegrator {
  private readonly maxAngle: number;
  private readonly drift: number;
  private readonly inactiveDecay: number;
  private readonly zeroRate: number;
  private readonly sensitivity: number;
  private readonly smoothing: number;
  /** Reused EMA state for smoothing; rate units, not accumulators. */
  private smoothedX = 0;
  private smoothedY = 0;
  private readonly stateValue: TiltState = {
    angleX: 0,
    angleY: 0,
    available: false,
  };

  constructor(options: TiltIntegratorOptions = {}) {
    this.maxAngle = requireNonNegative(options.maxAngleDeg ?? TILT_MAX_ANGLE_DEG, "maxAngleDeg");
    this.drift = requireNonNegative(
      options.driftDegPerSec ?? TILT_DRIFT_DEG_PER_SEC,
      "driftDegPerSec",
    );
    this.inactiveDecay = requireNonNegative(
      options.inactiveDecayDegPerSec ?? TILT_INACTIVE_DECAY_DEG_PER_SEC,
      "inactiveDecayDegPerSec",
    );
    this.zeroRate = requireNonNegative(options.zeroRateDps ?? TILT_ZERO_RATE_DPS, "zeroRateDps");
    this.sensitivity = requireNonNegative(options.sensitivity ?? 1, "sensitivity");
    this.smoothing = requireUnitInterval(options.smoothing ?? 0, "smoothing");
  }

  /** Latest angles. The returned object is reused across `update` calls. */
  get state(): TiltState {
    return this.stateValue;
  }

  /**
   * Advances one fixed step. `dtSeconds` is the host's fixed timestep (1/60
   * in the runtime). Non-positive or non-finite steps are ignored so a pause
   * cannot produce a jump.
   */
  update(input: TiltInput, dtSeconds: number): TiltState {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      return this.stateValue;
    }

    const state = this.stateValue;
    if (!input.gyroActive) {
      // No usable motion: angle is not meaningful, so decay and disable.
      state.available = false;
      this.smoothedX = 0;
      this.smoothedY = 0;
      state.angleX = moveTowardZero(state.angleX, this.inactiveDecay * dtSeconds);
      state.angleY = moveTowardZero(state.angleY, this.inactiveDecay * dtSeconds);
      return state;
    }

    if (input.gyroRecentered) {
      state.angleX = 0;
      state.angleY = 0;
      this.smoothedX = 0;
      this.smoothedY = 0;
    }
    state.available = true;

    // EMA over the raw rate. At smoothing 0 the raw value passes through.
    const blend = 1 - this.smoothing;
    this.smoothedX += (input.gyro.x - this.smoothedX) * blend;
    this.smoothedY += (input.gyro.y - this.smoothedY) * blend;

    const rateX = this.smoothedX * this.sensitivity;
    const rateY = this.smoothedY * this.sensitivity;

    state.angleX = clampAngle(state.angleX + rateX * dtSeconds, this.maxAngle);
    state.angleY = clampAngle(state.angleY + rateY * dtSeconds, this.maxAngle);

    // Drift correction: a still phone should not hold a stale angle forever.
    if (Math.abs(rateX) <= this.zeroRate) {
      state.angleX = moveTowardZero(state.angleX, this.drift * dtSeconds);
    }
    if (Math.abs(rateY) <= this.zeroRate) {
      state.angleY = moveTowardZero(state.angleY, this.drift * dtSeconds);
    }

    return state;
  }

  /** Returns both angles and availability to the initial state. */
  reset(): void {
    this.stateValue.angleX = 0;
    this.stateValue.angleY = 0;
    this.stateValue.available = false;
    this.smoothedX = 0;
    this.smoothedY = 0;
  }
}

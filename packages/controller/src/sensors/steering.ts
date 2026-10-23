/**
 * Gyro steering mapping for racing layouts (FR-8.5, FR-8.10).
 *
 * The controller sends remapped yaw rate as an i16 in `dps × 10` (FR-7.5).
 * A racing game wants a normalized steer axis in -1..1 with a small
 * deadzone, a full-lock point and an optional invert for left-handed play.
 * This module is pure so the racer (host side) and tests can share exactly
 * the mapping the layout recipe documents; it never reads a sensor itself.
 *
 * Convention: positive yaw rate steers right, negative steers left. The
 * mapping is linear between the deadzone and full lock, which is easier to
 * predict than a response curve and keeps a phone's small yaw range usable.
 */

/** Wire units per degree/second (`dps × 10`). */
export const GYRO_WIRE_DPS = 0.1;

/** Rates at or below this magnitude are treated as "not steering". */
export const STEER_DEADZONE_DPS = 2;

/** Rate that reaches full lock; above it the axis stays at ±1. */
export const STEER_FULL_SCALE_DPS = 90;

export interface SteerOptions {
  /** Rates at or below this magnitude map to 0. Default 2 dps. */
  deadzoneDps?: number;
  /** Rate that maps to ±1. Must exceed the deadzone. Default 90 dps. */
  fullScaleDps?: number;
  /** Flip the sign for a left-handed preference. Default false. */
  invert?: boolean;
}

/** Converts a wire i16 yaw rate (`dps × 10`) to degrees/second. */
export function wireRateToDps(wireRate: number): number {
  return wireRate * GYRO_WIRE_DPS;
}

function sanitizeOptions(options: SteerOptions): {
  deadzone: number;
  fullScale: number;
  invert: boolean;
} {
  const rawDeadzone = options.deadzoneDps;
  const deadzone =
    typeof rawDeadzone === "number" && Number.isFinite(rawDeadzone) && rawDeadzone >= 0
      ? rawDeadzone
      : STEER_DEADZONE_DPS;
  const rawFull = options.fullScaleDps;
  const fullScale =
    typeof rawFull === "number" && Number.isFinite(rawFull) && rawFull > deadzone
      ? rawFull
      : Math.max(STEER_FULL_SCALE_DPS, deadzone + 1);
  return { deadzone, fullScale, invert: options.invert === true };
}

/**
 * Maps a yaw rate in degrees/second to a steer axis.
 *
 * Returns 0 for non-finite input and inside the deadzone; otherwise the
 * magnitude ramps linearly from 0 at the deadzone to 1 at full lock and is
 * clamped there. The sign follows the input unless `invert` is set.
 */
export function steerAxisFromRate(yawDps: number, options: SteerOptions = {}): number {
  if (!Number.isFinite(yawDps)) {
    return 0;
  }
  const { deadzone, fullScale, invert } = sanitizeOptions(options);
  const magnitude = Math.abs(yawDps);
  if (magnitude <= deadzone) {
    return 0;
  }
  const scaled = Math.min(1, (magnitude - deadzone) / (fullScale - deadzone));
  const axis = yawDps < 0 ? -scaled : scaled;
  return invert ? -axis : axis;
}

/** Maps a wire i16 yaw rate (`dps × 10`) straight to a steer axis. */
export function steerAxisFromWire(wireRate: number, options: SteerOptions = {}): number {
  if (!Number.isFinite(wireRate)) {
    return 0;
  }
  return steerAxisFromRate(wireRateToDps(wireRate), options);
}

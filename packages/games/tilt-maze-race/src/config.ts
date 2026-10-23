/**
 * Tilt Maze Race configuration (GAME-TM-DATA-02).
 *
 * These six numbers are the whole play contract the plan names: ball radius,
 * acceleration scale, speed cap, friction, tilt clamp and countdown. Everything
 * else (exit radius, design space, tick length) is derived here so there is a
 * single source of truth. The maze itself is data in `maze-classic-v1.json`.
 *
 * Tuning note: at the 60 Hz host tick a full 30 degree tilt produces
 * `sin(30) * 900 = 450 u/s^2`; with `friction = 1.2` the terminal speed is
 * roughly `450 / 1.2 = 375 u/s`, just under the 380 u/s cap. The stick maps
 * directly to `accelScale` (the plan's "fallback stick maps directly") and the
 * same cap bounds it, so both sources share one maximum race speed.
 */

/** The plan's `GAME-TM-DATA-02` config block. */
export interface TiltMazeConfig {
  /** Ball radius in maze units. */
  readonly ballRadius: number;
  /** Acceleration at full stick deflection, maze units/second^2. */
  readonly accelScale: number;
  /** Hard speed cap, maze units/second. */
  readonly maxSpeed: number;
  /** Linear velocity damping per second (0 = frictionless). */
  readonly friction: number;
  /** Tilt angle mapped to the acceleration clamp, degrees. */
  readonly recenterClampDeg: number;
  /** Countdown before every race, milliseconds. */
  readonly countdownMs: number;
}

/** Shipped defaults. `friction` is a damping coefficient, not a multiplier. */
export const TILT_MAZE_CONFIG: TiltMazeConfig = {
  ballRadius: 14,
  accelScale: 900,
  maxSpeed: 380,
  friction: 1.2,
  recenterClampDeg: 30,
  countdownMs: 3000,
};

/** Preferred layout: gyro tilt, the gyro card's built-in Recenter target and a stick. */
export const TILT_MAZE_LAYOUT_ID = "tm-tilt-v1";

/** Stick-only layout for a gyro-less kiosk or an explicit per-host choice. */
export const TILT_MAZE_STICK_LAYOUT_ID = "tm-stick-v1";

/** Controller event name the results screen accepts as a rematch request. */
export const TILT_MAZE_REMATCH_EVENT = "rematch";

/** Exit is 2.5 ball radii wide, so the ball centre can reach it comfortably. */
export const EXIT_RADIUS_FACTOR = 2.5;

/** Slots 1..8, matching `GameInputSnapshot` and the protocol. */
export const SLOT_COUNT = 8;

/** Host fixed step; games should still consume the `dt` they are given. */
export const HOST_TICK_SECONDS = 1 / 60;

/** Design space for the flat rendering surface; scaled and letterboxed. */
export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 720;

function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
}

function requireNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
}

/** Validates and merges per-game overrides; called once from `init`. */
export function resolveConfig(overrides: Partial<TiltMazeConfig> = {}): TiltMazeConfig {
  const merged: TiltMazeConfig = { ...TILT_MAZE_CONFIG, ...overrides };
  requirePositive("ballRadius", merged.ballRadius);
  requirePositive("accelScale", merged.accelScale);
  requirePositive("maxSpeed", merged.maxSpeed);
  requireNonNegative("friction", merged.friction);
  requirePositive("recenterClampDeg", merged.recenterClampDeg);
  if (merged.recenterClampDeg > 90) {
    throw new RangeError("recenterClampDeg must be at most 90.");
  }
  if (!Number.isInteger(merged.countdownMs) || merged.countdownMs < 0) {
    throw new RangeError("countdownMs must be a non-negative integer.");
  }
  return merged;
}

/** The exit's trigger radius: 2.5 ball radii by contract. */
export function exitRadius(config: TiltMazeConfig): number {
  return config.ballRadius * EXIT_RADIUS_FACTOR;
}

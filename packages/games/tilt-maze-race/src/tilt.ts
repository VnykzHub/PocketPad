/**
 * Tilt-to-acceleration mapping and stick fallback (GAME-TM-HOST-02,
 * GAME-TM-CTRL-02; FR-7.6, FR-8.10, C6).
 *
 * The controller sends rotation rates; the runtime's `TiltIntegrator` owns the
 * integration and hands the game `player.tilt` (degrees, clamped to ±30 by the
 * host). This module never integrates rates. It maps the already-integrated
 * angles to acceleration and falls back to the stick, so the game has exactly
 * one acceleration value per slot per tick and both input sources share the
 * same physics path.
 *
 * Mapping (y-down screen space):
 *
 * - `angleX` positive (phone rolled right) accelerates +x (right).
 * - `angleY` positive (phone tilted away/forward) accelerates -y (up-screen).
 * - `accel = sin(angle) * accelScale`, with the angle defensively clamped to
 *   `recenterClampDeg` for hand-built snapshots (the host already clamps).
 * - The stick maps directly: `lx/ly * accelScale` (the plan's "fallback stick
 *   maps directly to acceleration").
 *
 * The stick wins whenever it is deflected past the layout's 8% deadzone, so a
 * player can always grab it even while motion is active. Otherwise tilt is
 * used. A recenter flag suppresses tilt for that tick; the host has already
 * zeroed the angle, so this is only a guard for non-integrated snapshots.
 * Disconnected players produce no acceleration (`world.ts` additionally lets
 * their velocity coast under friction).
 */
import type { GameControllerState, GameTiltState } from "@lanpad/sdk";
import type { TiltMazeConfig } from "./config.js";

/** The layout's stick deadzone (FR-7.4); mirrored here to pick a source. */
export const STICK_ACTIVE_DEADZONE = 0.08;

export type AccelerationSource = "none" | "tilt" | "stick";

/** Reused output object; games must not allocate one per tick (PR-9.3). */
export interface Acceleration {
  ax: number;
  ay: number;
  source: AccelerationSource;
}

/** Creates the caller-owned acceleration buffer, filled every tick. */
export function createAcceleration(): Acceleration {
  return { ax: 0, ay: 0, source: "none" };
}

/** Writes a level/no-input acceleration. */
export function resetAcceleration(out: Acceleration): void {
  out.ax = 0;
  out.ay = 0;
  out.source = "none";
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function safeAngle(angleDegrees: number, clampDegrees: number): number {
  if (!Number.isFinite(angleDegrees)) return 0;
  return clamp(angleDegrees, -clampDegrees, clampDegrees);
}

/** True when the stick is deflected beyond the layout deadzone. */
export function stickIsActive(lx: number, ly: number): boolean {
  if (!Number.isFinite(lx) || !Number.isFinite(ly)) return false;
  return lx * lx + ly * ly > STICK_ACTIVE_DEADZONE * STICK_ACTIVE_DEADZONE;
}

/**
 * Tilt angles (degrees) to acceleration. `recentered` suppresses the tilt for
 * the tick, matching the runtime's recenter contract.
 */
export function writeTiltAcceleration(
  tilt: GameTiltState | undefined,
  recentered: boolean,
  config: TiltMazeConfig,
  out: Acceleration,
): void {
  if (tilt === undefined || !tilt.available || recentered) {
    resetAcceleration(out);
    return;
  }
  const angleX = safeAngle(tilt.angleX, config.recenterClampDeg);
  const angleY = safeAngle(tilt.angleY, config.recenterClampDeg);
  const radians = Math.PI / 180;
  out.ax = Math.sin(angleX * radians) * config.accelScale;
  out.ay = -Math.sin(angleY * radians) * config.accelScale;
  out.source = "tilt";
}

/** Stick deflection (-1..1 per axis) to acceleration, mapped directly. */
export function writeStickAcceleration(
  lx: number,
  ly: number,
  config: TiltMazeConfig,
  out: Acceleration,
): void {
  const safeX = Number.isFinite(lx) ? clamp(lx, -1, 1) : 0;
  const safeY = Number.isFinite(ly) ? clamp(ly, -1, 1) : 0;
  out.ax = safeX * config.accelScale;
  out.ay = safeY * config.accelScale;
  out.source = "stick";
}

/**
 * Picks the source for one slot: stick when deflected, otherwise tilt, and
 * nothing when the player is absent or neither input is usable.
 */
export function resolveAcceleration(
  player: GameControllerState,
  config: TiltMazeConfig,
  out: Acceleration,
): void {
  if (!player.connected) {
    resetAcceleration(out);
    return;
  }
  if (stickIsActive(player.lx, player.ly)) {
    writeStickAcceleration(player.lx, player.ly, config, out);
    return;
  }
  writeTiltAcceleration(player.tilt, player.gyroRecentered, config, out);
}

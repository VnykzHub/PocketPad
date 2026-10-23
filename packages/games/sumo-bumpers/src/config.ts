/**
 * Sumo Bumpers tuning (GAME-SB-DATA-01, GAME-SB-DATA-02).
 *
 * All arena geometry is normalized to the smaller viewport dimension: the
 * arena centre is `(0, 0)`, the start radius is `0.48` and a player radius is
 * `0.035`. There are no pixel constants anywhere in the game; the renderer
 * multiplies by the surface's short side once per frame.
 *
 * `accel`, `dashImpulse` and `hitImpactThreshold` come from the plan in
 * simulation units. `unitsPerView` (16, the same short-side scale Coin Run
 * uses for its world) converts them into normalized units, so a terminal speed
 * of `42 / 16 / 3.2 ≈ 0.82` view-widths per second crosses the 0.96-wide arena
 * in about 1.2 s. Keeping the plan's numbers and one explicit scale constant
 * is clearer than silently retuning them.
 *
 * Every value here is a design target, not a measurement.
 */

/** Tuneable fields; every one has a tested default in `SUMO_CONFIG`. */
export interface SumoConfig {
  /** Slots preallocated; the plan caps a match at eight. */
  readonly maxPlayers: number;
  /** Arena radius at the first playing tick, normalized to the short side. */
  readonly arenaStartR: number;
  /** Arena radius after `shrinkDurationMs`, normalized to the short side. */
  readonly arenaEndR: number;
  /** Time the floor takes to shrink from start to end, milliseconds. */
  readonly shrinkDurationMs: number;
  /** Player circle radius, normalized to the short side. */
  readonly playerRadius: number;
  /** Acceleration from a full stick, simulation units/s^2. */
  readonly accel: number;
  /** Exponential velocity damping per second. */
  readonly friction: number;
  /** Bumper restitution (0..1). */
  readonly restitution: number;
  /** Mass scale; skins keep the same radius so every bumper has equal mass. */
  readonly massScale: number;
  /** Round wins that decide the match. */
  readonly roundsToWin: number;
  /** Pre-play countdown, milliseconds. */
  readonly countdownMs: number;
  /** How long the results screen stays before advancing, milliseconds. */
  readonly resultsMs: number;
  /** Instant speed added by a dash, simulation units/s. */
  readonly dashImpulse: number;
  /** Minimum time between dashes, milliseconds. */
  readonly dashCooldownMs: number;
  /** How long a disconnected body stays before it is removed, milliseconds. */
  readonly disconnectRemovalMs: number;
  /** Spawn ring as a fraction of `arenaStartR` (keeps spawns overlap-free). */
  readonly spawnRingScale: number;
  /** Minimum time between haptic pulses for one bumper, milliseconds. */
  readonly hitHapticCooldownMs: number;
  /** Closing speed that counts as a hit, simulation units/s. */
  readonly hitImpactThreshold: number;
  /** Simulation units per short viewport side; converts the values above. */
  readonly unitsPerView: number;
}

/** Shipped defaults (GAME-SB-DATA-01). */
export const SUMO_CONFIG: SumoConfig = Object.freeze({
  maxPlayers: 8,
  arenaStartR: 0.48,
  arenaEndR: 0.18,
  shrinkDurationMs: 60_000,
  playerRadius: 0.035,
  accel: 42,
  friction: 3.2,
  restitution: 0.65,
  massScale: 1.0,
  roundsToWin: 3,
  countdownMs: 3_000,
  resultsMs: 4_000,
  dashImpulse: 9,
  dashCooldownMs: 800,
  disconnectRemovalMs: 2_000,
  spawnRingScale: 0.72,
  hitHapticCooldownMs: 250,
  hitImpactThreshold: 3,
  unitsPerView: 16,
});

/** Test- and scene-level overrides; omitted fields keep the shipped value. */
export interface SumoConfigOptions {
  readonly countdownMs?: number;
  readonly resultsMs?: number;
  readonly roundsToWin?: number;
  readonly shrinkDurationMs?: number;
  readonly arenaStartR?: number;
  readonly arenaEndR?: number;
  readonly disconnectRemovalMs?: number;
  readonly dashImpulse?: number;
  readonly dashCooldownMs?: number;
  readonly playerRadius?: number;
}

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number.`);
  }
}

function requirePositive(name: string, value: number): void {
  requireFinite(name, value);
  if (value <= 0) {
    throw new RangeError(`${name} must be greater than zero.`);
  }
}

/** Resolves overrides over the shipped defaults and validates the result. */
export function resolveSumoConfig(options: SumoConfigOptions = {}): SumoConfig {
  const config: SumoConfig = {
    ...SUMO_CONFIG,
    countdownMs: options.countdownMs ?? SUMO_CONFIG.countdownMs,
    resultsMs: options.resultsMs ?? SUMO_CONFIG.resultsMs,
    roundsToWin: options.roundsToWin ?? SUMO_CONFIG.roundsToWin,
    shrinkDurationMs: options.shrinkDurationMs ?? SUMO_CONFIG.shrinkDurationMs,
    arenaStartR: options.arenaStartR ?? SUMO_CONFIG.arenaStartR,
    arenaEndR: options.arenaEndR ?? SUMO_CONFIG.arenaEndR,
    disconnectRemovalMs:
      options.disconnectRemovalMs ?? SUMO_CONFIG.disconnectRemovalMs,
    dashImpulse: options.dashImpulse ?? SUMO_CONFIG.dashImpulse,
    dashCooldownMs: options.dashCooldownMs ?? SUMO_CONFIG.dashCooldownMs,
    playerRadius: options.playerRadius ?? SUMO_CONFIG.playerRadius,
  };

  requirePositive("playerRadius", config.playerRadius);
  requirePositive("arenaStartR", config.arenaStartR);
  requirePositive("arenaEndR", config.arenaEndR);
  if (config.arenaStartR > 0.5) {
    throw new RangeError("arenaStartR must not exceed 0.5 (half the short side).");
  }
  if (config.arenaEndR >= config.arenaStartR) {
    throw new RangeError("arenaEndR must be smaller than arenaStartR.");
  }
  if (config.playerRadius * 2 >= config.arenaEndR) {
    throw new RangeError(
      "playerRadius must be less than half arenaEndR so the final floor fits.",
    );
  }
  requirePositive("shrinkDurationMs", config.shrinkDurationMs);
  // createMatch() requires an integer countdown; reject fractional values here
  // so a bad override fails at construction, not on the first host init.
  if (!Number.isInteger(config.countdownMs) || config.countdownMs < 0) {
    throw new RangeError("countdownMs must be a non-negative integer.");
  }
  if (!Number.isInteger(config.resultsMs) || config.resultsMs < 0) {
    throw new RangeError("resultsMs must be a non-negative integer.");
  }
  if (!Number.isInteger(config.roundsToWin) || config.roundsToWin < 1) {
    throw new RangeError("roundsToWin must be an integer >= 1.");
  }
  requireFinite("dashImpulse", config.dashImpulse);
  if (config.dashImpulse < 0) {
    throw new RangeError("dashImpulse must not be negative.");
  }
  requireFinite("dashCooldownMs", config.dashCooldownMs);
  if (config.dashCooldownMs < 0) {
    throw new RangeError("dashCooldownMs must not be negative.");
  }
  requireFinite("disconnectRemovalMs", config.disconnectRemovalMs);
  if (config.disconnectRemovalMs < 0) {
    throw new RangeError("disconnectRemovalMs must not be negative.");
  }
  requirePositive("unitsPerView", config.unitsPerView);

  return Object.freeze(config);
}

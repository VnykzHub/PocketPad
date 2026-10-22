/**
 * Coin Run tuning (GAME-PF-02/GAME-PF-03; PR-9.3).
 *
 * Every value here is a design target, not a measurement. Player feel lives in
 * this file so `player.ts` contains physics and rules, not magic pixels
 * (GAME-PF-03 anti-rework). Units are world units and milliseconds; the world
 * is y-down, so positive `gravity` accelerates toward larger y.
 *
 * Jump reach is derived from `jumpVelocity` and `gravity`, not stored as a
 * separate constant: `jumpVelocity^2 / (2 * gravity)` is the continuous apex
 * (~2.95 units). `level.test.ts` uses it to reject an unreachable level.
 */
export interface CoinRunConfig {
  /** Slots the world preallocates (GAME-PF-02; PR-9.4). */
  readonly maxPlayers: number;
  /** Player collider radius (GAME-PF-03; C9). */
  readonly playerRadius: number;
  /** Trigger radius for a coin centre (GAME-PF-02). */
  readonly coinRadius: number;
  /** Trigger radius for a checkpoint centre (GAME-PF-02). */
  readonly checkpointRadius: number;
  /** Maximum horizontal speed, world units/s. */
  readonly moveSpeed: number;
  /** Horizontal acceleration, world units/s^2. */
  readonly accel: number;
  /** Downward acceleration, world units/s^2. */
  readonly gravity: number;
  /** Upward speed applied on a jump, world units/s. */
  readonly jumpVelocity: number;
  /** Terminal fall speed, world units/s. */
  readonly maxFall: number;
  /** Grace period after leaving ground during which a jump still works, ms. */
  readonly coyoteMs: number;
  /** Time a jump press is remembered while airborne, ms. */
  readonly jumpBufferMs: number;
  /** Delay before a fallen player respawns, ms. */
  readonly respawnMs: number;
  /** Post-respawn no-penalty window exposed to presentation, ms. */
  readonly invulnMs: number;
  /** Extra separation applied after a platform contact, world units. */
  readonly skin: number;
}

export const COIN_RUN_CONFIG: CoinRunConfig = Object.freeze({
  maxPlayers: 4,
  playerRadius: 0.4,
  coinRadius: 0.35,
  checkpointRadius: 1.5,
  moveSpeed: 9,
  accel: 60,
  gravity: 55,
  jumpVelocity: 18,
  maxFall: 30,
  coyoteMs: 80,
  jumpBufferMs: 100,
  respawnMs: 750,
  invulnMs: 1000,
  skin: 0.01,
});

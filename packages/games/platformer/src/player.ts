/**
 * Coin Run player physics (GAME-PF-03; FR-7.11/7.12, FR-8.10, C9, PR-9.3).
 *
 * One pooled `PlayerState` per slot. `stepPlayer` is a pure function of the
 * player, the world data and the fixed `dt`: no wall clock, no randomness, no
 * allocation. Circle/AABB resolution comes from the runtime physics contract
 * (`resolveCircleAabb`, `integrate`); this module only supplies body
 * parameters, contact classification, coyote/buffer feel and respawn rules.
 *
 * y is down. A platform top is `box.y`, so a resting circle has
 * `body.y === box.y - body.radius` and a ground contact normal of (0, -1).
 *
 * Contact pipeline per tick:
 *   gravity/accel -> jump -> integrate -> resolve near platforms -> kill plane
 *
 * A face contact gets `skin` extra separation (0.01) so a circle resting on a
 * seam is not resolved twice into jitter. A top contact is then snapped to the
 * exact surface; runtime resolution already picks the smaller penetration
 * axis, so a platform corner never traps the circle.
 */
import {
  integrate,
  resolveCircleAabb,
  type CircleBody,
  type Contact,
} from "@lanpad/runtime";
import { COIN_RUN_CONFIG } from "./config.js";
import { createPlayerCommand, type PlayerCommand } from "./input.js";
import type { World } from "./world.js";

/**
 * A contact normal at least this vertical counts as a ground surface. Runtime
 * top contacts are exactly -1; a diagonal corner contact stays a wall so the
 * player is not teleported up the side of a platform.
 */
const GROUND_NORMAL_Y = -0.9;

/** One pooled character. Commands and contacts are reused every tick. */
export interface PlayerState {
  /** Slot number 1..4; also the `CircleBody.id`. */
  readonly slot: number;
  /** Pooled physics body (radius from `COIN_RUN_CONFIG`). */
  readonly body: CircleBody;
  /** Latest command, written by `readCommand` (GAME-PF-03). */
  readonly command: PlayerCommand;
  /** Reused collision result, so `resolveCircleAabb` never allocates. */
  readonly contact: Contact;
  /** Level start centre for this slot. */
  spawnX: number;
  spawnY: number;
  /** Last checkpoint reached, or -1 for the level start. */
  checkpointIndex: number;
  /** True while a platform top contact was resolved this tick. */
  grounded: boolean;
  /** Coyote grace remaining in ms (FR-7.12 feel). */
  coyoteRemaining: number;
  /** Jump buffer remaining in ms. */
  jumpBufferRemaining: number;
  /** True while waiting out `respawnMs` below the kill plane. */
  falling: boolean;
  /** Respawn delay remaining in ms. */
  respawnRemaining: number;
  /** Presentation-only no-penalty window after a respawn, ms. */
  invulnRemaining: number;
  /** Diagnostic counter: jumps actually applied (never used by rules). */
  jumpCount: number;
}

/** Builds one pooled player, including its body, command and contact. */
export function createPlayerState(
  slot: number,
  spawnX: number,
  spawnY: number,
): PlayerState {
  return {
    slot,
    body: {
      x: spawnX,
      y: spawnY,
      vx: 0,
      vy: 0,
      radius: COIN_RUN_CONFIG.playerRadius,
      mass: 1,
      restitution: 0,
      friction: 0,
      active: true,
      id: slot,
    },
    command: createPlayerCommand(),
    contact: { nx: 0, ny: 0, depth: 0 },
    spawnX,
    spawnY,
    checkpointIndex: -1,
    grounded: false,
    coyoteRemaining: 0,
    jumpBufferRemaining: 0,
    falling: false,
    respawnRemaining: 0,
    invulnRemaining: 0,
    jumpCount: 0,
  };
}

/**
 * Restores a player to level start without constructing anything (PR-9.4).
 * Called by `World.reset()` for every pooled slot, including rematch resets.
 */
export function resetPlayer(player: PlayerState, world: World): void {
  const body = player.body;
  body.x = player.spawnX;
  body.y = player.spawnY;
  body.vx = 0;
  body.vy = 0;
  body.active = player.slot <= world.level.spawns.length;
  player.checkpointIndex = -1;
  player.grounded = false;
  player.coyoteRemaining = 0;
  player.jumpBufferRemaining = 0;
  player.falling = false;
  player.respawnRemaining = 0;
  player.invulnRemaining = 0;
  player.jumpCount = 0;
  player.command.moveX = 0;
  player.command.jumpPressed = false;
  player.contact.nx = 0;
  player.contact.ny = 0;
  player.contact.depth = 0;
}

/**
 * Places a fallen player at their last checkpoint (or spawn), zeroes velocity
 * and starts the invulnerability window. Platform collision still applies
 * while `invulnRemaining > 0`; the flag is presentation-only in Minimal.
 */
export function respawnPlayer(player: PlayerState, world: World): void {
  const body = player.body;
  const index = player.checkpointIndex;
  const checkpoint =
    index >= 0 && index < world.checkpoints.length ? world.checkpoints[index] : undefined;
  if (checkpoint !== undefined) {
    body.x = checkpoint.x;
    body.y = checkpoint.y;
  } else {
    body.x = player.spawnX;
    body.y = player.spawnY;
  }
  body.vx = 0;
  body.vy = 0;
  player.falling = false;
  player.respawnRemaining = 0;
  player.grounded = false;
  player.coyoteRemaining = 0;
  player.jumpBufferRemaining = 0;
  player.invulnRemaining = COIN_RUN_CONFIG.invulnMs;
}

/**
 * Advances one player by one fixed tick.
 *
 * `player.command` must already hold this tick's command (the pool is owned by
 * the player, so the caller writes it with `readCommand` and this function
 * allocates nothing). A dormant slot (`body.active === false`) is skipped so
 * pooled objects cost nothing when fewer than four phones are connected.
 */
export function stepPlayer(player: PlayerState, world: World, dt: number): void {
  const body = player.body;
  if (!body.active || !(dt > 0)) {
    return;
  }

  const dtMs = dt * 1000;

  if (player.falling) {
    player.respawnRemaining -= dtMs;
    if (player.respawnRemaining <= 0) {
      respawnPlayer(player, world);
    }
    return;
  }

  if (player.invulnRemaining > 0) {
    player.invulnRemaining -= dtMs;
    if (player.invulnRemaining < 0) player.invulnRemaining = 0;
  }

  const wasGrounded = player.grounded;
  if (wasGrounded) {
    player.coyoteRemaining = COIN_RUN_CONFIG.coyoteMs;
  } else if (player.coyoteRemaining > 0) {
    player.coyoteRemaining -= dtMs;
    if (player.coyoteRemaining < 0) player.coyoteRemaining = 0;
  }

  if (player.command.jumpPressed) {
    player.jumpBufferRemaining = COIN_RUN_CONFIG.jumpBufferMs;
  } else if (player.jumpBufferRemaining > 0) {
    player.jumpBufferRemaining -= dtMs;
    if (player.jumpBufferRemaining < 0) player.jumpBufferRemaining = 0;
  }

  // Horizontal: approach the target speed at a bounded acceleration.
  const targetVx = player.command.moveX * COIN_RUN_CONFIG.moveSpeed;
  const maxDelta = COIN_RUN_CONFIG.accel * dt;
  if (body.vx < targetVx) {
    body.vx = Math.min(targetVx, body.vx + maxDelta);
  } else if (body.vx > targetVx) {
    body.vx = Math.max(targetVx, body.vx - maxDelta);
  }

  // Gravity before the jump impulse: a jump starts at exactly jumpVelocity.
  body.vy += COIN_RUN_CONFIG.gravity * dt;
  if (body.vy > COIN_RUN_CONFIG.maxFall) {
    body.vy = COIN_RUN_CONFIG.maxFall;
  }

  if (player.jumpBufferRemaining > 0 && (wasGrounded || player.coyoteRemaining > 0)) {
    body.vy = -COIN_RUN_CONFIG.jumpVelocity;
    player.jumpBufferRemaining = 0;
    player.coyoteRemaining = 0;
    player.jumpCount += 1;
  }
  player.grounded = false;

  integrate(body, dt, world.arena);
  resolvePlatforms(player, world);

  if (world.isBelowKillPlane(player)) {
    player.falling = true;
    player.respawnRemaining = COIN_RUN_CONFIG.respawnMs;
    player.grounded = false;
    body.vx = 0;
    body.vy = 0;
  }
}

/** Resolves every platform that can touch this body, then classifies ground. */
function resolvePlatforms(player: PlayerState, world: World): void {
  const body = player.body;
  const radius = body.radius;
  const platforms = world.platforms;
  const start = world.platformWindowStart(body.x, radius);
  let grounded = false;

  for (let i = start; i < platforms.length; i += 1) {
    const box = platforms[i];
    if (box === undefined || box.x > body.x + radius) {
      break;
    }
    const vyBefore = body.vy;
    if (!resolveCircleAabb(body, box, player.contact)) {
      continue;
    }
    const nx = player.contact.nx;
    const ny = player.contact.ny;

    // Extra separation; a top contact is snapped back to the exact surface.
    body.x += nx * COIN_RUN_CONFIG.skin;
    body.y += ny * COIN_RUN_CONFIG.skin;

    if (ny <= GROUND_NORMAL_Y && vyBefore >= 0) {
      body.y = box.y - radius;
      if (body.vy > 0) body.vy = 0;
      grounded = true;
    }
  }

  if (grounded) {
    player.grounded = true;
    player.coyoteRemaining = COIN_RUN_CONFIG.coyoteMs;
  }
}

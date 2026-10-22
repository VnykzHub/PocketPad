/**
 * Coin Run pooled world (GAME-PF-02; PR-9.3/9.4/9.5, C9).
 *
 * Setup constructs every object once: four player slots, the full coin and
 * checkpoint arrays, a preallocated arena and a reusable contact per player.
 * `reset()` only writes flags and positions, so a rematch allocates nothing.
 *
 * Platform lookup uses an x-sorted array plus a binary-search lower bound and
 * an x-bounded scan (`platformWindowStart`). Sorting by left edge alone is not
 * enough because one wide ground segment can reach past many narrower
 * platforms, so the lower bound backs off by the widest platform. The scan
 * stops at the first platform starting beyond the circle's right edge. No
 * `map`/`filter` runs during simulation.
 *
 * Trigger queries (coins, checkpoints, goal) are read-only overlap tests; they
 * never resolve a body or feed impulses back into runtime physics.
 */
import type { Arena } from "@lanpad/runtime";
import { COIN_RUN_CONFIG } from "./config.js";
import {
  circleIntersectsAabb,
  type Goal,
  type LevelData,
  type PlatformAabb,
} from "./level.js";
import { createPlayerState, resetPlayer, type PlayerState } from "./player.js";

/** A pooled coin; `collected` is the only mutable field. */
export interface CoinState {
  x: number;
  y: number;
  collected: boolean;
}

/** A pooled checkpoint; `activated` is shared by all players on the level. */
export interface CheckpointState {
  x: number;
  y: number;
  activated: boolean;
}

export class World {
  readonly level: LevelData;
  /** Platforms sorted by left edge (x), with `maxPlatformWidth` lookback. */
  readonly platforms: PlatformAabb[];
  /** Exactly four pooled slots, index `slot - 1` (PR-9.4). */
  readonly players: PlayerState[];
  /** Full coin array, preallocated at construction. */
  readonly coins: CoinState[];
  /** Full checkpoint array, preallocated at construction. */
  readonly checkpoints: CheckpointState[];
  /** Goal rectangle copied from the level. */
  readonly goal: Goal;
  /** Reusable arena for `integrate`; never reallocated per tick. */
  readonly arena: Arena;
  /** Widest platform; the lower-bound lookback for the query window. */
  readonly maxPlatformWidth: number;
  /** Team coins collected since the last reset (rules owns the score copy). */
  coinsCollected: number;
  /** True once any player has touched the goal this round. */
  goalReached: boolean;

  constructor(level: LevelData) {
    this.level = level;

    const platforms = level.platforms.slice();
    platforms.sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    this.platforms = platforms;

    let maxPlatformWidth = 0;
    for (let i = 0; i < platforms.length; i += 1) {
      const platform = platforms[i];
      if (platform !== undefined && platform.w > maxPlatformWidth) {
        maxPlatformWidth = platform.w;
      }
    }
    this.maxPlatformWidth = maxPlatformWidth;

    const players: PlayerState[] = [];
    const firstSpawn = level.spawns[0];
    if (firstSpawn === undefined) {
      throw new Error("World: level has no spawn point");
    }
    for (let i = 0; i < COIN_RUN_CONFIG.maxPlayers; i += 1) {
      const spawn = level.spawns[i] ?? firstSpawn;
      const player = createPlayerState(i + 1, spawn.x, spawn.y);
      player.body.active = i < level.spawns.length;
      players.push(player);
    }
    this.players = players;

    const coins: CoinState[] = [];
    for (let i = 0; i < level.coins.length; i += 1) {
      const coin = level.coins[i];
      if (coin !== undefined) {
        coins.push({ x: coin.x, y: coin.y, collected: false });
      }
    }
    this.coins = coins;

    const checkpoints: CheckpointState[] = [];
    for (let i = 0; i < level.checkpoints.length; i += 1) {
      const checkpoint = level.checkpoints[i];
      if (checkpoint !== undefined) {
        checkpoints.push({ x: checkpoint.x, y: checkpoint.y, activated: false });
      }
    }
    this.checkpoints = checkpoints;

    this.goal = {
      x: level.goal.x,
      y: level.goal.y,
      w: level.goal.w,
      h: level.goal.h,
    };

    // Side walls live in the arena, not in platform data (GAME-PF-02 risks).
    this.arena = {
      minX: 0,
      maxX: level.width,
      minY: -1000,
      maxY: level.killY + 10,
    };

    this.coinsCollected = 0;
    this.goalReached = false;
  }

  /**
   * Restores every pooled object to round start. Player positions, coin and
   * checkpoint flags, goal state and score counters are written in place.
   */
  reset(): void {
    const players = this.players;
    for (let i = 0; i < players.length; i += 1) {
      const player = players[i];
      if (player !== undefined) resetPlayer(player, this);
    }
    const coins = this.coins;
    for (let i = 0; i < coins.length; i += 1) {
      const coin = coins[i];
      if (coin !== undefined) coin.collected = false;
    }
    const checkpoints = this.checkpoints;
    for (let i = 0; i < checkpoints.length; i += 1) {
      const checkpoint = checkpoints[i];
      if (checkpoint !== undefined) checkpoint.activated = false;
    }
    this.coinsCollected = 0;
    this.goalReached = false;
  }

  /**
   * First sorted-platform index that can possibly overlap a circle.
   *
   * The lookback by `maxPlatformWidth` covers a wide ground segment whose left
   * edge is far to the left. The caller scans forward while
   * `platform.x <= circle.x + radius` (PR-9.5).
   */
  platformWindowStart(x: number, radius: number): number {
    const minX = x - radius - this.maxPlatformWidth;
    let low = 0;
    let high = this.platforms.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const platform = this.platforms[mid];
      if (platform !== undefined && platform.x < minX) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /**
   * Collects every uncollected coin within reach of a player and returns the
   * number collected this tick. Read-only with respect to physics (C9).
   */
  collectCoins(player: PlayerState): number {
    const reach = player.body.radius + COIN_RUN_CONFIG.coinRadius;
    const reachSq = reach * reach;
    const coins = this.coins;
    let collected = 0;
    for (let i = 0; i < coins.length; i += 1) {
      const coin = coins[i];
      if (coin === undefined || coin.collected) continue;
      const dx = coin.x - player.body.x;
      const dy = coin.y - player.body.y;
      if (dx * dx + dy * dy <= reachSq) {
        coin.collected = true;
        collected += 1;
      }
    }
    this.coinsCollected += collected;
    return collected;
  }

  /**
   * Marks a checkpoint activated and remembers the furthest one this player
   * reached. Returns true when the player's respawn point advanced.
   */
  activateCheckpoint(player: PlayerState): boolean {
    const reach = player.body.radius + COIN_RUN_CONFIG.checkpointRadius;
    const reachSq = reach * reach;
    let newest = -1;
    const checkpoints = this.checkpoints;
    for (let i = 0; i < checkpoints.length; i += 1) {
      const checkpoint = checkpoints[i];
      if (checkpoint === undefined) continue;
      const dx = checkpoint.x - player.body.x;
      const dy = checkpoint.y - player.body.y;
      if (dx * dx + dy * dy <= reachSq) {
        checkpoint.activated = true;
        newest = i;
      }
    }
    if (newest > player.checkpointIndex) {
      player.checkpointIndex = newest;
      return true;
    }
    return false;
  }

  /** Read-only goal overlap; the first player to touch ends the level. */
  touchesGoal(player: PlayerState): boolean {
    return circleIntersectsAabb(
      player.body.x,
      player.body.y,
      player.body.radius,
      this.goal,
    );
  }

  /** Sets the shared goal flag once; returns true only for the first touch. */
  reachGoal(player: PlayerState): boolean {
    if (this.goalReached || !this.touchesGoal(player)) {
      return false;
    }
    this.goalReached = true;
    return true;
  }

  /** Kill-plane predicate: the collider's feet are below `level.killY`. */
  isBelowKillPlane(player: PlayerState): boolean {
    return player.body.y - player.body.radius > this.level.killY;
  }
}

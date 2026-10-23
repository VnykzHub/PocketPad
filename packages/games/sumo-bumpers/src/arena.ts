/**
 * Arena geometry for Sumo Bumpers (GAME-SB-HOST-01, GAME-SB-TEST-02/03).
 *
 * The arena is a circle centred on the origin, sized in normalized units of
 * the smaller viewport dimension (GAME-SB-DATA-02). It shrinks linearly from
 * `arenaStartR` to `arenaEndR` over `shrinkDurationMs`, then holds. A player
 * is eliminated only when its whole body is outside — that is, its centre is
 * farther from the origin than the arena radius plus its own radius — so a
 * bumper half over the edge is still in play.
 *
 * Everything here is pure and allocation-free when given an output object, so
 * the per-tick pass can reuse one point record for every spawn.
 */

import type { SumoConfig } from "./config.js";

/** Reused spawn output; callers own one per spawn pass. */
export interface ArenaPoint {
  x: number;
  y: number;
}

/**
 * Arena radius at `elapsedMs` of the current round.
 *
 * Monotonic non-increasing: before the shrink starts it is `arenaStartR`, at
 * or after `shrinkDurationMs` it is `arenaEndR`. Non-finite or negative times
 * clamp to the start radius, which keeps a bad frame from collapsing the floor.
 */
export function arenaRadiusAt(config: SumoConfig, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return config.arenaStartR;
  if (elapsedMs >= config.shrinkDurationMs) return config.arenaEndR;
  const progress = elapsedMs / config.shrinkDurationMs;
  return config.arenaStartR + (config.arenaEndR - config.arenaStartR) * progress;
}

/**
 * True when a bumper at `(x, y)` is entirely beyond the floor edge.
 *
 * The floor is drawn as a filled circle of `arenaRadius`; a bumper is out only
 * when the nearest point of its own circle is at or beyond the rim.
 */
export function isFullyOutside(
  x: number,
  y: number,
  radius: number,
  arenaRadius: number,
): boolean {
  const distanceSq = x * x + y * y;
  const threshold = arenaRadius + radius;
  // Compare squared lengths to avoid a square root on the hot path.
  return distanceSq >= threshold * threshold;
}

/**
 * Writes the spawn point for player `index` of `count` onto a ring of
 * `spawnRadius`. Slots start at the top (-90 degrees) and go clockwise, so a
 * two-player match faces off vertically and an eight-player match is evenly
 * spread. The plan's spawn ring is `arenaStartR * spawnRingScale`; adjacent
 * points are at least `spawnRadius * 2 * sin(pi / count)` apart, which exceeds
 * two bumper radii for every supported count.
 */
export function spawnPoint(
  index: number,
  count: number,
  spawnRadius: number,
  out: ArenaPoint,
): ArenaPoint {
  const total = Number.isInteger(count) && count > 0 ? count : 1;
  const slot = Number.isInteger(index) && index >= 0 ? index : 0;
  const angle = -Math.PI / 2 + (slot / total) * Math.PI * 2;
  out.x = Math.cos(angle) * spawnRadius;
  out.y = Math.sin(angle) * spawnRadius;
  return out;
}

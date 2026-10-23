import { describe, expect, test } from "vitest";
import { DIRECTION_LEFT, DIRECTION_RIGHT } from "../src/config.js";
import { SnakeWorld, type SnakeWorldOptions } from "../src/world.js";

/**
 * Elimination, winner and disconnect rules (GAME-SR-TEST-04/06;
 * GAME-SR-HOST-05).
 *
 * The host maps presence onto `SnakeWorld.setConnected`; the world owns the
 * grace clock so the rule is testable without a host loop. All runs are
 * bounded and deterministic: no turns means every snake walks a straight line
 * into a wall, so an eight-snake round always resolves.
 */

const ZERO_RNG = (): number => 0;

function createWorld(options: SnakeWorldOptions = {}): SnakeWorld {
  return new SnakeWorld(ZERO_RNG, options);
}

function cell(world: SnakeWorld, x: number, y: number): number {
  return world.cellIndex(x, y);
}

function rosterMask(count: number): number {
  let mask = 0;
  for (let slot = 1; slot <= count; slot += 1) {
    mask |= 1 << slot;
  }
  return mask;
}

describe("Snake Royale round rules", () => {
  test("[GAME-SR-TEST-04] the last snake alive wins, and a double elimination is a draw", () => {
    const winnerWorld = createWorld({ gridSize: 8, foodCount: 0 });
    winnerWorld.placeSnake(1, [cell(winnerWorld, 0, 4), cell(winnerWorld, 1, 4)], DIRECTION_LEFT);
    winnerWorld.placeSnake(2, [cell(winnerWorld, 4, 4), cell(winnerWorld, 3, 4)], DIRECTION_RIGHT);
    winnerWorld.step();
    expect(winnerWorld.snakes[0]?.alive).toBe(false);
    expect(winnerWorld.snakes[1]?.alive).toBe(true);
    expect(winnerWorld.winnerSlot()).toBe(2);

    const drawWorld = createWorld({ gridSize: 8, foodCount: 0 });
    drawWorld.placeSnake(1, [cell(drawWorld, 0, 2), cell(drawWorld, 1, 2)], DIRECTION_LEFT);
    drawWorld.placeSnake(2, [cell(drawWorld, 0, 6), cell(drawWorld, 1, 6)], DIRECTION_LEFT);
    drawWorld.step();
    expect(drawWorld.aliveCount).toBe(0);
    expect(drawWorld.winnerSlot()).toBeNull();
  });

  test("[GAME-SR-TEST-04] an eight-snake startRound resolves within 200 steps", () => {
    const world = createWorld({ foodCount: 3 });
    world.startRound(rosterMask(8));
    expect(world.aliveCount).toBe(8);

    let steps = 0;
    while (world.aliveCount > 1 && steps < 200) {
      world.step();
      steps += 1;
    }

    expect(steps).toBeLessThanOrEqual(200);
    expect(world.aliveCount).toBeLessThanOrEqual(1);
    if (world.aliveCount === 1) {
      expect(world.winnerSlot()).not.toBeNull();
    } else {
      expect(world.winnerSlot()).toBeNull();
    }
  });

  test("[GAME-SR-HOST-05][GAME-SR-TEST-06] a disconnect eliminates the snake only after the grace window", () => {
    const world = createWorld({ gridSize: 24, foodCount: 0, respawnGraceMs: 500 });
    world.placeSnake(
      1,
      [cell(world, 5, 5), cell(world, 4, 5), cell(world, 3, 5), cell(world, 2, 5)],
      DIRECTION_RIGHT,
    );
    world.placeSnake(
      2,
      [cell(world, 10, 10), cell(world, 9, 10), cell(world, 8, 10), cell(world, 7, 10)],
      DIRECTION_RIGHT,
    );
    world.setConnected(1, false);

    world.update(499);
    expect(world.snakes[0]?.alive).toBe(true);
    expect(world.snakes[0]?.disconnectedMs).toBe(375);

    world.update(1);
    expect(world.snakes[0]?.alive).toBe(false);
    expect(world.snakes[1]?.alive).toBe(true);
    expect(world.winnerSlot()).toBe(2);
  });

  test("[GAME-SR-HOST-05] reconnecting inside the grace window resets the deadline", () => {
    const world = createWorld({ gridSize: 24, foodCount: 0, respawnGraceMs: 500 });
    world.placeSnake(
      1,
      [cell(world, 5, 5), cell(world, 4, 5), cell(world, 3, 5), cell(world, 2, 5)],
      DIRECTION_RIGHT,
    );
    world.placeSnake(
      2,
      [cell(world, 10, 10), cell(world, 9, 10), cell(world, 8, 10), cell(world, 7, 10)],
      DIRECTION_RIGHT,
    );

    world.setConnected(1, false);
    world.update(375);
    expect(world.snakes[0]?.alive).toBe(true);

    world.setConnected(1, true);
    expect(world.snakes[0]?.disconnectedMs).toBe(0);
    world.setConnected(1, false);

    world.update(499);
    expect(world.snakes[0]?.alive).toBe(true);
    world.update(1);
    expect(world.snakes[0]?.alive).toBe(false);
  });
});

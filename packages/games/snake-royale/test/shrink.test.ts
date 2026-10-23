import { describe, expect, test } from "vitest";
import { DIRECTION_RIGHT } from "../src/config.js";
import { SnakeWorld, type SnakeWorldOptions } from "../src/world.js";

/**
 * Shrinking arena rules (GAME-SR-HOST-03; GAME-SR-TEST-03).
 *
 * The production cadence is 15 s (asserted in `world.test.ts`); these tests
 * scale the clock down so the ring schedule is exercised without waiting.
 * Every expectation is on the public world state, never on internals.
 */

const ZERO_RNG = (): number => 0;

function createWorld(options: SnakeWorldOptions = {}): SnakeWorld {
  return new SnakeWorld(ZERO_RNG, options);
}

function cell(world: SnakeWorld, x: number, y: number): number {
  return world.cellIndex(x, y);
}

function wallCount(world: SnakeWorld): number {
  return world.walls.reduce((sum, value) => sum + value, 0);
}

describe("Snake Royale shrinking arena", () => {
  test("[GAME-SR-HOST-03][GAME-SR-TEST-03] rings wall on cadence and stop at a 2x2 arena", () => {
    const world = createWorld({ gridSize: 8, shrinkEveryMs: 100, foodCount: 0 });
    expect(world.wallInset).toBe(0);
    expect(world.maxInset).toBe(3);
    expect(world.shrinkRemainingMs).toBe(100);

    world.update(99);
    expect(world.wallInset).toBe(0);
    expect(world.shrinkRemainingMs).toBe(1);

    world.update(1);
    expect(world.wallInset).toBe(1);
    expect(world.walls[cell(world, 0, 0)]).toBe(1);
    expect(world.walls[cell(world, 7, 3)]).toBe(1);
    expect(world.walls[cell(world, 4, 4)]).toBe(0);
    expect(world.shrinkRemainingMs).toBe(100);

    world.update(150);
    expect(world.wallInset).toBe(2);
    expect(world.shrinkRemainingMs).toBe(50);

    world.update(1000);
    expect(world.wallInset).toBe(3);
    // The schedule keeps ticking; a due ring at the cap is a no-op.
    expect(world.shrinkRemainingMs).toBe(50);
    // Three rings remove 60 of the 64 cells, leaving the 2x2 interior.
    expect(wallCount(world)).toBe(60);
    expect(world.walls[cell(world, 3, 3)]).toBe(0);
    expect(world.walls[cell(world, 4, 4)]).toBe(0);

    world.shrink();
    expect(world.wallInset).toBe(3);
  });

  test("[GAME-SR-HOST-03][GAME-SR-TEST-03] a snake on the removed ring is eliminated; interior snakes survive", () => {
    const world = createWorld({ gridSize: 8, foodCount: 0 });
    world.placeSnake(1, [cell(world, 0, 0)], DIRECTION_RIGHT);
    world.placeSnake(2, [cell(world, 3, 3)], DIRECTION_RIGHT);
    expect(world.aliveCount).toBe(2);

    world.shrink();
    expect(world.snakes[0]?.alive).toBe(false);
    expect(world.snakes[1]?.alive).toBe(true);
    expect(world.aliveCount).toBe(1);
    expect(world.winnerSlot()).toBe(2);
  });

  test("[GAME-SR-HOST-03] food on a removed ring is cleared and refilled inside", () => {
    const world = createWorld({ gridSize: 8, foodCount: 1 });
    expect(world.placeFoodAt(0, 0)).toBe(true);
    expect(world.activeFoodCount).toBe(1);

    world.shrink();
    expect(world.foodCells[cell(world, 0, 0)]).toBe(0);
    expect(world.activeFoodCount).toBe(1);
    for (let index = 0; index < world.activeFoodCount; index += 1) {
      expect(world.walls[cell(world, world.foodX(index), world.foodY(index))]).toBe(0);
    }
  });
});

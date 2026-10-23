import { describe, expect, test } from "vitest";
import {
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  SNAKE_ROYALE_CONFIG,
  STEP_INTERVAL_MS,
} from "../src/config.js";
import { SnakeWorld, type SnakeWorldOptions } from "../src/world.js";

/**
 * Grid simulation rules (GAME-SR-HOST-01/02/03; GAME-SR-DATA-01/02;
 * GAME-SR-TEST-01/02).
 *
 * These tests drive the deterministic world directly: no host loop, no
 * renderer. A zero RNG makes food placement reproducible so failures are
 * always repeatable.
 */

const ZERO_RNG = (): number => 0;

function createWorld(options: SnakeWorldOptions = {}): SnakeWorld {
  return new SnakeWorld(ZERO_RNG, options);
}

function cell(world: SnakeWorld, x: number, y: number): number {
  return world.cellIndex(x, y);
}

function headOf(world: SnakeWorld, slot: number): { x: number; y: number } {
  const snake = world.snakes[slot - 1];
  if (snake === undefined) {
    throw new Error(`slot ${slot} has no snake state`);
  }
  const head = snake.cells[0] ?? 0;
  return { x: world.cellX(head), y: world.cellY(head) };
}

/** One bit per slot from 1..count. */
function rosterMask(count: number): number {
  let mask = 0;
  for (let slot = 1; slot <= count; slot += 1) {
    mask |= 1 << slot;
  }
  return mask;
}

describe("Snake Royale world", () => {
  test("[GAME-SR-DATA-01] the frozen play contract matches the plan", () => {
    expect(SNAKE_ROYALE_CONFIG).toEqual({
      gridSize: 32,
      stepHz: 8,
      initialLength: 4,
      shrinkEveryMs: 15000,
      foodCount: 3,
      respawnGraceMs: 5000,
      countdownMs: 3000,
      maxPlayers: 8,
    });
    expect(STEP_INTERVAL_MS).toBe(125);
  });

  test("[GAME-SR-HOST-01][GAME-SR-HOST-02] a straight snake advances one cell per 125 ms step", () => {
    const world = createWorld({ foodCount: 0 });
    expect(world.spawnSnakeAt(1, 4, 4, DIRECTION_RIGHT, 3)).toBe(true);
    expect(headOf(world, 1)).toEqual({ x: 4, y: 4 });

    world.update(124);
    expect(world.stepCount).toBe(0);
    expect(headOf(world, 1)).toEqual({ x: 4, y: 4 });

    world.update(1);
    expect(world.stepCount).toBe(1);
    expect(headOf(world, 1)).toEqual({ x: 5, y: 4 });
    const snake = world.snakes[0];
    expect(snake?.cells[1]).toBe(cell(world, 4, 4));
    expect(snake?.cells[2]).toBe(cell(world, 3, 4));
  });

  test("[GAME-SR-DATA-02] startRound spaces 2 and 8 snakes without overlap or food underneath", () => {
    for (const count of [2, 8]) {
      const world = createWorld();
      world.startRound(rosterMask(count));
      expect(world.participantCount).toBe(count);
      expect(world.aliveCount).toBe(count);

      const occupied = new Set<number>();
      for (let slot = 1; slot <= count; slot += 1) {
        const snake = world.snakes[slot - 1];
        if (snake === undefined) {
          throw new Error(`missing snake ${slot}`);
        }
        expect(snake.participating).toBe(true);
        expect(snake.alive).toBe(true);
        expect(snake.length).toBe(4);
        for (let segment = 0; segment < snake.length; segment += 1) {
          const snakeCell = snake.cells[segment] ?? -1;
          expect(occupied.has(snakeCell), `duplicate cell ${snakeCell}`).toBe(false);
          occupied.add(snakeCell);
        }
      }

      expect(world.activeFoodCount).toBe(3);
      for (let index = 0; index < world.activeFoodCount; index += 1) {
        const foodCell = cell(world, world.foodX(index), world.foodY(index));
        expect(occupied.has(foodCell)).toBe(false);
        expect(world.walls[foodCell]).toBe(0);
      }
    }
  });

  test("[GAME-SR-HOST-02][GAME-SR-TEST-01] eating food grows by one and refills on a free cell", () => {
    const world = createWorld({ gridSize: 8, foodCount: 1, initialLength: 3 });
    world.placeSnake(
      1,
      [cell(world, 3, 3), cell(world, 2, 3), cell(world, 1, 3)],
      DIRECTION_RIGHT,
    );
    expect(world.placeFoodAt(4, 3)).toBe(true);
    expect(world.activeFoodCount).toBe(1);

    world.step();
    const snake = world.snakes[0];
    expect(snake?.alive).toBe(true);
    expect(snake?.length).toBe(4);
    expect(snake?.foodEaten).toBe(1);
    expect(snake?.cells[0]).toBe(cell(world, 4, 3));
    // The tail stays put on a growth step.
    expect(snake?.cells[3]).toBe(cell(world, 1, 3));
    expect(world.foodCells[cell(world, 4, 3)]).toBe(0);
    expect(world.activeFoodCount).toBe(1);

    const refilled = cell(world, world.foodX(0), world.foodY(0));
    expect(refilled).not.toBe(cell(world, 4, 3));
    expect(world.occupancy[refilled]).toBe(0);
  });

  test("[GAME-SR-TEST-01][GAME-SR-CTRL-02] reversals and repeats are rejected; a perpendicular turn applies next step", () => {
    const world = createWorld({ foodCount: 0 });
    world.spawnSnakeAt(1, 10, 10, DIRECTION_RIGHT, 3);

    expect(world.queueTurn(1, DIRECTION_LEFT)).toBe(false);
    expect(world.queueTurn(1, DIRECTION_RIGHT)).toBe(false);
    expect(world.snakes[0]?.direction).toBe(DIRECTION_RIGHT);
    expect(world.snakes[0]?.turn).toBe(-1);

    expect(world.queueTurn(1, DIRECTION_UP)).toBe(true);
    expect(world.snakes[0]?.turn).toBe(DIRECTION_UP);
    world.step();
    expect(world.snakes[0]?.direction).toBe(DIRECTION_UP);
    expect(headOf(world, 1)).toEqual({ x: 10, y: 9 });

    world.setConnected(1, false);
    expect(world.queueTurn(1, 0)).toBe(false);
  });

  test("[GAME-SR-TEST-01] moving into your own body eliminates you", () => {
    const world = createWorld({ foodCount: 0 });
    world.placeSnake(
      1,
      [
        cell(world, 4, 4),
        cell(world, 4, 5),
        cell(world, 3, 5),
        cell(world, 3, 4),
        cell(world, 3, 3),
        cell(world, 4, 3),
        cell(world, 5, 3),
      ],
      DIRECTION_UP,
    );

    world.step();
    expect(world.snakes[0]?.alive).toBe(false);
    expect(world.aliveCount).toBe(0);
    expect(world.winnerSlot()).toBeNull();
  });

  test("[GAME-SR-TEST-01] moving into another snake's body eliminates only the mover", () => {
    const world = createWorld({ foodCount: 0 });
    world.placeSnake(
      1,
      [cell(world, 4, 4), cell(world, 3, 4), cell(world, 2, 4), cell(world, 1, 4)],
      DIRECTION_RIGHT,
    );
    world.placeSnake(
      2,
      [cell(world, 6, 4), cell(world, 5, 4), cell(world, 5, 5), cell(world, 5, 6)],
      2,
    );

    world.step();
    expect(world.snakes[0]?.alive).toBe(false);
    expect(world.snakes[1]?.alive).toBe(true);
    expect(world.aliveCount).toBe(1);
    expect(world.winnerSlot()).toBe(2);
  });

  test("[GAME-SR-TEST-01] a head moving out of bounds is eliminated", () => {
    const world = createWorld({ foodCount: 0 });
    world.placeSnake(
      1,
      [cell(world, 0, 4), cell(world, 1, 4), cell(world, 2, 4)],
      DIRECTION_LEFT,
    );

    world.step();
    expect(world.snakes[0]?.alive).toBe(false);
    expect(world.aliveCount).toBe(0);
  });

  test("[GAME-SR-HOST-03][GAME-SR-TEST-03] a head entering a walled ring is eliminated", () => {
    const world = createWorld({ gridSize: 8, foodCount: 0 });
    world.shrink();
    expect(world.wallInset).toBe(1);
    expect(world.walls[cell(world, 1, 0)]).toBe(1);
    expect(
      world.placeSnake(
        1,
        [cell(world, 1, 1), cell(world, 1, 2), cell(world, 1, 3)],
        DIRECTION_UP,
      ),
    ).toBeDefined();

    world.step();
    expect(world.snakes[0]?.alive).toBe(false);
  });

  test("[GAME-SR-TEST-02] two heads entering the same cell both die", () => {
    const world = createWorld({ foodCount: 0 });
    world.placeSnake(
      1,
      [cell(world, 4, 4), cell(world, 3, 4), cell(world, 2, 4), cell(world, 1, 4)],
      DIRECTION_RIGHT,
    );
    world.placeSnake(
      2,
      [cell(world, 6, 4), cell(world, 7, 4), cell(world, 8, 4), cell(world, 9, 4)],
      DIRECTION_LEFT,
    );

    world.step();
    expect(world.snakes[0]?.alive).toBe(false);
    expect(world.snakes[1]?.alive).toBe(false);
    expect(world.aliveCount).toBe(0);
    expect(world.winnerSlot()).toBeNull();
  });

  test("[GAME-SR-TEST-02] a tail does not vacate when its owner dies on the same step", () => {
    const world = createWorld({ foodCount: 0 });
    world.placeSnake(
      1,
      [cell(world, 27, 10), cell(world, 26, 10), cell(world, 25, 10), cell(world, 24, 10)],
      DIRECTION_RIGHT,
    );
    world.placeSnake(
      2,
      [cell(world, 31, 10), cell(world, 30, 10), cell(world, 29, 10), cell(world, 28, 10)],
      DIRECTION_RIGHT,
    );

    world.step();
    // Slot 2 walks out of bounds, so its tail stays put and blocks slot 1.
    expect(world.snakes[1]?.alive).toBe(false);
    expect(world.snakes[0]?.alive).toBe(false);
  });
});

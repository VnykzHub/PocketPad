import { describe, expect, test } from "vitest";
import { TILT_MAZE_CONFIG } from "../src/config.js";
import { collides, parseMaze, type Maze } from "../src/maze.js";
import { TiltMazeWorld, type Ball } from "../src/world.js";
import {
  TICK_SECONDS,
  eightPlayerMaze,
  fixtureWorldMaze,
  type MazeFixture,
} from "./helpers.js";

/**
 * Ball simulation (GAME-TM-HOST-01/05, GAME-TM-DATA-02; C9, G4).
 *
 * Fixtures are 480x240 boxes with a 16-unit border, so a radius-14 ball comes
 * to rest at x = 450 against the right wall and y = 30 against the top. Tests
 * drive the public world API only, exactly as the game adapter does.
 */

const RADIUS = TILT_MAZE_CONFIG.ballRadius;

function world(maze: Maze = fixtureWorldMaze()): TiltMazeWorld {
  return new TiltMazeWorld(maze, TILT_MAZE_CONFIG);
}

function ball(w: TiltMazeWorld, slot: number): Ball {
  const found = w.ball(slot);
  if (found === undefined) {
    throw new Error(`no ball for slot ${slot}`);
  }
  return found;
}

function parseFixture(document: MazeFixture): Maze {
  const result = parseMaze(document);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.maze;
}

function run(
  w: TiltMazeWorld,
  ticks: number,
  perTick?: (tick: number) => void,
): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    perTick?.(tick);
    w.step(TICK_SECONDS);
  }
}

function advanceUntil(
  w: TiltMazeWorld,
  predicate: () => boolean,
  maxTicks: number,
): number {
  let ticks = 0;
  while (!predicate() && ticks < maxTicks) {
    w.step(TICK_SECONDS);
    ticks += 1;
  }
  expect(predicate(), `condition after ${ticks} ticks`).toBe(true);
  return ticks;
}

describe("roster and lifecycle", () => {
  test("[C9] startRace places exactly the roster balls on their own starts", () => {
    const w = world();
    w.startRace((1 << 1) | (1 << 2));

    expect(w.participantCount).toBe(2);
    expect(w.participates(1)).toBe(true);
    expect(w.participates(2)).toBe(true);
    expect(w.participates(3)).toBe(false);
    expect(ball(w, 1).x).toBe(60);
    expect(ball(w, 1).y).toBe(80);
    expect(ball(w, 2).x).toBe(60);
    expect(ball(w, 2).y).toBe(160);
    expect(ball(w, 1).speed()).toBe(0);
    expect(w.finishOrder).toEqual([]);
    expect(w.elapsedMs).toBe(0);
    expect(w.stepCount).toBe(0);
  });

  test("[G4][C9] all eight protocol slots can race at once on distinct starts", () => {
    const w = world(parseFixture(eightPlayerMaze()));
    const roster = 0b111111110;
    w.startRace(roster);
    expect(w.participantCount).toBe(8);

    const seen = new Set<string>();
    for (let slot = 1; slot <= 8; slot += 1) {
      const current = ball(w, slot);
      expect(current.active).toBe(true);
      expect(current.connected).toBe(true);
      const key = `${current.x},${current.y}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  test("[C9] reset clears balls, timer and finish order; a new race restarts clean", () => {
    const w = world();
    w.startRace(1 << 1);
    ball(w, 1).x = 400;
    w.step(TICK_SECONDS);
    expect(w.finishOrder).toEqual([1]);
    expect(w.stepCount).toBe(1);

    w.reset();
    expect(w.participantCount).toBe(0);
    expect(w.finishOrder).toEqual([]);
    expect(w.elapsedMs).toBe(0);
    expect(w.stepCount).toBe(0);
    expect(ball(w, 1).x).toBe(0);
    expect(ball(w, 1).finished).toBe(false);

    w.startRace(1 << 2);
    expect(w.participates(1)).toBe(false);
    expect(w.participates(2)).toBe(true);
    expect(ball(w, 2).x).toBe(60);
    expect(ball(w, 2).y).toBe(160);
  });

  test("[C9] acceleration is ignored for slots outside the roster", () => {
    const w = world();
    w.startRace(1 << 1);
    w.setAcceleration(2, 900, 0);
    w.step(TICK_SECONDS);
    const outsider = ball(w, 2);
    expect(outsider.active).toBe(false);
    expect(outsider.x).toBe(0);
    expect(outsider.vx).toBe(0);
  });
});

describe("physics", () => {
  test("[C9] acceleration ramps velocity and the speed cap holds", () => {
    const w = world();
    w.startRace(1 << 2);
    w.setAcceleration(2, TILT_MAZE_CONFIG.accelScale, 0);

    run(w, 40, () => {
      expect(ball(w, 2).speed()).toBeLessThanOrEqual(TILT_MAZE_CONFIG.maxSpeed + 1e-9);
    });

    expect(ball(w, 2).speed()).toBeCloseTo(TILT_MAZE_CONFIG.maxSpeed, 6);
    expect(ball(w, 2).x).toBeGreaterThan(60);
  });

  test("[C9] the ball stops flush against the right wall and zeroes its x velocity", () => {
    const w = world();
    w.startRace(1 << 2);
    w.setAcceleration(2, TILT_MAZE_CONFIG.accelScale * 4, 0);
    run(w, 180);
    const moving = ball(w, 2);
    expect(moving.x).toBeGreaterThan(449);
    expect(moving.x).toBeLessThanOrEqual(450 + 1e-9);
    expect(moving.vx).toBe(0);
    expect(collides(w.maze, moving.x, moving.y, RADIUS)).toBe(false);
  });

  test("[C9] the ball stops flush against the top wall", () => {
    const w = world();
    w.startRace(1 << 2);
    w.setAcceleration(2, 0, -TILT_MAZE_CONFIG.accelScale * 4);
    run(w, 180);
    const moving = ball(w, 2);
    expect(moving.y).toBeGreaterThanOrEqual(30);
    // The contact search leaves a sub-pixel gap, never an overlap.
    expect(moving.y).toBeLessThanOrEqual(30.05);
    expect(moving.vy).toBe(0);
    expect(moving.x).toBe(60);
    expect(collides(w.maze, moving.x, moving.y, RADIUS)).toBe(false);
  });

  test("[C9] a diagonal push slides along a wall after contact", () => {
    const w = world();
    w.startRace(1 << 2);
    w.setAcceleration(2, TILT_MAZE_CONFIG.accelScale * 0.7, -TILT_MAZE_CONFIG.accelScale);
    advanceUntil(w, () => ball(w, 2).y <= 30.25, 120);

    const beforeSlide = ball(w, 2).x;
    run(w, 10);
    const afterSlide = ball(w, 2);
    expect(afterSlide.y).toBeGreaterThanOrEqual(30);
    expect(afterSlide.y).toBeLessThanOrEqual(30.05);
    expect(afterSlide.vy).toBe(0);
    expect(afterSlide.x).toBeGreaterThan(beforeSlide + 1);
  });

  test("[C9] a very large dt cannot tunnel through a wall", () => {
    const w = world();
    w.startRace(1 << 2);
    w.setAcceleration(2, 1_000_000, 0);
    w.step(5);

    const moving = ball(w, 2);
    expect(moving.x).toBeGreaterThan(449);
    expect(moving.x).toBeLessThanOrEqual(450 + 1e-9);
    expect(collides(w.maze, moving.x, moving.y, RADIUS)).toBe(false);
    expect(moving.y).toBe(160);
  });

  test("[C9] non-finite acceleration is stored as zero and never propagates NaN", () => {
    const w = world();
    w.startRace(1 << 1);
    w.setAcceleration(1, Number.NaN, Number.POSITIVE_INFINITY);
    w.step(TICK_SECONDS);
    const moving = ball(w, 1);
    expect(moving.vx).toBe(0);
    expect(moving.vy).toBe(0);
    expect(moving.x).toBe(60);
    expect(moving.y).toBe(80);
  });

  test("[C9] a non-positive or non-finite dt is ignored", () => {
    const w = world();
    w.startRace(1 << 1);
    w.setAcceleration(1, 900, 0);
    for (const dt of [0, -TICK_SECONDS, Number.NaN, Number.POSITIVE_INFINITY]) {
      w.step(dt);
    }
    expect(w.elapsedMs).toBe(0);
    expect(w.stepCount).toBe(0);
    expect(ball(w, 1).x).toBe(60);
    expect(ball(w, 1).vx).toBe(0);
  });
});

describe("finish and connectivity", () => {
  test("[C9] reaching the exit records rank, time and freezes the ball", () => {
    const w = world();
    w.startRace(1 << 1);
    ball(w, 1).x = 400;
    w.step(TICK_SECONDS);

    const finisher = ball(w, 1);
    expect(finisher.finished).toBe(true);
    expect(finisher.finishRank).toBe(1);
    expect(finisher.finishMs).toBeCloseTo(TICK_SECONDS * 1000, 6);
    expect(finisher.vx).toBe(0);
    expect(finisher.vy).toBe(0);
    expect(w.finishOrder).toEqual([1]);

    const frozenX = finisher.x;
    w.setAcceleration(1, 900, 0);
    w.step(TICK_SECONDS);
    expect(finisher.x).toBe(frozenX);
    expect(w.finishOrder).toEqual([1]);
  });

  test("[C9] two balls reaching the exit on one tick finish in slot order", () => {
    const w = world();
    w.startRace((1 << 1) | (1 << 2));
    ball(w, 1).x = 400;
    ball(w, 2).x = 400;
    ball(w, 2).y = 80;

    w.step(TICK_SECONDS);

    expect(w.finishOrder).toEqual([1, 2]);
    expect(ball(w, 1).finishRank).toBe(1);
    expect(ball(w, 2).finishRank).toBe(2);
    expect(ball(w, 1).finishMs).toBeCloseTo(ball(w, 2).finishMs, 9);
  });

  test("[C9] a later finisher appends after the early winner", () => {
    const w = world();
    w.startRace((1 << 1) | (1 << 2));
    ball(w, 1).x = 400;
    w.step(TICK_SECONDS);
    expect(w.finishOrder).toEqual([1]);

    ball(w, 2).x = 400;
    ball(w, 2).y = 80;
    w.step(TICK_SECONDS);
    expect(w.finishOrder).toEqual([1, 2]);
    expect(ball(w, 2).finishRank).toBe(2);
  });

  test("[C9] a disconnected ball coasts under friction and resumes on reconnect", () => {
    const w = world();
    w.startRace(1 << 1);
    w.setAcceleration(1, TILT_MAZE_CONFIG.accelScale, 0);
    run(w, 20);

    const rolling = ball(w, 1);
    const rolledX = rolling.x;
    const rolledSpeed = rolling.speed();
    expect(rolledSpeed).toBeGreaterThan(0);

    w.setConnected(1, false);
    run(w, 10);
    expect(rolling.x).toBeGreaterThan(rolledX);
    expect(rolling.speed()).toBeLessThan(rolledSpeed);
    expect(rolling.speed()).toBeGreaterThan(0);

    const coastingSpeed = rolling.speed();
    w.setConnected(1, true);
    run(w, 10);
    expect(rolling.speed()).toBeGreaterThan(coastingSpeed);
  });

  test("[C9] a disconnected ball receives no acceleration but is not reset", () => {
    const w = world();
    w.startRace(1 << 1);
    w.setConnected(1, false);
    w.setAcceleration(1, 900, 0);
    w.step(TICK_SECONDS);
    expect(ball(w, 1).x).toBe(60);
    expect(ball(w, 1).vx).toBe(0);
    expect(ball(w, 1).connected).toBe(false);
  });
});

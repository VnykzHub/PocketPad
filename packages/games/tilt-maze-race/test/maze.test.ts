import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  MAX_MAZE_STARTS,
  circleHitsWall,
  collides,
  parseMaze,
  reachesExit,
  startPointFor,
  type Maze,
  type MazeWall,
} from "../src/maze.js";

/**
 * Maze data and collision queries (GAME-TM-DATA-01; C9).
 *
 * `parseMaze` is the untrusted-data boundary: authored JSON must be rejected
 * with readable errors and never throw. Collision helpers are pure and are
 * used per physics substep, so their inclusivity at the tangent matters.
 */

const BALL_RADIUS = 14;

function readShippedMaze(): unknown {
  return JSON.parse(
    readFileSync(new URL("../src/maze-classic-v1.json", import.meta.url), "utf8"),
  ) as unknown;
}

function validDocument(): Record<string, unknown> {
  return {
    width: 480,
    height: 240,
    walls: [
      [0, 0, 480, 16],
      [0, 224, 480, 16],
      [0, 0, 16, 240],
      [464, 0, 16, 240],
    ],
    start: [
      { x: 60, y: 80 },
      { x: 60, y: 160 },
    ],
    exit: { x: 420, y: 80 },
  };
}

function parsed(document: unknown): Maze {
  const result = parseMaze(document);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.maze;
}

function errorsOf(document: unknown): string {
  const result = parseMaze(document);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.errors.join("\n");
}

describe("maze parsing", () => {
  test("[C9] the shipped maze parses with eight sorted starts and a clear exit", () => {
    const maze = parsed(readShippedMaze());
    expect(maze.width).toBe(960);
    expect(maze.height).toBe(640);
    expect(maze.walls).toHaveLength(8);
    expect(maze.start).toHaveLength(8);
    expect(maze.exit).toEqual({ x: 888, y: 64 });

    for (const point of maze.start) {
      expect(collides(maze, point.x, point.y, BALL_RADIUS), `start ${point.x},${point.y}`).toBe(
        false,
      );
    }
    expect(collides(maze, maze.exit.x, maze.exit.y, BALL_RADIUS)).toBe(false);
  });

  test("[C9] every start is distinct so no two balls stack on one lane", () => {
    const maze = parsed(readShippedMaze());
    const seen = new Set<string>();
    for (const point of maze.start) {
      const key = `${point.x},${point.y}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  test("[C9] non-objects and malformed dimensions are rejected without throwing", () => {
    expect(errorsOf(null)).toContain("must be an object");
    expect(errorsOf([])).toContain("must be an object");
    expect(errorsOf("maze")).toContain("must be an object");

    const narrow = validDocument();
    narrow["width"] = 32;
    expect(errorsOf(narrow)).toContain("maze.width");

    const huge = validDocument();
    huge["height"] = 9000;
    expect(errorsOf(huge)).toContain("maze.height");

    const nan = validDocument();
    nan["width"] = Number.NaN;
    expect(errorsOf(nan)).toContain("maze.width");
  });

  test("[C9] walls must be non-empty, in-bounds, positive AABBs", () => {
    const noWalls = validDocument();
    noWalls["walls"] = [];
    expect(errorsOf(noWalls)).toContain("maze.walls");

    const notArray = validDocument();
    notArray["walls"] = [[0, 0, 10]];
    expect(errorsOf(notArray)).toContain("must be [x, y, w, h]");

    const negative = validDocument();
    negative["walls"] = [[0, 0, -10, 10]];
    expect(errorsOf(negative)).toContain("width and height must be positive");

    const outside = validDocument();
    outside["walls"] = [[400, 0, 100, 10]];
    expect(errorsOf(outside)).toContain("inside the maze bounds");

    const nonFinite = validDocument();
    nonFinite["walls"] = [[0, 0, Number.POSITIVE_INFINITY, 10]];
    expect(errorsOf(nonFinite)).toContain("finite numbers");
  });

  test("[C9] starts and exits inside walls, outside bounds or duplicated are rejected", () => {
    const inWall = validDocument();
    inWall["start"] = [
      { x: 10, y: 10 },
      { x: 60, y: 160 },
    ];
    expect(errorsOf(inWall)).toContain("lies inside wall");

    const outside = validDocument();
    outside["start"] = [{ x: 20, y: 20 }, { x: 700, y: 160 }];
    expect(errorsOf(outside)).toContain("inside the maze bounds");

    const duplicate = validDocument();
    duplicate["start"] = [
      { x: 60, y: 80 },
      { x: 60, y: 80 },
    ];
    expect(errorsOf(duplicate)).toContain("duplicates");

    const tooMany = validDocument();
    tooMany["start"] = Array.from({ length: MAX_MAZE_STARTS + 1 }, (_, index) => ({
      x: 40 + index * 20,
      y: 80,
    }));
    // Every generated point is clear of the side walls, so the only failure is
    // the count limit.
    expect(errorsOf(tooMany)).toContain(`at most ${MAX_MAZE_STARTS}`);

    const missingExit = validDocument();
    delete missingExit["exit"];
    expect(errorsOf(missingExit)).toContain("maze.exit");

    const exitInWall = validDocument();
    exitInWall["exit"] = { x: 10, y: 10 };
    expect(errorsOf(exitInWall)).toContain("exit: lies inside wall");
  });

  test("[C9] a structurally valid document comes back unchanged", () => {
    const maze = parsed(validDocument());
    expect(maze).toEqual({
      width: 480,
      height: 240,
      walls: [
        { x: 0, y: 0, w: 480, h: 16 },
        { x: 0, y: 224, w: 480, h: 16 },
        { x: 0, y: 0, w: 16, h: 240 },
        { x: 464, y: 0, w: 16, h: 240 },
      ],
      start: [
        { x: 60, y: 80 },
        { x: 60, y: 160 },
      ],
      exit: { x: 420, y: 80 },
    });
  });
});

describe("maze collision", () => {
  const wall: MazeWall = { x: 0, y: 0, w: 100, h: 100 };

  test("[C9] circleHitsWall treats a tangent as clear and any overlap as a hit", () => {
    expect(circleHitsWall(50, 50, 10, wall)).toBe(true);
    expect(circleHitsWall(114, 50, 14, wall)).toBe(false);
    expect(circleHitsWall(113.9, 50, 14, wall)).toBe(true);
    expect(circleHitsWall(110, 110, 10, wall)).toBe(false);
    expect(circleHitsWall(108, 108, 10, wall)).toBe(false);
    expect(circleHitsWall(107, 107, 10, wall)).toBe(true);
    expect(circleHitsWall(-100, 50, 14, wall)).toBe(false);
  });

  test("[C9] collides includes walls and the maze boundary", () => {
    const maze = parsed(validDocument());
    expect(collides(maze, 60, 100, BALL_RADIUS)).toBe(false);
    expect(collides(maze, 8, 120, BALL_RADIUS)).toBe(true);
    expect(collides(maze, 472, 120, BALL_RADIUS)).toBe(true);
    expect(collides(maze, 200, 25, BALL_RADIUS)).toBe(true);
    expect(collides(maze, 200, 30, BALL_RADIUS)).toBe(false);
    expect(collides(maze, 200, 224, BALL_RADIUS)).toBe(true);
  });

  test("[C9] reachesExit uses an inclusive trigger radius", () => {
    const maze = parsed(validDocument());
    expect(reachesExit(maze, 420, 80, 14)).toBe(true);
    expect(reachesExit(maze, 434, 80, 14)).toBe(true);
    expect(reachesExit(maze, 434.1, 80, 14)).toBe(false);
    expect(reachesExit(maze, 420, 94, 14)).toBe(true);
    expect(reachesExit(maze, 420, 94.5, 14)).toBe(false);
  });

  test("[C9] startPointFor is slot-indexed and falls back to the last start", () => {
    const maze = parsed(validDocument());
    expect(startPointFor(maze, 1)).toEqual({ x: 60, y: 80 });
    expect(startPointFor(maze, 2)).toEqual({ x: 60, y: 160 });
    expect(startPointFor(maze, 3)).toEqual({ x: 60, y: 160 });
    expect(startPointFor(maze, 8)).toEqual({ x: 60, y: 160 });

    const empty: Maze = {
      width: 480,
      height: 240,
      walls: [],
      start: [],
      exit: { x: 420, y: 80 },
    };
    expect(startPointFor(empty, 1)).toEqual({ x: 240, y: 120 });
  });
});

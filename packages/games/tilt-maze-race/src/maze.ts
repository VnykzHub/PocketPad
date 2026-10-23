/**
 * Maze data and collision queries (GAME-TM-HOST-01, GAME-TM-DATA-01; C9).
 *
 * A maze is data, never code: `{width, height, walls: [[x, y, w, h]],
 * start: [{x, y}], exit: {x, y}}`. The shipped maze lives in
 * `maze-classic-v1.json` and is validated by the same pure parser tests use.
 *
 * Coordinates are maze units with a y-down screen axis. `start[slot - 1]` is
 * each player's independent start. Wall collision is a circle-versus-AABB
 * query against the ball's radius, which the plan permits ("ball-vs-wall
 * AABB/circle resolution").
 */
export interface MazeWall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface MazePoint {
  readonly x: number;
  readonly y: number;
}

export interface Maze {
  readonly width: number;
  readonly height: number;
  readonly walls: readonly MazeWall[];
  readonly start: readonly MazePoint[];
  readonly exit: MazePoint;
}

export type MazeValidation =
  | { readonly ok: true; readonly maze: Maze }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Hard limits keep a hostile or broken maze from bloating the game. */
export const MIN_MAZE_DIMENSION = 64;
export const MAX_MAZE_DIMENSION = 8192;
export const MAX_MAZE_WALLS = 256;
export const MAX_MAZE_STARTS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readPoint(value: unknown): MazePoint | null {
  if (!isRecord(value)) return null;
  const x = value["x"];
  const y = value["y"];
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  return { x, y };
}

function pointInWall(x: number, y: number, wall: MazeWall): boolean {
  return x >= wall.x && x <= wall.x + wall.w && y >= wall.y && y <= wall.y + wall.h;
}

/**
 * Parses and validates maze JSON. Returns every structural error it finds so a
 * content author can fix the data in one pass; never throws on bad input.
 */
export function parseMaze(raw: unknown): MazeValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: ["maze: must be an object"] };
  }

  const width = raw["width"];
  const height = raw["height"];
  if (
    !isFiniteNumber(width) ||
    width < MIN_MAZE_DIMENSION ||
    width > MAX_MAZE_DIMENSION
  ) {
    errors.push(`maze.width: must be a number in ${MIN_MAZE_DIMENSION}..${MAX_MAZE_DIMENSION}`);
  }
  if (
    !isFiniteNumber(height) ||
    height < MIN_MAZE_DIMENSION ||
    height > MAX_MAZE_DIMENSION
  ) {
    errors.push(`maze.height: must be a number in ${MIN_MAZE_DIMENSION}..${MAX_MAZE_DIMENSION}`);
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const mazeWidth = width as number;
  const mazeHeight = height as number;
  const walls: MazeWall[] = [];
  const rawWalls = raw["walls"];
  if (!Array.isArray(rawWalls) || rawWalls.length === 0) {
    errors.push("maze.walls: must be a non-empty array");
  } else if (rawWalls.length > MAX_MAZE_WALLS) {
    errors.push(`maze.walls: must contain at most ${MAX_MAZE_WALLS} walls`);
  } else {
    for (let index = 0; index < rawWalls.length; index += 1) {
      const wall = rawWalls[index];
      if (!Array.isArray(wall) || wall.length !== 4) {
        errors.push(`maze.walls[${index}]: must be [x, y, w, h]`);
        continue;
      }
      const x = wall[0];
      const y = wall[1];
      const w = wall[2];
      const h = wall[3];
      if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(w) || !isFiniteNumber(h)) {
        errors.push(`maze.walls[${index}]: all four values must be finite numbers`);
        continue;
      }
      if (w <= 0 || h <= 0) {
        errors.push(`maze.walls[${index}]: width and height must be positive`);
        continue;
      }
      if (x < 0 || y < 0 || x + w > mazeWidth || y + h > mazeHeight) {
        errors.push(`maze.walls[${index}]: must stay inside the maze bounds`);
        continue;
      }
      walls.push({ x, y, w, h });
    }
  }

  const starts: MazePoint[] = [];
  const rawStarts = raw["start"];
  if (!Array.isArray(rawStarts) || rawStarts.length === 0) {
    errors.push("maze.start: must be a non-empty array of points");
  } else if (rawStarts.length > MAX_MAZE_STARTS) {
    errors.push(`maze.start: must contain at most ${MAX_MAZE_STARTS} points`);
  } else {
    for (let index = 0; index < rawStarts.length; index += 1) {
      const point = readPoint(rawStarts[index]);
      if (point === null) {
        errors.push(`maze.start[${index}]: must be {x, y} with finite numbers`);
        continue;
      }
      if (point.x < 0 || point.y < 0 || point.x > mazeWidth || point.y > mazeHeight) {
        errors.push(`maze.start[${index}]: must be inside the maze bounds`);
        continue;
      }
      starts.push(point);
    }
  }

  const exit = readPoint(raw["exit"]);
  if (exit === null) {
    errors.push("maze.exit: must be {x, y} with finite numbers");
  } else if (exit.x < 0 || exit.y < 0 || exit.x > mazeWidth || exit.y > mazeHeight) {
    errors.push("maze.exit: must be inside the maze bounds");
  }

  // Data-only sanity: a start or exit embedded in a wall can never be played.
  for (let index = 0; index < starts.length; index += 1) {
    const point = starts[index];
    if (point === undefined) continue;
    for (let wallIndex = 0; wallIndex < walls.length; wallIndex += 1) {
      const wall = walls[wallIndex];
      if (wall !== undefined && pointInWall(point.x, point.y, wall)) {
        errors.push(`maze.start[${index}]: lies inside wall ${wallIndex}`);
        break;
      }
    }
  }
  if (exit !== null) {
    for (let wallIndex = 0; wallIndex < walls.length; wallIndex += 1) {
      const wall = walls[wallIndex];
      if (wall !== undefined && pointInWall(exit.x, exit.y, wall)) {
        errors.push(`maze.exit: lies inside wall ${wallIndex}`);
        break;
      }
    }
  }

  // Independent starts: byte-identical points would stack two players.
  for (let left = 0; left < starts.length; left += 1) {
    for (let right = left + 1; right < starts.length; right += 1) {
      const a = starts[left];
      const b = starts[right];
      if (a !== undefined && b !== undefined && a.x === b.x && a.y === b.y) {
        errors.push(`maze.start[${right}]: duplicates maze.start[${left}]`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    maze: {
      width: mazeWidth,
      height: mazeHeight,
      walls,
      start: starts,
      // Read above; non-null here because a missing exit pushed an error.
      exit: exit as MazePoint,
    },
  };
}

/** The start point for a slot; falls back to the last point for short mazes. */
export function startPointFor(maze: Maze, slot: number): MazePoint {
  const index = slot - 1;
  return (
    maze.start[index] ??
    maze.start[maze.start.length - 1] ?? { x: maze.width / 2, y: maze.height / 2 }
  );
}

/** Closest point on the AABB to the circle centre; true when it overlaps. */
export function circleHitsWall(x: number, y: number, radius: number, wall: MazeWall): boolean {
  const right = wall.x + wall.w;
  const bottom = wall.y + wall.h;
  const closestX = x < wall.x ? wall.x : x > right ? right : x;
  const closestY = y < wall.y ? wall.y : y > bottom ? bottom : y;
  const dx = x - closestX;
  const dy = y - closestY;
  return dx * dx + dy * dy < radius * radius;
}

/** True when the circle overlaps a wall or leaves the maze bounds. */
export function collides(maze: Maze, x: number, y: number, radius: number): boolean {
  if (x - radius < 0 || y - radius < 0 || x + radius > maze.width || y + radius > maze.height) {
    return true;
  }
  for (let index = 0; index < maze.walls.length; index += 1) {
    const wall = maze.walls[index];
    if (wall !== undefined && circleHitsWall(x, y, radius, wall)) {
      return true;
    }
  }
  return false;
}

/** True when the ball centre is within the exit trigger radius. */
export function reachesExit(maze: Maze, x: number, y: number, radius: number): boolean {
  const dx = x - maze.exit.x;
  const dy = y - maze.exit.y;
  return dx * dx + dy * dy <= radius * radius;
}

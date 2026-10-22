/**
 * Coin Run level data and hand-written validator (GAME-PF-02; FR-10.3, C9).
 *
 * The schema is deliberately boring JSON so a new level is a new file, never
 * a branch in code (GAME-PF-02 anti-rework). The runtime `Aabb` shape is reused
 * verbatim: top-left origin with positive extents in a y-down world, so a
 * platform's top surface is `y` and its bottom is `y + h`.
 *
 * The validator has zero dependencies because the game bundle must not add
 * one (GAME-PF-02; SDK validators are hand-written for the same reason). It
 * reports every problem with a JSON-style path so a bad level fails at startup
 * with a readable field name.
 */
import type { Aabb } from "@lanpad/runtime";

/** A player start position: the collider centre, not the feet. */
export interface SpawnPoint {
  x: number;
  y: number;
}

/** Alias kept for the plan's vocabulary; identical to the runtime `Aabb`. */
export type PlatformAabb = Aabb;

/** A coin trigger centre. Coins are not physics bodies (GAME-PF-02). */
export interface Coin {
  x: number;
  y: number;
}

/** A checkpoint trigger centre; activation is a read-only overlap test. */
export interface Checkpoint {
  x: number;
  y: number;
}

/** The goal flag rectangle; the top-left is `x`,`y`. */
export type Goal = Aabb;

export interface LevelData {
  version: 1;
  width: number;
  height: number;
  /** Players whose feet pass this y respawn (must be below `height`). */
  killY: number;
  spawns: SpawnPoint[];
  platforms: PlatformAabb[];
  checkpoints: Checkpoint[];
  coins: Coin[];
  goal: Goal;
}

/** Hard limits from GAME-PF-02; enforced by `validateLevel`. */
export const LEVEL_LIMITS = Object.freeze({
  minSpawns: 1,
  maxSpawns: 4,
  minPlatforms: 1,
  maxPlatforms: 80,
  minCoins: 1,
  maxCoins: 200,
  maxCheckpoints: 4,
});

export type LevelValidation =
  | { ok: true; level: LevelData }
  | { ok: false; errors: string[] };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True when a point (a trigger/entity centre) lies inside or on a box. */
export function pointInAabb(x: number, y: number, box: Aabb): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

/**
 * Read-only circle/AABB overlap for coin, checkpoint and goal triggers.
 *
 * Deliberately does not mutate a body or velocity: the plan allows a
 * game-local trigger overlap but forbids resolving physics from it
 * (GAME-PF-02 contract note).
 */
export function circleIntersectsAabb(
  x: number,
  y: number,
  radius: number,
  box: Aabb,
): boolean {
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  const closestX = x < box.x ? box.x : x > right ? right : x;
  const closestY = y < box.y ? box.y : y > bottom ? bottom : y;
  const dx = x - closestX;
  const dy = y - closestY;
  return dx * dx + dy * dy <= radius * radius;
}

function readPoint(
  value: unknown,
  path: string,
  errors: string[],
): { x: number; y: number } | null {
  if (!isRecord(value)) {
    errors.push(`${path}: must be an object with numeric x and y`);
    return null;
  }
  let valid = true;
  if (!isFiniteNumber(value.x)) {
    errors.push(`${path}.x: must be a finite number`);
    valid = false;
  }
  if (!isFiniteNumber(value.y)) {
    errors.push(`${path}.y: must be a finite number`);
    valid = false;
  }
  return valid ? { x: value.x as number, y: value.y as number } : null;
}

/**
 * Validate an unknown value as `LevelData`.
 *
 * Checks, in order: finite numbers, positive sizes, array limits, one goal
 * inside bounds, `killY > height`, spawn/coin/checkpoint points inside bounds
 * and no trigger centre inside a platform (GAME-PF-02).
 */
export function validateLevel(input: unknown): LevelValidation {
  if (!isRecord(input)) {
    return { ok: false, errors: ["level: must be an object"] };
  }

  const errors: string[] = [];

  if (input.version !== 1) {
    errors.push("level.version: must be 1");
  }

  const width = input.width;
  const height = input.height;
  const widthOk = isFiniteNumber(width) && width > 0;
  const heightOk = isFiniteNumber(height) && height > 0;
  if (!widthOk) errors.push("level.width: must be a positive finite number");
  if (!heightOk) errors.push("level.height: must be a positive finite number");

  const killY = input.killY;
  if (!isFiniteNumber(killY)) {
    errors.push("level.killY: must be a finite number");
  } else if (heightOk && killY <= (height as number)) {
    errors.push("level.killY: must be greater than level.height");
  }

  const boundsOk = widthOk && heightOk;
  const boundWidth = widthOk ? (width as number) : Number.POSITIVE_INFINITY;
  const boundHeight = heightOk ? (height as number) : Number.POSITIVE_INFINITY;

  // Platforms are read first: trigger-centre checks need them.
  const platforms: PlatformAabb[] = [];
  const rawPlatforms = input.platforms;
  if (!Array.isArray(rawPlatforms)) {
    errors.push("level.platforms: must be an array");
  } else {
    if (
      rawPlatforms.length < LEVEL_LIMITS.minPlatforms ||
      rawPlatforms.length > LEVEL_LIMITS.maxPlatforms
    ) {
      errors.push(
        `level.platforms: must have ${LEVEL_LIMITS.minPlatforms}..${LEVEL_LIMITS.maxPlatforms} entries`,
      );
    }
    for (let i = 0; i < rawPlatforms.length; i += 1) {
      const path = `level.platforms[${i}]`;
      const value: unknown = rawPlatforms[i];
      if (!isRecord(value)) {
        errors.push(`${path}: must be an object with numeric x, y, w and h`);
        continue;
      }
      const okX = isFiniteNumber(value.x);
      const okY = isFiniteNumber(value.y);
      const okW = isFiniteNumber(value.w) && value.w > 0;
      const okH = isFiniteNumber(value.h) && value.h > 0;
      if (!okX) errors.push(`${path}.x: must be a finite number`);
      if (!okY) errors.push(`${path}.y: must be a finite number`);
      if (!okW) errors.push(`${path}.w: must be a positive finite number`);
      if (!okH) errors.push(`${path}.h: must be a positive finite number`);
      if (okX && okY && okW && okH) {
        platforms.push({
          x: value.x as number,
          y: value.y as number,
          w: value.w as number,
          h: value.h as number,
        });
      }
    }
  }

  const insidePlatform = (x: number, y: number): boolean => {
    for (let i = 0; i < platforms.length; i += 1) {
      const platform = platforms[i];
      if (platform !== undefined && pointInAabb(x, y, platform)) return true;
    }
    return false;
  };

  const readPointList = (
    field: string,
    minLength: number,
    maxLength: number,
  ): { x: number; y: number }[] => {
    const raw = input[field];
    if (!Array.isArray(raw)) {
      errors.push(`level.${field}: must be an array`);
      return [];
    }
    if (raw.length < minLength || raw.length > maxLength) {
      errors.push(`level.${field}: must have ${minLength}..${maxLength} entries`);
    }
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      const path = `level.${field}[${i}]`;
      const point = readPoint(raw[i], path, errors);
      if (point === null) continue;
      if (
        boundsOk &&
        (point.x < 0 || point.x > boundWidth || point.y < 0 || point.y > boundHeight)
      ) {
        errors.push(`${path}: must be inside the level bounds`);
        continue;
      }
      if (insidePlatform(point.x, point.y)) {
        errors.push(`${path}: centre must not be inside a platform`);
        continue;
      }
      points.push(point);
    }
    return points;
  };

  const spawns = readPointList("spawns", LEVEL_LIMITS.minSpawns, LEVEL_LIMITS.maxSpawns);
  const checkpoints = readPointList("checkpoints", 0, LEVEL_LIMITS.maxCheckpoints);
  const coins = readPointList("coins", LEVEL_LIMITS.minCoins, LEVEL_LIMITS.maxCoins);

  let goal: Goal | null = null;
  const rawGoal = input.goal;
  if (!isRecord(rawGoal)) {
    errors.push("level.goal: must be an object with numeric x, y, w and h");
  } else {
    const okX = isFiniteNumber(rawGoal.x);
    const okY = isFiniteNumber(rawGoal.y);
    const okW = isFiniteNumber(rawGoal.w) && rawGoal.w > 0;
    const okH = isFiniteNumber(rawGoal.h) && rawGoal.h > 0;
    if (!okX) errors.push("level.goal.x: must be a finite number");
    if (!okY) errors.push("level.goal.y: must be a finite number");
    if (!okW) errors.push("level.goal.w: must be a positive finite number");
    if (!okH) errors.push("level.goal.h: must be a positive finite number");
    if (okX && okY && okW && okH) {
      const candidate: Goal = {
        x: rawGoal.x as number,
        y: rawGoal.y as number,
        w: rawGoal.w as number,
        h: rawGoal.h as number,
      };
      if (
        boundsOk &&
        (candidate.x < 0 ||
          candidate.y < 0 ||
          candidate.x + candidate.w > boundWidth ||
          candidate.y + candidate.h > boundHeight)
      ) {
        errors.push("level.goal: must fit inside the level bounds");
      } else {
        goal = candidate;
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    level: {
      version: 1,
      width: width as number,
      height: height as number,
      killY: killY as number,
      spawns,
      platforms,
      checkpoints,
      coins,
      goal: goal as Goal,
    },
  };
}

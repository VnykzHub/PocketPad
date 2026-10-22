/**
 * Level data and pooled world tests (GAME-PF-02; FR-10.3, C9, PR-9.3/9.4/9.5).
 *
 * The shipped `level-01.json` is the fixture: the validator, geometry counts,
 * spawn safety, jump reach, pooling and platform query all run against the
 * data the game actually loads.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { COIN_RUN_CONFIG } from "../src/config.js";
import {
  circleIntersectsAabb,
  pointInAabb,
  validateLevel,
  type LevelData,
} from "../src/level.js";
import { stepPlayer } from "../src/player.js";
import { World } from "../src/world.js";

const levelPath = fileURLToPath(new URL("../src/level-01.json", import.meta.url));
const rawJson: unknown = JSON.parse(readFileSync(levelPath, "utf8"));
const loaded = validateLevel(rawJson);
if (!loaded.ok) {
  throw new Error(`Shipped level is invalid: ${loaded.errors.join("; ")}`);
}
const level: LevelData = loaded.level;
const DT = 1 / 60;

function windowPlatforms(world: World, x: number, radius: number): number[] {
  const indices: number[] = [];
  const start = world.platformWindowStart(x, radius);
  for (let i = start; i < world.platforms.length; i += 1) {
    const platform = world.platforms[i];
    if (platform === undefined || platform.x > x + radius) break;
    if (platform.x + platform.w >= x - radius) indices.push(i);
  }
  return indices;
}

function bruteForcePlatforms(world: World, x: number, radius: number): number[] {
  const indices: number[] = [];
  for (let i = 0; i < world.platforms.length; i += 1) {
    const platform = world.platforms[i];
    if (
      platform !== undefined &&
      platform.x <= x + radius &&
      platform.x + platform.w >= x - radius
    ) {
      indices.push(i);
    }
  }
  return indices;
}

describe("level-01.json [FR-10.3]", () => {
  test("[FR-10.3] the shipped level loads from JSON and validates at startup", () => {
    expect(loaded.ok).toBe(true);
    expect(level.version).toBe(1);
    expect(level.width).toBe(120);
    expect(level.height).toBe(18);
    expect(level.killY).toBeGreaterThan(level.height);
  });

  test("[FR-10.3] the shipped level has the contracted geometry", () => {
    expect(level.spawns).toHaveLength(4);
    expect(level.coins).toHaveLength(20);
    expect(level.checkpoints).toHaveLength(2);
    expect(level.platforms).toHaveLength(9);

    const ground = level.platforms
      .filter((platform) => platform.y === 16 && platform.h === 2)
      .sort((a, b) => a.x - b.x);
    expect(ground).toHaveLength(4);

    const floating = level.platforms.filter((platform) => platform.y < 16);
    expect(floating).toHaveLength(5);

    const pits: number[] = [];
    for (let i = 1; i < ground.length; i += 1) {
      const previous = ground[i - 1];
      const current = ground[i];
      if (previous !== undefined && current !== undefined) {
        const gap = current.x - (previous.x + previous.w);
        if (gap > 0) pits.push(gap);
      }
    }
    expect(pits).toHaveLength(3);
    expect(pits).toEqual([3, 4, 4]);

    expect(level.goal).toEqual({ x: 116, y: 11, w: 2, h: 5 });
  });

  test("[FR-10.3] all five floating platforms are jump-reachable from below", () => {
    const jumpHeight =
      (COIN_RUN_CONFIG.jumpVelocity * COIN_RUN_CONFIG.jumpVelocity) /
      (2 * COIN_RUN_CONFIG.gravity);
    const floating = level.platforms.filter((platform) => platform.y < 16);
    expect(floating).toHaveLength(5);

    for (const platform of floating) {
      const supports = level.platforms.filter(
        (support) =>
          support !== platform &&
          support.y >= platform.y + platform.h &&
          support.x <= platform.x + platform.w &&
          support.x + support.w >= platform.x,
      );
      expect(supports.length).toBeGreaterThan(0);
      let bestRise = Number.POSITIVE_INFINITY;
      for (const support of supports) {
        const rise = support.y - platform.y;
        if (rise < bestRise) bestRise = rise;
      }
      // Margin below the continuous apex so float drift cannot make it exact.
      expect(bestRise).toBeLessThanOrEqual(jumpHeight - 0.1);
    }
  });

  test("[FR-10.3] spawn points rest on ground and never overlap a platform", () => {
    const radius = COIN_RUN_CONFIG.playerRadius;
    for (let i = 0; i < level.spawns.length; i += 1) {
      const spawn = level.spawns[i];
      if (spawn === undefined) continue;
      const support = level.platforms.find(
        (platform) =>
          spawn.x >= platform.x &&
          spawn.x <= platform.x + platform.w &&
          Math.abs(spawn.y + radius - platform.y) < 1e-9,
      );
      expect(support, `spawn ${i} has ground beneath it`).toBeDefined();
      for (const platform of level.platforms) {
        expect(pointInAabb(spawn.x, spawn.y, platform)).toBe(false);
        expect(circleIntersectsAabb(spawn.x, spawn.y, radius - 1e-6, platform)).toBe(false);
      }
    }
  });
});

describe("validateLevel [FR-10.3]", () => {
  interface RejectionCase {
    name: string;
    mutate: (draft: Record<string, unknown>) => void;
    path: string;
  }

  const cases: RejectionCase[] = [
    {
      name: "wrong version",
      mutate: (draft) => {
        draft.version = 2;
      },
      path: "level.version",
    },
    {
      name: "zero width",
      mutate: (draft) => {
        draft.width = 0;
      },
      path: "level.width",
    },
    {
      name: "negative height",
      mutate: (draft) => {
        draft.height = -1;
      },
      path: "level.height",
    },
    {
      name: "non-finite killY",
      mutate: (draft) => {
        draft.killY = Number.NaN;
      },
      path: "level.killY",
    },
    {
      name: "killY at the level floor",
      mutate: (draft) => {
        draft.killY = 18;
      },
      path: "level.killY",
    },
    {
      name: "no spawns",
      mutate: (draft) => {
        draft.spawns = [];
      },
      path: "level.spawns",
    },
    {
      name: "five spawns",
      mutate: (draft) => {
        const spawns = draft.spawns as unknown[];
        draft.spawns = [...spawns, { x: 10, y: 15.6 }];
      },
      path: "level.spawns",
    },
    {
      name: "spawn inside a platform",
      mutate: (draft) => {
        const spawns = draft.spawns as unknown[];
        spawns[0] = { x: 10, y: 17 };
      },
      path: "level.spawns[0]",
    },
    {
      name: "no platforms",
      mutate: (draft) => {
        draft.platforms = [];
      },
      path: "level.platforms",
    },
    {
      name: "zero-width platform",
      mutate: (draft) => {
        const platforms = draft.platforms as Array<Record<string, unknown>>;
        const first = platforms[0];
        if (first !== undefined) first.w = 0;
      },
      path: "level.platforms[0].w",
    },
    {
      name: "no coins",
      mutate: (draft) => {
        draft.coins = [];
      },
      path: "level.coins",
    },
    {
      name: "coin inside a platform",
      mutate: (draft) => {
        const coins = draft.coins as unknown[];
        coins[0] = { x: 10, y: 17 };
      },
      path: "level.coins[0]",
    },
    {
      name: "five checkpoints",
      mutate: (draft) => {
        const checkpoints = draft.checkpoints as unknown[];
        draft.checkpoints = [
          ...checkpoints,
          { x: 40, y: 14 },
          { x: 50, y: 14 },
          { x: 60, y: 14 },
        ];
      },
      path: "level.checkpoints",
    },
    {
      name: "checkpoint inside a platform",
      mutate: (draft) => {
        const checkpoints = draft.checkpoints as unknown[];
        checkpoints[0] = { x: 64, y: 13.7 };
      },
      path: "level.checkpoints[0]",
    },
    {
      name: "goal outside the level bounds",
      mutate: (draft) => {
        draft.goal = { x: 119, y: 11, w: 2, h: 5 };
      },
      path: "level.goal",
    },
    {
      name: "goal with a negative size",
      mutate: (draft) => {
        draft.goal = { x: 100, y: 11, w: -1, h: 5 };
      },
      path: "level.goal.w",
    },
  ];

  for (const rejection of cases) {
    test(`[FR-10.3] rejects ${rejection.name} with a readable path`, () => {
      const draft = structuredClone(rawJson) as Record<string, unknown>;
      rejection.mutate(draft);
      const result = validateLevel(draft);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((error) => error.includes(rejection.path))).toBe(true);
      }
    });
  }

  test("[FR-10.3] rejects non-objects and missing fields", () => {
    expect(validateLevel(null).ok).toBe(false);
    expect(validateLevel("level").ok).toBe(false);
    expect(validateLevel([]).ok).toBe(false);
    const empty = validateLevel({});
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("World pooling and queries [C9] [PR-9.3] [PR-9.4] [PR-9.5]", () => {
  test("[C9] the world exposes an AABB for every platform, sorted by x", () => {
    const world = new World(level);
    expect(world.platforms).toHaveLength(level.platforms.length);
    let previousX = Number.NEGATIVE_INFINITY;
    for (const platform of world.platforms) {
      expect(Number.isFinite(platform.x)).toBe(true);
      expect(Number.isFinite(platform.y)).toBe(true);
      expect(platform.w).toBeGreaterThan(0);
      expect(platform.h).toBeGreaterThan(0);
      expect(platform.x).toBeGreaterThanOrEqual(previousX);
      previousX = platform.x;
    }
  });

  test("[PR-9.5] platform lookup uses an x-sorted index window, not map/filter", () => {
    const world = new World(level);
    const samples = [-1, 0, 2, 9, 22, 29.5, 35, 50, 58, 64, 78, 84, 96, 100, 119.9];
    for (const x of samples) {
      expect(windowPlatforms(world, x, 0.4)).toEqual(bruteForcePlatforms(world, x, 0.4));
    }
  });

  test("[PR-9.5] the simulate path never calls map or filter", () => {
    const world = new World(level);
    const player = world.players[0];
    if (player === undefined) throw new Error("missing player");
    const originalMap = Array.prototype.map;
    const originalFilter = Array.prototype.filter;
    let startIndex = -1;
    let movedX = 0;
    try {
      Array.prototype.map = (() => {
        throw new Error("Array.prototype.map called during simulation");
      }) as unknown as typeof Array.prototype.map;
      Array.prototype.filter = (() => {
        throw new Error("Array.prototype.filter called during simulation");
      }) as unknown as typeof Array.prototype.filter;
      startIndex = world.platformWindowStart(9, 0.4);
      player.command.moveX = 1;
      player.command.jumpPressed = false;
      stepPlayer(player, world, DT);
      world.collectCoins(player);
      world.activateCheckpoint(player);
      movedX = player.body.x;
    } finally {
      Array.prototype.map = originalMap;
      Array.prototype.filter = originalFilter;
    }
    expect(startIndex).toBe(0);
    expect(movedX).toBeGreaterThan(level.spawns[0]?.x ?? 0);
  });

  test("[PR-9.4] reset restores flags and positions without replacing pooled objects", () => {
    const world = new World(level);
    const coinsArray = world.coins;
    const coin = world.coins[0];
    const playersArray = world.players;
    const player = world.players[0];
    const checkpoint = world.checkpoints[0];
    const platform = world.platforms[0];
    if (
      coin === undefined ||
      player === undefined ||
      checkpoint === undefined ||
      platform === undefined
    ) {
      throw new Error("world is missing pooled entities");
    }

    coin.collected = true;
    checkpoint.activated = true;
    world.coinsCollected = 7;
    world.goalReached = true;
    player.body.x = 50;
    player.body.y = 12;
    player.body.vx = 3;
    player.body.vy = -2;
    player.checkpointIndex = 1;
    player.falling = true;
    player.respawnRemaining = 500;
    player.jumpCount = 4;

    world.reset();
    world.reset();

    expect(world.coins).toBe(coinsArray);
    expect(world.coins[0]).toBe(coin);
    expect(world.players).toBe(playersArray);
    expect(world.players[0]).toBe(player);
    expect(world.checkpoints[0]).toBe(checkpoint);
    expect(world.platforms[0]).toBe(platform);
    expect(coin.collected).toBe(false);
    expect(checkpoint.activated).toBe(false);
    expect(world.coinsCollected).toBe(0);
    expect(world.goalReached).toBe(false);
    expect(player.checkpointIndex).toBe(-1);
    expect(player.falling).toBe(false);
    expect(player.body.vx).toBe(0);
    expect(player.body.vy).toBe(0);
    expect(player.body.x).toBe(player.spawnX);
    expect(player.body.y).toBe(player.spawnY);
  });

  test("[PR-9.3] world updates allocate nothing after setup", () => {
    const world = new World(level);
    const coins = world.coins;
    const players = world.players;
    const checkpoints = world.checkpoints;
    const platforms = world.platforms;
    const coinObjects = coins.slice();
    const playerObjects = players.slice();
    world.reset();
    for (let i = 0; i < 300; i += 1) {
      const player = players[i % players.length];
      if (player !== undefined) {
        player.command.moveX = i % 3 === 0 ? 1 : 0;
        stepPlayer(player, world, DT);
        world.collectCoins(player);
        world.activateCheckpoint(player);
      }
    }
    world.reset();
    expect(world.coins).toBe(coins);
    expect(world.players).toBe(players);
    expect(world.checkpoints).toBe(checkpoints);
    expect(world.platforms).toBe(platforms);
    for (let i = 0; i < coins.length; i += 1) {
      expect(world.coins[i]).toBe(coinObjects[i]);
    }
    for (let i = 0; i < players.length; i += 1) {
      expect(world.players[i]).toBe(playerObjects[i]);
    }
  });

  test("[C9] coin, checkpoint and goal triggers never mutate a body", () => {
    const world = new World(level);
    const player = world.players[0];
    const firstCoin = world.coins[0];
    const checkpoint = world.checkpoints[0];
    if (player === undefined || firstCoin === undefined || checkpoint === undefined) {
      throw new Error("world is missing entities");
    }

    player.body.x = firstCoin.x;
    player.body.y = firstCoin.y;
    player.body.vx = 4;
    player.body.vy = -3;
    expect(world.collectCoins(player)).toBeGreaterThan(0);
    expect(player.body.x).toBe(firstCoin.x);
    expect(player.body.y).toBe(firstCoin.y);
    expect(player.body.vx).toBe(4);
    expect(player.body.vy).toBe(-3);

    player.body.x = checkpoint.x;
    player.body.y = checkpoint.y;
    expect(world.activateCheckpoint(player)).toBe(true);
    expect(player.body.x).toBe(checkpoint.x);
    expect(player.body.y).toBe(checkpoint.y);

    player.body.x = world.goal.x + world.goal.w / 2;
    player.body.y = world.goal.y + world.goal.h / 2;
    expect(world.touchesGoal(player)).toBe(true);
    expect(world.reachGoal(player)).toBe(true);
    expect(world.reachGoal(player)).toBe(false);
    expect(player.body.x).toBe(world.goal.x + world.goal.w / 2);
    expect(player.body.y).toBe(world.goal.y + world.goal.h / 2);
  });
});

/**
 * Player movement, input mapping and respawn tests (GAME-PF-03; FR-7.2/7.3/
 * 7.4/7.11/7.12, FR-8.10, G2, C9, PR-9.3).
 *
 * Every test uses a fixed 1/60 s step and a fake controller state; there is no
 * wall clock, so the same script always produces the same positions. Custom
 * levels are hand-built `LevelData` literals (they bypass JSON because the
 * validator is covered by `level.test.ts`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { COIN_RUN_CONFIG } from "../src/config.js";
import {
  DLEFT_BIT,
  DRIGHT_BIT,
  JUMP_BIT,
  createPlayerCommand,
  readCommand,
  type CommandInputState,
} from "../src/input.js";
import { validateLevel, type LevelData } from "../src/level.js";
import { stepPlayer, type PlayerState } from "../src/player.js";
import { World } from "../src/world.js";

const DT = 1 / 60;
const levelPath = fileURLToPath(new URL("../src/level-01.json", import.meta.url));
const rawJson: unknown = JSON.parse(readFileSync(levelPath, "utf8"));
const loaded = validateLevel(rawJson);
if (!loaded.ok) {
  throw new Error(`Shipped level is invalid: ${loaded.errors.join("; ")}`);
}
const shippedLevel: LevelData = loaded.level;

function input(overrides: Partial<CommandInputState> = {}): CommandInputState {
  return { buttons: 0, edges: 0, lx: 0, ...overrides };
}

function playerAt(world: World, index = 0): PlayerState {
  const player = world.players[index];
  if (player === undefined) throw new Error(`missing player ${index}`);
  return player;
}

function tick(
  world: World,
  state: CommandInputState,
  count = 1,
  index = 0,
): PlayerState {
  const player = playerAt(world, index);
  for (let i = 0; i < count; i += 1) {
    readCommand(state, player.command);
    stepPlayer(player, world, DT);
  }
  return player;
}

function makeLevel(overrides: Partial<LevelData> = {}): LevelData {
  return {
    version: 1,
    width: 20,
    height: 18,
    killY: 21,
    spawns: [{ x: 2, y: 15.6 }],
    platforms: [{ x: 0, y: 16, w: 20, h: 2 }],
    checkpoints: [],
    coins: [],
    goal: { x: 18, y: 11, w: 2, h: 5 },
    ...overrides,
  };
}

describe("readCommand [FR-7.2] [FR-7.4] [PR-9.3]", () => {
  test("[FR-7.2] d-pad bits 10 and 11 drive left/right and suppress the stick", () => {
    const out = createPlayerCommand();

    readCommand(input({ buttons: 1 << DLEFT_BIT }), out);
    expect(out.moveX).toBe(-1);
    expect(out.jumpPressed).toBe(false);

    readCommand(input({ buttons: 1 << DRIGHT_BIT }), out);
    expect(out.moveX).toBe(1);

    readCommand(input({ buttons: (1 << DLEFT_BIT) | (1 << DRIGHT_BIT) }), out);
    expect(out.moveX).toBe(0);

    readCommand(input({ buttons: 1 << DLEFT_BIT, lx: 0.9 }), out);
    expect(out.moveX).toBe(-1);

    readCommand(input({ buttons: 1 << DRIGHT_BIT, lx: -0.9 }), out);
    expect(out.moveX).toBe(1);

    readCommand(input({ buttons: 1 << 8 }), out);
    expect(out.moveX).toBe(0);
  });

  test("[FR-7.4] stick input maps at the inclusive ±0.25 threshold without jitter", () => {
    const out = createPlayerCommand();
    const cases: Array<{ lx: number; expected: -1 | 0 | 1 }> = [
      { lx: -1, expected: -1 },
      { lx: -0.2501, expected: -1 },
      { lx: -0.25, expected: -1 },
      { lx: -0.2499, expected: 0 },
      { lx: 0, expected: 0 },
      { lx: 0.2499, expected: 0 },
      { lx: 0.25, expected: 1 },
      { lx: 0.2501, expected: 1 },
      { lx: 1, expected: 1 },
    ];
    for (const entry of cases) {
      readCommand(input({ lx: entry.lx }), out);
      expect(out.moveX, `lx=${entry.lx}`).toBe(entry.expected);
    }
  });

  test("[FR-7.2] jump is edge bit 0 only, never the button level", () => {
    const out = createPlayerCommand();
    readCommand(input({ edges: 1 << JUMP_BIT }), out);
    expect(out.jumpPressed).toBe(true);
    readCommand(input({ edges: 1 << 1 }), out);
    expect(out.jumpPressed).toBe(false);
    readCommand(input({ buttons: 1 << JUMP_BIT, edges: 0 }), out);
    expect(out.jumpPressed).toBe(false);
    readCommand(input({ edges: 0xffff }), out);
    expect(out.jumpPressed).toBe(true);
  });

  test("[PR-9.3] readCommand writes into the caller's pooled command object", () => {
    const out = createPlayerCommand();
    const first = out;
    readCommand(input({ buttons: 1 << DRIGHT_BIT, edges: 1 }), out);
    expect(out).toBe(first);
    expect(out.moveX).toBe(1);
    expect(out.jumpPressed).toBe(true);
    readCommand(input({ buttons: 1 << DLEFT_BIT, edges: 0 }), out);
    expect(out).toBe(first);
    expect(out.moveX).toBe(-1);
    expect(out.jumpPressed).toBe(false);
  });

  test("[FR-7.11] only the latest command written before a step is used", () => {
    const world = new World(shippedLevel);
    const player = tick(world, input({ buttons: 1 << DRIGHT_BIT }), 10);
    const speeding = player.body.vx;
    expect(speeding).toBeGreaterThan(0);
    // Two writes in one tick: the mapper's latest level state wins. The first
    // step only brakes (accel is 1 unit/s per tick), it does not reverse yet.
    player.command.moveX = 1;
    readCommand(input({ buttons: 1 << DLEFT_BIT }), player.command);
    stepPlayer(player, world, DT);
    expect(player.body.vx).toBeLessThan(speeding);
    tick(world, input({ buttons: 1 << DLEFT_BIT }), 12);
    expect(player.body.vx).toBeLessThan(0);
  });
});

describe("player physics [C9] [FR-7.12]", () => {
  test("[C9] a falling player lands, stays grounded and does not sink", () => {
    const world = new World(shippedLevel);
    const player = tick(world, input(), 120);
    expect(player.grounded).toBe(true);
    expect(player.body.y).toBeCloseTo(15.6, 10);
    expect(player.body.vy).toBe(0);

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 120; i += 1) {
      tick(world, input());
      if (player.body.y < minY) minY = player.body.y;
      if (player.body.y > maxY) maxY = player.body.y;
    }
    expect(player.grounded).toBe(true);
    expect(maxY - minY).toBeLessThan(1e-9);
  });

  test("[C9] wall collision stops horizontal motion and still reports ground", () => {
    const level = makeLevel({
      platforms: [
        { x: 0, y: 16, w: 20, h: 2 },
        { x: 6, y: 10, w: 1, h: 6 },
      ],
    });
    const world = new World(level);
    const player = tick(world, input({ buttons: 1 << DRIGHT_BIT }), 120);
    expect(player.grounded).toBe(true);
    expect(player.body.x).toBeLessThanOrEqual(6 - COIN_RUN_CONFIG.playerRadius + 1e-9);
    expect(Math.abs(player.body.vx)).toBeLessThan(1e-9);
    const stoppedX = player.body.x;
    tick(world, input(), 5);
    expect(player.body.x).toBeCloseTo(stoppedX, 10);
  });

  test("[FR-7.12] one jump edge produces one jump; a held button never repeats", () => {
    const world = new World(shippedLevel);
    const player = tick(world, input(), 5);
    expect(player.grounded).toBe(true);

    tick(world, input({ edges: 1 << JUMP_BIT }));
    expect(player.jumpCount).toBe(1);
    expect(player.body.vy).toBeLessThan(0);
    expect(player.body.y).toBeLessThan(15.6);

    // Button held for four seconds with no new edge.
    tick(world, input({ buttons: 1 << JUMP_BIT }), 240);
    expect(player.jumpCount).toBe(1);
  });

  test("[FR-7.3] a sub-tick edge merged into one tick is consumed exactly once", () => {
    const world = new World(shippedLevel);
    const player = tick(world, input(), 5);
    // Two press packets inside one host tick OR into one edge bit; the next
    // tick has no edge even though the finger may still be down.
    tick(world, input({ buttons: 1 << JUMP_BIT, edges: 1 << JUMP_BIT }));
    expect(player.jumpCount).toBe(1);
    tick(world, input({ buttons: 1 << JUMP_BIT, edges: 0 }), 2);
    expect(player.jumpCount).toBe(1);
  });

  test("[G2] a jump edge changes the player state on the next fixed tick", () => {
    const world = new World(shippedLevel);
    const player = tick(world, input(), 5);
    const beforeY = player.body.y;
    tick(world, input({ edges: 1 << JUMP_BIT }));
    expect(player.body.vy).toBeLessThan(0);
    expect(player.body.y).toBeLessThan(beforeY);
  });

  test("[FR-7.12] coyote time allows a jump just after leaving a ledge", () => {
    const level = makeLevel({
      spawns: [{ x: 3, y: 15.6 }],
      platforms: [{ x: 0, y: 16, w: 4, h: 2 }],
      goal: { x: 16, y: 11, w: 2, h: 5 },
    });
    const world = new World(level);
    const player = playerAt(world);
    let sawGround = false;
    let leftGround = false;
    for (let i = 0; i < 200; i += 1) {
      tick(world, input({ buttons: 1 << DRIGHT_BIT }));
      if (player.grounded) sawGround = true;
      if (sawGround && !player.grounded) {
        leftGround = true;
        break;
      }
    }
    expect(leftGround).toBe(true);

    tick(world, input({ buttons: 1 << DRIGHT_BIT, edges: 1 << JUMP_BIT }));
    expect(player.jumpCount).toBe(1);
    expect(player.body.vy).toBeLessThan(0);
  });

  test("[FR-7.12] coyote time expires after its window", () => {
    const level = makeLevel({
      spawns: [{ x: 3, y: 15.6 }],
      platforms: [{ x: 0, y: 16, w: 4, h: 2 }],
      goal: { x: 16, y: 11, w: 2, h: 5 },
    });
    const world = new World(level);
    const player = playerAt(world);
    let sawGround = false;
    for (let i = 0; i < 200; i += 1) {
      tick(world, input({ buttons: 1 << DRIGHT_BIT }));
      if (player.grounded) sawGround = true;
      if (sawGround && !player.grounded) break;
    }
    // 8 ticks is ~133 ms, beyond the 80 ms coyote window.
    tick(world, input(), 8);
    tick(world, input({ edges: 1 << JUMP_BIT }));
    expect(player.jumpCount).toBe(0);
  });

  test("[FR-7.12] jump buffer turns a late press into a jump on landing", () => {
    const world = new World(makeLevel());
    const player = playerAt(world);
    player.body.y = 15.0;
    player.body.vy = 0;

    for (let i = 0; i < 30 && player.body.y <= 15.45; i += 1) {
      tick(world, input());
    }
    expect(player.grounded).toBe(false);
    tick(world, input({ edges: 1 << JUMP_BIT }));
    expect(player.jumpBufferRemaining).toBeGreaterThan(0);

    for (let i = 0; i < 6 && player.jumpCount === 0; i += 1) {
      tick(world, input());
    }
    expect(player.jumpCount).toBe(1);
    expect(player.body.vy).toBeLessThan(0);
  });

  test("[C9] a player lands on a floating platform from above", () => {
    const level = makeLevel({
      platforms: [
        { x: 0, y: 16, w: 20, h: 2 },
        { x: 4, y: 13, w: 3, h: 0.5 },
      ],
    });
    const world = new World(level);
    const player = playerAt(world);
    player.body.x = 5;
    player.body.y = 11;
    player.body.vy = 0;

    let grounded = false;
    for (let i = 0; i < 60; i += 1) {
      tick(world, input());
      if (player.grounded) {
        grounded = true;
        break;
      }
    }
    expect(grounded).toBe(true);
    expect(player.body.y).toBeCloseTo(13 - COIN_RUN_CONFIG.playerRadius, 10);
  });

  test("[C9] a platform corner does not trap the player", () => {
    const level = makeLevel({
      platforms: [
        { x: 0, y: 16, w: 20, h: 2 },
        { x: 6, y: 14, w: 2, h: 2 },
      ],
    });
    const world = new World(level);
    const player = tick(world, input({ buttons: 1 << DRIGHT_BIT }), 90);
    expect(player.body.x).toBeLessThan(6);
    const blockedX = player.body.x;
    expect(blockedX).toBeGreaterThan(4);
    tick(world, input({ buttons: 1 << DLEFT_BIT }), 60);
    expect(player.body.x).toBeLessThan(blockedX - 1);
  });
});

describe("fall and respawn [C9]", () => {
  test("[C9] falling below the kill plane respawns at the last checkpoint", () => {
    const level = makeLevel({
      checkpoints: [{ x: 6, y: 15.6 }],
    });
    const world = new World(level);
    const player = playerAt(world);

    player.body.x = 6;
    player.body.y = 15.6;
    expect(world.activateCheckpoint(player)).toBe(true);
    expect(player.checkpointIndex).toBe(0);
    expect(world.checkpoints[0]?.activated).toBe(true);

    player.body.x = 10;
    player.body.y = 25;
    tick(world, input());
    expect(player.falling).toBe(true);
    expect(player.respawnRemaining).toBeCloseTo(COIN_RUN_CONFIG.respawnMs, 5);

    let ticks = 0;
    while (player.falling && ticks < 60) {
      tick(world, input());
      ticks += 1;
    }
    expect(player.falling).toBe(false);
    expect(ticks).toBeLessThanOrEqual(46);
    expect(player.body.x).toBeCloseTo(6, 10);
    expect(player.body.y).toBeCloseTo(15.6, 10);
    expect(player.body.vx).toBe(0);
    expect(player.body.vy).toBe(0);
    expect(player.invulnRemaining).toBeGreaterThan(0);
    expect(player.checkpointIndex).toBe(0);
  });

  test("[C9] a player with no checkpoint respawns at the level spawn", () => {
    const world = new World(makeLevel({ spawns: [{ x: 3, y: 15.6 }] }));
    const player = playerAt(world);
    player.body.x = 10;
    player.body.y = 25;
    tick(world, input());
    let ticks = 0;
    while (player.falling && ticks < 60) {
      tick(world, input());
      ticks += 1;
    }
    expect(player.body.x).toBeCloseTo(3, 10);
    expect(player.body.y).toBeCloseTo(15.6, 10);
    expect(player.invulnRemaining).toBeGreaterThan(0);
  });
});

describe("playability and determinism [FR-8.10] [PR-9.3]", () => {
  test("[FR-8.10] d-pad and one button complete the level", () => {
    const world = new World(shippedLevel);
    const player = playerAt(world);
    // Pit near-edges from the shipped ground segments.
    const pitEdges = [28, 56, 82];
    let reached = false;

    for (let i = 0; i < 6000; i += 1) {
      const nearPit = pitEdges.some((edge) => {
        const distance = edge - player.body.x;
        return distance > 0.2 && distance < 1.2;
      });
      const state = input({
        buttons: 1 << DRIGHT_BIT,
        edges: player.grounded && nearPit ? 1 << JUMP_BIT : 0,
      });
      readCommand(state, player.command);
      stepPlayer(player, world, DT);
      world.collectCoins(player);
      world.activateCheckpoint(player);
      if (world.reachGoal(player)) {
        reached = true;
        break;
      }
    }

    expect(reached).toBe(true);
    expect(player.body.x).toBeGreaterThan(110);
    expect(world.coinsCollected).toBeGreaterThan(0);
  });

  test("[PR-9.3] stepPlayer and trigger updates allocate nothing per tick", () => {
    const world = new World(shippedLevel);
    const player = playerAt(world);
    const body = player.body;
    const command = player.command;
    const contact = player.contact;
    const coins = world.coins;
    const players = world.players;
    const coinObjects = coins.slice();

    for (let i = 0; i < 600; i += 1) {
      const state = input({
        buttons: i % 120 < 60 ? 1 << DRIGHT_BIT : 1 << DLEFT_BIT,
        edges: i % 47 === 0 ? 1 << JUMP_BIT : 0,
      });
      readCommand(state, command);
      stepPlayer(player, world, DT);
      world.collectCoins(player);
      world.activateCheckpoint(player);
    }

    expect(player.body).toBe(body);
    expect(player.command).toBe(command);
    expect(player.contact).toBe(contact);
    expect(world.players).toBe(players);
    expect(world.coins).toBe(coins);
    for (let i = 0; i < coins.length; i += 1) {
      expect(world.coins[i]).toBe(coinObjects[i]);
    }
  });

  test("[FR-7.11] the same fixed input sequence replays to identical positions", () => {
    const worldA = new World(shippedLevel);
    const worldB = new World(shippedLevel);

    for (let i = 0; i < 900; i += 1) {
      const movingLeft = i % 89 >= 60;
      const state = input({
        buttons: movingLeft ? 1 << DLEFT_BIT : 1 << DRIGHT_BIT,
        edges: i % 43 === 0 ? 1 << JUMP_BIT : 0,
      });
      for (const world of [worldA, worldB]) {
        const player = playerAt(world);
        readCommand(state, player.command);
        stepPlayer(player, world, DT);
        world.collectCoins(player);
        world.activateCheckpoint(player);
      }
    }

    const playerA = playerAt(worldA);
    const playerB = playerAt(worldB);
    expect(playerA.body.x).toBe(playerB.body.x);
    expect(playerA.body.y).toBe(playerB.body.y);
    expect(playerA.body.vx).toBe(playerB.body.vx);
    expect(playerA.body.vy).toBe(playerB.body.vy);
    expect(playerA.grounded).toBe(playerB.grounded);
    expect(playerA.checkpointIndex).toBe(playerB.checkpointIndex);
    expect(playerA.jumpCount).toBe(playerB.jumpCount);
    for (let i = 0; i < worldA.coins.length; i += 1) {
      expect(worldA.coins[i]?.collected).toBe(worldB.coins[i]?.collected);
    }
  });
});

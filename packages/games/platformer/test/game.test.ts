/**
 * Coin Run adapter tests (GAME-PF-01/03/04; D3-SDK-01, D7-SDK-01, A12).
 *
 * The simulation modules have their own suites. These tests drive the
 * `GameModule` the host actually loads:
 *
 * - the shipped manifest validates and the default export builds a Game;
 * - a fresh tick-0, all-zero packet from the real `InputMapper` marks the slot
 *   connected and receives a Coin Run layout exactly once;
 * - disconnect clears the layout and reconnect re-applies it without
 *   destroying the pooled body;
 * - two players run the fixed-tick flow through coin, goal, results and
 *   rematch, with one shared team score;
 * - rendering uses the flat 2D surface with a bounded draw count;
 * - the adapter has no socket/fetch/controller import (FR-7.17).
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type {
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameManifest,
  GameRenderer3D,
  LayoutDocument,
} from "@lanpad/sdk";
import { validateManifest } from "@lanpad/sdk";
import { InputMapper } from "@lanpad/runtime";
import {
  COIN_RUN_COUNTDOWN_MS,
  createCoinRunGame,
  layoutIdForSlot,
  PF_DPAD_LAYOUT_ID,
  PF_STICK_LAYOUT_ID,
} from "../src/game.js";
import type { CoinRunGame } from "../src/game.js";
import levelData from "../src/level-01.json";

const manifestPath = new URL("../game.manifest.json", import.meta.url);
const manifestResult = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
if (!manifestResult.ok) {
  throw new Error(`Shipped manifest is invalid: ${manifestResult.errors.join("; ")}`);
}
const manifest: GameManifest = manifestResult.manifest;

/** Small synthetic level: ground, one coin, one checkpoint, one goal. */
const TEST_LEVEL = {
  version: 1,
  width: 24,
  height: 18,
  killY: 21,
  spawns: [
    { x: 2, y: 15.6 },
    { x: 2, y: 15.6 },
  ],
  platforms: [{ x: 0, y: 16, w: 24, h: 2 }],
  checkpoints: [{ x: 4, y: 14.9 }],
  coins: [{ x: 3, y: 15.6 }],
  goal: { x: 6, y: 13, w: 2, h: 3 },
};

interface FakeRenderer {
  readonly renderer: GameRenderer3D;
  readonly texts: string[];
  readonly counters: {
    beginFrames: number;
    endFrames: number;
    rects: number;
    circles: number;
  };
}

function createRenderer(options: { flat: boolean }): FakeRenderer {
  const texts: string[] = [];
  const counters = { beginFrames: 0, endFrames: 0, rects: 0, circles: 0 };
  const base = {
    backend: "canvas2d" as const,
    drawCalls: 0,
    textureMemoryMB: 0,
    beginFrame: () => {
      counters.beginFrames += 1;
    },
    endFrame: () => {
      counters.endFrames += 1;
    },
    setCamera: () => undefined,
    drawCube: () => undefined,
  };
  const renderer = options.flat
    ? {
        ...base,
        clear: () => undefined,
        rect: () => {
          counters.rects += 1;
        },
        circle: () => {
          counters.circles += 1;
        },
        text: (value: string) => {
          texts.push(value);
        },
      }
    : base;
  return { renderer, texts, counters };
}

interface FakeContext {
  readonly ctx: GameContext;
  readonly layouts: Array<{ slot: number; layoutId: string }>;
  readonly clearedLayouts: number[];
  readonly counters: Map<string, number>;
  readonly renderer: FakeRenderer;
}

function createContext(options: {
  flatRenderer?: boolean;
  layoutThrows?: boolean;
}): FakeContext {
  const renderer = createRenderer({ flat: options.flatRenderer ?? true });
  const layouts: Array<{ slot: number; layoutId: string }> = [];
  const clearedLayouts: number[] = [];
  const counters = new Map<string, number>();
  const snapshot: GameInputSnapshot = { tick: 0, players: [] };
  const ctx: GameContext = {
    manifest,
    input: {
      snapshot,
      poll: () => snapshot,
      player: () => undefined,
      events: () => [],
    },
    renderer: renderer.renderer,
    audio: {
      playSfx: () => undefined,
      playMusic: () => undefined,
      stopMusic: () => undefined,
      now: () => 0,
      unlocked: true,
      latencyHint: "interactive",
    },
    rng: {
      seed: 11,
      next: () => 0.5,
      int: (min) => min,
    },
    debug: {
      enabled: false,
      setCounter: (name, value) => {
        counters.set(name, value);
      },
    },
    panels: {
      set: () => undefined,
      show: () => undefined,
      clear: () => undefined,
    },
    layouts: {
      set: (slot: number | "all", layout: LayoutDocument | string): void => {
        if (options.layoutThrows === true) {
          throw new Error("layouts not available");
        }
        if (typeof slot === "number" && typeof layout === "string") {
          layouts.push({ slot, layoutId: layout });
        }
      },
      clear: (target: number | "all"): void => {
        if (options.layoutThrows === true) {
          throw new Error("layouts not available");
        }
        if (typeof target === "number") {
          clearedLayouts.push(target);
        }
      },
    },
    haptics: { pulse: () => undefined },
    events: {
      on: () => () => undefined,
      onAny: () => () => undefined,
    },
    serverNow: () => 1000,
  };
  return { ctx, layouts, clearedLayouts, counters, renderer };
}

interface Harness {
  readonly game: CoinRunGame;
  readonly fake: FakeContext;
  step(players: readonly GameControllerState[], dtSeconds?: number): void;
  render(alpha?: number): void;
}

function createHarness(options: {
  countdownMs?: number;
  level?: unknown;
  flatRenderer?: boolean;
  layoutThrows?: boolean;
} = {}): Harness {
  const fake = createContext({
    ...(options.flatRenderer === undefined ? {} : { flatRenderer: options.flatRenderer }),
    ...(options.layoutThrows === undefined ? {} : { layoutThrows: options.layoutThrows }),
  });
  const game = createCoinRunGame(manifest, {
    countdownMs: options.countdownMs ?? 0,
    level: options.level ?? TEST_LEVEL,
  });
  game.init(fake.ctx);
  return {
    game,
    fake,
    step(players, dtSeconds = 1 / 60): void {
      game.simulate(dtSeconds, { tick: 0, players });
    },
    render(alpha = 0.5): void {
      game.render(alpha);
    },
  };
}

function player(
  slot: number,
  overrides: Partial<GameControllerState> = {},
): GameControllerState {
  return {
    slot,
    connected: true,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gyro: { x: 0, y: 0, z: 0 },
    gyroActive: false,
    gyroRecentered: false,
    triggers: { lt: 0, rt: 0 },
    tick: 0,
    ...overrides,
  };
}

/** One raw protocol packet, all zero unless overridden. */
function packet(overrides: Record<string, number> = {}) {
  return {
    tick: 0,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    lt: 0,
    rt: 0,
    flags: 0,
    ...overrides,
  };
}

const RIGHT_BUTTON = 1 << 11;

describe("manifest + module shape", () => {
  test("[FR-10.3][G8] the shipped manifest validates and the default export builds a Game", () => {
    expect(manifestResult.ok).toBe(true);
    expect(manifest.name).toBe("Coin Run");
    expect(manifest.minPlayers).toBe(1);
    expect(manifest.maxPlayers).toBe(4);
    expect(manifest.needsGyro).toBe(false);
    expect(manifest.layouts).toEqual([
      `layouts/${PF_DPAD_LAYOUT_ID}.json`,
      `layouts/${PF_STICK_LAYOUT_ID}.json`,
    ]);

    const game = createCoinRunGame(manifest);
    expect(game.manifest).toBe(manifest);
    expect(typeof game.init).toBe("function");
    expect(typeof game.simulate).toBe("function");
    expect(typeof game.render).toBe("function");
    expect(typeof game.dispose).toBe("function");
    expect(game.world).toBeNull();
    expect(game.phase).toBe("lobby");
    expect(game.lastResults).toBeNull();
    game.dispose();
  });

  test("[FR-10.3] the shipped level loads with 20 coins, 2 checkpoints and a goal", () => {
    const harness = createHarness({ level: levelData });
    const world = harness.game.world;
    if (world === null) throw new Error("game was not initialized");
    expect(world.coins).toHaveLength(20);
    expect(world.checkpoints).toHaveLength(2);
    expect(world.level.width).toBe(120);
    expect(world.goal.w).toBeGreaterThan(0);
    expect(harness.game.phase).toBe("lobby");
    expect(harness.game.elapsedMs).toBe(0);
  });

  test("[FR-10.3] the countdown default is the documented three seconds", () => {
    expect(COIN_RUN_COUNTDOWN_MS).toBe(3000);
    const game = createCoinRunGame(manifest);
    game.init(createContext({}).ctx);
    game.simulate(1 / 60, { tick: 0, players: [player(1)] });
    expect(game.phase).toBe("countdown");
    game.dispose();
  });

  test("[FR-8.10] slots alternate the two shipped layouts from the manifest", () => {
    expect(layoutIdForSlot(1)).toBe(PF_DPAD_LAYOUT_ID);
    expect(layoutIdForSlot(2)).toBe(PF_STICK_LAYOUT_ID);
    expect(layoutIdForSlot(3)).toBe(PF_DPAD_LAYOUT_ID);
    expect(layoutIdForSlot(4)).toBe(PF_STICK_LAYOUT_ID);
  });
});

describe("connected flag integration", () => {
  test("[FR-8.2] a real tick-0 all-zero InputMapper packet receives a Coin Run layout once", () => {
    const harness = createHarness();
    const mapper = new InputMapper();
    mapper.apply(1, packet({ tick: 0 }), 0);
    const snapshot = mapper.pollAll(1);

    expect(snapshot.players[0]?.connected).toBe(true);
    expect(snapshot.players[0]?.tick).toBe(0);
    expect(snapshot.players[0]?.buttons).toBe(0);

    harness.game.simulate(1 / 60, snapshot);
    expect(harness.fake.layouts).toEqual([
      { slot: 1, layoutId: PF_DPAD_LAYOUT_ID },
    ]);
    expect(harness.game.laidOutSlots).toEqual([1]);
    expect(harness.game.connectedMask).toBe(0b10);

    harness.game.simulate(1 / 60, mapper.pollAll(2));
    harness.game.simulate(1 / 60, mapper.pollAll(3));
    expect(harness.fake.layouts).toHaveLength(1);
    expect(harness.game.laidOutSlots).toEqual([1]);
  });

  test("[FR-8.2][FR-5.4] disconnect clears the layout and reconnect applies it once", () => {
    const harness = createHarness();
    harness.step([player(1), player(2)]);
    expect(harness.fake.layouts).toEqual([
      { slot: 1, layoutId: PF_DPAD_LAYOUT_ID },
      { slot: 2, layoutId: PF_STICK_LAYOUT_ID },
    ]);

    const before = harness.game.world?.players[1]?.body.x ?? Number.NaN;
    harness.step([player(1), player(2, { connected: false })]);
    expect(harness.fake.clearedLayouts).toEqual([2]);
    expect(harness.game.connectedMask).toBe(0b10);
    // The idle body stays where it was; nothing is destroyed.
    expect(harness.game.world?.players[1]?.body.x).toBeCloseTo(before, 10);

    harness.step([player(1), player(2)]);
    expect(harness.game.laidOutSlots).toEqual([1, 2, 2]);
    expect(harness.fake.layouts).toHaveLength(3);
  });

  test("[FR-8.2] a disconnected slot with input values is not present", () => {
    const harness = createHarness();
    harness.step([
      player(1, { connected: false, tick: 900, buttons: RIGHT_BUTTON, edges: 1 }),
    ]);
    expect(harness.fake.layouts).toEqual([]);
    expect(harness.game.connectedMask).toBe(0);
    expect(harness.game.phase).toBe("lobby");
  });

  test("[FR-8.2] a throwing layouts API never stops the match", () => {
    const harness = createHarness({ layoutThrows: true });
    harness.step([player(1)]);
    expect(harness.game.connectedMask).toBe(0b10);
    expect(harness.fake.counters.get("layoutErrors")).toBe(1);
  });
});

describe("two-player round flow", () => {
  test("[G4][FR-9.1] coin, goal, results and rematch run on the fixed tick", () => {
    const harness = createHarness({ countdownMs: 0 });
    const players = [player(1), player(2)];

    harness.step(players);
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.laidOutSlots).toEqual([1, 2]);

    const moving = players.map((state) => ({ ...state, buttons: RIGHT_BUTTON }));
    let goalTick = -1;
    for (let tick = 0; tick < 60; tick += 1) {
      harness.step(moving);
      if (harness.game.phase === "results") {
        goalTick = tick;
        break;
      }
    }
    expect(goalTick).toBeGreaterThanOrEqual(0);
    expect(harness.game.phase).toBe("results");
    expect(harness.game.coinsCollected).toBe(1);
    const scoreSum =
      (harness.game.scores[0] ?? 0) + (harness.game.scores[1] ?? 0);
    expect(scoreSum).toBe(1);
    expect(harness.game.elapsedMs).toBeGreaterThan(0);

    const results = harness.game.lastResults;
    if (results === null) throw new Error("results were not built");
    expect(results.title).toBe("LEVEL COMPLETE");
    expect(results.coinLine).toBe("COINS 1 / 1");
    expect(results.playerLines).toHaveLength(2);
    expect(results.rematchLine).toContain("rematch");

    // Results freeze simulation: continued input moves nothing.
    const frozenX = harness.game.world?.players[0]?.body.x ?? Number.NaN;
    harness.step(moving);
    expect(harness.game.world?.players[0]?.body.x).toBeCloseTo(frozenX, 10);

    // Any A/B/X/Y edge opens a rematch; the next tick starts playing again.
    harness.step([player(1), player(2, { edges: 1 })]);
    expect(harness.game.phase).toBe("countdown");
    expect(harness.game.lastResults).toBeNull();
    expect(harness.game.coinsCollected).toBe(0);
    expect(harness.game.scores).toEqual([0, 0, 0, 0]);
    expect(harness.game.world?.coins[0]?.collected).toBe(false);

    harness.step([player(1), player(2)]);
    expect(harness.game.phase).toBe("playing");
    // No connection edge happened, so no layout was re-sent.
    expect(harness.game.laidOutSlots).toEqual([1, 2]);
  });

  test("[AR-4] a rematch controller event also resets the pooled world", () => {
    const harness = createHarness({ countdownMs: 0 });
    const players = [player(1), player(2)];
    const moving = players.map((state) => ({ ...state, buttons: RIGHT_BUTTON }));
    for (let tick = 0; tick < 60 && harness.game.phase !== "results"; tick += 1) {
      harness.step(moving);
    }
    expect(harness.game.phase).toBe("results");

    harness.game.onEvent?.(1, "rematch", null);
    expect(harness.game.phase).toBe("countdown");
    expect(harness.game.coinsCollected).toBe(0);
  });

  test("[PR-9.4] rematch reuses the same pooled objects", () => {
    const harness = createHarness({ countdownMs: 0 });
    const worldBefore = harness.game.world;
    const coinBefore = worldBefore?.coins[0];
    const playerBefore = worldBefore?.players[0];
    const players = [player(1), player(2)];
    const moving = players.map((state) => ({ ...state, buttons: RIGHT_BUTTON }));
    for (let tick = 0; tick < 60 && harness.game.phase !== "results"; tick += 1) {
      harness.step(moving);
    }
    harness.step([player(1), player(2, { edges: 1 })]);
    harness.step([player(1), player(2)]);

    expect(harness.game.world).toBe(worldBefore);
    expect(harness.game.world?.coins[0]).toBe(coinBefore);
    expect(harness.game.world?.players[0]).toBe(playerBefore);
  });

  test("[G5] connected slots are independent and respect their own d-pad", () => {
    const harness = createHarness({ countdownMs: 0 });
    harness.step([player(1), player(2)]);
    const p1 = harness.game.world?.players[0];
    const p2 = harness.game.world?.players[1];
    if (p1 === undefined || p2 === undefined) throw new Error("no players");

    harness.step([
      player(1, { buttons: RIGHT_BUTTON }),
      player(2, { buttons: 1 << 10 }),
    ]);
    expect(p1.body.x).toBeGreaterThan(2);
    expect(p2.body.x).toBeLessThan(2);
    expect(p1.body.y).toBeGreaterThanOrEqual(15.6 - 1e-9);
  });
});

describe("rendering", () => {
  test("[PR-9.1] a full frame draws through the 2D surface under 120 calls", () => {
    const harness = createHarness({ countdownMs: 0 });
    harness.step([player(1), player(2)]);
    const beforeRect = harness.fake.renderer.counters.rects;
    const beforeCircle = harness.fake.renderer.counters.circles;
    const beforeText = harness.fake.renderer.texts.length;

    harness.render();

    expect(harness.fake.renderer.counters.beginFrames).toBe(1);
    expect(harness.fake.renderer.counters.endFrames).toBe(1);
    const draws =
      harness.fake.renderer.counters.rects -
      beforeRect +
      (harness.fake.renderer.counters.circles - beforeCircle) +
      (harness.fake.renderer.texts.length - beforeText);
    expect(draws).toBeGreaterThan(0);
    expect(draws).toBeLessThanOrEqual(120);
    expect(harness.fake.renderer.texts).toContain("COINS 0/1");
    expect(harness.fake.renderer.texts).toContain("P1");
    expect(harness.fake.renderer.texts).toContain("P2");
  });

  test("[AR-4] results content is painted after the goal", () => {
    const harness = createHarness({ countdownMs: 0 });
    const players = [player(1), player(2)];
    const moving = players.map((state) => ({ ...state, buttons: RIGHT_BUTTON }));
    for (let tick = 0; tick < 60 && harness.game.phase !== "results"; tick += 1) {
      harness.step(moving);
    }
    harness.fake.renderer.texts.length = 0;
    harness.render();
    expect(harness.fake.renderer.texts).toContain("LEVEL COMPLETE");
    expect(harness.fake.renderer.texts).toContain("COINS 1 / 1");
  });

  test("a renderer without a 2D surface is a safe no-op", () => {
    const harness = createHarness({ flatRenderer: false, countdownMs: 0 });
    harness.step([player(1)]);
    expect(() => harness.render()).not.toThrow();
    expect(harness.fake.renderer.counters.beginFrames).toBe(0);
  });
});

describe("boundary and lifecycle", () => {
  test("[FR-7.17] the adapter has no socket, protocol, broker or fetch import", () => {
    const source = readFileSync(new URL("../src/game.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@lanpad\/(?:protocol|broker|dev-server|controller|relay)/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bWebSocket\b/);
  });

  test("dispose is idempotent and simulate/render stay no-ops", () => {
    const harness = createHarness({ countdownMs: 0 });
    harness.step([player(1)]);
    harness.game.dispose();
    harness.game.dispose();
    expect(harness.game.world).toBeNull();
    expect(() => harness.step([player(1)])).not.toThrow();
    expect(() => harness.render()).not.toThrow();
  });

  test("an invalid level fails init with a readable path", () => {
    const fake = createContext({});
    const game = createCoinRunGame(manifest, {
      level: { ...TEST_LEVEL, killY: 10 },
    });
    expect(() => game.init(fake.ctx)).toThrow(/level\.killY/);
    game.dispose();
  });

  test("slot 0 and out-of-range slots are ignored", () => {
    const harness = createHarness();
    harness.step([player(0), player(9), player(1)]);
    expect(harness.fake.layouts).toEqual([
      { slot: 1, layoutId: PF_DPAD_LAYOUT_ID },
    ]);
    expect(harness.game.connectedMask).toBe(0b10);
  });
});

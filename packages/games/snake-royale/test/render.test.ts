import { describe, expect, test } from "vitest";
import { resultsRows } from "@lanpad/game-kit";
import { createFakeContext } from "@lanpad/sdk/testing";
import { DIRECTION_RIGHT } from "../src/config.js";
import { HudCache } from "../src/hud.js";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  drawSnakeRoyale,
  resolveRenderer2D,
  type Renderer2DLike,
  type SnakeRoyaleRenderState,
} from "../src/render.js";
import { SnakeWorld } from "../src/world.js";

/**
 * Flat presentation tests (GAME-SR-HOST-04; FR-9.1, PR-9.3,
 * GAME-SR-TEST-05).
 *
 * The renderer double counts every flat call, so the expected draw counts are
 * arithmetic over the state: two circles per food (ring + centre), two per
 * snake head, one rect per body cell, and one HUD marker per participant.
 */

const ZERO_RNG = (): number => 0;

interface Counters {
  beginFrames: number;
  endFrames: number;
  clears: number;
  rects: number;
  circles: number;
  texts: string[];
}

function createSurface(size?: {
  readonly width: number;
  readonly height: number;
}): { surface: Renderer2DLike; counters: Counters } {
  const counters: Counters = {
    beginFrames: 0,
    endFrames: 0,
    clears: 0,
    rects: 0,
    circles: 0,
    texts: [],
  };
  const common = {
    beginFrame() {
      counters.beginFrames += 1;
    },
    endFrame() {
      counters.endFrames += 1;
    },
    clear() {
      counters.clears += 1;
    },
    rect() {
      counters.rects += 1;
    },
    circle() {
      counters.circles += 1;
    },
    text(text: string) {
      counters.texts.push(text);
    },
  };
  const surface: Renderer2DLike = size === undefined ? common : { ...common, size };
  return { surface, counters };
}

function createWorld(): SnakeWorld {
  const world = new SnakeWorld(ZERO_RNG, { gridSize: 8, foodCount: 2 });
  world.placeSnake(
    1,
    [world.cellIndex(3, 3), world.cellIndex(2, 3), world.cellIndex(1, 3)],
    DIRECTION_RIGHT,
  );
  expect(world.placeFoodAt(6, 6)).toBe(true);
  expect(world.placeFoodAt(5, 6)).toBe(true);
  return world;
}

function playingState(world: SnakeWorld, hud: HudCache): SnakeRoyaleRenderState {
  return {
    world,
    hud,
    phase: "playing",
    countdownRemainingMs: 0,
    matchWinner: null,
    results: [],
  };
}

describe("Snake Royale flat renderer", () => {
  test("[FR-9.1][GAME-SR-HOST-04] flat calls are feature-detected and an absent surface is null", () => {
    const context = createFakeContext();
    expect(resolveRenderer2D(context.renderer)).toBeNull();

    const { surface } = createSurface();
    expect(resolveRenderer2D(surface as never)).toBe(surface);

    const partial = { ...surface } as Partial<Renderer2DLike>;
    delete partial.circle;
    expect(resolveRenderer2D(partial as never)).toBeNull();
  });

  test("[GAME-SR-HOST-04][GAME-SR-TEST-05] a playing frame draws the board, two circles per food and head", () => {
    const world = createWorld();
    const hud = new HudCache(8);
    hud.update(world, "playing", 1, 0, 1, null, null);
    const { surface, counters } = createSurface();

    drawSnakeRoyale(surface, playingState(world, hud), 0);

    expect(counters.beginFrames).toBe(1);
    expect(counters.endFrames).toBe(1);
    expect(counters.clears).toBe(1);
    // board + 4 borders + 2 grid lines + 3 body cells + 1 HUD marker
    expect(counters.rects).toBe(11);
    // 2 foods x 2 circles + 1 head x 2 circles
    expect(counters.circles).toBe(6);
    expect(counters.texts).toContain("SNAKE ROYALE");
    expect(counters.texts).toContain("ROUND 1");
    expect(counters.texts).toContain("P1  LEN 3");
    expect(counters.texts).toContain("1 ALIVE · SHRINK IN 15s");
  });

  test("[GAME-SR-TEST-05] lobby, countdown and results overlays use the cached HUD strings", () => {
    const world = new SnakeWorld(ZERO_RNG, { gridSize: 8, foodCount: 0 });
    world.startRound(0b110);
    const hud = new HudCache(8);

    hud.update(world, "lobby", 0, 0, 2, null, null);
    const lobby = createSurface();
    drawSnakeRoyale(
      lobby.surface,
      {
        world,
        hud,
        phase: "lobby",
        countdownRemainingMs: 0,
        matchWinner: null,
        results: [],
      },
      0,
    );
    expect(lobby.counters.texts).toContain("WAITING FOR PLAYERS");
    // The cache is sized for the full eight-slot room.
    expect(lobby.counters.texts).toContain("2/8 READY");

    hud.update(world, "countdown", 1, 2500, 2, null, null);
    const countdown = createSurface();
    drawSnakeRoyale(
      countdown.surface,
      {
        world,
        hud,
        phase: "countdown",
        countdownRemainingMs: 2500,
        matchWinner: null,
        results: [],
      },
      0,
    );
    expect(countdown.counters.texts).toContain("GET READY");
    expect(countdown.counters.texts).toContain("3");
    expect(countdown.counters.texts).toContain("ROUND 1");

    const rows = resultsRows(
      [
        { slot: 1, score: 4 },
        { slot: 2, score: 4 },
      ],
      1,
    );
    hud.update(world, "results", 1, 0, 2, 1, 1);
    const results = createSurface();
    drawSnakeRoyale(
      results.surface,
      {
        world,
        hud,
        phase: "results",
        countdownRemainingMs: 0,
        matchWinner: 1,
        results: rows,
      },
      0,
    );
    expect(results.counters.texts).toContain("RESULTS");
    expect(results.counters.texts).toContain("P1 WINS THE MATCH");
    expect(results.counters.texts).toContain("TAP TO PLAY AGAIN");
    expect(results.counters.texts).toContain("P1  LEN 4");
    expect(results.counters.texts).toContain("P2  LEN 4");
  });

  test("[GAME-SR-HOST-04] the interpolation blend maps 62.5 ms onto half a logic step and clamps", () => {
    const world = new SnakeWorld(ZERO_RNG, { gridSize: 8, foodCount: 0 });
    world.spawnSnakeAt(1, 3, 3, DIRECTION_RIGHT, 3);

    world.update(62.5);
    expect(world.renderBlend(0)).toBeCloseTo(0.5, 10);
    expect(world.renderBlend(Number.NaN)).toBeCloseTo(0.5, 10);
    expect(world.renderBlend(-1)).toBeCloseTo(0.5, 10);

    world.update(62.4);
    expect(world.renderBlend(1)).toBe(1);
    expect(world.renderBlend(10)).toBe(1);
  });

  test("[PR-9.3] the HUD rebuilds a string only when its state key changes", () => {
    const world = createWorld();
    const hud = new HudCache(8);
    hud.update(world, "playing", 1, 0, 1, null, null);

    const title = hud.lines[0];
    const panel = hud.panelTexts[0];
    const status = hud.status;
    expect(title).toBe("P1  LEN 3");
    expect(panel).toBe("ALIVE · LEN 3 · →");
    expect(status).toBe("1 ALIVE · SHRINK IN 15s");

    hud.update(world, "playing", 1, 0, 1, null, null);
    expect(hud.lines[0]).toBe(title);
    expect(hud.panelTexts[0]).toBe(panel);
    expect(hud.status).toBe(status);
  });

  test("[GAME-SR-HOST-04] the design space is 1280x720 and a reported size letterboxes", () => {
    expect(DESIGN_WIDTH).toBe(1280);
    expect(DESIGN_HEIGHT).toBe(720);

    const world = createWorld();
    const hud = new HudCache(8);
    hud.update(world, "playing", 1, 0, 1, null, null);
    const { surface, counters } = createSurface({ width: 640, height: 360 });
    drawSnakeRoyale(surface, playingState(world, hud), 0);
    expect(counters.beginFrames).toBe(1);
    expect(counters.texts).toContain("SNAKE ROYALE");
  });
});

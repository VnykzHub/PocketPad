import { describe, expect, test } from "vitest";
import type {
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameRenderer3D,
  JsonValue,
  LayoutDocument,
} from "@lanpad/sdk";
import {
  createFakeContext,
  createFakeInput,
  createFakePlayer,
  type FakeInput,
} from "@lanpad/sdk/testing";
import {
  DIRECTION_RIGHT,
  DIRECTION_UP,
  SNAKE_DPAD_LAYOUT_ID,
} from "../src/config.js";
import createSnakeRoyaleGame, {
  createSnakeRoyaleGame as namedFactory,
  type SnakeRoyaleGame,
  type SnakeRoyaleGameOptions,
} from "../src/game.js";
import type { Renderer2DLike } from "../src/render.js";
import { SnakeWorld } from "../src/world.js";

/**
 * Host adapter tests (GAME-SR-HOST-01..05, GAME-SR-CTRL-02/03,
 * GAME-SR-TEST-04; D3-SDK-01, FR-8.1, FR-8.4, FR-9.1, G4, PR-9.3).
 *
 * These drive the default-export factory the runtime loads, with the SDK fake
 * context and hand-built packets. The 2-player round is fully deterministic:
 * both snakes spawn heading at opposite side walls, so slot 1 leaves the grid
 * on step 16 and slot 2 on step 17 (no turns means no other outcome).
 */

const TICK_SECONDS = 1 / 60;
const UP_EDGE = 1 << 8;
const LEFT_EDGE = 1 << 10;

interface FlatRenderer extends GameRenderer3D, Renderer2DLike {}

interface LayoutSet {
  readonly target: number | "all";
  readonly layout: LayoutDocument | string;
}

interface PanelSet {
  readonly slot: number;
  readonly content: JsonValue;
}

interface Recorder {
  readonly ctx: GameContext;
  readonly input: FakeInput;
  readonly texts: string[];
  readonly layoutSets: LayoutSet[];
  readonly layoutClears: Array<number | "all">;
  readonly panelSets: PanelSet[];
  readonly panelClears: number[];
  readonly panelTexts: Map<number, string>;
}

function createFlatRenderer(): { renderer: FlatRenderer; texts: string[] } {
  const texts: string[] = [];
  const renderer: FlatRenderer = {
    backend: "canvas2d",
    beginFrame() {},
    endFrame() {},
    drawCalls: 0,
    textureMemoryMB: 0,
    setCamera() {},
    drawCube() {},
    clear() {},
    rect() {},
    circle() {},
    text(text: string) {
      texts.push(text);
    },
  };
  return { renderer, texts };
}

function panelTextOf(content: JsonValue): string | null {
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    return null;
  }
  const text = (content as Record<string, JsonValue>)["text"];
  return typeof text === "string" ? text : null;
}

function createRecorder(players: readonly GameControllerState[]): Recorder {
  const input = createFakeInput(players);
  const { renderer, texts } = createFlatRenderer();
  const layoutSets: LayoutSet[] = [];
  const layoutClears: Array<number | "all"> = [];
  const panelSets: PanelSet[] = [];
  const panelClears: number[] = [];
  const panelTexts = new Map<number, string>();

  const recordPanel = (slot: number, content: JsonValue): void => {
    panelSets.push({ slot, content });
    const text = panelTextOf(content);
    if (text !== null) {
      panelTexts.set(slot, text);
    }
  };

  const ctx = createFakeContext({
    input,
    renderer,
    layouts: {
      set(target, layout) {
        layoutSets.push({ target, layout });
      },
      clear(target) {
        layoutClears.push(target);
      },
    },
    panels: {
      set: recordPanel,
      show: recordPanel,
      clear(slot) {
        panelClears.push(slot);
        panelTexts.delete(slot);
      },
    },
  });

  return {
    ctx,
    input,
    texts,
    layoutSets,
    layoutClears,
    panelSets,
    panelClears,
    panelTexts,
  };
}

function tick(game: SnakeRoyaleGame, input: FakeInput): void {
  game.simulate(TICK_SECONDS, input.poll());
}

function advanceUntil(
  game: SnakeRoyaleGame,
  input: FakeInput,
  predicate: () => boolean,
  maxTicks: number,
  label: string,
): number {
  let ticks = 0;
  while (!predicate() && ticks < maxTicks) {
    game.simulate(TICK_SECONDS, input.poll());
    ticks += 1;
  }
  expect(predicate(), `${label} after ${ticks} ticks`).toBe(true);
  return ticks;
}

function startPlaying(game: SnakeRoyaleGame, input: FakeInput): void {
  tick(game, input);
  advanceUntil(game, input, () => game.phase === "playing", 10, "playing");
}

function worldOf(game: SnakeRoyaleGame): SnakeWorld {
  const world = game.world;
  if (world === null) {
    throw new Error("game has no world");
  }
  return world;
}

function players1To(count: number): GameControllerState[] {
  const players: GameControllerState[] = [];
  for (let slot = 1; slot <= count; slot += 1) {
    players.push(createFakePlayer(slot));
  }
  return players;
}

function runTwoPlayerRound(
  options: SnakeRoyaleGameOptions = {},
): { rec: Recorder; game: SnakeRoyaleGame } {
  const rec = createRecorder([createFakePlayer(1), createFakePlayer(2)]);
  const game = createSnakeRoyaleGame(rec.ctx.manifest, {
    countdownMs: 0,
    ...options,
  });
  game.init(rec.ctx);
  startPlaying(game, rec.input);
  advanceUntil(game, rec.input, () => game.phase === "results", 900, "results");
  return { rec, game };
}

describe("Snake Royale host adapter", () => {
  test("[D3-SDK-01][FR-10.3] the default export builds a Game and dispose is idempotent", () => {
    expect(createSnakeRoyaleGame).toBe(namedFactory);

    const rec = createRecorder([createFakePlayer(1), createFakePlayer(2)]);
    const game = createSnakeRoyaleGame(rec.ctx.manifest, { countdownMs: 0 });
    expect(game.manifest).toBe(rec.ctx.manifest);
    expect(game.minPlayers).toBe(2);
    expect(game.maxPlayers).toBe(8);
    expect(game.world).toBeNull();
    expect(game.phase).toBe("lobby");

    game.init(rec.ctx);
    expect(game.world).toBeInstanceOf(SnakeWorld);
    expect(game.phase).toBe("lobby");
    expect(game.results).toEqual([]);

    game.dispose();
    expect(() => game.dispose()).not.toThrow();
    expect(game.world).toBeNull();
    expect(() => game.simulate(TICK_SECONDS, rec.input.poll())).not.toThrow();
    expect(() => game.render(0.5)).not.toThrow();
    expect(() => game.onEvent?.(1, "rematch", null)).not.toThrow();
    expect(game.phase).toBe("lobby");
    expect(game.results).toEqual([]);
    expect(game.connectedMask).toBe(0);
  });

  test("[FR-8.1][GAME-SR-CTRL-01] a layout is pushed once per connection and cleared on disconnect", () => {
    const rec = createRecorder([createFakePlayer(1), createFakePlayer(2)]);
    const game = createSnakeRoyaleGame(rec.ctx.manifest, { countdownMs: 3000 });
    game.init(rec.ctx);

    tick(game, rec.input);
    expect(game.laidOutSlots).toEqual([1, 2]);
    expect(rec.layoutSets).toEqual([
      { target: 1, layout: SNAKE_DPAD_LAYOUT_ID },
      { target: 2, layout: SNAKE_DPAD_LAYOUT_ID },
    ]);

    tick(game, rec.input);
    expect(rec.layoutSets).toHaveLength(2);

    rec.input.setPlayers([createFakePlayer(1)]);
    tick(game, rec.input);
    expect(rec.layoutClears).toEqual([2]);
    expect(game.connectedMask).toBe(0b10);

    rec.input.setPlayers([createFakePlayer(1), createFakePlayer(2)]);
    tick(game, rec.input);
    expect(game.laidOutSlots).toEqual([1, 2, 2]);
    expect(rec.layoutSets).toHaveLength(3);
    expect(rec.layoutSets[2]).toEqual({ target: 2, layout: SNAKE_DPAD_LAYOUT_ID });
  });

  test("[FR-8.4][GAME-SR-CTRL-03] panels walk SPECTATING -> GET READY -> ALIVE and stop changing while steady", () => {
    const rec = createRecorder([createFakePlayer(1)]);
    const game = createSnakeRoyaleGame(rec.ctx.manifest, { countdownMs: 3000 });
    game.init(rec.ctx);

    tick(game, rec.input);
    expect(rec.panelTexts.get(1)).toBe("SPECTATING");
    expect(rec.panelSets).toHaveLength(1);

    rec.input.setPlayers([createFakePlayer(1), createFakePlayer(2)]);
    tick(game, rec.input);
    expect(game.phase).toBe("countdown");
    expect(rec.panelTexts.get(1)).toBe("GET READY");
    expect(rec.panelTexts.get(2)).toBe("GET READY");
    expect(rec.panelSets).toHaveLength(3);

    tick(game, rec.input);
    expect(rec.panelSets).toHaveLength(3);

    advanceUntil(game, rec.input, () => game.phase === "playing", 400, "playing");
    expect(rec.panelTexts.get(1)).toBe("ALIVE · LEN 4 · →");
    expect(rec.panelTexts.get(2)).toBe("ALIVE · LEN 4 · ←");

    const published = rec.panelSets.length;
    tick(game, rec.input);
    expect(rec.panelSets.length).toBe(published);
  });

  test("[G4][FR-9.1][GAME-SR-TEST-04] two players reach results with slot 2 winning and rematch to the lobby", () => {
    const { rec, game } = runTwoPlayerRound();
    expect(game.roundWinnerSlot).toBe(2);
    expect(game.matchWinnerSlot).toBe(2);
    expect(game.round).toBe(1);

    const world = worldOf(game);
    expect(game.scores[0]).toBe(world.snakes[0]?.length);
    expect(game.scores[1]).toBe(world.snakes[1]?.length);

    const rows = game.results;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.slot)).toEqual([1, 2]);
    expect(rows.map((row) => row.winner)).toEqual([false, true]);
    expect(rows[1]?.score).toBe(world.snakes[1]?.length);

    game.render(0);
    expect(rec.texts).toContain("SNAKE ROYALE");
    expect(rec.texts).toContain("RESULTS");
    expect(rec.texts).toContain("P2 WINS THE MATCH");
    expect(rec.texts).toContain("TAP TO PLAY AGAIN");
    expect(rec.texts).toContain(`P2  LEN ${world.snakes[1]?.length ?? 0}`);

    rec.input.setPlayers([createFakePlayer(1, { edges: UP_EDGE }), createFakePlayer(2)]);
    tick(game, rec.input);
    expect(game.phase).toBe("lobby");
    expect(game.results).toEqual([]);
    expect(game.matchWinnerSlot).toBeNull();
    expect(worldOf(game).participantCount).toBe(0);

    rec.input.setPlayers([createFakePlayer(1), createFakePlayer(2)]);
    tick(game, rec.input);
    expect(game.phase).toBe("countdown");
    tick(game, rec.input);
    expect(game.phase).toBe("playing");
    expect(game.round).toBe(1);
    expect(worldOf(game).participantCount).toBe(2);
  });

  test("[FR-9.1] a named rematch event advances the results screen", () => {
    const { rec, game } = runTwoPlayerRound();
    game.onEvent?.(1, "rematch", null);
    tick(game, rec.input);
    expect(game.phase).toBe("lobby");
    expect(game.results).toEqual([]);
  });

  test("[G4][GAME-SR-TEST-04] eight players resolve to a ranked result with at most one winner", () => {
    const rec = createRecorder(players1To(8));
    const game = createSnakeRoyaleGame(rec.ctx.manifest, { countdownMs: 0 });
    game.init(rec.ctx);
    startPlaying(game, rec.input);
    advanceUntil(game, rec.input, () => game.phase === "results", 1200, "results");

    const rows = game.results;
    expect(rows).toHaveLength(8);
    const slots = rows.map((row) => row.slot);
    expect([...slots].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]?.score ?? -1;
      const current = rows[index]?.score ?? -1;
      expect(previous).toBeGreaterThanOrEqual(current);
    }

    const winners = rows.filter((row) => row.winner);
    if (game.roundWinnerSlot === null) {
      expect(winners).toHaveLength(0);
      expect(game.matchWinnerSlot).toBeNull();
    } else {
      expect(winners).toHaveLength(1);
      expect(winners[0]?.slot).toBe(game.roundWinnerSlot);
      expect(game.matchWinnerSlot).toBe(game.roundWinnerSlot);
    }
  });

  test("[GAME-SR-CTRL-02] a reversal is ignored and a perpendicular turn applies on the next step", () => {
    const rec = createRecorder([createFakePlayer(1), createFakePlayer(2)]);
    const game = createSnakeRoyaleGame(rec.ctx.manifest, { countdownMs: 0 });
    game.init(rec.ctx);
    startPlaying(game, rec.input);

    const world = worldOf(game);
    const snake = world.snakes[0];
    if (snake === undefined) {
      throw new Error("slot 1 has no snake");
    }
    expect(snake.direction).toBe(DIRECTION_RIGHT);

    rec.input.setPlayers([createFakePlayer(1, { edges: LEFT_EDGE }), createFakePlayer(2)]);
    tick(game, rec.input);
    expect(snake.direction).toBe(DIRECTION_RIGHT);
    expect(snake.turn).toBe(-1);

    rec.input.setPlayers([createFakePlayer(1, { edges: UP_EDGE }), createFakePlayer(2)]);
    tick(game, rec.input);
    expect(snake.direction === DIRECTION_UP || snake.turn === DIRECTION_UP).toBe(true);

    rec.input.setPlayers([createFakePlayer(1), createFakePlayer(2)]);
    advanceUntil(game, rec.input, () => world.stepCount >= 1, 20, "first step");
    expect(snake.direction).toBe(DIRECTION_UP);
  });

  test("[GAME-SR-HOST-05] a dropped player keeps its snake until grace expires and resumes on reconnect", () => {
    const rec = createRecorder([createFakePlayer(1), createFakePlayer(2)]);
    const game = createSnakeRoyaleGame(rec.ctx.manifest, {
      countdownMs: 0,
      world: { respawnGraceMs: 500 },
    });
    game.init(rec.ctx);
    startPlaying(game, rec.input);

    const world = worldOf(game);
    rec.input.setPlayers([createFakePlayer(1)]);
    tick(game, rec.input);
    expect(game.connectedMask).toBe(0b10);
    expect(world.snakes[1]?.connected).toBe(false);
    expect(world.snakes[1]?.alive).toBe(true);

    rec.input.setPlayers([createFakePlayer(1), createFakePlayer(2)]);
    tick(game, rec.input);
    expect(game.connectedMask).toBe(0b110);
    expect(world.snakes[1]?.connected).toBe(true);
    expect(world.snakes[1]?.alive).toBe(true);
  });

  test("[GAME-SR-HOST-05] a snake disconnected past the grace window is eliminated and play continues", () => {
    const rec = createRecorder(players1To(3));
    const game = createSnakeRoyaleGame(rec.ctx.manifest, {
      countdownMs: 0,
      world: { respawnGraceMs: 500 },
    });
    game.init(rec.ctx);
    startPlaying(game, rec.input);

    const world = worldOf(game);
    expect(world.participantCount).toBe(3);
    rec.input.setPlayers([createFakePlayer(1), createFakePlayer(2)]);
    advanceUntil(
      game,
      rec.input,
      () => world.snakes[2]?.alive === false,
      100,
      "grace elimination",
    );

    expect(world.aliveCount).toBe(2);
    expect(world.winnerSlot()).toBeNull();
    expect(game.phase).toBe("playing");
  });

  test("[GAME-SR-TEST-04][FR-9.1] results fall back to the lobby when the roster drops below the minimum", () => {
    const { rec, game } = runTwoPlayerRound();
    expect(game.phase).toBe("results");

    rec.input.setPlayers([createFakePlayer(1)]);
    tick(game, rec.input);
    expect(game.phase).toBe("lobby");
    expect(game.results).toEqual([]);
    expect(game.round).toBe(0);
    expect(game.matchWinnerSlot).toBeNull();
    expect(worldOf(game).participantCount).toBe(0);
  });

  test("[GAME-SR-HOST-05] losing the roster during the countdown returns to the lobby", () => {
    const rec = createRecorder([createFakePlayer(1), createFakePlayer(2)]);
    const game = createSnakeRoyaleGame(rec.ctx.manifest, { countdownMs: 3000 });
    game.init(rec.ctx);

    tick(game, rec.input);
    expect(game.phase).toBe("countdown");

    rec.input.setPlayers([createFakePlayer(1)]);
    tick(game, rec.input);
    expect(game.phase).toBe("lobby");
    expect(worldOf(game).participantCount).toBe(0);
    expect(rec.panelTexts.get(1)).toBe("SPECTATING");
  });

  test("[PR-9.3] a steady lobby tick publishes no layout or panel updates", () => {
    const rec = createRecorder([createFakePlayer(1)]);
    const game = createSnakeRoyaleGame(rec.ctx.manifest, { countdownMs: 3000 });
    game.init(rec.ctx);

    tick(game, rec.input);
    const layouts = rec.layoutSets.length;
    const panels = rec.panelSets.length;

    for (let index = 0; index < 10; index += 1) {
      tick(game, rec.input);
    }
    expect(rec.layoutSets.length).toBe(layouts);
    expect(rec.panelSets.length).toBe(panels);
  });

  test("[FR-9.1] simulate and render are safe with a non-flat renderer", () => {
    const input = createFakeInput([createFakePlayer(1), createFakePlayer(2)]);
    const ctx = createFakeContext({ input });
    const game = createSnakeRoyaleGame(ctx.manifest, { countdownMs: 0 });
    game.init(ctx);

    const snapshot: GameInputSnapshot = input.poll();
    expect(() => game.simulate(TICK_SECONDS, snapshot)).not.toThrow();
    expect(() => game.simulate(TICK_SECONDS, snapshot)).not.toThrow();
    expect(() => game.render(0.25)).not.toThrow();
  });
});

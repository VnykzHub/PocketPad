import { describe, expect, test } from "vitest";
import type { GameControllerState } from "@lanpad/sdk";
import {
  createFakeContext,
  createFakeInput,
  createFakePlayer,
} from "@lanpad/sdk/testing";
import createTiltMazeGameDefault, {
  createTiltMazeGame,
  type TiltMazeGame,
  type TiltMazeGameOptions,
} from "../src/game.js";
import {
  TICK_SECONDS,
  advanceUntil,
  eightPlayerMaze,
  fixtureMaze,
  playersTo,
  startGame,
  startPlaying,
  tick,
  verticalMaze,
  worldOf,
  type Recorder,
} from "./helpers.js";

/**
 * Host adapter contract (GAME-TM-HOST-01..05; GAME-TM-CTRL-01/02; G8,
 * ER-24-01, FR-8.2, FR-8.10, FR-9.1, PR-9.3, C6, C9).
 *
 * Every test drives the factory the host discovers, through the fake
 * `GameContext`/input kit, with synthetic mazes. No DOM, Babylon or real
 * device is involved; gyro secure-context behavior stays PENDING by design.
 */

function controller(
  slot: number,
  overrides: Partial<GameControllerState> = {},
): GameControllerState {
  return createFakePlayer(slot, overrides);
}

function fixtureGame(
  count = 2,
  options: TiltMazeGameOptions = {},
): { rec: Recorder; game: TiltMazeGame } {
  return startGame(playersTo(count), { maze: fixtureMaze(), ...options });
}

function tiltState(angleX: number, angleY: number) {
  return { angleX, angleY, available: true };
}

function setPlayers(rec: Recorder, ...players: GameControllerState[]): void {
  rec.input.setPlayers(players);
}

function stick(slot: number): GameControllerState {
  return controller(slot, { lx: 1, ly: 0 });
}

function idle(slot: number): GameControllerState {
  return controller(slot);
}

describe("factory and lifecycle", () => {
  test("[G8] the default export is the factory and dispose is idempotent", () => {
    expect(createTiltMazeGameDefault).toBe(createTiltMazeGame);

    const manifest = createFakeContext().manifest;
    const uninitialised = createTiltMazeGame(manifest, { maze: fixtureMaze() });
    expect(uninitialised.world).toBeNull();
    expect(uninitialised.phase).toBe("lobby");

    const { rec, game } = fixtureGame();
    expect(game.world).not.toBeNull();
    expect(game.minPlayers).toBe(2);
    expect(game.maxPlayers).toBe(8);

    game.dispose();
    expect(game.world).toBeNull();
    expect(game.phase).toBe("lobby");

    expect(() => tick(game, rec.input)).not.toThrow();
    expect(() => game.render(1)).not.toThrow();
    expect(() => game.onEvent?.(1, "rematch", null)).not.toThrow();
    expect(rec.stats.frames).toBe(0);

    game.dispose();
    expect(game.world).toBeNull();
  });

  test("[FR-10.3] the roster is clamped to the protocol's 2..8 players", () => {
    const manifest = { ...createFakeContext().manifest, minPlayers: 1, maxPlayers: 9 };
    const wide = createTiltMazeGame(manifest, { maze: fixtureMaze() });
    expect(wide.minPlayers).toBe(2);
    expect(wide.maxPlayers).toBe(8);

    const tight = createTiltMazeGame(
      { ...manifest, minPlayers: 3, maxPlayers: 5 },
      { maze: fixtureMaze() },
    );
    expect(tight.minPlayers).toBe(3);
    expect(tight.maxPlayers).toBe(5);
  });

  test("[C9] invalid maze data fails with a content-author message", () => {
    const manifest = createFakeContext().manifest;
    expect(() => createTiltMazeGame(manifest, { maze: { width: 10 } })).toThrow(
      /invalid maze data/,
    );
    expect(() =>
      createTiltMazeGame(manifest, {
        maze: { ...fixtureMaze(), start: [{ x: 10, y: 10 }] },
      }),
    ).toThrow(/invalid maze data/);
  });
});

describe("layouts and private panels", () => {
  test("[FR-8.2] each connected slot receives the tilt layout exactly once", () => {
    const { rec, game } = fixtureGame();
    expect(rec.layoutSets).toEqual([]);

    tick(game, rec.input);
    expect(rec.layoutSets).toEqual([
      { target: 1, layout: "tm-tilt-v1" },
      { target: 2, layout: "tm-tilt-v1" },
    ]);
    expect(game.laidOutSlots).toEqual([1, 2]);

    tick(game, rec.input);
    tick(game, rec.input);
    expect(rec.layoutSets).toHaveLength(2);
  });

  test("[FR-8.10][FR-8.2] stickOnly selects the stick layout for every slot", () => {
    const { rec, game } = fixtureGame(2, { stickOnly: true });
    tick(game, rec.input);
    expect(rec.layoutSets.map((set) => set.layout)).toEqual([
      "tm-stick-v1",
      "tm-stick-v1",
    ]);
  });

  test("[FR-8.2] disconnect clears the layout and panel; reconnect applies them again", () => {
    const { rec, game } = fixtureGame();
    startPlaying(game, rec.input);
    expect(worldOf(game).ball(1)?.connected).toBe(true);

    setPlayers(rec, controller(2));
    tick(game, rec.input);
    expect(rec.layoutClears).toContain(1);
    expect(rec.panelClears).toContain(1);
    expect(worldOf(game).ball(1)?.connected).toBe(false);

    setPlayers(rec, controller(1), controller(2));
    tick(game, rec.input);
    expect(rec.layoutSets.filter((set) => set.target === 1)).toHaveLength(2);
    expect(worldOf(game).ball(1)?.connected).toBe(true);
  });

  test("[FR-8.10][G5] phone panels start at GET READY and are only re-sent on change", () => {
    const { rec, game } = fixtureGame();
    tick(game, rec.input);
    expect(game.phase).toBe("countdown");
    expect(rec.panelSets[0]?.content).toEqual({
      kind: "text",
      title: "TILT MAZE RACE",
      text: "GET READY",
    });
    expect(rec.panelTexts.get(1)).toBe("GET READY");
    expect(rec.panelTexts.get(2)).toBe("GET READY");

    tick(game, rec.input);
    expect(game.phase).toBe("playing");
    expect(rec.panelTexts.get(1)).toBe("RACING - TILT OR STICK");

    const playingPublishes = rec.panelSets.length;
    tick(game, rec.input);
    tick(game, rec.input);
    expect(rec.panelSets.length).toBe(playingPublishes);
  });

  test("[G5] a player who joins after the roster is frozen spectates", () => {
    const { rec, game } = fixtureGame(2);
    startPlaying(game, rec.input);

    setPlayers(rec, controller(1), controller(2), controller(3));
    tick(game, rec.input);

    expect(worldOf(game).participates(3)).toBe(false);
    expect(rec.panelTexts.get(3)).toBe("SPECTATING");
    expect(rec.layoutSets.filter((set) => set.target === 3)).toHaveLength(1);
  });
});

describe("countdown", () => {
  test("[ER-24-01][G4] the countdown holds every ball at its start until GO", () => {
    const { rec, game } = fixtureGame(2, { countdownMs: 2500 });
    tick(game, rec.input);

    expect(game.phase).toBe("countdown");
    expect(game.round).toBe(0);
    expect(worldOf(game).participantCount).toBe(2);
    const startX = worldOf(game).ball(1)?.x ?? 0;

    game.render(1);
    expect(rec.texts).toContain("GET READY - 3");

    setPlayers(rec, stick(1), stick(2));
    for (let index = 0; index < 100; index += 1) {
      tick(game, rec.input);
    }
    expect(game.phase).toBe("countdown");
    expect(worldOf(game).ball(1)?.x).toBe(startX);

    advanceUntil(game, rec.input, () => game.phase === "playing", 120, "playing");
    expect(game.round).toBe(1);
    expect(rec.texts.some((text) => text.startsWith("P1  "))).toBe(true);
  });
});

describe("races and results", () => {
  test("[C9][G4] a stick race ends on the first finish and ranks the field", () => {
    const { rec, game } = fixtureGame(2);
    startPlaying(game, rec.input);
    setPlayers(rec, stick(1), idle(2));

    advanceUntil(game, rec.input, () => game.phase === "results", 400, "results");

    expect(game.roundWinnerSlot).toBe(1);
    expect(game.matchWinnerSlot).toBe(1);
    expect(game.finishOrder).toEqual([1]);
    expect(worldOf(game).ball(1)?.finished).toBe(true);
    expect(worldOf(game).elapsedMs).toBeGreaterThan(0);
    expect(game.scores[0]).toBe(8);
    expect(game.scores[1]).toBe(0);
    expect(game.results.map((row) => row.slot)).toEqual([1, 2]);
    expect(game.results[0]?.winner).toBe(true);
    expect(game.results[1]?.winner).toBe(false);
    expect(rec.panelTexts.get(1)).toBe("YOU WIN THE MATCH!");
    expect(rec.panelTexts.get(2)).toBe("RACE OVER");

    game.render(1);
    expect(rec.texts).toContain("RESULTS");
    expect(rec.texts).toContain("TAP TO PLAY AGAIN");
    expect(rec.texts.some((text) => text.startsWith("P1  1st - "))).toBe(true);
  });

  test("[C6] a tilt race reaches the same results path as the stick", () => {
    const { rec, game } = fixtureGame(2);
    startPlaying(game, rec.input);
    setPlayers(rec, controller(1, { tilt: tiltState(30, 0) }), idle(2));

    advanceUntil(game, rec.input, () => game.phase === "results", 600, "results");

    expect(game.roundWinnerSlot).toBe(1);
    expect(worldOf(game).ball(1)?.finished).toBe(true);
    expect(worldOf(game).ball(1)?.vx).toBe(0);
    expect(game.results[0]?.slot).toBe(1);
  });

  test("[FR-7.6][C6] forward tilt rolls up-screen to the exit", () => {
    const { rec, game } = startGame(playersTo(2), { maze: verticalMaze() });
    startPlaying(game, rec.input);
    setPlayers(rec, controller(1, { tilt: tiltState(0, 30) }), idle(2));

    advanceUntil(game, rec.input, () => game.phase === "results", 600, "results");

    expect(game.roundWinnerSlot).toBe(1);
    const winner = worldOf(game).ball(1);
    expect(winner?.finished).toBe(true);
    expect(winner?.finishRank).toBe(1);
  });

  test("[FR-7.6][C6][G5] recenter suppresses tilt until the player moves again", () => {
    const { rec, game } = fixtureGame(2);
    startPlaying(game, rec.input);

    setPlayers(rec, controller(1, { tilt: tiltState(30, 0) }), idle(2));
    for (let index = 0; index < 20; index += 1) {
      tick(game, rec.input);
    }
    const ball = worldOf(game).ball(1);
    if (ball === undefined) {
      throw new Error("no ball for slot 1");
    }
    const movingSpeed = ball.speed();
    expect(movingSpeed).toBeGreaterThan(0);

    setPlayers(
      rec,
      controller(1, { tilt: tiltState(30, 0), gyroRecentered: true }),
      idle(2),
    );
    tick(game, rec.input);
    expect(ball.ax).toBe(0);
    const recenteredSpeed = ball.speed();
    expect(recenteredSpeed).toBeLessThan(movingSpeed);

    setPlayers(rec, controller(1, { tilt: tiltState(30, 0) }), idle(2));
    tick(game, rec.input);
    expect(ball.ax).toBeCloseTo(450, 6);
    expect(ball.speed()).toBeGreaterThan(recenteredSpeed);
  });
});

describe("rounds, rematch and fallback", () => {
  test("[ER-24-01][G4] holding the stick through results does not skip them", () => {
    const { rec, game } = fixtureGame(2);
    startPlaying(game, rec.input);
    setPlayers(rec, stick(1), idle(2));
    advanceUntil(game, rec.input, () => game.phase === "results", 400, "results");

    // The player never released the stick; results must wait for them.
    for (let index = 0; index < 5; index += 1) {
      tick(game, rec.input);
    }
    expect(game.phase).toBe("results");

    setPlayers(rec, idle(1), idle(2));
    tick(game, rec.input);
    expect(game.phase).toBe("results");

    setPlayers(rec, stick(1), idle(2));
    tick(game, rec.input);
    expect(game.phase).toBe("lobby");
    expect(game.matchWinnerSlot).toBeNull();
    expect(game.results).toHaveLength(0);

    setPlayers(rec, idle(1), idle(2));
    advanceUntil(game, rec.input, () => game.phase === "playing", 10, "playing");
    expect(game.round).toBe(1);
    expect(game.finishOrder).toEqual([]);
    expect(worldOf(game).ball(1)?.x).toBe(60);
    expect(worldOf(game).ball(1)?.y).toBe(80);
  });

  test("[ER-24-01][G4] round wins accumulate until the match target is reached", () => {
    const { rec, game } = fixtureGame(2, { roundsToWin: 2 });
    startPlaying(game, rec.input);

    setPlayers(rec, stick(1), idle(2));
    advanceUntil(game, rec.input, () => game.phase === "results", 400, "results");
    expect(game.matchWinnerSlot).toBeNull();
    expect(game.roundWinnerSlot).toBe(1);
    expect(rec.panelTexts.get(1)).toBe("YOU WIN THE RACE!");
    expect(rec.panelTexts.get(2)).toBe("RACE OVER");

    setPlayers(rec, idle(1), idle(2));
    tick(game, rec.input);
    setPlayers(rec, stick(1), idle(2));
    tick(game, rec.input);
    expect(game.phase).toBe("countdown");

    advanceUntil(game, rec.input, () => game.phase === "playing", 10, "playing");
    expect(game.round).toBe(2);
    advanceUntil(game, rec.input, () => game.phase === "results", 400, "results");

    expect(game.matchWinnerSlot).toBe(1);
    expect(game.roundWinnerSlot).toBe(1);
    expect(game.results[0]?.winner).toBe(true);
    expect(rec.panelTexts.get(1)).toBe("YOU WIN THE MATCH!");
  });

  test("[ER-24-01][G4] results fall back to the lobby when the room empties", () => {
    const { rec, game } = fixtureGame(2);
    startPlaying(game, rec.input);
    setPlayers(rec, stick(1), idle(2));
    advanceUntil(game, rec.input, () => game.phase === "results", 400, "results");

    setPlayers(rec);
    tick(game, rec.input);

    expect(game.phase).toBe("lobby");
    expect(game.results).toHaveLength(0);
    expect(game.roundWinnerSlot).toBeNull();
    expect(worldOf(game).participantCount).toBe(0);
    expect(rec.layoutClears).toEqual(expect.arrayContaining([1, 2]));
    expect(rec.panelClears).toEqual(expect.arrayContaining([1, 2]));
  });
});

describe("rendering", () => {
  test("[FR-9.1][PR-9.3] eight players stay far under the draw-call budget", () => {
    const { rec, game } = startGame(playersTo(8), { maze: eightPlayerMaze() });
    startPlaying(game, rec.input);
    expect(worldOf(game).participantCount).toBe(8);

    const ball = worldOf(game).ball(1);
    if (ball === undefined) {
      throw new Error("no ball for slot 1");
    }
    const before = { x: ball.x, y: ball.y, prevX: ball.prevX, prevY: ball.prevY };
    game.render(0.5);

    expect(rec.stats.frames).toBe(1);
    const drawCalls = rec.stats.rects + rec.stats.circles + rec.stats.texts;
    expect(drawCalls).toBeGreaterThan(0);
    expect(drawCalls).toBeLessThanOrEqual(120);
    expect(rec.texts).toContain("TILT MAZE RACE");
    expect(rec.texts.some((text) => text.startsWith("P1  RACING"))).toBe(true);
    expect({ x: ball.x, y: ball.y, prevX: ball.prevX, prevY: ball.prevY }).toEqual(before);
  });

  test("[G8] a renderer without a flat surface simulates without drawing", () => {
    const input = createFakeInput(playersTo(2));
    const ctx = createFakeContext({ input });
    const game = createTiltMazeGame(ctx.manifest, {
      countdownMs: 0,
      maze: fixtureMaze(),
    });
    game.init(ctx);

    game.simulate(TICK_SECONDS, input.poll());
    expect(game.phase).toBe("countdown");
    expect(() => game.render(1)).not.toThrow();

    game.simulate(TICK_SECONDS, input.poll());
    expect(game.phase).toBe("playing");
    expect(game.world).not.toBeNull();

    game.dispose();
  });
});

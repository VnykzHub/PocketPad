/**
 * Reaction Duel adapter tests (GAME-RD-TEST-01..06, D7-SDK-01, A12).
 *
 * The pure model and adjudicator already have their own suites; these tests
 * drive the `GameModule` adapter the host actually loads:
 *
 * - the shipped manifest is valid and the factory has the frozen shape;
 * - joining slots receive the four-button layout exactly once;
 * - 2..8 slots start one match, below the minimum stays in the lobby;
 * - false starts, ties, no-taps and synced-tick wins surface in `lastRound`;
 * - rendering paints the target label+symbol through the 2D surface;
 * - rematch events and idempotent dispose behave.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type {
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameManifest,
  GameRenderer3D,
  JsonValue,
  LayoutDocument,
} from "@lanpad/sdk";
import { validateManifest } from "@lanpad/sdk";
import type { ReactionDuelConfig } from "../src/model.js";
import {
  createReactionDuelGame,
  REACTION_DUEL_LAYOUT_ID,
  resolveRenderer2D,
  TARGET_LABELS,
  TARGET_SYMBOLS,
} from "../src/game.js";
import type { ReactionDuelGame } from "../src/game.js";

const manifestPath = fileURLToPath(new URL("../game.manifest.json", import.meta.url));
const manifestResult = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
if (!manifestResult.ok) {
  throw new Error(`Shipped manifest is invalid: ${manifestResult.errors.join("; ")}`);
}
const manifest: GameManifest = manifestResult.manifest;

interface FakeRenderer {
  readonly renderer: GameRenderer3D;
  readonly texts: string[];
  readonly counters: { beginFrames: number; endFrames: number };
}

function createRenderer(options: { flat: boolean }): FakeRenderer {
  const texts: string[] = [];
  const counters = { beginFrames: 0, endFrames: 0 };
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
        rect: () => undefined,
        circle: () => undefined,
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
  /** Slots whose layout was cleared, in call order. */
  readonly clearedLayouts: number[];
  readonly counters: Map<string, number>;
  readonly renderer: FakeRenderer;
}

function createContext(options: {
  serverNow: () => number;
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
      seed: 7,
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
      set: (slot: number | "all", layoutId: string | LayoutDocument): void => {
        if (options.layoutThrows === true) {
          throw new Error("layouts not available");
        }
        if (typeof slot === "number" && typeof layoutId === "string") {
          layouts.push({ slot, layoutId });
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
    serverNow: options.serverNow,
  };
  return { ctx, layouts, clearedLayouts, counters, renderer };
}

interface Harness {
  readonly game: ReactionDuelGame;
  readonly fake: FakeContext;
  readonly clock: { now: number };
  step(players: readonly GameControllerState[], dtSeconds?: number): void;
  stepAt(now: number, players: readonly GameControllerState[]): void;
}

function createHarness(options: {
  config?: Partial<ReactionDuelConfig>;
  seed?: number;
  flatRenderer?: boolean;
  layoutThrows?: boolean;
} = {}): Harness {
  const clock = { now: 1000 };
  const fake = createContext({
    serverNow: () => clock.now,
    ...(options.flatRenderer === undefined ? {} : { flatRenderer: options.flatRenderer }),
    ...(options.layoutThrows === undefined ? {} : { layoutThrows: options.layoutThrows }),
  });
  const game = createReactionDuelGame(manifest, {
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  game.init(fake.ctx);
  return {
    game,
    fake,
    clock,
    step(players, dtSeconds = 1 / 60): void {
      clock.now += dtSeconds * 1000;
      game.simulate(dtSeconds, { tick: 0, players });
    },
    stepAt(now, players): void {
      clock.now = now;
      game.simulate(1 / 60, { tick: 0, players });
    },
  };
}

function player(
  slot: number,
  overrides: Partial<GameControllerState> = {},
): GameControllerState {
  return {
    slot,
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
    tick: 1000,
    ...overrides,
  };
}

function slots(count: number): GameControllerState[] {
  const players: GameControllerState[] = [];
  for (let slot = 1; slot <= count; slot += 1) {
    players.push(player(slot));
  }
  return players;
}

function modelOf(harness: Harness) {
  const model = harness.game.model;
  if (model === null) throw new Error("game was not initialized");
  return model;
}

/** Starts the match and advances through countdown + random wait to signal. */
function reachSignal(harness: Harness, count = 2): void {
  const players = slots(count);
  harness.step(players);
  const model = modelOf(harness);
  const countdownEnd = model.phaseEndsAt;
  if (countdownEnd === null) throw new Error("match did not start");
  harness.stepAt(countdownEnd, players);
  if (model.phase === "waiting") {
    const waitEnd = model.phaseEndsAt;
    if (waitEnd === null) throw new Error("waiting phase has no end");
    harness.stepAt(waitEnd, players);
  }
  expect(model.phase).toBe("signal");
}

describe("manifest + module shape", () => {
  test("[FR-10.3] the shipped manifest validates and names the four-button layout", () => {
    expect(manifestResult.ok).toBe(true);
    expect(manifest.name).toBe("Reaction Duel");
    expect(manifest.minPlayers).toBe(2);
    expect(manifest.maxPlayers).toBe(8);
    expect(manifest.needsGyro).toBe(false);
    expect(manifest.layouts).toEqual([`layouts/${REACTION_DUEL_LAYOUT_ID}.json`]);
  });

  test("[FR-10.3] the default export builds a Game with the frozen members", () => {
    const game = createReactionDuelGame(manifest);
    expect(game.manifest).toBe(manifest);
    expect(typeof game.init).toBe("function");
    expect(typeof game.simulate).toBe("function");
    expect(typeof game.render).toBe("function");
    expect(typeof game.dispose).toBe("function");
    expect(game.model).toBeNull();
    expect(game.lastResult).toBeNull();
    game.dispose();
  });

  test("[PR-9.3] the adapter allocates no player records per tick", () => {
    const harness = createHarness();
    const players = slots(2);
    harness.step(players);
    const model = modelOf(harness);
    const before = model.getPlayers().length;
    harness.step(players);
    harness.step(players);
    expect(model.getPlayers().length).toBe(before);
  });
});

describe("layout application", () => {
  test("[A12][FR-8.2] each joining slot receives the four-button layout once", () => {
    const harness = createHarness();
    harness.step([player(1)]);
    expect(harness.fake.layouts).toEqual([
      { slot: 1, layoutId: REACTION_DUEL_LAYOUT_ID },
    ]);

    harness.step([player(1), player(2)]);
    expect(harness.fake.layouts).toHaveLength(2);
    expect(harness.fake.layouts[1]).toEqual({
      slot: 2,
      layoutId: REACTION_DUEL_LAYOUT_ID,
    });

    harness.step([player(1), player(2)]);
    harness.step([player(1), player(2)]);
    expect(harness.fake.layouts).toHaveLength(2);
    expect(harness.game.laidOutSlots).toEqual([1, 2]);
  });

  test("[FR-8.2][FR-5.4] a reused slot re-applies the layout and starts at score 0", () => {
    const harness = createHarness({
      config: {
        countdownMs: 0,
        minDelayMs: 0,
        maxDelayMs: 0,
        roundResultMs: 60_000,
        noTapTimeoutMs: 1000,
      },
      seed: 31,
    });
    const players = slots(2);
    harness.step(players);
    harness.step(players);
    const model = modelOf(harness);
    expect(model.phase).toBe("signal");
    const target = model.targetBit;
    const signalAt = model.signalAt;
    if (target === null || signalAt === null) throw new Error("no signal");

    // Slot 2 scores, then leaves the snapshot.
    harness.stepAt(signalAt + 10, [
      player(1),
      player(2, { buttons: 1 << target, edges: 1 << target, tick: signalAt + 5 }),
    ]);
    expect(model.getPlayer(2)?.score).toBe(1);
    expect(harness.fake.layouts).toHaveLength(2);

    harness.step([player(1)]);
    expect(model.getPlayer(2)?.connected).toBe(false);
    expect(harness.fake.clearedLayouts).toEqual([2]);
    expect(harness.fake.layouts).toHaveLength(2);

    // A new player takes the freed slot: layout again, fresh score.
    harness.step([player(1), player(2)]);
    expect(harness.fake.clearedLayouts).toEqual([2]);
    expect(harness.fake.layouts).toEqual([
      { slot: 1, layoutId: REACTION_DUEL_LAYOUT_ID },
      { slot: 2, layoutId: REACTION_DUEL_LAYOUT_ID },
      { slot: 2, layoutId: REACTION_DUEL_LAYOUT_ID },
    ]);
    expect(harness.game.laidOutSlots).toEqual([1, 2, 2]);
    expect(model.getPlayer(2)?.connected).toBe(true);
    expect(model.getPlayer(2)?.score).toBe(0);
  });

  test("[FR-8.2] a throwing layouts API never stops the match", () => {
    const harness = createHarness({ layoutThrows: true });
    harness.step(slots(2));
    const model = modelOf(harness);
    expect(model.playerCount).toBe(2);
    expect(model.phase).toBe("countdown");
    expect(harness.fake.counters.get("layoutErrors")).toBe(2);
  });

  test("slot 0 and out-of-range slots are ignored", () => {
    const harness = createHarness();
    harness.step([player(0), player(9), player(1)]);
    expect(harness.fake.layouts).toEqual([
      { slot: 1, layoutId: REACTION_DUEL_LAYOUT_ID },
    ]);
    expect(modelOf(harness).playerCount).toBe(1);
  });
});

describe("player counts (2..8)", () => {
  test("[A12] one player stays in the lobby", () => {
    const harness = createHarness();
    for (let index = 0; index < 10; index += 1) {
      harness.step([player(1)]);
    }
    const model = modelOf(harness);
    expect(model.phase).toBe("lobby");
    expect(model.playerCount).toBe(1);
    expect(model.matchWinnerSlot).toBeNull();
  });

  test("[A12] two players start the match", () => {
    const harness = createHarness();
    harness.step(slots(2));
    const model = modelOf(harness);
    expect(model.phase).toBe("countdown");
    expect(model.playerCount).toBe(2);
  });

  test("[A12] eight players start and the highest slot can win", () => {
    const harness = createHarness({ seed: 3 });
    harness.step(slots(8));
    const model = modelOf(harness);
    expect(model.phase).toBe("countdown");
    expect(model.playerCount).toBe(8);
    expect(harness.fake.layouts).toHaveLength(8);

    reachSignal(harness, 8);
    const target = model.targetBit;
    if (target === null) throw new Error("signal has no target");
    const winTick = (model.signalAt ?? 0) + 25;
    harness.stepAt(winTick + 5, [
      ...slots(7),
      player(8, { buttons: 1 << target, edges: 1 << target, tick: winTick }),
    ]);
    const lastRound = model.lastRound;
    expect(lastRound?.decision.kind).toBe("winner");
    if (lastRound?.decision.kind !== "winner") return;
    expect(lastRound.decision.slot).toBe(8);
    expect(lastRound.decision.tick).toBe(winTick);
  });
});

describe("rules through the adapter", () => {
  test("[FR-7.10] the earliest synced tick wins regardless of slot order", () => {
    const harness = createHarness({ seed: 5 });
    harness.step(slots(2));
    const model = modelOf(harness);
    harness.stepAt(model.phaseEndsAt ?? 0, slots(2));
    harness.stepAt(model.phaseEndsAt ?? 0, slots(2));
    expect(model.phase).toBe("signal");

    const target = model.targetBit;
    const signalAt = model.signalAt;
    if (target === null || signalAt === null) throw new Error("no signal");
    harness.stepAt(signalAt + 100, [
      player(1, { buttons: 1 << target, edges: 1 << target, tick: signalAt + 90 }),
      player(2, { buttons: 1 << target, edges: 1 << target, tick: signalAt + 40 }),
    ]);
    const decision = model.lastRound?.decision;
    expect(decision?.kind).toBe("winner");
    if (decision?.kind !== "winner") return;
    expect(decision.slot).toBe(2);
    expect(decision.tick).toBe(signalAt + 40);
  });

  test("[A12] a pre-signal press is a false start and the other slot wins", () => {
    const harness = createHarness({ seed: 9 });
    harness.step(slots(2));
    const model = modelOf(harness);
    harness.stepAt(model.phaseEndsAt ?? 0, slots(2));
    expect(model.phase).toBe("waiting");

    const falseStartTick = harness.clock.now + 50;
    harness.stepAt(falseStartTick, [
      player(1, { buttons: 1, edges: 1, tick: falseStartTick }),
      player(2),
    ]);
    expect(model.phase).toBe("waiting");

    harness.stepAt(model.phaseEndsAt ?? 0, slots(2));
    expect(model.phase).toBe("signal");
    const target = model.targetBit;
    const signalAt = model.signalAt;
    if (target === null || signalAt === null) throw new Error("no signal");
    const winTick = signalAt + 30;
    harness.stepAt(winTick + 10, [
      player(1),
      player(2, { buttons: 1 << target, edges: 1 << target, tick: winTick }),
    ]);

    const lastRound = model.lastRound;
    expect(lastRound?.decision.kind).toBe("winner");
    if (lastRound?.decision.kind !== "winner") return;
    expect(lastRound.decision.slot).toBe(2);
    expect(lastRound.decision.presses).toEqual([
      expect.objectContaining({ slot: 1, outcome: "false-start" }),
      expect.objectContaining({ slot: 2, outcome: "match" }),
    ]);
  });

  test("[A12] matching presses inside the 1 ms tie gap replay the round", () => {
    const harness = createHarness({ seed: 11 });
    reachSignal(harness);
    const model = modelOf(harness);
    const target = model.targetBit;
    const signalAt = model.signalAt;
    if (target === null || signalAt === null) throw new Error("no signal");
    const tick = signalAt + 45;
    harness.stepAt(tick + 5, [
      player(1, { buttons: 1 << target, edges: 1 << target, tick }),
      player(2, { buttons: 1 << target, edges: 1 << target, tick }),
    ]);

    const decision = model.lastRound?.decision;
    expect(decision?.kind).toBe("replay");
    if (decision?.kind !== "replay") return;
    expect(decision.reason).toBe("tie");
    expect(decision.tiedSlots).toEqual([1, 2]);
    expect(model.phase).toBe("roundResult");
  });

  test("[A12] no tap inside 3 s is a no-tap replay", () => {
    const harness = createHarness({ seed: 13 });
    reachSignal(harness);
    const model = modelOf(harness);
    const timeoutAt = model.phaseEndsAt;
    if (timeoutAt === null) throw new Error("signal has no timeout");
    harness.stepAt(timeoutAt, slots(2));

    const decision = model.lastRound?.decision;
    expect(decision?.kind).toBe("replay");
    if (decision?.kind !== "replay") return;
    expect(decision.reason).toBe("no-tap");
    expect(model.phase).toBe("roundResult");
  });

  test("[A12] a wrong-button first press does not beat a later correct press", () => {
    const harness = createHarness({ seed: 17 });
    reachSignal(harness);
    const model = modelOf(harness);
    const target = model.targetBit;
    const signalAt = model.signalAt;
    if (target === null || signalAt === null) throw new Error("no signal");
    const wrongBit = (target + 1) % 4;
    harness.stepAt(signalAt + 60, [
      player(1, { buttons: 1 << wrongBit, edges: 1 << wrongBit, tick: signalAt + 10 }),
      player(2, { buttons: 1 << target, edges: 1 << target, tick: signalAt + 50 }),
    ]);
    const decision = model.lastRound?.decision;
    expect(decision?.kind).toBe("winner");
    if (decision?.kind !== "winner") return;
    expect(decision.slot).toBe(2);
    expect(decision.presses).toEqual([
      expect.objectContaining({ slot: 1, outcome: "miss" }),
      expect.objectContaining({ slot: 2, outcome: "match" }),
    ]);
  });
});

describe("rendering", () => {
  test("[A12][FR-8.3] the signal paints both the shape and the A/B/X/Y label", () => {
    const harness = createHarness({ seed: 19 });
    reachSignal(harness);
    const model = modelOf(harness);
    const target = model.targetBit;
    if (target === null) throw new Error("no target");

    harness.game.render(0.5);
    expect(harness.fake.renderer.counters.beginFrames).toBe(1);
    expect(harness.fake.renderer.counters.endFrames).toBe(1);
    const texts = harness.fake.renderer.texts;
    expect(texts).toContain(TARGET_SYMBOLS[target]);
    expect(texts).toContain(TARGET_LABELS[target]);
  });

  test("[E12] a 3D-only renderer degrades to no drawing instead of throwing", () => {
    const harness = createHarness({ flatRenderer: false });
    harness.step(slots(2));
    expect(resolveRenderer2D(harness.fake.ctx.renderer)).toBeNull();
    expect(() => harness.game.render(0.5)).not.toThrow();
    expect(harness.fake.renderer.counters.beginFrames).toBe(0);
  });
});

describe("lifecycle", () => {
  test("[A12] a rematch event restarts a finished match", () => {
    const harness = createHarness({
      config: {
        countdownMs: 0,
        minDelayMs: 0,
        maxDelayMs: 0,
        roundResultMs: 0,
        roundsToWin: 1,
        noTapTimeoutMs: 1000,
      },
      seed: 23,
    });
    const players = slots(2);
    harness.step(players);
    harness.step(players);
    const model = modelOf(harness);
    expect(model.phase).toBe("signal");
    const target = model.targetBit;
    const signalAt = model.signalAt;
    if (target === null || signalAt === null) throw new Error("no signal");

    harness.stepAt(signalAt + 10, [
      player(1, { buttons: 1 << target, edges: 1 << target, tick: signalAt + 5 }),
      player(2),
    ]);
    harness.step(players);
    expect(model.phase).toBe("matchResult");
    expect(model.matchWinnerSlot).toBe(1);

    const rematch: JsonValue = { source: "controller" };
    harness.game.onEvent?.(1, "rematch", rematch);
    expect(model.phase).toBe("countdown");
    expect(model.matchWinnerSlot).toBeNull();
    expect(harness.game.lastResult).toBeNull();
  });

  test("[A12][FR-7.12] a real button edge on the results screen starts a rematch", () => {
    const harness = createHarness({
      config: {
        countdownMs: 0,
        minDelayMs: 0,
        maxDelayMs: 0,
        roundResultMs: 0,
        roundsToWin: 1,
        noTapTimeoutMs: 1000,
      },
      seed: 29,
    });
    const players = slots(2);
    harness.step(players);
    harness.step(players);
    const model = modelOf(harness);
    expect(model.phase).toBe("signal");
    const target = model.targetBit;
    const signalAt = model.signalAt;
    if (target === null || signalAt === null) throw new Error("no signal");

    harness.stepAt(signalAt + 10, [
      player(1, { buttons: 1 << target, edges: 1 << target, tick: signalAt + 5 }),
      player(2),
    ]);
    harness.step(players); // round result window closes -> match result
    expect(model.phase).toBe("matchResult");
    expect(model.matchWinnerSlot).toBe(1);

    harness.game.render(0.5);
    expect(harness.fake.renderer.texts).toContain("Press any button to rematch");

    // A real four-button edge, not a named event, drives the rematch.
    const pressTick = harness.clock.now + 5;
    harness.step([
      player(1, { buttons: 1, edges: 1, tick: pressTick }),
      player(2),
    ]);
    expect(model.phase).toBe("countdown");
    expect(model.matchWinnerSlot).toBeNull();
    expect(harness.game.lastResult).toBeNull();
  });

  test("[FR-7.17] dispose is idempotent and stops all further work", () => {
    const harness = createHarness();
    harness.step(slots(2));
    harness.game.dispose();
    expect(harness.game.model).toBeNull();
    expect(() => harness.game.render(0.5)).not.toThrow();
    expect(() =>
      harness.game.simulate(1 / 60, { tick: 0, players: slots(2) }),
    ).not.toThrow();
    expect(() => harness.game.dispose()).not.toThrow();
  });
});

/**
 * Headless Beat Tap harness (GAME-BT-TEST-01..06; G2, E9, E11).
 *
 * Drives the real `createBeatTapGame` adapter with a controllable audio clock,
 * a recording layout seam, a recording music seam and a feature-detected 2D
 * surface. The audio clock advances by `dt` at the top of each tick, matching
 * the host loop; `audio.now()` is the only clock the game reads.
 *
 * Test-only code: allocations here are allowed.
 */
import type {
  GameContext,
  GameControllerState,
  GameLayouts,
  GameManifest,
  GameRenderer3D,
} from "../../../../sdk/src/index";
import { createFakeContext, createFakePlayer } from "../../../../sdk/src/testing";
import {
  createMemoryCalibrationStorage,
  type CalibrationStorage,
} from "../src/calibration.js";
import { createBeatTapGame, type BeatTapGame } from "../src/game.js";

/** Valid manifest for adapter tests; the shipped data is exercised separately. */
export const TEST_MANIFEST: GameManifest = {
  schemaVersion: 1,
  name: "Beat Tap Test",
  description: "Headless Beat Tap fixture.",
  entry: "index.js",
  layouts: [],
  assetBudget: { initialBytes: 4096, totalBytes: 65536 },
  minPlayers: 1,
  maxPlayers: 4,
  needsGyro: false,
};

export interface TestNote {
  readonly timeMs: number;
  readonly lane: number;
}

/** One-chart pack in the shipped schema. */
export function createTestPack(
  notes: readonly TestNote[],
  durationMs = 4000,
  audio = "test/silent",
): Record<string, unknown> {
  return {
    packVersion: 1,
    id: "bt-test-pack",
    type: "chart",
    license: "CC0-1.0",
    items: [
      {
        id: "bt-test-chart",
        title: "Test Chart",
        audio,
        bpm: 120,
        offsetMs: 0,
        durationMs,
        notes: notes.map((note) => ({ timeMs: note.timeMs, lane: note.lane })),
      },
    ],
  };
}

export interface TestSurface {
  readonly renderer: GameRenderer3D;
  readonly texts: string[];
}

/** The flat calls `drawBeatTap` feature-detects. */
interface FlatRenderer extends GameRenderer3D {
  clear(): void;
  rect(): void;
  circle(): void;
  text(value: string): void;
  readonly size: { readonly width: number; readonly height: number };
}

/** A recording Canvas2D-like surface, or a 3D-only renderer when `flat` is false. */
export function createTestSurface(flat = true): TestSurface {
  const texts: string[] = [];
  const base: GameRenderer3D = {
    backend: "canvas2d",
    beginFrame() {},
    endFrame() {},
    drawCalls: 0,
    textureMemoryMB: 0,
    setCamera() {},
    drawCube() {},
  };
  if (!flat) {
    return { renderer: base, texts };
  }
  const renderer: FlatRenderer = {
    ...base,
    clear() {},
    rect() {},
    circle() {},
    text(value) {
      texts.push(value);
    },
    size: { width: 1280, height: 720 },
  };
  return { renderer, texts };
}

export interface HarnessOptions {
  /** Chart pack passed to the factory; invalid packs are how init is tested. */
  readonly pack?: unknown;
  readonly manifest?: GameManifest;
  readonly countdownMs?: number;
  readonly storage?: CalibrationStorage;
  readonly flat?: boolean;
  readonly singlePlayerLayout?: "lanes" | "dpad";
  readonly reducedMotion?: boolean;
  readonly serverNow?: () => number | null;
}

export interface Harness {
  readonly game: BeatTapGame;
  readonly surface: TestSurface;
  readonly layouts: Array<{ slot: number; layoutId: string }>;
  readonly clearedLayouts: number[];
  readonly music: string[];
  readonly stopCount: { value: number };
  readonly counters: Map<string, number>;
  readonly audio: { ms: number };
  /**
   * One fixed tick. `edges` are that tick's press edges; `playerTick` is the
   * controller send timestamp on the server clock (0 means "not reported").
   */
  step(
    connected: readonly number[],
    edges?: Readonly<Record<number, number>>,
    dtSeconds?: number,
    playerTick?: number,
  ): void;
  stepUntil(
    predicate: () => boolean,
    connected: readonly number[],
    maxTicks?: number,
  ): void;
  /** Draws one frame into the recording surface. */
  render(alpha: number): void;
  /** Runs ticks until the press can land near `noteTimeMs`, then presses. */
  pressAtSongTime(
    noteTimeMs: number,
    connected: readonly number[],
    edges: Readonly<Record<number, number>>,
    playerTick?: number,
    maxTicks?: number,
  ): void;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const manifest = options.manifest ?? TEST_MANIFEST;
  const surface = createTestSurface(options.flat ?? true);
  const storage = options.storage ?? createMemoryCalibrationStorage();
  const layouts: Array<{ slot: number; layoutId: string }> = [];
  const clearedLayouts: number[] = [];
  const music: string[] = [];
  const stopCount = { value: 0 };
  const counters = new Map<string, number>();
  const audio = { ms: 0 };

  const layoutsApi: GameLayouts = {
    set(target, layout) {
      if (typeof target === "number" && typeof layout === "string") {
        layouts.push({ slot: target, layoutId: layout });
      }
    },
    clear(target) {
      if (typeof target === "number") {
        clearedLayouts.push(target);
      }
    },
  };

  const ctx: GameContext = {
    ...createFakeContext(),
    manifest,
    renderer: surface.renderer,
    audio: {
      playSfx() {},
      playMusic(id) {
        music.push(id);
      },
      stopMusic() {
        stopCount.value += 1;
      },
      now() {
        return audio.ms / 1000;
      },
      unlocked: true,
      latencyHint: "interactive",
    },
    debug: {
      enabled: false,
      setCounter(name, value) {
        counters.set(name, value);
      },
    },
    layouts: layoutsApi,
    serverNow: options.serverNow ?? (() => null),
  };

  const game = createBeatTapGame(manifest, {
    countdownMs: options.countdownMs ?? 0,
    calibrationStorage: storage,
    ...(options.pack === undefined ? {} : { chartPack: options.pack }),
    ...(options.singlePlayerLayout === undefined
      ? {}
      : { singlePlayerLayout: options.singlePlayerLayout }),
    ...(options.reducedMotion === undefined
      ? {}
      : { reducedMotion: options.reducedMotion }),
  });
  game.init(ctx);

  function step(
    connected: readonly number[],
    edges: Readonly<Record<number, number>> = {},
    dtSeconds = 1 / 60,
    playerTick = 0,
  ): void {
    audio.ms += dtSeconds * 1000;
    const players: GameControllerState[] = [];
    for (let index = 0; index < connected.length; index += 1) {
      const slot = connected[index];
      if (slot === undefined) {
        continue;
      }
      const edge = edges[slot] ?? 0;
      players.push(createFakePlayer(slot, { edges: edge, buttons: edge, tick: playerTick }));
    }
    game.simulate(dtSeconds, { tick: 0, players });
  }

  function stepUntil(
    predicate: () => boolean,
    connected: readonly number[],
    maxTicks = 1000,
  ): void {
    let ticks = 0;
    while (!predicate()) {
      if (ticks >= maxTicks) {
        throw new Error(
          `stepUntil did not settle within ${maxTicks} ticks (phase ${game.phase}).`,
        );
      }
      step(connected);
      ticks += 1;
    }
  }

  function render(alpha: number): void {
    game.render(alpha);
  }

  function pressAtSongTime(
    noteTimeMs: number,
    connected: readonly number[],
    edges: Readonly<Record<number, number>>,
    playerTick = 0,
    maxTicks = 600,
  ): void {
    let ticks = 0;
    while (game.songTimeMs < noteTimeMs - 30) {
      if (ticks >= maxTicks) {
        throw new Error(
          `song never reached ${noteTimeMs} ms (phase ${game.phase}, ` +
            `song ${game.songTimeMs} ms).`,
        );
      }
      step(connected, {}, 1 / 60, playerTick);
      ticks += 1;
    }
    step(connected, edges, 1 / 60, playerTick);
  }

  return {
    game,
    surface,
    layouts,
    clearedLayouts,
    music,
    stopCount,
    counters,
    audio,
    step,
    stepUntil,
    render,
    pressAtSongTime,
  };
}

/** Joins, then advances through an empty countdown into the playing phase. */
export function startSong(harness: Harness, connected: readonly number[]): void {
  harness.step(connected);
  harness.step(connected);
  if (harness.game.phase !== "playing") {
    throw new Error(
      `expected playing after the countdown, got ${harness.game.phase}`,
    );
  }
}

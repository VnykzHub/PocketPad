/**
 * Shared test harness for Tilt Maze Race.
 *
 * Records the flat render calls, layout/panel traffic and fake input so the
 * host-adapter tests can drive the real default-export factory. Fixture mazes
 * are synthetic; the only shipped maze is exercised by `maze.test.ts`.
 */
import { expect } from "vitest";
import type {
  GameContext,
  GameControllerState,
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
import createTiltMazeGame, {
  type TiltMazeGame,
  type TiltMazeGameOptions,
} from "../src/game.js";
import { parseMaze, type Maze } from "../src/maze.js";
import type { Renderer2DLike } from "../src/render.js";

export const TICK_SECONDS = 1 / 60;

export interface FlatRenderer extends GameRenderer3D, Renderer2DLike {}

export interface RenderStats {
  frames: number;
  rects: number;
  circles: number;
  texts: number;
}

export interface LayoutSet {
  readonly target: number | "all";
  readonly layout: LayoutDocument | string;
}

export interface PanelSet {
  readonly slot: number;
  readonly content: JsonValue;
}

export interface Recorder {
  readonly ctx: GameContext;
  readonly input: FakeInput;
  readonly texts: string[];
  readonly stats: RenderStats;
  readonly layoutSets: LayoutSet[];
  readonly layoutClears: Array<number | "all">;
  readonly panelSets: PanelSet[];
  readonly panelClears: number[];
  readonly panelTexts: Map<number, string>;
}

function panelTextOf(content: JsonValue): string | null {
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    return null;
  }
  const text = (content as Record<string, JsonValue>)["text"];
  return typeof text === "string" ? text : null;
}

export function createFlatRenderer(): {
  renderer: FlatRenderer;
  stats: RenderStats;
  texts: string[];
} {
  const stats: RenderStats = { frames: 0, rects: 0, circles: 0, texts: 0 };
  const texts: string[] = [];
  const renderer: FlatRenderer = {
    backend: "canvas2d",
    beginFrame() {
      stats.frames += 1;
    },
    endFrame() {},
    drawCalls: 0,
    textureMemoryMB: 0,
    setCamera() {},
    drawCube() {},
    clear() {},
    rect() {
      stats.rects += 1;
    },
    circle() {
      stats.circles += 1;
    },
    text(text: string) {
      stats.texts += 1;
      texts.push(text);
    },
  };
  return { renderer, stats, texts };
}

export function createRecorder(players: readonly GameControllerState[]): Recorder {
  const input = createFakeInput(players);
  const { renderer, stats, texts } = createFlatRenderer();
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
    stats,
    layoutSets,
    layoutClears,
    panelSets,
    panelClears,
    panelTexts,
  };
}

export function startGame(
  players: readonly GameControllerState[],
  options: TiltMazeGameOptions = {},
): { rec: Recorder; game: TiltMazeGame } {
  const rec = createRecorder(players);
  const game = createTiltMazeGame(rec.ctx.manifest, { countdownMs: 0, ...options });
  game.init(rec.ctx);
  return { rec, game };
}

export function tick(game: TiltMazeGame, input: FakeInput): void {
  game.simulate(TICK_SECONDS, input.poll());
}

export function advanceUntil(
  game: TiltMazeGame,
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

export function startPlaying(game: TiltMazeGame, input: FakeInput): void {
  tick(game, input);
  advanceUntil(game, input, () => game.phase === "playing", 10, "playing");
}

export function worldOf(game: TiltMazeGame) {
  const world = game.world;
  if (world === null) {
    throw new Error("game has no world");
  }
  return world;
}

export function playersTo(count: number): GameControllerState[] {
  const players: GameControllerState[] = [];
  for (let slot = 1; slot <= count; slot += 1) {
    players.push(createFakePlayer(slot));
  }
  return players;
}

/** Synthetic maze document shape accepted by `parseMaze`. */
export interface MazeFixture {
  width: number;
  height: number;
  walls: number[][];
  start: Array<{ x: number; y: number }>;
  exit: { x: number; y: number };
}

/** Two-lane fixture; the exit sits on slot 1's lane, clear of both walls. */
export function fixtureMaze(overrides: Partial<MazeFixture> = {}): MazeFixture {
  return {
    width: 480,
    height: 240,
    walls: [
      [0, 0, 480, 16],
      [0, 224, 480, 16],
      [0, 0, 16, 240],
      [464, 0, 16, 240],
    ],
    start: [
      { x: 60, y: 80 },
      { x: 60, y: 160 },
    ],
    exit: { x: 420, y: 80 },
    ...overrides,
  };
}

/** Eight independent starts; slot 1's lane holds the exit. */
export function eightPlayerMaze(): MazeFixture {
  const starts: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < 4; index += 1) {
    starts.push({ x: 60 + index * 80, y: 80 });
  }
  for (let index = 0; index < 4; index += 1) {
    starts.push({ x: 60 + index * 80, y: 180 });
  }
  return {
    width: 480,
    height: 320,
    walls: [
      [0, 0, 480, 16],
      [0, 304, 480, 16],
      [0, 0, 16, 320],
      [464, 0, 16, 320],
    ],
    start: starts,
    exit: { x: 420, y: 80 },
  };
}

/** Vertical fixture: forward tilt (positive `angleY`) must roll up-screen. */
export function verticalMaze(): MazeFixture {
  return {
    width: 400,
    height: 480,
    walls: [
      [0, 0, 400, 16],
      [0, 464, 400, 16],
      [0, 0, 16, 480],
      [384, 0, 16, 480],
    ],
    start: [
      { x: 120, y: 400 },
      { x: 280, y: 400 },
    ],
    exit: { x: 120, y: 80 },
  };
}

/** Parsed fixture for world tests. */
export function fixtureWorldMaze(overrides: Partial<MazeFixture> = {}): Maze {
  const validation = parseMaze(fixtureMaze(overrides));
  if (!validation.ok) {
    throw new Error(validation.errors.join("\n"));
  }
  return validation.maze;
}

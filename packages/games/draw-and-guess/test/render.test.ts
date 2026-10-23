/**
 * TV rendering acceptance (GAME-DG-HOST-03, GAME-DG-PERF-01, SR-13).
 *
 * The renderer is feature-detected: a flat Canvas2D-like surface gets
 * projected polylines, a 3D-only backend gets nothing. The secret word is
 * never drawn while a round is live, only on the results screen.
 */
import { describe, expect, test } from "vitest";
import type { GameRenderer3D, JsonValue } from "@lanpad/sdk";
import {
  drawDrawAndGuess,
  resolveRenderer2D,
  type DrawGuessRenderState,
} from "../src/render.js";
import { StrokeStore } from "../src/strokes.js";
import { createFlatRenderer } from "./harness.js";

function addStroke(
  store: StrokeStore,
  points: ReadonlyArray<{ x: number; y: number; t: number }>,
): void {
  const payload = {
    phase: "start",
    points: points.map((point) => ({ x: point.x, y: point.y, t: point.t })),
    color: "#ffffff",
    width: 6,
  } as unknown as JsonValue;
  expect(store.add(payload)).toBe(true);
}

function makeState(
  strokes: StrokeStore,
  overrides: Partial<DrawGuessRenderState> = {},
): DrawGuessRenderState {
  return {
    strokes,
    phase: "playing",
    roundNumber: 1,
    rounds: 3,
    drawerSlot: 2,
    countdownRemainingMs: 0,
    status: "P2 is drawing",
    turnLine: "Round 1 of 3 — P2 draws",
    word: "lighthouse",
    revealWord: false,
    scoreLines: [],
    resultsHeadline: "",
    ...overrides,
  };
}

describe("drawDrawAndGuess", () => {
  test("[GAME-DG-HOST-03] a 3D-only backend resolves to no flat surface", () => {
    expect(resolveRenderer2D(null)).toBeNull();
    expect(resolveRenderer2D(undefined)).toBeNull();
    const threeDOnly = {
      backend: "webgpu",
      beginFrame(): void {},
      endFrame(): void {},
      drawCalls: 0,
      textureMemoryMB: 0,
      setCamera(): void {},
      drawCube(): void {},
    } as GameRenderer3D;
    expect(resolveRenderer2D(threeDOnly)).toBeNull();
  });

  test("[GAME-DG-HOST-03][SR-13] strokes are projected and the word stays hidden while playing", () => {
    const strokes = new StrokeStore();
    addStroke(strokes, [{ x: 0.1, y: 0.2, t: 0 }]);
    const renderer = createFlatRenderer();

    drawDrawAndGuess(renderer, makeState(strokes), 0);

    expect(renderer.frameCount).toBe(1);
    expect(renderer.polylines).toHaveLength(1);
    const line = renderer.polylines[0];
    expect(line).toBeDefined();
    if (line === undefined) throw new Error("no polyline was drawn");
    expect(line.points).toHaveLength(1);
    const point = line.points[0];
    expect(point?.x).toBeCloseTo(24 + 8 + 0.1 * 1216, 5);
    expect(point?.y).toBeCloseTo(72 + 8 + 0.2 * 584, 5);
    expect(line.width).toBeCloseTo(6 * Math.min(6, 1216 / 360), 5);
    expect(line.color).toBe("#ffffff");

    expect(renderer.texts).toContain("DRAW AND GUESS");
    expect(renderer.texts).toContain("Round 1 of 3 — P2 draws");
    expect(renderer.texts.some((value) => value.includes("lighthouse"))).toBe(false);
  });

  test("[GAME-DG-HOST-03][GAME-DG-TEST-04] results reveal the word and ranked score lines", () => {
    const strokes = new StrokeStore();
    addStroke(strokes, [{ x: 0.4, y: 0.4, t: 0 }]);
    const renderer = createFlatRenderer();

    drawDrawAndGuess(
      renderer,
      makeState(strokes, {
        phase: "results",
        revealWord: true,
        resultsHeadline: "Round over",
        scoreLines: ["P1: 2", "P2: 1"],
        status: "P2 wins the match!",
      }),
      0,
    );

    expect(renderer.texts).toContain("Round over");
    expect(renderer.texts).toContain("lighthouse");
    expect(renderer.texts).toContain("P1: 2");
    expect(renderer.texts).toContain("P2: 1");
    expect(renderer.texts).toContain("P2 wins the match!");
    expect(renderer.polylines).toHaveLength(0);
  });

  test("[GAME-DG-PERF-01] a surface without polyline falls back to one dot per point", () => {
    const strokes = new StrokeStore();
    addStroke(strokes, [
      { x: 0.1, y: 0.1, t: 0 },
      { x: 0.5, y: 0.5, t: 10 },
      { x: 0.9, y: 0.9, t: 20 },
    ]);
    const renderer = createFlatRenderer({ withPolyline: false });

    drawDrawAndGuess(renderer, makeState(strokes), 0);

    expect(renderer.polylines).toHaveLength(0);
    expect(renderer.circles).toHaveLength(3);
    for (const circle of renderer.circles) expect(circle.radius).toBeGreaterThan(1);
  });

  test("[GAME-DG-PERF-01] projection is capped at 512 points even if the store is larger", () => {
    const strokes = new StrokeStore({ maxPointsPerStroke: 600, maxPoints: 600 });
    const points = Array.from({ length: 600 }, (_, index) => ({
      x: index / 599,
      y: 0.5,
      t: index,
    }));
    addStroke(strokes, points);
    expect(strokes.pointCount).toBe(600);
    const renderer = createFlatRenderer();

    drawDrawAndGuess(renderer, makeState(strokes), 0);

    expect(renderer.polylines[0]?.points).toHaveLength(512);
  });
});

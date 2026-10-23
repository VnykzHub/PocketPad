/**
 * Host ink ingestion (GAME-DG-HOST-03, GAME-DG-DATA-02, FR-7.8).
 *
 * The kit validates the wire payload; this store is the game's own boundary
 * after it. Points are clamped, colors and widths are bounded, and the caps
 * keep a hostile phone from growing host state during a round.
 */
import { describe, expect, test } from "vitest";
import type { JsonValue } from "@lanpad/sdk";
import { StrokeStore } from "../src/strokes.js";

interface PointInput {
  readonly x: number;
  readonly y: number;
  readonly t?: number;
}

function payload(
  phase: string,
  points: readonly PointInput[],
  overrides: Record<string, unknown> = {},
): JsonValue {
  return {
    phase,
    points: points.map((point) => ({ x: point.x, y: point.y, t: point.t ?? 0 })),
    color: "#ffffff",
    width: 6,
    ...overrides,
  } as unknown as JsonValue;
}

function linePoints(count: number): Array<{ x: number; y: number; t: number }> {
  const divisor = count > 1 ? count - 1 : 1;
  return Array.from({ length: count }, (_, index) => ({
    x: index / divisor,
    y: 0.5,
    t: index,
  }));
}

describe("StrokeStore", () => {
  test("[GAME-DG-HOST-03][FR-7.8] start/move/end are grouped into one ordered stroke", () => {
    const store = new StrokeStore();
    expect(
      store.add(payload("start", [{ x: 0.1, y: 0.1, t: 0 }], { color: "#ff0000" })),
    ).toBe(true);
    expect(
      store.add(payload("move", [{ x: 0.2, y: 0.2, t: 16 }], { color: "#00ff00" })),
    ).toBe(true);
    expect(store.add(payload("end", [{ x: 0.3, y: 0.3, t: 32 }]))).toBe(true);

    expect(store.count).toBe(1);
    expect(store.pointCount).toBe(3);
    expect(store.dropped).toBe(0);
    const stroke = store.all[0];
    expect(stroke?.points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.2, y: 0.2 },
      { x: 0.3, y: 0.3 },
    ]);
    // The stroke keeps the first batch's color rather than changing mid-line.
    expect(stroke?.color).toBe("#ff0000");
  });

  test("[GAME-DG-HOST-03] a new start opens a new stroke and a move without start still draws", () => {
    const store = new StrokeStore();
    store.add(payload("start", [{ x: 0.1, y: 0.1, t: 0 }]));
    store.add(payload("start", [{ x: 0.2, y: 0.2, t: 10 }]));
    expect(store.count).toBe(2);
    store.add(payload("move", [{ x: 0.3, y: 0.3, t: 20 }]));
    expect(store.count).toBe(2);
    expect(store.all[1]?.points).toHaveLength(2);

    const droppedStart = new StrokeStore();
    expect(droppedStart.add(payload("move", [{ x: 0.5, y: 0.5, t: 0 }]))).toBe(true);
    expect(droppedStart.count).toBe(1);
  });

  test("[GAME-DG-HOST-03][GAME-DG-DATA-02] points are clamped into 0..1 and non-finite points are dropped", () => {
    const store = new StrokeStore();
    store.add(
      payload("start", [
        { x: -2, y: 3, t: -5 },
        { x: 0.5, y: 0.5, t: 10 },
      ]),
    );
    expect(store.all[0]?.points).toEqual([
      { x: 0, y: 1 },
      { x: 0.5, y: 0.5 },
    ]);
    expect(store.dropped).toBe(0);

    store.add(payload("move", [{ x: 0.1, y: 0.1, t: Number.POSITIVE_INFINITY }]));
    expect(store.pointCount).toBe(2);
    expect(store.dropped).toBe(1);
  });

  test("[GAME-DG-HOST-03] ink width is clamped to the configured range", () => {
    const narrow = new StrokeStore();
    narrow.add(payload("start", [{ x: 0.5, y: 0.5, t: 0 }], { width: 0.01 }));
    expect(narrow.all[0]?.width).toBe(1);

    const wide = new StrokeStore();
    wide.add(payload("start", [{ x: 0.5, y: 0.5, t: 0 }], { width: 9999 }));
    expect(wide.all[0]?.width).toBe(24);
  });

  test("[GAME-DG-HOST-03] invalid phases, colors, sizes and point shapes are rejected", () => {
    const store = new StrokeStore();
    expect(store.add(null)).toBe(false);
    expect(store.add("not a stroke")).toBe(false);
    expect(store.add(payload("tap", [{ x: 0.1, y: 0.1 }]))).toBe(false);
    expect(store.add(payload("start", [{ x: 0.1, y: 0.1 }], { color: "red" }))).toBe(false);
    expect(store.add(payload("start", [{ x: 0.1, y: 0.1 }], { width: Number.NaN }))).toBe(false);
    expect(store.add(payload("start", []))).toBe(false);
    expect(
      store.add({
        phase: "start",
        points: [{ x: 0.1, y: 0.1 }],
        color: "#ffffff",
        width: 6,
      } as unknown as JsonValue),
    ).toBe(false);
    expect(store.count).toBe(0);
  });

  test("[GAME-DG-HOST-03][GAME-DG-DATA-02] per-stroke, total-point and stroke caps bound the store", () => {
    const perStroke = new StrokeStore({
      maxPointsPerStroke: 3,
      maxStrokes: 10,
      maxPoints: 100,
    });
    expect(perStroke.add(payload("start", linePoints(5)))).toBe(true);
    expect(perStroke.count).toBe(1);
    expect(perStroke.pointCount).toBe(3);
    expect(perStroke.dropped).toBe(2);
    // A new start still opens a fresh stroke after the cap.
    expect(perStroke.add(payload("start", linePoints(2)))).toBe(true);
    expect(perStroke.count).toBe(2);

    const totalPoints = new StrokeStore({
      maxPointsPerStroke: 10,
      maxStrokes: 10,
      maxPoints: 2,
    });
    expect(totalPoints.add(payload("start", linePoints(4)))).toBe(true);
    expect(totalPoints.pointCount).toBe(2);
    expect(totalPoints.dropped).toBe(2);

    const maxStrokes = new StrokeStore({
      maxPointsPerStroke: 10,
      maxStrokes: 1,
      maxPoints: 100,
    });
    expect(maxStrokes.add(payload("start", linePoints(1)))).toBe(true);
    expect(maxStrokes.add(payload("start", linePoints(1)))).toBe(false);
    expect(maxStrokes.count).toBe(1);
    expect(maxStrokes.dropped).toBe(1);
  });

  test("[GAME-DG-HOST-03] reset clears the board and the drop counter", () => {
    const store = new StrokeStore({ maxPointsPerStroke: 1, maxStrokes: 10, maxPoints: 10 });
    store.add(payload("start", linePoints(2)));
    expect(store.dropped).toBe(1);
    store.reset();
    expect(store.count).toBe(0);
    expect(store.pointCount).toBe(0);
    expect(store.dropped).toBe(0);
    expect(store.all).toHaveLength(0);
  });
});

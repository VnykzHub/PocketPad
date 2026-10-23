/**
 * Frame statistics acceptance tests (01 §7, ER-01-06).
 *
 * Percentiles use nearest rank: index `ceil(p * n) - 1` over the retained
 * window. The ring keeps the last `capacity` samples; the 10,000-sample case
 * sizes the ring so every sample is retained. Allocation is not asserted here:
 * heap growth is ER-01-07 on the benchmark page, not a Node unit test.
 */
import { expect, test } from "vitest";
import type { MutableFrameStats } from "../../src/contracts/time.js";
import {
  FrameStatsRing,
  LONG_FRAME_MS,
  OVER_BUDGET_FRAME_MS,
} from "../../src/time/index.js";

function createStatsOut(): MutableFrameStats {
  return {
    frameMs: 0,
    workMs: 0,
    simTicks: 0,
    alpha: 0,
    tick: 0,
    frames: 0,
    longFrames: 0,
    overBudgetFrames: 0,
    p50FrameMs: 0,
    p95FrameMs: 0,
    maxFrameMs: 0,
  };
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  const index = Math.ceil(percentile * sorted.length) - 1;
  const clamped = Math.min(sorted.length - 1, Math.max(0, index));
  return sorted[clamped] ?? 0;
}

test("[ER-01-06] p50, p95 and max match nearest rank for a known window", () => {
  const ring = new FrameStatsRing(8);
  for (let sample = 1; sample <= 10; sample += 1) {
    ring.record(sample, 0, 0, 0, sample);
  }

  const out = createStatsOut();
  const view = ring.snapshot(out);

  expect(view).toBe(out);
  expect(view.frames).toBe(10);
  expect(view.frameMs).toBe(10);

  // The last eight samples are 3..10.
  expect(view.p50FrameMs).toBe(6);
  expect(view.p95FrameMs).toBe(10);
  expect(view.maxFrameMs).toBe(10);
});

test("[ER-01-06] 10,000 deterministic samples match a reference sort within 1e-9", () => {
  const CAPACITY = 10_000;
  const ring = new FrameStatsRing(CAPACITY);
  const samples: number[] = [];

  let state = 0x12345678;
  const nextUnit = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };

  for (let sample = 0; sample < CAPACITY; sample += 1) {
    const frameMs = Math.round(nextUnit() * 50 * 1000) / 1000;
    samples.push(frameMs);
    ring.record(frameMs, nextUnit() * 5, 1, 0.5, sample);
  }

  const reference = [...samples].sort((left, right) => left - right);
  const out = createStatsOut();
  const view = ring.snapshot(out);

  expect(view.frames).toBe(CAPACITY);
  expect(
    Math.abs(view.p50FrameMs - nearestRank(reference, 0.5)),
  ).toBeLessThanOrEqual(1e-9);
  expect(
    Math.abs(view.p95FrameMs - nearestRank(reference, 0.95)),
  ).toBeLessThanOrEqual(1e-9);
  expect(Math.abs(view.maxFrameMs - nearestRank(reference, 1))).toBeLessThanOrEqual(
    1e-9,
  );

  expect(view.longFrames).toBe(
    samples.filter((sample) => sample > LONG_FRAME_MS).length,
  );
  expect(view.overBudgetFrames).toBe(
    samples.filter((sample) => sample > OVER_BUDGET_FRAME_MS).length,
  );
});

test("[ER-01-06] snapshot reuses the caller object and reset clears the window", () => {
  const ring = new FrameStatsRing(8);
  const out = createStatsOut();

  expect(ring.snapshot(out)).toBe(out);

  ring.record(LONG_FRAME_MS, 0, 0, 0, 0);
  ring.record(LONG_FRAME_MS + 0.01, 0, 0, 0, 0);
  ring.record(OVER_BUDGET_FRAME_MS + 0.01, 0, 0, 0, 0);

  const view = ring.snapshot(out);
  expect(view.longFrames).toBe(2);
  expect(view.overBudgetFrames).toBe(1);
  expect(ring.snapshot(out)).toBe(out);

  ring.reset();
  const cleared = ring.snapshot(out);
  expect(cleared.frames).toBe(0);
  expect(cleared.longFrames).toBe(0);
  expect(cleared.overBudgetFrames).toBe(0);
  expect(cleared.p50FrameMs).toBe(0);
  expect(cleared.p95FrameMs).toBe(0);
  expect(cleared.maxFrameMs).toBe(0);
});

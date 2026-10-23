/**
 * Fixed-loop acceptance tests (01 §7, ER-01-01..03).
 *
 * All timing is driven by `ManualScheduler`: no wall clock, no sleeps. The
 * harness copies `onFrameStats` views because the loop reuses one object.
 */
import { expect, test } from "vitest";
import type { FrameStatsView } from "../../src/contracts/time.js";
import { ManualScheduler } from "../../src/platform/index.js";
import { DT_SECONDS, EngineLoop, TICK_HZ } from "../../src/time/index.js";

interface Harness {
  readonly loop: EngineLoop;
  readonly scheduler: ManualScheduler;
  readonly ticks: number[];
  readonly renders: number[];
  readonly stats: FrameStatsView[];
  readonly pauseEvents: Array<{ paused: boolean; reasons: number }>;
}

function createHarness(): Harness {
  const scheduler = new ManualScheduler();
  const ticks: number[] = [];
  const renders: number[] = [];
  const stats: FrameStatsView[] = [];
  const pauseEvents: Array<{ paused: boolean; reasons: number }> = [];

  const loop = new EngineLoop({
    now: () => scheduler.nowMs,
    raf: (callback) => scheduler.request(callback),
    cancel: (id) => scheduler.cancel(id),
    onTick: (dt) => {
      ticks.push(dt);
    },
    onRender: (alpha) => {
      renders.push(alpha);
    },
    onFrameStats: (view) => {
      stats.push({ ...view });
    },
    onPauseChange: (paused, reasons) => {
      pauseEvents.push({ paused, reasons });
    },
  });

  return { loop, scheduler, ticks, renders, stats, pauseEvents };
}

function lastStats(harness: Harness): FrameStatsView {
  const view = harness.stats[harness.stats.length - 1];
  if (view === undefined) {
    throw new Error("the frame callback did not record statistics");
  }
  return view;
}

test("[ER-01-01] 30, 60, 120 and 144 Hz each run exactly 60 ticks in one wall-clock second", () => {
  for (const hz of [30, 60, 120, 144]) {
    const harness = createHarness();
    harness.loop.start();
    expect(harness.loop.dt).toBe(DT_SECONDS);

    let maximumSteps = 0;
    for (let frame = 0; frame < hz; frame += 1) {
      harness.scheduler.step(1000 / hz);
      const view = lastStats(harness);
      maximumSteps = Math.max(maximumSteps, view.simTicks);

      expect(view.alpha).toBeGreaterThanOrEqual(0);
      expect(view.alpha).toBeLessThan(1);
      expect(view.simTicks).toBeGreaterThanOrEqual(0);
      expect(view.simTicks).toBeLessThanOrEqual(5);
    }

    // 0.001 ms guards the last floating-point millisecond of the simulated
    // second; it cannot add a 61st tick (61 steps need 1016.7 ms).
    harness.scheduler.stepTo(1000.001);

    expect(harness.stats).toHaveLength(hz + 1);
    expect(harness.loop.tick).toBe(TICK_HZ);
    expect(harness.ticks).toHaveLength(TICK_HZ);
    expect(harness.ticks.every((dt) => dt === DT_SECONDS)).toBe(true);
    expect(maximumSteps).toBeLessThanOrEqual(5);

    harness.loop.stop();
    expect(harness.scheduler.pendingCount).toBe(0);
  }
});

test("[ER-01-02] a 2000 ms stall runs exactly 5 steps and leaves no backlog", () => {
  const harness = createHarness();
  harness.loop.start();

  harness.scheduler.step(2000);
  expect(harness.loop.tick).toBe(5);
  expect(lastStats(harness).simTicks).toBe(5);

  // The clamp discards the rest of the stall; the next frame is a normal one.
  harness.scheduler.step(1000 / 60 + 0.001);
  expect(harness.loop.tick).toBe(6);
  expect(lastStats(harness).simTicks).toBe(1);

  harness.scheduler.step(2000);
  expect(harness.loop.tick).toBe(11);
  expect(lastStats(harness).simTicks).toBe(5);

  harness.scheduler.step(2000);
  expect(harness.loop.tick).toBe(16);
  expect(lastStats(harness).simTicks).toBe(5);
});

test("[ER-01-03] 10 s paused runs no steps; resume plus 16.7 ms runs one; paused frames render alpha 0", () => {
  const harness = createHarness();
  harness.loop.start();

  harness.scheduler.stepTo(17);
  expect(harness.loop.tick).toBe(1);

  const rendersBeforePause = harness.renders.length;
  harness.loop.pause();
  expect(harness.loop.paused).toBe(true);
  expect(harness.renders).toHaveLength(rendersBeforePause + 1);
  expect(harness.renders[harness.renders.length - 1]).toBe(0);

  harness.scheduler.stepTo(10_017);
  expect(harness.loop.tick).toBe(1);
  expect(lastStats(harness).simTicks).toBe(0);
  expect(harness.renders[harness.renders.length - 1]).toBe(0);

  harness.loop.resume();
  expect(harness.loop.paused).toBe(false);

  harness.scheduler.stepTo(10_034);
  expect(harness.loop.tick).toBe(2);
  expect(lastStats(harness).simTicks).toBe(1);
});

test("[ER-01-03] stopped and disposed loops schedule nothing and cannot restart", () => {
  const harness = createHarness();
  harness.loop.start();
  harness.loop.start();
  expect(harness.scheduler.pendingCount).toBe(1);

  harness.scheduler.stepTo(17);
  expect(harness.loop.tick).toBe(1);

  harness.loop.stop();
  expect(harness.loop.running).toBe(false);
  expect(harness.scheduler.pendingCount).toBe(0);

  harness.scheduler.step(1000);
  expect(harness.loop.tick).toBe(1);

  const rendersAfterStop = harness.renders.length;
  harness.scheduler.step(1000);
  expect(harness.renders).toHaveLength(rendersAfterStop);

  harness.loop.start();
  expect(harness.scheduler.pendingCount).toBe(1);

  harness.loop.dispose();
  harness.loop.dispose();
  expect(harness.scheduler.pendingCount).toBe(0);
  expect(() => harness.loop.start()).toThrow(/dispose/);
});

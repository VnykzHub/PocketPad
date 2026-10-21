import { describe, expect, test } from "vitest";
import { InputMapper } from "../src/input/InputMapper.js";
import { FixedLoop } from "../src/loop/FixedLoop.js";
import type { LoopHooks } from "../src/loop/types.js";
import {
  DEFAULT_RESOLUTION_THRESHOLDS,
  ResolutionController,
  applyResolutionScale,
  type ResolutionChange,
} from "../src/profile/resolutionController.js";

/**
 * D3-RT-07: dynamic resolution (FR-9.5).
 *
 * Frames are fed explicitly; there is no wall clock in these tests. The
 * numbers come from `budgets.ts`, which mirrors `docs/BUDGETS.md`: 20 ms for
 * 30 consecutive frames drops 10%, under 12 ms for 120 consecutive frames
 * rises 5%, floor 60%, ceiling 100%.
 */

class RecordingRenderer {
  readonly calls: Array<{ cssWidth: number; cssHeight: number; dpr: number }> = [];

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.calls.push({ cssWidth, cssHeight, dpr });
  }
}

/** Feeds `frames` identical intervals; returns how many changes occurred. */
function feed(
  controller: ResolutionController,
  frames: number,
  frameMs: number,
): number {
  let changes = 0;
  for (let index = 0; index < frames; index += 1) {
    if (controller.sample(frameMs)) {
      changes += 1;
    }
  }
  return changes;
}

/**
 * Deterministic rAF scheduler for the loop integration test, same shape as
 * the one in `fixedLoop.test.ts`: one pending callback, injected clock.
 */
class FakeScheduler {
  nowMs = 0;
  private nextId = 1;
  private pending: { id: number; callback: (timeMs: number) => void } | null = null;

  readonly now = (): number => this.nowMs;

  readonly raf = (callback: (timeMs: number) => void): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.pending = { id, callback };
    return id;
  };

  readonly cancel = (): void => {
    this.pending = null;
  };

  step(ms: number): void {
    this.nowMs += ms;
    const pending = this.pending;
    if (pending === null) {
      throw new Error("FakeScheduler.step called with no pending frame");
    }
    this.pending = null;
    pending.callback(this.nowMs);
  }
}

describe("[FR-9.5] dynamic resolution", () => {
  test("[FR-9.5] 30 consecutive frames over 20 ms drop the render scale by 10%", () => {
    const controller = new ResolutionController();
    expect(controller.scale).toBe(1);
    expect(controller.percent).toBe(100);

    expect(feed(controller, 29, 25)).toBe(0);
    expect(controller.percent).toBe(100);
    expect(controller.slowStreakLength).toBe(29);

    expect(controller.sample(25)).toBe(true);
    expect(controller.percent).toBe(90);
    expect(controller.scale).toBeCloseTo(0.9, 10);
    expect(controller.dropCount).toBe(1);
    expect(controller.reason).toBe("slow-frames");
    expect(controller.slowStreakLength).toBe(0);
  });

  test("[FR-9.5] 20 ms and 12 ms boundaries are neutral (hysteresis)", () => {
    const exact = new ResolutionController();
    expect(feed(exact, 500, 20)).toBe(0);
    expect(exact.percent).toBe(100);
    expect(exact.slowStreakLength).toBe(0);

    const fastBoundary = new ResolutionController({ initialPercent: 90 });
    expect(feed(fastBoundary, 500, 12)).toBe(0);
    expect(fastBoundary.percent).toBe(90);
    expect(fastBoundary.fastStreakLength).toBe(0);

    const neutral = new ResolutionController({ initialPercent: 90 });
    expect(feed(neutral, 500, 15)).toBe(0);
    expect(neutral.percent).toBe(90);
  });

  test("[FR-9.5] recovery needs 120 consecutive frames under 12 ms and rises 5%", () => {
    const controller = new ResolutionController();
    feed(controller, 30, 25);
    expect(controller.percent).toBe(90);

    expect(feed(controller, 119, 8)).toBe(0);
    expect(controller.percent).toBe(90);
    expect(controller.fastStreakLength).toBe(119);

    expect(controller.sample(8)).toBe(true);
    expect(controller.percent).toBe(95);
    expect(controller.riseCount).toBe(1);
    expect(controller.reason).toBe("fast-frames");

    // One more window takes 95 -> 100 and stops at the ceiling.
    expect(feed(controller, 119, 8)).toBe(0);
    expect(controller.sample(8)).toBe(true);
    expect(controller.percent).toBe(100);
    expect(controller.riseCount).toBe(2);
    expect(feed(controller, 500, 8)).toBe(0);
    expect(controller.percent).toBe(100);
  });

  test("[FR-9.5] the scale never leaves the 60%-100% range", () => {
    const controller = new ResolutionController();
    feed(controller, 30 * 20, 25);
    expect(controller.percent).toBe(60);
    expect(controller.dropCount).toBe(4);
    expect(controller.changeCount).toBe(4);

    // Sustained slowness at the floor changes nothing and counts nothing.
    expect(feed(controller, 1000, 25)).toBe(0);
    expect(controller.percent).toBe(60);
    expect(controller.dropCount).toBe(4);

    // 8 rises of 5% take 60 -> 100 and stop.
    feed(controller, 120 * 10, 8);
    expect(controller.percent).toBe(100);
    expect(controller.riseCount).toBe(8);
    expect(feed(controller, 500, 8)).toBe(0);
    expect(controller.percent).toBe(100);
  });

  test("[FR-9.5] alternating 15/25 ms frames do not oscillate", () => {
    const controller = new ResolutionController();
    for (let index = 0; index < 4000; index += 1) {
      controller.sample(index % 2 === 0 ? 15 : 25);
    }
    expect(controller.changeCount).toBe(0);
    expect(controller.percent).toBe(100);
    expect(controller.state).toBe("active");
  });

  test("[FR-9.5] changes are single documented steps and are always reported", () => {
    const changes: ResolutionChange[] = [];
    const controller = new ResolutionController({
      onChange: (change) => changes.push(change),
    });

    feed(controller, 300, 25);

    expect(changes.map((change) => change.percent)).toEqual([90, 80, 70, 60]);
    expect(changes.map((change) => change.previousPercent)).toEqual([100, 90, 80, 70]);
    expect(changes.map((change) => change.sequence)).toEqual([1, 2, 3, 4]);
    expect(changes.map((change) => change.reason)).toEqual([
      "slow-frames",
      "slow-frames",
      "slow-frames",
      "slow-frames",
    ]);
    for (const change of changes) {
      expect(change.previousPercent - change.percent).toBe(10);
      expect(change.scale).toBeCloseTo(change.percent / 100, 10);
    }
    expect(controller.lastChange).toBe(changes[3]);
    expect(controller.changeCount).toBe(4);
  });

  test("[FR-9.5] the scale is applied to the backing store and CSS size is untouched", () => {
    const controller = new ResolutionController();
    feed(controller, 30, 25);
    const renderer = new RecordingRenderer();

    applyResolutionScale(renderer, 1280, 720, 1, controller.scale);
    applyResolutionScale(renderer, 1280, 720, 2, controller.scale);

    expect(renderer.calls).toHaveLength(2);
    expect(renderer.calls[0]).toEqual({ cssWidth: 1280, cssHeight: 720, dpr: 0.9 });
    expect(renderer.calls[1]?.cssWidth).toBe(1280);
    expect(renderer.calls[1]?.cssHeight).toBe(720);
    expect(renderer.calls[1]?.dpr).toBeCloseTo(1.8, 10);

    // Invalid values fall back to a safe full-resolution density rather than
    // handing NaN to the renderer.
    applyResolutionScale(renderer, 1280, 720, 1, Number.NaN);
    expect(renderer.calls[2]?.dpr).toBe(1);
  });

  test("[FR-9.5] invalid frame samples are ignored", () => {
    const controller = new ResolutionController();
    expect(controller.sample(Number.NaN)).toBe(false);
    expect(controller.sample(Number.POSITIVE_INFINITY)).toBe(false);
    expect(controller.sample(0)).toBe(false);
    expect(controller.sample(-16)).toBe(false);
    expect(controller.framesSampled).toBe(0);
    expect(controller.percent).toBe(100);
  });

  test("[FR-9.5] injectable thresholds produce a deterministic sequence", () => {
    const controller = new ResolutionController({
      thresholds: {
        slowFrameMs: 10,
        slowFrameCount: 2,
        dropStepPercent: 25,
        floorPercent: 50,
        fastFrameMs: 5,
        fastFrameCount: 2,
        riseStepPercent: 25,
        ceilingPercent: 100,
      },
    });

    expect(controller.sample(11)).toBe(false);
    expect(controller.sample(11)).toBe(true);
    expect(controller.percent).toBe(75);
    expect(controller.sample(11)).toBe(false);
    expect(controller.sample(11)).toBe(true);
    expect(controller.percent).toBe(50);
    expect(controller.sample(11)).toBe(false);
    expect(controller.percent).toBe(50);

    expect(controller.sample(4)).toBe(false);
    expect(controller.sample(4)).toBe(true);
    expect(controller.percent).toBe(75);
    expect(controller.thresholdsInUse.slowFrameCount).toBe(2);
    expect(DEFAULT_RESOLUTION_THRESHOLDS.slowFrameCount).toBe(30);
  });

  test("[FR-9.5] invalid threshold combinations are rejected", () => {
    expect(
      () =>
        new ResolutionController({
          thresholds: { fastFrameMs: 25, slowFrameMs: 20 },
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new ResolutionController({
          thresholds: { floorPercent: 80, ceilingPercent: 60 },
        }),
    ).toThrow(RangeError);
  });

  test("[FR-9.5] resolution changes do not affect the fixed simulation tick rate", () => {
    const scheduler = new FakeScheduler();
    const mapper = new InputMapper();
    const controller = new ResolutionController();
    let simTicks = 0;
    let frames = 0;

    const hooks: LoopHooks = {
      simulate: () => {
        simTicks += 1;
      },
      render: () => {},
      onFrameStats: (stats) => {
        frames += 1;
        controller.sample(stats.frameMs);
      },
    };
    const loop = new FixedLoop(hooks, {
      now: scheduler.now,
      raf: scheduler.raf,
      cancel: scheduler.cancel,
      mapper,
    });

    loop.start();
    // 50 ms frames are slow enough to trigger one 10% drop at frame 30 and
    // still run exactly 3 fixed ticks each (the loop's clamp is unchanged).
    for (let index = 0; index < 40; index += 1) {
      scheduler.step(50);
    }

    expect(frames).toBe(40);
    expect(controller.percent).toBe(90);
    expect(controller.dropCount).toBe(1);
    expect(simTicks).toBe(120);
    expect(loop.simTick).toBe(120);
    loop.stop();
  });
});

import { describe, expect, test } from "vitest";
import { InputMapper } from "../src/input/InputMapper.js";
import type { InputSnapshot } from "../src/input/types.js";
import { FixedLoop } from "../src/loop/FixedLoop.js";
import type { FrameStats, LoopHooks } from "../src/loop/types.js";

const DT = 1 / 60;

/**
 * Deterministic scheduler for the injected `now`/`raf`/`cancel` pair.
 *
 * The loop schedules exactly one frame at a time, so the fake keeps one
 * pending callback. `stepTo` sets the injected clock and fires it with the same
 * timestamp, exactly like a browser rAF callback.
 */
class FakeScheduler {
  nowMs = 0;
  readonly cancelled: number[] = [];
  private nextId = 1;
  private pending: { id: number; callback: (timeMs: number) => void } | null =
    null;

  readonly now = (): number => this.nowMs;

  readonly raf = (callback: (timeMs: number) => void): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.pending = { id, callback };
    return id;
  };

  readonly cancel = (id: number): void => {
    this.cancelled.push(id);
    if (this.pending !== null && this.pending.id === id) {
      this.pending = null;
    }
  };

  get hasPending(): boolean {
    return this.pending !== null;
  }

  /** Advance the simulated clock by `ms` and run the pending frame. */
  step(ms: number): void {
    this.stepTo(this.nowMs + ms);
  }

  /** Set the simulated clock to `timeMs` and run the pending frame. */
  stepTo(timeMs: number): void {
    this.nowMs = timeMs;
    const pending = this.pending;
    if (pending === null) {
      throw new Error("FakeScheduler.step called with no pending frame");
    }
    this.pending = null;
    pending.callback(timeMs);
  }
}

/** InputMapper subclass that counts polls without changing its behavior. */
class CountingMapper extends InputMapper {
  pollCount = 0;
  readonly hostTicks: number[] = [];

  override pollAll(hostTick: number): InputSnapshot {
    this.pollCount += 1;
    this.hostTicks.push(hostTick);
    return super.pollAll(hostTick);
  }
}

/** Records every hook invocation and keeps object identities for PR-9.3. */
class LoopRecorder implements LoopHooks {
  simulateCalls = 0;
  readonly dtValues: number[] = [];
  readonly snapshots: InputSnapshot[] = [];
  readonly alphas: number[] = [];
  /** Object identities; the loop reuses one stats object every frame. */
  readonly stats: FrameStats[] = [];
  /** Primitive copies, because every `stats` entry aliases the same object. */
  readonly statsAlphas: number[] = [];
  readonly statsFrameMs: number[] = [];
  readonly ticksPerFrame: number[] = [];

  simulate(dt: number, snapshot: InputSnapshot): void {
    this.simulateCalls += 1;
    this.dtValues.push(dt);
    this.snapshots.push(snapshot);
  }

  render(alpha: number): void {
    this.alphas.push(alpha);
  }

  onFrameStats(stats: FrameStats): void {
    this.stats.push(stats);
    this.statsAlphas.push(stats.alpha);
    this.statsFrameMs.push(stats.frameMs);
    this.ticksPerFrame.push(stats.simTicks);
  }
}

interface Harness {
  scheduler: FakeScheduler;
  recorder: LoopRecorder;
  mapper: CountingMapper;
  loop: FixedLoop;
}

function createHarness(): Harness {
  const scheduler = new FakeScheduler();
  const recorder = new LoopRecorder();
  const mapper = new CountingMapper();
  const loop = new FixedLoop(recorder, {
    now: scheduler.now,
    raf: scheduler.raf,
    cancel: scheduler.cancel,
    mapper,
  });
  return { scheduler, recorder, mapper, loop };
}

describe("FixedLoop (D3-RT-01)", () => {
  test("[FR-9.1] fixed timestep runs at 60 Hz with variable render (30/60/120/144 Hz)", () => {
    for (const rate of [30, 60, 120, 144]) {
      const { scheduler, recorder, mapper, loop } = createHarness();
      loop.start();

      const frameIntervalMs = 1000 / rate;
      for (let frame = 1; frame <= rate; frame += 1) {
        scheduler.stepTo(frame * frameIntervalMs);
      }

      expect(loop.tickHz).toBe(60);
      expect(loop.dt).toBeCloseTo(DT, 15);
      // One second of rendering at any refresh rate is 60 sim ticks.
      expect(loop.simTick).toBe(60);
      expect(recorder.simulateCalls).toBe(60);
      expect(mapper.pollCount).toBe(60);
      expect(recorder.alphas).toHaveLength(rate);
      expect(recorder.stats).toHaveLength(rate);

      for (let frame = 0; frame < rate; frame += 1) {
        const alpha = recorder.alphas[frame] ?? -1;
        expect(alpha).toBeGreaterThanOrEqual(0);
        expect(alpha).toBeLessThan(1);
        expect(recorder.statsAlphas[frame]).toBe(alpha);
        expect(recorder.statsFrameMs[frame]).toBeCloseTo(frameIntervalMs, 9);
        expect(recorder.stats[frame]?.simTicks).toBeLessThanOrEqual(5);
      }

      // Ticks are independent of the render cadence: the sum is 60, and a
      // fast display renders frames that execute zero simulation steps.
      const totalTicks = recorder.ticksPerFrame.reduce(
        (sum, count) => sum + count,
        0,
      );
      expect(totalTicks).toBe(60);
      if (rate === 144) {
        expect(recorder.ticksPerFrame.some((count) => count === 0)).toBe(true);
      }
    }
  });

  test("[FR-9.1] one 16.7 ms rAF at 60 Hz runs exactly one sim tick", () => {
    const { scheduler, recorder, loop } = createHarness();
    loop.start();

    scheduler.step(16.7);

    expect(loop.simTick).toBe(1);
    expect(recorder.simulateCalls).toBe(1);
    expect(recorder.dtValues[0]).toBe(DT);
    expect(recorder.alphas).toHaveLength(1);
    expect(recorder.alphas[0]).toBeCloseTo(0.002, 9);
  });

  test("[FR-9.1] a stalled frame is clamped to five catch-up steps", () => {
    const { scheduler, recorder, loop } = createHarness();
    loop.start();

    scheduler.step(2000);

    expect(loop.simTick).toBe(5);
    expect(recorder.simulateCalls).toBe(5);
    expect(recorder.alphas).toHaveLength(1);
    const stalledAlpha = recorder.alphas[0] ?? -1;
    expect(stalledAlpha).toBeGreaterThanOrEqual(0);
    expect(stalledAlpha).toBeLessThan(1);

    // No backlog survives the clamp: the next normal frame runs one step.
    scheduler.step(16.7);
    expect(loop.simTick).toBe(6);

    // Repeated stalls cannot grow the accumulator: 2 more stalls add 10.
    scheduler.step(2000);
    scheduler.step(2000);
    expect(loop.simTick).toBe(16);

    // A 50 ms frame runs three steps, which is under the clamp.
    const other = createHarness();
    other.loop.start();
    other.scheduler.step(50);
    expect(other.loop.simTick).toBe(3);
  });

  test("[FR-9.1] interpolation alpha stays in [0,1) and tracks the accumulator", () => {
    const { scheduler, recorder, loop } = createHarness();
    loop.start();

    scheduler.step(1000 / 120);
    expect(recorder.alphas[0]).toBeCloseTo(0.5, 9);
    expect(recorder.alphas[0]).toBeLessThan(1);

    scheduler.step(1000 / 120);
    expect(loop.simTick).toBe(1);
    expect(recorder.alphas[1]).toBeCloseTo(0, 9);

    // Deliberately uneven frame times, including stall-sized deltas.
    for (const frameMs of [0.1, 3.3, 16.7, 50, 2000, 8.35, 33.4]) {
      scheduler.step(frameMs);
      const alpha = recorder.alphas[recorder.alphas.length - 1] ?? -1;
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThan(1);
    }

    for (const alpha of recorder.statsAlphas) {
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThan(1);
    }
    for (const count of recorder.ticksPerFrame) {
      expect(count).toBeGreaterThanOrEqual(0);
      expect(count).toBeLessThanOrEqual(5);
    }
  });

  test("[FR-7.12] mapper poll happens once per sim tick, never per render", () => {
    const { scheduler, recorder, mapper, loop } = createHarness();
    loop.start();

    // 30 Hz renders twice per fixed step: 30 frames, 60 ticks, 30 renders.
    for (let frame = 1; frame <= 30; frame += 1) {
      scheduler.stepTo(frame * (1000 / 30));
    }

    expect(loop.simTick).toBe(60);
    expect(recorder.simulateCalls).toBe(60);
    expect(mapper.pollCount).toBe(60);
    expect(recorder.alphas).toHaveLength(30);
    expect(mapper.hostTicks).toHaveLength(60);
    expect(mapper.hostTicks[0]).toBe(0);
    expect(mapper.hostTicks[59]).toBe(59);

    // Frames shorter than DT render without polling at all.
    const idle = createHarness();
    idle.loop.start();
    for (let frame = 1; frame <= 3; frame += 1) {
      idle.scheduler.stepTo(frame * 5);
    }
    expect(idle.loop.simTick).toBe(0);
    expect(idle.mapper.pollCount).toBe(0);
    expect(idle.recorder.alphas).toHaveLength(3);
  });

  test("[PR-9.3] loop performs no per-frame allocations", () => {
    const { scheduler, recorder, loop } = createHarness();
    loop.start();

    for (let frame = 1; frame <= 240; frame += 1) {
      scheduler.stepTo(frame * (1000 / 144));
    }
    loop.pause();
    for (let frame = 0; frame < 10; frame += 1) {
      scheduler.step(1000 / 144);
    }

    // The mapper returns its pooled snapshot, and every simulate call sees it.
    expect(recorder.snapshots).toHaveLength(loop.simTick);
    expect(recorder.snapshots.length).toBeGreaterThan(0);
    expect(new Set(recorder.snapshots).size).toBe(1);

    // The loop reuses one stats object for every frame, paused frames included.
    expect(recorder.stats).toHaveLength(240 + 10);
    expect(new Set(recorder.stats).size).toBe(1);
    expect(recorder.stats[0]).toBe(recorder.stats[recorder.stats.length - 1]);
  });

  test("[FR-9.2] paused loop stops simulation", () => {
    const { scheduler, recorder, loop } = createHarness();
    loop.start();

    scheduler.step(16.7);
    expect(loop.simTick).toBe(1);

    loop.pause();
    // pause() renders the paused screen immediately with alpha 0.
    expect(recorder.alphas).toHaveLength(2);
    expect(recorder.alphas[1]).toBe(0);
    expect(scheduler.hasPending).toBe(true);

    const rendersBeforePausedFrames = recorder.alphas.length;
    for (let frame = 0; frame < 120; frame += 1) {
      scheduler.step(1000 / 120);
    }

    expect(loop.simTick).toBe(1);
    expect(recorder.alphas).toHaveLength(rendersBeforePausedFrames + 120);
    expect(
      recorder.alphas
        .slice(rendersBeforePausedFrames)
        .every((alpha) => alpha === 0),
    ).toBe(true);
    expect(recorder.ticksPerFrame.slice(-120).every((count) => count === 0)).toBe(
      true,
    );
    expect(scheduler.hasPending).toBe(true);

    loop.resume();
    scheduler.step(16.7);
    expect(loop.simTick).toBe(2);
  });

  test("[FR-9.2] hidden document (host pause) does not advance simulation", () => {
    const { scheduler, recorder, loop } = createHarness();
    loop.start();
    scheduler.step(16.7);

    // The host page calls pause() from visibilitychange; the loop reads no DOM.
    loop.pause();
    const tickAtHide = loop.simTick;
    for (let frame = 0; frame < 120; frame += 1) {
      // Hidden-tab rAF timestamps may jump; the loop stays paused regardless.
      scheduler.step(frame % 10 === 9 ? 2000 : 1000 / 60);
    }

    expect(loop.simTick).toBe(tickAtHide);
    expect(scheduler.hasPending).toBe(true);
    const pausedAlphas = recorder.alphas.slice(2);
    expect(pausedAlphas).toHaveLength(120);
    expect(pausedAlphas.every((alpha) => alpha === 0)).toBe(true);
  });

  test("[FR-9.1] pause and resume do not simulate wall-clock gap", () => {
    const { scheduler, recorder, loop } = createHarness();
    loop.start();
    scheduler.step(16.7);
    expect(loop.simTick).toBe(1);

    loop.pause();
    scheduler.step(2000);
    loop.resume();
    scheduler.step(16.7);

    // If the paused 2 s had been simulated, the clamp would allow 5 steps.
    expect(loop.simTick).toBe(2);
    expect(recorder.simulateCalls).toBe(2);
  });

  test("[FR-9.1] stop cancels the scheduled frame and start resumes scheduling", () => {
    const { scheduler, loop } = createHarness();
    loop.start();
    expect(scheduler.hasPending).toBe(true);

    loop.stop();
    expect(scheduler.hasPending).toBe(false);
    expect(scheduler.cancelled).toHaveLength(1);

    loop.start();
    scheduler.step(16.7);
    expect(loop.simTick).toBe(1);
  });
});

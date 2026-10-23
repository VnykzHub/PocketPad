/**
 * Audio clock — ER-09-06 (unit half).
 *
 * The clock is `AudioContext.currentTime`, exactly 0 while locked, monotonic
 * within a session, and never driven by `performance.now()`. The
 * performance bridge exists only for diagnostics.
 *
 * The offline-render half of ER-09-06 ("a click at now + 0.25 lands on sample
 * 12,000 of a 48 kHz render") needs an `OfflineAudioContext`; it stays PENDING
 * and is not claimed here.
 */

import { describe, expect, test } from "vitest";
import { EngineAudioClock } from "../src/clock/AudioClock.js";
import type { HostAudioContext } from "../src/host/types.js";
import { EngineAudioSystem } from "../src/AudioSystem.js";
import { createFakeFactory } from "./support/fakeAudio.js";

interface FauxContext {
  currentTime: number;
  state: "suspended" | "running" | "closed" | "interrupted";
  baseLatency?: number;
  outputLatency?: number;
}

function host(context: FauxContext | null): {
  context: () => HostAudioContext | null;
  unlocked: () => boolean;
} {
  return {
    context: () => context as unknown as HostAudioContext | null,
    unlocked: () => context !== null,
  };
}

describe("audio clock", () => {
  test("[ER-09-06] now is 0 before a context exists", () => {
    const clock = new EngineAudioClock(host(null));
    expect(clock.now).toBe(0);
    expect(clock.running).toBe(false);
  });

  test("[ER-09-06] now follows currentTime and never goes backwards", () => {
    const context: FauxContext = { currentTime: 10, state: "running" };
    const clock = new EngineAudioClock(host(context));
    expect(clock.now).toBe(10);
    context.currentTime = 10.5;
    expect(clock.now).toBe(10.5);
    context.currentTime = 9;
    expect(clock.now).toBe(10.5);
    context.currentTime = 11;
    expect(clock.now).toBe(11);
  });

  test("[ER-09-06] running is false while the context is suspended", () => {
    const context: FauxContext = { currentTime: 3, state: "running" };
    const clock = new EngineAudioClock(host(context));
    expect(clock.running).toBe(true);
    context.state = "suspended";
    expect(clock.running).toBe(false);
  });

  test("[ER-09-06] latency reads baseLatency, then outputLatency, then 0", () => {
    const both: FauxContext = {
      currentTime: 1,
      state: "running",
      baseLatency: 0.011,
      outputLatency: 0.022,
    };
    const full = new EngineAudioClock(host(both));
    expect(full.baseLatency).toBe(0.011);
    expect(full.outputLatency).toBe(0.022);

    const baseOnly: FauxContext = {
      currentTime: 1,
      state: "running",
      baseLatency: 0.011,
    };
    const fallback = new EngineAudioClock(host(baseOnly));
    expect(fallback.outputLatency).toBe(0.011);

    const none: FauxContext = { currentTime: 1, state: "running" };
    const empty = new EngineAudioClock(host(none));
    expect(empty.baseLatency).toBe(0);
    expect(empty.outputLatency).toBe(0);
  });

  test("[ER-09-06] the performance bridge clamps into [0, now]", () => {
    const context: FauxContext = { currentTime: 10, state: "running" };
    let perf = 1000;
    const clock = new EngineAudioClock(host(context), () => perf);

    expect(clock.performanceToAudio(900)).toBeCloseTo(9.9, 6);
    expect(clock.performanceToAudio(2000)).toBe(10);
    perf = 1000;
    expect(clock.audioToPerformance(5)).toBe(-4000);
    expect(clock.audioToPerformance(20)).toBe(1000);
  });

  test("[ER-09-06] the system clock advances only while unlocked", async () => {
    const fake = createFakeFactory({ currentTime: 12.5 });
    const system = new EngineAudioSystem({ createContext: fake.factory });
    expect(system.clock.now).toBe(0);

    await system.unlock();
    expect(system.clock.now).toBe(12.5);
    expect(system.clock.running).toBe(true);

    const context = fake.last();
    expect(context).toBeDefined();
    if (context === undefined) return;
    context.advance(0.25);
    expect(system.clock.now).toBe(12.75);

    await system.suspend();
    expect(system.clock.running).toBe(false);
    await system.resume();
    expect(system.clock.running).toBe(true);
    expect(system.clock.now).toBe(12.75);
    system.dispose();
  });
});

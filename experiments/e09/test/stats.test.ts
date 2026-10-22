import { describe, expect, it } from "vitest";
import {
  classifyG1,
  e4Passes,
  estimateOffset,
  meanAbsoluteDelta,
  percentile,
  sampleOffset,
  summarizeFairness,
  summarizeG1,
  summarizeLifecycle,
  summarizeRtt,
  unwrapU32,
  type ClockSample,
  type LifecycleEvent,
  type RecoveryAttempt,
} from "../stats.js";

describe("[E4] RTT statistics", () => {
  it("[E4] percentile interpolates linearly (type 7) and handles edges", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBeCloseTo(9.55, 10);
    expect(percentile([1, 2], 0)).toBe(1);
    expect(percentile([1, 2], 100)).toBe(2);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });

  it("[E4] jitter is the mean absolute delta between consecutive samples", () => {
    expect(meanAbsoluteDelta([5])).toBeNull();
    expect(meanAbsoluteDelta([1, 3, 2, 6])).toBeCloseTo((2 + 1 + 4) / 3, 10);
  });

  it("[E4] summarises p50/p95/jitter/loss and applies the 8 ms p95 rule", () => {
    const rtt = [2, 3, 2, 4, 3, 2, 3, 2, 3, 10];
    const summary = summarizeRtt([{ sent: 12, rttMs: rtt }]);
    expect(summary.sent).toBe(12);
    expect(summary.received).toBe(10);
    expect(summary.lost).toBe(2);
    expect(summary.lossPct).toBeCloseTo(16.667, 3);
    expect(summary.p50Ms).toBe(3);
    // sorted [2,2,2,2,3,3,3,3,4,10]: rank 8.55 -> 4 + 0.55 * 6
    expect(summary.p95Ms).toBeCloseTo(7.3, 3);
    expect(summary.minMs).toBe(2);
    expect(summary.maxMs).toBe(10);
    expect(summary.jitterMs).toBeCloseTo(16 / 9, 3);
    // Loss alone fails E4 even when p95 is under 8 ms.
    expect(e4Passes(summary)).toBe(false);
    expect(e4Passes(summarizeRtt([{ sent: 10, rttMs: rtt }]))).toBe(true);
    expect(e4Passes(summarizeRtt([{ sent: 3, rttMs: [9, 9, 9] }]))).toBe(false);
  });

  it("[E4] rejects more Pongs than Pings and reports nulls for an empty run", () => {
    expect(() => summarizeRtt([{ sent: 1, rttMs: [1, 2] }])).toThrow(RangeError);
    const empty = summarizeRtt([{ sent: 5, rttMs: [] }]);
    expect(empty.p95Ms).toBeNull();
    expect(empty.lossPct).toBe(100);
    expect(e4Passes(empty)).toBe(false);
  });
});

describe("[G4] eight parallel sockets and reservation", () => {
  it("[G4] pools percentiles but computes jitter only within each socket", () => {
    const series = Array.from({ length: 8 }, (_, index) => ({
      sent: 4,
      rttMs: index === 7 ? [10, 10] : [index + 1, index + 1, index + 1, index + 1],
    }));
    const summary = summarizeRtt(series);
    expect(summary.sockets).toBe(8);
    expect(summary.sent).toBe(32);
    expect(summary.received).toBe(30);
    expect(summary.perSocketLost).toEqual([0, 0, 0, 0, 0, 0, 0, 2]);
    // Each socket is perfectly steady, so cross-socket differences must not
    // leak into jitter.
    expect(summary.jitterMs).toBe(0);
    expect(summary.maxMs).toBe(10);
  });

  it("[G4] E15 recovery only passes inside the 30 s reservation", () => {
    const events: LifecycleEvent[] = [
      { type: "hidden", atMs: 1000 },
      { type: "visible", atMs: 32_000 },
    ];
    const recoveries: RecoveryAttempt[] = [
      { startedAtMs: 32_000, joinedAtMs: 32_100, path: "new-socket", expectedSlot: 3, slot: 3, error: null },
    ];
    const summary = summarizeLifecycle(events, recoveries);
    expect(summary.episodes[0]?.recoveryMs).toBe(100);
    expect(summary.episodes[0]?.passes).toBe(false);
    expect(summary.passes).toBe(false);
  });
});

describe("[E9] clock offset estimation", () => {
  it("[E9] unwraps u32 server time to the value nearest the reference", () => {
    const reference = 1_760_000_000_123.4;
    const u32 = Math.floor(reference) % 2 ** 32;
    expect(unwrapU32(u32, reference)).toBe(Math.floor(reference));
    expect(unwrapU32((u32 + 5) % 2 ** 32, reference)).toBe(Math.floor(reference) + 5);
    // Across the wrap in both directions.
    expect(unwrapU32(2 ** 32 - 2, 2 ** 33 + 3)).toBe(2 ** 33 - 2);
    expect(unwrapU32(5, 2 ** 33 - 2)).toBe(2 ** 33 + 5);
    expect(() => unwrapU32(-1, 0)).toThrow(RangeError);
    expect(() => unwrapU32(1.5, 0)).toThrow(RangeError);
  });

  it("[E9] one symmetric exchange recovers the offset including the 0.5 ms floor correction", () => {
    const sample: ClockSample = { sentClientMs: 0, receivedClientMs: 7.4, serverMs: 1004 };
    expect(sampleOffset(sample)).toBeCloseTo(1004.5 - 3.7, 10);
  });

  it("[E9] the estimate uses the fastest quarter and stays inside half the best RTT", () => {
    const trueOffset = 250;
    // Return-path-only delay biases the slow samples' offsets low by ~9.5 ms.
    const make = (sent: number, out: number, back: number): ClockSample => ({
      sentClientMs: sent,
      receivedClientMs: sent + out + back,
      serverMs: Math.floor(sent + out + trueOffset),
      truthOffsetMs: trueOffset,
    });
    const samples = [make(0, 1, 1), make(100, 1.2, 1.2)];
    for (let index = 0; index < 6; index += 1) samples.push(make(200 + index * 100, 1, 20));
    const estimate = estimateOffset(samples);
    expect(estimate.samples).toBe(8);
    expect(estimate.minRttMs).toBe(2);
    expect(estimate.errorBoundMs).toBe(1);
    expect(estimate.offsetMs).toBeCloseTo(250.4, 3);
    expect(Math.abs(estimate.offsetMs - trueOffset)).toBeLessThanOrEqual(estimate.errorBoundMs);
    expect(estimate.errorVsTruthMs).toBeCloseTo(0.4, 3);
    expect(estimate.offsetStdDevMs).toBeGreaterThan(1);
    expect(() => estimateOffset([])).toThrow(RangeError);
  });

  it("[E9] truth error is null unless every sample carries truth", () => {
    const estimate = estimateOffset([
      { sentClientMs: 0, receivedClientMs: 2, serverMs: 10, truthOffsetMs: 9.5 },
      { sentClientMs: 5, receivedClientMs: 7, serverMs: 15 },
    ]);
    expect(estimate.errorVsTruthMs).toBeNull();
  });

  it("[E9] fairness compares the two players' offsets and applies the 5 ms rule", () => {
    const estimate = (offsetMs: number, errorVsTruthMs: number | null = null) => ({
      samples: 16,
      offsetMs,
      minRttMs: 2,
      errorBoundMs: 1,
      offsetStdDevMs: 0.2,
      errorVsTruthMs,
    });
    const good = summarizeFairness([
      { a: estimate(100), b: estimate(100.5) },
      { a: estimate(100), b: estimate(101) },
      { a: estimate(100.2), b: estimate(100) },
    ]);
    expect(good.rounds).toBe(3);
    expect(good.pairErrorMaxMs).toBe(1);
    expect(good.pairErrorP50Ms).toBe(0.5);
    expect(good.absErrorVsTruthP95Ms).toBeNull();
    expect(good.worstErrorBoundMs).toBe(1);
    expect(good.passes).toBe(true);

    expect(summarizeFairness([{ a: estimate(100), b: estimate(106) }]).passes).toBe(false);

    // Pairwise agreement is not enough when ground truth shows a shared bias.
    const biased = summarizeFairness([{ a: estimate(100, 6), b: estimate(100, 6) }]);
    expect(biased.pairErrorP95Ms).toBe(0);
    expect(biased.absErrorVsTruthP95Ms).toBe(6);
    expect(biased.passes).toBe(false);

    expect(summarizeFairness([]).passes).toBe(false);
  });
});

describe("[E15] lifecycle episodes", () => {
  it("[E15] pairs hidden->visible with the next rejoin and measures recovery from visible", () => {
    const events: LifecycleEvent[] = [
      { type: "hidden", atMs: 1000 },
      { type: "freeze", atMs: 1100 },
      { type: "resume", atMs: 4900 },
      { type: "visible", atMs: 5000 },
      { type: "hidden", atMs: 9000 },
      { type: "pagehide", atMs: 9001, persisted: true },
      { type: "pageshow", atMs: 12_000, persisted: true },
      { type: "visible", atMs: 12_001 },
    ];
    const recoveries: RecoveryAttempt[] = [
      { startedAtMs: 5000, joinedAtMs: 5040, path: "same-socket", expectedSlot: 1, slot: 1, error: null },
      { startedAtMs: 12_001, joinedAtMs: 13_500, path: "new-socket", expectedSlot: 1, slot: 1, error: null },
    ];
    const summary = summarizeLifecycle(events, recoveries);
    expect(summary.events).toBe(8);
    expect(summary.episodes).toHaveLength(2);
    expect(summary.episodes[0]).toMatchObject({
      hiddenMs: 4000,
      recoveryMs: 40,
      path: "same-socket",
      sameSlot: true,
      pageHidden: false,
      passes: true,
    });
    // The bfcache episode took 1.499 s: over the 1 s limit.
    expect(summary.episodes[1]).toMatchObject({ pageHidden: true, recoveryMs: 1499, passes: false });
    expect(summary.recoveryMaxMs).toBe(1499);
    expect(summary.passes).toBe(false);
  });

  it("[E15] a different slot or a failed or missing rejoin fails the episode", () => {
    const events: LifecycleEvent[] = [
      { type: "hidden", atMs: 0 },
      { type: "visible", atMs: 100 },
      { type: "hidden", atMs: 200 },
      { type: "visible", atMs: 300 },
      { type: "hidden", atMs: 400 },
      { type: "visible", atMs: 500 },
    ];
    const recoveries: RecoveryAttempt[] = [
      { startedAtMs: 100, joinedAtMs: 150, path: "new-socket", expectedSlot: 2, slot: 4, error: null },
      { startedAtMs: 300, joinedAtMs: null, path: "new-socket", expectedSlot: 2, slot: null, error: "joined rejected: expired" },
    ];
    const summary = summarizeLifecycle(events, recoveries);
    expect(summary.episodes.map((episode) => episode.passes)).toEqual([false, false, false]);
    expect(summary.episodes[0]?.sameSlot).toBe(false);
    expect(summary.episodes[1]?.error).toBe("joined rejected: expired");
    expect(summary.episodes[2]?.error).toBe("no rejoin attempt recorded");
    expect(summary.recoveryP50Ms).toBe(50);
  });

  it("[E15] no completed episode is not a pass", () => {
    expect(summarizeLifecycle([{ type: "hidden", atMs: 1 }], []).passes).toBe(false);
  });
});

describe("[G1] page load to joined", () => {
  it("[G1] removes the human wait before Run from the verdict", () => {
    const summary = summarizeG1({
      pageReadyMs: 400,
      runClickMs: 6400,
      roomReadyMs: 6450,
      socketOpenMs: 6460,
      joinSentMs: 6461,
      joinedMs: 6470,
    });
    expect(summary).toEqual({
      pageLoadToJoinedMs: 6470,
      humanWaitMs: 6000,
      runToJoinedMs: 70,
      joinRoundTripMs: 9,
      machineMs: 470,
      verdict: "pass",
    });
  });

  it("[G1] classifies the 5 s pass and 10 s hard-fail thresholds", () => {
    expect(classifyG1(4999)).toBe("pass");
    expect(classifyG1(5000)).toBe("fail");
    expect(classifyG1(9999)).toBe("fail");
    expect(classifyG1(10_000)).toBe("hard-fail");
  });

  it("[G1] rejects out-of-order marks", () => {
    expect(() =>
      summarizeG1({
        pageReadyMs: 1,
        runClickMs: 10,
        roomReadyMs: 20,
        socketOpenMs: 30,
        joinSentMs: 25,
        joinedMs: 40,
      }),
    ).toThrow(RangeError);
  });
});

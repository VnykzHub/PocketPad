import { describe, expect, it } from "vitest";
import {
  LAN_P95_BUDGET_MS,
  LatencyLogError,
  analyzeSamples,
  formatReportTable,
  parseLatencyLog,
  percentile,
  summarize,
  type LatencySample,
} from "../src/analyze.js";

/** Synthetic taps: 2 ms to encode, 3..12 ms to the host, 9 ms to paint. */
function syntheticLog(count = 100): LatencySample[] {
  return Array.from({ length: count }, (_, index) => {
    const touchMs = 1000 + index * 100;
    const jitter = index % 10;
    return {
      touchMs,
      encodeMs: touchMs + 2,
      hostReceiveMs: touchMs + 5 + jitter,
      hostPaintMs: touchMs + 14 + jitter,
    };
  });
}

describe("[PR-11.1] latency analyzer statistics", () => {
  it("[PR-11.1] percentile is nearest-rank and summary reports p50/p95", () => {
    const values = [5, 1, 4, 2, 3, 100, 6, 7, 8, 9];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile([], 50)).toBeNull();
    expect(() => percentile([1], 0)).toThrow(RangeError);

    expect(summarize(values)).toEqual({
      count: 10,
      p50Ms: 5,
      p95Ms: 100,
      minMs: 1,
      maxMs: 100,
      meanMs: 14.5,
    });
    expect(summarize([])).toBeNull();
  });

  it("[PR-11.1] latency harness measures tap-to-host-canvas flash from a 100+ sample log", () => {
    const report = analyzeSamples(syntheticLog(120));
    expect(report.sampleCount).toBe(120);
    expect(report.rejected).toBe(0);
    expect(report.legs.tapToEncode).toMatchObject({ count: 120, p50Ms: 2, p95Ms: 2 });
    expect(report.legs.packetToHost).toMatchObject({ p50Ms: 7, p95Ms: 12, minMs: 3, maxMs: 12 });
    expect(report.legs.inputAge).toMatchObject({ p50Ms: 9, p95Ms: 14 });
    expect(report.legs.receiveToPaint).toMatchObject({ p50Ms: 9, p95Ms: 9 });
    expect(report.legs.inputToCanvas).toMatchObject({ p50Ms: 18, p95Ms: 23 });
    expect(report.gatedLeg).toBe("inputToCanvas");
  });

  it("[E5] [G2] the p95 verdict uses the 25 ms LAN budget", () => {
    expect(LAN_P95_BUDGET_MS).toBe(25);
    expect(analyzeSamples(syntheticLog()).pass).toBe(true);

    const slow = syntheticLog().map((sample) => ({
      ...sample,
      hostPaintMs: (sample.hostPaintMs ?? 0) + 10,
    }));
    const report = analyzeSamples(slow);
    expect(report.legs.inputToCanvas?.p95Ms).toBe(33);
    expect(report.pass).toBe(false);
    expect(formatReportTable(report)).toContain("inputToCanvas p95 >= 25 ms: FAIL");
  });

  it("[PR-11.1] without a paint stamp the gate falls back to input age", () => {
    const noPaint = syntheticLog().map(({ touchMs, encodeMs, hostReceiveMs }) => ({
      touchMs,
      encodeMs: encodeMs ?? null,
      hostReceiveMs,
    }));
    const report = analyzeSamples(noPaint);
    expect(report.legs.inputToCanvas).toBeUndefined();
    expect(report.legs.receiveToPaint).toBeUndefined();
    expect(report.gatedLeg).toBe("inputAge");
    expect(report.pass).toBe(true);
    expect(analyzeSamples([]).pass).toBeNull();
  });

  it("[PR-11.1] rejects samples with non-finite or backwards timestamps", () => {
    const report = analyzeSamples([
      { touchMs: 0, hostReceiveMs: 5 },
      { touchMs: 10, hostReceiveMs: 5 },
      { touchMs: 0, encodeMs: Number.NaN, hostReceiveMs: 5 },
      { touchMs: 0, hostReceiveMs: 5, hostPaintMs: 4 },
    ]);
    expect(report.sampleCount).toBe(1);
    expect(report.rejected).toBe(3);
  });
});

describe("[FR-7.13] input-to-canvas and display lag stay separate", () => {
  it("[FR-7.13] input-to-canvas and display-lag measurements are reported separately", () => {
    const report = analyzeSamples(syntheticLog());
    expect(report.displayLag.status).toBe("PENDING");
    expect(report.displayLag.valueMs).toBeNull();
    expect(report.displayLag.note).toContain("camera or photodiode");
    // The gated software number never includes a display-lag term.
    expect(report.legs.inputToCanvas?.p95Ms).toBe(23);
    const table = formatReportTable(report);
    expect(table).toMatch(/^inputToCanvas\s+100\s+18\.00\s+23\.00/m);
    expect(table).toMatch(/^displayLag\s+-\s+PENDING/m);
  });
});

describe("[PR-11.1] log parsing", () => {
  it("[PR-11.1] accepts a bare array or an object with samples", () => {
    const samples = syntheticLog(3);
    expect(parseLatencyLog(JSON.stringify(samples))).toEqual(samples);
    expect(parseLatencyLog(JSON.stringify({ schema: 1, samples }))).toEqual(samples);
    expect(parseLatencyLog('[{"touchMs":1,"hostReceiveMs":2,"hostPaintMs":null}]')).toEqual([
      { touchMs: 1, hostReceiveMs: 2 },
    ]);
  });

  it("[PR-11.1] names the problem in malformed logs", () => {
    expect(() => parseLatencyLog("{")).toThrow(LatencyLogError);
    expect(() => parseLatencyLog('{"rows":[]}')).toThrow(/samples/);
    expect(() => parseLatencyLog('[{"touchMs":1}]')).toThrow(/sample 0 needs numeric/);
    expect(() => parseLatencyLog("[3]")).toThrow(/sample 0 is not an object/);
  });
});

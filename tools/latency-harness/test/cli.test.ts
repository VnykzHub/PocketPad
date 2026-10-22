import { describe, expect, it } from "vitest";
import { analyzeSamples } from "../src/analyze.js";
import { runLatencyCli, type LatencyCliIo } from "../src/cli.js";
import type { LiveLatencyOptions, LiveLatencyResult } from "../src/live.js";

const LOG = JSON.stringify({
  samples: Array.from({ length: 100 }, (_, index) => ({
    touchMs: index * 100,
    encodeMs: index * 100 + 1,
    hostReceiveMs: index * 100 + 4,
    hostPaintMs: index * 100 + 12,
  })),
});

interface FakeIo extends LatencyCliIo {
  stdout: string[];
  stderr: string[];
  written: Record<string, string>;
  liveOptions: LiveLatencyOptions[];
}

function fakeIo(files: Record<string, string> = {}): FakeIo {
  const io: FakeIo = {
    stdout: [],
    stderr: [],
    written: {},
    liveOptions: [],
    out: (line) => io.stdout.push(line),
    err: (line) => io.stderr.push(line),
    readText: (path) => {
      const text = files[path];
      return text === undefined ? Promise.reject(new Error(`no file ${path}`)) : Promise.resolve(text);
    },
    writeText: (path, text) => {
      io.written[path] = text;
      return Promise.resolve();
    },
    runLive: (options): Promise<LiveLatencyResult> => {
      io.liveOptions.push(options);
      options.log?.("latency: creating room on http://127.0.0.1:8080");
      const samples = [{ touchMs: 0, encodeMs: 5, hostReceiveMs: 6 }];
      return Promise.resolve({
        schema: 1,
        method: "fake",
        server: "http://127.0.0.1:8080",
        tapsScheduled: 1,
        tapsEncoded: 1,
        tapsReceived: 1,
        intervalMs: 100,
        timedOut: false,
        botState: "closed",
        botFailures: [],
        samples,
        report: analyzeSamples(samples),
        notes: [],
      });
    },
  };
  return io;
}

describe("[PR-11.1] latency CLI", () => {
  it("[PR-11.1] analyze prints a p50/p95 table and JSON for a 100-sample log", async () => {
    const io = fakeIo({ "run.json": LOG });
    expect(await runLatencyCli(["analyze", "run.json"], io)).toBe(0);
    expect(io.stdout[0]).toMatch(/^inputToCanvas\s+100\s+12\.00\s+12\.00/m);
    expect(io.stdout[0]).toContain("inputToCanvas p95 < 25 ms: PASS");
    const report = JSON.parse(io.stdout[1] ?? "{}") as { sampleCount: number };
    expect(report.sampleCount).toBe(100);
  });

  it("[PR-11.1] live passes flags to the harness and writes --out only to a local file", async () => {
    const io = fakeIo();
    const code = await runLatencyCli(
      ["live", "--server", "http://127.0.0.1:8080", "--taps", "20", "--interval", "50", "--out", "e5.json"],
      io,
    );
    expect(code).toBe(0);
    expect(io.liveOptions[0]).toMatchObject({
      server: "http://127.0.0.1:8080",
      taps: 20,
      intervalMs: 50,
    });
    expect(Object.keys(io.written)).toEqual(["e5.json"]);
    expect(JSON.parse(io.written["e5.json"] ?? "{}")).toMatchObject({ schema: 1, tapsReceived: 1 });
    expect(io.stderr).toContain("latency: wrote e5.json");
  });

  it("[PR-11.1] bad arguments exit non-zero with a message", async () => {
    const io = fakeIo();
    expect(await runLatencyCli([], io)).toBe(2);
    expect(io.stderr[0]).toContain("usage:");
    expect(await runLatencyCli(["live"], io)).toBe(1);
    expect(io.stderr.at(-1)).toBe("latency: live needs --server");
    expect(await runLatencyCli(["live", "--server", "http://x", "--taps", "-1"], io)).toBe(1);
    expect(await runLatencyCli(["analyze", "missing.json"], io)).toBe(1);
  });
});

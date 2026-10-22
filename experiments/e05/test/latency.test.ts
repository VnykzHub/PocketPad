import { readFileSync } from "node:fs";
import { transform } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  E5_P95_BUDGET_MS,
  percentile,
  runE5TapLoop,
  summarizeE5,
  type E5Deps,
  type E5Sample,
} from "../latency.ts";
import { analyzeSamples, parseLatencyLog } from "../../../tools/latency-harness/src/analyze.ts";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const SECRET = { code: "Q7ZK", pin: "4821", hostToken: "HOSTTOKEN-secret-0123456789" };

/** In-memory `/ws`: hostJoin/join replies and Input -> InputFwd relay after `wireMs`. */
function fakeServer(clock: { t: number }, wireMs: number) {
  type Listener = (event: unknown) => void;
  let host: FakeSocket | null = null;

  class FakeSocket {
    binaryType = "";
    readyState = 1;
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor(readonly url: string) {
      queueMicrotask(() => this.emit("open", {}));
    }

    addEventListener(type: string, listener: Listener): void {
      const set = this.listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(type, set);
    }

    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener);
    }

    emit(type: string, event: unknown): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    }

    send(data: string | Uint8Array): void {
      if (typeof data === "string") {
        const message = JSON.parse(data) as Record<string, unknown>;
        if (message.t === "hostJoin" && message.hostToken === SECRET.hostToken) {
          host = this;
          queueMicrotask(() =>
            this.emit("message", { data: JSON.stringify({ t: "hostJoined", code: "X", serverTime: 0 }) }),
          );
        } else if (message.t === "join" && message.pin === SECRET.pin) {
          queueMicrotask(() =>
            this.emit("message", {
              data: JSON.stringify({ t: "joined", slot: 3, session: "S", serverTime: 0 }),
            }),
          );
        }
        return;
      }
      const target = host;
      if (data[0] !== 0x02 || target === null) return;
      const forwarded = new Uint8Array(27);
      forwarded[0] = 0xb2;
      forwarded[1] = 3;
      forwarded.set(data.subarray(1), 2);
      queueMicrotask(() => {
        clock.t += wireMs;
        target.emit("message", { data: forwarded.buffer });
      });
    }

    close(): void {
      this.readyState = 3;
    }
  }

  return FakeSocket;
}

function deps(clock: { t: number }, wireMs = 2, paintMs = 7): E5Deps {
  return {
    createRoom: () => Promise.resolve({ ...SECRET }),
    WebSocketCtor: fakeServer(clock, wireMs),
    url: "ws://dev.invalid/ws",
    now: () => clock.t,
    requestFrame: (callback) => {
      clock.t += paintMs;
      callback();
    },
    delay: (ms) => {
      clock.t += ms;
      return Promise.resolve();
    },
  };
}

describe("[E5] input-to-canvas tap loop", () => {
  it("[E5] input-to-canvas p95 is recorded on LAN with separate legs", async () => {
    const clock = { t: 1000 };
    const run = await runE5TapLoop(deps(clock), 100, 120);

    expect(run.samples).toHaveLength(100);
    expect(run.missed).toBe(0);
    expect(run.summary.tapToEncode).toMatchObject({ p50Ms: 0, p95Ms: 0 });
    expect(run.summary.packetToHost).toMatchObject({ p50Ms: 2, p95Ms: 2 });
    expect(run.summary.receiveToPaint).toMatchObject({ p50Ms: 7, p95Ms: 7 });
    expect(run.summary.inputToCanvas).toMatchObject({ count: 100, p50Ms: 9, p95Ms: 9 });
    expect(run.summary.pass).toBe(true);
  });

  it("[G2] a slow host paint fails the 25 ms p95 budget", async () => {
    const run = await runE5TapLoop(deps({ t: 0 }, 2, 30), 20, 120);
    expect(E5_P95_BUDGET_MS).toBe(25);
    expect(run.summary.inputToCanvas?.p95Ms).toBe(32);
    expect(run.summary.pass).toBe(false);
  });

  it("[SR-7] the result never contains the room code, PIN or host token", async () => {
    const run = await runE5TapLoop(deps({ t: 0 }), 3, 120);
    const json = JSON.stringify(run);
    for (const secret of Object.values(SECRET)) expect(json).not.toContain(secret);
  });

  it("[FR-7.13] display lag, camera and TV legs are reported as PENDING, not folded in", async () => {
    const run = await runE5TapLoop(deps({ t: 0 }), 2, 120);
    expect(run.pending.displayLag).toMatch(/^PENDING .*E6/);
    expect(run.pending.cameraInputToPhoton).toMatch(/^PENDING/);
    expect(run.pending.tv).toMatch(/^PENDING .*deferred/);
    expect(Object.keys(run.summary)).not.toContain("displayLag");
  });

  it("[PR-11.1] samples use the latency-harness log format and agree with its analyzer", () => {
    const samples: E5Sample[] = Array.from({ length: 40 }, (_, index) => ({
      touchMs: index * 100,
      encodeMs: index * 100 + 0.2,
      hostReceiveMs: index * 100 + 1 + (index % 5),
      hostPaintMs: index * 100 + 9 + (index % 5),
    }));
    const harness = analyzeSamples(parseLatencyLog(JSON.stringify({ samples })));
    const page = summarizeE5(samples);
    expect(harness.legs.inputToCanvas?.p95Ms).toBe(page.inputToCanvas?.p95Ms);
    expect(harness.legs.packetToHost?.p50Ms).toBe(page.packetToHost?.p50Ms);
    expect(percentile([3, 1, 2], 50)).toBe(2);
  });
});

describe("[E5] page pattern", () => {
  const html = read("../index.html");

  it("[E5] has Run, Copy JSON, table and JSON block with one module script", () => {
    expect(html).toContain("<h1>E5 - Input-to-canvas latency baseline</h1>");
    for (const id of ['id="run"', 'id="copy" type="button" disabled', 'id="results"', 'id="json"']) {
      expect(html).toContain(id);
    }
    expect(html.match(/<script\b/gi)).toHaveLength(1);
    expect(html).toContain('<script type="module" src="./page.js"></script>');
    expect(html).not.toMatch(/<style\b/i);
  });

  it("[E5] checked-in JS matches the TypeScript sources", async () => {
    for (const name of ["latency", "page"]) {
      const built = await transform(read(`../${name}.ts`), {
        loader: "ts",
        format: "esm",
        target: "es2019",
        sourcefile: `${name}.ts`,
      });
      expect(read(`../${name}.js`), `${name}.js is stale; run node experiments/e05/build.mjs`).toBe(
        `/* Generated from ${name}.ts by experiments/e05/build.mjs. Do not edit directly. */\n${built.code}`,
      );
    }
  });

  it("[SR-7] page sources make no direct network calls and load no external origin", () => {
    for (const name of ["../index.html", "../latency.ts", "../page.ts", "../latency.js", "../page.js"]) {
      const text = read(name);
      expect(text, name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket\b|EventSource/);
      expect(text, name).not.toMatch(/(?:href|src)\s*=\s*["']https?:\/\//i);
    }
  });

  it("[E5] mounting does not start a run: only the Run click handler does", () => {
    const page = read("../page.ts");
    expect(page).toContain("mountProbePage(");
    // The tap loop is reachable only from inside a check's run().
    expect(page.indexOf("runE5TapLoop({")).toBeGreaterThan(page.indexOf("run: async () =>"));
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodePing,
  decodePong,
  encodePing,
  encodePong,
} from "../../../packages/protocol/src/binary.js";
import type { WebSocketLike } from "../../e01/probe.js";
import {
  decodeProbePong,
  encodeProbePing,
  recordLifecycle,
  runPingSeries,
  type EventTargetLike,
} from "../probe.js";

function source(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

describe("[E9] Ping/Pong probe codecs match packages/protocol", () => {
  it("[E9] the probe Ping is byte-identical to encodePing and Pong decodes identically", () => {
    for (const value of [0, 1, 1_000_000, 0xffff_ffff, 2 ** 32 + 7]) {
      expect([...encodeProbePing(value)]).toEqual([...encodePing(value >>> 0)]);
      expect(decodePing(encodeProbePing(value)).clientTimeMs).toBe(value >>> 0);
    }
    const pong = encodePong(123_456, 0xfedc_ba98);
    expect(decodeProbePong(pong)).toEqual(decodePong(pong));
    expect(decodeProbePong(new Uint8Array([0x82, 0, 0]))).toBeNull();
    expect(decodeProbePong(encodePing(1))).toBeNull();
  });
});

type Listener = (event: unknown) => void;

/** Answers each Ping after `delayMs` with serverTime = clock + offset, except dropped sequence numbers. */
function fakeServerSocket(options: {
  clock: () => number;
  offsetMs: number;
  delayMs: number;
  drop: ReadonlySet<number>;
}): WebSocketLike {
  const listeners = new Map<string, Set<Listener>>();
  return {
    binaryType: "arraybuffer",
    readyState: 1,
    send(data: string | Uint8Array) {
      if (typeof data === "string") return;
      const { clientTimeMs } = decodePing(data);
      if (options.drop.has(clientTimeMs)) return;
      setTimeout(() => {
        const serverTime = Math.floor(options.clock() + options.offsetMs) >>> 0;
        const frame = encodePong(clientTimeMs, serverTime);
        for (const listener of listeners.get("message") ?? []) listener({ data: frame.buffer });
      }, options.delayMs);
    },
    close() {},
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
  };
}

describe("[E4] runPingSeries", () => {
  it("[E4] matches Pongs by sequence, counts loss and unwraps server time", async () => {
    const clock = (): number => Date.now() + 0.25;
    const socket = fakeServerSocket({ clock, offsetMs: 5000, delayMs: 2, drop: new Set([3, 7]) });
    const result = await runPingSeries(socket, {
      count: 10,
      intervalMs: 1,
      clientClock: clock,
      graceMs: 100,
    });
    expect(result.sent).toBe(10);
    expect(result.samples).toHaveLength(8);
    expect(result.rttMs).toHaveLength(8);
    for (const sample of result.samples) {
      // Unwrapped back to the full Date-scale value, about 5 s ahead.
      expect(sample.serverMs - sample.receivedClientMs).toBeGreaterThan(4990);
      expect(sample.serverMs - sample.receivedClientMs).toBeLessThan(5010);
    }
  });
});

describe("[E15] lifecycle recorder", () => {
  function target(): EventTargetLike & { fire(type: string, event?: unknown): void } {
    const listeners = new Map<string, Listener[]>();
    return {
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      fire(type, event = {}) {
        for (const listener of listeners.get(type) ?? []) listener(event);
      },
    };
  }

  it("[E15] records visibility, pagehide/pageshow and freeze/resume and calls the hooks", () => {
    const doc = Object.assign(target(), { visibilityState: "visible" });
    const win = target();
    let clock = 0;
    const calls: string[] = [];
    const events = recordLifecycle({ document: doc, window: win }, () => clock, {
      onHidden: () => calls.push("suspend"),
      onVisible: () => calls.push("rejoin"),
    });
    expect(events).toEqual([]);

    clock = 10;
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    clock = 11;
    win.fire("pagehide", { persisted: true });
    clock = 12;
    doc.fire("freeze");
    clock = 20;
    doc.fire("resume");
    win.fire("pageshow", { persisted: true });
    clock = 21;
    doc.visibilityState = "visible";
    doc.fire("visibilitychange");

    expect(events).toEqual([
      { type: "hidden", atMs: 10 },
      { type: "pagehide", atMs: 11, persisted: true },
      { type: "freeze", atMs: 12 },
      { type: "resume", atMs: 20 },
      { type: "pageshow", atMs: 20, persisted: true },
      { type: "visible", atMs: 21 },
    ]);
    expect(calls).toEqual(["suspend", "rejoin"]);
  });
});

describe("[G1] page markup and generated modules", () => {
  it("[G1] the page follows the probe pattern and never auto-runs", () => {
    const html = source("index.html");
    for (const id of ["run", "copy", "status", "results", "json"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('<script type="module" src="./page.js"></script>');
    // CSP is script-src 'self'; style-src 'self': no inline script or style.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style|\sstyle="/);
    // SR-7: no external origins.
    expect(html).not.toMatch(/https?:\/\//);
    for (const file of ["page.ts", "probe.ts", "stats.ts"]) {
      expect(source(file)).not.toMatch(/https?:\/\//);
    }
  });

  it("[G1] the checked-in JS is the ES2019 build of each source", () => {
    for (const name of ["stats", "probe", "page"]) {
      const js = source(`${name}.js`);
      expect(js.startsWith(`/* Generated from ${name}.ts by experiments/e09/build.mjs.`)).toBe(true);
      expect(js).not.toMatch(/\?\?|\?\.[a-zA-Z_(]/);
    }
    expect(source("page.js")).toContain("recordLifecycle");
    expect(source("probe.js")).toContain("runPingSeries");
  });
});

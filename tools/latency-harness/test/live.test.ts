import { afterEach, describe, expect, it } from "vitest";
import type {
  BotConnection,
  BotConnectionHandlers,
  BotTransport,
  Scheduler,
} from "@lanpad/input-bot";
import {
  MSG,
  decodeInput,
  encodeInput,
  encodeInputFwd,
  frameType,
  type InputState,
} from "@lanpad/protocol";
import { createDevServer, defaultConfig, type DevServer } from "@lanpad/dev-server";
import { TapRecorder, runLiveLatency, tapMacro, type RoomCredentials } from "../src/live.js";

/** Manual clock: timers fire only when the test calls `step()`. */
class FakeScheduler implements Scheduler {
  private time = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { due: number; every: number | null; run: () => void }>();

  now(): number {
    return this.time;
  }

  setInterval(callback: () => void, intervalMs: number): unknown {
    this.nextId += 1;
    this.timers.set(this.nextId, { due: this.time + intervalMs, every: intervalMs, run: callback });
    return this.nextId;
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.nextId += 1;
    this.timers.set(this.nextId, { due: this.time + delayMs, every: null, run: callback });
    return this.nextId;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Advances 1 ms and fires every timer that came due, in due order. */
  step(): void {
    this.time += 1;
    for (;;) {
      let nextId: number | null = null;
      let nextDue = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.due <= this.time && timer.due < nextDue) {
          nextId = id;
          nextDue = timer.due;
        }
      }
      if (nextId === null) return;
      const timer = this.timers.get(nextId);
      if (timer === undefined) return;
      if (timer.every === null) this.timers.delete(nextId);
      else timer.due += timer.every;
      timer.run();
    }
  }
}

const SECRETS: RoomCredentials = {
  code: "Q7ZK",
  pin: "4821",
  hostToken: "HOSTTOKEN-secret-0123456789",
};
const SESSION = "SESSION-secret-abcdef";

/** In-memory broker: relays controller Input to the host as InputFwd after `wireMs`. */
function fakeBroker(scheduler: FakeScheduler, wireMs: number): BotTransport {
  let host: BotConnectionHandlers | null = null;
  return {
    connect(_url: string, handlers: BotConnectionHandlers): BotConnection {
      queueMicrotask(() => handlers.open());
      return {
        send(data) {
          if (typeof data === "string") {
            const message = JSON.parse(data) as Record<string, unknown>;
            if (message.t === "hostJoin" && message.hostToken === SECRETS.hostToken) {
              host = handlers;
              queueMicrotask(() =>
                handlers.text(JSON.stringify({ t: "hostJoined", code: SECRETS.code, serverTime: 0 })),
              );
            } else if (message.t === "join" && message.pin === SECRETS.pin) {
              queueMicrotask(() =>
                handlers.text(
                  JSON.stringify({ t: "joined", slot: 1, session: SESSION, serverTime: 0 }),
                ),
              );
            }
            return true;
          }
          if (frameType(data) === MSG.Input && host !== null) {
            const target = host;
            const forwarded = encodeInputFwd(1, decodeInput(data));
            scheduler.setTimeout(() => target.binary(forwarded), wireMs);
          }
          return true;
        },
        close() {},
      };
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function inputWithEdges(edges: number): Uint8Array {
  const state: InputState = {
    tick: 0,
    buttons: edges,
    edges,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    lt: 0,
    rt: 0,
    flags: 0,
  };
  return encodeInput(state);
}

describe("[PR-11.1] tap recorder with an injected clock", () => {
  it("[PR-11.1] pairs scheduled taps, encoded edges and host receipts by order", () => {
    let now = 0;
    const recorder = new TapRecorder([100, 200], () => now);
    now = 50;
    recorder.joined(1);

    now = 151;
    recorder.controllerSend(inputWithEdges(0)); // level-only frame: ignored
    recorder.controllerSend(inputWithEdges(1));
    now = 154;
    recorder.hostFrame(encodeInputFwd(2, decodeInput(inputWithEdges(1)))); // other slot
    recorder.hostFrame(encodeInputFwd(1, decodeInput(inputWithEdges(1))));
    now = 260;
    recorder.controllerSend(inputWithEdges(1));
    now = 266;
    recorder.hostFrame(encodeInputFwd(1, decodeInput(inputWithEdges(1))));

    expect(recorder.samples()).toEqual([
      { touchMs: 150, encodeMs: 151, hostReceiveMs: 154 },
      { touchMs: 250, encodeMs: 260, hostReceiveMs: 266 },
    ]);
  });

  it("[PR-11.1] tap macro keeps taps distinct at 60 Hz and validates its inputs", () => {
    const { macros, offsets } = tapMacro(3, 100, 8);
    expect(offsets).toEqual([100, 200, 300]);
    expect(macros).toHaveLength(6);
    expect(macros[1]).toEqual({ atMs: 108, type: "release", buttons: ["A"] });
    expect(() => tapMacro(0, 100, 8)).toThrow(RangeError);
    expect(() => tapMacro(3, 30, 8)).toThrow(/two 60 Hz ticks/);
    expect(() => tapMacro(3, 100, 100)).toThrow(RangeError);
  });
});

describe("[PR-11.1] live run on an injected clock and transport", () => {
  it("[PR-11.1] input-bot taps produce tap-to-encode, packet-to-host and input-age legs", async () => {
    const scheduler = new FakeScheduler();
    const logs: string[] = [];
    const run = runLiveLatency({
      server: "http://127.0.0.1:9",
      taps: 10,
      intervalMs: 100,
      clock: () => scheduler.now(),
      scheduler,
      transport: fakeBroker(scheduler, 3),
      createRoom: () => Promise.resolve({ ...SECRETS }),
      log: (line) => logs.push(line),
    });
    let done = false;
    void run.finally(() => {
      done = true;
    });
    for (let step = 0; step < 5000 && !done; step += 1) {
      await flush();
      scheduler.step();
    }
    const result = await run;

    expect(result.timedOut).toBe(false);
    expect(result.tapsReceived).toBe(10);
    expect(result.samples).toHaveLength(10);
    for (const sample of result.samples) {
      const tapToEncode = (sample.encodeMs ?? 0) - sample.touchMs;
      expect(tapToEncode).toBeGreaterThanOrEqual(0);
      expect(tapToEncode).toBeLessThanOrEqual(17); // one 60 Hz bot tick + 1 ms step
      expect(sample.hostReceiveMs - (sample.encodeMs ?? 0)).toBe(3);
    }
    expect(result.report.legs.packetToHost).toMatchObject({ p50Ms: 3, p95Ms: 3 });
    expect(result.report.gatedLeg).toBe("inputAge");
    expect(result.report.displayLag.status).toBe("PENDING");
    expect(result.server).toBe("http://127.0.0.1:9");

    // SR-7 / SR-9: no credential reaches the result or the progress log.
    const everything = JSON.stringify(result) + logs.join("\n");
    for (const secret of [SECRETS.code, SECRETS.pin, SECRETS.hostToken, SESSION]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("[PR-11.1] a run that never receives input times out with partial results", async () => {
    const scheduler = new FakeScheduler();
    const silent: BotTransport = {
      connect(_url, handlers) {
        queueMicrotask(() => handlers.open());
        return {
          send(data) {
            if (typeof data === "string" && data.includes('"hostJoin"')) {
              queueMicrotask(() =>
                handlers.text(JSON.stringify({ t: "hostJoined", code: "X", serverTime: 0 })),
              );
            }
            return true;
          },
          close() {},
        };
      },
    };
    const run = runLiveLatency({
      server: "http://127.0.0.1:9",
      taps: 2,
      intervalMs: 50,
      timeoutMs: 200,
      clock: () => scheduler.now(),
      scheduler,
      transport: silent,
      createRoom: () => Promise.resolve({ ...SECRETS }),
    });
    let done = false;
    void run.finally(() => {
      done = true;
    });
    for (let step = 0; step < 1000 && !done; step += 1) {
      await flush();
      scheduler.step();
    }
    const result = await run;
    expect(result.timedOut).toBe(true);
    expect(result.samples).toEqual([]);
    expect(result.report.pass).toBeNull();
  });
});

describe("[PR-11.1] [E5] live run against the real dev server", () => {
  let app: DevServer | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("[E5] measures input-bot taps through the dev-server broker on loopback", async () => {
    const config = { ...defaultConfig(), host: "127.0.0.1", port: 0, allowedOrigins: [] };
    app = createDevServer(config, { logger: { info() {} } });
    const { port } = await app.listen();
    const logs: string[] = [];

    const result = await runLiveLatency({
      server: `http://127.0.0.1:${port}`,
      taps: 30,
      intervalMs: 50,
      log: (line) => logs.push(line),
    });

    expect(result.timedOut).toBe(false);
    expect(result.botFailures).toEqual([]);
    expect(result.samples).toHaveLength(30);
    const legs = result.report.legs;
    expect(legs.tapToEncode?.count).toBe(30);
    expect(legs.packetToHost?.p95Ms).toBeGreaterThanOrEqual(0);
    // Loopback relay is far inside the 25 ms LAN budget.
    expect(legs.packetToHost?.p95Ms).toBeLessThan(25);
    expect(legs.inputAge?.p95Ms).toBeLessThan(50);
    expect(logs.join("\n")).not.toMatch(/pin|token/i);
  }, 15_000);
});

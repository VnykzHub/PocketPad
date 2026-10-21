import {
  BUTTON_BITS,
  MSG,
  encodePong,
  decodeInput,
  decodePing,
  frameType,
  stringifyJsonMessage,
} from "@lanpad/protocol";
import { describe, expect, test } from "vitest";
import {
  Bot,
  BotConfigError,
  createBots,
  percentile,
  serverToWsUrl,
} from "../src/bot";
import type { BotConnection, BotConnectionHandlers, BotTransport, Scheduler } from "../src/bot";
import type { MacroAction } from "../src/macros";

const A_BIT = 1 << BUTTON_BITS.A;

class FakeScheduler implements Scheduler {
  nowMs: number;
  readonly intervals: number[] = [];
  private nextHandle = 1;
  private readonly timers = new Map<
    number,
    { callback: () => void; intervalMs: number; nextAt: number }
  >();

  constructor(startMs = 1000) {
    this.nowMs = startMs;
  }

  now = (): number => this.nowMs;

  setInterval(callback: () => void, intervalMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { callback, intervalMs, nextAt: this.nowMs + intervalMs });
    this.intervals.push(intervalMs);
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let bestHandle: number | null = null;
      let bestAt = Number.POSITIVE_INFINITY;
      for (const [handle, timer] of this.timers) {
        if (timer.nextAt <= target && timer.nextAt < bestAt) {
          bestHandle = handle;
          bestAt = timer.nextAt;
        }
      }
      if (bestHandle === null) break;
      const timer = this.timers.get(bestHandle);
      if (timer === undefined) break;
      this.nowMs = timer.nextAt;
      timer.nextAt += timer.intervalMs;
      timer.callback();
    }
    this.nowMs = target;
  }
}

class FakeConnection implements BotConnection {
  readonly sent: Array<string | Uint8Array> = [];
  open = false;

  constructor(
    readonly url: string,
    private readonly handlers: BotConnectionHandlers,
  ) {}

  send(data: string | Uint8Array): boolean {
    if (!this.open) return false;
    this.sent.push(data);
    return true;
  }

  close(): void {
    this.open = false;
  }

  accept(): void {
    this.open = true;
    this.handlers.open();
  }

  goOffline(): void {
    this.open = false;
  }

  receiveText(text: string): void {
    this.handlers.text(text);
  }

  receiveBinary(bytes: Uint8Array): void {
    this.handlers.binary(bytes);
  }

  get texts(): string[] {
    return this.sent.filter((item): item is string => typeof item === "string");
  }

  get binary(): Uint8Array[] {
    return this.sent.filter((item): item is Uint8Array => typeof item !== "string");
  }
}

class FakeTransport implements BotTransport {
  readonly connections: FakeConnection[] = [];

  connect(url: string, handlers: BotConnectionHandlers): BotConnection {
    const connection = new FakeConnection(url, handlers);
    this.connections.push(connection);
    return connection;
  }
}

interface Harness {
  scheduler: FakeScheduler;
  transport: FakeTransport;
  bot: Bot;
  connection: FakeConnection;
}

function connect(
  macros: MacroAction[],
  options: { pin?: string; serverTime?: number } = {},
): Harness {
  const scheduler = new FakeScheduler(1000);
  const transport = new FakeTransport();
  const bot = new Bot({
    server: "http://192.168.1.20:8080",
    code: "ABCD",
    macros,
    transport,
    scheduler,
    ...(options.pin !== undefined ? { pin: options.pin } : {}),
  });
  bot.start();
  const connection = transport.connections[0];
  if (connection === undefined) throw new Error("transport did not connect");
  connection.accept();
  connection.receiveText(
    stringifyJsonMessage({
      t: "joined",
      slot: 1,
      session: "synthetic-session",
      serverTime: options.serverTime ?? 5000,
    }),
  );
  return { scheduler, transport, bot, connection };
}

function inputFrames(connection: FakeConnection): Uint8Array[] {
  return connection.binary.filter((frame) => frameType(frame) === MSG.Input);
}

function decodeAll(frames: Uint8Array[]) {
  return frames.map((frame) => decodeInput(frame));
}

describe("input bot (D0-TOOL-01)", () => {
  test("[FR-7.1] bot sends at 60 Hz with input and 10 Hz idle", () => {
    const held = connect([{ atMs: 0, type: "press", buttons: ["A"] }]);
    held.scheduler.advance(1000);
    const heldFrames = inputFrames(held.connection);
    expect(heldFrames.length).toBeGreaterThanOrEqual(55);
    expect(heldFrames.length).toBeLessThanOrEqual(62);
    for (const state of decodeAll(heldFrames)) {
      expect(state.buttons & A_BIT).toBe(A_BIT);
    }
    expect(held.scheduler.intervals[0]).toBeCloseTo(1000 / 60, 6);

    const idle = connect([]);
    idle.scheduler.advance(1000);
    const idleFrames = inputFrames(idle.connection);
    expect(idleFrames.length).toBeGreaterThanOrEqual(9);
    expect(idleFrames.length).toBeLessThanOrEqual(11);
    for (const state of decodeAll(idleFrames)) {
      expect(state.buttons).toBe(0);
      expect(state.edges).toBe(0);
    }
    expect(idle.scheduler.intervals).toEqual([100]);
  });

  test("[FR-7.3] bot preserves a sub-tick tap edge", () => {
    const { scheduler, connection } = connect([
      { atMs: 0, type: "press", buttons: ["A"] },
      { atMs: 5, type: "release", buttons: ["A"] },
    ]);
    scheduler.advance(20);

    const states = decodeAll(inputFrames(connection));
    expect(states.length).toBeGreaterThanOrEqual(1);
    expect(states[0]?.buttons).toBe(0);
    expect(states[0]?.edges).toBe(A_BIT);

    scheduler.advance(200);
    const later = decodeAll(inputFrames(connection));
    expect(later[1]?.edges).toBe(0);
    expect(later[1]?.buttons).toBe(0);
  });

  test("[FR-7.3] a 40 ms tap clears the level on a later packet", () => {
    const { scheduler, connection } = connect([
      { atMs: 0, type: "press", buttons: ["A"] },
      { atMs: 40, type: "release", buttons: ["A"] },
    ]);
    scheduler.advance(70);

    const states = decodeAll(inputFrames(connection));
    const pressed = states.findIndex((state) => (state.buttons & A_BIT) === A_BIT);
    const released = states.findIndex(
      (state, index) => index > pressed && (state.buttons & A_BIT) === 0,
    );
    expect(pressed).toBeGreaterThanOrEqual(0);
    expect(states[pressed]?.edges).toBe(A_BIT);
    expect(released).toBeGreaterThan(pressed);
    expect(states[released]?.edges).toBe(0);
  });

  test("[G4] bot can create 8 independent clients", () => {
    const scheduler = new FakeScheduler(1000);
    const transport = new FakeTransport();
    const bots = createBots(
      { server: "http://192.168.1.20:8080", code: "ABCD", transport, scheduler },
      8,
    );

    expect(bots).toHaveLength(8);
    for (const bot of bots) bot.start();
    expect(transport.connections).toHaveLength(8);
    expect(new Set(transport.connections).size).toBe(8);

    const first = transport.connections[0];
    if (first === undefined) throw new Error("missing first connection");
    first.accept();
    first.receiveText(
      stringifyJsonMessage({ t: "joined", slot: 1, session: "s", serverTime: 5000 }),
    );
    scheduler.advance(200);
    expect(inputFrames(first).length).toBeGreaterThan(0);
    for (const other of transport.connections.slice(1)) {
      expect(inputFrames(other)).toHaveLength(0);
    }

    expect(() => createBots({ server: "http://x", code: "ABCD", transport, scheduler }, 9)).toThrow(
      BotConfigError,
    );
    expect(() => createBots({ server: "http://x", code: "ABCD", transport, scheduler }, 0)).toThrow(
      BotConfigError,
    );
  });

  test("join carries the PIN but no summary or log leaks it", () => {
    const { connection, bot } = connect([], { pin: "1234" });
    const join = JSON.parse(connection.texts[0] ?? "{}") as Record<string, unknown>;

    expect(join).toMatchObject({ t: "join", v: 1, code: "ABCD", pin: "1234" });
    // The join frame must carry the PIN; reporting (summary output) must not.
    const reported = JSON.stringify(bot.summary());
    expect(reported).not.toContain("1234");
    expect(reported).not.toContain("synthetic-session");
  });

  test("join omits absent optional credentials", () => {
    const { connection } = connect([]);
    const join = JSON.parse(connection.texts[0] ?? "{}") as Record<string, unknown>;

    expect(join).toMatchObject({ t: "join", v: 1, code: "ABCD" });
    expect("pin" in join).toBe(false);
    expect("token" in join).toBe(false);
  });

  test("summary reports sent, rttP50, rttP95 and drops", () => {
    const { scheduler, connection, bot } = connect([
      { atMs: 0, type: "press", buttons: ["A"] },
    ]);
    scheduler.advance(20);

    const ping = connection.binary.find((frame) => frameType(frame) === MSG.Ping);
    expect(ping).toBeDefined();
    if (ping === undefined) return;
    const { clientTimeMs } = decodePing(ping);
    scheduler.advance(100);
    connection.receiveBinary(encodePong(clientTimeMs, 5000));

    const before = bot.summary();
    expect(before.sent).toBeGreaterThan(0);
    expect(before.rttP50).not.toBeNull();
    expect(before.rttP95).not.toBeNull();
    expect(before.rttP50 ?? 0).toBeGreaterThan(0);
    expect(before.rttP95 ?? 0).toBeGreaterThanOrEqual(before.rttP50 ?? 0);

    connection.goOffline();
    scheduler.advance(50);
    expect(bot.summary().drops).toBeGreaterThan(0);
  });

  test("a join error stops the bot and is reported", () => {
    const scheduler = new FakeScheduler(1000);
    const transport = new FakeTransport();
    const bot = new Bot({
      server: "http://192.168.1.20:8080",
      code: "ABCD",
      transport,
      scheduler,
    });
    bot.start();
    const connection = transport.connections[0];
    if (connection === undefined) throw new Error("transport did not connect");
    connection.accept();
    connection.receiveText(stringifyJsonMessage({ t: "joinError", reason: "badPin" }));

    expect(bot.joined).toBe(false);
    expect(bot.joinError).toBe("badPin");
    scheduler.advance(500);
    expect(inputFrames(connection)).toHaveLength(0);
  });
});

describe("bot helpers", () => {
  test("server origins map to the /ws endpoint", () => {
    expect(serverToWsUrl("http://192.168.1.20:8080")).toBe("ws://192.168.1.20:8080/ws");
    expect(serverToWsUrl("https://example.test")).toBe("wss://example.test/ws");
    expect(serverToWsUrl("ws://example.test:9000/ws")).toBe("ws://example.test:9000/ws");
    expect(serverToWsUrl("http://example.test/base")).toBe("ws://example.test/base");
    expect(() => serverToWsUrl("ftp://example.test")).toThrow(BotConfigError);
    expect(() => serverToWsUrl("not a url")).toThrow(BotConfigError);
  });

  test("nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
    expect(percentile([7], 95)).toBe(7);
  });
});

import {
  BUTTON_BITS,
  MAX_CONTROLLERS,
  MSG,
  decodeInput,
  frameType,
  stringifyJsonMessage,
} from "@lanpad/protocol";
import type { JoinErrorReason } from "@lanpad/protocol";
import { describe, expect, test } from "vitest";
import { Bot, BotConfigError, reconnectBackoffMs } from "../src/bot";
import type {
  BotConnection,
  BotConnectionHandlers,
  BotOptions,
  BotTransport,
  Scheduler,
} from "../src/bot";
import type { MacroAction } from "../src/macros";
import {
  SCENARIO_NAMES,
  createScenarioBots,
  loadMacroFile,
  parseIntervalMs,
  parseJitterMs,
  parseLoss,
  parseScenarioName,
  resolveScenario,
  scenarioExitCode,
  summarizeScenario,
} from "../src/scenarios";

const A_BIT = 1 << BUTTON_BITS.A;

interface FakeTimer {
  callback: () => void;
  /** null for one-shot timeouts. */
  intervalMs: number | null;
  nextAt: number;
}

class FakeScheduler implements Scheduler {
  nowMs: number;
  /** Every delay passed to setTimeout, in scheduling order. */
  readonly timeoutDelays: number[] = [];
  private nextHandle = 1;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(startMs = 1000) {
    this.nowMs = startMs;
  }

  now = (): number => this.nowMs;

  setInterval(callback: () => void, intervalMs: number): unknown {
    return this.add(callback, intervalMs, null);
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.timeoutDelays.push(delayMs);
    return this.add(callback, null, delayMs);
  }

  clearTimeout(handle: unknown): void {
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
      if (timer.intervalMs === null) {
        this.timers.delete(bestHandle);
        timer.callback();
      } else {
        timer.nextAt += timer.intervalMs;
        timer.callback();
      }
    }
    this.nowMs = target;
  }

  private add(callback: () => void, intervalMs: number | null, delayMs: number | null): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    const delay = intervalMs ?? delayMs ?? 0;
    this.timers.set(handle, { callback, intervalMs, nextAt: this.nowMs + delay });
    return handle;
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
    if (!this.open) return;
    this.open = false;
    this.handlers.close(1000, "client close");
  }

  accept(): void {
    this.open = true;
    this.handlers.open();
  }

  fail(): void {
    this.open = false;
    this.handlers.close(1006, "network");
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

function connectionAt(transport: FakeTransport, index: number): FakeConnection {
  const connection = transport.connections[index];
  if (connection === undefined) throw new Error(`missing connection ${index}`);
  return connection;
}

function lastConnection(transport: FakeTransport): FakeConnection {
  const connection = transport.connections[transport.connections.length - 1];
  if (connection === undefined) throw new Error("transport has no connections");
  return connection;
}

function joinedText(slot: number, session: string): string {
  return stringifyJsonMessage({ t: "joined", slot, session, serverTime: 5000 });
}

function joinErrorText(reason: JoinErrorReason): string {
  return stringifyJsonMessage({ t: "joinError", reason });
}

interface Harness {
  scheduler: FakeScheduler;
  transport: FakeTransport;
}

function harness(): Harness {
  return { scheduler: new FakeScheduler(1000), transport: new FakeTransport() };
}

function baseOptions(
  h: Harness,
  extra: Partial<Omit<BotOptions, "index">> = {},
): Omit<BotOptions, "index"> {
  return {
    server: "http://192.168.1.20:8080",
    code: "ABCD",
    transport: h.transport,
    scheduler: h.scheduler,
    ...extra,
  };
}

/** Starts one bot and performs the initial join with `slot`/`session`. */
function startJoined(
  h: Harness,
  extra: Partial<Omit<BotOptions, "index">>,
  slot: number,
  session: string,
): { bot: Bot; connection: FakeConnection } {
  const bot = new Bot({ ...baseOptions(h, extra), index: 0 });
  bot.start();
  const connection = connectionAt(h.transport, 0);
  connection.accept();
  connection.receiveText(joinedText(slot, session));
  return { bot, connection };
}

function inputFrames(connection: FakeConnection): Uint8Array[] {
  return connection.binary.filter((frame) => frameType(frame) === MSG.Input);
}

describe("input-bot D4 scenarios (D4-TOOL-01)", () => {
  test("[G4] eight bots hold eight slots for ten minutes", () => {
    const h = harness();
    const config = resolveScenario("steady");
    // Simulated ten minutes on the fake clock. The 1 s send cadence keeps the
    // fake-scheduler run bounded; the 60 Hz / real-timer soak is D4-QA-01.
    const bots = createScenarioBots(
      config,
      baseOptions(h, { activeTickMs: 1000, idleTickMs: 1000 }),
    );
    expect(bots).toHaveLength(MAX_CONTROLLERS);

    for (const bot of bots) bot.start();
    expect(h.transport.connections).toHaveLength(MAX_CONTROLLERS);
    expect(new Set(h.transport.connections).size).toBe(MAX_CONTROLLERS);

    h.transport.connections.forEach((connection, index) => {
      connection.accept();
      connection.receiveText(joinedText(index + 1, `session-${index + 1}`));
    });

    h.scheduler.advance(600_000);

    const summaries = bots.map((bot) => bot.summary());
    expect(summaries.map((summary) => summary.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const summary of summaries) {
      expect(summary.failures).toBe(0);
      expect(summary.reconnects).toBe(0);
      expect(summary.sent).toBeGreaterThan(0);
    }
    const scenario = summarizeScenario(config, bots);
    expect(scenario.ok).toBe(true);
    expect(scenario.failures).toEqual([]);
    expect(scenarioExitCode(scenario)).toBe(0);
  });

  test("[FR-5.3] ninth bot receives roomFull", () => {
    const h = harness();
    const config = resolveScenario("full-room");
    const bots = createScenarioBots(
      config,
      baseOptions(h, { activeTickMs: 1000, idleTickMs: 1000, pin: "1234" }),
    );
    expect(bots).toHaveLength(MAX_CONTROLLERS + 1);

    for (const bot of bots) bot.start();
    expect(h.transport.connections).toHaveLength(MAX_CONTROLLERS + 1);

    for (let slot = 1; slot <= MAX_CONTROLLERS; slot += 1) {
      const connection = connectionAt(h.transport, slot - 1);
      connection.accept();
      connection.receiveText(joinedText(slot, `session-${slot}`));
    }
    const ninth = connectionAt(h.transport, MAX_CONTROLLERS);
    ninth.accept();
    ninth.receiveText(joinErrorText("roomFull"));

    h.scheduler.advance(1000);

    const ninthBot = bots[MAX_CONTROLLERS];
    expect(ninthBot?.summary().slot).toBeNull();
    expect(ninthBot?.expectedErrorSeen).toBe(true);
    expect(ninthBot?.summary().failures).toBe(0);

    const scenario = summarizeScenario(config, bots);
    expect(scenario.ok).toBe(true);
    expect(scenarioExitCode(scenario)).toBe(0);
  });

  test("[FR-5.4] bot reconnect reclaims its slot", () => {
    const h = harness();
    const { bot, connection } = startJoined(h, { reconnectEveryMs: 500 }, 5, "session-five");

    h.scheduler.advance(500);
    expect(bot.state).toBe("reconnecting");
    h.scheduler.advance(300);

    const reconnected = connectionAt(h.transport, 1);
    reconnected.accept();
    const join = JSON.parse(reconnected.texts[0] ?? "{}") as Record<string, unknown>;
    expect(join).toMatchObject({ t: "join", v: 1, code: "ABCD", session: "session-five" });
    expect("pin" in join).toBe(false);
    expect("token" in join).toBe(false);

    reconnected.receiveText(joinedText(5, "session-five"));

    expect(bot.summary()).toMatchObject({ slot: 5, reconnects: 1, failures: 0 });
    expect(bot.ok).toBe(true);
    // The first socket was deliberately closed by the periodic reconnect.
    expect(connection.open).toBe(false);
  });

  test("[FR-7.15] bot reconnect backoff starts at 250 ms and caps at 4 s", () => {
    const midpoint = (): number => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => reconnectBackoffMs(attempt, midpoint))).toEqual([
      250, 500, 1000, 2000, 4000, 4000, 4000,
    ]);

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const base = Math.min(250 * 2 ** (attempt - 1), 4000);
      expect(reconnectBackoffMs(attempt, () => 0)).toBe(Math.round(base * 0.8));
      expect(reconnectBackoffMs(attempt, () => 1 - Number.EPSILON)).toBe(
        Math.round(base * 1.2),
      );
    }

    const h = harness();
    const { connection } = startJoined(h, { random: () => 0.5 }, 1, "session-one");
    connection.fail();
    const observed: number[] = [h.scheduler.timeoutDelays.at(-1) ?? -1];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const scheduled = h.scheduler.timeoutDelays[h.scheduler.timeoutDelays.length - 1] ?? 0;
      h.scheduler.advance(scheduled + 1);
      const next = lastConnection(h.transport);
      next.accept();
      next.fail();
      observed.push(h.scheduler.timeoutDelays[h.scheduler.timeoutDelays.length - 1] ?? -1);
    }
    expect(observed).toEqual([250, 500, 1000, 2000, 4000, 4000]);
  });

  test("[FR-7.14] a silent socket is detected by the watchdog and reconnected with the session", () => {
    const h = harness();
    const { bot } = startJoined(h, { watchdogMs: 7000 }, 2, "session-two");

    h.scheduler.advance(7100);
    expect(bot.state).toBe("reconnecting");
    h.scheduler.advance(300);

    const reconnected = connectionAt(h.transport, 1);
    reconnected.accept();
    const join = JSON.parse(reconnected.texts[0] ?? "{}") as Record<string, unknown>;
    expect(join).toMatchObject({ t: "join", code: "ABCD", session: "session-two" });

    reconnected.receiveText(joinedText(2, "session-two"));
    expect(bot.watchdogCount).toBe(1);
    expect(bot.summary()).toMatchObject({ slot: 2, failures: 0 });
    expect(bot.ok).toBe(true);
  });

  test("[FR-7.14] suspend reserves the slot and the session rejoin restores it", () => {
    const h = harness();
    const { bot, connection } = startJoined(
      h,
      { suspendEveryMs: 2000, suspendResumeDelayMs: 1000 },
      4,
      "session-four",
    );

    h.scheduler.advance(2000);
    expect(connection.texts).toContain(JSON.stringify({ t: "suspend" }));

    h.scheduler.advance(1000);
    const rejoin = JSON.parse(connection.texts[connection.texts.length - 1] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(rejoin).toMatchObject({ t: "join", code: "ABCD", session: "session-four" });
    connection.receiveText(joinedText(4, "session-four"));

    expect(bot.summary()).toMatchObject({ slot: 4, suspends: 1, reconnects: 0, failures: 0 });
    expect(bot.ok).toBe(true);
  });

  test("[G4] churn leaves and rejoins without losing scenario health", () => {
    const h = harness();
    const config = resolveScenario("churn", { clients: 2, churnEveryMs: 1000 });
    const bots = createScenarioBots(
      config,
      baseOptions(h, { activeTickMs: 1000, idleTickMs: 1000, pin: "1234" }),
    );

    for (const bot of bots) bot.start();
    for (let index = 0; index < bots.length; index += 1) {
      const connection = connectionAt(h.transport, index);
      connection.accept();
      connection.receiveText(joinedText(index + 1, `session-${index + 1}`));
    }

    h.scheduler.advance(1000);
    for (let index = 0; index < bots.length; index += 1) {
      expect(connectionAt(h.transport, index).texts).toContain(JSON.stringify({ t: "leave" }));
    }

    h.scheduler.advance(300);
    for (let index = 0; index < bots.length; index += 1) {
      const connection = connectionAt(h.transport, bots.length + index);
      connection.accept();
      const join = JSON.parse(connection.texts[0] ?? "{}") as Record<string, unknown>;
      expect(join).toMatchObject({ t: "join", code: "ABCD", pin: "1234" });
      expect("session" in join).toBe(false);
      connection.receiveText(joinedText(index + 1, `fresh-${index + 1}`));
    }

    const scenario = summarizeScenario(config, bots);
    expect(scenario.ok).toBe(true);
    for (const summary of scenario.bots) {
      expect(summary.churns).toBe(1);
      expect(summary.reconnects).toBe(1);
      expect(summary.failures).toBe(0);
    }
  });

  test("[FR-5.5] an expired session falls back to a fresh join", () => {
    const h = harness();
    const { bot, connection } = startJoined(h, { pin: "1234" }, 3, "session-three");

    connection.fail();
    h.scheduler.advance(300);
    const reconnected = connectionAt(h.transport, 1);
    reconnected.accept();
    const firstJoin = JSON.parse(reconnected.texts[0] ?? "{}") as Record<string, unknown>;
    expect(firstJoin).toMatchObject({ t: "join", session: "session-three" });

    reconnected.receiveText(joinErrorText("expired"));
    const fallback = JSON.parse(reconnected.texts[reconnected.texts.length - 1] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(fallback).toMatchObject({ t: "join", code: "ABCD", pin: "1234" });
    expect("session" in fallback).toBe(false);

    reconnected.receiveText(joinedText(4, "session-four"));
    expect(bot.summary()).toMatchObject({ slot: 4, failures: 0 });
    expect(bot.joinError).toBeNull();
    expect(bot.ok).toBe(true);
  });

  test("[G4] jitter delays frames and loss never drops press edges", () => {
    const jitterHarness = harness();
    const jittered = startJoined(
      jitterHarness,
      {
        macros: [{ atMs: 0, type: "press", buttons: ["A"] }],
        jitterMs: 30,
        random: () => 0.5,
      },
      1,
      "session-one",
    ).bot;

    jitterHarness.scheduler.advance(20);
    expect(jittered.summary().sent).toBe(0);
    expect(jitterHarness.scheduler.timeoutDelays).toContain(15);

    jitterHarness.scheduler.advance(20);
    expect(jittered.summary().sent).toBe(1);

    const lossHarness = harness();
    const macros: MacroAction[] = [
      { atMs: 0, type: "press", buttons: ["A"] },
      { atMs: 60, type: "release", buttons: ["A"] },
      { atMs: 200, type: "press", buttons: ["B"] },
      { atMs: 260, type: "release", buttons: ["B"] },
    ];
    const lossy = startJoined(
      lossHarness,
      { macros, loss: 1, random: () => 0.5 },
      1,
      "session-one",
    );
    lossHarness.scheduler.advance(300);

    const frames = inputFrames(lossy.connection);
    expect(frames.length).toBeGreaterThan(0);
    const states = frames.map((frame) => decodeInput(frame));
    // Only edge-carrying frames survive a 100% level-packet loss.
    expect(states.every((state) => state.edges !== 0)).toBe(true);
    expect(states.some((state) => (state.edges & A_BIT) === A_BIT)).toBe(true);
    expect(lossy.bot.summary().lost).toBeGreaterThan(0);
    expect(lossy.bot.summary().sent).toBe(states.length);
  });

  test("[SR-9] bot output contains no room token or PIN", () => {
    const h = harness();
    const { bot } = startJoined(h, { pin: "8642", token: "room-token-value-22ch" }, 1, "session-secret");

    const botSummary = JSON.stringify(bot.summary());
    expect(botSummary).not.toContain("8642");
    expect(botSummary).not.toContain("session-secret");
    expect(botSummary).not.toContain("room-token-value-22ch");

    const config = resolveScenario("taps", { clients: 1 });
    const scenario = summarizeScenario(config, [bot]);
    const scenarioSummary = JSON.stringify(scenario);
    expect(scenarioSummary).not.toContain("8642");
    expect(scenarioSummary).not.toContain("session-secret");
    expect(scenarioSummary).not.toContain("room-token-value-22ch");
    expect(scenario.ok).toBe(true);
  });
});

describe("scenario configuration (D4-TOOL-01)", () => {
  test("[G4] scenario names and interval/loss flags parse strictly", () => {
    expect(parseScenarioName("FULL-ROOM")).toBe("full-room");
    expect(SCENARIO_NAMES).toEqual(["steady", "taps", "sticks", "churn", "full-room"]);
    expect(() => parseScenarioName("soak")).toThrow(BotConfigError);

    expect(parseIntervalMs("60s")).toBe(60_000);
    expect(parseIntervalMs("250ms")).toBe(250);
    expect(parseIntervalMs("2m")).toBe(120_000);
    expect(parseIntervalMs("1500")).toBe(1500);
    expect(() => parseIntervalMs("0s")).toThrow(BotConfigError);

    expect(parseJitterMs("30")).toBe(30);
    expect(parseJitterMs("30ms")).toBe(30);
    expect(() => parseJitterMs("-1")).toThrow(BotConfigError);

    expect(parseLoss("0.05")).toBe(0.05);
    expect(parseLoss("5%")).toBeCloseTo(0.05, 12);
    expect(() => parseLoss("1.5")).toThrow(BotConfigError);
    expect(() => parseLoss("-0.1")).toThrow(BotConfigError);
  });

  test("[G4] move, jump and tap macros exist and validate", () => {
    for (const name of ["move", "jump", "tap"]) {
      expect(loadMacroFile(name).length).toBeGreaterThan(0);
    }
    const steady = resolveScenario("steady");
    expect(steady.clients).toBe(MAX_CONTROLLERS);
    expect(steady.durationMs).toBe(600_000);
    expect(steady.macros).toEqual(loadMacroFile("move"));
    expect(steady.macroLoopMs).toBe(4000);
  });

  test("[FR-7.15] scenario overrides resolve into a concrete config", () => {
    const config = resolveScenario("steady", {
      clients: 8,
      jitterMs: 30,
      loss: 0.05,
      reconnectEveryMs: 60_000,
      suspendEveryMs: 45_000,
    });
    expect(config).toMatchObject({
      name: "steady",
      clients: 8,
      jitterMs: 30,
      loss: 0.05,
      reconnectEveryMs: 60_000,
      suspendEveryMs: 45_000,
    });

    expect(() => resolveScenario("full-room", { clients: 8 })).toThrow(BotConfigError);
    expect(() => resolveScenario("steady", { clients: 9 })).toThrow(BotConfigError);
    expect(() => resolveScenario("taps", { loss: 1.5 })).toThrow(BotConfigError);
  });

  test("[G4] scenario bot options give the ninth client the roomFull expectation", () => {
    const h = harness();
    const config = resolveScenario("full-room");
    const bots = createScenarioBots(config, baseOptions(h, { pin: "1234" }));
    expect(bots).toHaveLength(MAX_CONTROLLERS + 1);
    expect(bots[MAX_CONTROLLERS - 1]?.expectedError).toBeNull();
    expect(bots[MAX_CONTROLLERS]?.expectedError).toBe("roomFull");
  });
});

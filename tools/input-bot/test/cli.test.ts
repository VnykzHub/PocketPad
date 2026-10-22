/**
 * D4-TOOL-01: the CLI exposes the scenario runner and the D4 network knobs.
 * Bots run for real against a tiny in-memory broker double on a fake clock;
 * no sockets and no sleeps.
 */
import {
  MAX_CONTROLLERS,
  MSG,
  decodePing,
  encodePong,
  parseJsonMessage,
  stringifyJsonMessage,
} from "@lanpad/protocol";
import type { ServerToClientMessage } from "@lanpad/protocol";
import { describe, expect, test } from "vitest";
import type { BotConnection, BotConnectionHandlers, BotTransport, Scheduler } from "../src/bot";
import { parseBotArgs, runBotCli } from "../src/cli";
import { SCENARIO_NAMES } from "../src/index";

const PIN = "4321";

interface Timer {
  callback: () => void;
  intervalMs: number | null;
  nextAt: number;
}

class FakeScheduler implements Scheduler {
  nowMs = 1000;
  private nextHandle = 1;
  private readonly timers = new Map<number, Timer>();

  now = (): number => this.nowMs;

  setInterval(callback: () => void, intervalMs: number): unknown {
    return this.add(callback, intervalMs, intervalMs);
  }

  clearInterval(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    return this.add(callback, null, delayMs);
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let best: [number, Timer] | null = null;
      for (const entry of this.timers) {
        if (entry[1].nextAt <= target && (best === null || entry[1].nextAt < best[1].nextAt)) {
          best = entry;
        }
      }
      if (best === null) break;
      const [handle, timer] = best;
      this.nowMs = timer.nextAt;
      if (timer.intervalMs === null) this.timers.delete(handle);
      else timer.nextAt += timer.intervalMs;
      timer.callback();
    }
    this.nowMs = target;
  }

  private add(callback: () => void, intervalMs: number | null, delayMs: number): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.timers.set(handle, { callback, intervalMs, nextAt: this.nowMs + Math.max(1, delayMs) });
    return handle;
  }
}

/**
 * Minimal broker double: PIN join takes the lowest free slot, `session`
 * rejoins the same slot, `leave` frees it, a 9th player gets `roomFull`.
 * Sockets open one tick after `connect`, like a real transport.
 */
class FakeBroker implements BotTransport {
  /** session → slot; a slot stays held across a close (the 30 s reservation). */
  readonly sessions = new Map<string, number>();
  connections = 0;
  private nextSession = 1;

  constructor(private readonly scheduler: FakeScheduler) {}

  connect(_url: string, handlers: BotConnectionHandlers): BotConnection {
    this.connections += 1;
    let open = false;
    let session: string | null = null;
    const reply = (message: ServerToClientMessage): void => {
      this.scheduler.setTimeout(() => {
        if (open) handlers.text(stringifyJsonMessage(message));
      }, 1);
    };
    this.scheduler.setTimeout(() => {
      open = true;
      handlers.open();
    }, 1);

    return {
      send: (data) => {
        if (!open) return false;
        if (typeof data !== "string") {
          if (data[0] === MSG.Ping) {
            const { clientTimeMs } = decodePing(data);
            this.scheduler.setTimeout(() => {
              if (open) handlers.binary(encodePong(clientTimeMs, this.scheduler.nowMs));
            }, 1);
          }
          return true;
        }
        const message = parseJsonMessage(data);
        if (message.t === "join") {
          if (message.session !== undefined) {
            const slot = this.sessions.get(message.session);
            if (slot === undefined) {
              reply({ t: "joinError", reason: "expired" });
              return true;
            }
            session = message.session;
            reply({ t: "joined", slot, session, serverTime: this.scheduler.nowMs });
            return true;
          }
          if (message.pin !== PIN) {
            reply({ t: "joinError", reason: "badPin" });
            return true;
          }
          const held = new Set(this.sessions.values());
          let slot = 1;
          while (held.has(slot)) slot += 1;
          if (slot > MAX_CONTROLLERS) {
            reply({ t: "joinError", reason: "roomFull" });
            return true;
          }
          session = `fake-session-${this.nextSession}`;
          this.nextSession += 1;
          this.sessions.set(session, slot);
          reply({ t: "joined", slot, session, serverTime: this.scheduler.nowMs });
        } else if (message.t === "leave" && session !== null) {
          this.sessions.delete(session);
          session = null;
        }
        return true;
      },
      close: () => {
        if (!open) return;
        open = false;
        this.scheduler.setTimeout(() => handlers.close(1000, ""), 1);
      },
    };
  }
}

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  broker: FakeBroker;
}

async function runCli(args: readonly string[], durationMs: number): Promise<CliRun> {
  const scheduler = new FakeScheduler();
  const broker = new FakeBroker(scheduler);
  let stdout = "";
  let stderr = "";
  const pending = runBotCli(
    ["--server", "http://192.168.1.20:8080", "--code", "ABCD", "--pin", PIN, ...args],
    { transport: broker, scheduler },
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  );
  scheduler.advance(durationMs + 10);
  const code = await pending;
  return { code, stdout, stderr, broker };
}

interface ScenarioOutput {
  scenario: string;
  ok: boolean;
  failures: string[];
  bots: Array<{ slot: number | null; reconnects: number; suspends: number; churns: number }>;
}

describe("[G4] input-bot CLI flags (D4-TOOL-01)", () => {
  test("[G4] parses every D4 flag, including --flag=value and percent loss", () => {
    const parsed = parseBotArgs([
      "--server=http://127.0.0.1:8080",
      "--code",
      "abcd",
      "--scenario",
      "Steady",
      "--jitter-ms",
      "30",
      "--loss=5%",
      "--reconnect-every",
      "60s",
      "--suspend-every",
      "45s",
      "--churn-every",
      "15s",
      "--watchdog-ms",
      "7000",
    ]);
    expect(parsed.options).toMatchObject({
      code: "ABCD",
      scenario: "steady",
      jitterMs: 30,
      loss: 0.05,
      reconnectEveryMs: 60_000,
      suspendEveryMs: 45_000,
      churnEveryMs: 15_000,
      watchdogMs: 7000,
      clients: undefined,
      durationMs: undefined,
    });
  });

  test("[G4] index re-exports the scenario runner", () => {
    expect(SCENARIO_NAMES).toContain("full-room");
  });

  test.each([
    [["--scenario", "nope"], "unknown scenario"],
    [["--scenario", "taps", "--macro", "x.json"], "--macro cannot be combined"],
    [["--clients", "9"], "--clients must be an integer in 1..8"],
    [["--loss", "2"], "--loss must be at most 1"],
    [["--watchdog-ms", "-1"], "--watchdog-ms"],
    [["--scenario", "full-room", "--clients", "8"], "full-room requires 9 clients"],
  ])("bad configuration %j exits 2 before any socket opens", async (args, message) => {
    const run = await runCli(args, 0);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.broker.connections).toBe(0);
  });
});

describe("[G4] scenario runs", () => {
  test("[G4] steady: eight bots hold eight distinct slots with 30 ms jitter", async () => {
    const run = await runCli(["--scenario", "steady", "--duration", "20s", "--jitter-ms", "30"], 20_000);
    const summary = JSON.parse(run.stdout) as ScenarioOutput;

    expect(run.code).toBe(0);
    expect(summary.scenario).toBe("steady");
    expect(summary.ok).toBe(true);
    expect(summary.bots.map((bot) => bot.slot).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("[FR-5.3] full-room: the ninth bot receives roomFull and the run passes", async () => {
    const run = await runCli(["--scenario", "full-room", "--duration", "3s"], 3_000);
    const summary = JSON.parse(run.stdout) as ScenarioOutput;

    expect(run.code).toBe(0);
    expect(summary.bots).toHaveLength(MAX_CONTROLLERS + 1);
    expect(summary.bots.at(-1)?.slot).toBeNull();
  });

  test("[FR-7.15] --reconnect-every reclaims the same slot by session", async () => {
    const run = await runCli(
      ["--scenario", "sticks", "--clients", "2", "--reconnect-every", "2s", "--duration", "9s"],
      9_000,
    );
    const summary = JSON.parse(run.stdout) as ScenarioOutput;

    expect(run.code).toBe(0);
    expect(summary.failures).toEqual([]);
    for (const bot of summary.bots) {
      expect(bot.reconnects).toBeGreaterThanOrEqual(3);
    }
    expect(summary.bots.map((bot) => bot.slot).sort()).toEqual([1, 2]);
  });

  test("[FR-7.14] --suspend-every and --churn-every are applied", async () => {
    // Separate runs: in one run the suspend cycle preempts the churn timer,
    // so the flags are verified independently rather than combined.
    const suspended = await runCli(
      ["--scenario", "taps", "--suspend-every", "2s", "--duration", "4s"],
      4_000,
    );
    const suspendedSummary = JSON.parse(suspended.stdout) as ScenarioOutput;
    expect(suspended.code).toBe(0);
    expect(suspendedSummary.bots[0]?.suspends).toBeGreaterThan(0);

    const churned = await runCli(
      ["--scenario", "taps", "--churn-every", "2s", "--duration", "4s"],
      4_000,
    );
    const churnedSummary = JSON.parse(churned.stdout) as ScenarioOutput;
    expect(churned.code).toBe(0);
    expect(churnedSummary.bots[0]?.churns).toBeGreaterThan(0);
  });

  test("[SR-9] output contains no PIN and no session token", async () => {
    const run = await runCli(["--scenario", "taps", "--duration", "2s"], 2_000);
    expect(run.stdout + run.stderr).not.toContain(PIN);
    expect(run.stdout + run.stderr).not.toContain("fake-session-");
  });

  test("[G4] without --scenario the D0 mode still runs and a bad PIN exits 1", async () => {
    const ok = await runCli(["--clients", "2", "--duration", "1s"], 1_000);
    expect(ok.code).toBe(0);

    const scheduler = new FakeScheduler();
    const broker = new FakeBroker(scheduler);
    let stdout = "";
    const pending = runBotCli(
      ["--server", "http://192.168.1.20:8080", "--code", "ABCD", "--pin", "0000", "--duration", "1s"],
      { transport: broker, scheduler },
      { stdout: (text) => (stdout += text), stderr: () => {} },
    );
    scheduler.advance(1_010);
    expect(await pending).toBe(1);
    expect(stdout).not.toContain("0000");
  });
});

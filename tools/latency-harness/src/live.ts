/**
 * Live latency run against the dev server (D3-TOOL-01, PR-11.1).
 *
 * One `@lanpad/input-bot` controller taps button A on a fixed schedule while a
 * host socket in this process listens for the forwarded edges:
 *
 *   bot press scheduled (touchMs)
 *     -> Input frame with the edge written to the socket (encodeMs)
 *     -> broker relays InputFwd to the host socket (hostReceiveMs)
 *
 * Both ends share one injected clock, so no cross-device clock sync is needed.
 * There is no canvas in Node, so `hostPaintMs` stays absent; the browser E5
 * page adds the paint leg and the camera adds display lag (FR-7.13).
 *
 * The bot sends on a 60 Hz tick, so `tapToEncode` includes 0..16.7 ms of tick
 * quantisation. The real controller sends immediately on change (FR-7.1), so
 * treat that leg as the bot's, not the phone's.
 *
 * SR-7 / SR-9: the room code, PIN and host token live only in local variables
 * for the duration of the run. They are never passed to `log`, never written
 * to the result, and nothing is uploaded anywhere.
 */
import {
  Bot,
  serverToWsUrl,
  wsTransport,
  type BotConnection,
  type BotConnectionHandlers,
  type BotTransport,
  type MacroAction,
  type Scheduler,
} from "@lanpad/input-bot";
import {
  MSG,
  PROTOCOL_VERSION,
  decodeInput,
  decodeInputFwd,
  frameType,
} from "@lanpad/protocol";
import { analyzeSamples, type LatencyReport, type LatencySample } from "./analyze.js";

export interface RoomCredentials {
  code: string;
  pin: string;
  hostToken: string;
}

export type Clock = () => number;

export interface LiveLatencyOptions {
  /** Dev server base URL, e.g. `http://127.0.0.1:8080`. */
  server: string;
  /** Number of taps. Default 100. */
  taps?: number;
  /** Gap between taps. Must exceed two 60 Hz ticks. Default 100 ms. */
  intervalMs?: number;
  /** How long A is held. Default 8 ms. */
  pressMs?: number;
  /** Abort waiting after this long. Default taps * intervalMs + 5000. */
  timeoutMs?: number;
  /** Monotonic clock shared by bot and host. Default `performance.now`. */
  clock?: Clock;
  /** Socket transport for both ends. Default the input-bot `ws` transport. */
  transport?: BotTransport;
  /** Timers for the bot and the run timeout. Default Node timers on `clock`. */
  scheduler?: Scheduler;
  /** Creates the room. Default `POST {server}/api/rooms`. */
  createRoom?: () => Promise<RoomCredentials>;
  /** Progress lines. Never receives credentials. */
  log?: (line: string) => void;
}

export interface LiveLatencyResult {
  schema: 1;
  method: string;
  /** Origin only; no path, query or credentials. */
  server: string;
  tapsScheduled: number;
  tapsEncoded: number;
  tapsReceived: number;
  intervalMs: number;
  timedOut: boolean;
  botState: string;
  botFailures: string[];
  samples: LatencySample[];
  report: LatencyReport;
  notes: string[];
}

const BUTTON_A_BIT = 1 << 0;
const HOST_JOIN_TIMEOUT_MS = 5000;

/** Pairs scheduled taps, encoded edge frames and host receipts by order. */
export class TapRecorder {
  private joinedAt: number | null = null;
  private slot: number | null = null;
  private readonly encodes: number[] = [];
  private readonly receives: number[] = [];

  constructor(
    private readonly tapOffsetsMs: readonly number[],
    private readonly clock: Clock,
  ) {}

  /** Controller saw `joined`; the bot's macro clock starts now. */
  joined(slot: number): void {
    if (this.joinedAt === null) this.joinedAt = this.clock();
    this.slot = slot;
  }

  /** Called immediately before the controller writes a frame. */
  controllerSend(frame: Uint8Array): void {
    if (frameType(frame) !== MSG.Input) return;
    if ((decodeInput(frame).edges & BUTTON_A_BIT) === 0) return;
    this.encodes.push(this.clock());
  }

  /** Called as soon as the host socket delivers a binary frame. */
  hostFrame(frame: Uint8Array): void {
    if (frameType(frame) !== MSG.InputFwd) return;
    const now = this.clock();
    const { slot, state } = decodeInputFwd(frame);
    if (this.slot !== null && slot !== this.slot) return;
    if ((state.edges & BUTTON_A_BIT) === 0) return;
    this.receives.push(now);
  }

  get encoded(): number {
    return this.encodes.length;
  }

  get received(): number {
    return this.receives.length;
  }

  samples(): LatencySample[] {
    if (this.joinedAt === null) return [];
    const joinedAt = this.joinedAt;
    const count = Math.min(this.tapOffsetsMs.length, this.encodes.length, this.receives.length);
    const out: LatencySample[] = [];
    for (let index = 0; index < count; index += 1) {
      out.push({
        touchMs: joinedAt + (this.tapOffsetsMs[index] ?? 0),
        encodeMs: this.encodes[index] ?? 0,
        hostReceiveMs: this.receives[index] ?? 0,
      });
    }
    return out;
  }
}

/** A press/release pair per tap; the first tap waits one interval after join. */
export function tapMacro(
  taps: number,
  intervalMs: number,
  pressMs: number,
): { macros: MacroAction[]; offsets: number[] } {
  if (!Number.isInteger(taps) || taps < 1) throw new RangeError("taps must be an integer >= 1");
  if (!(intervalMs > 2 * (1000 / 60))) {
    throw new RangeError("intervalMs must exceed two 60 Hz ticks (33.4 ms) so taps stay distinct");
  }
  if (!(pressMs > 0 && pressMs < intervalMs)) {
    throw new RangeError("pressMs must be > 0 and shorter than intervalMs");
  }
  const macros: MacroAction[] = [];
  const offsets: number[] = [];
  for (let index = 0; index < taps; index += 1) {
    const atMs = (index + 1) * intervalMs;
    offsets.push(atMs);
    macros.push({ atMs, type: "press", buttons: ["A"] });
    macros.push({ atMs: atMs + pressMs, type: "release", buttons: ["A"] });
  }
  return { macros, offsets };
}

function nodeScheduler(clock: Clock): Scheduler {
  return {
    now: clock,
    setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function isCredentials(value: unknown): value is RoomCredentials {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.code === "string" &&
    typeof record.pin === "string" &&
    typeof record.hostToken === "string"
  );
}

/** `POST /api/rooms` on the dev server. The response body is never logged. */
export async function createDevRoom(server: string): Promise<RoomCredentials> {
  const url = new URL("/api/rooms", server.replace(/^ws(s?):/, "http$1:"));
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) throw new Error(`POST /api/rooms returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isCredentials(body)) throw new Error("POST /api/rooms returned an unexpected body");
  return { code: body.code, pin: body.pin, hostToken: body.hostToken };
}

function parseJson(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Wraps a transport so the recorder sees every controller frame at the socket edge. */
function recordingTransport(inner: BotTransport, recorder: TapRecorder): BotTransport {
  return {
    connect(url: string, handlers: BotConnectionHandlers): BotConnection {
      const connection = inner.connect(url, {
        ...handlers,
        text: (payload) => {
          // Stamp `joined` before the bot handles it so the bot's macro clock
          // and the recorder's tap origin agree to within microseconds.
          const message = parseJson(payload);
          if (message?.t === "joined" && typeof message.slot === "number") {
            recorder.joined(message.slot);
          }
          handlers.text(payload);
        },
      });
      return {
        send(data) {
          if (typeof data !== "string") recorder.controllerSend(data);
          return connection.send(data);
        },
        close: () => connection.close(),
      };
    },
  };
}

/** Opens the host socket and resolves once `hostJoined` arrives. */
function joinHost(
  transport: BotTransport,
  wsUrl: string,
  credentials: RoomCredentials,
  recorder: TapRecorder,
  scheduler: Scheduler,
): Promise<BotConnection> {
  return new Promise<BotConnection>((resolve, reject) => {
    let settled = false;
    const settle = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) scheduler.clearTimeout?.(timer);
      if (error === null) resolve(connection);
      else reject(error);
    };
    const timer = scheduler.setTimeout?.(
      () => settle(new Error("host did not join in time")),
      HOST_JOIN_TIMEOUT_MS,
    );
    const connection: BotConnection = transport.connect(wsUrl, {
      open: () => {
        connection.send(
          JSON.stringify({
            t: "hostJoin",
            v: PROTOCOL_VERSION,
            code: credentials.code,
            hostToken: credentials.hostToken,
          }),
        );
      },
      text: (payload) => {
        const message = parseJson(payload);
        if (message?.t === "hostJoined") settle(null);
        else if (message?.t === "joinError") {
          settle(new Error(`hostJoin rejected: ${String(message.reason)}`));
        }
      },
      binary: (payload) => recorder.hostFrame(payload),
      close: (code) => settle(new Error(`host socket closed (${code}) before hostJoined`)),
      error: (error) => settle(error),
    });
  });
}

export async function runLiveLatency(options: LiveLatencyOptions): Promise<LiveLatencyResult> {
  const taps = options.taps ?? 100;
  const intervalMs = options.intervalMs ?? 100;
  const pressMs = options.pressMs ?? 8;
  const timeoutMs = options.timeoutMs ?? taps * intervalMs + 5000;
  const clock = options.clock ?? (() => performance.now());
  const scheduler = options.scheduler ?? nodeScheduler(clock);
  const transport = options.transport ?? wsTransport;
  const log = options.log ?? (() => undefined);
  const { macros, offsets } = tapMacro(taps, intervalMs, pressMs);
  const recorder = new TapRecorder(offsets, clock);
  const wsUrl = serverToWsUrl(options.server);
  const origin = new URL(options.server).origin;

  log(`latency: creating room on ${origin}`);
  const credentials = await (options.createRoom ?? (() => createDevRoom(options.server)))();

  let host: BotConnection | null = null;
  let bot: Bot | null = null;
  let timedOut = false;

  try {
    host = await joinHost(transport, wsUrl, credentials, recorder, scheduler);
    log(`latency: host joined; bot taps A ${taps} times every ${intervalMs} ms`);

    const activeBot = new Bot({
      server: options.server,
      code: credentials.code,
      pin: credentials.pin,
      name: "latency",
      macros,
      transport: recordingTransport(transport, recorder),
      scheduler,
      autoReconnect: false,
    });
    bot = activeBot;
    activeBot.start();

    await new Promise<void>((resolve) => {
      // Assigned after the interval: poll and timeout must be able to clear
      // each other, and the poll callback may run synchronously.
      // eslint-disable-next-line prefer-const
      let timeout: unknown;
      const poll = scheduler.setInterval(() => {
        const state = activeBot.state;
        if (recorder.received >= taps || state === "error" || state === "closed") {
          scheduler.clearInterval(poll);
          if (timeout !== undefined) scheduler.clearTimeout?.(timeout);
          resolve();
        }
      }, 10);
      timeout = scheduler.setTimeout?.(() => {
        timedOut = true;
        scheduler.clearInterval(poll);
        resolve();
      }, timeoutMs);
    });
  } finally {
    bot?.stop();
    host?.close();
  }

  const samples = recorder.samples();
  log(`latency: ${samples.length}/${taps} taps paired`);
  return {
    schema: 1,
    method:
      "input-bot controller socket -> dev-server broker -> host socket; one process, one monotonic clock (software only)",
    server: origin,
    tapsScheduled: taps,
    tapsEncoded: recorder.encoded,
    tapsReceived: recorder.received,
    intervalMs,
    timedOut,
    botState: bot === null ? "not started" : bot.state,
    botFailures: bot === null ? [] : [...bot.failureDetails],
    samples,
    report: analyzeSamples(samples),
    notes: [
      "tapToEncode includes the bot's 60 Hz send tick (0..16.7 ms); the real controller sends on change (FR-7.1).",
      "No host canvas in Node: hostPaintMs and inputToCanvas come from the E5 browser page.",
      "Display lag is not measured here (FR-7.13); see E6.",
    ],
  };
}

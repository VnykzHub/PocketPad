/**
 * Input bot core (D0-TOOL-01, extended by D4-TOOL-01).
 *
 * One `Bot` is one controller socket: it joins a room, then sends binary Input
 * frames at 60 Hz while it has input to express and at 10 Hz as an idle
 * keepalive. D4 adds the session lifecycle the controller will use: rejoin by
 * session token, suspend/resume, leave-and-rejoin churn, a silent-socket
 * watchdog, and optional jitter/loss injection on the send path.
 *
 * Transport, scheduling and randomness are injectable so tests run on a fake
 * clock with deterministic jitter/loss. The bot imports `@lanpad/protocol`
 * only; it never touches controller or runtime code.
 */
import {
  BUTTON_BITS,
  MAX_CONTROLLERS,
  MSG,
  PROTOCOL_VERSION,
  TICK_HZ,
  decodePong,
  encodeInput,
  encodePing,
  frameType,
  parseJsonMessage,
  stringifyJsonMessage,
} from "@lanpad/protocol";
import type {
  ClientToServerMessage,
  InputState,
  JoinErrorReason,
  JsonControlMessage,
} from "@lanpad/protocol";
import { WebSocket } from "ws";
import type { MacroAction } from "./macros.js";

/** Timer abstraction; the default uses Node timers, tests use a fake clock. */
export interface Scheduler {
  now(): number;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
  /**
   * Optional one-shot timer. D4 jitter and reconnect backoff need it; a
   * scheduler without it can still run the bot, but frames are never delayed.
   */
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface BotConnectionHandlers {
  open(): void;
  text(payload: string): void;
  binary(payload: Uint8Array): void;
  close(code: number, reason: string): void;
  error(error: Error): void;
}

export interface BotConnection {
  /** Returns false when the socket is not open or the write failed. */
  send(data: string | Uint8Array): boolean;
  close(): void;
}

export interface BotTransport {
  connect(url: string, handlers: BotConnectionHandlers): BotConnection;
}

/** Thrown for configuration mistakes, before any socket is opened. */
export class BotConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotConfigError";
  }
}

/** Maps `http(s)://host:port[/path]` onto the `/ws` WebSocket endpoint. */
export function serverToWsUrl(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new BotConfigError(`invalid server URL ${JSON.stringify(server)}`);
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new BotConfigError(`server URL must be http(s) or ws(s), got ${url.protocol}`);
  }
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/ws";
  return url.toString();
}

/** Nearest-rank percentile; `null` when there are no samples. */
export function percentile(values: readonly number[], percent: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percent / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

/** FR-7.15: reconnect backoff starts at 250 ms and doubles to a 4 s cap. */
export const RECONNECT_BASE_MS = 250;
export const RECONNECT_MAX_MS = 4000;

/**
 * Backoff for reconnect attempt `attempt` (1-based) with +/-20% jitter.
 * `random` is injectable so tests can pin the jitter.
 */
export function reconnectBackoffMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(RECONNECT_BASE_MS * 2 ** exponent, RECONNECT_MAX_MS);
  const factor = 0.8 + 0.4 * random();
  return Math.round(base * factor);
}

export type BotStatus =
  | "idle"
  | "connecting"
  | "joined"
  | "reconnecting"
  | "suspended"
  | "closed"
  | "error";

type TimerMode = "active" | "idle";

export interface BotOptions {
  index?: number;
  server: string;
  code: string;
  pin?: string;
  token?: string;
  name?: string;
  macros?: readonly MacroAction[];
  transport?: BotTransport;
  scheduler?: Scheduler;
  /** Default 1000 / 60 ms. */
  activeTickMs?: number;
  /** Default 100 ms. */
  idleTickMs?: number;
  /** Default 5000 ms. */
  pingIntervalMs?: number;
  /** D4: delay every Input frame by a uniform 0..jitterMs. Default 0. */
  jitterMs?: number;
  /** D4: drop this fraction of level-only Input frames (0..1). Edges never drop. */
  loss?: number;
  /** D4: re-run the macro list every macroLoopMs while joined. Default off. */
  macroLoopMs?: number | null;
  /** D4: close and reopen with the session token every N ms. Default off. */
  reconnectEveryMs?: number | null;
  /** D4: send `suspend`, wait, then rejoin every N ms. Default off. */
  suspendEveryMs?: number | null;
  /** D4: send `leave` and join fresh every N ms. Default off. */
  churnEveryMs?: number | null;
  /** D4: pause after `suspend` before rejoining. Default 1000 ms. */
  suspendResumeDelayMs?: number;
  /** D4: no server message for N ms closes and reconnects. 0 = off. */
  watchdogMs?: number;
  /** D4: reconnect after an unexpected close. Default true. */
  autoReconnect?: boolean;
  /** D4: a joinError this bot expects, e.g. `roomFull` for the 9th client. */
  expectJoinError?: JoinErrorReason;
  /** Deterministic RNG for jitter, loss and backoff. Default Math.random. */
  random?: () => number;
}

export interface BotSummary {
  index: number;
  slot: number | null;
  sent: number;
  /** Input frames that carried at least one press edge. */
  edges: number;
  reconnects: number;
  suspends: number;
  churns: number;
  failures: number;
  /** Packets dropped by the injected loss simulation. */
  lost: number;
  /** Packets that could not be written to the socket (real drops). */
  drops: number;
  pings: number;
  rttP50: number | null;
  rttP95: number | null;
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) {
    const merged = Buffer.concat(data);
    return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
  }
  if (data instanceof Buffer) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function requireNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new BotConfigError(`${name} must be a finite number >= 0`);
  }
  return value;
}

function requireOptionalInterval(value: number | null | undefined, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) {
    throw new BotConfigError(`${name} must be a finite number > 0`);
  }
  return value;
}

class WsConnection implements BotConnection {
  constructor(private readonly socket: WebSocket) {}

  send(data: string | Uint8Array): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(data);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
  }
}

/** Default transport backed by the `ws` client. */
export const wsTransport: BotTransport = {
  connect(url, handlers) {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    socket.on("open", () => handlers.open());
    socket.on("message", (data, isBinary) => {
      if (isBinary) handlers.binary(toBytes(data));
      else handlers.text(data.toString());
    });
    socket.on("close", (code, reason) => handlers.close(code, reason.toString()));
    socket.on("error", (error) => handlers.error(error));
    return new WsConnection(socket);
  },
};

export class Bot {
  readonly index: number;

  private readonly server: string;
  private readonly code: string;
  private readonly pin: string | undefined;
  private readonly token: string | undefined;
  private readonly name: string | undefined;
  private readonly macros: readonly MacroAction[];
  private readonly transport: BotTransport;
  private readonly scheduler: Scheduler;
  private readonly activeTickMs: number;
  private readonly idleTickMs: number;
  private readonly pingIntervalMs: number;
  private readonly jitterMs: number;
  private readonly loss: number;
  private readonly macroLoopMs: number | null;
  private readonly reconnectEveryMs: number | null;
  private readonly suspendEveryMs: number | null;
  private readonly churnEveryMs: number | null;
  private readonly suspendResumeDelayMs: number;
  private readonly watchdogMs: number;
  private readonly autoReconnect: boolean;
  private readonly expectedJoinError: JoinErrorReason | null;
  private readonly random: () => number;

  private wsUrl = "";
  private connection: BotConnection | null = null;
  private socketOpen = false;
  /** True only while the current socket has an accepted `joined`. */
  private joinedThisSocket = false;
  private timer: unknown = null;
  private timerMode: TimerMode | null = null;
  private status: BotStatus = "idle";
  private stopping = false;

  private slot: number | null = null;
  private session: string | null = null;
  private expectedSlot: number | null = null;
  private serverTime = 0;
  /** Local time of the first join; the macro clock never resets. */
  private clockStarted = false;
  private macroStartMs = 0;
  private macroEpochMs = 0;
  private joinedAtMs = 0;
  private elapsedMs = 0;
  private lastServerMessageAt = 0;
  private hasJoined = false;
  private joinFailure: JoinErrorReason | null = null;
  private expectedErrorReceived = false;
  private fellBack = false;
  private lastError: string | null = null;

  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private suspendTimer: unknown = null;
  private retryTimer: unknown = null;
  private nextReconnectAt: number | null = null;
  private nextSuspendAt: number | null = null;
  private nextChurnAt: number | null = null;
  private readonly pendingSends = new Set<unknown>();

  private macroIndex = 0;
  private level = 0;
  private pendingEdges = 0;
  private axes = { lx: 0, ly: 0, rx: 0, ry: 0 };

  private sent = 0;
  private edgeFrames = 0;
  private drops = 0;
  private lost = 0;
  private pings = 0;
  private reconnectCount = 0;
  private suspendCount = 0;
  private churnCount = 0;
  private watchdogTrips = 0;
  private lastPingAt = Number.NEGATIVE_INFINITY;
  private readonly rtts: number[] = [];
  private readonly pingSentAt = new Map<number, number>();
  private readonly failureReasons: string[] = [];

  constructor(options: BotOptions) {
    if (options.code.length === 0) throw new BotConfigError("code must not be empty");
    this.index = options.index ?? 0;
    this.server = options.server;
    this.code = options.code;
    this.pin = options.pin;
    this.token = options.token;
    this.name = options.name;
    this.macros = options.macros ?? [];
    this.transport = options.transport ?? wsTransport;
    this.scheduler = options.scheduler ?? realScheduler;
    this.activeTickMs = options.activeTickMs ?? 1000 / TICK_HZ;
    this.idleTickMs = options.idleTickMs ?? 100;
    this.pingIntervalMs = options.pingIntervalMs ?? 5000;
    this.jitterMs = requireNonNegative(options.jitterMs ?? 0, "jitterMs");
    this.loss = options.loss ?? 0;
    if (!Number.isFinite(this.loss) || this.loss < 0 || this.loss > 1) {
      throw new BotConfigError("loss must be a finite number in 0..1");
    }
    this.macroLoopMs = requireOptionalInterval(options.macroLoopMs, "macroLoopMs");
    this.reconnectEveryMs = requireOptionalInterval(options.reconnectEveryMs, "reconnectEveryMs");
    this.suspendEveryMs = requireOptionalInterval(options.suspendEveryMs, "suspendEveryMs");
    this.churnEveryMs = requireOptionalInterval(options.churnEveryMs, "churnEveryMs");
    this.suspendResumeDelayMs = requireNonNegative(
      options.suspendResumeDelayMs ?? 1000,
      "suspendResumeDelayMs",
    );
    this.watchdogMs = requireNonNegative(options.watchdogMs ?? 0, "watchdogMs");
    this.autoReconnect = options.autoReconnect ?? true;
    this.expectedJoinError = options.expectJoinError ?? null;
    this.random = options.random ?? Math.random;
  }

  get joined(): boolean {
    return this.hasJoined;
  }

  get joinError(): JoinErrorReason | null {
    return this.joinFailure;
  }

  get connectionError(): string | null {
    return this.lastError;
  }

  get state(): BotStatus {
    return this.status;
  }

  get expectedError(): JoinErrorReason | null {
    return this.expectedJoinError;
  }

  get expectedErrorSeen(): boolean {
    return this.expectedErrorReceived;
  }

  /** True when this bot met its contract: joined (or saw its expected error) and no failures. */
  get ok(): boolean {
    if (this.failureReasons.length > 0) return false;
    if (this.expectedJoinError !== null) return this.expectedErrorSeen;
    return this.hasJoined;
  }

  /** Failure descriptions; protocol reasons only, never credentials. */
  get failureDetails(): readonly string[] {
    return this.failureReasons;
  }

  start(): void {
    if (this.status !== "idle") return;
    this.wsUrl = serverToWsUrl(this.server);
    this.openSocket();
  }

  stop(): void {
    this.stopping = true;
    this.stopTimer();
    this.cancelReconnectTimer();
    this.cancelSuspendTimer();
    this.cancelRetryTimer();
    this.clearPendingSends();
    if (this.connection !== null) {
      this.connection.send(stringifyJsonMessage({ t: "leave" }));
      const connection = this.connection;
      this.connection = null;
      this.socketOpen = false;
      connection.close();
    }
    if (this.status !== "error") this.status = "closed";
  }

  summary(): BotSummary {
    return {
      index: this.index,
      slot: this.slot,
      sent: this.sent,
      edges: this.edgeFrames,
      reconnects: this.reconnectCount,
      suspends: this.suspendCount,
      churns: this.churnCount,
      failures: this.failureReasons.length,
      lost: this.lost,
      drops: this.drops,
      pings: this.pings,
      rttP50: percentile(this.rtts, 50),
      rttP95: percentile(this.rtts, 95),
    };
  }

  /** Exposed for scenario summaries: watchdog trips are recoveries, not failures. */
  get watchdogCount(): number {
    return this.watchdogTrips;
  }

  private openSocket(): void {
    if (this.stopping) return;
    this.status = "connecting";
    this.joinedThisSocket = false;
    this.connection = this.transport.connect(this.wsUrl, {
      open: () => this.handleOpen(),
      text: (payload) => this.handleText(payload),
      binary: (payload) => this.handleBinary(payload),
      close: (code, reason) => this.handleClose(code, reason),
      error: (error) => {
        this.lastError = error.message;
      },
    });
  }

  private handleOpen(): void {
    this.socketOpen = true;
    this.sendJoin();
  }

  private sendJoin(): void {
    const base = { t: "join" as const, v: PROTOCOL_VERSION, code: this.code };
    let message: ClientToServerMessage;
    if (this.session !== null) {
      // FR-5.4: a rejoin uses the session token, never the shared room token.
      message = { ...base, session: this.session };
    } else {
      message = {
        ...base,
        ...(this.pin !== undefined ? { pin: this.pin } : {}),
        ...(this.token !== undefined ? { token: this.token } : {}),
        ...(this.name !== undefined ? { name: this.name } : {}),
      };
    }
    this.connection?.send(stringifyJsonMessage(message));
  }

  private handleText(payload: string): void {
    this.lastServerMessageAt = this.scheduler.now();
    let message: JsonControlMessage;
    try {
      message = parseJsonMessage(payload);
    } catch {
      this.drops += 1;
      return;
    }

    switch (message.t) {
      case "joined":
        this.handleJoined(message.slot, message.session, message.serverTime);
        return;
      case "joinError":
        this.handleJoinError(message.reason);
        return;
      case "kick":
        this.handleKick(message.reason);
        return;
      default:
        // hostStatus, stats, player* and layout messages are not needed by the
        // bot; ignoring them keeps it forward-compatible (A9 risk note).
        return;
    }
  }

  private handleJoined(slot: number, session: string, serverTime: number): void {
    const now = this.scheduler.now();
    if (!this.clockStarted) {
      this.clockStarted = true;
      this.macroStartMs = now;
      this.macroEpochMs = 0;
    }
    this.elapsedMs = now - this.macroStartMs;
    this.joinedAtMs = now;
    this.serverTime = serverTime;

    if (this.expectedSlot !== null && slot !== this.expectedSlot) {
      this.failureReasons.push(`slotChanged:${this.expectedSlot}->${slot}`);
    }
    this.expectedSlot = slot;
    this.slot = slot;
    this.session = session;
    this.hasJoined = true;
    this.joinedThisSocket = true;
    this.status = "joined";
    this.joinFailure = null;
    this.reconnectAttempt = 0;
    this.fellBack = false;
    this.cancelReconnectTimer();
    this.cancelSuspendTimer();
    this.cancelRetryTimer();
    this.nextReconnectAt =
      this.reconnectEveryMs !== null ? now + this.reconnectEveryMs : null;
    this.nextSuspendAt = this.suspendEveryMs !== null ? now + this.suspendEveryMs : null;
    this.nextChurnAt = this.churnEveryMs !== null ? now + this.churnEveryMs : null;
    this.refreshMode();
  }

  private handleJoinError(reason: JoinErrorReason): void {
    this.joinFailure = reason;
    if (this.expectedJoinError === reason) {
      this.expectedErrorReceived = true;
      this.status = "error";
      this.stopTimer();
      this.connection?.close();
      return;
    }
    if (reason === "expired" && this.session !== null && !this.fellBack) {
      // FR-5.5: an expired reservation falls back to a fresh join with the
      // credentials the bot was started with (token or PIN).
      this.fellBack = true;
      this.session = null;
      this.expectedSlot = null;
      if (this.connection !== null && this.socketOpen) {
        this.status = "connecting";
        this.sendJoin();
      } else {
        this.reconnectAttempt = 1;
        this.scheduleReconnect();
      }
      return;
    }
    this.failureReasons.push(`joinError:${reason}`);
    this.status = "error";
    this.stopTimer();
    this.connection?.close();
  }

  private handleKick(reason: string): void {
    this.failureReasons.push(`kick:${reason}`);
    this.status = "closed";
    this.stopTimer();
    this.cancelReconnectTimer();
    this.cancelSuspendTimer();
    this.cancelRetryTimer();
    this.connection?.close();
  }

  private handleBinary(payload: Uint8Array): void {
    this.lastServerMessageAt = this.scheduler.now();
    if (frameType(payload) !== MSG.Pong) return;
    let clientTimeMs: number;
    try {
      clientTimeMs = decodePong(payload).clientTimeMs;
    } catch {
      this.drops += 1;
      return;
    }
    const sentAt = this.pingSentAt.get(clientTimeMs);
    if (sentAt === undefined) return;
    this.pingSentAt.delete(clientTimeMs);
    const rtt = this.scheduler.now() - sentAt;
    if (rtt >= 0) this.rtts.push(rtt);
  }

  private handleClose(code: number, reason: string): void {
    this.clearPendingSends();
    this.stopTimer();
    this.cancelSuspendTimer();
    this.cancelRetryTimer();
    this.socketOpen = false;
    this.connection = null;
    const wasJoinedOnSocket = this.joinedThisSocket;
    this.joinedThisSocket = false;
    if (
      this.stopping ||
      this.status === "error" ||
      this.status === "closed" ||
      this.status === "reconnecting"
    ) {
      return;
    }
    // A reconnect attempt that died before rejoining keeps escalating the
    // backoff (FR-7.15) instead of restarting at 250 ms.
    if (wasJoinedOnSocket === false && this.reconnectAttempt > 0 && this.autoReconnect) {
      this.reconnectAttempt += 1;
      this.scheduleReconnect();
      return;
    }
    if (!this.hasJoined) {
      this.status = "closed";
      this.lastError ??= `socket closed before join (${code}${
        reason.length > 0 ? `: ${reason}` : ""
      })`;
      return;
    }
    if (this.autoReconnect) {
      this.reconnectAttempt = 1;
      this.reconnectCount += 1;
      this.scheduleReconnect();
      return;
    }
    this.status = "closed";
  }

  /** Active while macro actions remain or the state is non-neutral. */
  private isActive(): boolean {
    const macrosPending =
      this.macros.length > 0 &&
      (this.macroLoopMs !== null || this.macroIndex < this.macros.length);
    return (
      macrosPending ||
      this.level !== 0 ||
      this.pendingEdges !== 0 ||
      this.axes.lx !== 0 ||
      this.axes.ly !== 0 ||
      this.axes.rx !== 0 ||
      this.axes.ry !== 0
    );
  }

  private refreshMode(): void {
    if (this.status !== "joined") return;
    const desired: TimerMode = this.isActive() ? "active" : "idle";
    if (this.timer !== null && this.timerMode === desired) return;
    this.stopTimer();
    this.timerMode = desired;
    const intervalMs = desired === "active" ? this.activeTickMs : this.idleTickMs;
    this.timer = this.scheduler.setInterval(() => this.tick(), intervalMs);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    this.timerMode = null;
  }

  private tick(): void {
    if (this.status !== "joined") return;
    const now = this.scheduler.now();
    this.elapsedMs = now - this.macroStartMs;
    this.applyDueMacros();

    const state: InputState = {
      tick: (this.serverTime + Math.trunc(now - this.joinedAtMs)) >>> 0,
      buttons: this.level,
      edges: this.pendingEdges,
      lx: this.axes.lx,
      ly: this.axes.ly,
      rx: this.axes.rx,
      ry: this.axes.ry,
      gx: 0,
      gy: 0,
      gz: 0,
      lt: 0,
      rt: 0,
      flags: 0,
    };

    this.emitInput(state);
    this.maybePing(now);
    this.checkPeriodic(now);
    if (this.status !== "joined") return;
    this.checkWatchdog(now);
    if (this.status !== "joined") return;
    this.refreshMode();
  }

  /**
   * Sends one Input frame, optionally delayed by jitter and optionally lost.
   * `--loss` never drops a frame carrying press edges (FR-7.3 semantics stay
   * meaningful under simulation).
   */
  private emitInput(state: InputState): void {
    const connection = this.connection;
    if (connection === null) {
      this.drops += 1;
      return;
    }
    if (state.edges === 0 && this.loss > 0 && this.random() < this.loss) {
      this.lost += 1;
      return;
    }

    const delayMs = this.jitterMs > 0 ? this.random() * this.jitterMs : 0;
    const frame = encodeInput(state);
    if (delayMs <= 0 || this.scheduler.setTimeout === undefined) {
      if (connection.send(frame)) {
        this.sent += 1;
        if (state.edges !== 0) this.edgeFrames += 1;
        this.pendingEdges = 0;
      } else {
        this.drops += 1;
      }
      return;
    }

    const handle = this.scheduleOnce(() => {
      this.pendingSends.delete(handle);
      if (connection.send(frame)) {
        this.sent += 1;
        if (state.edges !== 0) this.edgeFrames += 1;
      } else {
        this.drops += 1;
      }
    }, delayMs);
    this.pendingSends.add(handle);
    // The frame is committed; a later press sets a fresh edge bit.
    this.pendingEdges = 0;
  }

  private applyDueMacros(): void {
    if (this.macros.length === 0) return;
    let localMs = this.elapsedMs - this.macroEpochMs;
    if (this.macroLoopMs !== null && localMs >= this.macroLoopMs) {
      const cycles = Math.floor(localMs / this.macroLoopMs);
      this.macroEpochMs += cycles * this.macroLoopMs;
      this.macroIndex = 0;
      localMs = this.elapsedMs - this.macroEpochMs;
    }
    while (this.macroIndex < this.macros.length) {
      const action = this.macros[this.macroIndex];
      if (action === undefined || action.atMs > localMs) break;
      this.macroIndex += 1;
      switch (action.type) {
        case "press": {
          for (const button of action.buttons) {
            const bit = 1 << BUTTON_BITS[button];
            this.level = (this.level | bit) & 0xffff;
            this.pendingEdges = (this.pendingEdges | bit) & 0xffff;
          }
          break;
        }
        case "release": {
          for (const button of action.buttons) {
            const bit = 1 << BUTTON_BITS[button];
            this.level &= ~bit & 0xffff;
          }
          break;
        }
        case "axis": {
          this.axes = {
            lx: action.lx ?? this.axes.lx,
            ly: action.ly ?? this.axes.ly,
            rx: action.rx ?? this.axes.rx,
            ry: action.ry ?? this.axes.ry,
          };
          break;
        }
      }
    }
  }

  private maybePing(now: number): void {
    if (now - this.lastPingAt < this.pingIntervalMs) return;
    this.lastPingAt = now;
    const clientTimeMs = Math.trunc(now) >>> 0;
    this.pingSentAt.set(clientTimeMs, now);
    if (this.pingSentAt.size > 64) {
      const oldest = this.pingSentAt.keys().next().value;
      if (oldest !== undefined) this.pingSentAt.delete(oldest);
    }
    if (this.connection?.send(encodePing(clientTimeMs)) === true) {
      this.pings += 1;
    }
  }

  private checkPeriodic(now: number): void {
    if (
      this.reconnectEveryMs !== null &&
      this.nextReconnectAt !== null &&
      now >= this.nextReconnectAt
    ) {
      this.startReconnectCycle();
      return;
    }
    if (
      this.suspendEveryMs !== null &&
      this.nextSuspendAt !== null &&
      now >= this.nextSuspendAt
    ) {
      this.beginSuspend();
      return;
    }
    if (this.churnEveryMs !== null && this.nextChurnAt !== null && now >= this.nextChurnAt) {
      this.beginChurn();
    }
  }

  /** FR-7.14: the bot's own silent-socket guard, mirroring the controller. */
  private checkWatchdog(now: number): void {
    if (this.watchdogMs <= 0) return;
    if (now - this.lastServerMessageAt <= this.watchdogMs) return;
    this.watchdogTrips += 1;
    this.startReconnectCycle();
  }

  /** FR-7.15 / FR-5.4: close, back off, then rejoin with the session token. */
  private startReconnectCycle(): void {
    this.stopTimer();
    this.cancelSuspendTimer();
    this.cancelRetryTimer();
    this.cancelReconnectTimer();
    this.clearPendingSends();
    const connection = this.connection;
    this.connection = null;
    this.socketOpen = false;
    this.status = "reconnecting";
    connection?.close();
    this.reconnectAttempt = 1;
    this.reconnectCount += 1;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.cancelReconnectTimer();
    this.status = "reconnecting";
    const delayMs = reconnectBackoffMs(this.reconnectAttempt, this.random);
    this.reconnectTimer = this.scheduleOnce(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delayMs);
  }

  /** Sends `suspend`, waits, then rejoins without freeing the slot. */
  private beginSuspend(): void {
    this.suspendCount += 1;
    this.stopTimer();
    this.clearPendingSends();
    this.status = "suspended";
    this.connection?.send(stringifyJsonMessage({ t: "suspend" }));
    this.suspendTimer = this.scheduleOnce(() => {
      this.suspendTimer = null;
      this.rejoinAfterSuspend();
    }, this.suspendResumeDelayMs);
  }

  private rejoinAfterSuspend(): void {
    if (this.stopping || this.status !== "suspended") return;
    if (this.connection !== null && this.socketOpen) {
      this.status = "connecting";
      this.sendJoin();
      // If the server rejects a rejoin on the old socket, recover with a
      // normal reconnect; both paths end at the same reserved slot.
      this.retryTimer = this.scheduleOnce(() => {
        this.retryTimer = null;
        if (this.status === "connecting") this.startReconnectCycle();
      }, Math.max(2000, this.suspendResumeDelayMs));
      return;
    }
    this.startReconnectCycle();
  }

  /** Explicit leave then a fresh join; the session token is not reused. */
  private beginChurn(): void {
    this.churnCount += 1;
    this.stopTimer();
    this.clearPendingSends();
    this.connection?.send(stringifyJsonMessage({ t: "leave" }));
    const connection = this.connection;
    this.connection = null;
    this.socketOpen = false;
    this.session = null;
    this.expectedSlot = null;
    this.hasJoined = false;
    this.joinedThisSocket = false;
    this.status = "reconnecting";
    connection?.close();
    this.reconnectAttempt = 1;
    this.reconnectCount += 1;
    this.scheduleReconnect();
  }

  private scheduleOnce(callback: () => void, delayMs: number): unknown {
    const timeout = this.scheduler.setTimeout;
    if (timeout !== undefined) {
      return timeout.call(this.scheduler, callback, delayMs);
    }
    // Minimal schedulers without setTimeout (D0 test doubles) get an interval
    // that clears itself. Frames cannot be jittered on such a scheduler.
    const handle = this.scheduler.setInterval(() => {
      this.scheduler.clearInterval(handle);
      callback();
    }, delayMs);
    return handle;
  }

  private cancelOnce(handle: unknown | null): void {
    if (handle === null) return;
    const clearTimeoutFn = this.scheduler.clearTimeout;
    if (clearTimeoutFn !== undefined) clearTimeoutFn.call(this.scheduler, handle);
    this.scheduler.clearInterval(handle);
  }

  private cancelReconnectTimer(): void {
    this.cancelOnce(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private cancelSuspendTimer(): void {
    this.cancelOnce(this.suspendTimer);
    this.suspendTimer = null;
  }

  private cancelRetryTimer(): void {
    this.cancelOnce(this.retryTimer);
    this.retryTimer = null;
  }

  private clearPendingSends(): void {
    for (const handle of this.pendingSends) this.cancelOnce(handle);
    this.pendingSends.clear();
  }
}

/** Creates `count` independent bots (1..MAX_CONTROLLERS), each with its own socket. */
export function createBots(options: BotOptions, count: number): Bot[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_CONTROLLERS) {
    throw new BotConfigError(`clients must be an integer in 1..${MAX_CONTROLLERS}`);
  }
  return Array.from({ length: count }, (_, index) => new Bot({ ...options, index }));
}

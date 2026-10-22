/**
 * D4-EXP-01 probe transport: Ping/Pong bursts, room join and session rejoin.
 *
 * Every function takes its WebSocket constructor and clocks as arguments, so
 * the Node tests drive it with `ws` or a fake. The page module (`page.ts`)
 * supplies `window.WebSocket`, `performance.now()` and the document/window
 * event targets. Statistics live in `stats.ts`.
 *
 * Wire notes (packages/protocol/src/binary.ts, frozen in D0):
 *   Ping  0x03, 5 bytes: type + u32 clientTimeMs (little-endian)
 *   Pong  0x82, 9 bytes: type + u32 clientTimeMs + u32 serverTimeMs
 * The server echoes `clientTimeMs` untouched and answers any open socket, so
 * the probe puts a sequence number there to match each Pong to its Ping with
 * sub-millisecond local timestamps. Joining is not required for Ping.
 */

import {
  PROBE_PROTOCOL_VERSION,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../e01/probe.js";
import { ProbeError, errorMessage } from "../shared/probe.js";
import { unwrapU32, type ClockSample, type LifecycleEvent, type RecoveryAttempt } from "./stats.js";

export const PING_TYPE = 0x03;
export const PONG_TYPE = 0x82;
export const PING_FRAME_BYTES = 5;
export const PONG_FRAME_BYTES = 9;

const DEFAULT_TIMEOUT_MS = 5000;
/** How long to wait for stragglers after the last Ping before counting loss. */
export const DEFAULT_PONG_GRACE_MS = 1000;
const OPEN = 1;

/* ------------------------------------------------------------------ */
/* Ping / Pong codecs (probe copies; tests cross-check packages/protocol) */
/* ------------------------------------------------------------------ */

export function encodeProbePing(clientTimeMs: number): Uint8Array {
  const frame = new Uint8Array(PING_FRAME_BYTES);
  frame[0] = PING_TYPE;
  new DataView(frame.buffer).setUint32(1, clientTimeMs >>> 0, true);
  return frame;
}

/** Returns null for any frame that is not a well-formed Pong. */
export function decodeProbePong(
  frame: Uint8Array,
): { clientTimeMs: number; serverTimeMs: number } | null {
  if (frame.byteLength !== PONG_FRAME_BYTES || frame[0] !== PONG_TYPE) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { clientTimeMs: view.getUint32(1, true), serverTimeMs: view.getUint32(5, true) };
}

/* ------------------------------------------------------------------ */
/* Socket plumbing                                                     */
/* ------------------------------------------------------------------ */

function eventData(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "data" in event) {
    return (event as { data?: unknown }).data;
  }
  return undefined;
}

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function openSocket(
  WebSocketCtor: WebSocketConstructor,
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<WebSocketLike> {
  return new Promise((resolve, reject) => {
    let socket: WebSocketLike;
    try {
      socket = new WebSocketCtor(url);
    } catch (error) {
      reject(new ProbeError(`WebSocket construction failed: ${errorMessage(error)}`));
      return;
    }
    socket.binaryType = "arraybuffer";
    const finish = (error: ProbeError | null): void => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      if (error === null) resolve(socket);
      else reject(error);
    };
    const onOpen = (): void => finish(null);
    const onError = (): void =>
      finish(new ProbeError("WebSocket failed to open; use a dev-server URL whose Origin is allowed"));
    const timer = setTimeout(
      () => finish(new ProbeError(`WebSocket did not open within ${timeoutMs} ms`)),
      timeoutMs,
    );
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

export function closeQuietly(socket: WebSocketLike | null): void {
  if (socket === null) return;
  try {
    socket.close();
  } catch {
    // Already closed or never opened.
  }
}

interface ControlMessage {
  t?: unknown;
  slot?: unknown;
  session?: unknown;
  reason?: unknown;
}

/** Waits for the JSON control message `expected`; `joinError` rejects. */
function waitForControl(
  socket: WebSocketLike,
  expected: "joined" | "hostJoined",
  timeoutMs: number,
): Promise<ControlMessage> {
  return new Promise((resolve, reject) => {
    const finish = (error: ProbeError | null, message?: ControlMessage): void => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      if (error === null) resolve(message as ControlMessage);
      else reject(error);
    };
    const onMessage = (event: unknown): void => {
      const data = eventData(event);
      // Browsers and `ws` 8 deliver text frames as strings; binary frames are never control.
      if (typeof data !== "string") return;
      let message: ControlMessage;
      try {
        message = JSON.parse(data) as ControlMessage;
      } catch {
        return;
      }
      if (message.t === "joinError") {
        finish(new ProbeError(`${expected} rejected: ${String(message.reason)}`));
      } else if (message.t === expected) {
        finish(null, message);
      }
    };
    const onClose = (): void => finish(new ProbeError(`socket closed before ${expected}`));
    const timer = setTimeout(
      () => finish(new ProbeError(`timed out after ${timeoutMs} ms waiting for ${expected}`)),
      timeoutMs,
    );
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
  });
}

/* ------------------------------------------------------------------ */
/* Ping series (E4) and clock bursts (E9)                              */
/* ------------------------------------------------------------------ */

export interface PingSeriesOptions {
  count: number;
  intervalMs: number;
  /** Date-compatible client clock with sub-ms resolution (timeOrigin + performance.now()). */
  clientClock: () => number;
  /** Optional same-machine truth: `Date.now() + 0.5 - clientClock()`. */
  truthOffset?: () => number;
  graceMs?: number;
  /** First sequence number echoed in `clientTimeMs`. */
  firstSeq?: number;
}

export interface PingSeriesResult {
  sent: number;
  /** One entry per Pong, in arrival order. */
  samples: ClockSample[];
  rttMs: number[];
}

/**
 * Sends `count` Pings at `intervalMs` spacing and collects matching Pongs.
 * Pongs that do not arrive within `graceMs` after the last Ping count as loss.
 */
export async function runPingSeries(
  socket: WebSocketLike,
  options: PingSeriesOptions,
): Promise<PingSeriesResult> {
  const graceMs = options.graceMs ?? DEFAULT_PONG_GRACE_MS;
  const firstSeq = options.firstSeq ?? 1;
  const pending = new Map<number, number>();
  const samples: ClockSample[] = [];
  const rttMs: number[] = [];
  let resolveDrained: (() => void) | null = null;
  let closed = false;

  const onMessage = (event: unknown): void => {
    const bytes = bytesOf(eventData(event));
    if (bytes === null) return;
    const pong = decodeProbePong(bytes);
    if (pong === null) return;
    const sentAt = pending.get(pong.clientTimeMs);
    if (sentAt === undefined) return;
    pending.delete(pong.clientTimeMs);
    const receivedAt = options.clientClock();
    const sample: ClockSample = {
      sentClientMs: sentAt,
      receivedClientMs: receivedAt,
      serverMs: unwrapU32(pong.serverTimeMs, receivedAt),
    };
    if (options.truthOffset !== undefined) sample.truthOffsetMs = options.truthOffset();
    samples.push(sample);
    rttMs.push(receivedAt - sentAt);
    if (pending.size === 0 && resolveDrained !== null) resolveDrained();
  };
  const onClose = (): void => {
    closed = true;
    if (resolveDrained !== null) resolveDrained();
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);

  let sent = 0;
  try {
    for (let index = 0; index < options.count && !closed; index += 1) {
      const seq = (firstSeq + index) >>> 0;
      pending.set(seq, options.clientClock());
      socket.send(encodeProbePing(seq));
      sent += 1;
      if (index < options.count - 1) await sleep(options.intervalMs);
    }
    if (pending.size > 0 && !closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        resolveDrained = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
  }
  return { sent, samples, rttMs };
}

/* ------------------------------------------------------------------ */
/* Rooms and controller sessions (G1, E15)                             */
/* ------------------------------------------------------------------ */

export interface JoinMarks {
  socketOpenMs: number;
  joinSentMs: number;
  joinedMs: number;
}

export interface JoinedController {
  socket: WebSocketLike;
  slot: number;
  session: string;
  marks: JoinMarks;
}

export interface JoinOptions {
  WebSocketCtor: WebSocketConstructor;
  url: string;
  code: string;
  /** Exactly one credential: PIN for a first join, session for a rejoin. */
  credential: { pin: string } | { session: string };
  now: () => number;
  timeoutMs?: number;
  /** Reuse an open socket (same-socket rejoin, FR-8.8). */
  socket?: WebSocketLike;
}

function requireSlotAndSession(message: ControlMessage): { slot: number; session: string } {
  if (typeof message.slot !== "number" || !Number.isInteger(message.slot)) {
    throw new ProbeError("joined did not carry an integer slot");
  }
  if (typeof message.session !== "string" || message.session.length === 0) {
    throw new ProbeError("joined did not carry a session");
  }
  return { slot: message.slot, session: message.session };
}

/** Joins as a controller. Callers must keep the PIN and session out of results. */
export async function joinController(options: JoinOptions): Promise<JoinedController> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socket = options.socket ?? (await openSocket(options.WebSocketCtor, options.url, timeoutMs));
  const socketOpenMs = options.now();
  try {
    const joined = waitForControl(socket, "joined", timeoutMs);
    const joinSentMs = options.now();
    socket.send(
      JSON.stringify({
        t: "join",
        v: PROBE_PROTOCOL_VERSION,
        code: options.code,
        ...options.credential,
      }),
    );
    const message = await joined;
    const joinedMs = options.now();
    return {
      socket,
      ...requireSlotAndSession(message),
      marks: { socketOpenMs, joinSentMs, joinedMs },
    };
  } catch (error) {
    if (options.socket === undefined) closeQuietly(socket);
    throw error;
  }
}

/** Opens the in-page host socket for a self-hosted room. */
export async function hostRoom(
  WebSocketCtor: WebSocketConstructor,
  url: string,
  code: string,
  hostToken: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<WebSocketLike> {
  const socket = await openSocket(WebSocketCtor, url, timeoutMs);
  try {
    const joined = waitForControl(socket, "hostJoined", timeoutMs);
    socket.send(JSON.stringify({ t: "hostJoin", v: PROBE_PROTOCOL_VERSION, code, hostToken }));
    await joined;
    return socket;
  } catch (error) {
    closeQuietly(socket);
    throw error;
  }
}

/**
 * A joined controller that follows FR-8.8 across visibility changes: on hidden
 * it sends `suspend` (the socket is left for the OS to keep or kill); on
 * visible it rejoins with its session, on the same socket if it survived,
 * otherwise on a new one. Each rejoin is recorded as a `RecoveryAttempt`.
 */
export class ControllerSession {
  readonly recoveries: RecoveryAttempt[] = [];
  private rejoining: Promise<void> | null = null;

  constructor(
    private controller: JoinedController,
    private readonly code: string,
    private readonly WebSocketCtor: WebSocketConstructor,
    private readonly url: string,
    private readonly now: () => number,
  ) {}

  get slot(): number {
    return this.controller.slot;
  }

  suspend(): void {
    if (this.controller.socket.readyState !== OPEN) return;
    try {
      this.controller.socket.send(JSON.stringify({ t: "suspend" }));
    } catch {
      // The OS may already have torn the socket down.
    }
  }

  rejoin(): Promise<void> {
    if (this.rejoining !== null) return this.rejoining;
    const sameSocket = this.controller.socket.readyState === OPEN;
    const attempt: RecoveryAttempt = {
      startedAtMs: this.now(),
      joinedAtMs: null,
      path: sameSocket ? "same-socket" : "new-socket",
      expectedSlot: this.controller.slot,
      slot: null,
      error: null,
    };
    this.recoveries.push(attempt);
    const options: JoinOptions = {
      WebSocketCtor: this.WebSocketCtor,
      url: this.url,
      code: this.code,
      credential: { session: this.controller.session },
      now: this.now,
    };
    if (sameSocket) options.socket = this.controller.socket;
    else closeQuietly(this.controller.socket);
    this.rejoining = joinController(options)
      .then((joined) => {
        attempt.joinedAtMs = joined.marks.joinedMs;
        attempt.slot = joined.slot;
        this.controller = joined;
      })
      .catch((error: unknown) => {
        attempt.error = errorMessage(error);
      })
      .then(() => {
        this.rejoining = null;
      });
    return this.rejoining;
  }

  /** Sends `leave` and closes, freeing the slot immediately. */
  leave(): void {
    if (this.controller.socket.readyState === OPEN) {
      try {
        this.controller.socket.send(JSON.stringify({ t: "leave" }));
      } catch {
        // Closing below is enough.
      }
    }
    closeQuietly(this.controller.socket);
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle recorder (E15)                                            */
/* ------------------------------------------------------------------ */

export interface EventTargetLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export interface LifecycleScope {
  document: EventTargetLike & { visibilityState: string };
  window: EventTargetLike;
}

export interface LifecycleHooks {
  onHidden?: () => void;
  onVisible?: () => void;
}

function persistedOf(event: unknown): boolean | undefined {
  if (typeof event === "object" && event !== null && "persisted" in event) {
    const persisted = (event as { persisted?: unknown }).persisted;
    return typeof persisted === "boolean" ? persisted : undefined;
  }
  return undefined;
}

/**
 * Starts recording visibilitychange, pagehide/pageshow and freeze/resume with
 * monotonic timestamps. Only called from a Run click, never on page load.
 */
export function recordLifecycle(
  scope: LifecycleScope,
  now: () => number,
  hooks: LifecycleHooks = {},
): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  scope.document.addEventListener("visibilitychange", () => {
    const hidden = scope.document.visibilityState === "hidden";
    events.push({ type: hidden ? "hidden" : "visible", atMs: now() });
    if (hidden) hooks.onHidden?.();
    else hooks.onVisible?.();
  });
  scope.document.addEventListener("freeze", () => events.push({ type: "freeze", atMs: now() }));
  scope.document.addEventListener("resume", () => events.push({ type: "resume", atMs: now() }));
  for (const type of ["pagehide", "pageshow"] as const) {
    scope.window.addEventListener(type, (event) => {
      const entry: LifecycleEvent = { type, atMs: now() };
      const persisted = persistedOf(event);
      if (persisted !== undefined) entry.persisted = persisted;
      events.push(entry);
    });
  }
  return events;
}

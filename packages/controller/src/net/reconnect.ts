/**
 * Controller reconnect state machine (D4-CTRL-02; FR-5.4, FR-5.5, FR-7.14, FR-7.15).
 *
 * A dropped controller must reclaim its own slot, not join the room again with
 * the shared QR token. This module therefore owns the retry timetable only:
 *
 * - socket close → exponential backoff 250 ms × 2^n, capped at 4 s, ±20% jitter;
 * - every attempt reads the persisted session for the room and emits exactly
 *   `join {v, code, session}` (FR-5.4); the room token is never used here;
 * - any server frame resets a 7 s silence watchdog (the D0 heartbeat already
 *   terminates the socket after 5 s; this catches a blackholed connection that
 *   never produces a close event — FR-7.14);
 * - `joinError expired` stops the machine so the join flow can fall back to a
 *   new join or the manual form (FR-5.5).
 *
 * The socket itself stays with the caller: `onJoin`, `onStaleSocket` and
 * `onStop` are the only side effects. That keeps this file free of DOM and
 * WebSocket types, fully deterministic under injected timers, and usable by
 * the D2 `ControllerClient` without duplicating its socket ownership. Games
 * never see this module.
 */
import { PROTOCOL_VERSION } from "@lanpad/protocol";
import type { ClientToServerMessage, JoinErrorReason } from "@lanpad/protocol";
import type { SessionStore } from "../join/sessionStore.js";

/** First retry delay (FR-7.15). */
export const RECONNECT_BASE_DELAY_MS = 250;

/** Backoff cap (FR-7.15). */
export const RECONNECT_MAX_DELAY_MS = 4_000;

/** ±20% jitter around the nominal delay. */
export const RECONNECT_JITTER_RATIO = 0.2;

/**
 * Controller-side silence timeout. The server pings every 2 s and drops the
 * peer after 5 s; waiting 7 s gives the close event time to arrive before the
 * controller declares the socket dead itself (FR-7.14).
 */
export const SERVER_SILENCE_TIMEOUT_MS = 7_000;

/** The only join shape a reconnect attempt produces. */
export type ReconnectJoin = Extract<ClientToServerMessage, { t: "join" }>;

/** Where the machine currently is. */
export type ReconnectPhase = "idle" | "waiting" | "connecting" | "connected" | "stopped";

/** Why reconnect stopped for good. */
export type ReconnectStopReason = "left" | "kicked" | "expired" | "rejected" | "noSession";

export interface ReconnectState {
  phase: ReconnectPhase;
  /** Retry index; 0 is the first retry after the drop. */
  attempt: number;
  /** Slot from the last `joined`; kept while reconnecting (FR-5.4). */
  slot: number | null;
  /** Delay armed for `waiting`, 0 otherwise. */
  delayMs: number;
  /** Set only in the `stopped` phase. */
  stopReason: ReconnectStopReason | null;
}

/** Timeout surface; tests inject a fake so the sequence is deterministic. */
export interface ReconnectTimers {
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(handle: number): void;
}

export interface ReconnectDeps {
  /** Persisted per-room session; read on every attempt (never cached). */
  store: SessionStore;
  /** Room code the session belongs to. */
  code: string;
  timers?: ReconnectTimers;
  /** Jitter source in [0, 1); injection point for deterministic tests. */
  random?: () => number;
  /**
   * Called for each retry with the exact `join {session}` message. The caller
   * opens a fresh socket (or reuses one) and sends it.
   */
  onJoin: (message: ReconnectJoin) => void;
  /** The watchdog fired: close the current socket; its close event is ignored. */
  onStaleSocket?: () => void;
  onState?: (state: ReconnectState) => void;
  /** Terminal transition, including explicit leave/kick. */
  onStop?: (reason: ReconnectStopReason) => void;
}

const defaultTimers: ReconnectTimers = {
  setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

/**
 * Nominal + jittered delay for retry `attempt` (FR-7.15). The cap applies
 * after jitter, so the machine never waits longer than 4 s.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  const nominal = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.min(safeAttempt, 16),
    RECONNECT_MAX_DELAY_MS,
  );
  const jitter = (random() * 2 - 1) * RECONNECT_JITTER_RATIO;
  const delay = Math.round(nominal * (1 + jitter));
  return Math.min(RECONNECT_MAX_DELAY_MS, Math.max(0, delay));
}

const INITIAL_STATE: ReconnectState = {
  phase: "idle",
  attempt: 0,
  slot: null,
  delayMs: 0,
  stopReason: null,
};

export class ReconnectController {
  private readonly store: SessionStore;
  private readonly code: string;
  private readonly timers: ReconnectTimers;
  private readonly random: () => number;
  private readonly onJoin: (message: ReconnectJoin) => void;
  private readonly onStaleSocket: (() => void) | undefined;
  private readonly onState: ((state: ReconnectState) => void) | undefined;
  private readonly onStop: ((reason: ReconnectStopReason) => void) | undefined;

  private current: ReconnectState = { ...INITIAL_STATE };
  private retryHandle: number | null = null;
  private watchdogHandle: number | null = null;

  constructor(deps: ReconnectDeps) {
    this.store = deps.store;
    this.code = deps.code;
    this.timers = deps.timers ?? defaultTimers;
    this.random = deps.random ?? Math.random;
    this.onJoin = deps.onJoin;
    this.onStaleSocket = deps.onStaleSocket;
    this.onState = deps.onState;
    this.onStop = deps.onStop;
  }

  get state(): ReconnectState {
    return this.current;
  }

  /**
   * The server accepted a join (first join or a session rejoin). Backoff is
   * reset and the silence watchdog armed (FR-7.14).
   */
  onConnected(slot: number): void {
    if (this.current.phase === "stopped") {
      return;
    }
    this.clearRetry();
    this.current = { phase: "connected", attempt: 0, slot, delayMs: 0, stopReason: null };
    this.emit();
    this.armWatchdog();
  }

  /**
   * Any server frame arrived (`joined`, `hostStatus`, `stats`, a pong…). The
   * socket is alive; push the watchdog forward (FR-7.14).
   */
  onServerActivity(): void {
    if (this.current.phase !== "connected") {
      return;
    }
    this.armWatchdog();
  }

  /**
   * The socket closed without an explicit leave or kick. A connected client
   * starts the retry sequence; a retry that closed before `joined` counts as a
   * failed attempt.
   */
  onDisconnected(): void {
    switch (this.current.phase) {
      case "connected":
        this.clearWatchdog();
        this.scheduleNext(0);
        return;
      case "connecting":
        this.scheduleNext(this.current.attempt + 1);
        return;
      case "idle":
      case "waiting":
      case "stopped":
        return;
    }
  }

  /** The retry socket could not be opened or gave up before `joined`. */
  onAttemptFailed(): void {
    if (this.current.phase !== "connecting") {
      return;
    }
    this.scheduleNext(this.current.attempt + 1);
  }

  /**
   * `joinError` for a retry. `expired` means the 30 s reservation is gone and
   * the join flow must take over (FR-5.5); every other refusal is terminal for
   * reconnect rather than an endless loop.
   */
  onJoinRejected(reason: JoinErrorReason): void {
    if (this.current.phase !== "connecting" && this.current.phase !== "waiting") {
      return;
    }
    this.stop(reason === "expired" ? "expired" : "rejected");
  }

  /**
   * Explicit leave, a kick, or a terminal join error. Clears every timer; no
   * further attempts are made even if a stale socket closes later.
   */
  stop(reason: ReconnectStopReason = "left"): void {
    if (this.current.phase === "stopped") {
      return;
    }
    this.clearRetry();
    this.clearWatchdog();
    this.current = {
      phase: "stopped",
      attempt: this.current.attempt,
      slot: this.current.slot,
      delayMs: 0,
      stopReason: reason,
    };
    this.emit();
    this.onStop?.(reason);
  }

  /** Arms the next retry. `attempt` is the index whose delay is used. */
  private scheduleNext(attempt: number): void {
    this.clearRetry();
    this.clearWatchdog();
    const delayMs = reconnectDelayMs(attempt, this.random);
    this.current = {
      phase: "waiting",
      attempt,
      slot: this.current.slot,
      delayMs,
      stopReason: null,
    };
    this.emit();
    this.retryHandle = this.timers.setTimeout(() => {
      this.retryHandle = null;
      this.fireAttempt();
    }, delayMs);
  }

  /**
   * Sends `join {session}` for the stored record. A missing record means the
   * reservation cannot be reclaimed at all; the caller gets `noSession` and
   * shows the manual form instead of spinning.
   */
  private fireAttempt(): void {
    if (this.current.phase !== "waiting") {
      return;
    }
    const attempt = this.current.attempt;
    const stored = this.store.get(this.code);
    if (stored === null) {
      this.stop("noSession");
      return;
    }

    this.current = {
      phase: "connecting",
      attempt,
      slot: this.current.slot,
      delayMs: 0,
      stopReason: null,
    };
    this.emit();

    try {
      this.onJoin({
        t: "join",
        v: PROTOCOL_VERSION,
        code: this.code,
        session: stored.session,
      });
    } catch {
      this.scheduleNext(attempt + 1);
    }
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdogHandle = this.timers.setTimeout(this.handleWatchdog, SERVER_SILENCE_TIMEOUT_MS);
  }

  private readonly handleWatchdog = (): void => {
    this.watchdogHandle = null;
    if (this.current.phase !== "connected") {
      return;
    }
    // Move to `waiting` first: closing the socket synchronously must not start
    // a second retry sequence from `onDisconnected`.
    this.scheduleNext(0);
    this.onStaleSocket?.();
  };

  private clearRetry(): void {
    if (this.retryHandle !== null) {
      this.timers.clearTimeout(this.retryHandle);
      this.retryHandle = null;
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogHandle !== null) {
      this.timers.clearTimeout(this.watchdogHandle);
      this.watchdogHandle = null;
    }
  }

  private emit(): void {
    this.onState?.(this.current);
  }
}

/** Convenience factory for the page shell and tests. */
export function createReconnectController(deps: ReconnectDeps): ReconnectController {
  return new ReconnectController(deps);
}

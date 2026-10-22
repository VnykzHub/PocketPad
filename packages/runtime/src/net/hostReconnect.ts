/**
 * Host session recovery (D4-HOST-02; FR-7.16, FR-9.2, A2).
 *
 * Wraps the existing `HostClient` so the TV can survive a refresh or a short
 * network gap:
 *
 * - stores exactly `{ code, hostToken }` in `sessionStorage` (never the room
 *   token, never in a URL or the DOM — FR-5.1, SR-9);
 * - on boot, resumes that session before creating a new room;
 * - after a socket close, retries with exponential backoff 250 ms → 4 s while
 *   the broker's 30 s lost-host window is open;
 * - treats `expired` and `badHostToken` as terminal, clears the stored
 *   session and lets the shell create a new room;
 * - mirrors tab visibility with `hostPause` / `hostResume` (FR-9.2).
 *
 * The class owns no socket and no DOM: tests inject the clock, timers and
 * storage. `HostClient` still owns the WebSocket and the host token.
 */
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  TOKEN_LENGTH,
  type HostToServerMessage,
  type JoinErrorReason,
} from "@lanpad/protocol";
import type { HostConnectionState, HostJoinResult } from "./hostClient.js";

/** sessionStorage key for the resumable host session. */
export const HOST_SESSION_STORAGE_KEY = "lanpad.hostSession";
/** Broker reservation window after the host socket drops (FR-7.16). */
export const HOST_LOST_WINDOW_MS = 30_000;
export const RECONNECT_INITIAL_BACKOFF_MS = 250;
export const RECONNECT_MAX_BACKOFF_MS = 4_000;

/** The only data kept across a host reload. */
export interface HostSession {
  readonly code: string;
  readonly hostToken: string;
}

/** Storage surface; `sessionStorage` satisfies it. */
export interface HostSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Recovery phases shown by `HostStatus` in the host UI. */
export type HostRecoveryState = "idle" | "connected" | "reconnecting" | "lost";

/** Outcome of `resumeStored()` at boot. */
export type HostResumeResult = "resumed" | "none" | "recovering" | "terminal";

/** The `HostClient` surface recovery needs. */
export interface HostReconnectClient {
  readonly state: HostConnectionState;
  readonly lastJoinError: JoinErrorReason | null;
  connect(origin?: string): Promise<void>;
  hostJoin(code: string, hostToken: string): Promise<HostJoinResult>;
  send(message: HostToServerMessage): void;
}

export type HostRecoveryTimer = ReturnType<typeof setTimeout>;

export interface HostReconnectOptions {
  readonly client: HostReconnectClient;
  /** Defaults to no storage (the token still stays in memory). */
  readonly storage?: HostSessionStorage | null;
  /** WS origin; omitted means the client resolves the page origin. */
  readonly origin?: string;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => HostRecoveryTimer;
  readonly clearTimer?: (handle: HostRecoveryTimer) => void;
  readonly onStateChange?: (state: HostRecoveryState) => void;
  /** Fired after a reconnect succeeds (not after the initial join). */
  readonly onResumed?: (session: HostSession) => void;
  /** Fired once when the 30 s window closes or the token is terminal. */
  readonly onLost?: (session: HostSession) => void;
  readonly lostWindowMs?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

const BASE64URL_TOKEN = /^[A-Za-z0-9_-]+$/;

function isRoomCode(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== ROOM_CODE_LENGTH) {
    return false;
  }
  for (const character of value) {
    if (!ROOM_CODE_ALPHABET.includes(character)) {
      return false;
    }
  }
  return true;
}

function isHostToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === TOKEN_LENGTH &&
    BASE64URL_TOKEN.test(value)
  );
}

/** Reads and validates the stored session; corrupt data is ignored. */
export function readHostSession(storage: HostSessionStorage | null): HostSession | null {
  if (storage === null) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(HOST_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const code = record["code"];
    const hostToken = record["hostToken"];
    if (!isRoomCode(code) || !isHostToken(hostToken)) {
      return null;
    }
    return { code, hostToken };
  } catch {
    return null;
  }
}

/** Stores the session; storage failures are non-fatal (private mode). */
export function storeHostSession(
  storage: HostSessionStorage | null,
  session: HostSession,
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(
      HOST_SESSION_STORAGE_KEY,
      JSON.stringify({ code: session.code, hostToken: session.hostToken }),
    );
  } catch {
    // The session stays in memory; only reload recovery is affected.
  }
}

/** Removes the stored session (leave, expiry, kick). */
export function clearHostSession(storage: HostSessionStorage | null): void {
  if (storage === null) {
    return;
  }
  try {
    storage.removeItem(HOST_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage availability problems.
  }
}

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}

export class HostReconnect {
  private readonly client: HostReconnectClient;
  private readonly storage: HostSessionStorage | null;
  private readonly origin: string | undefined;
  private readonly clock: () => number;
  private readonly setTimerFn: (callback: () => void, delayMs: number) => HostRecoveryTimer;
  private readonly clearTimerFn: (handle: HostRecoveryTimer) => void;
  private readonly onStateChange: ((state: HostRecoveryState) => void) | undefined;
  private readonly onResumed: ((session: HostSession) => void) | undefined;
  private readonly onLost: ((session: HostSession) => void) | undefined;
  private readonly lostWindowMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private sessionValue: HostSession | null = null;
  private stateValue: HostRecoveryState = "idle";
  private deadlineMs: number | null = null;
  private backoffMs: number;
  private timer: HostRecoveryTimer | null = null;
  private attemptInFlight = false;
  private joinInFlight = false;
  private pausedValue = false;
  private disposed = false;

  constructor(options: HostReconnectOptions) {
    this.client = options.client;
    this.storage = options.storage ?? null;
    this.origin = options.origin;
    this.clock = options.now ?? (() => performance.now());
    this.setTimerFn =
      options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimerFn =
      options.clearTimer ??
      ((handle) => {
        clearTimeout(handle);
      });
    this.onStateChange = options.onStateChange;
    this.onResumed = options.onResumed;
    this.onLost = options.onLost;
    this.lostWindowMs = requirePositive(
      options.lostWindowMs ?? HOST_LOST_WINDOW_MS,
      "lostWindowMs",
    );
    this.initialBackoffMs = requirePositive(
      options.initialBackoffMs ?? RECONNECT_INITIAL_BACKOFF_MS,
      "initialBackoffMs",
    );
    this.maxBackoffMs = requirePositive(
      options.maxBackoffMs ?? RECONNECT_MAX_BACKOFF_MS,
      "maxBackoffMs",
    );
    this.backoffMs = this.initialBackoffMs;
  }

  get state(): HostRecoveryState {
    return this.stateValue;
  }

  get session(): HostSession | null {
    return this.sessionValue;
  }

  /** True while the host tab is hidden and `hostPause` is in effect. */
  get paused(): boolean {
    return this.pausedValue;
  }

  /**
   * Joins a known session. Rejects on failure; terminal token failures clear
   * the stored session so the shell can start over.
   */
  async join(session: HostSession): Promise<void> {
    this.assertNotDisposed();
    this.joinInFlight = true;
    const joined: HostSession = { code: session.code, hostToken: session.hostToken };
    this.sessionValue = joined;
    this.deadlineMs = null;
    this.backoffMs = this.initialBackoffMs;
    try {
      await this.connectAndJoin(joined);
    } catch (error) {
      this.joinInFlight = false;
      if (this.isTerminalJoinError()) {
        this.clearSession();
        this.setState("idle");
      }
      throw error;
    }
    this.joinInFlight = false;
    storeHostSession(this.storage, joined);
    this.setState("connected");
    if (this.pausedValue) {
      this.sendSafely({ t: "hostPause" });
    }
  }

  /**
   * Boot path: reads sessionStorage and resumes it. `recovering` means the
   * session was found but the first attempt failed; the class keeps retrying
   * inside the 30 s window and reports through `onResumed` / `onLost`.
   */
  async resumeStored(): Promise<HostResumeResult> {
    this.assertNotDisposed();
    const stored = readHostSession(this.storage);
    if (stored === null) {
      return "none";
    }
    try {
      await this.join(stored);
      return "resumed";
    } catch {
      if (this.session === null) {
        return "terminal";
      }
      this.beginRecovery();
      return "recovering";
    }
  }

  /**
   * Socket close: start (or continue) the 30 s recovery window. Ignored while
   * the initial `join()` is in flight or after a terminal loss, so the shell's
   * own retry path is not raced.
   */
  handleClose(): void {
    if (this.disposed || this.session === null || this.stateValue === "lost") {
      return;
    }
    if (this.joinInFlight) {
      return;
    }
    if (this.deadlineMs === null) {
      this.deadlineMs = this.clock() + this.lostWindowMs;
      this.backoffMs = this.initialBackoffMs;
      this.setState("reconnecting");
    }
    if (!this.attemptInFlight && this.timer === null) {
      this.schedule(this.backoffMs);
    }
  }

  /** Tab hidden: remember the pause and tell the broker (FR-9.2). */
  pauseForVisibility(): void {
    if (this.pausedValue || this.disposed) {
      return;
    }
    this.pausedValue = true;
    this.sendSafely({ t: "hostPause" });
  }

  /** Tab visible: tell the broker; the shell resumes its loop separately. */
  resumeForVisibility(): void {
    if (!this.pausedValue || this.disposed) {
      return;
    }
    this.pausedValue = false;
    this.sendSafely({ t: "hostResume" });
  }

  /**
   * Forgets the session (kick, explicit new room). A later socket close will
   * not start a reconnect.
   */
  forget(): void {
    this.clearTimer();
    this.clearSession();
    this.deadlineMs = null;
    this.backoffMs = this.initialBackoffMs;
    this.attemptInFlight = false;
    this.pausedValue = false;
    this.setState("idle");
  }

  /** Stops timers; the stored session is left alone for a page reload. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearTimer();
    this.attemptInFlight = false;
    this.joinInFlight = false;
    this.stateValue = "idle";
  }

  private async connectAndJoin(session: HostSession): Promise<void> {
    if (this.origin === undefined) {
      await this.client.connect();
    } else {
      await this.client.connect(this.origin);
    }
    await this.client.hostJoin(session.code, session.hostToken);
  }

  private beginRecovery(): void {
    if (this.deadlineMs === null) {
      this.deadlineMs = this.clock() + this.lostWindowMs;
    }
    this.backoffMs = this.initialBackoffMs;
    this.setState("reconnecting");
    if (!this.attemptInFlight && this.timer === null) {
      this.schedule(this.backoffMs);
    }
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = this.setTimerFn(() => {
      this.timer = null;
      void this.attempt();
    }, delayMs);
  }

  private async attempt(): Promise<void> {
    if (this.disposed || this.stateValue !== "reconnecting") {
      return;
    }
    const session = this.session;
    if (session === null) {
      return;
    }
    if (this.deadlineMs !== null && this.clock() >= this.deadlineMs) {
      this.lose(session);
      return;
    }

    this.attemptInFlight = true;
    try {
      await this.connectAndJoin(session);
    } catch {
      this.attemptInFlight = false;
      if (this.disposed || this.stateValue !== "reconnecting") {
        return;
      }
      if (this.isTerminalJoinError()) {
        this.lose(session);
        return;
      }
      if (this.deadlineMs !== null && this.clock() >= this.deadlineMs) {
        this.lose(session);
        return;
      }
      this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2);
      this.schedule(this.backoffMs);
      return;
    }

    this.attemptInFlight = false;
    this.deadlineMs = null;
    this.backoffMs = this.initialBackoffMs;
    storeHostSession(this.storage, session);
    this.setState("connected");
    if (this.pausedValue) {
      this.sendSafely({ t: "hostPause" });
    }
    this.onResumed?.(session);
  }

  private lose(session: HostSession): void {
    this.clearTimer();
    this.deadlineMs = null;
    this.attemptInFlight = false;
    this.clearSession();
    this.setState("lost");
    this.onLost?.(session);
  }

  private isTerminalJoinError(): boolean {
    const reason = this.client.lastJoinError;
    return reason === "expired" || reason === "badHostToken";
  }

  private clearSession(): void {
    clearHostSession(this.storage);
    this.sessionValue = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clearTimerFn(this.timer);
      this.timer = null;
    }
  }

  private setState(state: HostRecoveryState): void {
    if (this.stateValue === state) {
      return;
    }
    this.stateValue = state;
    this.onStateChange?.(state);
  }

  private sendSafely(message: HostToServerMessage): void {
    if (this.client.state !== "connected") {
      return;
    }
    try {
      this.client.send(message);
    } catch {
      // The broker pause state resets on the next hostJoin; we re-send then.
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("HostReconnect is disposed.");
    }
  }
}

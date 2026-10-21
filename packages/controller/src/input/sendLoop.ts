/**
 * Controller send policy (D2-CTRL-03; FR-7.1, FR-7.3, A3).
 *
 * The wire policy is frozen for every later game:
 * - any input change is sent immediately, but never more than once per 4 ms
 *   (bursts of touches and releases are coalesced into one packet);
 * - while any input is non-zero, send at 60 Hz;
 * - while idle, send a 10 Hz keepalive;
 * - a press edge always rides in the packet that follows it, and edges are
 *   cleared only after `send()` returned. If `send()` throws (socket not open),
 *   the level and edges are held for the next attempt.
 *
 * Every timer and clock read is injected so the policy is deterministic in
 * tests. `start()` only arms the cadence: D2-CTRL-04 calls `notifyChange()`
 * once after `joined` to emit the initial packet, which keeps that packet
 * inside the same 4 ms coalescing rule as every other send.
 */
import type { InputState } from "@lanpad/protocol";
import type { ClockSync } from "../net/clockSync.js";
import type { InputStore } from "./InputStore.js";

/** Minimum spacing between any two sends (SPEC §7.1 / FR-7.1). */
export const MIN_SEND_INTERVAL_MS = 4;

/** Active cadence: 60 Hz while any input is non-zero (FR-7.1). */
export const ACTIVE_SEND_INTERVAL_MS = 1000 / 60;

/** Idle keepalive: 10 Hz (FR-7.1). */
export const IDLE_SEND_INTERVAL_MS = 100;

export interface SendLoopDeps {
  store: InputStore;
  clock: ClockSync;
  send: (state: InputState) => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
}

function emptyInputState(): InputState {
  return {
    tick: 0,
    buttons: 0,
    edges: 0,
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
}

function isDocumentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

export class SendLoop {
  private readonly deps: SendLoopDeps;

  /**
   * The single InputState handed to `send()` on every packet (PR-9.3). It is
   * rewritten in place by `InputStore.snapshotInto()`; consumers must encode
   * or copy synchronously.
   */
  private readonly packet: InputState = emptyInputState();

  private running = false;
  private paused = false;
  private timerId: number | null = null;
  private deadline: number | null = null;
  private lastSendAtMs: number | null = null;
  private packetsSentCount = 0;
  private edgePacketsCount = 0;
  private visibilityAttached = false;

  constructor(deps: SendLoopDeps) {
    this.deps = deps;
  }

  /** Arms the send cadence. Does not send; the owner sends the first packet. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.attachVisibility();
    if (isDocumentHidden()) {
      this.paused = true;
      return;
    }
    this.paused = false;
    this.scheduleNext();
  }

  /** Stops all timers. Pending edges stay latched in the store for a restart. */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.paused = false;
    this.cancelTimer();
    this.detachVisibility();
  }

  /**
   * Requests an immediate packet. Inside the 4 ms window after the previous
   * send the request is coalesced: the packet goes out at the window edge with
   * every change made until then (FR-7.1).
   */
  notifyChange(): void {
    if (!this.running || this.paused) {
      return;
    }
    const now = this.deps.now();
    const earliest =
      this.lastSendAtMs === null
        ? now
        : this.lastSendAtMs + MIN_SEND_INTERVAL_MS;

    if (now >= earliest) {
      this.cancelTimer();
      this.sendNow();
      this.scheduleNext();
      return;
    }

    this.scheduleAt(earliest);
  }

  /** Debug counter: packets passed to `send()` successfully. */
  get packetsSent(): number {
    return this.packetsSentCount;
  }

  /** Debug counter: packets that carried a non-zero edge bitfield. */
  get edgePackets(): number {
    return this.edgePacketsCount;
  }

  /** Debug counter: milliseconds since the last successful send. */
  get lastSendAgeMs(): number {
    if (this.lastSendAtMs === null) {
      return Number.POSITIVE_INFINITY;
    }
    return this.deps.now() - this.lastSendAtMs;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  private readonly handleTimer = (): void => {
    this.timerId = null;
    this.deadline = null;
    if (!this.running || this.paused) {
      return;
    }
    this.sendNow();
    this.scheduleNext();
  };

  /**
   * Serialises the store into the reused packet, sends it, and only then
   * clears the edges. A thrown send holds the edges for the retry.
   */
  private sendNow(): void {
    const now = this.deps.now();
    const tickMs = this.deps.clock.serverNow(now);
    this.deps.store.snapshotInto(this.packet, tickMs);
    const carriesEdge = this.packet.edges !== 0;

    try {
      this.deps.send(this.packet);
    } catch {
      return;
    }

    this.deps.store.clearEdges();
    this.lastSendAtMs = now;
    this.packetsSentCount += 1;
    if (carriesEdge) {
      this.edgePacketsCount += 1;
    }
  }

  /** Chooses the active or idle period from the current level state. */
  private scheduleNext(): void {
    if (!this.running || this.paused) {
      return;
    }
    const now = this.deps.now();
    const interval = this.deps.store.hasActiveInput()
      ? ACTIVE_SEND_INTERVAL_MS
      : IDLE_SEND_INTERVAL_MS;
    const base = this.lastSendAtMs ?? now;
    const target = base + interval;
    // A late timer must not cause a catch-up burst: push the next deadline a
    // full interval past the current time instead.
    this.scheduleAt(target > now ? target : now + interval);
  }

  /** Arms the single timer at the earliest deadline; later deadlines lose. */
  private scheduleAt(deadline: number): void {
    if (!this.running || this.paused) {
      return;
    }
    if (this.timerId !== null) {
      if (this.deadline !== null && this.deadline <= deadline) {
        return;
      }
      this.cancelTimer();
    }
    this.deadline = deadline;
    const delay = Math.max(0, deadline - this.deps.now());
    this.timerId = this.deps.setTimer(this.handleTimer, delay);
  }

  private cancelTimer(): void {
    if (this.timerId !== null) {
      this.deps.clearTimer(this.timerId);
      this.timerId = null;
    }
    this.deadline = null;
  }

  /**
   * Hidden: stop the cadence (no traffic, and background timers are throttled
   * anyway; D4 sends `suspend`). Visible: resume with a fresh packet so the
   * host drops any state that went stale while the page was hidden.
   */
  private readonly handleVisibilityChange = (): void => {
    if (!this.running) {
      return;
    }
    if (isDocumentHidden()) {
      if (this.paused) {
        return;
      }
      this.paused = true;
      this.cancelTimer();
      return;
    }
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.sendNow();
    this.scheduleNext();
  };

  private attachVisibility(): void {
    if (this.visibilityAttached || typeof document === "undefined") {
      return;
    }
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.visibilityAttached = true;
  }

  private detachVisibility(): void {
    if (!this.visibilityAttached || typeof document === "undefined") {
      return;
    }
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange,
    );
    this.visibilityAttached = false;
  }
}

/**
 * Phone lifecycle: suspend on hidden, rejoin on visible (D4-CTRL-02; FR-5.4,
 * FR-5.5, FR-8.8).
 *
 * Android can freeze a backgrounded tab without closing its socket, so the
 * controller tells the server explicitly:
 *
 * - hidden: send `suspend` (if the socket is open), stop sensors and the send
 *   loop, release the Wake Lock, pause clock sync. The socket itself is left
 *   open; the server reserves the slot for 30 s (FR-5.4).
 * - visible: reacquire the Wake Lock, then `join {session}` on the still-open
 *   socket, or hand control to the reconnect layer when the socket died. After
 *   the 30 s reservation there is nothing to reclaim: `onSessionLost` fires so
 *   the caller can use the room token or the manual form instead of sending a
 *   doomed session join (FR-5.5).
 *
 * Both `visibilitychange` and `pagehide`/`pageshow` are observed because some
 * Android browsers fire only the page events. Every callback and socket send
 * is best-effort: a lifecycle handler must never throw (AR-3). Timers are not
 * used; the elapsed reservation is measured with an injected clock.
 */
import { PROTOCOL_VERSION } from "@lanpad/protocol";
import type { ClientToServerMessage } from "@lanpad/protocol";
import type { SessionStore } from "../join/sessionStore.js";

/** Server slot reservation after `suspend` or socket close (FR-5.4). */
export const SLOT_RESERVATION_MS = 30_000;

/** Why the slot cannot be reclaimed by session. */
export type SessionLostReason = "expired" | "missing";

/** The socket surface the lifecycle needs. */
export interface SuspendSocket {
  isOpen(): boolean;
  /** Sends a protocol message; may throw when the socket is not writable. */
  send(message: ClientToServerMessage): void;
}

/** The Wake Lock surface the lifecycle needs; `WakeLockManager` satisfies it. */
export interface SuspendWakeLock {
  request(): Promise<boolean>;
  release(): Promise<void>;
}

/** Minimal document surface; the real `document` satisfies it. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface SuspendDeps {
  socket: SuspendSocket;
  store: SessionStore;
  code: string;
  wakeLock: SuspendWakeLock;
  /** Defaults to the global `document`; null disables event wiring. */
  visibility?: VisibilitySource | null | undefined;
  now?: () => number;
  /** Stop sensors, the send loop and clock sync. */
  onHide?: () => void;
  /** Restart clock sync, sensors and the send loop (only when joined). */
  onShow?: () => void;
  /** The socket is closed; the reconnect layer should take over. */
  onReconnect?: () => void;
  /** The reservation is gone or there is no stored session for this room. */
  onSessionLost?: (reason: SessionLostReason) => void;
  /** Debug-overlay sink; never used for control flow. */
  onError?: (error: unknown) => void;
}

function defaultVisibility(): VisibilitySource | null {
  if (typeof document === "undefined") {
    return null;
  }
  return document as unknown as VisibilitySource;
}

export class SuspendController {
  private readonly deps: SuspendDeps;
  private readonly now: () => number;

  private visibility: VisibilitySource | null = null;
  private attached = false;
  private hidden = false;
  private hiddenAtMs = 0;

  constructor(deps: SuspendDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  get isHidden(): boolean {
    return this.hidden;
  }

  /** Starts observing page visibility. Safe to call more than once. */
  attach(): void {
    if (this.attached) {
      return;
    }
    const source = this.deps.visibility === undefined ? defaultVisibility() : this.deps.visibility;
    this.visibility = source;
    if (source === null) {
      return;
    }
    source.addEventListener("visibilitychange", this.handleVisibilityChange);
    source.addEventListener("pagehide", this.handlePageHide);
    source.addEventListener("pageshow", this.handlePageShow);
    this.attached = true;
  }

  /** Stops observing and releases the Wake Lock (explicit leave/teardown). */
  destroy(): void {
    this.detach();
    this.releaseWakeLock();
  }

  /** Hidden transition. Idempotent: duplicate events send one `suspend`. */
  handleHidden(): void {
    if (this.hidden) {
      return;
    }
    this.hidden = true;
    this.hiddenAtMs = this.now();

    if (this.deps.socket.isOpen()) {
      try {
        this.deps.socket.send({ t: "suspend" });
      } catch (error) {
        this.reportError(error);
      }
    }

    this.call(() => this.deps.onHide?.());
    this.releaseWakeLock();
  }

  /** Visible transition. Idempotent: a stray event without a hide is ignored. */
  handleVisible(): void {
    if (!this.hidden) {
      return;
    }
    this.hidden = false;
    const hiddenForMs = Math.max(0, this.now() - this.hiddenAtMs);

    this.requestWakeLock();

    const stored = this.deps.store.get(this.deps.code);
    if (stored === null) {
      this.sessionLost("missing");
    } else if (hiddenForMs > SLOT_RESERVATION_MS) {
      this.sessionLost("expired");
    } else if (this.deps.socket.isOpen()) {
      try {
        this.deps.socket.send({
          t: "join",
          v: PROTOCOL_VERSION,
          code: this.deps.code,
          session: stored.session,
        });
      } catch (error) {
        this.reportError(error);
        this.call(() => this.deps.onReconnect?.());
      }
    } else {
      this.call(() => this.deps.onReconnect?.());
    }

    this.call(() => this.deps.onShow?.());
  }

  private detach(): void {
    const source = this.visibility;
    if (!this.attached || source === null) {
      this.visibility = null;
      return;
    }
    source.removeEventListener("visibilitychange", this.handleVisibilityChange);
    source.removeEventListener("pagehide", this.handlePageHide);
    source.removeEventListener("pageshow", this.handlePageShow);
    this.visibility = null;
    this.attached = false;
  }

  private readonly handleVisibilityChange = (): void => {
    const source = this.visibility;
    if (source === null) {
      return;
    }
    if (source.visibilityState === "hidden") {
      this.handleHidden();
    } else {
      this.handleVisible();
    }
  };

  private readonly handlePageHide = (): void => {
    this.handleHidden();
  };

  private readonly handlePageShow = (): void => {
    this.handleVisible();
  };

  private sessionLost(reason: SessionLostReason): void {
    this.call(() => this.deps.onSessionLost?.(reason));
  }

  private requestWakeLock(): void {
    try {
      const pending = this.deps.wakeLock.request();
      void Promise.resolve(pending).catch((error: unknown) => {
        this.reportError(error);
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  private releaseWakeLock(): void {
    try {
      const pending = this.deps.wakeLock.release();
      void Promise.resolve(pending).catch((error: unknown) => {
        this.reportError(error);
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  private call(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    try {
      this.deps.onError?.(error);
    } catch {
      // The error sink itself must not break the lifecycle path.
    }
  }
}

/** Convenience factory for the page shell and tests. */
export function createSuspendController(deps: SuspendDeps): SuspendController {
  return new SuspendController(deps);
}

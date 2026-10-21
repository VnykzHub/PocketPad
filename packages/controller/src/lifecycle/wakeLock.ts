/**
 * Screen Wake Lock wrapper (D4-CTRL-02; FR-8.8, AR-3).
 *
 * Keep the phone screen awake while a controller is connected, without ever
 * making input depend on it. The API is absent on many Android browsers and on
 * every non-secure origin, and a request can be refused at any time (battery
 * saver, tab hidden). Every failure path therefore resolves `false` and is
 * reported through `onError`; nothing here throws at the caller (AR-3).
 *
 * The navigator is injected so tests can exercise feature detection and the
 * held/released lifecycle without a browser. `request()` is safe to call
 * repeatedly: an already-held lock resolves `true` without a second request,
 * and a request in flight is shared.
 */

/** Wake Lock states exposed to the debug overlay. */
export type WakeLockState = "unsupported" | "idle" | "requesting" | "held" | "failed";

/** The part of `WakeLockSentinel` this module uses. */
export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener?(type: "release", listener: () => void): void;
  removeEventListener?(type: "release", listener: () => void): void;
}

/** The part of `navigator.wakeLock` this module uses. */
export interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export interface WakeLockNavigatorLike {
  wakeLock?: WakeLockLike | undefined;
}

export interface WakeLockOptions {
  /** Explicit surface; pass null to simulate an unsupporting browser. */
  navigator?: WakeLockNavigatorLike | null | undefined;
  /** Debug-overlay sink; never used for control flow. */
  onError?: (error: unknown) => void;
  onStateChange?: (state: WakeLockState) => void;
}

/**
 * Feature-detects `navigator.wakeLock` structurally. Some browsers expose the
 * property but not a callable `request`, so both are checked.
 */
function detectWakeLock(): WakeLockLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }
  const candidate: unknown = (navigator as unknown as { wakeLock?: unknown }).wakeLock;
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const request: unknown = (candidate as { request?: unknown }).request;
  if (typeof request !== "function") {
    return null;
  }
  return candidate as WakeLockLike;
}

export class WakeLockManager {
  private readonly wakeLock: WakeLockLike | null;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly onStateChange: ((state: WakeLockState) => void) | undefined;

  private current: WakeLockState;
  private sentinel: WakeLockSentinelLike | null = null;
  private releaseListener: (() => void) | null = null;
  private pending: Promise<boolean> | null = null;
  /** Incremented by request and release; stale acquisitions are discarded. */
  private sequence = 0;

  constructor(options: WakeLockOptions = {}) {
    const injected = options.navigator;
    const wakeLock =
      injected === undefined ? detectWakeLock() : injected === null ? null : (injected.wakeLock ?? null);
    this.wakeLock = wakeLock;
    this.onError = options.onError;
    this.onStateChange = options.onStateChange;
    this.current = wakeLock === null ? "unsupported" : "idle";
  }

  /** True when the browser exposes a usable Wake Lock API. */
  get supported(): boolean {
    return this.wakeLock !== null;
  }

  get state(): WakeLockState {
    return this.current;
  }

  get isHeld(): boolean {
    return this.sentinel !== null;
  }

  /**
   * Requests a screen lock. Resolves true when held, false when unsupported,
   * refused or superseded by a release. Never rejects (AR-3).
   */
  async request(): Promise<boolean> {
    if (this.wakeLock === null) {
      this.setState("unsupported");
      return false;
    }
    if (this.sentinel !== null && !this.sentinel.released) {
      return true;
    }
    if (this.pending !== null) {
      return this.pending;
    }

    const sequence = ++this.sequence;
    this.setState("requesting");
    const pending = this.acquire(this.wakeLock, sequence);
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) {
        this.pending = null;
      }
    }
  }

  /**
   * Releases the lock if held. Also cancels a request that is still in flight:
   * its sentinel is released as soon as the browser hands it over. Never
   * rejects.
   */
  async release(): Promise<void> {
    this.sequence += 1;
    const sentinel = this.sentinel;
    const listener = this.releaseListener;
    this.sentinel = null;
    this.releaseListener = null;

    if (sentinel === null) {
      if (this.current === "requesting") {
        this.setState(this.wakeLock === null ? "unsupported" : "idle");
      }
      return;
    }

    if (listener !== null) {
      sentinel.removeEventListener?.("release", listener);
    }
    try {
      await sentinel.release();
    } catch (error) {
      this.onError?.(error);
    }
    this.setState(this.wakeLock === null ? "unsupported" : "idle");
  }

  private async acquire(wakeLock: WakeLockLike, sequence: number): Promise<boolean> {
    let sentinel: WakeLockSentinelLike | null = null;
    try {
      sentinel = await wakeLock.request("screen");
    } catch (error) {
      if (sequence === this.sequence) {
        this.setState("failed");
      }
      this.onError?.(error);
      return false;
    }

    if (sentinel === null) {
      return false;
    }

    if (sequence !== this.sequence) {
      // Released (or superseded) while the request was in flight.
      try {
        await sentinel.release();
      } catch (error) {
        this.onError?.(error);
      }
      return false;
    }

    this.sentinel = sentinel;
    const listener = (): void => {
      if (this.sentinel !== sentinel) {
        return;
      }
      this.sentinel = null;
      this.releaseListener = null;
      this.setState(this.wakeLock === null ? "unsupported" : "idle");
    };
    this.releaseListener = listener;
    sentinel.addEventListener?.("release", listener);
    this.setState("held");
    return true;
  }

  private setState(next: WakeLockState): void {
    if (this.current === next) {
      return;
    }
    this.current = next;
    this.onStateChange?.(next);
  }
}

/** Convenience factory for the page shell and tests. */
export function createWakeLockManager(options: WakeLockOptions = {}): WakeLockManager {
  return new WakeLockManager(options);
}

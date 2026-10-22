/**
 * Haptic frame player and 20 Hz coalescer (D6-CTRL-04; FR-8.11, FR-8.12).
 *
 * The broker sends one Haptic frame (0x84) per host pulse. Patterns may carry
 * up to eight u16 durations, alternating vibrate/pause. Phones cannot start a
 * new vibration more often than roughly every 50 ms without the pattern being
 * cancelled, so this player:
 *
 *   1. decodes/validates the frame,
 *   2. plays immediately when the previous pulse is at least 50 ms old,
 *   3. otherwise merges it into one pending pattern (longest total duration
 *      wins) and plays that pattern when the 50 ms window closes.
 *
 * Playback uses an injected `vibrate` function. When it is missing, returns
 * false, or throws, the player falls back to a visual pulse and an optional
 * audio click so the host's feedback is never silent (AR-3).
 *
 * `setEnabled(false)` is the global haptics toggle: it cancels any pending
 * pulse, stops an in-flight vibration immediately (`vibrate(0)`), and drops
 * later patterns until re-enabled. Everything is injected, so the module has
 * no import-time DOM or navigator access and tests need no browser.
 */
import { decodeHaptic, MAX_HAPTIC_STEPS } from "@lanpad/protocol";

/** Minimum interval between vibration starts: 20 Hz (FR-8.11). */
export const HAPTIC_COALESCE_MS = 50;

/** Longest u16 duration in milliseconds. */
export const MAX_HAPTIC_DURATION_MS = 0xffff;

/** What happened to one incoming pattern. */
export type HapticPlayResult =
  | "played"
  | "coalesced"
  | "suppressed"
  | "rejected"
  | "ignored";

/** Minimal timer surface, injectable for deterministic tests. */
export interface HapticScheduler {
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/**
 * `navigator.vibrate` shape. Passing `0` cancels; otherwise the array is the
 * alternating on/off pattern. Returns false when the device rejects vibration.
 */
export type VibrateFn = (pattern: number | number[]) => boolean;

export interface HapticPlayerOptions {
  /** Slot number for diagnostics (1..8); no filtering is done here. */
  readonly slot?: number | undefined;
  /** Initial toggle state; defaults to enabled (FR-8.12). */
  readonly enabled?: boolean | undefined;
  /** `null` explicitly disables vibration in tests. Omit for navigator. */
  readonly vibrate?: VibrateFn | null | undefined;
  /** Called instead of vibration, with the total "on" time. */
  readonly visualPulse?: ((durationMs: number) => void) | undefined;
  /** Optional click paired with the visual pulse. */
  readonly audioClick?: (() => void) | undefined;
  readonly scheduler?: HapticScheduler | undefined;
  /** Monotonic clock in milliseconds; defaults to `performance.now()`. */
  readonly now?: (() => number) | undefined;
}

const DEFAULT_SCHEDULER: HapticScheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
};

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function defaultVibrate(pattern: number | number[]): boolean {
  const scope = globalThis as {
    navigator?: { vibrate?: (value: number | number[]) => boolean };
  };
  const navigatorValue = scope.navigator;
  if (navigatorValue === undefined || typeof navigatorValue.vibrate !== "function") {
    return false;
  }
  try {
    return navigatorValue.vibrate.call(navigatorValue, pattern) !== false;
  } catch {
    return false;
  }
}

/** Total "motor on" time: even indices vibrate, odd indices pause. */
export function totalOnDuration(durationsMs: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < durationsMs.length; index += 2) {
    total += durationsMs[index] ?? 0;
  }
  return total;
}

function totalPatternDuration(durationsMs: readonly number[]): number {
  let total = 0;
  for (const duration of durationsMs) {
    total += duration;
  }
  return total;
}

/**
 * Validates and normalizes a duration list. Returns null for anything that is
 * not 1..8 finite numbers; clamps each step to u16 instead of rejecting a
 * slightly out-of-range pulse.
 */
export function sanitizeHapticDurations(input: unknown): number[] | null {
  if (!Array.isArray(input)) {
    return null;
  }
  if (input.length === 0 || input.length > MAX_HAPTIC_STEPS) {
    return null;
  }

  const durations: number[] = [];
  for (const value of input) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    durations.push(
      Math.min(MAX_HAPTIC_DURATION_MS, Math.max(0, Math.round(value))),
    );
  }
  return durations;
}

/**
 * Lazily-created DOM fallback: a brief full-screen white flash. The element is
 * created on first use, never at import time. Without a document (Node tests,
 * server import) it does nothing.
 */
export function createDomVisualPulse(
  scope?: Document | null,
): (durationMs: number) => void {
  let element: HTMLElement | null = null;
  let hideHandle: number | null = null;

  return (durationMs: number): void => {
    const doc =
      scope ??
      (typeof document !== "undefined" ? document : null);
    const body = doc?.body ?? null;
    if (body === null) {
      return;
    }

    if (element === null) {
      element = doc!.createElement("div");
      element.dataset["part"] = "haptic-pulse";
      element.setAttribute("aria-hidden", "true");
      const style = element.style;
      style.position = "fixed";
      style.inset = "0";
      style.pointerEvents = "none";
      style.background = "rgba(255, 255, 255, 0.35)";
      style.opacity = "0";
      style.transition = "opacity 80ms linear";
      style.zIndex = "2147483647";
      body.append(element);
    }

    element.style.opacity = "0.35";
    if (hideHandle !== null) {
      globalThis.clearTimeout(hideHandle);
      hideHandle = null;
    }
    hideHandle = globalThis.setTimeout(() => {
      hideHandle = null;
      if (element !== null) {
        element.style.opacity = "0";
      }
    }, Math.max(40, Math.round(durationMs))) as unknown as number;
  };
}

export class HapticPlayer {
  /** Slot this player serves (diagnostics only; 0 when unset). */
  readonly slot: number;

  private readonly scheduler: HapticScheduler;
  private readonly now: () => number;
  private readonly vibrate: VibrateFn | null;
  private readonly visualPulse: (durationMs: number) => void;
  private readonly audioClick: (() => void) | null;

  private enabledState: boolean;
  private disposed = false;
  private pending: number[] | null = null;
  private timerHandle: number | null = null;
  private lastPlayedAtMs: number | null = null;

  private played = 0;
  private coalesced = 0;
  private rejected = 0;
  private suppressed = 0;
  private fallbacks = 0;

  constructor(options: HapticPlayerOptions = {}) {
    this.slot = options.slot ?? 0;
    this.enabledState = options.enabled !== false;
    this.scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
    this.now = options.now ?? defaultNow;
    this.vibrate =
      options.vibrate === undefined ? defaultVibrate : options.vibrate;
    this.visualPulse = options.visualPulse ?? createDomVisualPulse();
    this.audioClick = options.audioClick ?? null;
  }

  get isEnabled(): boolean {
    return this.enabledState;
  }

  /** Pattern waiting for the 20 Hz window, if any. */
  get pendingPattern(): readonly number[] | null {
    return this.pending === null ? null : [...this.pending];
  }

  get playedCount(): number {
    return this.played;
  }

  get coalescedCount(): number {
    return this.coalesced;
  }

  get rejectedCount(): number {
    return this.rejected;
  }

  get suppressedCount(): number {
    return this.suppressed;
  }

  get fallbackCount(): number {
    return this.fallbacks;
  }

  /**
   * Handles one decoded Haptic frame (0x84). Malformed frames are rejected
   * without throwing, so a hostile host cannot break the controller loop.
   */
  handleFrame(frame: Uint8Array): HapticPlayResult {
    if (this.disposed) {
      return "ignored";
    }

    let durations: number[];
    try {
      durations = decodeHaptic(frame);
    } catch {
      this.rejected += 1;
      return "rejected";
    }

    return this.handleDurations(durations);
  }

  /**
   * Accepts an already-decoded duration list (e.g. from a broker test or a
   * HapticCmd routed locally). Applies validation, coalescing and playback.
   */
  handleDurations(durationsMs: readonly number[]): HapticPlayResult {
    if (this.disposed) {
      return "ignored";
    }

    const durations = sanitizeHapticDurations(durationsMs);
    if (durations === null) {
      this.rejected += 1;
      return "rejected";
    }

    if (!this.enabledState) {
      this.suppressed += 1;
      return "suppressed";
    }

    const now = this.now();
    if (
      this.lastPlayedAtMs === null ||
      now - this.lastPlayedAtMs >= HAPTIC_COALESCE_MS
    ) {
      // A new pulse can start now; anything waiting is redundant.
      this.cancelTimer();
      this.pending = null;
      this.playPattern(durations, now);
      return "played";
    }

    this.mergePending(durations);
    this.coalesced += 1;
    return "coalesced";
  }

  /** Global haptics toggle (FR-8.12). Off stops vibration immediately. */
  setEnabled(enabled: boolean): void {
    if (this.enabledState === enabled) {
      return;
    }
    this.enabledState = enabled;

    if (!enabled) {
      this.cancelTimer();
      this.pending = null;
      this.tryVibrate(0);
    }
  }

  toggle(): boolean {
    this.setEnabled(!this.enabledState);
    return this.enabledState;
  }

  /** Stops all vibration and drops pending work; the instance stays usable. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelTimer();
    this.pending = null;
    this.tryVibrate(0);
  }

  private mergePending(durations: number[]): void {
    if (
      this.pending === null ||
      totalPatternDuration(durations) >= totalPatternDuration(this.pending)
    ) {
      this.pending = durations;
    }

    if (this.timerHandle === null) {
      const elapsed = this.now() - (this.lastPlayedAtMs ?? this.now());
      const delay = Math.max(0, HAPTIC_COALESCE_MS - elapsed);
      this.timerHandle = this.scheduler.setTimeout(() => {
        this.timerHandle = null;
        const pending = this.pending;
        this.pending = null;
        if (pending !== null && !this.disposed && this.enabledState) {
          this.playPattern(pending, this.now());
        }
      }, delay);
    }
  }

  private playPattern(durations: number[], nowMs: number): void {
    this.lastPlayedAtMs = nowMs;

    if (this.tryVibrate(durations)) {
      this.played += 1;
      return;
    }

    this.fallbacks += 1;
    try {
      this.visualPulse(totalOnDuration(durations));
    } catch {
      // A broken overlay must not break input.
    }
    if (this.audioClick !== null) {
      try {
        this.audioClick();
      } catch {
        // Optional enhancement only.
      }
    }
  }

  private tryVibrate(pattern: number | number[]): boolean {
    if (this.vibrate === null) {
      return false;
    }
    try {
      return this.vibrate(pattern) !== false;
    } catch {
      return false;
    }
  }

  private cancelTimer(): void {
    if (this.timerHandle === null) {
      return;
    }
    this.scheduler.clearTimeout(this.timerHandle);
    this.timerHandle = null;
  }
}

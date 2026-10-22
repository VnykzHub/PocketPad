/**
 * Host haptics API (D6-RT-01; FR-8.11, SR-12, D6 contract 5).
 *
 * Games call `ctx.haptics.pulse(slot | "all", durationsMs)`; this module
 * validates the pattern (1..8 u16 steps), encodes the existing binary
 * `HapticCmd` frame (slot 0 for "all") and hands it to the host socket.
 *
 * A game must not be able to flood the socket, so sends are limited to 20 Hz
 * per target (one bucket per slot and one for "all"). Pulses that arrive
 * inside the window coalesce: the newest pattern replaces the pending one and
 * is flushed at the window boundary. Double limiting with the controller is
 * intentional (D6 risk note).
 *
 * The API never persists patterns (SR-12), never logs them, and never exposes
 * the socket or the encoded frame to games (FR-7.17).
 */
import {
  MAX_CONTROLLERS,
  MAX_HAPTIC_STEPS,
  encodeHapticCmd,
} from "@lanpad/protocol";

/** Host-side ceiling from the plan. */
export const HAPTIC_MAX_HZ = 20;
/** Minimum spacing between two sends to the same target. */
export const HAPTIC_MIN_INTERVAL_MS = 1000 / HAPTIC_MAX_HZ;
/** u16 duration ceiling. */
export const HAPTIC_MAX_DURATION_MS = 0xffff;

/** A target slot (1..8) or every controller. */
export type HapticTarget = number | "all";

export interface HapticApiDeps {
  /** Sends one encoded binary frame. Throws when the socket is not open. */
  readonly send: (frame: Uint8Array) => void;
  /** Host clock in milliseconds; injected for deterministic tests. */
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => HapticTimer;
  readonly clearTimer?: (handle: HapticTimer) => void;
}

export type HapticTimer = ReturnType<typeof setTimeout>;

export interface HapticStats {
  /** Frames actually handed to the socket. */
  readonly sent: number;
  /** Pulses replaced by a newer pulse inside one 50 ms window. */
  readonly coalesced: number;
  /** Pulses that could not be encoded or sent. */
  readonly dropped: number;
  /** Host-clock time of the most recent successful send, or null. */
  readonly lastSentAtMs: number | null;
  /** Targets with a coalesced pulse waiting for the window boundary. */
  readonly pending: number;
}

interface Bucket {
  lastSentAtMs: number | null;
  /** Newest pattern waiting for the window; null when nothing is pending. */
  pending: readonly number[] | null;
  timer: HapticTimer | null;
}

function normalizeTarget(slot: HapticTarget): number {
  if (slot === "all") {
    return 0;
  }
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_CONTROLLERS) {
    throw new RangeError(
      `ctx.haptics.pulse target must be an integer in 1..${MAX_CONTROLLERS} or "all".`,
    );
  }
  return slot;
}

function normalizePattern(durations: ReadonlyArray<number>): readonly number[] {
  if (!Array.isArray(durations)) {
    throw new TypeError("ctx.haptics.pulse durations must be an array of milliseconds.");
  }
  if (durations.length < 1 || durations.length > MAX_HAPTIC_STEPS) {
    throw new RangeError(
      `ctx.haptics.pulse accepts 1..${MAX_HAPTIC_STEPS} durations; got ${durations.length}.`,
    );
  }
  const copy: number[] = [];
  for (let index = 0; index < durations.length; index += 1) {
    const duration = durations[index];
    if (
      typeof duration !== "number" ||
      !Number.isInteger(duration) ||
      duration < 0 ||
      duration > HAPTIC_MAX_DURATION_MS
    ) {
      throw new RangeError(
        `ctx.haptics.pulse duration ${index} must be an integer in 0..${HAPTIC_MAX_DURATION_MS}.`,
      );
    }
    copy.push(duration);
  }
  return copy;
}

export class HapticApi {
  private readonly sendFrame: (frame: Uint8Array) => void;
  private readonly clock: () => number;
  private readonly setTimerFn: (callback: () => void, delayMs: number) => HapticTimer;
  private readonly clearTimerFn: (handle: HapticTimer) => void;
  private readonly buckets = new Map<string, Bucket>();
  private sentCount = 0;
  private coalescedCount = 0;
  private droppedCount = 0;
  private lastSentAtMs: number | null = null;
  private disposed = false;

  constructor(deps: HapticApiDeps) {
    this.sendFrame = deps.send;
    this.clock = deps.now ?? (() => performance.now());
    this.setTimerFn = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimerFn =
      deps.clearTimer ??
      ((handle) => {
        clearTimeout(handle);
      });
  }

  get stats(): HapticStats {
    let pending = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.pending !== null) {
        pending += 1;
      }
    }
    return {
      sent: this.sentCount,
      coalesced: this.coalescedCount,
      dropped: this.droppedCount,
      lastSentAtMs: this.lastSentAtMs,
      pending,
    };
  }

  /**
   * Pulses one slot or every controller. First pulse to a target sends
   * immediately; pulses inside the next 50 ms coalesce to the latest.
   *
   * Developer errors (bad slot/pattern) throw; transport failures are counted
   * and never thrown into a game tick.
   */
  pulse(slot: HapticTarget, durations: ReadonlyArray<number>): void {
    if (this.disposed) {
      return;
    }
    const slotNumber = normalizeTarget(slot);
    const pattern = normalizePattern(durations);
    const key = String(slotNumber);
    const bucket = this.bucketFor(key);
    const now = this.clock();

    const last = bucket.lastSentAtMs;
    if (last === null || now - last >= HAPTIC_MIN_INTERVAL_MS) {
      this.clearBucketTimer(bucket);
      bucket.pending = null;
      this.sendNow(slotNumber, pattern, bucket, now);
      return;
    }

    if (bucket.pending !== null) {
      this.coalescedCount += 1;
    }
    bucket.pending = pattern;
    if (bucket.timer === null) {
      const delay = Math.max(0, HAPTIC_MIN_INTERVAL_MS - (now - last));
      bucket.timer = this.setTimerFn(() => {
        bucket.timer = null;
        this.flush(slotNumber, bucket);
      }, delay);
    }
  }

  /** Clears pending timers (host teardown). Idempotent. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const bucket of this.buckets.values()) {
      this.clearBucketTimer(bucket);
      bucket.pending = null;
    }
    this.buckets.clear();
  }

  private bucketFor(key: string): Bucket {
    const existing = this.buckets.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const created: Bucket = { lastSentAtMs: null, pending: null, timer: null };
    this.buckets.set(key, created);
    return created;
  }

  private flush(slotNumber: number, bucket: Bucket): void {
    const pattern = bucket.pending;
    if (pattern === null || this.disposed) {
      return;
    }
    bucket.pending = null;
    this.sendNow(slotNumber, pattern, bucket, this.clock());
  }

  private sendNow(
    slotNumber: number,
    pattern: readonly number[],
    bucket: Bucket,
    now: number,
  ): void {
    let frame: Uint8Array;
    try {
      frame = encodeHapticCmd(slotNumber, pattern);
    } catch {
      // Validation above should make this unreachable; count instead of throw.
      this.droppedCount += 1;
      return;
    }
    try {
      this.sendFrame(frame);
    } catch {
      // A closed socket during a game tick is normal; the next pulse retries.
      this.droppedCount += 1;
      return;
    }
    this.sentCount += 1;
    bucket.lastSentAtMs = now;
    this.lastSentAtMs = now;
  }

  private clearBucketTimer(bucket: Bucket): void {
    if (bucket.timer !== null) {
      this.clearTimerFn(bucket.timer);
      bucket.timer = null;
    }
  }
}

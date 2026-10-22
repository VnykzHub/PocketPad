/**
 * Stroke batching for the canvas control (D5-CTRL-04; FR-7.8, FR-8.1, E10).
 *
 * The batcher turns raw finger positions into the frozen D5 stroke event shape
 * `{points, color, width, phase}` (D5 contract 5) without owning any DOM or
 * socket. It is the only stroke path (D5 anti-rework): the canvas control
 * feeds it surface pixels and draws the returned samples locally; the emitted
 * payloads go to the event queue.
 *
 * Rules:
 * - Sampling: a point is kept at most every `sampleIntervalMs` (16 ms) or once
 *   the finger moved `sampleDistancePx` (8 px), whichever comes first.
 * - Points are normalized to 0..1 against the canvas box and rounded to 4
 *   decimals; `t` is integer milliseconds since the stroke started. Rounding
 *   roughly halves the bytes per point versus raw doubles (E10).
 * - `start` carries the first point; `move` carries up to
 *   `maxPointsPerBatch` (16) points every `flushIntervalMs` (~50 ms); `end`
 *   carries the remaining points plus the total `count`. An `end` is always
 *   emitted, even for a cancelled touch or a stroke with no moves.
 * - Bandwidth cap: a `move` flush that would push the trailing one-second
 *   byte estimate over `maxBytesPerSecond` (20 KB/s) is deferred; points keep
 *   accumulating instead.
 * - Bounded queue: pending points never exceed `maxPendingPoints`; when full,
 *   intermediate points are decimated (every other one dropped, the first and
 *   last kept) so the stroke shape survives instead of being dropped.
 * - `start`/`end` are never deferred, so a stroke always begins and finishes.
 *
 * Nothing is stored after `end` (SR-13: strokes are only sent).
 */
import { normalizeStrokePoint } from "@lanpad/sdk";
import type { JsonValue } from "@lanpad/protocol";
import type { StrokeEventData, StrokePoint } from "./eventSink.js";

/** Default tuning; see the module comment and E10 targets. */
export const STROKE_SAMPLE_INTERVAL_MS = 16;
export const STROKE_SAMPLE_DISTANCE_PX = 8;
export const STROKE_FLUSH_INTERVAL_MS = 50;
export const STROKE_MAX_POINTS_PER_BATCH = 16;
export const STROKE_MAX_PENDING_POINTS = 64;
export const STROKE_MAX_BYTES_PER_SECOND = 20_000;

const COORD_SCALE = 10_000;
const BANDWIDTH_WINDOW_MS = 1_000;

/** Canvas box in the same pixel space as the raw touch coordinates. */
export interface StrokeBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Minimal timer surface so tests can drive the idle flush deterministically. */
export interface StrokeTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface StrokeBatcherOptions {
  color: string;
  width: number;
  /** Receives every payload in order; normally wraps the event sink. */
  emit: (data: StrokeEventData) => void;
  now: () => number;
  /** Idle flush scheduler; omit to flush only on input (tests, workers). */
  timers?: StrokeTimers;
  sampleIntervalMs?: number;
  sampleDistancePx?: number;
  flushIntervalMs?: number;
  maxPointsPerBatch?: number;
  maxPendingPoints?: number;
  maxBytesPerSecond?: number;
  /** Hard cap on points per stroke (layout `maxStrokePoints`). */
  maxStrokePoints?: number;
}

/** Counters for the debug overlay and the E10 run. */
export interface StrokeBatcherStats {
  /** Payloads emitted across all strokes. */
  batches: number;
  /** Estimated JSON bytes of all emitted payloads. */
  bytes: number;
  /** Points removed by decimation under pressure. */
  coalescedPoints: number;
  /** `move` flushes postponed by the bandwidth cap. */
  deferredFlushes: number;
}

function roundCoord(value: number): number {
  return Math.round(value * COORD_SCALE) / COORD_SCALE;
}

/**
 * Drops every other intermediate point until `points.length <= limit`,
 * always keeping the first and last point. Returns the number removed.
 * Mutates `points` in place to avoid allocating on the touch path.
 */
export function decimatePoints(points: StrokePoint[], limit: number): number {
  const target = Math.max(2, Math.floor(limit));
  let removed = 0;
  while (points.length > target) {
    const last = points[points.length - 1];
    const kept: StrokePoint[] = [];
    for (let index = 0; index < points.length - 1; index += 2) {
      const point = points[index];
      if (point !== undefined) {
        kept.push(point);
      }
    }
    if (last !== undefined) {
      kept.push(last);
    }
    removed += points.length - kept.length;
    points.length = 0;
    points.push(...kept);
  }
  return removed;
}

/** JSON byte estimate; every field is ASCII so string length equals bytes. */
export function estimateStrokeBytes(data: StrokeEventData): number {
  return JSON.stringify(data).length;
}

function isStrokeData(value: JsonValue): value is StrokeEventData {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, JsonValue>;
  return (
    Array.isArray(record["points"]) &&
    typeof record["color"] === "string" &&
    typeof record["width"] === "number" &&
    (record["phase"] === "start" || record["phase"] === "move" || record["phase"] === "end")
  );
}

/**
 * Event-queue coalescer for stroke payloads (D5-CTRL-05 hook). Two queued
 * `move` batches with the same ink merge into one, decimated to
 * `STROKE_MAX_PENDING_POINTS`. `start`/`end` never merge, so stroke framing
 * is preserved. Returns null when the pair is not coalescible.
 */
export function coalesceStrokeData(previous: JsonValue, next: JsonValue): JsonValue | null {
  if (!isStrokeData(previous) || !isStrokeData(next)) {
    return null;
  }
  if (
    previous.phase !== "move" ||
    next.phase !== "move" ||
    previous.color !== next.color ||
    previous.width !== next.width
  ) {
    return null;
  }
  const points = [...previous.points, ...next.points];
  decimatePoints(points, STROKE_MAX_PENDING_POINTS);
  return { points, color: next.color, width: next.width, phase: "move" };
}

type ResolvedOptions = Required<Omit<StrokeBatcherOptions, "timers">> & {
  timers: StrokeTimers | undefined;
};

export class StrokeBatcher {
  private readonly options: ResolvedOptions;
  private readonly sent: { at: number; bytes: number }[] = [];
  private readonly statsValue: StrokeBatcherStats = {
    batches: 0,
    bytes: 0,
    coalescedPoints: 0,
    deferredFlushes: 0,
  };

  private box: StrokeBox | null = null;
  private pending: StrokePoint[] = [];
  private count = 0;
  private startedAt = 0;
  private lastRawX = 0;
  private lastRawY = 0;
  private lastSampleAt = 0;
  private lastFlushAt = 0;
  private timer: unknown = null;

  constructor(options: StrokeBatcherOptions) {
    this.options = {
      sampleIntervalMs: STROKE_SAMPLE_INTERVAL_MS,
      sampleDistancePx: STROKE_SAMPLE_DISTANCE_PX,
      flushIntervalMs: STROKE_FLUSH_INTERVAL_MS,
      maxPointsPerBatch: STROKE_MAX_POINTS_PER_BATCH,
      maxPendingPoints: STROKE_MAX_PENDING_POINTS,
      maxBytesPerSecond: STROKE_MAX_BYTES_PER_SECOND,
      maxStrokePoints: Number.POSITIVE_INFINITY,
      ...options,
      timers: options.timers,
    };
  }

  /** True while a stroke is between `begin` and `end`/`cancel`. */
  get active(): boolean {
    return this.box !== null;
  }

  /** Points currently waiting for a `move` flush. */
  get pendingCount(): number {
    return this.pending.length;
  }

  stats(): StrokeBatcherStats {
    return { ...this.statsValue };
  }

  /**
   * Starts a stroke and emits `start` immediately. Returns the first point
   * for local rendering, or null when a stroke is already active.
   */
  begin(rawX: number, rawY: number, box: StrokeBox): StrokePoint | null {
    if (this.box !== null) {
      return null;
    }
    const stamp = this.options.now();
    this.box = box;
    this.startedAt = stamp;
    this.lastSampleAt = stamp;
    this.lastFlushAt = stamp;
    this.lastRawX = rawX;
    this.lastRawY = rawY;
    this.pending = [];
    this.count = 1;
    const point = this.pointAt(rawX, rawY, stamp);
    this.send({
      points: [point],
      color: this.options.color,
      width: this.options.width,
      phase: "start",
    });
    return point;
  }

  /**
   * Offers a finger position. Returns the sampled point (draw it now) or null
   * when the sample was throttled. May emit a `move` batch.
   */
  move(rawX: number, rawY: number): StrokePoint | null {
    if (this.box === null || this.count >= this.options.maxStrokePoints) {
      return null;
    }
    const stamp = this.options.now();
    const distance = Math.hypot(rawX - this.lastRawX, rawY - this.lastRawY);
    if (
      stamp - this.lastSampleAt < this.options.sampleIntervalMs &&
      distance < this.options.sampleDistancePx
    ) {
      return null;
    }
    const point = this.accept(rawX, rawY, stamp);
    this.maybeFlush(stamp);
    return point;
  }

  /**
   * Ends the stroke: captures the release position if it moved, then emits
   * `end` with every remaining point and the total `count`. Returns the final
   * sampled point (for drawing) or null.
   */
  end(rawX?: number, rawY?: number): StrokePoint | null {
    if (this.box === null) {
      return null;
    }
    let point: StrokePoint | null = null;
    if (
      rawX !== undefined &&
      rawY !== undefined &&
      this.count < this.options.maxStrokePoints &&
      Math.hypot(rawX - this.lastRawX, rawY - this.lastRawY) >= 1
    ) {
      point = this.accept(rawX, rawY, this.options.now());
    }
    this.finish();
    return point;
  }

  /** Touch cancel: flushes and ends the stroke without a release sample. */
  cancel(): void {
    if (this.box !== null) {
      this.finish();
    }
  }

  /** Drops any active stroke without emitting; used on dispose/hot-swap. */
  reset(): void {
    this.clearTimer();
    this.box = null;
    this.pending = [];
    this.count = 0;
  }

  /** Flushes pending points if the interval elapsed; called by the idle timer. */
  tick(): void {
    if (this.box !== null) {
      this.maybeFlush(this.options.now());
    }
  }

  private accept(rawX: number, rawY: number, stamp: number): StrokePoint {
    const point = this.pointAt(rawX, rawY, stamp);
    this.pending.push(point);
    this.count += 1;
    this.lastRawX = rawX;
    this.lastRawY = rawY;
    this.lastSampleAt = stamp;
    if (this.pending.length > this.options.maxPendingPoints) {
      this.statsValue.coalescedPoints += decimatePoints(
        this.pending,
        Math.floor(this.options.maxPendingPoints / 2),
      );
    }
    return point;
  }

  private maybeFlush(stamp: number): void {
    const due =
      stamp - this.lastFlushAt >= this.options.flushIntervalMs ||
      this.pending.length >= this.options.maxPointsPerBatch;
    if (!due || this.pending.length === 0) {
      this.scheduleIdleFlush();
      return;
    }
    const points = this.pending.slice(0, this.options.maxPointsPerBatch);
    const data: StrokeEventData = {
      points,
      color: this.options.color,
      width: this.options.width,
      phase: "move",
    };
    const bytes = estimateStrokeBytes(data);
    if (this.recentBytes(stamp) + bytes > this.options.maxBytesPerSecond) {
      // Over budget: keep accumulating; the bounded queue decimates if needed.
      this.statsValue.deferredFlushes += 1;
      this.scheduleIdleFlush();
      return;
    }
    this.pending.splice(0, points.length);
    this.lastFlushAt = stamp;
    this.send(data, bytes);
    this.scheduleIdleFlush();
  }

  private finish(): void {
    this.clearTimer();
    const points = this.pending;
    // `end` is never deferred; keep it inside one frame by decimating.
    this.statsValue.coalescedPoints += decimatePoints(points, this.options.maxPendingPoints);
    const data: StrokeEventData = {
      points,
      color: this.options.color,
      width: this.options.width,
      phase: "end",
      count: this.count,
    };
    this.box = null;
    this.pending = [];
    this.count = 0;
    this.send(data);
  }

  private send(data: StrokeEventData, bytes: number = estimateStrokeBytes(data)): void {
    this.sent.push({ at: this.options.now(), bytes });
    this.statsValue.batches += 1;
    this.statsValue.bytes += bytes;
    this.options.emit(data);
  }

  private recentBytes(stamp: number): number {
    while (this.sent.length > 0 && stamp - (this.sent[0]?.at ?? stamp) >= BANDWIDTH_WINDOW_MS) {
      this.sent.shift();
    }
    let total = 0;
    for (const entry of this.sent) {
      total += entry.bytes;
    }
    return total;
  }

  private scheduleIdleFlush(): void {
    const timers = this.options.timers;
    if (timers === undefined || this.timer !== null || this.pending.length === 0) {
      return;
    }
    this.timer = timers.set(() => {
      this.timer = null;
      this.tick();
    }, this.options.flushIntervalMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.options.timers?.clear(this.timer);
      this.timer = null;
    }
  }

  private pointAt(rawX: number, rawY: number, stamp: number): StrokePoint {
    const box = this.box ?? { left: 0, top: 0, width: 1, height: 1 };
    const normalized = normalizeStrokePoint(
      (rawX - box.left) / box.width,
      (rawY - box.top) / box.height,
      Math.round(stamp - this.startedAt),
    );
    return { x: roundCoord(normalized.x), y: roundCoord(normalized.y), t: normalized.t };
  }
}

/**
 * Residency state machine, admission limits and cancellation tokens
 * (spec 12 §5.5, `src/Residency.ts`).
 *
 * One record per payload: a visual payload is identified by cell plus LOD so
 * that a promotion can hold the old LOD resident until the finer one applies,
 * and a simulation payload is identified by cell alone. The public cell state
 * is a projection of these records (12 §3.3); the internal states never leak
 * out of the package.
 *
 * Admission enforces `maxConcurrentLoads` (records in `loading` or
 * `decoding`) and `maxLoadsStartedPerTick`, both reset by `beginTick`. A
 * refused start leaves the record `queued`, which is a normal outcome, not an
 * error. Retry backoff is 15/30/60 ticks for attempts 1/2/3; after the third
 * failure the record stays `failed` until the owning cell re-enters a focus
 * band and `resetForReentry` is called.
 */

import type { CellKey, CellState } from "./contracts/world.js";
import { STREAMING_DEFAULTS } from "./contracts/world.js";
import type { Lod } from "./Lod.js";
import { streamingError } from "./StreamEvents.js";

export type ResidencyState =
  | "unloaded"
  | "queued"
  | "loading"
  | "decoding"
  | "ready"
  | "resident"
  | "evicting"
  | "failed";

export type PayloadKind = "visual" | "sim";

/** Attempts before a payload is parked (12 §5.5). */
export const MAX_LOAD_ATTEMPTS = 3;

export interface PayloadMeta {
  readonly key: CellKey;
  readonly cx: number;
  readonly cy: number;
  readonly kind: PayloadKind;
  /** Target visual LOD; null for a simulation payload. */
  readonly lod: Lod | null;
  readonly url: string;
  readonly expectedBytes: number;
  readonly contentHash: string;
}

export interface PayloadRecord extends PayloadMeta {
  state: ResidencyState;
  /** Completed failed attempts. */
  attempts: number;
  /** Tick at or after which a failed record may be retried; Infinity when parked. */
  retryAtTick: number;
  errorCode: string | null;
  /** In-flight fetch controller; null otherwise. */
  abort: AbortController | null;
  /** Tick the payload reached `ready`. */
  readyAtTick: number;
  /** Tick the payload was last demanded. */
  requestedAtTick: number;
  /** Tick the fetch started. */
  startedAtTick: number;
  /** Latest priority class/score, for diagnostics only. */
  priorityClass: number;
  score: number;
  /** True once `onCellActivate` ran; decides whether deactivate is owed. */
  activated: boolean;
}

/** `visual:<key>:<lod>` or `sim:<key>`. */
export function payloadId(kind: PayloadKind, key: CellKey, lod: Lod | null = null): string {
  return kind === "visual" ? `visual:${key}:${lod ?? 0}` : `sim:${key}`;
}

const TRANSITIONS: Readonly<Record<ResidencyState, readonly ResidencyState[]>> = {
  unloaded: ["queued"],
  queued: ["loading", "unloaded"],
  loading: ["decoding", "unloaded", "failed"],
  decoding: ["ready", "unloaded", "failed"],
  ready: ["resident", "evicting"],
  resident: ["evicting"],
  evicting: ["unloaded"],
  failed: ["unloaded"],
};

/** True when `from -> to` is a legal edge of the 12 §5.5 diagram. */
export function canTransition(from: ResidencyState, to: ResidencyState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** 12 §3.3: the public projection of the internal state. */
export function publicCellState(state: ResidencyState): CellState {
  if (state === "queued" || state === "loading" || state === "decoding") return "loading";
  if (state === "ready" || state === "resident") return "resident";
  if (state === "evicting") return "evicting";
  return "unloaded";
}

/** 12 §5.5 backoff; `attempts` is the number of failures so far. */
export function retryDelayTicks(attempts: number): number {
  if (!Number.isInteger(attempts) || attempts <= 0) {
    throw streamingError("E_STREAM_STATE", "attempts must be a positive integer");
  }
  const table = STREAMING_DEFAULTS.retryBackoffTicks;
  if (attempts > table.length) return Number.POSITIVE_INFINITY;
  return table[attempts - 1] ?? Number.POSITIVE_INFINITY;
}

export interface ResidencyLimits {
  readonly maxConcurrentLoads: number;
  readonly maxLoadsStartedPerTick: number;
}

/** One table per streamer. Records are reused for the lifetime of an entry. */
export class ResidencyTable {
  private readonly records = new Map<string, PayloadRecord>();
  readonly limits: ResidencyLimits;
  private startsThisTick = 0;

  constructor(limits: ResidencyLimits) {
    requirePositiveInt(limits.maxConcurrentLoads, "maxConcurrentLoads");
    requirePositiveInt(limits.maxLoadsStartedPerTick, "maxLoadsStartedPerTick");
    this.limits = limits;
  }

  get size(): number {
    return this.records.size;
  }

  beginTick(): void {
    this.startsThisTick = 0;
  }

  get(id: string): PayloadRecord | undefined {
    return this.records.get(id);
  }

  all(): IterableIterator<PayloadRecord> {
    return this.records.values();
  }

  /**
   * Returns the record for `meta`, creating it in `unloaded` on first demand.
   * Reusing the record keeps the attempt history across LOD swaps and
   * re-admission.
   */
  ensure(meta: PayloadMeta): PayloadRecord {
    const id = payloadId(meta.kind, meta.key, meta.lod);
    const existing = this.records.get(id);
    if (existing !== undefined) return existing;
    const record: PayloadRecord = {
      ...meta,
      state: "unloaded",
      attempts: 0,
      retryAtTick: 0,
      errorCode: null,
      abort: null,
      readyAtTick: 0,
      requestedAtTick: 0,
      startedAtTick: 0,
      priorityClass: 0,
      score: 0,
      activated: false,
    };
    this.records.set(id, record);
    return record;
  }

  /** unloaded -> queued. Idempotent while already queued. */
  admit(record: PayloadRecord, tick: number, priorityClass: number, score: number): void {
    record.requestedAtTick = tick;
    record.priorityClass = priorityClass;
    record.score = score;
    if (record.state === "queued") return;
    this.transition(record, "queued");
  }

  /**
   * queued -> loading when a slot is free. Returns false when the concurrent
   * cap or the per-tick start cap refuses the start; the record stays queued.
   */
  tryStart(record: PayloadRecord, tick: number, abort: AbortController): boolean {
    if (record.state !== "queued") {
      throw streamingError(
        "E_STREAM_STATE",
        `cannot start payload ${record.key} from state ${record.state}`,
      );
    }
    if (this.inFlight() >= this.limits.maxConcurrentLoads) return false;
    if (this.startsThisTick >= this.limits.maxLoadsStartedPerTick) return false;
    this.transition(record, "loading");
    record.abort = abort;
    record.startedAtTick = tick;
    this.startsThisTick += 1;
    return true;
  }

  /** loading -> decoding once the byte length has been validated. */
  markReceived(record: PayloadRecord): void {
    this.transition(record, "decoding");
  }

  /** decoding -> ready. */
  markReady(record: PayloadRecord, tick: number): void {
    this.transition(record, "ready");
    record.readyAtTick = tick;
    record.abort = null;
    record.errorCode = null;
  }

  /** ready -> resident after `onCellActivate`. */
  markResident(record: PayloadRecord): void {
    this.transition(record, "resident");
    record.activated = true;
    record.attempts = 0;
    record.retryAtTick = 0;
  }

  /**
   * loading/decoding -> failed. Schedules the retry; a third failure parks the
   * record with an infinite retry tick.
   */
  markFailed(record: PayloadRecord, code: string, tick: number): void {
    this.transition(record, "failed");
    record.attempts += 1;
    record.abort = null;
    record.errorCode = code;
    record.retryAtTick =
      record.attempts >= MAX_LOAD_ATTEMPTS
        ? Number.POSITIVE_INFINITY
        : tick + retryDelayTicks(record.attempts);
  }

  /** A parked record is eligible again after the player re-enters its band. */
  resetForReentry(record: PayloadRecord): void {
    if (record.state !== "failed") return;
    this.transition(record, "unloaded");
    record.errorCode = null;
    record.retryAtTick = 0;
  }

  /**
   * Cancels a payload that never activated (queued/loading/decoding/ready).
   * `ready` goes to `evicting` so the caller releases handles first; no
   * `onCellDeactivate` is owed because `activated` stays false.
   */
  cancelPending(record: PayloadRecord): void {
    if (record.state === "queued" || record.state === "loading" || record.state === "decoding") {
      record.abort?.abort();
      record.abort = null;
      this.transition(record, "unloaded");
      return;
    }
    if (record.state === "ready") {
      this.transition(record, "evicting");
      record.abort?.abort();
      record.abort = null;
      return;
    }
    throw streamingError(
      "E_STREAM_STATE",
      `cannot cancel payload ${record.key} from state ${record.state}`,
    );
  }

  /** ready/resident -> evicting. The caller releases handles and calls `release`. */
  beginEvict(record: PayloadRecord): void {
    if (record.state !== "ready" && record.state !== "resident") {
      throw streamingError(
        "E_STREAM_STATE",
        `cannot evict payload ${record.key} from state ${record.state}`,
      );
    }
    this.transition(record, "evicting");
  }

  /** evicting -> unloaded. */
  release(record: PayloadRecord): void {
    this.transition(record, "unloaded");
    record.activated = false;
    record.abort = null;
  }

  /** Removes a record entirely; used when a cell leaves the index (never at runtime). */
  forget(record: PayloadRecord): void {
    record.abort?.abort();
    record.abort = null;
    this.records.delete(payloadId(record.kind, record.key, record.lod));
  }

  /** loading + decoding; 12 §5.5 "at most maxConcurrentLoads are in flight". */
  inFlight(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.state === "loading" || record.state === "decoding") count += 1;
    }
    return count;
  }

  countIn(states: readonly ResidencyState[]): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (states.includes(record.state)) count += 1;
    }
    return count;
  }

  /** True when a failed record may retry at `tick`. */
  isRetryable(record: PayloadRecord, tick: number): boolean {
    return record.state === "failed" && tick >= record.retryAtTick;
  }

  /** Restores a retryable record to `unloaded` so admission can re-queue it. */
  readyRetry(record: PayloadRecord, tick: number): boolean {
    if (!this.isRetryable(record, tick)) return false;
    this.transition(record, "unloaded");
    record.retryAtTick = 0;
    return true;
  }

  /** Every record of one cell, in visual-LOD then sim order. */
  forCell(key: CellKey): PayloadRecord[] {
    const result: PayloadRecord[] = [];
    for (let lod = 0; lod < 4; lod += 1) {
      const visual = this.records.get(payloadId("visual", key, lod as Lod));
      if (visual !== undefined) result.push(visual);
    }
    const sim = this.records.get(payloadId("sim", key));
    if (sim !== undefined) result.push(sim);
    return result;
  }

  clear(): void {
    for (const record of this.records.values()) {
      record.abort?.abort();
      record.abort = null;
    }
    this.records.clear();
    this.startsThisTick = 0;
  }

  private transition(record: PayloadRecord, next: ResidencyState): void {
    if (!canTransition(record.state, next)) {
      throw streamingError(
        "E_STREAM_STATE",
        `illegal residency transition ${record.state} -> ${next} for ${record.key}`,
      );
    }
    record.state = next;
  }
}

function requirePositiveInt(value: number, what: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw streamingError("E_STREAM_STATE", `${what} must be a positive integer`);
  }
  return value;
}

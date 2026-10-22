/**
 * Controller event send queue (D5-CTRL-05; FR-7.8, FR-7.9, FR-7.15, SR-6, SR-13).
 *
 * Every control event passes through this queue (D5 anti-rework: controls
 * never send directly). It implements `ControlEventSink`, so the integration
 * owner passes one instance as `ControlContext.events` and supplies a
 * transport over the existing WebSocket. The queue never inspects `data`
 * beyond JSON serialization (FR-7.9) and never stores events after sending.
 *
 * Policy:
 * - Rate: token bucket, 30/s sustained, burst 60 (matches the server limit,
 *   which stays authoritative — defense in depth).
 * - Size: the whole `{t:"event",slot,name,data}` frame must fit 4096 UTF-8
 *   bytes; larger events are dropped before send with a counter (SR-6).
 * - Names must be wire-safe identifiers (`isValidEventName`, SR-13).
 * - Priorities when the bucket is empty:
 *   - `high` (text/choice) waits for a token; never silently dropped. A
 *     transport failure is retried once, then reported via `onDrop`.
 *   - `low` (strokes) waits and coalesces with a queued tail of the same name
 *     through the injected `coalesce` hook (default: stroke `move` merge).
 *   - `normal` (ephemeral) is dropped with a `rateLimited` counter.
 * - Bounded: at most `maxPending` (50) queued events; on overflow the oldest
 *   non-high event is dropped (oldest high only if nothing else remains).
 * - Disconnect (transport closed or no slot): events buffer; entries older
 *   than `maxBufferAgeMs` (5 s) are dropped as stale; `drain()` after the
 *   rejoin flushes the rest in order.
 *
 * Time and timers are injected so tests are deterministic.
 */
import { MAX_JSON_FRAME_BYTES, type EventMessage, type JsonValue } from "@lanpad/protocol";
import { isValidEventName } from "@lanpad/sdk";
import type { ControlEventPriority, ControlEventSink } from "../controls/eventSink.js";
import { coalesceStrokeData } from "../controls/strokeBatcher.js";

export const EVENT_RATE_PER_SECOND = 30;
export const EVENT_BURST = 60;
export const EVENT_MAX_PENDING = 50;
export const EVENT_MAX_BUFFER_AGE_MS = 5_000;

/** Absorbs float drift in the refill (e.g. 1000/30 ms x 30/s = 0.999...). */
const TOKEN_EPSILON = 1e-6;

/** Worst-case slot digits used when sizing a frame before the slot is known. */
const SIZING_SLOT = 255;

/** What the queue needs from the socket layer; owned by the D4 client. */
export interface EventTransport {
  /** True when a frame can be sent now (socket open and joined). */
  isOpen(): boolean;
  /** Sends one serialized JSON frame; false when the socket refused it. */
  send(frame: string): boolean;
}

export interface EventQueueTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

/** Merges a queued payload with a newer one; null when not coalescible. */
export type EventCoalescer = (previous: JsonValue, next: JsonValue) => JsonValue | null;

export type EventDropReason =
  | "invalidName"
  | "unserializable"
  | "tooLarge"
  | "rateLimited"
  | "overflow"
  | "stale"
  | "sendFailed";

export interface EventQueueOptions {
  transport: EventTransport;
  /** Slot from the joined state; null before join (events buffer). */
  getSlot: () => number | null;
  now: () => number;
  /** Retry scheduler for pending events; omit to drain only on demand. */
  timers?: EventQueueTimers;
  coalesce?: EventCoalescer;
  ratePerSecond?: number;
  burst?: number;
  maxPending?: number;
  maxBufferAgeMs?: number;
  maxFrameBytes?: number;
  /** Non-silent drop report (debug overlay, "not sent" UI). */
  onDrop?: (name: string, priority: ControlEventPriority, reason: EventDropReason) => void;
  /** Fires when `busy` (a high-priority event is waiting) changes. */
  onBusyChange?: (busy: boolean) => void;
}

export interface EventQueueStats {
  pending: number;
  sent: number;
  coalesced: number;
  dropped: Record<EventDropReason, number>;
  /** Milliseconds since the last successful send; null before the first. */
  lastSendAge: number | null;
  busy: boolean;
}

interface QueuedEvent {
  name: string;
  data: JsonValue;
  priority: ControlEventPriority;
  enqueuedAt: number;
  retried: boolean;
}

const encoder = new TextEncoder();

function emptyDrops(): Record<EventDropReason, number> {
  return {
    invalidName: 0,
    unserializable: 0,
    tooLarge: 0,
    rateLimited: 0,
    overflow: 0,
    stale: 0,
    sendFailed: 0,
  };
}

export class EventQueue implements ControlEventSink {
  private readonly transport: EventTransport;
  private readonly getSlot: () => number | null;
  private readonly now: () => number;
  private readonly timers: EventQueueTimers | undefined;
  private readonly coalesce: EventCoalescer;
  private readonly rate: number;
  private readonly burst: number;
  private readonly maxPending: number;
  private readonly maxBufferAgeMs: number;
  private readonly maxFrameBytes: number;
  private readonly onDrop: EventQueueOptions["onDrop"];
  private readonly onBusyChange: EventQueueOptions["onBusyChange"];

  private readonly queue: QueuedEvent[] = [];
  private readonly dropped = emptyDrops();
  private tokens: number;
  private refilledAt: number;
  private sent = 0;
  private coalesced = 0;
  private lastSentAt: number | null = null;
  private busy = false;
  private timer: unknown = null;

  constructor(options: EventQueueOptions) {
    this.transport = options.transport;
    this.getSlot = options.getSlot;
    this.now = options.now;
    this.timers = options.timers;
    this.coalesce = options.coalesce ?? coalesceStrokeData;
    this.rate = options.ratePerSecond ?? EVENT_RATE_PER_SECOND;
    this.burst = options.burst ?? EVENT_BURST;
    this.maxPending = options.maxPending ?? EVENT_MAX_PENDING;
    this.maxBufferAgeMs = options.maxBufferAgeMs ?? EVENT_MAX_BUFFER_AGE_MS;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_JSON_FRAME_BYTES;
    this.onDrop = options.onDrop;
    this.onBusyChange = options.onBusyChange;
    this.tokens = this.burst;
    this.refilledAt = this.now();
  }

  /** `ControlEventSink`: validates, queues and sends as tokens allow. */
  enqueue(name: string, data: JsonValue, priority: ControlEventPriority = "normal"): void {
    if (!isValidEventName(name)) {
      this.drop(name, priority, "invalidName");
      return;
    }
    // Size check up front with a worst-case slot so an oversized event never
    // occupies the queue; the real frame is re-measured at send time.
    const size = this.frameBytes(name, data);
    if (size === null) {
      this.drop(name, priority, "unserializable");
      return;
    }
    if (size > this.maxFrameBytes) {
      this.drop(name, priority, "tooLarge");
      return;
    }

    this.refill();
    const connected = this.isConnected();
    const canSendNow = connected && this.queue.length === 0 && this.hasToken();

    if (!canSendNow && connected && priority === "normal") {
      // Ephemeral events are not worth delaying behind the limit.
      this.drop(name, priority, "rateLimited");
      return;
    }
    if (!canSendNow && priority === "low" && this.tryCoalesce(name, data)) {
      this.drain();
      return;
    }
    if (this.queue.length >= this.maxPending) {
      this.evictOne();
    }
    this.queue.push({ name, data, priority, enqueuedAt: this.now(), retried: false });
    this.drain();
  }

  /**
   * Sends queued events in order while tokens and the transport allow. Call
   * after (re)join; it also runs from the internal retry timer. Returns the
   * number of frames sent.
   */
  drain(): number {
    this.clearTimer();
    this.dropStale();
    let sentNow = 0;
    while (this.queue.length > 0) {
      const slot = this.getSlot();
      if (slot === null || !this.transport.isOpen()) {
        break;
      }
      this.refill();
      if (!this.hasToken()) {
        break;
      }
      const head = this.queue[0];
      if (head === undefined) {
        break;
      }
      const message: EventMessage = { t: "event", slot, name: head.name, data: head.data };
      const frame = JSON.stringify(message);
      if (encoder.encode(frame).byteLength > this.maxFrameBytes) {
        this.queue.shift();
        this.drop(head.name, head.priority, "tooLarge");
        continue;
      }
      if (!this.transport.send(frame)) {
        if (head.priority === "high" && !head.retried) {
          // Retry once on the next drain; stop here so order is preserved.
          head.retried = true;
          break;
        }
        this.queue.shift();
        this.drop(head.name, head.priority, "sendFailed");
        continue;
      }
      this.queue.shift();
      this.tokens = Math.max(0, this.tokens - 1);
      this.sent += 1;
      sentNow += 1;
      this.lastSentAt = this.now();
    }
    this.updateBusy();
    this.scheduleRetry();
    return sentNow;
  }

  stats(): EventQueueStats {
    return {
      pending: this.queue.length,
      sent: this.sent,
      coalesced: this.coalesced,
      dropped: { ...this.dropped },
      lastSendAge: this.lastSentAt === null ? null : this.now() - this.lastSentAt,
      busy: this.busy,
    };
  }

  /** Drops everything without counting (kick/leave); stops the retry timer. */
  clear(): void {
    this.clearTimer();
    this.queue.length = 0;
    this.updateBusy();
  }

  private isConnected(): boolean {
    return this.transport.isOpen() && this.getSlot() !== null;
  }

  private hasToken(): boolean {
    return this.tokens >= 1 - TOKEN_EPSILON;
  }

  private refill(): void {
    const stamp = this.now();
    const elapsed = Math.max(0, stamp - this.refilledAt);
    this.refilledAt = stamp;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.rate) / 1_000);
  }

  private tryCoalesce(name: string, data: JsonValue): boolean {
    const tail = this.queue[this.queue.length - 1];
    if (tail === undefined || tail.name !== name || tail.priority !== "low") {
      return false;
    }
    const merged = this.coalesce(tail.data, data);
    if (merged === null) {
      return false;
    }
    const size = this.frameBytes(name, merged);
    if (size === null || size > this.maxFrameBytes) {
      return false;
    }
    tail.data = merged;
    this.coalesced += 1;
    return true;
  }

  private evictOne(): void {
    let index = this.queue.findIndex((queued) => queued.priority !== "high");
    if (index < 0) {
      index = 0;
    }
    const [evicted] = this.queue.splice(index, 1);
    if (evicted !== undefined) {
      this.drop(evicted.name, evicted.priority, "overflow");
    }
  }

  private dropStale(): void {
    const stamp = this.now();
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index];
      if (queued !== undefined && stamp - queued.enqueuedAt > this.maxBufferAgeMs) {
        this.queue.splice(index, 1);
        this.drop(queued.name, queued.priority, "stale");
      }
    }
  }

  private frameBytes(name: string, data: JsonValue): number | null {
    const message: EventMessage = { t: "event", slot: SIZING_SLOT, name, data };
    try {
      const text = JSON.stringify(message);
      return typeof text === "string" ? encoder.encode(text).byteLength : null;
    } catch {
      return null;
    }
  }

  private drop(name: string, priority: ControlEventPriority, reason: EventDropReason): void {
    this.dropped[reason] += 1;
    this.onDrop?.(name, priority, reason);
  }

  private updateBusy(): void {
    const busy = this.queue.some((queued) => queued.priority === "high");
    if (busy !== this.busy) {
      this.busy = busy;
      this.onBusyChange?.(busy);
    }
  }

  private scheduleRetry(): void {
    if (this.timers === undefined || this.queue.length === 0 || !this.isConnected()) {
      return;
    }
    const wait = this.hasToken() ? 0 : Math.ceil(((1 - this.tokens) * 1_000) / this.rate);
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.drain();
    }, wait);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers?.clear(this.timer);
      this.timer = null;
    }
  }
}

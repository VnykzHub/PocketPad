/**
 * Controller-event routing for games (D5-RT-01; FR-7.9, FR-7.12, FR-7.17,
 * D5 contracts 4, 7).
 *
 * The server forwards `{t:"event", slot, name, data}` unchanged after checking
 * the authenticated slot and its rate limit. `EventRouter` is the host's
 * second line of defense and the game-facing dispatch point:
 *
 * - validates slot, event name, JSON payload shape (depth-bounded) and
 *   serialized size before accepting a body (D5-SEC-01);
 * - queues accepted events in the fixed 256-entry ring from `InputReader`;
 * - forwards each accepted event to the host (the game's `onEvent` path);
 * - invokes per-name handlers from `dispatch()`, which the host calls at the
 *   start of `simulate`; each event is drained exactly once;
 * - routes unhandled names to `onAny` handlers or drops them with a counter.
 *
 * Events are `JsonValue`; games validate their own payload shape and render
 * user text with `textContent` only (SR-13). Nothing here touches the DOM or a
 * socket (FR-7.17).
 */
import {
  MAX_CONTROLLERS,
  MAX_JSON_FRAME_BYTES,
  jsonByteLength,
} from "@lanpad/protocol";
import type {
  GameEvent,
  GameEvents,
  JsonValue,
} from "@lanpad/sdk";
import {
  DEFAULT_EVENT_CAPACITY,
  GameEventQueue,
} from "./InputReader.js";
import { isSafeEventName, isSafeEventPayload } from "./safeData.js";

/** The game-facing event subscription surface (`ctx.events`). */
export type { GameEvents } from "@lanpad/sdk";

/** Destination for accepted events (the host's game event queue). */
export interface EventSink {
  push(slot: number, name: string, data: JsonValue): void;
}

export interface EventRouterOptions {
  /** Ring capacity; default 256 (D5). */
  readonly capacity?: number;
  /** Forwarding sink; the host wires `gameHost.pushEvent` here. */
  readonly sink?: EventSink | null;
  /** Maximum serialized envelope size; default the 4096-byte JSON frame cap. */
  readonly maxEventBytes?: number;
}

export interface EventRouterCounters {
  /** Events accepted into the ring (and forwarded to the sink). */
  readonly received: number;
  /** Events rejected for slot, name or size. */
  readonly invalid: number;
  /** Unknown-name events dropped because no catch-all was registered. */
  readonly unknown: number;
  /** Events handed to handlers by `dispatch()`. */
  readonly dispatched: number;
  /** Events lost to ring overflow (oldest first). */
  readonly dropped: number;
}

type EventHandler = (event: GameEvent) => void;

function serializedEnvelopeBytes(slot: number, name: string, data: JsonValue): number | null {
  try {
    const text = JSON.stringify({ t: "event", slot, name, data });
    return text === undefined ? null : jsonByteLength(text);
  } catch {
    // Circular or BigInt payloads cannot be delivered as JSON.
    return null;
  }
}

export class EventRouter implements GameEvents {
  private readonly queue: GameEventQueue;
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly fallbacks = new Set<EventHandler>();
  private readonly maxEventBytes: number;
  private sink: EventSink | null;
  private receivedCount = 0;
  private invalidCount = 0;
  private unknownCount = 0;
  private dispatchedCount = 0;

  constructor(options: EventRouterOptions = {}) {
    this.queue = new GameEventQueue(options.capacity ?? DEFAULT_EVENT_CAPACITY);
    this.maxEventBytes = options.maxEventBytes ?? MAX_JSON_FRAME_BYTES;
    if (!Number.isFinite(this.maxEventBytes) || this.maxEventBytes < 1) {
      throw new RangeError("EventRouter maxEventBytes must be a positive number.");
    }
    this.sink = options.sink ?? null;
  }

  get capacity(): number {
    return this.queue.capacity;
  }

  /** Accepted events waiting for the next `dispatch()`. */
  get pending(): number {
    return this.queue.pending;
  }

  get counters(): EventRouterCounters {
    return {
      received: this.receivedCount,
      invalid: this.invalidCount,
      unknown: this.unknownCount,
      dispatched: this.dispatchedCount,
      dropped: this.queue.dropped,
    };
  }

  /** Wires or clears the forwarding sink (host construction/teardown). */
  setSink(sink: EventSink | null): void {
    this.sink = sink;
  }

  /**
   * Validates and queues one server event. Returns false (and counts it) when
   * the slot, name, payload shape or size is invalid; the event is forwarded
   * to the sink only after validation.
   */
  receive(slot: number, name: string, data: JsonValue): boolean {
    if (
      !Number.isInteger(slot) ||
      slot < 1 ||
      slot > MAX_CONTROLLERS ||
      !isSafeEventName(name) ||
      !isSafeEventPayload(data)
    ) {
      this.invalidCount += 1;
      return false;
    }
    const bytes = serializedEnvelopeBytes(slot, name, data);
    if (bytes === null || bytes > this.maxEventBytes) {
      this.invalidCount += 1;
      return false;
    }

    this.queue.push(slot, name, data);
    this.receivedCount += 1;
    if (this.sink !== null) {
      try {
        this.sink.push(slot, name, data);
      } catch {
        // Forwarding is best-effort; the router's own copy is still delivered.
      }
    }
    return true;
  }

  /** Registers a named handler. Invalid names are a developer error. */
  on(name: string, handler: EventHandler): () => void {
    if (!isSafeEventName(name)) {
      throw new RangeError(
        `ctx.events.on name "${String(name)}" must match ^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$.`,
      );
    }
    if (typeof handler !== "function") {
      throw new TypeError("ctx.events.on handler must be a function.");
    }
    let handlers = this.handlers.get(name);
    if (handlers === undefined) {
      handlers = new Set<EventHandler>();
      this.handlers.set(name, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  /** Registers a catch-all for names without a named handler. */
  onAny(handler: EventHandler): () => void {
    if (typeof handler !== "function") {
      throw new TypeError("ctx.events.onAny handler must be a function.");
    }
    this.fallbacks.add(handler);
    return () => {
      this.fallbacks.delete(handler);
    };
  }

  /**
   * Drains the ring once and invokes handlers in arrival order. The returned
   * array is the queue's pooled per-tick view; copy events you retain.
   */
  dispatch(): ReadonlyArray<GameEvent> {
    const events = this.queue.drain();
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event === undefined) {
        continue;
      }
      const named = this.handlers.get(event.name);
      if (named !== undefined && named.size > 0) {
        for (const handler of [...named]) {
          handler(event);
        }
      } else if (this.fallbacks.size > 0) {
        for (const handler of [...this.fallbacks]) {
          handler(event);
        }
      } else {
        this.unknownCount += 1;
      }
      this.dispatchedCount += 1;
    }
    return events;
  }

  /** Drops pending events and clears subscriptions (host teardown). */
  clear(): void {
    this.queue.clear();
    this.handlers.clear();
    this.fallbacks.clear();
    this.sink = null;
  }
}

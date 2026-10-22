/**
 * Event queue tests (D5-CTRL-05; FR-7.8, FR-7.9, FR-7.15, SR-6, SR-13).
 *
 * A fake transport records frames; a fake clock plus a tiny timer scheduler
 * drive the token bucket and the retry timer deterministically.
 */
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@lanpad/protocol";
import {
  EventQueue,
  type EventDropReason,
  type EventQueueOptions,
  type EventQueueTimers,
} from "../src/events/EventQueue.js";
import type { ControlEventPriority, StrokeEventData } from "../src/controls/eventSink.js";

interface Harness {
  queue: EventQueue;
  frames: string[];
  clock: { now: number };
  link: { open: boolean; slot: number | null; failSends: number };
  drops: { name: string; priority: ControlEventPriority; reason: EventDropReason }[];
  busy: boolean[];
  advance: (ms: number) => void;
}

function harness(overrides: Partial<EventQueueOptions> = {}): Harness {
  const clock = { now: 10_000 };
  const frames: string[] = [];
  const link: Harness["link"] = { open: true, slot: 3, failSends: 0 };
  const drops: Harness["drops"] = [];
  const busy: boolean[] = [];
  let scheduled: { at: number; callback: () => void; handle: number }[] = [];
  let nextHandle = 1;
  const timers: EventQueueTimers = {
    set: (callback, delayMs) => {
      const handle = nextHandle++;
      scheduled.push({ at: clock.now + delayMs, callback, handle });
      return handle;
    },
    clear: (handle) => {
      scheduled = scheduled.filter((entry) => entry.handle !== handle);
    },
  };
  const queue = new EventQueue({
    transport: {
      isOpen: () => link.open,
      send: (frame) => {
        if (link.failSends > 0) {
          link.failSends -= 1;
          return false;
        }
        frames.push(frame);
        return true;
      },
    },
    getSlot: () => link.slot,
    now: () => clock.now,
    timers,
    onDrop: (name, priority, reason) => drops.push({ name, priority, reason }),
    onBusyChange: (value) => busy.push(value),
    ...overrides,
  });
  const advance = (ms: number): void => {
    const target = clock.now + ms;
    for (;;) {
      scheduled.sort((a, b) => a.at - b.at);
      const next = scheduled[0];
      if (next === undefined || next.at > target) {
        break;
      }
      scheduled.shift();
      clock.now = Math.max(clock.now, next.at);
      next.callback();
    }
    clock.now = target;
  };
  return { queue, frames, clock, link, drops, busy, advance };
}

interface ParsedFrame {
  t: string;
  slot: number;
  name: string;
  data: JsonValue;
}

function parsed(frame: string | undefined): ParsedFrame {
  return JSON.parse(frame ?? "null") as ParsedFrame;
}

function stroke(phase: StrokeEventData["phase"], x: number): StrokeEventData {
  return { points: [{ x, y: 0.5, t: Math.round(x * 1000) }], color: "#fff", width: 6, phase };
}

describe("[FR-7.8] event queue enforces 30/s with burst 60", () => {
  it("[FR-7.8] a burst of 61 sends 60 and drops one ephemeral event with a counter", () => {
    const h = harness();
    for (let index = 0; index < 61; index += 1) {
      h.queue.enqueue("ping", { index });
    }
    expect(h.frames).toHaveLength(60);
    const stats = h.queue.stats();
    expect(stats.sent).toBe(60);
    expect(stats.dropped.rateLimited).toBe(1);
    expect(h.drops).toEqual([{ name: "ping", priority: "normal", reason: "rateLimited" }]);
  });

  it("[FR-7.8] sustained 30/s passes after the burst is spent", () => {
    const h = harness();
    for (let index = 0; index < 60; index += 1) {
      h.queue.enqueue("ping", index);
    }
    // 10 s at exactly the sustained rate.
    for (let index = 0; index < 300; index += 1) {
      h.advance(1_000 / 30);
      h.queue.enqueue("ping", index);
    }
    expect(h.queue.stats().dropped.rateLimited).toBe(0);
    expect(h.frames).toHaveLength(360);
  });

  it("[FR-7.8] text/choice events wait for a token instead of being dropped", () => {
    const h = harness();
    for (let index = 0; index < 60; index += 1) {
      h.queue.enqueue("ping", index);
    }
    h.queue.enqueue("answer", { value: "cat" }, "high");
    expect(h.frames).toHaveLength(60);
    expect(h.queue.stats()).toMatchObject({ pending: 1, busy: true });
    expect(h.busy).toEqual([true]);

    h.advance(40);
    expect(h.frames).toHaveLength(61);
    expect(parsed(h.frames[60]).data).toEqual({ value: "cat" });
    expect(h.queue.stats()).toMatchObject({ pending: 0, busy: false });
    expect(h.busy).toEqual([true, false]);
    expect(h.drops).toHaveLength(0);
  });

  it("[FR-7.8] ordering is preserved when events wait", () => {
    const h = harness({ burst: 2 });
    h.queue.enqueue("a", 1, "high");
    h.queue.enqueue("b", 2, "high");
    h.queue.enqueue("c", 3, "high");
    h.queue.enqueue("d", 4, "low");
    h.queue.enqueue("e", 5, "high");
    h.advance(1_000);
    expect(h.frames.map((frame) => parsed(frame).name)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("[FR-7.8] stroke events coalesce instead of flooding", () => {
  it("[FR-7.8] queued move batches merge into the tail; start and end stay separate", () => {
    const h = harness({ burst: 1 });
    h.queue.enqueue("draw", stroke("start", 0.1), "low");
    for (let index = 0; index < 10; index += 1) {
      h.queue.enqueue("draw", stroke("move", 0.2 + index / 100), "low");
    }
    h.queue.enqueue("draw", stroke("end", 0.9), "low");

    const stats = h.queue.stats();
    expect(stats.coalesced).toBe(9);
    expect(stats.pending).toBe(2);

    h.advance(1_000);
    const sent = h.frames.map((frame) => parsed(frame).data as StrokeEventData);
    expect(sent.map((data) => data.phase)).toEqual(["start", "move", "end"]);
    expect(sent[1]?.points).toHaveLength(10);
    expect(h.queue.stats().dropped.rateLimited).toBe(0);
  });

  it("[FR-7.8] the bounded queue evicts the oldest non-high event first", () => {
    const h = harness({ maxPending: 3 });
    h.link.open = false;
    h.queue.enqueue("answer", { value: "keep" }, "high");
    h.queue.enqueue("draw", stroke("start", 0.1), "low");
    h.queue.enqueue("draw", stroke("end", 0.2), "low");
    h.queue.enqueue("vote", { value: "b" }, "high");
    expect(h.drops).toEqual([{ name: "draw", priority: "low", reason: "overflow" }]);
    expect(h.queue.stats()).toMatchObject({ pending: 3 });
  });
});

describe("[SR-6] oversized events are dropped before send", () => {
  it("[SR-6] a 4.1 KB event is rejected before it reaches the transport", () => {
    const h = harness();
    h.queue.enqueue("big", { blob: "x".repeat(4_100) }, "high");
    expect(h.frames).toHaveLength(0);
    expect(h.queue.stats()).toMatchObject({ pending: 0, busy: false });
    expect(h.queue.stats().dropped.tooLarge).toBe(1);
    expect(h.drops).toEqual([{ name: "big", priority: "high", reason: "tooLarge" }]);
  });

  it("[SR-6] a frame just under 4096 bytes is sent", () => {
    const h = harness();
    h.queue.enqueue("big", { blob: "x".repeat(4_000) });
    expect(h.frames).toHaveLength(1);
    expect(new TextEncoder().encode(h.frames[0]).byteLength).toBeLessThanOrEqual(4_096);
  });

  it("[SR-6] size counts UTF-8 bytes, not UTF-16 units", () => {
    const h = harness();
    // 1,400 three-byte characters = 4,200 bytes but only 1,400 code units.
    h.queue.enqueue("big", { text: "€".repeat(1_400) });
    expect(h.frames).toHaveLength(0);
    expect(h.queue.stats().dropped.tooLarge).toBe(1);
  });
});

describe("[SR-13] event names and payloads are validated", () => {
  it("[SR-13] unsafe event names never leave the phone", () => {
    const h = harness();
    h.queue.enqueue("<script>", { value: "x" }, "high");
    h.queue.enqueue("", 1);
    expect(h.frames).toHaveLength(0);
    expect(h.queue.stats().dropped.invalidName).toBe(2);
  });

  it("[SR-13] unserializable payloads are dropped with a counter", () => {
    const h = harness();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    h.queue.enqueue("bad", circular as unknown as JsonValue);
    expect(h.frames).toHaveLength(0);
    expect(h.queue.stats().dropped.unserializable).toBe(1);
  });
});

describe("[FR-7.9] events are opaque to the client transport layer", () => {
  it("[FR-7.9] the frame carries the joined slot and the data unchanged", () => {
    const h = harness();
    const data = { nested: { list: [1, "two", null, true] }, html: "<b>x</b>" };
    h.queue.enqueue("custom.event", data);
    expect(parsed(h.frames[0])).toEqual({ t: "event", slot: 3, name: "custom.event", data });
  });
});

describe("[FR-7.15] buffered events flush after reconnect", () => {
  it("[FR-7.15] events buffer while disconnected and flush in order on drain", () => {
    const h = harness();
    h.link.open = false;
    h.queue.enqueue("a", 1, "high");
    h.queue.enqueue("b", 2);
    h.queue.enqueue("c", 3, "low");
    expect(h.frames).toHaveLength(0);
    expect(h.queue.stats().pending).toBe(3);

    h.link.open = true;
    expect(h.queue.drain()).toBe(3);
    expect(h.frames.map((frame) => parsed(frame).name)).toEqual(["a", "b", "c"]);
  });

  it("[FR-7.15] no slot (not joined) buffers like a closed socket", () => {
    const h = harness();
    h.link.slot = null;
    h.queue.enqueue("a", 1);
    expect(h.frames).toHaveLength(0);
    h.link.slot = 5;
    h.queue.drain();
    expect(parsed(h.frames[0]).slot).toBe(5);
  });

  it("[FR-7.15] events older than 5 s are dropped as stale with a counter", () => {
    const h = harness();
    h.link.open = false;
    h.queue.enqueue("old", 1, "high");
    h.advance(4_000);
    h.queue.enqueue("fresh", 2, "high");
    h.advance(1_500);
    h.link.open = true;
    h.queue.drain();
    expect(h.frames.map((frame) => parsed(frame).name)).toEqual(["fresh"]);
    expect(h.drops).toEqual([{ name: "old", priority: "high", reason: "stale" }]);
  });

  it("[FR-7.15] the disconnect buffer is capped at 50 events", () => {
    const h = harness();
    h.link.open = false;
    for (let index = 0; index < 55; index += 1) {
      h.queue.enqueue("tick", index);
    }
    expect(h.queue.stats().pending).toBe(50);
    expect(h.queue.stats().dropped.overflow).toBe(5);
    h.link.open = true;
    h.queue.drain();
    expect(parsed(h.frames[0]).data).toBe(5);
  });
});

describe("[FR-7.8] transport failures and diagnostics", () => {
  it("[FR-7.8] a failed high-priority send is retried once, then reported", () => {
    const h = harness();
    h.link.failSends = 1;
    h.queue.enqueue("answer", { value: "a" }, "high");
    expect(h.frames).toHaveLength(0);
    h.advance(0);
    expect(h.frames).toHaveLength(1);

    h.link.failSends = 2;
    h.queue.enqueue("answer", { value: "b" }, "high");
    h.advance(0);
    expect(h.frames).toHaveLength(1);
    expect(h.drops).toEqual([{ name: "answer", priority: "high", reason: "sendFailed" }]);
  });

  it("[FR-7.8] stats expose pending, dropped and lastSendAge for the overlay", () => {
    const h = harness();
    expect(h.queue.stats().lastSendAge).toBeNull();
    h.queue.enqueue("ping", 1);
    h.advance(250);
    expect(h.queue.stats()).toMatchObject({ pending: 0, sent: 1, lastSendAge: 250 });
  });

  it("[FR-7.8] clear empties the queue without counting drops", () => {
    const h = harness();
    h.link.open = false;
    h.queue.enqueue("answer", { value: "x" }, "high");
    h.queue.clear();
    expect(h.queue.stats()).toMatchObject({ pending: 0, busy: false });
    expect(h.drops).toHaveLength(0);
  });
});

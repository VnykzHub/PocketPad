/**
 * D5-RT-01: server event validation, queueing and start-of-tick dispatch.
 */
import type { JsonValue } from "@lanpad/protocol";
import type { GameEvent } from "@lanpad/sdk";
import { describe, expect, test } from "vitest";
import { EventRouter, type EventSink } from "../src/game/EventRouter.js";

describe("D5-RT-01 EventRouter", () => {
  test("valid events reach named handlers exactly once per dispatch", () => {
    const router = new EventRouter();
    const received: GameEvent[] = [];
    router.on("vote", (event) => {
      received.push({ ...event });
    });

    expect(router.receive(2, "vote", { choice: 1 })).toBe(true);
    expect(router.pending).toBe(1);
    router.dispatch();

    expect(received).toEqual([{ slot: 2, name: "vote", data: { choice: 1 } }]);
    expect(router.counters).toMatchObject({ received: 1, dispatched: 1, invalid: 0 });
    router.dispatch();
    expect(received).toHaveLength(1);
  });

  test("unknown names go to onAny, or are counted when nobody listens", () => {
    const router = new EventRouter();
    const any: string[] = [];
    router.onAny((event) => {
      any.push(event.name);
    });

    router.receive(1, "a", null);
    router.receive(1, "b", null);
    router.dispatch();

    expect(any).toEqual(["a", "b"]);
    expect(router.counters.unknown).toBe(0);

    const silent = new EventRouter();
    silent.receive(1, "nobody", null);
    silent.dispatch();
    expect(silent.counters.unknown).toBe(1);
  });

  test("named handlers win over onAny", () => {
    const router = new EventRouter();
    const calls: string[] = [];
    router.on("vote", () => calls.push("named"));
    router.onAny(() => calls.push("any"));

    router.receive(1, "vote", null);
    router.receive(1, "other", null);
    router.dispatch();

    expect(calls).toEqual(["named", "any"]);
  });

  test("invalid slot or event name is rejected before queueing", () => {
    const router = new EventRouter();
    const seen: GameEvent[] = [];
    router.onAny((event) => seen.push(event));

    expect(router.receive(0, "vote", null)).toBe(false);
    expect(router.receive(9, "vote", null)).toBe(false);
    expect(router.receive(1, "not valid!", null)).toBe(false);
    expect(router.receive(1, "", null)).toBe(false);

    router.dispatch();
    expect(seen).toHaveLength(0);
    expect(router.pending).toBe(0);
    expect(router.counters.invalid).toBe(4);
  });

  test("[SR-13][FR-7.9] receive rejects payloads that cannot be safe JSON", () => {
    const router = new EventRouter();
    const pushed: JsonValue[] = [];
    router.setSink({ push: (_slot, _name, data) => pushed.push(data) });

    expect(router.receive(1, "answer", undefined as never)).toBe(false);
    expect(router.receive(1, "answer", Number.NaN as unknown as JsonValue)).toBe(false);

    let deep: JsonValue = "leaf";
    for (let level = 0; level < 12; level += 1) {
      deep = { nested: deep };
    }
    expect(router.receive(1, "answer", deep)).toBe(false);

    expect(router.receive(1, "answer", { value: "ok" })).toBe(true);
    expect(router.receive(1, 42 as never, null)).toBe(false);

    expect(pushed).toEqual([{ value: "ok" }]);
    expect(router.counters.invalid).toBe(4);
  });

  test("[SR-6] oversized payloads are rejected for the 4096-byte frame budget", () => {
    const router = new EventRouter({ maxEventBytes: 64 });
    const data = "x".repeat(200) as JsonValue;

    expect(router.receive(1, "vote", data)).toBe(false);
    expect(router.counters.invalid).toBe(1);
  });

  test("the sink receives accepted events for the game's onEvent path", () => {
    const pushed: Array<{ slot: number; name: string; data: JsonValue }> = [];
    const sink: EventSink = {
      push: (slot, name, data) => {
        pushed.push({ slot, name, data });
      },
    };
    const router = new EventRouter({ sink });

    router.receive(4, "chat", "hi");
    router.receive(4, "bad name", "nope");

    expect(pushed).toEqual([{ slot: 4, name: "chat", data: "hi" }]);
  });

  test("overflow drops the oldest event and counts it", () => {
    const router = new EventRouter({ capacity: 2 });
    const names: string[] = [];
    router.onAny((event) => names.push(event.name));

    router.receive(1, "a", null);
    router.receive(1, "b", null);
    router.receive(1, "c", null);
    router.dispatch();

    expect(names).toEqual(["b", "c"]);
    expect(router.counters.dropped).toBe(1);
  });

  test("on() rejects an invalid name and unsubscribe stops delivery", () => {
    const router = new EventRouter();
    expect(() => router.on("bad name", () => {})).toThrow(RangeError);

    let calls = 0;
    const off = router.on("vote", () => {
      calls += 1;
    });
    router.receive(1, "vote", null);
    router.dispatch();
    off();
    router.receive(1, "vote", null);
    router.dispatch();

    expect(calls).toBe(1);
  });
});

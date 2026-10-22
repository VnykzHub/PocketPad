/**
 * D5-SRV-01 event routing: opaque bodies, authenticated slot binding and the
 * per-slot 30/s burst-60 token bucket (FR-7.8, FR-7.9). Registry-level: no
 * sockets and an injected clock.
 */
import { describe, expect, test } from "vitest";
import { MAX_LAYOUT_ID_CHARS, type EventMessage } from "@lanpad/protocol";
import { EVENT_BURST, EVENT_RATE_PER_SECOND } from "../src/room/events.js";
import { FakePeer, makeRegistry, makeRoomHarness } from "./helpers.js";

function eventAt(slot: number, name: string, data: EventMessage["data"]): EventMessage {
  return { t: "event", slot, name, data };
}

function eventsOf(messages: ReturnType<FakePeer["jsonMessages"]>): EventMessage[] {
  return messages.filter((message): message is EventMessage => message.t === "event");
}

describe("event routing", () => {
  test("[FR-7.9] forwards event data untouched and rebuilds the slot from the peer", () => {
    const h = makeRoomHarness();
    const data = {
      points: [{ x: 0.25, y: 0.5, t: 12 }],
      nested: { tags: ["a", "b"], enabled: true, count: 3 },
      unicode: "héllo ✓",
    };

    expect(h.registry.routeEvent(h.code, 1, eventAt(1, "stroke.move", data))).toBe(true);

    expect(eventsOf(h.host.jsonMessages())).toEqual([
      { t: "event", slot: 1, name: "stroke.move", data },
    ]);
    expect(
      h.calls.some((call) => call.event === "event.route" && call.fields.name === "stroke.move"),
    ).toBe(true);
    // SR-9/FR-7.9: names may be logged, bodies never.
    expect(JSON.stringify(h.calls)).not.toContain("héllo");
  });

  test("[FR-7.8] an event claiming another slot is dropped and counted", () => {
    const h = makeRoomHarness({ controllerCount: 2 });

    expect(h.registry.routeEvent(h.code, 1, eventAt(2, "answer", { value: "spoof" }))).toBe(false);
    expect(eventsOf(h.host.jsonMessages())).toHaveLength(0);
    expect(h.registry.getRoom(h.code)?.controllers.get(1)?.drops).toBe(1);
    // Dropping is a counter, not a close: the adapter decides abuse policy.
    expect(h.controllers[0]?.closes).toHaveLength(0);

    expect(h.registry.routeEvent(h.code, 1, eventAt(1, "answer", { value: "ok" }))).toBe(true);
    expect(eventsOf(h.host.jsonMessages())).toEqual([
      { t: "event", slot: 1, name: "answer", data: { value: "ok" } },
    ]);
    expect(h.registry.getRoom(h.code)?.controllers.get(2)?.drops).toBe(0);
  });

  test("[FR-7.8] 61 rapid events yield 60 forwarded and one drop", () => {
    const h = makeRoomHarness();
    let accepted = 0;
    for (let index = 0; index < 61; index += 1) {
      if (h.registry.routeEvent(h.code, 1, eventAt(1, "tick", index))) {
        accepted += 1;
      }
    }

    expect(EVENT_BURST).toBe(60);
    expect(accepted).toBe(EVENT_BURST);
    const forwarded = eventsOf(h.host.jsonMessages());
    expect(forwarded).toHaveLength(60);
    expect(forwarded.map((event) => event.data)).toEqual(
      Array.from({ length: 60 }, (_value, index) => index),
    );
    expect(h.registry.getRoom(h.code)?.controllers.get(1)?.drops).toBe(1);
  });

  test("[FR-7.8] sustained 30/s refill and independent per-slot buckets", () => {
    const h = makeRoomHarness({ controllerCount: 2 });

    // Drain slot 1's burst.
    for (let index = 0; index < EVENT_BURST; index += 1) {
      expect(h.registry.routeEvent(h.code, 1, eventAt(1, "tick", index))).toBe(true);
    }
    expect(h.registry.routeEvent(h.code, 1, eventAt(1, "tick", 60))).toBe(false);

    // Slot 2 starts with its own full bucket.
    expect(h.registry.routeEvent(h.code, 2, eventAt(2, "tick", 0))).toBe(true);

    // One second refills one second's worth of events.
    h.clock.advance(1_000);
    let refilled = 0;
    for (let index = 0; index < EVENT_RATE_PER_SECOND; index += 1) {
      if (h.registry.routeEvent(h.code, 1, eventAt(1, "tick", index))) {
        refilled += 1;
      }
    }
    expect(refilled).toBe(EVENT_RATE_PER_SECOND);
    expect(h.registry.routeEvent(h.code, 1, eventAt(1, "tick", 31))).toBe(false);

    // After the refilled second is spent, 30/s still flows continuously.
    for (let index = 0; index < EVENT_RATE_PER_SECOND; index += 1) {
      h.clock.advance(34);
      expect(h.registry.routeEvent(h.code, 1, eventAt(1, "tick", index))).toBe(true);
    }
  });

  test("[FR-7.8] events from a suspended slot are dropped", () => {
    const h = makeRoomHarness();
    expect(h.registry.suspend(h.code, 1, h.clock.now())).toBe(true);

    expect(h.registry.routeEvent(h.code, 1, eventAt(1, "tick", 1))).toBe(false);
    expect(eventsOf(h.host.jsonMessages())).toHaveLength(0);
  });

  test("[FR-7.8] events without a host are dropped and counted", () => {
    const { registry } = makeRegistry();
    const credentials = registry.createRoom();
    const peer = new FakePeer();
    const joined = registry.join({ code: credentials.code, token: credentials.roomToken }, peer);
    if (!joined.ok) {
      throw new Error("controller fixture did not join");
    }

    expect(registry.routeEvent(credentials.code, joined.slot, eventAt(joined.slot, "tick", 1))).toBe(
      false,
    );
    expect(registry.getRoom(credentials.code)?.controllers.get(joined.slot)?.drops).toBe(1);
    expect(peer.jsonMessages()).toHaveLength(0);
  });
});

describe("layout acks", () => {
  test("[FR-8.2] forwards the layout id with the authenticated slot", () => {
    const h = makeRoomHarness();
    expect(h.registry.routeLayoutAck(h.code, 1, "layout-42")).toBe(true);

    expect(h.host.jsonMessages().filter((message) => message.t === "layoutAck")).toEqual([
      { t: "layoutAck", layoutId: "layout-42", slot: 1 },
    ]);
  });

  test("[FR-8.2] invalid ids and inactive slots never reach the host", () => {
    const h = makeRoomHarness();
    expect(h.registry.routeLayoutAck(h.code, 1, "")).toBe(false);
    expect(h.registry.routeLayoutAck(h.code, 1, "x".repeat(MAX_LAYOUT_ID_CHARS + 1))).toBe(false);
    expect(h.registry.routeLayoutAck(h.code, 2, "layout-1")).toBe(false);
    expect(h.host.jsonMessages().filter((message) => message.t === "layoutAck")).toHaveLength(0);
  });
});

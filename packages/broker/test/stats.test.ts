/**
 * Per-slot stats collection and the 1 Hz host stream (D4-SRV-03).
 *
 * RTT/jitter come from the heartbeat ping/pong timestamps the adapter feeds
 * in; input age and drops come from the room's hot path. The clock and the
 * stats interval are injected, so the tests never sleep.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  parseJsonMessage,
  stringifyJsonMessage,
  type InputState,
} from "@lanpad/protocol";
import type { RoomRegistry } from "../src/index.js";
import {
  JITTER_ALPHA,
  STATS_INTERVAL_MS,
  StatsCollector,
  StatsTicker,
} from "../src/room/stats.js";
import { FakePeer, makeRegistry } from "./helpers.js";

interface ControllerHandle {
  slot: number;
  session: string;
  peer: FakePeer;
}

function setup() {
  const harness = makeRegistry();
  const credentials = harness.registry.createRoom();
  const room = harness.registry.getRoom(credentials.code);
  if (room === undefined) {
    throw new Error("created room is missing from the registry");
  }
  const host = new FakePeer();
  expect(harness.registry.hostJoin(credentials.code, credentials.hostToken, host)).toEqual({
    ok: true,
  });
  host.sent.length = 0;
  return {
    ...harness,
    credentials,
    room,
    host,
    collector: new StatsCollector(),
  };
}

function joinController(
  registry: RoomRegistry,
  code: string,
  pin: string,
  peer: FakePeer = new FakePeer(),
): ControllerHandle {
  const result = registry.join({ code, pin }, peer);
  if (!result.ok) {
    throw new Error(`controller join failed: ${result.reason}`);
  }
  return { slot: result.slot, session: result.session, peer };
}

function input(overrides: Partial<InputState> = {}): InputState {
  return {
    tick: 0,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    lt: 0,
    rt: 0,
    flags: 0,
    ...overrides,
  };
}

function statsMessages(peer: FakePeer) {
  return peer.jsonMessages().flatMap((message) => (message.t === "stats" ? [message] : []));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("D4 host stats", () => {
  test("[FR-7.14] heartbeat pong timestamps feed per-slot RTT and jitter", () => {
    const { registry, clock, credentials, room, collector } = setup();
    const controller = joinController(registry, credentials.code, credentials.pin);
    const slot = controller.slot;

    // No ping outstanding: an unsolicited pong is ignored.
    expect(collector.recordPong(room, slot, clock.now())).toBeNull();

    expect(collector.recordPing(room, slot, 1_000)).toBe(true);
    expect(collector.recordPong(room, slot, 1_012)).toBe(12);
    const firstEntries = collector.collect(room, 1_012);
    expect(firstEntries).toHaveLength(1);
    expect(firstEntries[0]).toMatchObject({ slot, rttMs: 12, jitterMs: 0 });

    expect(collector.recordPing(room, slot, 2_000)).toBe(true);
    expect(collector.recordPong(room, slot, 2_030)).toBe(30);
    const stored = room.controllers.get(slot);
    expect(stored?.rttMs).toBe(30);
    expect(stored?.jitterMs).toBeCloseTo(JITTER_ALPHA * 18, 10);

    expect(collector.recordPing(room, slot, 3_000)).toBe(true);
    expect(collector.recordPong(room, slot, 3_010)).toBe(10);
    expect(stored?.jitterMs).toBeCloseTo(
      JITTER_ALPHA * 20 + (1 - JITTER_ALPHA) * (JITTER_ALPHA * 18),
      10,
    );

    // A late or duplicate pong does not overwrite the last real sample.
    expect(collector.recordPong(room, slot, 3_500)).toBeNull();
    expect(stored?.rttMs).toBe(10);
  });

  test("[FR-7.14] stats include 1 s packets/s, input age and drops per active slot", () => {
    const { registry, clock, credentials, room, collector } = setup();
    const first = joinController(registry, credentials.code, credentials.pin);
    const second = joinController(registry, credentials.code, credentials.pin);

    // The registry's hot path stamps lastInputAt for a real Input frame.
    registry.routeInput(room.code, first.slot, input({ buttons: 1 }));
    clock.advance(250);

    collector.recordInput(room, first.slot, clock.now());
    collector.recordInput(room, first.slot, clock.now());
    collector.recordInput(room, first.slot, clock.now());
    collector.recordDrop(room, first.slot, 2);

    // A reserved slot is not active and is omitted from the frame.
    expect(registry.suspend(room.code, second.slot, clock.now(), second.peer)).toBe(true);
    // A frame that arrives just after suspend is still attributed to the slot.
    collector.recordDrop(room, second.slot, 1);

    const entries = collector.collect(room, clock.now());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      slot: first.slot,
      packetsPerSecond: 3,
      drops: 2,
      lastInputAgeMs: 250,
    });

    // Every field is finite and non-negative, as the protocol validator requires.
    for (const value of Object.values(entries[0] ?? {})) {
      if (typeof value === "number") {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }

    // The packets/s window slides: samples older than 1 s fall out.
    clock.advance(1_001);
    const later = collector.collect(room, clock.now());
    expect(later.find((entry) => entry.slot === first.slot)?.packetsPerSecond).toBe(0);

    // The drop recorded while slot 2 was reserved survives the resume.
    const resumed = registry.join({ code: credentials.code, session: second.session }, new FakePeer());
    expect(resumed.ok).toBe(true);
    const afterResume = collector.collect(room, clock.now());
    expect(afterResume.find((entry) => entry.slot === second.slot)?.drops).toBe(1);
  });

  test("[G4] stats carries one finite entry for each of eight slots", () => {
    const { registry, clock, credentials, room, collector } = setup();
    const controllers: ControllerHandle[] = [];
    for (let index = 0; index < 8; index += 1) {
      controllers.push(joinController(registry, credentials.code, credentials.pin));
    }

    const now = clock.now();
    controllers.forEach((controller, index) => {
      const rttMs = (index + 1) * 2;
      expect(collector.recordPing(room, controller.slot, now)).toBe(true);
      expect(collector.recordPong(room, controller.slot, now + rttMs)).toBe(rttMs);
      expect(collector.recordInput(room, controller.slot, now)).toBe(true);
    });

    const message = collector.message(room, now);
    expect(message.t).toBe("stats");
    if (message.t !== "stats") {
      throw new Error("expected a stats message");
    }
    expect(message.slots.map((entry) => entry.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const entry of message.slots) {
      expect(entry.rttMs).toBeGreaterThan(0);
      expect(entry.packetsPerSecond).toBe(1);
      for (const field of [
        "rttMs",
        "jitterMs",
        "lastInputAgeMs",
        "packetsPerSecond",
        "drops",
      ] as const) {
        expect(Number.isFinite(entry[field])).toBe(true);
        expect(entry[field]).toBeGreaterThanOrEqual(0);
      }
    }

    // The frame round-trips through the shared protocol validator.
    const parsed = parseJsonMessage(stringifyJsonMessage(message));
    expect(parsed).toEqual(message);
  });

  test("[FR-7.14] the stats stream ticks once per second while the host is attached", () => {
    vi.useFakeTimers();
    try {
      const { registry, clock, credentials, room, host, collector } = setup();
      joinController(registry, credentials.code, credentials.pin);
      expect(STATS_INTERVAL_MS).toBe(1_000);

      const ticker = new StatsTicker({ collector, now: clock.now });
      host.sent.length = 0;

      ticker.start(room);
      vi.advanceTimersByTime(STATS_INTERVAL_MS);
      expect(statsMessages(host)).toHaveLength(1);
      expect(statsMessages(host)[0]).toMatchObject({ t: "stats" });

      vi.advanceTimersByTime(STATS_INTERVAL_MS);
      expect(statsMessages(host)).toHaveLength(2);

      // Starting twice must not create a second interval for the same room.
      ticker.start(room);
      vi.advanceTimersByTime(STATS_INTERVAL_MS);
      expect(statsMessages(host)).toHaveLength(3);

      ticker.stop(room);
      vi.advanceTimersByTime(STATS_INTERVAL_MS * 2);
      expect(statsMessages(host)).toHaveLength(3);

      // With no host attached there is nowhere to send.
      room.host = null;
      expect(ticker.tick(room)).toBe(false);
      ticker.stopAll();
    } finally {
      vi.useRealTimers();
    }
  });
});

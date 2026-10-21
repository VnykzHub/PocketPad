/**
 * Room and reservation expiry tests (D4-SRV-02).
 *
 * Every boundary is driven by the injected clock; no real timers or sleeps.
 */
import { describe, expect, test } from "vitest";
import type { InputState } from "@lanpad/protocol";
import {
  ROOM_IDLE_TIMEOUT_MS,
  ROOM_MAX_LIFETIME_MS,
  SLOT_RESERVATION_MS,
  type RoomRegistry,
} from "../src/index.js";
import { FakePeer, makeRegistry } from "./helpers.js";

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

function kicks(peer: FakePeer) {
  return peer.jsonMessages().filter((message) => message.t === "kick");
}

function presence(peer: FakePeer, type: "playerJoined" | "playerLeft" | "playerSuspended" | "playerResumed") {
  return peer.jsonMessages().filter((message) => message.t === type);
}

function attachHost(registry: RoomRegistry, code: string, hostToken: string): FakePeer {
  const host = new FakePeer();
  expect(registry.hostJoin(code, hostToken, host)).toEqual({ ok: true });
  host.sent.length = 0;
  return host;
}

describe("D4 room expiry", () => {
  test("[FR-5.2] a room expires after 10 minutes idle and kicks every peer", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room.code, room.hostToken);
    const controller = new FakePeer();
    expect(registry.join({ code: room.code, pin: room.pin }, controller).ok).toBe(true);

    clock.advance(ROOM_IDLE_TIMEOUT_MS - 1);
    registry.sweep();
    expect(registry.roomCount()).toBe(1);

    clock.advance(1);
    registry.sweep();

    expect(registry.roomCount()).toBe(0);
    expect(kicks(host)).toEqual([{ t: "kick", reason: "expired" }]);
    expect(kicks(controller)).toEqual([{ t: "kick", reason: "expired" }]);
    expect(host.closes).toEqual([{ code: 1000, reason: "room expired" }]);
    expect(controller.closes).toEqual([{ code: 1000, reason: "room expired" }]);
  });

  test("[FR-5.2] sweep(now) applies the idle boundary from the injected time", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room.code, room.hostToken);
    const createdAt = clock.now();

    // The clock itself does not move; the explicit `now` drives expiry.
    registry.sweep(createdAt + ROOM_IDLE_TIMEOUT_MS - 1);
    expect(registry.roomCount()).toBe(1);
    registry.sweep(createdAt + ROOM_IDLE_TIMEOUT_MS);
    expect(registry.roomCount()).toBe(0);
    expect(kicks(host)).toHaveLength(1);
  });

  test("[FR-5.2] the 4 hour maximum expires a room even while it is active", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room.code, room.hostToken);
    const startedAt = clock.now();

    // Refresh activity every 9 minutes so only the absolute cap can fire.
    for (
      let elapsed = ROOM_IDLE_TIMEOUT_MS - 60_000;
      elapsed < ROOM_MAX_LIFETIME_MS;
      elapsed += ROOM_IDLE_TIMEOUT_MS - 60_000
    ) {
      clock.set(startedAt + elapsed);
      expect(registry.hostJoin(room.code, room.hostToken, host)).toEqual({ ok: true });
    }

    clock.set(startedAt + ROOM_MAX_LIFETIME_MS - 1);
    registry.sweep();
    expect(registry.roomCount()).toBe(1);

    clock.set(startedAt + ROOM_MAX_LIFETIME_MS);
    registry.sweep();
    expect(registry.roomCount()).toBe(0);
    expect(kicks(host)).toEqual([{ t: "kick", reason: "expired" }]);
  });

  test("[FR-5.2] input and valid host messages keep an idle-but-active room alive", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    attachHost(registry, room.code, room.hostToken);
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer()).ok).toBe(true);

    clock.advance(ROOM_IDLE_TIMEOUT_MS - 1);
    registry.routeInput(room.code, 1, input({ tick: 1, buttons: 1 }));
    clock.advance(ROOM_IDLE_TIMEOUT_MS - 1);
    registry.sweep();
    expect(registry.roomCount()).toBe(1);

    // A host/controller message at the edge of the window resets the idle timer.
    expect(registry.noteActivity(room.code)).toBe(true);
    clock.advance(ROOM_IDLE_TIMEOUT_MS - 1);
    registry.sweep();
    expect(registry.roomCount()).toBe(1);

    clock.advance(1);
    registry.sweep();
    expect(registry.roomCount()).toBe(0);
  });

  test("[FR-5.2] a join to an expired-but-unswept room expires it and kicks the peers", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room.code, room.hostToken);
    const controller = new FakePeer();
    expect(registry.join({ code: room.code, pin: room.pin }, controller).ok).toBe(true);

    clock.advance(ROOM_IDLE_TIMEOUT_MS);
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toEqual({
      ok: false,
      reason: "expired",
    });

    expect(registry.roomCount()).toBe(0);
    expect(kicks(host)).toHaveLength(1);
    expect(kicks(controller)).toHaveLength(1);
  });

  test("[FR-5.2] sweep is idempotent and never duplicates kicks or close calls", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room.code, room.hostToken);

    clock.advance(ROOM_IDLE_TIMEOUT_MS);
    registry.sweep();
    registry.sweep();
    registry.sweep(clock.now() + ROOM_MAX_LIFETIME_MS);

    expect(registry.roomCount()).toBe(0);
    expect(kicks(host)).toHaveLength(1);
    expect(host.closes).toHaveLength(1);
  });
});

describe("D4 reservation expiry", () => {
  test("[FR-5.5] sweep frees a reservation at the 30 s boundary and notifies the host", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room.code, room.hostToken);
    const peer = new FakePeer();
    const joined = registry.join({ code: room.code, pin: room.pin }, peer);
    expect(joined.ok).toBe(true);
    const session = joined.ok ? joined.session : "";
    const slot = joined.ok ? joined.slot : 0;

    const detachedAt = clock.now();
    expect(registry.detach(room.code, slot, detachedAt, peer)).toBe(true);
    host.sent.length = 0;

    clock.advance(SLOT_RESERVATION_MS - 1);
    registry.sweep();
    expect(registry.getRoom(room.code)?.controllers.has(slot)).toBe(true);
    expect(registry.getRoom(room.code)?.reservations.size).toBe(1);
    expect(presence(host, "playerLeft")).toHaveLength(0);

    clock.advance(1);
    registry.sweep();
    expect(registry.getRoom(room.code)?.controllers.has(slot)).toBe(false);
    expect(registry.getRoom(room.code)?.reservations.size).toBe(0);
    expect(presence(host, "playerLeft")).toEqual([{ t: "playerLeft", slot }]);

    expect(registry.join({ code: room.code, session }, new FakePeer())).toEqual({
      ok: false,
      reason: "expired",
    });
    // The freed slot is assignable through a normal manual join.
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toMatchObject({
      ok: true,
      slot,
    });
  });

  test("[FR-5.5] a sweeper pass is idempotent for expired reservations", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room.code, room.hostToken);
    const peer = new FakePeer();
    expect(registry.join({ code: room.code, pin: room.pin }, peer).ok).toBe(true);
    registry.detach(room.code, 1, clock.now(), peer);
    host.sent.length = 0;

    clock.advance(SLOT_RESERVATION_MS);
    registry.sweep();
    registry.sweep();
    expect(presence(host, "playerLeft")).toHaveLength(1);
  });

  test("[FR-7.14] a detached socket does not refresh the idle timer", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room.code, room.hostToken);
    const peer = new FakePeer();
    expect(registry.join({ code: room.code, pin: room.pin }, peer).ok).toBe(true);

    // Detach at t0: it reserves the slot but is not a message, so the room's
    // last activity is still the host/join traffic at t0.
    expect(registry.detach(room.code, 1, clock.now(), peer)).toBe(true);
    peer.sent.length = 0;

    clock.advance(ROOM_IDLE_TIMEOUT_MS - 1);
    registry.sweep();
    expect(registry.roomCount()).toBe(1);

    clock.advance(1);
    registry.sweep();
    expect(registry.roomCount()).toBe(0);
    expect(kicks(host)).toHaveLength(1);
  });

  test("[FR-5.5] eight reservations expiring together reopen the room for new players", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    attachHost(registry, room.code, room.hostToken);
    const peers = Array.from({ length: 8 }, () => new FakePeer());
    for (const [index, peer] of peers.entries()) {
      expect(registry.join({ code: room.code, pin: room.pin }, peer)).toMatchObject({
        ok: true,
        slot: index + 1,
      });
    }

    for (const [index, peer] of peers.entries()) {
      expect(registry.detach(room.code, index + 1, clock.now(), peer)).toBe(true);
    }
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toEqual({
      ok: false,
      reason: "roomFull",
    });

    clock.advance(SLOT_RESERVATION_MS);
    registry.sweep();
    expect(registry.getRoom(room.code)?.reservations.size).toBe(0);

    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toMatchObject({
      ok: true,
      slot: 1,
    });
  });

  test("[FR-5.2] a room with only reserved slots still expires after 10 minutes idle", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const peer = new FakePeer();
    expect(registry.join({ code: room.code, pin: room.pin }, peer).ok).toBe(true);
    expect(registry.detach(room.code, 1, clock.now(), peer)).toBe(true);

    clock.advance(ROOM_IDLE_TIMEOUT_MS);
    registry.sweep();
    expect(registry.roomCount()).toBe(0);
  });
});

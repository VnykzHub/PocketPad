/**
 * Session, slot and rejoin tests (D4-SRV-02).
 *
 * Clocks and entropy are injected; nothing here sleeps or reads wall time.
 * Every test title starts with its requirement tag (anti-rework rule 10).
 */
import { describe, expect, test } from "vitest";
import type { InputState } from "@lanpad/protocol";
import {
  SLOT_RESERVATION_MS,
  type JoinRateLimiter,
  type JoinResult,
  type RoomCredentials,
  type RoomRegistry,
} from "../src/index.js";
import { FakePeer, assertNoSecretsLogged, makeRegistry } from "./helpers.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

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

function wrongPin(pin: string): string {
  return pin === "0000" ? "0001" : "0000";
}

function expectOk(result: JoinResult): { slot: number; session: string } {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`join failed: ${result.reason}`);
  }
  return { slot: result.slot, session: result.session };
}

function attachHost(
  registry: RoomRegistry,
  room: RoomCredentials,
): FakePeer {
  const host = new FakePeer();
  expect(registry.hostJoin(room.code, room.hostToken, host)).toEqual({ ok: true });
  host.sent.length = 0;
  return host;
}

function joinWithPin(
  registry: RoomRegistry,
  room: RoomCredentials,
  peer: FakePeer = new FakePeer(),
): { slot: number; session: string } {
  return expectOk(registry.join({ code: room.code, pin: room.pin }, peer));
}

describe("D4 sessions and slots", () => {
  test("[FR-5.4] session rejoin returns the same slot inside 30 seconds", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room);

    const firstPeer = new FakePeer();
    const first = expectOk(
      registry.join({ code: room.code, token: room.roomToken }, firstPeer),
    );
    expect(first.slot).toBe(1);
    // Fill slot 2 so a rejoin cannot "accidentally" land on slot 1.
    expect(joinWithPin(registry, room).slot).toBe(2);

    host.sent.length = 0;
    expect(registry.detach(room.code, first.slot, clock.now(), firstPeer)).toBe(true);
    expect(host.jsonMessages()).toContainEqual({ t: "playerSuspended", slot: 1 });

    clock.advance(SLOT_RESERVATION_MS - 100);
    const resumedPeer = new FakePeer();
    const resumed = expectOk(
      registry.join({ code: room.code, session: first.session }, resumedPeer),
    );

    expect(resumed.slot).toBe(1);
    expect(resumed.session).toBe(first.session);
    expect(host.jsonMessages()).toContainEqual({ t: "playerResumed", slot: 1 });

    const stored = registry.getRoom(room.code)?.controllers.get(1);
    expect(stored?.peer).toBe(resumedPeer);
    expect(stored?.reservationExpiresAt).toBeNull();
    expect(registry.getRoom(room.code)?.reservations.size).toBe(0);
  });

  test("[FR-5.4] the newest socket takes over an active session without moving slots", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room);

    const oldPeer = new FakePeer();
    const first = joinWithPin(registry, room, oldPeer);
    host.sent.length = 0;

    const newPeer = new FakePeer();
    const resumed = expectOk(
      registry.join({ code: room.code, session: first.session }, newPeer),
    );

    expect(resumed).toEqual({ slot: first.slot, session: first.session });
    expect(oldPeer.closes).toEqual([{ code: 1000, reason: "session resumed" }]);
    expect(registry.getRoom(room.code)?.controllers.get(1)?.peer).toBe(newPeer);
    // The old socket's close event must not detach the peer that replaced it.
    expect(registry.detach(room.code, 1, registry.nowMs(), oldPeer)).toBe(false);
    expect(registry.getRoom(room.code)?.controllers.get(1)?.peer).toBe(newPeer);
    // The host already saw this slot as active; no second presence event.
    expect(host.jsonMessages().filter((m) => m.t === "playerJoined")).toHaveLength(0);
  });

  test("[FR-5.4] suspend and socket close share the same 30 s reservation", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room);

    const peer = new FakePeer();
    const joined = joinWithPin(registry, room, peer);
    host.sent.length = 0;
    const suspendedAt = clock.now();
    expect(registry.suspend(room.code, joined.slot, suspendedAt, peer)).toBe(true);
    expect(host.jsonMessages()).toContainEqual({ t: "playerSuspended", slot: 1 });

    const slot = registry.getRoom(room.code)?.controllers.get(joined.slot);
    expect(slot?.peer).toBeNull();
    expect(slot?.reservationExpiresAt).toBe(suspendedAt + SLOT_RESERVATION_MS);
    expect(registry.getRoom(room.code)?.reservations.size).toBe(1);
    // A repeated suspend must not extend the window; a stale peer is ignored.
    expect(registry.suspend(room.code, joined.slot, suspendedAt + 1_000, peer)).toBe(false);
    expect(registry.suspend(room.code, joined.slot, suspendedAt + 1_000, new FakePeer())).toBe(
      false,
    );
    expect(registry.getRoom(room.code)?.controllers.get(joined.slot)?.reservationExpiresAt).toBe(
      suspendedAt + SLOT_RESERVATION_MS,
    );
  });

  test("[FR-5.5] a rejoin after 30.1 s returns expired and the slot becomes assignable", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room);

    const peer = new FakePeer();
    const first = joinWithPin(registry, room, peer);
    const detachedAt = clock.now();
    expect(registry.detach(room.code, first.slot, detachedAt, peer)).toBe(true);
    host.sent.length = 0;

    clock.advance(SLOT_RESERVATION_MS + 100);
    const rejoin = registry.join({ code: room.code, session: first.session }, new FakePeer());

    expect(rejoin).toEqual({ ok: false, reason: "expired" });
    expect(registry.getRoom(room.code)?.reservations.size).toBe(0);
    expect(registry.getRoom(room.code)?.controllers.has(first.slot)).toBe(false);
    // The host learns the slot is gone, and the slot can be assigned again.
    expect(host.jsonMessages()).toContainEqual({ t: "playerLeft", slot: first.slot });
    const fresh = joinWithPin(registry, room);
    expect(fresh.slot).toBe(first.slot);
    expect(fresh.session).not.toBe(first.session);
  });

  test("[FR-5.5] a reservation is live at 29.9 s and stale at 30.1 s", () => {
    const early = makeRegistry();
    const earlyRoom = early.registry.createRoom();
    const earlyPeer = new FakePeer();
    const earlyJoin = joinWithPin(early.registry, earlyRoom, earlyPeer);
    early.registry.detach(earlyRoom.code, earlyJoin.slot, early.clock.now(), earlyPeer);
    early.clock.advance(SLOT_RESERVATION_MS - 100);
    expect(
      expectOk(
        early.registry.join(
          { code: earlyRoom.code, session: earlyJoin.session },
          new FakePeer(),
        ),
      ).slot,
    ).toBe(earlyJoin.slot);

    const late = makeRegistry();
    const lateRoom = late.registry.createRoom();
    const latePeer = new FakePeer();
    const lateJoin = joinWithPin(late.registry, lateRoom, latePeer);
    late.registry.detach(lateRoom.code, lateJoin.slot, late.clock.now(), latePeer);
    late.clock.advance(SLOT_RESERVATION_MS + 100);
    expect(
      late.registry.join({ code: lateRoom.code, session: lateJoin.session }, new FakePeer()),
    ).toEqual({ ok: false, reason: "expired" });
  });

  test("[FR-5.4] explicit leave frees the slot immediately and does not reserve", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room);

    const peer = new FakePeer();
    const joined = joinWithPin(registry, room, peer);
    host.sent.length = 0;

    expect(registry.leave(room.code, joined.slot, clock.now())).toBe(true);
    expect(registry.getRoom(room.code)?.controllers.size).toBe(0);
    expect(registry.getRoom(room.code)?.reservations.size).toBe(0);
    expect(host.jsonMessages()).toContainEqual({ t: "playerLeft", slot: joined.slot });
    expect(registry.join({ code: room.code, session: joined.session }, new FakePeer())).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(joinWithPin(registry, room).slot).toBe(joined.slot);

    // The D0 peer-scoped form still refuses a stale socket.
    const second = joinWithPin(registry, room);
    expect(registry.leave(room.code, second.slot, peer)).toBe(false);
  });

  test("[FR-5.4] a session token cannot reclaim a slot in another room", () => {
    const { registry } = makeRegistry();
    const firstRoom = registry.createRoom();
    const secondRoom = registry.createRoom();
    const session = joinWithPin(registry, firstRoom).session;
    const secondPeer = new FakePeer();
    joinWithPin(registry, secondRoom, secondPeer);

    expect(
      registry.join({ code: secondRoom.code, session }, new FakePeer()),
    ).toEqual({ ok: false, reason: "expired" });
    expect(registry.getRoom(secondRoom.code)?.controllers.get(1)?.peer).toBe(secondPeer);
  });

  test("[FR-5.4] session never combines with token or pin", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();
    const session = "A".repeat(22);

    expect(
      registry.join({ code: room.code, session, token: room.roomToken }, new FakePeer()),
    ).toEqual({ ok: false, reason: "badToken" });
    expect(
      registry.join({ code: room.code, session, pin: room.pin }, new FakePeer()),
    ).toEqual({ ok: false, reason: "badToken" });
    expect(registry.join({ code: room.code }, new FakePeer())).toEqual({
      ok: false,
      reason: "badToken",
    });
  });

  test("[FR-7.15] a rejoin needs only the session token, even when QR joins require a PIN", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom({ requirePinForQr: true });
    const peer = new FakePeer();
    const joined = expectOk(
      registry.join({ code: room.code, token: room.roomToken, pin: room.pin }, peer),
    );
    registry.detach(room.code, joined.slot, clock.now(), peer);
    clock.advance(1_000);

    const resumed = expectOk(
      registry.join({ code: room.code, session: joined.session }, new FakePeer()),
    );
    expect(resumed).toEqual({ slot: joined.slot, session: joined.session });
  });

  test("[FR-5.6] manual join with code and PIN works without a room token", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();

    expect(joinWithPin(registry, room).slot).toBe(1);
    expect(registry.join({ code: room.code, pin: wrongPin(room.pin) }, new FakePeer())).toEqual({
      ok: false,
      reason: "badPin",
    });
    expect(registry.join({ code: room.code }, new FakePeer())).toEqual({
      ok: false,
      reason: "badToken",
    });
  });

  test("[A11] token-only joins work and an ignored PIN never fails them", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();
    expect(
      expectOk(registry.join({ code: room.code, token: room.roomToken }, new FakePeer())).slot,
    ).toBe(1);
    // QR-PIN mode is off (D4 default): a client that always prompts may send
    // token+pin and the PIN is ignored.
    expect(
      expectOk(
        registry.join(
          { code: room.code, token: room.roomToken, pin: wrongPin(room.pin) },
          new FakePeer(),
        ),
      ).slot,
    ).toBe(2);

    const pinned = registry.createRoom({ requirePinForQr: true });
    expect(registry.join({ code: pinned.code, token: pinned.roomToken }, new FakePeer())).toEqual({
      ok: false,
      reason: "badPin",
    });
    expect(
      registry.join(
        { code: pinned.code, token: pinned.roomToken, pin: wrongPin(pinned.pin) },
        new FakePeer(),
      ),
    ).toEqual({ ok: false, reason: "badPin" });
    expect(
      expectOk(
        registry.join(
          { code: pinned.code, token: pinned.roomToken, pin: pinned.pin },
          new FakePeer(),
        ),
      ).slot,
    ).toBe(1);
  });

  test("[FR-7.14] a silent socket is detached and its slot reserved", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room);
    const peer = new FakePeer();
    const joined = joinWithPin(registry, room, peer);
    host.sent.length = 0;

    const detachedAt = clock.now();
    expect(registry.detach(room.code, joined.slot, detachedAt, peer)).toBe(true);
    const slot = registry.getRoom(room.code)?.controllers.get(joined.slot);
    expect(slot?.peer).toBeNull();
    expect(slot?.reservationExpiresAt).toBe(detachedAt + SLOT_RESERVATION_MS);
    expect(host.jsonMessages()).toContainEqual({ t: "playerSuspended", slot: joined.slot });

    // A second close (or a stale socket) must not extend the reservation.
    clock.advance(5_000);
    expect(registry.detach(room.code, joined.slot, clock.now(), peer)).toBe(false);
    expect(registry.detach(room.code, joined.slot, clock.now(), new FakePeer())).toBe(false);
    expect(registry.getRoom(room.code)?.controllers.get(joined.slot)?.reservationExpiresAt).toBe(
      detachedAt + SLOT_RESERVATION_MS,
    );
  });

  test("[FR-7.14] input from a reserved slot is dropped and does not refresh activity", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room);
    const peer = new FakePeer();
    const joined = joinWithPin(registry, room, peer);
    const controller = registry.getRoom(room.code)?.controllers.get(joined.slot);
    const lastInputAt = controller?.lastInputAt;

    registry.detach(room.code, joined.slot, clock.now(), peer);
    const activityAtDetach = registry.getRoom(room.code)?.lastActivityAt;
    host.sent.length = 0;
    clock.advance(1_000);

    registry.routeInput(room.code, joined.slot, input({ tick: 9, edges: 1 }));

    expect(host.binaryFrames()).toHaveLength(0);
    expect(controller?.lastInputAt).toBe(lastInputAt);
    expect(registry.getRoom(room.code)?.lastActivityAt).toBe(activityAtDetach);
  });

  test("[SR-6] a ninth controller is rejected while a slot is reserved", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const peers = Array.from({ length: 8 }, () => new FakePeer());
    const sessions = peers.map((peer) => joinWithPin(registry, room, peer).session);

    registry.detach(room.code, 3, clock.now(), peers[2]);
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toEqual({
      ok: false,
      reason: "roomFull",
    });

    // The reserved slot is still reclaimable by its session...
    expect(
      expectOk(registry.join({ code: room.code, session: sessions[2] ?? "" }, new FakePeer()))
        .slot,
    ).toBe(3);
    // ...and an explicit leave is what frees a slot for a new player.
    expect(registry.leave(room.code, 5, clock.now())).toBe(true);
    expect(joinWithPin(registry, room).slot).toBe(5);
  });

  test("[G4] eight controllers keep stable slots across reconnects", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const peers = Array.from({ length: 8 }, () => new FakePeer());
    const joins = peers.map((peer) => joinWithPin(registry, room, peer));
    expect(joins.map((join) => join.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    for (const [index, join] of joins.entries()) {
      const peer = peers[index];
      expect(peer).toBeDefined();
      registry.detach(room.code, join.slot, clock.now(), peer as FakePeer);
    }
    clock.advance(10_000);

    for (const join of [...joins].reverse()) {
      const peer = new FakePeer();
      const resumed = expectOk(
        registry.join({ code: room.code, session: join.session }, peer),
      );
      expect(resumed.slot).toBe(join.slot);
      expect(resumed.session).toBe(join.session);
      expect(registry.getRoom(room.code)?.controllers.get(join.slot)?.peer).toBe(peer);
    }

    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toEqual({
      ok: false,
      reason: "roomFull",
    });
  });

  test("[SR-1] session tokens are unique random 128-bit values, never the room token", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();
    const sessions = Array.from({ length: 8 }, () => joinWithPin(registry, room).session);

    expect(new Set(sessions).size).toBe(8);
    for (const session of sessions) {
      expect(session).toMatch(TOKEN_PATTERN);
      expect(session).not.toBe(room.roomToken);
      expect(session).not.toBe(room.hostToken);
    }

    // A fresh join after an explicit leave gets a new token, never a reused one.
    expect(registry.leave(room.code, 1, registry.nowMs())).toBe(true);
    const replacement = joinWithPin(registry, room).session;
    expect(replacement).toMatch(TOKEN_PATTERN);
    expect(sessions).not.toContain(replacement);
  });

  test("[SR-5] only PIN-bearing joins consult the rate limiter", () => {
    const allowed: string[] = [];
    const failures: string[] = [];
    const successes: string[] = [];
    const limiter: JoinRateLimiter = {
      allow: (ip) => {
        allowed.push(ip);
        return true;
      },
      recordFailure: (ip) => failures.push(ip),
      recordSuccess: (ip) => successes.push(ip),
    };
    const { registry } = makeRegistry({ rateLimiter: limiter });
    const room = registry.createRoom();
    const peer = new FakePeer({ remoteAddress: "10.0.0.7" });

    // Token-only: no PIN to guess, no limiter traffic. A successful join does
    // reset the failure window (SR-5), but it never asks the limiter.
    expectOk(registry.join({ code: room.code, token: room.roomToken }, peer));
    expect(allowed).toHaveLength(0);
    expect(successes).toEqual(["10.0.0.7"]);

    // PIN-only: checked before credential comparison and recorded.
    expect(registry.join({ code: room.code, pin: wrongPin(room.pin) }, peer)).toEqual({
      ok: false,
      reason: "badPin",
    });
    expect(allowed).toEqual(["10.0.0.7"]);
    expect(failures).toEqual(["10.0.0.7"]);

    // A successful manual join resets the limiter.
    const replacement = joinWithPin(registry, room, peer);
    expect(replacement.slot).toBe(2);
    expect(successes).toEqual(["10.0.0.7", "10.0.0.7"]);

    // A session rejoin is not a credential attempt.
    const limiterCallsBeforeRejoin = allowed.length;
    registry.detach(room.code, replacement.slot, registry.nowMs(), peer);
    expect(
      expectOk(
        registry.join({ code: room.code, session: replacement.session }, new FakePeer()),
      ).slot,
    ).toBe(replacement.slot);
    expect(allowed).toHaveLength(limiterCallsBeforeRejoin);
  });

  test("[SR-9] session logs never include tokens, sessions or PINs", () => {
    const { registry, clock, calls } = makeRegistry();
    const room = registry.createRoom();
    const host = attachHost(registry, room);
    const peer = new FakePeer();

    const joined = joinWithPin(registry, room, peer);
    registry.detach(room.code, joined.slot, clock.now(), peer);
    clock.advance(1_000);
    const resumed = registry.join({ code: room.code, session: joined.session }, new FakePeer());
    expect(resumed.ok).toBe(true);
    registry.suspend(room.code, joined.slot, clock.now());
    clock.advance(SLOT_RESERVATION_MS);
    registry.sweep();
    registry.leave(room.code, joined.slot, clock.now());
    registry.hostLeave(room.code, host);

    assertNoSecretsLogged(calls, [
      room.pin,
      room.roomToken,
      room.hostToken,
      joined.session,
    ]);
  });
});

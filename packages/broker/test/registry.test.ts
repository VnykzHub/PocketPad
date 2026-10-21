/**
 * RoomRegistry tests (D0-SRV-02). Clocks and randomness are injected, so no
 * test waits on real time or real entropy.
 */
import { describe, expect, test } from "vitest";
import { decodeInputFwd, type InputState } from "@lanpad/protocol";
import {
  HOST_RESERVATION_MS,
  ROOM_IDLE_TIMEOUT_MS,
  ROOM_MAX_LIFETIME_MS,
  constantTimeEqual,
  createJoinRateLimiter,
} from "../src/index.js";
import { FakePeer, assertNoSecretsLogged, makeRegistry } from "./helpers.js";

const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}$/;
const PIN_PATTERN = /^\d{4}$/;
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

describe("RoomRegistry credentials", () => {
  test("[FR-5.2] room credentials use the frozen code, PIN and token formats", () => {
    const { registry, clock } = makeRegistry();
    const credentials = registry.createRoom();

    expect(credentials.code).toMatch(CODE_PATTERN);
    expect(credentials.pin).toMatch(PIN_PATTERN);
    expect(credentials.roomToken).toMatch(TOKEN_PATTERN);
    expect(credentials.hostToken).toMatch(TOKEN_PATTERN);
    expect(credentials.roomToken).not.toBe(credentials.hostToken);
    expect(credentials.serverTime).toBe(clock.now());
    expect(credentials.expiresAt).toBe(clock.now() + ROOM_MAX_LIFETIME_MS);
  });

  test("[FR-5.2] 1,000 generated rooms have unique codes", () => {
    const { registry } = makeRegistry({ seed: 1234 });
    const codes = new Set<string>();

    for (let index = 0; index < 1000; index += 1) {
      const code = registry.createRoom().code;
      expect(code).toMatch(CODE_PATTERN);
      codes.add(code);
    }

    expect(codes.size).toBe(1000);
    expect(registry.roomCount()).toBe(1000);
  });
});

describe("RoomRegistry joins", () => {
  test("[FR-5.1] join accepts the room token or the PIN and rejects wrong credentials", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();

    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toMatchObject({
      ok: true,
      slot: 1,
    });
    expect(
      registry.join({ code: room.code.toLowerCase(), token: room.roomToken }, new FakePeer()),
    ).toMatchObject({ ok: true, slot: 2 });
    expect(
      registry.join({ code: room.code, token: room.roomToken, pin: room.pin }, new FakePeer()),
    ).toMatchObject({ ok: true, slot: 3 });

    expect(registry.join({ code: room.code, pin: wrongPin(room.pin) }, new FakePeer())).toEqual({
      ok: false,
      reason: "badPin",
    });
    expect(
      registry.join({ code: room.code, token: "A".repeat(22) }, new FakePeer()),
    ).toEqual({ ok: false, reason: "badToken" });
    // D4-SRV-02 supersedes the D0 placeholder: an unknown or expired session
    // is an `expired` rejoin, never `badToken` (FR-5.5).
    expect(
      registry.join({ code: room.code, session: "A".repeat(22) }, new FakePeer()),
    ).toEqual({ ok: false, reason: "expired" });
    expect(registry.join({ code: room.code }, new FakePeer())).toEqual({
      ok: false,
      reason: "badToken",
    });
    expect(registry.join({ code: "IIII", pin: room.pin }, new FakePeer())).toEqual({
      ok: false,
      reason: "badCode",
    });
  });

  test("[FR-5.3] slots fill 1..8, the ninth join is roomFull, and the lowest free slot is reused", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();
    const peers = Array.from({ length: 8 }, () => new FakePeer());

    peers.forEach((peer, index) => {
      expect(registry.join({ code: room.code, pin: room.pin }, peer)).toMatchObject({
        ok: true,
        slot: index + 1,
      });
    });
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toEqual({
      ok: false,
      reason: "roomFull",
    });

    const second = peers[1];
    expect(second).toBeDefined();
    expect(registry.leave(room.code, 2, second!)).toBe(true);
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toMatchObject({
      ok: true,
      slot: 2,
    });
    // A stale peer cannot free a slot that now belongs to someone else.
    expect(registry.leave(room.code, 2, second!)).toBe(false);
  });

  test("[FR-5.3] the host is notified when a controller joins and leaves", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();
    const host = new FakePeer();
    const controller = new FakePeer();
    expect(registry.hostJoin(room.code, room.hostToken, host)).toEqual({ ok: true });

    registry.join({ code: room.code, pin: room.pin }, controller);
    expect(host.jsonMessages()).toContainEqual({ t: "playerJoined", slot: 1 });

    expect(registry.leave(room.code, 1, controller)).toBe(true);
    expect(host.jsonMessages()).toContainEqual({ t: "playerLeft", slot: 1 });
  });

  test("[SR-5] the join path consults the injected rate limiter", () => {
    let attempts = 0;
    const { registry } = makeRegistry({
      rateLimiter: {
        allow: () => {
          attempts += 1;
          return attempts <= 1;
        },
      },
    });
    const room = registry.createRoom();

    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toMatchObject({
      ok: true,
    });
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toEqual({
      ok: false,
      reason: "rateLimited",
    });
    expect(attempts).toBe(2);
  });
});

describe("RoomRegistry host auth", () => {
  test("[A2] hostJoin authenticates with the host token", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();
    const host = new FakePeer();

    expect(registry.hostJoin("IIII", room.hostToken, host)).toEqual({
      ok: false,
      reason: "badCode",
    });
    expect(registry.hostJoin(room.code, "A".repeat(22), host)).toEqual({
      ok: false,
      reason: "badHostToken",
    });
    expect(registry.hostJoin(room.code, room.hostToken, host)).toEqual({ ok: true });
    // A different socket cannot take over a live host seat.
    expect(registry.hostJoin(room.code, room.hostToken, new FakePeer())).toEqual({
      ok: false,
      reason: "badHostToken",
    });
    expect(registry.hostJoin(room.code, room.hostToken, host)).toEqual({ ok: true });
  });

  test("[A2] hostLeave detaches the host and marks the room hostLost", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();
    const host = new FakePeer();
    registry.hostJoin(room.code, room.hostToken, host);

    expect(registry.hostLeave(room.code, new FakePeer())).toBe(false);
    expect(registry.hostLeave(room.code, host)).toBe(true);
    expect(registry.getRoom(room.code)?.state).toBe("hostLost");
    expect(registry.hostLeave(room.code, host)).toBe(false);
  });
});

describe("RoomRegistry expiry", () => {
  test("[FR-5.2] rooms expire after 10 minutes of inactivity", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();

    clock.advance(ROOM_IDLE_TIMEOUT_MS - 1);
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toMatchObject({
      ok: true,
    });

    clock.advance(ROOM_IDLE_TIMEOUT_MS);
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(registry.roomCount()).toBe(0);
  });

  test("[FR-5.2] rooms expire 4 hours after creation regardless of activity", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = new FakePeer();
    const startedAt = clock.now();

    // Keep the room active with a host refresh inside every idle window until
    // just before the absolute lifetime cap.
    while (clock.now() < startedAt + ROOM_MAX_LIFETIME_MS - 500) {
      const remaining = startedAt + ROOM_MAX_LIFETIME_MS - 500 - clock.now();
      clock.advance(Math.min(ROOM_IDLE_TIMEOUT_MS - 1000, remaining));
      expect(registry.hostJoin(room.code, room.hostToken, host)).toEqual({ ok: true });
    }

    clock.advance(500);
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer())).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(registry.roomCount()).toBe(0);
    expect(host.closes).toEqual([{ code: 1000, reason: "room expired" }]);
  });

  test("[FR-5.2] sweep expires idle rooms and closes host and controllers", () => {
    const { registry, clock } = makeRegistry();
    const room = registry.createRoom();
    const host = new FakePeer();
    const controller = new FakePeer();
    registry.hostJoin(room.code, room.hostToken, host);
    registry.join({ code: room.code, pin: room.pin }, controller);

    registry.sweep();
    expect(registry.roomCount()).toBe(1);

    clock.advance(ROOM_IDLE_TIMEOUT_MS);
    registry.sweep();

    expect(registry.roomCount()).toBe(0);
    expect(host.closes).toEqual([{ code: 1000, reason: "room expired" }]);
    expect(controller.closes).toEqual([{ code: 1000, reason: "room expired" }]);
  });
});

describe("RoomRegistry input routing", () => {
  test("[FR-7.3] InputFwd reaches the host with the assigned slot and edges intact", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();
    const host = new FakePeer();
    const controller = new FakePeer();
    expect(registry.hostJoin(room.code, room.hostToken, host)).toEqual({ ok: true });
    expect(registry.join({ code: room.code, pin: room.pin }, controller).ok).toBe(true);
    host.sent.length = 0; // discard playerJoined noise

    const sent = input({ tick: 123456, buttons: 0, edges: 1 << 2, lx: -32768, rt: 255 });
    registry.routeInput(room.code, 1, sent);

    const frames = host.binaryFrames();
    expect(frames).toHaveLength(1);
    const decoded = decodeInputFwd(frames[0]!);
    expect(decoded.slot).toBe(1);
    expect(decoded.state).toEqual(sent);
    expect(controller.binaryFrames()).toHaveLength(0);

    // Input from an unassigned slot is dropped, never forwarded.
    registry.routeInput(room.code, 7, input({ tick: 1 }));
    expect(host.binaryFrames()).toHaveLength(1);
  });

  test("[FR-7.3] input with no host attached is dropped and counted", () => {
    const { registry } = makeRegistry();
    const room = registry.createRoom();
    const controller = new FakePeer();
    expect(registry.join({ code: room.code, pin: room.pin }, controller).ok).toBe(true);

    registry.routeInput(room.code, 1, input({ tick: 7 }));

    expect(registry.getRoom(room.code)?.droppedInputs).toBe(1);
    expect(controller.binaryFrames()).toHaveLength(0);
  });

  test("[G2] backpressure drops level-only input but never edge packets", () => {
    const { registry } = makeRegistry({ maxBufferedBytes: 1024 });
    const room = registry.createRoom();
    const host = new FakePeer();
    expect(registry.hostJoin(room.code, room.hostToken, host)).toEqual({ ok: true });
    expect(registry.join({ code: room.code, pin: room.pin }, new FakePeer()).ok).toBe(true);
    host.sent.length = 0;
    host.bufferedAmount = 4096; // over the ceiling

    registry.routeInput(room.code, 1, input({ buttons: 1, edges: 0 }));
    expect(host.binaryFrames()).toHaveLength(0);

    // Sub-tick tap: edge set with level already clear must still be forwarded.
    registry.routeInput(room.code, 1, input({ buttons: 0, edges: 1 }));
    expect(host.binaryFrames()).toHaveLength(1);
    expect(registry.getRoom(room.code)?.droppedInputs).toBe(1);
  });
});

describe("RoomRegistry security invariants", () => {
  test("[SR-1] credential comparison is constant-time and length-safe", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "diff")).toBe(false);
    expect(constantTimeEqual("short", "longer-value")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);

    const { registry } = makeRegistry();
    const room = registry.createRoom();
    const truncated = room.roomToken.slice(0, 21);
    expect(registry.join({ code: room.code, token: truncated }, new FakePeer())).toEqual({
      ok: false,
      reason: "badToken",
    });
  });

  test("[SR-9] registry logs never include tokens, sessions or PINs", () => {
    const { registry, clock, calls } = makeRegistry();
    const room = registry.createRoom();
    const host = new FakePeer();
    expect(registry.hostJoin(room.code, room.hostToken, host)).toEqual({ ok: true });

    const controller = new FakePeer();
    const joined = registry.join({ code: room.code, pin: room.pin }, controller);
    expect(joined.ok).toBe(true);
    const session = joined.ok ? joined.session : "";
    expect(session).toMatch(TOKEN_PATTERN);

    registry.routeInput(room.code, 1, input());
    registry.join({ code: room.code, pin: wrongPin(room.pin) }, new FakePeer());
    registry.leave(room.code, 1, controller);
    registry.hostLeave(room.code, host);
    clock.advance(ROOM_IDLE_TIMEOUT_MS);
    registry.sweep();

    assertNoSecretsLogged(calls, [room.pin, room.roomToken, room.hostToken, session]);
  });
});

describe("RoomRegistry D4 host and telemetry wiring", () => {
  test("[FR-9.2][A9] hostPause/hostResume gate input and notify controllers", () => {
    const { registry, clock } = makeRegistry();
    const credentials = registry.createRoom();
    const room = registry.getRoom(credentials.code);
    if (room === undefined) {
      throw new Error("created room is missing from the registry");
    }
    const host = new FakePeer();
    const controller = new FakePeer();
    expect(registry.hostJoin(credentials.code, credentials.hostToken, host)).toEqual({ ok: true });
    const joined = registry.join({ code: credentials.code, pin: credentials.pin }, controller);
    if (!joined.ok) {
      throw new Error(`controller join failed: ${joined.reason}`);
    }
    controller.sent.length = 0;

    // Only the live host may pause; controllers see the A9 status.
    expect(registry.hostPause(credentials.code, new FakePeer())).toBe(false);
    expect(registry.hostPause(credentials.code, host)).toBe(true);
    expect(controller.jsonMessages()).toEqual([{ t: "hostStatus", state: "paused" }]);

    host.sent.length = 0;
    registry.routeInput(credentials.code, joined.slot, input({ edges: 0b1 }));
    expect(host.binaryFrames()).toHaveLength(0);
    expect(room.controllers.get(joined.slot)?.drops).toBe(1);

    expect(registry.hostResume(credentials.code, host)).toBe(true);
    expect(controller.jsonMessages()).toContainEqual({ t: "hostStatus", state: "active" });
    registry.routeInput(credentials.code, joined.slot, input({ tick: 7, edges: 0b1 }));
    expect(host.binaryFrames()).toHaveLength(1);
    const forwarded = host.binaryFrames()[0];
    if (forwarded === undefined) {
      throw new Error("input was not forwarded after resume");
    }
    expect(decodeInputFwd(forwarded)).toMatchObject({ slot: joined.slot, state: { tick: 7 } });

    // FR-7.14: the shared collector sees the forwarded and dropped frames.
    expect(registry.statsCollector().collect(room, clock.now())).toEqual([
      expect.objectContaining({ slot: joined.slot, packetsPerSecond: 2, drops: 1 }),
    ]);
  });

  test("[FR-7.16][A9][G4] registry host loss recovers inside 30 s and expires afterwards", () => {
    const { registry, clock } = makeRegistry();
    const credentials = registry.createRoom();
    const room = registry.getRoom(credentials.code);
    if (room === undefined) {
      throw new Error("created room is missing from the registry");
    }
    const host = new FakePeer();
    const controller = new FakePeer();
    expect(registry.hostJoin(credentials.code, credentials.hostToken, host)).toEqual({ ok: true });
    const joined = registry.join({ code: credentials.code, pin: credentials.pin }, controller);
    if (!joined.ok) {
      throw new Error(`controller join failed: ${joined.reason}`);
    }
    controller.sent.length = 0;

    expect(registry.hostLeave(credentials.code, host)).toBe(true);
    expect(room.state).toBe("hostLost");
    expect(controller.jsonMessages()).toEqual([{ t: "hostStatus", state: "lost" }]);

    // A reload just inside the reservation resumes without a duplicate replay.
    clock.advance(HOST_RESERVATION_MS - 1);
    const resumedHost = new FakePeer();
    expect(registry.hostJoin(credentials.code, credentials.hostToken, resumedHost)).toEqual({
      ok: true,
    });
    expect(room.state).toBe("active");
    expect(controller.jsonMessages()).toEqual([
      { t: "hostStatus", state: "lost" },
      { t: "hostStatus", state: "active" },
    ]);
    expect(
      resumedHost.jsonMessages().filter((message) => message.t === "playerJoined"),
    ).toEqual([{ t: "playerJoined", slot: joined.slot }]);

    // A second loss that is not recovered expires the room on the next sweep.
    expect(registry.hostLeave(credentials.code, resumedHost)).toBe(true);
    clock.advance(HOST_RESERVATION_MS);
    registry.sweep();

    expect(registry.getRoom(credentials.code)).toBeUndefined();
    expect(registry.roomCount()).toBe(0);
    expect(controller.jsonMessages()).toContainEqual({ t: "kick", reason: "hostLost" });
    expect(controller.closes).toEqual([{ code: 1000, reason: "host lost" }]);
  });

  test("[SR-5][FR-5.6] the limiter runs before token and PIN comparison", () => {
    const { registry, clock } = makeRegistry({
      rateLimiter: createJoinRateLimiter({
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 1_000,
      }),
    });
    const credentials = registry.createRoom();
    const peer = new FakePeer({ remoteAddress: "10.0.0.9" });
    const otherPeer = new FakePeer({ remoteAddress: "10.0.0.10" });
    const wrongToken =
      (credentials.roomToken[0] === "A" ? "B" : "A") + credentials.roomToken.slice(1);

    // A wrong token locks the IP immediately (maxAttempts 1).
    expect(registry.join({ code: credentials.code, token: wrongToken }, peer)).toEqual({
      ok: false,
      reason: "badToken",
    });
    // The correct token is refused while locked out: the limiter precedes the
    // credential comparison, so a lockout cannot be bypassed by guessing right.
    expect(registry.join({ code: credentials.code, token: credentials.roomToken }, peer)).toEqual({
      ok: false,
      reason: "rateLimited",
    });
    // Another IP is unaffected by this peer's lockout.
    expect(
      registry.join({ code: credentials.code, token: credentials.roomToken }, otherPeer),
    ).toMatchObject({ ok: true });

    clock.advance(1_000);
    expect(
      registry.join({ code: credentials.code, token: credentials.roomToken }, peer),
    ).toMatchObject({ ok: true });
  });

  test("[FR-7.14][G4] one stats collector per registry records forwarded input", () => {
    const { registry, clock } = makeRegistry();
    const credentials = registry.createRoom();
    const host = new FakePeer();
    expect(registry.hostJoin(credentials.code, credentials.hostToken, host)).toEqual({ ok: true });
    const joined = registry.join({ code: credentials.code, pin: credentials.pin }, new FakePeer());
    if (!joined.ok) {
      throw new Error(`controller join failed: ${joined.reason}`);
    }
    const room = registry.getRoom(credentials.code);
    if (room === undefined) {
      throw new Error("created room is missing from the registry");
    }

    expect(registry.statsCollector()).toBe(registry.statsCollector());
    registry.routeInput(credentials.code, joined.slot, input({ tick: 1 }));
    registry.routeInput(credentials.code, joined.slot, input({ tick: 2 }));

    expect(registry.statsCollector().collect(room, clock.now())).toEqual([
      expect.objectContaining({ slot: joined.slot, packetsPerSecond: 2, drops: 0 }),
    ]);
  });
});

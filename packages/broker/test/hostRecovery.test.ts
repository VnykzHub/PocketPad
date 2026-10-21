/**
 * Host token recovery, the 30 s hostLost window and A9 hostStatus broadcasts
 * (D4-SRV-03).
 *
 * Rooms, controllers and sessions come from the real `RoomRegistry`; the host
 * state machine is the `HostRecovery` module this work item owns. Clocks are
 * injected, so every 30 s boundary is deterministic and nothing sleeps.
 */
import { describe, expect, test } from "vitest";
import type { InputState } from "@lanpad/protocol";
import { SLOT_RESERVATION_MS, type Room, type RoomRegistry } from "../src/index.js";
import { HOST_RESERVATION_MS, HostRecovery } from "../src/room/host.js";
import {
  FakePeer,
  assertNoSecretsLogged,
  createTestLogger,
  makeRegistry,
} from "./helpers.js";

interface ControllerHandle {
  slot: number;
  session: string;
  peer: FakePeer;
}

function setup() {
  const harness = makeRegistry();
  const { logger, calls } = createTestLogger();
  const expiredRooms: Room[] = [];
  const recovery = new HostRecovery({
    logger,
    onRoomExpired: (room) => {
      expiredRooms.push(room);
    },
  });
  const credentials = harness.registry.createRoom();
  const room = harness.registry.getRoom(credentials.code);
  if (room === undefined) {
    throw new Error("created room is missing from the registry");
  }
  return { ...harness, recovery, credentials, room, hostCalls: calls, expiredRooms };
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

function statuses(peer: FakePeer) {
  return peer
    .jsonMessages()
    .flatMap((message) => (message.t === "hostStatus" ? [message.state] : []));
}

function presence(peer: FakePeer) {
  return peer.jsonMessages().flatMap((message) =>
    message.t === "playerJoined" || message.t === "playerSuspended"
      ? [{ t: message.t, slot: message.slot }]
      : [],
  );
}

describe("D4 host recovery", () => {
  test("[FR-7.16] host lost for 30 seconds resumes with the host token", () => {
    const { registry, clock, recovery, credentials, room } = setup();
    const controller = joinController(registry, credentials.code, credentials.pin);

    const host = new FakePeer();
    const attachedAt = clock.now();
    expect(recovery.hostJoin(room, credentials.hostToken, host, attachedAt)).toEqual({
      ok: true,
      resumed: false,
    });
    expect(host.jsonMessages()).toContainEqual({ t: "playerJoined", slot: controller.slot });
    host.sent.length = 0;
    controller.peer.sent.length = 0;

    const lostAt = clock.now();
    expect(recovery.hostLeave(room, host, lostAt)).toBe(true);
    expect(room.state).toBe("hostLost");
    expect(statuses(controller.peer)).toEqual(["lost"]);
    expect(recovery.hostState(room)).toBe("lost");
    expect(recovery.acceptsInput(room)).toBe(false);

    // No host is attached, so input is dropped rather than queued forever.
    registry.routeInput(room.code, controller.slot, input({ buttons: 1 }));
    expect(host.sent.filter((frame) => typeof frame !== "string")).toHaveLength(0);

    clock.set(lostAt + HOST_RESERVATION_MS - 1);
    const resumedHost = new FakePeer();
    expect(recovery.hostJoin(room, credentials.hostToken, resumedHost, clock.now())).toEqual({
      ok: true,
      resumed: true,
    });

    expect(room.state).toBe("active");
    expect(room.host).toBe(resumedHost);
    expect(statuses(controller.peer)).toEqual(["lost", "active"]);
    expect(resumedHost.jsonMessages()).toContainEqual({
      t: "playerJoined",
      slot: controller.slot,
    });
    expect(room.controllers.get(controller.slot)?.session).toBe(controller.session);
    expect(recovery.acceptsInput(room)).toBe(true);
  });

  test("[FR-7.16] no host return expires the room and kicks controllers", () => {
    const { registry, clock, recovery, credentials, room, expiredRooms } = setup();
    const controller = joinController(registry, credentials.code, credentials.pin);

    const host = new FakePeer();
    expect(recovery.hostJoin(room, credentials.hostToken, host, clock.now()).ok).toBe(true);
    controller.peer.sent.length = 0;

    const lostAt = clock.now();
    expect(recovery.hostLeave(room, host, lostAt)).toBe(true);
    const deadline = lostAt + HOST_RESERVATION_MS;

    clock.set(deadline - 1);
    expect(recovery.sweep(room, clock.now())).toBe(false);
    expect(room.state).toBe("hostLost");

    clock.set(deadline);
    expect(recovery.sweep(room, clock.now())).toBe(true);
    expect(room.state).toBe("expired");
    expect(room.controllers.size).toBe(0);
    expect(controller.peer.jsonMessages()).toContainEqual({ t: "kick", reason: "hostLost" });
    expect(controller.peer.closes).toEqual([{ code: 1000, reason: "host lost" }]);
    expect(expiredRooms).toEqual([room]);

    expect(recovery.hostJoin(room, credentials.hostToken, new FakePeer(), clock.now())).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(HOST_RESERVATION_MS).toBe(SLOT_RESERVATION_MS);
  });

  test("[A9] controllers receive hostStatus active, paused and lost", () => {
    const { registry, clock, recovery, credentials, room } = setup();
    const first = joinController(registry, credentials.code, credentials.pin);
    const second = joinController(registry, credentials.code, credentials.pin);
    first.peer.sent.length = 0;
    second.peer.sent.length = 0;

    const host = new FakePeer();
    expect(recovery.hostJoin(room, credentials.hostToken, host, clock.now()).ok).toBe(true);
    expect(statuses(first.peer)).toEqual(["active"]);
    expect(statuses(second.peer)).toEqual(["active"]);

    expect(recovery.hostPause(room, host, clock.now())).toBe(true);
    expect(statuses(first.peer)).toEqual(["active", "paused"]);
    expect(statuses(second.peer)).toEqual(["active", "paused"]);

    expect(recovery.hostResume(room, host, clock.now())).toBe(true);
    expect(statuses(first.peer)).toEqual(["active", "paused", "active"]);

    expect(recovery.hostLeave(room, host, clock.now())).toBe(true);
    expect(statuses(first.peer)).toEqual(["active", "paused", "active", "lost"]);
    expect(statuses(second.peer)).toEqual(["active", "paused", "active", "lost"]);

    // A9 is server -> controller; the host never receives its own status.
    expect(host.jsonMessages().filter((message) => message.t === "hostStatus")).toHaveLength(0);
  });

  test("[FR-9.2] hostPause pauses the room and notifies controllers", () => {
    const { registry, clock, recovery, credentials, room } = setup();
    const controller = joinController(registry, credentials.code, credentials.pin);
    const host = new FakePeer();
    expect(recovery.hostJoin(room, credentials.hostToken, host, clock.now()).ok).toBe(true);
    controller.peer.sent.length = 0;

    const outsider = new FakePeer();
    expect(recovery.hostPause(room, outsider, clock.now())).toBe(false);
    expect(statuses(controller.peer)).toEqual([]);

    expect(recovery.hostPause(room, host, clock.now())).toBe(true);
    expect(statuses(controller.peer)).toEqual(["paused"]);
    expect(recovery.hostState(room)).toBe("paused");
    expect(recovery.acceptsInput(room)).toBe(false);
    expect(room.host).toBe(host);

    // Idempotent: a duplicate hostPause does not rebroadcast.
    expect(recovery.hostPause(room, host, clock.now())).toBe(true);
    expect(statuses(controller.peer)).toEqual(["paused"]);

    expect(recovery.hostResume(room, host, clock.now())).toBe(true);
    expect(statuses(controller.peer)).toEqual(["paused", "active"]);
    expect(recovery.hostState(room)).toBe("active");
    expect(recovery.acceptsInput(room)).toBe(true);

    expect(recovery.hostResume(room, host, clock.now())).toBe(true);
    expect(statuses(controller.peer)).toEqual(["paused", "active"]);
  });

  test("[G4] host recovery keeps eight slots and replays them without duplicates", () => {
    const { registry, clock, recovery, credentials, room } = setup();
    const controllers: ControllerHandle[] = [];
    for (let index = 0; index < 8; index += 1) {
      controllers.push(joinController(registry, credentials.code, credentials.pin));
    }
    const sessions = controllers.map((controller) => controller.session);
    const reserved = controllers[7];
    if (reserved === undefined) {
      throw new Error("the eighth controller did not join");
    }
    expect(registry.suspend(room.code, reserved.slot, clock.now(), reserved.peer)).toBe(true);

    const host = new FakePeer();
    expect(recovery.hostJoin(room, credentials.hostToken, host, clock.now()).ok).toBe(true);
    const firstReplay = presence(host);
    expect(firstReplay.filter((message) => message.t === "playerJoined")).toHaveLength(7);
    expect(firstReplay.filter((message) => message.t === "playerSuspended")).toEqual([
      { t: "playerSuspended", slot: 8 },
    ]);

    expect(recovery.hostLeave(room, host, clock.now())).toBe(true);
    clock.advance(1_000);
    const resumedHost = new FakePeer();
    expect(recovery.hostJoin(room, credentials.hostToken, resumedHost, clock.now())).toEqual({
      ok: true,
      resumed: true,
    });

    const replay = presence(resumedHost);
    expect(replay.filter((message) => message.t === "playerJoined").map((message) => message.slot)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(
      replay.filter((message) => message.t === "playerSuspended").map((message) => message.slot),
    ).toEqual([8]);
    // Eight distinct slots: recovery neither duplicates nor loses a player.
    expect(new Set(replay.map((message) => message.slot)).size).toBe(8);
    expect(room.controllers.size).toBe(8);
    controllers.forEach((controller, index) => {
      expect(room.controllers.get(index + 1)?.session).toBe(sessions[index]);
    });
  });

  test("[SR-9] host recovery logs never contain tokens", () => {
    const { registry, clock, recovery, credentials, room, hostCalls } = setup();
    const controller = joinController(registry, credentials.code, credentials.pin);

    const host = new FakePeer();
    expect(recovery.hostJoin(room, credentials.hostToken, host, clock.now()).ok).toBe(true);
    expect(recovery.hostPause(room, host, clock.now())).toBe(true);
    expect(recovery.hostResume(room, host, clock.now())).toBe(true);
    expect(recovery.hostLeave(room, host, clock.now())).toBe(true);
    clock.advance(HOST_RESERVATION_MS);
    expect(recovery.sweep(room, clock.now())).toBe(true);

    const events = hostCalls.map((call) => call.event);
    expect(events).toContain("room.hostLost");
    expect(events).toContain("room.hostExpired");
    assertNoSecretsLogged(hostCalls, [
      credentials.roomToken,
      credentials.hostToken,
      credentials.pin,
      controller.session,
    ]);
  });

  test("[FR-7.16] a wrong host token cannot reclaim a lost room", () => {
    const { clock, recovery, credentials, room } = setup();
    const host = new FakePeer();
    expect(recovery.hostJoin(room, credentials.hostToken, host, clock.now()).ok).toBe(true);

    // A second live host is refused even with the right token.
    expect(recovery.hostJoin(room, credentials.hostToken, new FakePeer(), clock.now())).toEqual({
      ok: false,
      reason: "badHostToken",
    });

    expect(recovery.hostLeave(room, host, clock.now())).toBe(true);
    const wrongToken =
      (credentials.hostToken[0] === "A" ? "B" : "A") + credentials.hostToken.slice(1);
    expect(recovery.hostJoin(room, wrongToken, new FakePeer(), clock.now())).toEqual({
      ok: false,
      reason: "badHostToken",
    });
    expect(recovery.hostJoin(room, "short", new FakePeer(), clock.now())).toEqual({
      ok: false,
      reason: "badHostToken",
    });
    expect(room.state).toBe("hostLost");

    // The real token still recovers the room inside the window.
    expect(recovery.hostJoin(room, credentials.hostToken, new FakePeer(), clock.now())).toEqual({
      ok: true,
      resumed: true,
    });
  });
});

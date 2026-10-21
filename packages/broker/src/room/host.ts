/**
 * Host presence, host-token recovery and hostStatus broadcasts (D4-SRV-03).
 *
 * A room lives on after its host socket drops: the room enters `hostLost`, a
 * 30 s reservation starts (FR-7.16) and every controller is told through the
 * A9 `hostStatus` message. Rejoining with the same `hostToken` inside the
 * window cancels the reservation, resumes the room and replays the slot table
 * as ordinary `playerJoined` / `playerSuspended` events, so the host UI needs
 * no separate snapshot message.
 *
 * This module is transport-agnostic like the rest of the broker: peers are the
 * `Peer` interface, time is passed in explicitly and nothing here logs a token
 * (SR-9). `RoomRegistry` owns lookup and lifecycle; it delegates host state to
 * one `HostRecovery` instance.
 */
import {
  stringifyJsonMessage,
  type HostStatusState,
  type ServerToClientMessage,
} from "@lanpad/protocol";
import type { Logger, Peer } from "../peer.js";
import type { Room } from "../room.js";
import { constantTimeEqual } from "../auth/tokens.js";
import { SLOT_RESERVATION_MS } from "./sessions.js";

/** FR-7.16: a dropped host keeps the room recoverable for 30 s. */
export const HOST_RESERVATION_MS = SLOT_RESERVATION_MS;

/** Result of `HostRecovery.hostJoin`. Room lookup (`badCode`) stays in the registry. */
export type HostJoinResult =
  | { ok: true; resumed: boolean }
  | { ok: false; reason: "expired" | "badHostToken" };

export interface HostRecoveryDeps {
  /** Structured logger; tokens and PINs must never be passed as fields (SR-9). */
  logger: Logger;
  /**
   * Called once when the 30 s host reservation lapses. The registry must
   * remove the room from its map here; the room object itself is already
   * marked `expired` and every controller has been kicked.
   */
  onRoomExpired?: (room: Room) => void;
}

/** Per-room host state, kept off the frozen `Room` shape. */
interface RoomHostState {
  phase: "never" | "active" | "lost" | "expired";
  paused: boolean;
  reservationExpiresAt: number | null;
}

function sendMessage(peer: Peer, message: ServerToClientMessage): boolean {
  try {
    peer.send(stringifyJsonMessage(message));
    return true;
  } catch {
    // A broken transport must not stop the remaining peers from being told.
    return false;
  }
}

/**
 * A9: tells every attached controller about host presence. Returns how many
 * peers accepted the frame (used only for log counters, never as a secret).
 */
export function broadcastHostStatus(room: Room, state: HostStatusState): number {
  let delivered = 0;
  for (const controller of room.controllers.values()) {
    if (controller.peer === null) {
      continue;
    }
    if (sendMessage(controller.peer, { t: "hostStatus", state })) {
      delivered += 1;
    }
  }
  return delivered;
}

/**
 * Rebuilds the host's slot table after a recovery: active slots are replayed
 * as `playerJoined`, reserved slots as `playerSuspended` (D4-SRV-03). Slots
 * are sent in ascending order so the host table is deterministic.
 */
export function replaySlots(room: Room, host: Peer): number {
  const controllers = [...room.controllers.values()].sort((left, right) => left.slot - right.slot);
  let delivered = 0;
  for (const controller of controllers) {
    const message: ServerToClientMessage =
      controller.peer === null
        ? { t: "playerSuspended", slot: controller.slot }
        : { t: "playerJoined", slot: controller.slot };
    if (sendMessage(host, message)) {
      delivered += 1;
    }
  }
  return delivered;
}

/**
 * Ends a room whose host never came back: controllers receive
 * `kick {reason:"hostLost"}`, their sockets close, and the room state becomes
 * `expired` (FR-7.16). Returns the number of kicked controllers.
 */
export function expireHostLostRoom(room: Room): number {
  const peers: Peer[] = [];
  for (const controller of room.controllers.values()) {
    if (controller.peer !== null) {
      peers.push(controller.peer);
    }
  }

  room.state = "expired";
  room.host = null;
  room.controllers.clear();
  room.reservations.clear();

  const kick = stringifyJsonMessage({ t: "kick", reason: "hostLost" });
  for (const peer of peers) {
    try {
      peer.send(kick);
    } catch {
      // The close below still tears the transport down.
    }
  }
  for (const peer of peers) {
    try {
      peer.close(1000, "host lost");
    } catch {
      // Already gone.
    }
  }
  return peers.length;
}

/**
 * Host half of the room lifecycle: token auth, pause/resume and the 30 s
 * lost-host reservation. One instance per registry; room state is keyed by the
 * `Room` object, so a recreated room with the same code starts clean.
 */
export class HostRecovery {
  private readonly states = new WeakMap<Room, RoomHostState>();
  private readonly logger: Logger;
  private readonly onRoomExpired: ((room: Room) => void) | undefined;

  constructor(deps: HostRecoveryDeps) {
    this.logger = deps.logger;
    this.onRoomExpired = deps.onRoomExpired;
  }

  /**
   * Authenticates a host socket with the 128-bit host token (A2, SR-1).
   *
   * - First attach: activates the room and broadcasts `hostStatus active`.
   * - Reload inside the reservation: same as above plus a slot replay.
   * - Reload after the reservation: `expired` (and any remaining controllers
   *   are kicked lazily, even if the adapter sweep has not run yet).
   * - Wrong token or a second live host: `badHostToken`.
   */
  hostJoin(room: Room, hostToken: string, peer: Peer, now: number): HostJoinResult {
    if (room.state === "expired") {
      return { ok: false, reason: "expired" };
    }
    const state = this.stateFor(room);
    if (state.phase === "expired") {
      return { ok: false, reason: "expired" };
    }
    if (!constantTimeEqual(hostToken, room.hostToken)) {
      return { ok: false, reason: "badHostToken" };
    }
    // A repeated hostJoin from the live host is idempotent: no duplicate
    // player events and no duplicate hostStatus broadcast (G4).
    if (state.phase === "active" && room.host === peer) {
      return { ok: true, resumed: false };
    }
    if (state.phase === "active" && room.host !== null) {
      return { ok: false, reason: "badHostToken" };
    }
    if (state.phase === "lost") {
      if (state.reservationExpiresAt === null || now >= state.reservationExpiresAt) {
        this.expireForHostLoss(room, now);
        return { ok: false, reason: "expired" };
      }
    }

    const resumed = state.phase === "lost";
    room.host = peer;
    room.state = "active";
    room.lastActivityAt = now;
    state.phase = "active";
    state.paused = false;
    state.reservationExpiresAt = null;

    const listeners = broadcastHostStatus(room, "active");
    const replayed = replaySlots(room, peer);
    this.logger.info(resumed ? "room.hostResume" : "room.hostJoin", {
      code: room.code,
      players: room.controllers.size,
      listeners,
      replayed,
    });
    return { ok: true, resumed };
  }

  /**
   * The host socket closed. The room enters `hostLost` for 30 s; controllers
   * keep their slots and sessions and see `hostStatus lost` (FR-7.16, A9).
   * Stale close events from an already-replaced peer are ignored.
   */
  hostLeave(room: Room, peer: Peer, now: number): boolean {
    const state = this.stateFor(room);
    if (room.host !== peer || state.phase !== "active") {
      return false;
    }
    room.host = null;
    room.state = "hostLost";
    state.phase = "lost";
    state.paused = false;
    state.reservationExpiresAt = now + HOST_RESERVATION_MS;

    const listeners = broadcastHostStatus(room, "lost");
    this.logger.info("room.hostLost", {
      code: room.code,
      players: room.controllers.size,
      listeners,
    });
    return true;
  }

  /**
   * `hostPause` (FR-9.2): controllers see `hostStatus paused`. The pause flag
   * lives here because `RoomState` is frozen without a `paused` member; use
   * `hostState(room)` for readers. Idempotent.
   */
  hostPause(room: Room, peer: Peer, now: number): boolean {
    const state = this.stateFor(room);
    if (room.host !== peer || state.phase !== "active") {
      return false;
    }
    if (state.paused) {
      return true;
    }
    state.paused = true;
    room.lastActivityAt = now;
    const listeners = broadcastHostStatus(room, "paused");
    this.logger.info("room.hostPause", { code: room.code, listeners });
    return true;
  }

  /** `hostResume`: controls see `hostStatus active` again. Idempotent. */
  hostResume(room: Room, peer: Peer, now: number): boolean {
    const state = this.stateFor(room);
    if (room.host !== peer || state.phase !== "active") {
      return false;
    }
    if (!state.paused) {
      return true;
    }
    state.paused = false;
    room.lastActivityAt = now;
    const listeners = broadcastHostStatus(room, "active");
    this.logger.info("room.hostResume", { code: room.code, listeners });
    return true;
  }

  /**
   * One sweep tick from the adapter. Expires a host-lost room when its 30 s
   * reservation lapses (FR-7.16). Returns true when the room was expired and
   * should be dropped by the registry.
   */
  sweep(room: Room, now: number): boolean {
    const state = this.stateFor(room);
    if (state.phase !== "lost") {
      return false;
    }
    if (state.reservationExpiresAt === null || now < state.reservationExpiresAt) {
      return false;
    }
    this.expireForHostLoss(room, now);
    return true;
  }

  /** A9 state for the room, suitable for UI or diagnostics. */
  hostState(room: Room): HostStatusState {
    const state = this.stateFor(room);
    if (room.state === "expired" || state.phase === "expired") {
      return "lost";
    }
    if (state.paused) {
      return "paused";
    }
    return state.phase === "active" ? "active" : "lost";
  }

  /**
   * True while controller input may be delivered to the host. False while the
   * host is lost or paused; `RoomRegistry.routeInput` should count a drop
   * instead of forwarding when this is false (FR-9.2).
   */
  acceptsInput(room: Room): boolean {
    const state = this.stateFor(room);
    return (
      room.state !== "expired" &&
      state.phase === "active" &&
      !state.paused &&
      room.host !== null
    );
  }

  private expireForHostLoss(room: Room, now: number): void {
    const state = this.stateFor(room);
    state.phase = "expired";
    state.reservationExpiresAt = null;
    const kicked = expireHostLostRoom(room);
    this.logger.info("room.hostExpired", {
      code: room.code,
      players: kicked,
      ageMs: Math.max(0, now - room.createdAt),
    });
    this.onRoomExpired?.(room);
  }

  private stateFor(room: Room): RoomHostState {
    const existing = this.states.get(room);
    if (existing !== undefined) {
      return existing;
    }
    const created: RoomHostState = {
      phase: "never",
      paused: false,
      reservationExpiresAt: null,
    };
    this.states.set(room, created);
    return created;
  }
}

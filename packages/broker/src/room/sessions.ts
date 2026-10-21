/**
 * Session, slot and reservation mechanics (D4-SRV-02).
 *
 * These are pure room invariants: no transport, no logging, no timers and no
 * wall clock. `RoomRegistry` owns fan-out and lifecycle; this module decides
 * whether a slot is active, reserved or free and when a room has expired.
 *
 * Frozen contracts:
 * - A reservation holds a slot for 30 s from `suspend` or socket close
 *   (FR-5.4). The slot stays in `room.controllers` with `peer === null` so
 *   slot numbers, join order and per-slot history survive a reconnect.
 * - `room.reservations` is the authority for a live reservation, keyed by
 *   session token. `ControllerSlot.reservationExpiresAt` mirrors it for
 *   readers that only hold a slot.
 * - Session lookup is per room and compared in constant time (SR-1). A
 *   session token from another room is simply unknown here.
 */
import { MAX_CONTROLLERS } from "@lanpad/protocol";
import { constantTimeEqual } from "../auth/tokens.js";
import {
  ROOM_IDLE_TIMEOUT_MS,
  ROOM_MAX_LIFETIME_MS,
  type ControllerSlot,
  type Reservation,
  type Room,
} from "../room.js";

/** FR-5.4: a dropped controller keeps its slot for 30 s. */
export const SLOT_RESERVATION_MS = 30_000;

/** Result of looking a session token up inside one room. */
export type SessionLookup =
  | { status: "missing" }
  | { status: "active"; controller: ControllerSlot }
  | { status: "reserved"; controller: ControllerSlot; reservation: Reservation }
  | { status: "stale"; controller: ControllerSlot; reservation: Reservation | null };

/** Why a room is past its life limit; null while it is still usable. */
export type RoomExpiryReason = "idle" | "maxAge";

/** One expired reservation, returned by `expireReservations` for host fan-out. */
export interface ExpiredReservation {
  controller: ControllerSlot;
  reservation: Reservation;
}

/**
 * Finds the reservation for a session token without leaking comparison time
 * (SR-1). Rooms hold at most eight entries, so a scan is cheaper than a
 * second hash map and keeps the token itself out of Map key comparisons.
 */
export function findReservation(room: Room, session: string): Reservation | undefined {
  for (const [key, reservation] of room.reservations) {
    if (constantTimeEqual(key, session)) {
      return reservation;
    }
  }
  return undefined;
}

/** Looks a session token up among active and reserved slots (FR-5.4). */
export function findSession(room: Room, session: string, now: number): SessionLookup {
  for (const controller of room.controllers.values()) {
    if (!constantTimeEqual(controller.session, session)) {
      continue;
    }
    if (controller.peer !== null) {
      return { status: "active", controller };
    }
    const reservation = findReservation(room, session);
    if (reservation !== undefined && reservation.expiresAt > now) {
      return { status: "reserved", controller, reservation };
    }
    // The sweeper usually removes these first; a rejoin may arrive between
    // ticks, so the stale slot is reported for lazy cleanup (FR-5.5).
    return { status: "stale", controller, reservation: reservation ?? null };
  }
  return { status: "missing" };
}

/** True while a slot has no controller and no live reservation. */
export function slotIsFree(room: Room, slot: number, now: number): boolean {
  if (room.controllers.has(slot)) {
    return false;
  }
  for (const reservation of room.reservations.values()) {
    if (reservation.slot === slot && reservation.expiresAt > now) {
      return false;
    }
  }
  return true;
}

/** Lowest free slot, or null when eight controllers are active or reserved. */
export function nextFreeSlot(room: Room, now: number): number | null {
  for (let slot = 1; slot <= MAX_CONTROLLERS; slot += 1) {
    if (slotIsFree(room, slot, now)) {
      return slot;
    }
  }
  return null;
}

/**
 * Detaches the controller from its transport and starts the 30 s reservation
 * (FR-5.4 / FR-7.14). Repeated calls are no-ops: a second close must not
 * extend the window.
 */
export function reserveSlot(room: Room, controller: ControllerSlot, now: number): Reservation {
  const reservation: Reservation = {
    slot: controller.slot,
    expiresAt: now + SLOT_RESERVATION_MS,
  };
  controller.peer = null;
  controller.reservationExpiresAt = reservation.expiresAt;
  room.reservations.set(controller.session, reservation);
  return reservation;
}

/** Removes any reservation held by a session token (constant-time match). */
export function clearReservationFor(room: Room, session: string): void {
  for (const key of [...room.reservations.keys()]) {
    if (constantTimeEqual(key, session)) {
      room.reservations.delete(key);
    }
  }
}

/**
 * Removes every reservation whose window has closed and frees its slot
 * (FR-5.5). Active slots always win over a stale map entry.
 */
export function expireReservations(room: Room, now: number): ExpiredReservation[] {
  const expired: ExpiredReservation[] = [];
  for (const [session, reservation] of [...room.reservations]) {
    if (reservation.expiresAt > now) {
      continue;
    }
    room.reservations.delete(session);
    const controller = room.controllers.get(reservation.slot);
    if (controller === undefined || controller.peer !== null) {
      continue;
    }
    room.controllers.delete(controller.slot);
    controller.reservationExpiresAt = null;
    expired.push({ controller, reservation });
  }
  return expired;
}

/** True when the 10 min idle or 4 h maximum limit has been reached (FR-5.2). */
export function isRoomExpired(room: Room, now: number): boolean {
  return roomExpiryReason(room, now) !== null;
}

/** Which limit expired the room, or null while it is still usable. */
export function roomExpiryReason(room: Room, now: number): RoomExpiryReason | null {
  if (now >= room.createdAt + ROOM_MAX_LIFETIME_MS) {
    return "maxAge";
  }
  if (now >= room.lastActivityAt + ROOM_IDLE_TIMEOUT_MS) {
    return "idle";
  }
  return null;
}

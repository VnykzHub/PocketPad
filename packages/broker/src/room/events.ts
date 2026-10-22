/**
 * Opaque event routing and per-slot event rate limiting (D5-SRV-01).
 *
 * The broker is a router, not a validator of game payloads: `event.data` is
 * forwarded byte-for-byte as parsed, never inspected, stored or logged
 * (FR-7.9). The only field trusted from the controller is the event name for
 * diagnostics; even the name is a protocol-validated identifier.
 *
 * Per-slot token bucket: 30/s sustained with a burst of 60 (FR-7.8). The
 * bucket is created lazily on the slot's first event, starts full and is
 * removed when the slot is freed or expires, so a rejoin starts clean.
 */
import {
  MAX_LAYOUT_ID_CHARS,
  stringifyJsonMessage,
  type EventMessage,
} from "@lanpad/protocol";
import type { Logger } from "../peer.js";
import type { ControllerSlot, Room } from "../room.js";
import { TokenBucket } from "./rateLimit.js";

/** FR-7.8: sustained events per second for one slot. */
export const EVENT_RATE_PER_SECOND = 30;

/** FR-7.8: largest allowed instantaneous event burst for one slot. */
export const EVENT_BURST = 60;

function activeController(room: Room, slot: number): ControllerSlot | undefined {
  const controller = room.controllers.get(slot);
  return controller !== undefined && controller.peer !== null ? controller : undefined;
}

function bucketFor(room: Room, slot: number, now: number): TokenBucket {
  let bucket = room.eventBuckets.get(slot);
  if (bucket === undefined) {
    bucket = new TokenBucket(
      { ratePerSecond: EVENT_RATE_PER_SECOND, burst: EVENT_BURST },
      now,
    );
    room.eventBuckets.set(slot, bucket);
  }
  return bucket;
}

/**
 * Routes one controller event to the host (D5 contract 4).
 *
 * `authenticatedSlot` is the slot assigned at join, never the wire value. A
 * controller-supplied `event.slot` that disagrees is dropped and counted
 * instead of forwarded. Rate-limited events are dropped and counted the same
 * way; the socket stays open (the abuse threshold belongs to P3).
 */
export function routeEvent(
  room: Room,
  authenticatedSlot: number,
  event: EventMessage,
  now: number,
  logger?: Logger,
): boolean {
  const controller = activeController(room, authenticatedSlot);
  if (controller === undefined) {
    return false;
  }
  room.lastActivityAt = now;
  controller.lastSeenAt = now;

  if (event.slot !== authenticatedSlot) {
    controller.drops += 1;
    logger?.debug?.("event.drop", {
      code: room.code,
      slot: authenticatedSlot,
      name: event.name,
      result: "slotMismatch",
    });
    return false;
  }

  if (!bucketFor(room, authenticatedSlot, now).take(now)) {
    controller.drops += 1;
    logger?.debug?.("event.drop", {
      code: room.code,
      slot: authenticatedSlot,
      name: event.name,
      result: "rateLimited",
    });
    return false;
  }

  const host = room.host;
  if (host === null) {
    controller.drops += 1;
    return false;
  }

  try {
    // The slot is rebuilt from the authenticated value; `data` is untouched
    // (FR-7.9).
    host.send(
      stringifyJsonMessage({
        t: "event",
        slot: authenticatedSlot,
        name: event.name,
        data: event.data,
      }),
    );
  } catch {
    controller.drops += 1;
    return false;
  }

  // Names are safe identifiers and are allowed in diagnostics; bodies never
  // reach the logger (SR-9, FR-7.9).
  logger?.debug?.("event.route", {
    code: room.code,
    slot: authenticatedSlot,
    name: event.name,
  });
  return true;
}

/**
 * Forwards a controller layout ack to the host with the authenticated slot
 * filled in (D5-SRV-01). Any controller-supplied `slot` is ignored by
 * construction: the caller passes the slot assigned at join.
 */
export function routeLayoutAck(
  room: Room,
  authenticatedSlot: number,
  layoutId: string,
  now: number,
  logger?: Logger,
): boolean {
  const controller = activeController(room, authenticatedSlot);
  if (controller === undefined) {
    return false;
  }
  if (layoutId.length < 1 || layoutId.length > MAX_LAYOUT_ID_CHARS) {
    return false;
  }
  room.lastActivityAt = now;
  controller.lastSeenAt = now;

  const host = room.host;
  if (host === null) {
    return false;
  }
  try {
    host.send(
      stringifyJsonMessage({
        t: "layoutAck",
        layoutId,
        slot: authenticatedSlot,
      }),
    );
  } catch {
    logger?.debug?.("layoutAck.drop", {
      code: room.code,
      slot: authenticatedSlot,
    });
    return false;
  }
  return true;
}

/**
 * Layout and private-panel routing (D5-SRV-01).
 *
 * Layouts and panels are opaque bodies: the broker reads only `layout.id` (the
 * ack key) and whether `panel.content` is null (the documented clear path).
 * Everything else is forwarded untouched (FR-7.9). State is the minimum needed
 * for rejoin:
 *
 * - the last layout per slot, including slots that are currently reserved;
 * - the last panel per slot, never event bodies and never a panel for a slot
 *   that has no controller record. A clear that a detached peer missed is
 *   kept as a `null` marker so the rejoin replays it; a slot that never had a
 *   panel stores nothing and stays silent on rejoin.
 *
 * Panels are private: they are sent directly to the addressed slot's peer and
 * never to the host or another controller (SR-13).
 */
import {
  MAX_LAYOUT_ID_CHARS,
  stringifyJsonMessage,
  type JsonValue,
  type ServerToClientMessage,
} from "@lanpad/protocol";
import type { ControllerSlot, Room } from "../room.js";

/** True when the body is an object with the required non-empty string id. */
function hasLayoutId(layout: JsonValue): boolean {
  if (typeof layout !== "object" || layout === null || Array.isArray(layout)) {
    return false;
  }
  const id = layout["id"];
  return typeof id === "string" && id.length >= 1 && id.length <= MAX_LAYOUT_ID_CHARS;
}

function sendJson(controller: ControllerSlot, message: ServerToClientMessage): boolean {
  if (controller.peer === null) {
    return false;
  }
  try {
    controller.peer.send(stringifyJsonMessage(message));
    return true;
  } catch {
    // An unserializable/oversized frame is a caller bug; drop it rather than
    // emit a frame the controller must reject. The incoming JSON cap already
    // prevents this in the WS path.
    return false;
  }
}

/**
 * Sends a host layout to one slot or every slot with a controller record
 * (active or reserved) and records it for rejoin (D5-SRV-01).
 *
 * Returns true when at least one slot record exists and the layout was
 * accepted. A reserved slot is recorded but cannot receive until rejoin.
 */
export function setLayout(
  room: Room,
  slot: number | "all",
  layout: JsonValue,
  now: number,
): boolean {
  if (!hasLayoutId(layout)) {
    return false;
  }
  room.lastActivityAt = now;

  if (slot === "all") {
    let applied = false;
    for (const controller of room.controllers.values()) {
      applied = true;
      room.layouts.set(controller.slot, layout);
      sendJson(controller, { t: "setLayout", slot: "all", layout });
    }
    return applied;
  }

  const controller = room.controllers.get(slot);
  if (controller === undefined) {
    return false;
  }
  room.layouts.set(slot, layout);
  sendJson(controller, { t: "setLayout", slot, layout });
  return true;
}

/**
 * Sends a private panel to exactly the addressed slot and records it for
 * rejoin. `content: null` is the clear path: it is forwarded so the controller
 * clears its UI, and a stored panel is replaced with a `null` marker so a
 * clear issued while the peer was absent is replayed when it returns. A slot
 * that never had a panel keeps no marker and receives no frame on rejoin.
 */
export function setPanel(
  room: Room,
  slot: number,
  content: JsonValue,
  now: number,
): boolean {
  const controller = room.controllers.get(slot);
  if (controller === undefined) {
    return false;
  }
  room.lastActivityAt = now;
  if (content === null) {
    if (room.panels.has(slot)) {
      room.panels.set(slot, null);
    }
  } else {
    room.panels.set(slot, content);
  }
  sendJson(controller, { t: "panel", slot, content });
  return true;
}

/**
 * Re-sends the stored layout and panel for one slot to its active peer, in
 * that order. The adapter calls this immediately after `joined` on every
 * successful controller join, so a rejoin recovers without a host resend
 * (D5-SRV-01). A stored `null` panel is a clear marker and is replayed as
 * `content:null`; a slot with no marker receives no panel frame. Returns the
 * number of frames sent (0..2).
 */
export function replayChannelState(room: Room, slot: number): number {
  const controller = room.controllers.get(slot);
  if (controller === undefined || controller.peer === null) {
    return 0;
  }

  let sent = 0;
  const layout = room.layouts.get(slot);
  if (layout !== undefined && sendJson(controller, { t: "setLayout", slot, layout })) {
    sent += 1;
  }
  if (room.panels.has(slot)) {
    const content = room.panels.get(slot) ?? null;
    if (sendJson(controller, { t: "panel", slot, content })) {
      sent += 1;
    }
  }
  return sent;
}

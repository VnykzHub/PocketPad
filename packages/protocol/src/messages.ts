/**
 * JSON control-message catalogue (D0-PROTO-01; D5-PROTO-01 extends it).
 *
 * One discriminated union on `t` covers every JSON control message in both
 * directions. Later stages add variants; they must never add a side-channel
 * message format.
 *
 * Timing (amendment A3): the binary `tick` field and the `serverTime` fields
 * below are server-clock **milliseconds**, never frame counters. `tick` is
 * truncated to u32 on the wire and wraps every ~49.7 days.
 */

/** Any value JSON can represent. Layout and panel bodies stay opaque to the server (FR-7.9). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Reasons a join or host join can be refused.
 *
 * D0 set from the spec plus A2. D4 adds `badVersion` (A10) and P3 adds
 * `pinRequired` (A11); adding union members is an additive change.
 */
export type JoinErrorReason =
  | "roomFull"
  | "badToken"
  | "badPin"
  | "expired"
  | "rateLimited"
  | "badCode"
  | "badHostToken"
  | "badVersion";

/** Host presence broadcast to controllers (amendment A9). */
export type HostStatusState = "active" | "paused" | "lost";

/** Per-slot statistics sent by the server at 1 Hz (spec §7.2). */
export interface SlotStats {
  slot: number;
  rttMs: number;
  jitterMs: number;
  lastInputAgeMs: number;
  packetsPerSecond: number;
  drops: number;
}

/** One sampled point of a batched freehand stroke; normalized 0..1, `t` in ms. */
export interface StrokePoint {
  x: number;
  y: number;
  t: number;
}

/**
 * `event.data` for canvas controls (D5 contract 5). Points are normalized
 * 0..1; a controller batches them into `start` / `move`* / `end` phases so a
 * stroke never becomes one event per point (FR-7.8).
 */
export interface StrokeEventData {
  points: StrokePoint[];
  color: string;
  width: number;
  phase: "start" | "move" | "end";
}

/**
 * `event.data` for text and choice controls (D5 contract 6). `value` is the
 * submitted answer or the picked option; text is already truncated to the
 * control's `maxLen`.
 */
export interface ValueEventData {
  value: string;
}

/**
 * Controller → server → host user event (spec §7.2).
 *
 * `data` is deliberately opaque: the server forwards it unchanged and games
 * validate their own schema (FR-7.9). `slot` is advisory on the client leg;
 * the server must compare it with the authenticated peer and must never route
 * on the value the controller supplied (D5-SRV-01).
 */
export interface EventMessage {
  t: "event";
  slot: number;
  name: string;
  data: JsonValue;
}

/**
 * Controller → server layout confirmation (spec §7.2; D5 contract 2).
 *
 * The controller reports only the id it applied. The server adds `slot` from
 * the authenticated peer when forwarding to the host (`LayoutAckForwardMessage`);
 * a controller never owns that field.
 */
export interface LayoutAckMessage {
  t: "layoutAck";
  layoutId: string;
}

/** Server → host forward of a layout ack, with the slot filled from the peer. */
export interface LayoutAckForwardMessage extends LayoutAckMessage {
  /** Authenticated slot; never taken from the controller's frame. */
  slot: number;
}

/** Messages a socket in the controller role may send (plus `hostJoin` for the host handshake). */
export type ClientToServerMessage =
  | {
      t: "join";
      v: number;
      code: string;
      token?: string;
      pin?: string;
      session?: string;
      name?: string;
    }
  | { t: "hostJoin"; v: number; code: string; hostToken: string }
  | { t: "suspend" }
  | { t: "leave" }
  | EventMessage
  | LayoutAckMessage;

/** Messages only the host socket may send. */
export type HostToServerMessage =
  | { t: "hostPause" }
  | { t: "hostResume" }
  | { t: "setLayout"; slot: number | "all"; layout: JsonValue }
  | { t: "panel"; slot: number; content: JsonValue };

/** Messages the server may send to a controller or host socket. */
export type ServerToClientMessage =
  | { t: "joined"; slot: number; session: string; serverTime: number; layout?: JsonValue }
  | { t: "hostJoined"; code: string; serverTime: number }
  | { t: "hostStatus"; state: HostStatusState }
  | { t: "joinError"; reason: JoinErrorReason }
  | { t: "playerJoined"; slot: number }
  | { t: "playerLeft"; slot: number }
  | { t: "playerSuspended"; slot: number }
  | { t: "playerResumed"; slot: number }
  | { t: "setLayout"; slot: number | "all"; layout: JsonValue }
  | { t: "panel"; slot: number; content: JsonValue }
  | EventMessage
  | LayoutAckForwardMessage
  | { t: "kick"; reason: string }
  | { t: "stats"; slots: SlotStats[] };

/** The complete JSON catalogue. Validation and role guards live in `json.ts`. */
export type JsonControlMessage =
  | ClientToServerMessage
  | HostToServerMessage
  | ServerToClientMessage;

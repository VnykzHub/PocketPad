/**
 * JSON control-message catalogue (D0-PROTO-01).
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
  | { t: "event"; slot: number; name: string; data: JsonValue };

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
  | { t: "kick"; reason: string }
  | { t: "stats"; slots: SlotStats[] };

/** The complete JSON catalogue. Validation and role guards live in `json.ts`. */
export type JsonControlMessage =
  | ClientToServerMessage
  | HostToServerMessage
  | ServerToClientMessage;

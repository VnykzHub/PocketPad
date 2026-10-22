/**
 * Room and session data shapes (D0-SRV-02, extended by D4-SRV-02).
 *
 * The field names here are frozen for D0: D4 fills sessions and reservations
 * without renaming anything. Additive fields are allowed.
 */
import type { JoinErrorReason, JsonValue } from "@lanpad/protocol";
import type { Peer } from "./peer.js";
import type { TokenBucket } from "./room/rateLimit.js";

/** A room is active while the host is attached; D4 adds the 30 s hostLost window. */
export type RoomState = "active" | "hostLost" | "expired";

/** One occupied controller slot. Slots are 1..8 (FR-5.3). */
export interface ControllerSlot {
  slot: number;
  /** Per-player session token issued on join (FR-5.4; consumed from D4). */
  session: string;
  /** Null while the slot is suspended or reserved (D4-SRV-02). */
  peer: Peer | null;
  /** Optional display name, rendered as text only. */
  name?: string;
  joinedAt: number;
  /** Last binary Input frame; drives `lastInputAgeMs` in host stats. */
  lastInputAt: number;
  /** Last valid message or frame from this controller (D4-SRV-02). */
  lastSeenAt: number;
  /** Epoch ms until which the slot is held after a drop; null while attached. */
  reservationExpiresAt: number | null;
  /** Per-slot transport statistics, filled by D4-SRV-03. */
  rttMs: number;
  jitterMs: number;
  packetsPerSecond: number;
  drops: number;
}

/** A held slot for a disconnected controller (D4-SRV-02). */
export interface Reservation {
  slot: number;
  expiresAt: number;
}

/** Response body of `POST /api/rooms` (amendment A8). */
export interface RoomCredentials {
  code: string;
  pin: string;
  roomToken: string;
  hostToken: string;
  /** Epoch ms, creation + 4 h (FR-5.2). */
  expiresAt: number;
  serverTime: number;
}

export interface Room {
  code: string;
  pin: string;
  roomToken: string;
  hostToken: string;
  createdAt: number;
  lastActivityAt: number;
  state: RoomState;
  host: Peer | null;
  controllers: Map<number, ControllerSlot>;
  /** Keyed by session token; a live entry means the slot is reserved. */
  reservations: Map<string, Reservation>;
  /** Input frames dropped because no host was attached or the host was backed up. */
  droppedInputs: number;
  /**
   * A11 optional QR-PIN mode. P3 owns the setting; D4 rooms default to false,
   * where a room token alone is sufficient.
   */
  requirePinForQr: boolean;
  /** Per-slot event token buckets (D5-SRV-01: 30/s, burst 60). */
  eventBuckets: Map<number, TokenBucket>;
  /** Last layout routed to each slot, for rejoin replay (D5-SRV-01). */
  layouts: Map<number, JsonValue>;
  /**
   * Last private panel per slot; `content:null` stores a clear marker that is
   * replayed to a rejoining controller (D5-SRV-01). A slot with no key has
   * never had a panel and receives nothing on rejoin.
   */
  panels: Map<number, JsonValue>;
  /** Per-slot haptic token buckets (D6-SRV-01: 20/s). */
  hapticBuckets: Map<number, TokenBucket>;
  /** Haptic commands dropped by validation or the 20 Hz limiter (D6-SRV-01). */
  hapticDrops: number;
}

/** Optional room settings. D4 uses the default (false) for every room. */
export interface CreateRoomOptions {
  requirePinForQr?: boolean;
}

/**
 * Join credentials (FR-5.1, A11): `session` alone, `token` alone, `pin` alone,
 * or `token` + `pin` when the room requires the PIN for QR joins. `session`
 * never combines with the other credentials.
 */
export interface JoinRequest {
  code: string;
  token?: string;
  pin?: string;
  session?: string;
  name?: string;
}

export type JoinResult =
  | { ok: true; slot: number; session: string; serverTime: number }
  | { ok: false; reason: JoinErrorReason };

/** Rooms expire after 10 minutes with no host/controller traffic (FR-5.2). */
export const ROOM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Rooms expire 4 hours after creation regardless of activity (FR-5.2). */
export const ROOM_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;

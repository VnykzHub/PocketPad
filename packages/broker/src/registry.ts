/**
 * RoomRegistry — the shared room/session core (D0-SRV-02, amendment A1;
 * sessions, slots and reservations in D4-SRV-02).
 *
 * Everything here is transport-agnostic: peers are the `Peer` interface, time
 * and randomness are injected, and the logger is structured. The `ws` adapter
 * (D0-SRV-03) and the production relay (P1) are thin transports around this.
 *
 * D4 join precedence (strict, FR-5.1/5.4/5.6):
 * 1. `session` alone — rejoin that slot (active or reserved) or `expired`.
 * 2. `token` + `pin` when the room requires a PIN — rate-limited, both checked.
 * 3. `token` alone — 128-bit room token, lowest free slot.
 * 4. `pin` alone — rate-limited manual join, lowest free slot.
 * 5. Anything else is malformed (`badToken`).
 */
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_PIN_LENGTH,
  encodeInputFwd,
  stringifyJsonMessage,
  type InputState,
  type ServerToClientMessage,
} from "@lanpad/protocol";
import type { Logger, Peer } from "./peer.js";
import { constantTimeEqual, generateToken as createToken } from "./auth/tokens.js";
import { HostRecovery } from "./room/host.js";
import { StatsCollector } from "./room/stats.js";
import {
  ROOM_MAX_LIFETIME_MS,
  type ControllerSlot,
  type CreateRoomOptions,
  type JoinRequest,
  type JoinResult,
  type Room,
  type RoomCredentials,
} from "./room.js";
import {
  clearReservationFor,
  expireReservations,
  findSession,
  isRoomExpired,
  nextFreeSlot,
  reserveSlot,
} from "./room/sessions.js";

export { SLOT_RESERVATION_MS } from "./room/sessions.js";

/** Bounded retries for a colliding room code (20 bits, so collisions are rare). */
const MAX_CODE_ATTEMPTS = 10;

/** Bounded retries for a session collision inside one room (128-bit entropy). */
const MAX_SESSION_ATTEMPTS = 16;

/** Default transport buffer ceiling before level-only input is dropped. */
const DEFAULT_MAX_BUFFERED_BYTES = 262_144;

/**
 * SR-5 limiter shapes. D0 and the existing tests use `allow`; D4-SRV-01's
 * `createJoinRateLimiter` exposes `check`/`recordFailure`/`recordSuccess` and
 * is accepted directly, so wiring it needs no adapter.
 *
 * The union is exported as `RegistryJoinRateLimiter` so the barrel can export
 * D4-SRV-01's frozen `JoinRateLimiter` interface under its own name.
 */
export interface SimpleJoinRateLimiter {
  allow(remoteAddress: string, now: number): boolean;
  recordFailure?(remoteAddress: string, now: number): void;
  recordSuccess?(remoteAddress: string, now: number): void;
}

export interface AccountableJoinRateLimiter {
  check(
    remoteAddress: string,
    now: number,
  ): { allowed: true } | { allowed: false; retryAfterMs: number };
  recordFailure(remoteAddress: string, now: number): void;
  recordSuccess(remoteAddress: string, now: number): void;
}

export type RegistryJoinRateLimiter = SimpleJoinRateLimiter | AccountableJoinRateLimiter;

function isAccountableLimiter(
  limiter: RegistryJoinRateLimiter,
): limiter is AccountableJoinRateLimiter {
  return typeof (limiter as Partial<AccountableJoinRateLimiter>).check === "function";
}

export interface RoomRegistryDeps {
  now: () => number;
  randomBytes: (n: number) => Uint8Array;
  logger: Logger;
  /** Transport buffer ceiling for level-only input dropping. */
  maxBufferedBytes?: number;
  /** Optional SR-5 limiter. Absent means allow every token/PIN attempt. */
  rateLimiter?: RegistryJoinRateLimiter;
}

function normalizeCode(code: string): string {
  return code.toUpperCase();
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;
  private readonly randomBytes: (n: number) => Uint8Array;
  private readonly logger: Logger;
  private readonly maxBufferedBytes: number;
  private readonly rateLimiter: RegistryJoinRateLimiter | undefined;
  /** One host state machine per registry (D4-SRV-03). */
  private readonly hosts: HostRecovery;
  /** One telemetry store per registry; the adapter shares it (D4-SRV-03). */
  private readonly stats: StatsCollector;
  /** Transport hooks told when a room leaves the map (adapter stops its ticker). */
  private readonly roomExpiredListeners = new Set<(room: Room) => void>();

  constructor(deps: RoomRegistryDeps) {
    this.now = deps.now;
    this.randomBytes = deps.randomBytes;
    this.logger = deps.logger;
    this.maxBufferedBytes = deps.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.rateLimiter = deps.rateLimiter;
    this.stats = new StatsCollector();
    this.hosts = new HostRecovery({
      logger: deps.logger,
      onRoomExpired: (room) => {
        // HostRecovery has already kicked the controllers and cleared them.
        if (this.rooms.get(room.code) === room) {
          this.rooms.delete(room.code);
        }
        this.notifyRoomExpired(room);
      },
    });
  }

  /** Server clock used for timestamps and heartbeats; shared with the adapter. */
  nowMs(): number {
    return this.now();
  }

  /** The registry's telemetry store, shared with the WS adapter (D4-SRV-03). */
  statsCollector(): StatsCollector {
    return this.stats;
  }

  /**
   * Registers a listener invoked after a room expires for any reason (idle,
   * maximum age or a lapsed host reservation). Used by the adapter to stop the
   * room's 1 Hz stats timer. Returns an unsubscribe function.
   */
  onRoomExpired(listener: (room: Room) => void): () => void {
    this.roomExpiredListeners.add(listener);
    return () => {
      this.roomExpiredListeners.delete(listener);
    };
  }

  /** Number of live rooms (used by `GET /healthz`). */
  roomCount(): number {
    return this.rooms.size;
  }

  /** Read-only room lookup for tests and later-stage diagnostics. */
  getRoom(code: string): Room | undefined {
    return this.rooms.get(normalizeCode(code));
  }

  /**
   * Creates a room with a unique Crockford code, a 4-digit PIN and two
   * independent 128-bit tokens (A8). Returns the credentials for
   * `POST /api/rooms`; never logs the PIN or tokens.
   */
  createRoom(options: CreateRoomOptions = {}): RoomCredentials {
    const now = this.now();
    const code = this.generateCode();
    const pin = this.generatePin();
    const roomToken = this.generateToken();
    const hostToken = this.generateToken();
    const room: Room = {
      code,
      pin,
      roomToken,
      hostToken,
      createdAt: now,
      lastActivityAt: now,
      state: "active",
      host: null,
      controllers: new Map(),
      reservations: new Map(),
      droppedInputs: 0,
      requirePinForQr: options.requirePinForQr ?? false,
    };
    this.rooms.set(code, room);
    this.logger.info("room.create", { code, rooms: this.rooms.size });
    return {
      code,
      pin,
      roomToken,
      hostToken,
      expiresAt: now + ROOM_MAX_LIFETIME_MS,
      serverTime: now,
    };
  }

  /**
   * Authenticates the host socket with the 128-bit host token (A2).
   *
   * D4-SRV-03 delegates the state machine to the registry's `HostRecovery`:
   * a first attach activates the room, a reload inside the 30 s reservation
   * resumes it and replays the slot table, and a lapsed reservation expires
   * the room. `badCode` stays here; the registry owns room lookup.
   */
  hostJoin(
    codeInput: string,
    hostToken: string,
    peer: Peer,
  ): { ok: true } | { ok: false; reason: "badCode" | "expired" | "badHostToken" } {
    const now = this.now();
    const room = this.rooms.get(normalizeCode(codeInput));
    if (!room) {
      return { ok: false, reason: "badCode" };
    }
    if (isRoomExpired(room, now)) {
      this.expireRoom(room, now);
      return { ok: false, reason: "expired" };
    }
    const result = this.hosts.hostJoin(room, hostToken, peer, now);
    if (!result.ok) {
      return result;
    }
    // A repeated hostJoin from the live host is valid host traffic (FR-5.2)
    // even though HostRecovery deliberately stays idempotent (G4).
    room.lastActivityAt = now;
    return { ok: true };
  }

  /**
   * Session-aware controller join (FR-5.1–5.6). The `session` credential never
   * combines with `token` or `pin`; a rejoin returns the same slot and its
   * original session token.
   */
  join(req: JoinRequest, peer: Peer): JoinResult {
    const now = this.now();
    const room = this.rooms.get(normalizeCode(req.code));
    if (room === undefined) {
      return { ok: false, reason: "badCode" };
    }
    if (isRoomExpired(room, now)) {
      this.expireRoom(room, now);
      return { ok: false, reason: "expired" };
    }

    const token = req.token;
    const pin = req.pin;
    const session = req.session;
    const hasToken = token !== undefined;
    const hasPin = pin !== undefined;
    const hasSession = session !== undefined;

    if (hasSession && (hasToken || hasPin)) {
      // Malformed. No credential is compared, but the rejection is counted so
      // an abusive peer cannot probe combinations for free.
      this.recordJoinFailure(peer.remoteAddress, now);
      this.logRejectedJoin(room, "badToken");
      return { ok: false, reason: "badToken" };
    }
    if (session !== undefined) {
      // A session rejoin is not a token/PIN credential attempt. It must stay
      // usable behind a shared IP that some other device has locked out.
      return this.rejoin(room, session, peer, now);
    }

    // SR-5: every token/PIN attempt is checked before any credential
    // comparison, so a locked-out IP cannot probe the room token either.
    if (!this.checkJoinAllowed(peer.remoteAddress, now)) {
      this.logRejectedJoin(room, "rateLimited");
      return { ok: false, reason: "rateLimited" };
    }
    if (!hasToken && !hasPin) {
      this.recordJoinFailure(peer.remoteAddress, now);
      this.logRejectedJoin(room, "badToken");
      return { ok: false, reason: "badToken" };
    }

    // A11: a QR token alone cannot enter a room that requires the PIN. No PIN
    // was submitted, so this is not a rate-limit failure.
    if (hasToken && room.requirePinForQr && !hasPin) {
      this.logRejectedJoin(room, "badPin");
      return { ok: false, reason: "badPin" };
    }

    // A token+PIN pair only checks the PIN when the room requires it (A11).
    const checksPin = hasPin && (!hasToken || room.requirePinForQr);

    if (token !== undefined) {
      if (!constantTimeEqual(token, room.roomToken)) {
        this.recordJoinFailure(peer.remoteAddress, now);
        this.logRejectedJoin(room, "badToken");
        return { ok: false, reason: "badToken" };
      }
      if (checksPin && pin !== undefined && !constantTimeEqual(pin, room.pin)) {
        this.recordJoinFailure(peer.remoteAddress, now);
        this.logRejectedJoin(room, "badPin");
        return { ok: false, reason: "badPin" };
      }
    } else if (pin !== undefined) {
      if (!constantTimeEqual(pin, room.pin)) {
        this.recordJoinFailure(peer.remoteAddress, now);
        this.logRejectedJoin(room, "badPin");
        return { ok: false, reason: "badPin" };
      }
    }

    const slot = nextFreeSlot(room, now);
    if (slot === null) {
      this.logRejectedJoin(room, "roomFull");
      return { ok: false, reason: "roomFull" };
    }

    const controller: ControllerSlot = {
      slot,
      session: this.generateSession(room),
      peer,
      ...(req.name === undefined ? {} : { name: req.name }),
      joinedAt: now,
      lastInputAt: now,
      lastSeenAt: now,
      reservationExpiresAt: null,
      rttMs: 0,
      jitterMs: 0,
      packetsPerSecond: 0,
      drops: 0,
    };
    room.controllers.set(slot, controller);
    room.lastActivityAt = now;
    this.recordJoinSuccess(peer.remoteAddress, now);
    this.logger.info("room.join", { code: room.code, slot, players: room.controllers.size });
    this.sendToHost(room, { t: "playerJoined", slot });
    return { ok: true, slot, session: controller.session, serverTime: now };
  }

  /**
   * Forwards one Input frame to the host as `InputFwd` (FR-7.3).
   *
   * - Unknown rooms, unassigned slots and suspended slots are dropped;
   *   controllers never receive each other's input.
   * - With no host attached the frame is dropped and counted.
   * - If the host's transport buffer is over the ceiling, level-only packets
   *   (no edges) are dropped; edge packets are never dropped (D0-SRV-03).
   */
  routeInput(codeInput: string, slot: number, state: InputState): void {
    const now = this.now();
    const room = this.rooms.get(normalizeCode(codeInput));
    if (!room) {
      return;
    }
    if (isRoomExpired(room, now)) {
      this.expireRoom(room, now);
      return;
    }
    const controller = room.controllers.get(slot);
    if (!controller || controller.peer === null) {
      return;
    }
    room.lastActivityAt = now;
    controller.lastInputAt = now;
    controller.lastSeenAt = now;
    this.stats.recordInput(room, slot, now);

    const host = room.host;
    if (host === null || !this.hosts.acceptsInput(room)) {
      // No host, host lost or host paused (FR-9.2): count the drop instead of
      // queueing input for a room that cannot consume it.
      this.stats.recordDrop(room, slot);
      room.droppedInputs += 1;
      return;
    }
    if (state.edges === 0 && (host.bufferedAmount ?? 0) > this.maxBufferedBytes) {
      this.stats.recordDrop(room, slot);
      room.droppedInputs += 1;
      this.logger.debug?.("input.drop", { code: room.code, slot });
      return;
    }
    host.send(encodeInputFwd(slot, state));
  }

  /**
   * A controller hid its page and asked for a suspension (FR-8.8). The slot is
   * held for 30 s and the host sees `playerSuspended` (FR-5.4).
   *
   * `peer` is an optional identity guard: a stale socket must not suspend the
   * slot that a newer socket has already claimed.
   */
  suspend(codeInput: string, slot: number, now: number, peer?: Peer): boolean {
    const room = this.rooms.get(normalizeCode(codeInput));
    if (room === undefined) {
      return false;
    }
    if (isRoomExpired(room, now)) {
      this.expireRoom(room, now);
      return false;
    }
    const controller = room.controllers.get(slot);
    if (controller === undefined || controller.peer === null) {
      return false;
    }
    if (peer !== undefined && controller.peer !== peer) {
      return false;
    }
    this.reserveController(room, controller, now);
    controller.lastSeenAt = now;
    // An explicit suspend is a valid controller message (FR-5.2 activity).
    room.lastActivityAt = now;
    return true;
  }

  /**
   * Socket close without an explicit `leave` (FR-7.14): reserve the slot for
   * 30 s instead of freeing it. Not a message, so the idle timer is not reset.
   *
   * Pass `peer` when the adapter has it. Without the guard, the close event of
   * a socket that was just replaced by a session rejoin would detach the new
   * peer.
   */
  detach(codeInput: string, slot: number, now: number, peer?: Peer): boolean {
    const room = this.rooms.get(normalizeCode(codeInput));
    if (room === undefined) {
      return false;
    }
    if (isRoomExpired(room, now)) {
      this.expireRoom(room, now);
      return false;
    }
    const controller = room.controllers.get(slot);
    if (controller === undefined || controller.peer === null) {
      return false;
    }
    if (peer !== undefined && controller.peer !== peer) {
      return false;
    }
    this.reserveController(room, controller, now);
    return true;
  }

  /**
   * Explicit `leave`: the slot is freed immediately and is not reserved
   * (FR-5.5). The D0 `Peer` form is kept for the current adapter; D4 callers
   * pass the injected `now`.
   */
  leave(codeInput: string, slot: number, atOrPeer: number | Peer): boolean {
    const room = this.rooms.get(normalizeCode(codeInput));
    if (!room) {
      return false;
    }
    const controller = room.controllers.get(slot);
    if (!controller) {
      return false;
    }

    let now: number;
    if (typeof atOrPeer === "number") {
      now = atOrPeer;
    } else {
      if (controller.peer !== atOrPeer) {
        return false;
      }
      now = this.now();
    }

    clearReservationFor(room, controller.session);
    room.controllers.delete(slot);
    room.lastActivityAt = now;
    this.logger.info("room.leave", { code: room.code, slot, players: room.controllers.size });
    this.sendToHost(room, { t: "playerLeft", slot });
    return true;
  }

  /**
   * Detaches the host socket. D4-SRV-03 keeps the room recoverable for 30 s
   * and broadcasts `hostStatus lost` through the registry's `HostRecovery`.
   */
  hostLeave(codeInput: string, peer: Peer): boolean {
    const room = this.rooms.get(normalizeCode(codeInput));
    if (room === undefined) {
      return false;
    }
    return this.hosts.hostLeave(room, peer, this.now());
  }

  /** FR-9.2 host pause: controllers see `hostStatus paused` (A9). */
  hostPause(codeInput: string, peer: Peer): boolean {
    const now = this.now();
    const room = this.rooms.get(normalizeCode(codeInput));
    if (room === undefined) {
      return false;
    }
    if (isRoomExpired(room, now)) {
      this.expireRoom(room, now);
      return false;
    }
    return this.hosts.hostPause(room, peer, now);
  }

  /** FR-9.2 host resume: controllers see `hostStatus active` again (A9). */
  hostResume(codeInput: string, peer: Peer): boolean {
    const now = this.now();
    const room = this.rooms.get(normalizeCode(codeInput));
    if (room === undefined) {
      return false;
    }
    if (isRoomExpired(room, now)) {
      this.expireRoom(room, now);
      return false;
    }
    return this.hosts.hostResume(room, peer, now);
  }

  /**
   * Records activity for a valid host/controller message that does not go
   * through `routeInput` (for example host pause/resume in D4-SRV-03). Keeps
   * an active room from idling out (FR-5.2).
   */
  noteActivity(codeInput: string, now: number = this.now()): boolean {
    const room = this.rooms.get(normalizeCode(codeInput));
    if (room === undefined) {
      return false;
    }
    if (isRoomExpired(room, now)) {
      this.expireRoom(room, now);
      return false;
    }
    room.lastActivityAt = now;
    return true;
  }

  /**
   * Expires live reservations (FR-5.5) and rooms past the 10 min idle or 4 h
   * maximum limit (FR-5.2), and gives `HostRecovery` the first look at every
   * room so a lapsed 30 s host reservation kicks its controllers (FR-7.16).
   * The adapter calls this once per second; `now` is explicit so tests and P5
   * load simulations drive time directly.
   */
  sweep(now: number = this.now()): void {
    for (const room of [...this.rooms.values()]) {
      // A host-lost room that hits its deadline is removed by the expiry
      // listener, so it must not also be treated as an idle room below.
      if (this.hosts.sweep(room, now)) {
        continue;
      }
      this.expireReservationsFor(room, now);
      if (isRoomExpired(room, now)) {
        this.expireRoom(room, now);
      }
    }
  }

  private rejoin(room: Room, session: string, peer: Peer, now: number): JoinResult {
    const found = findSession(room, session, now);
    if (found.status === "missing") {
      this.logRejectedJoin(room, "expired");
      return { ok: false, reason: "expired" };
    }

    if (found.status === "stale") {
      // The reservation lapsed between sweeps: remove it lazily so it cannot
      // block the slot, and tell the host the same way the sweeper would.
      if (found.reservation !== null) {
        clearReservationFor(room, session);
      }
      room.controllers.delete(found.controller.slot);
      found.controller.reservationExpiresAt = null;
      this.logger.info("room.leave", {
        code: room.code,
        slot: found.controller.slot,
        players: room.controllers.size,
        result: "reservationExpired",
      });
      this.sendToHost(room, { t: "playerLeft", slot: found.controller.slot });
      this.logRejectedJoin(room, "expired");
      return { ok: false, reason: "expired" };
    }

    const controller = found.controller;
    if (found.status === "reserved") {
      clearReservationFor(room, session);
      controller.reservationExpiresAt = null;
      this.sendToHost(room, { t: "playerResumed", slot: controller.slot });
      this.logger.info("room.resume", { code: room.code, slot: controller.slot });
    } else {
      // Same session on a live slot: the newest socket wins. Closing the old
      // transport is safe because the adapter's close handler passes its peer.
      const oldPeer = controller.peer;
      if (oldPeer !== null && oldPeer !== peer) {
        try {
          oldPeer.close(1000, "session resumed");
        } catch {
          // A broken transport is already gone; nothing else to detach.
        }
      }
    }

    controller.peer = peer;
    controller.lastSeenAt = now;
    room.lastActivityAt = now;
    // A rejoined controller is a successful join and clears the IP's SR-5
    // failure window like any other successful credential join.
    this.recordJoinSuccess(peer.remoteAddress, now);
    this.logger.info("room.join", {
      code: room.code,
      slot: controller.slot,
      players: room.controllers.size,
      result: "resumed",
    });
    return {
      ok: true,
      slot: controller.slot,
      session: controller.session,
      serverTime: now,
    };
  }

  private reserveController(room: Room, controller: ControllerSlot, now: number): void {
    reserveSlot(room, controller, now);
    this.logger.info("room.suspend", {
      code: room.code,
      slot: controller.slot,
      players: room.controllers.size,
    });
    this.sendToHost(room, { t: "playerSuspended", slot: controller.slot });
  }

  private expireReservationsFor(room: Room, now: number): void {
    for (const { controller } of expireReservations(room, now)) {
      this.logger.info("room.leave", {
        code: room.code,
        slot: controller.slot,
        players: room.controllers.size,
        result: "reservationExpired",
      });
      this.sendToHost(room, { t: "playerLeft", slot: controller.slot });
    }
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const bytes = this.randomBytes(ROOM_CODE_LENGTH);
      let code = "";
      for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
        const byte = bytes[index] ?? 0;
        code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length] ?? "0";
      }
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new Error(`Unable to allocate a unique room code after ${MAX_CODE_ATTEMPTS} attempts`);
  }

  private generatePin(): string {
    const bytes = this.randomBytes(ROOM_PIN_LENGTH);
    let pin = "";
    for (let index = 0; index < ROOM_PIN_LENGTH; index += 1) {
      pin += String((bytes[index] ?? 0) % 10);
    }
    return pin;
  }

  private generateToken(): string {
    return createToken(this.randomBytes);
  }

  /**
   * Issues a fresh 128-bit session token (SR-1). It is never derived from the
   * room token and must not collide with another slot's session.
   */
  private generateSession(room: Room): string {
    for (let attempt = 0; attempt < MAX_SESSION_ATTEMPTS; attempt += 1) {
      const token = this.generateToken();
      if (constantTimeEqual(token, room.roomToken)) {
        continue;
      }
      if (constantTimeEqual(token, room.hostToken)) {
        continue;
      }
      let taken = false;
      for (const controller of room.controllers.values()) {
        if (constantTimeEqual(controller.session, token)) {
          taken = true;
          break;
        }
      }
      if (!taken) {
        return token;
      }
    }
    throw new Error(
      `Unable to allocate a unique session token after ${MAX_SESSION_ATTEMPTS} attempts`,
    );
  }

  private expireRoom(room: Room, now: number): void {
    room.state = "expired";
    if (this.rooms.get(room.code) === room) {
      this.rooms.delete(room.code);
    }
    this.logger.info("room.expire", {
      code: room.code,
      ageMs: Math.max(0, now - room.createdAt),
    });

    const peers: Peer[] = [];
    if (room.host !== null) {
      peers.push(room.host);
    }
    for (const controller of room.controllers.values()) {
      if (controller.peer !== null) {
        peers.push(controller.peer);
      }
    }
    room.host = null;
    room.controllers.clear();
    room.reservations.clear();

    // FR-5.2: every peer gets a kick before the socket closes.
    const kick = stringifyJsonMessage({ t: "kick", reason: "expired" });
    for (const peer of peers) {
      try {
        peer.send(kick);
      } catch {
        // A broken transport is already gone; still close it below.
      }
    }
    for (const peer of peers) {
      try {
        peer.close(1000, "room expired");
      } catch {
        // Same as above.
      }
    }
    this.notifyRoomExpired(room);
  }

  /**
   * Tells transport hooks that the room left the registry. Listeners are
   * diagnostics only: a failing listener must not keep a room alive or throw
   * from a timer-driven sweep.
   */
  private notifyRoomExpired(room: Room): void {
    for (const listener of [...this.roomExpiredListeners]) {
      try {
        listener(room);
      } catch {
        this.logger.debug?.("room.expireListenerFailed", { code: room.code });
      }
    }
  }

  private checkJoinAllowed(remoteAddress: string, now: number): boolean {
    const limiter = this.rateLimiter;
    if (limiter === undefined) {
      return true;
    }
    if (isAccountableLimiter(limiter)) {
      return limiter.check(remoteAddress, now).allowed;
    }
    return limiter.allow(remoteAddress, now);
  }

  private recordJoinFailure(remoteAddress: string, now: number): void {
    this.rateLimiter?.recordFailure?.(remoteAddress, now);
  }

  private recordJoinSuccess(remoteAddress: string, now: number): void {
    this.rateLimiter?.recordSuccess?.(remoteAddress, now);
  }

  private logRejectedJoin(room: Room, reason: string): void {
    this.logger.info("room.join", { code: room.code, result: reason });
  }

  private sendToHost(room: Room, message: ServerToClientMessage): void {
    const host = room.host;
    if (host === null) {
      return;
    }
    try {
      host.send(stringifyJsonMessage(message));
    } catch {
      this.logger.debug?.("peer.sendFailed", { code: room.code });
    }
  }
}

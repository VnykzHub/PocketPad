/**
 * Controller join flow (D4-CTRL-01, FR-5.1, FR-5.4–5.6, SR-2, SR-4).
 *
 * One deterministic state machine owns every way into a room:
 *
 *   QR token (`join {token}`) → manual code + PIN (`join {pin}`)
 *   and, first of all, a stored session (`join {session}`).
 *
 * Precedence is fixed and must stay fixed (FR-5.4): a live session is always
 * tried before the shared room token, and the room token is never sent for a
 * rejoin. The QR fragment is cleared with `history.replaceState` before the
 * transport is touched, so the token cannot leak into a request URL, referrer
 * or log (FR-5.1, SR-2).
 *
 * The module has no DOM or socket dependency. `history`, `transport` and the
 * session store are injected, which also makes the whole flow testable with a
 * fake clock. It never logs and never places a token in the public state.
 */
import { PROTOCOL_VERSION } from "@lanpad/protocol";
import type { ClientToServerMessage, JoinErrorReason, JsonControlMessage } from "@lanpad/protocol";
import {
  clearUrlFragment,
  normalizeRoomCode,
  parseControllerPath,
  parseFragmentToken,
} from "../route.js";
import type { ReplaceStateHistory } from "../route.js";
import { validateManualJoin } from "./ManualJoin.js";
import type { ManualJoinErrors } from "./ManualJoin.js";
import type { SessionStore, SessionWrite } from "./sessionStore.js";

/** The only client→server message this flow produces. */
export type JoinRequest = Extract<ClientToServerMessage, { t: "join" }>;

/** Which credential the current attempt used. */
export type JoinCredential = "session" | "token" | "pin";

/** Parsed `/c/<code>#<roomToken>` input. The token never leaves this object. */
export interface ParsedJoinInput {
  code: string | null;
  roomToken: string | null;
}

/** Structural history surface; `window.history` satisfies it. */
export type JoinHistory = ReplaceStateHistory;

/** The socket adapter; integration maps this to the controller client. */
export interface JoinTransport {
  send(message: JoinRequest): void;
}

export interface JoinLocation {
  pathname: string;
  hash: string;
  /** `location.search`, preserved when the fragment is stripped. */
  search?: string;
}

export interface JoinFlowDeps {
  store: SessionStore;
  transport: JoinTransport;
  history: JoinHistory;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Lockout shown after `rateLimited`; the protocol carries no duration. */
  rateLimitRetryMs?: number;
}

/**
 * Human-readable text for every join refusal the controller can act on.
 * Tokens, PINs and server internals never appear here.
 */
export const JOIN_FLOW_MESSAGES = {
  roomFull: "Room is full (8/8). Try again when a player leaves.",
  badToken: "That invite link is not valid. Enter the room code and PIN.",
  badPin: "Wrong PIN. Check the PIN on the TV and try again.",
  expired: "That room or session has expired. Ask the host for a new code.",
  rateLimited: "Too many attempts. Wait a moment and try again.",
  badCode: "No room with that code. Check the code on the TV.",
  badHostToken: "This join is not valid for a controller.",
  badVersion: "This controller is out of date. Reload the page.",
} as const satisfies Record<JoinErrorReason, string>;

/** "Too many attempts. Try again in 60 seconds." */
export function rateLimitedMessage(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return `Too many attempts. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`;
}

export interface JoinFlowIdleState {
  status: "idle";
}

export interface JoinFlowJoiningState {
  status: "joining";
  code: string;
  via: JoinCredential;
}

export interface JoinFlowJoinedState {
  status: "joined";
  code: string;
  slot: number;
}

export interface JoinFlowManualState {
  status: "manual";
  code: string | null;
  errors: ManualJoinErrors;
  notice: string | null;
}

export interface JoinFlowErrorState {
  status: "error";
  kind: "roomFull" | "rateLimited";
  code: string;
  message: string;
  /** Remaining lockout at the time of the transition; null for `roomFull`. */
  retryAfterMs: number | null;
}

export type JoinFlowState =
  | JoinFlowIdleState
  | JoinFlowJoiningState
  | JoinFlowJoinedState
  | JoinFlowManualState
  | JoinFlowErrorState;

/** Reads `/c/<CODE>` and the URL fragment. Missing values become null (FR-5.6). */
export function parseJoinInput(pathname: string, hash: string | null | undefined): ParsedJoinInput {
  const route = parseControllerPath(pathname);
  return { code: route.code, roomToken: parseFragmentToken(hash) };
}

const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;
const CONNECT_FAILED_NOTICE =
  "Could not connect to the game server. Check the connection and try again.";
const KICKED_NOTICE = "The host ended this controller's session.";

/**
 * The join state machine.
 *
 * Typical page bootstrap:
 *   `flow.start({pathname, hash, search})`
 * then feed every parsed server message to `flow.handleMessage`.
 */
export class JoinFlow {
  private readonly store: SessionStore;
  private readonly transport: JoinTransport;
  private readonly history: JoinHistory;
  private readonly now: () => number;
  private readonly rateLimitRetryMs: number;

  private current: JoinFlowState = { status: "idle" };
  private code: string | null = null;
  /** Kept only in memory, never exposed in `state`, never logged (SR-2). */
  private roomToken: string | null = null;
  private lastAttempt: JoinCredential | null = null;
  private lockedUntil = 0;

  constructor(deps: JoinFlowDeps) {
    this.store = deps.store;
    this.transport = deps.transport;
    this.history = deps.history;
    this.now = deps.now ?? (() => Date.now());
    this.rateLimitRetryMs = deps.rateLimitRetryMs ?? DEFAULT_RATE_LIMIT_RETRY_MS;
  }

  get state(): JoinFlowState {
    return this.current;
  }

  /** Remaining lockout in ms; 0 when manual submit / retry is allowed. */
  get retryAfterMs(): number {
    return Math.max(0, this.lockedUntil - this.now());
  }

  /**
   * Bootstrap. Parses the route, clears the fragment *before* any network
   * call, then attempts session → room token → manual in that strict order.
   */
  start(location: JoinLocation): JoinFlowState {
    const parsed = parseJoinInput(location.pathname, location.hash);
    const hadFragment = typeof location.hash === "string" && location.hash.length > 0;

    this.code = parsed.code;
    this.roomToken = parsed.roomToken;
    this.lastAttempt = null;

    if (hadFragment) {
      clearUrlFragment(this.history, location.pathname, location.search ?? "");
    }

    if (parsed.code === null) {
      this.setManual(null, {}, null);
      return this.current;
    }
    return this.attempt(parsed.code);
  }

  /** Handles every server message; unrelated messages are ignored. */
  handleMessage(message: JsonControlMessage): JoinFlowState {
    switch (message.t) {
      case "joined":
        return this.handleJoined(message.slot, message.session);
      case "joinError":
        return this.handleJoinError(message.reason);
      case "kick":
        return this.handleKick(message.reason);
      default:
        return this.current;
    }
  }

  /**
   * Validates a manual code + PIN locally and sends `join {pin}` only.
   * The server stays authoritative; a wrong PIN comes back as `joinError`.
   */
  submitManual(input: { code: string; pin: string }): JoinFlowState {
    const remaining = this.retryAfterMs;
    if (remaining > 0) {
      const code = normalizeRoomCode(input.code) ?? this.code ?? "";
      this.setRateLimited(code, remaining);
      return this.current;
    }

    const result = validateManualJoin(input);
    if (!result.ok) {
      this.setManual(result.code ?? this.code, result.errors, null);
      return this.current;
    }

    // A manually typed code may differ from the QR route; never carry a room
    // token across rooms.
    if (this.code !== null && result.code !== this.code) {
      this.roomToken = null;
    }
    this.code = result.code;
    return this.sendJoin(
      { t: "join", v: PROTOCOL_VERSION, code: result.code, pin: result.pin },
      "pin",
      result.code,
    );
  }

  /** Retries after `roomFull` or a finished lockout, re-running precedence. */
  retry(): JoinFlowState {
    const code = this.code;
    if (code === null) {
      this.setManual(null, {}, null);
      return this.current;
    }
    return this.attempt(code);
  }

  /**
   * Explicit leave: drop the room's stored session. The caller is responsible
   * for sending `leave` on the socket (D4-CTRL-02 owns the live connection).
   */
  leave(): void {
    if (this.code !== null) {
      this.store.clear(this.code);
    }
    this.roomToken = null;
    this.lastAttempt = null;
    this.current = { status: "idle" };
  }

  private attempt(code: string): JoinFlowState {
    const remaining = this.retryAfterMs;
    if (remaining > 0) {
      this.setRateLimited(code, remaining);
      return this.current;
    }

    const stored = this.store.get(code);
    if (stored !== null) {
      if (this.roomToken === null && stored.roomToken !== undefined) {
        this.roomToken = stored.roomToken;
      }
      return this.sendJoin(
        { t: "join", v: PROTOCOL_VERSION, code, session: stored.session },
        "session",
        code,
      );
    }

    if (this.roomToken !== null) {
      return this.sendJoin(
        { t: "join", v: PROTOCOL_VERSION, code, token: this.roomToken },
        "token",
        code,
      );
    }

    this.setManual(code, {}, null);
    return this.current;
  }

  private sendJoin(message: JoinRequest, via: JoinCredential, code: string): JoinFlowState {
    this.lastAttempt = via;
    this.current = { status: "joining", code, via };
    try {
      this.transport.send(message);
    } catch {
      this.setManual(code, {}, CONNECT_FAILED_NOTICE);
    }
    return this.current;
  }

  private handleJoined(slot: number, session: string): JoinFlowState {
    const code = this.code;
    if (code === null) {
      return this.current;
    }
    const record: SessionWrite = { session, slot };
    if (this.roomToken !== null) {
      record.roomToken = this.roomToken;
    }
    this.store.set(code, record);
    this.lastAttempt = null;
    this.current = { status: "joined", code, slot };
    return this.current;
  }

  private handleJoinError(reason: JoinErrorReason): JoinFlowState {
    const code = this.code;
    if (code === null || this.current.status === "joined") {
      return this.current;
    }

    switch (reason) {
      case "roomFull":
        this.current = {
          status: "error",
          kind: "roomFull",
          code,
          message: JOIN_FLOW_MESSAGES.roomFull,
          retryAfterMs: null,
        };
        return this.current;

      case "rateLimited": {
        this.lockedUntil = this.now() + this.rateLimitRetryMs;
        this.setRateLimited(code, this.rateLimitRetryMs);
        return this.current;
      }

      case "expired":
        if (this.lastAttempt === "session") {
          this.store.clear(code);
          // FR-5.5: with a room token, join again as a new player; otherwise
          // send the user to the manual form rather than looping.
          if (this.roomToken !== null) {
            return this.sendJoin(
              { t: "join", v: PROTOCOL_VERSION, code, token: this.roomToken },
              "token",
              code,
            );
          }
        }
        this.setManual(code, {}, JOIN_FLOW_MESSAGES.expired);
        return this.current;

      case "badToken":
        // Do not loop on a token the server rejected.
        if (this.lastAttempt === "session") {
          this.store.clear(code);
        }
        this.roomToken = null;
        this.setManual(code, {}, JOIN_FLOW_MESSAGES.badToken);
        return this.current;

      case "badPin":
        this.setManual(code, {}, JOIN_FLOW_MESSAGES.badPin);
        return this.current;

      case "badCode":
        this.setManual(code, {}, JOIN_FLOW_MESSAGES.badCode);
        return this.current;

      case "badVersion":
      case "badHostToken":
        this.setManual(code, {}, JOIN_FLOW_MESSAGES[reason]);
        return this.current;
    }
    return this.current;
  }

  private handleKick(reason: string): JoinFlowState {
    const code = this.code;
    if (code !== null) {
      // The reservation is gone; a fresh join needs a new session (FR-5.4).
      this.store.clear(code);
    }
    this.lastAttempt = null;
    this.setManual(
      code,
      {},
      reason === "expired" ? JOIN_FLOW_MESSAGES.expired : KICKED_NOTICE,
    );
    return this.current;
  }

  private setManual(
    code: string | null,
    errors: ManualJoinErrors,
    notice: string | null,
  ): void {
    this.current = { status: "manual", code, errors, notice };
  }

  private setRateLimited(code: string, retryAfterMs: number): void {
    this.current = {
      status: "error",
      kind: "rateLimited",
      code,
      message: rateLimitedMessage(retryAfterMs),
      retryAfterMs,
    };
  }
}

/** Convenience factory for the page shell and tests. */
export function createJoinFlow(deps: JoinFlowDeps): JoinFlow {
  return new JoinFlow(deps);
}

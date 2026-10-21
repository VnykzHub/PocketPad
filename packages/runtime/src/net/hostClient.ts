/**
 * Host network client (D0-RT-01).
 *
 * Owns the single WebSocket on the host page. Games never see it (FR-7.17);
 * the shell feeds decoded input to the debug table until D3 installs the
 * runtime behind `#game-root`.
 *
 * Wire rules come from `@lanpad/protocol`; the origin comes from
 * `@lanpad/sdk` config helpers. There is no hard-coded origin here (FR-4.3)
 * and no socket literal outside the SDK's scheme conversion (FR-4.6).
 *
 * Tokens:
 * - `roomToken` and `hostToken` are read from the `POST /api/rooms` response.
 * - They are never logged and never serialized back out except in the
 *   `hostJoin` control message, which is the only place the host token may
 *   travel (A2). The shell stores the host token in `sessionStorage` and never
 *   in a URL or the DOM (FR-5.1).
 */
import {
  MSG,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_PIN_LENGTH,
  TOKEN_LENGTH,
  decodeInputFwd,
  frameType,
  parseJsonMessage,
  stringifyJsonMessage,
  type InputState,
  type JsonControlMessage,
  type ServerToClientMessage,
} from "@lanpad/protocol";
import { resolveServerOrigin, toWebSocketUrl } from "@lanpad/sdk";

/** The documented `POST /api/rooms` response body (A8). */
export interface RoomCredentials {
  code: string;
  pin: string;
  roomToken: string;
  hostToken: string;
  /** Epoch milliseconds at which the room expires (creation + 4 h). */
  expiresAt: number;
  /** Server clock in milliseconds at creation time. */
  serverTime: number;
}

/** Minimal response surface so tests can inject a fetch double. */
export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { readonly method: "POST"; readonly cache: "no-store" },
) => Promise<HttpResponseLike>;

/** Close information exposed to the shell without leaking DOM types. */
export interface WebSocketCloseInfo {
  readonly code?: number;
  readonly reason?: string;
  readonly wasClean?: boolean;
}

/** Minimal WebSocket surface; the browser object is adapted in one place. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: WebSocketCloseInfo) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

export interface HostClientDeps {
  fetch: FetchLike;
  createWebSocket: (url: string) => WebSocketLike;
}

/** Phases the shell uses to decide whether Enter may start a room (AR-4). */
export type HostPhase = "idle" | "creating" | "ready" | "failed";

/**
 * True when Enter should start a room. Exported as a pure function so the
 * shell's keyboard policy is testable without a DOM.
 */
export function shouldCreateRoomOnKey(key: string, phase: HostPhase): boolean {
  return key === "Enter" && (phase === "idle" || phase === "failed");
}

/** sessionStorage key for the host token; scoped per room code. */
export function hostTokenStorageKey(code: string): string {
  return `lanpad.host.${code}`;
}

/**
 * Remembers the host token for this tab. The caller passes `sessionStorage`;
 * tests pass a structural double. The token never enters a URL or the DOM.
 */
export function storeHostToken(
  storage: Pick<Storage, "setItem">,
  code: string,
  hostToken: string,
): void {
  storage.setItem(hostTokenStorageKey(code), hostToken);
}

const BASE64URL_TOKEN = /^[A-Za-z0-9_-]+$/;

function invalidRoomResponse(problem: string): never {
  // Never interpolate a field value: tokens must not reach error messages or
  // logs even when the server response is malformed (SR-9).
  throw new Error(`Invalid room creation response: ${problem}.`);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidRoomResponse("expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    invalidRoomResponse(`"${key}" must be a string`);
  }
  return value;
}

function requireTokenField(record: Record<string, unknown>, key: string): string {
  const value = requireStringField(record, key);
  if (value.length !== TOKEN_LENGTH || !BASE64URL_TOKEN.test(value)) {
    invalidRoomResponse(`"${key}" must be a ${TOKEN_LENGTH}-character base64url token`);
  }
  return value;
}

function requireNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidRoomResponse(`"${key}" must be a finite number`);
  }
  return value;
}

function isRoomCode(value: string): boolean {
  if (value.length !== ROOM_CODE_LENGTH) {
    return false;
  }
  for (const character of value) {
    if (!ROOM_CODE_ALPHABET.includes(character)) {
      return false;
    }
  }
  return true;
}

/**
 * Parses the frozen `POST /api/rooms` response (A8):
 * `{ code, pin, roomToken, hostToken, expiresAt, serverTime }`.
 *
 * Unknown extra fields are ignored; the returned object contains only the
 * documented fields. Error messages never echo field values (SR-9).
 */
export function parseRoomCredentials(value: unknown): RoomCredentials {
  const record = requireRecord(value);

  const code = requireStringField(record, "code");
  if (!isRoomCode(code)) {
    invalidRoomResponse(
      `"code" must be ${ROOM_CODE_LENGTH} characters from the room code alphabet`,
    );
  }

  const pin = requireStringField(record, "pin");
  if (pin.length !== ROOM_PIN_LENGTH || !/^\d+$/.test(pin)) {
    invalidRoomResponse(`"pin" must be ${ROOM_PIN_LENGTH} digits`);
  }

  return {
    code,
    pin,
    roomToken: requireTokenField(record, "roomToken"),
    hostToken: requireTokenField(record, "hostToken"),
    expiresAt: requireNumberField(record, "expiresAt"),
    serverTime: requireNumberField(record, "serverTime"),
  };
}

const SERVER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "joined",
  "hostJoined",
  "joinError",
  "playerJoined",
  "playerLeft",
  "playerSuspended",
  "playerResumed",
  "setLayout",
  "panel",
  "kick",
  "stats",
]);

function isServerToClientMessage(
  message: JsonControlMessage,
): message is ServerToClientMessage {
  return SERVER_MESSAGE_TYPES.has(message.t);
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function defaultCreateWebSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

/**
 * Host-side socket owner. One instance per host page.
 *
 * Reconnect/backoff is deliberately absent in D0; `onClose` is the hook D4
 * uses to restore the room with the stored host token.
 */
export class HostClient {
  private readonly fetchImpl: FetchLike;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private socket: WebSocketLike | null = null;
  private origin: string | null = null;

  private readonly messageListeners = new Set<(message: ServerToClientMessage) => void>();
  private readonly inputListeners = new Set<(slot: number, state: InputState) => void>();
  private readonly openListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(info: WebSocketCloseInfo) => void>();
  private readonly errorListeners = new Set<() => void>();

  constructor(deps: Partial<HostClientDeps> = {}) {
    this.fetchImpl = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.createWebSocket = deps.createWebSocket ?? defaultCreateWebSocket;
  }

  /**
   * Creates a room via `POST /api/rooms` relative to the resolved origin and
   * returns the parsed credentials. The origin is remembered for `connect()`.
   */
  async createRoom(origin?: string): Promise<RoomCredentials> {
    const resolved = resolveServerOrigin(origin);
    this.origin = resolved;

    const response = await this.fetchImpl(`${resolved}/api/rooms`, {
      method: "POST",
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Room creation failed with HTTP status ${response.status}.`);
    }
    return parseRoomCredentials(await response.json());
  }

  /**
   * Opens the same-origin WebSocket at `/ws`. The previous socket, if any, is
   * disposed without emitting close events so a retry cannot clobber the new
   * connection state.
   */
  connect(origin?: string): void {
    const resolved = resolveServerOrigin(origin ?? this.origin ?? undefined);
    this.origin = resolved;
    this.disposeSocket();

    const socket = this.createWebSocket(toWebSocketUrl(resolved));
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      for (const listener of this.openListeners) listener();
    };
    socket.onclose = (info) => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const listener of this.closeListeners) listener(info);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      for (const listener of this.errorListeners) listener();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleFrame(event.data);
    };
  }

  /**
   * Sends the host authentication message (A2). Call it from `onOpen`; a
   * browser WebSocket rejects `send` while still connecting.
   */
  sendHostJoin(code: string, hostToken: string): void {
    const socket = this.socket;
    if (socket === null) {
      throw new Error("hostJoin requires an open WebSocket; call connect() first.");
    }
    socket.send(
      stringifyJsonMessage({ t: "hostJoin", v: PROTOCOL_VERSION, code, hostToken }),
    );
  }

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => {
      this.openListeners.delete(listener);
    };
  }

  onClose(listener: (info: WebSocketCloseInfo) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  onError(listener: () => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  /** JSON server→host messages only, already validated by the protocol layer. */
  onMessage(listener: (message: ServerToClientMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /** Decoded `InputFwd` frames: slot plus the wire input state. */
  onInput(listener: (slot: number, state: InputState) => void): () => void {
    this.inputListeners.add(listener);
    return () => {
      this.inputListeners.delete(listener);
    };
  }

  /** Closes the socket without emitting close/error listeners. */
  close(): void {
    this.disposeSocket();
  }

  private disposeSocket(): void {
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    this.socket = null;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.close(1000, "host closing");
  }

  private handleFrame(data: unknown): void {
    if (typeof data === "string") {
      let message: JsonControlMessage;
      try {
        message = parseJsonMessage(data);
      } catch {
        // Malformed control traffic is dropped without echoing the payload.
        return;
      }
      if (!isServerToClientMessage(message)) {
        return;
      }
      for (const listener of this.messageListeners) listener(message);
      return;
    }

    const bytes = toBytes(data);
    if (bytes === null || frameType(bytes) !== MSG.InputFwd) {
      return;
    }

    let decoded: { slot: number; state: InputState };
    try {
      decoded = decodeInputFwd(bytes);
    } catch {
      return;
    }
    for (const listener of this.inputListeners) listener(decoded.slot, decoded.state);
  }
}

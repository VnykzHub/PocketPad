/**
 * Host network client (D0-RT-01, extended by D3-RT-03).
 *
 * Owns the single WebSocket on the host page. Games never see it (FR-7.17);
 * the shell feeds decoded input to the debug table and, from D3-RT-04, to the
 * input mapper. No game-facing object is returned from this module.
 *
 * D3 surface:
 * - `hostJoin(code, hostToken)` sends the A2 handshake and resolves when the
 *   matching `hostJoined` arrives, recording
 *   `serverTimeOffset = serverTime - clock.now()` for `serverNow()` (FR-7.10).
 * - Binary `InputFwd` frames decode through `decodeInputFwdInto` into one
 *   reusable `InputState` (PR-9.3) and dispatch `(slot, state)` to listeners.
 * - `player*` and `stats` messages dispatch to typed callbacks; unknown or
 *   wrong-direction messages are dropped and counted.
 * - `send()` accepts `HostToServerMessage` only, so controller messages can
 *   never leave the host socket.
 *
 * Wire rules come from `@lanpad/protocol`; the origin comes from
 * `@lanpad/sdk` config helpers. There is no hard-coded origin here (FR-4.3)
 * and no socket literal outside the SDK's scheme conversion (FR-4.6).
 *
 * Tokens:
 * - `roomToken` and `hostToken` are read from the `POST /api/rooms` response.
 * - They are never logged and never serialized back out except in the
 *   `hostJoin` control message, which is the only place the host token may
 *   travel (A2). `createRoom` stores the host token in per-tab storage keyed by
 *   code; it never enters a URL or the DOM (FR-5.1).
 *
 * Reconnect: D3 intentionally has no backoff and never transitions to
 * `reconnecting` or `hostLost`. The state union already carries those values
 * and the open/close/error hooks stay additive so D4-HOST-02 can wrap this
 * client without changing its shape (FR-7.16 groundwork).
 */
import {
  MAX_CONTROLLERS,
  MSG,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_PIN_LENGTH,
  TOKEN_LENGTH,
  decodeInputFwdInto,
  frameType,
  isHostToServerMessage,
  parseJsonMessage,
  stringifyJsonMessage,
  type HostToServerMessage,
  type InputState,
  type JsonControlMessage,
  type ServerToClientMessage,
  type SlotStats,
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
  /** Monotonic host clock in milliseconds; injected so tests are deterministic. */
  now: () => number;
  /** Per-tab token storage, or null when the host has no storage (tests, Node). */
  storage: Pick<Storage, "setItem"> | null;
}

/**
 * Connection phases. D3 only produces `idle`, `connecting`, `connected` and
 * `closed`; D4 adds `reconnecting` and `hostLost` without changing the union.
 */
export type HostConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "hostLost"
  | "closed";

/** Player lifecycle events, mapped from the `player*` wire messages. */
export type HostPlayerEvent = "joined" | "left" | "suspended" | "resumed";

/** Result of a successful A2 host join. */
export interface HostJoinResult {
  /** Server clock in milliseconds at host-join time. */
  serverTime: number;
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
  "hostStatus",
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

function defaultNow(): number {
  return performance.now();
}

function defaultStorage(): Pick<Storage, "setItem"> | null {
  try {
    const storage = (globalThis as { sessionStorage?: Pick<Storage, "setItem"> })
      .sessionStorage;
    return storage ?? null;
  } catch {
    // Accessing sessionStorage can throw when storage is blocked.
    return null;
  }
}

/** One reusable packet object; listeners must apply it synchronously. */
function emptyInputState(): InputState {
  return {
    tick: 0,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gx: 0,
    gy: 0,
    gz: 0,
    lt: 0,
    rt: 0,
    flags: 0,
  };
}

function messageTypeOf(message: unknown): string {
  if (typeof message === "object" && message !== null && "t" in message) {
    return String((message as { t: unknown }).t);
  }
  return "unknown";
}

interface PendingOpen {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface PendingHostJoin {
  readonly code: string;
  readonly resolve: (result: HostJoinResult) => void;
  readonly reject: (error: Error) => void;
}

/** Decode-time percentile window for the debug overlay; fixed memory. */
const DECODE_WINDOW = 120;

/**
 * Host-side socket owner. One instance per host page.
 *
 * `InputFwd` listeners receive the same `InputState` object for every packet
 * (allocation-free, PR-9.3). Apply it immediately — the input mapper does —
 * and copy any field you need to keep beyond the callback.
 */
export class HostClient {
  private readonly fetchImpl: FetchLike;
  private readonly createWebSocket: (url: string) => WebSocketLike;
  private readonly clock: () => number;
  private readonly storage: Pick<Storage, "setItem"> | null;
  private socket: WebSocketLike | null = null;
  private origin: string | null = null;
  private connectionState: HostConnectionState = "idle";
  private serverTimeOffsetMs: number | null = null;
  private lastCloseInfo: WebSocketCloseInfo | null = null;

  private pendingOpen: PendingOpen | null = null;
  private pendingHostJoin: PendingHostJoin | null = null;

  private readonly messageListeners = new Set<(message: ServerToClientMessage) => void>();
  private readonly inputListeners = new Set<(slot: number, state: InputState) => void>();
  private readonly playerListeners = new Set<(event: HostPlayerEvent, slot: number) => void>();
  private readonly statsListeners = new Set<(slots: SlotStats[]) => void>();
  private readonly openListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(info: WebSocketCloseInfo) => void>();
  private readonly errorListeners = new Set<() => void>();

  /** Reused decode target: no per-packet allocation on the host hot path. */
  private readonly inputState: InputState = emptyInputState();
  private packetsReceived = 0;
  private malformedInputFrames = 0;
  private droppedMessages = 0;
  private readonly decodeDurations = new Float64Array(DECODE_WINDOW);
  private readonly decodeSortScratch = new Float64Array(DECODE_WINDOW);
  private decodeHead = 0;
  private decodeCount = 0;
  /** Arrival time per slot; -1 means no packet yet. Index 0 is unused. */
  private readonly lastPacketAtMs = new Float64Array(MAX_CONTROLLERS + 1).fill(-1);

  constructor(deps: Partial<HostClientDeps> = {}) {
    this.fetchImpl = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.createWebSocket = deps.createWebSocket ?? defaultCreateWebSocket;
    this.clock = deps.now ?? defaultNow;
    this.storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  }

  /** Current connection phase; see `HostConnectionState`. */
  get state(): HostConnectionState {
    return this.connectionState;
  }

  /** Offset added to the host clock to estimate server time, or null before hostJoined. */
  get serverTimeOffset(): number | null {
    return this.serverTimeOffsetMs;
  }

  /** Close information from the last unexpected socket close; D4 uses it. */
  get lastClose(): WebSocketCloseInfo | null {
    return this.lastCloseInfo;
  }

  /** InputFwd frames decoded successfully. */
  get inputPacketCount(): number {
    return this.packetsReceived;
  }

  /** InputFwd frames rejected by the protocol decoder. */
  get malformedInputCount(): number {
    return this.malformedInputFrames;
  }

  /** JSON frames dropped as malformed, unknown or wrong-direction. */
  get droppedMessageCount(): number {
    return this.droppedMessages;
  }

  /** p95 decode time over the last 120 InputFwd frames, in milliseconds. */
  get decodeP95Ms(): number {
    const count = this.decodeCount;
    if (count === 0) {
      return 0;
    }
    const sorted = this.decodeSortScratch;
    for (let index = 0; index < count; index += 1) {
      sorted[index] = this.decodeDurations[index] ?? 0;
    }
    // Insertion sort: at most 120 values and only reached from the 4 Hz overlay.
    for (let index = 1; index < count; index += 1) {
      const value = sorted[index] ?? 0;
      let position = index - 1;
      while (position >= 0 && (sorted[position] ?? 0) > value) {
        sorted[position + 1] = sorted[position] ?? 0;
        position -= 1;
      }
      sorted[position + 1] = value;
    }
    return sorted[Math.ceil(count * 0.95) - 1] ?? 0;
  }

  /**
   * Milliseconds since the last InputFwd for `slot`, or -1 when the slot is
   * outside 1..8 or has not received input. Uses the injected clock.
   */
  lastInputAgeMs(slot: number): number {
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_CONTROLLERS) {
      return -1;
    }
    const receivedAt = this.lastPacketAtMs[slot] ?? -1;
    if (receivedAt < 0) {
      return -1;
    }
    return Math.max(0, this.clock() - receivedAt);
  }

  /** Estimated server clock in milliseconds, or null until hostJoined. */
  serverNow(): number | null {
    const offset = this.serverTimeOffsetMs;
    return offset === null ? null : this.clock() + offset;
  }

  /**
   * Creates a room via `POST /api/rooms` relative to the resolved origin and
   * returns the parsed credentials. The origin is remembered for `connect()`.
   * The host token is also written to per-tab storage keyed by room code.
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
    const credentials = parseRoomCredentials(await response.json());
    if (this.storage !== null) {
      try {
        storeHostToken(this.storage, credentials.code, credentials.hostToken);
      } catch {
        // Per-tab storage can be unavailable (private mode); the caller still
        // holds the credentials in memory.
      }
    }
    return credentials;
  }

  /**
   * Opens the same-origin WebSocket at `/ws`. Resolves when the socket opens;
   * rejects if it errors or closes before opening.
   *
   * The previous socket, if any, is disposed without emitting close events so
   * a retry cannot clobber the new connection state.
   */
  connect(origin?: string): Promise<void> {
    const resolved = resolveServerOrigin(origin ?? this.origin ?? undefined);
    this.origin = resolved;

    this.settleOpen(new Error("Host connection was replaced."));
    this.failPendingHostJoin(new Error("Host socket was replaced before hostJoined."));
    this.disposeSocket();

    this.serverTimeOffsetMs = null;
    this.lastCloseInfo = null;
    this.connectionState = "connecting";

    // Created synchronously so a bad origin/constructor throws to the caller
    // (the D0 shell wraps connect() in try/catch).
    const socket = this.createWebSocket(toWebSocketUrl(resolved));
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    const opened = new Promise<void>((resolve, reject) => {
      this.pendingOpen = { resolve: () => resolve(), reject };
    });

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.connectionState = "connected";
      this.settleOpen(null);
      for (const listener of this.openListeners) listener();
    };
    socket.onclose = (info) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connectionState = "closed";
      this.lastCloseInfo = info;
      this.failPendingHostJoin(new Error("Host socket closed before hostJoined."));
      this.settleOpen(new Error("Host socket closed before it opened."));
      for (const listener of this.closeListeners) listener(info);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.settleOpen(new Error("Host socket failed to open."));
      for (const listener of this.errorListeners) listener();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleFrame(event.data);
    };

    return opened;
  }

  /**
   * Sends the host authentication message (A2) and resolves when the matching
   * `hostJoined` arrives. Records the server-time offset for `serverNow()`.
   *
   * Call it after `connect()` resolves; a browser WebSocket rejects `send`
   * while still connecting.
   */
  async hostJoin(code: string, hostToken: string): Promise<HostJoinResult> {
    if (this.connectionState !== "connected" || this.socket === null) {
      throw new Error(
        "hostJoin requires a connected host socket; call connect() and wait for open.",
      );
    }

    this.failPendingHostJoin(new Error("hostJoin was superseded by a newer request."));
    const joined = new Promise<HostJoinResult>((resolve, reject) => {
      this.pendingHostJoin = { code, resolve, reject };
    });

    try {
      this.sendHostJoin(code, hostToken);
    } catch (error) {
      this.pendingHostJoin = null;
      throw error;
    }
    return joined;
  }

  /**
   * Sends the host authentication message (A2). Kept for the D0 shell, which
   * calls it from `onOpen`; prefer `hostJoin()` when a result is needed.
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

  /** Sends a host-only control message. Controller messages are refused. */
  send(message: HostToServerMessage): void {
    if (!isHostToServerMessage(message)) {
      throw new Error(
        `HostClient.send only accepts host messages; refusing "${messageTypeOf(message)}".`,
      );
    }
    const socket = this.socket;
    if (socket === null) {
      throw new Error("send() requires an open WebSocket; call connect() first.");
    }
    socket.send(stringifyJsonMessage(message));
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

  /**
   * Decoded `InputFwd` frames: slot plus the wire input state. The state
   * object is reused for every frame, so apply it before returning.
   */
  onInput(listener: (slot: number, state: InputState) => void): () => void {
    this.inputListeners.add(listener);
    return () => {
      this.inputListeners.delete(listener);
    };
  }

  /** Player join/leave/suspend/resume events, mapped from the wire names. */
  onPlayer(listener: (event: HostPlayerEvent, slot: number) => void): () => void {
    this.playerListeners.add(listener);
    return () => {
      this.playerListeners.delete(listener);
    };
  }

  /** Per-slot server statistics (1 Hz); the array is the validated message body. */
  onServerStats(listener: (slots: SlotStats[]) => void): () => void {
    this.statsListeners.add(listener);
    return () => {
      this.statsListeners.delete(listener);
    };
  }

  /** Closes the socket without emitting close/error listeners. */
  close(): void {
    this.failPendingHostJoin(new Error("HostClient closed before hostJoined."));
    this.settleOpen(new Error("HostClient closed before the socket opened."));
    this.disposeSocket();
    this.connectionState = "closed";
  }

  private settleOpen(error: Error | null): void {
    const pending = this.pendingOpen;
    if (pending === null) {
      return;
    }
    this.pendingOpen = null;
    if (error === null) {
      pending.resolve();
    } else {
      pending.reject(error);
    }
  }

  private failPendingHostJoin(error: Error): void {
    const pending = this.pendingHostJoin;
    if (pending === null) {
      return;
    }
    this.pendingHostJoin = null;
    pending.reject(error);
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
        this.droppedMessages += 1;
        return;
      }
      if (!isServerToClientMessage(message)) {
        this.droppedMessages += 1;
        return;
      }
      this.handleControlMessage(message);
      return;
    }

    const bytes = toBytes(data);
    if (bytes === null || frameType(bytes) !== MSG.InputFwd) {
      return;
    }

    const startedAt = this.clock();
    let slot: number;
    try {
      slot = decodeInputFwdInto(bytes, this.inputState);
    } catch {
      this.malformedInputFrames += 1;
      return;
    }
    const receivedAt = this.clock();
    this.recordDecode(receivedAt - startedAt);
    this.packetsReceived += 1;
    this.lastPacketAtMs[slot] = receivedAt;

    for (const listener of this.inputListeners) listener(slot, this.inputState);
  }

  private handleControlMessage(message: ServerToClientMessage): void {
    switch (message.t) {
      case "hostJoined":
        this.serverTimeOffsetMs = message.serverTime - this.clock();
        this.resolveHostJoin(message);
        break;
      case "joinError":
        this.failPendingHostJoin(new Error(`Host join failed: ${message.reason}.`));
        break;
      case "playerJoined":
        this.dispatchPlayerEvent("joined", message.slot);
        break;
      case "playerLeft":
        this.dispatchPlayerEvent("left", message.slot);
        break;
      case "playerSuspended":
        this.dispatchPlayerEvent("suspended", message.slot);
        break;
      case "playerResumed":
        this.dispatchPlayerEvent("resumed", message.slot);
        break;
      case "stats":
        for (const listener of this.statsListeners) listener(message.slots);
        break;
      default:
        break;
    }

    for (const listener of this.messageListeners) listener(message);
  }

  private resolveHostJoin(
    message: Extract<ServerToClientMessage, { t: "hostJoined" }>,
  ): void {
    const pending = this.pendingHostJoin;
    if (pending === null || pending.code !== message.code) {
      return;
    }
    this.pendingHostJoin = null;
    pending.resolve({ serverTime: message.serverTime });
  }

  private dispatchPlayerEvent(event: HostPlayerEvent, slot: number): void {
    for (const listener of this.playerListeners) listener(event, slot);
  }

  private recordDecode(durationMs: number): void {
    this.decodeDurations[this.decodeHead] = durationMs;
    this.decodeHead = (this.decodeHead + 1) % DECODE_WINDOW;
    if (this.decodeCount < DECODE_WINDOW) {
      this.decodeCount += 1;
    }
  }
}

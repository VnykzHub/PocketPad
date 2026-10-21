/**
 * JSON framing, structural validation and frame caps (D0-PROTO-03; D5-PROTO-01).
 *
 * Every JSON control message on the wire goes through this module; no other
 * layer calls JSON.parse on socket text. Validation is structural only:
 * `layout`, `panel` and `event` bodies are opaque JsonValue and are never
 * interpreted here (FR-7.9). The one exception is `setLayout.layout.id`, which
 * the server needs as a routing/ack key (D5 contract 1).
 *
 * XSS-safe by construction (SR-13): event names are safe identifiers and are
 * never rendered; bodies stay data.
 */
import {
  MAX_CONTROLLERS,
  MAX_EVENT_NAME_CHARS,
  MAX_JSON_FRAME_BYTES,
  MAX_PLAYER_NAME_CHARS,
  ROOM_CODE_LENGTH,
  ROOM_PIN_LENGTH,
  TOKEN_LENGTH,
} from "./constants.js";
import { ProtocolError } from "./errors.js";
import type {
  ClientToServerMessage,
  EventMessage,
  HostStatusState,
  HostToServerMessage,
  JoinErrorReason,
  JsonControlMessage,
  JsonValue,
  LayoutAckForwardMessage,
  LayoutAckMessage,
  ServerToClientMessage,
  SlotStats,
} from "./messages.js";

/** One TextEncoder for the life of the module; the JSON path is not the hot path. */
const utf8Encoder = new TextEncoder();

/** Layout ids are 1..64 characters (SDK `LayoutDocument.id`, D5 contract 1). */
export const MAX_LAYOUT_ID_CHARS = 64;

/**
 * Event names are identifiers, never markup (D5-SEC-01, SR-13). Restricting
 * them at the wire boundary means a hostile name can never reach a DOM
 * attribute or a `switch` key as free text.
 */
const EVENT_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;

const JOIN_ERROR_REASONS: ReadonlySet<string> = new Set<JoinErrorReason>([
  "roomFull",
  "badToken",
  "badPin",
  "expired",
  "rateLimited",
  "badCode",
  "badHostToken",
  "badVersion",
]);

const HOST_STATUS_STATES: ReadonlySet<string> = new Set<HostStatusState>([
  "active",
  "paused",
  "lost",
]);

/*
 * These guards classify message kinds, not socket identity: `event` and
 * `layoutAck` are controller-originated but also travel server->host, and
 * `setLayout`/`panel` travel host->server->controller. Callers must still
 * check the socket role (they already do for `setLayout`/`panel`).
 */
const CLIENT_TO_SERVER_TYPES: ReadonlySet<string> = new Set([
  "join",
  "hostJoin",
  "suspend",
  "leave",
  "event",
  "layoutAck",
]);

/*
 * `setLayout` and `panel` exist in both directions with identical shapes, so
 * this guard is a shape/type check. Callers use it on messages received from a
 * host socket, never on server output.
 */
const HOST_TO_SERVER_TYPES: ReadonlySet<string> = new Set([
  "hostPause",
  "hostResume",
  "setLayout",
  "panel",
]);

type UnknownRecord = Record<string, unknown>;

function bad(code: "tooLarge" | "badType" | "badLength" | "badValue", message: string): never {
  throw new ProtocolError(code, message);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requireField(record: UnknownRecord, key: string): unknown {
  if (!hasOwn(record, key)) {
    bad("badType", `missing required field "${key}"`);
  }
  return record[key];
}

function requireString(record: UnknownRecord, key: string): string {
  const value = requireField(record, key);
  if (typeof value !== "string") {
    bad("badType", `"${key}" must be a string`);
  }
  return value;
}

function requireStringLength(record: UnknownRecord, key: string, min: number, max: number): string {
  const value = requireString(record, key);
  if (value.length < min || value.length > max) {
    bad("badLength", `"${key}" must be ${min}..${max} characters`);
  }
  return value;
}

function requireNonEmptyString(record: UnknownRecord, key: string): string {
  const value = requireString(record, key);
  if (value.length === 0) {
    bad("badValue", `"${key}" must not be empty`);
  }
  return value;
}

function requireInteger(record: UnknownRecord, key: string): number {
  const value = requireField(record, key);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    bad("badType", `"${key}" must be a finite number`);
  }
  if (!Number.isInteger(value)) {
    bad("badValue", `"${key}" must be an integer`);
  }
  return value;
}

function requireNumber(record: UnknownRecord, key: string): number {
  const value = requireField(record, key);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    bad("badType", `"${key}" must be a finite number`);
  }
  return value;
}

function requireNonNegativeNumber(record: UnknownRecord, key: string): number {
  const value = requireNumber(record, key);
  if (value < 0) {
    bad("badValue", `"${key}" must not be negative`);
  }
  return value;
}

function requireSlot(record: UnknownRecord, key: string): number {
  const slot = requireInteger(record, key);
  if (slot < 1 || slot > MAX_CONTROLLERS) {
    bad("badValue", `"${key}" must be in 1..${MAX_CONTROLLERS}`);
  }
  return slot;
}

/** `layout`, `panel.content` and `event.data` are opaque JsonValue: presence only. */
function requireJsonValue(record: UnknownRecord, key: string): JsonValue {
  if (!hasOwn(record, key)) {
    bad("badType", `missing required field "${key}"`);
  }
  return record[key] as JsonValue;
}

/** UTF-8 byte length of a JSON text frame (SR-6 counts bytes, not characters). */
export function jsonByteLength(text: string): number {
  if (typeof text !== "string") {
    bad("badType", "JSON frame must be a string");
  }
  return utf8Encoder.encode(text).byteLength;
}

/** Throws ProtocolError("tooLarge") when the text exceeds 4096 UTF-8 bytes. */
export function assertJsonWithinLimit(text: string): void {
  const bytes = jsonByteLength(text);
  if (bytes > MAX_JSON_FRAME_BYTES) {
    bad("tooLarge", `JSON frame is ${bytes} bytes; max ${MAX_JSON_FRAME_BYTES}`);
  }
}

function parseJoin(record: UnknownRecord): Extract<ClientToServerMessage, { t: "join" }> {
  const v = requireInteger(record, "v");
  const code = requireStringLength(record, "code", ROOM_CODE_LENGTH, ROOM_CODE_LENGTH);
  const message: Extract<ClientToServerMessage, { t: "join" }> = { t: "join", v, code };

  if (hasOwn(record, "name")) {
    message.name = requireStringLength(record, "name", 0, MAX_PLAYER_NAME_CHARS);
  }

  const hasToken = hasOwn(record, "token");
  const hasPin = hasOwn(record, "pin");
  const hasSession = hasOwn(record, "session");

  if (hasSession && (hasToken || hasPin)) {
    bad("badValue", "session must not be combined with token or pin");
  }
  if (!hasSession && !hasToken && !hasPin) {
    bad("badValue", "join requires one of token, pin or session");
  }

  // token + pin is structurally valid for the optional QR-PIN mode (A11).
  // The broker decides whether the room actually runs in that mode.
  if (hasToken) {
    message.token = requireNonEmptyString(record, "token");
  }
  if (hasPin) {
    const pin = requireStringLength(record, "pin", ROOM_PIN_LENGTH, ROOM_PIN_LENGTH);
    if (!/^\d+$/.test(pin)) {
      bad("badValue", `"pin" must be ${ROOM_PIN_LENGTH} digits`);
    }
    message.pin = pin;
  }
  if (hasSession) {
    message.session = requireNonEmptyString(record, "session");
  }

  return message;
}

function parseHostJoin(record: UnknownRecord): Extract<ClientToServerMessage, { t: "hostJoin" }> {
  const v = requireInteger(record, "v");
  const code = requireStringLength(record, "code", ROOM_CODE_LENGTH, ROOM_CODE_LENGTH);
  const hostToken = requireStringLength(record, "hostToken", TOKEN_LENGTH, TOKEN_LENGTH);
  return { t: "hostJoin", v, code, hostToken };
}

/**
 * Validates a `event` frame. `slot` is range-checked only; the broker owns the
 * trust decision and must compare it with the authenticated peer before
 * forwarding (D5-SRV-01). `data` stays opaque (FR-7.9).
 */
function parseEvent(record: UnknownRecord): EventMessage {
  const slot = requireSlot(record, "slot");
  const name = requireStringLength(record, "name", 1, MAX_EVENT_NAME_CHARS);
  if (!EVENT_NAME_PATTERN.test(name)) {
    bad(
      "badValue",
      `"name" must match ${EVENT_NAME_PATTERN.source} (event names are identifiers, not text)`,
    );
  }
  const data = requireJsonValue(record, "data");
  return { t: "event", slot, name, data };
}

/**
 * Parses a `layoutAck`. A controller sends only `layoutId`; the server fills
 * `slot` from the authenticated peer when forwarding to the host (D5 contract
 * 2). Accepting an optional `slot` here keeps that forward parseable; the
 * server must overwrite it and never trust a controller-supplied value.
 */
function parseLayoutAck(
  record: UnknownRecord,
): LayoutAckMessage | LayoutAckForwardMessage {
  const layoutId = requireStringLength(record, "layoutId", 1, MAX_LAYOUT_ID_CHARS);
  if (!hasOwn(record, "slot")) {
    return { t: "layoutAck", layoutId };
  }
  return { t: "layoutAck", layoutId, slot: requireSlot(record, "slot") };
}

function parseSetLayout(record: UnknownRecord): Extract<HostToServerMessage, { t: "setLayout" }> {
  const rawSlot = requireField(record, "slot");
  let slot: number | "all";
  if (rawSlot === "all") {
    slot = "all";
  } else if (typeof rawSlot === "number" && Number.isInteger(rawSlot)) {
    if (rawSlot < 1 || rawSlot > MAX_CONTROLLERS) {
      bad("badValue", `"slot" must be "all" or 1..${MAX_CONTROLLERS}`);
    }
    slot = rawSlot;
  } else {
    bad("badType", `"slot" must be "all" or an integer in 1..${MAX_CONTROLLERS}`);
  }

  // The server needs `layout.id` as its routing/ack key, but never reads the
  // rest of the body (FR-7.9). Full validation is SDK-side.
  const layout = requireField(record, "layout");
  if (!isRecord(layout)) {
    bad("badType", `"layout" must be an object`);
  }
  requireStringLength(layout, "id", 1, MAX_LAYOUT_ID_CHARS);
  return { t: "setLayout", slot, layout: layout as unknown as JsonValue };
}

function parsePanel(record: UnknownRecord): Extract<HostToServerMessage, { t: "panel" }> {
  const slot = requireSlot(record, "slot");
  const content = requireJsonValue(record, "content");
  return { t: "panel", slot, content };
}

function parseJoined(record: UnknownRecord): Extract<ServerToClientMessage, { t: "joined" }> {
  const slot = requireSlot(record, "slot");
  const session = requireNonEmptyString(record, "session");
  const serverTime = requireNumber(record, "serverTime");
  const message: Extract<ServerToClientMessage, { t: "joined" }> = {
    t: "joined",
    slot,
    session,
    serverTime,
  };
  if (hasOwn(record, "layout")) {
    message.layout = requireJsonValue(record, "layout");
  }
  return message;
}

function parseHostJoined(
  record: UnknownRecord,
): Extract<ServerToClientMessage, { t: "hostJoined" }> {
  const code = requireStringLength(record, "code", ROOM_CODE_LENGTH, ROOM_CODE_LENGTH);
  const serverTime = requireNumber(record, "serverTime");
  return { t: "hostJoined", code, serverTime };
}

/**
 * A9: host presence for controllers. `state` is a closed enum; anything else
 * is a type error rather than a value error so a controller never sees an
 * unexpected host state. Unknown extra fields are dropped like every other
 * message, so this variant cannot carry UGC.
 */
function parseHostStatus(
  record: UnknownRecord,
): Extract<ServerToClientMessage, { t: "hostStatus" }> {
  const state = requireString(record, "state");
  if (!HOST_STATUS_STATES.has(state)) {
    bad("badType", `unknown hostStatus state "${state}"`);
  }
  return { t: "hostStatus", state: state as HostStatusState };
}

function parseJoinError(
  record: UnknownRecord,
): Extract<ServerToClientMessage, { t: "joinError" }> {
  const reason = requireString(record, "reason");
  if (!JOIN_ERROR_REASONS.has(reason)) {
    bad("badValue", `unknown join error reason "${reason}"`);
  }
  return { t: "joinError", reason: reason as JoinErrorReason };
}

type PlayerMessageType =
  | "playerJoined"
  | "playerLeft"
  | "playerSuspended"
  | "playerResumed";

function parsePlayerMessage(
  record: UnknownRecord,
  t: PlayerMessageType,
): Extract<ServerToClientMessage, { t: PlayerMessageType }> {
  const slot = requireSlot(record, "slot");
  // All four player messages share the same shape; the assertion narrows t.
  return { t, slot } as Extract<ServerToClientMessage, { t: PlayerMessageType }>;
}

function parseKick(record: UnknownRecord): Extract<ServerToClientMessage, { t: "kick" }> {
  const reason = requireString(record, "reason");
  return { t: "kick", reason };
}

function parseStats(record: UnknownRecord): Extract<ServerToClientMessage, { t: "stats" }> {
  const rawSlots = requireField(record, "slots");
  if (!Array.isArray(rawSlots)) {
    bad("badType", `"slots" must be an array`);
  }
  if (rawSlots.length > MAX_CONTROLLERS) {
    bad("badValue", `"slots" has ${rawSlots.length} entries; max ${MAX_CONTROLLERS}`);
  }
  const slots: SlotStats[] = new Array<SlotStats>(rawSlots.length);
  for (let index = 0; index < rawSlots.length; index += 1) {
    const entry: unknown = rawSlots[index];
    if (!isRecord(entry)) {
      bad("badType", `"slots[${index}]" must be an object`);
    }
    slots[index] = {
      slot: requireSlot(entry, "slot"),
      rttMs: requireNonNegativeNumber(entry, "rttMs"),
      jitterMs: requireNonNegativeNumber(entry, "jitterMs"),
      lastInputAgeMs: requireNonNegativeNumber(entry, "lastInputAgeMs"),
      packetsPerSecond: requireNonNegativeNumber(entry, "packetsPerSecond"),
      drops: requireNonNegativeNumber(entry, "drops"),
    };
  }
  return { t: "stats", slots };
}

/**
 * Parses and structurally validates one JSON text frame.
 *
 * Throws ProtocolError with `tooLarge`, `badType`, `badLength` or `badValue`.
 * Layout, panel and event bodies are passed through as opaque JsonValue.
 */
export function parseJsonMessage(text: string): JsonControlMessage {
  assertJsonWithinLimit(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    bad("badType", "invalid JSON");
  }

  if (!isRecord(parsed)) {
    bad("badType", "JSON message root must be an object");
  }
  const t = parsed["t"];
  if (typeof t !== "string") {
    bad("badType", `missing string field "t"`);
  }

  switch (t) {
    case "join":
      return parseJoin(parsed);
    case "hostJoin":
      return parseHostJoin(parsed);
    case "suspend":
      return { t: "suspend" };
    case "leave":
      return { t: "leave" };
    case "event":
      return parseEvent(parsed);
    case "layoutAck":
      return parseLayoutAck(parsed);
    case "hostPause":
      return { t: "hostPause" };
    case "hostResume":
      return { t: "hostResume" };
    case "setLayout":
      return parseSetLayout(parsed);
    case "panel":
      return parsePanel(parsed);
    case "joined":
      return parseJoined(parsed);
    case "hostJoined":
      return parseHostJoined(parsed);
    case "hostStatus":
      return parseHostStatus(parsed);
    case "joinError":
      return parseJoinError(parsed);
    case "playerJoined":
      return parsePlayerMessage(parsed, "playerJoined");
    case "playerLeft":
      return parsePlayerMessage(parsed, "playerLeft");
    case "playerSuspended":
      return parsePlayerMessage(parsed, "playerSuspended");
    case "playerResumed":
      return parsePlayerMessage(parsed, "playerResumed");
    case "kick":
      return parseKick(parsed);
    case "stats":
      return parseStats(parsed);
    default:
      bad("badType", `unknown message type "${t}"`);
  }
}

/**
 * Serializes a control message and enforces the 4096-byte UTF-8 cap so the
 * caller can never emit a frame the peer must reject (SR-6).
 */
export function stringifyJsonMessage(message: JsonControlMessage): string {
  const text = JSON.stringify(message);
  assertJsonWithinLimit(text);
  return text;
}

/**
 * Slot binding for controller events (FR-7.8, D5-SRV-01).
 *
 * The wire `slot` is never authoritative: the broker compares it with the slot
 * assigned at join and drops mismatches with a counter instead of forwarding
 * them. A boolean keeps the drop-vs-close policy in the adapter.
 */
export function isEventSlotBoundTo(event: EventMessage, authenticatedSlot: number): boolean {
  return event.slot === authenticatedSlot;
}

/** True when the message type may be sent by a controller-role socket (hostJoin included for the host handshake). */
export function isClientToServerMessage(
  message: JsonControlMessage,
): message is ClientToServerMessage {
  return CLIENT_TO_SERVER_TYPES.has(message.t);
}

/** True when the message type may be sent by a host-role socket. */
export function isHostToServerMessage(message: JsonControlMessage): message is HostToServerMessage {
  return HOST_TO_SERVER_TYPES.has(message.t);
}

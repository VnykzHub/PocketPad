/**
 * Frozen `.pps` header codec (15 §3.3, §4.2–§4.6).
 *
 * Layout is frozen by 00 §4.5: a 40-byte little-endian prefix, the UTF-8
 * `gameId` and `gameVersion`, then zero padding to an 8-byte boundary.
 * `headerBytes` must be the minimal padded value.
 *
 * Pure functions: no I/O and no browser storage. `TextEncoder`/`TextDecoder`
 * exist in Node 20 and every target browser. This is a cold path; allocation
 * is permitted.
 */

import type { SaveHeader } from "../contracts/save.js";
import {
  SAVE_FLAG_DEFLATE,
  SAVE_FLAGS_RESERVED_MASK,
  SAVE_FORMAT_VERSION,
  SAVE_HEADER_BYTES,
  SAVE_HEADER_MAX_BYTES,
  SAVE_MAGIC,
  SAVE_MAX_GAME_ID_BYTES,
  SAVE_MAX_GAME_VERSION_BYTES,
  SAVE_MAX_PAYLOAD_BYTES,
  SAVE_MAX_UNCOMPRESSED_BYTES,
} from "./constants.js";
import { saveError } from "./errors.js";

/** `createSaveHeader` input (15 §3.3). */
export interface CreateSaveHeaderInput {
  /** Strict `"major.minor.patch"`. */
  readonly engineVersion: string;
  readonly gameId: string;
  readonly gameVersion: string;
  /** Epoch milliseconds UTC; converted to u32 epoch seconds in the file. */
  readonly createdAtUnixMs: number;
  /** Compressed or raw; length and FNV-1a 32 are computed from it. */
  readonly storedPayload: Uint8Array;
  /** `0` or `SAVE_FLAG_DEFLATE`. Defaults to `0`. */
  readonly flags?: number;
  /** Required when the deflate flag is set; `0`/absent otherwise. */
  readonly payloadUncompressedBytes?: number;
}

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MAGIC_BYTES = new Uint8Array([0x50, 0x50, 0x53, 0x56]);
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  // Preserve a leading BOM as U+FEFF so encode/decode stay byte-faithful.
  ignoreBOM: true,
});

/** Rounds a small non-negative byte count up to a multiple of 8. */
function align8(value: number): number {
  return (value + 7) & ~7;
}

function requireInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw saveError(
      "E_SAVE_FORMAT",
      `${field} must be an integer in ${minimum}..${maximum}`,
    );
  }
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function encodeText(
  value: string,
  field: string,
  maxBytes: number,
  forbidSlash: boolean,
): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw saveError("E_SAVE_FORMAT", `${field} must be a non-empty string`);
  }
  if (value.indexOf("\u0000") !== -1) {
    throw saveError("E_SAVE_FORMAT", `${field} must not contain NUL`);
  }
  if (forbidSlash && value.indexOf("/") !== -1) {
    throw saveError("E_SAVE_FORMAT", `${field} must not contain "/"`);
  }
  if (containsLoneSurrogate(value)) {
    throw saveError("E_SAVE_FORMAT", `${field} is not well-formed UTF-16`);
  }
  const bytes = UTF8_ENCODER.encode(value);
  if (bytes.length > maxBytes) {
    throw saveError(
      "E_SAVE_FORMAT",
      `${field} exceeds ${maxBytes} UTF-8 bytes`,
    );
  }
  return bytes;
}

function decodeText(
  bytes: Uint8Array,
  field: string,
  forbidSlash: boolean,
): string {
  let value: string;
  try {
    value = UTF8_DECODER.decode(bytes);
  } catch {
    throw saveError("E_SAVE_FORMAT", `${field} is not valid UTF-8`);
  }
  if (value.length === 0) {
    throw saveError("E_SAVE_FORMAT", `${field} must be a non-empty string`);
  }
  if (value.indexOf("\u0000") !== -1) {
    throw saveError("E_SAVE_FORMAT", `${field} must not contain NUL`);
  }
  if (forbidSlash && value.indexOf("/") !== -1) {
    throw saveError("E_SAVE_FORMAT", `${field} must not contain "/"`);
  }
  return value;
}

function parseEngineVersion(value: string): {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
} {
  if (typeof value !== "string") {
    throw saveError("E_SAVE_FORMAT", "engineVersion must be a string");
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (match === null) {
    throw saveError(
      "E_SAVE_FORMAT",
      "engineVersion must be strict major.minor.patch",
    );
  }
  const majorText = match[1];
  const minorText = match[2];
  const patchText = match[3];
  if (
    majorText === undefined ||
    minorText === undefined ||
    patchText === undefined
  ) {
    throw saveError(
      "E_SAVE_FORMAT",
      "engineVersion must be strict major.minor.patch",
    );
  }
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  for (const part of [major, minor, patch]) {
    if (!Number.isInteger(part) || part < 0 || part > UINT16_MAX) {
      throw saveError(
        "E_SAVE_FORMAT",
        "engineVersion components must fit in u16",
      );
    }
  }
  return { major, minor, patch };
}

function checkFlags(flags: number): void {
  requireInteger(flags, 0, UINT16_MAX, "flags");
  if ((flags & SAVE_FLAGS_RESERVED_MASK) !== 0) {
    throw saveError("E_SAVE_FORMAT", "flags has reserved bits set");
  }
}

function checkUncompressedBytes(flags: number, bytes: number): void {
  requireInteger(
    bytes,
    0,
    SAVE_MAX_UNCOMPRESSED_BYTES,
    "payloadUncompressedBytes",
  );
  if ((flags & SAVE_FLAG_DEFLATE) !== 0) {
    if (bytes < 1) {
      throw saveError(
        "E_SAVE_FORMAT",
        "payloadUncompressedBytes must be at least 1 when the deflate flag is set",
      );
    }
  } else if (bytes !== 0) {
    throw saveError(
      "E_SAVE_FORMAT",
      "payloadUncompressedBytes must be 0 when the deflate flag is clear",
    );
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * FNV-1a 32 over bytes; returns an unsigned 32-bit integer.
 * Published vectors: `""` -> `0x811C9DC5`, `"a"` -> `0xE40C292C`,
 * `"foobar"` -> `0xBF9CF968`, `"hello"` -> `0x4F9F2CAB`.
 * A corruption check, not a security hash.
 */
export function fnv1a32(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array)) {
    throw saveError("E_SAVE_FORMAT", "fnv1a32 expects a Uint8Array");
  }
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Builds a complete header from caller fields and the *stored* payload.
 * `payloadBytes` and `payloadHash` are derived, never trusted from input.
 * Throws `E_SAVE_FORMAT` on invalid input.
 */
export function createSaveHeader(input: CreateSaveHeaderInput): SaveHeader {
  if (typeof input !== "object" || input === null) {
    throw saveError("E_SAVE_FORMAT", "createSaveHeader input is required");
  }

  const engine = parseEngineVersion(input.engineVersion);
  // Validate both strings before touching the payload.
  encodeText(input.gameId, "gameId", SAVE_MAX_GAME_ID_BYTES, true);
  encodeText(
    input.gameVersion,
    "gameVersion",
    SAVE_MAX_GAME_VERSION_BYTES,
    false,
  );

  const storedPayload = input.storedPayload;
  if (!(storedPayload instanceof Uint8Array)) {
    throw saveError("E_SAVE_FORMAT", "storedPayload must be a Uint8Array");
  }
  if (storedPayload.byteLength > SAVE_MAX_PAYLOAD_BYTES) {
    throw saveError(
      "E_SAVE_FORMAT",
      `storedPayload exceeds ${SAVE_MAX_PAYLOAD_BYTES} bytes`,
    );
  }

  if (
    typeof input.createdAtUnixMs !== "number" ||
    !Number.isFinite(input.createdAtUnixMs)
  ) {
    throw saveError(
      "E_SAVE_FORMAT",
      "createdAtUnixMs must be a finite number",
    );
  }
  const createdAtUnixSeconds = clamp(
    Math.floor(input.createdAtUnixMs / 1000),
    0,
    UINT32_MAX,
  );

  const flags = input.flags ?? 0;
  checkFlags(flags);

  let payloadUncompressedBytes = 0;
  if ((flags & SAVE_FLAG_DEFLATE) !== 0) {
    const declared = input.payloadUncompressedBytes;
    if (declared === undefined) {
      throw saveError(
        "E_SAVE_FORMAT",
        "payloadUncompressedBytes is required when the deflate flag is set",
      );
    }
    payloadUncompressedBytes = declared;
  } else if (input.payloadUncompressedBytes !== undefined) {
    payloadUncompressedBytes = input.payloadUncompressedBytes;
  }
  checkUncompressedBytes(flags, payloadUncompressedBytes);

  return {
    formatVersion: SAVE_FORMAT_VERSION,
    engineMajor: engine.major,
    engineMinor: engine.minor,
    enginePatch: engine.patch,
    gameId: input.gameId,
    gameVersion: input.gameVersion,
    createdAtUnixSeconds,
    payloadBytes: storedPayload.byteLength,
    payloadUncompressedBytes,
    payloadHash: fnv1a32(storedPayload),
    flags,
  };
}

/**
 * Serializes the 40-byte prefix + strings + zero padding. The payload is not
 * included. Throws `E_SAVE_FORMAT` for invalid fields and `E_SAVE_VERSION` for
 * a `formatVersion` newer than this writer.
 */
export function encodeSaveHeader(header: SaveHeader): Uint8Array {
  if (typeof header !== "object" || header === null) {
    throw saveError("E_SAVE_FORMAT", "a save header is required");
  }

  requireInteger(header.formatVersion, 0, UINT16_MAX, "formatVersion");
  if (header.formatVersion > SAVE_FORMAT_VERSION) {
    throw saveError(
      "E_SAVE_VERSION",
      `save format version ${header.formatVersion} is newer than ${SAVE_FORMAT_VERSION}`,
    );
  }
  if (header.formatVersion !== SAVE_FORMAT_VERSION) {
    throw saveError(
      "E_SAVE_FORMAT",
      `formatVersion must be ${SAVE_FORMAT_VERSION}`,
    );
  }

  requireInteger(header.engineMajor, 0, UINT16_MAX, "engineMajor");
  requireInteger(header.engineMinor, 0, UINT16_MAX, "engineMinor");
  requireInteger(header.enginePatch, 0, UINT16_MAX, "enginePatch");

  const gameIdBytes = encodeText(
    header.gameId,
    "gameId",
    SAVE_MAX_GAME_ID_BYTES,
    true,
  );
  const gameVersionBytes = encodeText(
    header.gameVersion,
    "gameVersion",
    SAVE_MAX_GAME_VERSION_BYTES,
    false,
  );

  requireInteger(
    header.payloadBytes,
    0,
    SAVE_MAX_PAYLOAD_BYTES,
    "payloadBytes",
  );
  requireInteger(header.payloadHash, 0, UINT32_MAX, "payloadHash");

  const flags = header.flags;
  checkFlags(flags);
  checkUncompressedBytes(flags, header.payloadUncompressedBytes);

  requireInteger(
    header.createdAtUnixSeconds,
    0,
    UINT32_MAX,
    "createdAtUnixSeconds",
  );

  const headerBytes = align8(
    SAVE_HEADER_BYTES + gameIdBytes.length + gameVersionBytes.length,
  );
  if (
    headerBytes < SAVE_HEADER_BYTES ||
    headerBytes > SAVE_HEADER_MAX_BYTES
  ) {
    throw saveError("E_SAVE_FORMAT", "headerBytes is out of range");
  }

  const out = new Uint8Array(headerBytes);
  const view = new DataView(out.buffer);
  out.set(MAGIC_BYTES, 0);
  view.setUint16(4, header.formatVersion, true);
  view.setUint16(6, headerBytes, true);
  view.setUint32(8, header.payloadBytes, true);
  view.setUint32(12, header.payloadHash, true);
  view.setUint16(16, header.engineMajor, true);
  view.setUint16(18, header.engineMinor, true);
  view.setUint16(20, header.enginePatch, true);
  view.setUint16(22, gameIdBytes.length, true);
  view.setUint16(24, gameVersionBytes.length, true);
  view.setUint16(26, flags, true);
  view.setUint32(28, header.createdAtUnixSeconds, true);
  view.setUint32(32, header.payloadUncompressedBytes, true);
  view.setUint32(36, 0, true);
  out.set(gameIdBytes, SAVE_HEADER_BYTES);
  out.set(gameVersionBytes, SAVE_HEADER_BYTES + gameIdBytes.length);
  return out;
}

/**
 * Parses and validates a header region.
 *
 * `bytes` may be a header-only buffer or a complete `.pps` file; bytes past
 * `headerBytes` are ignored here and checked by `decodeSaveFile`. Throws
 * `E_SAVE_VERSION` for a newer format and `E_SAVE_FORMAT` for every
 * structural failure. Never mutates the input.
 */
export function decodeSaveHeader(bytes: Uint8Array): SaveHeader {
  if (!(bytes instanceof Uint8Array)) {
    throw saveError("E_SAVE_FORMAT", "decodeSaveHeader expects a Uint8Array");
  }
  if (bytes.length < SAVE_HEADER_BYTES) {
    throw saveError("E_SAVE_FORMAT", "truncated save header");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    view.getUint8(0) !== 0x50 ||
    view.getUint8(1) !== 0x50 ||
    view.getUint8(2) !== 0x53 ||
    view.getUint8(3) !== 0x56
  ) {
    throw saveError("E_SAVE_FORMAT", `magic must be "${SAVE_MAGIC}"`);
  }

  const formatVersion = view.getUint16(4, true);
  if (formatVersion > SAVE_FORMAT_VERSION) {
    throw saveError(
      "E_SAVE_VERSION",
      `save format version ${formatVersion} is newer than ${SAVE_FORMAT_VERSION}`,
    );
  }
  if (formatVersion !== SAVE_FORMAT_VERSION) {
    throw saveError(
      "E_SAVE_FORMAT",
      `formatVersion must be ${SAVE_FORMAT_VERSION}`,
    );
  }

  const headerBytes = view.getUint16(6, true);
  if (headerBytes < SAVE_HEADER_BYTES || headerBytes > SAVE_HEADER_MAX_BYTES) {
    throw saveError("E_SAVE_FORMAT", "headerBytes is out of range");
  }
  if (headerBytes % 8 !== 0) {
    throw saveError("E_SAVE_FORMAT", "headerBytes is not a multiple of 8");
  }
  if (bytes.length < headerBytes) {
    throw saveError("E_SAVE_FORMAT", "truncated save header");
  }

  const payloadBytes = view.getUint32(8, true);
  if (payloadBytes > SAVE_MAX_PAYLOAD_BYTES) {
    throw saveError(
      "E_SAVE_FORMAT",
      `payloadBytes exceeds ${SAVE_MAX_PAYLOAD_BYTES} bytes`,
    );
  }

  const payloadHash = view.getUint32(12, true);
  const engineMajor = view.getUint16(16, true);
  const engineMinor = view.getUint16(18, true);
  const enginePatch = view.getUint16(20, true);
  const gameIdBytes = view.getUint16(22, true);
  const gameVersionBytes = view.getUint16(24, true);
  const flags = view.getUint16(26, true);
  const createdAtUnixSeconds = view.getUint32(28, true);
  const payloadUncompressedBytes = view.getUint32(32, true);
  const reserved = view.getUint32(36, true);

  if (gameIdBytes < 1 || gameIdBytes > SAVE_MAX_GAME_ID_BYTES) {
    throw saveError(
      "E_SAVE_FORMAT",
      `gameIdBytes must be 1..${SAVE_MAX_GAME_ID_BYTES}`,
    );
  }
  if (
    gameVersionBytes < 1 ||
    gameVersionBytes > SAVE_MAX_GAME_VERSION_BYTES
  ) {
    throw saveError(
      "E_SAVE_FORMAT",
      `gameVersionBytes must be 1..${SAVE_MAX_GAME_VERSION_BYTES}`,
    );
  }

  const expectedHeaderBytes = align8(
    SAVE_HEADER_BYTES + gameIdBytes + gameVersionBytes,
  );
  if (headerBytes !== expectedHeaderBytes) {
    throw saveError(
      "E_SAVE_FORMAT",
      "headerBytes is not the minimal padded value",
    );
  }

  const gameId = decodeText(
    bytes.subarray(SAVE_HEADER_BYTES, SAVE_HEADER_BYTES + gameIdBytes),
    "gameId",
    true,
  );
  const gameVersion = decodeText(
    bytes.subarray(
      SAVE_HEADER_BYTES + gameIdBytes,
      SAVE_HEADER_BYTES + gameIdBytes + gameVersionBytes,
    ),
    "gameVersion",
    false,
  );

  for (
    let index = SAVE_HEADER_BYTES + gameIdBytes + gameVersionBytes;
    index < headerBytes;
    index += 1
  ) {
    if (view.getUint8(index) !== 0) {
      throw saveError("E_SAVE_FORMAT", "header padding must be zero");
    }
  }

  checkFlags(flags);
  checkUncompressedBytes(flags, payloadUncompressedBytes);
  if (reserved !== 0) {
    throw saveError("E_SAVE_FORMAT", "reserved header field must be zero");
  }

  return {
    formatVersion,
    engineMajor,
    engineMinor,
    enginePatch,
    gameId,
    gameVersion,
    createdAtUnixSeconds,
    payloadBytes,
    payloadUncompressedBytes,
    payloadHash,
    flags,
  };
}

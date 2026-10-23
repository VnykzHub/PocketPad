/**
 * Shared helpers for the save-codec tests.
 *
 * The fixture is synthetic (README in this directory). Node-only tests read
 * it with `node:fs`; nothing here performs network or storage I/O.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SaveHeader } from "../../src/contracts/save.js";
import { createSaveHeader } from "../../src/save/header.js";
import { SaveEngineError } from "../../src/save/errors.js";

/** Synthetic fixture JSON (15 §4.9). Only the fields the tests use. */
export interface FixtureJson {
  readonly magic: string;
  readonly formatVersion: number;
  readonly headerBytes: number;
  readonly payloadBytes: number;
  readonly payloadHash: number;
  readonly payloadHashHex: string;
  readonly engineMajor: number;
  readonly engineMinor: number;
  readonly enginePatch: number;
  readonly gameIdBytes: number;
  readonly gameVersionBytes: number;
  readonly flags: number;
  readonly createdAtUnixSeconds: number;
  readonly createdAtUnixMs: number;
  readonly payloadUncompressedBytes: number;
  readonly reserved: number;
  readonly gameId: string;
  readonly gameVersion: string;
  readonly paddingBytes: number;
  readonly payloadText: string;
  readonly payloadSha256: string;
}

export interface FixtureData {
  readonly json: FixtureJson;
  /** The complete 85-byte synthetic `.pps`. */
  readonly file: Uint8Array;
  /** The 56-byte header region of `file`. */
  readonly headerBytes: Uint8Array;
  /** The 29-byte synthetic payload. */
  readonly storedPayload: Uint8Array;
}

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url);

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(name, FIXTURE_DIR))));
}

export function loadFixture(): FixtureData {
  const json = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("header-v1.json", FIXTURE_DIR)),
      "utf8",
    ),
  ) as FixtureJson;
  const file = readFixture("header-v1.bin");
  const headerBytes = file.slice(0, json.headerBytes);
  const storedPayload = file.slice(
    json.headerBytes,
    json.headerBytes + json.payloadBytes,
  );
  return { json, file, headerBytes, storedPayload };
}

/** Builds the header from the JSON fields and the 29-byte stored payload. */
export function createFixtureHeader(
  json: FixtureJson,
  storedPayload: Uint8Array,
): SaveHeader {
  return createSaveHeader({
    engineVersion: `${json.engineMajor}.${json.engineMinor}.${json.enginePatch}`,
    gameId: json.gameId,
    gameVersion: json.gameVersion,
    createdAtUnixMs: json.createdAtUnixMs,
    storedPayload,
    flags: json.flags,
    payloadUncompressedBytes: json.payloadUncompressedBytes,
  });
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Runs `fn`, requiring a `SaveEngineError`, and returns it. */
export function expectSaveError(fn: () => unknown): SaveEngineError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SaveEngineError) return error;
    throw new Error(`expected SaveEngineError, received ${String(error)}`);
  }
  throw new Error("expected a save error, but the call succeeded");
}

/** Returns a copy of `bytes` with one byte replaced. */
export function withByte(
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array {
  if (offset < 0 || offset >= bytes.length) {
    throw new Error(`offset ${offset} is outside the ${bytes.length}-byte input`);
  }
  const copy = bytes.slice();
  copy[offset] = value;
  return copy;
}

/** Returns a copy of `bytes` with a little-endian u16 replaced. */
export function withUint16(
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint16(
    offset,
    value,
    true,
  );
  return copy;
}

/** Returns a copy of `bytes` with a little-endian u32 replaced. */
export function withUint32(
  bytes: Uint8Array,
  offset: number,
  value: number,
): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint32(
    offset,
    value,
    true,
  );
  return copy;
}

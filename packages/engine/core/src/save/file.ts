/**
 * Whole-`.pps` container codec (15 §3.3, §4.1–§4.3).
 *
 * A file is exactly `headerBytes` + `payloadBytes`; there is no trailer in v1.
 * The payload is opaque game data and is never decompressed or parsed here.
 * Pure functions: no I/O, no browser storage, no decompression.
 */

import type { SaveHeader } from "../contracts/save.js";
import {
  SAVE_HEADER_BYTES,
  SAVE_MAX_PAYLOAD_BYTES,
} from "./constants.js";
import { saveError } from "./errors.js";
import {
  decodeSaveHeader,
  encodeSaveHeader,
  fnv1a32,
} from "./header.js";

/** `decodeSaveFile` result (15 §3.3). */
export interface DecodedSaveFile {
  readonly header: SaveHeader;
  /** Stored, possibly compressed bytes; not decompressed. */
  readonly storedPayload: Uint8Array;
}

/**
 * Concatenates the header and the stored payload after verifying that the
 * header's `payloadBytes` and `payloadHash` describe exactly these bytes.
 * A mismatch is `E_SAVE_HASH` (15 §4.3): the header claims a payload it was
 * not paired with.
 */
export function encodeSaveFile(
  header: SaveHeader,
  storedPayload: Uint8Array,
): Uint8Array {
  const encodedHeader = encodeSaveHeader(header);

  if (!(storedPayload instanceof Uint8Array)) {
    throw saveError("E_SAVE_FORMAT", "storedPayload must be a Uint8Array");
  }
  if (storedPayload.byteLength > SAVE_MAX_PAYLOAD_BYTES) {
    throw saveError(
      "E_SAVE_FORMAT",
      `storedPayload exceeds ${SAVE_MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  if (header.payloadBytes !== storedPayload.byteLength) {
    throw saveError(
      "E_SAVE_HASH",
      "header payloadBytes does not match the stored payload length",
    );
  }
  if (header.payloadHash !== fnv1a32(storedPayload)) {
    throw saveError(
      "E_SAVE_HASH",
      "header payloadHash does not match the stored payload",
    );
  }

  const file = new Uint8Array(encodedHeader.length + storedPayload.length);
  file.set(encodedHeader, 0);
  file.set(storedPayload, encodedHeader.length);
  return file;
}

/**
 * Parses a complete `.pps` file, verifies its structure and the FNV-1a 32 of
 * the stored payload, and returns the stored bytes.
 *
 * `expectedGameId` is an additive optional M0 convenience: the M1 `SaveStore`
 * is the layer that knows the running game id, but exposing the comparison
 * here lets the codec return `E_SAVE_GAME` without a store. It never changes
 * the one-argument behaviour.
 *
 * Never mutates the input. Throws `E_SAVE_VERSION` before any structural
 * check other than the minimum length and magic.
 */
export function decodeSaveFile(
  bytes: Uint8Array,
  expectedGameId?: string,
): DecodedSaveFile {
  if (!(bytes instanceof Uint8Array)) {
    throw saveError("E_SAVE_FORMAT", "decodeSaveFile expects a Uint8Array");
  }
  if (bytes.length < SAVE_HEADER_BYTES) {
    throw saveError("E_SAVE_FORMAT", "truncated save file");
  }

  const header = decodeSaveHeader(bytes);
  if (expectedGameId !== undefined && header.gameId !== expectedGameId) {
    throw saveError("E_SAVE_GAME", "save belongs to a different game");
  }

  // `decodeSaveHeader` has already validated this offset and range.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerBytes = view.getUint16(6, true);
  const fileBytes = headerBytes + header.payloadBytes;

  if (bytes.length < fileBytes) {
    throw saveError("E_SAVE_FORMAT", "truncated stored payload");
  }
  if (bytes.length > fileBytes) {
    throw saveError(
      "E_SAVE_FORMAT",
      "trailing bytes after the stored payload",
    );
  }

  const storedPayload = bytes.slice(headerBytes, fileBytes);
  if (fnv1a32(storedPayload) !== header.payloadHash) {
    throw saveError(
      "E_SAVE_HASH",
      "stored payload hash does not match the save header",
    );
  }

  return { header, storedPayload };
}

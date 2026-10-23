/**
 * Save codec property tests (15 §7, ER-15-03).
 *
 * 10,000 generated valid headers must round-trip; random single-bit mutations
 * and arbitrary byte strings must either decode to a valid, re-encodable
 * value or throw `SaveEngineError` with an `E_SAVE_*` code. Failures throw a
 * plain Error rather than mixing thousands of `expect` calls into the loop.
 */

import fc from "fast-check";
import { test } from "vitest";
import type { SaveHeader } from "../../src/contracts/save.js";
import {
  createSaveHeader,
  decodeSaveFile,
  decodeSaveHeader,
  encodeSaveFile,
  encodeSaveHeader,
  SAVE_FLAG_DEFLATE,
  SAVE_HEADER_MAX_BYTES,
} from "../../src/save/index.js";
import { SaveEngineError } from "../../src/save/errors.js";
import { toHex } from "./helpers.js";

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const MAX_TIMESTAMP_MS = UINT32_MAX * 1000 + 999;
const MAX_PAYLOAD_BYTES = 256;
const SAVE_CODES = new Set([
  "E_SAVE_FORMAT",
  "E_SAVE_VERSION",
  "E_SAVE_HASH",
  "E_SAVE_GAME",
]);

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-".split("");
const FIRST_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const VERSION_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz.-/+".split("");

/** A 1..64-byte ASCII manifest slug. */
const GAME_ID = fc
  .tuple(
    fc.constantFrom(...FIRST_ID_CHARS),
    fc.string({
      unit: fc.constantFrom(...ID_CHARS),
      minLength: 0,
      maxLength: 63,
    }),
  )
  .map(([first, rest]) => first + rest);

/** A 1..32-byte, NUL-free game version. */
const GAME_VERSION = fc.string({
  unit: fc.constantFrom(...VERSION_CHARS),
  minLength: 1,
  maxLength: 32,
});

const VALID_INPUT = fc.record({
  gameId: GAME_ID,
  gameVersion: GAME_VERSION,
  engineMajor: fc.integer({ min: 0, max: UINT16_MAX }),
  engineMinor: fc.integer({ min: 0, max: UINT16_MAX }),
  enginePatch: fc.integer({ min: 0, max: UINT16_MAX }),
  createdAtUnixMs: fc.integer({ min: 0, max: MAX_TIMESTAMP_MS }),
  storedPayload: fc.uint8Array({ maxLength: MAX_PAYLOAD_BYTES }),
  deflated: fc.boolean(),
  uncompressedBytes: fc.integer({ min: 1, max: 4096 }),
});

interface ValidInput {
  readonly gameId: string;
  readonly gameVersion: string;
  readonly engineMajor: number;
  readonly engineMinor: number;
  readonly enginePatch: number;
  readonly createdAtUnixMs: number;
  readonly storedPayload: Uint8Array;
  readonly deflated: boolean;
  readonly uncompressedBytes: number;
}

function buildHeader(input: ValidInput): SaveHeader {
  return createSaveHeader({
    engineVersion: `${input.engineMajor}.${input.engineMinor}.${input.enginePatch}`,
    gameId: input.gameId,
    gameVersion: input.gameVersion,
    createdAtUnixMs: input.createdAtUnixMs,
    storedPayload: input.storedPayload,
    flags: input.deflated ? SAVE_FLAG_DEFLATE : 0,
    payloadUncompressedBytes: input.deflated ? input.uncompressedBytes : 0,
  });
}

function headersEqual(left: SaveHeader, right: SaveHeader): boolean {
  return (
    left.formatVersion === right.formatVersion &&
    left.engineMajor === right.engineMajor &&
    left.engineMinor === right.engineMinor &&
    left.enginePatch === right.enginePatch &&
    left.gameId === right.gameId &&
    left.gameVersion === right.gameVersion &&
    left.createdAtUnixSeconds === right.createdAtUnixSeconds &&
    left.payloadBytes === right.payloadBytes &&
    left.payloadUncompressedBytes === right.payloadUncompressedBytes &&
    left.payloadHash === right.payloadHash &&
    left.flags === right.flags
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function requireSaveError(error: unknown): SaveEngineError {
  if (!(error instanceof SaveEngineError)) {
    throw new Error(`non-save error escaped: ${String(error)}`);
  }
  if (!SAVE_CODES.has(error.code)) {
    throw new Error(`unexpected save code: ${String(error.code)}`);
  }
  return error;
}

test("[ER-15-03] 10,000 generated headers round-trip through the header and file codecs", () => {
  fc.assert(
    fc.property(VALID_INPUT, (input) => {
      const header = buildHeader(input);
      const encoded = encodeSaveHeader(header);

      if (encoded.length < 48 || encoded.length > SAVE_HEADER_MAX_BYTES) {
        throw new Error(
          `encoded header length ${encoded.length} is out of range`,
        );
      }
      if (encoded.length % 8 !== 0) {
        throw new Error(
          `encoded header length ${encoded.length} is not aligned`,
        );
      }

      const decoded = decodeSaveHeader(encoded);
      if (!headersEqual(decoded, header)) {
        throw new Error("decodeSaveHeader did not reproduce the header");
      }
      if (toHex(encodeSaveHeader(decoded)) !== toHex(encoded)) {
        throw new Error("header re-encode is not byte-identical");
      }

      const file = encodeSaveFile(header, input.storedPayload);
      if (file.length !== encoded.length + input.storedPayload.length) {
        throw new Error("encoded file length is not header + payload");
      }

      const decodedFile = decodeSaveFile(file);
      if (!headersEqual(decodedFile.header, header)) {
        throw new Error("decodeSaveFile did not reproduce the header");
      }
      if (!bytesEqual(decodedFile.storedPayload, input.storedPayload)) {
        throw new Error("decodeSaveFile did not reproduce the payload");
      }
      if (
        toHex(encodeSaveFile(decodedFile.header, decodedFile.storedPayload)) !==
        toHex(file)
      ) {
        throw new Error("file re-encode is not byte-identical");
      }

      if (input.deflated) {
        if (header.flags !== SAVE_FLAG_DEFLATE) {
          throw new Error("deflate flag was not preserved");
        }
        if (header.payloadUncompressedBytes !== input.uncompressedBytes) {
          throw new Error("uncompressed length was not preserved");
        }
      } else if (header.payloadUncompressedBytes !== 0) {
        throw new Error("uncompressed length must be zero without deflate");
      }
    }),
    { numRuns: 10_000 },
  );
});

test("[ER-15-03] random single-bit mutations either throw a save code or re-encode identically", () => {
  fc.assert(
    fc.property(
      VALID_INPUT,
      fc.nat(),
      fc.integer({ min: 0, max: 7 }),
      (input, seed, bit) => {
        const header = buildHeader(input);
        const file = encodeSaveFile(header, input.storedPayload);
        if (file.length === 0) throw new Error("a save file is never empty");

        const offset = seed % file.length;
        const corrupted = file.slice();
        corrupted[offset] = (corrupted[offset] ?? 0) ^ (1 << bit);

        if (toHex(corrupted) === toHex(file)) {
          throw new Error("mutation did not change the file");
        }

        let failure: unknown;
        let decoded: ReturnType<typeof decodeSaveFile> | undefined;
        try {
          decoded = decodeSaveFile(corrupted);
        } catch (error) {
          failure = error;
        }

        if (failure !== undefined) {
          requireSaveError(failure);
          return;
        }
        if (decoded === undefined) {
          throw new Error("decodeSaveFile neither returned nor threw");
        }

        const reencoded = encodeSaveFile(decoded.header, decoded.storedPayload);
        if (toHex(reencoded) !== toHex(corrupted)) {
          throw new Error(
            "a successful decode must re-encode to the same bytes",
          );
        }
      },
    ),
    { numRuns: 10_000 },
  );
});

test("[ER-15-03] arbitrary byte strings never escape as non-save errors", () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 160 }), (bytes) => {
      try {
        decodeSaveHeader(bytes);
      } catch (error) {
        requireSaveError(error);
      }
      try {
        decodeSaveFile(bytes);
      } catch (error) {
        requireSaveError(error);
      }
    }),
    { numRuns: 10_000 },
  );
});

test("[ER-15-03] every truncation of a valid file is E_SAVE_FORMAT", () => {
  fc.assert(
    fc.property(VALID_INPUT, fc.nat(), (input, seed) => {
      const header = buildHeader(input);
      const file = encodeSaveFile(header, input.storedPayload);
      const cut = seed % file.length;
      const truncated = file.subarray(0, cut);

      let failure: unknown;
      try {
        decodeSaveFile(truncated);
      } catch (error) {
        failure = error;
      }

      if (failure === undefined) {
        throw new Error(`a ${cut}-byte prefix decoded as a complete file`);
      }

      const saveError = requireSaveError(failure);
      if (saveError.code !== "E_SAVE_FORMAT") {
        throw new Error(
          `truncation returned ${saveError.code} instead of E_SAVE_FORMAT`,
        );
      }
    }),
    { numRuns: 2_000 },
  );
});

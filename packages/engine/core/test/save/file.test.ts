/**
 * Whole-file refusal tests (15 §7, ER-15-01/02/05/06).
 *
 * Every malformed file is synthesized in memory from the synthetic fixture.
 * `decodeSaveFile` must refuse it as a unit, with the specified code, without
 * mutating the input. Store-level behaviours (listing, quotas, crash safety)
 * are M1 and are not tested here.
 */

import { expect, test } from "vitest";
import {
  createSaveHeader,
  decodeSaveFile,
  decodeSaveHeader,
  encodeSaveFile,
  encodeSaveHeader,
  SAVE_FLAG_DEFLATE,
  SAVE_MAX_PAYLOAD_BYTES,
} from "../../src/save/index.js";
import {
  createFixtureHeader,
  expectSaveError,
  loadFixture,
  toHex,
  withByte,
  withUint16,
  withUint32,
} from "./helpers.js";

const UINT16_MAX = 0xffff;

test("[ER-15-02] every truncated prefix of the fixture is refused as E_SAVE_FORMAT", () => {
  const { file } = loadFixture();
  for (const length of [0, 1, 3, 4, 39, 40, 55, 56, 84]) {
    const error = expectSaveError(() =>
      decodeSaveFile(file.subarray(0, length)),
    );
    expect(error.code, `length ${length}`).toBe("E_SAVE_FORMAT");
  }
});

test("[ER-15-02] each bad magic byte is refused as E_SAVE_FORMAT", () => {
  const { file } = loadFixture();
  for (let offset = 0; offset < 4; offset += 1) {
    for (const value of [0x00, 0xff]) {
      const error = expectSaveError(() =>
        decodeSaveFile(withByte(file, offset, value)),
      );
      expect(error.code, `magic byte ${offset} = ${value}`).toBe(
        "E_SAVE_FORMAT",
      );
    }
  }

  // The magic check precedes the version check.
  const badMagicNewer = withByte(withUint16(file, 4, 2), 0, 0x00);
  expect(expectSaveError(() => decodeSaveFile(badMagicNewer)).code).toBe(
    "E_SAVE_FORMAT",
  );
});

test("[ER-15-02] bad headerBytes values are refused as E_SAVE_FORMAT", () => {
  const { file } = loadFixture();
  for (const [label, value] of [
    ["below the prefix", 32],
    ["not minimal at 40", 40],
    ["not minimal at 48", 48],
    ["not a multiple of 8", 49],
    ["not minimal at 64", 64],
    ["not minimal at 72", 72],
    ["past the file length", 144],
    ["above the maximum", 152],
  ] as const) {
    const error = expectSaveError(() =>
      decodeSaveFile(withUint16(file, 6, value)),
    );
    expect(error.code, label).toBe("E_SAVE_FORMAT");
  }
});

test("[ER-15-02] out-of-range header fields are refused as E_SAVE_FORMAT", () => {
  const { file } = loadFixture();
  const cases: ReadonlyArray<
    readonly [label: string, mutated: Uint8Array]
  > = [
    ["gameIdBytes 0", withUint16(file, 22, 0)],
    ["gameIdBytes 65", withUint16(file, 22, 65)],
    ["gameVersionBytes 0", withUint16(file, 24, 0)],
    ["gameVersionBytes 33", withUint16(file, 24, 33)],
    [
      "payloadBytes over 32 MiB",
      withUint32(file, 8, SAVE_MAX_PAYLOAD_BYTES + 1),
    ],
    ["reserved field non-zero", withUint32(file, 36, 1)],
    ["reserved flag bit", withUint16(file, 26, 0b10)],
    ["reserved flag bit 15", withUint16(file, 26, 0x8000)],
    ["all flag bits", withUint16(file, 26, UINT16_MAX)],
    ["non-zero padding", withByte(file, 55, 1)],
    ["uncompressed bytes with deflate clear", withUint32(file, 32, 5)],
    [
      "deflate flag with zero uncompressed bytes",
      withUint32(withUint16(file, 26, SAVE_FLAG_DEFLATE), 32, 0),
    ],
    [
      "deflate with uncompressed over 64 MiB",
      withUint32(
        withUint16(file, 26, SAVE_FLAG_DEFLATE),
        32,
        64 * 1024 * 1024 + 1,
      ),
    ],
  ];

  for (const [label, mutated] of cases) {
    const error = expectSaveError(() => decodeSaveFile(mutated));
    expect(error.code, label).toBe("E_SAVE_FORMAT");
  }
});

test("[ER-15-02] invalid string bytes are refused as E_SAVE_FORMAT", () => {
  const { file } = loadFixture();
  const cases: ReadonlyArray<
    readonly [label: string, mutated: Uint8Array]
  > = [
    ["invalid UTF-8 in gameId", withByte(file, 40, 0xff)],
    ["NUL in gameId", withByte(file, 40, 0x00)],
    ["slash in gameId", withByte(file, 40, 0x2f)],
    ["invalid UTF-8 in gameVersion", withByte(file, 50, 0xc3)],
    ["NUL in gameVersion", withByte(file, 50, 0x00)],
  ];

  for (const [label, mutated] of cases) {
    const error = expectSaveError(() => decodeSaveFile(mutated));
    expect(error.code, label).toBe("E_SAVE_FORMAT");
  }
});

test("[ER-15-02] trailing bytes, truncated payloads and lying lengths are refused", () => {
  const { file, json } = loadFixture();

  const trailing = new Uint8Array(file.length + 1);
  trailing.set(file);
  expect(expectSaveError(() => decodeSaveFile(trailing)).code).toBe(
    "E_SAVE_FORMAT",
  );

  expect(
    expectSaveError(() =>
      decodeSaveFile(file.subarray(0, file.length - 1)),
    ).code,
  ).toBe("E_SAVE_FORMAT");

  // One extra byte plus a matching payloadBytes claim passes the structural
  // checks, so the FNV comparison is what refuses it.
  const extended = new Uint8Array(file.length + 1);
  extended.set(withUint32(file, 8, json.payloadBytes + 1));
  expect(expectSaveError(() => decodeSaveFile(extended)).code).toBe(
    "E_SAVE_HASH",
  );

  const shortened = withUint32(
    file.subarray(0, file.length - 1),
    8,
    json.payloadBytes - 1,
  );
  expect(expectSaveError(() => decodeSaveFile(shortened)).code).toBe(
    "E_SAVE_HASH",
  );
});

test("[ER-15-06] every single-bit flip in the fixture payload is E_SAVE_HASH and leaves the file untouched", () => {
  const { file, json } = loadFixture();
  const before = toHex(file);

  for (let offset = json.headerBytes; offset < file.length; offset += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const corrupted = withByte(
        file,
        offset,
        (file[offset] ?? 0) ^ (1 << bit),
      );
      const error = expectSaveError(() => decodeSaveFile(corrupted));
      expect(error.code, `payload byte ${offset} bit ${bit}`).toBe(
        "E_SAVE_HASH",
      );
    }
  }

  expect(toHex(file)).toBe(before);

  const headerCopy = file.slice(0, json.headerBytes);
  const decodedHeader = decodeSaveHeader(headerCopy);
  expect(decodedHeader.payloadHash).toBe(json.payloadHash);
  expect(toHex(headerCopy)).toBe(toHex(file.subarray(0, json.headerBytes)));
});

test("[ER-15-06] every single-bit flip in a 64-byte payload is E_SAVE_HASH", () => {
  const payload = new Uint8Array(64);
  const header = createSaveHeader({
    engineVersion: "0.1.0",
    gameId: "corrupt-check",
    gameVersion: "1.0.0",
    createdAtUnixMs: 0,
    storedPayload: payload,
  });
  const file = encodeSaveFile(header, payload);
  const headerBytes = encodeSaveHeader(header).length;

  for (let offset = headerBytes; offset < file.length; offset += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const corrupted = withByte(
        file,
        offset,
        (file[offset] ?? 0) ^ (1 << bit),
      );
      const error = expectSaveError(() => decodeSaveFile(corrupted));
      expect(error.code, `payload byte ${offset} bit ${bit}`).toBe(
        "E_SAVE_HASH",
      );
    }
  }
});

test("[ER-15-06] a corrupted header hash field is E_SAVE_HASH", () => {
  const { file, json } = loadFixture();
  for (let offset = 12; offset < 16; offset += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      const corrupted = withByte(
        file,
        offset,
        (file[offset] ?? 0) ^ (1 << bit),
      );
      const error = expectSaveError(() => decodeSaveFile(corrupted));
      expect(error.code, `hash byte ${offset} bit ${bit}`).toBe("E_SAVE_HASH");
    }
  }
  expect(decodeSaveHeader(file).payloadHash).toBe(json.payloadHash);
});

test("[ER-15-05] the version check runs before payload verification and never rewrites the file", () => {
  const { file } = loadFixture();

  // A file that is both newer and corrupted must report the version.
  const newerAndCorrupt = withByte(withUint16(file, 4, 2), 56, 0xff);
  const before = toHex(newerAndCorrupt);
  expect(expectSaveError(() => decodeSaveFile(newerAndCorrupt)).code).toBe(
    "E_SAVE_VERSION",
  );
  expect(expectSaveError(() => decodeSaveHeader(newerAndCorrupt)).code).toBe(
    "E_SAVE_VERSION",
  );
  expect(toHex(newerAndCorrupt)).toBe(before);
});

test("[ER-15-01] a deflate-flagged synthetic file round-trips", () => {
  const storedPayload = new TextEncoder().encode("not-actually-deflated");
  const header = createSaveHeader({
    engineVersion: "2.3.4",
    gameId: "harbor-run",
    gameVersion: "9.9.9",
    createdAtUnixMs: 1_792_627_200_000,
    storedPayload,
    flags: SAVE_FLAG_DEFLATE,
    payloadUncompressedBytes: 4096,
  });
  expect(header.flags).toBe(1);
  expect(header.payloadUncompressedBytes).toBe(4096);

  const file = encodeSaveFile(header, storedPayload);
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  expect(view.getUint16(26, true)).toBe(SAVE_FLAG_DEFLATE);
  expect(view.getUint32(32, true)).toBe(4096);

  const decoded = decodeSaveFile(file);
  expect(decoded.header).toEqual(header);
  expect(decoded.storedPayload).toEqual(storedPayload);
  expect(toHex(encodeSaveFile(decoded.header, decoded.storedPayload))).toBe(
    toHex(file),
  );
});

test("[ER-15-02] non-byte decoder inputs are refused as E_SAVE_FORMAT", () => {
  for (const value of [null, "bytes", 42, [1, 2, 3], { length: 85 }]) {
    const input = value as unknown as Uint8Array;
    expect(expectSaveError(() => decodeSaveHeader(input)).code).toBe(
      "E_SAVE_FORMAT",
    );
    expect(expectSaveError(() => decodeSaveFile(input)).code).toBe(
      "E_SAVE_FORMAT",
    );
  }
});

test("[ER-15-01] encodeSaveFile concatenates exactly header then payload", () => {
  const fixture = loadFixture();
  const header = createFixtureHeader(fixture.json, fixture.storedPayload);
  const encodedHeader = encodeSaveHeader(header);

  const file = encodeSaveFile(header, fixture.storedPayload);
  expect(file.subarray(0, encodedHeader.length)).toEqual(encodedHeader);
  expect(file.subarray(encodedHeader.length)).toEqual(fixture.storedPayload);

  const emptyHeader = createSaveHeader({
    engineVersion: "0.1.0",
    gameId: "harbor-run",
    gameVersion: "1.2.0",
    createdAtUnixMs: 0,
    storedPayload: new Uint8Array(0),
  });
  const empty = encodeSaveFile(emptyHeader, new Uint8Array(0));
  expect(empty.length).toBe(encodeSaveHeader(emptyHeader).length);
});

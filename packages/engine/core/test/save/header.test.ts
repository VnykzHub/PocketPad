/**
 * Save header and whole-file codec tests (15 §7, ER-15-01/02/04/05/11).
 *
 * Node 20, no storage. The fixture is synthetic (15 §4.9); hashes are asserted
 * against the published values in 15 §4.6/§4.10, never against the codec's own
 * output alone.
 *
 * Spec note: ER-15-01 names `headerBytes` 40 and 144 as round-trip boundaries,
 * but 00 §4.5 defines `headerBytes` as 40 + gameIdBytes + gameVersionBytes
 * padded to 8 with both lengths at least 1. The reachable range is therefore
 * 48..136; 40 and 144 cannot be produced legally and are asserted to be
 * refused as non-minimal/inconsistent. 00 wins per the task rules.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import type { SaveHeader } from "../../src/contracts/save.js";
import {
  createSaveHeader,
  decodeSaveFile,
  decodeSaveHeader,
  encodeSaveFile,
  encodeSaveHeader,
  fnv1a32,
  SAVE_DEFAULT_MAX_SLOTS,
  SAVE_FLAG_DEFLATE,
  SAVE_FLAGS_RESERVED_MASK,
  SAVE_FORMAT_VERSION,
  SAVE_GAME_ID_PATTERN,
  SAVE_HEADER_BYTES,
  SAVE_HEADER_MAX_BYTES,
  SAVE_HEADER_PREFIX_BYTES,
  SAVE_MAGIC,
  SAVE_MAX_GAME_ID_BYTES,
  SAVE_MAX_GAME_VERSION_BYTES,
  SAVE_MAX_PAYLOAD_BYTES,
  SAVE_MAX_UNCOMPRESSED_BYTES,
  SAVE_SLOT_ID_PATTERN,
  type CreateSaveHeaderInput,
} from "../../src/save/index.js";
import {
  createFixtureHeader,
  expectSaveError,
  loadFixture,
  toHex,
  withUint16,
  withUint32,
} from "./helpers.js";

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

const BASE_INPUT: CreateSaveHeaderInput = {
  engineVersion: "0.1.0",
  gameId: "harbor-run",
  gameVersion: "1.2.0",
  createdAtUnixMs: 1_792_627_200_000,
  storedPayload: new Uint8Array([1, 2, 3]),
};

test("[ER-15-01] the synthetic header encodes to the 85-byte fixture and decodes to the same fields", () => {
  const fixture = loadFixture();
  const { json } = fixture;

  const header = createFixtureHeader(json, fixture.storedPayload);

  expect(header).toEqual({
    formatVersion: json.formatVersion,
    engineMajor: json.engineMajor,
    engineMinor: json.engineMinor,
    enginePatch: json.enginePatch,
    gameId: json.gameId,
    gameVersion: json.gameVersion,
    createdAtUnixSeconds: json.createdAtUnixSeconds,
    payloadBytes: json.payloadBytes,
    payloadUncompressedBytes: json.payloadUncompressedBytes,
    payloadHash: json.payloadHash,
    flags: json.flags,
  });
  expect(header.payloadHash).toBe(0x635f8bc4);
  expect(header.payloadBytes).toBe(fixture.storedPayload.length);

  const encodedHeader = encodeSaveHeader(header);
  expect(encodedHeader).toEqual(fixture.headerBytes);

  const encodedFile = encodeSaveFile(header, fixture.storedPayload);
  expect(encodedFile.length).toBe(85);
  expect(toHex(encodedFile)).toBe(toHex(fixture.file));

  expect(decodeSaveHeader(fixture.file)).toEqual(header);
  expect(decodeSaveHeader(fixture.headerBytes)).toEqual(header);

  const decoded = decodeSaveFile(fixture.file);
  expect(decoded.header).toEqual(header);
  expect(decoded.storedPayload).toEqual(fixture.storedPayload);

  const reencoded = encodeSaveFile(decoded.header, decoded.storedPayload);
  expect(toHex(reencoded)).toBe(toHex(fixture.file));
});

test("[ER-15-01] header length, zero padding and SHA-256 metadata match the fixture", () => {
  const fixture = loadFixture();
  const { json, file, storedPayload } = fixture;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);

  const gameIdBytes = new TextEncoder().encode(json.gameId);
  const gameVersionBytes = new TextEncoder().encode(json.gameVersion);
  const expectedHeaderBytes = Math.ceil(
    (SAVE_HEADER_BYTES + gameIdBytes.length + gameVersionBytes.length) / 8,
  ) * 8;

  expect(expectedHeaderBytes).toBe(56);
  expect(json.headerBytes).toBe(expectedHeaderBytes);
  expect(file.length).toBe(json.headerBytes + json.payloadBytes);
  expect(json.paddingBytes).toBe(
    json.headerBytes -
      SAVE_HEADER_BYTES -
      gameIdBytes.length -
      gameVersionBytes.length,
  );

  expect(view.getUint16(6, true)).toBe(json.headerBytes);
  expect(new TextDecoder().decode(file.subarray(0, 4))).toBe("PPSV");
  expect(view.getUint16(4, true)).toBe(1);
  expect(view.getUint32(8, true)).toBe(json.payloadBytes);
  expect(view.getUint32(12, true)).toBe(json.payloadHash);
  expect(view.getUint16(16, true)).toBe(json.engineMajor);
  expect(view.getUint16(18, true)).toBe(json.engineMinor);
  expect(view.getUint16(20, true)).toBe(json.enginePatch);
  expect(view.getUint16(22, true)).toBe(gameIdBytes.length);
  expect(view.getUint16(24, true)).toBe(gameVersionBytes.length);
  expect(view.getUint16(26, true)).toBe(json.flags);
  expect(view.getUint32(28, true)).toBe(json.createdAtUnixSeconds);
  expect(view.getUint32(32, true)).toBe(json.payloadUncompressedBytes);
  expect(view.getUint32(36, true)).toBe(json.reserved);

  expect(file.subarray(40, 40 + gameIdBytes.length)).toEqual(gameIdBytes);
  expect(
    file.subarray(
      40 + gameIdBytes.length,
      40 + gameIdBytes.length + gameVersionBytes.length,
    ),
  ).toEqual(gameVersionBytes);
  for (
    let index = 40 + gameIdBytes.length + gameVersionBytes.length;
    index < json.headerBytes;
    index += 1
  ) {
    expect(file[index]).toBe(0);
  }

  expect(new TextEncoder().encode(json.payloadText)).toEqual(storedPayload);
  expect(createHash("sha256").update(storedPayload).digest("hex")).toBe(
    json.payloadSha256,
  );
  expect(json.payloadSha256).toBe(
    "b090e151095888be944ad76325de802ac690ab1967ab44ad4ee3e1a4c85c4895",
  );
});

test("[ER-15-04] FNV-1a 32 matches the published vectors and changes on a one-byte edit", () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  expect(fnv1a32(new Uint8Array(0))).toBe(0x811c9dc5);
  expect(fnv1a32(encode("a"))).toBe(0xe40c292c);
  expect(fnv1a32(encode("foobar"))).toBe(0xbf9cf968);
  expect(fnv1a32(encode("hello"))).toBe(0x4f9f2cab);

  const { storedPayload } = loadFixture();
  expect(fnv1a32(storedPayload)).toBe(0x635f8bc4);

  for (let index = 0; index < storedPayload.length; index += 1) {
    const changed = storedPayload.slice();
    changed[index] = (changed[index] ?? 0) ^ 0x01;
    const hash = fnv1a32(changed);
    expect(hash).not.toBe(0x635f8bc4);
    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(UINT32_MAX);
  }
});

test("[ER-15-04] fnv1a32 refuses a non-byte input", () => {
  const error = expectSaveError(() =>
    fnv1a32("not bytes" as unknown as Uint8Array),
  );
  expect(error.code).toBe("E_SAVE_FORMAT");
});

test("[ER-15-01] game id and game version byte limits round-trip at headerBytes 48 and 136", () => {
  const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);

  const shortest = createSaveHeader({
    ...BASE_INPUT,
    gameId: "a",
    gameVersion: "1",
    storedPayload: payload,
  });
  const shortBytes = encodeSaveHeader(shortest);
  expect(shortBytes.length).toBe(48);
  expect(decodeSaveHeader(shortBytes)).toEqual(shortest);

  const longest = createSaveHeader({
    ...BASE_INPUT,
    gameId: "g".repeat(SAVE_MAX_GAME_ID_BYTES),
    gameVersion: "v".repeat(SAVE_MAX_GAME_VERSION_BYTES),
    storedPayload: payload,
  });
  const longBytes = encodeSaveHeader(longest);
  expect(longBytes.length).toBe(136);
  expect(decodeSaveHeader(longBytes)).toEqual(longest);

  const shortFile = encodeSaveFile(shortest, payload);
  const longFile = encodeSaveFile(longest, payload);
  expect(shortFile.length).toBe(48 + payload.length);
  expect(longFile.length).toBe(136 + payload.length);
  expect(decodeSaveFile(shortFile).header).toEqual(shortest);
  expect(decodeSaveFile(longFile).header).toEqual(longest);
});

test("[ER-15-02] headerBytes 40, 49, 64 and 144 are refused", () => {
  // 40/144 are ER-15-01's stated boundaries but unreachable under 00 §4.5
  // (both strings are at least one byte), so they are malformed inputs.
  const { storedPayload, json } = loadFixture();
  const header = createFixtureHeader(json, storedPayload);
  const bytes = encodeSaveHeader(header);

  for (const [label, value] of [
    ["40 is not minimal", 40],
    ["49 is not a multiple of 8", 49],
    ["64 is not minimal", 64],
    ["144 is beyond the input", 144],
  ] as const) {
    const error = expectSaveError(() =>
      decodeSaveHeader(withUint16(bytes, 6, value)),
    );
    expect(error.code, label).toBe("E_SAVE_FORMAT");
  }

  const longHeader = createSaveHeader({
    ...BASE_INPUT,
    gameId: "g".repeat(SAVE_MAX_GAME_ID_BYTES),
    gameVersion: "v".repeat(SAVE_MAX_GAME_VERSION_BYTES),
    storedPayload,
  });
  const longBytes = encodeSaveHeader(longHeader);
  expect(longBytes.length).toBe(136);
  const nonMinimal = expectSaveError(() =>
    decodeSaveHeader(withUint16(longBytes, 6, 128)),
  );
  expect(nonMinimal.code).toBe("E_SAVE_FORMAT");
});

test("[ER-15-01] a zero-byte payload round-trips with the FNV offset basis", () => {
  const header = createSaveHeader({
    ...BASE_INPUT,
    storedPayload: new Uint8Array(0),
  });
  expect(header.payloadBytes).toBe(0);
  expect(header.payloadHash).toBe(0x811c9dc5);

  const file = encodeSaveFile(header, new Uint8Array(0));
  expect(file.length).toBe(encodeSaveHeader(header).length);
  const decoded = decodeSaveFile(file);
  expect(decoded.header).toEqual(header);
  expect(decoded.storedPayload.length).toBe(0);
});

test("[ER-15-01] a 32 MiB payload round-trips at the cap", () => {
  const payload = new Uint8Array(SAVE_MAX_PAYLOAD_BYTES);
  payload[0] = 0x50;
  payload[payload.length - 1] = 0x56;

  const header = createSaveHeader({ ...BASE_INPUT, storedPayload: payload });
  expect(header.payloadBytes).toBe(32 * 1024 * 1024);

  const file = encodeSaveFile(header, payload);
  const decoded = decodeSaveFile(file);
  expect(decoded.header).toEqual(header);
  expect(decoded.storedPayload.length).toBe(payload.length);
  expect(decoded.storedPayload[0]).toBe(0x50);
  expect(decoded.storedPayload[decoded.storedPayload.length - 1]).toBe(0x56);
  expect(fnv1a32(decoded.storedPayload)).toBe(header.payloadHash);
});

test("[ER-15-02] a payload one byte over 32 MiB is refused", () => {
  const oversized = new Uint8Array(SAVE_MAX_PAYLOAD_BYTES + 1);
  const error = expectSaveError(() =>
    createSaveHeader({ ...BASE_INPUT, storedPayload: oversized }),
  );
  expect(error.code).toBe("E_SAVE_FORMAT");
});

test("[ER-15-01] flags 0/1 and the u32 timestamp bounds round-trip", () => {
  const raw = createSaveHeader({ ...BASE_INPUT, flags: 0 });
  expect(raw.flags).toBe(0);
  expect(decodeSaveHeader(encodeSaveHeader(raw))).toEqual(raw);

  const deflated = createSaveHeader({
    ...BASE_INPUT,
    flags: SAVE_FLAG_DEFLATE,
    payloadUncompressedBytes: 100,
  });
  expect(deflated.flags).toBe(1);
  expect(deflated.payloadUncompressedBytes).toBe(100);
  expect(decodeSaveHeader(encodeSaveHeader(deflated))).toEqual(deflated);

  const timestamp = (createdAtUnixMs: number) =>
    createSaveHeader({ ...BASE_INPUT, createdAtUnixMs }).createdAtUnixSeconds;

  expect(timestamp(0)).toBe(0);
  expect(timestamp(999)).toBe(0);
  expect(timestamp(1_500)).toBe(1);
  expect(timestamp(UINT32_MAX * 1000 + 999)).toBe(UINT32_MAX);
  // Beyond u32 seconds the writer clamps instead of wrapping.
  expect(timestamp(UINT32_MAX * 1000 + 1000)).toBe(UINT32_MAX);
  expect(timestamp(-1_000)).toBe(0);
});

test("[ER-15-01] runtime constants equal the frozen contract declarations", () => {
  expect(SAVE_FORMAT_VERSION).toBe(1);
  expect(SAVE_MAGIC).toBe("PPSV");
  expect(SAVE_HEADER_BYTES).toBe(40);
  expect(SAVE_HEADER_PREFIX_BYTES).toBe(40);
  expect(SAVE_HEADER_MAX_BYTES).toBe(144);
  expect(SAVE_MAX_GAME_ID_BYTES).toBe(64);
  expect(SAVE_MAX_GAME_VERSION_BYTES).toBe(32);
  expect(SAVE_MAX_PAYLOAD_BYTES).toBe(32 * 1024 * 1024);
  expect(SAVE_MAX_UNCOMPRESSED_BYTES).toBe(64 * 1024 * 1024);
  expect(SAVE_DEFAULT_MAX_SLOTS).toBe(32);
  expect(SAVE_FLAG_DEFLATE).toBe(0b0000_0000_0000_0001);
  expect(SAVE_FLAGS_RESERVED_MASK).toBe(0b1111_1111_1111_1110);

  // The patterns are non-global, so repeated tests cannot carry `lastIndex`.
  expect(SAVE_SLOT_ID_PATTERN.test("slot-01")).toBe(true);
  expect(SAVE_GAME_ID_PATTERN.test("harbor-run")).toBe(true);
});

test("[ER-15-02] slot and game id patterns reject traversal and illegal shapes", () => {
  for (const accepted of ["a", "0", "slot-01", "a_b", "a".repeat(32)]) {
    expect(SAVE_SLOT_ID_PATTERN.test(accepted), accepted).toBe(true);
  }
  for (const rejected of [
    "",
    "A",
    "-slot",
    "_slot",
    "slot/01",
    "slot.01",
    "slot 01",
    "a".repeat(33),
    "../slot",
  ]) {
    expect(SAVE_SLOT_ID_PATTERN.test(rejected), rejected).toBe(false);
  }

  for (const accepted of ["a", "harbor-run", "a1-b2"]) {
    expect(SAVE_GAME_ID_PATTERN.test(accepted), accepted).toBe(true);
  }
  for (const rejected of [
    "",
    "Harbor",
    "-harbor",
    "_harbor",
    "harbor/run",
    "harbor_run",
    "harbor run",
  ]) {
    expect(SAVE_GAME_ID_PATTERN.test(rejected), rejected).toBe(false);
  }
});

test("[ER-15-02] createSaveHeader refuses invalid ids, versions, flags and payload sizes", () => {
  const base = BASE_INPUT;
  const cases: ReadonlyArray<
    readonly [label: string, run: () => unknown]
  > = [
    ["empty gameId", () => createSaveHeader({ ...base, gameId: "" })],
    [
      "65-byte gameId",
      () => createSaveHeader({ ...base, gameId: "g".repeat(65) }),
    ],
    [
      "multibyte gameId over 64 bytes",
      () => createSaveHeader({ ...base, gameId: "é".repeat(33) }),
    ],
    [
      "gameId with NUL",
      () => createSaveHeader({ ...base, gameId: "harbor\u0000run" }),
    ],
    [
      "gameId with slash",
      () => createSaveHeader({ ...base, gameId: "harbor/run" }),
    ],
    [
      "gameId with lone surrogate",
      () => createSaveHeader({ ...base, gameId: "harbor\uD800run" }),
    ],
    ["empty gameVersion", () => createSaveHeader({ ...base, gameVersion: "" })],
    [
      "33-byte gameVersion",
      () => createSaveHeader({ ...base, gameVersion: "v".repeat(33) }),
    ],
    [
      "gameVersion with NUL",
      () => createSaveHeader({ ...base, gameVersion: "1\u00002" }),
    ],
    [
      "two-part engineVersion",
      () => createSaveHeader({ ...base, engineVersion: "1.2" }),
    ],
    [
      "four-part engineVersion",
      () => createSaveHeader({ ...base, engineVersion: "1.2.3.4" }),
    ],
    [
      "non-numeric engineVersion",
      () => createSaveHeader({ ...base, engineVersion: "1.x.3" }),
    ],
    [
      "u16 overflow engineVersion",
      () => createSaveHeader({ ...base, engineVersion: "70000.0.0" }),
    ],
    [
      "non-string engineVersion",
      () =>
        createSaveHeader({
          ...base,
          engineVersion: 1.2 as unknown as string,
        }),
    ],
    [
      "NaN timestamp",
      () => createSaveHeader({ ...base, createdAtUnixMs: Number.NaN }),
    ],
    [
      "infinite timestamp",
      () =>
        createSaveHeader({
          ...base,
          createdAtUnixMs: Number.POSITIVE_INFINITY,
        }),
    ],
    [
      "reserved flag bit 1",
      () => createSaveHeader({ ...base, flags: 0b10 }),
    ],
    [
      "reserved flag bit 15",
      () => createSaveHeader({ ...base, flags: 0x8000 }),
    ],
    [
      "uncompressed bytes with deflate clear",
      () =>
        createSaveHeader({
          ...base,
          flags: 0,
          payloadUncompressedBytes: 1,
        }),
    ],
    [
      "deflate flag without uncompressed bytes",
      () => createSaveHeader({ ...base, flags: SAVE_FLAG_DEFLATE }),
    ],
    [
      "deflate flag with zero uncompressed bytes",
      () =>
        createSaveHeader({
          ...base,
          flags: SAVE_FLAG_DEFLATE,
          payloadUncompressedBytes: 0,
        }),
    ],
    [
      "uncompressed bytes over 64 MiB",
      () =>
        createSaveHeader({
          ...base,
          flags: SAVE_FLAG_DEFLATE,
          payloadUncompressedBytes: SAVE_MAX_UNCOMPRESSED_BYTES + 1,
        }),
    ],
    [
      "non-byte payload",
      () =>
        createSaveHeader({
          ...base,
          storedPayload: null as unknown as Uint8Array,
        }),
    ],
  ];

  for (const [label, run] of cases) {
    const error = expectSaveError(run);
    expect(error.code, label).toBe("E_SAVE_FORMAT");
  }

  // gameVersion only forbids NUL; a slash is legal and must round-trip.
  const withSlash = createSaveHeader({ ...base, gameVersion: "release/1" });
  expect(decodeSaveHeader(encodeSaveHeader(withSlash)).gameVersion).toBe(
    "release/1",
  );
});

test("[ER-15-02] encodeSaveHeader refuses invalid header fields", () => {
  const fixture = loadFixture();
  const header = createFixtureHeader(fixture.json, fixture.storedPayload);

  const invalid: ReadonlyArray<readonly [string, SaveHeader]> = [
    ["formatVersion 0", { ...header, formatVersion: 0 }],
    ["negative engineMajor", { ...header, engineMajor: -1 }],
    ["engineMinor over u16", { ...header, engineMinor: UINT16_MAX + 1 }],
    ["fractional enginePatch", { ...header, enginePatch: 1.5 }],
    ["empty gameId", { ...header, gameId: "" }],
    ["empty gameVersion", { ...header, gameVersion: "" }],
    [
      "payloadBytes over cap",
      { ...header, payloadBytes: SAVE_MAX_PAYLOAD_BYTES + 1 },
    ],
    ["negative payloadBytes", { ...header, payloadBytes: -1 }],
    ["payloadHash over u32", { ...header, payloadHash: UINT32_MAX + 1 }],
    ["negative payloadHash", { ...header, payloadHash: -1 }],
    ["negative timestamp", { ...header, createdAtUnixSeconds: -1 }],
    ["timestamp over u32", { ...header, createdAtUnixSeconds: UINT32_MAX + 1 }],
    ["reserved flag bits", { ...header, flags: 0b11 }],
    [
      "uncompressed bytes with deflate clear",
      { ...header, flags: 0, payloadUncompressedBytes: 5 },
    ],
    [
      "deflate flag with zero uncompressed bytes",
      { ...header, flags: SAVE_FLAG_DEFLATE, payloadUncompressedBytes: 0 },
    ],
    [
      "uncompressed bytes over 64 MiB",
      {
        ...header,
        flags: SAVE_FLAG_DEFLATE,
        payloadUncompressedBytes: SAVE_MAX_UNCOMPRESSED_BYTES + 1,
      },
    ],
  ];

  for (const [label, value] of invalid) {
    const error = expectSaveError(() => encodeSaveHeader(value));
    expect(error.code, label).toBe("E_SAVE_FORMAT");
  }
});

test("[ER-15-05] a newer format version is refused and the file stays byte-identical", () => {
  const fixture = loadFixture();
  const tampered = withUint16(fixture.file, 4, 2);
  const before = tampered.slice();

  const headerError = expectSaveError(() => decodeSaveHeader(tampered));
  expect(headerError.code).toBe("E_SAVE_VERSION");

  const fileError = expectSaveError(() => decodeSaveFile(tampered));
  expect(fileError.code).toBe("E_SAVE_VERSION");

  expect(toHex(tampered)).toBe(toHex(before));

  // formatVersion 0 has no migration step in M0. 15 §4.2 assigns
  // E_SAVE_FORMAT here; ER-15-05's E_SAVE_MIGRATION belongs to the M1
  // migration layer and is deferred.
  const zero = withUint16(fixture.file, 4, 0);
  const zeroError = expectSaveError(() => decodeSaveHeader(zero));
  expect(zeroError.code).toBe("E_SAVE_FORMAT");
});

test("[ER-15-11] a save for another game is refused with E_SAVE_GAME", () => {
  const fixture = loadFixture();

  const error = expectSaveError(() =>
    decodeSaveFile(fixture.file, "other-game"),
  );
  expect(error.code).toBe("E_SAVE_GAME");

  const decoded = decodeSaveFile(fixture.file, "harbor-run");
  expect(decoded.header.gameId).toBe("harbor-run");
  expect(decoded.storedPayload).toEqual(fixture.storedPayload);

  // The one-argument form performs no game comparison.
  expect(decodeSaveFile(fixture.file).header.gameId).toBe("harbor-run");
});

test("[ER-15-02] encodeSaveFile refuses a payload that does not match the header", () => {
  const fixture = loadFixture();
  const header = createFixtureHeader(fixture.json, fixture.storedPayload);

  const shorter = expectSaveError(() =>
    encodeSaveFile(header, fixture.storedPayload.slice(1)),
  );
  expect(shorter.code).toBe("E_SAVE_HASH");

  const longer = new Uint8Array(fixture.storedPayload.length + 1);
  longer.set(fixture.storedPayload);
  const extra = expectSaveError(() => encodeSaveFile(header, longer));
  expect(extra.code).toBe("E_SAVE_HASH");

  const sameLength = fixture.storedPayload.slice();
  sameLength[0] = (sameLength[0] ?? 0) ^ 0xff;
  const corrupted = expectSaveError(() => encodeSaveFile(header, sameLength));
  expect(corrupted.code).toBe("E_SAVE_HASH");

  const notBytes = expectSaveError(() =>
    encodeSaveFile(header, "payload" as unknown as Uint8Array),
  );
  expect(notBytes.code).toBe("E_SAVE_FORMAT");
});

test("[ER-15-01] the package entry exports every codec value", async () => {
  const entry = await import("../../src/index.js");

  expect(typeof entry.fnv1a32).toBe("function");
  expect(typeof entry.createSaveHeader).toBe("function");
  expect(typeof entry.encodeSaveHeader).toBe("function");
  expect(typeof entry.decodeSaveHeader).toBe("function");
  expect(typeof entry.encodeSaveFile).toBe("function");
  expect(typeof entry.decodeSaveFile).toBe("function");

  expect(entry.SAVE_FORMAT_VERSION).toBe(SAVE_FORMAT_VERSION);
  expect(entry.SAVE_MAGIC).toBe(SAVE_MAGIC);
  expect(entry.SAVE_HEADER_BYTES).toBe(SAVE_HEADER_BYTES);
  expect(entry.SAVE_HEADER_PREFIX_BYTES).toBe(SAVE_HEADER_PREFIX_BYTES);
  expect(entry.SAVE_HEADER_MAX_BYTES).toBe(SAVE_HEADER_MAX_BYTES);
  expect(entry.SAVE_MAX_GAME_ID_BYTES).toBe(SAVE_MAX_GAME_ID_BYTES);
  expect(entry.SAVE_MAX_GAME_VERSION_BYTES).toBe(SAVE_MAX_GAME_VERSION_BYTES);
  expect(entry.SAVE_MAX_PAYLOAD_BYTES).toBe(SAVE_MAX_PAYLOAD_BYTES);
  expect(entry.SAVE_MAX_UNCOMPRESSED_BYTES).toBe(SAVE_MAX_UNCOMPRESSED_BYTES);
  expect(entry.SAVE_DEFAULT_MAX_SLOTS).toBe(SAVE_DEFAULT_MAX_SLOTS);
  expect(entry.SAVE_FLAG_DEFLATE).toBe(SAVE_FLAG_DEFLATE);
  expect(entry.SAVE_FLAGS_RESERVED_MASK).toBe(SAVE_FLAGS_RESERVED_MASK);
  expect(entry.SAVE_SLOT_ID_PATTERN.source).toBe(SAVE_SLOT_ID_PATTERN.source);
  expect(entry.SAVE_GAME_ID_PATTERN.source).toBe(SAVE_GAME_ID_PATTERN.source);
});

test("[ER-15-01] a view into a larger buffer decodes identically", () => {
  const fixture = loadFixture();
  const header = createFixtureHeader(fixture.json, fixture.storedPayload);
  const padded = new Uint8Array(fixture.file.length + 64);
  padded.set(fixture.file);

  const decoded = decodeSaveFile(padded.subarray(0, fixture.file.length));
  expect(decoded.header).toEqual(header);

  const patchedLength = withUint32(fixture.file, 8, fixture.storedPayload.length);
  expect(toHex(patchedLength)).toBe(toHex(fixture.file));
});

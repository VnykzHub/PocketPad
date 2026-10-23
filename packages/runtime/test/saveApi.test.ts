/**
 * Host save/load API (spec 15) over the injected store.
 *
 * Every case runs in Node against the in-memory adapter, a Map-backed
 * localStorage double, a mock OPFS directory tree or `fake-indexeddb`: no
 * browser, no real clock, no network. The golden 85-byte fixture is the one
 * published in spec 15 §4.9, so a change to the frozen codec breaks this file
 * as well as the engine-core codec tests.
 *
 * Adapter note: production uses the spec 15 §5.5 tiers (OPFS with atomic
 * `move()`, IndexedDB fallback). OPFS and IndexedDB are exercised here with a
 * mock directory tree and `fake-indexeddb`; the real-browser rows
 * (ER-15-09/10/13/14) stay PENDING until measured on real hardware.
 */
import { afterEach, describe, expect, test } from "vitest";
import { IDBFactory as FakeIndexedDBFactory } from "fake-indexeddb";
import {
  ENGINE_VERSION,
  SAVE_MAX_PAYLOAD_BYTES,
  decodeSaveHeader,
} from "@lanpad/engine-core";
import type {
  Game,
  GameContext,
  GameManifest,
  SaveApi,
  SaveError,
  SaveErrorCode,
  SaveResult,
} from "@lanpad/sdk";
import {
  clearRuntimeCapabilities,
  createGameContext,
  installRuntimeCapabilities,
} from "../src/game/GameContext.js";
import { GameHost } from "../src/game/GameHost.js";
import { GameEventQueue, SnapshotInputReader } from "../src/game/InputReader.js";
import {
  RUNTIME_SDK_VERSION,
  SAVE_IDB_DATABASE,
  SAVE_IDB_STORE,
  SAVE_KEY_PREFIX,
  createBrowserSaveApi,
  createBrowserSaveCapability,
  createBrowserSaveStorage,
  createHostSaveApi,
  createIdbSaveStorage,
  createMemorySaveStorage,
  createOpfsSaveStorage,
  createTestLocalStorageSaveApi,
  createTestLocalStorageSaveCapability,
  createTestLocalStorageSaveStorage,
  selectBrowserSaveStorageKind,
} from "../src/game/SaveApi.js";
import type {
  BrowserSaveEnvironment,
  HostSaveApi,
  MemorySaveBackend,
  MemorySaveStorage,
  OpfsDirectoryHandleLike,
  OpfsFileHandleLike,
  StorageLike,
} from "../src/game/SaveApi.js";
import { InputMapper } from "../src/input/InputMapper.js";
import {
  FakeFrames,
  RecordingRenderer,
  silentAudio,
} from "./helpers/gameFakes.js";

const GAME_ID = "harbor-run";
const GAME_VERSION = "1.2.0";
const FIXED_MS = 1792627200000;
const PAYLOAD = new TextEncoder().encode("demo-payload:seed=1;tick=3600");
const OTHER_PAYLOAD = new TextEncoder().encode("other-payload:seed=2;tick=9");

/** Spec 15 §4.9 golden file: 85 bytes, uncompressed, engine 0.1.0. */
const GOLDEN_HEX = [
  "50 50 53 56 01 00 38 00 1d 00 00 00 c4 8b 5f 63",
  "00 00 01 00 00 00 0a 00 05 00 00 00 00 52 d9 6a",
  "00 00 00 00 00 00 00 00 68 61 72 62 6f 72 2d 72",
  "75 6e 31 2e 32 2e 30 00 64 65 6d 6f 2d 70 61 79",
  "6c 6f 61 64 3a 73 65 65 64 3d 31 3b 74 69 63 6b",
  "3d 33 36 30 30",
].join(" ");

const MANIFEST: GameManifest = {
  name: "SaveProbe",
  entry: "index.js",
  layouts: ["layouts/a.json"],
  assetBudget: { initialBytes: 1, totalBytes: 1 },
  minPlayers: 1,
  maxPlayers: 8,
  needsGyro: false,
  version: GAME_VERSION,
};

afterEach(() => {
  clearRuntimeCapabilities();
});

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function expectOk<T>(result: SaveResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function expectErr<T>(
  result: SaveResult<T>,
  code: SaveErrorCode,
): SaveError {
  if (result.ok) {
    throw new Error(`expected ${code}, got success`);
  }
  expect(result.error.code).toBe(code);
  return result.error;
}

function createBackend(): MemorySaveBackend {
  return {
    files: new Map<string, Uint8Array>(),
    metas: new Map(),
  };
}

interface MemoryFixture {
  readonly api: HostSaveApi;
  readonly storage: MemorySaveStorage;
  readonly backend: MemorySaveBackend;
}

function makeMemoryFixture(
  options: {
    readonly now?: () => number;
    readonly maxSlots?: number;
    readonly quotaBytes?: number;
    readonly backend?: MemorySaveBackend;
    readonly gameId?: string;
  } = {},
): MemoryFixture {
  const backend = options.backend ?? createBackend();
  const gameId = options.gameId ?? GAME_ID;
  const storage = createMemorySaveStorage({
    namespace: gameId,
    backend,
    ...(options.quotaBytes === undefined
      ? {}
      : { quotaBytes: options.quotaBytes }),
  });
  const api = expectOk(
    createHostSaveApi({
      gameId,
      gameVersion: GAME_VERSION,
      storage,
      now: options.now ?? ((): number => FIXED_MS),
      ...(options.maxSlots === undefined
        ? {}
        : { maxSlots: options.maxSlots }),
    }),
  );
  return { api, storage, backend };
}

function storedBytes(
  backend: MemorySaveBackend,
  gameId: string,
  slotId: string,
): Uint8Array {
  const bytes = backend.files.get(`${gameId}/${slotId}`);
  if (bytes === undefined) throw new Error(`no stored file for "${slotId}"`);
  return bytes.slice();
}

function setStoredBytes(
  backend: MemorySaveBackend,
  gameId: string,
  slotId: string,
  bytes: Uint8Array,
): void {
  backend.files.set(`${gameId}/${slotId}`, bytes.slice());
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    " ",
  );
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(
    hex.trim().split(/\s+/),
    (pair) => Number.parseInt(pair, 16),
  );
}

function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

function quotaError(): Error {
  const error = new Error("simulated quota");
  error.name = "QuotaExceededError";
  return error;
}

function securityError(): Error {
  const error = new Error("simulated security error");
  error.name = "SecurityError";
  return error;
}

/**
 * Map-backed `Storage` double. `onSet` runs before every write, so a test can
 * fail exactly one key (commit, metadata) without touching the others.
 */
class FakeLocalStorage implements StorageLike {
  private readonly entries = new Map<string, string>();
  maxChars = Number.POSITIVE_INFINITY;
  onSet: ((key: string, value: string) => Error | null) | null = null;

  get length(): number {
    return this.entries.size;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    const failure = this.onSet?.(key, value) ?? null;
    if (failure !== null) throw failure;
    const previous = this.entries.get(key)?.length ?? 0;
    if (this.usedChars() - previous + value.length > this.maxChars) {
      throw quotaError();
    }
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  usedChars(): number {
    let total = 0;
    for (const value of this.entries.values()) total += value.length;
    return total;
  }
}

/* -- OPFS doubles ---------------------------------------------------- */

function missingEntryError(): Error {
  const error = new Error("simulated missing entry");
  error.name = "NotFoundError";
  return error;
}

class FakeOpfsFileHandle implements OpfsFileHandleLike {
  readonly kind = "file" as const;
  readonly name: string;
  readonly directory: FakeOpfsDirectoryHandle;
  bytes: Uint8Array;
  lastModified: number;

  constructor(
    directory: FakeOpfsDirectoryHandle,
    name: string,
    bytes: Uint8Array,
    lastModified: number,
  ) {
    this.directory = directory;
    this.name = name;
    this.bytes = bytes.slice();
    this.lastModified = lastModified;
  }

  async getFile(): Promise<{
    size: number;
    lastModified: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
  }> {
    const snapshot = this.bytes.slice();
    return {
      size: snapshot.byteLength,
      lastModified: this.lastModified,
      arrayBuffer: async (): Promise<ArrayBuffer> => snapshot.buffer,
      text: async (): Promise<string> => new TextDecoder().decode(snapshot),
    };
  }

  async createWritable(): Promise<{
    write(data: Uint8Array): Promise<void>;
    close(): Promise<void>;
  }> {
    let pending = this.bytes.slice();
    return {
      write: async (data: Uint8Array): Promise<void> => {
        pending = data.slice();
      },
      close: async (): Promise<void> => {
        this.bytes = pending;
        this.lastModified = this.directory.clock;
      },
    };
  }

  async move(
    destination: OpfsDirectoryHandleLike,
    name: string,
  ): Promise<void> {
    const failure = this.directory.failMove?.(name) ?? null;
    if (failure !== null) throw failure;
    const target = destination as FakeOpfsDirectoryHandle;
    target.put(name, this.bytes, this.lastModified);
    this.directory.files.delete(this.name);
    this.directory.moves.push([this.name, name]);
  }
}

class FakeOpfsDirectoryHandle implements OpfsDirectoryHandleLike {
  readonly kind = "directory" as const;
  readonly name: string;
  readonly files = new Map<string, FakeOpfsFileHandle>();
  readonly directories = new Map<string, FakeOpfsDirectoryHandle>();
  readonly moves: Array<[string, string]> = [];
  readonly removals: string[] = [];
  clock = FIXED_MS;
  /** Test seam: return an Error to fail the named `move()` commit. */
  failMove: ((name: string) => Error | null) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  async getFileHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<OpfsFileHandleLike> {
    const existing = this.files.get(name);
    if (existing !== undefined) return existing;
    if (options.create !== true) throw missingEntryError();
    const handle = new FakeOpfsFileHandle(this, name, new Uint8Array(0), 0);
    this.files.set(name, handle);
    return handle;
  }

  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<OpfsDirectoryHandleLike> {
    const existing = this.directories.get(name);
    if (existing !== undefined) return existing;
    if (options.create !== true) throw missingEntryError();
    const handle = new FakeOpfsDirectoryHandle(name);
    this.directories.set(name, handle);
    return handle;
  }

  async removeEntry(name: string): Promise<void> {
    if (this.files.delete(name) || this.directories.delete(name)) {
      this.removals.push(name);
      return;
    }
    throw missingEntryError();
  }

  async *entries(): AsyncIterableIterator<
    [string, OpfsFileHandleLike | OpfsDirectoryHandleLike]
  > {
    for (const entry of this.files) yield entry;
    for (const entry of this.directories) yield entry;
  }

  put(name: string, bytes: Uint8Array, lastModified: number): void {
    this.files.set(
      name,
      new FakeOpfsFileHandle(this, name, bytes, lastModified),
    );
  }
}

async function seedGameDirectory(
  root: FakeOpfsDirectoryHandle,
): Promise<FakeOpfsDirectoryHandle> {
  const pocketpad = await root.getDirectoryHandle("pocketpad", { create: true });
  const saves = await pocketpad.getDirectoryHandle("saves", { create: true });
  return (await saves.getDirectoryHandle(GAME_ID, {
    create: true,
  })) as FakeOpfsDirectoryHandle;
}

async function gameDirectoryOf(
  root: FakeOpfsDirectoryHandle,
): Promise<FakeOpfsDirectoryHandle> {
  const pocketpad = await root.getDirectoryHandle("pocketpad");
  const saves = await pocketpad.getDirectoryHandle("saves");
  return (await saves.getDirectoryHandle(GAME_ID)) as FakeOpfsDirectoryHandle;
}

function opfsBytes(
  directory: FakeOpfsDirectoryHandle,
  name: string,
): Uint8Array {
  const file = directory.files.get(name);
  if (file === undefined) throw new Error(`no OPFS file "${name}"`);
  return file.bytes.slice();
}

/* -- IDB failure doubles (quota / abort are not reachable in fake-indexeddb) -- */

class FakeIdbRequest {
  result: unknown = undefined;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeIdbFailureTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  error: unknown = null;
  private readonly kind: "quota" | "abort";

  constructor(kind: "quota" | "abort") {
    this.kind = kind;
  }

  objectStore(): {
    put(record: unknown): FakeIdbRequest;
    get(key: unknown): FakeIdbRequest;
    getAll(): FakeIdbRequest;
    delete(key: unknown): FakeIdbRequest;
  } {
    return {
      put: (): FakeIdbRequest => {
        const request = new FakeIdbRequest();
        queueMicrotask((): void => {
          if (this.kind === "quota") this.error = quotaError();
          this.onabort?.();
        });
        return request;
      },
      get: (): FakeIdbRequest => {
        const request = new FakeIdbRequest();
        queueMicrotask((): void => {
          request.onsuccess?.();
          this.oncomplete?.();
        });
        return request;
      },
      getAll: (): FakeIdbRequest => {
        const request = new FakeIdbRequest();
        request.result = [];
        queueMicrotask((): void => {
          request.onsuccess?.();
          this.oncomplete?.();
        });
        return request;
      },
      delete: (): FakeIdbRequest => {
        const request = new FakeIdbRequest();
        queueMicrotask((): void => {
          request.onsuccess?.();
          this.oncomplete?.();
        });
        return request;
      },
    };
  }

  abort(): void {
    // The adapter aborts after a synchronous store error; nothing to do.
  }
}

class FakeIdbFailureDatabase {
  readonly objectStoreNames = { contains: (): boolean => true };
  private readonly kind: "quota" | "abort";

  constructor(kind: "quota" | "abort") {
    this.kind = kind;
  }

  createObjectStore(): void {
    // The store already "exists" in this double.
  }

  transaction(): FakeIdbFailureTransaction {
    return new FakeIdbFailureTransaction(this.kind);
  }

  close(): void {
    // No connection to close.
  }
}

class FakeIdbFailureOpenRequest {
  result: FakeIdbFailureDatabase;
  error: unknown = null;
  onupgradeneeded: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(result: FakeIdbFailureDatabase) {
    this.result = result;
  }
}

class FakeIdbFailureFactory {
  private readonly kind: "quota" | "abort";

  constructor(kind: "quota" | "abort") {
    this.kind = kind;
  }

  open(): FakeIdbFailureOpenRequest {
    const request = new FakeIdbFailureOpenRequest(
      new FakeIdbFailureDatabase(this.kind),
    );
    queueMicrotask((): void => {
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
}

const slotKey = (slotId: string): string =>
  `${SAVE_KEY_PREFIX}.${GAME_ID}.${slotId}.pps`;
const metaKey = (slotId: string): string =>
  `${SAVE_KEY_PREFIX}.${GAME_ID}.${slotId}.meta.json`;

function makeContext(
  options: { readonly gameId?: string; readonly save?: SaveApi } = {},
): GameContext {
  return createGameContext({
    manifest: MANIFEST,
    input: new SnapshotInputReader(new GameEventQueue()),
    renderer: new RecordingRenderer(),
    audio: silentAudio(),
    serverNow: () => null,
    ...(options.gameId === undefined ? {} : { gameId: options.gameId }),
    ...(options.save === undefined ? {} : { save: options.save }),
  });
}

function requireSave(context: GameContext): SaveApi {
  if (context.save === undefined) throw new Error("ctx.save is missing");
  return context.save;
}

/* ------------------------------------------------------------------ */
/* round trip                                                         */
/* ------------------------------------------------------------------ */

describe("host save API round trip [ER-15-01]", () => {
  test("[ER-15-01] write produces the exact 85-byte golden file and read returns the payload", async () => {
    const fixture = makeMemoryFixture();
    const slot = expectOk(await fixture.api.write("slot-1", PAYLOAD));

    expect(slot).toEqual({
      slotId: "slot-1",
      gameId: GAME_ID,
      formatVersion: 1,
      gameVersion: GAME_VERSION,
      createdAtUnixMs: FIXED_MS,
      updatedAtUnixMs: FIXED_MS,
      payloadBytes: 29,
      payloadUncompressedBytes: 0,
      bytes: 85,
      readable: true,
      error: null,
    });

    const file = storedBytes(fixture.backend, GAME_ID, "slot-1");
    expect(bytesToHex(file)).toBe(GOLDEN_HEX);
    expectBytes(file, hexToBytes(GOLDEN_HEX));

    const header = decodeSaveHeader(file);
    expect(header).toMatchObject({
      formatVersion: 1,
      engineMajor: 0,
      engineMinor: 1,
      enginePatch: 0,
      gameId: GAME_ID,
      gameVersion: GAME_VERSION,
      createdAtUnixSeconds: 1792627200,
      payloadBytes: 29,
      payloadUncompressedBytes: 0,
      payloadHash: 0x635f8bc4,
      flags: 0,
    });
    expect(ENGINE_VERSION).toBe("0.1.0");

    const meta = fixture.backend.metas.get("slot-1");
    expect(meta?.sdkVersion).toBe(RUNTIME_SDK_VERSION);
    expect(meta?.payloadSha256).toBeNull();

    expectBytes(expectOk(await fixture.api.read("slot-1")), PAYLOAD);

    const slots = expectOk(await fixture.api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]).toEqual(slot);

    expect(expectOk(await fixture.api.remove("slot-1"))).toBeUndefined();
    expect(expectOk(await fixture.api.remove("slot-1"))).toBeUndefined();
    expect(expectOk(await fixture.api.list())).toEqual([]);
    expect(fixture.storage.peek("slot-1")).toBeUndefined();
    expectErr(await fixture.api.read("slot-1"), "E_SAVE_SLOT");
  });

  test("[ER-15-01] API milliseconds project header seconds and commit time", async () => {
    const createdAtMs = FIXED_MS + 123;
    const fixture = makeMemoryFixture({ now: () => createdAtMs });
    const slot = expectOk(await fixture.api.write("slot-1", PAYLOAD));

    expect(slot.createdAtUnixMs).toBe(FIXED_MS);
    expect(slot.updatedAtUnixMs).toBe(createdAtMs);
    const header = decodeSaveHeader(
      storedBytes(fixture.backend, GAME_ID, "slot-1"),
    );
    expect(header.createdAtUnixSeconds).toBe(1792627200);
  });

  test("[ER-15-01] an empty payload writes a header-only 56-byte file", async () => {
    const fixture = makeMemoryFixture();
    const slot = expectOk(
      await fixture.api.write("slot-1", new Uint8Array(0)),
    );

    expect(slot.payloadBytes).toBe(0);
    expect(slot.bytes).toBe(56);
    const file = storedBytes(fixture.backend, GAME_ID, "slot-1");
    expect(file.byteLength).toBe(56);
    expect(decodeSaveHeader(file).payloadHash).toBe(0x811c9dc5);
    expect(expectOk(await fixture.api.read("slot-1")).byteLength).toBe(0);
  });

  test("[ER-15-01] list sorts by updatedAt descending then slotId ascending", async () => {
    const backend = createBackend();
    const early = makeMemoryFixture({ backend, now: () => FIXED_MS });
    expectOk(await early.api.write("zeta", PAYLOAD));
    const late = makeMemoryFixture({ backend, now: () => FIXED_MS + 5000 });
    expectOk(await late.api.write("alpha", PAYLOAD));

    expect(
      expectOk(await late.api.list()).map((slot) => slot.slotId),
    ).toEqual(["alpha", "zeta"]);

    const tied = makeMemoryFixture({
      backend: createBackend(),
      now: () => FIXED_MS,
    });
    expectOk(await tied.api.write("beta", PAYLOAD));
    expectOk(await tied.api.write("alpha", PAYLOAD));
    expect(
      expectOk(await tied.api.list()).map((slot) => slot.slotId),
    ).toEqual(["alpha", "beta"]);
  });
});

/* ------------------------------------------------------------------ */
/* malformed input                                                    */
/* ------------------------------------------------------------------ */

describe("malformed save input [ER-15-02]", () => {
  test("[ER-15-02] a truncated header is refused, listed unreadable and never deleted", async () => {
    const fixture = makeMemoryFixture();
    expectOk(await fixture.api.write("slot-1", PAYLOAD));
    const full = storedBytes(fixture.backend, GAME_ID, "slot-1");
    setStoredBytes(
      fixture.backend,
      GAME_ID,
      "slot-1",
      full.subarray(0, 20),
    );

    expectErr(await fixture.api.read("slot-1"), "E_SAVE_FORMAT");
    const slots = expectOk(await fixture.api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]?.readable).toBe(false);
    expect(slots[0]?.error).toBe("E_SAVE_FORMAT");
    expect(storedBytes(fixture.backend, GAME_ID, "slot-1")).toHaveLength(20);
  });

  test("[ER-15-02] a truncated payload is refused by read and left in place", async () => {
    const fixture = makeMemoryFixture();
    expectOk(await fixture.api.write("slot-1", PAYLOAD));
    const full = storedBytes(fixture.backend, GAME_ID, "slot-1");
    setStoredBytes(
      fixture.backend,
      GAME_ID,
      "slot-1",
      full.subarray(0, full.byteLength - 1),
    );

    expectErr(await fixture.api.read("slot-1"), "E_SAVE_FORMAT");
    expect(
      storedBytes(fixture.backend, GAME_ID, "slot-1").byteLength,
    ).toBe(84);
  });

  test("[ER-15-02] a trailing byte and a bad magic are both E_SAVE_FORMAT", async () => {
    const fixture = makeMemoryFixture();
    expectOk(await fixture.api.write("slot-1", PAYLOAD));

    const withTrailing = new Uint8Array(86);
    withTrailing.set(storedBytes(fixture.backend, GAME_ID, "slot-1"));
    setStoredBytes(fixture.backend, GAME_ID, "slot-1", withTrailing);
    expectErr(await fixture.api.read("slot-1"), "E_SAVE_FORMAT");

    const badMagic = storedBytes(fixture.backend, GAME_ID, "slot-1").subarray(
      0,
      85,
    );
    badMagic[0] = 0x58;
    setStoredBytes(fixture.backend, GAME_ID, "slot-1", badMagic);
    expectErr(await fixture.api.read("slot-1"), "E_SAVE_FORMAT");
  });

  test("[ER-15-02] invalid slot ids are refused before touching storage", async () => {
    const fixture = makeMemoryFixture();
    for (const slotId of [
      "",
      "../escape",
      "UPPER",
      "-leading",
      "a".repeat(33),
      "white space",
    ]) {
      expectErr(await fixture.api.write(slotId, PAYLOAD), "E_SAVE_SLOT");
      expectErr(await fixture.api.read(slotId), "E_SAVE_SLOT");
      expectErr(await fixture.api.remove(slotId), "E_SAVE_SLOT");
    }
    expect(fixture.backend.files.size).toBe(0);
    expect(fixture.backend.metas.size).toBe(0);
  });

  test("[ER-15-02] save setup refuses a missing version, bad game id and bad slot cap", () => {
    const storage = createMemorySaveStorage();
    expectErr(
      createHostSaveApi({ gameId: GAME_ID, storage }),
      "E_SAVE_FORMAT",
    );
    expectErr(
      createHostSaveApi({
        gameId: "Bad Id",
        gameVersion: GAME_VERSION,
        storage,
      }),
      "E_SAVE_GAME",
    );
    expectErr(
      createHostSaveApi({
        gameId: GAME_ID,
        gameVersion: GAME_VERSION,
        storage,
        maxSlots: 0,
      }),
      "E_SAVE_SLOT",
    );
    expectErr(
      createHostSaveApi({
        gameId: GAME_ID,
        gameVersion: GAME_VERSION,
        storage,
        maxSlots: 2.5,
      }),
      "E_SAVE_SLOT",
    );

    const unversioned: GameManifest = {
      name: "SaveProbe",
      entry: "index.js",
      layouts: ["layouts/a.json"],
      assetBudget: { initialBytes: 1, totalBytes: 1 },
      minPlayers: 1,
      maxPlayers: 8,
      needsGyro: false,
    };
    expectErr(
      createTestLocalStorageSaveApi(unversioned, GAME_ID, {
        storage: new FakeLocalStorage(),
      }),
      "E_SAVE_FORMAT",
    );
    expect(
      expectOk(
        createTestLocalStorageSaveApi(unversioned, GAME_ID, {
          gameVersion: GAME_VERSION,
          storage: new FakeLocalStorage(),
        }),
      ).gameId,
    ).toBe(GAME_ID);
  });
});

/* ------------------------------------------------------------------ */
/* versions and integrity                                             */
/* ------------------------------------------------------------------ */

describe("version and hash checks [ER-15-05, ER-15-06]", () => {
  test("[ER-15-05] a newer formatVersion is refused and the file stays byte-identical", async () => {
    const fixture = makeMemoryFixture();
    expectOk(await fixture.api.write("slot-1", PAYLOAD));
    const before = storedBytes(fixture.backend, GAME_ID, "slot-1");
    const patched = before.slice();
    patched[4] = 2;
    patched[5] = 0;
    setStoredBytes(fixture.backend, GAME_ID, "slot-1", patched);

    expectErr(await fixture.api.read("slot-1"), "E_SAVE_VERSION");
    const slots = expectOk(await fixture.api.list());
    expect(slots[0]?.readable).toBe(false);
    expect(slots[0]?.error).toBe("E_SAVE_VERSION");
    expectBytes(storedBytes(fixture.backend, GAME_ID, "slot-1"), patched);

    expectOk(await fixture.api.remove("slot-1"));
    expect(fixture.backend.files.size).toBe(0);
  });

  test("[ER-15-05] formatVersion 0 is refused as E_SAVE_FORMAT and left untouched", async () => {
    const fixture = makeMemoryFixture();
    expectOk(await fixture.api.write("slot-1", PAYLOAD));
    const patched = storedBytes(fixture.backend, GAME_ID, "slot-1");
    patched[4] = 0;
    patched[5] = 0;
    setStoredBytes(fixture.backend, GAME_ID, "slot-1", patched);

    expectErr(await fixture.api.read("slot-1"), "E_SAVE_FORMAT");
    expectBytes(storedBytes(fixture.backend, GAME_ID, "slot-1"), patched);
  });

  test("[ER-15-06] a payload bit flip is E_SAVE_HASH and never mutates the file", async () => {
    const fixture = makeMemoryFixture();
    expectOk(await fixture.api.write("slot-1", PAYLOAD));
    const storageFile = storedBytes(fixture.backend, GAME_ID, "slot-1");
    const flipped = storageFile.slice();
    const last = flipped.byteLength - 1;
    flipped[last] = (flipped[last] ?? 0) ^ 0x01;
    setStoredBytes(fixture.backend, GAME_ID, "slot-1", flipped);

    const error = expectErr(await fixture.api.read("slot-1"), "E_SAVE_HASH");
    expect(error.recoverable).toBe(false);
    expectBytes(storedBytes(fixture.backend, GAME_ID, "slot-1"), flipped);

    // Spec 15 §3.5: `readable` covers structural, version and game-id checks
    // only; `read()` is the authoritative hash check, so list may say true.
    const slots = expectOk(await fixture.api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]?.slotId).toBe("slot-1");
    expect(storedBytes(fixture.backend, GAME_ID, "slot-1")).toHaveLength(85);
  });
});

/* ------------------------------------------------------------------ */
/* isolation                                                          */
/* ------------------------------------------------------------------ */

describe("game isolation [ER-15-11]", () => {
  test("[ER-15-11] two games sharing a store never see each other's slots", async () => {
    const backend = createBackend();
    const gameA = makeMemoryFixture({ backend, gameId: "game-a" });
    const gameB = makeMemoryFixture({ backend, gameId: "game-b" });
    expectOk(await gameA.api.write("slot-1", PAYLOAD));
    expectOk(await gameB.api.write("slot-1", OTHER_PAYLOAD));

    expect(expectOk(await gameA.api.list())).toHaveLength(1);
    expect(expectOk(await gameB.api.list())).toHaveLength(1);
    expectBytes(expectOk(await gameA.api.read("slot-1")), PAYLOAD);
    expectBytes(expectOk(await gameB.api.read("slot-1")), OTHER_PAYLOAD);
    expectErr(await gameA.api.read("slot-2"), "E_SAVE_SLOT");

    expectOk(await gameA.api.remove("slot-1"));
    expect(expectOk(await gameA.api.list())).toEqual([]);
    expect(expectOk(await gameB.api.list())).toHaveLength(1);
  });

  test("[ER-15-11] a foreign-game file is listed unreadable and only remove deletes it", async () => {
    const backend = createBackend();
    const gameA = makeMemoryFixture({ backend, gameId: "game-a" });
    const gameB = makeMemoryFixture({ backend, gameId: "game-b" });
    expectOk(await gameB.api.write("slot-1", OTHER_PAYLOAD));
    setStoredBytes(
      backend,
      "game-a",
      "stolen",
      storedBytes(backend, "game-b", "slot-1"),
    );

    const slots = expectOk(await gameA.api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]?.slotId).toBe("stolen");
    expect(slots[0]?.readable).toBe(false);
    expect(slots[0]?.error).toBe("E_SAVE_GAME");
    expectErr(await gameA.api.read("stolen"), "E_SAVE_GAME");
    expect(backend.files.has("game-a/stolen")).toBe(true);

    // Listing and reading again must not repair or delete it.
    expectErr(await gameA.api.read("stolen"), "E_SAVE_GAME");
    expect(backend.files.has("game-a/stolen")).toBe(true);

    expectOk(await gameA.api.remove("stolen"));
    expect(backend.files.has("game-a/stolen")).toBe(false);
    expect(backend.files.has("game-b/slot-1")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* atomicity, quota and caps                                          */
/* ------------------------------------------------------------------ */

describe("write atomicity and limits [ER-15-07, ER-15-08]", () => {
  test("[ER-15-07] a temp-stage failure leaves the previous save byte-identical", async () => {
    const fixture = makeMemoryFixture();
    expectOk(await fixture.api.write("slot-1", PAYLOAD));
    const before = storedBytes(fixture.backend, GAME_ID, "slot-1");

    fixture.storage.failNextWrite("temp");
    const error = expectErr(
      await fixture.api.write("slot-1", OTHER_PAYLOAD),
      "E_SAVE_IO",
    );
    expect(error.recoverable).toBe(true);
    expectBytes(storedBytes(fixture.backend, GAME_ID, "slot-1"), before);
    expectBytes(expectOk(await fixture.api.read("slot-1")), PAYLOAD);
  });

  test("[ER-15-07] a commit-stage failure leaves the previous save readable", async () => {
    const fixture = makeMemoryFixture();
    expectOk(await fixture.api.write("slot-1", PAYLOAD));
    const before = storedBytes(fixture.backend, GAME_ID, "slot-1");

    fixture.storage.failNextWrite("commit");
    expectErr(
      await fixture.api.write("slot-1", OTHER_PAYLOAD),
      "E_SAVE_IO",
    );
    expectBytes(storedBytes(fixture.backend, GAME_ID, "slot-1"), before);
    expect(expectOk(await fixture.api.list())).toHaveLength(1);
    expectBytes(expectOk(await fixture.api.read("slot-1")), PAYLOAD);
  });

  test("[ER-15-07] adapter creation removes only stale temp keys", () => {
    const storage = new FakeLocalStorage();
    const prefix = `${SAVE_KEY_PREFIX}.${GAME_ID}.`;
    storage.setItem(`${prefix}stale.pps.tmp`, "junk");
    storage.setItem(`${prefix}slot-1.pps.tmp`, "junk");
    storage.setItem(`${prefix}slot-1.pps`, "keep");
    storage.setItem(`${prefix}slot-1.meta.json`, "{}");

    expect(createTestLocalStorageSaveStorage(GAME_ID, storage)).toBeDefined();
    expect(storage.getItem(`${prefix}stale.pps.tmp`)).toBeNull();
    expect(storage.getItem(`${prefix}slot-1.pps.tmp`)).toBeNull();
    expect(storage.getItem(`${prefix}slot-1.pps`)).toBe("keep");
    expect(storage.getItem(`${prefix}slot-1.meta.json`)).toBe("{}");
  });

  test("[ER-15-07] a failed localStorage commit keeps the old file and removes the temp", async () => {
    const storage = new FakeLocalStorage();
    const api = expectOk(
      createTestLocalStorageSaveApi(MANIFEST, GAME_ID, {
        storage,
        now: () => FIXED_MS,
      }),
    );
    expectOk(await api.write("slot-1", PAYLOAD));
    const before = storage.getItem(slotKey("slot-1"));

    storage.onSet = (key) =>
      key === slotKey("slot-1") ? new Error("io") : null;
    expectErr(await api.write("slot-1", OTHER_PAYLOAD), "E_SAVE_IO");
    expect(storage.getItem(slotKey("slot-1"))).toBe(before);
    expect(storage.keys().some((key) => key.endsWith(".tmp"))).toBe(false);
    expectBytes(expectOk(await api.read("slot-1")), PAYLOAD);
  });

  test("[ER-15-08] a localStorage quota error maps to E_SAVE_QUOTA and keeps the old save", async () => {
    const storage = new FakeLocalStorage();
    const api = expectOk(
      createTestLocalStorageSaveApi(MANIFEST, GAME_ID, {
        storage,
        now: () => FIXED_MS,
      }),
    );
    expectOk(await api.write("slot-1", PAYLOAD));
    const before = storage.getItem(slotKey("slot-1"));

    storage.maxChars = storage.usedChars() + 10;
    const error = expectErr(
      await api.write("slot-1", OTHER_PAYLOAD),
      "E_SAVE_QUOTA",
    );
    expect(error.recoverable).toBe(true);
    expect(storage.getItem(slotKey("slot-1"))).toBe(before);
    expect(storage.keys().some((key) => key.endsWith(".tmp"))).toBe(false);
    expectBytes(expectOk(await api.read("slot-1")), PAYLOAD);
  });

  test("[ER-15-07] a metadata write failure after commit still yields a valid save", async () => {
    const storage = new FakeLocalStorage();
    const api = expectOk(
      createTestLocalStorageSaveApi(MANIFEST, GAME_ID, {
        storage,
        now: () => FIXED_MS,
      }),
    );
    storage.onSet = (key) =>
      key.endsWith(".meta.json") ? quotaError() : null;

    const slot = expectOk(await api.write("slot-1", PAYLOAD));
    expect(slot.readable).toBe(true);
    expect(storage.getItem(metaKey("slot-1"))).toBeNull();
    expectBytes(expectOk(await api.read("slot-1")), PAYLOAD);
    const slots = expectOk(await api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]?.readable).toBe(true);
    expect(slots[0]?.createdAtUnixMs).toBe(FIXED_MS);
  });

  test("[ER-15-08] a quota failure leaves the previous save intact and deletes nothing", async () => {
    const fixture = makeMemoryFixture();
    expectOk(await fixture.api.write("keep", PAYLOAD));
    const before = storedBytes(fixture.backend, GAME_ID, "keep");

    const tight = makeMemoryFixture({
      backend: fixture.backend,
      quotaBytes: 90,
    });
    const error = expectErr(
      await tight.api.write("new", OTHER_PAYLOAD),
      "E_SAVE_QUOTA",
    );
    expect(error.recoverable).toBe(true);
    expectBytes(storedBytes(fixture.backend, GAME_ID, "keep"), before);
    expect(expectOk(await tight.api.list())).toHaveLength(1);
    expectBytes(expectOk(await tight.api.read("keep")), PAYLOAD);
  });

  test("[ER-15-08] the slot cap refuses a new slot but allows overwrite and remove", async () => {
    const fixture = makeMemoryFixture({ maxSlots: 2 });
    expectOk(await fixture.api.write("a", PAYLOAD));
    expectOk(await fixture.api.write("b", PAYLOAD));
    expectErr(await fixture.api.write("c", PAYLOAD), "E_SAVE_SLOT");

    expectOk(await fixture.api.write("a", OTHER_PAYLOAD));
    expectBytes(expectOk(await fixture.api.read("a")), OTHER_PAYLOAD);

    expectOk(await fixture.api.remove("b"));
    expectOk(await fixture.api.write("c", PAYLOAD));
    expect(expectOk(await fixture.api.list())).toHaveLength(2);
  });

  test("[ER-15-08] an over-cap payload is refused before storage and a bad type is rejected", async () => {
    const fixture = makeMemoryFixture();
    const oversized = new Uint8Array(SAVE_MAX_PAYLOAD_BYTES + 1);
    expectErr(await fixture.api.write("slot-1", oversized), "E_SAVE_FORMAT");
    expectErr(
      await fixture.api.write(
        "slot-1",
        "not bytes" as unknown as Uint8Array,
      ),
      "E_SAVE_FORMAT",
    );
    expect(fixture.backend.files.size).toBe(0);
    expectErr(await fixture.api.read("slot-1"), "E_SAVE_SLOT");
  });
});

/* ------------------------------------------------------------------ */
/* storage availability and context wiring                            */
/* ------------------------------------------------------------------ */

describe("storage availability [ER-15-10]", () => {
  test("[ER-15-10] missing localStorage yields no adapter and no ctx.save", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    try {
      Object.defineProperty(globalThis, "localStorage", {
        value: undefined,
        configurable: true,
        writable: true,
      });

      expect(createTestLocalStorageSaveStorage(GAME_ID)).toBeUndefined();
      expectErr(createTestLocalStorageSaveApi(MANIFEST, GAME_ID), "E_SAVE_IO");

      clearRuntimeCapabilities();
      const context = makeContext();
      expect(context.save).toBeUndefined();
      expect("save" in context).toBe(false);
      expect(Object.isFrozen(context)).toBe(true);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, "localStorage");
      } else {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      }
    }
  });

  test("[ER-15-10] a storage that refuses the probe write yields no adapter", () => {
    const storage = new FakeLocalStorage();
    storage.onSet = () => securityError();
    expect(createTestLocalStorageSaveStorage(GAME_ID, storage)).toBeUndefined();
  });

  test("[ER-15-10] the installed provider binds ctx.save only when a game id exists", async () => {
    const storage = new FakeLocalStorage();
    installRuntimeCapabilities({
      save: createTestLocalStorageSaveCapability({
        storage,
        now: () => FIXED_MS,
      }),
    });

    expect(makeContext().save).toBeUndefined();

    const context = makeContext({ gameId: GAME_ID });
    const save = requireSave(context);
    expect(save.gameId).toBe(GAME_ID);
    expectOk(await save.write("slot-1", PAYLOAD));
    expectBytes(expectOk(await save.read("slot-1")), PAYLOAD);
    expect(storage.getItem(slotKey("slot-1"))).not.toBeNull();
  });

  test("[ER-15-10] GameHost hands the host save API to init before the loop", async () => {
    const api = makeMemoryFixture().api;
    let seen: SaveApi | undefined;
    let sawSaveKey = false;
    const game: Game = {
      manifest: MANIFEST,
      init(context: GameContext): void {
        seen = context.save;
        sawSaveKey = "save" in context;
      },
      simulate(): void {},
      render(): void {},
      dispose(): void {},
    };
    const frames = new FakeFrames();
    const host = new GameHost({
      game,
      renderer: new RecordingRenderer(),
      audio: silentAudio(),
      mapper: new InputMapper(),
      now: frames.now,
      raf: frames.raf,
      cancel: frames.cancel,
      save: api,
      gameId: GAME_ID,
    });

    await host.start();
    expect(seen).toBe(api);
    expect(sawSaveKey).toBe(true);
    expect(host.phase).toBe("playing");
    host.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* redaction                                                          */
/* ------------------------------------------------------------------ */

describe("redaction [ER-15-12]", () => {
  test("[ER-15-12] engine-generated keys, headers and metadata carry no PII markers", async () => {
    const storage = new FakeLocalStorage();
    const api = expectOk(
      createTestLocalStorageSaveApi(MANIFEST, GAME_ID, {
        storage,
        now: () => FIXED_MS,
      }),
    );
    expectOk(await api.write("slot-1", PAYLOAD));

    const raw = storage.getItem(slotKey("slot-1")) ?? "";
    const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0));
    const headerText = new TextDecoder().decode(bytes.subarray(0, 56));
    const metaText = storage.getItem(metaKey("slot-1")) ?? "";
    const generated = [...storage.keys(), headerText, metaText].join("\n");

    for (const marker of ["token", "room", "pin", "session", "@"]) {
      expect(generated.toLowerCase()).not.toContain(marker);
    }
    expect(generated).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  });

  test("[ER-15-12] read errors name the slot and code but never echo payload bytes", async () => {
    const fixture = makeMemoryFixture();
    const secret = new TextEncoder().encode("token=SECRET-MARKER");
    expectOk(await fixture.api.write("slot-1", secret));
    const flipped = storedBytes(fixture.backend, GAME_ID, "slot-1");
    const last = flipped.byteLength - 1;
    flipped[last] = (flipped[last] ?? 0) ^ 0xff;
    setStoredBytes(fixture.backend, GAME_ID, "slot-1", flipped);

    const error = expectErr(await fixture.api.read("slot-1"), "E_SAVE_HASH");
    expect(error.message).not.toContain("SECRET-MARKER");
    expect(error.message).not.toContain("token=");
    expect(error.message).toContain("slot-1");
    expect(error.message).toContain("E_SAVE_HASH");
  });
});

/* ------------------------------------------------------------------ */
/* OPFS tier (spec 15 §4.11, §5.6)                                    */
/* ------------------------------------------------------------------ */

function makeOpfsApi(origin: FakeOpfsDirectoryHandle): {
  readonly storage: ReturnType<typeof createOpfsSaveStorage>;
  readonly api: HostSaveApi;
} {
  const storage = createOpfsSaveStorage(GAME_ID, origin);
  const api = expectOk(
    createHostSaveApi({
      gameId: GAME_ID,
      gameVersion: GAME_VERSION,
      storage,
      now: () => FIXED_MS,
    }),
  );
  return { storage, api };
}

describe("OPFS storage tier [ER-15-01, ER-15-09]", () => {
  test("[ER-15-01] OPFS commits by move, stores the exact golden file and reads it back", async () => {
    const origin = new FakeOpfsDirectoryHandle("root");
    const { storage, api } = makeOpfsApi(origin);
    expect(storage.kind).toBe("opfs");

    const slot = expectOk(await api.write("slot-1", PAYLOAD));
    expect(slot).toMatchObject({
      slotId: "slot-1",
      gameId: GAME_ID,
      formatVersion: 1,
      gameVersion: GAME_VERSION,
      createdAtUnixMs: FIXED_MS,
      updatedAtUnixMs: FIXED_MS,
      bytes: 85,
      readable: true,
      error: null,
    });

    const directory = await gameDirectoryOf(origin);
    expect([...directory.files.keys()].sort()).toEqual([
      "slot-1.meta.json",
      "slot-1.pps",
    ]);
    expectBytes(opfsBytes(directory, "slot-1.pps"), hexToBytes(GOLDEN_HEX));
    // Commit order: the save file first, then the disposable metadata sidecar.
    expect(directory.moves).toEqual([
      ["slot-1.tmp", "slot-1.pps"],
      ["slot-1.meta.json.tmp", "slot-1.meta.json"],
    ]);
    // move() replaces the destination; delete-then-rename is never used.
    expect(directory.removals).toEqual([]);

    const meta = JSON.parse(
      new TextDecoder().decode(opfsBytes(directory, "slot-1.meta.json")),
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({
      metaVersion: 1,
      slotId: "slot-1",
      gameId: GAME_ID,
      sdkVersion: RUNTIME_SDK_VERSION,
      createdAtUnixMs: FIXED_MS,
      updatedAtUnixMs: FIXED_MS,
      payloadSha256: null,
      bytes: 85,
    });

    expectBytes(expectOk(await api.read("slot-1")), PAYLOAD);
    const slots = expectOk(await api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      slotId: "slot-1",
      gameId: GAME_ID,
      readable: true,
      error: null,
      bytes: 85,
      updatedAtUnixMs: FIXED_MS,
    });
    expect(await storage.read("missing")).toBeUndefined();
    expectErr(await api.read("missing"), "E_SAVE_SLOT");

    // A second write replaces the committed file through move() alone.
    expectOk(await api.write("slot-1", OTHER_PAYLOAD));
    expectBytes(expectOk(await api.read("slot-1")), OTHER_PAYLOAD);
    expect(directory.removals).toEqual([]);
    expect(
      directory.moves.filter(([, name]) => name === "slot-1.pps"),
    ).toHaveLength(2);
    api.dispose();
  });

  test("[ER-15-09] OPFS init removes stale *.tmp files and nothing else", async () => {
    const origin = new FakeOpfsDirectoryHandle("root");
    const directory = await seedGameDirectory(origin);
    directory.put("slot-1.pps", hexToBytes(GOLDEN_HEX), FIXED_MS);
    directory.put(
      "slot-1.meta.json",
      new TextEncoder().encode("{}"),
      FIXED_MS,
    );
    directory.put("slot-1.tmp", new Uint8Array([1, 2, 3]), FIXED_MS);
    directory.put("slot-1.meta.json.tmp", new Uint8Array([4]), FIXED_MS);
    directory.put("keep.txt", new Uint8Array([5]), FIXED_MS);

    const storage = createOpfsSaveStorage(GAME_ID, origin);
    await storage.ready?.();

    expect([...directory.files.keys()].sort()).toEqual([
      "keep.txt",
      "slot-1.meta.json",
      "slot-1.pps",
    ]);
    expect([...directory.removals].sort()).toEqual([
      "slot-1.meta.json.tmp",
      "slot-1.tmp",
    ]);
    expectBytes(opfsBytes(directory, "slot-1.pps"), hexToBytes(GOLDEN_HEX));
    storage.dispose();
  });

  test("[ER-15-07] a failed OPFS move keeps the previous save and maps to E_SAVE_QUOTA", async () => {
    const origin = new FakeOpfsDirectoryHandle("root");
    const { api } = makeOpfsApi(origin);
    expectOk(await api.write("slot-1", PAYLOAD));
    const directory = await gameDirectoryOf(origin);
    const previous = opfsBytes(directory, "slot-1.pps");

    directory.failMove = (name) =>
      name.endsWith(".pps") ? quotaError() : null;
    const error = expectErr(
      await api.write("slot-1", OTHER_PAYLOAD),
      "E_SAVE_QUOTA",
    );
    expect(error.recoverable).toBe(true);

    expectBytes(opfsBytes(directory, "slot-1.pps"), previous);
    expectBytes(expectOk(await api.read("slot-1")), PAYLOAD);
    expect(directory.files.has("slot-1.tmp")).toBe(false);
    expect(directory.removals).not.toContain("slot-1.pps");

    directory.failMove = null;
    expectOk(await api.write("slot-1", OTHER_PAYLOAD));
    expectBytes(expectOk(await api.read("slot-1")), OTHER_PAYLOAD);
    api.dispose();
  });

  test("[ER-15-09] metadata failure after the file commit still leaves a readable save", async () => {
    const origin = new FakeOpfsDirectoryHandle("root");
    const { storage, api } = makeOpfsApi(origin);
    await storage.ready?.();
    const directory = await gameDirectoryOf(origin);
    directory.failMove = (name) =>
      name.endsWith(".meta.json") ? quotaError() : null;

    const slot = expectOk(await api.write("slot-1", PAYLOAD));
    expect(slot.readable).toBe(true);
    expect(directory.files.has("slot-1.pps")).toBe(true);
    expect(directory.files.has("slot-1.meta.json")).toBe(false);
    expect(directory.files.has("slot-1.meta.json.tmp")).toBe(false);

    expectBytes(expectOk(await api.read("slot-1")), PAYLOAD);
    const slots = expectOk(await api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      slotId: "slot-1",
      readable: true,
      error: null,
      updatedAtUnixMs: FIXED_MS,
    });
    api.dispose();
  });

  test("[ER-15-02] a corrupt OPFS file is listed unreadable and never deleted", async () => {
    const origin = new FakeOpfsDirectoryHandle("root");
    const directory = await seedGameDirectory(origin);
    directory.put(
      "bad.pps",
      new TextEncoder().encode("not-a-save"),
      FIXED_MS,
    );
    const { api } = makeOpfsApi(origin);

    const slots = expectOk(await api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      slotId: "bad",
      readable: false,
      error: "E_SAVE_FORMAT",
      bytes: 10,
    });
    expectErr(await api.read("bad"), "E_SAVE_FORMAT");
    expect(directory.files.has("bad.pps")).toBe(true);
    expect(directory.removals).toEqual([]);
  });

  test("[ER-15-02] list is header-only; read verifies the payload hash", async () => {
    const origin = new FakeOpfsDirectoryHandle("root");
    const { api } = makeOpfsApi(origin);
    expectOk(await api.write("slot-1", PAYLOAD));
    const directory = await gameDirectoryOf(origin);
    const file = directory.files.get("slot-1.pps");
    if (file === undefined) throw new Error("expected slot-1.pps");
    const last = file.bytes.byteLength - 1;
    file.bytes[last] = (file.bytes[last] ?? 0) ^ 0xff;

    const slots = expectOk(await api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      slotId: "slot-1",
      readable: true,
      error: null,
    });
    expectErr(await api.read("slot-1"), "E_SAVE_HASH");
    expect(directory.files.has("slot-1.pps")).toBe(true);
    expect(directory.removals).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* browser tier selection and bindings [ER-15-10]                     */
/* ------------------------------------------------------------------ */

describe("browser save tier selection [ER-15-10]", () => {
  test("[ER-15-10] order is OPFS (secure + getDirectory + move), then IndexedDB, then none", () => {
    const factory = new FakeIndexedDBFactory();
    const root = new FakeOpfsDirectoryHandle("root");
    const getDirectory = async (): Promise<OpfsDirectoryHandleLike> => root;

    expect(
      selectBrowserSaveStorageKind({
        isSecureContext: true,
        storage: { getDirectory },
        indexedDB: factory,
        moveSupported: true,
      }),
    ).toBe("opfs");
    expect(
      selectBrowserSaveStorageKind({
        isSecureContext: true,
        storage: { getDirectory },
        indexedDB: factory,
        moveSupported: false,
      }),
    ).toBe("indexeddb");
    expect(
      selectBrowserSaveStorageKind({
        isSecureContext: false,
        storage: { getDirectory },
        indexedDB: factory,
        moveSupported: true,
      }),
    ).toBe("indexeddb");
    expect(
      selectBrowserSaveStorageKind({
        isSecureContext: true,
        moveSupported: true,
        indexedDB: factory,
      }),
    ).toBe("indexeddb");
    expect(
      selectBrowserSaveStorageKind({
        isSecureContext: true,
        moveSupported: true,
      }),
    ).toBe("none");
  });

  test("[ER-15-10] an invalid game id selects no browser store", () => {
    const env: BrowserSaveEnvironment = {
      isSecureContext: true,
      moveSupported: true,
      storage: {
        getDirectory: async () => new FakeOpfsDirectoryHandle("root"),
      },
    };
    expect(createBrowserSaveStorage("Harbor Run", { env })).toBeUndefined();
    expect(createBrowserSaveStorage("", { env })).toBeUndefined();
  });

  test("[ER-15-10] localStorage is never selected as a production tier", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    try {
      Object.defineProperty(globalThis, "localStorage", {
        value: new FakeLocalStorage(),
        configurable: true,
        writable: true,
      });
      const env: BrowserSaveEnvironment = {
        isSecureContext: false,
        moveSupported: false,
      };
      expect(selectBrowserSaveStorageKind(env)).toBe("none");
      expect(createBrowserSaveStorage(GAME_ID, { env })).toBeUndefined();
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, "localStorage");
      } else {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      }
    }
  });

  test("[ER-15-10] createBrowserSaveApi writes through the OPFS tier", async () => {
    const origin = new FakeOpfsDirectoryHandle("root");
    const env: BrowserSaveEnvironment = {
      isSecureContext: true,
      moveSupported: true,
      storage: { getDirectory: async () => origin },
    };
    const api = expectOk(
      await createBrowserSaveApi(MANIFEST, GAME_ID, {
        env,
        now: () => FIXED_MS,
      }),
    );
    expect(api.gameId).toBe(GAME_ID);
    expectOk(await api.write("slot-1", PAYLOAD));
    expectBytes(expectOk(await api.read("slot-1")), PAYLOAD);
    const directory = await gameDirectoryOf(origin);
    expect(directory.files.has("slot-1.pps")).toBe(true);
    api.dispose();
  });

  test("[ER-15-10] an OPFS open failure yields E_SAVE_IO and no provider result", async () => {
    const env: BrowserSaveEnvironment = {
      isSecureContext: true,
      moveSupported: true,
      storage: {
        getDirectory: async (): Promise<OpfsDirectoryHandleLike> => {
          throw securityError();
        },
      },
    };
    expectErr(
      await createBrowserSaveApi(MANIFEST, GAME_ID, {
        env,
        now: () => FIXED_MS,
      }),
      "E_SAVE_IO",
    );
    const provider = createBrowserSaveCapability({ env, now: () => FIXED_MS });
    await expect(
      provider({ manifest: MANIFEST, gameId: GAME_ID }),
    ).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* IndexedDB tier (spec 15 §4.11, §5.6)                               */
/* ------------------------------------------------------------------ */

function openIdbDatabase(
  factory: IDBFactory,
  name: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error);
  });
}

async function idbRecord(
  factory: IDBFactory,
  gameId: string,
  slotId: string,
): Promise<Record<string, unknown> | undefined> {
  const database = await openIdbDatabase(factory, SAVE_IDB_DATABASE);
  try {
    return await new Promise<Record<string, unknown> | undefined>(
      (resolve, reject) => {
        const transaction = database.transaction(SAVE_IDB_STORE, "readonly");
        const request = transaction
          .objectStore(SAVE_IDB_STORE)
          .get([gameId, slotId]);
        request.onsuccess = (): void => {
          resolve(request.result as Record<string, unknown> | undefined);
        };
        request.onerror = (): void => reject(request.error);
      },
    );
  } finally {
    database.close();
  }
}

async function idbPut(
  factory: IDBFactory,
  record: Record<string, unknown>,
): Promise<void> {
  const database = await openIdbDatabase(factory, SAVE_IDB_DATABASE);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SAVE_IDB_STORE, "readwrite");
      transaction.objectStore(SAVE_IDB_STORE).put(record);
      transaction.oncomplete = (): void => resolve();
      transaction.onerror = (): void => reject(transaction.error);
      transaction.onabort = (): void => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function makeIdbApi(
  factory: IDBFactory = new FakeIndexedDBFactory(),
  gameId: string = GAME_ID,
): {
  readonly factory: IDBFactory;
  readonly storage: ReturnType<typeof createIdbSaveStorage>;
  readonly api: HostSaveApi;
} {
  const storage = createIdbSaveStorage(gameId, { factory });
  const api = expectOk(
    createHostSaveApi({
      gameId,
      gameVersion: GAME_VERSION,
      storage,
      now: () => FIXED_MS,
    }),
  );
  return { factory, storage, api };
}

class FakeIdbOpenFailureFactory {
  open(): FakeIdbFailureOpenRequest {
    const request = new FakeIdbFailureOpenRequest(
      new FakeIdbFailureDatabase("abort"),
    );
    queueMicrotask((): void => {
      request.error = securityError();
      request.onerror?.();
    });
    return request;
  }
}

describe("IndexedDB storage tier [ER-15-01, ER-15-09]", () => {
  test("[ER-15-09] IndexedDB stores one atomic record with file bytes and metadata", async () => {
    const { factory, storage, api } = makeIdbApi();
    await storage.ready?.();
    expect(storage.kind).toBe("indexeddb");

    const slot = expectOk(await api.write("slot-1", PAYLOAD));
    expect(slot).toMatchObject({
      slotId: "slot-1",
      gameId: GAME_ID,
      formatVersion: 1,
      gameVersion: GAME_VERSION,
      createdAtUnixMs: FIXED_MS,
      updatedAtUnixMs: FIXED_MS,
      bytes: 85,
      readable: true,
      error: null,
    });
    expectBytes(expectOk(await api.read("slot-1")), PAYLOAD);

    const record = await idbRecord(factory, GAME_ID, "slot-1");
    if (record === undefined) throw new Error("expected an IndexedDB record");
    expect(Object.keys(record).sort()).toEqual([
      "file",
      "gameId",
      "meta",
      "slotId",
    ]);
    expect(record["gameId"]).toBe(GAME_ID);
    expect(record["slotId"]).toBe("slot-1");
    const file = record["file"];
    if (!(file instanceof ArrayBuffer)) {
      throw new Error("expected the record file to be an ArrayBuffer");
    }
    expectBytes(new Uint8Array(file), hexToBytes(GOLDEN_HEX));
    expect(record["meta"]).toMatchObject({
      metaVersion: 1,
      slotId: "slot-1",
      gameId: GAME_ID,
      sdkVersion: RUNTIME_SDK_VERSION,
      createdAtUnixMs: FIXED_MS,
      updatedAtUnixMs: FIXED_MS,
      payloadSha256: null,
      bytes: 85,
    });

    const slots = expectOk(await api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      slotId: "slot-1",
      gameId: GAME_ID,
      readable: true,
      error: null,
      bytes: 85,
      updatedAtUnixMs: FIXED_MS,
    });
    expectErr(await api.read("missing"), "E_SAVE_SLOT");
    api.dispose();
  });

  test("[ER-15-09] IndexedDB replace and remove are atomic and idempotent", async () => {
    const { factory, api } = makeIdbApi();
    expectOk(await api.write("slot-1", PAYLOAD));
    expectOk(await api.write("slot-1", OTHER_PAYLOAD));
    expectBytes(expectOk(await api.read("slot-1")), OTHER_PAYLOAD);
    expect(expectOk(await api.list())).toHaveLength(1);

    const record = await idbRecord(factory, GAME_ID, "slot-1");
    const file = record?.["file"];
    if (!(file instanceof ArrayBuffer)) {
      throw new Error("expected the record file to be an ArrayBuffer");
    }
    const stored = new Uint8Array(file);
    expectBytes(
      stored.subarray(stored.byteLength - OTHER_PAYLOAD.byteLength),
      OTHER_PAYLOAD,
    );

    expectOk(await api.remove("slot-1"));
    expectErr(await api.read("slot-1"), "E_SAVE_SLOT");
    expect(expectOk(await api.list())).toHaveLength(0);
    expectOk(await api.remove("slot-1"));
    expect(await idbRecord(factory, GAME_ID, "slot-1")).toBeUndefined();
    api.dispose();
  });

  test("[ER-15-02] a corrupt IndexedDB record is listed unreadable and never deleted", async () => {
    const { factory, storage, api } = makeIdbApi();
    await storage.ready?.();
    const corrupt = new TextEncoder().encode("not-a-save");
    await idbPut(factory, {
      gameId: GAME_ID,
      slotId: "bad",
      file: corrupt.buffer,
      meta: null,
    });

    const slots = expectOk(await api.list());
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      slotId: "bad",
      readable: false,
      error: "E_SAVE_FORMAT",
      bytes: 10,
    });
    expectErr(await api.read("bad"), "E_SAVE_FORMAT");
    expect(await idbRecord(factory, GAME_ID, "bad")).toBeDefined();

    expectOk(await api.remove("bad"));
    expect(await idbRecord(factory, GAME_ID, "bad")).toBeUndefined();
    api.dispose();
  });

  test("[ER-15-11] IndexedDB isolates games by composite key", async () => {
    const factory = new FakeIndexedDBFactory();
    const first = makeIdbApi(factory, GAME_ID);
    const second = makeIdbApi(factory, "other-game");

    expectOk(await first.api.write("slot-1", PAYLOAD));
    expectOk(await second.api.write("slot-1", OTHER_PAYLOAD));

    expectBytes(expectOk(await first.api.read("slot-1")), PAYLOAD);
    expectBytes(expectOk(await second.api.read("slot-1")), OTHER_PAYLOAD);
    const firstSlots = expectOk(await first.api.list());
    expect(firstSlots).toHaveLength(1);
    expect(firstSlots[0]).toMatchObject({ gameId: GAME_ID });
    const secondSlots = expectOk(await second.api.list());
    expect(secondSlots).toHaveLength(1);
    expect(secondSlots[0]).toMatchObject({ gameId: "other-game" });

    expectOk(await first.api.remove("slot-1"));
    expectErr(await first.api.read("slot-1"), "E_SAVE_SLOT");
    expectBytes(expectOk(await second.api.read("slot-1")), OTHER_PAYLOAD);
    expect(await idbRecord(factory, GAME_ID, "slot-1")).toBeUndefined();
    expect(await idbRecord(factory, "other-game", "slot-1")).toBeDefined();

    first.api.dispose();
    second.api.dispose();
  });

  test("[ER-15-07] IndexedDB quota and abort map to E_SAVE_QUOTA and E_SAVE_IO", async () => {
    const quotaFactory = new FakeIdbFailureFactory(
      "quota",
    ) as unknown as IDBFactory;
    const quotaStorage = createIdbSaveStorage(GAME_ID, {
      factory: quotaFactory,
    });
    await quotaStorage.ready?.();
    const quotaApi = expectOk(
      createHostSaveApi({
        gameId: GAME_ID,
        gameVersion: GAME_VERSION,
        storage: quotaStorage,
        now: () => FIXED_MS,
      }),
    );
    const quota = expectErr(
      await quotaApi.write("slot-1", PAYLOAD),
      "E_SAVE_QUOTA",
    );
    expect(quota.recoverable).toBe(true);

    const abortFactory = new FakeIdbFailureFactory(
      "abort",
    ) as unknown as IDBFactory;
    const abortStorage = createIdbSaveStorage(GAME_ID, {
      factory: abortFactory,
    });
    await abortStorage.ready?.();
    const abortApi = expectOk(
      createHostSaveApi({
        gameId: GAME_ID,
        gameVersion: GAME_VERSION,
        storage: abortStorage,
        now: () => FIXED_MS,
      }),
    );
    const io = expectErr(await abortApi.write("slot-1", PAYLOAD), "E_SAVE_IO");
    expect(io.recoverable).toBe(true);

    quotaApi.dispose();
    abortApi.dispose();
  });

  test("[ER-15-10] an IndexedDB that fails to open yields E_SAVE_IO and no capability", async () => {
    const factory = new FakeIdbOpenFailureFactory() as unknown as IDBFactory;
    const env: BrowserSaveEnvironment = { indexedDB: factory };
    expectErr(
      await createBrowserSaveApi(MANIFEST, GAME_ID, {
        env,
        now: () => FIXED_MS,
      }),
      "E_SAVE_IO",
    );
    const provider = createBrowserSaveCapability({ env, now: () => FIXED_MS });
    await expect(
      provider({ manifest: MANIFEST, gameId: GAME_ID }),
    ).resolves.toBeUndefined();
    expect(
      await createBrowserSaveApi(MANIFEST, GAME_ID, {
        env: {},
        now: () => FIXED_MS,
      }),
    ).toMatchObject({ ok: false, error: { code: "E_SAVE_IO" } });
  });
});

/* ------------------------------------------------------------------ */
/* async provider resolution before init                              */
/* ------------------------------------------------------------------ */

function makeProbeGame(onInit: (context: GameContext) => void): Game {
  return {
    manifest: MANIFEST,
    init(context: GameContext): void {
      onInit(context);
    },
    simulate(): void {},
    render(): void {},
    dispose(): void {},
  };
}

function makeHost(game: Game): GameHost {
  const frames = new FakeFrames();
  return new GameHost({
    game,
    renderer: new RecordingRenderer(),
    audio: silentAudio(),
    mapper: new InputMapper(),
    now: frames.now,
    raf: frames.raf,
    cancel: frames.cancel,
    gameId: GAME_ID,
  });
}

describe("async save provider resolution [ER-15-01, ER-15-10]", () => {
  test("[ER-15-10] GameHost awaits an async provider before game.init", async () => {
    const factory = new FakeIndexedDBFactory();
    installRuntimeCapabilities({
      save: createBrowserSaveCapability({
        env: { indexedDB: factory },
        now: () => FIXED_MS,
      }),
    });

    let seen: SaveApi | undefined;
    let sawSaveKey = false;
    const host = makeHost(
      makeProbeGame((context) => {
        seen = context.save;
        sawSaveKey = "save" in context;
      }),
    );

    await host.start();
    expect(sawSaveKey).toBe(true);
    const save = seen;
    if (save === undefined) throw new Error("expected ctx.save after init");
    expect(save.gameId).toBe(GAME_ID);
    expectOk(await save.write("slot-1", PAYLOAD));
    expectBytes(expectOk(await save.read("slot-1")), PAYLOAD);
    expect(host.phase).toBe("playing");
    host.dispose();
  });

  test("[ER-15-10] a failed async open leaves save absent before game.init", async () => {
    installRuntimeCapabilities({
      save: createBrowserSaveCapability({
        env: {
          isSecureContext: true,
          moveSupported: true,
          storage: {
            getDirectory: async (): Promise<OpfsDirectoryHandleLike> => {
              throw securityError();
            },
          },
        },
        now: () => FIXED_MS,
      }),
    });

    let sawSave = true;
    let sawSaveKey = true;
    const host = makeHost(
      makeProbeGame((context) => {
        sawSave = context.save !== undefined;
        sawSaveKey = "save" in context;
      }),
    );

    await host.start();
    expect(sawSave).toBe(false);
    expect(sawSaveKey).toBe(false);
    expect(host.phase).toBe("playing");
    host.dispose();
  });
});

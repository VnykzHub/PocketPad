/**
 * Host-side save/load API (spec 15 §3.8) over an injected storage adapter.
 *
 * Spec 15 keeps the `.pps` codec pure in `@lanpad/engine-core`; this module is
 * the runtime binding that supplies a storage adapter, a wall clock and the
 * game/sdk versions, then projects the result onto the SDK's `SaveApi`.
 *
 * Storage is injected so Node tests run against an in-memory map with no DOM.
 * The production tiers are the ones spec 15 §4.11/§5.5 names: OPFS with an
 * atomic `move()` commit when the context is secure and `FileSystemFileHandle
 * .prototype.move` exists, otherwise IndexedDB with one `readwrite`
 * transaction per save. `localStorage` is deliberately not a production
 * adapter (synchronous, ~5 MiB, string-only, no atomic replace); the
 * Map-shaped double below is test-only and is never referenced by host code. The engine contract's `SaveStorageAdapter.kind` has no test-double
 * member, so this module declares its own `SaveStorage`, structurally
 * compatible with the frozen type for `opfs`, `indexeddb` and `memory`.
 * No payload, token or PII is ever logged or put into an error message.
 *
 * Reads verify structure, game id and the FNV-1a 32 of the stored payload via
 * `decodeSaveFile` before any bytes reach the game (15 I3). Writes build and
 * verify the complete file in memory, then commit through the adapter's
 * `writeAtomic` (15 I2). The payload is opaque and uncompressed: this binding
 * supplies no `SaveCodec`, which spec 15 §4.4 explicitly allows. A compressed
 * file is a valid file this reader cannot decode and returns
 * `E_SAVE_UNSUPPORTED`.
 */
import {
  ENGINE_VERSION,
  SAVE_DEFAULT_MAX_SLOTS,
  SAVE_FLAG_DEFLATE,
  SAVE_FORMAT_VERSION,
  SAVE_GAME_ID_PATTERN,
  SAVE_MAX_GAME_ID_BYTES,
  SAVE_MAX_PAYLOAD_BYTES,
  SAVE_SLOT_ID_PATTERN,
  createSaveHeader,
  decodeSaveFile,
  decodeSaveHeader,
  encodeSaveFile,
} from "@lanpad/engine-core";
import type {
  SaveHeader,
  SaveSlotMeta,
  SaveStorageEntry,
} from "@lanpad/engine-core";
import type {
  GameManifest,
  SaveApi,
  SaveErrorCode,
  SaveResult,
  SaveSlot,
} from "@lanpad/sdk";

/**
 * `sdk/package.json` version at host build time. The SDK has no
 * `SDK_VERSION` export today; `SaveSlotMeta.sdkVersion` is diagnostic only,
 * and the SDK's public `SaveSlot` projection does not carry it.
 */
export const RUNTIME_SDK_VERSION = "0.0.0" as const;

/** Root of every key this module writes. Versioned so a layout change is explicit. */
export const SAVE_KEY_PREFIX = "pocketpad.saves.v1" as const;

const PPS_SUFFIX = ".pps";
const META_SUFFIX = ".meta.json";
const TEMP_SUFFIX = ".tmp";
const UTF8_ENCODER = new TextEncoder();
const EMPTY_PAYLOAD = new Uint8Array(0);

/** Production tiers match the frozen `SaveStorageAdapter` union (15 §3.7). */
export type SaveStorageKind =
  | "opfs"
  | "indexeddb"
  | "memory"
  | "test-localstorage";

/**
 * Injected storage seam, structurally the engine's `SaveStorageAdapter`
 * (15 §3.7); `test-localstorage` exists only for the Node test double. An
 * adapter must commit all-or-nothing.
 */
export interface SaveStorage {
  readonly kind: SaveStorageKind;
  /**
   * Optional: resolves after the backing store is open and stale `*.tmp`
   * files are gone. `createBrowserSaveApi` awaits it so an unusable tier
   * leaves `ctx.save` undefined (15 §5.5 tier 3).
   */
  ready?(): Promise<void>;
  list(): Promise<readonly SaveStorageEntry[]>;
  read(slotId: string): Promise<Uint8Array | undefined>;
  writeAtomic(
    slotId: string,
    file: Uint8Array,
    meta: SaveSlotMeta,
  ): Promise<void>;
  remove(slotId: string): Promise<void>;
  dispose(): void;
}

/** The two expected storage failures (15 §3.7); anything else becomes E_SAVE_IO. */
export class SaveStorageFailure extends Error {
  readonly code: "E_SAVE_QUOTA" | "E_SAVE_IO";

  constructor(code: "E_SAVE_QUOTA" | "E_SAVE_IO", message: string) {
    super(message);
    this.name = "SaveStorageFailure";
    this.code = code;
  }
}

/** The concrete API also owns adapter teardown; games only see `SaveApi`. */
export interface HostSaveApi extends SaveApi {
  /** Idempotent; no callback runs afterwards (15 §3.6). */
  dispose(): void;
}

export interface HostSaveApiOptions {
  /** Manifest slug / game folder name (15 §4.3). */
  readonly gameId: string;
  /** Manifest `version` or an explicit host-supplied version. */
  readonly gameVersion?: string;
  readonly sdkVersion?: string;
  readonly engineVersion?: string;
  /** Epoch milliseconds UTC; injected so tests never read the real clock. */
  readonly now?: () => number;
  readonly maxSlots?: number;
  readonly storage: SaveStorage;
}

const RECOVERABLE: Readonly<Record<SaveErrorCode, boolean>> = Object.freeze({
  E_SAVE_FORMAT: false,
  E_SAVE_VERSION: false,
  E_SAVE_HASH: false,
  E_SAVE_GAME: false,
  E_SAVE_QUOTA: true,
  E_SAVE_IO: true,
  E_SAVE_MIGRATION: false,
  E_SAVE_SLOT: false,
  E_SAVE_UNSUPPORTED: false,
});

function ok<T>(value: T): SaveResult<T> {
  return { ok: true, value };
}

function fail<T>(code: SaveErrorCode, message: string): SaveResult<T> {
  return { ok: false, error: { code, message, recoverable: RECOVERABLE[code] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The save code carried by a codec `SaveEngineError`, else `fallback`. */
function engineSaveCode(error: unknown, fallback: SaveErrorCode): SaveErrorCode {
  if (isRecord(error)) {
    const code = error["code"];
    if (
      typeof code === "string" &&
      Object.prototype.hasOwnProperty.call(RECOVERABLE, code)
    ) {
      return code as SaveErrorCode;
    }
  }
  return fallback;
}

/** Redacted: names the slot (already pattern-checked) and the stable code only. */
function codecFailure<T>(error: unknown, slotId: string | null): SaveResult<T> {
  const code = engineSaveCode(error, "E_SAVE_FORMAT");
  return fail(
    code,
    slotId === null
      ? `save configuration is invalid (${code})`
      : `save slot "${slotId}" is not readable (${code})`,
  );
}

function storageFailure<T>(
  error: unknown,
  slotId: string | null,
): SaveResult<T> {
  const code =
    error instanceof SaveStorageFailure ? error.code : ("E_SAVE_IO" as const);
  const where =
    slotId === null ? "save storage" : `save storage for slot "${slotId}"`;
  return fail(
    code,
    code === "E_SAVE_QUOTA" ? `${where} is full` : `${where} is unavailable`,
  );
}

/** Returns a failure for an invalid slot id, else null. Never echoes the id. */
function checkSlotId(slotId: string): SaveResult<never> | null {
  if (typeof slotId !== "string" || !SAVE_SLOT_ID_PATTERN.test(slotId)) {
    return fail(
      "E_SAVE_SLOT",
      "save slot id must match ^[a-z0-9][a-z0-9_-]{0,31}$",
    );
  }
  return null;
}

function validGameId(gameId: string): boolean {
  return (
    typeof gameId === "string" &&
    SAVE_GAME_ID_PATTERN.test(gameId) &&
    UTF8_ENCODER.encode(gameId).length <= SAVE_MAX_GAME_ID_BYTES
  );
}

interface SlotViewInput {
  readonly slotId: string;
  readonly header: SaveHeader | null;
  readonly gameId: string;
  readonly updatedAtUnixMs: number;
  readonly bytes: number;
  readonly readable: boolean;
  readonly error: SaveErrorCode | null;
  readonly fallbackCreatedAtUnixMs?: number;
}

/**
 * Projects the frozen header plus storage metadata onto the SDK's `SaveSlot`.
 * For an unreadable slot the header fields are unknown; the row keeps the
 * slot's storage address and bytes so a UI can still offer an explicit
 * `remove()` (15 I1). Timestamps fall back to metadata, then to 0.
 */
function slotView(input: SlotViewInput): SaveSlot {
  const header = input.header;
  const createdAtUnixMs =
    header !== null
      ? header.createdAtUnixSeconds * 1000
      : (input.fallbackCreatedAtUnixMs ?? 0);
  const updatedAtUnixMs =
    input.updatedAtUnixMs > 0 ? input.updatedAtUnixMs : createdAtUnixMs;
  return {
    slotId: input.slotId,
    gameId: header?.gameId ?? input.gameId,
    formatVersion: header?.formatVersion ?? 0,
    gameVersion: header?.gameVersion ?? "",
    createdAtUnixMs,
    updatedAtUnixMs,
    payloadBytes: header?.payloadBytes ?? 0,
    payloadUncompressedBytes: header?.payloadUncompressedBytes ?? 0,
    bytes: input.bytes,
    readable: input.readable,
    error: input.error,
  };
}

/**
 * Builds a `SaveApi` over `options.storage`.
 *
 * Returns `E_SAVE_IO` when storage is missing, `E_SAVE_GAME` for an invalid
 * game id, `E_SAVE_FORMAT` when the game version cannot produce a valid frozen
 * header (including a manifest with no `version` and no explicit runtime
 * version), and `E_SAVE_SLOT` for an invalid `maxSlots`. A host that gets a
 * failure installs no `ctx.save` instead of a throwing stub (15 §3.8).
 */
export function createHostSaveApi(
  options: HostSaveApiOptions,
): SaveResult<HostSaveApi> {
  if (options.storage === undefined) {
    return fail("E_SAVE_IO", "save storage is unavailable");
  }
  const gameId = options.gameId;
  if (!validGameId(gameId)) {
    return fail("E_SAVE_GAME", "save game id is not a valid manifest slug");
  }
  const gameVersion = options.gameVersion;
  if (typeof gameVersion !== "string" || gameVersion.length === 0) {
    return fail(
      "E_SAVE_FORMAT",
      "gameVersion is required when the manifest has no version",
    );
  }
  // Re-bind after the guard: closures below read the narrowed string.
  const resolvedGameVersion: string = gameVersion;
  const engineVersion = options.engineVersion ?? ENGINE_VERSION;
  const sdkVersion = options.sdkVersion ?? RUNTIME_SDK_VERSION;
  const maxSlots = options.maxSlots ?? SAVE_DEFAULT_MAX_SLOTS;
  if (!Number.isInteger(maxSlots) || maxSlots < 1) {
    return fail("E_SAVE_SLOT", "maxSlots must be a positive integer");
  }
  const clock = options.now ?? ((): number => Date.now());
  const storage = options.storage;

  // Validate every header field once through the frozen codec, with an empty
  // payload and no I/O, so a bad version/gameId fails at install time rather
  // than on the first write.
  try {
    createSaveHeader({
      engineVersion,
      gameId,
      gameVersion,
      createdAtUnixMs: clock(),
      storedPayload: EMPTY_PAYLOAD,
    });
  } catch (error) {
    return codecFailure(error, null);
  }

  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      storage.dispose();
    } catch {
      // Teardown must never throw; the adapter is already unreachable.
    }
  }

  async function describeEntry(entry: SaveStorageEntry): Promise<SaveSlot> {
    const meta = entry.meta;
    const updatedAtUnixMs =
      entry.updatedAtUnixMs > 0
        ? entry.updatedAtUnixMs
        : (meta?.updatedAtUnixMs ?? 0);
    const fallbackCreatedAtUnixMs = meta?.createdAtUnixMs;
    const fallback =
      fallbackCreatedAtUnixMs === undefined
        ? {}
        : { fallbackCreatedAtUnixMs };
    let file: Uint8Array | undefined;
    try {
      file = await storage.read(entry.slotId);
    } catch {
      return slotView({
        slotId: entry.slotId,
        header: null,
        gameId,
        updatedAtUnixMs,
        bytes: entry.bytes,
        readable: false,
        error: "E_SAVE_IO",
        ...fallback,
      });
    }
    if (file === undefined) {
      return slotView({
        slotId: entry.slotId,
        header: null,
        gameId,
        updatedAtUnixMs,
        bytes: entry.bytes,
        readable: false,
        error: "E_SAVE_IO",
        ...fallback,
      });
    }
    let header: SaveHeader;
    try {
      header = decodeSaveHeader(file);
    } catch (error) {
      return slotView({
        slotId: entry.slotId,
        header: null,
        gameId,
        updatedAtUnixMs,
        bytes: file.byteLength,
        readable: false,
        error: engineSaveCode(error, "E_SAVE_FORMAT"),
        ...fallback,
      });
    }
    if (header.gameId !== gameId) {
      return slotView({
        slotId: entry.slotId,
        header,
        gameId,
        updatedAtUnixMs,
        bytes: file.byteLength,
        readable: false,
        error: "E_SAVE_GAME",
      });
    }
    if (header.formatVersion !== SAVE_FORMAT_VERSION) {
      // No migration chain exists in this binding (15 §4.8); a v1 reader
      // cannot interpret an older container as-is.
      return slotView({
        slotId: entry.slotId,
        header,
        gameId,
        updatedAtUnixMs,
        bytes: file.byteLength,
        readable: false,
        error: "E_SAVE_MIGRATION",
      });
    }
    return slotView({
      slotId: entry.slotId,
      header,
      gameId,
      updatedAtUnixMs,
      bytes: file.byteLength,
      readable: true,
      error: null,
    });
  }

  async function list(): Promise<SaveResult<readonly SaveSlot[]>> {
    if (disposed) return fail("E_SAVE_IO", "save storage is disposed");
    let entries: readonly SaveStorageEntry[];
    try {
      entries = await storage.list();
    } catch (error) {
      return storageFailure(error, null);
    }
    const slots: SaveSlot[] = [];
    for (const entry of entries) {
      if (!SAVE_SLOT_ID_PATTERN.test(entry.slotId)) continue;
      slots.push(await describeEntry(entry));
    }
    slots.sort(
      (left, right) =>
        right.updatedAtUnixMs - left.updatedAtUnixMs ||
        left.slotId.localeCompare(right.slotId),
    );
    return ok(slots);
  }

  async function read(slotId: string): Promise<SaveResult<Uint8Array>> {
    const invalid = checkSlotId(slotId);
    if (invalid !== null) return invalid;
    if (disposed) return fail("E_SAVE_IO", "save storage is disposed");
    let file: Uint8Array | undefined;
    try {
      file = await storage.read(slotId);
    } catch (error) {
      return storageFailure(error, slotId);
    }
    if (file === undefined) {
      return fail("E_SAVE_SLOT", `save slot "${slotId}" does not exist`);
    }
    let decoded: ReturnType<typeof decodeSaveFile>;
    try {
      decoded = decodeSaveFile(file, gameId);
    } catch (error) {
      return codecFailure(error, slotId);
    }
    if ((decoded.header.flags & SAVE_FLAG_DEFLATE) !== 0) {
      return fail(
        "E_SAVE_UNSUPPORTED",
        `save slot "${slotId}" is compressed and this host has no decompression codec`,
      );
    }
    return ok(decoded.storedPayload);
  }

  async function write(
    slotId: string,
    payload: Uint8Array,
  ): Promise<SaveResult<SaveSlot>> {
    const invalid = checkSlotId(slotId);
    if (invalid !== null) return invalid;
    if (disposed) return fail("E_SAVE_IO", "save storage is disposed");
    if (!(payload instanceof Uint8Array)) {
      return fail("E_SAVE_FORMAT", "save payload must be a Uint8Array");
    }
    if (payload.byteLength > SAVE_MAX_PAYLOAD_BYTES) {
      return fail(
        "E_SAVE_FORMAT",
        `save payload exceeds ${SAVE_MAX_PAYLOAD_BYTES} bytes`,
      );
    }

    let entries: readonly SaveStorageEntry[];
    try {
      entries = await storage.list();
    } catch (error) {
      return storageFailure(error, slotId);
    }
    let exists = false;
    for (const entry of entries) {
      if (entry.slotId === slotId) {
        exists = true;
        break;
      }
    }
    if (!exists && entries.length >= maxSlots) {
      return fail("E_SAVE_SLOT", `save slot limit ${maxSlots} reached`);
    }

    const createdAtUnixMs = clock();
    let header: SaveHeader;
    let file: Uint8Array;
    try {
      // Uncompressed by construction: no SaveCodec is supplied (15 §4.4).
      header = createSaveHeader({
        engineVersion,
        gameId,
        gameVersion: resolvedGameVersion,
        createdAtUnixMs,
        storedPayload: payload,
      });
      // Builds and re-verifies the complete file before the commit point.
      file = encodeSaveFile(header, payload);
    } catch (error) {
      return codecFailure(error, slotId);
    }

    const updatedAtUnixMs = Math.max(0, Math.floor(createdAtUnixMs));
    const meta: SaveSlotMeta = {
      metaVersion: 1,
      slotId,
      gameId,
      sdkVersion,
      createdAtUnixMs: header.createdAtUnixSeconds * 1000,
      updatedAtUnixMs,
      payloadSha256: null,
      bytes: file.byteLength,
    };
    try {
      await storage.writeAtomic(slotId, file, meta);
    } catch (error) {
      return storageFailure(error, slotId);
    }
    return ok(
      slotView({
        slotId,
        header,
        gameId,
        updatedAtUnixMs,
        bytes: file.byteLength,
        readable: true,
        error: null,
      }),
    );
  }

  async function remove(slotId: string): Promise<SaveResult<void>> {
    const invalid = checkSlotId(slotId);
    if (invalid !== null) return invalid;
    if (disposed) return fail("E_SAVE_IO", "save storage is disposed");
    try {
      await storage.remove(slotId);
    } catch (error) {
      return storageFailure(error, slotId);
    }
    return ok(undefined);
  }

  return ok({
    gameId,
    list,
    read,
    write,
    remove,
    dispose,
  });
}

/* -------------------------------------------------------------------------
 * Storage tiers (15 §4.11, §5.5): OPFS primary, IndexedDB fallback
 * ---------------------------------------------------------------------- */

/** OPFS root and per-game folder names (15 §4.11). */
export const SAVE_OPFS_ROOT = "pocketpad" as const;
export const SAVE_OPFS_SAVES = "saves" as const;
/** IndexedDB database/store/version (15 §4.11). */
export const SAVE_IDB_DATABASE = "pocketpad-saves" as const;
export const SAVE_IDB_STORE = "saves" as const;
export const SAVE_IDB_VERSION = 1 as const;

/** Minimal OPFS surface; `FileSystemDirectoryHandle` is structurally compatible. */
export interface OpfsFileLike {
  readonly size: number;
  readonly lastModified?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface OpfsWritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface OpfsFileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<OpfsFileLike>;
  createWritable(options?: {
    keepExistingData?: boolean;
  }): Promise<OpfsWritableLike>;
  /** Atomic OPFS replace; tier selection refuses a browser without it. */
  move?(destination: OpfsDirectoryHandleLike, name: string): Promise<void>;
}

export interface OpfsDirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsFileHandleLike>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<
    [string, OpfsFileHandleLike | OpfsDirectoryHandleLike]
  >;
}

/** The browser globals the tier selection reads (all injectable for tests). */
export interface BrowserSaveEnvironment {
  readonly isSecureContext?: boolean;
  readonly storage?: {
    readonly getDirectory?: () => Promise<OpfsDirectoryHandleLike>;
  };
  readonly indexedDB?: IDBFactory;
  /** Tests inject this; omitted means detect `FileSystemFileHandle.prototype.move`. */
  readonly moveSupported?: boolean;
}

export type BrowserSaveStorageKind = "opfs" | "indexeddb" | "none";

function supportsFileHandleMove(): boolean {
  try {
    const ctor = (
      globalThis as { FileSystemFileHandle?: { prototype?: object } }
    ).FileSystemFileHandle;
    const prototype = ctor?.prototype;
    return (
      prototype !== undefined &&
      typeof (prototype as { move?: unknown }).move === "function"
    );
  } catch {
    return false;
  }
}

/** Reads the real browser globals; every member is optional so Node is safe. */
export function detectBrowserSaveEnvironment(): BrowserSaveEnvironment {
  let secure = false;
  try {
    secure = (globalThis as { isSecureContext?: boolean }).isSecureContext === true;
  } catch {
    secure = false;
  }
  let storage: BrowserSaveEnvironment["storage"];
  try {
    const navigatorStorage = (
      globalThis as {
        navigator?: { storage?: { getDirectory?: unknown } };
      }
    ).navigator?.storage;
    if (
      navigatorStorage !== undefined &&
      typeof navigatorStorage.getDirectory === "function"
    ) {
      storage = {
        getDirectory: () =>
          (
            navigatorStorage.getDirectory as () => Promise<OpfsDirectoryHandleLike>
          ).call(navigatorStorage),
      };
    }
  } catch {
    storage = undefined;
  }
  let indexedDBValue: IDBFactory | undefined;
  try {
    indexedDBValue = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  } catch {
    indexedDBValue = undefined;
  }
  return {
    isSecureContext: secure,
    ...(storage === undefined ? {} : { storage }),
    ...(indexedDBValue === undefined ? {} : { indexedDB: indexedDBValue }),
    moveSupported: supportsFileHandleMove(),
  };
}

/**
 * Spec 15 §5.5, evaluated once at store creation:
 * 1. secure context + `navigator.storage.getDirectory` + atomic `move()`,
 * 2. `indexedDB` exists,
 * 3. neither → no store (`ctx.save` undefined).
 */
export function selectBrowserSaveStorageKind(
  env: BrowserSaveEnvironment = detectBrowserSaveEnvironment(),
): BrowserSaveStorageKind {
  if (
    env.isSecureContext === true &&
    env.storage?.getDirectory !== undefined &&
    env.moveSupported === true
  ) {
    return "opfs";
  }
  if (env.indexedDB !== undefined) return "indexeddb";
  return "none";
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error["name"] === "NotFoundError";
}

function opfsFailure(error: unknown): SaveStorageFailure {
  if (error instanceof SaveStorageFailure) return error;
  return storageFailureFrom(error);
}

/**
 * OPFS adapter (15 §5.6): write `<slotId>.tmp`, then `move()` it over
 * `<slotId>.pps`; metadata follows through its own temp+move. The destination
 * is never deleted first (delete-then-rename is not atomic). `root` is the
 * origin directory; the adapter creates `pocketpad/saves/<gameId>/`.
 */
export function createOpfsSaveStorage(
  gameId: string,
  root: OpfsDirectoryHandleLike | Promise<OpfsDirectoryHandleLike>,
): SaveStorage {
  let directory: OpfsDirectoryHandleLike | null = null;
  let readyPromise: Promise<void> | null = null;

  const openDirectory = async (): Promise<OpfsDirectoryHandleLike> => {
    const origin = await root;
    const pocketpad = await origin.getDirectoryHandle(SAVE_OPFS_ROOT, {
      create: true,
    });
    const saves = await pocketpad.getDirectoryHandle(SAVE_OPFS_SAVES, {
      create: true,
    });
    return saves.getDirectoryHandle(gameId, { create: true });
  };

  /** Only transient `*.tmp` names are removed (15 I1). */
  const cleanTemps = async (dir: OpfsDirectoryHandleLike): Promise<void> => {
    const stale: string[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && name.endsWith(TEMP_SUFFIX)) {
        stale.push(name);
      }
    }
    for (const name of stale) {
      try {
        await dir.removeEntry(name);
      } catch {
        // A stuck temp file is never listed or read.
      }
    }
  };

  const ensureReady = async (): Promise<OpfsDirectoryHandleLike> => {
    if (directory !== null) return directory;
    if (readyPromise === null) {
      readyPromise = openDirectory().then(async (dir) => {
        await cleanTemps(dir);
        directory = dir;
      });
    }
    await readyPromise;
    if (directory === null) {
      throw new SaveStorageFailure(
        "E_SAVE_IO",
        "save storage is unavailable",
      );
    }
    return directory;
  };

  const readMeta = async (
    dir: OpfsDirectoryHandleLike,
    slotId: string,
  ): Promise<SaveSlotMeta | null> => {
    try {
      const handle = await dir.getFileHandle(`${slotId}${META_SUFFIX}`);
      const file = await handle.getFile();
      return parseMeta(await file.text(), slotId, gameId);
    } catch {
      // Metadata is a disposable cache; a bad/missing sidecar is ignored and
      // the `.pps` remains authoritative (15 §4.10).
      return null;
    }
  };

  const removeIfPresent = async (
    dir: OpfsDirectoryHandleLike,
    name: string,
  ): Promise<void> => {
    try {
      await dir.removeEntry(name);
    } catch (error) {
      if (!isNotFound(error)) throw opfsFailure(error);
    }
  };

  const writeMetaBestEffort = async (
    dir: OpfsDirectoryHandleLike,
    slotId: string,
    meta: SaveSlotMeta,
  ): Promise<void> => {
    const tempName = `${slotId}${META_SUFFIX}${TEMP_SUFFIX}`;
    try {
      const temp = await dir.getFileHandle(tempName, { create: true });
      const writable = await temp.createWritable();
      await writable.write(UTF8_ENCODER.encode(JSON.stringify(meta)));
      await writable.close();
      const move = temp.move;
      if (typeof move !== "function") {
        throw new SaveStorageFailure(
          "E_SAVE_IO",
          "atomic move is unavailable",
        );
      }
      await move.call(temp, dir, `${slotId}${META_SUFFIX}`);
    } catch {
      // A metadata failure after the `.pps` commit still leaves a valid save
      // (15 §5.3); the sidecar is ignored and rewritten on the next write.
      try {
        await dir.removeEntry(tempName);
      } catch {
        // Cleaned at the next store init.
      }
    }
  };

  return {
    kind: "opfs",
    ready: async (): Promise<void> => {
      await ensureReady();
    },
    async list(): Promise<readonly SaveStorageEntry[]> {
      const dir = await ensureReady();
      const entries: SaveStorageEntry[] = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "file" || !name.endsWith(PPS_SUFFIX)) continue;
        const slotId = name.slice(0, name.length - PPS_SUFFIX.length);
        if (!SAVE_SLOT_ID_PATTERN.test(slotId)) continue;
        let bytes = 0;
        let lastModified = 0;
        try {
          const file = await handle.getFile();
          bytes = file.size;
          lastModified = file.lastModified ?? 0;
        } catch {
          // Keep the slot visible; read() reports the storage failure.
        }
        const meta = await readMeta(dir, slotId);
        entries.push({
          slotId,
          bytes,
          updatedAtUnixMs: meta?.updatedAtUnixMs ?? lastModified,
          meta,
        });
      }
      return entries;
    },
    async read(slotId: string): Promise<Uint8Array | undefined> {
      const dir = await ensureReady();
      let handle: OpfsFileHandleLike;
      try {
        handle = await dir.getFileHandle(`${slotId}${PPS_SUFFIX}`);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw opfsFailure(error);
      }
      try {
        const file = await handle.getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        throw opfsFailure(error);
      }
    },
    async writeAtomic(
      slotId: string,
      file: Uint8Array,
      meta: SaveSlotMeta,
    ): Promise<void> {
      const dir = await ensureReady();
      // Spec 15 §5.6 step 1: the transient file is `<slotId>.tmp`.
      const tempName = `${slotId}${TEMP_SUFFIX}`;
      const finalName = `${slotId}${PPS_SUFFIX}`;
      try {
        const temp = await dir.getFileHandle(tempName, { create: true });
        const writable = await temp.createWritable();
        await writable.write(file);
        await writable.close();
        const move = temp.move;
        if (typeof move !== "function") {
          throw new SaveStorageFailure(
            "E_SAVE_IO",
            "atomic move is unavailable",
          );
        }
        // Atomic commit: the destination is replaced by move(), never by a
        // delete-then-rename (15 §5.6).
        await move.call(temp, dir, finalName);
      } catch (error) {
        try {
          await dir.removeEntry(tempName);
        } catch {
          // Cleaned at the next store init.
        }
        throw opfsFailure(error);
      }
      await writeMetaBestEffort(dir, slotId, meta);
    },
    async remove(slotId: string): Promise<void> {
      const dir = await ensureReady();
      await removeIfPresent(dir, `${slotId}${PPS_SUFFIX}`);
      await removeIfPresent(dir, `${slotId}${META_SUFFIX}`);
      await removeIfPresent(dir, `${slotId}${TEMP_SUFFIX}`);
    },
    dispose(): void {
      directory = null;
    },
  };
}

interface IdbSaveRecord {
  readonly gameId: string;
  readonly slotId: string;
  readonly file: ArrayBuffer;
  readonly meta: SaveSlotMeta | null;
}

export interface IdbSaveStorageOptions {
  readonly factory: IDBFactory;
  /** Test override; defaults to the spec 15 §4.11 database name. */
  readonly databaseName?: string;
}

/**
 * IndexedDB adapter (15 §5.6): one `readwrite` transaction stores the
 * complete `{ gameId, slotId, file, meta }` record. `oncomplete` is the
 * commit signal; an abort is `E_SAVE_IO`, `QuotaExceededError` is
 * `E_SAVE_QUOTA` (15 §5.5, §5.7).
 */
export function createIdbSaveStorage(
  gameId: string,
  options: IdbSaveStorageOptions,
): SaveStorage {
  const factory = options.factory;
  const databaseName = options.databaseName ?? SAVE_IDB_DATABASE;
  let database: IDBDatabase | null = null;
  let openPromise: Promise<IDBDatabase> | null = null;
  let disposed = false;

  const openDatabase = (): Promise<IDBDatabase> => {
    if (openPromise !== null) return openPromise;
    openPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(databaseName, SAVE_IDB_VERSION);
      } catch (error) {
        reject(storageFailureFrom(error));
        return;
      }
      request.onupgradeneeded = (): void => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SAVE_IDB_STORE)) {
          db.createObjectStore(SAVE_IDB_STORE, {
            keyPath: ["gameId", "slotId"],
          });
        }
      };
      request.onsuccess = (): void => {
        const db = request.result;
        if (disposed) {
          db.close();
          reject(
            new SaveStorageFailure("E_SAVE_IO", "save storage is disposed"),
          );
          return;
        }
        database = db;
        resolve(db);
      };
      request.onerror = (): void => {
        reject(storageFailureFrom(request.error));
      };
    });
    return openPromise;
  };

  const runTransaction = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T> | null,
  ): Promise<T | undefined> => {
    const db = await openDatabase();
    return new Promise<T | undefined>((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(SAVE_IDB_STORE, mode);
      } catch (error) {
        reject(storageFailureFrom(error));
        return;
      }
      let result: T | undefined;
      let requestError: unknown = null;
      let settled = false;
      const settle = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (error !== undefined && error !== null) {
          reject(storageFailureFrom(error));
        } else {
          resolve(result);
        }
      };
      transaction.oncomplete = (): void => settle();
      transaction.onabort = (): void =>
        settle(
          requestError ??
            transaction.error ??
            new SaveStorageFailure("E_SAVE_IO", "save transaction aborted"),
        );
      try {
        const request = run(transaction.objectStore(SAVE_IDB_STORE));
        if (request !== null) {
          request.onsuccess = (): void => {
            result = request.result;
          };
          request.onerror = (): void => {
            requestError = request.error;
          };
        }
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // Already aborted or complete.
        }
        settle(error);
      }
    });
  };

  return {
    kind: "indexeddb",
    ready: async (): Promise<void> => {
      await openDatabase();
    },
    async list(): Promise<readonly SaveStorageEntry[]> {
      const records = await runTransaction<unknown[]>("readonly", (store) =>
        store.getAll(),
      );
      const entries: SaveStorageEntry[] = [];
      for (const record of records ?? []) {
        if (!isRecord(record)) continue;
        const slotId = record["slotId"];
        if (typeof slotId !== "string" || !SAVE_SLOT_ID_PATTERN.test(slotId)) {
          continue;
        }
        if (record["gameId"] !== gameId) continue;
        const meta = normalizeMeta(record["meta"], slotId, gameId);
        const file = record["file"];
        let bytes = 0;
        if (file instanceof ArrayBuffer) {
          bytes = file.byteLength;
        } else if (ArrayBuffer.isView(file)) {
          bytes = file.byteLength;
        }
        entries.push({
          slotId,
          bytes,
          updatedAtUnixMs: meta?.updatedAtUnixMs ?? 0,
          meta,
        });
      }
      return entries;
    },
    async read(slotId: string): Promise<Uint8Array | undefined> {
      const record = await runTransaction<unknown>("readonly", (store) =>
        store.get([gameId, slotId]),
      );
      if (record === undefined) return undefined;
      if (!isRecord(record)) {
        // A damaged record stays visible (list) and fails the header check.
        return new Uint8Array(0);
      }
      const file = record["file"];
      if (file instanceof ArrayBuffer) {
        return new Uint8Array(file.slice(0));
      }
      if (ArrayBuffer.isView(file)) {
        return new Uint8Array(
          file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
        );
      }
      return new Uint8Array(0);
    },
    async writeAtomic(
      slotId: string,
      file: Uint8Array,
      meta: SaveSlotMeta,
    ): Promise<void> {
      const copy = new Uint8Array(file.byteLength);
      copy.set(file);
      const record: IdbSaveRecord = {
        gameId,
        slotId,
        file: copy.buffer,
        meta,
      };
      await runTransaction<void>("readwrite", (store) => {
        store.put(record);
        return null;
      });
    },
    async remove(slotId: string): Promise<void> {
      await runTransaction<void>("readwrite", (store) => {
        store.delete([gameId, slotId]);
        return null;
      });
    },
    dispose(): void {
      disposed = true;
      if (database !== null) {
        database.close();
        database = null;
      }
    },
  };
}

/* -------------------------------------------------------------------------
 * Test-only localStorage double (never used by production)
 * ---------------------------------------------------------------------- */

/** The subset of `Storage` this adapter needs; tests pass a Map-backed fake. */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): StorageLike | undefined {
  try {
    const candidate = (globalThis as { localStorage?: StorageLike })
      .localStorage;
    return candidate ?? undefined;
  } catch {
    // Accessing `localStorage` can throw SecurityError in a sandboxed frame.
    return undefined;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkBytes = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkBytes),
    );
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64ByteLength(text: string): number {
  if (text.length === 0) return 0;
  let padding = 0;
  if (text.endsWith("==")) padding = 2;
  else if (text.endsWith("=")) padding = 1;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

function storageFailureFrom(error: unknown): SaveStorageFailure {
  if (error instanceof SaveStorageFailure) return error;
  const name =
    isRecord(error) && typeof error["name"] === "string" ? error["name"] : "";
  const quota =
    name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
  return new SaveStorageFailure(
    quota ? "E_SAVE_QUOTA" : "E_SAVE_IO",
    quota ? "save storage is full" : "save storage is unavailable",
  );
}

/**
 * Validates sidecar metadata from an OPFS JSON file or an IndexedDB record.
 * Metadata is a disposable cache: a missing/malformed/different-version value
 * is ignored and rebuilt rather than treated as a save error (15 §4.10).
 */
function normalizeMeta(
  value: unknown,
  slotId: string,
  gameId: string,
): SaveSlotMeta | null {
  if (!isRecord(value)) return null;
  if (
    value["metaVersion"] !== 1 ||
    value["slotId"] !== slotId ||
    value["gameId"] !== gameId
  ) {
    return null;
  }
  const createdAtUnixMs = value["createdAtUnixMs"];
  const updatedAtUnixMs = value["updatedAtUnixMs"];
  const bytes = value["bytes"];
  const sdkVersion = value["sdkVersion"];
  const payloadSha256 = value["payloadSha256"];
  if (
    typeof createdAtUnixMs !== "number" ||
    !Number.isFinite(createdAtUnixMs) ||
    typeof updatedAtUnixMs !== "number" ||
    !Number.isFinite(updatedAtUnixMs) ||
    typeof bytes !== "number" ||
    !Number.isInteger(bytes) ||
    bytes < 0 ||
    typeof sdkVersion !== "string" ||
    (payloadSha256 !== null && typeof payloadSha256 !== "string")
  ) {
    return null;
  }
  return {
    metaVersion: 1,
    slotId,
    gameId,
    sdkVersion,
    createdAtUnixMs,
    updatedAtUnixMs,
    payloadSha256,
    bytes,
  };
}

function parseMeta(
  raw: string | null,
  slotId: string,
  gameId: string,
): SaveSlotMeta | null {
  if (raw === null) return null;
  try {
    return normalizeMeta(JSON.parse(raw), slotId, gameId);
  } catch {
    return null;
  }
}

/**
 * TEST-ONLY localStorage double for the original Node cases. Production uses
 * `createBrowserSaveStorage` (OPFS/IndexedDB); no host code references this
 * function. Returns `undefined` when `localStorage` is absent, throws on
 * access, or refuses the probe write (quota/security). Stale temp keys from a
 * failed write are removed at creation; no `.pps` or `.meta.json` is touched
 * (15 I1).
 */
export function createTestLocalStorageSaveStorage(
  gameId: string,
  override?: StorageLike,
): SaveStorage | undefined {
  if (!validGameId(gameId)) return undefined;
  const storage = override ?? browserStorage();
  if (storage === undefined) return undefined;

  const prefix = `${SAVE_KEY_PREFIX}.${gameId}.`;
  const probeKey = `${prefix}__probe__`;
  try {
    storage.setItem(probeKey, "1");
    storage.removeItem(probeKey);
  } catch {
    return undefined;
  }

  // Only transient temp keys are cleaned; a real save is never deleted.
  try {
    const stale: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(prefix) && key.endsWith(TEMP_SUFFIX)) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      try {
        storage.removeItem(key);
      } catch {
        // A stuck temp key is harmless: it is never listed or read.
      }
    }
  } catch {
    // Enumeration failing after a successful probe means the adapter will
    // fail its first list(); keep the store and report E_SAVE_IO there.
  }

  const ppsKey = (slotId: string): string => `${prefix}${slotId}${PPS_SUFFIX}`;
  const metaKey = (slotId: string): string =>
    `${prefix}${slotId}${META_SUFFIX}`;

  return {
    kind: "test-localstorage",
    async list(): Promise<readonly SaveStorageEntry[]> {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key !== null && key.startsWith(prefix) && key.endsWith(PPS_SUFFIX)) {
          keys.push(key);
        }
      }
      const entries: SaveStorageEntry[] = [];
      for (const key of keys) {
        const slotId = key.slice(prefix.length, key.length - PPS_SUFFIX.length);
        if (!SAVE_SLOT_ID_PATTERN.test(slotId)) continue;
        const raw = storage.getItem(key);
        const meta = parseMeta(
          storage.getItem(metaKey(slotId)),
          slotId,
          gameId,
        );
        entries.push({
          slotId,
          bytes: raw === null ? 0 : base64ByteLength(raw),
          updatedAtUnixMs: meta?.updatedAtUnixMs ?? 0,
          meta,
        });
      }
      return entries;
    },
    async read(slotId: string): Promise<Uint8Array | undefined> {
      const raw = storage.getItem(ppsKey(slotId));
      if (raw === null) return undefined;
      try {
        return base64ToBytes(raw);
      } catch {
        // A non-base64 value is a damaged stored file, not a missing one;
        // return bytes that fail the header check instead of hiding the slot.
        return new Uint8Array(0);
      }
    },
    async writeAtomic(
      slotId: string,
      file: Uint8Array,
      meta: SaveSlotMeta,
    ): Promise<void> {
      const finalKey = ppsKey(slotId);
      const tempKey = `${finalKey}${TEMP_SUFFIX}`;
      let encoded: string;
      try {
        encoded = bytesToBase64(file);
      } catch (error) {
        throw storageFailureFrom(error);
      }
      try {
        storage.setItem(tempKey, encoded);
      } catch (error) {
        throw storageFailureFrom(error);
      }
      try {
        // localStorage `setItem` replaces one key atomically; the temp value
        // proves the bytes fit before the destination is touched.
        storage.setItem(finalKey, encoded);
      } catch (error) {
        try {
          storage.removeItem(tempKey);
        } catch {
          // The stale temp key is cleaned on the next adapter creation.
        }
        throw storageFailureFrom(error);
      }
      try {
        storage.removeItem(tempKey);
      } catch {
        // Harmless; cleaned on next creation.
      }
      // Metadata is a disposable cache (15 §5.3): a failure after the `.pps`
      // commit still leaves a valid save and must not fail the write.
      try {
        storage.setItem(metaKey(slotId), JSON.stringify(meta));
      } catch {
        // Rebuilt on the next list()/read().
      }
    },
    async remove(slotId: string): Promise<void> {
      try {
        storage.removeItem(ppsKey(slotId));
        storage.removeItem(metaKey(slotId));
        storage.removeItem(`${ppsKey(slotId)}${TEMP_SUFFIX}`);
      } catch (error) {
        throw storageFailureFrom(error);
      }
    },
    dispose(): void {
      // localStorage has no connection to close; the adapter is stateless.
    },
  };
}

/* -------------------------------------------------------------------------
 * In-memory adapter (Node tests and failure injection)
 * ---------------------------------------------------------------------- */

/** Shared backing maps; two namespaces can share one backend. */
export interface MemorySaveBackend {
  readonly files: Map<string, Uint8Array>;
  readonly metas: Map<string, SaveSlotMeta>;
}

export interface MemorySaveStorageOptions {
  /** Key namespace; defaults to `"memory"`. Use one per game. */
  readonly namespace?: string;
  /** Total stored `.pps` bytes allowed; `undefined` means unlimited. */
  readonly quotaBytes?: number;
  readonly backend?: MemorySaveBackend;
}

export interface MemorySaveStorage extends SaveStorage {
  readonly kind: "memory";
  /** Arms one write failure at the named stage (test seam, 15 ER-15-07). */
  failNextWrite(stage: "temp" | "commit"): void;
  /** A copy of the stored `.pps` bytes, or undefined (test assertion seam). */
  peek(slotId: string): Uint8Array | undefined;
}

export function createMemorySaveStorage(
  options: MemorySaveStorageOptions = {},
): MemorySaveStorage {
  const namespace = options.namespace ?? "memory";
  const backend = options.backend ?? {
    files: new Map<string, Uint8Array>(),
    metas: new Map<string, SaveSlotMeta>(),
  };
  const quotaBytes = options.quotaBytes;
  const prefix = `${namespace}/`;
  let failStage: "temp" | "commit" | null = null;

  const keyFor = (slotId: string): string => `${prefix}${slotId}`;

  return {
    kind: "memory",
    async list(): Promise<readonly SaveStorageEntry[]> {
      const entries: SaveStorageEntry[] = [];
      for (const [key, bytes] of backend.files) {
        if (!key.startsWith(prefix)) continue;
        const slotId = key.slice(prefix.length);
        if (!SAVE_SLOT_ID_PATTERN.test(slotId)) continue;
        const meta = backend.metas.get(slotId) ?? null;
        entries.push({
          slotId,
          bytes: bytes.byteLength,
          updatedAtUnixMs: meta?.updatedAtUnixMs ?? 0,
          meta,
        });
      }
      return entries;
    },
    async read(slotId: string): Promise<Uint8Array | undefined> {
      return backend.files.get(keyFor(slotId))?.slice();
    },
    async writeAtomic(
      slotId: string,
      file: Uint8Array,
      meta: SaveSlotMeta,
    ): Promise<void> {
      if (failStage === "temp") {
        failStage = null;
        throw new SaveStorageFailure(
          "E_SAVE_IO",
          "simulated temp write failure",
        );
      }
      const key = keyFor(slotId);
      if (quotaBytes !== undefined) {
        let stored = 0;
        for (const bytes of backend.files.values()) {
          stored += bytes.byteLength;
        }
        const previous = backend.files.get(key)?.byteLength ?? 0;
        if (stored - previous + file.byteLength > quotaBytes) {
          throw new SaveStorageFailure("E_SAVE_QUOTA", "simulated quota");
        }
      }
      if (failStage === "commit") {
        failStage = null;
        throw new SaveStorageFailure("E_SAVE_IO", "simulated commit failure");
      }
      // One synchronous commit: a reader sees the old file or the new one.
      backend.files.set(key, file.slice());
      backend.metas.set(slotId, meta);
    },
    async remove(slotId: string): Promise<void> {
      backend.files.delete(keyFor(slotId));
      backend.metas.delete(slotId);
    },
    dispose(): void {
      failStage = null;
    },
    failNextWrite(stage: "temp" | "commit"): void {
      failStage = stage;
    },
    peek(slotId: string): Uint8Array | undefined {
      return backend.files.get(keyFor(slotId))?.slice();
    },
  };
}

/* -------------------------------------------------------------------------
 * Manifest-bound test double
 * ---------------------------------------------------------------------- */

/** Test-only options for the localStorage double. */
export interface TestLocalSaveApiOptions {
  readonly gameVersion?: string;
  readonly sdkVersion?: string;
  readonly engineVersion?: string;
  readonly now?: () => number;
  readonly maxSlots?: number;
  readonly storage?: StorageLike;
}

/**
 * TEST-ONLY binding of the localStorage double to one game; production uses
 * `createBrowserSaveApi`. Without `manifest.version` and without
 * `options.gameVersion` this returns `E_SAVE_FORMAT`; the engine never invents
 * a version (15 R12).
 */
export function createTestLocalStorageSaveApi(
  manifest: GameManifest,
  gameId: string,
  options: TestLocalSaveApiOptions = {},
): SaveResult<HostSaveApi> {
  const storage = createTestLocalStorageSaveStorage(gameId, options.storage);
  if (storage === undefined) {
    return fail("E_SAVE_IO", "test storage is unavailable");
  }
  const gameVersion = options.gameVersion ?? manifest.version;
  return createHostSaveApi({
    gameId,
    ...(gameVersion === undefined ? {} : { gameVersion }),
    ...(options.sdkVersion === undefined
      ? {}
      : { sdkVersion: options.sdkVersion }),
    ...(options.engineVersion === undefined
      ? {}
      : { engineVersion: options.engineVersion }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxSlots === undefined ? {} : { maxSlots: options.maxSlots }),
    storage,
  });
}

/** The shape `RuntimeCapabilities.save` accepts for a lazy, per-game binding. */
export interface SaveCapabilityHostContext {
  readonly manifest: GameManifest;
  /** Host-resolved slug; absent means no persistence for this game. */
  readonly gameId?: string;
}

export type SaveCapabilityProvider = (
  context: SaveCapabilityHostContext,
) => SaveApi | undefined | Promise<SaveApi | undefined>;

/** TEST-ONLY provider over the localStorage double. */
export function createTestLocalStorageSaveCapability(
  options: TestLocalSaveApiOptions = {},
): SaveCapabilityProvider {
  return (context) => {
    if (context.gameId === undefined) return undefined;
    const result = createTestLocalStorageSaveApi(
      context.manifest,
      context.gameId,
      options,
    );
    return result.ok ? result.value : undefined;
  };
}

/* -------------------------------------------------------------------------
 * Browser bindings (OPFS primary, IndexedDB fallback)
 * ---------------------------------------------------------------------- */

export interface BrowserSaveOptions {
  /** Injectable environment; defaults to the real browser globals. */
  readonly env?: BrowserSaveEnvironment;
  /** Test seam: origin OPFS root (production resolves navigator.storage). */
  readonly opfsRoot?:
    | OpfsDirectoryHandleLike
    | Promise<OpfsDirectoryHandleLike>;
  /** Test seam; defaults to `env.indexedDB`. */
  readonly idbFactory?: IDBFactory;
}

/**
 * Selects the §5.5 tier and returns its adapter. Synchronous presence checks
 * happen here; `ready()` opens the store and removes stale OPFS temp files.
 * Returns undefined when neither tier is present, so the caller installs no
 * `ctx.save` (15 §5.5 tier 3).
 */
export function createBrowserSaveStorage(
  gameId: string,
  options: BrowserSaveOptions = {},
): SaveStorage | undefined {
  if (!validGameId(gameId)) return undefined;
  const env = options.env ?? detectBrowserSaveEnvironment();
  const kind = selectBrowserSaveStorageKind(env);
  if (kind === "opfs") {
    if (options.opfsRoot !== undefined) {
      return createOpfsSaveStorage(gameId, options.opfsRoot);
    }
    const getDirectory = env.storage?.getDirectory;
    if (getDirectory === undefined) return undefined;
    let root: Promise<OpfsDirectoryHandleLike>;
    try {
      root = Promise.resolve(getDirectory());
    } catch {
      return undefined;
    }
    // A rejected root surfaces through ready()/the first call, not as an
    // unhandled rejection at provider creation.
    void root.catch(() => undefined);
    return createOpfsSaveStorage(gameId, root);
  }
  if (kind === "indexeddb") {
    const factory = options.idbFactory ?? env.indexedDB;
    if (factory === undefined) return undefined;
    return createIdbSaveStorage(gameId, { factory });
  }
  return undefined;
}

export interface BrowserSaveApiOptions extends BrowserSaveOptions {
  readonly gameVersion?: string;
  readonly sdkVersion?: string;
  readonly engineVersion?: string;
  readonly now?: () => number;
  readonly maxSlots?: number;
}

/**
 * Binds the selected tier to one game and waits for the store to open (OPFS
 * also cleans stale temp files here). An open failure is `E_SAVE_IO`, so the
 * host leaves `ctx.save` undefined (15 §5.5 tier 3, §3.8). Without
 * `manifest.version` and without `options.gameVersion` this returns
 * `E_SAVE_FORMAT`; the engine never invents a version (15 R12).
 */
export async function createBrowserSaveApi(
  manifest: GameManifest,
  gameId: string,
  options: BrowserSaveApiOptions = {},
): Promise<SaveResult<HostSaveApi>> {
  const storage = createBrowserSaveStorage(gameId, options);
  if (storage === undefined) {
    return fail("E_SAVE_IO", "browser save storage is unavailable");
  }
  try {
    await storage.ready?.();
  } catch (error) {
    storage.dispose();
    return storageFailure(error, null);
  }
  const gameVersion = options.gameVersion ?? manifest.version;
  const result = createHostSaveApi({
    gameId,
    ...(gameVersion === undefined ? {} : { gameVersion }),
    ...(options.sdkVersion === undefined
      ? {}
      : { sdkVersion: options.sdkVersion }),
    ...(options.engineVersion === undefined
      ? {}
      : { engineVersion: options.engineVersion }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxSlots === undefined ? {} : { maxSlots: options.maxSlots }),
    storage,
  });
  if (!result.ok) storage.dispose();
  return result;
}

/**
 * Production provider for `installRuntimeCapabilities({ save })`. It is async
 * so a store that fails to open leaves `ctx.save` undefined; `GameHost`
 * resolves it before `game.init` (15 §5.5, §3.8). Failures never throw.
 */
export function createBrowserSaveCapability(
  options: BrowserSaveApiOptions = {},
): SaveCapabilityProvider {
  return async (context) => {
    if (context.gameId === undefined) return undefined;
    const result = await createBrowserSaveApi(
      context.manifest,
      context.gameId,
      options,
    );
    return result.ok ? result.value : undefined;
  };
}

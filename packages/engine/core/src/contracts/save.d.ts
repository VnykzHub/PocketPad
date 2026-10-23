/**
 * Save/load contract (spec 15). Types and constants only.
 *
 * The frozen header layout is 00 §4.5: a 40-byte little-endian prefix, the
 * UTF-8 `gameId` and `gameVersion`, then zero padding to an 8-byte boundary.
 * `SaveHeaderFields` is declared once in `engine.d.ts`; this file aliases it
 * as `SaveHeader` and adds the storage/codec/API surface.
 *
 * CODE-FREE WAVE. M0's header codec (`fnv1a32`, `createSaveHeader`,
 * `encodeSaveHeader`, `decodeSaveHeader`, `encodeSaveFile`,
 * `decodeSaveFile`) is W1. M1 owns `SaveStore`, browser adapters,
 * compression, SHA-256 and migration machinery. Nothing here performs I/O or
 * imports a browser API.
 */

import type { EngineErrorCode, SaveHeaderFields } from "./engine.js";

/** Frozen on-disk save format version (00 §4.1). */
export const SAVE_FORMAT_VERSION: 1;

/** ASCII magic at offset 0: `50 50 53 56`. */
export const SAVE_MAGIC: "PPSV";

/**
 * Fixed prefix length before the UTF-8 strings: 40 bytes (00 §4.5).
 *
 * This is not the header's `headerBytes` field, which is the whole header
 * (40..144). 15 §3.1 calls this value `SAVE_HEADER_PREFIX_BYTES`; both names
 * are exported to keep the prose and the contract aligned.
 */
export const SAVE_HEADER_BYTES: 40;

/** 15 §3.1 name for the same fixed 40-byte prefix. */
export const SAVE_HEADER_PREFIX_BYTES: typeof SAVE_HEADER_BYTES;

/** Largest legal `headerBytes` field, inclusive. */
export const SAVE_HEADER_MAX_BYTES: 144;

/** `gameId` UTF-8 byte cap. */
export const SAVE_MAX_GAME_ID_BYTES: 64;

/** `gameVersion` UTF-8 byte cap. */
export const SAVE_MAX_GAME_VERSION_BYTES: 32;

/** Stored-payload cap: 32 MiB (00 §4.5). */
export const SAVE_MAX_PAYLOAD_BYTES: 33554432;

/** Decompressed-payload policy cap: 64 MiB. Validation bound, not a measurement. */
export const SAVE_MAX_UNCOMPRESSED_BYTES: 67108864;

/** Default slot cap. Policy limit, not a measurement. */
export const SAVE_DEFAULT_MAX_SLOTS: 32;

/** Flags bit 0: the stored payload is zlib-wrapped DEFLATE (RFC 1950). */
export const SAVE_FLAG_DEFLATE: 1;

/** Bits 1..15 are reserved and must be zero. */
export const SAVE_FLAGS_RESERVED_MASK: 65534;

/** Path-safe slot id: `^[a-z0-9][a-z0-9_-]{0,31}$`. */
export const SAVE_SLOT_ID_PATTERN: RegExp;

/** Manifest slug: `^[a-z0-9][a-z0-9-]*$`. */
export const SAVE_GAME_ID_PATTERN: RegExp;

/**
 * Frozen header view (00 §3.5). `SaveHeaderFields` is declared once in
 * `engine.d.ts`; this alias keeps the two names from drifting.
 *
 * Timestamps: `createdAtUnixSeconds` is an unsigned 32-bit count of
 * **seconds** since 1970-01-01T00:00:00Z (header offset 28) — the file unit.
 * API timestamps (`createdAtUnixMs` / `updatedAtUnixMs`) are epoch
 * **milliseconds** UTC. No ISO-8601 string is ever stored in a `.pps`.
 *
 * Integrity: `payloadHash` is **FNV-1a 32** over the stored payload (header
 * offset 12), frozen by 00. It is a corruption check, not a security hash.
 * SHA-256 is optional slot metadata (`SaveSlotMeta.payloadSha256`), never a
 * field in this 40-byte header.
 */
export type SaveHeader = SaveHeaderFields;

/**
 * Save failure codes, derived from the core `EngineErrorCode` union (00 §5.9)
 * rather than a parallel union. Today this resolves to `E_SAVE_FORMAT`,
 * `E_SAVE_VERSION`, `E_SAVE_HASH`, `E_SAVE_GAME`, `E_SAVE_QUOTA`,
 * `E_SAVE_IO`, `E_SAVE_MIGRATION`, `E_SAVE_SLOT` and `E_SAVE_UNSUPPORTED`.
 */
export type SaveErrorCode = Extract<EngineErrorCode, `E_SAVE_${string}`>;

export interface SaveError {
  readonly code: SaveErrorCode;
  /** Short, redacted sentence; never payload bytes, tokens or a path with PII. */
  readonly message: string;
  readonly recoverable: boolean;
}

export type SaveResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SaveError };

/**
 * Metadata view of a stored slot; carries no payload bytes.
 *
 * Timestamps are epoch **milliseconds** UTC — the API unit.
 * `createdAtUnixMs` is derived from the header's **epoch seconds**
 * (`createdAtUnixSeconds × 1000`). `updatedAtUnixMs` is the storage commit
 * time and is not stored in the `.pps`. No ISO-8601 string is used.
 */
export interface SaveSlot {
  /** `SAVE_SLOT_ID_PATTERN`. */
  readonly slotId: string;
  /** From the header. */
  readonly gameId: string;
  /** From the header. */
  readonly formatVersion: number;
  /** Derived `"major.minor.patch"` from the header's three u16 fields. */
  readonly engineVersion: string;
  /** From the header; display/semantic metadata the engine never interprets. */
  readonly gameVersion: string;
  /** Slot metadata; diagnostic only. */
  readonly sdkVersion: string;
  /** Creation time, epoch milliseconds UTC; header seconds × 1000. */
  readonly createdAtUnixMs: number;
  /** Storage commit time, epoch milliseconds UTC; not in the `.pps`. */
  readonly updatedAtUnixMs: number;
  /** Stored (possibly compressed) payload bytes. */
  readonly payloadBytes: number;
  /** Decompressed payload bytes; `0` when uncompressed. */
  readonly payloadUncompressedBytes: number;
  /** FNV-1a 32 of the stored payload, frozen in the 40-byte header. */
  readonly payloadHash: number;
  /**
   * Lowercase hex SHA-256 of the stored payload, from slot metadata only.
   * Optional and never part of the 40-byte header; `null` when unavailable.
   */
  readonly payloadSha256: string | null;
  readonly flags: number;
  /** Total `.pps` file size: header bytes + stored payload bytes. */
  readonly bytes: number;
  readonly readable: boolean;
  /** Why `readable === false`; never means the slot was deleted. */
  readonly error: SaveErrorCode | null;
}

export interface SaveData {
  /** Header after any migration. */
  readonly header: SaveHeader;
  /** Decompressed game-owned bytes. */
  readonly payload: Uint8Array;
  readonly slot: SaveSlot;
  /** Original `formatVersion` when a migration ran; `null` otherwise. */
  readonly migratedFrom: number | null;
}

/**
 * Sidecar slot metadata (15 §3.7). Versioned independently of the `.pps`
 * header; it is a disposable cache, not a second source of truth. Timestamps
 * are epoch **milliseconds** UTC. `payloadSha256` is metadata, not a header
 * field.
 */
export interface SaveSlotMeta {
  readonly metaVersion: 1;
  readonly slotId: string;
  readonly gameId: string;
  readonly sdkVersion: string;
  readonly createdAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly payloadSha256: string | null;
  readonly bytes: number;
}

export interface SaveStorageEntry {
  readonly slotId: string;
  /** Actual `.pps` file size. */
  readonly bytes: number;
  /** File `lastModified` / IndexedDB record time, epoch milliseconds UTC. */
  readonly updatedAtUnixMs: number;
  /** Sidecar metadata if present; the header wins on disagreement. */
  readonly meta: SaveSlotMeta | null;
}

/**
 * Injected storage seam. OPFS/IndexedDB adapters live in `packages/runtime`,
 * not `engine-core` (00 D11). `writeAtomic` must commit all-or-nothing and
 * never expose a partial file.
 */
export interface SaveStorageAdapter {
  readonly kind: "opfs" | "indexeddb" | "memory";
  list(): Promise<readonly SaveStorageEntry[]>;
  /** `undefined` means the slot does not exist. */
  read(slotId: string): Promise<Uint8Array | undefined>;
  /** All-or-nothing commit; the only method allowed to replace a `.pps`. */
  writeAtomic(
    slotId: string,
    file: Uint8Array,
    meta: SaveSlotMeta,
  ): Promise<void>;
  remove(slotId: string): Promise<void>;
  dispose(): void;
}

/** Thrown by a storage adapter for the two expected storage failures. */
export class SaveStorageError extends Error {
  readonly code: "E_SAVE_QUOTA" | "E_SAVE_IO";
}

/* -------------------------------------------------------------------------
 * M0 header codec (15 §3.3, §4)
 * ---------------------------------------------------------------------- */

/** Input to `createSaveHeader`; payload length and FNV-1a 32 are derived. */
export interface CreateSaveHeaderInput {
  /** Strict `"major.minor.patch"`. */
  readonly engineVersion: string;
  readonly gameId: string;
  readonly gameVersion: string;
  /** Epoch milliseconds UTC; written to the file as u32 epoch seconds. */
  readonly createdAtUnixMs: number;
  /** Compressed or raw payload bytes; length and hash are computed from it. */
  readonly storedPayload: Uint8Array;
  /** `0` or `SAVE_FLAG_DEFLATE`; defaults to `0`. */
  readonly flags?: number;
  /** Required when the deflate flag is set; `0`/absent otherwise. */
  readonly payloadUncompressedBytes?: number;
}

/** Result of `decodeSaveFile`; the payload is not decompressed. */
export interface DecodedSaveFile {
  readonly header: SaveHeader;
  readonly storedPayload: Uint8Array;
}

/** FNV-1a 32 over the stored payload; a corruption check, not a security hash. */
export function fnv1a32(bytes: Uint8Array): number;
export function createSaveHeader(input: CreateSaveHeaderInput): SaveHeader;
/** Prefix + strings + padding; the payload is not included. */
export function encodeSaveHeader(header: SaveHeader): Uint8Array;
export function decodeSaveHeader(bytes: Uint8Array): SaveHeader;
/** Header followed by the stored payload, after verifying length and hash. */
export function encodeSaveFile(header: SaveHeader, storedPayload: Uint8Array): Uint8Array;
/**
 * Decodes a complete `.pps`. `expectedGameId` is an optional additive check:
 * when supplied, a different `gameId` is refused with `E_SAVE_GAME`.
 */
export function decodeSaveFile(
  bytes: Uint8Array,
  expectedGameId?: string,
): DecodedSaveFile;

/**
 * Injected compression/hash seam (15 §3.7). Every member is optional so Node
 * tests can supply deterministic fakes and a browser without
 * `CompressionStream`/`crypto.subtle` still saves uncompressed.
 */
export interface SaveCodec {
  /** zlib-wrapped DEFLATE (RFC 1950), like `CompressionStream("deflate")`. */
  compress?(bytes: Uint8Array): Promise<Uint8Array>;
  /** Must abort once decoded output exceeds `maxBytes`. */
  decompress?(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array>;
  /** Lowercase hex SHA-256 of the stored payload. */
  sha256?(bytes: Uint8Array): Promise<string>;
}

export interface SaveStoreOptions {
  /** Must equal the running game's manifest slug. */
  readonly gameId: string;
  /** SDK version at host build time. */
  readonly sdkVersion: string;
  /** Defaults to `ENGINE_VERSION` in the runtime binding. */
  readonly engineVersion?: string;
  /** Epoch milliseconds UTC; supplied by the runtime adapter. */
  readonly now?: () => number;
  readonly storage: SaveStorageAdapter;
  /** Absent means uncompressed and no SHA-256. */
  readonly codec?: SaveCodec;
  /** Defaults to `SAVE_DEFAULT_MAX_SLOTS`. */
  readonly maxSlots?: number;
}

export interface SaveWriteOptions {
  /** Game-supplied `1..32` UTF-8 bytes; the engine never invents one. */
  readonly gameVersion: string;
  readonly compress?: boolean;
  /** Epoch milliseconds UTC; overrides the store clock for tests. */
  readonly now?: number;
}

export interface SaveStore {
  readonly gameId: string;
  list(): Promise<SaveResult<readonly SaveSlot[]>>;
  read(slotId: string): Promise<SaveResult<SaveData>>;
  write(
    slotId: string,
    payload: Uint8Array,
    options: SaveWriteOptions,
  ): Promise<SaveResult<SaveSlot>>;
  remove(slotId: string): Promise<SaveResult<void>>;
  /** Idempotent; no callback runs afterwards. */
  dispose(): void;
}

/** Contiguous `n → n+1` container migration step (15 §4.8). */
export interface SaveMigration {
  /** Must be >= 1. */
  readonly from: number;
  /** Must equal `from + 1`. */
  readonly to: number;
  migrate(
    header: SaveHeader,
    storedPayload: Uint8Array,
  ): SaveResult<{
    readonly header: SaveHeader;
    readonly storedPayload: Uint8Array;
  }>;
}

/** Game-facing projection bound to `ctx.save` (15 §3.8). */
export interface SaveApi {
  readonly gameId: string;
  list(): Promise<SaveResult<readonly SaveSlot[]>>;
  /** Decompressed game payload bytes only. */
  read(slotId: string): Promise<SaveResult<Uint8Array>>;
  write(slotId: string, payload: Uint8Array): Promise<SaveResult<SaveSlot>>;
  remove(slotId: string): Promise<SaveResult<void>>;
}

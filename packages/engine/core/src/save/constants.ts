/**
 * Runtime values for the frozen save contract (15 §3.1).
 *
 * The matching declarations live in `src/contracts/save.d.ts`; that file
 * cannot emit runtime values, so this module is the single runtime source and
 * the package entry re-exports it (REVIEW RV-17). Every literal here must
 * equal its declaration in `save.d.ts` and in 00 §4.5.
 *
 * Limits are validation bounds, not measurements.
 */

/** Frozen on-disk save format version (00 §4.1). */
export const SAVE_FORMAT_VERSION = 1 as const;

/** ASCII magic at offset 0: `50 50 53 56`. */
export const SAVE_MAGIC = "PPSV" as const;

/** Fixed prefix length before the UTF-8 strings: 40 bytes (00 §4.5). */
export const SAVE_HEADER_BYTES = 40 as const;

/** 15 §3.1 name for the same fixed 40-byte prefix. */
export const SAVE_HEADER_PREFIX_BYTES = SAVE_HEADER_BYTES;

/** Largest legal `headerBytes` field, inclusive. */
export const SAVE_HEADER_MAX_BYTES = 144 as const;

/** `gameId` UTF-8 byte cap. */
export const SAVE_MAX_GAME_ID_BYTES = 64 as const;

/** `gameVersion` UTF-8 byte cap. */
export const SAVE_MAX_GAME_VERSION_BYTES = 32 as const;

/** Stored-payload cap: 32 MiB (00 §4.5). */
export const SAVE_MAX_PAYLOAD_BYTES = 33554432 as const;

/** Decompressed-payload policy cap: 64 MiB. Validation bound, not a measurement. */
export const SAVE_MAX_UNCOMPRESSED_BYTES = 67108864 as const;

/** Default slot cap. Policy limit, not a measurement. */
export const SAVE_DEFAULT_MAX_SLOTS = 32 as const;

/** Flags bit 0: the stored payload is zlib-wrapped DEFLATE (RFC 1950). */
export const SAVE_FLAG_DEFLATE = 1 as const;

/** Bits 1..15 are reserved and must be zero. */
export const SAVE_FLAGS_RESERVED_MASK = 65534 as const;

/** Path-safe slot id: `^[a-z0-9][a-z0-9_-]{0,31}$`. */
export const SAVE_SLOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Manifest slug: `^[a-z0-9][a-z0-9-]*$/`. */
export const SAVE_GAME_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

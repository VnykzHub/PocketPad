# 15 — Save / Load

**Status:** authoritative for the save/load subsystem: the `.pps` container, the `SaveHeader` codec, slot storage, the migration chain, corruption/quota behaviour and the game-facing `SaveApi`. **M0 implements only the `SaveHeader` codec.** The store, storage adapters, compression, SHA-256 and migration machinery are M1. Nothing in this document is implemented today.
**Milestone:** M0 header codec; M1 full save/load (00 §5.14, 00 §9).
**Authority:** [`SPEC.md`](../../SPEC.md) for the product/protocol contract and security rules, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) for programme rules, [`00-architecture.md`](00-architecture.md) for boundaries and frozen contracts. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded in [`docs/todos/README.md`](../todos/README.md).

**Frozen-contract note.** `SaveHeader` is frozen by 00 §3.1 and its byte layout is frozen by 00 §4.5. This spec **does not change it**. Four things the programme needs are deliberately placed outside the header because adding them would be a byte-layout change:

| Need | Where it lives | Why not in `SaveHeader` |
|---|---|---|
| `slotId` | slot metadata and storage path | The header identifies content, not a storage address. Moving a `.pps` to another slot must not rewrite it. |
| `sdkVersion` | slot metadata | Diagnostic only; the load-critical identity is `gameVersion`, which the header already carries. |
| `updatedAt` | slot metadata | The file is replaced atomically on every write; update time is the storage commit time. |
| SHA-256 | slot metadata | 00 freezes `payloadHash` as FNV-1a 32. An in-file SHA-256 requires **A19** (next free amendment ID) and `SAVE_FORMAT_VERSION` 2, with v1 readers retained. |

A change to the header itself is a five-step frozen-contract change (00 §3.1): update this spec, record an amendment, bump `SAVE_FORMAT_VERSION`, provide a v1 migration, and keep a v1 golden fixture loading.

---

## 1. Goal

The player-visible outcome: **progress survives a reload, a tab close, a browser restart and a game update**, and a damaged or newer save never silently destroys the previous one. A player who sees "save failed" still has their last good save; a player who sees "this save is from a newer version" can keep the file and update the game instead of losing it.

The engineering outcomes:

1. **One container, one header, one codec.** Every save is a `.pps` file: a frozen header plus an opaque game payload. The header is the only compatibility gate.
2. **Pure codec, injected storage.** Header/file encoding and validation run in Node and in the browser without DOM access. OPFS/IndexedDB/compression/hash live behind a small adapter seam supplied by the runtime.
3. **Atomic writes.** A save is fully built and verified in memory before the first byte is written. The commit point is an atomic rename (OPFS) or one IndexedDB transaction. A crash leaves either the old save or the new save, never a partial file.
4. **Fail-safe reads.** Hash first, decompress second, hand verified bytes to the game third. A failure never modifies or deletes the file.
5. **Strictly forward migration.** A reader accepts its current `formatVersion` and any older version with a complete migration chain. A newer file is refused with `E_SAVE_VERSION`. There is no downgrade and no best-effort parse.
6. **No PII, no network.** Saves are origin-private user data. The engine writes only the fields in §4; nothing is uploaded, logged or embedded in a URL.

### 1.1 Normative invariants

These are contract rules, not implementation suggestions. Each has an acceptance row in §7.

- **I1 — Never delete what you cannot read.** The engine deletes a `.pps` only on an explicit `SaveStore.remove(slotId)` call naming that slot. Automatic housekeeping is limited to transient `*.tmp` files created by a failed write. `list()` reports an unreadable slot; it never removes it. Quota pressure never evicts saves.
- **I2 — A failed write leaves the previous save intact.** The new file is built and hash-verified in memory before the commit point. A failure before the commit point leaves the old file byte-identical. A failure after the commit point (for example a metadata write) leaves a valid new save with stale/missing metadata, which is rebuilt on the next read.
- **I3 — A failed hash never reaches the game.** The FNV-1a 32 check over the stored payload runs before decompression and before the payload is returned. SHA-256 is checked when the runtime provides it. A mismatch returns `E_SAVE_HASH`; the game sees no bytes.
- **I4 — Readers migrate strictly forward.** Migrations are `n → n+1` steps, sorted, contiguous and applied one at a time. A gap is `E_SAVE_MIGRATION`. A newer file is `E_SAVE_VERSION`. A read never rewrites the file; persisting a migrated form requires an explicit `write()`.
- **I5 — The payload is opaque to the engine.** The engine never parses game bytes. The game must validate its **entire** payload before mutating game state; a game that applies sections incrementally violates this contract.
- **I6 — No PII or secrets.** The engine-owned header and metadata contain no player name, room code, token, PIN, IP address, device id or analytics id. Fixtures are synthetic.

---

## 2. Non-goals

**M0 boundary (normative).** M0 delivers **only** the `SaveHeader` codec and its fixture: `packages/engine/core/src/save/header.ts` plus `types.ts`, the golden header fixture and the unit/property tests. M0 does **not** deliver `SaveStore`, OPFS, IndexedDB, compression, SHA-256, slot metadata, migrations beyond the v1 identity, `ctx.save`, a save menu or a save/load integration test. 00 §5.14 lists "save/load implementation; only the header codec exists" as explicitly deferred. A wave that adds the store to M0 is an M0 failure even if it works.

The full subsystem deliberately does not do:

- **Cloud saves, accounts, sync or cross-device transfer.** `SPEC.md` §2 lists cloud saves as a v1 non-goal. Saves are local to one origin and one browser profile.
- **A save editor.** Spec 17 owns the editor and explicitly does not write `.pps` files (17 §2).
- **A game payload schema.** The payload is game-owned. Spec 03 owns `SceneSnapshot`; spec 12 owns `CSTR`; spec 07 has no persisted physics representation. This spec does not duplicate or re-version any of them.
- **Scene or physics serialization.** 03 serializes scene-owned state; 07 states that physics state is game-owned and saved by this spec's consumer. This spec only carries bytes.
- **Encryption, DRM, anti-cheat or save signing.** FNV-1a 32 and SHA-256 are integrity checks, not authenticity. A local user can edit a save; the game must validate semantics.
- **Automatic backup or rollback slots.** The atomic replace keeps the previous version only until commit. A game that wants a backup writes two slots.
- **Cross-tab merge or conflict resolution.** Web Locks may serialize writes; the last completed write wins. There is no merge.
- **A performance claim.** No save latency, throughput or memory number is asserted here. M1 records measurements in `docs/RESULTS.md`; until then those rows are PENDING.
- **Television-specific storage guarantees.** TV browser storage availability is measured, not assumed (§7, ER-15-14).
- **A new protocol frame or controller feature.** Saves never touch the wire, the controller or the room protocol. `PROTOCOL_VERSION` stays 1.

### 2.1 Milestone table

| Milestone | Delivered | Not delivered |
|---|---|---|
| **M0** | `SaveHeader` types, `encodeSaveHeader`, `decodeSaveHeader`, `fnv1a32`, `createSaveHeader`, golden fixture, unit + property tests | Store, OPFS, IndexedDB, compression, SHA-256, migrations, `SaveApi` |
| **M1** | `SaveStore`, memory adapter, OPFS + IndexedDB adapters (runtime), atomic writes, quota/corruption handling, migration chain, `SaveApi`, vertical-slice round trip | Cloud sync, editor integration, backup rotation, multi-tab merge |
| **M2+** | Additive: export/import UI, slot thumbnails, optional compression policy tuning, in-file SHA-256 only under amendment A19 / format v2 | — |

---

## 3. Public interfaces

The types below are the contract. Per README §7.1 they must also land as `docs/engine/15-save-load.d.ts` before implementation; that file is frozen and additive-only. This document is the prose authority until the `.d.ts` exists. The implementing change adds it; this documentation change does not.

### 3.1 Constants

```ts
export const SAVE_FORMAT_VERSION = 1 as const;
export const SAVE_MAGIC = "PPSV" as const;
export const SAVE_HEADER_PREFIX_BYTES = 40;
export const SAVE_HEADER_MAX_BYTES = 144;
export const SAVE_MAX_GAME_ID_BYTES = 64;
export const SAVE_MAX_GAME_VERSION_BYTES = 32;
export const SAVE_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;        // 32 MiB, from 00 §4.5
export const SAVE_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;   // policy cap, not a measurement
export const SAVE_DEFAULT_MAX_SLOTS = 32;                      // policy cap
export const SAVE_FLAG_DEFLATE = 0b0000_0000_0000_0001;
export const SAVE_FLAGS_RESERVED_MASK = 0b1111_1111_1111_1110;
export const SAVE_SLOT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const SAVE_GAME_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;     // manifest slug, 18 §3.7
```

`SAVE_MAX_UNCOMPRESSED_BYTES` and `SAVE_DEFAULT_MAX_SLOTS` are **design limits** chosen so a malicious 32 MiB deflate payload cannot exhaust host memory and so slot enumeration stays bounded. They are not measurements and must not be cited as budgets.

### 3.2 `SaveHeader`

`SaveHeaderFields` is frozen in 00 §3.5. This spec exports `SaveHeader` as a type alias so the two names cannot drift. All fields are required; none is nullable.

```ts
export interface SaveHeaderFields {
  readonly formatVersion: number;              // u16, currently 1
  readonly engineMajor: number;                // u16
  readonly engineMinor: number;                // u16
  readonly enginePatch: number;                // u16
  readonly gameId: string;                     // 1..64 UTF-8 bytes, no NUL, no "/"
  readonly gameVersion: string;                // 1..32 UTF-8 bytes, no NUL
  readonly createdAtUnixSeconds: number;       // u32, Unix epoch seconds UTC
  readonly payloadBytes: number;               // u32, stored payload length
  readonly payloadUncompressedBytes: number;   // u32, 0 when uncompressed
  readonly payloadHash: number;                // u32, FNV-1a 32 of the stored payload
  readonly flags: number;                      // u16, bit 0 = zlib DEFLATE
}
export type SaveHeader = SaveHeaderFields;
```

### 3.3 Codec functions

Pure functions. They throw `EngineError` with a save code for invalid data; they perform no I/O and allocate only on the cold path.

```ts
/** FNV-1a 32 over bytes; returns an unsigned 32-bit integer. Not a security hash. */
export function fnv1a32(bytes: Uint8Array): number;

/**
 * Build a complete header from caller fields and the *stored* payload.
 * Computes payloadBytes and payloadHash; validates every length, flag and range.
 * Throws E_SAVE_FORMAT on invalid input.
 */
export function createSaveHeader(input: CreateSaveHeaderInput): SaveHeader;

/** Serialize the 40-byte prefix + strings + zero padding. Does not include the payload. */
export function encodeSaveHeader(header: SaveHeader): Uint8Array;

/** Parse and validate a header region. Throws E_SAVE_FORMAT or E_SAVE_VERSION. */
export function decodeSaveHeader(bytes: Uint8Array): SaveHeader;

/** Concatenate header + stored payload; verifies length and FNV-1a 32. */
export function encodeSaveFile(header: SaveHeader, storedPayload: Uint8Array): Uint8Array;

/** Parse a complete .pps file, verify structure and FNV-1a 32, return stored bytes. */
export function decodeSaveFile(bytes: Uint8Array): DecodedSaveFile;

export interface CreateSaveHeaderInput {
  readonly engineVersion: string;              // strict "major.minor.patch"
  readonly gameId: string;
  readonly gameVersion: string;
  readonly createdAtUnixMs: number;            // epoch milliseconds UTC
  readonly storedPayload: Uint8Array;          // compressed or raw; length/hash computed
  readonly flags?: number;                     // 0 or SAVE_FLAG_DEFLATE
  readonly payloadUncompressedBytes?: number;  // required when flags bit 0 is set
}

export interface DecodedSaveFile {
  readonly header: SaveHeader;
  readonly storedPayload: Uint8Array;          // not decompressed
}
```

`decodeSaveFile` verifies, in order: minimum length, magic, `formatVersion`, `headerBytes`, string lengths and padding, `payloadBytes` versus the actual file length, reserved flag bits, `payloadUncompressedBytes` consistency, and FNV-1a 32 over the stored payload. It does **not** decompress; the store does that so the uncompressed cap is enforced in one place.

### 3.4 Result and error union

Codec functions throw; the asynchronous store returns `SaveResult<T>`. The split is deliberate: a bad header is a programmer/data error at a boundary, while a missing slot or a full disk is an expected runtime outcome.

```ts
export type SaveErrorCode =
  | "E_SAVE_FORMAT"       // malformed magic/header/lengths/padding/flags/compression
  | "E_SAVE_VERSION"      // formatVersion newer than this reader
  | "E_SAVE_HASH"         // FNV-1a 32 or SHA-256 mismatch
  | "E_SAVE_GAME"         // gameId differs from the running game
  | "E_SAVE_QUOTA"        // storage quota exhausted
  | "E_SAVE_IO"           // storage unavailable, blocked or failed
  | "E_SAVE_MIGRATION"    // older version with no contiguous migration step
  | "E_SAVE_SLOT"         // invalid/unknown slot id, or maxSlots exceeded
  | "E_SAVE_UNSUPPORTED"; // valid file, but this reader lacks a required capability

export interface SaveError {
  readonly code: SaveErrorCode;
  readonly message: string;      // short, redacted; never payload bytes or secrets
  readonly recoverable: boolean;
}

export type SaveResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SaveError };
```

All nine `E_SAVE_*` codes are now in 00 §5.9 and the core contract; no further request is needed. Codes may be added but never removed.

| Code | Meaning | `recoverable` |
|---|---|---|
| `E_SAVE_FORMAT` | The file is structurally invalid or uses an unsupported compression method. | false for this file |
| `E_SAVE_VERSION` | The file's `formatVersion` is newer than this reader. | false; update the game/engine |
| `E_SAVE_HASH` | Stored payload does not match its FNV-1a 32 or SHA-256. | false; the file is damaged |
| `E_SAVE_GAME` | `gameId` does not match the running game. | false; wrong save |
| `E_SAVE_QUOTA` | The browser refused the write for space. | true; free space and retry |
| `E_SAVE_IO` | Storage is unavailable, blocked or failed. | true; retry or run without persistence |
| `E_SAVE_MIGRATION` | No contiguous migration path from the file's version. | false; update the game/engine |
| `E_SAVE_SLOT` | Slot id invalid/unknown or `maxSlots` reached. | false; caller error |
| `E_SAVE_UNSUPPORTED` | Valid file, but this reader lacks `DecompressionStream` or another required capability. | false on this browser |

### 3.5 `SaveSlot` and `SaveData`

`SaveSlot` is the metadata view returned by `list()`, `read()` and `write()`. It combines the frozen header with storage metadata. It contains no payload bytes.

```ts
export interface SaveSlot {
  readonly slotId: string;                 // SAVE_SLOT_ID_PATTERN
  readonly gameId: string;                 // from the header
  readonly formatVersion: number;          // from the header
  readonly engineVersion: string;          // derived "major.minor.patch"
  readonly gameVersion: string;            // from the header
  readonly sdkVersion: string;             // slot metadata, diagnostic only
  readonly createdAtUnixMs: number;        // header seconds × 1000
  readonly updatedAtUnixMs: number;        // storage commit time, epoch ms UTC
  readonly payloadBytes: number;           // stored (possibly compressed) bytes
  readonly payloadUncompressedBytes: number;
  readonly payloadHash: number;            // frozen FNV-1a 32
  readonly payloadSha256: string | null;   // lowercase hex, 64 chars; null if unavailable
  readonly flags: number;
  readonly bytes: number;                  // total .pps file size
  readonly readable: boolean;              // structural + version + gameId checks passed
  readonly error: SaveErrorCode | null;    // why readable === false; never means deleted
}

export interface SaveData {
  readonly header: SaveHeader;             // after any migration
  readonly payload: Uint8Array;            // decompressed game bytes
  readonly slot: SaveSlot;
  readonly migratedFrom: number | null;    // original formatVersion, or null
}
```

`readable: true` from `list()` means the header parsed, the game id matched and the version is readable or migratable. It does **not** mean the payload hash was verified; `read()` is the authoritative check. A slot can be `readable: true` in `list()` and fail `read()` with `E_SAVE_HASH`.

### 3.6 `SaveStore`

```ts
export interface SaveStore {
  readonly gameId: string;
  list(): Promise<SaveResult<readonly SaveSlot[]>>;
  read(slotId: string): Promise<SaveResult<SaveData>>;
  write(slotId: string, payload: Uint8Array, options: SaveWriteOptions): Promise<SaveResult<SaveSlot>>;
  remove(slotId: string): Promise<SaveResult<void>>;
  dispose(): void;                          // idempotent; no callbacks afterwards
}

export interface SaveStoreOptions {
  readonly gameId: string;                  // must equal the running manifest slug
  readonly sdkVersion: string;              // SDK_VERSION at host build time
  readonly engineVersion?: string;          // default ENGINE_VERSION
  readonly now?: () => number;              // epoch ms UTC; default Date.now in the adapter
  readonly storage: SaveStorageAdapter;
  readonly codec?: SaveCodec;               // compression/SHA-256; absent = uncompressed, no SHA
  readonly maxSlots?: number;               // default SAVE_DEFAULT_MAX_SLOTS
}

export interface SaveWriteOptions {
  readonly gameVersion: string;             // 1..32 UTF-8 bytes; game-supplied
  readonly compress?: boolean;              // default true when codec.compress exists
  readonly now?: number;                    // epoch ms UTC; overrides the store clock for tests
}
```

Rules:

- `write` validates `slotId`, `gameId` and payload length before touching storage. It refuses a payload over `SAVE_MAX_PAYLOAD_BYTES` with `E_SAVE_FORMAT`.
- `write` refuses a 33rd slot with `E_SAVE_SLOT` unless it overwrites an existing slot. It never evicts.
- `remove` deletes exactly one named slot. It does not scan, clean or cascade. This is the **only** path that deletes a `.pps`, including an unreadable one.
- `list` returns slots sorted by `updatedAtUnixMs` descending, then `slotId` ascending. A corrupt slot appears with `readable: false` and its error code; `list` fails as a whole only if the storage backend cannot be enumerated (`E_SAVE_IO`).
- `read` never writes, never migrates in place and never deletes.
- `dispose` is idempotent. In-flight promises may settle; no callback runs after `dispose`.

### 3.7 Storage and codec seams

The engine-core store is pure. Browser APIs are injected by the runtime, mirroring spec 12's `CellSource`/`CellCache` split.

```ts
export interface SaveStorageEntry {
  readonly slotId: string;
  readonly bytes: number;                  // actual .pps file size
  readonly updatedAtUnixMs: number;        // file lastModified / IDB record time
  readonly meta: SaveSlotMeta | null;      // sidecar cache, if present
}

export interface SaveStorageAdapter {
  readonly kind: "opfs" | "indexeddb" | "memory";
  list(): Promise<readonly SaveStorageEntry[]>;
  read(slotId: string): Promise<Uint8Array | undefined>;   // undefined = missing
  /** All-or-nothing commit. Must never expose a partial file. */
  writeAtomic(slotId: string, file: Uint8Array, meta: SaveSlotMeta): Promise<void>;
  remove(slotId: string): Promise<void>;
  dispose(): void;
}

export class SaveStorageError extends Error {
  readonly code: "E_SAVE_QUOTA" | "E_SAVE_IO";
}

export interface SaveCodec {
  /** zlib-wrapped DEFLATE (RFC 1950), as produced by CompressionStream("deflate"). */
  compress?(bytes: Uint8Array): Promise<Uint8Array>;
  /** Must abort once decoded output exceeds maxBytes. */
  decompress?(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array>;
  /** Lowercase hex SHA-256 of the stored payload; crypto.subtle in the browser. */
  sha256?(bytes: Uint8Array): Promise<string>;
}

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
```

`SaveSlotMeta` is fresh, engine-owned metadata, versioned separately (`metaVersion`). It is a cache/index, not a second source of truth: if it disagrees with the `.pps` header, the header wins and the meta is rebuilt on the next successful write. No field is personal data.

### 3.8 `SaveApi` (game-facing projection)

18 §3.4 reserves `ctx.save?: SaveApi` and says the owning spec is authoritative for its shape. This is that shape. It is a thin binding over one `SaveStore`; the host supplies `gameVersion` and `sdkVersion`.

```ts
export interface SaveApi {
  readonly gameId: string;
  list(): Promise<SaveResult<readonly SaveSlot[]>>;
  read(slotId: string): Promise<SaveResult<Uint8Array>>;   // decompressed game payload only
  write(slotId: string, payload: Uint8Array): Promise<SaveResult<SaveSlot>>;
  remove(slotId: string): Promise<SaveResult<void>>;
}
```

`SaveApi` is absent (`undefined`) when storage is unavailable, following 18's additive-member rule. It is never a throwing stub. A game feature-detects with `if (ctx.save)` and runs without persistence otherwise.

### 3.9 Migration types

```ts
export interface SaveMigration {
  readonly from: number;                   // must be >= 1
  readonly to: number;                     // must equal from + 1
  migrate(
    header: SaveHeader,
    storedPayload: Uint8Array,
  ): SaveResult<{ readonly header: SaveHeader; readonly storedPayload: Uint8Array }>;
}

/** Sorted, contiguous, one step per version. Empty at v1. */
export const SAVE_MIGRATIONS: readonly SaveMigration[] = [];
```

Migration rules are in §4.8.

---

## 4. Data formats

All multi-byte integers are little-endian and read/written with `DataView`. All binary layouts are frozen by 00 §4.5; this spec only adds the surrounding storage format.

### 4.1 File layout

A `.pps` file is exactly:

```
offset 0                      headerBytes                    headerBytes + payloadBytes
|------------------------------|------------------------------|
| SaveHeader (prefix+strings+  | stored payload (compressed   |
| zero padding)                | or raw, game-owned)          |
```

There is no trailer in v1. `fileBytes = headerBytes + payloadBytes` exactly; a trailing byte is `E_SAVE_FORMAT`. An optional v2 SHA-256 trailer is an amendment, not a v1 feature.

### 4.2 Header fields

| Offset | Size | Field | Type | Rule |
|---:|---:|---|---|---|
| 0 | 4 | `magic` | ASCII | Exactly `PPSV` (`50 50 53 56`). |
| 4 | 2 | `formatVersion` | u16 | Exactly `1` in v1. A newer value is `E_SAVE_VERSION`; `0` is `E_SAVE_FORMAT`. |
| 6 | 2 | `headerBytes` | u16 | `align8(40 + gameIdBytes + gameVersionBytes)`; multiple of 8; `40..144`. |
| 8 | 4 | `payloadBytes` | u32 | Stored payload length; `0..33,554,432` (32 MiB). |
| 12 | 4 | `payloadHash` | u32 | FNV-1a 32 over the stored payload bytes. |
| 16 | 2 | `engineMajor` | u16 | From `ENGINE_VERSION`. |
| 18 | 2 | `engineMinor` | u16 | From `ENGINE_VERSION`. |
| 20 | 2 | `enginePatch` | u16 | From `ENGINE_VERSION`. |
| 22 | 2 | `gameIdBytes` | u16 | `1..64`; exact UTF-8 byte length. |
| 24 | 2 | `gameVersionBytes` | u16 | `1..32`; exact UTF-8 byte length. |
| 26 | 2 | `flags` | u16 | Bit 0 = payload is zlib DEFLATE. Bits 1..15 reserved, must be 0. |
| 28 | 4 | `createdAtUnixSeconds` | u32 | Unix epoch **seconds** UTC; see §4.5. |
| 32 | 4 | `payloadUncompressedBytes` | u32 | `0` when bit 0 clear; `1..67,108,864` (64 MiB) when set. |
| 36 | 4 | `reserved` | u32 | Must be `0`. |
| 40 | `gameIdBytes` | `gameId` | UTF-8 | No NUL (`0x00`), no `/`. |
| … | `gameVersionBytes` | `gameVersion` | UTF-8 | No NUL. |
| … | `0..7` | padding | bytes | Zero; to the next 8-byte boundary; `headerBytes` is the end. |
| `headerBytes` | `payloadBytes` | payload | bytes | Opaque game data; compressed iff bit 0 is set. |

`headerBytes` must equal the minimal padded value, not merely be large enough. Extra padding is `E_SAVE_FORMAT`.

### 4.3 String, padding and length rules

- Lengths are **UTF-8 bytes**, not JavaScript code units: `new TextEncoder().encode(s).length`. A 64-code-point emoji string can exceed 64 bytes and must be refused.
- UTF-8 decoding is fatal: invalid byte sequences are `E_SAVE_FORMAT`, never replaced with U+FFFD.
- `gameId` must match the running game's manifest slug (`SAVE_GAME_ID_PATTERN`, 18 §3.7) at the store layer. The codec enforces only 00's rules (1..64 bytes, no NUL, no `/`); the stricter slug check also makes the value path-safe.
- `gameVersion` is 1..32 UTF-8 bytes, no NUL. It is display/semantic metadata; the engine never interprets it.
- Padding bytes must all be `0x00`; a non-zero padding byte is `E_SAVE_FORMAT`.
- `payloadBytes` is derived from the actual stored bytes; `encodeSaveFile` refuses a mismatch with `E_SAVE_HASH` (the header claims a length that does not match the payload it is being paired with).

### 4.4 Payload and flags

The payload is game-owned and opaque. It may be JSON, binary, or a game-defined concatenation of sections (for example a `SceneSnapshot` JSON section, a `CSTR` section and game state). The engine never parses it, never reorders it and never injects keys.

`flags`:

| Bit | Name | Meaning |
|---:|---|---|
| 0 | `SAVE_FLAG_DEFLATE` | The stored payload is zlib-wrapped DEFLATE (RFC 1950), produced by `CompressionStream("deflate")`. |
| 1..15 | reserved | Must be 0. A reader rejects a non-zero reserved bit with `E_SAVE_FORMAT`. |

Compression policy (M1, runtime codec):

- If `codec.compress` exists and the compressed result is **smaller** than the raw payload, write the compressed bytes with bit 0 set and the raw length in `payloadUncompressedBytes`.
- Otherwise write raw bytes, clear bit 0, and set `payloadUncompressedBytes` to `0`.
- An empty payload is always written raw (bit 0 clear); a compressed empty payload is not produced.
- A reader that encounters bit 0 without `codec.decompress` returns `E_SAVE_UNSUPPORTED`, not `E_SAVE_FORMAT`: the file is valid, the reader lacks the capability.
- Decompression is streaming and aborts as soon as decoded output exceeds `payloadUncompressedBytes` or `SAVE_MAX_UNCOMPRESSED_BYTES`. A declared/actual length mismatch is `E_SAVE_FORMAT`.

### 4.5 Timestamps

**Choice: epoch milliseconds UTC as a `number` in the API; epoch seconds UTC as the frozen u32 in the file. No ISO-8601 strings anywhere.**

| Item | Field | Unit | Where |
|---|---|---|---|
| Created at rest | `createdAtUnixSeconds` | integer seconds since `1970-01-01T00:00:00Z` | header offset 28, u32 |
| Created in API | `createdAtUnixMs` | integer milliseconds since epoch UTC | `SaveSlot` |
| Updated in API | `updatedAtUnixMs` | integer milliseconds since epoch UTC | `SaveSlot` / `SaveSlotMeta` |

Why this split:

- 00 §4.5 **freezes** the on-disk field as a u32 in seconds. Redefining it as milliseconds or a string would change the byte layout and break every v1 reader; that requires `SAVE_FORMAT_VERSION` 2 and a migration. That is not justified for sub-second creation precision.
- The API uses milliseconds because JavaScript `Date` and `Intl.DateTimeFormat` consume milliseconds, integer comparison is exact below 2^53, and there is no parsing, locale or timezone ambiguity. This is the same unit the rest of the host uses for wall-clock timestamps.
- An ISO-8601 string is rejected for the API: it is larger, needs parsing and validation, invites timezone mistakes, and does not sort lexicographically across all producers without a fixed format. Integers are unambiguous.
- Conversion is exact and one-directional in normal use: `ms = seconds * 1000`; `seconds = clamp(floor(ms / 1000), 0, 0xFFFFFFFF)`. A save created at `…999 ms` reports `…000 ms` after reload; the file has one-second resolution and this is accepted and documented.
- `createdAtUnixSeconds = 0` is legal (the epoch) and means "unknown" to a UI; the store always writes a real clock value.
- `updatedAtUnixMs` is **not** in the `.pps`. It is the storage commit time in `SaveSlotMeta` (OPFS file `lastModified` / IndexedDB record time). If metadata is missing, the adapter's `updatedAtUnixMs` is used; if that is also unavailable, it falls back to `createdAtUnixMs`. It never causes a read failure.
- `now()` is injected and read **outside** the simulation and render paths (00 §5.8, 01 §5.4). No save code calls `Date.now()` inside `simulate` or `render`.

The u32 seconds field is valid until `2106-02-07T06:28:15Z`. A later date clamps to `0xFFFFFFFF` and must be treated as a format concern at that time; no v1 game will hit it.

### 4.6 Integrity: FNV-1a 32 and SHA-256

| Check | Scope | Location | Purpose |
|---|---|---|---|
| FNV-1a 32 | stored payload bytes (compressed length if bit 0 set) | `SaveHeader.payloadHash` at offset 12 | Mandatory corruption check; frozen by 00. |
| SHA-256 | the same stored payload bytes | `SaveSlotMeta.payloadSha256` | Optional stronger at-rest check when `crypto.subtle` is available. |

FNV-1a 32 algorithm: offset basis `0x811C9DC5`, prime `0x01000193`, for each byte `h ^= b; h = Math.imul(h, 0x01000193) >>> 0`. Published vectors used by the tests:

| Input (ASCII) | FNV-1a 32 |
|---|---:|
| empty | `0x811C9DC5` |
| `a` | `0xE40C292C` |
| `foobar` | `0xBF9CF968` |
| `hello` | `0x4F9F2CAB` |

Rules:

- FNV-1a 32 is **not** collision-resistant and is **not** an authenticity mechanism. A malicious local user can rewrite a save and recompute it. The game must validate its payload semantically.
- SHA-256 is lowercase hex (64 characters), computed with `crypto.subtle.digest("SHA-256", bytes)`. It is computed when the runtime codec provides it; otherwise `payloadSha256` is `null`.
- The store recomputes SHA-256 on every `read()`. It never trusts a stored meta value alone. A stored/recomputed mismatch is `E_SAVE_HASH`.
- SHA-256 is **not** in the v1 `.pps` because 00 freezes `payloadHash` as a u32 FNV. Putting a 32-byte digest in the file is amendment **A19** plus `SAVE_FORMAT_VERSION` 2, with v1 readers retained. Until that amendment, the `.pps` is portable with FNV only and the stronger digest is local metadata.
- Comparing hashes is not secret-dependent; constant-time comparison is unnecessary here.

### 4.7 Limits

| Item | Limit | Source / nature |
|---|---:|---|
| `formatVersion` | 1 | 00 §4.1 |
| `headerBytes` | 40..144, multiple of 8, minimal padded value | 00 §4.5 |
| `gameId` | 1..64 UTF-8 bytes | 00 §4.5 |
| `gameVersion` | 1..32 UTF-8 bytes | 00 §4.5 |
| `payloadBytes` | ≤ 32 MiB | 00 §4.5 |
| `payloadUncompressedBytes` | ≤ 64 MiB | policy cap; protects host memory |
| Slots per game | 32 by default | policy cap; configurable in `SaveStoreOptions` |
| Slot id | `^[a-z0-9][a-z0-9_-]{0,31}$` | path safety |
| OPFS/IDB metadata | ≤ 4 KiB JSON | policy; metadata is tiny |
| Save file total | ≤ 32 MiB + 144 B | derived |

No MAX limit is a measured performance number. They are validation bounds.

### 4.8 Versioning and migration chain

`SAVE_FORMAT_VERSION = 1` is the only in-file compatibility gate (00 §5.15).

Rules, in order:

1. **Read the version.** If `formatVersion > SAVE_FORMAT_VERSION`, return `E_SAVE_VERSION` and leave the file untouched. Never guess a future layout.
2. **Current version.** Validate and return; no migration.
3. **Older version.** Find a migration with `from === formatVersion`. It must have `to === from + 1`. Apply it, then repeat from step 1 using the returned header's version. The chain must reach the current version exactly. A missing step, a skip (`from + 2`), a duplicate `from`, a non-ascending table, or a migration that returns a version other than `to` is `E_SAVE_MIGRATION`.
4. **Re-verify after every step.** A migration must return a complete header and a stored payload whose `payloadBytes` and `payloadHash` match. The store re-runs FNV and, if available, SHA-256 after each step. A migration that changes the payload must not mutate its input buffer.
5. **No downgrade.** There is no `to < from` migration. An older engine refuses a newer save rather than reading it partially.
6. **Reads are pure.** A migration happens in memory. The file is not rewritten; the game must call `write()` to persist the migrated form. This keeps a read safe to repeat and keeps `I1` true.
7. **Container only.** `SaveMigration` operates on the header and opaque stored bytes. The engine cannot migrate game payload semantics. Game payload migrations are game-owned and keyed by `gameVersion`; the game runs them after `read()` and before applying state. The engine never pretends to know what the payload means.
8. **Empty chain at v1.** `SAVE_MIGRATIONS` is empty. The v1 identity case is tested by `migrate` with a no-op table and by a `formatVersion: 0` fixture that must fail with `E_SAVE_MIGRATION` (no step from 0).
9. **No automatic rewrite or cleanup.** A migrated save does not replace the original; an unreadable save is not deleted.

A future v2 example (not implemented): add a 32-byte SHA-256 trailer after the payload. The v1→v2 migration would compute it, set `formatVersion: 2`, and leave the header layout unchanged; v2 readers would accept v1 through this step. The trailer's existence must be a v2-only rule, so v1 readers still see `fileBytes === headerBytes + payloadBytes` and refuse the v2 file with `E_SAVE_VERSION`.

### 4.9 Synthetic example

A v1 save for `harbor-run` version `1.2.0`, created `2026-10-22T00:00:00Z`, uncompressed, payload ASCII `demo-payload:seed=1;tick=3600`.

| Field | Value |
|---|---|
| `formatVersion` | `1` |
| `headerBytes` | `56` |
| `payloadBytes` | `29` |
| `payloadHash` | `0x635F8BC4` |
| `engineMajor/Minor/Patch` | `0 / 1 / 0` |
| `gameIdBytes` | `10` |
| `gameVersionBytes` | `5` |
| `flags` | `0` |
| `createdAtUnixSeconds` | `1792627200` |
| `payloadUncompressedBytes` | `0` |
| `reserved` | `0` |
| `gameId` | `harbor-run` |
| `gameVersion` | `1.2.0` |
| padding | one `0x00` byte (offset 55) |
| File size | `85` bytes |
| `payloadSha256` (slot metadata) | `b090e151095888be944ad76325de802ac690ab1967ab44ad4ee3e1a4c85c4895` |
| API `createdAtUnixMs` | `1792627200000` |

Hex dump of the complete `.pps`:

```
0000  50 50 53 56 01 00 38 00 1d 00 00 00 c4 8b 5f 63
0010  00 00 01 00 00 00 0a 00 05 00 00 00 00 52 d9 6a
0020  00 00 00 00 00 00 00 00 68 61 72 62 6f 72 2d 72
0030  75 6e 31 2e 32 2e 30 00 64 65 6d 6f 2d 70 61 79
0040  6c 6f 61 64 3a 73 65 65 64 3d 31 3b 74 69 63 6b
0050  3d 33 36 30 30
```

Decoded JSON view (the fixture's other half):

```json
{
  "formatVersion": 1,
  "headerBytes": 56,
  "payloadBytes": 29,
  "payloadHash": 1667206084,
  "engineMajor": 0,
  "engineMinor": 1,
  "enginePatch": 0,
  "gameIdBytes": 10,
  "gameVersionBytes": 5,
  "flags": 0,
  "createdAtUnixSeconds": 1792627200,
  "payloadUncompressedBytes": 0,
  "reserved": 0,
  "gameId": "harbor-run",
  "gameVersion": "1.2.0"
}
```

`1667206084` is the decimal form of `0x635F8BC4`. The payload is exactly the 29 ASCII bytes shown in the dump; the file contains no other bytes.

### 4.10 Slot metadata

OPFS sidecar (`<slotId>.meta.json`) or the IndexedDB record's `meta` field. UTF-8 JSON, ≤ 4 KiB, `metaVersion: 1`:

```json
{
  "metaVersion": 1,
  "slotId": "manual-1",
  "gameId": "harbor-run",
  "sdkVersion": "1.0.0",
  "createdAtUnixMs": 1792627200000,
  "updatedAtUnixMs": 1792627205123,
  "payloadSha256": "b090e151095888be944ad76325de802ac690ab1967ab44ad4ee3e1a4c85c4895",
  "bytes": 85
}
```

Rules:

- `metaVersion` is independent of `formatVersion`; a newer metadata version is ignored and rebuilt (metadata is disposable), not treated as a save error.
- `slotId` and `gameId` must match the storage path and the header. On mismatch, the header/path wins and the metadata is rebuilt.
- `payloadSha256` is `null` when `crypto.subtle` was unavailable at write time. It is recomputed on read when possible; a mismatch is `E_SAVE_HASH`.
- The metadata never contains a player name, token, room code, IP, email or free-form text.
- Losing the metadata loses no save data: the `.pps` remains the authority.

### 4.11 Storage layout

```
OPFS (secure context, navigator.storage.getDirectory()):
  pocketpad/
    saves/
      <gameId>/
        <slotId>.pps
        <slotId>.meta.json
        <slotId>.tmp            transient; deleted at store init

IndexedDB fallback:
  database  "pocketpad-saves" version 1
  store     "saves"           keyPath ["gameId", "slotId"]
  record    { gameId, slotId, file: ArrayBuffer, meta: SaveSlotMeta }
```

Why not `localStorage`: synchronous, ~5 MB origin cap, string-only, no atomic replace, and a single blocked write can stall the main thread. Why not `CacheStorage`: it stores HTTP responses with URL keys and cache-eviction semantics, not user-owned records with atomic replacement. Why not the File System Access API picker: it needs a user gesture per save and is not appropriate for automatic saves.

`gameId` and `slotId` are validated against their patterns **before** any path is built. No `..`, `/`, `\`, control characters, absolute path or URL is accepted. The storage root is origin-private; a save is never served over HTTP.

---

## 5. Architecture

### 5.1 Module map

| Path | Responsibility | Milestone |
|---|---|---|
| `packages/engine/core/src/save/header.ts` | `SaveHeader` codec, `fnv1a32`, `createSaveHeader`, `encode/decodeSaveHeader` (00 §6 assignment) | M0 |
| `packages/engine/core/src/save/types.ts` | constants, `SaveHeaderFields` alias, `SaveSlot`, `SaveResult`, error codes | M0 |
| `packages/engine/core/src/save/file.ts` | `encodeSaveFile`, `decodeSaveFile`, total-length and padding validation | M0/M1 |
| `packages/engine/core/src/save/store.ts` | pure `SaveStore` facade over injected adapter/codec/clock | M1 |
| `packages/engine/core/src/save/migrate.ts` | migration chain validation and application | M1 |
| `packages/engine/core/src/save/storage/memory.ts` | in-memory adapter for Node tests and failure injection | M0/M1 |
| `packages/engine/core/src/save/index.ts` | public exports only | M0/M1 |
| `packages/engine/core/test/save/**` | unit, property, golden, migration, crash, quota, PII tests | M0/M1 |

Runtime integration, **not owned here** (integration-agent files, by request): `packages/runtime/src/engine/saveStorageOpfs.ts`, `saveStorageIdb.ts`, `saveCodec.ts` (CompressionStream + crypto.subtle), `saveWorker.ts`, `saveApi.ts`, and the `GameContext` assembly in `packages/runtime/src/game/GameContext.ts`.

### 5.2 Codec vs storage: no browser APIs in engine-core

`engine-core` is zero-dependency, runs in Node and is subject to 00 D11 (DOM access is confined to `src/platform/`, `engine-input`, `engine-audio`, `engine-ui` and the renderer packages). The save subsystem respects this without an amendment:

- `header.ts`, `file.ts`, `store.ts`, `migrate.ts` and the memory adapter import **no** browser global. They use `TextEncoder`/`TextDecoder` (available in Node 20) and injected functions for compression, hashing, time and storage.
- The OPFS, IndexedDB, `CompressionStream`, `crypto.subtle`, `Worker` and `navigator.storage` calls live in `packages/runtime/src/engine/save*`, exactly as spec 12 puts `CacheStorage` in the runtime and keeps `engine-streaming` free of DOM I/O.
- If a future wave wants the adapters inside `engine-core/src/save/storage/`, 00 D11 must be amended first. The default plan does not need that amendment.

This is also why `SaveCodec` is injected: Node tests can supply deterministic fakes, and the browser supplies real implementations without the engine package importing `crypto` or `CompressionStream`.

### 5.3 Write path

```
game.save(slot, payload)
  → validate slotId, gameId, payload length
  → codec.compress? (optional)
  → FNV-1a 32 over stored payload
  → codec.sha256? (optional, for metadata)
  → createSaveHeader(...)
  → encodeSaveFile(header, storedPayload)          // full file in memory
  → verify file length + FNV again                  // before any I/O
  → quota preflight (optional estimate)
  → storage.writeAtomic(slotId, file, meta)         // commit point
  → return SaveSlot
```

The store does not stream a save to disk incrementally. Building the complete file first is what makes "a failed write leaves the previous save intact" true: every error that can be detected from the data (bad length, hash mismatch, compression failure) happens before the commit point.

If the metadata write fails **after** the `.pps` commit, the write still returns success for the save (the data is durable) and the metadata is marked stale; the next `list()`/`read()` rebuilds it. A metadata failure never corrupts or hides a valid save.

### 5.4 Read path

```
store.read(slotId)
  → validate slotId
  → storage.read(slotId)                  // undefined → E_SAVE_SLOT
  → decodeSaveHeader(bytes)               // E_SAVE_FORMAT / E_SAVE_VERSION
  → header.gameId === store.gameId ?       // else E_SAVE_GAME
  → migration chain if older               // E_SAVE_MIGRATION
  → decodeSaveFile(bytes)                  // length + FNV-1a 32 → E_SAVE_FORMAT/HASH
  → decompress if flags bit 0              // E_SAVE_UNSUPPORTED / E_SAVE_FORMAT
  → verify payloadUncompressedBytes
  → SHA-256 vs metadata if available       // E_SAVE_HASH
  → return { header, payload, slot, migratedFrom }
```

Order is normative:

1. Structure before content (header before payload hash).
2. FNV before decompression (00 §4.5: hash the stored payload before handing it to the game).
3. Length checks before allocation where possible.
4. Decompression with a hard output cap.
5. SHA-256 last, before returning.

A read never writes. It does not update `updatedAt`, does not rewrite a migrated file and does not repair a stale metadata record. Those are write-path concerns.

### 5.5 Storage tiers: OPFS primary, IndexedDB fallback

Tier selection, evaluated once at store creation:

| Order | Condition | Adapter |
|---:|---|---|
| 1 | `navigator.storage?.getDirectory` exists, the context is secure, and OPFS file handles support atomic `move()` | `opfs` |
| 2 | `indexedDB` exists and opens | `indexeddb` |
| 3 | Neither is usable | none → `E_SAVE_IO`; `ctx.save` is `undefined` |

Rules:

- OPFS requires a secure context. The dev server on a LAN IP over plain HTTP is **not** secure; IndexedDB is the expected dev fallback. On `localhost` OPFS is available.
- `navigator.storage.estimate()` and `navigator.storage.persist()` are advisory. The store may call `estimate()` for a preflight; it never calls `persist()` (host policy). A denied/absent estimate must not block a write.
- OPFS `move()` is the atomic commit. If `FileSystemFileHandle.prototype.move` is absent, do **not** emulate it with delete-then-rename (that is not atomic); use IndexedDB for writes.
- IndexedDB uses one `readwrite` transaction per save; `transaction.oncomplete` is the commit signal. A transaction abort is `E_SAVE_IO`; `QuotaExceededError` is `E_SAVE_QUOTA`.
- A storage adapter that throws a non-`SaveStorageError` is a bug: the store wraps it as `E_SAVE_IO` and logs only the slot id and byte count in dev.
- `kind` is available for diagnostics and tests; the game never branches on it for correctness.

### 5.6 Atomic write and crash recovery

**OPFS path:**

```
1. write <slotId>.tmp with createWritable(); write(file); close()
2. move(<slotId>.tmp, <slotId>.pps)      // atomic replace within the directory
3. write <slotId>.meta.json.tmp; close()
4. move(<slotId>.meta.json.tmp, <slotId>.meta.json)
```

- A crash before step 2 leaves the old `.pps` untouched and a `.tmp` behind.
- A crash during step 2 yields either the old file or the new file, never a mix.
- A crash between steps 2 and 4 leaves the new `.pps` with old/absent metadata. The save is valid; metadata is rebuilt.
- At store init, every `*.tmp` in the game's save directory is deleted. Only `.tmp` files are cleaned; no `.pps` and no `.meta.json` is touched.

**IndexedDB path:** one `readwrite` transaction puts the complete `{ gameId, slotId, file, meta }` record. IDB commits atomically; a crash yields the old record or the new record. No temp file exists.

`writeAtomic` is the only storage method allowed to change a `.pps`. It must replace the destination in one commit; an adapter that writes in place is non-conforming and fails the conformance suite.

### 5.7 Quota handling

- **Preflight.** If `navigator.storage.estimate()` is available, compute `remaining = quota - usage`. If `fileBytes > remaining`, return `E_SAVE_QUOTA` **before** writing. `estimate()` is advisory; the write path still catches `QuotaExceededError`.
- **On refusal.** Catch `QuotaExceededError` (`DOMException.name === "QuotaExceededError"`), return `E_SAVE_QUOTA`, and leave the previous save untouched. Never retry in a loop; never delete another slot.
- **No eviction.** The engine never frees space by deleting saves. The host may show a "manage saves" UI that calls `remove()` explicitly; that is the only deletion path.
- **Slot cap.** `maxSlots` (default 32) is a separate limit. A write to a new slot past the cap returns `E_SAVE_SLOT`; overwriting an existing slot is always allowed.
- **Persistence.** The host may call `navigator.storage.persist()` to reduce browser eviction. The store does not call it and does not claim durability beyond the browser's storage guarantees. A user clearing site data loses saves; this is stated in the host UI.
- **Private mode.** IndexedDB/OPFS may be unavailable or ephemeral. The store returns `E_SAVE_IO`/`E_SAVE_QUOTA`; the game runs without persistence. It never crashes the host.

### 5.8 Corruption handling and the no-delete rule

| Failure | Detection | Result | File effect |
|---|---|---|---|
| Bad magic, lengths, padding, reserved bits | `decodeSaveHeader` / `decodeSaveFile` | `E_SAVE_FORMAT` | none |
| `formatVersion` newer | `decodeSaveHeader` | `E_SAVE_VERSION` | none |
| No migration step | migration chain | `E_SAVE_MIGRATION` | none |
| Wrong game | header `gameId` vs store | `E_SAVE_GAME` | none |
| Payload bit flip | FNV-1a 32 / SHA-256 | `E_SAVE_HASH` | none |
| Decompression bomb | output cap | `E_SAVE_FORMAT` (aborted) | none |
| Missing compression support | bit 0 + no codec | `E_SAVE_UNSUPPORTED` | none |
| Storage read failure | adapter | `E_SAVE_IO` | none |
| Storage write failure | adapter before commit | `E_SAVE_QUOTA` / `E_SAVE_IO` | old save intact |
| Metadata write failure | adapter after commit | success + stale meta | new save valid |

Rules:

- `list()` must not throw for one corrupt file. It includes the slot with `readable: false` and the error. This is how a UI can offer "delete this damaged save" rather than silently hiding it.
- The engine's only automatic deletion is `*.tmp` at init. It never deletes a `.pps` or `.meta.json` it cannot parse.
- A game may explicitly overwrite a corrupt slot with `write()` (atomic replace) or delete it with `remove()`. Both are explicit caller actions.
- A successful overwrite destroys the previous version at the commit point. The engine does not keep a backup. A game that needs rollback writes a second slot; this is documented, not hidden.
- Error messages name the slot id and the code; they never include payload bytes, hashes of user data in logs, or a file path containing a user name.

### 5.9 Worker boundary

Save work is cold-path but can be large. The runtime may provide a `saveWorker` for `codec.compress`/`codec.decompress`/`codec.sha256`:

- The worker receives a **transferable** `ArrayBuffer` (or a copy when transfer is unavailable) and a small options object. It never receives the `Scene`, a game object, an `AssetHandle`, a DOM node or a token.
- It returns `{ stored: ArrayBuffer, uncompressedBytes, sha256 }` and transfers the buffer back.
- The store consumes the result on the calling task, not mid-tick. Saves are triggered from game code or host UI, never from `simulate`/`render` per frame.
- If `Worker` is unavailable or fails, the codec falls back to main-thread `CompressionStream`/`crypto.subtle`; if those are unavailable, it writes uncompressed and omits SHA-256. A worker failure never blocks a save that can be written uncompressed.
- No save task may run inside the fixed simulation tick. The host saves at a pause/menu/checkpoint boundary; a game that calls `save()` every tick is a game bug.
- Worker source is bundled by Vite as a declared entry. It imports no DOM module and no game package.

### 5.10 Cross-tab writes

- If `navigator.locks` exists, the runtime adapter takes `pocketpad-save:<gameId>:<slotId>` around `writeAtomic` and `remove`. This serializes two tabs writing the same slot.
- Without Web Locks, atomic replace still guarantees no partial file. The last completed write wins; there is no merge and no lost-update detection. `list()`/`read()` are lock-free.
- Cross-tab **reads** are safe: a reader sees the old file or the new file, never a mix.
- The spec does not claim multi-tab coordination beyond this. A host that needs it can take its own lock.

### 5.11 Time and determinism

- Save time is wall-clock, injected as `now(): number` in epoch milliseconds. It is not simulation time and never influences `simulate`.
- `createdAtUnixSeconds` is `floor(now / 1000)` clamped to u32. `updatedAtUnixMs` is the clock at metadata construction.
- Tests inject a fixed clock; no test depends on the real date.
- Saves are not part of the replay hash. Loading a save changes state deliberately; determinism tests compare a replay from a recorded start, not a save round trip.
- `Date.now`, `new Date()` and `performance.now` remain banned in engine simulation paths (00 §5.8, 01 §5.4). The save store's default clock is provided by the runtime adapter, outside those paths.

### 5.12 Privacy and security

- **No PII in engine-owned fields.** Header: game id, game version, engine version, timestamps, lengths, FNV hash, flags. Metadata: slot id, game id, SDK version, timestamps, SHA-256, byte count. None identifies a person.
- **Slot ids are opaque.** Use `manual-1`, `autosave`, `checkpoint-3`, never a player name, email, phone number or room code. `SAVE_SLOT_ID_PATTERN` enforces a path-safe, non-PII shape but cannot detect a human name; review and fixtures enforce the rule.
- **Payload rule for games.** Do not write player names, room codes, tokens, PINs, IP addresses, device identifiers or analytics ids into a save. A save is user data that a player can copy and share. This is a game contract; the engine cannot inspect opaque bytes.
- **No network.** Saves are never uploaded, fetched, relayed or included in a protocol frame. `SPEC.md` SR-12 (relay never persists message bodies) remains true; the relay never sees a save.
- **No analytics.** The engine does not count saves, slot names or load outcomes for telemetry (`SPEC.md` SR-7).
- **Logging.** Dev logs may include slot id, byte count and error code. They never include payload bytes, a full save path with a user name, or a token.
- **Untrusted input.** A `.pps` is data, never code. Parsing uses `DataView` and `TextDecoder`, never `eval`, `Function`, module loading or prototype assignment. All lengths are checked before allocation. An imported file (future host feature) goes through the same `decodeSaveFile` path as a stored file.
- **CSP.** Saves do not relax `SPEC.md` SR-8. OPFS/IndexedDB are same-origin storage, not a network origin.
- **Not a security boundary.** A local attacker can edit a save. The game must validate its own payload; the engine's hash is a corruption check, not a signature.

### 5.13 Error mapping

| Layer | Throws or returns | Codes |
|---|---|---|
| `header.ts` / `file.ts` | throws `EngineError` | `E_SAVE_FORMAT`, `E_SAVE_VERSION`, `E_SAVE_HASH` |
| migration chain | returns `SaveResult` | `E_SAVE_MIGRATION`, plus whatever a step returns |
| `SaveStore` | returns `SaveResult` for data/I/O; throws `EngineError` only for a programmer error (invalid `maxSlots`, disposed use) | all nine codes |
| storage adapter | throws `SaveStorageError` | `E_SAVE_QUOTA`, `E_SAVE_IO` |
| `SaveApi` | returns `SaveResult` | all nine codes |

A `SaveError.message` is a short human sentence. It never contains a token, a room code, a player name, raw payload bytes, or a URL with credentials. Dev mode may add the slot id and byte offset; production shows the sentence and the code.

---

## 6. File ownership

**One writer per file.** Spec 15 is the only writer under `packages/engine/core/src/save/**`. No other spec, game or agent edits these paths. A required change outside them is a request filed against the owning spec, not an edit.

| Path | Owner | Milestone | Contents |
|---|---|---|---|
| `docs/engine/15-save-load.md` | 15 | — | This document |
| `docs/engine/15-save-load.d.ts` | 15 | before implementation | Frozen, additive-only type contract (README §7.1); **not written by this documentation change** |
| `packages/engine/core/src/save/header.ts` | 15 | M0 | Frozen `SaveHeader` codec, `fnv1a32`, `createSaveHeader`, `encode/decodeSaveHeader`; 00 §6 assignment |
| `packages/engine/core/src/save/types.ts` | 15 | M0 | Constants, `SaveHeaderFields`/`SaveHeader`, `SaveResult`, `SaveErrorCode`, `SaveSlot`, `SaveData`, `SaveSlotMeta` |
| `packages/engine/core/src/save/file.ts` | 15 | M0/M1 | `encodeSaveFile`, `decodeSaveFile`, full-file validation |
| `packages/engine/core/src/save/store.ts` | 15 | M1 | Pure `SaveStore` facade; no browser globals |
| `packages/engine/core/src/save/migrate.ts` | 15 | M1 | Migration table validation and application |
| `packages/engine/core/src/save/storage/memory.ts` | 15 | M0/M1 | In-memory adapter for Node tests and fault injection |
| `packages/engine/core/src/save/index.ts` | 15 | M0/M1 | Public exports only |
| `packages/engine/core/test/save/**` | 15 | M0/M1 | Unit, property, golden, migration, crash, quota, PII tests and fixtures |
| `packages/engine/core/test/save/fixtures/**` | 15 | M0/M1 | `header-v1.bin`, `header-v1.json`, `invalid/*.pps`, `migration/*.pps`, `corrupt/*.pps`, `meta-v1.json`, `crash-plan.json`, `quota.json`, `slot-id.json` |
| `experiments/e15-save/**` | 15 | M1 | Browser round-trip page for OPFS/IDB; `window.__SAVE_BENCH__` for automation |

**Not owned here — integration-agent requests:**

| Path | Owning area | Request |
|---|---|---|
| `packages/runtime/src/engine/saveStorageOpfs.ts` | runtime | OPFS adapter with atomic `move()` and `*.tmp` cleanup |
| `packages/runtime/src/engine/saveStorageIdb.ts` | runtime | IndexedDB adapter, one transaction per commit |
| `packages/runtime/src/engine/saveCodec.ts` | runtime | `CompressionStream("deflate")`, `crypto.subtle.digest("SHA-256")` |
| `packages/runtime/src/engine/saveWorker.ts` | runtime | Optional worker entry; transferable buffers only |
| `packages/runtime/src/engine/saveApi.ts` | runtime | Bind `SaveStore` to `ctx.save`; supply `gameId`, `gameVersion`, `sdkVersion` |
| `packages/runtime/src/game/GameContext.ts` | runtime/18 | Add `save?: SaveApi` as an optional member when M1 lands |
| `packages/engine/core/package.json`, root `tsconfig.json`, root `vitest.config.ts`, `eslint.config.js` | integration agent (00 §5.16) | Workspace, project reference and Vitest project done 2026-10-22; ESLint boundary deferred to REVIEW RV-12 |
| `docs/todos/TRACEABILITY.md` | programme owner | **Partial 2026-10-23:** ER-15-01..06 and ER-15-11 registered; 07/08/09/10/12/13/14 remain |
| `docs/engine/00-architecture.md` §5.9 | 00 owner | **Done 2026-10-22:** all nine `E_SAVE_*` codes are in `EngineErrorCode` |
| `docs/engine/18-game-sdk.md` | 18 owner | **Done 2026-10-22:** `version?: string` added and `SaveApi` reserved structurally |

No root config, `package.json`, lockfile, SDK source or game file is touched by this documentation change. No commit is made.

---

## 7. Acceptance

All rows are **PENDING**. No engine code exists yet. A row becomes PASS only with a recorded build, device, browser version, date and evidence in `docs/RESULTS.md` (00 §7). Thresholds are limits from 00/`SPEC.md` or stated policy, never measurements. Requirement IDs must be registered in `docs/todos/TRACEABILITY.md`.

| ID | Criterion | Fixture / method | Hardware / run | State |
|---|---|---|---|---|
| ER-15-01 | The synthetic header encodes to exactly the 85-byte fixture, decodes to the same fields and re-encodes byte-identically; boundary cases (`gameId` 1/64 bytes, `gameVersion` 1/32, payload 0/32 MiB, `headerBytes` 48/136 reachable range, flags 0/1, timestamp 0/`0xFFFFFFFF`) all round-trip. `headerBytes` 40 and 144 are structurally invalid because both strings are at least one byte | `packages/engine/core/test/save/fixtures/header-v1.bin`, `header-v1.json`; `header.test.ts` | CI Node 20 | PENDING — codec not written |
| ER-15-02 | Every malformed header is refused as a unit with the named code: bad magic, `formatVersion` 0, `headerBytes` < 40 / > 144 / not a multiple of 8 / not minimal, `gameIdBytes` 0/65, `gameVersionBytes` 0/33, non-zero padding, reserved flag bits, `reserved !== 0`, `payloadBytes` > 32 MiB, truncated file, trailing byte | `fixtures/invalid/*.pps`; `file.test.ts` | CI Node 20 | PENDING |
| ER-15-03 | `fast-check` generates 10,000 valid headers and random mutations; `decode(encode(h))` equals `h`; every malformed input either throws `EngineError` with a save code or returns a valid header; no out-of-bounds read, no non-`EngineError` throw | `header.property.test.ts` | CI Node 20 | PENDING |
| ER-15-04 | FNV-1a 32 matches the published vectors for `""`, `"a"`, `"foobar"`, `"hello"`; the golden payload hashes to `0x635F8BC4`; a one-byte change changes the hash | `header.test.ts`, `fixtures/header-v1.bin` | CI Node 20 | PENDING |
| ER-15-05 | A `formatVersion: 2` file is refused with `E_SAVE_VERSION` and left byte-identical; in M0 a `formatVersion: 0` file is refused with `E_SAVE_FORMAT`; migration, the v1 identity step and `E_SAVE_MIGRATION` are M1 | `fixtures/migration/*.pps`; `migrate.test.ts` | CI Node 20 | PENDING |
| ER-15-06 | Single-bit flips across every byte of a 64-byte payload are each refused with `E_SAVE_HASH`; the file remains byte-identical; `list()` still reports the slot with `readable: false`; a SHA-256 mismatch is also `E_SAVE_HASH` | `fixtures/corrupt/*.pps`; `store.test.ts` | CI Node 20 | PENDING |
| ER-15-07 | Crash injection at five points (during temp write, after temp close, before rename, after rename, before meta write) never yields a partial `.pps`; the old save is readable after every pre-commit failure; init removes only `*.tmp`; a post-commit meta failure still returns a valid save | `fixtures/crash-plan.json`; fault-injecting memory adapter | CI Node 20 | PENDING |
| ER-15-08 | A write that exceeds a fake 1 MiB quota returns `E_SAVE_QUOTA`, leaves the previous save byte-identical and deletes no other slot; a 33rd slot returns `E_SAVE_SLOT`; no automatic eviction occurs | `fixtures/quota.json`; `store.test.ts` | CI Node 20 | PENDING |
| ER-15-09 | OPFS round trip: write, `list()`, `read()` return identical header fields and payload; `remove()` deletes exactly one slot; no `.tmp` remains; a 32 MiB payload is written and read back | `experiments/e15-save/?case=opfs`; `window.__SAVE_BENCH__` | Desktop Chrome 155, Windows 11, `localhost` (secure context) | PENDING — M1 |
| ER-15-10 | IndexedDB fallback: with OPFS denied, write/read/list/remove work and survive a reload; with both unavailable, `ctx.save` is `undefined`, `SaveStore` creation reports `E_SAVE_IO`, and the game still runs | `experiments/e15-save/?case=idb`, `?case=none` | Desktop Chrome 155, Windows 11 | PENDING — M1 |
| ER-15-11 | A newer or unreadable slot is listed with `readable: false` and the stable code; it is never deleted by list/read/init; only explicit `remove()` deletes it; a successful overwrite atomically replaces it | `fixtures/invalid/*.pps`, `migration/*.pps`; `store.test.ts` | CI Node 20 | PENDING |
| ER-15-12 | PII/secret scan: engine-generated headers, metadata, fixtures and log lines contain none of `token`, `room`, `pin`, `session`, `@`, an IPv4 address or a player-name field; error messages never include payload bytes | `fixtures/pii-scan.json`; `pii.test.ts`; review of `docs/RESULTS.md` | CI Node 20 | PENDING |
| ER-15-13 | Vertical-slice round trip: save a running game, reload the page, load the save, and reproduce the same state hash at the same tick; record save/load wall time, slot size, browser, adapter and build hash in `docs/RESULTS.md` (no threshold asserted) | M1 city-block slice; `packages/runtime/test/integration/saveLoad.test.ts` | Desktop Chrome 155, Windows 11, `pc-win11-rtx3050` | PENDING — M1 |
| ER-15-14 | TV storage audit: record whether OPFS, IndexedDB, WebCrypto and `DecompressionStream` are available; saves work through at least IndexedDB; a save survives a TV browser restart; failures degrade to `ctx.save === undefined` without wedging the host | `experiments/e15-save/?case=tv`; manual checklist | **PENDING device:** 2020-era Android TV Chromium, plus the Tizen/webOS set from `SPEC.md` §12 | PENDING — no TV hardware |

The M1 rows are deliberately separated from the M0 codec rows. A green codec does **not** prove storage, atomicity or a vertical-slice round trip.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | header field validation, byte offsets, UTF-8 byte lengths, padding, flags, FNV, `createSaveHeader`, `encode/decodeSaveHeader`, file length, error codes, slot-id rules | `packages/engine/core/test/save/header.test.ts`, `file.test.ts` |
| Property (`fast-check`) | random valid headers round-trip; random truncations and bit flips never read out of bounds; random field mutations always fail with a save code; random slot ids/versions stay within limits | `packages/engine/core/test/save/header.property.test.ts` |
| Golden | `header-v1.bin` + `header-v1.json` exact bytes; `meta-v1.json`; invalid-file rejection codes; migration fixtures | `packages/engine/core/test/save/fixtures/` |
| Migration | v1 identity; no step from 0; skipped/duplicate/non-ascending chain refused; re-hash after each step; input buffer not mutated; read does not rewrite | `packages/engine/core/test/save/migrate.test.ts` |
| Store (Node) | write/read/list/remove over the memory adapter; quota; max slots; crash injection; corrupted hash; newer version; wrong game; `dispose` idempotence; no callback after dispose | `packages/engine/core/test/save/store.test.ts` |
| Store (browser) | real OPFS and IndexedDB adapters; reload persistence; 32 MiB payload; temp cleanup; OPFS denied fallback; both denied | `experiments/e15-save/` + `packages/engine/core/test/save/store.browser.test.ts` |
| Security/privacy | PII/secret scan over fixtures, metadata and log capture; no payload bytes in messages; path-traversal slot ids rejected before any adapter call | `packages/engine/core/test/save/pii.test.ts` |
| Integration | M1 slice save → reload → load → state hash; runtime adapter wiring; `ctx.save` absent when storage is unavailable | `packages/runtime/test/integration/saveLoad.test.ts` (integration agent) |
| Manual | TV storage audit; browser restart; site-data clear; quota exhaustion on a real profile; record in `docs/RESULTS.md` | `docs/RESULTS.md` rows ER-15-09/10/13/14 |

Rules:

- **Every test title carries its ER id**, for example:
  - `test("[ER-15-01] the synthetic header encodes to the exact 85-byte fixture", ...)`
  - `test("[ER-15-02] a non-minimal headerBytes value is refused with E_SAVE_FORMAT", ...)`
  - `test("[ER-15-04] FNV-1a 32 matches the published vectors", ...)`
  - `test("[ER-15-05] a newer formatVersion is refused with E_SAVE_VERSION and the file is unchanged", ...)`
  - `test("[ER-15-06] every single-bit payload flip is refused with E_SAVE_HASH", ...)`
  - `test("[ER-15-07] a crash after temp close leaves the previous save readable", ...)`
  - `test("[ER-15-08] a quota failure leaves the previous save byte-identical", ...)`
- Integration tests bind `127.0.0.1:0`, wait on messages/promises and never use fixed sleeps.
- Node tests use the memory adapter and injected clock/codec; they perform no network and no real filesystem I/O.
- Browser tests run in real Chromium (Desktop Chrome 155 for evidence); they are not deleted or skipped to make CI green.
- The bit-flip test is exhaustive for a 64-byte payload (512 flips) and sampled for larger payloads; every flip must fail the hash, and the file must remain unchanged.
- Crash injection is deterministic: the fake adapter throws at a named point, the test asserts the observable state and then re-opens the store to assert temp cleanup. No timing or real crash is involved.
- No test asserts a save latency or throughput number. Wall time is recorded manually in `docs/RESULTS.md` for ER-15-13, with browser, adapter and build hash.
- Fixtures are synthetic. They contain no real player data, token, room code or IP address. A fixture change is explained by a format change and updates the golden in the same change.

---

## 9. Dependencies

**Specs and packages**

| Dependency | What 15 needs | State |
|---|---|---|
| `00-architecture.md` | frozen `SaveHeader` byte layout (§4.5), `EngineErrorCode`, version policy (§5.15), D11 browser boundary, package map (§6) | Written |
| `01-core-loop-time.md` | injected wall clock for `now()` outside the tick; `ENGINE_VERSION` companion | Written |
| `03-scene-ecs.md` | `SceneSnapshot` and `Scene.load()` for scene-owned state; `EntityId` is runtime-local and never persisted | Written |
| `07-physics3d.md` | no persisted physics representation; game collects its own body state | Written |
| `12-world-streaming.md` | `CellStateStore.serialize()/restore()` CSTR bytes; save embeds them opaquely; restore before the first `update` | Written |
| `18-game-sdk.md` | `ctx.save?: SaveApi` reserved slot; `GameManifest` has no `version` field today | Written; two requests below |
| `19-testing-benchmarks.md` | ER grammar, evidence format, browser test harness | written |

**Implementation prerequisites**

- `engine-core` exports `ENGINE_VERSION` and `EngineError`/`EngineErrorCode`; the save codec imports them from the same package.
- The runtime supplies `SaveStorageAdapter`, `SaveCodec` and `SaveApi` bindings; `engine-core` imports no browser API (00 D11).
- `TextEncoder`/`TextDecoder` are available in Node 20 and every target browser. They are the only globals used by the pure codec.
- The browser target for M1 is Desktop Chrome 155 on Windows 11 for evidence. OPFS requires a secure context; IndexedDB is the fallback on plain-HTTP LAN dev.
- `CompressionStream("deflate")`, `DecompressionStream("deflate")`, `crypto.subtle`, `Worker`, `navigator.storage` and `navigator.locks` are feature-detected. Absence degrades, never crashes.
- No third-party runtime package enters `engine-core` or the save path. No WASM, no compression library, no hashing library.

**Paper-trail prerequisites (same change as the first implementation)**

- Add `E_SAVE_GAME`, `E_SAVE_QUOTA`, `E_SAVE_IO`, `E_SAVE_MIGRATION`, `E_SAVE_SLOT`, `E_SAVE_UNSUPPORTED` to `EngineErrorCode` in 00 §5.9 (additive; allowed).
- Register ER-15-01..14 in `docs/todos/TRACEABILITY.md`.
- Request from 18: add `version?: string` (strict `x.y.z`, default `"1.0.0"`) to `GameManifest`, and restate `SaveApi` structurally when M1 lands. Until then, the game/host supplies `gameVersion` explicitly to `SaveStore.write`; the engine never invents one.
- When M1 lands, update `docs/ENGINE.md`, the engine wave checkpoint and `docs/RESULTS.md` rows in the same change.
- A14 (browser-native engine reframe) already authorises the engine track. **No new amendment is needed for v1 save/load** because the frozen header is unchanged. An in-file SHA-256 or a header field change needs **A19** and `SAVE_FORMAT_VERSION` 2.

**Cross-spec notes**

- **12:** spec 12 says "spec 15 embeds the CSTR payload". This spec keeps the payload opaque. The game or runtime adapter embeds `stateStore.serialize()` bytes in its payload and calls `stateStore.restore()` before the first `streamer.update()`. If `restore()` throws `E_STATE_*`, the game aborts the load before mutating other state. Spec 15 does not parse CSTR and does not own its version.
- **18:** `GameContext` is frozen; `ctx.save` must be optional and absent when storage is unavailable. `SaveApi` is a structural projection, not an engine import.
- **03:** scene-owned state is a `SceneSnapshot` inside the game payload; the game calls `Scene.load()` only after validating the whole payload. Runtime `EntityId`s are never persisted. A game that needs stable references uses its own ids in its payload.
- **07:** physics state is game-owned. This spec does not define a body serialization; a game that wants to persist vehicles or ragdolls collects their state into its payload.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | The frozen header lacks a field the product needs (in-file SHA-256, `sdkVersion`, `slotId`, `updatedAt`) and an agent silently redefines it | Medium | Corrupt format, broken readers | The frozen note and §4.10 place these in slot metadata; a real change requires A19 + `SAVE_FORMAT_VERSION` 2 + a v1 reader; ER-15-05/11 test the boundary |
| R2 | OPFS is unavailable (insecure LAN context, TV browser, private mode) | High on LAN/TV | Saves silently stop working | IndexedDB fallback, `E_SAVE_IO`, `ctx.save === undefined`, game continues; ER-15-10/14 |
| R3 | Quota exhaustion during a save | Medium | Save fails; player loses new progress | Preflight, `E_SAVE_QUOTA`, old save intact, no auto-eviction; explicit manage UI; ER-15-08 |
| R4 | A crash or tab close mid-write leaves a partial or lost save | Medium | Corrupt save, lost progress | Build and verify the whole file first; atomic OPFS `move` or one IDB transaction; temp cleanup; five-point crash test ER-15-07 |
| R5 | A bit flip or truncated file reaches the game | Medium | Wrong game state | FNV on the stored payload before decompression; optional SHA-256; `E_SAVE_HASH`; exhaustive flip test ER-15-06 |
| R6 | A newer save is read by an older build | Medium after a game update/rollback | Corrupt state | `E_SAVE_VERSION`, no best-effort parse, file untouched; ER-15-05 |
| R7 | Migration chain has a gap or a bug | Medium over years | Unreadable old saves | Contiguous `n → n+1` steps, re-hash each step, identity/gap fixtures, no downgrade; game payload migrations are game-owned |
| R8 | A 32 MiB compressed payload expands to gigabytes | Medium (malicious/corrupt file) | Host memory exhaustion | Declared `payloadUncompressedBytes` ≤ 64 MiB; streaming decompression aborts at the cap; `E_SAVE_FORMAT` |
| R9 | Compression/hash blocks the main thread | Medium on large saves | Frame hitch | Injected async codec; optional worker with transferables; no save work in `simulate`/`render`; uncompressed fallback |
| R10 | PII or a token is written into a save or a log | Medium if games improvise slot ids/payloads | Privacy breach (SR-7, SR-9) | Engine fields contain no PII; slot-id pattern; game payload rule; PII scan ER-15-12; error redaction |
| R11 | Two tabs write the same slot | Medium | Lost update | Web Locks when available; atomic replace means no corruption; last completed write wins; documented, never merged |
| R12 | `GameManifest` has no `version`, so `gameVersion` is missing or invented | Medium until 18 adds it | Misleading save metadata | `SaveWriteOptions.gameVersion` is required; request `version?: string` from 18; no default invented in the store |
| R13 | The save store drifts into `engine-core` browser APIs, breaking Node tests or D11 | Medium | Boundary/lint failure | Pure core + injected adapter/codec/clock; browser adapters in the runtime, mirroring spec 12's CacheStorage split |
| R14 | A read succeeds but the game applies its payload partially | Medium if a game is careless | Half-loaded world | I5: the game validates the whole payload before mutating; the engine returns complete verified bytes and never calls game apply itself; integration test asserts hash equality after load |
| R15 | Browsers evict site data, so a "saved" game disappears | Medium | Player surprise | Host calls `navigator.storage.persist()` when appropriate; UI warns that clearing site data deletes saves; no durability claim beyond the browser |
| R16 | Save size grows toward 32 MiB and slows every write | Medium at M1 scale | Long save pauses | Payload is game-composed; game may split slots or compress; the engine caps at 32 MiB and records real timings in RESULTS rather than inventing a budget |

**Fallback if OPFS and IndexedDB are both unavailable:** `SaveStore` creation returns `E_SAVE_IO`, `ctx.save` is `undefined`, and the game runs a no-persistence session. The host shows a one-line notice; it does not crash, retry forever, or write to `localStorage` as a silent substitute. **Fallback if a save cannot be read:** return the stable code, keep the file, list it as unreadable, and let the player update the game or explicitly delete it. The engine never deletes a save it cannot read.

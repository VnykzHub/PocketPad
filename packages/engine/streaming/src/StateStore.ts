/**
 * Authoritative world-state store and the CSTR codec (spec 12 §3.4, §4.4,
 * `src/StateStore.ts`).
 *
 * Layout (canonical, little-endian): the 48-byte header, then a contiguous
 * `cellCount × 28`-byte record table in ascending `(cx, cy)`, then each cell's
 * `flags` words in table order, then each cell's entities (ascending
 * `localId`) and destroyed ids (ascending) back to back. The record's
 * `entitiesOffset` / `destroyedOffset` are absolute payload offsets and must
 * point exactly where that canonical layout puts them; a non-canonical but
 * in-bounds payload is rejected as `E_STATE_ORDER`, which is what makes
 * `serialize → restore → serialize` byte-identical (ER-12-09).
 *
 * The entity record's `flags u16` word has no counterpart in
 * `EntityStateRecord`; serialization writes 0 and restore ignores it. This is
 * a contract gap reported for the owning spec.
 *
 * Sparse flag: `serialize(keys)` sets bit 0 whenever the requested set is
 * smaller than the grid, and clears it when it covers every cell. The spec's
 * "first write allocates a record" cannot be implemented literally because
 * the frozen interface has no write entry point, so `get` allocates on first
 * access and the additive `setRngCursor` / `advanceRng` / `setEntities` /
 * `setDestroyed` methods perform writes explicitly and mark dirty.
 */

import { fnv1a32 } from "@lanpad/engine-core";
import type {
  CellKey,
  CellRuntimeState,
  CellStateStore as CellStateStoreContract,
  EntityStateRecord,
  WorldConfig,
} from "./contracts/world.js";
import {
  CellGrid,
  formatCellKey,
  sortCellKeys,
  tryParseCellKey,
} from "./Grid.js";
import { streamingError } from "./StreamEvents.js";

export const CELL_STATE_FORMAT_VERSION = 1;
export const CSTR_MAGIC = 0x5254_5343;
export const CSTR_HEADER_BYTES = 48;
export const CSTR_CELL_RECORD_BYTES = 28;
export const CSTR_ENTITY_RECORD_BYTES = 52;
export const CSTR_SPARSE_FLAG = 0x1;
export const CSTR_MAX_FLAGS = 16;
export const CSTR_MAX_ENTITIES_PER_CELL = 0xffff;
const FLOAT32_MAX = 3.402_823_466_385_288_6e38;

interface MutableCellRecord {
  readonly key: CellKey;
  rngCursor: number;
  readonly flags: Uint32Array;
  entities: readonly EntityStateRecord[];
  destroyed: readonly number[];
}

interface CellSnapshot {
  readonly key: CellKey;
  readonly cx: number;
  readonly cy: number;
  readonly rngCursor: number;
  readonly flags: Uint32Array;
  readonly entities: readonly EntityStateRecord[];
  readonly destroyed: readonly number[];
}

/**
 * The engine's `CellStateStore`. Construct one per world with the world's
 * `WorldConfig`; it is always resident for the whole grid.
 */
export class WorldStateStore implements CellStateStoreContract {
  readonly config: WorldConfig;
  private readonly grid: CellGrid;
  private readonly records = new Map<CellKey, MutableCellRecord>();
  private readonly dirtyKeys = new Set<CellKey>();
  private disposed = false;

  constructor(config: WorldConfig) {
    this.config = config;
    this.grid = new CellGrid(config);
  }

  get dirty(): readonly CellKey[] {
    return sortCellKeys([...this.dirtyKeys]);
  }

  /** Additive: number of cells with an allocated record. */
  get allocatedCells(): number {
    return this.records.size;
  }

  get(key: CellKey): CellRuntimeState {
    this.assertLive();
    this.requireKey(key);
    const existing = this.records.get(key);
    if (existing !== undefined) return existing;
    const record: MutableCellRecord = {
      key,
      rngCursor: 0,
      flags: new Uint32Array(CSTR_MAX_FLAGS),
      entities: [],
      destroyed: [],
    };
    this.records.set(key, record);
    return record;
  }

  markDirty(key: CellKey): void {
    this.assertLive();
    this.requireKey(key);
    this.dirtyKeys.add(key);
  }

  clearDirty(): void {
    this.assertLive();
    this.dirtyKeys.clear();
  }

  /** Additive write: sets the per-cell RNG cursor (`u32`). */
  setRngCursor(key: CellKey, cursor: number): void {
    this.assertLive();
    this.requireKey(key);
    this.recordFor(key).rngCursor = requireU32(cursor, "rngCursor");
    this.dirtyKeys.add(key);
  }

  /** Additive write: advances `rngCursor` with unsigned wraparound. */
  advanceRng(key: CellKey, delta = 1): number {
    this.assertLive();
    this.requireKey(key);
    if (!Number.isInteger(delta) || delta < 0 || delta > 0xffff_ffff) {
      throw streamingError("E_STATE_FORMAT", "rng delta must be a u32 integer");
    }
    const record = this.recordFor(key);
    record.rngCursor = (record.rngCursor + delta) >>> 0;
    this.dirtyKeys.add(key);
    return record.rngCursor;
  }

  /** Additive write: replaces the entity list (stored sorted by `localId`). */
  setEntities(key: CellKey, entities: readonly EntityStateRecord[]): void {
    this.assertLive();
    this.requireKey(key);
    const sorted = sortEntities(entities);
    this.recordFor(key).entities = sorted;
    this.dirtyKeys.add(key);
  }

  /** Additive write: replaces the destroyed-id list (stored ascending). */
  setDestroyed(key: CellKey, destroyed: readonly number[]): void {
    this.assertLive();
    this.requireKey(key);
    this.recordFor(key).destroyed = sortDestroyed(destroyed);
    this.dirtyKeys.add(key);
  }

  /** Every cell key in the grid, canonical order (rule 7 of §5.6). */
  allKeys(): CellKey[] {
    this.assertLive();
    const keys: CellKey[] = [];
    this.grid.forEachCell((cx, cy) => {
      keys.push(formatCellKey(cx, cy));
    });
    return keys;
  }

  /** `fnv1a32(serialize(keys))`; defaults to the full grid (12 §5.6). */
  stateHash(keys?: readonly CellKey[]): number {
    return fnv1a32(new Uint8Array(this.serialize(keys ?? this.allKeys())));
  }

  serialize(keys: readonly CellKey[]): ArrayBuffer {
    this.assertLive();
    const snapshots = this.snapshotsFor(keys);
    const count = snapshots.length;

    let tableBytes = 0;
    let flagsBytes = 0;
    let entitiesBytes = 0;
    let destroyedBytes = 0;
    let entityTotal = 0;
    for (const snapshot of snapshots) {
      if (snapshot.flags.length > CSTR_MAX_FLAGS) {
        throw streamingError("E_STATE_ORDER", `cell ${snapshot.key} has too many flags`);
      }
      if (snapshot.entities.length > CSTR_MAX_ENTITIES_PER_CELL) {
        throw streamingError("E_STATE_ORDER", `cell ${snapshot.key} has too many entities`);
      }
      if (snapshot.destroyed.length > CSTR_MAX_ENTITIES_PER_CELL) {
        throw streamingError("E_STATE_ORDER", `cell ${snapshot.key} has too many destroyed ids`);
      }
      tableBytes += CSTR_CELL_RECORD_BYTES;
      flagsBytes += 4 * snapshot.flags.length;
      entitiesBytes += CSTR_ENTITY_RECORD_BYTES * snapshot.entities.length;
      destroyedBytes += 4 * snapshot.destroyed.length;
      entityTotal += snapshot.entities.length;
    }
    if (entityTotal > 0xffff_ffff) {
      throw streamingError("E_STATE_ORDER", "entity count exceeds u32");
    }
    const payloadBytes = tableBytes + flagsBytes + entitiesBytes + destroyedBytes;
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes > 0xffff_ffff) {
      throw streamingError("E_STATE_ORDER", "state payload exceeds the u32 payload size");
    }

    const entitiesOffsets: number[] = [];
    const destroyedOffsets: number[] = [];
    let cursor = tableBytes + flagsBytes;
    for (const snapshot of snapshots) {
      entitiesOffsets.push(cursor);
      cursor += CSTR_ENTITY_RECORD_BYTES * snapshot.entities.length;
      destroyedOffsets.push(cursor);
      cursor += 4 * snapshot.destroyed.length;
    }

    const buffer = new ArrayBuffer(CSTR_HEADER_BYTES + payloadBytes);
    const view = new DataView(buffer);
    const sparse = count < this.grid.cellCount;
    view.setUint32(0, CSTR_MAGIC, true);
    view.setUint16(4, CELL_STATE_FORMAT_VERSION, true);
    view.setUint16(6, CSTR_HEADER_BYTES, true);
    view.setUint32(8, this.config.seed >>> 0, true);
    view.setUint32(12, count, true);
    view.setUint32(16, entityTotal, true);
    view.setUint32(20, payloadBytes, true);
    view.setUint32(28, sparse ? CSTR_SPARSE_FLAG : 0, true);

    const payload = new DataView(buffer, CSTR_HEADER_BYTES);

    // Record table.
    for (let index = 0; index < count; index += 1) {
      const snapshot = snapshots[index];
      const entitiesOffset = entitiesOffsets[index];
      const destroyedOffset = destroyedOffsets[index];
      if (snapshot === undefined || entitiesOffset === undefined || destroyedOffset === undefined) {
        throw streamingError("E_STATE_ORDER", "internal snapshot table mismatch");
      }
      const base = index * CSTR_CELL_RECORD_BYTES;
      payload.setInt32(base, snapshot.cx, true);
      payload.setInt32(base + 4, snapshot.cy, true);
      payload.setUint32(base + 8, snapshot.rngCursor >>> 0, true);
      payload.setUint16(base + 12, snapshot.flags.length, true);
      payload.setUint16(base + 14, snapshot.entities.length, true);
      payload.setUint16(base + 16, snapshot.destroyed.length, true);
      payload.setUint16(base + 18, 0, true);
      payload.setUint32(base + 20, entitiesOffset, true);
      payload.setUint32(base + 24, destroyedOffset, true);
    }

    // Flags, in table order.
    let flagsCursor = tableBytes;
    for (const snapshot of snapshots) {
      for (let index = 0; index < snapshot.flags.length; index += 1) {
        payload.setUint32(flagsCursor, snapshot.flags[index] ?? 0, true);
        flagsCursor += 4;
      }
    }

    // Entities and destroyed ids at their declared offsets.
    for (let cellIndex = 0; cellIndex < count; cellIndex += 1) {
      const snapshot = snapshots[cellIndex];
      const entitiesOffset = entitiesOffsets[cellIndex];
      const destroyedOffset = destroyedOffsets[cellIndex];
      if (snapshot === undefined || entitiesOffset === undefined || destroyedOffset === undefined) {
        throw streamingError("E_STATE_ORDER", "internal snapshot table mismatch");
      }
      let entityCursor = entitiesOffset;
      for (const entity of snapshot.entities) {
        payload.setUint32(entityCursor, entity.localId >>> 0, true);
        payload.setUint16(entityCursor + 4, entity.kind & 0xffff, true);
        payload.setUint16(entityCursor + 6, 0, true);
        payload.setFloat32(entityCursor + 8, entity.position.x, true);
        payload.setFloat32(entityCursor + 12, entity.position.y, true);
        payload.setFloat32(entityCursor + 16, entity.position.z, true);
        payload.setFloat32(entityCursor + 20, entity.rotation.x, true);
        payload.setFloat32(entityCursor + 24, entity.rotation.y, true);
        payload.setFloat32(entityCursor + 28, entity.rotation.z, true);
        payload.setFloat32(entityCursor + 32, entity.rotation.w, true);
        payload.setUint32(entityCursor + 36, entity.state[0] ?? 0, true);
        payload.setUint32(entityCursor + 40, entity.state[1] ?? 0, true);
        payload.setUint32(entityCursor + 44, entity.state[2] ?? 0, true);
        payload.setUint32(entityCursor + 48, entity.state[3] ?? 0, true);
        entityCursor += CSTR_ENTITY_RECORD_BYTES;
      }
      let destroyedCursor = destroyedOffset;
      for (const id of snapshot.destroyed) {
        payload.setUint32(destroyedCursor, id >>> 0, true);
        destroyedCursor += 4;
      }
    }

    view.setUint32(24, fnv1a32(new Uint8Array(buffer, CSTR_HEADER_BYTES)), true);
    return buffer;
  }

  restore(bytes: ArrayBuffer): void {
    this.assertLive();
    if (!(bytes instanceof ArrayBuffer)) {
      throw streamingError("E_STATE_FORMAT", "CSTR payload must be an ArrayBuffer");
    }
    if (bytes.byteLength < CSTR_HEADER_BYTES) {
      throw streamingError("E_STATE_FORMAT", "CSTR payload is shorter than its header");
    }
    const view = new DataView(bytes);
    if (view.getUint32(0, true) !== CSTR_MAGIC) {
      throw streamingError("E_STATE_FORMAT", "CSTR magic mismatch");
    }
    if (view.getUint16(4, true) !== CELL_STATE_FORMAT_VERSION) {
      throw streamingError("E_STATE_FORMAT", "unsupported CSTR formatVersion");
    }
    if (view.getUint16(6, true) !== CSTR_HEADER_BYTES) {
      throw streamingError("E_STATE_FORMAT", "CSTR headerBytes must be 48");
    }
    if (view.getUint32(8, true) !== (this.config.seed >>> 0)) {
      throw streamingError("E_STATE_WORLD", "CSTR worldSeed does not match the world");
    }
    const cellCount = view.getUint32(12, true);
    const entityTotal = view.getUint32(16, true);
    const payloadBytes = view.getUint32(20, true);
    if (payloadBytes !== bytes.byteLength - CSTR_HEADER_BYTES) {
      throw streamingError("E_STATE_FORMAT", "CSTR payloadBytes does not match the buffer");
    }
    const flags = view.getUint32(28, true);
    if ((flags & ~CSTR_SPARSE_FLAG) !== 0) {
      throw streamingError("E_STATE_FORMAT", "CSTR has unknown flag bits");
    }
    for (let offset = 32; offset < CSTR_HEADER_BYTES; offset += 4) {
      if (view.getUint32(offset, true) !== 0) {
        throw streamingError("E_STATE_FORMAT", "CSTR reserved header bytes must be zero");
      }
    }
    if (fnv1a32(new Uint8Array(bytes, CSTR_HEADER_BYTES, payloadBytes)) !== view.getUint32(24, true)) {
      throw streamingError("E_STATE_HASH", "CSTR content hash mismatch");
    }
    if (cellCount > this.grid.cellCount) {
      throw streamingError("E_STATE_ORDER", "CSTR declares more cells than the grid holds");
    }
    const sparse = (flags & CSTR_SPARSE_FLAG) !== 0;
    if (!sparse && cellCount !== this.grid.cellCount) {
      throw streamingError("E_STATE_ORDER", "a dense CSTR payload must contain every cell");
    }

    const tableBytes = CSTR_CELL_RECORD_BYTES * cellCount;
    if (tableBytes > payloadBytes) {
      throw streamingError("E_STATE_ORDER", "CSTR cell table exceeds the payload");
    }
    const payload = new DataView(bytes, CSTR_HEADER_BYTES);

    interface RawRecord {
      cx: number;
      cy: number;
      rngCursor: number;
      flagCount: number;
      entityCount: number;
      destroyedCount: number;
      entitiesOffset: number;
      destroyedOffset: number;
    }
    const raw: RawRecord[] = [];
    let previousCx = Number.NEGATIVE_INFINITY;
    let previousCy = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < cellCount; index += 1) {
      const base = index * CSTR_CELL_RECORD_BYTES;
      const record: RawRecord = {
        cx: payload.getInt32(base, true),
        cy: payload.getInt32(base + 4, true),
        rngCursor: payload.getUint32(base + 8, true),
        flagCount: payload.getUint16(base + 12, true),
        entityCount: payload.getUint16(base + 14, true),
        destroyedCount: payload.getUint16(base + 16, true),
        entitiesOffset: payload.getUint32(base + 20, true),
        destroyedOffset: payload.getUint32(base + 24, true),
      };
      if (payload.getUint16(base + 18, true) !== 0) {
        throw streamingError("E_STATE_FORMAT", "CSTR cell record reserved word must be zero");
      }
      if (record.flagCount > CSTR_MAX_FLAGS) {
        throw streamingError("E_STATE_ORDER", "CSTR cell has more than 16 flags");
      }
      if (!this.grid.contains(record.cx, record.cy)) {
        throw streamingError("E_STATE_BOUNDS", `CSTR cell (${record.cx},${record.cy}) is out of grid`);
      }
      if (record.cx < previousCx || (record.cx === previousCx && record.cy <= previousCy)) {
        throw streamingError("E_STATE_ORDER", "CSTR cells are not in ascending key order");
      }
      previousCx = record.cx;
      previousCy = record.cy;
      raw.push(record);
    }

    // Flags follow the table in table order.
    let flagsCursor = tableBytes;
    const flagSets: Uint32Array[] = [];
    for (const record of raw) {
      const bytesNeeded = 4 * record.flagCount;
      if (flagsCursor + bytesNeeded > payloadBytes) {
        throw streamingError("E_STATE_ORDER", "CSTR flags run past the payload");
      }
      const set = new Uint32Array(record.flagCount);
      for (let index = 0; index < record.flagCount; index += 1) {
        set[index] = payload.getUint32(flagsCursor + 4 * index, true);
      }
      flagSets.push(set);
      flagsCursor += bytesNeeded;
    }

    // Entities and destroyed ids must sit exactly at their canonical offsets.
    let blobCursor = flagsCursor;
    const parsedEntities: EntityStateRecord[][] = [];
    const parsedDestroyed: number[][] = [];
    let countedEntities = 0;
    for (let index = 0; index < raw.length; index += 1) {
      const record = raw[index];
      if (record === undefined) {
        throw streamingError("E_STATE_ORDER", "CSTR record table mismatch");
      }
      if (record.entitiesOffset !== blobCursor) {
        throw streamingError("E_STATE_ORDER", "CSTR entitiesOffset is not canonical");
      }
      const entitiesEnd = blobCursor + CSTR_ENTITY_RECORD_BYTES * record.entityCount;
      if (entitiesEnd > payloadBytes) {
        throw streamingError("E_STATE_ORDER", "CSTR entities run past the payload");
      }
      if (record.destroyedOffset !== entitiesEnd) {
        throw streamingError("E_STATE_ORDER", "CSTR destroyedOffset is not canonical");
      }
      const destroyedEnd = entitiesEnd + 4 * record.destroyedCount;
      if (destroyedEnd > payloadBytes) {
        throw streamingError("E_STATE_ORDER", "CSTR destroyed ids run past the payload");
      }

      const entities: EntityStateRecord[] = [];
      let previousLocalId = -1;
      for (let entityIndex = 0; entityIndex < record.entityCount; entityIndex += 1) {
        const base = record.entitiesOffset + CSTR_ENTITY_RECORD_BYTES * entityIndex;
        const localId = payload.getUint32(base, true);
        if (localId <= previousLocalId) {
          throw streamingError("E_STATE_ORDER", "CSTR entities are not in ascending localId order");
        }
        previousLocalId = localId;
        const position = {
          x: requireFinite(payload.getFloat32(base + 8, true), "entity px"),
          y: requireFinite(payload.getFloat32(base + 12, true), "entity py"),
          z: requireFinite(payload.getFloat32(base + 16, true), "entity pz"),
        };
        const rotation = {
          x: requireFinite(payload.getFloat32(base + 20, true), "entity qx"),
          y: requireFinite(payload.getFloat32(base + 24, true), "entity qy"),
          z: requireFinite(payload.getFloat32(base + 28, true), "entity qz"),
          w: requireFinite(payload.getFloat32(base + 32, true), "entity qw"),
        };
        const state = new Uint32Array(4);
        state[0] = payload.getUint32(base + 36, true);
        state[1] = payload.getUint32(base + 40, true);
        state[2] = payload.getUint32(base + 44, true);
        state[3] = payload.getUint32(base + 48, true);
        entities.push({
          localId,
          kind: payload.getUint16(base + 4, true),
          position,
          rotation,
          state,
        });
      }

      const destroyed: number[] = [];
      let previousDestroyed = -1;
      for (let idIndex = 0; idIndex < record.destroyedCount; idIndex += 1) {
        const id = payload.getUint32(entitiesEnd + 4 * idIndex, true);
        if (id <= previousDestroyed) {
          throw streamingError("E_STATE_ORDER", "CSTR destroyed ids are not ascending");
        }
        previousDestroyed = id;
        destroyed.push(id);
      }

      countedEntities += entities.length;
      parsedEntities.push(entities);
      parsedDestroyed.push(destroyed);
      blobCursor = destroyedEnd;
    }
    if (blobCursor !== payloadBytes) {
      throw streamingError("E_STATE_ORDER", "CSTR payload has trailing bytes");
    }
    if (countedEntities !== entityTotal) {
      throw streamingError("E_STATE_ORDER", "CSTR entityCount does not match the records");
    }

    // Atomic replace: nothing above touches the live store.
    const next = new Map<CellKey, MutableCellRecord>();
    for (let index = 0; index < raw.length; index += 1) {
      const record = raw[index];
      const flagsSet = flagSets[index];
      const entities = parsedEntities[index];
      const destroyed = parsedDestroyed[index];
      if (record === undefined || flagsSet === undefined || entities === undefined || destroyed === undefined) {
        throw streamingError("E_STATE_ORDER", "CSTR record table mismatch");
      }
      const key = formatCellKey(record.cx, record.cy);
      next.set(key, {
        key,
        rngCursor: record.rngCursor,
        flags: flagsSet,
        entities,
        destroyed,
      });
    }
    this.records.clear();
    for (const [key, record] of next) {
      this.records.set(key, record);
    }
    this.dirtyKeys.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.records.clear();
    this.dirtyKeys.clear();
  }

  private snapshotsFor(keys: readonly CellKey[]): CellSnapshot[] {
    const seen = new Set<CellKey>();
    for (const key of keys) {
      this.requireKey(key);
      if (seen.has(key)) {
        throw streamingError("E_STATE_ORDER", `cell ${key} appears twice in serialize(keys)`);
      }
      seen.add(key);
    }
    const sorted = sortCellKeys([...seen]);
    const snapshots: CellSnapshot[] = [];
    for (const key of sorted) {
      const coord = this.requireKey(key);
      const record = this.records.get(key);
      if (record === undefined) {
        snapshots.push({
          key,
          cx: coord.cx,
          cy: coord.cy,
          rngCursor: 0,
          flags: new Uint32Array(CSTR_MAX_FLAGS),
          entities: [],
          destroyed: [],
        });
        continue;
      }
      snapshots.push({
        key,
        cx: coord.cx,
        cy: coord.cy,
        rngCursor: record.rngCursor,
        flags: record.flags,
        entities: sortEntities(record.entities),
        destroyed: sortDestroyed(record.destroyed),
      });
    }
    return snapshots;
  }

  private recordFor(key: CellKey): MutableCellRecord {
    const existing = this.records.get(key);
    if (existing !== undefined) return existing;
    const record: MutableCellRecord = {
      key,
      rngCursor: 0,
      flags: new Uint32Array(CSTR_MAX_FLAGS),
      entities: [],
      destroyed: [],
    };
    this.records.set(key, record);
    return record;
  }

  private requireKey(key: CellKey): { cx: number; cy: number } {
    const coord = tryParseCellKey(key);
    if (coord === undefined) {
      throw streamingError("E_STATE_BOUNDS", `not a canonical cell key: ${String(key)}`);
    }
    if (!this.grid.contains(coord.cx, coord.cy)) {
      throw streamingError("E_STATE_BOUNDS", `cell ${key} is outside the grid`);
    }
    return coord;
  }

  private assertLive(): void {
    if (this.disposed) {
      throw streamingError("E_STREAM_DISPOSED", "state store has been disposed");
    }
  }
}

function sortEntities(entities: readonly EntityStateRecord[]): EntityStateRecord[] {
  const copy = [...entities];
  for (const entity of copy) {
    requireU32(entity.localId, "entity localId");
    if (!Number.isInteger(entity.kind) || entity.kind < 0 || entity.kind > 0xffff) {
      throw streamingError("E_STATE_FORMAT", "entity kind must be a u16 integer");
    }
    requireFloat32(entity.position.x, "entity px");
    requireFloat32(entity.position.y, "entity py");
    requireFloat32(entity.position.z, "entity pz");
    requireFloat32(entity.rotation.x, "entity qx");
    requireFloat32(entity.rotation.y, "entity qy");
    requireFloat32(entity.rotation.z, "entity qz");
    requireFloat32(entity.rotation.w, "entity qw");
    if (entity.state.length !== 4) {
      throw streamingError("E_STATE_FORMAT", "entity state must hold exactly four words");
    }
  }
  copy.sort((a, b) => a.localId - b.localId);
  for (let index = 1; index < copy.length; index += 1) {
    if (copy[index - 1]?.localId === copy[index]?.localId) {
      throw streamingError("E_STATE_ORDER", `duplicate entity localId ${copy[index]?.localId ?? 0}`);
    }
  }
  return copy;
}

function sortDestroyed(destroyed: readonly number[]): number[] {
  const copy: number[] = [];
  for (const id of destroyed) {
    copy.push(requireU32(id, "destroyed id"));
  }
  copy.sort((a, b) => a - b);
  for (let index = 1; index < copy.length; index += 1) {
    if (copy[index - 1] === copy[index]) {
      throw streamingError("E_STATE_ORDER", `duplicate destroyed id ${copy[index] ?? 0}`);
    }
  }
  return copy;
}

function requireU32(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw streamingError("E_STATE_FORMAT", `${what} must be a u32 integer`);
  }
  return value;
}

function requireFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw streamingError("E_STATE_FORMAT", `${what} must be finite`);
  }
  return value;
}

function requireFloat32(value: number, what: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > FLOAT32_MAX) {
    throw streamingError("E_STATE_FORMAT", `${what} must be representable as a finite f32`);
  }
  return value;
}

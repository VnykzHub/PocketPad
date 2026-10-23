/**
 * World-state store and CSTR codec (spec 12 §3.4/§4.4/§5.6, ER-12-09).
 *
 * The golden hashes come from the checked-in `golden/state-hash.json` and the
 * deterministic writer below; they are compared, never rewritten here.
 * Corrupted-buffer cases recompute the payload hash so the deeper structural
 * checks are actually reached instead of stopping at `E_STATE_HASH`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CellKey, EntityStateRecord, WorldConfig } from "../../src/index.js";
import {
  CELL_STATE_FORMAT_VERSION,
  CSTR_CELL_RECORD_BYTES,
  CSTR_ENTITY_RECORD_BYTES,
  CSTR_HEADER_BYTES,
  CSTR_MAGIC,
  CSTR_SPARSE_FLAG,
  WorldStateStore,
  parseWorldManifest,
} from "../../src/index.js";
import { fnv1a32 } from "@lanpad/engine-core";
import { TEST_MANIFEST_URL, createTestWorld, expectCode } from "../support/world-fixture.js";

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));
}

const SMALL: WorldConfig = createTestWorld({ size: 3 }).config;

function smallStore(): WorldStateStore {
  return new WorldStateStore(SMALL);
}

function entity(localId: number, overrides: Partial<EntityStateRecord> = {}): EntityStateRecord {
  return {
    localId,
    kind: 3,
    position: { x: 1.5, y: 0.25, z: 2.5 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    state: new Uint32Array([localId, 1, 2, 3]),
    ...overrides,
  };
}

/** Writes every cell with a deterministic rng cursor. */
function writeAll(store: WorldStateStore): CellKey[] {
  const keys = store.allKeys();
  keys.forEach((key, index) => {
    store.setRngCursor(key, index);
  });
  return keys;
}

function denseSmall(): { store: WorldStateStore; keys: CellKey[]; bytes: ArrayBuffer } {
  const store = smallStore();
  const keys = writeAll(store);
  return { store, keys, bytes: store.serialize(keys) };
}

function fixHash(buffer: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buffer);
  view.setUint32(24, fnv1a32(new Uint8Array(buffer, CSTR_HEADER_BYTES)), true);
  return buffer;
}

function corrupt(base: ArrayBuffer, mutate: (view: DataView) => void): ArrayBuffer {
  const copy = base.slice(0);
  mutate(new DataView(copy));
  return fixHash(copy);
}

function recordBase(index: number): number {
  return CSTR_HEADER_BYTES + index * CSTR_CELL_RECORD_BYTES;
}

describe("ER-12-09 golden state", () => {
  it("[ER-12-09] reproduces the checked-in dense and sparse hashes", () => {
    const golden = readJson("../fixtures/golden/state-hash.json") as {
      formatVersion: number;
      seed: number;
      cells: number;
      sparseHash: number;
      denseHash: number;
      recipe: { manifest: string };
    };
    expect(golden.formatVersion).toBe(1);
    expect(golden.seed).toBe(0x5eed1234);
    expect(golden.cells).toBe(4096);

    const manifestText = readFileSync(
      fileURLToPath(new URL("../fixtures/world-64x64.world.json", import.meta.url)),
      "utf8",
    );
    const config = parseWorldManifest(manifestText, TEST_MANIFEST_URL);
    expect(config.seed).toBe(golden.seed);
    expect(config.cells.length).toBe(golden.cells);

    const write = (store: WorldStateStore, keys: readonly CellKey[]): void => {
      keys.forEach((key, index) => {
        store.setRngCursor(key, index);
        if (index % 64 === 0) {
          const [cx = 0, cy = 0] = key.split(",").map(Number);
          store.setEntities(key, [
            {
              localId: 1,
              kind: 1,
              position: { x: cx * 64 + 1.5, y: 0.25, z: cy * 64 + 2.5 },
              rotation: { x: 0, y: 0, z: 0, w: 1 },
              state: new Uint32Array([index, 1, 2, 3]),
            },
          ]);
          store.setDestroyed(key, [7, 9]);
        }
      });
    };

    const allKeys = new WorldStateStore(config).allKeys();
    expect(allKeys).toHaveLength(4096);

    const dense = new WorldStateStore(config);
    write(dense, allKeys);
    const denseBytes = dense.serialize(allKeys);
    expect(dense.stateHash()).toBe(golden.denseHash);
    expect(fnv1a32(new Uint8Array(denseBytes))).toBe(golden.denseHash);
    // A full-grid serialize is a dense payload: sparse bit clear.
    expect(new DataView(denseBytes).getUint32(28, true) & CSTR_SPARSE_FLAG).toBe(0);

    const sparseKeys = allKeys.filter((_, index) => index % 17 === 0);
    const sparse = new WorldStateStore(config);
    write(sparse, sparseKeys);
    const sparseBytes = sparse.serialize(sparseKeys);
    expect(sparse.stateHash(sparseKeys)).toBe(golden.sparseHash);
    expect(fnv1a32(new Uint8Array(sparseBytes))).toBe(golden.sparseHash);
    expect(new DataView(sparseBytes).getUint32(28, true) & CSTR_SPARSE_FLAG).toBe(1);

    // The two formats never hash alike.
    expect(golden.sparseHash).not.toBe(golden.denseHash);
  });

  it("[ER-12-09] is byte-identical across serialize → restore → serialize", () => {
    const first = smallStore();
    const keys = first.allKeys();
    keys.forEach((key, index) => {
      first.setRngCursor(key, index * 3);
      first.setDestroyed(key, [index + 2, index + 1]);
    });
    first.setEntities("1,1" as CellKey, [entity(5), entity(2)]);
    const original = first.serialize(keys);

    const second = smallStore();
    second.restore(original);
    const again = second.serialize(keys);
    expect(new Uint8Array(again)).toEqual(new Uint8Array(original));

    // Field-level round trip for the cell that holds entities.
    const restored = second.get("1,1" as CellKey);
    expect(restored.rngCursor).toBe(4 * 3);
    expect(restored.entities.map((record) => record.localId)).toEqual([2, 5]);
    expect(restored.entities[1]?.position.x).toBe(1.5);
    expect(restored.entities[1]?.state[3]).toBe(3);
    expect([...restored.destroyed]).toEqual([5, 6]);
  });

  it("[ER-12-09] sparse serialize contains only the requested cells", () => {
    const store = smallStore();
    store.setRngCursor("2,2" as CellKey, 99);
    const bytes = store.serialize(["2,2" as CellKey]);
    const view = new DataView(bytes);
    expect(view.getUint32(12, true)).toBe(1);
    expect(view.getUint32(28, true) & CSTR_SPARSE_FLAG).toBe(CSTR_SPARSE_FLAG);

    const restored = smallStore();
    restored.restore(bytes);
    expect(restored.allocatedCells).toBe(1);
    expect(restored.get("2,2" as CellKey).rngCursor).toBe(99);
  });
});

describe("store writes", () => {
  it("[ER-12-09] tracks dirty cells in canonical order", () => {
    const store = smallStore();
    store.markDirty("2,0" as CellKey);
    store.markDirty("0,2" as CellKey);
    store.markDirty("2,0" as CellKey);
    expect(store.dirty).toEqual(["0,2", "2,0"]);
    store.clearDirty();
    expect(store.dirty).toEqual([]);
  });

  it("[ER-12-09] allocates a record on first read and validates keys", async () => {
    const store = smallStore();
    expect(store.allocatedCells).toBe(0);
    const record = store.get("0,0" as CellKey);
    expect(store.allocatedCells).toBe(1);
    expect(record.rngCursor).toBe(0);
    expect(record.flags).toHaveLength(16);
    await expectCode(() => store.get("3,0" as CellKey), "E_STATE_BOUNDS");
    await expectCode(() => store.get("+0,0" as CellKey), "E_STATE_BOUNDS");
  });

  it("[ER-12-09] validates rng cursors and advances with u32 wraparound", async () => {
    const store = smallStore();
    store.setRngCursor("0,0" as CellKey, 0xffff_fffe);
    expect(store.advanceRng("0,0" as CellKey, 3)).toBe(1);
    expect(store.advanceRng("0,0" as CellKey)).toBe(2);
    await expectCode(() => store.setRngCursor("0,0" as CellKey, -1), "E_STATE_FORMAT");
    await expectCode(() => store.setRngCursor("0,0" as CellKey, 1.5), "E_STATE_FORMAT");
    await expectCode(() => store.advanceRng("0,0" as CellKey, -1), "E_STATE_FORMAT");
  });

  it("[ER-12-09] sorts entity and destroyed lists and rejects invalid records", async () => {
    const store = smallStore();
    store.setEntities("0,0" as CellKey, [entity(9), entity(4)]);
    expect(store.get("0,0" as CellKey).entities.map((record) => record.localId)).toEqual([4, 9]);
    store.setDestroyed("0,0" as CellKey, [8, 3, 5]);
    expect([...store.get("0,0" as CellKey).destroyed]).toEqual([3, 5, 8]);

    await expectCode(
      () => store.setEntities("0,0" as CellKey, [entity(1), entity(1)]),
      "E_STATE_ORDER",
    );
    await expectCode(
      () => store.setEntities("0,0" as CellKey, [entity(-1)]),
      "E_STATE_FORMAT",
    );
    await expectCode(
      () => store.setEntities("0,0" as CellKey, [entity(1, { kind: 70000 })]),
      "E_STATE_FORMAT",
    );
    await expectCode(
      () => store.setEntities("0,0" as CellKey, [entity(1, { state: new Uint32Array(3) })]),
      "E_STATE_FORMAT",
    );
    await expectCode(
      () =>
        store.setEntities("0,0" as CellKey, [
          entity(1, { position: { x: Number.NaN, y: 0, z: 0 } }),
        ]),
      "E_STATE_FORMAT",
    );
    await expectCode(() => store.setDestroyed("0,0" as CellKey, [1, 1]), "E_STATE_ORDER");
    await expectCode(() => store.setDestroyed("0,0" as CellKey, [-1]), "E_STATE_FORMAT");
    await expectCode(
      () => store.serialize(["0,0" as CellKey, "0,0" as CellKey]),
      "E_STATE_ORDER",
    );
  });

  it("[ER-12-09] refuses work after dispose", async () => {
    const store = smallStore();
    store.dispose();
    await expectCode(() => store.get("0,0" as CellKey), "E_STREAM_DISPOSED");
    await expectCode(() => store.serialize(["0,0" as CellKey]), "E_STREAM_DISPOSED");
    await expectCode(() => store.restore(new ArrayBuffer(48)), "E_STREAM_DISPOSED");
    store.dispose(); // idempotent
  });
});

describe("CSTR restore validation", () => {
  const base = (): ArrayBuffer => denseSmall().bytes;

  it("[ER-12-09] rejects header magic, version, size, seed, flags and hash", async () => {
    const raw = (mutate: (view: DataView) => void): ArrayBuffer => {
      const copy = base().slice(0);
      mutate(new DataView(copy));
      return copy;
    };
    expect(CSTR_MAGIC).toBe(0x5254_5343);
    expect(CELL_STATE_FORMAT_VERSION).toBe(1);
    await expectCode(
      () => smallStore().restore(raw((view) => view.setUint32(0, 0, true))),
      "E_STATE_FORMAT",
    );
    await expectCode(
      () => smallStore().restore(raw((view) => view.setUint16(4, 2, true))),
      "E_STATE_FORMAT",
    );
    await expectCode(
      () => smallStore().restore(raw((view) => view.setUint16(6, 44, true))),
      "E_STATE_FORMAT",
    );
    await expectCode(
      () => smallStore().restore(raw((view) => view.setUint32(8, 0, true))),
      "E_STATE_WORLD",
    );
    await expectCode(
      () => smallStore().restore(raw((view) => view.setUint32(20, 0, true))),
      "E_STATE_FORMAT",
    );
    await expectCode(
      () => smallStore().restore(raw((view) => view.setUint32(28, 0x4, true))),
      "E_STATE_FORMAT",
    );
    await expectCode(
      () => smallStore().restore(raw((view) => view.setUint32(32, 1, true))),
      "E_STATE_FORMAT",
    );
    await expectCode(
      () => smallStore().restore(raw((view) => view.setUint32(24, 0, true))),
      "E_STATE_HASH",
    );
    await expectCode(() => smallStore().restore(new ArrayBuffer(10)), "E_STATE_FORMAT");
    await expectCode(
      () => smallStore().restore(new Uint8Array(100) as unknown as ArrayBuffer),
      "E_STATE_FORMAT",
    );
  });

  it("[ER-12-09] rejects cell counts that contradict the grid or the payload", async () => {
    await expectCode(
      () => smallStore().restore(corrupt(base(), (view) => view.setUint32(12, 10, true))),
      "E_STATE_ORDER",
    );

    const sparse = smallStore();
    sparse.setRngCursor("1,1" as CellKey, 1);
    const sparseBytes = sparse.serialize(["1,1" as CellKey]);
    // Clearing the sparse bit on a one-cell payload claims a full grid.
    await expectCode(
      () => smallStore().restore(corrupt(sparseBytes, (view) => view.setUint32(28, 0, true))),
      "E_STATE_ORDER",
    );
    // Claiming nine cells in a payload that cannot hold their table.
    await expectCode(
      () =>
        smallStore().restore(
          corrupt(sparseBytes, (view) => {
            view.setUint32(12, 9, true);
            view.setUint32(28, 0, true);
          }),
        ),
      "E_STATE_ORDER",
    );
  });

  it("[ER-12-09] rejects malformed cell records", async () => {
    await expectCode(
      () =>
        smallStore().restore(
          corrupt(base(), (view) => view.setUint16(recordBase(0) + 18, 1, true)),
        ),
      "E_STATE_FORMAT",
    );
    await expectCode(
      () =>
        smallStore().restore(
          corrupt(base(), (view) => view.setUint16(recordBase(0) + 12, 17, true)),
        ),
      "E_STATE_ORDER",
    );
    await expectCode(
      () => smallStore().restore(corrupt(base(), (view) => view.setInt32(recordBase(0), 5, true))),
      "E_STATE_BOUNDS",
    );
    await expectCode(
      () =>
        smallStore().restore(
          corrupt(base(), (view) => {
            view.setInt32(recordBase(1), 0, true);
            view.setInt32(recordBase(1) + 4, 0, true);
          }),
        ),
      "E_STATE_ORDER",
    );
  });

  it("[ER-12-09] requires canonical entity and destroyed offsets", async () => {
    // A dense 3x3 payload with no entity data: the canonical offset follows
    // the table and the flag words.
    await expectCode(
      () =>
        smallStore().restore(
          corrupt(base(), (view) => {
            const offset = view.getUint32(recordBase(0) + 20, true);
            view.setUint32(recordBase(0) + 20, offset + 4, true);
          }),
        ),
      "E_STATE_ORDER",
    );
    await expectCode(
      () =>
        smallStore().restore(
          corrupt(base(), (view) => {
            const offset = view.getUint32(recordBase(0) + 24, true);
            view.setUint32(recordBase(0) + 24, offset + 4, true);
          }),
        ),
      "E_STATE_ORDER",
    );
    // Append four bytes beyond the last record: trailing payload.
    const trailing = new ArrayBuffer(base().byteLength + 4);
    new Uint8Array(trailing).set(new Uint8Array(base()));
    const view = new DataView(trailing);
    view.setUint32(20, view.getUint32(20, true) + 4, true);
    fixHash(trailing);
    await expectCode(() => smallStore().restore(trailing), "E_STATE_ORDER");
  });

  it("[ER-12-09] rejects entity order, duplicate ids and non-finite floats", async () => {
    const store = smallStore();
    const keys = writeAll(store);
    store.setEntities("0,0" as CellKey, [entity(2), entity(5)]);
    const bytes = store.serialize(keys);
    const entityOffset = new DataView(bytes).getUint32(recordBase(0) + 20, true);
    expect(entityOffset).toBeGreaterThan(0);
    expect(CSTR_ENTITY_RECORD_BYTES).toBe(52);

    // Offsets in a cell record are payload-relative; the payload starts after
    // the 48-byte header.
    const secondEntity = CSTR_HEADER_BYTES + entityOffset + CSTR_ENTITY_RECORD_BYTES;
    await expectCode(
      () =>
        smallStore().restore(
          corrupt(bytes, (view) => view.setUint32(secondEntity, 1, true)),
        ),
      "E_STATE_ORDER",
    );
    await expectCode(
      () =>
        smallStore().restore(
          corrupt(bytes, (view) => view.setUint32(secondEntity, 2, true)),
        ),
      "E_STATE_ORDER",
    );
    await expectCode(
      () =>
        smallStore().restore(
          corrupt(bytes, (view) =>
            view.setFloat32(CSTR_HEADER_BYTES + entityOffset + 8, Number.NaN, true),
          ),
        ),
      "E_STATE_FORMAT",
    );
    // entityTotal disagrees with the record list.
    await expectCode(
      () => smallStore().restore(corrupt(bytes, (view) => view.setUint32(16, 3, true))),
      "E_STATE_ORDER",
    );
  });

  it("[ER-12-09] rejects descending destroyed ids", async () => {
    const store = smallStore();
    const keys = writeAll(store);
    store.setDestroyed("0,0" as CellKey, [3, 5]);
    const bytes = store.serialize(keys);
    const destroyedOffset = new DataView(bytes).getUint32(recordBase(0) + 24, true);
    await expectCode(
      () =>
        smallStore().restore(
          corrupt(bytes, (view) =>
            view.setUint32(CSTR_HEADER_BYTES + destroyedOffset + 4, 1, true),
          ),
        ),
      "E_STATE_ORDER",
    );
  });

  it("[ER-12-09] a failed restore leaves the live store untouched", async () => {
    const store = smallStore();
    store.setRngCursor("0,0" as CellKey, 42);
    store.markDirty("0,0" as CellKey);
    const before = store.serialize(store.allKeys());
    const bad = corrupt(base(), (view) => view.setUint32(recordBase(0) + 18, 1, true));
    await expectCode(() => store.restore(bad), "E_STATE_FORMAT");
    expect(store.get("0,0" as CellKey).rngCursor).toBe(42);
    expect(store.dirty).toEqual(["0,0"]);
    const after = store.serialize(store.allKeys());
    expect(new Uint8Array(after)).toEqual(new Uint8Array(before));
  });
});

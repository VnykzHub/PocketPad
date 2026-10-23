/**
 * `.cell` container validation and section decoding (spec 12 §4.2/§5.4,
 * ER-12-08).
 *
 * Every case builds a valid container with `buildCellBytes`, mutates one
 * field, and asserts the exact named code. The fuzz case is a deterministic
 * truncation sweep over the header region, not random data — the corpus is
 * reproducible and no network or real filesystem is involved.
 */

import { describe, expect, it } from "vitest";
import type { CellKey, DecodedSection, DecodeCellContext } from "../../src/index.js";
import {
  CELL_CONTAINER_MAGIC,
  CELL_FLAG_HAS_COLLISION,
  CELL_FLAG_HAS_NAV,
  CELL_HEADER_BYTES,
  CELL_SECTION_ENTRY_BYTES,
  SECTION_TYPE_COLLISION,
  SECTION_TYPE_MESH,
  SECTION_TYPE_NAVMESH,
  SECTION_TYPE_TEXTURE,
  STREAMING_LIMITS,
  compositeContentHash,
  decodeCell,
} from "../../src/index.js";
import { buildCellBytes, expectCode, gunzipBytes } from "../support/world-fixture.js";

function visual(lod: 0 | 1 | 2 | 3 = 0): Uint8Array {
  return buildCellBytes({ cx: 2, cy: 1, kind: 0, lod });
}

function sim(): Uint8Array {
  return buildCellBytes({ cx: 2, cy: 1, kind: 1 });
}

function context(overrides: Partial<DecodeCellContext> = {}): DecodeCellContext {
  return {
    cellSizeMeters: 64,
    expectedCx: 2,
    expectedCy: 1,
    bounds: { minX: 128, maxX: 192, minZ: 64, maxZ: 128 },
    decodeGzip: gunzipBytes,
    ...overrides,
  };
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function mutate(bytes: Uint8Array, offset: number, write: (view: DataView) => void): ArrayBuffer {
  const copy = bytes.slice();
  write(new DataView(copy.buffer));
  expect(copy.byteOffset).toBe(0);
  return copy.buffer;
}

describe("valid containers", () => {
  it("[ER-12-08] decodes a visual cell header and its sections", async () => {
    const decoded = await decodeCell(bufferOf(visual()), context());
    expect(decoded.header.cx).toBe(2);
    expect(decoded.header.cy).toBe(1);
    expect(decoded.header.kind).toBe(0);
    expect(decoded.header.lod).toBe(0);
    expect(decoded.header.cellSizeCm).toBe(6400);
    expect(decoded.header.sectionCount).toBe(2);
    expect(decoded.header.uncompressedBytes).toBe(48);
    expect(decoded.header.aabb).toEqual({
      minX: 128,
      minY: 0,
      minZ: 64,
      maxX: 192,
      maxY: 8,
      maxZ: 128,
    });
    expect(decoded.sections.map((section) => section.type)).toEqual([
      SECTION_TYPE_MESH,
      SECTION_TYPE_TEXTURE,
    ]);
    expect(decoded.sections[0]?.bytes).toHaveLength(32);
    expect(decoded.sections[1]?.bytes).toHaveLength(16);
  });

  it("[ER-12-08] decodes simulation sections and cross-checks manifest flags", async () => {
    const decoded = await decodeCell(
      bufferOf(sim()),
      context({ expectedHasCollision: true, expectedHasNav: true }),
    );
    expect(decoded.header.kind).toBe(1);
    expect(decoded.header.lod).toBe(0xff);
    expect(decoded.header.flags & CELL_FLAG_HAS_COLLISION).toBe(CELL_FLAG_HAS_COLLISION);
    expect(decoded.header.flags & CELL_FLAG_HAS_NAV).toBe(CELL_FLAG_HAS_NAV);
    expect(decoded.sections.map((section) => section.type)).toEqual([
      SECTION_TYPE_COLLISION,
      SECTION_TYPE_NAVMESH,
    ]);
  });

  it("[ER-12-08] inflates gzip sections through the injected decoder", async () => {
    const bytes = buildCellBytes({ cx: 2, cy: 1, kind: 0, lod: 2, gzipSections: true });
    const decoded = await decodeCell(bufferOf(bytes), context());
    expect(decoded.sections).toHaveLength(2);
    expect(decoded.sections[0]?.bytes).toHaveLength(32);
    expect((decoded.sections[0]?.flags ?? 0) & 0x1).toBe(0x1);
    expect(decoded.sections[0]?.bytes[0]).toBe((SECTION_TYPE_MESH * 31 + 2 * 3 + 1 * 5) & 0xff);
  });

  it("[ER-12-08] dispatches owner handlers in table order after validation", async () => {
    const seen: DecodedSection[] = [];
    const decoded = await decodeCell(
      bufferOf(visual(3)),
      context({
        onSection: (section) => {
          seen.push(section);
        },
      }),
    );
    expect(seen).toEqual(decoded.sections);
    expect(seen.map((section) => section.type)).toEqual([
      SECTION_TYPE_MESH,
      SECTION_TYPE_TEXTURE,
    ]);

    await expectCode(
      () =>
        decodeCell(
          bufferOf(visual()),
          context({
            onSection: () => {
              throw new Error("handler rejected");
            },
          }),
        ),
      "E_CELL_SECTION",
    );
    await expectCode(
      () =>
        decodeCell(
          bufferOf(visual()),
          context({
            onSection: async () => {
              await Promise.resolve();
              throw new Error("async rejection");
            },
          }),
        ),
      "E_CELL_SECTION",
    );
  });
});

describe("header validation", () => {
  it("[ER-12-08] rejects magic, short files, versions and header sizes", async () => {
    await expectCode(() => decodeCell(new ArrayBuffer(10), context()), "E_CELL_FORMAT");
    await expectCode(
      () => decodeCell(mutate(visual(), 0, (view) => view.setUint32(0, 0, true)), context()),
      "E_CELL_FORMAT",
    );
    // A wrong magic is reported before any section work.
    expect(CELL_CONTAINER_MAGIC).toBe(0x4c43_5050);
    await expectCode(
      () => decodeCell(mutate(visual(), 4, (view) => view.setUint16(4, 2, true)), context()),
      "E_CELL_FORMAT",
    );
    await expectCode(
      () => decodeCell(mutate(visual(), 6, (view) => view.setUint16(6, 48, true)), context()),
      "E_CELL_FORMAT",
    );
  });

  it("[ER-12-08] rejects files over the compressed byte cap before reading them", async () => {
    const over = new ArrayBuffer(STREAMING_LIMITS.maxCellCompressedBytes + 1);
    await expectCode(() => decodeCell(over, context()), "E_CELL_SIZE");
  });

  it("[ER-12-08] rejects coordinates and cell size that disagree with the world", async () => {
    await expectCode(
      () => decodeCell(mutate(visual(), 12, (view) => view.setInt32(12, 3, true)), context()),
      "E_CELL_FORMAT",
    );
    await expectCode(
      () => decodeCell(mutate(visual(), 16, (view) => view.setInt32(16, 0, true)), context()),
      "E_CELL_FORMAT",
    );
    await expectCode(
      () => decodeCell(mutate(visual(), 20, (view) => view.setUint16(20, 3200, true)), context()),
      "E_CELL_FORMAT",
    );
    await expectCode(
      () => decodeCell(mutate(visual(), 20, (view) => view.setUint16(20, 1000, true)), context()),
      "E_CELL_FORMAT",
    );
  });

  it("[ER-12-08] rejects illegal kind and LOD bytes", async () => {
    await expectCode(
      () => decodeCell(mutate(visual(), 22, (view) => view.setUint8(22, 2)), context()),
      "E_CELL_KIND",
    );
    await expectCode(
      () => decodeCell(mutate(visual(), 23, (view) => view.setUint8(23, 4)), context()),
      "E_CELL_KIND",
    );
    // A simulation payload must carry 0xFF.
    await expectCode(
      () => decodeCell(mutate(sim(), 23, (view) => view.setUint8(23, 0)), context()),
      "E_CELL_KIND",
    );
  });

  it("[ER-12-08] rejects unknown flags, reserved words and a bad AABB", async () => {
    await expectCode(
      () => decodeCell(mutate(visual(), 56, (view) => view.setUint32(56, 0x80, true)), context()),
      "E_CELL_FORMAT",
    );
    await expectCode(
      () => decodeCell(mutate(visual(), 60, (view) => view.setUint32(60, 1, true)), context()),
      "E_CELL_FORMAT",
    );
    await expectCode(
      () => decodeCell(mutate(visual(), 32, (view) => view.setFloat32(32, 100, true)), context()),
      "E_CELL_FORMAT",
    );
    await expectCode(
      () => decodeCell(mutate(visual(), 32, (view) => view.setFloat32(32, 250, true)), context()),
      "E_CELL_FORMAT",
    );
    // NaN AABB is rejected as non-finite before the bounds comparison.
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), 40, (view) => view.setFloat32(40, Number.NaN, true)),
          context(),
        ),
      "E_CELL_FORMAT",
    );
  });

  it("[ER-12-08] rejects a manifest/container collision or nav disagreement", async () => {
    await expectCode(
      () => decodeCell(bufferOf(sim()), context({ expectedHasCollision: false })),
      "E_CELL_KIND",
    );
    await expectCode(
      () => decodeCell(bufferOf(sim()), context({ expectedHasNav: false })),
      "E_CELL_KIND",
    );
  });

  it("[ER-12-08] enforces the per-LOD uncompressed byte limits", async () => {
    // LOD3's limit is 32 KiB; declare one byte more than the real section sum.
    const bytes = buildCellBytes({ cx: 2, cy: 1, kind: 0, lod: 3 });
    await expectCode(
      () =>
        decodeCell(
          mutate(bytes, 24, (view) => view.setUint32(24, 32 * 1024 + 1, true)),
          context(),
        ),
      "E_CELL_SIZE",
    );
  });
});

describe("section table validation", () => {
  it("[ER-12-08] rejects a table that runs past the file", async () => {
    await expectCode(
      () => decodeCell(mutate(visual(), 28, (view) => view.setUint32(28, 64, true)), context()),
      "E_CELL_SECTION",
    );
  });

  it("[ER-12-08] rejects illegal section type, flags and reserved words", async () => {
    const base = CELL_HEADER_BYTES;
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), base, (view) => view.setUint16(base, 0, true)),
          context(),
        ),
      "E_CELL_SECTION",
    );
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), base, (view) => view.setUint16(base, 40000, true)),
          context(),
        ),
      "E_CELL_SECTION",
    );
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), base + 2, (view) => view.setUint16(base + 2, 0x2, true)),
          context(),
        ),
      "E_CELL_SECTION",
    );
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), base + 18, (view) => view.setUint16(base + 18, 1, true)),
          context(),
        ),
      "E_CELL_SECTION",
    );
  });

  it("[ER-12-08] rejects offsets that are unaligned, before the table or out of file", async () => {
    const base = CELL_HEADER_BYTES;
    const entry = CELL_SECTION_ENTRY_BYTES;
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), base + 4, (view) => view.setUint32(base + 4, 89, true)),
          context(),
        ),
      "E_CELL_SECTION",
    );
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), base + 4, (view) => view.setUint32(base + 4, 64, true)),
          context(),
        ),
      "E_CELL_SECTION",
    );
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), base + entry + 4, (view) =>
            view.setUint32(base + entry + 4, 4096, true),
          ),
          context(),
        ),
      "E_CELL_SECTION",
    );
  });

  it("[ER-12-08] rejects simulation sections inside visual payloads and vice versa", async () => {
    const base = CELL_HEADER_BYTES;
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), base, (view) => view.setUint16(base, SECTION_TYPE_COLLISION, true)),
          context(),
        ),
      "E_CELL_KIND",
    );
    await expectCode(
      () =>
        decodeCell(
          mutate(sim(), base, (view) => view.setUint16(base, SECTION_TYPE_MESH, true)),
          context(),
        ),
      "E_CELL_KIND",
    );
  });

  it("[ER-12-08] rejects a section-sum mismatch, overlap and trailing sizes", async () => {
    await expectCode(
      () => decodeCell(mutate(visual(), 24, (view) => view.setUint32(24, 49, true)), context()),
      "E_CELL_FORMAT",
    );
    // Point the second section back at the first one's bytes.
    const entry = CELL_SECTION_ENTRY_BYTES;
    const firstOffset = 112;
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), CELL_HEADER_BYTES + entry + 4, (view) =>
            view.setUint32(CELL_HEADER_BYTES + entry + 4, firstOffset, true),
          ),
          context(),
        ),
      "E_CELL_SECTION",
    );
  });

  it("[ER-12-08] rejects a section whose gzip stream cannot be inflated", async () => {
    const bytes = buildCellBytes({ cx: 2, cy: 1, kind: 0, gzipSections: true });
    const firstOffset = 112;
    await expectCode(
      () =>
        decodeCell(
          mutate(bytes, firstOffset + 2, (view) => view.setUint8(firstOffset + 2, 0xff)),
          context(),
        ),
      "E_STREAM_DECOMPRESS",
    );
  });

  it("[ER-12-08] rejects section and file hash mismatches", async () => {
    const base = CELL_HEADER_BYTES;
    await expectCode(
      () =>
        decodeCell(
          mutate(visual(), base + 20, (view) => view.setUint32(base + 20, 0, true)),
          context(),
        ),
      "E_CELL_HASH",
    );
    await expectCode(
      () => decodeCell(mutate(visual(), 8, (view) => view.setUint32(8, 0, true)), context()),
      "E_CELL_HASH",
    );
  });
});

describe("header fuzz corpus", () => {
  it("[ER-12-08] every truncated header fails with a named code, never a crash", async () => {
    const bytes = visual();
    for (let length = 0; length < CELL_HEADER_BYTES; length += 4) {
      const truncated = bytes.slice(0, length).buffer;
      let caught: unknown;
      try {
        await decodeCell(truncated, context());
      } catch (error) {
        caught = error;
      }
      expect(caught, `truncation to ${length} bytes`).toBeDefined();
      expect(
        typeof (caught as { code?: unknown }).code === "string",
        `truncation to ${length} bytes has a code`,
      ).toBe(true);
    }
  });

  it("[ER-12-08] a one-byte flip in any header word is either accepted or named", async () => {
    const clean = visual();
    // Header words 0..15: magic, version, hashes, coordinates, sizes, AABB, flags.
    for (let word = 0; word < CELL_HEADER_BYTES; word += 4) {
      const mutated = clean.slice();
      mutated[word] = (mutated[word] ?? 0) ^ 0xff;
      let outcome: "accept" | string = "accept";
      try {
        await decodeCell(mutated.buffer, context());
      } catch (error) {
        outcome = (error as { code?: string }).code ?? "no-code";
      }
      expect(outcome, `word at ${word}`).not.toBe("no-code");
    }
  });
});

describe("composite content hash", () => {
  it("[ER-12-08] hashes the key and five component hashes deterministically", async () => {
    const first = compositeContentHash("2,1" as CellKey, [1, 2, 3, 0], 4);
    expect(first).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(compositeContentHash("2,1" as CellKey, [1, 2, 3, 0], 4)).toBe(first);
    expect(compositeContentHash("2,2" as CellKey, [1, 2, 3, 0], 4)).not.toBe(first);
    expect(compositeContentHash("2,1" as CellKey, [1, 2, 3, 1], 4)).not.toBe(first);
    expect(compositeContentHash("2,1" as CellKey, [1, 2, 3, 0], 5)).not.toBe(first);
    await expectCode(
      () => compositeContentHash("2,1" as CellKey, [1, 2, 3, 4.5], 4),
      "E_CELL_HASH",
    );
    await expectCode(
      () => compositeContentHash("2,1" as CellKey, [1, 2, 3, 0], -1),
      "E_CELL_HASH",
    );
  });
});

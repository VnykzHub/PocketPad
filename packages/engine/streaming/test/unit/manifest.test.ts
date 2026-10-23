/**
 * `world.json` parsing, URL rules, index lookups and boot budget
 * (spec 12 §4.1/§5.1/§5.8, ER-12-01/12).
 *
 * The 4,096-cell manifest and the invalid manifests are checked-in goldens
 * produced by `test/fixtures/build-world.mjs`; this test reads them and never
 * regenerates them. Timing thresholds stay PENDING (ER-12-01's ≤ 100 ms p95 is
 * a CI-run measurement, not something a unit test may invent).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { CellIndexEntry } from "../../src/index.js";
import {
  MAX_BOOT_SET_GZIP_BYTES,
  MAX_MANIFEST_GZIP_BYTES,
  WORLD_FORMAT_VERSION,
  WorldIndex,
  assertBootBudget,
  checkBootBudget,
  parseWorldManifest,
  resolveCellUrl,
  validateRelativeCellUrl,
  validateWorldConfig,
} from "../../src/index.js";
import { TEST_MANIFEST_URL, expectCode } from "../support/world-fixture.js";

function readText(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function readBytes(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(relative, import.meta.url))));
}

const MANIFEST_TEXT = readText("../fixtures/world-64x64.world.json");

/** Minimal valid one-cell manifest; overrides land on the cell entry. */
function oneCellManifest(cellOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    worldId: "manifest-test",
    seed: 0x5eed1234,
    cellSizeMeters: 64,
    origin: { x: 0, y: 0, z: 0 },
    grid: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    lodBands: [
      { lod: 0, maxDistanceMeters: 96, hysteresisMeters: 8 },
      { lod: 1, maxDistanceMeters: 160, hysteresisMeters: 12 },
      { lod: 2, maxDistanceMeters: 256, hysteresisMeters: 16 },
      { lod: 3, maxDistanceMeters: 384, hysteresisMeters: 24 },
    ],
    budgets: {
      residentBytes: 1024,
      textureBytes: 256,
      geometryBytes: 256,
      cpuBytes: 256,
      maxResidentCells: 16,
      maxConcurrentLoads: 4,
      maxLoadsStartedPerTick: 1,
      decisionIntervalTicks: 6,
      streamerTickMs: 2,
      maxTaskMs: 8,
      cacheBytes: 1024,
      cacheEnabled: true,
    },
    cells: [
      {
        key: "0,0",
        cx: 0,
        cy: 0,
        visualUrls: ["0_0_l0.cell", "0_0_l1.cell", "0_0_l2.cell", "0_0_l3.cell"],
        simUrl: "0_0_sim.cell",
        visualBytes: [512, 384, 256, 128],
        simBytes: 64,
        contentHash: "fnv1a32:00000000",
        hasCollision: true,
        hasNav: false,
        ...cellOverrides,
      },
    ],
  };
}

describe("64x64 golden manifest", () => {
  it("[ER-12-01] parses the checked-in 4,096-cell manifest into canonical order", () => {
    const config = parseWorldManifest(MANIFEST_TEXT, TEST_MANIFEST_URL);
    expect(config.formatVersion).toBe(WORLD_FORMAT_VERSION);
    expect(config.worldId).toBe("fixture-city-64");
    expect(config.seed).toBe(0x5eed1234);
    expect(config.cellSizeMeters).toBe(64);
    expect(config.grid).toEqual({ minX: 0, minY: 0, maxX: 63, maxY: 63 });
    expect(config.lodBands).toHaveLength(4);
    expect(config.budgets.maxResidentCells).toBe(256);
    expect(config.cells).toHaveLength(4096);
    expect(config.cells[0]?.key).toBe("0,0");
    expect(config.cells.at(-1)?.key).toBe("63,63");

    // Canonical order is ascending (cx, cy) — cell-major, not row-major.
    let previous = { cx: -1, cy: -1 };
    for (const entry of config.cells) {
      const ordered =
        entry.cx > previous.cx || (entry.cx === previous.cx && entry.cy > previous.cy);
      expect(ordered, `${entry.key} after ${previous.cx},${previous.cy}`).toBe(true);
      previous = { cx: entry.cx, cy: entry.cy };
    }
  });

  it("[ER-12-01] builds O(1) index lookups by key and grid index", () => {
    const config = parseWorldManifest(MANIFEST_TEXT, TEST_MANIFEST_URL);
    const index = new WorldIndex(config, TEST_MANIFEST_URL);
    expect(index.cellCount).toBe(4096);
    expect(index.grid.cellCount).toBe(4096);
    expect(index.has("12,34")).toBe(true);
    expect(index.has("64,0")).toBe(false);
    expect(index.entry("12,34")?.cx).toBe(12);
    expect(index.entryAt(12, 34)?.key).toBe("12,34");
    expect(index.entryAt(64, 0)).toBeUndefined();
    expect(index.keyAt(34 * 64 + 12)).toBe("12,34");
    expect(index.entryByGridIndex(-1)).toBeUndefined();
    expect(index.entryByGridIndex(4096)).toBeUndefined();

    const payload = index.visualPayload("12,34", 0);
    expect(payload).toEqual({
      lod: 0,
      url: "http://localhost/worlds/test/cells/12_34_l0.cell",
      bytes: 512,
    });
    expect(index.simPayload("12,34")).toEqual({
      url: "http://localhost/worlds/test/cells/12_34_sim.cell",
      bytes: 256,
    });
    expect(index.visualPayload("64,0", 0)).toBeUndefined();
    expect(index.simPayload("64,0")).toBeUndefined();
  });

  it("[ER-12-12] the checked-in manifest is within the 512 KiB gzip budget", () => {
    // Measured from the checked-in bytes; the browser boot row stays PENDING.
    const gzipBytes = gzipSync(readBytes("../fixtures/world-64x64.world.json")).byteLength;
    expect(gzipBytes).toBeLessThanOrEqual(MAX_MANIFEST_GZIP_BYTES);
    expect(gzipBytes).toBeGreaterThan(0);
    expect(MAX_MANIFEST_GZIP_BYTES).toBe(512 * 1024);
  });
});

describe("manifest rejection", () => {
  const invalid = [
    ["bad-key-plus.world.json", "E_WORLD_KEY"],
    ["bad-key-leading-zero.world.json", "E_WORLD_KEY"],
    ["bad-key-negative-zero.world.json", "E_WORLD_KEY"],
    ["duplicate.world.json", "E_WORLD_DUPLICATE"],
    ["hole.world.json", "E_WORLD_HOLE"],
    ["url-dotdot.world.json", "E_WORLD_URL"],
    ["url-scheme.world.json", "E_WORLD_URL"],
    ["missing-lod3.world.json", "E_WORLD_LOD3"],
    ["grid-too-large.world.json", "E_WORLD_GRID"],
  ] as const;

  for (const [name, code] of invalid) {
    it(`[ER-12-01] rejects ${name} with ${code}`, async () => {
      const text = readText(`../fixtures/invalid/${name}`);
      await expectCode(() => parseWorldManifest(text, TEST_MANIFEST_URL), code);
    });
  }

  it("[ER-12-01] rejects malformed JSON and unknown format versions", async () => {
    await expectCode(() => parseWorldManifest("{", TEST_MANIFEST_URL), "E_WORLD_FORMAT");
    await expectCode(
      () => parseWorldManifest(JSON.stringify({ formatVersion: 2 }), TEST_MANIFEST_URL),
      "E_WORLD_FORMAT",
    );
  });

  it("[ER-12-01] rejects a missing LOD author, bad byte counts and a bad hash", async () => {
    const noLod3 = oneCellManifest({ visualUrls: ["a", "b", "c", ""], visualBytes: [1, 1, 1, 0] });
    await expectCode(() => validateWorldConfig(noLod3, TEST_MANIFEST_URL), "E_WORLD_LOD3");
    // LOD3's bake limit is 32 KiB; LOD0's is 1.5 MiB.
    const oversized = oneCellManifest({ visualBytes: [1, 1, 1, 32 * 1024 + 1] });
    await expectCode(() => validateWorldConfig(oversized, TEST_MANIFEST_URL), "E_CELL_SIZE");
    const badHash = oneCellManifest({ contentHash: "sha256:0000" });
    await expectCode(() => validateWorldConfig(badHash, TEST_MANIFEST_URL), "E_WORLD_ENTRY");
    const emptySim = oneCellManifest({ simUrl: "", simBytes: 0, hasCollision: true });
    await expectCode(() => validateWorldConfig(emptySim, TEST_MANIFEST_URL), "E_WORLD_ENTRY");
  });
});

describe("cell URLs", () => {
  it("[ER-12-01] accepts relative same-directory URLs only", () => {
    expect(validateRelativeCellUrl("cells/0_0_l0.cell")).toBeNull();
    expect(validateRelativeCellUrl("0_0_l0.cell")).toBeNull();
    expect(validateRelativeCellUrl("../cells/a.cell")).toMatch(/dot segment/);
    expect(validateRelativeCellUrl("a/./b.cell")).toMatch(/dot segment/);
    expect(validateRelativeCellUrl("https:evil.example/a.cell")).toMatch(/scheme/);
    expect(validateRelativeCellUrl("https://evil.example/a.cell")).toMatch(/double slash/);
    expect(validateRelativeCellUrl("//evil.example/a.cell")).toMatch(/double slash/);
    expect(validateRelativeCellUrl("/abs.cell")).toMatch(/absolute/);
    expect(validateRelativeCellUrl("a\\b.cell")).toMatch(/backslash/);
    expect(validateRelativeCellUrl("a?x=1")).toMatch(/query/);
    expect(validateRelativeCellUrl("a#frag")).toMatch(/fragment/);
    expect(validateRelativeCellUrl("a%2e%2e/b.cell")).toMatch(/encoded dot/);
    expect(validateRelativeCellUrl("a%2Fb.cell")).toMatch(/encoded separator/);
    expect(validateRelativeCellUrl("a\u0000b.cell")).toMatch(/control/);
    expect(validateRelativeCellUrl("")).toMatch(/empty/);
    expect(validateRelativeCellUrl("a//b.cell")).toMatch(/double slash/);
  });

  it("[ER-12-01] resolves against the manifest directory and re-checks containment", async () => {
    expect(resolveCellUrl("cells/a.cell", "http://localhost/worlds/test/world.json")).toBe(
      "http://localhost/worlds/test/cells/a.cell",
    );
    expect(resolveCellUrl("a.cell", "http://localhost/worlds/test/world.json")).toBe(
      "http://localhost/worlds/test/a.cell",
    );
    // A validated URL cannot escape via `..`, so the containment check is
    // exercised through a manifest anchored at the server root.
    expect(resolveCellUrl("cells/a.cell", "http://localhost/world.json")).toBe(
      "http://localhost/cells/a.cell",
    );
    await expectCode(
      () =>
        resolveCellUrl("https://evil.example/a.cell", "http://localhost/worlds/test/world.json"),
      "E_WORLD_URL",
    );
    await expectCode(
      () => resolveCellUrl("a.cell", "http://user:pass@localhost/worlds/test/world.json"),
      "E_WORLD_URL",
    );
  });

  it("[ER-12-01] visual LOD lookup falls back to the next coarser authored LOD", () => {
    const raw = oneCellManifest({
      visualUrls: ["", "0_0_l1.cell", "0_0_l2.cell", "0_0_l3.cell"],
      visualBytes: [0, 384, 256, 128],
    });
    const config = validateWorldConfig(raw, TEST_MANIFEST_URL);
    const index = new WorldIndex(config, TEST_MANIFEST_URL);
    expect(index.visualPayload("0,0", 0)).toEqual({
      lod: 1,
      url: "http://localhost/worlds/test/0_0_l1.cell",
      bytes: 384,
    });
    expect(index.visualPayload("0,0", 2)?.lod).toBe(2);
    expect(index.visualPayload("0,0", 3)?.lod).toBe(3);
  });
});

describe("boot budget", () => {
  it("[ER-12-12] accepts a measured boot set at the limit and rejects one byte over", () => {
    const ok = checkBootBudget({
      manifestGzipBytes: MAX_MANIFEST_GZIP_BYTES,
      gameGzipBytes: MAX_BOOT_SET_GZIP_BYTES - MAX_MANIFEST_GZIP_BYTES,
      firstRingGzipBytes: 0,
    });
    expect(ok.ok).toBe(true);
    expect(ok.code).toBeNull();
    expect(ok.bootSetGzipBytes).toBe(MAX_BOOT_SET_GZIP_BYTES);

    const overManifest = checkBootBudget({
      manifestGzipBytes: MAX_MANIFEST_GZIP_BYTES + 1,
      firstRingGzipBytes: 0,
    });
    expect(overManifest.ok).toBe(false);
    expect(overManifest.code).toBe("E_WORLD_BUDGET");

    const overBoot = checkBootBudget({
      manifestGzipBytes: 1024,
      gameGzipBytes: MAX_BOOT_SET_GZIP_BYTES,
      firstRingGzipBytes: 0,
    });
    expect(overBoot.ok).toBe(false);
    expect(overBoot.code).toBe("E_WORLD_BUDGET");

    expect(() =>
      assertBootBudget({
        manifestGzipBytes: MAX_MANIFEST_GZIP_BYTES + 1,
        firstRingGzipBytes: 0,
      }),
    ).toThrow(/boot set/);
  });

  it("[ER-12-12] refuses unmeasured or impossible byte counts", async () => {
    const calls: (() => unknown)[] = [
      () => checkBootBudget({ manifestGzipBytes: -1, firstRingGzipBytes: 0 }),
      () => checkBootBudget({ manifestGzipBytes: Number.NaN, firstRingGzipBytes: 0 }),
      () => checkBootBudget({ manifestGzipBytes: 1, firstRingGzipBytes: Number.POSITIVE_INFINITY }),
      () => checkBootBudget({ manifestGzipBytes: 1, gameGzipBytes: -1, firstRingGzipBytes: 0 }),
    ];
    for (const call of calls) {
      await expectCode(call, "E_WORLD_BUDGET");
    }
  });
});

describe("cell entry shape", () => {
  it("[ER-12-01] keeps authored payload fields intact", () => {
    const config = parseWorldManifest(MANIFEST_TEXT, TEST_MANIFEST_URL);
    const entry = config.cells.find((cell) => cell.key === "63,63") as CellIndexEntry;
    expect(entry.visualUrls).toEqual([
      "cells/63_63_l0.cell",
      "cells/63_63_l1.cell",
      "cells/63_63_l2.cell",
      "cells/63_63_l3.cell",
    ]);
    expect(entry.visualBytes).toEqual([512, 384, 256, 128]);
    expect(entry.simUrl).toBe("cells/63_63_sim.cell");
    expect(entry.simBytes).toBe(256);
    expect(entry.contentHash).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(entry.hasCollision).toBe(true);
    expect(entry.hasNav).toBe(true);
  });
});

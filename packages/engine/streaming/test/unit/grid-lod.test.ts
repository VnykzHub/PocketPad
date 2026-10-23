/**
 * Grid keys/transforms and LOD hysteresis (spec 12 §5.1/§5.3, ER-12-01/06).
 *
 * Pure numeric tests: no source, sink, network or filesystem.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Lod, LodBand } from "../../src/index.js";
import {
  CellGrid,
  bandAtDistance,
  clampLodBias,
  compareCellCoords,
  compareCellKeys,
  effectiveMaxDistance,
  formatCellKey,
  isI32,
  parseCellKey,
  selectLod,
  shouldUnload,
  sortCellKeys,
  tryParseCellKey,
  unloadDistanceMeters,
  validateLodBands,
} from "../../src/index.js";
import { expectCode } from "../support/world-fixture.js";

const BANDS: readonly LodBand[] = [
  { lod: 0, maxDistanceMeters: 96, hysteresisMeters: 8 },
  { lod: 1, maxDistanceMeters: 160, hysteresisMeters: 12 },
  { lod: 2, maxDistanceMeters: 256, hysteresisMeters: 16 },
  { lod: 3, maxDistanceMeters: 384, hysteresisMeters: 24 },
];

function grid(
  overrides: Partial<{ cellSizeMeters: number; origin: { x: number; y: number; z: number } }> = {},
): CellGrid {
  return new CellGrid({
    // Origin 0 with negative cell indices: cell (-2,-1) starts at (-128,-64).
    origin: overrides.origin ?? { x: 0, y: 0, z: 0 },
    cellSizeMeters: overrides.cellSizeMeters ?? 64,
    grid: { minX: -2, minY: -1, maxX: 2, maxY: 2 },
  });
}

describe("cell keys", () => {
  it("[ER-12-01] accepts canonical keys and rejects non-canonical spellings", () => {
    expect(parseCellKey("0,0")).toEqual({ cx: 0, cy: 0 });
    expect(parseCellKey("-3,12")).toEqual({ cx: -3, cy: 12 });
    expect(parseCellKey("2147483647,-2147483648")).toEqual({
      cx: 2147483647,
      cy: -2147483648,
    });

    for (const raw of [
      "+0,0",
      "+3,1",
      "003,1",
      "1,003",
      "-0,0",
      "0,-0",
      " 1,2",
      "1 ,2",
      "1,2 ",
      "01,2",
      "1.0,2",
      "1e2,3",
      ",2",
      "1,",
      "",
    ]) {
      expect(tryParseCellKey(raw), raw).toBeUndefined();
    }
    expect(tryParseCellKey("2147483648,0")).toBeUndefined();
    expect(tryParseCellKey("-2147483649,0")).toBeUndefined();
  });

  it("[ER-12-01] formats canonical keys and rejects non-i32 coordinates", () => {
    expect(formatCellKey(-0, 4)).toBe("0,4");
    expect(formatCellKey(2147483647, -2147483648)).toBe("2147483647,-2147483648");
    expect(isI32(2147483647)).toBe(true);
    expect(isI32(2147483648)).toBe(false);
    expect(isI32(1.5)).toBe(false);
    expect(() => formatCellKey(2147483648, 0)).toThrow(/32-bit/);
    expect(() => parseCellKey("+1,1")).toThrow(/non-canonical/);
  });

  it("[ER-12-01] sorts keys by numeric (cx, cy), not lexicographically", () => {
    const keys = ["10,0", "2,0", "-1,5", "-1,-5", "2,-1"] as const;
    expect(sortCellKeys([...keys])).toEqual(["-1,-5", "-1,5", "2,-1", "2,0", "10,0"]);
    expect(compareCellKeys("10,0", "2,0")).toBeGreaterThan(0);
    expect(compareCellCoords({ cx: 2, cy: 0 }, { cx: 2, cy: 0 })).toBe(0);
    expect(compareCellCoords({ cx: 2, cy: 0 }, { cx: 2, cy: 1 })).toBe(-1);
  });

  it("[ER-12-01] round-trips arbitrary i32 coordinate pairs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2147483648, max: 2147483647 }),
        fc.integer({ min: -2147483648, max: 2147483647 }),
        (cx, cy) => {
          expect(parseCellKey(formatCellKey(cx, cy))).toEqual({ cx, cy });
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("CellGrid", () => {
  it("[ER-12-01] maps world positions to cells and reports rectangle distance", () => {
    const world = grid();
    expect(world.width).toBe(5);
    expect(world.height).toBe(4);
    expect(world.cellCount).toBe(20);
    expect(world.contains(-2, -1)).toBe(true);
    expect(world.contains(3, -1)).toBe(false);

    // origin.x = -128, cell size 64: world x -128 maps to cell -2.
    expect(world.worldToCellX(-128)).toBe(-2);
    expect(world.worldToCellX(-64.001)).toBe(-2);
    expect(world.worldToCellX(-64)).toBe(-1);
    expect(world.worldToCellZ(-64)).toBe(-1);
    expect(world.cellAtWorld(-128, -64)).toEqual({ cx: -2, cy: -1 });
    expect(world.cellAtWorld(-128 - 0.001, 0)).toBeUndefined();
    expect(world.cellAtWorld(Number.NaN, 0)).toBeUndefined();

    expect(world.minWorldX(-2)).toBe(-128);
    expect(world.maxWorldX(-2)).toBe(-64);
    expect(world.centerX(-2)).toBe(-96);
    expect(world.centerZ(-1)).toBe(-32);

    // Points inside the rectangle measure 0 on both axes.
    expect(world.distanceToCellXZ(-96, -32, -2, -1)).toBe(0);
    expect(world.distanceToCellXZ(-128, -32, -2, -1)).toBe(0);
    expect(world.distanceToCellXZ(-63.5, -32, -2, -1)).toBeCloseTo(0.5, 9);
    expect(world.distanceToCellXZ(-96, -95, -2, -1)).toBeCloseTo(31, 9);
    expect(world.distanceToCellXZ(-59.5, -97.5, -2, -1)).toBeCloseTo(
      Math.hypot(4.5, 33.5),
      9,
    );
  });

  it("[ER-12-01] enumerates the grid and cropped neighbourhoods in canonical order", () => {
    const world = grid();
    const seen: number[] = [];
    world.forEachNeighbour(0, 0, 1, (cx, cy) => seen.push(world.indexOf(cx, cy)));
    // Cell-major order: for each cx, ascending cy (canonical).
    expect(seen).toEqual([1, 6, 11, 2, 7, 12, 3, 8, 13]);
    const edge: string[] = [];
    world.forEachNeighbour(2, 2, 1, (cx, cy) => edge.push(formatCellKey(cx, cy)));
    expect(edge).toEqual(["1,1", "1,2", "2,1", "2,2"]);

    const all: string[] = [];
    world.forEachCell((cx, cy) => all.push(formatCellKey(cx, cy)));
    expect(all.length).toBe(world.cellCount);
    expect(all[0]).toBe("-2,-1");
    expect(all.at(-1)).toBe("2,2");
    expect(world.indexOf(3, 0)).toBe(-1);
    expect(world.coordOf(0)).toEqual({ cx: -2, cy: -1 });
    expect(world.coordOf(19)).toEqual({ cx: 2, cy: 2 });
    expect(() => world.coordOf(20)).toThrow(/out of range/);
    expect(() => world.forEachNeighbour(0, 0, -1, () => undefined)).toThrow(/non-negative/);
  });

  it("[ER-12-01] derives adjacency and radius helpers from cell size", () => {
    const world = grid();
    expect(world.isAdjacentOrEqual({ cx: 0, cy: 0 }, { cx: 1, cy: 1 })).toBe(true);
    expect(world.isAdjacentOrEqual({ cx: 0, cy: 0 }, { cx: 2, cy: 0 })).toBe(false);
    expect(world.chebyshevRadius(0)).toBe(0);
    expect(world.chebyshevRadius(1)).toBe(0);
    expect(world.chebyshevRadius(272)).toBe(4);
    expect(world.neighbourhoodRadius(272)).toBe(5);
  });

  it("[ER-12-01] rejects an invalid grid or cell size with a named code", async () => {
    const badSize = () =>
      new CellGrid({
        origin: { x: 0, y: 0, z: 0 },
        cellSizeMeters: 0,
        grid: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      });
    await expectCode(badSize, "E_WORLD_CELL_SIZE");
    const badGrid = () =>
      new CellGrid({
        origin: { x: 0, y: 0, z: 0 },
        cellSizeMeters: 64,
        grid: { minX: 2, minY: 0, maxX: 1, maxY: 0 },
      });
    await expectCode(badGrid, "E_WORLD_GRID");
    const tooMany = () =>
      new CellGrid({
        origin: { x: 0, y: 0, z: 0 },
        cellSizeMeters: 64,
        grid: { minX: 0, minY: 0, maxX: 128, maxY: 128 },
      });
    await expectCode(tooMany, "E_WORLD_GRID");
  });
});

describe("LOD bands", () => {
  it("[ER-12-06] selects the finest band containing the distance", () => {
    expect(bandAtDistance(0, BANDS, 0)).toBe(0);
    expect(bandAtDistance(96, BANDS, 0)).toBe(0);
    expect(bandAtDistance(96.001, BANDS, 0)).toBe(1);
    expect(bandAtDistance(160, BANDS, 0)).toBe(1);
    expect(bandAtDistance(256, BANDS, 0)).toBe(2);
    expect(bandAtDistance(384, BANDS, 0)).toBe(3);
    expect(bandAtDistance(384.001, BANDS, 0)).toBeUndefined();
    expect(() => bandAtDistance(-1, BANDS, 0)).toThrow(/non-negative/);
    expect(() => bandAtDistance(Number.POSITIVE_INFINITY, BANDS, 0)).toThrow(/non-negative/);
  });

  it("[ER-12-06] keeps the current LOD inside the hysteresis dead band", () => {
    // Dead band for the 0/1 edge is (88, 104): no promotion at >= 88,
    // no demotion until > 104.
    expect(selectLod(96, 0, BANDS, 0)).toBe(0);
    expect(selectLod(104, 0, BANDS, 0)).toBe(0);
    expect(selectLod(104.0001, 0, BANDS, 0)).toBe(1);
    expect(selectLod(96, 1, BANDS, 0)).toBe(1);
    expect(selectLod(88, 1, BANDS, 0)).toBe(1);
    expect(selectLod(87.9999, 1, BANDS, 0)).toBe(0);

    // A long jump demotes several bands in one decision.
    expect(selectLod(300, 0, BANDS, 0)).toBe(3);
    expect(selectLod(10, 3, BANDS, 0)).toBe(0);
    expect(selectLod(10, undefined, BANDS, 0)).toBe(0);
    expect(selectLod(500, undefined, BANDS, 0)).toBe(3);
    expect(selectLod(500, 3, BANDS, 0)).toBe(3);
  });

  it("[ER-12-06] clamps and scales the bias without enlarging a ring", () => {
    expect(clampLodBias(-2)).toBe(0);
    expect(clampLodBias(0)).toBe(0);
    expect(clampLodBias(1.5)).toBe(1.5);
    expect(clampLodBias(9)).toBe(3);
    expect(() => clampLodBias(Number.NaN)).toThrow(/finite/);
    expect(effectiveMaxDistance(BANDS[0] as LodBand, 0)).toBe(96);
    expect(effectiveMaxDistance(BANDS[0] as LodBand, 1)).toBe(72);
    expect(effectiveMaxDistance(BANDS[3] as LodBand, 3)).toBe(96);
    expect(bandAtDistance(96, BANDS, 1)).toBe(1);
    // Bias 1 coarsens the LOD0 ring to 72 m, so 96 m is already LOD1.
    expect(selectLod(96, 0, BANDS, 1)).toBe(1);
    expect(selectLod(80, 0, BANDS, 1)).toBe(0); // inside the coarsened dead band (64, 80]
  });

  it("[ER-12-06] unloads only beyond band 3 + hysteresis + one cell", () => {
    expect(unloadDistanceMeters(BANDS, 384, 64)).toBe(472);
    expect(shouldUnload(472, BANDS, 0, 64)).toBe(false);
    expect(shouldUnload(472.0001, BANDS, 0, 64)).toBe(true);
    // Bias 1 coarsens band 3 to 288: 288 + 24 + 64 = 376.
    expect(shouldUnload(376, BANDS, 1, 64)).toBe(false);
    expect(shouldUnload(376.0001, BANDS, 1, 64)).toBe(true);
    expect(() => shouldUnload(400, BANDS.slice(0, 2), 0, 64)).toThrow(/four bands/);
  });

  it("[ER-12-06] validates band shape at manifest load", async () => {
    expect(() => validateLodBands(BANDS)).not.toThrow();
    const cases: [LodBand[], string][] = [
      [BANDS.slice(0, 3), "E_WORLD_LOD_BANDS"],
      [
        [
          { ...(BANDS[0] as LodBand), lod: 1 as Lod },
          ...BANDS.slice(1),
        ],
        "E_WORLD_LOD_BANDS",
      ],
      [
        [{ ...(BANDS[0] as LodBand), maxDistanceMeters: 0 }, ...BANDS.slice(1)],
        "E_WORLD_LOD_BANDS",
      ],
      [
        [{ ...(BANDS[0] as LodBand), hysteresisMeters: -1 }, ...BANDS.slice(1)],
        "E_WORLD_LOD_BANDS",
      ],
      [
        [BANDS[0] as LodBand, BANDS[0] as LodBand, BANDS[2] as LodBand, BANDS[3] as LodBand],
        "E_WORLD_LOD_BANDS",
      ],
      [
        [{ ...(BANDS[0] as LodBand), hysteresisMeters: 64 }, ...BANDS.slice(1)],
        "E_WORLD_LOD_BANDS",
      ],
    ];
    for (const [bands, code] of cases) {
      await expectCode(() => validateLodBands(bands), code);
    }
  });

  it("[ER-12-06] never switches while a ±2 m camera oscillation stays in the dead band", () => {
    // Each boundary's two adjacent LODs; both are legal inside the dead band
    // and must never be changed by a ±2 m oscillation.
    const boundaries: [number, Lod, Lod][] = [
      [96, 0, 1],
      [160, 1, 2],
      [256, 2, 3],
    ];
    for (const [boundary, finer, coarser] of boundaries) {
      for (const startLod of [finer, coarser]) {
        let current: Lod | undefined = startLod;
        let switches = 0;
        for (let tick = 0; tick < 600; tick += 1) {
          const distance = boundary + 2 * Math.sin((tick / 600) * Math.PI * 2);
          const next = selectLod(distance, current, BANDS, 0);
          if (next !== current) switches += 1;
          current = next;
        }
        expect(switches, `boundary ${boundary} from LOD ${startLod}`).toBe(0);
      }
    }
  });

  it("[ER-12-06] one monotonic sweep across a boundary switches exactly once", () => {
    let current: Lod | undefined = 0;
    let switches = 0;
    for (let tick = 0; tick < 600; tick += 1) {
      // 80 m -> 112 m: exits the LOD0 dead band (88, 104] once, never returns.
      const distance = 80 + (32 * tick) / 599;
      const next = selectLod(distance, current, BANDS, 0);
      if (next !== current) switches += 1;
      current = next;
    }
    expect(switches).toBe(1);
    expect(current).toBe(1);
  });

  it("[ER-12-06] random distances inside a dead band never change the LOD", () => {
    const deadBands: [number, number, Lod][] = [
      [88, 104, 0],
      [88, 104, 1],
      [148, 172, 1],
      [148, 172, 2],
      [240, 272, 2],
      [240, 272, 3],
    ];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: deadBands.length - 1 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (index, fraction) => {
          const [low, high, current] = deadBands[index] as [number, number, Lod];
          const distance = low + (high - low) * fraction;
          expect(selectLod(distance, current, BANDS, 0)).toBe(current);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

/**
 * Cell keys and world<->cell transforms (spec 12 §5.1, `src/Grid.ts`).
 *
 * Canonical key rules (00 §4.4): signed i32 components, decimal, no `+`, no
 * leading zeros, `-0` normalises to `0`. `+3`, `003`, `-0` and whitespace are
 * rejected. Cell `(cx, cy)` covers
 * `[origin.x + cx*S, origin.x + (cx+1)*S) x [origin.z + cy*S, origin.z + (cy+1)*S)`
 * (12 §4.1); Y is elevation, never a cell axis.
 */

import type { CellKey, LodBand, WorldConfig } from "./contracts/world.js";
import { STREAMING_LIMITS } from "./contracts/world.js";
import { streamingError } from "./StreamEvents.js";

const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;

/**
 * Canonical shape only. `-0` is not reachable through the regex because a
 * negative component must start with 1-9 after the sign; `0` is its own
 * alternative. Leading zeros are impossible for the same reason.
 */
const CELL_KEY_PATTERN = /^(?:0|-?[1-9]\d*),(?:0|-?[1-9]\d*)$/;

export interface CellCoord {
  readonly cx: number;
  readonly cy: number;
}

/** World-space XZ rectangle of one cell; `max` edges are exclusive. */
export interface CellBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** Inclusive grid rectangle in cell coordinates. */
export interface GridRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export function isI32(value: number): boolean {
  return Number.isInteger(value) && value >= I32_MIN && value <= I32_MAX;
}

/** Formats a coordinate pair; throws `E_WORLD_KEY` for non-integers or i32 overflow. */
export function formatCellKey(cx: number, cy: number): CellKey {
  if (!isI32(cx) || !isI32(cy)) {
    throw streamingError(
      "E_WORLD_KEY",
      `cell coordinate is not a signed 32-bit integer: ${String(cx)},${String(cy)}`,
    );
  }
  // Template literals render -0 as "0", which is the canonical form.
  return `${cx},${cy}` as CellKey;
}

/** Parses a canonical key; throws `E_WORLD_KEY` on any non-canonical form. */
export function parseCellKey(raw: string): CellCoord {
  const parsed = tryParseCellKey(raw);
  if (parsed === undefined) {
    throw streamingError("E_WORLD_KEY", `non-canonical cell key: ${raw}`);
  }
  return parsed;
}

/** Returns undefined instead of throwing; used by validators that collect issues. */
export function tryParseCellKey(raw: string): CellCoord | undefined {
  if (typeof raw !== "string" || !CELL_KEY_PATTERN.test(raw)) return undefined;
  const comma = raw.indexOf(",");
  const cx = Number(raw.slice(0, comma));
  const cy = Number(raw.slice(comma + 1));
  if (!isI32(cx) || !isI32(cy)) return undefined;
  return { cx, cy };
}

export function cellKeyEquals(a: CellKey, b: CellKey): boolean {
  return a === b;
}

/** Canonical order: ascending `(cx, cy)` (12 §5.6 rule 3). */
export function compareCellCoords(a: CellCoord, b: CellCoord): number {
  if (a.cx !== b.cx) return a.cx < b.cx ? -1 : 1;
  if (a.cy !== b.cy) return a.cy < b.cy ? -1 : 1;
  return 0;
}

/** Lexicographic compare of two keys after parsing; throws on a malformed key. */
export function compareCellKeys(a: CellKey, b: CellKey): number {
  return compareCellCoords(parseCellKey(a), parseCellKey(b));
}

export function sortCellKeys(keys: readonly CellKey[]): CellKey[] {
  return [...keys].sort(compareCellKeys);
}

/**
 * Immutable grid transform for one world. Validates the configuration that
 * concerns the grid; `Index.ts` validates the rest of the manifest.
 */
export class CellGrid {
  readonly originX: number;
  readonly originZ: number;
  readonly cellSizeMeters: number;
  readonly rect: GridRect;
  readonly width: number;
  readonly height: number;
  readonly cellCount: number;

  constructor(config: Pick<WorldConfig, "origin" | "cellSizeMeters" | "grid">) {
    const size = config.cellSizeMeters;
    if (
      !Number.isInteger(size) ||
      size < STREAMING_LIMITS.minCellSizeMeters ||
      size > STREAMING_LIMITS.maxCellSizeMeters
    ) {
      throw streamingError(
        "E_WORLD_CELL_SIZE",
        `cellSizeMeters must be an integer in [${STREAMING_LIMITS.minCellSizeMeters}, ${STREAMING_LIMITS.maxCellSizeMeters}]`,
      );
    }
    const { minX, minY, maxX, maxY } = config.grid;
    if (!isI32(minX) || !isI32(minY) || !isI32(maxX) || !isI32(maxY) || minX > maxX || minY > maxY) {
      throw streamingError("E_WORLD_GRID", "grid rectangle is invalid");
    }
    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const cellCount = width * height;
    if (!Number.isSafeInteger(cellCount) || cellCount > STREAMING_LIMITS.maxCells) {
      throw streamingError(
        "E_WORLD_GRID",
        `grid holds ${String(cellCount)} cells; the cap is ${STREAMING_LIMITS.maxCells}`,
      );
    }
    if (
      !Number.isFinite(config.origin.x) ||
      !Number.isFinite(config.origin.y) ||
      !Number.isFinite(config.origin.z)
    ) {
      throw streamingError("E_WORLD_FORMAT", "origin must be finite");
    }
    this.originX = config.origin.x;
    this.originZ = config.origin.z;
    this.cellSizeMeters = size;
    this.rect = { minX, minY, maxX, maxY };
    this.width = width;
    this.height = height;
    this.cellCount = cellCount;
  }

  contains(cx: number, cy: number): boolean {
    const { minX, minY, maxX, maxY } = this.rect;
    return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
  }

  /** Flat row-major index (cy-major) for the rectangle, or -1 outside it. */
  indexOf(cx: number, cy: number): number {
    if (!this.contains(cx, cy)) return -1;
    return (cy - this.rect.minY) * this.width + (cx - this.rect.minX);
  }

  coordOf(index: number): CellCoord {
    if (!Number.isInteger(index) || index < 0 || index >= this.cellCount) {
      throw streamingError("E_WORLD_GRID", `grid index out of range: ${String(index)}`);
    }
    const cx = this.rect.minX + (index % this.width);
    const cy = this.rect.minY + Math.floor(index / this.width);
    return { cx, cy };
  }

  minWorldX(cx: number): number {
    return this.originX + cx * this.cellSizeMeters;
  }

  /** Exclusive edge. */
  maxWorldX(cx: number): number {
    return this.originX + (cx + 1) * this.cellSizeMeters;
  }

  minWorldZ(cy: number): number {
    return this.originZ + cy * this.cellSizeMeters;
  }

  /** Exclusive edge. */
  maxWorldZ(cy: number): number {
    return this.originZ + (cy + 1) * this.cellSizeMeters;
  }

  centerX(cx: number): number {
    return this.minWorldX(cx) + this.cellSizeMeters / 2;
  }

  centerZ(cy: number): number {
    return this.minWorldZ(cy) + this.cellSizeMeters / 2;
  }

  worldToCellX(x: number): number {
    return Math.floor((x - this.originX) / this.cellSizeMeters);
  }

  worldToCellZ(z: number): number {
    return Math.floor((z - this.originZ) / this.cellSizeMeters);
  }

  /** Cell containing a world XZ position, or undefined outside the grid. */
  cellAtWorld(x: number, z: number): CellCoord | undefined {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return undefined;
    const cx = this.worldToCellX(x);
    const cy = this.worldToCellZ(z);
    return this.contains(cx, cy) ? { cx, cy } : undefined;
  }

  boundsOf(cx: number, cy: number): CellBounds {
    return {
      minX: this.minWorldX(cx),
      maxX: this.maxWorldX(cx),
      minZ: this.minWorldZ(cy),
      maxZ: this.maxWorldZ(cy),
    };
  }

  /**
   * XZ distance from a point to the cell rectangle; 0 when the point is
   * inside (12 §5.3). Uses `max` as an exclusive edge, so a point exactly on
   * the edge measures 0 for the cell on either side.
   */
  distanceToCellXZ(x: number, z: number, cx: number, cy: number): number {
    const dx = axisDistance(x, this.minWorldX(cx), this.maxWorldX(cx));
    const dz = axisDistance(z, this.minWorldZ(cy), this.maxWorldZ(cy));
    return Math.hypot(dx, dz);
  }

  /** Calls `fn` for every cell in the grid, ascending `(cx, cy)`. */
  forEachCell(fn: (cx: number, cy: number) => void): void {
    const { minX, minY, maxX, maxY } = this.rect;
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cy = minY; cy <= maxY; cy += 1) {
        fn(cx, cy);
      }
    }
  }

  /**
   * Calls `fn` for the square neighbourhood of `radius` around `(cx, cy)`,
   * cropped to the grid, ascending `(cx, cy)` — the canonical order.
   */
  forEachNeighbour(
    cx: number,
    cy: number,
    radius: number,
    fn: (ncx: number, ncy: number) => void,
  ): void {
    if (!Number.isInteger(radius) || radius < 0) {
      throw streamingError("E_WORLD_GRID", `neighbourhood radius must be a non-negative integer`);
    }
    const x0 = Math.max(this.rect.minX, cx - radius);
    const x1 = Math.min(this.rect.maxX, cx + radius);
    const y0 = Math.max(this.rect.minY, cy - radius);
    const y1 = Math.min(this.rect.maxY, cy + radius);
    for (let ncx = x0; ncx <= x1; ncx += 1) {
      for (let ncy = y0; ncy <= y1; ncy += 1) {
        fn(ncx, ncy);
      }
    }
  }

  /** True when the two cells are equal or share an edge or corner. */
  isAdjacentOrEqual(a: CellCoord, b: CellCoord): boolean {
    return Math.abs(a.cx - b.cx) <= 1 && Math.abs(a.cy - b.cy) <= 1;
  }

  /** Chebyshev radius in cells that still touches `meters` (12 §5.3 table). */
  chebyshevRadius(meters: number): number {
    return Math.max(0, Math.ceil(meters / this.cellSizeMeters) - 1);
  }

  /** Cell radius that covers every point within `meters` of a cell AABB. */
  neighbourhoodRadius(meters: number): number {
    return Math.max(0, Math.ceil(meters / this.cellSizeMeters));
  }
}

function axisDistance(value: number, min: number, max: number): number {
  if (value < min) return min - value;
  if (value >= max) return value - max;
  return 0;
}

/**
 * The unload distance from 12 §5.3: band 3 + its hysteresis + one cell.
 * The caller passes the already-effective band-3 distance so `lodBias` is
 * applied uniformly.
 */
export function unloadDistanceMeters(
  bands: readonly LodBand[],
  effectiveBand3Max: number,
  cellSizeMeters: number,
): number {
  const band = bands[3];
  if (band === undefined) {
    throw streamingError("E_WORLD_LOD_BANDS", "lodBands must contain four bands");
  }
  return effectiveBand3Max + band.hysteresisMeters + cellSizeMeters;
}

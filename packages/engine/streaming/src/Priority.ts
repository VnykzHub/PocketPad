/**
 * Focus scoring, candidate selection, deterministic sort and the prefetch
 * window (spec 12 §5.3, §5.4, `src/Priority.ts`).
 *
 * Every decision produces the full demand set: one `sim` candidate per cell
 * inside `simRadiusMeters` that has a simulation payload, and one `visual`
 * candidate per cell inside the unload distance. Classes and scores follow
 * 12 §5.4 exactly:
 *
 * - class 0: sim of a cell containing or adjacent to a focus; visual LOD0
 * - class 1: sim inside the simulation radius
 * - class 2/3/4: visual LOD1/LOD2/LOD3 (LOD3 is also the prefetch window)
 *
 * `score = min over focus of distanceXZ / clamp(weight, 0.25, 4)`, plus
 * `0.25 * cellSizeMeters` for behind-camera cells. A focus with velocity also
 * contributes one look-ahead sample at `weight * 0.5`; that sample is the
 * prefetch window (2 s of travel, clamped to 64 m). Sorting is total:
 * `(class, score, cx, cy)`, then `kind` and `lod` only to break an exact tie
 * between a sim and a visual candidate of the same cell.
 *
 * Distant focuses (XZ distance from the camera > `visualFocusRangeMeters`)
 * still request simulation and a low-detail stand-in, but a cell whose nearest
 * sample comes from a distant focus is never promoted above LOD2 (12 §5.3).
 *
 * The returned array is a reused snapshot, valid until the next `plan` call.
 * Candidate records are pooled; after warm-up a plan allocates nothing.
 */

import type { CellKey, LodBand, StreamView } from "./contracts/world.js";
import { STREAMING_DEFAULTS, STREAMING_LIMITS } from "./contracts/world.js";
import type { WorldIndex } from "./WorldIndex.js";
import { CellGrid } from "./Grid.js";
import type { Lod } from "./Lod.js";
import { clampLodBias, effectiveMaxDistance, selectLod, shouldUnload } from "./Lod.js";
import { streamingError } from "./StreamEvents.js";

export const LOOK_AHEAD_SECONDS = 2;
export const LOOK_AHEAD_MAX_METERS = 64;

export type PriorityClass = 0 | 1 | 2 | 3 | 4;

export interface PriorityCandidate {
  readonly key: CellKey;
  readonly cx: number;
  readonly cy: number;
  readonly kind: "sim" | "visual";
  /** Selected band for a visual candidate; null for sim. */
  readonly lod: Lod | null;
  readonly priorityClass: PriorityClass;
  readonly score: number;
  /** Unweighted distance used for band selection (sim: nearest real focus). */
  readonly distanceMeters: number;
}

interface CandidateRecord {
  key: CellKey;
  cx: number;
  cy: number;
  kind: "sim" | "visual";
  lod: Lod | null;
  priorityClass: PriorityClass;
  score: number;
  distanceMeters: number;
}

interface FocusSample {
  x: number;
  z: number;
  /** `clamp(weight, 0.25, 4)`, or half that (floored at 0.25) for look-ahead. */
  divisor: number;
  distant: boolean;
}

export interface PriorityOptions {
  /** Defaults to `STREAMING_DEFAULTS.simRadiusMeters` (272 m). */
  readonly simRadiusMeters?: number;
  /** Defaults to `STREAMING_DEFAULTS.visualFocusRangeMeters` (400 m). */
  readonly visualFocusRangeMeters?: number;
  /** Defaults to 0. */
  readonly lodBias?: number;
}

/** Clamps a focus weight to [0.25, 4]; a missing weight means 1. */
export function clampFocusWeight(weight: number | undefined): number {
  if (weight === undefined) return 1;
  if (!Number.isFinite(weight)) {
    throw streamingError("E_STREAM_STATE", "focus weight must be finite");
  }
  if (weight < 0.25) return 0.25;
  if (weight > 4) return 4;
  return weight;
}

/**
 * The look-ahead point from 12 §5.4: `position + clamp(velocity, 2 s, 64 m)`
 * in the XZ plane. Returns `undefined` when velocity is absent or zero.
 */
export function lookAheadPosition(
  position: { readonly x: number; readonly z: number },
  velocity: { readonly x: number; readonly z: number } | undefined,
): { x: number; z: number } | undefined {
  if (velocity === undefined) return undefined;
  if (!Number.isFinite(velocity.x) || !Number.isFinite(velocity.z)) {
    throw streamingError("E_STREAM_STATE", "focus velocity must be finite");
  }
  let dx = velocity.x * LOOK_AHEAD_SECONDS;
  let dz = velocity.z * LOOK_AHEAD_SECONDS;
  const length = Math.hypot(dx, dz);
  if (length === 0) return undefined;
  if (length > LOOK_AHEAD_MAX_METERS) {
    const scale = LOOK_AHEAD_MAX_METERS / length;
    dx *= scale;
    dz *= scale;
  }
  return { x: position.x + dx, z: position.z + dz };
}

/** Deterministic, total candidate order (12 §5.4). */
export function comparePriorityCandidates(
  a: PriorityCandidate,
  b: PriorityCandidate,
): number {
  if (a.priorityClass !== b.priorityClass) return a.priorityClass - b.priorityClass;
  if (a.score !== b.score) return a.score < b.score ? -1 : 1;
  if (a.cx !== b.cx) return a.cx < b.cx ? -1 : 1;
  if (a.cy !== b.cy) return a.cy < b.cy ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === "sim" ? -1 : 1;
  const aLod = a.lod ?? -1;
  const bLod = b.lod ?? -1;
  if (aLod !== bLod) return aLod < bLod ? -1 : 1;
  return 0;
}

const LOD_CLASS: readonly [PriorityClass, PriorityClass, PriorityClass, PriorityClass] = [
  0, 2, 3, 4,
];

/**
 * Plans the demand set for one view. One instance per world; `plan` reuses
 * every array and record it owns.
 */
export class PriorityPlanner {
  private readonly index: WorldIndex;
  private readonly grid: CellGrid;
  private readonly bands: readonly LodBand[];
  private simRadius: number;
  private visualRange: number;
  private bias: number;

  /** Generation stamps: visiting the same cell from two focus rects is O(1). */
  private readonly stamps: Uint32Array;
  private generation = 0;

  private readonly samples: (FocusSample | undefined)[] = [];
  private sampleCount = 0;

  // Real focus positions and their cell coordinates. Simulation demand never
  // follows the look-ahead point, so these are stored separately.
  private readonly focusCellXs: number[] = [];
  private readonly focusCellZs: number[] = [];
  private readonly focusXs: number[] = [];
  private readonly focusZs: number[] = [];
  private focusCount = 0;

  private cameraX = 0;
  private cameraZ = 0;
  private forwardX = 0;
  private forwardZ = 0;
  private hasForward = false;

  private readonly active: CandidateRecord[] = [];
  private readonly pool: CandidateRecord[] = [];
  private poolCursor = 0;

  constructor(index: WorldIndex, options: PriorityOptions = {}) {
    this.index = index;
    this.grid = index.grid;
    this.bands = index.config.lodBands;
    this.simRadius = requirePositive(
      options.simRadiusMeters ?? STREAMING_DEFAULTS.simRadiusMeters,
      "simRadiusMeters",
    );
    this.visualRange = requirePositive(
      options.visualFocusRangeMeters ?? STREAMING_DEFAULTS.visualFocusRangeMeters,
      "visualFocusRangeMeters",
    );
    this.bias = clampLodBias(options.lodBias ?? 0);
    this.stamps = new Uint32Array(this.grid.cellCount);
  }

  get lodBias(): number {
    return this.bias;
  }

  get simRadiusMeters(): number {
    return this.simRadius;
  }

  get visualFocusRangeMeters(): number {
    return this.visualRange;
  }

  /** 12 §5.3: `lodBias` is clamped to [0, 3] rather than rejected. */
  setLodBias(bias: number): void {
    this.bias = clampLodBias(bias);
  }

  setSimRadius(meters: number): void {
    this.simRadius = requirePositive(meters, "simRadiusMeters");
  }

  /**
   * Returns the sorted demand set for `view`. `currentLods` supplies the
   * cell's applied/requested LOD so hysteresis keeps a loaded cell in place
   * across the band edge; absent entries mean "never loaded".
   */
  plan(
    view: StreamView,
    currentLods?: ReadonlyMap<CellKey, Lod>,
  ): readonly PriorityCandidate[] {
    this.beginPlan(view);
    if (this.sampleCount === 0) return this.active;

    const radiusCells =
      Math.ceil(Math.max(this.unloadDistance(), this.simRadius) / this.grid.cellSizeMeters) + 1;
    const { minX, minY, maxX, maxY } = this.grid.rect;

    for (let sampleIndex = 0; sampleIndex < this.sampleCount; sampleIndex += 1) {
      const sample = this.samples[sampleIndex];
      if (sample === undefined) continue;
      const sampleCx = this.grid.worldToCellX(sample.x);
      const sampleCy = this.grid.worldToCellZ(sample.z);
      const x0 = Math.max(minX, sampleCx - radiusCells);
      const x1 = Math.min(maxX, sampleCx + radiusCells);
      const y0 = Math.max(minY, sampleCy - radiusCells);
      const y1 = Math.min(maxY, sampleCy + radiusCells);
      for (let cx = x0; cx <= x1; cx += 1) {
        for (let cy = y0; cy <= y1; cy += 1) {
          const flat = this.grid.indexOf(cx, cy);
          if (flat < 0 || this.stamps[flat] === this.generation) continue;
          this.stamps[flat] = this.generation;
          this.consider(flat, currentLods);
        }
      }
    }

    // `Array.prototype.sort` is spec-stable since ES2019, and the comparator
    // is total anyway, so this order is fully deterministic.
    this.active.sort(comparePriorityCandidates);
    return this.active;
  }

  private beginPlan(view: StreamView): void {
    if (view.focus.length > STREAMING_LIMITS.maxFocusPoints) {
      throw streamingError(
        "E_STREAM_STATE",
        `view has ${view.focus.length} focus points; the cap is ${STREAMING_LIMITS.maxFocusPoints}`,
      );
    }
    assertFiniteVec(view.cameraPosition, "cameraPosition");
    assertFiniteVec(view.cameraForward, "cameraForward");
    const forwardX = view.cameraForward.x;
    const forwardZ = view.cameraForward.z;
    const forwardLength = Math.hypot(forwardX, forwardZ);
    this.hasForward = forwardLength > 0;
    if (this.hasForward) {
      this.forwardX = forwardX / forwardLength;
      this.forwardZ = forwardZ / forwardLength;
    }
    this.cameraX = view.cameraPosition.x;
    this.cameraZ = view.cameraPosition.z;

    this.generation += 1;
    if (this.generation >= 0xffff_fffe) {
      this.stamps.fill(0);
      this.generation = 1;
    }

    this.sampleCount = 0;
    this.focusCount = 0;
    for (let index = 0; index < view.focus.length; index += 1) {
      const focus = view.focus[index];
      if (focus === undefined) continue;
      assertFiniteVec(focus.position, `focus[${index}].position`);
      const divisor = clampFocusWeight(focus.weight);
      const distant =
        Math.hypot(focus.position.x - this.cameraX, focus.position.z - this.cameraZ) >
        this.visualRange;
      this.pushSample(focus.position.x, focus.position.z, divisor, distant);
      const ahead = lookAheadPosition(focus.position, focus.velocity);
      if (ahead !== undefined) {
        this.pushSample(ahead.x, ahead.z, Math.max(0.25, divisor * 0.5), distant);
      }
      this.focusXs[this.focusCount] = focus.position.x;
      this.focusZs[this.focusCount] = focus.position.z;
      this.focusCellXs[this.focusCount] = this.grid.worldToCellX(focus.position.x);
      this.focusCellZs[this.focusCount] = this.grid.worldToCellZ(focus.position.z);
      this.focusCount += 1;
    }

    this.active.length = 0;
    this.poolCursor = 0;
  }

  private pushSample(x: number, z: number, divisor: number, distant: boolean): void {
    let sample = this.samples[this.sampleCount];
    if (sample === undefined) {
      sample = { x: 0, z: 0, divisor: 1, distant: false };
      this.samples[this.sampleCount] = sample;
    }
    sample.x = x;
    sample.z = z;
    sample.divisor = divisor;
    sample.distant = distant;
    this.sampleCount += 1;
  }

  private consider(flat: number, currentLods: ReadonlyMap<CellKey, Lod> | undefined): void {
    const entry = this.index.entryByGridIndex(flat);
    if (entry === undefined) return;
    const cx = entry.cx;
    const cy = entry.cy;

    // Band distance and the distant cap use every sample, including the
    // look-ahead window; the score already carries the weight.
    let nearest = Infinity;
    let nearestDistant = false;
    for (let index = 0; index < this.sampleCount; index += 1) {
      const sample = this.samples[index];
      if (sample === undefined) continue;
      const distance = this.grid.distanceToCellXZ(sample.x, sample.z, cx, cy);
      if (distance < nearest) {
        nearest = distance;
        nearestDistant = sample.distant;
      }
    }

    let nearestReal = Infinity;
    let adjacentToFocus = false;
    for (let index = 0; index < this.focusCount; index += 1) {
      const cellX = this.focusCellXs[index] ?? 0;
      const cellY = this.focusCellZs[index] ?? 0;
      if (Math.abs(cx - cellX) <= 1 && Math.abs(cy - cellY) <= 1) {
        adjacentToFocus = true;
      }
      const distance = this.grid.distanceToCellXZ(
        this.focusXs[index] ?? 0,
        this.focusZs[index] ?? 0,
        cx,
        cy,
      );
      if (distance < nearestReal) nearestReal = distance;
    }

    let score = Infinity;
    for (let index = 0; index < this.sampleCount; index += 1) {
      const sample = this.samples[index];
      if (sample === undefined) continue;
      const distance = this.grid.distanceToCellXZ(sample.x, sample.z, cx, cy);
      const weighted = distance / sample.divisor;
      if (weighted < score) score = weighted;
    }
    score = this.applyCameraPenalty(score, cx, cy);

    if (entry.simUrl !== "" && nearestReal <= this.simRadius) {
      const record = this.takeRecord();
      record.key = entry.key;
      record.cx = cx;
      record.cy = cy;
      record.kind = "sim";
      record.lod = null;
      record.priorityClass = adjacentToFocus ? 0 : 1;
      record.score = score;
      record.distanceMeters = nearestReal;
      this.active.push(record);
    }

    if (!shouldUnload(nearest, this.bands, this.bias, this.grid.cellSizeMeters)) {
      const current = currentLods?.get(entry.key);
      let lod: Lod = selectLod(nearest, current, this.bands, this.bias);
      if (nearestDistant && lod < 2) lod = 2;
      const record = this.takeRecord();
      record.key = entry.key;
      record.cx = cx;
      record.cy = cy;
      record.kind = "visual";
      record.lod = lod;
      record.priorityClass = LOD_CLASS[lod];
      record.score = score;
      record.distanceMeters = nearest;
      this.active.push(record);
    }
  }

  private applyCameraPenalty(score: number, cx: number, cy: number): number {
    if (!this.hasForward) return score;
    const dx = this.grid.centerX(cx) - this.cameraX;
    const dz = this.grid.centerZ(cy) - this.cameraZ;
    // The dot's sign is unchanged by normalising (center - camera).
    if (this.forwardX * dx + this.forwardZ * dz < 0) {
      return score + 0.25 * this.grid.cellSizeMeters;
    }
    return score;
  }

  private takeRecord(): CandidateRecord {
    const existing = this.pool[this.poolCursor];
    if (existing !== undefined) {
      this.poolCursor += 1;
      return existing;
    }
    const record: CandidateRecord = {
      key: "0,0",
      cx: 0,
      cy: 0,
      kind: "sim",
      lod: null,
      priorityClass: 0,
      score: 0,
      distanceMeters: 0,
    };
    this.pool.push(record);
    this.poolCursor += 1;
    return record;
  }

  private unloadDistance(): number {
    const band = this.bands[3];
    if (band === undefined) {
      throw streamingError("E_WORLD_LOD_BANDS", "lodBands must contain four bands");
    }
    return (
      effectiveMaxDistance(band, this.bias) +
      band.hysteresisMeters +
      this.grid.cellSizeMeters
    );
  }
}

function requirePositive(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw streamingError("E_STREAM_STATE", `${what} must be positive and finite`);
  }
  return value;
}

function assertFiniteVec(value: { x: number; y: number; z: number }, what: string): void {
  if (
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.z)
  ) {
    throw streamingError("E_STREAM_STATE", `${what} must be finite`);
  }
}

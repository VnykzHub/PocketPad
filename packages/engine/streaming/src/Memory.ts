/**
 * Byte ledger, category accounting, pressure stages and eviction policy
 * (spec 12 §5.7, `src/Memory.ts`).
 *
 * The ledger is updated synchronously at apply and evict and never samples.
 * Categories are `geometry`, `texture` and `cpu`; `residentBytes` is their
 * sum. A shared geometry handle or texture atlas is charged once by asset id
 * and released when the last cell referencing it is evicted.
 *
 * Pressure stages are taken from 12 §5.7: stage 1 at >= 85% of
 * `residentBytes`, stage 2 at >= 95%, stage 3 at >= 100%. Recovery (the
 * streamer's 600-tick bias decrement) starts below 80%.
 *
 * Eviction ordering interpretation: 12 §5.7 rule 3 says "evict the farthest
 * non-pinned cell, coarsest LOD first; ties by descending (cx, cy)". This
 * module orders coarsest LOD first, then farthest distance, then descending
 * `(cx, cy)`, which is the only reading that keeps "coarsest LOD first"
 * meaningful across cells at different distances. Pinned cells, player-guarded
 * cells and simulation-ring payloads are never selected (rules 4 and the
 * simulation-ring floor). Distance evictions are returned in ascending key
 * order so deactivation callbacks run in the order 12 §5.5 requires.
 */

import type { CellKey } from "./contracts/world.js";
import type { Lod } from "./Lod.js";
import { streamingError } from "./StreamEvents.js";

export const PRESSURE_STAGE1_FRACTION = 0.85;
export const PRESSURE_STAGE2_FRACTION = 0.95;
export const PRESSURE_RECOVERY_FRACTION = 0.8;

export type PressureStage = 0 | 1 | 2 | 3;
export type MemoryCategory = "geometry" | "texture" | "cpu";

export interface SharedAssetUse {
  /** Asset or handle identity; the same id is charged once across cells. */
  readonly id: string;
  readonly category: "geometry" | "texture";
  readonly bytes: number;
}

/**
 * One resident payload's contributions to the ledger. The key is the payload
 * id (`visual:<key>:<lod>` / `sim:<key>`), not the cell key, because a LOD
 * swap holds two visual payloads of the same cell at once (12 §5.3).
 */
export interface CellMemoryEntry {
  readonly key: string;
  /** Geometry bytes unique to this cell. */
  readonly geometryBytes: number;
  /** Texture bytes unique to this cell. */
  readonly textureBytes: number;
  readonly cpuBytes: number;
  /** Handles shared with other cells; charged once per `id`. */
  readonly sharedAssets?: readonly SharedAssetUse[];
}

export interface MemorySnapshot {
  readonly geometryBytes: number;
  readonly textureBytes: number;
  readonly cpuBytes: number;
  readonly residentBytes: number;
  readonly cells: number;
  readonly sharedAssets: number;
}

export interface CellMemoryBill {
  readonly key: string;
  readonly uniqueBytes: number;
  /** Full size of shared assets retained by this cell (diagnostic only). */
  readonly sharedBytes: number;
  readonly totalBytes: number;
}

interface SharedRecord {
  readonly category: "geometry" | "texture";
  readonly bytes: number;
  refs: number;
}

interface CellRecord {
  readonly unique: { geometry: number; texture: number; cpu: number };
  readonly sharedIds: readonly string[];
  readonly sharedBytes: number;
}

/** 12 §5.7 thresholds; exported so the streamer and tests share one rule. */
export function pressureStageOf(residentBytes: number, budgetBytes: number): PressureStage {
  requireNonNegative(residentBytes, "residentBytes");
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    throw streamingError("E_STREAM_STATE", "resident budget must be positive");
  }
  if (residentBytes >= budgetBytes) return 3;
  if (residentBytes >= budgetBytes * PRESSURE_STAGE2_FRACTION) return 2;
  if (residentBytes >= budgetBytes * PRESSURE_STAGE1_FRACTION) return 1;
  return 0;
}

/** True below 80%: the streamer may lower `lodBias` after 600 such ticks. */
export function isPressureRecovered(residentBytes: number, budgetBytes: number): boolean {
  if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
    throw streamingError("E_STREAM_STATE", "resident budget must be positive");
  }
  return residentBytes < budgetBytes * PRESSURE_RECOVERY_FRACTION;
}

/**
 * Synchronous per-cell byte ledger. All mutation is O(shared assets per
 * cell); totals are maintained incrementally, never recomputed.
 */
export class MemoryLedger {
  readonly budgetBytes: number;
  private readonly cells = new Map<string, CellRecord>();
  private readonly shared = new Map<string, SharedRecord>();
  private geometry = 0;
  private texture = 0;
  private cpu = 0;

  constructor(budgetBytes: number) {
    if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
      throw streamingError("E_STREAM_STATE", "resident budget must be positive");
    }
    this.budgetBytes = budgetBytes;
  }

  get residentBytes(): number {
    return this.geometry + this.texture + this.cpu;
  }

  get geometryBytes(): number {
    return this.geometry;
  }

  get textureBytes(): number {
    return this.texture;
  }

  get cpuBytes(): number {
    return this.cpu;
  }

  get cellCount(): number {
    return this.cells.size;
  }

  get sharedAssetCount(): number {
    return this.shared.size;
  }

  get pressureStage(): PressureStage {
    return pressureStageOf(this.residentBytes, this.budgetBytes);
  }

  get recovered(): boolean {
    return isPressureRecovered(this.residentBytes, this.budgetBytes);
  }

  has(key: string): boolean {
    return this.cells.has(key);
  }

  /** Adds one resident cell; a duplicate key is a state bug. */
  add(entry: CellMemoryEntry): CellMemoryBill {
    if (this.cells.has(entry.key)) {
      throw streamingError("E_STREAM_STATE", `cell ${entry.key} is already in the ledger`);
    }
    const geometryBytes = requireNonNegative(entry.geometryBytes, "geometryBytes");
    const textureBytes = requireNonNegative(entry.textureBytes, "textureBytes");
    const cpuBytes = requireNonNegative(entry.cpuBytes, "cpuBytes");
    const sharedAssets = entry.sharedAssets ?? [];
    const ids: string[] = [];
    let sharedBytes = 0;
    const seen = new Set<string>();
    for (const asset of sharedAssets) {
      if (typeof asset.id !== "string" || asset.id.length === 0) {
        throw streamingError("E_STREAM_STATE", "shared asset id must be a non-empty string");
      }
      if (seen.has(asset.id)) {
        throw streamingError("E_STREAM_STATE", `cell ${entry.key} lists asset ${asset.id} twice`);
      }
      seen.add(asset.id);
      const bytes = requireNonNegative(asset.bytes, "shared asset bytes");
      sharedBytes += bytes;
      let record = this.shared.get(asset.id);
      if (record === undefined) {
        record = { category: asset.category, bytes, refs: 1 };
        this.shared.set(asset.id, record);
        this.addCategory(asset.category, bytes);
      } else {
        if (record.category !== asset.category || record.bytes !== bytes) {
          throw streamingError(
            "E_STREAM_STATE",
            `shared asset ${asset.id} was declared with a different category or size`,
          );
        }
        record.refs += 1;
      }
      ids.push(asset.id);
    }

    this.geometry += geometryBytes;
    this.texture += textureBytes;
    this.cpu += cpuBytes;
    this.cells.set(entry.key, {
      unique: { geometry: geometryBytes, texture: textureBytes, cpu: cpuBytes },
      sharedIds: ids,
      sharedBytes,
    });
    return {
      key: entry.key,
      uniqueBytes: geometryBytes + textureBytes + cpuBytes,
      sharedBytes,
      totalBytes: geometryBytes + textureBytes + cpuBytes + sharedBytes,
    };
  }

  /** Removes a resident cell; returns false when it was not accounted. */
  remove(key: string): boolean {
    const record = this.cells.get(key);
    if (record === undefined) return false;
    this.cells.delete(key);
    this.geometry -= record.unique.geometry;
    this.texture -= record.unique.texture;
    this.cpu -= record.unique.cpu;
    for (const id of record.sharedIds) {
      const shared = this.shared.get(id);
      if (shared === undefined) continue;
      shared.refs -= 1;
      if (shared.refs === 0) {
        this.addCategory(shared.category, -shared.bytes);
        this.shared.delete(id);
      }
    }
    return true;
  }

  billFor(key: string): CellMemoryBill | undefined {
    const record = this.cells.get(key);
    if (record === undefined) return undefined;
    const uniqueBytes = record.unique.geometry + record.unique.texture + record.unique.cpu;
    return {
      key,
      uniqueBytes,
      sharedBytes: record.sharedBytes,
      totalBytes: uniqueBytes + record.sharedBytes,
    };
  }

  /** True when adding `bytes` would take the ledger above its budget. */
  wouldExceed(bytes: number): boolean {
    return this.residentBytes + requireNonNegative(bytes, "bytes") > this.budgetBytes;
  }

  snapshot(): MemorySnapshot {
    return {
      geometryBytes: this.geometry,
      textureBytes: this.texture,
      cpuBytes: this.cpu,
      residentBytes: this.residentBytes,
      cells: this.cells.size,
      sharedAssets: this.shared.size,
    };
  }

  /** `stop()` clears everything; accounted bytes return to 0. */
  reset(): void {
    this.cells.clear();
    this.shared.clear();
    this.geometry = 0;
    this.texture = 0;
    this.cpu = 0;
  }

  private addCategory(category: "geometry" | "texture", bytes: number): void {
    if (category === "geometry") {
      this.geometry += bytes;
    } else {
      this.texture += bytes;
    }
  }
}

/** The inputs the eviction policy needs about one resident cell. */
export interface EvictionCandidate {
  readonly key: CellKey;
  readonly cx: number;
  readonly cy: number;
  readonly lod: Lod;
  readonly distanceMeters: number;
  readonly pinned: boolean;
  /** Contains a player or is within `playerGuardMeters` of one. */
  readonly guarded: boolean;
  /** Has a simulation payload inside `simRadiusMeters`. */
  readonly inSimRing: boolean;
}

/**
 * Rule 3/4 order: coarsest LOD first, then farthest, then descending
 * `(cx, cy)`. The comparator is total over the fields it uses.
 */
export function comparePressureEviction(a: EvictionCandidate, b: EvictionCandidate): number {
  if (a.lod !== b.lod) return b.lod - a.lod;
  if (a.distanceMeters !== b.distanceMeters) {
    return a.distanceMeters > b.distanceMeters ? -1 : 1;
  }
  if (a.cx !== b.cx) return b.cx - a.cx;
  if (a.cy !== b.cy) return b.cy - a.cy;
  return 0;
}

/**
 * Returns at most `limit` pressure evictions, already ordered. Pinned,
 * guarded and simulation-ring candidates are never returned.
 */
export function selectPressureEvictions(
  candidates: readonly EvictionCandidate[],
  limit = Number.POSITIVE_INFINITY,
): EvictionCandidate[] {
  const eligible = candidates.filter(
    (candidate) => !candidate.pinned && !candidate.guarded && !candidate.inSimRing,
  );
  eligible.sort(comparePressureEviction);
  return eligible.slice(0, Math.max(0, limit));
}

/**
 * Rule 1: cells beyond the unload distance, ascending key order. Pinned
 * cells are absolute and are never returned.
 */
export function selectDistanceEvictions(
  candidates: readonly EvictionCandidate[],
  unloadDistanceMeters: number,
): EvictionCandidate[] {
  return candidates
    .filter((candidate) => !candidate.pinned && candidate.distanceMeters > unloadDistanceMeters)
    .sort((a, b) => {
      if (a.cx !== b.cx) return a.cx - b.cx;
      if (a.cy !== b.cy) return a.cy - b.cy;
      return 0;
    });
}

function requireNonNegative(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw streamingError("E_STREAM_STATE", `${what} must be finite and >= 0`);
  }
  return value;
}

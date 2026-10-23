/**
 * LOD band selection with hysteresis (spec 12 §5.1, §5.3, `src/Lod.ts`).
 *
 * Effective band distance is `band.maxDistanceMeters * (4 - lodBias) / 4`
 * with `lodBias` in [0, 3] (12 §5.3). A higher bias coarsens the rings; it
 * never enlarges one.
 *
 * Promotion to a finer LOD requires `distance < maxDistance - hysteresis`;
 * demotion to a coarser LOD requires `distance > maxDistance + hysteresis`
 * where `maxDistance` is the *boundary being crossed* (the finer band's
 * limit). Inside the dead band the current LOD is kept.
 */

import type { LodBand } from "./contracts/world.js";
import { STREAMING_LIMITS } from "./contracts/world.js";
import { streamingError } from "./StreamEvents.js";

export type Lod = 0 | 1 | 2 | 3;

/** Clamps `lodBias` to [0, 3]; rejects non-finite input instead of guessing. */
export function clampLodBias(bias: number): number {
  if (!Number.isFinite(bias)) {
    throw streamingError("E_STREAM_STATE", "lodBias must be a finite number");
  }
  if (bias <= 0) return 0;
  if (bias >= 3) return 3;
  return bias;
}

/** 12 §5.3: `maxDistance * (4 - bias) / 4`. */
export function effectiveMaxDistance(band: LodBand, bias: number): number {
  return (band.maxDistanceMeters * (4 - clampLodBias(bias))) / 4;
}

/**
 * Finest band whose effective radius still contains `distance`, or undefined
 * when the distance is beyond every band. This is the hysteresis-free answer
 * used for a cell with no previous LOD.
 */
export function bandAtDistance(
  distance: number,
  bands: readonly LodBand[],
  bias: number,
): Lod | undefined {
  assertDistance(distance);
  for (let lod = 0; lod < bands.length; lod += 1) {
    const band = bands[lod];
    if (band === undefined) break;
    if (distance <= effectiveMaxDistance(band, bias)) return band.lod;
  }
  return undefined;
}

/**
 * Selects the LOD for a cell at `distance`, preserving `current` while the
 * distance stays inside the hysteresis dead band.
 *
 * `current === undefined` means the cell has never been resident: the plain
 * band answer is returned (band 3 when beyond every band; the caller decides
 * whether that means "load LOD3" or "unload" via `shouldUnload`).
 */
export function selectLod(
  distance: number,
  current: Lod | undefined,
  bands: readonly LodBand[],
  bias: number,
): Lod {
  assertDistance(distance);
  const clampedBias = clampLodBias(bias);
  if (current === undefined) {
    return bandAtDistance(distance, bands, clampedBias) ?? 3;
  }
  let lod: Lod = current;

  // Demote while past the current band's far edge plus its hysteresis.
  while (lod < 3) {
    const band = bands[lod];
    if (band === undefined) break;
    const limit = effectiveMaxDistance(band, clampedBias) + band.hysteresisMeters;
    if (distance <= limit) break;
    lod = (lod + 1) as Lod;
  }

  // Promote while inside the finer band's near edge minus its hysteresis.
  while (lod > 0) {
    const finer = bands[lod - 1];
    if (finer === undefined) break;
    const limit = effectiveMaxDistance(finer, clampedBias) - finer.hysteresisMeters;
    if (distance >= limit) break;
    lod = (lod - 1) as Lod;
  }

  return lod;
}

/**
 * True when the cell is farther than band 3 + its hysteresis + one cell
 * (12 §5.3) and must therefore be evicted regardless of its applied LOD.
 */
export function shouldUnload(
  distance: number,
  bands: readonly LodBand[],
  bias: number,
  cellSizeMeters: number,
): boolean {
  assertDistance(distance);
  const band = bands[3];
  if (band === undefined) {
    throw streamingError("E_WORLD_LOD_BANDS", "lodBands must contain four bands");
  }
  const limit =
    effectiveMaxDistance(band, bias) + band.hysteresisMeters + cellSizeMeters;
  return distance > limit;
}

/**
 * Validates the four bands at manifest load (12 §3.2): exactly four bands,
 * `lod` 0..3 in order, strictly ascending positive distances, finite
 * non-negative hysteresis smaller than the gap to the next band.
 */
export function validateLodBands(bands: readonly LodBand[]): void {
  if (bands.length !== STREAMING_LIMITS.maxLodBands) {
    throw streamingError(
      "E_WORLD_LOD_BANDS",
      `lodBands must contain exactly ${STREAMING_LIMITS.maxLodBands} entries`,
    );
  }
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    if (band === undefined) {
      throw streamingError("E_WORLD_LOD_BANDS", `lodBands[${index}] is missing`);
    }
    if (band.lod !== index) {
      throw streamingError(
        "E_WORLD_LOD_BANDS",
        `lodBands[${index}].lod must be ${index}`,
      );
    }
    if (!Number.isFinite(band.maxDistanceMeters) || band.maxDistanceMeters <= 0) {
      throw streamingError(
        "E_WORLD_LOD_BANDS",
        `lodBands[${index}].maxDistanceMeters must be positive and finite`,
      );
    }
    if (!Number.isFinite(band.hysteresisMeters) || band.hysteresisMeters < 0) {
      throw streamingError(
        "E_WORLD_LOD_BANDS",
        `lodBands[${index}].hysteresisMeters must be finite and >= 0`,
      );
    }
    const next = bands[index + 1];
    if (next !== undefined) {
      if (next.maxDistanceMeters <= band.maxDistanceMeters) {
        throw streamingError(
          "E_WORLD_LOD_BANDS",
          `lodBands distances must be strictly ascending at index ${index}`,
        );
      }
      const gap = next.maxDistanceMeters - band.maxDistanceMeters;
      if (band.hysteresisMeters >= gap) {
        throw streamingError(
          "E_WORLD_LOD_BANDS",
          `lodBands[${index}].hysteresisMeters must be smaller than the gap to the next band`,
        );
      }
    }
  }
}

function assertDistance(distance: number): void {
  if (!Number.isFinite(distance) || distance < 0) {
    throw streamingError(
      "E_STREAM_STATE",
      `distance must be finite and non-negative: ${String(distance)}`,
    );
  }
}

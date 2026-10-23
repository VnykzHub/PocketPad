/**
 * Scene internals: resolved options, limits and shared constants (spec 03 §4–§5).
 *
 * The public scene types live in `contracts/scene.d.ts` (frozen). This module
 * holds only values that are internal to `src/scene/**`; it is not re-exported
 * from the package entry.
 */

import type { SceneOptions } from "../contracts/scene.js";

/** Default slot capacity for a new scene (03 §3.5). */
export const DEFAULT_INITIAL_CAPACITY = 256;
/** Smallest capacity a scene may allocate. */
export const MIN_INITIAL_CAPACITY = 16;
/** Hard cap for both `initialCapacity` and `maxEntities`. */
export const MAX_ENTITIES_LIMIT = 1_048_576;

export const DEFAULT_MAX_HIERARCHY_DEPTH = 64;
export const MIN_MAX_HIERARCHY_DEPTH = 1;
export const MAX_MAX_HIERARCHY_DEPTH = 256;

/** 03 §4.1: snapshot limits. */
export const MAX_SNAPSHOT_ENTITIES = 65_536;
export const MAX_PREFAB_ENTITIES = 1_024;
export const MAX_COMPONENTS_PER_ENTITY = 64;
export const SCENE_FORMAT_VERSION = 1;

/** `^[a-z][a-z0-9_.-]{0,63}$` — component names (03 §3.2, §4.1). */
export const COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
/** `^[a-z0-9][a-z0-9/_.-]{0,63}$` — prefab ids (03 §3.8). */
export const PREFAB_ID_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,63}$/;
/** `^[a-z0-9][a-z0-9/_.-]{0,127}$` — asset ids (03 §4.1). */
export const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9/_.-]{0,127}$/;

/** Per-slot flag bits (03 §5.2). */
export const FLAG_HAS_WORLD = 1;
export const FLAG_LOCAL_DIRTY = 2;
export const FLAG_WORLD_DIRTY = 4;

/** Mutable dev/contract counters reported by `getStats` (03 §3.10). */
export interface SceneCounters {
  staleHandleCount: number;
  dirtyReadCount: number;
  rejectedOperationCount: number;
}

export interface ResolvedSceneOptions {
  readonly initialCapacity: number;
  readonly maxEntities: number;
  readonly maxHierarchyDepth: number;
  readonly devChecks: boolean;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Applies the documented clamps of `SceneOptions` (03 §3.5). */
export function resolveSceneOptions(options?: SceneOptions): ResolvedSceneOptions {
  const maxEntities = clampInteger(
    options?.maxEntities ?? MAX_ENTITIES_LIMIT,
    MIN_INITIAL_CAPACITY,
    MAX_ENTITIES_LIMIT,
  );
  const initialCapacity = Math.min(
    clampInteger(
      options?.initialCapacity ?? DEFAULT_INITIAL_CAPACITY,
      MIN_INITIAL_CAPACITY,
      MAX_ENTITIES_LIMIT,
    ),
    maxEntities,
  );
  const maxHierarchyDepth = clampInteger(
    options?.maxHierarchyDepth ?? DEFAULT_MAX_HIERARCHY_DEPTH,
    MIN_MAX_HIERARCHY_DEPTH,
    MAX_MAX_HIERARCHY_DEPTH,
  );
  return {
    initialCapacity,
    maxEntities,
    maxHierarchyDepth,
    devChecks: options?.devChecks === true,
  };
}

/** UTF-8 byte length without allocating an encoder (03 §4.1 `name.value`). */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: a valid pair is 4 bytes, a lone one encodes as 3.
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Integer index in `[0, maxExclusive)`. */
export function isIndex(value: unknown, maxExclusive: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < maxExclusive
  );
}

/** True for a JSON-style plain object (not null, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finite JSON number check (03 §4.1). */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Normalizes `-0` to `0` for the serializer (03 §4.1). */
export function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * Cache-key builder and LRU policy (spec 12 §5.7, `src/Cache.ts`).
 *
 * Keys are `${worldId}/v${CELL_FORMAT_VERSION}/${payloadHash}/${name}`.
 * `payloadHash` is the manifest `contentHash` of the cell (all LODs plus the
 * simulation payload), so a deploy that changes any payload cannot serve a
 * stale entry. `name` is the payload file name (`v0.cell` … `v3.cell`,
 * `sim.cell`).
 *
 * This module never imports CacheStorage. `CellCache` is the runtime's
 * adapter; every storage failure is swallowed because caching is an
 * optimisation and never a correctness dependency. Recency lives in this
 * index (`lastUsedTick` plus a monotonic sequence), not in the persistent
 * store.
 */

import type { CellCache } from "./contracts/world.js";
import { CELL_FORMAT_VERSION } from "./contracts/world.js";
import { CONTENT_HASH_PATTERN, WORLD_ID_PATTERN } from "./WorldIndex.js";
import { streamingError } from "./StreamEvents.js";

const PAYLOAD_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Builds the cache key from 12 §5.7; rejects anything path-unsafe. */
export function buildCacheKey(worldId: string, contentHash: string, name: string): string {
  if (!WORLD_ID_PATTERN.test(worldId)) {
    throw streamingError("E_STREAM_STATE", `invalid worldId for a cache key: ${worldId}`);
  }
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw streamingError("E_STREAM_STATE", `invalid contentHash for a cache key: ${contentHash}`);
  }
  if (!PAYLOAD_NAME_PATTERN.test(name) || name.includes("..")) {
    throw streamingError("E_STREAM_STATE", `invalid payload name for a cache key: ${name}`);
  }
  return `${worldId}/v${CELL_FORMAT_VERSION}/${contentHash}/${name}`;
}

interface LruEntry {
  bytes: number;
  lastUsedTick: number;
  sequence: number;
}

/**
 * In-memory LRU metadata. Pure policy: it never stores payload bytes and
 * never performs I/O. `lastUsedTick` is the caller's tick, which keeps trim
 * decisions deterministic in tests.
 */
export class LruIndex {
  readonly capacityBytes: number;
  private readonly entries = new Map<string, LruEntry>();
  private sequence = 0;
  private bytes = 0;

  constructor(capacityBytes: number) {
    if (!Number.isFinite(capacityBytes) || capacityBytes < 0) {
      throw streamingError("E_STREAM_STATE", "cache capacity must be finite and >= 0");
    }
    this.capacityBytes = capacityBytes;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  bytesOf(key: string): number | undefined {
    return this.entries.get(key)?.bytes;
  }

  /** Records a hit or a completed put. */
  touch(key: string, bytes: number, tick: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw streamingError("E_STREAM_STATE", "cache entry size must be finite and >= 0");
    }
    if (!Number.isFinite(tick)) {
      throw streamingError("E_STREAM_STATE", "cache tick must be finite");
    }
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.bytes += bytes - existing.bytes;
      existing.bytes = bytes;
      existing.lastUsedTick = tick;
      this.sequence += 1;
      existing.sequence = this.sequence;
      return;
    }
    this.sequence += 1;
    this.entries.set(key, { bytes, lastUsedTick: tick, sequence: this.sequence });
    this.bytes += bytes;
  }

  remove(key: string): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  /**
   * Keys to delete, least recently used first, so that
   * `totalBytes + incomingBytes <= capacityBytes`. When the incoming entry
   * alone exceeds the capacity, every existing entry is returned.
   */
  planTrim(incomingBytes: number): string[] {
    if (!Number.isFinite(incomingBytes) || incomingBytes < 0) {
      throw streamingError("E_STREAM_STATE", "incoming cache size must be finite and >= 0");
    }
    if (this.bytes + incomingBytes <= this.capacityBytes) return [];
    if (incomingBytes > this.capacityBytes) {
      return this.orderedKeys();
    }
    const victims: string[] = [];
    let remaining = this.bytes;
    for (const key of this.orderedKeys()) {
      if (remaining + incomingBytes <= this.capacityBytes) break;
      const entry = this.entries.get(key);
      if (entry === undefined) continue;
      victims.push(key);
      remaining -= entry.bytes;
    }
    return victims;
  }

  private orderedKeys(): string[] {
    return [...this.entries.entries()]
      .sort((a, b) => {
        if (a[1].lastUsedTick !== b[1].lastUsedTick) {
          return a[1].lastUsedTick - b[1].lastUsedTick;
        }
        return a[1].sequence - b[1].sequence;
      })
      .map(([key]) => key);
  }
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly writes: number;
  readonly failures: number;
  readonly evictions: number;
}

export interface CellCacheStoreOptions {
  readonly worldId: string;
  readonly budgetBytes: number;
  readonly enabled: boolean;
}

/**
 * Cache facade over a runtime-supplied `CellCache`. Every operation is
 * best-effort: a rejection is counted and swallowed, and the caller falls
 * back to the network.
 */
export class CellCacheStore {
  private readonly cache: CellCache;
  private readonly options: CellCacheStoreOptions;
  private readonly lru: LruIndex;
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private failures = 0;
  private evictions = 0;

  constructor(cache: CellCache, options: CellCacheStoreOptions) {
    this.cache = cache;
    this.options = options;
    this.lru = new LruIndex(options.budgetBytes);
  }

  get enabled(): boolean {
    return this.options.enabled && this.options.budgetBytes > 0;
  }

  get index(): LruIndex {
    return this.lru;
  }

  get stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      failures: this.failures,
      evictions: this.evictions,
    };
  }

  keyFor(contentHash: string, name: string): string {
    return buildCacheKey(this.options.worldId, contentHash, name);
  }

  async get(
    contentHash: string,
    name: string,
    tick: number,
  ): Promise<ArrayBuffer | undefined> {
    if (!this.enabled) return undefined;
    const key = this.keyFor(contentHash, name);
    try {
      const bytes = await this.cache.get(key);
      if (bytes === undefined) {
        this.misses += 1;
        this.lru.remove(key);
        return undefined;
      }
      this.hits += 1;
      this.lru.touch(key, bytes.byteLength, tick);
      return bytes;
    } catch {
      this.failures += 1;
      this.lru.remove(key);
      return undefined;
    }
  }

  async put(
    contentHash: string,
    name: string,
    bytes: ArrayBuffer,
    tick: number,
  ): Promise<void> {
    if (!this.enabled) return;
    if (bytes.byteLength > this.options.budgetBytes) return;
    const key = this.keyFor(contentHash, name);
    try {
      const victims = this.lru.planTrim(bytes.byteLength);
      for (const victim of victims) {
        await this.cache.delete(victim);
        this.lru.remove(victim);
        this.evictions += 1;
      }
      await this.cache.put(key, bytes);
      this.lru.touch(key, bytes.byteLength, tick);
      this.writes += 1;
    } catch {
      this.failures += 1;
    }
  }

  /** Boot and every 600 ticks (12 §5.7); returns the number of deletions. */
  async trim(): Promise<number> {
    if (!this.enabled) return 0;
    const victims = this.lru.planTrim(0);
    let deleted = 0;
    for (const victim of victims) {
      try {
        await this.cache.delete(victim);
        deleted += 1;
      } catch {
        this.failures += 1;
      }
      this.lru.remove(victim);
      this.evictions += 1;
    }
    return deleted;
  }
}

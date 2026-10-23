/**
 * LRU pipeline cache (04 §4.2, §5.5).
 *
 * Cache entries carry either a value or a failure marker. Failed compilation
 * is cached so a frame does not retry the same invalid descriptor. Eviction
 * is reported to the device, which destroys the GPU pipeline at the frame
 * boundary.
 */

import type { PipelineCacheKey } from "../contracts/webgpu.js";

export interface PipelineCacheSuccess<T> {
  readonly key: PipelineCacheKey;
  readonly value: T;
  readonly failure: null;
}

export interface PipelineCacheFailure {
  readonly key: PipelineCacheKey;
  readonly value: null;
  readonly failure: string;
}

export type PipelineCacheEntry<T> =
  | PipelineCacheSuccess<T>
  | PipelineCacheFailure;

export interface PipelineCacheOptions<T> {
  readonly capacity?: number;
  readonly onEvict?: (entry: PipelineCacheEntry<T>) => void;
}

export class PipelineCache<T> {
  private readonly capacity: number;
  private readonly entries = new Map<string, PipelineCacheEntry<T>>();
  private readonly onEvict: ((entry: PipelineCacheEntry<T>) => void) | null;

  constructor(options?: PipelineCacheOptions<T>) {
    this.capacity = Math.max(1, Math.floor(options?.capacity ?? 256));
    this.onEvict = options?.onEvict ?? null;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: PipelineCacheKey): PipelineCacheEntry<T> | undefined {
    const entry = this.entries.get(key.canonical);
    if (entry === undefined) {
      return undefined;
    }
    // Map insertion order is the LRU order.
    this.entries.delete(key.canonical);
    this.entries.set(key.canonical, entry);
    return entry;
  }

  has(key: PipelineCacheKey): boolean {
    return this.entries.has(key.canonical);
  }

  set(key: PipelineCacheKey, value: T): PipelineCacheSuccess<T> {
    return this.insert({
      key,
      value,
      failure: null,
    });
  }

  setFailure(key: PipelineCacheKey, failure: string): PipelineCacheFailure {
    return this.insert({
      key,
      value: null,
      failure,
    });
  }

  delete(key: PipelineCacheKey): boolean {
    return this.entries.delete(key.canonical);
  }

  clear(): void {
    this.entries.clear();
  }

  private insert<TEntry extends PipelineCacheEntry<T>>(
    entry: TEntry,
  ): TEntry {
    this.entries.delete(entry.key.canonical);
    while (this.entries.size >= this.capacity) {
      let oldestKey: string | undefined;
      for (const key of this.entries.keys()) {
        oldestKey = key;
        break;
      }
      if (oldestKey === undefined) {
        break;
      }
      const evicted = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (evicted !== undefined) {
        this.onEvict?.(evicted);
      }
    }
    this.entries.set(entry.key.canonical, entry);
    return entry;
  }
}

/**
 * Test doubles for `CellCache` (spec 12 cache policy).
 *
 * `RecordingCache` counts every call and can be knocked over with
 * `failAlways`, which is how the streamer's "cache failures never fail a
 * load" rule gets exercised without a real CacheStorage.
 */

import type { CellCache } from "../../src/index.js";

export class RecordingCache implements CellCache {
  readonly entries = new Map<string, ArrayBuffer>();
  readonly gets: string[] = [];
  readonly puts: string[] = [];
  readonly deletes: string[] = [];
  readonly keyCalls: string[] = [];
  failAlways = false;

  constructor(seed?: ReadonlyMap<string, ArrayBuffer>) {
    if (seed !== undefined) {
      for (const [key, value] of seed) this.entries.set(key, value.slice(0));
    }
  }

  get getCalls(): number {
    return this.gets.length;
  }

  get putCalls(): number {
    return this.puts.length;
  }

  get deleteCalls(): number {
    return this.deletes.length;
  }

  /** Fraction of `get` calls that returned bytes; NaN before any get. */
  get hitRate(): number {
    if (this.gets.length === 0) return Number.NaN;
    let hits = 0;
    for (const key of this.gets) {
      if (this.entries.has(key)) hits += 1;
    }
    return hits / this.gets.length;
  }

  async get(key: string): Promise<ArrayBuffer | undefined> {
    this.gets.push(key);
    if (this.failAlways) throw new Error("cache unavailable");
    const value = this.entries.get(key);
    return value === undefined ? undefined : value.slice(0);
  }

  async put(key: string, value: ArrayBuffer): Promise<void> {
    this.puts.push(key);
    if (this.failAlways) throw new Error("cache unavailable");
    this.entries.set(key, value.slice(0));
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (this.failAlways) throw new Error("cache unavailable");
    this.entries.delete(key);
  }

  async keys(): Promise<readonly string[]> {
    this.keyCalls.push("keys");
    if (this.failAlways) throw new Error("cache unavailable");
    return [...this.entries.keys()];
  }

  /** Synchronous snapshot used to assert what a run left behind. */
  snapshot(): Map<string, ArrayBuffer> {
    const copy = new Map<string, ArrayBuffer>();
    for (const [key, value] of this.entries) copy.set(key, value);
    return copy;
  }
}

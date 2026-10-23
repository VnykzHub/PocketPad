/**
 * Generational handle table and deferred-destroy bookkeeping (05 §4.6,
 * 00 §3.2).
 *
 * A handle is `{ index, generation }`. Generations never repeat for a slot, so
 * a stale handle can never alias a newly created resource. The table stores
 * only CPU records; GL deletion is the device's deferred step.
 */

export interface TableEntry<T> {
  readonly record: T;
  readonly generation: number;
  destroyed: boolean;
}

export interface CreatedSlot {
  readonly index: number;
  readonly generation: number;
}

export class HandleTable<T> {
  private entries: Array<TableEntry<T> | null> = [];
  private readonly free: number[] = [];

  create(record: T): CreatedSlot {
    const reused = this.free.pop();
    if (reused === undefined) {
      const index = this.entries.length;
      this.entries.push({ record, generation: 1, destroyed: false });
      return { index, generation: 1 };
    }
    const previous = this.entries[reused];
    const generation = previous === undefined || previous === null ? 1 : previous.generation + 1;
    this.entries[reused] = { record, generation, destroyed: false };
    return { index: reused, generation };
  }

  /** Live record for a handle, or null for stale/unknown/destroyed handles. */
  resolve(index: number, generation: number): T | null {
    const entry = this.entries[index];
    if (entry === undefined || entry === null) return null;
    if (entry.generation !== generation || entry.destroyed) return null;
    return entry.record;
  }

  /** The entry a handle names, including its destroyed flag. */
  entry(index: number, generation: number): TableEntry<T> | null {
    const entry = this.entries[index];
    if (entry === undefined || entry === null) return null;
    if (entry.generation !== generation) return null;
    return entry;
  }

  /** Marks a live handle destroyed and returns its record for GL cleanup. */
  markDestroyed(index: number, generation: number): T | null {
    const entry = this.entries[index];
    if (entry === undefined || entry === null) return null;
    if (entry.generation !== generation || entry.destroyed) return null;
    entry.destroyed = true;
    this.free.push(index);
    return entry.record;
  }

  /** Restore hook: every record that is still live. Allocation is fine here. */
  live(): Array<{ index: number; generation: number; record: T }> {
    const result: Array<{ index: number; generation: number; record: T }> = [];
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry === undefined || entry === null || entry.destroyed) continue;
      result.push({ index, generation: entry.generation, record: entry.record });
    }
    return result;
  }

  /** Device dispose: returns every live record and empties the table. */
  drain(): T[] {
    const result: T[] = [];
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry === undefined || entry === null || entry.destroyed) continue;
      entry.destroyed = true;
      result.push(entry.record);
    }
    this.entries = [];
    this.free.length = 0;
    return result;
  }

  get size(): number {
    let count = 0;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      if (entry !== undefined && entry !== null && !entry.destroyed) count += 1;
    }
    return count;
  }
}

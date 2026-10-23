/**
 * Content packs (spec 24 §2.4; ER-24-04).
 *
 * A pack is a deterministic shuffle of caller-owned content. The same seed
 * always yields the same order, and `draw` wraps around the deck instead of
 * reshuffling. No `Math.random` is used anywhere.
 */
import { requireFinite } from "./slots.js";

export interface PackOptions<T> {
  readonly seed: number;
  readonly validate?: (value: unknown) => value is T;
}

export interface Pack<T> {
  readonly size: number;
  /** Draws without replacement; wraps when exhausted. Deterministic per seed. */
  draw(): T;
  drawUnique(count: number): T[];
  reset(): void;
}

/** mulberry32: small, fast, deterministic and dependency-free. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class PackState<T> implements Pack<T> {
  readonly size: number;
  private readonly source: readonly T[];
  private readonly seed: number;
  private order: T[];
  private readonly result: T[];
  private cursor = 0;

  constructor(items: readonly T[], options: PackOptions<T>) {
    requireFinite(options.seed, "seed");
    if (!Array.isArray(items) || items.length === 0) {
      throw new RangeError("createPack requires a non-empty items array.");
    }
    const validate = options.validate;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) {
        throw new TypeError(`Pack item at index ${index} is undefined.`);
      }
      if (validate !== undefined && !validate(item)) {
        throw new TypeError(`Pack item at index ${index} failed validation.`);
      }
    }
    this.source = items;
    this.size = items.length;
    this.seed = options.seed;
    this.order = items.slice();
    // One buffer, resized with `length`; drawUnique allocates nothing later.
    this.result = new Array<T>(this.size);
    this.shuffle();
  }

  draw(): T {
    const item = this.order[this.cursor];
    if (item === undefined) {
      // Unreachable: order is fully populated and non-empty.
      throw new Error("Pack order is empty.");
    }
    this.cursor = (this.cursor + 1) % this.size;
    return item;
  }

  drawUnique(count: number): T[] {
    if (!Number.isInteger(count) || count < 0 || count > this.size) {
      throw new RangeError(`count must be an integer in 0..${this.size}.`);
    }
    const result = this.result;
    for (let offset = 0; offset < count; offset += 1) {
      const item = this.order[(this.cursor + offset) % this.size];
      if (item === undefined) {
        throw new Error("Pack order is empty.");
      }
      result[offset] = item;
    }
    result.length = count;
    this.cursor = (this.cursor + count) % this.size;
    return result;
  }

  reset(): void {
    this.order = this.source.slice();
    this.result.length = this.size;
    this.cursor = 0;
    this.shuffle();
  }

  private shuffle(): void {
    const random = mulberry32(this.seed);
    const order = this.order;
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      const current = order[index];
      const other = order[swap];
      if (current === undefined || other === undefined) {
        throw new Error("Pack order is empty.");
      }
      order[index] = other;
      order[swap] = current;
    }
  }
}

/** Creates a shuffled pack; validates items and the seed eagerly. */
export function createPack<T>(items: readonly T[], options: PackOptions<T>): Pack<T> {
  return new PackState(items, options);
}

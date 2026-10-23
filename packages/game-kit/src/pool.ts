/**
 * Object pools (spec 24 §2.5; ER-24-05).
 *
 * Every item is created once, up front. Acquire and release then swap indices
 * on preallocated typed arrays; nothing on the warm path allocates.
 * Releasing a foreign or already-free item is ignored and counted.
 */

/** Thrown when every pooled item is already acquired. */
export class PoolExhaustedError extends Error {
  readonly code = "E_POOL_EXHAUSTED";

  constructor(capacity: number) {
    super(`E_POOL_EXHAUSTED: all ${capacity} pooled items are in use.`);
    this.name = "PoolExhaustedError";
  }
}

export interface Pool<T> {
  acquire(): T;
  release(item: T): void;
  readonly active: number;
  readonly capacity: number;
  forEachActive(fn: (item: T) => void): void;
  clear(): void;
  /** Additive (spec 24 §2.5): ignored foreign/double releases, cumulative. */
  readonly ignoredReleases: number;
}

class PoolState<T> implements Pool<T> {
  readonly capacity: number;
  private readonly items: T[];
  private readonly freeStack: Int32Array;
  private readonly inUse: Uint8Array;
  private readonly reset: (item: T) => void;
  private top: number;
  private activeCount = 0;
  private ignored = 0;

  constructor(create: () => T, reset: (item: T) => void, capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError("capacity must be a non-negative integer.");
    }
    this.capacity = capacity;
    this.reset = reset;
    this.items = new Array<T>(capacity);
    for (let index = 0; index < capacity; index += 1) {
      const item = create();
      if (item === undefined) {
        throw new TypeError("Pool create() returned undefined.");
      }
      this.items[index] = item;
    }
    this.freeStack = new Int32Array(capacity);
    for (let index = 0; index < capacity; index += 1) {
      this.freeStack[index] = index;
    }
    this.top = capacity;
    this.inUse = new Uint8Array(capacity);
  }

  get active(): number {
    return this.activeCount;
  }

  get ignoredReleases(): number {
    return this.ignored;
  }

  acquire(): T {
    if (this.top === 0) {
      throw new PoolExhaustedError(this.capacity);
    }
    this.top -= 1;
    const index = this.freeStack[this.top];
    const item = index === undefined ? undefined : this.items[index];
    if (index === undefined || item === undefined) {
      throw new Error("Pool free stack is corrupt.");
    }
    this.inUse[index] = 1;
    this.activeCount += 1;
    return item;
  }

  release(item: T): void {
    const index = this.indexOf(item);
    if (index < 0) {
      this.ignored += 1;
      return;
    }
    this.reset(item);
    this.inUse[index] = 0;
    this.freeStack[this.top] = index;
    this.top += 1;
    this.activeCount -= 1;
  }

  forEachActive(fn: (item: T) => void): void {
    for (let index = 0; index < this.capacity; index += 1) {
      if (this.inUse[index] === 1) {
        const item = this.items[index];
        if (item !== undefined) {
          fn(item);
        }
      }
    }
  }

  clear(): void {
    for (let index = 0; index < this.capacity; index += 1) {
      if (this.inUse[index] === 1) {
        const item = this.items[index];
        if (item !== undefined) {
          this.reset(item);
        }
      }
      this.inUse[index] = 0;
      this.freeStack[index] = index;
    }
    this.top = this.capacity;
    this.activeCount = 0;
  }

  /** Linear identity scan; capacity is small and release rate is low. */
  private indexOf(item: T): number {
    for (let index = 0; index < this.capacity; index += 1) {
      if (this.inUse[index] === 1 && this.items[index] === item) {
        return index;
      }
    }
    return -1;
  }
}

/** Creates a pool whose items all exist before the first acquire. */
export function createPool<T>(
  create: () => T,
  reset: (item: T) => void,
  capacity: number,
): Pool<T> {
  return new PoolState(create, reset, capacity);
}

/**
 * Sparse-set component storage (spec 03 §5.3).
 *
 * One store per registered type, created lazily. `add` replaces in place;
 * `remove` is swap-remove. `column` returns a cached view whose arrays always
 * reflect the live store, so a reader may hold one across unrelated mutations
 * (the documented invalidation window is the structural mutation itself).
 */

import type { ComponentColumn, ComponentType, Entity } from "../contracts/scene.js";
import type { EntityAllocator } from "./EntityAllocator.js";

const INITIAL_DENSE_CAPACITY = 16;

function nextPowerOfTwo(value: number): number {
  if (value <= INITIAL_DENSE_CAPACITY) return INITIAL_DENSE_CAPACITY;
  let capacity = INITIAL_DENSE_CAPACITY;
  while (capacity < value) capacity *= 2;
  return capacity;
}

class ColumnView<T> implements ComponentColumn<T> {
  constructor(private readonly store: ComponentStore<T>) {}

  get type(): ComponentType<T> {
    return this.store.type;
  }

  get entityIds(): Uint32Array {
    return this.store.entityIds;
  }

  get values(): readonly T[] {
    return this.store.values as unknown as readonly T[];
  }

  get count(): number {
    return this.store.count;
  }

  get enabled(): Uint8Array {
    return this.store.allocator.enabled;
  }
}

export class ComponentStore<T> {
  readonly type: ComponentType<T>;
  readonly allocator: EntityAllocator;

  entityIds: Uint32Array;
  values: (T | undefined)[];
  sparse: Int32Array;
  count = 0;

  private readonly columnView: ColumnView<T>;

  constructor(type: ComponentType<T>, allocator: EntityAllocator) {
    this.type = type;
    this.allocator = allocator;
    this.entityIds = new Uint32Array(INITIAL_DENSE_CAPACITY);
    this.values = new Array<T | undefined>(INITIAL_DENSE_CAPACITY);
    this.sparse = new Int32Array(allocator.capacity).fill(-1);
    this.columnView = new ColumnView(this);
  }

  /** Called after the entity allocator grows its capacity. */
  ensureSparseCapacity(capacity: number): void {
    if (this.sparse.length >= capacity) return;
    const next = new Int32Array(capacity).fill(-1);
    next.set(this.sparse);
    this.sparse = next;
  }

  private growDense(): void {
    const capacity = this.entityIds.length * 2;
    const ids = new Uint32Array(capacity);
    ids.set(this.entityIds);
    const values = new Array<T | undefined>(capacity);
    for (let index = 0; index < this.count; index += 1) values[index] = this.values[index];
    this.entityIds = ids;
    this.values = values;
  }

  /** Returns the dense row for `id`, or -1. Verifies the sparse back-pointer. */
  rowOf(id: number): number {
    if (id < 0 || id >= this.sparse.length) return -1;
    const row = this.sparse[id]!;
    if (row < 0 || row >= this.count) return -1;
    if (this.entityIds[row] !== id) return -1;
    return row;
  }

  has(id: number): boolean {
    return this.rowOf(id) >= 0;
  }

  get(id: number): T | undefined {
    const row = this.rowOf(id);
    return row < 0 ? undefined : this.values[row];
  }

  add(id: number, value: T, entity: Entity): void {
    const row = this.rowOf(id);
    if (row >= 0) {
      const previous = this.values[row];
      if (previous !== undefined) this.type.onRemove?.(previous, entity);
      this.values[row] = value;
      return;
    }
    if (this.count === this.entityIds.length) this.growDense();
    const appendRow = this.count;
    this.sparse[id] = appendRow;
    this.entityIds[appendRow] = id;
    this.values[appendRow] = value;
    this.count = appendRow + 1;
  }

  remove(id: number, entity: Entity): boolean {
    const row = this.rowOf(id);
    if (row < 0) return false;
    const removed = this.values[row];
    const lastRow = this.count - 1;
    if (row !== lastRow) {
      const movedId = this.entityIds[lastRow]!;
      this.entityIds[row] = movedId;
      this.values[row] = this.values[lastRow];
      this.sparse[movedId] = row;
    }
    this.values[lastRow] = undefined;
    this.entityIds[lastRow] = 0;
    this.count = lastRow;
    this.sparse[id] = -1;
    if (removed !== undefined) this.type.onRemove?.(removed, entity);
    return true;
  }

  column(): ComponentColumn<T> {
    return this.columnView;
  }

  /** Preallocates dense storage; cold path (03 §3.5). */
  reserve(capacity: number): void {
    this.ensureSparseCapacity(this.allocator.capacity);
    if (capacity <= this.entityIds.length) return;
    const size = nextPowerOfTwo(capacity);
    const ids = new Uint32Array(size);
    ids.set(this.entityIds.subarray(0, this.count));
    const values = new Array<T | undefined>(size);
    for (let index = 0; index < this.count; index += 1) values[index] = this.values[index];
    this.entityIds = ids;
    this.values = values;
  }

  /** Sorts rows by entity id and trims capacity; cold path (03 §5.3). */
  compact(): void {
    const capacity = nextPowerOfTwo(this.count);
    const ids = new Uint32Array(capacity);
    const values = new Array<T | undefined>(capacity);
    const sparse = new Int32Array(this.sparse.length).fill(-1);
    let row = 0;
    const limit = this.allocator.nextId;
    for (let id = 0; id < limit; id += 1) {
      const oldRow = this.rowOf(id);
      if (oldRow < 0) continue;
      sparse[id] = row;
      ids[row] = id;
      values[row] = this.values[oldRow];
      row += 1;
    }
    this.entityIds = ids;
    this.values = values;
    this.sparse = sparse;
    this.count = row;
  }

  approxBytes(): number {
    return this.entityIds.length * 4 + this.values.length * 8 + this.sparse.length * 4;
  }
}

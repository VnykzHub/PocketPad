/**
 * Query driver selection (spec 03 §3.6, §5.4).
 *
 * Chooses the smallest column as driver (earliest argument breaks ties) and
 * checks the other requested types through their sparse arrays. `Parent` has
 * no column, so a query that requests it falls back to an ascending-id scan.
 * No function here allocates or uses a callback.
 */

import type { ComponentType, Entity } from "../contracts/scene.js";
import type { ComponentStore } from "./ComponentStore.js";
import type { EntityAllocator } from "./EntityAllocator.js";

const PARENT_TYPE_ID = 2;

function storeFor(
  stores: readonly (ComponentStore<unknown> | undefined)[],
  type: ComponentType<unknown>,
): ComponentStore<unknown> | undefined {
  return type.id < stores.length ? stores[type.id] : undefined;
}

function matchesType(
  allocator: EntityAllocator,
  stores: readonly (ComponentStore<unknown> | undefined)[],
  id: number,
  type: ComponentType<unknown>,
): boolean {
  if (type.id === PARENT_TYPE_ID) return allocator.parent[id]! !== -1;
  const store = storeFor(stores, type);
  return store !== undefined && store.rowOf(id) >= 0;
}

function matchesAll(
  allocator: EntityAllocator,
  stores: readonly (ComponentStore<unknown> | undefined)[],
  id: number,
  types: readonly ComponentType<unknown>[],
): boolean {
  for (let index = 0; index < types.length; index += 1) {
    if (!matchesType(allocator, stores, id, types[index]!)) return false;
  }
  return true;
}

/**
 * Runs a query. When `out` is null nothing is appended (queryCount).
 * Returns the number of matches.
 */
export function runQuery(
  allocator: EntityAllocator,
  stores: readonly (ComponentStore<unknown> | undefined)[],
  types: readonly ComponentType<unknown>[],
  out: Entity[] | null,
  includeDisabled: boolean,
): number {
  if (out !== null) out.length = 0;

  if (types.length === 0) {
    let count = 0;
    for (let id = 0; id < allocator.nextId; id += 1) {
      if (allocator.alive[id] !== 1) continue;
      if (!includeDisabled && allocator.enabled[id] !== 1) continue;
      if (out !== null) out.push(allocator.handles[id]!);
      count += 1;
    }
    return count;
  }

  let requiresScan = false;
  let driver: ComponentStore<unknown> | undefined;
  for (let index = 0; index < types.length; index += 1) {
    const type = types[index]!;
    if (type.id === PARENT_TYPE_ID) {
      requiresScan = true;
      continue;
    }
    const store = storeFor(stores, type);
    if (store === undefined) return 0;
    if (driver === undefined || store.count < driver.count) driver = store;
  }

  if (requiresScan) {
    let count = 0;
    for (let id = 0; id < allocator.nextId; id += 1) {
      if (allocator.alive[id] !== 1) continue;
      if (!includeDisabled && allocator.enabled[id] !== 1) continue;
      if (!matchesAll(allocator, stores, id, types)) continue;
      if (out !== null) out.push(allocator.handles[id]!);
      count += 1;
    }
    return count;
  }

  if (driver === undefined || driver.count === 0) return 0;

  let count = 0;
  const rows = driver.count;
  for (let row = 0; row < rows; row += 1) {
    const id = driver.entityIds[row]!;
    if (allocator.alive[id] !== 1) continue;
    if (!includeDisabled && allocator.enabled[id] !== 1) continue;
    if (!matchesAll(allocator, stores, id, types)) continue;
    if (out !== null) out.push(allocator.handles[id]!);
    count += 1;
  }
  return count;
}

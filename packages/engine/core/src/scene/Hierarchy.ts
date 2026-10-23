/**
 * Hierarchy storage (spec 03 §3.7, §5.5).
 *
 * A forest held in five Int32Arrays on the allocator. Child lists are
 * doubly-linked so unlink is O(1) and insertion order is preserved. All
 * traversal helpers are iterative and use the allocator's scratch arrays; no
 * function here allocates.
 */

import type { Entity } from "../contracts/scene.js";
import type { EntityAllocator } from "./EntityAllocator.js";

/** Removes `id` from its parent's child list; no-op for a root. */
export function unlinkFromParent(allocator: EntityAllocator, id: number): void {
  const parent = allocator.parent[id]!;
  if (parent === -1) return;
  const prev = allocator.prevSibling[id]!;
  const next = allocator.nextSibling[id]!;
  if (prev !== -1) allocator.nextSibling[prev] = next;
  else allocator.firstChild[parent] = next;
  if (next !== -1) allocator.prevSibling[next] = prev;
  else allocator.lastChild[parent] = prev;
  allocator.parent[id] = -1;
  allocator.prevSibling[id] = -1;
  allocator.nextSibling[id] = -1;
}

/** Appends `childId` to `parentId`'s child list. Caller validates first. */
export function appendChild(
  allocator: EntityAllocator,
  childId: number,
  parentId: number,
): void {
  const last = allocator.lastChild[parentId]!;
  allocator.parent[childId] = parentId;
  allocator.prevSibling[childId] = last;
  allocator.nextSibling[childId] = -1;
  if (last === -1) allocator.firstChild[parentId] = childId;
  else allocator.nextSibling[last] = childId;
  allocator.lastChild[parentId] = childId;
}

/** True when `id` is `ancestorId` or lies in its subtree. */
export function isAncestorOrSelf(
  allocator: EntityAllocator,
  ancestorId: number,
  id: number,
): boolean {
  let current = id;
  let guard = 0;
  while (current !== -1 && guard <= allocator.nextId) {
    if (current === ancestorId) return true;
    current = allocator.parent[current]!;
    guard += 1;
  }
  return false;
}

/** Root depth is 1 (03 §3.7). */
export function depthOf(allocator: EntityAllocator, id: number): number {
  let depth = 1;
  let current = allocator.parent[id]!;
  let guard = 0;
  while (current !== -1 && guard <= allocator.nextId) {
    depth += 1;
    current = allocator.parent[current]!;
    guard += 1;
  }
  return depth;
}

/**
 * Number of nodes on the longest path from `id` down to a leaf (leaf = 1).
 * Computed post-order into `allocator.heightDepth`, which is scratch.
 */
export function subtreeHeight(allocator: EntityAllocator, id: number): number {
  const order = allocator.postOrder;
  const count = collectPostOrder(allocator, id, order);
  const depths = allocator.heightDepth;
  for (let index = 0; index < count; index += 1) {
    const node = order[index]!;
    let height = 1;
    for (
      let child = allocator.firstChild[node]!;
      child !== -1;
      child = allocator.nextSibling[child]!
    ) {
      const childHeight = depths[child]! + 1;
      if (childHeight > height) height = childHeight;
    }
    depths[node] = height;
  }
  return depths[id]!;
}

/**
 * Writes the subtree rooted at `rootId` in post-order (children before
 * parents) into `out`. Uses a negative emit marker (`~id`) so one stack
 * suffices. Returns the number of ids written.
 */
export function collectPostOrder(
  allocator: EntityAllocator,
  rootId: number,
  out: Int32Array,
): number {
  const stack = allocator.postOrderStack;
  let top = 0;
  let count = 0;
  stack[top] = rootId;
  top += 1;
  while (top > 0) {
    top -= 1;
    const value = stack[top]!;
    if (value < 0) {
      out[count] = ~value;
      count += 1;
      continue;
    }
    stack[top] = ~value;
    top += 1;
    for (
      let child = allocator.firstChild[value]!;
      child !== -1;
      child = allocator.nextSibling[child]!
    ) {
      stack[top] = child;
      top += 1;
    }
  }
  return count;
}

/** Appends the children of `id` to `out` in insertion order. */
export function writeChildren(
  allocator: EntityAllocator,
  id: number,
  out: Entity[],
): void {
  for (
    let child = allocator.firstChild[id]!;
    child !== -1;
    child = allocator.nextSibling[child]!
  ) {
    out.push(allocator.handles[child]!);
  }
}

/** Topmost ancestor of `id`, or its own id for a root. */
export function rootOfId(allocator: EntityAllocator, id: number): number {
  let current = id;
  let guard = 0;
  while (guard <= allocator.nextId) {
    const parent = allocator.parent[current]!;
    if (parent === -1) return current;
    current = parent;
    guard += 1;
  }
  return id;
}

/**
 * Transform dirty flags and the world-matrix pass (spec 03 §3.7, §5.6).
 *
 * `update()` walks every root in ascending id order and every child list in
 * insertion order, recomputing only world-dirty entities. All stacks are
 * preallocated on the allocator, so a steady-state pass allocates nothing.
 */

import type { Entity, Transform as TransformData } from "../contracts/scene.js";
import type { Mat4 } from "../contracts/math.js";
import { mat4Compose, mat4Create, mat4Multiply } from "../math/index.js";
import type { ComponentStore } from "./ComponentStore.js";
import type { EntityAllocator } from "./EntityAllocator.js";
import {
  FLAG_HAS_WORLD,
  FLAG_LOCAL_DIRTY,
  FLAG_WORLD_DIRTY,
  type SceneCounters,
} from "./types.js";

const CLEAR_DIRTY = ~(FLAG_LOCAL_DIRTY | FLAG_WORLD_DIRTY);

export class TransformSystem {
  private readonly local: Mat4 = mat4Create();

  constructor(
    private readonly allocator: EntityAllocator,
    private readonly transforms: ComponentStore<TransformData>,
    private readonly counters: SceneCounters,
  ) {}

  /** Marks `id`'s TRS dirty and its whole subtree world-dirty. */
  markDirty(id: number): void {
    const allocator = this.allocator;
    allocator.flags[id] = allocator.flags[id]! | FLAG_LOCAL_DIRTY | FLAG_WORLD_DIRTY;
    const stack = allocator.dirtyStack;
    let top = 0;
    for (
      let child = allocator.firstChild[id]!;
      child !== -1;
      child = allocator.nextSibling[child]!
    ) {
      stack[top] = child;
      top += 1;
    }
    while (top > 0) {
      top -= 1;
      const current = stack[top]!;
      const flags = allocator.flags[current]!;
      // A world-dirty descendant already covers its own subtree.
      if ((flags & FLAG_WORLD_DIRTY) !== 0) continue;
      allocator.flags[current] = flags | FLAG_WORLD_DIRTY;
      for (
        let child = allocator.firstChild[current]!;
        child !== -1;
        child = allocator.nextSibling[child]!
      ) {
        stack[top] = child;
        top += 1;
      }
    }
  }

  /** Recomputes dirty world matrices; returns the number of entities written. */
  update(): number {
    const allocator = this.allocator;
    const stack = allocator.updateStack;
    let updated = 0;
    for (let root = 0; root < allocator.nextId; root += 1) {
      if (allocator.alive[root] !== 1 || allocator.parent[root] !== -1) continue;
      let top = 0;
      stack[top] = root;
      top += 1;
      while (top > 0) {
        top -= 1;
        const id = stack[top]!;
        const flags = allocator.flags[id]!;
        if ((flags & FLAG_WORLD_DIRTY) !== 0) {
          const transform = this.transforms.get(id);
          const world = allocator.world[id];
          if (transform !== undefined && world !== undefined) {
            const parent = allocator.parent[id]!;
            if (parent === -1) {
              mat4Compose(world, transform.position, transform.rotation, transform.scale);
            } else {
              const parentWorld = allocator.world[parent];
              if (parentWorld !== undefined) {
                mat4Compose(
                  this.local,
                  transform.position,
                  transform.rotation,
                  transform.scale,
                );
                mat4Multiply(world, parentWorld, this.local);
              }
            }
            allocator.flags[id] = (flags | FLAG_HAS_WORLD) & CLEAR_DIRTY;
            updated += 1;
          }
        }
        // Push children in reverse so they pop in insertion order.
        for (
          let child = allocator.lastChild[id]!;
          child !== -1;
          child = allocator.prevSibling[child]!
        ) {
          stack[top] = child;
          top += 1;
        }
      }
    }
    return updated;
  }

  /** Returns the cached matrix, counting a read while still world-dirty. */
  readWorld(entity: Entity): Mat4 | undefined {
    if (!this.allocator.isAliveHandle(entity)) return undefined;
    const id = entity.id;
    if ((this.allocator.flags[id]! & FLAG_WORLD_DIRTY) !== 0) {
      this.counters.dirtyReadCount += 1;
    }
    return this.allocator.world[id];
  }

  /** Installs an already-composed world matrix (used by load/debug tools). */
  setWorld(id: number, matrix: Mat4): void {
    const target = this.allocator.world[id];
    if (target === undefined) return;
    target.m.set(matrix.m);
    this.allocator.flags[id] =
      (this.allocator.flags[id]! | FLAG_HAS_WORLD) & CLEAR_DIRTY;
  }
}

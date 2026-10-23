/**
 * Entity slot allocation (spec 03 §3.1, §5.2).
 *
 * One handle object per live entity, LIFO slot reuse, generations that
 * increment on reuse (never 0). The allocator also owns the per-slot hierarchy
 * arrays and world matrices so `Hierarchy` and `TransformSystem` can walk them
 * without indirection.
 */

import type { Entity } from "../contracts/scene.js";
import type { Mat4 } from "../contracts/math.js";
import { mat4Create } from "../math/index.js";
import { sceneError } from "./errors.js";
import { FLAG_LOCAL_DIRTY, FLAG_WORLD_DIRTY } from "./types.js";

/** Returned by operations that have no meaningful entity (disposed scene). */
export const DEAD_ENTITY: Entity = Object.freeze({ id: -1, generation: 0 });

function growRefArray<T>(old: readonly (T | undefined)[], size: number): (T | undefined)[] {
  const next = new Array<T | undefined>(size);
  for (let index = 0; index < old.length; index += 1) next[index] = old[index];
  return next;
}

function growInt32(old: Int32Array, size: number, fill: number): Int32Array {
  const next = new Int32Array(size);
  if (fill !== 0) next.fill(fill);
  next.set(old);
  return next;
}

export class EntityAllocator {
  capacity: number;
  readonly maxEntities: number;

  generations: Uint32Array;
  alive: Uint8Array;
  enabled: Uint8Array;
  flags: Uint8Array;
  parent: Int32Array;
  firstChild: Int32Array;
  lastChild: Int32Array;
  nextSibling: Int32Array;
  prevSibling: Int32Array;
  handles: (Entity | undefined)[];
  world: (Mat4 | undefined)[];

  freeStack: Uint32Array;
  freeCount = 0;
  nextId = 0;
  liveCount = 0;

  /** Scratch arrays reused by destroy, dirty propagation and height checks. */
  postOrderStack: Int32Array;
  postOrder: Int32Array;
  dirtyStack: Int32Array;
  updateStack: Int32Array;
  heightStack: Int32Array;
  heightDepth: Int32Array;

  constructor(initialCapacity: number, maxEntities: number) {
    this.capacity = initialCapacity;
    this.maxEntities = maxEntities;
    this.generations = new Uint32Array(initialCapacity);
    this.alive = new Uint8Array(initialCapacity);
    this.enabled = new Uint8Array(initialCapacity);
    this.flags = new Uint8Array(initialCapacity);
    this.parent = new Int32Array(initialCapacity).fill(-1);
    this.firstChild = new Int32Array(initialCapacity).fill(-1);
    this.lastChild = new Int32Array(initialCapacity).fill(-1);
    this.nextSibling = new Int32Array(initialCapacity).fill(-1);
    this.prevSibling = new Int32Array(initialCapacity).fill(-1);
    this.handles = new Array<Entity | undefined>(initialCapacity);
    this.world = new Array<Mat4 | undefined>(initialCapacity);
    this.freeStack = new Uint32Array(initialCapacity);
    // Traversal stacks hold pending nodes plus one emit marker per depth.
    this.postOrderStack = new Int32Array(initialCapacity * 2);
    this.postOrder = new Int32Array(initialCapacity);
    this.dirtyStack = new Int32Array(initialCapacity * 2);
    this.updateStack = new Int32Array(initialCapacity * 2);
    this.heightStack = new Int32Array(initialCapacity * 2);
    this.heightDepth = new Int32Array(initialCapacity);
  }

  private grow(): void {
    const nextCapacity = Math.min(this.capacity * 2, this.maxEntities);
    if (nextCapacity <= this.capacity) return;
    this.generations = growUint32(this.generations, nextCapacity);
    this.alive = growUint8(this.alive, nextCapacity);
    this.enabled = growUint8(this.enabled, nextCapacity);
    this.flags = growUint8(this.flags, nextCapacity);
    this.parent = growInt32(this.parent, nextCapacity, -1);
    this.firstChild = growInt32(this.firstChild, nextCapacity, -1);
    this.lastChild = growInt32(this.lastChild, nextCapacity, -1);
    this.nextSibling = growInt32(this.nextSibling, nextCapacity, -1);
    this.prevSibling = growInt32(this.prevSibling, nextCapacity, -1);
    this.handles = growRefArray(this.handles, nextCapacity);
    this.world = growRefArray(this.world, nextCapacity);
    this.freeStack = growUint32(this.freeStack, nextCapacity);
    this.postOrderStack = growInt32(this.postOrderStack, nextCapacity * 2, 0);
    this.postOrder = growInt32(this.postOrder, nextCapacity, 0);
    this.dirtyStack = growInt32(this.dirtyStack, nextCapacity * 2, 0);
    this.updateStack = growInt32(this.updateStack, nextCapacity * 2, 0);
    this.heightStack = growInt32(this.heightStack, nextCapacity * 2, 0);
    this.heightDepth = growInt32(this.heightDepth, nextCapacity, 0);
    this.capacity = nextCapacity;
  }

  /** Allocates a slot (LIFO) and returns the single handle object for it. */
  allocate(): Entity {
    let id: number;
    if (this.freeCount > 0) {
      id = this.freeStack[--this.freeCount]!;
    } else {
      if (this.nextId >= this.maxEntities) {
        throw sceneError(
          "E_SCENE_INVALID",
          `createEntity: entity limit reached (${this.maxEntities})`,
        );
      }
      if (this.nextId >= this.capacity) this.grow();
      id = this.nextId;
      this.nextId += 1;
    }

    const previous = this.generations[id]!;
    let generation = (previous + 1) >>> 0;
    if (generation === 0) generation = 1;
    this.generations[id] = generation;

    this.alive[id] = 1;
    this.enabled[id] = 1;
    this.flags[id] = FLAG_LOCAL_DIRTY | FLAG_WORLD_DIRTY;
    this.parent[id] = -1;
    this.firstChild[id] = -1;
    this.lastChild[id] = -1;
    this.nextSibling[id] = -1;
    this.prevSibling[id] = -1;

    const handle: Entity = Object.freeze({ id, generation });
    this.handles[id] = handle;
    if (this.world[id] === undefined) this.world[id] = mat4Create();
    this.liveCount += 1;
    return handle;
  }

  /** Releases a dead slot. The generation is preserved until reuse. */
  release(id: number): void {
    this.alive[id] = 0;
    this.enabled[id] = 0;
    this.flags[id] = 0;
    this.parent[id] = -1;
    this.firstChild[id] = -1;
    this.lastChild[id] = -1;
    this.nextSibling[id] = -1;
    this.prevSibling[id] = -1;
    this.handles[id] = undefined;
    this.freeStack[this.freeCount] = id;
    this.freeCount += 1;
    this.liveCount -= 1;
  }

  /** O(1) liveness check including generation and disposed-free range checks. */
  isAliveHandle(entity: Entity | null | undefined): boolean {
    if (entity === null || entity === undefined) return false;
    const id = entity.id;
    if (!Number.isInteger(id) || id < 0 || id >= this.nextId) return false;
    return this.alive[id] === 1 && this.generations[id] === entity.generation;
  }
}

function growUint32(old: Uint32Array, size: number): Uint32Array {
  const next = new Uint32Array(size);
  next.set(old);
  return next;
}

function growUint8(old: Uint8Array, size: number): Uint8Array {
  const next = new Uint8Array(size);
  next.set(old);
  return next;
}

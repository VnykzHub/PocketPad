/**
 * Entity identity, generations and slot reuse (03 §3.1, §5.2, ER-03-01).
 *
 * The 100,000-cycle row runs against the allocator directly; the scene-level
 * cases cover stale rejection in dev and production.
 */

import { expect, test } from "vitest";
import type { Entity, SceneStats } from "../../src/contracts/scene.js";
import { createScene, Transform } from "../../src/scene/index.js";
import { EntityAllocator } from "../../src/scene/EntityAllocator.js";
import { SceneEngineError } from "../../src/scene/errors.js";

const CYCLE_COUNT = 100_000;

function makeStats(): SceneStats {
  return {
    alive: 0,
    capacity: 0,
    freeSlots: 0,
    components: 0,
    dirtyTransforms: 0,
    maxDepth: 0,
    staleHandleCount: 0,
    dirtyReadCount: 0,
    rejectedOperationCount: 0,
    approxBytes: 0,
  };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof SceneEngineError ? error.code : undefined;
  }
}

test("[ER-03-01] fresh slots ascend from 0 with generation 1", () => {
  const scene = createScene({ devChecks: true, initialCapacity: 16 });
  const first = scene.createEntity();
  const second = scene.createEntity();
  const third = scene.createEntity();

  expect([first.id, second.id, third.id]).toEqual([0, 1, 2]);
  expect([first.generation, second.generation, third.generation]).toEqual([1, 1, 1]);
  expect(scene.aliveCount).toBe(3);
});

test("[ER-03-01] 100,000 create/destroy cycles on a full allocator leak no slot", () => {
  const allocator = new EntityAllocator(16, 64);
  const handles: Entity[] = [];
  for (let index = 0; index < 16; index += 1) handles.push(allocator.allocate());

  let current = handles[0]!;
  let generation = current.generation;

  for (let cycle = 0; cycle < CYCLE_COUNT; cycle += 1) {
    allocator.release(current.id);
    const next = allocator.allocate();
    if (next.id !== current.id) {
      throw new Error(`cycle ${cycle} reused slot ${next.id}, expected ${current.id}`);
    }
    const expected = generation === 0xffffffff ? 1 : generation + 1;
    if (next.generation !== expected) {
      throw new Error(
        `cycle ${cycle} generation ${next.generation}, expected ${expected}`,
      );
    }
    generation = next.generation;
    current = next;
  }

  expect(current.id).toBe(0);
  expect(generation).toBe(1 + CYCLE_COUNT);
  expect(allocator.liveCount).toBe(16);
  expect(allocator.capacity - allocator.liveCount).toBe(allocator.freeCount);
  expect(allocator.isAliveHandle(handles[0]!)).toBe(false);
});

test("[ER-03-01] freed slots are reused LIFO", () => {
  const allocator = new EntityAllocator(16, 64);
  const first = allocator.allocate();
  const second = allocator.allocate();
  const third = allocator.allocate();

  allocator.release(second.id);
  allocator.release(third.id);

  expect(allocator.allocate().id).toBe(third.id);
  expect(allocator.allocate().id).toBe(second.id);
  expect(allocator.freeCount).toBe(0);
  expect(allocator.liveCount).toBe(3);
  expect(first.generation).toBe(1);
});

test("[ER-03-01] a reused slot makes the previous handle stale", () => {
  const scene = createScene({ devChecks: true, initialCapacity: 16 });
  const original = scene.createEntity();
  scene.createEntity();
  scene.destroyEntity(original);
  const reused = scene.createEntity();

  expect(reused.id).toBe(original.id);
  expect(reused.generation).toBe(original.generation + 1);
  expect(scene.isAlive(original)).toBe(false);
  expect(scene.isAlive(reused)).toBe(true);
  expect(scene.isAlive({ id: reused.id, generation: 0 })).toBe(false);
  expect(scene.isAlive({ id: 99, generation: 1 })).toBe(false);
});

test("[ER-03-01] generation wrap maps 0 to 1 and never 0", () => {
  const allocator = new EntityAllocator(16, 16);
  const handle = allocator.allocate();
  allocator.generations[handle.id] = 0xffffffff;
  allocator.release(handle.id);

  const wrapped = allocator.allocate();
  expect(wrapped.generation).toBe(1);
  expect(allocator.isAliveHandle({ id: handle.id, generation: 1 })).toBe(true);
  expect(allocator.isAliveHandle({ id: handle.id, generation: 0 })).toBe(false);
});

test("[ER-03-01] dev rejects a stale handle with E_STALE_HANDLE", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();
  scene.destroyEntity(entity);

  expect(codeOf(() => scene.get(entity, Transform))).toBe("E_STALE_HANDLE");
  expect(codeOf(() => scene.destroyEntity(entity))).toBe("E_STALE_HANDLE");
});

test("[ER-03-01] production ignores a stale handle and counts it", () => {
  const scene = createScene();
  const entity = scene.createEntity();
  scene.destroyEntity(entity);

  expect(scene.get(entity, Transform)).toBeUndefined();
  expect(scene.has(entity, Transform)).toBe(false);
  scene.destroyEntity(entity);

  const stats = scene.getStats(makeStats());
  expect(stats.staleHandleCount).toBe(3);
  expect(scene.aliveCount).toBe(0);
});

test("[ER-03-01] the slot limit throws E_SCENE_INVALID", () => {
  const scene = createScene({ initialCapacity: 16, maxEntities: 16 });
  for (let index = 0; index < 16; index += 1) scene.createEntity();

  expect(codeOf(() => scene.createEntity())).toBe("E_SCENE_INVALID");
  expect(scene.aliveCount).toBe(16);
});

/**
 * Hierarchy semantics (03 §3.7, §3.10, §5.5, ER-03-05).
 *
 * Child order, detach/reparent, cycle and depth rejection, and depth-first
 * subtree destruction. The randomized forest checks live in
 * `hierarchy.property.test.ts`.
 */

import { expect, test } from "vitest";
import type { Entity, SceneStats } from "../../src/contracts/scene.js";
import { createScene, defineComponent } from "../../src/scene/index.js";
import { SceneEngineError } from "../../src/scene/errors.js";

interface Tracked {
  value: number;
}

const destroyed: number[] = [];

const TrackedType = defineComponent<Tracked>({
  name: "test.hierarchy.tracker",
  create: () => ({ value: 0 }),
  onRemove: (value) => {
    destroyed.push(value.value);
  },
});

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

function ids(entities: Entity[]): number[] {
  return entities.map((entity) => entity.id);
}

test("[ER-03-05] setParent appends children in insertion order", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const first = scene.createEntity();
  const second = scene.createEntity();
  const third = scene.createEntity();

  expect(scene.setParent(first, root)).toBe(true);
  expect(scene.setParent(second, root)).toBe(true);
  expect(scene.setParent(third, root)).toBe(true);

  const out: Entity[] = [];
  expect(ids(scene.childrenOf(root, out))).toEqual([first.id, second.id, third.id]);
  expect(scene.parentOf(second)).toBe(root);
  expect(scene.parentOf(root)).toBeNull();
  expect(scene.rootOf(third)).toBe(root);
});

test("[ER-03-05] reparenting moves the subtree and appends to the new parent", () => {
  const scene = createScene({ devChecks: true });
  const left = scene.createEntity();
  const right = scene.createEntity();
  const middle = scene.createEntity();
  const leaf = scene.createEntity();
  const sibling = scene.createEntity();

  scene.setParent(middle, left);
  scene.setParent(leaf, middle);
  scene.setParent(sibling, right);

  expect(scene.setParent(middle, right)).toBe(true);

  const leftChildren: Entity[] = [];
  expect(scene.childrenOf(left, leftChildren)).toEqual([]);
  const rightChildren: Entity[] = [];
  expect(ids(scene.childrenOf(right, rightChildren))).toEqual([
    sibling.id,
    middle.id,
  ]);
  const middleChildren: Entity[] = [];
  expect(ids(scene.childrenOf(middle, middleChildren))).toEqual([leaf.id]);
  expect(scene.rootOf(leaf)).toBe(right);
});

test("[ER-03-05] setParent(null) detaches and preserves the remaining order", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const first = scene.createEntity();
  const second = scene.createEntity();
  const third = scene.createEntity();
  scene.setParent(first, root);
  scene.setParent(second, root);
  scene.setParent(third, root);

  expect(scene.setParent(second, null)).toBe(true);
  const out: Entity[] = [];
  expect(ids(scene.childrenOf(root, out))).toEqual([first.id, third.id]);
  expect(scene.parentOf(second)).toBeNull();
  expect(scene.rootOf(second)).toBe(second);

  scene.setParent(second, third);
  expect(ids(scene.childrenOf(third, out))).toEqual([second.id]);
  expect(scene.rootOf(second)).toBe(root);
});

test("[ER-03-05] childrenOf clears and reuses the caller array", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const child = scene.createEntity();
  scene.setParent(child, root);

  const out: Entity[] = [root, child, root];
  const result = scene.childrenOf(root, out);
  expect(result).toBe(out);
  expect(out).toEqual([child]);

  scene.setParent(child, null);
  expect(scene.childrenOf(root, out)).toBe(out);
  expect(out).toEqual([]);
});

test("[ER-03-05] self-parenting and cycles are rejected in dev", () => {
  const scene = createScene({ devChecks: true });
  const first = scene.createEntity();
  const second = scene.createEntity();
  const third = scene.createEntity();
  scene.setParent(second, first);
  scene.setParent(third, second);

  expect(codeOf(() => scene.setParent(first, first))).toBe("E_SCENE_INVALID");
  expect(codeOf(() => scene.setParent(first, third))).toBe("E_SCENE_INVALID");
  expect(codeOf(() => scene.setParent(first, second))).toBe("E_SCENE_INVALID");

  // The rejected links must not have mutated the forest.
  expect(scene.parentOf(first)).toBeNull();
  expect(scene.parentOf(second)).toBe(first);
  const children: Entity[] = [];
  expect(ids(scene.childrenOf(first, children))).toEqual([second.id]);
});

test("[ER-03-05] production rejects a cycle without mutating and counts it", () => {
  const scene = createScene({ devChecks: false });
  const first = scene.createEntity();
  const second = scene.createEntity();
  scene.setParent(second, first);

  expect(scene.setParent(first, second)).toBe(false);
  expect(scene.parentOf(first)).toBeNull();
  expect(scene.parentOf(second)).toBe(first);

  const stats = scene.getStats(makeStats());
  expect(stats.rejectedOperationCount).toBe(1);
});

test("[ER-03-05] the depth cap counts the moved subtree height", () => {
  const scene = createScene({ devChecks: true, maxHierarchyDepth: 3 });
  const root = scene.createEntity();
  const middle = scene.createEntity();
  const bottom = scene.createEntity();
  scene.setParent(middle, root);
  scene.setParent(bottom, middle);

  const carried = scene.createEntity();
  const carriedLeaf = scene.createEntity();
  scene.setParent(carriedLeaf, carried);

  // depth(middle) = 2, height(carried) = 2 → 4 > 3.
  expect(codeOf(() => scene.setParent(carried, middle))).toBe("E_SCENE_INVALID");
  expect(scene.parentOf(carried)).toBeNull();

  // depth(bottom) = 3, height(carriedLeaf) = 1 → 4 > 3.
  expect(codeOf(() => scene.setParent(carriedLeaf, bottom))).toBe("E_SCENE_INVALID");
  expect(scene.parentOf(carriedLeaf)).toBe(carried);

  // depth(middle) = 2, height(carriedLeaf) = 1 → 3 ≤ 3.
  expect(scene.setParent(carriedLeaf, middle)).toBe(true);
  expect(scene.rootOf(carriedLeaf)).toBe(root);
});

test("[ER-03-05] a chain of 64 links is allowed and the 65th is rejected", () => {
  const scene = createScene({ devChecks: true });
  const chain: Entity[] = [];
  for (let index = 0; index < 65; index += 1) chain.push(scene.createEntity());

  for (let index = 1; index < 64; index += 1) {
    expect(scene.setParent(chain[index]!, chain[index - 1]!)).toBe(true);
  }
  expect(codeOf(() => scene.setParent(chain[64]!, chain[63]!))).toBe(
    "E_SCENE_INVALID",
  );
  expect(scene.parentOf(chain[64]!)).toBeNull();

  const stats = scene.getStats(makeStats());
  expect(stats.maxDepth).toBe(64);
});

test("[ER-03-05] maxHierarchyDepth is clamped to at least 1", () => {
  const scene = createScene({ devChecks: true, maxHierarchyDepth: 0 });
  const root = scene.createEntity();
  const child = scene.createEntity();

  expect(codeOf(() => scene.setParent(child, root))).toBe("E_SCENE_INVALID");
  expect(scene.parentOf(child)).toBeNull();
});

test("[ER-03-05] destroyEntity removes the subtree depth-first in post-order", () => {
  const scene = createScene({ devChecks: true });
  destroyed.length = 0;
  const root = scene.createEntity();
  const first = scene.createEntity();
  const second = scene.createEntity();
  const firstLeaf = scene.createEntity();
  const secondLeaf = scene.createEntity();
  scene.setParent(first, root);
  scene.setParent(second, root);
  scene.setParent(firstLeaf, first);
  scene.setParent(secondLeaf, second);

  for (const entity of [root, first, second, firstLeaf, secondLeaf]) {
    scene.add(entity, TrackedType, { value: entity.id });
  }

  scene.destroyEntity(root);

  expect(destroyed.length).toBe(5);
  expect(new Set(destroyed)).toEqual(
    new Set([root.id, first.id, second.id, firstLeaf.id, secondLeaf.id]),
  );
  const position = new Map(destroyed.map((id, index) => [id, index]));
  for (const [parent, child] of [
    [root.id, first.id],
    [root.id, second.id],
    [first.id, firstLeaf.id],
    [second.id, secondLeaf.id],
  ] as const) {
    expect(position.get(child)!).toBeLessThan(position.get(parent)!);
  }
  expect(position.get(root.id)).toBe(4);
  expect(destroyed[4]).toBe(root.id);

  for (const entity of [root, first, second, firstLeaf, secondLeaf]) {
    expect(scene.isAlive(entity)).toBe(false);
  }
  expect(scene.aliveCount).toBe(0);
});

test("[ER-03-05] destroying a child detaches it from its parent", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const first = scene.createEntity();
  const second = scene.createEntity();
  scene.setParent(first, root);
  scene.setParent(second, root);

  scene.destroyEntity(first);

  const out: Entity[] = [];
  expect(ids(scene.childrenOf(root, out))).toEqual([second.id]);
  expect(codeOf(() => scene.childrenOf(first, out))).toBe("E_STALE_HANDLE");
  expect(scene.aliveCount).toBe(2);
});

test("[ER-03-05] disabling a parent does not disable its children", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const child = scene.createEntity();
  scene.setParent(child, root);
  scene.setEnabled(root, false);

  expect(scene.isEnabled(root)).toBe(false);
  expect(scene.isEnabled(child)).toBe(true);
  expect(scene.parentOf(child)).toBe(root);
  expect(ids(scene.query([]))).toEqual([child.id]);

  scene.destroyEntity(root);
  expect(scene.isAlive(child)).toBe(false);
});

test("[ER-03-05] a stale parent is refused while a stale child reports stale", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const child = scene.createEntity();
  scene.destroyEntity(child);

  expect(codeOf(() => scene.setParent(child, root))).toBe("E_STALE_HANDLE");

  const other = scene.createEntity();
  scene.destroyEntity(root);
  expect(codeOf(() => scene.setParent(other, root))).toBe("E_SCENE_INVALID");
});

test("[ER-03-05] production counts stale and rejected setParent attempts", () => {
  const scene = createScene({ devChecks: false });
  const root = scene.createEntity();
  const child = scene.createEntity();

  scene.destroyEntity(child);
  expect(scene.setParent(child, root)).toBe(false);

  const other = scene.createEntity();
  scene.destroyEntity(root);
  expect(scene.setParent(other, root)).toBe(false);

  const stats = scene.getStats(makeStats());
  expect(stats.staleHandleCount).toBe(1);
  expect(stats.rejectedOperationCount).toBe(1);
});

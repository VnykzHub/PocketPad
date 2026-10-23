/**
 * Prefab instancing and EntityPool behaviour (03 §3.9, §4.2, §4.3, §5.8,
 * ER-03-10).
 *
 * Deterministic stand-in for the pooled-spawn workload: 1,000 independent
 * instances, 10,000 acquire/release cycles, ownership errors and dispose.
 * Heap-growth figures stay PENDING in RESULTS; this suite pins behaviour.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type {
  EngineScene,
  Entity,
  Prefab,
  SceneStats,
} from "../../src/contracts/scene.js";
import {
  createScene,
  EntityPool,
  instantiatePrefab,
  parsePrefab,
  Renderable,
  Transform,
} from "../../src/scene/index.js";
import { SceneEngineError } from "../../src/scene/errors.js";

const PREFAB_DATA: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/prefab-golden.json", import.meta.url), "utf8"),
);
const PREFAB: Prefab = parsePrefab(PREFAB_DATA);

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

function instanceEntities(scene: EngineScene, root: Entity): Entity[] {
  const result: Entity[] = [];
  const stack: Entity[] = [root];
  const out: Entity[] = [];
  while (stack.length > 0) {
    const entity = stack.pop()!;
    result.push(entity);
    scene.childrenOf(entity, out);
    for (let index = 0; index < out.length; index += 1) {
      stack.push(out[index]!);
    }
  }
  return result;
}

test("[ER-03-10] one prefab instantiated 1,000 times shares no mutable component state", () => {
  const scene = createScene({ devChecks: true });
  const roots: Entity[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    roots.push(instantiatePrefab(scene, PREFAB));
  }

  expect(scene.aliveCount).toBe(5_000);
  expect(new Set(roots.map((root) => root.id)).size).toBe(1_000);

  const first = roots[0]!;
  const second = roots[1]!;
  const firstChildren: Entity[] = [];
  const secondChildren: Entity[] = [];
  scene.childrenOf(first, firstChildren);
  scene.childrenOf(second, secondChildren);
  expect(firstChildren).toHaveLength(3);
  expect(secondChildren).toHaveLength(3);
  expect(scene.get(secondChildren[0]!, Transform)!.position).toEqual(
    scene.get(firstChildren[0]!, Transform)!.position,
  );

  const secondRootPosition = { ...scene.get(second, Transform)!.position };
  const secondMesh = scene.get(second, Renderable)!.mesh;
  const secondChildPosition = {
    ...scene.get(secondChildren[0]!, Transform)!.position,
  };

  scene.get(first, Transform)!.position.x = 99;
  scene.get(first, Transform)!.scale.z = 3;
  scene.get(first, Renderable)!.mesh = "meshes/mutated";
  scene.get(first, Renderable)!.visible = false;
  scene.get(firstChildren[0]!, Transform)!.position.y = -7;

  expect(scene.get(second, Transform)!.position).toEqual(secondRootPosition);
  expect(scene.get(second, Renderable)!.mesh).toBe(secondMesh);
  expect(scene.get(secondChildren[0]!, Transform)!.position).toEqual(
    secondChildPosition,
  );

  for (let index = 1; index < roots.length; index += 1) {
    expect(scene.get(roots[index]!, Transform)!.position).toEqual({
      x: 0,
      y: 0,
      z: 0,
    });
    expect(scene.get(roots[index]!, Renderable)!.mesh).toBe("meshes/crate");
  }
});

test("[ER-03-10] EntityPool survives 10,000 acquire/release cycles without growth or leaks", () => {
  const scene = createScene({ devChecks: true });
  const pool = new EntityPool(scene, PREFAB, { initial: 4, max: 4 });
  expect(pool.created).toBe(4);
  expect(pool.idle).toBe(4);

  const reused = new Set<number>();
  const children: Entity[] = [];
  for (let cycle = 0; cycle < 10_000; cycle += 1) {
    const root = pool.acquire();
    expect(pool.active).toBe(1);
    expect(pool.idle).toBe(3);
    expect(scene.isEnabled(root)).toBe(true);
    scene.childrenOf(root, children);
    expect(scene.isEnabled(children[0]!)).toBe(true);
    reused.add(root.id);
    pool.release(root);
    expect(pool.active).toBe(0);
    expect(pool.idle).toBe(4);
    expect(scene.isEnabled(root)).toBe(false);
  }

  expect(pool.created).toBe(4);
  expect(reused.size).toBe(1);
  expect(scene.aliveCount).toBe(20);
});

test("[ER-03-10] release disables every instance entity and query excludes it while queryAll includes it", () => {
  const scene = createScene({ devChecks: true });
  const pool = new EntityPool(scene, PREFAB, { initial: 1 });
  const root = pool.acquire();
  const entities = instanceEntities(scene, root);
  expect(entities).toHaveLength(5);

  const out: Entity[] = [];
  expect(scene.query(out, Renderable)).toHaveLength(5);
  expect(scene.queryAll(out, Renderable)).toHaveLength(5);

  pool.release(root);
  for (const entity of entities) {
    expect(scene.isAlive(entity)).toBe(true);
    expect(scene.isEnabled(entity)).toBe(false);
  }
  expect(scene.query(out, Renderable)).toHaveLength(0);
  expect(scene.queryAll(out, Renderable)).toHaveLength(5);
  expect(scene.childrenOf(root, out)).toHaveLength(3);

  const again = pool.acquire();
  expect(again).toBe(root);
  for (const entity of entities) expect(scene.isEnabled(entity)).toBe(true);
  expect(scene.query(out, Renderable)).toHaveLength(5);
});

test("[ER-03-10] acquire resets every component to its prefab value", () => {
  const scene = createScene({ devChecks: true });
  const pool = new EntityPool(scene, PREFAB, { initial: 1 });
  const root = pool.acquire();
  const children: Entity[] = [];
  scene.childrenOf(root, children);
  const nested: Entity[] = [];
  scene.childrenOf(children[0]!, nested);

  scene.get(root, Transform)!.position.x = 42;
  scene.get(root, Renderable)!.mesh = "meshes/mutated";
  scene.get(children[0]!, Transform)!.position.y = 8;
  scene.get(nested[0]!, Transform)!.scale.x = 9;
  scene.setEnabled(nested[0]!, false);

  pool.release(root);
  const again = pool.acquire();
  expect(again.id).toBe(root.id);
  expect(again.generation).toBe(root.generation);
  expect(scene.get(again, Transform)!.position).toEqual({ x: 0, y: 0, z: 0 });
  expect(scene.get(again, Renderable)!.mesh).toBe("meshes/crate");
  expect(scene.get(children[0]!, Transform)!.position).toEqual({
    x: 0,
    y: 0.5,
    z: 0,
  });
  expect(scene.get(nested[0]!, Transform)!.scale.x).toBe(1);
  expect(scene.isEnabled(nested[0]!)).toBe(true);
});

test("[ER-03-10] acquire applies default and explicit parents and enforces the instance cap", () => {
  const scene = createScene({ devChecks: true });
  const defaultParent = scene.createEntity();
  const pool = new EntityPool(scene, PREFAB, {
    initial: 1,
    max: 1,
    parent: defaultParent,
  });

  const root = pool.acquire();
  expect(scene.parentOf(root)).toBe(defaultParent);
  pool.release(root);

  const explicitParent = scene.createEntity();
  const again = pool.acquire(explicitParent);
  expect(scene.parentOf(again)).toBe(explicitParent);
  expect(
    codeOf(() => {
      const second = pool.acquire();
      pool.release(second);
    }),
  ).toBe("E_SCENE_INVALID");
  expect(pool.active).toBe(1);
  pool.release(again);
});

test("[ER-03-10] pool rejects foreign and double releases, requires one root and disposes its instances", () => {
  const scene = createScene({ devChecks: true });
  const pool = new EntityPool(scene, PREFAB, { initial: 1 });
  const foreign = scene.createEntity();
  expect(codeOf(() => pool.release(foreign))).toBe("E_SCENE_INVALID");

  const root = pool.acquire();
  pool.release(root);
  expect(codeOf(() => pool.release(root))).toBe("E_SCENE_INVALID");

  const destroyed = pool.acquire();
  scene.destroyEntity(destroyed);
  expect(codeOf(() => pool.release(destroyed))).toBe("E_STALE_HANDLE");

  pool.dispose();
  pool.dispose();
  expect(scene.isAlive(foreign)).toBe(true);
  expect(scene.aliveCount).toBe(1);
  expect(codeOf(() => pool.acquire())).toBe("E_CONTRACT");
  expect(() => pool.release(root)).not.toThrow();

  const production = createScene({ devChecks: false });
  const productionPool = new EntityPool(production, PREFAB, { initial: 1 });
  const productionForeign = production.createEntity();
  productionPool.release(productionForeign);
  expect(production.getStats(makeStats()).rejectedOperationCount).toBe(1);

  const twoRoots = JSON.parse(JSON.stringify(PREFAB_DATA)) as {
    entities: { parent: number | null }[];
  };
  twoRoots.entities[3]!.parent = null;
  const invalid = parsePrefab(twoRoots);
  expect(codeOf(() => new EntityPool(scene, invalid))).toBe("E_SCENE_INVALID");
});

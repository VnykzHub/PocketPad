/**
 * Renderer/physics integration over the 10k fixture (03 §7 ER-03-11).
 *
 * A fake renderer walks every Renderable and its world matrix after a single
 * update; a fake physics system writes 1,000 transforms and only their
 * subtrees recompute. Neither reads a world-dirty matrix. Heap growth is not
 * asserted here; the ER-03-11 allocation budget stays PENDING in RESULTS.
 */

import { expect, test } from "vitest";
import type { Quat } from "../../src/contracts/math.js";
import type { EngineScene, Entity, SceneStats } from "../../src/contracts/scene.js";
import {
  createScene,
  Renderable,
  Transform,
} from "../../src/scene/index.js";
import { findStaleWorldMatrices } from "./transformFixture.js";

const ROOTS = 1_000;
const CHAIN = 10;
const ENTITY_COUNT = ROOTS * CHAIN;
/** Chain index whose subtree is rewritten by the fake physics system. */
const PHYSICS_DEPTH = 4;
const PHYSICS_SUBTREE = CHAIN - PHYSICS_DEPTH;
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

interface World {
  readonly scene: EngineScene;
  readonly chains: readonly Entity[][];
}

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

function buildWorld(): World {
  const scene = createScene({ devChecks: true });
  const chains: Entity[][] = [];
  for (let rootIndex = 0; rootIndex < ROOTS; rootIndex += 1) {
    const chain: Entity[] = [];
    for (let depth = 0; depth < CHAIN; depth += 1) {
      const entity = scene.createEntity();
      if (depth > 0) scene.setParent(entity, chain[depth - 1]!);
      scene.setTransform(
        entity,
        { x: rootIndex * CHAIN + depth, y: 0, z: 0 },
        IDENTITY,
        { x: 1, y: 1, z: 1 },
      );
      scene.add(entity, Renderable, {
        mesh: "meshes/cube",
        material: "materials/default",
        visible: true,
        layer: 0,
      });
      chain.push(entity);
    }
    chains.push(chain);
  }
  return { scene, chains };
}

test("[ER-03-11] a fake renderer walks 10,000 Renderables after one update with zero dirty reads", () => {
  const { scene } = buildWorld();
  expect(scene.updateWorldTransforms()).toBe(ENTITY_COUNT);

  const out: Entity[] = [];
  const first = scene.query(out, Renderable);
  expect(first).toBe(out);
  expect(first).toHaveLength(ENTITY_COUNT);

  const handles = first.slice();
  const matrices = new Array<unknown>(ENTITY_COUNT);
  let visited = 0;
  for (let index = 0; index < first.length; index += 1) {
    const matrix = scene.worldMatrix(first[index]!);
    expect(matrix).toBeDefined();
    matrices[index] = matrix;
    visited += 1;
  }
  expect(visited).toBe(ENTITY_COUNT);
  expect(scene.getStats(makeStats()).dirtyReadCount).toBe(0);

  // A second pass reuses the same out array, handles and matrices.
  const second = scene.query(out, Renderable);
  expect(second).toBe(first);
  for (let index = 0; index < second.length; index += 1) {
    expect(second[index]).toBe(handles[index]);
    expect(scene.worldMatrix(second[index]!)).toBe(matrices[index]);
  }
  expect(scene.getStats(makeStats()).dirtyReadCount).toBe(0);
  expect(scene.getStats(makeStats()).dirtyTransforms).toBe(0);
});

test("[ER-03-11] fake physics writes 1,000 transforms and exactly those subtrees recompute", () => {
  const { scene, chains } = buildWorld();
  expect(scene.updateWorldTransforms()).toBe(ENTITY_COUNT);

  const parents: Entity[] = [];
  const parentTranslations: number[] = [];
  for (let rootIndex = 0; rootIndex < ROOTS; rootIndex += 1) {
    const parent = chains[rootIndex]![PHYSICS_DEPTH - 1]!;
    parents.push(parent);
    parentTranslations.push(scene.worldMatrix(parent)!.m[12]!);
  }

  for (let rootIndex = 0; rootIndex < ROOTS; rootIndex += 1) {
    const entity = chains[rootIndex]![PHYSICS_DEPTH]!;
    const transform = scene.get(entity, Transform)!;
    scene.setTransform(
      entity,
      { x: transform.position.x + 1, y: 0, z: 0 },
      IDENTITY,
      { x: 1, y: 1, z: 1 },
    );
  }

  expect(scene.updateWorldTransforms()).toBe(ROOTS * PHYSICS_SUBTREE);
  expect(scene.updateWorldTransforms()).toBe(0);
  expect(scene.getStats(makeStats()).dirtyReadCount).toBe(0);

  for (let rootIndex = 0; rootIndex < ROOTS; rootIndex += 1) {
    const parent = parents[rootIndex]!;
    expect(scene.worldMatrix(parent)!.m[12]).toBe(parentTranslations[rootIndex]);
  }
  expect(findStaleWorldMatrices(scene)).toEqual([]);

  const out: Entity[] = [];
  const renderables = scene.query(out, Renderable);
  expect(renderables).toHaveLength(ENTITY_COUNT);
  for (let index = 0; index < renderables.length; index += 1) {
    expect(scene.worldMatrix(renderables[index]!)).toBeDefined();
  }
  expect(scene.getStats(makeStats()).dirtyReadCount).toBe(0);
});

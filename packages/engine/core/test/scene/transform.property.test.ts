/**
 * Randomized transform conformance (03 §8, ER-03-06).
 *
 * 250 runs × 40 entities = 10,000 random TRS hierarchies. Each run compares
 * every cached world matrix against a full recompute (1e-5), then pins the
 * exact recompute count for a moved leaf and a moved root, and finally proves
 * the dev validator catches a deliberately missed `markTransformDirty`.
 */

import fc from "fast-check";
import { expect, test } from "vitest";
import type { Quat, Vec3 } from "../../src/contracts/math.js";
import type { Entity } from "../../src/contracts/scene.js";
import { createScene, Transform } from "../../src/scene/index.js";
import { findStaleWorldMatrices, subtreeSize } from "./transformFixture.js";

const ENTITY_COUNT = 40;
const RUNS = 250;

const REAL = fc.double({
  min: -10,
  max: 10,
  noNaN: true,
  noDefaultInfinity: true,
});

// Positive scales >= 1 keep the product along a deep chain well conditioned,
// so a missed mark can never be annihilated to sub-tolerance. Rotations are
// normalized before use so `quatToMat4` always takes its non-degenerate path.
const SCALE = fc.double({
  min: 1,
  max: 3,
  noNaN: true,
  noDefaultInfinity: true,
});

const TRS = fc.record({
  position: fc.record({ x: REAL, y: REAL, z: REAL }),
  rotation: fc.record({ x: REAL, y: REAL, z: REAL, w: REAL }),
  scale: fc.record({ x: SCALE, y: SCALE, z: SCALE }),
});

type Trs = { position: Vec3; rotation: Quat; scale: Vec3 };

const SCENARIO = fc.record({
  rawParents: fc.array(fc.integer({ min: 0, max: 1_000 }), {
    minLength: ENTITY_COUNT,
    maxLength: ENTITY_COUNT,
  }),
  transforms: fc.array(TRS, {
    minLength: ENTITY_COUNT,
    maxLength: ENTITY_COUNT,
  }),
  leafPick: fc.integer({ min: 0, max: ENTITY_COUNT - 1 }),
  rootPick: fc.integer({ min: 0, max: ENTITY_COUNT - 1 }),
});

/** `parents[i] < i`, so the generated forest is acyclic and parents first. */
function buildParents(rawParents: number[]): number[] {
  const parents = new Array<number>(ENTITY_COUNT);
  for (let index = 0; index < ENTITY_COUNT; index += 1) {
    parents[index] = (rawParents[index]! % (index + 1)) - 1;
  }
  return parents;
}

/** Unit quaternion, falling back to identity for a near-zero generator hit. */
function unitRotation(rotation: Quat): Quat {
  const length = Math.sqrt(
    rotation.x * rotation.x +
      rotation.y * rotation.y +
      rotation.z * rotation.z +
      rotation.w * rotation.w,
  );
  if (length < 1e-6) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: rotation.x / length,
    y: rotation.y / length,
    z: rotation.z / length,
    w: rotation.w / length,
  };
}

function applyTrs(scene: ReturnType<typeof createScene>, entity: Entity, trs: Trs): void {
  scene.setTransform(entity, trs.position, unitRotation(trs.rotation), trs.scale);
}

function reaches(parents: number[], node: number, ancestor: number): boolean {
  let current = node;
  let guard = 0;
  while (current !== -1 && guard <= ENTITY_COUNT) {
    if (current === ancestor) return true;
    current = parents[current]!;
    guard += 1;
  }
  return false;
}

function modelSubtreeSize(parents: number[], rootId: number): number {
  let count = 0;
  for (let id = 0; id < ENTITY_COUNT; id += 1) {
    if (reaches(parents, id, rootId)) count += 1;
  }
  return count;
}

test("[ER-03-06] 10,000 random TRS hierarchies match full recompute and exact dirty counts", () => {
  fc.assert(
    fc.property(SCENARIO, (scenario) => {
      const scene = createScene({ devChecks: true });
      const entities: Entity[] = [];
      for (let index = 0; index < ENTITY_COUNT; index += 1) {
        entities.push(scene.createEntity());
      }

      const parents = buildParents(scenario.rawParents);
      for (let index = 0; index < ENTITY_COUNT; index += 1) {
        applyTrs(scene, entities[index]!, scenario.transforms[index]! as Trs);
      }
      for (let index = 1; index < ENTITY_COUNT; index += 1) {
        const parent = parents[index]!;
        if (parent >= 0) {
          scene.setParent(entities[index]!, entities[parent]!);
        }
      }

      expect(scene.updateWorldTransforms()).toBe(ENTITY_COUNT);
      expect(findStaleWorldMatrices(scene)).toEqual([]);

      // A moved leaf recomputes exactly one matrix.
      const children: Entity[] = [];
      const leaves = entities.filter((entity) => {
        scene.childrenOf(entity, children);
        return children.length === 0;
      });
      expect(leaves.length).toBeGreaterThanOrEqual(1);
      const leaf = leaves[scenario.leafPick % leaves.length]!;
      applyTrs(scene, leaf, scenario.transforms[(scenario.leafPick + 1) % ENTITY_COUNT]! as Trs);
      expect(scene.updateWorldTransforms()).toBe(1);
      expect(findStaleWorldMatrices(scene)).toEqual([]);

      // A moved root recomputes exactly its subtree.
      const roots = entities.filter((entity) => scene.parentOf(entity) === null);
      expect(roots.length).toBeGreaterThanOrEqual(1);
      const root = roots[scenario.rootPick % roots.length]!;
      const rootId = entities.indexOf(root);
      const expectedSize = modelSubtreeSize(parents, rootId);
      applyTrs(scene, root, scenario.transforms[(scenario.rootPick + 2) % ENTITY_COUNT]! as Trs);
      expect(scene.updateWorldTransforms()).toBe(expectedSize);
      expect(findStaleWorldMatrices(scene)).toEqual([]);

      // A missed mark is caught; the true state count is its subtree size.
      const missed = entities[(scenario.leafPick * 7 + scenario.rootPick * 3) % ENTITY_COUNT]!;
      const transform = scene.get(missed, Transform)!;
      transform.position.x += 3;
      expect(scene.updateWorldTransforms()).toBe(0);
      expect(findStaleWorldMatrices(scene)).toContain(missed.id);

      const actualSize = subtreeSize(scene, missed);
      scene.markTransformDirty(missed);
      expect(scene.updateWorldTransforms()).toBe(actualSize);
      expect(findStaleWorldMatrices(scene)).toEqual([]);
    }),
    { numRuns: RUNS, seed: 20261023 },
  );
});

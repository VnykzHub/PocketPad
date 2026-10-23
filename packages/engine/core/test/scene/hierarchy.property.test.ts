/**
 * Randomized hierarchy conformance (03 §3.7, ER-03-05).
 *
 * Ten runs of 1,000 accepted/rejected `setParent` operations (10,000 total)
 * against an independent parent/child-list model. Production mode is used so
 * rejections return `false` instead of throwing to the property driver.
 */

import fc from "fast-check";
import { expect, test } from "vitest";
import type { Entity } from "../../src/contracts/scene.js";
import { createScene } from "../../src/scene/index.js";

const ENTITY_COUNT = 40;
const RUNS = 10;
const OPS_PER_RUN = 1_000;

const LINK = fc.record({
  child: fc.integer({ min: 0, max: ENTITY_COUNT - 1 }),
  parent: fc.integer({ min: -1, max: ENTITY_COUNT - 1 }),
});

function modelRoot(parents: number[], id: number): number {
  let current = id;
  let guard = 0;
  while (parents[current]! !== -1 && guard <= ENTITY_COUNT) {
    current = parents[current]!;
    guard += 1;
  }
  return current;
}

function isAncestorOrSelf(parents: number[], ancestor: number, id: number): boolean {
  let current = id;
  let guard = 0;
  while (current !== -1 && guard <= ENTITY_COUNT) {
    if (current === ancestor) return true;
    current = parents[current]!;
    guard += 1;
  }
  return false;
}

test("[ER-03-05] 10,000 randomized setParent operations keep the forest valid", () => {
  fc.assert(
    fc.property(
      fc.array(LINK, { minLength: OPS_PER_RUN, maxLength: OPS_PER_RUN }),
      (operations) => {
        const scene = createScene({ devChecks: false });
        const entities: Entity[] = [];
        for (let index = 0; index < ENTITY_COUNT; index += 1) {
          entities.push(scene.createEntity());
        }

        const parents = new Array<number>(ENTITY_COUNT).fill(-1);
        const childLists: number[][] = [];
        for (let index = 0; index < ENTITY_COUNT; index += 1) childLists.push([]);

        const out: Entity[] = [];
        for (let opIndex = 0; opIndex < operations.length; opIndex += 1) {
          const operation = operations[opIndex]!;
          const { child, parent } = operation;
          const childEntity = entities[child]!;
          const parentEntity = parent === -1 ? null : entities[parent]!;

          let expected: boolean;
          if (parent === child) {
            expected = false;
          } else if (parent !== -1 && isAncestorOrSelf(parents, child, parent)) {
            expected = false;
          } else {
            expected = true;
          }

          const actual = scene.setParent(childEntity, parentEntity);
          if (actual !== expected) {
            throw new Error(
              `op ${opIndex}: setParent(${child}, ${parent}) returned ${String(actual)}, expected ${String(expected)}`,
            );
          }

          if (expected) {
            const previous = parents[child]!;
            if (previous !== -1) {
              const siblings = childLists[previous]!;
              const at = siblings.indexOf(child);
              if (at < 0) throw new Error(`op ${opIndex}: model lost child ${child}`);
              siblings.splice(at, 1);
            }
            if (parent === -1) {
              parents[child] = -1;
            } else {
              childLists[parent]!.push(child);
              parents[child] = parent;
            }
          }

          const parentNow = scene.parentOf(childEntity);
          const expectedParent = parents[child]!;
          if (
            (expectedParent === -1 && parentNow !== null) ||
            (expectedParent !== -1 && parentNow !== entities[expectedParent])
          ) {
            throw new Error(`op ${opIndex}: parentOf(${child}) is wrong`);
          }

          const expectedRoot = modelRoot(parents, child);
          const actualRoot = scene.rootOf(childEntity);
          if (actualRoot !== entities[expectedRoot]) {
            throw new Error(
              `op ${opIndex}: rootOf(${child}) = ${actualRoot.id}, expected ${expectedRoot}`,
            );
          }

          const expectedChildren = childLists[child]!;
          scene.childrenOf(childEntity, out);
          if (out.length !== expectedChildren.length) {
            throw new Error(
              `op ${opIndex}: child ${child} has ${out.length} children, expected ${expectedChildren.length}`,
            );
          }
          for (let index = 0; index < out.length; index += 1) {
            if (out[index] !== entities[expectedChildren[index]!]) {
              throw new Error(`op ${opIndex}: child list of ${child} disagrees`);
            }
          }
        }

        // Final full-forest check: every parent edge and child list.
        for (let id = 0; id < ENTITY_COUNT; id += 1) {
          const parent = scene.parentOf(entities[id]!);
          if (parents[id]! === -1) {
            if (parent !== null) throw new Error(`final: entity ${id} has a parent`);
          } else if (parent !== entities[parents[id]!]) {
            throw new Error(`final: entity ${id} parent mismatch`);
          }
          scene.childrenOf(entities[id]!, out);
          const expected = childLists[id]!;
          if (out.length !== expected.length) {
            throw new Error(`final: entity ${id} child count mismatch`);
          }
          for (let index = 0; index < out.length; index += 1) {
            if (out[index] !== entities[expected[index]!]) {
              throw new Error(`final: entity ${id} child order mismatch`);
            }
          }
        }

        expect(scene.aliveCount).toBe(ENTITY_COUNT);
      },
    ),
    { numRuns: RUNS, seed: 20261023 },
  );
});

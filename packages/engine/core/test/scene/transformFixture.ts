/**
 * Test-only transform fixture (03 §8, ER-03-06).
 *
 * The dev full-recompute validator recomputes every world matrix from TRS in
 * a topological order and reports entities whose cached matrix drifted. It is
 * deliberately kept outside `src/` so production never pays for it.
 */

import type { Mat4 } from "../../src/contracts/math.js";
import type { EngineScene, Entity } from "../../src/contracts/scene.js";
import { mat4Compose, mat4Create, mat4Multiply } from "../../src/math/index.js";
import { Transform } from "../../src/scene/index.js";

export const TRANSFORM_TOLERANCE = 1e-5;

export function matrixMaxDelta(
  actual: Mat4,
  expected: Mat4,
  tolerance = TRANSFORM_TOLERANCE,
): number {
  let delta = 0;
  for (let index = 0; index < 16; index += 1) {
    const difference = Math.abs(actual.m[index]! - expected.m[index]!);
    if (difference > delta) delta = difference;
  }
  return delta > tolerance ? delta : 0;
}

/** Entities whose cached world matrix differs from a full recompute. */
export function findStaleWorldMatrices(scene: EngineScene): number[] {
  const entities = scene.queryAll([], Transform);
  const depths = new Map<number, number>();
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index]!;
    let depth = 1;
    let parent = scene.parentOf(entity);
    let guard = 0;
    while (parent !== null && guard <= entities.length) {
      depth += 1;
      parent = scene.parentOf(parent);
      guard += 1;
    }
    depths.set(entity.id, depth);
  }

  const ordered = entities
    .slice()
    .sort((left, right) => depths.get(left.id)! - depths.get(right.id)!);
  const expected = new Map<number, Mat4>();
  const stale: number[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const entity = ordered[index]!;
    const transform = scene.get(entity, Transform);
    if (transform === undefined) continue;
    const local = mat4Compose(
      mat4Create(),
      transform.position,
      transform.rotation,
      transform.scale,
    );
    const parent = scene.parentOf(entity);
    let world = local;
    if (parent !== null) {
      const parentWorld = expected.get(parent.id);
      if (parentWorld === undefined) {
        stale.push(entity.id);
        continue;
      }
      world = mat4Multiply(mat4Create(), parentWorld, local);
    }
    expected.set(entity.id, world);
    const actual = scene.worldMatrix(entity);
    if (actual === undefined || matrixMaxDelta(actual, world) !== 0) {
      stale.push(entity.id);
    }
  }
  return stale;
}

/** Number of nodes in the subtree rooted at `root`, including `root`. */
export function subtreeSize(scene: EngineScene, root: Entity): number {
  let count = 0;
  const stack: Entity[] = [root];
  const out: Entity[] = [];
  while (stack.length > 0) {
    const entity = stack.pop()!;
    count += 1;
    scene.childrenOf(entity, out);
    for (let index = 0; index < out.length; index += 1) {
      stack.push(out[index]!);
    }
  }
  return count;
}

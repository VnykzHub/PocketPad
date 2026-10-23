/**
 * Transform composition and dirty semantics (03 §3.7, §5.6, ER-03-06).
 *
 * Deterministic cases for T*R*S composition, parent multiplication, exact
 * recompute counts, dirty reads, direct-mutation rules and non-finite values.
 * The 10,000-hierarchy sweep lives in `transform.property.test.ts`.
 */

import { expect, test } from "vitest";
import type { Mat4, Quat, Vec3 } from "../../src/contracts/math.js";
import type { SceneStats } from "../../src/contracts/scene.js";
import { mat4Compose, mat4Create, mat4Multiply } from "../../src/math/index.js";
import { createScene, Transform } from "../../src/scene/index.js";
import { SceneEngineError } from "../../src/scene/errors.js";
import { findStaleWorldMatrices, matrixMaxDelta } from "./transformFixture.js";

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/** Quaternion for a rotation of `degrees` about +Y. */
function quatY(degrees: number): Quat {
  const half = (degrees * Math.PI) / 360;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
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

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof SceneEngineError ? error.code : undefined;
  }
}

function expectMatrix(actual: Mat4 | undefined, expected: Mat4): void {
  expect(actual).toBeDefined();
  expect(matrixMaxDelta(actual!, expected)).toBe(0);
}

test("[ER-03-06] a fresh entity has an identity Transform and identity world matrix", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();
  const transform = scene.get(entity, Transform)!;

  expect(transform.position).toEqual({ x: 0, y: 0, z: 0 });
  expect(transform.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  expect(transform.scale).toEqual({ x: 1, y: 1, z: 1 });
  expect(scene.updateWorldTransforms()).toBe(1);

  const expected = mat4Compose(
    mat4Create(),
    { x: 0, y: 0, z: 0 },
    IDENTITY,
    { x: 1, y: 1, z: 1 },
  );
  expectMatrix(scene.worldMatrix(entity), expected);
  expect(scene.updateWorldTransforms()).toBe(0);
});

test("[ER-03-06] a root world matrix composes translation, rotation and scale", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();
  const position = vec(1, 2, 3);
  const rotation = quatY(90);
  const scale = vec(2, 3, 4);

  scene.setTransform(entity, position, rotation, scale);
  expect(scene.updateWorldTransforms()).toBe(1);

  const expected = mat4Compose(mat4Create(), position, rotation, scale);
  const actual = scene.worldMatrix(entity);
  expectMatrix(actual, expected);

  // Column-major translation lives in m[12..14] and is unaffected by T*R*S.
  expect(actual!.m[12]).toBeCloseTo(1, 5);
  expect(actual!.m[13]).toBeCloseTo(2, 5);
  expect(actual!.m[14]).toBeCloseTo(3, 5);
});

test("[ER-03-06] a child world matrix is parentWorld × local", () => {
  const scene = createScene({ devChecks: true });
  const parent = scene.createEntity();
  const child = scene.createEntity();
  const parentPosition = vec(10, 20, 30);
  const childPosition = vec(1, 2, 3);

  scene.setTransform(parent, parentPosition, IDENTITY, vec(1, 1, 1));
  scene.setTransform(child, childPosition, IDENTITY, vec(1, 1, 1));
  scene.setParent(child, parent);

  expect(scene.updateWorldTransforms()).toBe(2);

  const parentLocal = mat4Compose(mat4Create(), parentPosition, IDENTITY, vec(1, 1, 1));
  const childLocal = mat4Compose(mat4Create(), childPosition, IDENTITY, vec(1, 1, 1));
  const expected = mat4Multiply(mat4Create(), parentLocal, childLocal);
  const actual = scene.worldMatrix(child);
  expectMatrix(actual, expected);

  expect(actual!.m[12]).toBeCloseTo(11, 5);
  expect(actual!.m[13]).toBeCloseTo(22, 5);
  expect(actual!.m[14]).toBeCloseTo(33, 5);
});

test("[ER-03-06] setParent marks exactly the moved subtree world-dirty", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const middle = scene.createEntity();
  const leaf = scene.createEntity();
  scene.setParent(middle, root);
  scene.setParent(leaf, middle);

  expect(scene.updateWorldTransforms()).toBe(3);
  expect(scene.updateWorldTransforms()).toBe(0);

  scene.setParent(middle, null);
  expect(scene.updateWorldTransforms()).toBe(2);
  expect(scene.updateWorldTransforms()).toBe(0);

  scene.setParent(middle, root);
  expect(scene.updateWorldTransforms()).toBe(2);

  scene.setParent(leaf, middle);
  expect(scene.updateWorldTransforms()).toBe(1);
  expect(scene.updateWorldTransforms()).toBe(0);
});

test("[ER-03-06] setTransform marks exactly the entity subtree", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const middle = scene.createEntity();
  const leaf = scene.createEntity();
  scene.setParent(middle, root);
  scene.setParent(leaf, middle);

  expect(scene.updateWorldTransforms()).toBe(3);

  scene.setTransform(root, vec(1, 0, 0), IDENTITY, vec(1, 1, 1));
  expect(scene.updateWorldTransforms()).toBe(3);

  scene.setTransform(middle, vec(0, 1, 0), IDENTITY, vec(1, 1, 1));
  expect(scene.updateWorldTransforms()).toBe(2);

  scene.setTransform(leaf, vec(0, 0, 1), IDENTITY, vec(1, 1, 1));
  expect(scene.updateWorldTransforms()).toBe(1);
  expect(scene.updateWorldTransforms()).toBe(0);
});

test("[ER-03-06] a direct mutation needs markTransformDirty", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const child = scene.createEntity();
  scene.setParent(child, root);
  expect(scene.updateWorldTransforms()).toBe(2);

  const childWorld = scene.worldMatrix(child)!;
  const before = childWorld.m[13];
  scene.get(child, Transform)!.position.y = 5;

  // Without the mark the cached matrix legitimately does not move.
  expect(scene.updateWorldTransforms()).toBe(0);
  expect(scene.worldMatrix(child)!.m[13]).toBe(before);

  scene.markTransformDirty(child);
  expect(scene.updateWorldTransforms()).toBe(1);
  expect(scene.worldMatrix(child)!.m[13]).toBeCloseTo(5, 5);
  expect(findStaleWorldMatrices(scene)).toEqual([]);
});

test("[ER-03-06] the full-recompute validator detects a missed mark", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const middle = scene.createEntity();
  const leaf = scene.createEntity();
  scene.setParent(middle, root);
  scene.setParent(leaf, middle);
  scene.updateWorldTransforms();
  expect(findStaleWorldMatrices(scene)).toEqual([]);

  scene.get(middle, Transform)!.position.x = 7;
  expect(scene.updateWorldTransforms()).toBe(0);

  const stale = findStaleWorldMatrices(scene);
  expect(stale).toContain(middle.id);
  expect(stale).toContain(leaf.id);

  scene.markTransformDirty(middle);
  expect(scene.updateWorldTransforms()).toBe(2);
  expect(findStaleWorldMatrices(scene)).toEqual([]);
});

test("[ER-03-06] reading a world-dirty matrix increments dirtyReadCount", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();

  expect(scene.getStats(makeStats()).dirtyReadCount).toBe(0);
  expect(scene.worldMatrix(entity)).toBeDefined();
  expect(scene.getStats(makeStats()).dirtyReadCount).toBe(1);

  scene.updateWorldTransforms();
  scene.worldMatrix(entity);
  expect(scene.getStats(makeStats()).dirtyReadCount).toBe(1);

  scene.setTransform(entity, vec(1, 1, 1), IDENTITY, vec(1, 1, 1));
  scene.worldMatrix(entity);
  expect(scene.getStats(makeStats()).dirtyReadCount).toBe(2);

  scene.updateWorldTransforms();
  scene.worldMatrix(entity);
  expect(scene.getStats(makeStats()).dirtyReadCount).toBe(2);
});

test("[ER-03-06] setTransform copies values and mutates the stored object", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();
  const position = vec(1, 2, 3);
  const rotation = quatY(45);
  const scale = vec(2, 2, 2);
  const stored = scene.get(entity, Transform)!;

  scene.setTransform(entity, position, rotation, scale);
  expect(scene.get(entity, Transform)).toBe(stored);
  expect(stored.position).toEqual({ x: 1, y: 2, z: 3 });

  position.x = 99;
  rotation.w = 99;
  scale.z = 99;
  expect(stored.position.x).toBe(1);
  expect(stored.rotation.w).toBeCloseTo(Math.cos(Math.PI / 8), 10);
  expect(stored.scale.z).toBe(2);
});

test("[ER-03-06] dev rejects non-finite transforms with E_SCENE_INVALID", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();

  expect(
    codeOf(() =>
      scene.setTransform(entity, { x: Number.NaN, y: 0, z: 0 }, IDENTITY, vec(1, 1, 1)),
    ),
  ).toBe("E_SCENE_INVALID");
  expect(scene.get(entity, Transform)!.position.x).toBe(0);

  expect(
    codeOf(() =>
      scene.add(entity, Transform, {
        position: vec(0, Number.POSITIVE_INFINITY, 0),
        rotation: IDENTITY,
        scale: vec(1, 1, 1),
      }),
    ),
  ).toBe("E_SCENE_INVALID");
  expect(scene.get(entity, Transform)!.position.y).toBe(0);
});

test("[ER-03-06] production stores non-finite transforms and counts them", () => {
  const scene = createScene({ devChecks: false });
  const entity = scene.createEntity();

  expect(() =>
    scene.setTransform(entity, { x: Number.NaN, y: 0, z: 0 }, IDENTITY, vec(1, 1, 1)),
  ).not.toThrow();
  expect(Number.isNaN(scene.get(entity, Transform)!.position.x)).toBe(true);
  expect(scene.getStats(makeStats()).rejectedOperationCount).toBe(1);

  scene.add(entity, Transform, {
    position: vec(0, Number.POSITIVE_INFINITY, 0),
    rotation: IDENTITY,
    scale: vec(1, 1, 1),
  });
  expect(scene.get(entity, Transform)!.position.y).toBe(Number.POSITIVE_INFINITY);
  expect(scene.getStats(makeStats()).rejectedOperationCount).toBe(2);
});

test("[ER-03-06] removing Transform is forbidden", () => {
  const dev = createScene({ devChecks: true });
  const devEntity = dev.createEntity();
  expect(codeOf(() => dev.remove(devEntity, Transform))).toBe("E_SCENE_INVALID");
  expect(dev.has(devEntity, Transform)).toBe(true);

  const prod = createScene({ devChecks: false });
  const prodEntity = prod.createEntity();
  expect(() => prod.remove(prodEntity, Transform)).not.toThrow();
  expect(prod.has(prodEntity, Transform)).toBe(true);
  expect(prod.getStats(makeStats()).rejectedOperationCount).toBe(1);
});

test("[ER-03-06] worldMatrix is undefined for a dead entity", () => {
  const scene = createScene({ devChecks: false });
  const entity = scene.createEntity();
  scene.destroyEntity(entity);
  expect(scene.worldMatrix(entity)).toBeUndefined();
});

/**
 * Query semantics (03 §3.6, §5.4, ER-03-03).
 *
 * Pins driver selection, disabled filtering, zero-type scans, handle identity
 * and output-array reuse. The randomized comparison lives in
 * `query.property.test.ts`; this file is the deterministic contract.
 */

import { expect, test } from "vitest";
import type { Entity } from "../../src/contracts/scene.js";
import {
  createScene,
  defineComponent,
  Parent,
  Renderable,
} from "../../src/scene/index.js";

interface Tag {
  value: number;
}

interface Other {
  value: number;
}

const TagType = defineComponent<Tag>({
  name: "test.query.tag",
  create: () => ({ value: 0 }),
});

const OtherType = defineComponent<Other>({
  name: "test.query.other",
  create: () => ({ value: 0 }),
});

function renderable(mesh: string): { mesh: string; material: string; visible: boolean; layer: number } {
  return { mesh, material: "materials/default", visible: true, layer: 0 };
}

test("[ER-03-03] query uses the smallest column and the earliest argument breaks ties", () => {
  const scene = createScene({ devChecks: true });
  const entities = [0, 1, 2].map(() => scene.createEntity());
  const [first, second, third] = entities as [Entity, Entity, Entity];

  // Equal counts (3 each) with different insertion orders.
  scene.add(first, TagType, { value: 1 });
  scene.add(second, TagType, { value: 2 });
  scene.add(third, TagType, { value: 3 });
  scene.add(third, OtherType, { value: 30 });
  scene.add(first, OtherType, { value: 10 });
  scene.add(second, OtherType, { value: 20 });

  // Tag's dense order is [first, second, third]; Other's is [third, first, second].
  const tagFirst = scene.query([], TagType, OtherType);
  expect(tagFirst.map((entity) => entity.id)).toEqual([
    first.id,
    second.id,
    third.id,
  ]);

  const otherFirst = scene.query([], OtherType, TagType);
  expect(otherFirst.map((entity) => entity.id)).toEqual([
    third.id,
    first.id,
    second.id,
  ]);
});

test("[ER-03-03] query skips disabled entities while queryAll includes them", () => {
  const scene = createScene({ devChecks: true });
  const first = scene.createEntity();
  const second = scene.createEntity();
  const third = scene.createEntity();
  scene.add(first, TagType, { value: 1 });
  scene.add(second, TagType, { value: 2 });
  scene.add(third, TagType, { value: 3 });
  scene.setEnabled(second, false);

  expect(scene.query([], TagType).map((entity) => entity.id)).toEqual([
    first.id,
    third.id,
  ]);
  expect(scene.queryAll([], TagType).map((entity) => entity.id)).toEqual([
    first.id,
    second.id,
    third.id,
  ]);
  expect(scene.queryCount(TagType)).toBe(2);
});

test("[ER-03-03] a disabled entity is excluded even when it matches every type", () => {
  const scene = createScene({ devChecks: true });
  const first = scene.createEntity();
  const second = scene.createEntity();
  scene.add(first, TagType, { value: 1 });
  scene.add(first, OtherType, { value: 2 });
  scene.add(second, TagType, { value: 3 });
  scene.add(second, OtherType, { value: 4 });
  scene.setEnabled(first, false);

  expect(scene.query([], TagType, OtherType).map((entity) => entity.id)).toEqual([
    second.id,
  ]);
  expect(scene.queryAll([], TagType, OtherType).map((entity) => entity.id)).toEqual([
    first.id,
    second.id,
  ]);
});

test("[ER-03-03] a zero-type query scans live ids in ascending order", () => {
  const scene = createScene({ devChecks: true });
  const entities = [0, 1, 2, 3, 4].map(() => scene.createEntity());
  scene.setEnabled(entities[2]!, false);
  scene.destroyEntity(entities[1]!);
  scene.destroyEntity(entities[3]!);

  expect(scene.query([]).map((entity) => entity.id)).toEqual([0, 4]);
  expect(scene.queryAll([]).map((entity) => entity.id)).toEqual([0, 2, 4]);
  expect(scene.queryCount()).toBe(2);
});

test("[ER-03-03] query writes into the caller array and keeps its identity", () => {
  const scene = createScene({ devChecks: true });
  const first = scene.createEntity();
  const second = scene.createEntity();
  scene.add(first, TagType, { value: 1 });
  scene.add(second, TagType, { value: 2 });

  const out: Entity[] = [{ id: 99, generation: 1 }];
  const result = scene.query(out, TagType);
  expect(result).toBe(out);
  expect(out.length).toBe(2);
  expect(out.map((entity) => entity.id)).toEqual([first.id, second.id]);

  scene.destroyEntity(first);
  expect(scene.query(out, TagType)).toBe(out);
  expect(out.length).toBe(1);
  expect(out[0]?.id).toBe(second.id);
});

test("[ER-03-03] query emits the existing frozen handle objects", () => {
  const scene = createScene({ devChecks: true });
  const first = scene.createEntity();
  const second = scene.createEntity();
  scene.add(first, TagType, { value: 1 });
  scene.add(second, TagType, { value: 2 });

  const out: Entity[] = [];
  scene.query(out, TagType);
  expect(out[0]).toBe(first);
  expect(out[1]).toBe(second);
  expect(Object.isFrozen(out[0])).toBe(true);
});

test("[ER-03-03] Parent is queryable without a component store", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const child = scene.createEntity();
  const secondChild = scene.createEntity();
  scene.setParent(child, root);
  scene.setParent(secondChild, root);
  scene.add(secondChild, Renderable, renderable("meshes/child"));
  scene.setEnabled(secondChild, false);

  expect(scene.query([], Parent).map((entity) => entity.id)).toEqual([child.id]);
  expect(scene.queryAll([], Parent).map((entity) => entity.id)).toEqual([
    child.id,
    secondChild.id,
  ]);

  const both: Entity[] = [];
  scene.query(both, Parent, Renderable);
  expect(both).toEqual([]);
  expect(scene.queryAll([], Parent, Renderable).map((entity) => entity.id)).toEqual([
    secondChild.id,
  ]);
});

test("[ER-03-03] duplicate type arguments do not duplicate results", () => {
  const scene = createScene({ devChecks: true });
  const first = scene.createEntity();
  const second = scene.createEntity();
  scene.add(first, TagType, { value: 1 });
  scene.add(second, TagType, { value: 2 });

  expect(scene.query([], TagType, TagType).map((entity) => entity.id)).toEqual([
    first.id,
    second.id,
  ]);
  expect(scene.queryCount(TagType, TagType)).toBe(2);
});

test("[ER-03-03] a type with no column yields an empty result", () => {
  const scene = createScene({ devChecks: true });
  scene.createEntity();
  const fake = {
    id: 4094,
    name: "test.query.unregistered",
    serializable: false,
    create: () => ({ value: 0 }),
  };

  expect(scene.query([], fake)).toEqual([]);
  expect(scene.queryAll([], fake)).toEqual([]);
  expect(scene.queryCount(fake)).toBe(0);
});

test("[ER-03-03] queryCount agrees with both query variants", () => {
  const scene = createScene({ devChecks: true });
  for (let index = 0; index < 20; index += 1) {
    const entity = scene.createEntity();
    if (index % 2 === 0) scene.add(entity, TagType, { value: index });
    if (index % 3 === 0) scene.add(entity, OtherType, { value: index });
    if (index % 5 === 0) scene.setEnabled(entity, false);
  }

  const queryLength = scene.query([], TagType, OtherType).length;
  const allLength = scene.queryAll([], TagType, OtherType).length;
  expect(scene.queryCount(TagType, OtherType)).toBe(queryLength);
  expect(queryLength).toBeLessThanOrEqual(allLength);
});

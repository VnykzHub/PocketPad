/**
 * Sparse-set component semantics (03 §3.2, §3.4, §5.3, ER-03-02).
 *
 * The property test drives 100 × 100 operations against a reference `Map`;
 * the unit cases pin replacement, removal and destroy callback ordering.
 */

import fc from "fast-check";
import { beforeEach, expect, test } from "vitest";
import type { ComponentType } from "../../src/contracts/scene.js";
import {
  createScene,
  defineComponent,
  Renderable,
  Transform,
} from "../../src/scene/index.js";
import { SceneEngineError } from "../../src/scene/errors.js";

interface Counter {
  value: number;
}

interface Marker {
  value: number;
}

const removeEvents: Array<{ value: number; entityId: number }> = [];
const destroyOrder: string[] = [];

const COUNTER_NAME = "test.counter";

const CounterType = defineComponent<Counter>({
  name: COUNTER_NAME,
  create: () => ({ value: 0 }),
  serialize: (value) => ({ value: value.value }),
  deserialize: (data) => {
    const record = data as { value?: unknown };
    return { value: typeof record.value === "number" ? record.value : 0 };
  },
  reset: (out, data) => {
    out.value = (data as Counter).value;
  },
  onRemove: (value, entity) => {
    removeEvents.push({ value: value.value, entityId: entity.id });
  },
});

const FIRST_NAME = "test.first";
const SECOND_NAME = "test.second";

const FirstType = defineComponent<Marker>({
  name: FIRST_NAME,
  create: () => ({ value: 0 }),
  onRemove: () => {
    destroyOrder.push("first");
  },
});

const SecondType = defineComponent<Marker>({
  name: SECOND_NAME,
  create: () => ({ value: 0 }),
  onRemove: () => {
    destroyOrder.push("second");
  },
});

function renderable(mesh: string): { mesh: string; material: string; visible: boolean; layer: number } {
  return { mesh, material: "materials/default", visible: true, layer: 0 };
}

beforeEach(() => {
  removeEvents.length = 0;
  destroyOrder.length = 0;
});

test("[ER-03-02] add/get/has/remove follow the component map", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();

  expect(scene.has(entity, CounterType)).toBe(false);
  expect(scene.get(entity, CounterType)).toBeUndefined();

  const first = { value: 7 };
  scene.add(entity, CounterType, first);
  expect(scene.has(entity, CounterType)).toBe(true);
  expect(scene.get(entity, CounterType)).toBe(first);

  const replacement = { value: 9 };
  scene.add(entity, CounterType, replacement);
  expect(scene.get(entity, CounterType)).toBe(replacement);
  expect(removeEvents).toEqual([{ value: 7, entityId: entity.id }]);

  scene.remove(entity, CounterType);
  expect(scene.has(entity, CounterType)).toBe(false);
  expect(scene.get(entity, CounterType)).toBeUndefined();
  expect(removeEvents).toEqual([
    { value: 7, entityId: entity.id },
    { value: 9, entityId: entity.id },
  ]);
});

test("[ER-03-02] removing an absent component is a no-op", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();

  expect(() => scene.remove(entity, CounterType)).not.toThrow();
  expect(removeEvents).toEqual([]);
  expect(scene.has(entity, CounterType)).toBe(false);
});

test("[ER-03-02] replacement calls onRemove exactly once with the old value", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();

  for (let value = 1; value <= 5; value += 1) {
    scene.add(entity, CounterType, { value });
  }

  expect(removeEvents.map((event) => event.value)).toEqual([1, 2, 3, 4]);
  expect(removeEvents.every((event) => event.entityId === entity.id)).toBe(true);
  expect(scene.get(entity, CounterType)?.value).toBe(5);
});

test("[ER-03-02] destroy runs onRemove in ascending component id order", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();

  // Add in reverse id order; the destroy walk must still be id-ascending.
  scene.add(entity, SecondType, { value: 2 });
  scene.add(entity, FirstType, { value: 1 });

  scene.destroyEntity(entity);
  expect(destroyOrder).toEqual(["first", "second"]);
});

test("[ER-03-02] column is dense, includes disabled entities and exposes flags", () => {
  const scene = createScene({ devChecks: true });
  const first = scene.createEntity();
  const second = scene.createEntity();
  scene.add(first, Renderable, renderable("meshes/first"));
  scene.add(second, Renderable, renderable("meshes/second"));
  scene.setEnabled(first, false);

  const column = scene.column(Renderable);
  expect(column.type).toBe(Renderable);
  expect(column.count).toBe(2);
  expect(Array.from(column.entityIds.subarray(0, column.count))).toEqual([
    first.id,
    second.id,
  ]);
  expect(column.values[0]?.mesh).toBe("meshes/first");
  expect(column.values[1]?.mesh).toBe("meshes/second");
  expect(column.enabled[first.id]).toBe(0);
  expect(column.enabled[second.id]).toBe(1);
});

test("[ER-03-02] remove is swap-remove and keeps values paired with ids", () => {
  const scene = createScene({ devChecks: true });
  const first = scene.createEntity();
  const second = scene.createEntity();
  const third = scene.createEntity();
  scene.add(first, Renderable, renderable("meshes/a"));
  scene.add(second, Renderable, renderable("meshes/b"));
  scene.add(third, Renderable, renderable("meshes/c"));

  scene.remove(second, Renderable);

  let column = scene.column(Renderable);
  expect(column.count).toBe(2);
  expect(Array.from(column.entityIds.subarray(0, column.count))).toEqual([
    first.id,
    third.id,
  ]);
  expect(column.values[0]?.mesh).toBe("meshes/a");
  expect(column.values[1]?.mesh).toBe("meshes/c");

  scene.add(second, Renderable, renderable("meshes/d"));
  column = scene.column(Renderable);
  expect(Array.from(column.entityIds.subarray(0, column.count))).toEqual([
    first.id,
    third.id,
    second.id,
  ]);
  expect(column.values[2]?.mesh).toBe("meshes/d");
});

test("[ER-03-02] every entity owns exactly one Transform", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();
  const original = scene.get(entity, Transform);

  expect(original).toBeDefined();
  expect(scene.has(entity, Transform)).toBe(true);
  scene.add(entity, Transform, {
    position: { x: 2, y: 3, z: 4 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  });
  expect(scene.get(entity, Transform)?.position.x).toBe(2);

  const beforeSet = scene.get(entity, Transform);
  scene.setTransform(
    entity,
    { x: 5, y: 6, z: 7 },
    { x: 0, y: 0, z: 0, w: 1 },
    { x: 1, y: 1, z: 1 },
  );
  expect(scene.get(entity, Transform)).toBe(beforeSet);
});

test("[ER-03-02] an unregistered component descriptor is refused", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();
  const fake = {
    id: 4095,
    name: "test.unregistered",
    serializable: false,
    create: () => ({ value: 0 }),
  } as ComponentType<Counter>;

  let code: string | undefined;
  try {
    scene.add(entity, fake, { value: 1 });
  } catch (error) {
    code = error instanceof SceneEngineError ? error.code : undefined;
  }
  expect(code).toBe("E_CONTRACT");
});

const OPERATION = fc.record({
  kind: fc.constantFrom("add", "remove", "get", "has"),
  entity: fc.integer({ min: 0, max: 7 }),
  value: fc.integer({ min: -1_000, max: 1_000 }),
});

test("[ER-03-02] 10,000 random operations match a reference map", () => {
  fc.assert(
    fc.property(fc.array(OPERATION, { minLength: 100, maxLength: 100 }), (operations) => {
      const scene = createScene({ devChecks: true });
      const entities = [] as ReturnType<typeof scene.createEntity>[];
      for (let index = 0; index < 8; index += 1) entities.push(scene.createEntity());
      const reference = new Map<number, number>();

      for (const operation of operations) {
        const entity = entities[operation.entity]!;
        if (operation.kind === "add") {
          scene.add(entity, CounterType, { value: operation.value });
          reference.set(entity.id, operation.value);
        } else if (operation.kind === "remove") {
          scene.remove(entity, CounterType);
          reference.delete(entity.id);
        } else if (operation.kind === "get") {
          const expected = reference.get(entity.id);
          const actual = scene.get(entity, CounterType);
          if (actual?.value !== expected) {
            throw new Error(
              `get(${entity.id}) returned ${String(actual?.value)}, expected ${String(expected)}`,
            );
          }
        } else {
          const expected = reference.has(entity.id);
          if (scene.has(entity, CounterType) !== expected) {
            throw new Error(`has(${entity.id}) disagreed with the reference map`);
          }
        }
      }

      expect(scene.column(CounterType).count).toBe(reference.size);
    }),
    { numRuns: 100, seed: 20261023 },
  );
});

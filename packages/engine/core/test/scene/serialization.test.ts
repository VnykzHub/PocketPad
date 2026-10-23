/**
 * Snapshot serialization golden and format tests (03 §3.8, §4.1, §4.3,
 * ER-03-09).
 *
 * The golden snapshot is the normative ordering fixture: pre-order DFS, roots
 * ascending, children insertion order, `transform` first then component ids
 * ascending. Refusal cases must leave a non-empty scene byte-identical.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type {
  SceneSnapshot,
  SceneStats,
  SerializedEntity,
} from "../../src/contracts/scene.js";
import {
  createScene,
  defineComponent,
  Name,
  Renderable,
  Transform,
} from "../../src/scene/index.js";
import { SceneEngineError } from "../../src/scene/errors.js";

const FIXTURE = JSON.parse(
  readFileSync(new URL("./fixtures/scene-golden.json", import.meta.url), "utf8"),
) as SceneSnapshot;

interface MutableRecord {
  parent: number | null;
  enabled?: false;
  components: Record<string, unknown>;
}

interface MutableSnapshot {
  formatVersion: number;
  entities: MutableRecord[];
}

/** Non-serializable component used to prove serialize refuses such values. */
const Transient = defineComponent<{ ticks: number }>({
  name: "test.serialization.transient",
  create: () => ({ ticks: 0 }),
});

function cloneFixture(): MutableSnapshot {
  return JSON.parse(JSON.stringify(FIXTURE)) as MutableSnapshot;
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

test("[ER-03-09] scene-golden.json round-trips with identical values, hierarchy and key order", () => {
  const scene = createScene({ devChecks: true });
  scene.load(FIXTURE);

  expect(scene.aliveCount).toBe(50);
  expect(scene.getStats(makeStats()).maxDepth).toBe(5);

  const serialized = scene.serialize();
  expect(JSON.stringify(serialized)).toBe(JSON.stringify(FIXTURE));
  expect(serialized.entities).toHaveLength(50);

  let roots = 0;
  const disabled: number[] = [];
  for (let index = 0; index < serialized.entities.length; index += 1) {
    const record = serialized.entities[index]!;
    if (record.parent === null) roots += 1;
    else expect(record.parent).toBeLessThan(index);
    if (record.enabled === false) disabled.push(index);
    expect(Object.keys(record)).toEqual(
      record.enabled === false
        ? ["parent", "enabled", "components"]
        : ["parent", "components"],
    );
    expect(Object.keys(record.components)).toEqual([
      "transform",
      "renderable",
      "name",
    ]);
  }
  expect(roots).toBe(2);
  expect(disabled).toEqual([33]);

  const reloaded = createScene({ devChecks: true });
  reloaded.load(serialized);
  expect(JSON.stringify(reloaded.serialize())).toBe(JSON.stringify(serialized));
  expect(reloaded.isEnabled(reloaded.queryAll([], Transform)[33]!)).toBe(false);
});

test("[ER-03-09] formatVersion 2, forward parents and unknown components are refused atomically", () => {
  const scene = createScene({ devChecks: true });
  const parent = scene.createEntity();
  const child = scene.createEntity();
  scene.setParent(child, parent);
  scene.add(parent, Renderable, {
    mesh: "meshes/cube",
    material: "materials/default",
    visible: true,
    layer: 0,
  });
  const before = JSON.stringify(scene.serialize());

  const versionTwo = cloneFixture();
  versionTwo.formatVersion = 2;
  expect(
    codeOf(() => scene.load(versionTwo as unknown as SceneSnapshot)),
  ).toBe("E_SCENE_FORMAT");
  expect(JSON.stringify(scene.serialize())).toBe(before);

  const forwardParent = cloneFixture();
  forwardParent.entities[0]!.parent = 1;
  expect(
    codeOf(() => scene.load(forwardParent as unknown as SceneSnapshot)),
  ).toBe("E_SCENE_FORMAT");
  expect(JSON.stringify(scene.serialize())).toBe(before);

  const selfParent = cloneFixture();
  selfParent.entities[0]!.parent = 0;
  expect(
    codeOf(() => scene.load(selfParent as unknown as SceneSnapshot)),
  ).toBe("E_SCENE_FORMAT");
  expect(JSON.stringify(scene.serialize())).toBe(before);

  const unknown = cloneFixture();
  unknown.entities[0]!.components["bogus"] = {};
  expect(codeOf(() => scene.load(unknown as unknown as SceneSnapshot))).toBe(
    "E_SCENE_FORMAT",
  );
  expect(JSON.stringify(scene.serialize())).toBe(before);

  const nonSerializable = cloneFixture();
  nonSerializable.entities[0]!.components["test.serialization.transient"] = {
    ticks: 1,
  };
  expect(
    codeOf(() => scene.load(nonSerializable as unknown as SceneSnapshot)),
  ).toBe("E_SCENE_FORMAT");
  expect(JSON.stringify(scene.serialize())).toBe(before);
});

test("[ER-03-09] a missing transform loads as identity and -0 serializes as 0", () => {
  const scene = createScene({ devChecks: true });
  const snapshot = {
    formatVersion: 1,
    entities: [
      {
        parent: null,
        components: { name: { value: "no-transform" } },
      },
      {
        parent: 0,
        components: {
          transform: {
            position: [-0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      },
    ],
  };
  scene.load(snapshot as unknown as SceneSnapshot);

  const entities = scene.queryAll([], Transform);
  expect(entities).toHaveLength(2);
  const identity = scene.get(entities[0]!, Transform)!;
  expect(identity.position).toEqual({ x: 0, y: 0, z: 0 });
  expect(identity.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  expect(identity.scale).toEqual({ x: 1, y: 1, z: 1 });

  const serialized = scene.serialize();
  expect(Object.keys(serialized.entities[0]!.components)).toEqual([
    "transform",
    "name",
  ]);
  expect(serialized.entities[0]!.components["transform"]).toEqual({
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  });

  const payload = serialized.entities[1]!.components["transform"] as {
    position: number[];
  };
  expect(Object.is(payload.position[0], -0)).toBe(false);
  expect(payload.position[0]).toBe(0);
});

test("[ER-03-09] children serialize in insertion order and parents precede children", () => {
  const scene = createScene({ devChecks: true });
  const root = scene.createEntity();
  const first = scene.createEntity();
  const second = scene.createEntity();
  scene.add(root, Name, { value: "root" });
  scene.add(first, Name, { value: "first" });
  scene.add(second, Name, { value: "second" });
  scene.setParent(second, root);
  scene.setParent(first, root);

  const serialized = scene.serialize();
  expect(serialized.entities.map((record) => record.parent)).toEqual([
    null,
    0,
    0,
  ]);
  expect(
    serialized.entities.map(
      (record: SerializedEntity) =>
        (record.components["name"] as { value: string }).value,
    ),
  ).toEqual(["root", "second", "first"]);
});

test("[ER-03-09] serialize refuses a live non-serializable component", () => {
  const scene = createScene({ devChecks: true });
  const entity = scene.createEntity();
  scene.add(entity, Transient, { ticks: 3 });
  expect(scene.has(entity, Transient)).toBe(true);
  expect(codeOf(() => scene.serialize())).toBe("E_SCENE_INVALID");
});

/**
 * Scene lifecycle conformance replay (`test/conformance/scene-lifecycle.json`,
 * 03 §3.1–3.7, ER-03-01).
 *
 * The fixture is normative data hand-derived from the spec. Entity ids are
 * runtime-local; the replay asserts the documented LIFO slot reuse and
 * generation bump, not persisted ids.
 */

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import type {
  ComponentType,
  Entity,
  SceneStats,
} from "../../src/contracts/scene.js";
import {
  createScene,
  Name,
  Renderable,
  Transform,
} from "../../src/scene/index.js";

interface FixtureHandle {
  readonly id: number;
  readonly generation: number;
}

interface FixtureStepExpect {
  readonly id?: number;
  readonly generation?: number;
  readonly ids?: readonly number[];
  readonly count?: number;
}

interface FixtureStep {
  readonly op: string;
  readonly entity?: FixtureHandle;
  readonly component?: string;
  readonly value?: unknown;
  readonly enabled?: boolean;
  readonly components?: readonly string[];
  readonly expect?: boolean | number | FixtureStepExpect;
}

interface FixtureFinalEntity {
  readonly id: number;
  readonly generation: number;
  readonly enabled: boolean;
  readonly components: readonly string[];
}

interface SceneLifecycleFixture {
  readonly formatVersion: number;
  readonly synthetic: boolean;
  readonly source: string;
  readonly orderingNote: string;
  readonly note: string;
  readonly steps: readonly FixtureStep[];
  readonly final: {
    readonly aliveCount: number;
    readonly freeSlots: number;
    readonly entities: readonly FixtureFinalEntity[];
  };
}

const FIXTURE = JSON.parse(
  readFileSync(
    new URL("../conformance/scene-lifecycle.json", import.meta.url),
    "utf8",
  ),
) as SceneLifecycleFixture;

const TYPES: Readonly<Record<string, ComponentType<unknown>>> = {
  transform: Transform as ComponentType<unknown>,
  renderable: Renderable as ComponentType<unknown>,
  name: Name as ComponentType<unknown>,
};

function typeFor(name: string): ComponentType<unknown> {
  const type = TYPES[name];
  if (type === undefined) throw new Error(`fixture names unknown component ${name}`);
  return type;
}

function handleOf(source: FixtureHandle): Entity {
  return { id: source.id, generation: source.generation };
}

function typesOf(names: readonly string[]): ComponentType<unknown>[] {
  const types: ComponentType<unknown>[] = [];
  for (let index = 0; index < names.length; index += 1) {
    types.push(typeFor(names[index]!));
  }
  return types;
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

test("[ER-03-01] scene-lifecycle.json replays every step and the final state", () => {
  expect(FIXTURE.formatVersion).toBe(1);
  expect(FIXTURE.synthetic).toBe(true);
  expect(FIXTURE.steps).toHaveLength(17);

  const scene = createScene({ devChecks: true });
  const out: Entity[] = [];

  for (let index = 0; index < FIXTURE.steps.length; index += 1) {
    const step = FIXTURE.steps[index]!;
    switch (step.op) {
      case "createEntity": {
        const expected = step.expect as FixtureStepExpect;
        const entity = scene.createEntity();
        expect(entity.id).toBe(expected.id);
        expect(entity.generation).toBe(expected.generation);
        break;
      }
      case "add": {
        scene.add(handleOf(step.entity!), typeFor(step.component!), step.value);
        break;
      }
      case "setEnabled": {
        scene.setEnabled(handleOf(step.entity!), step.enabled!);
        break;
      }
      case "isAlive": {
        expect(scene.isAlive(handleOf(step.entity!))).toBe(step.expect);
        break;
      }
      case "destroyEntity": {
        scene.destroyEntity(handleOf(step.entity!));
        break;
      }
      case "query":
      case "queryAll": {
        const expected = step.expect as FixtureStepExpect;
        const types = typesOf(step.components!);
        const result =
          step.op === "query"
            ? scene.query(out, ...types)
            : scene.queryAll(out, ...types);
        expect(result).toBe(out);
        expect(result.map((entity) => entity.id)).toEqual(expected.ids);
        expect(result).toHaveLength(expected.count!);
        break;
      }
      case "queryCount": {
        const types = typesOf(step.components!);
        expect(scene.queryCount(...types)).toBe(step.expect);
        break;
      }
      default:
        throw new Error(`fixture uses unknown op ${step.op}`);
    }
  }

  const stats = scene.getStats(makeStats());
  expect(scene.aliveCount).toBe(FIXTURE.final.aliveCount);
  expect(stats.alive).toBe(FIXTURE.final.aliveCount);
  expect(stats.freeSlots).toBe(FIXTURE.final.freeSlots);
  expect(scene.isAlive({ id: 1, generation: 1 })).toBe(false);

  const serialized = scene.serialize();
  expect(serialized.entities).toHaveLength(FIXTURE.final.entities.length);
  for (let index = 0; index < FIXTURE.final.entities.length; index += 1) {
    const expected = FIXTURE.final.entities[index]!;
    const entity = handleOf(expected);
    const record = serialized.entities[index]!;
    expect(scene.isAlive(entity)).toBe(true);
    expect(scene.isEnabled(entity)).toBe(expected.enabled);
    expect(scene.has(entity, Transform)).toBe(true);
    expect(record.parent).toBeNull();
    expect(Object.keys(record.components)).toEqual(expected.components);
  }
});

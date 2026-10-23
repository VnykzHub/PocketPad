/**
 * Randomized query conformance (03 §3.6, ER-03-03).
 *
 * 500 runs × 24 entities × four component kinds. The reference model keeps
 * its own ordered presence lists and enabled flags, then computes the expected
 * driver (smallest presence list, earliest argument on ties) independently.
 */

import fc from "fast-check";
import { expect, test } from "vitest";
import type { Entity } from "../../src/contracts/scene.js";
import {
  createScene,
  defineComponent,
  Renderable,
} from "../../src/scene/index.js";

const ENTITY_COUNT = 24;

interface Payload {
  value: number;
}

const Alpha = defineComponent<Payload>({
  name: "test.query.alpha",
  create: () => ({ value: 0 }),
});

const Beta = defineComponent<Payload>({
  name: "test.query.beta",
  create: () => ({ value: 0 }),
});

const Gamma = defineComponent<Payload>({
  name: "test.query.gamma",
  create: () => ({ value: 0 }),
});

const TYPES = [Alpha, Beta, Gamma, Renderable] as const;

const SCENARIO = fc.record({
  // 24 × 4 slots: which of the four component kinds each entity has.
  has: fc.array(fc.boolean(), {
    minLength: ENTITY_COUNT * 4,
    maxLength: ENTITY_COUNT * 4,
  }),
  enabled: fc.array(fc.integer({ min: 0, max: 4 }), {
    minLength: ENTITY_COUNT,
    maxLength: ENTITY_COUNT,
  }),
  queryTypes: fc.uniqueArray(fc.integer({ min: 0, max: 3 }), {
    minLength: 0,
    maxLength: 4,
  }),
});

function renderable(value: number): {
  mesh: string;
  material: string;
  visible: boolean;
  layer: number;
} {
  return {
    mesh: `meshes/probe-${value}`,
    material: "materials/default",
    visible: true,
    layer: 0,
  };
}

test("[ER-03-03] 500 randomized queries match a brute-force reference", () => {
  fc.assert(
    fc.property(SCENARIO, (scenario) => {
      const scene = createScene({ devChecks: true });
      const entities: Entity[] = [];
      for (let index = 0; index < ENTITY_COUNT; index += 1) {
        entities.push(scene.createEntity());
      }

      // Reference presence lists, one per component kind, in insertion order.
      const presence: number[][] = [[], [], [], []];
      for (let index = 0; index < ENTITY_COUNT; index += 1) {
        const entity = entities[index]!;
        for (let kind = 0; kind < 4; kind += 1) {
          if (!scenario.has[index * 4 + kind]) continue;
          const kindValue = index * 4 + kind;
          if (kind === 3) scene.add(entity, Renderable, renderable(kindValue));
          else if (kind === 0) scene.add(entity, Alpha, { value: kindValue });
          else if (kind === 1) scene.add(entity, Beta, { value: kindValue });
          else scene.add(entity, Gamma, { value: kindValue });
          presence[kind]!.push(entity.id);
        }
        if (scenario.enabled[index] === 0) scene.setEnabled(entity, false);
      }

      const types = scenario.queryTypes.map((index) => TYPES[index]!);
      const presentSets = presence.map((ids) => new Set(ids));
      const enabledById = scenario.enabled.map((value) => value !== 0);

      let expectedEnabled: number[];
      let expectedAll: number[];
      if (types.length === 0) {
        const allIds = entities.map((entity) => entity.id);
        expectedEnabled = allIds.filter((id) => enabledById[id]!);
        expectedAll = allIds;
      } else {
        // Driver: the smallest presence list; the first argument wins a tie.
        let driverKind = scenario.queryTypes[0]!;
        for (const kind of scenario.queryTypes) {
          if (presence[kind]!.length < presence[driverKind]!.length) {
            driverKind = kind;
          }
        }
        const matches = (id: number): boolean =>
          scenario.queryTypes.every((kind) => presentSets[kind]!.has(id));
        const driverIds = presence[driverKind]!;
        expectedEnabled = driverIds.filter(
          (id) => matches(id) && enabledById[id]!,
        );
        expectedAll = driverIds.filter((id) => matches(id));
      }

      const enabledResult = scene.query([], ...types).map((entity) => entity.id);
      const allResult = scene.queryAll([], ...types).map((entity) => entity.id);

      expect(enabledResult).toEqual(expectedEnabled);
      expect(allResult).toEqual(expectedAll);
      expect(scene.queryCount(...types)).toBe(expectedEnabled.length);
    }),
    { numRuns: 500, seed: 20261023 },
  );
});

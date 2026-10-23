/**
 * Prefab parsing and instancing (spec 03 §3.8, §4.2, §5.7).
 *
 * `parsePrefab` validates the whole payload (shape, limits, names, codecs,
 * depth) and returns a frozen descriptor. `instantiateRecords` creates fresh
 * values through `deserialize`; two instances share no mutable state.
 */

import type { EngineScene, Entity, Prefab, SerializedEntity } from "../contracts/scene.js";
import { sceneError } from "./errors.js";
import {
  decodePrefabData,
  freezePrefabRecord,
  readPrefabSource,
} from "./Serialization.js";
import { MAX_PREFAB_ENTITIES } from "./types.js";

/** Format-level depth cap for snapshots and prefabs (03 §4.1). */
export const FORMAT_MAX_DEPTH = 64;

export interface PrefabInstance {
  readonly root: Entity;
  readonly entities: readonly Entity[];
}

/** Throws `E_SCENE_FORMAT` on an invalid payload. */
export function parsePrefab(data: unknown): Prefab {
  const source = readPrefabSource(data);
  // Full decode validates component names, codecs, limits and depth.
  const decoded = decodePrefabData(data, MAX_PREFAB_ENTITIES, FORMAT_MAX_DEPTH);
  const entities = new Array<SerializedEntity>(source.entities.length);
  for (let index = 0; index < source.entities.length; index += 1) {
    entities[index] = freezePrefabRecord(source.entities[index]!, index);
  }
  return Object.freeze({
    formatVersion: 1,
    id: decoded.id,
    root: decoded.root,
    entities: Object.freeze(entities),
  }) as Prefab;
}

/**
 * Internal: validates, creates records in order, links parents, applies
 * components in ascending id order and enables/disables entities.
 */
export function instantiateRecords(
  scene: EngineScene,
  prefab: Prefab,
  parent?: Entity | null,
): PrefabInstance {
  const decoded = decodePrefabData(prefab, MAX_PREFAB_ENTITIES, FORMAT_MAX_DEPTH);
  const created: Entity[] = [];

  try {
    for (let index = 0; index < decoded.records.length; index += 1) {
      created.push(scene.createEntity());
    }

    for (let index = 0; index < decoded.records.length; index += 1) {
      const record = decoded.records[index]!;
      if (record.parent === null) continue;
      if (!scene.setParent(created[index]!, created[record.parent]!)) {
        throw sceneError(
          "E_SCENE_INVALID",
          `instantiatePrefab: record ${index} parent link rejected`,
        );
      }
    }

    for (let index = 0; index < decoded.records.length; index += 1) {
      const record = decoded.records[index]!;
      const entity = created[index]!;
      for (
        let componentIndex = 0;
        componentIndex < record.components.length;
        componentIndex += 1
      ) {
        const component = record.components[componentIndex]!;
        scene.add(entity, component.type, component.value);
      }
    }

    for (let index = 0; index < decoded.records.length; index += 1) {
      if (!decoded.records[index]!.enabled) scene.setEnabled(created[index]!, false);
    }

    if (parent !== undefined && parent !== null) {
      if (!scene.setParent(created[decoded.root]!, parent)) {
        throw sceneError(
          "E_SCENE_INVALID",
          "instantiatePrefab: root parent link rejected",
        );
      }
    }
  } catch (error) {
    for (let index = created.length - 1; index >= 0; index -= 1) {
      if (scene.isAlive(created[index]!)) scene.destroyEntity(created[index]!);
    }
    throw error;
  }

  return { root: created[decoded.root]!, entities: created };
}

/** Fresh values through `deserialize`; two instances share nothing mutable. */
export function instantiatePrefab(
  scene: EngineScene,
  prefab: Prefab,
  parent?: Entity | null,
): Entity {
  return instantiateRecords(scene, prefab, parent).root;
}

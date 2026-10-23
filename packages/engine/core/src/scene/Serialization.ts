/**
 * Snapshot validation and deterministic serialization (spec 03 §3.8, §4.1, §5.7).
 *
 * Validation decodes every component into temporary values before the scene is
 * touched, so `load` is all-or-nothing. The serializer emits a pre-order DFS:
 * roots ascending id, children insertion order, `transform` first and then
 * components in ascending `ComponentType.id` order.
 */

import type {
  ComponentType,
  SceneSnapshot,
  SerializedEntity,
  Transform as TransformValue,
} from "../contracts/scene.js";
import { Transform } from "./builtins.js";
import { getComponentByName, listComponentTypes } from "./component.js";
import type { ComponentStore } from "./ComponentStore.js";
import type { EntityAllocator } from "./EntityAllocator.js";
import { sceneError } from "./errors.js";
import {
  COMPONENT_NAME_PATTERN,
  MAX_COMPONENTS_PER_ENTITY,
  PREFAB_ID_PATTERN,
  isIndex,
  isPlainObject,
} from "./types.js";

const TRANSFORM_TYPE_ID = 1;
const PARENT_TYPE_ID = 2;

export interface DecodedComponent {
  readonly type: ComponentType<unknown>;
  readonly value: unknown;
}

export interface DecodedEntity {
  readonly parent: number | null;
  readonly enabled: boolean;
  readonly components: readonly DecodedComponent[];
}

export interface DecodedPrefab {
  readonly id: string;
  readonly root: number;
  readonly records: readonly DecodedEntity[];
}

function formatError(message: string): never {
  throw sceneError("E_SCENE_FORMAT", message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeComponent(
  recordIndex: number,
  name: string,
  payload: unknown,
): DecodedComponent {
  const type = getComponentByName(name);
  if (type === undefined) {
    formatError(`entities[${recordIndex}].components.${name}: unknown component`);
  }
  if (type.id === PARENT_TYPE_ID) {
    formatError(
      `entities[${recordIndex}].components.${name}: parent links are encoded by the parent field`,
    );
  }
  if (!type.serializable || type.deserialize === undefined) {
    formatError(`entities[${recordIndex}].components.${name}: component is not serializable`);
  }
  let value: unknown;
  try {
    value = type.deserialize(payload);
  } catch (error) {
    formatError(
      `entities[${recordIndex}].components.${name}: ${messageOf(error)}`,
    );
  }
  return { type, value };
}

/** Validates and decodes an entity record array. Never mutates the input. */
export function decodeEntityRecords(
  entities: unknown,
  limit: number,
  maxDepth: number,
): DecodedEntity[] {
  if (!Array.isArray(entities)) formatError("entities must be an array");
  if (entities.length > limit) {
    formatError(`entities: ${entities.length} records exceeds the limit of ${limit}`);
  }
  const records = new Array<DecodedEntity>(entities.length);
  const depths = new Int32Array(entities.length);

  for (let index = 0; index < entities.length; index += 1) {
    const record: unknown = entities[index];
    if (!isPlainObject(record)) {
      formatError(`entities[${index}]: record must be an object`);
    }

    const parentValue = record["parent"];
    let parent: number | null;
    if (parentValue === null) parent = null;
    else if (isIndex(parentValue, index)) parent = parentValue;
    else {
      formatError(
        `entities[${index}].parent: must be null or an index below ${index}`,
      );
    }

    let enabled = true;
    if (Object.prototype.hasOwnProperty.call(record, "enabled")) {
      if (record["enabled"] !== false) {
        formatError(`entities[${index}].enabled: only false may be present`);
      }
      enabled = false;
    }

    const componentsValue = record["components"];
    if (!isPlainObject(componentsValue)) {
      formatError(`entities[${index}].components: must be an object`);
    }
    const names = Object.keys(componentsValue);
    if (names.length === 0 || names.length > MAX_COMPONENTS_PER_ENTITY) {
      formatError(
        `entities[${index}].components: expected 1..${MAX_COMPONENTS_PER_ENTITY} entries`,
      );
    }

    const components: DecodedComponent[] = [];
    for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
      const name = names[nameIndex]!;
      if (name === "__proto__" || name === "constructor" || name === "prototype") {
        formatError(`entities[${index}].components.${name}: reserved key`);
      }
      if (!COMPONENT_NAME_PATTERN.test(name)) {
        formatError(`entities[${index}].components.${name}: invalid component name`);
      }
      if (!Object.prototype.hasOwnProperty.call(componentsValue, name)) continue;
      components.push(decodeComponent(index, name, componentsValue[name]));
    }

    // Ascending component id; insertion sort keeps this allocation-light.
    for (let a = 1; a < components.length; a += 1) {
      const item = components[a]!;
      let b = a - 1;
      while (b >= 0 && components[b]!.type.id > item.type.id) {
        components[b + 1] = components[b]!;
        b -= 1;
      }
      components[b + 1] = item;
    }

    const depth = parent === null ? 1 : depths[parent]! + 1;
    if (depth > maxDepth) {
      formatError(`entities[${index}]: depth ${depth} exceeds ${maxDepth}`);
    }
    depths[index] = depth;
    records[index] = { parent, enabled, components };
  }
  return records;
}

/** Validates a `SceneSnapshot` shape and decodes every component. */
export function decodeSnapshot(
  snapshot: unknown,
  limit: number,
  maxDepth: number,
): DecodedEntity[] {
  if (!isPlainObject(snapshot)) formatError("snapshot must be an object");
  if (snapshot["formatVersion"] !== 1) {
    formatError("formatVersion: expected 1");
  }
  return decodeEntityRecords(snapshot["entities"], limit, maxDepth);
}

/** Validates a prefab payload and decodes every component. */
export function decodePrefabData(
  data: unknown,
  limit: number,
  maxDepth: number,
): DecodedPrefab {
  if (!isPlainObject(data)) formatError("prefab must be an object");
  if (data["formatVersion"] !== 1) {
    formatError("formatVersion: expected 1");
  }
  const id = data["id"];
  if (typeof id !== "string" || !PREFAB_ID_PATTERN.test(id)) {
    formatError("id: expected ^[a-z0-9][a-z0-9/_.-]{0,63}$");
  }
  const records = decodeEntityRecords(data["entities"], limit, maxDepth);
  const root = data["root"];
  if (!isIndex(root, records.length)) {
    formatError("root: expected a record index");
  }
  return { id, root, records };
}

/**
 * Builds a snapshot in canonical order. Throws `E_SCENE_INVALID` when a live
 * entity carries a component without codecs.
 */
export function buildSnapshot(
  allocator: EntityAllocator,
  stores: readonly (ComponentStore<unknown> | undefined)[],
): SceneSnapshot {
  const types = listComponentTypes();

  // Pre-validate so a non-serializable component never produces a partial walk.
  for (let id = 0; id < allocator.nextId; id += 1) {
    if (allocator.alive[id] !== 1) continue;
    const transformStore = stores[TRANSFORM_TYPE_ID];
    if (transformStore === undefined || !transformStore.has(id)) {
      throw sceneError(
        "E_SCENE_INVALID",
        `serialize: entity ${id} has no Transform`,
      );
    }
    for (let typeIndex = 0; typeIndex < types.length; typeIndex += 1) {
      const type = types[typeIndex]!;
      if (type.id === TRANSFORM_TYPE_ID || type.id === PARENT_TYPE_ID) continue;
      const store = type.id < stores.length ? stores[type.id] : undefined;
      if (store === undefined || !store.has(id)) continue;
      if (!type.serializable || type.serialize === undefined) {
        throw sceneError(
          "E_SCENE_INVALID",
          `serialize: component ${type.name} on entity ${id} has no codec`,
        );
      }
    }
  }

  const order: number[] = [];
  const stack: number[] = [];
  for (let root = 0; root < allocator.nextId; root += 1) {
    if (allocator.alive[root] !== 1 || allocator.parent[root] !== -1) continue;
    stack.push(root);
    while (stack.length > 0) {
      const id = stack.pop()!;
      order.push(id);
      // Reverse push so children pop in insertion order.
      for (
        let child = allocator.lastChild[id]!;
        child !== -1;
        child = allocator.prevSibling[child]!
      ) {
        stack.push(child);
      }
    }
  }

  const transformStore = stores[TRANSFORM_TYPE_ID];
  const transformSerialize = Transform.serialize;
  if (transformStore === undefined || transformSerialize === undefined) {
    throw sceneError("E_SCENE_INVALID", "serialize: Transform is not serializable");
  }

  const entities: SerializedEntity[] = [];
  const indexOfId = new Int32Array(allocator.nextId).fill(-1);

  for (let position = 0; position < order.length; position += 1) {
    const id = order[position]!;
    const parentId = allocator.parent[id]!;
    const parent = parentId === -1 ? null : indexOfId[parentId]!;
    if (parentId !== -1 && parent === -1) {
      throw sceneError("E_SCENE_INVALID", `serialize: entity ${id} has an unvisited parent`);
    }

    const components: Record<string, unknown> = {};
    const transform = transformStore.get(id);
    if (transform === undefined) {
      throw sceneError("E_SCENE_INVALID", `serialize: entity ${id} has no Transform`);
    }
    components[Transform.name] = transformSerialize(transform as TransformValue);

    for (let typeIndex = 0; typeIndex < types.length; typeIndex += 1) {
      const type = types[typeIndex]!;
      if (type.id === TRANSFORM_TYPE_ID || type.id === PARENT_TYPE_ID) continue;
      const store = type.id < stores.length ? stores[type.id] : undefined;
      if (store === undefined || !store.has(id)) continue;
      const serialize = type.serialize;
      if (serialize === undefined) {
        throw sceneError(
          "E_SCENE_INVALID",
          `serialize: component ${type.name} on entity ${id} has no codec`,
        );
      }
      components[type.name] = serialize(store.get(id) as unknown);
    }

    const record: {
      parent: number | null;
      enabled?: false;
      components?: Record<string, unknown>;
    } = { parent };
    if (allocator.enabled[id] !== 1) record.enabled = false;
    record.components = components;

    indexOfId[id] = entities.length;
    entities.push(record as SerializedEntity);
  }

  return { formatVersion: 1, entities };
}

/** Shape checks used by `parsePrefab` before copying user records. */
export function readPrefabSource(data: unknown): {
  id: string;
  root: number;
  entities: readonly Record<string, unknown>[];
} {
  if (!isPlainObject(data)) formatError("prefab must be an object");
  if (data["formatVersion"] !== 1) formatError("formatVersion: expected 1");
  const id = data["id"];
  if (typeof id !== "string" || !PREFAB_ID_PATTERN.test(id)) {
    formatError("id: expected ^[a-z0-9][a-z0-9/_.-]{0,63}$");
  }
  const entities = data["entities"];
  if (!Array.isArray(entities)) formatError("entities must be an array");
  const records: Record<string, unknown>[] = new Array(entities.length);
  for (let index = 0; index < entities.length; index += 1) {
    const record: unknown = entities[index];
    if (!isPlainObject(record)) formatError(`entities[${index}]: record must be an object`);
    records[index] = record;
  }
  const root = data["root"];
  if (!isIndex(root, records.length)) formatError("root: expected a record index");
  return { id, root, entities: records };
}

/** Copies one source record into an immutable `SerializedEntity`. */
export function freezePrefabRecord(
  source: Record<string, unknown>,
  index: number,
): SerializedEntity {
  const componentsSource = source["components"];
  if (!isPlainObject(componentsSource)) {
    formatError(`entities[${index}].components: must be an object`);
  }
  const components: Record<string, unknown> = {};
  const names = Object.keys(componentsSource);
  for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
    const name = names[nameIndex]!;
    components[name] = componentsSource[name];
  }
  const record: {
    parent: number | null;
    enabled?: false;
    components?: Record<string, unknown>;
  } = { parent: source["parent"] as number | null };
  if (Object.prototype.hasOwnProperty.call(source, "enabled")) record.enabled = false;
  record.components = components;
  return Object.freeze(record) as SerializedEntity;
}

/** Identity payload used when a prefab record omits `transform`. */
export const IDENTITY_TRANSFORM_PAYLOAD: unknown = Object.freeze({
  position: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
});

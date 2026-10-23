/**
 * Component registration (spec 03 §3.2).
 *
 * The registry is append-only and process-global. Built-ins (ids 1–4) are
 * registered by `builtins.ts`; game and engine subsystems call
 * `defineComponent` at module scope, never inside a tick.
 */

import type { ComponentSpec, ComponentType, Entity } from "../contracts/scene.js";
import { sceneError } from "./errors.js";
import { COMPONENT_NAME_PATTERN } from "./types.js";

/** Highest allocatable component id (03 §3.2: ids 1..4095). */
const MAX_COMPONENT_ID = 4095;

const typesByName = new Map<string, ComponentType<unknown>>();
const typesById: (ComponentType<unknown> | undefined)[] = [];
/** Registration order sorted by id; kept as a flat array for allocation-free walks. */
const orderedTypes: ComponentType<unknown>[] = [];
let nextComponentId = 1;

function validateSpec<T>(spec: ComponentSpec<T>): void {
  if (typeof spec !== "object" || spec === null) {
    throw sceneError("E_CONTRACT", "defineComponent: spec must be an object");
  }
  if (typeof spec.name !== "string" || !COMPONENT_NAME_PATTERN.test(spec.name)) {
    throw sceneError(
      "E_CONTRACT",
      `defineComponent: invalid component name ${String(spec.name)}`,
    );
  }
  if (typeof spec.create !== "function") {
    throw sceneError("E_CONTRACT", `defineComponent(${spec.name}): create is required`);
  }
  const hasSerialize = spec.serialize !== undefined;
  const hasDeserialize = spec.deserialize !== undefined;
  if (hasSerialize !== hasDeserialize) {
    throw sceneError(
      "E_CONTRACT",
      `defineComponent(${spec.name}): serialize and deserialize must be supplied together`,
    );
  }
  if (hasSerialize && (typeof spec.serialize !== "function" || typeof spec.deserialize !== "function")) {
    throw sceneError(
      "E_CONTRACT",
      `defineComponent(${spec.name}): serialize/deserialize must be functions`,
    );
  }
  if (spec.reset !== undefined && typeof spec.reset !== "function") {
    throw sceneError("E_CONTRACT", `defineComponent(${spec.name}): reset must be a function`);
  }
  if (spec.onRemove !== undefined && typeof spec.onRemove !== "function") {
    throw sceneError("E_CONTRACT", `defineComponent(${spec.name}): onRemove must be a function`);
  }
}

function buildType<T>(id: number, spec: ComponentSpec<T>): ComponentType<T> {
  const serializable = spec.serialize !== undefined && spec.deserialize !== undefined;
  const type: {
    id: number;
    name: string;
    serializable: boolean;
    create: () => T;
    serialize?: (value: T) => unknown;
    deserialize?: (data: unknown) => T;
    reset?: (out: T, data: unknown) => void;
    onRemove?: (value: T, entity: Entity) => void;
  } = {
    id,
    name: spec.name,
    serializable,
    create: spec.create,
  };
  if (spec.serialize !== undefined) type.serialize = spec.serialize;
  if (spec.deserialize !== undefined) type.deserialize = spec.deserialize;
  if (spec.reset !== undefined) type.reset = spec.reset;
  if (spec.onRemove !== undefined) type.onRemove = spec.onRemove;
  return Object.freeze(type) as ComponentType<T>;
}

function insertOrdered(type: ComponentType<unknown>): void {
  let low = 0;
  let high = orderedTypes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const current = orderedTypes[middle];
    if (current !== undefined && current.id < type.id) low = middle + 1;
    else high = middle;
  }
  orderedTypes.splice(low, 0, type);
}

function register<T>(id: number, spec: ComponentSpec<T>): ComponentType<T> {
  validateSpec(spec);
  if (typesByName.has(spec.name)) {
    throw sceneError(
      "E_CONTRACT",
      `defineComponent: component name already registered: ${spec.name}`,
    );
  }
  if (typesById[id] !== undefined) {
    throw sceneError("E_CONTRACT", `defineComponent: component id already registered: ${id}`);
  }
  const type = buildType(id, spec);
  typesByName.set(type.name, type as ComponentType<unknown>);
  typesById[id] = type as ComponentType<unknown>;
  insertOrdered(type as ComponentType<unknown>);
  if (id >= nextComponentId) nextComponentId = id + 1;
  return type;
}

/**
 * Internal: registers a built-in type with a fixed id. Not exported from the
 * package entry; only `builtins.ts` may call it.
 */
export function registerComponentType<T>(
  id: number,
  spec: ComponentSpec<T>,
): ComponentType<T> {
  if (!Number.isInteger(id) || id < 1 || id > MAX_COMPONENT_ID) {
    throw sceneError("E_CONTRACT", `registerComponentType: invalid id ${String(id)}`);
  }
  return register(id, spec);
}

/** Registers a component type; ids are allocated from 5 upward (03 §3.2). */
export function defineComponent<T>(spec: ComponentSpec<T>): ComponentType<T> {
  if (nextComponentId > MAX_COMPONENT_ID) {
    throw sceneError(
      "E_CONTRACT",
      "defineComponent: component id space exhausted (max 4095)",
    );
  }
  return register(nextComponentId, spec);
}

/** Registry lookup by serialized component name. */
export function getComponentByName(name: string): ComponentType<unknown> | undefined {
  return typesByName.get(name);
}

/** Registry lookup by numeric id (internal). */
export function getComponentTypeById(id: number): ComponentType<unknown> | undefined {
  return typesById[id];
}

/** All registered types, ascending `id`, for deterministic serialization. */
export function listComponentTypes(): readonly ComponentType<unknown>[] {
  return orderedTypes;
}

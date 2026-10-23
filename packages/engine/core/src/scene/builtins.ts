/**
 * Built-in scene components (spec 03 §3.3): Transform (id 1), Parent (id 2),
 * Renderable (id 3), Name (id 4).
 *
 * Codecs accept the synthetic payload shapes from 03 §4.1. Deserializers copy
 * every value, so two prefab instances never share mutable state. `reset`
 * overwrites fields in place and allocates nothing.
 */

import type {
  ComponentType,
  Name as NameData,
  Parent as ParentData,
  Renderable as RenderableData,
  Transform as TransformData,
} from "../contracts/scene.js";
import type { Quat, Vec3 } from "../contracts/math.js";
import { registerComponentType } from "./component.js";
import { sceneError } from "./errors.js";
import {
  ASSET_ID_PATTERN,
  isFiniteNumber,
  isPlainObject,
  normalizeZero,
  utf8ByteLength,
} from "./types.js";

/**
 * Public type/value merge for the built-ins. The contract defines the data
 * shape; the module exports the runtime descriptor under the same name so the
 * package entry can export one symbol carrying both meanings.
 */
export type Transform = TransformData;
export type Parent = ParentData;
export type Renderable = RenderableData;
export type Name = NameData;

function formatError(typeName: string, field: string): never {
  throw sceneError(
    "E_SCENE_FORMAT",
    `${typeName}.${field}: invalid value in scene payload`,
  );
}

function readVec3Into(out: Vec3, data: unknown, typeName: string, field: string): void {
  if (data === undefined) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return;
  }
  if (!Array.isArray(data) || data.length !== 3) formatError(typeName, field);
  const x = data[0];
  const y = data[1];
  const z = data[2];
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    formatError(typeName, field);
  }
  out.x = x;
  out.y = y;
  out.z = z;
}

function readQuatInto(out: Quat, data: unknown): void {
  if (data === undefined) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.w = 1;
    return;
  }
  if (!Array.isArray(data) || data.length !== 4) formatError("transform", "rotation");
  const x = data[0];
  const y = data[1];
  const z = data[2];
  const w = data[3];
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z) || !isFiniteNumber(w)) {
    formatError("transform", "rotation");
  }
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
}

function requireRecord(data: unknown, typeName: string): Record<string, unknown> {
  if (!isPlainObject(data)) formatError(typeName, "payload");
  return data;
}

function createTransform(): TransformData {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

function writeTransform(out: TransformData, data: unknown): void {
  const payload = requireRecord(data, "transform");
  readVec3Into(out.position, payload["position"], "transform", "position");
  readQuatInto(out.rotation, payload["rotation"]);
  if (payload["scale"] === undefined) {
    out.scale.x = 1;
    out.scale.y = 1;
    out.scale.z = 1;
  } else {
    readVec3Into(out.scale, payload["scale"], "transform", "scale");
  }
}

function serializeTransform(value: TransformData): unknown {
  const { position, rotation, scale } = value;
  return {
    position: [normalizeZero(position.x), normalizeZero(position.y), normalizeZero(position.z)],
    rotation: [
      normalizeZero(rotation.x),
      normalizeZero(rotation.y),
      normalizeZero(rotation.z),
      normalizeZero(rotation.w),
    ],
    scale: [normalizeZero(scale.x), normalizeZero(scale.y), normalizeZero(scale.z)],
  };
}

function deserializeTransform(data: unknown): TransformData {
  const out = createTransform();
  writeTransform(out, data);
  return out;
}

/** id 1, serializable; implicitly present on every entity. */
export const Transform: ComponentType<Transform> = registerComponentType(1, {
  name: "transform",
  create: createTransform,
  serialize: serializeTransform,
  deserialize: deserializeTransform,
  reset: writeTransform,
});

function createParent(): ParentData {
  return { entity: { id: -1, generation: 0 } };
}

/**
 * id 2. A read-only view of the hierarchy edge. The scene routes `add` and
 * `remove` to `setParent`; no component store is created for this type.
 */
export const Parent: ComponentType<Parent> = registerComponentType(2, {
  name: "parent",
  create: createParent,
});

function createRenderable(): RenderableData {
  return { mesh: "", material: "", visible: true, layer: 0 };
}

function readBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") formatError("renderable", field);
  return value;
}

function readLayer(value: unknown): number {
  if (value === undefined) return 0;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 31
  ) {
    formatError("renderable", "layer");
  }
  return value;
}

function writeRenderable(out: RenderableData, data: unknown): void {
  const payload = requireRecord(data, "renderable");
  const mesh = payload["mesh"];
  const material = payload["material"];
  if (typeof mesh !== "string" || !ASSET_ID_PATTERN.test(mesh)) {
    formatError("renderable", "mesh");
  }
  if (typeof material !== "string" || !ASSET_ID_PATTERN.test(material)) {
    formatError("renderable", "material");
  }
  out.mesh = mesh;
  out.material = material;
  out.visible = readBoolean(payload["visible"], true, "visible");
  out.layer = readLayer(payload["layer"]);
}

function deserializeRenderable(data: unknown): RenderableData {
  const out = createRenderable();
  writeRenderable(out, data);
  return out;
}

function serializeRenderable(value: RenderableData): unknown {
  if (typeof value.mesh !== "string" || !ASSET_ID_PATTERN.test(value.mesh)) {
    throw sceneError("E_SCENE_INVALID", "renderable.mesh: invalid asset id");
  }
  if (typeof value.material !== "string" || !ASSET_ID_PATTERN.test(value.material)) {
    throw sceneError("E_SCENE_INVALID", "renderable.material: invalid asset id");
  }
  if (
    typeof value.layer !== "number" ||
    !Number.isInteger(value.layer) ||
    value.layer < 0 ||
    value.layer > 31
  ) {
    throw sceneError("E_SCENE_INVALID", "renderable.layer: must be an integer 0..31");
  }
  return {
    mesh: value.mesh,
    material: value.material,
    visible: value.visible,
    layer: value.layer,
  };
}

/** id 3, serializable. Asset ids, never GPU handles. */
export const Renderable: ComponentType<Renderable> = registerComponentType(3, {
  name: "renderable",
  create: createRenderable,
  serialize: serializeRenderable,
  deserialize: deserializeRenderable,
  reset: writeRenderable,
});

function createName(): NameData {
  return { value: "" };
}

function readNameValue(value: unknown): string {
  if (typeof value !== "string" || utf8ByteLength(value) > 128) {
    formatError("name", "value");
  }
  return value;
}

function writeName(out: NameData, data: unknown): void {
  const payload = requireRecord(data, "name");
  out.value = readNameValue(payload["value"]);
}

function deserializeName(data: unknown): NameData {
  const out = createName();
  writeName(out, data);
  return out;
}

function serializeName(value: NameData): unknown {
  const text = readNameValue(value.value);
  return { value: text };
}

/** id 4, serializable. Display/debug only. */
export const Name: ComponentType<Name> = registerComponentType(4, {
  name: "name",
  create: createName,
  serialize: serializeName,
  deserialize: deserializeName,
  reset: writeName,
});

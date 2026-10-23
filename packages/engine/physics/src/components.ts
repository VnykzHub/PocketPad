/**
 * `PreviousTransform` runtime component (07 §3.7).
 *
 * The contract declares the type; core spec 03 does not ship the component.
 * Physics owns this registration in its own id range so `syncScene` can write
 * the pose that the renderer interpolates from.
 */
import { defineComponent, quatCreate, vec3Create } from "@lanpad/engine-core";
import type { ComponentType, Quat, Vec3 } from "@lanpad/engine-core";
import type { PreviousTransform as PreviousTransformData } from "./contracts/physics3d.js";

function createPreviousTransform(): PreviousTransformData {
  return { position: vec3Create(), rotation: quatCreate() };
}

function serializePreviousTransform(value: PreviousTransformData): unknown {
  return {
    position: [value.position.x, value.position.y, value.position.z],
    rotation: [
      value.rotation.x,
      value.rotation.y,
      value.rotation.z,
      value.rotation.w,
    ],
  };
}

function readVec3(data: unknown, field: string): Vec3 {
  if (!Array.isArray(data) || data.length !== 3) {
    throw new Error(`previous-transform.${field} must be [x, y, z]`);
  }
  const values = data as unknown[];
  const x = values[0];
  const y = values[1];
  const z = values[2];
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    throw new Error(`previous-transform.${field} must be finite numbers`);
  }
  return vec3Create(x, y, z);
}

function readQuat(data: unknown): Quat {
  if (!Array.isArray(data) || data.length !== 4) {
    throw new Error("previous-transform.rotation must be [x, y, z, w]");
  }
  const values = data as unknown[];
  const x = values[0];
  const y = values[1];
  const z = values[2];
  const w = values[3];
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    typeof w !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    !Number.isFinite(w)
  ) {
    throw new Error("previous-transform.rotation must be finite numbers");
  }
  return quatCreate(x, y, z, w);
}

function deserializePreviousTransform(data: unknown): PreviousTransformData {
  if (typeof data !== "object" || data === null) {
    throw new Error("previous-transform payload must be an object");
  }
  const record = data as Record<string, unknown>;
  return {
    position: readVec3(record["position"], "position"),
    rotation: readQuat(record["rotation"]),
  };
}

/**
 * Serializable component written by `syncScene` before it updates Transform.
 * Not declared by core 03; additive and physics-owned.
 */
export const PreviousTransform: ComponentType<PreviousTransformData> =
  defineComponent<PreviousTransformData>({
    name: "previous-transform",
    create: createPreviousTransform,
    serialize: serializePreviousTransform,
    deserialize: deserializePreviousTransform,
  });

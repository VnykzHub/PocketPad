/**
 * Renderer ABI 1 vertex layouts, validation and VAO construction (05 §4.3).
 *
 * Only `static-pbr-v1` and `instanced-transform-v1` are part of ABI 1. Any
 * other layout id, attribute set or attribute format is `E_CONTRACT` at
 * creation, never at draw. The fixed locations must never shift.
 */

import type { BoundingSphere, MeshDesc } from "@lanpad/engine-core";
import { rendererError } from "./errors.js";
import type { StateCache } from "./state.js";

export interface AbiAttribute {
  readonly offset: number;
  readonly shaderLocation: number;
  readonly name: string;
  readonly format: "float32x3" | "float32x2" | "float32x4";
}

export interface AbiBufferLayout {
  readonly slot: number;
  readonly stepMode: "vertex" | "instance";
  readonly stride: number;
  readonly attributes: readonly AbiAttribute[];
}

export interface AbiLayout {
  readonly label: string;
  readonly topology: "triangle-list";
  readonly buffers: readonly AbiBufferLayout[];
}

export const ABI_VERTEX_STRIDE = 32;
export const ABI_INSTANCE_STRIDE = 64;
export const ABI_MAX_INSTANCE_CAPACITY = 16384;

const VERTEX_ATTRIBUTES: readonly AbiAttribute[] = [
  { offset: 0, shaderLocation: 0, name: "position", format: "float32x3" },
  { offset: 12, shaderLocation: 1, name: "normal", format: "float32x3" },
  { offset: 24, shaderLocation: 2, name: "uv", format: "float32x2" },
];

const INSTANCE_ATTRIBUTES: readonly AbiAttribute[] = [
  { offset: 0, shaderLocation: 3, name: "model0", format: "float32x4" },
  { offset: 16, shaderLocation: 4, name: "model1", format: "float32x4" },
  { offset: 32, shaderLocation: 5, name: "model2", format: "float32x4" },
  { offset: 48, shaderLocation: 6, name: "model3", format: "float32x4" },
];

export type MeshLayoutId = "static-pbr-v1" | "instanced-transform-v1";

/** The exact ABI-1 layout table, mirrored by `test/fixtures/abi-parity.json`. */
export const ABI_LAYOUTS: Readonly<Record<MeshLayoutId, AbiLayout>> = {
  "static-pbr-v1": {
    label: "static-pbr-v1",
    topology: "triangle-list",
    buffers: [
      { slot: 0, stepMode: "vertex", stride: ABI_VERTEX_STRIDE, attributes: VERTEX_ATTRIBUTES },
    ],
  },
  "instanced-transform-v1": {
    label: "instanced-transform-v1",
    topology: "triangle-list",
    buffers: [
      { slot: 0, stepMode: "vertex", stride: ABI_VERTEX_STRIDE, attributes: VERTEX_ATTRIBUTES },
      {
        slot: 1,
        stepMode: "instance",
        stride: ABI_INSTANCE_STRIDE,
        attributes: INSTANCE_ATTRIBUTES,
      },
    ],
  },
};

export function isMeshLayoutId(value: string): value is MeshLayoutId {
  return value === "static-pbr-v1" || value === "instanced-transform-v1";
}

export function abiLayout(layoutId: string): AbiLayout {
  if (!isMeshLayoutId(layoutId)) {
    throw rendererError(
      "E_CONTRACT",
      `Mesh layout "${layoutId}" is not part of renderer ABI 1.`,
    );
  }
  return ABI_LAYOUTS[layoutId];
}

/**
 * Pure attribute-set check used by the ABI parity fixture: an extra or moved
 * attribute (TANGENT, COLOR_0, TEXCOORD_1, JOINTS_0, WEIGHTS_0, …) rejects.
 */
export function validateVertexAttributeSet(
  layoutId: string,
  attributes: readonly AbiAttribute[],
): void {
  const layout = abiLayout(layoutId);
  const canonical = layout.buffers[0]?.attributes ?? [];
  if (attributes.length !== canonical.length) {
    throw rendererError(
      "E_CONTRACT",
      `Layout ${layoutId} accepts exactly ${canonical.length} vertex attributes.`,
    );
  }
  for (let index = 0; index < canonical.length; index += 1) {
    const expected = canonical[index];
    const actual = attributes[index];
    if (expected === undefined || actual === undefined) {
      throw rendererError("E_CONTRACT", `Layout ${layoutId} attribute set is incomplete.`);
    }
    if (
      actual.offset !== expected.offset ||
      actual.shaderLocation !== expected.shaderLocation ||
      actual.name !== expected.name ||
      actual.format !== expected.format
    ) {
      throw rendererError(
        "E_CONTRACT",
        `Attribute ${actual.name} is not part of layout ${layoutId} at that location.`,
      );
    }
  }
}

export interface NormalizedMeshDesc {
  readonly label: string;
  readonly layout: MeshLayoutId;
  readonly vertexData: ArrayBufferView;
  readonly vertexCount: number;
  readonly indexData: Uint16Array | Uint32Array | null;
  readonly indexType: "uint16" | "uint32" | null;
  readonly indexCount: number;
  readonly bounds: BoundingSphere;
}

export function normalizeMeshDesc(desc: MeshDesc): NormalizedMeshDesc {
  if (typeof desc.label !== "string") {
    throw rendererError("E_CONTRACT", "MeshDesc.label must be a string.");
  }
  const layout = abiLayout(desc.layout);
  if (desc.topology !== undefined && desc.topology !== "triangle-list") {
    throw rendererError("E_CONTRACT", "ABI 1 supports only triangle-list topology.");
  }
  if (desc.vertices.length !== 1) {
    throw rendererError("E_CONTRACT", "ABI 1 requires exactly one vertex buffer.");
  }
  const vertexData = desc.vertices[0];
  if (vertexData === undefined || !ArrayBuffer.isView(vertexData)) {
    throw rendererError("E_CONTRACT", "MeshDesc.vertices[0] must be an ArrayBufferView.");
  }
  const stride = layout.buffers[0]?.stride ?? ABI_VERTEX_STRIDE;
  if (vertexData.byteLength === 0 || vertexData.byteOffset % 4 !== 0) {
    throw rendererError(
      "E_CONTRACT",
      "The vertex buffer must be non-empty and 4-byte aligned.",
    );
  }
  if (vertexData.byteLength % stride !== 0) {
    throw rendererError(
      "E_CONTRACT",
      `The vertex buffer length must be a whole number of ${stride}-byte vertices.`,
    );
  }
  const vertexCount = vertexData.byteLength / stride;
  if (vertexCount > 65535 && desc.indices?.format === "uint16") {
    throw rendererError("E_CONTRACT", "uint16 indices cannot address more than 65535 vertices.");
  }

  let indexData: Uint16Array | Uint32Array | null = null;
  let indexType: "uint16" | "uint32" | null = null;
  let indexCount = 0;
  if (desc.indices !== undefined) {
    const data = desc.indices.data;
    if (!(data instanceof Uint16Array) && !(data instanceof Uint32Array)) {
      throw rendererError("E_CONTRACT", "Mesh indices must be Uint16Array or Uint32Array.");
    }
    if (desc.indices.format === "uint16" && !(data instanceof Uint16Array)) {
      throw rendererError("E_CONTRACT", 'Index format "uint16" requires Uint16Array data.');
    }
    if (desc.indices.format === "uint32" && !(data instanceof Uint32Array)) {
      throw rendererError("E_CONTRACT", 'Index format "uint32" requires Uint32Array data.');
    }
    if (data.length % 3 !== 0) {
      throw rendererError("E_CONTRACT", "Triangle-list index count must be a multiple of 3.");
    }
    indexData = data;
    indexType = desc.indices.format;
    indexCount = data.length;
  } else if (vertexCount % 3 !== 0) {
    throw rendererError("E_CONTRACT", "Triangle-list vertex count must be a multiple of 3.");
  }

  const bounds = desc.bounds;
  if (
    bounds === undefined ||
    !Number.isFinite(bounds.radius) ||
    bounds.radius < 0 ||
    !Number.isFinite(bounds.center.x) ||
    !Number.isFinite(bounds.center.y) ||
    !Number.isFinite(bounds.center.z)
  ) {
    throw rendererError("E_CONTRACT", "MeshDesc.bounds must be a finite, non-negative sphere.");
  }

  return {
    label: desc.label,
    layout: desc.layout,
    vertexData,
    vertexCount,
    indexData,
    indexType,
    indexCount,
    bounds: desc.bounds,
  };
}

export interface MeshGpuRecord {
  readonly vao: WebGLVertexArrayObject;
  readonly vertexBuffer: WebGLBuffer;
  readonly indexBuffer: WebGLBuffer | null;
  readonly instanceBuffer: WebGLBuffer | null;
  instanceCapacity: number;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indexType: "uint16" | "uint32" | null;
  readonly layout: MeshLayoutId;
  readonly bounds: BoundingSphere;
  readonly desc: MeshDesc;
  byteSize: number;
}

function setupAttribute(
  gl: WebGL2RenderingContext,
  location: number,
  size: number,
  stride: number,
  offset: number,
  divisor: number,
): void {
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
  if (divisor !== 0) gl.vertexAttribDivisor(location, divisor);
}

export function createMeshGpu(
  gl: WebGL2RenderingContext,
  state: StateCache,
  desc: MeshDesc,
): MeshGpuRecord {
  const normalized = normalizeMeshDesc(desc);
  const vao = gl.createVertexArray();
  const vertexBuffer = gl.createBuffer();
  if (vao === null || vertexBuffer === null) {
    throw rendererError("E_BACKEND_INIT", "Could not allocate mesh buffers.");
  }
  const layout = ABI_LAYOUTS[normalized.layout];

  state.bindVertexArray(vao);
  state.bindArrayBuffer(vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, normalized.vertexData, gl.STATIC_DRAW);
  const vertexAttributes = layout.buffers[0]?.attributes ?? [];
  for (let index = 0; index < vertexAttributes.length; index += 1) {
    const attribute = vertexAttributes[index];
    if (attribute === undefined) continue;
    const size =
      attribute.format === "float32x3" ? 3 : attribute.format === "float32x2" ? 2 : 4;
    setupAttribute(gl, attribute.shaderLocation, size, ABI_VERTEX_STRIDE, attribute.offset, 0);
  }

  let indexBuffer: WebGLBuffer | null = null;
  if (normalized.indexData !== null) {
    indexBuffer = gl.createBuffer();
    if (indexBuffer === null) {
      throw rendererError("E_BACKEND_INIT", "Could not allocate an index buffer.");
    }
    state.bindElementBuffer(indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, normalized.indexData, gl.STATIC_DRAW);
  }

  let instanceBuffer: WebGLBuffer | null = null;
  let instanceCapacity = 0;
  if (normalized.layout === "instanced-transform-v1") {
    instanceBuffer = gl.createBuffer();
    if (instanceBuffer === null) {
      throw rendererError("E_BACKEND_INIT", "Could not allocate an instance buffer.");
    }
    instanceCapacity = 1;
    state.bindArrayBuffer(instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instanceCapacity * ABI_INSTANCE_STRIDE, gl.DYNAMIC_DRAW);
    const instanceAttributes = layout.buffers[1]?.attributes ?? [];
    for (let index = 0; index < instanceAttributes.length; index += 1) {
      const attribute = instanceAttributes[index];
      if (attribute === undefined) continue;
      setupAttribute(
        gl,
        attribute.shaderLocation,
        4,
        ABI_INSTANCE_STRIDE,
        attribute.offset,
        1,
      );
    }
  }

  state.bindVertexArray(null);
  const byteSize =
    normalized.vertexData.byteLength +
    (normalized.indexData === null ? 0 : normalized.indexData.byteLength) +
    instanceCapacity * ABI_INSTANCE_STRIDE;
  return {
    vao,
    vertexBuffer,
    indexBuffer,
    instanceBuffer,
    instanceCapacity,
    vertexCount: normalized.vertexCount,
    indexCount: normalized.indexCount,
    indexType: normalized.indexType,
    layout: normalized.layout,
    bounds: normalized.bounds,
    desc,
    byteSize,
  };
}

/** Grows the instance buffer; returns false when the ABI cap is exceeded. */
export function ensureInstanceCapacity(
  gl: WebGL2RenderingContext,
  state: StateCache,
  record: MeshGpuRecord,
  required: number,
): boolean {
  if (record.instanceBuffer === null) return false;
  if (required <= record.instanceCapacity) return true;
  if (required > ABI_MAX_INSTANCE_CAPACITY) return false;
  let capacity = record.instanceCapacity;
  while (capacity < required) capacity *= 2;
  if (capacity > ABI_MAX_INSTANCE_CAPACITY) capacity = ABI_MAX_INSTANCE_CAPACITY;
  state.bindArrayBuffer(record.instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, capacity * ABI_INSTANCE_STRIDE, gl.DYNAMIC_DRAW);
  record.byteSize += (capacity - record.instanceCapacity) * ABI_INSTANCE_STRIDE;
  record.instanceCapacity = capacity;
  return true;
}

export function deleteMeshGpu(gl: WebGL2RenderingContext, record: MeshGpuRecord): void {
  gl.deleteVertexArray(record.vao);
  gl.deleteBuffer(record.vertexBuffer);
  if (record.indexBuffer !== null) gl.deleteBuffer(record.indexBuffer);
  if (record.instanceBuffer !== null) gl.deleteBuffer(record.instanceBuffer);
}

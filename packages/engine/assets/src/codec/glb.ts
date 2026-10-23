/**
 * GLB / glTF subset decoder (06 §4.5).
 *
 * Exactly one mesh, 1–8 triangle primitives, embedded BIN chunk, POSITION /
 * NORMAL / TEXCOORD_0 as float32, uint16/uint32 indices. TANGENT and COLOR_0
 * are accepted and dropped (the static-pbr-v1 ABI has no slots) and counted
 * for the profiler. Everything else is ignored or rejected per the spec.
 */

import type { MeshData, MeshPrimitive } from "../contracts/assets.js";
import { assetError } from "../errors.js";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const DROPPED_ATTRIBUTES: ReadonlySet<string> = new Set([
  "TANGENT",
  "COLOR_0",
]);

export interface DecodedMesh {
  readonly mesh: MeshData;
  readonly droppedAttributes: number;
}

interface GltfBufferView {
  readonly buffer: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly byteStride: number | null;
}

interface GltfAccessor {
  readonly bufferView: number;
  readonly byteOffset: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
  readonly min: readonly number[] | null;
  readonly max: readonly number[] | null;
}

interface GltfPrimitive {
  readonly attributes: Readonly<Record<string, number>>;
  readonly indices: number;
  readonly material: number;
  readonly mode: number;
}

interface GltfDocument {
  readonly bufferByteLength: number;
  readonly bufferViews: readonly GltfBufferView[];
  readonly accessors: readonly GltfAccessor[];
  readonly primitives: readonly GltfPrimitive[];
  readonly materialNames: readonly string[];
}

interface AccessorLayout {
  readonly accessor: GltfAccessor;
  readonly view: GltfBufferView;
  readonly elementSize: number;
  readonly stride: number;
}

function fail(id: string, reason: string): never {
  throw assetError("E_ASSET_FORMAT", `${id}: ${reason}`, id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function componentSize(componentType: number): number {
  switch (componentType) {
    case 5120:
    case 5121:
      return 1;
    case 5122:
    case 5123:
      return 2;
    case 5125:
    case 5126:
      return 4;
    default:
      return 0;
  }
}

function componentCount(type: string): number {
  switch (type) {
    case "SCALAR":
      return 1;
    case "VEC2":
      return 2;
    case "VEC3":
      return 3;
    case "VEC4":
      return 4;
    case "MAT2":
      return 4;
    case "MAT3":
      return 9;
    case "MAT4":
      return 16;
    default:
      return 0;
  }
}

function parseNumberArray(value: unknown): readonly number[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const numbers: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return null;
    numbers.push(item);
  }
  return numbers;
}

function parseDocument(
  json: Record<string, unknown>,
  binByteLength: number,
  id: string,
): GltfDocument {
  const extensionsRequiredValue = json["extensionsRequired"];
  if (
    extensionsRequiredValue !== undefined &&
    !Array.isArray(extensionsRequiredValue)
  ) {
    fail(id, "extensionsRequired must be an array");
  }
  if (
    Array.isArray(extensionsRequiredValue) &&
    extensionsRequiredValue.length > 0
  ) {
    fail(id, "extensionsRequired is not supported in M0");
  }

  const buffersValue = json["buffers"];
  if (!Array.isArray(buffersValue) || buffersValue.length !== 1) {
    fail(id, "buffers must contain exactly one embedded buffer");
  }
  const bufferValue = buffersValue[0];
  if (!isRecord(bufferValue)) fail(id, "buffers[0] must be an object");
  if (bufferValue["uri"] !== undefined) {
    fail(id, "external buffers and data URIs are not supported");
  }
  const bufferByteLength = bufferValue["byteLength"];
  if (!nonNegativeInteger(bufferByteLength) || bufferByteLength <= 0) {
    fail(id, "buffers[0].byteLength must be a positive integer");
  }
  if (bufferByteLength > binByteLength) {
    fail(id, "buffers[0].byteLength exceeds the BIN chunk");
  }
  if (binByteLength - bufferByteLength > 3) {
    fail(id, "BIN chunk padding is not valid");
  }

  const bufferViewsValue = json["bufferViews"];
  if (!Array.isArray(bufferViewsValue) || bufferViewsValue.length === 0) {
    fail(id, "bufferViews must be a non-empty array");
  }
  const bufferViews: GltfBufferView[] = [];
  for (let index = 0; index < bufferViewsValue.length; index += 1) {
    const raw = bufferViewsValue[index];
    if (!isRecord(raw)) fail(id, `bufferViews[${index}] must be an object`);
    const buffer = raw["buffer"];
    const byteOffset = raw["byteOffset"] ?? 0;
    const byteLength = raw["byteLength"];
    const byteStride =
      raw["byteStride"] === undefined ? null : raw["byteStride"];
    if (buffer !== 0) {
      fail(id, `bufferViews[${index}].buffer must be 0`);
    }
    if (!nonNegativeInteger(byteOffset)) {
      fail(id, `bufferViews[${index}].byteOffset is invalid`);
    }
    if (!nonNegativeInteger(byteLength) || byteLength <= 0) {
      fail(id, `bufferViews[${index}].byteLength is invalid`);
    }
    if (byteOffset + byteLength > bufferByteLength) {
      fail(id, `bufferViews[${index}] points outside the BIN chunk`);
    }
    if (byteStride !== null) {
      if (!nonNegativeInteger(byteStride) || byteStride <= 0) {
        fail(id, `bufferViews[${index}].byteStride is invalid`);
      }
    }
    bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength,
      byteStride: byteStride === null ? null : (byteStride as number),
    });
  }

  const accessorsValue = json["accessors"];
  if (!Array.isArray(accessorsValue) || accessorsValue.length === 0) {
    fail(id, "accessors must be a non-empty array");
  }
  const accessors: GltfAccessor[] = [];
  for (let index = 0; index < accessorsValue.length; index += 1) {
    const raw = accessorsValue[index];
    if (!isRecord(raw)) fail(id, `accessors[${index}] must be an object`);
    const bufferView = raw["bufferView"];
    const byteOffset = raw["byteOffset"] ?? 0;
    const componentType = raw["componentType"];
    const count = raw["count"];
    const type = raw["type"];
    const normalized = raw["normalized"] ?? false;
    if (raw["sparse"] !== undefined) {
      fail(id, `accessors[${index}] must not be sparse`);
    }
    if (normalized !== false) {
      fail(id, `accessors[${index}] must not be normalized`);
    }
    if (
      !nonNegativeInteger(bufferView) ||
      bufferView >= bufferViews.length
    ) {
      fail(id, `accessors[${index}].bufferView is invalid`);
    }
    if (!nonNegativeInteger(byteOffset)) {
      fail(id, `accessors[${index}].byteOffset is invalid`);
    }
    if (typeof componentType !== "number") {
      fail(id, `accessors[${index}].componentType is invalid`);
    }
    if (!nonNegativeInteger(count) || count <= 0) {
      fail(id, `accessors[${index}].count is invalid`);
    }
    if (typeof type !== "string" || componentCount(type) === 0) {
      fail(id, `accessors[${index}].type is invalid`);
    }
    const size = componentSize(componentType);
    if (size === 0) {
      fail(id, `accessors[${index}].componentType is unsupported`);
    }
    const view = bufferViews[bufferView];
    if (view === undefined) {
      fail(id, `accessors[${index}].bufferView is invalid`);
    }
    const elementSize = size * componentCount(type);
    const stride = view.byteStride ?? elementSize;
    if (stride < elementSize) {
      fail(id, `accessors[${index}] stride is smaller than its element`);
    }
    if (byteOffset + stride * (count - 1) + elementSize > view.byteLength) {
      fail(id, `accessors[${index}] points outside its buffer view`);
    }
    accessors.push({
      bufferView,
      byteOffset,
      componentType,
      count,
      type,
      min: parseNumberArray(raw["min"]),
      max: parseNumberArray(raw["max"]),
    });
  }

  const meshesValue = json["meshes"];
  if (!Array.isArray(meshesValue) || meshesValue.length !== 1) {
    fail(id, "meshes must contain exactly one mesh");
  }
  const meshValue = meshesValue[0];
  if (!isRecord(meshValue)) fail(id, "meshes[0] must be an object");
  const primitivesValue = meshValue["primitives"];
  if (
    !Array.isArray(primitivesValue) ||
    primitivesValue.length < 1 ||
    primitivesValue.length > 8
  ) {
    fail(id, "meshes[0].primitives must contain 1 to 8 primitives");
  }
  const primitives: GltfPrimitive[] = [];
  for (let index = 0; index < primitivesValue.length; index += 1) {
    const raw = primitivesValue[index];
    if (!isRecord(raw)) {
      fail(id, `meshes[0].primitives[${index}] must be an object`);
    }
    const extensions = raw["extensions"];
    if (isRecord(extensions)) {
      if (extensions["KHR_draco_mesh_compression"] !== undefined) {
        fail(id, "KHR_draco_mesh_compression is not supported in M0");
      }
      if (extensions["EXT_meshopt_compression"] !== undefined) {
        fail(id, "EXT_meshopt_compression is not supported in M0");
      }
    }
    const mode = raw["mode"] ?? 4;
    if (mode !== 4) {
      fail(id, `meshes[0].primitives[${index}].mode must be triangles`);
    }
    const attributes = raw["attributes"];
    if (!isRecord(attributes)) {
      fail(id, `meshes[0].primitives[${index}].attributes must be an object`);
    }
    const parsedAttributes: Record<string, number> = Object.create(
      null,
    ) as Record<string, number>;
    for (const name of Object.keys(attributes)) {
      const accessorIndex = attributes[name];
      if (
        !nonNegativeInteger(accessorIndex) ||
        accessorIndex >= accessors.length
      ) {
        fail(
          id,
          `meshes[0].primitives[${index}].attributes.${name} is invalid`,
        );
      }
      parsedAttributes[name] = accessorIndex;
    }
    const indices = raw["indices"];
    if (!nonNegativeInteger(indices) || indices >= accessors.length) {
      fail(id, `meshes[0].primitives[${index}].indices is required`);
    }
    const materialValue = raw["material"] === undefined ? -1 : raw["material"];
    if (
      materialValue !== -1 &&
      (!nonNegativeInteger(materialValue) || materialValue >= 1_000_000)
    ) {
      fail(id, `meshes[0].primitives[${index}].material is invalid`);
    }
    primitives.push({
      attributes: parsedAttributes,
      indices,
      material: materialValue as number,
      mode: 4,
    });
  }

  const materialsValue = json["materials"];
  const materialNames: string[] = [];
  if (materialsValue !== undefined) {
    if (!Array.isArray(materialsValue)) {
      fail(id, "materials must be an array");
    }
    for (let index = 0; index < materialsValue.length; index += 1) {
      const raw = materialsValue[index];
      if (!isRecord(raw)) fail(id, `materials[${index}] must be an object`);
      const name = raw["name"];
      if (name !== undefined && typeof name !== "string") {
        fail(id, `materials[${index}].name must be a string`);
      }
      materialNames.push(typeof name === "string" ? name : "");
    }
  }

  for (let index = 0; index < primitives.length; index += 1) {
    const primitive = primitives[index];
    if (primitive === undefined) continue;
    if (
      primitive.material !== -1 &&
      primitive.material >= materialNames.length
    ) {
      fail(id, `meshes[0].primitives[${index}].material does not exist`);
    }
  }

  return {
    bufferByteLength,
    bufferViews,
    accessors,
    primitives,
    materialNames,
  };
}

function accessorLayout(
  accessors: readonly GltfAccessor[],
  bufferViews: readonly GltfBufferView[],
  accessorIndex: number,
  id: string,
  label: string,
): AccessorLayout {
  const accessor = accessors[accessorIndex];
  if (accessor === undefined) fail(id, `${label} accessor is missing`);
  const view = bufferViews[accessor.bufferView];
  if (view === undefined) fail(id, `${label} buffer view is missing`);
  const size = componentSize(accessor.componentType);
  const elementSize = size * componentCount(accessor.type);
  const stride = view.byteStride ?? elementSize;
  return { accessor, view, elementSize, stride };
}

function readFloat(
  data: DataView,
  binOffset: number,
  layout: AccessorLayout,
  index: number,
  component: number,
): number {
  const offset =
    binOffset +
    layout.view.byteOffset +
    layout.accessor.byteOffset +
    index * layout.stride +
    component * 4;
  return data.getFloat32(offset, true);
}

function readIndex(
  data: DataView,
  binOffset: number,
  layout: AccessorLayout,
  index: number,
): number {
  const offset =
    binOffset +
    layout.view.byteOffset +
    layout.accessor.byteOffset +
    index * layout.stride;
  if (layout.accessor.componentType === UNSIGNED_SHORT) {
    return data.getUint16(offset, true);
  }
  return data.getUint32(offset, true);
}

interface Bounds3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

function emptyBounds(): Bounds3 {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

function extendBounds(bounds: Bounds3, x: number, y: number, z: number): void {
  if (x < bounds.minX) bounds.minX = x;
  if (y < bounds.minY) bounds.minY = y;
  if (z < bounds.minZ) bounds.minZ = z;
  if (x > bounds.maxX) bounds.maxX = x;
  if (y > bounds.maxY) bounds.maxY = y;
  if (z > bounds.maxZ) bounds.maxZ = z;
}

function sphereFromBounds(
  bounds: Bounds3,
  positions: readonly Float32Array[],
): MeshData["bounds"] {
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  let radiusSquared = 0;
  for (const vertices of positions) {
    for (let offset = 0; offset < vertices.length; offset += 8) {
      const dx = (vertices[offset] ?? 0) - centerX;
      const dy = (vertices[offset + 1] ?? 0) - centerY;
      const dz = (vertices[offset + 2] ?? 0) - centerZ;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance > radiusSquared) radiusSquared = distance;
    }
  }
  return {
    center: { x: centerX, y: centerY, z: centerZ },
    radius: Math.sqrt(radiusSquared),
  };
}

function crossCheckBounds(
  id: string,
  label: string,
  accessor: GltfAccessor,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  const tolerance = 1e-4;
  if (accessor.min !== null) {
    const expected = accessor.min;
    if (expected.length < 3) fail(id, `${label}.min must have three numbers`);
    if (
      Math.abs((expected[0] ?? 0) - minX) > tolerance ||
      Math.abs((expected[1] ?? 0) - minY) > tolerance ||
      Math.abs((expected[2] ?? 0) - minZ) > tolerance
    ) {
      fail(id, `${label}.min does not match POSITION data`);
    }
  }
  if (accessor.max !== null) {
    const expected = accessor.max;
    if (expected.length < 3) fail(id, `${label}.max must have three numbers`);
    if (
      Math.abs((expected[0] ?? 0) - maxX) > tolerance ||
      Math.abs((expected[1] ?? 0) - maxY) > tolerance ||
      Math.abs((expected[2] ?? 0) - maxZ) > tolerance
    ) {
      fail(id, `${label}.max does not match POSITION data`);
    }
  }
}

/**
 * Decodes a GLB into `MeshData`. Throws `E_ASSET_FORMAT` on any accepted-set
 * violation; never fetches and never imports DOM APIs.
 */
export function decodeGlb(id: string, bytes: ArrayBuffer): DecodedMesh {
  if (bytes.byteLength < 20) fail(id, "GLB is too small");
  const data = new DataView(bytes);
  if (data.getUint32(0, true) !== GLB_MAGIC) fail(id, "GLB magic is not glTF");
  if (data.getUint32(4, true) !== 2) fail(id, "GLB version must be 2");
  if (data.getUint32(8, true) !== bytes.byteLength) {
    fail(id, "GLB length does not equal the buffer length");
  }

  let offset = 12;
  let chunkIndex = 0;
  let jsonChunk: Uint8Array | null = null;
  let binChunk: Uint8Array | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = data.getUint32(offset, true);
    const chunkType = data.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > bytes.byteLength) fail(id, "GLB chunk exceeds the buffer");
    if (chunkLength % 4 !== 0) fail(id, "GLB chunks must be 4-byte aligned");
    if (chunkIndex === 0 && chunkType !== CHUNK_JSON) {
      fail(id, "GLB chunk 0 must be JSON");
    }
    if (chunkIndex === 1 && chunkType !== CHUNK_BIN) {
      fail(id, "GLB chunk 1 must be BIN");
    }
    if (chunkType === CHUNK_JSON && jsonChunk === null) {
      jsonChunk = new Uint8Array(bytes, chunkStart, chunkLength);
    } else if (chunkType === CHUNK_BIN && binChunk === null) {
      binChunk = new Uint8Array(bytes, chunkStart, chunkLength);
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (offset !== bytes.byteLength) fail(id, "GLB has trailing bytes");
  if (jsonChunk === null) fail(id, "GLB has no JSON chunk");
  if (binChunk === null) fail(id, "GLB has no BIN chunk");
  if (binChunk.byteLength === 0) fail(id, "GLB BIN chunk is empty");

  let jsonEnd = jsonChunk.byteLength;
  while (
    jsonEnd > 0 &&
    (jsonChunk[jsonEnd - 1] === 0x20 || jsonChunk[jsonEnd - 1] === 0x00)
  ) {
    jsonEnd -= 1;
  }
  let jsonText: string;
  try {
    jsonText = new TextDecoder("utf-8", { fatal: true }).decode(
      jsonChunk.subarray(0, jsonEnd),
    );
  } catch {
    fail(id, "GLB JSON chunk is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    fail(id, "GLB JSON chunk is not valid JSON");
  }
  if (!isRecord(parsed)) fail(id, "GLB JSON root must be an object");

  const document = parseDocument(parsed, binChunk.byteLength, id);
  const binOffset = binChunk.byteOffset;
  const binData = new DataView(bytes);
  const primitives: MeshPrimitive[] = [];
  const positions: Float32Array[] = [];
  const unionBounds = emptyBounds();
  let droppedAttributes = 0;

  for (
    let primitiveIndex = 0;
    primitiveIndex < document.primitives.length;
    primitiveIndex += 1
  ) {
    const primitive = document.primitives[primitiveIndex];
    if (primitive === undefined) continue;

    for (const name of Object.keys(primitive.attributes)) {
      if (DROPPED_ATTRIBUTES.has(name)) droppedAttributes += 1;
    }

    const positionIndex = primitive.attributes["POSITION"];
    const normalIndex = primitive.attributes["NORMAL"];
    const uvIndex = primitive.attributes["TEXCOORD_0"];
    if (positionIndex === undefined) fail(id, "POSITION is required");
    if (normalIndex === undefined) fail(id, "NORMAL is required");
    if (uvIndex === undefined) fail(id, "TEXCOORD_0 is required");

    const position = accessorLayout(
      document.accessors,
      document.bufferViews,
      positionIndex,
      id,
      "POSITION",
    );
    const normal = accessorLayout(
      document.accessors,
      document.bufferViews,
      normalIndex,
      id,
      "NORMAL",
    );
    const uv = accessorLayout(
      document.accessors,
      document.bufferViews,
      uvIndex,
      id,
      "TEXCOORD_0",
    );
    const indexLayout = accessorLayout(
      document.accessors,
      document.bufferViews,
      primitive.indices,
      id,
      "indices",
    );

    if (
      position.accessor.componentType !== FLOAT ||
      position.accessor.type !== "VEC3"
    ) {
      fail(id, "POSITION must be float32 VEC3");
    }
    if (
      normal.accessor.componentType !== FLOAT ||
      normal.accessor.type !== "VEC3"
    ) {
      fail(id, "NORMAL must be float32 VEC3");
    }
    if (uv.accessor.componentType !== FLOAT || uv.accessor.type !== "VEC2") {
      fail(id, "TEXCOORD_0 must be float32 VEC2");
    }
    if (
      position.accessor.count !== normal.accessor.count ||
      position.accessor.count !== uv.accessor.count
    ) {
      fail(id, "vertex attribute counts must match");
    }
    if (
      indexLayout.accessor.componentType !== UNSIGNED_SHORT &&
      indexLayout.accessor.componentType !== UNSIGNED_INT
    ) {
      fail(id, "indices must be uint16 or uint32");
    }
    if (indexLayout.accessor.type !== "SCALAR") {
      fail(id, "indices must be SCALAR");
    }
    if (indexLayout.accessor.count % 3 !== 0) {
      fail(id, "index count must be a multiple of 3");
    }

    const vertexCount = position.accessor.count;
    const indexCount = indexLayout.accessor.count;
    const vertices = new Float32Array(vertexCount * 8);
    let localMinX = Infinity;
    let localMinY = Infinity;
    let localMinZ = Infinity;
    let localMaxX = -Infinity;
    let localMaxY = -Infinity;
    let localMaxZ = -Infinity;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const px = readFloat(binData, binOffset, position, vertex, 0);
      const py = readFloat(binData, binOffset, position, vertex, 1);
      const pz = readFloat(binData, binOffset, position, vertex, 2);
      const nx = readFloat(binData, binOffset, normal, vertex, 0);
      const ny = readFloat(binData, binOffset, normal, vertex, 1);
      const nz = readFloat(binData, binOffset, normal, vertex, 2);
      const u = readFloat(binData, binOffset, uv, vertex, 0);
      const v = readFloat(binData, binOffset, uv, vertex, 1);
      const out = vertex * 8;
      vertices[out] = px;
      vertices[out + 1] = py;
      vertices[out + 2] = pz;
      vertices[out + 3] = nx;
      vertices[out + 4] = ny;
      vertices[out + 5] = nz;
      vertices[out + 6] = u;
      vertices[out + 7] = v;
      if (px < localMinX) localMinX = px;
      if (py < localMinY) localMinY = py;
      if (pz < localMinZ) localMinZ = pz;
      if (px > localMaxX) localMaxX = px;
      if (py > localMaxY) localMaxY = py;
      if (pz > localMaxZ) localMaxZ = pz;
      extendBounds(unionBounds, px, py, pz);
    }
    crossCheckBounds(
      id,
      "POSITION",
      position.accessor,
      localMinX,
      localMinY,
      localMinZ,
      localMaxX,
      localMaxY,
      localMaxZ,
    );

    const indices =
      indexLayout.accessor.componentType === UNSIGNED_SHORT
        ? new Uint16Array(indexCount)
        : new Uint32Array(indexCount);
    let maxIndex = -1;
    for (let index = 0; index < indexCount; index += 1) {
      const value = readIndex(binData, binOffset, indexLayout, index);
      if (value >= vertexCount) {
        fail(id, "index is larger than the vertex count");
      }
      if (value > maxIndex) maxIndex = value;
      indices[index] = value;
    }
    if (maxIndex < 0 && indexCount > 0) {
      fail(id, "indices are invalid");
    }

    const primitiveBounds: MeshData["bounds"] = sphereFromBounds(
      {
        minX: localMinX,
        minY: localMinY,
        minZ: localMinZ,
        maxX: localMaxX,
        maxY: localMaxY,
        maxZ: localMaxZ,
      },
      [vertices],
    );

    primitives.push({
      vertices,
      indices,
      indexFormat:
        indexLayout.accessor.componentType === UNSIGNED_SHORT
          ? "uint16"
          : "uint32",
      vertexCount,
      indexCount,
      bounds: primitiveBounds,
      materialSlot: primitive.material,
    });
    positions.push(vertices);
  }

  if (primitives.length === 0) fail(id, "mesh has no primitives");
  const bounds = sphereFromBounds(unionBounds, positions);
  const mesh: MeshData = {
    formatVersion: 1,
    id,
    bounds,
    primitives,
    materialNames: document.materialNames,
  };
  return { mesh, droppedAttributes };
}

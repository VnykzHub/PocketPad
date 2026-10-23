/**
 * ABI 1 uniform packing and vertex layouts (04 §4.2–§4.7).
 *
 * Pure functions: no WebGPU handle is touched. Writers overwrite their whole
 * destination slice so reserved bytes stay deterministic and never retain a
 * previous object's data.
 */

import { mat4Invert } from "@lanpad/engine-core";
import type { Mat4, MeshDesc } from "@lanpad/engine-core";

export const FRAME_UNIFORM_BYTES = 256;
export const LIGHT_UNIFORM_BYTES = 2048;
export const OBJECT_UNIFORM_BYTES = 256;
export const OBJECT_UNIFORM_STRIDE = 256;
export const OBJECTS_PER_FRAME = 8192;
export const INSTANCE_STRIDE_BYTES = 64;

export const FRAME_UNIFORM_OFFSETS = {
  viewProjection: 0,
  cameraPosition: 64,
  time: 80,
  ambient: 96,
  resolution: 112,
  fog: 128,
  clip: 144,
  reserved: 160,
} as const;

export const LIGHT_UNIFORM_OFFSETS = {
  counts: 0,
  directional: 16,
  cascadeMatrices: 144,
  cascadeSplits: 336,
  point: 352,
  shadowAtlas: 1376,
  reserved: 1392,
} as const;

export const OBJECT_UNIFORM_OFFSETS = {
  model: 0,
  normalMatrixColumns: 64,
  tint: 112,
  reserved: 128,
} as const;

export const VERTEX_STRIDE_BYTES = 32;

export interface VertexAttributeLayout {
  readonly name: string;
  readonly shaderLocation: number;
  readonly offset: number;
  readonly format: "float32x3" | "float32x2" | "float32x4";
}

export interface VertexBufferLayout {
  readonly slot: number;
  readonly stepMode: "vertex" | "instance";
  readonly arrayStride: number;
  readonly attributes: readonly VertexAttributeLayout[];
}

export interface VertexLayoutDefinition {
  readonly id: MeshDesc["layout"];
  readonly baseLayout: MeshDesc["layout"] | null;
  readonly buffers: readonly VertexBufferLayout[];
}

const STATIC_ATTRIBUTES: readonly VertexAttributeLayout[] = [
  { name: "position", shaderLocation: 0, offset: 0, format: "float32x3" },
  { name: "normal", shaderLocation: 1, offset: 12, format: "float32x3" },
  { name: "uv", shaderLocation: 2, offset: 24, format: "float32x2" },
];

const INSTANCE_ATTRIBUTES: readonly VertexAttributeLayout[] = [
  { name: "model0", shaderLocation: 3, offset: 0, format: "float32x4" },
  { name: "model1", shaderLocation: 4, offset: 16, format: "float32x4" },
  { name: "model2", shaderLocation: 5, offset: 32, format: "float32x4" },
  { name: "model3", shaderLocation: 6, offset: 48, format: "float32x4" },
];

export const VERTEX_LAYOUTS: readonly VertexLayoutDefinition[] = [
  {
    id: "static-pbr-v1",
    baseLayout: null,
    buffers: [
      {
        slot: 0,
        stepMode: "vertex",
        arrayStride: VERTEX_STRIDE_BYTES,
        attributes: STATIC_ATTRIBUTES,
      },
    ],
  },
  {
    id: "instanced-transform-v1",
    baseLayout: "static-pbr-v1",
    buffers: [
      {
        slot: 0,
        stepMode: "vertex",
        arrayStride: VERTEX_STRIDE_BYTES,
        attributes: STATIC_ATTRIBUTES,
      },
      {
        slot: 1,
        stepMode: "instance",
        arrayStride: INSTANCE_STRIDE_BYTES,
        attributes: INSTANCE_ATTRIBUTES,
      },
    ],
  },
];

export function vertexLayoutDefinition(
  layout: MeshDesc["layout"],
): VertexLayoutDefinition | undefined {
  for (const candidate of VERTEX_LAYOUTS) {
    if (candidate.id === layout) {
      return candidate;
    }
  }
  return undefined;
}

export function indexFormatForVertexCount(
  vertexCount: number,
): "uint16" | "uint32" {
  return vertexCount <= 65_535 ? "uint16" : "uint32";
}

export interface FrameUniformInput {
  readonly viewProjection: Mat4;
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
  readonly timeSeconds: number;
  readonly deltaSeconds: number;
  readonly frameIndex: number;
  readonly exposure: number;
  readonly ambientRgb: readonly [number, number, number];
  readonly ambientIntensity: number;
  readonly width: number;
  readonly height: number;
  readonly fogRgb: readonly [number, number, number];
  readonly fogDensity: number;
  readonly near: number;
  readonly far: number;
}

/** Writes all 64 floats. `out.length` must be at least 64. */
export function writeFrameUniforms(
  out: Float32Array,
  input: FrameUniformInput,
): void {
  out.fill(0);
  out.set(input.viewProjection.m, FRAME_UNIFORM_OFFSETS.viewProjection / 4);
  const camera = FRAME_UNIFORM_OFFSETS.cameraPosition / 4;
  out[camera] = input.cameraX;
  out[camera + 1] = input.cameraY;
  out[camera + 2] = input.cameraZ;
  out[camera + 3] = 1;
  const time = FRAME_UNIFORM_OFFSETS.time / 4;
  out[time] = input.timeSeconds;
  out[time + 1] = input.deltaSeconds;
  out[time + 2] = input.frameIndex;
  out[time + 3] = input.exposure;
  const ambient = FRAME_UNIFORM_OFFSETS.ambient / 4;
  out[ambient] = input.ambientRgb[0];
  out[ambient + 1] = input.ambientRgb[1];
  out[ambient + 2] = input.ambientRgb[2];
  out[ambient + 3] = input.ambientIntensity;
  const resolution = FRAME_UNIFORM_OFFSETS.resolution / 4;
  out[resolution] = input.width;
  out[resolution + 1] = input.height;
  out[resolution + 2] = input.width > 0 ? 1 / input.width : 0;
  out[resolution + 3] = input.height > 0 ? 1 / input.height : 0;
  const fog = FRAME_UNIFORM_OFFSETS.fog / 4;
  out[fog] = input.fogRgb[0];
  out[fog + 1] = input.fogRgb[1];
  out[fog + 2] = input.fogRgb[2];
  out[fog + 3] = input.fogDensity;
  const clip = FRAME_UNIFORM_OFFSETS.clip / 4;
  out[clip] = input.near;
  out[clip + 1] = input.far;
  out[clip + 2] = input.far > input.near ? 1 / (input.far - input.near) : 0;
  out[clip + 3] = 0;
}

export interface LightUniformInput {
  readonly directionalCount: number;
  readonly pointCount: number;
  readonly cascadeCount: number;
  readonly flags: number;
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
  readonly colorR: number;
  readonly colorG: number;
  readonly colorB: number;
  readonly intensity: number;
}

/** Writes the 2048-byte light block. Both views must cover the same 512 floats. */
export function writeLightUniforms(
  floats: Float32Array,
  uints: Uint32Array,
  input: LightUniformInput,
): void {
  floats.fill(0);
  uints[0] = input.directionalCount;
  uints[1] = input.pointCount;
  uints[2] = input.cascadeCount;
  uints[3] = input.flags;
  const base = LIGHT_UNIFORM_OFFSETS.directional / 4;
  floats[base] = input.directionX;
  floats[base + 1] = input.directionY;
  floats[base + 2] = input.directionZ;
  floats[base + 3] = 0;
  floats[base + 4] = input.colorR;
  floats[base + 5] = input.colorG;
  floats[base + 6] = input.colorB;
  floats[base + 7] = input.intensity;
}

const scratchInverse: Mat4 = { m: new Float32Array(16) };

/** Writes a 3×3 column-major normal matrix into the first nine entries. */
export function writeNormalMatrix(out: Float32Array, model: Mat4): boolean {
  const inverted = mat4Invert(scratchInverse, model);
  const m = scratchInverse.m;
  if (!inverted) {
    out.fill(0);
    out[0] = 1;
    out[4] = 1;
    out[8] = 1;
    return false;
  }
  // normal = transpose(inverse(model)); inverse is column-major.
  out[0] = m[0] ?? 0;
  out[1] = m[4] ?? 0;
  out[2] = m[8] ?? 0;
  out[3] = m[1] ?? 0;
  out[4] = m[5] ?? 0;
  out[5] = m[9] ?? 0;
  out[6] = m[2] ?? 0;
  out[7] = m[6] ?? 0;
  out[8] = m[10] ?? 0;
  return true;
}

/** Writes all 64 floats of the per-object block. */
export function writeObjectUniforms(
  out: Float32Array,
  model: Mat4,
  normalMatrix: Float32Array,
  tintR: number,
  tintG: number,
  tintB: number,
  tintA: number,
): void {
  out.fill(0);
  out.set(model.m, 0);
  const n = OBJECT_UNIFORM_OFFSETS.normalMatrixColumns / 4;
  for (let column = 0; column < 3; column += 1) {
    const source = column * 3;
    const target = n + column * 4;
    out[target] = normalMatrix[source] ?? 0;
    out[target + 1] = normalMatrix[source + 1] ?? 0;
    out[target + 2] = normalMatrix[source + 2] ?? 0;
    out[target + 3] = 0;
  }
  const t = OBJECT_UNIFORM_OFFSETS.tint / 4;
  out[t] = tintR;
  out[t + 1] = tintG;
  out[t + 2] = tintB;
  out[t + 3] = tintA;
}

/** Number of bytes covered by one ABI 1 vertex. */
export function vertexByteLength(vertexCount: number): number {
  return vertexCount * VERTEX_STRIDE_BYTES;
}

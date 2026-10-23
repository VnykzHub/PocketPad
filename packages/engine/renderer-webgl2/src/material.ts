/**
 * Material UBO packing and texture-unit assignment (05 §4.5, §5.8).
 *
 * M0 accepts a base-colour texture only. The metallic-roughness, normal,
 * occlusion and emissive maps are M1/M2; supplying one is refused with
 * `E_UNSUPPORTED_FEATURE` rather than silently ignored.
 */

import type { AlphaMode, MaterialDesc } from "@lanpad/engine-core";
import { rendererError } from "./errors.js";
import type { StateCache } from "./state.js";
import { MATERIAL_UBO_BINDING, MATERIAL_UBO_BYTES } from "./shaders/forwardLit.js";
import type { TextureGpuRecord } from "./texture.js";

export interface MaterialGpuRecord {
  readonly ubo: WebGLBuffer;
  readonly data: Float32Array;
  readonly baseTexture: TextureGpuRecord;
  readonly alphaMode: AlphaMode;
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
  readonly unlit: boolean;
  readonly desc: MaterialDesc;
}

function readAlphaMode(value: AlphaMode | undefined): AlphaMode {
  if (value === undefined) return "opaque";
  if (value === "opaque" || value === "mask" || value === "blend") return value;
  throw rendererError("E_CONTRACT", `Unknown alphaMode "${String(value)}".`);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return value < min ? min : value > max ? max : value;
}

function readFactor(value: readonly [number, number, number, number]): void {
  if (value.length !== 4) {
    throw rendererError("E_CONTRACT", "baseColorFactor must have four components.");
  }
  for (let index = 0; index < 4; index += 1) {
    const component = value[index];
    if (component === undefined || !Number.isFinite(component)) {
      throw rendererError("E_CONTRACT", "baseColorFactor components must be finite.");
    }
  }
}

function rejectUnsupportedMaps(desc: MaterialDesc): void {
  if (desc.metallicRoughnessTexture != null) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Metallic-roughness textures are M1; the M0 WebGL2 pass accepts a base-colour texture only.",
    );
  }
  if (desc.normalTexture != null) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Normal maps are M1; the M0 WebGL2 pass accepts a base-colour texture only.",
    );
  }
  if (desc.occlusionTexture != null) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Occlusion textures are M1; the M0 WebGL2 pass accepts a base-colour texture only.",
    );
  }
  if (desc.emissiveTexture != null) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Emissive textures are M1; the M0 WebGL2 pass accepts a base-colour texture only.",
    );
  }
}

export function createMaterialGpu(
  gl: WebGL2RenderingContext,
  state: StateCache,
  desc: MaterialDesc,
  resolveTexture: (index: number, generation: number) => TextureGpuRecord | null,
  defaultTexture: TextureGpuRecord,
): MaterialGpuRecord {
  readFactor(desc.baseColorFactor);
  if (!Number.isFinite(desc.metallic) || !Number.isFinite(desc.roughness)) {
    throw rendererError("E_CONTRACT", "metallic and roughness must be finite.");
  }
  rejectUnsupportedMaps(desc);

  let baseTexture = defaultTexture;
  const handle = desc.baseColorTexture;
  if (handle != null) {
    const resolved = resolveTexture(handle.index, handle.generation);
    if (resolved === null) {
      throw rendererError("E_STALE_HANDLE", "baseColorTexture is not a live texture handle.");
    }
    baseTexture = resolved;
  }

  const alphaMode = readAlphaMode(desc.alphaMode);
  const alphaCutoff =
    alphaMode === "mask" ? clamp(desc.alphaCutoff ?? 0.5, 0, 1) : (desc.alphaCutoff ?? 0.5);
  const data = new Float32Array(MATERIAL_UBO_BYTES / 4);
  const baseColor = desc.baseColorFactor;
  data[0] = baseColor[0];
  data[1] = baseColor[1];
  data[2] = baseColor[2];
  data[3] = baseColor[3];
  data[4] = clamp(desc.metallic, 0, 1);
  data[5] = clamp(desc.roughness, 0.04, 1);
  data[6] = alphaCutoff;
  data[7] = desc.unlit === true ? 1 : 0;
  const emissive = desc.emissiveFactor;
  data[8] = Number.isFinite(emissive[0]) ? emissive[0] : 0;
  data[9] = Number.isFinite(emissive[1]) ? emissive[1] : 0;
  data[10] = Number.isFinite(emissive[2]) ? emissive[2] : 0;
  data[11] = 0;
  data[12] = clamp(desc.normalScale ?? 1, 0, 1);
  data[13] = clamp(desc.occlusionStrength ?? 1, 0, 1);
  data[14] = 0;
  data[15] = 0;

  const ubo = gl.createBuffer();
  if (ubo === null) {
    throw rendererError("E_BACKEND_INIT", "Could not allocate the material UBO.");
  }
  // A direct bind is safe: the ring rebinds the frame block at each beginFrame.
  gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
  gl.bufferData(gl.UNIFORM_BUFFER, data, gl.STATIC_DRAW);
  state.bindBufferBase(MATERIAL_UBO_BINDING, gl.UNIFORM_BUFFER, ubo);

  return {
    ubo,
    data,
    baseTexture,
    alphaMode,
    alphaCutoff,
    doubleSided: desc.doubleSided === true,
    unlit: desc.unlit === true,
    desc,
  };
}

/** Binds the material block and base-colour texture (unit 0). */
export function bindMaterialGpu(
  gl: WebGL2RenderingContext,
  state: StateCache,
  record: MaterialGpuRecord,
): void {
  state.bindBufferBase(MATERIAL_UBO_BINDING, gl.UNIFORM_BUFFER, record.ubo);
  state.bindTexture(0, gl.TEXTURE_2D, record.baseTexture.texture);
  state.bindSampler(0, record.baseTexture.sampler);
}

export function deleteMaterialGpu(
  gl: WebGL2RenderingContext,
  record: MaterialGpuRecord,
): void {
  gl.deleteBuffer(record.ubo);
}

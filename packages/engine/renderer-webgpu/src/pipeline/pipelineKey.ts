/**
 * Canonical shader and pipeline cache keys (04 §4.2, §4.8).
 *
 * The key encoding is implementation-owned. Nothing in the renderer may rely
 * on the exact string; equality is canonical-string equality. The FNV-1a hash
 * is a stats label only and is never used for lookup equality.
 */

import type {
  PipelineCacheKey,
  PipelineKeyInputs,
  ShaderModuleKey,
  ShaderModuleKeyParts,
} from "../contracts/webgpu.js";
import { rendererError } from "../errors.js";
import { PIPELINE_CACHE_VERSION } from "../version.js";

export const MAX_PIPELINE_KEY_BYTES = 4096;
export const MAX_SHADER_MODULE_KEY_BYTES = 65_536 * 2 + 1024;

const encoder = new TextEncoder();

export function utf8Bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

/** FNV-1a 32-bit. Returns an unsigned integer. */
export function fnv1a32(text: string): number {
  const bytes = encoder.encode(text);
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export type DefineValue = boolean | number;

const DEFINE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Canonical define object: keys sorted, booleans and finite numbers only.
 * This matches the fixture's `{"ALPHA_MASK":false,"NORMAL_MAP":true}` form.
 */
export function canonicalDefines(
  defines: Readonly<Record<string, DefineValue>> | undefined,
): string {
  if (defines === undefined) {
    return "{}";
  }
  const keys = Object.keys(defines).sort();
  const parts: string[] = [];
  for (const key of keys) {
    if (!DEFINE_NAME.test(key)) {
      throw rendererError("E_CONTRACT", `invalid shader define name: ${key}`, {
        label: "shader-defines",
      });
    }
    const value = defines[key];
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw rendererError(
          "E_CONTRACT",
          `shader define ${key} must be a finite number`,
          { label: "shader-defines" },
        );
      }
      parts.push(`${JSON.stringify(key)}:${String(value)}`);
    } else if (typeof value === "boolean") {
      parts.push(`${JSON.stringify(key)}:${value ? "true" : "false"}`);
    } else {
      throw rendererError(
        "E_CONTRACT",
        `shader define ${key} must be boolean or number`,
        { label: "shader-defines" },
      );
    }
  }
  return `{${parts.join(",")}}`;
}

/** Shader cache key: full tuple. Equality is the tuple. */
export function shaderModuleKey(parts: ShaderModuleKeyParts): ShaderModuleKey {
  const canonical = JSON.stringify([
    parts.language,
    parts.stage,
    parts.entryPoint,
    parts.abiVersion,
    parts.definesCanonical,
    parts.code,
  ]);
  if (utf8Length(canonical) > MAX_SHADER_MODULE_KEY_BYTES) {
    throw rendererError(
      "E_CONTRACT",
      "shader module key exceeds the shader source limit",
      { label: "shader-key" },
    );
  }
  return canonical;
}

/** Builds the canonical ABI 1 pipeline key in the frozen field order. */
export function canonicalPipelineKey(
  inputs: PipelineKeyInputs,
): PipelineCacheKey {
  const canonical = JSON.stringify([
    PIPELINE_CACHE_VERSION,
    inputs.vertexShaderKey,
    inputs.fragmentShaderKey,
    inputs.vertexLayout,
    inputs.primitiveState.topology,
    inputs.primitiveState.cullMode,
    inputs.primitiveState.frontFace,
    inputs.depthState.format,
    inputs.depthState.compare,
    inputs.depthState.writeEnabled,
    inputs.multisample,
    inputs.colorFormats,
    inputs.blendStates,
    inputs.layoutId,
    inputs.definesCanonical,
  ]);
  if (utf8Length(canonical) > MAX_PIPELINE_KEY_BYTES) {
    throw rendererError("E_CONTRACT", "pipeline cache key exceeds 4 KiB", {
      label: "pipeline-key",
    });
  }
  return {
    canonical,
    hash: fnv1a32(canonical),
  };
}

/** Equality relation used by conformance; never compares hashes. */
export function pipelineKeysEqual(
  left: PipelineCacheKey,
  right: PipelineCacheKey,
): boolean {
  return left.canonical === right.canonical;
}

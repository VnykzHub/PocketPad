/**
 * Pure WebGL2 tier and feature classification (05 §3.3, ER-05-05).
 *
 * Node-safe: this module reads no DOM and has no GL dependency. Detection is
 * feature-only; no browser name or user agent is consulted.
 */

import type { EngineFeature } from "@lanpad/engine-core";
import type { WebGL2Limits, WebGL2Tier } from "./contracts/webgl2.js";

/** Extension names this backend observes (05 §3.3). */
export const EXT = {
  floatColorBuffer: "EXT_color_buffer_float",
  floatLinear: "OES_texture_float_linear",
  timerQuery: "EXT_disjoint_timer_query_webgl2",
  astc: "WEBGL_compressed_texture_astc",
  etc: "WEBGL_compressed_texture_etc",
  s3tc: "WEBGL_compressed_texture_s3tc",
  bptc: "EXT_texture_compression_bptc",
  anisotropy: "EXT_texture_filter_anisotropic",
  parallelCompile: "KHR_parallel_shader_compile",
  loseContext: "WEBGL_lose_context",
  debugRenderer: "WEBGL_debug_renderer_info",
} as const;

/** Compressed families that satisfy the `extended` tier condition. */
export const COMPRESSED_FAMILY_EXTENSIONS: readonly string[] = [
  EXT.astc,
  EXT.etc,
  EXT.s3tc,
  EXT.bptc,
];

export interface WebGL2Classification {
  readonly tier: WebGL2Tier;
  readonly features: ReadonlySet<EngineFeature>;
}

/**
 * Deterministic and monotone (05 §3.3): adding an extension or raising a
 * limit can never lower the tier. Feature presence is independent of tier.
 */
export function classifyWebGL2(input: {
  readonly limits: WebGL2Limits;
  readonly extensions: readonly string[];
}): WebGL2Classification {
  const { limits } = input;
  const present = new Set(input.extensions);
  const features = new Set<EngineFeature>();

  // Core WebGL2 capability: 2D array textures are always available.
  features.add("texture-array");
  if (limits.maxSamples >= 4) features.add("msaa4");
  if (present.has(EXT.floatColorBuffer)) features.add("float-render-target");
  if (present.has(EXT.timerQuery)) features.add("timestamp-query");
  if (present.has(EXT.astc)) features.add("compressed-astc");
  if (present.has(EXT.etc)) features.add("compressed-etc2");
  if (present.has(EXT.s3tc)) features.add("compressed-s3tc");
  // `compute` and `storage-buffers` are never present on Tier B.

  const extended =
    present.has(EXT.floatColorBuffer) &&
    present.has(EXT.floatLinear) &&
    hasCompressedFamily(present) &&
    limits.maxTextureSize >= 8192 &&
    limits.maxSamples >= 4;

  const standard =
    limits.maxTextureSize >= 4096 && limits.maxVertexTextureImageUnits >= 16;

  const tier: WebGL2Tier = extended ? "extended" : standard ? "standard" : "minimal";
  return { tier, features };
}

function hasCompressedFamily(present: ReadonlySet<string>): boolean {
  for (let index = 0; index < COMPRESSED_FAMILY_EXTENSIONS.length; index += 1) {
    const name = COMPRESSED_FAMILY_EXTENSIONS[index];
    if (name !== undefined && present.has(name)) return true;
  }
  return false;
}

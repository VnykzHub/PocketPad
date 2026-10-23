/**
 * Browser probe and capability report (05 §3.3, §4.1). Node-safe when the
 * caller supplies a fake context; no branching on user agent.
 */

import type {
  EngineFeature,
  RendererCapabilities,
  RendererQualityTier,
  TextureFormat,
} from "@lanpad/engine-core";
import type {
  WebGL2Capabilities,
  WebGL2Probe,
} from "./contracts/webgl2.js";
import { classifyWebGL2, EXT } from "./classify.js";
import { readLimits, resolveContextAttributes } from "./limits.js";
import { WEBGL2_DESIGN_CAPS } from "./version.js";
import { supportedTextureFormats } from "./texture.js";

export interface ProbeData {
  readonly limits: ReturnType<typeof readLimits>;
  readonly extensions: readonly string[];
  readonly extensionObjects: Readonly<Record<string, unknown>>;
}

function safeString(gl: WebGL2RenderingContext, name: number): string {
  const value: unknown = gl.getParameter(name);
  return typeof value === "string" ? value : "";
}

function numberFromExtension(source: unknown, name: string): number {
  if (typeof source !== "object" || source === null) return 0;
  const value = (source as Record<string, unknown>)[name];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Reads limits, extensions and their objects once (05 §3.3). */
export function readProbeData(gl: WebGL2RenderingContext): ProbeData {
  const supported = gl.getSupportedExtensions() ?? [];
  const extensionObjects: Record<string, unknown> = {};
  for (let index = 0; index < supported.length; index += 1) {
    const name = supported[index];
    if (name === undefined) continue;
    const object = gl.getExtension(name);
    if (object !== null) extensionObjects[name] = object;
  }
  const anisotropyObject = extensionObjects[EXT.anisotropy];
  const maxAnisotropy =
    anisotropyObject === undefined
      ? 0
      : numberFromExtension(anisotropyObject, "MAX_TEXTURE_MAX_ANISOTROPY_EXT");
  return Object.freeze({
    limits: readLimits(gl, maxAnisotropy),
    extensions: Object.freeze([...supported]),
    extensionObjects: Object.freeze(extensionObjects),
  });
}

export function qualityForTier(tier: WebGL2Capabilities["tier"]): RendererQualityTier {
  if (tier === "extended") return "high";
  if (tier === "standard") return "medium";
  return "low";
}

export interface CapabilityInput {
  readonly gl: WebGL2RenderingContext;
  readonly data: ProbeData;
  readonly quality: RendererQualityTier;
  readonly shadowCascades: 0 | 2 | 3;
}

/** Builds the frozen core capability record plus the WebGL2 profile. */
export function buildCapabilities(input: CapabilityInput): WebGL2Capabilities {
  const { data } = input;
  const classification = classifyWebGL2({
    limits: data.limits,
    extensions: data.extensions,
  });
  const formats: ReadonlySet<TextureFormat> = supportedTextureFormats(
    new Set(data.extensions),
  );
  const features: ReadonlySet<EngineFeature> = classification.features;
  const maxSamples: 1 | 4 = data.limits.maxSamples >= 4 ? 4 : 1;

  const core: RendererCapabilities = {
    backend: "webgl2",
    features,
    supportedFormats: formats,
    quality: input.quality,
    maxTextureSize: data.limits.maxTextureSize,
    maxTextureLayers: data.limits.maxArrayTextureLayers,
    maxBindGroups: 4,
    maxUniformBufferBytes: data.limits.maxUniformBlockSize,
    maxSamples,
    anisotropy: data.limits.maxAnisotropy,
    directionalLights: WEBGL2_DESIGN_CAPS.maxDirectionalLights,
    pointLights: WEBGL2_DESIGN_CAPS.maxPointLights,
    // M0 implements no shadow pass; the capability never advertises one.
    shadowCascades: input.shadowCascades,
    supportsPost: false,
    supportsTimestamps: features.has("timestamp-query"),
  };

  return Object.freeze({
    ...core,
    available: true as const,
    vendor: safeString(input.gl, input.gl.VENDOR),
    renderer: safeString(input.gl, input.gl.RENDERER),
    glVersion: safeString(input.gl, input.gl.VERSION),
    shadingLanguageVersion: safeString(input.gl, input.gl.SHADING_LANGUAGE_VERSION),
    tier: classification.tier,
    extensions: data.extensions,
    limits: data.limits,
    ...WEBGL2_DESIGN_CAPS,
  });
}

/**
 * Probes a disposable canvas or factory (05 §3.2). Never throws; a missing,
 * throwing or lost context is data.
 */
export function probeWebGL2(
  canvas: HTMLCanvasElement | (() => HTMLCanvasElement | null),
): WebGL2Probe {
  let element: HTMLCanvasElement | null;
  try {
    element = typeof canvas === "function" ? canvas() : canvas;
  } catch {
    return { available: false, reason: "context-threw" };
  }
  if (element === null) return { available: false, reason: "no-context" };

  let gl: WebGL2RenderingContext | null;
  try {
    gl = element.getContext(
      "webgl2",
      resolveContextAttributes({ tvProfile: false }),
    ) as WebGL2RenderingContext | null;
  } catch {
    return { available: false, reason: "context-threw" };
  }
  if (gl === null) return { available: false, reason: "no-context" };
  if (gl.isContextLost()) return { available: false, reason: "blocked" };

  const data = readProbeData(gl);
  const classification = classifyWebGL2({
    limits: data.limits,
    extensions: data.extensions,
  });
  const capabilities = buildCapabilities({
    gl,
    data,
    quality: qualityForTier(classification.tier),
    shadowCascades: 0,
  });
  return { available: true, capabilities };
}

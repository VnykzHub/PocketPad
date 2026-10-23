/**
 * Device option normalization and capability classification (04 §3.2, §5.2).
 *
 * M0 reports only what this backend implements: one directional light, no
 * point lights, no shadow cascades, no post pass, no MSAA, no timestamps and
 * no compute/storage. Adapter support alone is not enough to claim a feature.
 */

import type {
  DeviceLimits,
  EngineFeature,
  RenderDeviceOptions,
  RendererQualityTier,
} from "@lanpad/engine-core";
import type {
  WebGpuCanvasFormat,
  WebGpuCapabilities,
  WebGpuDeviceOptions,
  WebGpuPowerPreference,
} from "../contracts/webgpu.js";
import { rendererError } from "../errors.js";
import { supportedFormatsFor } from "../texture/formats.js";

export interface NormalizedDeviceOptions {
  readonly quality: RendererQualityTier;
  readonly maxRenderHeight: number;
  readonly maxTextureBytes: number;
  readonly shadowCascades: 0 | 2 | 3;
  readonly post: boolean;
  readonly anisotropy: number;
  readonly retainCpuCopies: boolean;
  readonly powerPreference: WebGpuPowerPreference;
}

const MIB = 1024 * 1024;

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function normalizeOptions(
  base?: WebGpuDeviceOptions,
  override?: RenderDeviceOptions,
): NormalizedDeviceOptions {
  const quality = override?.quality ?? base?.quality ?? "high";
  const maxRenderHeight = clampInt(
    finiteOr(override?.maxRenderHeight ?? base?.maxRenderHeight, 0),
    0,
    16_384,
  );
  const maxTextureBytes = Math.floor(
    finiteOr(override?.maxTextureBytes ?? base?.maxTextureBytes, 128 * MIB),
  );
  if (maxTextureBytes <= 0) {
    throw rendererError(
      "E_CONTRACT",
      "maxTextureBytes must be a positive finite number",
      { label: "options", recoverable: false },
    );
  }
  const shadowCascades = override?.shadowCascades ?? base?.shadowCascades ?? 0;
  const post = override?.post ?? base?.post ?? false;
  const anisotropy = clampInt(
    finiteOr(override?.anisotropy ?? base?.anisotropy, 4),
    1,
    16,
  );
  const retainCpuCopies =
    override?.retainCpuCopies ?? base?.retainCpuCopies ?? true;
  const powerPreference = base?.powerPreference ?? "high-performance";
  return {
    quality,
    maxRenderHeight,
    maxTextureBytes,
    shadowCascades,
    post,
    anisotropy,
    retainCpuCopies,
    powerPreference,
  };
}

export function isWebGpuCanvasFormat(
  value: unknown,
): value is WebGpuCanvasFormat {
  return value === "bgra8unorm" || value === "rgba8unorm";
}

export function preferredCanvasFormat(gpu: GPU): WebGpuCanvasFormat {
  const format = gpu.getPreferredCanvasFormat();
  if (!isWebGpuCanvasFormat(format)) {
    throw rendererError(
      "E_BACKEND_INIT",
      `unsupported preferred canvas format: ${String(format)}`,
      { label: "swapchain", recoverable: false },
    );
  }
  return format;
}

const COMPRESSION_FEATURES: readonly GPUFeatureName[] = [
  "texture-compression-bc",
  "texture-compression-etc2",
  "texture-compression-astc",
];

/** Features this backend requests and actually implements in M0. */
export function requestedWebGpuFeatures(adapter: GPUAdapter): GPUFeatureName[] {
  const requested: GPUFeatureName[] = [];
  for (const feature of COMPRESSION_FEATURES) {
    if (adapter.features.has(feature)) {
      requested.push(feature);
    }
  }
  return requested;
}

/**
 * Reads `maxSamplerAnisotropy` defensively. The installed TypeScript DOM
 * library predates the limit even though browsers expose it; a missing value
 * falls back to the WebGPU default of 1 rather than claiming 16.
 */
export function samplerAnisotropyLimit(limits: GPUSupportedLimits): number {
  const value = (
    limits as GPUSupportedLimits & { readonly maxSamplerAnisotropy?: unknown }
  ).maxSamplerAnisotropy;
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : 1;
}

export function capabilitiesFromAdapter(
  adapter: GPUAdapter,
  options: NormalizedDeviceOptions,
  requestedFeatures: readonly GPUFeatureName[],
  requestedLimits?: DeviceLimits,
): WebGpuCapabilities {
  const requestedSet = new Set<GPUFeatureName>(requestedFeatures);
  const features = new Set<EngineFeature>();
  features.add("texture-array");
  for (const feature of requestedFeatures) {
    if (feature === "texture-compression-bc") {
      features.add("compressed-s3tc");
    } else if (feature === "texture-compression-etc2") {
      features.add("compressed-etc2");
    } else if (feature === "texture-compression-astc") {
      features.add("compressed-astc");
    }
  }
  const limits = requestedLimits ?? deviceLimits(adapter.limits);
  const anisotropy = clampInt(
    Math.min(
      options.anisotropy,
      samplerAnisotropyLimit(adapter.limits),
      limits.maxSamplerAnisotropy,
    ),
    1,
    16,
  );
  return {
    backend: "webgpu",
    features,
    supportedFormats: new Set(supportedFormatsFor(requestedSet)),
    quality: options.quality,
    maxTextureSize: limits.maxTextureDimension2D,
    maxTextureLayers: limits.maxTextureArrayLayers,
    maxBindGroups: limits.maxBindGroups,
    maxUniformBufferBytes: limits.maxUniformBufferBindingSize,
    maxSamples: 1,
    anisotropy,
    directionalLights: 1,
    pointLights: 0,
    shadowCascades: 0,
    supportsPost: false,
    supportsTimestamps: false,
  };
}

export function deviceLimits(limits: GPUSupportedLimits): DeviceLimits {
  return {
    maxTextureDimension2D: limits.maxTextureDimension2D,
    maxTextureArrayLayers: limits.maxTextureArrayLayers,
    maxBindGroups: limits.maxBindGroups,
    maxUniformBufferBindingSize: limits.maxUniformBufferBindingSize,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxBufferSize: limits.maxBufferSize,
    maxVertexBuffers: limits.maxVertexBuffers,
    maxColorAttachments: limits.maxColorAttachments,
    maxSamplerAnisotropy: samplerAnisotropyLimit(limits),
    minUniformBufferOffsetAlignment: limits.minUniformBufferOffsetAlignment,
    maxComputeWorkgroupSizeX: limits.maxComputeWorkgroupSizeX,
  };
}

export interface AdapterInfoLike {
  readonly vendor?: string;
  readonly architecture?: string;
  readonly device?: string;
  readonly description?: string;
}

/** Display-only, sanitized, at most 120 characters. */
export function sanitizeAdapterInfo(
  info: AdapterInfoLike | null | undefined,
): string {
  if (info === null || info === undefined) {
    return "WebGPU adapter";
  }
  const joined = [info.description, info.vendor, info.architecture, info.device]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(" ");
  const clean = joined
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\b(?:token|pin|room|session|secret|key)=[^\s&]+/gi, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 0 ? clean.slice(0, 120) : "WebGPU adapter";
}

export function adapterInfoOf(adapter: GPUAdapter): string {
  const withInfo = adapter as GPUAdapter & {
    readonly info?: AdapterInfoLike;
  };
  return sanitizeAdapterInfo(withInfo.info);
}

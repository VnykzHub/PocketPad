/**
 * ABI 1 texture-format classification and gating (04 §4.5, §5.8).
 *
 * A format is usable only when the backend has obtained the WebGPU adapter
 * feature that exposes it. Unsupported formats fail with
 * `E_UNSUPPORTED_FEATURE`; they are never silently replaced by a different
 * format.
 */

import type { EngineFeature, TextureFormat } from "@lanpad/engine-core";
import { rendererError } from "../errors.js";

export interface FormatClassification {
  readonly token: TextureFormat;
  readonly webgpuFormat: GPUTextureFormat;
  readonly kind: "color" | "depth" | "depth-stencil" | "compressed";
  readonly engineFeature: EngineFeature | null;
  readonly webgpuFeature: GPUFeatureName | null;
  /** Bytes per pixel for uncompressed formats; 0 for compressed. */
  readonly bytesPerPixel: number;
  /** Block dimensions and bytes for compressed formats; 0 otherwise. */
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly bytesPerBlock: number;
}

const FORMAT_TABLE: Readonly<Record<TextureFormat, FormatClassification>> = {
  rgba8unorm: {
    token: "rgba8unorm",
    webgpuFormat: "rgba8unorm",
    kind: "color",
    engineFeature: null,
    webgpuFeature: null,
    bytesPerPixel: 4,
    blockWidth: 0,
    blockHeight: 0,
    bytesPerBlock: 0,
  },
  "rgba8unorm-srgb": {
    token: "rgba8unorm-srgb",
    webgpuFormat: "rgba8unorm-srgb",
    kind: "color",
    engineFeature: null,
    webgpuFeature: null,
    bytesPerPixel: 4,
    blockWidth: 0,
    blockHeight: 0,
    bytesPerBlock: 0,
  },
  bgra8unorm: {
    token: "bgra8unorm",
    webgpuFormat: "bgra8unorm",
    kind: "color",
    engineFeature: null,
    webgpuFeature: null,
    bytesPerPixel: 4,
    blockWidth: 0,
    blockHeight: 0,
    bytesPerBlock: 0,
  },
  rgba16float: {
    token: "rgba16float",
    webgpuFormat: "rgba16float",
    kind: "color",
    engineFeature: null,
    webgpuFeature: null,
    bytesPerPixel: 8,
    blockWidth: 0,
    blockHeight: 0,
    bytesPerBlock: 0,
  },
  rgba32float: {
    token: "rgba32float",
    webgpuFormat: "rgba32float",
    kind: "color",
    engineFeature: "float-render-target",
    webgpuFeature: null,
    bytesPerPixel: 16,
    blockWidth: 0,
    blockHeight: 0,
    bytesPerBlock: 0,
  },
  r8unorm: {
    token: "r8unorm",
    webgpuFormat: "r8unorm",
    kind: "color",
    engineFeature: null,
    webgpuFeature: null,
    bytesPerPixel: 1,
    blockWidth: 0,
    blockHeight: 0,
    bytesPerBlock: 0,
  },
  rgb10a2unorm: {
    token: "rgb10a2unorm",
    webgpuFormat: "rgb10a2unorm",
    kind: "color",
    engineFeature: null,
    webgpuFeature: null,
    bytesPerPixel: 4,
    blockWidth: 0,
    blockHeight: 0,
    bytesPerBlock: 0,
  },
  depth24plus: {
    token: "depth24plus",
    webgpuFormat: "depth24plus",
    kind: "depth",
    engineFeature: null,
    webgpuFeature: null,
    bytesPerPixel: 4,
    blockWidth: 0,
    blockHeight: 0,
    bytesPerBlock: 0,
  },
  depth32float: {
    token: "depth32float",
    webgpuFormat: "depth32float",
    kind: "depth",
    engineFeature: null,
    webgpuFeature: null,
    bytesPerPixel: 4,
    blockWidth: 0,
    blockHeight: 0,
    bytesPerBlock: 0,
  },
  "depth24plus-stencil8": {
    token: "depth24plus-stencil8",
    webgpuFormat: "depth24plus-stencil8",
    kind: "depth-stencil",
    engineFeature: null,
    webgpuFeature: null,
    bytesPerPixel: 4,
    blockWidth: 0,
    blockHeight: 0,
    bytesPerBlock: 0,
  },
  "s3tc-dxt1": {
    token: "s3tc-dxt1",
    webgpuFormat: "bc1-rgba-unorm",
    kind: "compressed",
    engineFeature: "compressed-s3tc",
    webgpuFeature: "texture-compression-bc",
    bytesPerPixel: 0,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlock: 8,
  },
  "s3tc-dxt3": {
    token: "s3tc-dxt3",
    webgpuFormat: "bc2-rgba-unorm",
    kind: "compressed",
    engineFeature: "compressed-s3tc",
    webgpuFeature: "texture-compression-bc",
    bytesPerPixel: 0,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlock: 16,
  },
  "s3tc-dxt5": {
    token: "s3tc-dxt5",
    webgpuFormat: "bc3-rgba-unorm",
    kind: "compressed",
    engineFeature: "compressed-s3tc",
    webgpuFeature: "texture-compression-bc",
    bytesPerPixel: 0,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlock: 16,
  },
  "etc2-rgb8": {
    token: "etc2-rgb8",
    webgpuFormat: "etc2-rgb8unorm",
    kind: "compressed",
    engineFeature: "compressed-etc2",
    webgpuFeature: "texture-compression-etc2",
    bytesPerPixel: 0,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlock: 8,
  },
  "etc2-rgba8": {
    token: "etc2-rgba8",
    webgpuFormat: "etc2-rgba8unorm",
    kind: "compressed",
    engineFeature: "compressed-etc2",
    webgpuFeature: "texture-compression-etc2",
    bytesPerPixel: 0,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlock: 16,
  },
  "astc-4x4": {
    token: "astc-4x4",
    webgpuFormat: "astc-4x4-unorm",
    kind: "compressed",
    engineFeature: "compressed-astc",
    webgpuFeature: "texture-compression-astc",
    bytesPerPixel: 0,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlock: 16,
  },
  "astc-6x6": {
    token: "astc-6x6",
    webgpuFormat: "astc-6x6-unorm",
    kind: "compressed",
    engineFeature: "compressed-astc",
    webgpuFeature: "texture-compression-astc",
    bytesPerPixel: 0,
    blockWidth: 6,
    blockHeight: 6,
    bytesPerBlock: 16,
  },
  "astc-8x8": {
    token: "astc-8x8",
    webgpuFormat: "astc-8x8-unorm",
    kind: "compressed",
    engineFeature: "compressed-astc",
    webgpuFeature: "texture-compression-astc",
    bytesPerPixel: 0,
    blockWidth: 8,
    blockHeight: 8,
    bytesPerBlock: 16,
  },
  "bptc-rgba": {
    token: "bptc-rgba",
    webgpuFormat: "bc7-rgba-unorm",
    kind: "compressed",
    engineFeature: null,
    webgpuFeature: "texture-compression-bc",
    bytesPerPixel: 0,
    blockWidth: 4,
    blockHeight: 4,
    bytesPerBlock: 16,
  },
};

/** Runtime guard for descriptor strings arriving from JavaScript callers. */
export function isTextureFormat(value: unknown): value is TextureFormat {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(FORMAT_TABLE, value)
  );
}

export function classifyFormat(format: TextureFormat): FormatClassification {
  return FORMAT_TABLE[format];
}

export interface AdapterFeatureSet {
  has(feature: GPUFeatureName): boolean;
}

export function supportsFormat(
  format: TextureFormat,
  features: AdapterFeatureSet,
): boolean {
  const info = classifyFormat(format);
  return info.webgpuFeature === null || features.has(info.webgpuFeature);
}

export function supportedFormatsFor(
  features: AdapterFeatureSet,
): TextureFormat[] {
  const out: TextureFormat[] = [];
  for (const token of Object.keys(FORMAT_TABLE) as TextureFormat[]) {
    if (supportsFormat(token, features)) {
      out.push(token);
    }
  }
  return out;
}

export function assertFormatSupported(
  format: TextureFormat,
  features: AdapterFeatureSet,
  label = "texture",
): void {
  if (!supportsFormat(format, features)) {
    const info = classifyFormat(format);
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      `${label} format ${format} requires adapter feature ${info.webgpuFeature ?? "unknown"}`,
      { label, recoverable: false },
    );
  }
}

export function isDepthFormat(format: TextureFormat): boolean {
  const kind = classifyFormat(format).kind;
  return kind === "depth" || kind === "depth-stencil";
}

export function isCompressedFormat(format: TextureFormat): boolean {
  return classifyFormat(format).kind === "compressed";
}

export function engineFeatureForFormat(
  format: TextureFormat,
): EngineFeature | null {
  return classifyFormat(format).engineFeature;
}

/** Aligns a byte count to 256 as required by texture upload accounting. */
export function align256(value: number): number {
  return (value + 255) & ~255;
}

/** Bytes for one mip level, including 256-byte row alignment accounting. */
export function mipByteSize(
  format: TextureFormat,
  width: number,
  height: number,
  depthOrArrayLayers = 1,
): number {
  const info = classifyFormat(format);
  if (info.kind === "compressed") {
    const blocksWide = Math.max(1, Math.ceil(width / info.blockWidth));
    const blocksHigh = Math.max(1, Math.ceil(height / info.blockHeight));
    return (
      align256(blocksWide * info.bytesPerBlock) *
      blocksHigh *
      depthOrArrayLayers
    );
  }
  const rowBytes = width * info.bytesPerPixel;
  return align256(rowBytes) * height * depthOrArrayLayers;
}

/** Total texture bytes for all mip levels. */
export function textureMemoryBytes(
  format: TextureFormat,
  width: number,
  height: number,
  depthOrArrayLayers = 1,
  mipLevels = 1,
): number {
  let total = 0;
  for (let level = 0; level < mipLevels; level += 1) {
    total += mipByteSize(
      format,
      Math.max(1, width >> level),
      Math.max(1, height >> level),
      depthOrArrayLayers,
    );
  }
  return total;
}

/** Tight row bytes for a single mip level, before upload alignment. */
export function tightRowBytes(format: TextureFormat, width: number): number {
  const info = classifyFormat(format);
  if (info.kind === "compressed") {
    return Math.max(1, Math.ceil(width / info.blockWidth)) * info.bytesPerBlock;
  }
  return width * info.bytesPerPixel;
}

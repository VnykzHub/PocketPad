/**
 * Tier B texture-format vocabulary (05 §4.4).
 *
 * `WEBGL2_TEXTURE_FORMAT_MAP` is the exact mapping data checked in as
 * `test/fixtures/texture-format-map.json`. The key type is the canonical core
 * `TextureFormat` union, so a missing or invented token is a type error.
 */

import type {
  SamplerDesc,
  TextureDesc,
  TextureFormat,
  TextureLevel,
  TextureUsage,
} from "@lanpad/engine-core";
import type {
  WebGL2TextureFormatEntry,
  WebGL2TextureFormatMap,
} from "./contracts/webgl2.js";
import { EXT } from "./classify.js";
import { rendererError } from "./errors.js";
import type { StateCache } from "./state.js";

/** Every canonical token owned by 04 §4.5, in map order. */
export const TEXTURE_FORMATS: readonly TextureFormat[] = [
  "rgba8unorm",
  "rgba8unorm-srgb",
  "bgra8unorm",
  "rgba16float",
  "rgba32float",
  "r8unorm",
  "rgb10a2unorm",
  "depth24plus",
  "depth32float",
  "depth24plus-stencil8",
  "s3tc-dxt1",
  "s3tc-dxt3",
  "s3tc-dxt5",
  "etc2-rgb8",
  "etc2-rgba8",
  "astc-4x4",
  "astc-6x6",
  "astc-8x8",
  "bptc-rgba",
];

const entry = (
  status: WebGL2TextureFormatEntry["status"],
  internalFormat: string | null,
  extension: string | null,
  renderTargetExtension: WebGL2TextureFormatEntry["renderTargetExtension"],
  notes: string,
): WebGL2TextureFormatEntry =>
  Object.freeze({ status, internalFormat, extension, renderTargetExtension, notes });

/** The exact Tier B format table (05 §4.4). */
export const WEBGL2_TEXTURE_FORMAT_MAP: WebGL2TextureFormatMap = Object.freeze({
  rgba8unorm: entry("core", "RGBA8", null, null, "Default uncompressed colour format."),
  "rgba8unorm-srgb": entry("core", "SRGB8_ALPHA8", null, null, "sRGB sampling."),
  bgra8unorm: entry(
    "unsupported",
    null,
    null,
    null,
    "WebGPU swapchain format; the Tier B probe removes this token.",
  ),
  rgba16float: entry(
    "core",
    "RGBA16F",
    null,
    "EXT_color_buffer_float",
    "HDR post. Sampling is core; render-target use requires EXT_color_buffer_float.",
  ),
  rgba32float: entry(
    "core",
    "RGBA32F",
    null,
    "EXT_color_buffer_float",
    "Data and skinning targets. Sampling is core; render-target use requires EXT_color_buffer_float.",
  ),
  r8unorm: entry("core", "R8", null, null, "Masks."),
  rgb10a2unorm: entry("core", "RGB10_A2", null, null, "HDR-ish LDR targets."),
  depth24plus: entry("core", "DEPTH_COMPONENT24", null, null, "Depth attachment."),
  depth32float: entry("core", "DEPTH_COMPONENT32F", null, null, "Optional depth format."),
  "depth24plus-stencil8": entry(
    "core",
    "DEPTH24_STENCIL8",
    null,
    null,
    "Stencil path.",
  ),
  "s3tc-dxt1": entry(
    "extension",
    "COMPRESSED_RGB_S3TC_DXT1_EXT",
    "WEBGL_compressed_texture_s3tc",
    null,
    "Compressed; complete mip chain required.",
  ),
  "s3tc-dxt3": entry(
    "extension",
    "COMPRESSED_RGBA_S3TC_DXT3_EXT",
    "WEBGL_compressed_texture_s3tc",
    null,
    "Compressed; complete mip chain required.",
  ),
  "s3tc-dxt5": entry(
    "extension",
    "COMPRESSED_RGBA_S3TC_DXT5_EXT",
    "WEBGL_compressed_texture_s3tc",
    null,
    "Compressed; complete mip chain required.",
  ),
  "etc2-rgb8": entry(
    "extension",
    "COMPRESSED_RGB8_ETC2",
    "WEBGL_compressed_texture_etc",
    null,
    "Compressed; complete mip chain required.",
  ),
  "etc2-rgba8": entry(
    "extension",
    "COMPRESSED_RGBA8_ETC2_EAC",
    "WEBGL_compressed_texture_etc",
    null,
    "Compressed; complete mip chain required.",
  ),
  "astc-4x4": entry(
    "extension",
    "COMPRESSED_RGBA_ASTC_4x4_KHR",
    "WEBGL_compressed_texture_astc",
    null,
    "Compressed; complete mip chain required.",
  ),
  "astc-6x6": entry(
    "extension",
    "COMPRESSED_RGBA_ASTC_6x6_KHR",
    "WEBGL_compressed_texture_astc",
    null,
    "TV default where present; complete mip chain required.",
  ),
  "astc-8x8": entry(
    "extension",
    "COMPRESSED_RGBA_ASTC_8x8_KHR",
    "WEBGL_compressed_texture_astc",
    null,
    "Compressed; complete mip chain required.",
  ),
  "bptc-rgba": entry(
    "extension",
    "COMPRESSED_RGBA_BPTC_UNORM_EXT",
    "EXT_texture_compression_bptc",
    null,
    "Desktop; complete mip chain required.",
  ),
});

export function textureFormatEntry(format: TextureFormat): WebGL2TextureFormatEntry {
  return WEBGL2_TEXTURE_FORMAT_MAP[format];
}

export function isTextureFormatToken(value: string): value is TextureFormat {
  return Object.prototype.hasOwnProperty.call(WEBGL2_TEXTURE_FORMAT_MAP, value);
}

/** The formats this adapter accepts for sampling, filtered by extensions. */
export function supportedTextureFormats(
  extensions: ReadonlySet<string>,
): ReadonlySet<TextureFormat> {
  const supported = new Set<TextureFormat>();
  for (let index = 0; index < TEXTURE_FORMATS.length; index += 1) {
    const format = TEXTURE_FORMATS[index];
    if (format === undefined) continue;
    const row = WEBGL2_TEXTURE_FORMAT_MAP[format];
    if (row.status === "unsupported") continue;
    if (row.extension !== null && !extensions.has(row.extension)) continue;
    supported.add(format);
  }
  return supported;
}

export function isCompressedFormat(format: TextureFormat): boolean {
  return WEBGL2_TEXTURE_FORMAT_MAP[format].status === "extension";
}

export function isDepthFormat(format: TextureFormat): boolean {
  return (
    format === "depth24plus" ||
    format === "depth32float" ||
    format === "depth24plus-stencil8"
  );
}

export function isFloatFormat(format: TextureFormat): boolean {
  return format === "rgba16float" || format === "rgba32float";
}

/**
 * Rejects a token the device cannot accept for the requested usage. An
 * unsupported token fails; it is never silently downcast (04 §3).
 */
export function assertTextureFormatSupported(
  format: TextureFormat,
  usage: readonly TextureUsage[],
  extensions: ReadonlySet<string>,
): void {
  const row = WEBGL2_TEXTURE_FORMAT_MAP[format];
  if (row.status === "unsupported") {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      `Texture format ${format} is not supported on the WebGL2 backend.`,
    );
  }
  if (row.extension !== null && !extensions.has(row.extension)) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      `Texture format ${format} requires ${row.extension}, which this device does not expose.`,
    );
  }
  if (
    row.renderTargetExtension !== null &&
    usage.includes("render-attachment") &&
    !extensions.has(row.renderTargetExtension)
  ) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      `Texture format ${format} needs ${row.renderTargetExtension} for render targets.`,
    );
  }
}

/** Resolves a fixture internalformat token to the numeric GL constant. */
export function readGlConstant(source: unknown, name: string): number {
  if (typeof source !== "object" || source === null) {
    throw rendererError("E_BACKEND_INIT", `GL constant source for ${name} is missing.`);
  }
  const value = (source as Record<string, unknown>)[name];
  if (typeof value !== "number") {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      `GL constant ${name} is not available on this device.`,
    );
  }
  return value;
}

/**
 * Numeric internalformat for a token. Compressed extension formats read the
 * constant from their extension object; core formats read it from the context.
 */
export function resolveInternalFormat(
  gl: WebGL2RenderingContext,
  format: TextureFormat,
  extensionObjects: Readonly<Record<string, unknown>>,
): number {
  const row = WEBGL2_TEXTURE_FORMAT_MAP[format];
  if (row.internalFormat === null) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      `Texture format ${format} has no WebGL2 internal format.`,
    );
  }
  if (row.status === "extension") {
    const extensionName = row.extension;
    const source =
      extensionName === null ? undefined : extensionObjects[extensionName];
    if (source === undefined) {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        `Texture format ${format} requires ${extensionName ?? "an extension"}, which this device does not expose.`,
      );
    }
    return readGlConstant(source, row.internalFormat);
  }
  return readGlConstant(gl, row.internalFormat);
}

export interface TextureLayout {
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly blockBytes: number;
}

const LAYOUTS: Readonly<Record<TextureFormat, TextureLayout>> = {
  rgba8unorm: { blockWidth: 1, blockHeight: 1, blockBytes: 4 },
  "rgba8unorm-srgb": { blockWidth: 1, blockHeight: 1, blockBytes: 4 },
  bgra8unorm: { blockWidth: 1, blockHeight: 1, blockBytes: 4 },
  rgba16float: { blockWidth: 1, blockHeight: 1, blockBytes: 8 },
  rgba32float: { blockWidth: 1, blockHeight: 1, blockBytes: 16 },
  r8unorm: { blockWidth: 1, blockHeight: 1, blockBytes: 1 },
  rgb10a2unorm: { blockWidth: 1, blockHeight: 1, blockBytes: 4 },
  depth24plus: { blockWidth: 1, blockHeight: 1, blockBytes: 4 },
  depth32float: { blockWidth: 1, blockHeight: 1, blockBytes: 4 },
  "depth24plus-stencil8": { blockWidth: 1, blockHeight: 1, blockBytes: 4 },
  "s3tc-dxt1": { blockWidth: 4, blockHeight: 4, blockBytes: 8 },
  "s3tc-dxt3": { blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  "s3tc-dxt5": { blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  "etc2-rgb8": { blockWidth: 4, blockHeight: 4, blockBytes: 8 },
  "etc2-rgba8": { blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  "astc-4x4": { blockWidth: 4, blockHeight: 4, blockBytes: 16 },
  "astc-6x6": { blockWidth: 6, blockHeight: 6, blockBytes: 16 },
  "astc-8x8": { blockWidth: 8, blockHeight: 8, blockBytes: 16 },
  "bptc-rgba": { blockWidth: 4, blockHeight: 4, blockBytes: 16 },
};

/** Estimated allocation for one level, used only for stats accounting. */
export function levelBytes(
  format: TextureFormat,
  width: number,
  height: number,
): number {
  const layout = LAYOUTS[format];
  const blocksWide = Math.max(1, Math.ceil(width / layout.blockWidth));
  const blocksHigh = Math.max(1, Math.ceil(height / layout.blockHeight));
  return blocksWide * blocksHigh * layout.blockBytes;
}

/** Estimated allocation for a full texture, rounded up to 256 bytes. */
export function estimateTextureBytes(
  format: TextureFormat,
  width: number,
  height: number,
  depthOrLayers = 1,
  mipLevels = 1,
): number {
  let total = 0;
  let levelWidth = Math.max(1, width);
  let levelHeight = Math.max(1, height);
  for (let level = 0; level < Math.max(1, mipLevels); level += 1) {
    total += levelBytes(format, levelWidth, levelHeight) * Math.max(1, depthOrLayers);
    levelWidth = Math.max(1, levelWidth >> 1);
    levelHeight = Math.max(1, levelHeight >> 1);
  }
  return Math.ceil(total / 256) * 256;
}

/** Extension names the probe must request to make the map usable. */
export const TEXTURE_EXTENSION_NAMES: readonly string[] = [
  EXT.s3tc,
  EXT.etc,
  EXT.astc,
  EXT.bptc,
  EXT.floatColorBuffer,
];

export interface TextureGpuRecord {
  readonly texture: WebGLTexture;
  readonly sampler: WebGLSampler;
  readonly format: TextureFormat;
  readonly width: number;
  readonly height: number;
  readonly mipLevels: number;
  readonly byteSize: number;
  readonly desc: TextureDesc;
}

interface UploadFormat {
  readonly format: number;
  readonly type: number;
  readonly bytesPerPixel: number;
}

function uploadFormat(gl: WebGL2RenderingContext, format: TextureFormat): UploadFormat {
  switch (format) {
    case "rgba8unorm":
    case "rgba8unorm-srgb":
      return { format: gl.RGBA, type: gl.UNSIGNED_BYTE, bytesPerPixel: 4 };
    case "r8unorm":
      return { format: gl.RED, type: gl.UNSIGNED_BYTE, bytesPerPixel: 1 };
    case "rgba16float":
      return { format: gl.RGBA, type: gl.HALF_FLOAT, bytesPerPixel: 8 };
    case "rgba32float":
      return { format: gl.RGBA, type: gl.FLOAT, bytesPerPixel: 16 };
    case "rgb10a2unorm":
      return {
        format: gl.RGBA,
        type: gl.UNSIGNED_INT_2_10_10_10_REV,
        bytesPerPixel: 4,
      };
    default:
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        `Texture format ${format} cannot be uploaded from CPU data in the M0 WebGL2 pass.`,
      );
  }
}

function addressMode(gl: WebGL2RenderingContext, mode: string): number {
  if (mode === "clamp-to-edge") return gl.CLAMP_TO_EDGE;
  if (mode === "repeat") return gl.REPEAT;
  if (mode === "mirror-repeat") return gl.MIRRORED_REPEAT;
  throw rendererError("E_CONTRACT", `Unknown sampler address mode "${mode}".`);
}

function filterMode(gl: WebGL2RenderingContext, mode: string): number {
  if (mode === "nearest") return gl.NEAREST;
  if (mode === "linear") return gl.LINEAR;
  throw rendererError("E_CONTRACT", `Unknown sampler filter "${mode}".`);
}

const DEFAULT_SAMPLER: SamplerDesc = {
  magFilter: "linear",
  minFilter: "linear",
  mipmapFilter: "linear",
  addressU: "clamp-to-edge",
  addressV: "clamp-to-edge",
};

/** Creates a GL sampler object; M0 has no shadow comparisons. */
export function createSamplerGpu(
  gl: WebGL2RenderingContext,
  desc: SamplerDesc | undefined,
  extensionObjects: Readonly<Record<string, unknown>>,
  maxAnisotropy: number,
): WebGLSampler {
  const source = desc ?? DEFAULT_SAMPLER;
  if (source.compare !== undefined) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Comparison samplers are shadow-map M2 surface; the M0 WebGL2 pass does not create them.",
    );
  }
  const sampler = gl.createSampler();
  if (sampler === null) {
    throw rendererError("E_BACKEND_INIT", "Could not allocate a sampler.");
  }
  gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filterMode(gl, source.magFilter));
  const mipmapped =
    source.minFilter === "nearest"
      ? source.mipmapFilter === "nearest"
        ? gl.NEAREST_MIPMAP_NEAREST
        : gl.NEAREST_MIPMAP_LINEAR
      : source.mipmapFilter === "nearest"
        ? gl.LINEAR_MIPMAP_NEAREST
        : gl.LINEAR_MIPMAP_LINEAR;
  gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, mipmapped);
  gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, addressMode(gl, source.addressU));
  gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, addressMode(gl, source.addressV));
  gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_R, addressMode(gl, source.addressW ?? "clamp-to-edge"));
  if (source.maxAnisotropy !== undefined && source.maxAnisotropy > 1) {
    if (maxAnisotropy < 1 || extensionObjects[EXT.anisotropy] === undefined) {
      throw rendererError(
        "E_CONTRACT",
        "Sampler requires anisotropic filtering but the device has no anisotropy limit.",
      );
    }
    const constant = readGlConstant(extensionObjects[EXT.anisotropy], "TEXTURE_MAX_ANISOTROPY_EXT");
    const value = Math.min(source.maxAnisotropy, maxAnisotropy);
    gl.samplerParameterf(sampler, constant, value);
  }
  return sampler;
}

function mipDimension(base: number, level: number): number {
  return Math.max(1, base >> level);
}

function validateLevels(
  gl: WebGL2RenderingContext,
  desc: TextureDesc,
  mipLevels: number,
  format: TextureFormat,
): readonly TextureLevel[] {
  const levels = desc.data;
  if (levels === undefined || levels.length === 0) {
    throw rendererError(
      "E_CONTRACT",
      "A sampled texture requires CPU data for every declared mip level.",
    );
  }
  if (levels.length !== mipLevels) {
    throw rendererError(
      "E_CONTRACT",
      `TextureDesc declares ${mipLevels} mip level(s) but supplies ${levels.length}.`,
    );
  }
  const seen = new Set<number>();
  const compressed = isCompressedFormat(format);
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    if (level === undefined) {
      throw rendererError("E_CONTRACT", "TextureLevel entry is missing.");
    }
    if (!Number.isInteger(level.mipLevel) || level.mipLevel < 0 || level.mipLevel >= mipLevels) {
      throw rendererError("E_CONTRACT", "TextureLevel.mipLevel is outside the declared range.");
    }
    if (level.layer !== 0) {
      throw rendererError("E_CONTRACT", "M0 textures are 2D; only layer 0 is accepted.");
    }
    if (seen.has(level.mipLevel)) {
      throw rendererError("E_CONTRACT", "Duplicate mip level supplied.");
    }
    seen.add(level.mipLevel);
    if (!ArrayBuffer.isView(level.bytes)) {
      throw rendererError("E_CONTRACT", "TextureLevel.bytes must be an ArrayBufferView.");
    }
    const width = mipDimension(desc.width, level.mipLevel);
    const height = mipDimension(desc.height, level.mipLevel);
    if (compressed) {
      const tight = levelBytes(format, width, height);
      if (level.bytes.byteLength !== tight) {
        throw rendererError(
          "E_CONTRACT",
          `Compressed level ${level.mipLevel} must be exactly ${tight} bytes.`,
        );
      }
      continue;
    }
    const upload = uploadFormat(gl, format);
    const tightRow = width * upload.bytesPerPixel;
    const rowBytes = height > 1 ? level.bytesPerRow : Math.max(tightRow, level.bytesPerRow || 0);
    if (!Number.isInteger(rowBytes) || rowBytes < tightRow) {
      throw rendererError(
        "E_CONTRACT",
        `TextureLevel.bytesPerRow must be at least ${tightRow} for level ${level.mipLevel}.`,
      );
    }
    if (rowBytes % upload.bytesPerPixel !== 0) {
      throw rendererError(
        "E_CONTRACT",
        "TextureLevel.bytesPerRow must be a whole number of pixels.",
      );
    }
    const total = rowBytes * (height - 1) + tightRow;
    if (level.bytes.byteLength < total) {
      throw rendererError(
        "E_CONTRACT",
        `TextureLevel ${level.mipLevel} is ${level.bytes.byteLength} bytes; ${total} required.`,
      );
    }
  }
  return levels;
}

export interface TextureLimits {
  readonly maxTextureDimension2D: number;
}

/**
 * Creates and uploads an immutable 2D texture (05 §4.4). Render-target,
 * storage, copy-source and MSAA uses are M1/M2 and reject rather than degrade.
 *
 * `copy-dst` is accepted as a no-op: WebGPU requires it for CPU uploads, while
 * WebGL2 uploads through `texSubImage2D` and has no matching usage flag. The
 * `sample` usage remains required because this path only creates sampled
 * textures.
 */
export function createTextureGpu(
  gl: WebGL2RenderingContext,
  state: StateCache,
  desc: TextureDesc,
  extensions: ReadonlySet<string>,
  extensionObjects: Readonly<Record<string, unknown>>,
  limits: TextureLimits,
  maxAnisotropy: number,
): TextureGpuRecord {
  if (typeof desc.label !== "string" || desc.label.length === 0) {
    throw rendererError("E_CONTRACT", "TextureDesc.label must be a non-empty string.");
  }
  if (!Number.isInteger(desc.width) || desc.width < 1 || desc.width > limits.maxTextureDimension2D) {
    throw rendererError("E_CONTRACT", "TextureDesc.width is outside the device limit.");
  }
  if (
    !Number.isInteger(desc.height) ||
    desc.height < 1 ||
    desc.height > limits.maxTextureDimension2D
  ) {
    throw rendererError("E_CONTRACT", "TextureDesc.height is outside the device limit.");
  }
  const layers = desc.depthOrArrayLayers ?? 1;
  if (layers !== 1) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Array and 3D textures are M1/M2; the M0 WebGL2 pass creates 2D textures only.",
    );
  }
  if ((desc.sampleCount ?? 1) !== 1) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "MSAA textures are M1; the M0 WebGL2 pass creates single-sample textures only.",
    );
  }
  if (!desc.usage.includes("sample")) {
    throw rendererError("E_CONTRACT", "Sampled textures must declare the sample usage.");
  }
  for (let index = 0; index < desc.usage.length; index += 1) {
    const usage = desc.usage[index];
    if (usage !== undefined && usage !== "sample" && usage !== "copy-dst") {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        `Texture usage "${usage}" is not available in the M0 WebGL2 pass.`,
      );
    }
  }
  if (isDepthFormat(desc.format)) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      `Depth texture ${desc.format} is a render-target format; shadow maps are M2.`,
    );
  }
  assertTextureFormatSupported(desc.format, desc.usage, extensions);

  const mipLevels = desc.mipLevels ?? 1;
  const maxMipLevels = Math.floor(Math.log2(Math.max(desc.width, desc.height))) + 1;
  if (!Number.isInteger(mipLevels) || mipLevels < 1 || mipLevels > maxMipLevels) {
    throw rendererError(
      "E_CONTRACT",
      `mipLevels must be between 1 and ${maxMipLevels}.`,
    );
  }
  const levels = validateLevels(gl, desc, mipLevels, desc.format);

  const texture = gl.createTexture();
  if (texture === null) {
    throw rendererError("E_BACKEND_INIT", "Could not allocate a texture.");
  }
  const internalFormat = resolveInternalFormat(gl, desc.format, extensionObjects);
  state.bindTexture(0, gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, mipLevels, internalFormat, desc.width, desc.height);

  const compressed = isCompressedFormat(desc.format);
  if (!compressed) gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  for (let index = 0; index < levels.length; index += 1) {
    const level = levels[index];
    if (level === undefined) continue;
    const width = mipDimension(desc.width, level.mipLevel);
    const height = mipDimension(desc.height, level.mipLevel);
    if (compressed) {
      gl.compressedTexSubImage2D(
        gl.TEXTURE_2D,
        level.mipLevel,
        0,
        0,
        width,
        height,
        internalFormat,
        level.bytes,
      );
      continue;
    }
    const upload = uploadFormat(gl, desc.format);
    const tightRow = width * upload.bytesPerPixel;
    const rowBytes =
      height > 1 ? level.bytesPerRow : Math.max(tightRow, level.bytesPerRow || 0);
    const rowPixels = rowBytes / upload.bytesPerPixel;
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowBytes === tightRow ? 0 : rowPixels);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      level.mipLevel,
      0,
      0,
      width,
      height,
      upload.format,
      upload.type,
      level.bytes,
    );
  }
  if (!compressed) {
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  const sampler = createSamplerGpu(gl, desc.sampler, extensionObjects, maxAnisotropy);
  return {
    texture,
    sampler,
    format: desc.format,
    width: desc.width,
    height: desc.height,
    mipLevels,
    byteSize: estimateTextureBytes(desc.format, desc.width, desc.height, 1, mipLevels),
    desc,
  };
}

/** The 1×1 white base-colour texture bound by materials without a map. */
export function createDefaultTextureGpu(
  gl: WebGL2RenderingContext,
  state: StateCache,
): TextureGpuRecord {
  const desc: TextureDesc = {
    label: "engine-default-white",
    width: 1,
    height: 1,
    format: "rgba8unorm",
    usage: ["sample"],
    data: [
      {
        mipLevel: 0,
        layer: 0,
        bytes: new Uint8Array([255, 255, 255, 255]),
        bytesPerRow: 4,
      },
    ],
    sampler: {
      magFilter: "nearest",
      minFilter: "nearest",
      mipmapFilter: "nearest",
      addressU: "clamp-to-edge",
      addressV: "clamp-to-edge",
    },
  };
  return createTextureGpu(gl, state, desc, new Set<string>(), {}, { maxTextureDimension2D: 1 }, 1);
}

export function deleteTextureGpu(
  gl: WebGL2RenderingContext,
  record: TextureGpuRecord,
): void {
  gl.deleteSampler(record.sampler);
  gl.deleteTexture(record.texture);
}


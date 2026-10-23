/**
 * KTX2 container reader (06 §4.6, §4.7, §4.9).
 *
 * M0 accepts pre-transcoded (supercompressionScheme 0) textures only. The
 * full mip chain is required: the engine does not generate mips, so an
 * incomplete chain is refused rather than silently sampled as one level.
 * No transcoding and no GPU upload happen here.
 */

import type {
  AssetCapability,
  AssetTextureFormat,
  TextureData,
  TextureLevelData,
} from "../contracts/assets.js";
import { assetError } from "../errors.js";

export const KTX2_IDENTIFIER: readonly number[] = [
  0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
];

const HEADER_BYTES = 80;
const LEVEL_INDEX_BYTES = 24;
const GPU_ALIGNMENT = 256;

export interface Ktx2FormatInfo {
  readonly format: AssetTextureFormat;
  readonly capability: AssetCapability | null;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly blockBytes: number;
}

const FORMATS_BY_VK: Readonly<Record<number, Ktx2FormatInfo>> = {
  37: {
    format: "rgba8unorm",
    capability: null,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: 4,
  },
  43: {
    format: "rgba8unorm-srgb",
    capability: null,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: 4,
  },
  131: {
    format: "bc1-rgba-unorm",
    capability: "compressed-s3tc",
    blockWidth: 4,
    blockHeight: 4,
    blockBytes: 8,
  },
  132: {
    format: "bc1-rgba-unorm-srgb",
    capability: "compressed-s3tc",
    blockWidth: 4,
    blockHeight: 4,
    blockBytes: 8,
  },
  137: {
    format: "bc3-rgba-unorm",
    capability: "compressed-s3tc",
    blockWidth: 4,
    blockHeight: 4,
    blockBytes: 16,
  },
  138: {
    format: "bc3-rgba-unorm-srgb",
    capability: "compressed-s3tc",
    blockWidth: 4,
    blockHeight: 4,
    blockBytes: 16,
  },
  145: {
    format: "bc7-rgba-unorm",
    capability: "compressed-s3tc",
    blockWidth: 4,
    blockHeight: 4,
    blockBytes: 16,
  },
  146: {
    format: "bc7-rgba-unorm-srgb",
    capability: "compressed-s3tc",
    blockWidth: 4,
    blockHeight: 4,
    blockBytes: 16,
  },
  147: {
    format: "etc2-rgba8unorm",
    capability: "compressed-etc2",
    blockWidth: 4,
    blockHeight: 4,
    blockBytes: 16,
  },
  148: {
    format: "etc2-rgba8unorm-srgb",
    capability: "compressed-etc2",
    blockWidth: 4,
    blockHeight: 4,
    blockBytes: 16,
  },
  157: {
    format: "astc-4x4-unorm",
    capability: "compressed-astc",
    blockWidth: 4,
    blockHeight: 4,
    blockBytes: 16,
  },
  158: {
    format: "astc-4x4-unorm-srgb",
    capability: "compressed-astc",
    blockWidth: 4,
    blockHeight: 4,
    blockBytes: 16,
  },
};

function fail(id: string, reason: string): never {
  throw assetError("E_ASSET_FORMAT", `${id}: ${reason}`, id);
}

function align256(value: number): number {
  return Math.ceil(value / GPU_ALIGNMENT) * GPU_ALIGNMENT;
}

function blockBytes(
  width: number,
  height: number,
  info: Ktx2FormatInfo,
): number {
  return (
    Math.ceil(width / info.blockWidth) *
    Math.ceil(height / info.blockHeight) *
    info.blockBytes
  );
}

/** Planned GPU bytes for a texture, per 06 §4.9. */
export function textureGpuBytes(
  width: number,
  height: number,
  mipLevels: number,
  layers: number,
  info: Ktx2FormatInfo,
): number {
  let total = 0;
  for (let layer = 0; layer < layers; layer += 1) {
    for (let level = 0; level < mipLevels; level += 1) {
      const levelWidth = Math.max(1, width >> level);
      const levelHeight = Math.max(1, height >> level);
      total += align256(blockBytes(levelWidth, levelHeight, info));
    }
  }
  return total;
}

/** Texture token and capability for a KTX2 vkFormat, if supported. */
export function ktx2FormatForVkFormat(
  vkFormat: number,
): { readonly format: AssetTextureFormat; readonly capability: AssetCapability | null } | null {
  const info = FORMATS_BY_VK[vkFormat];
  if (info === undefined) return null;
  return { format: info.format, capability: info.capability };
}

function readUint64(
  data: DataView,
  offset: number,
  id: string,
  label: string,
): number {
  const value = data.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(id, `${label} exceeds the safe integer range`);
  }
  return Number(value);
}

export interface Ktx2Plan {
  readonly decodedBytes: number;
  readonly gpuBytes: number;
}

/**
 * Header-only plan used to reserve the decoded and texture ledgers before a
 * KTX2 decode copies any level bytes (06 §5.5). Validates the same header and
 * level-index facts `decodeKtx2` will enforce.
 */
export function planKtx2(
  id: string,
  bytes: ArrayBuffer,
  capabilities?: ReadonlySet<AssetCapability>,
): Ktx2Plan {
  if (bytes.byteLength < HEADER_BYTES) fail(id, "KTX2 header is truncated");
  const data = new DataView(bytes);
  const signature = new Uint8Array(bytes, 0, KTX2_IDENTIFIER.length);
  for (let index = 0; index < KTX2_IDENTIFIER.length; index += 1) {
    if (signature[index] !== KTX2_IDENTIFIER[index]) {
      fail(id, "KTX2 identifier does not match");
    }
  }
  const vkFormat = data.getUint32(12, true);
  const typeSize = data.getUint32(16, true);
  const width = data.getUint32(20, true);
  const height = data.getUint32(24, true);
  const pixelDepth = data.getUint32(28, true);
  const layerCount = data.getUint32(32, true);
  const faceCount = data.getUint32(36, true);
  const levelCount = data.getUint32(40, true);
  const supercompressionScheme = data.getUint32(44, true);

  if (typeSize !== 1) fail(id, "KTX2 typeSize must be 1");
  if (width === 0 || height === 0) fail(id, "KTX2 dimensions must be positive");
  if (width > 4096 || height > 4096) fail(id, "KTX2 dimensions exceed 4096");
  if (pixelDepth !== 0) fail(id, "KTX2 pixelDepth must be 0");
  if (faceCount !== 1) fail(id, "KTX2 faceCount must be 1");
  if (layerCount !== 0 && layerCount !== 1) {
    fail(id, "KTX2 layerCount must be 0 or 1");
  }
  if (supercompressionScheme !== 0) {
    fail(id, "KTX2 supercompression is not supported in M0");
  }
  const info = FORMATS_BY_VK[vkFormat];
  if (info === undefined) fail(id, `KTX2 vkFormat ${vkFormat} is unsupported`);
  if (info.capability !== null && capabilities !== undefined) {
    if (!capabilities.has(info.capability)) {
      throw assetError(
        "E_UNSUPPORTED_FEATURE",
        `${id}: KTX2 format ${info.format} requires ${info.capability}`,
        id,
      );
    }
  }
  const expectedLevels = 1 + Math.floor(Math.log2(Math.max(width, height)));
  if (levelCount !== expectedLevels) {
    fail(
      id,
      `KTX2 levelCount ${levelCount} is not the complete chain ${expectedLevels}`,
    );
  }
  if (bytes.byteLength < HEADER_BYTES + levelCount * LEVEL_INDEX_BYTES) {
    fail(id, "KTX2 level index is truncated");
  }
  let decodedBytes = 0;
  for (let level = 0; level < levelCount; level += 1) {
    const entryOffset = HEADER_BYTES + level * LEVEL_INDEX_BYTES;
    const byteOffset = readUint64(data, entryOffset, id, "level byteOffset");
    const byteLength = readUint64(
      data,
      entryOffset + 8,
      id,
      "level byteLength",
    );
    if (byteOffset % 4 !== 0) {
      fail(id, "KTX2 level byteOffset must be 4-byte aligned");
    }
    if (byteOffset + byteLength > bytes.byteLength) {
      fail(id, "KTX2 level points outside the buffer");
    }
    const levelWidth = Math.max(1, width >> level);
    const levelHeight = Math.max(1, height >> level);
    const expectedLength = blockBytes(levelWidth, levelHeight, info);
    if (byteLength !== expectedLength) {
      fail(
        id,
        `KTX2 level ${level} has ${byteLength} bytes, expected ${expectedLength}`,
      );
    }
    decodedBytes += byteLength;
  }
  const layers = layerCount === 0 ? 1 : layerCount;
  return {
    decodedBytes: decodedBytes * layers,
    gpuBytes: textureGpuBytes(width, height, levelCount, layers, info),
  };
}

export interface DecodeKtx2Options {
  readonly id: string;
  readonly bytes: ArrayBuffer;
  readonly capabilities?: ReadonlySet<AssetCapability>;
}

/**
 * Parses a KTX2 container into `TextureData`. Throws `E_ASSET_FORMAT` for a
 * bad header/level index or `E_UNSUPPORTED_FEATURE` when the declared format
 * needs a capability the caller passed as absent.
 */
export function decodeKtx2(options: DecodeKtx2Options): TextureData {
  const { id, bytes } = options;
  if (bytes.byteLength < HEADER_BYTES) fail(id, "KTX2 header is truncated");
  const data = new DataView(bytes);
  const signature = new Uint8Array(bytes, 0, KTX2_IDENTIFIER.length);
  for (let index = 0; index < KTX2_IDENTIFIER.length; index += 1) {
    if (signature[index] !== KTX2_IDENTIFIER[index]) {
      fail(id, "KTX2 identifier does not match");
    }
  }

  const vkFormat = data.getUint32(12, true);
  const typeSize = data.getUint32(16, true);
  const width = data.getUint32(20, true);
  const height = data.getUint32(24, true);
  const pixelDepth = data.getUint32(28, true);
  const layerCount = data.getUint32(32, true);
  const faceCount = data.getUint32(36, true);
  const levelCount = data.getUint32(40, true);
  const supercompressionScheme = data.getUint32(44, true);

  if (typeSize !== 1) fail(id, "KTX2 typeSize must be 1");
  if (width === 0 || height === 0) fail(id, "KTX2 dimensions must be positive");
  if (width > 4096 || height > 4096) {
    fail(id, "KTX2 dimensions exceed 4096");
  }
  if (pixelDepth !== 0) fail(id, "KTX2 pixelDepth must be 0");
  if (faceCount !== 1) fail(id, "KTX2 faceCount must be 1");
  if (layerCount !== 0 && layerCount !== 1) {
    fail(id, "KTX2 layerCount must be 0 or 1");
  }
  if (supercompressionScheme !== 0) {
    fail(id, "KTX2 supercompression is not supported in M0");
  }

  const info = FORMATS_BY_VK[vkFormat];
  if (info === undefined) fail(id, `KTX2 vkFormat ${vkFormat} is unsupported`);
  if (info.capability !== null && options.capabilities !== undefined) {
    if (!options.capabilities.has(info.capability)) {
      throw assetError(
        "E_UNSUPPORTED_FEATURE",
        `${id}: KTX2 format ${info.format} requires ${info.capability}`,
        id,
      );
    }
  }

  const expectedLevels =
    1 + Math.floor(Math.log2(Math.max(width, height)));
  if (levelCount !== expectedLevels) {
    fail(
      id,
      `KTX2 levelCount ${levelCount} is not the complete chain ${expectedLevels}`,
    );
  }
  if (bytes.byteLength < HEADER_BYTES + levelCount * LEVEL_INDEX_BYTES) {
    fail(id, "KTX2 level index is truncated");
  }

  const layers = layerCount === 0 ? 1 : layerCount;
  const levels: TextureLevelData[] = [];
  const seenMipLevels: boolean[] = new Array<boolean>(levelCount).fill(false);
  for (let layer = 0; layer < layers; layer += 1) {
    for (let level = 0; level < levelCount; level += 1) {
      const entryOffset = HEADER_BYTES + level * LEVEL_INDEX_BYTES;
      const byteOffset = readUint64(data, entryOffset, id, "level byteOffset");
      const byteLength = readUint64(
        data,
        entryOffset + 8,
        id,
        "level byteLength",
      );
      const uncompressedLength = readUint64(
        data,
        entryOffset + 16,
        id,
        "level uncompressedByteLength",
      );
      if (byteOffset % 4 !== 0) {
        fail(id, "KTX2 level byteOffset must be 4-byte aligned");
      }
      if (byteOffset + byteLength > bytes.byteLength) {
        fail(id, "KTX2 level points outside the buffer");
      }
      const levelWidth = Math.max(1, width >> level);
      const levelHeight = Math.max(1, height >> level);
      const expectedLength = blockBytes(levelWidth, levelHeight, info);
      if (byteLength !== expectedLength) {
        fail(
          id,
          `KTX2 level ${level} has ${byteLength} bytes, expected ${expectedLength}`,
        );
      }
      if (
        uncompressedLength !== 0 &&
        uncompressedLength !== expectedLength
      ) {
        fail(id, "KTX2 uncompressedByteLength does not match the level");
      }
      const levelBytes = new Uint8Array(byteLength);
      levelBytes.set(new Uint8Array(bytes, byteOffset, byteLength));
      levels.push({
        mipLevel: level,
        layer,
        bytes: levelBytes,
        bytesPerRow:
          Math.ceil(levelWidth / info.blockWidth) * info.blockBytes,
      });
      seenMipLevels[level] = true;
    }
  }
  for (let level = 0; level < levelCount; level += 1) {
    if (seenMipLevels[level] !== true) {
      fail(id, "KTX2 mip chain is incomplete");
    }
  }

  return {
    formatVersion: 1,
    id,
    container: "ktx2",
    width,
    height,
    mipLevels: levelCount,
    layers,
    format: info.format,
    sourceColorSpace: info.format.endsWith("-srgb") ? "srgb" : "linear",
    levels,
    gpuBytes: textureGpuBytes(width, height, levelCount, layers, info),
    completeMipChain: true,
  };
}

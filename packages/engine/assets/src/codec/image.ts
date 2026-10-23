/**
 * WebP / PNG default texture decode (06 §4.6).
 *
 * Dimensions come from the container header before any bitmap exists, so a
 * 16384² decompression bomb is refused up front. Pixels are produced through
 * an injected bitmap factory; tests supply a fake that carries RGBA data, and
 * the browser path uses `createImageBitmap` + `OffscreenCanvas`. Output is
 * always `rgba8unorm`, one level, sRGB metadata, alpha preserved.
 */

import type { TextureData } from "../contracts/assets.js";
import { assetError } from "../errors.js";

export const MAX_TEXTURE_DIMENSION = 4096;
const GPU_ALIGNMENT = 256;

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface ImageBitmapLike {
  readonly width: number;
  readonly height: number;
  /** Test seam: RGBA8 pixels, width * height * 4 bytes. */
  readonly data?: Uint8Array | Uint8ClampedArray;
  close?: () => void;
}

export type CreateImageBitmapFn = (
  blob: Blob,
  options?: ImageBitmapOptions,
) => Promise<ImageBitmapLike>;

export type ReadPixelsFn = (
  bitmap: ImageBitmapLike,
) => Promise<Uint8Array> | Uint8Array;

export interface DecodeImageOptions {
  readonly id: string;
  readonly bytes: ArrayBuffer;
  readonly container: "webp" | "png";
  /** Defaults to `globalThis.createImageBitmap`. */
  readonly createBitmap?: CreateImageBitmapFn;
  /** Defaults to `bitmap.data` or OffscreenCanvas 2D readback. */
  readonly readPixels?: ReadPixelsFn;
}

function fail(id: string, reason: string): never {
  throw assetError("E_ASSET_FORMAT", `${id}: ${reason}`, id);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return text;
}

function validateDimensions(
  id: string,
  width: number,
  height: number,
): ImageDimensions {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    fail(id, "image dimensions are invalid");
  }
  if (width > MAX_TEXTURE_DIMENSION || height > MAX_TEXTURE_DIMENSION) {
    fail(id, `image dimensions exceed ${MAX_TEXTURE_DIMENSION}`);
  }
  return { width, height };
}

const PNG_SIGNATURE: readonly number[] = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
];

/** Reads PNG width/height from the mandatory IHDR chunk. */
export function readPngDimensions(
  id: string,
  bytes: ArrayBuffer,
): ImageDimensions {
  if (bytes.byteLength < 33) fail(id, "PNG is truncated");
  const data = new DataView(bytes);
  const header = new Uint8Array(bytes, 0, 8);
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (header[index] !== PNG_SIGNATURE[index]) {
      fail(id, "PNG signature does not match");
    }
  }
  if (data.getUint32(8, false) !== 13) fail(id, "PNG IHDR length is invalid");
  const chunkType = new Uint8Array(bytes, 12, 4);
  if (ascii(chunkType, 0, 4) !== "IHDR") {
    fail(id, "PNG first chunk must be IHDR");
  }
  return validateDimensions(
    id,
    data.getUint32(16, false),
    data.getUint32(20, false),
  );
}

function readUint24le(data: DataView, offset: number): number {
  return (
    (data.getUint8(offset) |
      (data.getUint8(offset + 1) << 8) |
      (data.getUint8(offset + 2) << 16)) >>>
    0
  );
}

/** Reads WebP width/height from VP8, VP8L or VP8X. Frame 0 is what decodes. */
export function readWebpDimensions(
  id: string,
  bytes: ArrayBuffer,
): ImageDimensions {
  if (bytes.byteLength < 16) fail(id, "WebP is truncated");
  const data = new DataView(bytes);
  const header = new Uint8Array(bytes);
  if (ascii(header, 0, 4) !== "RIFF") fail(id, "WebP RIFF signature is invalid");
  if (ascii(header, 8, 4) !== "WEBP") fail(id, "WebP form type is invalid");
  const riffSize = data.getUint32(4, true);
  if (riffSize + 8 !== bytes.byteLength) {
    fail(id, "WebP RIFF size does not match the buffer length");
  }
  const chunk = ascii(header, 12, 4);

  if (chunk === "VP8 ") {
    if (bytes.byteLength < 30) fail(id, "WebP VP8 chunk is truncated");
    if (
      data.getUint8(23) !== 0x9d ||
      data.getUint8(24) !== 0x01 ||
      data.getUint8(25) !== 0x2a
    ) {
      fail(id, "WebP VP8 start code is invalid");
    }
    return validateDimensions(
      id,
      data.getUint16(26, true) & 0x3fff,
      data.getUint16(28, true) & 0x3fff,
    );
  }

  if (chunk === "VP8L") {
    if (bytes.byteLength < 25) fail(id, "WebP VP8L chunk is truncated");
    if (data.getUint8(20) !== 0x2f) {
      fail(id, "WebP VP8L signature is invalid");
    }
    const bits = data.getUint32(21, true);
    return validateDimensions(
      id,
      (bits & 0x3fff) + 1,
      ((bits >>> 14) & 0x3fff) + 1,
    );
  }

  if (chunk === "VP8X") {
    if (bytes.byteLength < 30) fail(id, "WebP VP8X chunk is truncated");
    return validateDimensions(
      id,
      readUint24le(data, 24) + 1,
      readUint24le(data, 27) + 1,
    );
  }

  fail(id, "WebP chunk is not VP8, VP8L or VP8X");
}

/** Dimensions for a supported image container. */
export function readImageDimensions(
  id: string,
  container: "webp" | "png",
  bytes: ArrayBuffer,
): ImageDimensions {
  return container === "png"
    ? readPngDimensions(id, bytes)
    : readWebpDimensions(id, bytes);
}

function align256(value: number): number {
  return Math.ceil(value / GPU_ALIGNMENT) * GPU_ALIGNMENT;
}

function defaultCreateBitmap(): CreateImageBitmapFn {
  const factory = (globalThis as { createImageBitmap?: unknown })
    .createImageBitmap;
  if (typeof factory !== "function") {
    throw assetError(
      "E_ASSET_UNSUPPORTED",
      "createImageBitmap is not available",
    );
  }
  return (blob, options) =>
    (
      factory as (
        blob: Blob,
        options?: ImageBitmapOptions,
      ) => Promise<ImageBitmap>
    ).call(globalThis, blob, options) as unknown as Promise<ImageBitmapLike>;
}

function defaultReadPixels(id: string): ReadPixelsFn {
  return (bitmap) => {
    if (bitmap.data !== undefined) {
      const source = bitmap.data;
      const copy = new Uint8Array(source.byteLength);
      copy.set(source);
      return copy;
    }
    if (typeof OffscreenCanvas === "undefined") {
      throw assetError(
        "E_ASSET_UNSUPPORTED",
        `${id}: no OffscreenCanvas for pixel readback`,
        id,
      );
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (context === null) {
      throw assetError(
        "E_ASSET_UNSUPPORTED",
        `${id}: OffscreenCanvas 2D context is unavailable`,
        id,
      );
    }
    context.drawImage(
      bitmap as unknown as CanvasImageSource,
      0,
      0,
      bitmap.width,
      bitmap.height,
    );
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const copy = new Uint8Array(image.data.byteLength);
    copy.set(image.data);
    return copy;
  };
}

/**
 * Decodes WebP/PNG bytes to `TextureData` with a single RGBA8 mip.
 * The bitmap factory is injected so Node tests never touch a DOM.
 */
export async function decodeImage(
  options: DecodeImageOptions,
): Promise<TextureData> {
  const { id, bytes, container } = options;
  const dimensions = readImageDimensions(id, container, bytes);
  const expectedPixels = dimensions.width * dimensions.height * 4;

  const createBitmap = options.createBitmap ?? defaultCreateBitmap();
  const readPixels = options.readPixels ?? defaultReadPixels(id);
  const mimeType = container === "png" ? "image/png" : "image/webp";

  let bitmap: ImageBitmapLike;
  try {
    bitmap = await createBitmap(new Blob([bytes], { type: mimeType }), {
      imageOrientation: "none",
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "EngineError") throw error;
    throw assetError("E_ASSET_FORMAT", `${id}: image decode failed`, id);
  }

  try {
    if (
      bitmap.width !== dimensions.width ||
      bitmap.height !== dimensions.height
    ) {
      fail(id, "decoded bitmap dimensions do not match the header");
    }
    let pixels: Uint8Array;
    try {
      pixels = await readPixels(bitmap);
    } catch (error) {
      if (error instanceof Error && error.name === "EngineError") throw error;
      throw assetError(
        "E_ASSET_UNSUPPORTED",
        `${id}: image pixel readback failed`,
        id,
      );
    }
    if (!(pixels instanceof Uint8Array)) {
      throw assetError(
        "E_ASSET_UNSUPPORTED",
        `${id}: pixel readback did not return a Uint8Array`,
        id,
      );
    }
    if (pixels.byteLength !== expectedPixels) {
      fail(
        id,
        `RGBA buffer is ${pixels.byteLength} bytes, expected ${expectedPixels}`,
      );
    }

    return {
      formatVersion: 1,
      id,
      container,
      width: dimensions.width,
      height: dimensions.height,
      mipLevels: 1,
      layers: 1,
      format: "rgba8unorm",
      sourceColorSpace: "srgb",
      levels: [
        {
          mipLevel: 0,
          layer: 0,
          bytes: pixels,
          bytesPerRow: dimensions.width * 4,
        },
      ],
      gpuBytes: align256(expectedPixels),
      completeMipChain: false,
    };
  } finally {
    try {
      bitmap.close?.();
    } catch {
      // Closing a bitmap is best-effort and must not mask the decode result.
    }
  }
}

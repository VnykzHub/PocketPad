/**
 * ER-06-05: WebP/PNG header reads and image decode.
 *
 * Node has no `createImageBitmap`, so every decode here injects a fake
 * bitmap factory. Dimensions always come from the container header first.
 */

import { describe, expect, test } from "vitest";
import {
  decodeImage,
  MAX_TEXTURE_DIMENSION,
  readImageDimensions,
  readPngDimensions,
  readWebpDimensions,
  type ImageBitmapLike,
} from "../src/codec/image.js";
import { AssetEngineError } from "../src/errors.js";
import {
  arrayBufferOf,
  buildPngHeader,
  buildWebpVp8l,
  catchAsync,
  catchError,
  expectCode,
} from "./helpers.js";

interface FakeBitmap {
  readonly bitmap: ImageBitmapLike;
  readonly closed: () => number;
}

function fakeBitmap(width: number, height: number, fill = 0x40): FakeBitmap {
  let closes = 0;
  const data = new Uint8Array(width * height * 4);
  data.fill(fill);
  return {
    bitmap: {
      width,
      height,
      data,
      close: () => {
        closes += 1;
      },
    },
    closed: () => closes,
  };
}

function setAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}

function messageOf(error: unknown): string {
  return error instanceof AssetEngineError ? error.message : String(error);
}

describe("ER-06-05 image decode", () => {
  test("ER-06-05 reads PNG dimensions from the IHDR chunk", () => {
    expect(readPngDimensions("textures/p", buildPngHeader(16, 8))).toEqual({
      width: 16,
      height: 8,
    });
    expect(
      readImageDimensions("textures/p", "png", buildPngHeader(3, 5)),
    ).toEqual({ width: 3, height: 5 });
  });

  test("ER-06-05 reads VP8L WebP dimensions", () => {
    expect(readWebpDimensions("textures/w", buildWebpVp8l(5, 3))).toEqual({
      width: 5,
      height: 3,
    });
    expect(
      readImageDimensions("textures/w", "webp", buildWebpVp8l(1, 1)),
    ).toEqual({ width: 1, height: 1 });
  });

  test("ER-06-05 decodes PNG pixels through an injected bitmap", async () => {
    const fake = fakeBitmap(2, 2, 0x20);
    let blobType = "";
    let bitmapOptions: ImageBitmapOptions | undefined;
    const texture = await decodeImage({
      id: "textures/checker",
      bytes: buildPngHeader(2, 2),
      container: "png",
      createBitmap: async (blob, options) => {
        blobType = blob.type;
        bitmapOptions = options;
        return fake.bitmap;
      },
    });

    expect(blobType).toBe("image/png");
    expect(bitmapOptions).toEqual({
      imageOrientation: "none",
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
    expect(texture.formatVersion).toBe(1);
    expect(texture.id).toBe("textures/checker");
    expect(texture.container).toBe("png");
    expect(texture.width).toBe(2);
    expect(texture.height).toBe(2);
    expect(texture.mipLevels).toBe(1);
    expect(texture.layers).toBe(1);
    expect(texture.format).toBe("rgba8unorm");
    expect(texture.sourceColorSpace).toBe("srgb");
    expect(texture.completeMipChain).toBe(false);
    expect(texture.gpuBytes).toBe(256);
    expect(texture.levels).toHaveLength(1);
    expect(texture.levels[0]).toMatchObject({
      mipLevel: 0,
      layer: 0,
      bytesPerRow: 8,
    });
    expect(texture.levels[0]?.bytes.byteLength).toBe(16);
    expect(texture.levels[0]?.bytes[0]).toBe(0x20);
    expect(texture.levels[0]?.bytes[3]).toBe(0x20);
    expect(fake.closed()).toBe(1);
  });

  test("ER-06-05 decodes WebP with the WebP MIME type and aligned GPU bytes", async () => {
    const fake = fakeBitmap(5, 3);
    let blobType = "";
    const texture = await decodeImage({
      id: "textures/w",
      bytes: buildWebpVp8l(5, 3),
      container: "webp",
      createBitmap: async (blob) => {
        blobType = blob.type;
        return fake.bitmap;
      },
    });

    expect(blobType).toBe("image/webp");
    expect(texture.container).toBe("webp");
    expect(texture.width).toBe(5);
    expect(texture.height).toBe(3);
    // 5 * 3 * 4 = 60 bytes, aligned to 256.
    expect(texture.gpuBytes).toBe(256);
    expect(texture.levels[0]?.bytesPerRow).toBe(20);
    expect(fake.closed()).toBe(1);
  });

  test("ER-06-05 rejects a bitmap whose dimensions disagree with the header", async () => {
    const fake = fakeBitmap(4, 2);
    const error = await catchAsync(
      decodeImage({
        id: "textures/mismatch",
        bytes: buildPngHeader(2, 2),
        container: "png",
        createBitmap: async () => fake.bitmap,
      }),
    );
    expectCode(error, "E_ASSET_FORMAT");
    expect(messageOf(error)).toContain("dimensions do not match");
    expect(fake.closed()).toBe(1);
  });

  test("ER-06-05 rejects an RGBA buffer with the wrong length", async () => {
    const error = await catchAsync(
      decodeImage({
        id: "textures/short",
        bytes: buildPngHeader(2, 2),
        container: "png",
        createBitmap: async () => ({
          width: 2,
          height: 2,
          data: new Uint8Array(15),
        }),
      }),
    );
    expectCode(error, "E_ASSET_FORMAT");
    expect(messageOf(error)).toContain("RGBA buffer");
  });

  test("ER-06-05 rejects dimensions over the texture limit before decoding", () => {
    const error = catchError(() =>
      readPngDimensions(
        "textures/big",
        buildPngHeader(MAX_TEXTURE_DIMENSION + 1, 1),
      ),
    );
    expectCode(error, "E_ASSET_FORMAT");
    expect(messageOf(error)).toContain(`exceed ${MAX_TEXTURE_DIMENSION}`);

    expectCode(
      catchError(() =>
        readWebpDimensions(
          "textures/big",
          buildWebpVp8l(MAX_TEXTURE_DIMENSION + 1, 1),
        ),
      ),
      "E_ASSET_FORMAT",
    );
  });

  test("ER-06-05 maps bitmap factory failure to E_ASSET_FORMAT", async () => {
    const error = await catchAsync(
      decodeImage({
        id: "textures/bad",
        bytes: buildPngHeader(2, 2),
        container: "png",
        createBitmap: async () => {
          throw new Error("decoder exploded");
        },
      }),
    );
    expectCode(error, "E_ASSET_FORMAT");
    expect(messageOf(error)).toContain("image decode failed");
  });

  test("ER-06-05 maps readback failure to E_ASSET_UNSUPPORTED", async () => {
    const fake = fakeBitmap(2, 2);
    const error = await catchAsync(
      decodeImage({
        id: "textures/readback",
        bytes: buildPngHeader(2, 2),
        container: "png",
        createBitmap: async () => fake.bitmap,
        readPixels: () => {
          throw new Error("no context");
        },
      }),
    );
    expectCode(error, "E_ASSET_UNSUPPORTED");
    expect(messageOf(error)).toContain("pixel readback failed");
    expect(fake.closed()).toBe(1);
  });

  test("ER-06-05 rejects readback that is not a Uint8Array", async () => {
    const fake = fakeBitmap(2, 2);
    const error = await catchAsync(
      decodeImage({
        id: "textures/readback",
        bytes: buildPngHeader(2, 2),
        container: "png",
        createBitmap: async () => fake.bitmap,
        readPixels: () => new Uint16Array(16) as unknown as Uint8Array,
      }),
    );
    expectCode(error, "E_ASSET_UNSUPPORTED");
    expect(messageOf(error)).toContain("did not return a Uint8Array");
  });

  test("ER-06-05 requires createImageBitmap when no factory is injected", async () => {
    const error = await catchAsync(
      decodeImage({
        id: "textures/node",
        bytes: buildPngHeader(2, 2),
        container: "png",
      }),
    );
    expectCode(error, "E_ASSET_UNSUPPORTED");
    expect(messageOf(error)).toContain("createImageBitmap is not available");
  });

  test("ER-06-05 rejects malformed PNG and WebP headers", () => {
    expectCode(
      catchError(() => readPngDimensions("textures/p", new ArrayBuffer(12))),
      "E_ASSET_FORMAT",
    );

    const badSignature = buildPngHeader(2, 2);
    new Uint8Array(badSignature)[0] = 0;
    expectCode(
      catchError(() => readPngDimensions("textures/p", badSignature)),
      "E_ASSET_FORMAT",
    );

    const notIhdr = buildPngHeader(2, 2);
    setAscii(new Uint8Array(notIhdr), 12, "IDAT");
    expectCode(
      catchError(() => readPngDimensions("textures/p", notIhdr)),
      "E_ASSET_FORMAT",
    );

    const badRiff = buildWebpVp8l(2, 2);
    setAscii(new Uint8Array(badRiff), 0, "RIFX");
    expectCode(
      catchError(() => readWebpDimensions("textures/w", badRiff)),
      "E_ASSET_FORMAT",
    );

    const wrongSize = buildWebpVp8l(2, 2);
    new DataView(wrongSize).setUint32(4, 99, true);
    expectCode(
      catchError(() => readWebpDimensions("textures/w", wrongSize)),
      "E_ASSET_FORMAT",
    );

    const unknownChunk = buildWebpVp8l(2, 2);
    setAscii(new Uint8Array(unknownChunk), 12, "ABCD");
    expectCode(
      catchError(() => readWebpDimensions("textures/w", unknownChunk)),
      "E_ASSET_FORMAT",
    );

    const truncatedVp8l = arrayBufferOf(
      new Uint8Array(buildWebpVp8l(2, 2)).slice(0, 20),
    );
    expectCode(
      catchError(() => readWebpDimensions("textures/w", truncatedVp8l)),
      "E_ASSET_FORMAT",
    );
  });
});

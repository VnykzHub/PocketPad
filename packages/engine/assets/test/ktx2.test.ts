/**
 * ER-06-04: KTX2 container planning and decode.
 *
 * The M0 subset is pre-transcoded KTX2 with a complete mip chain and one of
 * the twelve mapped vkFormats. Capability-gated formats fail loudly.
 */

import { describe, expect, test } from "vitest";
import {
  decodeKtx2,
  KTX2_IDENTIFIER,
  planKtx2,
  textureGpuBytes,
} from "../src/codec/ktx2.js";
import { AssetEngineError } from "../src/errors.js";
import { buildKtx2, catchError, expectCode } from "./helpers.js";

const S3TC = new Set<"compressed-s3tc">(["compressed-s3tc"]);

describe("ER-06-04 KTX2", () => {
  test("ER-06-04 plan and decode a complete rgba8unorm mip chain", () => {
    const bytes = buildKtx2({ vkFormat: 37, width: 2, height: 2 });
    const plan = planKtx2("textures/t", bytes);
    expect(plan.decodedBytes).toBe(20);
    expect(plan.gpuBytes).toBe(512);

    const texture = decodeKtx2({ id: "textures/t", bytes });
    expect(texture.formatVersion).toBe(1);
    expect(texture.container).toBe("ktx2");
    expect(texture.width).toBe(2);
    expect(texture.height).toBe(2);
    expect(texture.mipLevels).toBe(2);
    expect(texture.layers).toBe(1);
    expect(texture.format).toBe("rgba8unorm");
    expect(texture.sourceColorSpace).toBe("linear");
    expect(texture.completeMipChain).toBe(true);
    expect(texture.gpuBytes).toBe(512);
    expect(texture.levels).toHaveLength(2);
    expect(texture.levels[0]).toMatchObject({
      mipLevel: 0,
      layer: 0,
      bytesPerRow: 8,
    });
    expect(texture.levels[0]?.bytes.byteLength).toBe(16);
    expect(texture.levels[1]?.bytes.byteLength).toBe(4);
  });

  test("ER-06-04 maps the sRGB vkFormat token and color space", () => {
    const texture = decodeKtx2({
      id: "textures/t",
      bytes: buildKtx2({ vkFormat: 43, width: 2, height: 2 }),
    });
    expect(texture.format).toBe("rgba8unorm-srgb");
    expect(texture.sourceColorSpace).toBe("srgb");
  });

  test("ER-06-04 requires the s3tc capability for BC formats", () => {
    const bytes = buildKtx2({ vkFormat: 145, width: 4, height: 4 });
    const planError = catchError(() =>
      planKtx2("textures/t", bytes, new Set()),
    );
    expectCode(planError, "E_UNSUPPORTED_FEATURE");
    const decodeError = catchError(() =>
      decodeKtx2({ id: "textures/t", bytes, capabilities: new Set() }),
    );
    expectCode(decodeError, "E_UNSUPPORTED_FEATURE");

    const texture = decodeKtx2({
      id: "textures/t",
      bytes,
      capabilities: S3TC,
    });
    expect(texture.format).toBe("bc7-rgba-unorm");
    expect(texture.mipLevels).toBe(3);
    expect(texture.levels).toHaveLength(3);
    expect(texture.gpuBytes).toBe(768);
  });

  test("ER-06-04 rejects an incomplete mip chain", () => {
    const bytes = buildKtx2({
      vkFormat: 37,
      width: 4,
      height: 4,
      levelCount: 1,
    });
    const error = catchError(() => decodeKtx2({ id: "textures/t", bytes }));
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain("complete chain");
  });

  test("ER-06-04 rejects supercompressed KTX2 in M0", () => {
    const bytes = buildKtx2({
      vkFormat: 37,
      width: 2,
      height: 2,
      supercompressionScheme: 1,
    });
    const error = catchError(() => decodeKtx2({ id: "textures/t", bytes }));
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain("supercompression");
  });

  test("ER-06-04 rejects a level that points outside the buffer", () => {
    const bytes = buildKtx2({ vkFormat: 37, width: 2, height: 2 });
    new DataView(bytes).setBigUint64(88, 9_999n, true);
    const error = catchError(() => planKtx2("textures/t", bytes));
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain(
      "points outside the buffer",
    );
  });

  test("ER-06-04 rejects an unaligned level byte offset", () => {
    const bytes = buildKtx2({ vkFormat: 37, width: 2, height: 2 });
    new DataView(bytes).setBigUint64(80, 1n, true);
    const error = catchError(() => decodeKtx2({ id: "textures/t", bytes }));
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain("4-byte aligned");
  });

  test("ER-06-04 rejects zero dimensions and unknown vkFormats", () => {
    const zero = buildKtx2({ vkFormat: 37, width: 2, height: 2 });
    new DataView(zero).setUint32(20, 0, true);
    expectCode(
      catchError(() => decodeKtx2({ id: "textures/t", bytes: zero })),
      "E_ASSET_FORMAT",
    );

    const unknown = buildKtx2({ vkFormat: 999, width: 2, height: 2 });
    const error = catchError(() =>
      decodeKtx2({ id: "textures/t", bytes: unknown }),
    );
    expectCode(error, "E_ASSET_FORMAT");
    expect((error as AssetEngineError).message).toContain("vkFormat 999");
  });

  test("ER-06-04 rejects a truncated header and a bad identifier", () => {
    expectCode(
      catchError(() =>
        decodeKtx2({ id: "textures/t", bytes: new ArrayBuffer(12) }),
      ),
      "E_ASSET_FORMAT",
    );
    const bytes = buildKtx2({ vkFormat: 37, width: 2, height: 2 });
    new Uint8Array(bytes)[0] = 0;
    expectCode(
      catchError(() => decodeKtx2({ id: "textures/t", bytes })),
      "E_ASSET_FORMAT",
    );
    expect(KTX2_IDENTIFIER[0]).toBe(0xab);
  });

  test("ER-06-04 computes the aligned GPU byte formula", () => {
    const rgba = {
      format: "rgba8unorm",
      capability: null,
      blockWidth: 1,
      blockHeight: 1,
      blockBytes: 4,
    } as const;
    // 2x2 rgba: level0 16 B -> 256, level1 4 B -> 256.
    expect(textureGpuBytes(2, 2, 2, 1, rgba)).toBe(512);
    // 4x4 bc7: three 16 B levels, each aligned to 256.
    const bc7 = {
      format: "bc7-rgba-unorm",
      capability: "compressed-s3tc",
      blockWidth: 4,
      blockHeight: 4,
      blockBytes: 16,
    } as const;
    expect(textureGpuBytes(4, 4, 3, 1, bc7)).toBe(768);
  });
});

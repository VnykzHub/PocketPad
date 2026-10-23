/**
 * ER-05-01: the exact 19-token texture map, extension gating, internalformat
 * resolution and conservative byte accounting (05 §4.4). The map fixture is
 * synthetic contract data, not a measurement.
 */

import { describe, expect, test } from "vitest";
import type { TextureFormat, TextureUsage } from "@lanpad/engine-core";
import { EXT } from "../src/classify.js";
import {
  TEXTURE_EXTENSION_NAMES,
  TEXTURE_FORMATS,
  WEBGL2_TEXTURE_FORMAT_MAP,
  assertTextureFormatSupported,
  estimateTextureBytes,
  isCompressedFormat,
  isDepthFormat,
  isFloatFormat,
  isTextureFormatToken,
  levelBytes,
  resolveInternalFormat,
  supportedTextureFormats,
  textureFormatEntry,
} from "../src/texture.js";
import { createFakeWebGL2, glConstant } from "./fake/webgl2.js";
import { errorCodeOf, readFixture } from "./helpers.js";

interface FormatRow {
  readonly status: "core" | "extension" | "unsupported";
  readonly internalFormat: string | null;
  readonly extension: string | null;
  readonly renderTargetExtension: string | null;
  readonly notes: string;
}

interface FormatFixture {
  readonly schema: string;
  readonly formats: Readonly<Record<string, FormatRow>>;
}

const FIXTURE = readFixture<FormatFixture>("texture-format-map.json");

const CORE_FORMATS: readonly TextureFormat[] = [
  "rgba8unorm",
  "rgba8unorm-srgb",
  "rgba16float",
  "rgba32float",
  "r8unorm",
  "rgb10a2unorm",
  "depth24plus",
  "depth32float",
  "depth24plus-stencil8",
];

function sortedFormats(formats: ReadonlySet<TextureFormat>): string[] {
  return [...formats].sort();
}

function sortedCore(): string[] {
  return [...CORE_FORMATS].sort();
}

describe("[ER-05-01] texture format map", () => {
  test("[ER-05-01] the device map equals the frozen 19-token fixture", () => {
    expect(TEXTURE_FORMATS).toEqual(Object.keys(FIXTURE.formats));
    expect(TEXTURE_FORMATS).toHaveLength(19);
    expect(WEBGL2_TEXTURE_FORMAT_MAP).toEqual(FIXTURE.formats);
    expect(Object.keys(WEBGL2_TEXTURE_FORMAT_MAP)).toEqual(Object.keys(FIXTURE.formats));
  });

  test("[ER-05-01] bgra8unorm is unsupported and never silently downcast", () => {
    expect(textureFormatEntry("bgra8unorm")).toEqual(FIXTURE.formats.bgra8unorm);
    expect(isTextureFormatToken("bgra8unorm")).toBe(true);
    expect(isTextureFormatToken("rgba8")).toBe(false);
    expect(
      errorCodeOf(() => assertTextureFormatSupported("bgra8unorm", ["sample"], new Set())),
    ).toBe("E_UNSUPPORTED_FEATURE");
  });

  test("[ER-05-01] no extensions expose exactly the nine core formats", () => {
    expect(sortedFormats(supportedTextureFormats(new Set()))).toEqual(sortedCore());
  });

  test("[ER-05-01] every texture extension exposes 18 sampling formats", () => {
    expect(TEXTURE_EXTENSION_NAMES).toEqual([
      EXT.s3tc,
      EXT.etc,
      EXT.astc,
      EXT.bptc,
      EXT.floatColorBuffer,
    ]);
    const supported = supportedTextureFormats(new Set(TEXTURE_EXTENSION_NAMES));
    expect(supported.size).toBe(18);
    expect(supported.has("bgra8unorm")).toBe(false);
    expect(supported.has("astc-6x6")).toBe(true);
  });

  test("[ER-05-01] each compressed family exposes only its own tokens", () => {
    expect(sortedFormats(supportedTextureFormats(new Set([EXT.astc])))).toHaveLength(12);
    expect(sortedFormats(supportedTextureFormats(new Set([EXT.s3tc])))).toHaveLength(12);
    expect(sortedFormats(supportedTextureFormats(new Set([EXT.etc])))).toHaveLength(11);
    expect(sortedFormats(supportedTextureFormats(new Set([EXT.bptc])))).toHaveLength(10);
    expect(sortedFormats(supportedTextureFormats(new Set([EXT.floatColorBuffer])))).toEqual(
      sortedCore(),
    );
  });

  test("[ER-05-01] compressed, depth and float classification matches the map", () => {
    for (const format of TEXTURE_FORMATS) {
      const row = FIXTURE.formats[format];
      expect(row).toBeDefined();
      expect(isCompressedFormat(format)).toBe(row?.status === "extension");
    }
    expect(isDepthFormat("depth24plus")).toBe(true);
    expect(isDepthFormat("depth32float")).toBe(true);
    expect(isDepthFormat("depth24plus-stencil8")).toBe(true);
    expect(isDepthFormat("rgba8unorm")).toBe(false);
    expect(isFloatFormat("rgba16float")).toBe(true);
    expect(isFloatFormat("rgba32float")).toBe(true);
    expect(isFloatFormat("rgb10a2unorm")).toBe(false);
  });
});

describe("[ER-05-01] format support and internalformat resolution", () => {
  test("[ER-05-01] a compressed format without its extension refuses", () => {
    expect(errorCodeOf(() => assertTextureFormatSupported("astc-6x6", ["sample"], new Set()))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(() =>
      assertTextureFormatSupported("astc-6x6", ["sample"], new Set([EXT.astc])),
    ).not.toThrow();
  });

  test("[ER-05-01] render-target float use requires EXT_color_buffer_float", () => {
    const usage: readonly TextureUsage[] = ["sample", "render-attachment"];
    expect(errorCodeOf(() => assertTextureFormatSupported("rgba16float", usage, new Set()))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(() =>
      assertTextureFormatSupported("rgba16float", usage, new Set([EXT.floatColorBuffer])),
    ).not.toThrow();
    expect(() => assertTextureFormatSupported("rgba16float", ["sample"], new Set())).not.toThrow();
  });

  test("[ER-05-01] core internalformats read from the context", () => {
    const { gl } = createFakeWebGL2();
    expect(resolveInternalFormat(gl, "rgba8unorm", {})).toBe(glConstant("RGBA8"));
    expect(resolveInternalFormat(gl, "rgba16float", {})).toBe(glConstant("RGBA16F"));
    expect(resolveInternalFormat(gl, "depth24plus", {})).toBe(
      glConstant("DEPTH_COMPONENT24"),
    );
    expect(resolveInternalFormat(gl, "depth24plus-stencil8", {})).toBe(
      glConstant("DEPTH24_STENCIL8"),
    );
  });

  test("[ER-05-01] extension internalformats read from the extension object", () => {
    const { gl } = createFakeWebGL2();
    expect(
      resolveInternalFormat(gl, "astc-4x4", {
        [EXT.astc]: { COMPRESSED_RGBA_ASTC_4x4_KHR: 0x93b0 },
      }),
    ).toBe(0x93b0);
    expect(
      errorCodeOf(() => resolveInternalFormat(gl, "s3tc-dxt1", {})),
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(
      errorCodeOf(() => resolveInternalFormat(gl, "bgra8unorm", {})),
    ).toBe("E_UNSUPPORTED_FEATURE");
  });
});

describe("[ER-05-01] conservative texture byte accounting", () => {
  test("[ER-05-01] levelBytes uses block layouts and clamped block counts", () => {
    expect(levelBytes("rgba8unorm", 2, 2)).toBe(16);
    expect(levelBytes("rgba16float", 8, 8)).toBe(512);
    expect(levelBytes("rgba32float", 3, 2)).toBe(96);
    expect(levelBytes("astc-6x6", 6, 6)).toBe(16);
    expect(levelBytes("astc-8x8", 17, 9)).toBe(96);
    expect(levelBytes("s3tc-dxt1", 1, 1)).toBe(8);
  });

  test("[ER-05-01] estimateTextureBytes rounds every texture up to 256 bytes", () => {
    expect(estimateTextureBytes("rgba8unorm", 1, 1)).toBe(256);
    expect(estimateTextureBytes("rgba8unorm", 2, 2)).toBe(256);
    expect(estimateTextureBytes("rgba8unorm", 16, 16)).toBe(1024);
    expect(estimateTextureBytes("rgba16float", 8, 8)).toBe(512);
    expect(estimateTextureBytes("astc-6x6", 6, 6)).toBe(256);
    expect(estimateTextureBytes("rgba32float", 3, 2)).toBe(256);
  });

  test("[ER-05-01] estimateTextureBytes accounts for layers and the whole mip chain", () => {
    expect(estimateTextureBytes("rgba8unorm", 2, 2, 1, 2)).toBe(256);
    expect(estimateTextureBytes("rgba8unorm", 4, 4, 2, 1)).toBe(256);
    expect(estimateTextureBytes("rgba8unorm", 4, 4, 1, 4)).toBe(256);
    expect(estimateTextureBytes("rgba8unorm", 64, 64, 1, 7)).toBe(22016);
  });
});

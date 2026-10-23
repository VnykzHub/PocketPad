/**
 * ABI 1 layout and uniform-packing tests (04 §4.2–§4.7, ER-04-17).
 *
 * Pure module coverage: no GPU, no browser, no fake device. The vertex-layout
 * fixture is contract data, not a measurement.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  FRAME_UNIFORM_BYTES,
  FRAME_UNIFORM_OFFSETS,
  INSTANCE_STRIDE_BYTES,
  LIGHT_UNIFORM_BYTES,
  LIGHT_UNIFORM_OFFSETS,
  OBJECT_UNIFORM_BYTES,
  OBJECT_UNIFORM_OFFSETS,
  OBJECT_UNIFORM_STRIDE,
  OBJECTS_PER_FRAME,
  VERTEX_LAYOUTS,
  VERTEX_STRIDE_BYTES,
  indexFormatForVertexCount,
  vertexByteLength,
  vertexLayoutDefinition,
  writeFrameUniforms,
  writeLightUniforms,
  writeNormalMatrix,
  writeObjectUniforms,
} from "../src/abi.js";
import type {
  FrameUniformInput,
  LightUniformInput,
} from "../src/abi.js";
import {
  mat4Create,
  mat4FromScale,
  mat4Identity,
} from "@lanpad/engine-core";
import type { Mat4, MeshDesc } from "@lanpad/engine-core";
import {
  LIT_FRAGMENT_ENTRY,
  LIT_UNLIT_FRAGMENT_ENTRY,
  LIT_WGSL,
} from "../src/shaders/lit.wgsl.js";

interface VertexFixtureAttribute {
  readonly name: string;
  readonly shaderLocation: number;
  readonly offset: number;
  readonly format: string;
}

interface VertexFixtureBuffer {
  readonly slot: number;
  readonly stepMode: string;
  readonly arrayStride: number;
  readonly attributes: readonly VertexFixtureAttribute[];
}

interface VertexFixtureLayout {
  readonly id: string;
  readonly baseLayout: string | null;
  readonly buffers: readonly VertexFixtureBuffer[];
}

interface VertexFixture {
  readonly formatVersion: number;
  readonly synthetic: boolean;
  readonly abiVersion: number;
  readonly indexFormatRule: {
    readonly uint16MaxVertices: number;
    readonly rule: string;
  };
  readonly layouts: readonly VertexFixtureLayout[];
}

const vertexFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/vertex-layouts.json", import.meta.url),
    "utf8",
  ),
) as VertexFixture;

function frameInput(): FrameUniformInput {
  const viewProjection = mat4Create();
  for (let index = 0; index < 16; index += 1) {
    viewProjection.m[index] = index + 1;
  }
  return {
    viewProjection,
    cameraX: 1.5,
    cameraY: -2.5,
    cameraZ: 3.5,
    timeSeconds: 2.25,
    deltaSeconds: 0.016,
    frameIndex: 42,
    exposure: 1.1,
    ambientRgb: [0.1, 0.2, 0.3],
    ambientIntensity: 0.75,
    width: 1920,
    height: 1080,
    fogRgb: [0.4, 0.5, 0.6],
    fogDensity: 0.02,
    near: 0.1,
    far: 500,
  };
}

function lightInput(): LightUniformInput {
  return {
    directionalCount: 1,
    pointCount: 0,
    cascadeCount: 0,
    flags: 0,
    directionX: 0.5,
    directionY: 0.25,
    directionZ: -0.75,
    colorR: 0.9,
    colorG: 0.8,
    colorB: 0.7,
    intensity: 3.5,
  };
}

describe("ABI 1 uniform blocks", () => {
  test("[ER-04-17] block sizes and byte offsets match the frozen ABI", () => {
    expect(FRAME_UNIFORM_BYTES).toBe(256);
    expect(LIGHT_UNIFORM_BYTES).toBe(2048);
    expect(OBJECT_UNIFORM_BYTES).toBe(256);
    expect(OBJECT_UNIFORM_STRIDE).toBe(256);
    expect(OBJECTS_PER_FRAME).toBe(8192);
    expect(VERTEX_STRIDE_BYTES).toBe(32);
    expect(INSTANCE_STRIDE_BYTES).toBe(64);

    expect(FRAME_UNIFORM_OFFSETS).toEqual({
      viewProjection: 0,
      cameraPosition: 64,
      time: 80,
      ambient: 96,
      resolution: 112,
      fog: 128,
      clip: 144,
      reserved: 160,
    });
    expect(LIGHT_UNIFORM_OFFSETS).toEqual({
      counts: 0,
      directional: 16,
      cascadeMatrices: 144,
      cascadeSplits: 336,
      point: 352,
      shadowAtlas: 1376,
      reserved: 1392,
    });
    expect(OBJECT_UNIFORM_OFFSETS).toEqual({
      model: 0,
      normalMatrixColumns: 64,
      tint: 112,
      reserved: 128,
    });
  });

  test("[ER-04-17] frame uniforms write every field at its offset and zero reserved bytes", () => {
    const out = new Float32Array(FRAME_UNIFORM_BYTES / 4);
    out.fill(Number.NaN);
    writeFrameUniforms(out, frameInput());

    expect(Array.from(out.slice(0, 16))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    expect(out[16]).toBe(1.5);
    expect(out[17]).toBe(-2.5);
    expect(out[18]).toBe(3.5);
    expect(out[19]).toBe(1);
    expect(out[20]).toBe(2.25);
    expect(out[21]).toBeCloseTo(0.016, 6);
    expect(out[22]).toBe(42);
    expect(out[23]).toBeCloseTo(1.1, 6);
    expect(out[24]).toBeCloseTo(0.1, 6);
    expect(out[25]).toBeCloseTo(0.2, 6);
    expect(out[26]).toBeCloseTo(0.3, 6);
    expect(out[27]).toBe(0.75);
    expect(out[28]).toBe(1920);
    expect(out[29]).toBe(1080);
    expect(out[30]).toBeCloseTo(1 / 1920, 6);
    expect(out[31]).toBeCloseTo(1 / 1080, 6);
    expect(out[32]).toBeCloseTo(0.4, 6);
    expect(out[33]).toBeCloseTo(0.5, 6);
    expect(out[34]).toBeCloseTo(0.6, 6);
    expect(out[35]).toBeCloseTo(0.02, 6);
    expect(out[36]).toBeCloseTo(0.1, 6);
    expect(out[37]).toBe(500);
    expect(out[38]).toBeCloseTo(1 / (500 - 0.1), 6);
    expect(out[39]).toBe(0);
    for (let index = 40; index < out.length; index += 1) {
      expect(out[index]).toBe(0);
    }
  });

  test("[ER-04-17] light uniforms write counts as uints and one directional light", () => {
    const floats = new Float32Array(LIGHT_UNIFORM_BYTES / 4);
    const uints = new Uint32Array(floats.buffer);
    floats.fill(Number.NaN);
    writeLightUniforms(floats, uints, lightInput());

    expect(Array.from(uints.slice(0, 4))).toEqual([1, 0, 0, 0]);
    expect(floats[4]).toBe(0.5);
    expect(floats[5]).toBe(0.25);
    expect(floats[6]).toBe(-0.75);
    expect(floats[7]).toBe(0);
    expect(floats[8]).toBeCloseTo(0.9, 6);
    expect(floats[9]).toBeCloseTo(0.8, 6);
    expect(floats[10]).toBeCloseTo(0.7, 6);
    expect(floats[11]).toBe(3.5);
    for (let index = 12; index < floats.length; index += 1) {
      expect(floats[index]).toBe(0);
    }
  });

  test("[ER-04-17] object uniforms write model, padded normal columns and tint", () => {
    const out = new Float32Array(OBJECT_UNIFORM_BYTES / 4);
    out.fill(Number.NaN);
    const model = mat4Create();
    for (let index = 0; index < 16; index += 1) {
      model.m[index] = index + 1;
    }
    const normal = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    writeObjectUniforms(out, model, normal, 0.25, 0.5, 0.75, 1);

    for (let index = 0; index < 16; index += 1) {
      expect(out[index]).toBe(index + 1);
    }
    expect(Array.from(out.slice(16, 28))).toEqual([
      1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0,
    ]);
    expect(Array.from(out.slice(28, 32))).toEqual([0.25, 0.5, 0.75, 1]);
    for (let index = 32; index < out.length; index += 1) {
      expect(out[index]).toBe(0);
    }
  });

  test("[ER-04-17] normal matrix is the transpose of the inverse model matrix", () => {
    const model = mat4Create();
    model.m[0] = 1;
    model.m[1] = 3;
    model.m[4] = 2;
    model.m[5] = 4;
    model.m[10] = 1;
    model.m[15] = 1;
    const out = new Float32Array(9);
    expect(writeNormalMatrix(out, model)).toBe(true);
    const expected = [-2, 1, 0, 1.5, -0.5, 0, 0, 0, 1];
    expected.forEach((value, index) => {
      expect(out[index]).toBeCloseTo(value, 6);
    });
  });

  test("[ER-04-17] a singular model falls back to an identity normal matrix", () => {
    const model = mat4Create();
    mat4Identity(model);
    model.m[0] = 0;
    model.m[5] = 0;
    const out = new Float32Array(9).fill(Number.NaN);
    expect(writeNormalMatrix(out, model)).toBe(false);
    expect(Array.from(out)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  test("[ER-04-17] non-uniform scale inverts per axis", () => {
    const model = mat4FromScale(mat4Create(), { x: 2, y: 4, z: 8 });
    const out = new Float32Array(9);
    expect(writeNormalMatrix(out, model)).toBe(true);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(out[4]).toBeCloseTo(0.25, 6);
    expect(out[8]).toBeCloseTo(0.125, 6);
  });
});

describe("ABI 1 vertex layouts", () => {
  test("[ER-04-17] static and instanced layouts match the contract fixture", () => {
    expect(vertexFixture.formatVersion).toBe(1);
    expect(vertexFixture.synthetic).toBe(true);
    expect(vertexFixture.abiVersion).toBe(1);
    expect(VERTEX_LAYOUTS).toEqual(vertexFixture.layouts);
  });

  test("[ER-04-17] the instanced layout adds four model columns at stride 64", () => {
    const instanced = vertexLayoutDefinition("instanced-transform-v1");
    expect(instanced).toBeDefined();
    expect(instanced?.buffers).toHaveLength(2);
    const slot = instanced?.buffers[1];
    expect(slot?.slot).toBe(1);
    expect(slot?.stepMode).toBe("instance");
    expect(slot?.arrayStride).toBe(64);
    expect(slot?.attributes.map((attribute) => attribute.shaderLocation)).toEqual(
      [3, 4, 5, 6],
    );
    expect(slot?.attributes.map((attribute) => attribute.offset)).toEqual([
      0, 16, 32, 48,
    ]);
  });

  test("[ER-04-17] index format switches from uint16 to uint32 above 65,535 vertices", () => {
    expect(vertexFixture.indexFormatRule.uint16MaxVertices).toBe(65_535);
    expect(indexFormatForVertexCount(0)).toBe("uint16");
    expect(indexFormatForVertexCount(65_535)).toBe("uint16");
    expect(indexFormatForVertexCount(65_536)).toBe("uint32");
    expect(indexFormatForVertexCount(1_000_000)).toBe("uint32");
  });

  test("[ER-04-17] vertexByteLength is 32 bytes per ABI 1 vertex", () => {
    const layouts: MeshDesc["layout"][] = [
      "static-pbr-v1",
      "instanced-transform-v1",
    ];
    expect(vertexByteLength(0)).toBe(0);
    expect(vertexByteLength(1)).toBe(32);
    expect(vertexByteLength(3)).toBe(96);
    for (const layout of layouts) {
      expect(vertexLayoutDefinition(layout)?.buffers[0]?.arrayStride).toBe(
        VERTEX_STRIDE_BYTES,
      );
    }
  });

  test("[ER-04-17] an unknown layout has no definition", () => {
    const unknown = "terrain-pbr-v9" as unknown as MeshDesc["layout"];
    expect(vertexLayoutDefinition(unknown)).toBeUndefined();
  });

  test("[ER-04-17] frame uniform writes clear the whole destination before packing", () => {
    const out = new Float32Array(FRAME_UNIFORM_BYTES / 4 + 8);
    out.fill(Number.NaN);
    writeFrameUniforms(out, frameInput());
    for (let index = FRAME_UNIFORM_BYTES / 4; index < out.length; index += 1) {
      expect(out[index]).toBe(0);
    }
  });

  test("[ER-04-17] a singular matrix still writes all 64 object floats", () => {
    const out = new Float32Array(64).fill(Number.NaN);
    const model = mat4Create();
    mat4Identity(model);
    model.m[0] = 0;
    model.m[5] = 0;
    const normal = new Float32Array(9);
    expect(writeNormalMatrix(normal, model)).toBe(false);
    writeObjectUniforms(out, model, normal, 1, 1, 1, 1);
    expect(out.some((value) => Number.isNaN(value))).toBe(false);
    expect(out[16]).toBe(1);
    expect(out[21]).toBe(1);
    expect(out[26]).toBe(1);
  });
});

function diagonalScaleMatrix(x: number, y: number, z: number): Mat4 {
  return mat4FromScale(mat4Create(), { x, y, z });
}

describe("ABI 1 matrix scratch reuse", () => {
  test("[ER-04-17] repeated normal-matrix writes are independent", () => {
    const out = new Float32Array(9);
    expect(writeNormalMatrix(out, diagonalScaleMatrix(2, 2, 2))).toBe(true);
    expect(out[0]).toBeCloseTo(0.5, 6);
    expect(writeNormalMatrix(out, diagonalScaleMatrix(4, 4, 4))).toBe(true);
    expect(out[0]).toBeCloseTo(0.25, 6);
    expect(out[4]).toBeCloseTo(0.25, 6);
    expect(out[8]).toBeCloseTo(0.25, 6);
  });
});

/**
 * RV-76: Chrome exposes no sRGB canvas format. Probing `bgra8unorm-srgb` and
 * `rgba8unorm-srgb` on 2026-10-23 both threw "Unsupported canvas context
 * format", and `getPreferredCanvasFormat()` returns `bgra8unorm`. The swapchain
 * therefore stores what the built-in fragment shader writes, so the shader is
 * the one place linear light is encoded. sRGB base-colour textures use
 * `rgba8unorm-srgb` and the sampler decodes them; never decode again.
 */
describe("sRGB output encoding (RV-76)", () => {
  function fragmentBody(entry: string, nextMarker: string): string {
    const start = LIT_WGSL.indexOf(`fn ${entry}`);
    const end = nextMarker === "" ? LIT_WGSL.length : LIT_WGSL.indexOf(nextMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return LIT_WGSL.slice(start, end);
  }

  test("[ER-04-09] the non-sRGB fallback encodes linear light once in each fragment path", () => {
    const lit = fragmentBody(LIT_FRAGMENT_ENTRY, "// Opaque unlit path");
    const unlit = fragmentBody(LIT_UNLIT_FRAGMENT_ENTRY, "");
    for (const body of [lit, unlit]) {
      expect(body.match(/encodeSrgb\(/g)).toHaveLength(1);
      expect(body).not.toContain("12.92");
      expect(body).not.toContain("pow(");
    }
    expect(lit).toContain("return vec4<f32>(encodeSrgb(lit), 1.0);");
    expect(unlit).toContain(
      "return vec4<f32>(encodeSrgb(baseTexture.rgb * object.tint.rgb), 1.0);",
    );
  });

  test("[ER-04-09] the encode uses the IEC 61966-2-1 sRGB transfer function", () => {
    expect(LIT_WGSL).toContain("fn encodeSrgb(value: vec3<f32>) -> vec3<f32>");
    expect(LIT_WGSL).toContain("let linear = max(value, vec3<f32>(0.0));");
    expect(LIT_WGSL).toContain("let low = linear * 12.92;");
    expect(LIT_WGSL).toContain(
      "let high = 1.055 * pow(linear, vec3<f32>(1.0 / 2.4)) - 0.055;",
    );
    expect(LIT_WGSL).toContain("linear <= vec3<f32>(0.0031308)");
    expect(LIT_WGSL).toContain("return select(high, low,");
  });

  test("[ER-04-11] sRGB textures are sampler-decoded and encoded only at output", () => {
    expect(LIT_WGSL).toContain("var baseColorTexture: texture_2d<f32>;");
    expect(LIT_WGSL).toContain(
      "let baseTexture = textureSample(baseColorTexture, baseColorSampler, input.uv);",
    );
    expect(LIT_WGSL).not.toMatch(/srgbToLinear|linearToSrgb|decodeSrgb/);
    expect(LIT_WGSL.match(/encodeSrgb\(/g)).toHaveLength(3);
  });
});

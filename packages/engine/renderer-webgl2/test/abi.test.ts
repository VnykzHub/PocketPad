/**
 * ER-05-01: renderer ABI 1 parity (05 §4.3). The fixture is the checked-in
 * mirror of the canonical layout table; these tests prove the layout validator
 * and mesh-descriptor refusals, not GL output.
 */

import { describe, expect, test } from "vitest";
import type { MeshDesc } from "@lanpad/engine-core";
import {
  ABI_INSTANCE_STRIDE,
  ABI_LAYOUTS,
  ABI_MAX_INSTANCE_CAPACITY,
  ABI_VERTEX_STRIDE,
  abiLayout,
  normalizeMeshDesc,
  validateVertexAttributeSet,
  type AbiAttribute,
} from "../src/mesh.js";
import { errorCodeOf, readFixture, triangleMesh } from "./helpers.js";
import {
  FORWARD_DEFINES,
  forwardLitFragmentSource,
} from "../src/shaders/forwardLit.js";
import { WEBGL2_TEXTURE_FORMAT_MAP } from "../src/texture.js";

interface AbiFixtureCase {
  readonly id: string;
  readonly layout?: string;
  readonly baseLayout?: string;
  readonly extraAttribute?: {
    readonly offset: number;
    readonly shaderLocation: number;
    readonly name: string;
    readonly format: string;
  };
  readonly expected: {
    readonly result: "accept" | "reject";
    readonly code?: string;
  };
}

interface AbiFixture {
  readonly schema: string;
  readonly layouts: Readonly<Record<string, unknown>>;
  readonly cases: readonly AbiFixtureCase[];
}

const FIXTURE = readFixture<AbiFixture>("abi-parity.json");
const BOUNDS = { center: { x: 0, y: 0, z: 0 }, radius: 1 } as const;

describe("[ER-05-01] renderer ABI 1 layouts", () => {
  test("[ER-05-01] the frozen ABI table equals the parity fixture", () => {
    expect(ABI_LAYOUTS).toEqual(FIXTURE.layouts);
    expect(ABI_VERTEX_STRIDE).toBe(32);
    expect(ABI_INSTANCE_STRIDE).toBe(64);
    expect(ABI_MAX_INSTANCE_CAPACITY).toBe(16384);
  });

  for (const fixtureCase of FIXTURE.cases) {
    test(`[ER-05-01] ABI parity fixture ${fixtureCase.id} is ${fixtureCase.expected.result}`, () => {
      if (fixtureCase.expected.result === "accept") {
        const layoutId = fixtureCase.layout ?? fixtureCase.baseLayout ?? "";
        const layout = abiLayout(layoutId);
        const attributes = layout.buffers[0]?.attributes ?? [];
        expect(() => validateVertexAttributeSet(layoutId, attributes)).not.toThrow();
        return;
      }
      if (fixtureCase.layout !== undefined) {
        expect(errorCodeOf(() => abiLayout(fixtureCase.layout ?? ""))).toBe(
          fixtureCase.expected.code,
        );
        return;
      }
      const baseLayoutId = fixtureCase.baseLayout ?? "";
      const layout = abiLayout(baseLayoutId);
      const extra = fixtureCase.extraAttribute;
      expect(extra).toBeDefined();
      const attributes = [
        ...(layout.buffers[0]?.attributes ?? []),
        extra as unknown as AbiAttribute,
      ];
      expect(errorCodeOf(() => validateVertexAttributeSet(baseLayoutId, attributes))).toBe(
        fixtureCase.expected.code,
      );
    });
  }

  test("[ER-05-01] a moved vertex attribute rejects at creation", () => {
    const layout = abiLayout("static-pbr-v1");
    const attributes = (layout.buffers[0]?.attributes ?? []).map((attribute, index) =>
      index === 1 ? { ...attribute, offset: 16 } : attribute,
    );
    expect(errorCodeOf(() => validateVertexAttributeSet("static-pbr-v1", attributes))).toBe(
      "E_CONTRACT",
    );
  });
});

describe("[ER-05-01] mesh descriptor normalization", () => {
  test("[ER-05-01] both ABI layouts normalize with exact counts", () => {
    const staticMesh = normalizeMeshDesc(triangleMesh("static-pbr-v1"));
    expect(staticMesh.layout).toBe("static-pbr-v1");
    expect(staticMesh.vertexCount).toBe(3);
    expect(staticMesh.indexCount).toBe(3);
    expect(staticMesh.indexType).toBe("uint16");

    const instanced = normalizeMeshDesc(triangleMesh("instanced-transform-v1"));
    expect(instanced.layout).toBe("instanced-transform-v1");
    expect(instanced.vertexCount).toBe(3);
  });

  test("[ER-05-01] a skinned or unknown layout rejects at creation", () => {
    const skinned = {
      ...triangleMesh(),
      layout: "skinned-pbr-v1",
    } as unknown as MeshDesc;
    expect(errorCodeOf(() => normalizeMeshDesc(skinned))).toBe("E_CONTRACT");
  });

  test("[ER-05-01] a non-triangle topology rejects at creation", () => {
    const strip = {
      ...triangleMesh(),
      topology: "triangle-strip",
    } as unknown as MeshDesc;
    expect(errorCodeOf(() => normalizeMeshDesc(strip))).toBe("E_CONTRACT");
  });

  test("[ER-05-01] ABI 1 requires exactly one vertex buffer", () => {
    const twoBuffers: MeshDesc = {
      ...triangleMesh(),
      vertices: [new Float32Array(24), new Float32Array(24)],
    };
    expect(errorCodeOf(() => normalizeMeshDesc(twoBuffers))).toBe("E_CONTRACT");
  });

  test("[ER-05-01] an empty or misaligned vertex buffer rejects", () => {
    const empty: MeshDesc = { ...triangleMesh(), vertices: [new Float32Array(0)] };
    expect(errorCodeOf(() => normalizeMeshDesc(empty))).toBe("E_CONTRACT");

    const unaligned = new Uint8Array(new ArrayBuffer(128), 2, 96);
    const misaligned: MeshDesc = { ...triangleMesh(), vertices: [unaligned] };
    expect(errorCodeOf(() => normalizeMeshDesc(misaligned))).toBe("E_CONTRACT");
  });

  test("[ER-05-01] a partial vertex stride rejects", () => {
    const partial: MeshDesc = { ...triangleMesh(), vertices: [new Float32Array(12)] };
    expect(errorCodeOf(() => normalizeMeshDesc(partial))).toBe("E_CONTRACT");
  });

  test("[ER-05-01] index data and declared format must agree", () => {
    const mismatch: MeshDesc = {
      ...triangleMesh(),
      indices: { data: new Uint32Array([0, 1, 2]), format: "uint16" },
    };
    expect(errorCodeOf(() => normalizeMeshDesc(mismatch))).toBe("E_CONTRACT");
  });

  test("[ER-05-01] index and vertex counts must complete whole triangles", () => {
    const fourIndices: MeshDesc = {
      ...triangleMesh(),
      indices: { data: new Uint16Array([0, 1, 2, 0]), format: "uint16" },
    };
    expect(errorCodeOf(() => normalizeMeshDesc(fourIndices))).toBe("E_CONTRACT");

    const twoVertices: MeshDesc = {
      label: "two",
      layout: "static-pbr-v1",
      vertices: [new Float32Array(16)],
      bounds: BOUNDS,
    };
    expect(errorCodeOf(() => normalizeMeshDesc(twoVertices))).toBe("E_CONTRACT");
  });

  test("[ER-05-01] bounds must be a finite non-negative sphere", () => {
    const negative: MeshDesc = {
      ...triangleMesh(),
      bounds: { center: { x: 0, y: 0, z: 0 }, radius: -1 },
    };
    expect(errorCodeOf(() => normalizeMeshDesc(negative))).toBe("E_CONTRACT");

    const infinite: MeshDesc = {
      ...triangleMesh(),
      bounds: { center: { x: Number.NaN, y: 0, z: 0 }, radius: 1 },
    };
    expect(errorCodeOf(() => normalizeMeshDesc(infinite))).toBe("E_CONTRACT");
  });

  test("[ER-05-01] a non-string label rejects", () => {
    const badLabel = {
      ...triangleMesh(),
      label: 42,
    } as unknown as MeshDesc;
    expect(errorCodeOf(() => normalizeMeshDesc(badLabel))).toBe("E_CONTRACT");
  });

  test("[ER-05-01] uint16 indices refuse more than 65535 vertices", () => {
    const vertexCount = 65_536 + 3;
    const huge: MeshDesc = {
      label: "huge",
      layout: "static-pbr-v1",
      vertices: [new Float32Array(vertexCount * 8)],
      indices: { data: new Uint16Array([0, 1, 2]), format: "uint16" },
      bounds: BOUNDS,
    };
    expect(errorCodeOf(() => normalizeMeshDesc(huge))).toBe("E_CONTRACT");
  });
});

/**
 * RV-76: the WebGL2 default framebuffer is not sRGB. Measured on 2026-10-23:
 * clearing and drawing 0.5 both read back 127, and `EXT_sRGB_write_control` is
 * absent. The fragment shader is therefore the one place linear light is
 * encoded. `rgba8unorm-srgb` textures map to `SRGB8_ALPHA8` and the sampler
 * decodes them; never decode again in the shader.
 */
describe("sRGB output encoding (RV-76)", () => {
  test("[ER-05-01] the non-sRGB fallback encodes linear light once in each output path", () => {
    const lit = forwardLitFragmentSource(0);
    const unlit = forwardLitFragmentSource(FORWARD_DEFINES.UNLIT);
    for (const source of [lit, unlit]) {
      // Both preprocessor branches are present in the source; exactly one is
      // compiled per variant, so the encode call count includes both branches.
      expect(source.match(/encodeSrgb\(/g)).toHaveLength(3);
      expect(source).not.toMatch(/srgbToLinear|linearToSrgb|decodeSrgb/);
      expect(source.match(/outColor = vec4\(encodeSrgb\(/g)).toHaveLength(2);
    }
    expect(lit).toContain("outColor = vec4(encodeSrgb(lit), baseColor.a);");
    expect(unlit).toContain(
      "outColor = vec4(encodeSrgb(baseColor.rgb), baseColor.a);",
    );
  });

  test("[ER-05-01] the encode uses the IEC 61966-2-1 sRGB transfer function", () => {
    const source = forwardLitFragmentSource(0);
    expect(source).toContain("vec3 encodeSrgb(vec3 value)");
    expect(source).toContain("vec3 linear = max(value, vec3(0.0));");
    expect(source).toContain("vec3 low = linear * 12.92;");
    expect(source).toContain(
      "vec3 high = 1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055;",
    );
    expect(source).toContain("lessThanEqual(linear, vec3(0.0031308))");
  });

  test("[ER-05-01] sRGB base textures use hardware decoding, not a second shader decode", () => {
    expect(WEBGL2_TEXTURE_FORMAT_MAP["rgba8unorm-srgb"]?.internalFormat).toBe(
      "SRGB8_ALPHA8",
    );
    expect(forwardLitFragmentSource(0)).toContain(
      "vec4 baseColor = texture(uBaseColorTexture, vUv) * uBaseColorFactor;",
    );
  });
});

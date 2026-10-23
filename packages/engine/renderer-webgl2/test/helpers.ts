/** Shared Node-test helpers: fixture loading, matrices and error codes. */

import { readFileSync } from "node:fs";
import type { Mat4, MaterialDesc, MeshDesc, TextureDesc } from "@lanpad/engine-core";

/** Reads a synthetic fixture from `test/fixtures` (no network, no dates). */
export function readFixture<T>(name: string): T {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

export function identity(): Mat4 {
  return {
    m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  };
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return { m };
}

/** A three-vertex triangle mesh in one of the two ABI-1 layouts. */
export function triangleMesh(layout: MeshDesc["layout"] = "static-pbr-v1"): MeshDesc {
  return {
    label: "triangle",
    layout,
    vertices: [new Float32Array(24)],
    indices: { data: new Uint16Array([0, 1, 2]), format: "uint16" },
    bounds: { center: { x: 0, y: 0, z: 0 }, radius: 1 },
  };
}

/** Minimal valid material; overrides let a test reach one refusal branch. */
export function materialDesc(overrides: Partial<MaterialDesc> = {}): MaterialDesc {
  return {
    label: "material",
    baseColorFactor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.5,
    emissiveFactor: [0, 0, 0],
    ...overrides,
  };
}

/** 2x2 RGBA8 texture with a tight row; overrides may make it invalid. */
export function textureDesc(overrides: Partial<TextureDesc> = {}): TextureDesc {
  return {
    label: "texture",
    width: 2,
    height: 2,
    format: "rgba8unorm",
    usage: ["sample"],
    data: [
      {
        mipLevel: 0,
        layer: 0,
        bytes: new Uint8Array(16),
        bytesPerRow: 8,
      },
    ],
    sampler: {
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressU: "clamp-to-edge",
      addressV: "clamp-to-edge",
    },
    ...overrides,
  };
}

/** Column-major instance matrices, one 16-float block per position. */
export function instanceTransforms(
  positions: ReadonlyArray<{ readonly x: number; readonly y: number; readonly z: number }>,
): Float32Array {
  const out = new Float32Array(positions.length * 16);
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index];
    if (position === undefined) continue;
    const base = index * 16;
    out[base] = 1;
    out[base + 5] = 1;
    out[base + 10] = 1;
    out[base + 12] = position.x;
    out[base + 13] = position.y;
    out[base + 14] = position.z;
    out[base + 15] = 1;
  }
  return out;
}

/** Runs a throwing call and returns its `EngineError.code`, failing otherwise. */
export function errorCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      return String((error as { readonly code: unknown }).code);
    }
    throw error;
  }
  throw new Error("Expected the call to throw an EngineError, but it returned.");
}

/** Awaits a rejecting call and returns its `EngineError.code`. */
export async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      return String((error as { readonly code: unknown }).code);
    }
    throw error;
  }
  throw new Error("Expected the promise to reject with an EngineError, but it resolved.");
}

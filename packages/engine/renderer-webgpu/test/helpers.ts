/**
 * Shared test fixtures for the WebGPU backend (04 §8).
 *
 * These helpers build synthetic descriptors and a fake-GPU-backed device.
 * They never touch a real adapter: every assertion that uses them is
 * Node-only evidence.
 */

import { mat4Create, mat4OrthographicWebGPU } from "@lanpad/engine-core";
import type {
  Mat4,
  MaterialDesc,
  MeshDesc,
  Vec3,
} from "@lanpad/engine-core";
import type { WebGpuDeviceOptions } from "../src/contracts/webgpu.js";
import { WebGpuRendererDevice } from "../src/device/WebGpuDevice.js";
import { WebGpuRendererError } from "../src/errors.js";
import { canvasSurface, createHarness } from "./fakes/webgpu.js";
import type { Harness } from "./fakes/webgpu.js";

export interface Initialized {
  readonly harness: Harness;
  readonly device: WebGpuRendererDevice;
}

/** Initializes a device against the fake GPU at a deterministic CSS size. */
export async function initialized(
  options?: WebGpuDeviceOptions,
  cssWidth = 64,
  cssHeight = 36,
): Promise<Initialized> {
  const harness = createHarness(options);
  const device = new WebGpuRendererDevice(harness.dependencies);
  await device.init(canvasSurface(harness.canvas, cssWidth, cssHeight), options);
  return { harness, device };
}

/** A static mesh with one 32-byte vertex and one triangle. */
export function staticMeshDesc(overrides: Partial<MeshDesc> = {}): MeshDesc {
  return {
    label: "test-mesh",
    layout: "static-pbr-v1",
    vertices: [new Uint8Array(3 * 32)],
    indices: { data: new Uint16Array([0, 1, 2]), format: "uint16" },
    bounds: { center: { x: 0, y: 0, z: 0 }, radius: 1 },
    ...overrides,
  };
}

/** The same geometry with the instanced-transform vertex layout. */
export function instancedMeshDesc(overrides: Partial<MeshDesc> = {}): MeshDesc {
  return staticMeshDesc({
    label: "test-instanced-mesh",
    layout: "instanced-transform-v1",
    ...overrides,
  });
}

export function materialDesc(
  overrides: Partial<MaterialDesc> = {},
): MaterialDesc {
  return {
    label: "test-material",
    baseColorFactor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.5,
    emissiveFactor: [0, 0, 0],
    ...overrides,
  };
}

export const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The fixture orthographic projection from 04 §8:
 * x in [-10, 10], y in [-10, 10], near 1, far 100, WebGPU depth range.
 */
export function orthoProjection(): Mat4 {
  return mat4OrthographicWebGPU(mat4Create(), -10, 10, -10, 10, 1, 100);
}

/** Column-major translation matrix. */
export function translation(x: number, y: number, z: number): Mat4 {
  const matrix = mat4Create();
  matrix.m[0] = 1;
  matrix.m[5] = 1;
  matrix.m[10] = 1;
  matrix.m[15] = 1;
  matrix.m[12] = x;
  matrix.m[13] = y;
  matrix.m[14] = z;
  return matrix;
}

/** Packs translation-only model matrices into the instance-buffer layout. */
export function instanceTransforms(
  points: readonly (readonly [number, number, number])[],
): Float32Array {
  const out = new Float32Array(points.length * 16);
  points.forEach((point, index) => {
    const base = index * 16;
    out[base] = 1;
    out[base + 5] = 1;
    out[base + 10] = 1;
    out[base + 15] = 1;
    out[base + 12] = point[0];
    out[base + 13] = point[1];
    out[base + 14] = point[2];
  });
  return out;
}

/** The log of the first render pass in the most recent encoder. */
export function currentPassLog(harness: Harness): readonly string[] {
  const encoder = harness.device.encoders[harness.device.encoders.length - 1];
  return encoder?.passes[0]?.log ?? [];
}

export function errorOf(action: () => unknown): WebGpuRendererError {
  try {
    action();
  } catch (error) {
    if (error instanceof WebGpuRendererError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a WebGpuRendererError");
}

export async function errorOfAsync(
  promise: Promise<unknown>,
): Promise<WebGpuRendererError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WebGpuRendererError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a rejected WebGpuRendererError");
}

/**
 * Resource lifecycle tests (04 §5.3–§5.9, ER-04-04).
 *
 * Every test runs against the hand-written fake GPU: no browser, no real
 * device. Handle stores, byte counters, validation-before-GPU-call and the
 * idempotent dispose path are exercised here.
 */

import { describe, expect, test } from "vitest";
import type {
  MaterialDesc,
  MeshDesc,
  SamplerDesc,
  ShaderModuleDesc,
  TextureDesc,
} from "@lanpad/engine-core";
import { WebGpuRendererDevice } from "../src/device/WebGpuDevice.js";
import { WebGpuRendererError } from "../src/errors.js";
import type { WebGpuDeviceOptions } from "../src/contracts/webgpu.js";
import {
  canvasSurface,
  createHarness,
} from "./fakes/webgpu.js";
import type {
  FakeDevice,
  FakeDeviceCounts,
  Harness,
} from "./fakes/webgpu.js";

interface Initialized {
  readonly harness: Harness;
  readonly device: WebGpuRendererDevice;
}

async function initialized(options?: WebGpuDeviceOptions): Promise<Initialized> {
  const harness = createHarness(options);
  const device = new WebGpuRendererDevice(harness.dependencies);
  await device.init(canvasSurface(harness.canvas, 1, 1), options);
  return { harness, device };
}

function snapshot(device: FakeDevice): FakeDeviceCounts {
  return { ...device.counts };
}

function errorOf(action: () => unknown): WebGpuRendererError {
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

function vertexShaderDesc(index = 0): ShaderModuleDesc {
  return {
    label: `vertex-shader-${index}`,
    stage: "vertex",
    language: "wgsl",
    code: `@vertex fn vs_${index}() -> @builtin(position) vec4f { return vec4f(0); }`,
    entryPoint: `vs_${index}`,
    abiVersion: 1,
  };
}

function fragmentShaderDesc(index = 0): ShaderModuleDesc {
  return {
    label: `fragment-shader-${index}`,
    stage: "fragment",
    language: "wgsl",
    code: `@fragment fn fs_${index}() -> @location(0) vec4f { return vec4f(1); }`,
    entryPoint: `fs_${index}`,
    abiVersion: 1,
  };
}

function textureDesc(overrides: Partial<TextureDesc> = {}): TextureDesc {
  return {
    label: "test-texture",
    width: 1,
    height: 1,
    format: "rgba8unorm-srgb",
    usage: ["sample", "copy-dst"],
    data: [
      {
        mipLevel: 0,
        layer: 0,
        bytes: new Uint8Array([255, 255, 255, 255]),
        bytesPerRow: 4,
      },
    ],
    ...overrides,
  };
}

function samplerDesc(overrides: Partial<SamplerDesc> = {}): SamplerDesc {
  return {
    label: "test-sampler",
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressU: "clamp-to-edge",
    addressV: "clamp-to-edge",
    maxAnisotropy: 1,
    ...overrides,
  };
}

function bufferDesc(size = 16): Record<string, unknown> {
  return {
    label: "test-buffer",
    size,
    usage: ["uniform", "copy-dst"],
    data: new Uint8Array(size),
  };
}

function meshDesc(overrides: Partial<MeshDesc> = {}): MeshDesc {
  return {
    label: "test-mesh",
    layout: "static-pbr-v1",
    vertices: [new Uint8Array(3 * 32)],
    indices: { data: new Uint16Array([0, 1, 2]), format: "uint16" },
    bounds: { center: { x: 0, y: 0, z: 0 }, radius: 1 },
    ...overrides,
  };
}

function materialDesc(overrides: Partial<MaterialDesc> = {}): MaterialDesc {
  return {
    label: "test-material",
    baseColorFactor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.5,
    emissiveFactor: [0, 0, 0],
    ...overrides,
  };
}

function pipelineDesc(
  vertexShader: ReturnType<WebGpuRendererDevice["createShaderModule"]>,
  fragmentShader: ReturnType<WebGpuRendererDevice["createShaderModule"]>,
): Record<string, unknown> {
  return {
    label: "test-pipeline",
    layoutId: "builtin-pbr-v1",
    vertexShader,
    fragmentShader,
    vertexLayout: "static-pbr-v1",
    colorFormats: ["bgra8unorm"],
    blendStates: ["off"],
  };
}

describe("resource lifecycle", () => {
  test("[ER-04-04] every M0 handle kind can be created and destroyed", async () => {
    const { harness, device } = await initialized();
    const baselineBytes = {
      texture: device.stats.textureBytes,
      buffer: device.stats.bufferBytes,
    };
    const vertex = device.createShaderModule(vertexShaderDesc());
    const fragment = device.createShaderModule(fragmentShaderDesc());
    const pipeline = device.createPipeline(
      pipelineDesc(vertex, fragment),
    );
    const texture = device.createTexture(textureDesc());
    const sampler = device.createSampler(samplerDesc());
    const buffer = device.createBuffer(bufferDesc());
    const mesh = device.createMesh(meshDesc());
    const material = device.createMaterial(materialDesc());
    expect(device.stats.textureBytes).toBeGreaterThan(baselineBytes.texture);
    expect(device.stats.bufferBytes).toBeGreaterThan(baselineBytes.buffer);

    for (const handle of [
      material,
      mesh,
      buffer,
      sampler,
      texture,
      pipeline,
      fragment,
      vertex,
    ]) {
      device.destroy(handle);
    }
    expect(device.stats.textureBytes).toBe(baselineBytes.texture);
    expect(device.stats.bufferBytes).toBe(baselineBytes.buffer);
    expect(harness.device.counts.destroy).toBe(0);
  });

  test("[ER-04-04] texture and buffer byte counters return to baseline", async () => {
    const { device } = await initialized();
    const baseTexture = device.stats.textureBytes;
    const baseBuffer = device.stats.bufferBytes;
    const texture = device.createTexture(textureDesc());
    const buffer = device.createBuffer(bufferDesc(64));
    const mesh = device.createMesh(meshDesc());
    // 1x1 RGBA8 rows align to 256 bytes; the mesh owns 96 vertex bytes and
    // 8 aligned index bytes.
    expect(device.stats.textureBytes).toBe(baseTexture + 256);
    expect(device.stats.bufferBytes).toBe(baseBuffer + 64 + 96 + 8);

    device.destroy(buffer);
    expect(device.stats.bufferBytes).toBe(baseBuffer + 96 + 8);
    device.destroy(mesh);
    expect(device.stats.bufferBytes).toBe(baseBuffer);
    device.destroy(texture);
    expect(device.stats.textureBytes).toBe(baseTexture);
  });

  test("[ER-04-04] destroying a stale handle throws E_STALE_HANDLE in dev", async () => {
    const { device } = await initialized();
    const buffer = device.createBuffer(bufferDesc());
    device.destroy(buffer);
    expect(errorOf(() => device.destroy(buffer)).code).toBe("E_STALE_HANDLE");
    const forged = { ...buffer, index: buffer.index + 1000 };
    expect(errorOf(() => device.destroy(forged)).code).toBe("E_STALE_HANDLE");
  });

  test("[ER-04-04] dispose is idempotent, releases GPU objects and invalidates handles", async () => {
    const { harness, device } = await initialized();
    const buffer = device.createBuffer(bufferDesc());
    device.createTexture(textureDesc());
    device.createMesh(meshDesc());
    device.createSampler(samplerDesc());
    const vertex = device.createShaderModule(vertexShaderDesc());
    const fragment = device.createShaderModule(fragmentShaderDesc());
    device.createPipeline(pipelineDesc(vertex, fragment));
    device.createMaterial(materialDesc());

    device.dispose();
    expect(device.deviceState).toBe("disposed");
    expect(harness.device.counts.destroy).toBe(1);
    expect(harness.context.unconfigureCalls).toBeGreaterThanOrEqual(1);
    expect(device.stats.textureBytes).toBe(0);
    expect(device.stats.bufferBytes).toBe(0);
    expect(harness.device.textures.every((texture) => texture.destroyed)).toBe(
      true,
    );
    expect(harness.device.buffers.every((entry) => entry.destroyed)).toBe(true);

    device.dispose();
    expect(harness.device.counts.destroy).toBe(1);
    expect(errorOf(() => device.createBuffer(bufferDesc())).code).toBe(
      "E_DEVICE_LOST",
    );
    expect(errorOf(() => device.destroy(buffer)).code).toBe("E_STALE_HANDLE");
  });

  test("[ER-04-04] create calls before init throw E_BACKEND_INIT", async () => {
    const harness = createHarness();
    const device = new WebGpuRendererDevice(harness.dependencies);
    const before = snapshot(harness.device);
    expect(errorOf(() => device.createBuffer(bufferDesc())).code).toBe(
      "E_BACKEND_INIT",
    );
    expect(errorOf(() => device.createTexture(textureDesc())).code).toBe(
      "E_BACKEND_INIT",
    );
    expect(harness.device.counts).toEqual(before);
    device.dispose();
  });
});

describe("validation before GPU work", () => {
  test("[ER-04-04] an invalid buffer descriptor makes no GPU call", async () => {
    const { harness, device } = await initialized();
    const before = snapshot(harness.device);
    expect(errorOf(() => device.createBuffer(bufferDesc(3))).code).toBe(
      "E_CONTRACT",
    );
    expect(
      errorOf(() =>
        device.createBuffer({ label: "", size: 16, usage: ["uniform"] }),
      ).code,
    ).toBe("E_CONTRACT");
    expect(harness.device.counts).toEqual(before);
  });

  test("[ER-04-04] an invalid texture descriptor makes no GPU call", async () => {
    const { harness, device } = await initialized();
    const before = snapshot(harness.device);
    expect(
      errorOf(() => device.createTexture(textureDesc({ width: 0 }))).code,
    ).toBe("E_CONTRACT");
    expect(
      errorOf(() => device.createTexture(textureDesc({ usage: [] }))).code,
    ).toBe("E_CONTRACT");
    expect(
      errorOf(() =>
        device.createTexture(
          textureDesc({
            format: "depth24plus",
            usage: ["sample", "copy-dst"],
          }),
        ),
      ).code,
    ).toBe("E_ASSET_FORMAT");
    expect(harness.device.counts).toEqual(before);
  });

  test("[ER-04-04] an unsupported format is rejected, never downcast", async () => {
    const { harness, device } = await initialized();
    const before = snapshot(harness.device);
    expect(
      errorOf(() =>
        device.createTexture(
          textureDesc({ format: "bptc-rgba", usage: ["sample", "copy-dst"] }),
        ),
      ).code,
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(
      errorOf(() =>
        device.createTexture(textureDesc({ sampleCount: 4 })),
      ).code,
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(harness.device.counts).toEqual(before);
  });

  test("[ER-04-04] an invalid mesh descriptor makes no GPU call", async () => {
    const { harness, device } = await initialized();
    const before = snapshot(harness.device);
    expect(
      errorOf(() =>
        device.createMesh(meshDesc({ vertices: [new Uint8Array(33)] })),
      ).code,
    ).toBe("E_CONTRACT");
    expect(
      errorOf(() =>
        device.createMesh(
          meshDesc({ vertices: [new Uint8Array(32), new Uint8Array(32)] }),
        ),
      ).code,
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(harness.device.counts).toEqual(before);
  });

  test("[ER-04-04] mesh index rules are enforced", async () => {
    const { device } = await initialized();
    expect(
      errorOf(() =>
        device.createMesh(
          meshDesc({
            indices: {
              data: new Uint32Array([0, 1, 2]),
              format: "uint32",
            },
          }),
        ),
      ).code,
    ).toBe("E_CONTRACT");
    expect(
      errorOf(() =>
        device.createMesh(
          meshDesc({
            indices: { data: new Uint16Array([0, 1, 2, 0]), format: "uint16" },
          }),
        ),
      ).code,
    ).toBe("E_CONTRACT");
    expect(
      errorOf(() =>
        device.createMesh(
          meshDesc({
            indices: { data: new Uint16Array([0, 1, 3]), format: "uint16" },
          }),
        ),
      ).code,
    ).toBe("E_CONTRACT");
  });

  test("[ER-04-04] an invalid material descriptor makes no GPU call", async () => {
    const { harness, device } = await initialized();
    const before = snapshot(harness.device);
    expect(
      errorOf(() => device.createMaterial(materialDesc({ metallic: 2 }))).code,
    ).toBe("E_CONTRACT");
    expect(
      errorOf(() =>
        device.createMaterial(materialDesc({ alphaMode: "blend" })),
      ).code,
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(harness.device.counts).toEqual(before);
  });

  test("[ER-04-04] an invalid shader or sampler descriptor makes no GPU call", async () => {
    const { harness, device } = await initialized();
    const before = snapshot(harness.device);
    expect(
      errorOf(() =>
        device.createShaderModule({ ...vertexShaderDesc(), label: "" }),
      ).code,
    ).toBe("E_CONTRACT");
    expect(
      errorOf(() =>
        device.createShaderModule({
          ...vertexShaderDesc(),
          entryPoint: "missing_entry",
        }),
      ).code,
    ).toBe("E_PIPELINE_COMPILE");
    expect(
      errorOf(() =>
        device.createSampler(
          samplerDesc({
            magFilter: "bogus" as unknown as SamplerDesc["magFilter"],
          }),
        ),
      ).code,
    ).toBe("E_CONTRACT");
    expect(harness.device.counts).toEqual(before);
  });

  test("[ER-04-04] M1-only creation methods report E_UNSUPPORTED_FEATURE", async () => {
    const { device } = await initialized();
    expect(
      errorOf(() =>
        device.createLodGroup({
          label: "lod",
          entries: [],
          bounds: { center: { x: 0, y: 0, z: 0 }, radius: 1 },
        }),
      ).code,
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(
      errorOf(() =>
        device.createRenderTarget({
          label: "target",
          width: 1,
          height: 1,
          format: "rgba8unorm",
          depth: "none",
        }),
      ).code,
    ).toBe("E_UNSUPPORTED_FEATURE");
  });
});

describe("handle deduplication and limits", () => {
  test("[ER-04-04] identical shader descriptors return the same handle", async () => {
    const { harness, device } = await initialized();
    const first = device.createShaderModule(vertexShaderDesc());
    const second = device.createShaderModule(vertexShaderDesc());
    expect(second.index).toBe(first.index);
    expect(second.generation).toBe(first.generation);
    expect(harness.device.counts.createShaderModule).toBe(1);
    expect(device.stats.shaderModulesCreated).toBe(1);
  });

  test("[ER-04-04] the shader module store caps at 64", async () => {
    const { harness, device } = await initialized();
    for (let index = 0; index < 64; index += 1) {
      device.createShaderModule(vertexShaderDesc(index));
    }
    expect(harness.device.counts.createShaderModule).toBe(64);
    expect(
      errorOf(() => device.createShaderModule(vertexShaderDesc(64))).code,
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(harness.device.counts.createShaderModule).toBe(64);
  });

  test("[ER-04-04] identical sampler descriptors return the same handle regardless of label", async () => {
    const { harness, device } = await initialized();
    const baseSamplers = harness.device.counts.createSampler;
    const first = device.createSampler(samplerDesc());
    const second = device.createSampler({
      ...samplerDesc(),
      label: "another-label",
    });
    expect(second.index).toBe(first.index);
    expect(second.generation).toBe(first.generation);
    expect(harness.device.counts.createSampler - baseSamplers).toBe(1);
  });

  test("[ER-04-04] the sampler store caps at 32", async () => {
    const { harness, device } = await initialized();
    const baseSamplers = harness.device.counts.createSampler;
    const addresses = ["clamp-to-edge", "repeat", "mirror-repeat"] as const;
    for (let index = 0; index < 32; index += 1) {
      device.createSampler(
        samplerDesc({
          addressU: addresses[Math.floor(index / 16)] ?? "clamp-to-edge",
          maxAnisotropy: (index % 16) + 1,
        }),
      );
    }
    expect(harness.device.counts.createSampler - baseSamplers).toBe(32);
    expect(
      errorOf(() =>
        device.createSampler(samplerDesc({ addressV: "repeat" })),
      ).code,
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(harness.device.counts.createSampler - baseSamplers).toBe(32);
  });

  test("[ER-04-04] the pipeline store caps at 256", async () => {
    const { harness, device } = await initialized();
    const vertex = device.createShaderModule(vertexShaderDesc());
    const fragment = device.createShaderModule(fragmentShaderDesc());
    for (let index = 0; index < 256; index += 1) {
      device.createPipeline({
        ...pipelineDesc(vertex, fragment),
        label: `pipeline-${index}`,
        definesCanonical: `{"PIPELINE_INDEX":${index}}`,
      });
    }
    expect(harness.device.counts.createRenderPipeline).toBe(256);
    expect(
      errorOf(() =>
        device.createPipeline({
          ...pipelineDesc(vertex, fragment),
          label: "pipeline-256",
          definesCanonical: '{"PIPELINE_INDEX":256}',
        }),
      ).code,
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(harness.device.counts.createRenderPipeline).toBe(256);
  });
});

describe("texture memory budget", () => {
  // A 1x1 canvas creates the 256-byte white fallback and a 256-byte depth
  // texture during init; every budget assertion is relative to that baseline.
  const INIT_TEXTURE_BYTES = 512;

  test("[ER-04-04] a texture over maxTextureBytes is rejected before allocation", async () => {
    const { harness, device } = await initialized({ maxTextureBytes: 1024 });
    const before = snapshot(harness.device);
    // 16x16 RGBA8 rows align to 256 bytes, so this texture accounts 4096.
    const pixels = new Uint8Array(16 * 64);
    expect(
      errorOf(() =>
        device.createTexture(
          textureDesc({
            width: 16,
            height: 16,
            data: [{ mipLevel: 0, layer: 0, bytes: pixels, bytesPerRow: 64 }],
          }),
        ),
      ).code,
    ).toBe("E_ASSET_BUDGET");
    expect(harness.device.counts.createTexture).toBe(before.createTexture);
    expect(device.stats.textureBytes).toBe(INIT_TEXTURE_BYTES);
  });

  test("[ER-04-04] a texture exactly at the budget is accepted", async () => {
    const { device } = await initialized({
      maxTextureBytes: INIT_TEXTURE_BYTES + 256,
    });
    const texture = device.createTexture(textureDesc());
    expect(device.stats.textureBytes).toBe(INIT_TEXTURE_BYTES + 256);
    expect(
      errorOf(() =>
        device.createTexture(textureDesc({ label: "second-texture" })),
      ).code,
    ).toBe("E_ASSET_BUDGET");
    device.destroy(texture);
    expect(device.stats.textureBytes).toBe(INIT_TEXTURE_BYTES);
  });
});

/**
 * ER-05-01: WebGL2 device lifecycle, resources, frame recording, culling and
 * refusals (05 §3–§5). The hand-written fake records GL calls; it proves call
 * order/state and handle validation, not pixels, GPU timing or real hardware.
 */

import { describe, expect, test } from "vitest";
import type {
  BufferHandle,
  MeshDesc,
  MeshHandle,
  PipelineDesc,
  ShaderModuleDesc,
} from "@lanpad/engine-core";
import { EXT } from "../src/classify.js";
import { probeWebGL2 } from "../src/capability.js";
import type { WebGL2DeviceOptions } from "../src/contracts/webgl2.js";
import { createWebGL2Device } from "../src/device.js";
import type { MutableRenderStats } from "../src/stats.js";
import {
  errorCodeOf,
  identity,
  instanceTransforms,
  materialDesc,
  rejectionCode,
  textureDesc,
  translation,
  triangleMesh,
} from "./helpers.js";
import { wireWebGL2 } from "./fake/canvas.js";
import { FakeCanvas } from "./fake/webgl2.js";

const EXPECTED_ATTRIBUTES = {
  alpha: false,
  depth: true,
  stencil: false,
  antialias: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
  desynchronized: true,
  failIfMajorPerformanceCaveat: false,
} as const;

async function makeDevice(options: Partial<WebGL2DeviceOptions> = {}) {
  const wired = wireWebGL2();
  const init = await createWebGL2Device({ canvas: wired.canvas.asCanvas(), ...options });
  return { ...wired, init, device: init.device };
}

/** The device's stats object carries internal counters beyond `RenderStats`. */
function internalStats(device: { readonly stats: unknown }): MutableRenderStats {
  return device.stats as MutableRenderStats;
}

function shaderDesc(overrides: Partial<ShaderModuleDesc> = {}): ShaderModuleDesc {
  return {
    label: "test-shader",
    stage: "vertex",
    language: "wgsl",
    code: "struct VsOut { position: vec4<f32> };",
    entryPoint: "vs_main",
    abiVersion: 1,
    ...overrides,
  };
}

function pipelineDesc(overrides: Partial<PipelineDesc> = {}): PipelineDesc {
  return { label: "test-pipeline", ...overrides };
}

const SAMPLER_DESC = {
  magFilter: "linear",
  minFilter: "linear",
  mipmapFilter: "linear",
  addressU: "clamp-to-edge",
  addressV: "clamp-to-edge",
} as const;

const LOD_DESC = {
  label: "test-lod",
  entries: [],
  bounds: { center: { x: 0, y: 0, z: 0 }, radius: 1 },
} as const;

const RENDER_TARGET_DESC = {
  label: "test-target",
  width: 1,
  height: 1,
  format: "rgba8unorm",
  depth: "none",
} as const;

describe("[ER-05-01] device creation and probe", () => {
  test("[ER-05-01] the factory creates one context with Appendix A attributes", async () => {
    const { canvas, fake, init, device } = await makeDevice();
    expect(canvas.getContextCalls).toHaveLength(1);
    expect(canvas.getContextCalls[0]?.type).toBe("webgl2");
    expect(canvas.getContextCalls[0]?.attributes).toEqual(EXPECTED_ATTRIBUTES);
    expect(device.contextAttributes).toEqual(EXPECTED_ATTRIBUTES);
    expect(init.backend).toBe("webgl2");
    expect(init.adapterInfo).toBe("webgl2 | Fake GL Renderer");
    expect(device.contextEpoch).toBe(0);
    expect(device.lost).toBe(false);
    expect(fake.count("isContextLost")).toBe(1);
  });

  test("[ER-05-01] a standard fake classifies as standard/medium with nine formats", async () => {
    const { init, device } = await makeDevice();
    expect(init.capabilities).toMatchObject({
      available: true,
      backend: "webgl2",
      tier: "standard",
      quality: "medium",
      maxTextureSize: 4096,
      maxTextureLayers: 256,
      maxBindGroups: 4,
      maxUniformBufferBytes: 16384,
      maxSamples: 1,
      anisotropy: 0,
      directionalLights: 4,
      pointLights: 8,
      shadowCascades: 0,
      supportsPost: false,
      supportsTimestamps: false,
      maxBones: 256,
      maxDirectionalLights: 4,
      maxPointLights: 8,
      maxShadowMaps: 1,
      vendor: "Fake Vendor",
      renderer: "Fake GL Renderer",
    });
    expect([...init.capabilities.features]).toEqual(["texture-array"]);
    expect(init.capabilities.supportedFormats.size).toBe(9);
    expect(device.limits.maxStorageBufferBindingSize).toBe(0);
    expect(device.limits.maxComputeWorkgroupSizeX).toBe(0);
    expect(device.limits.maxVertexBuffers).toBe(2);
    expect(device.limits.minUniformBufferOffsetAlignment).toBe(256);
    expect(device.extensions).toEqual([]);
  });

  test("[ER-05-01] initial size is the canvas CSS size at DPR 1", async () => {
    const { canvas, device } = await makeDevice();
    expect(device.size).toEqual({ width: 640, height: 360 });
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(canvas.style).toEqual({ width: "640px", height: "360px" });
  });

  test("[ER-05-01] init refuses a foreign canvas or a non-canvas surface", async () => {
    const { device, canvas } = await makeDevice();
    expect(
      await rejectionCode(
        device.init({
          kind: "canvas",
          native: new FakeCanvas().asCanvas(),
          cssWidth: 1,
          cssHeight: 1,
          dpr: 1,
        }),
      ),
    ).toBe("E_CONTRACT");
    expect(
      await rejectionCode(
        device.init({
          kind: "offscreen",
          native: canvas.asCanvas(),
          cssWidth: 1,
          cssHeight: 1,
          dpr: 1,
        } as never),
      ),
    ).toBe("E_CONTRACT");
  });

  test("[ER-05-01] resize maps CSS pixels to a DPR backing store", async () => {
    const { device, canvas } = await makeDevice();
    device.resize(800, 600, 2);
    expect(device.size).toEqual({ width: 800, height: 600 });
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(canvas.style).toEqual({ width: "800px", height: "600px" });
    device.resize(320, 180, 0);
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
    expect(errorCodeOf(() => device.resize(Number.NaN, 10, 1))).toBe("E_CONTRACT");
    expect(errorCodeOf(() => device.resize(10, 10, Number.POSITIVE_INFINITY))).toBe(
      "E_CONTRACT",
    );
  });

  test("[ER-05-01] maxRenderHeight caps the backing height proportionally", async () => {
    const { device, canvas } = await makeDevice({ maxRenderHeight: 100 });
    device.resize(100, 100, 2);
    expect(device.size).toEqual({ width: 100, height: 100 });
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(100);
  });

  test("[ER-05-01] the TV profile disables antialias and caps backing height at 1080", async () => {
    const { device, canvas } = await makeDevice({ tvProfile: true });
    expect(device.contextAttributes.antialias).toBe(false);
    expect(canvas.getContextCalls[0]?.attributes).toMatchObject({ antialias: false });
    device.resize(1920, 1080, 2);
    expect(canvas.height).toBe(1080);
    expect(canvas.width).toBe(1920);
  });

  test("[ER-05-01] a zero-size surface reports an invalid frame", async () => {
    const { device, canvas } = await makeDevice();
    device.resize(0, 0, 1);
    expect(device.size).toEqual({ width: 0, height: 0 });
    expect(canvas.width).toBe(1);
    const frame = device.beginFrame();
    expect(frame.valid).toBe(false);
    device.endFrame();
  });

  test("[ER-05-01] a missing, throwing or lost context rejects E_BACKEND_INIT", async () => {
    const missing = new FakeCanvas();
    expect(await rejectionCode(createWebGL2Device({ canvas: missing.asCanvas() }))).toBe(
      "E_BACKEND_INIT",
    );

    const throwing = new FakeCanvas();
    throwing.contextThrows = true;
    expect(await rejectionCode(createWebGL2Device({ canvas: throwing.asCanvas() }))).toBe(
      "E_BACKEND_INIT",
    );

    const lost = wireWebGL2();
    lost.fake.contextLost = true;
    expect(await rejectionCode(createWebGL2Device({ canvas: lost.canvas.asCanvas() }))).toBe(
      "E_BACKEND_INIT",
    );

    expect(
      await rejectionCode(
        createWebGL2Device({ canvas: null as unknown as HTMLCanvasElement }),
      ),
    ).toBe("E_BACKEND_INIT");
  });

  test("[ER-05-01] post, shadows and non-default frame counts reject before allocation", async () => {
    const wired = wireWebGL2();
    const canvas = wired.canvas.asCanvas();
    expect(await rejectionCode(createWebGL2Device({ canvas, post: true }))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(await rejectionCode(createWebGL2Device({ canvas, shadowCascades: 2 }))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(
      await rejectionCode(
        createWebGL2Device({ canvas, framesInFlight: 2 as unknown as 3 }),
      ),
    ).toBe("E_CONTRACT");
    expect(wired.fake.count("createShader")).toBe(0);
    expect(wired.canvas.getContextCalls).toHaveLength(0);
  });
});

describe("[ER-05-01] WebGL2 probe", () => {
  test("[ER-05-01] a standard context reports standard/medium", () => {
    const { canvas } = wireWebGL2();
    const result = probeWebGL2(canvas.asCanvas());
    expect(result.available).toBe(true);
    expect(result.capabilities?.tier).toBe("standard");
    expect(result.capabilities?.quality).toBe("medium");
    expect(result.capabilities?.supportedFormats.size).toBe(9);
    expect(result.capabilities?.vendor).toBe("Fake Vendor");
  });

  test("[ER-05-01] extensions raise the tier and add formats", () => {
    const { canvas, fake } = wireWebGL2();
    fake.setParameter("MAX_TEXTURE_SIZE", 8192);
    fake.setParameter("MAX_SAMPLES", 4);
    fake.addExtension(EXT.floatColorBuffer);
    fake.addExtension(EXT.floatLinear);
    fake.addExtension(EXT.astc);
    const result = probeWebGL2(canvas.asCanvas());
    expect(result.capabilities?.tier).toBe("extended");
    expect(result.capabilities?.quality).toBe("high");
    expect(result.capabilities?.features.has("compressed-astc")).toBe(true);
    expect(result.capabilities?.features.has("float-render-target")).toBe(true);
    expect(result.capabilities?.supportedFormats.size).toBe(12);
  });

  test("[ER-05-01] no-context, throwing and blocked probes are data", () => {
    expect(probeWebGL2(new FakeCanvas().asCanvas())).toEqual({
      available: false,
      reason: "no-context",
    });
    const throwing = new FakeCanvas();
    throwing.contextThrows = true;
    expect(probeWebGL2(throwing.asCanvas())).toEqual({
      available: false,
      reason: "context-threw",
    });
    const blocked = wireWebGL2();
    blocked.fake.contextLost = true;
    expect(probeWebGL2(blocked.canvas.asCanvas())).toEqual({
      available: false,
      reason: "blocked",
    });
    expect(
      probeWebGL2(() => {
        throw new Error("boom");
      }),
    ).toEqual({ available: false, reason: "context-threw" });
    expect(probeWebGL2(() => null)).toEqual({ available: false, reason: "no-context" });
    expect(
      probeWebGL2(null as unknown as () => HTMLCanvasElement | null),
    ).toEqual({ available: false, reason: "no-context" });
  });
});

describe("[ER-05-01] textures and buffers", () => {
  test("[ER-05-01] a sampled 2D texture uploads immutably and accounts bytes", async () => {
    const { device, fake, gl } = await makeDevice();
    // The device uploads its 1x1 white fallback during construction.
    fake.clearCalls();
    const texture = device.createTexture(textureDesc());
    expect(texture.__kind).toBe("texture");
    expect(device.stats.textureBytes).toBe(256);
    expect(device.stats.uploadBytes).toBe(256);
    expect(device.stats.uploadCalls).toBe(1);
    expect(fake.lastCall("texStorage2D")?.args).toEqual([
      gl.TEXTURE_2D,
      1,
      gl.RGBA8,
      2,
      2,
    ]);
    expect(fake.count("texSubImage2D")).toBe(1);
    expect(fake.count("createSampler")).toBe(1);
    expect(fake.count("compressedTexSubImage2D")).toBe(0);
  });

  test("[ER-05-01] copy-dst is an accepted no-op for data-backed textures", async () => {
    const { device, fake } = await makeDevice();
    fake.clearCalls();
    // The runtime asset bridge declares both usages for data-backed textures.
    const texture = device.createTexture(textureDesc({ usage: ["sample", "copy-dst"] }));
    expect(texture.__kind).toBe("texture");
    expect(fake.count("texStorage2D")).toBe(1);
    expect(fake.count("texSubImage2D")).toBe(1);
    // WebGL2 uploads with texSubImage2D; sampling still requires `sample`.
    expect(errorCodeOf(() => device.createTexture(textureDesc({ usage: ["copy-dst"] })))).toBe(
      "E_CONTRACT",
    );
  });

  test("[ER-05-01] a copy-dst texture resolves as a material base colour", async () => {
    const { device } = await makeDevice();
    const texture = device.createTexture(textureDesc({ usage: ["sample", "copy-dst"] }));
    const material = device.createMaterial(materialDesc({ baseColorTexture: texture }));
    const mesh = device.createMesh(triangleMesh());
    const frame = device.beginFrame();
    frame.draw(mesh, material, identity());
    device.endFrame();
    expect(device.stats.drawCalls).toBe(1);
    expect(internalStats(device).textureBinds).toBe(1);
  });

  test("[ER-05-01] unsupported formats, usages and samplers refuse", async () => {
    const { device } = await makeDevice();
    expect(errorCodeOf(() => device.createTexture(textureDesc({ format: "bgra8unorm" })))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(
      errorCodeOf(() =>
        device.createTexture(
          textureDesc({
            format: "astc-6x6",
            width: 6,
            height: 6,
            data: [
              { mipLevel: 0, layer: 0, bytes: new Uint8Array(16), bytesPerRow: 0 },
            ],
          }),
        ),
      ),
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(
      errorCodeOf(() => device.createTexture(textureDesc({ format: "depth24plus" }))),
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(
      errorCodeOf(() =>
        device.createTexture(textureDesc({ usage: ["render-attachment"] })),
      ),
    ).toBe("E_CONTRACT");
    expect(
      errorCodeOf(() =>
        device.createTexture(textureDesc({ usage: ["sample", "render-attachment"] })),
      ),
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(errorCodeOf(() => device.createSampler(SAMPLER_DESC))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
  });

  test("[ER-05-01] the texture budget rejects before allocation", async () => {
    const { device } = await makeDevice({ maxTextureBytes: 100 });
    expect(errorCodeOf(() => device.createTexture(textureDesc()))).toBe("E_ASSET_BUDGET");
    expect(device.stats.textureBytes).toBe(0);
  });

  test("[ER-05-01] texture destroy is deferred to endFrame", async () => {
    const { device, fake } = await makeDevice();
    const texture = device.createTexture(textureDesc());
    expect(device.stats.textureBytes).toBe(256);
    device.beginFrame();
    device.destroy(texture);
    expect(fake.count("deleteTexture")).toBe(0);
    expect(device.stats.textureBytes).toBe(0);
    device.endFrame();
    expect(fake.count("deleteTexture")).toBe(1);
    device.destroy(texture);
    expect(internalStats(device).staleHandles).toBe(1);
  });

  test("[ER-05-01] buffers validate size, data and range", async () => {
    const { device, fake } = await makeDevice();
    const buffer = device.createBuffer({ size: 64, target: "vertex" });
    expect(buffer.__kind).toBe("buffer");
    expect(device.stats.bufferBytes).toBe(64);
    expect(device.stats.uploadCalls).toBe(0);
    device.writeBuffer(buffer, 0, new Uint8Array(8));
    expect(device.stats.uploadBytes).toBe(8);
    expect(device.stats.uploadCalls).toBe(1);
    expect(errorCodeOf(() => device.writeBuffer(buffer, 60, new Uint8Array(8)))).toBe(
      "E_CONTRACT",
    );
    const stale: BufferHandle = { ...buffer, generation: buffer.generation + 1 };
    expect(errorCodeOf(() => device.writeBuffer(stale, 0, new Uint8Array(4)))).toBe(
      "E_STALE_HANDLE",
    );
    expect(errorCodeOf(() => device.createBuffer({ size: 0 }))).toBe("E_CONTRACT");
    expect(errorCodeOf(() => device.createBuffer({ size: 16, target: "texture" }))).toBe(
      "E_CONTRACT",
    );
    expect(
      errorCodeOf(() => device.createBuffer({ size: 16, data: new Uint8Array(32) })),
    ).toBe("E_CONTRACT");
    fake.clearCalls();
    device.destroy(buffer);
    expect(fake.count("deleteBuffer")).toBe(1);
  });

  test("[ER-05-01] buffer initial data counts as one upload", async () => {
    const { device } = await makeDevice();
    device.createBuffer({ size: 16, data: new Uint8Array(8) });
    expect(device.stats.bufferBytes).toBe(16);
    expect(device.stats.uploadBytes).toBe(8);
    expect(device.stats.uploadCalls).toBe(1);
  });
});

describe("[ER-05-01] meshes and materials", () => {
  test("[ER-05-01] a static ABI-1 mesh binds locations 0-2 with stride 32", async () => {
    const { device, fake, gl } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    expect(mesh.__kind).toBe("mesh");
    expect(device.stats.bufferBytes).toBe(102);
    expect(device.stats.uploadCalls).toBe(1);
    const pointers = fake.callsNamed("vertexAttribPointer");
    expect(pointers.map((call) => call.args[0])).toEqual([0, 1, 2]);
    expect(pointers.map((call) => call.args[1])).toEqual([3, 3, 2]);
    expect(pointers.every((call) => call.args[4] === 32)).toBe(true);
    expect(pointers.map((call) => call.args[5])).toEqual([0, 12, 24]);
    expect(fake.count("vertexAttribDivisor")).toBe(0);
    expect(fake.lastCall("bufferData")?.args[0]).toBe(gl.ELEMENT_ARRAY_BUFFER);
    const stale: MeshHandle = { ...mesh, generation: mesh.generation + 1 };
    device.destroy(stale);
    expect(internalStats(device).staleHandles).toBe(1);
  });

  test("[ER-05-01] instanced meshes bind matrix attributes 3-6 at divisor 1", async () => {
    const { device, fake, gl } = await makeDevice();
    device.createMesh(triangleMesh("instanced-transform-v1"));
    expect(device.stats.bufferBytes).toBe(166);
    const divisors = fake.callsNamed("vertexAttribDivisor");
    expect(divisors.map((call) => call.args[0])).toEqual([3, 4, 5, 6]);
    expect(divisors.every((call) => call.args[1] === 1)).toBe(true);
    const allocated = fake
      .callsNamed("bufferData")
      .some((call) => call.args[0] === gl.ARRAY_BUFFER && call.args[1] === 64);
    expect(allocated).toBe(true);
  });

  test("[ER-05-01] a skinned layout rejects at mesh creation", async () => {
    const { device } = await makeDevice();
    const bad = { ...triangleMesh(), layout: "skinned-pbr-v1" } as unknown as MeshDesc;
    expect(errorCodeOf(() => device.createMesh(bad))).toBe("E_CONTRACT");
  });

  test("[ER-05-01] materials pack a 64-byte UBO and refuse M1 maps", async () => {
    const { device } = await makeDevice();
    const material = device.createMaterial(materialDesc());
    expect(material.__kind).toBe("material");
    expect(device.stats.bufferBytes).toBe(64);
    expect(device.stats.uploadBytes).toBe(64);
    expect(device.stats.uploadCalls).toBe(1);
    expect(
      errorCodeOf(() =>
        device.createMaterial(
          materialDesc({
            normalTexture: { index: 0, generation: 1, __kind: "texture" },
          }),
        ),
      ),
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(
      errorCodeOf(() =>
        device.createMaterial(
          materialDesc({
            baseColorTexture: { index: 9, generation: 1, __kind: "texture" },
          }),
        ),
      ),
    ).toBe("E_STALE_HANDLE");
  });

  test("[ER-05-01] a live base-colour texture binds on draw", async () => {
    const { device } = await makeDevice();
    const texture = device.createTexture(textureDesc());
    const material = device.createMaterial(materialDesc({ baseColorTexture: texture }));
    const mesh = device.createMesh(triangleMesh());
    const frame = device.beginFrame();
    frame.draw(mesh, material, identity());
    device.endFrame();
    expect(device.stats.drawCalls).toBe(1);
    expect(internalStats(device).textureBinds).toBe(1);
  });
});

describe("[ER-05-01] shader modules and pipelines", () => {
  test("[ER-05-01] shader modules are recorded but never compiled", async () => {
    const { device, fake } = await makeDevice();
    const shader = device.createShaderModule(shaderDesc());
    expect(shader.__kind).toBe("shader");
    expect(fake.count("createShader")).toBe(16);
    expect(errorCodeOf(() => device.createShaderModule(shaderDesc({ stage: "compute" })))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(
      errorCodeOf(() =>
        device.createShaderModule(shaderDesc({ abiVersion: 2 as unknown as 1 })),
      ),
    ).toBe("E_CONTRACT");
    expect(errorCodeOf(() => device.createShaderModule(shaderDesc({ label: "" })))).toBe(
      "E_CONTRACT",
    );
    expect(
      errorCodeOf(() => device.createShaderModule(shaderDesc({ code: "x".repeat(65_537) }))),
    ).toBe("E_CONTRACT");
  });

  test("[ER-05-01] the default pipeline descriptor is a cache hit", async () => {
    const { device } = await makeDevice();
    const pipeline = device.createPipeline(pipelineDesc());
    expect(pipeline.__kind).toBe("pipeline");
    expect(device.stats.pipelinesCreated).toBe(24);
    expect(device.stats.pipelineCacheHits).toBe(1);
    expect(errorCodeOf(() => device.createPipeline({}))).toBe("E_CONTRACT");
    expect(
      errorCodeOf(() => device.createPipeline(pipelineDesc({ blendMode: "additive" }))),
    ).toBe("E_CONTRACT");
    expect(
      errorCodeOf(() =>
        device.createPipeline(pipelineDesc({ vertexLayout: "skinned-pbr-v1" })),
      ),
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(
      errorCodeOf(() => device.createPipeline(pipelineDesc({ colorFormat: "rgba8unorm" }))),
    ).toBe("E_UNSUPPORTED_FEATURE");
  });

  test("[ER-05-01] M1/M2 device surfaces refuse instead of stubbing", async () => {
    const { device } = await makeDevice();
    const texture = device.createTexture(textureDesc());
    expect(errorCodeOf(() => device.createLodGroup(LOD_DESC))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(errorCodeOf(() => device.createRenderTarget(RENDER_TARGET_DESC))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(errorCodeOf(() => device.createSampler(SAMPLER_DESC))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(await rejectionCode(device.readTexture(texture, { width: 1, height: 1 }))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(await rejectionCode(device.captureFrame())).toBe("E_UNSUPPORTED_FEATURE");
  });
});

describe("[ER-05-01] frame recording and culling", () => {
  test("[ER-05-01] a draw clears, binds and issues one indexed draw", async () => {
    const { device, fake, gl } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    fake.clearCalls();
    const frame = device.beginFrame();
    expect(frame.valid).toBe(true);
    frame.draw(mesh, material, identity());
    device.endFrame();
    expect(frame.valid).toBe(false);
    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.instances).toBe(1);
    expect(device.stats.triangles).toBe(1);
    expect(device.stats.culledInstances).toBe(0);
    expect(internalStats(device).textureBinds).toBe(1);
    expect(fake.count("clear")).toBe(1);
    expect(fake.lastCall("viewport")?.args).toEqual([0, 0, 640, 360]);
    expect(fake.lastCall("drawElements")?.args).toEqual([
      gl.TRIANGLES,
      3,
      gl.UNSIGNED_SHORT,
      0,
    ]);
    const uniform = fake.lastCall("uniformMatrix4fv");
    expect(uniform?.args[1]).toBe(false);
    expect(uniform?.args[4]).toBe(16);
  });

  test("[ER-05-01] draws outside an open frame throw E_FRAME_CLOSED", async () => {
    const { device } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    const frame = device.beginFrame();
    device.endFrame();
    expect(errorCodeOf(() => frame.draw(mesh, material, identity()))).toBe(
      "E_FRAME_CLOSED",
    );
    expect(
      errorCodeOf(() => frame.drawInstanced(mesh, material, new Float32Array(16), 1)),
    ).toBe("E_FRAME_CLOSED");
  });

  test("[ER-05-01] per-frame stats reset at beginFrame", async () => {
    const { device } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    let frame = device.beginFrame();
    frame.draw(mesh, material, identity());
    device.endFrame();
    expect(device.stats.drawCalls).toBe(1);
    frame = device.beginFrame();
    expect(device.stats.drawCalls).toBe(0);
    device.endFrame();
    expect(device.stats.drawCalls).toBe(0);
  });

  test("[ER-05-01] drawInstanced uploads the pool block and grows capacity", async () => {
    const { device, fake, gl } = await makeDevice();
    const mesh = device.createMesh(triangleMesh("instanced-transform-v1"));
    const material = device.createMaterial(materialDesc());
    const transforms = instanceTransforms([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 2 },
    ]);
    const frame = device.beginFrame();
    frame.drawInstanced(mesh, material, transforms, 3);
    device.endFrame();
    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.instances).toBe(3);
    expect(device.stats.triangles).toBe(3);
    expect(device.stats.bufferBytes).toBe(166 + 64 + 192);
    expect(fake.lastCall("drawElementsInstanced")?.args).toEqual([
      gl.TRIANGLES,
      3,
      gl.UNSIGNED_SHORT,
      0,
      3,
    ]);
    const upload = fake.lastCall("bufferSubData");
    expect(upload?.args[0]).toBe(gl.ARRAY_BUFFER);
    expect(upload?.args[1]).toBe(0);
    expect(upload?.args[4]).toBe(48);
  });

  test("[ER-05-01] zero instances record no command", async () => {
    const { device } = await makeDevice();
    const mesh = device.createMesh(triangleMesh("instanced-transform-v1"));
    const material = device.createMaterial(materialDesc());
    const frame = device.beginFrame();
    frame.drawInstanced(mesh, material, new Float32Array(0), 0);
    device.endFrame();
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.instances).toBe(0);
  });

  test("[ER-05-01] camera culling drops an off-screen sphere", async () => {
    const { device } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    const frame = device.beginFrame();
    frame.setCamera(identity());
    frame.draw(mesh, material, identity());
    frame.draw(mesh, material, translation(0, 0, 1000));
    device.endFrame();
    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.instances).toBe(1);
    expect(device.stats.culledInstances).toBe(1);
  });

  test("[ER-05-01] a fully culled frame draws nothing", async () => {
    const { device } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    const frame = device.beginFrame();
    frame.setCamera(identity());
    frame.draw(mesh, material, translation(0, 0, 1000));
    device.endFrame();
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.triangles).toBe(0);
    expect(device.stats.culledInstances).toBe(1);
  });

  test("[ER-05-01] setCameraMatrices also enables culling", async () => {
    const { device } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    const frame = device.beginFrame();
    frame.setCameraMatrices(identity(), identity());
    frame.draw(mesh, material, translation(0, 0, 1000));
    device.endFrame();
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.culledInstances).toBe(1);
  });

  test("[ER-05-01] instanced culling compacts the kept transforms", async () => {
    const { device, fake } = await makeDevice();
    const mesh = device.createMesh(triangleMesh("instanced-transform-v1"));
    const material = device.createMaterial(materialDesc());
    const transforms = instanceTransforms([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 1000 },
    ]);
    const frame = device.beginFrame();
    frame.setCamera(identity());
    frame.drawInstanced(mesh, material, transforms, 3);
    device.endFrame();
    expect(device.stats.drawCalls).toBe(1);
    expect(device.stats.instances).toBe(2);
    expect(device.stats.culledInstances).toBe(1);
    expect(device.stats.triangles).toBe(2);
    expect(fake.lastCall("drawElementsInstanced")?.args[4]).toBe(2);
    expect(fake.lastCall("bufferSubData")?.args[4]).toBe(32);
  });

  test("[ER-05-01] instanced draws on a static mesh are dropped, not guessed", async () => {
    const { device } = await makeDevice();
    const mesh = device.createMesh(triangleMesh("static-pbr-v1"));
    const material = device.createMaterial(materialDesc());
    const frame = device.beginFrame();
    frame.drawInstanced(
      mesh,
      material,
      instanceTransforms([{ x: 0, y: 0, z: 0 }]),
      1,
    );
    device.endFrame();
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.droppedDraws).toBe(1);
  });

  test("[ER-05-01] stale handles are dropped and counted", async () => {
    const { device } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    const stale: MeshHandle = { ...mesh, generation: mesh.generation + 1 };
    const frame = device.beginFrame();
    frame.draw(stale, material, identity());
    device.endFrame();
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.droppedDraws).toBe(1);
    expect(internalStats(device).staleHandles).toBe(1);
  });

  test("[ER-05-01] frame-only M1 calls refuse with E_UNSUPPORTED_FEATURE", async () => {
    const { device } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    const texture = device.createTexture(textureDesc());
    const frame = device.beginFrame();
    expect(errorCodeOf(() => frame.drawLod(mesh as never, material, identity()))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(errorCodeOf(() => frame.beginPass({ target: "swapchain" }))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    expect(errorCodeOf(() => frame.drawFullscreen(texture, material))).toBe(
      "E_UNSUPPORTED_FEATURE",
    );
    device.endFrame();
  });

  test("[ER-05-01] destroying during a frame defers GL deletion", async () => {
    const { device, fake } = await makeDevice();
    const mesh = device.createMesh(triangleMesh());
    fake.clearCalls();
    device.beginFrame();
    device.destroy(mesh);
    expect(fake.count("deleteVertexArray")).toBe(0);
    device.endFrame();
    expect(fake.count("deleteVertexArray")).toBe(1);
    expect(fake.count("deleteBuffer")).toBeGreaterThan(0);
  });
});

describe("[ER-05-01] lifecycle", () => {
  test("[ER-05-01] restore on a healthy device reports the live handle count", async () => {
    const { device } = await makeDevice();
    device.createBuffer({ size: 16 });
    expect(await device.restore()).toEqual({
      ok: true,
      restoredHandles: 1,
      staleHandles: 0,
    });
  });

  test("[ER-05-01] dispose is idempotent and detaches context listeners", async () => {
    const { device, canvas, fake } = await makeDevice();
    const buffer = device.createBuffer({ size: 64 });
    const mesh = device.createMesh(triangleMesh());
    const material = device.createMaterial(materialDesc());
    const texture = device.createTexture(textureDesc());
    expect(canvas.listenerCount("webglcontextlost")).toBe(1);
    expect(canvas.listenerCount("webglcontextrestored")).toBe(1);
    const deletedBefore = fake.count("deleteBuffer");
    device.dispose();
    expect(canvas.listenerCount("webglcontextlost")).toBe(0);
    expect(canvas.listenerCount("webglcontextrestored")).toBe(0);
    expect(device.stats.bufferBytes).toBe(0);
    expect(device.stats.textureBytes).toBe(0);
    expect(fake.count("deleteBuffer")).toBeGreaterThan(deletedBefore);
    const deletedAfter = fake.count("deleteBuffer");
    device.dispose();
    expect(fake.count("deleteBuffer")).toBe(deletedAfter);
    expect(errorCodeOf(() => device.createBuffer({ size: 16 }))).toBe("E_DEVICE_LOST");
    const frame = device.beginFrame();
    expect(frame.valid).toBe(false);
    frame.draw(mesh, material, identity());
    expect(device.stats.droppedDraws).toBe(1);
    device.destroy(buffer);
    expect(internalStats(device).staleHandles).toBe(0);
    expect(await device.restore()).toEqual({
      ok: false,
      reason: "disposed",
      restoredHandles: 0,
      staleHandles: 0,
    });
    expect(texture.__kind).toBe("texture");
  });

  test("[ER-05-01] unknown handles count as stale and never throw", async () => {
    const { device } = await makeDevice();
    expect(() => device.destroy({} as unknown as BufferHandle)).not.toThrow();
    expect(internalStats(device).staleHandles).toBe(1);
  });
});

/**
 * Device lifecycle, capability report and draw-stat tests
 * (04 §3.2, §5.13, ER-04-17 partial, ER-04-03 partial).
 *
 * Node-only evidence: the shared core conformance suite and the real-device
 * browser run are still PENDING. This file covers the WebGPU device's own
 * lifecycle, capability report and per-frame counters against the fake GPU.
 */

import { describe, expect, test } from "vitest";
import type { ShaderModuleDesc, Surface } from "@lanpad/engine-core";
import {
  capabilitiesFromAdapter,
  deviceLimits,
} from "../src/device/capabilities.js";
import { WebGpuRendererDevice } from "../src/device/WebGpuDevice.js";
import type { WebGpuDeviceOptions } from "../src/contracts/webgpu.js";
import { canvasSurface, createHarness } from "./fakes/webgpu.js";
import {
  currentPassLog,
  errorOf,
  errorOfAsync,
  initialized,
  materialDesc,
  orthoProjection,
  staticMeshDesc,
  translation,
} from "./helpers.js";

function vertexShaderDesc(): ShaderModuleDesc {
  return {
    label: "device-vertex",
    stage: "vertex",
    language: "wgsl",
    code: "@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }",
    entryPoint: "vs_main",
    abiVersion: 1,
  };
}

function fragmentShaderDesc(): ShaderModuleDesc {
  return {
    label: "device-fragment",
    stage: "fragment",
    language: "wgsl",
    code: "@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }",
    entryPoint: "fs_main",
    abiVersion: 1,
  };
}

function pipelineDesc(
  vertexShader: ReturnType<WebGpuRendererDevice["createShaderModule"]>,
  fragmentShader: ReturnType<WebGpuRendererDevice["createShaderModule"]>,
): Record<string, unknown> {
  return {
    label: "device-pipeline",
    layoutId: "builtin-pbr-v1",
    vertexShader,
    fragmentShader,
    vertexLayout: "static-pbr-v1",
    colorFormats: ["bgra8unorm"],
    blendStates: ["off"],
  };
}

describe("device lifecycle", () => {
  test("[ER-04-17] resource creation before init is rejected", () => {
    const harness = createHarness();
    const device = new WebGpuRendererDevice(harness.dependencies);
    expect(device.backend).toBe("webgpu");
    expect(device.deviceState).toBe("uninitialized");
    expect(
      errorOf(() => device.createShaderModule(vertexShaderDesc())).code,
    ).toBe("E_BACKEND_INIT");
    expect(harness.device.counts.createShaderModule).toBe(0);
  });

  test("[ER-04-17] init rejects a non-canvas surface and a second init", async () => {
    const harness = createHarness();
    const device = new WebGpuRendererDevice(harness.dependencies);
    const offscreen = {
      kind: "offscreen",
      native: {},
      cssWidth: 1,
      cssHeight: 1,
      dpr: 1,
    } as unknown as Surface;
    expect((await errorOfAsync(device.init(offscreen))).code).toBe(
      "E_BACKEND_INIT",
    );
    expect(device.deviceState).toBe("uninitialized");

    await device.init(canvasSurface(harness.canvas, 8, 8, 1));
    expect(device.deviceState).toBe("running");
    expect(
      (await errorOfAsync(device.init(canvasSurface(harness.canvas, 8, 8, 1))))
        .code,
    ).toBe("E_BACKEND_INIT");
    expect(device.deviceState).toBe("running");
  });

  test("[ER-04-17] a failed swapchain construction leaves the device failed", async () => {
    const harness = createHarness();
    const device = new WebGpuRendererDevice(harness.dependencies);
    const surface: Surface = {
      kind: "canvas",
      native: { width: 0, height: 0, getContext: () => null },
      cssWidth: 8,
      cssHeight: 8,
      dpr: 1,
    };
    const error = await errorOfAsync(device.init(surface));
    expect(error.code).toBe("E_BACKEND_INIT");
    expect(device.deviceState).toBe("failed");
    expect(
      errorOf(() => device.createShaderModule(vertexShaderDesc())).code,
    ).toBe("E_DEVICE_LOST");
  });

  test("[ER-04-17] beginFrame after dispose is an invalid frame, not a throw", async () => {
    const { device } = await initialized();
    device.dispose();
    expect(device.deviceState).toBe("disposed");
    const frame = device.beginFrame();
    expect(frame.valid).toBe(false);
    expect(() => device.endFrame()).not.toThrow();
  });
});

describe("capability report", () => {
  test("[ER-04-17] the device reports the M0 capability subset", async () => {
    const { harness, device } = await initialized();
    const expected = deviceLimits(
      harness.adapter.limits as unknown as GPUSupportedLimits,
    );
    expect(device.limits).toEqual(expected);
    expect(device.adapterInfo).toBe("Fake GPU fake test fake-device");
    expect(device.canvasFormat).toBe("bgra8unorm");

    const capabilities = device.capabilities;
    expect(capabilities.backend).toBe("webgpu");
    expect(capabilities.quality).toBe("high");
    expect(capabilities.maxTextureSize).toBe(8192);
    expect(capabilities.maxTextureLayers).toBe(256);
    expect(capabilities.maxBindGroups).toBe(4);
    expect(capabilities.maxUniformBufferBytes).toBe(65_536);
    expect(capabilities.maxSamples).toBe(1);
    expect(capabilities.anisotropy).toBe(4);
    expect(capabilities.directionalLights).toBe(1);
    expect(capabilities.pointLights).toBe(0);
    expect(capabilities.shadowCascades).toBe(0);
    expect(capabilities.supportsPost).toBe(false);
    expect(capabilities.supportsTimestamps).toBe(false);
    expect(capabilities.features.has("texture-array")).toBe(true);
    expect(capabilities.features.size).toBe(1);
    expect(capabilities.supportedFormats.has("rgba8unorm-srgb")).toBe(true);
    expect(device.features).toBe(capabilities.features);
  });

  test("[ER-04-17] requested options feed the capability report", async () => {
    const options: WebGpuDeviceOptions = {
      quality: "low",
      anisotropy: 9,
      maxRenderHeight: 720,
      retainCpuCopies: false,
    };
    const { harness, device } = await initialized(options);
    const expected = capabilitiesFromAdapter(
      harness.adapter as unknown as GPUAdapter,
      {
        quality: "low",
        maxRenderHeight: 720,
        maxTextureBytes: 128 * 1024 * 1024,
        shadowCascades: 0,
        post: false,
        anisotropy: 9,
        retainCpuCopies: false,
        powerPreference: "high-performance",
      },
      [],
      harness.limits,
    );
    expect(device.capabilities.quality).toBe("low");
    expect(device.capabilities.anisotropy).toBe(9);
    expect(device.capabilities).toEqual(expected);
  });
});

describe("draw statistics", () => {
  test("[ER-04-03] two steady-state draws count pipeline and bind switches", async () => {
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());

    frame.draw(mesh, material, translation(0, 0, -50));
    frame.draw(mesh, material, translation(1, 0, -50));
    expect(device.stats.drawCalls).toBe(2);
    expect(device.stats.instances).toBe(2);
    expect(device.stats.triangles).toBe(2);
    expect(device.stats.pipelineSwitches).toBe(1);
    // Frame and light bind once (2), material once, object once per draw.
    expect(device.stats.bindGroupSwitches).toBe(5);
    expect(device.stats.culledInstances).toBe(0);
    expect(device.stats.droppedDraws).toBe(0);
    expect(device.stats.gpuErrors).toBe(0);
    expect(
      currentPassLog(harness).filter((line) =>
        line.startsWith("drawIndexed:"),
      ),
    ).toEqual(["drawIndexed:3:1:0:0:0", "drawIndexed:3:1:0:0:0"]);
    device.endFrame();
  });

  test("[ER-04-03] an instanced draw switches to the instanced pipeline once", async () => {
    const { device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const staticMesh = device.createMesh(staticMeshDesc());
    const instancedMesh = device.createMesh(
      staticMeshDesc({
        label: "device-instanced",
        layout: "instanced-transform-v1",
      }),
    );
    const material = device.createMaterial(materialDesc());

    frame.draw(staticMesh, material, translation(0, 0, -50));
    frame.drawInstanced(
      instancedMesh,
      material,
      new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, -50, 1,
      ]),
      1,
    );
    expect(device.stats.drawCalls).toBe(2);
    expect(device.stats.pipelineSwitches).toBe(2);
    expect(device.stats.triangles).toBe(2);
    device.endFrame();
  });

  test("[ER-04-03] no pipeline is created in steady-state frames", async () => {
    const { harness, device } = await initialized();
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());

    const first = device.beginFrame();
    first.setCamera(orthoProjection());
    first.draw(mesh, material, translation(0, 0, -50));
    device.endFrame();
    const pipelinesAfterFirst = harness.device.counts.createRenderPipeline;
    const shadersAfterFirst = harness.device.counts.createShaderModule;
    expect(pipelinesAfterFirst).toBe(1);
    expect(device.stats.pipelinesCreated).toBe(1);

    for (let index = 0; index < 3; index += 1) {
      const frame = device.beginFrame();
      frame.setCamera(orthoProjection());
      frame.draw(mesh, material, translation(0, 0, -50));
      device.endFrame();
      expect(device.stats.drawCalls).toBe(1);
    }
    expect(harness.device.counts.createRenderPipeline).toBe(pipelinesAfterFirst);
    expect(harness.device.counts.createShaderModule).toBe(shadersAfterFirst);
  });

  test("[ER-04-03] duplicate pipeline descriptors return the same handle", async () => {
    const { harness, device } = await initialized();
    const vertex = device.createShaderModule(vertexShaderDesc());
    const fragment = device.createShaderModule(fragmentShaderDesc());
    const desc = pipelineDesc(vertex, fragment);
    const first = device.createPipeline(desc);
    const second = device.createPipeline(desc);
    expect(second).toEqual(first);
    expect(harness.device.counts.createRenderPipeline).toBe(1);
    expect(device.stats.pipelinesCreated).toBe(1);
    expect(device.stats.pipelineCacheHits).toBe(1);
  });

  test("[ER-04-17] a stale mesh or material handle is rejected in dev", async () => {
    const { device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());
    const forgedMesh = { ...mesh, index: mesh.index + 10_000 };
    const forgedMaterial = { ...material, index: material.index + 10_000 };

    expect(
      errorOf(() => frame.draw(forgedMesh, material, orthoProjection())).code,
    ).toBe("E_STALE_HANDLE");
    device.destroy(mesh);
    expect(
      errorOf(() => frame.draw(mesh, material, orthoProjection())).code,
    ).toBe("E_STALE_HANDLE");
    const liveMesh = device.createMesh(staticMeshDesc({ label: "live-mesh" }));
    expect(
      errorOf(() => frame.draw(liveMesh, forgedMaterial, orthoProjection())).code,
    ).toBe("E_STALE_HANDLE");
    expect(device.stats.drawCalls).toBe(0);
    device.endFrame();
  });
});

describe("unlit materials", () => {
  test("[ER-04-11] unlit materials use a distinct built-in pipeline", async () => {
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(staticMeshDesc());
    const lit = device.createMaterial(materialDesc());
    const unlit = device.createMaterial(
      materialDesc({ label: "unlit-material", unlit: true }),
    );

    frame.draw(mesh, lit, translation(0, 0, -50));
    frame.draw(mesh, unlit, translation(1, 0, -50));
    expect(
      harness.device.renderPipelines.map((pipeline) => pipeline.label),
    ).toEqual(["builtin-lit", "builtin-unlit"]);
    expect(device.stats.pipelineSwitches).toBe(2);
    expect(device.stats.drawCalls).toBe(2);
    expect(device.stats.gpuErrors).toBe(0);
    device.endFrame();
  });

  test("[ER-04-11] unlit draws reuse their pipeline across frames", async () => {
    const { harness, device } = await initialized();
    const mesh = device.createMesh(staticMeshDesc());
    const unlit = device.createMaterial(materialDesc({ unlit: true }));

    for (let index = 0; index < 2; index += 1) {
      const frame = device.beginFrame();
      frame.setCamera(orthoProjection());
      frame.draw(mesh, unlit, translation(0, 0, -50));
      device.endFrame();
    }
    expect(harness.device.counts.createRenderPipeline).toBe(1);
    expect(device.stats.pipelinesCreated).toBe(1);
    expect(harness.device.renderPipelines[0]?.label).toBe("builtin-unlit");
    expect(device.stats.gpuErrors).toBe(0);
  });
});

describe("lit path uniforms", () => {
  test("[ER-04-09] a draw uploads the inverse-transpose normal matrix and the fixed M0 light", async () => {
    const { harness, device } = await initialized();
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());
    const model = translation(3, 4, -50);
    model.m[0] = 2;
    model.m[5] = 0.5;

    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    frame.draw(mesh, material, model);
    device.endFrame();
    expect(device.stats.drawCalls).toBe(1);

    const objectCall = harness.device.queue.writeBufferCalls.find(
      (call) => call.buffer.label === "object-ring",
    );
    if (objectCall === undefined) {
      throw new Error("expected an object-ring upload");
    }
    const object = new Float32Array(
      objectCall.bytes.buffer,
      objectCall.bytes.byteOffset,
      objectCall.bytes.byteLength / 4,
    );
    expect(Array.from(object.slice(0, 16))).toEqual([
      2, 0, 0, 0,
      0, 0.5, 0, 0,
      0, 0, 1, 0,
      3, 4, -50, 1,
    ]);
    // Normal matrix is transpose(inverse(model)); zero here was real-GPU black.
    const normal = Array.from(object.slice(16, 28), (value) =>
      value === 0 ? 0 : value,
    );
    expect(normal).toEqual([
      0.5, 0, 0, 0,
      0, 2, 0, 0,
      0, 0, 1, 0,
    ]);

    const lightCall = harness.device.queue.writeBufferCalls.find(
      (call) => call.buffer.label === "light-uniform",
    );
    if (lightCall === undefined) {
      throw new Error("expected a light-uniform upload");
    }
    const light = new Float32Array(
      lightCall.bytes.buffer,
      lightCall.bytes.byteOffset,
      lightCall.bytes.byteLength / 4,
    );
    const lightCounts = new Uint32Array(
      lightCall.bytes.buffer,
      lightCall.bytes.byteOffset,
      4,
    );
    expect(lightCounts[0]).toBe(1);
    expect(light[4]).toBeCloseTo(-0.45, 6);
    expect(light[5]).toBeCloseTo(-0.8, 6);
    expect(light[6]).toBeCloseTo(-0.35, 6);
    expect(Array.from(light.slice(8, 12))).toEqual([1, 1, 1, 1]);
  });
});

describe("frame misuse rules", () => {
  test("[ER-04-17] drawing before a camera is rejected in dev", async () => {
    const { device } = await initialized();
    const frame = device.beginFrame();
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());
    expect(
      errorOf(() => frame.draw(mesh, material, orthoProjection())).code,
    ).toBe("E_CONTRACT");
    frame.setCamera(orthoProjection());
    frame.draw(mesh, material, translation(0, 0, -50));
    expect(device.stats.drawCalls).toBe(1);
    device.endFrame();
  });

  test("[ER-04-17] drawing after endFrame is rejected in dev", async () => {
    const { device } = await initialized();
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());
    frame.draw(mesh, material, orthoProjection());
    device.endFrame();
    expect(
      errorOf(() => frame.draw(mesh, material, orthoProjection())).code,
    ).toBe("E_FRAME_CLOSED");
  });

  test("[ER-04-17] a second beginFrame without endFrame is rejected in dev", async () => {
    const { device } = await initialized();
    device.beginFrame();
    expect(errorOf(() => device.beginFrame()).code).toBe("E_FRAME_CLOSED");
    device.endFrame();
  });
});

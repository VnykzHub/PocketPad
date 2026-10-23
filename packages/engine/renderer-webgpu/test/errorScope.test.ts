/**
 * Error-handling tests (04 §5.10, ER-04-07 partial).
 *
 * Scope: synchronous validation before a GPU call, cached pipeline failures,
 * and the uncaptured-error path (never throws, ends an over-budget frame
 * without submit, listener removed on dispose).
 *
 * Deliberately not covered here: ER-04-07's balanced `pushErrorScope` /
 * `popErrorScope` creation groups are not implemented in this backend, and the
 * frozen `webgpu.d.ts` exposes no load-time checkpoint where a scope could be
 * awaited. The uncaptured handler is the implemented M0 safety net. The
 * remaining ER-04-07 acceptance (browser injection page) is still PENDING and
 * this file is Node-only evidence.
 */

import { describe, expect, test } from "vitest";
import type { ShaderModuleDesc } from "@lanpad/engine-core";
import type { WebGpuRendererDevice } from "../src/device/WebGpuDevice.js";
import {
  errorOf,
  initialized,
  materialDesc,
  orthoProjection,
  staticMeshDesc,
  translation,
} from "./helpers.js";

function vertexShaderDesc(): ShaderModuleDesc {
  return {
    label: "error-vertex",
    stage: "vertex",
    language: "wgsl",
    code: "@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }",
    entryPoint: "vs_main",
    abiVersion: 1,
  };
}

function fragmentShaderDesc(): ShaderModuleDesc {
  return {
    label: "error-fragment",
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
    label: "test-pipeline",
    layoutId: "builtin-pbr-v1",
    vertexShader,
    fragmentShader,
    vertexLayout: "static-pbr-v1",
    colorFormats: ["bgra8unorm"],
    blendStates: ["off"],
  };
}

describe("synchronous validation", () => {
  test("[ER-04-07] an invalid descriptor throws before any GPU call", async () => {
    const { harness, device } = await initialized();
    const textureCalls = harness.device.counts.createTexture;
    const bufferCalls = harness.device.counts.createBuffer;
    const shaderCalls = harness.device.counts.createShaderModule;

    expect(
      errorOf(() =>
        device.createTexture({
          label: "bad-format",
          width: 1,
          height: 1,
          format: "not-a-format",
          usage: ["sample", "copy-dst"],
        } as never),
      ).code,
    ).toBe("E_CONTRACT");
    expect(
      errorOf(() =>
        device.createBuffer({
          label: "bad-size",
          size: 3,
          usage: ["uniform"],
        } as never),
      ).code,
    ).toBe("E_CONTRACT");
    expect(
      errorOf(() =>
        device.createShaderModule({
          label: "empty-source",
          stage: "vertex",
          language: "wgsl",
          code: "",
          entryPoint: "vs_main",
          abiVersion: 1,
        }),
      ).code,
    ).toBe("E_PIPELINE_COMPILE");

    expect(harness.device.counts.createTexture).toBe(textureCalls);
    expect(harness.device.counts.createBuffer).toBe(bufferCalls);
    expect(harness.device.counts.createShaderModule).toBe(shaderCalls);
    expect(device.stats.gpuErrors).toBe(0);
  });

  test("[ER-04-07] a failed pipeline is cached and counted once per key", async () => {
    const { harness, device } = await initialized();
    harness.device.failRenderPipelineLabels.add("test-pipeline");
    const vertex = device.createShaderModule(vertexShaderDesc());
    const fragment = device.createShaderModule(fragmentShaderDesc());
    const desc = pipelineDesc(vertex, fragment);

    expect(errorOf(() => device.createPipeline(desc)).code).toBe(
      "E_PIPELINE_COMPILE",
    );
    expect(harness.device.counts.createRenderPipeline).toBe(1);
    expect(device.stats.gpuErrors).toBe(1);

    // The cached failure is reported without touching the driver again; the
    // first later lookup is counted once, and the count then stays flat.
    expect(errorOf(() => device.createPipeline(desc)).code).toBe(
      "E_PIPELINE_COMPILE",
    );
    expect(harness.device.counts.createRenderPipeline).toBe(1);
    expect(device.stats.gpuErrors).toBe(2);

    expect(errorOf(() => device.createPipeline(desc)).code).toBe(
      "E_PIPELINE_COMPILE",
    );
    expect(harness.device.counts.createRenderPipeline).toBe(1);
    expect(device.stats.gpuErrors).toBe(2);
  });

  test("[ER-04-07] a builtin lit compile failure is counted and drops later draws", async () => {
    const { harness, device } = await initialized();
    harness.device.failRenderPipelineLabels.add("builtin-lit");
    const frame = device.beginFrame();
    frame.setCamera(orthoProjection());
    const mesh = device.createMesh(staticMeshDesc());
    const material = device.createMaterial(materialDesc());

    const error = errorOf(() =>
      frame.draw(mesh, material, translation(0, 0, -50)),
    );
    expect(error.code).toBe("E_PIPELINE_COMPILE");
    expect(device.stats.gpuErrors).toBe(1);
    expect(harness.device.counts.createRenderPipeline).toBe(1);

    // The failure is sticky: the same frame and later frames drop the draw
    // without another compile attempt or a second error count.
    frame.draw(mesh, material, translation(0, 0, -50));
    expect(device.stats.droppedDraws).toBe(1);
    expect(device.stats.gpuErrors).toBe(1);
    device.endFrame();

    const next = device.beginFrame();
    next.setCamera(orthoProjection());
    next.draw(mesh, material, translation(0, 0, -50));
    expect(next.valid).toBe(true);
    expect(device.stats.droppedDraws).toBe(1);
    expect(harness.device.counts.createRenderPipeline).toBe(1);
    device.endFrame();
  });
});

describe("uncaptured errors", () => {
  test("[ER-04-07] uncaptured errors never throw into the loop", async () => {
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    expect(() => {
      for (let index = 0; index < 5; index += 1) {
        harness.device.emitUncapturedError();
      }
    }).not.toThrow();
    expect(device.stats.gpuErrors).toBe(5);
    expect(frame.valid).toBe(true);
    device.endFrame();
  });

  test("[ER-04-07] exactly 100 uncaptured errors still submit the frame", async () => {
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    for (let index = 0; index < 100; index += 1) {
      harness.device.emitUncapturedError();
    }
    expect(frame.valid).toBe(true);
    device.endFrame();
    expect(harness.device.queue.submitCalls.length).toBe(1);
    expect(harness.device.encoders[0]?.passes[0]?.ended).toBe(true);
    expect(device.stats.gpuErrors).toBe(100);
  });

  test("[ER-04-07] the 101st uncaptured error ends the frame without submit", async () => {
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    for (let index = 0; index < 100; index += 1) {
      harness.device.emitUncapturedError();
    }
    expect(frame.valid).toBe(true);
    harness.device.emitUncapturedError();
    expect(frame.valid).toBe(false);
    device.endFrame();
    expect(harness.device.queue.submitCalls.length).toBe(0);
    expect(harness.device.encoders[0]?.passes[0]?.ended).toBe(false);
    expect(device.stats.gpuErrors).toBe(101);

    // The budget resets with the next frame.
    const next = device.beginFrame();
    expect(next.valid).toBe(true);
    harness.device.emitUncapturedError();
    device.endFrame();
    expect(harness.device.queue.submitCalls.length).toBe(1);
  });

  test("[ER-04-07] dispose detaches the uncaptured listener", async () => {
    const { harness, device } = await initialized();
    device.beginFrame();
    harness.device.emitUncapturedError();
    expect(device.stats.gpuErrors).toBe(1);
    device.endFrame();
    device.dispose();
    const errorsAfterDispose = device.stats.gpuErrors;
    harness.device.emitUncapturedError();
    expect(device.stats.gpuErrors).toBe(errorsAfterDispose);
  });
});

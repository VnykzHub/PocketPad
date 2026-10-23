/**
 * Canvas swapchain tests (04 §5.3, ER-04-06).
 *
 * `computeBackingSize` is pure; the remaining cases drive a real `Swapchain`
 * against the fake canvas and fake device recorder. A browser `?resize=1`
 * run is still required for ER-04-06 evidence; these are Node-only facts.
 */

import { describe, expect, test } from "vitest";
import { TEXTURE_USAGE } from "../src/runtime.js";
import {
  Swapchain,
  computeBackingSize,
  isCanvasLike,
} from "../src/swapchain/Swapchain.js";
import { createHarness } from "./fakes/webgpu.js";
import type { Harness } from "./fakes/webgpu.js";
import { errorOf, initialized, orthoProjection } from "./helpers.js";

interface ConfigureDescriptor {
  readonly device: unknown;
  readonly format: string;
  readonly alphaMode: string;
  readonly usage: number;
  readonly colorSpace: string;
}

const FORMAT = "bgra8unorm" as const;
const MAX_TEXTURE_DIMENSION = 8192;

function newSwapchain(
  harness: Harness,
  overrides: { maxRenderHeight?: number; maxTextureDimension2D?: number } = {},
): Swapchain {
  return new Swapchain({
    native: harness.canvas,
    device: harness.device as unknown as GPUDevice,
    format: FORMAT,
    maxTextureDimension2D:
      overrides.maxTextureDimension2D ?? MAX_TEXTURE_DIMENSION,
    maxRenderHeight: overrides.maxRenderHeight ?? 0,
  });
}

function lastConfigure(harness: Harness): ConfigureDescriptor {
  const descriptor =
    harness.context.configureDescriptors[
      harness.context.configureDescriptors.length - 1
    ];
  if (descriptor === undefined) {
    throw new Error("expected a configure call");
  }
  return descriptor as ConfigureDescriptor;
}

describe("backing-store arithmetic", () => {
  test("[ER-04-06] CSS pixels scale by DPR and round to a device pixel", () => {
    expect(computeBackingSize(1280, 720, 1, 0, 8192)).toEqual({
      width: 1280,
      height: 720,
    });
    expect(computeBackingSize(1280, 720, 2, 0, 8192)).toEqual({
      width: 2560,
      height: 1440,
    });
    expect(computeBackingSize(640.4, 360.6, 1, 0, 8192)).toEqual({
      width: 640,
      height: 361,
    });
    expect(computeBackingSize(640.5, 360.5, 1.5, 0, 8192)).toEqual({
      width: 961,
      height: 541,
    });
  });

  test("[ER-04-06] maxRenderHeight caps height only", () => {
    expect(computeBackingSize(1280, 720, 1, 600, 8192)).toEqual({
      width: 1280,
      height: 600,
    });
    expect(computeBackingSize(3840, 2160, 2, 1080, 8192)).toEqual({
      width: 7680,
      height: 1080,
    });
    // A cap above the requested height does nothing.
    expect(computeBackingSize(1280, 720, 1, 2160, 8192)).toEqual({
      width: 1280,
      height: 720,
    });
  });

  test("[ER-04-06] the texture-dimension limit caps both axes and clamps to one", () => {
    expect(computeBackingSize(5000, 4000, 1, 0, 2048)).toEqual({
      width: 2048,
      height: 2048,
    });
    expect(computeBackingSize(0.2, 0.4, 1, 0, 8192)).toEqual({
      width: 1,
      height: 1,
    });
  });

  test("[ER-04-06] a zero CSS dimension yields a zero backing store", () => {
    expect(computeBackingSize(0, 720, 1, 0, 8192)).toEqual({
      width: 0,
      height: 0,
    });
    expect(computeBackingSize(1280, 0, 2, 1080, 8192)).toEqual({
      width: 0,
      height: 0,
    });
  });

  test("[ER-04-06] non-finite or negative metrics are rejected", () => {
    const invalid: readonly (readonly [number, number, number])[] = [
      [Number.NaN, 720, 1],
      [1280, Number.NaN, 1],
      [1280, 720, Number.NaN],
      [Number.POSITIVE_INFINITY, 720, 1],
      [-1, 720, 1],
      [1280, -1, 1],
      [1280, 720, 0],
      [1280, 720, -2],
    ];
    for (const [cssWidth, cssHeight, dpr] of invalid) {
      const error = errorOf(() =>
        computeBackingSize(cssWidth, cssHeight, dpr, 0, 8192),
      );
      expect(error.code).toBe("E_CONTRACT");
    }
  });
});

describe("swapchain construction", () => {
  test("[ER-04-06] only a canvas with a complete WebGPU context is accepted", () => {
    const harness = createHarness();
    const base = {
      device: harness.device as unknown as GPUDevice,
      format: FORMAT,
      maxTextureDimension2D: MAX_TEXTURE_DIMENSION,
      maxRenderHeight: 0,
    };
    expect(isCanvasLike({})).toBe(false);
    expect(isCanvasLike({ width: 1, height: 1 })).toBe(false);
    expect(isCanvasLike(harness.canvas)).toBe(true);
    expect(errorOf(() => new Swapchain({ ...base, native: {} })).code).toBe(
      "E_BACKEND_INIT",
    );
    expect(
      errorOf(
        () =>
          new Swapchain({
            ...base,
            native: { width: 0, height: 0, getContext: () => null },
          }),
      ).code,
    ).toBe("E_BACKEND_INIT");
    expect(
      errorOf(
        () =>
          new Swapchain({
            ...base,
            native: { width: 0, height: 0, getContext: () => ({}) },
          }),
      ).code,
    ).toBe("E_BACKEND_INIT");
  });

  test("[ER-04-06] a fresh swapchain is unconfigured until metrics arrive", () => {
    const harness = createHarness();
    const swapchain = newSwapchain(harness);
    expect(swapchain.isConfigured).toBe(false);
    expect(harness.context.configureCalls).toBe(0);
    // Default metrics are zero, so the first call only settles the zero size.
    expect(swapchain.configureIfNeeded()).toBe(false);
    expect(swapchain.isConfigured).toBe(false);
    expect(harness.context.configureCalls).toBe(0);
    swapchain.setMetrics(320, 200, 1);
    expect(swapchain.configureIfNeeded()).toBe(true);
    expect(swapchain.isConfigured).toBe(true);
    expect(swapchain.canvasWidth).toBe(320);
    expect(swapchain.canvasHeight).toBe(200);
    expect(harness.context.configureCalls).toBe(1);
    // Not dirty: a second call in the same state configures nothing.
    expect(swapchain.configureIfNeeded()).toBe(false);
    expect(harness.context.configureCalls).toBe(1);
  });

  test("[ER-04-06] the texture limit caps a direct swapchain", () => {
    const harness = createHarness();
    const swapchain = newSwapchain(harness, { maxTextureDimension2D: 50 });
    swapchain.setMetrics(100, 80, 1);
    expect(swapchain.configureIfNeeded()).toBe(true);
    expect(harness.canvas.width).toBe(50);
    expect(harness.canvas.height).toBe(50);
  });
});

describe("device swapchain integration", () => {
  test("[ER-04-06] init configures once and size is zero before resize", async () => {
    const { harness, device } = await initialized();
    expect(device.size).toEqual({ width: 0, height: 0 });
    expect(harness.context.configureCalls).toBe(1);
    expect(harness.canvas.width).toBe(64);
    expect(harness.canvas.height).toBe(36);
    const descriptor = lastConfigure(harness);
    expect(descriptor.device).toBe(harness.device);
    expect(descriptor.format).toBe("bgra8unorm");
    expect(descriptor.alphaMode).toBe("opaque");
    expect(descriptor.colorSpace).toBe("srgb");
    expect(descriptor.usage).toBe(
      TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_SRC,
    );
  });

  test("[ER-04-06] ten resizes in one frame configure once", async () => {
    const { harness, device } = await initialized();
    expect(harness.context.configureCalls).toBe(1);
    for (let index = 0; index < 10; index += 1) {
      device.resize(200 + index, 100 + index, 1);
    }
    expect(device.size).toEqual({ width: 209, height: 109 });
    const frame = device.beginFrame();
    expect(frame.valid).toBe(true);
    expect(harness.context.configureCalls).toBe(2);
    expect(harness.canvas.width).toBe(209);
    expect(harness.canvas.height).toBe(109);
    device.endFrame();

    // A second frame with unchanged metrics configures nothing.
    device.beginFrame();
    expect(harness.context.configureCalls).toBe(2);
    device.endFrame();

    // Another burst inside the next frame still yields one configure.
    for (let index = 0; index < 10; index += 1) {
      device.resize(300 + index, 200, 1);
    }
    device.beginFrame();
    expect(harness.context.configureCalls).toBe(3);
    device.endFrame();
  });

  test("[ER-04-06] a zero-size surface returns an invalid frame and does no GPU work", async () => {
    const { harness, device } = await initialized(undefined, 0, 0);
    expect(device.size).toEqual({ width: 0, height: 0 });
    expect(harness.context.configureCalls).toBe(0);
    expect(harness.canvas.width).toBe(0);
    expect(harness.canvas.height).toBe(0);

    const frame = device.beginFrame();
    // The frame is invalid by contract, so camera setup is a dev-time misuse.
    expect(frame.valid).toBe(false);
    expect(errorOf(() => frame.setCamera(orthoProjection())).code).toBe(
      "E_FRAME_CLOSED",
    );
    expect(harness.context.getCurrentTextureCalls).toBe(0);
    expect(harness.device.encoders.length).toBe(0);
    expect(device.stats.drawCalls).toBe(0);

    const mesh = device.createMesh({
      label: "zero-surface-mesh",
      layout: "static-pbr-v1",
      vertices: [new Uint8Array(3 * 32)],
      indices: { data: new Uint16Array([0, 1, 2]), format: "uint16" },
      bounds: { center: { x: 0, y: 0, z: 0 }, radius: 1 },
    });
    const material = device.createMaterial({
      label: "zero-surface-material",
      baseColorFactor: [1, 1, 1, 1],
      metallic: 0,
      roughness: 0.5,
      emissiveFactor: [0, 0, 0],
    });
    const uploadsBefore = device.stats.uploadCalls;
    frame.draw(mesh, material, orthoProjection());
    expect(device.stats.drawCalls).toBe(0);
    expect(device.stats.uploadCalls).toBe(uploadsBefore);
    device.endFrame();
    expect(harness.device.queue.submitCalls.length).toBe(0);
  });

  test("[ER-04-06] shrinking to zero unconfigures the context", async () => {
    const { harness, device } = await initialized();
    const frame = device.beginFrame();
    expect(frame.valid).toBe(true);
    device.endFrame();
    const encodersBefore = harness.device.encoders.length;

    device.resize(0, 0, 1);
    const empty = device.beginFrame();
    expect(empty.valid).toBe(false);
    expect(harness.context.unconfigureCalls).toBe(1);
    expect(harness.canvas.width).toBe(0);
    expect(harness.canvas.height).toBe(0);
    expect(harness.device.encoders.length).toBe(encodersBefore);
    device.endFrame();

    // Growing again reconfigures exactly once.
    device.resize(48, 27, 1);
    const restoredFrame = device.beginFrame();
    expect(restoredFrame.valid).toBe(true);
    expect(harness.context.configureCalls).toBe(2);
    expect(harness.canvas.width).toBe(48);
    expect(harness.canvas.height).toBe(27);
    device.endFrame();
  });

  test("[ER-04-06] a DPR change updates the backing store", async () => {
    const { harness, device } = await initialized(undefined, 100, 50);
    expect(harness.canvas.width).toBe(100);
    expect(harness.canvas.height).toBe(50);
    device.resize(100, 50, 2);
    device.beginFrame();
    expect(harness.canvas.width).toBe(200);
    expect(harness.canvas.height).toBe(100);
    expect(device.size).toEqual({ width: 100, height: 50 });
    device.endFrame();
  });

  test("[ER-04-06] maxRenderHeight caps backing height without touching width", async () => {
    const { harness, device } = await initialized(
      { maxRenderHeight: 30 },
      64,
      36,
    );
    expect(harness.canvas.width).toBe(64);
    expect(harness.canvas.height).toBe(30);
    device.resize(200, 100, 1);
    device.beginFrame();
    expect(harness.canvas.width).toBe(200);
    expect(harness.canvas.height).toBe(30);
    device.endFrame();
  });

  test("[ER-04-06] an outdated acquisition retries configure exactly once", async () => {
    const { harness, device } = await initialized();
    expect(harness.context.configureCalls).toBe(1);
    harness.context.errorQueue.push("swapchain is outdated");

    const frame = device.beginFrame();
    expect(frame.valid).toBe(true);
    expect(harness.context.getCurrentTextureCalls).toBe(2);
    expect(harness.context.configureCalls).toBe(2);
    expect(harness.device.encoders.length).toBe(1);
    device.endFrame();
    expect(harness.device.queue.submitCalls.length).toBe(1);
  });

  test("[ER-04-06] a lost acquisition drives the device into the lost state", async () => {
    const { harness, device } = await initialized();
    harness.context.errorQueue.push("device lost");
    const frame = device.beginFrame();
    expect(frame.valid).toBe(false);
    expect(device.deviceState).toBe("lost");
    expect(device.stats.gpuErrors).toBe(1);
    expect(harness.device.encoders.length).toBe(0);
    device.endFrame();
    expect(harness.device.queue.submitCalls.length).toBe(0);
  });

  test("[ER-04-06] a generic acquisition failure is counted and not thrown", async () => {
    const { harness, device } = await initialized();
    harness.context.errorQueue.push("validation failure");
    const frame = device.beginFrame();
    expect(frame.valid).toBe(false);
    expect(device.deviceState).toBe("running");
    expect(device.stats.gpuErrors).toBe(1);
    expect(harness.device.encoders.length).toBe(0);
    device.endFrame();
  });

  test("[ER-04-06] dispose unconfigures once and rejects later resizes", async () => {
    const { harness, device } = await initialized();
    device.dispose();
    expect(harness.context.unconfigureCalls).toBe(1);
    expect(harness.device.counts.destroy).toBe(1);
    device.dispose();
    expect(harness.context.unconfigureCalls).toBe(1);
    expect(harness.device.counts.destroy).toBe(1);
    expect(errorOf(() => device.resize(10, 10, 1)).code).toBe("E_DEVICE_LOST");
  });
});

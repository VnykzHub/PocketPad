import type { RendererCapabilities, Surface } from "@lanpad/engine-core";
import type { WebGpuDeviceInitResult } from "@lanpad/engine-renderer-webgpu";
import type {
  WebGL2DeviceInitResult,
  WebGL2Probe,
} from "@lanpad/engine-renderer-webgl2";
import type { Canvas2DDevice } from "@lanpad/engine-renderer-webgl2/canvas2d";
import { describe, expect, test } from "vitest";
import {
  selectRenderer,
  type RendererSelectionFactories,
} from "../../src/render/selectRenderer.js";

/**
 * M0 backend selection tests. Factories are injected so the fallback order,
 * sanitized reasons and the 3D refusal are verified without a GPU or DOM.
 * ER-05-07 is the only existing row this suite can honestly tag.
 */

function capabilities(
  backend: "webgpu" | "webgl2" | "canvas2d",
): RendererCapabilities {
  return {
    backend,
    features: new Set<never>(),
    supportedFormats: new Set<never>(),
    quality: "high",
    maxTextureSize: 8192,
    maxTextureLayers: 1,
    maxBindGroups: 4,
    maxUniformBufferBytes: 65_536,
    maxSamples: 4,
    anisotropy: 1,
    directionalLights: 4,
    pointLights: 8,
    shadowCascades: 0,
    supportsPost: false,
    supportsTimestamps: false,
  };
}

function fakeCanvas(label: string): HTMLCanvasElement {
  return {
    label,
    clientWidth: 800,
    clientHeight: 450,
    width: 800,
    height: 450,
    ownerDocument: null,
  } as unknown as HTMLCanvasElement;
}

class FakeGpuDevice {
  initCalls = 0;
  lastSurface: Surface | null = null;
  disposed = false;
  initError: Error | null = null;

  async init(surface: Surface): Promise<void> {
    this.initCalls += 1;
    this.lastSurface = surface;
    if (this.initError !== null) throw this.initError;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function gpuInit(device: FakeGpuDevice): WebGpuDeviceInitResult {
  return {
    backend: "webgpu",
    capabilities:
      capabilities(
        "webgpu",
      ) as unknown as WebGpuDeviceInitResult["capabilities"],
    adapterInfo: "Fake WebGPU",
    device: device as unknown as WebGpuDeviceInitResult["device"],
  };
}

function webgl2Init(device: object): WebGL2DeviceInitResult {
  return {
    backend: "webgl2",
    capabilities:
      capabilities(
        "webgl2",
      ) as unknown as WebGL2DeviceInitResult["capabilities"],
    adapterInfo: "Fake WebGL2",
    device: device as unknown as WebGL2DeviceInitResult["device"],
  };
}

function canvas2dDevice(): Canvas2DDevice {
  return {
    backend: "canvas2d",
    capabilities: capabilities("canvas2d"),
    dispose(): void {
      // Nothing to release in the fake.
    },
  } as unknown as Canvas2DDevice;
}

/** Fails loudly if a backend that should not be reached is called. */
async function forbidden(): Promise<never> {
  throw new Error("backend factory must not be called");
}

function makeFactories(
  overrides: Partial<RendererSelectionFactories>,
): RendererSelectionFactories {
  const base: RendererSelectionFactories = {
    detectWebGpu: () => false,
    createWebGpu: forbidden,
    probeWebGl2: () => ({ available: false, reason: "no-context" }),
    createWebGl2: forbidden,
    createCanvas2D: forbidden,
    createScratchCanvas: () => fakeCanvas("scratch"),
  };
  return Object.assign(base, overrides);
}

describe("renderer selection", () => {
  test("[ER-00-14] selects WebGPU first and initializes it on the host canvas", async () => {
    const host = fakeCanvas("host");
    const device = new FakeGpuDevice();
    let factoryCalls = 0;
    let factoryOptions: unknown = null;

    const result = await selectRenderer({
      canvas: host,
      deviceOptions: { quality: "high" },
      factories: makeFactories({
        detectWebGpu: () => true,
        createWebGpu: async (options) => {
          factoryCalls += 1;
          factoryOptions = options;
          return gpuInit(device);
        },
      }),
    });

    expect(factoryCalls).toBe(1);
    expect(factoryOptions).toEqual({ quality: "high" });
    expect(device.initCalls).toBe(1);
    expect(device.lastSurface?.native).toBe(host);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("webgpu");
    expect(result.capabilities.backend).toBe("webgpu");
    expect(result.device).toBe(device);
    expect(result.adapterInfo).toBe("Fake WebGPU");
    expect(result.canvas).toBe(host);
    expect(result.usedFallback).toBe(false);
    expect(result.attempts).toEqual([
      { backend: "webgpu", ok: true, reason: "selected" },
    ]);
  });

  test("[ER-00-14] probes WebGL2 on a disposable canvas and uses the host canvas after WebGPU is absent", async () => {
    const host = fakeCanvas("host");
    const probeCanvas = fakeCanvas("probe");
    const device = {};
    const probeArguments: (HTMLCanvasElement | null)[] = [];
    const createArguments: HTMLCanvasElement[] = [];

    const result = await selectRenderer({
      canvas: host,
      factories: {
        detectWebGpu: () => false,
        createWebGpu: forbidden,
        createScratchCanvas: () => probeCanvas,
        probeWebGl2: (canvas) => {
          probeArguments.push(canvas);
          return { available: true };
        },
        createWebGl2: async (options) => {
          createArguments.push(options.canvas);
          return webgl2Init(device);
        },
        createCanvas2D: forbidden,
      },
    });

    expect(probeArguments).toEqual([probeCanvas]);
    expect(createArguments).toEqual([host]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("webgl2");
    expect(result.device).toBe(device);
    expect(result.adapterInfo).toBe("Fake WebGL2");
    expect(result.canvas).toBe(host);
    expect(result.usedFallback).toBe(true);
    expect(result.attempts).toEqual([
      { backend: "webgpu", ok: false, reason: "not-detected" },
      { backend: "webgl2", ok: true, reason: "selected" },
    ]);
  });

  test("[ER-00-14] uses a replacement canvas for WebGL2 when a failed WebGPU init claimed the host canvas", async () => {
    const host = fakeCanvas("host");
    const probeCanvas = fakeCanvas("probe");
    const replacement = fakeCanvas("replacement");
    const scratchCanvases = [probeCanvas, replacement];
    let scratchIndex = 0;
    const device = new FakeGpuDevice();
    device.initError = new Error("adapter lost during init");
    const createArguments: HTMLCanvasElement[] = [];

    const result = await selectRenderer({
      canvas: host,
      factories: {
        detectWebGpu: () => true,
        createWebGpu: async () => gpuInit(device),
        createScratchCanvas: () => scratchCanvases[scratchIndex++] ?? null,
        probeWebGl2: (): WebGL2Probe => ({ available: true }),
        createWebGl2: async (options) => {
          createArguments.push(options.canvas);
          return webgl2Init({});
        },
        createCanvas2D: forbidden,
      },
    });

    expect(device.initCalls).toBe(1);
    expect(device.disposed).toBe(true);
    expect(createArguments).toEqual([replacement]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("webgl2");
    expect(result.canvas).toBe(replacement);
    expect(result.attempts).toEqual([
      { backend: "webgpu", ok: false, reason: "init-failed" },
      { backend: "webgl2", ok: true, reason: "selected" },
    ]);
  });

  test("[ER-00-14] falls back to Canvas2D only when neither 3D backend can start", async () => {
    const host = fakeCanvas("host");
    const probeCanvas = fakeCanvas("probe");
    let canvas2dTarget: HTMLCanvasElement | null = null;

    const result = await selectRenderer({
      canvas: host,
      factories: {
        detectWebGpu: () => false,
        createWebGpu: forbidden,
        createScratchCanvas: () => probeCanvas,
        probeWebGl2: () => ({ available: false, reason: "context-threw" }),
        createWebGl2: forbidden,
        createCanvas2D: async (options) => {
          canvas2dTarget = options.canvas;
          return canvas2dDevice();
        },
      },
    });

    expect(canvas2dTarget).toBe(host);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("canvas2d");
    expect(result.capabilities.backend).toBe("canvas2d");
    expect(result.adapterInfo).toBe("Canvas2D");
    expect(result.canvas).toBe(host);
    expect(result.usedFallback).toBe(true);
    expect(result.attempts).toEqual([
      { backend: "webgpu", ok: false, reason: "not-detected" },
      { backend: "webgl2", ok: false, reason: "context-threw" },
      { backend: "canvas2d", ok: true, reason: "selected" },
    ]);
  });

  test("[ER-05-07] refuses a 3D request instead of selecting Canvas2D", async () => {
    const host = fakeCanvas("host");
    let canvas2dCalls = 0;

    const result = await selectRenderer({
      canvas: host,
      require3D: true,
      factories: {
        detectWebGpu: () => false,
        createWebGpu: forbidden,
        createScratchCanvas: () => fakeCanvas("probe"),
        probeWebGl2: () => ({ available: false, reason: "no-context" }),
        createWebGl2: forbidden,
        createCanvas2D: async () => {
          canvas2dCalls += 1;
          return canvas2dDevice();
        },
      },
    });

    expect(canvas2dCalls).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_UNSUPPORTED_FEATURE");
    expect(result.detail).toBe("3d-on-canvas2d");
    expect(result.attempts).toEqual([
      { backend: "webgpu", ok: false, reason: "not-detected" },
      { backend: "webgl2", ok: false, reason: "context-unavailable" },
      { backend: "canvas2d", ok: false, reason: "requires-3d" },
    ]);
  });

  test("[ER-00-14] reports a fixed no-backend failure without leaking exception text", async () => {
    const host = fakeCanvas("host");
    const secret = "https://example.invalid/?token=SECRET";

    const result = await selectRenderer({
      canvas: host,
      factories: {
        detectWebGpu: () => true,
        createWebGpu: async () => {
          throw new Error(secret);
        },
        createScratchCanvas: () => fakeCanvas("probe"),
        probeWebGl2: () => ({ available: false, reason: "blocked" }),
        createWebGl2: forbidden,
        createCanvas2D: async () => {
          throw new Error(secret);
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("E_DEVICE_UNAVAILABLE");
    expect(result.detail).toBe("no-backend");
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("example.invalid");
    expect(result.attempts).toEqual([
      { backend: "webgpu", ok: false, reason: "unavailable" },
      { backend: "webgl2", ok: false, reason: "context-blocked" },
      { backend: "canvas2d", ok: false, reason: "init-failed" },
    ]);
  });
});

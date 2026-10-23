// @req ER-00-14 — manifest-driven renderer selection refuses 3D on Canvas2D.
import type { Canvas2DDevice } from "@lanpad/engine-renderer-webgl2/canvas2d";
import type { GameManifest } from "@lanpad/sdk";
import { describe, expect, test, vi } from "vitest";
import { createGameRenderer } from "../../src/host/stage.js";
import type { RendererSelectionFactories } from "../../src/render/selectRenderer.js";

function manifest(renderer: "canvas2d" | "engine"): GameManifest {
  return {
    schemaVersion: 1,
    name: "Selection Fixture",
    entry: "index.js",
    layouts: ["layouts/default.json"],
    assetBudget: { initialBytes: 1024, totalBytes: 4096 },
    minPlayers: 1,
    maxPlayers: 2,
    needsGyro: false,
    renderer,
  };
}

function fakeCanvas2DDevice(): Canvas2DDevice {
  return {
    size: { width: 640, height: 360 },
    stats: { drawCalls: 0 },
    resize: vi.fn(),
    beginFrame: vi.fn(),
    endFrame: vi.fn(),
    dispose: vi.fn(),
    clear: vi.fn(),
    circle: vi.fn(),
    rect: vi.fn(),
    text: vi.fn(),
    polyline: vi.fn(),
  } as unknown as Canvas2DDevice;
}

interface Fake3DDevice {
  readonly device: {
    backend: "webgl2" | "webgpu";
    capabilities: {
      supportedFormats: Set<string>;
      maxTextureSize: number;
    };
    stats: { drawCalls: number; textureBytes: number };
    size: { width: number; height: number };
    init: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    beginFrame: ReturnType<typeof vi.fn>;
    endFrame: ReturnType<typeof vi.fn>;
    createMesh: ReturnType<typeof vi.fn>;
    createMaterial: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}

function fake3DDevice(
  backend: "webgl2" | "webgpu",
  options: { failInit?: boolean } = {},
): Fake3DDevice {
  const frame = {
    valid: true,
    setCamera: vi.fn(),
    setCameraMatrices: vi.fn(),
    draw: vi.fn(),
    drawInstanced: vi.fn(),
    drawLod: vi.fn(),
    beginPass: vi.fn(),
    drawFullscreen: vi.fn(),
  };
  let nextHandle = 1;
  const device = {
    backend,
    capabilities: {
      supportedFormats: new Set(["rgba8unorm"]),
      maxTextureSize: 8192,
    },
    stats: { drawCalls: 0, textureBytes: 0 },
    size: { width: 0, height: 0 },
    init: options.failInit
      ? vi.fn(async () => {
          throw new Error("webgpu init failed");
        })
      : vi.fn(async () => {}),
    resize: vi.fn(),
    beginFrame: vi.fn(() => frame),
    endFrame: vi.fn(),
    createMesh: vi.fn(() => ({
      index: nextHandle++,
      generation: 1,
      __kind: "mesh",
    })),
    createMaterial: vi.fn(() => ({
      index: nextHandle++,
      generation: 1,
      __kind: "material",
    })),
    destroy: vi.fn(),
    dispose: vi.fn(),
  };
  return { device };
}

type WebGpuFactory = RendererSelectionFactories["createWebGpu"];
type WebGl2Factory = RendererSelectionFactories["createWebGl2"];

const canvas = {} as HTMLCanvasElement;

describe("manifest-driven renderer selection", () => {
  test("[ER-00-14] canvas2d keeps the existing Canvas2D path and never probes 3D", async () => {
    const createWebGpu = vi.fn(async () => {
      throw new Error("must not run");
    });
    const createCanvas2D = vi.fn(async () => fakeCanvas2DDevice());

    const choice = await createGameRenderer({
      canvas,
      manifest: manifest("canvas2d"),
      createCanvas2D,
      factories: {
        detectWebGpu: vi.fn(() => true),
        createWebGpu: createWebGpu as unknown as WebGpuFactory,
      },
    });

    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.backend).toBe("canvas2d");
    expect(choice.renderer.backend).toBe("canvas2d");
    expect(choice.canvas).toBe(canvas);
    expect(createCanvas2D).toHaveBeenCalledTimes(1);
    expect(createWebGpu).not.toHaveBeenCalled();
  });

  test("[ER-00-14] engine selects the WebGPU device and wraps it in the 3D adapter", async () => {
    const gpu = fake3DDevice("webgpu");
    const createWebGpu = vi.fn(async () => ({
      backend: "webgpu" as const,
      capabilities: gpu.device.capabilities,
      adapterInfo: "fixture-gpu",
      device: gpu.device,
    }));
    const createCanvas2D = vi.fn(async () => fakeCanvas2DDevice());

    const choice = await createGameRenderer({
      canvas,
      manifest: manifest("engine"),
      createCanvas2D,
      factories: {
        detectWebGpu: vi.fn(() => true),
        createWebGpu: createWebGpu as unknown as WebGpuFactory,
      },
    });

    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.backend).toBe("webgpu");
    expect(choice.renderer.backend).toBe("webgpu");
    expect(choice.canvas).toBe(canvas);
    expect(gpu.device.init).toHaveBeenCalledTimes(1);
    expect(gpu.device.createMesh).toHaveBeenCalledTimes(1);
    expect(createCanvas2D).not.toHaveBeenCalled();
  });

  test("[ER-00-14] engine refuses Canvas2D when neither 3D backend is available", async () => {
    const createCanvas2D = vi.fn(async () => fakeCanvas2DDevice());

    const choice = await createGameRenderer({
      canvas,
      manifest: manifest("engine"),
      createCanvas2D,
      factories: {
        detectWebGpu: vi.fn(() => false),
        probeWebGl2: vi.fn(() => ({
          available: false,
          reason: "no-context" as const,
        })),
      },
    });

    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.reason).toBe("3d-unavailable");
    expect(choice.message).toContain("3D renderer");
    expect(choice.canvas).toBe(canvas);
    expect(createCanvas2D).not.toHaveBeenCalled();
  });

  test("[ER-00-14] engine falls back to WebGL2 and reports the replacement canvas", async () => {
    const webgpu = fake3DDevice("webgpu", { failInit: true });
    const webgl2 = fake3DDevice("webgl2");
    const replacement = {} as HTMLCanvasElement;
    const createWebGl2 = vi.fn(async () => ({
      backend: "webgl2" as const,
      capabilities: webgl2.device.capabilities,
      adapterInfo: "fixture-webgl2",
      device: webgl2.device,
    }));

    const choice = await createGameRenderer({
      canvas,
      manifest: manifest("engine"),
      factories: {
        detectWebGpu: vi.fn(() => true),
        createWebGpu: (async () => ({
          backend: "webgpu" as const,
          capabilities: webgpu.device.capabilities,
          adapterInfo: "fixture-gpu",
          device: webgpu.device,
        })) as unknown as WebGpuFactory,
        probeWebGl2: vi.fn(() => ({ available: true })),
        createWebGl2: createWebGl2 as unknown as WebGl2Factory,
        createScratchCanvas: vi.fn(() => replacement),
      },
    });

    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.backend).toBe("webgl2");
    expect(choice.usedFallback).toBe(true);
    expect(choice.canvas).toBe(replacement);
    expect(webgpu.device.dispose).toHaveBeenCalledTimes(1);
    expect(webgl2.device.createMesh).toHaveBeenCalledTimes(1);
  });
});

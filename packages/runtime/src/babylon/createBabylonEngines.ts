/**
 * Real Babylon engine creation, isolated behind a dynamic import.
 *
 * `createBabylonRenderer` imports this module only when no test seams are
 * supplied, so unit tests can exercise the factory without loading Babylon's
 * module graph (which is large enough to matter in the full Vitest run).
 */
import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import type { BabylonEngine } from "./BabylonGameRenderer.js";

export async function createWebGpuEngine(
  canvas: HTMLCanvasElement,
): Promise<BabylonEngine> {
  if (!(await WebGPUEngine.IsSupportedAsync)) {
    throw new Error("WebGPU is not supported");
  }
  const engine = new WebGPUEngine(canvas, {
    antialias: true,
    adaptToDeviceRatio: false,
  });
  await engine.initAsync();
  return engine;
}

export function createWebGl2Engine(canvas: HTMLCanvasElement): BabylonEngine {
  return new Engine(
    canvas,
    true,
    {
      preserveDrawingBuffer: true,
      stencil: true,
      powerPreference: "high-performance",
    },
    false,
  );
}

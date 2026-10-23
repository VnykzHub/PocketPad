// @req ER-21-09 — both backends unavailable is fixed copy, never an exception.
// @req ER-21-03 — forced WebGL2 selects the fallback without trying WebGPU.
import { describe, expect, test, vi } from "vitest";
import type { BabylonEngine } from "../../src/babylon/BabylonGameRenderer.js";
import {
  BABYLON_UNAVAILABLE_MESSAGE,
  createBabylonGameRenderer,
} from "../../src/babylon/createBabylonRenderer.js";

function fakeCanvas(): HTMLCanvasElement {
  return { ownerDocument: null } as unknown as HTMLCanvasElement;
}

function fakeEngine(): BabylonEngine {
  return {
    setHardwareScalingLevel: vi.fn(),
  } as unknown as BabylonEngine;
}

describe("Babylon engine factory", () => {
  test("[ER-21-09] both backends failing returns fixed copy and no throw", async () => {
    const result = await createBabylonGameRenderer({
      canvas: fakeCanvas(),
      seams: {
        createWebGpu: () => Promise.reject(new Error("secret adapter detail")),
        createWebGl2: () => {
          throw new Error("secret gl detail");
        },
        createCanvas: () => fakeCanvas(),
      },
    });

    expect(result).toEqual({
      ok: false,
      reason: "unavailable",
      message: BABYLON_UNAVAILABLE_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("[ER-21-09] a failed WebGPU attempt gets a fresh canvas for WebGL2", async () => {
    const original = fakeCanvas();
    const replacement = fakeCanvas();
    const engine = fakeEngine();
    const createWebGl2 = vi.fn(() => engine);

    const result = await createBabylonGameRenderer({
      canvas: original,
      seams: {
        createWebGpu: () => Promise.reject(new Error("no adapter")),
        createWebGl2,
        createCanvas: () => replacement,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("webgl2");
    expect(result.usedFallback).toBe(true);
    expect(result.canvas).toBe(replacement);
    expect(createWebGl2).toHaveBeenCalledWith(replacement);
  });

  test("[ER-21-03] forcing WebGL2 skips the WebGPU attempt", async () => {
    const createWebGpu = vi.fn(() => Promise.reject(new Error("unused")));
    const result = await createBabylonGameRenderer({
      canvas: fakeCanvas(),
      forceBackend: "webgl2",
      seams: {
        createWebGpu,
        createWebGl2: () => fakeEngine(),
        createCanvas: () => fakeCanvas(),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("webgl2");
    expect(createWebGpu).not.toHaveBeenCalled();
  });

  test("[ER-21-09] a WebGPU engine is selected without a fallback", async () => {
    const result = await createBabylonGameRenderer({
      canvas: fakeCanvas(),
      seams: {
        createWebGpu: () => Promise.resolve(fakeEngine()),
        createWebGl2: () => {
          throw new Error("must not be called");
        },
        createCanvas: () => fakeCanvas(),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.backend).toBe("webgpu");
    expect(result.usedFallback).toBe(false);
  });
});

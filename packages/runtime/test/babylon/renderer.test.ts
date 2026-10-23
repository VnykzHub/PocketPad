// @req ER-21-10 — dispose is idempotent and frees the engine exactly once.
import { describe, expect, test, vi } from "vitest";
import {
  BabylonGameRenderer,
  type BabylonEngine,
} from "../../src/babylon/BabylonGameRenderer.js";

function fakeEngine(): BabylonEngine {
  return {
    setHardwareScalingLevel: vi.fn(),
    dispose: vi.fn(),
  } as unknown as BabylonEngine;
}

function fakeCanvas(): HTMLCanvasElement {
  return {} as HTMLCanvasElement;
}

describe("BabylonGameRenderer lifecycle", () => {
  test("[ER-21-10] dispose is idempotent and frees the engine once", () => {
    const engine = fakeEngine();
    const renderer = new BabylonGameRenderer(
      engine,
      fakeCanvas(),
      "webgpu",
    );

    renderer.dispose();
    renderer.dispose();

    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  test("[ER-21-10] drawCube before init is a programming error", () => {
    const renderer = new BabylonGameRenderer(
      fakeEngine(),
      fakeCanvas(),
      "webgl2",
    );

    expect(() =>
      renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#fff", 0),
    ).toThrow(/init\(\) must complete/);
    renderer.dispose();
  });
});

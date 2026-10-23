/**
 * ER-05-07 / ER-05-08: the Canvas2D Tier C entry (05 §5.10).
 *
 * A fake 2D context records every call. These tests prove the draw semantics,
 * the resize/DPR/backing-store rules and that every 3D call is refused with
 * `E_UNSUPPORTED_FEATURE` instead of being a silent stub. Real pixel output is
 * out of scope for Node tests.
 */

import { describe, expect, test } from "vitest";
import type { Surface } from "@lanpad/engine-core";
import {
  CANVAS2D_BACKGROUND,
  createCanvas2DDevice,
} from "../src/canvas2d.js";
import type { Canvas2DDevice } from "../src/contracts/canvas2d.js";
import { errorCodeOf, identity, rejectionCode } from "./helpers.js";
import { wireCanvas2D } from "./fake/canvas.js";
import { FakeCanvas, createFake2DContext } from "./fake/webgl2.js";

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected the call to throw, but it returned.");
}

function surfaceOf(canvas: FakeCanvas): Surface {
  return {
    kind: "canvas",
    native: canvas.asCanvas(),
    cssWidth: canvas.clientWidth,
    cssHeight: canvas.clientHeight,
    dpr: 1,
  };
}

async function makeDevice(options: {
  readonly width?: number;
  readonly height?: number;
  readonly maxRenderHeight?: number;
  readonly tvProfile?: boolean;
} = {}): Promise<{
  device: Canvas2DDevice;
  canvas: FakeCanvas;
  fake: ReturnType<typeof createFake2DContext>["fake"];
}> {
  const wired = wireCanvas2D({
    ...(options.width !== undefined ? { clientWidth: options.width } : {}),
    ...(options.height !== undefined ? { clientHeight: options.height } : {}),
  });
  const deviceOptions = {
    canvas: wired.canvas.asCanvas(),
    ...(options.maxRenderHeight !== undefined
      ? { maxRenderHeight: options.maxRenderHeight }
      : {}),
    ...(options.tvProfile !== undefined ? { tvProfile: options.tvProfile } : {}),
  };
  const device = await createCanvas2DDevice(deviceOptions);
  return { device, canvas: wired.canvas, fake: wired.fake };
}

describe("[ER-05-07] Canvas2D factory and capabilities", () => {
  test("[ER-05-07] the factory asks for exactly one 2D context with no attributes", async () => {
    const { canvas } = await makeDevice();
    expect(canvas.getContextCalls).toHaveLength(1);
    expect(canvas.getContextCalls[0]?.type).toBe("2d");
    expect(canvas.getContextCalls[0]?.attributes).toBeUndefined();
  });

  test("[ER-05-07] capabilities describe a 2D-only backend", async () => {
    const { device } = await makeDevice();
    expect(device.backend).toBe("canvas2d");
    expect(device.capabilities.backend).toBe("canvas2d");
    expect(device.capabilities.quality).toBe("off");
    expect(device.capabilities.features.size).toBe(0);
    expect(device.features.size).toBe(0);
    expect(device.capabilities.supportedFormats.size).toBe(0);
    expect(device.capabilities.maxTextureSize).toBe(0);
    expect(device.capabilities.maxTextureLayers).toBe(0);
    expect(device.capabilities.maxBindGroups).toBe(0);
    expect(device.capabilities.maxUniformBufferBytes).toBe(0);
    expect(device.capabilities.maxSamples).toBe(1);
    expect(device.capabilities.anisotropy).toBe(0);
    expect(device.capabilities.directionalLights).toBe(0);
    expect(device.capabilities.pointLights).toBe(0);
    expect(device.capabilities.shadowCascades).toBe(0);
    expect(device.capabilities.supportsPost).toBe(false);
    expect(device.capabilities.supportsTimestamps).toBe(false);
    expect(Object.isFrozen(device.capabilities)).toBe(true);
  });

  test("[ER-05-07] every device limit is zero", async () => {
    const { device } = await makeDevice();
    for (const value of Object.values(device.limits)) expect(value).toBe(0);
    expect(Object.keys(device.limits)).toHaveLength(11);
  });

  test("[ER-05-07] creation sizes the backing store from the CSS box at DPR 1", async () => {
    const { device, canvas, fake } = await makeDevice();
    expect(device.size).toEqual({ width: 640, height: 360 });
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(360);
    expect(canvas.style.width).toBe("640px");
    expect(canvas.style.height).toBe("360px");
    expect(fake.lastCall("setTransform")?.args).toEqual([1, 0, 0, 1, 0, 0]);
  });

  test("[ER-05-07] a missing 2D context rejects E_DEVICE_UNAVAILABLE", async () => {
    const canvas = new FakeCanvas();
    expect(await rejectionCode(createCanvas2DDevice({ canvas: canvas.asCanvas() }))).toBe(
      "E_DEVICE_UNAVAILABLE",
    );
  });

  test("[ER-05-07] a throwing getContext rejects E_DEVICE_UNAVAILABLE with the cause", async () => {
    const canvas = new FakeCanvas();
    canvas.contextThrows = true;
    let message = "";
    try {
      await createCanvas2DDevice({ canvas: canvas.asCanvas() });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Could not create a 2D context: fake getContext failure");
  });

  test("[ER-05-07] the 2D entry registers no context-loss listeners", async () => {
    const { canvas } = await makeDevice();
    expect(canvas.listenerCount("webglcontextlost")).toBe(0);
    expect(canvas.listenerCount("webglcontextrestored")).toBe(0);
  });
});

describe("[ER-05-07] Canvas2D resize", () => {
  test("[ER-05-07] DPR scales the backing store and the drawing transform", async () => {
    const { device, canvas, fake } = await makeDevice();
    device.resize(800, 600, 2);
    expect(device.size).toEqual({ width: 800, height: 600 });
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("600px");
    expect(fake.lastCall("setTransform")?.args).toEqual([2, 0, 0, 2, 0, 0]);
  });

  test("[ER-05-07] maxRenderHeight caps the backing store proportionally", async () => {
    const { device, canvas, fake } = await makeDevice({ maxRenderHeight: 100 });
    device.resize(800, 600, 2);
    expect(canvas.width).toBe(133);
    expect(canvas.height).toBe(100);
    expect(device.size).toEqual({ width: 800, height: 600 });
    expect(fake.lastCall("setTransform")?.args).toEqual([133 / 800, 0, 0, 100 / 600, 0, 0]);
  });

  test("[ER-05-07] the TV profile caps 1080p backing at DPR 2", async () => {
    const { device, canvas } = await makeDevice({ tvProfile: true });
    device.resize(1920, 1080, 2);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    expect(device.size).toEqual({ width: 1920, height: 1080 });
  });

  test("[ER-05-07] a zero-size surface keeps a 1x1 canvas and an invalid frame", async () => {
    const { device, canvas } = await makeDevice();
    device.resize(0, 0, 1);
    expect(device.size).toEqual({ width: 0, height: 0 });
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
    const frame = device.beginFrame();
    expect(frame.valid).toBe(false);
    device.endFrame();
  });
});

describe("[ER-05-08] Canvas2D drawing", () => {
  test("[ER-05-08] beginFrame fills the fixed background over the CSS box", async () => {
    const { device, fake } = await makeDevice();
    const frame = device.beginFrame();
    expect(frame.valid).toBe(true);
    expect(fake.fillStyle).toBe(CANVAS2D_BACKGROUND);
    expect(CANVAS2D_BACKGROUND).toBe("#0b0f14");
    expect(fake.lastCall("fillRect")?.args).toEqual([0, 0, 640, 360]);
    expect(device.stats.drawCalls).toBe(0);
    device.endFrame();
  });

  test("[ER-05-08] circle, rect and text record one draw call each", async () => {
    const { device, fake } = await makeDevice();
    device.beginFrame();

    device.circle(10, 20, 5, "#ff0000");
    expect(fake.lastCall("beginPath")?.args).toEqual([]);
    expect(fake.lastCall("arc")?.args).toEqual([10, 20, 5, 0, Math.PI * 2]);
    expect(fake.fillStyle).toBe("#ff0000");
    expect(fake.lastCall("fill")?.args).toEqual([]);
    expect(device.stats.drawCalls).toBe(1);

    device.rect(1, 2, 3, 4, "#00ff00");
    expect(fake.lastCall("fillRect")?.args).toEqual([1, 2, 3, 4]);
    expect(device.stats.drawCalls).toBe(2);

    device.text("score", 30, 40, 16, "#ffffff", "center");
    expect(fake.font).toBe("16px sans-serif");
    expect(fake.textAlign).toBe("center");
    expect(fake.lastCall("fillText")?.args).toEqual(["score", 30, 40]);
    expect(device.stats.drawCalls).toBe(3);

    device.text("small", 0, 0, 0, "#ffffff");
    expect(fake.font).toBe("1px sans-serif");
    expect(fake.textAlign).toBe("left");
    expect(device.stats.drawCalls).toBe(4);

    device.endFrame();
  });

  test("[ER-05-08] polyline strokes once and an empty polyline is a no-op", async () => {
    const { device, fake } = await makeDevice();
    device.beginFrame();

    device.polyline(
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
      0,
      "#abcdef",
    );
    expect(fake.count("beginPath")).toBe(1);
    expect(fake.lastCall("moveTo")?.args).toEqual([1, 2]);
    const lineTo = fake.calls
      .filter((call) => call.name === "lineTo")
      .map((call) => call.args);
    expect(lineTo).toEqual([
      [3, 4],
      [5, 6],
    ]);
    expect(fake.strokeStyle).toBe("#abcdef");
    expect(fake.lineWidth).toBe(1);
    expect(fake.count("stroke")).toBe(1);
    expect(device.stats.drawCalls).toBe(1);

    device.polyline([], 2, "#abcdef");
    expect(fake.count("beginPath")).toBe(1);
    expect(fake.count("stroke")).toBe(1);
    expect(device.stats.drawCalls).toBe(1);

    device.endFrame();
  });

  test("[ER-05-08] clear paints the requested colour and is not a draw call", async () => {
    const { device, fake } = await makeDevice();
    device.beginFrame();
    device.clear("#123456");
    expect(fake.fillStyle).toBe("#123456");
    expect(fake.lastCall("fillRect")?.args).toEqual([0, 0, 640, 360]);
    expect(device.stats.drawCalls).toBe(0);
    device.endFrame();
  });

  test("[ER-05-08] per-frame counters reset on the next beginFrame", async () => {
    const { device } = await makeDevice();
    device.beginFrame();
    device.circle(0, 0, 1, "#fff");
    device.rect(0, 0, 1, 1, "#fff");
    expect(device.stats.drawCalls).toBe(2);
    device.endFrame();

    device.beginFrame();
    expect(device.stats.drawCalls).toBe(0);
    device.circle(0, 0, 1, "#fff");
    expect(device.stats.drawCalls).toBe(1);
    device.endFrame();
  });

  test("[ER-05-08] a closed frame refuses 2D calls with E_FRAME_CLOSED", async () => {
    const { device } = await makeDevice();
    expect(errorCodeOf(() => device.circle(0, 0, 1, "#fff"))).toBe("E_FRAME_CLOSED");
    expect(errorCodeOf(() => device.rect(0, 0, 1, 1, "#fff"))).toBe("E_FRAME_CLOSED");
    expect(errorCodeOf(() => device.text("x", 0, 0, 10, "#fff"))).toBe("E_FRAME_CLOSED");
    expect(errorCodeOf(() => device.polyline([{ x: 0, y: 0 }], 1, "#fff"))).toBe(
      "E_FRAME_CLOSED",
    );
    expect(errorCodeOf(() => device.clear("#fff"))).toBe("E_FRAME_CLOSED");

    device.beginFrame();
    device.endFrame();
    expect(errorCodeOf(() => device.circle(0, 0, 1, "#fff"))).toBe("E_FRAME_CLOSED");
  });

  test("[ER-05-08] frame validity tracks the open frame and the surface size", async () => {
    const { device } = await makeDevice();
    const frame = device.beginFrame();
    expect(frame.valid).toBe(true);
    device.endFrame();
    expect(frame.valid).toBe(false);
  });
});

describe("[ER-05-07] Canvas2D 3D refusals", () => {
  test("[ER-05-07] every 3D resource call throws E_UNSUPPORTED_FEATURE", async () => {
    const { device } = await makeDevice();
    const operations: ReadonlyArray<readonly [string, () => unknown]> = [
      ["createShaderModule", () => device.createShaderModule(undefined as never)],
      ["createPipeline", () => device.createPipeline(undefined as never)],
      ["createTexture", () => device.createTexture(undefined as never)],
      ["createSampler", () => device.createSampler(undefined as never)],
      ["createBuffer", () => device.createBuffer(undefined as never)],
      ["writeBuffer", () => device.writeBuffer(undefined as never, 0, new Uint8Array(0))],
      ["createMesh", () => device.createMesh(undefined as never)],
      ["createLodGroup", () => device.createLodGroup(undefined as never)],
      ["createMaterial", () => device.createMaterial(undefined as never)],
      ["createRenderTarget", () => device.createRenderTarget(undefined as never)],
    ];
    for (const [operation, call] of operations) {
      const error = thrown(call);
      expect(error.name).toBe("EngineError");
      expect((error as { code?: string }).code).toBe("E_UNSUPPORTED_FEATURE");
      expect((error as { layer?: string }).layer).toBe("renderer");
      expect((error as { recoverable?: boolean }).recoverable).toBe(false);
      expect(error.message).toContain("This device provides only 2D drawing.");
      expect(error.message).toContain("(3d-on-canvas2d)");
      expect(error.message.endsWith(`[${operation}]`)).toBe(true);
    }
  });

  test("[ER-05-07] every 3D frame call throws E_UNSUPPORTED_FEATURE", async () => {
    const { device } = await makeDevice();
    const frame = device.beginFrame();
    const operations: ReadonlyArray<readonly [string, () => unknown]> = [
      ["RenderFrame.setCamera", () => frame.setCamera(identity())],
      ["RenderFrame.setCameraMatrices", () => frame.setCameraMatrices(identity(), identity())],
      [
        "RenderFrame.draw",
        () => frame.draw(undefined as never, undefined as never, identity()),
      ],
      [
        "RenderFrame.drawInstanced",
        () =>
          frame.drawInstanced(
            undefined as never,
            undefined as never,
            new Float32Array(16),
            1,
          ),
      ],
      [
        "RenderFrame.drawLod",
        () => frame.drawLod(undefined as never, undefined as never, identity()),
      ],
      ["RenderFrame.beginPass", () => frame.beginPass(undefined as never)],
      [
        "RenderFrame.drawFullscreen",
        () => frame.drawFullscreen(undefined as never, undefined as never),
      ],
    ];
    for (const [operation, call] of operations) {
      const error = thrown(call);
      expect((error as { code?: string }).code).toBe("E_UNSUPPORTED_FEATURE");
      expect(error.message.endsWith(`[${operation}]`)).toBe(true);
    }
    expect(frame.valid).toBe(true);
    device.endFrame();
  });

  test("[ER-05-07] readTexture and captureFrame reject E_UNSUPPORTED_FEATURE", async () => {
    const { device } = await makeDevice();
    expect(
      await rejectionCode(device.readTexture(undefined as never, undefined as never)),
    ).toBe("E_UNSUPPORTED_FEATURE");
    expect(await rejectionCode(device.captureFrame())).toBe("E_UNSUPPORTED_FEATURE");
  });

  test("[ER-05-07] destroy refuses because a 2D device owns no GPU handles", async () => {
    const { device } = await makeDevice();
    expect(errorCodeOf(() => device.destroy(undefined as never))).toBe("E_STALE_HANDLE");
  });
});

describe("[ER-05-07] Canvas2D lifecycle", () => {
  test("[ER-05-07] dispose is idempotent and drops later draws silently", async () => {
    const { device, fake } = await makeDevice();
    device.dispose();
    device.dispose();
    expect(() => device.circle(0, 0, 1, "#fff")).not.toThrow();
    expect(() => device.clear("#fff")).not.toThrow();
    expect(device.stats.droppedDraws).toBe(2);
    expect(fake.count("fill")).toBe(0);
    expect(device.beginFrame().valid).toBe(false);
    expect(device.beginFrame().valid).toBe(false);
  });

  test("[ER-05-07] restore reports ok while alive and disposed after dispose", async () => {
    const { device } = await makeDevice();
    expect(await device.restore()).toEqual({
      ok: true,
      restoredHandles: 0,
      staleHandles: 0,
    });
    device.dispose();
    expect(await device.restore()).toEqual({
      ok: false,
      reason: "disposed",
      restoredHandles: 0,
      staleHandles: 0,
    });
  });

  test("[ER-05-07] init rejects a foreign canvas and a non-canvas surface", async () => {
    const { device } = await makeDevice();
    const other = new FakeCanvas();
    expect(await rejectionCode(device.init(surfaceOf(other)))).toBe("E_CONTRACT");

    const offscreen = {
      kind: "offscreen",
      native: other.asCanvas(),
      cssWidth: 10,
      cssHeight: 10,
      dpr: 1,
    } as unknown as Surface;
    expect(await rejectionCode(device.init(offscreen))).toBe("E_CONTRACT");
  });

  test("[ER-05-07] init after dispose rejects E_DEVICE_LOST", async () => {
    const { device, canvas } = await makeDevice();
    device.dispose();
    const own = surfaceOf(canvas);
    expect(await rejectionCode(device.init(own))).toBe("E_DEVICE_LOST");
  });

  test("[ER-05-07] listeners unregister independently", async () => {
    const { device } = await makeDevice();
    let lost = 0;
    let restored = 0;
    const offLost = device.onDeviceLost(() => {
      lost += 1;
    });
    const offRestored = device.onRestored(() => {
      restored += 1;
    });
    offLost();
    offRestored();
    offLost();
    device.dispose();
    expect(lost).toBe(0);
    expect(restored).toBe(0);
  });
});

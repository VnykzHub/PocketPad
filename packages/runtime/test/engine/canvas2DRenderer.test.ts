// @req ER-05-08 — the adapter preserves the engine Canvas2D drawing semantics.
import type { Canvas2DDevice } from "@lanpad/engine-renderer-webgl2/canvas2d";
import { describe, expect, test, vi } from "vitest";
import { createEngineCanvas2DRenderer } from "../../src/engine/canvas2DRenderer.js";

interface FakeDevice {
  readonly device: Canvas2DDevice;
  readonly calls: string[];
  readonly stats: { drawCalls: number };
}

function fakeDevice(): FakeDevice {
  const calls: string[] = [];
  const stats = { drawCalls: 0 };
  const record = (name: string) => () => {
    calls.push(name);
  };
  const device = {
    size: { width: 1280, height: 720 },
    stats,
    resize: vi.fn((width: number, height: number, dpr: number) => {
      calls.push(`resize:${width}x${height}@${dpr}`);
      device.size = { width, height };
    }),
    beginFrame: vi.fn(record("beginFrame")),
    endFrame: vi.fn(record("endFrame")),
    dispose: vi.fn(record("dispose")),
    clear: vi.fn((color: string) => calls.push(`clear:${color}`)),
    circle: vi.fn((x: number, y: number, r: number, color: string) =>
      calls.push(`circle:${x},${y},${r},${color}`),
    ),
    rect: vi.fn((x: number, y: number, w: number, h: number, color: string) =>
      calls.push(`rect:${x},${y},${w},${h},${color}`),
    ),
    text: vi.fn(
      (text: string, x: number, y: number, size: number, color: string, align?: string) =>
        calls.push(`text:${text},${x},${y},${size},${color},${align ?? "left"}`),
    ),
    polyline: vi.fn(
      (points: ReadonlyArray<{ x: number; y: number }>, width: number, color: string) =>
        calls.push(`polyline:${points.length},${width},${color}`),
    ),
  };
  return { device: device as unknown as Canvas2DDevice, calls, stats };
}

const canvas = {} as HTMLCanvasElement;

describe("engine Canvas2D adapter", () => {
  test("[ER-05-08] forwards the frame lifecycle and reports device stats", async () => {
    const fake = fakeDevice();
    const renderer = createEngineCanvas2DRenderer(fake.device, canvas);

    renderer.beginFrame(0.5);
    fake.stats.drawCalls = 7;
    expect(renderer.drawCalls).toBe(7);
    renderer.endFrame();

    expect(fake.calls).toEqual(["beginFrame", "endFrame"]);
    expect(renderer.textureMemoryMB).toBe(0);
    expect(renderer.size).toEqual({ width: 1280, height: 720 });
    expect(renderer.backend).toBe("canvas2d");
  });

  test("[ER-05-08] forwards every 2D call without changing its arguments", () => {
    const fake = fakeDevice();
    const renderer = createEngineCanvas2DRenderer(fake.device, canvas);
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 20 },
    ];

    renderer.clear("#0b0f14");
    renderer.circle(4, 5, 6, "#ff0000");
    renderer.rect(1, 2, 3, 4, "#00ff00");
    renderer.text("hi", 7, 8, 9, "#ffffff", "center");
    renderer.polyline(points, 2, "#0000ff");

    expect(fake.calls).toEqual([
      "clear:#0b0f14",
      "circle:4,5,6,#ff0000",
      "rect:1,2,3,4,#00ff00",
      "text:hi,7,8,9,#ffffff,center",
      "polyline:2,2,#0000ff",
    ]);
  });

  test("[ER-05-08] clamps a negative circle radius the way the legacy renderer did", () => {
    const fake = fakeDevice();
    const renderer = createEngineCanvas2DRenderer(fake.device, canvas);

    renderer.circle(1, 2, -5, "#ffffff");

    expect(fake.calls).toEqual(["circle:1,2,0,#ffffff"]);
  });

  test("[ER-05-08] init returns Canvas2D capabilities and refuses a foreign canvas", async () => {
    const fake = fakeDevice();
    const renderer = createEngineCanvas2DRenderer(fake.device, canvas);

    await expect(renderer.init(canvas)).resolves.toEqual({
      maxTextureSize: 0,
      compressedFormats: [],
    });
    await expect(renderer.init({} as HTMLCanvasElement)).rejects.toThrow(
      "different canvas",
    );
  });

  test("[ER-05-08] refuses 3D calls instead of drawing flat cubes", () => {
    const fake = fakeDevice();
    const renderer = createEngineCanvas2DRenderer(fake.device, canvas);

    expect(() => renderer.setCamera({ x: 0, y: 0, z: 3 }, { x: 0, y: 0, z: 0 })).toThrow(
      "3D drawing is not available",
    );
    expect(() =>
      renderer.drawCube({ x: 0, y: 0, z: 0 }, 1, "#ffffff", 0),
    ).toThrow("3D drawing is not available");
  });

  test("[ER-05-08] dispose forwards once and is idempotent", () => {
    const fake = fakeDevice();
    const renderer = createEngineCanvas2DRenderer(fake.device, canvas);

    renderer.dispose();
    renderer.dispose();

    expect(fake.calls).toEqual(["dispose"]);
  });
});

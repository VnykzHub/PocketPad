/**
 * Coin Run design-space render contract (FR-9.4, HP-04).
 *
 * The host canvas is ~1052x592 CSS pixels, not the 1280x720 the drawing code
 * uses. Every draw call must go through one uniform scale plus a centred
 * offset so ground, players, coins, HUD and results land in the same
 * letterboxed rectangle. A surface that reports no size keeps the 1:1 design
 * space (test doubles and 3D-only backends).
 */
import { describe, expect, test } from "vitest";
import { createCamera } from "../src/camera.js";
import { HudCache } from "../src/hud.js";
import type { LevelData } from "../src/level.js";
import {
  drawCoinRun,
  type Renderer2DLike,
  type RendererSize,
} from "../src/render.js";
import { World } from "../src/world.js";

interface RectCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface CircleCall {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

interface TextCall {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

interface Recorder {
  readonly surface: Renderer2DLike;
  readonly rects: RectCall[];
  readonly circles: CircleCall[];
  readonly texts: TextCall[];
}

/** Records every flat draw call; optionally reports a CSS surface size. */
function createRecorder(size?: RendererSize): Recorder {
  const rects: RectCall[] = [];
  const circles: CircleCall[] = [];
  const texts: TextCall[] = [];
  const base = {
    beginFrame(): void {},
    endFrame(): void {},
    clear(): void {},
    rect(x: number, y: number, w: number, h: number): void {
      rects.push({ x, y, w, h });
    },
    circle(x: number, y: number, r: number): void {
      circles.push({ x, y, r });
    },
    text(value: string, x: number, y: number, textSize: number): void {
      texts.push({ text: value, x, y, size: textSize });
    },
  };
  const surface: Renderer2DLike = size === undefined ? base : { ...base, size };
  return { surface, rects, circles, texts };
}

const level: LevelData = {
  version: 1,
  width: 24,
  height: 18,
  killY: 21,
  spawns: [{ x: 2, y: 15.6 }],
  platforms: [{ x: 0, y: 16, w: 24, h: 2 }],
  checkpoints: [{ x: 4, y: 14.9 }],
  coins: [
    { x: 3, y: 15.6 },
    { x: 8, y: 14 },
  ],
  goal: { x: 6, y: 13, w: 2, h: 3 },
};

function renderFrame(size?: RendererSize): Recorder {
  const recorder = createRecorder(size);
  drawCoinRun(
    recorder.surface,
    {
      world: new World(level),
      camera: createCamera(level.width),
      hud: new HudCache(4),
      phase: "playing",
      elapsedMs: 0,
      countdownMs: 0,
      results: null,
      connectedMask: 2,
      scores: [],
    },
    0,
  );
  return recorder;
}

function expectClose(actual: number, expected: number): void {
  expect(actual).toBeCloseTo(expected, 8);
}

/** Asserts every draw call went through the same scale + offset. */
function expectTransformed(
  design: Recorder,
  actual: Recorder,
  scale: number,
  offsetX: number,
  offsetY: number,
): void {
  expect(actual.rects.length).toBe(design.rects.length);
  for (let index = 0; index < design.rects.length; index += 1) {
    const base = design.rects[index];
    const scaled = actual.rects[index];
    if (base === undefined || scaled === undefined) throw new Error("rect missing");
    expectClose(scaled.x, offsetX + base.x * scale);
    expectClose(scaled.y, offsetY + base.y * scale);
    expectClose(scaled.w, base.w * scale);
    expectClose(scaled.h, base.h * scale);
  }

  expect(actual.circles.length).toBe(design.circles.length);
  for (let index = 0; index < design.circles.length; index += 1) {
    const base = design.circles[index];
    const scaled = actual.circles[index];
    if (base === undefined || scaled === undefined) throw new Error("circle missing");
    expectClose(scaled.x, offsetX + base.x * scale);
    expectClose(scaled.y, offsetY + base.y * scale);
    expectClose(scaled.r, base.r * scale);
  }

  expect(actual.texts.length).toBe(design.texts.length);
  for (let index = 0; index < design.texts.length; index += 1) {
    const base = design.texts[index];
    const scaled = actual.texts[index];
    if (base === undefined || scaled === undefined) throw new Error("text missing");
    expect(scaled.text).toBe(base.text);
    expectClose(scaled.x, offsetX + base.x * scale);
    expectClose(scaled.y, offsetY + base.y * scale);
    expectClose(scaled.size, base.size * scale);
  }
}

describe("Coin Run design-space render contract", () => {
  test("[FR-9.4] a surface without a size draws 1:1 in the 1280x720 design space", () => {
    const frame = renderFrame();
    const band = frame.rects[0];
    if (band === undefined) throw new Error("parallax band missing");
    // First band: 45% down a 720px design space, 35% tall, full 1280px width.
    expect(band.x).toBe(0);
    expect(band.y).toBe(324);
    expect(band.w).toBe(1280);
    expectClose(band.h, 252);
    // Player label first (22px), then the HUD readout (30px).
    expect(frame.texts[0]?.text).toBe("P1");
    expect(frame.texts[0]?.size).toBe(22);
    const coins = frame.texts.find((call) => call.text.startsWith("COINS"));
    expect(coins?.size).toBe(30);
  });

  test("[FR-9.4] every draw call scales and letterboxes into a ~1052x592 canvas", () => {
    const design = renderFrame();
    const surface = renderFrame({ width: 1052, height: 592 });
    const scale = 1052 / 1280;

    expectTransformed(design, surface, scale, 0, (592 - 720 * scale) / 2);

    // Nothing is drawn past the real canvas: the old 1280-wide assumptions
    // no longer clip the ground, the goal or the player.
    for (const rect of surface.rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(1052 + 1e-6);
    }
  });

  test("[FR-9.4] a taller surface letterboxes with a centred vertical offset", () => {
    const design = renderFrame();
    const surface = renderFrame({ width: 1280, height: 900 });

    // Aspect is narrower than 16:9, so scale stays 1 and the content is
    // centred vertically instead of stretched.
    expectTransformed(design, surface, 1, 0, (900 - 720) / 2);
  });
});

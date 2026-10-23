/**
 * Canvas wiring helpers shared by the WebGL2 and Canvas2D device tests.
 *
 * Kept separate from `webgl2.ts` so the 2D tests import no GL recorder. The
 * helpers create a fake canvas with exactly one registered context, which is
 * what the frozen contracts assume (a canvas holds one context type).
 */

import {
  createFake2DContext,
  createFakeWebGL2,
  FakeCanvas,
  type Fake2DContext,
  type FakeWebGL2,
} from "./webgl2.js";

export interface WiredWebGL2 {
  readonly canvas: FakeCanvas;
  readonly fake: FakeWebGL2;
  readonly gl: WebGL2RenderingContext;
}

export function wireWebGL2(options?: {
  readonly width?: number;
  readonly height?: number;
  readonly clientWidth?: number;
  readonly clientHeight?: number;
}): WiredWebGL2 {
  const canvas = new FakeCanvas(options);
  const { gl, fake } = createFakeWebGL2();
  canvas.registerContext("webgl2", gl);
  return { canvas, fake, gl };
}

export interface WiredCanvas2D {
  readonly canvas: FakeCanvas;
  readonly fake: Fake2DContext;
  readonly ctx: CanvasRenderingContext2D;
}

export function wireCanvas2D(options?: {
  readonly width?: number;
  readonly height?: number;
  readonly clientWidth?: number;
  readonly clientHeight?: number;
}): WiredCanvas2D {
  const canvas = new FakeCanvas(options);
  const { ctx, fake } = createFake2DContext();
  canvas.registerContext("2d", ctx);
  return { canvas, fake, ctx };
}

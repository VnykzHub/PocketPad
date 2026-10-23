/**
 * Legacy `Renderer2D` adapter over the engine Canvas2D device (05 §5.10).
 *
 * The two bundled 2D games draw through the SDK's renderer shape, which the
 * runtime's `Renderer2D` has satisfied since D7. The engine Canvas2D device
 * keeps the same CSS-pixel semantics, so the host can run the games on engine
 * code without touching a game. This adapter is the only glue: the device is
 * already initialized for `canvas` by `createCanvas2DDevice`, and every draw
 * call forwards one-to-one.
 *
 * Two legacy behaviors are preserved deliberately:
 * - a negative circle radius is clamped to 0 (the 2D context throws otherwise);
 * - `textureMemoryMB` stays 0, because Canvas2D uploads no textures.
 */
import type { Canvas2DDevice } from "@lanpad/engine-renderer-webgl2/canvas2d";
import type {
  Renderer2D,
  Renderer3D,
  RendererCapabilities,
  RendererSize,
} from "../render/Renderer.js";

/** The surface the 2D games use: every 2D call plus the 3D members refusing. */
export type EngineCanvas2DRenderer = Renderer2D & Renderer3D;

const CANVAS2D_CAPABILITIES: RendererCapabilities = Object.freeze({
  maxTextureSize: 0,
  compressedFormats: [],
});

const THREE_D_REFUSAL =
  "3D drawing is not available on the Canvas2D device. Route 3D games to a WebGPU or WebGL2 device before init.";

/**
 * Wraps an already-initialized Canvas2D device. `init` verifies the caller
 * passed the canvas the device was built for; it never initializes twice.
 *
 * The returned object is typed as `Renderer3D` because `GameHost` holds that
 * interface, but the 3D members refuse: silently drawing flat cubes is how a
 * 3D game ends up on the 2D fallback. The host routes 3D games elsewhere.
 */
export function createEngineCanvas2DRenderer(
  device: Canvas2DDevice,
  canvas: HTMLCanvasElement,
): EngineCanvas2DRenderer {
  let disposed = false;

  const size: RendererSize = {
    get width(): number {
      return device.size.width;
    },
    get height(): number {
      return device.size.height;
    },
  };

  return {
    backend: "canvas2d",
    size,
    async init(target: HTMLCanvasElement): Promise<RendererCapabilities> {
      if (target !== canvas) {
        throw new Error(
          "The Canvas2D device was created for a different canvas.",
        );
      }
      return CANVAS2D_CAPABILITIES;
    },
    resize(cssWidth: number, cssHeight: number, dpr: number): void {
      device.resize(cssWidth, cssHeight, dpr);
    },
    beginFrame(alpha: number): void {
      void alpha;
      device.beginFrame();
    },
    endFrame(): void {
      device.endFrame();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      device.dispose();
    },
    get drawCalls(): number {
      return device.stats.drawCalls;
    },
    get textureMemoryMB(): number {
      return 0;
    },
    clear(color: string): void {
      device.clear(color);
    },
    circle(x: number, y: number, r: number, color: string): void {
      device.circle(x, y, Math.max(0, r), color);
    },
    rect(x: number, y: number, w: number, h: number, color: string): void {
      device.rect(x, y, w, h, color);
    },
    text(
      text: string,
      x: number,
      y: number,
      fontSize: number,
      color: string,
      align: "left" | "center" | "right" = "left",
    ): void {
      device.text(text, x, y, fontSize, color, align);
    },
    polyline(
      points: ReadonlyArray<{ x: number; y: number }>,
      width: number,
      color: string,
    ): void {
      device.polyline(points, width, color);
    },
    setCamera(): void {
      throw new Error(THREE_D_REFUSAL);
    },
    drawCube(): void {
      throw new Error(THREE_D_REFUSAL);
    },
  };
}

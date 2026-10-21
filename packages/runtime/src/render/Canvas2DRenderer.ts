/**
 * Canvas2D renderer (D3-RT-02).
 *
 * This is a real backend, not a stub: it is the fallback when WebGL2 is
 * missing (FR-9.3) and the renderer the 2D games will use. It also implements
 * the `Renderer3D` cube call by projecting the cube as a rotating square, so
 * `CubeDemo` runs unchanged on both backends (E12's swap point).
 *
 * The renderer draws in CSS-pixel coordinates and scales the backing store,
 * which is how the TV profile renders at DPR 1 / 1080p and lets CSS upscale
 * (FR-9.4). `maxRenderHeight` caps the backing store; the CSS size is never
 * modified, so the browser upscales.
 */
import type {
  Renderer2D,
  Renderer3D,
  RendererCapabilities,
  RendererOptions,
} from "./Renderer.js";

const BACKGROUND = "#0b0f14";
const CUBE_PIXELS_PER_UNIT = 60;
const DEFAULT_CAMERA_Z = 3;

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class Canvas2DRenderer implements Renderer2D, Renderer3D {
  readonly backend = "canvas2d" as const;

  private readonly maxRenderHeight: number;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cssWidth = 0;
  private cssHeight = 0;
  private scaleX = 1;
  private scaleY = 1;
  private drawCallCount = 0;
  private cameraX = 0;
  private cameraY = 0;
  private cameraZ = DEFAULT_CAMERA_Z;

  constructor(options: RendererOptions = {}) {
    this.maxRenderHeight = options.maxRenderHeight ?? 0;
  }

  get drawCalls(): number {
    return this.drawCallCount;
  }

  get textureMemoryMB(): number {
    return 0;
  }

  async init(canvas: HTMLCanvasElement): Promise<RendererCapabilities> {
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("Canvas2D context is unavailable.");
    }
    this.canvas = canvas;
    this.ctx = ctx;
    return { maxTextureSize: 0, compressedFormats: [] };
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const canvas = this.requireCanvas();
    const ctx = this.requireContext();
    const width = positiveOr(cssWidth, 1);
    const height = positiveOr(cssHeight, 1);
    const density = positiveOr(dpr, 1);

    let backingWidth = Math.max(1, Math.round(width * density));
    let backingHeight = Math.max(1, Math.round(height * density));
    if (this.maxRenderHeight > 0 && backingHeight > this.maxRenderHeight) {
      const ratio = this.maxRenderHeight / backingHeight;
      backingWidth = Math.max(1, Math.round(backingWidth * ratio));
      backingHeight = this.maxRenderHeight;
    }

    canvas.width = backingWidth;
    canvas.height = backingHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    this.cssWidth = width;
    this.cssHeight = height;
    this.scaleX = backingWidth / width;
    this.scaleY = backingHeight / height;
    ctx.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0);
  }

  beginFrame(alpha: number): void {
    void alpha;
    const ctx = this.requireContext();
    this.drawCallCount = 0;
    // Canvas resize resets context state; reapply the CSS->backing transform.
    ctx.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
  }

  endFrame(): void {
    // Immediate-mode Canvas2D has nothing to flush.
  }

  clear(color: string): void {
    const ctx = this.requireContext();
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
  }

  circle(x: number, y: number, r: number, color: string): void {
    const ctx = this.requireContext();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
    ctx.fill();
    this.drawCallCount += 1;
  }

  rect(x: number, y: number, w: number, h: number, color: string): void {
    const ctx = this.requireContext();
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    this.drawCallCount += 1;
  }

  text(
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    align: "left" | "center" | "right" = "left",
  ): void {
    const ctx = this.requireContext();
    ctx.fillStyle = color;
    ctx.font = `${Math.max(1, size)}px sans-serif`;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    this.drawCallCount += 1;
  }

  polyline(
    points: ReadonlyArray<{ x: number; y: number }>,
    width: number,
    color: string,
  ): void {
    const first = points[0];
    if (first === undefined) {
      return;
    }
    const ctx = this.requireContext();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, width);
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      if (point !== undefined) {
        ctx.lineTo(point.x, point.y);
      }
    }
    ctx.stroke();
    this.drawCallCount += 1;
  }

  setCamera(
    position: { x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
  ): void {
    void target;
    this.cameraX = position.x;
    this.cameraY = position.y;
    this.cameraZ = position.z;
  }

  drawCube(
    position: { x: number; y: number; z: number },
    size: number,
    color: string,
    rotationY: number,
  ): void {
    const ctx = this.requireContext();
    const depth = this.cameraZ - position.z;
    const perspective = depth > 0.25 ? DEFAULT_CAMERA_Z / depth : DEFAULT_CAMERA_Z;
    const half = Math.max(1, (size * CUBE_PIXELS_PER_UNIT * perspective) / 2);
    const px =
      this.cssWidth / 2 + (position.x - this.cameraX) * CUBE_PIXELS_PER_UNIT * perspective;
    const py =
      this.cssHeight / 2 -
      (position.y - this.cameraY) * CUBE_PIXELS_PER_UNIT * perspective;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rotationY);
    ctx.fillStyle = color;
    ctx.fillRect(-half, -half, half * 2, half * 2);
    ctx.restore();
    this.drawCallCount += 1;
  }

  dispose(): void {
    this.ctx = null;
    this.canvas = null;
  }

  private requireCanvas(): HTMLCanvasElement {
    if (this.canvas === null) {
      throw new Error("Canvas2DRenderer.init(canvas) must run before resize.");
    }
    return this.canvas;
  }

  private requireContext(): CanvasRenderingContext2D {
    if (this.ctx === null) {
      throw new Error("Canvas2DRenderer.init(canvas) must run before drawing.");
    }
    return this.ctx;
  }
}

/**
 * Canvas2D drawing state and call semantics (05 §5.10, ER-05-08).
 *
 * Mirrors `packages/runtime/src/render/Canvas2DRenderer.ts`: CSS-pixel
 * coordinates via `setTransform`, a DPR-scaled backing store, the
 * `maxRenderHeight` cap applied proportionally, `#0b0f14` background and
 * `sans-serif` text. Kept DOM-only so tests can drive a fake 2D context.
 */

export const CANVAS2D_BACKGROUND = "#0b0f14";

export class Canvas2DDraw {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  private readonly maxRenderHeight: number;
  private cssWidth = 0;
  private cssHeight = 0;
  private width = 0;
  private height = 0;
  private scaleX = 1;
  private scaleY = 1;

  constructor(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    maxRenderHeight: number,
  ) {
    this.ctx = ctx;
    this.canvas = canvas;
    this.maxRenderHeight = maxRenderHeight;
  }

  get drawWidth(): number {
    return this.width;
  }

  get drawHeight(): number {
    return this.height;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || !Number.isFinite(dpr)) {
      throw new Error("Canvas2DDraw.resize requires finite css sizes and dpr.");
    }
    const safeDpr = dpr > 0 ? dpr : 1;
    this.cssWidth = Math.max(0, cssWidth);
    this.cssHeight = Math.max(0, cssHeight);
    let width = Math.max(1, Math.round(this.cssWidth * safeDpr));
    let height = Math.max(1, Math.round(this.cssHeight * safeDpr));
    if (this.maxRenderHeight > 0 && height > this.maxRenderHeight) {
      const scale = this.maxRenderHeight / height;
      width = Math.max(1, Math.round(width * scale));
      height = this.maxRenderHeight;
    }
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    if (this.canvas.style) {
      this.canvas.style.width = `${this.cssWidth}px`;
      this.canvas.style.height = `${this.cssHeight}px`;
    }
    this.width = width;
    this.height = height;
    this.scaleX = this.cssWidth > 0 ? width / this.cssWidth : 1;
    this.scaleY = this.cssHeight > 0 ? height / this.cssHeight : 1;
    this.applyTransform();
  }

  /** Fills the background and restarts the CSS-pixel drawing transform. */
  beginFrame(): void {
    this.applyTransform();
    this.ctx.fillStyle = CANVAS2D_BACKGROUND;
    this.ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
  }

  clear(color: string): void {
    this.applyTransform();
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);
  }

  circle(x: number, y: number, r: number, color: string): void {
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  rect(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
  }

  text(
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    align: "left" | "center" | "right" = "left",
  ): void {
    this.ctx.font = `${Math.max(1, size)}px sans-serif`;
    this.ctx.textAlign = align;
    this.ctx.fillStyle = color;
    this.ctx.fillText(text, x, y);
  }

  /** Empty polylines are no-ops and must not count as draw calls. */
  polyline(
    points: ReadonlyArray<{ x: number; y: number }>,
    width: number,
    color: string,
  ): boolean {
    if (points.length === 0) return false;
    this.ctx.beginPath();
    const first = points[0];
    if (first !== undefined) this.ctx.moveTo(first.x, first.y);
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      if (point !== undefined) this.ctx.lineTo(point.x, point.y);
    }
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = Math.max(1, width);
    this.ctx.stroke();
    return true;
  }

  private applyTransform(): void {
    this.ctx.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0);
  }
}

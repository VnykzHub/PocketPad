/**
 * Canvas swapchain (04 §5.3).
 *
 * One configure per dirty frame, never more. A zero-sized surface performs no
 * GPU work. "Outdated" retries configure exactly once; "lost" is reported to
 * the device state machine rather than thrown. Successful frame acquisition
 * allocates nothing.
 */

import type { WebGpuCanvasFormat } from "../contracts/webgpu.js";
import { rendererError, sanitizeMessage } from "../errors.js";
import { TEXTURE_USAGE } from "../runtime.js";

export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: "webgpu"): unknown;
}

export type SwapchainAcquireStatus =
  | "ok"
  | "empty"
  | "outdated"
  | "lost"
  | "error";

export interface BackingSize {
  readonly width: number;
  readonly height: number;
}

export function isCanvasLike(value: unknown): value is CanvasLike {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as {
    readonly width?: unknown;
    readonly height?: unknown;
    readonly getContext?: unknown;
  };
  return (
    typeof candidate.width === "number" &&
    typeof candidate.height === "number" &&
    typeof candidate.getContext === "function"
  );
}

export function computeBackingSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  maxRenderHeight: number,
  maxTextureDimension2D: number,
): BackingSize {
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    !Number.isFinite(dpr) ||
    cssWidth < 0 ||
    cssHeight < 0 ||
    dpr <= 0
  ) {
    throw rendererError("E_CONTRACT", "invalid surface size or DPR", {
      label: "resize",
      recoverable: false,
    });
  }
  if (cssWidth === 0 || cssHeight === 0) {
    return { width: 0, height: 0 };
  }
  let width = Math.round(cssWidth * dpr);
  let height = Math.round(cssHeight * dpr);
  if (maxRenderHeight > 0) {
    height = Math.min(height, maxRenderHeight);
  }
  width = Math.min(width, maxTextureDimension2D);
  height = Math.min(height, maxTextureDimension2D);
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Swapchain {
  private readonly canvas: CanvasLike;
  private readonly context: GPUCanvasContext;
  private device: GPUDevice;
  private readonly format: WebGpuCanvasFormat;
  private readonly maxTextureDimension2D: number;
  private readonly maxRenderHeight: number;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private dirty = true;
  private configured = false;
  private current: GPUTexture | null = null;

  constructor(args: {
    readonly native: unknown;
    readonly device: GPUDevice;
    readonly format: WebGpuCanvasFormat;
    readonly maxTextureDimension2D: number;
    readonly maxRenderHeight: number;
  }) {
    if (!isCanvasLike(args.native)) {
      throw rendererError(
        "E_BACKEND_INIT",
        "Surface.native is not a canvas with getContext",
        { label: "swapchain", recoverable: false },
      );
    }
    const context = args.native.getContext("webgpu");
    if (context === null || typeof context !== "object") {
      throw rendererError(
        "E_BACKEND_INIT",
        "canvas.getContext('webgpu') returned null",
        { label: "swapchain", recoverable: false },
      );
    }
    const candidate = context as {
      readonly configure?: unknown;
      readonly unconfigure?: unknown;
      readonly getCurrentTexture?: unknown;
    };
    if (
      typeof candidate.configure !== "function" ||
      typeof candidate.getCurrentTexture !== "function"
    ) {
      throw rendererError(
        "E_BACKEND_INIT",
        "canvas WebGPU context is incomplete",
        { label: "swapchain", recoverable: false },
      );
    }
    this.canvas = args.native;
    this.context = context as GPUCanvasContext;
    this.device = args.device;
    this.format = args.format;
    this.maxTextureDimension2D = args.maxTextureDimension2D;
    this.maxRenderHeight = args.maxRenderHeight;
  }

  get canvasWidth(): number {
    return this.width;
  }

  get canvasHeight(): number {
    return this.height;
  }

  get isConfigured(): boolean {
    return this.configured;
  }

  setMetrics(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    this.dirty = true;
  }

  setDevice(device: GPUDevice): void {
    this.device = device;
    this.dirty = true;
    this.configured = false;
    this.current = null;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Called at most once per beginFrame. Returns true when it configured. */
  configureIfNeeded(): boolean {
    const next = computeBackingSize(
      this.cssWidth,
      this.cssHeight,
      this.dpr,
      this.maxRenderHeight,
      this.maxTextureDimension2D,
    );
    this.width = next.width;
    this.height = next.height;
    if (next.width === 0 || next.height === 0) {
      if (this.dirty && this.configured) {
        this.unconfigure();
      }
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.dirty = false;
      this.configured = false;
      this.current = null;
      return false;
    }
    if (!this.dirty) {
      return false;
    }
    this.canvas.width = next.width;
    this.canvas.height = next.height;
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: "opaque",
      usage: TEXTURE_USAGE.RENDER_ATTACHMENT | TEXTURE_USAGE.COPY_SRC,
      colorSpace: "srgb",
    });
    this.configured = true;
    this.dirty = false;
    return true;
  }

  /**
   * Returns "ok" on success. The acquired texture is read through
   * `currentTexture` before the next acquisition.
   */
  acquire(): SwapchainAcquireStatus {
    this.current = null;
    if (this.width === 0 || this.height === 0) {
      return "empty";
    }
    try {
      this.current = this.context.getCurrentTexture();
      return "ok";
    } catch (error) {
      const message = errorText(error).toLowerCase();
      if (message.includes("outdated")) {
        this.dirty = true;
        this.configureIfNeeded();
        try {
          this.current = this.context.getCurrentTexture();
          return "ok";
        } catch (retryError) {
          const retryMessage = errorText(retryError).toLowerCase();
          if (retryMessage.includes("lost")) {
            return "lost";
          }
          return "outdated";
        }
      }
      if (message.includes("lost")) {
        return "lost";
      }
      return "error";
    }
  }

  get currentTexture(): GPUTexture | null {
    return this.current;
  }

  describeAcquireError(error: unknown): string {
    return sanitizeMessage(`swapchain acquire failed: ${errorText(error)}`);
  }

  unconfigure(): void {
    const context = this.context as GPUCanvasContext & {
      unconfigure?(): void;
    };
    if (typeof context.unconfigure === "function") {
      context.unconfigure();
    }
    this.configured = false;
  }

  destroy(): void {
    this.current = null;
    if (this.configured) {
      this.unconfigure();
    }
    this.width = 0;
    this.height = 0;
    this.dirty = true;
  }
}

/**
 * Canvas2D Tier C device (05 §5.10).
 *
 * Only lifecycle and the five 2D calls work. Every 3D resource creation, draw
 * call and frame-camera call throws an `EngineError` with code
 * `E_UNSUPPORTED_FEATURE` and detail `3d-on-canvas2d` (ER-05-07), never a
 * silent stub. This entry imports no WebGL2 shader or texture code.
 */

import type {
  BufferHandle,
  DeviceLimits,
  DeviceLostListener,
  EngineFeature,
  FrameCapture,
  LodGroupHandle,
  MaterialHandle,
  MeshHandle,
  PipelineHandle,
  RenderFrame,
  RenderPassEncoder,
  RenderStats,
  RenderTargetHandle,
  RendererCapabilities,
  RendererSize,
  RestoredListener,
  RestoreResult,
  SamplerHandle,
  ShaderModuleHandle,
  Surface,
  TextureFormat,
  TextureHandle,
} from "@lanpad/engine-core";
import type { Canvas2DDevice, Canvas2DDeviceOptions } from "../contracts/canvas2d.js";
import { rendererError, unsupported3dOnCanvas2d } from "../errors.js";
import {
  createStats,
  resetFrameStats,
  statsAsRenderStats,
  type MutableRenderStats,
} from "../stats.js";
import { Canvas2DDraw } from "./draw2d.js";

const EMPTY_FEATURES: ReadonlySet<EngineFeature> = new Set<EngineFeature>();
const EMPTY_FORMATS: ReadonlySet<TextureFormat> = new Set<TextureFormat>();
const ZERO_LIMITS: DeviceLimits = Object.freeze({
  maxTextureDimension2D: 0,
  maxTextureArrayLayers: 0,
  maxBindGroups: 0,
  maxUniformBufferBindingSize: 0,
  maxStorageBufferBindingSize: 0,
  maxBufferSize: 0,
  maxVertexBuffers: 0,
  maxColorAttachments: 0,
  maxSamplerAnisotropy: 0,
  minUniformBufferOffsetAlignment: 0,
  maxComputeWorkgroupSizeX: 0,
});

class Canvas2DFrame implements RenderFrame {
  private readonly device: Canvas2DDeviceImpl;

  constructor(device: Canvas2DDeviceImpl) {
    this.device = device;
  }

  get valid(): boolean {
    return this.device.frameValid;
  }

  setCamera(): void {
    throw unsupported3dOnCanvas2d("RenderFrame.setCamera");
  }

  setCameraMatrices(): void {
    throw unsupported3dOnCanvas2d("RenderFrame.setCameraMatrices");
  }

  draw(): void {
    throw unsupported3dOnCanvas2d("RenderFrame.draw");
  }

  drawInstanced(): void {
    throw unsupported3dOnCanvas2d("RenderFrame.drawInstanced");
  }

  drawLod(): void {
    throw unsupported3dOnCanvas2d("RenderFrame.drawLod");
  }

  beginPass(): RenderPassEncoder {
    throw unsupported3dOnCanvas2d("RenderFrame.beginPass");
  }

  drawFullscreen(): void {
    throw unsupported3dOnCanvas2d("RenderFrame.drawFullscreen");
  }
}

export class Canvas2DDeviceImpl implements Canvas2DDevice {
  readonly backend = "canvas2d" as const;
  readonly stats: RenderStats;
  readonly features: ReadonlySet<EngineFeature> = EMPTY_FEATURES;
  readonly limits: DeviceLimits = ZERO_LIMITS;
  readonly capabilities: RendererCapabilities;

  private readonly canvas: HTMLCanvasElement;
  private readonly draw: Canvas2DDraw;
  private readonly mutableStats: MutableRenderStats;
  private readonly frame: RenderFrame;
  private readonly lostListeners = new Set<DeviceLostListener>();
  private readonly restoredListeners = new Set<RestoredListener>();
  private readonly sizeRecord: { width: number; height: number } = { width: 0, height: 0 };
  private frameActive = false;
  private disposed = false;

  constructor(options: Canvas2DDeviceOptions, ctx: CanvasRenderingContext2D) {
    this.canvas = options.canvas;
    const maxRenderHeight =
      options.maxRenderHeight ?? (options.tvProfile === true ? 1080 : 0);
    this.draw = new Canvas2DDraw(ctx, options.canvas, maxRenderHeight);
    this.mutableStats = createStats();
    this.stats = statsAsRenderStats(this.mutableStats);
    this.capabilities = Object.freeze({
      backend: "canvas2d" as const,
      features: EMPTY_FEATURES,
      supportedFormats: EMPTY_FORMATS,
      quality: "off" as const,
      maxTextureSize: 0,
      maxTextureLayers: 0,
      maxBindGroups: 0,
      maxUniformBufferBytes: 0,
      // The frozen type floor is 1; the 2D device exposes no MSAA samples.
      maxSamples: 1 as const,
      anisotropy: 0,
      directionalLights: 0,
      pointLights: 0,
      shadowCascades: 0 as const,
      supportsPost: false,
      supportsTimestamps: false,
    });
    this.frame = new Canvas2DFrame(this);
  }

  get size(): RendererSize {
    return this.sizeRecord;
  }

  get frameValid(): boolean {
    return (
      this.frameActive &&
      !this.disposed &&
      this.sizeRecord.width > 0 &&
      this.sizeRecord.height > 0
    );
  }

  async init(surface: Surface): Promise<void> {
    if (this.disposed) {
      throw rendererError("E_DEVICE_LOST", "This Canvas2D device has been disposed.");
    }
    if (surface.kind !== "canvas") {
      throw rendererError("E_CONTRACT", "The Canvas2D device requires a canvas surface.");
    }
    if (surface.native !== this.canvas) {
      throw rendererError(
        "E_CONTRACT",
        "The surface does not match the canvas this device was created for.",
      );
    }
    this.resize(surface.cssWidth, surface.cssHeight, surface.dpr);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.draw.resize(cssWidth, cssHeight, dpr);
    this.sizeRecord.width = Math.max(0, cssWidth);
    this.sizeRecord.height = Math.max(0, cssHeight);
  }

  beginFrame(): RenderFrame {
    if (this.disposed) return this.frame;
    resetFrameStats(this.mutableStats);
    this.draw.beginFrame();
    this.frameActive = this.sizeRecord.width > 0 && this.sizeRecord.height > 0;
    return this.frame;
  }

  endFrame(): void {
    this.frameActive = false;
  }

  clear(color: string): void {
    if (!this.requireOpenFrame()) return;
    this.draw.clear(color);
  }

  circle(x: number, y: number, r: number, color: string): void {
    if (!this.requireOpenFrame()) return;
    this.bumpDrawCall();
    this.draw.circle(x, y, r, color);
  }

  rect(x: number, y: number, w: number, h: number, color: string): void {
    if (!this.requireOpenFrame()) return;
    this.bumpDrawCall();
    this.draw.rect(x, y, w, h, color);
  }

  text(
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    align: "left" | "center" | "right" = "left",
  ): void {
    if (!this.requireOpenFrame()) return;
    this.bumpDrawCall();
    this.draw.text(text, x, y, size, color, align);
  }

  polyline(
    points: ReadonlyArray<{ x: number; y: number }>,
    width: number,
    color: string,
  ): void {
    if (!this.requireOpenFrame()) return;
    if (this.draw.polyline(points, width, color)) this.bumpDrawCall();
  }

  createShaderModule(): ShaderModuleHandle {
    throw unsupported3dOnCanvas2d("createShaderModule");
  }

  createPipeline(): PipelineHandle {
    throw unsupported3dOnCanvas2d("createPipeline");
  }

  createTexture(): TextureHandle {
    throw unsupported3dOnCanvas2d("createTexture");
  }

  createSampler(): SamplerHandle {
    throw unsupported3dOnCanvas2d("createSampler");
  }

  createBuffer(): BufferHandle {
    throw unsupported3dOnCanvas2d("createBuffer");
  }

  writeBuffer(): void {
    throw unsupported3dOnCanvas2d("writeBuffer");
  }

  createMesh(): MeshHandle {
    throw unsupported3dOnCanvas2d("createMesh");
  }

  createLodGroup(): LodGroupHandle {
    throw unsupported3dOnCanvas2d("createLodGroup");
  }

  createMaterial(): MaterialHandle {
    throw unsupported3dOnCanvas2d("createMaterial");
  }

  createRenderTarget(): RenderTargetHandle {
    throw unsupported3dOnCanvas2d("createRenderTarget");
  }

  destroy(): void {
    throw rendererError(
      "E_STALE_HANDLE",
      "The Canvas2D device owns no GPU handles to destroy.",
    );
  }

  async restore(): Promise<RestoreResult> {
    if (this.disposed) {
      return { ok: false, reason: "disposed", restoredHandles: 0, staleHandles: 0 };
    }
    return { ok: true, restoredHandles: 0, staleHandles: 0 };
  }

  onDeviceLost(listener: DeviceLostListener): () => void {
    this.lostListeners.add(listener);
    return () => {
      this.lostListeners.delete(listener);
    };
  }

  onRestored(listener: RestoredListener): () => void {
    this.restoredListeners.add(listener);
    return () => {
      this.restoredListeners.delete(listener);
    };
  }

  readTexture(): Promise<Uint8Array> {
    return Promise.reject(unsupported3dOnCanvas2d("readTexture"));
  }

  captureFrame(): Promise<FrameCapture> {
    return Promise.reject(unsupported3dOnCanvas2d("captureFrame"));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frameActive = false;
    this.lostListeners.clear();
    this.restoredListeners.clear();
  }

  /** False when the device is disposed; the draw must then be dropped. */
  private requireOpenFrame(): boolean {
    if (this.disposed) {
      this.mutableStats.droppedDraws += 1;
      return false;
    }
    if (!this.frameActive) {
      throw rendererError(
        "E_FRAME_CLOSED",
        "2D draw calls must happen between beginFrame() and endFrame().",
      );
    }
    return true;
  }

  private bumpDrawCall(): void {
    this.mutableStats.drawCalls += 1;
  }
}

/**
 * Creates the Canvas2D device. Rejects with `E_DEVICE_UNAVAILABLE` when the
 * browser cannot create a 2D context; the host shows that failure screen.
 */
export async function createCanvas2DDevice(
  options: Canvas2DDeviceOptions,
): Promise<Canvas2DDevice> {
  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = options.canvas.getContext("2d") as CanvasRenderingContext2D | null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw rendererError("E_DEVICE_UNAVAILABLE", `Could not create a 2D context: ${detail}`);
  }
  if (ctx === null) {
    throw rendererError("E_DEVICE_UNAVAILABLE", "Could not create a 2D context.");
  }
  const device = new Canvas2DDeviceImpl(options, ctx);
  await device.init(makeSurface(options.canvas));
  return device;
}

function makeSurface(canvas: HTMLCanvasElement): Surface {
  const cssWidth =
    typeof canvas.clientWidth === "number" && canvas.clientWidth > 0
      ? canvas.clientWidth
      : Math.max(1, canvas.width || 1);
  const cssHeight =
    typeof canvas.clientHeight === "number" && canvas.clientHeight > 0
      ? canvas.clientHeight
      : Math.max(1, canvas.height || 1);
  const dpr = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { kind: "canvas", native: canvas, cssWidth, cssHeight, dpr };
}

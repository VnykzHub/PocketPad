/**
 * WebGL2 Tier B device (05 §3.2, §4–§5).
 *
 * M0 surface: lifecycle, buffers, immutable 2D textures, ABI-1 meshes,
 * base-colour materials, the fixed forward-lit pipeline set, one directional
 * light, instancing, frustum culling and a bounded pipeline cache. Custom
 * shader modules are accepted but never compiled: Tier B has no WGSL path.
 * Render targets, LOD, post, shadows, skinning, MSAA targets, samplers and
 * readback are refused with `E_UNSUPPORTED_FEATURE`, never silently stubbed.
 *
 * Context loss rebuilds every live resource in place from its retained
 * descriptor, so handles stay valid across a restore. That is a recorded
 * deviation from the literal "old handles are stale after a bump" line in the
 * contract (05 §4.6); only calls made while lost are unavailable.
 */

import type {
  BufferDesc,
  BufferHandle,
  DeviceLimits,
  DeviceLostListener,
  EngineFeature,
  FrameCapture,
  GpuHandle,
  LodGroupHandle,
  MaterialDesc,
  MaterialHandle,
  Mat4,
  MeshDesc,
  MeshHandle,
  PipelineDesc,
  PipelineHandle,
  RenderDeviceOptions,
  RenderFrame,
  RenderPassEncoder,
  RenderStats,
  RenderTargetHandle,
  RendererQualityTier,
  RendererSize,
  RestoredListener,
  RestoreResult,
  SamplerHandle,
  ShaderModuleDesc,
  ShaderModuleHandle,
  Surface,
  TextureDesc,
  TextureHandle,
} from "@lanpad/engine-core";
import type {
  WebGL2Capabilities,
  WebGL2ContextAttributes,
  WebGL2Device,
  WebGL2DeviceInitResult,
  WebGL2DeviceOptions,
} from "./contracts/webgl2.js";
import { createStats, resetFrameStats, statsAsRenderStats, type MutableRenderStats } from "./stats.js";
import { HandleTable, type CreatedSlot } from "./resources.js";
import { rendererError } from "./errors.js";
import { StateCache } from "./state.js";
import {
  readProbeData,
  buildCapabilities,
  qualityForTier,
  type ProbeData,
} from "./capability.js";
import { classifyWebGL2 } from "./classify.js";
import { resolveContextAttributes, toDeviceLimits } from "./limits.js";
import { FrameUniformRing } from "./buffer.js";
import {
  createBufferGpu,
  deleteBufferGpu,
  readBufferDesc,
  writeBufferGpu,
  type BufferGpuRecord,
} from "./buffer.js";
import {
  createDefaultTextureGpu,
  createTextureGpu,
  deleteTextureGpu,
  estimateTextureBytes,
  type TextureGpuRecord,
} from "./texture.js";
import {
  ABI_INSTANCE_STRIDE,
  createMeshGpu,
  deleteMeshGpu,
  ensureInstanceCapacity,
  type MeshGpuRecord,
} from "./mesh.js";
import {
  bindMaterialGpu,
  createMaterialGpu,
  deleteMaterialGpu,
  type MaterialGpuRecord,
} from "./material.js";
import {
  DEFAULT_DEPTH_FORMAT,
  PipelineCache,
  PROGRAM_FORWARD_LIT_ID,
  SWAPCHAIN_COLOR_FORMAT,
  defineMaskFor,
  pipelineVariantIndex,
  type PipelineGpuRecord,
  type PipelineKeyParts,
} from "./pipelineCache.js";
import { FrameRecorder } from "./frame.js";
import { MATERIAL_UBO_BYTES } from "./shaders/forwardLit.js";

const DEFAULT_MAX_TEXTURE_BYTES = 128 * 1024 * 1024;
const LIGHT_DIRECTION_X = -0.45;
const LIGHT_DIRECTION_Y = -0.8;
const LIGHT_DIRECTION_Z = -0.35;
const LIGHT_INTENSITY = 1;
const LIGHT_AMBIENT = 0.18;
const IDENTITY_16 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
] as const;

type HandleKind =
  | "shader"
  | "pipeline"
  | "texture"
  | "sampler"
  | "buffer"
  | "mesh"
  | "lodGroup"
  | "material"
  | "renderTarget";
type TaggedHandle = GpuHandle & { readonly __kind?: string };

interface ShaderModuleRecord {
  readonly desc: ShaderModuleDesc;
}

interface DeferredTexture {
  readonly kind: "texture";
  readonly record: TextureGpuRecord;
}
interface DeferredBuffer {
  readonly kind: "buffer";
  readonly record: BufferGpuRecord;
}
interface DeferredMesh {
  readonly kind: "mesh";
  readonly record: MeshGpuRecord;
}
interface DeferredMaterial {
  readonly kind: "material";
  readonly record: MaterialGpuRecord;
}
type DeferredDelete = DeferredTexture | DeferredBuffer | DeferredMesh | DeferredMaterial;

function nowMs(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/** out = a * b for column-major 4x4 matrices. `out` must not alias `a`/`b`. */
function multiplyMat4(out: Float32Array, a: Float32Array, b: Float32Array): void {
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      }
      out[column * 4 + row] = sum;
    }
  }
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readCullMode(value: unknown): "none" | "back" | "front" {
  return value === "none" || value === "front" || value === "back" ? value : "back";
}

function sanitizeAdapterInfo(capabilities: WebGL2Capabilities): string {
  const raw = capabilities.renderer.length > 0 ? capabilities.renderer : capabilities.vendor;
  let cleaned = "";
  for (let index = 0; index < raw.length && cleaned.length < 120; index += 1) {
    const code = raw.charCodeAt(index);
    cleaned += code < 32 || code === 127 ? " " : raw[index] ?? "";
  }
  return `webgl2 | ${cleaned.trim()}`;
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

class DeviceFrameView implements RenderFrame {
  private readonly device: WebGL2DeviceImpl;

  constructor(device: WebGL2DeviceImpl) {
    this.device = device;
  }

  get valid(): boolean {
    return this.device.frameValid;
  }

  setCamera(viewProjection: Mat4): void {
    this.device.setCamera(viewProjection);
  }

  setCameraMatrices(view: Mat4, projection: Mat4): void {
    this.device.setCameraMatrices(view, projection);
  }

  draw(mesh: MeshHandle, material: MaterialHandle, transform: Mat4): void {
    this.device.recordDraw(mesh, material, transform);
  }

  drawInstanced(
    mesh: MeshHandle,
    material: MaterialHandle,
    transforms: Float32Array,
    count: number,
  ): void {
    this.device.recordDrawInstanced(mesh, material, transforms, count);
  }

  drawLod(): void {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "LOD groups are M2; the M0 WebGL2 device has no LOD draw path.",
    );
  }

  beginPass(): RenderPassEncoder {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Explicit render passes are M1; the M0 WebGL2 device renders only the swapchain pass.",
    );
  }

  drawFullscreen(): void {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Fullscreen post passes are M1; the M0 WebGL2 device has no post path.",
    );
  }
}

export class WebGL2DeviceImpl implements WebGL2Device {
  readonly backend = "webgl2" as const;
  readonly stats: RenderStats;
  readonly features: ReadonlySet<EngineFeature>;
  readonly limits: DeviceLimits;
  readonly contextAttributes: WebGL2ContextAttributes;

  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly options: WebGL2DeviceOptions;
  private readonly quality: RendererQualityTier;
  private readonly frameView: RenderFrame;
  private readonly mutableStats: MutableRenderStats;
  private readonly textureTable = new HandleTable<TextureGpuRecord>();
  private readonly shaderTable = new HandleTable<ShaderModuleRecord>();
  private readonly pipelineTable = new HandleTable<PipelineGpuRecord>();
  private readonly bufferTable = new HandleTable<BufferGpuRecord>();
  private readonly meshTable = new HandleTable<MeshGpuRecord>();
  private readonly materialTable = new HandleTable<MaterialGpuRecord>();
  private readonly deferred: DeferredDelete[] = [];
  private readonly lostListeners = new Set<DeviceLostListener>();
  private readonly restoredListeners = new Set<RestoredListener>();
  private readonly recorder: FrameRecorder;
  private readonly cameraViewProjection = new Float32Array(IDENTITY_16);
  private readonly cameraMatrixView: Mat4 = { m: this.cameraViewProjection };
  private readonly viewMatrix = new Float32Array(IDENTITY_16);
  private readonly multiplyScratch = new Float32Array(16);
  private readonly sizeRecord: { width: number; height: number } = { width: 0, height: 0 };

  private probe: ProbeData;
  private caps: WebGL2Capabilities;
  private deviceLimits: DeviceLimits;
  private state: StateCache;
  private ring: FrameUniformRing;
  private whiteTexture: TextureGpuRecord;
  private pipelineCache: PipelineCache;
  private extensionSet: ReadonlySet<string>;
  private frameActive = false;
  private initialized = false;
  private disposed = false;
  private lostFlag = false;
  private epoch = 0;
  private frameCounter = 0;
  private frameStartMs = 0;
  private hasView = false;
  private backingWidth = 0;
  private backingHeight = 0;
  private maxRenderHeight: number;
  private maxTextureBytes: number;
  private readonly tvProfile: boolean;

  private readonly resolveTextureRecord = (
    index: number,
    generation: number,
  ): TextureGpuRecord | null => this.textureTable.resolve(index, generation);

  private readonly handleContextLost = (event: Event): void => {
    if (this.disposed) return;
    const prevent = (event as Event & { preventDefault?: () => void }).preventDefault;
    if (typeof prevent === "function") prevent.call(event);
    if (this.lostFlag) return;
    this.lostFlag = true;
    this.epoch += 1;
    this.frameActive = false;
    this.notifyLost("unknown", "The WebGL2 context was lost.");
    const callback = this.options.onContextLost;
    if (callback !== undefined) callback();
  };

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return;
    this.rebuildAfterRestore();
  };

  constructor(input: {
    readonly canvas: HTMLCanvasElement;
    readonly gl: WebGL2RenderingContext;
    readonly options: WebGL2DeviceOptions;
    readonly data: ProbeData;
    readonly capabilities: WebGL2Capabilities;
    readonly quality: RendererQualityTier;
    readonly contextAttributes: WebGL2ContextAttributes;
  }) {
    this.canvas = input.canvas;
    this.gl = input.gl;
    this.options = input.options;
    this.quality = input.quality;
    this.contextAttributes = input.contextAttributes;
    this.probe = input.data;
    this.caps = input.capabilities;
    this.deviceLimits = toDeviceLimits(input.capabilities.limits);
    this.extensionSet = new Set(input.data.extensions);
    this.tvProfile = input.options.tvProfile === true;
    this.maxRenderHeight = input.options.maxRenderHeight ?? (this.tvProfile ? 1080 : 0);
    this.maxTextureBytes = input.options.maxTextureBytes ?? DEFAULT_MAX_TEXTURE_BYTES;
    this.mutableStats = createStats();
    this.stats = statsAsRenderStats(this.mutableStats);
    this.features = input.capabilities.features;
    this.limits = this.deviceLimits;
    this.state = new StateCache(this.gl);
    this.ring = new FrameUniformRing(this.gl, this.state);
    this.whiteTexture = createDefaultTextureGpu(this.gl, this.state);
    this.pipelineCache = new PipelineCache(this.gl, this.state, this.mutableStats);
    this.recorder = new FrameRecorder(this.mutableStats);
    this.frameView = new DeviceFrameView(this);
    this.cameraViewProjection.set(IDENTITY_16);
    this.viewMatrix.set(IDENTITY_16);
  }

  get capabilities(): WebGL2Capabilities {
    return this.caps;
  }

  get extensions(): readonly string[] {
    return this.caps.extensions;
  }

  get contextEpoch(): number {
    return this.epoch;
  }

  get lost(): boolean {
    return this.lostFlag;
  }

  get size(): RendererSize {
    return this.sizeRecord;
  }

  get frameValid(): boolean {
    return (
      this.frameActive &&
      !this.lostFlag &&
      !this.disposed &&
      this.sizeRecord.width > 0 &&
      this.sizeRecord.height > 0
    );
  }

  async init(surface: Surface, options?: RenderDeviceOptions): Promise<void> {
    if (this.disposed) {
      throw rendererError("E_DEVICE_LOST", "This WebGL2 device has been disposed.");
    }
    if (surface.kind !== "canvas") {
      throw rendererError("E_CONTRACT", "The WebGL2 device requires a canvas surface.");
    }
    if (surface.native !== this.canvas) {
      throw rendererError(
        "E_CONTRACT",
        "The surface does not match the canvas this device created its context on.",
      );
    }
    if (options?.maxRenderHeight !== undefined) {
      this.maxRenderHeight = options.maxRenderHeight;
    }
    this.resize(surface.cssWidth, surface.cssHeight, surface.dpr);
    if (!this.initialized) {
      this.initialized = true;
      this.attachContextListeners();
    }
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || !Number.isFinite(dpr)) {
      throw rendererError("E_CONTRACT", "resize requires finite css sizes and dpr.");
    }
    const safeCssWidth = Math.max(0, cssWidth);
    const safeCssHeight = Math.max(0, cssHeight);
    const safeDpr = dpr > 0 ? dpr : 1;
    let width = Math.max(1, Math.round(safeCssWidth * safeDpr));
    let height = Math.max(1, Math.round(safeCssHeight * safeDpr));
    if (this.maxRenderHeight > 0 && height > this.maxRenderHeight) {
      const scale = this.maxRenderHeight / height;
      width = Math.max(1, Math.round(width * scale));
      height = this.maxRenderHeight;
    }
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    if (this.canvas.style) {
      this.canvas.style.width = `${safeCssWidth}px`;
      this.canvas.style.height = `${safeCssHeight}px`;
    }
    this.backingWidth = width;
    this.backingHeight = height;
    this.sizeRecord.width = safeCssWidth;
    this.sizeRecord.height = safeCssHeight;
  }

  beginFrame(): RenderFrame {
    if (this.disposed) return this.frameView;
    resetFrameStats(this.mutableStats);
    this.recorder.begin(this.mutableStats);
    this.cameraViewProjection.set(IDENTITY_16);
    this.viewMatrix.set(IDENTITY_16);
    this.hasView = false;
    this.frameStartMs = nowMs();
    this.frameActive =
      !this.lostFlag &&
      this.sizeRecord.width > 0 &&
      this.sizeRecord.height > 0;
    if (!this.frameActive) {
      if (this.lostFlag) this.mutableStats.lostFrames += 1;
      return this.frameView;
    }
    this.ring.begin(this.frameCounter);
    return this.frameView;
  }

  endFrame(): void {
    if (!this.frameActive) {
      this.frameActive = false;
      return;
    }
    this.frameActive = false;
    try {
      this.flushFrame();
    } finally {
      this.mutableStats.cpuFrameMs = Math.max(0, nowMs() - this.frameStartMs);
      this.frameCounter += 1;
      this.flushDeferred();
    }
  }

  setCamera(viewProjection: Mat4): void {
    if (!this.frameActive) return;
    const m = viewProjection.m;
    for (let index = 0; index < 16; index += 1) {
      this.cameraViewProjection[index] = m[index] ?? 0;
    }
    this.recorder.setCamera(this.cameraMatrixView);
    this.hasView = false;
  }

  setCameraMatrices(view: Mat4, projection: Mat4): void {
    if (!this.frameActive) return;
    multiplyMat4(this.cameraViewProjection, projection.m, view.m);
    for (let index = 0; index < 16; index += 1) {
      this.viewMatrix[index] = view.m[index] ?? 0;
    }
    this.recorder.setCamera(this.cameraMatrixView);
    this.hasView = true;
  }

  recordDraw(mesh: MeshHandle, material: MaterialHandle, transform: Mat4): void {
    this.requireOpenFrame();
    if (!this.frameActive) return;
    const meshRecord = this.meshTable.resolve(mesh.index, mesh.generation);
    const materialRecord = this.materialTable.resolve(material.index, material.generation);
    if (meshRecord === null || materialRecord === null) {
      this.mutableStats.staleHandles += 1;
      this.mutableStats.droppedDraws += 1;
      return;
    }
    this.recorder.recordDraw(mesh.index, meshRecord, material.index, materialRecord, transform);
  }

  recordDrawInstanced(
    mesh: MeshHandle,
    material: MaterialHandle,
    transforms: Float32Array,
    count: number,
  ): void {
    this.requireOpenFrame();
    if (!this.frameActive) return;
    const meshRecord = this.meshTable.resolve(mesh.index, mesh.generation);
    const materialRecord = this.materialTable.resolve(material.index, material.generation);
    if (meshRecord === null || materialRecord === null) {
      this.mutableStats.staleHandles += 1;
      this.mutableStats.droppedDraws += 1;
      return;
    }
    this.recorder.recordDrawInstanced(
      mesh.index,
      meshRecord,
      material.index,
      materialRecord,
      transforms,
      count,
    );
  }

  createShaderModule(desc: ShaderModuleDesc): ShaderModuleHandle {
    this.requireUsable();
    if (desc.label.length < 1 || desc.label.length > 64) {
      throw rendererError("E_CONTRACT", "ShaderModuleDesc.label must be 1..64 characters.");
    }
    if (desc.stage === "compute") {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        "Compute shader modules are unavailable on Tier B.",
      );
    }
    if (desc.abiVersion !== 1) {
      throw rendererError("E_CONTRACT", "Only shader ABI 1 is accepted.");
    }
    if (desc.code.length > 65536) {
      throw rendererError("E_CONTRACT", "ShaderModuleDesc.code exceeds 64 KiB.");
    }
    const slot = this.shaderTable.create({ desc });
    return this.makeHandle("shader", slot);
  }

  createPipeline(desc: PipelineDesc): PipelineHandle {
    this.requireUsable();
    const label = readString(desc["label"], "");
    if (label.length === 0) {
      throw rendererError("E_CONTRACT", "PipelineDesc.label is required.");
    }
    const programId = readString(desc["programId"], PROGRAM_FORWARD_LIT_ID);
    const vertexLayoutId = readString(
      desc["vertexLayoutId"] ?? desc["vertexLayout"],
      "static-pbr-v1",
    );
    const alphaMode = readString(desc["blendMode"] ?? desc["alphaMode"], "opaque");
    if (alphaMode !== "opaque" && alphaMode !== "mask" && alphaMode !== "blend") {
      throw rendererError(
        "E_CONTRACT",
        'PipelineDesc blendMode must be "opaque", "mask" or "blend".',
      );
    }
    if (vertexLayoutId !== "static-pbr-v1" && vertexLayoutId !== "instanced-transform-v1") {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        `Pipeline layout ${vertexLayoutId} is not part of renderer ABI 1.`,
      );
    }
    const unlit = readBoolean(desc["unlit"], false);
    const depthTest = readBoolean(desc["depthTest"], true);
    const depthWrite = readBoolean(desc["depthWrite"], alphaMode !== "blend");
    const cullMode = readCullMode(desc["cullMode"]);
    const parts: PipelineKeyParts = {
      programId,
      colorFormat: readString(desc["colorFormat"], SWAPCHAIN_COLOR_FORMAT),
      depthFormat: readString(desc["depthFormat"], DEFAULT_DEPTH_FORMAT),
      blendMode: alphaMode,
      depthTest,
      depthWrite,
      cullMode,
      topology: readString(desc["topology"], "triangle-list"),
      sampleCount: readNumber(desc["sampleCount"], 1),
      vertexLayoutId,
      defineMask: readNumber(desc["defineMask"], defineMaskFor(vertexLayoutId, alphaMode, unlit)),
    };
    const record = this.pipelineCache.ensure(parts);
    if (record === null) {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        "That pipeline descriptor is not part of the M0 WebGL2 forward-lit set.",
      );
    }
    const slot = this.pipelineTable.create(record);
    return this.makeHandle("pipeline", slot);
  }

  createTexture(desc: TextureDesc): TextureHandle {
    this.requireUsable();
    const mipLevels = desc.mipLevels ?? 1;
    const byteSize = estimateTextureBytes(desc.format, desc.width, desc.height, 1, mipLevels);
    if (this.mutableStats.textureBytes + byteSize > this.maxTextureBytes) {
      throw rendererError(
        "E_ASSET_BUDGET",
        `Texture budget exceeded: ${this.mutableStats.textureBytes} + ${byteSize} bytes.`,
      );
    }
    const record = createTextureGpu(
      this.gl,
      this.state,
      desc,
      this.extensionSet,
      this.probe.extensionObjects,
      { maxTextureDimension2D: this.probe.limits.maxTextureSize },
      this.probe.limits.maxAnisotropy,
    );
    this.mutableStats.textureBytes += record.byteSize;
    this.mutableStats.uploadBytes += record.byteSize;
    this.mutableStats.uploadCalls += record.mipLevels;
    const slot = this.textureTable.create(record);
    return this.makeHandle("texture", slot);
  }

  createSampler(): SamplerHandle {
    this.requireUsable();
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "createSampler is M1; pass an inline sampler in TextureDesc instead.",
    );
  }

  createBuffer(desc: BufferDesc): BufferHandle {
    this.requireUsable();
    const parsed = readBufferDesc(desc);
    const record = createBufferGpu(this.gl, this.state, parsed, this.deviceLimits.maxBufferSize);
    this.mutableStats.bufferBytes += record.byteLength;
    if (parsed.data !== undefined) {
      this.mutableStats.uploadBytes += parsed.data.byteLength;
      this.mutableStats.uploadCalls += 1;
    }
    const slot = this.bufferTable.create(record);
    return this.makeHandle("buffer", slot);
  }

  writeBuffer(handle: BufferHandle, offset: number, data: ArrayBufferView): void {
    this.requireUsable();
    const record = this.bufferTable.resolve(handle.index, handle.generation);
    if (record === null) {
      throw rendererError("E_STALE_HANDLE", "writeBuffer received a stale buffer handle.");
    }
    writeBufferGpu(this.gl, this.state, record, offset, data);
    this.mutableStats.uploadBytes += data.byteLength;
    this.mutableStats.uploadCalls += 1;
  }

  createMesh(desc: MeshDesc): MeshHandle {
    this.requireUsable();
    const record = createMeshGpu(this.gl, this.state, desc);
    this.mutableStats.bufferBytes += record.byteSize;
    const vertexBytes = desc.vertices[0]?.byteLength ?? 0;
    const indexBytes = desc.indices?.data.byteLength ?? 0;
    this.mutableStats.uploadBytes += vertexBytes + indexBytes;
    this.mutableStats.uploadCalls += 1;
    const slot = this.meshTable.create(record);
    return this.makeHandle("mesh", slot);
  }

  createLodGroup(): LodGroupHandle {
    this.requireUsable();
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "LOD groups are M2; the M0 WebGL2 device does not create them.",
    );
  }

  createMaterial(desc: MaterialDesc): MaterialHandle {
    this.requireUsable();
    const record = createMaterialGpu(
      this.gl,
      this.state,
      desc,
      this.resolveTextureRecord,
      this.whiteTexture,
    );
    this.mutableStats.bufferBytes += MATERIAL_UBO_BYTES;
    this.mutableStats.uploadBytes += MATERIAL_UBO_BYTES;
    this.mutableStats.uploadCalls += 1;
    const slot = this.materialTable.create(record);
    return this.makeHandle("material", slot);
  }

  createRenderTarget(): RenderTargetHandle {
    this.requireUsable();
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Render targets are M1; the M0 WebGL2 device renders to the swapchain only.",
    );
  }

  destroy(handle: GpuHandle): void {
    if (this.disposed) return;
    const kind = (handle as TaggedHandle).__kind;
    switch (kind) {
      case "texture": {
        const record = this.textureTable.markDestroyed(handle.index, handle.generation);
        if (record === null) {
          this.mutableStats.staleHandles += 1;
          return;
        }
        this.mutableStats.textureBytes = Math.max(
          0,
          this.mutableStats.textureBytes - record.byteSize,
        );
        this.queueDelete({ kind: "texture", record });
        return;
      }
      case "buffer": {
        const record = this.bufferTable.markDestroyed(handle.index, handle.generation);
        if (record === null) {
          this.mutableStats.staleHandles += 1;
          return;
        }
        this.mutableStats.bufferBytes = Math.max(
          0,
          this.mutableStats.bufferBytes - record.byteLength,
        );
        this.queueDelete({ kind: "buffer", record });
        return;
      }
      case "mesh": {
        const record = this.meshTable.markDestroyed(handle.index, handle.generation);
        if (record === null) {
          this.mutableStats.staleHandles += 1;
          return;
        }
        this.mutableStats.bufferBytes = Math.max(
          0,
          this.mutableStats.bufferBytes - record.byteSize,
        );
        this.queueDelete({ kind: "mesh", record });
        return;
      }
      case "material": {
        const record = this.materialTable.markDestroyed(handle.index, handle.generation);
        if (record === null) {
          this.mutableStats.staleHandles += 1;
          return;
        }
        this.mutableStats.bufferBytes = Math.max(
          0,
          this.mutableStats.bufferBytes - MATERIAL_UBO_BYTES,
        );
        this.queueDelete({ kind: "material", record });
        return;
      }
      case "shader":
        if (this.shaderTable.markDestroyed(handle.index, handle.generation) === null) {
          this.mutableStats.staleHandles += 1;
        }
        return;
      case "pipeline":
        if (this.pipelineTable.markDestroyed(handle.index, handle.generation) === null) {
          this.mutableStats.staleHandles += 1;
        }
        return;
      default:
        this.mutableStats.staleHandles += 1;
        return;
    }
  }

  async restore(): Promise<RestoreResult> {
    if (this.disposed) {
      return { ok: false, reason: "disposed", restoredHandles: 0, staleHandles: 0 };
    }
    if (!this.lostFlag) {
      return { ok: true, restoredHandles: this.liveHandleCount(), staleHandles: 0 };
    }
    const extension = this.gl.getExtension("WEBGL_lose_context") as
      | { restoreContext?: () => void }
      | null;
    if (extension !== null && typeof extension.restoreContext === "function") {
      extension.restoreContext();
    }
    return { ok: false, reason: "device-lost", restoredHandles: 0, staleHandles: 0 };
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
    return Promise.reject(
      rendererError(
        "E_UNSUPPORTED_FEATURE",
        "Texture readback needs framebuffers and is not part of the M0 WebGL2 backend.",
      ),
    );
  }

  captureFrame(): Promise<FrameCapture> {
    return Promise.reject(
      rendererError(
        "E_UNSUPPORTED_FEATURE",
        "Frame capture needs readback and is not part of the M0 WebGL2 backend.",
      ),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frameActive = false;
    this.detachContextListeners();
    this.deleteDeferredNow();
    for (const record of this.textureTable.drain()) deleteTextureGpu(this.gl, record);
    for (const record of this.bufferTable.drain()) deleteBufferGpu(this.gl, record);
    for (const record of this.meshTable.drain()) deleteMeshGpu(this.gl, record);
    for (const record of this.materialTable.drain()) deleteMaterialGpu(this.gl, record);
    this.pipelineTable.drain();
    this.shaderTable.drain();
    this.ring.destroy();
    deleteTextureGpu(this.gl, this.whiteTexture);
    this.pipelineCache.dispose();
    this.lostListeners.clear();
    this.restoredListeners.clear();
    this.mutableStats.textureBytes = 0;
    this.mutableStats.bufferBytes = 0;
  }

  private requireUsable(): void {
    if (this.disposed) {
      throw rendererError("E_DEVICE_LOST", "This WebGL2 device has been disposed.");
    }
    if (this.lostFlag) {
      throw rendererError("E_DEVICE_LOST", "The WebGL2 context is lost.");
    }
  }

  private requireOpenFrame(): void {
    if (this.disposed || this.lostFlag) {
      this.mutableStats.droppedDraws += 1;
      return;
    }
    if (!this.frameActive) {
      throw rendererError(
        "E_FRAME_CLOSED",
        "Draw calls must happen between beginFrame() and endFrame().",
      );
    }
  }

  private makeHandle<K extends HandleKind>(
    kind: K,
    slot: CreatedSlot,
  ): GpuHandle & { readonly __kind: K } {
    return { index: slot.index, generation: slot.generation, __kind: kind };
  }

  private queueDelete(entry: DeferredDelete): void {
    if (this.frameActive) {
      this.deferred.push(entry);
    } else {
      this.deleteNow(entry);
    }
  }

  private deleteNow(entry: DeferredDelete): void {
    if (entry.kind === "texture") deleteTextureGpu(this.gl, entry.record);
    else if (entry.kind === "buffer") deleteBufferGpu(this.gl, entry.record);
    else if (entry.kind === "mesh") deleteMeshGpu(this.gl, entry.record);
    else deleteMaterialGpu(this.gl, entry.record);
  }

  private flushDeferred(): void {
    for (let index = 0; index < this.deferred.length; index += 1) {
      const entry = this.deferred[index];
      if (entry !== undefined) this.deleteNow(entry);
    }
    this.deferred.length = 0;
  }

  private deleteDeferredNow(): void {
    this.flushDeferred();
  }

  private flushFrame(): void {
    const count = this.recorder.finish();
    const ring = this.ring;
    const data = ring.data();
    const vp = this.cameraViewProjection;
    for (let index = 0; index < 16; index += 1) data[index] = vp[index] ?? 0;
    const view = this.viewMatrix;
    const cameraX = this.hasView
      ? -((view[0] ?? 0) * (view[12] ?? 0) +
        (view[1] ?? 0) * (view[13] ?? 0) +
        (view[2] ?? 0) * (view[14] ?? 0))
      : 0;
    const cameraY = this.hasView
      ? -((view[4] ?? 0) * (view[12] ?? 0) +
        (view[5] ?? 0) * (view[13] ?? 0) +
        (view[6] ?? 0) * (view[14] ?? 0))
      : 0;
    const cameraZ = this.hasView
      ? -((view[8] ?? 0) * (view[12] ?? 0) +
        (view[9] ?? 0) * (view[13] ?? 0) +
        (view[10] ?? 0) * (view[14] ?? 0))
      : 0;
    data[16] = cameraX;
    data[17] = cameraY;
    data[18] = cameraZ;
    data[19] = 1;
    data[20] = LIGHT_DIRECTION_X;
    data[21] = LIGHT_DIRECTION_Y;
    data[22] = LIGHT_DIRECTION_Z;
    data[23] = LIGHT_INTENSITY;
    data[24] = 1;
    data[25] = 1;
    data[26] = 1;
    data[27] = LIGHT_AMBIENT;
    data[28] = this.frameCounter;
    data[29] = this.backingWidth;
    data[30] = this.backingHeight;
    data[31] = 1;
    ring.commit();

    const gl = this.gl;
    const state = this.state;
    const stats = this.mutableStats;
    state.setViewport(0, 0, this.backingWidth, this.backingHeight);
    state.setClearColor(0.043, 0.059, 0.078, 1);
    state.setDepth(true, gl.LEQUAL, true);
    state.setCull(true, gl.BACK);
    state.setFrontFace(gl.CCW);
    state.setBlend(
      false,
      gl.SRC_ALPHA,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
      gl.FUNC_ADD,
    );
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    let lastPipeline: PipelineGpuRecord | null = null;
    let lastMaterial: MaterialGpuRecord | null = null;
    const pool = this.recorder.instancePoolData;
    for (let index = 0; index < count; index += 1) {
      const mesh = this.recorder.meshAt(index);
      const material = this.recorder.materialAt(index);
      if (mesh === null || material === null) continue;
      const variant = pipelineVariantIndex(
        mesh.layout,
        material.alphaMode,
        material.unlit,
        material.doubleSided,
      );
      const pipeline = this.pipelineCache.defaultPipeline(variant);
      if (pipeline === null) {
        stats.droppedDraws += 1;
        continue;
      }
      if (pipeline !== lastPipeline) {
        if (lastPipeline !== null) stats.pipelineSwitches += 1;
        state.useProgram(pipeline.program);
        lastPipeline = pipeline;
      }
      state.setDepth(pipeline.depthTest, gl.LEQUAL, pipeline.depthWrite);
      state.setCull(
        pipeline.cullMode !== "none",
        pipeline.cullMode === "front" ? gl.FRONT : gl.BACK,
      );
      state.setBlend(
        pipeline.alphaMode === "blend",
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.FUNC_ADD,
      );
      if (material !== lastMaterial) {
        if (lastMaterial !== null) stats.bindGroupSwitches += 1;
        bindMaterialGpu(gl, state, material);
        lastMaterial = material;
        stats.textureBinds += 1;
      }
      state.bindVertexArray(mesh.vao);
      const instanceCount = this.recorder.instanceCountAt(index);
      const instanced = this.recorder.kindAt(index) === 1;
      if (instanced) {
        if (mesh.instanceBuffer === null) {
          stats.droppedDraws += 1;
          continue;
        }
        const capacityBefore = mesh.instanceCapacity;
        if (!ensureInstanceCapacity(gl, state, mesh, instanceCount)) {
          stats.droppedDraws += 1;
          continue;
        }
        if (mesh.instanceCapacity !== capacityBefore) {
          stats.bufferBytes += (mesh.instanceCapacity - capacityBefore) * ABI_INSTANCE_STRIDE;
        }
        const start = this.recorder.instanceStartAt(index);
        state.bindArrayBuffer(mesh.instanceBuffer);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          0,
          pool,
          start * FrameRecorder.floatsPerInstance,
          instanceCount * FrameRecorder.floatsPerInstance,
        );
      } else if (pipeline.uModelLocation !== null) {
        const start = this.recorder.instanceStartAt(index);
        gl.uniformMatrix4fv(
          pipeline.uModelLocation,
          false,
          pool,
          start * FrameRecorder.floatsPerInstance,
          16,
        );
      }
      this.drawMesh(mesh, instanceCount, instanced);
      stats.drawCalls += 1;
      stats.instances += instanceCount;
      const triangleCount = (mesh.indexCount > 0 ? mesh.indexCount : mesh.vertexCount) / 3;
      stats.triangles += triangleCount * instanceCount;
    }
  }

  private drawMesh(mesh: MeshGpuRecord, instanceCount: number, instanced: boolean): void {
    const gl = this.gl;
    const indexed = mesh.indexBuffer !== null && mesh.indexCount > 0;
    if (indexed) {
      const type = mesh.indexType === "uint32" ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      if (instanced) {
        gl.drawElementsInstanced(gl.TRIANGLES, mesh.indexCount, type, 0, instanceCount);
      } else {
        gl.drawElements(gl.TRIANGLES, mesh.indexCount, type, 0);
      }
      return;
    }
    if (instanced) {
      gl.drawArraysInstanced(gl.TRIANGLES, 0, mesh.vertexCount, instanceCount);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, mesh.vertexCount);
    }
  }

  private liveHandleCount(): number {
    return (
      this.textureTable.size +
      this.bufferTable.size +
      this.meshTable.size +
      this.materialTable.size +
      this.pipelineTable.size +
      this.shaderTable.size
    );
  }

  private rebuildAfterRestore(): void {
    try {
      this.probe = readProbeData(this.gl);
      this.caps = buildCapabilities({
        gl: this.gl,
        data: this.probe,
        quality: this.quality,
        shadowCascades: 0,
      });
      this.deviceLimits = toDeviceLimits(this.caps.limits);
      this.extensionSet = new Set(this.probe.extensions);
      this.state = new StateCache(this.gl);
      this.ring = new FrameUniformRing(this.gl, this.state);
      this.whiteTexture = createDefaultTextureGpu(this.gl, this.state);
      this.pipelineCache = new PipelineCache(this.gl, this.state, this.mutableStats);

      const textures = this.textureTable.live();
      for (let index = 0; index < textures.length; index += 1) {
        const entry = textures[index];
        if (entry === undefined) continue;
        const fresh = createTextureGpu(
          this.gl,
          this.state,
          entry.record.desc,
          this.extensionSet,
          this.probe.extensionObjects,
          { maxTextureDimension2D: this.probe.limits.maxTextureSize },
          this.probe.limits.maxAnisotropy,
        );
        Object.assign(entry.record, fresh);
      }

      const buffers = this.bufferTable.live();
      for (let index = 0; index < buffers.length; index += 1) {
        const entry = buffers[index];
        if (entry === undefined) continue;
        const fresh = createBufferGpu(
          this.gl,
          this.state,
          entry.record.desc,
          this.deviceLimits.maxBufferSize,
        );
        Object.assign(entry.record, fresh);
      }

      const meshes = this.meshTable.live();
      for (let index = 0; index < meshes.length; index += 1) {
        const entry = meshes[index];
        if (entry === undefined) continue;
        const fresh = createMeshGpu(this.gl, this.state, entry.record.desc);
        Object.assign(entry.record, fresh);
      }

      const materials = this.materialTable.live();
      for (let index = 0; index < materials.length; index += 1) {
        const entry = materials[index];
        if (entry === undefined) continue;
        const fresh = createMaterialGpu(
          this.gl,
          this.state,
          entry.record.desc,
          this.resolveTextureRecord,
          this.whiteTexture,
        );
        Object.assign(entry.record, fresh);
      }

      const pipelines = this.pipelineTable.live();
      for (let index = 0; index < pipelines.length; index += 1) {
        const entry = pipelines[index];
        if (entry === undefined) continue;
        const fresh = this.pipelineCache.ensure(this.partsFromRecord(entry.record));
        if (fresh !== null) Object.assign(entry.record, fresh);
      }

      this.recomputeByteTotals();
      this.lostFlag = false;
      this.frameCounter = 0;
    } catch {
      this.mutableStats.gpuErrors += 1;
      this.lostFlag = true;
      return;
    }
    const restored = [...this.restoredListeners];
    for (let index = 0; index < restored.length; index += 1) {
      const listener = restored[index];
      if (listener === undefined) continue;
      try {
        listener();
      } catch {
        // Listener failures must not corrupt device state.
      }
    }
    const callback = this.options.onContextRestored;
    if (callback !== undefined) callback();
  }

  private partsFromRecord(record: PipelineGpuRecord): PipelineKeyParts {
    return {
      programId: PROGRAM_FORWARD_LIT_ID,
      colorFormat: SWAPCHAIN_COLOR_FORMAT,
      depthFormat: DEFAULT_DEPTH_FORMAT,
      blendMode: record.alphaMode,
      depthTest: record.depthTest,
      depthWrite: record.depthWrite,
      cullMode: record.cullMode,
      topology: "triangle-list",
      sampleCount: 1,
      vertexLayoutId: record.layout,
      defineMask: record.defineMask,
    };
  }

  private recomputeByteTotals(): void {
    let textureBytes = 0;
    const textures = this.textureTable.live();
    for (let index = 0; index < textures.length; index += 1) {
      const entry = textures[index];
      if (entry !== undefined) textureBytes += entry.record.byteSize;
    }
    let bufferBytes = 0;
    const buffers = this.bufferTable.live();
    for (let index = 0; index < buffers.length; index += 1) {
      const entry = buffers[index];
      if (entry !== undefined) bufferBytes += entry.record.byteLength;
    }
    const meshes = this.meshTable.live();
    for (let index = 0; index < meshes.length; index += 1) {
      const entry = meshes[index];
      if (entry !== undefined) bufferBytes += entry.record.byteSize;
    }
    bufferBytes += this.materialTable.size * MATERIAL_UBO_BYTES;
    this.mutableStats.textureBytes = textureBytes;
    this.mutableStats.bufferBytes = bufferBytes;
  }

  private notifyLost(reason: "destroyed" | "unknown", message: string): void {
    const listeners = [...this.lostListeners];
    for (let index = 0; index < listeners.length; index += 1) {
      const listener = listeners[index];
      if (listener === undefined) continue;
      try {
        listener({ reason, message });
      } catch {
        // Listener failures must not corrupt device state.
      }
    }
  }

  private attachContextListeners(): void {
    if (typeof this.canvas.addEventListener !== "function") return;
    this.canvas.addEventListener("webglcontextlost", this.handleContextLost as EventListener, false);
    this.canvas.addEventListener(
      "webglcontextrestored",
      this.handleContextRestored as EventListener,
      false,
    );
  }

  private detachContextListeners(): void {
    if (typeof this.canvas.removeEventListener !== "function") return;
    this.canvas.removeEventListener(
      "webglcontextlost",
      this.handleContextLost as EventListener,
      false,
    );
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.handleContextRestored as EventListener,
      false,
    );
  }
}

function readContextAttributes(
  options: WebGL2DeviceOptions,
  tvProfile: boolean,
): WebGL2ContextAttributes {
  return resolveContextAttributes({
    tvProfile,
    ...(options.antialias === undefined ? {} : { antialias: options.antialias }),
    ...(options.depth === undefined ? {} : { depth: options.depth }),
    ...(options.stencil === undefined ? {} : { stencil: options.stencil }),
    ...(options.powerPreference === undefined
      ? {}
      : { powerPreference: options.powerPreference }),
    ...(options.desynchronized === undefined
      ? {}
      : { desynchronized: options.desynchronized }),
    ...(options.failIfMajorPerformanceCaveat === undefined
      ? {}
      : { failIfMajorPerformanceCaveat: options.failIfMajorPerformanceCaveat }),
  });
}

/**
 * Creates the WebGL2 device, probing once and constructing every fixed
 * resource before resolving. A context failure rejects with `E_BACKEND_INIT`
 * (05 §3.2); unsupported requested features reject before any allocation.
 */
export async function createWebGL2Device(
  options: WebGL2DeviceOptions,
): Promise<WebGL2DeviceInitResult> {
  if (options.canvas === undefined || options.canvas === null) {
    throw rendererError("E_BACKEND_INIT", "createWebGL2Device requires a canvas.");
  }
  if (options.post === true) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Post-processing is M1; the M0 WebGL2 device does not request it.",
    );
  }
  if (options.shadowCascades !== undefined && options.shadowCascades !== 0) {
    throw rendererError(
      "E_UNSUPPORTED_FEATURE",
      "Shadow cascades are M2; the M0 WebGL2 device advertises 0.",
    );
  }
  if (options.framesInFlight !== undefined && options.framesInFlight !== 3) {
    throw rendererError(
      "E_CONTRACT",
      "The M0 WebGL2 device supports exactly three frames in flight.",
    );
  }

  const tvProfile = options.tvProfile === true;
  const attributes = readContextAttributes(options, tvProfile);
  let gl: WebGL2RenderingContext | null;
  try {
    gl = options.canvas.getContext("webgl2", attributes) as WebGL2RenderingContext | null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw rendererError("E_BACKEND_INIT", `Could not create a WebGL2 context: ${detail}`);
  }
  if (gl === null) {
    throw rendererError("E_BACKEND_INIT", "Could not create a WebGL2 context.");
  }
  if (gl.isContextLost()) {
    throw rendererError("E_BACKEND_INIT", "The WebGL2 context was lost during creation.");
  }

  const data = readProbeData(gl);
  const classification = classifyWebGL2({
    limits: data.limits,
    extensions: data.extensions,
  });
  const quality = options.quality ?? qualityForTier(classification.tier);
  const capabilities = buildCapabilities({
    gl,
    data,
    quality,
    shadowCascades: 0,
  });
  const device = new WebGL2DeviceImpl({
    canvas: options.canvas,
    gl,
    options,
    data,
    capabilities,
    quality,
    contextAttributes: attributes,
  });
  await device.init(makeSurface(options.canvas), options);
  return Object.freeze({
    backend: "webgl2" as const,
    capabilities,
    adapterInfo: sanitizeAdapterInfo(capabilities),
    device,
  });
}

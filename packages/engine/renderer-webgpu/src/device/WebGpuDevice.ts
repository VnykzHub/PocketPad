/**
 * WebGPU render-device implementation (04 §5.1–§5.12, M0 boundary).
 *
 * M0 owns the lit, textured, instanced mesh path: one directional light and an
 * ambient term, frustum culling, shader/pipeline caches, the object and
 * instance rings, textures, meshes, materials, device loss, and one lazy
 * restore attempt. PBR maps, shadows, post, LOD groups, compute and readback
 * are later milestones; their contract methods fail with
 * `E_UNSUPPORTED_FEATURE` rather than silently doing nothing.
 *
 * Hot path: `beginFrame` → draw → `endFrame` reuses the frame wrapper, pass
 * descriptor, uniform rings, matrices, culler and submit array. The only
 * unavoidable per-frame wrappers are the swapchain view, command encoder,
 * render pass and command buffer required by WebGPU itself.
 */

import {
  mat4Copy,
  mat4Create,
  mat4Identity,
  mat4Invert,
  mat4Multiply,
  SHADER_ABI_VERSION,
  vec3Create,
} from "@lanpad/engine-core";
import type {
  BufferDesc,
  BufferHandle,
  DeviceLimits,
  DeviceLostListener,
  EngineFeature,
  FrameCapture,
  GpuHandle,
  LodGroupDesc,
  LodGroupHandle,
  MaterialDesc,
  MaterialHandle,
  Mat4,
  MeshDesc,
  MeshHandle,
  PipelineDesc,
  PipelineHandle,
  ReadbackOptions,
  RenderDeviceOptions,
  RenderFrame,
  RenderPassDesc,
  RenderPassEncoder,
  RendererSize,
  RenderTargetDesc,
  RenderTargetHandle,
  RestoreResult,
  RestoredListener,
  SamplerDesc,
  SamplerHandle,
  ShaderModuleDesc,
  ShaderModuleHandle,
  Surface,
  TextureDesc,
  TextureFormat,
  TextureHandle,
  TextureUsage,
} from "@lanpad/engine-core";
import type {
  PipelineCacheKey,
  PipelineKeyInputs,
  WebGpuCanvasFormat,
  WebGpuCapabilities,
  WebGpuDevice,
  WebGpuDeviceOptions,
  WebGpuDeviceState,
} from "../contracts/webgpu.js";
import {
  FRAME_UNIFORM_BYTES,
  INSTANCE_STRIDE_BYTES,
  LIGHT_UNIFORM_BYTES,
  OBJECT_UNIFORM_BYTES,
  vertexLayoutDefinition,
  writeFrameUniforms,
  writeLightUniforms,
  writeNormalMatrix,
  writeObjectUniforms,
} from "../abi.js";
import { InstanceRing } from "../buffer/InstanceRing.js";
import {
  MAX_OBJECTS_PER_FRAME,
  UniformRing,
} from "../buffer/UniformRing.js";
import {
  classifyFormat,
  engineFeatureForFormat,
  isCompressedFormat,
  isDepthFormat,
  isTextureFormat,
  supportsFormat,
  textureMemoryBytes,
  tightRowBytes,
} from "../texture/formats.js";
import { matrixIsFinite, FrustumCuller, unionSphereForInstances } from "../culling/FrustumCuller.js";
import {
  type BufferUsage,
  type NormalizedPipelineDesc,
  type WebGpuBufferDesc,
  type WebGpuPipelineDesc,
  DEFAULT_DEPTH_STATE,
  DEFAULT_PRIMITIVE_STATE,
  narrowBufferDesc,
  narrowPipelineDesc,
  validateLabel,
} from "./descriptors.js";
import {
  HandleStore,
  kindOf,
  makeHandle,
} from "./Handles.js";
import { PipelineCache } from "../pipeline/PipelineCache.js";
import { ShaderCache } from "../pipeline/ShaderCache.js";
import {
  canonicalDefines,
  canonicalPipelineKey,
  shaderModuleKey,
  utf8Bytes,
} from "../pipeline/pipelineKey.js";
import { MutableRenderStats } from "../profile/Stats.js";
import { Swapchain } from "../swapchain/Swapchain.js";
import {
  LIT_FRAGMENT_ENTRY,
  LIT_INSTANCED_VERTEX_ENTRY,
  LIT_UNLIT_FRAGMENT_ENTRY,
  LIT_VERTEX_ENTRY,
  LIT_WGSL,
} from "../shaders/lit.wgsl.js";
import { BUFFER_USAGE, IS_DEV, SHADER_STAGE, TEXTURE_USAGE, nowMs } from "../runtime.js";
import { rendererError, WebGpuRendererError } from "../errors.js";
import { normalizeOptions } from "./capabilities.js";
import type { NormalizedDeviceOptions } from "./capabilities.js";
import { acquireWebGpuDevice } from "./adapter.js";
import type { AcquireFailureReason } from "./adapter.js";

/** Dependencies acquired by the factory; the device owns their lifetime. */
export interface WebGpuDeviceDependencies {
  readonly gpu: GPU;
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly requestedFeatures: readonly GPUFeatureName[];
  readonly limits: DeviceLimits;
  readonly capabilities: WebGpuCapabilities;
  readonly options: WebGpuDeviceOptions;
}

const BUILTIN_VERTEX_KEY = `builtin:lit:abi${SHADER_ABI_VERSION}:vs_main`;
const BUILTIN_INSTANCED_VERTEX_KEY = `builtin:lit:abi${SHADER_ABI_VERSION}:vs_instanced_main`;
const BUILTIN_FRAGMENT_KEY = `builtin:lit:abi${SHADER_ABI_VERSION}:fs_main`;
const BUILTIN_UNLIT_FRAGMENT_KEY = `builtin:lit:abi${SHADER_ABI_VERSION}:${LIT_UNLIT_FRAGMENT_ENTRY}`;

const TEXTURE_USAGE_TOKENS: Readonly<Record<TextureUsage, true>> = {
  sample: true,
  "render-attachment": true,
  "copy-dst": true,
  "copy-src": true,
  storage: true,
};

const FILTER_MODES: Readonly<Record<"nearest" | "linear", true>> = {
  nearest: true,
  linear: true,
};

const ADDRESS_MODES: Readonly<
  Record<"clamp-to-edge" | "repeat" | "mirror-repeat", true>
> = {
  "clamp-to-edge": true,
  repeat: true,
  "mirror-repeat": true,
};

interface ShaderRecord {
  readonly desc: ShaderModuleDesc;
  readonly key: string;
  pending: boolean;
  module: GPUShaderModule | null;
}

interface PipelineRecord {
  readonly desc: NormalizedPipelineDesc;
  readonly key: PipelineCacheKey;
  pending: boolean;
  pipeline: GPURenderPipeline | null;
}

interface TextureRecord {
  readonly desc: TextureDesc;
  readonly label: string;
  readonly format: TextureFormat;
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly mips: number;
  readonly usageFlags: GPUTextureUsageFlags;
  readonly sampled: boolean;
  readonly depth: boolean;
  readonly bytes: number;
  readonly restorable: boolean;
  pending: boolean;
  texture: GPUTexture | null;
  view: GPUTextureView | null;
  sampler: GPUSampler | null;
}

interface SamplerRecord {
  readonly desc: SamplerDesc;
  readonly key: string;
  readonly restorable: true;
  pending: boolean;
  sampler: GPUSampler | null;
}

interface BufferRecord {
  readonly label: string;
  readonly logicalSize: number;
  readonly gpuBytes: number;
  readonly usageFlags: GPUBufferUsageFlags;
  readonly restorable: boolean;
  cpu: Uint8Array | null;
  cpuDirty: boolean;
  pending: boolean;
  buffer: GPUBuffer | null;
}

interface MeshRecord {
  readonly desc: MeshDesc;
  readonly label: string;
  readonly layout: MeshDesc["layout"];
  readonly vertexCount: number;
  readonly vertexBytes: number;
  readonly indexCount: number;
  readonly indexFormat: GPUIndexFormat;
  readonly indexBytes: number;
  readonly restorable: boolean;
  pending: boolean;
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
}

interface MaterialRecord {
  readonly desc: MaterialDesc;
  readonly label: string;
  readonly baseTexture: TextureHandle | null;
  readonly tintR: number;
  readonly tintG: number;
  readonly tintB: number;
  readonly tintA: number;
  readonly unlit: boolean;
  readonly restorable: true;
  pending: boolean;
  bindGroup: GPUBindGroup | null;
}

interface ColorAttachmentLike {
  view: GPUTextureView;
  clearValue: { r: number; g: number; b: number; a: number };
  loadOp: "clear" | "load";
  storeOp: "store" | "discard";
}

interface DepthAttachmentLike {
  view: GPUTextureView;
  depthClearValue: number;
  depthLoadOp: "clear" | "load";
  depthStoreOp: "store" | "discard";
}

interface PassDescriptorLike {
  label: string;
  colorAttachments: (ColorAttachmentLike | null)[];
  depthStencilAttachment: DepthAttachmentLike;
}

interface MutableFrameUniformInput {
  viewProjection: Mat4;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  timeSeconds: number;
  deltaSeconds: number;
  frameIndex: number;
  exposure: number;
  ambientRgb: [number, number, number];
  ambientIntensity: number;
  width: number;
  height: number;
  fogRgb: [number, number, number];
  fogDensity: number;
  near: number;
  far: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function textureUsageFlagsFor(usage: readonly TextureUsage[]): number {
  let flags = 0;
  for (const token of usage) {
    if (token === "sample") {
      flags |= TEXTURE_USAGE.TEXTURE_BINDING;
    } else if (token === "render-attachment") {
      flags |= TEXTURE_USAGE.RENDER_ATTACHMENT;
    } else if (token === "copy-dst") {
      flags |= TEXTURE_USAGE.COPY_DST;
    } else if (token === "copy-src") {
      flags |= TEXTURE_USAGE.COPY_SRC;
    }
  }
  return flags;
}

function bufferUsageFlagsFor(usage: readonly BufferUsage[]): number {
  let flags = 0;
  for (const token of usage) {
    switch (token) {
      case "vertex":
        flags |= BUFFER_USAGE.VERTEX;
        break;
      case "index":
        flags |= BUFFER_USAGE.INDEX;
        break;
      case "uniform":
        flags |= BUFFER_USAGE.UNIFORM;
        break;
      case "copy-dst":
        flags |= BUFFER_USAGE.COPY_DST;
        break;
      case "copy-src":
        flags |= BUFFER_USAGE.COPY_SRC;
        break;
      case "map-read":
        flags |= BUFFER_USAGE.MAP_READ;
        break;
      case "map-write":
        flags |= BUFFER_USAGE.MAP_WRITE;
        break;
      case "storage":
        // Storage buffers are rejected before this helper is called.
        break;
      default:
        break;
    }
  }
  return flags;
}

function applyDefines(
  code: string,
  defines: Readonly<Record<string, number | boolean>> | undefined,
): string {
  if (defines === undefined) {
    return code;
  }
  const keys = Object.keys(defines).sort();
  if (keys.length === 0) {
    return code;
  }
  let header = "";
  for (const key of keys) {
    const value = defines[key];
    header += `const ${key}: ${
      typeof value === "boolean" ? "bool" : "i32"
    } = ${typeof value === "boolean" ? String(value) : String(value)};\n`;
  }
  return `${header}\n${code}`;
}

function gpuBufferLayout(
  layout: MeshDesc["layout"],
): GPUVertexBufferLayout[] {
  const definition = vertexLayoutDefinition(layout);
  if (definition === undefined) {
    return [];
  }
  const buffers: GPUVertexBufferLayout[] = [];
  for (const buffer of definition.buffers) {
    const attributes: GPUVertexAttribute[] = [];
    for (const attribute of buffer.attributes) {
      attributes.push({
        shaderLocation: attribute.shaderLocation,
        offset: attribute.offset,
        format: attribute.format,
      });
    }
    buffers.push({
      arrayStride: buffer.arrayStride,
      stepMode: buffer.stepMode,
      attributes,
    });
  }
  return buffers;
}

function samplerKey(desc: SamplerDesc): string {
  return JSON.stringify([
    desc.magFilter,
    desc.minFilter,
    desc.mipmapFilter,
    desc.addressU,
    desc.addressV,
    desc.addressW ?? "clamp-to-edge",
    desc.maxAnisotropy ?? 1,
  ]);
}

/** 1 only for the M0 sRGB colour-slot formats. */
function isSrgbColorFormat(format: TextureFormat): boolean {
  return format === "rgba8unorm-srgb" || format === "rgba16float";
}

function reasonForAcquire(error: unknown): AcquireFailureReason {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { readonly reason?: unknown }).reason === "string"
  ) {
    const reason = (error as { readonly reason: string }).reason;
    if (reason === "adapter-unavailable" || reason === "device-request-failed") {
      return reason;
    }
  }
  return "device-request-failed";
}

function unsupported(feature: string): WebGpuRendererError {
  return rendererError(
    "E_UNSUPPORTED_FEATURE",
    `${feature} is not implemented in the M0 WebGPU backend`,
    { label: "webgpu", recoverable: false },
  );
}

/**
 * Dev-only entry point to the real loss path (ER-04-05). It is a symbol, not
 * part of `WebGpuDevice`, so production code cannot call it by accident; the
 * `./dev` subpath is the only supported way to reach it. Destroying the
 * `GPUDevice` resolves the real `device.lost` promise, exactly as a driver
 * loss does, and lets the normal loss/restore machinery run — no fake event.
 */
export const FORCE_DEVICE_LOST = Symbol("WebGpuRendererDevice.forceDeviceLost");

/**
 * M0 device. Construct through `createWebGpuDevice`; the runtime still calls
 * `init(surface, options)` before any resource creation.
 */
export class WebGpuRendererDevice implements WebGpuDevice {
  readonly backend = "webgpu" as const;
  readonly stats: MutableRenderStats = new MutableRenderStats();

  private readonly gpu: GPU;
  private adapter: GPUAdapter;
  private gpuDevice: GPUDevice;
  private requestedFeatures: readonly GPUFeatureName[];
  private limitsValue: DeviceLimits;
  private capabilitiesValue: WebGpuCapabilities;
  private adapterInfoValue: string;
  private options: NormalizedDeviceOptions;
  private readonly factoryOptions: WebGpuDeviceOptions;
  private readonly canvasFormatValue: WebGpuCanvasFormat;
  private stateValue: WebGpuDeviceState = "uninitialized";
  private surface: Surface | null = null;
  private swapchain: Swapchain | null = null;
  private readonly sizeValue: { width: number; height: number } = {
    width: 0,
    height: 0,
  };

  private readonly shaderStore = new HandleStore<ShaderRecord>();
  private readonly pipelineStore = new HandleStore<PipelineRecord>();
  private readonly textureStore = new HandleStore<TextureRecord>();
  private readonly samplerStore = new HandleStore<SamplerRecord>();
  private readonly bufferStore = new HandleStore<BufferRecord>();
  private readonly meshStore = new HandleStore<MeshRecord>();
  private readonly lodGroupStore = new HandleStore<never>();
  private readonly materialStore = new HandleStore<MaterialRecord>();
  private readonly renderTargetStore = new HandleStore<never>();

  private readonly shaderCache = new ShaderCache<GPUShaderModule>(64);
  private readonly pipelineCache = new PipelineCache<GPURenderPipeline>({ capacity: 256 });
  private readonly builtinPipelineCache = new PipelineCache<GPURenderPipeline>({
    capacity: 16,
  });
  private readonly samplerCache = new Map<string, GPUSampler>();
  private readonly shaderHandleByKey = new Map<string, ShaderModuleHandle>();
  private readonly pipelineHandleByKey = new Map<string, PipelineHandle>();
  private readonly samplerHandleByKey = new Map<string, SamplerHandle>();
  private readonly failedPipelineKeys = new Set<string>();

  private readonly deviceLostListeners: DeviceLostListener[] = [];
  private readonly restoredListeners: RestoredListener[] = [];

  private readonly adapterFeatureProbe: { has(feature: GPUFeatureName): boolean } = {
    has: (feature: GPUFeatureName): boolean =>
      this.requestedFeatures.includes(feature),
  };

  private readonly frame: RenderFrame;
  private frameActive = false;
  private frameOpen = false;
  private frameSuppressed = false;
  private passBindingsReady = false;
  private frameStartMs = 0;
  private lastFrameStartMs = 0;
  private timeSeconds = 0;
  private deltaSeconds = 0;
  private frameIndex = 0;
  private uncapturedInFrame = 0;
  private lossCount = 0;

  private cameraSet = false;
  private frustumActive = false;
  private cameraX = 0;
  private cameraY = 0;
  private cameraZ = 0;
  private readonly viewProjection: Mat4 = mat4Create();
  private readonly inverseView: Mat4 = mat4Create();
  private readonly culler = new FrustumCuller();
  private readonly frameFloats = new Float32Array(FRAME_UNIFORM_BYTES / 4);
  private readonly frameBytes = new Uint8Array(this.frameFloats.buffer);
  private readonly lightFloats = new Float32Array(LIGHT_UNIFORM_BYTES / 4);
  private readonly lightUints = new Uint32Array(this.lightFloats.buffer);
  private readonly lightBytes = new Uint8Array(this.lightFloats.buffer);
  // The M0 scene light is fixed and must agree with the WebGL2 backend and
  // the M0 experiment camera: direction points from the surface toward the
  // light on the camera's side. Values mirror 05's forward-lit defaults.
  private readonly ambientRgb: [number, number, number] = [0.18, 0.18, 0.18];
  private readonly fogRgb: [number, number, number] = [0, 0, 0];
  private readonly frameInput: MutableFrameUniformInput = {
    viewProjection: this.viewProjection,
    cameraX: 0,
    cameraY: 0,
    cameraZ: 0,
    timeSeconds: 0,
    deltaSeconds: 0,
    frameIndex: 0,
    exposure: 1,
    ambientRgb: this.ambientRgb,
    ambientIntensity: 1,
    width: 0,
    height: 0,
    fogRgb: this.fogRgb,
    fogDensity: 0,
    near: 0.1,
    far: 500,
  };
  private readonly objectFloats = new Float32Array(OBJECT_UNIFORM_BYTES / 4);
  private readonly normalScratch = new Float32Array(9);
  private readonly dynamicOffset = new Uint32Array(1);
  private readonly groupCenter = vec3Create();
  private readonly identityScratch: Mat4 = mat4Create();
  private readonly submitBuffer: GPUCommandBuffer[] = [];

  private objectRing: UniformRing;
  private readonly instanceRing = new InstanceRing();
  private objectRingCpu: Float32Array = new Float32Array(0);
  private objectRingBytes: Uint8Array = new Uint8Array(0);
  private instanceRingCpu: Float32Array = new Float32Array(0);
  private instanceRingBytes: Uint8Array = new Uint8Array(0);

  private objectBuffer: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer | null = null;
  private objectBindGroup: GPUBindGroup | null = null;
  private objectBindGroupLayout: GPUBindGroupLayout | null = null;
  private frameBindGroupLayout: GPUBindGroupLayout | null = null;
  private lightBindGroupLayout: GPUBindGroupLayout | null = null;
  private readonly instanceOffsetRef: { value: number } = { value: 0 };
  private lightBuffer: GPUBuffer | null = null;
  private frameBuffers: GPUBuffer[] = [];
  private frameBindGroups: (GPUBindGroup | null)[] = [];
  private lightBindGroups: (GPUBindGroup | null)[] = [];
  private whiteTexture: GPUTexture | null = null;
  private whiteView: GPUTextureView | null = null;
  private whiteBytes: Uint8Array = new Uint8Array(0);
  private defaultSampler: GPUSampler | null = null;
  private depthTexture: GPUTexture | null = null;
  private depthView: GPUTextureView | null = null;
  private depthWidth = 0;
  private depthHeight = 0;

  private pbrPipelineLayout: GPUPipelineLayout | null = null;
  private twoDPipelineLayout: GPUPipelineLayout | null = null;
  private materialBindGroupLayout: GPUBindGroupLayout | null = null;
  private litModule: GPUShaderModule | null = null;
  private readonly litPipelines: (GPURenderPipeline | null)[] = [
    null,
    null,
    null,
    null,
  ];
  private readonly litFailed: boolean[] = [false, false, false, false];
  private readonly litKeys: (PipelineCacheKey | null)[] = [
    null,
    null,
    null,
    null,
  ];

  private currentEncoder: GPUCommandEncoder | null = null;
  private currentPass: GPURenderPassEncoder | null = null;
  private currentSwapTexture: GPUTexture | null = null;
  private frameColorView: GPUTextureView | null = null;
  private lastMaterialGroup: GPUBindGroup | null = null;
  private lastPipeline: GPURenderPipeline | null = null;

  private readonly passColor: ColorAttachmentLike;
  private readonly passDepth: DepthAttachmentLike;
  private readonly passDescriptor: PassDescriptorLike;
  private readonly placeholderView: GPUTextureView;

  private listenedDevice: (GPUDevice & {
    addEventListener?: (type: string, listener: (event: unknown) => void) => void;
    removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  }) | null = null;

  private readonly uncapturedHandler = (): void => {
    this.stats.gpuErrors += 1;
    this.uncapturedInFrame += 1;
    if (this.uncapturedInFrame > 100) {
      this.frameSuppressed = true;
    }
  };

  constructor(dependencies: WebGpuDeviceDependencies) {
    this.gpu = dependencies.gpu;
    this.adapter = dependencies.adapter;
    this.gpuDevice = dependencies.device;
    this.requestedFeatures = dependencies.requestedFeatures;
    this.limitsValue = dependencies.limits;
    this.capabilitiesValue = dependencies.capabilities;
    this.adapterInfoValue = "";
    this.factoryOptions = dependencies.options;
    this.options = normalizeOptions(this.factoryOptions);
    this.canvasFormatValue = this.preferredFormat();
    this.adapterInfoValue = this.currentAdapterInfo();
    this.objectRing = new UniformRing(
      undefined,
      this.limitsValue.minUniformBufferOffsetAlignment,
    );
    this.prepareRings();
    this.placeholderView = null as unknown as GPUTextureView;
    this.passColor = {
      view: this.placeholderView,
      clearValue: { r: 0.043, g: 0.059, b: 0.078, a: 1 },
      loadOp: "clear",
      storeOp: "store",
    };
    this.passDepth = {
      view: this.placeholderView,
      depthClearValue: 1,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    };
    this.passDescriptor = {
      label: "pocketpad-frame",
      colorAttachments: [this.passColor],
      depthStencilAttachment: this.passDepth,
    };
    this.frame = this.createFrame();
    this.prepareBuiltinPipelineKeys();
    this.attachDevice(this.gpuDevice);
  }

  get features(): ReadonlySet<EngineFeature> {
    return this.capabilitiesValue.features;
  }

  get limits(): DeviceLimits {
    return this.limitsValue;
  }

  get capabilities(): WebGpuCapabilities {
    return this.capabilitiesValue;
  }

  get adapterInfo(): string {
    return this.adapterInfoValue;
  }

  get canvasFormat(): WebGpuCanvasFormat {
    return this.canvasFormatValue;
  }

  get deviceState(): WebGpuDeviceState {
    return this.stateValue;
  }

  get size(): RendererSize {
    return this.sizeValue;
  }

  async init(surface: Surface, options?: RenderDeviceOptions): Promise<void> {
    if (this.stateValue !== "uninitialized") {
      throw rendererError(
        "E_BACKEND_INIT",
        `init() called while device is ${this.stateValue}`,
        { label: "device", recoverable: false },
      );
    }
    if (surface.kind !== "canvas") {
      throw rendererError("E_BACKEND_INIT", "only canvas surfaces are supported", {
        label: "swapchain",
        recoverable: false,
      });
    }
    this.options = normalizeOptions(this.factoryOptions, options);
    this.capabilitiesValue = this.recomputeCapabilities();
    let created: Swapchain | null = null;
    try {
      created = new Swapchain({
        native: surface.native,
        device: this.gpuDevice,
        format: this.canvasFormatValue,
        maxTextureDimension2D: this.limitsValue.maxTextureDimension2D,
        maxRenderHeight: this.options.maxRenderHeight,
      });
      created.setMetrics(surface.cssWidth, surface.cssHeight, surface.dpr);
      created.configureIfNeeded();
      this.swapchain = created;
      this.surface = surface;
      this.stats.textureBytes = 0;
      this.stats.bufferBytes = 0;
      this.createBuiltinResources();
      this.stateValue = "running";
      this.stats.beginFrame();
    } catch (error) {
      created?.destroy();
      this.swapchain = null;
      this.surface = null;
      this.destroyBuiltinResources();
      this.stateValue = "failed";
      this.stats.textureBytes = 0;
      this.stats.bufferBytes = 0;
      throw error instanceof WebGpuRendererError
        ? error
        : rendererError("E_BACKEND_INIT", "WebGPU device init failed", {
            label: "device",
            recoverable: true,
            cause: error,
          });
    }
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.stateValue === "disposed") {
      throw rendererError("E_DEVICE_LOST", "renderer is disposed", {
        label: "resize",
        recoverable: false,
      });
    }
    if (
      !Number.isFinite(cssWidth) ||
      !Number.isFinite(cssHeight) ||
      !Number.isFinite(dpr) ||
      cssWidth < 0 ||
      cssHeight < 0 ||
      dpr <= 0
    ) {
      throw rendererError("E_CONTRACT", "invalid resize metrics", {
        label: "resize",
        recoverable: false,
      });
    }
    this.sizeValue.width = cssWidth;
    this.sizeValue.height = cssHeight;
    this.swapchain?.setMetrics(cssWidth, cssHeight, dpr);
  }

  beginFrame(): RenderFrame {
    if (this.stateValue !== "running") {
      this.stats.beginFrame();
      return this.frame;
    }
    if (this.frameActive) {
      if (IS_DEV) {
        throw rendererError("E_FRAME_CLOSED", "previous frame was not ended", {
          label: "frame",
          recoverable: false,
        });
      }
      this.abortFrame();
    }

    this.stats.beginFrame();
    this.frameStartMs = nowMs();
    if (this.lastFrameStartMs === 0) {
      this.deltaSeconds = 0;
    } else {
      this.deltaSeconds = Math.max(
        0,
        (this.frameStartMs - this.lastFrameStartMs) / 1000,
      );
    }
    this.lastFrameStartMs = this.frameStartMs;
    this.timeSeconds += this.deltaSeconds;
    this.frameActive = true;
    this.frameOpen = false;
    this.frameSuppressed = false;
    this.passBindingsReady = false;
    this.uncapturedInFrame = 0;
    this.frameUniformDirty = true;
    this.lastMaterialGroup = null;
    this.lastPipeline = null;
    this.objectRing.reset();
    this.instanceRing.reset();

    try {
      const swapchain = this.swapchain;
      if (swapchain === null) {
        throw rendererError("E_BACKEND_INIT", "device is not initialized", {
          label: "frame",
          recoverable: false,
        });
      }
      swapchain.configureIfNeeded();
      const width = swapchain.canvasWidth;
      const height = swapchain.canvasHeight;
      if (width === 0 || height === 0) {
        return this.frame;
      }
      this.ensureDepth(width, height);
      const status = swapchain.acquire();
      if (status === "lost") {
        this.handleDeviceLoss(
          this.gpuDevice,
          "unknown",
          "swapchain reported a lost device",
        );
        return this.frame;
      }
      if (status !== "ok") {
        if (status !== "empty") {
          this.stats.gpuErrors += 1;
        }
        return this.frame;
      }
      const texture = swapchain.currentTexture;
      if (texture === null) {
        this.stats.gpuErrors += 1;
        return this.frame;
      }
      this.currentSwapTexture = texture;
      const colorView = texture.createView();
      this.frameColorView = colorView;
      this.passColor.view = colorView;
      const depthView = this.depthView;
      if (depthView === null) {
        this.stats.gpuErrors += 1;
        return this.frame;
      }
      this.passDepth.view = depthView;
      this.frameInput.width = width;
      this.frameInput.height = height;
      const encoder = this.gpuDevice.createCommandEncoder({ label: "frame" });
      this.currentEncoder = encoder;
      const pass = encoder.beginRenderPass(
        this.passDescriptor as unknown as GPURenderPassDescriptor,
      );
      this.currentPass = pass;
      pass.setViewport(0, 0, width, height, 0, 1);
      this.frameOpen = true;
    } catch (error) {
      this.abortFrame();
      this.stats.gpuErrors += 1;
      throw error instanceof WebGpuRendererError
        ? error
        : rendererError("E_BACKEND_INIT", "beginFrame failed", {
            label: "frame",
            recoverable: true,
            cause: error,
          });
    }
    return this.frame;
  }

  endFrame(): void {
    if (!this.frameActive) {
      return;
    }
    const pass = this.currentPass;
    const encoder = this.currentEncoder;
    let failure: unknown = null;
    if (this.frameOpen && pass !== null && encoder !== null) {
      if (!this.frameSuppressed) {
        try {
          pass.end();
          this.currentPass = null;
          const commandBuffer = encoder.finish();
          this.submitBuffer[0] = commandBuffer;
          this.gpuDevice.queue.submit(this.submitBuffer);
        } catch (error) {
          failure = error;
        }
      }
    }
    this.stats.cpuFrameMs = nowMs() - this.frameStartMs;
    this.frameIndex += 1;
    this.abortFrame();
    if (failure !== null) {
      this.stats.gpuErrors += 1;
      if (IS_DEV) {
        throw rendererError("E_BACKEND_INIT", "frame submit failed", {
          label: "frame",
          recoverable: true,
          cause: failure,
        });
      }
    }
  }

  createShaderModule(desc: ShaderModuleDesc): ShaderModuleHandle {
    this.assertRunning("createShaderModule");
    const raw = desc as unknown as Readonly<Record<string, unknown>>;
    const label = validateLabel(raw["label"], "shader");
    if (raw["language"] !== "wgsl") {
      throw rendererError("E_CONTRACT", "only wgsl shaders are supported", {
        label,
        recoverable: false,
      });
    }
    if (raw["stage"] === "compute") {
      throw unsupported("compute shaders");
    }
    if (raw["stage"] !== "vertex" && raw["stage"] !== "fragment") {
      throw rendererError("E_CONTRACT", "invalid shader stage", {
        label,
        recoverable: false,
      });
    }
    if (raw["abiVersion"] !== 1) {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        "shader abiVersion must be 1",
        { label, recoverable: false },
      );
    }
    const code = raw["code"];
    if (typeof code !== "string" || code.length === 0) {
      throw rendererError("E_PIPELINE_COMPILE", "shader source is empty", {
        label,
        recoverable: false,
      });
    }
    if (utf8Bytes(code).byteLength > 65_536) {
      throw rendererError("E_PIPELINE_COMPILE", "shader source exceeds 64 KiB", {
        label,
        recoverable: false,
      });
    }
    const entryPoint = raw["entryPoint"];
    if (
      typeof entryPoint !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entryPoint) ||
      !new RegExp(`\\bfn\\s+${entryPoint}\\s*\\(`).test(code)
    ) {
      throw rendererError(
        "E_PIPELINE_COMPILE",
        "shader entry point is invalid or missing",
        { label, recoverable: false },
      );
    }
    const definesValue = raw["defines"];
    if (
      definesValue !== undefined &&
      (typeof definesValue !== "object" ||
        definesValue === null ||
        Array.isArray(definesValue))
    ) {
      throw rendererError("E_CONTRACT", "shader defines must be an object", {
        label,
        recoverable: false,
      });
    }
    const definesCanonical = canonicalDefines(
      definesValue as Readonly<Record<string, number | boolean>> | undefined,
    );
    const normalized: ShaderModuleDesc = {
      label,
      stage: raw["stage"],
      language: "wgsl",
      code,
      entryPoint,
      abiVersion: 1,
      ...(definesValue === undefined
        ? {}
        : {
            defines: definesValue as Readonly<
              Record<string, number | boolean>
            >,
          }),
    };
    const key = shaderModuleKey({
      language: "wgsl",
      stage: normalized.stage,
      entryPoint,
      abiVersion: 1,
      definesCanonical,
      code,
    });
    const existing = this.shaderHandleByKey.get(key);
    if (existing !== undefined) {
      return existing;
    }
    if (this.shaderStore.count >= 64) {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        "shader module limit (64) reached",
        { label, recoverable: false },
      );
    }
    let module: GPUShaderModule;
    try {
      module = this.gpuDevice.createShaderModule({
        label,
        code: applyDefines(code, normalized.defines),
      });
    } catch (error) {
      this.stats.gpuErrors += 1;
      throw rendererError("E_PIPELINE_COMPILE", "shader compilation failed", {
        label,
        recoverable: false,
        cause: error,
      });
    }
    const record: ShaderRecord = {
      desc: normalized,
      key,
      pending: false,
      module,
    };
    const slot = this.shaderStore.addWithGeneration(record);
    const handle = makeHandle("shader", slot.index, slot.generation);
    this.shaderHandleByKey.set(key, handle);
    this.shaderCache.set(key, module);
    this.stats.shaderModulesCreated += 1;
    return handle;
  }

  createPipeline(desc: PipelineDesc): PipelineHandle {
    this.assertRunning("createPipeline");
    const normalized = narrowPipelineDesc(desc as WebGpuPipelineDesc);
    const colorFormat = normalized.colorFormats[0];
    if (
      normalized.colorFormats.length !== 1 ||
      colorFormat !== this.canvasFormatValue
    ) {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        "M0 pipelines target the swapchain format only",
        { label: normalized.label, recoverable: false },
      );
    }
    if (
      normalized.depthState.format !== "none" &&
      normalized.depthState.format !== "depth24plus"
    ) {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        "M0 pipelines support depth24plus or no depth only",
        { label: normalized.label, recoverable: false },
      );
    }
    const vertexRecord = this.shaderRecord(normalized.vertexShader, "vertex");
    const fragmentRecord = this.shaderRecord(
      normalized.fragmentShader,
      "fragment",
    );
    if (!this.ensureShaderLive(vertexRecord)) {
      throw rendererError("E_PIPELINE_COMPILE", "vertex shader is unavailable", {
        label: normalized.label,
        recoverable: false,
      });
    }
    if (!this.ensureShaderLive(fragmentRecord)) {
      throw rendererError(
        "E_PIPELINE_COMPILE",
        "fragment shader is unavailable",
        { label: normalized.label, recoverable: false },
      );
    }
    const vertexModule = vertexRecord.module;
    const fragmentModule = fragmentRecord.module;
    if (vertexModule === null || fragmentModule === null) {
      throw rendererError("E_PIPELINE_COMPILE", "shader module is unavailable", {
        label: normalized.label,
        recoverable: false,
      });
    }
    const key = this.pipelineKeyFor(normalized, vertexRecord, fragmentRecord);

    const cached = this.pipelineCache.get(key);
    if (cached !== undefined && cached.failure !== null) {
      if (!this.failedPipelineKeys.has(key.canonical)) {
        this.failedPipelineKeys.add(key.canonical);
        this.stats.gpuErrors += 1;
      }
      throw rendererError("E_PIPELINE_COMPILE", cached.failure, {
        label: normalized.label,
        recoverable: false,
      });
    }
    const existingHandle = this.pipelineHandleByKey.get(key.canonical);
    if (existingHandle !== undefined) {
      const existing = this.pipelineStore.get(existingHandle);
      if (existing !== undefined) {
        if (existing.pipeline === null && !this.ensurePipelineLive(existingHandle, existing)) {
          throw rendererError(
            "E_PIPELINE_COMPILE",
            "pipeline rebuild failed",
            { label: normalized.label, recoverable: false },
          );
        }
        if (
          existing.pipeline !== null &&
          cached !== undefined &&
          cached.failure === null
        ) {
          this.stats.pipelineCacheHits += 1;
        }
        return existingHandle;
      }
    }
    if (this.pipelineStore.count >= 256) {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        "pipeline limit (256) reached",
        { label: normalized.label, recoverable: false },
      );
    }
    let pipeline: GPURenderPipeline;
    try {
      pipeline = this.buildPublicPipeline(
        normalized,
        vertexRecord.desc.entryPoint,
        fragmentRecord.desc.entryPoint,
        vertexModule,
        fragmentModule,
      );
    } catch (error) {
      const message =
        error instanceof WebGpuRendererError
          ? error.message
          : errorText(error).slice(0, 240);
      this.pipelineCache.setFailure(key, message);
      throw error instanceof WebGpuRendererError
        ? error
        : rendererError("E_PIPELINE_COMPILE", message, {
            label: normalized.label,
            recoverable: false,
            cause: error,
          });
    }
    const record: PipelineRecord = {
      desc: normalized,
      key,
      pending: false,
      pipeline,
    };
    const slot = this.pipelineStore.addWithGeneration(record);
    const handle = makeHandle("pipeline", slot.index, slot.generation);
    this.pipelineHandleByKey.set(key.canonical, handle);
    this.pipelineCache.set(key, pipeline);
    return handle;
  }

  createTexture(desc: TextureDesc): TextureHandle {
    this.assertRunning("createTexture");
    const label = validateLabel(
      (desc as unknown as { readonly label?: unknown }).label,
      "texture",
    );
    const raw = desc as unknown as Readonly<Record<string, unknown>>;
    const width = this.readPositiveInteger(raw["width"], "texture width", label);
    const height = this.readPositiveInteger(raw["height"], "texture height", label);
    if (
      width > this.limitsValue.maxTextureDimension2D ||
      height > this.limitsValue.maxTextureDimension2D
    ) {
      throw rendererError(
        "E_ASSET_BUDGET",
        "texture exceeds maxTextureDimension2D",
        { label, recoverable: false },
      );
    }
    const layers = this.readPositiveInteger(
      raw["depthOrArrayLayers"] ?? 1,
      "texture layers",
      label,
    );
    if (layers > this.limitsValue.maxTextureArrayLayers) {
      throw rendererError("E_ASSET_BUDGET", "texture exceeds layer limit", {
        label,
        recoverable: false,
      });
    }
    const formatValue = raw["format"];
    if (typeof formatValue !== "string") {
      throw rendererError("E_CONTRACT", "invalid texture format", {
        label,
        recoverable: false,
      });
    }
    if (!isTextureFormat(formatValue)) {
      throw rendererError("E_CONTRACT", "invalid texture format", {
        label,
        recoverable: false,
      });
    }
    const format: TextureFormat = formatValue;
    this.assertFormat(format, label);
    const classification = classifyFormat(format);
    const usageValue = raw["usage"];
    if (!Array.isArray(usageValue) || usageValue.length === 0) {
      throw rendererError("E_CONTRACT", "texture usage must be non-empty", {
        label,
        recoverable: false,
      });
    }
    const usage: TextureUsage[] = [];
    for (const token of usageValue) {
      if (
        typeof token !== "string" ||
        !Object.prototype.hasOwnProperty.call(TEXTURE_USAGE_TOKENS, token)
      ) {
        throw rendererError("E_CONTRACT", "invalid texture usage", {
          label,
          recoverable: false,
        });
      }
      usage.push(token as TextureUsage);
    }
    if (usage.includes("storage")) {
      throw unsupported("storage textures");
    }
    if (raw["sampleCount"] === 4) {
      throw rendererError("E_UNSUPPORTED_FEATURE", "MSAA is M1", {
        label,
        recoverable: false,
      });
    }
    if (raw["sampleCount"] !== undefined && raw["sampleCount"] !== 1) {
      throw rendererError("E_CONTRACT", "sampleCount must be 1", {
        label,
        recoverable: false,
      });
    }
    const sampled = usage.includes("sample");
    const renderAttachment = usage.includes("render-attachment");
    if (sampled && classification.kind !== "color" && classification.kind !== "compressed") {
      throw rendererError("E_ASSET_FORMAT", "depth textures cannot be sampled", {
        label,
        recoverable: false,
      });
    }
    if (renderAttachment) {
      const engineFeature = engineFeatureForFormat(format);
      if (engineFeature !== null && !this.features.has(engineFeature)) {
        throw rendererError(
          "E_UNSUPPORTED_FEATURE",
          `render target format ${format} requires ${engineFeature}`,
          { label, recoverable: false },
        );
      }
      if (isCompressedFormat(format)) {
        throw rendererError(
          "E_UNSUPPORTED_FEATURE",
          "compressed render targets are not supported",
          { label, recoverable: false },
        );
      }
    }
    const dataValue = raw["data"];
    if (dataValue !== undefined && !Array.isArray(dataValue)) {
      throw rendererError("E_ASSET_FORMAT", "texture data must be an array", {
        label,
        recoverable: false,
      });
    }
    if (usage.includes("copy-dst") === false && dataValue !== undefined) {
      throw rendererError(
        "E_ASSET_FORMAT",
        "texture data requires copy-dst usage",
        { label, recoverable: false },
      );
    }
    if (sampled && dataValue === undefined) {
      throw rendererError(
        "E_ASSET_FORMAT",
        "sampled textures require data in ABI 1",
        { label, recoverable: false },
      );
    }
    const maxMipLevels =
      Math.floor(Math.log2(Math.max(width, height))) + 1;
    const mips = this.readPositiveInteger(
      raw["mipLevels"] ?? 1,
      "texture mipLevels",
      label,
    );
    if (mips > maxMipLevels) {
      throw rendererError("E_ASSET_FORMAT", "mipLevels exceeds texture size", {
        label,
        recoverable: false,
      });
    }
    const levels = dataValue as
      | readonly { readonly mipLevel: number; readonly layer: number; readonly bytes: ArrayBufferView; readonly bytesPerRow: number }[]
      | undefined;
    if (levels !== undefined) {
      if (mips > 1 && levels.length === 0) {
        throw rendererError(
          "E_ASSET_FORMAT",
          "mipLevels > 1 requires all levels supplied",
          { label, recoverable: false },
        );
      }
      this.validateTextureLevels(levels, format, width, height, layers, mips, label);
    }
    const samplerValue = raw["sampler"];
    if (samplerValue !== undefined) {
      this.gpuSamplerDescriptor(samplerValue as SamplerDesc, label);
    }
    const retainValue = raw["retainCpu"];
    if (retainValue !== undefined && typeof retainValue !== "boolean") {
      throw rendererError("E_CONTRACT", "retainCpu must be boolean", {
        label,
        recoverable: false,
      });
    }
    const restorable =
      (retainValue as boolean | undefined) ?? this.options.retainCpuCopies;
    const record: TextureRecord = {
      desc,
      label,
      format,
      width,
      height,
      layers,
      mips,
      usageFlags: textureUsageFlagsFor(usage),
      sampled,
      depth: isDepthFormat(format),
      bytes: textureMemoryBytes(format, width, height, layers, mips),
      restorable,
      pending: false,
      texture: null,
      view: null,
      sampler: null,
    };
    this.buildTextureGpu(record);
    const slot = this.textureStore.addWithGeneration(record);
    return makeHandle("texture", slot.index, slot.generation);
  }

  createSampler(desc: SamplerDesc): SamplerHandle {
    this.assertRunning("createSampler");
    const label =
      typeof desc.label === "string" ? validateLabel(desc.label, "sampler") : "sampler";
    const key = samplerKey(desc);
    const existingHandle = this.samplerHandleByKey.get(key);
    if (existingHandle !== undefined) {
      const existing = this.samplerStore.get(existingHandle);
      if (existing !== undefined) {
        if (existing.sampler === null) {
          this.ensureSamplerLive(existing, label);
        }
        return existingHandle;
      }
    }
    if (this.samplerStore.count >= 32) {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        "sampler limit (32) reached",
        { label, recoverable: false },
      );
    }
    const gpuDesc = this.gpuSamplerDescriptor(desc, label);
    let sampler: GPUSampler;
    try {
      sampler = this.gpuDevice.createSampler(gpuDesc);
    } catch (error) {
      this.stats.gpuErrors += 1;
      throw rendererError("E_BACKEND_INIT", "sampler creation failed", {
        label,
        recoverable: false,
        cause: error,
      });
    }
    const record: SamplerRecord = {
      desc,
      key,
      restorable: true,
      pending: false,
      sampler,
    };
    const slot = this.samplerStore.addWithGeneration(record);
    const handle = makeHandle("sampler", slot.index, slot.generation);
    this.samplerHandleByKey.set(key, handle);
    this.samplerCache.set(key, sampler);
    return handle;
  }

  createBuffer(desc: BufferDesc): BufferHandle {
    this.assertRunning("createBuffer");
    const normalized = narrowBufferDesc(desc as WebGpuBufferDesc);
    if (normalized.usage.includes("storage")) {
      throw unsupported("storage buffers");
    }
    if (normalized.size > this.limitsValue.maxBufferSize) {
      throw rendererError("E_ASSET_BUDGET", "buffer exceeds maxBufferSize", {
        label: normalized.label,
        recoverable: false,
      });
    }
    if (normalized.size % 4 !== 0) {
      throw rendererError("E_CONTRACT", "buffer size must be a multiple of 4", {
        label: normalized.label,
        recoverable: false,
      });
    }
    if (
      normalized.usage.includes("uniform") &&
      normalized.size % 16 !== 0
    ) {
      throw rendererError(
        "E_CONTRACT",
        "uniform buffer size must be 16-byte aligned",
        { label: normalized.label, recoverable: false },
      );
    }
    const data = normalized.data;
    if (data !== null) {
      if (data.byteLength > normalized.size) {
        throw rendererError("E_CONTRACT", "buffer data exceeds buffer size", {
          label: normalized.label,
          recoverable: false,
        });
      }
      if (data.byteLength % 4 !== 0) {
        throw rendererError(
          "E_CONTRACT",
          "buffer data byte length must be a multiple of 4",
          { label: normalized.label, recoverable: false },
        );
      }
      if (!normalized.usage.includes("copy-dst")) {
        throw rendererError(
          "E_CONTRACT",
          "buffer data requires copy-dst usage",
          { label: normalized.label, recoverable: false },
        );
      }
    }
    const restorable = normalized.retainCpu ?? this.options.retainCpuCopies;
    const gpuBytes = align4(normalized.size);
    const usageFlags = bufferUsageFlagsFor(normalized.usage);
    let cpu: Uint8Array | null = null;
    let cpuDirty = false;
    if (restorable) {
      cpu = new Uint8Array(gpuBytes);
      if (data !== null) {
        cpu.set(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          0,
        );
        cpuDirty = true;
      }
    }
    const record: BufferRecord = {
      label: normalized.label,
      logicalSize: normalized.size,
      gpuBytes,
      usageFlags,
      restorable,
      cpu,
      cpuDirty,
      pending: false,
      buffer: null,
    };
    this.buildBufferGpu(record);
    const slot = this.bufferStore.addWithGeneration(record);
    return makeHandle("buffer", slot.index, slot.generation);
  }

  writeBuffer(handle: BufferHandle, offset: number, data: ArrayBufferView): void {
    this.assertRunning("writeBuffer");
    const record = this.bufferStore.get(handle);
    if (record === undefined || kindOf(handle) !== "buffer") {
      this.staleHandle("writeBuffer");
      return;
    }
    if (!this.ensureBufferLive(record)) {
      this.staleHandle("writeBuffer");
      return;
    }
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset % 4 !== 0 ||
      !Number.isInteger(data.byteLength) ||
      data.byteLength % 4 !== 0
    ) {
      throw rendererError("E_CONTRACT", "invalid buffer write range", {
        label: record.label,
        recoverable: false,
      });
    }
    if (offset + data.byteLength > record.logicalSize) {
      throw rendererError("E_CONTRACT", "buffer write exceeds size", {
        label: record.label,
        recoverable: false,
      });
    }
    if ((record.usageFlags & BUFFER_USAGE.COPY_DST) === 0) {
      throw rendererError(
        "E_CONTRACT",
        "buffer was not created with copy-dst",
        { label: record.label, recoverable: false },
      );
    }
    if (data.byteLength === 0) {
      return;
    }
    const buffer = record.buffer;
    if (buffer === null) {
      this.staleHandle("writeBuffer");
      return;
    }
    const bytes = new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    );
    this.queueUpload(buffer, offset, bytes, 0, bytes.byteLength);
    if (record.cpu !== null) {
      record.cpu.set(bytes, offset);
      record.cpuDirty = true;
    }
  }

  createMesh(desc: MeshDesc): MeshHandle {
    this.assertRunning("createMesh");
    const label = validateLabel(
      (desc as unknown as { readonly label?: unknown }).label,
      "mesh",
    );
    const raw = desc as unknown as Readonly<Record<string, unknown>>;
    const layoutValue = raw["layout"];
    if (layoutValue !== "static-pbr-v1" && layoutValue !== "instanced-transform-v1") {
      throw rendererError("E_CONTRACT", "invalid mesh layout", {
        label,
        recoverable: false,
      });
    }
    if (raw["topology"] !== undefined && raw["topology"] !== "triangle-list") {
      throw unsupported("mesh topology other than triangle-list");
    }
    const vertices = raw["vertices"];
    if (!Array.isArray(vertices) || vertices.length === 0) {
      throw rendererError("E_CONTRACT", "mesh needs one vertex buffer", {
        label,
        recoverable: false,
      });
    }
    if (vertices.length > 1) {
      throw unsupported("multiple vertex buffers");
    }
    const vertexView = vertices[0];
    if (!ArrayBuffer.isView(vertexView)) {
      throw rendererError("E_CONTRACT", "mesh vertices must be an ArrayBufferView", {
        label,
        recoverable: false,
      });
    }
    const vertexBytes = vertexView.byteLength;
    if (vertexBytes === 0 || vertexBytes % 32 !== 0) {
      throw rendererError(
        "E_CONTRACT",
        "mesh vertex bytes must be a positive multiple of 32",
        { label, recoverable: false },
      );
    }
    const vertexCount = vertexBytes / 32;

    const indexValue = raw["indices"];
    let indexData: Uint16Array | Uint32Array | null = null;
    let indexFormat: "uint16" | "uint32" = "uint16";
    if (indexValue !== undefined) {
      if (typeof indexValue !== "object" || indexValue === null) {
        throw rendererError("E_CONTRACT", "mesh indices must be an object", {
          label,
          recoverable: false,
        });
      }
      const indexRecord = indexValue as {
        readonly data?: unknown;
        readonly format?: unknown;
      };
      const data = indexRecord.data;
      if (!(data instanceof Uint16Array) && !(data instanceof Uint32Array)) {
        throw rendererError(
          "E_CONTRACT",
          "mesh indices must be Uint16Array or Uint32Array",
          { label, recoverable: false },
        );
      }
      if (data.length === 0 || data.length % 3 !== 0) {
        throw rendererError(
          "E_CONTRACT",
          "mesh index count must be a positive multiple of 3",
          { label, recoverable: false },
        );
      }
      const expectedFormat = vertexCount <= 65_535 ? "uint16" : "uint32";
      if (indexRecord.format !== expectedFormat) {
        throw rendererError(
          "E_CONTRACT",
          `mesh index format must be ${expectedFormat}`,
          { label, recoverable: false },
        );
      }
      for (let index = 0; index < data.length; index += 1) {
        if ((data[index] ?? 0) >= vertexCount) {
          throw rendererError(
            "E_CONTRACT",
            "mesh index exceeds vertex count",
            { label, recoverable: false },
          );
        }
      }
      indexData = data;
      indexFormat = expectedFormat;
    }

    const boundsValue = raw["bounds"];
    if (typeof boundsValue !== "object" || boundsValue === null) {
      throw rendererError("E_CONTRACT", "mesh bounds are required", {
        label,
        recoverable: false,
      });
    }
    const bounds = boundsValue as {
      readonly center?: unknown;
      readonly radius?: unknown;
    };
    const center = bounds.center as
      | { readonly x?: unknown; readonly y?: unknown; readonly z?: unknown }
      | undefined;
    if (
      center === undefined ||
      typeof center.x !== "number" ||
      typeof center.y !== "number" ||
      typeof center.z !== "number" ||
      !Number.isFinite(center.x) ||
      !Number.isFinite(center.y) ||
      !Number.isFinite(center.z) ||
      typeof bounds.radius !== "number" ||
      !Number.isFinite(bounds.radius) ||
      bounds.radius < 0
    ) {
      throw rendererError("E_CONTRACT", "mesh bounds are invalid", {
        label,
        recoverable: false,
      });
    }

    const restorable = this.options.retainCpuCopies;
    const record: MeshRecord = {
      desc,
      label,
      layout: layoutValue,
      vertexCount,
      vertexBytes,
      indexCount: indexData?.length ?? 0,
      indexFormat,
      indexBytes: indexData === null ? 0 : indexData.byteLength,
      restorable,
      pending: false,
      vertexBuffer: null,
      indexBuffer: null,
    };
    this.buildMeshGpu(record);
    const slot = this.meshStore.addWithGeneration(record);
    return makeHandle("mesh", slot.index, slot.generation);
  }

  createMaterial(desc: MaterialDesc): MaterialHandle {
    this.assertRunning("createMaterial");
    const label = validateLabel(
      (desc as unknown as { readonly label?: unknown }).label,
      "material",
    );
    const raw = desc as unknown as Readonly<Record<string, unknown>>;
    const baseColor = raw["baseColorFactor"];
    if (
      !Array.isArray(baseColor) ||
      baseColor.length !== 4 ||
      !baseColor.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)
    ) {
      throw rendererError("E_CONTRACT", "baseColorFactor must be four values in 0..1", {
        label,
        recoverable: false,
      });
    }
    const metallic = raw["metallic"];
    if (
      typeof metallic !== "number" ||
      !Number.isFinite(metallic) ||
      metallic < 0 ||
      metallic > 1
    ) {
      throw rendererError("E_CONTRACT", "metallic must be in 0..1", {
        label,
        recoverable: false,
      });
    }
    const roughness = raw["roughness"];
    if (typeof roughness !== "number" || !Number.isFinite(roughness)) {
      throw rendererError("E_CONTRACT", "roughness must be finite", {
        label,
        recoverable: false,
      });
    }
    const emissive = raw["emissiveFactor"];
    if (
      !Array.isArray(emissive) ||
      emissive.length !== 3 ||
      !emissive.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw rendererError("E_CONTRACT", "emissiveFactor must be three finite values", {
        label,
        recoverable: false,
      });
    }
    const alphaMode = raw["alphaMode"] ?? "opaque";
    if (alphaMode !== "opaque") {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        "mask and blend materials are M1",
        { label, recoverable: false },
      );
    }
    if (raw["doubleSided"] === true) {
      throw rendererError("E_UNSUPPORTED_FEATURE", "double-sided materials are M1", {
        label,
        recoverable: false,
      });
    }
    for (const slot of [
      "metallicRoughnessTexture",
      "normalTexture",
      "occlusionTexture",
      "emissiveTexture",
    ] as const) {
      const value = raw[slot];
      if (value !== undefined && value !== null) {
        throw rendererError(
          "E_UNSUPPORTED_FEATURE",
          `${slot} is M1`,
          { label, recoverable: false },
        );
      }
    }
    const baseTextureValue = raw["baseColorTexture"];
    let baseTexture: TextureHandle | null = null;
    if (baseTextureValue !== undefined && baseTextureValue !== null) {
      if (
        typeof baseTextureValue !== "object" ||
        kindOf(baseTextureValue as GpuHandle) !== "texture"
      ) {
        throw rendererError("E_CONTRACT", "baseColorTexture must be a texture handle", {
          label,
          recoverable: false,
        });
      }
      const textureRecord = this.textureStore.get(baseTextureValue as GpuHandle);
      if (textureRecord === undefined) {
        this.staleHandle("createMaterial");
      } else {
        if (textureRecord.layers !== 1) {
          throw rendererError(
            "E_UNSUPPORTED_FEATURE",
            "texture arrays in materials are M1",
            { label, recoverable: false },
          );
        }
        if (!textureRecord.sampled) {
          throw rendererError(
            "E_ASSET_FORMAT",
            "baseColorTexture lacks sample usage",
            { label, recoverable: false },
          );
        }
        if (!isSrgbColorFormat(textureRecord.format)) {
          throw rendererError(
            "E_ASSET_FORMAT",
            "baseColorTexture must be an sRGB colour format",
            { label, recoverable: false },
          );
        }
        baseTexture = baseTextureValue as TextureHandle;
      }
    }
    const factor = baseColor as readonly number[];
    const record: MaterialRecord = {
      desc,
      label,
      baseTexture,
      tintR: factor[0] ?? 1,
      tintG: factor[1] ?? 1,
      tintB: factor[2] ?? 1,
      tintA: factor[3] ?? 1,
      unlit: raw["unlit"] === true,
      restorable: true,
      pending: false,
      bindGroup: null,
    };
    this.buildMaterialGpu(record);
    const slot = this.materialStore.addWithGeneration(record);
    return makeHandle("material", slot.index, slot.generation);
  }

  createLodGroup(_desc: LodGroupDesc): LodGroupHandle {
    void _desc;
    this.assertRunning("createLodGroup");
    throw unsupported("LOD groups");
  }

  createRenderTarget(_desc: RenderTargetDesc): RenderTargetHandle {
    void _desc;
    this.assertRunning("createRenderTarget");
    throw unsupported("render targets");
  }

  destroy(handle: GpuHandle): void {
    if (typeof handle !== "object" || handle === null) {
      this.staleHandle("destroy");
      return;
    }
    const kind = kindOf(handle);
    if (kind === "shader") {
      const record = this.shaderStore.get(handle);
      if (record === undefined) {
        this.staleHandle("shader");
        return;
      }
      this.shaderStore.free(handle);
      this.shaderCache.delete(record.key);
      this.shaderHandleByKey.delete(record.key);
      return;
    }
    if (kind === "pipeline") {
      const record = this.pipelineStore.get(handle);
      if (record === undefined) {
        this.staleHandle("pipeline");
        return;
      }
      this.pipelineStore.free(handle);
      this.pipelineCache.delete(record.key);
      const mapped = this.pipelineHandleByKey.get(record.key.canonical);
      if (
        mapped !== undefined &&
        mapped.index === handle.index &&
        mapped.generation === handle.generation
      ) {
        this.pipelineHandleByKey.delete(record.key.canonical);
      }
      return;
    }
    if (kind === "texture") {
      const record = this.textureStore.get(handle);
      if (record === undefined) {
        this.staleHandle("texture");
        return;
      }
      if (record.texture !== null) {
        record.texture.destroy();
        this.stats.textureBytes = Math.max(0, this.stats.textureBytes - record.bytes);
      }
      this.textureStore.free(handle);
      return;
    }
    if (kind === "sampler") {
      const record = this.samplerStore.get(handle);
      if (record === undefined) {
        this.staleHandle("sampler");
        return;
      }
      this.samplerStore.free(handle);
      this.samplerCache.delete(record.key);
      const mapped = this.samplerHandleByKey.get(record.key);
      if (
        mapped !== undefined &&
        mapped.index === handle.index &&
        mapped.generation === handle.generation
      ) {
        this.samplerHandleByKey.delete(record.key);
      }
      return;
    }
    if (kind === "buffer") {
      const record = this.bufferStore.get(handle);
      if (record === undefined) {
        this.staleHandle("buffer");
        return;
      }
      if (record.buffer !== null) {
        record.buffer.destroy();
        this.stats.bufferBytes = Math.max(0, this.stats.bufferBytes - record.gpuBytes);
      }
      this.bufferStore.free(handle);
      return;
    }
    if (kind === "mesh") {
      const record = this.meshStore.get(handle);
      if (record === undefined) {
        this.staleHandle("mesh");
        return;
      }
      if (record.vertexBuffer !== null || record.indexBuffer !== null) {
        const bytes = align4(record.vertexBytes) + align4(record.indexBytes);
        record.vertexBuffer?.destroy();
        record.indexBuffer?.destroy();
        this.stats.bufferBytes = Math.max(0, this.stats.bufferBytes - bytes);
      }
      this.meshStore.free(handle);
      return;
    }
    if (kind === "material") {
      if (this.materialStore.free(handle) === undefined) {
        this.staleHandle("material");
      }
      return;
    }
    this.staleHandle("handle");
  }

  async restore(): Promise<RestoreResult> {
    if (this.stateValue === "disposed") {
      return {
        ok: false,
        reason: "disposed",
        restoredHandles: 0,
        staleHandles: 0,
      };
    }
    if (this.stateValue === "uninitialized") {
      throw rendererError("E_BACKEND_INIT", "restore() before init()", {
        label: "device",
        recoverable: false,
      });
    }
    if (this.stateValue === "running") {
      return { ok: true, restoredHandles: 0, staleHandles: 0 };
    }
    if (this.stateValue === "restoring") {
      throw rendererError("E_DEVICE_LOST", "restore() already in progress", {
        label: "device",
        recoverable: true,
      });
    }
    if (this.stateValue === "failed") {
      throw rendererError("E_DEVICE_LOST", "device restore already failed", {
        label: "device",
        recoverable: true,
      });
    }

    this.stateValue = "restoring";
    let acquired;
    try {
      acquired = await acquireWebGpuDevice(this.gpu, this.options);
    } catch (error) {
      if (this.deviceState === "disposed") {
        return {
          ok: false,
          reason: "disposed",
          restoredHandles: 0,
          staleHandles: 0,
        };
      }
      this.stateValue = "failed";
      this.stats.gpuErrors += 1;
      return {
        ok: false,
        reason: reasonForAcquire(error),
        restoredHandles: 0,
        staleHandles: 0,
      };
    }
    if (this.deviceState === "disposed") {
      acquired.device.destroy();
      return {
        ok: false,
        reason: "disposed",
        restoredHandles: 0,
        staleHandles: 0,
      };
    }

    this.detachDeviceListeners();
    this.gpuDevice = acquired.device;
    this.adapter = acquired.adapter;
    this.requestedFeatures = acquired.requestedFeatures;
    this.limitsValue = acquired.limits;
    this.capabilitiesValue = acquired.capabilities;
    this.adapterInfoValue = this.currentAdapterInfo();
    this.objectRing = new UniformRing(
      undefined,
      this.limitsValue.minUniformBufferOffsetAlignment,
    );
    this.prepareRings();
    this.attachDevice(this.gpuDevice);
    this.swapchain?.setDevice(this.gpuDevice);
    this.stats.textureBytes = 0;
    this.stats.bufferBytes = 0;
    this.pipelineCache.clear();
    this.shaderCache.clear();
    this.failedPipelineKeys.clear();
    this.litModule = null;
    this.litPipelines.fill(null);
    this.litFailed.fill(false);
    try {
      this.createBuiltinResources();
    } catch {
      this.detachDeviceListeners();
      acquired.device.destroy();
      this.stateValue = "failed";
      this.destroyBuiltinResources();
      this.stats.textureBytes = 0;
      this.stats.bufferBytes = 0;
      this.stats.gpuErrors += 1;
      return {
        ok: false,
        reason: "device-request-failed",
        restoredHandles: 0,
        staleHandles: this.countStaleHandles(),
      };
    }
    this.stateValue = "running";
    const restorableHandles = this.countRestorableHandles();
    const staleHandles = this.countStaleHandles();
    this.notifyRestored();
    return { ok: true, restoredHandles: restorableHandles, staleHandles };
  }

  /**
   * Real device destruction for the `./dev` test hook. Returns false unless
   * the device is running, so it cannot disturb an in-progress restore.
   */
  [FORCE_DEVICE_LOST](): boolean {
    if (this.stateValue !== "running") return false;
    this.gpuDevice.destroy();
    return true;
  }

  onDeviceLost(listener: DeviceLostListener): () => void {
    if (this.stateValue === "disposed") {
      return () => {};
    }
    this.deviceLostListeners.push(listener);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      const index = this.deviceLostListeners.indexOf(listener);
      if (index >= 0) {
        this.deviceLostListeners.splice(index, 1);
      }
    };
  }

  onRestored(listener: RestoredListener): () => void {
    if (this.stateValue === "disposed") {
      return () => {};
    }
    this.restoredListeners.push(listener);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      const index = this.restoredListeners.indexOf(listener);
      if (index >= 0) {
        this.restoredListeners.splice(index, 1);
      }
    };
  }

  readTexture(
    _handle: TextureHandle,
    _opts: ReadbackOptions,
  ): Promise<Uint8Array> {
    void _handle;
    void _opts;
    return Promise.reject(unsupported("readTexture"));
  }

  captureFrame(): Promise<FrameCapture> {
    return Promise.reject(unsupported("captureFrame"));
  }

  dispose(): void {
    if (this.stateValue === "disposed") {
      return;
    }
    this.stateValue = "disposed";
    this.detachDeviceListeners();
    this.abortFrame();
    this.swapchain?.destroy();
    this.swapchain = null;
    this.textureStore.forEachLive((_index, _generation, record) => {
      record.texture?.destroy();
    });
    this.bufferStore.forEachLive((_index, _generation, record) => {
      record.buffer?.destroy();
    });
    this.meshStore.forEachLive((_index, _generation, record) => {
      record.vertexBuffer?.destroy();
      record.indexBuffer?.destroy();
    });
    this.destroyBuiltinResources();
    try {
      this.gpuDevice.destroy();
    } catch {
      // A lost device may already be destroyed; disposal remains idempotent.
    }
    this.stats.textureBytes = 0;
    this.stats.bufferBytes = 0;
    this.stats.gpuFrameMs = null;
    this.shaderStore.invalidateAll();
    this.pipelineStore.invalidateAll();
    this.textureStore.invalidateAll();
    this.samplerStore.invalidateAll();
    this.bufferStore.invalidateAll();
    this.meshStore.invalidateAll();
    this.lodGroupStore.invalidateAll();
    this.materialStore.invalidateAll();
    this.renderTargetStore.invalidateAll();
    this.shaderHandleByKey.clear();
    this.pipelineHandleByKey.clear();
    this.samplerHandleByKey.clear();
    this.deviceLostListeners.length = 0;
    this.restoredListeners.length = 0;
    this.surface = null;
    this.frameColorView = null;
  }

  private frameUniformDirty = true;

  private createFrame(): RenderFrame {
    // The frame object's getter and methods must reach the owning device.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const device = this;
    return {
      get valid(): boolean {
        return (
          device.frameActive && device.frameOpen && !device.frameSuppressed
        );
      },
      setCamera(viewProjection: Mat4): void {
        device.setCamera(viewProjection);
      },
      setCameraMatrices(view: Mat4, projection: Mat4): void {
        device.setCameraMatrices(view, projection);
      },
      draw(
        mesh: MeshHandle,
        material: MaterialHandle,
        transform: Mat4,
      ): void {
        device.drawMesh(mesh, material, transform);
      },
      drawInstanced(
        mesh: MeshHandle,
        material: MaterialHandle,
        transforms: Float32Array,
        count: number,
      ): void {
        device.drawMeshInstanced(mesh, material, transforms, count);
      },
      drawLod(
        _group: LodGroupHandle,
        _material: MaterialHandle,
        _transform: Mat4,
      ): void {
        void _group;
        void _material;
        void _transform;
        throw unsupported("drawLod");
      },
      beginPass(_desc: RenderPassDesc): RenderPassEncoder {
        void _desc;
        throw unsupported("beginPass");
      },
      drawFullscreen(
        _source: TextureHandle,
        _material: MaterialHandle,
      ): void {
        void _source;
        void _material;
        throw unsupported("drawFullscreen");
      },
    };
  }

  private assertRunning(operation: string): void {
    if (this.stateValue === "running") {
      return;
    }
    if (this.stateValue === "uninitialized") {
      throw rendererError(
        "E_BACKEND_INIT",
        `${operation} called before init()`,
        { label: "device", recoverable: false },
      );
    }
    throw rendererError(
      "E_DEVICE_LOST",
      `${operation} called while device is ${this.stateValue}`,
      { label: "device", recoverable: true },
    );
  }

  private preferredFormat(): WebGpuCanvasFormat {
    const format = this.gpu.getPreferredCanvasFormat();
    if (format === "bgra8unorm" || format === "rgba8unorm") {
      return format;
    }
    throw rendererError(
      "E_BACKEND_INIT",
      `unsupported preferred canvas format: ${String(format)}`,
      { label: "swapchain", recoverable: false },
    );
  }

  private currentAdapterInfo(): string {
    const info = (this.adapter as GPUAdapter & {
      readonly info?: {
        readonly vendor?: string;
        readonly architecture?: string;
        readonly device?: string;
        readonly description?: string;
      };
    }).info;
    if (info === undefined) {
      return "WebGPU adapter";
    }
    const joined = [info.description, info.vendor, info.architecture, info.device]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ")
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\b(?:token|pin|room|session|secret|key)=[^\s&]+/gi, "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return joined.length > 0 ? joined.slice(0, 120) : "WebGPU adapter";
  }

  private recomputeCapabilities(): WebGpuCapabilities {
    const features = new Set<EngineFeature>(["texture-array"]);
    for (const feature of this.requestedFeatures) {
      if (feature === "texture-compression-bc") {
        features.add("compressed-s3tc");
      } else if (feature === "texture-compression-etc2") {
        features.add("compressed-etc2");
      } else if (feature === "texture-compression-astc") {
        features.add("compressed-astc");
      }
    }
    const supportedFormats = new Set<TextureFormat>();
    for (const format of this.capabilitiesValue.supportedFormats) {
      if (supportsFormat(format, this.adapterFeatureProbe)) {
        supportedFormats.add(format);
      }
    }
    return {
      ...this.capabilitiesValue,
      features,
      supportedFormats,
      quality: this.options.quality,
      anisotropy: Math.min(
        this.options.anisotropy,
        this.limitsValue.maxSamplerAnisotropy,
      ),
    };
  }

  private prepareRings(): void {
    this.objectRingCpu = new Float32Array(this.objectRing.capacityBytes / 4);
    this.objectRingBytes = new Uint8Array(this.objectRingCpu.buffer);
    // One float per four bytes; the stride is baked into each 16-float
    // instance, never into the capacity.
    this.instanceRingCpu = new Float32Array(this.instanceRing.capacityBytes / 4);
    this.instanceRingBytes = new Uint8Array(this.instanceRingCpu.buffer);
  }

  private prepareBuiltinPipelineKeys(): void {
    const colorFormats: readonly TextureFormat[] = [this.canvasFormatValue];
    const staticInputs: PipelineKeyInputs = {
      vertexShaderKey: BUILTIN_VERTEX_KEY,
      fragmentShaderKey: BUILTIN_FRAGMENT_KEY,
      vertexLayout: "static-pbr-v1",
      primitiveState: DEFAULT_PRIMITIVE_STATE,
      depthState: DEFAULT_DEPTH_STATE,
      multisample: 1,
      colorFormats,
      blendStates: ["off"],
      layoutId: "builtin-pbr-v1",
      definesCanonical: "{}",
    };
    const instancedInputs: PipelineKeyInputs = {
      ...staticInputs,
      vertexShaderKey: BUILTIN_INSTANCED_VERTEX_KEY,
      vertexLayout: "instanced-transform-v1",
    };
    this.litKeys[0] = canonicalPipelineKey(staticInputs);
    this.litKeys[1] = canonicalPipelineKey({
      ...staticInputs,
      fragmentShaderKey: BUILTIN_UNLIT_FRAGMENT_KEY,
    });
    this.litKeys[2] = canonicalPipelineKey(instancedInputs);
    this.litKeys[3] = canonicalPipelineKey({
      ...instancedInputs,
      fragmentShaderKey: BUILTIN_UNLIT_FRAGMENT_KEY,
    });
  }

  private createBuiltinResources(): void {
    this.destroyBuiltinResources();
    const alignment = this.limitsValue.minUniformBufferOffsetAlignment;
    this.objectRing = new UniformRing(undefined, alignment);
    this.prepareRings();
    this.objectBuffer = this.createInternalBuffer(
      "object-ring",
      this.objectRing.capacityBytes,
      BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    );
    this.instanceBuffer = this.createInternalBuffer(
      "instance-ring",
      this.instanceRing.capacityBytes,
      BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
    );
    this.frameBuffers = [];
    for (let slot = 0; slot < 3; slot += 1) {
      this.frameBuffers.push(
        this.createInternalBuffer(
          "frame-uniform",
          FRAME_UNIFORM_BYTES,
          BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
        ),
      );
    }
    this.lightBuffer = this.createInternalBuffer(
      "light-uniform",
      LIGHT_UNIFORM_BYTES,
      BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    );
    writeLightUniforms(this.lightFloats, this.lightUints, {
      directionalCount: 1,
      pointCount: 0,
      cascadeCount: 0,
      flags: 0,
      directionX: -0.45,
      directionY: -0.8,
      directionZ: -0.35,
      colorR: 1,
      colorG: 1,
      colorB: 1,
      intensity: 1,
    });
    this.queueUpload(this.lightBuffer, 0, this.lightBytes, 0, LIGHT_UNIFORM_BYTES);

    this.whiteTexture = this.gpuDevice.createTexture({
      label: "white-fallback",
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: "2d",
      format: "rgba8unorm",
      usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST,
    });
    this.whiteView = this.whiteTexture.createView({
      dimension: "2d",
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: 1,
    });
    this.whiteBytes = new Uint8Array(256);
    this.whiteBytes[0] = 255;
    this.whiteBytes[1] = 255;
    this.whiteBytes[2] = 255;
    this.whiteBytes[3] = 255;
    this.gpuDevice.queue.writeTexture(
      {
        texture: this.whiteTexture,
        mipLevel: 0,
        origin: { x: 0, y: 0, z: 0 },
      },
      this.whiteBytes,
      { offset: 0, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    this.stats.textureBytes += 256;
    this.stats.uploadBytes += 256;
    this.stats.uploadCalls += 1;

    this.defaultSampler = this.gpuDevice.createSampler({
      label: "default-sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
      maxAnisotropy: 1,
    });
    this.createLayouts();
    this.frameBindGroups = [];
    this.lightBindGroups = [];
    const materialLayout = this.materialBindGroupLayout;
    const frameLayout = this.frameBindGroupLayout;
    const lightLayout = this.lightBindGroupLayout;
    const pbrLayout = this.pbrPipelineLayout;
    const objectLayout = this.objectBindGroupLayout;
    const objectBuffer = this.objectBuffer;
    if (
      materialLayout === null ||
      frameLayout === null ||
      lightLayout === null ||
      pbrLayout === null ||
      objectLayout === null ||
      objectBuffer === null
    ) {
      throw rendererError("E_BACKEND_INIT", "pipeline layouts missing", {
        label: "pipeline",
        recoverable: false,
      });
    }
    this.objectBindGroup = this.gpuDevice.createBindGroup({
      label: "object-bind-group",
      layout: objectLayout,
      // A dynamic uniform binding is validated against
      // maxUniformBufferBindingSize, so the 2 MiB ring cannot be bound whole.
      // Bind one 256-byte slot; the per-draw dynamic offset selects it.
      entries: [
        {
          binding: 0,
          resource: {
            buffer: objectBuffer,
            offset: 0,
            size: OBJECT_UNIFORM_BYTES,
          },
        },
      ],
    });
    for (let slot = 0; slot < 3; slot += 1) {
      const frameBuffer = this.frameBuffers[slot];
      if (frameBuffer === undefined) {
        throw rendererError("E_BACKEND_INIT", "frame buffer missing", {
          label: "pipeline",
          recoverable: false,
        });
      }
      this.frameBindGroups.push(
        this.gpuDevice.createBindGroup({
          label: "frame-bind-group",
          layout: frameLayout,
          entries: [{ binding: 0, resource: { buffer: frameBuffer } }],
        }),
      );
      this.lightBindGroups.push(
        this.gpuDevice.createBindGroup({
          label: "light-bind-group",
          layout: lightLayout,
          entries: [{ binding: 0, resource: { buffer: this.lightBuffer } }],
        }),
      );
    }
    this.litPipelines.fill(null);
    this.litFailed.fill(false);
    this.litModule = null;
    this.builtinPipelineCache.clear();
    this.frameUniformDirty = true;
    this.passBindingsReady = false;
    const swapchain = this.swapchain;
    if (swapchain !== null) {
      const width = swapchain.canvasWidth;
      const height = swapchain.canvasHeight;
      if (width > 0 && height > 0) {
        this.ensureDepth(width, height);
      }
    }
  }

  private createLayouts(): void {
    const frameEntry: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: FRAME_UNIFORM_BYTES },
    };
    const lightEntry: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: SHADER_STAGE.FRAGMENT,
      buffer: { type: "uniform", minBindingSize: LIGHT_UNIFORM_BYTES },
    };
    const textureEntry: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: SHADER_STAGE.FRAGMENT,
      texture: { sampleType: "float", viewDimension: "2d", multisampled: false },
    };
    const samplerEntry: GPUBindGroupLayoutEntry = {
      binding: 1,
      visibility: SHADER_STAGE.FRAGMENT,
      sampler: { type: "filtering" },
    };
    const objectEntry: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: SHADER_STAGE.VERTEX | SHADER_STAGE.FRAGMENT,
      buffer: {
        type: "uniform",
        hasDynamicOffset: true,
        minBindingSize: OBJECT_UNIFORM_BYTES,
      },
    };
    const frameLayout = this.gpuDevice.createBindGroupLayout({
      label: "builtin-frame",
      entries: [frameEntry],
    });
    const lightLayout = this.gpuDevice.createBindGroupLayout({
      label: "builtin-light",
      entries: [lightEntry],
    });
    this.frameBindGroupLayout = frameLayout;
    this.lightBindGroupLayout = lightLayout;
    this.materialBindGroupLayout = this.gpuDevice.createBindGroupLayout({
      label: "builtin-material",
      entries: [textureEntry, samplerEntry],
    });
    const objectLayout = this.gpuDevice.createBindGroupLayout({
      label: "builtin-object",
      entries: [objectEntry],
    });
    this.objectBindGroupLayout = objectLayout;
    this.pbrPipelineLayout = this.gpuDevice.createPipelineLayout({
      label: "builtin-pbr-v1",
      bindGroupLayouts: [
        frameLayout,
        lightLayout,
        this.materialBindGroupLayout,
        objectLayout,
      ],
    });
    this.twoDPipelineLayout = this.gpuDevice.createPipelineLayout({
      label: "builtin-2d-v1",
      bindGroupLayouts: [frameLayout],
    });
  }

  private createInternalBuffer(
    label: string,
    size: number,
    usage: GPUBufferUsageFlags,
  ): GPUBuffer {
    const buffer = this.gpuDevice.createBuffer({ label, size, usage });
    this.stats.bufferBytes += size;
    return buffer;
  }

  private ensureDepth(width: number, height: number): void {
    if (this.depthTexture !== null && this.depthWidth === width && this.depthHeight === height) {
      return;
    }
    this.destroyDepth();
    const bytes = textureMemoryBytes("depth24plus", width, height, 1, 1);
    if (this.stats.textureBytes + bytes > this.options.maxTextureBytes) {
      throw rendererError(
        "E_ASSET_BUDGET",
        "depth texture exceeds the texture memory budget",
        { label: "depth", recoverable: false },
      );
    }
    let texture: GPUTexture | null = null;
    try {
      texture = this.gpuDevice.createTexture({
        label: "swapchain-depth",
        size: { width, height, depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: "2d",
        format: "depth24plus",
        usage: TEXTURE_USAGE.RENDER_ATTACHMENT,
      });
      const view = texture.createView({
        dimension: "2d",
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1,
        aspect: "depth-only",
      });
      this.depthTexture = texture;
      this.depthView = view;
      this.depthWidth = width;
      this.depthHeight = height;
      this.stats.textureBytes += bytes;
    } catch (error) {
      texture?.destroy();
      throw error;
    }
  }

  private destroyDepth(): void {
    if (this.depthTexture === null) {
      this.depthView = null;
      this.depthWidth = 0;
      this.depthHeight = 0;
      return;
    }
    this.depthTexture.destroy();
    this.depthTexture = null;
    this.depthView = null;
    this.depthWidth = 0;
    this.depthHeight = 0;
  }

  private destroyBuiltinResources(): void {
    this.destroyDepth();
    if (this.whiteTexture !== null) {
      this.whiteTexture.destroy();
      this.whiteTexture = null;
    }
    this.whiteView = null;
    this.defaultSampler = null;
    this.lightBuffer?.destroy();
    this.lightBuffer = null;
    this.objectBuffer?.destroy();
    this.objectBuffer = null;
    this.instanceBuffer?.destroy();
    this.instanceBuffer = null;
    this.objectBindGroup = null;
    this.objectBindGroupLayout = null;
    this.frameBindGroupLayout = null;
    this.lightBindGroupLayout = null;
    for (const buffer of this.frameBuffers) {
      buffer.destroy();
    }
    this.frameBuffers = [];
    this.frameBindGroups = [];
    this.lightBindGroups = [];
    this.pbrPipelineLayout = null;
    this.twoDPipelineLayout = null;
    this.materialBindGroupLayout = null;
    this.litModule = null;
    this.litPipelines.fill(null);
    this.litFailed.fill(false);
    this.builtinPipelineCache.clear();
    this.currentEncoder = null;
    this.currentPass = null;
    this.currentSwapTexture = null;
    this.lastMaterialGroup = null;
    this.lastPipeline = null;
    this.passBindingsReady = false;
  }

  private attachDevice(device: GPUDevice): void {
    const facade = device as GPUDevice & {
      addEventListener?: (type: string, listener: (event: unknown) => void) => void;
      removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
    };
    this.listenedDevice = facade;
    facade.addEventListener?.("uncapturederror", this.uncapturedHandler);
    const lost = device.lost;
    if (lost !== undefined && typeof lost.then === "function") {
      lost
        .then((info) => {
          const reason: "destroyed" | "unknown" =
            info.reason === "destroyed" ? "destroyed" : "unknown";
          this.handleDeviceLoss(device, reason, info.message);
        })
        .catch(() => {
          this.handleDeviceLoss(device, "unknown", "device lost promise rejected");
        });
    }
  }

  private detachDeviceListeners(): void {
    const device = this.listenedDevice;
    if (device !== null) {
      device.removeEventListener?.("uncapturederror", this.uncapturedHandler);
    }
    this.listenedDevice = null;
  }

  private handleDeviceLoss(
    source: GPUDevice,
    reason: "destroyed" | "unknown",
    message: string,
  ): void {
    if (this.stateValue === "disposed" || source !== this.gpuDevice) {
      return;
    }
    this.lossCount += 1;
    this.abortFrame();
    this.stats.gpuErrors += 1;
    this.stats.textureBytes = 0;
    this.stats.bufferBytes = 0;
    this.markHandlesLost();
    this.pipelineCache.clear();
    this.shaderCache.clear();
    this.failedPipelineKeys.clear();
    this.destroyBuiltinResources();
    if (this.lossCount > 1) {
      this.stateValue = "failed";
    } else {
      this.stateValue = "lost";
    }
    const clean = message
      .replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    const info = {
      reason,
      message: clean.length > 0 ? clean : "WebGPU device lost",
    };
    for (const listener of this.deviceLostListeners) {
      try {
        listener(info);
      } catch {
        // A listener must not break recovery or the game loop.
      }
    }
  }

  private notifyRestored(): void {
    for (const listener of this.restoredListeners) {
      try {
        listener();
      } catch {
        // Listener failures are isolated from the renderer state machine.
      }
    }
  }

  private markHandlesLost(): void {
    this.shaderStore.forEachLive((_index, _generation, record) => {
      record.pending = true;
      record.module = null;
    });
    this.pipelineStore.forEachLive((_index, _generation, record) => {
      record.pending = true;
      record.pipeline = null;
    });
    this.textureStore.forEachLive((_index, _generation, record) => {
      record.pending = record.restorable;
      record.texture = null;
      record.view = null;
      record.sampler = null;
    });
    this.samplerStore.forEachLive((_index, _generation, record) => {
      record.pending = true;
      record.sampler = null;
    });
    this.bufferStore.forEachLive((_index, _generation, record) => {
      record.pending = record.restorable;
      record.buffer = null;
    });
    this.meshStore.forEachLive((_index, _generation, record) => {
      record.pending = record.restorable;
      record.vertexBuffer = null;
      record.indexBuffer = null;
    });
    this.materialStore.forEachLive((_index, _generation, record) => {
      record.pending = true;
      record.bindGroup = null;
    });
  }

  private countRestorableHandles(): number {
    let count = 0;
    this.shaderStore.forEachLive((_index, _generation, record) => {
      if (record.pending) count += 1;
    });
    this.pipelineStore.forEachLive((_index, _generation, record) => {
      if (record.pending) count += 1;
    });
    this.textureStore.forEachLive((_index, _generation, record) => {
      if (record.restorable) count += 1;
    });
    this.samplerStore.forEachLive((_index, _generation, record) => {
      if (record.restorable) count += 1;
    });
    this.bufferStore.forEachLive((_index, _generation, record) => {
      if (record.restorable) count += 1;
    });
    this.meshStore.forEachLive((_index, _generation, record) => {
      if (record.restorable) count += 1;
    });
    this.materialStore.forEachLive((_index, _generation, record) => {
      if (record.restorable) count += 1;
    });
    return count;
  }

  private countStaleHandles(): number {
    let count = 0;
    this.textureStore.forEachLive((_index, _generation, record) => {
      if (!record.restorable) count += 1;
    });
    this.bufferStore.forEachLive((_index, _generation, record) => {
      if (!record.restorable) count += 1;
    });
    this.meshStore.forEachLive((_index, _generation, record) => {
      if (!record.restorable) count += 1;
    });
    return count;
  }

  private abortFrame(): void {
    this.frameActive = false;
    this.frameOpen = false;
    this.frameSuppressed = false;
    this.currentEncoder = null;
    this.currentPass = null;
    this.currentSwapTexture = null;
    this.frameColorView = null;
    this.lastMaterialGroup = null;
    this.lastPipeline = null;
    this.passBindingsReady = false;
  }

  private setCamera(viewProjection: Mat4): void {
    this.requireFrame();
    if (!matrixIsFinite(viewProjection)) {
      if (IS_DEV) {
        throw rendererError("E_CONTRACT", "viewProjection matrix is not finite", {
          label: "camera",
          recoverable: false,
        });
      }
      mat4Identity(this.viewProjection);
      this.cameraSet = true;
      this.frustumActive = false;
      this.stats.gpuErrors += 1;
      return;
    }
    mat4Copy(this.viewProjection, viewProjection);
    this.culler.update(this.viewProjection);
    this.cameraSet = true;
    this.frustumActive = true;
    this.frameUniformDirty = true;
  }

  private setCameraMatrices(view: Mat4, projection: Mat4): void {
    this.requireFrame();
    if (!matrixIsFinite(view) || !matrixIsFinite(projection)) {
      if (IS_DEV) {
        throw rendererError("E_CONTRACT", "camera matrix is not finite", {
          label: "camera",
          recoverable: false,
        });
      }
      mat4Identity(this.viewProjection);
      this.cameraSet = true;
      this.frustumActive = false;
      this.stats.gpuErrors += 1;
      return;
    }
    mat4Multiply(this.viewProjection, projection, view);
    this.culler.update(this.viewProjection);
    if (mat4Invert(this.inverseView, view)) {
      this.cameraX = this.inverseView.m[12] ?? 0;
      this.cameraY = this.inverseView.m[13] ?? 0;
      this.cameraZ = this.inverseView.m[14] ?? 0;
    } else {
      this.cameraX = 0;
      this.cameraY = 0;
      this.cameraZ = 0;
    }
    this.cameraSet = true;
    this.frustumActive = true;
    this.frameUniformDirty = true;
  }

  private requireFrame(): void {
    if (!this.frameActive) {
      if (IS_DEV) {
        throw rendererError("E_FRAME_CLOSED", "no frame is open", {
          label: "frame",
          recoverable: false,
        });
      }
      return;
    }
    if (!this.frameOpen) {
      if (IS_DEV) {
        throw rendererError("E_FRAME_CLOSED", "frame has no render pass", {
          label: "frame",
          recoverable: false,
        });
      }
    }
  }

  private ensureCamera(): boolean {
    if (this.cameraSet) {
      return true;
    }
    if (IS_DEV) {
      throw rendererError("E_CONTRACT", "draw before setCamera", {
        label: "camera",
        recoverable: false,
      });
    }
    mat4Identity(this.viewProjection);
    this.cameraSet = true;
    this.frustumActive = false;
    this.stats.gpuErrors += 1;
    return true;
  }

  private canDraw(): boolean {
    if (!this.frameActive) {
      if (IS_DEV) {
        throw rendererError("E_FRAME_CLOSED", "draw after endFrame", {
          label: "frame",
          recoverable: false,
        });
      }
      return false;
    }
    if (!this.frameOpen || this.frameSuppressed) {
      return false;
    }
    return true;
  }

  private drawMesh(
    mesh: MeshHandle,
    material: MaterialHandle,
    transform: Mat4,
  ): void {
    if (!this.canDraw()) {
      return;
    }
    this.ensureCamera();
    const meshRecord = this.meshStore.get(mesh);
    if (meshRecord === undefined || kindOf(mesh) !== "mesh") {
      this.staleHandle("draw");
      return;
    }
    const materialRecord = this.materialStore.get(material);
    if (materialRecord === undefined || kindOf(material) !== "material") {
      this.staleHandle("draw");
      return;
    }
    let model = transform;
    if (!matrixIsFinite(transform)) {
      if (IS_DEV) {
        throw rendererError("E_CONTRACT", "draw transform is not finite", {
          label: meshRecord.label,
          recoverable: false,
        });
      }
      mat4Identity(this.identityScratch);
      model = this.identityScratch;
      this.stats.gpuErrors += 1;
    }
    const cx = meshRecord.desc.bounds.center.x;
    const cy = meshRecord.desc.bounds.center.y;
    const cz = meshRecord.desc.bounds.center.z;
    if (
      this.frustumActive &&
      this.culler.isValid &&
      !this.culler.transformedSphereVisible(
        model,
        cx,
        cy,
        cz,
        meshRecord.desc.bounds.radius,
      )
    ) {
      this.stats.culledInstances += 1;
      return;
    }
    if (!this.ensureMeshLive(meshRecord)) {
      this.staleHandle("draw");
      return;
    }
    if (!this.ensureMaterialLive(materialRecord)) {
      this.staleHandle("draw");
      return;
    }
    const pipeline = this.getLitPipeline(false, materialRecord.unlit);
    if (pipeline === null) {
      this.stats.droppedDraws += 1;
      return;
    }
    const objectOffset = this.objectRing.allocate();
    if (objectOffset < 0) {
      this.stats.droppedDraws += 1;
      if (IS_DEV) {
        throw rendererError(
          "E_CONTRACT",
          `object uniform ring exhausted (${MAX_OBJECTS_PER_FRAME} objects max)`,
          { label: meshRecord.label, recoverable: false },
        );
      }
      return;
    }
    const group = this.materialGroup(materialRecord);
    if (group === null) {
      this.stats.droppedDraws += 1;
      return;
    }
    this.writeObjectUniform(model, materialRecord, objectOffset);
    this.encodeDraw(
      pipeline,
      meshRecord,
      group,
      objectOffset,
      1,
      null,
      0,
    );
  }

  private drawMeshInstanced(
    mesh: MeshHandle,
    material: MaterialHandle,
    transforms: Float32Array,
    count: number,
  ): void {
    if (!this.canDraw()) {
      return;
    }
    this.ensureCamera();
    const meshRecord = this.meshStore.get(mesh);
    if (meshRecord === undefined || kindOf(mesh) !== "mesh") {
      this.staleHandle("drawInstanced");
      return;
    }
    if (meshRecord.layout !== "instanced-transform-v1") {
      if (IS_DEV) {
        throw rendererError(
          "E_UNSUPPORTED_FEATURE",
          "drawInstanced requires an instanced-transform-v1 mesh",
          { label: meshRecord.label, recoverable: false },
        );
      }
      this.stats.droppedDraws += 1;
      return;
    }
    const materialRecord = this.materialStore.get(material);
    if (materialRecord === undefined || kindOf(material) !== "material") {
      this.staleHandle("drawInstanced");
      return;
    }
    if (!Number.isInteger(count) || count <= 0) {
      if (IS_DEV) {
        throw rendererError("E_CONTRACT", "instance count must be positive", {
          label: meshRecord.label,
          recoverable: false,
        });
      }
      this.stats.droppedDraws += 1;
      return;
    }
    let requested = count;
    const available = Math.floor(transforms.length / 16);
    if (available < requested) {
      if (IS_DEV) {
        throw rendererError(
          "E_CONTRACT",
          "instance transform buffer is shorter than count",
          { label: meshRecord.label, recoverable: false },
        );
      }
      requested = available;
      this.stats.droppedDraws += 1;
    }
    if (requested > 65_536) {
      if (IS_DEV) {
        throw rendererError(
          "E_UNSUPPORTED_FEATURE",
          "a single instanced draw is limited to 65,536 instances",
          { label: meshRecord.label, recoverable: false },
        );
      }
      requested = 65_536;
      this.stats.droppedDraws += 1;
    }
    if (requested <= 0) {
      return;
    }
    let finite = true;
    for (let index = 0; index < requested * 16; index += 1) {
      if (!Number.isFinite(transforms[index])) {
        finite = false;
        break;
      }
    }
    if (!finite) {
      if (IS_DEV) {
        throw rendererError("E_CONTRACT", "instance transform is not finite", {
          label: meshRecord.label,
          recoverable: false,
        });
      }
      this.stats.gpuErrors += 1;
    }
    const localX = meshRecord.desc.bounds.center.x;
    const localY = meshRecord.desc.bounds.center.y;
    const localZ = meshRecord.desc.bounds.center.z;
    const localRadius = meshRecord.desc.bounds.radius;
    if (this.frustumActive && this.culler.isValid && finite) {
      const radius = unionSphereForInstances(
        this.groupCenter,
        transforms,
        requested,
        localX,
        localY,
        localZ,
        localRadius,
      );
      if (
        !this.culler.sphereVisible(
          this.groupCenter.x,
          this.groupCenter.y,
          this.groupCenter.z,
          radius,
        )
      ) {
        this.stats.culledInstances += requested;
        return;
      }
    }
    if (!this.ensureMeshLive(meshRecord)) {
      this.staleHandle("drawInstanced");
      return;
    }
    if (!this.ensureMaterialLive(materialRecord)) {
      this.staleHandle("drawInstanced");
      return;
    }
    const pipeline = this.getLitPipeline(true, materialRecord.unlit);
    if (pipeline === null) {
      this.stats.droppedDraws += 1;
      return;
    }
    const group = this.materialGroup(materialRecord);
    if (group === null) {
      this.stats.droppedDraws += 1;
      return;
    }
    mat4Identity(this.identityScratch);
    const model = this.identityScratch;
    let remaining = requested;
    let sourceInstance = 0;
    while (remaining > 0) {
      this.instanceOffsetRef.value = 0;
      const accepted = this.instanceRing.allocate(
        remaining,
        this.instanceOffsetRef,
      );
      if (accepted <= 0) {
        this.stats.droppedDraws += 1;
        break;
      }
      const floatDestination = this.instanceOffsetRef.value / 4;
      for (let instance = 0; instance < accepted; instance += 1) {
        const sourceBase = (sourceInstance + instance) * 16;
        const destinationBase = floatDestination + instance * 16;
        let instanceFinite = true;
        if (!finite) {
          for (let component = 0; component < 16; component += 1) {
            if (!Number.isFinite(transforms[sourceBase + component])) {
              instanceFinite = false;
              break;
            }
          }
        }
        for (let component = 0; component < 16; component += 1) {
          this.instanceRingCpu[destinationBase + component] = instanceFinite
            ? transforms[sourceBase + component] ?? 0
            : this.identityScratch.m[component] ?? 0;
        }
      }
      const byteOffset = this.instanceOffsetRef.value;
      const byteLength = accepted * INSTANCE_STRIDE_BYTES;
      const instanceBuffer = this.instanceBuffer;
      if (instanceBuffer === null) {
        this.stats.droppedDraws += 1;
        break;
      }
      this.queueUpload(
        instanceBuffer,
        byteOffset,
        this.instanceRingBytes,
        byteOffset,
        byteLength,
      );
      const objectOffset = this.objectRing.allocate();
      if (objectOffset < 0) {
        this.stats.droppedDraws += 1;
        if (IS_DEV) {
          throw rendererError(
            "E_CONTRACT",
            `object uniform ring exhausted (${MAX_OBJECTS_PER_FRAME} objects max)`,
            { label: meshRecord.label, recoverable: false },
          );
        }
        break;
      }
      this.writeObjectUniform(model, materialRecord, objectOffset);
      this.encodeDraw(
        pipeline,
        meshRecord,
        group,
        objectOffset,
        accepted,
        instanceBuffer,
        byteOffset,
      );
      sourceInstance += accepted;
      remaining -= accepted;
    }
    if (sourceInstance < requested) {
      this.stats.droppedDraws += 1;
    }
  }

  private writeObjectUniform(
    model: Mat4,
    material: MaterialRecord,
    offset: number,
  ): void {
    // Normal matrix = transpose(inverse(model)). Without this the uploaded
    // normal columns stay zero and the lit shader sees no direction.
    writeNormalMatrix(this.normalScratch, model);
    writeObjectUniforms(
      this.objectFloats,
      model,
      this.normalScratch,
      material.tintR,
      material.tintG,
      material.tintB,
      material.tintA,
    );
    const destination = offset / 4;
    this.objectRingCpu.set(this.objectFloats, destination);
    const buffer = this.objectBuffer;
    if (buffer === null) {
      return;
    }
    this.queueUpload(
      buffer,
      offset,
      this.objectRingBytes,
      offset,
      OBJECT_UNIFORM_BYTES,
    );
  }

  private encodeDraw(
    pipeline: GPURenderPipeline,
    mesh: MeshRecord,
    materialGroup: GPUBindGroup,
    objectOffset: number,
    instanceCount: number,
    instanceBuffer: GPUBuffer | null,
    instanceOffset: number,
  ): void {
    const pass = this.currentPass;
    if (pass === null) {
      this.stats.droppedDraws += 1;
      return;
    }
    this.flushFrameUniforms();
    if (!this.passBindingsReady) {
      const frameGroup = this.frameBindGroups[this.frameIndex % 3];
      const lightGroup = this.lightBindGroups[this.frameIndex % 3];
      if (!frameGroup || !lightGroup) {
        this.stats.droppedDraws += 1;
        return;
      }
      pass.setBindGroup(0, frameGroup);
      pass.setBindGroup(1, lightGroup);
      this.stats.bindGroupSwitches += 2;
      this.passBindingsReady = true;
    }
    if (this.lastPipeline !== pipeline) {
      pass.setPipeline(pipeline);
      this.lastPipeline = pipeline;
      this.stats.pipelineSwitches += 1;
    }
    if (this.lastMaterialGroup !== materialGroup) {
      pass.setBindGroup(2, materialGroup);
      this.lastMaterialGroup = materialGroup;
      this.stats.bindGroupSwitches += 1;
    }
    const vertexBuffer = mesh.vertexBuffer;
    if (vertexBuffer === null) {
      this.stats.droppedDraws += 1;
      return;
    }
    pass.setVertexBuffer(0, vertexBuffer);
    // Static draws pass a null instance buffer; every instanced draw must bind
    // slot 1, including a single-instance draw, because the pipeline reads the
    // instance transform attributes.
    if (instanceBuffer !== null) {
      pass.setVertexBuffer(
        1,
        instanceBuffer,
        instanceOffset,
        instanceCount * INSTANCE_STRIDE_BYTES,
      );
    }
    if (mesh.indexBuffer !== null) {
      pass.setIndexBuffer(mesh.indexBuffer, mesh.indexFormat);
    }
    const group = this.objectBindGroup;
    if (group === null) {
      this.stats.droppedDraws += 1;
      return;
    }
    this.dynamicOffset[0] = objectOffset;
    pass.setBindGroup(3, group, this.dynamicOffset);
    this.stats.bindGroupSwitches += 1;
    if (mesh.indexCount > 0) {
      pass.drawIndexed(
        mesh.indexCount,
        instanceCount,
        0,
        0,
        0,
      );
    } else {
      pass.draw(mesh.vertexCount, instanceCount, 0, 0);
    }
    this.stats.drawCalls += 1;
    this.stats.instances += instanceCount;
    const triangleCount =
      mesh.indexCount > 0 ? mesh.indexCount / 3 : mesh.vertexCount / 3;
    this.stats.triangles += triangleCount * instanceCount;
  }

  private flushFrameUniforms(): void {
    if (!this.frameUniformDirty) {
      return;
    }
    const buffer = this.frameBuffers[this.frameIndex % 3];
    if (buffer === undefined) {
      return;
    }
    this.frameInput.cameraX = this.cameraX;
    this.frameInput.cameraY = this.cameraY;
    this.frameInput.cameraZ = this.cameraZ;
    this.frameInput.timeSeconds = this.timeSeconds;
    this.frameInput.deltaSeconds = this.deltaSeconds;
    this.frameInput.frameIndex = this.frameIndex;
    writeFrameUniforms(this.frameFloats, this.frameInput);
    this.queueUpload(
      buffer,
      0,
      this.frameBytes,
      0,
      FRAME_UNIFORM_BYTES,
    );
    this.frameUniformDirty = false;
  }

  private queueUpload(
    target: GPUBuffer,
    targetOffset: number,
    source: Uint8Array,
    sourceOffset: number,
    size: number,
  ): void {
    this.gpuDevice.queue.writeBuffer(
      target,
      targetOffset,
      source,
      sourceOffset,
      size,
    );
    this.stats.uploadBytes += size;
    this.stats.uploadCalls += 1;
  }

  private materialGroup(record: MaterialRecord): GPUBindGroup | null {
    if (!this.ensureMaterialLive(record)) {
      return null;
    }
    const group = record.bindGroup;
    return group;
  }

  private ensureMaterialLive(record: MaterialRecord): boolean {
    if (record.bindGroup !== null) {
      return true;
    }
    if (!record.pending) {
      return false;
    }
    try {
      this.buildMaterialGpu(record);
      record.pending = false;
      return true;
    } catch (error) {
      record.pending = true;
      this.stats.gpuErrors += 1;
      if (IS_DEV) {
        throw error;
      }
      return false;
    }
  }

  private buildMaterialGpu(record: MaterialRecord): void {
    const layout = this.materialBindGroupLayout;
    if (layout === null) {
      throw rendererError("E_BACKEND_INIT", "material layout missing", {
        label: record.label,
        recoverable: false,
      });
    }
    let view = this.whiteView;
    let sampler = this.defaultSampler;
    const baseHandle = record.baseTexture;
    if (baseHandle !== null) {
      const textureRecord = this.textureStore.get(baseHandle);
      if (
        textureRecord !== undefined &&
        textureRecord.sampled &&
        textureRecord.layers === 1
      ) {
        if (this.ensureTextureLive(textureRecord)) {
          view = textureRecord.view;
          sampler = textureRecord.sampler ?? this.defaultSampler;
        }
      }
      if (view === this.whiteView) {
        if (record.pending && IS_DEV) {
          throw rendererError(
            "E_STALE_HANDLE",
            "baseColorTexture cannot be restored",
            { label: record.label, recoverable: false },
          );
        }
        this.stats.gpuErrors += 1;
      }
    }
    if (view === null || sampler === null) {
      throw rendererError("E_BACKEND_INIT", "fallback material resources missing", {
        label: record.label,
        recoverable: false,
      });
    }
    record.bindGroup = this.gpuDevice.createBindGroup({
      label: record.label,
      layout,
      entries: [
        { binding: 0, resource: view },
        { binding: 1, resource: sampler },
      ],
    });
  }

  private needDepthStencil(
    record: NormalizedPipelineDesc,
  ): GPUDepthStencilState | undefined {
    if (record.depthState.format === "none") {
      return undefined;
    }
    const compare = record.depthState.compare;
    if (compare === null) {
      throw rendererError("E_CONTRACT", "depth compare is required", {
        label: record.label,
        recoverable: false,
      });
    }
    return {
      format: "depth24plus",
      depthWriteEnabled: record.depthState.writeEnabled,
      depthCompare: compare,
    };
  }

  private buildPublicPipeline(
    desc: NormalizedPipelineDesc,
    vertexEntryPoint: string,
    fragmentEntryPoint: string,
    vertexModule: GPUShaderModule,
    fragmentModule: GPUShaderModule,
  ): GPURenderPipeline {
    const layout =
      desc.layoutId === "builtin-2d-v1"
        ? this.twoDPipelineLayout
        : this.pbrPipelineLayout;
    if (layout === null) {
      throw rendererError("E_BACKEND_INIT", "pipeline layout missing", {
        label: desc.label,
        recoverable: false,
      });
    }
    const depth = this.needDepthStencil(desc);
    const descriptor: GPURenderPipelineDescriptor = {
      label: desc.label,
      layout,
      vertex: {
        module: vertexModule,
        entryPoint: vertexEntryPoint,
        buffers: gpuBufferLayout(desc.vertexLayout),
      },
      fragment: {
        module: fragmentModule,
        entryPoint: fragmentEntryPoint,
        targets: [{ format: this.canvasFormatValue }],
      },
      primitive: {
        topology: "triangle-list",
        cullMode: desc.primitiveState.cullMode,
        frontFace: "ccw",
      },
      multisample: { count: 1, mask: 0xffffffff },
      ...(depth === undefined ? {} : { depthStencil: depth }),
    };
    try {
      const pipeline = this.gpuDevice.createRenderPipeline(descriptor);
      this.stats.pipelinesCreated += 1;
      return pipeline;
    } catch (error) {
      const message = errorText(error).slice(0, 240);
      this.stats.gpuErrors += 1;
      throw rendererError("E_PIPELINE_COMPILE", message, {
        label: desc.label,
        recoverable: false,
        cause: error,
      });
    }
  }

  private pipelineKeyFor(
    desc: NormalizedPipelineDesc,
    vertexRecord: ShaderRecord,
    fragmentRecord: ShaderRecord,
  ): PipelineCacheKey {
    return canonicalPipelineKey({
      vertexShaderKey: vertexRecord.key,
      fragmentShaderKey: fragmentRecord.key,
      vertexLayout: desc.vertexLayout,
      primitiveState: desc.primitiveState,
      depthState: desc.depthState,
      multisample: desc.multisample,
      colorFormats: desc.colorFormats,
      blendStates: desc.blendStates,
      layoutId: desc.layoutId,
      definesCanonical: desc.definesCanonical,
    });
  }

  private shaderRecord(
    handle: ShaderModuleHandle,
    stage: "vertex" | "fragment",
  ): ShaderRecord {
    const record = this.shaderStore.get(handle);
    if (record === undefined || kindOf(handle) !== "shader") {
      throw rendererError("E_STALE_HANDLE", `${stage} shader is stale`, {
        label: "shader",
        recoverable: false,
      });
    }
    if (record.desc.stage !== stage) {
      throw rendererError(
        "E_CONTRACT",
        `${stage}Shader has stage ${record.desc.stage}`,
        { label: record.desc.label, recoverable: false },
      );
    }
    return record;
  }

  private ensureShaderLive(record: ShaderRecord): boolean {
    if (record.module !== null) {
      return true;
    }
    try {
      record.module = this.gpuDevice.createShaderModule({
        label: record.desc.label,
        code: applyDefines(record.desc.code, record.desc.defines),
      });
      record.pending = false;
      this.shaderCache.set(record.key, record.module);
      this.stats.shaderModulesCreated += 1;
      return true;
    } catch {
      record.pending = true;
      this.stats.gpuErrors += 1;
      return false;
    }
  }

  private ensurePipelineLive(
    handle: PipelineHandle,
    record: PipelineRecord,
  ): boolean {
    if (record.pipeline !== null) {
      return true;
    }
    const vertexRecord = this.shaderStore.get(record.desc.vertexShader);
    const fragmentRecord = this.shaderStore.get(record.desc.fragmentShader);
    if (
      vertexRecord === undefined ||
      fragmentRecord === undefined ||
      !this.ensureShaderLive(vertexRecord) ||
      !this.ensureShaderLive(fragmentRecord)
    ) {
      record.pending = true;
      this.stats.gpuErrors += 1;
      return false;
    }
    const vertexModule = vertexRecord.module;
    const fragmentModule = fragmentRecord.module;
    if (vertexModule === null || fragmentModule === null) {
      record.pending = true;
      return false;
    }
    try {
      const pipeline = this.buildPublicPipeline(
        record.desc,
        vertexRecord.desc.entryPoint,
        fragmentRecord.desc.entryPoint,
        vertexModule,
        fragmentModule,
      );
      record.pipeline = pipeline;
      record.pending = false;
      this.pipelineCache.set(record.key, pipeline);
      const mapped = this.pipelineHandleByKey.get(record.key.canonical);
      if (mapped === undefined) {
        this.pipelineHandleByKey.set(record.key.canonical, handle);
      }
      return true;
    } catch (error) {
      record.pending = true;
      record.pipeline = null;
      this.pipelineCache.setFailure(
        record.key,
        error instanceof WebGpuRendererError
          ? error.message
          : "pipeline rebuild failed",
      );
      return false;
    }
  }

  private getLitPipeline(
    instanced: boolean,
    unlit: boolean,
  ): GPURenderPipeline | null {
    const variant = (instanced ? 2 : 0) + (unlit ? 1 : 0);
    const existing = this.litPipelines[variant] ?? null;
    if (existing !== null) {
      return existing;
    }
    if (this.litFailed[variant] === true) {
      return null;
    }
    const key = this.litKeys[variant] ?? null;
    if (key === null) {
      return null;
    }
    const cached = this.builtinPipelineCache.get(key);
    if (cached !== undefined) {
      if (cached.failure !== null) {
        this.litFailed[variant] = true;
        return null;
      }
      this.stats.pipelineCacheHits += 1;
      this.litPipelines[variant] = cached.value;
      return cached.value;
    }
    const family = unlit ? "builtin-unlit" : "builtin-lit";
    try {
      if (this.litModule === null) {
        this.litModule = this.gpuDevice.createShaderModule({
          label: "builtin-lit",
          code: LIT_WGSL,
        });
        this.stats.shaderModulesCreated += 1;
      }
      const layout = this.pbrPipelineLayout;
      if (layout === null) {
        throw rendererError("E_BACKEND_INIT", "PBR pipeline layout missing", {
          label: family,
          recoverable: false,
        });
      }
      const descriptor: GPURenderPipelineDescriptor = {
        label: instanced ? `${family}-instanced` : family,
        layout,
        vertex: {
          module: this.litModule,
          entryPoint: instanced
            ? LIT_INSTANCED_VERTEX_ENTRY
            : LIT_VERTEX_ENTRY,
          buffers: gpuBufferLayout(
            instanced ? "instanced-transform-v1" : "static-pbr-v1",
          ),
        },
        fragment: {
          module: this.litModule,
          entryPoint: unlit ? LIT_UNLIT_FRAGMENT_ENTRY : LIT_FRAGMENT_ENTRY,
          targets: [{ format: this.canvasFormatValue }],
        },
        primitive: {
          topology: "triangle-list",
          cullMode: "back",
          frontFace: "ccw",
        },
        multisample: { count: 1, mask: 0xffffffff },
        depthStencil: {
          format: "depth24plus",
          depthWriteEnabled: true,
          depthCompare: "less",
        },
      };
      const pipeline = this.gpuDevice.createRenderPipeline(descriptor);
      this.builtinPipelineCache.set(key, pipeline);
      this.stats.pipelinesCreated += 1;
      this.litPipelines[variant] = pipeline;
      return pipeline;
    } catch (error) {
      const message = errorText(error).slice(0, 240);
      this.builtinPipelineCache.setFailure(key, message);
      this.litFailed[variant] = true;
      this.stats.gpuErrors += 1;
      if (IS_DEV) {
        throw rendererError("E_PIPELINE_COMPILE", message, {
          label: family,
          recoverable: false,
          cause: error,
        });
      }
      return null;
    }
  }

  private ensureTextureLive(record: TextureRecord): boolean {
    if (record.texture !== null) {
      return true;
    }
    if (!record.restorable || !record.pending) {
      return false;
    }
    try {
      this.buildTextureGpu(record);
      record.pending = false;
      return true;
    } catch {
      record.pending = true;
      this.stats.gpuErrors += 1;
      return false;
    }
  }

  private buildTextureGpu(record: TextureRecord): void {
    if (this.stats.textureBytes + record.bytes > this.options.maxTextureBytes) {
      throw rendererError(
        "E_ASSET_BUDGET",
        `texture memory budget exceeded by ${record.label}`,
        { label: record.label, recoverable: false },
      );
    }
    const classification = classifyFormat(record.format);
    let texture: GPUTexture | null = null;
    try {
      texture = this.gpuDevice.createTexture({
        label: record.label,
        size: {
          width: record.width,
          height: record.height,
          depthOrArrayLayers: record.layers,
        },
        mipLevelCount: record.mips,
        sampleCount: 1,
        dimension: "2d",
        format: classification.webgpuFormat,
        usage: record.usageFlags,
      });
      const view = texture.createView({
        dimension: "2d",
        baseMipLevel: 0,
        mipLevelCount: record.mips,
        baseArrayLayer: 0,
        arrayLayerCount: record.layers,
        ...(record.depth ? { aspect: "depth-only" as const } : {}),
      });
      let sampler: GPUSampler | null = null;
      if (record.desc.sampler !== undefined) {
        sampler = this.gpuDevice.createSampler(
          this.gpuSamplerDescriptor(record.desc.sampler, record.label),
        );
      }
      if (record.desc.data !== undefined) {
        this.uploadTextureLevels(record, texture);
      }
      record.texture = texture;
      record.view = view;
      record.sampler = sampler;
      this.stats.textureBytes += record.bytes;
    } catch (error) {
      texture?.destroy();
      throw error;
    }
  }

  private uploadTextureLevels(record: TextureRecord, texture: GPUTexture): void {
    const levels = record.desc.data;
    if (levels === undefined) {
      return;
    }
    for (const level of levels) {
      const width = Math.max(1, record.width >> level.mipLevel);
      const height = Math.max(1, record.height >> level.mipLevel);
      const rows = height;
      const rowBytes = tightRowBytes(record.format, width);
      const sourceStride = rows > 1 ? level.bytesPerRow : rowBytes;
      const paddedStride = (rowBytes + 255) & ~255;
      const bytes = new Uint8Array(
        level.bytes.buffer,
        level.bytes.byteOffset,
        level.bytes.byteLength,
      );
      const padded = new Uint8Array(paddedStride * rows);
      for (let row = 0; row < rows; row += 1) {
        const sourceStart = row * sourceStride;
        const targetStart = row * paddedStride;
        for (let column = 0; column < rowBytes; column += 1) {
          padded[targetStart + column] = bytes[sourceStart + column] ?? 0;
        }
      }
      this.gpuDevice.queue.writeTexture(
        {
          texture,
          mipLevel: level.mipLevel,
          origin: { x: 0, y: 0, z: level.layer },
        },
        padded,
        { offset: 0, bytesPerRow: paddedStride, rowsPerImage: rows },
        { width, height, depthOrArrayLayers: 1 },
      );
      this.stats.uploadBytes += padded.byteLength;
      this.stats.uploadCalls += 1;
    }
  }

  private validateTextureLevels(
    levels: readonly {
      readonly mipLevel: number;
      readonly layer: number;
      readonly bytes: ArrayBufferView;
      readonly bytesPerRow: number;
    }[],
    format: TextureFormat,
    width: number,
    height: number,
    layers: number,
    mips: number,
    label: string,
  ): void {
    const seen = new Uint8Array(mips * layers);
    if (mips > 1 && levels.length !== mips * layers) {
      throw rendererError(
        "E_ASSET_FORMAT",
        "mipLevels > 1 requires every mip and layer",
        { label, recoverable: false },
      );
    }
    for (const level of levels) {
      const mipLevel = level.mipLevel;
      const layer = level.layer;
      if (
        !Number.isInteger(mipLevel) ||
        mipLevel < 0 ||
        mipLevel >= mips ||
        !Number.isInteger(layer) ||
        layer < 0 ||
        layer >= layers
      ) {
        throw rendererError("E_ASSET_FORMAT", "texture level index out of range", {
          label,
          recoverable: false,
        });
      }
      const slot = mipLevel * layers + layer;
      if (seen[slot] === 1) {
        throw rendererError("E_ASSET_FORMAT", "duplicate texture level", {
          label,
          recoverable: false,
        });
      }
      seen[slot] = 1;
      if (!ArrayBuffer.isView(level.bytes)) {
        throw rendererError("E_ASSET_FORMAT", "texture level bytes are invalid", {
          label,
          recoverable: false,
        });
      }
      const levelWidth = Math.max(1, width >> mipLevel);
      const levelHeight = Math.max(1, height >> mipLevel);
      const rowBytes = tightRowBytes(format, levelWidth);
      if (
        !Number.isInteger(level.bytesPerRow) ||
        level.bytesPerRow < 0
      ) {
        throw rendererError(
          "E_ASSET_FORMAT",
          "texture bytesPerRow must be a non-negative integer",
          { label, recoverable: false },
        );
      }
      if (levelHeight > 1 && level.bytesPerRow < rowBytes) {
        throw rendererError(
          "E_ASSET_FORMAT",
          "texture bytesPerRow is too small",
          { label, recoverable: false },
        );
      }
      const sourceStride = levelHeight > 1 ? level.bytesPerRow : rowBytes;
      const required =
        levelHeight > 1
          ? (levelHeight - 1) * sourceStride + rowBytes
          : rowBytes;
      if (level.bytes.byteLength < required) {
        throw rendererError(
          "E_ASSET_FORMAT",
          "texture level bytes are shorter than the declared rows",
          { label, recoverable: false },
        );
      }
    }
    for (let index = 0; index < mips * layers; index += 1) {
      if (seen[index] !== 1) {
        throw rendererError(
          "E_ASSET_FORMAT",
          "a required texture mip or layer is missing",
          { label, recoverable: false },
        );
      }
    }
  }

  private buildBufferGpu(record: BufferRecord): void {
    let buffer: GPUBuffer | null = null;
    try {
      buffer = this.gpuDevice.createBuffer({
        label: record.label,
        size: record.gpuBytes,
        usage: record.usageFlags,
      });
      if (record.cpu !== null && record.cpuDirty) {
        if ((record.usageFlags & BUFFER_USAGE.COPY_DST) === 0) {
          throw rendererError(
            "E_CONTRACT",
            "buffer CPU data requires copy-dst",
            { label: record.label, recoverable: false },
          );
        }
        this.queueUpload(
          buffer,
          0,
          record.cpu,
          0,
          record.cpu.byteLength,
        );
        record.cpuDirty = false;
      }
      record.buffer = buffer;
      this.stats.bufferBytes += record.gpuBytes;
    } catch (error) {
      buffer?.destroy();
      throw error;
    }
  }

  private ensureBufferLive(record: BufferRecord): boolean {
    if (record.buffer !== null) {
      return true;
    }
    if (!record.restorable || !record.pending) {
      return false;
    }
    try {
      this.buildBufferGpu(record);
      record.pending = false;
      return true;
    } catch {
      record.pending = true;
      this.stats.gpuErrors += 1;
      return false;
    }
  }

  private buildMeshGpu(record: MeshRecord): void {
    const vertexView = record.desc.vertices[0];
    if (vertexView === undefined) {
      throw rendererError("E_BACKEND_INIT", "mesh vertex data missing", {
        label: record.label,
        recoverable: false,
      });
    }
    let vertexBuffer: GPUBuffer | null = null;
    let indexBuffer: GPUBuffer | null = null;
    try {
      vertexBuffer = this.gpuDevice.createBuffer({
        label: `${record.label}-vertices`,
        size: align4(record.vertexBytes),
        usage: BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
      });
      const vertexBytes = new Uint8Array(
        vertexView.buffer,
        vertexView.byteOffset,
        vertexView.byteLength,
      );
      this.queueUpload(
        vertexBuffer,
        0,
        vertexBytes,
        0,
        vertexBytes.byteLength,
      );
      this.stats.bufferBytes += align4(record.vertexBytes);
      if (record.indexCount > 0) {
        const indices = record.desc.indices;
        if (indices === undefined) {
          throw rendererError("E_BACKEND_INIT", "mesh index data missing", {
            label: record.label,
            recoverable: false,
          });
        }
        const indexBytes = new Uint8Array(
          indices.data.buffer,
          indices.data.byteOffset,
          indices.data.byteLength,
        );
        indexBuffer = this.gpuDevice.createBuffer({
          label: `${record.label}-indices`,
          size: align4(indexBytes.byteLength),
          usage: BUFFER_USAGE.INDEX | BUFFER_USAGE.COPY_DST,
        });
        this.queueUpload(
          indexBuffer,
          0,
          indexBytes,
          0,
          indexBytes.byteLength,
        );
        this.stats.bufferBytes += align4(indexBytes.byteLength);
      }
      record.vertexBuffer = vertexBuffer;
      record.indexBuffer = indexBuffer;
    } catch (error) {
      vertexBuffer?.destroy();
      indexBuffer?.destroy();
      this.stats.bufferBytes = Math.max(
        0,
        this.stats.bufferBytes - align4(record.vertexBytes) - align4(record.indexBytes),
      );
      throw error;
    }
  }

  private ensureMeshLive(record: MeshRecord): boolean {
    if (record.vertexBuffer !== null) {
      return true;
    }
    if (!record.restorable || !record.pending) {
      return false;
    }
    try {
      this.buildMeshGpu(record);
      record.pending = false;
      return true;
    } catch {
      record.pending = true;
      this.stats.gpuErrors += 1;
      return false;
    }
  }

  private ensureSamplerLive(record: SamplerRecord, label: string): void {
    if (record.sampler !== null) {
      return;
    }
    try {
      record.sampler = this.gpuDevice.createSampler(
        this.gpuSamplerDescriptor(record.desc, label),
      );
      record.pending = false;
      this.samplerCache.set(record.key, record.sampler);
    } catch (error) {
      record.pending = true;
      this.stats.gpuErrors += 1;
      throw rendererError("E_BACKEND_INIT", "sampler rebuild failed", {
        label,
        recoverable: false,
        cause: error,
      });
    }
  }

  private gpuSamplerDescriptor(
    desc: SamplerDesc,
    label: string,
  ): GPUSamplerDescriptor {
    const raw = desc as unknown as Readonly<Record<string, unknown>>;
    if (raw["compare"] !== undefined) {
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        "comparison samplers are M1 (shadows)",
        { label, recoverable: false },
      );
    }
    const magFilter = raw["magFilter"];
    const minFilter = raw["minFilter"];
    const mipmapFilter = raw["mipmapFilter"];
    if (
      typeof magFilter !== "string" ||
      !Object.prototype.hasOwnProperty.call(FILTER_MODES, magFilter) ||
      typeof minFilter !== "string" ||
      !Object.prototype.hasOwnProperty.call(FILTER_MODES, minFilter) ||
      typeof mipmapFilter !== "string" ||
      !Object.prototype.hasOwnProperty.call(FILTER_MODES, mipmapFilter)
    ) {
      throw rendererError("E_CONTRACT", "invalid sampler filter", {
        label,
        recoverable: false,
      });
    }
    const addressU = raw["addressU"];
    const addressV = raw["addressV"];
    const addressW = raw["addressW"] ?? "clamp-to-edge";
    for (const address of [addressU, addressV, addressW]) {
      if (
        typeof address !== "string" ||
        !Object.prototype.hasOwnProperty.call(ADDRESS_MODES, address)
      ) {
        throw rendererError("E_CONTRACT", "invalid sampler address mode", {
          label,
          recoverable: false,
        });
      }
    }
    const maxAnisotropyValue = raw["maxAnisotropy"] ?? 1;
    if (
      typeof maxAnisotropyValue !== "number" ||
      !Number.isInteger(maxAnisotropyValue) ||
      maxAnisotropyValue < 1 ||
      maxAnisotropyValue > 16
    ) {
      throw rendererError(
        "E_CONTRACT",
        "maxAnisotropy must be an integer in 1..16",
        { label, recoverable: false },
      );
    }
    return {
      label,
      magFilter: magFilter as GPUFilterMode,
      minFilter: minFilter as GPUFilterMode,
      mipmapFilter: mipmapFilter as GPUFilterMode,
      addressModeU: addressU as GPUAddressMode,
      addressModeV: addressV as GPUAddressMode,
      addressModeW: addressW as GPUAddressMode,
      maxAnisotropy: Math.min(
        maxAnisotropyValue,
        this.limitsValue.maxSamplerAnisotropy,
      ),
    };
  }

  private readPositiveInteger(
    value: unknown,
    name: string,
    label: string,
  ): number {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value <= 0
    ) {
      throw rendererError("E_CONTRACT", `${name} must be a positive integer`, {
        label,
        recoverable: false,
      });
    }
    return value;
  }

  private assertFormat(format: TextureFormat, label: string): void {
    if (!isTextureFormat(format)) {
      throw rendererError("E_CONTRACT", "invalid texture format", {
        label,
        recoverable: false,
      });
    }
    if (!supportsFormat(format, this.adapterFeatureProbe)) {
      const classification = classifyFormat(format);
      throw rendererError(
        "E_UNSUPPORTED_FEATURE",
        `${format} requires ${classification.webgpuFeature ?? "an adapter feature"}`,
        { label, recoverable: false },
      );
    }
  }

  private staleHandle(label: string): void {
    if (IS_DEV) {
      throw rendererError("E_STALE_HANDLE", `${label} handle is stale`, {
        label,
        recoverable: false,
      });
    }
    this.stats.gpuErrors += 1;
  }
}


/**
 * Render-device contract (specs 00 §3.2 and 04 §3–4). Types and signatures
 * only; both renderer backends implement it.
 *
 * `Surface`, `RendererSize` and `DeviceLimits` are declared in
 * `./engine.js` (00-owned) and imported here so the package has one
 * declaration of each. Importing from the package entry exposes them.
 */

import type { DeviceLimits, RendererSize, Surface } from "./engine.js";
import type { Mat4, Vec3 } from "./math.js";

export type RendererBackend = "webgpu" | "webgl2" | "canvas2d";

export type EngineFeature =
  | "compute"
  | "storage-buffers"
  | "timestamp-query"
  | "float-render-target"
  | "texture-array"
  | "msaa4"
  | "compressed-astc"
  | "compressed-etc2"
  | "compressed-s3tc";

export type RendererQualityTier = "off" | "low" | "medium" | "high";

export interface RendererCapabilities {
  readonly backend: RendererBackend;
  readonly features: ReadonlySet<EngineFeature>;
  /** The texture tokens this adapter accepts; unsupported tokens fail, never downcast. */
  readonly supportedFormats: ReadonlySet<TextureFormat>;
  readonly quality: RendererQualityTier;
  readonly maxTextureSize: number;
  readonly maxTextureLayers: number;
  readonly maxBindGroups: number;
  readonly maxUniformBufferBytes: number;
  readonly maxSamples: 1 | 4;
  readonly anisotropy: number;
  /** Maximum lights the built-in PBR pipeline consumes. */
  readonly directionalLights: number;
  readonly pointLights: number;
  /** 0 disables shadows; 2 or 3 are the only shadow tiers. */
  readonly shadowCascades: 0 | 2 | 3;
  readonly supportsPost: boolean;
  readonly supportsTimestamps: boolean;
}

export interface RenderDeviceOptions {
  /** Default "high" desktop, "medium" TV. */
  readonly quality?: RendererQualityTier;
  /** 0 = no cap; the TV profile passes 1080. */
  readonly maxRenderHeight?: number;
  /** Default 128 MiB (provisional). */
  readonly maxTextureBytes?: number;
  /** Default 3 desktop / 0 TV at M0. */
  readonly shadowCascades?: 0 | 2 | 3;
  /** Default false at M0. */
  readonly post?: boolean;
  /** 1..16, clamped by limits. */
  readonly anisotropy?: number;
  /** Default true. */
  readonly retainCpuCopies?: boolean;
}

/**
 * Result of a backend factory. `device` is the initialized backend; the
 * runtime selects the backend from `backend`/`capabilities` before init.
 * Backends narrow `T` and `capabilities` in their own init-result types.
 */
export interface DeviceInitResult<T extends RenderDevice = RenderDevice> {
  readonly backend: RendererBackend;
  readonly capabilities: RendererCapabilities;
  /** Display-only, sanitized; never contains URLs or tokens. */
  readonly adapterInfo: string;
  readonly device: T;
}

export interface RenderDevice {
  readonly backend: RendererBackend;
  readonly features: ReadonlySet<EngineFeature>;
  readonly limits: DeviceLimits;
  readonly capabilities: RendererCapabilities;
  /** The optional options argument is the additive 04 form of 00's call. */
  init(surface: Surface, options?: RenderDeviceOptions): Promise<void>;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  beginFrame(): RenderFrame;
  endFrame(): void;

  createShaderModule(desc: ShaderModuleDesc): ShaderModuleHandle;
  createPipeline(desc: PipelineDesc): PipelineHandle;
  createTexture(desc: TextureDesc): TextureHandle;
  createSampler(desc: SamplerDesc): SamplerHandle;
  createBuffer(desc: BufferDesc): BufferHandle;
  writeBuffer(handle: BufferHandle, offset: number, data: ArrayBufferView): void;
  createMesh(desc: MeshDesc): MeshHandle;
  createLodGroup(desc: LodGroupDesc): LodGroupHandle;
  createMaterial(desc: MaterialDesc): MaterialHandle;
  createRenderTarget(desc: RenderTargetDesc): RenderTargetHandle;

  destroy(handle: GpuHandle): void;
  /** One re-create attempt after device loss; the runtime owns retries. */
  restore(): Promise<RestoreResult>;
  onDeviceLost(listener: DeviceLostListener): () => void;
  onRestored(listener: RestoredListener): () => void;

  /** Debug/benchmark only; rejects with `E_UNSUPPORTED_FEATURE` otherwise. */
  readTexture(handle: TextureHandle, opts: ReadbackOptions): Promise<Uint8Array>;
  captureFrame(): Promise<FrameCapture>;

  /** Stable object, mutated once per frame; copy fields, never retain arrays. */
  readonly stats: RenderStats;
  /** CSS pixels, zero before the first resize. */
  readonly size: RendererSize;
  /** Idempotent. */
  dispose(): void;
}

export interface RenderFrame {
  /** False while the device is lost or the surface has zero size. */
  readonly valid: boolean;
  setCamera(viewProjection: Mat4): void;
  setCameraMatrices(view: Mat4, projection: Mat4): void;
  draw(mesh: MeshHandle, material: MaterialHandle, transform: Mat4): void;
  /** 16 floats per instance, column-major; read, never retained. */
  drawInstanced(
    mesh: MeshHandle,
    material: MaterialHandle,
    transforms: Float32Array,
    count: number,
  ): void;
  drawLod(group: LodGroupHandle, material: MaterialHandle, transform: Mat4): void;
  /** M1; the default swapchain pass is implicit. */
  beginPass(desc: RenderPassDesc): RenderPassEncoder;
  /** M1; fullscreen post pass source. */
  drawFullscreen(source: TextureHandle, material: MaterialHandle): void;
}

export interface RenderPassEncoder {
  setCamera(viewProjection: Mat4): void;
  draw(mesh: MeshHandle, material: MaterialHandle, transform: Mat4): void;
  drawInstanced(
    mesh: MeshHandle,
    material: MaterialHandle,
    transforms: Float32Array,
    count: number,
  ): void;
  drawLod(group: LodGroupHandle, material: MaterialHandle, transform: Mat4): void;
  drawFullscreen(source: TextureHandle, material: MaterialHandle): void;
  end(): void;
}

export interface GpuHandle {
  readonly index: number;
  readonly generation: number;
}

export type ShaderModuleHandle = GpuHandle & { readonly __kind: "shader" };
export type PipelineHandle = GpuHandle & { readonly __kind: "pipeline" };
export type TextureHandle = GpuHandle & { readonly __kind: "texture" };
export type SamplerHandle = GpuHandle & { readonly __kind: "sampler" };
export type BufferHandle = GpuHandle & { readonly __kind: "buffer" };
export type MeshHandle = GpuHandle & { readonly __kind: "mesh" };
export type LodGroupHandle = GpuHandle & { readonly __kind: "lodGroup" };
export type MaterialHandle = GpuHandle & { readonly __kind: "material" };
export type RenderTargetHandle = GpuHandle & { readonly __kind: "renderTarget" };

export interface RenderStats {
  readonly drawCalls: number;
  readonly shadowDrawCalls: number;
  readonly triangles: number;
  readonly instances: number;
  readonly culledInstances: number;
  readonly pipelineSwitches: number;
  readonly bindGroupSwitches: number;
  readonly pipelinesCreated: number;
  readonly pipelineCacheHits: number;
  readonly shaderModulesCreated: number;
  readonly textureBytes: number;
  readonly bufferBytes: number;
  readonly uploadBytes: number;
  readonly uploadCalls: number;
  readonly gpuErrors: number;
  readonly droppedDraws: number;
  readonly lodCounts: readonly [number, number, number, number];
  /** null without timestamp-query. */
  readonly gpuFrameMs: number | null;
  readonly cpuFrameMs: number;
}

export interface ShaderModuleDesc {
  /** 1..64 chars, stable; used in errors. */
  readonly label: string;
  readonly stage: "vertex" | "fragment" | "compute";
  readonly language: "wgsl";
  /** UTF-8, at most 64 KiB. */
  readonly code: string;
  readonly entryPoint: string;
  readonly abiVersion: 1;
  readonly defines?: Readonly<Record<string, number | boolean>>;
}

export interface BoundingSphere {
  readonly center: Vec3;
  readonly radius: number;
}

export interface MeshDesc {
  readonly label: string;
  readonly layout: "static-pbr-v1" | "instanced-transform-v1";
  /** One buffer in ABI 1. */
  readonly vertices: readonly ArrayBufferView[];
  readonly indices?: {
    readonly data: Uint16Array | Uint32Array;
    readonly format: "uint16" | "uint32";
  };
  /** Model space. */
  readonly bounds: BoundingSphere;
  /** Only value in ABI 1. */
  readonly topology?: "triangle-list";
}

/**
 * Single canonical texture vocabulary for both backends. A backend reports
 * the subset it supports; an unsupported token is `E_UNSUPPORTED_FEATURE`,
 * never a silent downcast.
 */
export type TextureFormat =
  | "rgba8unorm"
  | "rgba8unorm-srgb"
  | "bgra8unorm"
  | "rgba16float"
  | "rgba32float"
  | "r8unorm"
  | "rgb10a2unorm"
  | "depth24plus"
  | "depth32float"
  | "depth24plus-stencil8"
  | "s3tc-dxt1"
  | "s3tc-dxt3"
  | "s3tc-dxt5"
  | "etc2-rgb8"
  | "etc2-rgba8"
  | "astc-4x4"
  | "astc-6x6"
  | "astc-8x8"
  | "bptc-rgba";

export type TextureUsage =
  | "sample"
  | "render-attachment"
  | "copy-dst"
  | "copy-src"
  | "storage";

export interface TextureLevel {
  readonly mipLevel: number;
  /** Array layer or cube face. */
  readonly layer: number;
  /** Tight or padded per `bytesPerRow`. */
  readonly bytes: ArrayBufferView;
  /** Required when height > 1. */
  readonly bytesPerRow: number;
}

export interface TextureDesc {
  readonly label: string;
  /** 1..limits.maxTextureDimension2D. */
  readonly width: number;
  readonly height: number;
  /** Default 1. */
  readonly depthOrArrayLayers?: number;
  /** Default 1; must match supplied levels. */
  readonly mipLevels?: number;
  readonly format: TextureFormat;
  readonly usage: readonly TextureUsage[];
  /** Default 1. */
  readonly sampleCount?: 1 | 4;
  /** Required for sampled textures. */
  readonly data?: readonly TextureLevel[];
  /** M0 inline sampler; `createSampler` is M1. */
  readonly sampler?: SamplerDesc;
  /** Default `options.retainCpuCopies`. */
  readonly retainCpu?: boolean;
}

export interface SamplerDesc {
  readonly label?: string;
  readonly magFilter: "nearest" | "linear";
  readonly minFilter: "nearest" | "linear";
  readonly mipmapFilter: "nearest" | "linear";
  readonly addressU: "clamp-to-edge" | "repeat" | "mirror-repeat";
  readonly addressV: "clamp-to-edge" | "repeat" | "mirror-repeat";
  readonly addressW?: "clamp-to-edge" | "repeat" | "mirror-repeat";
  /** 1..16, default 1. */
  readonly maxAnisotropy?: number;
  /** Shadow samplers only. */
  readonly compare?: "less-equal";
}

export interface RenderTargetDesc {
  readonly label: string;
  /** Render resolution, not CSS. */
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
  readonly sampleCount?: 1 | 4;
  readonly depth: "none" | "depth24plus" | "depth32float";
  /** Only 1 in ABI 1. */
  readonly mips?: 1;
  readonly clear?: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  };
  readonly clearDepth?: number;
}

export interface RenderPassDesc {
  readonly target: RenderTargetHandle | "swapchain";
  readonly clearColor?: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  };
  readonly clearDepth?: number;
  /** Default "clear". */
  readonly loadOp?: "clear" | "load";
}

export type AlphaMode = "opaque" | "mask" | "blend";

export interface MaterialDesc {
  readonly label: string;
  /** Linear, 0..1. */
  readonly baseColorFactor: readonly [number, number, number, number];
  /** 0..1. */
  readonly metallic: number;
  /** 0.04..1 (clamped). */
  readonly roughness: number;
  /** Linear. */
  readonly emissiveFactor: readonly [number, number, number];
  /** sRGB. */
  readonly baseColorTexture?: TextureHandle | null;
  /** Linear; G = roughness, B = metallic. */
  readonly metallicRoughnessTexture?: TextureHandle | null;
  /** Linear. */
  readonly normalTexture?: TextureHandle | null;
  /** Default 1. */
  readonly normalScale?: number;
  /** Linear; R. */
  readonly occlusionTexture?: TextureHandle | null;
  /** Default 1. */
  readonly occlusionStrength?: number;
  /** sRGB. */
  readonly emissiveTexture?: TextureHandle | null;
  /** Default "opaque". */
  readonly alphaMode?: AlphaMode;
  /** Default 0.5, mask only. */
  readonly alphaCutoff?: number;
  /** Default false. */
  readonly doubleSided?: boolean;
  /** Default false. */
  readonly unlit?: boolean;
}

export interface LodEntry {
  readonly mesh: MeshHandle;
  /** Switch up to this entry at or above this screen radius. */
  readonly minScreenRadiusPx: number;
}

export interface LodGroupDesc {
  readonly label: string;
  /** 1..4, descending thresholds. */
  readonly entries: readonly LodEntry[];
  /** Union bounds, model space. */
  readonly bounds: BoundingSphere;
  /** Default 0.1 (10%). */
  readonly hysteresis?: number;
}

export interface ReadbackOptions {
  /** Default 0. */
  readonly mipLevel?: number;
  /** Default 0. */
  readonly layer?: number;
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  /** Only "rgba8" in ABI 1. */
  readonly format?: "rgba8";
}

export interface FrameCapture {
  readonly width: number;
  readonly height: number;
  /** 4 bytes per pixel, top-left origin. */
  readonly rgba: Uint8Array;
}

export interface RestoreResult {
  readonly ok: boolean;
  readonly reason?:
    | "device-lost"
    | "adapter-unavailable"
    | "device-request-failed"
    | "disposed";
  readonly restoredHandles: number;
  readonly staleHandles: number;
}

export type DeviceLostListener = (info: {
  readonly reason: "destroyed" | "unknown";
  /** Sanitized; no URLs or tokens. */
  readonly message: string;
}) => void;

export type RestoredListener = () => void;

/**
 * W0 ambiguity: 00 §3.2 and 04 §3.2 require `BufferDesc` and `PipelineDesc`
 * in the device surface, but neither spec defines their fields (00 §3.2 says
 * their exact fields are "part of those specs"; 04 §3 never supplies them).
 * They are declared opaque so the contract compiles without inventing a
 * descriptor shape. W1 (or a 04 amendment) narrows them additively.
 */
export type BufferDesc = Readonly<Record<string, unknown>>;
export type PipelineDesc = Readonly<Record<string, unknown>>;

/**
 * Renderer ABI 1 (04 §4.1). The runtime value lives in `src/version.ts` and
 * must equal this literal. Any change invalidates the pipeline cache.
 */
export const RENDERER_ABI_VERSION: 1;
/** Built-in shader ABI 1 (04 §4.1); part of every shader cache key. */
export const SHADER_ABI_VERSION: 1;

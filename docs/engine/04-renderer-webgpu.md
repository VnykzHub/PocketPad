# 04 — WebGPU Renderer

**Status:** authoritative for the WebGPU renderer backend, the backend-neutral render contract it implements, and the engine-facing 3D surface. `docs/engine/00-architecture.md` owns the layer map and package boundaries; this file owns the internals and the supporting structures of the render contract (`Surface`, `DeviceLimits`, descriptors, `RenderStats`).
**Authority:** [`SPEC.md`](../../SPEC.md) for the product/protocol contract, [`docs/engine/README.md`](README.md) for the programme rules, [`docs/engine/00-architecture.md`](00-architecture.md) for boundaries. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until amendment **A14 — Browser-native engine reframe** is recorded in [`docs/todos/README.md`](../todos/README.md). A14 must exist before WebGPU implementation code merges.

**Decision fixed by the programme:** custom **WebGPU-first** renderer with a **WebGL2 fallback**, no Three.js. `SPEC.md` v0.3 currently says the opposite (§2, §6.2, §18); that contradiction is recorded in 00 §0 and resolved by A14, not by silently changing this spec.

**Milestone boundary.** M0 is the lit, textured, instanced mesh path with one directional light, frustum culling, pipeline cache and device-loss recovery. PBR with multiple lights, shadows, post-processing and LOD are specified here as the target contract but land in M1/M2. A row marked M1/M2 below is not an M0 requirement.

**No implementation exists in this tree.** `packages/engine/` does not exist as of 2026-10-22; the only renderer code today is `packages/runtime/src/render/` (WebGL2 and Canvas2D). This spec defines what to build and is not evidence of code or measurements. Every acceptance row is PENDING.

---

## 1. Goal

Give the engine a renderer that is fast enough to treat a Vice City-scale open world as an architectural ceiling, while staying invisible to games.

Player-visible outcome for M0:

- a lit, textured 3D cube renders at 1920×1080 CSS (DPR 1) with a measured frame p95 at or under the 14 ms target;
- 5,000 instanced textured cubes render in one scene with ≤ 120 draw calls and ≤ 128 MB of GPU texture memory;
- resizing the window, changing DPR, losing the device and recovering it never shows a stack trace, a black frame or a stuck page;
- the same scene runs through the WebGL2 backend (spec 05) through the same contract, with no game code branching on backend.

Engineering outcome:

1. **One contract, two backends.** `RenderDevice` and `RenderFrame` are backend-neutral. Only `packages/runtime/src/render/selectRenderer.ts` names a concrete backend.
2. **No game sees the GPU.** Games receive the frozen `GameRenderer3D` surface plus additive capabilities, or the engine-rendered scene path. They never receive `GPUDevice`, `GPUTexture`, `WebGL2RenderingContext`, a pipeline or a bind group.
3. **Load-time creation, frame-time recording.** Pipelines, shader modules, layouts, meshes, textures and materials are created during boot or scene load. The steady-state frame records draws and submits; it never compiles or allocates.
4. **Measured, not assumed.** Every performance claim has a fixture, a named browser/GPU and a row in `docs/RESULTS.md`. Hardware rows stay PENDING until run.
5. **A path to open-world rendering.** Instancing, LOD selection, frustum culling, shadow cascades, a bind-group model that maps cleanly to WebGL2, and a resource budget that can be enforced are present in the design from day one, even when implemented in a later milestone.

---

## 2. Non-goals

- **Not a general-purpose renderer API for third-party engines.** No public shader authoring in M0/M1. Games use built-in materials; custom material graphs are an editor/SDK feature after M2.
- **Not a raytracer, software rasterizer or WebGL1 backend.** WebGPU is Tier A, WebGL2 is Tier B (spec 05), Canvas2D is 2D-only (spec 05).
- **No Three.js, Babylon, Pixi, PlayCanvas or WASM renderer.** No third-party runtime dependency enters this package. WGSL is written by hand.
- **No compute-driven culling, GPU particles, GPU skinning, mesh shaders, ray queries, variable-rate shading, or clustered lighting in v1.** Compute is feature-gated for later specs; the v1 frame must be complete without it.
- **No VR/XR, no multiview, no HDR display output, no wide-gamut management.** Canvas format is the browser preferred 8-bit format; HDR exists only in intermediate render targets.
- **No editor, no scene authoring, no asset codecs.** This package consumes decoded meshes/textures from `engine-assets` (spec 06); it does not parse GLB or KTX2.
- **No game logic, animation sampling, physics, streaming policy or UI layout.** It draws what the frame encoder submits.
- **No promise of identical pixels to WebGL2.** The contract promises the same scene, same simulation and a measured quality tier; pixel parity uses tolerance rows (00 ER-00-05).
- **No pixel-perfect parity across GPU vendors.** Evidence is recorded per adapter; a different adapter is a different row.
- **No Safari/WebKit host support in v1.** Safari phones remain controllers. Firefox WebGPU is best-effort; Firefox WebGL2 is Tier B.
- **No dynamic shader hot reload in production.** Dev-only shader reload is allowed behind `?debug=1` and must not ship.

---

## 3. Public interfaces

The contract lives in `@lanpad/engine-core`'s `src/render/contract.ts` (spec 00 authors the scaffold; this spec owns the field-level definitions after M0). It is imported by both renderer packages and by `packages/runtime`, never by `sdk`, `controller` or a game.

### 3.1 Backend-neutral rules

- No public type contains a WebGPU, WebGL2 or DOM object. `Surface.native` is typed `unknown` and documented as backend-private; only a renderer backend may cast it.
- Handles are opaque, generational and owned by the device. All resource references cross layers as handles.
- The render contract uses engine-core math types (`Mat4`, `Vec3`) and plain numbers. No protocol types.
- Feature decisions use `RendererCapabilities` and `EngineFeature`, never `backend`, never user-agent. `backend` exists for diagnostics and the legacy `GameRenderer3D` field only.
- A backend may implement fewer features but must implement every M0 method. A missing M1 method returns/throws `E_UNSUPPORTED_FEATURE` until that milestone lands; it must not silently no-op.

### 3.2 Device surface

```ts
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

/** Actual CSS-pixel size. Games draw in a 1280x720 design space (HP-04). */
export interface RendererSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Platform-owned drawing surface. `native` is an opaque HTMLCanvasElement in
 * the runtime; only a backend may read it. It is `unknown` here so no DOM type
 * crosses the engine contract.
 */
export interface Surface {
  readonly kind: "canvas";
  readonly native: unknown;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
}

export interface DeviceLimits {
  readonly maxTextureDimension2D: number;
  readonly maxTextureArrayLayers: number;
  readonly maxBindGroups: number;
  readonly maxUniformBufferBindingSize: number;
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
  readonly maxVertexBuffers: number;
  readonly maxColorAttachments: number;
  readonly maxSamplerAnisotropy: number;
  readonly minUniformBufferOffsetAlignment: number;
  readonly maxComputeWorkgroupSizeX: number;
}

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
  readonly quality?: RendererQualityTier;     // default "high" desktop, "medium" TV
  readonly maxRenderHeight?: number;          // 0 = no cap; TV profile passes 1080
  readonly maxTextureBytes?: number;          // default 128 MiB (PR-9.2 provisional)
  readonly shadowCascades?: 0 | 2 | 3;        // default 3 desktop / 0 TV at M0
  readonly post?: boolean;                    // default false at M0
  readonly anisotropy?: number;               // 1..16, clamped by limits
  readonly retainCpuCopies?: boolean;         // default true; see 5.9
}

export interface DeviceInitResult {
  readonly backend: RendererBackend;
  readonly capabilities: RendererCapabilities;
  readonly adapterInfo: string;               // display-only, sanitized
}

export interface RenderDevice {
  readonly backend: RendererBackend;
  readonly features: ReadonlySet<EngineFeature>;
  readonly limits: DeviceLimits;
  readonly capabilities: RendererCapabilities;
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
  /** One re-create attempt after device loss. Runtime owns the retry policy. */
  restore(): Promise<RestoreResult>;
  onDeviceLost(listener: DeviceLostListener): () => void;
  onRestored(listener: RestoredListener): () => void;

  /** Debug/benchmark only. */
  readTexture(handle: TextureHandle, opts: ReadbackOptions): Promise<Uint8Array>;
  captureFrame(): Promise<FrameCapture>;

  readonly stats: RenderStats;
  readonly size: RendererSize;
  dispose(): void;                            // idempotent
}
```

### 3.3 Frame surface

```ts
export interface RenderFrame {
  /** False while the device is lost or the surface has zero size. */
  readonly valid: boolean;
  setCamera(viewProjection: Mat4): void;
  /** Additive: needed when a pass requires separate view/projection. */
  setCameraMatrices(view: Mat4, projection: Mat4): void;
  draw(mesh: MeshHandle, material: MaterialHandle, transform: Mat4): void;
  /** `transforms` is 16 floats per instance, column-major. Read, never retained. */
  drawInstanced(
    mesh: MeshHandle,
    material: MaterialHandle,
    transforms: Float32Array,
    count: number,
  ): void;
  drawLod(group: LodGroupHandle, material: MaterialHandle, transform: Mat4): void;
  /** M1: offscreen or shadow pass. The default swapchain pass is implicit. */
  beginPass(desc: RenderPassDesc): RenderPassEncoder;
  /** M1: fullscreen post pass source. */
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
```

`beginFrame()` implicitly opens the swapchain pass with the clear colour configured by `RenderDeviceOptions`/runtime (default `{ r: 0.043, g: 0.059, b: 0.078, a: 1 }`, matching today's cube demo). A `beginPass` for an offscreen target closes the implicit pass first. `endFrame()` closes any open pass, submits exactly one command buffer and presents. Calling `draw` before `setCamera` is a contract error (`E_CONTRACT` in dev; identity camera and a counter in production).

### 3.4 Handles and stats

```ts
export interface GpuHandle { readonly index: number; readonly generation: number; }
export type ShaderModuleHandle = GpuHandle & { readonly __kind: "shader" };
export type PipelineHandle     = GpuHandle & { readonly __kind: "pipeline" };
export type TextureHandle      = GpuHandle & { readonly __kind: "texture" };
export type SamplerHandle      = GpuHandle & { readonly __kind: "sampler" };
export type BufferHandle       = GpuHandle & { readonly __kind: "buffer" };
export type MeshHandle         = GpuHandle & { readonly __kind: "mesh" };
export type LodGroupHandle     = GpuHandle & { readonly __kind: "lodGroup" };
export type MaterialHandle     = GpuHandle & { readonly __kind: "material" };
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
  readonly gpuFrameMs: number | null;   // null without timestamp-query
  readonly cpuFrameMs: number;
}
```

`stats` is a stable object mutated once per frame; readers copy fields, never retain arrays. `textureBytes` is the live GPU texture + render-target + shadow-atlas total, including mips and array layers, rounded to 256-byte alignment per subresource. `bufferBytes` is live buffer allocation. Both are updated on create/destroy and read in O(1).

### 3.5 Engine-facing 3D surface (games)

There are exactly two game-facing paths, both backend-agnostic:

1. **Legacy `GameRenderer3D` (frozen, SDK 1.x).** `backend`, `beginFrame(alpha)`, `endFrame()`, `setCamera(position, target)`, `drawCube(position, size, color, rotationY)`, `drawCalls`, `textureMemoryMB`. In the engine runtime it is implemented by `LegacyGameRendererAdapter` (00 §5.5) over `RenderDevice`: `setCamera` writes the scene camera, `drawCube` uses a shared unit cube and a cached colour material, repeated cubes above 10 instances batch into `drawInstanced`, and the Canvas2D compatibility path preserves today's pixels. `backend` gains `"webgpu"` additively; games must not exhaustively switch on it.
2. **Engine scene path (M0/M1, additive SDK).** `ctx.scene` (spec 03) is rendered by the engine before `game.render(alpha)`. Games read `ctx.renderer.capabilities` to choose quality/feature branches and add entities/components; they never receive `RenderDevice`, a handle, a render target or a pass encoder.

`RendererCapabilities` is restated structurally in `sdk` (00 §3.6) so `sdk` stays zero-dependency; `packages/runtime` carries a compile-time assignability test between the engine type and the SDK type. A mismatch fails typecheck.

### 3.6 Package entry points

`@lanpad/engine-renderer-webgpu` exposes one browser-only entry point (`.`). It exports the concrete `WebGpuDevice` interface, `createWebGpuDevice(options): Promise<WebGpuDeviceInitResult>`, the built-in shader ABI constants and the contract re-exports needed by `packages/runtime`. `WebGpuDeviceInitResult` carries the device, narrowed capabilities and the display-only adapter string, matching the WebGL2 factory. It exports no test-only hooks in production; test doubles live under `test/` and are not part of the package entry. Later revisions may add `./profiling` (dev-only) and `./shaders` (tooling) entries; both are additive.

---

## 4. Data formats

All structures below are runtime JavaScript/TypeScript objects, not files. The only persisted renderer-adjacent formats are the built-in shader sources (TypeScript string modules, bundled) and the readback/capture outputs used by tests. Mesh, texture and material files are owned by spec 06; this spec consumes their decoded form.

### 4.1 Version registry

| Name | Value | Owner | Bump rule |
|---|---|---|---|
| `RENDERER_ABI_VERSION` | `1` | 04 | Any change to the vertex layout, uniform layouts, bind-group assignment, material model or built-in shader interface. A bump invalidates the pipeline cache and requires spec-05 parity work. |
| `SHADER_ABI_VERSION` | `1` | 04 | Any change to built-in shader inputs/outputs or the material uniform block. Included in every shader cache key. |
| `PIPELINE_CACHE_VERSION` | `1` | 04 | Cache-key canonicalisation change. |
| `TEXTURE_FORMAT_VERSION` | n/a (no file) | 04 | No persisted texture format is introduced by this spec. |

A pipeline or shader module whose `abiVersion` does not equal the running constant is refused with `E_UNSUPPORTED_FEATURE`, not compiled on a guess.

### 4.2 Shader modules

```ts
export interface ShaderModuleDesc {
  readonly label: string;                    // 1..64 chars, stable; used in errors
  readonly stage: "vertex" | "fragment" | "compute";
  readonly language: "wgsl";                 // this package; spec 05 uses "glsl"
  readonly code: string;                     // UTF-8, <= 64 KiB
  readonly entryPoint: string;               // "vs_main" | "fs_main" | "cs_main"
  readonly abiVersion: 1;
  readonly defines?: Readonly<Record<string, number | boolean>>; // prepended as WGSL consts
}
```

Rules:

- Source is validated for size, UTF-8, entry point presence and `abiVersion` before touching the GPU; failures throw `E_PIPELINE_COMPILE` synchronously with the label and the first three compiler lines in dev.
- The renderer prepends `struct`/`const` definitions from `defines`; it never string-replaces source text.
- Built-in shaders ship as `src/shaders/*.wgsl.ts` modules exporting template strings, so no fetch, CSP change or loader plugin is needed. The M0 set is: `pbr.wgsl.ts` (opaque/mask PBR), `shadow.wgsl.ts` (depth-only), `fullscreen.wgsl.ts` (blit/tonemap/FXAA). Later milestones add `bloom.wgsl.ts` and `point-shadow.wgsl.ts`.
- Shader modules are cached by `SHA-256`-equivalent key: the exact tuple `(language, stage, entryPoint, abiVersion, definesCanonical, code)`. A 64-bit FNV-1a pair is used in production for speed; dev additionally compares the full tuple on a collision. Maximum 64 modules.
- No game-authored shader enters this package before M2. The public surface accepts shader modules so the engine can add materials without changing the contract.

### 4.3 Vertex layouts

Two fixed layouts are valid for built-in pipelines in ABI 1.

**`static-pbr-v1`** — one interleaved vertex buffer, stride 32 bytes:

| Offset | Attribute | Format | Shader location |
|---|---|---|---|
| 0 | `position` | `float32x3` | 0 |
| 12 | `normal` | `float32x3` | 1 |
| 24 | `uv` | `float32x2` | 2 |

**`instanced-transform-v1`** — the same vertex buffer plus one instance buffer, stride 64 bytes:

| Offset | Attribute | Format | Shader location | Step mode |
|---|---|---|---|---|
| 0 | `model0` | `float32x4` | 3 | instance |
| 16 | `model1` | `float32x4` | 4 | instance |
| 32 | `model2` | `float32x4` | 5 | instance |
| 48 | `model3` | `float32x4` | 6 | instance |

Skinned (`skinned-pbr-v1`) and morph layouts are M1/M2 and must be added as new layout ids, never by changing these. Index format is `uint16` for ≤ 65,535 vertices and `uint32` otherwise; the renderer validates the index maximum against the vertex count.

`MeshDesc` carries a required bounding sphere used by culling and LOD:

```ts
export interface BoundingSphere { readonly center: Vec3; readonly radius: number; }

export interface MeshDesc {
  readonly label: string;
  readonly layout: "static-pbr-v1" | "instanced-transform-v1";
  readonly vertices: readonly ArrayBufferView[];   // one buffer in ABI 1
  readonly indices?: { readonly data: Uint16Array | Uint32Array; readonly format: "uint16" | "uint32" };
  readonly bounds: BoundingSphere;                 // model space
  readonly topology?: "triangle-list";             // only value in ABI 1
}
```

### 4.4 Uniform buffer layouts

Uniform structs are written by the renderer, never by games. `std140`-compatible alignment is used so the same CPU packing works for WebGPU and WebGL2. All offsets are bytes.

**Frame uniforms — bind group 0, binding 0, 256 bytes**

| Offset | Field | Type |
|---|---|---|
| 0 | `viewProjection` | `mat4x4<f32>` |
| 64 | `cameraPosition` | `vec4<f32>` (xyz position, w = 1) |
| 80 | `time` | `vec4<f32>` (seconds, dt, frameIndex, exposure) |
| 96 | `ambient` | `vec4<f32>` (rgb colour, intensity) |
| 112 | `resolution` | `vec4<f32>` (renderW, renderH, 1/renderW, 1/renderH) |
| 128 | `fog` | `vec4<f32>` (rgb, density); zero density disables |
| 144 | `clip` | `vec4<f32>` (near, far, 0, 0) |
| 160 | reserved | 96 bytes, zero |

**Light uniforms — bind group 1, binding 0, 2048 bytes**

| Offset | Field | Type |
|---|---|---|
| 0 | `counts` | `vec4<u32>` (directionalCount, pointCount, cascadeCount, flags) |
| 16 | `directional[4]` | each 32 bytes: `direction vec4` (xyz, 0), `colorIntensity vec4` (rgb, intensity) |
| 144 | `cascadeMatrix[3]` | `mat4x4<f32>` each (light view-projection) |
| 336 | `cascadeSplit` | `vec4<f32>` (near distances for 3 cascades, w = fade) |
| 352 | `point[32]` | each 32 bytes: `positionRadius vec4`, `colorIntensity vec4` |
| 1376 | `shadowAtlas` | `vec4<f32>` (tile size, 1/tile size, atlas size, 0) |
| 1392 | reserved | 656 bytes, zero |

**Object uniforms — bind group 3, binding 0, dynamic, 256-byte stride**

| Offset | Field | Type |
|---|---|---|
| 0 | `model` | `mat4x4<f32>` |
| 64 | `normalMatrix` | three `vec4<f32>` (columns, w unused) |
| 112 | `tint` | `vec4<f32>` (rgb multiplier, alpha) |
| 128 | reserved | 128 bytes, zero |

The dynamic stride is `max(256, limits.minUniformBufferOffsetAlignment)`; the writer rounds up. The object ring is 2 MiB per in-flight frame (8,192 objects at 256 bytes) and 3 frames in flight, so 6 MiB total. **Bind group 3 binds only `OBJECT_UNIFORM_BYTES` (256 B) at offset 0; the per-draw dynamic offset selects the ring slot.** The ring is never bound as one uniform range: WebGPU's default `maxUniformBufferBindingSize` is 65,536 bytes, so binding the whole ring produces an invalid bind group. Exceeding 8,192 object-uniform writes in one frame increments `stats.droppedDraws` and drops the excess draws; dev logs once per frame with the count.

**Shadow-pass uniforms** reuse bind group 0 (frame) and bind group 3 (object); the shadow pipeline layout has no material group. Post pipelines use a `post` group with one texture + sampler and a 32-byte parameter block.

### 4.5 Textures, samplers and colour space

```ts
export type TextureFormat =
  | "rgba8unorm" | "rgba8unorm-srgb" | "bgra8unorm"
  | "rgba16float" | "rgba32float" | "r8unorm" | "rgb10a2unorm"
  | "depth24plus" | "depth32float" | "depth24plus-stencil8"
  | "s3tc-dxt1" | "s3tc-dxt3" | "s3tc-dxt5"
  | "etc2-rgb8" | "etc2-rgba8"
  | "astc-4x4" | "astc-6x6" | "astc-8x8"
  | "bptc-rgba";

export type TextureUsage =
  | "sample" | "render-attachment" | "copy-dst" | "copy-src" | "storage";

export interface TextureLevel {
  readonly mipLevel: number;
  readonly layer: number;                 // array layer or cube face
  readonly bytes: ArrayBufferView;        // tight or padded per bytesPerRow
  readonly bytesPerRow: number;           // required when height > 1
}

export interface TextureDesc {
  readonly label: string;
  readonly width: number;                 // 1..limits.maxTextureDimension2D
  readonly height: number;
  readonly depthOrArrayLayers?: number;   // default 1
  readonly mipLevels?: number;            // default 1; must match supplied levels
  readonly format: TextureFormat;
  readonly usage: readonly TextureUsage[];
  readonly sampleCount?: 1 | 4;           // default 1
  readonly data?: readonly TextureLevel[]; // required for sampled textures
  readonly sampler?: SamplerDesc;         // M0 inline sampler; createSampler is M1
  readonly retainCpu?: boolean;           // default options.retainCpuCopies
}

export interface SamplerDesc {
  readonly label?: string;
  readonly magFilter: "nearest" | "linear";
  readonly minFilter: "nearest" | "linear";
  readonly mipmapFilter: "nearest" | "linear";
  readonly addressU: "clamp-to-edge" | "repeat" | "mirror-repeat";
  readonly addressV: "clamp-to-edge" | "repeat" | "mirror-repeat";
  readonly addressW?: "clamp-to-edge" | "repeat" | "mirror-repeat";
  readonly maxAnisotropy?: number;        // 1..16, default 1
  readonly compare?: "less-equal";        // shadow samplers only
}
```

Rules:

- The union above is the **single canonical texture vocabulary** for both backends and for spec 06 variant selection. A backend supports a subset, reported through `supportedFormats`; using an unsupported token is `E_UNSUPPORTED_FEATURE`, never a silent downcast.
- Compressed formats require the matching feature flag (`compressed-s3tc`, `compressed-etc2`, `compressed-astc`); `bptc-rgba` is desktop-only and feature-gated. A compressed upload uses the block geometry of its format; the 256-byte `bytesPerRow` rule applies only to uncompressed uploads.
- `bgra8unorm` is the WebGPU preferred swapchain format; it is not required as an upload or render-target format on the WebGL2 Tier B backend (spec 05).
- `rgba32float` sampling is core where the adapter exposes it; rendering to it requires the `float-render-target` feature.
- Colour textures are `rgba8unorm-srgb` or `rgba16float`; normal, metallic-roughness, occlusion and mask textures are linear formats. A material validation error (`E_ASSET_FORMAT`) is raised when a texture bound to a colour slot is linear or vice versa, unless the material sets `unlit` and the slot is base colour.
- M0/M1 do **not** generate mips. `mipLevels > 1` requires all levels supplied (KTX2 transcoding in spec 06). M2 may add `generateMips(handle)` additively.
- Uploads require `copy-dst`; sampled textures require `sample`; render targets require `render-attachment`; readback requires `copy-src`; readback also requires `copy-src` on the source. Storage textures are WebGPU-only and feature-gated.
- `bytesPerRow` must be a multiple of 256 for `writeTexture` and large enough for the row; the uploader pads on the CPU when the asset is tight.
- Samplers are cached by canonical `SamplerDesc`; maximum 32. Anisotropy is clamped to `limits.maxSamplerAnisotropy` (4 on most desktop adapters, 1 on some TV drivers).
- Texture memory accounting: `sum over subresources(align256(bytesPerPixel * width * height))`, plus 25% overhead not assumed. Render targets and shadow atlas count. Compressed/transcoded textures count their GPU footprint, not source bytes.

### 4.6 Render targets and passes

```ts
export interface RenderTargetDesc {
  readonly label: string;
  readonly width: number;                 // render resolution, not CSS
  readonly height: number;
  readonly format: TextureFormat;
  readonly sampleCount?: 1 | 4;
  readonly depth: "none" | "depth24plus" | "depth32float";
  readonly mips?: 1;                      // only 1 in ABI 1
  readonly clear?: { readonly r: number; readonly g: number; readonly b: number; readonly a: number };
  readonly clearDepth?: number;
}

export interface RenderPassDesc {
  readonly target: RenderTargetHandle | "swapchain";
  readonly clearColor?: { readonly r: number; readonly g: number; readonly b: number; readonly a: number };
  readonly clearDepth?: number;
  readonly loadOp?: "clear" | "load";     // default "clear"
}
```

Pass order for the full quality tier (M1/M2): shadow cascades → opaque scene into HDR target (MSAA resolve if enabled) → transparent → post chain (bloom, tonemap, FXAA) → swapchain. M0 skips shadow/post and renders straight to the swapchain. The renderer owns no frame graph; the runtime/scene encoder decides passes. The renderer validates that a target is not bound as both sampled input and attachment in the same pass, except the explicit ping-pong rule for post (source and destination must differ).

### 4.7 Materials

```ts
export type AlphaMode = "opaque" | "mask" | "blend";

export interface MaterialDesc {
  readonly label: string;
  readonly baseColorFactor: readonly [number, number, number, number]; // linear, 0..1
  readonly metallic: number;             // 0..1
  readonly roughness: number;            // 0.04..1 (clamped)
  readonly emissiveFactor: readonly [number, number, number];         // linear
  readonly baseColorTexture?: TextureHandle | null;                  // sRGB
  readonly metallicRoughnessTexture?: TextureHandle | null;          // linear, G=roughness, B=metallic
  readonly normalTexture?: TextureHandle | null;                     // linear
  readonly normalScale?: number;                                      // default 1
  readonly occlusionTexture?: TextureHandle | null;                  // linear, R
  readonly occlusionStrength?: number;                                // default 1
  readonly emissiveTexture?: TextureHandle | null;                   // sRGB
  readonly alphaMode?: AlphaMode;                                     // default "opaque"
  readonly alphaCutoff?: number;                                      // default 0.5, mask only
  readonly doubleSided?: boolean;                                     // default false
  readonly unlit?: boolean;                                           // default false
}
```

The material model is glTF 2.0 metallic-roughness with one normal map and one occlusion map. It is deliberately a subset: no clearcoat, sheen, transmission, iridescence or anisotropy, because each adds shader cost and WebGL2 parity work before a game proves the need. Materials are immutable; changing a parameter creates a new handle and the runtime releases the old one. A material with all four optional textures unset uses a 1×1 white fallback texture and a 1×1 neutral metallic-roughness texture.

### 4.8 Cache keys

Canonical keys are built only at creation time; the per-frame path looks up by handle.

- **Shader module key:** `sha256(language | stage | entryPoint | abiVersion | definesCanonical | code)` represented as 32 bytes; dev keeps the tuple for collision proof.
- **Pipeline key:** `PIPELINE_CACHE_VERSION | vertexShaderKey | fragmentShaderKey | vertexLayout | primitiveState | depthState | multisample | colorFormats | blendStates | layoutId | definesCanonical`. The key is a UTF-8 string ≤ 4 KiB, hashed with FNV-1a 32 for the stats label; the cache stores the full string for equality. Maximum 256 pipelines, LRU eviction destroys the GPU pipeline but keeps shader modules.
- **Bind-group key (group 2, material):** `materialHandle.index | materialHandle.generation | samplerKey`. Maximum 4,096 entries; cleared on device restore. Groups 0, 1 and 3 are allocated once per frame/in-flight slot, not cached per draw.
- **Sampler key:** canonical `SamplerDesc` JSON, maximum 32 entries.
- **LOD group key:** not cached; a LOD group is an explicit handle.

Cache eviction never happens mid-frame; it runs after `endFrame()` submit. A pipeline destroyed while a submitted command buffer references it is safe (WebGPU keeps GPU-side references alive); the JS wrapper is released.

### 4.9 Readback, capture and profiling data

```ts
export interface ReadbackOptions {
  readonly mipLevel?: number;             // default 0
  readonly layer?: number;                // default 0
  readonly x?: number; readonly y?: number;
  readonly width: number; readonly height: number;
  readonly format?: "rgba8";              // only rgba8 in ABI 1
}

export interface FrameCapture {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;              // 4 bytes per pixel, top-left origin
}

export interface RestoreResult {
  readonly ok: boolean;
  readonly reason?: "device-lost" | "adapter-unavailable" | "device-request-failed" | "disposed";
  readonly restoredHandles: number;
  readonly staleHandles: number;
}

export type DeviceLostListener = (info: {
  readonly reason: "destroyed" | "unknown";
  readonly message: string;               // sanitized, no URLs or tokens
}) => void;
export type RestoredListener = () => void;
```

`readTexture` and `captureFrame` are dev/benchmark-only: they return a rejected promise with `E_UNSUPPORTED_FEATURE` when the build is production or the texture lacks `copy-src`. `captureFrame` reads the presented swapchain texture after `endFrame()`; on a device without `copy-src` support for the preferred canvas format it returns unsupported. Capture bytes are bottom-up in WebGPU; the implementation flips rows before resolving so the public origin is top-left. Golden tests consume `FrameCapture`; no PNG encoder is added to the package (spec 19 owns test encoding).

### 4.10 Limits and budget defaults

| Limit | Default | Source |
|---|---|---|
| Draw calls per frame | 120 | SPEC PR-9.1; hard gate |
| Draw calls in M0 fixtures | ≤ 8 | This spec, §7 |
| GPU texture memory | 128 MiB provisional | SPEC PR-9.2 |
| Buffer memory | 64 MiB soft; 256 MiB absolute | This spec |
| Object uniform ring | 2 MiB/frame × 3 frames | This spec |
| Staging belt | 2 MiB/frame, max 16 MiB | This spec |
| Uploads per frame | 8 MiB or 2 ms, whichever first | This spec |
| Pipelines | 256 live | This spec |
| Shader modules | 64 live | This spec |
| Bind-group cache | 4,096 entries | This spec |
| Samplers | 32 live | This spec |
| Max instanced draw | 65,536 instances | This spec |
| Max LOD entries per group | 4 | This spec |
| Shadow cascades | 0, 2 or 3 | This spec |
| Shadow tile | 1024×1024, atlas 2048×2048 | This spec |
| MSAA | 1 or 4 samples | This spec |

The 128 MiB texture budget stays provisional until a TV E2 run replaces it (00 R15). The renderer reports usage; it does not crash a game for exceeding a soft budget. Exceeding the absolute WebGPU limit throws `E_ASSET_BUDGET` before allocation.

---

## 5. Architecture

### 5.1 Module map

```text
packages/engine/renderer-webgpu/src/
  index.ts                  public entry: WebGpuDevice, createWebGpuDevice, ABI constants
  errors.ts                 EngineError construction and sanitized messages
  device/
    adapter.ts              navigator.gpu probe, requestAdapter/requestDevice, limits
    WebGpuDevice.ts         RenderDevice implementation, registries, frame lifecycle
    limits.ts               required/default limits, feature negotiation
    options.ts              RenderDeviceOptions normalization and quality tiers
    deviceLost.ts           lost/restore state machine
    errorScope.ts           push/pop wrappers, uncaptured-error handler
  swapchain/
    Swapchain.ts            canvas.configure, getCurrentTexture, resize, outdated
  pipeline/
    ShaderCache.ts          module creation and cache
    PipelineCache.ts        key building, create, LRU, switch tracking
    PipelineLayout.ts       built-in layouts (pbr, shadow, post, 2d)
  bindgroup/
    BindGroupCache.ts       material groups, per-frame groups, invalidation
    FrameBindings.ts        frame + light uniform buffers and shadow bindings
  buffer/
    BufferArena.ts          vertex/index/uniform/storage allocations
    UniformRing.ts          per-frame dynamic-offset ring, 3 slots
    UploadBelt.ts           staging belt, copy scheduling, upload budget
  texture/
    Texture.ts              creation, subresource upload, accounting
    Sampler.ts              sampler cache
    TextureMemory.ts        byte accounting and budget warning
  mesh/
    Mesh.ts                 vertex/index buffers, bounds, index validation
    LodGroup.ts             LOD entry table and selection hookup
  material/
    Material.ts             immutable descriptor, fallback textures
    MaterialCache.ts        validation, bind-group ownership
  frame/
    FrameRecorder.ts        RenderFrame/RenderPassEncoder implementation
    RenderTarget.ts         HDR/MSAA/depth targets, post ping-pong
    draw.ts                 draw validation, culling, uniform write, encode
  camera/
    CameraState.ts          view/projection validation, aspect helpers
  culling/
    FrustumCuller.ts        plane extraction, sphere test, cascade light frusta
  instancing/
    InstanceWriter.ts       transform packing into the uniform/vertex ring
  lod/
    LodSelector.ts          projected-radius selection with hysteresis
  lights/
    LightSet.ts             directional/point packing, cascade splits
  shadows/
    ShadowAtlas.ts          atlas allocation, cascade matrices, bias
  post/
    PostChain.ts            M1: bloom/tonemap/FXAA pass sequence
  profile/
    Stats.ts                stable counter object
    GpuTimer.ts             timestamp queries, ring of 4
    Readback.ts             readTexture/captureFrame
  shaders/
    pbr.wgsl.ts             built-in lit textured PBR shader
    shadow.wgsl.ts          depth-only shadow shader
    fullscreen.wgsl.ts      blit/tonemap/FXAA shader
    common.wgsl.ts          shared structs/constants (ABI 1)
  compat/
    legacyAdapterSupport.ts helpers used by runtime's LegacyGameRendererAdapter
```

No file outside this package imports a module under `src/device`, `src/pipeline` or any backend-specific directory. The package imports only `@lanpad/engine-core` (00 D2).

### 5.2 Initialization sequence

`WebGpuDevice.init(surface, options)` runs once and must complete before any create call:

1. **Probe.** Read `navigator.gpu`. If absent, throw `E_DEVICE_UNAVAILABLE` without touching the canvas. This is a normal Tier B signal, not an error screen.
2. **Adapter.** `requestAdapter({ powerPreference: "high-performance", forceFallbackAdapter: false })`. A null adapter → `E_DEVICE_UNAVAILABLE` (runtime falls back). One retry with `{ powerPreference: "low-power" }` only when the first call throws (driver bug), not when it returns null.
3. **Limits.** Compute required limits as the minimum this renderer needs (table in §4.10), capped by `adapter.limits`; request `maxTextureDimension2D: 8192`, `maxBufferSize: 256 MiB`, `maxUniformBufferBindingSize: 64 KiB`, `maxStorageBufferBindingSize: 128 MiB` only when storage is required; otherwise request the defaults and read the actual values. Never request a limit above the adapter's.
4. **Features.** Request only optional features the engine or a manifest declares: `timestamp-query` for profiling, `texture-compression-*` for the formats present. `depth32float-stencil8` is not required. A requested feature absent from the adapter is either dropped (optional) or fails with `E_UNSUPPORTED_FEATURE` (manifest-required).
5. **Device.** `adapter.requestDevice({ label: "pocketpad-renderer", requiredFeatures, requiredLimits })`. A rejection → `E_DEVICE_UNAVAILABLE`. Install `device.lost` handling and `uncapturederror` before creating anything.
6. **Capabilities.** Populate `RendererCapabilities` from `adapter.features`, `adapter.limits` and the chosen quality tier. `adapter.info` (vendor/architecture) is copied to a display-only sanitized string; if the browser omits it, use `"WebGPU adapter"`.
7. **Swapchain.** Cast `surface.native` to `HTMLCanvasElement`, call `getContext("webgpu")`, configure it with the preferred format, `alphaMode: "opaque"`, `usage: RENDER_ATTACHMENT | COPY_SRC`, `colorSpace: "srgb"`, and the backing size from `surface.cssWidth/Height × dpr` clamped by `maxRenderHeight`. A null context or failed configuration → `E_BACKEND_INIT` (runtime falls back).
8. **Built-ins.** Create the default sampler, 1×1 white/neutral fallback textures, the shared unit cube, the built-in pipelines lazily on first use (not eagerly: a 2D game should not pay for PBR pipelines), and the object uniform ring (3 × 2 MiB).
9. **State.** Mark `initialized`; create the first `RenderFrame` wrapper; reset stats.

The device is single-use: after `dispose()`, `init()` throws `E_BACKEND_INIT`. Recovery after device loss uses the same instance and `restore()`, not a new `init`.

### 5.3 Swapchain and resize

- The swapchain owns the canvas context configuration, not the render targets. Its backing size is `clamp(round(cssWidth × dpr), 1, limits.maxTextureDimension2D)` with the same `maxRenderHeight` cap as the legacy renderer (CSS size is untouched, so the browser upscales).
- `resize(cssW, cssH, dpr)` updates `size` (CSS pixels, zero before the first call), stores the desired backing size, and marks the swapchain dirty. The actual `context.configure()` happens at the next `beginFrame()`, at most once per frame, so ten resize events in one frame cost one reconfiguration.
- If width or height is 0 (hidden tab, detached element), `beginFrame()` returns an invalid frame, does no GPU work, and `endFrame()` is a no-op. The loop keeps running; the first non-zero resize restores rendering.
- `getCurrentTexture()` failure with `"outdated"` → reconfigure once and retry; a second failure marks the frame invalid and increments `gpuErrors`. `"lost"` → enter the device-lost path.
- The swapchain texture is valid only until `endFrame()` presents. The renderer never retains it.
- DPR changes are normal resizes. A TV profile clamps DPR to 1 (FR-9.4); desktop clamps to 2. The renderer does not read device profiles; the runtime passes the final DPR.

### 5.4 Frame recording and submission

Per display frame:

1. **`beginFrame()`** — if dirty, reconfigure; acquire the swapchain texture; reset per-frame counters (`drawCalls`, `triangles`, `instances`, pipeline/bind-group switches); reset the uniform ring slot for `frameIndex % 3`; write frame uniforms from the current camera and light set; open the implicit swapchain pass with clear; return the frame wrapper.
2. **Scene encoder (host runtime)** — the runtime encoder queries spec 03's `Renderable` entities, resolves asset ids through spec 06's `AssetLibrary`, sorts by layer, material and mesh, and submits low-level draws. The renderer preserves submission order; it does not sort. Opaque/transparent ordering, batching and LOD choice belong to the encoder, because the renderer must not import the assets package.
3. **Each draw** — validate handles (generation), cull against the current frustum (unless `culling: "none"`), write the object uniform at the ring offset, ensure pipeline and bind groups, encode `draw`/`drawIndexed`/`drawIndexedInstanced`, update counters.
4. **`endFrame()`** — end the open pass; finish the command encoder; `queue.submit([buffer])` exactly once; present; schedule timestamp resolve/map for the next frame (if enabled); run deferred cache eviction; increment `frameIndex`.

No other submit happens in a normal frame. The shadow pass (M1) is recorded before the main pass inside the same command buffer, so it is still one submit. A pipeline or buffer created during a frame is allowed but discouraged; the creation increments `pipelinesCreated` and is not counted as a draw.

The frame wrapper is reused (one per in-flight slot) and is invalid after `endFrame()`; calling a draw after `endFrame()` is `E_FRAME_CLOSED` in dev and ignored in production.

### 5.5 Shader modules and pipeline cache

- Shader modules are created on demand and cached by the tuple key in §4.8. A module is never destroyed while a pipeline references it; the cache evicts only unreferenced modules at the 64-entry limit.
- Pipelines are created on first use and cached. A cache hit increments `pipelineCacheHits` and returns the same handle, so switching between two materials with the same state never re-encodes a pipeline.
- A pipeline key that fails compilation is stored as a failed entry with the error message and is never retried in the same session. The first failure throws `E_PIPELINE_COMPILE` at load/first-use time; later lookups return the failed marker and increment `gpuErrors` once per unique key.
- Built-in layouts: `builtin-pbr-v1` (groups 0–3), `builtin-shadow-v1` (groups 0, 3), `builtin-post-v1` (groups 0, 2), `builtin-2d-v1` (group 0 only). Adding a group or changing a binding is an ABI bump.
- The pipeline cache is cleared on `restore()`; shader sources and descriptors survive, so the first frame after restore re-creates only what it draws.

### 5.6 Bind groups

Four groups, fixed assignment:

| Group | Contents | Recreated |
|---|---|---|
| 0 | Frame uniforms (view-projection, camera, time, ambient, resolution, fog, clip) | Every frame (ring offset) |
| 1 | Light uniforms, shadow atlas depth texture + comparison sampler | On light/cascade change or shadow resize |
| 2 | Material textures (base colour, metallic-roughness, normal, emissive, occlusion) + sampler | Per material; cached |
| 3 | Object uniforms (model, normal matrix, tint), dynamic offset | Every draw (ring offset) |

Group 3 uses a dynamic uniform offset, so one bind group serves many draws. The offset is `align(objectIndex * stride, max(256, minUniformBufferOffsetAlignment))`. Groups 0, 1 and 2 are cached by content; group 3 is one per in-flight frame.

Material bind groups are invalidated when a material is destroyed or when the fallback textures change (never in practice). The bind-group cache is bounded at 4,096 entries; exceeding it evicts the oldest material group after submit. Missing material textures bind the fallback textures, so a material never binds a null descriptor.

### 5.7 Buffers and uploads

- **Vertex/index buffers** are created with `createBuffer` and `writeBuffer` at mesh load. They are immutable after creation in ABI 1; dynamic geometry is re-created or written through a storage/vertex buffer with `copy-dst` (M2).
- **Uniform buffers** are ring-allocated in 2 MiB slots per in-flight frame. A ring slot is reused only after three frames, which is safe because the runtime never has more than three frames in flight (one submit per frame, present after submit).
- **Staging belt**: for uploads > 64 KiB, `UploadBelt` writes to a `MAP_WRITE | COPY_SRC` staging buffer and records `copyBufferToBuffer`; for ≤ 64 KiB, `queue.writeBuffer` is used directly. The belt is 2 MiB per frame, grows to 16 MiB, and is reset after submit. Uploads are budgeted at 8 MiB or 2 ms per frame; excess uploads are queued (not dropped) and the caller's promise resolves when the copy is submitted. Asset loading (spec 06) calls the async upload path, never `writeBuffer` in a loop on the main thread with unbounded bytes.
- **Buffer accounting** updates `bufferBytes` on create/destroy. `writeBuffer` validates `offset + data.byteLength <= desc.size` and alignment (`4` for uniform writes, `4` for vertex/index), throwing `E_CONTRACT` before touching the GPU.
- Buffers with `usage: "uniform"` must be 16-byte aligned in size; the allocator rounds up. Storage buffers are WebGPU-only and feature-gated; their absence does not change the M0 path.

### 5.8 Textures and samplers

- Decoded texture levels arrive from spec 06 as `TextureLevel[]`. The renderer creates the `GPUTexture` and calls `queue.writeTexture` per level (or a staging copy for very large levels), then optionally generates mips (M2). A missing level or a wrong `bytesPerRow` throws `E_ASSET_FORMAT` before creation.
- Uploads are validated against `limits.maxTextureDimension2D`, `maxTextureArrayLayers`, format support and usage. A compressed format not in `features` is refused with `E_UNSUPPORTED_FEATURE`; the asset layer must have chosen a supported variant already.
- Samplers are cached by canonical descriptor. The default sampler is linear/linear/linear, clamp-to-edge, anisotropy 4 when supported. Shadow comparison samplers are separate and bound only to group 1.
- Texture memory is accounted per subresource and checked against `maxTextureBytes` (default 128 MiB) on creation: crossing 100% logs once and sets a debug flag; crossing the absolute WebGPU limit throws `E_ASSET_BUDGET`. A destroyed texture releases its accounting immediately, even if the GPU is still finishing a submitted frame.

### 5.9 Resource lifetime, disposal and restore

- **Registries.** One generational registry per handle kind (`shader`, `pipeline`, `texture`, `sampler`, `buffer`, `mesh`, `lodGroup`, `material`, `renderTarget`). `destroy(handle)` checks the generation; a stale handle is `E_STALE_HANDLE` in dev and a no-op plus `gpuErrors` in production. The slot is reused with `generation + 1`.
- **Ownership.** The device owns GPU objects. The runtime/assets own CPU data. A handle may be destroyed only by its creator; destroying a texture still referenced by a live material is a contract error in dev (`E_STALE_HANDLE` on the material's next use) and leaves the material on fallback textures in production.
- **Disposal order at teardown** (00 §5.7): game dispose → scene/material/mesh/texture handles released → render targets → pipelines → shader modules → ring/staging buffers → swapchain unconfigure → `device.destroy()` → drop references. `dispose()` is idempotent, cancels in-flight readbacks, and makes all handles stale. It does not wait for the GPU; the browser handles completion.
- **CPU retention.** `retainCpuCopies` defaults to true for textures and meshes created at load. The device keeps a copy of vertex/index data and texture level bytes so it can rebuild after device loss. This roughly doubles CPU-side asset memory for GPU resources; spec 06 already retains decoded data, so the default is `false` when the runtime passes asset-library-owned buffers and `true` only for engine built-ins and small runtime-created resources. The policy is explicit in `TextureDesc.retainCpu` / `MeshDesc` creation options, never implicit.
- **Restore rebuild.** On `restore()`, the device re-creates adapter/device/swapchain, then rebuilds restorable handles lazily on first use from descriptors and retained CPU copies. Non-restorable handles (those explicitly created with `retainCpu: false`) become stale and their owners re-upload on `onRestored`. Pipeline and shader handles are always restorable from descriptors. External handle indices/generations stay stable across restore, so scene and game references remain valid; `destroy()` during the lost state marks the handle dead and it is not rebuilt.
- **Leak tracking (dev).** A counter table logs live texture/buffer/pipeline/handle counts on `dispose()` and on scene unload; survivors are named by label. The tracker is compiled out of production by `import.meta.env.DEV` and the size gate.

### 5.10 Error scopes and validation

Two layers, in this order:

1. **Synchronous JS validation** covers every descriptor: handle liveness, format/usage compatibility, limits, sizes, alignments, index ranges, material texture slots, pass target conflicts and uniform ring capacity. Failures throw `EngineError` with `E_CONTRACT`, `E_UNSUPPORTED_FEATURE`, `E_ASSET_FORMAT` or `E_ASSET_BUDGET` before any GPU call. This is where 99% of programmer errors surface, at load or first use.
2. **GPU error scopes** catch what only the driver can reject. Every create/upload is wrapped:

```ts
device.pushErrorScope("validation");
const texture = device.createTexture(desc);
const error = await device.popErrorScope();   // awaited only at load-time checkpoints
```

  The implementation pushes/pops around creation groups rather than per call, so a 500-texture load does not pay a microtask per texture. Scopes are balanced within a microtask turn; max depth 8. An error marks the just-created object dead, destroys it, increments `stats.gpuErrors`, and rejects the load with `E_BACKEND_INIT` (or `E_PIPELINE_COMPILE` for shader pipelines). The first 10 messages per session are logged with the label and a sanitized compiler message; the rest are counted only.

- `device.addEventListener("uncapturederror", ...)` is installed at init. An uncaptured error increments `gpuErrors`, logs once per 60 frames at most, and (above 100 in one frame) ends the frame without submit. It never throws into the game loop.
- Out-of-memory: clear the pipeline cache, sampler cache and bind-group cache, then retry the allocation once. A second failure is treated as `E_DEVICE_LOST` and routed to recovery.
- Development (`?debug=1`) includes the validation stack, descriptor label and first compiler lines. Production messages name the resource label and error code only. No message includes a token, room code, player name or full URL (00 §5.9).
- Shader compile failures are cached per pipeline key and never retried per frame. A failed pipeline draws nothing and increments `droppedDraws` once; the scene keeps rendering.
- `device.onSubmittedWorkDone()` is not awaited per frame. It is used only by tests and by `dispose()` when the caller explicitly requests a flush.

### 5.11 Device loss and recovery

States: `running → lost → restoring → running | failed`. The runtime loop is paused while not `running` (spec 01), so no draws race recovery.

1. **Detect.** `device.lost` resolves with `{ reason, message }`. `reason === "destroyed"` after our own `dispose()` is ignored. Otherwise: mark every handle `lost`, set all in-flight upload promises to rejected, stop accepting draws (`beginFrame()` returns invalid), clear per-frame ring state, emit `onDeviceLost` with a sanitized message.
2. **Notify.** `packages/runtime` receives the event, pauses the game loop, shows no UI at first (a one-frame freeze is normal), and calls `restore()` exactly once. The renderer does not retry on its own schedule; policy lives in the runtime.
3. **Restore.** Request adapter and device again with the same options/limits, reconfigure the swapchain, recreate the default sampler and fallbacks, reset the pipeline/shader/bind-group caches to descriptors, and mark restorable handles `pending`. Return `{ ok: true, restoredHandles, staleHandles }`. If adapter/device acquisition fails, return `{ ok: false, reason }` and leave the object disposed; the runtime falls back to WebGL2 (00 §5.12).
4. **Lazy rebuild.** The first draw using a pending handle rebuilds its GPU object from the retained descriptor and CPU copy, then marks it live. A non-restorable handle throws `E_STALE_HANDLE` to its owner; the owner re-creates it during `onRestored`. No rebuild happens during `restore()` itself, so recovery time is bounded by adapter/device creation, not scene size.
5. **Failure.** A second loss in the same session is not retried automatically: the runtime falls back to the next backend tier and shows the existing notice. `restore()` after a failed restore rejects with `E_DEVICE_LOST`.
6. **No partial save/state.** The renderer owns no game state. A half-submitted frame is discarded; the next valid frame redraws from the scene.

Recovery target: a forced loss on desktop Chrome recovers to the same scene within 2 s and never shows a black frame longer than one frame (acceptance ER-04-05). A recovery does not restart the game, reload assets from the network, or reset the simulation.

### 5.12 Camera and frustum culling

- The scene camera is owned by spec 03. The renderer receives a view-projection matrix through `setCamera` (or view/projection separately). It validates that all 16 floats are finite; a non-finite matrix is `E_CONTRACT` in dev, replaced by identity in production with `gpuErrors++`.
- Depth convention: engine-core `Mat4.perspective` produces **0..1 clip depth** (WebGPU). The WebGL2 backend (spec 05) applies its own -1..1 remap internally. The renderer's culling math uses whichever matrix it receives, so no convention leaks to games or the scene.
- Frustum extraction uses the Gribb-Hartmann method on the current view-projection matrix, in the same allocation-free style as today's `WebGL2Renderer.updateFrustum`. Six normalized planes are stored in a preallocated `Float32Array(24)`.
- Per-draw culling tests the mesh's model-space bounding sphere transformed by the draw transform: center transformed by the model matrix, radius multiplied by the maximum axis scale. A sphere fully outside any plane is culled. `drawInstanced` culls per instance only when `cullInstances: true` is explicitly passed; the default is group-level culling using a caller-supplied bounds sphere, because scanning 65,536 instances every frame is not free. The M0 5,000-cube scene relies on group-level culling (one instanced draw, one bounds test).
- Shadow passes cull against each cascade's light frustum, not the camera frustum. The same culler class is used with a different matrix.
- Culling is always on for the built-in path (PR-9.7). `culling: "none"` exists only for debug and benchmark comparisons; it is not exposed to games.
- Counters: `culledInstances` increments per culled draw or instance; a culled draw costs no encode and no uniform write. Culling happens before the uniform ring write, so culled objects do not consume ring slots.

### 5.13 Lighting and PBR

The built-in material is glTF metallic-roughness rendered with a Cook-Torrance GGX model:

- **Direct lights.** Up to 4 directional and 32 point lights in the uniform block (TV profile: 1 and 8; desktop high: 4 and 32). Directional `direction` is normalized world-space direction *toward* the light. Point lights use inverse-square falloff with a smooth radius cutoff to avoid a hard edge. Spot lights are M2; a spot is represented by a point light plus a game-side cone check until then.
- **BRDF.** GGX NDF with `alpha = roughness²`, Smith-Schlick height-correlated visibility, Schlick Fresnel (F0 from base colour and metallic). Diffuse is Lambert × `(1 - metallic)` × `(1 - F)`. Energy is not multiplied by an arbitrary PI; the shader uses the standard normalized form. `roughness` is clamped to `[0.04, 1]`, `metallic` to `[0, 1]`.
- **Ambient.** A flat ambient term from `FrameUniforms.ambient` plus a hemispherical sky/ground gradient derived from the same colour (ground = 0.35 × sky) in M1. Ambient occlusion multiplies only the ambient diffuse term. Image-based lighting (split-sum prefiltered environment) is M2 and feature-gated; it must not be required for correct M1 visuals.
- **Normal mapping.** Tangent-space normal map with `normalScale`; when a mesh has no tangents, the shader derives a tangent frame from screen-space derivatives (M1). `static-pbr-v1` does not carry tangents in ABI 1, so the derivative path is the default.
- **Alpha.** `opaque` writes depth and ignores alpha; `mask` discards below `alphaCutoff`; `blend` is rendered in the transparent pass with depth test on and depth write off, sorted back-to-front by the scene encoder. The renderer does not reorder draws.
- **Unlit.** `unlit: true` returns base colour × texture × tint, no lighting, no shadows; it still participates in depth and alpha rules.
- **Colour space.** Base-colour and emissive textures are sRGB; all lighting math is linear; the output is tonemapped and encoded to sRGB **exactly once**. The measured platform (Chrome 155) rejects `bgra8unorm-srgb` canvas formats and WebGL2 exposes no `EXT_sRGB_write_control`, so both backends perform the linear→sRGB encode at fragment output rather than relying on an sRGB swapchain; a preferred sRGB canvas format, if one ever appears, is refused with `E_BACKEND_INIT` to prevent double encoding (RV-76). Intermediate HDR targets are linear `rgba16float` (or `rgba8unorm` on Tier B low quality).
- **Determinism.** Lighting is a pure function of uniforms and textures; no time-based noise, no jitter, no TAA in v1. The same scene at the same camera produces the same pixels on the same adapter.

Point/directional light counts beyond the uniform capacity are dropped in submission order and counted; the scene encoder is expected to choose the most relevant lights before submitting.

### 5.14 Shadows

M1 target, directional only; point shadows are M2 and feature-gated.

- **Cascades.** 3 cascades desktop, 2 on TV/low, 0 when shadows are off. Split scheme: practical split with lambda 0.5, near = camera near, far = `min(camera far, shadowDistance)`; `shadowDistance` default 120 world units, configurable by the runtime. Cascade 0 gets the most resolution.
- **Atlas.** One `depth32float` texture, 2048×2048, split into four 1024×1024 tiles; three are used for cascades, the fourth is reserved for a future spot/point tile. A 4×4 grid at 512 would waste memory; a texture array would complicate WebGL2 parity, so the atlas is the v1 choice.
- **Matrices.** Each cascade uses a light-space orthographic projection fitted to the camera frustum slice, stabilized by texel snapping and a fixed up vector. The three light view-projections are uploaded in `LightUniforms.cascadeMatrix`.
- **Bias.** Slope-scaled depth bias (`1.5` constant, `2.0` slope for 32-bit depth), plus normal-offset of 2 texels. PCF 3×3 with a comparison sampler. Cascade blend over the last 10% of each split.
- **Pass.** One shadow pass per frame, recording three cascaded draws of all shadow casters before the main pass. Static shadow caching (re-render only when the light or casters move) is M2; M1 re-renders every frame, which is affordable at the 120-draw-call budget.
- **Cost control.** Shadow casters are a scene flag (`castShadow`); the scene encoder excludes them from the shadow list when the flag is absent. Shadow draw calls count toward `stats.shadowDrawCalls`, not `drawCalls`; the total of both is gated by the 120-draw budget.
- **Fallback.** When `shadowCascades === 0`, no shadow texture is created, the light uniform flags disable sampling, and the shader uses a constant ambient occlusion term. The material shader is the same (one pipeline), so switching quality never recompiles the scene shader.

### 5.15 Post-processing

M1 target, optional, and never required for correctness.

- **Scene target.** `rgba16float` when `float-render-target` is present, otherwise `rgba8unorm`; MSAA 4× when `msaa4` is present and quality is high, resolved to a single-sample texture. Depth is `depth24plus` (or `depth32float` for shadows).
- **Chain.** Scene → bloom (prefilter at 1.0 threshold, 5 mip levels, upsample with additive blend; strength 0.05 default) → tonemap (ACES fitted, exposure from `FrameUniforms.time.w`) → FXAA → swapchain. Each step is a fullscreen triangle with a cached pipeline. The chain ping-pongs between two `rgba16float` targets; the final pass writes the swapchain format.
- **Quality tiers.**
  - `high`: HDR, shadows 3, bloom, FXAA, anisotropy 4.
  - `medium`: HDR, shadows 2, bloom off, FXAA, anisotropy 2.
  - `low`: LDR `rgba8unorm`, shadows off, no bloom, FXAA, anisotropy 1.
  - `off`: direct swapchain, no post, no shadows; the M0 path.
- **Cost.** Post is at most 4 fullscreen passes at render resolution. At 1080p that is ~8.3 M fragments per pass; the budget assumes ≤ 3 ms total on the reference desktop GPU. A pass that would exceed the per-frame budget is skipped and counted, not allowed to drop the frame.
- **Resolution changes.** Render targets are recreated on backing-size change, debounced to one recreation per frame and skipped when the size change is ≤ 8 px in both dimensions (avoids thrash during a drag resize). Dynamic resolution (spec 01) changes the render size; the renderer recreates targets at the new size and keeps the CSS/swapchain size unchanged (the final blit upscales).
- **Not in v1:** TAA, motion blur, depth of field, SSAO, SSR, colour grading LUTs, HDR output. Each is a later spec; none is stubbed into the M1 chain.

### 5.16 LOD and instancing

**LOD.**

```ts
export interface LodEntry {
  readonly mesh: MeshHandle;
  readonly minScreenRadiusPx: number;   // switch up to this entry at or above this radius
}
export interface LodGroupDesc {
  readonly label: string;
  readonly entries: readonly LodEntry[]; // 1..4, descending thresholds
  readonly bounds: BoundingSphere;       // union bounds, model space
  readonly hysteresis?: number;          // default 0.1 (10%)
}
```

- Selection projects the bounding sphere through the view-projection matrix: `screenRadiusPx = radius * (0.5 * viewportHeight * proj[5]) / distance`. Entries are sorted richest-first; the renderer picks the first entry whose `minScreenRadiusPx` is ≤ the projected radius, with 10% hysteresis to prevent flicker at a boundary.
- The selection is cached per entity by the scene encoder (spec 03); the renderer exposes a pure `selectLod(group, viewProjection, viewportHeight, center, scale, previousIndex)` helper and does not query entities. `stats.lodCounts` counts draws per level.
- Instanced LOD is group-level: every instance in a `drawInstanced` call uses the same LOD, chosen from the group bounds. Per-instance LOD is M2.
- Shadow passes use the camera-selected LOD, not a separate shadow LOD, in M1.

**Instancing.**

- `drawInstanced(mesh, material, transforms, count)` packs 16 floats per instance into the instance vertex buffer ring and issues one `drawIndexedInstanced`. Counts above 65,536 throw `E_UNSUPPORTED_FEATURE` in dev and clamp with `droppedDraws++` in production.
- The instance ring is 4 MiB per in-flight frame (65,536 × 64 bytes = 4 MiB), written with `queue.writeBuffer` for ≤ 256 KiB batches and a staging copy above that. A batch larger than the remaining ring space is split into multiple draws, which still counts as one logical draw per split.
- Instance transforms are column-major; the shader multiplies the model matrix by the base mesh. Non-uniform scale is supported by the normal matrix computed on the CPU in the scene encoder; the renderer only validates finiteness.
- A repeated mesh below 10 instances is not automatically instanced by the renderer; the scene encoder decides (PR-9.6). The legacy `drawCube` adapter batches above 10 as today.

### 5.17 Readback and profiling hooks

- **Readback.** `readTexture` copies a subresource into a `MAP_READ` buffer and resolves with tightly packed RGBA8 bytes. It is asynchronous, allowed only outside the frame hot path, and gated by `?debug=1` or a benchmark flag. At most 4 readbacks in flight; a fifth rejects with `E_CONTRACT`. Formats other than RGBA8 reject with `E_UNSUPPORTED_FEATURE` in ABI 1.
- **Frame capture.** `captureFrame()` copies the swapchain texture after present into a readback buffer, flips rows to top-left origin, and resolves with `FrameCapture`. It is used by golden tests and the acceptance page; production builds reject it.
- **Timestamps.** When `timestamp-query` is present, the renderer owns a ring of 4 query sets (begin/end per pass), resolves them into a query-resolve buffer, maps asynchronously, and publishes `stats.gpuFrameMs` one frame later. Without the feature, `gpuFrameMs` is `null` and `supportsTimestamps` is false; no CPU timing is substituted for GPU time.
- **Debug groups.** With `?debug=1`, passes and draws use `pushDebugGroup`/`popDebugGroup` with labels (`shadow`, `scene`, `post:bloom`, material label). Production does not emit them.
- **Stats sampling.** The profiler (spec 16) reads `stats` once per second, never per frame, and copies numbers into its own ring. The renderer does not format strings per frame.
- **Overlay compatibility.** `textureMemoryMB` on the legacy surface is `stats.textureBytes / (1024 * 1024)`; `drawCalls` is `stats.drawCalls + stats.shadowDrawCalls`. This keeps the existing debug overlay and budgets working without a second accounting path.

### 5.18 Hot-path rules (no per-frame allocation)

The steady-state frame (`beginFrame` → draws → `endFrame`) allocates nothing:

- frame wrappers, pass encoders, uniform writes, culling planes, LOD scratch, instance packing and stats are preallocated at init or per in-flight slot;
- draw validation uses numeric handle fields, not object spread or closures;
- no `Array.prototype.map/filter/forEach`, no array literals, no string concatenation in a draw; labels are used only on errors and debug groups;
- the only allowed allocations are at creation/load, on a quality/resolution change, on device restore, and in debug-gated code;
- descriptor objects passed to `create*` may allocate; they never appear in a draw call.

Enforcement: spec 16's allocation benchmark, a heap-growth acceptance row (ER-04-08), and review. A new allocation in the frame path needs a comment explaining why it is not per-frame in practice.

### 5.19 How the contract stays WebGL2-compatible

Spec 05 implements the same contract. This package must not use a WebGPU-only capability in a way that cannot be emulated:

- Four bind groups and dynamic uniform offsets map to WebGL2 UBOs + `uniformBlockBinding`; the renderer does not use push constants.
- Instancing maps to vertex-attrib divisors; the instance buffer is a vertex buffer, not a storage buffer.
- No compute, storage texture or storage buffer in the M0/M1 path. Compute is optional and gated by `features`.
- Depth textures and comparison samplers are core WebGL2 (`WEBGL2` + `EXT_color_buffer_float` for float targets).
- The shadow atlas is one 2D depth texture, not a depth array, so WebGL2 needs no extension.
- Command recording is one submit per frame; WebGL2 has no explicit command buffers, so the backend translates the same sequence into immediate calls.
- Pipeline descriptors are backend-neutral state; spec 05 maps them to program + VAO + render state.
- The contract conformance suite (00 §8) runs against both backends with the same assertions: resize, create/destroy, draw counts, cap hit, device lost, dispose idempotence.

### 5.20 Quality tier selection

The runtime selects the tier (device profile + measured data), not the renderer:

| Tier | Renderer behavior |
|---|---|
| `high` | HDR, 3 cascades, bloom, FXAA, anisotropy 4, 4× MSAA when available |
| `medium` | HDR, 2 cascades, no bloom, FXAA, anisotropy 2, no MSAA |
| `low` | LDR, no shadows, no post, anisotropy 1, no MSAA |
| `off` | Direct swapchain, no shadows/post, no MSAA (M0 cube/2D path) |

A tier is a hint, not a promise: if a feature is absent, the renderer degrades within the tier and reports it in capabilities. A game that requires a feature declares it in its manifest; the runtime refuses early (00 §5.11). The renderer never upgrades quality on its own during play; dynamic resolution (spec 01) changes resolution, not tier.

---

## 6. File ownership

Canonical package path is `packages/engine/renderer-webgpu/**` (00 §5.3 and §6). An earlier work brief wrote `packages/renderer-webgpu/**`; that is shorthand for the same package and must not create a second one. This spec owns `docs/engine/04-renderer-webgpu.md` and the paths below. Package-local `package.json`, `tsconfig.json`, root workspace entry, tsconfig reference, Vitest project and eslint entries are integration-agent changes (00 §5.16), not feature-agent edits.

| Path | Contents |
|---|---|
| `packages/engine/renderer-webgpu/package.json` | private workspace package `@lanpad/engine-renderer-webgpu`; `"type": "module"`; exports `"."`; dependency `@lanpad/engine-core` only |
| `packages/engine/renderer-webgpu/tsconfig.json` | project reference to `engine-core`; DOM lib |
| `src/index.ts` | public entry: `WebGpuDevice`, `createWebGpuDevice`, ABI constants, contract re-exports |
| `src/errors.ts` | `EngineError` construction and sanitized messages |
| `src/device/**` | `adapter.ts`, `WebGpuDevice.ts`, `limits.ts`, `options.ts`, `deviceLost.ts`, `errorScope.ts` |
| `src/swapchain/**` | `Swapchain.ts` |
| `src/pipeline/**` | `ShaderCache.ts`, `PipelineCache.ts`, `PipelineLayout.ts` |
| `src/bindgroup/**` | `BindGroupCache.ts`, `FrameBindings.ts` |
| `src/buffer/**` | `BufferArena.ts`, `UniformRing.ts`, `UploadBelt.ts` |
| `src/texture/**` | `Texture.ts`, `Sampler.ts`, `TextureMemory.ts` |
| `src/mesh/**` | `Mesh.ts`, `LodGroup.ts` |
| `src/material/**` | `Material.ts`, `MaterialCache.ts` |
| `src/frame/**` | `FrameRecorder.ts`, `RenderTarget.ts`, `draw.ts` |
| `src/camera/**` | `CameraState.ts` |
| `src/culling/**` | `FrustumCuller.ts` |
| `src/instancing/**` | `InstanceWriter.ts` |
| `src/lod/**` | `LodSelector.ts` |
| `src/lights/**` | `LightSet.ts` |
| `src/shadows/**` | `ShadowAtlas.ts` |
| `src/post/**` | `PostChain.ts` |
| `src/profile/**` | `Stats.ts`, `GpuTimer.ts`, `Readback.ts` |
| `src/shaders/**` | `pbr.wgsl.ts`, `shadow.wgsl.ts`, `fullscreen.wgsl.ts`, `common.wgsl.ts` |
| `src/compat/**` | helpers used by the runtime's `LegacyGameRendererAdapter` |
| `test/**` | unit, property, golden, fake-device conformance and boundary tests |
| `test/fixtures/**` | fixtures listed in §8 |
| `docs/engine/04-renderer-webgpu.d.ts` | frozen contract mirror required by README §7.1; created at contract freeze and type-equality-tested against `engine-core/src/render/contract.ts` |

**Contract ownership.** `packages/engine/core/src/render/contract.ts` is authored by 00 for M0 and owned by 04 after M0 (00 §3.1, §6). This backend implements it; a backend wave does not edit it. The frozen `.d.ts` beside this spec is a mirror, not a second source of truth: a type-equality test fails if the mirror and the contract file diverge.

**Not owned by this spec:**

- `packages/engine/core/src/render/contract.ts` — 00 until the M0 handoff, then 04; never edited by an implementation wave without a contract revision.
- `packages/engine/core/src/scene/**` — 03. The renderer consumes a draw list; it does not own the scene, camera entity or culling policy inputs.
- `packages/engine/renderer-webgl2/**` — 05. The two backends are siblings and neither imports the other (00 D9).
- `packages/engine/assets/**` — 06. Decoded meshes and texture levels arrive as `MeshDesc`/`TextureLevel[]`; this package parses no GLB, KTX2 or WebP.
- `packages/runtime/src/render/**` and `src/compat/**` — the integration agent owns `selectRenderer.ts`, `LegacyGameRendererAdapter` and the migration of the existing WebGL2/Canvas2D renderers (00 §5.13, §6). This package must not edit runtime files.
- `experiments/e-m0-engine/**` and `golden/` — 19. The M0 page, measurement harness and golden-image encoding are not owned here.
- `docs/RESULTS.md` — measurements only, written by whoever runs the device.
- `sdk/**` — the additive game-facing `RendererCapabilities` shape is owned by 18.
- Root `package.json`, `tsconfig.json`, `eslint.config.js`, Vitest config — integration agent.

**One writer per file.** A wave that needs two agents in this package splits by file (for example `device/**` + `swapchain/**` versus `pipeline/**` + `shaders/**`), never by "renderer area". The shared conformance suite is not duplicated per backend: it lives once at `packages/engine/core/test/contract/renderDevice.conformance.test.ts` (00 §8) and both 04 and 05 run it.

---

## 7. Acceptance

Every row carries an `ER-04-NN` ID. Tests and manual records reference the ID; the integration agent adds the matching `docs/todos/TRACEABILITY.md` rows in the same change that lands the first tagged test. **Evidence state is PENDING until a run exists**; no row is claimed from this document. "M0/M1/M2" in the milestone column follows §5.14 and Appendix B; an M0 row must not depend on an M1/M2 feature.

| ID | Milestone | Criterion | Fixture / method | Hardware / run | Evidence state |
|---|---|---|---|---|---|
| ER-04-01 | M0 | A lit, textured cube at 1920×1080 CSS, DPR 1, with one directional light and ambient renders the golden capture at frame 60 within tolerance; ≤ **8** draw calls, **12** triangles, no WebGPU validation error; `stats.textureBytes` reports the cube texture | Appendix A cube fixture; `experiments/e-m0-engine/?scene=cube&backend=webgpu&bench=1`; golden owned by 19 | `pc-win11-rtx3050`, Windows 11 10.0.26300, Chrome 155; adapter name recorded | PENDING — needs implementation and the M0 page |
| ER-04-02 | M0 | M0 scene (5,000 instanced textured cubes, one directional light, 1920×1080 CSS, DPR 1, 600 measured frames after 120 warm-up): frame p95 ≤ **14 ms** (hard fail **20 ms**), draw calls ≤ **120**, `textureBytes` ≤ **128 MiB**; p50/p95/max, adapter, browser and build hash recorded | Appendix A scene fixture; `experiments/e-m0-engine/?scene=scene5000&backend=webgpu&bench=1` | `pc-win11-rtx3050`, Windows 11 10.0.26300, Chrome 155 | **PASS 2026-10-23** — headless Chrome 155, `nvidia ampere`, p50 9.2 / p95 10.1 / max 10.2 ms, 1 draw, 60,000 triangles, 8,295,680 texture bytes, 0 GPU errors, build `bed149c4…`; see `docs/RESULTS.md` |
| ER-04-03 | M0 | Creating the same pipeline descriptor twice returns the same handle and increments `pipelineCacheHits`; a failed compile is cached and not retried; no pipeline is created between `beginFrame` and `endFrame` in steady state; live pipelines ≤ **256** | `test/pipelineCache.test.ts` + `test/fixtures/pipeline-keys.json` | CI Node 20 (fake device) + Chrome 155 | PENDING — first implementation wave |
| ER-04-04 | M0 | Every handle kind creates and destroys; `textureBytes` and `bufferBytes` return to their pre-create values; double `dispose()` is a no-op; a stale handle throws `E_STALE_HANDLE` in dev and is a counted no-op in production; the dev leak tracker reports zero survivors after scene unload | `test/resources.test.ts` with a fake device; browser `?scene=cube&dispose=1` | CI Node 20 + Chrome 155 | PENDING — first implementation wave |
| ER-04-05 | M0 | A forced device loss recovers to the same scene in ≤ **2 s** and ≤ **60 frames**; no black frame longer than one frame; handle indices/generations stay valid; no asset refetch and no game restart; a second loss in the session falls back instead of retrying forever | Dev-only `__test_forceDeviceLost()` hook (compiled out of production) or `chrome://gpucrash`; page `?deviceloss=1`; frame timestamps around the loss | `pc-win11-rtx3050`, Windows 11, Chrome 155 | PENDING — needs the recovery path and the page |
| ER-04-06 | M0 | Ten `resize()` calls in one frame cause at most **one** `context.configure()`; `size` is CSS pixels and zero before the first resize; a zero-size surface returns an invalid frame and performs no GPU work; DPR changes update the backing store; `maxRenderHeight` caps backing height only | `test/swapchain.test.ts` + browser `?scene=cube&resize=1`; configure counter exposed in dev | CI Node 20 + Chrome 155 | PENDING — first implementation wave |
| ER-04-07 | M0 | An invalid descriptor throws synchronously before a GPU call; an injected GPU validation error is captured by a balanced error scope, destroys the just-created object, increments `gpuErrors` and rejects the load; an uncaptured error never throws into the loop and, above **100** in one frame, ends the frame without submit | `test/errorScope.test.ts` with injected invalid descriptors; browser injection page | CI Node 20 + Chrome 155 | PENDING — first implementation wave |
| ER-04-08 | M0 | Steady-state heap growth ≤ **512 KiB** over 480 frames after 120 warm-up frames; no allocation site in `beginFrame`/`draw`/`endFrame` appears in the allocation profile | `experiments/e-m0-engine/?scene=scene5000&backend=webgpu&bench=1&alloc=1`; `performance.memory` | `pc-win11-rtx3050`, Chrome 155 | PENDING — needs the M0 page |
| ER-04-09 | M0 | WebGPU and WebGL2 frames at tick 300 differ by ≤ **2%** of pixels by more than **8/255** in any channel | Shared golden capture with 05 ER-05-04; `experiments/e-m0-engine/golden/`; 19 owns the encoder | `pc-win11-rtx3050`, Chrome 155 | PENDING — needs both backends and the goldens |
| ER-04-10 | M0 | Sphere-frustum culling matches the reference set on the fixture; culled draws consume no uniform-ring slot; one **65,536**-instance draw succeeds; 65,537 throws `E_UNSUPPORTED_FEATURE` in dev and clamps with `droppedDraws` in production; a batch larger than remaining ring space splits with correct per-split counts | `test/fixtures/culling-cases.json`, `test/fixtures/instance-batches.json`; `test/culling.test.ts`, `test/instancing.test.ts` | CI Node 20 + Chrome 155 | PENDING — first implementation wave |
| ER-04-11 | M0/M1 | **M0:** an opaque `unlit` material samples base colour × tint, selects a cached `builtin-unlit` pipeline and renders the cube fixture. **M1:** the full material fixture (opaque, mask, blend, unlit, double-sided; base colour, metallic-roughness, normal, occlusion, emissive) renders golden images within tolerance; 4 directional + 32 point lights pack correctly; lights beyond capacity are dropped in submission order and counted; roughness/metallic clamp | `test/fixtures/material-cases.json`; `experiments/e-m0-engine/?scene=pbr&quality=high` | `pc-win11-rtx3050`, Chrome 155 | M0 unlit: real cube page, 2026-10-23. M1: PENDING — fixture authored with the implementation |
| ER-04-12 | M1 | `cascades=3`: atlas **2048×2048** `depth32float`, three **1024²** tiles, texel-snapped matrices, PCF 3×3; `shadowDrawCalls` counted separately and `drawCalls + shadowDrawCalls ≤ 120`; `cascades=0` creates no shadow texture and uses the same scene pipeline; switching 3/2/0 does not recompile the scene shader | `experiments/e-m0-engine/?scene=shadows&cascades=3`; `test/fixtures/shadow-cascades.json` | `pc-win11-rtx3050`, Chrome 155 | PENDING — M1 |
| ER-04-13 | M1 | At 1080p the post chain is ≤ **4** fullscreen passes and ≤ **3 ms** p95 on the reference desktop; a pass that would exceed the per-frame budget is skipped and counted; `high`/`medium`/`low`/`off` produce the §5.15 chains | `experiments/e-m0-engine/?scene=post&quality=high`; pass timer from timestamp queries or CPU bracket | `pc-win11-rtx3050`, Chrome 155 | PENDING — M1; 3 ms is a design target, not a measurement |
| ER-04-14 | M1 | Projected-radius LOD selection matches `lod-cases.json`; 10% hysteresis prevents a switch across a 100-frame boundary sweep; `lodCounts` sums to the visible draw count; an instanced draw uses one group-level LOD | `test/fixtures/lod-cases.json`; `test/lodSelector.test.ts`; browser sweep | CI Node 20 + Chrome 155 | PENDING — M1 |
| ER-04-15 | M0 | `readTexture` returns tightly packed top-left RGBA8 bytes matching the golden fixture; `captureFrame` matches within tolerance; production rejects both with `E_UNSUPPORTED_FEATURE`; a fifth in-flight readback rejects with `E_CONTRACT`; with `timestamp-query` `gpuFrameMs` is published one frame later, and without it `gpuFrameMs` is `null` and `supportsTimestamps` is false | `test/readback.test.ts`; `test/fixtures/readback-rgba8.json`; `?scene=cube&readback=1` | CI Node 20 + Chrome 155 | PENDING — first implementation wave |
| ER-04-16 | M0 | No WebGPU or DOM type appears in a game-facing type; the SDK structural `RendererCapabilities` and the engine type pass a compile-time assignability test; the package imports only `@lanpad/engine-core`; zero third-party runtime dependencies; package gzip size recorded and host + demo ≤ **5 MB gz** | `npm run typecheck`, `npm run size`, `test/boundaries.test.ts` | CI Node 20 | PENDING — first implementation wave |
| ER-04-17 | M0 | The shared renderer conformance suite (00 §8) passes against the WebGPU device with a fake `GPUDevice` in CI and the real device in the browser: capability report, resize, create/destroy for every kind, draw counts, stale handles, dispose idempotence | `packages/engine/core/test/contract/renderDevice.conformance.test.ts` + `packages/engine/renderer-webgpu/test/fakes/` | CI Node 20 + Chrome 155 | PENDING — needs the shared suite |
| ER-04-18 | TV | If a TV browser exposes `navigator.gpu`, the M0 scene runs at 1920×1080 with `tvProfile=1` and records p95, adapter, resolution and texture bytes; **no WebGPU on TV is a PASS for the WebGL2 tier (05 ER-05-13), not a failure of this spec** | Same page, `?scene=scene5000&backend=webgpu&tvProfile=1` | **PENDING device:** a 2020-era Android TV Chromium and a Tizen/webOS set from SPEC §12 | PENDING — no TV hardware in this repo |

Threshold sources: 14 ms target and 20 ms hard fail from SPEC §11; 120 draw calls from PR-9.1; 128 MB texture memory from PR-9.2 (provisional per `docs/BUDGETS.md`); 5 MB gz from NR-6.1; 2%/8-255 parity and 512 KiB heap from 00 §7. The 3 ms post budget is this spec's design target, not a measurement. Do not copy any threshold into `docs/RESULTS.md` as a result.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | Adapter/limit negotiation, options normalization, swapchain resize/zero-size rules, pipeline-key construction, shader-module validation, handle generations, uniform-ring allocation, upload-belt thresholds, texture accounting, material validation, culling math, LOD selection, stats counters, error-scope balance | `packages/engine/renderer-webgpu/test/*.test.ts` |
| Property (`fast-check`) | Resize sequences never produce a backing size outside limits; pipeline keys are stable across equivalent descriptor construction order; handle generations never repeat; ring offsets are aligned and never overlap live frames; culling never rejects a sphere intersecting the frustum; instance split sums equal the requested count; texture accounting returns to zero after create/destroy pairs | `test/*.property.test.ts` |
| Golden | ABI 1 uniform offsets and bytes; pipeline keys; culling case sets; LOD threshold cases; instance-batch split counts; readback RGBA8 bytes | `test/golden/`, `test/fixtures/` |
| Conformance | The 00 §8 shared suite run against WebGPU: capability report, resize, create/destroy for every kind, draw counts, stale handles, device-loss path, dispose idempotence; CI uses a recording fake `GPUDevice`, the browser uses the real device | `packages/engine/core/test/contract/` + `packages/engine/renderer-webgpu/test/fakes/` |
| Integration | Runtime selection: WebGPU ok → WebGPU; WebGPU adapter/device failure → WebGL2; required feature missing → refusal before `game.init`; device loss → pause → restore or fallback; `LegacyGameRendererAdapter.drawCube` batching above 10; both reference games unchanged | `packages/runtime/test/integration/rendererFallback.test.ts`, `engineBoot.test.ts` (integration agent) |
| Browser benchmark | Cube fixture, 5,000-instance scene, PBR material grid, shadow scene, post scene; p50/p95/max, draw calls, triangles, instances, texture bytes, pipeline misses, heap growth, device losses | `experiments/e-m0-engine/?backend=webgpu&bench=1` (19 owns the page) |
| Manual | Real GPU adapter matrix, TV WebGPU if present, 10-minute device-loss soak, legibility of the failure screen | `docs/RESULTS.md` |

Fixtures owned by this spec (small, synthetic, checked in):

| Fixture | Purpose |
|---|---|
| `test/fixtures/pipeline-keys.json` | Descriptor → expected canonical pipeline key and cache-hit behaviour, including each state bit |
| `test/fixtures/layout-abi.json` | ABI 1 vertex strides/offsets, uniform block sizes and field offsets |
| `test/fixtures/culling-cases.json` | Bounding sphere + view-projection → expected culled/visible set, including tangent and behind-camera cases |
| `test/fixtures/instance-batches.json` | Instance counts around ring capacity → expected split draw counts and dropped-count behaviour |
| `test/fixtures/material-cases.json` | Material descriptors and expected validation results (valid, missing texture fallback, wrong colour space, clamp values) |
| `test/fixtures/shadow-cascades.json` | Camera/light inputs → expected split distances and cascade matrices for 0/2/3 cascades within 1e-4; no shadow texture at 0 |
| `test/fixtures/lod-cases.json` | Projected radius sequences → expected LOD index with and without hysteresis |
| `test/fixtures/readback-rgba8.json` | Small synthetic image → expected top-left-origin RGBA8 bytes |
| `test/fixtures/draw-list.json` | Mesh/material/transform sequence → expected draw calls, pipeline switches and bind-group switches after validation |

Test rules:

- Every test title carries its `ER-04-NN` ID or a leading `// @req ER-04-NN`; the ID must resolve to a traceability row once the engine programme is registered there.
- CI cannot create a real WebGPU device. It runs the pure logic and the shared conformance suite against a hand-written fake `GPUDevice` recorder. Real GPU work runs in the browser page and reports `window.__M0_BENCH__`; no real-GPU claim is asserted from Node.
- No fixed sleeps. Device-loss and upload tests wait on promises, counters or events with an explicit timeout.
- Image comparisons use the 00 §7 tolerance (≤ 2% of pixels differ by more than 8/255 in any channel). Byte fixtures (uniform blocks, readback of a synthetic target) are exact.
- Performance tests report p50, p95, max, frame count, warm-up count, adapter, browser version, build hash, CSS size and DPR. A number without those fields is not evidence.
- Tests assert facts (offsets, counts, feature presence), never a vendor string that changes with a driver update. Adapter strings are recorded in `docs/RESULTS.md` only.
- A test is never skipped or weakened to land a wave. A hardware row that cannot run in CI is covered by the browser page and a recorded manual result.
- The device-loss test hook exists only in dev builds; a production-bundle check asserts the hook is absent.

---

## 9. Dependencies

**Spec order**

| Dependency | Why | State |
|---|---|---|
| `00-architecture.md` | Layer map, `RenderDevice` contract scaffold, tiers, fallback chain, error taxonomy, migration, file ownership | Written |
| `01-core-loop-time.md` | `EngineFrame`, pause-on-loss ownership, frame statistics and the 60 Hz loop | Written |
| `02-math.md` | `Mat4`, `Vec3`, frustum/plane math, `BoundingSphere` helpers | Written |
| `03-scene-ecs.md` | Scene, transforms, camera, draw-list and culling inputs | written |
| `05-renderer-webgl2.md` | WebGL2 parity backend; consumes this contract and the shared conformance suite | Written in this wave |
| `06-assets.md` | Decoded mesh/texture levels, GLB/KTX2/WebP variants, `AssetHandle` lifetime | written |
| `16-tooling-profiler.md` | Consumes `RenderStats` and `gpuFrameMs`; owns the profiler overlay | Written |
| `18-game-sdk.md` | Additive `renderer.capabilities` shape for games | written |
| `19-testing-benchmarks.md` | M0 benchmark page, golden-image encoding, parity harness, `window.__M0_BENCH__` | written |

**Package prerequisites**

- Runtime dependency: `@lanpad/engine-core` only (00 D2/D9). No import of `engine-renderer-webgl2`, `engine-assets`, `protocol`, `sdk`, `runtime`, `controller` or a game.
- `engine-core` must ship: `Mat4`/`Vec3`/frustum helpers, the `RenderDevice`/`RenderFrame` contract, generational `GpuHandle`, `EngineError` codes, frame statistics and the resolution controller. If a name in §3 differs from the contract file, the contract file wins and this spec is updated in the same change.
- `engine-assets` must deliver decoded `MeshDesc` and `TextureLevel[]` values. This package never parses GLB, KTX2, WebP or PNG.
- The runtime composition root owns backend selection (`selectRenderer.ts`), the legacy adapter and the retry/fallback policy. This package never imports or edits the runtime.
- Browser floor: Chromium 155 on Windows 11 is the provisional evidence target (00 §5.11). Firefox WebGPU is best-effort; Safari hosts are out of scope; Safari phones remain controllers.
- Build: zero third-party runtime dependencies. WGSL sources are TypeScript template strings bundled by Vite; no shader fetch, loader plugin or CSP change is required.

**Paper-trail prerequisites**

- Amendment **A14** (browser-native engine reframe) recorded in `docs/todos/README.md` before any WebGPU implementation code merges (00 preamble).
- `docs/engine/04-renderer-webgpu.d.ts` frozen mirror created and type-equality-tested against `packages/engine/core/src/render/contract.ts` before implementation (README §7.1).
- `RENDERER_ABI_VERSION`, `SHADER_ABI_VERSION` and `PIPELINE_CACHE_VERSION` registered in 00 §4.1 in the first implementing change; they are owned here but not yet listed there.
- `docs/todos/TRACEABILITY.md` rows for ER-04-01..18 added with the first tagged test.
- `docs/RESULTS.md` rows only after real runs, with date, build, browser, adapter and numbers. `docs/BUDGETS.md` remains the single source for the 14/20 ms, 120 draw-call, 128 MB and 5 MB gz thresholds; this spec must not grow a second budget table.
- `docs/ENGINE.md` and `docs/engine/README.md` updated when implementation status changes; this spec is not evidence of implementation.

**External dependencies:** none. No Three.js, Babylon, Pixi, naga, gl-matrix or other renderer/math runtime package enters this package.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | WebGPU drivers on Windows/TV are immature: validation errors, hangs, device loss | Medium | M0 demo unstable, lost time | Error scopes around every creation group, one automatic restore, WebGL2 fallback, shared conformance suite, pin the Chrome version used for evidence |
| R2 | Contract drift between 00, 04 and 05 (field names, feature semantics) | High if unmanaged | Rework across two backends | One contract file in `engine-core`, a `.d.ts` mirror with a type-equality test, one shared conformance suite, spec 05 consumes rather than redefines |
| R3 | The 5,000-instance scene misses the 14 ms p95 at 1080p | Medium | M0 acceptance fails | One instanced draw, group-level culling, preallocated ring buffers, measure early; dynamic resolution floor 60% from spec 01; record the true p95 rather than relaxing the row |
| R4 | Device-loss recovery loops or leaves a black frame | Medium | Frozen page, lost session | One retry, descriptor-based lazy rebuild, no asset refetch, fallback tier after a second loss, 2 s/60-frame acceptance row, 10-minute soak |
| R5 | Per-frame allocation creeps into the draw path | High over time | GC pauses, frame spikes on TV | Preallocated frame wrappers/rings/scratch, allocation benchmark ER-04-08, review rule in §5.18, no `map`/`filter`/closures per draw |
| R6 | Pipeline, material or bind-group churn dominates CPU time | Medium | Missed frame budget on draw-heavy scenes | Pipeline cache keyed by full state, material bind-group cache, 256/4,096 bounds, scene sorts by pipeline/material, `pipelineSwitches`/`bindGroupSwitches` counters |
| R7 | Object-uniform ring exhaustion at high draw counts | Medium | Dropped draws, visual holes | 8,192-object cap per frame, `droppedDraws` counter, 120-draw-call budget, scene encoder batches by mesh/material before submission |
| R8 | Texture memory exceeds the provisional 128 MiB on TV | High until measured | Allocation failure or context loss | KTX2/compressed variants from spec 06, supplied mip chains, per-subresource accounting, 100% warning, absolute limit throws before allocation; budget stays provisional (`docs/BUDGETS.md`) |
| R9 | LOD switching flickers at a threshold | Low–Medium | Visible popping | 10% hysteresis, pure selection function, golden sweep, per-entity previous-index cache; instanced LOD is group-level in M1 |
| R10 | Shadow cascades push the total draw count past 120 | Medium | Budget breach | `shadowDrawCalls` counted separately and added to the gate; caster flag; cascades 0 on TV and low tier; static shadow caching is M2 |
| R11 | Post-processing cost or driver behaviour varies widely | Medium | Frame spikes, inconsistent look | ≤ 4 fullscreen passes, ≤ 3 ms budget with pass skipping, quality tiers, LDR fallback without `float-render-target` |
| R12 | A TV has no WebGPU and a game requires it | High for TV WebGPU | The game cannot run there | WebGL2 is a first-class Tier B; required features refused before `game.init`; TV WebGPU row is PENDING and its absence is a pass for Tier B, not a claim |
| R13 | Canvas texture readback/capture is unsupported for the preferred format | Medium | Goldens cannot be captured from the swapchain | Configure the swapchain with `COPY_SRC`; capture through an offscreen target when the canvas format lacks it; readback is dev/benchmark-only and rejects with `E_UNSUPPORTED_FEATURE` |
| R14 | WebGPU or DOM types leak into `sdk`, the controller bundle or games | Medium | Controller size breach, backend lock-in | Game-facing types are structural and backend-neutral; compile-time assignability test; `sdk` stays zero-dependency; boundary test on imports |
| R15 | Timestamp queries are blocked or unreliable | Medium | No GPU frame time | `gpuFrameMs` is `null` and `supportsTimestamps` is false; never substitute a CPU estimate for GPU time; the profiler shows CPU frame time only |
| R16 | Error scopes add microtask overhead during asset load | Low–Medium | Slow boot | Scopes wrap creation groups, not individual calls; maximal depth 8; pop awaited only at load checkpoints |
| R17 | The renderer package inflates the host bundle past 5 MB gz | Low–Medium | Gate failure, slow TV boot | Zero runtime deps, WGSL as small TS strings, code splitting per backend, package size recorded every wave, host + demo hard cap 5 MB gz |

---

## Appendix A — M0 acceptance fixtures

The two fixtures below are the only scenes ER-04-01/02/08/09 may cite. They are deterministic: no random placement, no time-dependent animation, no post, no shadows. Spec 19 owns the page and golden encoding; this appendix owns the scene parameters.

### A.1 Cube fixture (`?scene=cube`)

| Parameter | Value |
|---|---|
| Canvas | 1920×1080 CSS, DPR 1, backing store 1920×1080 for acceptance; the smoke page uses 640×360 |
| Camera | Perspective, vertical FOV 45°, near 0.1, far 100, position `(-1.15, -0.95, -2.2)`, target `(0, 0, 0)`, up `+Y` |
| Geometry | 1.1-unit cube centred at origin (half-extent 0.55): 24 vertices, 36 `uint16` indices, stride 32 B (`position float32x3`, `normal float32x3`, `uv float32x2`), bounding radius `√3 × 0.55` |
| Material | Base-colour texture 4×4 sRGB checker (light `236,226,200,255`; dark `96,58,34,255`); metallic 0, roughness 0.62; opaque |
| Light | One directional light toward normalized `(-0.45, -0.8, -0.35)`, white, intensity 1.0; ambient `(0.18, 0.18, 0.18, 1.0)` |
| Passes | Direct swapchain; clear colour from §3.3; no shadow, no post |
| Capture | Frame 60 after 30 warm-up frames; golden comparison tolerance ≤ 2% of pixels differing by more than 8/255 |
| Expected stats | `drawCalls ≤ 8`, `triangles = 12`, `instances = 1`, `textureBytes ≤ 1 MiB`, `gpuErrors = 0` |

### A.2 Scene fixture (`?scene=scene5000`)

| Parameter | Value |
|---|---|
| Canvas / light / material | Same as A.1 |
| Camera | Perspective, vertical FOV 60°, near 0.1, far 500, position `(0, 70, 140)`, target `(0, 0, 0)`, up `+Y`; the whole grid is inside the frustum at frame 1 |
| Instances | 5,000 unit cubes in a deterministic 50×100 grid on the XZ plane, 1.5 m spacing, each centred at `y = 0.5`, `rotationY = (i × 0.37) mod 2π` |
| Submission | One `drawInstanced` call with 5,000 column-major transforms, one mesh, one material |
| Passes | Direct swapchain; clear; no shadow, no post |
| Measurement | 120 warm-up frames, 600 measured frames; wall-clock `requestAnimationFrame` interval; report p50, p95, max, frame count, adapter, browser, build hash, CSS size and DPR |
| Expected stats | `drawCalls = 1`, `instances = 5000`, `triangles = 60,000`, `textureBytes ≤ 12 MiB` (includes the 1920×1080 depth attachment; content textures ≤ 1 MiB), `gpuErrors = 0` |
| Budget | frame p95 ≤ 14 ms (hard fail 20 ms), `drawCalls ≤ 120`, `textureBytes ≤ 128 MiB` |

A run that cannot produce the adapter, browser version, build hash, CSS size and DPR is not evidence and must not be entered in `docs/RESULTS.md`.

---

## Appendix B — Milestone boundary for this backend

| Milestone | Included | Explicitly not included |
|---|---|---|
| **M0** | Adapter/device/swapchain, pipeline and shader caches, sampler cache, buffers and upload belt, textures, meshes, materials (including opaque unlit), frame recorder, camera, frustum culling, instancing, one directional light + ambient, legacy adapter support, error scopes, device-loss recovery, stats, readback/capture, GPU timestamps when available, shared conformance | PBR multi-texture materials, shadows, post, LOD groups, IBL, compute, skinning, morph targets |
| **M1** | Metallic-roughness PBR with base colour, metallic-roughness, normal, occlusion and emissive maps; 4 directional + 32 point lights; cascaded shadows 3/2/0; LOD groups and selection; the §5.15 post chain (optional, and skippable per frame) | IBL, point/spot shadows, per-instance LOD, static shadow caching |
| **M2** | IBL, spot/point shadows, per-instance LOD, static shadow caching, `generateMips`, optional compute paths behind `features` | GPU-driven culling, ray queries, mesh shaders, variable-rate shading |
| **M3** | Content-scale tuning; GPU culling and particles only if a measured game need justifies them | Any contract change without an engine major plus an amendment |

A feature added to an earlier milestone than its row is scope creep. M0 acceptance must not depend on an M1/M2 feature, and a later milestone must not change the M0 contract.

---

## Appendix C — ABI 1 pipeline state defaults

Unless a descriptor overrides them, built-in pipelines use these states. A change to any row is an `RENDERER_ABI_VERSION` bump.

| State | Opaque / mask | Blend | Shadow (M1) | Post (M1) |
|---|---|---|---|---|
| Topology | `triangle-list` | `triangle-list` | `triangle-list` | `triangle-list` |
| Cull mode | `back`, front face CCW; `none` when `doubleSided` | `none` | `back` | `none` |
| Depth format | `depth24plus` | `depth24plus` | `depth32float` | `none` |
| Depth compare | `less` | `less` | `less-equal` | — |
| Depth write | on | off | on | — |
| Blend | off | src-alpha / one-minus-src-alpha, add | off | off (fullscreen) |
| Sample count | 1 (M0); 1 or 4 (M1) | 1 | 1 | 1 |
| Colour format | preferred canvas format | preferred canvas format | none | `rgba16float` or `rgba8unorm`; final pass = canvas format |
| Vertex layout | `static-pbr-v1` or `instanced-transform-v1` | same | same | fullscreen triangle, no vertex buffer |
| Index format | `uint16` ≤ 65,535 vertices, else `uint32` | same | same | none |

Alpha-to-coverage, wireframe, polygon offset, stencil and conservative raster are off in ABI 1. A descriptor that requests an unsupported state combination fails `E_UNSUPPORTED_FEATURE` at pipeline creation, never at draw.

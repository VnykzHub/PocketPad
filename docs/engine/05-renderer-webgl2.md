# 05 — WebGL2 Renderer (Tier B)

**Status:** authoritative target contract for `@lanpad/engine-renderer-webgl2` and its `./canvas2d` entry. **No implementation exists in this tree yet:** `packages/engine/` does not exist as of 2026-10-22. This spec defines what to build; it claims nothing about code or measurements.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product/protocol contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) for the programme rules, [`docs/engine/00-architecture.md`](00-architecture.md) for package boundaries and the `RenderDevice` contract. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded.
**Contract ownership:** the backend-neutral types (`RenderDevice`, `RenderFrame`, `Surface`, `DeviceLimits`, `TextureDesc`, `BufferDesc`, `MeshDesc`, `MaterialDesc`, `PipelineDesc`, `RenderStats` and the GPU handles) are owned by spec `04-renderer-webgpu.md`. This spec implements them and must not redefine them. Where this document restates a field, it is the WebGL2 conformance profile, not a second contract; a mismatch is resolved in 04 and this spec's mapping tables are updated in the same change.
**Programme conflict:** `SPEC.md` v0.3 calls WebGPU a non-goal (§2) and names Three.js as the 3D candidate (§6.2). The engine programme's later decision is the opposite: custom WebGPU-first with this WebGL2 fallback, no Three.js (see 00 §0). Record amendment **A14** before backend code merges. This spec follows the programme decision.

---

## 1. Goal

WebGL2 is the backend that makes the engine's "any browser" claim true. WebGPU is Tier A and is the quality target; WebGL2 is Tier B and is the **primary TV backend** for v1, because the TV browsers in `SPEC.md` §12 expose WebGL2 and not WebGPU. TV is one target, not the product boundary (A14). Without a first-class WebGL2 implementation, every TV is a failure screen.

This spec has one player-visible goal and one engineering goal.

**Player-visible goal (M0).** The same textured, lit 3D scene runs at 1920×1080 CSS through WebGL2 on `pc-win11-rtx3050` (Desktop Chrome 155, Windows 11), with the same simulation, input and game logic as the WebGPU path. A 2D game runs through the `./canvas2d` entry with visuals matching the current Canvas2D backend. A 3D game on a device with no usable 3D backend shows a clear, remote-operable failure screen — never a black canvas, never a silent Canvas2D 3D substitute.

**Engineering goal.** One `RenderDevice` contract, one conformance suite, one feature vocabulary. Game code never branches on `backend` and never imports this package. Quality differences are expressed only through `renderer.capabilities` features, so the same game degrades predictably instead of failing.

**What "first-class" means here.** The package is not a stub or a "good enough" path. It owns: capability probing and tier classification, device and frame lifecycle, resource creation and destruction, pipeline compilation and caching, upload budgeting, context-loss recovery, per-draw frustum culling (04 §5.4), the Canvas2D 2D entry, and the WebGL2 half of the failure-screen contract. It does not own scene traversal, draw ordering/batching policy, animation sampling or game decisions.

---

## 2. Non-goals

- **Not a WebGPU emulator.** There is no emulation of compute shaders, storage buffers, indirect draws, timestamp queries, bindless resources or large bind groups. Features that need those run a CPU path or are refused early when the game declares them required.
- **Not pixel-identical to WebGPU.** The contract promises the same game, same input, same simulation and a measured lower quality tier — not identical pixels or identical frame time (00 §5.12).
- **Not a 3D Canvas2D renderer.** `./canvas2d` is 2D-only. A 3D game is refused on Tier C with `E_UNSUPPORTED_FEATURE`; the old "draw a cube as a rotating square" compatibility path is not part of the engine contract.
- **No Three.js, Babylon, Pixi, regl or any third-party runtime dependency.** Zero runtime dependencies in the package; every line is owned here.
- **No PBR, shadows or post-processing in M0.** M0 renders textured meshes with one directional light (the 00 §5.14 boundary). PBR + one shadow cascade are M1; multi-light, post and HDR are M2. This spec defines how those features degrade, so the architecture does not have to be rewritten later, but adding them to the M0 wave is an M0 failure.
- **No game-specific branches.** No "if game X then quality Y". Device profiles and capability flags are the only switches.
- **No TV quality claim.** No TV hardware is available in this repository (`docs/DEVICES.md`). Every TV row in this spec is PENDING until a person runs it.
- **No new protocol, controller or broker work.** The backend never opens a socket.
- **No editor, asset pipeline or benchmark page.** Assets are spec 06; the benchmark page and goldens are spec 19.
- **No software rasterizer of our own.** If the browser exposes a software WebGL2 implementation, it is used with the measured (slow) consequences; it is not replaced.

---

## 3. Public interfaces

### 3.1 Package exports

Package: `@lanpad/engine-renderer-webgl2`, private workspace package at `packages/engine/renderer-webgl2/`.

| Entry | Exports | Browser | Node |
|---|---|---|---|
| `.` | `probeWebGL2`, `classifyWebGL2`, `createWebGL2Device`, `WebGL2DeviceInitResult`, `WebGL2Device`, `WebGL2DeviceOptions`, `WebGL2Capabilities`, `WebGL2Limits`, `WebGL2Tier`, `createBackendFailureNotice`, `BackendFailureNotice`, `missingFeatures`, `describeMissingFeature` | yes | pure classification only |
| `./canvas2d` | `createCanvas2DDevice`, `Canvas2DDevice`, `Canvas2DDeviceOptions` | yes | no |

Rules:

- No default export. Named exports only.
- No `GPUDevice`, `WebGL2RenderingContext`, DOM node or protocol frame appears in a game-facing type. `WebGL2Device` is a concrete backend type used by the runtime composition root; games see only the engine-neutral `RenderDevice` and the additive `renderer.capabilities`.
- `./canvas2d` must be independently importable so a 2D-only build never pulls the 3D WebGL2 shader set.
- The pure parts (`classifyWebGL2`, `missingFeatures`, `describeMissingFeature`, pipeline-key hashing) must run in Node for CI without a DOM.

### 3.2 Device construction

```ts
export interface WebGL2DeviceOptions {
  /** The host canvas. The device calls getContext("webgl2") exactly once. */
  readonly canvas: HTMLCanvasElement;
  /** Default: false on the TV profile, true otherwise. */
  readonly antialias?: boolean;
  /** Fixed false in v1: the page owns the background. */
  readonly alpha?: false;
  readonly depth?: boolean;              // default true
  readonly stencil?: boolean;            // default false; M2 UI masks may enable
  /** Default "high-performance". */
  readonly powerPreference?: "high-performance" | "default" | "low-power";
  /** Chromium hint; silently ignored when unsupported. */
  readonly desynchronized?: boolean;
  /** Caps the backing-store height only; CSS size is untouched. 0 = no cap. */
  readonly maxRenderHeight?: number;
  /** Per-frame GPU upload time slice. Default 4 ms (provisional). */
  readonly uploadBudgetMs?: number;
  /** Uniform-ring depth. Exactly 3 is the M0 supported value. */
  readonly framesInFlight?: 3;
  /** Device profile: DPR assumptions, MSAA off, TV texture/shadow sizes. */
  readonly tvProfile?: boolean;
  /** Default false on TV, true elsewhere. */
  readonly failIfMajorPerformanceCaveat?: boolean;
  readonly onContextLost?: () => void;
  readonly onContextRestored?: () => void;
}

export class WebGL2Device implements RenderDevice {
  readonly backend: "webgl2";
  readonly features: ReadonlySet<EngineFeature>;
  readonly limits: DeviceLimits;
  readonly capabilities: WebGL2Capabilities;
  /** Increments on every context loss. Old handles are stale after a bump. */
  readonly contextEpoch: number;
  readonly lost: boolean;
  // RenderDevice members from 00 §3.2 / spec 04:
  // init, resize, beginFrame, endFrame, createTexture, createBuffer, createMesh,
  // createMaterial, createPipeline, destroy, stats, size, dispose
}

export async function createWebGL2Device(
  options: WebGL2DeviceOptions,
): Promise<WebGL2DeviceInitResult>;
```

`createWebGL2Device` rejects with an `EngineError` whose code is `E_BACKEND_INIT` when a context cannot be created or the initial GL state cannot be established. It never returns a partially working device. The runtime catches that rejection and falls to the next tier (00 §5.12).

**Context-creation ordering is part of the contract.** A canvas can hold only one context type. The runtime must attempt WebGPU first and, if the WebGPU attempt has already called `configure()` on the canvas, replace the canvas element before calling `createWebGL2Device`. `probeWebGL2` therefore either probes a disposable canvas created by the caller or accepts a factory; it must not lock the host canvas before backend selection. This is the one ordering rule that, if broken, produces an unexplainable `null` context on Firefox and some TV browsers.

### 3.3 Capability probe and tier classification

```ts
export interface WebGL2Limits {
  readonly maxTextureSize: number;
  readonly maxCubeMapTextureSize: number;
  readonly max3DTextureSize: number;
  readonly maxArrayTextureLayers: number;
  readonly maxTextureImageUnits: number;
  readonly maxVertexTextureImageUnits: number;
  readonly maxCombinedTextureImageUnits: number;
  readonly maxVertexAttributes: number;
  readonly maxUniformBufferBindings: number;
  readonly maxUniformBlockSize: number;
  readonly maxDrawBuffers: number;
  readonly maxColorAttachments: number;
  readonly maxSamples: number;
  readonly maxAnisotropy: number;
}

export type WebGL2Tier = "extended" | "standard" | "minimal";

export interface WebGL2Capabilities {
  readonly available: true;
  /** Driver strings, recorded locally in RESULTS only; never transmitted. */
  readonly vendor: string;
  readonly renderer: string;
  readonly glVersion: string;
  readonly shadingLanguageVersion: string;
  readonly tier: WebGL2Tier;
  readonly extensions: readonly string[];
  readonly limits: WebGL2Limits;
  readonly features: ReadonlySet<EngineFeature>;
  /** Design caps, derived from limits; see §4.5. */
  readonly maxBones: number;
  readonly maxDirectionalLights: number;
  readonly maxPointLights: number;
  readonly maxShadowMaps: number;
}

export interface WebGL2Probe {
  readonly available: boolean;
  readonly reason?: "no-context" | "context-threw" | "blocked";
  readonly capabilities?: WebGL2Capabilities;
}

/** Browser probe. Creates a context on the supplied canvas/factory once. */
export function probeWebGL2(
  canvas:
    | HTMLCanvasElement
    | (() => HTMLCanvasElement | null),
): WebGL2Probe;

/** Pure classifier used by the probe and by CI. */
export function classifyWebGL2(input: {
  readonly limits: WebGL2Limits;
  readonly extensions: readonly string[];
}): {
  readonly tier: WebGL2Tier;
  readonly features: ReadonlySet<EngineFeature>;
};
```

Capability decisions are **feature detection only**. `navigator.userAgent` may be read by the host only to display a browser name in failure copy (the existing `displayBrowserName`); it never selects a code path (FR-12.1). A `getContext` exception, a blacklisted context or a blocked context all mean "unavailable", never a crash.

Tier classification is deterministic and monotone: adding an extension or raising a limit can never lower the tier.

| Tier | Condition (all must hold) | Intended use |
|---|---|---|
| `extended` | `EXT_color_buffer_float` **and** `OES_texture_float_linear` **and** at least one compressed family (`ASTC`, `ETC`, `S3TC` or `BPTC`) **and** `maxTextureSize >= 8192` **and** `maxSamples >= 4` | Desktop and high-end TV; HDR-capable post, MSAA, compressed variants |
| `standard` | WebGL2 core **and** `maxTextureSize >= 4096` **and** `maxVertexTextureImageUnits >= 16` | Most TVs; LDR PBR, one shadow cascade, no MSAA by default |
| `minimal` | Any other working WebGL2 context | 2D-quality 3D, small textures, no MSAA, no post |

These thresholds are design constraints, not hardware measurements. The actual tier of any device is whatever the probe reports and is recorded in `docs/RESULTS.md`.

`EngineFeature` is the frozen vocabulary from 00 §3.2. This backend maps it as follows:

| `EngineFeature` | WebGL2 | Detection | When absent |
|---|---|---|---|
| `compute` | **never present** | — | CPU job path; a game that requires it is refused early |
| `storage-buffers` | **never present** | — | Uniform buffers + data textures |
| `timestamp-query` | extension only | `EXT_disjoint_timer_query_webgl2` | CPU frame timing; dev profiling only |
| `float-render-target` | extension | `EXT_color_buffer_float` | LDR render targets only; no HDR bloom/tonemap |
| `texture-array` | **core** | always present | — |
| `msaa4` | core, 4× | `maxSamples >= 4` | No MSAA; optional FXAA |
| `compressed-astc` | extension | `WEBGL_compressed_texture_astc` | Asset variant fallback (06 §4.5) |
| `compressed-etc2` | extension | `WEBGL_compressed_texture_etc` | Asset variant fallback |
| `compressed-s3tc` | extension | `WEBGL_compressed_texture_s3tc` | Asset variant fallback |

Additional, non-`EngineFeature` capabilities are reported in `capabilities.extensions` and used only by the backend: `EXT_texture_filter_anisotropic`, `KHR_parallel_shader_compile`, `WEBGL_lose_context` (tests), `WEBGL_debug_renderer_info` (probe strings, never for decisions), `OES_texture_float_linear`, `EXT_sRGB_write_control` if present. Adding a value to `EngineFeature` requires a 00/04 amendment; this spec does not do that.

### 3.4 Refusing a game early

```ts
export function missingFeatures(
  required: readonly EngineFeature[],
  available: ReadonlySet<EngineFeature>,
): EngineFeature[];

export function describeMissingFeature(feature: EngineFeature): string;
```

The runtime compares the game manifest's `requiredFeatures` with the selected device **before** `game.init` and before the first scene upload. If any are missing, it refuses with `E_UNSUPPORTED_FEATURE` and the failure notice from §3.5. It never starts the game and fails mid-session.

Example sentences (fixed copy, used by the host):

| Feature | Sentence |
|---|---|
| `compute` | "This game needs WebGPU compute, which this browser does not provide. It can run on a WebGPU-capable desktop browser." |
| `storage-buffers` | "This game needs GPU storage buffers, which WebGL2 does not provide." |
| `timestamp-query` | "This game requires GPU timing queries, which this device does not expose." |
| `float-render-target` | "This game needs HDR rendering, which this device's WebGL2 cannot provide." |
| `msaa4` | "This game requires 4× anti-aliasing, which this device's WebGL2 cannot provide." |
| `compressed-astc` / `compressed-etc2` / `compressed-s3tc` | "This game requires a compressed texture format this device does not support." |

### 3.5 Failure screen contract

The host renders the failure screen as DOM, not canvas, so it works when every graphics context is unavailable. This package supplies the content; the host supplies the element, focus handling and remote/keyboard bindings.

```ts
export type BackendFailureCode =
  | "E_DEVICE_UNAVAILABLE"     // no WebGL2, and no Canvas2D for a 2D game
  | "E_BACKEND_INIT"           // context or initial GL state failed
  | "E_UNSUPPORTED_FEATURE"    // required feature or 3D on Canvas2D
  | "E_DEVICE_LOST"            // restore failed twice
  | "E_RENDERER_UNAVAILABLE";  // no tier can host this game

export interface BackendFailureNotice {
  readonly code: BackendFailureCode;
  readonly title: string;
  readonly message: string;
  readonly missingFeatures: readonly EngineFeature[];
  readonly hints: readonly string[];
  readonly canRetry: boolean;
  readonly detail: string;     // machine token, e.g. "3d-on-canvas2d"
}

export function createBackendFailureNotice(input: {
  readonly code: BackendFailureCode;
  readonly browserName: string;
  readonly backendTried: "webgpu" | "webgl2" | "canvas2d" | "none";
  readonly gameName?: string;
  readonly missingFeatures?: readonly EngineFeature[];
  readonly detail?: string;
}): BackendFailureNotice;
```

Fixed content rules:

| Situation | Title | Message | Hints | Retry |
|---|---|---|---|---|
| 3D game, no WebGL2, no WebGPU | "3D graphics are not available" | "<Browser> cannot create a 3D graphics context, so this game cannot run on this device." | update browser; use a PC over HDMI; try another device | no |
| 3D game, Canvas2D only | "This game needs 3D graphics" | "This device provides only 2D drawing. This game requires a 3D renderer." | update browser; use a PC over HDMI | no |
| Required feature missing | "This game needs a graphics feature this device lacks" | one sentence per §3.4 | update browser; try a desktop browser | no |
| WebGL2 context exists, init fails | "Graphics could not start" | "<Browser> has 3D graphics, but the context failed to initialize." | reload; close other tabs; update browser | yes (once) |
| Device lost twice | "Graphics was reset" | "The graphics device was reset and could not be restored. The game was stopped to protect your device." | reload | yes (once) |
| No tier at all (2D game) | "Cannot draw on this device" | "<Browser> could not create a 2D or 3D drawing context." | update browser; use another device | no |

The screen must:

- render with no canvas and no `RenderDevice`;
- use plain DOM text at no less than 24 CSS px at 1080p, high contrast, no truncation;
- set `role="alert"` on the message and move focus to the heading;
- be operable with Arrow keys + Enter and with gamepad A/B (the host's input layer maps these; this package only names the actions);
- never contain tokens, room codes, player names, absolute filesystem paths or full URLs with credentials (SR-2, SR-9);
- show the error code and, when `?debug=1`, the backend tried and the missing feature list;
- never auto-dismiss.

A 2D game that falls back to Canvas2D is **not** a failure. It runs, and the debug overlay records `backend=canvas2d`; there is no blocking notice.

### 3.6 What the game sees

Games never receive a `WebGL2Device`, a GL object, or a backend handle. The only observable difference is the additive `renderer.capabilities` on `GameContext` (owned by spec 18):

```ts
// Restated structurally in sdk; exact shape owned by 18.
export interface RendererCapabilities {
  maxTextureSize: number;
  compressedFormats: string[];       // existing legacy field
  backend?: "webgpu" | "webgl2" | "canvas2d";
  features?: readonly EngineFeature[];
  tier?: "webgpu" | WebGL2Tier | "canvas2d";
  limits?: DeviceLimits;
}
```

The existing `RendererCapabilities` in `packages/runtime/src/render/Renderer.ts` is extended additively; its two current fields keep their names and meaning. A game that checks `renderer.backend === "webgl2"` for correctness is a defect: correctness branches on `features`, quality branches on `tier` if the game chooses to.

---

## 4. Data formats

### 4.1 Capability report (RESULTS record)

The probe page writes this JSON to the page and `docs/RESULTS.md` records the fields in its E1-style row. It is never sent over the network and never logged with session data.

```json
{
  "schema": "pocketpad.webgl2.capability/1",
  "backend": "webgl2",
  "tier": "extended",
  "vendor": "Google Inc. (NVIDIA)",
  "renderer": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "glVersion": "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
  "shadingLanguageVersion": "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)",
  "limits": {
    "maxTextureSize": 16384,
    "maxCubeMapTextureSize": 16384,
    "max3DTextureSize": 2048,
    "maxArrayTextureLayers": 2048,
    "maxTextureImageUnits": 16,
    "maxVertexTextureImageUnits": 16,
    "maxCombinedTextureImageUnits": 32,
    "maxVertexAttributes": 16,
    "maxUniformBufferBindings": 24,
    "maxUniformBlockSize": 65536,
    "maxDrawBuffers": 8,
    "maxColorAttachments": 8,
    "maxSamples": 4,
    "maxAnisotropy": 16
  },
  "extensions": ["EXT_color_buffer_float", "OES_texture_float_linear", "WEBGL_compressed_texture_s3tc", "WEBGL_compressed_texture_s3tc_srgb", "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc"],
  "features": ["float-render-target", "texture-array", "msaa4", "compressed-s3tc"],
  "design": { "maxBones": 256, "maxDirectionalLights": 4, "maxPointLights": 8, "maxShadowMaps": 1 }
}
```

The numbers in the example are illustrative only. A recorded row contains only observed values; the example must never be copied into `docs/RESULTS.md`.

### 4.2 Pipeline descriptor key

Pipeline compilation is cached by a stable 32-bit key. The key is computed **without** `JSON.stringify` and without object key iteration order:

```
key = fnv1a32(
  "pipeline/1|",
  programId, "|", colorFormat, "|", depthFormat, "|",
  blendMode, "|", depthTest, "|", depthWrite, "|",
  cullMode, "|", topology, "|", sampleCount, "|",
  vertexLayoutId, "|", defineMask
)
```

- `programId` is a stable string from the shader registry (`forward-lit`, `depth-only`, `post-fxaa`, …).
- `defineMask` is a `uint32` built from the fixed variant list; each bit names one compile-time define. The mapping is a module constant, tested.
- The key space is deliberately small: the M0 backend must stay under **128 compiled pipelines**; exceeding it is a dev error with `E_PIPELINE_COMPILE` and the two ids that collided. (Design limit, not a measurement.)
- `createPipeline` compiles synchronously and returns a usable handle. Pipeline creation is a load-time operation; a pipeline miss inside `beginFrame` increments `stats.pipelineMisses` and fails in dev. `KHR_parallel_shader_compile` may be used to pre-warm at load, but the API never returns a half-linked program.
- Compilation failure is cached: retrying the same key returns the same `E_PIPELINE_COMPILE`, not a new compile every frame.

### 4.3 Shader sources and vertex layout

- Shaders are GLSL ES 3.00 (`#version 300 es`), checked in as TypeScript template strings in `src/shaders/`. No runtime string concatenation from asset data, no `#include`, no generated shader source from JSON.
- Variants are produced only by prepending `#define` lines from the fixed list. The list is exported for tests.
- Attribute locations are fixed by **ABI 1**, which spec 04 owns. This backend accepts exactly the two M0 layouts and rejects any other attribute set with `E_CONTRACT` at creation, not at draw.

**`static-pbr-v1`** — one interleaved vertex buffer, stride 32 bytes:

| Location | Attribute | Format |
|---|---|---|
| 0 | `position` | `float32x3` |
| 1 | `normal` | `float32x3` |
| 2 | `uv` | `float32x2` |

**`instanced-transform-v1`** — the same vertex buffer plus one instance buffer, stride 64 bytes:

| Location | Attribute | Format | Step mode |
|---|---|---|---|
| 3–6 | `model0`–`model3` | `float32x4` × 4 | instance |

`TANGENT`, `COLOR_0`, `JOINTS_0`, `WEIGHTS_0` and `TEXCOORD_1` are **not** part of ABI 1. Skinned and morph layouts are M1/M2 and must be added as new layout ids with a `RENDERER_ABI_VERSION` bump in both specs; they must never shift the ABI-1 locations. Normal mapping in ABI 1 uses the derivative tangent frame (04 §5.13).

### 4.4 Texture formats accepted by this backend

The canonical `TextureFormat` tokens are owned by 04 and consumed by 06 for variant selection. The WebGL2 backend must support at least this set; the probe removes formats whose extension is absent:

| Token (canonical, owned by 04) | WebGL internal format | Source | Notes |
|---|---|---|---|
| `rgba8unorm` | `RGBA8` | uncompressed | default |
| `rgba8unorm-srgb` | `SRGB8_ALPHA8` | uncompressed | sRGB sampling |
| `bgra8unorm` | — | not supported | WebGPU swapchain format; the probe removes it |
| `rgba16float` | `RGBA16F` | requires `EXT_color_buffer_float` for render targets; sampling core | HDR post |
| `rgba32float` | `RGBA32F` | as above | data/skinning targets |
| `r8unorm` | `R8` | core | masks |
| `rgb10a2unorm` | `RGB10_A2` | core | HDR-ish LDR targets |
| `depth24plus` | `DEPTH_COMPONENT24` | core | depth attachment |
| `depth32float` | `DEPTH_COMPONENT32F` | core | optional |
| `depth24plus-stencil8` | `DEPTH24_STENCIL8` | core | stencil path |
| `s3tc-dxt1` | `COMPRESSED_RGB_S3TC_DXT1_EXT` | `WEBGL_compressed_texture_s3tc` | |
| `s3tc-dxt3` | `COMPRESSED_RGBA_S3TC_DXT3_EXT` | same | |
| `s3tc-dxt5` | `COMPRESSED_RGBA_S3TC_DXT5_EXT` | same | |
| `etc2-rgb8` | `COMPRESSED_RGB8_ETC2` | `WEBGL_compressed_texture_etc` | |
| `etc2-rgba8` | `COMPRESSED_RGBA8_ETC2_EAC` | same | |
| `astc-4x4` | `COMPRESSED_RGBA_ASTC_4x4_KHR` | `WEBGL_compressed_texture_astc` | |
| `astc-6x6` | `COMPRESSED_RGBA_ASTC_6x6_KHR` | same | TV default where present |
| `astc-8x8` | `COMPRESSED_RGBA_ASTC_8x8_KHR` | same | |
| `bptc-rgba` | `COMPRESSED_RGBA_BPTC_UNORM_EXT` | `EXT_texture_compression_bptc` | desktop |

Compressed textures use `compressedTexStorage2D` + `compressedTexSubImage2D`. The mip chain must be complete in the file; the backend never calls `generateMipmap` on a compressed texture. Uncompressed textures use immutable `texStorage2D`; `generateMipmap` runs only at load when the descriptor requests it, never per frame.

### 4.5 Design caps and uniform layout

These are fixed design values, derived from WebGL2 minimums, not device measurements. They are reported in `capabilities` so games and tooling can budget content.

| Cap | Value | Reason |
|---|---|---|
| `maxBones` | 256 | Bone texture of 4 RGBA32F texels per bone needs 1024 texels; every WebGL2 device supports ≥ 2048 texture width |
| `maxDirectionalLights` | 4 | Fits the frame UBO with material and camera data |
| `maxPointLights` | 8 | Same; no clustered/tiled lights on WebGL2 |
| `maxShadowMaps` | 1 | One directional cascade in M1; more is a quality decision for M3 |
| Frame UBO binding | 0 | viewProjection, camera, time, resolution, light header |
| Material UBO binding | 1 | factors, alpha mode, texture unit indices |
| Skinning UBO binding | 2 | fallback for ≤ 64 bones; bone texture for > 64 |
| Instance data | attribute locations 8–13 | no instance UBO |
| UBO alignment | std140, 16-byte | never pack a `vec3`; use `vec4` |

`MAX_UNIFORM_BLOCK_SIZE` is at least 16 KiB on WebGL2; the backend refuses a material or frame layout that would exceed the probed value with `E_CONTRACT` at creation. It never silently drops a light.

### 4.6 Context-loss epochs and handles

GPU handles are `{ index, generation }` (00 §3.2). In addition:

- `contextEpoch` starts at 0 and increments on every `webglcontextlost`.
- Handles **remain valid across restoration**: the device retains every live descriptor and rebuilds the resource in place under the same `{index, generation}`. While the context is lost, creation and drawing return `E_DEVICE_LOST`; after `onRestored`, the same handles resolve again. A handle is stale only after `destroy`/`dispose` (dev throws `E_STALE_HANDLE`; production is a counted no-op).
- CPU-side descriptors (`TextureDesc`, `BufferDesc`, `MeshDesc`, `MaterialDesc`, `PipelineDesc`) are retained for every live handle so the device can rebuild after restoration. `TextureDesc.source` is retained by reference; the caller (the scene, through an `AssetHandle`) must keep it alive until `destroy`. The device never mutates it.
- Render-target contents are not preserved across loss; only descriptors are.
- `destroy` is deferred to `endFrame` so a resource cannot be deleted while the current frame still references it. `destroy` is idempotent; double destroy is a no-op.

### 4.7 Benchmark envelope

The M0 benchmark page is owned by spec 19. The WebGL2 backend must expose the fields 19 needs, without allocating:

```ts
interface WebGL2BenchSample {
  backend: "webgl2";
  adapter: string;          // capabilities.renderer
  tier: WebGL2Tier;
  frames: number;
  warmupFrames: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  drawCalls: number;
  triangles: number;
  textureBytes: number;
  pipelineMisses: number;
  contextLosses: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}
```

### 4.8 Fixtures owned by this spec

Small, synthetic, checked in:

| Fixture | Purpose |
|---|---|
| `test/fixtures/capability-cases.json` | Synthetic limit/extension sets → expected tier + feature list (including no-extension, ASTC-only, float-only, and a below-standard set) |
| `test/fixtures/pipeline-keys.json` | Descriptor → expected 32-bit key, including define-mask boundaries |
| `test/fixtures/failure-notices.json` | Every `BackendFailureCode` + missing-feature combination → expected copy and `canRetry` |
| `test/fixtures/state-sequence.json` | A small draw sequence → expected GL call sequence from the fake recorder |
| `test/fixtures/draw-list.json` | Mesh/material/pipeline combinations → expected draw-call count after batching |

No fixture is a performance measurement.

---

## 5. Architecture

### 5.1 Module map

```
packages/engine/renderer-webgl2/src/
  index.ts                 public 3D entry
  device.ts                WebGL2Device, lifecycle, RenderDevice implementation
  capability.ts            probe, limits, extensions, vendor strings
  classify.ts              pure tier/feature classification (Node-safe)
  features.ts              EngineFeature mapping, missing-feature sentences
  failure.ts               BackendFailureNotice construction and copy
  limits.ts                design caps (bones, lights, shadow maps)
  state.ts                 shadow GL state cache with dirty bits
  pipelineCache.ts         key hashing, program registry, compile/link, failure cache
  resources.ts             generational handle table, deferred destroy
  texture.ts               texStorage/texSubImage/compressed upload, format map
  buffer.ts                static/dynamic buffers, UBO ring
  mesh.ts                  VAO construction, index buffers, attribute validation
  material.ts              material UBO packing, texture-unit assignment
  frame.ts                 beginFrame/endFrame, RenderFrame implementation
  upload.ts                upload budget, staging, time slicing
  contextLoss.ts           loss/restore, epoch bump, rebuild
  stats.ts                 stable counters, no allocation
  shaders/                 GLSL ES 3.00 sources and the fixed define list
  passes/forward.ts        opaque/transparent forward pass (M0 lit)
  passes/depth.ts          depth-only shadow pass (M1)
  passes/post.ts           LDR post chain (M2; FXAA allowed earlier)
  canvas2d/index.ts        public 2D entry
  canvas2d/device.ts       Canvas2DDevice
  canvas2d/draw2d.ts       clear/circle/rect/text/polyline, design-space transform
```

### 5.2 Lifecycle

```
createWebGL2Device(canvas, options)
  → getContext("webgl2", attributes) once
  → read limits + extensions
  → classify tier/features
  → install context-loss listeners
  → establish default state (viewport, depth, cull, blend)
  → return device

runtime: resize(cssW, cssH, dpr) → beginFrame() → frame.setCamera / draw / drawInstanced → endFrame()
```

`init(surface)` (the RenderDevice member) performs the context acquisition and is idempotent only in the sense that a second call after success rejects with `E_CONTRACT`. `dispose()` is idempotent and may run on a half-initialised device.

### 5.3 Frame lifecycle and passes

`beginFrame()`:

1. If the context is lost, return a no-op `RenderFrame` and increment `stats.lostFrames`.
2. Reset per-frame counters (no allocation; a stable object is mutated).
3. Apply the configured clear (colour + depth; stencil only if enabled).
4. Bind the frame UBO for this frame slot (ring index `frameIndex % 3`).
5. Return the stable `RenderFrame` object.

`RenderFrame`:

- `setCamera(viewProjection)` copies 16 floats into the frame UBO; no allocation.
- `draw(mesh, material, transform)` writes one draw command; the command is flushed in pipeline/material/mesh order.
- `drawInstanced(mesh, material, transforms, count)` writes one instanced command; `count` is clamped to `transforms.length / 16` and to the mesh's instance capacity. Zero is a no-op.

`endFrame()`:

1. Flush any pending draw commands in the current sort order.
2. Resolve MSAA only if an offscreen multisampled target was used (M2 post); the M0 default-framebuffer path needs no resolve.
3. Apply deferred destroys.
4. Advance `frameIndex`; publish stats.

M0 pass order: clear → opaque (front-to-back) → alpha-test → transparent (back-to-front) → end. M1 inserts the shadow depth pass before opaque. M2 inserts post before host UI. The backend must not add engine passes that the game did not request: a game that draws only 2D through the engine gets clear + 2D.

`alpha` from the fixed loop is **not** used by the backend. Interpolation is the game's/scene's job; the backend renders the matrices it is given. (This preserves the existing `Renderer3D` contract, which ignores `alpha`.)

### 5.4 Draw batching and sorting

- Commands are written into preallocated typed arrays: `drawCallCount`, `pipelineId`, `materialId`, `meshId`, `transformOffset`, `instanceCount`, `depthKey`. Capacity is **4096 commands**; overflow drops the command, increments `stats.droppedCommands` and logs once in dev. The draw-call budget is 120 after batching; 4096 commands is the pre-batch ceiling.
- Opaque commands sort by `pipelineId`, then `materialId`, then `meshId`, then front-to-back `depthKey`. Transparent commands sort back-to-front by `depthKey` and keep pipeline grouping only within equal depth. The sort uses a counting sort over a `Uint32Array`; no `Array.prototype.sort` with a comparator closure per frame.
- Instancing: a command with `instanceCount > 1` uses `drawElementsInstanced` or `drawArraysInstanced`. Repeated meshes above 10 copies are expected to arrive already batched from the scene/04 layer; the backend does not merge separate `draw` calls heuristically (that would make draw counts backend-specific and break parity).
- The backend never culls. Frustum culling and LOD selection are backend-neutral decisions in 04/03, so WebGPU and WebGL2 submit the same visible set. `stats.culled` is reported by the caller, not invented here.

### 5.5 Shadow and light passes (M1)

- One directional light casts one shadow map. M0 renders the light's shading without a shadow map.
- Shadow map: `DEPTH_COMPONENT24`, 2048² on `extended`, 1024² on `standard`/`minimal`; the TV profile forces 1024². Sampling uses `sampler2DShadow` with 3×3 PCF.
- The depth pass uses a dedicated `depth-only` program and the same vertex layout; it does not run the material shader.
- No cascaded shadow maps on WebGL2 before M3; the single cascade covers a camera-relative box sized by the game's `shadowDistance`.
- No point-light shadows (6 faces × light count is too expensive on TV); point lights are unshadowed.
- Light counts above the design caps are refused at material/scene build time (`E_CONTRACT`), not silently dropped.

### 5.6 PBR and post: what is lost versus WebGPU

| Capability | WebGPU (Tier A) | WebGL2 (Tier B) | Required degradation |
|---|---|---|---|
| Compute | compute shaders | none | CPU jobs; GPU culling/particles are optional features with CPU fallbacks |
| Storage buffers | yes | none | UBOs (≤ 16 KiB guaranteed) + data textures |
| Indirect / GPU-driven draws | yes | none | CPU-built draw lists; instancing only |
| Timestamp queries | standard | extension only | CPU frame timing; dev GPU timing when the extension exists |
| Bindless / many textures | yes | limited texture units | Material atlases; per-draw binds; texture-unit budget from `limits` |
| Skinning | compute or vertex | vertex shader, bone texture | 4 influences; 256 bones; no dual-quaternion path in M0/M1 |
| Morph targets | storage/compute-friendly | vertex texture or CPU | CPU blend or vertex-texture path; capped by `maxBones`-style design budget |
| PBR | full, clustered lights | metallic-roughness, 4 dir + 8 point, one shadow | Reduced light count; no clustered/tiled lights |
| HDR post | float targets standard | requires `EXT_color_buffer_float` | Without it: LDR tonemap/grade/FXAA only; no HDR bloom |
| MSAA | up to 4×/8× | 4× where `maxSamples >= 4` | Off by default on TV; FXAA if enabled |
| Texture compression | ASTC/ETC2/BC | whichever extension exists | Asset variants (06 §4.5); uncompressed fallback costs memory |
| Occlusion culling | GPU queries | CPU queries core but stall-prone | CPU frustum + distance LOD; occlusion queries not used by default |
| Ray tracing | no | no | same |

A game that needs `float-render-target` for HDR bloom declares it in `requiredFeatures`; it is refused on a device without the extension instead of silently losing the effect. A game that only prefers it branches on `features` and uses the LDR path.

### 5.7 Upload budgeting

- All texture and buffer uploads happen through `upload.ts`; no pass calls `texImage2D` directly.
- Each frame has `uploadBudgetMs` (default 4 ms, provisional) for uploads. Work is queued as upload jobs; a job is started only when the remaining budget is positive. A single job may exceed the budget if it is a boot asset (boot may block, per 00 §5.6), but a streaming upload that would exceed the budget waits for the next frame.
- `generateMipmap` is a load operation, not a streaming operation.
- Compressed texture levels upload one `compressedTexSubImage2D` per level; uncompressed levels one `texSubImage2D` per level.
- `stats.uploads` counts queued jobs; `stats.uploadBytes` counts bytes accepted this frame; `stats.uploadStalls` counts frames where the budget expired with work remaining.

### 5.8 State cache

WebGL2 is a stateful API; redundant binds are the main CPU cost. `state.ts` keeps a shadow of:

`currentProgram`, `boundVAO`, `arrayBuffer`, each UBO binding index, `activeTexture` + each texture unit's binding and target, `blend` (enabled, src/dst factors, equation), `depth` (test, func, write, range), `cull` (enabled, face), `viewport`, `scissor`, `stencil`, `clearColor`.

Rules:

- The cache is updated only by the backend's own calls; the backend never reads GL state to decide (a `getParameter` per draw is a stall). After context restoration the cache is reset to "unknown" and every setter runs.
- A pipeline apply sets the program and pipeline state; a material apply sets the material UBO and texture units; a mesh apply binds the VAO and index buffer.
- Texture unit assignment is deterministic: the material's texture slots are assigned in fixed order (base colour 0, normal 1, metallic-roughness 2, occlusion 3, emissive 4, shadow 5, environment 6, …). Slots above `maxTextureImageUnits - reserved` are refused at material creation.
- `stats.pipelineSwitches` and `stats.textureBinds` count changes, not calls.

### 5.9 Context loss and backend fallback

1. `webglcontextlost`: call `preventDefault()`, set `lost = true`, stop accepting GL commands, increment `contextEpoch`, clear the state cache, invoke `onContextLost`. The runtime pauses the loop. No exception is thrown from `draw`.
2. `webglcontextrestored`: re-acquire the context (the same object), reset GL state, rebuild every live resource from its retained descriptor, reset the state cache, set `lost = false`, invoke `onContextRestored`. The runtime resumes and renders the next frame.
3. If restoration does not arrive within **1 s** or the restored context fails to rebuild (shader compile, allocation), the device reports `E_DEVICE_LOST`. The runtime attempts one fresh device creation on the same canvas. If that fails, it falls back one tier: a 2D game may move to Canvas2D; a 3D game shows the `E_DEVICE_LOST` failure screen. Two consecutive failures stop retrying for the session.
4. A save in progress is abandoned by the saving subsystem, never half-written (00 §5.12). This package has no save code.
5. In dev (`?debug=1`) a per-frame watchdog logs the last pipeline/mesh before a hang; production relies on the host notice path.

### 5.10 Canvas2D entry (Tier C)

`./canvas2d` implements the 2D subset behind the same device lifecycle:

```ts
export interface Canvas2DDeviceOptions {
  readonly canvas: HTMLCanvasElement;
  readonly maxRenderHeight?: number;
  readonly tvProfile?: boolean;
}
export async function createCanvas2DDevice(
  options: Canvas2DDeviceOptions,
): Promise<Canvas2DDevice>;
```

- `backend = "canvas2d"`, `features` is an empty set, `limits` reports `maxTextureSize: 0`, `maxSamples: 0`, `maxAnisotropy: 0`.
- It implements the frozen `Renderer2D` calls (`clear`, `circle`, `rect`, `text`, `polyline`) with the exact current semantics from `packages/runtime/src/render/Canvas2DRenderer.ts`: CSS-pixel coordinates via `setTransform`, 1280×720 design space owned by the game, backing-store DPR scaling, `maxRenderHeight` cap.
- It refuses every 3D call. A 3D game never receives this device: selection refuses with `E_UNSUPPORTED_FEATURE` / `detail: "3d-on-canvas2d"` before the game starts.
- `init` rejects when `getContext("2d")` returns null; the host then shows the `E_DEVICE_UNAVAILABLE` failure screen.
- Text uses the browser font stack (`sans-serif`) exactly as today; cached offscreen HUD text is spec 13, not this entry.

### 5.11 Performance rules

- **No allocation in the frame path.** Preallocated: `RenderFrame`, command arrays, transform scratch, sort key/value arrays, UBO ring, stats object, clear colour. The only allowed frame-path allocation is growing a buffer whose capacity was exceeded, and that growth is capped and logged.
- **No `getParameter` in the frame path.** Limits and extensions are read once in `probe`/`init`.
- **No shader compilation in the frame path.** All pipelines are created at load; a miss is a defect.
- **No readback.** No `readPixels`, `getBufferSubData` or `fenceSync` in the frame path. Screenshot/golden capture is a test-only path with an explicit flag.
- **Dynamic resolution** is owned by `engine-core` (`resolutionController`): the device honours `resize` and reports `size`; it never changes scale on its own.
- **TV profile defaults:** `tvProfile: true` sets DPR 1, `maxRenderHeight` 1080, MSAA off, shadow map 1024², `failIfMajorPerformanceCaveat: false`, and prefers `minimal`-safe defaults when the tier is `minimal`.

### 5.12 Error and counter behaviour

| Failure | Behaviour |
|---|---|
| No WebGL2 context | `probeWebGL2` returns `available: false`; runtime falls to Canvas2D (2D) or shows `E_DEVICE_UNAVAILABLE` (3D) |
| Context creation throws | Treated as unavailable; never propagates a raw browser exception to a game |
| Initial GL state / boot pipeline fails | `createWebGL2Device` rejects `E_BACKEND_INIT`; runtime falls a tier |
| Pipeline compile fails | `createPipeline` throws `E_PIPELINE_COMPILE`; failure cached; game load fails with the failure screen |
| Stale handle in dev | Throws `E_STALE_HANDLE`; production no-op + `stats.staleHandles++` |
| Draw with a destroyed texture | Dev error `E_STALE_HANDLE`; production binds a 1×1 white fallback and counts |
| Upload queue over budget | Defers to the next frame; never blocks the loop |
| Context lost | No throw; pause + recover per §5.9 |
| Disposed device used | Dev `E_CONTRACT`; production no-op + counter |

Nothing in the frame path throws in normal operation. A recoverable failure increments a counter and degrades; an unrecoverable one stops the loop and routes the notice to the host (00 §5.9).

---

## 6. File ownership

This spec owns only `docs/engine/05-renderer-webgl2.md` until implementation starts. The implementing wave owns exactly these paths and no others.

| Path | Contents |
|---|---|
| `packages/engine/renderer-webgl2/package.json` | name `@lanpad/engine-renderer-webgl2`, private, `"type": "module"`, exports `"."` and `"./canvas2d"`, runtime deps `{}` (only `@lanpad/engine-core` as a workspace dependency) |
| `packages/engine/renderer-webgl2/tsconfig.json` | project reference to `engine-core`; DOM lib |
| `packages/engine/renderer-webgl2/src/index.ts` | public 3D exports |
| `packages/engine/renderer-webgl2/src/device.ts` | `WebGL2Device` |
| `packages/engine/renderer-webgl2/src/capability.ts`, `classify.ts`, `features.ts` | probe, pure classification, feature mapping |
| `packages/engine/renderer-webgl2/src/failure.ts`, `limits.ts` | notice construction, design caps |
| `packages/engine/renderer-webgl2/src/state.ts`, `pipelineCache.ts` | state cache, program cache |
| `packages/engine/renderer-webgl2/src/resources.ts`, `texture.ts`, `buffer.ts`, `mesh.ts`, `material.ts` | resource tables and upload |
| `packages/engine/renderer-webgl2/src/frame.ts`, `upload.ts`, `contextLoss.ts`, `stats.ts` | frame, budget, loss, counters |
| `packages/engine/renderer-webgl2/src/shaders/**` | GLSL ES 3.00 sources + define registry |
| `packages/engine/renderer-webgl2/src/passes/**` | forward, depth, post |
| `packages/engine/renderer-webgl2/src/canvas2d/**` | `./canvas2d` entry and device |
| `packages/engine/renderer-webgl2/test/**` | unit, property, golden, conformance, benchmark harness |
| `packages/engine/renderer-webgl2/test/fixtures/**` | fixtures listed in §4.8 |

**Not owned by this spec:**

- `packages/engine/core/src/render/contract.ts` — 00/04. The backend implements it; it does not edit it.
- `packages/engine/renderer-webgpu/**` — 04. The two backends are siblings and neither imports the other (D9).
- `packages/runtime/src/render/**` — the migration of `WebGL2Renderer.ts`, `Canvas2DRenderer.ts` and `capability.ts` into this package is an **integration-wave** change owned by the integration agent (00 §5.13, §6). This spec's implementation may add the package; it must not edit runtime files.
- `packages/runtime/src/render/selectRenderer.ts`, `src/compat/**` — integration agent.
- `experiments/e-m0-engine/**` and goldens — spec 19.
- `docs/RESULTS.md` — measurements only, written by whoever runs the device.
- `sdk/**` — the additive `renderer.capabilities` shape is owned by spec 18.
- `eslint.config.js`, root `package.json`, `tsconfig.json`, Vitest config — integration agent adds the workspace/project entries.

One writer per file. A wave that needs two agents in this package splits by file (for example, `capability.ts` + `classify.ts` vs `passes/**`), never by "renderer area".

---

## 7. Acceptance

Every row carries an `ER-05-NN` ID. Tests and manual records reference the ID; the integration agent adds the matching `docs/todos/TRACEABILITY.md` rows in the same change that lands the first tagged test (per `docs/TESTING.md`, "Adding a requirement"). Evidence state is **PENDING** until a run exists; no row is claimed from this document.

| ID | Criterion | Fixture / method | Hardware | Evidence state |
|---|---|---|---|---|
| ER-05-01 | The shared renderer conformance suite (defined by 04) passes against the WebGL2 device: capability report, resize, create/destroy for every resource kind, draw counts, dispose idempotence, stale-handle behaviour | `packages/engine/renderer-webgl2/test/conformance/` and the shared suite; CI runs the suite against a fake device, the browser page runs it against real GL | CI Node 20; real GL on `pc-win11-rtx3050`, Chrome 155 | PENDING — needs 04's suite and the implementation |
| ER-05-02 | `probeWebGL2` on the recorded desktop reports `available: true`, `tier: extended`, `maxTextureSize >= 16384`, and includes S3TC/S3TC_sRGB/BPTC/RGTC; it does not report ASTC or ETC (E1 recorded those as absent) | Probe page, capability JSON from §4.1 | `pc-win11-rtx3050`, Windows 11 10.0.26300, Chrome 155.0.8059.85 | PENDING — probe run |
| ER-05-03 | M0 scene (5,000 instanced textured cubes, one directional light, 1920×1080 CSS, DPR 1, 600 measured frames after 120 warm-up) runs with frame p95 ≤ **20 ms** (hard budget), draw calls ≤ **120**, and records p50/p95/max, adapter, tier, build hash | `experiments/e-m0-engine/?backend=webgl2&instances=5000&bench=1`; 19 owns the page | `pc-win11-rtx3050`, Chrome 155 | **PASS 2026-10-23** — headless Chrome 155, `WebKit WebGL`, p50 9.3 / p95 10.2 / max 10.7 ms, 1 draw, 60,000 triangles, 0 GPU errors, build `bed149c4…`; see `docs/RESULTS.md` |
| ER-05-04 | WebGL2 and WebGPU frames at tick 300 match within tolerance: ≤ **2%** of pixels differ by more than **8/255** in any channel | `experiments/e-m0-engine/golden/` capture + in-page diff; 19 owns the goldens | `pc-win11-rtx3050`, Chrome 155 | PENDING — needs 04's WebGPU backend and the goldens |
| ER-05-05 | Tier classification is deterministic and monotone: every synthetic case in `capability-cases.json` maps to the expected tier/features, and adding an extension never lowers the tier | `test/capability.test.ts` + `fixtures/capability-cases.json` | CI Node 20 (pure classifier) | PENDING — first implementation wave |
| ER-05-06 | Context loss (`WEBGL_lose_context.loseContext()`) recovers to a frame matching the pre-loss golden within tolerance in ≤ **1 s** and ≤ **60 frames**; no uncaught exception; `contextEpoch` increments; old handles are stale | Browser page `?contextloss=1` + golden diff | `pc-win11-rtx3050`, Chrome 155 | PENDING — needs the page |
| ER-05-07 | A 3D game on a Tier C device is refused before `game.init` with `E_UNSUPPORTED_FEATURE`, `detail: "3d-on-canvas2d"`, and the failure notice; no Canvas2D 3D draw occurs | Runtime integration test with injected device factories; `packages/runtime/test/integration/rendererFallback.test.ts` | CI Node 20 (fake devices) | PENDING — first implementation wave |
| ER-05-08 | The `./canvas2d` entry preserves current 2D visuals: Coin Run and Reaction Duel golden frames at frame 300 differ by ≤ **2%** of pixels by more than 8/255 | Existing game goldens, before/after capture; 19 owns the goldens | `pc-win11-rtx3050`, Chrome 155 | PENDING — goldens and migration |
| ER-05-09 | Streaming uploads are time-sliced: while loading a fixture set with ≥ 64 MiB of textures, the longest main-thread task is ≤ **8 ms** (FR-9.10) and `stats.uploadStalls` records deferred frames | `PerformanceObserver({ type: "longtask" })` on the streaming fixture page | `pc-win11-rtx3050`, Chrome 155 | PENDING — needs the fixture set |
| ER-05-10 | No steady-state per-frame allocation: heap growth ≤ **512 KiB** over 480 frames after 120 warm-up frames on the M0 scene | `?bench=1&alloc=1`, Chrome `performance.memory`; same method as 00 ER-00-07 | `pc-win11-rtx3050`, Chrome 155 | PENDING — needs the page |
| ER-05-11 | Package has zero third-party runtime dependencies; its gzip size is recorded in the size report; the host bundle stays under the **5 MB gz** hard cap | `npm run size` + `package.json` check | CI Node 20 | PENDING — first implementation wave |
| ER-05-12 | Every failure notice in `failure-notices.json` has the fixed copy, correct `canRetry`, no token/URL/PII, `role="alert"`, focusable heading, and is operable by keyboard/gamepad; text ≥ 24 CSS px at 1080p | DOM unit test + manual 1080p check | CI (copy); `pc-win11-rtx3050` (legibility) | PENDING — first implementation wave + manual |
| ER-05-13 | TV Tier B: the M0 scene runs at 1280×720 and 1920×1080 with p95 ≤ **20 ms** on a 60 Hz panel or ≤ **33.3 ms** on a 30 Hz panel (BUDGETS frame classes), records tier/extensions/resolution, and survives a 10-minute run with no unrecovered context loss | Same page with `tvProfile=1`; record p50/p95/max and the panel class | **PENDING device:** a 2020-era Android TV Chromium and a Tizen/webOS set from SPEC §12; no TV hardware exists in this repo | PENDING — cannot be measured yet |

Threshold sources: 20 ms hard fail and 14 ms target from SPEC §11; 120 draw calls from PR-9.1; 128 MB texture from PR-9.2 (provisional); 8 ms long task from FR-9.10; 5 MB gz from NR-6.1; 2%/8-255 parity and 512 KiB heap from 00 §7. The 33.3 ms row is the 30 Hz frame class in `docs/BUDGETS.md`.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | Limit reading, extension filtering, tier classification, feature mapping, missing-feature sentences, failure copy, pipeline key hashing, define mask, format map, state-cache diffs, handle generations, deferred destroy, upload queue, stats counters | `packages/engine/renderer-webgl2/test/*.test.ts` |
| Property (`fast-check`) | Adding an extension/limit never lowers tier; feature set is a subset of the declared universe; pipeline keys are stable across object construction order; handle indices never return the same generation twice; count clamping never exceeds capacity | `test/*.property.test.ts` |
| Golden | Capability cases, pipeline keys, failure notices, fake-GL call sequence for a fixed draw list, draw-call count after batching | `test/fixtures/`, `test/golden/*.test.ts` |
| Conformance | The 04-owned suite run against WebGL2; in CI a recording fake device proves the suite is not backend-specific; in the browser the real GL device runs it | `test/conformance/` |
| Integration | Runtime selection matrix: WebGPU ok → WebGPU; WebGPU fails → WebGL2; WebGL2 fails + 2D → Canvas2D; WebGL2 fails + 3D → failure screen; required feature missing → refusal before `game.init`; context loss → pause → restore | `packages/runtime/test/integration/rendererFallback.test.ts`, `engineBoot.test.ts` (integration agent) |
| Browser benchmark | M0 scene, p50/p95/max, draw calls, texture bytes, pipeline misses, long tasks, heap growth, context loss | `experiments/e-m0-engine/?backend=webgl2&bench=1` (19) |
| Manual | Real GPU adapter matrix, TV tiers, legibility of the failure screen, 10-minute soak | `docs/RESULTS.md` |

Test rules:

- Every test title carries its `ER-05-*` ID or a leading `// @req ER-05-*`; the ID must resolve once the traceability row exists.
- CI cannot create real GL; the pure logic and the shared conformance suite with a fake device run in Node. Real GL runs in the browser page and produces `window.__M0_BENCH__`. A backend that cannot run in CI is covered by a recorded manual/browser result, never by deleting a test.
- Tests use synthetic limit/extension fixtures, never a captured private device string in an assertion. A capability report may be recorded in RESULTS, but tests assert facts (extension present/absent, tier), not a vendor string that changes with driver updates.
- No fixed sleeps: context-loss and upload tests wait on events/counters with a timeout.
- Performance tests report p50, p95, max, frame count, warm-up count, adapter, browser version, build hash, CSS size and DPR. A number without those fields is not evidence.

---

## 9. Dependencies

**Spec order**

| Dependency | Why | State |
|---|---|---|
| 00 architecture | `RenderDevice` contract, tiers, fallback chain, migration, file ownership | written |
| 04 renderer-webgpu | Canonical supporting types, feature names, conformance suite, texture-format tokens, parity partner | written; ABI 1 and texture tokens reconciled 2026-10-22 |
| 01 core loop/time | Frame entry, `EngineFrame`, stats consumers | written |
| 02 math | `Mat4`, `Vec3`, frustum types used by descriptors and camera | written |
| 03 scene/ECS | Draw-list source, culling policy, camera | written; encoder ownership clarified 2026-10-22 |
| 06 assets | KTX2/GLB decoded data, `TextureData`, variant selection | written in this wave |
| 16 tooling | Shader validation, benchmark result capture | written |
| 19 testing/benchmarks | M0 page, goldens, parity harness | written |

**Package prerequisites**

- Runtime dependency: `@lanpad/engine-core` only (D9). No import of `engine-renderer-webgpu`, `engine-assets`, `protocol`, `sdk`, `runtime`, `controller` or a game.
- Dev-only: TypeScript/Vitest inherited from the root workspace. No GL test library is added; the fake device is hand-written.
- The package is private until P4; no publishing.

**Paper-trail prerequisites**

- Amendment **A14** (browser-native engine reframe) recorded before this backend's code merges.
- `docs/todos/TRACEABILITY.md` rows for `ER-05-*` added with the first tagged test.
- `docs/RESULTS.md` rows for ER-05-02/03/06/08/09/10/13 only after real runs; no synthetic numbers.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | Spec 04 lands with different type/field names or feature semantics, forcing rework | High until 04 exists | Medium | Treat 00 §3.2 as the interim contract; reconcile in 04 before implementation; conformance suite is shared, so drift fails one test set |
| R2 | TV WebGL2 is much slower than desktop; the 20 ms budget is unreachable at 1080p | High until E2/E3 TV runs | High | TV profile: DPR 1, 720p first, MSAA off, 1024² shadow, compressed textures, dynamic resolution floor 60%; TV rows stay PENDING; no quality promise before measurement |
| R3 | Extension matrix varies by TV vendor; a format or float target appears/disappears between sets | High | Medium | Feature detection at boot, asset variants (06), LDR fallback for post, uncompressed fallback, `requiredFeatures` refusal |
| R4 | Context loss on TV driver resets loses the scene or loops | Medium | High | Descriptor-based rebuild, epoch/generation invalidation, one fresh-device retry, one tier fallback, then failure screen; 10-minute soak row |
| R5 | Shader compilation stalls at load or on a cold driver cache | Medium | Medium | Compile at load, pipeline cache, `KHR_parallel_shader_compile` pre-warm, failure cache, ≤ 128 pipelines, pipeline-miss counter |
| R6 | CPU state-change overhead dominates on TV | Medium | High | State cache, fixed attribute locations, sorted draws, instancing, no per-frame allocation; profile on the M0 page |
| R7 | Texture-unit limits break PBR materials | Medium | Medium | Fixed slot assignment, material atlas, refuse over-budget materials at creation, LOD material paths |
| R8 | Two backends drift visually/semantically | High if unmanaged | High | Single contract, shared conformance, golden parity, feature flags, no backend-specific culling, no game branches on backend |
| R9 | Canvas2D entry grows 3D features "just in case" | Medium | Medium | 2D-only contract; 3D calls refused; parity goldens only for 2D games |
| R10 | Context-loss rebuild needs source bytes the asset was allowed to free | Medium | High | Scene retains `AssetHandle` for every texture; `TextureDesc.source` is retained by reference until `destroy`; 06 keeps decoded values alive while retained |
| R11 | Software WebGL2 on TV yields single-digit fps; the game looks broken | Medium | Medium | `failIfMajorPerformanceCaveat` default false to avoid a hard failure, but record the adapter/tier; the game may declare a performance floor later; failure screen is not the first answer |
| R12 | WebGPU/WebGL2 context-creation ordering produces `null` on some browsers | Medium | High | Probe on a disposable canvas or replace the host canvas after a WebGPU `configure()`; documented in §3.2 and tested in the selection matrix |
| R13 | Package size inflates the host bundle | Low–Medium | Medium | Zero runtime deps, no Three.js, shader sources are small, code-split `./canvas2d`; size row every wave |
| R14 | `generateMipmap` or uploads stall a frame on TV | Medium | Medium | Load-time mips, upload budget, compressed levels, `stats.uploadStalls`; never generate mips in the frame path |
| R15 | Driver bugs reject valid GL calls (validation errors) | Medium | Medium | Test on the named desktop + TV matrix; dev overlay surfaces the first GL error; no retry loop; document the Chrome version used for evidence |
| R16 | Dynamic resolution interacts badly with DPR/backing-store changes | Low–Medium | Medium | `resize` is idempotent, no resource reallocation on scale change, viewport-only change; acceptance includes 720p/1080p |
| R17 | The M0 boundary expands into PBR/shadows/post before the gate | High | High | §2 excludes them; 00 §5.14 lists them as deferred; a wave adding them is an M0 failure |

---

## Appendix A — WebGL2 context attributes (M0)

```
{
  alpha: false,
  depth: true,
  stencil: false,
  antialias: !tvProfile,          // default; caller may override
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
  desynchronized: true,           // hint only
  failIfMajorPerformanceCaveat: false
}
```

`preserveDrawingBuffer: false` is required for performance. Golden capture is a test-only path that renders and reads back within the same frame, before compositing.

## Appendix B — Milestone boundary for this backend

| Milestone | Included | Explicitly not included |
|---|---|---|
| M0 | Context/probe/tiers, device/frame, resources, pipelines, state cache, textured forward pass, one directional light, upload budget, context loss, Canvas2D 2D entry, failure screen, conformance, benchmark hooks | PBR, shadow maps, post, MSAA default-on, skinning, morphs, GPU particles, HDR, cubemaps, LOD switching |
| M1 | Metallic-roughness PBR, one shadow cascade + PCF, vertex-shader skinning (bone texture, 4 influences, 256 bones), cubemap IBL, FXAA | Compute, GPU culling, clustered lights, more than one shadow map |
| M2 | LDR post chain (tonemap/grade/FXAA), MSAA where useful, LOD consumption, UI pass integration | HDR without `EXT_color_buffer_float`; there is no software HDR path |
| M3 | Content-scale tuning, more shadow/LOD options only if measured | Ray tracing, compute-only effects |

A feature added to an earlier milestone than its row is scope creep; a feature added to a later milestone must not change the M0 contract.

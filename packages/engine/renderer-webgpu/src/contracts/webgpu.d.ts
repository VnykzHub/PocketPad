/**
 * WebGPU backend contract (spec 04 §3, §4.5, §4.8, §5.2, §5.5, §5.11).
 *
 * Types and the factory signature only. This wave ships no renderer
 * implementation, no WGSL and no GPU calls; the backend lands behind this
 * surface in a later wave.
 *
 * Backend-neutral types come from `@lanpad/engine-core` and are never
 * redeclared here: `RenderDevice`, `RenderFrame`, `GpuHandle`,
 * `TextureFormat`, `RendererCapabilities`, `EngineFeature`,
 * `RendererQualityTier`, `DeviceLimits`, `Surface`, `RendererSize`,
 * `MeshDesc`, `MaterialDesc`, `RenderTargetDesc`, the ABI constants and the
 * error codes have exactly one owner.
 */
import type {
  DeviceInitResult,
  MeshDesc,
  RenderDevice,
  RenderDeviceOptions,
  RendererCapabilities,
  TextureFormat,
} from "@lanpad/engine-core";

/**
 * Listener and result types owned by core, re-exported so a backend consumer
 * can type device-loss handling from this package without a second import.
 * Re-export only; do not redeclare (04 §4.9).
 */
export type {
  DeviceLostListener,
  RestoreResult,
  RestoredListener,
} from "@lanpad/engine-core";

/**
 * Canvas formats WebGPU may select for the swapchain (04 §5.2 step 7,
 * `getPreferredCanvasFormat`). `bgra8unorm` is the preferred format; it is
 * not required as an upload or render-target format on the WebGL2 Tier B
 * backend (04 §4.5).
 */
export type WebGpuCanvasFormat = "bgra8unorm" | "rgba8unorm";

/**
 * Device lifecycle state. `running`, `lost`, `restoring` and `failed` are the
 * state machine named in 04 §5.11. `uninitialized` is the state before
 * `init()` (04 §5.2 must complete before any create call) and `disposed` is
 * the endpoint after the idempotent `dispose()` (04 §5.9); neither is in the
 * §5.11 diagram because the diagram starts once the device exists.
 */
export type WebGpuDeviceState =
  | "uninitialized"
  | "running"
  | "lost"
  | "restoring"
  | "failed"
  | "disposed";

/**
 * Adapter power preference passed to `requestAdapter` (04 §5.2 step 2).
 * The implementation retries once with `"low-power"` only when the first
 * call throws, never when it returns a null adapter.
 */
export type WebGpuPowerPreference = "high-performance" | "low-power";

/**
 * Options for the WebGPU backend (04 §3.2 plus §5.2 step 2).
 *
 * The canvas is not an option: it arrives through `Surface.native` in
 * `RenderDevice.init(surface, options)` (04 §3.2, §5.2 step 7). Adding a
 * second canvas source here would let the two disagree.
 */
export interface WebGpuDeviceOptions extends RenderDeviceOptions {
  /** Default `"high-performance"` (04 §5.2 step 2). */
  readonly powerPreference?: WebGpuPowerPreference;
}

/**
 * Capability report for a WebGPU adapter (04 §3.2, §5.2 step 6).
 * `supportedFormats` and `features` are inherited; this type only pins the
 * backend token so callers can narrow without a cast.
 */
export interface WebGpuCapabilities extends RendererCapabilities {
  readonly backend: "webgpu";
}

/**
 * The WebGPU render device (04 §3.2, §3.6, §5.1).
 *
 * It adds only WebGPU-specific read-only members. `restore()`,
 * `onDeviceLost()`, `onRestored()` and the restore-result shape are already
 * part of core's `RenderDevice` and are not redeclared.
 */
export interface WebGpuDevice extends RenderDevice {
  readonly backend: "webgpu";
  readonly capabilities: WebGpuCapabilities;
  /**
   * Display-only, sanitized adapter text (04 §5.2 step 6). It never contains
   * URLs or tokens; when the browser omits adapter info it is
   * `"WebGPU adapter"`.
   */
  readonly adapterInfo: string;
  /** Format chosen when the swapchain is configured (04 §5.2 step 7). */
  readonly canvasFormat: WebGpuCanvasFormat;
  /** Current lifecycle state (04 §5.11). */
  readonly deviceState: WebGpuDeviceState;
}

/**
 * Result of `createWebGpuDevice` (04 §3.2, §3.6).
 *
 * Core's `DeviceInitResult` is generic over the device; `capabilities` is
 * narrowed to `WebGpuCapabilities` and `adapterInfo` is inherited as the
 * display-only string.
 */
export interface WebGpuDeviceInitResult extends DeviceInitResult<WebGpuDevice> {
  readonly backend: "webgpu";
  readonly capabilities: WebGpuCapabilities;
}

/**
 * Creates the WebGPU backend and acquires its adapter/device (04 §3.6,
 * §5.2). The runtime still calls `init(surface, options)` before any create
 * call; the surface supplies the canvas.
 *
 * Declared, not implemented: this contract wave emits no runtime value for
 * the factory.
 */
export function createWebGpuDevice(
  options?: WebGpuDeviceOptions,
): Promise<WebGpuDeviceInitResult>;

/**
 * The type of the `createWebGpuDevice` export, usable as a value type by the
 * runtime's backend selector without a `typeof` import.
 */
export type WebGpuDeviceFactory = typeof createWebGpuDevice;

/**
 * Built-in pipeline layouts in ABI 1 (04 §5.5). Adding a group or changing a
 * binding is an ABI bump.
 */
export type PipelineLayoutId =
  | "builtin-pbr-v1"
  | "builtin-shadow-v1"
  | "builtin-post-v1"
  | "builtin-2d-v1";

/**
 * Fields of the shader-module cache key tuple (04 §4.2, §4.8):
 * `(language, stage, entryPoint, abiVersion, definesCanonical, code)`.
 * Production hashes the tuple; dev additionally compares the full tuple.
 */
export interface ShaderModuleKeyParts {
  readonly language: "wgsl";
  readonly stage: "vertex" | "fragment" | "compute";
  readonly entryPoint: string;
  readonly abiVersion: 1;
  /** Canonical form of `ShaderModuleDesc.defines` (04 §4.8). */
  readonly definesCanonical: string;
  /** UTF-8 WGSL source, at most 64 KiB. */
  readonly code: string;
}

/**
 * A shader-module cache key. Its encoding is implementation-owned; equality
 * is equality of the `ShaderModuleKeyParts` tuple (04 §4.2).
 */
export type ShaderModuleKey = string;

/**
 * Render-state primitive block for a built-in pipeline (04 Appendix C).
 * Alpha-to-coverage, wireframe, polygon offset and conservative raster are
 * off in ABI 1 and have no field.
 */
export interface PipelinePrimitiveState {
  readonly topology: "triangle-list";
  readonly cullMode: "none" | "back";
  /** Front face is counter-clockwise; `doubleSided` materials use `"none"`. */
  readonly frontFace: "ccw";
}

/**
 * Depth block for a built-in pipeline (04 Appendix C). `format` is `"none"`
 * for the fullscreen post pipeline, where `compare` is `null` and
 * `writeEnabled` is false.
 */
export interface PipelineDepthState {
  readonly format: "none" | "depth24plus" | "depth32float";
  readonly compare: "less" | "less-equal" | null;
  readonly writeEnabled: boolean;
}

/**
 * Blend block for a built-in pipeline (04 Appendix C): `"off"` for opaque,
 * mask, shadow and post; `"src-alpha-one-minus-src-alpha"` for `blend`
 * materials (add operation).
 */
export type PipelineBlendState =
  | "off"
  | "src-alpha-one-minus-src-alpha";

/**
 * Inputs to the canonical pipeline cache key, in the 04 §4.8 concatenation
 * order:
 * `version | vertexShaderKey | fragmentShaderKey | vertexLayout |
 * primitiveState | depthState | multisample | colorFormats | blendStates |
 * layoutId | definesCanonical`.
 *
 * The version field is `PIPELINE_CACHE_VERSION` (see `src/version.ts`) and is
 * not repeated here.
 */
export interface PipelineKeyInputs {
  readonly vertexShaderKey: ShaderModuleKey;
  readonly fragmentShaderKey: ShaderModuleKey;
  readonly vertexLayout: MeshDesc["layout"];
  readonly primitiveState: PipelinePrimitiveState;
  readonly depthState: PipelineDepthState;
  /** `1` in M0; `1` or `4` when MSAA lands (04 §4.10). */
  readonly multisample: 1 | 4;
  /** One entry per colour attachment; the swapchain format in the M0 path. */
  readonly colorFormats: readonly TextureFormat[];
  /** One entry per colour attachment (04 §4.8 names this field `blendStates`). */
  readonly blendStates: readonly PipelineBlendState[];
  readonly layoutId: PipelineLayoutId;
  readonly definesCanonical: string;
}

/**
 * Serialized pipeline cache key (04 §4.8).
 *
 * `canonical` is the full UTF-8 key string, at most 4 KiB, stored in the
 * cache for equality. `hash` is the FNV-1a 32 stats label; it is never used
 * for equality. The exact separator and escaping are not frozen by 04, so
 * conformance asserts equality relations, not literal strings.
 */
export interface PipelineCacheKey {
  readonly canonical: string;
  readonly hash: number;
}

/**
 * WebGL2 backend contract (spec 05 §3; renderer ABI 1 from spec 04 §4.3).
 *
 * The implementation lives in `src/**`; this file is the frozen public contract.
 * The backend-neutral types — `RenderDevice`, `RenderFrame`, `EngineFeature`,
 * `RendererCapabilities`, `DeviceLimits`, `MeshDesc`, `MaterialDesc`,
 * `TextureFormat`, the GPU handles, the ABI constants and the error codes —
 * are owned by `@lanpad/engine-core` (specs 00/04) and imported here. This
 * file must never redeclare them.
 *
 * The `./canvas2d` entry has its own contract file so a 2D-only build never
 * pulls the 3D WebGL2 shader set (05 §3.1).
 */

import type {
  DeviceInitResult,
  EngineFeature,
  RenderDevice,
  RenderDeviceOptions,
  RendererCapabilities,
  TextureFormat,
} from "@lanpad/engine-core";

/** Tier classification from 05 §3.3. Higher tiers are supersets of lower ones. */
export type WebGL2Tier = "extended" | "standard" | "minimal";

/**
 * WebGL2 device limits read once by the probe (05 §3.3). This is the backend
 * conformance profile; the backend-neutral `DeviceLimits` stays in core.
 */
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

/**
 * Fixed design caps from 05 §4.5. They are derived from WebGL2 minimums and
 * are not device measurements; `WEBGL2_DESIGN_CAPS` is the runtime copy.
 */
export interface WebGL2DesignCaps {
  readonly maxBones: number;
  readonly maxDirectionalLights: number;
  readonly maxPointLights: number;
  readonly maxShadowMaps: number;
}

/**
 * WebGL2 conformance profile of the core capability record (05 §3.3).
 *
 * `RendererCapabilities` is the frozen game-facing shape owned by 04. This
 * profile adds the probe observations and the §4.5 design caps; it is not a
 * second capability contract. It extends the core record because
 * `RenderDevice.capabilities` requires that record and 05 §3.2 declares the
 * device as a `RenderDevice`.
 *
 * `vendor`/`renderer`/`glVersion`/`shadingLanguageVersion` are display-only;
 * they are recorded locally in RESULTS and never transmitted.
 */
export interface WebGL2Capabilities
  extends RendererCapabilities,
    WebGL2DesignCaps {
  readonly available: true;
  readonly vendor: string;
  readonly renderer: string;
  readonly glVersion: string;
  readonly shadingLanguageVersion: string;
  readonly tier: WebGL2Tier;
  readonly extensions: readonly string[];
  readonly limits: WebGL2Limits;
}

/** Result of `probeWebGL2` (05 §3.3). A failure is data, never a throw. */
export interface WebGL2Probe {
  readonly available: boolean;
  readonly reason?: "no-context" | "context-threw" | "blocked";
  readonly capabilities?: WebGL2Capabilities;
}

/**
 * Resolved context attributes (05 Appendix A). The device calls
 * `getContext("webgl2", ...)` exactly once with this set.
 */
export interface WebGL2ContextAttributes {
  readonly alpha: false;
  readonly depth: boolean;
  readonly stencil: boolean;
  readonly antialias: boolean;
  readonly premultipliedAlpha: true;
  readonly preserveDrawingBuffer: false;
  readonly powerPreference: "high-performance" | "default" | "low-power";
  readonly desynchronized: boolean;
  readonly failIfMajorPerformanceCaveat: boolean;
}

/**
 * Construction options (05 §3.2) plus the quality options the backend-neutral
 * `init` accepts (04 §3.2 / core `RenderDeviceOptions`: `quality`,
 * `maxTextureBytes`, `shadowCascades`, `post`, `maxRenderHeight`, …).
 */
export interface WebGL2DeviceOptions extends RenderDeviceOptions {
  /** The host canvas. The device calls `getContext("webgl2")` exactly once. */
  readonly canvas: HTMLCanvasElement;
  /** Default false on the TV profile, true otherwise. */
  readonly antialias?: boolean;
  /** Fixed false in v1: the page owns the background. */
  readonly alpha?: false;
  /** Default true. */
  readonly depth?: boolean;
  /** Default false; M2 UI masks may enable. */
  readonly stencil?: boolean;
  /** Default "high-performance". */
  readonly powerPreference?: "high-performance" | "default" | "low-power";
  /** Chromium hint; silently ignored when unsupported. */
  readonly desynchronized?: boolean;
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

/**
 * Concrete WebGL2 device (05 §3.2). It implements the frozen `RenderDevice`
 * surface unchanged and adds only the GL-specific readonly members below.
 * `restore`, `onDeviceLost` and `onRestored` are inherited from core.
 *
 * A canvas can hold only one context type: the runtime must attempt WebGPU
 * first and replace the canvas if WebGPU already configured it, before calling
 * `createWebGL2Device` (05 §3.2).
 */
export interface WebGL2Device extends RenderDevice {
  readonly backend: "webgl2";
  readonly capabilities: WebGL2Capabilities;
  /** The attributes the context was created with (05 Appendix A). */
  readonly contextAttributes: WebGL2ContextAttributes;
  /** Snapshot of the probe's extension names; equals `capabilities.extensions`. */
  readonly extensions: readonly string[];
  /** Increments on every context loss; old handles are stale after a bump. */
  readonly contextEpoch: number;
  readonly lost: boolean;
}

/**
 * One row of the Tier B texture-format mapping (05 §4.4). The key is the
 * canonical core `TextureFormat` token; this is data about the mapping, not a
 * second format union. The checked-in data lives in
 * `test/fixtures/texture-format-map.json`.
 */
export interface WebGL2TextureFormatEntry {
  readonly status: "core" | "extension" | "unsupported";
  /** WebGL2 internalformat token; null when the token is unsupported. */
  readonly internalFormat: string | null;
  /** GL extension required for upload/sampling, or null for a core format. */
  readonly extension: string | null;
  /** Extra extension required only for render-target use (float formats). */
  readonly renderTargetExtension: "EXT_color_buffer_float" | null;
  readonly notes: string;
}

/**
 * The exact Tier B format table, keyed by every canonical core token. A
 * `Record<TextureFormat, …>` makes an omitted or invented token a type error.
 */
export type WebGL2TextureFormatMap = Readonly<
  Record<TextureFormat, WebGL2TextureFormatEntry>
>;

/** Benchmark fields spec 19 consumes (05 §4.7). No field is a measurement. */
export interface WebGL2BenchSample {
  readonly backend: "webgl2";
  /** `capabilities.renderer`. */
  readonly adapter: string;
  readonly tier: WebGL2Tier;
  readonly frames: number;
  readonly warmupFrames: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly textureBytes: number;
  readonly pipelineMisses: number;
  readonly contextLosses: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
}

/** Failure-screen codes owned by 05 §3.5. */
export type BackendFailureCode =
  | "E_DEVICE_UNAVAILABLE"
  | "E_BACKEND_INIT"
  | "E_UNSUPPORTED_FEATURE"
  | "E_DEVICE_LOST"
  | "E_RENDERER_UNAVAILABLE";

/**
 * Failure-screen content (05 §3.5). The host owns the DOM element, focus and
 * remote bindings; this package owns the copy. It must contain no tokens, room
 * codes, player names, filesystem paths or credentialed URLs.
 */
export interface BackendFailureNotice {
  readonly code: BackendFailureCode;
  readonly title: string;
  readonly message: string;
  readonly missingFeatures: readonly EngineFeature[];
  readonly hints: readonly string[];
  readonly canRetry: boolean;
  /** Machine token, e.g. "3d-on-canvas2d". */
  readonly detail: string;
}

/**
 * Browser probe (05 §3.3). Creates at most one context on the supplied canvas
 * or factory and must not lock the host canvas before backend selection. A
 * missing, throwing or blocked context returns `available: false`; it never
 * throws.
 */
export function probeWebGL2(
  canvas: HTMLCanvasElement | (() => HTMLCanvasElement | null),
): WebGL2Probe;

/**
 * Pure tier/feature classifier (05 §3.3). Node-safe; used by the probe and by
 * CI. Deterministic and monotone: adding an extension or raising a limit can
 * never lower the tier.
 */
export function classifyWebGL2(input: {
  readonly limits: WebGL2Limits;
  readonly extensions: readonly string[];
}): {
  readonly tier: WebGL2Tier;
  readonly features: ReadonlySet<EngineFeature>;
};

/**
 * Result of `createWebGL2Device`. Mirrors the WebGPU factory: the init result
 * carries the device, its narrowed capabilities and the display-only adapter
 * string, so the runtime can select a backend with one signature.
 */
export interface WebGL2DeviceInitResult extends DeviceInitResult<WebGL2Device> {
  readonly backend: "webgl2";
  readonly capabilities: WebGL2Capabilities;
}

/**
 * Creates and initialises the WebGL2 device. Rejects with an `EngineError`
 * whose code is `E_BACKEND_INIT` when the context cannot be created or the
 * initial GL state cannot be established; it never returns a partially working
 * device and never lets a raw browser exception reach a game (05 §3.2).
 */
export function createWebGL2Device(
  options: WebGL2DeviceOptions,
): Promise<WebGL2DeviceInitResult>;

/**
 * Features the game requires that the device lacks, in declaration order
 * (05 §3.4). The runtime refuses with `E_UNSUPPORTED_FEATURE` before
 * `game.init` when this is non-empty.
 */
export function missingFeatures(
  required: readonly EngineFeature[],
  available: ReadonlySet<EngineFeature>,
): EngineFeature[];

/** Fixed failure sentence for a missing feature (05 §3.4). */
export function describeMissingFeature(feature: EngineFeature): string;

/** Builds the fixed-copy failure notice (05 §3.5). */
export function createBackendFailureNotice(input: {
  readonly code: BackendFailureCode;
  readonly browserName: string;
  readonly backendTried: "webgpu" | "webgl2" | "canvas2d" | "none";
  readonly gameName?: string;
  readonly missingFeatures?: readonly EngineFeature[];
  readonly detail?: string;
}): BackendFailureNotice;

type ContractAssert<T extends true> = T;

/**
 * Compile-time assignability check: the WebGL2 contract satisfies the frozen
 * core `RenderDevice`. This alias fails typecheck (via the `ContractAssert`
 * constraint) if the two contracts drift.
 */
export type WebGL2DeviceIsRenderDevice = ContractAssert<
  WebGL2Device extends RenderDevice ? true : false
>;

/**
 * Engine-wide contracts owned by spec 00 (`docs/engine/00-architecture.md`).
 *
 * Frozen surface: additive changes only. A rename or semantic change requires
 * an amendment and a version bump. This file declares types; it contains no
 * implementation.
 */

/**
 * Error code union (00 §5.9). Codes may be added, never removed.
 *
 * `E_SCENE_FORMAT` (03 §3.8, snapshot/prefab validation) and `E_FRAME_CLOSED`
 * (04, draw after `endFrame()`) are referenced by contracts in this package
 * but are absent from the 00 §5.9 literal. They are additive codes, recorded
 * as a W0 ambiguity; do not remove either.
 *
 * The `E_WORLD_*`, `E_CELL_*`, `E_STREAM_*` and `E_STATE_*` codes are named
 * by spec 12 (§3.4, §4.1, §4.2, §5.5, §5.7, §9) and were likewise absent
 * from the 00 §5.9 literal. They are canonical here so
 * `@lanpad/engine-streaming` derives its public code type from this union
 * instead of redeclaring a parallel string list.
 */
export type EngineErrorCode =
  | "E_DEVICE_UNAVAILABLE"
  | "E_DEVICE_LOST"
  | "E_BACKEND_INIT"
  | "E_PIPELINE_COMPILE"
  | "E_UNSUPPORTED_FEATURE"
  | "E_ASSET_LOAD"
  | "E_ASSET_FORMAT"
  | "E_ASSET_BUDGET"
  | "E_ASSET_HASH"
  | "E_ASSET_NOT_READY"
  | "E_ASSET_UNKNOWN"
  | "E_ASSET_ABORTED"
  | "E_ASSET_UNSUPPORTED"
  | "E_ASSET_EVICTED"
  | "E_INPUT_FORMAT"
  | "E_INPUT_CONFLICT"
  | "E_INPUT_RESERVED"
  | "E_INPUT_CAPTURE"
  | "E_INPUT_TICK"
  | "E_INPUT_DEVICE"
  | "E_AUDIO_DEVICE"
  | "E_AUDIO_DECODE"
  | "E_AUDIO_FORMAT"
  | "E_AUDIO_BUDGET"
  | "E_SCENE_INVALID"
  | "E_SCENE_FORMAT"
  | "E_STALE_HANDLE"
  | "E_SAVE_FORMAT"
  | "E_SAVE_VERSION"
  | "E_SAVE_HASH"
  | "E_SAVE_GAME"
  | "E_SAVE_QUOTA"
  | "E_SAVE_IO"
  | "E_SAVE_MIGRATION"
  | "E_SAVE_SLOT"
  | "E_SAVE_UNSUPPORTED"
  | "E_WORLD_FORMAT"
  | "E_WORLD_ID"
  | "E_WORLD_SEED"
  | "E_WORLD_CELL_SIZE"
  | "E_WORLD_GRID"
  | "E_WORLD_KEY"
  | "E_WORLD_DUPLICATE"
  | "E_WORLD_HOLE"
  | "E_WORLD_URL"
  | "E_WORLD_LOD3"
  | "E_WORLD_LOD_BANDS"
  | "E_WORLD_BUDGET"
  | "E_WORLD_ENTRY"
  | "E_CELL_FORMAT"
  | "E_CELL_HASH"
  | "E_CELL_SECTION"
  | "E_CELL_KIND"
  | "E_CELL_SIZE"
  | "E_CELL_APPLY"
  | "E_STREAM_FETCH"
  | "E_STREAM_DECOMPRESS"
  | "E_STREAM_BUDGET"
  | "E_STREAM_SIM_BUDGET"
  | "E_STREAM_PIN_BUDGET"
  | "E_STREAM_ABORT"
  | "E_STREAM_STATE"
  | "E_STREAM_DISPOSED"
  | "E_STATE_FORMAT"
  | "E_STATE_WORLD"
  | "E_STATE_BOUNDS"
  | "E_STATE_ORDER"
  | "E_STATE_HASH"
  | "E_WORKER_FAILED"
  | "E_FRAME_CLOSED"
  | "E_CONTRACT";

/**
 * Public shape of the engine error (00 §5.9). W1 exports the concrete
 * `EngineError` class; this declaration fixes the fields every occurrence
 * must carry.
 */
export interface EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly layer:
    | "core"
    | "assets"
    | "renderer"
    | "physics"
    | "animation"
    | "audio"
    | "input"
    | "ai"
    | "streaming"
    | "ui"
    | "host";
  readonly recoverable: boolean;
}

/** Queue priority (01 §3.6): `critical` is reserved for boot assets. */
export type JobPriority = "critical" | "normal" | "idle";

export type JobKind =
  | "decode-gltf"
  | "decode-ktx2"
  | "decode-image"
  | "decode-audio"
  | "build-atlas"
  | "build-navmesh"
  | "compress-save"
  | "hash-bytes";

/**
 * Payload passed to a worker (01 §3.6 names this type but does not define its
 * field shape; 01 §5.7 limits values to ArrayBuffer, typed arrays, strings,
 * numbers and plain records of those). The value stays `unknown` so the
 * contract does not invent a shape; the `T` parameter mirrors `Job<T>` (01
 * declares that generic but never uses it inside the interface) and
 * contributes no member. `unknown | T` is `unknown` for every `T`.
 */
export type JobPayload<T = unknown> = unknown | T;

export interface Job<T = unknown> {
  readonly kind: JobKind;
  readonly priority?: JobPriority;
  readonly payload: JobPayload<T>;
  readonly signal?: AbortSignal;
  transfer?: Transferable[];
}

export interface JobHandle {
  /** Monotonic u32, never reused. */
  readonly id: number;
  readonly kind: JobKind;
  cancel(): void;
  readonly state: "queued" | "running" | "done" | "cancelled" | "failed";
}

export interface JobResult<T = unknown> {
  readonly id: number;
  readonly kind: JobKind;
  readonly ok: boolean;
  readonly value?: T;
  readonly errorCode?: "E_WORKER_FAILED" | "E_ASSET_FORMAT" | "E_ASSET_LOAD";
  readonly errorMessage?: string;
}

export interface JobSystem {
  schedule<T>(job: Job<T>): JobHandle;
  cancel(handle: JobHandle): void;
  /** Moves completed results into `out`, sorted by ascending job id. */
  drainCompleted(out: JobResult[]): JobResult[];
  readonly pending: number;
  readonly running: number;
  dispose(): void;
}

/**
 * Save-header fields (00 §3.5). The on-disk header is a 40-byte little-endian
 * prefix plus UTF-8 `gameId`/`gameVersion` and zero padding to 8 bytes.
 */
export interface SaveHeaderFields {
  /** Currently 1. */
  readonly formatVersion: number;
  readonly engineMajor: number;
  readonly engineMinor: number;
  readonly enginePatch: number;
  /** 1..64 UTF-8 bytes. */
  readonly gameId: string;
  /** 1..32 UTF-8 bytes. */
  readonly gameVersion: string;
  /** Save wall-clock time as integer epoch seconds, not simulation time. */
  readonly createdAtUnixSeconds: number;
  /** Compressed payload length. */
  readonly payloadBytes: number;
  /** 0 when uncompressed. */
  readonly payloadUncompressedBytes: number;
  /** FNV-1a 32 over the stored payload. */
  readonly payloadHash: number;
  /** Bit 0 = payload deflated; bits 1..15 reserved and 0. */
  readonly flags: number;
}

/**
 * Engine version (00 §4.1). Lockstep across all `@lanpad/engine-*` packages.
 * The runtime value lives in `src/version.ts` and must equal this literal.
 */
export const ENGINE_VERSION: "0.1.0";

/** Actual CSS-pixel drawing size (04 §3.2). */
export interface RendererSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Platform-owned drawing surface (04 §3.2). `native` is opaque here so no DOM
 * type crosses the engine contract; only a renderer backend may read it.
 */
export interface Surface {
  readonly kind: "canvas";
  readonly native: unknown;
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
}

/** Device limits reported by the active backend (04 §3.2). */
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

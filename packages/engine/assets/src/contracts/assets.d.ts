/**
 * Asset contracts owned by spec 06 (`docs/engine/06-assets.md`).
 *
 * Frozen surface (06 §3.1) plus the additive members 06 §3.2–§3.5 define.
 * This file declares types and one factory signature; it contains no
 * implementation. W1 adds loaders, workers and the runtime factory behind
 * these declarations without changing the frozen members.
 *
 * Shared types come from `@lanpad/engine-core`. Core error codes and
 * `GpuHandle` are referenced, never redefined here.
 */

import type {
  BoundingSphere,
  EngineErrorCode,
  TextureLevel,
} from "@lanpad/engine-core";

/** 06 §3.1. The eight kinds a manifest entry may declare. */
export type AssetKind =
  | "mesh"
  | "texture"
  | "material"
  | "audio"
  | "font"
  | "json"
  | "scene"
  | "animation";

/** 06 §3.1. */
export type AssetState = "queued" | "loading" | "ready" | "failed" | "disposed";

/**
 * Error codes the asset layer can surface (06 §3.7).
 *
 * The `Extract` branch re-exports the matching members of core's frozen
 * `EngineErrorCode`; it is not a parallel namespace. The five additive
 * `E_ASSET_*` codes are now in core (00 §5.9), so they flow through the same
 * `Extract`. `E_UNSUPPORTED_FEATURE` (06 §4.6) and `E_STALE_HANDLE`
 * (06 §3.2, §5.11) are included because the spec throws both from this layer
 * even though the §3.7 table does not list them.
 */
export type AssetErrorCode = Extract<
  EngineErrorCode,
  | `E_ASSET_${string}`
  | "E_WORKER_FAILED"
  | "E_UNSUPPORTED_FEATURE"
  | "E_STALE_HANDLE"
>;

/**
 * A failed load or decode (06 §3.3, §5.11). 06 names the type but does not
 * define its fields; this is the minimum shape its rules require — the asset
 * id, the code, a redacted message and whether a later `load` may retry.
 */
export interface AssetFailure {
  readonly id: string;
  readonly code: AssetErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Reference-counted asset handle (06 §3.1 frozen members, §3.2 additive
 * members).
 *
 * `value` is a getter in the implementation: it returns the decoded value
 * only when `state === "ready"` and throws `E_ASSET_NOT_READY` otherwise;
 * after disposal it throws `E_STALE_HANDLE`. The library holds no reference
 * to the handle: `load` returns refcount 1 for the caller, `get` adds none.
 */
export interface AssetHandle<T = unknown> {
  /** Stable manifest id, e.g. "meshes/sedan". */
  readonly id: string;
  readonly kind: AssetKind;
  readonly state: AssetState;
  /** Valid only when `state === "ready"`; see the throw rules above. */
  readonly value: T;
  /** +1 reference; returns this. Throws `E_STALE_HANDLE` when disposed (dev). */
  retain(): AssetHandle<T>;
  /** -1 reference; at 0 the library may evict on `trim()`. */
  release(): void;
  /** Starts at 1; incremented by a hot-reload swap. */
  readonly revision: number;
  /** Decoded bytes charged for this value. */
  readonly bytes: number;
  /** 0 except for texture values; the planned GPU cost (06 §4.9). */
  readonly textureGpuBytes: number;
  readonly failed: AssetFailure | null;
}

/** 06 §3.3. */
export interface AssetLoadOptions {
  /** Caller cancellation. */
  readonly signal?: AbortSignal;
  /** Default "background"; "boot" bypasses the concurrency queue. */
  readonly priority?: "boot" | "background";
  /** Default options.fetchTimeoutMs (30_000). */
  readonly timeoutMs?: number;
}

/** 06 §3.3. */
export interface AssetGroupResult {
  readonly handles: readonly AssetHandle[];
  readonly failures: readonly AssetFailure[];
}

/**
 * Byte-accurate progress for the active batch (06 §3.3, §4.4). `fetched`
 * counts bytes read from response bodies; `declared` is the sum of selected
 * variant bytes; audio stream URLs contribute 0 to `declared`.
 */
export interface AssetProgress {
  readonly fetched: number;
  readonly declared: number;
  readonly determinate: boolean;
  readonly state: "idle" | "loading" | "ready" | "failed";
  readonly loadedCount: number;
  readonly totalCount: number;
  readonly currentId: string | null;
}

/**
 * Per-game declared budget (06 §4.2). 06 names the manifest `budget` field
 * but not its type; these are exactly its two fields.
 */
export interface AssetManifestBudget {
  /** Positive integer; must cover every `initial: true` entry's default bytes. */
  readonly initialBytes: number;
  /** Must be ≥ initialBytes and ≥ the sum of every entry's `bytes`. */
  readonly totalBytes: number;
}

/**
 * One declared asset (06 §4.2).
 *
 * `url` rules (06 §4.3): same-origin, relative, at most 512 characters, no
 * scheme/host, no `//`, no `.` or `..` segment, no `?`, no `#`, no backslash,
 * no percent-encoded dot, and it must end with the extension implied by the
 * kind/container. `id` is unique and matches
 * `^[a-z0-9][a-z0-9/_.-]{0,127}$`.
 */
export interface AssetManifestEntry {
  readonly id: string;
  readonly kind: AssetKind;
  readonly url: string;
  /** Positive integer ≤ 268,435,456; must equal the response body length. */
  readonly bytes: number;
  /** Optional `fnv1a32:[0-9a-f]{8}`; verified only in development. */
  readonly hash?: string;
  /** Member of the boot set (SPEC FR-9.6). */
  readonly initial?: boolean;
  /** Unit of `loadGroup`; `^[a-z0-9][a-z0-9-]{0,31}$`. */
  readonly group?: string;
  /** Ids that must load first; ≤ 16, acyclic, no self-reference. */
  readonly dependencies?: readonly string[];
  /** ≤ 8 ordered variants; first qualifying variant wins (06 §5.4). */
  readonly variants?: readonly AssetVariant[];
  /** Audio only; forces stream vs buffer (06 §4.10). */
  readonly streaming?: boolean;
  /** Audio container hint; must agree with the URL extension. */
  readonly mimeType?: AudioMimeType;
  /** Audio only; positive number used for display and stream routing. */
  readonly durationSeconds?: number;
  /** Flat tooling metadata; ≤ 16 keys, values ≤ 256 characters. */
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}

/** 06 §4.2. */
export interface AssetManifest {
  /** Exactly 1 (ASSET_MANIFEST_VERSION). An unknown version is refused. */
  readonly formatVersion: 1;
  /** `^[a-z0-9][a-z0-9._-]{0,63}$`; must equal options.gameId. */
  readonly id: string;
  readonly budget: AssetManifestBudget;
  /** ≤ 4096 entries; unique ids. */
  readonly assets: readonly AssetManifestEntry[];
}

/**
 * Renderer-relevant capability tokens (06 §3.6). Strings are contract
 * tokens; do not rename them. They mirror the renderer subset of
 * `EngineFeature` and are intentionally a subset of that union.
 */
export type AssetCapability =
  | "compressed-s3tc"
  | "compressed-etc2"
  | "compressed-astc"
  | "texture-array"
  | "float-render-target";

/** 06 §3.6. */
export type AssetContainer =
  | "glb"
  | "ktx2"
  | "webp"
  | "png"
  | "ogg"
  | "webm"
  | "m4a"
  | "wav"
  | "woff2";

/** 06 §3.6. Selection is deterministic and follows manifest order. */
export interface AssetVariant {
  /** Same rules as AssetManifestEntry.url. */
  readonly url: string;
  readonly bytes: number;
  /** All listed capabilities must be present for the variant to qualify. */
  readonly requires?: readonly AssetCapability[];
  readonly container?: AssetContainer;
  /** Texture only; must match the container header. */
  readonly format?: AssetTextureFormat;
  /** Audio only. */
  readonly mimeType?: AudioMimeType;
  readonly hash?: string;
}

/**
 * Persistent cache seam (06 §5.8, M1). Keys are
 * `lanpad-assets-v1:<gameId>:<fnv1a32>`; only hashed entries are stored.
 */
export interface AssetCache {
  match(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Dev-only reload seam (06 §5.7). */
export interface HotReloadSource {
  /** Called with manifest-relative urls or asset ids that changed. */
  subscribe(listener: (changed: readonly string[]) => void): () => void;
}

/** 06 §5.7. */
export interface AssetReloadEvent {
  readonly id: string;
  readonly revision: number;
  readonly kind: AssetKind;
}

/**
 * Minimal worker seam used by `workerFactory` (06 §3.4, §5.6). 06 names the
 * type but not its fields; this is the smallest surface the decode pool
 * needs. A module `Worker` is adapted to it by the implementation.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  terminate(): void;
}

/**
 * Worker decode request (06 §5.1, §5.6 names the worker boundary but not the
 * message fields). `bytes` is transferred, not copied. `container` is absent
 * for JSON and material payloads, which are parsed on the main thread.
 */
export interface AssetDecodeRequest {
  readonly jobId: number;
  readonly id: string;
  readonly kind: AssetKind;
  readonly container?: AssetContainer;
  readonly bytes: ArrayBuffer;
  /** Audio only; the container hint from the manifest. */
  readonly mimeType?: AudioMimeType;
}

/**
 * Worker decode result (06 §5.1, §5.6 names the worker boundary but not the
 * message fields). On success `value` is set and every owned ArrayBuffer is
 * in the transfer list. On failure `errorCode`/`errorMessage` are set.
 * `droppedAttributes` is mesh-only (06 §4.5); `gpuBytes` is texture-only
 * (06 §4.9).
 */
export interface AssetDecodeResult<T = unknown> {
  readonly jobId: number;
  readonly ok: boolean;
  readonly value?: T;
  readonly errorCode?: AssetErrorCode;
  readonly errorMessage?: string;
  readonly droppedAttributes?: number;
  readonly gpuBytes?: number;
}

/**
 * Construction options (06 §3.4). All budgets are checked before a fetch or
 * decode starts. `fetch` is an additive test/embedding seam requested by the
 * W0 contract task; 06 §3.4 does not list it, and production defaults to
 * `globalThis.fetch`.
 */
export interface AssetLibraryOptions {
  /** Must equal manifest.id. */
  readonly gameId: string;
  /** e.g. "/games/demo/asset-manifest.json". */
  readonly manifestUrl: string;
  /** Defaults to the directory of manifestUrl; all asset URLs resolve here. */
  readonly baseUrl?: string;
  /** Variant preference; default "high". */
  readonly quality?: "low" | "medium" | "high";
  /** From renderer.features; absent means no compressed variants. */
  readonly capabilities?: ReadonlySet<AssetCapability>;
  /** Default 134_217_728 (128 MiB, provisional). */
  readonly textureBudgetBytes?: number;
  /** Default 100_663_296 desktop / 67_108_864 TV (provisional). */
  readonly decodedBudgetBytes?: number;
  /** Default 268_435_456 (256 MiB ceiling, provisional). */
  readonly maxTotalBytes?: number;
  /** Default 6. */
  readonly maxConcurrentFetches?: number;
  /** Default min(4, max(1, hardwareConcurrency - 1)). */
  readonly maxDecodeWorkers?: number;
  /** Default 30_000. */
  readonly fetchTimeoutMs?: number;
  /** Default false; the runtime passes true in development. */
  readonly verifyHashes?: boolean;
  /** Default false; compiled out of production. */
  readonly hotReload?: boolean;
  readonly hotReloadSource?: HotReloadSource;
  /** Default undefined (M1). */
  readonly persistentCache?: AssetCache;
  /** Tests. */
  readonly now?: () => number;
  /** Tests; production uses module workers. */
  readonly workerFactory?: () => WorkerLike;
  /** Test/embedding injection; defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The asset library (06 §3.1 frozen members, §3.3 additive members).
 *
 * `loadedBytes` counts CPU-decoded bytes only; metadata source bytes are
 * reported separately in `metadataBytes`. `textureBytes` is the planned GPU
 * cost of live texture values.
 */
export interface AssetLibrary {
  load<T>(id: string, options?: AssetLoadOptions): Promise<AssetHandle<T>>;
  get<T>(id: string): AssetHandle<T> | undefined;
  readonly loadedBytes: number;
  readonly budgetBytes: number;
  readonly progress: AssetProgress;

  loadGroup(group: string, options?: AssetLoadOptions): Promise<AssetGroupResult>;
  loadInitial(options?: AssetLoadOptions): Promise<AssetGroupResult>;

  readonly manifest: AssetManifest;
  /** Planned GPU bytes of live texture values. */
  readonly textureBytes: number;
  readonly textureBudgetBytes: number;
  /** Source bytes of live metadata values (json/scene/material). */
  readonly metadataBytes: number;
  readonly inFlight: number;
  readonly failures: readonly AssetFailure[];
  /** True when worker decode was unavailable and decode fell back to main. */
  readonly degraded: boolean;

  onProgress(listener: (progress: AssetProgress) => void): () => void;
  onReload(listener: (event: AssetReloadEvent) => void): () => void;
  onFailure(listener: (failure: AssetFailure) => void): () => void;

  /**
   * Evict ready handles with refcount 0 in least-recently-used order until
   * `loadedBytes + textureBytes <= maxBytes`. Returns bytes freed.
   */
  trim(maxBytes?: number): number;
  /** Clear active-batch progress counters; never affects loaded assets. */
  resetProgress(): void;
  /** Release every handle but leave the manifest usable. */
  releaseAll(): void;
  /** Release everything, terminate workers; idempotent and never throws. */
  dispose(): void;
}

/**
 * Fetches and validates the manifest before resolving. Declaration only in
 * this contract wave; the implementation and the package-entry value export
 * land with W1 (06 §3.4, §5.2).
 */
export function createAssetLibrary(
  options: AssetLibraryOptions,
): Promise<AssetLibrary>;

/** 06 §3.5. */
export type AssetValueMap = {
  mesh: MeshData;
  texture: TextureData;
  material: MaterialData;
  audio: AudioAssetData;
  font: FontAssetData;
  json: JsonAssetData;
  scene: SceneDocument;
  animation: AnimationData;
};

/** 06 §3.5. */
export type AssetValue<K extends AssetKind> = AssetValueMap[K];

/**
 * CPU-side mesh value (06 §3.5, §4.5). It feeds
 * `RenderDevice.createMesh`; this package never creates a GPU resource.
 */
export interface MeshData {
  /** MESH_FORMAT_VERSION. */
  readonly formatVersion: 1;
  readonly id: string;
  /** Union of primitive bounds, model space. */
  readonly bounds: BoundingSphere;
  /** 1..8. */
  readonly primitives: readonly MeshPrimitive[];
  /** glTF material names; the scene resolves them to material ids. */
  readonly materialNames: readonly string[];
}

/** 06 §3.5, §4.5. */
export interface MeshPrimitive {
  /** Interleaved static-pbr-v1; stride 32 bytes (8 floats per vertex). */
  readonly vertices: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly indexFormat: "uint16" | "uint32";
  readonly vertexCount: number;
  /** Multiple of 3. */
  readonly indexCount: number;
  readonly bounds: BoundingSphere;
  /** Index into materialNames; -1 when the primitive has no material. */
  readonly materialSlot: number;
}

/**
 * Texture tokens accepted by this package (06 §4.7). The uncompressed tokens
 * are the core `TextureFormat` tokens; the compressed tokens are the additive
 * extension 06 §4.7 requests from spec 04. A device must report the matching
 * capability before a compressed variant is selected.
 */
export type AssetTextureFormat =
  | "rgba8unorm"
  | "rgba8unorm-srgb"
  | "bc1-rgba-unorm"
  | "bc1-rgba-unorm-srgb"
  | "bc3-rgba-unorm"
  | "bc3-rgba-unorm-srgb"
  | "bc7-rgba-unorm"
  | "bc7-rgba-unorm-srgb"
  | "etc2-rgba8unorm"
  | "etc2-rgba8unorm-srgb"
  | "astc-4x4-unorm"
  | "astc-4x4-unorm-srgb";

/** 06 §3.5. */
export interface TextureData {
  /** TEXTURE_ASSET_FORMAT_VERSION. */
  readonly formatVersion: 1;
  readonly id: string;
  readonly container: "webp" | "png" | "ktx2";
  readonly width: number;
  readonly height: number;
  readonly mipLevels: number;
  readonly layers: number;
  readonly format: AssetTextureFormat;
  /** Metadata only; the material slot chooses the GPU format. */
  readonly sourceColorSpace: "srgb" | "linear";
  /** Mip 0 first, then +1, per layer. */
  readonly levels: readonly TextureLevelData[];
  /** 06 §4.9 plan. */
  readonly gpuBytes: number;
  readonly completeMipChain: boolean;
}

/**
 * One texture subresource (06 §3.5 names this `TextureLevelData`). It
 * references the core render-device `TextureLevel` and narrows `bytes` from
 * `ArrayBufferView` to the `Uint8Array` 06 specifies, so a `TextureData` can
 * be passed to `RenderDevice.createTexture` without a copy.
 */
export interface TextureLevelData extends Omit<TextureLevel, "bytes"> {
  readonly bytes: Uint8Array;
}

/** 06 §3.5, §4.8. Texture fields are manifest texture ids, not GPU handles. */
export interface MaterialData {
  /** MATERIAL_FORMAT_VERSION. */
  readonly formatVersion: 1;
  readonly id: string;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  readonly emissiveFactor: readonly [number, number, number];
  readonly baseColorTexture: string | null;
  readonly metallicRoughnessTexture: string | null;
  readonly normalTexture: string | null;
  readonly normalScale: number;
  readonly occlusionTexture: string | null;
  readonly occlusionStrength: number;
  readonly emissiveTexture: string | null;
  readonly alphaMode: "opaque" | "mask" | "blend";
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
  readonly unlit: boolean;
}

/** 06 §3.5, §4.10. */
export type AudioMimeType = "audio/ogg" | "audio/webm" | "audio/mp4" | "audio/wav";

/**
 * Encoded audio transport value (06 §3.5). This package never creates an
 * `AudioContext`; `engine-audio` converts "encoded" after gesture unlock and
 * passes "stream" through unchanged.
 */
export type AudioAssetData =
  | {
      readonly kind: "stream";
      readonly url: string;
      readonly mimeType: AudioMimeType;
      readonly durationSeconds?: number;
    }
  | {
      readonly kind: "encoded";
      readonly bytes: ArrayBuffer;
      readonly mimeType: AudioMimeType;
      readonly durationSeconds?: number;
      readonly streaming: boolean;
    };

/** 06 §3.5, §4.10. Atlas schema is owned by spec 13. */
export type FontAssetData =
  | { readonly kind: "woff2"; readonly bytes: ArrayBuffer }
  | { readonly kind: "atlas"; readonly json: unknown };

/** 06 §3.5. */
export type JsonAssetData = { readonly json: unknown };

/**
 * Opaque until specs 03/17 define the payload (06 §3.5). Loading a scene in
 * M0 fails `E_ASSET_UNSUPPORTED`; the manifest validator still checks the
 * entry so a future decoder can be enabled without a manifest change.
 */
export type SceneDocument = unknown;

/** Opaque until spec 08 defines the payload (06 §3.5); unsupported in M0. */
export type AnimationData = unknown;

/** 06 §3.5. These declarations mirror `src/version.ts`. */
export const ASSET_MANIFEST_VERSION: 1;
export const MESH_FORMAT_VERSION: 1;
export const TEXTURE_ASSET_FORMAT_VERSION: 1;
export const MATERIAL_FORMAT_VERSION: 1;
export const ASSET_CACHE_VERSION: 1;

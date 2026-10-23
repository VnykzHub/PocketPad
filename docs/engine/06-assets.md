# 06 — Assets

**Status:** authoritative target contract for `@lanpad/engine-assets` — the asset manifest, byte-accurate loading, worker decode, `AssetHandle` lifetime, lazy groups, budgets, hashing/caching and dev hot reload.

**No implementation exists in this tree as of 2026-10-22.** `packages/engine/` does not exist yet. Every acceptance row in §7 is `PENDING` until the package lands and the named fixture or hardware run exists. Nothing in this document is a measurement.

**Contract authority:** `packages/engine/assets/src/types.ts`, mirrored structurally by `sdk` where a game-facing shape is exposed (00 §3.6). The `.d.ts` companion required by `docs/engine/README.md` §7.1 is generated from that file. The types are the authority; this prose explains them.

**Milestone boundary:** M0 delivers the full runtime path for `json`, `mesh` (uncompressed GLB), `texture` (WebP/PNG and pre-transcoded KTX2), `material` and `font` (WOFF2 bytes), plus the audio transport. Compressed mesh (Meshopt/Draco), BasisU supercompressed KTX2, persistent `CacheStorage` and hot reload of removed assets are M1. `scene` and `animation` are declared here but their payload semantics belong to specs 03/17 and 08; until those exist the loader returns `E_ASSET_UNSUPPORTED` for those kinds.

**Upstream:** 00-architecture (§3.2, §4.2, §4.3, §5.7, §6.3), 02-math (`Vec3`, `BoundingSphere`), 04-renderer-webgpu (`MeshDesc`, `TextureFormat`, `MaterialDesc`, `EngineFeature`), 05-renderer-webgl2 (`AssetCapability` mirror).
**Downstream:** 09-audio, 12-world-streaming, 13-ui-text, 16-tooling-profiler, 03-scene (written), 08-animation (written), 18-game-sdk.

---

## 1. Goal

Give every game one asset system that:

1. **Loads one declared manifest.** `asset-manifest.json` is the complete, validated list of what a game ships: id, kind, URL, byte size, group, optional variants, optional integrity hash. A game cannot fetch an asset that is not declared, and cannot escape its own directory.
2. **Reports real progress.** A progress bar is driven by bytes actually read from the response body, not by a count of completed fetches. `progress.fetched / progress.declared` is exact for the active batch.
3. **Keeps the frame path clean.** Fetching, hashing and decoding happen off the simulation and render paths. `AssetHandle.value` is an O(1) property read. `simulate` and `render` never await, decode, allocate a loader object or touch this package.
4. **Decodes in workers.** GLB parsing, KTX2 header/level extraction and WebP/PNG decode run in module workers; the main thread only validates, fetches with byte counting, reserves budget and swaps results. Main-thread work per completed asset is bounded (§5.6).
5. **Owns lifetime explicitly.** `AssetHandle` is reference-counted by the caller. The library never evicts a retained asset. There is no heuristic cache that can free something a game is holding (00 §5.7).
6. **Enforces budgets before allocation.** The 5 MiB initial boot set (SPEC FR-9.6), the declared total, the CPU decoded budget and the planned GPU texture budget are checked *before* a fetch or decode starts, so an over-budget game fails a load instead of the tab.
7. **Feeds both renderers without knowing them.** The package produces CPU-side `MeshData` and `TextureData` in the exact shapes `RenderDevice.createMesh`/`createTexture` consume. It never creates a GPU resource, imports a renderer, or sees a `RenderDevice`.
8. **Supports hot reload in development only.** A changed asset is re-fetched, re-decoded and swapped into live handles with a revision bump; production builds contain none of the watcher.
9. **Is auditable.** The same validator runs in the host and in tooling (16), producing the same issue codes for the same fixture.

**Success is measurable:** fixture assets load and render through both backends, `progress.fetched` ends on the exact declared byte count, an over-budget manifest fails with `E_ASSET_BUDGET` and zero network requests, a retained handle survives an explicit `trim()`, and a released handle is evicted in LRU order.

---

## 2. Non-goals

- **No editor, importer or converter.** Tooling (spec 16) turns PNG/glTF/OBJ/WAV/TTF into the runtime formats. This package rejects anything it cannot decode rather than converting on the fly.
- **No GPU work.** No `GPUDevice`, `WebGL2RenderingContext`, `TextureHandle`, `MeshHandle` or `RenderDevice` import. Upload is the renderer's job.
- **No scene graph, streaming policy or entity ownership.** `engine-streaming` (12) decides which cells load; the scene (03) decides which entities reference which handles. This package loads ids.
- **No animation sampling or font layout.** `animation` payload semantics are spec 08's; glyph layout is spec 13's. This package transports and validates containers only.
- **No audio playback or decoding before gesture unlock.** It fetches encoded bytes and decides stream-vs-buffer; `engine-audio` (09) decodes through an unlocked `AudioContext`.
- **No third-party runtime dependency in M0.** No three.js, no Draco/Meshopt/Basis WASM, no zip library. M1 adds the two mesh decoders and the BasisU transcoder as optional worker chunks behind capability flags.
- **No network beyond same-origin relative URLs.** No CDN, no cross-origin, no redirects, no query strings, no fragments, no credentials, no data URLs.
- **No automatic eviction, prefetch heuristics or predictive loading.** Eviction is explicit (`trim`) and reference-counted. Streaming prefetch policy belongs to 12.
- **No service worker in v1.** HTTP cache + immutable hashed filenames + in-memory dedupe. A `CacheStorage` backend is M1 and off by default.
- **No code as data.** No `eval`, no `new Function`, no dynamic `import()` of an asset URL, no HTML/SVG rendering in the host origin.

---

## 3. Public interfaces

All types below are exported from `@lanpad/engine-assets` (entry `.`) except test doubles. `Vec3` and `BoundingSphere` come from `@lanpad/engine-core` (spec 02); they are not redefined.

### 3.1 Frozen core types (00 §3.2)

```ts
export type AssetKind =
  | "mesh" | "texture" | "material" | "audio" | "font" | "json" | "scene" | "animation";
export type AssetState = "queued" | "loading" | "ready" | "failed" | "disposed";

export interface AssetHandle<T = unknown> {
  readonly id: string;                 // stable manifest id, e.g. "meshes/sedan"
  readonly kind: AssetKind;
  readonly state: AssetState;
  readonly value: T;                   // valid only when state === "ready"; throws E_ASSET_NOT_READY otherwise
  retain(): AssetHandle<T>;            // +1 ref, returns this
  release(): void;                     // -1 ref; at 0 the library may evict on trim()
}

export interface AssetLibrary {
  load<T>(id: string, options?: AssetLoadOptions): Promise<AssetHandle<T>>;
  get<T>(id: string): AssetHandle<T> | undefined;
  readonly loadedBytes: number;        // CPU-decoded bytes charged against budgetBytes
  readonly budgetBytes: number;
  readonly progress: AssetProgress;
  dispose(): void;                     // releases all; idempotent
}
```

Additive members permitted by 00's "frozen, methods may be added" rule are defined in §3.2–§3.5. No frozen member changes shape or semantics.

### 3.2 Handle (additive)

```ts
export interface AssetHandle<T = unknown> {
  readonly revision: number;           // starts at 1; incremented by a hot-reload swap
  readonly bytes: number;              // decoded bytes charged for this value
  readonly textureGpuBytes: number;    // 0 except for texture values; the planned GPU cost
  readonly failed: AssetFailure | null;
}
```

Rules:

- `value` is a getter. `ready` returns the decoded value; any other state throws `EngineError(E_ASSET_NOT_READY)` carrying `id` and `state`. After `disposed` it throws `E_STALE_HANDLE`.
- `retain()` on a disposed handle throws `E_STALE_HANDLE` in dev and is a counted no-op in production, matching 00 §5.7.
- `release()` below zero throws `E_STALE_HANDLE` in dev, counters in production. `release()` on a `failed` handle frees the failure entry.
- A hot-reload swap keeps the same handle object, replaces the value and increments `revision`; callers that cached `handle.value` in a local must re-read after an `onReload` event (dev only).
- **The library holds no reference to a handle.** `load()` returns refcount 1 for the caller; the internal map is a lookup table, not an owner. `get()` does not add a reference. Only `trim()` and `dispose()` destroy values, and only at refcount 0 or on forced dispose.

### 3.3 Library (additive)

```ts
export interface AssetLoadOptions {
  readonly signal?: AbortSignal;              // caller cancellation
  readonly priority?: "boot" | "background";  // default "background"; "boot" bypasses the concurrency queue
  readonly timeoutMs?: number;                // default options.fetchTimeoutMs (30_000)
}

export interface AssetGroupResult {
  readonly handles: readonly AssetHandle[];
  readonly failures: readonly AssetFailure[];
}

export interface AssetLibrary {
  loadGroup(group: string, options?: AssetLoadOptions): Promise<AssetGroupResult>;
  loadInitial(options?: AssetLoadOptions): Promise<AssetGroupResult>;

  readonly manifest: AssetManifest;
  readonly textureBytes: number;        // planned GPU bytes of live texture values
  readonly textureBudgetBytes: number;
  readonly metadataBytes: number;       // source bytes of live metadata values (json/scene/material)
  readonly inFlight: number;
  readonly failures: readonly AssetFailure[];
  readonly degraded: boolean;           // true when worker decode was unavailable and decode fell back to main

  onProgress(listener: (progress: AssetProgress) => void): () => void;
  onReload(listener: (event: AssetReloadEvent) => void): () => void;
  onFailure(listener: (failure: AssetFailure) => void): () => void;

  /** Evict ready handles with refcount 0 in least-recently-used order until at or below maxBytes. Returns bytes freed. */
  trim(maxBytes?: number): number;
  /** Clear the active-batch progress counters. Never affects loaded assets. */
  resetProgress(): void;
  /** Release every handle the library knows about. Same as dispose() but leaves the manifest usable. */
  releaseAll(): void;
}

export interface AssetProgress {
  readonly fetched: number;             // bytes read from response bodies in the active batch
  readonly declared: number;            // sum of selected-variant bytes for the active batch
  readonly determinate: boolean;        // true when every batch member has a declared byte count
  readonly state: "idle" | "loading" | "ready" | "failed";
  readonly loadedCount: number;         // settled (ready or failed) assets in the batch
  readonly totalCount: number;          // assets in the batch
  readonly currentId: string | null;    // last id to make progress; display only
}
```

`loadedBytes` counts **CPU decoded bytes only**: interleaved vertex bytes + index bytes for meshes, level bytes for textures, encoded bytes for audio/fonts. Metadata (`json`, `scene`, `material`) is tracked separately in `metadataBytes` and is not charged to `budgetBytes`, because its parsed-object size cannot be measured portably; its source size is bounded by the manifest entry (≤ 4 MiB).

`textureBytes` is the **planned GPU cost** of live texture values, computed by the formula in §4.9 before decode. It is charged against `textureBudgetBytes` (default 128 MiB, PR-9.2 provisional). The renderer's `stats.textureBytes` is the truth after upload; a dev assertion reconciles the two at scene load and reports a counter on mismatch.

### 3.4 Options and construction

```ts
export interface AssetLibraryOptions {
  readonly gameId: string;                     // must equal manifest.id
  readonly manifestUrl: string;                // e.g. "/games/demo/asset-manifest.json"
  readonly baseUrl?: string;                   // default: directory of manifestUrl; all asset URLs resolve against it
  readonly quality?: "low" | "medium" | "high";// variant preference, default "high"
  readonly capabilities?: ReadonlySet<AssetCapability>; // from renderer.features; absent = no compressed variants
  readonly textureBudgetBytes?: number;        // default 134_217_728 (128 MiB)
  readonly decodedBudgetBytes?: number;        // default 100_663_296 desktop / 67_108_864 TV (provisional)
  readonly maxTotalBytes?: number;             // default 268_435_456 (256 MiB ceiling, provisional)
  readonly maxConcurrentFetches?: number;      // default 6
  readonly maxDecodeWorkers?: number;          // default min(4, max(1, hardwareConcurrency - 1))
  readonly fetchTimeoutMs?: number;            // default 30_000
  readonly verifyHashes?: boolean;             // default false; runtime passes true in dev
  readonly hotReload?: boolean;                // default false; compiled out of production
  readonly hotReloadSource?: HotReloadSource;
  readonly persistentCache?: AssetCache;       // default undefined (M1)
  readonly now?: () => number;                 // tests
  readonly fetch?: typeof globalThis.fetch;    // tests/offline; default globalThis.fetch
  readonly workerFactory?: () => WorkerLike;   // tests; production uses module workers
}

export function createAssetLibrary(options: AssetLibraryOptions): Promise<AssetLibrary>;
```

`createAssetLibrary` fetches and validates the manifest before returning; a manifest failure rejects the promise with `EngineError` (`E_ASSET_FORMAT` or `E_ASSET_LOAD`). It performs no asset fetch and allocates no worker until the first `load`.

### 3.5 Decoded values

```ts
export type AssetValueMap = {
  mesh: MeshData;
  texture: TextureData;
  material: MaterialData;
  audio: AudioAssetData;
  font: FontAssetData;
  json: JsonAssetData;
  scene: SceneDocument;        // opaque until spec 03/17; E_ASSET_UNSUPPORTED in M0
  animation: AnimationData;    // opaque until spec 08; E_ASSET_UNSUPPORTED in M0
};
export type AssetValue<K extends AssetKind> = AssetValueMap[K];

export interface MeshData {
  readonly formatVersion: 1;                       // MESH_FORMAT_VERSION
  readonly id: string;
  readonly bounds: BoundingSphere;                 // union of primitive bounds, model space
  readonly primitives: readonly MeshPrimitive[];   // 1..8
  readonly materialNames: readonly string[];       // glTF material names, scene resolves to material ids
}
export interface MeshPrimitive {
  readonly vertices: Float32Array;                 // interleaved static-pbr-v1, stride 32 bytes (8 floats/vertex)
  readonly indices: Uint16Array | Uint32Array;
  readonly indexFormat: "uint16" | "uint32";
  readonly vertexCount: number;
  readonly indexCount: number;                     // multiple of 3
  readonly bounds: BoundingSphere;
  readonly materialSlot: number;                   // index into materialNames, -1 when the primitive has no material
}

export type AssetTextureFormat =
  | "rgba8unorm" | "rgba8unorm-srgb"
  | "bc1-rgba-unorm" | "bc1-rgba-unorm-srgb"
  | "bc3-rgba-unorm" | "bc3-rgba-unorm-srgb"
  | "bc7-rgba-unorm" | "bc7-rgba-unorm-srgb"
  | "etc2-rgba8unorm" | "etc2-rgba8unorm-srgb"
  | "astc-4x4-unorm" | "astc-4x4-unorm-srgb";

export interface TextureData {
  readonly formatVersion: 1;                       // TEXTURE_ASSET_FORMAT_VERSION
  readonly id: string;
  readonly container: "webp" | "png" | "ktx2";
  readonly width: number;
  readonly height: number;
  readonly mipLevels: number;
  readonly layers: number;
  readonly format: AssetTextureFormat;
  readonly sourceColorSpace: "srgb" | "linear";    // metadata; the material slot chooses the GPU format
  readonly levels: readonly TextureLevelData[];    // mip 0 first, then +1, per layer
  readonly gpuBytes: number;                       // §4.9 plan
  readonly completeMipChain: boolean;
}
export interface TextureLevelData {
  readonly mipLevel: number;
  readonly layer: number;
  readonly bytes: Uint8Array;
  readonly bytesPerRow: number;                    // required when height > 1
}

export interface MaterialData {
  readonly formatVersion: 1;                       // MATERIAL_FORMAT_VERSION
  readonly id: string;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  readonly emissiveFactor: readonly [number, number, number];
  readonly baseColorTexture: string | null;        // manifest texture id
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

export type AudioMimeType = "audio/ogg" | "audio/webm" | "audio/mp4" | "audio/wav";
export type AudioAssetData =
  | { readonly kind: "stream"; readonly url: string; readonly mimeType: AudioMimeType; readonly durationSeconds?: number }
  | { readonly kind: "encoded"; readonly bytes: ArrayBuffer; readonly mimeType: AudioMimeType; readonly durationSeconds?: number; readonly streaming: boolean };

export type FontAssetData =
  | { readonly kind: "woff2"; readonly bytes: ArrayBuffer }
  | { readonly kind: "atlas"; readonly json: unknown }; // MSDF/bitmap schema owned by 13

export type JsonAssetData = { readonly json: unknown };

export const ASSET_MANIFEST_VERSION = 1;
export const MESH_FORMAT_VERSION = 1;
export const TEXTURE_ASSET_FORMAT_VERSION = 1;
export const MATERIAL_FORMAT_VERSION = 1;
```

**Audio boundary.** This package does **not** create an `AudioContext` and does not return `AudioAssetValue` (spec 09's type). It returns `AudioAssetData`: an encoded buffer plus its MIME type, or a same-origin stream URL. `engine-audio` converts `"encoded"` to `AudioAssetValue.kind === "buffer"` with `decodeAudioData` **after** the first user gesture (09 §4.1, FR-9.11), and passes `"stream"` through unchanged. This keeps the "no `AudioContext` before unlock" rule and leaves decode accounting (`decodeBudgetBytes`, `E_AUDIO_BUDGET`) where 09 specifies it.

**Material resolution.** `MaterialData` names texture **by manifest id**. The runtime/scene resolves those ids to retained `AssetHandle<TextureData>`, uploads them, builds a `MaterialDesc` (04 §4.7) with `TextureHandle`s, and releases the texture handles when the material is destroyed. This package never sees a `TextureHandle`, and the runtime is the only layer that bridges ids to GPU resources.

**Scene/animation opacity.** `SceneDocument` and `AnimationData` are declared as opaque branded types (`unknown` until their specs land). Loading either kind in M0 throws `E_ASSET_UNSUPPORTED`; the manifest validator still checks the entry, so a future spec can flip the decoder on without a manifest change.

### 3.6 Capabilities and variants

```ts
/** Mirrors the renderer-relevant subset of EngineFeature (04 §3.3). Strings are contract tokens; do not rename. */
export type AssetCapability =
  | "compressed-s3tc" | "compressed-etc2" | "compressed-astc"
  | "texture-array" | "float-render-target";

export interface AssetVariant {
  readonly url: string;                            // same rules as AssetManifestEntry.url
  readonly bytes: number;
  readonly requires?: readonly AssetCapability[];  // all must be present
  readonly container?: "glb" | "ktx2" | "webp" | "png" | "ogg" | "webm" | "m4a" | "wav" | "woff2";
  readonly format?: AssetTextureFormat;            // texture only; must match the container header
  readonly mimeType?: AudioMimeType;               // audio only
  readonly hash?: string;
}
```

Selection is deterministic and ordered (§5.4): the first variant in manifest order whose `requires` are all present wins; the entry's own `url` is the **default** and is used when no variant qualifies. The default must be loadable on Tier B (05) without any compressed-texture feature: WebP/PNG for `texture`, uncompressed GLB for `mesh`, WOFF2 for `font`, Ogg/WebM/WAV for `audio`. `bytes` on the entry is the default's size; `declared` progress uses the selected variant's size.

### 3.7 Errors

`EngineError` and `EngineErrorCode` come from `@lanpad/engine-core` (00 §5.9). This spec uses the existing codes and requires one additive extension, allowed by 00 ("codes may be added, never removed"):

| Code | Existing/additive | Meaning |
|---|---|---|
| `E_ASSET_LOAD` | existing | fetch failed, non-2xx, timeout, abort, Content-Length/byte-count mismatch |
| `E_ASSET_FORMAT` | existing | manifest schema violation, bad container, unsupported glTF/KTX2 feature, wrong content type, duplicate id, dependency cycle |
| `E_ASSET_BUDGET` | existing | initial/total/decoded/texture budget would be exceeded |
| `E_ASSET_HASH` | existing | declared hash does not match the bytes (dev) |
| `E_WORKER_FAILED` | existing | decode worker crashed or could not be created and main-thread fallback is disabled |
| `E_ASSET_NOT_READY` | **additive** | `handle.value` read before `ready` |
| `E_ASSET_UNKNOWN` | **additive** | `load`/`get` for an id not present in the manifest |
| `E_ASSET_ABORTED` | **additive** | caller aborted before completion |
| `E_ASSET_UNSUPPORTED` | **additive** | kind not implemented in this milestone, or no variant fits the device and no default is legal |
| `E_ASSET_EVICTED` | **additive** | a `get()`-borrowed handle was evicted; dev only signal, production reports a counter |

`EngineError.layer` is `"assets"`; `recoverable` is true for `E_ASSET_LOAD`, `E_ASSET_ABORTED`, `E_WORKER_FAILED`, `E_ASSET_NOT_READY`, `E_ASSET_EVICTED`, false for the rest. Messages contain the id, the URL path (never a query string; URLs are query-free by rule) and a short reason. They never contain tokens, cookies or response bodies.

---

## 4. Data formats

### 4.1 Version registry

| Name | Value | Owner | Bump rule |
|---|---|---|---|
| `ASSET_MANIFEST_VERSION` | `1` | 06 | Breaking required-field or semantic change. Readers keep v1 support for one milestone (00 §7.4). |
| `MESH_FORMAT_VERSION` | `1` | 06 | New required vertex attribute, index rule or compression requirement. |
| `TEXTURE_ASSET_FORMAT_VERSION` | `1` | 06 | New container, level layout or colour-space rule. |
| `MATERIAL_FORMAT_VERSION` | `1` | 06 | Breaking material field change. |
| `ASSET_CACHE_VERSION` | `1` | 06 | Persistent cache-key or storage-layout change (M1). |

Adding an optional manifest field does not bump `ASSET_MANIFEST_VERSION` (00 §7.4). Unknown fields are ignored. An unknown `formatVersion` is refused with `E_ASSET_FORMAT`, never guessed.

### 4.2 `asset-manifest.json` v1

UTF-8 JSON at the game root, ≤ **262,144 bytes**, ≤ **4096** assets. Synthetic example:

```json
{
  "formatVersion": 1,
  "id": "example-game",
  "budget": { "initialBytes": 3145728, "totalBytes": 5242880 },
  "assets": [
    {
      "id": "textures/atlas-01",
      "kind": "texture",
      "url": "assets/atlas-01.webp",
      "bytes": 524288,
      "hash": "fnv1a32:1a2b3c4d",
      "initial": true,
      "group": "boot",
      "variants": [
        { "url": "assets/atlas-01-bc7.ktx2", "bytes": 131072, "requires": ["compressed-s3tc"], "container": "ktx2", "format": "bc7-rgba-unorm" }
      ]
    },
    {
      "id": "meshes/sedan",
      "kind": "mesh",
      "url": "assets/sedan.glb",
      "bytes": 262144,
      "initial": false,
      "group": "city",
      "dependencies": ["materials/sedan"]
    }
  ]
}
```

Field rules:

| Field | Rule |
|---|---|
| `formatVersion` | exactly `1` |
| `id` (manifest) | `^[a-z0-9][a-z0-9._-]{0,63}$`, equals `options.gameId` |
| `budget.initialBytes` | positive integer ≥ the sum of `bytes` of every `initial: true` entry (selected default variant) |
| `budget.totalBytes` | ≥ `initialBytes` and ≥ the sum of `bytes` of all entries |
| `assets[].id` | unique, `^[a-z0-9][a-z0-9/_.-]{0,127}$`, no `//`, no leading/trailing `/`, segments not `.` or `..` |
| `assets[].kind` | one of the eight `AssetKind` values |
| `assets[].url` | same-origin relative path; no scheme, host, `//`, `..` segment, `?`, `#`, backslash, percent-encoded dot; must end with the extension implied by `kind`/`container` |
| `assets[].bytes` | positive integer ≤ 268,435,456; must equal the response body length |
| `assets[].hash` | optional `^fnv1a32:[0-9a-f]{8}$`; dev-only |
| `assets[].initial` | optional boolean; the boot set |
| `assets[].group` | optional `^[a-z0-9][a-z0-9-]{0,31}$`; the unit of `loadGroup` |
| `assets[].dependencies` | optional array of existing ids, ≤ 16, no self-reference, acyclic |
| `assets[].variants` | optional array ≤ 8; urls/bytes follow the entry rules; `requires` ⊆ the known capability set |
| `assets[].streaming` | optional boolean; audio only; forces stream vs buffer (09 §4.1) |
| `assets[].mimeType` | optional audio container hint; must agree with the container extension |
| `assets[].durationSeconds` | optional positive number; audio only; display and stream threshold |
| `assets[].meta` | optional flat object of string/number/boolean, ≤ 16 keys, values ≤ 256 chars; tooling metadata (font family, authoring hints). The engine does not interpret it. |

**Budget hierarchy.** SPEC FR-9.6 is authoritative: **initial download ≤ 5 MiB** (5,242,880 bytes), lazy-load the rest. 00 §4.2 additionally states `totalBytes ≤ 5 MB` "for v1"; that sentence is stricter than SPEC and is flagged as a cross-spec concern in the task report. This spec enforces the authoritative rule — `initialBytes` and the initial asset sum ≤ 5,242,880 bytes hard — and enforces `budget.totalBytes` as the game's own declared ceiling with an engine ceiling `options.maxTotalBytes` (default 268,435,456 bytes, provisional). Raising either requires a recorded budget amendment in `docs/todos/README.md`.

**Validation order** (fail fast, before any asset request):

1. Fetch manifest with `redirect: "error"`, `credentials: "omit"`, `cache: "no-cache"` in dev.
2. Size ≤ 262,144 bytes; `JSON.parse`; object shape.
3. `formatVersion`, `id`, `budget` fields.
4. Per entry: schema, id regex/uniqueness, url rules, ext/kind agreement, variant rules, dependency existence and acyclicity, kind support for the milestone.
5. Budget arithmetic including variants (`sumDefault`, `sumInitial`).
6. Only then create the library. A structural, path or format failure rejects with `E_ASSET_FORMAT`; a budget failure rejects with `E_ASSET_BUDGET`; a fetch failure rejects with `E_ASSET_LOAD`.

### 4.3 URL resolution and security

Resolution is a pure function; no fetch happens on an invalid URL.

1. Reject unless the raw string is non-empty, ≤ 512 chars, contains no `\`, no `?`, no `#`, no `%2e`/`%2E` sequence, and no `//`.
2. Reject an absolute path (leading `/`) and any scheme-like prefix before the first `/`.
3. Split on `/`; reject any segment equal to `.` or `..`, empty segments, or control characters.
4. Resolve `new URL(url, baseUrl)`; require `origin === location.origin`, `protocol` equal to `location.protocol`, and `pathname` under `new URL(baseUrl).pathname`.
5. Re-parse the resolved URL and repeat checks 1–3 on its pathname, so normalization cannot smuggle an escape.

Fetch always uses `redirect: "error"`, `mode: "same-origin"`, `credentials: "omit"`, `referrerPolicy: "no-referrer"`. A response with a non-2xx status, an opaque status, or a `Content-Type` outside the expected family (with `application/octet-stream` always allowed) fails `E_ASSET_LOAD`/`E_ASSET_FORMAT`. The reader aborts as soon as `fetched > entry.bytes`, so a lying `Content-Length` cannot grow unbounded.

### 4.4 Fetch and progress

- `declared` = Σ selected variant `bytes` for the active batch.
- `fetched` = bytes actually read from `response.body.getReader()`; increments after every chunk, even when the response is compressed at the HTTP layer (the counted bytes are the decoded body bytes, matching `bytes`).
- Before the body exists, the library compares `Content-Length` (when present) to `bytes`; a mismatch fails `E_ASSET_LOAD` immediately.
- If the body ends early (`fetched < bytes`) the asset fails `E_ASSET_LOAD`; if it would exceed `bytes` the reader is cancelled and the asset fails `E_ASSET_LOAD`.
- `determinate` is `false` only when a batch member has no declared `bytes` (impossible with a valid v1 manifest) or a stream URL is opened directly without a byte fetch (audio stream variant). Stream assets contribute 0 to `declared` and are excluded from the byte fraction; they are counted in `totalCount`.
- Progress events are coalesced to one per animation frame via the injected `now`/scheduler; the library never emits more than 60 events per second.

### 4.5 Mesh: GLB subset (M0)

A `mesh` entry points at a `.glb` containing **exactly one** mesh with 1–8 primitives. Multi-mesh models are split by tooling into multiple mesh assets. The GLB decoder ignores `scenes`, `nodes`, skins, cameras and images.

Accepted:

- 12-byte header: magic `glTF`, `version === 2`, `length === buffer.byteLength`.
- Chunk 0 `JSON` (UTF-8, 4-byte aligned, zero-padded), chunk 1 `BIN` (required, non-empty). Extra chunks are ignored.
- `buffers[0]` with no `uri`; every buffer view points inside the BIN chunk; no external buffers, no data URIs.
- `meshes.length === 1`; `primitives.length` 1–8; `mode` absent or `4` (triangle list); `indices` required.
- Attributes: `POSITION` (float32 vec3) required, `NORMAL` (float32 vec3) required, `TEXCOORD_0` (float32 vec2) required. `TANGENT` and `COLOR_0` are accepted and **dropped** (ABI 1's `static-pbr-v1` has no slots for them); the count is reported in `droppedAttributes` on the worker response for the profiler. Any other attribute is ignored.
- Accessors: no `sparse`; no `normalized`; `byteStride` either absent or exactly 32 when all attributes share one buffer view, otherwise the loader de-interleaves a strided view into the fixed layout. Indices: `UNSIGNED_SHORT` or `UNSIGNED_INT`, count % 3 === 0, max index < vertex count.
- Bounds: computed from POSITION and cross-checked against `accessor.min`/`max` when present; a mismatch > 1e-4 fails `E_ASSET_FORMAT` (catches corrupted exports).

Rejected with `E_ASSET_FORMAT`: any `extensionsRequired` entry; Draco (`KHR_draco_mesh_compression`), Meshopt (`EXT_meshopt_compression`), quantization (`KHR_mesh_quantization`), sparse accessors, primitive modes other than triangles, a second mesh, zero primitives, missing BIN chunk, accessor bounds inconsistent with data.

M1 adds compressed mesh: `EXT_meshopt_compression` and `KHR_draco_mesh_compression` are decoded in a worker by optional chunks (`codec/meshopt.worker.ts`, `codec/draco.worker.ts`), gated by `ALLOW_COMPRESSED_MESH`. Tooling may instead pre-decompress for M0; the runtime format is then identical. M0 ships no WASM, so the dev CSP needs no change; M1 requires `script-src 'wasm-unsafe-eval'` (see §5.10).

**Interleaved layout (`static-pbr-v1`, 32 bytes/vertex):**

| Offset | Field | Type |
|---|---|---|
| 0 | position | float32 ×3 |
| 12 | normal | float32 ×3 |
| 24 | uv | float32 ×2 |

`vertices.byteLength === vertexCount * 32`. Normals are normalized on export; the loader does not renormalize in release but flags zero-length normals in dev. Tangents are derived in-shader (04 §4.6), so a missing TANGENT never breaks rendering.

### 4.6 Texture: WebP/PNG and KTX2

**Default variant (required, universal):** WebP or PNG. Decoded in a worker with `createImageBitmap(blob)` → `OffscreenCanvas(width, height)` → `getImageData(0, 0, w, h)` → copy to a `Uint8Array`. Result: `format: "rgba8unorm"`, `mipLevels: 1`, `layers: 1`, `sourceColorSpace: "srgb"`, `completeMipChain: false`. Animated WebP decodes frame 0 only. Dimensions ≤ 4096 each; a larger image fails `E_ASSET_FORMAT` (a 4096² RGBA image is already 64 MiB of CPU memory). Alpha is preserved. ICC profiles are ignored; tooling converts to sRGB.

**KTX2 variant (M0, pre-transcoded):** the loader reads the 12-byte identifier `«KTX 20»\r\n\x1A\n`, then the header: `vkFormat`, `typeSize`, `pixelWidth`, `pixelHeight`, `pixelDepth` (0), `layerCount` (0 or N), `faceCount` (1), `levelCount`, `supercompressionScheme`. M0 accepts `supercompressionScheme === 0` (none) only. Levels are read via the level index: `byteOffset`, `byteLength`, `uncompressedByteLength`. Requirements:

- `typeSize === 1`, `pixelDepth === 0`, `faceCount === 1`, `layerCount` 0 (one layer) or 1 for this milestone; cube maps are M2.
- `levelCount` equals the full chain `1 + floor(log2(max(width, height)))`; every level is present and its dimensions are `max(1, w >> level)`, `max(1, h >> level)`. M0/M1 do not generate mips (04 §4.9): an incomplete chain is refused rather than silently sampled as a single level.
- Each level's `byteOffset` is 4-byte aligned and inside the buffer; `byteLength` equals the computed subresource size for the declared format.
- `vkFormat` must map to a supported `AssetTextureFormat` (§4.7) and its `requires` capability must be present in `options.capabilities`. A KTX2 whose format the device cannot sample fails `E_UNSUPPORTED_FEATURE` **before** decode, so the caller can retry the default variant.

M1 adds BasisU: `supercompressionScheme` 1–3 with the BasisU transcoder WASM chunk, transcoding to the first supported target (`bc7` → `bc1`/`bc3` → `etc2` → `astc` per capabilities). The transcoder never runs in M0.

### 4.7 Texture format map

| `AssetTextureFormat` | KTX2 `vkFormat` | `requires` | 04 `TextureFormat` |
|---|---|---|---|
| `rgba8unorm` | 37 (R8G8B8A8_UNORM) | — | `rgba8unorm` |
| `rgba8unorm-srgb` | 43 (R8G8B8A8_SRGB) | — | `rgba8unorm-srgb` |
| `bc1-rgba-unorm` | 131 | `compressed-s3tc` | additive token |
| `bc1-rgba-unorm-srgb` | 132 | `compressed-s3tc` | additive token |
| `bc3-rgba-unorm` | 137 | `compressed-s3tc` | additive token |
| `bc3-rgba-unorm-srgb` | 138 | `compressed-s3tc` | additive token |
| `bc7-rgba-unorm` | 145 | `compressed-s3tc` | additive token |
| `bc7-rgba-unorm-srgb` | 146 | `compressed-s3tc` | additive token |
| `etc2-rgba8unorm` | 147 | `compressed-etc2` | additive token |
| `etc2-rgba8unorm-srgb` | 148 | `compressed-etc2` | additive token |
| `astc-4x4-unorm` | 157 | `compressed-astc` | additive token |
| `astc-4x4-unorm-srgb` | 158 | `compressed-astc` | additive token |

**Cross-spec requirement:** 04 §4.5's `TextureFormat` union currently lists only uncompressed formats. Compressed tokens must be added there additively (same tokens, exact strings) or the renderer cannot accept a compressed `TextureDesc`. This spec does not fork the contract; it names the extension and waits for 04's revision. Until then, compressed variants are decoded but not uploadable, so the runtime must not select them (`capabilities` empty).

### 4.8 Material: `.material.json` v1

```json
{
  "formatVersion": 1,
  "id": "materials/sedan",
  "baseColorFactor": [1, 1, 1, 1],
  "metallic": 0.4,
  "roughness": 0.35,
  "emissiveFactor": [0, 0, 0],
  "baseColorTexture": "textures/sedan-basecolor",
  "metallicRoughnessTexture": null,
  "normalTexture": "textures/sedan-normal",
  "normalScale": 1,
  "occlusionTexture": null,
  "occlusionStrength": 1,
  "emissiveTexture": null,
  "alphaMode": "opaque",
  "alphaCutoff": 0.5,
  "doubleSided": false,
  "unlit": false
}
```

Rules: values match 04 §4.7 ranges (`roughness` 0.04–1 after clamping, factors linear 0–1); texture ids must exist, be `kind: "texture"`, and are added to the entry's resolved dependency set automatically; `alphaCutoff` is only meaningful for `mask`. A material is immutable data; editing it means a new asset and a manifest change. Tooling generates one material asset per glTF material; a GLB's `materialNames` are matched by name when the scene declares the mapping.

### 4.9 Texture GPU byte formula

Per 04 §4.9, accounting is per subresource with 256-byte alignment:

```
block(w, h, fmt) = uncompressed ? w*h*4
                  : ceil(w / blockW(fmt)) * ceil(h / blockH(fmt)) * blockBytes(fmt)
levelBytes(w, h, fmt, l) = block(max(1, w >> l), max(1, h >> l), fmt)
gpuBytes = Σ_{layer=0..layers-1} Σ_{l=0..mipLevels-1} align256(levelBytes(w, h, fmt, l))
```

Block sizes: BC1/BC3/BC7 = 4×4, 8/16/16 bytes; ETC2 RGBA8 = 4×4, 16 bytes; ASTC 4×4 = 16 bytes; RGBA8 = 1×1, 4 bytes.

Worked example: 64×64 BC1 with 7 mips = 2048 + 512 + 256 + 256 + 256 + 256 + 256 = **3,840** bytes (the small mips each round up to 256). 32×32 RGBA8 with 1 mip = **4,096** bytes. The same numbers appear in §7's fixtures.

### 4.10 Audio, font and JSON containers

**Audio.** Accepted containers: Ogg (`OggS`), WebM (`0x1A45DFA3`), WAV (`RIFF`…`WAVE`), MP4/M4A (`ftyp`). The loader sniffs the container in a worker and returns the MIME type; it never calls `decodeAudioData`. Routing follows 09 §4.1: stream when `durationSeconds > 30` **or** `bytes > 1,048,576`; a manifest `"streaming"` boolean overrides either way. A stream result carries the resolved URL (same-origin, validated) — the fetch for playback is `engine-audio`'s and is not counted in asset progress. Ogg/WebM is the required M0 format; AAC/MP4 is an accepted alternate when the browser supports it (capability is checked by `engine-audio` at play time, not here).

**Font.** `kind: "font"` accepts WOFF2 (`wOF2` signature) and JSON atlas documents. WOFF2 returns the raw bytes; the family/weight/style live in spec 13's font stack, not in this manifest. An atlas returns the parsed JSON (≤ 2 MiB per 13 §4.8) and its atlas texture is a separate `texture` asset referenced by id inside that JSON — 13 owns the schema; the validator only checks the id references exist and are textures. TTF/OTF are rejected at runtime; tooling converts.

**JSON.** `.json`, UTF-8, ≤ 4 MiB, parsed on the main thread at load time (not in a worker, so the result needs no second structured clone). The parser accepts any JSON value. Games must treat it as data; the engine never merges it into a prototype.

---

## 5. Architecture

### 5.1 Module map

```
packages/engine/assets/src/
  index.ts             public barrel: types + createAssetLibrary + constants
  types.ts             every exported type in §3 (contract authority)
  manifest.ts          parse + validate manifest, URL rules, budget arithmetic
  library.ts           AssetLibrary implementation, batch/progress, dedupe, trim
  handle.ts            handle object, refcounts, value getter, revision
  fetch.ts             validated fetch, streaming byte counter, timeout/abort
  variants.ts          deterministic variant selection
  budget.ts            decoded/texture/total ledgers, reservation and release
  hotReload.ts         dev watcher plumbing (tree-shaken in production)
  cache.ts             in-memory + optional CacheStorage backend
  worker/pool.ts       worker pool, job lifecycle, restart policy
  worker/protocol.ts   request/response messages, transfer lists
  worker/decode.worker.ts  entry: dispatch by kind/container
  codec/glb.ts         GLB/glTF subset parser (worker-side)
  codec/ktx2.ts        KTX2 header/level reader (worker-side)
  codec/image.ts       WebP/PNG -> RGBA8 (worker-side)
  codec/audio.ts       container sniff + routing (worker-side)
  codec/font.ts        WOFF2/atlas validation (worker-side)
  codec/material.ts    material JSON validation (main-side, small)
  codec/json.ts        JSON asset parse (main-side)
```

The worker entry imports only `codec/*`, `worker/protocol.ts` and `types.ts`; it never imports `library.ts`, `fetch.ts` or DOM-only modules. The pool creates workers with `new Worker(new URL("./worker/decode.worker.ts", import.meta.url), { type: "module" })`; bundlers emit one chunk. Tests inject `workerFactory`.

### 5.2 Load state machine

```
queued -> fetching -> decoding -> ready
   |         |           |
   |         +-----------+--> failed (code, retryable)
   +-----------------------> failed (budget/unsupported/unknown, no fetch)
ready -> disposed (only at refcount 0 via trim(), or forced by dispose/releaseAll)
```

- `load(id)` validates the id, joins the active batch, and returns a promise. Concurrent `load(id)` calls share one fetch and one decode; each caller gets the same handle and **one reference each**. A second caller does not re-fetch.
- Failures are sticky per id until `retry(id)` (additive; not in v1 unless needed) or a hot reload. A failed handle has `state: "failed"`, `value` throws, `failed` carries the code.
- Cancellation: when the last waiting caller aborts, the fetch is aborted and a queued/running worker job is cancelled best-effort. A decode that already completed is discarded. The handle becomes `disposed`; `E_ASSET_ABORTED` reaches the caller.
- `dispose()` aborts every fetch and worker job, disposes every handle (refcount ignored), terminates workers, and is idempotent. It never throws.
- `releaseAll()` is `dispose()` for values but keeps the library and manifest usable; subsequent `load` works.

### 5.3 Dependencies and groups

- `loadGroup(group)` selects every entry with `group === group`, expands `dependencies` transitively, and loads dependencies first in topological order. A cycle fails validation, not load.
- `loadInitial()` selects every `initial: true` entry plus dependencies. The boot batch is the only batch allowed to use `priority: "boot"`, which bypasses the concurrency queue up to its own limit.
- A group member that fails does not fail the group; `AssetGroupResult.failures` reports it and the result resolves. Only a manifest/validation failure rejects.
- Dependencies are also enforced for single `load(id)`: loading a `mesh` does not automatically load its materials (the scene decides), but a `material` always loads its texture ids first. Rule: **only kinds whose value cannot exist without another asset declare dependencies** — currently `material` (textures) and `scene` (everything it names, once 03 lands). Meshes declare none; their material names are resolved by the scene, not by this package.

### 5.4 Variant selection

```ts
selectVariant(entry, capabilities, quality): { url, bytes, container, format?, mimeType?, hash? }
```

1. If `kind !== "texture"` and no variants exist, return the default.
2. Otherwise scan `entry.variants` in manifest order; the first whose every `requires` capability is present, whose `container` matches the kind, and whose `format` maps to a supported format wins.
3. If none qualify, return the default. If the default's container is a compressed KTX2 (illegal for a default) or the kind is unsupported, fail `E_ASSET_UNSUPPORTED` before fetch.
4. `quality` influences only the caller's capability set (the runtime drops `compressed-*` at `low`), never the scan order. Selection is deterministic for a given manifest + capability set, so caches and tests agree.

### 5.5 Budget accounting

| Ledger | Charged when | Released when | Default |
|---|---|---|---|
| Initial boot bytes | manifest validation; sum of `initial` defaults | never (game-lifetime) | 5,242,880 hard |
| Total declared bytes | manifest validation (`budget.totalBytes`) | never | game-declared ≤ `maxTotalBytes` |
| CPU decoded bytes | value decoded, before `ready` | value disposed (trim/releaseAll) | 96 MiB desktop / 64 MiB TV |
| Planned texture GPU bytes | texture decode starts (reserve) | texture disposed | 128 MiB |
| Metadata bytes | metadata value parsed | disposed | reported only |

Rules:

- A reservation is all-or-nothing: if the next asset would cross a ledger, the load fails `E_ASSET_BUDGET` with `{id, requested, used, budget}` and performs **no** fetch/decode. Nothing is partially charged.
- `trim(maxBytes = budgetBytes)` evicts `ready` handles with refcount 0 in least-recently-used order (last `value` read or `load` completion, whichever is later) until `loadedBytes + textureBytes ≤ maxBytes`. Pinned `initial` assets are evicted last, only if nothing else remains, and only when `trim` is called explicitly.
- `dispose()` releases every ledger to zero. `trim` returns the bytes freed.
- The texture ledger is a plan. On upload the renderer computes the same `gpuBytes` from the `TextureData`; a dev check compares renderer `stats.textureBytes` with the library's `textureBytes` and counts a mismatch. Production trusts the renderer.

### 5.6 Worker pool and main-thread bound

- Pool size `maxDecodeWorkers` (default `min(4, max(1, hardwareConcurrency - 1))`), created lazily on the first decode, capped at 4. Jobs are FIFO with `priority: "boot"` ahead of background.
- Main-thread work per asset: URL checks (µs), fetch setup, chunk counter, a structured-clone of the request, a structured-clone of the result (buffers transferred, not copied), handle swap, one progress event. Design bound: **≤ 2 ms p95 per completed asset on the reference desktop**; measured in ER-06-09.
- Transfer lists: a decode response transfers every `ArrayBuffer` it owns (`vertices.buffer`, `indices.buffer`, each level's buffer). The main thread never copies decoded bytes. A transferred buffer is detached in the worker; the codec must not touch it afterwards.
- A worker `error`/`messageerror` fails in-flight jobs with `E_WORKER_FAILED` (retryable), terminates it, and creates at most one replacement per 10 seconds. A second failure in that window disables the pool and sets `degraded`, falling back to main-thread decode with a warning counter (never a hang). Main-thread fallback is capped at 4 MiB per job; larger jobs fail `E_WORKER_FAILED`.
- A job has a deadline of `timeoutMs` (default 30 s). Expiry terminates and restarts the worker, then fails the job. A decode never blocks the simulation: the library is only called from load boundaries, and a load awaiting a worker does not stop the loop.

### 5.7 Hot reload (dev only)

```ts
export interface HotReloadSource {
  subscribe(listener: (changed: readonly string[]) => void): () => void; // manifest-relative urls or ids
}
export interface AssetReloadEvent {
  readonly id: string;
  readonly revision: number;
  readonly kind: AssetKind;
}
```

- `options.hotReload` defaults to `false` and the module is imported only when true (`if (options.hotReload) await import("./hotReload.js")`), so production bundles drop it. The runtime wires a source: Vite HMR in dev or the dev-server watcher; this package never polls the network on its own.
- On a change: re-fetch the manifest when the manifest URL changed (diff ids: add=new entry, remove=release and dispose with `E_ASSET_EVICTED` to listeners), then re-fetch affected assets that have live handles. Budgets are re-checked; an over-budget reload fails the event and keeps the old value.
- Swapping is atomic per handle: decode completes, the old value is released, the new value is installed, `revision` increments, then `onReload` fires. A stale decode (a newer revision already installed) is dropped.
- No hot reload in production builds, ever: `hotReload: true` in a production bundle is ignored with a one-time warning, and the watcher chunk is absent.

### 5.8 Caching and hashing

- **Hash:** FNV-1a 32 over the exact response bytes, `fnv1a32:` + 8 lowercase hex. Implemented in `codec/hash.ts` (worker) with the basis `0x811c9dc5` and prime `0x01000193`, matching 12 and the save header. Verified only when `options.verifyHashes`; mismatch fails `E_ASSET_HASH` and leaves no cached value.
- **In-memory:** one entry per id for the library lifetime; one fetch per `(selected url, manifest epoch)`. Concurrent loads share. No duplicate network request while a value is live or loading.
- **HTTP:** tooling emits content-hashed filenames so production can serve `Cache-Control: public, max-age=31536000, immutable`. The manifest itself is served `no-cache`. v1 relies on the browser HTTP cache; no service worker.
- **Persistent (M1):** `AssetCache { match(key): Promise<ArrayBuffer | undefined>; put(key, bytes): Promise<void>; delete(key): Promise<void> }` keyed `lanpad-assets-v1:<gameId>:<fnv1a32>`; only entries with a hash are stored; every read verifies the hash; the whole namespace is purged when the manifest's asset-id/hash set changes. Disabled by default; a game opts in through the runtime.
- **Negative results are not cached.** A failed fetch retries on the next `load`.

### 5.9 Integration points and frame-path rules

- **Runtime boot (00 §5.5):** create the library with `renderer.features` → `loadInitial()` → pass `ctx.assets` → start the loop only after the boot set settles (or fails with a visible error). Teardown order: pause loop → `game.dispose()` → streamer stop → scene dispose → **asset `releaseAll()`** → render device dispose.
- **Renderer:** runtime reads `MeshData`/`TextureData` and calls `createMesh`/`createTexture`; on device restore the CPU data is still valid, so re-upload needs no re-fetch (00 §5.7 context-loss rule). No asset code runs on device loss.
- **Streaming (12):** the streamer retains `AssetHandle<MeshData>` arrays and releases them on cell eviction. It never decodes and never calls `trim`.
- **Audio (09):** gets `AudioAssetData`; decodes only after unlock; `registerBuffer`/`releaseBuffer` own the decoded buffer accounting.
- **UI (13):** gets `FontAssetData`; builds `FontFace` from WOFF2 bytes or parses its own atlas JSON.
- **Tooling (16):** imports `manifest.ts` and the URL/budget validators directly (no browser); the audit report uses the same `AssetFailure` codes plus its own `ASSET_UNREFERENCED`/`ASSET_DUPLICATE_HASH` codes, which are tooling-only and never thrown at runtime.
- **Frame path:** no allocation, no promise, no worker message, no fetch. `handle.value` is a getter returning a stored field. `progress` is a stable object mutated by the library, read by UI at most once per frame.

### 5.10 Security

- Same-origin only, relative only, no redirects, no cross-origin, no credentials, no query/fragment, validated before fetch (§4.3).
- CSP: host pages need `connect-src 'self'` for fetches, `worker-src 'self'` for module workers (bundlers may emit `blob:`; if so, add `worker-src 'self' blob:` and record it in the host CSP). M0 adds no WASM, so no `wasm-unsafe-eval`. M1's Meshopt/Draco/Basis decoders require `script-src 'wasm-unsafe-eval'`; that CSP change is owned by infra and must be recorded before the M1 decoders ship.
- Assets are data, never code: no `eval`, no `new Function`, no dynamic import of an asset URL, no HTML/SVG injection. A JSON asset cannot install a prototype; consumers use it as data.
- Errors and logs include only id, path, code and reason. No tokens, no cookies, no response bodies. The manifest URL is query-free by rule, so no token can leak into an asset URL.
- UGC manifests are validated twice: by tooling before deploy and by the host at boot. A game can only load files under its own directory.

### 5.11 Error matrix

| Situation | Code | Retryable | Leaves state |
|---|---|---|---|
| Manifest 404/500/timeout | `E_ASSET_LOAD` | yes | library creation rejects |
| Manifest JSON/schema/id/url invalid | `E_ASSET_FORMAT` | no (deploy fix) | rejects |
| Initial sum > 5 MiB, total > ceiling, decoded/texture budget would cross | `E_ASSET_BUDGET` | no for this manifest; yes after trim | no fetch/decode |
| Asset 404, non-2xx, timeout, body short/long, Content-Length mismatch | `E_ASSET_LOAD` | yes | handle failed |
| Wrong container signature, bad GLB/KTX2 header, missing attribute, bad material JSON | `E_ASSET_FORMAT` | no | failed |
| Kind `scene`/`animation`, or compressed variant with no supported default | `E_ASSET_UNSUPPORTED` | no | failed before fetch |
| Hash mismatch | `E_ASSET_HASH` | yes (reload) | failed, nothing cached |
| Worker crash | `E_WORKER_FAILED` | yes (one immediate retry) | retry or fallback |
| Caller abort | `E_ASSET_ABORTED` | yes | disposed |
| Unknown id | `E_ASSET_UNKNOWN` | no | promise rejects |
| `value` before ready | `E_ASSET_NOT_READY` | yes | unchanged |
| Evicted handle borrowed via `get()` | `E_ASSET_EVICTED` / `E_STALE_HANDLE` | no | disposed |

---

## 6. File ownership

**Package:** `packages/engine/assets/**` (00 §6.3, §5.4). The task shorthand `packages/assets/src/**` resolves to this authoritative path, exactly as `packages/engine-core` resolves to `packages/engine/core` in 02.

| Path | Owner | Notes |
|---|---|---|
| `packages/engine/assets/package.json` | assets agent | New workspace `@lanpad/engine-assets`; deps: `@lanpad/engine-core` only |
| `packages/engine/assets/tsconfig.json` | assets agent | Project reference to engine-core |
| `src/types.ts` | assets agent | Contract authority; additive changes only after M0 |
| `src/manifest.ts`, `src/fetch.ts`, `src/variants.ts`, `src/budget.ts` | assets agent | Pure/unit-testable |
| `src/library.ts`, `src/handle.ts`, `src/cache.ts` | assets agent | Lifecycle, ledgers |
| `src/hotReload.ts` | assets agent | Dev-only, dynamically imported |
| `src/worker/**` | assets agent | Pool, protocol, worker entry |
| `src/codec/glb.ts`, `ktx2.ts`, `image.ts`, `audio.ts`, `font.ts`, `material.ts`, `json.ts` | assets agent | One decoder per file |
| `test/*.test.ts`, `test/golden/**`, `test/fixtures/**` | assets agent | Requirement-tagged titles |
| `packages/engine/assets/src/index.ts` | assets agent | Public barrel |

**Not owned by this spec:** root `package.json`, root Vitest config, `npm run check` wiring, TRACEABILITY rows and the runtime migration are the integration agent's files in the wave that lands this package. `docs/engine/04-renderer-webgpu.md` §4.5 (`TextureFormat` union) and `docs/engine/00-architecture.md` §4.2 (total-budget sentence) are owned by their spec authors; this spec requests the additive fix and records the conflict, it does not edit them.

---

## 7. Acceptance

Every row carries an `ER-06-NN` ID and must resolve in `docs/todos/TRACEABILITY.md`. Hardware-dependent rows stay PENDING until run on the named device.

| ID | Criterion | Fixture / method | Hardware | Evidence state |
|---|---|---|---|---|
| ER-06-01 | The valid manifest fixture loads; all 16 invalid fixtures are rejected with the named code and JSON path; unknown fields are ignored; the format matrix matches the accepted variants | `test/fixtures/manifest-valid.json`, `manifest-invalid/*.json`, `format-matrix.json`; `manifest.test.ts` | CI Node 20 | PENDING — implementation wave |
| ER-06-02 | Fetch reads exactly the declared bytes, reports per-chunk progress, sends the specified request init, and fails with `E_ASSET_LOAD` on short/long bodies, non-2xx, abort or timeout; manifest fetch enforces the size cap and UTF-8 | `test/fetch.test.ts` with a fake fetch/server; no sockets | CI Node 20 | PENDING — implementation wave |
| ER-06-03 | The M0 GLB subset decodes one mesh with 1–8 primitives, POSITION/NORMAL/TEXCOORD_0, uint16/uint32 indices and embedded BIN; dropped TANGENT/COLOR_0 are counted; bounds mismatch is refused | Synthetic GLB fixtures; `glb.test.ts` | CI Node 20 | PENDING — implementation wave |
| ER-06-04 | KTX2 headers, level index, vkFormat map and 256-byte GPU alignment are validated; a format the device does not support is refused, never downcast | Synthetic KTX2 fixtures; `ktx2.test.ts` | CI Node 20 | PENDING — implementation wave |
| ER-06-05 | WebP/PNG decode uses the injected `createImageBitmap` seam, enforces dimension limits and produces RGBA8 data | Fake bitmap factory; `image.test.ts` | CI Node 20 | PENDING — implementation wave |
| ER-06-06 | Audio signature/stream routing, WOFF2 atlas validation, generic JSON and `.material.json` v1 clamps/kind checks behave as specified | Synthetic byte fixtures; `audio.test.ts`, `font.test.ts`, `json.test.ts`, `material.test.ts` | CI Node 20 | PENDING — implementation wave |
| ER-06-07 | Refcounts, shared in-flight loads, budget ledgers (all-or-nothing), stable progress, LRU trim with pinned handles, `releaseAll` and idempotent `dispose` behave as specified | `library.test.ts`; deterministic fake decoders | CI Node 20 | PENDING — implementation wave |
| ER-06-08 | The worker pool is lazy, bounded, boot-first, replaces one failed worker per 10 s before degrading, enforces the 4 MiB fallback cap and a 30 s deadline, and disposes cleanly | `worker/pool.test.ts` with injected worker doubles | CI Node 20 | PENDING — implementation wave |
| ER-06-09 | During a 5 MB asset load, no main-thread task exceeds 8 ms and per-asset main-thread work is ≤ 2 ms p95 on the reference desktop | `experiments/e-m0-engine/?bench=1&assets=5mb`; PerformanceObserver `longtask` | Desktop Chrome 155, Windows 11; adapter recorded | PENDING — needs the M0 page |

### 7.1 Clarifications recorded in W1

- **Failure stickiness.** A failed load is sticky while the handle has references; a later `load` after the refcount reaches zero retries. This resolves the §5.2/§5.8 tension.
- **Dependencies.** `dependsOn` is accepted on any asset kind, not only materials/scenes; §4.2's mesh→material example is authoritative.
- **Disposed vs evicted.** Reading `value` on an owned disposed handle throws `E_STALE_HANDLE`; a borrowed handle that was evicted throws `E_ASSET_EVICTED`. Both are in the §3.7 matrix.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | Manifest, URL rules, variants, budget ledgers, hash, codecs | `packages/engine/assets/test/*.test.ts` |
| Property (`fast-check`) | URL normalization, byte accounting, refcount invariants, decode rejection never throws uncaught | same |
| Golden fixtures | Synthetic GLB/KTX2/WebP/PNG/WOFF2/audio bytes and golden manifest outputs | `test/fixtures/**` |
| Integration | `createAssetLibrary` + FakeServer/fake fetch, worker doubles, abort/timeout, trim | `test/library.test.ts`, `test/worker/**` |
| Browser/manual | Real fetch, `createImageBitmap`, Worker decode, 5 MB long-task budget | `experiments/e-m0-engine`; `docs/RESULTS.md` |

Rules:

- Every test title carries its `ER-06-NN` ID or a leading `// @req ER-06-NN`.
- Tests never open sockets; fetch and workers are injected. Integration tests wait on promises/events, never fixed sleeps.
- Fixtures are synthetic. No production asset, token or PII appears in a fixture or error message.
- No performance number is asserted in Node; ER-06-09 is a browser run recorded in `docs/RESULTS.md`.

---

## 9. Dependencies

| Dependency | Why | State |
|---|---|---|
| 00 architecture | `AssetHandle`/`AssetLibrary`, error taxonomy, budgets, versioning | written |
| 01 core loop/time | Job interface and tick boundary for worker results | written |
| 04 renderer | Canonical `TextureFormat` tokens and `supportedFormats` | written |
| 03 scene | `Renderable` stores asset ids, not GPU handles | written |
| 16 tooling | Asset audit CLI and manifest validator reporting | written |
| 19 testing | Rig, fixtures, `docs/RESULTS.md` rows | written |

**Package prerequisite:** `@lanpad/engine-assets` imports only `@lanpad/engine-core`; no protocol, SDK, runtime or game package. Zero third-party runtime dependencies.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | Binary decoder edge cases (GLB/KTX2) are numerous | High | Corrupt assets or crashes | Synthetic fixtures, property tests, all-or-nothing decode, `E_ASSET_FORMAT` |
| R2 | KTX2 supercompression/BasisU is out of M0 scope | Certain | Some authored textures cannot load | Reject with `E_ASSET_UNSUPPORTED`; tooling emits a supported variant |
| R3 | Texture memory exceeds the budget on TV | Medium | Eviction churn or OOM | All-or-nothing ledgers, LRU trim, compressed variants, capability gate |
| R4 | Worker decode is unavailable or crashes | Medium | Main-thread stalls | Lazy pool, one replacement per 10 s, then main-thread fallback with a 4 MiB cap |
| R5 | MIME/extension mismatch or a lying `Content-Length` | Medium | Partial/corrupt values | Extension/kind agreement, Content-Length check, hard byte counter, abort |
| R6 | Abort/timeout races leak handles | Medium | Memory or unhandled rejections | Single settle per load, refcount zero cleanup, tests with fake timers |
| R7 | Fixture licensing or accidental production data | Low | Legal/privacy issue | Synthetic fixtures only; review before commit |

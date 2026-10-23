# 00 — Engine Architecture

**Status:** authoritative for the engine programme's layer map, package boundaries, frozen contracts and migration. Subsystem internals are owned by `01-…` to `19-…`; this file owns only the boundaries between them.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product/protocol contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) for the programme rules. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded in [`docs/todos/README.md`](../todos/README.md).

**Conflict to resolve before M0 code lands.** `SPEC.md` v0.3 records WebGPU as a non-goal (§2), names Three.js as the 3D candidate (§6.2) and argues "why not WebGPU" (§18). The engine programme's fixed decision is the opposite: a custom **WebGPU-first** renderer with a **WebGL2 fallback**, no Three.js. This spec follows the programme decision because it is the later decision and the user directive. Per repo rule, the paper trail must be updated in the same change: record an amendment (proposed **A14 — Browser-native engine reframe**) before `renderer-webgpu` code is merged. Until A14 exists, implementation of this spec is blocked at the SPEC layer, not the architecture layer.

---

## 1. Goal

Build a **browser-native game engine** inside this repository, not a TV accessory with a renderer attached. The engine must:

- run entirely in a browser tab on any display — desktop monitor, laptop, TV, tablet — with no install, no native code and no server-side simulation;
- ship 2D and 3D games from one runtime, with phones, keyboard/mouse and gamepad as first-class inputs;
- be **local-first** for multiplayer: phones join a room on the LAN and drive the host simulation; online state sync is a later spec, not a dependency of the engine core;
- be fast enough that a Vice City-scale open world is a plausible architectural ceiling, measured milestone by milestone, never claimed;
- be documented precisely enough that many agents can implement subsystems and many people can build games **in parallel** without reading engine source.

The player-visible outcome for M0 is narrow and concrete: a textured, lit 3D scene runs at 1080p in desktop Chrome, the same scene runs through the WebGL2 fallback, and the existing phone-controlled 2D games still play exactly as they do today.

The engineering outcome of this spec is the map that makes parallel work safe:

1. one owner per file, one direction of dependency;
2. contracts that can be implemented against before the implementation exists;
3. a migration path that never leaves the tree non-green;
4. a measurable M0 boundary that cannot silently expand.

**Scope of this spec.** It defines packages, import rules, frozen contracts, data-format envelopes, threading and memory rules, browser tiers, migration and versioning. It does not define loop math, renderer algorithms, asset codecs or game APIs in detail; those belong to specs 01–19.

---

## 2. Non-goals

- **Not a subsystem design.** Exact math, ECS storage, shader pipelines, physics solvers, codec choices and UI layout are owned by the numbered specs.
- **Not an implementation.** No code is written from this spec; it defines what code must expose.
- **Not a promise of Vice City in M0.** The north star constrains architecture (streaming, LOD, save format, asset pipeline). It is proven only at M3 with measured evidence.
- **Not online multiplayer.** Local rooms remain as they are. State sync, prediction and reconciliation belong to spec 14 and Phase 2.
- **Not a general-purpose engine for arbitrary browsers.** Chromium desktop/TV is the first target; Firefox WebGL2 is best-effort; Safari hosts are out of scope (Safari phones remain controllers).
- **Not cross-browser lockstep determinism.** Replay determinism is required within one build/browser; byte-identical simulation across engines is not a v1 goal (see §5.8).
- **Not a published npm SDK yet.** Engine packages stay private workspace packages until P4; the `@lanpad/*` scope is not renamed in M0 (product name is PocketPad; package rename is cosmetic and deliberately deferred).
- **Not Three.js, Babylon, Pixi, Unity Web, Godot Web or a WASM engine.** No third-party runtime dependency enters an engine package in M0.
- **No editor, no content pipeline beyond asset validation, no terrain/vehicle authoring** before M1–M3.
- **No `SharedArrayBuffer` requirement.** COOP/COEP headers are not guaranteed on TV browsers; the job system must work without it.

---

## 3. Public interfaces

This section is the contract surface. Signatures are normative in shape; exact names may be refined by the owning spec *before* the package's first release, and never after (see §5.15). Types are backend-neutral: no `GPUDevice`, `WebGL2RenderingContext`, DOM node or protocol frame appears in an engine public type.

### 3.1 Contract status

| Contract | Introduced | Status | Breaking change requires |
|---|---|---|---|
| `GameContext`, `Game`, `GameRenderer3D` | D3 (exists) | **Frozen**; additive optional members only | `sdk` major + amendment |
| `Renderer2D`, `Renderer3D` legacy | D3 (exists) | **Frozen**; compatibility facade only after M0 | `sdk` major + amendment |
| `RenderDevice` renderer contract | M0 | **Frozen after M0**; new optional features via capability flags | engine major + renderer spec revision |
| `AssetHandle`, `AssetLibrary` | M0 | **Frozen after M0**; methods may be added | engine major |
| `Scene`, `Entity`, `Transform` | M0 | **Frozen after M0**; public API additive only | engine major |
| `InputAction`, `ActionState` | M0 | **Frozen after M0**; new source/kinds additive | engine major |
| `WorldCell` | declared M0, implemented M2 | **Frozen at declaration**; key format change is a data-format bump | format version + engine major |
| `SaveHeader` | M0 codec, M1 use | **Frozen**; byte layout change is a save-format bump | save `formatVersion` + migration |
| `EngineErrorCode` | M0 | **Frozen**; codes may be added, never removed | engine major |

**Changing a frozen contract** is a five-step operation, all in one change: (1) update the owning numbered spec; (2) record the amendment in `docs/todos/README.md`; (3) bump the version named in the table; (4) provide a migration note and, for saves/assets, a reader for the previous version; (5) add a test that the old fixture still loads or the old call still compiles.

**`Renderer2D`/`Renderer3D` specifically:** the existing methods (`clear`, `circle`, `rect`, `text`, `polyline`, `setCamera`, `drawCube`) and all `Renderer` members are frozen. Additive evolution is by optional members (`size` already exists; `capabilities` arrives at M0) and by the new engine path (`ctx.scene` + `ctx.assets`). Renaming or removing a legacy method is an SDK major. The internal `RenderDevice` contract is separate and never appears in a game.

### 3.2 `@lanpad/engine-core`

Zero-dependency foundation. Browser-safe; sim modules must also run in Node for tests.

```ts
// time
export interface EngineFrame {
  readonly tick: number;        // host simulation tick, integer
  readonly dt: number;          // seconds, fixed 1/60
  readonly alpha: number;       // [0, 1) render interpolation
  readonly frameMs: number;     // measured display-frame interval
}
export interface FixedLoop {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  readonly running: boolean;
  readonly tick: number;
}
export interface FixedLoopOptions {
  readonly tickHz?: 60;                  // M0: exactly 60
  readonly maxCatchUpSteps?: 5;          // death-spiral clamp
  readonly now: () => number;
  readonly raf: (cb: (nowMs: number) => void) => number;
  readonly cancel: (id: number) => void;
  readonly onTick: (dt: number) => void;
  readonly onRender: (alpha: number) => void;
}

// scene / ECS
export type EntityId = number;                       // dense index, never reused without a generation bump
export interface Entity { readonly id: EntityId; readonly generation: number; }
export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}
export interface Scene {
  createEntity(): Entity;
  destroyEntity(entity: Entity): void;
  isAlive(entity: Entity): boolean;
  add<T>(entity: Entity, component: ComponentType<T>, value: T): void;
  get<T>(entity: Entity, component: ComponentType<T>): T | undefined;
  remove<T>(entity: Entity, component: ComponentType<T>): void;
  /** Writes matches into a caller-owned result; no per-frame allocation. */
  query(out: Entity[], ...components: ComponentType<unknown>[]): Entity[];
  dispose(): void;
}

// math (spec 02 owns the full set)
export interface Vec2 { x: number; y: number; }
export interface Vec3 { x: number; y: number; z: number; }
export interface Vec4 { x: number; y: number; z: number; w: number; }
export interface Quat { x: number; y: number; z: number; w: number; }
export interface Mat4 { readonly m: Float32Array; }   // column-major, 16 floats

// renderer contract (implemented by both renderer packages; never seen by games)
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
export interface RenderDevice {
  readonly backend: RendererBackend;
  readonly features: ReadonlySet<EngineFeature>;
  readonly limits: DeviceLimits;
  init(surface: Surface): Promise<void>;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  beginFrame(): RenderFrame;
  endFrame(): void;
  createTexture(desc: TextureDesc): TextureHandle;
  createBuffer(desc: BufferDesc): BufferHandle;
  createMesh(desc: MeshDesc): MeshHandle;
  createMaterial(desc: MaterialDesc): MaterialHandle;
  createPipeline(desc: PipelineDesc): PipelineHandle;
  destroy(handle: GpuHandle): void;
  readonly stats: RenderStats;      // drawCalls, triangles, textureBytes, uploads
  readonly size: RendererSize;      // CSS pixels, zero before first resize
  dispose(): void;                  // idempotent
}
export interface RenderFrame {
  setCamera(viewProjection: Mat4): void;
  draw(mesh: MeshHandle, material: MaterialHandle, transform: Mat4): void;
  drawInstanced(mesh: MeshHandle, material: MaterialHandle, transforms: Float32Array, count: number): void;
}
// Handles are opaque, generational and owned by the device.
export interface GpuHandle { readonly index: number; readonly generation: number; }
export type MeshHandle = GpuHandle & { readonly __kind: "mesh" };
export type TextureHandle = GpuHandle & { readonly __kind: "texture" };
export type BufferHandle = GpuHandle & { readonly __kind: "buffer" };
export type MaterialHandle = GpuHandle & { readonly __kind: "material" };
export type PipelineHandle = GpuHandle & { readonly __kind: "pipeline" };

// errors, version, jobs, save envelope
export const ENGINE_VERSION: string;                  // lockstep for all @lanpad/engine-* packages
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly layer: "core" | "assets" | "renderer" | "physics" | "animation" | "audio" | "input" | "ai" | "streaming" | "ui" | "host";
  readonly recoverable: boolean;
}
export interface JobSystem {
  schedule<T>(job: Job<T>): JobHandle;
  cancel(handle: JobHandle): void;
  dispose(): void;
}
```

`Surface`, `RendererSize`, `DeviceLimits`, `TextureDesc`, `BufferDesc`, `MeshDesc`, `MaterialDesc`, `PipelineDesc`, `RenderStats`, `Job` and `JobHandle` are supporting structures owned by specs 01 and 04; their exact fields are part of those specs. `ComponentType` is the ECS registration contract and is owned by spec 03. The names above are fixed so implementation can start in parallel.

### 3.3 `@lanpad/engine-assets`

```ts
export type AssetKind =
  | "mesh" | "texture" | "material" | "audio" | "font" | "json" | "scene" | "animation";
export type AssetState = "queued" | "loading" | "ready" | "failed" | "disposed";
export interface AssetHandle<T = unknown> {
  readonly id: string;                 // stable manifest id, e.g. "meshes/sedan"
  readonly kind: AssetKind;
  readonly state: AssetState;
  readonly value: T;                   // valid only when state === "ready"; throws otherwise
  retain(): AssetHandle<T>;            // +1 ref
  release(): void;                     // -1 ref; at 0 the library may evict
}
export interface AssetLibrary {
  load<T>(id: string): Promise<AssetHandle<T>>;
  get<T>(id: string): AssetHandle<T> | undefined;
  readonly loadedBytes: number;
  readonly budgetBytes: number;
  readonly progress: { fetched: number; declared: number; determinate: boolean };
  dispose(): void;                     // releases all; idempotent
}
export interface AssetManifestEntry {
  readonly id: string;
  readonly kind: AssetKind;
  readonly url: string;                // relative, same-origin, no scheme, no ".."
  readonly bytes: number;              // declared size for progress/limits
  readonly hash?: string;              // "fnv1a32:xxxxxxxx" in dev
  readonly initial?: boolean;          // part of the boot set
}
export interface AssetManifest {
  readonly formatVersion: 1;
  readonly id: string;
  readonly budget: { readonly initialBytes: number; readonly totalBytes: number };
  readonly assets: readonly AssetManifestEntry[];
}
```

### 3.4 `@lanpad/engine-input`

```ts
export type InputActionKind = "button" | "axis" | "vector2";
export type InputSource =
  | { readonly device: "phone"; readonly slot: number; readonly channel: "button"; readonly bit: number }
  | { readonly device: "phone"; readonly slot: number; readonly channel: "axis";
      readonly axis: "lx" | "ly" | "rx" | "ry" | "lt" | "rt" }
  | { readonly device: "keyboard"; readonly code: string }
  | { readonly device: "pointer"; readonly axis: "x" | "y" | "wheel"; readonly button?: 0 | 1 | 2 }
  | { readonly device: "gamepad"; readonly pad: number; readonly button: number; readonly axis?: number };
export interface InputAction {
  readonly name: string;               // "move", "jump", "aim"
  readonly kind: InputActionKind;
  readonly bindings: readonly InputSource[];
  readonly deadzone?: number;          // 0..0.5, default 0.08 for sticks
}
export interface ActionState {
  readonly pressed: boolean;           // level
  readonly edges: number;              // press edges since the previous tick (bit 0 = primary)
  readonly x: number;                  // -1..1
  readonly y: number;                  // -1..1
  readonly value: number;              // 0..1 (triggers)
}
export interface InputMap {
  readonly actions: readonly InputAction[];
  /** Polled exactly once per simulation tick; clears edges. */
  poll(out: ActionState[]): ActionState[];
}
```

The phone bridge is an adapter: `engine-input` defines `PhoneInputSample` structurally equal to the host's `ControllerState`; `packages/runtime` converts `InputFwd` frames into it. `engine-input` never imports `@lanpad/protocol` and never opens a socket.

### 3.5 `@lanpad/engine-streaming` and save envelope

```ts
export interface WorldCellId {
  readonly cx: number;                 // grid coordinate, i32
  readonly cy: number;                 // grid coordinate, i32
}
export type CellKey = `${number},${number}`;   // canonical: "12,-3"
export type CellState = "unloaded" | "loading" | "resident" | "evicting";
export interface WorldCell {
  readonly id: WorldCellId;
  readonly key: CellKey;
  readonly lod: 0 | 1 | 2 | 3;         // 0 = richest
  readonly state: CellState;
  readonly bytes: number;
}
export interface SaveHeaderFields {
  readonly formatVersion: number;      // currently 1
  readonly engineMajor: number;
  readonly engineMinor: number;
  readonly enginePatch: number;
  readonly gameId: string;             // 1..64 UTF-8 bytes
  readonly gameVersion: string;        // 1..32 UTF-8 bytes
  readonly createdAtUnixSeconds: number;
  readonly payloadBytes: number;
  readonly payloadUncompressedBytes: number; // 0 when uncompressed
  readonly payloadHash: number;        // FNV-1a 32 over the payload
  readonly flags: number;              // bit 0 = payload deflated; bits 1..15 reserved 0
}
```

`WorldStreamer`, `GameUi` and `AnimationApi` are defined by specs 12, 13 and 08; only their names are fixed here. Their fields are additive within the SDK rules in §3.6.

### 3.6 Game-facing evolution (`@lanpad/sdk`)

`GameContext` is frozen. The engine grows it **only by optional members**:

| Member | Status | Notes |
|---|---|---|
| `manifest`, `input`, `renderer`, `audio`, `rng`, `debug`, `panels`, `layouts`, `haptics`, `events`, `serverNow()` | Frozen | Existing games keep working unchanged |
| `assets?: AssetLibrary` | Additive (M0) | Loading and retaining engine assets |
| `scene?: Scene` | Additive (M0/M1) | Engine-rendered world; runtime draws the scene before `game.render(alpha)` |
| `world?: WorldStreamer` | Additive (M2) | Cell queries and stream state |
| `ui?: GameUi` | Additive (M2) | Screen-space HUD/menu API |
| `animation?: AnimationApi` | Additive (M1) | Clip playback by entity |
| `renderer.capabilities?: RendererCapabilities` | Additive (M0) | Feature query; games branch on **features**, never on `backend` for correctness |
| `renderer.backend` union gains `"webgpu"` | Additive at runtime, SDK minor | Games must not exhaustively switch on backend |

The SDK **restates these structures structurally** (`Scene`, `AssetHandle`, `AssetLibrary`, `InputAction`, `WorldStreamer`, `GameUi`, `AnimationApi`, `RendererCapabilities`) instead of importing engine packages. This preserves `sdk` as a zero-dependency leaf and keeps the controller bundle at 40 KB. `packages/runtime` contains a compile-time assignability test proving the engine's concrete types satisfy the SDK's structural ones; a mismatch fails `npm run typecheck`, not a game at runtime.

A game built against SDK 1.x must run on any higher engine minor with the same major. Removals and semantic changes to existing members require SDK 2.0 plus an amendment.

### 3.7 Package export map

| Package | Entry points | Browser | Node |
|---|---|---|---|
| `@lanpad/engine-core` | `.` | yes | yes |
| `@lanpad/engine-assets` | `.`, `./manifest` | yes | yes (manifest only) |
| `@lanpad/engine-input` | `.` | yes | yes (pure mapping) |
| `@lanpad/engine-renderer-webgpu` | `.` | yes (WebGPU) | no |
| `@lanpad/engine-renderer-webgl2` | `.`, `./canvas2d` | yes | no |
| `@lanpad/engine-physics` | `.` | yes | yes |
| `@lanpad/engine-animation` | `.` | yes | yes |
| `@lanpad/engine-audio` | `.` | yes | fake only |
| `@lanpad/engine-ai` | `.` | yes | yes |
| `@lanpad/engine-streaming` | `.` | yes | yes (logic only) |
| `@lanpad/engine-ui` | `.` | yes | layout only |
| `@lanpad/engine-tooling` | `.`, `./browser` | dev overlay | yes (CLI) |

---

## 4. Data formats

### 4.1 Version registry

Every persisted or parsed format carries an integer `formatVersion`. Readers accept their current version and, where a migration exists, the previous one; they never guess.

| Name | Current | Owner spec | Bump rule |
|---|---|---|---|
| `ENGINE_VERSION` | `0.1.0` at M0 | 00 | Lockstep across all `@lanpad/engine-*` packages; minor bumps at milestones, `1.0.0` at public SDK release |
| `ASSET_MANIFEST_VERSION` | 1 | 06 | Breaking field/shape change; readers keep v1 support for one milestone |
| `MESH_FORMAT_VERSION` | 1 (GLB subset) | 06 | New required attribute or compression = new version |
| `SCENE_FORMAT_VERSION` | 1 (M1) | 03 / 17 | Breaking serialized field change |
| `WORLD_CELL_KEY_VERSION` | 1 | 12 | Key canonicalization change |
| `SAVE_FORMAT_VERSION` | 1 (M1) | 15 | Any byte-layout or payload-semantics change |
| `PROTOCOL_VERSION` | 1 (unchanged) | protocol spec | Same rule as today: rename/semantic change requires bump + amendment |
| `SDK_VERSION` | `1.x` | 18 | Optional member additions = minor; removal/rename = major |

### 4.2 Asset manifest (`asset-manifest.json`)

One manifest per game, at the game root, validated by host and tooling before boot. Synthetic example:

```json
{
  "formatVersion": 1,
  "id": "example-game",
  "budget": { "initialBytes": 3145728, "totalBytes": 5242880 },
  "assets": [
    {
      "id": "textures/atlas-01",
      "kind": "texture",
      "url": "assets/atlas-01.ktx2",
      "bytes": 524288,
      "hash": "fnv1a32:1a2b3c4d",
      "initial": true
    },
    {
      "id": "meshes/sedan",
      "kind": "mesh",
      "url": "assets/sedan.glb",
      "bytes": 262144,
      "initial": false
    }
  ]
}
```

Rules:

- UTF-8 JSON, **≤ 256 KB**, **≤ 4096** assets, unique `id`s matching `^[a-z0-9][a-z0-9/_.-]{0,127}$`.
- `url` is a same-origin relative path: no scheme, no host, no `//`, no `..` segment, no query, no fragment. Path traversal is rejected before fetch.
- `bytes` is a positive integer and must equal the served `Content-Length` in dev; a mismatch fails the load.
- `initial: true` assets form the boot set. `budget.initialBytes ≤ budget.totalBytes ≤ 5 MB` for v1 (FR-9.6); a larger game needs a recorded budget amendment.
- `hash` is optional and dev-only. Production integrity is TLS plus immutable deploy.
- Unknown fields are ignored for forward compatibility; an unknown `formatVersion` is refused with `E_ASSET_FORMAT`.
- The manifest is data, never code. Parsing uses `JSON.parse` plus field validation; no `eval`, no module loading from asset bytes.

### 4.3 Runtime asset formats

| Kind | M0 runtime format | Accepted source (tooling converts) | Notes |
|---|---|---|---|
| mesh | GLB (glTF 2.0 binary), uncompressed | glTF/GLB, OBJ for tools only | Triangle primitives; indices u16/u32; `POSITION`, `NORMAL`, `TANGENT`, `TEXCOORD_0`, `COLOR_0`; no sparse accessors |
| mesh (compressed) | deferred to M1 | Meshopt or Draco via tooling | No third-party decoder enters a browser bundle before M1 |
| texture | KTX2 (BasisU/ETC2/ASTC) or WebP | PNG, JPEG, WebP, KTX2 | Transcode by tooling; runtime picks the supported variant from `EngineFeature` |
| audio | Opus in Ogg/WebM; WAV in dev | WAV, Ogg, MP3 (tooling) | `decodeAudioData`; music streamed, SFX preloaded |
| font | WOFF2 or bitmap atlas | TTF/OTF (tooling) | SDF atlas generated by tooling |
| scene | `.scene.json` (`SCENE_FORMAT_VERSION`) | editor JSON | M1; not loaded by M0 |
| save | `.pps` (`SAVE_FORMAT_VERSION`) | game state | M1; header defined below |
| json | `.json` | any | Game data; ≤ 4 MB per asset |

No engine package parses a format it does not own. `engine-assets` owns mesh/texture/audio/font/json decode; `engine-animation` consumes animation data already decoded by assets; `engine-streaming` consumes scene/cell records produced by the tooling.

### 4.4 World cell keys

`WorldCell.key` is canonical decimal `"<cx>,<cy>"`:

- both components are signed 32-bit integers;
- no `+` sign, no leading zeros (`0`, `-3`, `12` — never `-0`, `+3`, `003`);
- `-0` normalizes to `0`;
- the cell **size in metres is a world configuration property**, not part of the key, so a world cannot mix cell sizes silently.

The key is the stable identity used by streaming, saves and tooling. Changing canonicalization requires a `WORLD_CELL_KEY_VERSION` bump and a migration for saved resident-cell lists.

### 4.5 Save header (`SaveHeader`)

Fixed 40-byte little-endian prefix, then two UTF-8 strings, then zero padding to an 8-byte boundary. All multi-byte integers are little-endian via `DataView`.

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | 4 | `magic` | ASCII `PPSV` |
| 4 | u16 | `formatVersion` | 1 |
| 6 | u16 | `headerBytes` | `40 + gameIdBytes + gameVersionBytes`, padded to 8; ≤ 144 |
| 8 | u32 | `payloadBytes` | Compressed payload length; ≤ 32 MiB |
| 12 | u32 | `payloadHash` | FNV-1a 32 over the stored payload |
| 16 | u16 | `engineMajor` | From `ENGINE_VERSION` |
| 18 | u16 | `engineMinor` | From `ENGINE_VERSION` |
| 20 | u16 | `enginePatch` | From `ENGINE_VERSION` |
| 22 | u16 | `gameIdBytes` | 1..64 |
| 24 | u16 | `gameVersionBytes` | 1..32 |
| 26 | u16 | `flags` | bit 0 = payload deflated; bits 1..15 reserved, must be 0 |
| 28 | u32 | `createdAtUnixSeconds` | Save wall-clock time, not simulation time |
| 32 | u32 | `payloadUncompressedBytes` | 0 when bit 0 clear |
| 36 | u32 | `reserved` | 0 |
| 40 | bytes | `gameId` | UTF-8, no NUL, no slash |
| … | bytes | `gameVersion` | UTF-8, no NUL |
| … | bytes | padding | Zero to 8-byte boundary |

Read rules: verify the magic, `headerBytes`, both lengths and the padding; hash the stored payload before handing it to the game; reject a newer `formatVersion` with `E_SAVE_VERSION`; migrate older versions through an explicit chain; never partially apply a save. The payload itself is game-owned and opaque to the engine.

### 4.6 URL and naming rules

- All runtime asset URLs are same-origin and relative to the game root. The dev CSP is `default-src 'self'`; production adds no CDN in v1.
- Bundled games live at `/games/<slug>/`; their assets live under `/games/<slug>/assets/`.
- File extensions are part of the contract: `.glb`, `.ktx2`, `.webp`, `.opus`, `.ogg`, `.woff2`, `.scene.json`, `.pps`, `.json`.
- No token, room code, player name or other session data may appear in an asset URL or filename (SR-2, SR-9).

---

## 5. Architecture

### 5.1 Layer map

```
                    ┌──────────────────────────────────────────────┐
                    │ packages/runtime — host shell + composition  │
                    │ packages/controller — phone app              │
                    └───────────────┬──────────────────────────────┘
                                    │ runtime imports; controller does not
        ┌───────────────────────────┼───────────────────────────────┐
        ▼                           ▼                               ▼
 renderer-webgpu              renderer-webgl2                 feature packages:
        │                           │                     assets · physics · animation
        └─────────────┬─────────────┘                     audio · input · ai · streaming · ui
                      ▼                                               │
                 engine-core ◀───────────────────────────────────────┘
                      ▲
              (zero dependencies)

 protocol ◀── broker ◀── dev-server          sdk (zero deps) ◀── games
                                                   ▲
                                             controller
```

Legend: an arrow `A ◀── B` means "B imports A". `engine-core` is the floor of the engine; `protocol` is the floor of the network stack; `sdk` is the game-facing contract and imports nothing.

### 5.2 Dependency rules (enforced)

| Rule | Statement | Enforcement |
|---|---|---|
| D1 | `engine-core` imports no workspace package and no third-party runtime package. | `package.json` + boundary test |
| D2 | Every engine package may import `engine-core`. The only other allowed feature edges are: `animation → assets`, `ai → physics`, `streaming → assets`, `ui → assets`. | eslint `no-restricted-imports` per directory |
| D3 | Engine packages must not import `@lanpad/protocol`, `@lanpad/sdk`, `@lanpad/runtime`, `@lanpad/controller`, `@lanpad/broker`, `@lanpad/dev-server` or a game package. The single exception is `engine-tooling` importing `sdk` types (D8), which never reaches a browser bundle. | eslint + boundary test |
| D4 | `sdk` imports nothing. It is the only package shared by controller and games, and the controller has 166 bytes of gzip headroom. | `sdk/package.json` `dependencies: {}` |
| D5 | `packages/runtime` is the only composition root and the only package allowed to import every engine package. | eslint rule + review |
| D6 | Games import `@lanpad/sdk` only (plus their own relative files). | existing eslint rule |
| D7 | Controller imports `@lanpad/protocol` and `@lanpad/sdk` only. | existing eslint rule |
| D8 | `engine-tooling` is dev-only. Its Node entry may import `engine-core`, `engine-assets` and `sdk` types; its `./browser` entry may be dynamically imported by a dev build. Production bundles must not include it. | `sideEffects` + build graph test |
| D9 | The two renderer backends are siblings; neither imports the other. Spec 05 implements the contract defined by spec 04, but the package dependency is `engine-core` only. | eslint |
| D10 | No game-specific code in any engine package. A feature needed by one game is either general or lives in the game. | review + traceability |
| D11 | `engine-core` simulation modules use no DOM types. DOM access is confined to `engine-core/src/platform/`, `engine-input`, `engine-audio`, `engine-ui` and `engine-renderer-*`. | tsconfig `lib` split + review |
| D12 | No hard-coded WebSocket origin, room code or server URL in any package; runtime config supplies it. | existing eslint rule |

The full dependency list is closed. Adding an edge requires editing this table and the eslint config in the same change.

### 5.3 Package catalogue

**`@lanpad/engine-core`** — the engine floor: `ENGINE_VERSION`, error taxonomy, math (`Vec2`/`Vec3`/`Vec4`, `Mat3`/`Mat4`, `Quat`, AABB, ray, plane, frustum), fixed loop and clock, frame statistics, the scene/ECS core, generational GPU/entity handles, the resource registry, the backend-neutral `RenderDevice` contract, the job-system interface, the seeded RNG and the save-header codec. It has no third-party dependency and no DOM dependency in sim modules. Everything a renderer or feature package needs to agree on lives here once.

**`@lanpad/engine-renderer-webgpu`** — implements `RenderDevice` on WebGPU: adapter/device acquisition, canvas configuration, swapchain and resize, pipeline and bind-group caches, uniform ring buffers, mesh/texture upload, camera and frustum culling, render-pass scheduling, timestamp queries when available, and device-loss recovery. It draws what the scene says and owns no game logic. PBR, shadows, post-processing and LOD are added by spec 04 behind capability flags.

**`@lanpad/engine-renderer-webgl2`** — the same `RenderDevice` contract on WebGL2, plus a `./canvas2d` entry point that implements the 2D subset without GPU requirements. It is a first-class TV backend, not a stub: no compute, no storage buffers, CPU culling, vertex-shader skinning, compressed textures only where a feature flag says so, and context-loss recovery. It must pass the same conformance suite as WebGPU.

**`@lanpad/engine-assets`** — manifest validation, byte-accurate progress, refcounted `AssetHandle`s, worker-based decode for GLB/KTX2/WebP/Opus, budget enforcement and dev hot reload. It produces CPU-side data in `engine-core` types and never creates GPU resources; the renderer uploads. Eviction is explicit and reference-counted, never a heuristic that can free an asset a game is holding.

**`@lanpad/engine-physics`** — deterministic fixed-step physics: bodies, shapes, broadphase, narrowphase, constraints, raycasts, a character controller and a vehicle model. The existing 2D circle/AABB solver migrates here as `src/two-d/` and keeps its current semantics. 3D physics is M1+; the package exists at M0 only as a migration target so the boundary is fixed early.

**`@lanpad/engine-animation`** — skeletal clips, blend trees, layered poses, root motion, morph targets and event markers. It samples poses into caller-owned buffers consumed by the renderer; it never draws and never touches the network. It depends on `engine-assets` for decoded skeleton/clip data.

**`@lanpad/engine-audio`** — the Web Audio graph: master/music/SFX buses, positional audio, voice pooling, fades, streaming music and radio-style sources, and scheduling against `AudioContext.currentTime`. It preserves today's gesture-unlock rule and silent-while-locked behavior.

**`@lanpad/engine-input`** — device abstraction and action maps. It consumes phone samples supplied by the runtime adapter, host keyboard/mouse events and gamepad snapshots; applies deadzones; accumulates edges; publishes one `ActionState` per action per tick. It has no socket, no protocol import and no DOM dependency in the pure mapping path.

**`@lanpad/engine-ai`** — navmesh construction and queries, A*, path smoothing, behavior trees, steering and crowd/traffic agents. All decisions are taken on the fixed tick; no wall-clock or worker race may change behaviour. It depends on physics for raycasts and collision queries.

**`@lanpad/engine-streaming`** — world cells, LOD tiers, budgeted asynchronous load/unload, camera-centred prefetch, backpressure and memory-pressure eviction. It uses assets and the job system, exposes `WorldCell` state to games, and guarantees that no streaming task blocks the main thread for more than 8 ms.

**`@lanpad/engine-ui`** — retained-mode 2D/3D UI: HUD, menus, SDF and bitmap text, focus/navigation for TV remotes, safe-area handling and accessibility hooks. Text is cached offscreen and re-rasterized only when content or scale changes; the render path allocates nothing.

**`@lanpad/engine-tooling`** — dev-only glue: a Node-side entry for asset audit, GLB validation, KTX2/WebP/audio conversion wrappers, atlas packing, shader compile checks and the benchmark runner, plus a browser `./browser` entry for the profiler overlay. The Node entry may use dev-only npm packages; the browser entry is dynamically imported only in dev builds. `tools/*` remain thin CLIs on top of it.

**Existing packages.** `@lanpad/protocol` stays wire truth and is untouched by engine work. `@lanpad/broker` and `@lanpad/dev-server` stay room/relay/static layers. `@lanpad/controller` stays the phone app and never imports engine code. `@lanpad/sdk` stays the zero-dependency game contract and validators. `packages/runtime` becomes the host composition root and shell; after the migration it contains no renderer, asset, audio, input-mapping, physics or profiling implementation. `packages/games/*` consume only `@lanpad/sdk`.

### 5.4 Dependency graph

```
games ──────────────▶ sdk (zero deps)
controller ─────────▶ protocol, sdk
runtime ────────────▶ protocol, sdk, engine-core, engine-assets, engine-input,
                      engine-renderer-webgpu, engine-renderer-webgl2,
                      engine-physics, engine-animation, engine-audio,
                      engine-streaming, engine-ui, engine-ai, engine-tooling (dev)
engine-core ────────▶ (nothing)
engine-assets ──────▶ engine-core
engine-physics ─────▶ engine-core
engine-animation ───▶ engine-core, engine-assets
engine-audio ───────▶ engine-core
engine-input ───────▶ engine-core
engine-ai ──────────▶ engine-core, engine-physics
engine-streaming ───▶ engine-core, engine-assets
engine-ui ──────────▶ engine-core, engine-assets
engine-renderer-webgpu ──▶ engine-core
engine-renderer-webgl2 ──▶ engine-core
engine-tooling ─────▶ engine-core, engine-assets, sdk (dev only; never in a production bundle)
broker, dev-server ─▶ protocol
```

`packages/runtime` is not imported by anything except tests and the dev server's static output; it is the top of the graph. `sdk` is deliberately a leaf: duplicating a handful of structural types is cheaper than dragging engine code into the 40 KB controller bundle.

### 5.5 Host composition and the game boundary

`packages/runtime` is the composition root. A host boot is:

1. Detect capabilities and select a backend (`selectRenderer.ts`): WebGPU → WebGL2 → Canvas2D (2D games only).
2. Create the `RenderDevice`, `JobSystem`, `AssetLibrary` and `InputMap`; load the boot asset set.
3. Create the `Scene` and, when the milestone lands, the `WorldStreamer`.
4. Join the room through the existing host client; do not change the protocol.
5. `GameHost` validates the manifest, loads the game entry, and assembles `GameContext` from adapters.
6. Per tick: poll input once, then `game.simulate(dt, snapshot)`; per display frame: begin the engine frame, render the scene, call `game.render(alpha)`, draw host UI, end the frame.
7. Teardown in reverse: `game.dispose()` → streaming stop → scene dispose → asset library dispose → device dispose → job system dispose.

The **legacy renderer adapter** is the compatibility seam. It implements `GameRenderer3D` (`backend`, `beginFrame`, `endFrame`, `setCamera`, `drawCube`, `drawCalls`, `textureMemoryMB`) over the new `RenderDevice`:

- `beginFrame`/`endFrame` become idempotent markers inside the engine-owned frame, so existing games that call them do not break;
- `setCamera` writes the scene camera instead of a backend-specific matrix;
- `drawCube` draws a shared unit-cube mesh with a cached material per colour, preserving the 1280×720 design space, DPR and CSS size contract;
- a Canvas2D compatibility path preserves exact current visuals for the two reference games.

Games never receive a `RenderDevice`, a GPU handle, an `AssetHandle` that resolves to raw GPU data, or a backend-specific object. Backend selection is invisible; capability differences are expressed only through `renderer.capabilities`.

### 5.6 Threading and jobs

**Main thread owns:** input capture, simulation (`simulate`), render-frame encoding, GPU device calls, scene mutation and game lifecycle. This is non-negotiable in M0–M1 because the game API is synchronous and single-threaded.

**Workers own:** GLB parsing, KTX2 transcoding, image decode via `createImageBitmap`, audio decode, atlas generation, navmesh build (M2), save compression and streaming prefetch. Workers receive copied data or transferables; they never receive GPU handles, scene references or asset handles.

`JobSystem` (interface in `engine-core`, implementation in `runtime`) rules:

- one shared pool sized `min(4, max(1, hardwareConcurrency - 1))`, created lazily on first job;
- priorities `critical` (boot assets) > `normal` (visible streaming) > `idle` (prefetch, audits);
- every job has a cancellation token; late results after cancellation are discarded, never applied;
- results are consumed at tick boundaries; a job may not mutate simulation state directly;
- `SharedArrayBuffer` is optional and capability-gated; the design must be correct without it;
- worker crash or `postMessage` failure surfaces `E_WORKER_FAILED` and degrades to main-thread decode for the affected asset, not a blank screen;
- no single main-thread task caused by streaming or decode may exceed **8 ms** (FR-9.10). Uploads are time-sliced by the renderer's upload budget; boot may block but must show byte-accurate progress.

Vite bundles workers per package; worker entry points are declared explicitly and must not import DOM modules.

### 5.7 Memory ownership and resource lifetime

| Resource | Owner | Lifetime end |
|---|---|---|
| CPU asset bytes and decoded data | `AssetLibrary` | `AssetHandle` refcount reaches zero and the library evicts, or `dispose()` |
| GPU textures/buffers/meshes/pipelines | `RenderDevice` | explicit `destroy(handle)`, scene unload, or `dispose()` |
| Scene entities and components | `Scene` | `destroyEntity` or `scene.dispose()` |
| World cells | `WorldStreamer` | cell eviction or streamer stop |
| Input state | `InputMap` / runtime adapter | loop stop |
| Jobs and worker pool | `JobSystem` | `dispose()` |
| Game-owned data | the game | `game.dispose()` |

Rules:

- Every handle is generational. A stale `Entity` or GPU handle is detected (`generation` mismatch) and fails with `E_STALE_HANDLE` in dev; production treats it as a no-op with a counter.
- `retain()`/`release()` are explicit. A game that keeps an `AssetHandle` past init must retain it; the runtime releases its own references at teardown.
- `dispose()` is idempotent everywhere. Double dispose never throws.
- **Teardown order is fixed:** pause loop → `game.dispose()` → streamer stop and cell release → scene dispose → asset library release-all → render device dispose → job system dispose. Reversing this order is a leak or use-after-free.
- **Context loss:** the device invalidates all GPU handles and rejects in-flight uploads. CPU-side asset data and scene state survive. The runtime attempts one device re-create, re-uploads lazily on the next frame, and restores pipelines from cached descriptors. Two failures in a row fall back to the next backend tier and show a notice.
- A dev-only resource tracker logs counts on scene unload and warns when textures/buffers survive their owner; it is compiled out of production bundles.

Budgets: the existing provisional limits stay until hardware measurements replace them — ≤ 120 draw calls per frame (PR-9.1), ≤ 128 MB texture memory (PR-9.2), host + game ≤ 5 MB gz (NR-6.1). The renderer reports `stats.textureBytes` and `stats.uploads` every frame at no allocation cost.

### 5.8 Determinism

Required within one build on one browser:

- fixed 60 Hz simulation; the loop's accumulator clamp is 5 steps (83.3 ms) and never changes per game;
- all simulation randomness comes from the seeded RNG in `GameContext` (mulberry32, default seed 1) or an engine RNG created from it; `Math.random` is banned in engine packages by lint;
- no `Date.now`, `performance.now`, `new Date()` or timer callbacks inside `simulate`; time enters only as `dt` and `tick`;
- iteration order is dense-array order; entity queries never depend on `Map`/`Set` hash order or object key order;
- worker results are applied at a tick boundary in a deterministic order (sorted by request id), never mid-tick;
- input is latest-wins for levels and OR-accumulated for edges, exactly as the existing mapper does.

**Scope limit.** Cross-browser bit-identical simulation is *not* required in v1. `Math.sin`/`Math.cos`/`Math.pow` may differ in the last bits between engines, and WebGPU/WebGL2 do not affect simulation. Replays are therefore guaranteed per build and per browser: record input trace + seed + tick count + `ENGINE_VERSION`, replay on the same build, compare an FNV-1a state hash. Lockstep networking would demand stricter rules and is out of scope (spec 14 may revisit).

Replay fixture format (JSON): `{ version: 1, engineVersion, gameId, seed, ticks, packets: [{ tick, slot, buttons, edges, lx, ly, rx, ry, lt, rt }] }`. It is a test fixture, not a wire format.

### 5.9 Error handling

```ts
export type EngineErrorCode =
  | "E_DEVICE_UNAVAILABLE" | "E_DEVICE_LOST" | "E_BACKEND_INIT"
  | "E_PIPELINE_COMPILE" | "E_UNSUPPORTED_FEATURE"
  | "E_ASSET_LOAD" | "E_ASSET_FORMAT" | "E_ASSET_BUDGET" | "E_ASSET_HASH"
  | "E_ASSET_NOT_READY" | "E_ASSET_UNKNOWN" | "E_ASSET_ABORTED"
  | "E_ASSET_UNSUPPORTED" | "E_ASSET_EVICTED"
  | "E_INPUT_FORMAT" | "E_INPUT_CONFLICT" | "E_INPUT_RESERVED"
  | "E_INPUT_CAPTURE" | "E_INPUT_TICK" | "E_INPUT_DEVICE"
  | "E_AUDIO_DEVICE" | "E_AUDIO_DECODE" | "E_AUDIO_FORMAT" | "E_AUDIO_BUDGET"
  | "E_SCENE_INVALID" | "E_SCENE_FORMAT" | "E_STALE_HANDLE" | "E_FRAME_CLOSED"
  | "E_SAVE_FORMAT" | "E_SAVE_VERSION" | "E_SAVE_HASH" | "E_SAVE_GAME"
  | "E_SAVE_QUOTA" | "E_SAVE_IO" | "E_SAVE_MIGRATION" | "E_SAVE_SLOT" | "E_SAVE_UNSUPPORTED"
  | "E_WORKER_FAILED" | "E_CONTRACT";
```

Rules:

- Validate at boundaries (manifest, save header, layout, asset URL, action map). The per-frame path assumes validated data and does not re-check.
- Nothing throws from `simulate`, render encoding or input polling in normal operation. Recoverable failures increment a counter and degrade one feature; unrecoverable failures stop the loop and route an `EngineError` to the host notice panel.
- Error messages never contain tokens, room codes, player names or full URLs with credentials. Asset errors name the asset id and a redacted path.
- Dev mode (`?debug=1`) shows code, layer, asset id and the first stack frame; production shows a human sentence plus the code.
- Shader and pipeline compilation happens at load or first use, never as a per-frame surprise; failures are cached so the same broken pipeline is not retried every frame.
- The existing `GameHost` failure path (stop loop, record error, notice, idempotent dispose) is preserved.

### 5.10 The no-per-frame-allocation rule

Hot paths are `InputMap.poll`, `game.simulate`, scene update, render-frame encoding, streaming tick and the profiler's steady state. In these paths:

- no `new`, no object/array literals, no closures, no `map`/`filter`/`forEach`/spread, no string concatenation;
- all scratch vectors, matrices, query results, command lists and transform arrays are preallocated and reused;
- events and debug counters use fixed-capacity rings; strings are created only when a value changes (`setCounter`), never per frame;
- async APIs are not awaited inside a tick; work is queued and consumed later.

Allowed allocations: boot, asset load, scene creation/destruction, event handling, UI rebuild on change, and any code gated by `debug.enabled`. A new allocation in a hot path needs a comment explaining why it is not per-frame in practice.

Enforcement: code review, the lint ban on `Math.random`, the `bench:alloc` fixture (§7 A7), and a heap-growth threshold in the M0 benchmark. V8's sampling profiler identifies allocation sites in dev.

### 5.11 Browser targets and renderer tiers

| Tier | Backend | Target | 3D | 2D | Notes |
|---|---|---|---|---|---|
| **A** | WebGPU | Chromium desktop 113+; provisional v1 target Desktop Chrome 155 on Windows 11 | full | full | Compute, storage buffers, timestamp queries when the adapter exposes them |
| **B** | WebGL2 | Chromium and Firefox desktop; Chromium-based TV browsers (Android TV, Tizen, webOS) | reduced | full | No compute; CPU culling; vertex-shader skinning; compressed textures only if flagged |
| **C** | Canvas2D | Any browser with a 2D context | **refused** | full | Last resort for 2D only; never silently used for a 3D game |
| **D** | none | No usable context | refused | refused | Friendly notice plus PC/HDMI hint |

Selection is **feature detection only** (FR-12.1):

1. `navigator.gpu?.requestAdapter()` → non-null adapter → `requestDevice()` succeeds → Tier A.
2. `canvas.getContext("webgl2")` → Tier B, with extensions probed individually (`EXT_color_buffer_float`, `OES_texture_float_linear`, `WEBGL_compressed_texture_*`).
3. `canvas.getContext("2d")` → Tier C; allowed only when the game declares 2D-only.
4. Otherwise Tier D.

Rules:

- **No UA sniffing for capability.** `navigator.userAgent` may be read only to render a human browser name in a failure message (existing `displayBrowserName`), never to choose a code path.
- A `navigator.gpu` object that exists but yields no adapter is Tier B, not an error.
- The game manifest may declare `requiredFeatures: EngineFeature[]`; the runtime compares against the selected device and refuses early with `E_UNSUPPORTED_FEATURE` and a specific sentence ("This game needs WebGPU compute; this browser provides WebGL2"). No mid-game failure.
- Device profiles (`tv`, `desktop`, `mobile-controller`) set DPR caps, render-scale floor, shadow/texture budgets and target frame rate. They are derived from measured device data where available, not from brand names.
- Dynamic resolution stays: drop render scale 10% after 30 consecutive frames over 20 ms, floor 60%, recover slowly (FR-9.5). The engine owns render scale; games see only the CSS size.
- TV is expected to be Tier B for v1. WebGPU on a TV is treated as Tier A if it appears, with TV budgets; its absence changes nothing.

### 5.12 WebGPU unavailability and fallback

The fallback chain is fixed:

```
request WebGPU ──adapter/device/init fails──▶ WebGL2 ──fails──▶ Canvas2D (2D game only) ──fails──▶ notice
```

- **No adapter / blocked / software fallback disabled:** Tier B. The user sees no error; the debug overlay records `backend=webgl2` and the reason.
- **`requestDevice` rejects or the device is lost before first frame:** try one fresh adapter request, then Tier B.
- **Device lost after running:** pause the loop, attempt one re-create; on success restore from descriptors; on failure fall back to Tier B and rebuild; on a second failure show the notice. A save-in-progress is abandoned, never half-written.
- **Driver bug or hang:** the renderer has a per-frame watchdog only in dev (`?debug=1`), which logs the last pipeline/scene; production relies on the host notice path rather than killing frames.
- **Feature gaps on WebGL2:** compute, storage buffers, timestamp queries and large bind groups are absent. Games must degrade through `renderer.capabilities`; a required feature is declared in the manifest and refused early. Engine features that need compute (GPU culling, particle simulation) must ship a CPU path or be optional.
- **What the fallback does not promise:** identical pixels or identical performance. It promises the same game, same input, same simulation, and a measured lower quality tier.

The architecture rule that makes this safe: **no game branches on `backend` for correctness, and no engine package imports a backend directly.** Only `packages/runtime/src/render/selectRenderer.ts` names the concrete backends.

### 5.13 Migration from `packages/runtime`

The migration is **move implementation down, keep the host shell**. No big-bang rewrite; every wave ends with `npm run check` green and both reference games playable.

| Current path | Target | Action |
|---|---|---|
| `packages/runtime/src/loop/FixedLoop.ts` | `packages/engine/core/src/time/FixedLoop.ts` | Move; runtime imports it |
| `packages/runtime/src/loop/types.ts` | `packages/engine/core/src/time/types.ts` | Move |
| `packages/runtime/src/physics/Vec2.ts` | `packages/engine/core/src/math/Vec2.ts` | Move |
| `packages/runtime/src/physics/Aabb.ts` | `packages/engine/core/src/math/Aabb2.ts` | Move |
| `packages/runtime/src/physics/collide.ts` | `packages/engine/physics/src/two-d/collide.ts` | Move; keep `Contact` and semantics exactly |
| `packages/runtime/src/physics/index.ts` | — | Compatibility re-export, then delete at M1 |
| `packages/runtime/src/input/InputMapper.ts` | `packages/engine/input/src/phone/InputMapper.ts` | Move; phone adapter feeds it |
| `packages/runtime/src/input/TiltIntegrator.ts` | `packages/engine/input/src/phone/TiltIntegrator.ts` | Move |
| `packages/runtime/src/input/types.ts` | `packages/engine/input/src/types.ts` | Move; `ControllerState` shape unchanged |
| `packages/runtime/src/assets/AssetLoader.ts` | `packages/engine/assets/src/loader/` | Split into manifest, bytes, progress and decode |
| `packages/runtime/src/assets/ProgressBar.ts` | — | **Stays** in runtime (DOM UI) |
| `packages/runtime/src/audio/AudioBus.ts` | `packages/engine/audio/src/AudioBus.ts` | Move; gesture unlock preserved |
| `packages/runtime/src/render/WebGL2Renderer.ts` | `packages/engine/renderer-webgl2/src/webgl2/` | Move and adapt to `RenderDevice` |
| `packages/runtime/src/render/Canvas2DRenderer.ts` | `packages/engine/renderer-webgl2/src/canvas2d/` | Move; exact visual parity |
| `packages/runtime/src/render/capability.ts` | `packages/engine/renderer-webgl2/src/webgl2/capability.ts` | Move; extend for WebGPU probe |
| `packages/runtime/src/render/Renderer.ts` | `packages/engine/core/src/compat/renderer-legacy.ts` + `packages/runtime/src/render/selectRenderer.ts` | Split contracts from selection |
| `packages/runtime/src/render/CubeDemo.ts` | `experiments/e-m0-engine/` | Becomes the M0 demo, not production code |
| `packages/runtime/src/profile/budgets.ts` | `packages/engine/core/src/profile/budgets.ts` | Move |
| `packages/runtime/src/profile/resolutionController.ts` | `packages/engine/core/src/render/resolution.ts` | Move; engine owns render scale |
| `packages/runtime/src/profile/framePacing.ts` | `packages/engine/core/src/profile/framePacing.ts` | Move |
| `packages/runtime/src/profile/tvProfile.ts` | `packages/engine/core/src/platform/deviceProfile.ts` | Move and generalise |
| `packages/runtime/src/profile/contextLoss.ts` | `packages/engine/core/src/render/contextLoss.ts` + per-backend handlers | Split |
| `packages/runtime/src/debug/Overlay.ts` | `packages/engine/tooling/src/browser/Overlay.ts` | Move; host mounts it |
| `packages/runtime/src/debug/inputTable.ts` | — | **Stays** (protocol-specific debug) |
| `packages/runtime/src/game/*` | — | **Stays**: `GameHost`, `GameContext` assembly, adapters, loader, registry |
| `packages/runtime/src/net/*`, `src/ui/*`, `src/main.ts` | — | **Stays** (host shell) |

**How games keep working during and after migration:**

1. `@lanpad/sdk` is untouched; `GameContext` members keep their names and semantics.
2. `GameHost` keeps its phases and tick order; only the implementations it calls move.
3. `LegacyGameRendererAdapter` preserves `GameRenderer3D`: 1280×720 design space, CSS size contract, `drawCube` colours/rotation, `drawCalls`, `textureMemoryMB`, and Canvas2D visuals.
4. `packages/runtime/src/index.ts` and `src/render/Renderer.ts` keep re-exports tagged `@deprecated` with a removal wave; no game imports them, but tests do.
5. Coin Run and Reaction Duel get golden-frame tests (§7 A10) before and after each migration wave.
6. Protocol, broker, dev-server and controller are not touched. A migration wave that changes a wire frame is a bug.
7. Migration waves are owned by the **integration agent**, not feature agents, and are serial across package boundaries (one writer per file).

Legacy 2D games may keep using `GameRenderer3D` indefinitely; it is frozen. New engine games use `ctx.scene` + `ctx.assets` when those land. There is no forced rewrite.

### 5.14 M0 foundation boundary

**In M0 (first wave):**

| Area | Included |
|---|---|
| Workspace | `packages/engine/*` workspaces, tsconfig references, Vitest projects, eslint rules, boundary test |
| `engine-core` | `ENGINE_VERSION`, errors, math (`Vec2/3/4`, `Mat3/Mat4`, `Quat` basics, AABB, ray), fixed loop/clock, frame stats, scene/ECS skeleton (`Entity`, `Transform`, create/destroy/add/get/remove/query), generational handles, resource registry, `RenderDevice` contract, seeded RNG, job interface, `SaveHeader` codec |
| `renderer-webgpu` | Adapter/device, canvas config, resize, pipeline cache, camera, textured mesh, instancing, one directional light, frustum culling, device-loss recovery |
| `renderer-webgl2` | Same scene through the same contract; Canvas2D `./canvas2d` 2D entry; capability probe; context-loss recovery |
| `assets` | Manifest validation, byte-accurate loading/progress, uncompressed GLB subset, KTX2/WebP textures, audio bytes, worker decode, budget enforcement |
| `physics` | 2D solver migration only (`Vec2`, `Aabb`, `collide`); no 3D features |
| `audio` | Existing `AudioBus` migration only; no positional audio or new buses |
| `input` | Keyboard/mouse/gamepad, phone adapter, action maps, deadzones, edge accumulation, parity with the legacy mapper |
| `tooling` | Asset audit CLI, manifest validator, package READMEs; shader validation if cheap |
| `runtime` | Composition root, `selectRenderer`, legacy adapter, both games green, existing budgets enforced |
| Evidence | `experiments/e-m0-engine/` demo + benchmark, golden capture, acceptance rows ER-00-01 to ER-00-11 |

**Explicitly deferred (do not build in M0):**

- 3D physics, vehicles, character controllers; 2D physics only moves.
- Skeletal animation, blend trees, morph targets, vertex-shader skinning.
- PBR, shadows, post-processing, LOD tiers, occlusion culling, GPU particles, compute culling.
- Positional audio, mixer buses beyond the existing stereo bus, music streaming.
- AI, navmesh, traffic, pedestrians.
- World streaming implementation. `WorldCell` is declared so saves and tools agree, but no streamer ships.
- 3D UI, SDF text, editor UI. Existing Canvas2D text remains.
- Save/load implementation; only the header codec exists.
- Editor, terrain, content pipeline beyond asset audit.
- Online relay, state sync, prediction.
- WebGPU on TV and Firefox WebGPU tuning.
- `SharedArrayBuffer`, worker-side simulation, GPU skinning.
- Package publishing, npm scope rename.
- New controller control types (the controller has 166 gz headroom; that is a separate size pass).

A wave that adds a deferred item to M0 is an M0 failure, even if it works.

### 5.15 Versioning and compatibility policy

**Engine packages.**

- All `@lanpad/engine-*` packages share one version, exported as `ENGINE_VERSION`. No independent versions in the monorepo.
- `0.1.0` at M0, `0.2.0` at M1, `0.3.0` at M2, `0.4.0` at M3, `1.0.0` at the public SDK release (P4). Patches for fixes.
- While `0.x`, a minor may contain a breaking change **only** at a milestone boundary, with an amendment and a migration note. After `1.0`, normal semver.
- Engine packages are private until P4. Publishing them is a separate decision with its own support policy.

**SDK and games.**

- `sdk` is the only contract a game compiles against. Its version is independent of `ENGINE_VERSION` and declares `minEngineVersion`.
- The host checks `sdk` compatibility at load and refuses with a clear message instead of failing mid-game.
- New `GameContext` members are optional and additive. Removing or changing one requires a major SDK and an amendment.
- A game is never rebuilt by the engine; the host runtime adapts.

**Assets.**

- Readers accept the current `formatVersion` and the previous one when a migration exists. Unknown newer versions are refused with `E_ASSET_FORMAT`.
- Tooling writes only the current version. Hash mismatches fail the load in dev; production relies on immutable deploys and TLS.
- Adding an optional manifest field does not bump the version. Changing required semantics does.

**Saves.**

- `SaveHeader.formatVersion` is the only compatibility gate. Readers migrate strictly forward through an explicit chain; a newer file is refused, never partially applied.
- Payload hashing happens before the game sees bytes. A failed hash leaves the previous save intact.
- The engine never deletes a save it cannot read.

**Protocol.**

- The engine does not change the wire. `PROTOCOL_VERSION` stays 1. If an engine feature needs a new frame, it requires a protocol bump, an amendment, controller tests and a size pass — and it is not an M0 item.

### 5.16 Workspace and CI changes required by M0

These are integration-agent changes, not feature-agent changes:

- root `package.json`: add `"packages/engine/*"` to `workspaces`; add a build/test order if needed.
- root `tsconfig.json`: add one project reference per engine package.
- root Vitest config: add one project per engine package that has tests; otherwise its tests never run under `npm test`.
- `eslint.config.js`: encode §5.2 rules per directory; add `Math.random` and `navigator.userAgent` restrictions for engine packages (UA allowed only in display helpers).
- `tools/size-budget`: keep the host and controller budgets; record engine package gzip sizes in the report even when they share the host bundle.
- `tools/trace-check`: map the new `ER-*` requirement IDs (§7) once `docs/todos/TRACEABILITY.md` has rows.
- `package.json` scripts: no new top-level gate. `npm run check` remains the one gate; engine tests join the existing `npm test`.

---

## 6. File ownership

This spec owns exactly one file: `docs/engine/00-architecture.md`. It owns no code. The paths below are the implementation map; the numbered spec named against each path is its single writer.

| Path | Owner spec(s) | M0 contents |
|---|---|---|
| `docs/engine/00-architecture.md` | 00 | This document |
| `packages/engine/core/src/version.ts`, `errors.ts`, `handles.ts`, `render/contract.ts`, `render/contextLoss.ts`, `compat/renderer-legacy.ts` | 00 | Contract scaffolding; handed to 04 after M0 |
| `packages/engine/core/src/time/**`, `src/jobs/**`, `src/platform/**` | 01 | Loop, clock, frame stats, job interface, device profile |
| `packages/engine/core/src/math/**` | 02 | Vec/Mat/Quat/AABB/ray/plane/frustum |
| `packages/engine/core/src/scene/**` | 03 | Entity/component storage, queries, transforms |
| `packages/engine/core/src/profile/**` | 01, 16 | Budgets, frame pacing, resolution controller |
| `packages/engine/core/src/save/header.ts` | 15 | `SaveHeader` codec and fixture |
| `packages/engine/renderer-webgpu/**` | 04 | Device, pipelines, camera, textured instanced mesh, device loss |
| `packages/engine/renderer-webgl2/**` | 05 | Same contract on WebGL2; `canvas2d/` entry |
| `packages/engine/assets/**` | 06 | Manifest, loaders, worker decode, refcounts, budgets |
| `packages/engine/physics/**` | 07 | 2D solver moves here; 3D is M1+ |
| `packages/engine/animation/**` | 08 | Package skeleton only in M0 |
| `packages/engine/audio/**` | 09 | Existing `AudioBus` moves here |
| `packages/engine/input/**` | 10 | Action maps, KB/M/gamepad, phone adapter, parity fixture |
| `packages/engine/ai/**` | 11 | Package skeleton only in M0 |
| `packages/engine/streaming/**` | 12 | Package skeleton + `WorldCell` type only |
| `packages/engine/ui/**` | 13 | Package skeleton only in M0 |
| `packages/engine/tooling/**` | 16, 17, 19 | Asset audit, manifest validator, profiler overlay |
| `packages/runtime/src/render/selectRenderer.ts`, `src/compat/**` | 00 migration wave (integration agent) | Selection + legacy adapter; `compat/` deleted at M1 |
| `packages/runtime/src/{game,net,ui,main.ts,index.ts}` | existing owners | Host shell; engine wave changes imports only |
| `experiments/e-m0-engine/**` | 19 | Demo, benchmark, golden capture |
| `docs/RESULTS.md` rows | 19 | Measurements only, never invented |

Rules:

- **One writer per file.** A wave declares ownership before fan-out. Two agents never touch the same file, including `package.json`, `tsconfig.json` and `eslint.config.js`.
- **Existing packages are not silently edited.** `protocol`, `broker`, `dev-server`, `controller` and `sdk` keep their owners. The only SDK change in M0 is the additive entry owned by spec 18 (`GameContext.assets`, `GameContext.scene`, optional capabilities), plus the corresponding validator/size tests.
- **`packages/runtime` hands over implementation, not ownership.** The integration agent owns the migration wave; feature agents own only their engine package. After the cutover, runtime changes that add engine implementation are rejected in review.
- **Shared contracts have one owner per wave.** `RenderDevice` is authored by 00 for M0 and owned by 04 afterwards. `GameContext` is authored by 18. `WorldCell` by 12. `SaveHeader` by 15. `InputAction` by 10.
- **Fixtures are owned by the spec that defines them.** A test may read another spec's fixture; it may not edit it.

---

## 7. Acceptance

Every row carries an `ER-00-NN` requirement ID. Tests and manual records must reference the ID, and the ID must resolve to a row in `docs/todos/TRACEABILITY.md` once the engine programme is registered there.

**Evidence rule:** a row is PASS only with a recorded build, device, browser version, date and numbers in `docs/RESULTS.md`. Untested rows say PENDING and name the run needed. No row is claimed from a specification.

| ID | Criterion | Fixture / method | Hardware | Evidence state |
|---|---|---|---|---|
| ER-00-01 | `npm run check` exits 0 with no test removed or weakened; `node tools/trace-check/dist/cli.js --stage D7` reports 0 missing | CI, full gate | CI Node 20 | PENDING — first green M0 wave |
| ER-00-02 | Package graph has no forbidden edge (§5.2); `npm run lint` passes with engine rules | `packages/engine/core/test/boundaries.test.ts` + eslint | CI | PENDING — after scaffolding |
| ER-00-03 | M0 scene: 5,000 instanced textured cubes, one directional light, 1920×1080 CSS, DPR 1, 600 measured frames after 120 warm-up; frame p95 ≤ **14 ms**; draw calls ≤ 120; texture memory ≤ 128 MB | `experiments/e-m0-engine/?backend=webgpu&instances=5000&bench=1` | Desktop Chrome 155, Windows 11; GPU adapter name recorded | **PASS 2026-10-23** — headless Chrome 155, `nvidia ampere`, p95 10.1 ms, 1 draw, 0 GPU errors; see `docs/RESULTS.md` |
| ER-00-04 | Same scene through WebGL2: p95 ≤ **20 ms** (hard budget), draw calls ≤ 120 | Same page, `?backend=webgl2` | Desktop Chrome 155, Windows 11 | **PASS 2026-10-23** — headless Chrome 155, p95 10.2 ms, 1 draw, 0 GPU errors; see `docs/RESULTS.md` |
| ER-00-05 | WebGPU and WebGL2 frames at tick 300 match within tolerance: ≤ 2% of pixels differ by more than 8/255 in any channel | `experiments/e-m0-engine/golden/` capture + in-page diff | Desktop Chrome 155, Windows 11 | PENDING — goldens captured at M0 |
| ER-00-06 | A 600-tick replay run twice produces the same FNV-1a state hash; changing the seed changes it | `packages/engine/core/test/fixtures/replay-600.json` | CI (Node) + Chrome 155 | PENDING — fixture authored with spec 01 |
| ER-00-07 | Steady-state heap growth ≤ 512 KiB over 480 frames after 120 warm-up frames; no per-frame allocation in the profiler's allocation sites | `?bench=1&alloc=1` on the M0 page | Desktop Chrome 155, Windows 11 (`performance.memory` available) | PENDING — needs the M0 page |
| ER-00-08 | A manifest declaring 5 MB of assets loads on localhost with byte-accurate progress; longest main-thread task ≤ 8 ms | `packages/engine/assets/test/fixtures/manifest-5mb.json` + PerformanceObserver `longtask` | Desktop Chrome 155, Windows 11 | PENDING — needs worker decode |
| ER-00-09 | 1,200-packet input-bot trace produces exactly the same buttons/edges/axes/triggers/tilt as the legacy mapper | `tools/input-bot` scenario `steady` → `packages/engine/input/test/fixtures/parity-1200.json` | CI (pure mapping) | PENDING — fixture generated at M0 |
| ER-00-10 | Coin Run and Reaction Duel pass existing tests and preserve visuals: ≤ 2% pixels differ at 300 frames on the Canvas2D path | `packages/games/*/test` + golden capture | Desktop Chrome 155 | PENDING — before/after migration |
| ER-00-11 | Host + M0 demo ≤ 5 MB gzip hard; controller ≤ 60 KB gzip and byte count unchanged by engine work; engine package sizes recorded | `npm run size` | CI | PENDING — first M0 build |
| ER-00-12 | TV WebGL2 tier runs the M0 scene and records p95, backend, memory and resolution | Same page, `?backend=webgl2`, TV profile | **PENDING device:** a 2020-era Android TV Chromium and a Tizen/webOS set from SPEC §12, run manually | PENDING — no TV hardware yet |
| ER-00-13 | WebGPU on TV, if the browser exposes it, is detected and measured; absence is a pass for Tier B | Same page, `?backend=webgpu` | **PENDING device:** any TV browser exposing `navigator.gpu` | PENDING — not expected in v1 |
| ER-00-14 | Renderer selection probes WebGPU → WebGL2 → Canvas2D, replaces a canvas claimed by a failed attempt, refuses a 3D request on Canvas2D, and emits fixed failure tokens that never contain exception text, URLs or tokens | `packages/runtime/test/integration/rendererFallback.test.ts` with injected factories | CI Node 20 | PENDING — first M0 run |
| ER-00-15 | The scene encoder queries `Renderable`, resolves only ready assets without reading `value`, stable-sorts by layer/material/mesh, skips missing/disabled/invisible entities, and reuses pooled buffers on the steady path | `packages/runtime/test/engine/sceneEncoder.test.ts` with a fake scene/frame | CI Node 20 | PENDING — first M0 run |
| ER-00-16 | Ready decoded assets resolve to one cached GPU resource per asset; meshes pack to ABI 1 (merged primitives, uint32 widening above 65,535 vertices); textures map through the canonical format table and refuse unsupported formats; materials resolve texture ids through the same cache; refcounted release destroys only the last owner, and a failed material upload destroys everything it acquired | `packages/runtime/test/engine/assetBridge.test.ts` with a fake device/library | CI Node 20 | PENDING — first M0 run |

Targets above are derived from the existing SPEC budgets (host frame p95 14 ms, hard fail 20 ms; draw calls 120; texture 128 MB; host 5 MB gz; controller 60 KB gz). They are acceptance thresholds, not measurements. `docs/RESULTS.md` remains the only place where a number becomes evidence.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | math identities, entity handles, save-header bounds, action-map resolution, error codes | `packages/engine/core/test/*.test.ts`, `packages/engine/input/test/*.test.ts` |
| Property (`fast-check`) | Vec/Mat/Quat identities, transform composition, AABB/ray invariants, header round-trip, cell-key canonicalization | `packages/engine/core/test/math.property.test.ts`, `.../saveHeader.property.test.ts` |
| Golden wire/data | save header bytes (`PPSV` fixture), replay hash, input trace → action states | `packages/engine/core/test/golden/`, `packages/engine/input/test/fixtures/` |
| Renderer conformance | One suite run against both backends: capability report, resize, pipeline create/destroy, draw counts, context loss, dispose idempotence | `packages/engine/core/test/contract/renderDevice.conformance.test.ts` (fake device in CI) |
| Integration | Runtime boot, backend selection matrix (WebGPU ok; WebGPU fails → WebGL2; all fail → notice; 3D + Canvas2D → refusal), both games, dev server on `127.0.0.1:0` | `packages/runtime/test/integration/engineBoot.test.ts`, `rendererFallback.test.ts` |
| Boundary | package.json dependency graph and forbidden imports | `packages/engine/core/test/boundaries.test.ts` |
| Benchmark | M0 scene p50/p95, draw calls, texture MB, allocation growth | `experiments/e-m0-engine/?bench=1` |
| Manual | TV tiers, real GPU adapter matrix, WebGPU availability; recorded in `docs/RESULTS.md` | SPEC §12 devices |

Test rules:

- Every test title carries its `ER-*` (or existing `FR-*`/`PR-*`) ID; a tag must resolve to a traceability row.
- Integration tests bind `127.0.0.1:0`, wait on messages and never use fixed sleeps; the dev server and broker are never mocked.
- Real GPU work is exercised in the browser page, not in Node. CI runs the contract suite with a fake device and the pure logic in Node; the browser page reports `window.__M0_BENCH__` for automation.
- No test is skipped or weakened to land a wave. A backend that cannot run in CI is covered by the page and a recorded manual result, not by deleting the test.
- Migration adds before/after golden frames for both games in the same change as the file move.
- Performance tests report p50, p95, max, frame count, adapter, browser version and build hash. A number without those fields is not evidence.

---

## 9. Dependencies

**Spec dependency order**

| Milestone | Specs that must exist and be implemented | Adds |
|---|---|---|
| M0 | 00, 01, 02, 03, 04, 05, 06, 07 (2D migration only), 09 (existing bus only), 10, 15 (header codec only), 16, 18, 19 | Loop/time, math, scene skeleton, both renderers, assets, 2D physics migration, audio migration, input, save-header codec, tooling, SDK evolution, benchmarks |
| M1 | + 07 (2D → 3D physics), 08, 09, 12, 13, 15 | Vehicles/character, animation, audio buses, streaming, 3D UI, saves |
| M2 | + 11, 14, 17 | AI/navigation, online sync, editor |
| M3 | content and world proof | Vice City-scale slice, measured |

**Package prerequisites**

- 00 depends on nothing.
- 01/02/03 depend on 00 only.
- 04/05/06/10 depend on 00 + their own spec; 05 implements the contract authored by 04 but imports only `engine-core`.
- 07 depends on 02/03; 08 on 03/06; 09 on 01; 11 on 03/07; 12 on 03/06; 13 on 06 and the render contract (never a backend package); 15 on 03/07.
- `packages/runtime` integration depends on 01–06 and 10 being green; it is the last step of each wave.

**External dependencies**

- Zero third-party runtime dependencies in `engine-core` and in every browser-bound engine package at M0. This is a hard rule (G7): every dependency must justify its gzip and frame-time cost.
- `engine-tooling` may use dev-only packages (glTF converter, KTX2 encoder, audio transcoder) because it never enters a browser bundle. The tooling lockfile is still audited.
- The existing `protocol`, `broker`, `dev-server`, `controller` and `sdk` dependencies do not change. `sdk` stays at zero.

**Paper-trail prerequisites**

- Amendment **A14** (browser-native engine reframe, WebGPU-first, no Three.js) recorded in `docs/todos/README.md` before M0 WebGPU code merges.
- `docs/todos/IMPLEMENTATION-ORDER.md`, `TRACEABILITY.md` and `RESULTS.md` updated in the same wave that changes status.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | `SPEC.md` contradicts the engine decision (WebGPU non-goal, Three.js candidate) | Certain until amended | M0 work is unauthorised by the repo's own rules | Record A14 first; this spec treats the programme README as the newer decision |
| R2 | WebGPU drivers are immature on Windows/TV: crashes, validation errors, device loss | Medium | M0 demo unstable, lost time | One backend-agnostic contract; WebGL2 fallback remains fully supported; device-loss recovery; conformance suite; pin the Chrome version used for evidence |
| R3 | TV browsers have no WebGPU and weak WebGL2 | High | The TV claim fails | Treat WebGL2 as a first-class TV backend; dynamic resolution; CPU culling; TV measurements gate any quality promise; TV rows stay PENDING until run |
| R4 | The two renderers drift and games behave differently | High if unmanaged | Visual/feature inconsistency | Single `RenderDevice` contract, one conformance suite, golden frames, feature flags, no game branches on backend |
| R5 | Engine code inflates the host bundle past 5 MB gz | Medium | Gate failure, slow TV boot | No runtime deps, code-splitting per subsystem, size report per wave, no Three.js |
| R6 | Scope explodes toward Vice City before M1 | High | Nothing ships | Hard M0 boundary (§5.14); milestone gates; deferred list is normative |
| R7 | Migration breaks the existing games or controller | Medium | Non-green tree, lost trust | Compatibility facade, golden games, serial integration waves, one writer per file |
| R8 | Engine types leak into `sdk`, blowing the 166-byte controller headroom | Medium | Controller budget breach | `sdk` stays zero-dependency; engine runtime packages never import `sdk`; size gate on every wave |
| R9 | Per-frame allocations creep in | High over time | Frame spikes, GC pauses on TV | Allocation benchmark, hot-path review, pooled scratch, no `map/filter` in sim |
| R10 | Cross-browser determinism is assumed and then fails | Medium | Replay/netcode bugs | Scope limit stated in §5.8; replay hash per build/browser; lockstep deferred |
| R11 | Workers or `SharedArrayBuffer` unavailable | Medium on TV | Decode stalls the main thread | No SAB requirement; main-thread fallback with time slicing; 8 ms long-task gate |
| R12 | Context loss loses GPU state | Medium | Frozen or black screen | CPU descriptors survive; one automatic restore; fallback tier; notice |
| R13 | glTF/KTX2 toolchain complexity delays M0 | Medium | Asset pipeline slips | M0 accepts uncompressed GLB; compression is M1 and tooling-only |
| R14 | Contracts are frozen before the design is proven | Medium | Expensive rework | Pre-release names may change *before* first release; freeze after M0; version policy and migration notes |
| R15 | TV memory ceiling is lower than provisional budgets | High until E2 | Crashes on streamed worlds | Budgets stay provisional (128 MB); measurement at E2; eviction and texture tiers |
| R16 | Package scope rename (`@lanpad` → `@pocketpad`) churns every import | Low (deferred) | Busywork | Deferred to P4; product name is already PocketPad |
| R17 | Docs drift from code and agents implement stale contracts | High without discipline | Parallel work diverges | One owner per spec; traceability IDs; spec is the interface; update docs in the same change |
| R18 | Two agents touch the same file during a parallel wave | Medium | Corrupted work | Explicit ownership table (§6), one writer per file, serial integration at wave boundaries |

**Fallback if WebGPU is unavailable or immature on a target:** the target runs Tier B (WebGL2) with reduced quality, declaring required features so the game is refused early rather than failing mid-session. If WebGL2 is also unusable, 2D games run on Canvas2D and 3D games are refused with a clear notice. The engine never silently runs a 3D game on Canvas2D, and never ships a game that only works on one backend unless its manifest says so.





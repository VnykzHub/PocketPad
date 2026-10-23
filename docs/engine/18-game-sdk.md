# 18 — Game SDK

**Status:** authoritative for the game-facing SDK: lifecycle, `GameContext` evolution, packaging, templates, API reference, versioning, and the rules parallel game teams follow. The current SDK exists in `sdk/src/`; the additive members, compatibility gate, template and generated reference in this spec are **targets**, not implemented.
**Milestone:** M0 for the additive contract and packaging; M4/P4 for the public SDK release and third-party distribution.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product contract, [`00-architecture.md`](00-architecture.md) §3.6 and §5.15 for contract and version policy, [`docs/ENGINE.md`](../ENGINE.md) for the current runtime. Where this spec and the current code disagree, the code is evidence of today and this spec is the target; an amendment resolves the difference.

---

## 1. Goal

A game is a folder with a manifest, one entry module, layouts and assets. The host discovers it, validates it, gives it a single `GameContext`, and drives one frozen lifecycle. The same folder runs on WebGPU and WebGL2, with phones, keyboard/mouse and gamepad, without the game importing the engine, the protocol, the broker or the DOM.

The player-visible outcome:

- a new game appears in the launcher without editing a switch statement or a host route;
- it starts from the same seed and input trace with the same result on both backends;
- a bad manifest, a missing entry or a throwing `init` shows a readable error and returns to the launcher instead of wedging the room;
- an SDK update does not force a rebuild of an existing game;
- two game teams can add games in the same wave without touching each other's files.

The engineering outcome:

- one lifecycle, one context, one manifest schema, one packaging contract;
- a zero-dependency SDK that stays a leaf of the dependency graph;
- additive evolution of `GameContext` with a compile-time proof that engine types satisfy the SDK projection;
- one generated API reference and one compatibility policy;
- a template and a test project per game so parallel work is safe by construction.

## 2. Non-goals

- **Not engine internals.** `GameContext` is a projection. `Scene`, `AssetLibrary`, `WorldStreamer`, `GameUi`, `AnimationApi`, `RendererCapabilities` and the renderer are owned by specs 03, 06, 12, 13, 08 and 04. This spec fixes only their game-facing structural shape.
- **Not the protocol.** No packet, socket, frame, token, room or slot-reservation type appears in the SDK (`FR-7.17`). Games receive `GameEvent` values and `GameInputSnapshot` only.
- **Not a gameplay framework.** No ECS helpers, state machines, scene-graph convenience layer, tween library, UI framework or asset importer ships in the SDK at M0. Games may build those on top of the engine contracts.
- **Not a scripting runtime.** Games are ES modules. No eval, no `new Function`, no code loaded from an asset.
- **Not a registry service.** Third-party publishing, signing, discovery and billing are P4. M0-M3 support bundled games and a folder served from the same origin.
- **Not backward compatibility across SDK majors.** SDK 1.x runs on higher engine minors with the same major. SDK 2.0 may remove members; migration notes are mandatory.
- **Not a new controller control type.** The 11 control types, layout schema and 16 KB layout limit are frozen by `SPEC.md`.
- **Not online multiplayer.** Online relay and state sync are spec 14. `serverNow()` stays the only clock hint.
- **Not the editor.** Scene/world authoring is spec 17; play-in-editor reuses this lifecycle unchanged.
- **Not hot reload in production.** Dev may reload a game page. A running game is never patched in place.
- **Not DOM or network access for games.** A game gets no `window`, `document`, `fetch`, `WebSocket`, `localStorage` or timer API through the context. It may use standard JavaScript, but boundary tests reject imports that assume a browser host beyond what the runtime provides.

## 3. Public interfaces

The SDK is the only package a game compiles against. It is private and zero-dependency today (`sdk/package.json`, `dependencies: {}`) and stays that way. Implementations in this section are targets; only the frozen members in §3.3 exist today.

### 3.1 Version constants

A new file `sdk/src/version.ts`, exported from `sdk/src/index.ts`:

```ts
/** The SDK contract this build implements. Independent of ENGINE_VERSION. */
export const SDK_VERSION = "1.0.0" as const;
export const SDK_VERSION_MAJOR = 1 as const;
export const SDK_VERSION_MINOR = 0 as const;
export const SDK_VERSION_PATCH = 0 as const;

/** Lowest engine version that can host SDK 1.0.0. */
export const SDK_MIN_ENGINE_VERSION = "0.1.0" as const;

/** GameContext API generation. Bumped only for a semantic context change. */
export const SDK_CONTEXT_API = 1 as const;
```

Rules:

- Optional member additions bump the SDK **minor**.
- A removal, rename, or semantic change to an existing member requires SDK **major** plus an amendment in `docs/todos/README.md`.
- Bug fixes that do not change the contract bump the **patch**.
- `ENGINE_VERSION` is independent (00 §5.15). The engine declares `minEngineVersion` in the manifest; the SDK does not track engine milestones.

### 3.2 Compatibility gate

The host checks compatibility **before** importing the game entry, so an incompatible game cannot execute code:

```ts
export interface SdkHostInfo {
  readonly sdkVersion: string;
  readonly engineVersion: string;
}

export type SdkCompatibilityCode =
  | "ok"
  | "E_SDK_INVALID"
  | "E_SDK_MAJOR"
  | "E_SDK_MINOR"
  | "E_SDK_ENGINE";

export interface SdkCompatibility {
  readonly ok: boolean;
  readonly code: SdkCompatibilityCode;
  readonly message: string;
}

export function checkSdkCompatibility(
  manifest: Pick<GameManifest, "sdkVersion" | "minEngineVersion">,
  host: SdkHostInfo,
): SdkCompatibility;
```

Semantics:

| Condition | Result |
|---|---|
| `manifest.sdkVersion` absent | Treated as `1.0.0` |
| `manifest.minEngineVersion` absent | Treated as `0.1.0` |
| Either value is not strict `x.y.z` | `E_SDK_INVALID` |
| `gameSdk.major !== hostSdk.major` | `E_SDK_MAJOR` |
| `gameSdk.major === hostSdk.major` and `gameSdk.minor > hostSdk.minor` | `E_SDK_MINOR` |
| `host.engineVersion < manifest.minEngineVersion` | `E_SDK_ENGINE` |
| Otherwise | `ok` |

Patch differences never refuse. A game built against SDK 1.0 runs on a host SDK 1.3; a game built against 1.3 refuses on a 1.0 host because it may call members added in 1.3. Refusal is a launcher notice, not a mid-game failure.

### 3.3 Lifecycle (frozen)

The lifecycle is already implemented by `packages/runtime/src/game/GameHost.ts` and is frozen:

```
idle → start(): init(ctx) → playing ⇄ paused → dispose() → disposed
                   └─ init/simulate/render throws → failed (loop stopped)
```

```ts
export type GamePhase =
  | "idle"
  | "starting"
  | "playing"
  | "paused"
  | "failed"
  | "disposed";

export interface Game {
  readonly manifest: GameManifest;
  /** Called exactly once after the context is assembled. May be async. */
  init(ctx: GameContext): void | Promise<void>;
  /** One fixed 1/60 s step. No per-tick allocation. */
  simulate(dt: number, input: GameInputSnapshot): void;
  /** One display frame; alpha in [0, 1) interpolates simulation state. */
  render(alpha: number): void;
  /** Delivered before simulate() of the same tick, when present. */
  onEvent?(slot: number, name: string, data: JsonValue): void;
  /** Called exactly once on unload, pause-independent. Idempotent host-side. */
  dispose(): void;
}

export interface GameModule {
  default: (manifest: GameManifest) => Game;
}
```

Frozen order per simulation tick (must not change):

1. integrate tilt into input;
2. `input.update(snapshot)` (host polls the mapper once);
3. drain queued controller events;
4. call `game.onEvent(slot, name, data)` for each event;
5. call `game.simulate(dt, snapshot)`.

`render(alpha)` runs once per display frame, during `playing` **and** `paused`; `simulate` runs only while `playing`. `dispose()` stops the loop, then calls `game.dispose()` once; a throwing `dispose` is logged and does not block host teardown. No method is called after `dispose`, and no method is called before `init` resolves.

The host adds two guards that are **targets**, not present today:

| Guard | Value | Failure |
|---|---|---|
| Manifest fetch | 10,000 ms | `E_GAME_TIMEOUT`, phase `manifest` |
| Entry import | 10,000 ms | `E_GAME_TIMEOUT`, phase `entry` |
| `init()` | 10,000 ms | `E_GAME_TIMEOUT`, phase `init` |
| `dispose()` | 2,000 ms best-effort | logged, teardown continues |

Values are target contracts, testable with fake timers; they are not measurements. A game that needs a longer load must stream assets after `init`, not block it.

### 3.4 GameContext (frozen members plus optional additions)

Frozen today (`sdk/src/game-api.ts`):

```ts
export interface GameContext {
  readonly manifest: GameManifest;
  readonly input: GameInputReader;
  readonly renderer: GameRenderer3D;
  readonly audio: GameAudio;
  readonly rng: GameRng;
  readonly debug: GameDebug;
  readonly panels: GamePanels;
  readonly layouts: GameLayouts;
  readonly haptics: GameHaptics;
  readonly events: GameEvents;
  serverNow(): number | null;
}
```

Additive members, in the order they land:

| Member | Status | Owner | Availability rule |
|---|---|---|---|
| `assets?: AssetLibrary` | Additive, M0 | 06 | `undefined` until the asset pipeline is installed |
| `scene?: Scene` | Additive, M0/M1 | 03 | `undefined` on Canvas2D-only games and before the engine scene exists |
| `renderer.capabilities?: RendererCapabilities` | Additive, M0 | 04 | `undefined` means assume the lowest supported tier |
| `renderer.backend` union gains `"webgpu"` | Additive, M0 | 04 | Diagnostics only; never branch on it for correctness |
| `debug.draw?: DebugDraw` | Additive, M0 | 16 | `undefined` when the profiler is stripped from production |
| `animation?: AnimationApi` | Additive, M1 | 08 | `undefined` before the animation package is installed |
| `streaming?: WorldStreamer` | Additive, M2 | 12 | `undefined` for non-streaming games |
| `world?: GameWorld3D` | Additive, Wave 0 | 22 | `undefined` on 2D-only hosts; models, instances, clips, scene, camera |
| `ui?: GameUi` | Additive, M2 | 13 | `undefined` when the game uses only `renderer` |
| `actions?: ActionReader` | Reserved | 10 | Not part of SDK 1.0 until spec 10 lands; do not depend on it |
| `save?: SaveApi` | Reserved | 15 | Not part of SDK 1.0 until spec 15 lands; do not depend on it |

Two availability rules, enforced by tests:

1. **Frozen members are always present.** If the host cannot provide one, calling it throws `CapabilityUnavailableError` with a readable message, as `panels`, `layouts` and `haptics` do today. A frozen member is never silently a no-op.
2. **Additive members are absent when unavailable.** `ctx.assets === undefined` is the feature test. Games must use `if (ctx.scene)` and provide a fallback; they must not assume a milestone.

The SDK **restates** the engine structures structurally rather than importing engine packages. Fields are owned by the referenced spec; the SDK shape is the projection a game sees. The engine must satisfy it at compile time (see ER-18-02).

```ts
export interface GameRendererBase {
  readonly backend: "webgpu" | "webgl2" | "canvas2d";
  readonly capabilities?: RendererCapabilities;
  beginFrame(alpha: number): void;
  endFrame(): void;
  readonly drawCalls: number;
  readonly textureMemoryMB: number;
}

export interface RendererCapabilities {
  readonly backend: "webgpu" | "webgl2" | "canvas2d";
  readonly features: ReadonlySet<EngineFeature>;
  readonly quality: "off" | "low" | "medium" | "high";
  readonly maxTextureSize: number;
  readonly maxTextureLayers: number;
  readonly maxBindGroups: number;
  readonly maxUniformBufferBytes: number;
  readonly maxSamples: 1 | 4;
  readonly anisotropy: number;
  readonly directionalLights: number;
  readonly pointLights: number;
  readonly shadowCascades: 0 | 2 | 3;
  readonly supportsPost: boolean;
  readonly supportsTimestamps: boolean;
}

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
```

`AssetLibrary`, `AssetHandle`, `Scene`, `WorldStreamer`, `GameUi`, `AnimationApi`, `ActionReader` and `SaveApi` follow the same rule: the SDK declares the minimal structural surface, the owning spec is authoritative for fields and semantics. The minimum shapes the SDK fixes at M0 are:

```ts
export type AssetKind =
  | "mesh" | "texture" | "material" | "audio"
  | "font" | "json" | "scene" | "animation";
export type AssetState = "queued" | "loading" | "ready" | "failed" | "disposed";

export interface AssetFailure {
  readonly id: string;
  readonly code: string;          // engine AssetErrorCode, widened for the SDK
  readonly message: string;
  readonly retryable: boolean;
}
export interface AssetProgress {
  readonly fetched: number;
  readonly declared: number;
  readonly determinate: boolean;
  readonly state: "idle" | "loading" | "ready" | "failed";
  readonly loadedCount: number;
  readonly totalCount: number;
  readonly currentId: string | null;
}
export interface AssetHandle<T = unknown> {
  readonly id: string;
  readonly kind: AssetKind;
  readonly state: AssetState;
  readonly value: T;              // valid only when state === "ready"
  retain(): AssetHandle<T>;
  release(): void;
  readonly failed: AssetFailure | null;
}

export interface AssetLibrary {
  load<T = unknown>(id: string): Promise<AssetHandle<T>>;
  get<T = unknown>(id: string): AssetHandle<T> | undefined;
  readonly loadedBytes: number;
  readonly budgetBytes: number;
  readonly progress: AssetProgress;
  dispose(): void;
}
```

The SDK projection is a **structural subset** of spec 06's `AssetLibrary`: every member and value is assignable from the engine type, so the runtime can pass an engine library directly. `AssetFailure.code` is widened to `string` because games must not depend on the engine's internal code union.

`Scene` at M0 is limited to what an engine-rendered game needs to create, find and destroy entities. The SDK shape is `createEntity`, `destroyEntity`, `isAlive`, `add`, `get`, `remove`, `query`, `dispose` and the `Entity`/`Transform` value types; spec 03 owns the storage layout, query semantics and limits.

When `ctx.scene` is present, the host renders the engine scene **before** `game.render(alpha)`. `game.render` then draws the game's own 2D HUD, debug overlays and screen-space effects through `ctx.renderer`, or nothing. The two paths are not mixed per object: an entity is engine-rendered or game-rendered, never both.

### 3.5 Manifest (v1 plus additive fields)

`GameManifest` keeps every current field and adds optional fields. `schemaVersion` stays `1`; adding an optional field does not bump it, per 00 §5.15.

```ts
export interface GameManifest {
  // Frozen v1
  schemaVersion?: 1;
  name: string;
  description?: string;
  entry: string;
  layouts: string[];
  assetBudget: { initialBytes: number; totalBytes: number };
  minPlayers: number;
  maxPlayers: number;
  needsGyro: boolean;
  chunkConfig?: {
    chunkSize: number;
    loadRadius: number;
    unloadRadius: number;
    lodTiers: number[];
  };

  // Additive, validated from SDK 1.0
  version?: string;             // game content version, e.g. "1.2.0"; used by saves; 1..32 bytes
  sdkVersion?: string;          // strict x.y.z, default "1.0.0"
  minEngineVersion?: string;    // strict x.y.z, default "0.1.0"
  requiredFeatures?: EngineFeature[]; // max 9, unique
  assetManifest?: string;       // relative path; default "asset-manifest.json" if present
  scene?: string;               // relative path to a .scene.json default scene
  world?: string;               // relative path to a world.json (streaming)
}
```

Validation rules, added to `sdk/src/manifest.ts` and mirrored in `sdk/schema/game-manifest.schema.json`:

- `sdkVersion` and `minEngineVersion` are strict `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`, at most 32 characters.
- `version` is optional, 1..32 UTF-8 bytes, no NUL. It is the game's content version recorded in saves; when absent, the save layer requires the game to supply `gameVersion` explicitly.
- `requiredFeatures` is an array of at most 9 unique strings from the `EngineFeature` union. An unknown name is a manifest error; silently ignoring a required feature is not allowed.
- `assetManifest`, `scene` and `world` use the same relative-path rules as `entry`: no absolute path, no drive letter, no `..` segment. Resolution must stay inside the game folder.
- `scene` is only meaningful with `ctx.scene`; a game that declares it on a host without the engine scene fails with `E_UNSUPPORTED_FEATURE` before `init`, not by rendering nothing.
- `world` requires `chunkConfig` and streaming support; declaring it without streaming is `E_UNSUPPORTED_FEATURE`.
- Unknown top-level properties are preserved. A future field is readable by a newer host and ignored by an older one; the older host must not reject it.
- A manifest document is at most **64 KiB**. This is a target limit; it is checked before parsing into the typed object. The manifest is fetched over HTTP, not sent through the 4 KB protocol frame limit.

### 3.6 Failure contract

The existing loader codes stay (`fetch`, `invalidManifest`, `badEntry`, `import`, `badModule`, `factory`, `budget`). The SDK adds a superset used by the host:

```ts
export type GameFailureCode =
  | "fetch"
  | "invalidManifest"
  | "badEntry"
  | "import"
  | "badModule"
  | "factory"
  | "budget"
  | "sdkMajor"
  | "sdkMinor"
  | "engineVersion"
  | "feature"
  | "init"
  | "runtime"
  | "timeout"
  | "dispose";

export type GameFailurePhase =
  | "manifest"
  | "entry"
  | "factory"
  | "init"
  | "runtime"
  | "dispose";

export interface GameFailure {
  readonly code: GameFailureCode;
  readonly phase: GameFailurePhase;
  readonly message: string;
  readonly details: readonly string[];
  readonly recoverable: boolean;
}
```

| Code | Phase | Cause | Recoverable |
|---|---|---|---|
| `fetch` | manifest | Network or HTTP failure | yes, retry |
| `invalidManifest` | manifest | Validator errors | no, author fix |
| `badEntry` | entry | Absolute, `..`, cross-origin or empty path | no |
| `import` | entry | Module fetch/evaluation threw | yes, relaunch |
| `badModule` | entry | No default factory, or factory did not return a `Game` | no |
| `factory` | factory | Factory threw | no |
| `sdkMajor` / `sdkMinor` / `engineVersion` | manifest | Compatibility gate refused | no, different build |
| `feature` | manifest | `requiredFeatures` missing, or `scene`/`world` unsupported | no on this host |
| `init` | init | `game.init` threw | yes, relaunch |
| `runtime` | runtime | `simulate`, `onEvent` or `render` threw | yes, host returns to launcher |
| `timeout` | manifest/entry/init | Guard expired | yes, retry |
| `dispose` | dispose | `game.dispose` threw | logged; teardown continues |

`GameFailure` never contains a room token, a session token, a controller PIN, a player name or raw input bytes. `details` may contain manifest field paths and HTTP status codes. The visible launcher message is a short sentence; the technical detail goes to the debug overlay.

### 3.7 Packaging contract

A bundled game is a folder:

```text
packages/games/<slug>/
  game.manifest.json
  src/game.ts                 # entry, default-exports (manifest) => Game
  layouts/<name>.json         # 1..16 files, each <= 16 KiB
  asset-manifest.json         # optional until M0 assets land
  assets/...                  # referenced by the asset manifest
  scenes/<name>.scene.json    # optional, engine-rendered games
  world.json                  # optional, streaming games
  test/game.test.ts           # at least one test that calls simulate
  tsconfig.json               # required by typecheck:games
```

Rules:

- No `package.json` is required in a game folder. Bundled games are discovered by Vite glob, validated eagerly, and served over HTTP from `/games/<slug>/`. The host fetches the manifest again through `loadGame`, because the network copy is untrusted even when the bundled copy is trusted.
- `slug` matches `^[a-z0-9][a-z0-9-]*$` and equals the folder name. It is the URL segment and the game id in captures and replay fixtures.
- `entry` resolves to an ES module. It may import `@lanpad/sdk` and relative files only. It must not import `@lanpad/protocol`, `@lanpad/broker`, `@lanpad/engine-*`, a Node built-in, or another game's folder.
- Asset and layout URLs are same-origin and contained by the game folder. `loadGame` enforces this for `entry`; the asset and layout loaders enforce it for their paths.
- A third-party package (P4) is the same folder shape, optionally built by any bundler into one ESM entry plus assets. It must run under the host CSP without `eval` or inline scripts. The host does not execute a build tool for a third-party game.
- A game folder is at most **5 MB gzip total** including the host's game-side code, per the host + game budget in `CLAUDE.md`. The manifest declares `assetBudget` for downloaded assets; the total package budget is enforced by `tools/size-budget`.
- A new bundled game needs three registrations, all mechanical: the folder itself (Vite glob picks it up), its `tsconfig.json` path in the root `typecheck:games` script, and a Vitest project entry in the root `vitest.config.ts`. A game without the last two compiles nowhere and tests nowhere; the template and `tools/create-game` write all three or fail.

The resolved package view the runtime passes to the host (not part of `@lanpad/sdk`):

```ts
export interface GamePackage {
  readonly slug: string;
  readonly baseUrl: string;
  readonly manifestUrl: string;
  readonly manifest: GameManifest;
  readonly entryUrl: string;
  readonly layoutUrls: readonly string[];
  readonly assetManifestUrl: string | null;
  readonly sceneUrl: string | null;
  readonly worldUrl: string | null;
}
```

### 3.8 Template and scaffold

`templates/game/` is the canonical game skeleton:

```text
templates/game/
  game.manifest.json
  src/game.ts
  layouts/keyboard.json
  layouts/phone.json
  test/game.test.ts
  tsconfig.json
  README.md
```

The template game must be playable, not a placeholder: one entity moves with input on both backends, one layout works on a phone, one test asserts that 600 fixed ticks with a recorded input produce a stable state hash. It is excluded from discovery because it lives outside `packages/games/`.

`tools/create-game/` copies the template:

```bash
node tools/create-game/dist/cli.js harbor-run --name "Harbor Run"
```

It creates `packages/games/harbor-run/`, substitutes the slug and display name, adds the `typecheck:games` path, adds the Vitest project entry, and runs the new game's typecheck and test. It refuses to overwrite an existing folder. If it cannot edit a root config safely, it prints the two exact edits and exits non-zero rather than leaving a half-registered game.

### 3.9 API reference

`docs/api/sdk-1.0.md` is generated from `sdk/src/**` by `tools/sdk-docs/`, using the TypeScript compiler API already in devDependencies. No new documentation dependency is introduced.

The reference contains, in this order:

1. version and compatibility gate;
2. lifecycle and tick order;
3. the `GameContext` table with frozen/additive status and owning spec;
4. every exported type, function and constant, sorted by name;
5. packaging, manifest and limits;
6. deprecations and migration notes.

Generation is deterministic: same source gives byte-identical output. Every exported symbol needs a doc comment; the tool fails on an undocumented export. The output must not contain engine-internal type names that a game cannot import (`RenderDevice`, `WorldCell`, `AssetEntry`, `InputSnapshot`). CI regenerates and diffs.

## 4. Data formats

### 4.1 Manifest example

```json
{
  "schemaVersion": 1,
  "name": "Harbor Run",
  "description": "Deliver the crate before the tide.",
  "entry": "src/game.js",
  "layouts": ["layouts/drive.json", "layouts/on-foot.json"],
  "assetBudget": { "initialBytes": 1048576, "totalBytes": 5242880 },
  "minPlayers": 1,
  "maxPlayers": 4,
  "needsGyro": false,
  "sdkVersion": "1.0.0",
  "minEngineVersion": "0.1.0",
  "requiredFeatures": ["texture-array", "msaa4"],
  "assetManifest": "asset-manifest.json",
  "scene": "scenes/main.scene.json",
  "world": "world.json"
}
```

### 4.2 Compatibility data

`sdk/compat.json` is a small, checked-in description of the contract, consumed by docs and the compatibility test, never by the game at runtime:

```json
{
  "formatVersion": 1,
  "sdkVersion": "1.0.0",
  "minEngineVersion": "0.1.0",
  "contextApi": 1,
  "members": [
    { "path": "manifest", "status": "frozen", "since": "1.0.0", "owner": "sdk" },
    { "path": "assets", "status": "optional", "since": "1.0.0", "owner": "06" },
    { "path": "scene", "status": "optional", "since": "1.0.0", "owner": "03" },
    { "path": "renderer.capabilities", "status": "optional", "since": "1.0.0", "owner": "04" },
    { "path": "debug.draw", "status": "optional", "since": "1.0.0", "owner": "16" },
    { "path": "animation", "status": "optional", "since": "1.1.0", "owner": "08" },
    { "path": "world", "status": "optional", "since": "1.2.0", "owner": "12" },
    { "path": "ui", "status": "optional", "since": "1.2.0", "owner": "13" }
  ]
}
```

The `since` values for M1/M2 members are the planned SDK minor at which they land; the owning spec updates the row in the same change that adds the member. A test parses `sdk/src/game-api.ts` with the TypeScript compiler API and fails if `compat.json` and the interface disagree on member name, optionality or order.

### 4.3 Version and compatibility matrix

| Game built against | Host SDK | Host engine | Result |
|---|---|---|---|
| SDK 1.0 | 1.0 | 0.1.0 | runs |
| SDK 1.0 | 1.3 | 0.3.0 | runs |
| SDK 1.3 | 1.0 | 0.3.0 | `E_SDK_MINOR` |
| SDK 1.0 | 2.0 | 1.0.0 | `E_SDK_MAJOR` |
| SDK 2.0 | 1.9 | 0.4.0 | `E_SDK_MAJOR` |
| SDK 1.0, `minEngineVersion: 0.4.0` | 1.0 | 0.3.0 | `E_SDK_ENGINE` |
| malformed `sdkVersion` | any | any | `E_SDK_INVALID` / `invalidManifest` |

The matrix is a fixture, not documentation. `sdk/test/compat.test.ts` runs every row.

### 4.4 Limits

| Item | Limit | Enforced by |
|---|---|---|
| Manifest document | 64 KiB | loader before JSON parse |
| Layouts per game | 1..16 | manifest validator |
| Layout document | 16 KiB, 24 controls, unique ids/bits/channels | SDK layout validator |
| Manifest `name` | 1..64 code points | manifest validator |
| Manifest `description` | <= 140 code points, display only | manifest validator |
| `requiredFeatures` | <= 9, unique, known names | manifest validator |
| Game folder | 5 MB gzip including game-side code and assets | size budget |
| Asset download | `assetBudget.initialBytes` / `totalBytes` | asset loader |
| Package entry | one ESM module graph, same origin | loader |
| Game id (`slug`) | `^[a-z0-9][a-z0-9-]*$`, folder name | registry |

### 4.5 Generated reference

`docs/api/sdk-1.0.md` starts with:

```markdown
# PocketPad SDK 1.0.0

Generated from sdk/src at <SDK_VERSION>. Do not edit by hand.
Engine compatibility: >= 0.1.0, SDK major 1.
```

A changed contract updates `SDK_VERSION`, `sdk/compat.json` and the generated document in the same commit. A stale generated document fails CI.

## 5. Architecture

### 5.1 Module map

```text
sdk/src/
  index.ts          public re-exports
  game-api.ts       Game, GameContext, input, renderer projection, all game types
  manifest.ts       GameManifest and validateManifest
  version.ts        SDK_VERSION, compatibility constants and check
  layout.ts         layout schema (frozen)
  layout-validate.ts
  panel.ts
  ugc.ts
  config.ts
  compat.ts         SDK_MEMBERS table used by tools (optional at runtime)

packages/runtime/src/game/
  GameHost.ts       lifecycle, phase, tick order, dispose
  GameContext.ts    context assembly and capability stubs
  loadGame.ts       manifest fetch, validation, entry containment, factory
  registry.ts       bundled manifest discovery and launcher view
```

The SDK stays at the bottom of the graph: it imports nothing from `packages/`, and the controller imports the SDK directly. The runtime may import the SDK; the SDK never imports the runtime.

### 5.2 Load sequence

```text
launcher selects /games/<slug>/
  → fetch manifest (10 s guard)
  → byte-limit check (64 KiB)
  → validateManifest
  → checkSdkCompatibility
  → check requiredFeatures against RendererCapabilities
  → resolve entry inside the game folder
  → dynamic import entry (10 s guard)
  → check GameModule.default
  → create context (frozen members + available optional members)
  → game = factory(manifest)
  → check Game shape
  → await game.init(ctx) (10 s guard)
  → phase = playing
```

Every failure maps to a `GameFailure`, stops before the next step, and shows the launcher notice. A failure after `init` starts (`runtime`) stops the loop and returns to the launcher; it never leaves a half-playing game.

The context is assembled before the factory because the factory signature is frozen as `(manifest) => Game`. The factory must not need the context; it receives it in `init`. A factory that does heavy work is a bug: it blocks the main thread before the first frame. The template's factory only captures the manifest.

### 5.3 Context assembly and capability policy

`createGameContext` freezes the context object. Frozen members are always keys. Optional members are present only when the corresponding adapter exists.

- Renderer: the host chooses the best backend (WebGPU → WebGL2 → Canvas2D for 2D games). The game sees `renderer.backend` for diagnostics and `renderer.capabilities` for decisions. A 3D game on Canvas2D is refused at launch with `E_UNSUPPORTED_FEATURE`, not silently drawn as 2D.
- Assets: installed at M0 when the asset pipeline exists. Until then `ctx.assets` is `undefined`, and a game that needs it fails at launch if it declares `assetManifest`.
- Scene: installed when the engine scene renderer is active. `ctx.scene` is `undefined` for Canvas2D games and for hosts with `--no-engine-scene` (test/profile mode).
- World/UI/animation: same pattern, per their owning specs.
- Debug: `ctx.debug` is always present. `debug.draw` is present only when the profiler is enabled or the build includes it. Production may strip `debug.draw`; a game must not require it for correctness.
- Panels/layouts/haptics: present with throwing stubs until the controller transport is ready, matching today's behaviour.

`ctx.renderer.capabilities` is a snapshot taken after device creation and quality selection. It does not change during a session; a device loss rebuilds the context or fails the game with `runtime`.

### 5.4 Engine-rendered scene vs game-rendered content

Two rendering paths exist during the migration:

1. **Engine scene path.** `ctx.scene` is present. The host simulates and renders the scene, including culling, lighting and post. `game.render(alpha)` draws only screen-space content. Gameplay reads and writes entity transforms through `ctx.scene`.
2. **Game renderer path.** `ctx.scene` is absent. The game draws through `ctx.renderer` (Canvas2D or the legacy `GameRenderer3D` cube API). This keeps Coin Run and Reaction Duel working unchanged.

A game may use the game renderer for a HUD while using the engine scene for the world. It may not draw the same entity in both. `GameRenderer3D` grows additively; `drawCube` remains for compatibility, and new mesh/scene calls are owned by spec 04 and exposed through `ctx.scene` or an additive renderer method.

### 5.5 Discovery and packaging flow

- Bundled games: `registry.ts` globs `packages/games/*/game.manifest.json`, validates every bundled manifest eagerly, rejects duplicate slugs, and sorts by display name. A broken bundled manifest fails the host build, not a TV at runtime.
- Served games: the dev server serves `/games/<slug>/` from the same folder. The loader fetches the manifest over HTTP and imports the entry with the bundled importer map or native `import()`. Same code path, untrusted network copy.
- Third-party games (P4): a folder under a configured games root, same shape, same validation. No workspace entry, no root typecheck, no build step in the host. The host still enforces origin, containment, CSP, byte limits and compatibility.
- Templates: `templates/game/` is not discovered because it is outside `packages/games/`. `tools/create-game` copies it and performs the registrations.

### 5.6 Parallel game teams

The SDK is the contract that lets game teams work in parallel:

- **Ownership.** Each game owns its folder, its manifest, its layouts, its assets and its tests. No engine agent edits a game; no game agent edits engine or SDK files. A needed SDK change is a request against this spec, landed once by the SDK owner.
- **Contract changes.** An additive member is a minor SDK bump, a new row in `sdk/compat.json`, a generated-reference update, and a compile-time assignability test. A breaking change requires an amendment and a major bump; it is not made mid-wave.
- **Game tests.** Each game has a Vitest project entry. Its tests exercise `simulate` with hand-built `GameInputSnapshot`s, never a live socket. A game may add a browser smoke page under `experiments/`, but the gate test is Node.
- **No shared mutable state.** Games never write to `window`, a module-level singleton shared across games, `localStorage` or the DOM. Two games can be loaded in the same host only in tests; each gets a fresh module graph or a fresh context.
- **Determinism.** All randomness comes from `ctx.rng`. `Math.random`, `Date.now` and `performance.now` are banned in game simulation paths by lint; `render` may use wall time only for visual effects that do not affect simulation. The seed is part of the replay fixture.
- **Assets.** Asset ids are namespaced by the game folder; an id cannot escape to another game's assets. The asset manifest is the only list the loader trusts.
- **Budgets.** Each game owns its `assetBudget` and must fit the host + game 5 MB gzip budget. A game that grows the shared host bundle is a host change and needs the host owner.
- **Review.** A game PR includes its manifest, code, layouts, tests and a measured or explicitly `PENDING` result. A game is not "done" because it compiles.

### 5.7 API reference generation

`tools/sdk-docs/` reads the built `.d.ts` files (not the TypeScript source) so the published shape is what a game actually sees. It walks exported symbols, extracts doc comments, sorts deterministically, and writes `docs/api/sdk-<major>.<minor>.md`. A second mode (`--check`) regenerates into memory and diffs against the checked-in file. It also validates `sdk/compat.json` against the `GameContext` interface.

The tool is dev-only and never shipped to the host or controller. It uses the TypeScript compiler API, `node:fs` and `node:path`; no network.

### 5.8 Hot paths

`GameHost.simulateTick` runs at 60 Hz. The SDK adds no allocation there:

- `input.snapshot`, player states and events are pooled; games copy what they retain.
- `ctx.scene.query` uses caller-provided arrays or pooled results, never `filter`/`map` in the tick.
- `ctx.assets.load` returns a promise created at load time, not per tick; a tick may call `get`.
- `ctx.debug.setCounter` and `ctx.debug.draw` write into preallocated buffers.
- Compatibility and manifest validation run once at load, never in the loop.

### 5.9 Migration and deprecation

- Existing games (Coin Run, Reaction Duel) compile and run unchanged. They use no optional member and do not declare `sdkVersion`; they are treated as 1.0.0.
- A deprecated member stays for one SDK minor with a dev-only warning, then is removed only in a major. The generated reference marks it `deprecated since x.y.z; removed in z.0.0`.
- SDK 0.0.0 (today) to 1.0.0: no game-facing removals. The version becomes 1.0.0 when the M0 additive members land and the reference is generated.
- P4 public release: the package becomes publishable, `private` is removed, and a support policy is added. That is a separate decision, not implied by this spec.

## 6. File ownership

This spec owns only the paths below. Implementation agents must not edit another spec's files; cross-package changes are a request filed against the owning spec.

| Path | Owner | Change |
|---|---|---|
| `docs/engine/18-game-sdk.md` | 18 | this document |
| `sdk/src/game-api.ts` | 18 | additive members and type additions only; frozen members unchanged |
| `sdk/src/manifest.ts` | 18 | additive fields and validation |
| `sdk/src/version.ts` | 18 | new: constants and compatibility gate |
| `sdk/src/index.ts` | 18 | re-export `version.ts` |
| `sdk/schema/game-manifest.schema.json` | 18 | additive field definitions |
| `sdk/compat.json` | 18 | new: contract table |
| `sdk/CHANGELOG.md` | 18 | new: SDK change log |
| `sdk/test/**` | 18 | compat, manifest, lifecycle and boundary tests |
| `tools/sdk-docs/**` | 18 | new: deterministic reference generator |
| `tools/create-game/**` | 18 | new: scaffold and registration |
| `templates/game/**` | 18 | new: canonical playable skeleton |
| `docs/api/sdk-1.0.md` | 18 | generated |
| `packages/runtime/src/game/GameContext.ts` | runtime owner | request: assemble optional members |
| `packages/runtime/src/game/GameHost.ts` | runtime owner | request: timeouts and failure mapping |
| `packages/runtime/src/game/loadGame.ts` | runtime owner | request: consume `version.ts`, byte limit |
| `packages/runtime/src/game/registry.ts` | runtime owner | no change for bundled games; template excluded by path |
| `packages/runtime/src/main.ts` | runtime owner | request: launcher error notice |
| `packages/games/<slug>/**` | game team | each game owns its folder |
| `docs/engine/03,06,08,10,12,13,15` | their owners | SDK projections must match their interfaces |

The root `package.json`, root `vitest.config.ts` and `tsconfig` files are integration-agent files. This spec's tools and tests need entries there; the integration agent makes those edits at the wave boundary, not a feature agent. This documentation task writes only `docs/engine/18-game-sdk.md`.

## 7. Acceptance

Every row is `PENDING` until the target code exists. A `PASS` requires a recorded build hash, device id from [`docs/DEVICES.md`](../DEVICES.md), browser version, date and numbers in [`docs/RESULTS.md`](../RESULTS.md). CI rows name Node 20 on `ubuntu-latest`; manual rows name `pc-win11-rtx3050` (Windows 11, Chrome 155.0.8059.85) for desktop and `android-phone-d0qa02` for the phone layout. Thresholds are targets, not measurements.

| ID | Criterion | Fixture / method | Hardware | Evidence state |
|---|---|---|---|---|
| ER-18-01 | SDK stays zero-dependency: `sdk/package.json` has `dependencies: {}`; the controller gzip size is unchanged from the last gate (40,794 / 40,960 B dev) after additive type changes, because types erase | `npm run size`; `sdk/test/package.test.ts` reads `package.json` | CI Node 20 | PENDING — additive types not implemented |
| ER-18-02 | Compile-time projection: every engine concrete type (`Scene`, `AssetLibrary`, `RendererCapabilities`, `DebugDraw`, `WorldStreamer`, `GameUi`, `AnimationApi`) is assignable to the SDK structural type; a negative fixture with a missing member fails `tsc` with the expected member name | `packages/runtime/test/types/sdk-assignability.test-d.ts`; `sdk/test/fixtures/negative/*.ts` compiled with `tsc --noEmit` | CI Node 20 | PENDING — types not implemented |
| ER-18-03 | Existing games unchanged: Reaction Duel and the platformer compile and their test suites pass without source edits; their lifecycle callback order is identical to the current golden trace | `npm test -- --project reaction-duel --project platformer`; `packages/runtime/test/gameHost.test.ts` | CI Node 20 | PENDING — SDK 1.0.0 not landed |
| ER-18-04 | Optional members are absent, not throwing stubs: on a host without assets/scene/streaming, `ctx.assets`, `ctx.scene`, `ctx.streaming` are `undefined`; `ctx.world` is absent on 2D-only hosts; frozen `panels/layouts/haptics` remain present and throw `CapabilityUnavailableError` when called | `packages/runtime/test/gameContext.test.ts` with a minimal host | CI Node 20 | PENDING |
| ER-18-05 | Manifest evolution: all v1 manifests load unchanged; every additive field validates; an unknown feature name is rejected with a field path; an unknown top-level property survives load and is readable; a 65 KiB manifest is rejected before parse | `sdk/test/manifest.additive.test.ts`; fixtures `manifest-additive.json`, `manifest-unknown-feature.json`, `manifest-65k.json` | CI Node 20 | PENDING |
| ER-18-06 | Load failures map one-to-one: manifest 404, invalid JSON, invalid manifest, escaping entry, import throw, no default export, factory throw, init throw and timeout each produce the expected `GameFailure.code`/`phase`, one launcher notice, and no unhandled rejection | `packages/runtime/test/loadGame.failures.test.ts`; fake fetch/import; fake timers | CI Node 20 | PENDING — timeout and init mapping missing |
| ER-18-07 | Lifecycle golden: `init` once, `simulate` only while playing, `onEvent` before `simulate`, `render` during playing and paused, `dispose` once and idempotent; a throwing `simulate` stops the loop and reports `runtime`; no callback after dispose | `packages/runtime/test/gameHost.lifecycle.test.ts` records the callback sequence and compares a golden array | CI Node 20 | PENDING — existing behaviour partly present; golden not recorded |
| ER-18-08 | Timeouts: a manifest fetch, entry import or `init` that never settles is aborted at 10,000 ms with `E_GAME_TIMEOUT` and the launcher returns; a 2,000 ms `dispose` continues teardown and logs once | Same harness with fake timers; a never-resolving promise fixture | CI Node 20 | PENDING |
| ER-18-09 | Template is real: `create-game harbor-run` produces a folder that typechecks, passes its test, is discovered by the launcher, and plays with two input-bot controllers for 60 s on both backends | `tools/create-game/test/scaffold.test.ts`; `experiments/e18-template/`; `tools/input-bot` | CI Node 20 for scaffold; `pc-win11-rtx3050` Chrome 155 for the 60 s run | PENDING — template not written |
| ER-18-10 | API reference is complete and deterministic: every export appears once, every export has a doc comment, regeneration is byte-identical, and no engine-internal type name appears | `node tools/sdk-docs/dist/cli.js --check`; `sdk/test/apiDocs.test.ts` | CI Node 20 | PENDING |
| ER-18-11 | Boundary isolation: a game importing `@lanpad/protocol`, `@lanpad/broker`, `@lanpad/engine-core`, a Node built-in or another game's file fails lint or the boundary test with the exact rule; a game using `window`/`document`/`fetch` in `simulate` fails the same test | ESLint `no-restricted-imports`; `packages/runtime/test/gameBoundary.test.ts` over fixture games | CI Node 20 | PENDING — engine packages do not exist yet |
| ER-18-12 | Version matrix: every row in §4.3 produces the stated result; a malformed version is refused before entry import; a compatible game on a higher minor runs | `sdk/test/compat.test.ts`; `packages/runtime/test/loadGame.compat.test.ts` | CI Node 20 | PENDING |
| ER-18-13 | Budgets: a game folder at 5 MB gzip passes; one byte over fails the size gate naming the game; an asset set over `assetBudget` fails before `init` with `budget` and the byte counts | `tools/size-budget` fixture; `packages/runtime/test/assetBudget.test.ts` | CI Node 20 | PENDING — asset pipeline stub |
| ER-18-14 | Parallel teams: two synthetic games added in one wave, with disjoint folders and one shared additive SDK change, both register, typecheck and test; neither game's files are edited by the other team's fixture; the SDK diff is a minor bump | `tools/create-game/test/two-games.test.ts`; fixture folders `fixtures/game-a`, `fixtures/game-b` | CI Node 20 | PENDING |
| ER-18-15 | Determinism: the template game with seed 1 and a 600-tick recorded input trace produces the same FNV-1a state hash on two runs and on WebGPU and WebGL2; changing the seed changes the hash | `experiments/e18-template/?replay=fixture-600.json&seed=1`; hash printed in the page and compared by the runner | `pc-win11-rtx3050`, Chrome 155, both backends | PENDING — M0 |
| ER-18-16 | Onboarding: someone given only `docs/api/sdk-1.0.md`, `templates/game/` and `tools/create-game` builds a game that passes typecheck, test and the 60 s two-bot run, without reading engine source | Manual P4 checklist; record time and every source looked at | `pc-win11-rtx3050`; phone `android-phone-d0qa02` for the layout | PENDING — P4 |

## 8. Test plan

**Unit (Node, Vitest).** Manifest validation for every field and boundary; compatibility matrix; failure-code mapping; version parsing; path containment for `entry`, `assetManifest`, `scene`, `world`; slug rules; package view construction.

**Property (`fast-check`).** Manifest round-trip for arbitrary valid names/paths/budgets; unknown-field preservation; compatibility is antisymmetric on majors (1.x vs 2.x refuses both directions); a random path with `..` is always rejected; a random `requiredFeatures` array with a duplicate is always rejected.

**Golden.** Lifecycle callback sequence for a canonical game (init, N ticks with events, pause, resume, dispose); manifest error messages; generated API reference; the `sdk/compat.json` vs `game-api.ts` match.

**Integration (real host pieces).** `loadGame` against a real static server on `127.0.0.1:0`: valid game, 404, invalid JSON, escaping entry, import throw, factory throw; `GameHost` with a real `FixedLoop` and fake scheduler for the timeout paths. No fixed sleeps; wait on promises and messages.

**Type tests.** The assignability fixture is compiled, not run. Positive fixtures must exit 0; negative fixtures must fail with the expected diagnostic. `tsc -b` covers the SDK; the games' tsconfigs cover the games.

**Browser/manual.** On `pc-win11-rtx3050`, Chrome 155: template game on WebGPU and WebGL2, phone layout on `android-phone-d0qa02`, 60 s with two bots, launcher error screens for a bad manifest and an incompatible SDK. TV rows are absent: the SDK has no TV-specific claim.

**Meta.** `npm run trace` (all stages, after spec 19's grammar change) resolves every `ER-18-*` row to a test or a named manual run. `node tools/sdk-docs/dist/cli.js --check` is part of the gate. A row may be `PENDING`, but it may not be missing.

## 9. Dependencies

| Dependency | What 18 needs | Status |
|---|---|---|
| `00-architecture.md` | package map, additive contract rules, version registry, browser tiers | Exists |
| `01-core-loop-time.md` | fixed tick, pause, frame stats, manual scheduler | Exists |
| `02-math.md` | `Vec3`, `Entity`, `Transform` value types used by the scene projection | Exists |
| `03-scene-ecs.md` | `Scene`, `Entity`, `Transform`, query semantics | written |
| `04-renderer-webgpu.md` | `RendererCapabilities`, `EngineFeature`, backend selection, device loss | Exists |
| `05-renderer-webgl2.md` | same capability shape and backend selection | Exists |
| `06-assets.md` | `AssetLibrary`, `AssetHandle`, manifest format, budgets | written |
| `08-animation.md` | `AnimationApi` projection | written |
| `09-audio.md` | existing `GameAudio` adapter | Exists |
| `10-input.md` | `ActionReader` projection, keyboard/mouse/gamepad mapping | written |
| `12-world-streaming.md` | `WorldStreamer` projection, `world.json`, chunk config | Exists |
| `13-ui-text.md` | `GameUi` projection | Exists |
| `15-save-load.md` | `SaveApi` projection | written |
| `16-tooling-profiler.md` | `DebugDraw`, capture identity for determinism rows | Exists |
| `17-editor.md` | play-in-editor uses this lifecycle and `ctx.scene` unchanged | Exists |
| `19-testing-benchmarks.md` | ER grammar, evidence format, benchmark fixtures, CI lanes | This wave |
| `sdk` package | current zero-dependency package, `Game`/`GameContext`/manifest | Exists, version 0.0.0 |
| `packages/runtime/src/game/*` | loader, host, context assembly, registry | Exists |

The SDK can land its additive **types** before specs 03, 06, 08, 10 and 15 exist, because the SDK restates structural shapes rather than importing implementations. It cannot land a context member whose engine adapter does not exist; that member stays `undefined` and its acceptance row stays `PENDING`.

## 10. Risks

| Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|
| SDK grows and bloats the controller bundle (166 B headroom at the last gate) | Medium | High — size gate fails | Types erase; no runtime constants in the controller path except `SDK_VERSION` if imported; `tools/size-budget` runs on every change; move any table to `sdk/compat.json` (not bundled) |
| SDK projection drifts from engine types | High without a test | Games compile then fail at runtime | Compile-time assignability test in the runtime; `compat.json` parsed from the interface; owning specs update the row in the same change |
| Additive member becomes effectively required by games | Medium | New games break on older hosts | Optional-by-type, `undefined` by policy; compatibility gate uses `sdkVersion`; template feature-detects |
| A game team edits SDK or engine files to unblock itself | Medium | Contract conflict | Ownership manifest and boundary test; SDK change is a request; two-game fixture proves disjoint work |
| Manifest growth becomes a config language | Medium | Unmaintainable, security surface | 64 KiB cap; only the listed fields; no executable values; unknown fields preserved but ignored |
| Timeouts break slow TV or low-end devices | Medium | Games fail to load | Timeouts are targets to tune with hardware evidence; a game streams after `init`; no timeout is claimed PASS without a TV run |
| Third-party code reaches DOM/network through a bundler shim | Medium | Security/privacy breach | CSP, same-origin containment, boundary lint, no `eval`; P4 review checklist |
| Generated docs go stale | Low | Developer confusion | `--check` in CI; version bump and docs in the same commit |
| WebGPU-only API leaks into games before WebGL2 parity | Medium | Fallback games break | Games branch on `capabilities`, never `backend`; 05 conformance suite; M0 requires both backends |
| `GameContext` freeze is violated by a convenient rename | Low | Existing games break | Frozen list in 00 §3.6 and this spec; removal requires major + amendment; ER-18-03 golden |

The fallback if the additive work cannot land in M0: ship SDK 1.0 with the frozen members only, keep `assets`/`scene`/`capabilities` as `undefined`, and record the milestone as partial. Do not fake the members with stubs that return empty data.

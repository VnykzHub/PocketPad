# 17 — Scene and World Editor

**Status:** authoritative for the engine programme's scene/world editor. This is a **later milestone** spec: nothing is implemented in the current tree, and no editor work may gate M0 or M1. Every acceptance row in §7 is `PENDING` until the named run or fixture exists.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product/protocol contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) for programme rules, [`docs/engine/00-architecture.md`](00-architecture.md) for package boundaries, milestones and the scene/asset contracts. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded.
**Milestone:** **M2** (00 §8 and §9). A dev-only prototype may exist earlier behind an explicit dev flag, but it cannot be cited as evidence, cannot be part of a wave gate, and cannot change a production bundle. The first editor milestone is a single-cell scene editor with play-in-editor; world-cell editing follows streaming (12).

---

## 1. Goal

Let content teams build the worlds the engine is designed for **without hand-editing JSON or reading engine source**.

The player-visible outcome: a city block with buildings, vehicles, lights, props and a playable mission is authored, previewed and corrected in the editor, then runs through the exact same runtime path as a bundled game. The editor is how the programme moves from "a demo scene" to "a world", and it is the tool that makes M3 content work parallelisable.

The engineering outcomes:

- one deterministic scene document format that the editor, runtime and tests all read, with byte-stable round-trips;
- an undo/redo model that survives long editing sessions and never leaves the document and rendered scene out of sync;
- a play-in-editor path that reuses the real `GameHost`, real input and real renderer rather than a second game loop;
- placement, transform, lighting and prefab tools concrete enough for a fresh agent to implement from this spec;
- an asset browser driven by the engine asset manifest (06), so a missing or invalid asset is visible before play;
- explicit later-milestone boundaries: the editor is dev-only, desktop-only, not collaborative and not a modelling package.

**Scope.** The editor document envelope, the editor application structure, commands/undo, selection/gizmos, scene sync, serialization, lighting authoring, asset browser, play-in-editor and world-cell authoring. The in-memory scene/ECS semantics belong to spec 03; component behaviour belongs to the owning subsystem spec (04, 07, 08, 09, 12, 13).

---

## 2. Non-goals

- **Not shipped to players.** The editor is a dev build served under `/x/editor/`; no production bundle contains it.
- **Not a DCC package.** No modelling, sculpting, UV editing, rigging, animation authoring or texture painting. Blender or an equivalent external tool produces assets; the editor places and configures them.
- **Not a code editor or visual scripting system.** A `ScriptRef` component points at a game-provided script id; the editor does not author or execute game logic. Executing anything from a scene document is forbidden.
- **Not a terrain/road/water authoring tool in v1.** Terrain sculpting and road splines are deferred until M3 and require their own spec. The editor can place terrain tiles and road prefabs from assets.
- **Not a lightmap baker.** Real-time lighting preview only; baking is an M3 content-pipeline decision.
- **Not a UI editor.** Spec 13 owns UI; the editor may preview a HUD but does not lay it out.
- **Not collaborative.** One editor instance, one document, no server, no presence, no conflict resolution.
- **Not a TV/remote tool.** Keyboard and mouse only; no gamepad or phone editing surface.
- **Not the runtime.** The editor never becomes a dependency of `packages/runtime`, a game package, the controller or a production build.
- **Not a replacement for spec 03.** Component storage, entity lifetime and query semantics are owned by 03; the editor calls them. The editor owns file identity, ordering and undo.
- **Not an asset importer.** 06 owns formats and conversion; the editor browses and instantiates.
- **No network access beyond same-origin dev assets.** No cloud storage, no upload, no telemetry (SR-7).
- **Not a save-game editor.** Spec 15 owns saves; the editor never writes a `.pps` file.

---

## 3. Public interfaces

The editor lives in the dev-only `@lanpad/engine-tooling` package under a separate `./editor` entry (directory ownership in §6). It imports `engine-core` types and `engine-assets` types only. The concrete renderer and the real game host are supplied by the dev page (`experiments/editor/`), which is the composition root allowed to import renderer/runtime packages. This keeps the tooling package inside the dependency rules of 00 §5.2.

### 3.1 Editor application

```ts
export interface EditorOptions {
  readonly mount: HTMLElement;
  readonly services: EditorServices;
  readonly projectUrl: string;          // same-origin "editor-project.json"
  readonly autosave?: AutosaveOptions;
}

export interface EditorServices {
  /** Created by the dev page from a concrete backend; engine-core contract. */
  readonly device: RenderDevice;
  readonly assets: AssetLibrary;
  /** Scratch scene owned by the editor; cleared on project change. */
  readonly scene: Scene;
  readonly now: () => number;
  readonly raf: (cb: (nowMs: number) => void) => number;
  readonly cancel: (id: number) => void;
  /** Supplied by the dev page; starts the real GameHost for play-in-editor. */
  readonly createPlaySession: (doc: EditorDocument, mount: HTMLElement) => PlaySession;
}

export interface EditorApp {
  openProject(url: string): Promise<void>;
  openScene(sceneId: string): Promise<void>;
  saveScene(): Promise<Uint8Array>;
  readonly selection: EditorSelection;
  readonly gizmo: GizmoState;
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): boolean;
  redo(): boolean;
  readonly play: PlayController;
  dispose(): void;                      // idempotent; releases listeners and scratch scene
}

export function createEditor(options: EditorOptions): EditorApp;
```

### 3.2 Document model

```ts
export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export interface EditorTransform {
  position: Vec3Tuple;
  rotation: QuatTuple;   // normalized on load
  scale: Vec3Tuple;
}

export interface EditorEntity {
  readonly id: string;                    // stable within a scene
  name: string;
  parent: string | null;
  transform: EditorTransform;
  prefab: string | null;                  // prefab id or null for a plain entity
  components: Readonly<Record<string, JsonValue>>;
  tags?: readonly string[];
}

export interface EditorSceneSettings {
  background: string;                     // "#rgb" or "#rrggbb"
  ambient: { color: string; intensity: number };
  fog?: { color: string; near: number; far: number; density?: number } | null;
  gravity: Vec3Tuple;
}

export interface EditorDocument {
  readonly formatVersion: 1;
  readonly kind: "scene";
  readonly id: string;                    // ^[a-z0-9][a-z0-9-]{0,63}$
  readonly engineVersion: string;         // ENGINE_VERSION at write time
  readonly settings: EditorSceneSettings;
  readonly entities: readonly EditorEntity[];
  readonly extra?: Readonly<Record<string, JsonValue>>; // preserved unknown top-level data
}

export interface EditorProject {
  readonly formatVersion: 1;
  readonly kind: "editor-project";
  readonly id: string;
  readonly scenes: readonly { id: string; url: string }[];
  readonly prefabs: readonly { id: string; url: string }[];
  readonly assetManifest: string;         // relative path, default "asset-manifest.json"
  readonly playScene: string;
  readonly grid: { cell: number; snap: number };
  readonly world?: EditorWorld;
}

export interface EditorWorld {
  readonly cellSize: number;              // metres; world configuration, not part of a cell key
  readonly cells: readonly { cx: number; cy: number; scene: string }[];
}

export interface EditorPrefab {
  readonly formatVersion: 1;
  readonly kind: "prefab";
  readonly id: string;
  readonly root: string;                  // entity id inside entities
  readonly entities: readonly EditorEntity[];
  readonly extra?: Readonly<Record<string, JsonValue>>;
}
```

### 3.3 Commands, selection and gizmos

```ts
export interface MutableDocument {
  readonly id: string;
  readonly entities: Map<string, EditorEntity>;
  readonly settings: EditorSceneSettings;
  addEntity(entity: EditorEntity): void;
  removeEntity(id: string): void;
  updateEntity(id: string, patch: Partial<EditorEntity>): void;
  setParent(id: string, parent: string | null): void;
  readonly extra: Record<string, JsonValue>;
}

export interface EditorCommand {
  readonly label: string;                 // shown in the undo menu
  readonly mergeKey?: string;             // adjacent commands coalesce while dragging
  apply(doc: MutableDocument): void;
  revert(doc: MutableDocument): void;
}

export interface CommandStack {
  execute(command: EditorCommand): void;
  beginTransaction(label: string): void;
  commit(): void;
  rollback(): void;
  undo(): boolean;
  redo(): boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly size: number;                  // commands currently undoable
  clear(): void;
}

export type GizmoMode = "translate" | "rotate" | "scale";
export type GizmoSpace = "world" | "local";

export interface GizmoState {
  mode: GizmoMode;
  space: GizmoSpace;
  snap: { translate: number; rotateDeg: number; scale: number };
}

export interface EditorSelection {
  readonly ids: readonly string[];
  set(ids: readonly string[]): void;
  add(id: string): void;
  remove(id: string): void;
  clear(): void;
  has(id: string): boolean;
}
```

### 3.4 Component schemas

```ts
export type EditorFieldKind =
  | "number" | "vec3" | "quat" | "color" | "boolean"
  | "enum" | "string" | "asset" | "entity";

export interface EditorField {
  readonly key: string;
  readonly label: string;
  readonly kind: EditorFieldKind;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly options?: readonly string[];   // for "enum"
  readonly assetKind?: string;            // for "asset", e.g. "mesh"
}

export interface ComponentSchema<T = unknown> {
  readonly name: string;                  // registry key, e.g. "MeshRenderer"
  readonly version: number;
  readonly fields: readonly EditorField[];
  defaults(): T;                          // allocates; called on create only
  validate(value: T): readonly string[];
  serialize(value: T): JsonValue;
  deserialize(json: JsonValue): T;
}

export function registerComponentSchema(schema: ComponentSchema): void;
export function getComponentSchema(name: string): ComponentSchema | undefined;
```

Built-in schemas registered at boot: `MeshRenderer` (04), `Light` (04), `Camera` (04), `Collider`/`RigidBody` (07), `AudioSource` (09), `ScriptRef` (game-owned data), `StreamCell` (12). A schema is data-only: no editor schema may execute game code. Unknown component keys are preserved and shown read-only; the editor never drops them.

### 3.5 Serialization and play

```ts
export interface SceneSerializer {
  serialize(doc: EditorDocument, options?: { pretty?: boolean }): Uint8Array;
  parse(bytes: Uint8Array): EditorDocument;    // validates and migrates
  loadIntoScene(doc: EditorDocument, scene: Scene, assets: AssetLibrary): Promise<void>;
  captureFromScene(scene: Scene, meta: { id: string }): EditorDocument;
}

export function createSceneSerializer(options?: { engineVersion?: string }): SceneSerializer;
export function migrateSceneDocument(value: unknown): EditorDocument; // throws EditorError("E_EDITOR_VERSION")

export interface PlaySession {
  start(): Promise<void>;                  // real GameHost.init + loop
  stop(): void;                            // dispose game and transient scene
  readonly state: "starting" | "playing" | "failed";
  readonly error: string | null;
  readonly sceneUsed: boolean;             // false when the game ignores ctx.scene
}

export interface PlayController {
  play(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
  readonly state: "editing" | "starting" | "playing" | "paused" | "failed";
}

export type EditorErrorCode =
  | "E_EDITOR_DOCUMENT"    // schema/validation failure
  | "E_EDITOR_VERSION"     // newer or unknown format version
  | "E_EDITOR_REFERENCE"   // dangling parent/prefab/entity/asset reference
  | "E_EDITOR_ASSET"       // asset manifest unavailable or invalid
  | "E_EDITOR_PLAY"        // play session failed to start
  | "E_EDITOR_BUSY";       // save/open/play attempted during an exclusive operation
```

`EditorError` is dev-only and never crosses into the runtime. A failed play session leaves the document intact and returns the editor to `editing`.

---

## 4. Data formats

### 4.1 Editor project (`editor-project.json`, formatVersion 1)

UTF-8 JSON, one per game root, ≤ 256 KiB.

| Field | Rule |
|---|---|
| `formatVersion` | exactly `1` |
| `kind` | exactly `"editor-project"` |
| `id` | `^[a-z0-9][a-z0-9-]{0,63}$` |
| `scenes` | 1..4096 entries; unique `id`; `url` is a same-origin relative path, no scheme, no `..` |
| `prefabs` | 0..4096 entries; unique `id`; relative `url` |
| `assetManifest` | relative path, default `asset-manifest.json` |
| `playScene` | must name an entry in `scenes` |
| `grid` | `cell > 0`, `snap ≥ 0` (0 disables snapping) |
| `world` | optional; `cellSize > 0`; each cell key canonical per 00 §4.4; `scene` must name a scene |

### 4.2 Scene document (`.scene.json`, `SCENE_FORMAT_VERSION = 1`)

UTF-8 JSON. The envelope is owned here; component meaning is owned by the component's subsystem spec. Synthetic example:

```json
{
  "formatVersion": 1,
  "kind": "scene",
  "id": "city-block-01",
  "engineVersion": "0.3.0",
  "settings": {
    "background": "#0b1020",
    "ambient": { "color": "#8090b0", "intensity": 0.35 },
    "fog": { "color": "#0b1020", "near": 80, "far": 400 },
    "gravity": [0, -9.81, 0]
  },
  "entities": [
    {
      "id": "e-0001",
      "name": "Sedan",
      "parent": null,
      "transform": {
        "position": [12.5, 0, -4],
        "rotation": [0, 0, 0, 1],
        "scale": [1, 1, 1]
      },
      "prefab": "sedan",
      "components": {
        "MeshRenderer": { "mesh": "meshes/sedan", "material": "materials/car-red" },
        "Collider": { "shape": "box", "size": [2, 1, 1] }
      },
      "tags": ["vehicle"]
    }
  ],
  "extra": {}
}
```

Rules:

- **Size ≤ 4 MiB** per scene (the json asset limit in 00 §4.3). The editor warns above 5,000 entities and recommends splitting into world cells (12). It never silently truncates.
- `id` matches `^[a-z0-9][a-z0-9-]{0,63}$`; entity ids match `^[a-z0-9][a-z0-9_.:-]{0,63}$` and are unique.
- `parent` is `null` or an existing entity id; the graph is acyclic and at most 64 levels deep (a safety limit, not a content rule).
- Transform numbers are finite; `rotation` is normalized on load (a zero quaternion becomes identity); zero scale is allowed but warned.
- Asset references are **asset manifest ids**, never URLs. Prefab references are prefab ids. Entity references are entity ids. No absolute path, URL, `..`, scheme or query appears in a document.
- Component keys must be registered to be edited; unknown keys are preserved byte-for-byte and shown read-only. Unknown top-level keys are preserved in `extra`.
- **Determinism:** the writer sorts entities by `id`, sorts object keys lexicographically, emits shortest round-trip numbers, uses two-space indentation when `pretty`, one trailing newline, and never writes timestamps, editor version or machine data. `serialize(parse(x)) === x` byte-for-byte for a canonical document.
- `engineVersion` records the writer; the reader does not refuse a newer engine patch, but a newer `formatVersion` is refused with `E_EDITOR_VERSION`.

### 4.3 Prefab (`.prefab.json`, `PREFAB_FORMAT_VERSION = 1`)

UTF-8 JSON, ≤ 256 KiB, ≤ 1,000 entities.

| Field | Rule |
|---|---|
| `formatVersion` | exactly `1` |
| `kind` | exactly `"prefab"` |
| `id` | `^[a-z0-9][a-z0-9-]{0,63}$`, unique in the project |
| `root` | entity id present in `entities`; its `parent` is `null` |
| `entities` | same entity rules as §4.2; every non-root parent is inside the prefab |
| `extra` | preserved unknown data |

Instantiating a prefab creates a new entity subtree with fresh entity ids, remapped parent links and copied components. The instance records `prefab: <id>`; overrides are ordinary component/transform edits. The editor does not maintain a live link to the prefab file in v1 (no automatic propagation); a "revert to prefab" command is a later additive feature.

### 4.4 Autosave (dev-only)

- IndexedDB store `pocketpad-editor`, one key per `(projectId, sceneId)`, three rotating slots, written every 30 s while dirty and on `visibilitychange` to hidden.
- Payload is `{ formatVersion: 1, savedAtUnixMs, document: EditorDocument }`; no selection/camera, no tokens, no player data.
- On open, if an autosave exists and differs from the file, the editor offers restore or discard. It never overwrites silently.
- Autosave never leaves the browser. Clearing site data loses it; this is acceptable for a dev tool.
- The undo journal is **not** persisted; reopening a scene starts with an empty history.

### 4.5 Versioning and migration

| Name | Current | Owner | Rule |
|---|---:|---|---|
| `SCENE_FORMAT_VERSION` | 1 | 03/17 (03 for component semantics, 17 for envelope/order) | Breaking field change bumps; readers keep the previous version for one milestone |
| `PREFAB_FORMAT_VERSION` | 1 | 17 | Same rule |
| `EDITOR_PROJECT_VERSION` | 1 | 17 | Same rule |

Migration is a pure function chain (`v1 → v2 → current`), tested with a fixture per version. A newer version is refused before any entity is created. Migration never touches asset bytes and never executes document content.

### 4.6 Security and privacy

- Scene/prefab/project files are data. The editor parses JSON, validates fields, and never `eval`s, imports or executes a string from a document.
- Assets are resolved through the manifest id and the same-origin game root; path traversal, schemes and query strings are rejected.
- No tokens, room codes, player names or IP addresses are read or written. Autosave is local.
- The editor page is served by the dev server under the existing dev CSP (`script-src 'self'`, `style-src 'self'`); it uses external scripts/styles only.
- The editor is absent from production bundles; a build-graph test enforces it.

---

## 5. Architecture

### 5.1 Composition

```
experiments/editor/            dev page, composition root
  index.html
  page.ts                      creates RenderDevice (WebGPU/WebGL2), AssetLibrary,
                               Scene, and a PlaySession backed by the real GameHost
  page.css

packages/engine/tooling/src/editor/
  app.ts                       createEditor, panel wiring, lifecycle
  document/
    model.ts                   MutableDocument, validation
    serializer.ts              canonical writer, parser, migration
    project.ts                 project loader, scene/prefab resolution
  commands/
    stack.ts                   undo/redo, transactions, merge
    entityCommands.ts          create/delete/rename/parent/duplicate
    transformCommands.ts       move/rotate/scale, snap
    componentCommands.ts       add/remove/edit
    prefabCommands.ts          instantiate/revert
    settingsCommands.ts        lighting/environment
  scene/
    sync.ts                    document ↔ scratch Scene reconciliation
    picking.ts                 ray from camera, entity hit test
    gizmos.ts                  translate/rotate/scale, screen-constant size
    grid.ts                    world grid, snap, cell overlay
  panels/
    hierarchy.ts
    inspector.ts               schema-driven fields
    assetBrowser.ts            manifest + thumbnails
    viewport.ts                camera controller, selection, gizmo host
    console.ts                 validation/play errors
    playBar.ts                 play/pause/step/stop
  play/
    controller.ts              PlayController; delegates to injected PlaySession
  autosave.ts
  input.ts                     editor keyboard/mouse map (not engine-input)
```

### 5.2 Data flow

```
pointer/keyboard
   → panel or viewport action
   → EditorCommand (with mergeKey for drags)
   → CommandStack.execute
   → MutableDocument mutation
   → SceneSync (create/destroy/update scratch Scene)
   → mark viewport dirty → render on demand
```

- The document is the source of truth. The scratch `Scene` is a projection and is never edited directly except by `SceneSync`.
- Idle editing renders on demand (dirty flag), which keeps the editor quiet on a laptop. Play mode renders continuously.
- `SceneSync` reconciles by stable document id: new entities are created, removed entities are destroyed, transform/component changes are applied. It reuses pooled arrays and allocates only when entities are added or removed.
- Saving serializes the document, not the scene, so a runtime-only component cannot silently leak into the file.

### 5.3 Selection, picking and gizmos

- Picking casts a ray from the viewport camera through the pointer (02 math). It tests entity bounds from 03/07; mesh-accurate picking may be added without changing the interface.
- Selection is a set of entity ids. Multi-select shows a combined pivot; the inspector shows shared fields and marks mixed values.
- Gizmos are drawn through the debug-draw sink (16) with screen-constant size: translate arrows, rotate rings, scale handles. Clicking a handle starts a transaction; pointer movement applies one command per frame with `mergeKey = "transform:<entity>:<axis>"`; pointer-up commits. One drag is one undo entry.
- Snapping: translate on the project grid (or 0.5 m default when grid snap is 0), rotation in degrees, scale in 0.05 steps. Holding the modifier bypasses snap. Numeric inspector edits are exact and are not snapped.
- Local mode uses the entity's rotation; world mode uses world axes. A parent transform is composed, never baked into the child until an explicit "apply transform" command.

### 5.4 Undo and transactions

- Every mutation is a command with `apply` and `revert`. Commands never call the panel layer; panels re-read from the document after an undo/redo.
- Adjacent commands with the same non-empty `mergeKey` coalesce within 250 ms (mouse drag) so a drag does not create hundreds of entries.
- A transaction groups several commands (e.g. "duplicate selection + reparent + rename") into one undo entry. A failed transaction rolls back completely.
- History is capped at 200 commands; the oldest entry is dropped. Undo memory is bounded (see R17-4).
- Undo/redo restores selection captured before the command. Undo stops at the last save boundary only if the user chooses "clear history on save"; the default keeps history.
- Play-in-editor is a hard boundary: entering play requires a clean document (auto-save or explicit save), undo history is frozen during play, and stopping returns to the same history.

### 5.5 Lighting and environment authoring

- `Light` schema fields: type (`directional`, `point`, `spot`), colour, intensity, range, cone angles, shadow enable, shadow bias. The renderer's real-time preview is the truth; the editor does not bake.
- `settings.ambient` and `settings.fog` edit the scene environment. Skybox/IBL is an asset reference in a later additive field.
- Light gizmos show direction, range and cone; selecting a light opens its schema. Invalid values (negative range, cone outside 0..90°) fail validation with an inspector error.
- The editor warns when a scene exceeds a documented light count once spec 04 defines one. It does not invent a limit.

### 5.6 Asset browser

- Reads `asset-manifest.json` (06) and lists entries by kind with declared bytes. Thumbnails: decode a small preview off the main thread where 06 provides one; otherwise show a kind icon and metadata. The thumbnail cache is dev-only and may live in memory or IndexedDB.
- Drag-and-drop:
  - mesh → creates an entity with `MeshRenderer`;
  - material → assigns to the selected renderer or creates a material preview;
  - texture → assigns to the selected material field;
  - prefab → instantiates the prefab subtree;
  - scene → opens it (with a dirty check);
  - audio → creates an `AudioSource`.
- A missing asset (manifest entry present, file absent) shows a red placeholder in the browser and in the viewport; the document keeps the id. Saving does not drop it.
- The browser never fetches outside the game root and never executes an asset.

### 5.7 Play-in-editor

1. Require a clean document: save or autosave, then snapshot the document.
2. Build a transient `Scene` from the snapshot through `SceneSync` and the serializer's loader; apply the scene settings.
3. Call the injected `createPlaySession(snapshot, mount)`. The dev page starts the **real** `GameHost` with the real runtime, real input adapter (phone bridge, keyboard/mouse, gamepad) and the real renderer, with `ctx.scene` pointing at the transient scene.
4. `PlayController` forwards pause/resume/stop. `step` (if present) advances exactly one fixed tick while paused; the tick uses the same fixed `dt`.
5. Stop disposes the game and transient scene in the runtime's fixed teardown order; the scratch editor scene and document are untouched. Any game save request is refused (`E_EDITOR_PLAY`) because play is a preview.
6. If the game does not use `ctx.scene`, `PlaySession.sceneUsed` is false and the play bar shows "game ignores edited scene"; the game still runs, which is useful for testing UI/input but is not a scene acceptance result.
7. Play sessions never write to the network or storage beyond the runtime's normal room join. The editor does not create a room by itself; the dev page may host one for controllers.

### 5.8 World-cell editing (M2, after streaming)

- `EditorWorld` maps canonical cell keys (`"<cx>,<cy>"`, 00 §4.4) to scenes. The editor shows a top-down cell grid at `cellSize`.
- The active cell is fully editable. Neighbouring cells are rendered read-only (ghosted) so placement at a border is meaningful.
- Creating a cell creates a new scene and a project entry; deleting a cell requires confirmation and never deletes the scene file.
- Cell size is a project property, not a per-cell value; changing it after cells exist requires an explicit migration that refuses when scenes exist (the key alone cannot express the size).
- Streaming itself (12) owns load/unload; the editor only authors the mapping and content.

### 5.9 Performance and correctness rules

- Idle editing: no per-frame allocation; render only when dirty. Play mode follows the engine's no-allocation hot-path rule.
- A scene load parses and validates off the render path. Entity creation is batched into one `SceneSync` pass per frame after a paste or prefab instantiate.
- The editor never holds a stale entity handle across an undo; handles are re-resolved from document ids.
- A save is atomic from the user's perspective: serialize fully, then write. A failed write leaves the previous file and reports an error.
- The editor's own UI is plain DOM with external CSS; no framework dependency enters the tooling package.

---

## 6. File ownership

This spec owns no production code. The editor is dev-only. One writer per file; files shared with 16/19 are listed explicitly.

| Path | Owner | Contents |
|---|---|---|
| `docs/engine/17-editor.md` | 17 | This spec |
| `packages/engine/tooling/src/editor/**` | 17 | Editor app, document, commands, scene sync, panels, play controller, autosave |
| `packages/engine/tooling/src/editor/editor.css` | 17 | External stylesheet under the dev CSP |
| `packages/engine/tooling/test/editor/**` | 17 | Unit/property/integration tests |
| `packages/engine/tooling/test/fixtures/editor/**` | 17 | Canonical scenes, prefabs, migrations, 1,000-entity and 4 MiB fixtures |
| `experiments/editor/**` | 17 | Dev page, composition root, PlaySession backed by the real GameHost |
| `packages/engine/tooling/package.json` `exports["./editor"]` | integration agent | Added in the editor wave; 17 does not edit the package file |
| `packages/engine/tooling/src/shared/**`, `profile/**`, `browser/**` (profiler parts) | 16 | Shared tooling; 17 imports, never edits |
| `packages/engine/tooling/src/node/bench/**`, `src/browser/bench/**` | 19 | Benchmarks; 17 never edits |
| `packages/runtime/src/game/**`, `src/net/**`, `src/ui/**` | existing owners | 17 does not edit; the dev page calls them |
| `packages/dev-server/**` | existing owner | No change: `/x/editor/` uses the existing experiments route |
| `sdk/**` | 18 | No change |
| `packages/games/**` | game owners | No change; a game opts into `ctx.scene` through the SDK |

No editor file may be imported by `packages/runtime`, a game, the controller or a production entry. A build-graph test enforces the boundary.

---

## 7. Acceptance

The editor is an M2 deliverable; every row is `PENDING` until M2. A `PASS` requires a recorded build, device id, date and numbers in [`docs/RESULTS.md`](../RESULTS.md). Hardware rows name `pc-win11-rtx3050` (Desktop Chrome 155.0.8059.85, Windows 11) from [`docs/DEVICES.md`](../DEVICES.md). There is deliberately **no TV acceptance row**: the editor is a keyboard/mouse dev tool and TV/remote editing is a non-goal.

| ID | Criterion | Fixture / method | Hardware | Evidence state |
|---|---|---|---|---|
| ER-17-01 | Canonical scene round-trip is byte-identical: `serialize(parse(x)) === x` for the fixture scene, including entity order, key order, number spelling and trailing newline | `packages/engine/tooling/test/fixtures/editor/city-block-01.scene.json` | CI Node 20 | PENDING — M2 implementation |
| ER-17-02 | A 1,000-entity scene opens with hierarchy, inspector, viewport and asset browser ready in ≤ **2 s** | `experiments/editor/?scene=fixture-1000`; mark from file fetch to panels ready | `pc-win11-rtx3050`, Chrome 155, WebGL2 | PENDING — M2 implementation |
| ER-17-03 | Viewport holds ≥ **30 fps** at 1920×1080 with 5,000 visible entities while idle-editing | Same page, `?bench=1`; 600-frame sample after 120 warm-up | `pc-win11-rtx3050`, Chrome 155, WebGL2 | PENDING — M2 run |
| ER-17-04 | Undo/redo is exact: 200 random commands, undo all restores the initial document hash, redo all restores the final hash; no selection or handle leak | Property test in `packages/engine/tooling/test/editor/undo.property.test.ts` | CI Node 20 | PENDING — M2 implementation |
| ER-17-05 | A 0.5 m translate snap produces exact multiples after 1,000 drags with zero drift; rotate snap produces exact degrees; scale snap exact steps | `packages/engine/tooling/test/editor/gizmo.test.ts` | CI Node 20 | PENDING — M2 implementation |
| ER-17-06 | Play-in-editor parity: the same game, seed and 600-tick input trace produce the same FNV-1a state hash as `/games/<slug>/` | `experiments/editor/?play=1` with a capture from 16; compare with the bundled-game run | `pc-win11-rtx3050`, Chrome 155 | PENDING — M2 run |
| ER-17-07 | Stopping play restores the pre-play document hash exactly and leaves no entities in the scratch scene (alive count returns to the pre-play count) | Integration test in `test/editor/play.test.ts` + page run | CI Node 20 (fake play session); `pc-win11-rtx3050` for the real one | PENDING — M2 implementation |
| ER-17-08 | A missing asset shows a placeholder, does not crash, and survives save/load with its manifest id unchanged | Fixture `.../fixtures/editor/missing-asset.scene.json` + `.../assets-missing/` root | CI Node 20 | PENDING — M2 implementation |
| ER-17-09 | Unknown component and unknown top-level data survive load → edit → save byte-for-byte (the editor never drops data it does not understand) | Fixture `.../fixtures/editor/unknown-component.scene.json` | CI Node 20 | PENDING — M2 implementation |
| ER-17-10 | Version handling: current and previous scene versions load through the migration chain; a newer version is refused with `E_EDITOR_VERSION` before any entity is created | Fixtures `scene.v1.json`, `scene.v0.json`, `scene.v99.json` | CI Node 20 | PENDING — M2 implementation |
| ER-17-11 | Autosave recovers after a simulated crash with ≤ **30 s** of lost work; a clean close leaves no recovery prompt | jsdom integration with fake IndexedDB | CI Node 20 + jsdom | PENDING — M2 implementation |
| ER-17-12 | No production host/controller/game bundle contains editor code; `npm run size` is unchanged by editor work | Build-graph test + `npm run size` | CI Node 20 | PENDING — M2 implementation |
| ER-17-13 | A scene at the **4 MiB** JSON limit parses and validates successfully; an entity above the 64-level parent limit is rejected with a field path | Fixture `.../fixtures/editor/limits-4mb.scene.json` + synthetic deep tree | CI Node 20 | PENDING — M2 implementation |
| ER-17-14 | A world project with canonical cell keys (`"0,0"`, `"12,-3"`) round-trips; a non-canonical key (`"003,0"`, `"-0,2"`) is rejected | Fixture `.../fixtures/editor/world-project.json` | CI Node 20 | PENDING — M2 implementation |
| ER-17-15 | A prefab instantiate produces fresh ids, remapped parents and copied components; deleting the instance does not delete the prefab | Unit/property test `test/editor/prefab.test.ts` | CI Node 20 | PENDING — M2 implementation |

Thresholds are targets, not measurements. No editor row is claimed from a desktop browser when it requires TV or console hardware; the editor has no such row.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | document validation, parent-cycle detection, canonical ordering, field schema rendering, snapping math, command apply/revert, selection | `packages/engine/tooling/test/editor/*.test.ts` |
| Property (`fast-check`) | serialize/parse round-trip, undo-all/redo-all identity, random command sequences, prefab id remapping, parent-graph acyclicity | `.../test/editor/*.property.test.ts` |
| Golden | canonical scene/prefab/project bytes; migration outputs; inspector snapshot for a fixed entity | `.../test/fixtures/editor/` |
| Integration | project load → scene sync → save; missing assets; autosave recovery; play start/stop with a fake `PlaySession`; no entity leak | `.../test/editor/integration/*.test.ts` |
| Browser | real viewport, picking, gizmo drag, play-in-editor with the real GameHost at `127.0.0.1:0` | `experiments/editor/` (manual and scripted page run) |
| Benchmark | open time, viewport fps, undo memory, save time | `experiments/editor/?bench=1`; results recorded by spec 19 |
| Manual | 30-minute authoring session: place 100 props, undo/redo, play, save, reload; no lost work, no visual drift | `docs/RESULTS.md` row |
| Meta | every `ER-17-*` row has a fixture or a named manual run; every fixture exists; no production bundle contains editor code | trace check + build-graph test |

Test rules:

- Test titles carry `ER-17-*` or a leading `// @req ER-17-*`.
- All editor tests run without a GPU except the browser rows; the scratch `Scene` uses the engine's real implementation, not a mock, where the semantics matter.
- Integration tests use a temporary directory under `os.tmpdir()` and bind `127.0.0.1:0`; they never touch a live room.
- Golden files are canonical (one trailing newline, LF) and checked in; regeneration requires a format-version note.
- A failed save/play test asserts the previous document is intact and the error is surfaced in the console panel.

---

## 9. Dependencies

| Dependency | Why | Status |
|---|---|---|
| `00-architecture.md` | Dev-only tooling boundary, `SCENE_FORMAT_VERSION`, cell-key canonicalization, milestones | Exists |
| `02-math.md` | Ray, plane, quaternion and matrix math for picking and gizmos | written |
| `03-scene-ecs.md` | `Scene`, `Entity`, `Transform`, component storage, queries; the editor's scratch projection | written |
| `04-renderer-webgpu.md` / `05-renderer-webgl2.md` | Viewport device, camera, light components and material fields | written |
| `06-assets.md` | Asset manifest, asset ids, thumbnails, format validation | written |
| `07-physics3d.md` | Collider/body schemas, raycast for surface placement and picking (optional at first) | written |
| `08-animation.md` | Animation clip preview and skeleton fields (read-only in the first editor) | written |
| `09-audio.md` | `AudioSource` schema and preview | written |
| `10-input.md` | Keyboard/mouse/gamepad action map used by play-in-editor | written |
| `11-ai-navigation.md` | Navmesh/cell overlays (M2, read-only) | written |
| `12-world-streaming.md` | `WorldCell`, cell keys, cell-size rule for world editing | written |
| `13-ui-text.md` | Text/UI preview only; no UI authoring | written |
| `16-tooling-profiler.md` | `@lanpad/engine-tooling` package, debug draw, profiler overlay | This wave |
| `18-game-sdk.md` | `GameContext.scene`, play-in-editor contract | This wave |
| `19-testing-benchmarks.md` | Benchmark fixtures and evidence format for ER-17 rows | This wave |
| `packages/runtime/src/game/GameHost.ts` | Real play session, unchanged | Exists |

**Sequencing.** 02/03 first; a document-only editor (project, scene, hierarchy, inspector, undo, serialization) can be built against fakes before 04/06. The viewport needs 04/05 and 06. Play-in-editor needs 10 and the additive `ctx.scene` from 18. World cells need 12. No editor work is part of M0 or M1 gates; it may be prototyped only behind `/x/editor/` and a dev flag.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R17-1 | Editor scope explodes into a DCC/scripting product | High | No M2 delivery | Non-goals are normative; components are schema-driven; import from Blender, do not build modelling |
| R17-2 | Editor and runtime diverge (a scene looks different in play) | High if unmanaged | Content bugs | One serializer and one `SceneSync`; play uses the real `GameHost`; parity fixture ER-17-06 |
| R17-3 | Serialization is non-deterministic or loses unknown data | Medium | Diff noise, data loss | Canonical writer, sorted keys/entities, unknown-data preservation, byte-stable tests |
| R17-4 | Undo memory grows unbounded on large scenes | Medium | Editor stalls/crashes | 200-command cap, transactions, merge keys, memory measured on a 10k-entity scene, command compaction |
| R17-5 | Play-in-editor mutates the document or leaks entities | Medium | Lost work, corrupt scene | Snapshot + transient scene, hard play boundary, stop disposes in fixed order, ER-17-07 |
| R17-6 | Scene files exceed the 4 MiB json limit as worlds grow | High for M3 | Cannot save a cell | Cell partitioning (12), editor warning at 5,000 entities, hard limit enforced on save |
| R17-7 | Asset references rot (renamed/missing assets) | High | Broken scenes | Manifest-id references, red placeholders, audit command from 16, save preserves ids |
| R17-8 | The editor drags runtime or renderer imports into tooling | Medium | Dependency-rule violation, bundle risk | Dev page is the composition root; editor core imports engine-core/assets types only; build-graph test |
| R17-9 | Gizmo/picking drift under parent transforms | Medium | Placement errors | World-matrix composition tested; snap tests; numeric inspector is authoritative |
| R17-10 | World-cell editing is built before streaming exists | Medium | Rework | World editing is M2 after 12; first editor is single-cell |
| R17-11 | Keyboard/mouse only is mistaken for a TV tool | Low | Scope confusion | Explicit non-goal; no TV row; editor is desktop dev-only |
| R17-12 | The editor becomes a gate for M0/M1 and delays the engine | Medium | Milestone slip | 00 §8 places it at M2; prototype cannot be cited as evidence or gate work |
| R17-13 | Autosave stores sensitive content or confuses projects | Low | Privacy/UX | Local IndexedDB only, keyed by project/scene, no session data, restore prompt |
| R17-14 | Component schemas duplicate subsystem truth | Medium | Two definitions drift | Schema is UI metadata only; `serialize`/`deserialize` delegate to the owning component's canonical form; unknown components preserved |

# 16 — Tooling and Profiler

**Status:** authoritative for the engine programme's developer tooling and profiling surface. Nothing in this spec is implemented in the current tree; every acceptance row in §7 is `PENDING` until the named run or fixture exists.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product/protocol contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) for programme rules, [`docs/engine/00-architecture.md`](00-architecture.md) for package boundaries and budgets. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded.
**Milestone:** M0 for the profiler core, overlay, budget evaluation, asset audit and capture/replay; M1 for GPU timer queries and heap accounting; M2 for the capture trend report. The editor (spec 17) and the benchmark/evidence system (spec 19) consume this spec but are owned elsewhere.

---

## 1. Goal

Make the engine's performance **visible, attributable and gateable** on every machine the programme claims to support.

The player-visible outcome: a game that holds 60 Hz on a desktop holds it on the target TV, and when it does not, a developer can say which phase of which frame exceeded which budget without attaching a debugger. A stutter on a phone-controlled session is attributed to simulation, scene update, culling, game render, encoding, submission, UI, audio or streaming, not guessed at.

The engineering outcomes:

- one profiler that both the engine and a game can feed, with a stable field contract that screenshots, CI artifacts and `docs/RESULTS.md` rows can reference;
- budget values transcribed once from [`docs/BUDGETS.md`](../BUDGETS.md) and evaluated identically in the overlay, the CLI and CI;
- debug draws that make collision shapes, raycasts, light bounds, navigation and streaming cells visible without a game shipping its own line renderer;
- an asset audit that catches a missing file, a byte-count lie, an unsafe URL, an unsupported mesh attribute or a budget breach before boot;
- capture/replay of a real session (input plus frame samples) that reproduces the same build's behaviour for investigation and regression comparison;
- CI hooks that run without a GPU and a manual evidence path that never invents a number.

**Scope.** This spec defines the profiler, debug-draw batching, budget enforcement, asset audit, capture file and the dev-only CLIs. It does not define the benchmark fixtures, acceptance scenes, hardware matrix or evidence format; those belong to spec 19. It does not define budget values; those belong to `docs/BUDGETS.md` and the profile module named in spec 01.

---

## 2. Non-goals

- **Not a browser DevTools replacement.** The JS sampling profiler, network panel, memory heap snapshot and GPU command capture stay in DevTools, RenderDoc or vendor tools. This profiler records the engine's own phase timings, counters and frame statistics.
- **Not a GPU command replay tool.** It reads timestamps and counters; it does not capture or replay command buffers.
- **Not production telemetry.** No analytics, no upload, no persistence of player data, no session identifiers (SR-7). Everything is opt-in, local, and dev-build only.
- **Not a network inspector.** Broker `stats` already reports RTT, jitter, packets/s and drops; the overlay displays them but does not own them.
- **Not the editor.** Spec 17.
- **Not the benchmark or evidence system.** Spec 19 owns fixtures, result schemas, the hardware matrix and `docs/RESULTS.md`. This spec produces the capture and budget primitives 19 consumes.
- **Not a per-frame allocation source.** The steady-state profiler path allocates nothing; the 4 Hz DOM update is the only string-producing path.
- **Not available in production bundles.** `@lanpad/engine-tooling` is dynamically imported only in dev (`D8` in 00 §5.2); the production host must not contain it.
- **No UA sniffing.** The browser name is display text only; capability decisions use feature detection (FR-12.1).
- **No third-party runtime dependency in the browser entry.** Node-side audit tooling may use dev-only packages listed in `packages/engine/tooling/package.json`, but they never reach a browser bundle.
- **No fabricated GPU timing.** If the backend and adapter do not expose timer queries, the report says `source: "none"` and `null` values. It never estimates a GPU number from CPU time.

---

## 3. Public interfaces

The package is `@lanpad/engine-tooling` (00 §3.7), dev-only. It has two entries:

| Entry | Runs in | May import | Must not import |
|---|---|---|---|
| `@lanpad/engine-tooling` (Node) | Node 20 CLI and tests | `engine-core`, `engine-assets` types, `sdk` types (D8) | DOM, renderer packages, runtime, protocol |
| `@lanpad/engine-tooling/browser` | dev browser overlay | `engine-core`, `engine-assets` types | Node built-ins, runtime, protocol |

Types below are normative in shape. `RendererBackend`, `EngineFeature`, `AssetKind` and `Vec3` are restated or imported from `engine-core`; the tooling package never invents a second definition of an engine type.

### 3.1 Profiler (browser entry)

```ts
export const PROFILER_FORMAT_VERSION = 1;

export type FramePhase =
  | "input" | "simulate" | "scene" | "cull" | "gameRender"
  | "ui" | "encode" | "submit" | "audio" | "streaming" | "other";

/** Fixed field object; reused every frame. Order is the capture array order. */
export interface PhaseTimes {
  input: number;
  simulate: number;
  scene: number;
  cull: number;
  gameRender: number;
  ui: number;
  encode: number;
  submit: number;
  audio: number;
  streaming: number;
  other: number;
}

export interface FrameSampleInput {
  readonly tick: number;          // host simulation tick
  readonly cpuMs: number;        // whole-frame CPU time, measured by the loop
  readonly phases: PhaseTimes;   // per-phase CPU time, milliseconds
  readonly drawCalls: number;
  readonly triangles: number;
  readonly textureBytes: number;
  readonly bufferBytes: number;
  readonly renderScale: number;  // 0.6 .. 1.0
}

export interface BudgetSet {
  readonly frameP95Ms: number;        // 14 by default (SPEC §11)
  readonly frameHardFailMs: number;   // 20 by default (SPEC §11, FR-9.5)
  readonly drawCalls: number;         // 120 (PR-9.1)
  readonly textureBytes: number;      // 128 MiB provisional (PR-9.2)
  readonly heapBytes: number | null;  // null when the browser exposes no heap API
}

export type BudgetViolationCode =
  | "frame-p95" | "frame-max" | "draw-calls" | "texture-bytes" | "heap";

export interface BudgetViolation {
  readonly code: BudgetViolationCode;
  readonly observed: number;
  readonly limit: number;
}

export interface GpuTiming {
  readonly supported: boolean;
  readonly source: "timestamp-query" | "ext-disjoint-timer" | "none";
  readonly passMs: {
    readonly p50: number | null;
    readonly p95: number | null;
    readonly max: number | null;
  };
}

export interface BuildIdentity {
  readonly engineVersion: string;   // ENGINE_VERSION
  readonly buildHash: string;       // CI build hash, 8..64 hex chars
  readonly gameId: string;          // game slug, "engine" for the demo
  readonly backend: "webgpu" | "webgl2" | "canvas2d";
  readonly browser: string;         // human display only, never a capability gate
  readonly adapter: string | null;  // GPU adapter name when the backend exposes it
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
}

export interface ProfilerReport {
  readonly formatVersion: 1;
  readonly frames: number;
  readonly frameMs: { readonly p50: number; readonly p95: number; readonly max: number; readonly mean: number };
  readonly phasesMs: Readonly<Record<FramePhase, { readonly p50: number; readonly p95: number }>>;
  readonly counters: Readonly<Record<string, number>>;
  readonly gpu: GpuTiming;
  readonly heapBytes: number | null;
  readonly violations: readonly BudgetViolation[];
  readonly build: BuildIdentity;
}

export interface ProfilerOptions {
  /** `null` runs headless: no DOM is touched (tests, CI, capture mode). */
  readonly mount: HTMLElement | null;
  readonly enabled: boolean;              // true only with ?debug=1
  readonly budgets: BudgetSet;
  readonly build: BuildIdentity;
  readonly capacity?: number;             // frame ring, default 600, max 1800
  readonly now?: () => number;            // injected in tests; performance.now otherwise
  readonly onCapture?: (capture: CaptureFile) => void;
}

export interface Profiler {
  readonly enabled: boolean;
  beginFrame(frameIndex: number): void;
  mark(phase: FramePhase, elapsedMs: number): void;
  endFrame(sample: FrameSampleInput): void;
  setCounter(name: string, value: number): void;
  capture(action: "start" | "stop" | "dump"): void;
  update(nowMs: number): void;            // DOM at 4 Hz; no-op when headless
  report(): ProfilerReport;               // allocates; never call per frame
  dispose(): void;                        // idempotent
}

export function createProfiler(options: ProfilerOptions): Profiler;

/** Pure budget evaluation; shared by overlay, CLI and tests. */
export function evaluateBudgets(report: ProfilerReport, budgets: BudgetSet): BudgetViolation[];

/** Nearest-rank percentile over a copied array; p in [0, 1]. */
export function percentile(values: ReadonlyArray<number>, p: number): number;
```

### 3.2 Debug draw (browser entry)

```ts
export type DebugColor = number; // 0xRRGGBBAA

export interface DebugDrawOptions {
  readonly enabled: boolean;
  readonly maxLines?: number;    // default 4096
  readonly maxBoxes?: number;    // default 1024
  readonly maxSpheres?: number;  // default 256
  readonly maxRays?: number;     // default 1024
  readonly maxTexts?: number;    // default 64
}

export interface DebugDraw {
  readonly enabled: boolean;
  line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: DebugColor): void;
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: DebugColor): void;
  sphere(cx: number, cy: number, cz: number, radius: number, color: DebugColor): void;
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, length: number, color: DebugColor): void;
  /** Dev-only; the caller supplies the string. At most 64 per frame. */
  text(x: number, y: number, z: number, text: string, color: DebugColor): void;
  /** Called by the renderer once per frame. Resets counts, keeps capacity. */
  flush(): void;
  readonly dropped: number; // capacity overflow counter, cumulative
}

export function createDebugDraw(options: DebugDrawOptions): DebugDraw;
```

`DebugDraw` is exposed to games through the additive `GameContext.debug.draw?` member owned by spec 18. Engine systems (physics, AI, streaming) receive the same sink internally. Drawing happens after the scene pass and before game UI, with depth testing off by default; a `depthTest: true` option may be added later without changing the method set.

### 3.3 Asset audit (Node entry)

```ts
export interface AssetAuditOptions {
  readonly gameRoot: string;          // absolute or cwd-relative game folder
  readonly manifestName?: string;     // default "asset-manifest.json"
  readonly strict?: boolean;          // warnings become failures in the CLI
  readonly checkHashes?: boolean;     // default true in dev
}

export interface AssetAuditEntry {
  readonly id: string;
  readonly kind: string;              // AssetKind from engine-assets
  readonly url: string;
  readonly declaredBytes: number;
  readonly actualBytes: number | null;
  readonly hashOk: boolean | null;
  readonly details: Readonly<Record<string, number | string | boolean | null>>;
}

export interface AuditIssue {
  readonly severity: "error" | "warning";
  readonly code: string;              // stable, see §4.3
  readonly assetId?: string;
  readonly path?: string;
  readonly message: string;
}

export interface AssetAuditReport {
  readonly formatVersion: 1;
  readonly kind: "engine-asset-audit";
  readonly gameId: string;
  readonly manifestPath: string;
  readonly generatedAtUnixMs: number;
  readonly engineVersion: string;
  readonly totals: {
    readonly assets: number;
    readonly declaredBytes: number;
    readonly actualBytes: number;
    readonly initialBytes: number;
    readonly totalBudgetBytes: number;
    readonly overBudget: boolean;
    readonly byKind: Readonly<Record<string, { readonly count: number; readonly bytes: number }>>;
  };
  readonly assets: readonly AssetAuditEntry[];
  readonly issues: readonly AuditIssue[];
  readonly status: "pass" | "warn" | "fail";
}

export function auditGameAssets(options: AssetAuditOptions): Promise<AssetAuditReport>;
```

### 3.4 Capture and replay (shared)

```ts
/** Input packet shape is exactly the 00 §5.8 replay packet. */
export interface CapturePacket {
  readonly tick: number;
  readonly slot: number;
  readonly buttons: number;
  readonly edges: number;
  readonly lx: number;
  readonly ly: number;
  readonly rx: number;
  readonly ry: number;
  readonly lt: number;
  readonly rt: number;
}

export interface CaptureFrame {
  readonly i: number;          // display frame, monotonic from 0
  readonly tick: number;
  readonly cpuMs: number;      // 2 decimal places
  readonly phases: readonly number[]; // 11 values, FramePhase order
  readonly drawCalls: number;
  readonly triangles: number;
  readonly textureBytes: number;
  readonly bufferBytes: number;
  readonly renderScale: number;
}

export interface CaptureFile {
  readonly formatVersion: 1;
  readonly kind: "engine-profile-capture";
  readonly engineVersion: string;
  readonly buildHash: string;
  readonly gameId: string;
  readonly seed: number;
  readonly startedAtUnixMs: number;
  readonly build: BuildIdentity;
  readonly frames: readonly CaptureFrame[];
  readonly input: readonly CapturePacket[];
  readonly counters: Readonly<Record<string, number>>;
}

export function encodeCapture(capture: CaptureFile): Uint8Array;
export function decodeCapture(bytes: Uint8Array): CaptureFile; // throws ToolingError("E_TOOLING_FORMAT")
export function reportFromCapture(capture: CaptureFile, budgets: BudgetSet): ProfilerReport;
export function formatReportMarkdown(report: ProfilerReport): string;
```

### 3.5 Errors

Tooling failures use a dev-only error type, not the engine runtime taxonomy:

```ts
export type ToolingErrorCode =
  | "E_TOOLING_FORMAT"      // capture/audit JSON is malformed or a newer version
  | "E_TOOLING_CAPTURE"     // capture limits exceeded
  | "E_TOOLING_AUDIT"       // the audit could not read the game folder
  | "E_TOOLING_BUDGET";     // budget input is invalid
export class ToolingError extends Error {
  readonly code: ToolingErrorCode;
}
```

`E_TOOLING_*` never appears in a production error path; it is thrown in dev/CLI only.

### 3.6 CLI contract

Thin CLIs live under `tools/` and contain no logic beyond argument parsing:

```bash
node tools/engine-cli/dist/cli.js audit --game platformer [--json audit.json] [--strict]
node tools/engine-cli/dist/cli.js profile-report --capture capture.json \
  [--baseline baseline.json] [--factor 1.10] [--fail-on-budget] [--out report.md]
node tools/engine-cli/dist/cli.js capture-validate --capture capture.json
```

| Exit | Meaning |
|---|---|
| 0 | pass (warnings allowed unless `--strict`) |
| 1 | warnings treated as failure (`--strict`) or a budget regression |
| 2 | audit errors or invalid capture |
| 3 | tool failure (I/O, unreadable root) |

The CLI is offline, deterministic, and never reads a URL, token or live room. `--json` writes the serialized report; stdout remains a human summary.

### 3.7 Automation surface

Only in dev builds:

| Global | Enabled by | Shape |
|---|---|---|
| `window.__ENGINE_PROFILE__` | `?debug=1&profiler=1` | `{ report(): ProfilerReport; capture: "start" \| "stop" \| "dump" }` |
| `window.__ENGINE_CAPTURE__` | `?capture=1` | the last `CaptureFile` object, read-only |
| `window.__ENGINE_BENCH__` | spec 19 | owned by 19; the profiler does not write it |

The globals are deleted and the whole module is absent from production bundles. The overlay's toggle key `D` and the `?debug=1` gate are preserved from the existing runtime overlay contract.

---

## 4. Data formats

### 4.1 Profiler capture (`engine-profile-capture`, `PROFILER_FORMAT_VERSION = 1`)

UTF-8 JSON, one object per file.

| Field | Rule |
|---|---|
| `formatVersion` | exactly `1`; an unknown value is refused with `E_TOOLING_FORMAT` |
| `kind` | exactly `"engine-profile-capture"` |
| `engineVersion` | `ENGINE_VERSION` at capture time, semver |
| `buildHash` | 8..64 hex characters; required for replay comparison |
| `gameId` | game slug matching `^[a-z0-9][a-z0-9-]{0,63}$` or `"engine"` |
| `seed` | u32; the game seed used by the run |
| `startedAtUnixMs` | capture wall-clock start; never used for simulation |
| `build` | `BuildIdentity` from §3.1 |
| `frames` | 1..18,000; `i` strictly increasing from 0; `tick` u32 |
| `input` | 0..100,000 packets, sorted by `tick` then `slot`; slot 1..8 |
| `counters` | ≤ 256 entries; names `^[a-z][a-z0-9_.-]{0,63}$`; finite numbers |

Rules:

- Serialized size **≤ 5 MiB**. A larger capture is truncated by dropping the oldest frames and is marked `truncated: true` by the writer (the field is optional and additive).
- Floats are written with at most two decimal places for milliseconds and three for axes; `NaN` and `Infinity` are replaced by `null` and fail validation.
- The file contains no room code, PIN, token, player name, IP address or URL with credentials. `browser` is a display string; `adapter` is a GPU model string.
- Unknown fields are ignored on read; unknown `formatVersion` is refused.
- The input packet shape is the 00 §5.8 replay format. A replay on a different `buildHash` is refused by default; `--allow-build-mismatch` is an investigation flag and marks the report `non-reproducible`.
- A capture is a **test/dev artifact**, not a wire format. It never travels over the broker.

### 4.2 Budget source

There is no second budget file. The profiler receives a `BudgetSet` assembled from the generated profile module owned by spec 01 (`packages/engine/core/src/profile/budgets.ts`), which is drift-tested against [`docs/BUDGETS.md`](../BUDGETS.md). Defaults:

| Field | Value | Source |
|---|---:|---|
| `frameP95Ms` | 14 | SPEC §11 |
| `frameHardFailMs` | 20 | SPEC §11; FR-9.5 slow-frame threshold |
| `drawCalls` | 120 | PR-9.1 |
| `textureBytes` | 134,217,728 (128 MiB) | PR-9.2, provisional |
| `heapBytes` | `null` until E2 on a real TV | PR-11.2 |

A CLI invocation that supplies a different budget set must name the source file in its report; ad-hoc numbers are allowed for investigation but are never evidence.

### 4.3 Asset audit (`engine-asset-audit`, formatVersion 1)

UTF-8 JSON. `status` is `fail` if any issue is an error; `warn` if only warnings; `pass` otherwise.

Stable issue codes:

| Code | Severity | Detects |
|---|---|---|
| `MANIFEST_SCHEMA` | error | manifest fails the engine-assets validator |
| `MANIFEST_URL` | error | scheme, host, `//`, `..`, query, fragment or absolute path in `url` |
| `ASSET_MISSING` | error | file does not exist under the game root |
| `ASSET_UNREADABLE` | error | permission or I/O failure |
| `ASSET_SIZE_MISMATCH` | error | `actualBytes !== declaredBytes` |
| `ASSET_HASH_MISMATCH` | error | dev hash differs (`checkHashes`) |
| `PATH_TRAVERSAL` | error | resolved path escapes the game root |
| `PATH_CASE_COLLISION` | error | two asset URLs differ only by case |
| `BUDGET_EXCEEDED` | error | initial or total declared bytes exceed the manifest budget |
| `GLB_INVALID` | error | GLB magic/version/chunk layout is malformed |
| `GLB_UNSUPPORTED` | warning | sparse accessor, missing required attribute, unsupported primitive |
| `TEXTURE_INVALID` | error | KTX2/WebP header cannot be parsed |
| `AUDIO_INVALID` | warning | container header cannot be parsed |
| `ASSET_UNREFERENCED` | warning | file exists under `assets/` but no manifest entry names it |
| `ASSET_DUPLICATE_HASH` | warning | two ids ship identical bytes |
| `ASSET_LARGE` | warning | a single asset exceeds 1 MiB (boot-time risk, not a hard cap) |

Rules:

- The audit reads file bytes but never executes or decodes them into a renderer; GLB/KTX2/audio checks are header-level and, where a dev-only parser exists, structural.
- The walker follows no symlinks, is case-sensitive in its comparison, and rejects any resolved path outside `gameRoot`.
- `actualBytes` comes from `stat`; a mismatch is an error, not a warning.
- The report is deterministic for the same tree: entries sorted by `id`, issues by `(severity, code, assetId, path)`.
- The report contains game ids and relative paths only; no absolute user paths (redact the prefix).

### 4.4 Overlay field contract

Field labels are stable for screenshots and Gate evidence. Values are written with `textContent` into nodes created once. `—` means unavailable, never zero.

| Row | Contents | Update |
|---|---|---|
| Build | `engineVersion`, `gameId`, `backend` | on mount/change |
| Frame | FPS, frame ms mean/p50/p95 over the ring, tick | 4 Hz |
| Phase | simulate, scene, cull, gameRender, encode, submit (ms, p95) | 4 Hz |
| GPU | pass p50/p95 and source, or `— (no timer)` | 4 Hz |
| Draw | draw calls and budget, triangles | 4 Hz |
| Memory | texture MB / budget, buffer MB, JS heap MB when available | 4 Hz |
| Resolution | CSS size, DPR, render scale | 4 Hz |
| Counters | game counters from `ctx.debug.setCounter` | 4 Hz |
| Slots | per-slot input age, packets/s, RTT, jitter, drops (broker stats) | 4 Hz |
| Budget | one line per active violation, or `budgets ok` | 4 Hz |

The overlay is hidden by default, shown only with `?debug=1`, and toggled by `D`. While hidden, `recordFrame` returns before any ring write; while visible it only writes numbers into the preallocated ring. The DOM update is the only allocating path and is throttled to 4 Hz.

---

## 5. Architecture

### 5.1 Package layout

```
packages/engine/tooling/
  package.json                 (created by 16; integration edits later)
  src/
    shared/
      stats.ts                 percentile, mean, ring statistics
      schema.ts                capture/audit validation helpers
      errors.ts                ToolingError
    profile/
      budgets.ts               BudgetSet defaults + evaluateBudgets
      profiler.ts              createProfiler, ring, counters
      capture.ts               capture ring, encode/decode, reportFromCapture
    browser/
      overlay.ts               DOM overlay (4 Hz)
      overlay.css              external stylesheet, CSP-safe
      debugDraw.ts             line/box/sphere/ray/text batching
      profileEntry.ts          dynamic dev entry; exports window.__ENGINE_PROFILE__
    node/
      audit/
        manifest.ts            read + validate game asset manifest
        walk.ts                contained, symlink-free file walk
        glb.ts                 header/structure checks (no renderer)
        ktx2.ts                header checks
        audio.ts               container header checks
        audit.ts               auditGameAssets
      report/
        markdown.ts            formatReportMarkdown
  test/
    profile/*.test.ts
    browser/*.test.ts          jsdom
    node/audit/*.test.ts
    node/report/*.test.ts
    fixtures/
      captures/*.json
      audits/*.json
      games/*/                 tiny synthetic game roots for audit
```

`tools/engine-cli/` contains only `src/cli.ts`, `src/commands/audit.ts` and `src/commands/profileReport.ts`; it imports the Node entry. Spec 19 owns `tools/engine-test/` and `packages/engine/tooling/src/node/bench/**`; spec 17 owns `packages/engine/tooling/src/editor/**`. Directory ownership is exclusive.

### 5.2 Frame flow

```
FixedLoop tick ──▶ simulate ──▶ Profiler.mark("simulate", ms)
Render frame ───▶ scene update/cull/encode/submit
                ──▶ Profiler.mark(...) per phase
                ──▶ GameHost calls game.render(alpha)
                ──▶ Profiler.endFrame({ tick, cpuMs, phases, stats... })
                ──▶ Profiler.update(now)   (4 Hz, DOM)
```

Rules:

- The loop and renderer call `mark` with measured deltas. The profiler never reads a clock inside `endFrame` to guess a phase.
- `endFrame` copies the fixed `PhaseTimes` object into the ring; the caller may reuse the object immediately.
- The runtime owns the ordering. The profiler does not wrap `game.simulate` itself and does not catch game errors.
- If a phase is unknown or unavailable, its value is `0` and the `other` phase carries the remainder of `cpuMs - sum(phases)` when that remainder is positive.
- GPU timestamps are resolved asynchronously (one to two frames behind). A late result is written into the ring slot for its frame index if it is still resident; otherwise it is dropped and counted. `endFrame` never waits on the GPU.

### 5.3 Overlay and production isolation

- `packages/runtime/src/main.ts` dynamically imports `@lanpad/engine-tooling/browser` only when `isDebugEnabled(location.search)` is true and the build is not production.
- The existing `packages/runtime/src/debug/Overlay.ts` is the migration source. After the browser overlay lands, the runtime file is deleted in the integration wave; both are never mounted at once.
- `packages/runtime/src/debug/inputTable.ts` stays in the runtime (protocol-specific debug) and is displayed as a separate panel, not inside the profiler.
- The production Vite build must not include the dynamic import. A build-graph test asserts that `@lanpad/engine-tooling` and its Node dependencies appear in zero production chunks.
- The overlay reads only numeric/display data and the broker's `stats`; it never reads storage, tokens, room codes or the URL beyond `debug`, `profiler` and `capture`.

### 5.4 Debug draws

- Batching: one growable `Float32Array` per primitive class (line, box edge, sphere ring, ray, text quad), preallocated at the configured capacity. `line` writes 2 vertices; `box` writes 12 edges (24 vertices); `sphere` writes 3 great circles (default 96 vertices); `ray` is one line with an arrowhead; `text` uses the existing bitmap/SDF atlas from spec 13 when it exists, otherwise a dev-only 5×7 bitmap in the tooling package.
- Submission: at most 4 draw calls per frame (lines, boxes, spheres, text), one pipeline/material, and no per-primitive bind group. Colors are packed attributes.
- Capacity overflow increments `dropped` and discards the primitive. The first drop in a frame writes one console warning in dev; subsequent drops are silent.
- The buffer is uploaded once per frame only when at least one primitive exists. An empty frame performs no upload and no draw call.
- Depth test is off by default; `depthTest` is a creation option, not a per-primitive flag.
- Text is capped at 64 strings per frame; each string is copied into a preallocated character buffer so the render path itself does not allocate beyond the caller's string.

### 5.5 GPU timing

| Backend/feature | Source | Rule |
|---|---|---|
| WebGPU + `timestamp-query` | `timestamp-query` | Timestamp writes around the scene and debug passes; resolve after submit; read at most one frame later. |
| WebGL2 + `EXT_disjoint_timer_query_webgl2` | `ext-disjoint-timer` | One query object per frame from a small pool; `GPU_DISJOINT_EXT` invalidates the sample. |
| Anything else | `none` | `supported: false`, all values `null`. |

The profiler never sums unrelated passes into a misleading "GPU time" without labeling it. If only one pass is timed, the report says so in `counters["gpu.pass"]` (the pass name). Timestamps are in milliseconds with two decimals.

### 5.6 Heap accounting

- Chromium exposes `performance.memory.usedJSHeapSize`; the profiler samples it at 4 Hz and reports bytes. It is non-standard and labeled `heap.source = "performance.memory"` in `counters`.
- Firefox/Safari expose no equivalent; `heapBytes` is `null` and the overlay shows `—`.
- The profiler never forces `gc()` and never treats a heap number as a leak proof. Leak proof is the allocation benchmark in spec 19 (heap growth over a fixed frame window).
- The steady-state profiler writes no strings; counter names are interned at registration (first `setCounter` for a name allocates the key, later calls do not).

### 5.7 Asset audit pipeline

1. Read `asset-manifest.json`; validate `formatVersion`, ids, URLs, budgets and counts with the engine-assets validator.
2. Resolve each URL against the game root; reject `..`, absolute paths, symlinks and case collisions before touching the file.
3. `stat` each file; compare `bytes`; optionally hash (FNV-1a 32) and compare.
4. Parse headers by kind: GLB chunk layout and accessor attributes; KTX2 header and level count; WebP/PNG dimensions; Ogg/WebM/Opus container magic; WOFF2 signature.
5. Sum declared and actual bytes; compare to the manifest budget.
6. Scan `assets/` for unreferenced files and duplicate hashes (warnings).
7. Emit a deterministic report; the CLI maps errors/warnings/strictness to the exit code.

The audit does not import the renderer, create a GPU device, decode pixels/audio, or execute game code. It must run on a CI runner with no GPU.

### 5.8 Capture and replay

- The capture ring stores every input packet the host applied (post-broker, pre-mapper is preferred so the replay exercises the mapper) and every frame sample. Capacity defaults: 18,000 frames or 100,000 packets, whichever limit is reached first.
- `capture.start` clears the ring and records `seed` and `build`. `capture.stop` freezes it. `capture.dump` encodes, validates and hands the file to `onCapture` (download in dev).
- `reportFromCapture` computes the same statistics as a live report without a renderer. It is the CLI path: offline, deterministic, no browser.
- Replay: the dev host accepts `?replay=<same-origin-url>`; the runtime feeds the captured packets at their ticks, uses the captured seed, and exposes the resulting report through `window.__ENGINE_PROFILE__`. A build-hash mismatch is refused unless explicitly allowed. Replay compares frame statistics and, when the game publishes one, a state hash; it never writes a save or touches the network.
- Capture files are attachments to a bug report or CI artifact, not committed to the repository except as a small golden fixture (≤ 256 KiB).

### 5.9 CI hooks

| Hook | Where | What it proves | Hardware-free |
|---|---|---|---|
| `npm test -- --project packages/engine/tooling` | `npm run check` | percentile/budget math, capture schema, audit rules, overlay snapshots | yes |
| `engine-cli audit --game <slug>` | tool tests and a root script used by the integration wave | every bundled game's assets are complete and within budget | yes |
| `engine-cli capture-validate` | CI artifact validation | a recorded capture is well-formed and within limits | yes |
| `engine-cli profile-report --fail-on-budget` | nightly/manual | a capture meets the current budgets; a regression fails the run | yes (offline) |
| bundle isolation test | `npm run check` | tooling is absent from production bundles | yes |

The root gate stays `npm run check`. Spec 19 owns the benchmark jobs; this spec supplies the audit and report commands they call.

---

## 6. File ownership

One writer per file. The package skeleton and export map are created by 16 in M0; 17 and 19 add only their own directories in later waves. Integration-owned files (`package.json`, `tsconfig.json`, root Vitest config, `eslint.config.js`) are edited by the integration agent in the same wave, not by a feature agent.

| Path | Owner | Contents |
|---|---|---|
| `docs/engine/16-tooling-profiler.md` | 16 | This spec |
| `packages/engine/tooling/package.json` | 16 (M0) | Name, exports `.` and `./browser`, dev-only deps |
| `packages/engine/tooling/tsconfig.json`, `vite.config.ts` | 16 (M0) | Build of the browser entry |
| `packages/engine/tooling/src/shared/**` | 16 | Stats, schema, errors |
| `packages/engine/tooling/src/profile/**` | 16 | Profiler, budgets, capture |
| `packages/engine/tooling/src/browser/overlay.ts`, `overlay.css`, `debugDraw.ts`, `profileEntry.ts` | 16 | Overlay and debug draws |
| `packages/engine/tooling/src/node/audit/**` | 16 | Asset audit |
| `packages/engine/tooling/src/node/report/**` | 16 | Markdown report |
| `packages/engine/tooling/test/profile/**`, `test/browser/**`, `test/node/audit/**`, `test/node/report/**` | 16 | Tests and fixtures |
| `tools/engine-cli/**` | 16 | `audit`, `profile-report`, `capture-validate` commands |
| `packages/engine/tooling/src/node/bench/**`, `src/browser/bench/**` | 19 | Benchmark runner (not this spec) |
| `packages/engine/tooling/src/editor/**` | 17 | Editor (not this spec) |
| `packages/runtime/src/debug/Overlay.ts` | integration agent | Deleted after the browser overlay lands; 16 never edits it |
| `packages/runtime/src/debug/inputTable.ts` | existing owner | Unchanged |
| `experiments/e-m0-engine/**` | 19 | Hosts the profiler mount; 16 does not edit the page |
| `docs/BUDGETS.md` | 19 with 00/01 | Budget values; 16 only reads them |

The existing `tools/size-budget`, `tools/trace-check`, `tools/input-bot` and `tools/latency-harness` keep their current owners. 16 adds no command to them.

---

## 7. Acceptance

Every row is `PENDING` until a build exists. A `PASS` requires the recorded build hash, device id from [`docs/DEVICES.md`](../DEVICES.md), browser version, date and numbers in [`docs/RESULTS.md`](../RESULTS.md). `ER-16-*` ids must be registered in [`docs/todos/TRACEABILITY.md`](../todos/TRACEABILITY.md) when the engine programme is registered; see §9 for the trace-check grammar change.

| ID | Criterion | Fixture / method | Hardware | Evidence state |
|---|---|---|---|---|
| ER-16-01 | Overlay is absent without `?debug=1`, mounts with it, toggles with `D`, does no DOM work while hidden, and updates at exactly 4 Hz when visible | `packages/engine/tooling/test/browser/overlay.test.ts` (jsdom, injected clock) | CI Node 20 + jsdom | PENDING — implementation |
| ER-16-02 | Profiler overhead: disabled ≤ **0.1 ms** and enabled ≤ **0.3 ms** CPU per frame, measured over 600 frames after 120 warm-up on the M0 scene | `experiments/e-m0-engine/?bench=1&profiler=1`, compare `frameMs` with profiler on/off in the same run | `pc-win11-rtx3050`, Chrome 155.0.8059.85, WebGL2 | PENDING — needs M0 scene and the desktop run |
| ER-16-03 | Profiler steady state allocates no per-frame objects: heap growth ≤ **512 KiB** over 480 measured frames after 120 warm-up with profiler enabled and overlay visible | `?bench=1&alloc=1&profiler=1`; `performance.memory` sampled after forced settle | `pc-win11-rtx3050`, Chrome 155 (heap API available) | PENDING — needs the desktop run; Chrome-only |
| ER-16-04 | `percentile` and `ProfilerReport` math match a checked-in fixture exactly for p50/p95/max/mean over 600 known samples | `packages/engine/tooling/test/fixtures/captures/stats-600.json` | CI Node 20 | PENDING — fixture authored with implementation |
| ER-16-05 | Budget evaluation flags exactly the configured breaches: 121 draw calls fails, 120 passes; 134,217,729 texture bytes fails, 134,217,728 passes; p95 14.01 fails the 14 ms target, max 20.01 fails the hard fail | Unit table in `packages/engine/tooling/test/profile/budgets.test.ts`; values read from the generated budget module and `docs/BUDGETS.md` | CI Node 20 | PENDING — implementation |
| ER-16-06 | Asset audit passes both bundled games with zero errors; a synthetic root with five seeded defects (missing file, size mismatch, unsafe URL, budget breach, malformed GLB) exits 2 and names each code | `tools/engine-cli audit --game platformer` and `... reaction-duel`; `packages/engine/tooling/test/fixtures/games/defects/` | CI Node 20 | PENDING — needs games' asset manifests |
| ER-16-07 | Capture round-trip is byte-stable for a 600-frame / 1,200-packet fixture and rejects a newer `formatVersion` with `E_TOOLING_FORMAT` | `packages/engine/tooling/test/fixtures/captures/roundtrip-600.json` | CI Node 20 | PENDING — fixture authored with implementation |
| ER-16-08 | A 600-frame / 1,200-packet capture of the M0 scene is ≤ **1 MiB** and replays with the same tick count and same input hash as the source run | `?capture=1` on the M0 scene; compare decoded packet hash with the live trace | `pc-win11-rtx3050`, Chrome 155, WebGL2 | PENDING — needs M0 scene |
| ER-16-09 | Debug draw submits 4,096 lines and 1,024 boxes with ≤ **4 draw calls**, adds ≤ **0.5 ms** CPU to the frame, and drops nothing at capacity | `packages/engine/tooling/test/browser/debugDraw.test.ts` (counts) + `?debug=1&debugDraw=stress` page | CI jsdom for counts; `pc-win11-rtx3050` Chrome 155 for cost | PENDING — cost row needs the desktop run |
| ER-16-10 | GPU timing reports `timestamp-query` only when the feature is present, `ext-disjoint-timer` only when the extension exists, and `none` with `null` values otherwise; a disjoint sample is discarded, not reported | Fake-device contract test + real WebGPU/WebGL2 page | CI (fake device); WebGPU row PENDING on `pc-win11-rtx3050` (WebGPU availability unmeasured) | PENDING — WebGPU row needs a device with `navigator.gpu` |
| ER-16-11 | No production build contains `@lanpad/engine-tooling` or any Node-only audit dependency; host gzip size is unchanged within **±1 KiB** after the dev-only import is added | Build-graph test in `packages/engine/tooling/test/browser/productionIsolation.test.ts` + `npm run size` | CI Node 20 | PENDING — implementation |
| ER-16-12 | The overlay is legible at 1080p from 3 m and its 4 Hz DOM update costs ≤ **2 ms** per update on the TV profile | Manual capture of the overlay at 1920×1080; Performance panel mark around `update()` | **PENDING device:** a 2020-era Android TV Chromium from SPEC §12; no TV exists in `docs/DEVICES.md` yet | PENDING — no TV hardware |
| ER-16-13 | `profile-report` over an 18,000-frame capture completes in ≤ **2 s** and ≤ **64 MiB** heap on CI, and writes a Markdown report with every field from §4.4 | `packages/engine/tooling/test/fixtures/captures/full-18000.json`, CLI run | CI Node 20 (ubuntu-latest) | PENDING — implementation |

Thresholds in this table are targets derived from SPEC §11 / PR-9.1–9.2 / 00 §7, not measurements. `docs/RESULTS.md` is the only place a number becomes evidence.

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | nearest-rank percentile, mean, ring wrap, counter interning, budget evaluation, capture limits, audit codes, redaction | `packages/engine/tooling/test/profile/*.test.ts`, `.../node/audit/*.test.ts` |
| Property (`fast-check`) | `p50 ≤ p95 ≤ max`, monotonic percentiles, capture encode → decode round-trip, capture packet ordering, audit determinism, budget evaluation idempotence | `packages/engine/tooling/test/**/*.property.test.ts` |
| Golden | overlay text snapshot for a fixed `FrameSample`; audit JSON for both bundled games; a 600-frame capture fixture; a report Markdown fixture | `packages/engine/tooling/test/fixtures/` |
| Contract | fake `RenderDevice` reports stats and features; profiler never invents GPU timing; debug-draw call/draw-count contract | `packages/engine/tooling/test/browser/contract.test.ts` |
| Integration | runtime mounts the overlay with `?debug=1`; production build excludes it; CLI runs over a real game folder; dev host replay accepts a capture | `packages/runtime/test/integration/debugOverlay.test.ts`, `tools/engine-cli/test/*.test.ts` |
| Browser | real WebGL2 page at `127.0.0.1:0`; profiler on/off; debug-draw stress; capture dump/replay | `experiments/e-m0-engine/` (spec 19 owns the page) |
| Manual | TV legibility and DOM cost; GPU timer availability; overlay screenshot for Gate evidence | `docs/RESULTS.md` rows |
| Meta | every `ER-16-*` row has a test or a named manual run; every fixture named in §7 exists; no row claims a number without a device | `tools/trace-check` with the ER grammar extension |

Test rules:

- Test titles carry `ER-16-*` or a leading `// @req ER-16-*`; the tag must resolve to a traceability row.
- Unit and property tests run in Node with no DOM. jsdom tests are confined to `test/browser/`.
- Integration tests bind `127.0.0.1:0`, wait on messages/events, and never mock the dev server.
- No test reads a live room, token or phone sensor. Captures use synthetic input packets.
- A performance test reports build hash, device id, browser version, backend, resolution, sample count and p50/p95/max. A number without those fields is not evidence.
- The profiler's own overhead test is comparative within one run (on/off), avoiding cross-machine variance.

---

## 9. Dependencies

| Dependency | Why | Status |
|---|---|---|
| `00-architecture.md` | Package boundary, `ENGINE_VERSION`, `EngineErrorCode`, budgets, D8 dev-only rule | Exists |
| `01-core-loop-time.md` | `FrameStats`, frame phases, the loop callback that calls the profiler, the generated budget module | written |
| `04-renderer-webgpu.md` | `RenderStats`, timestamp-query capability, pass structure | written |
| `05-renderer-webgl2.md` | `RenderStats`, `EXT_disjoint_timer_query_webgl2`, pass structure | written |
| `06-assets.md` | Asset manifest validator, `AssetKind`, GLB/KTX2/audio header rules used by the audit | written |
| `18-game-sdk.md` | Additive `GameContext.debug.draw?` and `renderer.capabilities?` | This wave |
| `19-testing-benchmarks.md` | Benchmark result schema, acceptance scenes, CI matrix; consumes captures | This wave |
| Existing `docs/BUDGETS.md` | Budget values and confidence | Exists |
| Existing `packages/runtime/src/debug/Overlay.ts` | Migration source (4 Hz DOM, `?debug=1`, `D` toggle) | Exists |
| `tools/size-budget`, `tools/trace-check` | Gate integration; trace grammar needs `ER-*` support | Exists; ER grammar change pending |

**Sequencing.** The profiler core and budget evaluator land with 01. Overlay and debug draw land after 04/05 expose frame stats and a pass boundary. The asset audit lands with 06 (or against fixture manifests before 06). Capture can land with 01 + 10. The CI report command lands with 19's runner. Nothing in M0 may depend on a real GPU; browser rows are manual evidence.

**Traceability prerequisite.** The current `tools/trace-check` ID grammar accepts `FR|NR|PR|SR|AR|TR-\d+(\.\d+)?` and bare `A|G|E|C`; it does not accept `ER-16-01`. Registering engine rows requires an additive regex change (`ER-\d+-\d+`) in `tools/trace-check/src/trace.ts` plus the corresponding `TRACEABILITY.md` rows. Spec 19 owns that tooling change; until it lands, ER rows are documentation-only and must not be counted as gate evidence.

**Amendment prerequisite.** 00 §1 records that `SPEC.md` v0.3 still names WebGPU as a non-goal (A14 pending). No profiler work depends on that amendment, but the profiler's WebGPU rows do.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R16-1 | The profiler itself distorts the frame it measures | Medium | Misleading evidence | Comparative on/off runs; disabled path returns immediately; ≤0.3 ms target; no allocation; profile only in dev |
| R16-2 | GPU timer queries are unavailable or unreliable on a target | High on WebGL2/TV | No GPU number | Report `none` and `null`; rely on CPU phase marks; never fabricate; timestamp-query is a capability, not a requirement |
| R16-3 | Overlay DOM work stutters a weak TV | Medium | Visible hitch while debugging | 4 Hz throttle, `textContent` on fixed nodes, hidden = zero work, ≤2 ms TV target, external CSS under CSP |
| R16-4 | Debug draws hide the real frame cost or overflow memory | Medium | False performance signal, memory spike | Fixed capacities, 4 draw calls, no per-primitive allocation, `dropped` counter, dev-only |
| R16-5 | Budget values drift between `docs/BUDGETS.md`, the generated module and the CLI | High without enforcement | Gate and overlay disagree | One generated module, drift test against `docs/BUDGETS.md`, `BudgetSet` injected rather than redefined |
| R16-6 | Asset audit gives false confidence (header-only checks) | Medium | Broken asset reaches runtime | Audit is a pre-boot check, not a decoder; runtime still enforces formats; errors vs warnings are explicit |
| R16-7 | Captures leak session data or grow unbounded | Medium | Security/size | No tokens/PII by construction, URL and room fields absent, 5 MiB cap, redacted paths, same-origin replay |
| R16-8 | Capture replay diverges from the live run | Medium | Wasted investigation | Per-build/browser determinism scope (00 §5.8); build-hash refusal; state hash when the game provides one; never claims cross-browser equality |
| R16-9 | Tooling leaks into production bundles | Medium | Size and security regression | D8 dynamic import, build-graph test, `npm run size` check, no static import from runtime |
| R16-10 | The package is split across 16/17/19 and agents collide | Medium | Corrupted work | Directory-level ownership in §6; one writer per file; 16 creates the skeleton first |
| R16-11 | ER-16 rows are not enforceable by the trace checker | Certain until tooling changes | Acceptance cannot be audited | 19 extends the grammar and registers rows; until then ER rows are explicitly documentation-only |
| R16-12 | The profiler becomes a de-facto requirements surface and slows engine work | Medium | Schedule | The interface is frozen after M0; new counters and phases are additive; the editor and benchmarks are separate specs |

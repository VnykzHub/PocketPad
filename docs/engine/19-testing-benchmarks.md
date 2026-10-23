# 19 — Testing and Benchmarks

**Status:** authoritative for the engine verification rig, benchmark runner, golden/replay/result formats and the evidence rows they produce. Only the W0 GPU-rig probe (`tools/gpu-rig/probe.js`) exists in the current tree; there is no runner, golden manifest, result schema or CI lane yet. Every acceptance row in §7 is `PENDING`.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product/protocol contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`docs/engine/README.md`](README.md) §7/§7.1 for the programme rules and verification rig, [`docs/engine/00-architecture.md`](00-architecture.md) for package boundaries, budgets, determinism scope and the replay fixture. Where this spec and `SPEC.md` disagree, `SPEC.md` wins until an amendment is recorded.
**Milestone:** W0 (rig skeleton and golden triangle), M0 (M0 scene goldens, determinism, bench, both backends), M1+ (one scene family per subsystem as it lands). The rig is a wave gate, not a one-time experiment.

---

## 1. Goal

Make parallel engine work **safe to land**: one verification rig that any agent can run against the same fixtures, in the same modes, with the same result schema, so a subsystem owner cannot silently break another subsystem's pixels, simulation, frame budget or backend contract.

The player-visible outcome is that the engine does not regress quietly. A wave that changes a shader, a scene layout, a physics step or a streaming budget either produces the same verified output or fails with a named fixture, a named mode and a diff artifact.

The engineering outcomes:

- **One rig, four modes.** Headless Chromium drives `webgpu`, `webgl2`, `software` (SwiftShader WebGL2) and `canvas2d` through one CLI and one result JSON.
- **Goldens with an explicit tolerance.** The renderer contract (§7.1 of the programme README) is only real when two implementations can be compared: a golden image plus a per-entry tolerance, not a prose claim.
- **Determinism with a replay file.** Fixed seed, recorded input, a state hash every N ticks, two isolated runs, and a seed-sensitivity check.
- **Budgets with a ceiling.** Frame-time and allocation measurements use the profiler counters owned by spec 16 and the budget values owned by `docs/BUDGETS.md`; spec 19 measures, it does not invent thresholds.
- **One conformance suite, two backends.** WebGPU and WebGL2 run the same case IDs against the same `RenderDevice` contract.
- **Evidence, not vibes.** Every number in `docs/RESULTS.md` comes from a recorded run with build hash, device, browser, mode, adapter and sample count. The rig writes artifacts a reviewer can inspect.
- **A rig that can fail a wave.** A seeded mismatch, a budget breach, a determinism divergence or a conformance failure exits non-zero and blocks the wave.

**Scope.** This spec defines the rig CLI, result/golden/replay/budget formats, the headless browser architecture, the conformance runner, CI wiring, artifacts and the `docs/RESULTS.md` evidence rules. It does not define the thresholds themselves (00/04/05/16 and `docs/BUDGETS.md` own those), the scenes' visual content (04/05 own the M0 scene parameters), or the profiler internals (16).

---

## 2. Non-goals

- **Not a replacement for Vitest.** Unit, property and fake-device tests stay in each package's `test/` and run under `npm test`. The rig adds browser-real and cross-backend checks.
- **Not Playwright or Puppeteer.** No browser-automation framework dependency. The rig uses the Chrome DevTools Protocol directly; see §5.4.
- **Not a profiler.** Frame phases, counters, capture files and GPU timing belong to spec 16. The rig consumes their output.
- **Not the asset audit CLI.** `engine-cli audit` (16) validates assets. The rig may run it in CI, but does not implement it.
- **Not a network/session harness.** The rig never joins a room, opens a broker socket or reads a token. Phone latency stays with `tools/latency-harness` and manual E5 runs.
- **Not phone or TV acceptance.** A headless browser on CI is not a TV. TV rows remain manual and `PENDING` until a person runs them on named hardware. A desktop software run never substitutes for a TV run.
- **Not cross-browser determinism.** Replays are valid per build and per browser (00 §5.8). The rig does not claim Firefox/Safari parity.
- **Not a general screenshot-diff service.** It compares engine golden frames from a declared scene, mode, tick, viewport and DPR. It does not diff arbitrary pages or marketing screenshots.
- **Not production code.** The rig is dev/CI-only, is not imported by `packages/runtime`, and creates no runtime dependency.
- **Not a threshold author.** A budget limit is copied from its owning spec or `docs/BUDGETS.md`; spec 19 never raises a limit to make a run pass.
- **Not the editor or its play-in-editor tests.** Spec 17.

---

## 3. Public interfaces

The package is `@lanpad/engine-test`, a workspace tool with one CLI entry. The CLI is the only supported interface for humans and CI; the TypeScript types below are the authority for the result files it writes.

### 3.1 CLI contract

```text
node tools/engine-test/dist/cli.js <command> [options]

Commands:
  verify            Run the named suite: golden checks, determinism, conformance and bench
  golden-verify     Compare captured frames against a golden manifest
  golden-update     Replace golden entries (explicit, reviewed, never in CI)
  determinism       Replay a recorded input trace twice and compare state hashes
  conformance       Run the shared RenderDevice conformance suite
  bench             Measure a scene and evaluate its budgets
```

| Option | Applies to | Type | Default | Meaning |
|---|---|---|---|---|
| `--suite <name>` | `verify` | string | required | Suite id from `tools/engine-test/suites/<name>.json` |
| `--scene <id>` | `verify`, `bench` | string | required for `bench` | Scene id from `experiments/e-m0-engine/scenes.json` |
| `--mode <mode>` | all | `webgpu\|webgl2\|software\|canvas2d` | required | Requested renderer mode, §5.3 |
| `--manifest <file>` | `golden-verify`, `golden-update` | path | required | Golden manifest, §4.1 |
| `--id <id>` | `golden-*` | string | all entries | One golden entry |
| `--replay <file>` | `determinism` | path | required | Replay file, §4.2 |
| `--driver <module>` | `determinism` | path | required for Node | Module exporting `createReplayDriver()` |
| `--runtime <kind>` | `determinism` | `node\|browser` | `node` | Where the simulation runs |
| `--runs <n>` | `determinism` | integer ≥ 2 | `2` | Isolated runs that must agree |
| `--hash-every <n>` | `determinism` | integer ≥ 1 | `10` | Ticks between state hashes |
| `--warmup <n>` | `bench` | integer ≥ 0 | `120` | Discarded frames |
| `--frames <n>` | `bench` | integer ≥ 1 | `600` | Measured frames |
| `--out <file>` | all | path | `artifacts/engine-test/<runId>/result.json` | Result JSON path |
| `--artifacts <dir>` | all | path | `artifacts/engine-test/<runId>` | Artifact root |
| `--json` | all | flag | off | Write the result object to stdout; human summary to stderr |
| `--headful` | all | flag | off | Show the browser (debug only; never in CI) |
| `--allow-fallback` | all | flag | off | Permit a requested mode to run on another backend; records `fallback: true`. A requested gate check still fails |
| `--timeout-ms <n>` | all | integer | `120000` | Whole-run watchdog, not a sleep |
| `--retries <n>` | all | integer | `0` | Infrastructure retries only, max `1`; see §8 |
| `--reason <text>` | `golden-update` | string | required | Why the golden changed; recorded in the manifest and the run log |
| `--confirm` | `golden-update` | flag | off | Required; without it the command refuses |
| `--help` | — | flag | — | Usage; exit 0 |

Rules:

- `<mode>` is a **request**, not a guarantee. The result records both `requestedMode` and the actual `backend`. A mismatch is a `fail` unless `--allow-fallback` was passed, and a golden, bench, determinism or conformance check against a mismatched backend always fails: the manifest entry names the mode it was captured in.
- `golden-update` refuses when `CI` is set to a non-empty value, requires `--confirm` and `--reason`, writes the manifest and PNG atomically (temp file then rename), and records `capturedAt`, `buildHash` and the reason. It never runs as part of `verify`.
- `verify` runs every check named by the suite in the declared order and stops at the first `error` (exit 3) but continues after an acceptance `fail` so the result lists every failed check.
- Every path is resolved relative to the repository root; a path outside the root is a usage error (exit 2). The static server also enforces containment.
- The CLI never reads a URL, token, room code or phone. It serves files from loopback and launches a browser; it performs no other network access.

### 3.2 Result types (normative shape)

```ts
export type EngineTestMode = "webgpu" | "webgl2" | "software" | "canvas2d";
export type EngineTestCommand =
  | "verify" | "golden-verify" | "golden-update"
  | "determinism" | "conformance" | "bench";
export type ExitCode = 0 | 1 | 2 | 3;

export interface Percentiles {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

export interface BuildIdentity {
  readonly engineVersion: string;   // ENGINE_VERSION
  readonly buildHash: string;       // 8..64 lowercase hex
  readonly dirty: boolean;          // working tree had uncommitted changes
  readonly gameId: string;          // slug or "engine" for the M0 demo
  readonly sceneId: string;
}

export interface AdapterInfo {
  readonly api: "webgpu" | "webgl2";
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly isFallbackAdapter: boolean | null;
}

export interface Viewport {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
}

export interface RunEnvironment {
  readonly browser: string;         // "Chrome 155.0.8059.85"
  readonly headless: boolean;
  readonly viewport: Viewport;
  readonly adapter: AdapterInfo | null;
  readonly deviceId: string | null; // docs/DEVICES.md id; null on CI
}

export interface GpuTiming {
  readonly source: "timestamp-query" | "ext-disjoint-timer" | "none";
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

export interface HeapSample {
  readonly source: "performance.memory";
  readonly startBytes: number;
  readonly endBytes: number;
  readonly growthBytes: number;     // endBytes - startBytes
  readonly frames: number;
}

export interface BenchSample {
  readonly sceneId: string;
  readonly warmupFrames: number;
  readonly measuredFrames: number;
  readonly frameMs: Percentiles;
  readonly cpuMs: Percentiles | null;
  readonly gpuMs: GpuTiming;
  readonly drawCalls: Percentiles;
  readonly triangles: number;       // maximum over measured frames
  readonly textureBytes: number;    // last measured frame
  readonly bufferBytes: number;     // last measured frame
  readonly renderScale: number;     // 0.6 .. 1.0
  readonly heap: HeapSample | null; // null when the browser exposes no heap API
}

export interface GoldenTolerance {
  readonly maxChannelDelta: number;      // 0..255
  readonly maxMismatchFraction: number;  // 0..1
}

export interface DiffMetrics {
  readonly totalPixels: number;
  readonly mismatchPixels: number;
  readonly mismatchFraction: number;
  readonly maxChannelDelta: number;
  readonly meanAbsError: number;
  readonly firstMismatch: { readonly x: number; readonly y: number } | null;
}

export interface GoldenComparison {
  readonly goldenId: string;
  readonly file: string;                 // relative to the manifest directory
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly width: number;
  readonly height: number;
  readonly tolerance: GoldenTolerance;
  readonly diff: DiffMetrics;
  readonly pass: boolean;
}

export interface DeterminismResult {
  readonly replayId: string;
  readonly seed: number;
  readonly ticks: number;
  readonly hashEvery: number;
  readonly runs: number;
  readonly hashesPerRun: number;
  readonly equal: boolean;
  readonly stateHash: string;            // "fnv1a32:xxxxxxxx" from run 1
  readonly firstMismatchTick: number | null;
  readonly seedSensitivity: boolean;     // a seed+1 run produced a different hash
}

export interface ConformanceCaseFailure {
  readonly id: string;
  readonly message: string;
}

export interface ConformanceSummary {
  readonly suiteId: string;
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failures: readonly ConformanceCaseFailure[];
  readonly pass: boolean;
}

export interface BudgetCheck {
  readonly id: string;       // "frame-p95" | "draw-calls" | "texture-bytes" | "heap-growth"
  readonly observed: number;
  readonly limit: number;
  readonly unit: "ms" | "count" | "bytes";
  readonly pass: boolean;
}

export interface ArtifactPaths {
  readonly resultJson: string;
  readonly screenshotPng: string | null;
  readonly goldenActualPng: string | null;
  readonly goldenDiffPng: string | null;
  readonly log: string;
}

export type RunErrorCode =
  | "E_RIG_USAGE" | "E_RIG_CHROME" | "E_RIG_CDP" | "E_RIG_TIMEOUT"
  | "E_RIG_PAGE" | "E_RIG_RESULT" | "E_RIG_GOLDEN" | "E_RIG_IO"
  | "E_RIG_UNSUPPORTED";

export interface RunError {
  readonly code: RunErrorCode;
  readonly message: string;
}

export interface RunResult {
  readonly formatVersion: 1;
  readonly kind: "engine-bench-result";
  readonly runId: string;                 // UUID v4
  readonly command: EngineTestCommand;
  readonly status: "pass" | "fail" | "error" | "skipped";
  readonly exitCode: ExitCode;
  readonly startedAt: string;             // ISO 8601 UTC, e.g. "2026-10-22T00:00:00.000Z"
  readonly durationMs: number;
  readonly requestedMode: EngineTestMode;
  readonly backend: "webgpu" | "webgl2" | "canvas2d" | "none";
  readonly fallback: boolean;
  readonly build: BuildIdentity;
  readonly environment: RunEnvironment;
  readonly bench: BenchSample | null;
  readonly golden: GoldenComparison | null;
  readonly determinism: DeterminismResult | null;
  readonly conformance: ConformanceSummary | null;
  readonly budgets: readonly BudgetCheck[];
  readonly artifacts: ArtifactPaths;
  readonly errors: readonly RunError[];
  readonly warnings: readonly string[];
}
```

Rules:

- `formatVersion` is exactly `1`. A reader refuses any other value with `E_RIG_RESULT` (exit 2). Unknown fields are ignored; new optional fields do not bump the version.
- `status` is `pass` only when every requested check passed and no `errors` entry exists. `skipped` is used only for optional measurements that the environment cannot provide (heap API, GPU timer); a required check that cannot run is `fail` with `E_RIG_UNSUPPORTED`, never `skipped`.
- `exitCode` must equal the process exit code (§3.5). A result with `status: "pass"` and a non-zero exit is invalid.
- Numbers are finite. `null` means "not measured", never zero. Percentiles use the nearest-rank definition owned by spec 16 (`percentile`); the rig imports it rather than reimplementing it.
- `stateHash` is `fnv1a32:` plus eight lowercase hex digits, matching the asset-hash convention in 00 §3.3.
- JSON size limit is 1 MiB. The result contains no token, PIN, room code, player name, IP address, absolute user path or URL with credentials. `browser` and `adapter` are display strings, not capability gates.

### 3.3 Replay driver (test-only interface)

A determinism run needs a simulation the rig can step without a renderer. The driver is supplied by the fixture owner; the rig owns the stepping, hashing and comparison.

```ts
export interface ReplayPacket {
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

export interface ReplayDriver {
  init(seed: number): void;
  /** One fixed tick. `null` means no packet changed on this tick. */
  step(packet: ReplayPacket | null): void;
  /** Writes canonical state bytes into `out`; returns the byte length. */
  stateBytes(out: Uint8Array): number;
  dispose(): void;
}

export interface ReplayDriverModule {
  createReplayDriver(): ReplayDriver;
}
```

Rules:

- `stateBytes` must be deterministic and complete for the state the fixture claims to verify. It writes into a caller-owned buffer; the driver must not allocate per tick.
- The M0 driver serializes, in dense entity order: tick, RNG state, and each live entity's position/rotation/scale as little-endian `f64`, followed by any game counters the fixture declares. The fixture documents its own state coverage in `experiments/e-m0-engine/replay/README.md`; a hash that omits gameplay-relevant state is a fixture bug.
- The browser runtime uses the same interface through the page global in §3.4; the driver module is loaded by the page, not by the Node runner.
- `step(null)` must advance exactly one tick and apply no input. The rig never calls `step` more than `ticks` times.
- No driver may read `Date.now`, `performance.now`, `Math.random` or the network. The rig cannot enforce this from outside; the determinism test plus review does (00 §5.8).

### 3.4 Page automation surface

Only the rig page and the M0 page may set these globals. They are dev/test-only and must be absent from production bundles.

| Global | Shape | Owner |
|---|---|---|
| `window.__GPU_RIG__` | `{ backend, hash, drawCalls, width, height, error, requestedBackend, stable, backendInfo, fallbackReason }` | 19 (existing W0 probe) |
| `window.__M0_BENCH__` | `{ state: "running" \| "done" \| "error", sample?: BenchSample, error?: string }` | 19 |
| `window.__ENGINE_REPLAY__` | `{ state, result?: DeterminismResult, error?: string }` | 19 |
| `window.__ENGINE_CONFORMANCE__` | `{ state, report?: ConformanceSummary, error?: string }` | 19 |
| `window.__ENGINE_PROFILE__`, `window.__ENGINE_CAPTURE__` | see 16 §3.7 | 16 |

The runner registers a CDP binding named `__engineTest` and the page calls `window.__engineTest(JSON.stringify({ command, payload }))` exactly once when the run finishes or errors. The runner waits on the binding event, not on a poll interval and not on a fixed sleep. A watchdog timer bounds the whole run; when it fires the run is `error` with `E_RIG_TIMEOUT`, the browser is killed, and the artifact log records the last page state.

### 3.5 Exit codes

| Exit | Meaning | Examples |
|---:|---|---|
| **0** | Every requested check passed; result valid | Golden matches, budgets satisfied, hashes equal, all conformance cases pass |
| **1** | Acceptance failure | Golden mismatch, budget breach, determinism divergence, conformance failure, requested mode unavailable |
| **2** | Usage, configuration, schema or I/O error | Unknown flag, missing fixture, bad manifest, unknown `formatVersion`, path outside root |
| **3** | Browser or infrastructure failure | Chrome not found, launch failed, CDP disconnect, page crash, watchdog timeout |

The mapping is exhaustive. A missing result file is exit 3, never 0. A check that is required but cannot run is exit 1 with `E_RIG_UNSUPPORTED`. A retry that succeeds after an infrastructure error exits 0 but sets `warnings` and records `retried` in the log; a retried acceptance failure is still exit 1.

### 3.6 Suite files

```ts
export interface SuiteCheck {
  readonly kind: "golden" | "determinism" | "conformance" | "bench";
  readonly id: string;          // golden id, replay id, conformance suite id or scene id
  readonly required: boolean;   // required checks fail the run; optional checks warn
}

export interface SuiteFile {
  readonly formatVersion: 1;
  readonly kind: "engine-test-suite";
  readonly id: string;          // "m0", "renderer", "physics"
  readonly checks: readonly SuiteCheck[];
}
```

A suite is data, not code. `verify --suite m0` expands to its checks and runs them in order. A required check that names a missing fixture is exit 2. The M0 suite is authored once the M0 scene and replay fixtures exist; it is not fabricated here.

---

## 4. Data formats

All formats are UTF-8 JSON unless stated otherwise. Every persisted format carries an integer `formatVersion`; readers accept only the current version unless a migration is explicitly named. Dates written by the rig are ISO 8601 UTC (`startedAt`) or calendar dates (`capturedAt`, `YYYY-MM-DD`). Examples in this section are **synthetic**, not measurements.

### 4.1 Golden manifest (`engine-golden-manifest`, `GOLDEN_MANIFEST_VERSION = 1`)

One manifest per suite, stored beside its PNGs. The M0 manifest lives at `experiments/e-m0-engine/golden/goldens.manifest.json`.

```json
{
  "formatVersion": 1,
  "kind": "engine-golden-manifest",
  "suite": "m0",
  "engineVersion": "0.1.0",
  "entries": [
    {
      "id": "scene5000-webgpu-tick300",
      "scene": "scene5000",
      "mode": "webgpu",
      "width": 1920,
      "height": 1080,
      "dpr": 1,
      "tick": 300,
      "file": "scene5000-webgpu-tick300.png",
      "sha256": "<64 lowercase hex characters>",
      "tolerance": { "maxChannelDelta": 8, "maxMismatchFraction": 0.02 },
      "capturedAt": "YYYY-MM-DD",
      "deviceId": "<docs/DEVICES.md id>",
      "browser": "<browser name and version>",
      "adapter": "<GPU adapter or software rasterizer>",
      "reason": "<why this golden exists>"
    }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `formatVersion` | integer | Exactly `1`; any other value is `E_RIG_GOLDEN` (exit 2) |
| `kind` | string | Exactly `"engine-golden-manifest"` |
| `suite` | string | Matches `^[a-z0-9][a-z0-9-]{0,31}$` |
| `engineVersion` | string | Semver recorded when the manifest was last written |
| `entries` | array | 1..512 entries; ids unique |
| `entries[].id` | string | `^[a-z0-9][a-z0-9-]{0,63}$` |
| `entries[].scene` | string | Scene id resolved by the page |
| `entries[].mode` | enum | `webgpu`, `webgl2`, `software`, `canvas2d` |
| `entries[].width`, `height` | integer | 1..4096; must equal the PNG dimensions |
| `entries[].dpr` | number | 0.5..3 |
| `entries[].tick` | integer | ≥ 0; the simulation tick at capture |
| `entries[].file` | string | Same-directory relative PNG; no `..`, no scheme, no query |
| `entries[].sha256` | string | 64 lowercase hex characters over the PNG file bytes |
| `entries[].tolerance.maxChannelDelta` | integer | 0..255 |
| `entries[].tolerance.maxMismatchFraction` | number | 0..1 |
| `entries[].capturedAt` | string | `YYYY-MM-DD` |
| `entries[].deviceId` | string | A `docs/DEVICES.md` id, or `"ci-software"` |
| `entries[].browser` | string | Display string, recorded |
| `entries[].adapter` | string | Display string, recorded |
| `entries[].reason` | string | 1..280 characters; required on update |

Rules:

- PNGs are 8-bit RGBA, non-interlaced, top-down, with no color profile that changes pixel values. Alpha is compared, not ignored.
- There is exactly one entry per `(scene, mode, tick, width, height, dpr)`. A duplicate is a manifest error.
- Hardware and software entries are separate. A software golden is never compared to a hardware capture, and vice versa.
- Changing a tolerance requires a `golden-update --reason` and review. It is never widened automatically to make a run pass.
- The manifest and PNGs are committed. The actual capture, diff image and result JSON are artifacts and are not committed.

### 4.2 Determinism replay (`engine-replay`, `REPLAY_FORMAT_VERSION = 1`)

The six required fields are the fixture format frozen by 00 §5.8. Spec 19 adds two optional fields additively; a reader accepts files without them.

```json
{
  "version": 1,
  "engineVersion": "0.1.0",
  "gameId": "engine",
  "seed": 1,
  "ticks": 4,
  "packets": [
    { "tick": 0, "slot": 1, "buttons": 1, "edges": 1, "lx": 0, "ly": 0, "rx": 0, "ry": 0, "lt": 0, "rt": 0 },
    { "tick": 2, "slot": 1, "buttons": 0, "edges": 0, "lx": 0, "ly": 0, "rx": 0, "ry": 0, "lt": 0, "rt": 0 }
  ],
  "hashEvery": 2,
  "expectedStateHashes": [
    { "tick": 2, "hash": "fnv1a32:00000000" },
    { "tick": 4, "hash": "fnv1a32:00000000" }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `version` | integer | Exactly `1` (00 §5.8) |
| `engineVersion` | string | The build that recorded the trace |
| `gameId` | string | Slug or `"engine"` |
| `seed` | integer | u32 |
| `ticks` | integer | 1..1,000,000 |
| `packets` | array | ≤ 100,000; sorted by `tick` then `slot`; `slot` 1..8; `tick` < `ticks`; integer fields in the ranges owned by `protocol` |
| `hashEvery` | integer, optional | ≥ 1; default `10` when absent |
| `expectedStateHashes` | array, optional | Sorted by `tick`; `hash` matches `^fnv1a32:[0-9a-f]{8}$` |

Rules:

- `expectedStateHashes` are compared after the two runs agree with each other. A mismatch is a failed fixture, not a harness bug; investigate the code change first.
- The replay file is a test fixture, not a wire format. It never travels over the broker and contains no token, room code or player name.
- Packets are applied at the tick they name. Multiple packets for one slot in one tick are merged by the driver using the frozen input rules (latest level wins, edges OR-accumulate) so the replay matches the host mapper (00 §5.8).
- The rig never rewrites a replay file. Capture belongs to spec 16 (`__ENGINE_CAPTURE__`); replay consumes its `input` array.

### 4.3 Benchmark and budget report (`engine-bench-result`, `BENCH_RESULT_VERSION = 1`)

The result type in §3.2 is the only benchmark/budget report. `bench` writes it with `golden`, `determinism` and `conformance` set to `null`; `verify` fills the members it ran. The `budgets` array is the budget report:

```json
{
  "formatVersion": 1,
  "kind": "engine-bench-result",
  "runId": "<uuid-v4>",
  "command": "bench",
  "status": "pass",
  "exitCode": 0,
  "startedAt": "2026-10-22T00:00:00.000Z",
  "durationMs": 0,
  "requestedMode": "software",
  "backend": "webgl2",
  "fallback": false,
  "build": {
    "engineVersion": "0.1.0",
    "buildHash": "<8..64 lowercase hex>",
    "dirty": false,
    "gameId": "engine",
    "sceneId": "scene5000"
  },
  "environment": {
    "browser": "<browser name and version>",
    "headless": true,
    "viewport": { "cssWidth": 1920, "cssHeight": 1080, "dpr": 1 },
    "adapter": null,
    "deviceId": "ci-software"
  },
  "bench": {
    "sceneId": "scene5000",
    "warmupFrames": 120,
    "measuredFrames": 600,
    "frameMs": { "p50": 0, "p95": 0, "max": 0, "mean": 0 },
    "cpuMs": null,
    "gpuMs": { "source": "none", "p50": null, "p95": null, "max": null },
    "drawCalls": { "p50": 0, "p95": 0, "max": 0, "mean": 0 },
    "triangles": 0,
    "textureBytes": 0,
    "bufferBytes": 0,
    "renderScale": 1,
    "heap": null
  },
  "golden": null,
  "determinism": null,
  "conformance": null,
  "budgets": [
    { "id": "frame-p95", "observed": 0, "limit": 0, "unit": "ms", "pass": false }
  ],
  "artifacts": {
    "resultJson": "result.json",
    "screenshotPng": null,
    "goldenActualPng": null,
    "goldenDiffPng": null,
    "log": "run.log"
  },
  "errors": [],
  "warnings": []
}
```

The zeros above are placeholders in a schema example, **not measured values**. A real result never contains a zero written to mean "not measured"; use `null`.

Budget rules:

- `limit` is copied from the owning spec (`ER-00-03`/`ER-04-02`/`ER-05-03` for frame time, `PR-9.1` for draw calls, `PR-9.2` for texture bytes, `ER-00-07`/`ER-01-07`/`ER-04-08` for heap growth) or from the generated budget module. Spec 19 never edits a limit.
- A missing budget value leaves the check out of the array and adds a warning. It does not silently pass.
- A budget check whose observed value is `null` is a failed check with `E_RIG_UNSUPPORTED`.
- The rig records an observed value and a limit; it does not round a failure into a pass. Thresholds in `docs/RESULTS.md` remain the owning spec's.

### 4.4 `docs/RESULTS.md` row format

Existing manual rows keep the table columns defined in `docs/TESTING.md`: `Date | Stage / work item | Device | OS / browser | Method | Result | Verdict`. Spec 19 adds rows only; it does not change the column set. Every engine row carries the `ER-19-*` id in the work-item cell (or the owning `ER-00/04/05/16` id when the number is theirs).

A row is written only after a run. Synthetic shape:

```markdown
| 2026-10-22 | ER-19-15 | pc-win11-rtx3050 | Windows 11 10.0.26300 / Chrome 155.0.8059.85 | `node tools/engine-test/dist/cli.js verify --suite m0 --mode webgl2`; build `<hash>`, 1920x1080 DPR 1, warm-up 120, measured 600 | frame p50/p95/max `<p50>`/`<p95>`/`<max>` ms; draw calls `<n>`; texture `<n>` B; heap growth `<n>` B; golden `<id>` mismatch `<n>`% > 8/255; determinism `<hash>`; artifacts `<runId>` | `PENDING` |
```

Rules:

- `Date` is `YYYY-MM-DD`; `Verdict` is `PASS`, `FAIL` or `PENDING`.
- A hardware row stays `PENDING` until a person runs it on the named device. A CI software run cannot fill a TV or desktop-GPU row.
- The `Method` cell names the exact command, mode, build hash, viewport/DPR and warm-up/measured counts.
- The `Result` cell records p50/p95/max, draw calls, texture bytes, heap growth (or `unavailable`), golden mismatch and determinism hash as applicable. A number without those fields is not evidence.
- Never paste a token, PIN, room code, player name, IP address or absolute user path. `docs/RESULTS.md` is committed; artifacts are not.
- A failed run is recorded as `FAIL` with the failing check and artifact id. Deleting a failed row to make a milestone look green is prohibited.

### 4.5 Artifact layout

```text
artifacts/engine-test/<runId>/
  result.json          the RunResult above
  screenshot.png       full page capture, debug overlay off
  golden-actual.png    captured frame used for comparison
  golden-diff.png      mismatch visualization, when a golden ran
  run.log              human log: command, flags, build, browser, timings
  browser.log          CDP/console/exception transcript (redacted)
```

Rules:

- `artifacts/` is gitignored and uploaded by CI with a retention period chosen by the CI owner.
- Every path in `result.artifacts` is relative to the artifact root. No absolute path is written.
- The temp Chrome profile lives under `os.tmpdir()` and is deleted on success, failure and timeout.
- `browser.log` records console messages and uncaught exceptions. It is scanned for the forbidden strings before upload: `token`, `pin`, `roomCode`, `hostToken`, `sessionToken`. A hit fails the run with `E_RIG_RESULT`.
- No video or trace capture by default; a deliberate `--trace` flag may be added later as an investigation aid, never as acceptance evidence.

### 4.6 Format version registry additions

| Name | Current | Owner | Bump rule |
|---|---:|---|---|
| `GOLDEN_MANIFEST_VERSION` | 1 | 19 | Required field/meaning change; readers keep v1 for one milestone |
| `REPLAY_FORMAT_VERSION` | 1 | 19 with 00 §5.8 | Any change to the frozen replay fields; optional additions do not bump |
| `BENCH_RESULT_VERSION` | 1 | 19 | Removing or reinterpreting a result field |
| `CONFORMANCE_REPORT_VERSION` | 1 | 19 with 00/04 | Case-result shape change |

These rows are added to the 00 §4.1 registry by the integration change that lands the rig; this spec defines them.

---

## 5. Architecture

### 5.1 Module layout

```text
tools/engine-test/
  package.json, tsconfig.json
  src/
    cli.ts                     argument parsing, command dispatch, exit mapping
    commands/
      verify.ts                suite expansion
      golden.ts                golden-verify, golden-update
      determinism.ts           replay orchestration
      conformance.ts           suite orchestration
      bench.ts                 scene measurement
    launcher/
      chrome.ts                discovery, spawn, DevToolsActivePort
      profile.ts               temp profile lifecycle
    cdp/
      client.ts                WebSocket request/response, event emitter
      session.ts               target attach, bindings, exceptions
    server/
      static.ts                loopback static server, containment
    golden/
      manifest.ts              parse, validate, update
      diff.ts                  pure RGBA diff
      capture.ts               page capture protocol, PNG handling
    determinism/
      replay.ts                parse, validate, packet schedule
      hash.ts                  FNV-1a 32 over canonical bytes
      driver.ts                driver loading (Node) and page bridge (browser)
    bench/
      sample.ts                page measurement protocol
      budgets.ts               evaluate BudgetCheck[] from spec-16 values
    conformance/
      report.ts                case result schema
      run.ts                   Node fake-device and browser real-device runners
    result/
      schema.ts                RunResult validation
      write.ts                 deterministic write, artifact paths
    report/
      markdown.ts              human summary
    browser/
      harness.ts               injected page-side runner glue
  suites/
    m0.json                    authored with the M0 scene
  test/
  fixtures/
```

The rig is a workspace tool, built with `tsc` like `tools/trace-check` and `tools/size-budget`. It has no browser-side bundle of its own beyond the harness module injected into the page; the page itself belongs to `experiments/e-m0-engine/`.

### 5.2 Run flow

```text
CLI parse ──▶ validate suite/manifest/replay (exit 2 on bad input)
           ──▶ find Chrome, spawn headless with a temp profile
           ──▶ start loopback static server on 127.0.0.1:0
           ──▶ connect CDP over the DevTools WebSocket
           ──▶ create target, set viewport/DPR, register __engineTest binding
           ──▶ navigate to the scene page with explicit query flags
           ──▶ page runs the check and calls __engineTest(payload)
           ──▶ runner assembles RunResult, writes artifacts
           ──▶ compare golden / hashes / cases / budgets
           ──▶ exit 0/1/2/3
```

Ordering rules:

- The static server starts before the browser navigates. The browser is killed and the server closed in a `finally` block on every path.
- A page error (`Runtime.exceptionThrown`) or console error is recorded. A console error fails the run unless the page declares it expected in its result payload; an uncaught exception always fails.
- The runner waits on the `Runtime.bindingCalled` event. It never polls with a fixed interval. The watchdog is a deadline, not a sleep, and its expiry is an infrastructure error (exit 3).
- One rig run owns one browser process and one temp profile. Parallel CI jobs use distinct `runId` directories; two runs in one checkout are not supported because they would share the artifact root unless `--artifacts` is passed explicitly.

### 5.3 Modes

| Mode | Browser configuration | What it proves | CI use |
|---|---|---|---|
| `webgpu` | Hardware adapter; `--enable-unsafe-webgpu` where the Chrome version requires it | WebGPU backend, goldens, budgets | Hardware lane only; absent `navigator.gpu` is a failure for a requested WebGPU check |
| `webgl2` | Hardware GL through ANGLE | WebGL2 backend and parity | Hardware lane; nightly/manual |
| `software` | `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` | Pipeline health, deterministic goldens, CI coverage without a GPU | Every PR |
| `canvas2d` | No GPU requirement | Legacy 2D visual parity (Coin Run, Reaction Duel) | Every PR when those goldens exist |

Rules:

- The actual backend is read from the page and recorded. A requested `webgpu` that falls back to WebGL2 is `fallback: true`; a golden entry captured in `webgpu` cannot be checked against a WebGL2 fallback.
- `software` is WebGL2 on SwiftShader, not WebGPU. A WebGPU software adapter may be added later as `webgpu-software` if a pinned Chrome exposes it; it is not required for M0.
- `canvas2d` refuses 3D scenes (05 ER-05-07); the rig records the refusal as a pass only for a suite entry that explicitly expects it.
- The viewport and DPR come from the scene/suite, then are set through CDP `Emulation.setDeviceMetricsOverride`. The browser window size is not evidence.
- No mode is silently substituted. `--allow-fallback` exists for smoke runs and records the substitution; it never turns a mismatched golden or budget into a pass.

### 5.4 Chrome discovery and launch

- `CHROME_PATH` wins. Otherwise the launcher probes the platform defaults (Windows Program Files Chrome/Chromium, macOS app bundle, `google-chrome`/`chromium` on PATH) and fails with `E_RIG_CHROME` (exit 3) naming what it looked for.
- The evidence lane pins a Chrome for Testing build. The exact version is recorded in every result and every `docs/RESULTS.md` row. A browser upgrade is a deliberate golden-review event, not an invisible change.
- Launch flags: `--headless=new`, `--remote-debugging-port=0`, `--user-data-dir=<temp>`, `--no-first-run`, `--no-default-browser-check`, `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`, `--force-device-scale-factor=1`, `--disable-extensions`. `--no-sandbox` is used only where the CI container requires it, and the result records that it was used.
- The launcher reads `<profile>/DevToolsActivePort`, then connects to the WebSocket endpoint. It does not assume port 9222.
- The launcher never opens a visible window unless `--headful` is explicit. Headful runs are debug-only and never evidence.
- The browser is killed with a grace period, then forcibly. Orphan processes and temp profiles are cleaned up on timeout.

### 5.5 Loopback static server

- Node `http.createServer`, bound to `127.0.0.1:0`. The chosen port is read from `server.address()` after the `listening` event.
- It serves only the repository root, read-only, with path containment (resolve, then require the prefix) and a MIME table for `.html`, `.js`, `.mjs`, `.css`, `.json`, `.png`, `.wasm`, `.glb`, `.ktx2`, `.webp`, `.ogg`, `.opus`, `.woff2`.
- It sets `Cache-Control: no-store` and `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin` to match the dev server's isolation decision. A page that needs isolation gets it in the rig too, so a failure is not a header difference.
- It exposes no API, no broker, no WebSocket, no room. It logs requests to `run.log` with no query strings (the scene query is not secret, but the rule keeps the log stable).
- Directory listing is off; a request for a directory returns 404. A missing file returns 404 and the page reports its own error.

### 5.6 Golden capture and diff

**Capture.** The page renders the declared scene at the declared tick, waits for the frame to complete, and captures pixels through the renderer's test-only readback path (04/05 expose it; the rig does not call `readPixels` from a game path). The page converts the RGBA buffer to PNG on an `OffscreenCanvas` and posts the bytes through the `__engineTest` binding. Captures are top-down RGBA8; a WebGL bottom-left readback is flipped once, in one place, before encoding. The debug overlay, HUD, profiler and cursor are off. The scene has no wall-clock animation at the captured tick.

**Diff.** Pure function `diffRgba(expected, actual, width, height, tolerance)`:

1. Require equal lengths and dimensions; otherwise `E_RIG_GOLDEN` (exit 2).
2. For every pixel and every channel, compute `d = abs(expected - actual)`.
3. Count the pixel as a mismatch when `max(r, g, b, a) > tolerance.maxChannelDelta`.
4. `mismatchFraction = mismatchPixels / totalPixels`. Pass when `mismatchFraction <= tolerance.maxMismatchFraction`.
5. Record `maxChannelDelta`, `meanAbsError`, `firstMismatch` (scan order) and both SHA-256 values for diagnostics. Only step 4 gates.

The default tolerance for the M0 parity rows is the one already recorded in 00/04/05: **≤ 2% of pixels differ by more than 8/255 in any channel**. The rig implements that rule; it does not redefine it. A tighter or wider tolerance is a per-entry manifest decision with a `--reason` and review.

Rules:

- A golden is compared only against a capture from the same `mode`, `scene`, `tick`, width, height and DPR.
- Two consecutive software captures must be byte-identical. Two consecutive hardware captures may differ within tolerance; both are recorded in the run log.
- A diff image is written for every failure and for every pass where the tolerance was non-zero and the mismatch count was above zero; it is an artifact, never committed.
- A missing PNG, a wrong SHA-256 for the committed golden, or a dimension mismatch is a manifest error (exit 2), not a visual difference. This catches a corrupt checkout before blaming the renderer.
- `golden-update` writes a new PNG and manifest entry only; it never edits another entry. The review diff is the manifest change plus the image.

### 5.7 Determinism harness

1. Parse and validate the replay file. A packet for a tick outside `[0, ticks)` or a slot outside 1..8 is exit 2.
2. Start two **isolated** runs. Node: two child processes, each importing the driver fresh. Browser: two fresh pages (or two fresh browser contexts) with a cache-busting query, so module-level state cannot leak.
3. In each run: `init(seed)`, then for each tick apply the packets scheduled for that tick and call `step`. Every `hashEvery` ticks (and on the final tick), call `stateBytes` and hash the bytes with FNV-1a 32. Store `{ tick, hash }`.
4. Compare the hash arrays. `equal` is true only when the lengths and every hash match. `firstMismatchTick` is the first differing tick, or `null`.
5. Run a third isolated run with `seed + 1` (wrapping at u32) over the same input. `seedSensitivity` is true when at least one hash differs. A fixture whose state does not depend on the seed fails this check unless the fixture declares `seedSensitive: false`; that declaration needs a reason in the fixture README.
6. Compare against `expectedStateHashes` when present.
7. The run passes only when `equal`, `seedSensitivity` (or its declared exemption) and the expected hashes all pass.

Canonical hash input:

- Every value is little-endian.
- `tick` is `u32`; entity ids are `u32`; positions/rotations/scales are `f64`; counters are `f64` unless the fixture declares an integer width.
- The order is dense entity order, then RNG state, then declared counters. No `Map` iteration, no object key order, no locale-formatted numbers.
- The hash is `fnv1a32:` plus eight lowercase hex digits over the byte buffer returned by `stateBytes`.

Rules:

- No wall clock, no `Math.random`, no network and no worker result may enter the simulation (00 §5.8).
- A replay that names a different `engineVersion` than the build is a warning, not a pass; the result records both. It is not evidence for the current build.
- The harness never retries a determinism mismatch. A mismatch is a defect or a fixture bug; retrying hides it.
- Browser determinism is per build and per browser. A Node pass does not prove a browser pass; both lanes exist.

### 5.8 Frame-time and allocation measurement

**Frame time.**

- The page runs the scene through the real loop. Warm-up frames are discarded; the next `--frames` frames are measured (defaults 120 and 600, the sample windows used by 00/04/05).
- Per frame the page records the rAF timestamp delta (`frameMs`), the CPU frame time from the loop (`cpuMs`), renderer stats (`drawCalls`, `triangles`, `textureBytes`, `bufferBytes`), render scale, and GPU timing when the backend exposes it.
- Percentiles are nearest-rank via spec 16's `percentile`. The result reports p50, p95, max and mean.
- The page signals completion once, through the binding, after the last measured frame. The runner never samples a half-written global.
- Frame samples are stored in a preallocated ring; the harness must not allocate per frame. The rig is measuring the engine, not adding its own GC pressure.
- GPU timing is whatever spec 16 reports: `timestamp-query`, `ext-disjoint-timer` or `none`. `none` means `null` values, never an estimate from CPU time.

**Allocation.**

- With `--enable-precise-memory-info`, the page reads `performance.memory.usedJSHeapSize` after warm-up and after the last measured frame. `growthBytes = endBytes - startBytes`; `frames` is the measured window.
- When the API is unavailable, `heap` is `null` and the allocation check is `E_RIG_UNSUPPORTED`. The run never reports `0` as a substitute.
- Heap growth is a screening signal, not proof of a leak. Spec 16's capture/profile tools identify the allocation site; the acceptance thresholds stay with 00/01/04/05.
- The rig does not force `gc()`. The page may call `gc()` only behind an explicit debug flag, never in an acceptance run.

### 5.9 Conformance runner

- The suite is a module owned by 00/04 and lives at `packages/engine/core/test/contract/renderDevice.conformance.test.ts` (00 §8). It exports case ids and a runner that accepts a `RenderDevice`; it does not import a backend package.
- `conformance --suite render-device --mode <mode>` runs the same case ids against the real device in the browser and writes a `ConformanceSummary`.
- CI runs the suite against the fake device in Vitest. The rig's browser run is what proves the real backend. A fake-device pass is not a real-backend pass.
- A case may be `skipped` only when a declared, optional capability is absent (for example timestamp queries). A required case that cannot run is a failure, not a skip.
- The WebGPU and WebGL2 runs must report the same case id set. A missing case on one backend is a failure; it means the suite drifted.
- A backend-specific workaround is not allowed inside the suite. If a backend needs different behaviour, the contract needs a capability flag.

### 5.10 CI wiring

The local gate stays `npm run check` (00 §5.16: no new top-level gate). The rig is a second required job at the wave boundary.

| Job | Trigger | Command | Blocks a wave? |
|---|---|---|---|
| `check` (existing) | every push/PR | `npm ci && npm run check` | Yes, unchanged |
| `engine-test:unit` | every push/PR | included by `npm test` through the `tools/engine-test` Vitest project | Yes |
| `engine-rig:software` | every push/PR | `node tools/engine-test/dist/cli.js verify --suite m0 --mode software --json` | **Yes**; a red rig is a red wave |
| `engine-rig:determinism` | every push/PR | `node tools/engine-test/dist/cli.js determinism --replay experiments/e-m0-engine/replay/replay-600.json --runtime node` | Yes |
| `engine-rig:hardware` | nightly + manual dispatch | `verify --suite m0 --mode webgl2`, then `--mode webgpu` on the reference device | No for a code wave; **yes** before claiming an M0/M1 performance or visual result |
| `engine-rig:tv` | manual only | Not headless; a person runs the page on the named TV and fills `docs/RESULTS.md` | No; TV rows stay `PENDING` |

Rules:

- A wave is green only when `check` and the `engine-rig:software` + `engine-rig:determinism` jobs are green and the run artifacts are linked from the checkpoint. A wave cannot be declared green on `check` alone.
- The rig job installs a pinned Chrome for Testing build and sets `CHROME_PATH`. It does not download a browser at run time from an unpinned URL.
- The job uploads `artifacts/engine-test/<runId>/` as a CI artifact. A failed run's artifacts are kept; a passing run's may expire.
- The hardware job runs only where a GPU is available and the device is listed in `docs/DEVICES.md`. A hardware row run on an unlisted device is not evidence until the device is registered.
- Root scripts (`engine:verify`, `engine:bench`, `engine:golden:update`) are added by the integration agent, not by this spec's implementation agent. `npm run check` is not changed to call the rig.
- CI concurrency: one rig job per checkout. Parallel jobs use separate workspaces or separate `--artifacts` roots; they never share a temp profile.

### 5.11 What the rig does not prove

- It does not prove phone input latency, TV display lag, Bluetooth audio latency or real Wi-Fi behaviour. Those are E5/E6/E11/manual rows.
- It does not prove cross-browser determinism or cross-GPU visual equality. It proves a declared build in a declared mode on a declared adapter.
- It does not prove a game is fun, complete or within content budget. It proves the engine substrate it uses.
- It does not prove production bundle contents; `npm run size` and the build-graph tests do (16 ER-16-11).

---

## 6. File ownership

One writer per file. The paths below are the implementation map. Files not listed are not owned by spec 19.

| Path | Owner | Contents / rule |
|---|---|---|
| `docs/engine/19-testing-benchmarks.md` | 19 | This spec |
| `tools/engine-test/package.json`, `tsconfig.json` | 19 | Workspace tool metadata; integration adds the root workspace entry |
| `tools/engine-test/src/**` | 19 | CLI, launcher, CDP, server, golden, determinism, bench, conformance, result, report, browser harness |
| `tools/engine-test/test/**` | 19 | Unit, property, golden-result, integration and artifact-hygiene tests |
| `tools/engine-test/fixtures/**` | 19 | Synthetic manifests, replays, result JSON, diff cases, mutant suites |
| `tools/engine-test/suites/**` | 19 | Suite files (`m0.json` authored with the M0 scene) |
| `experiments/e-m0-engine/**` | 19 | M0 demo/benchmark page, scene definitions, `golden/`, `replay/`, `conformance/`, `README.md`. Scene parameters remain owned by 04/05 Appendix A; 19 implements the page |
| `experiments/e-m0-engine/golden/*.png`, `goldens.manifest.json` | 19 | Committed goldens; update only through `golden-update` |
| `experiments/e-m0-engine/replay/*.json` | 19 | Committed replay fixtures |
| `docs/RESULTS.md` — rows tagged `ER-19-*` | 19 | Measurements only; existing rows keep their owners; no invented numbers |
| `packages/engine/tooling/src/node/bench/**` | 19 | Node-side benchmark runner glue; shared package, exclusive directory |
| `packages/engine/tooling/src/browser/bench/**` | 19 | Browser-side benchmark glue; same rule |
| `tools/gpu-rig/**` | 19 (after W0 handoff) | Headless rig, golden triangle, `probe.js`; **implemented by the W0 rig task** (`a8f49ff...`). Spec 19 does not edit this tree while that task is in flight |
| `tools/trace-check/src/trace.ts` — ER grammar | 19, additive change | Extend the ID grammar to `ER-\d+-\d+` (assigned by 16 §9). This is the only edit to an existing tool; it must not weaken existing grammar or tests |
| `tools/trace-check/test/trace.test.ts` — ER cases | 19, additive change | Tests for the new grammar; existing cases unchanged |
| `docs/BUDGETS.md` | 19 with 00/01 (shared) | Values; spec 19 reads them and does not change a threshold to pass a run |
| `docs/TESTING.md` | existing owner | Integration adds the rig commands and the wave rule; 19 does not edit it |
| root `package.json`, `tsconfig.json`, `vitest.config.ts`, CI workflow, `.gitignore` | integration agent | Workspace entry, project reference, Vitest project, `engine-rig` job, `artifacts/` ignore |
| `docs/todos/TRACEABILITY.md` — `ER-19-*` rows | integration agent | Added with the first tagged test; 19 supplies the rows |
| `docs/engine/00-architecture.md` §4.1 version registry | integration agent | Adds the four format versions from §4.6 |
| `docs/engine/16-tooling-profiler.md` §5.1 path | integration agent | Reconciles `tools/bench/` with the canonical `tools/engine-test/` (see below) |

**Path conflict, resolved here.** 16 §5.1 names `tools/bench/` as owned by spec 19. This spec chooses `tools/engine-test/` as the canonical package: it is the rig, not only the bench, and one package avoids a second workspace with a competing CLI. `tools/bench/` is not created. 16 §5.1 was updated to `tools/engine-test/` on 2026-10-22; `packages/engine/tooling/src/node/bench/**` stays as named by 16.

**W0 handoff.** `tools/gpu-rig/` is owned by spec 19 in the long run but is being built by the W0 rig task (`probe.js` exists; `index.html` and `run.mjs` are in flight). This spec declares the ownership and does not edit the tree. When the W0 task completes, spec 19's implementation agent owns maintenance and the golden-triangle entry.

**Fixtures are owned by the spec that defines them.** A test may read another spec's fixture; it may not edit it. Scene parameters (instance count, camera, light) are owned by 04/05; spec 19 owns the page and the encoding.

---

## 7. Acceptance

Every row carries an `ER-19-NN` id. Tests and manual records reference the id; the id must resolve to a row in `docs/todos/TRACEABILITY.md` once the engine programme is registered there. Evidence state is `PENDING` until a run exists. No row is claimed from this document, and no hardware number is invented.

| ID | Criterion | Fixture / method | Hardware / run condition | Evidence state |
|---|---|---|---|---|
| ER-19-01 | Every command parses its declared flags; `--json` emits one valid `RunResult`; exit codes 0/1/2/3 are produced by the named fixtures; an invalid result (pass status with non-zero exit, missing required field, unknown `formatVersion`) is refused | `tools/engine-test/test/fixtures/results/{pass,fail,error,invalid}.json`; unit table over the CLI | CI Node 20 | PENDING — implementation |
| ER-19-02 | Headless Chromium launches with a temp profile, serves the page from `127.0.0.1:0`, attaches CDP, receives the `__engineTest` binding, loads `tools/gpu-rig/`, and records `stable: true` in two consecutive runs; no fixed sleep is used; browser and profile are cleaned up on success and timeout | `tools/gpu-rig/index.html` (W0, in flight); `engine-test run --scene gpu-rig --mode software` | CI Linux with pinned Chromium; local `pc-win11-rtx3050`, Chrome 155 for the desktop leg | PENDING — W0 rig and runner |
| ER-19-03 | Golden manifest validation rejects a duplicate id, bad SHA-256, missing PNG, `..` path, unknown `formatVersion`, and a dimension mismatch with the specified exit code (2) and no partial write | `tools/engine-test/test/fixtures/golden/invalid/*.json` and `*.png` | CI Node 20 | PENDING — implementation |
| ER-19-04 | Diff math: identical images pass; a mismatch fraction exactly at the tolerance passes; one pixel beyond the fraction or one channel beyond `maxChannelDelta` fails; a dimension mismatch is exit 2; metrics are deterministic across runs; property tests cover symmetry and monotonicity | `tools/engine-test/test/fixtures/golden/diff-cases/`; `diff.test.ts`, `diff.property.test.ts` | CI Node 20 | PENDING — implementation |
| ER-19-05 | The golden triangle rendered at 256×256 in `webgpu` and `webgl2` matches within the 00 §7 tolerance (**≤ 2% of pixels differ by more than 8/255 in any channel**) | `tools/gpu-rig/` capture; `goldens.manifest.json` entries `gpu-rig-webgpu` / `gpu-rig-webgl2` | `pc-win11-rtx3050`, Chrome 155; WebGPU availability must be measured, not assumed | PENDING — hardware; WebGPU adapter unmeasured |
| ER-19-06 | Two consecutive `software` captures of the golden triangle are byte-identical (same SHA-256 and same `hash`); a deliberate scene mutation produces a different hash and a failed golden | `tools/gpu-rig/`; `tools/engine-test/test/fixtures/mutants/gpu-rig-mutant.json` | CI Linux with pinned Chromium (software) | PENDING — W0 rig and runner |
| ER-19-07 | A 600-tick replay at seed 1, hash every 10 ticks, produces identical hash sequences in two isolated Node runs; a seed+1 run produces a different hash; expected hashes in the fixture match; a mismatch reports the first differing tick and is never retried | `experiments/e-m0-engine/replay/replay-600.json`; `--runtime node` | CI Node 20 | PENDING — fixture authored with the M0 scene/driver |
| ER-19-08 | The same replay in two fresh Chrome pages produces identical hash sequences and matches the Node result for the same build | `experiments/e-m0-engine/replay/replay-600.json`; `--runtime browser` | `pc-win11-rtx3050`, Chrome 155, WebGL2 | PENDING — needs the M0 page and driver |
| ER-19-09 | `bench` on the M0 scene runs the declared warm-up and measured windows, and the result contains every `BenchSample` field, a valid build identity, viewport/DPR, actual mode and adapter; a `null` GPU timer or heap API is recorded as `null`/`E_RIG_UNSUPPORTED`, never zero; budget checks copy their limits from the owning spec | `experiments/e-m0-engine/?scene=scene5000&bench=1`; `--mode software` for the schema run | CI software for schema; `pc-win11-rtx3050`, Chrome 155 for numbers | PENDING — M0 page |
| ER-19-10 | Allocation semantics: with a fake `performance.memory`, start/end/growth and frame count are recorded; without it, `heap` is `null`, the allocation check is `E_RIG_UNSUPPORTED`, and the run does not claim a pass for the allocation budget | `tools/engine-test/test/heap.test.ts` with an injected memory API; browser run records the real availability | CI Node 20; desktop browser for availability | PENDING — implementation |
| ER-19-11 | The shared renderer conformance suite runs against the fake device in Node and against real WebGPU and WebGL2 in the browser; both real runs report the same case-id set, zero failed required cases, and any skip is a declared optional capability | `packages/engine/core/test/contract/renderDevice.conformance.test.ts`; `conformance --suite render-device` | CI Node 20 (fake); `pc-win11-rtx3050`, Chrome 155 (real both backends) | PENDING — suite and backends |
| ER-19-12 | A red rig blocks a wave: a seeded mutant golden makes `verify` exit 1; a missing result, a failed browser launch or a CDP disconnect exits 3; no path returns 0 for a missing or invalid result; the CI job is required in the wave checklist | `tools/engine-test/test/fixtures/mutants/`; CI job contract test | CI Node 20 + CI job | PENDING — implementation and CI |
| ER-19-13 | `golden-update` refuses without `--confirm` and `--reason`, refuses when `CI` is set, writes the PNG and manifest atomically, and records `capturedAt`, `buildHash` and the reason; it never runs inside `verify` | `tools/engine-test/test/goldenUpdate.test.ts`; temp fixture manifest | CI Node 20 | PENDING — implementation |
| ER-19-14 | Artifacts contain no token, PIN, room code, player name, IP address, absolute user path or credential URL; the temp Chrome profile is deleted; `result.artifacts` paths are relative; a seeded forbidden string fails the run | `tools/engine-test/test/artifacts.test.ts`; seeded `browser.log` fixture | CI Node 20 | PENDING — implementation |
| ER-19-15 | M0 evidence: on the reference desktop, `verify --suite m0 --mode webgl2` and `--mode webgpu` produce artifacts, and the resulting `docs/RESULTS.md` row records build hash, device id, browser version, mode, adapter, viewport/DPR, warm-up/measured counts, p50/p95/max, draw calls, texture bytes, heap growth, golden result and determinism hash. Thresholds are the owning `ER-00/ER-04/ER-05` values | `docs/RESULTS.md` row; artifacts directory | `pc-win11-rtx3050`, Windows 11 10.0.26300, Chrome 155.0.8059.85 | PENDING — needs the M0 scene, goldens and a real run |
| ER-19-16 | TV evidence is not produced by the rig: a TV row stays `PENDING` until a person runs the page on a named TV; a software or desktop run never fills a TV row | `docs/RESULTS.md` TV rows; manual checklist | **PENDING device:** a 2020-era Android TV Chromium and a Tizen/webOS set from SPEC §12 | PENDING — no TV hardware in this repo |

Thresholds cited above are acceptance targets from 00/04/05, not measurements. `docs/RESULTS.md` is the only place where a number becomes evidence. A row with a `PASS` but no recorded build/device/browser/artifact is a documentation defect.

---

## 8. Test plan

### 8.1 Layers

| Layer | Scope | Location |
|---|---|---|
| Unit | CLI parsing, suite/manifest/replay validation, diff math, hash serialization, exit mapping, artifact paths, redaction, golden-update guards | `tools/engine-test/test/*.test.ts` |
| Property (`fast-check`) | Diff metric symmetry and monotonicity (`maxChannelDelta` up never reduces mismatches; identical images are zero); manifest parse → write → parse round-trip; replay packet ordering; percentage math; result schema round-trip | `tools/engine-test/test/**/*.property.test.ts` |
| Golden | A fixed synthetic RGBA pair with a known diff; a golden result JSON with normalized `runId`/`startedAt`; a manifest snapshot | `tools/engine-test/test/fixtures/`, `tools/engine-test/test/golden.test.ts` |
| Conformance | Shared `RenderDevice` suite against the fake device in CI; real WebGPU/WebGL2 in the rig browser lane | `packages/engine/core/test/contract/` (suite), `tools/engine-test/test/conformance.test.ts` (runner) |
| Integration | Real headless Chromium, real loopback server, real CDP, real static files; launch → binding → result → artifact; no mocks of the browser or server | `tools/engine-test/test/integration/liveRig.test.ts` |
| Benchmark | Schema and completeness of `bench`; threshold evaluation against injected samples; no hardware number asserted in CI | `tools/engine-test/test/bench.test.ts` |
| Manual | Desktop hardware lanes, WebGPU availability, TV rows, visual inspection of diff artifacts | `docs/RESULTS.md` |

### 8.2 Test-tag convention

- Every test title carries `[ER-19-NN]` or a leading `// @req ER-19-NN`, exactly as `docs/TESTING.md` requires.
- The tag must resolve to a row in `docs/todos/TRACEABILITY.md`. The current trace grammar (`tools/trace-check/src/trace.ts`) does **not** accept `ER-19-01`. The implementation change must land, atomically: (1) the additive ER grammar, (2) the `TRACEABILITY.md` rows, (3) the tagged tests. Adding a tag before its row exists makes `npm run trace` red with an unknown tag; that is a real defect, not a reason to remove the tag.
- Until the grammar and rows land, `ER-19-*` ids in this document are documentation-only and must not be counted as gate evidence.
- A test may carry several ids (`[ER-19-04][ER-00-05]`) when it genuinely exercises both. Do not tag a test for a row it does not assert.
- The trace checker scans `tools/**/test/**`; the rig's tests must live under `tools/engine-test/test/` to be seen.

### 8.3 Flake policy

- **No fixed sleeps.** Wait on CDP events (`Runtime.bindingCalled`, `Page.loadEventFired`), on the page's completion binding, or on a DOM/global condition observed through an evaluate. A watchdog deadline is allowed and is not a sleep.
- **No polling loop with an arbitrary interval** as the primary readiness mechanism. If a poll is unavoidable for a browser-internal state, it must have a deadline, a clear failure message, and a comment explaining why an event is not available.
- **Retries are infrastructure-only.** A browser launch failure, a CDP disconnect before any page result, or a temp-profile cleanup failure may retry once. A golden mismatch, budget breach, determinism divergence or conformance failure is never retried. A retried run is marked in `warnings` and `run.log`; a retry that hides an acceptance failure is a defect.
- **No quarantine.** A flaky acceptance check is fixed or its fixture is fixed in the same change. Deleting, skipping or loosening it to land a wave is prohibited (repo rule; 00 §8).
- **Determinism first.** Fixed seed, fixed viewport/DPR, fixed tick, debug overlay off, no wall-clock animation in the captured frame. If a golden is flaky, the cause is a nondeterministic scene or an unstable backend, not a tolerance that needs widening.
- **One browser per run.** Reusing a browser across runs leaks state and makes flake attribution harder. The cost is accepted; the software lane is the only per-PR browser lane.
- **Timeout failures are exit 3**, not exit 1. A hang is not a product regression until the partial log says otherwise; the log is attached.

### 8.4 How a red rig blocks a wave

1. The wave's exit evidence includes the `engine-rig:software` and `engine-rig:determinism` job URLs and a `PASS` result.
2. A red rig job is a red wave even when `npm run check` is green. The checkpoint records the failing check id, mode and artifact id.
3. The failure is fixed, or the fixture/manifest is corrected with a recorded reason and review. The rig is not bypassed with `--allow-fallback`, a wider tolerance, a deleted check or a skipped suite.
4. Hardware lanes do not block every code wave, because a GPU runner is not always available. They **do** block a performance or visual claim: no `PASS` in `docs/RESULTS.md` without the hardware run.
5. A missing or unreadable result is a failure, not an absent check. The CI job fails with exit 3 when the runner cannot produce a valid `RunResult`.

---

## 9. Dependencies

### 9.1 Spec dependencies

| Dependency | Why | Status |
|---|---|---|
| `00-architecture.md` | Contracts, determinism scope, replay fixture, budgets, ownership map, acceptance-ID convention | Exists |
| `01-core-loop-time.md` | Frame stats, fixed loop, the sample window the bench uses, budget module | Exists |
| `02-math.md`, `03-scene-ecs.md` | Math/scene benchmarks and their commands (`?mathBench=1`, `?bench=scene10k`) | Exist; wired after M0 |
| `04-renderer-webgpu.md` | `RenderStats`, test-only capture/readback, WebGPU conformance, M0 scene parameters | Exists; implementation pending |
| `05-renderer-webgl2.md` | Same contract, Canvas2D 2D path, WebGL2 conformance and parity | Exists; implementation pending |
| `06-assets.md` | Asset fixtures for the M0 scene and audit integration | Exists |
| `10-input.md` | Input traces and the replay packet semantics | Exists |
| `14-networking.md`, `13-ui-text.md`, `17-editor.md` | Later scene families and benchmarks that reuse this rig | Exist; later |
| `16-tooling-profiler.md` | `percentile`, profiler report, capture files, budget evaluation, `__ENGINE_PROFILE__` | Exists; implementation pending |
| `18-game-sdk.md` | `GameContext` and the game fixture shape used by the replay driver | Exists |
| `docs/TESTING.md` | Tag convention, manual-row fields, no-secrets rule | Exists |
| `docs/BUDGETS.md` | Budget values; spec 19 reads, never invents | Exists |
| `docs/DEVICES.md` | Device ids used by result and RESULTS rows | Exists |

### 9.2 Package and tool dependencies

| Dependency | Use | Rule |
|---|---|---|
| Node 20+ | CLI, launcher, static server, tests | Same engine as the repo |
| TypeScript strict, ESM | Tool implementation | Same as `tools/trace-check` |
| `ws` (already in the repo) | CDP WebSocket client | Dev-only; no new browser-automation framework |
| Chrome / Chromium (pinned) | Headless rendering | `CHROME_PATH`; Chrome for Testing in CI |
| `node:zlib`, `node:crypto` | PNG checks and SHA-256 | Built-ins only |
| PNG encode/decode | In-page `OffscreenCanvas` + `createImageBitmap` | No Node PNG library; the page decodes, Node hashes |
| Spec 16 profiler | Frame phases, GPU timings, heap sampling, capture | Dev-only import; never in a production bundle |
| `tools/gpu-rig` | W0 golden triangle | Implemented by the W0 task; owner after handoff is 19 |
| `tools/input-bot` | Replay/capture generation for larger traces | Existing tool; not modified |
| `tools/trace-check` | Tag enforcement | ER grammar extension owned additively by 19 |
| `tools/size-budget` | Size evidence remains separate | Not changed |

### 9.3 Integration prerequisites (not owned by the implementation agent)

- Root `package.json`: add `tools/engine-test` to `workspaces`; add `engine:verify`, `engine:bench`, `engine:golden:update` scripts. Do not change `npm run check`.
- Root `tsconfig.json`: add one project reference for `tools/engine-test`.
- Root `vitest.config.ts`: add a `tools/engine-test` project; otherwise its tests never run under `npm test`.
- `.gitignore`: add `artifacts/`.
- CI: add the `engine-rig:software` and `engine-rig:determinism` jobs; install a pinned Chrome; upload artifacts.
- `docs/todos/TRACEABILITY.md`: add `ER-19-01..16` rows with the owning work item and stage.
- `tools/trace-check/src/trace.ts` + its test: add the `ER-\d+-\d+` grammar additively.
- `docs/engine/00-architecture.md` §4.1: register the four format versions.
- `docs/engine/16-tooling-profiler.md` §5.1: reconcile `tools/bench/` to `tools/engine-test/`.
- `docs/TESTING.md`: add the rig commands and the wave rule.
- `docs/engine/README.md` §8.1: update the W0/W1 exit evidence to name the rig job.

### 9.4 Sequencing

1. W0: `tools/gpu-rig` golden triangle (in flight) → spec 19 runner skeleton and result schema.
2. W0/W1: ER grammar + traceability rows + the `tools/engine-test` Vitest project.
3. M0: M0 scene page, golden manifest, replay driver, software lane in CI.
4. M0: hardware lane on the reference desktop; `docs/RESULTS.md` rows.
5. M1+: one suite entry per new scene family (shadows, post, animation, physics, streaming, UI), each with its owning spec's thresholds.

Nothing in M0 requires headless WebGPU to succeed in CI. The software WebGL2 lane is the per-PR gate; WebGPU is a hardware lane and its rows stay `PENDING` until the adapter is measured.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R19-1 | Headless WebGPU is unavailable, unstable or flag-dependent in the pinned Chrome | High on CI and on some Windows/TV drivers | No WebGPU goldens or bench in CI; false "engine works" signal | WebGPU is a hardware lane, not a CI prerequisite; the software WebGL2 lane gates every PR; a requested WebGPU check fails explicitly with `E_RIG_UNSUPPORTED`; adapter and flags are recorded; never claim a WebGPU pass without a real adapter |
| R19-2 | SwiftShader (software) differs from hardware rasterization | Certain for some pixels | A software golden does not match hardware | Separate goldens and tolerances per mode; never compare software to hardware; software proves pipeline health, determinism and schema, not visual parity; hardware goldens are captured and checked on the named device |
| R19-3 | GPU nondeterminism or driver-specific output | Medium | Flaky goldens; a wave blocked by a GPU quirk | Two-run stability check; pin Chrome/Driver; per-entry tolerance; a tolerance change requires `--reason` and review; capture on the named device; report the adapter; never widen a tolerance silently |
| R19-4 | CI cost and runtime grow because every scene launches a browser | Medium | Slow PRs; skipped lanes under pressure | One software browser run per PR; Node determinism in Vitest; hardware lanes nightly/manual; cache the pinned Chrome; no video by default; a suite lists only its checks, not every scene |
| R19-5 | Golden churn from harmless rendering changes | High over time | Review fatigue; developers disable the gate | Explicit `golden-update` with `--reason` and review; fixed tick, viewport/DPR and no HUD; per-scene images; one manifest entry per mode; a golden diff is a review artifact, not an auto-accept |
| R19-6 | CDP/launch flakiness (port race, profile lock, orphan process) | Medium | Red builds for infrastructure reasons | `DevToolsActivePort` discovery; temp profile per run; binding-event wait; watchdog + kill; one infrastructure retry, marked; artifact log; no fixed sleeps |
| R19-7 | Result schema drifts between the runner, fixtures and CI consumers | Medium | Evidence not machine-readable; silent breakage | `formatVersion: 1`; schema validation on write and read; golden result fixtures; additive-only changes; unknown version exits 2 |
| R19-8 | The rig is not run and a wave is declared green anyway | Medium | Unverified changes land | CI job is required; a missing result is exit 3; the checkpoint must link the run; hardware rows stay `PENDING`; a red rig is a red wave |
| R19-9 | Determinism gives false confidence because the hash omits relevant state | Medium | A replay passes while gameplay diverges | The fixture documents its state coverage; the driver hashes tick, RNG, dense entity transforms and declared counters; seed sensitivity is mandatory; a review of new state must extend `stateBytes`; cross-browser equality is not claimed |
| R19-10 | The `tools/bench/` vs `tools/engine-test/` path drift creates two owners | Medium until reconciled | Duplicate work or a missing package | This spec declares `tools/engine-test/` canonical; integration updates 16 §5.1 in the same change; no work starts under `tools/bench/` |
| R19-11 | A browser upgrade changes goldens or timing | High over time | Surprise red builds; stale evidence | Pin Chrome for Testing; record the version in every result and RESULTS row; a version change is a deliberate re-capture and review event |
| R19-12 | Tagging `ER-19-*` before the grammar/rows exist makes `npm run trace` red | Certain if ordered wrongly | Non-green wave boundary | Land grammar + TRACEABILITY rows + tags atomically; do not tag documentation-only rows; the integration change owns the ordering |
| R19-13 | Artifacts leak session data or user paths | Low by construction, high if violated | Security/privacy defect | The rig never joins a room; the server serves loopback files only; artifacts are scanned for forbidden strings; paths are relative; temp profiles are deleted; no PII in results |
| R19-14 | The rig's own overhead distorts frame measurements | Medium | Misleading budgets | Preallocated rings; the harness records once per run; profiler/overlay off in the measured window; compare a no-rig page run when a number is near a threshold; spec 16 owns profiler overhead measurement |

**Overall fallback.** If the headless rig cannot run on a target, the target does not get an automated pass. It gets a recorded manual run in `docs/RESULTS.md` with the same fields, or it stays `PENDING`. The engine never claims a golden, frame budget or determinism result from a lane that did not run.

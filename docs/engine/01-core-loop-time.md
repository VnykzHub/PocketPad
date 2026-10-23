# 01 — Core Loop, Time and Jobs

**Status:** authoritative for the engine's time domain once implemented. This document specifies a target contract; no code in it exists yet.
**Authority:** [`SPEC.md`](../../SPEC.md) for the product/protocol contract, [`docs/ENGINE.md`](../ENGINE.md) for what exists today, [`00-architecture.md`](00-architecture.md) for package boundaries and frozen names.
**Package:** `@lanpad/engine-core` at `packages/engine/core` (00 §3.7, §6). The wave brief's shorthand `packages/engine-core` resolves to this path; no second package is created. The brief's loop directory `src/loop/**` is this package's `src/time/**`; 00 §6 fixes the directory name.

---

## 1. Goal

Give every game one trustworthy clock and one trustworthy frame.

- **Deterministic simulation.** The world advances in fixed 1/60 s steps no matter whether the display runs at 30, 60, 120 or 144 Hz, and no matter how long a frame stalls.
- **Smooth rendering.** Every display frame gets an interpolation alpha in `[0, 1)` so a 60 Hz simulation looks smooth on a 120 Hz panel without simulating twice.
- **Honest time.** Pausing (hidden tab, host pause, menu, context loss, network loss) never turns wall-clock time into simulation catch-up. Resuming never replays the paused interval.
- **Measured frames.** A fixed-capacity statistics ring answers p50/p95/max, long-frame counts and simulation steps per frame without allocating on the frame path.
- **Safe parallelism.** A job interface and worker protocol let decode, streaming, navmesh and save compression run off the main thread, while all simulation state stays on the main thread and job results are applied only at tick boundaries in deterministic order.
- **Migration without a rewrite.** The existing `packages/runtime/src/loop/FixedLoop.ts` moves here and keeps its semantics (`TICK_HZ = 60`, `DT = 1/60`, five-step clamp, `pause()` renders once at alpha 0, `resume()` re-baselines). The host adapter changes imports, not behaviour.

The player-visible outcome: a game on a 120 Hz laptop, a 60 Hz TV and a 30 Hz panel plays at the same speed, a backgrounded tab does not fast-forward when it returns, and no hitches come from the loop itself.

**Scope.** Loop, clock, scheduler, pause reasons, frame statistics, fixed vs variable step policy, job interface, worker protocol, worker boundaries, and the host adapter contract. Input mapping, rendering and physics are consumers.

---

## 2. Non-goals

- **Not a variable-timestep engine.** `tickHz` is exactly 60 in M0. A future variable step would be a new contract, not an option that silently changes game behaviour.
- **Not worker-side simulation.** Entities, components, physics, animation and game state never leave the main thread in M0–M2. Workers receive bytes and return bytes.
- **Not a `SharedArrayBuffer` design.** COOP/COEP headers are not guaranteed on TV browsers. The loop and jobs work without SAB; SAB is an optional accelerator, never a requirement.
- **Not lockstep networking.** Replay determinism is per build and per browser (00 §5.8). Tick-perfect cross-browser determinism is out of scope.
- **Not an audio clock.** Audio scheduling uses `AudioContext.currentTime` (spec 09). The loop never drives audio timing.
- **Not a renderer timer.** GPU timing, timestamp queries, dynamic resolution and frame pacing belong to specs 04/05/16; this spec only exposes the measured interval and CPU work time.
- **Not a task scheduler for arbitrary promises.** Jobs are coarse-grained, explicit, cancellable units; no implicit microtask queue, no `await` in a tick.
- **Not a profiler UI.** The statistics ring is data; the overlay belongs to spec 16.

---

## 3. Public interfaces

All types below are exported from `@lanpad/engine-core`. Names fixed by 00 §3.2 (`EngineFrame`, `FixedLoop`, `FixedLoopOptions`, `JobSystem`) are preserved; additions are optional fields or adjacent types.

### 3.1 Frozen 00 contract (restated)

```ts
export interface EngineFrame {
  readonly tick: number;        // host simulation tick, integer, starts at 0
  readonly dt: number;          // seconds, exactly 1/60
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
  readonly now: () => number;            // monotonic milliseconds
  readonly raf: (cb: (nowMs: number) => void) => number;
  readonly cancel: (id: number) => void;
  readonly onTick: (dt: number) => void;
  readonly onRender: (alpha: number) => void;
}
```

### 3.2 Loop implementation and additive surface

```ts
/** The concrete implementation of FixedLoop. */
export class EngineLoop implements FixedLoop {
  constructor(options: FixedLoopOptions);
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  readonly running: boolean;
  readonly paused: boolean;
  readonly tick: number;
  readonly dt: number;

  /** Pooled, mutated once per frame; do not retain across frames. */
  readonly frame: EngineFrame;

  /**
   * Pause ownership. Every source holds a reason; the loop is paused while at
   * least one reason is held. Idempotent; returns an idempotent release token.
   */
  holdPause(reason: PauseReason): () => void;
  readonly pausedBy: number;             // PauseReason bitmask
}

export type PauseReason =
  | "visibility"     // document hidden (host shell)
  | "hostPause"      // protocol hostPause from the room
  | "menu"           // launcher, leave-confirm, results overlay
  | "network"        // host lost / socket unavailable
  | "contextLoss"    // renderer device/context lost
  | "manual";        // game or debug request

export interface FixedLoopOptionsAdditive {
  /** Receives the loop's single reused stats object; copy what you keep. */
  readonly onFrameStats?: (stats: FrameStatsView) => void;
  /** Fired only when the aggregate paused state changes, never per frame. */
  readonly onPauseChange?: (paused: boolean, reasons: number) => void;
  /** Optional measured CPU work of the whole frame, supplied by the host. */
  readonly onFrameWork?: () => number;
}
```

`FixedLoopOptionsAdditive` is merged into `FixedLoopOptions` as optional members. A caller that supplies only the 00 fields gets the same behaviour as today's `FixedLoop`.

### 3.3 Clock

The accumulator arithmetic is a separate, pure class so it can be property-tested without a scheduler.

```ts
export class LoopClock {
  constructor(dtSeconds: number, maxCatchUpSteps: number);
  /** Discard accumulated time and re-baseline the wall clock. */
  reset(nowMs: number): void;
  /**
   * Add one frame interval and return how many fixed steps to run, 0..max.
   * Non-finite or non-positive deltas contribute zero. The accumulator is
   * clamped to maxCatchUpSteps * dt before the step count is computed.
   */
  beginFrame(nowMs: number): number;
  /** Consume one step: tick += 1, accumulator -= dt. */
  consumeStep(): void;
  /** alpha = accumulator / dt, always in [0, 1). Zero while paused. */
  alpha(paused: boolean): number;
  readonly tick: number;
  readonly accumulatorSeconds: number;
  readonly dt: number;
}
```

Exact rule set (normative):

1. `dt = 1 / tickHz`, with `tickHz` exactly 60 in M0.
2. `MAX_ACCUMULATED_SECONDS = maxCatchUpSteps * dt`; default `5 * dt = 0.083333…`.
3. On `start()` and `resume()`: `reset(now())`. The first frame after either does not simulate time from before it.
4. On `beginFrame(nowMs)`: `deltaMs = nowMs - lastMs`; `lastMs = nowMs`; if `deltaMs > 0 && deltaMs` finite, add `deltaMs / 1000`; then clamp. A backwards clock contributes zero.
5. Step count is `floor(accumulator / dt)` capped at `maxCatchUpSteps`. Accumulator is reduced by `dt` per consumed step.
6. `alpha = accumulator / dt`, forced to 0 while paused, and guaranteed `0 <= alpha < 1`. If floating-point accumulation leaves `alpha >= 1 - Number.EPSILON` after the last allowed step, alpha is clamped to `0` and the remainder is carried; this is the only place rounding may consume a step.
7. `tick` starts at 0 and increments once per `consumeStep()`. It is a `number` in memory; it must remain a safe integer for 4,767 years at 60 Hz and is never serialized as an integer larger than 2^53.

### 3.4 Scheduler

```ts
export interface FrameScheduler {
  readonly nowMs: number;                       // monotonic, same clock as callbacks
  request(cb: (nowMs: number) => void): number;
  cancel(id: number): void;
}

/** Browser adapter; the only loop file allowed to name requestAnimationFrame. */
export function createBrowserScheduler(): FrameScheduler;
/** Deterministic test scheduler with step(ms) / stepTo(ms). */
export class ManualScheduler implements FrameScheduler { /* ... */ }
```

The loop receives `now`, `raf` and `cancel` from `FixedLoopOptions`; `createBrowserScheduler()` is a convenience for the host shell. `engine-core/src/platform/` is the only directory in `engine-core` allowed DOM globals (00 rule D11).

Scheduler rules:

- Exactly one frame callback is pending while `running` is true; `stop()` cancels it.
- The callback's timestamp is authoritative; the loop does not call `now()` inside a frame.
- A hidden tab may deliver a large discontinuity. The clamp handles it. `visibilitychange` is not read here; the host supplies `holdPause("visibility")`.
- `requestAnimationFrame` is not replaced by `setTimeout` in production. Tests and headless benchmarks use `ManualScheduler`.

### 3.5 Frame statistics

```ts
export interface FrameStatsView {
  readonly frameMs: number;     // display interval of the last frame
  readonly workMs: number;      // optional measured CPU work; 0 when unmeasured
  readonly simTicks: number;    // steps run this frame, 0..maxCatchUpSteps
  readonly alpha: number;       // [0, 1)
  readonly tick: number;        // tick after this frame's steps
  readonly frames: number;      // frames recorded since construction/reset
  readonly longFrames: number;  // frameMs > 16.7
  readonly overBudgetFrames: number; // frameMs > 20 (SPEC hard-fail threshold)
  readonly p50FrameMs: number;
  readonly p95FrameMs: number;
  readonly maxFrameMs: number;
}

export class FrameStatsRing {
  constructor(capacity?: number);   // default 240 frames; min 8
  record(frameMs: number, workMs: number, simTicks: number, alpha: number, tick: number): void;
  /** Writes a snapshot into a caller-owned object; allocates nothing after construction. */
  snapshot(out: MutableFrameStats): FrameStatsView;
  reset(): void;                    // on resume / backend switch
}
```

- Capacity is fixed; default 240 frames (4 s at 60 Hz). Recording overwrites the oldest sample.
- Percentiles are computed with a preallocated scratch `Float64Array` copied from the ring, then a fixed insertion sort for n ≤ 240. No allocation.
- `p95` uses nearest-rank: index `ceil(0.95 * n) - 1`, clamped.
- Thresholds come from spec 16's budget module: target interval 16.7 ms, hard-fail 20 ms. This spec does not invent new budgets.
- The stats object is reused; `onFrameStats` subscribers must copy fields they retain. This preserves the current `FrameStats` contract.

### 3.6 Jobs

```ts
export type JobPriority = "critical" | "normal" | "idle";

/** `unknown | T` is still `unknown`; T is the phantom result type (see JobResult). */
export type JobPayload<T = unknown> = unknown | T;

export interface Job<T = unknown> {
  readonly kind: JobKind;
  readonly priority?: JobPriority;         // default "normal"
  readonly payload: JobPayload<T>;         // transferable or structured-cloneable
  readonly signal?: AbortSignal;           // optional external cancellation
  transfer?: Transferable[];               // ownership moves to the worker
}

export type JobKind =
  | "decode-gltf"
  | "decode-ktx2"
  | "decode-image"
  | "decode-audio"
  | "build-atlas"
  | "build-navmesh"
  | "compress-save"
  | "hash-bytes";

export interface JobHandle {
  readonly id: number;                     // monotonic u32, never reused
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
  /**
   * Move completed results into the caller's array once per tick, sorted by
   * ascending job id. Never called from a worker callback. Allocates only
   * when the caller's array must grow (cold path).
   */
  drainCompleted(out: JobResult[]): JobResult[];
  readonly pending: number;
  readonly running: number;
  dispose(): void;
}
```

Job rules (normative):

- The main thread owns simulation; workers own decode/compression/navmesh bytes.
- A worker never receives an `Entity`, `Scene`, component, GPU handle, `AssetHandle` or callback. Payloads are `ArrayBuffer`, typed arrays, strings, numbers and plain records of those.
- Cancellation is cooperative and terminal: a cancelled job's late result is discarded by id and never delivered. The worker is not killed; it finishes and its result is dropped.
- Results are delivered only at tick boundaries through `drainCompleted`, sorted by id, so two runs with the same schedule produce the same application order.
- A worker crash or `postMessage` failure surfaces `E_WORKER_FAILED` once for the affected job, increments a counter, and falls back to main-thread work for that job kind where a fallback exists (decode). It never produces a blank screen.
- The pool size is `min(4, max(1, hardwareConcurrency - 1))`, created lazily on first schedule.
- A job result becomes visible to a game only after the runtime applies it in `onTick`; a job may not mutate simulation state.
- No single main-thread task caused by a job may exceed 8 ms (00 §5.6).

### 3.7 Host adapter contract

`packages/runtime` keeps its composition role. The engine loop knows nothing about input, sockets or games.

```ts
export interface HostLoopWiring {
  readonly now: () => number;
  readonly raf: (cb: (nowMs: number) => void) => number;
  readonly cancel: (id: number) => void;
  /** Called once per fixed step, exactly where simulate() is called today. */
  readonly onTick: (dt: number) => void;
  /** Called once per display frame, including paused frames. */
  readonly onRender: (alpha: number) => void;
  readonly onFrameStats?: (stats: FrameStatsView) => void;
  readonly onPauseChange?: (paused: boolean, reasons: number) => void;
}
```

The host adapter (`GameHost`, integration-agent owned) keeps the existing tick order inside `onTick`:

1. `TiltIntegrator.update(dt, snapshot)` for each slot.
2. `InputMapper.pollAll(loop.tick)` — exactly once per tick, never per render.
3. `InputReader.update(snapshot)`.
4. Drain queued controller events; `game.onEvent` before `simulate`.
5. `game.simulate(dt, snapshot)`.
6. Apply drained job results in id order, if the runtime has any (after `simulate`, before the next render).
7. `scene.updateWorldTransforms()` once, if the host has an engine scene (03 §5.6). This is engine-only, never calls game code, and is a no-op for the legacy 2D games.

Steps 1–6 preserve today's game-visible order exactly; step 7 is additive.

`onRender(alpha)` calls `game.render(alpha)` once. Paused frames still call it with `alpha = 0`, matching today. `GameHost.pause()`/`resume()` now call `loop.holdPause("menu")` releases and/or `loop.pause()`/`resume()`; the aggregate pause state is the single source of truth.

The host adapter must not poll input in a render callback, must not call `simulate` from `onRender`, and must not start a second loop.

### 3.8 Fixed vs variable step policy

| Policy | M0–M2 | Rule |
|---|---|---|
| Simulation | Fixed 60 Hz | `dt` is always `1/60`. Games never see a variable `dt`. |
| Rendering | Variable | One `onRender(alpha)` per display frame. `alpha` interpolates the last two simulation states. |
| Catch-up | Clamped | At most 5 steps per frame, at most 83.3 ms accumulated. |
| Background | Paused | Hidden tab, host pause, menu, network loss, context loss hold a pause reason. |
| Game-requested slow motion | Forbidden in simulation | Slow motion is a game-level time scale applied inside `simulate`, not a loop `dt` change. |
| Fast-forward / replay | Explicit | Trace replay calls `onTick` directly `N` times with a fake scheduler; it never runs the wall clock faster. |

A future variable-step mode requires a new spec and an amendment; it must not be added as a `tickHz` option.

---

## 4. Data formats

This spec introduces no persisted engine file. It owns two test-only formats.

### 4.1 Benchmark result (`bench-loop.json`, test-only)

```json
{
  "formatVersion": 1,
  "engineVersion": "0.1.0",
  "buildHash": "sha256:…",
  "scene": "loop-overhead",
  "browser": "Chrome 155.0.0.0",
  "os": "Windows 11 10.0.26300",
  "device": "desktop",
  "gpuAdapter": "…",
  "viewport": { "width": 1920, "height": 1080, "dpr": 1 },
  "warmupFrames": 120,
  "measuredFrames": 600,
  "frameMs": { "p50": 0, "p95": 0, "max": 0 },
  "loopWorkMs": { "p50": 0, "p95": 0, "max": 0 },
  "simTicksPerFrame": { "min": 0, "max": 0, "mean": 0 },
  "longFrames": 0,
  "overBudgetFrames": 0
}
```

Rules: all numbers are measured, never filled from a spec. A row missing `browser`, `os`, `buildHash` or frame count is not evidence. `docs/RESULTS.md` is the only record that turns this file into a PASS.

### 4.2 Replay fixture (`replay-<ticks>.json`, test-only)

Reuses the format declared in 00 §5.8. `01` owns the first fixture, `packages/engine/core/test/fixtures/replay-600.json`:

```json
{
  "version": 1,
  "engineVersion": "0.1.0",
  "gameId": "loop-replay-probe",
  "seed": 1,
  "ticks": 600,
  "packets": [{ "tick": 0, "slot": 1, "buttons": 0, "edges": 0, "lx": 0, "ly": 0, "rx": 0, "ry": 0, "lt": 0, "rt": 0 }]
}
```

The fixture is JSON, not a wire format. A replay passes when the FNV-1a hash of the final simulation state matches on the same build and browser; changing `seed` changes the hash (ER-00-06).

### 4.3 Worker message envelope (structured clone, not persisted)

| Field | Type | Rule |
|---|---|---|
| `v` | number | `1` |
| `kind` | `"init" \| "job" \| "cancel" \| "result" \| "error" \| "progress"` | Discriminator |
| `id` | number | Job id, u32, 0 for `init` |
| `jobKind` | `JobKind?` | Present on `job`/`result`/`error` |
| `payload` | transferable / cloneable | Never a DOM node, function, GPU handle or class instance |
| `bytes` | number? | Progress bytes for `progress` |

Transfer lists are passed as the second `postMessage` argument, not inside `payload`. Byte order inside payloads is the owning codec's concern (spec 06).

---

## 5. Architecture

### 5.1 Modules

```
engine-core/src/
  time/
    types.ts          EngineFrame, FixedLoop, FixedLoopOptions, pause reasons
    LoopClock.ts      accumulator/tick arithmetic, pure
    FixedLoop.ts      EngineLoop: scheduler, pause ownership, stats wiring
    FrameStats.ts     fixed-capacity ring, percentiles
    PauseReasons.ts   bitmask + token helpers
  jobs/
    types.ts          Job, JobHandle, JobResult, JobSystem
    JobQueue.ts       priority queues, id allocation, deterministic drain
    WorkerProtocol.ts message types + guards
  platform/
    frameScheduler.ts createBrowserScheduler(), ManualScheduler
```

`engine-core/src/time/` imports only `engine-core/src/math/` types when a consumer needs them; the loop itself imports no math.

### 5.2 Frame path

```
requestAnimationFrame(nowMs)
        │
        ▼
EngineLoop.frame(nowMs)
  ├─ read aggregate pause state (bitmask)
  ├─ if paused: steps = 0, alpha = 0, lastMs re-baselined each frame
  ├─ else: steps = LoopClock.beginFrame(nowMs)
  ├─ for step in 0..steps-1:
  │     consumeStep(); onTick(dt); frame.tick = clock.tick
  ├─ frame.alpha = clock.alpha(paused)
  ├─ frame.frameMs = measured delta
  ├─ stats.record(...)
  ├─ onFrameStats(statsView)         (optional)
  ├─ onRender(frame.alpha)           (once, paused included)
  └─ schedule next frame if running
```

Ordering is normative: simulation steps finish before `onRender`; `onFrameStats` runs before `onRender` so the overlay reflects the frame it is about to draw; exactly one `onRender` per scheduled frame; zero or more `onTick` per frame.

### 5.3 Pause ownership

A single boolean is not enough: a menu can close while the tab is still hidden, or the network can recover while a game menu is open. The loop stores a 32-bit bitmask; each `PauseReason` owns one bit.

- `holdPause(reason)` sets the bit and returns a release function that clears only that bit. Calling release twice is a no-op. Holding the same reason twice is reference-counted so two owners cannot accidentally resume each other.
- `pause()` is an alias for a manual hold that stays until `resume()`; `resume()` releases the manual hold only. It does not override `visibility` or `contextLoss`.
- `paused` is `bitmask !== 0`. `onPauseChange` fires only on aggregate 0→1 or 1→0 transitions.
- Entering pause resets the accumulator and renders once at alpha 0. Leaving pause re-baselines. This is the existing behaviour and is what prevents catch-up.
- Paused frames still request the next animation frame so the paused screen remains responsive. A stopped loop does not.

### 5.4 Time sources and clocks

| Clock | Source | Used for | Never used for |
|---|---|---|---|
| Wall/monotonic | `performance.now()` via injected `now`/rAF timestamp | Frame interval, stats, profiling | Simulation decisions |
| Simulation | `tick * dt` | Game logic, physics, animation | Display timing |
| Server | host client estimate (`serverNow()`) | Input fairness (Reaction Duel) | Engine loop |
| Audio | `AudioContext.currentTime` | Audio scheduling (spec 09) | Engine loop |
| Worker | none | None | Simulation |

No engine package calls `Date.now()`, `new Date()` or `setTimeout` in a simulation or frame path. Lint bans `Date` and `performance.now` outside `engine-core/src/platform/`, `engine-tooling` and the host shell.

### 5.5 Statistics hot path

`FrameStatsRing.record`:

1. Stores `frameMs`, `workMs`, `simTicks`, `alpha`, `tick` into preallocated `Float64Array`/`Int32Array` rings.
2. Increments counters and the head index.
3. Marks the snapshot dirty; percentiles are computed lazily in `snapshot()` at most once per frame.
4. Writes into the caller-provided mutable object; the returned view aliases it.

No arrays, objects, closures or strings are created per frame. `snapshot()` copies into a preallocated scratch array and insertion-sorts it in place; n ≤ 240.

### 5.6 Job pipeline

```
caller.schedule(job)
   → JobQueue.enqueue(id, priority, kind)
   → idle worker? postMessage({kind:"job", ...}, transfer)
        worker decodes/compresses/builds
   → postMessage({kind:"result", id, payload}, transfer)
   → JobQueue.complete(id, result)         (worker callback: enqueue only)
   → main thread tick boundary: drainCompleted(out) sorted by id
   → owner applies result (asset library, streamer, saver)
```

- Queue order is priority, then FIFO within priority. `critical` is reserved for boot assets; `normal` for visible streaming; `idle` for prefetch/audits.
- A completed result is held in a fixed-capacity ring until drained. If the ring is full, the worker retains the result and the main thread drains next tick; a result is never dropped silently. Overflow increments an `E_CONTRACT` counter and is reported in dev.
- Job ids are allocated from a monotonic u32 and never reused. After 2^32 jobs, the pool must be recreated at boot only; this is unreachable in a session.
- Applying a result must be O(result) and time-sliced if it exceeds 8 ms; the asset library and streamer own that slicing.

### 5.7 Worker boundaries

| Runs on main thread | Runs in worker | May cross the boundary |
|---|---|---|
| `simulate`, `onTick`, input polling, scene mutation | GLB parse, KTX2 transcode, image decode, audio decode | `ArrayBuffer`, typed arrays, strings, numbers, plain records |
| Render command encoding, GPU calls | Atlas packing, navmesh build, save compression, hashing | Transferables (ownership moves) |
| Game lifecycle, asset handle refcounts | — | Job ids and result envelopes |
| Applying results at tick boundary | — | — |

Never crossed: functions, promises, DOM nodes, `WebGL*`/`GPU*` objects, `Entity`, `Scene`, component values, `AssetHandle` instances, sockets. A payload that fails the structured-clone check is rejected in dev with `E_CONTRACT`, not retried.

### 5.8 Host adapter and migration

1. Move `packages/runtime/src/loop/FixedLoop.ts` and `types.ts` into `engine-core/src/time/`. Keep `TICK_HZ`, `DT`, clamp and pause semantics exactly.
2. `packages/runtime/src/loop/FixedLoop.ts` becomes a deprecated re-export from `@lanpad/engine-core` so existing runtime tests and imports keep compiling for one wave.
3. `GameHost` replaces its constructor wiring: `new FixedLoop({ simulate, render }, deps)` becomes `new EngineLoop({ onTick: this.simulateTick, onRender: this.renderFrame, now, raf, cancel, onFrameStats })`.
4. `GameHost.simulateTick` performs its current sequence (tilt → input update → events → `game.simulate`) and adds job-result application after `game.simulate` only if the runtime has jobs. No game-visible timing change.
5. `pause()`/`resume()` become pause-reason holds; `attachVisibilityPause` calls `holdPause("visibility")` and releases on visible.
6. Delete the runtime re-export at M1. No game imports the loop directly.

### 5.9 Hot-path rules

- The loop allocates everything at construction: one `EngineFrame`, one `FrameStatsView`, one stats ring, pause tokens per reason (max 6), one bound frame callback.
- `frame` is the same object every frame; the `onTick`/`onRender` callbacks are bound once.
- No `try/catch` in the frame path beyond the existing `GameHost` failure guards; an exception stops the loop through `onError`, not through a retry loop.
- No `await` inside `onTick`. Jobs are scheduled and drained; they are never awaited in a frame.

---

## 6. File ownership

**This spec owns:** `docs/engine/01-core-loop-time.md` and the paths below. It owns no implementation in this wave.

| Path | Contents | Owner |
|---|---|---|
| `packages/engine/core/src/time/types.ts` | `EngineFrame`, `FixedLoop`, `FixedLoopOptions`, pause reason types | 01 |
| `packages/engine/core/src/time/LoopClock.ts` | Accumulator, tick, alpha arithmetic | 01 |
| `packages/engine/core/src/time/FixedLoop.ts` | `EngineLoop` scheduler, pause ownership, stats wiring | 01 |
| `packages/engine/core/src/time/FrameStats.ts` | Fixed-capacity ring, percentiles, `FrameStatsView` | 01 |
| `packages/engine/core/src/time/PauseReasons.ts` | Bitmask and idempotent hold tokens | 01 |
| `packages/engine/core/src/time/index.ts` | Barrel export | 01 |
| `packages/engine/core/src/jobs/types.ts` | `Job`, `JobHandle`, `JobResult`, `JobSystem`, `JobKind` | 01 |
| `packages/engine/core/src/jobs/JobQueue.ts` | Priority queues, id allocation, completed ring, deterministic drain | 01 |
| `packages/engine/core/src/jobs/WorkerProtocol.ts` | Envelope types and runtime guards | 01 |
| `packages/engine/core/src/jobs/index.ts` | Barrel export | 01 |
| `packages/engine/core/src/platform/frameScheduler.ts` | `FrameScheduler`, `createBrowserScheduler`, `ManualScheduler` | 01 |
| `packages/engine/core/src/platform/index.ts` | Barrel export | 01 |
| `packages/engine/core/test/time/*.test.ts` | Loop, clock, pause, stats unit and property tests | 01 |
| `packages/engine/core/test/jobs/*.test.ts` | Queue order, cancellation, drain determinism | 01 |
| `packages/engine/core/test/fixtures/replay-600.json` | Replay fixture (00 §5.8) | 01 |
| `packages/engine/core/test/fixtures/bench-loop.json` | Benchmark result fixture shape | 01 |
| `packages/runtime/src/loop/FixedLoop.ts` | Deprecated re-export after migration | integration agent |
| `packages/runtime/src/game/GameHost.ts` | Host adapter wiring (`onTick`/`onRender`), pause reasons | integration agent |
| `packages/runtime/test/fixedLoop.test.ts` | Existing tests kept green; new adapter tests added by integration | integration agent |

**Not owned by this spec:** `engine-core/src/math/**` (02), `scene/**` (03), `render/contract.ts` (04), the job pool's concrete `Worker` adapter in `packages/runtime/src/jobs/**` (integration agent, implementing this spec's `JobSystem`), the profiler UI (16), the benchmark page (19).

---

## 7. Acceptance

**Evidence rule:** every row is PASS only with a recorded build, device, browser version, date and numbers in `docs/RESULTS.md`. A row that has not run says PENDING and names the run it needs. Targets below are acceptance thresholds, not measurements.

| ID | Criterion | Fixture / method | Hardware / environment | State |
|---|---|---|---|---|
| ER-01-01 | At 30, 60, 120 and 144 Hz simulated for one wall-clock second, exactly 60 ticks run; alpha is always in `[0,1)`; each frame runs 0–5 steps | `packages/engine/core/test/time/loop.test.ts` with `ManualScheduler` | CI Node 20 | PENDING — test authoring |
| ER-01-02 | A 2,000 ms stall runs exactly 5 steps; no backlog survives; two more stalls add exactly 10 steps | Same fixture, `step(2000)` | CI Node 20 | PENDING |
| ER-01-03 | Pausing for 10 s of scheduler time runs 0 ticks; resuming then one 16.7 ms frame runs exactly 1; paused frames still call `onRender(0)` | Loop test with fake scheduler | CI Node 20 | PENDING |
| ER-01-04 | Six pause reasons held and released in interleaved order resume only when the last is released; double release is a no-op; `onPauseChange` fires exactly twice per aggregate transition | `pauseReasons.test.ts` | CI Node 20 | PENDING |
| ER-01-05 | `LoopClock.beginFrame` is monotonic and never returns more than `maxCatchUpSteps`; property test over random deltas including NaN, Infinity, negative and 1e9 | `fast-check`, 10,000 cases | CI Node 20 | PENDING |
| ER-01-06 | `FrameStatsRing` p50/p95/max match a reference sort for 10,000 random samples within 1e-9; snapshots reuse caller-owned objects after construction (heap growth is measured in ER-01-07) | `frameStats.test.ts` | CI Node 20 | PENDING |
| ER-01-07 | 10,000 frames at 60 Hz after 120 warm-up: heap growth ≤ 512 KiB; no loop-owned allocation site appears in the allocation profile | `experiments/e-m0-engine/?bench=1&alloc=1` | Desktop Chrome 155, Windows 11; adapter name recorded | PENDING — needs the M0 page |
| ER-01-08 | Loop CPU cost (frame callback minus `onTick`+`onRender` work) p95 ≤ 0.5 ms at 60 Hz, ≤ 3.6% of the 14 ms frame budget | Same page, `loopWorkMs` in `bench-loop.json` | Desktop Chrome 155, Windows 11 | PENDING — needs the M0 page |
| ER-01-09 | A 600-tick replay run twice produces the same FNV-1a state hash; changing the seed changes it | `fixtures/replay-600.json` compiled by test game | CI Node 20 + Desktop Chrome 155 | PENDING — fixture authored with this spec |
| ER-01-10 | 32 jobs scheduled in mixed priorities dispatch by priority band; `drainCompleted` returns completed results in globally ascending id; a cancelled job's late result is discarded; a worker crash delivers `E_WORKER_FAILED` once and does not stop the loop | `jobs/jobQueue.test.ts` + fake worker | CI Node 20 | PENDING |
| ER-01-11 | No main-thread task caused by job apply exceeds 8 ms during a 5 MB asset load | PerformanceObserver `longtask`, asset fixture shared with 06 | Desktop Chrome 155, Windows 11 | PENDING — needs spec 06 |
| ER-01-12 | Existing Coin Run and Reaction Duel tests stay green after the loop move; game-visible tick order is unchanged | Existing game tests + `GameHost` adapter test | CI Node 20 | PENDING — migration wave |
| ER-01-13 | TV profile runs the loop at its display cadence with the same tick rate; p95 frame interval and loop work recorded | `experiments/e-m0-engine/?bench=1` on TV profile | **PENDING device:** 2020-era Android TV Chromium and a Tizen/webOS set (SPEC §12) | PENDING — no TV hardware |

---

## 8. Test plan

| Layer | Scope | Location |
|---|---|---|
| Unit | Clock step counts, clamp, alpha, pause reasons, stats percentiles, job queue order/cancel | `packages/engine/core/test/time/*.test.ts`, `test/jobs/*.test.ts` |
| Property (`fast-check`) | Arbitrary frame deltas produce 0–5 steps and a valid alpha; tick never decreases; pause hold/release is a commutative multiset | `test/time/loop.property.test.ts` |
| Golden | 600-tick replay hash; `bench-loop.json` shape validation | `test/fixtures/` |
| Integration | `GameHost` + `EngineLoop` + `InputMapper` fake: poll once per tick, events before simulate, pause reasons from visibility/host/network, no game-visible timing change | `packages/runtime/test/loopAdapter.test.ts` (integration agent) |
| Contract | `JobSystem` fake and worker-adapter conformance: schedule, cancel, drain order, crash path, dispose idempotence | `test/jobs/jobSystem.conformance.test.ts` |
| Benchmark | Loop overhead, allocation growth, stats overhead | `experiments/e-m0-engine/?bench=1` (19) |
| Manual | TV cadence, hidden-tab behaviour on real TV browsers | Device matrix, `docs/RESULTS.md` |

Test rules:

- Every title carries its `ER-01-NN` (or existing `FR-9.x`/`PR-9.3`) ID; the ID resolves to a traceability row.
- No fixed sleeps. `ManualScheduler` makes every timing test deterministic.
- The loop tests run in Node; browser-only claims are measured on the benchmark page, never asserted from Node.
- A failing performance row is a report, not a skipped test. It never blocks a correctness test from running.

---

## 9. Dependencies

| Dependency | Why | Status |
|---|---|---|
| `00-architecture.md` | Package path, `EngineFrame`/`FixedLoop`/`FixedLoopOptions` names, error taxonomy, job/thread rules | Written |
| `02-math.md` | Not required by the loop; required by consumers that consume `EngineFrame` transforms | Written in the same wave |
| `03-scene-ecs.md` | Consumes `onTick` and the tick boundary for transform updates; not a dependency of the loop itself | Written in the same wave |
| `10-input.md` | Host adapter polls the action map inside `onTick`; the loop itself never sees input | Later |
| `16-tooling-profiler.md` | Owns budgets (16.7/20 ms), overlay, allocation profiling; consumes `FrameStatsView` | Later |
| `19-testing-benchmarks.md` | Owns the benchmark page and `docs/RESULTS.md` rows; this spec owns the Node fixtures | Later |
| Root integration (00 §5.16) | Workspace entry, tsconfig reference, Vitest project, eslint `Date`/`performance.now` bans | Integration wave |

No third-party runtime dependency. No DOM import outside `engine-core/src/platform/`.

---

## 10. Risks

| ID | Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|---|
| R1 | Float accumulation makes alpha hit exactly 1 or a frame run 6 steps | Medium | Visual jitter, test flake | Explicit rounding rule in §3.3; property test over 10k random deltas; clamp is normative |
| R2 | Pause reasons leak (a menu closes without releasing) | Medium | Game freezes with no visible cause | Idempotent tokens; `pausedBy` in debug overlay; integration test for every reason; host shell owns release in `finally` paths |
| R3 | A hidden TV tab delivers a huge rAF gap and the game fast-forwards | High without clamp | Lost game state | 5-step / 83.3 ms clamp; visibility hold; test ER-01-03 |
| R4 | Job results applied mid-tick cause nondeterminism | Medium | Replay mismatch | `drainCompleted` only at tick boundary, sorted by id; no callbacks into simulation |
| R5 | Worker unavailability on a TV browser | Medium | Decode stalls | Main-thread fallback with 8 ms time slicing; `E_WORKER_FAILED` path tested |
| R6 | The migration changes game-visible timing | Medium | Existing games break | Host adapter keeps the exact tick order; existing loop tests and game tests stay green; serial integration wave |
| R7 | Stats percentiles allocate or cost too much | Low | Per-frame GC on TV | Fixed ring, preallocated scratch, insertion sort n ≤ 240; alloc benchmark |
| R8 | Someone adds a variable `dt` for a game | Medium | Physics/replay break | Non-goal stated; `dt` is readonly `1/60`; lint/test rejects a changed `dt` |
| R9 | `performance.now` or `Date` enters simulation | Medium | Nondeterminism | Lint ban (00 D11); only `platform/` and host shell may read wall time |
| R10 | Over-engineered job system before a real consumer | Medium | Wasted wave | M0 implements interface + deterministic queue; the concrete worker pool lands with spec 06, the first real consumer |

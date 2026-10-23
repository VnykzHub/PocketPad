/**
 * Loop, clock, scheduler and frame-statistics contracts (spec 01).
 *
 * Frozen names from 00 §3.2 (`EngineFrame`, `FixedLoop`, `FixedLoopOptions`)
 * are preserved. Additive 01 members are optional, so a caller that supplies
 * only the 00 fields keeps the original behaviour.
 */

/** 00 §3.1 / 01 §3.1. One pooled object, mutated once per frame. */
export interface EngineFrame {
  /** Host simulation tick, integer, starts at 0. */
  readonly tick: number;
  /** Seconds, exactly 1/60. */
  readonly dt: number;
  /** Render interpolation in [0, 1). */
  readonly alpha: number;
  /** Measured display-frame interval. */
  readonly frameMs: number;
}

export interface FixedLoop {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  readonly running: boolean;
  readonly tick: number;
}

/**
 * Loop options. The first eight members are the frozen 00 §3.1 surface; the
 * optional statistics and pause hooks are additive per 01 §3.2.
 */
export interface FixedLoopOptions {
  /** M0: exactly 60. */
  readonly tickHz?: 60;
  /** Death-spiral clamp; default 5. */
  readonly maxCatchUpSteps?: 5;
  /** Monotonic milliseconds. */
  readonly now: () => number;
  readonly raf: (cb: (nowMs: number) => void) => number;
  readonly cancel: (id: number) => void;
  readonly onTick: (dt: number) => void;
  readonly onRender: (alpha: number) => void;
  /** Receives the loop's single reused stats object; copy what you keep. */
  readonly onFrameStats?: (stats: FrameStatsView) => void;
  /** Fired only when the aggregate paused state changes. */
  readonly onPauseChange?: (paused: boolean, reasons: number) => void;
  /** Optional measured CPU work of the whole frame, supplied by the host. */
  readonly onFrameWork?: () => number;
}

/** Pause ownership reasons; each owns one bit of `pausedBy` (01 §3.2). */
export type PauseReason =
  | "visibility"
  | "hostPause"
  | "menu"
  | "network"
  | "contextLoss"
  | "manual";

/** Concrete `FixedLoop` implementation (01 §3.2). */
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
   * Holds one pause reason; the loop is paused while at least one reason is
   * held. Idempotent; releases only this hold.
   */
  holdPause(reason: PauseReason): () => void;
  /** PauseReason bitmask. */
  readonly pausedBy: number;
}

/** Pure accumulator arithmetic (01 §3.3). */
export class LoopClock {
  constructor(dtSeconds: number, maxCatchUpSteps: number);
  /** Discards accumulated time and re-baselines the wall clock. */
  reset(nowMs: number): void;
  /** Adds one frame interval and returns the fixed steps to run, 0..max. */
  beginFrame(nowMs: number): number;
  /** Consumes one step: tick += 1, accumulator -= dt. */
  consumeStep(): void;
  /** alpha = accumulator / dt in [0, 1); zero while paused. */
  alpha(paused: boolean): number;
  readonly tick: number;
  readonly accumulatorSeconds: number;
  readonly dt: number;
}

/** Frame callback source (01 §3.4). */
export interface FrameScheduler {
  /** Monotonic, same clock as callbacks. */
  readonly nowMs: number;
  request(cb: (nowMs: number) => void): number;
  cancel(id: number): void;
}

/** Browser adapter; the only loop helper allowed to name requestAnimationFrame. */
export function createBrowserScheduler(): FrameScheduler;

/** Deterministic test scheduler. */
export class ManualScheduler implements FrameScheduler {
  readonly nowMs: number;
  request(cb: (nowMs: number) => void): number;
  cancel(id: number): void;
  step(ms: number): void;
  stepTo(ms: number): void;
}

/** Reused statistics snapshot (01 §3.5). */
export interface FrameStatsView {
  /** Display interval of the last frame. */
  readonly frameMs: number;
  /** Measured CPU work; 0 when unmeasured. */
  readonly workMs: number;
  /** Steps run this frame, 0..maxCatchUpSteps. */
  readonly simTicks: number;
  /** [0, 1). */
  readonly alpha: number;
  /** Tick after this frame's steps. */
  readonly tick: number;
  /** Frames recorded since construction/reset. */
  readonly frames: number;
  /** Frames with frameMs > 16.7. */
  readonly longFrames: number;
  /** Frames with frameMs > 20 (SPEC hard-fail threshold). */
  readonly overBudgetFrames: number;
  readonly p50FrameMs: number;
  readonly p95FrameMs: number;
  readonly maxFrameMs: number;
}

/** Caller-owned snapshot target; same fields, mutable for reuse. */
export type MutableFrameStats = {
  -readonly [K in keyof FrameStatsView]: FrameStatsView[K];
};

/** Fixed-capacity statistics ring (01 §3.5). */
export class FrameStatsRing {
  /** Default 240 frames; minimum 8. */
  constructor(capacity?: number);
  record(
    frameMs: number,
    workMs: number,
    simTicks: number,
    alpha: number,
    tick: number,
  ): void;
  /** Writes into a caller-owned object; allocates nothing after construction. */
  snapshot(out: MutableFrameStats): FrameStatsView;
  reset(): void;
}

/**
 * Host adapter contract (01 §3.7). `onTick` keeps the existing order:
 *
 * 1. `TiltIntegrator.update(dt, snapshot)` for each slot.
 * 2. `InputMapper.pollAll(loop.tick)` exactly once per tick.
 * 3. `InputReader.update(snapshot)`.
 * 4. Drain queued controller events; `game.onEvent` before `simulate`.
 * 5. `game.simulate(dt, snapshot)`.
 * 6. Apply drained job results in ascending id order.
 * 7. `scene.updateWorldTransforms()` once, engine-only, after jobs.
 *
 * Steps 1–6 preserve the legacy game-visible order; step 7 is additive.
 */
export interface HostLoopWiring {
  readonly now: () => number;
  readonly raf: (cb: (nowMs: number) => void) => number;
  readonly cancel: (id: number) => void;
  /** Called once per fixed step. */
  readonly onTick: (dt: number) => void;
  /** Called once per display frame, including paused frames. */
  readonly onRender: (alpha: number) => void;
  readonly onFrameStats?: (stats: FrameStatsView) => void;
  readonly onPauseChange?: (paused: boolean, reasons: number) => void;
}

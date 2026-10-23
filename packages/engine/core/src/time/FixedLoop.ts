/**
 * Fixed-timestep engine loop (spec 01 §3.2, §5.2, §5.3, §5.9).
 *
 * One reused `EngineFrame` and one reused stats view are allocated at
 * construction. The frame path performs zero allocation: no closures, arrays,
 * objects or strings per frame.
 *
 * Timeline of one scheduled frame:
 *   paused state -> (paused) re-baseline, 0 steps, alpha 0
 *                -> (running) LoopClock.beginFrame, N x consumeStep/onTick
 *   alpha -> frame fields -> stats.record -> onFrameStats -> onRender
 *   -> schedule the next frame while running (paused frames keep rendering)
 *
 * The loop never reads `document`, `performance`, `Date` or a timer. The host
 * injects `now`, `raf` and `cancel`; `createBrowserScheduler()` in
 * `src/platform/` is the only convenience adapter that names rAF.
 */
import type {
  EngineFrame,
  FixedLoop,
  FixedLoopOptions,
  FrameStatsView,
  MutableFrameStats,
  PauseReason,
} from "../contracts/time.js";
import { FrameStatsRing } from "./FrameStats.js";
import { LoopClock } from "./LoopClock.js";
import { PauseReasons } from "./PauseReasons.js";
import { DEFAULT_MAX_CATCH_UP_STEPS, DT_SECONDS, TICK_HZ } from "./types.js";

const DEFAULT_STATS_CAPACITY = 240;

interface MutableEngineFrame {
  tick: number;
  dt: number;
  alpha: number;
  frameMs: number;
}

function createStatsView(): MutableFrameStats {
  return {
    frameMs: 0,
    workMs: 0,
    simTicks: 0,
    alpha: 0,
    tick: 0,
    frames: 0,
    longFrames: 0,
    overBudgetFrames: 0,
    p50FrameMs: 0,
    p95FrameMs: 0,
    maxFrameMs: 0,
  };
}

/** Idempotent release returned after disposal; no closure per hold. */
function noopRelease(): void {
  /* the loop is disposed; the hold is intentionally ignored */
}

export class EngineLoop implements FixedLoop {
  private readonly nowFn: () => number;
  private readonly rafFn: (cb: (nowMs: number) => void) => number;
  private readonly cancelFn: (id: number) => void;
  private readonly onTick: (dt: number) => void;
  private readonly onRender: (alpha: number) => void;
  private readonly onFrameStats: ((stats: FrameStatsView) => void) | undefined;
  private readonly onPauseChange: ((paused: boolean, reasons: number) => void) | undefined;
  private readonly onFrameWork: (() => number) | undefined;

  private readonly clock: LoopClock;
  private readonly pauseReasons = new PauseReasons();
  private readonly stats = new FrameStatsRing(DEFAULT_STATS_CAPACITY);
  private readonly statsView: MutableFrameStats = createStatsView();
  private readonly frameState: MutableEngineFrame = {
    tick: 0,
    dt: DT_SECONDS,
    alpha: 0,
    frameMs: 0,
  };

  /** Pooled, mutated once per frame; do not retain across frames. */
  readonly frame: EngineFrame = this.frameState;

  private runningValue = false;
  private disposedValue = false;
  private rafId: number | null = null;
  private lastNowMs = Number.NaN;
  private manualPauseRelease: (() => void) | null = null;

  private readonly frameCallback = (nowMs: number): void => {
    this.runFrame(nowMs);
  };

  constructor(options: FixedLoopOptions) {
    if (options.tickHz !== undefined && options.tickHz !== TICK_HZ) {
      throw new RangeError(`tickHz must be exactly ${TICK_HZ} in M0`);
    }
    const maxCatchUpSteps = options.maxCatchUpSteps ?? DEFAULT_MAX_CATCH_UP_STEPS;
    if (!Number.isInteger(maxCatchUpSteps) || maxCatchUpSteps < 1) {
      throw new RangeError("maxCatchUpSteps must be a positive integer");
    }

    this.clock = new LoopClock(DT_SECONDS, maxCatchUpSteps);
    this.nowFn = options.now;
    this.rafFn = options.raf;
    this.cancelFn = options.cancel;
    this.onTick = options.onTick;
    this.onRender = options.onRender;
    this.onFrameStats = options.onFrameStats;
    this.onPauseChange = options.onPauseChange;
    this.onFrameWork = options.onFrameWork;
  }

  get running(): boolean {
    return this.runningValue;
  }

  get paused(): boolean {
    return this.pauseReasons.paused;
  }

  /** PauseReason bitmask (01 §3.2). */
  get pausedBy(): number {
    return this.pauseReasons.mask;
  }

  get tick(): number {
    return this.clock.tick;
  }

  get dt(): number {
    return this.clock.dt;
  }

  /**
   * Begin scheduling frames. Idempotent while running. Re-baselines the clock,
   * so time before `start()` is never simulated. Held pause reasons persist:
   * a hidden tab is still hidden after a stop/start cycle.
   */
  start(): void {
    if (this.disposedValue) {
      throw new Error("EngineLoop cannot start after dispose()");
    }
    if (this.runningValue) {
      return;
    }
    this.runningValue = true;
    this.rebaselineClock();
    this.rafId = this.rafFn(this.frameCallback);
  }

  /** Stop scheduling frames; the pending callback is cancelled. */
  stop(): void {
    if (!this.runningValue) {
      return;
    }
    this.runningValue = false;
    if (this.rafId !== null) {
      this.cancelFn(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Manual pause hold. Idempotent until `resume()`. Entering the aggregate
   * paused state renders once at alpha 0 and discards accumulated time.
   */
  pause(): void {
    if (this.disposedValue || this.manualPauseRelease !== null) {
      return;
    }
    this.manualPauseRelease = this.holdPause("manual");
  }

  /** Releases only the manual hold; visibility/network holds stay active. */
  resume(): void {
    const release = this.manualPauseRelease;
    if (release === null) {
      return;
    }
    this.manualPauseRelease = null;
    release();
  }

  /**
   * Holds one pause reason; the loop is paused while any reason is held.
   * Returns an idempotent release token for that hold.
   */
  holdPause(reason: PauseReason): () => void {
    if (this.disposedValue) {
      return noopRelease;
    }

    const wasPaused = this.pauseReasons.paused;
    const releaseReason = this.pauseReasons.hold(reason);
    const nowPaused = this.pauseReasons.paused;
    if (!wasPaused && nowPaused) {
      this.enterPause();
    }

    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      if (this.disposedValue) {
        return;
      }
      const before = this.pauseReasons.paused;
      releaseReason();
      if (before && !this.pauseReasons.paused) {
        this.leavePause();
      }
    };
  }

  /** Stops the loop, cancels the pending frame and clears pause state. */
  dispose(): void {
    if (this.disposedValue) {
      return;
    }
    this.disposedValue = true;
    this.runningValue = false;
    if (this.rafId !== null) {
      this.cancelFn(this.rafId);
      this.rafId = null;
    }
    this.manualPauseRelease = null;
    this.pauseReasons.clear();
  }

  private enterPause(): void {
    this.frameState.alpha = 0;
    this.rebaselineClock();
    if (this.onPauseChange !== undefined) {
      this.onPauseChange(true, this.pauseReasons.mask);
    }
    if (this.runningValue) {
      this.onRender(0);
    }
  }

  private leavePause(): void {
    this.rebaselineClock();
    if (this.onPauseChange !== undefined) {
      this.onPauseChange(false, 0);
    }
  }

  private rebaselineClock(): void {
    if (this.disposedValue) {
      return;
    }
    const nowMs = this.nowFn();
    this.clock.reset(nowMs);
    this.lastNowMs = nowMs;
  }

  /** One scheduled frame. Allocates nothing. */
  private runFrame(nowMs: number): void {
    this.rafId = null;
    if (!this.runningValue || this.disposedValue) {
      return;
    }

    const previousMs = this.lastNowMs;
    this.lastNowMs = nowMs;

    let frameMs = 0;
    if (Number.isFinite(previousMs)) {
      const deltaMs = nowMs - previousMs;
      if (Number.isFinite(deltaMs) && deltaMs > 0) {
        frameMs = deltaMs;
      }
    }

    let workMs = 0;
    if (this.onFrameWork !== undefined) {
      const measuredWorkMs = this.onFrameWork();
      if (Number.isFinite(measuredWorkMs) && measuredWorkMs > 0) {
        workMs = measuredWorkMs;
      }
    }

    const paused = this.pauseReasons.paused;
    let simTicks = 0;

    if (paused) {
      // Hidden tabs deliver large gaps; re-baselining every paused frame makes
      // the paused interval impossible to convert into catch-up steps.
      this.clock.reset(nowMs);
    } else {
      const steps = this.clock.beginFrame(nowMs);
      const dt = this.clock.dt;
      for (let step = 0; step < steps; step += 1) {
        this.clock.consumeStep();
        this.onTick(dt);
        simTicks += 1;
        if (!this.runningValue || this.disposedValue) {
          break;
        }
      }
    }

    if (this.disposedValue) {
      return;
    }

    const alpha = this.clock.alpha(paused);
    const frame = this.frameState;
    frame.tick = this.clock.tick;
    frame.dt = this.clock.dt;
    frame.alpha = alpha;
    frame.frameMs = frameMs;

    this.stats.record(frameMs, workMs, simTicks, alpha, frame.tick);
    if (this.onFrameStats !== undefined) {
      this.onFrameStats(this.stats.snapshot(this.statsView));
    }
    this.onRender(alpha);

    if (this.runningValue && !this.disposedValue) {
      this.rafId = this.rafFn(this.frameCallback);
    }
  }
}

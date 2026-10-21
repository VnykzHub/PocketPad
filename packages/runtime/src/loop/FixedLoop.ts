/**
 * Fixed-timestep loop for the host runtime (D3-RT-01).
 *
 * The contract is frozen in `docs/todos/phase-1-dev/D3-runtime-v0.md`:
 *
 * - Simulation advances in fixed 1/60 s steps; rendering runs once per
 *   animation frame with an interpolation alpha in [0, 1) (FR-9.1).
 * - A stalled frame contributes at most 5 steps (death-spiral clamp), so the
 *   accumulator cannot grow without bound.
 * - `pause()` stops simulation but keeps scheduling frames so the paused
 *   screen still renders; `resume()` re-baselines the clock, so time spent
 *   paused is never simulated (FR-9.2).
 * - Construction allocates everything the frame path needs. After that the
 *   loop only mutates preallocated fields, reuses the mapper's pooled snapshot
 *   and stats object, and invokes the stable hooks, with no DOM or socket
 *   access (PR-9.3).
 *
 * The loop is deliberately inert: it does not read `document`, sockets,
 * timers, `Date` or game state. `now`, `raf`, `cancel` and `mapper` are
 * injected; the host wires `performance.now` and `requestAnimationFrame`.
 */
import type { InputMapper } from "../input/InputMapper.js";
import type { FrameStats, LoopDependencies, LoopHooks } from "./types.js";

const TICK_HZ = 60;
const DT = 1 / TICK_HZ;
const MAX_CATCH_UP_STEPS = 5;
const MAX_ACCUMULATED_SECONDS = MAX_CATCH_UP_STEPS * DT;

export class FixedLoop {
  /** Simulation rate in hertz (FR-9.1). */
  readonly tickHz = TICK_HZ;
  /** Fixed simulation step in seconds. */
  readonly dt = DT;

  private readonly hooks: LoopHooks;
  private readonly nowFn: LoopDependencies["now"];
  private readonly rafFn: LoopDependencies["raf"];
  private readonly cancelFn: LoopDependencies["cancel"];
  private readonly mapper: InputMapper;
  /** Reused every frame; the overlay must copy any value it keeps. */
  private readonly stats: FrameStats = { frameMs: 0, simTicks: 0, alpha: 0 };

  private running = false;
  private paused = false;
  /** Seconds of frame time not yet simulated, always in [0, 5 * DT]. */
  private acc = 0;
  private lastMs = 0;
  private simTickValue = 0;
  private rafId: number | null = null;

  constructor(hooks: LoopHooks, deps: LoopDependencies) {
    this.hooks = hooks;
    this.nowFn = deps.now;
    this.rafFn = deps.raf;
    this.cancelFn = deps.cancel;
    this.mapper = deps.mapper;
  }

  /** Completed simulation ticks since construction. */
  get simTick(): number {
    return this.simTickValue;
  }

  /**
   * Begin scheduling frames. Idempotent while running. A stopped loop keeps
   * its tick count and accumulator; starting again clears the paused state and
   * re-baselines the clock so the stopped interval is not simulated.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.paused = false;
    this.lastMs = this.nowFn();
    this.rafId = this.rafFn(this.frame);
  }

  /** Stop scheduling frames; the pending callback is cancelled. */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.rafId !== null) {
      this.cancelFn(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Stop simulation but keep frames running so the paused screen renders with
   * alpha 0. Also renders once immediately, as the work item requires.
   */
  pause(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    if (this.running) {
      this.hooks.render(0);
    }
  }

  /**
   * Resume simulation. The clock baseline is reset here, so the wall-clock
   * time spent paused is never turned into catch-up steps.
   */
  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.lastMs = this.nowFn();
  }

  /**
   * One scheduled frame. Bound once at construction so the hot path allocates
   * nothing: no closures, arrays, objects or string building.
   */
  private readonly frame = (nowMs: number): void => {
    this.rafId = null;

    const deltaMs = nowMs - this.lastMs;
    this.lastMs = nowMs;

    if (!this.paused && deltaMs > 0) {
      this.acc += deltaMs / 1000;
      if (this.acc > MAX_ACCUMULATED_SECONDS) {
        this.acc = MAX_ACCUMULATED_SECONDS;
      }
    }

    let simTicks = 0;
    if (!this.paused) {
      while (this.acc >= DT) {
        this.hooks.simulate(DT, this.mapper.pollAll(this.simTickValue));
        this.acc -= DT;
        this.simTickValue += 1;
        simTicks += 1;
      }
    }

    const alpha = this.paused ? 0 : this.acc / DT;
    const stats = this.stats;
    stats.frameMs = deltaMs > 0 ? deltaMs : 0;
    stats.simTicks = simTicks;
    stats.alpha = alpha;

    if (this.hooks.onFrameStats !== undefined) {
      this.hooks.onFrameStats(stats);
    }

    this.hooks.render(alpha);

    if (this.running) {
      this.rafId = this.rafFn(this.frame);
    }
  };
}

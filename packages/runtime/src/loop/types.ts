/**
 * Fixed-loop contracts (D3-RT-01, frozen in
 * `docs/todos/phase-1-dev/D3-runtime-v0.md`).
 *
 * Everything the loop touches is injected: the clock, the frame scheduler and
 * the pooled input mapper. Nothing in this contract reads the DOM, a socket or
 * game state (FR-9.1, FR-9.2).
 */
import type { InputMapper } from "../input/InputMapper.js";
import type { InputSnapshot } from "../input/types.js";

/** Per-frame diagnostics consumed by the debug overlay (D3-RT-06). */
export interface FrameStats {
  /**
   * Wall-clock interval since the previous frame, in milliseconds (the rAF
   * timestamp delta). This is the display cadence, not the callback's work
   * time, so dynamic resolution can react to it (FR-9.5).
   */
  frameMs: number;
  /** Simulation steps executed in this frame, 0..5. */
  simTicks: number;
  /** Interpolation alpha handed to `render`, always in [0, 1). */
  alpha: number;
}

/** Game-facing callbacks. The loop calls `render` exactly once per frame. */
export interface LoopHooks {
  /** Advance the simulation by one fixed step. */
  simulate(dt: number, snapshot: InputSnapshot): void;
  /** Draw one frame; `alpha` interpolates between the last two sim states. */
  render(alpha: number): void;
  /**
   * Optional diagnostics sink. Receives the loop's single reused `FrameStats`
   * object, so subscribers must copy anything they retain.
   */
  onFrameStats?(stats: FrameStats): void;
}

/** Injected clock, scheduler and input source. */
export interface LoopDependencies {
  /**
   * Monotonic milliseconds, read on `start()` and `resume()` to baseline the
   * accumulator. Must share a clock with the timestamps passed to `raf`.
   */
  now: () => number;
  /** Schedules the next frame, e.g. `requestAnimationFrame`. */
  raf: (cb: (t: number) => void) => number;
  /** Cancels a scheduled frame, e.g. `cancelAnimationFrame`. */
  cancel: (id: number) => void;
  /** Pooled input source; `pollAll` runs once per simulation tick (FR-7.12). */
  mapper: InputMapper;
}

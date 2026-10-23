/**
 * Frame callback sources (spec 01 §3.4).
 *
 * `createBrowserScheduler` is the only helper in `engine-core` that names
 * `requestAnimationFrame` or `performance.now`; D11 confines DOM access to
 * `src/platform/`. `ManualScheduler` is the deterministic test double: time
 * only moves when a test calls `step`/`stepTo`, and each call dispatches at
 * most one pending callback, exactly like one display refresh.
 */
import type { FrameScheduler } from "../contracts/time.js";

/**
 * Browser adapter. The returned object resolves `performance.now` and rAF at
 * call time, so a test harness or a polyfill installed after construction is
 * still honoured. `request` throws the platform's own `ReferenceError` when
 * rAF is absent (non-browser consumers must inject a scheduler instead).
 */
export function createBrowserScheduler(): FrameScheduler {
  return {
    get nowMs(): number {
      return performance.now();
    },
    request(callback: (nowMs: number) => void): number {
      return requestAnimationFrame(callback);
    },
    cancel(id: number): void {
      cancelAnimationFrame(id);
    },
  };
}

interface PendingFrame {
  readonly id: number;
  readonly callback: (nowMs: number) => void;
}

/**
 * Deterministic scheduler for tests. `nowMs` starts at 0; `step(ms)` advances
 * by a relative amount, `stepTo(ms)` to an absolute time. Both dispatch the
 * oldest pending callback once, with the new time, after advancing. Callbacks
 * requested by that callback remain pending for the next step.
 */
export class ManualScheduler implements FrameScheduler {
  private currentMs = 0;
  private nextId = 1;
  private readonly pending: PendingFrame[] = [];

  get nowMs(): number {
    return this.currentMs;
  }

  /** Number of callbacks waiting for a step; useful in assertions. */
  get pendingCount(): number {
    return this.pending.length;
  }

  request(callback: (nowMs: number) => void): number {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.push({ id, callback });
    return id;
  }

  cancel(id: number): void {
    for (let index = 0; index < this.pending.length; index += 1) {
      if (this.pending[index]?.id === id) {
        this.pending.splice(index, 1);
        return;
      }
    }
  }

  /** Advances the clock by `ms` and runs one pending frame callback. */
  step(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("ManualScheduler.step requires a finite, non-negative delta");
    }
    this.advance(this.currentMs + ms);
  }

  /** Advances the clock to an absolute time and runs one pending callback. */
  stepTo(ms: number): void {
    if (!Number.isFinite(ms) || ms < this.currentMs) {
      throw new RangeError("ManualScheduler.stepTo cannot move the clock backwards");
    }
    this.advance(ms);
  }

  private advance(ms: number): void {
    this.currentMs = ms;
    const frame = this.pending.shift();
    if (frame !== undefined) {
      frame.callback(ms);
    }
  }
}

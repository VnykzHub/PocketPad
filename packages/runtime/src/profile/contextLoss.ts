/**
 * WebGL context-loss recovery (D3-RT-07).
 *
 * A TV browser can lose the WebGL context (driver reset, tab backgrounded on
 * a memory-constrained device, GPU process restart). Without a handler the
 * canvas goes black permanently. The recovery contract is:
 *
 * - on `webglcontextlost`, call `preventDefault()` so the browser will fire
 *   `webglcontextrestored`, pause frame sampling and keep the current render
 *   scale;
 * - on `webglcontextrestored`, resume sampling with fresh streaks, re-apply
 *   the preserved scale to the new backing store, and report the recovery.
 *
 * Quality continuity is deliberate: the scale is preserved across the loss, so
 * the picture does not jump back to 100% (which would likely cause a second
 * slow-frame spiral on a weak GPU). Both transitions are counted and delivered
 * to callbacks, so recovery is never silent.
 *
 * This module has no DOM dependency beyond the `EventTarget` interface; the
 * host attaches it to its real canvas, tests attach it to a plain
 * `EventTarget`.
 */
import type { ResolutionController } from "./resolutionController.js";

export type ContextLossPhase = "running" | "lost";

export interface ContextLossStatus {
  readonly phase: ContextLossPhase;
  readonly lossCount: number;
  readonly restoreCount: number;
  /** Duration of the most recent loss in milliseconds; 0 before recovery. */
  readonly lastLossDurationMs: number;
}

export interface ContextLossRecoveryOptions {
  /** Injected clock (tests); defaults to `performance.now` when available. */
  readonly now?: () => number;
  /** Controller to suspend while the context is gone and resume afterwards. */
  readonly controller?: ResolutionController;
  /** Called once per loss; show a "graphics restarting" state if desired. */
  readonly onLost?: (status: ContextLossStatus) => void;
  /** Called once per successful restore, after the controller resumes. */
  readonly onRestored?: (status: ContextLossStatus) => void;
}

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export class ContextLossRecovery {
  private readonly nowFn: () => number;
  private readonly controller: ResolutionController | undefined;
  private readonly onLost: ((status: ContextLossStatus) => void) | undefined;
  private readonly onRestored: ((status: ContextLossStatus) => void) | undefined;

  private phaseValue: ContextLossPhase = "running";
  private lossCountValue = 0;
  private restoreCountValue = 0;
  private lastLossDurationMsValue = 0;
  private lostAtMs = 0;

  constructor(options: ContextLossRecoveryOptions = {}) {
    this.nowFn = options.now ?? defaultNow;
    this.controller = options.controller;
    this.onLost = options.onLost;
    this.onRestored = options.onRestored;
  }

  get phase(): ContextLossPhase {
    return this.phaseValue;
  }

  get lossCount(): number {
    return this.lossCountValue;
  }

  get restoreCount(): number {
    return this.restoreCountValue;
  }

  get lastLossDurationMs(): number {
    return this.lastLossDurationMsValue;
  }

  /** True while the context is lost and rendering is invalid. */
  get lost(): boolean {
    return this.phaseValue === "lost";
  }

  /**
   * Handles `webglcontextlost`. Idempotent: a duplicate event does not
   * double-count or re-suspend. Returns true when the state changed.
   */
  handleLost(): boolean {
    if (this.phaseValue === "lost") {
      return false;
    }
    this.phaseValue = "lost";
    this.lossCountValue += 1;
    this.lostAtMs = this.nowFn();
    this.controller?.suspend();
    this.onLost?.(this.status());
    return true;
  }

  /**
   * Handles `webglcontextrestored`. A restore without a preceding loss is
   * ignored so a stray event cannot reset counters. Returns true when the
   * state changed.
   */
  handleRestored(): boolean {
    if (this.phaseValue !== "lost") {
      return false;
    }
    this.phaseValue = "running";
    this.restoreCountValue += 1;
    const duration = this.nowFn() - this.lostAtMs;
    this.lastLossDurationMsValue =
      Number.isFinite(duration) && duration > 0 ? duration : 0;
    this.controller?.resume();
    this.onRestored?.(this.status());
    return true;
  }

  /** Snapshot for the debug overlay or the recovery callbacks. */
  status(): ContextLossStatus {
    return {
      phase: this.phaseValue,
      lossCount: this.lossCountValue,
      restoreCount: this.restoreCountValue,
      lastLossDurationMs: this.lastLossDurationMsValue,
    };
  }
}

/**
 * Attaches the two WebGL context lifecycle handlers to a canvas (or any
 * `EventTarget` in tests). The loss handler calls `preventDefault()`; without
 * that the browser does not attempt a restore.
 *
 * Returns a detach function; the host calls it from `dispose()` so a discarded
 * canvas keeps no listeners.
 */
export function attachContextLossRecovery(
  canvas: EventTarget,
  recovery: ContextLossRecovery,
): () => void {
  const onLost = (event: Event): void => {
    // Required for the browser to fire `webglcontextrestored`.
    event.preventDefault();
    recovery.handleLost();
  };
  const onRestored = (): void => {
    recovery.handleRestored();
  };

  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  return () => {
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
  };
}

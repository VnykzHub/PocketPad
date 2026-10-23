/**
 * Controller touch capture engine (D2-CTRL-01; FR-8.6, FR-8.7, FR-8.3, AR-5).
 *
 * Owns the four touch listeners on the play surface, tracks touches by
 * `Touch.identifier`, hit-tests against cached rects, and emits semantic events
 * synchronously so the control layer can paint pressed state before the event
 * handler returns (FR-8.7). It knows nothing about control types: D2-CTRL-02
 * maps the events onto buttons, d-pads and sticks.
 *
 * There are no pointer events and no network calls in this layer (SPEC §8.2).
 * Touches are capped so a stuck or malicious pointer cannot grow the map
 * without bound; the dropped count is exposed for the debug overlay.
 */
import { DEFAULT_SLOP_PX, hitTest, type HitRect } from "./hitTest.js";

/** One tracked finger, keyed by `Touch.identifier`. */
export interface TouchBinding {
  identifier: number;
  controlId: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
}

export type TouchEventType = "start" | "move" | "end" | "cancel";

/** Semantic event emitted by the engine; `binding` is the live tracked object. */
export interface TouchEngineEvent {
  type: TouchEventType;
  binding: TouchBinding;
  controlId: string;
}

export interface TouchEngineOptions {
  /** Hit slop in CSS pixels; default 8 (SPEC §8.2). */
  slopPx?: number;
  /** Simultaneous touch cap; default 10 (FR-8.6). */
  maxTouches?: number;
  /**
   * Called on the next animation frame after the surface resizes or the
   * orientation changes. The owner should recompute layout and call
   * `setControls` again; `layoutStale` is true until it does.
   */
  onLayoutChange?: () => void;
}

const DEFAULT_MAX_TOUCHES = 10;
const PASSIVE_FALSE = { passive: false } as const;

/**
 * Captures touch input for one play surface.
 *
 * All emissions happen synchronously inside the touch handler; `dispose`
 * removes every listener, observer and pending frame.
 */
export class TouchEngine {
  /** Synchronous semantic callback; assigned by the control layer. */
  onTouch: (event: TouchEngineEvent) => void = () => {};

  private readonly surface: HTMLElement;
  private readonly slopPx: number;
  private readonly maxTouches: number;
  private readonly onLayoutChange: (() => void) | undefined;
  private readonly bindings = new Map<number, TouchBinding>();
  private rects: readonly HitRect[] = [];
  private droppedTouchCount = 0;
  private staleLayout = false;
  private frameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  constructor(surface: HTMLElement, opts: TouchEngineOptions = {}) {
    this.surface = surface;
    this.slopPx = opts.slopPx ?? DEFAULT_SLOP_PX;
    const requestedMax = opts.maxTouches ?? DEFAULT_MAX_TOUCHES;
    this.maxTouches =
      Number.isFinite(requestedMax) && requestedMax >= 1
        ? Math.floor(requestedMax)
        : DEFAULT_MAX_TOUCHES;
    this.onLayoutChange = opts.onLayoutChange;

    surface.addEventListener("touchstart", this.handleTouchStart, PASSIVE_FALSE);
    surface.addEventListener("touchmove", this.handleTouchMove, PASSIVE_FALSE);
    surface.addEventListener("touchend", this.handleTouchEnd, PASSIVE_FALSE);
    surface.addEventListener("touchcancel", this.handleTouchCancel, PASSIVE_FALSE);

    window.addEventListener("blur", this.handleWindowBlur);
    window.addEventListener("resize", this.handleViewportChange);
    window.addEventListener("orientationchange", this.handleViewportChange);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    // jsdom and older browsers may lack ResizeObserver; window resize above is
    // the fallback, so the engine still invalidates its cache.
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(this.handleSurfaceResize);
      this.resizeObserver.observe(surface);
    }
  }

  /**
   * Replaces the cached hit-test rects after a layout or size change. The
   * array and its entries are copied so later mutations by the renderer cannot
   * alter hit-testing mid-touch.
   */
  setControls(rects: HitRect[]): void {
    this.rects = rects.map((rect) => ({ ...rect }));
    this.staleLayout = false;
  }

  /** Active bindings, copied for the debug overlay. */
  get activeBindings(): TouchBinding[] {
    return [...this.bindings.values()].map((binding) => ({ ...binding }));
  }

  /** Touches rejected because more than `maxTouches` fingers were down. */
  get droppedTouches(): number {
    return this.droppedTouchCount;
  }

  /** True when a resize/orientation change invalidated the cached rects. */
  get layoutStale(): boolean {
    return this.staleLayout;
  }

  /**
   * Releases every active binding and emits `cancel` to the control layer.
   * Used by a layout hot-swap so a held touch cannot stay pressed or bind to a
   * removed control (FR-7.12, FR-8.2).
   */
  cancelTouches(): void {
    if (this.disposed) {
      return;
    }
    this.cancelAllTouches();
  }

  /** Removes every listener, observer and pending frame; bindings are cleared. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // removeEventListener only compares `capture`, which defaults to false and
    // matches the `{ passive: false }` add above.
    this.surface.removeEventListener("touchstart", this.handleTouchStart);
    this.surface.removeEventListener("touchmove", this.handleTouchMove);
    this.surface.removeEventListener("touchend", this.handleTouchEnd);
    this.surface.removeEventListener("touchcancel", this.handleTouchCancel);

    window.removeEventListener("blur", this.handleWindowBlur);
    window.removeEventListener("resize", this.handleViewportChange);
    window.removeEventListener("orientationchange", this.handleViewportChange);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.frameId !== null) {
      cancelFrame(this.frameId);
      this.frameId = null;
    }

    this.bindings.clear();
    this.rects = [];
  }

  private readonly handleTouchStart = (event: TouchEvent): void => {
    if (this.disposed) {
      return;
    }
    event.preventDefault();

    const changed = event.changedTouches;
    for (let index = 0; index < changed.length; index += 1) {
      const touch = changed[index];
      if (touch === undefined || this.bindings.has(touch.identifier)) {
        continue;
      }
      if (this.bindings.size >= this.maxTouches) {
        this.droppedTouchCount += 1;
        continue;
      }

      const controlId = hitTest(this.rects, touch.clientX, touch.clientY, this.slopPx);
      if (controlId === null) {
        continue;
      }

      const binding: TouchBinding = {
        identifier: touch.identifier,
        controlId,
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
      };
      this.bindings.set(touch.identifier, binding);
      this.emit("start", binding);
    }
  };

  private readonly handleTouchMove = (event: TouchEvent): void => {
    if (this.disposed) {
      return;
    }
    event.preventDefault();

    const changed = event.changedTouches;
    for (let index = 0; index < changed.length; index += 1) {
      const touch = changed[index];
      if (touch === undefined) {
        continue;
      }
      const binding = this.bindings.get(touch.identifier);
      if (binding === undefined) {
        continue;
      }
      binding.lastX = touch.clientX;
      binding.lastY = touch.clientY;
      this.emit("move", binding);
    }
  };

  private readonly handleTouchEnd = (event: TouchEvent): void => {
    this.finishTouches(event, "end");
  };

  private readonly handleTouchCancel = (event: TouchEvent): void => {
    this.finishTouches(event, "cancel");
  };

  private finishTouches(event: TouchEvent, type: "end" | "cancel"): void {
    if (this.disposed) {
      return;
    }
    event.preventDefault();

    const changed = event.changedTouches;
    if (type === "cancel" && changed.length === 0) {
      // Some engines can deliver a cancel without changedTouches. Release
      // everything rather than leave controls stuck pressed.
      this.cancelAllTouches();
      return;
    }

    for (let index = 0; index < changed.length; index += 1) {
      const touch = changed[index];
      if (touch === undefined) {
        continue;
      }
      const binding = this.bindings.get(touch.identifier);
      if (binding === undefined) {
        continue;
      }
      binding.lastX = touch.clientX;
      binding.lastY = touch.clientY;
      this.bindings.delete(touch.identifier);
      this.emit(type, binding);
    }
  }

  private readonly handleWindowBlur = (): void => {
    if (this.disposed) {
      return;
    }
    this.cancelAllTouches();
  };

  private readonly handleVisibilityChange = (): void => {
    if (this.disposed) {
      return;
    }
    if (document.visibilityState === "hidden") {
      this.cancelAllTouches();
    }
  };

  private readonly handleViewportChange = (): void => {
    if (this.disposed) {
      return;
    }
    this.cancelAllTouches();
    this.scheduleLayoutChange();
  };

  private readonly handleSurfaceResize = (): void => {
    if (this.disposed) {
      return;
    }
    this.cancelAllTouches();
    this.scheduleLayoutChange();
  };

  private scheduleLayoutChange(): void {
    this.staleLayout = true;
    if (this.frameId !== null) {
      return;
    }
    this.frameId = scheduleFrame(() => {
      this.frameId = null;
      if (this.disposed) {
        return;
      }
      this.onLayoutChange?.();
    });
  }

  private cancelAllTouches(): void {
    if (this.bindings.size === 0) {
      return;
    }
    const cancelled = [...this.bindings.values()];
    this.bindings.clear();
    for (const binding of cancelled) {
      this.emit("cancel", binding);
    }
  }

  private emit(type: TouchEventType, binding: TouchBinding): void {
    this.onTouch({ type, binding, controlId: binding.controlId });
  }
}

function scheduleFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  // The handle is opaque; the browser returns a number, Node a Timeout.
  return setTimeout(callback, 0) as unknown as number;
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(id);
  } else {
    clearTimeout(id);
  }
}

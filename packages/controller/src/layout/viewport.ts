/**
 * Visible-viewport tracking for the on-screen keyboard (D5-CTRL-03; FR-8.9, E16).
 *
 * Mobile keyboards shrink the *visual* viewport, not always the layout
 * viewport, so `window.innerHeight` alone is wrong (D5-CTRL-03). This module
 * reads `visualViewport.height/offsetTop` when available and falls back to
 * `innerHeight`. It is shared by text, canvas and panel scrolling and by the
 * layout host that re-caches hit rects; nothing here is text-specific.
 *
 * Keyboard detection: the tracker remembers the tallest visible height seen
 * at the current width (orientation). When the visible height drops more than
 * `KEYBOARD_THRESHOLD_PX` below that baseline, the keyboard is considered
 * open. A width change (rotation) resets the baseline.
 */

/** Minimum height loss treated as an open keyboard (URL-bar jitter is ~60 px). */
export const KEYBOARD_THRESHOLD_PX = 150;

/** The subset of `VisualViewport` used here (injectable for tests). */
export interface VisualViewportLike {
  readonly width: number;
  readonly height: number;
  readonly offsetTop: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
}

/** The subset of `Window` used here (injectable for tests). */
export interface ViewportWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly visualViewport?: VisualViewportLike | null;
  addEventListener(type: "resize" | "orientationchange", listener: () => void): void;
  removeEventListener(type: "resize" | "orientationchange", listener: () => void): void;
}

export interface ViewportMetrics {
  /** Visible width in CSS px. */
  width: number;
  /** Visible height in CSS px (above the keyboard). */
  visibleHeight: number;
  /** Visible top relative to the layout viewport, in CSS px. */
  offsetTop: number;
  keyboardOpen: boolean;
}

export type ViewportListener = (metrics: ViewportMetrics) => void;

/** Vertical extent of an element, e.g. from `getBoundingClientRect()`. */
export interface VerticalRect {
  top: number;
  bottom: number;
}

/** True when the rect lies entirely inside the visible band. */
export function isRectVisible(rect: VerticalRect, metrics: ViewportMetrics): boolean {
  return rect.top >= metrics.offsetTop && rect.bottom <= metrics.offsetTop + metrics.visibleHeight;
}

/**
 * Scrolls `element` to the middle of the visible band when the keyboard (or
 * anything else) hides it. Returns true when a scroll was requested.
 */
export function ensureVisible(element: Element, metrics: ViewportMetrics): boolean {
  if (isRectVisible(element.getBoundingClientRect(), metrics)) {
    return false;
  }
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "center", inline: "nearest" });
  }
  return true;
}

export class ViewportTracker {
  private readonly win: ViewportWindow;
  private readonly listeners = new Set<ViewportListener>();
  private readonly handleChange = (): void => {
    this.update();
  };
  private baselineHeight = 0;
  private baselineWidth = -1;
  private current: ViewportMetrics;
  private disposed = false;

  constructor(win: ViewportWindow) {
    this.win = win;
    this.current = this.read();
    win.visualViewport?.addEventListener("resize", this.handleChange);
    win.visualViewport?.addEventListener("scroll", this.handleChange);
    win.addEventListener("resize", this.handleChange);
    win.addEventListener("orientationchange", this.handleChange);
  }

  metrics(): ViewportMetrics {
    return { ...this.current };
  }

  /** Subscribes to changes; returns the unsubscribe function. */
  subscribe(listener: ViewportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Re-reads the viewport and notifies listeners when anything changed. */
  update(): ViewportMetrics {
    if (this.disposed) {
      return this.metrics();
    }
    const next = this.read();
    const previous = this.current;
    this.current = next;
    if (
      next.width !== previous.width ||
      next.visibleHeight !== previous.visibleHeight ||
      next.offsetTop !== previous.offsetTop ||
      next.keyboardOpen !== previous.keyboardOpen
    ) {
      for (const listener of [...this.listeners]) {
        listener(this.metrics());
      }
    }
    return this.metrics();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.listeners.clear();
    this.win.visualViewport?.removeEventListener("resize", this.handleChange);
    this.win.visualViewport?.removeEventListener("scroll", this.handleChange);
    this.win.removeEventListener("resize", this.handleChange);
    this.win.removeEventListener("orientationchange", this.handleChange);
  }

  private read(): ViewportMetrics {
    const visual = this.win.visualViewport ?? null;
    const width = visual?.width ?? this.win.innerWidth;
    const visibleHeight = visual?.height ?? this.win.innerHeight;
    const offsetTop = visual?.offsetTop ?? 0;

    // Rotation changes the reference height; start a fresh baseline.
    if (width !== this.baselineWidth) {
      this.baselineWidth = width;
      this.baselineHeight = visibleHeight;
    }
    this.baselineHeight = Math.max(this.baselineHeight, visibleHeight);

    return {
      width,
      visibleHeight,
      offsetTop,
      keyboardOpen: this.baselineHeight - visibleHeight > KEYBOARD_THRESHOLD_PX,
    };
  }
}

/**
 * Home-screen backdrop (spec 25 §2.4; DESIGN.md console-shell tier).
 *
 * Two stacked layers crossfade with opacity only; the backdrop owns no timers,
 * no animation loop and no GPU resource. `pause()` is called when a game
 * launches: updates stop being applied, any pending theme is held, and CSS
 * drops the transition so a running game costs nothing. `resume()` applies
 * the latest theme immediately.
 */
import type { MotionTier } from "./types.js";

export interface BackdropTheme {
  /** Accent of the focused game; used by the test surface and CSS glow. */
  readonly accent: string;
  /** Full CSS `background` value (gradient allowed on the launcher only). */
  readonly gradient: string;
}

export interface BackdropOptions {
  readonly tier?: MotionTier;
}

export class ConsoleBackdrop {
  readonly element: HTMLElement;
  readonly layers: readonly [HTMLElement, HTMLElement];

  private readonly tier: MotionTier;
  private activeLayer = 0;
  private currentTheme: BackdropTheme | null = null;
  private pendingTheme: BackdropTheme | null = null;
  private pausedFlag = false;

  constructor(doc: Document, options: BackdropOptions = {}) {
    this.tier = options.tier ?? "full";

    const root = doc.createElement("div");
    root.className = "console-backdrop";
    root.setAttribute("aria-hidden", "true");
    root.dataset["motion"] = this.tier;

    const first = this.createLayer(doc);
    const second = this.createLayer(doc);
    root.append(first, second);

    this.element = root;
    this.layers = [first, second];
  }

  get tierName(): MotionTier {
    return this.tier;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  /** Crossfades to `theme`; while paused the latest theme is held. */
  show(theme: BackdropTheme): void {
    this.currentTheme = theme;
    if (this.pausedFlag) {
      this.pendingTheme = theme;
      return;
    }
    this.apply(theme);
  }

  /** The theme currently painted, or null before the first `show`. */
  get theme(): BackdropTheme | null {
    return this.currentTheme;
  }

  /** Stops applying theme changes while a game runs (ER-25-07). */
  pause(): void {
    if (this.pausedFlag) return;
    this.pausedFlag = true;
    this.element.dataset["paused"] = "true";
    this.pendingTheme = this.currentTheme;
  }

  /** Applies the newest held theme immediately and resumes updates. */
  resume(): void {
    if (!this.pausedFlag) return;
    this.pausedFlag = false;
    this.element.dataset["paused"] = "false";
    const pending = this.pendingTheme;
    this.pendingTheme = null;
    if (pending !== null) this.apply(pending);
  }

  destroy(): void {
    this.currentTheme = null;
    this.pendingTheme = null;
    this.element.remove();
  }

  private createLayer(doc: Document): HTMLElement {
    const layer = doc.createElement("div");
    layer.className = "console-backdrop__layer";
    layer.dataset["visible"] = "false";
    return layer;
  }

  private apply(theme: BackdropTheme): void {
    const nextIndex = this.activeLayer === 0 ? 1 : 0;
    const next = this.layers[nextIndex];
    const current = this.layers[this.activeLayer];
    if (next === undefined || current === undefined) return;
    next.style.setProperty("background", theme.gradient);
    next.style.setProperty("--backdrop-accent", theme.accent);
    next.dataset["visible"] = "true";
    current.dataset["visible"] = "false";
    this.activeLayer = nextIndex;
    this.element.dataset["accent"] = theme.accent;
  }
}

/**
 * Console loading screen (spec 25 §2.7; BUILD-BRIEF launcher).
 *
 * Shown between activating a tile and the game's first frame. It is a real
 * `progressbar`: the fill moves with `transform: scaleX()` only, the percentage
 * and byte counts are text, and an unknown total renders an indeterminate bar
 * with the bytes fetched so far. No timers, no animation loop, no allocations
 * per update beyond the three text nodes.
 *
 * `update()` accepts the runtime's `AssetProgress` unchanged, so the host can
 * forward the asset loader's callback straight through once stream G wires the
 * shell into stage start.
 */
import type { AssetProgress } from "../../assets/AssetLoader.js";
import type { MotionTier } from "./types.js";

export const LOADING_EYEBROW = "Loading";
export const LOADING_UNKNOWN_TOTAL = "Preparing game…";

export interface ConsoleLoadingOptions {
  readonly motion?: MotionTier;
}

let nextTitleId = 0;

/** Human byte count: `0 B`, `512 B`, `1.5 KB`, `12 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

export class ConsoleLoadingScreen {
  readonly element: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly bar: HTMLElement;
  readonly fill: HTMLElement;
  readonly bytesEl: HTMLElement;
  readonly percentEl: HTMLElement;

  private readonly titleId: string;
  private fraction = 0;

  constructor(doc: Document, options: ConsoleLoadingOptions = {}) {
    this.titleId = `console-loading-title-${nextTitleId++}`;

    const root = doc.createElement("section");
    root.className = "console-loading";
    root.dataset["motion"] = options.motion ?? "full";
    root.setAttribute("role", "region");
    root.setAttribute("aria-labelledby", this.titleId);
    root.hidden = true;

    const inner = doc.createElement("div");
    inner.className = "console-loading__inner";

    const eyebrow = doc.createElement("p");
    eyebrow.className = "console-loading__eyebrow";
    eyebrow.textContent = LOADING_EYEBROW;

    this.titleEl = doc.createElement("h1");
    this.titleEl.id = this.titleId;
    this.titleEl.className = "console-loading__title";
    this.titleEl.tabIndex = -1;

    this.bar = doc.createElement("div");
    this.bar.className = "console-loading__bar";
    this.bar.setAttribute("role", "progressbar");
    this.bar.setAttribute("aria-labelledby", this.titleId);
    this.bar.setAttribute("aria-valuemin", "0");
    this.bar.setAttribute("aria-valuemax", "100");
    this.bar.setAttribute("aria-valuenow", "0");
    this.fill = doc.createElement("span");
    this.fill.className = "console-loading__fill";
    this.fill.style.setProperty("transform", "scaleX(0)");
    this.bar.append(this.fill);

    const meta = doc.createElement("p");
    meta.className = "console-loading__meta";
    this.bytesEl = doc.createElement("span");
    this.bytesEl.className = "console-loading__bytes";
    this.bytesEl.textContent = LOADING_UNKNOWN_TOTAL;
    this.percentEl = doc.createElement("span");
    this.percentEl.className = "console-loading__percent";
    this.percentEl.textContent = "0%";
    meta.append(this.bytesEl, this.percentEl);

    inner.append(eyebrow, this.titleEl, this.bar, meta);
    root.append(inner);
    this.element = root;
  }

  get isVisible(): boolean {
    return !this.element.hidden;
  }

  /** Reveals the screen for `title` and resets the bar to zero. */
  show(title: string): void {
    this.titleEl.textContent = title;
    this.element.hidden = false;
    this.setProgress({ fraction: 0, loadedBytes: 0, totalBytes: 0 } as AssetProgress);
  }

  hide(): void {
    this.element.hidden = true;
  }

  /** Moves the bar; a null/unknown fraction renders indeterminate. */
  update(progress: AssetProgress): void {
    this.setProgress(progress);
  }

  /** Moves focus to the game title so screen readers announce the screen. */
  focus(): void {
    if (this.element.hidden) return;
    this.titleEl.focus();
  }

  destroy(): void {
    this.element.remove();
  }

  private setProgress(progress: AssetProgress): void {
    const fraction = progress.fraction;
    const determinate =
      typeof fraction === "number" && Number.isFinite(fraction);
    const clamped = determinate ? Math.max(0, Math.min(1, fraction)) : 0;
    this.fraction = clamped;

    this.element.dataset["determinate"] = determinate ? "true" : "false";
    if (determinate) {
      this.bar.setAttribute("aria-valuenow", String(Math.round(clamped * 100)));
      this.fill.style.setProperty("transform", `scaleX(${clamped})`);
      this.percentEl.textContent = `${Math.round(clamped * 100)}%`;
    } else {
      this.bar.removeAttribute("aria-valuenow");
      this.fill.style.setProperty("transform", "scaleX(0.15)");
      this.percentEl.textContent = "";
    }

    const loaded = formatBytes(progress.loadedBytes);
    if (!determinate || progress.totalBytes <= 0) {
      this.bytesEl.textContent =
        progress.loadedBytes > 0 ? `${loaded} fetched` : LOADING_UNKNOWN_TOTAL;
      return;
    }
    this.bytesEl.textContent = `${loaded} of ${formatBytes(progress.totalBytes)}`;
  }
}

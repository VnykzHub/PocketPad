/**
 * Progress bar bound to `AssetLoader` byte progress (D3-RT-02, FR-9.7).
 *
 * The interesting part is `describeProgress`: it is a pure state machine so
 * the "never claim completion before assets resolve" rule is unit-testable
 * without a DOM. A determinate bar shows `loadedBytes / totalBytes` rounded;
 * an unknown total shows `indeterminate` with no percentage; a fully fetched
 * but still-decoding load shows "Finalizing…" at 100%, never "Ready".
 *
 * The DOM class uses plain elements and `textContent` only: no virtual DOM in
 * the runtime (NR-6.2), no `innerHTML`, and updates are diffed so the bar does
 * not touch the DOM when the state has not changed.
 */
import type { AssetProgress } from "./AssetLoader.js";

export type ProgressBarMode = "determinate" | "indeterminate" | "complete";

export interface ProgressBarState {
  readonly mode: ProgressBarMode;
  /** 0..100 for determinate/complete, null for indeterminate. */
  readonly percent: number | null;
  readonly label: string;
  /** Screen-reader text; never implies completion before `done`. */
  readonly ariaValueText: string;
}

/** Pure progress → view-state mapping. */
export function describeProgress(progress: AssetProgress): ProgressBarState {
  if (progress.done) {
    return {
      mode: "complete",
      percent: 100,
      label: "Ready",
      ariaValueText: "Ready",
    };
  }

  if (!progress.determinate || progress.fraction === null) {
    return {
      mode: "indeterminate",
      percent: null,
      label: "Loading… (size unknown)",
      ariaValueText:
        `Loading, ${progress.loadedBytes} bytes fetched, ` +
        `${progress.loadedCount} of ${progress.totalCount} files ready, ` +
        "total size unknown",
    };
  }

  const percent = Math.min(
    100,
    Math.max(0, Math.round(progress.fraction * 100)),
  );

  if (progress.fraction >= 1) {
    // Bytes are in, but at least one asset is still decoding: do not say
    // "Ready" or the start screen could advance before the game can run.
    return {
      mode: "determinate",
      percent: 100,
      label: "Finalizing…",
      ariaValueText:
        `All ${progress.totalCount} files fetched, preparing assets`,
    };
  }

  return {
    mode: "determinate",
    percent,
    label: `Loading… ${percent}%`,
    ariaValueText:
      `Loading ${percent}%, ${progress.loadedCount} of ` +
      `${progress.totalCount} files ready`,
  };
}

function sameState(
  a: ProgressBarState | null,
  b: ProgressBarState,
): boolean {
  return (
    a !== null &&
    a.mode === b.mode &&
    a.percent === b.percent &&
    a.label === b.label
  );
}

/**
 * DOM progress bar. `element` is the host's to mount; `update(progress)` is
 * safe to call on every loader callback.
 */
export class ProgressBar {
  readonly element: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly labelElement: HTMLElement;
  private current: ProgressBarState | null = null;

  constructor(doc: Document, labelText = "Loading assets") {
    const root = doc.createElement("div");
    root.className = "lanpad-progress";
    root.setAttribute("role", "progressbar");
    root.setAttribute("aria-valuemin", "0");
    root.setAttribute("aria-valuemax", "100");
    root.setAttribute("aria-label", labelText);

    const track = doc.createElement("div");
    track.className = "lanpad-progress-track";
    const fill = doc.createElement("div");
    fill.className = "lanpad-progress-fill";
    track.appendChild(fill);

    const label = doc.createElement("div");
    label.className = "lanpad-progress-label";
    label.textContent = "Loading…";

    root.appendChild(track);
    root.appendChild(label);

    this.element = root;
    this.fill = fill;
    this.labelElement = label;
  }

  get state(): ProgressBarState | null {
    return this.current;
  }

  /** Applies `progress` and returns the resulting view state. */
  update(progress: AssetProgress): ProgressBarState {
    const next = describeProgress(progress);
    if (sameState(this.current, next)) {
      return next;
    }
    this.current = next;
    this.fill.style.width =
      next.percent === null ? "100%" : `${next.percent}%`;
    this.labelElement.textContent = next.label;
    this.element.dataset["mode"] = next.mode;
    if (next.percent === null) {
      this.element.removeAttribute("aria-valuenow");
    } else {
      this.element.setAttribute("aria-valuenow", String(next.percent));
    }
    this.element.setAttribute("aria-valuetext", next.ariaValueText);
    return next;
  }

  dispose(): void {
    this.element.remove();
  }
}

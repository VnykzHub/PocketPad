/**
 * Results overlay (HP-05; AR-4).
 *
 * Platform-owned results over a dimmed canvas. The game supplies every string
 * and value in the payload — the overlay never invents a score, a winner or a
 * label. It owns the presentation decisions the design fixes:
 *
 * - 900px `--surface` panel on a flat 72% black scrim (no blur, no glass).
 * - Title 56px, subtitle 32px `--muted`, 72px rows with a player-hue swatch,
 *   right-aligned tabular value, and the word `WIN` plus value emphasis for a
 *   winner (never colour alone).
 * - Play again (inverted) and Back to games (outlined); focus order Play again
 *   then Back. Focus is trapped in the panel.
 * - 220ms entry (scale 0.96 -> 1 + opacity) and 160ms exit. With
 *   `prefers-reduced-motion: reduce` the scale is removed and only opacity
 *   changes. Nothing animates when remote focus moves.
 *
 * Player identity uses the fixed per-slot tokens from DESIGN.md: each row's
 * swatch receives `--player-color: var(--player-N)` (1..8). `src/style.css`
 * owns the actual painting; classes:
 * `lanpad-results`, `lanpad-results__panel`, `lanpad-results__title`,
 * `lanpad-results__subtitle`, `lanpad-results__rows`, `lanpad-results__row`,
 * `lanpad-results__swatch`, `lanpad-results__label`, `lanpad-results__value`,
 * `lanpad-results__win`, `lanpad-results__actions`,
 * `lanpad-results__action--primary`, `lanpad-results__action--secondary`.
 */

export interface ResultsRow {
  /** Player slot 1..8; picks the fixed `--player-N` hue. */
  readonly slot: number;
  readonly label: string;
  readonly value: string;
  readonly winner?: boolean;
}

export interface ResultsData {
  readonly title: string;
  readonly subtitle?: string;
  readonly rows: ReadonlyArray<ResultsRow>;
  /** False hides Play again, leaving Back to games as the only action. */
  readonly rematch: boolean;
}

export interface ResultsCallbacks {
  readonly onRematch: () => void;
  readonly onBack: () => void;
}

export interface ResultsOverlayOptions {
  /** Mount target; defaults to `document.body` when `show()` runs. */
  readonly root?: HTMLElement;
  /** Test seam; otherwise read from `prefers-reduced-motion`. */
  readonly reducedMotion?: boolean;
}

export const RESULTS_PLAY_AGAIN_LABEL = "Play again";
export const RESULTS_BACK_LABEL = "Back to games";
export const RESULTS_WIN_LABEL = "WIN";

const ENTER_MS = 220;
const EXIT_MS = 160;
const EASE_OUT = "var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1))";

let nextOverlayId = 1;

/** `var(--player-N)` with slot clamped to the eight fixed hues. */
export function playerColorVariable(slot: number): string {
  const normalized = Number.isFinite(slot)
    ? Math.min(8, Math.max(1, Math.trunc(slot)))
    : 1;
  return `var(--player-${normalized})`;
}

export class ResultsOverlay {
  readonly element: HTMLElement;

  private readonly doc: Document;
  private readonly panel: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly subtitleEl: HTMLElement;
  private readonly rowsEl: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly root: HTMLElement | null;
  private readonly reducedMotion: boolean;

  private actionButtons: HTMLButtonElement[] = [];
  private activeAction = 0;
  private callbacks: ResultsCallbacks | null = null;
  private visible = false;
  private closing = false;
  private mounted = false;
  private destroyed = false;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(doc: Document, options: ResultsOverlayOptions = {}) {
    this.doc = doc;
    this.root = options.root ?? null;
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion(doc);

    const overlay = doc.createElement("div");
    overlay.className = "lanpad-results";
    overlay.setAttribute("role", "presentation");
    overlay.hidden = true;

    const panel = doc.createElement("div");
    panel.className = "lanpad-results__panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    const id = nextOverlayId;
    nextOverlayId += 1;

    const title = doc.createElement("h2");
    title.className = "lanpad-results__title";
    title.id = `lanpad-results-title-${id}`;
    panel.setAttribute("aria-labelledby", title.id);

    const subtitle = doc.createElement("p");
    subtitle.className = "lanpad-results__subtitle";
    subtitle.id = `lanpad-results-subtitle-${id}`;
    subtitle.hidden = true;

    const rows = doc.createElement("ul");
    rows.className = "lanpad-results__rows";

    const actions = doc.createElement("div");
    actions.className = "lanpad-results__actions";

    panel.append(title, subtitle, rows, actions);
    overlay.append(panel);
    overlay.addEventListener("keydown", this.handleKeyDown as EventListener);

    this.element = overlay;
    this.panel = panel;
    this.titleEl = title;
    this.subtitleEl = subtitle;
    this.rowsEl = rows;
    this.actionsEl = actions;
  }

  /** True while the overlay is shown (including its exit animation). */
  get isVisible(): boolean {
    return this.visible;
  }

  /** Builds the content, mounts the overlay and focuses its first action. */
  show(data: ResultsData, callbacks: ResultsCallbacks): void {
    if (this.destroyed) return;

    this.cancelExit();
    this.callbacks = callbacks;
    this.visible = true;
    this.closing = false;

    this.titleEl.textContent = data.title;

    const subtitleText = data.subtitle?.trim() ?? "";
    this.subtitleEl.textContent = subtitleText;
    this.subtitleEl.hidden = subtitleText.length === 0;
    if (subtitleText.length === 0) {
      this.panel.removeAttribute("aria-describedby");
    } else {
      this.panel.setAttribute("aria-describedby", this.subtitleEl.id);
    }

    this.renderRows(data.rows);
    this.renderActions(data.rematch);

    this.element.hidden = false;
    this.mount();
    this.focus();
    this.applyEnterMotion();
  }

  /** Hides the overlay with the 160ms exit; does not call a callback. */
  hide(): void {
    if (!this.visible) return;
    this.finishClose();
  }

  /** Focuses the first action: Play again, or Back when rematch is unavailable. */
  focus(): void {
    if (!this.visible) return;
    const button = this.actionButtons[this.activeAction] ?? this.actionButtons[0];
    if (button !== undefined) button.focus();
  }

  /** Removes listeners, timers and the mounted tree. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.cancelExit();
    this.element.removeEventListener("keydown", this.handleKeyDown as EventListener);
    this.element.remove();
    this.mounted = false;
    this.actionButtons = [];
    this.callbacks = null;
  }

  private mount(): void {
    if (this.mounted) return;
    const parent = this.root ?? this.doc.body;
    parent.append(this.element);
    this.mounted = true;
  }

  private renderRows(rows: ReadonlyArray<ResultsRow>): void {
    this.rowsEl.replaceChildren();
    for (const row of rows) {
      const item = this.doc.createElement("li");
      item.className = "lanpad-results__row";
      item.dataset["slot"] = String(row.slot);
      if (row.winner === true) item.dataset["winner"] = "true";

      const swatch = this.doc.createElement("span");
      swatch.className = "lanpad-results__swatch";
      swatch.setAttribute("aria-hidden", "true");
      swatch.style.setProperty("--player-color", playerColorVariable(row.slot));

      const label = this.doc.createElement("span");
      label.className = "lanpad-results__label";
      label.textContent = row.label;

      const value = this.doc.createElement("span");
      value.className = "lanpad-results__value";
      value.textContent = row.value;

      item.append(swatch, label, value);

      if (row.winner === true) {
        const win = this.doc.createElement("span");
        win.className = "lanpad-results__win";
        win.textContent = RESULTS_WIN_LABEL;
        item.append(win);
      }

      this.rowsEl.append(item);
    }
  }

  private renderActions(rematch: boolean): void {
    this.actionsEl.replaceChildren();
    this.actionButtons = [];
    this.activeAction = 0;

    if (rematch) {
      const play = this.createAction(RESULTS_PLAY_AGAIN_LABEL, "primary");
      play.addEventListener("click", this.handleRematch);
      this.actionButtons.push(play);
      this.actionsEl.append(play);
    }

    const back = this.createAction(RESULTS_BACK_LABEL, "secondary");
    back.addEventListener("click", this.handleBack);
    this.actionButtons.push(back);
    this.actionsEl.append(back);
  }

  private createAction(
    label: string,
    variant: "primary" | "secondary",
  ): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.setAttribute("type", "button");
    button.className = `lanpad-results__action lanpad-results__action--${variant}`;
    button.textContent = label;

    const index = this.actionButtons.length;
    button.addEventListener("focus", () => {
      this.activeAction = index;
    });
    return button;
  }

  private finishClose(): void {
    this.visible = false;
    this.closing = true;
    this.applyExitMotion(() => {
      this.closing = false;
      this.element.hidden = true;
      this.element.remove();
      this.mounted = false;
      this.actionButtons = [];
      this.callbacks = null;
    });
  }

  private applyEnterMotion(): void {
    this.element.dataset["reducedMotion"] = this.reducedMotion ? "true" : "false";
    this.panel.style.transition = "none";
    this.panel.style.opacity = "0";
    this.panel.style.transform = this.reducedMotion ? "none" : "scale(0.96)";

    afterFrame(this.doc, () => {
      if (this.destroyed || !this.visible) return;
      this.panel.style.transition = this.reducedMotion
        ? `opacity ${ENTER_MS}ms ${EASE_OUT}`
        : `opacity ${ENTER_MS}ms ${EASE_OUT}, transform ${ENTER_MS}ms ${EASE_OUT}`;
      this.panel.style.opacity = "1";
      if (!this.reducedMotion) this.panel.style.transform = "scale(1)";
    });
  }

  private applyExitMotion(after: () => void): void {
    this.panel.style.transition = this.reducedMotion
      ? `opacity ${EXIT_MS}ms ${EASE_OUT}`
      : `opacity ${EXIT_MS}ms ${EASE_OUT}, transform ${EXIT_MS}ms ${EASE_OUT}`;
    this.panel.style.opacity = "0";
    if (!this.reducedMotion) this.panel.style.transform = "scale(0.96)";
    this.exitTimer = setTimeout(() => {
      this.exitTimer = null;
      after();
    }, EXIT_MS);
  }

  private cancelExit(): void {
    if (this.exitTimer === null) return;
    clearTimeout(this.exitTimer);
    this.exitTimer = null;
  }

  private readonly handleRematch = (): void => {
    if (!this.visible || this.closing) return;
    this.closing = true;
    const callback = this.callbacks?.onRematch;
    this.finishClose();
    callback?.();
  };

  private readonly handleBack = (): void => {
    if (!this.visible || this.closing) return;
    this.closing = true;
    const callback = this.callbacks?.onBack;
    this.finishClose();
    callback?.();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.visible || this.closing) return;
    if (event.key !== "Tab") return;

    const buttons = this.actionButtons;
    if (buttons.length === 0) return;

    const shift = event.shiftKey === true;
    const next = shift
      ? this.activeAction <= 0
        ? buttons.length - 1
        : this.activeAction - 1
      : this.activeAction >= buttons.length - 1
        ? 0
        : this.activeAction + 1;

    event.preventDefault();
    buttons[next]?.focus();
  };
}

/** Schedules one frame; falls back to a macrotask in test/document fakes. */
function afterFrame(doc: Document, run: () => void): void {
  const view = doc.defaultView;
  if (view !== null && typeof view.requestAnimationFrame === "function") {
    view.requestAnimationFrame(run);
    return;
  }
  setTimeout(run, 0);
}

function prefersReducedMotion(doc: Document): boolean {
  const view = doc.defaultView;
  if (view === null || typeof view.matchMedia !== "function") return false;
  try {
    return view.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

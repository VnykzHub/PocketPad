/**
 * Leave-game confirmation (HP-04b; AR-4).
 *
 * A 720px `--surface` panel over a flat 72% black scrim (no blur). Default
 * focus is Keep playing; Escape closes the overlay as Keep playing; Enter
 * activates the focused action. The panel traps Tab so remote focus cannot
 * fall into the paused game underneath.
 *
 * Motion: 220ms entry (scale 0.96 -> 1 + opacity), 160ms exit. Under
 * `prefers-reduced-motion: reduce` the scale is removed and only opacity
 * changes. Focus movement itself never animates.
 *
 * The component ships structure and class names only; `src/style.css` owns the
 * visuals. Classes: `lanpad-leave`, `lanpad-leave__panel`,
 * `lanpad-leave__title`, `lanpad-leave__body`, `lanpad-leave__actions`,
 * `lanpad-leave__action--primary`, `lanpad-leave__action--secondary`.
 */

export interface LeaveConfirmOptions {
  /** Mount target; defaults to `document.body` when `open()` runs. */
  readonly root?: HTMLElement;
  /** Test seam; otherwise read from `prefers-reduced-motion`. */
  readonly reducedMotion?: boolean;
}

export const LEAVE_TITLE = "Leave the game?";
export const LEAVE_BODY = "Phones stay connected to the room.";
export const LEAVE_KEEP_LABEL = "Keep playing";
export const LEAVE_BACK_LABEL = "Back to games";

const ENTER_MS = 220;
const EXIT_MS = 160;
const EASE_OUT = "var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1))";

let nextOverlayId = 1;

export class LeaveConfirm {
  readonly element: HTMLElement;

  private readonly doc: Document;
  private readonly panel: HTMLElement;
  private readonly keepButton: HTMLButtonElement;
  private readonly backButton: HTMLButtonElement;
  private readonly root: HTMLElement | null;
  private readonly reducedMotion: boolean;

  private onKeepPlaying: (() => void) | null = null;
  private onBackToGames: (() => void) | null = null;
  private activeAction = 0;
  private visible = false;
  private closing = false;
  private mounted = false;
  private destroyed = false;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(doc: Document, options: LeaveConfirmOptions = {}) {
    this.doc = doc;
    this.root = options.root ?? null;
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion(doc);

    const overlay = doc.createElement("div");
    overlay.className = "lanpad-leave";
    overlay.setAttribute("role", "presentation");
    overlay.hidden = true;

    const panel = doc.createElement("div");
    panel.className = "lanpad-leave__panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    const id = nextOverlayId;
    nextOverlayId += 1;

    const title = doc.createElement("h2");
    title.className = "lanpad-leave__title";
    title.id = `lanpad-leave-title-${id}`;
    title.textContent = LEAVE_TITLE;
    panel.setAttribute("aria-labelledby", title.id);

    const body = doc.createElement("p");
    body.className = "lanpad-leave__body";
    body.textContent = LEAVE_BODY;

    const actions = doc.createElement("div");
    actions.className = "lanpad-leave__actions";

    const keep = doc.createElement("button");
    keep.setAttribute("type", "button");
    keep.className = "lanpad-leave__action lanpad-leave__action--primary";
    keep.textContent = LEAVE_KEEP_LABEL;
    keep.addEventListener("click", this.handleKeepPlaying);
    keep.addEventListener("focus", () => {
      this.activeAction = 0;
    });

    const back = doc.createElement("button");
    back.setAttribute("type", "button");
    back.className = "lanpad-leave__action lanpad-leave__action--secondary";
    back.textContent = LEAVE_BACK_LABEL;
    back.addEventListener("click", this.handleBackToGames);
    back.addEventListener("focus", () => {
      this.activeAction = 1;
    });

    actions.append(keep, back);
    panel.append(title, body, actions);
    overlay.append(panel);
    overlay.addEventListener("keydown", this.handleKeyDown as EventListener);

    this.element = overlay;
    this.panel = panel;
    this.keepButton = keep;
    this.backButton = back;
  }

  /** True while the confirmation is shown (including its exit animation). */
  get isOpen(): boolean {
    return this.visible;
  }

  /**
   * Shows the confirmation. `onKeepPlaying` runs for the focused primary
   * action and for Escape; `onBackToGames` runs for Back to games.
   */
  open(onKeepPlaying: () => void, onBackToGames: () => void): void {
    if (this.destroyed) return;
    this.onKeepPlaying = onKeepPlaying;
    this.onBackToGames = onBackToGames;

    if (this.visible) {
      this.focus();
      return;
    }

    this.cancelExit();
    this.visible = true;
    this.closing = false;
    this.activeAction = 0;
    this.element.hidden = false;
    this.mount();
    this.focus();
    this.applyEnterMotion();
  }

  /** Closes the overlay without invoking a callback. */
  close(): void {
    if (!this.visible) return;
    this.finishClose();
  }

  /** Focuses Keep playing, the default action (HP-04b). */
  focus(): void {
    if (!this.visible) return;
    const button = this.activeAction === 0 ? this.keepButton : this.backButton;
    button.focus();
  }

  /** Removes listeners, timers and the mounted tree. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    this.cancelExit();
    this.element.removeEventListener("keydown", this.handleKeyDown as EventListener);
    this.keepButton.removeEventListener("click", this.handleKeepPlaying);
    this.backButton.removeEventListener("click", this.handleBackToGames);
    this.element.remove();
    this.mounted = false;
    this.onKeepPlaying = null;
    this.onBackToGames = null;
  }

  private mount(): void {
    if (this.mounted) return;
    const parent = this.root ?? this.doc.body;
    parent.append(this.element);
    this.mounted = true;
  }

  private finishClose(): void {
    this.visible = false;
    this.closing = true;
    this.applyExitMotion(() => {
      this.closing = false;
      this.element.hidden = true;
      this.element.remove();
      this.mounted = false;
      this.onKeepPlaying = null;
      this.onBackToGames = null;
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

  private readonly handleKeepPlaying = (): void => {
    if (!this.visible || this.closing) return;
    const callback = this.onKeepPlaying;
    this.closing = true;
    this.finishClose();
    callback?.();
  };

  private readonly handleBackToGames = (): void => {
    if (!this.visible || this.closing) return;
    const callback = this.onBackToGames;
    this.closing = true;
    this.finishClose();
    callback?.();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.visible || this.closing) return;

    const key = event.key;
    const keyCode = typeof event.keyCode === "number" ? event.keyCode : 0;
    if (key === "Escape" || key === "Esc" || keyCode === 27) {
      event.preventDefault();
      this.handleKeepPlaying();
      return;
    }

    if (key !== "Tab") return;
    event.preventDefault();
    this.activeAction = this.activeAction === 0 ? 1 : 0;
    this.focus();
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

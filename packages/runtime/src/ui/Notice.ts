/**
 * HP-07 notice panel (FR-9.3, SR-9, AR-4).
 *
 * One centred `--surface` card for renderer failure, room expiry and host
 * lost: a 40px title, one message, optional hint lines and exactly one
 * action. The panel is `role="alert"`, so assistive tech announces it when it
 * is mounted, and the single action is the only focusable thing in it — a TV
 * remote cannot get lost in the notice.
 *
 * PAGE-PLANS HP-07 / DESIGN "Notice panel": max 720px, radius 20px, 32px
 * padding, danger carried by a mark and a word, never a full red panel.
 * The host shell owns when a notice appears; this class only renders it.
 */

export type NoticeTone = "notice" | "error";

export interface NoticeOptions {
  /** Short headline, e.g. "The game stopped". */
  readonly title: string;
  /** One sentence of what happened, e.g. "Renderer unavailable.". */
  readonly message?: string;
  /** Optional 18px muted hint lines. */
  readonly hints?: readonly string[];
  /** Label of the one action, e.g. "Reload". */
  readonly actionLabel: string;
  /** Runs on click; the shell decides whether to reload or retry. */
  readonly onAction: () => void;
  /** `error` adds the negative dot and danger semantics. Default `notice`. */
  readonly tone?: NoticeTone;
}

let noticeSeq = 0;

export class Notice {
  readonly element: HTMLElement;
  readonly actionButton: HTMLButtonElement;

  private readonly onAction: () => void;
  private destroyed = false;

  constructor(doc: Document, options: NoticeOptions) {
    this.onAction = options.onAction;
    const tone = options.tone ?? "notice";
    const titleId = `lanpad-notice-title-${++noticeSeq}`;

    const root = doc.createElement("section");
    root.className =
      tone === "error" ? "lanpad-notice lanpad-error" : "lanpad-notice";
    root.setAttribute("role", "alert");
    root.setAttribute("aria-labelledby", titleId);

    const title = doc.createElement("h2");
    title.className = "lanpad-notice__title";
    title.id = titleId;
    title.textContent = options.title;

    root.append(title);

    if (options.message !== undefined && options.message.length > 0) {
      const message = doc.createElement("p");
      message.className = "lanpad-notice__message";
      message.textContent = options.message;
      root.append(message);
    }

    if (options.hints !== undefined && options.hints.length > 0) {
      const hints = doc.createElement("ul");
      hints.className = "lanpad-notice__hints";
      for (const line of options.hints) {
        const item = doc.createElement("li");
        item.textContent = line;
        hints.append(item);
      }
      root.append(hints);
    }

    const action = doc.createElement("button");
    action.type = "button";
    action.className = "lanpad-notice__action";
    action.textContent = options.actionLabel;
    action.addEventListener("click", this.handleAction);
    this.actionButton = action;

    root.append(action);
    this.element = root;
  }

  /** Appends the panel to `parent` and gives the single action focus. */
  mount(parent: HTMLElement): void {
    parent.append(this.element);
    this.focusAction();
  }

  /** Moves remote/keyboard focus to the action (AR-4). */
  focusAction(): void {
    this.actionButton.focus();
  }

  /** Removes the listener and the panel. Safe to call twice. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.actionButton.removeEventListener("click", this.handleAction);
    this.element.remove();
  }

  private readonly handleAction = (): void => {
    if (this.destroyed) return;
    this.onAction();
  };
}

/**
 * Console hint bar (BUILD-BRIEF launcher; DESIGN.md console-shell tier).
 *
 * One line, chosen by the last input source that actually drove the launcher.
 * The hint is plain text, never colour or an icon alone, and changes
 * synchronously with the source so a player who picks up a gamepad or a phone
 * immediately sees the controls for the thing in their hands.
 */
import type { InputMode } from "./types.js";

export const HINT_KEYBOARD =
  "Arrow keys move · Enter plays · Tab reaches the room controls";
export const HINT_GAMEPAD =
  "D-pad or stick moves · A plays · B goes back";
export const HINT_REMOTE = "D-pad moves · OK plays · Back goes back";

export const HINTS: Readonly<Record<InputMode, string>> = {
  keyboard: HINT_KEYBOARD,
  gamepad: HINT_GAMEPAD,
  remote: HINT_REMOTE,
};

export class ConsoleHintBar {
  readonly element: HTMLElement;
  readonly textEl: HTMLElement;

  private mode: InputMode = "keyboard";

  constructor(doc: Document, initial: InputMode = "keyboard") {
    const root = doc.createElement("aside");
    root.className = "console-hints";
    root.setAttribute("role", "note");
    root.setAttribute("aria-label", "Controls");

    this.textEl = doc.createElement("p");
    this.textEl.className = "console-hints__text";
    root.append(this.textEl);

    this.element = root;
    this.setMode(initial);
  }

  get inputMode(): InputMode {
    return this.mode;
  }

  setMode(mode: InputMode): void {
    this.mode = mode;
    this.textEl.textContent = HINTS[mode];
  }

  destroy(): void {
    this.element.remove();
  }
}

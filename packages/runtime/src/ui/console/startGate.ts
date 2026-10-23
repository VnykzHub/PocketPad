/**
 * Console start gate (spec 25 §2.1; BUILD-BRIEF launcher §1).
 *
 * The first screen is a single gesture: any key, any gamepad button, any phone
 * remote action or a tap. That same gesture is the audio unlock, so no sound
 * can play before it. `unlockAudio` is called inside the gesture and the gate
 * waits for it before reporting `onStart`; a failed unlock still starts the
 * launcher (the silent fallback), it never traps the player.
 *
 * The gate is single-shot and removes its own listeners in `destroy()`. It is
 * destroyed the moment the home screen appears, so the 20-cycle launch/return
 * test sees no listener growth.
 */
import type { InputMode } from "./types.js";

export const START_GATE_PROMPT = "Press any key, button or tap to start";
export const START_GATE_HINT = "This also turns sound on.";

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "AltGraph",
  "Dead",
  "Unidentified",
]);

export interface StartGateOptions {
  readonly onStart: () => void;
  /** Runs inside the start gesture; rejects are swallowed. */
  readonly unlockAudio?: () => Promise<void>;
  readonly title?: string;
  /** Keyboard source; defaults to `doc.defaultView`. */
  readonly target?: EventTarget | null;
}

export class ConsoleStartGate {
  readonly element: HTMLElement;
  readonly primaryButton: HTMLButtonElement;

  private readonly onStart: () => void;
  private readonly unlockAudio: (() => Promise<void>) | undefined;
  private readonly target: EventTarget | null;
  private startedFlag = false;
  private destroyed = false;
  private activation: Promise<void> | null = null;

  constructor(doc: Document, options: StartGateOptions) {
    this.onStart = options.onStart;
    this.unlockAudio = options.unlockAudio;
    this.target =
      options.target !== undefined ? options.target : doc.defaultView;

    const root = doc.createElement("section");
    root.className = "console-gate";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Start");

    const title = doc.createElement("h1");
    title.className = "console-gate__title";
    title.textContent = options.title ?? "PocketPad";

    const prompt = doc.createElement("p");
    prompt.className = "console-gate__prompt";
    prompt.textContent = START_GATE_PROMPT;

    const button = doc.createElement("button");
    button.setAttribute("type", "button");
    button.className = "console-gate__button";
    button.textContent = "Start";
    button.addEventListener("click", this.handleClick);
    this.primaryButton = button;

    const hint = doc.createElement("p");
    hint.className = "console-gate__hint";
    hint.textContent = START_GATE_HINT;

    root.append(title, button, prompt, hint);
    root.addEventListener("pointerdown", this.handlePointerDown);
    this.element = root;

    if (this.target !== null) {
      this.target.addEventListener(
        "keydown",
        this.handleKeyDown as EventListener,
      );
    }
  }

  get started(): boolean {
    return this.startedFlag;
  }

  /** Moves focus to the single action (switch/keyboard parity). */
  focus(): void {
    if (this.destroyed) return;
    this.primaryButton.focus();
  }

  /**
   * Runs the gesture path exactly once. `source` is informational; every
   * source is an accepted start gesture. Never rejects.
   */
  async activate(source: InputMode | "pointer" = "pointer"): Promise<void> {
    void source;
    if (this.destroyed || this.startedFlag) {
      return this.activation ?? Promise.resolve();
    }
    this.startedFlag = true;
    const attempt = this.performStart();
    this.activation = attempt;
    try {
      await attempt;
    } finally {
      if (this.activation === attempt) this.activation = null;
    }
  }

  /**
   * Any keyboard key is a start gesture, except modifier-only keys and Tab
   * (Tab must stay available to reach the button without unlocking audio).
   * Returns true when the key was consumed.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (this.destroyed || this.startedFlag) return false;
    if (event.repeat === true) return false;
    const key = event.key;
    if (key === "Tab" || key === "Escape" || MODIFIER_KEYS.has(key)) {
      return false;
    }
    if (typeof event.preventDefault === "function") event.preventDefault();
    void this.activate("keyboard");
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.target !== null) {
      this.target.removeEventListener(
        "keydown",
        this.handleKeyDown as EventListener,
      );
    }
    this.primaryButton.removeEventListener("click", this.handleClick);
    this.element.removeEventListener("pointerdown", this.handlePointerDown);
    this.element.remove();
  }

  private async performStart(): Promise<void> {
    if (this.unlockAudio !== undefined) {
      try {
        await this.unlockAudio();
      } catch {
        // AudioBus.unlock never rejects; a swapped implementation might.
        // Either way the launcher starts with the visible silent fallback.
      }
    }
    if (this.destroyed) return;
    this.onStart();
  }

  private readonly handleClick = (): void => {
    void this.activate("pointer");
  };

  private readonly handlePointerDown = (): void => {
    void this.activate("pointer");
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    this.handleKey(event);
  };
}

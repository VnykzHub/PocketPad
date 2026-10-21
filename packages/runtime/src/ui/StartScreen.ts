/**
 * Start screen (D3-RT-05; FR-9.11, AR-4).
 *
 * Spec §9.6: the host opens on a "Press Enter to start" screen. The same
 * gesture that starts the game unlocks audio, because browsers (and TV
 * Chromium in particular) only allow `AudioContext.resume()` inside a user
 * gesture. Nothing in this module ever calls `playSfx`/`playMusic`; the bus
 * itself is silent until `unlock()` (no autoplay).
 *
 * TV remote (AR-4): a single primary action is the whole screen. Enter, Space,
 * the remote "OK"/"Select" key, and a legacy `keyCode` 13 all activate it;
 * arrow keys keep focus on that action instead of letting focus fall off the
 * page. The button is a real `<button>`, so it is focusable and keyboard
 * operable without a synthetic focus trap.
 *
 * The screen has no stylesheet of its own; it uses `lanpad-start*` classes and
 * the host adds them to `src/style.css` (see the D3-RT-05 integration notes):
 * focus visibility, TV-sized type and the audio-state colours belong there.
 *
 * Lifecycle: the host builds the screen, mounts `element`, feeds
 * `updateProgress()` from the asset loader, sets room credentials with
 * `setRoom()`, and receives `onStart()` exactly once after both assets are
 * ready and audio was unlocked (or found unavailable). A first gesture made
 * while assets are still loading still unlocks audio; it just does not start
 * the game yet.
 */
import type { AssetProgress } from "../assets/AssetLoader.js";
import { ProgressBar } from "../assets/ProgressBar.js";
import type { AudioBusState } from "../audio/AudioBus.js";

/** Exact label FR-9.11 asks for. */
export const START_LABEL = "Press Enter to start";

export const AUDIO_LOCKED_MESSAGE = "Sound is off until you press Enter.";
export const AUDIO_UNLOCKED_MESSAGE = "Sound on.";
export const AUDIO_UNAVAILABLE_MESSAGE =
  "Audio unavailable — the game will run without sound.";

export const AUDIO_ICON_MUTED = "🔇";
export const AUDIO_ICON_UNMUTED = "🔊";

/** The slice of `AudioBus` this screen needs; keeps tests free of Web Audio. */
export interface StartScreenAudio {
  readonly state: AudioBusState;
  unlock(): Promise<void>;
}

export interface StartScreenOptions {
  readonly audio: StartScreenAudio;
  /** Called once, after assets are ready and audio has been unlocked. */
  readonly onStart: () => void;
  /** Game title shown above the room credentials. Default "lanpad". */
  readonly title?: string;
  /**
   * Keyboard source. Defaults to `doc.defaultView`, i.e. the page window.
   * Injected in Node tests, which have no DOM.
   */
  readonly target?: EventTarget | null;
}

export class StartScreen {
  readonly element: HTMLElement;
  readonly primaryButton: HTMLButtonElement;
  readonly progressBar: ProgressBar;

  private readonly audio: StartScreenAudio;
  private readonly onStart: () => void;
  private readonly target: EventTarget | null;
  private readonly codeEl: HTMLElement;
  private readonly pinEl: HTMLElement;
  private readonly audioRow: HTMLElement;
  private readonly audioIcon: HTMLElement;
  private readonly audioText: HTMLElement;
  private readonly hintEl: HTMLElement;

  private assetsReady = false;
  private startedFlag = false;
  private gestureSeen = false;
  private activation: Promise<void> | null = null;
  private destroyed = false;

  constructor(doc: Document, options: StartScreenOptions) {
    this.audio = options.audio;
    this.onStart = options.onStart;
    this.target =
      options.target !== undefined ? options.target : doc.defaultView;

    const root = doc.createElement("section");
    root.className = "lanpad-start";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Game start");

    const title = doc.createElement("h2");
    title.className = "lanpad-start__title";
    title.textContent = options.title ?? "lanpad";

    const room = doc.createElement("div");
    room.className = "lanpad-start__room";

    this.codeEl = doc.createElement("span");
    this.codeEl.className = "lanpad-start__code";
    this.codeEl.setAttribute("aria-label", "Room code");
    this.codeEl.textContent = "----";

    this.pinEl = doc.createElement("span");
    this.pinEl.className = "lanpad-start__pin";
    this.pinEl.setAttribute("aria-label", "Room PIN");
    this.pinEl.textContent = "PIN ----";

    room.appendChild(this.codeEl);
    room.appendChild(this.pinEl);

    const button = doc.createElement("button");
    button.setAttribute("type", "button");
    button.className = "lanpad-start__button";
    button.textContent = START_LABEL;
    button.setAttribute("autofocus", "");
    button.addEventListener("click", this.handleClick);
    this.primaryButton = button;

    this.progressBar = new ProgressBar(doc, "Game assets");

    this.audioRow = doc.createElement("p");
    this.audioRow.className = "lanpad-start__audio";
    this.audioRow.setAttribute("role", "status");
    this.audioRow.setAttribute("aria-live", "polite");

    this.audioIcon = doc.createElement("span");
    this.audioIcon.className = "lanpad-start__audio-icon";
    this.audioIcon.setAttribute("aria-hidden", "true");

    this.audioText = doc.createElement("span");
    this.audioText.className = "lanpad-start__audio-text";

    this.audioRow.appendChild(this.audioIcon);
    this.audioRow.appendChild(this.audioText);

    this.hintEl = doc.createElement("p");
    this.hintEl.className = "lanpad-start__hint";
    this.hintEl.setAttribute("role", "status");
    this.hintEl.setAttribute("aria-live", "polite");
    this.hintEl.textContent = "Loading assets…";

    root.appendChild(title);
    root.appendChild(room);
    root.appendChild(button);
    root.appendChild(this.progressBar.element);
    root.appendChild(this.audioRow);
    root.appendChild(this.hintEl);

    this.element = root;
    this.renderAudioState();

    if (this.target !== null) {
      this.target.addEventListener(
        "keydown",
        this.handleKeyDown as EventListener,
      );
    }
  }

  /** True only after the loader reported `done`. */
  get ready(): boolean {
    return this.assetsReady;
  }

  /** True after `onStart` ran; activation is single-shot. */
  get started(): boolean {
    return this.startedFlag;
  }

  /** Shows the room credentials on the start screen (D4 reuses this shell). */
  setRoom(code: string | null, pin: string | null = null): void {
    this.codeEl.textContent =
      code === null || code.length === 0 ? "----" : code;
    this.pinEl.textContent =
      pin === null || pin.length === 0 ? "PIN ----" : `PIN ${pin}`;
  }

  /**
   * Feeds loader progress to the bar and flips `ready` when bytes are done.
   * The game still waits for the start gesture, so progress never starts it.
   */
  updateProgress(progress: AssetProgress): void {
    this.progressBar.update(progress);
    if (progress.done) {
      if (!this.assetsReady) {
        this.assetsReady = true;
        if (!this.startedFlag) this.setHint("Ready. Press Enter to start.");
      }
      return;
    }
    if (!this.startedFlag) this.setHint("Loading assets…");
  }

  /** Moves keyboard/remote focus to the single primary action (AR-4). */
  focus(): void {
    this.primaryButton.focus();
  }

  /**
   * Runs the gesture path: unlock audio (once) and start the game if assets
   * are ready. Safe to call from a click or key handler; concurrent calls share
   * one activation. Never rejects.
   */
  async activate(): Promise<void> {
    if (this.destroyed || this.startedFlag) return;
    const inFlight = this.activation;
    if (inFlight !== null) return inFlight;

    const attempt = this.performActivation();
    this.activation = attempt;
    try {
      await attempt;
    } finally {
      if (this.activation === attempt) this.activation = null;
    }
  }

  /** Removes listeners and the mounted tree. */
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
    this.progressBar.dispose();
    this.element.remove();
  }

  private async performActivation(): Promise<void> {
    this.gestureSeen = true;

    if (this.audio.state === "locked") {
      try {
        await this.audio.unlock();
      } catch {
        // AudioBus.unlock never rejects; a swapped implementation might.
        // Either way the screen keeps working and shows the silent fallback.
      }
    }
    this.renderAudioState();

    if (!this.assetsReady) {
      this.setHint("Assets are still loading…");
      return;
    }
    if (this.startedFlag) return;

    this.startedFlag = true;
    this.setHint("Starting…");
    this.onStart();
  }

  private renderAudioState(): void {
    const state = this.audio.state;
    if (state === "unlocked") {
      this.audioIcon.textContent = AUDIO_ICON_UNMUTED;
      this.audioText.textContent = AUDIO_UNLOCKED_MESSAGE;
      this.audioRow.dataset["state"] = "unlocked";
      this.audioRow.setAttribute("data-audio-state", "unlocked");
      return;
    }

    // Before the gesture the muted icon is the FR-9.11 "audio needs a gesture"
    // signal. After a failed attempt — or when Web Audio is missing — the same
    // row turns into the visible no-sound fallback.
    if (state === "unavailable" || this.gestureSeen) {
      this.audioIcon.textContent = AUDIO_ICON_MUTED;
      this.audioText.textContent = AUDIO_UNAVAILABLE_MESSAGE;
      this.audioRow.dataset["state"] = "unavailable";
      this.audioRow.setAttribute("data-audio-state", "unavailable");
      return;
    }

    this.audioIcon.textContent = AUDIO_ICON_MUTED;
    this.audioText.textContent = AUDIO_LOCKED_MESSAGE;
    this.audioRow.dataset["state"] = "locked";
    this.audioRow.setAttribute("data-audio-state", "locked");
  }

  private setHint(text: string): void {
    this.hintEl.textContent = text;
  }

  private readonly handleClick = (): void => {
    void this.activate();
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.destroyed) return;
    const key = event.key;
    const keyCode = typeof event.keyCode === "number" ? event.keyCode : 0;

    const isArrow =
      key === "ArrowUp" ||
      key === "ArrowDown" ||
      key === "ArrowLeft" ||
      key === "ArrowRight" ||
      (keyCode >= 37 && keyCode <= 40);
    if (isArrow) {
      // Do not let the remote's arrows scroll the TV page or drop focus.
      event.preventDefault();
      this.focus();
      return;
    }

    // "Select"/"OK" cover older TV remotes; keyCode 13 covers browsers that
    // report "Unidentified" for the remote's centre button.
    const isActivate =
      key === "Enter" ||
      key === " " ||
      key === "Spacebar" ||
      key === "Select" ||
      key === "OK" ||
      keyCode === 13;
    if (!isActivate) return;
    if (event.repeat === true) return;

    event.preventDefault();
    void this.activate();
  };
}

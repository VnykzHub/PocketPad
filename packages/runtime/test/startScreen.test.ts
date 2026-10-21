import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { AssetProgress } from "../src/assets/AssetLoader.js";
import type { AudioBusState } from "../src/audio/AudioBus.js";
import {
  AUDIO_ICON_MUTED,
  AUDIO_ICON_UNMUTED,
  START_LABEL,
  StartScreen,
  type StartScreenAudio,
} from "../src/ui/StartScreen.js";

// ---------------------------------------------------------------------------
// Fakes: the runtime test project runs in Node. The fake DOM implements only
// the surface StartScreen and ProgressBar use, so the assertions describe real
// browser behaviour (button activation, status text, dataset state).
// ---------------------------------------------------------------------------

type Listener = (event: unknown) => void;

class FakeElement {
  readonly tagName: string;
  className = "";
  textContent = "";
  hidden = false;
  type = "";
  focused = false;
  parent: FakeElement | null = null;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const parent = this.parent;
    if (parent === null) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  focus(): void {
    this.focused = true;
  }
}

class FakeDocument {
  defaultView: EventTarget | null = null;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

class FakeKeyboardTarget {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

class FakeAudio implements StartScreenAudio {
  state: AudioBusState;
  unlockCalls = 0;
  /** State the bus reports after a gesture (simulates a blocked context). */
  stateAfterUnlock: AudioBusState = "unlocked";

  constructor(state: AudioBusState = "locked") {
    this.state = state;
  }

  async unlock(): Promise<void> {
    this.unlockCalls += 1;
    this.state = this.stateAfterUnlock;
  }
}

interface FakeKeyEvent {
  readonly key: string;
  readonly keyCode: number;
  readonly repeat: boolean;
  prevented: number;
  preventDefault(): void;
}

function keyEvent(key: string, keyCode = 0, repeat = false): FakeKeyEvent {
  return {
    key,
    keyCode,
    repeat,
    prevented: 0,
    preventDefault(): void {
      this.prevented += 1;
    },
  };
}

function progress(done: boolean): AssetProgress {
  return {
    loadedBytes: done ? 100 : 40,
    totalBytes: 100,
    determinate: true,
    fraction: done ? 1 : 0.4,
    loadedCount: done ? 1 : 0,
    totalCount: 1,
    currentUrl: done ? null : "/cube.bin",
    done,
  };
}

/** Lets the async activation path settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function fake(element: HTMLElement): FakeElement {
  return element as unknown as FakeElement;
}

function findByClass(root: FakeElement, className: string): FakeElement | null {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) {
    const found = findByClass(child, className);
    if (found !== null) return found;
  }
  return null;
}

function partOf(screen: StartScreen, className: string): FakeElement {
  const found = findByClass(fake(screen.element), className);
  if (found === null) throw new Error(`missing .${className}`);
  return found;
}

interface ScreenHarness {
  readonly screen: StartScreen;
  readonly doc: FakeDocument;
  readonly target: FakeKeyboardTarget;
  readonly audio: FakeAudio;
  readonly starts: () => number;
}

function setup(audioState: AudioBusState = "locked"): ScreenHarness {
  const doc = new FakeDocument();
  const target = new FakeKeyboardTarget();
  const audio = new FakeAudio(audioState);
  let startCount = 0;
  const screen = new StartScreen(doc as unknown as Document, {
    audio,
    onStart: () => {
      startCount += 1;
    },
    title: "Reaction Duel",
    target: target as unknown as EventTarget,
  });
  return { screen, doc, target, audio, starts: () => startCount };
}

function press(target: FakeKeyboardTarget, event: FakeKeyEvent): void {
  target.dispatch("keydown", event as unknown as KeyboardEvent);
}

// ---------------------------------------------------------------------------
// Gesture-gated audio (FR-9.11)
// ---------------------------------------------------------------------------

describe("start screen audio gate", () => {
  test("[FR-9.11] nothing is unlocked or started before the first gesture", () => {
    const { screen, audio, target } = setup();

    expect(audio.unlockCalls).toBe(0);
    expect(screen.started).toBe(false);
    expect(screen.ready).toBe(false);

    const audioRow = partOf(screen, "lanpad-start__audio");
    expect(audioRow.dataset["state"]).toBe("locked");
    expect(audioRow.getAttribute("data-audio-state")).toBe("locked");
    expect(partOf(screen, "lanpad-start__audio-icon").textContent).toBe(
      AUDIO_ICON_MUTED,
    );
    expect(partOf(screen, "lanpad-start__audio-text").textContent).toContain(
      "Sound is off",
    );

    // An unrelated key neither unlocks audio nor starts the game.
    press(target, keyEvent("x"));
    expect(audio.unlockCalls).toBe(0);
    expect(screen.started).toBe(false);
  });

  test("[FR-9.11] Enter before assets are ready unlocks audio but defers the start", async () => {
    const { screen, audio, target, starts } = setup();
    screen.updateProgress(progress(false));

    press(target, keyEvent("Enter", 13));
    await flush();

    expect(audio.unlockCalls).toBe(1);
    expect(audio.state).toBe("unlocked");
    expect(screen.started).toBe(false);
    expect(starts()).toBe(0);
    expect(partOf(screen, "lanpad-start__hint").textContent).toContain(
      "still loading",
    );
    expect(partOf(screen, "lanpad-start__audio-icon").textContent).toBe(
      AUDIO_ICON_UNMUTED,
    );
    expect(partOf(screen, "lanpad-start__audio-text").textContent).toContain(
      "Sound on",
    );

    // Assets finish; the next Enter starts, and does not unlock a second time.
    screen.updateProgress(progress(true));
    expect(screen.ready).toBe(true);
    press(target, keyEvent("Enter", 13));
    await flush();

    expect(screen.started).toBe(true);
    expect(starts()).toBe(1);
    expect(audio.unlockCalls).toBe(1);
  });

  test("[FR-9.11] a repeated Enter after start does not start twice", async () => {
    const { screen, target, starts } = setup();
    screen.updateProgress(progress(true));

    press(target, keyEvent("Enter", 13));
    await flush();
    press(target, keyEvent("Enter", 13));
    press(target, keyEvent(" "));
    await flush();

    expect(starts()).toBe(1);
    expect(screen.started).toBe(true);
  });

  test("[FR-9.11] audio unavailable shows a visible fallback and still starts", async () => {
    const missing = setup("unavailable");
    missing.screen.updateProgress(progress(true));

    const rowBeforeGesture = partOf(missing.screen, "lanpad-start__audio");
    expect(rowBeforeGesture.dataset["state"]).toBe("unavailable");
    expect(
      partOf(missing.screen, "lanpad-start__audio-text").textContent,
    ).toContain("without sound");

    press(missing.target, keyEvent("Enter", 13));
    await flush();

    // No context is attempted when Web Audio is missing.
    expect(missing.audio.unlockCalls).toBe(0);
    expect(missing.starts()).toBe(1);
    expect(missing.screen.started).toBe(true);
  });

  test("[FR-9.11] a blocked unlock also falls back visibly", async () => {
    const blocked = setup();
    blocked.audio.stateAfterUnlock = "unavailable";
    blocked.screen.updateProgress(progress(true));

    press(blocked.target, keyEvent("Enter", 13));
    await flush();

    expect(blocked.audio.unlockCalls).toBe(1);
    expect(blocked.screen.started).toBe(true);
    const row = partOf(blocked.screen, "lanpad-start__audio");
    expect(row.dataset["state"]).toBe("unavailable");
    expect(
      partOf(blocked.screen, "lanpad-start__audio-text").textContent,
    ).toContain("without sound");
  });

  test("[FR-9.11] the start screen itself never triggers playback", () => {
    // StartScreen owns the gesture, not playback: only AudioBus plays, and it
    // is silent until unlock. A source scan keeps this rule from regressing.
    const source = readFileSync(
      fileURLToPath(new URL("../src/ui/StartScreen.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/\.playSfx\s*\(/);
    expect(source).not.toMatch(/\.playMusic\s*\(/);
    expect(source).toContain("unlock");
  });
});

// ---------------------------------------------------------------------------
// Remote operability (AR-4)
// ---------------------------------------------------------------------------

describe("remote operability", () => {
  test("[AR-4] arrow keys keep focus on the primary action and prevent scrolling", () => {
    const { screen, target } = setup();

    for (const [key, keyCode] of [
      ["ArrowUp", 38],
      ["ArrowDown", 40],
      ["ArrowLeft", 37],
      ["ArrowRight", 39],
    ] as const) {
      const event = keyEvent(key, keyCode);
      press(target, event);
      expect(event.prevented, `${key} must not scroll the TV page`).toBe(1);
    }

    // Older remotes report "Unidentified" and only set keyCode.
    const legacy = keyEvent("Unidentified", 40);
    press(target, legacy);
    expect(legacy.prevented).toBe(1);

    expect(fake(screen.primaryButton).focused).toBe(true);
  });

  test("[AR-4] remote Enter, OK/Select and Space activate the primary action", async () => {
    const keys: Array<[string, number]> = [
      ["Enter", 13],
      [" ", 32],
      ["Spacebar", 32],
      ["Select", 13],
      ["OK", 13],
    ];

    for (const [key, keyCode] of keys) {
      const { screen, target, starts } = setup();
      screen.updateProgress(progress(true));
      const event = keyEvent(key, keyCode);
      press(target, event);
      await flush();
      expect(event.prevented, `${key} must be handled`).toBe(1);
      expect(starts(), `${key} must start the game`).toBe(1);
    }
  });

  test("[AR-4] a legacy keyCode-only Enter starts the game", async () => {
    const { screen, target, starts } = setup();
    screen.updateProgress(progress(true));

    press(target, keyEvent("Unidentified", 13));
    await flush();

    expect(starts()).toBe(1);
  });

  test("[AR-4] a click is the same gesture path as the remote", async () => {
    const { screen, audio, starts } = setup();
    screen.updateProgress(progress(true));

    fake(screen.primaryButton).dispatch("click");
    await flush();

    expect(audio.unlockCalls).toBe(1);
    expect(starts()).toBe(1);
  });

  test("[AR-4] hold-to-repeat does not activate twice", async () => {
    const { screen, target, starts } = setup();
    screen.updateProgress(progress(true));

    press(target, keyEvent("Enter", 13, true));
    await flush();

    expect(starts()).toBe(0);
  });

  test("[AR-4] the primary action is one focused, labelled button", () => {
    const { screen } = setup();
    const button = fake(screen.primaryButton);

    expect(button.tagName).toBe("button");
    expect(button.textContent).toBe(START_LABEL);
    expect(button.className).toBe("lanpad-start__button");
    expect(button.attributes.get("autofocus")).toBe("");
    expect(screen.primaryButton.getAttribute("type")).toBe("button");

    screen.focus();
    expect(button.focused).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Room shell and loader progress
// ---------------------------------------------------------------------------

describe("start screen content", () => {
  test("[FR-9.11] the screen shows the title, room code and PIN", () => {
    const { screen } = setup();

    expect(partOf(screen, "lanpad-start__title").textContent).toBe(
      "Reaction Duel",
    );

    screen.setRoom("ABCD", "1234");
    expect(partOf(screen, "lanpad-start__code").textContent).toBe("ABCD");
    expect(partOf(screen, "lanpad-start__pin").textContent).toBe("PIN 1234");

    screen.setRoom(null, null);
    expect(partOf(screen, "lanpad-start__code").textContent).toBe("----");
    expect(partOf(screen, "lanpad-start__pin").textContent).toBe("PIN ----");
  });

  test("[FR-9.11] loader progress is shown and completion enables readiness", () => {
    const { screen } = setup();

    screen.updateProgress(progress(false));
    expect(screen.ready).toBe(false);
    expect(screen.progressBar.state?.label).toContain("40%");
    expect(partOf(screen, "lanpad-start__hint").textContent).toContain(
      "Loading assets",
    );

    screen.updateProgress(progress(true));
    expect(screen.ready).toBe(true);
    expect(screen.progressBar.state?.label).toBe("Ready");
    expect(partOf(screen, "lanpad-start__hint").textContent).toContain(
      "Press Enter to start",
    );
    // Progress never starts the game by itself.
    expect(screen.started).toBe(false);
  });

  test("destroy removes the keyboard listener and the mounted tree", () => {
    const { screen, target, audio, starts } = setup();
    const host = new FakeElement("div");
    host.appendChild(fake(screen.element));

    screen.destroy();

    expect(target.listenerCount("keydown")).toBe(0);
    expect(fake(screen.element).parent).toBeNull();
    expect(host.children).toHaveLength(0);

    press(target, keyEvent("Enter", 13));
    expect(audio.unlockCalls).toBe(0);
    expect(starts()).toBe(0);
  });
});


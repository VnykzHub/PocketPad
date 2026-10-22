/**
 * Text input and on-screen keyboard tests (D5-CTRL-03; FR-8.9, FR-7.8, SR-13, E16).
 *
 * jsdom has no layout and no `visualViewport`, so the viewport is a fake that
 * tests resize by hand, and element rects are stubbed. The real-device E16 run
 * (Android Chrome keyboard) is a manual experiment recorded in RESULTS.md;
 * these tests pin the logic it relies on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TextControl } from "@lanpad/sdk";
import type { JsonValue } from "@lanpad/protocol";
import { bindTextInput, prepareTextValue } from "../src/controls/textInput.js";
import {
  KEYBOARD_THRESHOLD_PX,
  ViewportTracker,
  ensureVisible,
  type ViewportWindow,
  type VisualViewportLike,
} from "../src/layout/viewport.js";
import { InputStore } from "../src/input/InputStore.js";
import { createControl } from "../src/controls/registry.js";
import type { ControlEventPriority, ControlEventSink } from "../src/controls/eventSink.js";

type Listener = () => void;

class ListenerBag {
  private readonly listeners = new Map<string, Set<Listener>>();

  add(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  remove(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener();
    }
  }

  count(): number {
    let total = 0;
    for (const set of this.listeners.values()) {
      total += set.size;
    }
    return total;
  }
}

class FakeVisualViewport implements VisualViewportLike {
  width = 400;
  height = 800;
  offsetTop = 0;
  readonly bag = new ListenerBag();

  addEventListener(type: "resize" | "scroll", listener: Listener): void {
    this.bag.add(type, listener);
  }

  removeEventListener(type: "resize" | "scroll", listener: Listener): void {
    this.bag.remove(type, listener);
  }

  resize(width: number, height: number, offsetTop = 0): void {
    this.width = width;
    this.height = height;
    this.offsetTop = offsetTop;
    this.bag.fire("resize");
  }
}

class FakeWindow implements ViewportWindow {
  innerWidth = 400;
  innerHeight = 800;
  readonly bag = new ListenerBag();

  constructor(readonly visualViewport: FakeVisualViewport | null) {}

  addEventListener(type: "resize" | "orientationchange", listener: Listener): void {
    this.bag.add(type, listener);
  }

  removeEventListener(type: "resize" | "orientationchange", listener: Listener): void {
    this.bag.remove(type, listener);
  }
}

function stubRect(element: Element, top: number, bottom: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ top, bottom } as DOMRect);
}

function mountInput(top = 700, bottom = 744): {
  input: HTMLInputElement;
  scroll: ReturnType<typeof vi.fn>;
} {
  const input = document.createElement("input");
  input.type = "text";
  document.body.append(input);
  stubRect(input, top, bottom);
  const scroll = vi.fn();
  input.scrollIntoView = scroll;
  return { input, scroll };
}

function typeText(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(input: HTMLInputElement, init: KeyboardEventInit = {}): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init }));
}

function recorder(): { sent: string[]; onSubmit: (value: string) => boolean } {
  const sent: string[] = [];
  return {
    sent,
    onSubmit: (value) => {
      sent.push(value);
      return true;
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("[SR-13] text is sent as plain text and truncated to maxLen", () => {
  it("[SR-13] prepareTextValue strips controls, truncates by code point, then trims", () => {
    expect(prepareTextValue("  a\u0000b\u0007c  ", 10)).toBe("abc");
    expect(prepareTextValue("\u{1F600}\u{1F600}\u{1F600}", 2)).toBe("\u{1F600}\u{1F600}");
    expect(prepareTextValue("abc   ", 4)).toBe("abc");
    expect(prepareTextValue("   ", 4)).toBe("");
  });

  it("[SR-13] typing or pasting past maxLen is truncated and HTML stays literal text", () => {
    const { input } = mountInput();
    const { sent, onSubmit } = recorder();
    bindTextInput(input, { maxLen: 12, onSubmit });

    typeText(input, '<img src=x onerror="alert(1)">');
    expect(input.value).toBe("<img src=x o");
    pressEnter(input);
    expect(sent).toEqual(["<img src=x o"]);
    expect(document.querySelector("img")).toBeNull();
  });

  it("[SR-13] backspace below the limit never rewrites the value or moves the caret", () => {
    const { input } = mountInput();
    bindTextInput(input, { maxLen: 5, onSubmit: () => true });
    typeText(input, "hello");
    const select = vi.spyOn(input, "setSelectionRange");
    typeText(input, "hell");
    expect(input.value).toBe("hell");
    expect(select).not.toHaveBeenCalled();
  });
});

describe("[SR-13] IME composition is never interrupted", () => {
  it("[SR-13] truncation waits for compositionend and Enter while composing does not submit", () => {
    const { input } = mountInput();
    const { sent, onSubmit } = recorder();
    const binding = bindTextInput(input, { maxLen: 3, onSubmit });

    input.dispatchEvent(new CompositionEvent("compositionstart"));
    expect(binding.composing).toBe(true);
    typeText(input, "nihon");
    expect(input.value).toBe("nihon");
    pressEnter(input);
    pressEnter(input, { isComposing: true });
    expect(sent).toEqual([]);

    input.value = "日本語です";
    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(binding.composing).toBe(false);
    expect(input.value).toBe("日本語");
    // Android reports IME key events as keyCode 229 even after composition.
    pressEnter(input, { keyCode: 229 });
    expect(sent).toEqual([]);
    pressEnter(input);
    expect(sent).toEqual(["日本語"]);
  });
});

describe("[FR-7.8] text submits one event, not per keystroke", () => {
  it("[FR-7.8] keystrokes send nothing; Enter sends once and clears", () => {
    const { input } = mountInput();
    const { sent, onSubmit } = recorder();
    bindTextInput(input, { maxLen: 20, onSubmit });
    for (const prefix of ["c", "ca", "cat"]) {
      typeText(input, prefix);
    }
    expect(sent).toEqual([]);
    pressEnter(input);
    expect(sent).toEqual(["cat"]);
    expect(input.value).toBe("");
    pressEnter(input);
    expect(sent).toEqual(["cat"]);
  });

  it("[FR-7.8] a rejected submit keeps the text", () => {
    const { input } = mountInput();
    bindTextInput(input, { maxLen: 20, onSubmit: () => false });
    typeText(input, "dog");
    pressEnter(input);
    expect(input.value).toBe("dog");
  });

  it("[FR-7.8] submit blurs by default and keeps focus with keepFocus", () => {
    const first = mountInput();
    bindTextInput(first.input, { maxLen: 20, onSubmit: () => true });
    first.input.focus();
    typeText(first.input, "a");
    pressEnter(first.input);
    expect(document.activeElement).not.toBe(first.input);

    const second = mountInput();
    bindTextInput(second.input, { maxLen: 20, keepFocus: true, onSubmit: () => true });
    second.input.focus();
    typeText(second.input, "b");
    pressEnter(second.input);
    expect(document.activeElement).toBe(second.input);
  });
});

describe("[FR-8.9] keyboard resize keeps the text control usable", () => {
  it("[FR-8.9] the tracker reads visualViewport and detects an open keyboard", () => {
    const visual = new FakeVisualViewport();
    const win = new FakeWindow(visual);
    const tracker = new ViewportTracker(win);
    const seen: boolean[] = [];
    tracker.subscribe((metrics) => seen.push(metrics.keyboardOpen));

    expect(tracker.metrics()).toEqual({
      width: 400,
      visibleHeight: 800,
      offsetTop: 0,
      keyboardOpen: false,
    });
    // URL-bar jitter is not a keyboard.
    visual.resize(400, 800 - KEYBOARD_THRESHOLD_PX + 10);
    visual.resize(400, 420);
    expect(tracker.metrics().keyboardOpen).toBe(true);
    visual.resize(400, 800);
    expect(seen).toEqual([false, true, false]);

    tracker.dispose();
    expect(visual.bag.count()).toBe(0);
    expect(win.bag.count()).toBe(0);
  });

  it("[FR-8.9] rotation resets the baseline instead of reporting a keyboard", () => {
    const visual = new FakeVisualViewport();
    const tracker = new ViewportTracker(new FakeWindow(visual));
    visual.resize(800, 400);
    expect(tracker.metrics()).toMatchObject({ width: 800, visibleHeight: 400, keyboardOpen: false });
    visual.resize(800, 180);
    expect(tracker.metrics().keyboardOpen).toBe(true);
  });

  it("[FR-8.9] without visualViewport the tracker falls back to innerHeight", () => {
    const win = new FakeWindow(null);
    const tracker = new ViewportTracker(win);
    win.innerHeight = 400;
    win.bag.fire("resize");
    expect(tracker.metrics()).toMatchObject({
      visibleHeight: 400,
      offsetTop: 0,
      keyboardOpen: true,
    });
  });

  it("[FR-8.9] ensureVisible scrolls only when the element is outside the visible band", () => {
    const { input, scroll } = mountInput(300, 344);
    const open = { width: 400, visibleHeight: 300, offsetTop: 0, keyboardOpen: true };
    const closed = { width: 400, visibleHeight: 800, offsetTop: 0, keyboardOpen: false };
    expect(ensureVisible(input, closed)).toBe(false);
    expect(ensureVisible(input, open)).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
    // A visual viewport panned down by the keyboard counts its offsetTop.
    expect(ensureVisible(input, { ...open, offsetTop: 100 })).toBe(false);
  });

  it("[FR-8.9] a focused input is scrolled back into view when the keyboard opens", () => {
    const visual = new FakeVisualViewport();
    const tracker = new ViewportTracker(new FakeWindow(visual));
    const { input, scroll } = mountInput(700, 744);
    bindTextInput(input, { maxLen: 20, viewport: tracker, onSubmit: () => true });

    input.focus();
    expect(scroll).not.toHaveBeenCalled();
    visual.resize(400, 420);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("[FR-8.9] typed text survives a rotation/reflow while focused", () => {
    const visual = new FakeVisualViewport();
    const tracker = new ViewportTracker(new FakeWindow(visual));
    const { input } = mountInput();
    bindTextInput(input, { maxLen: 20, viewport: tracker, onSubmit: () => true });
    input.focus();
    typeText(input, "keep me");
    visual.resize(800, 400);
    visual.resize(800, 200);
    expect(input.value).toBe("keep me");
    expect(document.activeElement).toBe(input);
  });
});

describe("[FR-8.9] focus and listener cleanup", () => {
  it("[FR-8.9] blur stops viewport tracking", () => {
    const visual = new FakeVisualViewport();
    const tracker = new ViewportTracker(new FakeWindow(visual));
    const { input, scroll } = mountInput(700, 744);
    bindTextInput(input, { maxLen: 20, viewport: tracker, onSubmit: () => true });
    input.focus();
    input.blur();
    visual.resize(400, 420);
    expect(scroll).not.toHaveBeenCalled();
  });

  it("[FR-8.9] dispose blurs, unsubscribes and removes every listener", () => {
    const visual = new FakeVisualViewport();
    const tracker = new ViewportTracker(new FakeWindow(visual));
    const { input, scroll } = mountInput(700, 744);
    const { sent, onSubmit } = recorder();
    const binding = bindTextInput(input, { maxLen: 3, viewport: tracker, onSubmit });
    input.focus();
    binding.dispose();
    expect(document.activeElement).not.toBe(input);

    visual.resize(400, 420);
    expect(scroll).not.toHaveBeenCalled();
    typeText(input, "abcdef");
    expect(input.value).toBe("abcdef");
    pressEnter(input);
    expect(sent).toEqual([]);
    expect(binding.submit()).toBe(false);
  });
});

describe("[E16] text control under a simulated on-screen keyboard", () => {
  const TEXT: TextControl = {
    type: "text",
    id: "answer",
    x: "50%",
    y: "90%",
    w: "80%",
    h: "12%",
    event: "answer",
    maxLen: 8,
  };

  class Sink implements ControlEventSink {
    readonly events: { name: string; data: JsonValue; priority: ControlEventPriority | undefined }[] =
      [];

    enqueue(name: string, data: JsonValue, priority?: ControlEventPriority): void {
      this.events.push({ name, data, priority });
    }
  }

  it("[E16] the text control emits {value} once and stays visible when the keyboard opens", () => {
    const visual = new FakeVisualViewport();
    const tracker = new ViewportTracker(new FakeWindow(visual));
    const sink = new Sink();
    const renderer = createControl(TEXT, {
      input: new InputStore(),
      surfaceSize: { width: 400, height: 800 },
      events: sink,
      viewport: tracker,
    });
    document.body.append(renderer.element);
    const input = renderer.element.querySelector("input");
    if (input === null) {
      throw new Error("text renderer is missing its input");
    }
    stubRect(input, 700, 748);
    const scroll = vi.fn();
    input.scrollIntoView = scroll;

    input.focus();
    visual.resize(400, 430);
    expect(tracker.metrics().keyboardOpen).toBe(true);
    expect(scroll).toHaveBeenCalled();

    typeText(input, "  cat  ");
    pressEnter(input);
    expect(sink.events).toEqual([{ name: "answer", data: { value: "cat" }, priority: "high" }]);

    renderer.dispose();
    scroll.mockClear();
    visual.resize(400, 800);
    visual.resize(400, 430);
    expect(scroll).not.toHaveBeenCalled();
  });
});

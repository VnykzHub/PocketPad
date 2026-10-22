import { describe, expect, test } from "vitest";
import {
  RESULTS_BACK_LABEL,
  RESULTS_PLAY_AGAIN_LABEL,
  RESULTS_WIN_LABEL,
  ResultsOverlay,
  playerColorVariable,
  type ResultsData,
} from "../src/ui/ResultsOverlay.js";

// ---------------------------------------------------------------------------
// Minimal jsdom-shaped fake for the runtime's Node test project. Only the DOM
// surface ResultsOverlay uses is implemented.
// ---------------------------------------------------------------------------

type Listener = (event: unknown) => void;

class FakeStyle {
  opacity = "";
  transform = "";
  transition = "";
  private readonly values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? "";
  }
}

class FakeElement {
  readonly tagName: string;
  className = "";
  textContent = "";
  hidden = false;
  id = "";
  focused = false;
  parent: FakeElement | null = null;
  readonly style = new FakeStyle();
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

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.append(...nodes);
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
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  focus(): void {
    let top: FakeElement | null = this.parent;
    if (top === null) {
      this.clearFocus();
    } else {
      while (top.parent !== null) top = top.parent;
      top.clearFocus();
    }
    this.focused = true;
    for (const listener of [...(this.listeners.get("focus") ?? [])]) {
      listener({ type: "focus" });
    }
  }

  private clearFocus(): void {
    this.focused = false;
    for (const child of this.children) child.clearFocus();
  }
}

class FakeDocument {
  readonly body = new FakeElement("body");
  defaultView: EventTarget | null = null;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

interface FakeKeyEvent {
  readonly key: string;
  readonly keyCode: number;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
  prevented: number;
  preventDefault(): void;
}

function keyEvent(
  key: string,
  keyCode = 0,
  options: { repeat?: boolean; shiftKey?: boolean } = {},
): FakeKeyEvent {
  return {
    key,
    keyCode,
    repeat: options.repeat ?? false,
    shiftKey: options.shiftKey ?? false,
    prevented: 0,
    preventDefault(): void {
      this.prevented += 1;
    },
  };
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

function findAllByClass(root: FakeElement, className: string): FakeElement[] {
  const found: FakeElement[] = [];
  const visit = (node: FakeElement): void => {
    if (node.className.split(/\s+/).includes(className)) found.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

const DATA: ResultsData = {
  title: "Round over",
  subtitle: "Player 2 wins the match",
  rows: [
    { slot: 1, label: "Player 1", value: "12" },
    { slot: 2, label: "Player 2", value: "18", winner: true },
    { slot: 3, label: "Player 3", value: "9" },
  ],
  rematch: true,
};

interface OverlayHarness {
  readonly overlay: ResultsOverlay;
  readonly doc: FakeDocument;
  readonly rematches: () => number;
  readonly backs: () => number;
}

function setup(options: { reducedMotion?: boolean } = {}): OverlayHarness {
  const doc = new FakeDocument();
  let rematchCount = 0;
  let backCount = 0;
  const overlay = new ResultsOverlay(doc as unknown as Document, {
    root: doc.body as unknown as HTMLElement,
    ...(options.reducedMotion === undefined
      ? {}
      : { reducedMotion: options.reducedMotion }),
  });
  overlay.show(DATA, {
    onRematch: () => {
      rematchCount += 1;
    },
    onBack: () => {
      backCount += 1;
    },
  });
  return {
    overlay,
    doc,
    rematches: () => rematchCount,
    backs: () => backCount,
  };
}

function panelOf(overlay: ResultsOverlay): FakeElement {
  const panel = findByClass(fake(overlay.element), "lanpad-results__panel");
  if (panel === null) throw new Error("missing results panel");
  return panel;
}

function actionsOf(overlay: ResultsOverlay): FakeElement[] {
  return findAllByClass(fake(overlay.element), "lanpad-results__action");
}

// ---------------------------------------------------------------------------
// Content and player identity (HP-05)
// ---------------------------------------------------------------------------

describe("results overlay content", () => {
  test("[AR-4] HP-05 shows the supplied title, subtitle, rows and winner", () => {
    const { overlay } = setup();
    const panel = panelOf(overlay);

    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).not.toBeNull();

    const title = findByClass(panel, "lanpad-results__title");
    expect(title?.textContent).toBe("Round over");

    const subtitle = findByClass(panel, "lanpad-results__subtitle");
    expect(subtitle?.textContent).toBe("Player 2 wins the match");
    expect(subtitle?.hidden).toBe(false);
    expect(panel.getAttribute("aria-describedby")).toBe(subtitle?.id ?? null);

    const rows = findAllByClass(panel, "lanpad-results__row");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.dataset["slot"]).toBe("1");
    expect(rows[1]?.dataset["winner"]).toBe("true");
    expect(rows[2]?.dataset["winner"]).toBeUndefined();
    expect(rows[2]?.dataset["slot"]).toBe("3");

    expect(
      findByClass(rows[0] as FakeElement, "lanpad-results__label")?.textContent,
    ).toBe("Player 1");
    expect(
      findByClass(rows[0] as FakeElement, "lanpad-results__value")?.textContent,
    ).toBe("12");
    expect(findByClass(rows[0] as FakeElement, "lanpad-results__win")).toBeNull();

    expect(
      findByClass(rows[1] as FakeElement, "lanpad-results__win")?.textContent,
    ).toBe(RESULTS_WIN_LABEL);

    const swatch = findByClass(rows[1] as FakeElement, "lanpad-results__swatch");
    expect(swatch?.style.getPropertyValue("--player-color")).toBe(
      "var(--player-2)",
    );
    expect(playerColorVariable(99)).toBe("var(--player-8)");
    expect(playerColorVariable(0)).toBe("var(--player-1)");
  });

  test("[AR-4] HP-05 renders a winner with a word, not colour alone", () => {
    const { overlay } = setup();
    const winnerRow = findAllByClass(
      fake(overlay.element),
      "lanpad-results__row",
    )[1];

    expect(winnerRow?.dataset["winner"]).toBe("true");
    expect(
      findByClass(winnerRow as FakeElement, "lanpad-results__win")?.textContent,
    ).toBe("WIN");
    expect(
      findByClass(winnerRow as FakeElement, "lanpad-results__value")?.textContent,
    ).toBe("18");
  });

  test("[AR-4] HP-05 omits an absent subtitle", () => {
    const { overlay } = setup();
    overlay.show(
      { title: "Round over", rows: [], rematch: false },
      { onRematch: () => undefined, onBack: () => undefined },
    );

    const panel = panelOf(overlay);
    const subtitle = findByClass(panel, "lanpad-results__subtitle");
    expect(subtitle?.hidden).toBe(true);
    expect(panel.getAttribute("aria-describedby")).toBeNull();
    overlay.destroy();
  });
});

// ---------------------------------------------------------------------------
// Focus order and actions (HP-05; AR-4)
// ---------------------------------------------------------------------------

describe("results overlay actions", () => {
  test("[AR-4] HP-05 focuses Play again first and traps Tab in the panel", () => {
    const { overlay } = setup();
    const actions = actionsOf(overlay);

    expect(actions.map((action) => action.textContent)).toEqual([
      RESULTS_PLAY_AGAIN_LABEL,
      RESULTS_BACK_LABEL,
    ]);
    expect((actions[0] as FakeElement).focused).toBe(true);

    const tab = keyEvent("Tab", 9);
    fake(overlay.element).dispatch("keydown", tab as unknown as KeyboardEvent);
    expect(tab.prevented).toBe(1);
    expect((actions[1] as FakeElement).focused).toBe(true);

    fake(overlay.element).dispatch(
      "keydown",
      keyEvent("Tab", 9) as unknown as KeyboardEvent,
    );
    expect((actions[0] as FakeElement).focused).toBe(true);

    fake(overlay.element).dispatch(
      "keydown",
      keyEvent("Tab", 9, { shiftKey: true }) as unknown as KeyboardEvent,
    );
    expect((actions[1] as FakeElement).focused).toBe(true);

    overlay.destroy();
  });

  test("[AR-4] HP-05 callbacks fire once and each closes the overlay", () => {
    const rematch = setup();
    const rematchActions = actionsOf(rematch.overlay);
    (rematchActions[0] as FakeElement).dispatch("click");
    (rematchActions[0] as FakeElement).dispatch("click");
    expect(rematch.rematches()).toBe(1);
    expect(rematch.backs()).toBe(0);
    expect(rematch.overlay.isVisible).toBe(false);
    rematch.overlay.destroy();

    const back = setup();
    const backActions = actionsOf(back.overlay);
    (backActions[1] as FakeElement).dispatch("click");
    (backActions[1] as FakeElement).dispatch("click");
    expect(back.backs()).toBe(1);
    expect(back.rematches()).toBe(0);
    expect(back.overlay.isVisible).toBe(false);
    back.overlay.destroy();
  });

  test("[AR-4] HP-05 hides Play again when rematch is false", () => {
    const { overlay } = setup();
    overlay.show(
      { title: "Match over", rows: [], rematch: false },
      { onRematch: () => undefined, onBack: () => undefined },
    );

    const actions = actionsOf(overlay);
    expect(actions.map((action) => action.textContent)).toEqual([
      RESULTS_BACK_LABEL,
    ]);
    expect((actions[0] as FakeElement).focused).toBe(true);

    overlay.destroy();
  });
});

// ---------------------------------------------------------------------------
// Motion and lifecycle (HP-05)
// ---------------------------------------------------------------------------

describe("results overlay motion", () => {
  test("[AR-4] HP-05 enters with the 220ms scale and finishes at scale 1", async () => {
    const { overlay } = setup();
    const panel = panelOf(overlay);

    expect(panel.style.transform).toBe("scale(0.96)");
    await flush();
    expect(panel.style.transform).toBe("scale(1)");
    expect(panel.style.opacity).toBe("1");
    expect(panel.style.transition).toContain("220ms");

    overlay.destroy();
  });

  test("[AR-4] HP-05 reduced motion removes the scale and keeps opacity", async () => {
    const { overlay } = setup({ reducedMotion: true });
    const panel = panelOf(overlay);

    expect(fake(overlay.element).dataset["reducedMotion"]).toBe("true");
    expect(panel.style.transform).toBe("none");

    await flush();
    expect(panel.style.transform).toBe("none");
    expect(panel.style.opacity).toBe("1");
    expect(panel.style.transition).not.toContain("transform");

    overlay.destroy();
  });

  test("[AR-4] HP-05 destroy removes the overlay and stops callbacks", () => {
    const { overlay, rematches } = setup();
    const play = actionsOf(overlay)[0] as FakeElement;

    overlay.destroy();
    expect(fake(overlay.element).parent).toBeNull();
    expect(overlay.isVisible).toBe(false);

    play.dispatch("click");
    expect(rematches()).toBe(0);
  });
});

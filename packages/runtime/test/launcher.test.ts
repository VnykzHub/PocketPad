import { describe, expect, test } from "vitest";
import {
  LAUNCHER_EMPTY_HINT,
  LAUNCHER_EMPTY_TITLE,
  LAUNCHER_HEADING,
  LAUNCHER_MISSING_DESCRIPTION,
  LAUNCHER_UNTITLED,
  Launcher,
  playerRangeLabel,
  type LauncherGame,
} from "../src/ui/Launcher.js";

// ---------------------------------------------------------------------------
// Minimal jsdom-shaped fake. The runtime test project runs in Node, so the
// fake implements only the DOM surface Launcher uses: elements, attributes,
// dataset, class names, child lists, focus and event listeners.
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
    // Real DOM focus events do not bubble, but they do reach listeners on the
    // focused element. Components use that to track the active card.
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

function textOf(root: FakeElement, className: string): string {
  return findByClass(root, className)?.textContent ?? "";
}

function allText(root: FakeElement): string {
  let text = root.textContent;
  for (const child of root.children) text += ` ${allText(child)}`;
  return text;
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

function gameEntry(overrides: {
  slug: string;
  name: string;
  minPlayers?: number;
  maxPlayers?: number;
  description?: string;
  connected?: number;
}): LauncherGame {
  return {
    slug: overrides.slug,
    name: overrides.name,
    minPlayers: overrides.minPlayers ?? 1,
    maxPlayers: overrides.maxPlayers ?? 8,
    needsGyro: false,
    manifestUrl: `/games/${overrides.slug}/game.manifest.json`,
    ...(overrides.description === undefined
      ? {}
      : { description: overrides.description }),
    ...(overrides.connected === undefined
      ? {}
      : { connected: overrides.connected }),
  };
}

interface LauncherHarness {
  readonly launcher: Launcher;
  readonly doc: FakeDocument;
  readonly launched: string[];
}

function setup(games: ReadonlyArray<LauncherGame>): LauncherHarness {
  const doc = new FakeDocument();
  const launched: string[] = [];
  const launcher = new Launcher(doc as unknown as Document, {
    games,
    onLaunch: (slug) => {
      launched.push(slug);
    },
  });
  launcher.mount(doc.body as unknown as HTMLElement);
  return { launcher, doc, launched };
}

function cardsOf(launcher: Launcher): FakeElement[] {
  return findAllByClass(fake(launcher.element), "lanpad-launcher__card");
}

function press(launcher: Launcher, event: FakeKeyEvent): void {
  fake(launcher.element).dispatch("keydown", event as unknown as KeyboardEvent);
}

const GAMES: ReadonlyArray<LauncherGame> = [
  gameEntry({
    slug: "reaction-duel",
    name: "Reaction Duel",
    minPlayers: 1,
    maxPlayers: 8,
    description: "Match the signal.",
  }),
  gameEntry({
    slug: "coin-run",
    name: "Coin Run",
    minPlayers: 2,
    maxPlayers: 4,
    description: "Race for 20 coins.",
    connected: 2,
  }),
];

// ---------------------------------------------------------------------------
// Manifest-driven shelf (HP-03; FR-10.3)
// ---------------------------------------------------------------------------

describe("launcher shelf", () => {
  test("[FR-10.3] HP-03 lists every supplied entry from manifest data", () => {
    const { launcher } = setup(GAMES);
    const root = fake(launcher.element);

    expect(textOf(root, "lanpad-launcher__title")).toBe(LAUNCHER_HEADING);

    const cards = cardsOf(launcher);
    expect(cards).toHaveLength(2);

    const first = cards[0] as FakeElement;
    expect(first.tagName).toBe("button");
    expect(first.dataset["slug"]).toBe("reaction-duel");
    expect(textOf(first, "lanpad-launcher__card-title")).toBe("Reaction Duel");
    expect(textOf(first, "lanpad-launcher__card-meta")).toBe("1–8 players");
    expect(textOf(first, "lanpad-launcher__card-description")).toBe(
      "Match the signal.",
    );
    expect(findByClass(first, "lanpad-launcher__card-connected")).toBeNull();

    const second = cards[1] as FakeElement;
    expect(second.dataset["slug"]).toBe("coin-run");
    expect(textOf(second, "lanpad-launcher__card-title")).toBe("Coin Run");
    expect(textOf(second, "lanpad-launcher__card-meta")).toBe("2–4 players");
    expect(textOf(second, "lanpad-launcher__card-connected")).toBe("2 connected");
  });

  test("[FR-10.3] HP-03 renders neutral lines when optional fields are absent", () => {
    const { launcher } = setup([
      gameEntry({ slug: "unnamed", name: "   " }),
    ]);
    const card = cardsOf(launcher)[0] as FakeElement;

    expect(textOf(card, "lanpad-launcher__card-title")).toBe(LAUNCHER_UNTITLED);
    expect(textOf(card, "lanpad-launcher__card-description")).toBe(
      LAUNCHER_MISSING_DESCRIPTION,
    );
    expect(
      findByClass(card, "lanpad-launcher__card-description")?.dataset["missing"],
    ).toBe("true");
    expect(allText(fake(launcher.element))).not.toContain("undefined");
  });

  test("[FR-10.3] HP-03 maps the player range without a hard-coded game menu", () => {
    expect(playerRangeLabel(1, 1)).toBe("1 player");
    expect(playerRangeLabel(2, 2)).toBe("2 players");
    expect(playerRangeLabel(1, 8)).toBe("1–8 players");
    expect(playerRangeLabel(Number.NaN, 4)).toBe("Players");
  });

  test("[AR-4] HP-03 empty state keeps the frame and explains what to do", () => {
    const { launcher } = setup([]);
    const root = fake(launcher.element);

    expect(textOf(root, "lanpad-launcher__title")).toBe(LAUNCHER_HEADING);
    expect(textOf(root, "lanpad-launcher__empty-title")).toBe(
      LAUNCHER_EMPTY_TITLE,
    );
    expect(textOf(root, "lanpad-launcher__empty-hint")).toBe(
      LAUNCHER_EMPTY_HINT,
    );
    expect(cardsOf(launcher)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Remote operability (HP-03; AR-4)
// ---------------------------------------------------------------------------

describe("launcher remote navigation", () => {
  test("[AR-4] HP-03 arrows move focus between cards and wrap at the ends", () => {
    const { launcher } = setup(GAMES);
    const cards = cardsOf(launcher);

    launcher.focus();
    expect((cards[0] as FakeElement).focused).toBe(true);

    const events = [
      keyEvent("ArrowRight", 39),
      keyEvent("ArrowDown", 40),
      keyEvent("ArrowRight", 39),
      keyEvent("ArrowLeft", 37),
      keyEvent("ArrowUp", 38),
    ];
    // Two cards: right -> 1, down -> 0 (wrap), right -> 1, left -> 0,
    // up -> 1 (wrap).
    const expected = [1, 0, 1, 0, 1];

    events.forEach((event, index) => {
      press(launcher, event);
      expect(event.prevented, `${event.key} must not scroll`).toBe(1);
      expect(
        (cards[expected[index] as number] as FakeElement).focused,
        `focus after ${event.key}`,
      ).toBe(true);
    });

    const home = keyEvent("Home", 36);
    press(launcher, home);
    expect(home.prevented).toBe(1);
    expect((cards[0] as FakeElement).focused).toBe(true);

    const end = keyEvent("End", 35);
    press(launcher, end);
    expect((cards[1] as FakeElement).focused).toBe(true);
  });

  test("[AR-4] HP-03 Enter, OK/Select and legacy keyCode activate the focused card", () => {
    const { launcher, launched } = setup(GAMES);
    const cards = cardsOf(launcher);

    cards[1]?.focus();
    const enter = keyEvent("Enter", 13);
    press(launcher, enter);
    expect(enter.prevented).toBe(1);
    expect(launched).toEqual(["coin-run"]);

    const ok = keyEvent("OK", 13);
    press(launcher, ok);
    expect(launched).toEqual(["coin-run", "coin-run"]);

    const legacy = keyEvent("Unidentified", 13);
    press(launcher, legacy);
    expect(launched).toEqual(["coin-run", "coin-run", "coin-run"]);

    const repeated = keyEvent("Enter", 13, { repeat: true });
    press(launcher, repeated);
    expect(launched).toHaveLength(3);
  });

  test("[AR-4] HP-03 a click launches the card's own slug", () => {
    const { launcher, launched } = setup(GAMES);
    const cards = cardsOf(launcher);

    (cards[0] as FakeElement).dispatch("click");
    expect(launched).toEqual(["reaction-duel"]);
  });

  test("[AR-4] HP-03 destroy removes the tree and stops launching", () => {
    const { launcher, launched } = setup(GAMES);
    const cards = cardsOf(launcher);

    launcher.destroy();
    expect(fake(launcher.element).parent).toBeNull();

    (cards[0] as FakeElement).dispatch("click");
    press(launcher, keyEvent("Enter", 13));
    expect(launched).toEqual([]);
  });
});

import { describe, expect, test } from "vitest";
import {
  LEAVE_BACK_LABEL,
  LEAVE_BODY,
  LEAVE_KEEP_LABEL,
  LEAVE_TITLE,
  LeaveConfirm,
} from "../src/ui/LeaveConfirm.js";

// ---------------------------------------------------------------------------
// Minimal jsdom-shaped fake for the runtime's Node test project. Only the DOM
// surface LeaveConfirm uses is implemented.
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

interface LeaveHarness {
  readonly overlay: LeaveConfirm;
  readonly doc: FakeDocument;
  readonly keeps: () => number;
  readonly backs: () => number;
}

function setup(options: { reducedMotion?: boolean } = {}): LeaveHarness {
  const doc = new FakeDocument();
  let keepCount = 0;
  let backCount = 0;
  const overlay = new LeaveConfirm(doc as unknown as Document, {
    root: doc.body as unknown as HTMLElement,
    ...(options.reducedMotion === undefined
      ? {}
      : { reducedMotion: options.reducedMotion }),
  });
  overlay.open(
    () => {
      keepCount += 1;
    },
    () => {
      backCount += 1;
    },
  );
  return {
    overlay,
    doc,
    keeps: () => keepCount,
    backs: () => backCount,
  };
}

function panelOf(overlay: LeaveConfirm): FakeElement {
  const panel = findByClass(fake(overlay.element), "lanpad-leave__panel");
  if (panel === null) throw new Error("missing leave panel");
  return panel;
}

function actionsOf(overlay: LeaveConfirm): FakeElement[] {
  return findAllByClass(fake(overlay.element), "lanpad-leave__action");
}

// ---------------------------------------------------------------------------
// Copy, default focus and dismissal (HP-04b; AR-4)
// ---------------------------------------------------------------------------

describe("leave confirm content and focus", () => {
  test("[AR-4] HP-04b opens with the fixed copy and focuses Keep playing", () => {
    const { overlay } = setup();
    const panel = panelOf(overlay);

    expect(overlay.isOpen).toBe(true);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-labelledby")).not.toBeNull();

    expect(findByClass(panel, "lanpad-leave__title")?.textContent).toBe(
      LEAVE_TITLE,
    );
    expect(findByClass(panel, "lanpad-leave__body")?.textContent).toBe(
      LEAVE_BODY,
    );

    const actions = actionsOf(overlay);
    expect(actions.map((action) => action.textContent)).toEqual([
      LEAVE_KEEP_LABEL,
      LEAVE_BACK_LABEL,
    ]);
    expect(actions[0]?.className).toContain("lanpad-leave__action--primary");
    expect(actions[1]?.className).toContain("lanpad-leave__action--secondary");
    expect((actions[0] as FakeElement).focused).toBe(true);

    overlay.destroy();
  });

  test("[AR-4] HP-04b Escape closes as Keep playing", () => {
    const { overlay, keeps, backs } = setup();

    const escape = keyEvent("Escape", 27);
    fake(overlay.element).dispatch(
      "keydown",
      escape as unknown as KeyboardEvent,
    );

    expect(escape.prevented).toBe(1);
    expect(keeps()).toBe(1);
    expect(backs()).toBe(0);
    expect(overlay.isOpen).toBe(false);

    overlay.destroy();
  });

  test("[AR-4] HP-04b Tab keeps focus inside the two actions", () => {
    const { overlay } = setup();
    const actions = actionsOf(overlay);

    expect((actions[0] as FakeElement).focused).toBe(true);

    const firstTab = keyEvent("Tab", 9);
    fake(overlay.element).dispatch(
      "keydown",
      firstTab as unknown as KeyboardEvent,
    );
    expect(firstTab.prevented).toBe(1);
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

  test("[AR-4] HP-04b Back to games calls its callback once", () => {
    const { overlay, keeps, backs } = setup();
    const back = actionsOf(overlay)[1] as FakeElement;

    back.dispatch("click");
    back.dispatch("click");

    expect(backs()).toBe(1);
    expect(keeps()).toBe(0);
    expect(overlay.isOpen).toBe(false);

    overlay.destroy();
  });
});

// ---------------------------------------------------------------------------
// Motion and lifecycle (HP-04b)
// ---------------------------------------------------------------------------

describe("leave confirm motion", () => {
  test("[AR-4] HP-04b enters with the 220ms scale and finishes at scale 1", async () => {
    const { overlay } = setup();
    const panel = panelOf(overlay);

    expect(panel.style.transform).toBe("scale(0.96)");
    await flush();
    expect(panel.style.transform).toBe("scale(1)");
    expect(panel.style.opacity).toBe("1");
    expect(panel.style.transition).toContain("220ms");

    overlay.destroy();
  });

  test("[AR-4] HP-04b reduced motion removes the scale and keeps opacity", async () => {
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

  test("[AR-4] HP-04b destroy removes the overlay and stops callbacks", () => {
    const { overlay, keeps } = setup();
    const keep = actionsOf(overlay)[0] as FakeElement;

    overlay.destroy();
    expect(fake(overlay.element).parent).toBeNull();
    expect(overlay.isOpen).toBe(false);

    keep.dispatch("click");
    expect(keeps()).toBe(0);
  });
});

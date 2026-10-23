/**
 * Dependency-free fake DOM for the runtime Node test project.
 *
 * The runtime tests run in Node (no jsdom, that is controller-only), so the
 * console tests need a small DOM. This fake implements exactly what the
 * launcher uses: element creation, classes, dataset, attributes, inline style
 * properties, children, focus, bubbling events and listener bookkeeping. The
 * listener counters back the 20-cycle leak test (ER-25-07).
 *
 * It is deliberately not a general DOM: no HTML parsing, no layout, no text
 * nodes. `textContent` is a plain string on leaf elements.
 */

export type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  readonly type: string;
  target: FakeElement | null;
  currentTarget: FakeElement | null;
  defaultPrevented: boolean;
  preventDefault(): void;
  readonly [key: string]: unknown;
}

export interface EventInit {
  readonly target?: FakeElement | null;
  readonly [key: string]: unknown;
}

export function makeEvent(type: string, init: EventInit = {}): FakeEvent {
  let prevented = false;
  const event = {
    type,
    target: init.target ?? null,
    currentTarget: null,
    preventDefault(): void {
      prevented = true;
    },
    ...init,
  } as unknown as FakeEvent;
  Object.defineProperty(event, "defaultPrevented", {
    get: () => prevented,
    enumerable: true,
  });
  return event;
}

export interface KeyInit extends EventInit {
  readonly keyCode?: number;
  readonly repeat?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

export function keyEvent(key: string, init: KeyInit = {}): FakeEvent {
  return makeEvent("keydown", {
    key,
    keyCode: 0,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  });
}

export class FakeStyle {
  private readonly values = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.values.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? "";
  }
}

export class FakeElement {
  readonly tagName: string;
  className = "";
  textContent = "";
  hidden = false;
  id = "";
  tabIndex = -1;
  focused = false;
  isContentEditable = false;
  parent: FakeElement | null = null;
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  rect = { left: 0, top: 0, width: 0, height: 0 };

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

  listenerCount(type?: string): number {
    if (type !== undefined) return this.listeners.get(type)?.length ?? 0;
    let total = 0;
    for (const list of this.listeners.values()) total += list.length;
    return total;
  }

  /** Bubbles towards the root; `focus`/`blur` stay on the target. */
  dispatch(type: string, init: EventInit = {}): FakeEvent {
    const event = makeEvent(type, { target: this, ...init });
    this.dispatchEvent(event);
    return event;
  }

  dispatchEvent(event: FakeEvent): void {
    const bubbling = event.type !== "focus" && event.type !== "blur";
    const path: FakeElement[] = [this];
    if (bubbling) {
      let node = this.parent;
      while (node !== null) {
        path.push(node);
        node = node.parent;
      }
    }
    for (const node of path) {
      event.currentTarget = node;
      for (const listener of [...(node.listeners.get(event.type) ?? [])]) {
        listener(event);
      }
    }
    event.currentTarget = null;
  }

  focus(): void {
    this.root().clearFocus();
    this.focused = true;
    this.dispatch("focus");
  }

  /** Topmost ancestor; the subtree that owns the single focused element. */
  private root(): FakeElement {
    let node = this.parent;
    if (node === null) return this;
    while (node.parent !== null) node = node.parent;
    return node;
  }

  click(): void {
    this.dispatch("click");
  }

  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    return this.rect;
  }

  private clearFocus(): void {
    this.focused = false;
    for (const child of this.children) child.clearFocus();
  }
}

export class FakeWindow {
  location = { search: "", pathname: "/" };
  matchMediaMatches = false;
  gpuReads = 0;
  private gpuValue: unknown = null;
  private readonly listeners = new Map<string, Listener[]>();

  /** Fake GPU handle: reading it at all is a launcher defect (ER-25-07). */
  get gpu(): unknown {
    this.gpuReads += 1;
    return this.gpuValue;
  }

  matchMedia(query: string): {
    matches: boolean;
    media: string;
    addEventListener(): void;
    removeEventListener(): void;
  } {
    return {
      matches: this.matchMediaMatches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
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

  listenerCount(type?: string): number {
    if (type !== undefined) return this.listeners.get(type)?.length ?? 0;
    let total = 0;
    for (const list of this.listeners.values()) total += list.length;
    return total;
  }

  dispatch(type: string, init: EventInit = {}): FakeEvent {
    const event = makeEvent(type, init);
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
    return event;
  }
}

export class FakeDocument {
  readonly body = new FakeElement("body");
  readonly defaultView = new FakeWindow();

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

export function asDocument(doc: FakeDocument): Document {
  return doc as unknown as Document;
}

export function asElement(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

export function findAllByClass(
  root: FakeElement,
  className: string,
): FakeElement[] {
  const found: FakeElement[] = [];
  const visit = (node: FakeElement): void => {
    if (node.className.split(/\s+/).includes(className)) found.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

export function findByClass(
  root: FakeElement,
  className: string,
): FakeElement | null {
  return findAllByClass(root, className)[0] ?? null;
}

export function findAllByTag(
  root: FakeElement,
  tagName: string,
): FakeElement[] {
  const found: FakeElement[] = [];
  const visit = (node: FakeElement): void => {
    if (node.tagName.toLowerCase() === tagName.toLowerCase()) found.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

export function textOf(root: FakeElement, className: string): string {
  return findByClass(root, className)?.textContent ?? "";
}

export function totalListeners(root: FakeElement): number {
  let total = root.listenerCount();
  for (const child of root.children) total += totalListeners(child);
  return total;
}

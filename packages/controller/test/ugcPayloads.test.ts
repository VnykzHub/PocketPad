/**
 * Stream E: text, choice and canvas payloads end to end through
 * `ControllerClient` (layout -> renderer -> EventQueue -> socket), including the
 * on-screen keyboard resizing the visible viewport, plus the reconnect path
 * that keeps the slot, replays the layout idempotently and keeps the private
 * panel mounted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDocument, PanelContent } from "@lanpad/sdk";
import {
  ControllerClient,
  type ControllerSocket,
} from "../src/net/controllerClient.js";
import {
  ViewportTracker,
  type ViewportWindow,
  type VisualViewportLike,
} from "../src/layout/viewport.js";

const SURFACE_SIZE = { width: 800, height: 400 } as const;

class FakeSocket implements ControllerSocket {
  readonly sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    // Handlers are detached by the client before closing.
  }

  open(): void {
    this.onopen?.();
  }

  serverClose(code = 1006, reason = "lost"): void {
    this.onclose?.({ code, reason });
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  texts(): string[] {
    return this.sent.filter((entry): entry is string => typeof entry === "string");
  }

  messages(): Record<string, unknown>[] {
    return this.texts().map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  events(): Record<string, unknown>[] {
    return this.messages().filter((message) => message["t"] === "event");
  }
}

const UGC_LAYOUT: LayoutDocument = {
  id: "ugc-v1",
  orientation: "portrait",
  controls: [
    {
      type: "text",
      id: "answer",
      x: "50%",
      y: "20%",
      w: "80%",
      h: "8%",
      event: "guess.submit",
      maxLen: 12,
    },
    {
      type: "choice",
      id: "pick",
      x: "50%",
      y: "50%",
      w: "80%",
      h: "30%",
      event: "guess.pick",
      options: [
        { value: "a", label: "It is a cat" },
        { value: "b", label: "It is a house" },
      ],
    },
    {
      type: "canvas",
      id: "draw",
      x: "50%",
      y: "80%",
      w: "80%",
      h: "30%",
      event: "guess.draw",
      maxStrokePoints: 64,
    },
  ],
};

const PANEL_LAYOUT: LayoutDocument = {
  id: "panel-v1",
  orientation: "portrait",
  controls: [
    {
      type: "button",
      id: "ready",
      label: "Ready",
      shape: "circle",
      x: "50%",
      y: "80%",
      r: "12%",
      bit: 0,
    },
    {
      type: "panel",
      id: "status",
      x: "50%",
      y: "20%",
      w: "80%",
      h: "20%",
    },
  ],
};

const PANEL_CONTENT: PanelContent = {
  kind: "text",
  title: "Round 1",
  text: "Pick a move",
};

class FakeWindow implements ViewportWindow {
  readonly innerWidth = 390;
  readonly innerHeight = 844;
  private readonly viewportState = { visibleHeight: 844 };
  readonly visualViewport: VisualViewportLike;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor() {
    const state = this.viewportState;
    this.visualViewport = {
      width: this.innerWidth,
      get height() {
        return state.visibleHeight;
      },
      offsetTop: 0,
      addEventListener: (type, listener) => {
        this.add(type, listener);
      },
      removeEventListener: (type, listener) => {
        this.remove(type, listener);
      },
    };
  }

  get visibleHeight(): number {
    return this.viewportState.visibleHeight;
  }

  set visibleHeight(value: number) {
    this.viewportState.visibleHeight = value;
  }

  addEventListener(type: "resize" | "orientationchange", listener: () => void): void {
    this.add(type, listener);
  }

  removeEventListener(type: "resize" | "orientationchange", listener: () => void): void {
    this.remove(type, listener);
  }

  private add(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  private remove(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
}

let nowMs = 0;
let socket: FakeSocket;
let client: ControllerClient;
let surface: HTMLDivElement;
let viewportWindow: FakeWindow;
let viewport: ViewportTracker;

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 1_000;
  socket = new FakeSocket();
  surface = document.createElement("div");
  document.body.append(surface);
  viewportWindow = new FakeWindow();
  viewport = new ViewportTracker(viewportWindow);
  client = new ControllerClient({
    origin: "http://localhost:8080",
    createSocket: () => socket,
    now: () => nowMs,
    surface,
    surfaceSize: SURFACE_SIZE,
    viewport,
  });
});

afterEach(() => {
  client.disconnect();
  viewport.dispose();
  surface.remove();
  vi.useRealTimers();
});

function join(slot = 1, layout?: LayoutDocument): void {
  client.connect("ABCD", "1234");
  socket.open();
  const joined: Record<string, unknown> = {
    t: "joined",
    slot,
    session: "session-1",
    serverTime: 5_000,
  };
  if (layout !== undefined) {
    joined["layout"] = layout;
  }
  socket.deliver(joined);
}

interface TouchPoint {
  identifier: number;
  clientX: number;
  clientY: number;
}

function dispatchTouch(
  target: HTMLElement,
  type: string,
  points: TouchPoint[],
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "changedTouches", { value: points });
  Object.defineProperty(event, "touches", { value: points });
  target.dispatchEvent(event);
}

function touch(identifier: number, clientX: number, clientY: number): TouchPoint {
  return { identifier, clientX, clientY };
}

describe("[FR-8.9][FR-7.8][SR-13] UGC payloads end to end", () => {
  it("[FR-8.9] text submits once on Enter, never per keystroke, and truncates", () => {
    join(1, UGC_LAYOUT);
    const input = surface.querySelector<HTMLInputElement>(
      '[data-control-id="answer"] input',
    );
    expect(input).not.toBeNull();

    input!.value = "  hello  ";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(socket.events()).toHaveLength(0);

    input!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    const events = socket.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      t: "event",
      slot: 1,
      name: "guess.submit",
      data: { value: "hello" },
    });
    expect(input!.value).toBe("");

    input!.value = "123456789012345";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    input!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(socket.events().at(-1)?.["data"]).toEqual({ value: "123456789012" });
  });

  it("[FR-8.1] a choice tap emits exactly one value for the touched row", () => {
    join(1, UGC_LAYOUT);

    // Choice box: y 50% of 400 = 200 center, 30% height = 120 -> top 140.
    // The first 44 px row spans 140..184.
    dispatchTouch(surface, "touchstart", [touch(1, 400, 160)]);
    dispatchTouch(surface, "touchend", [touch(1, 400, 160)]);

    const events = socket.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "guess.pick",
      data: { value: "a" },
    });
  });

  it("[FR-7.8][E10] a canvas stroke emits the frozen batch shape", () => {
    join(1, UGC_LAYOUT);

    // Canvas box: y 80% of 400 = 320 center, 30% height = 120 -> top 260.
    dispatchTouch(surface, "touchstart", [touch(1, 400, 300)]);
    dispatchTouch(surface, "touchmove", [touch(1, 430, 320)]);
    dispatchTouch(surface, "touchend", [touch(1, 430, 320)]);

    const events = socket.events().filter((event) => event["name"] === "guess.draw");
    expect(events.length).toBeGreaterThanOrEqual(2);
    const first = events[0]?.["data"] as Record<string, unknown>;
    const last = events.at(-1)?.["data"] as Record<string, unknown>;
    expect(first["phase"]).toBe("start");
    expect(last["phase"]).toBe("end");
    expect(first["color"]).toBe("#ffffff");
    expect(first["width"]).toBe(6);
    expect(Array.isArray(first["points"])).toBe(true);
    expect(Array.isArray(last["points"])).toBe(true);
    expect(last["count"] as number).toBeGreaterThanOrEqual(1);
  });

  it("[FR-8.9][E16] keeps the focused field visible when the keyboard shrinks the viewport", () => {
    join(1, UGC_LAYOUT);
    const input = surface.querySelector<HTMLInputElement>(
      '[data-control-id="answer"] input',
    );
    expect(input).not.toBeNull();

    input!.focus();
    const scrollIntoView = vi.fn();
    input!.scrollIntoView = scrollIntoView as unknown as HTMLInputElement["scrollIntoView"];
    input!.getBoundingClientRect = () =>
      ({ top: 700, bottom: 740, left: 0, right: 0, width: 0, height: 40 }) as DOMRect;
    expect(viewport.metrics().keyboardOpen).toBe(false);

    // A 444 px visual-viewport loss is above the 150 px keyboard threshold.
    viewportWindow.visibleHeight = 400;
    const metrics = viewport.update();

    expect(metrics.keyboardOpen).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
  });
});

describe("[FR-5.4][FR-8.2] reconnect keeps the slot, layout and panel", () => {
  it("[FR-5.4][FR-8.2] a session rejoin replays the same layout without duplicating controls", () => {
    join(1, PANEL_LAYOUT);
    socket.deliver({ t: "panel", slot: 1, content: PANEL_CONTENT });

    const panel = surface.querySelector('[data-control-id="status"]');
    expect(panel?.textContent).toContain("Round 1");
    expect(surface.querySelectorAll(".control")).toHaveLength(2);
    const acksBefore = socket.messages().filter((message) => message["t"] === "layoutAck");

    socket.serverClose();
    expect(client.currentState.status).toBe("reconnecting");
    expect(client.currentState.slot).toBe(1);
    expect(client.layout?.id).toBe("panel-v1");

    // First backoff attempt opens a new socket and joins by the stored session.
    vi.advanceTimersByTime(300);
    nowMs += 300;
    socket.open();
    const sessionJoin = socket
      .messages()
      .filter((message) => message["t"] === "join")
      .at(-1);
    expect(sessionJoin).toMatchObject({ t: "join", session: "session-1" });

    socket.deliver({
      t: "joined",
      slot: 1,
      session: "session-1",
      serverTime: 5_300,
      layout: PANEL_LAYOUT,
    });

    expect(client.currentState.slot).toBe(1);
    expect(client.layout?.id).toBe("panel-v1");
    expect(surface.querySelectorAll(".control")).toHaveLength(2);
    expect(panel?.textContent).toContain("Round 1");

    // The same layout was acked again so a host that missed it can settle.
    const acksAfter = socket.messages().filter((message) => message["t"] === "layoutAck");
    expect(acksAfter.length).toBe(acksBefore.length + 1);

    // A host panel replay after the rejoin updates the same mounted panel.
    socket.deliver({ t: "panel", slot: 1, content: { ...PANEL_CONTENT, title: "Round 2" } });
    expect(panel?.textContent).toContain("Round 2");
    expect(surface.querySelectorAll(".control")).toHaveLength(2);
  });
});

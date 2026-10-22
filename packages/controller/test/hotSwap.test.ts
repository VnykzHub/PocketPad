/**
 * D5-CTRL-02 integration: layout hot-swap without a reload.
 *
 * These tests drive `ControllerClient` over a fake socket and a real jsdom
 * surface. They prove the swap is per slot/all, repeatable, atomic, acked only
 * on success, and that it preserves the connection, the stored session, the
 * send loop and private panel content by control id (FR-8.2).
 *
 * D5-CTRL-01/05 wiring is covered at the client boundary too: a choice tap and
 * a text submit leave through the shared `EventQueue` with the joined slot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDocument } from "@lanpad/sdk";
import {
  ControllerClient,
  createMemoryStorage,
  type ControllerSocket,
} from "../src/net/controllerClient.js";
import { createSessionStore, type SessionStore } from "../src/join/sessionStore.js";

const SURFACE_SIZE = { width: 800, height: 400 } as const;
const SESSION = "sessionHOTSWAP000000";

class FakeSocket implements ControllerSocket {
  readonly sent: (string | Uint8Array)[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  serverClose(): void {
    this.onclose?.({ code: 1006, reason: "" });
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  texts(): Record<string, unknown>[] {
    return this.sent
      .filter((entry): entry is string => typeof entry === "string")
      .map((text) => JSON.parse(text) as Record<string, unknown>);
  }

  inputs(): Uint8Array[] {
    return this.sent.filter(
      (entry): entry is Uint8Array => entry instanceof Uint8Array,
    );
  }
}

const BUTTON_LAYOUT_A: LayoutDocument = {
  id: "layout-a",
  orientation: "landscape",
  controls: [
    {
      type: "button",
      id: "jump",
      label: "Jump",
      shape: "circle",
      x: "82%",
      y: "70%",
      r: "11%",
      bit: 0,
    },
  ],
};

const BUTTON_LAYOUT_B: LayoutDocument = {
  id: "layout-b",
  orientation: "landscape",
  controls: [
    {
      type: "button",
      id: "left",
      label: "Left",
      shape: "circle",
      x: "25%",
      y: "50%",
      r: "10%",
      bit: 0,
    },
    {
      type: "button",
      id: "right",
      label: "Right",
      shape: "circle",
      x: "75%",
      y: "50%",
      r: "10%",
      bit: 1,
    },
  ],
};

const PANEL_LAYOUT_A: LayoutDocument = {
  id: "panel-a",
  orientation: "landscape",
  controls: [
    {
      type: "button",
      id: "fire",
      label: "Fire",
      shape: "rounded",
      x: "50%",
      y: "80%",
      r: "12%",
      bit: 4,
    },
    { type: "panel", id: "score", x: "50%", y: "12%", w: "40%", h: "16%" },
  ],
};

const PANEL_LAYOUT_B: LayoutDocument = {
  id: "panel-b",
  orientation: "landscape",
  controls: [
    {
      type: "button",
      id: "heal",
      label: "Heal",
      shape: "rounded",
      x: "50%",
      y: "80%",
      r: "12%",
      bit: 5,
    },
    { type: "panel", id: "score", x: "50%", y: "12%", w: "40%", h: "16%" },
  ],
};

/** Box x=64..256, y=112..208; two 44 px option rows. */
const CHOICE_LAYOUT: LayoutDocument = {
  id: "choice-a",
  orientation: "landscape",
  controls: [
    {
      type: "choice",
      id: "pick",
      x: "20%",
      y: "40%",
      w: "24%",
      h: "24%",
      event: "pick",
      options: [
        { value: "a", label: "Alpha" },
        { value: "b", label: "Bravo" },
      ],
    },
  ],
};

const TEXT_LAYOUT: LayoutDocument = {
  id: "text-a",
  orientation: "landscape",
  controls: [
    {
      type: "text",
      id: "answer",
      x: "50%",
      y: "90%",
      w: "40%",
      h: "8%",
      event: "answer",
      maxLen: 40,
    },
  ],
};

let nowMs: number;
let sockets: FakeSocket[];
let store: SessionStore;
let surface: HTMLDivElement;
let client: ControllerClient;

function makeClient(): ControllerClient {
  return new ControllerClient({
    origin: "http://localhost:8080",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    now: () => nowMs,
    sessionStore: store,
    surface,
    surfaceSize: SURFACE_SIZE,
  });
}

function latest(): FakeSocket {
  const socket = sockets.at(-1);
  if (socket === undefined) {
    throw new Error("no socket was created");
  }
  return socket;
}

function join(slot: number, layout?: LayoutDocument): FakeSocket {
  client.connect("ABCD", "1234");
  const socket = latest();
  socket.open();
  const joined: Record<string, unknown> = {
    t: "joined",
    slot,
    session: SESSION,
    serverTime: 5_000,
  };
  if (layout !== undefined) {
    joined["layout"] = layout;
  }
  socket.deliver(joined);
  return socket;
}

function advance(ms: number): void {
  nowMs += ms;
  vi.advanceTimersByTime(ms);
}

interface TouchPoint {
  identifier: number;
  clientX: number;
  clientY: number;
}

function touch(identifier: number, clientX: number, clientY: number): TouchPoint {
  return { identifier, clientX, clientY };
}

/** jsdom has no TouchEvent; the engine only reads `changedTouches`. */
function dispatchTouch(
  target: HTMLElement,
  type: string,
  points: TouchPoint[],
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "changedTouches", { value: points });
  Object.defineProperty(event, "touches", { value: points });
  target.dispatchEvent(event);
  return event;
}

function messages(socket: FakeSocket, type: string): Record<string, unknown>[] {
  return socket.texts().filter((message) => message["t"] === type);
}

beforeEach(() => {
  vi.useFakeTimers();
  nowMs = 1_000;
  sockets = [];
  store = createSessionStore({
    sessionStorage: createMemoryStorage(),
    now: () => nowMs,
  });
  surface = document.createElement("div");
  document.body.append(surface);
  client = makeClient();
});

afterEach(() => {
  client.disconnect();
  surface.remove();
  vi.useRealTimers();
});

describe("[FR-8.2] hot-swap mounts a new layout in place", () => {
  it("[FR-8.2] a per-slot setLayout swaps the DOM once and acks the new id", () => {
    const socket = join(1, BUTTON_LAYOUT_A);
    const oldJump = surface.querySelector<HTMLElement>('[data-control-id="jump"]');
    expect(oldJump).not.toBeNull();

    let mountCalls = 0;
    const replaceChildren = surface.replaceChildren.bind(surface);
    surface.replaceChildren = (...nodes: (Node | string)[]) => {
      mountCalls += 1;
      replaceChildren(...nodes);
    };

    socket.deliver({ t: "setLayout", slot: 1, layout: BUTTON_LAYOUT_B });

    expect(client.layout?.id).toBe("layout-b");
    expect(mountCalls).toBe(1);
    expect(surface.querySelectorAll(".control")).toHaveLength(2);
    expect(surface.querySelector('[data-control-id="jump"]')).toBeNull();
    expect(oldJump?.isConnected).toBe(false);
    expect(surface.querySelector('[data-control-id="left"]')).not.toBeNull();
    expect(surface.querySelector('[data-control-id="right"]')).not.toBeNull();
    expect(messages(socket, "layoutAck").at(-1)).toEqual({
      t: "layoutAck",
      layoutId: "layout-b",
    });
  });

  it("[FR-8.2] repeated swaps keep one socket, the session and the send loop", () => {
    const socket = join(1, BUTTON_LAYOUT_A);

    for (const [expected, layout] of [
      ["layout-b", BUTTON_LAYOUT_B],
      ["layout-a", BUTTON_LAYOUT_A],
      ["layout-b", BUTTON_LAYOUT_B],
      ["layout-a", BUTTON_LAYOUT_A],
    ] as const) {
      socket.deliver({ t: "setLayout", slot: "all", layout });
      expect(client.layout?.id).toBe(expected);
      expect(client.currentState.status).toBe("connected");
      expect(client.currentState.slot).toBe(1);
      expect(client.isJoined).toBe(true);
      expect(sockets).toHaveLength(1);
    }

    expect(store.get("ABCD")?.session).toBe(SESSION);
    expect(messages(socket, "layoutAck").map((ack) => ack["layoutId"])).toEqual([
      "layout-a",
      "layout-b",
      "layout-a",
      "layout-b",
      "layout-a",
    ]);

    // The idle send policy is still running after four swaps.
    const before = socket.inputs().length;
    advance(250);
    expect(socket.inputs().length).toBeGreaterThan(before);
  });
});

describe("[FR-7.12] held touches are released on swap", () => {
  it("[FR-7.12] a button held across a swap is released and the new layout is live", () => {
    const socket = join(1, BUTTON_LAYOUT_A);

    // 800x400: r 11% of 400 = 44 -> 88 px circle at (656, 280).
    dispatchTouch(surface, "touchstart", [touch(1, 656, 280)]);
    expect(client.input.snapshot(0).buttons).toBe(1 << 0);
    expect(client.stats.activeTouches).toBe(1);
    const oldJump = surface.querySelector<HTMLElement>('[data-control-id="jump"]');

    socket.deliver({ t: "setLayout", slot: 1, layout: BUTTON_LAYOUT_B });

    expect(client.input.snapshot(0).buttons).toBe(0);
    expect(client.stats.activeTouches).toBe(0);
    expect(oldJump?.isConnected).toBe(false);
    // A stale touchend for the removed binding must not throw or re-press.
    expect(() => dispatchTouch(surface, "touchend", [touch(1, 656, 280)])).not.toThrow();
    expect(client.input.snapshot(0).buttons).toBe(0);

    // The new layout is interactive in the same tick as the swap.
    dispatchTouch(surface, "touchstart", [touch(2, 200, 200)]);
    expect(client.input.snapshot(0).buttons).toBe(1 << 0);
    dispatchTouch(surface, "touchend", [touch(2, 200, 200)]);
    expect(client.input.snapshot(0).buttons).toBe(0);
  });
});

describe("[FR-8.4] invalid layouts never replace a good one", () => {
  it("[FR-8.4] a rejected swap keeps the layout, reports the error and does not ack", () => {
    const socket = join(1, BUTTON_LAYOUT_A);
    const ackCount = messages(socket, "layoutAck").length;
    const controlCount = surface.querySelectorAll(".control").length;

    socket.deliver({
      t: "setLayout",
      slot: 1,
      layout: {
        id: "broken-v1",
        orientation: "landscape",
        controls: [
          {
            type: "button",
            id: "bad",
            label: "Bad",
            shape: "circle",
            x: "10%",
            y: "10%",
            r: "10%",
            bit: 99,
          },
        ],
      },
    });

    expect(client.layout?.id).toBe("layout-a");
    expect(client.layoutError).toContain("bit");
    expect(surface.querySelectorAll(".control")).toHaveLength(controlCount);
    expect(surface.querySelector('[data-control-id="jump"]')).not.toBeNull();
    expect(messages(socket, "layoutAck")).toHaveLength(ackCount);

    // A later valid swap still works after the rejection.
    socket.deliver({ t: "setLayout", slot: 1, layout: BUTTON_LAYOUT_B });
    expect(client.layout?.id).toBe("layout-b");
    expect(client.layoutError).toBeNull();
  });

  it("[FR-8.2] a same-id layout is idempotent and does not rebuild the DOM", () => {
    const socket = join(1, BUTTON_LAYOUT_A);
    const jump = surface.querySelector<HTMLElement>('[data-control-id="jump"]');

    socket.deliver({ t: "setLayout", slot: 1, layout: BUTTON_LAYOUT_A });

    expect(surface.querySelector<HTMLElement>('[data-control-id="jump"]')).toBe(jump);
    expect(client.layout?.id).toBe("layout-a");
    // The replay is acked so a host that missed the original ack settles.
    expect(messages(socket, "layoutAck").at(-1)).toEqual({
      t: "layoutAck",
      layoutId: "layout-a",
    });
  });
});

describe("[FR-8.1] private panel state survives a swap by control id", () => {
  it("[FR-8.1] panel content is private, survives the swap and can be cleared", () => {
    const socket = join(1, PANEL_LAYOUT_A);

    socket.deliver({
      t: "panel",
      slot: 1,
      content: { kind: "text", title: "Secret", text: "Only P1" },
    });
    expect(
      surface.querySelector('[data-control-id="score"] [data-part="panel-text"]')
        ?.textContent,
    ).toBe("Only P1");

    // Another slot's panel is ignored by the controller as well as the broker.
    socket.deliver({
      t: "panel",
      slot: 2,
      content: { kind: "text", text: "Wrong slot" },
    });
    expect(
      surface.querySelector('[data-control-id="score"] [data-part="panel-text"]')
        ?.textContent,
    ).toBe("Only P1");

    socket.deliver({ t: "setLayout", slot: 1, layout: PANEL_LAYOUT_B });
    expect(client.layout?.id).toBe("panel-b");
    expect(
      surface.querySelector('[data-control-id="score"] [data-part="panel-text"]')
        ?.textContent,
    ).toBe("Only P1");
    expect(surface.querySelector('[data-control-id="heal"]')).not.toBeNull();

    socket.deliver({ t: "panel", slot: 1, content: null });
    expect(
      surface.querySelector('[data-control-id="score"] [data-part="placeholder"]')
        ?.textContent,
    ).toBe("Private panel");
  });

  it("[FR-8.1] a panel message that arrives before the layout is applied on mount", () => {
    const socket = join(1);
    expect(client.layout).toBeNull();

    socket.deliver({
      t: "panel",
      slot: 1,
      content: { kind: "text", text: "Early" },
    });
    socket.deliver({ t: "setLayout", slot: 1, layout: PANEL_LAYOUT_A });

    expect(
      surface.querySelector('[data-control-id="score"] [data-part="panel-text"]')
        ?.textContent,
    ).toBe("Early");
  });
});

describe("[D5-CTRL-01/05] control events leave through the shared queue", () => {
  it("[FR-7.8] a choice tap sends one event frame stamped with the joined slot", () => {
    const socket = join(3, CHOICE_LAYOUT);

    dispatchTouch(surface, "touchstart", [touch(1, 100, 130)]);
    dispatchTouch(surface, "touchend", [touch(1, 100, 130)]);

    expect(messages(socket, "event")).toEqual([
      { t: "event", slot: 3, name: "pick", data: { value: "a" } },
    ]);
  });

  it("[FR-7.8] a text submit sends one event, never per keystroke", () => {
    const socket = join(2, TEXT_LAYOUT);
    const input = surface.querySelector<HTMLInputElement>(
      '[data-control-id="answer"] input',
    );
    if (input === null) {
      throw new Error("text control is missing its input");
    }

    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(messages(socket, "event")).toHaveLength(0);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(messages(socket, "event")).toEqual([
      { t: "event", slot: 2, name: "answer", data: { value: "hello" } },
    ]);
    expect(input.value).toBe("");
  });
});

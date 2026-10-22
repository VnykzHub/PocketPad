/**
 * Controller page state flow (W3; PAGE-PLANS CP-01…CP-06, CP-19).
 *
 * These tests drive the real `ControllerShell` (the page module `main.ts`)
 * against a jsdom fixture that mirrors `index.html` and a fake client. They
 * pin the visible states the shell owes the player:
 *
 *   CP-01/02/03  auto-advance without auto-submit, Joining…, lockout countdown
 *   CP-04        waiting page without the D0 Test button (debug-only)
 *   CP-05        playing surface replaces the waiting page in place
 *   CP-06        reconnecting banner over live controls; paused host pill-only
 *   CP-19        landscape layout on a portrait phone, resolved on rotation
 *
 * The fake client has the `ControllerShellClient` surface; no socket, timer or
 * storage is involved, and importing `main.ts` does not bootstrap because the
 * jsdom document has no `#app` at module evaluation time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutDocument } from "@lanpad/sdk";
import { ConnectionPill } from "../src/ui/ConnectionPill.js";
import {
  ControllerShell,
  INVALID_CODE_TEXT,
  INVALID_PIN_TEXT,
  formatRoomLine,
  joinButtonLabel,
  resolveShellScreen,
  WAITING_CONNECTED_TEXT,
  type ControllerShellElements,
  type ControllerShellClient,
  type ShellScreen,
} from "../src/main.js";
import type { ControllerState } from "../src/net/controllerClient.js";
import type { JoinFlowState } from "../src/join/joinFlow.js";

const DISCONNECTED: ControllerState = {
  status: "disconnected",
  slot: null,
  error: null,
  host: null,
};

const CONNECTED: ControllerState = {
  status: "connected",
  slot: 2,
  error: null,
  host: "active",
};

const LANDSCAPE_LAYOUT: LayoutDocument = {
  id: "coin-run-v1",
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

const PORTRAIT_LAYOUT: LayoutDocument = {
  ...LANDSCAPE_LAYOUT,
  id: "coin-run-portrait-v1",
  orientation: "portrait",
};

/** Minimal client: real listener ordering (immediate callback), no network. */
class FakeClient implements ControllerShellClient {
  state: ControllerState = DISCONNECTED;
  flow: JoinFlowState = { status: "idle" };
  retry = 0;
  layout: LayoutDocument | null = null;
  readonly connectCalls: Array<{ code: string; pin: string }> = [];
  pressCount = 0;
  releaseCount = 0;
  retryCount = 0;

  private readonly stateListeners = new Set<(state: ControllerState) => void>();
  private readonly layoutListeners = new Set<(layout: LayoutDocument | null) => void>();
  private readonly joinListeners = new Set<(state: JoinFlowState) => void>();

  get currentState(): ControllerState {
    return this.state;
  }

  get joinState(): JoinFlowState {
    return this.flow;
  }

  get retryAfterMs(): number {
    return this.retry;
  }

  onState(listener: (state: ControllerState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onLayout(listener: (layout: LayoutDocument | null) => void): () => void {
    this.layoutListeners.add(listener);
    listener(this.layout);
    return () => {
      this.layoutListeners.delete(listener);
    };
  }

  onJoinState(listener: (state: JoinFlowState) => void): () => void {
    this.joinListeners.add(listener);
    listener(this.flow);
    return () => {
      this.joinListeners.delete(listener);
    };
  }

  connect(code: string, pin: string): void {
    this.connectCalls.push({ code, pin });
  }

  retryJoin(): JoinFlowState {
    this.retryCount += 1;
    return this.flow;
  }

  press(): void {
    this.pressCount += 1;
  }

  release(): void {
    this.releaseCount += 1;
  }

  emitState(state: ControllerState): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) {
      listener(state);
    }
  }

  emitLayout(layout: LayoutDocument | null): void {
    this.layout = layout;
    for (const listener of [...this.layoutListeners]) {
      listener(layout);
    }
  }

  emitFlow(flow: JoinFlowState): void {
    this.flow = flow;
    for (const listener of [...this.joinListeners]) {
      listener(flow);
    }
  }
}

interface Fixture {
  shell: ControllerShell;
  client: FakeClient;
  connection: HTMLSpanElement;
  joinForm: HTMLFormElement;
  code: HTMLInputElement;
  pin: HTMLInputElement;
  joinError: HTMLParagraphElement;
  joinButton: HTMLButtonElement;
  controller: HTMLElement;
  slotLabel: HTMLElement;
  playSurface: HTMLElement;
  orientation: HTMLElement;
  app: HTMLElement;
}

const FIXTURE_HTML = `
  <div id="app">
    <header class="topbar">
      <span id="connection" class="pill" data-state="disconnected">Disconnected</span>
      <button id="haptics-toggle" type="button">Haptics on</button>
    </header>
    <main class="shell">
      <form id="join-form">
        <input id="code" />
        <input id="pin" />
        <p id="join-error" role="alert" hidden></p>
        <button id="join-button" type="submit">Join</button>
      </form>
      <section id="controller" hidden>
        <p id="slot-label">Player</p>
        <p class="waiting-state"></p>
        <button id="test-button" type="button">Test</button>
      </section>
    </main>
    <div id="play-surface" hidden></div>
    <div id="orientation" hidden></div>
  </div>
`;

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Fixture is missing #${id}`);
  }
  return element as T;
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function createFixture(debug = false): Fixture {
  document.body.innerHTML = FIXTURE_HTML;

  const connection = byId<HTMLSpanElement>("connection");
  const client = new FakeClient();
  const elements: ControllerShellElements = {
    app: byId<HTMLElement>("app"),
    pill: new ConnectionPill(connection),
    joinForm: byId<HTMLFormElement>("join-form"),
    codeInput: byId<HTMLInputElement>("code"),
    pinInput: byId<HTMLInputElement>("pin"),
    joinError: byId<HTMLParagraphElement>("join-error"),
    joinButton: byId<HTMLButtonElement>("join-button"),
    controllerPanel: byId<HTMLElement>("controller"),
    slotLabel: byId<HTMLElement>("slot-label"),
    testButton: document.getElementById("test-button") as HTMLButtonElement | null,
    playSurface: byId<HTMLElement>("play-surface"),
    orientation: byId<HTMLElement>("orientation"),
  };
  const shell = new ControllerShell({ client, elements, debug });

  return {
    shell,
    client,
    connection,
    joinForm: elements.joinForm,
    code: elements.codeInput,
    pin: elements.pinInput,
    joinError: elements.joinError,
    joinButton: elements.joinButton,
    controller: elements.controllerPanel,
    slotLabel: elements.slotLabel,
    playSurface: elements.playSurface,
    orientation: elements.orientation,
    app: elements.app,
  };
}

function submit(fixture: Fixture, code: string, pin: string): void {
  fixture.code.value = code;
  fixture.pin.value = pin;
  fixture.joinForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

let fixture: Fixture | null = null;

beforeEach(() => {
  vi.useRealTimers();
  setViewport(800, 400);
  document.body.className = "";
  document.body.innerHTML = "";
});

afterEach(() => {
  fixture?.shell.destroy();
  fixture = null;
  document.body.className = "";
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("[FR-5.6] join form states", () => {
  it("[FR-5.6] a complete code advances to the PIN and never auto-submits", () => {
    fixture = createFixture();

    typeInto(fixture.code, "b26a");
    expect(fixture.code.value).toBe("B26A");
    expect(document.activeElement).toBe(fixture.pin);

    typeInto(fixture.pin, "1596");
    expect(fixture.client.connectCalls).toHaveLength(0);
    expect(fixture.joinError.hidden).toBe(true);
  });

  it("[FR-5.6] an incomplete code stays in the code field", () => {
    fixture = createFixture();

    typeInto(fixture.code, "b26");
    expect(fixture.code.value).toBe("B26");
    expect(document.activeElement).toBe(fixture.code);
    expect(fixture.client.connectCalls).toHaveLength(0);
  });

  it("[FR-5.6] connecting disables the form, locks the fields and says Joining…", () => {
    fixture = createFixture();
    fixture.client.emitState({
      status: "connecting",
      slot: null,
      error: null,
      host: null,
    });

    expect(fixture.joinForm.hidden).toBe(false);
    expect(fixture.controller.hidden).toBe(true);
    expect(fixture.joinButton.disabled).toBe(true);
    expect(fixture.joinButton.textContent).toBe("Joining…");
    expect(fixture.code.readOnly).toBe(true);
    expect(fixture.pin.readOnly).toBe(true);
    expect(fixture.connection.textContent).toBe("Connecting");
  });

  it("[FR-5.6] a lockout counts down once per second and re-enables Join", () => {
    vi.useFakeTimers();
    fixture = createFixture();
    fixture.client.retry = 5000;
    fixture.client.emitState({
      status: "disconnected",
      slot: null,
      error: "Too many attempts. Wait a moment and try again.",
      host: null,
    });

    expect(fixture.joinButton.textContent).toBe("Try again in 5s");
    expect(fixture.joinButton.disabled).toBe(true);
    expect(fixture.code.readOnly).toBe(false);

    fixture.client.retry = 4000;
    vi.advanceTimersByTime(1000);
    expect(fixture.joinButton.textContent).toBe("Try again in 4s");

    fixture.client.retry = 0;
    vi.advanceTimersByTime(1000);
    expect(fixture.joinButton.textContent).toBe("Join");
    expect(fixture.joinButton.disabled).toBe(false);
  });

  it("[FR-5.6] a joinFlow error is rendered verbatim and focuses the PIN", () => {
    fixture = createFixture();
    const message = "Wrong PIN. Check the PIN on the TV and try again.";
    fixture.client.emitState({
      status: "disconnected",
      slot: null,
      error: message,
      host: null,
    });

    expect(fixture.joinError.hidden).toBe(false);
    expect(fixture.joinError.textContent).toBe(message);
    expect(document.activeElement).toBe(fixture.pin);
  });

  it("[FR-5.6] local validation keeps the CP-01 copy and sends nothing", () => {
    fixture = createFixture();

    submit(fixture, "abc", "1596");
    expect(fixture.joinError.textContent).toBe(INVALID_CODE_TEXT);
    expect(fixture.client.connectCalls).toHaveLength(0);

    submit(fixture, "B26A", "12");
    expect(fixture.joinError.textContent).toBe(INVALID_PIN_TEXT);
    expect(fixture.client.connectCalls).toHaveLength(0);
  });

  it("[FR-5.6] a valid manual join is normalized and sent once", () => {
    fixture = createFixture();

    submit(fixture, "b26a", "1596");

    expect(fixture.client.connectCalls).toEqual([{ code: "B26A", pin: "1596" }]);
    expect(fixture.code.value).toBe("B26A");
    expect(fixture.joinButton.disabled).toBe(true);
  });
});

describe("[FR-8.2] waiting and playing", () => {
  it("[FR-8.2] the waiting page drops Test, shows Player N and the room line", () => {
    fixture = createFixture(false);
    // A manual join gives this phone the PIN CP-04 shows; a QR/session join
    // would show the room code alone.
    submit(fixture, "B26A", "1596");
    fixture.client.emitFlow({ status: "joined", code: "B26A", slot: 2 });
    fixture.client.emitState(CONNECTED);

    expect(document.getElementById("test-button")).toBeNull();
    expect(fixture.joinForm.hidden).toBe(true);
    expect(fixture.controller.hidden).toBe(false);
    expect(fixture.playSurface.hidden).toBe(true);
    expect(fixture.slotLabel.textContent).toBe("Player 2");
    expect(fixture.connection.textContent).toBe("Connected (P2)");

    const waiting = fixture.controller.querySelector(".waiting-state");
    expect(waiting?.textContent).toBe(WAITING_CONNECTED_TEXT);

    const roomLine = document.getElementById("room-line");
    expect(roomLine?.textContent).toBe("Room B26A · PIN 1596");
    expect((roomLine as HTMLElement).hidden).toBe(false);
  });

  it("[FR-8.2] a layout arriving replaces the waiting page in place", () => {
    fixture = createFixture();
    fixture.client.emitState(CONNECTED);
    expect(fixture.controller.hidden).toBe(false);

    fixture.client.emitLayout(LANDSCAPE_LAYOUT);

    expect(fixture.controller.hidden).toBe(true);
    expect(fixture.joinForm.hidden).toBe(true);
    expect(fixture.playSurface.hidden).toBe(false);
    expect(document.body.classList.contains("playing")).toBe(true);
    expect(fixture.shell.screen).toBe("playing");

    // A second layout keeps the same shell and surface (hot-swap, no reload).
    fixture.client.emitLayout({ ...LANDSCAPE_LAYOUT, id: "coin-run-v2" });
    expect(fixture.playSurface.hidden).toBe(false);
    expect(fixture.shell.screen).toBe("playing");
  });

  it("[FR-8.2] ?debug=1 keeps Test, live on the waiting page only", () => {
    fixture = createFixture(true);
    const button = document.getElementById("test-button") as HTMLButtonElement | null;
    expect(button).not.toBeNull();

    fixture.client.emitState(CONNECTED);
    expect(button?.disabled).toBe(false);

    button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(fixture.client.pressCount).toBe(1);
    button?.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    expect(fixture.client.releaseCount).toBe(1);
  });
});

describe("[FR-8.3] orientation", () => {
  it("[FR-8.3] a landscape layout on a portrait phone shows CP-19 until rotation", () => {
    setViewport(400, 800);
    fixture = createFixture();
    fixture.client.emitState(CONNECTED);
    fixture.client.emitLayout(LANDSCAPE_LAYOUT);

    expect(fixture.orientation.hidden).toBe(false);
    expect(fixture.playSurface.hidden).toBe(true);
    expect(fixture.joinForm.hidden).toBe(true);
    expect(fixture.shell.screen).toBe("orientation");

    // Rotating resolves the same shell; no reload and no remount of the page.
    setViewport(800, 400);
    window.dispatchEvent(new Event("resize"));

    expect(fixture.orientation.hidden).toBe(true);
    expect(fixture.playSurface.hidden).toBe(false);
    expect(fixture.shell.screen).toBe("playing");
  });

  it("[FR-8.3] portrait and any layouts mount without the orientation screen", () => {
    setViewport(400, 800);
    fixture = createFixture();
    fixture.client.emitState(CONNECTED);

    fixture.client.emitLayout(PORTRAIT_LAYOUT);
    expect(fixture.orientation.hidden).toBe(true);
    expect(fixture.playSurface.hidden).toBe(false);

    fixture.client.emitLayout({ ...LANDSCAPE_LAYOUT, id: "any-layout", orientation: "any" });
    expect(fixture.orientation.hidden).toBe(true);
    expect(fixture.playSurface.hidden).toBe(false);
  });
});

describe("[FR-5.4] reconnect and host loss", () => {
  it("[FR-5.4] reconnecting keeps the controls visible and shows the banner", () => {
    fixture = createFixture();
    fixture.client.emitState(CONNECTED);
    fixture.client.emitLayout(LANDSCAPE_LAYOUT);

    const banner = document.getElementById("reconnect-banner") as HTMLElement | null;
    expect(banner).not.toBeNull();
    expect(banner?.hidden).toBe(true);

    fixture.client.emitState({
      status: "reconnecting",
      slot: 2,
      error: null,
      host: null,
    });

    expect(banner?.hidden).toBe(false);
    expect(banner?.textContent).toContain("Reconnecting…");
    expect(fixture.playSurface.hidden).toBe(false);
    expect(fixture.joinForm.hidden).toBe(true);
    expect(fixture.controller.hidden).toBe(true);
    expect(document.body.classList.contains("playing")).toBe(true);
    expect(fixture.connection.textContent).toBe("Reconnecting");
  });

  it("[A9] a paused host is pill-only, with no second message", () => {
    fixture = createFixture();
    fixture.client.emitState(CONNECTED);
    fixture.client.emitLayout(LANDSCAPE_LAYOUT);
    const banner = document.getElementById("reconnect-banner") as HTMLElement | null;

    fixture.client.emitState({ ...CONNECTED, host: "paused" });

    expect(banner?.hidden).toBe(true);
    expect(fixture.connection.textContent).toBe("TV paused");
    expect(fixture.playSurface.hidden).toBe(false);
  });

  it("[FR-5.4] a lost host returns to the form with Connection lost.", () => {
    fixture = createFixture();
    fixture.client.emitState(CONNECTED);
    fixture.client.emitLayout(LANDSCAPE_LAYOUT);

    fixture.client.emitLayout(null);
    fixture.client.emitState({
      status: "disconnected",
      slot: null,
      error: "Connection lost.",
      host: null,
    });

    expect(fixture.joinForm.hidden).toBe(false);
    expect(fixture.playSurface.hidden).toBe(true);
    expect(fixture.controller.hidden).toBe(true);
    expect(document.body.classList.contains("playing")).toBe(false);
    expect(fixture.joinError.textContent).toBe("Connection lost.");
    expect(fixture.connection.textContent).toBe("Disconnected");
  });
});

describe("[FR-5.6] CP-03/CP-04 copy and screen mapping", () => {
  it("[FR-5.6] join labels and room lines use the planned copy", () => {
    expect(joinButtonLabel(DISCONNECTED, 0)).toBe("Join");
    expect(joinButtonLabel(DISCONNECTED, 12_000)).toBe("Try again in 12s");
    expect(joinButtonLabel({ ...DISCONNECTED, status: "connecting" }, 0)).toBe("Joining…");
    expect(formatRoomLine("B26A", "1596")).toBe("Room B26A · PIN 1596");
    expect(formatRoomLine("B26A", null)).toBe("Room B26A");
    expect(formatRoomLine(null, "1596")).toBeNull();
  });

  it("[FR-8.3] the screen mapping is total over the visible states", () => {
    const screens: ShellScreen[] = [
      resolveShellScreen(DISCONNECTED, LANDSCAPE_LAYOUT, false),
      resolveShellScreen(CONNECTED, null, false),
      resolveShellScreen(CONNECTED, LANDSCAPE_LAYOUT, false),
      resolveShellScreen(CONNECTED, LANDSCAPE_LAYOUT, true),
      resolveShellScreen(CONNECTED, PORTRAIT_LAYOUT, true),
    ];
    expect(screens).toEqual(["join", "waiting", "playing", "orientation", "playing"]);
  });
});

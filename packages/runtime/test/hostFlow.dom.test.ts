// @vitest-environment jsdom
/**
 * W2 host shell integration (HP-02/HP-03/HP-07/HP-08).
 *
 * Boots the real `bootstrapHost()` against the real index.html structure with
 * two injected edges only: the `POST /api/rooms` response and the WebSocket.
 * Everything else — RoomPanel, Launcher, SlotRoster, the broker message switch
 * — is the production code path.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { getGames } from "../src/game/registry.js";

const ROOM_TOKEN = "r".repeat(22);
const HOST_TOKEN = "h".repeat(22);

const HOST_MARKUP = `
  <div id="app" class="host">
    <header class="top-bar">
      <span class="top-bar__wordmark">lanpad</span>
      <div id="connection" class="status-pill" role="status" aria-live="polite"
           data-state="pending">Starting…</div>
    </header>
    <div class="host-body">
      <section id="boot" class="boot" aria-labelledby="boot-title">
        <div class="boot__progress">
          <span class="boot__dot" aria-hidden="true"></span>
          <h1 id="boot-title" class="boot__title">Starting PocketPad</h1>
          <p class="boot__subtitle">Creating a room for this TV</p>
        </div>
      </section>
      <section class="room" aria-label="Room">
        <div id="room-code" class="visually-hidden" aria-hidden="true">----</div>
        <div id="room-pin" class="visually-hidden" aria-hidden="true">PIN ----</div>
        <div id="room-panel" class="room-panel" data-state="empty"></div>
        <p id="room-hint" class="room__hint" role="status" aria-live="polite">
          Creating a room…
        </p>
      </section>
      <main id="game-root" class="game-root"></main>
      <section class="roster" aria-label="Players">
        <h2 class="roster__title">Players</h2>
        <div id="slots" class="roster__mount"></div>
      </section>
    </div>
  </div>
`;

type OpenHandler = (event: unknown) => void;
type CloseHandler = (event: unknown) => void;
type ErrorHandler = (event: unknown) => void;
type MessageHandler = (event: { readonly data: unknown }) => void;

class FakeSocket {
  static readonly all: FakeSocket[] = [];

  binaryType = "arraybuffer";
  readyState = 0;
  onopen: OpenHandler | null = null;
  onclose: CloseHandler | null = null;
  onerror: ErrorHandler | null = null;
  onmessage: MessageHandler | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string | Uint8Array): void {
    if (typeof data !== "string") return;
    this.sent.push(data);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message["t"] === "hostJoin") {
      queueMicrotask(() => {
        this.emit({
          t: "hostJoined",
          code: "ABCD",
          serverTime: Date.now(),
        });
      });
    }
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: true });
  }

  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function socket(): FakeSocket {
  const last = FakeSocket.all.at(-1);
  if (last === undefined) {
    throw new Error("Host shell opened no WebSocket.");
  }
  return last;
}

beforeAll(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 201,
      async json() {
        return {
          code: "ABCD",
          pin: "1234",
          roomToken: ROOM_TOKEN,
          hostToken: HOST_TOKEN,
          expiresAt: Date.now() + 4 * 60 * 60 * 1_000,
          serverTime: Date.now(),
        };
      },
    })),
  );
  vi.stubGlobal("WebSocket", FakeSocket);
  // jsdom has no 2D canvas; the QR renderer must fall back, not throw.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

  document.body.innerHTML = HOST_MARKUP;
  window.history.replaceState({}, "", "/");
  await import("../src/main.js");

  await waitFor(
    () => document.querySelector(".lanpad-launcher") !== null,
    "launcher after room creation",
  );
  await waitFor(
    () => document.getElementById("connection")?.textContent === "Connected",
    "hostJoined",
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("host shell", () => {
  test("[FR-10.3] mounts the launcher at / after a room exists and no stage canvas", () => {
    const launcher = document.querySelector(".lanpad-launcher");
    expect(launcher).not.toBeNull();
    expect(launcher?.querySelector("h1")?.textContent).toBe("Games");
    expect(document.querySelectorAll(".lanpad-launcher__card")).toHaveLength(
      getGames().length,
    );
    expect(document.querySelector(".lanpad-canvas")).toBeNull();
    // HP-02: the lobby hero is the only place the code/PIN are rendered.
    expect(document.getElementById("room-code")?.textContent).toBe("----");
    expect(document.getElementById("room-pin")?.textContent).toBe("PIN ----");
    expect(document.querySelector(".lanpad-stage-bar")?.hasAttribute("hidden")).toBe(true);
  });

  test("[FR-5.4] updates connected counts in place and keeps the roster truthful", () => {
    const launcherBefore = document.querySelector(".lanpad-launcher");
    socket().emit({ t: "playerJoined", slot: 1 });

    const labels = Array.from(
      document.querySelectorAll(".lanpad-launcher__card-connected"),
    );
    expect(labels).toHaveLength(getGames().length);
    for (const label of labels) {
      expect(label.textContent).toBe("1 connected");
    }
    // Same element: a count change never rebuilds the shelf or loses focus.
    expect(document.querySelector(".lanpad-launcher")).toBe(launcherBefore);

    const row = document.querySelector('.slot-row[data-slot="1"]');
    expect(row?.getAttribute("data-state")).toBe("connected");
    expect(
      document.querySelector(".lanpad-stage-bar__players")?.textContent,
    ).toBe("1 player");

    socket().emit({ t: "playerSuspended", slot: 1 });
    expect(row?.getAttribute("data-state")).toBe("reconnecting");
    expect(
      document.querySelector('.slot-row[data-slot="1"] .slot-row__state')?.textContent,
    ).toBe("Reconnecting");
    expect(document.querySelectorAll(".lanpad-launcher__card-connected")).toHaveLength(0);
  });

  test("[FR-5.1] a kick shows HP-07 with one focused action and never renders the token", () => {
    socket().emit({ t: "kick", reason: "Removed by the host" });

    const notice = document.querySelector('.lanpad-notice[role="alert"]');
    expect(notice).not.toBeNull();
    expect(notice?.querySelector("h2")?.textContent).toBe("Room ended");
    expect(notice?.querySelector(".lanpad-notice__message")?.textContent).toBe(
      "Removed from the room: Removed by the host",
    );
    const action = notice?.querySelector<HTMLButtonElement>(".lanpad-notice__action");
    expect(action?.textContent).toBe("Create a new room");
    expect(document.activeElement).toBe(action);
    expect(window.location.pathname).toBe("/");

    // The room token exists only inside RoomPanel's QR path, never as text.
    expect(document.body.innerHTML.includes(ROOM_TOKEN)).toBe(false);
    expect(document.body.innerHTML.includes(HOST_TOKEN)).toBe(false);
    expect(document.getElementById("room-pin")?.textContent).toBe("PIN ----");
  });
});

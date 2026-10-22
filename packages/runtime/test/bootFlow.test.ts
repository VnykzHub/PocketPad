// @vitest-environment jsdom
/**
 * HP-01 boot and room-creation failure. The first `POST /api/rooms` fails;
 * the boot screen must show the failure and pressing Enter must retry.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

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
        <div class="boot__failure" role="alert">
          <span class="boot__dot boot__dot--bad" aria-hidden="true"></span>
          <h1 class="boot__title">Could not create a room</h1>
          <p class="boot__subtitle">
            Check that the dev server is running, then try again.
          </p>
          <form class="boot__retry" method="get" action="">
            <button type="submit" class="action action--primary">
              Try again
            </button>
          </form>
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

let fetchCalls = 0;

class FakeSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "", wasClean: true });
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

beforeAll(async () => {
  vi.resetModules();
  document.body.innerHTML = HOST_MARKUP;
  window.history.replaceState({}, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        throw new Error("offline");
      }
      return {
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
      };
    }),
  );
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

  await import("../src/main.js");
  await waitFor(
    () =>
      document.getElementById("connection")?.textContent ===
      "Could not create a room",
    "boot failure",
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("HP-01 boot", () => {
  test("[FR-5.1] a room-creation failure is visible and Enter retries", async () => {
    const connection = document.getElementById("connection");
    expect(connection?.textContent).toBe("Could not create a room");
    expect(connection?.dataset["state"]).toBe("bad");
    expect(document.getElementById("room-hint")?.textContent).toBe(
      "Press Enter to retry.",
    );
    expect(
      document.querySelector(".boot__failure .action--primary")?.textContent?.trim(),
    ).toBe("Try again");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    await waitFor(
      () => document.querySelector(".room-panel__code")?.textContent === "ABCD",
      "retried room creation",
    );
    expect(fetchCalls).toBeGreaterThanOrEqual(2);
  });
});


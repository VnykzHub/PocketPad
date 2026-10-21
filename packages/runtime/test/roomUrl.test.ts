// @vitest-environment jsdom
/**
 * D4-HOST-01: join URL, QR encoding, room panel notices and keyboard action.
 *
 * The room token is the only secret in this file's fixtures; every test that
 * handles it asserts it stays in the fragment and out of the DOM/logs.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildJoinUrl,
  renderJoinQr,
  resolvePublicOrigin,
  type QrRenderer,
} from "../src/ui/QrCode";
import {
  NEW_ROOM_LABEL,
  QR_FALLBACK_TEXT,
  RoomPanel,
  SECURITY_NOTICE,
  manualJoinInstruction,
  type RoomPanelRoom,
} from "../src/ui/RoomPanel";

const ORIGIN = "http://192.168.1.20:5173";
const CODE = "7K2M";
const PIN = "0429";
const TOKEN = "A1b2C3d4E5f6G7h8I9j0Kl";
const OTHER_TOKEN = "Z9y8X7w6V5u4T3s2R1q0Po";

const ROOM: RoomPanelRoom = { code: CODE, pin: PIN, roomToken: TOKEN };

afterEach(() => {
  document.body.replaceChildren();
});

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function recordingRenderer(): { renderer: QrRenderer; texts: string[] } {
  const texts: string[] = [];
  const renderer: QrRenderer = async (_canvas, text) => {
    texts.push(text);
  };
  return { renderer, texts };
}

function mountPanel(overrides: {
  readonly publicOrigin?: string;
  readonly renderQr?: QrRenderer;
  readonly onNewRoom?: () => void;
} = {}): { panel: RoomPanel; root: HTMLDivElement; texts: string[] } {
  const root = document.createElement("div");
  document.body.append(root);
  const recorded = recordingRenderer();
  const panel = new RoomPanel(root, {
    publicOrigin: overrides.publicOrigin ?? ORIGIN,
    renderQr: overrides.renderQr ?? recorded.renderer,
    ...(overrides.onNewRoom === undefined
      ? {}
      : { onNewRoom: overrides.onNewRoom }),
  });
  return { panel, root, texts: recorded.texts };
}

describe("join URL construction (D4-HOST-01)", () => {
  test("[FR-5.1] room token is only in the URL fragment", () => {
    const join = buildJoinUrl(ORIGIN, CODE, TOKEN);
    const parsed = new URL(join);

    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.pathname).toBe(`/c/${CODE}`);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe(`#${TOKEN}`);
    expect(join.slice(0, join.indexOf("#"))).not.toContain(TOKEN);
  });

  test("[SR-2] QR URL never puts the token in path or query", async () => {
    const { renderer, texts } = recordingRenderer();
    const canvas = document.createElement("canvas");

    await renderJoinQr(
      canvas,
      buildJoinUrl(`${ORIGIN}/`, CODE, TOKEN),
      renderer,
    );

    const encoded = texts[0] ?? "";
    const parsed = new URL(encoded);
    expect(encoded).toBe(`${ORIGIN}/c/${CODE}#${TOKEN}`);
    expect(parsed.pathname).toBe(`/c/${CODE}`);
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe(`#${TOKEN}`);
  });

  test("[SR-2] a misconfigured origin cannot smuggle a query or fragment", () => {
    const join = buildJoinUrl(
      "https://pages.example/tv/?leak=1#leak",
      CODE,
      TOKEN,
    );

    expect(join).toBe(`https://pages.example/tv/c/${CODE}#${TOKEN}`);
    expect(join).not.toContain("leak");
  });

  test("[SR-2] an invalid token is rejected without echoing it", () => {
    const badToken = "not-a-token/with?unsafe#chars";
    let message = "";
    try {
      buildJoinUrl(ORIGIN, CODE, badToken);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(badToken);
  });

  test("[FR-5.1] public origin prefers the pages origin over location", () => {
    expect(resolvePublicOrigin("https://vynkzhub.com/")).toBe(
      "https://vynkzhub.com",
    );
  });
});

describe("RoomPanel (D4-HOST-01)", () => {
  test("[SR-10] host shows the anyone-with-this-code notice", async () => {
    const { panel, root } = mountPanel();

    expect(root.textContent).toContain(SECURITY_NOTICE);

    panel.setRoom(ROOM);
    panel.setHostJoined(true);
    await settle();

    const notice = root.querySelector<HTMLElement>(".room-panel__notice");
    expect(notice).not.toBeNull();
    expect(notice?.hidden).toBe(false);
    expect(root.textContent).toContain(SECURITY_NOTICE);
  });

  test("[FR-5.6] manual join instructions are always visible", async () => {
    const { panel, root } = mountPanel();
    const manual = () =>
      root.querySelector<HTMLElement>(".room-panel__manual");

    expect(manual()?.hidden).toBe(false);
    expect(manual()?.textContent).toContain("/c");
    expect(manual()?.textContent).toContain("code + PIN");

    panel.setRoom(ROOM);
    await settle();

    expect(manual()?.hidden).toBe(false);
    expect(manual()?.textContent).toBe(manualJoinInstruction(ORIGIN));
  });

  test("[FR-5.6] manual join line follows the pages origin", () => {
    expect(manualJoinInstruction("http://192.168.1.20:5173")).toBe(
      "Or open http://192.168.1.20:5173/c and enter the code + PIN",
    );
    expect(manualJoinInstruction("")).toBe(
      "Or open /c and enter the code + PIN",
    );
  });

  test("[AR-4] new room action is a focusable native button", () => {
    let calls = 0;
    const { panel } = mountPanel({
      onNewRoom: () => {
        calls += 1;
      },
    });
    const button = panel.newRoomButton;

    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.textContent).toBe(NEW_ROOM_LABEL);
    expect(button.disabled).toBe(false);
    expect(button.tabIndex).toBe(0);

    button.focus();
    expect(document.activeElement).toBe(button);

    // Native buttons fire click for Enter and Space, which is what a TV
    // remote sends; the test asserts the action behind that activation.
    button.click();
    expect(calls).toBe(1);
  });

  test("[FR-5.1] the token never reaches DOM text or attributes", async () => {
    const { panel, root } = mountPanel();
    panel.setRoom(ROOM);
    panel.setHostJoined(true);
    await settle();

    expect(root.textContent).not.toContain(TOKEN);
    expect(root.innerHTML).not.toContain(TOKEN);

    for (const element of root.querySelectorAll("*")) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.value).not.toContain(TOKEN);
        expect(attribute.value).not.toContain(encodeURIComponent(TOKEN));
      }
    }
  });

  test("[FR-5.1] panel updates on host join without exposing the token", async () => {
    const { panel, root } = mountPanel();

    panel.setRoom(ROOM);
    panel.setHostJoined(true);
    await settle();

    expect(
      root.querySelector(".room-panel__status")?.textContent,
    ).toContain("Room ready");
    expect(root.textContent).not.toContain(TOKEN);
  });

  test("[SR-2] QR regenerates only when the code or token changes", async () => {
    const { panel, texts } = mountPanel();

    panel.setRoom(ROOM);
    await settle();
    panel.setRoom({ ...ROOM });
    await settle();
    expect(texts).toHaveLength(1);

    panel.setRoom({ ...ROOM, roomToken: OTHER_TOKEN });
    await settle();
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain(`#${OTHER_TOKEN}`);
  });

  test("[SR-9] host logs never include the QR URL or token", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );

    try {
      const failing: QrRenderer = async () => {
        throw new Error("canvas unavailable");
      };
      const { panel, root } = mountPanel({ renderQr: failing });

      panel.setRoom(ROOM);
      await settle();

      expect(root.textContent).toContain(QR_FALLBACK_TEXT);
      expect(root.textContent).not.toContain(TOKEN);

      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(TOKEN);
        }
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});

import { describe, expect, test } from "vitest";
import {
  ConsoleTopBar,
  formatClock,
  QR_CAPTION,
  QR_UNAVAILABLE,
  type QrRenderer,
} from "../../src/ui/console/topBar.js";
import {
  ConsoleLobbyPanel,
  LOBBY_EMPTY_HINT,
  LOBBY_EMPTY_TITLE,
  LOBBY_HEADING,
  LOBBY_QR_LABEL,
  LOBBY_SLOT_COUNT,
} from "../../src/ui/console/lobbyPanel.js";
import {
  ConsoleHintBar,
  HINT_GAMEPAD,
  HINT_KEYBOARD,
  HINT_REMOTE,
  HINTS,
} from "../../src/ui/console/hintBar.js";
import type {
  ConsoleConnection,
  ConsolePlayerInput,
  ConsoleRoomInfo,
} from "../../src/ui/console/types.js";
import {
  asDocument,
  FakeDocument,
  FakeElement,
  findAllByClass,
  findByClass,
  textOf,
} from "./fakeDom.js";

function fake(value: unknown): FakeElement {
  return value as FakeElement;
}

/** True when `needle` appears in any text node content or attribute value. */
function treeContains(root: FakeElement, needle: string): boolean {
  if (root.textContent.includes(needle)) return true;
  for (const value of root.attributes.values()) {
    if (value.includes(needle)) return true;
  }
  return root.children.some((child) => treeContains(child, needle));
}

function topBar(
  doc: FakeDocument,
  options: {
    room?: ConsoleRoomInfo;
    connection?: ConsoleConnection;
    players?: readonly ConsolePlayerInput[];
    renderQr?: QrRenderer;
  } = {},
): ConsoleTopBar {
  const bar = new ConsoleTopBar(asDocument(doc), options);
  doc.body.append(fake(bar.element));
  return bar;
}

describe("console chrome", () => {
  test("[ER-25-03] the top bar renders room, connection, clock and chips from data", () => {
    const doc = new FakeDocument();
    const bar = topBar(doc, {
      room: { code: "ABCD", pin: "4321" },
      connection: { text: "Room live", tone: "ok" },
      players: [
        { slot: 1 },
        {
          slot: 3,
          label: "Ada",
          color: "#123456",
          shape: "diamond",
          state: "connected",
        },
      ],
    });

    expect(bar.codeEl.textContent).toBe("ABCD");
    expect(bar.pinEl.textContent).toBe("PIN 4321");
    expect(textOf(fake(bar.element), "console-status__text")).toBe("Room live");
    expect(bar.connectionEl.dataset["tone"]).toBe("ok");
    expect(bar.connectionEl.getAttribute("aria-label")).toBe(
      "Connection: Room live",
    );

    const clock = new Date(2026, 0, 2, 9, 5);
    bar.setClock(clock);
    expect(bar.clockEl.textContent).toBe("09:05");
    expect(bar.clockEl.getAttribute("datetime")).toBe(clock.toISOString());
    expect(formatClock(new Date(2026, 0, 2, 0, 0))).toBe("00:00");
    expect(formatClock(new Date(Number.NaN))).toBe("--:--");

    const chips = findAllByClass(fake(bar.chipsEl), "console-chip");
    expect(chips).toHaveLength(2);
    expect(textOf(chips[0] ?? fake(bar.chipsEl), "console-chip__label")).toBe(
      "P1",
    );
    expect(textOf(chips[1] ?? fake(bar.chipsEl), "console-chip__label")).toBe(
      "Ada",
    );
    expect(chips[0]?.dataset["shape"]).toBe("circle");
    expect(chips[1]?.dataset["shape"]).toBe("diamond");
    expect(
      findByClass(chips[1] ?? fake(bar.chipsEl), "console-chip__shape")?.dataset[
        "shape"
      ],
    ).toBe("diamond");
    expect(chips[1]?.style.getPropertyValue("--chip-color")).toBe("#123456");
    // State is colour plus a word, never colour alone.
    expect(
      findAllByClass(chips[0] ?? fake(bar.chipsEl), "visually-hidden")[0]
        ?.textContent,
    ).toBe("connected");
    expect(fake(bar.chipsEl).hidden).toBe(false);

    bar.setPlayers([]);
    expect(findAllByClass(fake(bar.chipsEl), "console-chip")).toHaveLength(0);
    expect(fake(bar.chipsEl).hidden).toBe(true);

    bar.setRoom({ code: "  WXYZ ", pin: "   " });
    expect(bar.codeEl.textContent).toBe("WXYZ");
    expect(bar.pinEl.textContent).toBe("PIN ----");
    bar.setRoom({ code: null, pin: null });
    expect(bar.codeEl.textContent).toBe("----");
    expect(bar.pinEl.textContent).toBe("PIN ----");
  });

  test("[ER-25-03] the join URL reaches only the QR renderer, never text or attributes", async () => {
    const doc = new FakeDocument();
    const calls: Array<{ canvas: FakeElement; url: string }> = [];
    const joinUrl = "http://host/c/ABCD#secret-token";
    const renderQr: QrRenderer = (canvas, url) => {
      calls.push({ canvas: fake(canvas), url });
      return Promise.resolve();
    };
    const bar = topBar(doc, {
      room: { code: "ABCD", pin: "4321", joinUrl },
      renderQr,
    });
    expect(fake(bar.qrPanel).hidden).toBe(true);

    bar.setQrOpen(true);
    expect(fake(bar.qrPanel).hidden).toBe(false);
    expect(bar.qrToggle.getAttribute("aria-expanded")).toBe("true");
    expect(bar.qrToggle.textContent).toBe("Hide QR");
    expect(fake(bar.qrStatus).textContent).toBe(QR_CAPTION);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(joinUrl);
    expect(calls[0]?.canvas.getAttribute("width")).toBe("384");
    expect(fake(calls[0]?.canvas).getAttribute("height")).toBe("384");

    expect(treeContains(fake(bar.element), "secret-token")).toBe(false);
    expect(treeContains(fake(bar.element), "http://host/c/ABCD")).toBe(false);

    bar.setQrOpen(false);
    expect(fake(bar.qrPanel).hidden).toBe(true);
    expect(bar.qrToggle.textContent).toBe("QR");
  });

  test("[ER-25-03] missing QR input or a failed renderer shows a text fallback", async () => {
    const noRendererDoc = new FakeDocument();
    const noRenderer = topBar(noRendererDoc, {
      room: { code: "ABCD", pin: null, joinUrl: "http://host/c/ABCD#t" },
    });
    noRenderer.setQrOpen(true);
    expect(fake(noRenderer.qrStatus).textContent).toBe(QR_UNAVAILABLE);

    const noUrlDoc = new FakeDocument();
    let calls = 0;
    const noUrl = topBar(noUrlDoc, {
      room: { code: "ABCD", pin: null },
      renderQr: () => {
        calls += 1;
        return Promise.resolve();
      },
    });
    noUrl.setQrOpen(true);
    expect(fake(noUrl.qrStatus).textContent).toBe(QR_UNAVAILABLE);
    expect(calls).toBe(0);

    const failingDoc = new FakeDocument();
    const failing = topBar(failingDoc, {
      room: { code: "ABCD", pin: null, joinUrl: "http://host/c/ABCD#t" },
      renderQr: () => Promise.reject(new Error("canvas lost")),
    });
    failing.setQrOpen(true);
    await Promise.resolve();
    expect(fake(failing.qrStatus).textContent).toBe(QR_UNAVAILABLE);
  });

  test("[ER-25-03] the QR toggle is a real button and destroy releases it", () => {
    const doc = new FakeDocument();
    const bar = topBar(doc, { room: { code: "ABCD", pin: null } });
    expect(fake(bar.qrToggle).listenerCount("click")).toBe(1);
    fake(bar.qrToggle).click();
    expect(bar.isQrOpen).toBe(true);
    expect(fake(bar.element).parent).not.toBeNull();

    bar.destroy();
    expect(fake(bar.qrToggle).listenerCount("click")).toBe(0);
    expect(fake(bar.element).parent).toBeNull();
  });

  test("[ER-25-03] the lobby keeps eight stable rows and states them in words", () => {
    const doc = new FakeDocument();
    const players: ConsolePlayerInput[] = [
      {
        slot: 2,
        label: "Ada",
        color: "#ff0000",
        shape: "diamond",
        state: "connected",
      },
      { slot: 4, label: "Rex", state: "reconnecting" },
    ];
    let scans = 0;
    const lobby = new ConsoleLobbyPanel(asDocument(doc), {
      room: { code: "WXYZ", pin: null },
      players,
      onScanRequest: () => {
        scans += 1;
      },
    });
    doc.body.append(fake(lobby.element));

    const rows = findAllByClass(fake(lobby.list), "console-lobby__row");
    expect(rows).toHaveLength(LOBBY_SLOT_COUNT);
    expect(textOf(fake(lobby.element), "console-lobby__title")).toBe(
      LOBBY_HEADING,
    );

    const ada = rows[1];
    expect(ada?.dataset["state"]).toBe("connected");
    expect(textOf(ada ?? fake(lobby.list), "console-lobby__label")).toBe("Ada");
    expect(textOf(ada ?? fake(lobby.list), "console-lobby__state")).toBe(
      "Connected",
    );
    expect(ada?.getAttribute("aria-label")).toBe("Ada, Connected");
    expect(
      findByClass(ada ?? fake(lobby.list), "console-lobby__shape")?.dataset[
        "shape"
      ],
    ).toBe("diamond");
    expect(ada?.style.getPropertyValue("--player-color")).toBe("#ff0000");

    const rex = rows[3];
    expect(rex?.dataset["state"]).toBe("reconnecting");
    expect(textOf(rex ?? fake(lobby.list), "console-lobby__state")).toBe(
      "Reconnecting",
    );

    const open = rows[0];
    expect(open?.dataset["state"]).toBe("open");
    expect(textOf(open ?? fake(lobby.list), "console-lobby__label")).toBe("P1");
    expect(textOf(open ?? fake(lobby.list), "console-lobby__state")).toBe(
      "Open",
    );

    expect(lobby.connectedCount).toBe(1);
    expect(lobby.countEl.textContent).toBe("1 of 8");
    expect(fake(lobby.emptyState).hidden).toBe(true);
    expect(fake(lobby.list).hidden).toBe(false);

    // Rows are created once; player changes only update their contents.
    lobby.setPlayers([
      {
        slot: 2,
        label: "Ada",
        color: "#ff0000",
        shape: "diamond",
        state: "connected",
      },
    ]);
    const after = findAllByClass(fake(lobby.list), "console-lobby__row");
    expect(after).toHaveLength(LOBBY_SLOT_COUNT);
    after.forEach((row, index) => expect(row).toBe(rows[index]));

    lobby.setPlayers([]);
    expect(lobby.connectedCount).toBe(0);
    expect(lobby.countEl.textContent).toBe("0 of 8");
    expect(fake(lobby.emptyState).hidden).toBe(false);
    expect(fake(lobby.list).hidden).toBe(true);
    expect(textOf(fake(lobby.emptyState), "console-lobby__empty-title")).toBe(
      LOBBY_EMPTY_TITLE,
    );
    expect(lobby.emptyHint.textContent).toContain("WXYZ");
    expect(
      textOf(fake(lobby.emptyState), "console-lobby__empty-hint"),
    ).toContain("WXYZ");

    lobby.setRoom({ code: "", pin: null });
    expect(lobby.emptyHint.textContent).toBe(LOBBY_EMPTY_HINT);

    expect(lobby.qrButton.textContent).toBe(LOBBY_QR_LABEL);
    fake(lobby.qrButton).click();
    expect(scans).toBe(1);

    expect(fake(lobby.qrButton).listenerCount("click")).toBe(1);
    lobby.destroy();
    expect(fake(lobby.qrButton).listenerCount("click")).toBe(0);
    expect(fake(lobby.element).parent).toBeNull();
    fake(lobby.qrButton).click();
    expect(scans).toBe(1);
  });

  test("[ER-25-04] the hint bar names controls for the active input source", () => {
    const doc = new FakeDocument();
    const hints = new ConsoleHintBar(asDocument(doc));
    doc.body.append(fake(hints.element));

    expect(hints.inputMode).toBe("keyboard");
    expect(fake(hints.textEl).textContent).toBe(HINT_KEYBOARD);
    expect(fake(hints.element).getAttribute("role")).toBe("note");
    expect(fake(hints.element).getAttribute("aria-label")).toBe("Controls");

    hints.setMode("gamepad");
    expect(hints.inputMode).toBe("gamepad");
    expect(fake(hints.textEl).textContent).toBe(HINT_GAMEPAD);

    hints.setMode("remote");
    expect(fake(hints.textEl).textContent).toBe(HINT_REMOTE);

    expect(new Set([HINT_KEYBOARD, HINT_GAMEPAD, HINT_REMOTE]).size).toBe(3);
    expect(HINTS).toEqual({
      keyboard: HINT_KEYBOARD,
      gamepad: HINT_GAMEPAD,
      remote: HINT_REMOTE,
    });

    hints.destroy();
    expect(fake(hints.element).parent).toBeNull();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ConsoleGameRow, MAX_PARALLAX_PX } from "../../src/ui/console/gameRow.js";
import { ConsoleLobbyPanel } from "../../src/ui/console/lobbyPanel.js";
import { ConsoleStartGate } from "../../src/ui/console/startGate.js";
import { ConsoleTopBar } from "../../src/ui/console/topBar.js";
import type {
  ConsoleGame,
  ConsolePlayerInput,
} from "../../src/ui/console/types.js";
import {
  asDocument,
  FakeDocument,
  FakeElement,
  findAllByTag,
  textOf,
} from "./fakeDom.js";

const CSS = readFileSync(
  new URL("../../src/ui/console/console.css", import.meta.url),
  "utf8",
);

function fake(value: unknown): FakeElement {
  return value as FakeElement;
}

/** The name a screen reader can announce for a control. */
function accessibleName(element: FakeElement): string {
  const aria = element.getAttribute("aria-label")?.trim() ?? "";
  if (aria.length > 0) return aria;
  return element.textContent.trim();
}

const PLAYERS: readonly ConsolePlayerInput[] = Array.from(
  { length: 8 },
  (_, index) => {
    const slot = index + 1;
    return {
      slot,
      label: `P${slot}`,
      color: "#4cb3f0",
      shape: slot % 2 === 0 ? "square" : "circle",
      state: "connected",
    } satisfies ConsolePlayerInput;
  },
);

describe("console accessibility (static)", () => {
  test("[ER-25-04] focus is always visibly outlined and never removed", () => {
    expect(CSS).toContain(":focus-visible");
    expect(CSS).toContain("outline: 3px solid var(--console-accent)");
    expect(CSS).toContain("outline-offset: 2px");
    expect(CSS).not.toMatch(/outline\s*:\s*(?:none|0)(?:\s|;|})/);
  });

  test("[ER-25-05] reduced motion removes transitions, animations and focus scale", () => {
    expect(CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(CSS).toContain('.console-shell[data-motion="reduced"]');
    expect(
      CSS.match(/transition:\s*none/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(2);
    expect(CSS.match(/animation:\s*none/g)?.length ?? 0).toBeGreaterThanOrEqual(
      2,
    );
    expect(CSS).toMatch(
      /\.console-shell\[data-motion="reduced"\] \.console-tile\[data-active="true"\] \{\s*transform: none;/,
    );
    expect(CSS).toMatch(
      /\.console-shell \.console-tile\[data-active="true"\] \{\s*transform: none;/,
    );

    const scale = /scale\((\d+(?:\.\d+)?)\)/.exec(CSS)?.[1];
    expect(scale).toBeDefined();
    expect(Number(scale)).toBeLessThanOrEqual(1.08);
    expect(MAX_PARALLAX_PX).toBe(8);
  });

  test("[ER-25-04] no colour-only state and every control has an accessible name", () => {
    const doc = new FakeDocument();

    const bar = new ConsoleTopBar(asDocument(doc), {
      room: { code: "ABCD", pin: "4321" },
      players: PLAYERS,
    });
    doc.body.append(fake(bar.element));
    expect(fake(bar.chipsEl).children).toHaveLength(8);
    for (const chip of fake(bar.chipsEl).children) {
      expect(textOf(chip, "console-chip__label")).not.toBe("");
      expect(chip.dataset["shape"]).not.toBeUndefined();
      expect(chip.style.getPropertyValue("--chip-color")).not.toBe("");
      expect(textOf(chip, "visually-hidden")).toBe("connected");
    }
    for (const [tone, text] of [
      ["ok", "Room live"],
      ["pending", "Reconnecting"],
      ["bad", "Offline"],
    ] as const) {
      bar.setConnection({ text, tone });
      expect(textOf(fake(bar.element), "console-status__text")).toBe(text);
      expect(bar.connectionEl.getAttribute("aria-label")).toBe(
        `Connection: ${text}`,
      );
    }

    const lobby = new ConsoleLobbyPanel(asDocument(doc), {
      room: { code: "ABCD", pin: "4321" },
      players: [
        { slot: 1, label: "P1", state: "connected" },
        { slot: 2, label: "P2", state: "reconnecting" },
      ],
    });
    doc.body.append(fake(lobby.element));
    for (const row of fake(lobby.list).children) {
      expect(textOf(row, "console-lobby__label")).not.toBe("");
      expect(textOf(row, "console-lobby__state")).not.toBe("");
      expect(row.getAttribute("aria-label")).not.toBeNull();
    }

    const game: ConsoleGame = {
      slug: "arena",
      name: "Arena",
      minPlayers: 2,
      maxPlayers: 4,
      presentation: {
        tagline: "Last one standing",
        inputBadges: ["stick", "gyro"],
      },
    };
    const row = new ConsoleGameRow(asDocument(doc), { games: [game] });
    doc.body.append(fake(row.element));
    const badges = findAllByTag(fake(row.element), "span").filter(
      (element) => element.className === "console-badge",
    );
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) expect(badge.textContent).not.toBe("");

    const gate = new ConsoleStartGate(asDocument(doc), {
      onStart: () => undefined,
    });
    doc.body.append(fake(gate.element));

    const buttons = [
      ...findAllByTag(fake(bar.element), "button"),
      ...findAllByTag(fake(lobby.element), "button"),
      ...findAllByTag(fake(row.element), "button"),
      ...findAllByTag(fake(gate.element), "button"),
    ];
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    for (const button of buttons) expect(accessibleName(button)).not.toBe("");

    gate.destroy();
    row.destroy();
    lobby.destroy();
    bar.destroy();
  });

  test("[ER-25-04] the stylesheet avoids unsupported selectors and colour mixing", () => {
    expect(CSS).not.toContain(":has(");
    expect(CSS).not.toContain("color-mix(");
  });
});

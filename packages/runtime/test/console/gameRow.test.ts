import { describe, expect, test } from "vitest";
import {
  ConsoleGameRow,
  EMPTY_ROW_HINT,
  EMPTY_ROW_TITLE,
  MAX_PARALLAX_PX,
  PLAY_LABEL,
  ROW_HEADING,
} from "../../src/ui/console/gameRow.js";
import { asDocument, FakeDocument, FakeElement, findAllByClass, textOf } from "./fakeDom.js";
import type { ConsoleGame, MotionTier } from "../../src/ui/console/types.js";

function fake(value: unknown): FakeElement {
  return value as FakeElement;
}

function game(
  slug: string,
  name: string,
  overrides: Partial<ConsoleGame> = {},
): ConsoleGame {
  return { slug, name, minPlayers: 1, maxPlayers: 4, ...overrides };
}

const GAMES: readonly ConsoleGame[] = [
  game("arena", "Arena", {
    minPlayers: 2,
    maxPlayers: 4,
    presentation: {
      tagline: "Last one standing",
      accent: "#ff9f45",
      inputBadges: ["stick", "buttons"],
    },
  }),
  game("solo", "Solo", { minPlayers: 1, maxPlayers: 1 }),
  game("party", "Party", {
    minPlayers: 2,
    maxPlayers: 8,
    presentation: { tagline: "Couch chaos", featured: true },
  }),
];

interface Harness {
  readonly doc: FakeDocument;
  readonly row: ConsoleGameRow;
  readonly activated: string[];
  readonly focused: string[];
  tiles(): FakeElement[];
}

function setup(
  options: {
    games?: readonly ConsoleGame[];
    motion?: MotionTier;
  } = {},
): Harness {
  const doc = new FakeDocument();
  const activated: string[] = [];
  const focused: string[] = [];
  const row = new ConsoleGameRow(asDocument(doc), {
    games: options.games ?? GAMES,
    ...(options.motion !== undefined ? { motion: options.motion } : {}),
    onActivate: (entry) => activated.push(entry.slug),
    onFocusChange: (entry) => focused.push(entry.slug),
  });
  doc.body.append(fake(row.element));
  return {
    doc,
    row,
    activated,
    focused,
    tiles: () => findAllByClass(fake(row.element), "console-tile"),
  };
}

function tileAt(harness: Harness, index: number): FakeElement {
  const tile = harness.tiles()[index];
  if (tile === undefined) throw new Error(`missing tile ${index}`);
  return tile;
}

function detailsAt(harness: Harness, index: number): FakeElement {
  const details = findAllByClass(tileAt(harness, index), "console-tile__details")[0];
  if (details === undefined) throw new Error(`missing details ${index}`);
  return details;
}

describe("console game row", () => {
  // @req ER-25-03
  test("[ER-25-03] tiles come from manifest data only, featured first", () => {
    const harness = setup();
    expect(harness.row.gameList.map((entry) => entry.slug)).toEqual([
      "party",
      "arena",
      "solo",
    ]);
    expect(harness.tiles()).toHaveLength(3);
    expect(textOf(fake(harness.row.element), "console-row__count")).toBe(
      "3 games",
    );
    expect(textOf(fake(harness.row.element), "console-row__title")).toBe(
      ROW_HEADING,
    );

    const invented = setup({ games: [game("new-game", "New Game")] });
    expect(invented.row.gameList[0]?.slug).toBe("new-game");
    expect(invented.tiles()).toHaveLength(1);
  });

  test("[ER-25-03] the focused tile shows title, tagline, range, badges and Play", () => {
    const harness = setup();
    harness.row.focusSlug("arena");
    const arena = tileAt(harness, 1);
    expect(textOf(arena, "console-tile__title")).toBe("Arena");
    expect(textOf(arena, "console-tile__tagline")).toBe("Last one standing");
    expect(textOf(arena, "console-tile__range")).toBe("2–4 players");
    const badges = findAllByClass(arena, "console-badge").map(
      (badge) => badge.textContent,
    );
    expect(badges).toEqual(["Stick", "Buttons"]);
    expect(textOf(arena, "console-tile__play")).toBe(PLAY_LABEL);
    expect(detailsAt(harness, 1).hidden).toBe(false);
    expect(arena.getAttribute("aria-label")).toBe(
      "Arena, 2–4 players, Last one standing",
    );
  });

  test("[ER-25-04] arrow navigation moves focus, wraps at both ends and keeps one tab stop", () => {
    const harness = setup();
    expect(tileAt(harness, 0).tabIndex).toBe(0);
    expect(tileAt(harness, 1).tabIndex).toBe(-1);

    harness.row.move(1);
    expect(harness.row.focusedIndex).toBe(1);
    expect(harness.row.focusedGame?.slug).toBe("arena");
    expect(tileAt(harness, 1).focused).toBe(true);
    expect(tileAt(harness, 0).focused).toBe(false);
    expect(tileAt(harness, 1).tabIndex).toBe(0);
    expect(tileAt(harness, 0).tabIndex).toBe(-1);

    harness.row.move(-1);
    expect(harness.row.focusedIndex).toBe(0);

    harness.row.move(-1);
    expect(harness.row.focusedIndex).toBe(2);
    expect(tileAt(harness, 2).focused).toBe(true);

    harness.row.move(1);
    expect(harness.row.focusedIndex).toBe(0);

    harness.row.focusLast();
    expect(harness.row.focusedIndex).toBe(2);
    harness.row.focusFirst();
    expect(harness.row.focusedIndex).toBe(0);
    expect(harness.focused).toEqual([
      "arena",
      "party",
      "solo",
      "party",
      "solo",
      "party",
    ]);
  });

  test("[ER-25-04] only the focused tile reveals details; neighbours stay quiet", () => {
    const harness = setup();
    harness.row.focusSlug("party");
    expect(detailsAt(harness, 0).hidden).toBe(false);
    expect(detailsAt(harness, 1).hidden).toBe(true);
    expect(detailsAt(harness, 2).hidden).toBe(true);
    expect(tileAt(harness, 0).dataset["active"]).toBe("true");
    expect(tileAt(harness, 1).dataset["active"]).toBe("false");
    expect(tileAt(harness, 2).dataset["active"]).toBe("false");
  });

  test("[ER-25-04] click and confirm activate the tile under focus", () => {
    const harness = setup();
    harness.row.focusSlug("arena");
    tileAt(harness, 1).click();
    expect(harness.activated).toEqual(["arena"]);

    harness.row.focusSlug("solo");
    expect(harness.row.activateActive()).toBe(true);
    expect(harness.activated).toEqual(["arena", "solo"]);
  });

  test("[ER-25-04] focusSlug restores a launched tile and rejects unknown slugs", () => {
    const harness = setup();
    expect(harness.row.focusSlug("solo")).toBe(true);
    expect(harness.row.focusedGame?.slug).toBe("solo");
    expect(tileAt(harness, 2).focused).toBe(true);
    expect(harness.row.focusSlug("missing")).toBe(false);
    expect(harness.row.focusedGame?.slug).toBe("solo");
    expect(harness.row.focusSlug(null)).toBe(false);
  });

  test("[ER-25-05] the full tier caps parallax at 8px and moves it with the active tile", () => {
    const harness = setup();
    harness.row.setParallax(200, -200);
    expect(harness.row.parallax).toEqual({
      x: MAX_PARALLAX_PX,
      y: -MAX_PARALLAX_PX,
    });
    expect(tileAt(harness, 0).style.getPropertyValue("--parallax-x")).toBe(
      "8px",
    );
    expect(tileAt(harness, 0).style.getPropertyValue("--parallax-y")).toBe(
      "-8px",
    );
    expect(tileAt(harness, 1).style.getPropertyValue("--parallax-x")).toBe("");

    harness.row.move(1);
    expect(tileAt(harness, 0).style.getPropertyValue("--parallax-x")).toBe(
      "0px",
    );
    expect(tileAt(harness, 1).style.getPropertyValue("--parallax-x")).toBe(
      "8px",
    );

    harness.row.setParallax(Number.NaN, 2);
    expect(harness.row.parallax).toEqual({ x: 0, y: 2 });
  });

  test("[ER-25-05] the reduced tier ignores parallax entirely", () => {
    const harness = setup({ motion: "reduced" });
    harness.row.setParallax(8, -8);
    expect(harness.row.parallax).toEqual({ x: 0, y: 0 });
    expect(tileAt(harness, 0).style.getPropertyValue("--parallax-x")).toBe(
      "0px",
    );
    expect(tileAt(harness, 0).style.getPropertyValue("--parallax-y")).toBe(
      "0px",
    );
  });

  test("[ER-25-03] only safe thumbnails are used; unsafe art keeps the generated gradient", () => {
    const relative = setup({
      games: [
        game("art", "Art", {
          presentation: { thumbnail: "/assets/art.webp" },
        }),
      ],
    });
    const art = findAllByClass(tileAt(relative, 0), "console-tile__art")[0];
    expect(art?.dataset["art"]).toBe("image");
    const image = findAllByClass(tileAt(relative, 0), "console-tile__image")[0];
    expect(image?.style.getPropertyValue("background-image")).toBe(
      'url("/assets/art.webp")',
    );

    const data = setup({
      games: [
        game("art", "Art", {
          presentation: { thumbnail: "data:image/png;base64,AAAA" },
        }),
      ],
    });
    expect(
      findAllByClass(tileAt(data, 0), "console-tile__art")[0]?.dataset["art"],
    ).toBe("image");

    for (const unsafe of [
      "javascript:alert(1)",
      '/assets/a") ; background: red; x="',
      "https://example.com/art.png",
    ]) {
      const rejected = setup({
        games: [
          game("art", "Art", { presentation: { thumbnail: unsafe } }),
        ],
      });
      expect(
        findAllByClass(tileAt(rejected, 0), "console-tile__art")[0]?.dataset[
          "art"
        ],
      ).toBe("generated");
    }
  });

  test("[ER-25-03] an empty shelf keeps the heading and explains what to do", () => {
    const harness = setup({ games: [] });
    expect(fake(harness.row.track).hidden).toBe(true);
    expect(fake(harness.row.emptyState).hidden).toBe(false);
    expect(textOf(fake(harness.row.element), "console-row__empty-title")).toBe(
      EMPTY_ROW_TITLE,
    );
    expect(textOf(fake(harness.row.element), "console-row__empty-hint")).toBe(
      EMPTY_ROW_HINT,
    );
    harness.row.focusFirst();
    harness.row.focus();
    expect(harness.row.focusedGame).toBeNull();
    expect(harness.row.activateActive()).toBe(false);
  });

  test("[ER-25-04] destroy removes every tile listener and stops activation", () => {
    const harness = setup();
    expect(tileAt(harness, 0).listenerCount()).toBe(2);
    harness.row.destroy();
    expect(tileAt(harness, 0).listenerCount()).toBe(0);
    expect(fake(harness.row.element).parent).toBeNull();
    tileAt(harness, 0).click();
    expect(harness.row.activateActive()).toBe(false);
    expect(harness.activated).toEqual([]);
  });
});

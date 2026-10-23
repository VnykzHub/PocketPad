import { describe, expect, test } from "vitest";
import type { GamePresentation } from "@lanpad/sdk";
import {
  connectedPlayers,
  fallbackAccent,
  hashText,
  inputBadgeLabel,
  monogramFor,
  playerRangeLabel,
  presentationAccent,
  presentationBadges,
  presentationGradient,
  presentationTagline,
  resolvePlayers,
  slotColor,
  slotLabel,
  slotShape,
  sortConsoleGames,
  visibleConsoleGames,
} from "../../src/ui/console/presentation.js";
import type { ConsoleGame } from "../../src/ui/console/types.js";

function game(
  overrides: Partial<ConsoleGame> & Pick<ConsoleGame, "slug" | "name">,
): ConsoleGame {
  return { minPlayers: 1, maxPlayers: 4, ...overrides };
}

describe("console presentation", () => {
  // @req ER-25-03
  test("[ER-25-03] generated art is deterministic for any slug, with no game table", () => {
    const invented = game({ slug: "never-heard-of-it", name: "Never Heard Of It" });
    expect(monogramFor(invented.name)).toBe("NH");
    expect(hashText(invented.slug)).toBe(hashText(invented.slug));
    expect(hashText(invented.slug)).toBeGreaterThanOrEqual(0);
    expect(fallbackAccent(invented)).toBe(fallbackAccent(invented));
    expect(fallbackAccent(invented)).toMatch(/^#[0-9a-f]{6}$/);
    expect(presentationGradient(invented)).toContain(fallbackAccent(invented));
  });

  test("[ER-25-03] monograms handle one word, extra spaces and an empty name", () => {
    expect(monogramFor("platformer")).toBe("P");
    expect(monogramFor("  Beat   Tap  ")).toBe("BT");
    expect(monogramFor("")).toBe("?");
    expect(monogramFor("   ")).toBe("?");
  });

  test("[ER-25-03] a manifest accent is used only when it is a valid hex colour", () => {
    const accent = game({
      slug: "neon",
      name: "Neon",
      presentation: { accent: "#FF9F45" },
    });
    expect(presentationAccent(accent)).toBe("#ff9f45");
    expect(presentationGradient(accent)).toContain("#ff9f45");

    const invalid = game({
      slug: "neon",
      name: "Neon",
      presentation: { accent: "orange" },
    });
    expect(presentationAccent(invalid)).toBe(fallbackAccent(invalid));

    const short = game({
      slug: "neon",
      name: "Neon",
      presentation: { accent: "#fff" },
    });
    expect(presentationAccent(short)).toBe(fallbackAccent(short));
  });

  test("[ER-25-03] a missing presentation falls back without rendering undefined", () => {
    const bare = game({ slug: "bare", name: "Bare" });
    expect(presentationTagline(bare)).toBeNull();
    expect(presentationBadges(bare)).toEqual([]);
    expect(presentationAccent(bare)).not.toContain("undefined");
    expect(presentationGradient(bare)).not.toContain("undefined");
  });

  test("[ER-25-03] taglines are trimmed and blank taglines are treated as absent", () => {
    expect(
      presentationTagline(
        game({
          slug: "a",
          name: "A",
          presentation: { tagline: "  Four-player chaos  " },
        }),
      ),
    ).toBe("Four-player chaos");
    expect(
      presentationTagline(
        game({ slug: "a", name: "A", presentation: { tagline: "   " } }),
      ),
    ).toBeNull();
  });

  test("[ER-25-03] input badges keep manifest order and drop unknown values", () => {
    const presentation = {
      inputBadges: ["stick", "laser", "gyro"],
    } as unknown as GamePresentation;
    const badges = presentationBadges(
      game({ slug: "a", name: "A", presentation }),
    );
    expect(badges).toEqual(["stick", "gyro"]);
    expect(badges.map(inputBadgeLabel)).toEqual(["Stick", "Gyro"]);
  });

  test("[ER-25-04] every badge has a text label, never an icon alone", () => {
    const labels = (
      ["stick", "dpad", "buttons", "triggers", "gyro", "haptics", "text", "canvas", "choice"] as const
    ).map(inputBadgeLabel);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("[ER-25-03] featured games sort first, then by name and slug, without a game table", () => {
    const games = [
      game({ slug: "zebra", name: "Zebra" }),
      game({ slug: "alpha", name: "alpha" }),
      game({
        slug: "featured",
        name: "Zzz",
        presentation: { featured: true },
      }),
      game({ slug: "beta-b", name: "Beta" }),
      game({ slug: "beta-a", name: "beta" }),
    ];
    expect(sortConsoleGames(games).map((entry) => entry.slug)).toEqual([
      "featured",
      "alpha",
      "beta-a",
      "beta-b",
      "zebra",
    ]);
  });

  test("[ER-25-03] the player range is generated from manifest numbers", () => {
    expect(playerRangeLabel(1, 1)).toBe("1 player");
    expect(playerRangeLabel(2, 4)).toBe("2–4 players");
    expect(playerRangeLabel(0, 99)).toBe("1–8 players");
  });

  test("[ER-25-03] slots get stable colours, labels and four cycling shapes", () => {
    expect(slotColor(1)).toBe("#4cb3f0");
    expect(slotColor(8)).toBe("#ff6b6b");
    expect(slotLabel(3)).toBe("P3");
    expect(slotShape(1)).toBe("circle");
    expect(slotShape(2)).toBe("triangle");
    expect(slotShape(3)).toBe("square");
    expect(slotShape(4)).toBe("diamond");
    expect(slotShape(5)).toBe("circle");
    expect(slotLabel(9)).toBe("P1");
    expect(slotColor(0)).toBe("#4cb3f0");
  });

  test("[ER-25-04] player identities are filled deterministically and sorted by slot", () => {
    const players = resolvePlayers([
      { slot: 3, label: "  Ada  ", color: "#123456", state: "reconnecting" },
      { slot: 1 },
      { slot: 3, label: "Duplicate" },
      { slot: 0 },
      { slot: 9 },
      { slot: 1.5 },
    ]);
    expect(players.map((player) => player.slot)).toEqual([1, 3]);
    expect(players[0]).toMatchObject({
      slot: 1,
      label: "P1",
      color: slotColor(1),
      shape: "circle",
      state: "connected",
    });
    expect(players[1]).toMatchObject({
      slot: 3,
      label: "Ada",
      color: "#123456",
      shape: "square",
      state: "reconnecting",
    });
    expect(connectedPlayers(players).map((player) => player.slot)).toEqual([1]);
  });

  test("[ER-25-09] debug-only tech demos stay hidden unless debug is on", () => {
    const games = [
      game({ slug: "party", name: "Party" }),
      game({ slug: "engine-cube", name: "Engine Cube", debugOnly: true }),
    ];
    expect(visibleConsoleGames(games, false).map((entry) => entry.slug)).toEqual([
      "party",
    ]);
    expect(visibleConsoleGames(games, true).map((entry) => entry.slug)).toEqual([
      "party",
      "engine-cube",
    ]);
  });
});

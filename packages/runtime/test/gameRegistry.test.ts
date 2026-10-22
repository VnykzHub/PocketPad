/**
 * Bundled game registry tests (D7-SDK-01; G8, FR-10.3, FR-9.13).
 *
 * The build-time glob is the real subject here: these tests exercise the same
 * `import.meta.glob` discovery Vite performs for the host, so a new
 * `packages/games/<slug>/game.manifest.json` appears without any code change.
 */
import { describe, expect, test } from "vitest";
import {
  createGameRegistry,
  discoverBundledGames,
  GameRegistryError,
  getGames,
  manifestUrlFor,
  slugFromManifestPath,
  type GameSource,
} from "../src/game/registry.js";

const validManifest = {
  schemaVersion: 1,
  name: "Alpha",
  entry: "index.js",
  layouts: ["layout.json"],
  assetBudget: { initialBytes: 1, totalBytes: 2 },
  minPlayers: 1,
  maxPlayers: 8,
  needsGyro: false,
};

function source(slug: string, manifest: unknown = validManifest): GameSource {
  return {
    slug,
    manifest,
    sourcePath: `../../../games/${slug}/game.manifest.json`,
  };
}

describe("discovery", () => {
  test("[G8] a bundled game is discovered from its folder + manifest only", () => {
    const sources = discoverBundledGames();
    const slugs = sources.map((entry) => entry.slug);
    expect(slugs).toContain("reaction-duel");

    const reactionDuel = sources.find((entry) => entry.slug === "reaction-duel");
    expect(reactionDuel?.sourcePath).toMatch(/games\/reaction-duel\/game\.manifest\.json$/);
    expect(reactionDuel?.manifest).toMatchObject({
      name: "Reaction Duel",
      minPlayers: 2,
      maxPlayers: 8,
    });
  });

  test("[FR-10.3] every discovered bundled manifest validates", () => {
    const entries = createGameRegistry(discoverBundledGames());
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries) {
      expect(entry.minPlayers).toBeGreaterThanOrEqual(1);
      expect(entry.maxPlayers).toBeLessThanOrEqual(8);
      expect(entry.minPlayers).toBeLessThanOrEqual(entry.maxPlayers);
    }
  });

  test("[FR-9.13] getGames exposes the metadata the launcher needs", () => {
    const games = getGames();
    const reactionDuel = games.find((entry) => entry.slug === "reaction-duel");
    expect(reactionDuel).toEqual({
      slug: "reaction-duel",
      name: "Reaction Duel",
      description: "Match the signal. First to three rounds wins.",
      minPlayers: 2,
      maxPlayers: 8,
      needsGyro: false,
      manifestUrl: "/games/reaction-duel/game.manifest.json",
    });
    expect(getGames()).toBe(games);
    expect(Object.isFrozen(games)).toBe(true);
    expect(Object.isFrozen(reactionDuel)).toBe(true);
  });

  test("[FR-10.3][A12] the Coin Run platformer is discovered at /games/platformer/", () => {
    const platformer = getGames().find((entry) => entry.slug === "platformer");
    expect(platformer).toEqual({
      slug: "platformer",
      name: "Coin Run",
      description: "Race across a shared level and collect 20 coins.",
      minPlayers: 1,
      maxPlayers: 4,
      needsGyro: false,
      manifestUrl: "/games/platformer/game.manifest.json",
    });
    expect(discoverBundledGames().map((entry) => entry.slug)).toContain("platformer");
  });

  test("slugFromManifestPath handles Vite keys and rejects other paths", () => {
    expect(slugFromManifestPath("../../../games/reaction-duel/game.manifest.json")).toBe(
      "reaction-duel",
    );
    expect(slugFromManifestPath("..\\..\\..\\games\\reaction-duel\\game.manifest.json")).toBe(
      "reaction-duel",
    );
    expect(slugFromManifestPath("../../../runtime/public/demo/game.manifest.json")).toBeNull();
  });

  test("manifestUrlFor is root-absolute so the host page's path does not matter", () => {
    expect(manifestUrlFor("foo")).toBe("/games/foo/game.manifest.json");
  });
});

describe("validation", () => {
  test("[FR-10.3] an invalid manifest fails with its path and every error", () => {
    const invalid = {
      schemaVersion: 1,
      name: "",
      entry: "../escape.js",
      layouts: [],
      assetBudget: { initialBytes: 5, totalBytes: 1 },
      minPlayers: 9,
      maxPlayers: 2,
      needsGyro: "no",
    };
    try {
      createGameRegistry([source("broken", invalid)]);
      expect.unreachable("invalid manifest must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GameRegistryError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("broken");
      expect(message).toContain("games/broken/game.manifest.json");
      expect(message).toContain("name");
      expect(message).toContain("entry");
      expect(message).toContain("minPlayers");
    }
  });

  test("[FR-10.3] duplicate slugs are rejected instead of shadowing", () => {
    const alpha = { ...validManifest, name: "Alpha" };
    const beta = { ...validManifest, name: "Beta" };
    expect(() => createGameRegistry([
      source("same", alpha),
      { ...source("same", beta), sourcePath: "elsewhere/games/same/game.manifest.json" },
    ])).toThrow(/Duplicate game slug "same"/);
  });

  test("invalid slugs are rejected", () => {
    expect(() => createGameRegistry([source("Not A Slug")])).toThrow(GameRegistryError);
    expect(() => createGameRegistry([source("../escape")])).toThrow(GameRegistryError);
  });

  test("entries are sorted by display name with a deterministic tie-break", () => {
    const zeta = { ...validManifest, name: "Zeta" };
    const alpha = { ...validManifest, name: "Alpha" };
    const beta = { ...validManifest, name: "Beta" };
    const entries = createGameRegistry([
      source("zeta", zeta),
      source("alpha", alpha),
      source("beta", beta),
    ]);
    expect(entries.map((entry) => entry.name)).toEqual(["Alpha", "Beta", "Zeta"]);
  });

  test("an empty list is a valid (frozen) registry", () => {
    const entries = createGameRegistry([]);
    expect(entries).toEqual([]);
    expect(Object.isFrozen(entries)).toBe(true);
  });
});

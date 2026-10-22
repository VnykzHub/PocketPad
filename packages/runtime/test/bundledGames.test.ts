/**
 * Bundled entry mapping (D3-SDK-01, D7-SDK-01; A12, FR-10.3).
 *
 * `registry.test.ts` proves discovery and the manifest URLs. This suite proves
 * the other half of the boot path: the resolved `<manifest dir>/<entry>` URL of
 * every discovered game maps to its Vite chunk, so `loadGame` can import the
 * platformer without a network fetch of `index.js`. The glob here is the real
 * build-time glob, so a new `packages/games/<slug>/src/game.ts` is covered by
 * the same mapping without a hand-written table.
 */
import { describe, expect, test, vi } from "vitest";
import type { Game, GameManifest } from "@lanpad/sdk";
import {
  createBundledGameImporter,
  createBundledGames,
} from "../src/demo/bundledGames.js";

type GameModule = { readonly default: (manifest: GameManifest) => Game };

const MANIFEST: GameManifest = {
  schemaVersion: 1,
  name: "Coin Run",
  entry: "index.js",
  layouts: ["layouts/pf-dpad-v1.json", "layouts/pf-stick-v1.json"],
  assetBudget: { initialBytes: 262144, totalBytes: 1048576 },
  minPlayers: 1,
  maxPlayers: 4,
  needsGyro: false,
};

const BASE = "https://tv.example/";

describe("[A12] bundled game entry mapping", () => {
  test("[FR-10.3] the platformer entry URL resolves to its bundled GameModule", async () => {
    const fallback = vi.fn(async () => {
      throw new Error("network fallback must not run for a bundled game");
    });
    const importModule = createBundledGameImporter(BASE, fallback);

    const module = (await importModule(
      "https://tv.example/games/platformer/index.js",
    )) as GameModule;

    expect(fallback).not.toHaveBeenCalled();
    expect(typeof module.default).toBe("function");

    const game = module.default(MANIFEST);
    expect(game.manifest).toBe(MANIFEST);
    game.dispose();
  });

  test("[FR-10.3] every discovered game maps its manifest-derived entry URL", async () => {
    const fallback = vi.fn(async (url: string) => {
      throw new Error(`unexpected fallback: ${url}`);
    });
    const { games, importModule } = createBundledGames(BASE, fallback);
    expect(games.map((entry) => entry.slug)).toContain("platformer");

    for (const entry of games) {
      const entryUrl = new URL(entry.manifestUrl, BASE);
      const module = (await importModule(
        new URL("index.js", entryUrl).href,
      )) as GameModule;
      expect(typeof module.default).toBe("function");
    }
    expect(fallback).not.toHaveBeenCalled();
  });

  test("an unknown entry URL still falls through to the native import fallback", async () => {
    const fallback = vi.fn(async () => "native");
    const importModule = createBundledGameImporter(BASE, fallback);
    await expect(importModule("https://tv.example/games/unknown/index.js")).resolves.toBe(
      "native",
    );
    expect(fallback).toHaveBeenCalledWith("https://tv.example/games/unknown/index.js");
  });
});

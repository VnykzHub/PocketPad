// @req ER-25-03 — a folder with a manifest registers a game with no root edit.
import { describe, expect, test } from "vitest";
import { validateManifest } from "@lanpad/sdk";
import { createFakeContext, createFakePlayer } from "@lanpad/sdk/testing";
import manifestJson from "../game.manifest.json";
import { createTemplateGame } from "../src/game.js";

describe("Template Game", () => {
  test("[ER-25-03] the shipped manifest validates and declares presentation", () => {
    const result = validateManifest(manifestJson);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.presentation?.tagline).toBe(
      "A folder, a manifest, a tile.",
    );
    expect(result.manifest.presentation?.categories).toEqual(["solo"]);
  });

  test("[ER-25-03] init, simulate, render and dispose run headlessly", () => {
    const context = createFakeContext();
    const game = createTemplateGame(manifestJson as never);

    game.init(context);
    for (let tick = 0; tick < 3; tick += 1) {
      game.simulate(1 / 60, {
        tick,
        players: [createFakePlayer(1, { edges: 1 })],
      });
    }
    game.render(0);
    expect(() => game.dispose()).not.toThrow();
    expect(() => game.dispose()).not.toThrow();
  });
});

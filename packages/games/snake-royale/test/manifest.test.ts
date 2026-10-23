import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { validateManifest } from "../../../../sdk/src/index";

/**
 * Snake Royale manifest contract (GAME-SR-DATA-01; FR-10.3, G8).
 *
 * The tests read the shipped manifest as data, exactly as the runtime registry
 * does, so adding the folder is the only registration step. The launcher
 * metadata (`presentation`) is additive but still validated by the SDK.
 */

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as unknown;
}

const shippedManifest = readJson("../game.manifest.json");

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("manifest fixture must be an object");
  }
  return value as Record<string, unknown>;
}

function withOverrides(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...asRecord(shippedManifest), ...overrides };
}

describe("Snake Royale manifest", () => {
  test("[FR-10.3][G8] the shipped manifest validates with the documented boundary", () => {
    const result = validateManifest(shippedManifest);
    expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest).toEqual({
      schemaVersion: 1,
      name: "Snake Royale",
      description: "Grow your snake, cut off rivals and survive the shrinking arena.",
      entry: "index.js",
      layouts: ["layouts/snake-dpad-v1.json"],
      assetBudget: { initialBytes: 262144, totalBytes: 1048576 },
      minPlayers: 2,
      maxPlayers: 8,
      needsGyro: false,
      presentation: {
        tagline: "Eat, grow, outlast the arena.",
        accent: "#4fd1a1",
        categories: ["arena", "party"],
        inputBadges: ["dpad"],
      },
    });
  });

  test("[G8] every declared layout is a real file in the game folder", () => {
    const result = validateManifest(shippedManifest);
    expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
    if (!result.ok) {
      return;
    }
    for (const layoutPath of result.manifest.layouts) {
      const file = new URL(`../${layoutPath}`, import.meta.url);
      expect(() => readFileSync(file, "utf8"), layoutPath).not.toThrow();
    }
  });

  test("[FR-10.3] launcher metadata stays inside the presentation limits", () => {
    const result = validateManifest(shippedManifest);
    if (!result.ok) {
      throw new Error(result.errors.join("\n"));
    }
    const presentation = result.manifest.presentation;
    expect(presentation).toBeDefined();
    expect(presentation?.tagline?.length).toBeLessThanOrEqual(80);
    expect(presentation?.tagline).toBe("Eat, grow, outlast the arena.");
    expect(presentation?.accent).toBe("#4fd1a1");
    expect(presentation?.categories).toEqual(["arena", "party"]);
    expect(presentation?.inputBadges).toEqual(["dpad"]);
  });

  test("[FR-10.3] an out-of-range roster, missing layouts or long tagline is rejected", () => {
    const roster = validateManifest(withOverrides({ minPlayers: 9, maxPlayers: 8 }));
    expect(roster.ok).toBe(false);

    const layouts = validateManifest(withOverrides({ layouts: [] }));
    expect(layouts.ok).toBe(false);

    const tagline = validateManifest(
      withOverrides({ presentation: { tagline: "x".repeat(81) } }),
    );
    expect(tagline.ok).toBe(false);
  });
});

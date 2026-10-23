import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { validateManifest } from "../../../../sdk/src/index";

/**
 * Tilt Maze Race manifest contract (GAME-TM-DATA-01/02; FR-10.3, G8).
 *
 * The tests read the shipped manifest as data, exactly as the runtime registry
 * does, so adding the folder is the only registration step. The launcher
 * metadata (`presentation`) is additive but still validated by the SDK. The
 * plan fixes the roster at 2..8 players; `needsGyro` stays false because the
 * stick fallback is always present.
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

describe("Tilt Maze Race manifest", () => {
  test("[FR-10.3][G8] the shipped manifest validates with the documented boundary", () => {
    const result = validateManifest(shippedManifest);
    expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest).toEqual({
      schemaVersion: 1,
      name: "Tilt Maze Race",
      description:
        "Tilt your phone to roll your ball through the maze and reach the exit first.",
      entry: "index.js",
      layouts: ["layouts/tm-tilt-v1.json", "layouts/tm-stick-v1.json"],
      assetBudget: { initialBytes: 262144, totalBytes: 1048576 },
      minPlayers: 2,
      maxPlayers: 8,
      needsGyro: false,
      presentation: {
        tagline: "Tilt, roll and race to the exit.",
        accent: "#ff9f45",
        categories: ["racing", "party"],
        inputBadges: ["gyro", "stick"],
      },
    });
  });

  test("[G8] every declared layout is a real file in the game folder", () => {
    const result = validateManifest(shippedManifest);
    expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.layouts).toEqual([
      "layouts/tm-tilt-v1.json",
      "layouts/tm-stick-v1.json",
    ]);
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
    expect(presentation?.tagline).toBe("Tilt, roll and race to the exit.");
    expect(presentation?.accent).toBe("#ff9f45");
    expect(presentation?.categories).toEqual(["racing", "party"]);
    expect(presentation?.inputBadges).toEqual(["gyro", "stick"]);
  });

  test("[FR-10.3] an out-of-range roster, missing layouts or long tagline is rejected", () => {
    const roster = validateManifest(withOverrides({ minPlayers: 9, maxPlayers: 8 }));
    expect(roster.ok).toBe(false);

    const tooMany = validateManifest(withOverrides({ maxPlayers: 9 }));
    expect(tooMany.ok).toBe(false);

    const layouts = validateManifest(withOverrides({ layouts: [] }));
    expect(layouts.ok).toBe(false);

    const tagline = validateManifest(
      withOverrides({ presentation: { tagline: "x".repeat(81) } }),
    );
    expect(tagline.ok).toBe(false);

    const accent = validateManifest(
      withOverrides({ presentation: { accent: "#000000" } }),
    );
    expect(accent.ok).toBe(false);

    const category = validateManifest(
      withOverrides({ presentation: { categories: ["not-a-category"] } }),
    );
    expect(category.ok).toBe(false);
  });
});

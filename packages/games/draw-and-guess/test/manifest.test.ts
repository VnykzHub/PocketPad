/**
 * Manifest and content-pack acceptance (FR-10.3, G8, GAME-DG-DATA-01).
 *
 * The host validates the manifest before it lists a game and registers each
 * declared layout by id, so a broken path or an invalid presentation field
 * fails here rather than at launch.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { validateLayout, validateManifest } from "@lanpad/sdk";

const PACKAGE_ROOT = new URL("../", import.meta.url);
const BACKGROUND = "#101014";

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, PACKAGE_ROOT), "utf8"));
}

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const channel = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16) / 255;
    channels.push(channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  }
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Draw and Guess manifest", () => {
  test("[FR-10.3][G8][GAME-DG-DATA-01] the shipped manifest validates with console presentation", () => {
    const result = validateManifest(readJson("game.manifest.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const manifest = result.manifest;

    expect(manifest.name).toBe("Draw and Guess");
    expect(manifest.entry).toBe("index.js");
    expect(manifest.minPlayers).toBe(2);
    expect(manifest.maxPlayers).toBe(8);
    expect(manifest.needsGyro).toBe(false);
    expect(manifest.layouts).toHaveLength(3);
    expect(manifest.assetBudget.totalBytes).toBeGreaterThan(0);

    const presentation = manifest.presentation;
    expect(presentation).toBeDefined();
    if (presentation === undefined) throw new Error("manifest has no presentation");
    const tagline = presentation.tagline;
    expect(tagline).toBeDefined();
    if (tagline === undefined) throw new Error("manifest has no tagline");
    expect(tagline.length).toBeLessThanOrEqual(80);
    expect(tagline).toContain("Draw");

    const accent = presentation.accent;
    expect(accent).toBeDefined();
    if (accent === undefined) throw new Error("manifest has no accent");
    expect(accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(presentation.categories).toEqual(["party", "puzzle"]);
    expect(presentation.inputBadges).toEqual(["canvas", "text", "choice"]);

    // The accent is the results headline colour on the dark TV board.
    expect(contrastRatio(accent, BACKGROUND)).toBeGreaterThanOrEqual(4.5);
  });

  test("[FR-10.3][GAME-DG-DATA-01] invalid rosters, layout lists and presentation are rejected", () => {
    const base = readJson("game.manifest.json") as Record<string, unknown>;
    const presentation = base["presentation"];
    if (typeof presentation !== "object" || presentation === null || Array.isArray(presentation)) {
      throw new Error("manifest presentation is not an object");
    }
    const fields = presentation as Record<string, unknown>;

    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest({ ...base, minPlayers: 9 }).ok).toBe(false);
    expect(validateManifest({ ...base, layouts: [] }).ok).toBe(false);
    expect(
      validateManifest({
        ...base,
        presentation: { ...fields, tagline: "x".repeat(81) },
      }).ok,
    ).toBe(false);
    expect(
      validateManifest({
        ...base,
        presentation: { ...fields, accent: "blue" },
      }).ok,
    ).toBe(false);
  });

  test("[FR-8.4][G8][GAME-DG-DATA-01] every declared layout file exists and validates", () => {
    const result = validateManifest(readJson("game.manifest.json"));
    if (!result.ok) throw new Error(result.errors.join("\n"));

    const ids = new Set<string>();
    for (const relativePath of result.manifest.layouts) {
      expect(existsSync(new URL(relativePath, PACKAGE_ROOT)), relativePath).toBe(true);
      const layout = validateLayout(readJson(relativePath));
      expect(
        layout.ok,
        layout.ok ? relativePath : `${relativePath}: ${layout.errors.join("; ")}`,
      ).toBe(true);
      if (!layout.ok) continue;
      expect(layout.layout.orientation).toBe("portrait");
      ids.add(layout.layout.id);
    }

    expect(ids.size).toBe(result.manifest.layouts.length);
    expect([...ids].sort()).toEqual(["dg-drawer-v1", "dg-guesser-v1", "dg-results-v1"]);
  });
});

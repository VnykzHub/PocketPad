/**
 * Bomb Defusal manifest and folder contract (FR-10.3, ER-25-01..03).
 *
 * The manifest is the only registration surface: the runtime discovers
 * `packages/games/<slug>/game.manifest.json` and `src/game.ts` with globs, so
 * these tests check the shipped files rather than any root switch statement.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  validateLayout,
  validateManifest,
  type GameManifest,
} from "@lanpad/sdk";
import createGame from "../src/game.js";

const MANIFEST_PATH = "../game.manifest.json";
const SHIPPED_LAYOUTS = [
  "layouts/bd-defuser-v1.json",
  "layouts/bd-manual-v1.json",
] as const;

function readJson(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("fixture must be an object");
  }
  return value as Record<string, unknown>;
}

function shippedManifest(): GameManifest {
  const result = validateManifest(readJson(MANIFEST_PATH));
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.manifest;
}

describe("Bomb Defusal manifest", () => {
  test("[FR-10.3] the shipped manifest declares a two-to-eight player co-op puzzle", () => {
    const manifest = shippedManifest();
    expect(manifest.name).toBe("Bomb Defusal");
    expect(manifest.entry).toBe("index.js");
    expect(manifest.minPlayers).toBe(2);
    expect(manifest.maxPlayers).toBe(8);
    expect(manifest.needsGyro).toBe(false);
    expect(manifest.layouts).toEqual([...SHIPPED_LAYOUTS]);
    expect(manifest.assetBudget.initialBytes).toBeGreaterThan(0);
    expect(manifest.assetBudget.totalBytes).toBeGreaterThanOrEqual(
      manifest.assetBudget.initialBytes,
    );

    const presentation = manifest.presentation;
    expect(presentation).toBeDefined();
    if (presentation === undefined) return;
    const tagline = presentation.tagline ?? "";
    expect(tagline.length).toBeGreaterThanOrEqual(1);
    expect(tagline.length).toBeLessThanOrEqual(80);
    expect(presentation.accent).toMatch(/^#[0-9a-f]{6}$/i);
    expect(presentation.categories).toContain("puzzle");
    expect(presentation.categories).toContain("co-op");
    expect(presentation.categories?.length ?? 0).toBeLessThanOrEqual(3);
    expect(presentation.inputBadges).toContain("choice");
    expect(presentation.inputBadges).toContain("text");
    expect(presentation.inputBadges).toContain("haptics");
    expect(presentation.featured).toBe(false);
  });

  test("[G8] every layout the manifest declares is shipped and validates", () => {
    const manifest = shippedManifest();
    const ids = new Set<string>();
    for (const path of manifest.layouts) {
      expect(path.endsWith(".json")).toBe(true);
      expect(path.startsWith("/")).toBe(false);
      expect(path.includes("..")).toBe(false);
      expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);

      const result = validateLayout(readJson(`../${path}`));
      expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
      if (!result.ok) continue;
      expect(ids.has(result.layout.id), result.layout.id).toBe(false);
      ids.add(result.layout.id);
    }
    expect([...ids].sort()).toEqual(["bd-defuser-v1", "bd-manual-v1"]);
  });

  test("[ER-25-01] presentation is optional and the full form keeps its fields", () => {
    const base = asRecord(readJson(MANIFEST_PATH));

    const withoutPresentation: Record<string, unknown> = { ...base };
    delete withoutPresentation["presentation"];
    const optional = validateManifest(withoutPresentation);
    expect(optional.ok, optional.ok ? "" : optional.errors.join("\n")).toBe(true);
    if (optional.ok) {
      expect(optional.manifest.presentation).toBeUndefined();
    }

    const full = validateManifest(base);
    expect(full.ok, full.ok ? "" : full.errors.join("\n")).toBe(true);
    if (!full.ok) return;
    expect(full.manifest.presentation).toEqual(base["presentation"]);
  });

  test("[ER-25-02] invalid presentation fields fail with their JSON path", () => {
    const base = asRecord(readJson(MANIFEST_PATH));
    const presentation = asRecord(base["presentation"]);
    const withPresentation = (patch: Record<string, unknown>): unknown => ({
      ...base,
      presentation: { ...presentation, ...patch },
    });

    const cases: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ tagline: "" }, "presentation.tagline"],
      [{ tagline: "x".repeat(81) }, "presentation.tagline"],
      [{ accent: "#fff" }, "presentation.accent"],
      [{ accent: "#333333" }, "presentation.accent"],
      [{ categories: ["sandbox"] }, "presentation.categories[0]"],
      [{ categories: ["puzzle", "puzzle"] }, "presentation.categories[1]"],
      [{ inputBadges: ["camera"] }, "presentation.inputBadges[0]"],
      [{ featured: "yes" }, "presentation.featured"],
      [{ mood: "dark" }, "presentation.mood"],
    ];

    for (const [patch, path] of cases) {
      const result = validateManifest(withPresentation(patch));
      expect(result.ok, path).toBe(false);
      if (result.ok) continue;
      expect(result.errors.join("\n"), path).toContain(path);
    }
  });

  test("[ER-25-03] the game folder is discoverable without a root edit", () => {
    expect(existsSync(new URL(MANIFEST_PATH, import.meta.url))).toBe(true);
    expect(existsSync(new URL("../src/game.ts", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../tsconfig.json", import.meta.url))).toBe(true);
    expect(typeof createGame).toBe("function");

    const manifest = shippedManifest();
    for (const path of manifest.layouts) {
      expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);
    }
  });

  test("[FR-10.3] the validator rejects zero layouts and a ninth player", () => {
    const base = asRecord(readJson(MANIFEST_PATH));

    const emptyLayouts = validateManifest({ ...base, layouts: [] });
    expect(emptyLayouts.ok).toBe(false);
    if (!emptyLayouts.ok) {
      expect(emptyLayouts.errors.join("\n")).toContain("layouts");
    }

    const ninePlayers = validateManifest({ ...base, maxPlayers: 9 });
    expect(ninePlayers.ok).toBe(false);
    if (!ninePlayers.ok) {
      expect(ninePlayers.errors.join("\n")).toContain("maxPlayers");
    }

    const inverted = validateManifest({ ...base, minPlayers: 4, maxPlayers: 2 });
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) {
      expect(inverted.errors.join("\n")).toContain("maxPlayers");
    }
  });
});

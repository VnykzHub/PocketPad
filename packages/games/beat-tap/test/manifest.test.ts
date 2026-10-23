/**
 * Beat Tap manifest contract (GAME-BT-DATA-01; FR-10.3, G8).
 *
 * The tests read the shipped manifest as data, exactly as the runtime registry
 * does, so the folder stays the only registration step.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { validateManifest } from "../../../../sdk/src/index";

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

describe("Beat Tap manifest", () => {
  test("[FR-10.3] the shipped manifest validates with the documented boundary", () => {
    const result = validateManifest(shippedManifest);
    expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest).toMatchObject({
      schemaVersion: 1,
      name: "Beat Tap",
      description: "Tap the lanes in time with the beat.",
      entry: "index.js",
      layouts: [
        "layouts/bt-lanes-v1.json",
        "layouts/bt-duo-v1.json",
        "layouts/bt-solo-v1.json",
        "layouts/bt-dpad-v1.json",
        "layouts/bt-calibrate-v1.json",
      ],
      assetBudget: { initialBytes: 262144, totalBytes: 1048576 },
      minPlayers: 1,
      maxPlayers: 4,
      needsGyro: false,
      renderer: "canvas2d",
    });
  });

  test("[FR-10.3] the launcher presentation block is complete and valid", () => {
    const result = validateManifest(shippedManifest);
    expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest.presentation).toMatchObject({
      tagline: "Four lanes. One beat. Tap with the couch.",
      accent: "#c6f24e",
      categories: ["party", "action"],
      inputBadges: ["buttons", "dpad"],
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

  test("[FR-10.3] a manifest demanding a fifth player is rejected", () => {
    const result = validateManifest(withOverrides({ minPlayers: 5, maxPlayers: 4 }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain("maxPlayers: must be >= minPlayers");
    expect(asRecord(shippedManifest)["maxPlayers"]).toBe(4);
  });

  test("[FR-10.3] a manifest without any layout is rejected", () => {
    const result = validateManifest(withOverrides({ layouts: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors).toContain("layouts: must contain 1..16 entries (got 0)");
  });

  test("[FR-10.3] unknown presentation fields are rejected explicitly", () => {
    const presentation = asRecord(asRecord(shippedManifest)["presentation"]);
    const result = validateManifest(
      withOverrides({ presentation: { ...presentation, theme: "neon" } }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.join("\n")).toContain("presentation.theme: unknown field");
  });
});

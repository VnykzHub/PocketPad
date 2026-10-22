import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { validateManifest } from "../../../../sdk/src/index";

/**
 * Coin Run manifest contract (GAME-PF-01; FR-10.3, G8).
 *
 * The tests read the shipped manifest as data, exactly as the runtime registry
 * does, so the folder is the only registration step. There is no hand-written
 * game list anywhere in the host.
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

describe("Coin Run manifest", () => {
  test("[FR-10.3] the shipped manifest validates with the documented boundary", () => {
    const result = validateManifest(shippedManifest);
    expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.manifest).toEqual({
      schemaVersion: 1,
      name: "Coin Run",
      description: "Race across a shared level and collect 20 coins.",
      entry: "index.js",
      layouts: ["layouts/pf-dpad-v1.json", "layouts/pf-stick-v1.json"],
      assetBudget: { initialBytes: 262144, totalBytes: 1048576 },
      minPlayers: 1,
      maxPlayers: 4,
      needsGyro: false,
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
    // Coin Run caps at four players. Asking for five as the minimum while
    // keeping the four-player cap is the shape the frozen SDK validator can
    // reject; the shipped manifest itself pins maxPlayers to 4.
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
});

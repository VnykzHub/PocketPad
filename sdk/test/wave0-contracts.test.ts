// @req ER-22-01 — the fake world satisfies the world contract without a GPU.
// @req ER-22-08 — missing model assets fail with E_WORLD_ASSET.
// @req ER-22-09 — exceeding instance limits fails with E_WORLD_LIMIT.
// @req ER-22-10 — world dispose is idempotent.
// @req ER-23-01 — asset manifests validate, including ledger and budget failures.
// @req ER-25-01 — presentation is optional and fully-populated manifests validate.
// @req ER-25-02 — invalid presentation fields fail with their JSON path.
import { describe, expect, test } from "vitest";
import { validateAssetManifest } from "../src/assets.js";
import { validateManifest } from "../src/manifest.js";
import { createFakeWorld, type FakeActor } from "../src/testing.js";

const BASE_MANIFEST = {
  schemaVersion: 1,
  name: "Wave Zero",
  description: "Contract fixture.",
  entry: "index.js",
  layouts: ["layouts/default.json"],
  assetBudget: { initialBytes: 65536, totalBytes: 131072 },
  minPlayers: 1,
  maxPlayers: 8,
  needsGyro: false,
};

const LEDGER = new Set(["car.glb", "hit.ogg"]);
const BUDGET = { initialBytes: 65536, totalBytes: 131072 };

function validAssets(): unknown {
  return {
    schemaVersion: 1,
    groups: [
      { id: "boot", mode: "eager" },
      { id: "extra", mode: "lazy" },
    ],
    assets: [
      {
        id: "car",
        path: "assets/car.glb",
        kind: "mesh",
        bytes: 4096,
        group: "boot",
        ledger: "car.glb",
        clips: ["idle", "drive"],
      },
      {
        id: "hit",
        path: "assets/hit.ogg",
        kind: "audio",
        bytes: 1024,
        group: "boot",
        ledger: "hit.ogg",
      },
    ],
  };
}

describe("Wave 0 fake world", () => {
  test("[ER-22-01] spawns actors, plays clips and advances clip time", () => {
    const world = createFakeWorld({ models: ["car"] });
    const car = world.spawnModel("car") as FakeActor;
    car.setPosition(1, 2, 3);
    car.playClip("drive", { loop: true, speed: 2 });

    world.update(0.5);

    expect(car.currentClip).toBe("drive");
    expect(car.clipTime).toBeCloseTo(0.5, 10);
    expect(world.actors).toHaveLength(1);
    expect(world.calls.some((call) => call.method === "setPosition")).toBe(true);
  });

  test("[ER-22-01] the fake satisfies the whole surface without throwing", () => {
    const world = createFakeWorld();
    const actor = world.createPrimitive("box", { color: "#ffffff" });
    world.spawnInstances("anything", 4);
    world.setSun({ x: 0, y: -1, z: 0 }, "#ffffff", 1);
    world.setAmbient("#ffffff", 0.4);
    world.setFog("#000000", 10, 100);
    world.setSky("dusk");
    world.setShadowTier("low");
    world.setPost({ bloom: true, grade: "warm" });
    world.setCamera({ x: 0, y: 5, z: 10 }, { x: 0, y: 0, z: 0 }, 60);
    world.follow(actor, { distance: 6 });
    world.clearFollow();

    expect(world.camera?.fov).toBe(60);
    expect(world.capabilities.animation).toBe(true);
    expect(actor.alive).toBe(true);
  });

  test("[ER-22-08] a missing model throws E_WORLD_ASSET", () => {
    const world = createFakeWorld({ models: ["car"] });
    expect(() => world.spawnModel("tank")).toThrowError(
      expect.objectContaining({ code: "E_WORLD_ASSET" }),
    );
    expect(world.actors).toHaveLength(0);
  });

  test("[ER-22-09] exceeding the instance limit throws E_WORLD_LIMIT", () => {
    const world = createFakeWorld({
      capabilities: { maxInstances: 2 },
    });
    expect(() => world.spawnInstances("any", 3)).toThrowError(
      expect.objectContaining({ code: "E_WORLD_LIMIT" }),
    );
  });

  test("[ER-22-10] dispose is idempotent and blocks later updates", () => {
    const world = createFakeWorld();
    world.dispose();
    expect(() => world.dispose()).not.toThrow();
    expect(world.disposed).toBe(true);
    expect(() => world.update(1 / 60)).toThrowError(
      expect.objectContaining({ code: "E_WORLD_DISPOSED" }),
    );
  });
});

describe("Wave 0 asset manifest", () => {
  test("[ER-23-01] a valid manifest with ledger rows and budgets loads", () => {
    const result = validateAssetManifest(validAssets(), LEDGER, BUDGET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.assets).toHaveLength(2);
    expect(result.manifest.groups[0]?.mode).toBe("eager");
  });

  test("[ER-23-01] a missing ledger row fails with its JSON path", () => {
    const value = validAssets() as {
      assets: { ledger: string }[];
    };
    value.assets[1]!.ledger = "missing.ogg";
    const result = validateAssetManifest(value, LEDGER, BUDGET);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: "E_ASSET_LEDGER",
        path: "assets[1].ledger",
      }),
    );
  });

  test("[ER-23-01] duplicate ids, path escapes and over-budget sets fail", () => {
    const duplicate = validAssets() as {
      assets: { id: string }[];
    };
    duplicate.assets[1]!.id = "car";
    expect(validateAssetManifest(duplicate, LEDGER, BUDGET).ok).toBe(false);

    const escape = validAssets() as {
      assets: { path: string }[];
    };
    escape.assets[0]!.path = "../secrets/car.glb";
    expect(validateAssetManifest(escape, LEDGER, BUDGET).ok).toBe(false);

    const overBudget = validAssets() as {
      assets: { bytes: number }[];
    };
    overBudget.assets[0]!.bytes = 70_000;
    const result = validateAssetManifest(overBudget, LEDGER, BUDGET);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((error) => error.code === "E_ASSET_BUDGET")).toBe(
      true,
    );
  });
});

describe("Wave 0 presentation", () => {
  test("[ER-25-01] presentation is optional and a full object validates", () => {
    expect(validateManifest(BASE_MANIFEST).ok).toBe(true);
    const result = validateManifest({
      ...BASE_MANIFEST,
      presentation: {
        tagline: "Shrink the floor. Stay on.",
        accent: "#ff9f45",
        thumbnail: "art/sumo-thumb.webp",
        heroModel: "characters/bumper",
        categories: ["party", "arena"],
        inputBadges: ["stick", "haptics"],
        featured: true,
      },
    });
    expect(result.ok).toBe(true);
  });

  test("[ER-25-02] invalid presentation fields fail with their JSON path", () => {
    const cases: ReadonlyArray<{ field: string; value: unknown; path: string }> = [
      { field: "tagline", value: "", path: "presentation.tagline" },
      { field: "tagline", value: "x".repeat(81), path: "presentation.tagline" },
      { field: "accent", value: "#000000", path: "presentation.accent" },
      { field: "accent", value: "orange", path: "presentation.accent" },
      { field: "thumbnail", value: "Art/Thumb.webp", path: "presentation.thumbnail" },
      { field: "categories", value: ["party", "party"], path: "presentation.categories[1]" },
      { field: "categories", value: ["party", "arena", "puzzle", "racing"], path: "presentation.categories" },
      { field: "inputBadges", value: ["laser"], path: "presentation.inputBadges[0]" },
      { field: "featured", value: "yes", path: "presentation.featured" },
    ];
    for (const entry of cases) {
      const result = validateManifest({
        ...BASE_MANIFEST,
        presentation: { [entry.field]: entry.value },
      });
      expect(result.ok, `${entry.field}=${JSON.stringify(entry.value)}`).toBe(false);
      if (result.ok) continue;
      expect(result.errors).toContainEqual(
        expect.stringMatching(new RegExp(`^${entry.path.replace(/[.[\]]/g, "\\$&")}`)),
      );
    }

    const unknown = validateManifest({
      ...BASE_MANIFEST,
      presentation: { theme: "neon" },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.errors).toContain("presentation.theme: unknown field");
    }
  });
});

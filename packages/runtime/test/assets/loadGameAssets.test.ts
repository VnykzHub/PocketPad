import { describe, expect, test } from "vitest";
import type { GameManifest } from "@lanpad/sdk";
import { GameLoadError, loadGame } from "../../src/game/loadGame.js";
import {
  FIXTURE_MANIFEST_URL,
  fixtureText,
} from "./fixtureGame.js";

const fixtureModule = {
  default: (manifest: GameManifest) => ({
    manifest,
    init() {},
    simulate() {},
    render() {},
    dispose() {},
  }),
};

interface LoadOptions {
  readonly assetsText?: string | null;
  readonly ledgerText?: string | null;
  readonly manifest?: unknown;
  readonly importModule?: (url: string) => Promise<unknown>;
}

async function loadFixture(options: LoadOptions = {}) {
  return loadGame(FIXTURE_MANIFEST_URL, {
    fetchJson: async () =>
      options.manifest ??
      (JSON.parse(fixtureText("game.manifest.json")) as unknown),
    fetchText: async (url) => {
      if (url.endsWith("/assets.json")) {
        return options.assetsText !== undefined
          ? options.assetsText
          : fixtureText("assets.json");
      }
      if (url.endsWith("/LICENSES.csv")) {
        return options.ledgerText !== undefined
          ? options.ledgerText
          : fixtureText("LICENSES.csv");
      }
      return null;
    },
    importModule: options.importModule ?? (async () => fixtureModule),
  });
}

async function expectAssetsError(
  promise: Promise<unknown>,
): Promise<GameLoadError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GameLoadError);
    const loadError = error as GameLoadError;
    expect(loadError.code).toBe("assets");
    return loadError;
  }
  throw new Error("expected loadGame to reject");
}

interface RawAsset {
  id: string;
  path: string;
  kind: string;
  bytes: number;
  group: string;
  ledger: string;
  clips?: string[];
}

interface RawAssets {
  schemaVersion: number;
  groups: Array<{ id: string; mode: string }>;
  assets: RawAsset[];
}

function fixtureAssetsJson(): RawAssets {
  return JSON.parse(fixtureText("assets.json")) as RawAssets;
}

function fixtureManifestJson(): Record<string, unknown> {
  return JSON.parse(fixtureText("game.manifest.json")) as Record<
    string,
    unknown
  >;
}

describe("assets.json discovery and validation", () => {
  test("[ER-23-01] a valid assets.json next to the manifest loads and validates", async () => {
    const loaded = await loadFixture();

    expect(loaded.assets).not.toBeNull();
    expect(loaded.assets?.manifest.assets.map((asset) => asset.id)).toEqual([
      "triangle",
      "hit",
      "music",
      "arena-data",
      "arena-music",
    ]);
    expect(loaded.assets?.assetsUrl).toBe(
      "https://fixture.test/games/fixture/assets.json",
    );
    expect(loaded.assets?.ledgerUrl).toBe(
      "https://fixture.test/games/fixture/LICENSES.csv",
    );
    expect(loaded.assets?.baseUrl).toBe(
      "https://fixture.test/games/fixture/",
    );
    expect(loaded.assets?.budget).toEqual({
      initialBytes: 65536,
      totalBytes: 131072,
    });
    expect(loaded.game.manifest).toBe(loaded.manifest);
  });

  test("[ER-23-01] a game without assets.json still loads", async () => {
    const loaded = await loadFixture({ assetsText: null });
    expect(loaded.assets).toBeNull();
    expect(loaded.manifest.name).toBe("Fixture Game");
  });

  test("[ER-23-01] assets.json without LICENSES.csv rejects with E_ASSET_LEDGER", async () => {
    const error = await expectAssetsError(loadFixture({ ledgerText: null }));
    expect(error.details.join(" ")).toMatch(/E_ASSET_LEDGER/);
    expect(error.message).toMatch(/LICENSES\.csv/);
  });

  test("[ER-23-01] a missing ledger row rejects with its code and JSON path", async () => {
    const error = await expectAssetsError(
      loadFixture({
        ledgerText: "file,source\ntriangle.glb,synthetic\n",
      }),
    );
    expect(
      error.details.some((detail) =>
        /E_ASSET_LEDGER assets\[1\]\.ledger/.test(detail),
      ),
    ).toBe(true);
  });

  test("[ER-23-01] duplicate asset ids reject with E_ASSET_DUPLICATE", async () => {
    const assets = fixtureAssetsJson();
    assets.assets[1] = { ...assets.assets[0]! };
    const error = await expectAssetsError(
      loadFixture({ assetsText: JSON.stringify(assets) }),
    );
    expect(
      error.details.some((detail) =>
        /E_ASSET_DUPLICATE assets\[1\]\.id/.test(detail),
      ),
    ).toBe(true);
  });

  test("[ER-23-01] a path escape rejects with E_ASSET_PATH", async () => {
    const assets = fixtureAssetsJson();
    assets.assets[0]!.path = "../secret.glb";
    const error = await expectAssetsError(
      loadFixture({ assetsText: JSON.stringify(assets) }),
    );
    expect(
      error.details.some((detail) =>
        /E_ASSET_PATH assets\[0\]\.path/.test(detail),
      ),
    ).toBe(true);
  });

  test("[ER-23-01] an unknown asset kind rejects with E_ASSET_KIND", async () => {
    const assets = fixtureAssetsJson();
    assets.assets[3]!.kind = "video";
    const error = await expectAssetsError(
      loadFixture({ assetsText: JSON.stringify(assets) }),
    );
    expect(
      error.details.some((detail) =>
        /E_ASSET_KIND assets\[3\]\.kind/.test(detail),
      ),
    ).toBe(true);
  });

  test("[ER-23-01] eager bytes over initialBytes reject before the entry is imported", async () => {
    const manifest = fixtureManifestJson();
    manifest["assetBudget"] = { initialBytes: 1, totalBytes: 131072 };
    let imported = false;
    const error = await expectAssetsError(
      loadFixture({
        manifest,
        importModule: async () => {
          imported = true;
          return fixtureModule;
        },
      }),
    );
    expect(
      error.details.some((detail) => detail.includes("E_ASSET_BUDGET")),
    ).toBe(true);
    expect(imported).toBe(false);
  });

  test("[ER-23-01] total bytes over totalBytes reject with E_ASSET_BUDGET", async () => {
    const manifest = fixtureManifestJson();
    manifest["assetBudget"] = { initialBytes: 9000, totalBytes: 10000 };
    const error = await expectAssetsError(loadFixture({ manifest }));
    expect(
      error.details.some(
        (detail) =>
          detail.includes("E_ASSET_BUDGET") &&
          detail.includes("totalBytes"),
      ),
    ).toBe(true);
  });

  test("[ER-23-01] the 5 MiB boot cap wins even when the manifest allows more", async () => {
    const big = 5 * 1024 * 1024 + 1;
    const assets: RawAssets = {
      schemaVersion: 1,
      groups: [{ id: "boot", mode: "eager" }],
      assets: [
        {
          id: "big",
          path: "files/big.bin",
          kind: "json",
          bytes: big,
          group: "boot",
          ledger: "big.bin",
        },
      ],
    };
    const manifest = fixtureManifestJson();
    manifest["assetBudget"] = {
      initialBytes: big + 1,
      totalBytes: big + 1,
    };
    const error = await expectAssetsError(
      loadFixture({
        manifest,
        assetsText: JSON.stringify(assets),
        ledgerText: "file\nbig.bin\n",
      }),
    );
    expect(
      error.details.some((detail) => detail.includes("5 MiB boot cap")),
    ).toBe(true);
  });

  test("[ER-23-01] malformed assets.json JSON is an assets error, not a manifest error", async () => {
    const error = await expectAssetsError(
      loadFixture({ assetsText: "{not json" }),
    );
    expect(error.message).toMatch(/not valid JSON/);
  });
});

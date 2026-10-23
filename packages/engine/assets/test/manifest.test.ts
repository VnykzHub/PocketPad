/**
 * ER-06-01: manifest fixture validation.
 *
 * Every fixture in `test/fixtures` is exercised exactly as written. Invalid
 * fixtures assert both the `E_ASSET_*` code and the JSON path of the first
 * issue, so a validation regression cannot pass by rejecting for a new reason.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ASSET_CAPABILITIES,
  ASSET_CONTAINERS,
  ASSET_KINDS,
  ASSET_TEXTURE_FORMATS,
  MAX_MANIFEST_BYTES,
  requireAssetManifest,
  validateAssetManifest,
} from "../src/manifest.js";
import { AssetEngineError } from "../src/errors.js";
import { catchError } from "./helpers.js";

interface FixtureEnvelope {
  $fixture?: { code?: string; expect?: string };
}

function readFixture(relativePath: string): unknown {
  const text = readFileSync(
    new URL(`./fixtures/${relativePath}`, import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as unknown;
}

const VALID_OPTIONS = {
  gameId: "example-game",
  maxTotalBytes: 268_435_456,
  baseUrl: "http://localhost/games/example-game/",
} as const;

const INVALID_PATHS: Readonly<Record<string, string>> = {
  "format-version-unknown.json": "formatVersion",
  "missing-format-version.json": "formatVersion",
  "missing-budget.json": "budget",
  "missing-entry-field.json": "assets[0].url",
  "budget-initial-over-five-mib.json": "budget.initialBytes",
  "budget-initial-above-total.json": "budget.totalBytes",
  "budget-total-below-asset-sum.json": "budget.totalBytes",
  "path-parent-segment.json": "assets[0].url",
  "path-absolute.json": "assets[0].url",
  "path-scheme.json": "assets[0].url",
  "path-query-string.json": "assets[0].url",
  "path-encoded-dot.json": "assets[0].url",
  "unknown-kind.json": "assets[0].kind",
  "duplicate-id.json": "assets[1].id",
  "dependency-cycle.json": "assets[1].dependencies",
  "url-extension-mismatch.json": "assets[0].url",
};

describe("ER-06-01 manifest fixtures", () => {
  test("ER-06-01 accepts the complete valid fixture", () => {
    const result = validateAssetManifest(
      readFixture("manifest-valid.json"),
      VALID_OPTIONS,
    );
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.manifest).not.toBeNull();
    const manifest = result.manifest;
    if (manifest === null) return;
    expect(manifest.id).toBe("example-game");
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.budget).toEqual({
      initialBytes: 561152,
      totalBytes: 1415168,
    });
    expect(manifest.assets).toHaveLength(7);
    expect(manifest.assets.map((asset) => asset.kind)).toEqual([
      "json",
      "texture",
      "texture",
      "mesh",
      "material",
      "audio",
      "font",
    ]);
    const atlas = manifest.assets[1];
    expect(atlas?.variants).toHaveLength(1);
    expect(atlas?.variants?.[0]?.requires).toEqual(["compressed-s3tc"]);
    expect(manifest.assets[6]?.meta).toEqual({ family: "Inter", weight: 400 });
  });

  test("ER-06-01 rejects a game id that differs from options.gameId", () => {
    const result = validateAssetManifest(readFixture("manifest-valid.json"), {
      ...VALID_OPTIONS,
      gameId: "other-game",
    });
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("E_ASSET_FORMAT");
    expect(result.issues[0]?.path).toBe("id");
  });

  for (const [fileName, expectedPath] of Object.entries(INVALID_PATHS)) {
    test(`ER-06-01 rejects ${fileName} at ${expectedPath}`, () => {
      const fixture = readFixture(`manifest-invalid/${fileName}`);
      const envelope = fixture as FixtureEnvelope;
      const expectedCode = envelope.$fixture?.code;
      expect(expectedCode).toMatch(/^E_ASSET_/);
      const result = validateAssetManifest(fixture, VALID_OPTIONS);
      expect(result.ok).toBe(false);
      expect(result.manifest).toBeNull();
      expect(result.issues.length).toBeGreaterThan(0);
      const first = result.issues[0];
      expect(first?.code).toBe(expectedCode);
      expect(first?.path).toBe(expectedPath);
    });
  }

  test("ER-06-01 requireAssetManifest throws the first issue with its path", () => {
    const fixture = readFixture("manifest-invalid/path-parent-segment.json");
    const error = catchError(() =>
      requireAssetManifest(fixture, VALID_OPTIONS),
    );
    expect(error).toBeInstanceOf(AssetEngineError);
    const assetError = error as AssetEngineError;
    expect(assetError.code).toBe("E_ASSET_FORMAT");
    expect(assetError.message.startsWith("assets[0].url: ")).toBe(true);
    expect(assetError.layer).toBe("assets");
  });

  test("ER-06-01 requireAssetManifest returns the parsed manifest", () => {
    const manifest = requireAssetManifest(
      readFixture("manifest-valid.json"),
      VALID_OPTIONS,
    );
    expect(manifest.assets[0]?.id).toBe("data/config");
    expect(manifest.assets[0]?.url).toBe("data/config.json");
  });

  test("ER-06-01 format matrix agrees with exported contract sets", () => {
    const matrix = readFixture("format-matrix.json") as {
      readonly measured?: unknown;
      readonly versions?: Readonly<Record<string, number>>;
      readonly manifest?: {
        readonly maxBytes?: number;
        readonly maxAssets?: number;
      };
      readonly categories?: {
        readonly texture?: {
          readonly containers?: {
            readonly ktx2?: {
              readonly formats?: readonly {
                readonly vkFormat?: number;
                readonly requires?: readonly string[];
              }[];
            };
          };
        };
      };
    };
    expect(matrix.measured).toBe(false);
    expect(matrix.versions).toEqual({
      ASSET_MANIFEST_VERSION: 1,
      MESH_FORMAT_VERSION: 1,
      TEXTURE_ASSET_FORMAT_VERSION: 1,
      MATERIAL_FORMAT_VERSION: 1,
      ASSET_CACHE_VERSION: 1,
    });
    expect(matrix.manifest?.maxBytes).toBe(MAX_MANIFEST_BYTES);
    expect(matrix.manifest?.maxAssets).toBe(4096);
    expect(ASSET_KINDS).toEqual([
      "mesh",
      "texture",
      "material",
      "audio",
      "font",
      "json",
      "scene",
      "animation",
    ]);
    expect(ASSET_CONTAINERS).toContain("glb");
    expect(ASSET_TEXTURE_FORMATS).toContain("bc7-rgba-unorm");
    expect(ASSET_CAPABILITIES).toContain("compressed-s3tc");
    const ktxFormats = matrix.categories?.texture?.containers?.ktx2?.formats;
    expect(ktxFormats).toBeDefined();
    for (const format of ktxFormats ?? []) {
      expect(typeof format.vkFormat).toBe("number");
      for (const capability of format.requires ?? []) {
        expect(ASSET_CAPABILITIES).toContain(capability);
      }
    }
  });
});

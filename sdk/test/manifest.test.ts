import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { validateManifest } from "../src/index";

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "Sumo Bumpers",
    entry: "games/sumo-bumpers/index.js",
    layouts: ["layouts/default.json", "layouts/alternate.json"],
    assetBudget: { initialBytes: 250_000, totalBytes: 2_000_000 },
    minPlayers: 2,
    maxPlayers: 8,
    needsGyro: false,
    chunkConfig: { chunkSize: 32, loadRadius: 2, unloadRadius: 4, lodTiers: [0, 1, 2] },
    ...overrides,
  };
}

function errorsFor(value: unknown): string[] {
  const result = validateManifest(value);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

interface SchemaNode {
  type?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  const?: unknown;
  enum?: unknown[];
  pattern?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
}

interface ManifestSchema extends SchemaNode {
  $schema?: string;
}

function readSchema(): ManifestSchema {
  const text = readFileSync(
    new URL("../schema/game-manifest.schema.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as ManifestSchema;
}

describe("validateManifest (D0-SDK-01)", () => {
  test("[FR-10.3] accepts a complete manifest unchanged", () => {
    const manifest = validManifest();
    expect(validateManifest(manifest)).toEqual({ ok: true, manifest });
  });

  test("[FR-10.3] accepts a manifest without optional schemaVersion and chunkConfig", () => {
    const manifest = validManifest();
    delete manifest.schemaVersion;
    delete manifest.chunkConfig;
    expect(validateManifest(manifest).ok).toBe(true);
  });

  test.each([null, [], "manifest", 42])(
    "[FR-10.3] rejects a non-object manifest (%s)",
    (value) => {
      expect(errorsFor(value)).toEqual(["manifest: must be an object"]);
    },
  );

  test("[FR-10.3] reports every missing required field in one pass", () => {
    const errors = errorsFor({});
    expect(errors).toHaveLength(7);
    for (const field of [
      "name",
      "entry",
      "layouts",
      "assetBudget",
      "minPlayers",
      "maxPlayers",
      "needsGyro",
    ]) {
      expect(errors).toContain(`${field}: required`);
    }
  });

  test("[FR-10.3] rejects a schemaVersion other than 1", () => {
    expect(errorsFor(validManifest({ schemaVersion: 2 }))).toEqual([
      "schemaVersion: must be 1 when present",
    ]);
  });

  test.each(["", "x".repeat(65)])(
    "[FR-10.3] rejects a name outside 1..64 characters (%j)",
    (name) => {
      expect(
        errorsFor(validManifest({ name })).some((error) => error.startsWith("name:")),
      ).toBe(true);
    },
  );

  test("[FR-10.3] accepts a 64-character name", () => {
    expect(validateManifest(validManifest({ name: "x".repeat(64) })).ok).toBe(true);
  });

  test("[FR-10.3] rejects a non-string name", () => {
    expect(errorsFor(validManifest({ name: 7 }))).toContain("name: must be a string");
  });

  test.each(["../evil.js", "dist/../evil.js", "dist\\..\\evil.js"])(
    "[FR-10.3] rejects parent traversal in entry (%s)",
    (entry) => {
      const errors = errorsFor(validManifest({ entry }));
      expect(
        errors.some((error) => error.startsWith("entry:") && error.includes("..")),
      ).toBe(true);
    },
  );

  test.each(["/evil.js", "\\evil.js", "C:\\evil.js"])(
    "[FR-10.3] rejects absolute entry paths (%s)",
    (entry) => {
      expect(errorsFor(validManifest({ entry }))).toContain("entry: must be a relative path");
    },
  );

  test("[FR-10.3] rejects an empty layouts array", () => {
    expect(errorsFor(validManifest({ layouts: [] }))).toContain(
      "layouts: must contain 1..16 entries (got 0)",
    );
  });

  test("[FR-10.3] rejects more than 16 layouts", () => {
    const layouts = Array.from({ length: 17 }, (_, index) => `layouts/${index}.json`);
    expect(errorsFor(validManifest({ layouts }))).toContain(
      "layouts: must contain 1..16 entries (got 17)",
    );
  });

  test("[FR-10.3] rejects non-string and escaping layout paths", () => {
    const errors = errorsFor(
      validManifest({ layouts: ["layouts/ok.json", "../escape.json", 7] }),
    );
    expect(errors).toContain('layouts[1]: must not contain ".." path segments');
    expect(errors).toContain("layouts[2]: must be a string");
  });

  test.each([
    ["zero initial", { initialBytes: 0, totalBytes: 100 }],
    ["negative total", { initialBytes: 10, totalBytes: -1 }],
    ["non-number initial", { initialBytes: "10", totalBytes: 100 }],
    ["initial over total", { initialBytes: 200, totalBytes: 100 }],
  ] as Array<[string, Record<string, unknown>]>)(
    "[FR-10.3] rejects an invalid asset budget: %s",
    (_label, assetBudget) => {
      expect(
        errorsFor(validManifest({ assetBudget })).some((error) =>
          error.startsWith("assetBudget"),
        ),
      ).toBe(true);
    },
  );

  test("[FR-10.3] requires both asset budget fields", () => {
    const errors = errorsFor(validManifest({ assetBudget: {} }));
    expect(errors).toContain("assetBudget.initialBytes: required");
    expect(errors).toContain("assetBudget.totalBytes: required");
  });

  test.each([
    ["maxPlayers above 8", { maxPlayers: 9 }],
    ["minPlayers below 1", { minPlayers: 0 }],
    ["minPlayers above maxPlayers", { minPlayers: 5, maxPlayers: 3 }],
    ["non-integer maxPlayers", { maxPlayers: 4.5 }],
  ] as Array<[string, Record<string, unknown>]>)(
    "[FR-10.3] rejects invalid player bounds: %s",
    (_label, overrides) => {
      const errors = errorsFor(validManifest(overrides));
      expect(
        errors.some(
          (error) => error.startsWith("minPlayers") || error.startsWith("maxPlayers"),
        ),
      ).toBe(true);
    },
  );

  test("[FR-10.3] rejects a non-boolean needsGyro", () => {
    expect(errorsFor(validManifest({ needsGyro: "yes" }))).toContain(
      "needsGyro: must be a boolean",
    );
  });

  test("[FR-10.3] accepts an absent renderer as the canvas2d default", () => {
    const manifest = validManifest();
    expect(validateManifest(manifest)).toEqual({ ok: true, manifest });
    expect("renderer" in manifest).toBe(false);
  });

  test.each(["canvas2d", "engine"] as const)(
    "[FR-10.3] accepts renderer %s",
    (renderer) => {
      expect(validateManifest(validManifest({ renderer })).ok).toBe(true);
    },
  );

  test.each(["webgpu", "Canvas2D", "", 7, null])(
    "[FR-10.3] rejects an invalid renderer (%j)",
    (renderer) => {
      expect(errorsFor(validManifest({ renderer }))).toEqual([
        'renderer: must be "canvas2d" or "engine"',
      ]);
    },
  );

  test("[FR-10.3] rejects chunkConfig with fewer than three LOD tiers", () => {
    const errors = errorsFor(
      validManifest({
        chunkConfig: { chunkSize: 32, loadRadius: 2, unloadRadius: 4, lodTiers: [0, 1] },
      }),
    );
    expect(errors).toContain("chunkConfig.lodTiers: must contain at least 3 LOD tiers (got 2)");
  });

  test("[FR-10.3] accepts chunkConfig with exactly three LOD tiers", () => {
    expect(
      validateManifest(
        validManifest({
          chunkConfig: { chunkSize: 8, loadRadius: 0, unloadRadius: 1, lodTiers: [0, 1, 2] },
        }),
      ).ok,
    ).toBe(true);
  });

  test("[FR-10.3] rejects malformed chunkConfig fields", () => {
    const errors = errorsFor(
      validManifest({ chunkConfig: { chunkSize: 0, lodTiers: [0, 1, 2] } }),
    );
    expect(errors).toContain("chunkConfig.chunkSize: must be a positive number");
    expect(errors).toContain("chunkConfig.loadRadius: required");
    expect(errors).toContain("chunkConfig.unloadRadius: required");
  });

  test("[G8] returns every manifest error in one pass", () => {
    const errors = errorsFor({
      schemaVersion: 2,
      name: "",
      entry: "../evil.js",
      layouts: [],
      assetBudget: { initialBytes: 500, totalBytes: 100 },
      minPlayers: 5,
      maxPlayers: 3,
      needsGyro: "yes",
      chunkConfig: { chunkSize: 0, loadRadius: -1, unloadRadius: -1, lodTiers: [0, 1] },
    });

    expect(errors.length).toBeGreaterThanOrEqual(9);
    for (const field of [
      "schemaVersion",
      "name",
      "entry",
      "layouts",
      "assetBudget",
      "maxPlayers",
      "needsGyro",
      "chunkConfig.chunkSize",
      "chunkConfig.lodTiers",
    ]) {
      expect(errors.some((error) => error.startsWith(field))).toBe(true);
    }
  });

  test("[G8] JSON schema mirrors the manifest field contract", () => {
    const schema = readSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(new Set(schema.required)).toEqual(
      new Set(["name", "entry", "layouts", "assetBudget", "minPlayers", "maxPlayers", "needsGyro"]),
    );
    expect(schema.properties?.schemaVersion?.const).toBe(1);
    expect(schema.properties?.name).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 64,
    });
    expect(schema.properties?.layouts).toMatchObject({ minItems: 1, maxItems: 16 });
    expect(schema.properties?.assetBudget?.properties?.initialBytes).toMatchObject({
      type: "number",
      exclusiveMinimum: 0,
    });
    expect(schema.properties?.assetBudget?.properties?.totalBytes).toMatchObject({
      type: "number",
      exclusiveMinimum: 0,
    });
    expect(schema.properties?.minPlayers).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 8,
    });
    expect(schema.properties?.maxPlayers).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 8,
    });
    expect(schema.properties?.needsGyro?.type).toBe("boolean");
    expect(schema.properties?.renderer).toMatchObject({
      type: "string",
      enum: ["canvas2d", "engine"],
    });
    expect(schema.properties?.chunkConfig?.properties?.lodTiers).toMatchObject({
      type: "array",
      minItems: 3,
    });
  });

  test("[G8] every schema-required field is rejected by the validator when missing", () => {
    const schema = readSchema();
    for (const field of schema.required ?? []) {
      const manifest = validManifest();
      delete manifest[field];
      expect(validateManifest(manifest).ok).toBe(false);
    }
  });

  test("[G8] schema path patterns reject the same unsafe entries as the validator", () => {
    const schema = readSchema();
    const entryPattern = schema.properties?.entry?.pattern;
    const layoutPattern = schema.properties?.layouts?.items?.pattern;
    expect(entryPattern).toBeTypeOf("string");
    expect(layoutPattern).toBeTypeOf("string");

    const unsafePaths = [
      "../evil.js",
      "dist/../evil.js",
      "dist\\..\\evil.js",
      "/evil.js",
      "\\evil.js",
      "C:\\evil.js",
    ];
    for (const unsafe of unsafePaths) {
      expect(new RegExp(entryPattern as string).test(unsafe)).toBe(false);
      expect(new RegExp(layoutPattern as string).test(unsafe)).toBe(false);
      expect(validateManifest(validManifest({ entry: unsafe })).ok).toBe(false);
    }
    expect(new RegExp(entryPattern as string).test("games/sumo/index.js")).toBe(true);
  });

  test("[G8] SDK has zero runtime dependencies", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

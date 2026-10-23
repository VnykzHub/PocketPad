/**
 * ER-05-11: package layering (05 §3.1).
 *
 * The renderer may depend on `@lanpad/engine-core` and nothing else, may not
 * import the host app, and the Canvas2D entry must not pull the WebGL2 module
 * graph. These checks read the real package sources.
 */

import { readFileSync, readdirSync } from "node:fs";
import { extname } from "node:path";
import { describe, expect, test } from "vitest";

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly exports?: Readonly<Record<string, unknown>>;
}

const SRC_ROOT = new URL("../src/", import.meta.url);
const MANIFEST = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

function sourceFiles(directory: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...sourceFiles(child));
    else if (extname(entry.name) === ".ts") files.push(child);
  }
  return files;
}

function sourceOf(file: URL): string {
  return readFileSync(file, "utf8");
}

/** Every bare or relative specifier that appears in an import or re-export. */
function importSpecifiers(source: string): string[] {
  const pattern = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  const specifiers: string[] = [];
  let match = pattern.exec(source);
  while (match !== null) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
    match = pattern.exec(source);
  }
  return specifiers;
}

const FILES = sourceFiles(SRC_ROOT);

describe("[ER-05-11] package dependencies", () => {
  test("[ER-05-11] the only runtime dependency is the frozen core package", () => {
    expect(MANIFEST.dependencies).toEqual({ "@lanpad/engine-core": "0.1.0" });
    expect(MANIFEST.devDependencies).toBeUndefined();
    expect(MANIFEST.peerDependencies).toBeUndefined();
  });

  test("[ER-05-11] the package exposes exactly the 3D and 2D entries", () => {
    expect(Object.keys(MANIFEST.exports ?? {}).sort()).toEqual([".", "./canvas2d"]);
  });

  test("[ER-05-11] source files import only relative modules or engine-core", () => {
    expect(FILES.length).toBeGreaterThan(0);
    for (const file of FILES) {
      for (const specifier of importSpecifiers(sourceOf(file))) {
        const allowed = specifier.startsWith(".") || specifier === "@lanpad/engine-core";
        expect(
          allowed,
          `${file.pathname} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  test("[ER-05-11] no source file reaches the host, runtime, controller or SDK", () => {
    for (const file of FILES) {
      const source = sourceOf(file);
      expect(source).not.toContain("@lanpad/runtime");
      expect(source).not.toContain("@lanpad/controller");
      expect(source).not.toContain("@lanpad/sdk");
      expect(source).not.toContain("@lanpad/broker");
      for (const specifier of importSpecifiers(source)) {
        expect(specifier).not.toContain("packages/runtime");
        expect(specifier).not.toContain("packages/controller");
        expect(specifier).not.toContain("../../");
      }
    }
  });
});

describe("[ER-05-11] Canvas2D entry isolation", () => {
  const ENTRY = new URL("canvas2d.ts", SRC_ROOT);
  const DEVICE = new URL("canvas2d/device.ts", SRC_ROOT);
  const DRAW = new URL("canvas2d/draw2d.ts", SRC_ROOT);
  const CONTRACT = new URL("contracts/canvas2d.d.ts", SRC_ROOT);

  test("[ER-05-11] the entry re-exports only the contract, factory and background", () => {
    expect(importSpecifiers(sourceOf(ENTRY)).sort()).toEqual([
      "./canvas2d/device.js",
      "./canvas2d/draw2d.js",
      "./contracts/canvas2d.js",
    ]);
  });

  test("[ER-05-11] the Canvas2D device imports no WebGL2 module", () => {
    const allowed = new Set([
      "@lanpad/engine-core",
      "../contracts/canvas2d.js",
      "../errors.js",
      "../stats.js",
      "./draw2d.js",
    ]);
    const specifiers = importSpecifiers(sourceOf(DEVICE));
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(allowed.has(specifier), `unexpected import ${specifier}`).toBe(true);
    }
  });

  test("[ER-05-11] the Canvas2D drawer imports nothing", () => {
    expect(importSpecifiers(sourceOf(DRAW))).toEqual([]);
  });

  test("[ER-05-11] the Canvas2D contract imports only engine-core", () => {
    expect(importSpecifiers(sourceOf(CONTRACT)).sort()).toEqual(["@lanpad/engine-core"]);
  });

  test("[ER-05-11] no Canvas2D source names a 3D-only module or context", () => {
    const forbidden = [
      "getContext(\"webgl2\")",
      "WebGL2RenderingContext",
      "pipelineCache.js",
      "texture.js",
      "mesh.js",
      "material.js",
      "state.js",
      "buffer.js",
      "../device.js",
      "../frame.js",
      "../capability.js",
      "../classify.js",
      "../shaders",
    ];
    for (const file of [ENTRY, DEVICE, DRAW, CONTRACT]) {
      const source = sourceOf(file);
      for (const marker of forbidden) {
        expect(source, `${file.pathname} contains ${marker}`).not.toContain(marker);
      }
    }
  });

  test("[ER-05-11] importing the 2D entry exposes only the 2D surface", async () => {
    const entry = await import("../src/canvas2d.js");
    expect(Object.keys(entry).sort()).toEqual([
      "CANVAS2D_BACKGROUND",
      "createCanvas2DDevice",
    ]);
    expect(entry.CANVAS2D_BACKGROUND).toBe("#0b0f14");
    expect(typeof entry.createCanvas2DDevice).toBe("function");
    expect("createWebGL2Device" in entry).toBe(false);
    expect("probeWebGL2" in entry).toBe(false);
  });

  test("[ER-05-11] the package root is the 3D entry, not the 2D one", () => {
    const exportsRecord = MANIFEST.exports?.["."] as
      | { readonly import?: string; readonly types?: string }
      | undefined;
    expect(exportsRecord?.import).toBe("./dist/index.js");
    expect(exportsRecord?.types).toBe("./dist/index.d.ts");
    const twoD = MANIFEST.exports?.["./canvas2d"] as
      | { readonly import?: string; readonly types?: string }
      | undefined;
    expect(twoD?.import).toBe("./dist/canvas2d.js");
    expect(twoD?.types).toBe("./dist/canvas2d.d.ts");
  });
});

/**
 * ER-00-02 — engine package graph boundary test.
 *
 * The dev server may not edit `eslint.config.js` (config-protection hook), so
 * the forbidden-edge rule from 00 §5.2 D1–D3 is enforced here instead. This
 * scans real source text: type-only imports count, because a type dependency is
 * still a package dependency even when the runtime edge is erased.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const ENGINE_ROOT = join(ROOT, "packages", "engine");

/** Host packages no engine package may import (00 §5.2 D3). */
const FORBIDDEN_HOST = [
  "@lanpad/protocol",
  "@lanpad/sdk",
  "@lanpad/runtime",
  "@lanpad/controller",
  "@lanpad/broker",
  "@lanpad/dev-server",
  "@lanpad/relay",
];

/** Allowed engine-to-engine edges (00 §5.2 D2). Unlisted targets are denied. */
const ALLOWED_ENGINE_EDGES: Readonly<Record<string, readonly string[]>> = {
  "@lanpad/engine-core": [],
  "@lanpad/engine-renderer-webgpu": ["@lanpad/engine-core"],
  "@lanpad/engine-renderer-webgl2": ["@lanpad/engine-core"],
  "@lanpad/engine-assets": ["@lanpad/engine-core"],
  "@lanpad/engine-input": ["@lanpad/engine-core"],
  "@lanpad/engine-physics": ["@lanpad/engine-core"],
  "@lanpad/engine-audio": ["@lanpad/engine-core"],
  "@lanpad/engine-animation": ["@lanpad/engine-core", "@lanpad/engine-assets"],
  "@lanpad/engine-ai": ["@lanpad/engine-core", "@lanpad/engine-physics"],
  "@lanpad/engine-streaming": ["@lanpad/engine-core", "@lanpad/engine-assets"],
  "@lanpad/engine-ui": ["@lanpad/engine-core", "@lanpad/engine-assets"],
  "@lanpad/engine-tooling": ["@lanpad/engine-core", "@lanpad/sdk"],
};

interface EnginePackage {
  /** Directory name under packages/engine. */
  dir: string;
  /** package.json name. */
  name: string;
  /** Absolute package root. */
  root: string;
}

function listEnginePackages(): EnginePackage[] {
  if (!existsSync(ENGINE_ROOT)) return [];
  return readdirSync(ENGINE_ROOT)
    .filter((entry) => statSync(join(ENGINE_ROOT, entry)).isDirectory())
    .map((entry) => ({ dir: entry, root: join(ENGINE_ROOT, entry) }))
    .filter((entry) => existsSync(join(entry.root, "package.json")))
    .map((entry) => {
      const manifest = JSON.parse(readFileSync(join(entry.root, "package.json"), "utf8")) as {
        name?: unknown;
      };
      return {
        dir: entry.dir,
        root: entry.root,
        name: typeof manifest.name === "string" ? manifest.name : "",
      };
    })
    .filter((entry) => entry.name.startsWith("@lanpad/engine-"));
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test" && entry.name !== "dist" && entry.name !== "node_modules") {
          walk(path);
        }
        continue;
      }
      if (/\.(?:d\.)?[cm]?[jt]sx?$/.test(entry.name)) out.push(path);
    }
  };
  const src = join(root, "src");
  if (existsSync(src)) walk(src);
  return out;
}

/** Removes block and line comments so example imports in docs do not count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

interface Violation {
  file: string;
  specifier: string;
  reason: string;
}

describe("engine package boundaries", () => {
  test("[ER-00-02] engine packages have no forbidden dependency edge", () => {
    const packages = listEnginePackages();
    expect(packages.length).toBeGreaterThan(0);

    const violations: Violation[] = [];
    for (const pkg of packages) {
      const allowed = ALLOWED_ENGINE_EDGES[pkg.name] ?? ["@lanpad/engine-core"];
      for (const file of sourceFiles(pkg.root)) {
        const text = stripComments(readFileSync(file, "utf8"));
        for (const match of text.matchAll(IMPORT_PATTERN)) {
          const specifier = match[1] ?? "";
          const shown = relative(ROOT, file).split(sep).join("/");

          if (FORBIDDEN_HOST.some((forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`))) {
            violations.push({ file: shown, specifier, reason: "host/controller/server/SDK import (D3)" });
            continue;
          }
          if (specifier.startsWith("@lanpad/")) {
            if (!allowed.includes(specifier)) {
              violations.push({ file: shown, specifier, reason: `edge not allowed by D2 (allowed: ${allowed.join(", ") || "none"})` });
            }
            continue;
          }
          if (specifier.startsWith(".")) {
            const target = resolve(dirname(file), specifier);
            const insidePackage = target === pkg.root || target.startsWith(`${pkg.root}${sep}`);
            if (!insidePackage) {
              violations.push({ file: shown, specifier, reason: "relative import escapes its own engine package" });
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("[ER-00-02] engine-core declares no runtime dependency", () => {
    const core = listEnginePackages().find((pkg) => pkg.name === "@lanpad/engine-core");
    expect(core).toBeDefined();
    const manifest = JSON.parse(readFileSync(join(core!.root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});

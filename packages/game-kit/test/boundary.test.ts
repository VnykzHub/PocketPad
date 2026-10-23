import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(PACKAGE_ROOT, "src");

const SOURCE_FILES = readdirSync(SRC_DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

function source(name: string): string {
  return readFileSync(join(SRC_DIR, name), "utf8");
}

/** Comments may name a forbidden API to explain why it is absent. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;

function importSpecifiers(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

const FORBIDDEN_APIS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Math\.random/, "Math.random"],
  [/\bsetTimeout\s*\(/, "setTimeout"],
  [/\bsetInterval\s*\(/, "setInterval"],
  [/\brequestAnimationFrame\s*\(/, "requestAnimationFrame"],
  [/\bfetch\s*\(/, "fetch"],
  [/\bwindow\b/, "window"],
  [/\bdocument\b/, "document"],
  [/\blocalStorage\b/, "localStorage"],
  [/\bDate\.now\s*\(/, "Date.now"],
  [/\bperformance\.now\s*\(/, "performance.now"],
];

describe("package boundary [ER-24-07]", () => {
  it("finds every source module", () => {
    expect(SOURCE_FILES).toContain("index.ts");
    expect(SOURCE_FILES.length).toBeGreaterThanOrEqual(8);
  });

  it("imports only @lanpad/sdk and local modules", () => {
    for (const file of SOURCE_FILES) {
      for (const specifier of importSpecifiers(source(file))) {
        const allowed =
          specifier === "@lanpad/sdk" ||
          specifier.startsWith("./") ||
          specifier.startsWith("../");
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
        expect(specifier).not.toBe("@lanpad/sdk/testing");
      }
    }
  });

  it("does not call DOM, timer, network or random APIs", () => {
    for (const file of SOURCE_FILES) {
      const text = codeOnly(source(file));
      for (const [pattern, name] of FORBIDDEN_APIS) {
        expect(pattern.test(text), `${file} uses ${name}`).toBe(false);
      }
    }
  });

  it("keeps every source file under 300 lines", () => {
    for (const file of SOURCE_FILES) {
      const lines = source(file).split("\n").length;
      expect(lines, `${file} has ${lines} lines`).toBeLessThanOrEqual(300);
    }
  });

  it("exports every public module from the single entry point", () => {
    const index = source("index.ts");
    for (const file of SOURCE_FILES) {
      if (file === "index.ts" || file === "slots.ts") {
        continue;
      }
      const moduleName = file.slice(0, -3);
      expect(index).toContain(`./${moduleName}.js`);
    }
    expect(index).not.toContain("./slots.js");
  });

  it("declares only @lanpad/sdk as a runtime dependency", () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      type?: string;
      sideEffects?: boolean;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@lanpad/sdk"]);
    expect(pkg.devDependencies ?? {}).toEqual({});
    expect(pkg.type).toBe("module");
    expect(pkg.sideEffects).toBe(false);
  });

  it("keeps the sample fixture inside the same import boundary", () => {
    const fixture = readFileSync(
      join(PACKAGE_ROOT, "test", "fixtures", "kit-sample.ts"),
      "utf8",
    );
    for (const specifier of importSpecifiers(fixture)) {
      const allowed =
        specifier === "@lanpad/sdk" ||
        specifier.startsWith("./") ||
        specifier.startsWith("../");
      expect(allowed, `fixture imports ${specifier}`).toBe(true);
    }
  });
});

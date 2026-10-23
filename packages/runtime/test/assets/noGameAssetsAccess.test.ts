import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Spec 23: the runtime must never fall back to the legacy `Game-assets/`
 * folder (or any remote URL). This scan guards the source tree; the comment
 * line in `GameAssetLibrary.ts` documents the rule and is allowed, any code
 * reference is an offender.
 */
const SRC_DIR = fileURLToPath(new URL("../../src/", import.meta.url));

interface Offender {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function walkTypeScript(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...walkTypeScript(join(dir, entry.name), relativePath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(relativePath);
    }
  }
  return files;
}

function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("*") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*")
  );
}

function findGameAssetsReferences(file: string): Offender[] {
  const source = readFileSync(join(SRC_DIR, file), "utf8");
  const offenders: Offender[] = [];
  source.split(/\r?\n/).forEach((text, index) => {
    if (!/game-assets/i.test(text)) return;
    if (isCommentLine(text.trim())) return;
    offenders.push({ file, line: index + 1, text: text.trim() });
  });
  return offenders;
}

describe("no legacy asset fallback", () => {
  test("[ER-23-01] runtime sources never reference Game-assets/ outside comments", () => {
    const files = walkTypeScript(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("assets/GameAssetLibrary.ts");

    const offenders = files.flatMap(findGameAssetsReferences);
    expect(offenders).toEqual([]);
  });
});

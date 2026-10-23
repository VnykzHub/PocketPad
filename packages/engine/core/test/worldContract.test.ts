/**
 * Frozen world-cell contract and the streaming error taxonomy (00 §3.5/§4.4/
 * §5.9, 12 §3–§5).
 *
 * No ER row covers contract placement itself, so the shape and duplication
 * tests are untagged (the same precedent as `contracts.test.ts`). The
 * taxonomy-coverage title carries ER-12-01, which requires every named
 * streaming rejection code to exist and resolve.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, expectTypeOf, test } from "vitest";
import type {
  CellKey as CoreCellKey,
  CellState as CoreCellState,
  EngineErrorCode,
  WorldCell as CoreWorldCell,
  WorldCellId as CoreWorldCellId,
} from "../src/index";
import type {
  CellKey as StreamingCellKey,
  CellState as StreamingCellState,
  StreamingErrorCode,
  WorldCell as StreamingWorldCell,
  WorldCellId as StreamingWorldCellId,
} from "@lanpad/engine-streaming";
import { ERROR_CODES } from "./errorCodes";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../..");
const STREAMING_SRC = join(ROOT, "packages", "engine", "streaming", "src");
const STREAMING_CONTRACTS = join(STREAMING_SRC, "contracts", "world.ts");
const STREAM_EVENTS = join(STREAMING_SRC, "StreamEvents.ts");

/** Every `.ts`/`.d.ts` source file under a directory, sorted for stable output. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.(?:d\.)?ts$/.test(entry.name)) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

/** Removes block and line comments so prose never counts as a declaration. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("WorldCell keeps the frozen 00 §3.5 shape", () => {
  expectTypeOf<CoreWorldCellId>().toEqualTypeOf<{
    readonly cx: number;
    readonly cy: number;
  }>();
  expectTypeOf<CoreCellKey>().toEqualTypeOf<`${number},${number}`>();
  expectTypeOf<CoreCellState>().toEqualTypeOf<
    "unloaded" | "loading" | "resident" | "evicting"
  >();
  expectTypeOf<CoreWorldCell>().toEqualTypeOf<{
    readonly id: CoreWorldCellId;
    readonly key: CoreCellKey;
    readonly lod: 0 | 1 | 2 | 3;
    readonly state: CoreCellState;
    readonly bytes: number;
  }>();
});

test("streaming world types are the canonical core world types", () => {
  expectTypeOf<StreamingWorldCell>().toEqualTypeOf<CoreWorldCell>();
  expectTypeOf<StreamingWorldCellId>().toEqualTypeOf<CoreWorldCellId>();
  expectTypeOf<StreamingCellKey>().toEqualTypeOf<CoreCellKey>();
  expectTypeOf<StreamingCellState>().toEqualTypeOf<CoreCellState>();
});

test("streaming re-exports the core world types instead of restating them", () => {
  const text = readFileSync(STREAMING_CONTRACTS, "utf8");
  const match =
    /export\s+type\s*\{([^}]*)\}\s*from\s*"@lanpad\/engine-core"/.exec(text);
  expect(match).not.toBeNull();

  const reexported = (match?.[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  expect(reexported.sort()).toEqual([
    "CellKey",
    "CellState",
    "WorldCell",
    "WorldCellId",
  ]);
});

test("streaming source declares no duplicate world type", () => {
  const declaration =
    /\b(?:type|interface)\s+(CellKey|WorldCellId|CellState|WorldCell)\b/;
  const offenders: string[] = [];

  for (const file of sourceFiles(STREAMING_SRC)) {
    const text = stripComments(readFileSync(file, "utf8"));
    const match = declaration.exec(text);
    if (match !== null) {
      offenders.push(
        `${relative(ROOT, file).split(sep).join("/")}: ${match[1]}`,
      );
    }
  }

  expect(offenders).toEqual([]);
});

test("streaming derives its error-code type from the core taxonomy", () => {
  type IsEngineSubset = StreamingErrorCode extends EngineErrorCode
    ? true
    : false;
  const isEngineSubset: IsEngineSubset = true;
  expect(isEngineSubset).toBe(true);

  const text = readFileSync(STREAM_EVENTS, "utf8");
  expect(text).toMatch(
    /import\s+type\s*\{[^}]*EngineErrorCode[^}]*\}\s*from\s*"@lanpad\/engine-core"/,
  );

  const alias = /export type StreamingErrorCode =[\s\S]*?;\n/.exec(text);
  expect(alias).not.toBeNull();
  const aliasBody = alias?.[0] ?? "";
  expect(aliasBody).toMatch(/Extract<\s*EngineErrorCode,/);
  // No locally listed `"E_*"` strings: the concrete codes live in core.
  expect(aliasBody).not.toMatch(/"E_[A-Z0-9_]+"/);
});

/** Every `"E_(WORLD|CELL|STREAM|STATE)_*"` literal in streaming source. */
function streamingCodeLiterals(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(STREAMING_SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /"(E_(?:WORLD|CELL|STREAM|STATE)_[A-Z0-9_]+)"/g,
    )) {
      found.add(match[1] as string);
    }
  }
  return [...found].sort();
}

test("[ER-12-01] every world, cell, stream and state code used by streaming is in EngineErrorCode", () => {
  const used = streamingCodeLiterals();
  expect(used).toHaveLength(32);

  const missing = used.filter(
    (code) => !(ERROR_CODES as readonly string[]).includes(code),
  );
  expect(missing).toEqual([]);
});

/**
 * The codes spec 12 names verbatim in §3.4, §4.2, §5.5, §5.7 and §9. Every one
 * must exist in the canonical union; the rest of the streaming set is the
 * additive coverage ER-12-01 requires.
 */
const SPEC_NAMED_CODES = [
  "E_WORLD_HOLE",
  "E_CELL_HASH",
  "E_CELL_SECTION",
  "E_CELL_KIND",
  "E_CELL_SIZE",
  "E_CELL_APPLY",
  "E_STREAM_FETCH",
  "E_STREAM_DECOMPRESS",
  "E_STREAM_BUDGET",
  "E_STREAM_SIM_BUDGET",
  "E_STREAM_PIN_BUDGET",
  "E_STATE_WORLD",
  "E_STATE_BOUNDS",
  "E_STATE_ORDER",
] as const;

test("spec 12's named codes are declared in the core taxonomy", () => {
  const missing = SPEC_NAMED_CODES.filter(
    (code) => !(ERROR_CODES as readonly string[]).includes(code),
  );
  expect(missing).toEqual([]);
});

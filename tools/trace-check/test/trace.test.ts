import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runTraceCli, type CliIo } from "../src/cli";
import { PREFIX_ORDER, checkTrace, findTags, parseCanonicalIds } from "../src/trace";

const tempDirs: string[] = [];

/** Builds fixture tags without leaving a literal `[ID]` in this file's source. */
const tag = (id: string): string => `[${id}]`;
const req = (id: string): string => `// @req ${id}`;

const CANONICAL_ROWS = [
  "| ID | Short requirement | Layer |",
  "|---|---|---|",
  "| FR-1.1 | first | Protocol |",
  "| FR-10.2 | second, references FR-99.9 in prose | Protocol |",
  "| NR-6.1 | third | Tools |",
  "| PR-9.3 | fourth | Runtime |",
  "| SR-6 | fifth | Protocol |",
  "| AR-4 | sixth | Runtime |",
  "| TR-1 | seventh | Docs |",
  "| A9 | amendment | - |",
  "| G1 | goal | - |",
  "| E5 | experiment | - |",
  "| C1 | capability | - |",
  "| D0-SRV-01 | work item, not a requirement | - |",
];

const CANONICAL_IDS = [
  "FR-1.1",
  "FR-10.2",
  "NR-6.1",
  "PR-9.3",
  "SR-6",
  "AR-4",
  "TR-1",
  "A9",
  "G1",
  "E5",
  "C1",
];

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "lanpad-trace-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function write(root: string, relative: string, text: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function writeTraceability(root: string): void {
  write(root, "docs/todos/TRACEABILITY.md", ["# Traceability", "", ...CANONICAL_ROWS, ""].join("\n"));
}

interface FixtureOptions {
  includeAllIds?: boolean;
  withUnknownTag?: boolean;
}

function makeFixture(options: FixtureOptions = {}): string {
  const root = makeTemp();
  writeTraceability(root);

  write(
    root,
    "packages/demo/test/demo.test.ts",
    [
      `test("${tag("FR-1.1")} first", () => {});`,
      `test("${tag("G1")} ${tag("E5")} second", () => {});`,
      req("PR-9.3, SR-6"),
      "",
    ].join("\n"),
  );

  write(
    root,
    "sdk/test/sdk.test.ts",
    [
      `test("${tag("NR-6.1")} third", () => {});`,
      `test("${tag("C1")} ${tag("AR-4")} fourth", () => {});`,
      `test("${tag("TR-1")} fifth", () => {});`,
      "",
    ].join("\n"),
  );

  if (options.includeAllIds === true) {
    write(
      root,
      "tools/demo/test/extra.test.ts",
      [`test("${tag("A9")} sixth", () => {});`, req("FR-10.2"), ""].join("\n"),
    );
  }

  if (options.withUnknownTag === true) {
    const unknownId = ["FR", "99.9"].join("-");
    write(
      root,
      "packages/demo/test/unknown.test.ts",
      `test("${tag(unknownId)} typo", () => {});\n`,
    );
  }

  return root;
}

interface CapturedIo {
  io: CliIo;
  stdout: string[];
  stderr: string[];
}

function capture(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

describe("traceability parser (D0-QA-01)", () => {
  test("[TR-1] parses only the ID column of markdown tables", () => {
    const ids = parseCanonicalIds(CANONICAL_ROWS.join("\n"));

    expect(ids.sort()).toEqual([...CANONICAL_IDS].sort());
    expect(ids).not.toContain("D0-SRV-01");
    expect(ids).not.toContain("FR-99.9");
  });

  test("[TR-1] recognizes the FR/NR/PR/SR/AR/TR/A/G/E/C prefix families", () => {
    const ids = parseCanonicalIds(CANONICAL_ROWS.join("\n"));
    for (const prefix of PREFIX_ORDER) {
      expect(ids.some((id) => id.startsWith(prefix))).toBe(true);
    }
  });

  test("[TR-1] finds title tags, comma groups and @req comments", () => {
    const text = [
      `test("${tag("FR-1.1")} first", () => {});`,
      `const label = "${tag("G1")}, ${tag("E5")}";`,
      req("PR-9.3, SR-6"),
      "// plain mention of FR-2.2 does not count",
    ].join("\n");

    const ids = findTags(text).map((found) => found.id).sort();
    expect(ids).toEqual(["E5", "FR-1.1", "G1", "PR-9.3", "SR-6"]);
    expect(ids).not.toContain("FR-2.2");
  });

  test("[TR-1] array literals are not mistaken for tags", () => {
    const text = `expect(ids).toEqual(${JSON.stringify(["E5", "FR-1.1"])});`;

    expect(findTags(text)).toEqual([]);
  });

  test("[TR-1] ignores work-item IDs in other columns and prose", () => {
    const markdown = [
      "| ID | Primary work item | Notes |",
      "|---|---|---|",
      "| FR-1.1 | D0-SRV-03 | also mentions SR-9 in prose |",
      "| G1 | P2-QA-01 | - |",
    ].join("\n");

    expect(parseCanonicalIds(markdown).sort()).toEqual(["FR-1.1", "G1"]);
  });
});

describe("trace checker (D0-QA-01)", () => {
  test("[TR-1] every requirement ID has at least one tagged test", () => {
    const root = makeFixture({ includeAllIds: true });
    const report = checkTrace({ root });

    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.canonicalIds.length).toBe(CANONICAL_IDS.length);
    expect(report.taggedIds.length).toBe(CANONICAL_IDS.length);
    expect(report.scannedFiles.length).toBeGreaterThan(0);
  });

  test("[TR-1] missing tags fail the checker", () => {
    const root = makeFixture();
    const report = checkTrace({ root });

    expect(report.ok).toBe(false);
    expect(report.missing).toContain("A9");
    expect(report.missing).toContain("FR-10.2");

    const captured = capture();
    const code = runTraceCli(["--root", root], { io: captured.io });
    expect(code).toBe(1);
    expect(captured.stdout.join("")).toMatch(/missing IDs/);
  });

  test("[TR-1] unknown requirement tags fail the checker", () => {
    const root = makeFixture({ includeAllIds: true, withUnknownTag: true });
    const report = checkTrace({ root });

    expect(report.ok).toBe(false);
    expect(report.missing).toEqual([]);
    expect(report.unknown).toHaveLength(1);
    expect(report.unknown[0]?.id).toBe(["FR", "99.9"].join("-"));
    expect(report.unknown[0]?.file).toBe("packages/demo/test/unknown.test.ts");

    const captured = capture();
    const code = runTraceCli(["--root", root], { io: captured.io });
    expect(code).toBe(1);
    expect(captured.stdout.join("")).toMatch(/unknown tags/);
  });

  test("[TR-1] tool fixtures are not scanned as real test tags", () => {
    const root = makeFixture({ includeAllIds: true });
    write(root, "tools/demo/test/fixtures/not-a-test.txt", `fixture ${tag("FR-99.9")}\n`);
    write(root, "packages/demo/node_modules/planted.test.ts", `test("${tag("FR-99.9")}")`);
    const report = checkTrace({ root });

    expect(report.ok).toBe(true);
    expect(report.unknown).toEqual([]);
  });

  test("[TR-1] prefix coverage summarises every family present", () => {
    const root = makeFixture();
    const report = checkTrace({ root });

    expect(report.prefixes.map((summary) => summary.prefix)).toEqual([...PREFIX_ORDER]);
    const fr = report.prefixes.find((summary) => summary.prefix === "FR");
    expect(fr?.total).toBe(2);
    expect(fr?.covered).toBe(1);
    expect(fr?.missing).toEqual(["FR-10.2"]);
  });

  test("[TR-1] --json emits a machine-readable report and --update writes it", () => {
    const root = makeFixture({ includeAllIds: true });
    const reportPath = join(root, "docs", "TRACE-REPORT.md");
    const captured = capture();
    const code = runTraceCli(["--root", root, "--json", `--update=${reportPath}`], {
      io: captured.io,
    });

    expect(code).toBe(0);
    const report = JSON.parse(captured.stdout.join("")) as {
      ok: boolean;
      canonicalIds: string[];
      missing: string[];
    };
    expect(report.ok).toBe(true);
    expect(report.canonicalIds.length).toBe(CANONICAL_IDS.length);
    const markdown = readFileSync(reportPath, "utf8");
    expect(markdown).toContain("# Trace Report");
    expect(markdown).toContain("| FR-1.1 | covered | `packages/demo/test/demo.test.ts` |");
    expect(markdown).toContain("Do not edit by hand");
  });

  test("[TR-1] --report lists every test file for every covered ID", () => {
    const root = makeFixture({ includeAllIds: true });
    write(
      root,
      "packages/demo/test/extra.test.ts",
      `test("${tag("FR-1.1")} duplicate coverage", () => {});\n`,
    );
    const reportPath = join(root, "docs", "TRACE-REPORT.md");
    const code = runTraceCli(["--root", root, "--report", reportPath], { io: capture().io });
    expect(code).toBe(0);

    const report = checkTrace({ root });
    const markdown = readFileSync(reportPath, "utf8");
    for (const id of report.canonicalIds) {
      expect(report.taggedIds).toContain(id);
      const files = report.tagFilesById[id] ?? [];
      expect(files.length).toBeGreaterThan(0);
      const row = markdown.split("\n").find((line) => line.startsWith(`| ${id} |`));
      expect(row).toMatch(/\| covered \|/);
      for (const file of files) expect(row).toContain(`\`${file}\``);
    }

    expect(markdown).toContain(
      "| FR-1.1 | covered | `packages/demo/test/demo.test.ts`<br>`packages/demo/test/extra.test.ts` |",
    );
  });

  test("[TR-1] the generated report is deterministic and timestamp-free", () => {
    const root = makeFixture({ includeAllIds: true });
    const reportPath = join(root, "docs", "TRACE-REPORT.md");
    expect(runTraceCli(["--root", root, "--report", reportPath], { io: capture().io })).toBe(0);
    const first = readFileSync(reportPath, "utf8");
    expect(runTraceCli(["--root", root, "--report", reportPath], { io: capture().io })).toBe(0);

    expect(readFileSync(reportPath, "utf8")).toBe(first);
    expect(first).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(first).not.toContain("Generated at");
  });

  test("[TR-1] a stage-scoped report separates covered, deferred and missing", () => {
    const root = makeTemp();
    write(
      root,
      "docs/todos/TRACEABILITY.md",
      [
        "# Traceability",
        "",
        "| ID | Short requirement | Primary work item |",
        "|---|---|---|",
        "| FR-1.1 | first | D0-SRV-01 |",
        "| FR-2.1 | second | D1-EXP-01 |",
        "| NR-1.1 | third | D0-QA-01 |",
        "| G1 | goal | D0 |",
        "",
      ].join("\n"),
    );
    write(root, "packages/demo/test/demo.test.ts", `test("${tag("FR-1.1")} first", () => {});\n`);

    const reportPath = join(root, "docs", "TRACE-REPORT.md");
    const code = runTraceCli(["--root", root, "--stage", "D0", "--report", reportPath], {
      io: capture().io,
    });
    expect(code).toBe(1);

    const markdown = readFileSync(reportPath, "utf8");
    expect(markdown).toContain("- Scope: stage D0");
    expect(markdown).toContain("| FR-1.1 | covered | `packages/demo/test/demo.test.ts` |");
    expect(markdown).toContain("| NR-1.1 | missing | - |");
    expect(markdown).toContain("| FR-2.1 | deferred | - |");
    expect(markdown).toContain("| G1 | deferred | - |");
  });

  test("[TR-1] --stage enforces only that stage's requirements and defers the rest", () => {
    const root = makeTemp();
    write(
      root,
      "docs/todos/TRACEABILITY.md",
      [
        "# Traceability",
        "",
        "| ID | Short requirement | Primary work item |",
        "|---|---|---|",
        "| FR-1.1 | first | D0-SRV-01 |",
        "| FR-2.1 | second | D1-EXP-01 |",
        "| NR-1.1 | third | D0-QA-01 |",
        "| G1 | goal | D0 |",
        "",
      ].join("\n"),
    );
    write(root, "packages/demo/test/demo.test.ts", `test("${tag("FR-1.1")} first", () => {});\n`);

    const staged = checkTrace({ root, stage: "D0" });
    expect(staged.stage).toBe("D0");
    expect(staged.requiredIds).toEqual(["FR-1.1", "NR-1.1"]);
    expect(staged.missing).toEqual(["NR-1.1"]);
    expect(staged.deferred).toEqual(["FR-2.1", "G1"]);
    expect(staged.ok).toBe(false);

    const captured = capture();
    const code = runTraceCli(["--root", root, "--stage", "D0"], { io: captured.io });
    expect(code).toBe(1);
    expect(captured.stdout.join("")).toMatch(/stage D0/);

    write(
      root,
      "packages/demo/test/demo.test.ts",
      `test("${tag("FR-1.1")} ${tag("NR-1.1")} first", () => {});\n`,
    );
    const passing = checkTrace({ root, stage: "D0" });
    expect(passing.ok).toBe(true);
    expect(passing.missing).toEqual([]);
    expect(passing.deferred).toEqual(["FR-2.1", "G1"]);

    // No stage means the Gate audit: the same fixture still fails on FR-2.1.
    expect(checkTrace({ root }).ok).toBe(false);
    expect(() => checkTrace({ root, stage: "D-0" })).toThrow(/invalid stage/);
  });

  test("[TR-1] a missing traceability file is an IO error, not a pass", () => {
    const root = makeTemp();
    const captured = capture();
    const code = runTraceCli(["--root", root], { io: captured.io });

    expect(code).toBe(2);
    expect(captured.stderr.join("")).toMatch(/cannot read/);
  });
});

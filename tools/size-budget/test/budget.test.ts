import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  BudgetConfigError,
  classifySize,
  defaultBudgetsPath,
  expandGlob,
  expandGlobs,
  loadBudgets,
  measureFiles,
  parseBudgets,
} from "../src/budget";
import { runSizeCli, type CliIo } from "../src/cli";

const tempDirs: string[] = [];

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), "lanpad-size-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(root: string, relative: string, data: string | Uint8Array): string {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return path;
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
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

function normalized(files: readonly string[]): string[] {
  return files.map((file) => file.replace(/\\/g, "/"));
}

/** Glob expansion returns absolute paths; compare against paths under the temp root. */
function under(root: string, relative: readonly string[]): string[] {
  return relative.map((file) => join(root, file).replace(/\\/g, "/"));
}

describe("budgets file (D0-TOOL-02)", () => {
  test("[G7] every browser bundle has a budget entry", () => {
    const budgets = loadBudgets(defaultBudgetsPath());
    expect(Object.keys(budgets.targets).sort()).toEqual(["controller", "engineCore", "host"]);
    expect(budgets.targets["controller"]).toEqual({ dev: 51200, prod: 51200, hard: 61440 });
    expect(budgets.targets["host"]).toEqual({
      dev: 3145728,
      prod: 3670016,
      hard: 5242880,
    });
    expect(budgets.targets["engineCore"]).toEqual({ aspirational: 409600 });
    expect(budgets.games).toEqual({});
  });

  test("[NR-6.1] host bundle budget is 5 MB hard, 3/3.5 MB targets", () => {
    const host = loadBudgets(defaultBudgetsPath()).targets["host"];
    expect(host?.hard).toBe(5 * 1024 * 1024);
    expect(host?.dev).toBe(3 * 1024 * 1024);
    expect(host?.prod).toBe(3.5 * 1024 * 1024);
  });

  test("[PR-11.2] no memory budget is asserted from the size gate", () => {
    const budgets = loadBudgets(defaultBudgetsPath());
    expect(JSON.stringify(budgets)).not.toMatch(/memory/i);
    for (const tiers of Object.values(budgets.targets)) {
      expect(Object.keys(tiers)).not.toContain("memory");
    }
  });

  test("[G7] malformed budgets are rejected with a field-level error", () => {
    expect(() => parseBudgets({ targets: { controller: { dev: -1 } } })).toThrow(BudgetConfigError);
    expect(() => parseBudgets({ targets: { controller: {} } })).toThrow(/at least one/);
    expect(() => parseBudgets({ games: {} })).toThrow(/targets/);
    expect(() => parseBudgets([])).toThrow(/JSON object/);
  });
});

describe("gzip budget gate (D0-TOOL-02)", () => {
  test("[NR-6.3] controller bundle over 60 KB gz fails the gate", () => {
    const root = makeTemp();
    const payload = randomBytes(70 * 1024);
    writeFile(root, "controller/dist/assets/index-abc.js", payload);
    const captured = capture();
    const code = runSizeCli(
      [
        "--target",
        "controller",
        "--env",
        "dev",
        "--file",
        "controller/dist/assets/*.js",
        "--root",
        root,
        "--json",
      ],
      { cwd: root, io: captured.io },
    );

    expect(code).toBe(1);
    const report = JSON.parse(captured.stdout.join("")) as {
      ok: boolean;
      results: Array<{ status: string; gzipBytes: number; hardBytes: number; budgetBytes: number }>;
    };
    expect(report.ok).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.status).toBe("hard-breach");
    expect(report.results[0]?.gzipBytes).toBeGreaterThan(61440);
    expect(report.results[0]?.hardBytes).toBe(61440);
    expect(report.results[0]?.budgetBytes).toBe(51200);
  });

  test("[NR-6.3] 60 KB passes with a warning and 61 KB breaches", () => {
    const controller = loadBudgets(defaultBudgetsPath()).targets["controller"];
    expect(controller).toBeDefined();
    if (controller === undefined) return;
    expect(classifySize(61440, controller, "dev").status).toBe("warn");
    expect(classifySize(61440, controller, "dev").hardBytes).toBe(61440);
    expect(classifySize(61441, controller, "dev").status).toBe("hard-breach");
    expect(classifySize(51200, controller, "dev").status).toBe("ok");
  });

  test("[G7] a small controller bundle passes and reports deterministic numbers", () => {
    const root = makeTemp();
    writeFile(root, "controller/dist/assets/index-abc.js", "console.log('lanpad');\n");
    writeFile(root, "controller/dist/assets/index-abc.js.map", "{}");
    const captured = capture();
    const code = runSizeCli(
      [
        "--target=controller",
        "--env=dev",
        "--file=controller/dist/assets/*.js",
        `--root=${root}`,
        "--json",
      ],
      { cwd: root, io: captured.io },
    );

    expect(code).toBe(0);
    const report = JSON.parse(captured.stdout.join("")) as {
      ok: boolean;
      results: Array<{ files: string[]; status: string; rawBytes: number; gzipBytes: number }>;
    };
    expect(report.ok).toBe(true);
    expect(report.results[0]?.status).toBe("ok");
    expect(report.results[0]?.files).toEqual(["controller/dist/assets/index-abc.js"]);
    expect(report.results[0]?.rawBytes).toBeGreaterThan(0);
    expect(report.results[0]?.gzipBytes).toBeGreaterThan(0);
  });

  test("[NR-6.3] a missing glob is a usage error, not a silent pass", () => {
    const root = makeTemp();
    const captured = capture();
    const code = runSizeCli(
      ["--target", "controller", "--env", "dev", "--file", "controller/dist/assets/*.js"],
      { cwd: root, io: captured.io },
    );
    expect(code).toBe(2);
    expect(captured.stderr.join("")).toMatch(/no files matched/);
  });
});

describe("recursive glob walker (D0-TOOL-02)", () => {
  test("[G3] walks nested directories and excludes source maps", () => {
    const root = makeTemp();
    writeFile(root, "controller/dist/a.js", "a");
    writeFile(root, "controller/dist/nested/b.js", "b");
    writeFile(root, "controller/dist/nested/deep/c.js", "c");
    writeFile(root, "controller/dist/nested/deep/c.js.map", "{}");

    const files = normalized(expandGlob("controller/dist/**/*.js", root));
    expect(files).toEqual(
      under(root, [
        "controller/dist/a.js",
        "controller/dist/nested/b.js",
        "controller/dist/nested/deep/c.js",
      ]),
    );
  });

  test("[G7] a single star stays within one directory", () => {
    const root = makeTemp();
    writeFile(root, "controller/dist/a.js", "a");
    writeFile(root, "controller/dist/nested/b.js", "b");
    const files = normalized(expandGlob("controller/dist/*.js", root));
    expect(files).toEqual(under(root, ["controller/dist/a.js"]));
  });

  test("[G7] repeated and overlapping globs are deduplicated", () => {
    const root = makeTemp();
    writeFile(root, "controller/dist/a.js", "a");
    writeFile(root, "controller/dist/nested/b.js", "b");
    const files = normalized(
      expandGlobs(["controller/dist/**/*.js", "controller/dist/*.js", "controller/dist/**/*.js"], root),
    );
    expect(files).toEqual(under(root, ["controller/dist/a.js", "controller/dist/nested/b.js"]));
  });

  test("[G3] measurement sums raw and gzip bytes per file", () => {
    const root = makeTemp();
    const first = writeFile(root, "a.js", "a".repeat(1000));
    const second = writeFile(root, "b.js", "b".repeat(2000));
    const measured = measureFiles([first, second]);
    expect(measured.rawBytes).toBe(3000);
    expect(measured.gzipBytes).toBeGreaterThan(0);
    expect(measured.gzipBytes).toBeLessThan(measured.rawBytes);
  });
});

describe("audit mode (D0-TOOL-02)", () => {
  test("[NR-6.1] no-argument run audits controller and host dev targets", () => {
    const root = makeTemp();
    writeFile(root, "packages/controller/dist/assets/c.js", "controller");
    writeFile(root, "packages/runtime/dist/assets/h.js", "host");
    const captured = capture();
    const code = runSizeCli(["--json"], { cwd: root, io: captured.io });

    expect(code).toBe(0);
    const report = JSON.parse(captured.stdout.join("")) as {
      results: Array<{ target: string; env: string; status: string }>;
    };
    expect(report.results.map((result) => `${result.target}:${result.env}`)).toEqual([
      "controller:dev",
      "host:dev",
    ]);
    expect(report.results.every((result) => result.status === "ok")).toBe(true);
  });

  test("[G7] an unknown target is a usage error", () => {
    const root = makeTemp();
    const captured = capture();
    const code = runSizeCli(["--target", "nope", "--file", "x.js"], { cwd: root, io: captured.io });
    expect(code).toBe(2);
    expect(captured.stderr.join("")).toMatch(/unknown target/);
  });
});

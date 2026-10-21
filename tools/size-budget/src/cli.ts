/**
 * size-budget CLI (D0-TOOL-02).
 *
 * Usage:
 *   size-budget --target controller --env dev --file "packages/controller/dist/**\/*.js"
 *   size-budget --target host --env prod --file dist/a.js --file dist/b.js --json
 *   size-budget                      # audit controller+host against dev targets
 *
 * Exit codes: 0 pass/warn, 1 hard-cap breach, 2 usage/config/IO error.
 */
import { pathToFileURL } from "node:url";
import {
  BudgetConfigError,
  type BudgetFile,
  type BudgetTiers,
  type SizeResult,
  defaultBudgetsPath,
  evaluateSize,
  expandGlobs,
  loadBudgets,
  measureFiles,
} from "./budget.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface SizeCliOptions {
  cwd?: string;
  budgetsPath?: string;
  io?: CliIo;
}

interface ParsedArgs {
  target: string | null;
  env: string | null;
  files: string[];
  json: boolean;
  help: boolean;
  budgetsPath: string | null;
  root: string | null;
}

interface AuditEntry {
  target: string;
  env: string;
  patterns: readonly string[];
}

/** Default file globs used when `--file` is omitted. */
const DEFAULT_GLOBS: Record<string, readonly string[]> = {
  controller: ["packages/controller/dist/assets/**/*.js"],
  host: ["packages/runtime/dist/assets/**/*.js"],
  engineCore: ["packages/runtime/dist/assets/**/*.js"],
};

/** No-argument audit mode: the two browser bundles that exist in D0. */
const AUDIT_TARGETS: readonly AuditEntry[] = [
  { target: "controller", env: "dev", patterns: DEFAULT_GLOBS["controller"] ?? [] },
  { target: "host", env: "dev", patterns: DEFAULT_GLOBS["host"] ?? [] },
];

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const USAGE = `Usage: size-budget [options]

Options:
  --target <name>   Budget target from budgets.json (controller, host, engineCore, ...)
  --env <tier>      Budget tier: dev | prod | aspirational (default: dev, else aspirational)
  --file <glob>     File glob to measure; repeatable. Supports *, ? and **
  --budgets <path>  Alternative budgets.json
  --root <dir>      Base directory for relative globs (default: cwd)
  --json            Machine-readable output
  --help            Show this help

With no arguments the controller and host dev budgets are audited.`;

function readValue(argv: readonly string[], index: number, flag: string): { value: string; next: number } {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return { value, next: index + 1 };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    target: null,
    env: null,
    files: [],
    json: false,
    help: false,
    budgetsPath: null,
    root: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);

    switch (flag) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--target": {
        const { value, next } =
          inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };
        parsed.target = value;
        index = next;
        break;
      }
      case "--env": {
        const { value, next } =
          inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };
        parsed.env = value;
        index = next;
        break;
      }
      case "--file": {
        const { value, next } =
          inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };
        if (value.length === 0) throw new UsageError("--file must not be empty");
        parsed.files.push(value);
        index = next;
        break;
      }
      case "--budgets": {
        const { value, next } =
          inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };
        parsed.budgetsPath = value;
        index = next;
        break;
      }
      case "--root": {
        const { value, next } =
          inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };
        parsed.root = value;
        index = next;
        break;
      }
      default:
        throw new UsageError(`unknown option "${token}"`);
    }
  }
  return parsed;
}

function pickEnv(tiers: BudgetTiers): string {
  if (tiers.dev !== undefined) return "dev";
  if (tiers.aspirational !== undefined) return "aspirational";
  if (tiers.prod !== undefined) return "prod";
  return "hard";
}

function skippedResult(target: string, env: string, tiers: BudgetTiers): SizeResult {
  return {
    target,
    env,
    files: [],
    rawBytes: 0,
    gzipBytes: 0,
    budgetBytes: tiers[env as keyof BudgetTiers] ?? null,
    hardBytes: tiers.hard ?? null,
    status: "skipped",
  };
}

function measureTarget(
  budgets: BudgetFile,
  target: string,
  env: string,
  patterns: readonly string[],
  root: string,
  allowEmpty: boolean,
): SizeResult {
  const tiers = budgets.targets[target];
  if (tiers === undefined) {
    throw new UsageError(
      `unknown target "${target}"; budgets.json has: ${Object.keys(budgets.targets).join(", ")}`,
    );
  }
  if (tiers[env as keyof BudgetTiers] === undefined) {
    throw new UsageError(
      `target "${target}" has no "${env}" budget; available: ${Object.keys(tiers).join(", ")}`,
    );
  }
  const files = expandGlobs(patterns, root);
  if (files.length === 0) {
    if (allowEmpty) return skippedResult(target, env, tiers);
    throw new UsageError(`no files matched ${patterns.map((pattern) => `"${pattern}"`).join(", ")}`);
  }
  return evaluateSize(target, env, tiers, files, measureFiles(files), root);
}

function formatText(results: readonly SizeResult[]): string {
  const rows = results.map((result) => ({
    target: result.target,
    env: result.env,
    files: String(result.files.length),
    raw: result.status === "skipped" ? "-" : String(result.rawBytes),
    gzip: result.status === "skipped" ? "-" : String(result.gzipBytes),
    budget: result.budgetBytes === null ? "-" : String(result.budgetBytes),
    status: result.status,
  }));
  const headers = {
    target: "target",
    env: "env",
    files: "files",
    raw: "raw",
    gzip: "gzip",
    budget: "budget",
    status: "status",
  };
  const widths: Record<keyof typeof headers, number> = {
    target: headers.target.length,
    env: headers.env.length,
    files: headers.files.length,
    raw: headers.raw.length,
    gzip: headers.gzip.length,
    budget: headers.budget.length,
    status: headers.status.length,
  };
  for (const row of rows) {
    for (const key of Object.keys(widths) as Array<keyof typeof widths>) {
      widths[key] = Math.max(widths[key], row[key].length);
    }
  }
  const line = (row: Record<keyof typeof headers, string>): string =>
    `${row.target.padEnd(widths.target)}  ${row.env.padEnd(widths.env)}  ${row.files.padStart(widths.files)}  ${row.raw.padStart(widths.raw)}  ${row.gzip.padStart(widths.gzip)}  ${row.budget.padStart(widths.budget)}  ${row.status}`;
  return [line(headers), ...rows.map(line)].join("\n");
}

function describeDecisions(results: readonly SizeResult[]): string[] {
  const notes: string[] = [];
  for (const result of results) {
    if (result.status === "hard-breach") {
      notes.push(
        `FAIL: ${result.target} ${result.env} is ${result.gzipBytes} gz bytes, over the hard cap of ${result.hardBytes}`,
      );
    } else if (result.status === "warn") {
      const limit = result.budgetBytes ?? result.hardBytes ?? 0;
      notes.push(
        `WARNING: ${result.target} ${result.env} is ${result.gzipBytes} gz bytes, over the ${limit}-byte target but under hard`,
      );
    } else if (result.status === "skipped") {
      notes.push(`WARNING: ${result.target} ${result.env} skipped; no files matched`);
    }
  }
  return notes;
}

/** Runs the CLI. Returns the process exit code instead of calling process.exit. */
export function runSizeCli(argv: readonly string[], options: SizeCliOptions = {}): number {
  const io = options.io ?? {
    stdout: (text: string) => process.stdout.write(text),
    stderr: (text: string) => process.stderr.write(text),
  };
  const cwd = options.cwd ?? process.cwd();

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.stderr(`${String(error)}\n\n${USAGE}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }

  try {
    const root = parsed.root === null ? cwd : parsed.root;
    const budgets = loadBudgets(parsed.budgetsPath ?? options.budgetsPath ?? defaultBudgetsPath());
    const results: SizeResult[] = [];

    if (parsed.target === null) {
      if (parsed.env !== null || parsed.files.length > 0) {
        throw new UsageError("--env and --file require --target");
      }
      for (const entry of AUDIT_TARGETS) {
        results.push(measureTarget(budgets, entry.target, entry.env, entry.patterns, root, true));
      }
    } else {
      const tiers = budgets.targets[parsed.target];
      if (tiers === undefined) {
        throw new UsageError(
          `unknown target "${parsed.target}"; budgets.json has: ${Object.keys(budgets.targets).join(", ")}`,
        );
      }
      const env = parsed.env ?? pickEnv(tiers);
      const patterns = parsed.files.length > 0 ? parsed.files : (DEFAULT_GLOBS[parsed.target] ?? []);
      if (patterns.length === 0) {
        throw new UsageError(`target "${parsed.target}" has no default glob; pass --file`);
      }
      results.push(measureTarget(budgets, parsed.target, env, patterns, root, false));
    }

    const ok = results.every((result) => result.status !== "hard-breach");
    if (parsed.json) {
      io.stdout(`${JSON.stringify({ ok, results }, null, 2)}\n`);
    } else {
      io.stdout(`${formatText(results)}\n`);
      for (const note of describeDecisions(results)) io.stderr(`${note}\n`);
    }
    return ok ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError || error instanceof BudgetConfigError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    io.stderr(`${String(error)}\n`);
    return 2;
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  process.exitCode = runSizeCli(process.argv.slice(2));
}

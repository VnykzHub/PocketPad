/**
 * trace-check CLI (D0-QA-01).
 *
 * Usage:
 *   trace-check [--root <dir>] [--traceability <file>] [--stage <name>]
 *               [--json] [--report <file>] [--update[=<file>]] [--help]
 *
 * Inside a stage, only that stage's requirement IDs must be tagged; the Gate
 * runs without `--stage` and requires the whole matrix.
 *
 * Exit codes: 0 every required ID tagged and no unknown tags, 1 missing/unknown
 * tags, 2 usage or IO error.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type TraceReport, TraceCheckError, checkTrace } from "./trace.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface TraceCliOptions {
  cwd?: string;
  io?: CliIo;
  /** Default scan root when `--root` is not passed. */
  root?: string;
  /** Default traceability file when `--traceability` is not passed. */
  traceabilityPath?: string;
  /** Default report path used by a bare `--update`. */
  updatePath?: string;
}

interface ParsedArgs {
  root: string | null;
  traceability: string | null;
  stage: string | null;
  json: boolean;
  help: boolean;
  updateRequested: boolean;
  updatePath: string | null;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const USAGE = `Usage: trace-check [options]

Options:
  --root <dir>           Repository root to scan (default: cwd)
  --traceability <file>  Traceability matrix (default: docs/todos/TRACEABILITY.md)
  --stage <name>         Enforce only requirement IDs owned by this stage (e.g. D0)
  --json                 Machine-readable report
  --report <file>        Write deterministic markdown to <file> (e.g. docs/TRACE-REPORT.md)
  --update[=<file>]      Write the report (default: docs/TRACE-REPORT.md), same as --report
  --help                 Show this help

Inside a stage, untagged IDs owned by later stages are reported as deferred;
the Gate runs without --stage and requires the whole matrix. Fails when a
required requirement ID has no tagged test or a test tag names an unknown ID.`;

function readValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string; next: number } {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return { value, next: index + 1 };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    root: null,
    traceability: null,
    stage: null,
    json: false,
    help: false,
    updateRequested: false,
    updatePath: null,
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
      case "--report": {
        const value =
          inlineValue !== null ? inlineValue : readValue(argv, index, flag).value;
        if (value.length === 0) {
          throw new UsageError(`${flag} requires a value`);
        }
        parsed.updateRequested = true;
        parsed.updatePath = value;
        if (inlineValue === null) index += 1;
        break;
      }
      case "--update":
        parsed.updateRequested = true;
        if (inlineValue !== null && inlineValue.length > 0) {
          parsed.updatePath = inlineValue;
        } else {
          const nextToken = argv[index + 1];
          if (nextToken !== undefined && !nextToken.startsWith("-")) {
            parsed.updatePath = nextToken;
            index += 1;
          }
        }
        break;
      case "--root": {
        const { value, next } =
          inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };
        parsed.root = value;
        index = next;
        break;
      }
      case "--traceability": {
        const { value, next } =
          inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };
        parsed.traceability = value;
        index = next;
        break;
      }
      case "--stage": {
        const { value, next } =
          inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };
        parsed.stage = value;
        index = next;
        break;
      }
      default:
        throw new UsageError(`unknown option "${token}"`);
    }
  }
  return parsed;
}

function displayPath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  if (absolutePath === absoluteRoot) return ".";
  if (absolutePath.startsWith(`${absoluteRoot}\\`) || absolutePath.startsWith(`${absoluteRoot}/`)) {
    return relative(absoluteRoot, absolutePath).replace(/\\/g, "/");
  }
  return absolutePath.replace(/\\/g, "/");
}

function formatText(report: TraceReport): string {
  const lines: string[] = [];
  if (report.stage === null) {
    lines.push(
      `trace-check: ${report.canonicalIds.length} IDs, ${report.taggedIds.length} tagged, ${report.missing.length} missing, ${report.unknown.length} unknown (${report.scannedFiles.length} test files)`,
    );
  } else {
    lines.push(
      `trace-check: stage ${report.stage}, ${report.requiredIds.length}/${report.canonicalIds.length} required IDs, ${report.missing.length} missing, ${report.deferred.length} deferred, ${report.unknown.length} unknown (${report.scannedFiles.length} test files)`,
    );
  }
  for (const summary of report.prefixes) {
    lines.push(`  ${summary.prefix.padEnd(3)} ${summary.covered}/${summary.total}`);
  }
  if (report.missing.length > 0) {
    lines.push(`missing IDs (${report.missing.length}):`);
    for (const id of report.missing) lines.push(`  - ${id}`);
  }
  if (report.unknown.length > 0) {
    lines.push(`unknown tags (${report.unknown.length}):`);
    for (const tag of report.unknown) {
      lines.push(`  - ${tag.id} at ${tag.file}:${tag.line}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildReportMarkdown(report: TraceReport, root: string): string {
  const statusOf = (id: string): "missing" | "deferred" | "covered" => {
    if (report.missing.includes(id)) return "missing";
    if (report.deferred.includes(id)) return "deferred";
    return "covered";
  };
  const filesOf = (id: string): string => {
    const files = report.tagFilesById[id] ?? [];
    return files.length === 0 ? "-" : files.map((file) => `\`${file}\``).join("<br>");
  };
  return [
    "# Trace Report",
    "",
    "> Generated by `tools/trace-check` (D0-QA-01). Do not edit by hand.",
    "",
    `- Traceability: \`${displayPath(root, report.traceabilityPath)}\``,
    `- Scope: ${report.stage === null ? "full matrix (Gate audit)" : `stage ${report.stage}`}`,
    `- Requirement IDs: ${report.canonicalIds.length}`,
    `- Required: ${report.requiredIds.length}`,
    `- Tagged: ${report.taggedIds.length}`,
    `- Missing: ${report.missing.length}`,
    `- Deferred: ${report.deferred.length}`,
    `- Unknown tags: ${report.unknown.length}`,
    "",
    "Status is `covered` (tagged), `deferred` (untagged, outside the stage scope)",
    "or `missing` (untagged and required). Test file paths are relative to the",
    "repository root and sorted.",
    "",
    "## Coverage by prefix",
    "",
    "| Prefix | Covered | Total |",
    "|---|---:|---:|",
    ...report.prefixes.map(
      (summary) => `| ${summary.prefix} | ${summary.covered} | ${summary.total} |`,
    ),
    "",
    "## Coverage",
    "",
    "| ID | Status | Test file(s) |",
    "|---|---|---|",
    ...report.canonicalIds.map(
      (id) => `| ${id} | ${statusOf(id)} | ${filesOf(id)} |`,
    ),
    "",
  ].join("\n");
}

/** Runs the CLI. Returns the process exit code instead of calling process.exit. */
export function runTraceCli(argv: readonly string[], options: TraceCliOptions = {}): number {
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

  const root = parsed.root ?? options.root ?? cwd;
  const traceabilityPath = parsed.traceability ?? options.traceabilityPath;
  try {
    const report = checkTrace({
      root,
      ...(traceabilityPath !== undefined ? { traceabilityPath } : {}),
      ...(parsed.stage !== null ? { stage: parsed.stage } : {}),
    });

    if (parsed.updateRequested) {
      const reportPath =
        parsed.updatePath ?? options.updatePath ?? join(root, "docs", "TRACE-REPORT.md");
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(reportPath, buildReportMarkdown(report, root), "utf8");
    }

    if (parsed.json) {
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      io.stdout(formatText(report));
    }
    return report.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError || error instanceof TraceCheckError) {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    io.stderr(`${String(error)}\n`);
    return 2;
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  process.exitCode = runTraceCli(process.argv.slice(2));
}

/**
 * asset-curate CLI (ADR-0004 D7).
 *
 * Usage:
 *   asset-curate --source E:/PocketPad/Game-assets --out assets
 *   asset-curate --check --json
 *
 * Exit codes: 0 pass, 1 verification/budget failure, 2 usage or unexpected IO.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CURATION_JSON_FILE,
  CURATION_MD_FILE,
  LICENSES_FILE,
  curate,
  type CurateResult,
} from "./curate.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface AssetCurateCliOptions {
  cwd?: string;
  io?: CliIo;
}

interface ParsedArgs {
  source: string | null;
  out: string | null;
  check: boolean;
  json: boolean;
  help: boolean;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const USAGE = `Usage: asset-curate [options]

Options:
  --source <dir>  Game-assets drop (default: nearest Game-assets/ ancestor)
  --out <dir>     Output root for the committed subset (default: assets)
  --check         Verify assets/ against Game-assets; do not write
  --json          Machine-readable summary
  --help          Show this help

The source drop is gitignored; the committed output is size-budgeted.`;

function readValue(argv: readonly string[], index: number, flag: string): { value: string; next: number } {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} requires a value`);
  return { value, next: index + 1 };
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { source: null, out: null, check: false, json: false, help: false };
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
      case "--check":
        parsed.check = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--source": {
        const { value, next } =
          inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };
        parsed.source = value;
        index = next;
        break;
      }
      case "--out": {
        const { value, next } =
          inlineValue === null ? readValue(argv, index, flag) : { value: inlineValue, next: index };
        parsed.out = value;
        index = next;
        break;
      }
      default:
        throw new UsageError(`unknown option "${token}"`);
    }
  }
  return parsed;
}

/**
 * The drop sits at the repository root, while agents run in worktrees several
 * levels down. Walk ancestors before reporting a missing source.
 */
function findDefaultSource(cwd: string): string {
  let directory = resolve(cwd);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, "Game-assets");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return resolve(cwd, "Game-assets");
}

function formatNumber(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function printSummary(result: CurateResult, sourceRoot: string, assetRoot: string, check: boolean): string {
  const lines: string[] = [];
  lines.push(`asset-curate: ${result.ok ? "PASS" : "FAIL"}${check ? " (check mode)" : ""}`);
  lines.push(`source: ${sourceRoot}`);
  lines.push(`output: ${assetRoot}`);
  lines.push(
    `scan: ${formatNumber(result.scan.files)} files, ${formatNumber(result.scan.bytes)} bytes (${formatNumber(result.scan.glb)} GLB, ${formatNumber(result.scan.ogg)} OGG)`,
  );
  lines.push(
    `curated: ${formatNumber(result.totals.files)} files, ${formatNumber(result.totals.bytes)} bytes raw, ${formatNumber(result.totals.gzipBytes)} bytes gzip (per-file)`,
  );
  for (const group of result.groups) {
    lines.push(
      `  ${group.group}: ${group.files} files, ${formatNumber(group.bytes)} raw, ${formatNumber(group.gzipBytes)} gzip`,
    );
  }
  for (const manifest of result.manifests) {
    lines.push(
      `manifest ${manifest.game}: boot ${manifest.bootIds.length}/${formatNumber(manifest.bootBytes)} raw (${formatNumber(manifest.bootGzipBytes)} gzip), total ${manifest.assetCount} assets/${formatNumber(manifest.totalBytes)} raw`,
    );
  }
  lines.push(`ledger: ${LICENSES_FILE}`);
  lines.push(`report: ${CURATION_MD_FILE} (${CURATION_JSON_FILE} for machines)`);
  lines.push(`written: ${result.written.length} file(s)`);
  lines.push("D6 OGG decode: NOT MEASURED by this CLI; see the stream C report.");
  return `${lines.join("\n")}\n`;
}

export function runAssetCurateCli(
  argv: readonly string[],
  options: AssetCurateCliOptions = {},
): number {
  const io = options.io ?? {
    stdout: (text: string) => process.stdout.write(text),
    stderr: (text: string) => process.stderr.write(text),
  };
  const cwd = options.cwd ?? process.cwd();

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }

  const sourceRoot = parsed.source === null ? findDefaultSource(cwd) : resolve(cwd, parsed.source);
  const assetRoot = parsed.out === null ? resolve(cwd, "assets") : resolve(cwd, parsed.out);

  try {
    const result = curate({ sourceRoot, assetRoot, check: parsed.check });
    if (parsed.json) {
      io.stdout(
        `${JSON.stringify(
          {
            ok: result.ok,
            check: parsed.check,
            sourceRoot,
            assetRoot,
            scan: result.scan,
            totals: result.totals,
            groups: result.groups,
            manifests: result.manifests.map((manifest) => ({
              game: manifest.game,
              path: manifest.path,
              assets: manifest.assetCount,
              bootAssets: manifest.bootIds.length,
              bootBytes: manifest.bootBytes,
              bootGzipBytes: manifest.bootGzipBytes,
              totalBytes: manifest.totalBytes,
              totalGzipBytes: manifest.totalGzipBytes,
            })),
            ledger: LICENSES_FILE,
            report: CURATION_MD_FILE,
            written: result.written,
            errors: result.errors,
            warnings: result.warnings,
            d6: "NOT_MEASURED_BY_CLI",
          },
          null,
          2,
        )}\n`,
      );
    } else {
      io.stdout(printSummary(result, sourceRoot, assetRoot, parsed.check));
    }
    for (const warning of result.warnings) io.stderr(`WARNING: ${warning}\n`);
    for (const error of result.errors) io.stderr(`ERROR: ${error}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    io.stderr(`asset-curate failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  process.exitCode = runAssetCurateCli(process.argv.slice(2));
}

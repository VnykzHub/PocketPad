/**
 * Size-budget core (D0-TOOL-02).
 *
 * Everything here is dependency-free: the glob walker, gzip measurement and
 * budget evaluation are plain Node built-ins so the gate can run in CI without
 * an install beyond the workspace itself.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** One target's cap set. `aspirational` is a warning-only goal (engineCore). */
export interface BudgetTiers {
  dev?: number;
  prod?: number;
  hard?: number;
  aspirational?: number;
}

export interface BudgetFile {
  targets: Record<string, BudgetTiers>;
  games: Record<string, BudgetTiers>;
}

export type SizeStatus = "ok" | "warn" | "hard-breach" | "skipped";

export interface SizeResult {
  target: string;
  env: string;
  /** Paths relative to the invocation root, POSIX separators, sorted. */
  files: string[];
  rawBytes: number;
  gzipBytes: number;
  /** The cap for the requested env, or null when the tier does not apply. */
  budgetBytes: number | null;
  hardBytes: number | null;
  status: SizeStatus;
}

export interface MeasuredSize {
  rawBytes: number;
  gzipBytes: number;
}

export class BudgetConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetConfigError";
  }
}

const configuredBudgetsUrl = new URL("../budgets.json", import.meta.url);

/** Absolute path of the checked-in budgets file (works from src/ and dist/). */
export function defaultBudgetsPath(): string {
  return fileURLToPath(configuredBudgetsUrl);
}

function isPositiveBudget(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function readTierSet(value: unknown, label: string): BudgetTiers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BudgetConfigError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const tiers: BudgetTiers = {};
  for (const key of ["dev", "prod", "hard", "aspirational"] as const) {
    if (!(key in record)) continue;
    const bytes = record[key];
    if (!isPositiveBudget(bytes)) {
      throw new BudgetConfigError(`${label}.${key} must be a positive integer byte count`);
    }
    tiers[key] = bytes;
  }
  if (Object.keys(tiers).length === 0) {
    throw new BudgetConfigError(`${label} must define at least one of dev/prod/hard/aspirational`);
  }
  return tiers;
}

/** Loads and validates a budgets JSON file. Throws BudgetConfigError on malformed input. */
export function parseBudgets(value: unknown): BudgetFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BudgetConfigError("budgets file must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const rawTargets = record["targets"];
  if (typeof rawTargets !== "object" || rawTargets === null || Array.isArray(rawTargets)) {
    throw new BudgetConfigError('budgets file must contain a "targets" object');
  }
  const targets: Record<string, BudgetTiers> = {};
  for (const [name, tiers] of Object.entries(rawTargets as Record<string, unknown>)) {
    targets[name] = readTierSet(tiers, `targets.${name}`);
  }

  const rawGames = record["games"] ?? {};
  if (typeof rawGames !== "object" || rawGames === null || Array.isArray(rawGames)) {
    throw new BudgetConfigError('"games" must be an object when present');
  }
  const games: Record<string, BudgetTiers> = {};
  for (const [name, tiers] of Object.entries(rawGames as Record<string, unknown>)) {
    games[name] = readTierSet(tiers, `games.${name}`);
  }
  return { targets, games };
}

/** Reads, parses and validates a budgets JSON file. */
export function loadBudgets(path: string = defaultBudgetsPath()): BudgetFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new BudgetConfigError(`cannot read budgets file ${path}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BudgetConfigError(`invalid JSON in ${path}: ${String(error)}`);
  }
  return parseBudgets(parsed);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Glob match for one path segment. Supports `*` and `?` only. */
function matchSegment(name: string, pattern: string): boolean {
  let source = "";
  for (const char of pattern) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`).test(name);
}

interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function safeReadDir(path: string): Array<{ name: string; isDirectory: boolean; isFile: boolean }> {
  let entries: DirEntry[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ name: string; isDirectory: boolean; isFile: boolean }> = [];
  for (const entry of entries) {
    // Symlinked directories are skipped so a cyclic link cannot hang the walk.
    if (entry.isSymbolicLink()) continue;
    out.push({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function walkPattern(baseDir: string, segments: readonly string[], out: Set<string>): void {
  const head = segments[0];
  if (head === undefined) return;
  const rest = segments.slice(1);

  if (head === "**") {
    if (rest.length === 0) {
      // Trailing `**` matches every file below this directory.
      for (const entry of safeReadDir(baseDir)) {
        const path = join(baseDir, entry.name);
        if (entry.isFile) out.add(path);
        else if (entry.isDirectory) walkPattern(path, ["**"], out);
      }
      return;
    }
    // Zero directories, then one or more directory levels.
    walkPattern(baseDir, rest, out);
    for (const entry of safeReadDir(baseDir)) {
      if (entry.isDirectory) walkPattern(join(baseDir, entry.name), segments, out);
    }
    return;
  }

  if (!head.includes("*") && !head.includes("?")) {
    const path = join(baseDir, head);
    if (rest.length === 0) {
      try {
        if (statSync(path).isFile()) out.add(path);
      } catch {
        // Missing path: no match.
      }
      return;
    }
    try {
      if (statSync(path).isDirectory()) walkPattern(path, rest, out);
    } catch {
      // Missing path: no match.
    }
    return;
  }

  for (const entry of safeReadDir(baseDir)) {
    if (!matchSegment(entry.name, head)) continue;
    const path = join(baseDir, entry.name);
    if (rest.length === 0) {
      if (entry.isFile) out.add(path);
    } else if (entry.isDirectory) {
      walkPattern(path, rest, out);
    }
  }
}

/**
 * Expands one glob to absolute file paths. Supports `*`, `?` and recursive
 * `**` segments; source maps are excluded from the measurement set.
 */
export function expandGlob(pattern: string, cwd: string): string[] {
  const normalized = pattern.replace(/\\/g, "/");
  const isAbsolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  let baseDir: string;
  let walkSegments: string[];

  if (isAbsolute && segments.length > 0 && /^[A-Za-z]:$/.test(segments[0] ?? "")) {
    baseDir = `${segments[0]}/`;
    walkSegments = segments.slice(1);
  } else if (isAbsolute) {
    baseDir = "/";
    walkSegments = segments;
  } else {
    baseDir = resolve(cwd);
    walkSegments = segments;
  }

  const matches = new Set<string>();
  walkPattern(baseDir, walkSegments, matches);
  return [...matches]
    .filter((path) => !path.endsWith(".map"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Expands several globs and deduplicates the union. */
export function expandGlobs(patterns: readonly string[], cwd: string): string[] {
  const matches = new Set<string>();
  for (const pattern of patterns) {
    for (const path of expandGlob(pattern, cwd)) matches.add(path);
  }
  return [...matches].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Raw and gzip byte totals. Each file is compressed independently, matching the budgets. */
export function measureFiles(files: readonly string[]): MeasuredSize {
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const file of files) {
    const buffer = readFileSync(file);
    rawBytes += buffer.byteLength;
    gzipBytes += gzipSync(buffer).byteLength;
  }
  return { rawBytes, gzipBytes };
}

/**
 * Chooses the status for a measured size.
 *
 * - over `hard`                     -> hard-breach (exit 1)
 * - over the selected env target    -> warn (exit 0)
 * - over `aspirational`             -> warn (exit 0; engineCore has no hard cap)
 * - otherwise                       -> ok
 */
export function classifySize(
  gzipBytes: number,
  tiers: BudgetTiers,
  env: string,
): { status: SizeStatus; budgetBytes: number | null; hardBytes: number | null } {
  const budgetBytes = tiers[env as keyof BudgetTiers];
  if (!isPositiveBudget(budgetBytes)) {
    throw new BudgetConfigError(
      `no "${env}" budget (available: ${Object.keys(tiers).join(", ") || "none"})`,
    );
  }
  const hardBytes = isPositiveBudget(tiers.hard) ? tiers.hard : null;
  if (hardBytes !== null && gzipBytes > hardBytes) {
    return { status: "hard-breach", budgetBytes, hardBytes };
  }
  if (gzipBytes > budgetBytes) {
    return { status: "warn", budgetBytes, hardBytes };
  }
  return { status: "ok", budgetBytes, hardBytes };
}

/** Builds one report row from measured bytes and the matching budget tiers. */
export function evaluateSize(
  target: string,
  env: string,
  tiers: BudgetTiers,
  files: readonly string[],
  measured: MeasuredSize,
  root: string,
): SizeResult {
  const { status, budgetBytes, hardBytes } = classifySize(measured.gzipBytes, tiers, env);
  return {
    target,
    env,
    files: files.map((file) => relativeTo(root, file)),
    rawBytes: measured.rawBytes,
    gzipBytes: measured.gzipBytes,
    budgetBytes,
    hardBytes,
    status,
  };
}

function relativeTo(root: string, file: string): string {
  const normalizedRoot = resolve(root).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedFile = resolve(file).replace(/\\/g, "/");
  if (normalizedFile === normalizedRoot) return ".";
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile;
}

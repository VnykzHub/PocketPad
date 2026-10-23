/**
 * TR-1 trace checker core (D0-QA-01).
 *
 * `docs/todos/TRACEABILITY.md` is the single source of requirement IDs. This
 * module parses the ID column of its tables, scans test sources for `[ID]`
 * titles and `@req ID` annotations, and reports missing and unknown IDs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const DASH_PREFIXES = ["FR", "NR", "PR", "SR", "AR", "TR", "ER", "GAME"] as const;
const BARE_PREFIXES = ["A", "G", "E", "C"] as const;

/** Prefix display/grouping order. */
export const PREFIX_ORDER: readonly string[] = [...DASH_PREFIXES, ...BARE_PREFIXES];

/**
 * Matches FR-7.3, NR-6.1, PR-9.3, SR-6, AR-4, TR-1, ER-19-01, A9, G1, E17 and C10.
 *
 * ER IDs carry two hyphen-separated numbers (engine spec + acceptance row), so
 * they need their own alternative; the dotted form is for the phone-platform
 * requirement families.
 *
 * The surrounding negative lookarounds keep work-item IDs such as
 * `D0-SRV-03` or `P1-SRV-03` from being mistaken for requirement tags.
 */
const ID_SOURCE = String.raw`(?<![A-Za-z0-9-])(?:(?:FR|NR|PR|SR|AR|TR)-\d+(?:\.\d+)?|ER-\d+-\d+|GAME-[A-Z0-9]+(?:-[A-Z0-9]+)+-\d+|[AGEC]\d+)(?![A-Za-z0-9-])`;
const ANCHORED_ID = new RegExp(`^(?:${ID_SOURCE})$`);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".md",
  ".txt",
  ".json",
  ".html",
  ".htm",
  ".css",
]);

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".git", ".turbo"]);

export interface TagLocation {
  id: string;
  /** Path relative to the scan root, POSIX separators. */
  file: string;
  line: number;
}

export interface PrefixSummary {
  prefix: string;
  total: number;
  covered: number;
  missing: string[];
}

export interface TraceReport {
  ok: boolean;
  traceabilityPath: string;
  /** Stage used to scope enforcement, or null for the full Gate audit. */
  stage: string | null;
  canonicalIds: string[];
  /** IDs enforced in this run: the whole matrix, or one stage's requirements. */
  requiredIds: string[];
  taggedIds: string[];
  missing: string[];
  /** Untagged IDs outside the current stage's scope; informational until the Gate. */
  deferred: string[];
  unknown: TagLocation[];
  prefixes: PrefixSummary[];
  scannedFiles: string[];
  /**
   * Test files that carry at least one tag for each ID, sorted. Keys follow
   * `compareIds` order so JSON and Markdown output are deterministic.
   */
  tagFilesById: Record<string, string[]>;
}

export interface TraceCheckOptions {
  root: string;
  traceabilityPath?: string;
  /**
   * Scope enforcement to the requirement IDs owned by one stage (for example
   * `D0`). Untagged IDs owned by later stages are reported as deferred instead
   * of failing the run. Omit it for the Gate's full-coverage audit.
   */
  stage?: string;
}

/** Requirement families enforced per stage. Goals, amendments and experiments are Gate-audited. */
const REQUIREMENT_PREFIX = /^(?:FR|NR|PR|SR|AR|TR)-/;

const STAGE_PATTERN = /^[A-Z]\d+$/;

export class TraceCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceCheckError";
  }
}

interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

function safeReadDir(path: string): DirEntry[] {
  let entries: DirEntry[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let offset = 0; offset < index; offset += 1) {
    if (text.charCodeAt(offset) === 10) line += 1;
  }
  return line;
}

/** All ID-shaped strings in `text`, in first-seen order, without duplicates. */
export function extractIds(text: string): string[] {
  const pattern = new RegExp(ID_SOURCE, "g");
  const ids: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const id = match[0];
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Parses the first column of every markdown table row and keeps the whole row.
 * The row text is what stage ownership is read from (work-item tokens such as
 * `D0-SRV-02` or `D1-EXP-01`).
 */
export function parseCanonicalRows(markdown: string): Array<{ id: string; row: string }> {
  const rows: Array<{ id: string; row: string }> = [];
  const seen = new Set<string>();
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|");
    const first = (cells[1] ?? "").replace(/[`*]/g, "").trim();
    if (first.length === 0 || !ANCHORED_ID.test(first)) continue;
    if (seen.has(first)) continue;
    seen.add(first);
    rows.push({ id: first, row: line });
  }
  return rows;
}

/**
 * Parses the first column of every markdown table row. IDs referenced in prose
 * or in other columns (for example a work-item cell) are not canonical.
 */
export function parseCanonicalIds(markdown: string): string[] {
  return parseCanonicalRows(markdown).map(({ id }) => id);
}

/** True when the row names the stage directly (`D0`) or through a work item (`D0-SRV-02`). */
export function rowMentionsStage(row: string, stage: string): boolean {
  const token = new RegExp(`(?<![A-Za-z0-9-])${stage}(?![A-Za-z0-9])`);
  return token.test(row);
}

function idParts(id: string): { prefix: string; major: number; minor: number } {
  // GAME-<GAME>-<AREA>-<NN> has a variable segment count; the trailing number
  // is its acceptance row.
  if (id.startsWith("GAME-")) {
    const gameMatch = /^GAME-[A-Z0-9-]+-(\d+)$/.exec(id);
    return {
      prefix: "GAME",
      major: Number(gameMatch?.[1] ?? 0),
      minor: 0,
    };
  }
  // ER IDs use a second hyphen (ER-19-01); the phone-platform families use a dot.
  const match = /^([A-Z]+)-?(\d+)(?:[-.](\d+))?$/.exec(id);
  if (match === null) return { prefix: "", major: 0, minor: 0 };
  return {
    prefix: match[1] ?? "",
    major: Number(match[2] ?? 0),
    minor: Number(match[3] ?? 0),
  };
}

/** Deterministic natural order: prefix group, then numeric segments. */
export function compareIds(left: string, right: string): number {
  const a = idParts(left);
  const b = idParts(right);
  const aPrefix = PREFIX_ORDER.indexOf(a.prefix);
  const bPrefix = PREFIX_ORDER.indexOf(b.prefix);
  if (aPrefix !== bPrefix) return aPrefix - bPrefix;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A bracket group counts as a tag group only when it holds nothing but IDs and
 * comma/space separators. This keeps array literals such as
 * `expect(ids).toEqual(["FR-1.1", "G1"])` from being read as tests.
 */
function looksLikeTagGroup(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;
  return trimmed.split(/[\s,]+/).every((token) => ANCHORED_ID.test(token));
}

/**
 * Finds `[ID]` groups (including `[FR-7.3, SR-6]`) and `@req ID` comments.
 * A tag only counts when it appears in square brackets or after `@req`.
 */
export function findTags(text: string): Array<{ id: string; line: number }> {
  const found: Array<{ id: string; line: number }> = [];
  const seen = new Set<string>();

  const bracketPattern = /\[([^[\]\n]*)\]/g;
  for (const match of text.matchAll(bracketPattern)) {
    const content = match[1] ?? "";
    if (!looksLikeTagGroup(content)) continue;
    const line = lineAt(text, match.index ?? 0);
    for (const id of extractIds(content)) {
      const key = `${id}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ id, line });
    }
  }

  const reqPattern = /@req\b([^\n]*)/g;
  for (const match of text.matchAll(reqPattern)) {
    const line = lineAt(text, match.index ?? 0);
    for (const id of extractIds(match[1] ?? "")) {
      const key = `${id}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ id, line });
    }
  }

  return found;
}

function isTestFileName(name: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/.test(name);
}

function hasTextExtension(name: string): boolean {
  return TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function walkArea(
  root: string,
  dir: string,
  area: "packages" | "tools" | "sdk" | "experiments",
  inTestDir: boolean,
  files: string[],
): void {
  for (const entry of safeReadDir(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkArea(root, path, area, inTestDir || entry.name === "test", files);
      continue;
    }
    if (!entry.isFile() || !hasTextExtension(entry.name)) continue;

    const isTestFile = isTestFileName(entry.name);
    let included: boolean;
    if (area === "experiments") included = true;
    else if (area === "tools" || area === "sdk") included = isTestFile;
    else included = inTestDir || isTestFile;

    if (included) files.push(relative(root, path));
  }
}

/**
 * Collects test sources under the D0-QA-01 areas.
 *
 * `packages` scans every text file under a `test/` directory plus any
 * `*.test.ts`; `tools` and `sdk` scan only `*.test.ts` so checker fixtures are
 * not mistaken for real tags; `experiments` scans all text files.
 */
export function collectTestFiles(root: string): string[] {
  const absoluteRoot = resolve(root);
  const files: string[] = [];
  for (const area of ["packages", "tools", "sdk", "experiments"] as const) {
    const dir = join(absoluteRoot, area);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    walkArea(absoluteRoot, dir, area, false, files);
  }
  return files
    .map((file) => file.replace(/\\/g, "/"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Runs the full check and returns a deterministic report. */
export function checkTrace(options: TraceCheckOptions): TraceReport {
  const root = resolve(options.root);
  const traceabilityPath =
    options.traceabilityPath ?? join(root, "docs", "todos", "TRACEABILITY.md");
  const stage = options.stage ?? null;
  if (stage !== null && !STAGE_PATTERN.test(stage)) {
    throw new TraceCheckError(
      `invalid stage ${JSON.stringify(stage)}: expected a token such as "D0" or "P1"`,
    );
  }

  let markdown: string;
  try {
    markdown = readFileSync(traceabilityPath, "utf8");
  } catch (error) {
    throw new TraceCheckError(`cannot read ${traceabilityPath}: ${String(error)}`);
  }

  const rows = new Map(parseCanonicalRows(markdown).map(({ id, row }) => [id, row]));
  const canonicalIds = [...rows.keys()].sort(compareIds);
  const canonical = new Set(canonicalIds);
  const scannedFiles = collectTestFiles(root);

  const tags: TagLocation[] = [];
  for (const file of scannedFiles) {
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch (error) {
      throw new TraceCheckError(`cannot read test file ${file}: ${String(error)}`);
    }
    for (const tag of findTags(text)) {
      tags.push({ id: tag.id, file, line: tag.line });
    }
  }

  const taggedIds = [...new Set(tags.map((tag) => tag.id))].sort(compareIds);

  const filesById = new Map<string, Set<string>>();
  for (const tag of tags) {
    const files = filesById.get(tag.id) ?? new Set<string>();
    files.add(tag.file);
    filesById.set(tag.id, files);
  }
  const tagFilesById: Record<string, string[]> = {};
  for (const id of [...filesById.keys()].sort(compareIds)) {
    tagFilesById[id] = [...(filesById.get(id) ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /*
   * A stage run enforces only the requirement IDs that the matrix assigns to
   * that stage. Goals, experiments, capabilities and amendments are validated
   * when tagged but become required at the Gate's full-coverage audit.
   */
  const requiredIds =
    stage === null
      ? canonicalIds
      : canonicalIds.filter(
          (id) =>
            REQUIREMENT_PREFIX.test(id) &&
            rowMentionsStage(rows.get(id) ?? "", stage),
        );

  const missing = requiredIds.filter((id) => !taggedIds.includes(id));
  const deferred =
    stage === null
      ? []
      : canonicalIds.filter((id) => !requiredIds.includes(id) && !taggedIds.includes(id));
  const untagged = new Set([...missing, ...deferred]);
  const unknown = tags
    .filter((tag) => !canonical.has(tag.id))
    .filter(
      (tag, index, all) =>
        all.findIndex(
          (other) => other.id === tag.id && other.file === tag.file && other.line === tag.line,
        ) === index,
    )
    .sort((a, b) => {
      const idOrder = compareIds(a.id, b.id);
      if (idOrder !== 0) return idOrder;
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.line - b.line;
    });

  const prefixes: PrefixSummary[] = PREFIX_ORDER.map((prefix) => {
    const ids = canonicalIds.filter((id) => idParts(id).prefix === prefix);
    const missingForPrefix = ids.filter((id) => untagged.has(id));
    return {
      prefix,
      total: ids.length,
      covered: ids.length - missingForPrefix.length,
      missing: missingForPrefix,
    };
  }).filter((summary) => summary.total > 0);

  return {
    ok: missing.length === 0 && unknown.length === 0,
    traceabilityPath,
    stage,
    canonicalIds,
    requiredIds,
    taggedIds,
    missing,
    deferred,
    unknown,
    prefixes,
    scannedFiles,
    tagFilesById,
  };
}

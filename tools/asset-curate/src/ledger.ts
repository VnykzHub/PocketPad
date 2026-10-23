/**
 * LICENSES.csv rendering, parsing and validation.
 *
 * One row per committed file. The `file` column is the row key that a game's
 * `assets.json` cites in its `ledger` field (spec 23).
 */
import { GAME_IDS, type GameId } from "./selection.js";

export const LEDGER_COLUMNS = [
  "file",
  "id",
  "kind",
  "group",
  "bytes",
  "sha256",
  "parent",
  "source_pack",
  "source_path",
  "source_bytes",
  "source_sha256",
  "author",
  "licence",
  "licence_url",
  "licence_file",
  "source_url",
  "accessed",
  "attribution",
  "games",
  "derivation",
  "notes",
] as const;

export type LedgerColumn = (typeof LEDGER_COLUMNS)[number];

export interface LedgerRow {
  readonly file: string;
  readonly id: string;
  readonly kind: string;
  readonly group: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Owning asset id for a GLB texture dependency; empty for top-level assets. */
  readonly parent: string;
  readonly source_pack: string;
  readonly source_path: string;
  readonly source_bytes: number;
  readonly source_sha256: string;
  readonly author: string;
  readonly licence: string;
  readonly licence_url: string;
  readonly licence_file: string;
  readonly source_url: string;
  readonly accessed: string;
  readonly attribution: string;
  readonly games: string;
  readonly derivation: string;
  readonly notes: string;
}

const KINDS: ReadonlySet<string> = new Set(["mesh", "texture", "audio"]);
const ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GAME_SET: ReadonlySet<string> = new Set(GAME_IDS);

/** Quote a CSV field when it contains a comma, quote, CR or LF. */
function escapeField(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Deterministic ledger: fixed column order, rows sorted by file path. */
export function formatLedger(rows: readonly LedgerRow[]): string {
  const sorted = [...rows].sort((a, b) => a.file.localeCompare(b.file));
  const lines = [LEDGER_COLUMNS.join(",")];
  for (const row of sorted) {
    lines.push(LEDGER_COLUMNS.map((column) => escapeField(String(row[column]))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * RFC 4180-style parser. Supports quoted fields, escaped quotes and embedded
 * newlines; CRLF is normalised to LF.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char === "\r") {
      // Ignore CR; the following LF ends the record.
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface ParsedLedger {
  readonly header: readonly string[];
  readonly rows: readonly Record<string, string>[];
}

export function parseLedger(text: string): ParsedLedger {
  const table = parseCsv(text);
  const [header = [], ...body] = table;
  const rows = body
    .filter((line) => !(line.length === 1 && line[0] === ""))
    .map((line) => {
      const record: Record<string, string> = {};
      header.forEach((column, index) => {
        record[column] = line[index] ?? "";
      });
      return record;
    });
  return { header, rows };
}

export function ledgerKeysFromCsv(text: string): Set<string> {
  return new Set(parseLedger(text).rows.map((row) => row["file"] ?? "").filter(Boolean));
}

function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (path.includes("\\") || path.includes("://")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export interface LedgerValidationOptions {
  /** Curated output paths; every row must name one and every file needs a row. */
  readonly knownFiles?: ReadonlySet<string>;
}

/** Returns every defect, so one CLI run can fix a batch. */
export function validateLedger(
  parsed: ParsedLedger,
  options: LedgerValidationOptions = {},
): string[] {
  const errors: string[] = [];

  const expected = [...LEDGER_COLUMNS];
  if (parsed.header.length !== expected.length || parsed.header.some((column, index) => column !== expected[index])) {
    errors.push(`header must be exactly: ${expected.join(",")}`);
    return errors;
  }

  const files = new Set<string>();
  const ids = new Set<string>();
  for (const row of parsed.rows) {
    const file = row["file"] ?? "";
    const label = file === "" ? "(empty file)" : file;
    if (!isSafePath(file)) errors.push(`${label}: file must be a safe assets-relative path`);
    if (files.has(file)) errors.push(`${label}: duplicate file row`);
    files.add(file);
    if (options.knownFiles !== undefined && !options.knownFiles.has(file)) {
      errors.push(`${label}: row does not match a curated file`);
    }

    const id = row["id"] ?? "";
    if (!ID_PATTERN.test(id) || id.length > 64) errors.push(`${label}: invalid id "${id}"`);
    if (ids.has(id)) errors.push(`${label}: duplicate id "${id}"`);
    ids.add(id);

    if (!KINDS.has(row["kind"] ?? "")) errors.push(`${label}: kind must be mesh, texture or audio`);
    if (!/^[a-z0-9-]+$/.test(row["group"] ?? "")) errors.push(`${label}: invalid group`);

    const bytes = Number(row["bytes"]);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) errors.push(`${label}: bytes must be a positive integer`);
    const sourceBytes = Number(row["source_bytes"]);
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes <= 0) {
      errors.push(`${label}: source_bytes must be a positive integer`);
    }
    if (!SHA256_PATTERN.test(row["sha256"] ?? "")) errors.push(`${label}: sha256 must be 64 lowercase hex chars`);
    if (!SHA256_PATTERN.test(row["source_sha256"] ?? "")) {
      errors.push(`${label}: source_sha256 must be 64 lowercase hex chars`);
    }

    if ((row["source_pack"] ?? "") === "") errors.push(`${label}: source_pack is required`);
    if ((row["source_path"] ?? "") === "") errors.push(`${label}: source_path is required`);
    if ((row["author"] ?? "") === "") errors.push(`${label}: author is required`);
    if (row["licence"] !== "CC0 1.0") errors.push(`${label}: licence must be CC0 1.0 for this curated set`);
    if (!(row["licence_url"] ?? "").startsWith("https://")) errors.push(`${label}: licence_url must be https`);
    if ((row["licence_file"] ?? "") === "") errors.push(`${label}: licence_file is required`);
    if (!(row["source_url"] ?? "").startsWith("https://")) errors.push(`${label}: source_url must be https`);
    if (!DATE_PATTERN.test(row["accessed"] ?? "")) errors.push(`${label}: accessed must be YYYY-MM-DD`);
    if ((row["attribution"] ?? "") === "") errors.push(`${label}: attribution is required`);

    const games = (row["games"] ?? "").split(";").filter(Boolean);
    if (games.length === 0) errors.push(`${label}: at least one game is required`);
    for (const game of games) {
      if (!GAME_SET.has(game)) errors.push(`${label}: unknown game "${game}"`);
    }
  }

  if (options.knownFiles !== undefined) {
    for (const file of options.knownFiles) {
      if (!files.has(file)) errors.push(`${file}: curated file has no ledger row`);
    }
  }

  for (const row of parsed.rows) {
    const parent = row["parent"] ?? "";
    if (parent !== "" && !ids.has(parent)) {
      errors.push(`${row["file"] ?? ""}: parent "${parent}" is not a ledger id`);
    }
  }

  return errors;
}

export function gamesFromRow(row: LedgerRow): GameId[] {
  return row.games
    .split(";")
    .filter(Boolean)
    .filter((game): game is GameId => GAME_SET.has(game));
}

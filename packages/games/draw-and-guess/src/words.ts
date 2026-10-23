/**
 * Word pack parsing and guess normalization (GAME-DG-DATA-01,
 * GAME-DG-HOST-04).
 *
 * The shipped pack is a JSON object, not a bare array, so its license and
 * language travel with the words (the game plan rejects an array on
 * purpose). `parseWordPack` is the single validator: the shipped file and any
 * future pack go through it before a match can draw from it.
 *
 * Guess normalization is deliberately exact, never fuzzy:
 *
 * - Unicode NFKD decomposition, then combining marks are dropped, so
 *   "café" and "cafe" compare equal.
 * - Lowercase.
 * - Collapse every whitespace run to one space and trim the ends.
 *
 * The accent fold is additive to the plan's "trim, lowercase, collapse
 * spaces" rule: it never accepts a different word, only the same letters
 * typed with a different keyboard.
 */
import shippedPack from "../packs/words-family-v1.json";

/** Maximum accepted code points in one pack word. */
const MAX_WORD_CHARS = 40;
/** Lowercase words, single spaces/hyphens/apostrophes only. */
const WORD_PATTERN = /^[a-z][a-z '-]*$/;
const SUPPORTED_LICENSE = "CC0-1.0";
const COMBINING_MARKS = /\p{M}+/gu;
const WHITESPACE = /\s+/gu;

export interface WordPackMeta {
  readonly category: string;
  readonly language: string;
}

export interface WordPack {
  readonly id: string;
  readonly type: "word-list";
  readonly license: string;
  readonly items: readonly string[];
  readonly meta: WordPackMeta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`word pack: "${field}" must be a non-empty string`);
  }
  return value;
}

/**
 * Validates one pack value and returns a frozen-in-spirit view of it.
 *
 * Rejects: wrong type/license, an empty list, duplicate words, non-canonical
 * words (leading/trailing space, uppercase, double spaces, punctuation
 * outside the allowed set) and words over 40 code points. The rules are
 * intentionally stricter than the guess sanitizer: a pack is authored
 * content, not user input.
 */
export function parseWordPack(value: unknown): WordPack {
  if (!isRecord(value)) throw new Error("word pack: root must be an object");
  const id = nonEmptyString(value["id"], "id");
  const type = value["type"];
  if (type !== "word-list") throw new Error('word pack: "type" must be "word-list"');
  const license = nonEmptyString(value["license"], "license");
  if (license !== SUPPORTED_LICENSE) {
    throw new Error(`word pack: "license" must be ${SUPPORTED_LICENSE}`);
  }

  const rawItems = value["items"];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error('word pack: "items" must be a non-empty array');
  }

  const seen = new Set<string>();
  const items: string[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const raw = rawItems[index];
    if (typeof raw !== "string") {
      throw new Error(`word pack: item ${index} must be a string`);
    }
    if (raw.length > MAX_WORD_CHARS) {
      throw new Error(`word pack: item ${index} is longer than ${MAX_WORD_CHARS} code points`);
    }
    if (raw !== raw.trim() || raw !== normalizeWord(raw)) {
      throw new Error(`word pack: item ${index} is not canonical lowercase text`);
    }
    if (!WORD_PATTERN.test(raw)) {
      throw new Error(`word pack: item ${index} contains unsupported characters`);
    }
    if (seen.has(raw)) throw new Error(`word pack: duplicate item "${raw}"`);
    seen.add(raw);
    items.push(raw);
  }

  const meta = value["meta"];
  if (!isRecord(meta)) throw new Error('word pack: "meta" must be an object');
  const category = nonEmptyString(meta["category"], "meta.category");
  const language = nonEmptyString(meta["language"], "meta.language");

  return { id, type: "word-list", license, items, meta: { category, language } };
}

/** The validated shipped pack. Parsed once at module load. */
export function loadShippedWordPack(): WordPack {
  return parseWordPack(shippedPack);
}

/**
 * Exact guess comparison key: accent-folded, lowercase, collapsed spaces.
 * Returns "" for input that contains nothing but whitespace and marks.
 */
export function normalizeWord(text: string): string {
  return text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(WHITESPACE, " ")
    .trim();
}

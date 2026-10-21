/**
 * Private panel content contract (D5-SDK-01; FR-8.1, FR-8.4, SR-13).
 *
 * `PanelContent` is the only private-display format in v1. It is deliberately
 * data-only: there is no HTML/markup kind, so there is no injection path by
 * construction. Renderers must:
 * - assign every string with `textContent` (never `innerHTML`);
 * - accept an image `src` only after `isAllowedImageSrc` and assign it through
 *   `img.src`.
 *
 * Validation error strings are the stable public contract (there are no
 * numeric codes): they are field-addressed (`blocks[2].items[1]: ...`) and are
 * locked by `sdk/test/panel.test.ts`.
 *
 * The byte limit is below the 4096-byte JSON frame cap on purpose: the frame
 * includes the `{t:"panel",slot,content}` envelope, so a panel that fits the
 * frame has roughly 3.5 KiB of payload (D5-SDK-01 risk note).
 */

import { isAllowedImageSrc } from "./ugc.js";

export type PanelContent =
  | { kind: "text"; title?: string; text: string }
  | { kind: "blocks"; blocks: PanelBlock[] }
  | { kind: "image"; src: string; alt?: string; fit?: "contain" | "cover" };

export type PanelBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "image"; src: string; alt?: string };

/** Serialized content budget inside a 4096-byte frame (512-byte margin). */
export const MAX_PANEL_CONTENT_BYTES = 3_584;

const MAX_TITLE_CHARS = 80;
const MAX_TEXT_CHARS = 1_000;
const MAX_BLOCKS = 20;
const MAX_LIST_ITEMS = 12;
const MAX_LIST_ITEM_CHARS = 120;
const MAX_ALT_CHARS = 120;

const PANEL_KINDS = ["text", "blocks", "image"] as const;
const BLOCK_TYPES = ["heading", "paragraph", "list", "image"] as const;
const IMAGE_FITS = ["contain", "cover"] as const;

const FORBIDDEN_PANEL_CONTROL_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const FORBIDDEN_CONTROL_MESSAGE =
  "must not contain control characters other than tab, line feed and carriage return";
const IMAGE_SRC_MESSAGE =
  "must be a same-origin relative path or a data:image/(png|jpeg|webp);base64 URI";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Matches JSON Schema `minLength`/`maxLength`, which count code points. */
function charLength(text: string): number {
  return Array.from(text).length;
}

/** UTF-8 byte count without depending on `TextEncoder` or `Buffer`. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      bytes += 1;
    } else if (codePoint <= 0x7ff) {
      bytes += 2;
    } else if (codePoint <= 0xffff) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

/** Serialized wire size; `null` means the value cannot be serialized. */
function serializedByteSize(value: unknown): number | null {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  return serialized === undefined ? null : utf8ByteLength(serialized);
}

function fieldLabel(path: string, field: string): string {
  return path.length === 0 ? field : `${path}.${field}`;
}

/**
 * Validates one string field and reports length/control-character problems.
 * Required fields must be present; optional fields may be `undefined`.
 */
function validateStringField(
  record: UnknownRecord,
  field: string,
  path: string,
  errors: string[],
  maxChars: number,
  required: boolean,
): string | undefined {
  const label = fieldLabel(path, field);
  const value = record[field];

  if (value === undefined) {
    if (required) {
      errors.push(`${label}: required`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    errors.push(`${label}: must be a string`);
    return undefined;
  }

  const length = charLength(value);
  if (length > maxChars) {
    errors.push(`${label}: must be at most ${maxChars} characters (got ${length})`);
    return undefined;
  }
  if (FORBIDDEN_PANEL_CONTROL_PATTERN.test(value)) {
    errors.push(`${label}: ${FORBIDDEN_CONTROL_MESSAGE}`);
    return undefined;
  }
  return value;
}

/** Validates an image `src` plus the optional `alt`/`fit` fields. */
function validateImageFields(
  record: UnknownRecord,
  path: string,
  errors: string[],
  allowFit: boolean,
): void {
  const label = fieldLabel(path, "src");
  const src = record.src;

  if (src === undefined) {
    errors.push(`${label}: required`);
  } else if (typeof src !== "string") {
    errors.push(`${label}: must be a string`);
  } else if (!isAllowedImageSrc(src)) {
    errors.push(`${label}: ${IMAGE_SRC_MESSAGE}`);
  }

  validateStringField(record, "alt", path, errors, MAX_ALT_CHARS, false);

  if (!allowFit) {
    return;
  }
  const fit = record.fit;
  if (fit === undefined) {
    return;
  }
  if (typeof fit !== "string" || !(IMAGE_FITS as readonly string[]).includes(fit)) {
    errors.push(
      `${fieldLabel(path, "fit")}: must be one of ${IMAGE_FITS.map((item) => JSON.stringify(item)).join(", ")}`,
    );
  }
}

function validateListItems(block: UnknownRecord, path: string, errors: string[]): void {
  const items = block.items;

  if (items === undefined) {
    errors.push(`${path}.items: required`);
    return;
  }
  if (!Array.isArray(items)) {
    errors.push(`${path}.items: must be an array`);
    return;
  }
  if (items.length > MAX_LIST_ITEMS) {
    errors.push(
      `${path}.items: must contain at most ${MAX_LIST_ITEMS} entries (got ${items.length})`,
    );
  }

  for (let index = 0; index < items.length; index += 1) {
    const itemPath = `${path}.items[${index}]`;
    const item = items[index];
    if (typeof item !== "string") {
      errors.push(`${itemPath}: must be a string`);
      continue;
    }
    const length = charLength(item);
    if (length > MAX_LIST_ITEM_CHARS) {
      errors.push(
        `${itemPath}: must be at most ${MAX_LIST_ITEM_CHARS} characters (got ${length})`,
      );
      continue;
    }
    if (FORBIDDEN_PANEL_CONTROL_PATTERN.test(item)) {
      errors.push(`${itemPath}: ${FORBIDDEN_CONTROL_MESSAGE}`);
    }
  }
}

function validateBlock(block: unknown, path: string, errors: string[]): void {
  if (!isRecord(block)) {
    errors.push(`${path}: must be an object`);
    return;
  }

  const type = block.type;
  if (type === undefined) {
    errors.push(`${path}.type: required`);
    return;
  }
  if (typeof type !== "string") {
    errors.push(`${path}.type: must be a string`);
    return;
  }

  switch (type) {
    case "heading":
    case "paragraph": {
      validateStringField(block, "text", path, errors, MAX_TEXT_CHARS, true);
      break;
    }
    case "list": {
      validateListItems(block, path, errors);
      break;
    }
    case "image": {
      validateImageFields(block, path, errors, false);
      break;
    }
    default: {
      errors.push(
        `${path}.type: must be one of ${BLOCK_TYPES.map((item) => JSON.stringify(item)).join(", ")}`,
      );
    }
  }
}

function validateBlocksPanel(
  value: UnknownRecord,
  errors: string[],
): void {
  const blocks = value.blocks;
  if (blocks === undefined) {
    errors.push("blocks: required");
    return;
  }
  if (!Array.isArray(blocks)) {
    errors.push("blocks: must be an array");
    return;
  }
  if (blocks.length > MAX_BLOCKS) {
    errors.push(`blocks: must contain at most ${MAX_BLOCKS} entries (got ${blocks.length})`);
  }

  for (let index = 0; index < blocks.length; index += 1) {
    validateBlock(blocks[index], `blocks[${index}]`, errors);
  }
}

/**
 * Validates untrusted panel content. Returns every problem in one pass, except
 * non-serializable or oversized input, which fails fast to bound hostile work.
 * Extra properties are preserved for forward compatibility; the returned
 * content is the original value after validation.
 */
export function validatePanelContent(
  value: unknown,
): { ok: true; content: PanelContent } | { ok: false; errors: string[] } {
  if (!isRecord(value)) {
    return { ok: false, errors: ["panel: must be an object"] };
  }

  const byteSize = serializedByteSize(value);
  if (byteSize === null) {
    return { ok: false, errors: ["panel: must be JSON-serializable"] };
  }
  if (byteSize > MAX_PANEL_CONTENT_BYTES) {
    return {
      ok: false,
      errors: [
        `panel: serialized size ${byteSize} bytes exceeds the ${MAX_PANEL_CONTENT_BYTES}-byte limit`,
      ],
    };
  }

  const errors: string[] = [];
  const kind = value.kind;

  if (kind === undefined) {
    errors.push("kind: required");
  } else if (typeof kind !== "string") {
    errors.push("kind: must be a string");
  } else if (!(PANEL_KINDS as readonly string[]).includes(kind)) {
    errors.push(`kind: must be one of ${PANEL_KINDS.map((item) => JSON.stringify(item)).join(", ")}`);
  } else {
    switch (kind) {
      case "text": {
        validateStringField(value, "title", "", errors, MAX_TITLE_CHARS, false);
        validateStringField(value, "text", "", errors, MAX_TEXT_CHARS, true);
        break;
      }
      case "blocks": {
        validateBlocksPanel(value, errors);
        break;
      }
      case "image": {
        validateImageFields(value, "", errors, true);
        break;
      }
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, content: value as unknown as PanelContent };
}

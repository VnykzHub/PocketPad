/**
 * @lanpad/sdk game manifest contract (D0-SDK-01, FR-10.3).
 *
 * The manifest is the game boundary: the D3 loader consumes this exact type and
 * the P6 hub lists games by reading manifests, so adding a game never means
 * editing a switch statement.
 *
 * Validation is hand-written on purpose. The SDK keeps zero runtime
 * dependencies and must run in a browser without a JSON Schema library. The
 * matching schema lives in `sdk/schema/game-manifest.schema.json`; keep the two
 * in sync when the contract changes.
 */

export type GameCategory =
  | "party"
  | "arena"
  | "puzzle"
  | "racing"
  | "action"
  | "co-op"
  | "solo";

export type InputBadge =
  | "stick"
  | "dpad"
  | "buttons"
  | "triggers"
  | "gyro"
  | "haptics"
  | "text"
  | "canvas"
  | "choice";

/** Launcher metadata (spec 25). Absent fields use generated fallbacks. */
export interface GamePresentation {
  /** 1..80 chars, no control characters. */
  readonly tagline?: string;
  /** `#rrggbb` with at least 3:1 contrast against black. */
  readonly accent?: string;
  /** Asset id from `assets.json`; launcher thumbnail. */
  readonly thumbnail?: string;
  /** Asset id; Wave 2 launcher backdrop model. */
  readonly heroModel?: string;
  /** Max 3 unique values. */
  readonly categories?: readonly GameCategory[];
  /** Max 5 unique values; what a player needs to play. */
  readonly inputBadges?: readonly InputBadge[];
  readonly featured?: boolean;
}

export interface GameManifest {
  schemaVersion?: 1;
  name: string;
  /** Optional one-line launcher copy. Display only; the runtime never reads it. */
  description?: string;
  entry: string;
  layouts: string[];
  assetBudget: {
    initialBytes: number;
    totalBytes: number;
  };
  minPlayers: number;
  maxPlayers: number;
  needsGyro: boolean;
  /**
   * Renderer family the host must select (00 §5.12). Absent means
   * `"canvas2d"`, which keeps every existing manifest on the 2D path.
   * `"engine"` requires a WebGPU or WebGL2 device and is refused on the
   * Canvas2D fallback; it never silently downgrades. `"babylon"` selects the
   * Babylon.js backend (spec 21) with the same 3D requirement.
   */
  renderer?: "canvas2d" | "engine" | "babylon";
  chunkConfig?: {
    chunkSize: number;
    loadRadius: number;
    unloadRadius: number;
    lodTiers: number[];
  };
  /**
   * Optional game content version recorded in saves (18 §3.5). 1..32 UTF-8
   * bytes, no NUL, e.g. "1.2.0". When absent, the save layer requires the
   * game to supply `gameVersion` explicitly.
   */
  version?: string;
  /** Additive launcher metadata (spec 25); may be absent. */
  presentation?: GamePresentation;
}

const NAME_MIN_CHARS = 1;
const NAME_MAX_CHARS = 64;
const MIN_LAYOUTS = 1;
const MAX_LAYOUTS = 16;
const MIN_PLAYERS = 1;
const MAX_PLAYERS = 8;
const MIN_LOD_TIERS = 3;
const MAX_TAGLINE_CHARS = 80;
const MAX_CATEGORIES = 3;
const MAX_INPUT_BADGES = 5;
const MAX_ASSET_ID_CHARS = 64;

const CATEGORY_VALUES: ReadonlySet<string> = new Set([
  "party",
  "arena",
  "puzzle",
  "racing",
  "action",
  "co-op",
  "solo",
]);
const INPUT_BADGE_VALUES: ReadonlySet<string> = new Set([
  "stick",
  "dpad",
  "buttons",
  "triggers",
  "gyro",
  "haptics",
  "text",
  "canvas",
  "choice",
]);
const PRESENTATION_KEYS: ReadonlySet<string> = new Set([
  "tagline",
  "accent",
  "thumbnail",
  "heroModel",
  "categories",
  "inputBadges",
  "featured",
]);
const ASSET_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** WCAG relative luminance for `#rrggbb`; 0..1. */
function relativeLuminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  );
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Matches JSON Schema `minLength`/`maxLength`, which count code points. */
function charLength(text: string): number {
  return Array.from(text).length;
}

function isAbsoluteAssetPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path);
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]/).includes("..");
}

/**
 * Manifest paths are resolved inside the game folder. Absolute paths and any
 * `..` segment are rejected so a manifest cannot point at another game or a
 * server file.
 */
function validateAssetPath(label: string, path: string, errors: string[]): void {
  if (path.length === 0) {
    errors.push(`${label}: must be a non-empty relative path`);
    return;
  }
  if (isAbsoluteAssetPath(path)) {
    errors.push(`${label}: must be a relative path`);
    return;
  }
  if (hasParentSegment(path)) {
    errors.push(`${label}: must not contain ".." path segments`);
  }
}

/**
 * Validates an untrusted manifest value. Returns every problem in one pass so
 * third-party authors can fix a manifest in one edit rather than one error per
 * run. Unknown extra properties are preserved, matching the schema's additive
 * policy.
 */
function validateAssetId(
  path: string,
  value: unknown,
  errors: string[],
): void {
  if (typeof value !== "string") {
    errors.push(`${path}: must be an asset id string`);
    return;
  }
  if (value.length < 1 || value.length > MAX_ASSET_ID_CHARS) {
    errors.push(`${path}: must be 1..${MAX_ASSET_ID_CHARS} characters`);
    return;
  }
  if (!ASSET_ID_PATTERN.test(value)) {
    errors.push(`${path}: must be a lower-case asset id`);
  }
}

function validatePresentation(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("presentation: must be an object");
    return;
  }
  for (const key of Object.keys(value)) {
    if (!PRESENTATION_KEYS.has(key)) {
      errors.push(`presentation.${key}: unknown field`);
    }
  }

  if (value.tagline !== undefined) {
    if (typeof value.tagline !== "string") {
      errors.push("presentation.tagline: must be a string");
    } else {
      const tagline = value.tagline.trim();
      if (tagline.length < 1 || tagline.length > MAX_TAGLINE_CHARS) {
        errors.push(
          `presentation.tagline: must be 1..${MAX_TAGLINE_CHARS} characters`,
        );
      } else if (CONTROL_CHARACTER.test(tagline)) {
        errors.push("presentation.tagline: must not contain control characters");
      }
    }
  }

  if (value.accent !== undefined) {
    if (
      typeof value.accent !== "string" ||
      !/^#[0-9a-fA-F]{6}$/.test(value.accent)
    ) {
      errors.push("presentation.accent: must be #rrggbb");
    } else if (
      (relativeLuminance(value.accent) + 0.05) / 0.05 < 3
    ) {
      errors.push("presentation.accent: must have at least 3:1 contrast on black");
    }
  }

  if (value.thumbnail !== undefined) {
    validateAssetId("presentation.thumbnail", value.thumbnail, errors);
  }
  if (value.heroModel !== undefined) {
    validateAssetId("presentation.heroModel", value.heroModel, errors);
  }

  if (value.categories !== undefined) {
    if (!Array.isArray(value.categories)) {
      errors.push("presentation.categories: must be an array");
    } else if (value.categories.length > MAX_CATEGORIES) {
      errors.push(
        `presentation.categories: must contain at most ${MAX_CATEGORIES} values`,
      );
    } else {
      const seen = new Set<unknown>();
      for (let index = 0; index < value.categories.length; index += 1) {
        const category = value.categories[index];
        if (typeof category !== "string" || !CATEGORY_VALUES.has(category)) {
          errors.push(`presentation.categories[${index}]: unknown category`);
        } else if (seen.has(category)) {
          errors.push(`presentation.categories[${index}]: duplicate category`);
        }
        seen.add(category);
      }
    }
  }

  if (value.inputBadges !== undefined) {
    if (!Array.isArray(value.inputBadges)) {
      errors.push("presentation.inputBadges: must be an array");
    } else if (value.inputBadges.length > MAX_INPUT_BADGES) {
      errors.push(
        `presentation.inputBadges: must contain at most ${MAX_INPUT_BADGES} values`,
      );
    } else {
      const seen = new Set<unknown>();
      for (let index = 0; index < value.inputBadges.length; index += 1) {
        const badge = value.inputBadges[index];
        if (typeof badge !== "string" || !INPUT_BADGE_VALUES.has(badge)) {
          errors.push(`presentation.inputBadges[${index}]: unknown badge`);
        } else if (seen.has(badge)) {
          errors.push(`presentation.inputBadges[${index}]: duplicate badge`);
        }
        seen.add(badge);
      }
    }
  }

  if (value.featured !== undefined && typeof value.featured !== "boolean") {
    errors.push("presentation.featured: must be a boolean");
  }
}

export function validateManifest(
  value: unknown,
): { ok: true; manifest: GameManifest } | { ok: false; errors: string[] } {
  if (!isRecord(value)) {
    return { ok: false, errors: ["manifest: must be an object"] };
  }

  const errors: string[] = [];

  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    errors.push("schemaVersion: must be 1 when present");
  }

  if (value.name === undefined) {
    errors.push("name: required");
  } else if (typeof value.name !== "string") {
    errors.push("name: must be a string");
  } else {
    const length = charLength(value.name);
    if (length < NAME_MIN_CHARS || length > NAME_MAX_CHARS) {
      errors.push(`name: must be ${NAME_MIN_CHARS}..${NAME_MAX_CHARS} characters (got ${length})`);
    }
  }

  if (value.entry === undefined) {
    errors.push("entry: required");
  } else if (typeof value.entry !== "string") {
    errors.push("entry: must be a string");
  } else {
    validateAssetPath("entry", value.entry, errors);
  }

  if (value.layouts === undefined) {
    errors.push("layouts: required");
  } else if (!Array.isArray(value.layouts)) {
    errors.push("layouts: must be an array");
  } else {
    const layouts: unknown[] = value.layouts;
    if (layouts.length < MIN_LAYOUTS || layouts.length > MAX_LAYOUTS) {
      errors.push(
        `layouts: must contain ${MIN_LAYOUTS}..${MAX_LAYOUTS} entries (got ${layouts.length})`,
      );
    }
    for (let index = 0; index < layouts.length; index += 1) {
      const layout = layouts[index];
      if (typeof layout !== "string") {
        errors.push(`layouts[${index}]: must be a string`);
      } else {
        validateAssetPath(`layouts[${index}]`, layout, errors);
      }
    }
  }

  if (value.assetBudget === undefined) {
    errors.push("assetBudget: required");
  } else if (!isRecord(value.assetBudget)) {
    errors.push("assetBudget: must be an object");
  } else {
    const initial = value.assetBudget.initialBytes;
    const total = value.assetBudget.totalBytes;

    if (initial === undefined) {
      errors.push("assetBudget.initialBytes: required");
    } else if (!isPositiveNumber(initial)) {
      errors.push("assetBudget.initialBytes: must be a positive number");
    }

    if (total === undefined) {
      errors.push("assetBudget.totalBytes: required");
    } else if (!isPositiveNumber(total)) {
      errors.push("assetBudget.totalBytes: must be a positive number");
    }

    if (isPositiveNumber(initial) && isPositiveNumber(total) && initial > total) {
      errors.push("assetBudget.initialBytes: must be <= assetBudget.totalBytes");
    }
  }

  const minPlayers = value.minPlayers;
  const maxPlayers = value.maxPlayers;

  if (minPlayers === undefined) {
    errors.push("minPlayers: required");
  } else if (!isIntegerInRange(minPlayers, MIN_PLAYERS, MAX_PLAYERS)) {
    errors.push(`minPlayers: must be an integer ${MIN_PLAYERS}..${MAX_PLAYERS}`);
  }

  if (maxPlayers === undefined) {
    errors.push("maxPlayers: required");
  } else if (!isIntegerInRange(maxPlayers, MIN_PLAYERS, MAX_PLAYERS)) {
    errors.push(`maxPlayers: must be an integer ${MIN_PLAYERS}..${MAX_PLAYERS}`);
  }

  if (
    isIntegerInRange(minPlayers, MIN_PLAYERS, MAX_PLAYERS) &&
    isIntegerInRange(maxPlayers, MIN_PLAYERS, MAX_PLAYERS) &&
    minPlayers > maxPlayers
  ) {
    errors.push("maxPlayers: must be >= minPlayers");
  }

  if (value.needsGyro === undefined) {
    errors.push("needsGyro: required");
  } else if (typeof value.needsGyro !== "boolean") {
    errors.push("needsGyro: must be a boolean");
  }

  if (
    value.renderer !== undefined &&
    value.renderer !== "canvas2d" &&
    value.renderer !== "engine" &&
    value.renderer !== "babylon"
  ) {
    errors.push('renderer: must be "canvas2d", "engine" or "babylon"');
  }

  if (value.presentation !== undefined) {
    validatePresentation(value.presentation, errors);
  }

  if (value.chunkConfig !== undefined) {
    if (!isRecord(value.chunkConfig)) {
      errors.push("chunkConfig: must be an object");
    } else {
      const chunkConfig = value.chunkConfig;
      const chunkSize = chunkConfig.chunkSize;
      const loadRadius = chunkConfig.loadRadius;
      const unloadRadius = chunkConfig.unloadRadius;
      const lodTiers = chunkConfig.lodTiers;

      if (chunkSize === undefined) {
        errors.push("chunkConfig.chunkSize: required");
      } else if (!isPositiveNumber(chunkSize)) {
        errors.push("chunkConfig.chunkSize: must be a positive number");
      }

      if (loadRadius === undefined) {
        errors.push("chunkConfig.loadRadius: required");
      } else if (!isNonNegativeNumber(loadRadius)) {
        errors.push("chunkConfig.loadRadius: must be a non-negative number");
      }

      if (unloadRadius === undefined) {
        errors.push("chunkConfig.unloadRadius: required");
      } else if (!isNonNegativeNumber(unloadRadius)) {
        errors.push("chunkConfig.unloadRadius: must be a non-negative number");
      }

      if (lodTiers === undefined) {
        errors.push("chunkConfig.lodTiers: required");
      } else if (!Array.isArray(lodTiers)) {
        errors.push("chunkConfig.lodTiers: must be an array");
      } else {
        const tiers: unknown[] = lodTiers;
        if (tiers.length < MIN_LOD_TIERS) {
          errors.push(
            `chunkConfig.lodTiers: must contain at least ${MIN_LOD_TIERS} LOD tiers (got ${tiers.length})`,
          );
        }
        for (let index = 0; index < tiers.length; index += 1) {
          if (!isFiniteNumber(tiers[index])) {
            errors.push(`chunkConfig.lodTiers[${index}]: must be a number`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Every required field has been type-checked above; extra properties are
  // intentionally allowed so later schema versions can add fields.
  return { ok: true, manifest: value as unknown as GameManifest };
}

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
}

const NAME_MIN_CHARS = 1;
const NAME_MAX_CHARS = 64;
const MIN_LAYOUTS = 1;
const MAX_LAYOUTS = 16;
const MIN_PLAYERS = 1;
const MAX_PLAYERS = 8;
const MIN_LOD_TIERS = 3;

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

/**
 * Per-game asset manifest contract (spec 23; Wave 0).
 *
 * Pure validation only: no filesystem, fetch or DOM. The runtime loader (stream
 * B) checks real file bytes against these declarations; the curation CLI
 * (stream C) checks the ledger file. Both call this function first.
 */
import type { AssetKind } from "./game-api.js";

export type AssetGroupMode = "eager" | "lazy";

export interface AssetGroupDeclaration {
  readonly id: string;
  readonly mode: AssetGroupMode;
}

export interface AssetDeclaration {
  readonly id: string;
  /** Relative to the game folder; forward slashes only. */
  readonly path: string;
  readonly kind: AssetKind;
  /** Exact size in bytes. */
  readonly bytes: number;
  readonly group: string;
  /** Row key in the game's LICENSES.csv. */
  readonly ledger: string;
  /** Animation-group names, mesh assets only. */
  readonly clips?: readonly string[];
}

export interface GameAssetsManifest {
  readonly schemaVersion: 1;
  readonly groups: readonly AssetGroupDeclaration[];
  readonly assets: readonly AssetDeclaration[];
}

export type AssetManifestErrorCode =
  | "E_ASSET_SCHEMA"
  | "E_ASSET_DUPLICATE"
  | "E_ASSET_PATH"
  | "E_ASSET_KIND"
  | "E_ASSET_LEDGER"
  | "E_ASSET_BUDGET"
  | "E_ASSET_CLIP";

export interface AssetManifestError {
  readonly code: AssetManifestErrorCode;
  /** JSON path, e.g. `assets[2].ledger`. */
  readonly path: string;
  readonly message: string;
}

export type AssetManifestResult =
  | { readonly ok: true; readonly manifest: GameAssetsManifest }
  | { readonly ok: false; readonly errors: readonly AssetManifestError[] };

export interface AssetBudgetLimits {
  /** The manifest's `assetBudget.initialBytes`. */
  readonly initialBytes: number;
  /** The manifest's `assetBudget.totalBytes`. */
  readonly totalBytes: number;
}

/** Hard boot cap from the SPEC (host + game + boot assets). */
export const ASSET_BOOT_HARD_CAP_BYTES = 5 * 1024 * 1024;

const ASSET_KINDS: ReadonlySet<string> = new Set([
  "mesh",
  "texture",
  "material",
  "audio",
  "font",
  "json",
  "scene",
  "animation",
]);
const GROUP_MODES: ReadonlySet<string> = new Set(["eager", "lazy"]);
const ASSET_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)*$/;
const ASSET_KEYS: ReadonlySet<string> = new Set([
  "id",
  "path",
  "kind",
  "bytes",
  "group",
  "ledger",
  "clips",
]);
const GROUP_KEYS: ReadonlySet<string> = new Set(["id", "mode"]);
const ROOT_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "groups",
  "assets",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAssetId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 64 &&
    ASSET_ID_PATTERN.test(value)
  );
}

/**
 * Path safety: relative to the game folder, forward slashes, no `..`, no
 * absolute prefix, no drive letter and no scheme.
 */
export function isSafeAssetPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (path.includes("\\") || path.includes("://")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
    if (segment.includes("\u0000")) return false;
  }
  return true;
}

function push(
  errors: AssetManifestError[],
  code: AssetManifestErrorCode,
  path: string,
  message: string,
): void {
  errors.push({ code, path, message });
}

/**
 * Validates an untrusted `assets.json` value against the game's ledger and
 * budget. Returns every error, not just the first, so curation can fix a batch.
 */
export function validateAssetManifest(
  value: unknown,
  ledger: ReadonlySet<string>,
  budget: AssetBudgetLimits,
): AssetManifestResult {
  const errors: AssetManifestError[] = [];

  if (!isRecord(value)) {
    push(errors, "E_ASSET_SCHEMA", "", "must be an object");
    return { ok: false, errors };
  }
  for (const key of Object.keys(value)) {
    if (!ROOT_KEYS.has(key)) {
      push(errors, "E_ASSET_SCHEMA", key, "unknown field");
    }
  }
  if (value.schemaVersion !== 1) {
    push(errors, "E_ASSET_SCHEMA", "schemaVersion", "must be 1");
  }

  const groups: AssetGroupDeclaration[] = [];
  const groupIds = new Set<string>();
  if (!Array.isArray(value.groups)) {
    push(errors, "E_ASSET_SCHEMA", "groups", "must be an array");
  } else {
    for (let index = 0; index < value.groups.length; index += 1) {
      const raw = value.groups[index];
      const path = `groups[${index}]`;
      if (!isRecord(raw)) {
        push(errors, "E_ASSET_SCHEMA", path, "must be an object");
        continue;
      }
      for (const key of Object.keys(raw)) {
        if (!GROUP_KEYS.has(key)) {
          push(errors, "E_ASSET_SCHEMA", `${path}.${key}`, "unknown field");
        }
      }
      if (!isAssetId(raw.id)) {
        push(errors, "E_ASSET_SCHEMA", `${path}.id`, "must be a lower-case id");
        continue;
      }
      if (typeof raw.mode !== "string" || !GROUP_MODES.has(raw.mode)) {
        push(
          errors,
          "E_ASSET_SCHEMA",
          `${path}.mode`,
          'must be "eager" or "lazy"',
        );
        continue;
      }
      if (groupIds.has(raw.id)) {
        push(errors, "E_ASSET_DUPLICATE", `${path}.id`, "duplicate group id");
        continue;
      }
      groupIds.add(raw.id);
      groups.push({ id: raw.id, mode: raw.mode as AssetGroupMode });
    }
  }

  const assets: AssetDeclaration[] = [];
  const assetIds = new Set<string>();
  let bootBytes = 0;
  let totalBytes = 0;
  if (!Array.isArray(value.assets)) {
    push(errors, "E_ASSET_SCHEMA", "assets", "must be an array");
  } else {
    for (let index = 0; index < value.assets.length; index += 1) {
      const raw = value.assets[index];
      const path = `assets[${index}]`;
      if (!isRecord(raw)) {
        push(errors, "E_ASSET_SCHEMA", path, "must be an object");
        continue;
      }
      for (const key of Object.keys(raw)) {
        if (!ASSET_KEYS.has(key)) {
          push(errors, "E_ASSET_SCHEMA", `${path}.${key}`, "unknown field");
        }
      }
      if (!isAssetId(raw.id)) {
        push(errors, "E_ASSET_SCHEMA", `${path}.id`, "must be a lower-case id");
        continue;
      }
      if (assetIds.has(raw.id)) {
        push(errors, "E_ASSET_DUPLICATE", `${path}.id`, "duplicate asset id");
        continue;
      }
      assetIds.add(raw.id);

      if (typeof raw.path !== "string" || !isSafeAssetPath(raw.path)) {
        push(
          errors,
          "E_ASSET_PATH",
          `${path}.path`,
          "must be a relative path inside the game folder",
        );
      }
      if (typeof raw.kind !== "string" || !ASSET_KINDS.has(raw.kind)) {
        push(errors, "E_ASSET_KIND", `${path}.kind`, "unknown asset kind");
      }
      if (
        typeof raw.bytes !== "number" ||
        !Number.isInteger(raw.bytes) ||
        raw.bytes <= 0
      ) {
        push(
          errors,
          "E_ASSET_SCHEMA",
          `${path}.bytes`,
          "must be a positive integer",
        );
      }
      if (typeof raw.group !== "string" || !groupIds.has(raw.group)) {
        push(errors, "E_ASSET_SCHEMA", `${path}.group`, "unknown group");
      }
      if (typeof raw.ledger !== "string" || !ledger.has(raw.ledger)) {
        push(
          errors,
          "E_ASSET_LEDGER",
          `${path}.ledger`,
          "must name a row in LICENSES.csv",
        );
      }

      let clips: string[] | undefined;
      if (raw.clips !== undefined) {
        if (raw.kind !== "mesh") {
          push(
            errors,
            "E_ASSET_CLIP",
            `${path}.clips`,
            "clips are only valid on mesh assets",
          );
        } else if (
          !Array.isArray(raw.clips) ||
          raw.clips.some(
            (clip) => typeof clip !== "string" || clip.length === 0,
          )
        ) {
          push(
            errors,
            "E_ASSET_CLIP",
            `${path}.clips`,
            "must be a non-empty string array",
          );
        } else {
          clips = raw.clips as string[];
          if (new Set(clips).size !== clips.length) {
            push(
              errors,
              "E_ASSET_CLIP",
              `${path}.clips`,
              "must not contain duplicate clip names",
            );
          }
        }
      }

      if (
        typeof raw.bytes === "number" &&
        Number.isInteger(raw.bytes) &&
        raw.bytes > 0
      ) {
        totalBytes += raw.bytes;
        const group = groups.find((entry) => entry.id === raw.group);
        if (group?.mode === "eager") bootBytes += raw.bytes;
      }

      if (
        isAssetId(raw.id) &&
        typeof raw.path === "string" &&
        typeof raw.kind === "string" &&
        typeof raw.group === "string" &&
        typeof raw.ledger === "string" &&
        typeof raw.bytes === "number"
      ) {
        assets.push({
          id: raw.id,
          path: raw.path,
          kind: raw.kind as AssetKind,
          bytes: raw.bytes,
          group: raw.group,
          ledger: raw.ledger,
          ...(clips !== undefined ? { clips } : {}),
        });
      }
    }
  }

  if (bootBytes > budget.initialBytes) {
    push(
      errors,
      "E_ASSET_BUDGET",
      "assets",
      `eager bytes ${bootBytes} exceed initialBytes ${budget.initialBytes}`,
    );
  }
  if (bootBytes > ASSET_BOOT_HARD_CAP_BYTES) {
    push(
      errors,
      "E_ASSET_BUDGET",
      "assets",
      `eager bytes ${bootBytes} exceed the 5 MiB boot cap`,
    );
  }
  if (totalBytes > budget.totalBytes) {
    push(
      errors,
      "E_ASSET_BUDGET",
      "assets",
      `total bytes ${totalBytes} exceed totalBytes ${budget.totalBytes}`,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: { schemaVersion: 1, groups, assets },
  };
}

/**
 * Spec-23 `assets.json` glue (stream B).
 *
 * `loadGame` fetches `assets.json` and `LICENSES.csv` next to the manifest,
 * validates the declarations with the SDK, and returns a `LoadedGameAssets`
 * value. This module turns that value into the runtime `GameAssetLibrary` and
 * parses the ledger. It never fetches anything itself.
 */
import type {
  AssetBudgetLimits,
  AssetManifestError,
  AssetProgress,
  GameAssetsManifest,
} from "@lanpad/sdk";
import { GameAssetLibrary } from "./GameAssetLibrary.js";
import type {
  GameAssetDecodeHooks,
  GameAssetLibraryOptions,
} from "./GameAssetLibrary.js";
import type {
  AssetProgress as LoadProgress,
  FetchLike,
} from "./AssetLoader.js";

/** A validated per-game asset manifest and where it came from. */
export interface LoadedGameAssets {
  readonly manifest: GameAssetsManifest;
  /** Absolute URL of `assets.json`. */
  readonly assetsUrl: string;
  /** Absolute URL of `LICENSES.csv`. */
  readonly ledgerUrl: string;
  /** Game folder URL, ending in "/"; asset paths resolve against it. */
  readonly baseUrl: string;
  /** `manifest.assetBudget` from `game.manifest.json`. */
  readonly budget: AssetBudgetLimits;
}

export interface GameAssetLoadOptions {
  readonly fetch?: FetchLike;
  readonly decode?: GameAssetDecodeHooks;
  readonly bootCapBytes?: number;
  readonly signal?: AbortSignal;
}

/**
 * Builds the boot/lazy asset library. The constructor re-checks budgets and
 * fetches nothing, so an over-budget set fails before the first request.
 */
export function createGameAssetLibrary(
  assets: LoadedGameAssets,
  options: GameAssetLoadOptions = {},
): GameAssetLibrary {
  const libraryOptions: GameAssetLibraryOptions = {
    manifest: assets.manifest,
    baseUrl: assets.baseUrl,
    budget: assets.budget,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.decode !== undefined ? { decode: options.decode } : {}),
    ...(options.bootCapBytes !== undefined
      ? { bootCapBytes: options.bootCapBytes }
      : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  return new GameAssetLibrary(libraryOptions);
}

/**
 * Parses the `file` column of a game's `LICENSES.csv` into the row-key set
 * `validateAssetManifest` expects. Handles a UTF-8 BOM, CRLF, blank lines,
 * `#` comments and quoted fields with embedded commas or doubled quotes.
 * Falls back to the first column when the header has no `file` column, which
 * matches the hand-written ledgers already in the repo.
 */
export function parseLicenseLedger(text: string): Set<string> {
  const rows = new Set<string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let fileIndex: number | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (line.trimStart().startsWith("#")) continue;
    const fields = parseCsvLine(line);
    if (fileIndex === null) {
      const lower = fields.map((field) => field.trim().toLowerCase());
      const index = lower.indexOf("file");
      fileIndex = index >= 0 ? index : 0;
      continue;
    }
    const key = fields[fileIndex]?.trim();
    if (key !== undefined && key.length > 0) rows.add(key);
  }
  return rows;
}

/** One-line detail list for `GameLoadError.details` and the error notice. */
export function describeAssetManifestErrors(
  errors: readonly AssetManifestError[],
): string[] {
  return errors.map((error) =>
    error.path.length === 0
      ? `${error.code}: ${error.message}`
      : `${error.code} ${error.path}: ${error.message}`,
  );
}

/** Adapts SDK asset progress to the host's `AssetLoader` progress shape. */
export function toLoadProgress(progress: AssetProgress): LoadProgress {
  const fraction =
    progress.determinate && progress.declared > 0
      ? Math.min(1, progress.fetched / progress.declared)
      : null;
  return {
    loadedBytes: progress.fetched,
    totalBytes: progress.declared,
    determinate: progress.determinate,
    fraction,
    loadedCount: progress.loadedCount,
    totalCount: progress.totalCount,
    currentUrl: progress.currentId,
    done: progress.state === "ready",
  };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === undefined) break;
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}

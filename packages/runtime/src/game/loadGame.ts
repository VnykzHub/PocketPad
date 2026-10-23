/**
 * Manifest-driven game loader (D3-SDK-01; FR-10.3, G3, G8).
 *
 * `loadGame(manifestUrl)`:
 * 1. fetches the manifest and validates it with the SDK validator, so a bad
 *    manifest fails before any code is imported;
 * 2. resolves `entry` relative to the manifest URL and rejects anything that
 *    escapes the manifest's directory (other origins, schemes, `..`);
 * 3. discovers `assets.json` + `LICENSES.csv` next to the manifest and
 *    validates them against the manifest budget (spec 23); a missing
 *    `assets.json` is allowed, a missing ledger is not;
 * 4. dynamic-imports the entry, checks the `GameModule` shape and calls the
 *    default factory with the manifest;
 * 5. checks the returned object implements `Game`.
 *
 * Every failure is a `GameLoadError` with a readable message so the host can
 * show an error screen instead of wedging.
 *
 * Bundled games (the cube demo) use the same path: the host passes an
 * `importModule` that maps the resolved entry URL to a bundler chunk; any URL
 * not in that map falls through to a real dynamic import.
 */
import {
  validateAssetManifest,
  validateManifest,
  type AssetBudgetLimits,
  type Game,
  type GameManifest,
} from "@lanpad/sdk";
import type { AssetEntry } from "../assets/AssetLoader.js";
import {
  describeAssetManifestErrors,
  parseLicenseLedger,
  type LoadedGameAssets,
} from "../assets/gameAssets.js";

export type GameLoadErrorCode =
  | "fetch"
  | "invalidManifest"
  | "badEntry"
  | "assets"
  | "import"
  | "badModule"
  | "factory"
  | "budget";

export class GameLoadError extends Error {
  readonly code: GameLoadErrorCode;
  readonly details: readonly string[];

  constructor(code: GameLoadErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = "GameLoadError";
    this.code = code;
    this.details = details;
  }
}

export interface LoadGameDeps {
  /** Fetches and parses the manifest JSON. Defaults to `fetch`. */
  readonly fetchJson?: (url: string) => Promise<unknown>;
  /**
   * Fetches a text file next to the manifest. `null` means the file does not
   * exist (HTTP 404). Defaults to `fetch` + `response.text()`.
   */
  readonly fetchText?: (url: string) => Promise<string | null>;
  /** Imports the resolved entry. Defaults to native dynamic `import()`. */
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Base for a relative `manifestUrl`. Defaults to `document.baseURI`. */
  readonly baseUrl?: string;
}

export interface LoadedGame {
  readonly game: Game;
  readonly manifest: GameManifest;
  readonly manifestUrl: string;
  readonly entryUrl: string;
  /** Validated spec-23 asset manifest, or null when the game has none. */
  readonly assets: LoadedGameAssets | null;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

async function defaultFetchText(url: string): Promise<string | null> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

function defaultImportModule(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url) as Promise<unknown>;
}

function defaultBaseUrl(): string | undefined {
  return typeof document === "undefined" ? undefined : document.baseURI;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Resolves `entry` against the manifest URL. The result must stay on the
 * manifest's origin and inside its directory (FR-10.3).
 */
export function resolveGameEntry(manifestUrl: string, entry: string): string {
  if (SCHEME.test(entry) || entry.startsWith("/") || entry.startsWith("\\")) {
    throw new GameLoadError("badEntry", `Game entry "${entry}" must be a relative path.`);
  }
  let manifest: URL;
  let directory: URL;
  let resolved: URL;
  try {
    manifest = new URL(manifestUrl);
    directory = new URL(".", manifest);
    resolved = new URL(entry, manifest);
  } catch {
    throw new GameLoadError(
      "badEntry",
      `Game entry "${entry}" cannot be resolved against ${manifestUrl}.`,
    );
  }
  if (
    resolved.origin !== directory.origin ||
    !resolved.pathname.startsWith(directory.pathname) ||
    resolved.pathname === directory.pathname
  ) {
    throw new GameLoadError(
      "badEntry",
      `Game entry "${entry}" escapes the game folder ${directory.pathname}.`,
    );
  }
  return resolved.href;
}

function absoluteManifestUrl(manifestUrl: string, baseUrl: string | undefined): string {
  try {
    return new URL(manifestUrl, baseUrl).href;
  } catch {
    throw new GameLoadError("fetch", `Manifest URL "${manifestUrl}" is not a valid URL.`);
  }
}

const GAME_METHODS = ["init", "simulate", "render", "dispose"] as const;

function missingGameMethods(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return ["game: factory must return an object"];
  }
  const record = value as Record<string, unknown>;
  const missing: string[] = [];
  for (const name of GAME_METHODS) {
    if (typeof record[name] !== "function") {
      missing.push(`game.${name}: must be a function`);
    }
  }
  if (record["onEvent"] !== undefined && typeof record["onEvent"] !== "function") {
    missing.push("game.onEvent: must be a function when present");
  }
  return missing;
}

/**
 * Discovers `assets.json` next to the manifest (spec 23). A 404 from
 * `fetchText` means the game ships without assets. When `assets.json` exists,
 * `LICENSES.csv` is required and every declaration is validated against it and
 * against the manifest's `assetBudget` before any game code is imported.
 */
async function discoverGameAssets(
  manifestUrl: string,
  manifest: GameManifest,
  fetchText: (url: string) => Promise<string | null>,
): Promise<LoadedGameAssets | null> {
  const directory = new URL(".", manifestUrl);
  const assetsUrl = new URL("assets.json", directory).href;
  const ledgerUrl = new URL("LICENSES.csv", directory).href;

  let assetsText: string | null;
  try {
    assetsText = await fetchText(assetsUrl);
  } catch (error) {
    throw new GameLoadError(
      "assets",
      `Could not load the asset manifest ${assetsUrl}: ${message(error)}.`,
    );
  }
  if (assetsText === null) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(assetsText) as unknown;
  } catch (error) {
    throw new GameLoadError(
      "assets",
      `${assetsUrl} is not valid JSON: ${message(error)}.`,
    );
  }

  let ledgerText: string | null;
  try {
    ledgerText = await fetchText(ledgerUrl);
  } catch (error) {
    throw new GameLoadError(
      "assets",
      `Could not load the asset ledger ${ledgerUrl}: ${message(error)}.`,
    );
  }
  if (ledgerText === null) {
    throw new GameLoadError(
      "assets",
      `"${manifest.name}" declares assets.json but has no LICENSES.csv.`,
      ["E_ASSET_LEDGER: every game with assets.json needs a LICENSES.csv ledger"],
    );
  }

  const budget: AssetBudgetLimits = {
    initialBytes: manifest.assetBudget.initialBytes,
    totalBytes: manifest.assetBudget.totalBytes,
  };
  const validation = validateAssetManifest(
    raw,
    parseLicenseLedger(ledgerText),
    budget,
  );
  if (!validation.ok) {
    const details = describeAssetManifestErrors(validation.errors);
    throw new GameLoadError(
      "assets",
      `"${manifest.name}" has an invalid assets.json: ${details.join("; ")}.`,
      details,
    );
  }

  return {
    manifest: validation.manifest,
    assetsUrl,
    ledgerUrl,
    baseUrl: directory.href,
    budget,
  };
}

export async function loadGame(
  manifestUrl: string,
  deps: LoadGameDeps = {},
): Promise<LoadedGame> {
  const url = absoluteManifestUrl(manifestUrl, deps.baseUrl ?? defaultBaseUrl());
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const importModule = deps.importModule ?? defaultImportModule;

  let raw: unknown;
  try {
    raw = await fetchJson(url);
  } catch (error) {
    throw new GameLoadError("fetch", `Could not load the game manifest: ${message(error)}.`);
  }

  const validation = validateManifest(raw);
  if (!validation.ok) {
    throw new GameLoadError(
      "invalidManifest",
      `The game manifest is invalid: ${validation.errors.join("; ")}.`,
      validation.errors,
    );
  }
  const manifest = validation.manifest;
  const entryUrl = resolveGameEntry(url, manifest.entry);
  const fetchText = deps.fetchText ?? defaultFetchText;
  const assets = await discoverGameAssets(url, manifest, fetchText);

  let module: unknown;
  try {
    module = await importModule(entryUrl);
  } catch (error) {
    throw new GameLoadError("import", `Could not load "${manifest.name}": ${message(error)}.`);
  }

  const factory =
    typeof module === "object" && module !== null
      ? (module as Record<string, unknown>)["default"]
      : undefined;
  if (typeof factory !== "function") {
    throw new GameLoadError(
      "badModule",
      `"${manifest.name}" entry must default-export a (manifest) => Game factory.`,
    );
  }

  let game: unknown;
  try {
    game = (factory as (manifest: GameManifest) => unknown)(manifest);
  } catch (error) {
    throw new GameLoadError("factory", `"${manifest.name}" failed to start: ${message(error)}.`);
  }

  const missing = missingGameMethods(game);
  if (missing.length > 0) {
    throw new GameLoadError(
      "badModule",
      `"${manifest.name}" did not return a valid Game: ${missing.join("; ")}.`,
      missing,
    );
  }

  return { game: game as Game, manifest, manifestUrl: url, entryUrl, assets };
}

/**
 * Checks declared asset bytes against `manifest.assetBudget` (G3). Entries
 * without a `group` are the initial download. Returns readable errors; empty
 * means within budget. Unknown sizes cannot be checked here; the loader's
 * byte counting still enforces its own 5 MB cap while streaming.
 */
export function checkAssetBudget(
  manifest: GameManifest,
  entries: readonly AssetEntry[],
): string[] {
  let initial = 0;
  let total = 0;
  for (const entry of entries) {
    const bytes = entry.bytes ?? 0;
    total += bytes;
    if (entry.group === undefined) initial += bytes;
  }
  const errors: string[] = [];
  if (initial > manifest.assetBudget.initialBytes) {
    errors.push(
      `initial assets declare ${initial} bytes, over the ${manifest.assetBudget.initialBytes}-byte budget`,
    );
  }
  if (total > manifest.assetBudget.totalBytes) {
    errors.push(
      `assets declare ${total} bytes, over the ${manifest.assetBudget.totalBytes}-byte total budget`,
    );
  }
  return errors;
}

/** Throws a `GameLoadError("budget")` when `checkAssetBudget` fails. */
export function assertAssetBudget(manifest: GameManifest, entries: readonly AssetEntry[]): void {
  const errors = checkAssetBudget(manifest, entries);
  if (errors.length > 0) {
    throw new GameLoadError(
      "budget",
      `"${manifest.name}" is over its asset budget: ${errors.join("; ")}.`,
      errors,
    );
  }
}

/**
 * Importer for games bundled with the host. Keys are resolved entry URLs;
 * anything else falls through to `fallback` (native import by default).
 */
export function bundledGameImporter(
  modules: Readonly<Record<string, () => Promise<unknown>>>,
  fallback: (url: string) => Promise<unknown> = defaultImportModule,
): (url: string) => Promise<unknown> {
  return (url: string) => {
    const load = Object.prototype.hasOwnProperty.call(modules, url) ? modules[url] : undefined;
    return load !== undefined ? load() : fallback(url);
  };
}

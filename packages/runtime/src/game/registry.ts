/**
 * Bundled game registry (D7-SDK-01).
 *
 * Games live as folders under `packages/games/<slug>/` with a
 * `game.manifest.json` and an `entry` module. The host does not hand-list
 * games: Vite discovers every manifest at build time and this registry turns
 * the manifests into the frozen `GameEntry` view the hub and the direct game
 * route consume.
 *
 * Discovery is a build-time transform (`import.meta.glob`), so the manifest
 * data is bundled into the host; the runtime still fetches the same manifest
 * over HTTP through `loadGame`, which is what validates an untrusted game at
 * the network boundary. This module validates the *bundled* copies eagerly so
 * a broken game fails the build/test instead of failing on a TV at runtime.
 *
 * Invalid manifests throw `GameRegistryError` with the offending path and every
 * schema error. Duplicate slugs also throw, so a new game cannot silently
 * shadow another.
 */
import type { GameManifest } from "@lanpad/sdk";
import { validateManifest } from "@lanpad/sdk";

/** One game as the hub lists it (frozen shape from D7-SDK-01). */
export interface GameEntry {
  /** Folder name and URL segment under `/games/<slug>/`. */
  readonly slug: string;
  /** Human-readable manifest name (sorted by this). */
  readonly name: string;
  /** Optional one-line launcher copy; empty when the manifest omits it. */
  readonly description: string;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly needsGyro: boolean;
  /** Root-absolute manifest URL the host's `loadGame` fetches. */
  readonly manifestUrl: string;
}

/** A manifest discovered on disk, with the path used in error messages. */
export interface GameSource {
  readonly slug: string;
  /** Raw manifest JSON, not yet validated. */
  readonly manifest: unknown;
  /** Build-time module path, e.g. `../../../games/reaction-duel/game.manifest.json`. */
  readonly sourcePath?: string;
}

/** Thrown for an invalid or duplicated bundled manifest. */
export class GameRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameRegistryError";
  }
}

/** Every bundled game manifest, transformed by Vite at build time. */
const discoveredManifests: Readonly<Record<string, unknown>> = import.meta.glob(
  "../../../games/*/game.manifest.json",
  { eager: true, import: "default" },
) as Readonly<Record<string, unknown>>;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** `/games/<slug>/game.manifest.json`, the URL the dev server serves. */
export function manifestUrlFor(slug: string): string {
  return `/games/${slug}/game.manifest.json`;
}

/** Extracts `<slug>` from a build-time `.../games/<slug>/game.manifest.json`. */
export function slugFromManifestPath(modulePath: string): string | null {
  const normalized = modulePath.replace(/\\/g, "/");
  const match = /(?:^|\/)games\/([^/]+)\/game\.manifest\.json$/.exec(normalized);
  return match?.[1] ?? null;
}

/** Returns every discovered manifest, sorted by path for deterministic output. */
export function discoverBundledGames(): ReadonlyArray<GameSource> {
  const paths = Object.keys(discoveredManifests).sort();
  const sources: GameSource[] = [];
  for (const sourcePath of paths) {
    const slug = slugFromManifestPath(sourcePath);
    if (slug === null) {
      throw new GameRegistryError(
        `Bundled manifest is not inside a games/<slug>/ folder: ${sourcePath}`,
      );
    }
    sources.push({ slug, manifest: discoveredManifests[sourcePath], sourcePath });
  }
  return sources;
}

/**
 * Validates every source, rejects duplicate slugs, and returns frozen entries
 * sorted by display name (then slug, so ties stay deterministic).
 */
export function createGameRegistry(
  sources: ReadonlyArray<GameSource>,
): ReadonlyArray<GameEntry> {
  const bySlug = new Map<string, GameEntry>();

  for (const source of sources) {
    const where = source.sourcePath ?? source.slug;
    if (!SLUG_PATTERN.test(source.slug)) {
      throw new GameRegistryError(
        `Invalid game slug "${source.slug}" (${where}): use lowercase letters, digits and hyphens.`,
      );
    }
    if (bySlug.has(source.slug)) {
      throw new GameRegistryError(
        `Duplicate game slug "${source.slug}": ${where} collides with another bundled game.`,
      );
    }

    const result = validateManifest(source.manifest);
    if (!result.ok) {
      throw new GameRegistryError(
        `Invalid manifest for "${source.slug}" (${where}): ${result.errors.join("; ")}`,
      );
    }
    const manifest: GameManifest = result.manifest;
    // `description` is additive and optional; validators preserve extra
    // properties, so read it defensively rather than trusting the cast.
    const rawDescription = (manifest as { description?: unknown }).description;
    const description =
      typeof rawDescription === "string" ? rawDescription.trim() : "";
    bySlug.set(
      source.slug,
      Object.freeze({
        slug: source.slug,
        name: manifest.name,
        description,
        minPlayers: manifest.minPlayers,
        maxPlayers: manifest.maxPlayers,
        needsGyro: manifest.needsGyro,
        manifestUrl: manifestUrlFor(source.slug),
      }),
    );
  }

  const entries = [...bySlug.values()];
  entries.sort(
    (a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug),
  );
  return Object.freeze(entries);
}

let cachedGames: ReadonlyArray<GameEntry> | null = null;

/**
 * The bundled games the host may launch, sorted by name. Discovered once and
 * frozen; the result is stable for the lifetime of the page.
 */
export function getGames(): ReadonlyArray<GameEntry> {
  cachedGames ??= createGameRegistry(discoverBundledGames());
  return cachedGames;
}

/**
 * Games shipped inside the host bundle (D3-SDK-01, D7-SDK-01).
 *
 * The cube demo's manifest is a real file served next to the host page
 * (`public/demo/cube-demo/game.manifest.json`). Its `entry` resolves to
 * `<manifest dir>/index.js`; in the bundled host that URL maps to a Vite
 * chunk instead of a separately served file. `loadGame` still fetches and
 * validates the manifest and resolves the entry exactly as for any game; only
 * the final import goes through this table. Unknown URLs fall through to a
 * native dynamic import.
 *
 * Reaction Duel and future bundled games follow the same path: every
 * `packages/games/<slug>/src/game.ts` is a lazy Vite chunk, discovered at
 * build time, and its resolved `/games/<slug>/<entry>` URL is mapped here.
 * The manifest itself is still fetched from the dev server / host origin, so
 * the network boundary is unchanged.
 */
import { validateManifest } from "@lanpad/sdk";
import { bundledGameImporter } from "../game/loadGame.js";
import {
  discoverBundledGames,
  getGames,
  manifestUrlFor,
  type GameEntry,
} from "../game/registry.js";

/** Relative to the host page (`document.baseURI`). */
export const CUBE_DEMO_MANIFEST_PATH = "demo/cube-demo/game.manifest.json";

export function cubeDemoManifestUrl(baseUrl: string): string {
  return new URL(CUBE_DEMO_MANIFEST_PATH, baseUrl).href;
}

/**
 * Lazy loaders for every `packages/games/<slug>/src/game.ts`, keyed by slug.
 * Vite splits each into its own chunk; nothing is imported until a game boots.
 */
const gameLoaders: ReadonlyMap<string, () => Promise<unknown>> = (() => {
  const modules = import.meta.glob("../../../games/*/src/game.ts") as Readonly<
    Record<string, () => Promise<unknown>>
  >;
  const loaders = new Map<string, () => Promise<unknown>>();
  for (const [modulePath, load] of Object.entries(modules)) {
    const match = /(?:^|\/)games\/([^/]+)\/src\/game\.ts$/.exec(
      modulePath.replace(/\\/g, "/"),
    );
    const slug = match?.[1];
    if (slug !== undefined) {
      loaders.set(slug, load);
    }
  }
  return loaders;
})();

/**
 * Resolved entry URL for each bundled game, using the same URL resolution as
 * `loadGame`: `<manifest dir>/<manifest.entry>`. Manifests that fail
 * validation are left to `getGames()` to report with its richer message.
 */
function bundledEntryUrls(baseUrl: string): Map<string, () => Promise<unknown>> {
  const entries = new Map<string, () => Promise<unknown>>();
  for (const source of discoverBundledGames()) {
    const load = gameLoaders.get(source.slug);
    if (load === undefined) continue;
    const result = validateManifest(source.manifest);
    if (!result.ok) continue;
    const manifestUrl = new URL(manifestUrlFor(source.slug), baseUrl).href;
    entries.set(new URL(result.manifest.entry, manifestUrl).href, load);
  }
  return entries;
}

export function createBundledGameImporter(
  baseUrl: string,
  fallback?: (url: string) => Promise<unknown>,
): (url: string) => Promise<unknown> {
  const modules: Record<string, () => Promise<unknown>> = {
    [new URL("index.js", cubeDemoManifestUrl(baseUrl)).href]: () =>
      import("./cube-demo/index.js"),
  };
  for (const [url, load] of bundledEntryUrls(baseUrl)) {
    // The cube demo keeps its mapping if a game folder ever reuses its slug.
    modules[url] ??= load;
  }
  return bundledGameImporter(modules, fallback);
}

/** Everything the boot path needs to launch a bundled game. */
export interface BundledGames {
  /** Manifest-derived entries, sorted by name. */
  readonly games: ReadonlyArray<GameEntry>;
  /** Maps resolved entry URLs to Vite chunks; falls back to native import. */
  readonly importModule: (url: string) => Promise<unknown>;
}

/**
 * One call the host makes at boot:
 *
 *   const { games, importModule } = createBundledGames(document.baseURI);
 *
 * `games` feeds the hub and the direct `/games/<slug>/` route; `importModule`
 * is passed to `loadGame(entry.manifestUrl, { importModule })`.
 */
export function createBundledGames(
  baseUrl: string,
  fallback?: (url: string) => Promise<unknown>,
): BundledGames {
  return {
    games: getGames(),
    importModule: createBundledGameImporter(baseUrl, fallback),
  };
}

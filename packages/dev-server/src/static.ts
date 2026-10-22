/**
 * Static serving and header policy for the dev server (D0-SRV-01).
 *
 * Each URL prefix is mounted on its own `sirv` instance. Only the host root
 * and the controller root use SPA fallback; assets, games and experiments
 * return 404 for missing files so a missing bundle can never be masked by
 * `index.html` (D0 risk note).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import sirv from "sirv";

/** Frozen static roots shape from D0-SRV-01. */
export interface StaticRoots {
  /** Host page build, `packages/runtime/dist`. */
  host: string;
  /** Controller page build, `packages/controller/dist`. */
  controller: string;
  /** Game bundles, `packages/games/dist`. */
  games: string;
  /**
   * Game sources, `packages/games` (D7-SDK-01). Used as a `/games/*` fallback
   * so manifests and layouts are servable before a game bundle is built.
   * Only `game.manifest.json` and `layouts/*.json` are ever served from here.
   */
  gameSources?: string;
  /** Experiment pages, `experiments`. */
  experiments: string;
}

export type StaticRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

export interface StaticHandlers {
  host: StaticRequestHandler;
  /** Host files without SPA fallback (e.g. `/demo/*` manifests and assets). */
  hostFiles: StaticRequestHandler;
  controller: StaticRequestHandler;
  games: StaticRequestHandler;
  /** Present only when `roots.gameSources` is configured. */
  gameSources?: StaticRequestHandler;
  experiments: StaticRequestHandler;
  assets: StaticRequestHandler;
}

/** Dev CSP from D0-SRV-01. Kept in one place so tests assert the exact string. */
export const DEV_CSP =
  "default-src 'self'; connect-src 'self' ws:; img-src 'self' data:; " +
  "script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const NO_STORE_CACHE_CONTROL = "no-store";

type CachePolicy = "spa" | "no-store" | "immutable";

/** Applies the D0 security headers. No CORS headers are ever added. */
export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", DEV_CSP);
}

/**
 * HTML and extensionless routes are never cached; hashed build outputs are
 * immutable. sirv passes the requested pathname, not the SPA fallback file,
 * so this decision is made on the URL the browser asked for.
 */
function cacheControlFor(policy: CachePolicy, pathname: string): string {
  if (policy === "immutable") {
    return IMMUTABLE_CACHE_CONTROL;
  }
  if (policy === "no-store") {
    return NO_STORE_CACHE_CONTROL;
  }
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const isDocument = !lastSegment.includes(".") || lastSegment.endsWith(".html");
  return isDocument ? NO_STORE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL;
}

function headerSetter(policy: CachePolicy) {
  return (res: ServerResponse, pathname: string): void => {
    applySecurityHeaders(res);
    res.setHeader("Cache-Control", cacheControlFor(policy, pathname));
  };
}

/**
 * Creates one handler per route prefix.
 *
 * `/assets/*` is mounted on `<host>/assets` because the host page is the
 * document served at `/`; the controller build emits its own assets under
 * `/c/` (Vite `base`), and game bundles live under `/games/`.
 */
export function createStaticHandlers(roots: StaticRoots): StaticHandlers {
  const handlers: StaticHandlers = {
    host: sirv(roots.host, { dev: true, single: true, setHeaders: headerSetter("spa") }),
    // `/demo/*` is fetched by `loadGame`; an SPA fallback would return HTML
    // with a 200 for a missing manifest, so serve existing files only.
    hostFiles: sirv(roots.host, { dev: true, setHeaders: headerSetter("no-store") }),
    controller: sirv(roots.controller, {
      dev: true,
      single: true,
      setHeaders: headerSetter("spa"),
    }),
    games: sirv(roots.games, { dev: true, setHeaders: headerSetter("immutable") }),
    experiments: sirv(roots.experiments, { dev: true, setHeaders: headerSetter("no-store") }),
    assets: sirv(join(roots.host, "assets"), {
      dev: true,
      setHeaders: headerSetter("immutable"),
    }),
  };
  if (roots.gameSources !== undefined) {
    // Source manifests/layouts change while the server runs; never cache them.
    handlers.gameSources = sirv(roots.gameSources, {
      dev: true,
      setHeaders: headerSetter("no-store"),
    });
  }
  return handlers;
}

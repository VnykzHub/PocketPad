/**
 * @lanpad/sdk server configuration contract (D0-SDK-01, FR-4.3, FR-4.6).
 *
 * There is no default origin. The server location comes from, in order:
 *
 * 1. the explicit argument,
 * 2. the build-time `VITE_SERVER_ORIGIN` (Vite's `import.meta.env`, with a
 *    guarded `process.env` fallback for Node tools),
 * 3. `globalThis.location.origin` in a browser.
 *
 * Running outside a browser without an explicit origin is an error rather than
 * a silent fallback to a hard-coded host.
 */

const DEFAULT_SOCKET_PATH = "/ws";

type BuildTimeMeta = ImportMeta & {
  readonly env?: Readonly<Record<string, unknown>>;
};

/**
 * Reads the configured origin from Vite's build-time env, falling back to
 * `process.env` for Node tools and tests. Browser bundles without a `process`
 * polyfill skip the second source.
 */
function readConfiguredOrigin(): string | undefined {
  const viteValue = (import.meta as BuildTimeMeta).env?.VITE_SERVER_ORIGIN;
  const nodeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const nodeValue = nodeProcess?.env?.VITE_SERVER_ORIGIN;

  for (const value of [viteValue, nodeValue]) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readLocationOrigin(): string | undefined {
  const location = globalThis.location;
  if (location === undefined || typeof location.origin !== "string") {
    return undefined;
  }
  const origin = location.origin.trim();
  // Sandboxed documents and file:// pages report the literal origin "null".
  return origin.length > 0 && origin !== "null" ? origin : undefined;
}

function parseHttpUrl(candidate: string): URL {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(
      `Invalid server origin ${JSON.stringify(candidate)}: expected an absolute URL with an http or https scheme.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Unsupported server origin ${JSON.stringify(candidate)}: lanpad requires an http or https URL.`,
    );
  }
  return url;
}

function trimTrailingSlashes(pathname: string): string {
  return pathname.replace(/\/+$/, "");
}

function normalizeSocketPath(path: string): string {
  if (path.length === 0) {
    return DEFAULT_SOCKET_PATH;
  }
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Resolves the server origin from config. Trailing slashes are removed; a path
 * prefix is preserved so the SDK also works behind a reverse proxy. Query
 * strings and fragments are dropped.
 *
 * @throws when no source is configured or the value is not an http(s) URL.
 */
export function resolveServerOrigin(explicit?: string): string {
  const candidate = explicit ?? readConfiguredOrigin() ?? readLocationOrigin();

  if (candidate === undefined || candidate.trim().length === 0) {
    throw new Error(
      "Cannot resolve the server origin: pass an explicit origin, set VITE_SERVER_ORIGIN at build time, or run in a browser. Lanpad never hard-codes an origin.",
    );
  }

  const url = parseHttpUrl(candidate);
  return `${url.origin}${trimTrailingSlashes(url.pathname)}`;
}

/**
 * Converts an http(s) origin into its WebSocket URL. `http` maps to `ws` and
 * `https` maps to `wss`; no origin is assumed.
 *
 * @throws when the origin is not an absolute http(s) URL.
 */
export function toWebSocketUrl(origin: string, path: string = DEFAULT_SOCKET_PATH): string {
  const url = parseHttpUrl(origin);
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  const basePath = trimTrailingSlashes(url.pathname);
  return `${scheme}//${url.host}${basePath}${normalizeSocketPath(path)}`;
}

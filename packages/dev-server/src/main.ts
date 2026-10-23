/**
 * Dev server entry point (D0-SRV-01): static routes, LAN discovery, health,
 * room creation and the broker's WebSocket adapter.
 *
 * This is an adapter only. Room lifecycle lives in `@lanpad/broker` (A1), so
 * the production relay in P1 reuses the same core through a different
 * transport. No CORS headers are ever emitted: dev is same-origin and
 * production origins are config-driven.
 */
import { randomBytes as secureRandomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RoomRegistry,
  attachWebSocketServer,
  type Logger,
} from "@lanpad/broker";
import { allowedOriginsFromUrls, lanUrls } from "./lan.js";
import { applySecurityHeaders, createStaticHandlers } from "./static.js";
import { printBootInfo } from "./terminal.js";

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = "0.0.0.0";
/** FR-7.14: ping every 2 s, drop after 5 s of silence. */
export const HEARTBEAT_MS = 2000;
export const DEAD_AFTER_MS = 5000;
/** G2: drop level-only input when the host socket is this far behind. */
export const MAX_BUFFERED_BYTES = 262_144;

/** Frozen interface from D0-SRV-01. */
export interface DevServerConfig {
  /** Bind address; default `0.0.0.0`. */
  host: string;
  /** Default 8080. Use 0 in tests to bind an ephemeral port. */
  port: number;
  staticRoots: {
    host: string;
    controller: string;
    games: string;
    /** Unbuilt game sources, used for manifests/layouts only. */
    gameSources?: string;
    experiments: string;
  };
  /** Derived at boot from LAN IPs + localhost; never `*`. */
  allowedOrigins: string[];
  /**
   * Opt-in HTTPS (D5) for phone motion sensors, which require a secure
   * context. The files are read at server creation; nothing is committed.
   */
  tls?: {
    certPath: string;
    keyPath: string;
  };
}

export interface DevServerDeps {
  /** Injected clock for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Injected entropy for tests; defaults to `node:crypto.randomBytes`. */
  randomBytes?: (n: number) => Uint8Array;
  /** Defaults to structured JSON lines on stdout. */
  logger?: Logger;
}

export interface DevServer {
  server: Server;
  registry: RoomRegistry;
  wss: ReturnType<typeof attachWebSocketServer>;
  config: DevServerConfig;
  /** Binds the server and returns the actual port plus every reachable URL. */
  listen(): Promise<{ port: number; urls: string[] }>;
  close(): Promise<void>;
}

function writeLogLine(event: string, fields: Record<string, string | number>): void {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}

const stdoutLogger: Logger = {
  info: writeLogLine,
};

/** Repository root derived from this module's location, never hard-coded (FR-4.3). */
export function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

/** Opt-in TLS from `LANPAD_TLS_CERT` + `LANPAD_TLS_KEY`; both are required. */
export function resolveTlsConfig(
  env: NodeJS.ProcessEnv,
): { certPath: string; keyPath: string } | undefined {
  const certPath = env["LANPAD_TLS_CERT"];
  const keyPath = env["LANPAD_TLS_KEY"];
  if (
    (certPath === undefined || certPath.length === 0) &&
    (keyPath === undefined || keyPath.length === 0)
  ) {
    return undefined;
  }
  if (certPath === undefined || certPath.length === 0) {
    throw new Error("LANPAD_TLS_CERT is required when TLS is enabled");
  }
  if (keyPath === undefined || keyPath.length === 0) {
    throw new Error("LANPAD_TLS_KEY is required when TLS is enabled");
  }
  return { certPath, keyPath };
}

export function defaultConfig(repoRoot = defaultRepoRoot()): DevServerConfig {
  const urls = lanUrls(DEFAULT_PORT, networkInterfaces());
  const tls = resolveTlsConfig(process.env);
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    staticRoots: {
      host: join(repoRoot, "packages/runtime/dist"),
      controller: join(repoRoot, "packages/controller/dist"),
      games: join(repoRoot, "packages/games/dist"),
      gameSources: join(repoRoot, "packages/games"),
      experiments: join(repoRoot, "experiments"),
    },
    allowedOrigins: allowedOriginsFromUrls(urls),
    ...(tls !== undefined ? { tls } : {}),
  };
}

function pathnameOf(rawUrl: string | undefined): string | null {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

/** Strips a mount prefix while preserving the query string for sirv. */
function rewritePrefix(req: IncomingMessage, prefix: string): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const rest = url.pathname.slice(prefix.length) || "/";
  req.url = `${rest}${url.search}`;
}

/** Exact game page: `/games/<slug>` or `/games/<slug>/` (A12). */
const GAME_PAGE_PATTERN = /^\/games\/([a-z0-9][a-z0-9-]*)\/?$/;

/**
 * The only source-tree paths a game exposes before it is built: its manifest
 * and layout documents. `src/**`, tests and READMEs stay server-side.
 */
const GAME_SOURCE_ASSET_PATTERN =
  /^\/[a-z0-9][a-z0-9-]*\/(?:game\.manifest\.json|layouts\/[^/]+\.json)$/;

/** True when the slug has a manifest in the built tree or the source tree. */
function hasGameManifest(roots: DevServerConfig["staticRoots"], slug: string): boolean {
  if (existsSync(join(roots.games, slug, "game.manifest.json"))) {
    return true;
  }
  return (
    roots.gameSources !== undefined &&
    existsSync(join(roots.gameSources, slug, "game.manifest.json"))
  );
}

function sendText(res: ServerResponse, status: number, body: string): void {
  applySecurityHeaders(res);
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  applySecurityHeaders(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  applySecurityHeaders(res);
  res.writeHead(405, {
    Allow: allow,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end("Method not allowed");
}

/**
 * Creates the dev server without binding it. `listen()` must be called before
 * requests are served.
 */
export function createDevServer(config: DevServerConfig, deps: DevServerDeps = {}): DevServer {
  const logger = deps.logger ?? stdoutLogger;
  const registry = new RoomRegistry({
    now: deps.now ?? Date.now,
    randomBytes: deps.randomBytes ?? ((count) => new Uint8Array(secureRandomBytes(count))),
    logger,
  });
  const staticHandlers = createStaticHandlers(config.staticRoots);

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const pathname = pathnameOf(req.url);

    // SR-9: method, pathname, status and duration only. Query strings,
    // headers and bodies are never logged.
    res.on("finish", () => {
      logger.info("http.request", {
        method,
        path: pathname ?? "invalid",
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    if (pathname === null) {
      sendText(res, 400, "Bad request");
      return;
    }

    if (pathname === "/healthz") {
      if (method !== "GET" && method !== "HEAD") {
        sendMethodNotAllowed(res, "GET, HEAD");
        return;
      }
      sendJson(res, 200, { ok: true, now: registry.nowMs(), rooms: registry.roomCount() });
      return;
    }

    if (pathname === "/api/rooms") {
      if (method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      sendJson(res, 201, registry.createRoom());
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      sendText(res, 404, "Not found");
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      staticHandlers.host(req, res, () => sendText(res, 404, "Not found"));
      return;
    }
    if (pathname === "/demo" || pathname.startsWith("/demo/")) {
      // Bundled demo manifests and assets (`public/demo` copied into the host
      // build). No SPA fallback: a missing manifest must be a visible 404.
      staticHandlers.hostFiles(req, res, () => sendText(res, 404, "Not found"));
      return;
    }
    if (pathname === "/c" || pathname.startsWith("/c/")) {
      rewritePrefix(req, "/c");
      staticHandlers.controller(req, res, () => sendText(res, 404, "Not found"));
      return;
    }
    if (pathname.startsWith("/games/")) {
      // A direct game page (`/games/reaction-duel/`) serves the host SPA,
      // which selects the manifest from the URL (A12). Only slugs that
      // actually have a manifest qualify; everything else stays a 404.
      const page = GAME_PAGE_PATTERN.exec(pathname);
      if (
        page !== null &&
        page[1] !== undefined &&
        hasGameManifest(config.staticRoots, page[1])
      ) {
        staticHandlers.host(req, res, () => sendText(res, 404, "Not found"));
        return;
      }
      rewritePrefix(req, "/games");
      staticHandlers.games(req, res, () => {
        // Unbuilt games still expose their manifest and layouts from the
        // source tree; no other source files are reachable.
        const sourcePath = pathnameOf(req.url);
        if (
          staticHandlers.gameSources !== undefined &&
          sourcePath !== null &&
          GAME_SOURCE_ASSET_PATTERN.test(sourcePath)
        ) {
          staticHandlers.gameSources(req, res, () => sendText(res, 404, "Not found"));
          return;
        }
        sendText(res, 404, "Not found");
      });
      return;
    }
    if (pathname.startsWith("/x/")) {
      rewritePrefix(req, "/x");
      staticHandlers.experiments(req, res, () => sendText(res, 404, "Not found"));
      return;
    }
    if (pathname.startsWith("/assets/")) {
      rewritePrefix(req, "/assets");
      staticHandlers.assets(req, res, () => sendText(res, 404, "Not found"));
      return;
    }
    sendText(res, 404, "Not found");
  }

  const server =
    config.tls === undefined
      ? createServer(handleRequest)
      : createHttpsServer(
          {
            cert: readFileSync(config.tls.certPath),
            key: readFileSync(config.tls.keyPath),
          },
          handleRequest,
        );
  const wss = attachWebSocketServer(server, {
    registry,
    config: {
      // Same array reference: listen() may fill it once the real port is known.
      allowedOrigins: config.allowedOrigins,
      allowMissingOrigin: true,
      heartbeatMs: HEARTBEAT_MS,
      deadAfterMs: DEAD_AFTER_MS,
      maxBufferedBytes: MAX_BUFFERED_BYTES,
    },
    logger,
  });

  const sweeper = setInterval(() => registry.sweep(), 1000);
  sweeper.unref?.();

  async function listen(): Promise<{ port: number; urls: string[] }> {
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(config.port, config.host);
    });

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.port;
    const urls = lanUrls(port, networkInterfaces()).map((url) =>
      config.tls === undefined ? url : url.replace(/^http:/, "https:"),
    );
    if (config.allowedOrigins.length === 0) {
      config.allowedOrigins.push(...allowedOriginsFromUrls(urls));
    }
    return { port, urls };
  }

  async function close(): Promise<void> {
    clearInterval(sweeper);
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolvePromise) => setTimeout(() => resolvePromise(), 20));
    await new Promise<void>((resolvePromise) => {
      wss.close(() => resolvePromise());
    });
    if (server.listening) {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    }
  }

  return { server, registry, wss, config, listen, close };
}

/** Boots the default server and prints the LAN banner + QR. */
export async function main(): Promise<void> {
  const config = defaultConfig();
  const app = createDevServer(config);
  const { urls } = await app.listen();
  await printBootInfo(urls, { tls: config.tls !== undefined });

  const shutdown = (): void => {
    void app.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function normalizeEntryPath(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  normalizeEntryPath(entry) === normalizeEntryPath(fileURLToPath(import.meta.url))
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

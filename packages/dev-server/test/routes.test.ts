/**
 * Dev-server route tests (D0-SRV-01): static roots, SPA fallback, cache and
 * security headers, health, room creation, traversal and request logging.
 *
 * Fixtures live in a fresh temp directory per test; nothing is written to the
 * repository.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Logger } from "@lanpad/broker";
import {
  DEV_CSP,
  IMMUTABLE_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  allowedOriginsFromUrls,
  createDevServer,
  type DevServer,
  type StaticRoots,
} from "../src/index.js";

const silentLogger: Logger = { info() {} };

interface Running {
  app: DevServer;
  base: string;
  port: number;
}

interface Health {
  ok: boolean;
  now: number;
  rooms: number;
}

interface Credentials {
  code: string;
  pin: string;
  roomToken: string;
  hostToken: string;
  expiresAt: number;
  serverTime: number;
}

let root: string;
let roots: StaticRoots;
let running: Running | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lanpad-dev-server-"));
  mkdirSync(join(root, "host", "assets"), { recursive: true });
  writeFileSync(join(root, "host", "index.html"), "<!doctype html><title>HOST_SHELL</title>");
  writeFileSync(join(root, "host", "assets", "main-abc123.js"), "console.log('host asset');");
  mkdirSync(join(root, "controller"), { recursive: true });
  writeFileSync(
    join(root, "controller", "index.html"),
    "<!doctype html><title>CONTROLLER_SHELL</title>",
  );
  mkdirSync(join(root, "games"), { recursive: true });
  writeFileSync(join(root, "games", "bundle-xyz.js"), "console.log('game bundle');");
  mkdirSync(join(root, "experiments", "e1"), { recursive: true });
  writeFileSync(
    join(root, "experiments", "e1", "index.html"),
    "<!doctype html><title>EXPERIMENT_ONE</title>",
  );
  roots = {
    host: join(root, "host"),
    controller: join(root, "controller"),
    games: join(root, "games"),
    experiments: join(root, "experiments"),
  };
});

afterEach(async () => {
  if (running !== null) {
    await running.app.close();
    running = null;
  }
  rmSync(root, { recursive: true, force: true });
});

async function startApp(logger: Logger = silentLogger): Promise<Running> {
  const app = createDevServer(
    { host: "127.0.0.1", port: 0, staticRoots: roots, allowedOrigins: [] },
    { logger },
  );
  const { port } = await app.listen();
  running = { app, base: `http://127.0.0.1:${port}`, port };
  return running;
}

/** Sends a request path verbatim, without fetch's client-side normalization. */
function rawGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("static routes", () => {
  test("[FR-9.12] / serves the host shell with no-store", async () => {
    const { base } = await startApp();
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(NO_STORE_CACHE_CONTROL);
    expect(await response.text()).toContain("HOST_SHELL");
  });

  test("[FR-9.12] /c/* serves the controller SPA shell with no-store", async () => {
    const { base } = await startApp();
    const response = await fetch(`${base}/c/ABCD`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(NO_STORE_CACHE_CONTROL);
    expect(await response.text()).toContain("CONTROLLER_SHELL");
  });

  test("[FR-9.12] games, experiments and build assets come from their roots", async () => {
    const { base } = await startApp();

    const game = await fetch(`${base}/games/bundle-xyz.js`);
    expect(game.status).toBe(200);
    expect(game.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(await game.text()).toContain("game bundle");

    const experiment = await fetch(`${base}/x/e1`);
    expect(experiment.status).toBe(200);
    expect(experiment.headers.get("cache-control")).toBe(NO_STORE_CACHE_CONTROL);
    expect(await experiment.text()).toContain("EXPERIMENT_ONE");

    const asset = await fetch(`${base}/assets/main-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(await asset.text()).toContain("host asset");
  });

  test("[FR-9.12] missing files under /assets and /games return 404, not the host shell", async () => {
    const { base } = await startApp();

    const missingAsset = await fetch(`${base}/assets/missing.js`);
    expect(missingAsset.status).toBe(404);
    expect(await missingAsset.text()).not.toContain("HOST_SHELL");

    const missingGame = await fetch(`${base}/games/missing.js`);
    expect(missingGame.status).toBe(404);
    expect(await missingGame.text()).not.toContain("HOST_SHELL");
  });

  test("[SR-11] static traversal attempts return 404", async () => {
    const { port } = await startApp();

    const plain = await rawGet(port, "/c/../../etc/passwd");
    expect(plain.status).toBe(404);
    expect(plain.body).not.toContain("root:");

    const encoded = await rawGet(port, "/c/%2e%2e/%2e%2e/etc/passwd");
    expect(encoded.status).toBe(404);
    expect(encoded.body).not.toContain("root:");
  });
});

describe("headers and policy", () => {
  test("[SR-3] HTML carries security headers and never CORS headers", async () => {
    const { base } = await startApp();
    const response = await fetch(`${base}/`);

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe(DEV_CSP);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await fetch(`${base}/api/rooms`, { method: "OPTIONS" });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("[FR-5.2] POST /api/rooms returns credentials and /healthz counts the room", async () => {
    const { base } = await startApp();

    const initial = (await (await fetch(`${base}/healthz`)).json()) as Health;
    expect(initial.ok).toBe(true);
    expect(typeof initial.now).toBe("number");
    expect(initial.rooms).toBe(0);

    const response = await fetch(`${base}/api/rooms`, { method: "POST" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe(NO_STORE_CACHE_CONTROL);
    const credentials = (await response.json()) as Credentials;
    expect(credentials.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(credentials.pin).toMatch(/^\d{4}$/);
    expect(credentials.roomToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(credentials.hostToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(credentials.expiresAt - credentials.serverTime).toBe(4 * 60 * 60 * 1000);

    const health = (await (await fetch(`${base}/healthz`)).json()) as Health;
    expect(health.rooms).toBe(1);

    const wrongMethod = await fetch(`${base}/api/rooms`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  });

  test("[FR-4.3] allowed origins follow the actual bind port", async () => {
    const config = {
      host: "127.0.0.1",
      port: 0,
      staticRoots: roots,
      allowedOrigins: [] as string[],
    };
    const app = createDevServer(config, { logger: silentLogger });
    try {
      const { port, urls } = await app.listen();
      expect(port).toBeGreaterThan(0);
      expect(urls).toContain(`http://localhost:${port}`);
      expect(config.allowedOrigins).toEqual(allowedOriginsFromUrls(urls));
      expect(config.allowedOrigins.every((origin) => origin !== "*")).toBe(true);
    } finally {
      await app.close();
    }
  });

  test("[SR-9] request logs contain only method, pathname, status and duration", async () => {
    const calls: { event: string; fields: Record<string, string | number> }[] = [];
    const logger: Logger = {
      info(event, fields) {
        calls.push({ event, fields });
      },
    };
    const { base } = await startApp(logger);

    await fetch(`${base}/healthz?token=super-secret&pin=0000`);
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 20));

    const requests = calls.filter((call) => call.event === "http.request");
    expect(requests.length).toBeGreaterThan(0);
    const last = requests[requests.length - 1];
    expect(last?.fields.method).toBe("GET");
    expect(last?.fields.path).toBe("/healthz");
    expect(Object.keys(last?.fields ?? {}).sort()).toEqual([
      "durationMs",
      "method",
      "path",
      "status",
    ]);

    const serialized = JSON.stringify(requests);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("token=");
  });
});

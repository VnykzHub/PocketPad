/**
 * Direct game route + game asset serving tests (D7-SDK-01, A12).
 *
 * Acceptance covered here:
 * - `/games/reaction-duel/` serves the host SPA (the page boots the game from
 *   the URL), while unknown slugs and missing bundles stay 404;
 * - manifests and layouts are served from the built game tree, and from the
 *   source tree before a game is built;
 * - only `game.manifest.json` and `layouts/*.json` leak from the source tree;
 * - `/demo/<game>/game.manifest.json` (the cube demo) is reachable without
 *   an SPA fallback masking a missing file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Logger } from "@lanpad/broker";
import {
  IMMUTABLE_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  createDevServer,
  type DevServer,
  type StaticRoots,
} from "../src/index.js";

const silentLogger: Logger = { info() {} };

const REACTION_DUEL_MANIFEST = {
  schemaVersion: 1,
  name: "Reaction Duel",
  entry: "index.js",
  layouts: ["layouts/rd-four-button-v1.json"],
  assetBudget: { initialBytes: 262144, totalBytes: 1048576 },
  minPlayers: 2,
  maxPlayers: 8,
  needsGyro: false,
};

const REACTION_DUEL_LAYOUT = {
  id: "rd-four-button-v1",
  buttons: [
    { bit: 0, label: "A", symbol: "▲" },
    { bit: 1, label: "B", symbol: "●" },
    { bit: 2, label: "X", symbol: "✕" },
    { bit: 3, label: "Y", symbol: "■" },
  ],
};

const CUBE_DEMO_MANIFEST = {
  schemaVersion: 1,
  name: "Cube Demo",
  entry: "index.js",
  layouts: ["layouts/cube-demo-v1.json"],
  assetBudget: { initialBytes: 65536, totalBytes: 262144 },
  minPlayers: 1,
  maxPlayers: 8,
  needsGyro: false,
};

interface Running {
  app: DevServer;
  base: string;
  port: number;
}

let root: string;
let roots: StaticRoots;
let running: Running | null = null;

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lanpad-games-route-"));

  // Host build: SPA shell + the cube demo copied from public/.
  mkdirSync(join(root, "host"), { recursive: true });
  writeFileSync(join(root, "host", "index.html"), "<!doctype html><title>HOST_SHELL</title>");
  writeJson(join(root, "host", "demo", "cube-demo", "game.manifest.json"), CUBE_DEMO_MANIFEST);

  // Built game tree: one game with a bundle + manifest + layout.
  writeJson(join(root, "games", "reaction-duel", "game.manifest.json"), REACTION_DUEL_MANIFEST);
  writeJson(
    join(root, "games", "reaction-duel", "layouts", "rd-four-button-v1.json"),
    REACTION_DUEL_LAYOUT,
  );
  writeFileSync(
    join(root, "games", "reaction-duel", "index.js"),
    "console.log('reaction duel bundle');",
  );

  // Source tree: a game that has no build yet.
  writeJson(join(root, "games-src", "source-only", "game.manifest.json"), {
    ...REACTION_DUEL_MANIFEST,
    name: "Source Only",
  });
  writeJson(
    join(root, "games-src", "source-only", "layouts", "rd-four-button-v1.json"),
    REACTION_DUEL_LAYOUT,
  );
  mkdirSync(join(root, "games-src", "source-only", "src"), { recursive: true });
  writeFileSync(join(root, "games-src", "source-only", "src", "game.ts"), "export default 1;");

  roots = {
    host: join(root, "host"),
    controller: join(root, "empty-controller"),
    games: join(root, "games"),
    gameSources: join(root, "games-src"),
    experiments: join(root, "empty-experiments"),
  };
});

afterEach(async () => {
  if (running !== null) {
    await running.app.close();
    running = null;
  }
  rmSync(root, { recursive: true, force: true });
});

async function startApp(
  options: { gameSources?: boolean; gameSourcesDir?: string } = {},
): Promise<Running> {
  const staticRoots: StaticRoots = {
    host: roots.host,
    controller: roots.controller,
    games: roots.games,
    experiments: roots.experiments,
  };
  if (options.gameSourcesDir !== undefined) {
    staticRoots.gameSources = options.gameSourcesDir;
  } else if (options.gameSources !== false && roots.gameSources !== undefined) {
    staticRoots.gameSources = roots.gameSources;
  }
  const app = createDevServer(
    {
      host: "127.0.0.1",
      port: 0,
      staticRoots,
      allowedOrigins: [],
    },
    { logger: silentLogger },
  );
  const { port } = await app.listen();
  running = { app, base: `http://127.0.0.1:${port}`, port };
  return running;
}

interface TestResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/**
 * GET through node:http instead of the global fetch (undici). undici refuses
 * to connect to a fixed list of "bad ports", and `listen()` may assign an
 * ephemeral port on that list, which made this file fail intermittently.
 * The path is sent verbatim, so encoded traversal is not URL-normalized.
 */
function get(url: string): Promise<TestResponse> {
  const parsed = new URL(url);
  const requestPath = url.slice(parsed.origin.length) || "/";
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: parsed.hostname, port: Number(parsed.port), path: requestPath, method: "GET" },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: {
              get(name: string): string | null {
                const value = response.headers[name.toLowerCase()];
                return Array.isArray(value) ? value.join(", ") : (value ?? null);
              },
            },
            text: async () => body,
            json: async () => JSON.parse(body) as unknown,
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("direct game page", () => {
  test("[A12] /games/<slug>/ serves the host SPA when the manifest exists", async () => {
    const { base } = await startApp();
    const response = await get(`${base}/games/reaction-duel/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(NO_STORE_CACHE_CONTROL);
    expect(await response.text()).toContain("HOST_SHELL");
  });

  test("[A12] /games/<slug> without the trailing slash also serves the host SPA", async () => {
    const { base } = await startApp();
    const response = await get(`${base}/games/reaction-duel`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("HOST_SHELL");
  });

  test("an unknown slug is 404, not the host shell", async () => {
    const { base } = await startApp();
    const response = await get(`${base}/games/unknown/`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("HOST_SHELL");
  });

  test("a missing game bundle stays a 404 (no SPA fallback)", async () => {
    const { base } = await startApp();
    const response = await get(`${base}/games/missing.js`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("HOST_SHELL");
  });

  test("a source-only game is also reachable as a page", async () => {
    const { base } = await startApp();
    const response = await get(`${base}/games/source-only/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("HOST_SHELL");
  });

  test("[A12] the shipped Coin Run game is discovered at /games/platformer/", async () => {
    // The real `packages/games` tree, not a fixture: the route must find the
    // platformer manifest exactly as the dev server does at boot.
    const { base } = await startApp({
      gameSourcesDir: fileURLToPath(new URL("../../games", import.meta.url)),
    });

    const page = await get(`${base}/games/platformer/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("HOST_SHELL");

    const manifest = await get(`${base}/games/platformer/game.manifest.json`);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({
      name: "Coin Run",
      minPlayers: 1,
      maxPlayers: 4,
    });

    const layout = await get(`${base}/games/platformer/layouts/pf-dpad-v1.json`);
    expect(layout.status).toBe(200);

    const source = await get(`${base}/games/platformer/src/game.ts`);
    expect(source.status).toBe(404);
  });
});

describe("game bundles, manifests and layouts", () => {
  test("[G3] built bundles are served immutably", async () => {
    const { base } = await startApp();
    const response = await get(`${base}/games/reaction-duel/index.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(await response.text()).toContain("reaction duel bundle");
  });

  test("[FR-10.3] the built manifest and layout are served", async () => {
    const { base } = await startApp();
    const manifest = await get(`${base}/games/reaction-duel/game.manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(await manifest.json()).toMatchObject({ name: "Reaction Duel", minPlayers: 2 });

    const layout = await get(`${base}/games/reaction-duel/layouts/rd-four-button-v1.json`);
    expect(layout.status).toBe(200);
    expect(await layout.json()).toMatchObject({ id: "rd-four-button-v1" });
  });

  test("[FR-10.3] an unbuilt game serves its manifest and layout from source", async () => {
    const { base } = await startApp();
    const manifest = await get(`${base}/games/source-only/game.manifest.json`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("cache-control")).toBe(NO_STORE_CACHE_CONTROL);
    expect(await manifest.json()).toMatchObject({ name: "Source Only", minPlayers: 2 });

    const layout = await get(`${base}/games/source-only/layouts/rd-four-button-v1.json`);
    expect(layout.status).toBe(200);
    expect(layout.headers.get("cache-control")).toBe(NO_STORE_CACHE_CONTROL);
    expect(await layout.json()).toMatchObject({ id: "rd-four-button-v1" });
  });

  test("source code, tests and docs are not reachable through /games/*", async () => {
    const { base } = await startApp();
    for (const path of [
      "/games/source-only/src/game.ts",
      "/games/source-only/test/game.test.ts",
      "/games/source-only/README.md",
      "/games/source-only/config.json",
    ]) {
      const response = await get(`${base}${path}`);
      expect(response.status, path).toBe(404);
    }
  });

  test("a missing manifest is 404 rather than the host shell", async () => {
    const { base } = await startApp();
    const response = await get(`${base}/games/source-only/game.manifest.json.nope`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("HOST_SHELL");
  });

  test("without gameSources, only the built tree is served", async () => {
    const { base } = await startApp({ gameSources: false });
    const sourceManifest = await get(`${base}/games/source-only/game.manifest.json`);
    expect(sourceManifest.status).toBe(404);

    const builtManifest = await get(`${base}/games/reaction-duel/game.manifest.json`);
    expect(builtManifest.status).toBe(200);

    const sourcePage = await get(`${base}/games/source-only/`);
    expect(sourcePage.status).toBe(404);
  });
});

describe("cube demo manifest route", () => {
  test("[FR-10.3] /demo/cube-demo/game.manifest.json is served from the host build", async () => {
    const { base } = await startApp();
    const response = await get(`${base}/demo/cube-demo/game.manifest.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(NO_STORE_CACHE_CONTROL);
    expect(await response.json()).toMatchObject({ name: "Cube Demo", minPlayers: 1 });
  });

  test("a missing demo file is a 404, not index.html", async () => {
    const { base } = await startApp();
    const response = await get(`${base}/demo/cube-demo/missing.json`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("HOST_SHELL");
  });
});

describe("security", () => {
  test("encoded traversal never reaches a game manifest", async () => {
    const { base } = await startApp();
    for (const path of [
      "/games/..%2f..%2fhost/index.html",
      "/games/%2e%2e/game.manifest.json",
      "/games/reaction-duel/..%2f..%2fhost/index.html",
      "/demo/..%2f..%2fhost/index.html",
    ]) {
      const response = await get(`${base}${path}`);
      expect(response.status, path).not.toBe(200);
    }
  });

  test("game responses keep the D0 security headers", async () => {
    const { base } = await startApp();
    const response = await get(`${base}/games/reaction-duel/game.manifest.json`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).not.toBeNull();
  });
});

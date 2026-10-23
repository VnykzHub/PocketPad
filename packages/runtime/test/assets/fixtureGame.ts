/**
 * Test harness for the spec-23 fixture game (stream B tests).
 *
 * Node-only: reads the committed fixture game from disk and serves it through
 * the runtime `FetchLike` seam. Tests that need a browser (Web Audio) inject
 * their own sink; nothing here pretends to measure real hardware.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateAssetManifest,
  validateManifest,
  type AssetBudgetLimits,
  type GameManifest,
} from "@lanpad/sdk";
import type { FetchLike, ResponseLike } from "../../src/assets/AssetLoader.js";
import {
  parseLicenseLedger,
  type LoadedGameAssets,
} from "../../src/assets/gameAssets.js";

export const FIXTURE_GAME_DIR = fileURLToPath(
  new URL("./fixtures/fixture-game/", import.meta.url),
);
export const FIXTURE_BASE_URL = "https://fixture.test/games/fixture/";
export const FIXTURE_MANIFEST_URL = `${FIXTURE_BASE_URL}game.manifest.json`;

export function fixtureText(relativePath: string): string {
  return readFileSync(join(FIXTURE_GAME_DIR, relativePath), "utf8");
}

export function fixtureBytes(relativePath: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_GAME_DIR, relativePath)));
}

/** Resolves a fixture URL to bytes, or null when the URL is not in the game. */
export function fixtureFileForUrl(url: string): Uint8Array | null {
  if (!url.startsWith(FIXTURE_BASE_URL)) return null;
  const relative = url.slice(FIXTURE_BASE_URL.length);
  const path = join(FIXTURE_GAME_DIR, relative);
  if (!existsSync(path)) return null;
  return new Uint8Array(readFileSync(path));
}

export function fixtureManifest(): GameManifest {
  const raw: unknown = JSON.parse(fixtureText("game.manifest.json"));
  const result = validateManifest(raw);
  if (!result.ok) {
    throw new Error(`fixture manifest invalid: ${result.errors.join("; ")}`);
  }
  return result.manifest;
}

export function fixtureBudget(): AssetBudgetLimits {
  const manifest = fixtureManifest();
  return {
    initialBytes: manifest.assetBudget.initialBytes,
    totalBytes: manifest.assetBudget.totalBytes,
  };
}

export function fixtureAssets(): LoadedGameAssets {
  const budget = fixtureBudget();
  const raw: unknown = JSON.parse(fixtureText("assets.json"));
  const validation = validateAssetManifest(
    raw,
    parseLicenseLedger(fixtureText("LICENSES.csv")),
    budget,
  );
  if (!validation.ok) {
    throw new Error(
      `fixture assets.json invalid: ${validation.errors
        .map((error) => `${error.code} ${error.path}`)
        .join("; ")}`,
    );
  }
  return {
    manifest: validation.manifest,
    assetsUrl: `${FIXTURE_BASE_URL}assets.json`,
    ledgerUrl: `${FIXTURE_BASE_URL}LICENSES.csv`,
    baseUrl: FIXTURE_BASE_URL,
    budget,
  };
}

export async function fixtureFetchText(url: string): Promise<string | null> {
  const bytes = fixtureFileForUrl(url);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

export async function fixtureFetchJson(url: string): Promise<unknown> {
  const bytes = fixtureFileForUrl(url);
  if (bytes === null) throw new Error(`HTTP 404 for ${url}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Streams `bytes` in chunks so progress is observed before completion. */
export function streamResponse(
  bytes: Uint8Array,
  chunkSize = 64,
): ResponseLike {
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.byteLength) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
        }
        controller.close();
      },
    }),
    arrayBuffer: async () => new Uint8Array(bytes).buffer as ArrayBuffer,
  };
}

/** Exercises the `response.body === null` path. */
export function bufferResponse(bytes: Uint8Array): ResponseLike {
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.byteLength) },
    body: null,
    arrayBuffer: async () => new Uint8Array(bytes).buffer as ArrayBuffer,
  };
}

export function notFoundResponse(): ResponseLike {
  return {
    ok: false,
    status: 404,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

export interface FixtureFetch {
  readonly urls: string[];
  readonly fetch: FetchLike;
}

/**
 * Fetch seam backed by the fixture game. `transform` may return a custom
 * response for a URL (truncated body, 503, ...); returning null falls through
 * to the real fixture file.
 */
export function createFixtureFetch(
  transform?: (url: string, bytes: Uint8Array | null) => ResponseLike | null,
): FixtureFetch {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const bytes = fixtureFileForUrl(url);
    if (transform !== undefined) {
      const custom = transform(url, bytes);
      if (custom !== null) return custom;
    }
    return bytes === null ? notFoundResponse() : streamResponse(bytes);
  };
  return { urls, fetch };
}

/**
 * ER-06-07: asset library lifecycle.
 *
 * Every transport is the in-memory `FakeServer`; decodes run on the pool's
 * main-thread fallback because Node has no module `Worker`. Fixtures are the
 * synthetic GLB, WOFF2 and Ogg builders from `helpers.ts`.
 */

import { describe, expect, test, vi } from "vitest";
import type {
  AssetKind,
  AudioAssetData,
  AudioMimeType,
  FontAssetData,
  JsonAssetData,
  MaterialData,
  MeshData,
} from "../src/contracts/assets.js";
import { AssetEngineError } from "../src/errors.js";
import { fnv1a32Hex } from "../src/hash.js";
import { createAssetLibrary } from "../src/library.js";
import {
  buildAudio,
  buildTriangleGlb,
  buildWoff2,
  catchAsync,
  expectCode,
  FakeServer,
  utf8,
} from "./helpers.js";

const MANIFEST_URL = "http://localhost/games/example-game/asset-manifest.json";

const GLB = buildTriangleGlb();
const GLB_BYTES = GLB.byteLength;
/** 3 vertices x 8 floats x 4 bytes plus 3 uint16 indices. */
const MESH_DECODED_BYTES = 3 * 8 * 4 + 3 * 2;

const FONT = buildWoff2();
const FONT_BYTES = FONT.byteLength;

const CONFIG_TEXT = '{"a":1}';
const CONFIG_BYTES = utf8(CONFIG_TEXT).byteLength;

const MATERIAL_TEXT = JSON.stringify({
  formatVersion: 1,
  id: "materials/m",
});
const MATERIAL_BYTES = utf8(MATERIAL_TEXT).byteLength;

const AUDIO = buildAudio("ogg");
const AUDIO_BYTES = AUDIO.byteLength;

interface EntrySpec {
  readonly id: string;
  readonly kind: AssetKind;
  readonly url: string;
  readonly bytes: number;
  readonly initial?: boolean;
  readonly group?: string;
  readonly dependencies?: readonly string[];
  readonly streaming?: boolean;
  readonly mimeType?: AudioMimeType;
  readonly durationSeconds?: number;
  readonly hash?: string;
}

interface EntryExtra {
  readonly initial?: boolean;
  readonly group?: string;
  readonly dependencies?: readonly string[];
  readonly streaming?: boolean;
  readonly mimeType?: AudioMimeType;
  readonly durationSeconds?: number;
  readonly hash?: string;
}

function entry(
  id: string,
  kind: AssetKind,
  url: string,
  bytes: number,
  extra: EntryExtra = {},
): EntrySpec {
  return {
    id,
    kind,
    url,
    bytes,
    ...(extra.initial !== undefined ? { initial: extra.initial } : {}),
    ...(extra.group !== undefined ? { group: extra.group } : {}),
    ...(extra.dependencies !== undefined
      ? { dependencies: extra.dependencies }
      : {}),
    ...(extra.streaming !== undefined ? { streaming: extra.streaming } : {}),
    ...(extra.mimeType !== undefined ? { mimeType: extra.mimeType } : {}),
    ...(extra.durationSeconds !== undefined
      ? { durationSeconds: extra.durationSeconds }
      : {}),
    ...(extra.hash !== undefined ? { hash: extra.hash } : {}),
  };
}

function meshEntry(
  id: string,
  url: string,
  extra: EntryExtra = {},
): EntrySpec {
  return entry(id, "mesh", url, GLB_BYTES, extra);
}

/** Builds a valid manifest around `entries`, deriving both budget figures. */
function manifestText(
  entries: readonly EntrySpec[],
  gameId = "example-game",
): string {
  let sum = 0;
  let initialSum = 0;
  for (const item of entries) {
    sum += item.bytes;
    if (item.initial === true) initialSum += item.bytes;
  }
  return JSON.stringify({
    formatVersion: 1,
    id: gameId,
    budget: {
      initialBytes: Math.max(1, initialSum),
      totalBytes: Math.max(1, initialSum, sum),
    },
    assets: entries,
  });
}

interface HarnessOptions {
  readonly decodedBudgetBytes?: number;
  readonly verifyHashes?: boolean;
  readonly now?: () => number;
}

interface Harness {
  readonly server: FakeServer;
  readonly library: Awaited<ReturnType<typeof createAssetLibrary>>;
}

async function makeLibrary(
  entries: readonly EntrySpec[],
  overrides: HarnessOptions = {},
): Promise<Harness> {
  const server = new FakeServer(MANIFEST_URL, manifestText(entries));
  const library = await createAssetLibrary({
    gameId: "example-game",
    manifestUrl: MANIFEST_URL,
    fetch: server.fetch,
    ...(overrides.decodedBudgetBytes !== undefined
      ? { decodedBudgetBytes: overrides.decodedBudgetBytes }
      : {}),
    ...(overrides.verifyHashes !== undefined
      ? { verifyHashes: overrides.verifyHashes }
      : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });
  return { server, library };
}

function messageOf(error: unknown): string {
  return error instanceof AssetEngineError ? error.message : String(error);
}

describe("ER-06-07 library initialization", () => {
  test("ER-06-07 resolves the manifest and exposes empty ledgers", async () => {
    const { library } = await makeLibrary([
      entry("data/config", "json", "data/config.json", CONFIG_BYTES, {
        initial: true,
        group: "boot",
      }),
      meshEntry("meshes/tri", "meshes/tri.glb", { group: "city" }),
    ]);

    expect(library.manifest.id).toBe("example-game");
    expect(library.manifest.assets.map((asset) => asset.id)).toEqual([
      "data/config",
      "meshes/tri",
    ]);
    expect(library.loadedBytes).toBe(0);
    expect(library.textureBytes).toBe(0);
    expect(library.metadataBytes).toBe(0);
    expect(library.inFlight).toBe(0);
    expect(library.failures).toEqual([]);
    expect(library.budgetBytes).toBe(100_663_296);
    expect(library.textureBudgetBytes).toBe(134_217_728);
    // Node has no module Worker, so decode falls back to the main thread.
    expect(library.degraded).toBe(true);
    expect(library.progress.state).toBe("idle");
  });

  test("ER-06-07 rejects a manifest whose id differs from gameId", async () => {
    const server = new FakeServer(
      MANIFEST_URL,
      manifestText(
        [entry("data/config", "json", "data/config.json", CONFIG_BYTES)],
        "other-game",
      ),
    );
    const error = await catchAsync(
      createAssetLibrary({
        gameId: "example-game",
        manifestUrl: MANIFEST_URL,
        fetch: server.fetch,
      }),
    );
    expectCode(error, "E_ASSET_FORMAT");
    expect(messageOf(error)).toContain("id");
  });

  test("ER-06-07 maps a rejected manifest request to E_ASSET_LOAD", async () => {
    const server = new FakeServer(MANIFEST_URL, "{}");
    server.add(MANIFEST_URL, { status: 500, body: "nope" });
    const error = await catchAsync(
      createAssetLibrary({
        gameId: "example-game",
        manifestUrl: MANIFEST_URL,
        fetch: server.fetch,
      }),
    );
    expectCode(error, "E_ASSET_LOAD");
    expect(messageOf(error)).toContain("HTTP 500");
  });
});

describe("ER-06-07 handles and reference counts", () => {
  test("ER-06-07 decodes JSON and reports metadata bytes without charging", async () => {
    const { server, library } = await makeLibrary([
      entry("data/config", "json", "data/config.json", CONFIG_BYTES),
    ]);
    server.add("data/config.json", { body: CONFIG_TEXT });

    const handle = await library.load<JsonAssetData>("data/config");
    expect(handle.state).toBe("ready");
    expect(handle.kind).toBe("json");
    expect(handle.id).toBe("data/config");
    expect(handle.value.json).toEqual({ a: 1 });
    expect(handle.bytes).toBe(0);
    expect(handle.textureGpuBytes).toBe(0);
    expect(handle.failed).toBeNull();
    expect(handle.revision).toBe(1);

    expect(library.loadedBytes).toBe(0);
    expect(library.metadataBytes).toBe(CONFIG_BYTES);
    expect(server.assetCalls()).toHaveLength(1);

    const borrowed = library.get<JsonAssetData>("data/config");
    expect(borrowed?.value.json).toEqual({ a: 1 });
    // get() adds no reference, so only the owned handle is released.
    handle.release();
    expect(library.get("data/config")).toBeDefined();
  });

  test("ER-06-07 concurrent loads share one fetch and one handle", async () => {
    const { server, library } = await makeLibrary([
      meshEntry("meshes/tri", "meshes/tri.glb"),
    ]);
    server.add("meshes/tri.glb", { body: GLB });

    const [first, second] = await Promise.all([
      library.load<MeshData>("meshes/tri"),
      library.load<MeshData>("meshes/tri"),
    ]);
    expect(first).toBe(second);
    expect(first?.value.primitives).toHaveLength(1);
    expect(first?.bytes).toBe(MESH_DECODED_BYTES);
    expect(server.assetCalls()).toHaveLength(1);
    expect(library.loadedBytes).toBe(MESH_DECODED_BYTES);

    first?.release();
    expect(library.get("meshes/tri")).toBeDefined();
    second?.release();
    library.trim(0);
    expect(library.loadedBytes).toBe(0);
    expect(library.get("meshes/tri")).toBeUndefined();
  });

  test("ER-06-07 a failure is sticky until every handle is released", async () => {
    const { server, library } = await makeLibrary([
      entry("data/config", "json", "data/config.json", CONFIG_BYTES),
    ]);
    const emitted: string[] = [];
    library.onFailure((failure) => {
      emitted.push(`${failure.id}:${failure.code}`);
    });

    const failed = await library.load("data/config");
    expect(failed.state).toBe("failed");
    expect(failed.failed?.code).toBe("E_ASSET_LOAD");
    expect(failed.failed?.retryable).toBe(true);
    expect(server.assetCalls()).toHaveLength(1);
    expect(library.failures).toHaveLength(1);
    expect(emitted).toEqual(["data/config:E_ASSET_LOAD"]);

    const stillFailed = await library.load("data/config");
    expect(stillFailed.state).toBe("failed");
    expect(stillFailed.failed?.code).toBe("E_ASSET_LOAD");
    // The failed record is shared, so no second fetch is attempted.
    expect(server.assetCalls()).toHaveLength(1);
    expect(emitted).toHaveLength(1);

    failed.release();
    stillFailed.release();

    server.add("data/config.json", { body: CONFIG_TEXT });
    const retried = await library.load<JsonAssetData>("data/config");
    expect(retried.state).toBe("ready");
    expect(retried.value.json).toEqual({ a: 1 });
    expect(server.assetCalls()).toHaveLength(2);
    retried.release();
  });

  test("ER-06-07 unknown ids reject without echoing the id", async () => {
    const { library } = await makeLibrary([
      entry("data/config", "json", "data/config.json", CONFIG_BYTES),
    ]);
    const error = await catchAsync(library.load("data/missing"));
    expectCode(error, "E_ASSET_UNKNOWN");
    expect(messageOf(error)).not.toContain("data/missing");
  });
});

describe("ER-06-07 groups, initial set and dependencies", () => {
  test("ER-06-07 loadGroup resolves members and their dependencies once", async () => {
    const { server, library } = await makeLibrary([
      entry("data/dep", "json", "data/dep.json", CONFIG_BYTES, {
        group: "city",
      }),
      entry("materials/m", "material", "materials/m.material.json", MATERIAL_BYTES, {
        group: "city",
        dependencies: ["data/dep"],
      }),
      meshEntry("meshes/tri", "meshes/tri.glb", {
        group: "city",
        dependencies: ["materials/m"],
      }),
    ]);
    server.add("data/dep.json", { body: CONFIG_TEXT });
    server.add("materials/m.material.json", {
      body: MATERIAL_TEXT,
      contentType: "application/json",
    });
    server.add("meshes/tri.glb", { body: GLB });

    const result = await library.loadGroup("city");
    expect(result.failures).toEqual([]);
    expect(result.handles.map((handle) => handle.id)).toEqual([
      "data/dep",
      "materials/m",
      "meshes/tri",
    ]);
    expect((result.handles[1]?.value as MaterialData).formatVersion).toBe(1);
    expect((result.handles[2]?.value as MeshData).primitives).toHaveLength(1);
    expect(server.assetCalls()).toHaveLength(3);
    expect(library.loadedBytes).toBe(MESH_DECODED_BYTES);

    for (const handle of result.handles) handle.release();
  });

  test("ER-06-07 loadInitial selects only initial entries", async () => {
    const { server, library } = await makeLibrary([
      entry("data/config", "json", "data/config.json", CONFIG_BYTES, {
        initial: true,
      }),
      meshEntry("meshes/tri", "meshes/tri.glb"),
    ]);
    server.add("data/config.json", { body: CONFIG_TEXT });
    server.add("meshes/tri.glb", { body: GLB });

    const result = await library.loadInitial();
    expect(result.failures).toEqual([]);
    expect(result.handles.map((handle) => handle.id)).toEqual(["data/config"]);
    expect(server.assetCalls()).toEqual([server.urlOf("data/config.json")]);
    for (const handle of result.handles) handle.release();
  });

  test("ER-06-07 a dependency failure surfaces on the dependent member", async () => {
    const { server, library } = await makeLibrary([
      entry("materials/m", "material", "materials/m.material.json", MATERIAL_BYTES, {
        group: "deps",
      }),
      meshEntry("meshes/tri", "meshes/tri.glb", {
        group: "city",
        dependencies: ["materials/m"],
      }),
    ]);
    server.add("meshes/tri.glb", { body: GLB });

    const result = await library.loadGroup("city");
    expect(result.handles).toHaveLength(1);
    expect(result.handles[0]?.state).toBe("failed");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.id).toBe("meshes/tri");
    expect(result.failures[0]?.code).toBe("E_ASSET_LOAD");
    // Only the failed dependency was requested; the dependent was not.
    expect(server.assetCalls()).toEqual([
      server.urlOf("materials/m.material.json"),
    ]);
    for (const handle of result.handles) handle.release();
  });
});

describe("ER-06-07 budgets and trim", () => {
  test("ER-06-07 a budget failure is raised before the fetch", async () => {
    const { server, library } = await makeLibrary(
      [meshEntry("meshes/tri", "meshes/tri.glb")],
      { decodedBudgetBytes: 10 },
    );
    server.add("meshes/tri.glb", { body: GLB });

    const handle = await library.load("meshes/tri");
    expect(handle.state).toBe("failed");
    expect(handle.failed?.code).toBe("E_ASSET_BUDGET");
    expect(handle.failed?.retryable).toBe(false);
    expect(server.assetCalls()).toHaveLength(0);
    expect(library.loadedBytes).toBe(0);
    handle.release();
  });

  test("ER-06-07 trim evicts unreferenced values in LRU order", async () => {
    let clock = 0;
    const { server, library } = await makeLibrary(
      [
        meshEntry("meshes/a", "meshes/a.glb", { group: "loose" }),
        meshEntry("meshes/b", "meshes/b.glb", { group: "loose" }),
      ],
      { now: () => clock },
    );
    server.add("meshes/a.glb", { body: GLB });
    server.add("meshes/b.glb", { body: GLB });

    const first = await library.load("meshes/a");
    clock = 1;
    const second = await library.load("meshes/b");
    clock = 2;
    // Reading the value refreshes its LRU stamp, making b the older entry.
    void library.get("meshes/a")?.value;
    expect(library.loadedBytes).toBe(MESH_DECODED_BYTES * 2);
    first.release();
    second.release();

    const freed = library.trim(MESH_DECODED_BYTES);
    expect(freed).toBe(MESH_DECODED_BYTES);
    expect(library.loadedBytes).toBe(MESH_DECODED_BYTES);
    expect(library.get("meshes/a")).toBeDefined();
    expect(library.get("meshes/b")).toBeUndefined();

    expect(library.trim(0)).toBe(MESH_DECODED_BYTES);
    expect(library.loadedBytes).toBe(0);
    expect(library.get("meshes/a")).toBeUndefined();
  });

  test("ER-06-07 trim never evicts a referenced value", async () => {
    const { server, library } = await makeLibrary([
      meshEntry("meshes/tri", "meshes/tri.glb"),
    ]);
    server.add("meshes/tri.glb", { body: GLB });
    const handle = await library.load("meshes/tri");

    expect(library.trim(0)).toBe(0);
    expect(library.loadedBytes).toBe(MESH_DECODED_BYTES);
    expect(library.get("meshes/tri")).toBeDefined();
    handle.release();
  });

  test("ER-06-07 pinned initial values are evicted last", async () => {
    const { server, library } = await makeLibrary([
      meshEntry("meshes/boot", "meshes/boot.glb", { initial: true }),
      meshEntry("meshes/loose", "meshes/loose.glb"),
    ]);
    server.add("meshes/boot.glb", { body: GLB });
    server.add("meshes/loose.glb", { body: GLB });

    const boot = await library.load("meshes/boot");
    const loose = await library.load("meshes/loose");
    boot.release();
    loose.release();

    expect(library.trim(MESH_DECODED_BYTES)).toBe(MESH_DECODED_BYTES);
    expect(library.get("meshes/boot")).toBeDefined();
    expect(library.get("meshes/loose")).toBeUndefined();
  });
});

describe("ER-06-07 hashing and audio routing", () => {
  test("ER-06-07 verifyHashes accepts the digest and rejects a mismatch", async () => {
    const correct = fnv1a32Hex(utf8(CONFIG_TEXT));
    const { server, library } = await makeLibrary(
      [
        entry("data/ok", "json", "data/ok.json", CONFIG_BYTES, {
          hash: correct,
        }),
        entry("data/bad", "json", "data/bad.json", CONFIG_BYTES, {
          hash: "fnv1a32:00000000",
        }),
      ],
      { verifyHashes: true },
    );
    server.add("data/ok.json", { body: CONFIG_TEXT });
    server.add("data/bad.json", { body: CONFIG_TEXT });

    const ok = await library.load<JsonAssetData>("data/ok");
    expect(ok.state).toBe("ready");
    ok.release();

    const bad = await library.load("data/bad");
    expect(bad.state).toBe("failed");
    expect(bad.failed?.code).toBe("E_ASSET_HASH");
    expect(bad.failed?.retryable).toBe(true);
    bad.release();
  });

  test("ER-06-07 a streamed audio entry is ready without a fetch", async () => {
    const { server, library } = await makeLibrary([
      entry("audio/music", "audio", "audio/music.ogg", AUDIO_BYTES, {
        streaming: true,
        mimeType: "audio/ogg",
        durationSeconds: 120,
      }),
    ]);

    const handle = await library.load<AudioAssetData>("audio/music");
    expect(handle.state).toBe("ready");
    expect(handle.bytes).toBe(0);
    expect(handle.value.kind).toBe("stream");
    expect(handle.value.mimeType).toBe("audio/ogg");
    expect(handle.value.durationSeconds).toBe(120);
    expect(server.assetCalls()).toHaveLength(0);
    expect(library.loadedBytes).toBe(0);
    expect(library.progress.declared).toBe(0);
    expect(library.progress.determinate).toBe(false);
    handle.release();
  });

  test("ER-06-07 buffered audio keeps its encoded bytes and MIME type", async () => {
    const { server, library } = await makeLibrary([
      entry("audio/engine", "audio", "audio/engine.ogg", AUDIO_BYTES, {
        streaming: false,
        mimeType: "audio/ogg",
        durationSeconds: 12.5,
      }),
    ]);
    server.add("audio/engine.ogg", { body: AUDIO });

    const handle = await library.load<AudioAssetData>("audio/engine");
    expect(handle.state).toBe("ready");
    if (handle.value.kind !== "encoded") throw new Error("expected encoded");
    expect(handle.value.mimeType).toBe("audio/ogg");
    expect(handle.value.bytes.byteLength).toBe(AUDIO_BYTES);
    expect(handle.value.durationSeconds).toBe(12.5);
    expect(handle.bytes).toBe(AUDIO_BYTES);
    expect(library.loadedBytes).toBe(AUDIO_BYTES);
    handle.release();
  });
});

describe("ER-06-07 progress and lifecycle", () => {
  test("ER-06-07 progress follows the active batch and can be reset", async () => {
    const { server, library } = await makeLibrary([
      entry("data/config", "json", "data/config.json", CONFIG_BYTES, {
        group: "boot",
      }),
      entry("fonts/ui", "font", "fonts/ui.woff2", FONT_BYTES, {
        group: "boot",
      }),
    ]);
    server.add("data/config.json", { body: CONFIG_TEXT });
    server.add("fonts/ui.woff2", { body: FONT });

    const result = await library.loadGroup("boot");
    const progress = library.progress;
    expect(progress.state).toBe("ready");
    expect(progress.loadedCount).toBe(2);
    expect(progress.totalCount).toBe(2);
    expect(progress.declared).toBe(CONFIG_BYTES + FONT_BYTES);
    expect(progress.fetched).toBe(CONFIG_BYTES + FONT_BYTES);
    expect(progress.determinate).toBe(true);
    expect(progress.currentId).not.toBeNull();
    for (const handle of result.handles) handle.release();

    library.resetProgress();
    expect(library.progress.state).toBe("idle");
    expect(library.progress.loadedCount).toBe(0);
    expect(library.progress.totalCount).toBe(0);
    expect(library.progress.fetched).toBe(0);
    expect(library.progress.declared).toBe(0);
    expect(library.progress.determinate).toBe(false);
  });

  test("ER-06-07 progress listeners receive snapshots and unsubscribe", async () => {
    const { server, library } = await makeLibrary([
      entry("data/config", "json", "data/config.json", CONFIG_BYTES),
    ]);
    server.add("data/config.json", { body: CONFIG_TEXT });

    const snapshots: Array<{ state: string; fetched: number }> = [];
    const unsubscribe = library.onProgress((progress) => {
      snapshots.push({ state: progress.state, fetched: progress.fetched });
    });

    const handle = await library.load("data/config");
    await vi.waitFor(() => {
      expect(snapshots.at(-1)?.state).toBe("ready");
    });
    expect(snapshots.at(-1)?.fetched).toBe(CONFIG_BYTES);

    unsubscribe();
    const count = snapshots.length;
    library.resetProgress();
    expect(snapshots).toHaveLength(count);
    handle.release();
  });

  test("ER-06-07 abort rejects the load and clears in-flight work", async () => {
    const { server, library } = await makeLibrary([
      meshEntry("meshes/tri", "meshes/tri.glb"),
    ]);
    server.add("meshes/tri.glb", { hang: true });

    const controller = new AbortController();
    const pending = library.load("meshes/tri", {
      signal: controller.signal,
    });
    expect(library.inFlight).toBe(1);
    controller.abort();
    const error = await catchAsync(pending);
    expectCode(error, "E_ASSET_ABORTED");
    await vi.waitFor(() => {
      expect(library.inFlight).toBe(0);
    });
    expect(library.loadedBytes).toBe(0);

    server.add("meshes/tri.glb", { body: GLB });
    const retried = await library.load("meshes/tri");
    expect(retried.state).toBe("ready");
    retried.release();
  });

  test("ER-06-07 releaseAll drops values but keeps the manifest usable", async () => {
    const { server, library } = await makeLibrary([
      entry("data/config", "json", "data/config.json", CONFIG_BYTES),
      entry("fonts/ui", "font", "fonts/ui.woff2", FONT_BYTES),
    ]);
    server.add("data/config.json", { body: CONFIG_TEXT });
    server.add("fonts/ui.woff2", { body: FONT });

    const config = await library.load<JsonAssetData>("data/config");
    const font = await library.load<FontAssetData>("fonts/ui");
    expect(config.state).toBe("ready");
    expect(font.state).toBe("ready");
    expect(library.loadedBytes).toBe(FONT_BYTES);
    expect(library.metadataBytes).toBe(CONFIG_BYTES);

    library.releaseAll();
    expect(library.loadedBytes).toBe(0);
    expect(library.textureBytes).toBe(0);
    expect(library.metadataBytes).toBe(0);
    expect(library.get("data/config")).toBeUndefined();
    expect(library.get("fonts/ui")).toBeUndefined();
    expect(library.manifest.assets).toHaveLength(2);

    const again = await library.load<JsonAssetData>("data/config");
    expect(again.state).toBe("ready");
    expect(again.value.json).toEqual({ a: 1 });
    again.release();
  });

  test("ER-06-07 dispose is idempotent and aborts pending loads", async () => {
    const { server, library } = await makeLibrary([
      meshEntry("meshes/tri", "meshes/tri.glb"),
    ]);
    server.add("meshes/tri.glb", { hang: true });

    const pending = library.load("meshes/tri");
    library.dispose();
    const error = await catchAsync(pending);
    expectCode(error, "E_ASSET_ABORTED");

    expect(() => library.dispose()).not.toThrow();
    expect(library.get("meshes/tri")).toBeUndefined();
    const later = await catchAsync(library.load("meshes/tri"));
    expectCode(later, "E_ASSET_ABORTED");
    expect(library.loadedBytes).toBe(0);
  });
});

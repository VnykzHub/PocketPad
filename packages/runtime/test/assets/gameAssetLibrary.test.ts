import { describe, expect, test } from "vitest";
import type {
  AssetProgress,
  GameAssetsManifest,
} from "@lanpad/sdk";
import {
  GameAssetError,
  GameAssetLibrary,
  type GameAssetLibraryOptions,
} from "../../src/assets/GameAssetLibrary.js";
import {
  createGameAssetLibrary,
  toLoadProgress,
} from "../../src/assets/gameAssets.js";
import {
  bufferResponse,
  createFixtureFetch,
  fixtureAssets,
  fixtureBytes,
  streamResponse,
} from "./fixtureGame.js";

type Transform = (
  url: string,
  bytes: Uint8Array | null,
) => ReturnType<typeof streamResponse> | null;

function makeLibrary(transform?: Transform) {
  const fixture = createFixtureFetch(transform);
  const assets = fixtureAssets();
  const library = createGameAssetLibrary(assets, { fetch: fixture.fetch });
  return { library, urls: fixture.urls, assets };
}

function bootDeclaredBytes(): number {
  return (
    fixtureBytes("files/triangle.glb").byteLength +
    2 * fixtureBytes("files/hit.ogg").byteLength
  );
}

describe("eager loading and byte progress", () => {
  test("[FR-9.7] eager progress sums fetched bytes and ends exactly at declared", async () => {
    const { library } = makeLibrary();
    const snapshots: AssetProgress[] = [];
    const result = await library.loadEager((progress) => {
      snapshots.push({ ...progress });
    });
    const expected = bootDeclaredBytes();

    expect(result.loadedBytes).toBe(expected);
    expect(result.declaredBytes).toBe(expected);
    expect(result.failures).toEqual([]);
    expect(result.handles.map((handle) => handle.id)).toEqual([
      "triangle",
      "hit",
      "music",
    ]);

    expect(library.progress.fetched).toBe(expected);
    expect(library.progress.declared).toBe(expected);
    expect(library.progress.determinate).toBe(true);
    expect(library.progress.state).toBe("ready");
    expect(library.progress.loadedCount).toBe(3);
    expect(library.progress.totalCount).toBe(3);
    expect(library.progress.currentId).toBeNull();
    expect(library.loadedBytes).toBe(expected);
    expect(library.budgetBytes).toBe(fixtureAssets().budget.totalBytes);

    expect(
      snapshots.some(
        (snapshot) => snapshot.fetched > 0 && snapshot.fetched < expected,
      ),
    ).toBe(true);
    expect(toLoadProgress(library.progress)).toMatchObject({
      loadedBytes: expected,
      totalBytes: expected,
      determinate: true,
      fraction: 1,
      loadedCount: 3,
      totalCount: 3,
      done: true,
    });
  });

  test("[FR-9.7] a null response body is byte-checked through arrayBuffer()", async () => {
    const { library } = makeLibrary((url, bytes) =>
      bytes === null ? null : bufferResponse(bytes),
    );
    const result = await library.loadEager();

    expect(result.loadedBytes).toBe(bootDeclaredBytes());
    expect(library.progress.state).toBe("ready");
    expect(library.progress.fetched).toBe(library.progress.declared);
  });

  test("[FR-9.7] a short response fails eager loading with a byte mismatch", async () => {
    const { library } = makeLibrary((url, bytes) => {
      if (url.endsWith("triangle.glb") && bytes !== null) {
        return streamResponse(bytes.slice(0, bytes.byteLength - 1));
      }
      return null;
    });

    await expect(library.loadEager()).rejects.toMatchObject({
      code: "E_ASSET_BYTE_MISMATCH",
      assetId: "triangle",
    });
    expect(library.progress.state).toBe("failed");
    expect(library.get("triangle")).toBeUndefined();
  });

  test("[FR-9.7] a long response is stopped at the declared byte count", async () => {
    const { library } = makeLibrary((url, bytes) => {
      if (url.endsWith("triangle.glb") && bytes !== null) {
        const longer = new Uint8Array(bytes.byteLength + 8);
        longer.set(bytes);
        return streamResponse(longer);
      }
      return null;
    });

    await expect(library.loadEager()).rejects.toMatchObject({
      code: "E_ASSET_BYTE_MISMATCH",
      assetId: "triangle",
    });
    expect(library.progress.state).toBe("failed");
  });
});

describe("valid fixture data", () => {
  test("[ER-23-01] the fixture GLB loads as bytes and the boot group fetches only its three files", async () => {
    const { library, urls } = makeLibrary();
    await library.loadEager();

    const handle = library.get("triangle");
    expect(handle?.state).toBe("ready");
    const bytes = handle?.value as Uint8Array;
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("glTF");
    expect(bytes.byteLength).toBe(
      fixtureBytes("files/triangle.glb").byteLength,
    );
    expect(urls).toEqual([
      "https://fixture.test/games/fixture/files/triangle.glb",
      "https://fixture.test/games/fixture/files/hit.ogg",
      "https://fixture.test/games/fixture/files/hit.ogg",
    ]);
  });

  test("[FR-9.11] audio assets stay encoded while the bus is locked", async () => {
    const { library } = makeLibrary();
    await library.loadEager();

    const handle = library.get("hit");
    expect(handle?.state).toBe("ready");
    expect(handle?.value).toBeInstanceOf(Uint8Array);
    const bytes = handle?.value as Uint8Array;
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("OggS");
  });

  test("[ER-23-01] a non-2xx response fails with E_ASSET_NETWORK and a retryable flag", async () => {
    const { library } = makeLibrary((url) => {
      if (!url.endsWith("triangle.glb")) return null;
      return {
        ok: false,
        status: 503,
        headers: { get: () => null },
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });

    await expect(library.loadEager()).rejects.toMatchObject({
      code: "E_ASSET_NETWORK",
      assetId: "triangle",
      retryable: true,
    });
    expect(library.progress.state).toBe("failed");
  });
});

describe("lazy groups", () => {
  test("[FR-9.6] lazy groups are not fetched at boot and load on demand", async () => {
    const { library, urls } = makeLibrary();
    await library.loadEager();
    expect(urls.some((url) => url.includes("arena"))).toBe(false);

    const handle = await library.load("arena-data");
    expect(handle.state).toBe("ready");
    expect(handle.value).toEqual({ name: "arena", columns: 3 });
    expect(urls.filter((url) => url.endsWith("arena.json"))).toHaveLength(1);
    expect(library.get("arena-data")?.state).toBe("ready");
  });

  test("[FR-9.6] loadGroup fetches only its group and reports its declared bytes", async () => {
    const { library, urls } = makeLibrary();
    const result = await library.loadGroup("arena");
    const expected =
      fixtureBytes("files/arena.json").byteLength +
      fixtureBytes("files/hit.ogg").byteLength;

    expect(result.declaredBytes).toBe(expected);
    expect(result.loadedBytes).toBe(expected);
    expect(result.failures).toEqual([]);
    expect(result.handles.map((handle) => handle.id)).toEqual([
      "arena-data",
      "arena-music",
    ]);
    expect(urls).toEqual([
      "https://fixture.test/games/fixture/files/arena.json",
      "https://fixture.test/games/fixture/files/hit.ogg",
    ]);
    await expect(library.loadGroup("nope")).rejects.toMatchObject({
      code: "E_ASSET_UNKNOWN",
    });
  });
});

describe("budget and lifecycle guards", () => {
  test("[ER-23-01] an eager set over initialBytes fails in the constructor before any fetch", () => {
    const fixture = createFixtureFetch();
    const assets = fixtureAssets();
    let caught: unknown;
    try {
      createGameAssetLibrary(
        { ...assets, budget: { ...assets.budget, initialBytes: 1 } },
        { fetch: fixture.fetch },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GameAssetError);
    expect(caught).toMatchObject({ code: "E_ASSET_BUDGET" });
    expect(fixture.urls).toHaveLength(0);
  });

  test("[ER-23-01] the library enforces the 5 MiB boot cap before any fetch", () => {
    const fixture = createFixtureFetch();
    const manifest: GameAssetsManifest = {
      schemaVersion: 1,
      groups: [{ id: "boot", mode: "eager" }],
      assets: [
        {
          id: "big",
          path: "files/big.bin",
          kind: "json",
          bytes: 5 * 1024 * 1024 + 1,
          group: "boot",
          ledger: "big.bin",
        },
      ],
    };
    const options: GameAssetLibraryOptions = {
      manifest,
      baseUrl: "https://fixture.test/games/fixture/",
      budget: { initialBytes: 6 * 1024 * 1024, totalBytes: 6 * 1024 * 1024 },
      fetch: fixture.fetch,
    };

    expect(() => new GameAssetLibrary(options)).toThrowError(/boot cap/);
    expect(fixture.urls).toHaveLength(0);
  });

  test("[ER-23-01] unknown ids fail with E_ASSET_UNKNOWN", async () => {
    const { library } = makeLibrary();
    await expect(library.load("missing")).rejects.toMatchObject({
      code: "E_ASSET_UNKNOWN",
      assetId: "missing",
    });
  });

  test("[ER-23-01] dispose silences future loads", async () => {
    const { library } = makeLibrary();
    await library.loadEager();
    library.dispose();

    await expect(library.load("triangle")).rejects.toMatchObject({
      code: "E_ASSET_DISPOSED",
    });
    expect(library.get("triangle")).toBeUndefined();
  });
});

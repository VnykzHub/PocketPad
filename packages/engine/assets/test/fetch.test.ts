/**
 * ER-06-02: exact-byte fetch, progress, timeout, abort and manifest limits.
 *
 * `FakeServer` is the only transport: every case registers an in-memory route,
 * so a test can assert byte accounting without a socket.
 */

import { describe, expect, test } from "vitest";
import {
  fetchAssetBytes,
  fetchManifestText,
  isAcceptableContentType,
} from "../src/fetch.js";
import { fnv1a32Hex, verifyFnv1a32 } from "../src/hash.js";
import { AssetEngineError } from "../src/errors.js";
import {
  catchAsync,
  FakeServer,
  expectCode,
  textBytes,
  utf8,
} from "./helpers.js";

const MANIFEST_URL = "http://localhost/game/asset-manifest.json";

function serverWithManifest(): FakeServer {
  return new FakeServer(MANIFEST_URL, "{}");
}

describe("ER-06-02 asset fetch", () => {
  test("ER-06-02 returns exact bytes split across chunks", async () => {
    const server = serverWithManifest();
    const url = server.add("assets/a.bin", {
      chunks: [utf8("abc"), utf8("defg"), utf8("hi")],
    });
    const bytes = await fetchAssetBytes({
      id: "data/a",
      url,
      bytes: 9,
      fetchImpl: server.fetch,
    });
    expect(new TextDecoder().decode(bytes)).toBe("abcdefghi");
    expect(bytes.byteLength).toBe(9);
  });

  test("ER-06-02 reports progress per chunk and totals the body", async () => {
    const server = serverWithManifest();
    const url = server.add("assets/a.bin", {
      chunks: [utf8("abc"), utf8("defg"), utf8("hi")],
    });
    const counts: number[] = [];
    await fetchAssetBytes({
      id: "data/a",
      url,
      bytes: 9,
      fetchImpl: server.fetch,
      onBytes: (count) => {
        counts.push(count);
      },
    });
    expect(counts).toEqual([3, 4, 2]);
  });

  test("ER-06-02 sends a same-origin, credential-free request", async () => {
    const server = serverWithManifest();
    const url = server.add("assets/a.bin", { body: "ab" });
    await fetchAssetBytes({
      id: "data/a",
      url,
      bytes: 2,
      fetchImpl: server.fetch,
    });
    const init = server.inits[0];
    expect(init?.method).toBe("GET");
    expect(init?.mode).toBe("same-origin");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    expect(init?.referrerPolicy).toBe("no-referrer");
  });

  test("ER-06-02 rejects a Content-Length that disagrees with the manifest", async () => {
    const server = serverWithManifest();
    const url = server.add("assets/a.bin", {
      body: "abc",
      contentLength: 4,
    });
    const error = await catchAsync(
      fetchAssetBytes({
        id: "data/a",
        url,
        bytes: 3,
        fetchImpl: server.fetch,
      }),
    );
    expectCode(error, "E_ASSET_LOAD");
    expect((error as AssetEngineError).message).toContain("Content-Length");
  });

  test("ER-06-02 rejects a body shorter than declared", async () => {
    const server = serverWithManifest();
    const url = server.add("assets/a.bin", { body: "ab", contentLength: null });
    const error = await catchAsync(
      fetchAssetBytes({
        id: "data/a",
        url,
        bytes: 3,
        fetchImpl: server.fetch,
      }),
    );
    expectCode(error, "E_ASSET_LOAD");
    expect((error as AssetEngineError).message).toContain("body ended");
  });

  test("ER-06-02 rejects a body longer than declared and stops reading", async () => {
    const server = serverWithManifest();
    const url = server.add("assets/a.bin", {
      chunks: [utf8("abcd"), utf8("e")],
      contentLength: null,
    });
    const error = await catchAsync(
      fetchAssetBytes({
        id: "data/a",
        url,
        bytes: 3,
        fetchImpl: server.fetch,
      }),
    );
    expectCode(error, "E_ASSET_LOAD");
    expect((error as AssetEngineError).message).toContain("exceeds");
  });

  test("ER-06-02 rejects an unexpected response content type", async () => {
    const server = serverWithManifest();
    const url = server.add("assets/a.bin", {
      body: "abc",
      contentType: "text/html",
    });
    const error = await catchAsync(
      fetchAssetBytes({
        id: "data/a",
        url,
        bytes: 3,
        fetchImpl: server.fetch,
        container: "glb",
      }),
    );
    expectCode(error, "E_ASSET_FORMAT");
    expect(
      isAcceptableContentType("application/octet-stream", "glb", "mesh"),
    ).toBe(true);
    expect(isAcceptableContentType("model/gltf-binary", "glb", "mesh")).toBe(
      true,
    );
    expect(isAcceptableContentType("text/html", "glb", "mesh")).toBe(false);
  });

  test("ER-06-02 rejects a non-OK response", async () => {
    const server = serverWithManifest();
    const url = server.add("assets/missing.bin", { status: 404, body: "no" });
    const error = await catchAsync(
      fetchAssetBytes({
        id: "data/a",
        url,
        bytes: 2,
        fetchImpl: server.fetch,
      }),
    );
    expectCode(error, "E_ASSET_LOAD");
    expect((error as AssetEngineError).message).toContain("HTTP 404");
  });

  test("ER-06-02 maps a caller abort to E_ASSET_ABORTED", async () => {
    const server = serverWithManifest();
    const url = server.add("assets/slow.bin", { hang: true });
    const controller = new AbortController();
    const pending = fetchAssetBytes({
      id: "data/slow",
      url,
      bytes: 3,
      fetchImpl: server.fetch,
      signal: controller.signal,
    });
    controller.abort();
    const error = await catchAsync(pending);
    expectCode(error, "E_ASSET_ABORTED");
  });

  test("ER-06-02 maps a fetch timeout to E_ASSET_LOAD", async () => {
    const server = serverWithManifest();
    const url = server.add("assets/slow.bin", { hang: true });
    const error = await catchAsync(
      fetchAssetBytes({
        id: "data/slow",
        url,
        bytes: 3,
        fetchImpl: server.fetch,
        timeoutMs: 5,
      }),
    );
    expectCode(error, "E_ASSET_LOAD");
    expect((error as AssetEngineError).message).toContain("timed out");
  });
});

describe("ER-06-02 manifest fetch", () => {
  test("ER-06-02 strips a UTF-8 BOM and returns the text", async () => {
    const manifestText = '{"formatVersion":1}';
    const server = new FakeServer(MANIFEST_URL, `﻿${manifestText}`);
    const text = await fetchManifestText({
      url: server.manifestUrl,
      fetchImpl: server.fetch,
    });
    expect(text).toBe(manifestText);
  });

  test("ER-06-02 rejects an oversized Content-Length before reading", async () => {
    const server = new FakeServer(MANIFEST_URL, "x");
    const url = server.add("big.json", {
      body: "small",
      contentLength: 262_145,
    });
    const error = await catchAsync(
      fetchManifestText({ url, fetchImpl: server.fetch }),
    );
    expectCode(error, "E_ASSET_FORMAT");
  });

  test("ER-06-02 rejects an oversized streamed body without Content-Length", async () => {
    const server = new FakeServer(MANIFEST_URL, "x");
    const url = server.add("big.json", {
      chunks: [new Uint8Array(200_000), new Uint8Array(70_000)],
      contentLength: null,
    });
    const error = await catchAsync(
      fetchManifestText({ url, fetchImpl: server.fetch }),
    );
    expectCode(error, "E_ASSET_FORMAT");
  });

  test("ER-06-02 rejects invalid UTF-8 manifest bytes", async () => {
    const server = new FakeServer(MANIFEST_URL, "x");
    const url = server.add("bad.json", {
      body: new Uint8Array([0xff, 0xfe, 0xfd]),
    });
    const error = await catchAsync(
      fetchManifestText({ url, fetchImpl: server.fetch }),
    );
    expectCode(error, "E_ASSET_FORMAT");
  });
});

describe("ER-06-02 content hash", () => {
  test("ER-06-02 FNV-1a 32 matches the published vector for hello", () => {
    expect(fnv1a32Hex(utf8("hello"))).toBe("fnv1a32:4f9f2cab");
    expect(verifyFnv1a32(utf8("hello"), "fnv1a32:4f9f2cab")).toBe(true);
    expect(verifyFnv1a32(utf8("hello"), "fnv1a32:00000000")).toBe(false);
    expect(fnv1a32Hex(textBytes(""))).toBe("fnv1a32:811c9dc5");
  });
});

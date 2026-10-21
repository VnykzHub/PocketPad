import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  ASSET_TYPES,
  AssetLoadError,
  AssetLoader,
  INITIAL_DOWNLOAD_LIMIT_BYTES,
  validateAssetEntries,
  type AssetProgress,
  type AssetType,
  type FetchLike,
  type ResponseLike,
} from "../src/assets/AssetLoader.js";
import {
  ProgressBar,
  describeProgress,
} from "../src/assets/ProgressBar.js";

// ---------------------------------------------------------------------------
// Fakes: controllable streams and fetch responses keep the tests byte-exact.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

interface ControlledStream {
  readonly body: ReadableStream<Uint8Array>;
  push(bytes: Uint8Array | string): void;
  close(): void;
}

function controlledStream(): ControlledStream {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    body,
    push(bytes) {
      controller?.enqueue(
        typeof bytes === "string" ? encoder.encode(bytes) : bytes,
      );
    },
    close() {
      controller?.close();
    },
  };
}

function responseOf(options: {
  body?: ReadableStream<Uint8Array> | null;
  headers?: Record<string, string>;
  buffer?: ArrayBuffer;
  ok?: boolean;
  status?: number;
} = {}): ResponseLike {
  const headers = options.headers ?? {};
  const buffer = options.buffer ?? new ArrayBuffer(0);
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    body: options.body ?? null,
    async arrayBuffer(): Promise<ArrayBuffer> {
      return buffer;
    },
  };
}

function fakeFetch(responders: Array<() => ResponseLike>): {
  fetchImpl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const responder = responders.shift();
    if (responder === undefined) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    return responder();
  };
  return { fetchImpl, calls };
}

/** Lets pending stream reads and microtasks settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function recorder(sink: AssetProgress[]): (progress: AssetProgress) => void {
  return (progress) => {
    sink.push({ ...progress });
  };
}

function jsonResponse(value: unknown): () => ResponseLike {
  const text = JSON.stringify(value);
  return () => responseOf({ buffer: encoder.encode(text).buffer });
}

function textResponse(value: string): () => ResponseLike {
  return () => responseOf({ buffer: encoder.encode(value).buffer });
}

// ---------------------------------------------------------------------------
// Byte-accurate progress (FR-9.7)
// ---------------------------------------------------------------------------

describe("asset progress", () => {
  test("[FR-9.7] progress is bytes fetched over bytes declared, never time", async () => {
    const stream = controlledStream();
    const { fetchImpl, calls } = fakeFetch([
      () => responseOf({ body: stream.body }),
    ]);
    const loader = new AssetLoader([], { fetch: fetchImpl });
    const snapshots: AssetProgress[] = [];

    const loading = loader.load(
      [{ url: "/cube.bin", type: "texture", bytes: 100 }],
      recorder(snapshots),
    );

    await flush();
    expect(snapshots[0]).toMatchObject({
      loadedBytes: 0,
      totalBytes: 100,
      determinate: true,
      fraction: 0,
      loadedCount: 0,
      totalCount: 1,
      done: false,
    });

    stream.push(new Uint8Array(40));
    await flush();
    const at40 = snapshots.at(-1);
    expect(at40?.loadedBytes).toBe(40);
    expect(at40?.totalBytes).toBe(100);
    expect(at40?.fraction).toBeCloseTo(0.4, 10);
    expect(at40?.done).toBe(false);

    // No timer or count fake: nothing advances while the stream is silent.
    await flush();
    expect(snapshots.at(-1)?.loadedBytes).toBe(40);

    stream.push(new Uint8Array(60));
    stream.close();
    const result = await loading;

    expect(result.loadedBytes).toBe(100);
    expect(result.totalBytes).toBe(100);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.bytes).toBe(100);
    expect(snapshots.at(-1)?.done).toBe(true);
    expect(snapshots.at(-1)?.fraction).toBe(1);
    expect(calls).toEqual(["/cube.bin"]);
  });

  test("[FR-9.7] done is withheld until the bytes decode", async () => {
    let resolveDecode: (value: unknown) => void = () => {};
    const decodePromise = new Promise<unknown>((resolve) => {
      resolveDecode = resolve;
    });
    const stream = controlledStream();
    const { fetchImpl } = fakeFetch([
      () => responseOf({ body: stream.body }),
    ]);
    const loader = new AssetLoader([], {
      fetch: fetchImpl,
      decodeImage: () => decodePromise,
    });
    const snapshots: AssetProgress[] = [];

    const loading = loader.load(
      [{ url: "/tex.webp", type: "image", bytes: 10 }],
      recorder(snapshots),
    );

    await flush();
    stream.push(new Uint8Array(10));
    stream.close();
    await flush();

    const fetched = snapshots.at(-1);
    expect(fetched?.loadedBytes).toBe(10);
    expect(fetched?.fraction).toBe(1);
    expect(fetched?.done).toBe(false);
    const state = describeProgress(fetched as AssetProgress);
    expect(state).toMatchObject({
      mode: "determinate",
      percent: 100,
      label: "Finalizing…",
    });
    expect(state.label).not.toBe("Ready");

    resolveDecode("bitmap");
    const result = await loading;
    expect(result.assets[0]?.data).toBe("bitmap");
    expect(snapshots.at(-1)?.done).toBe(true);
    expect(describeProgress(snapshots.at(-1) as AssetProgress)).toMatchObject({
      mode: "complete",
      percent: 100,
      label: "Ready",
    });
  });

  test("[FR-9.7] an unknown total stays indeterminate, never a fake percentage", async () => {
    const stream = controlledStream();
    const { fetchImpl } = fakeFetch([
      () => responseOf({ body: stream.body }),
    ]);
    const loader = new AssetLoader([], { fetch: fetchImpl });
    const snapshots: AssetProgress[] = [];

    const loading = loader.load(
      [{ url: "/data.json", type: "json" }],
      recorder(snapshots),
    );

    await flush();
    stream.push('{"ready":');
    await flush();

    const mid = snapshots.at(-1) as AssetProgress;
    expect(mid.loadedBytes).toBe(9);
    expect(mid.determinate).toBe(false);
    expect(mid.fraction).toBeNull();
    expect(mid.totalBytes).toBe(0);
    expect(describeProgress(mid)).toMatchObject({
      mode: "indeterminate",
      percent: null,
      label: "Loading… (size unknown)",
    });

    stream.push("true}");
    stream.close();
    const result = await loading;
    expect(result.determinate).toBe(false);
    expect(result.assets[0]?.data).toEqual({ ready: true });
    expect(snapshots.at(-1)?.done).toBe(true);
    expect(describeProgress(snapshots.at(-1) as AssetProgress).mode).toBe(
      "complete",
    );
  });

  test("[FR-9.7] a Content-Length header promotes an unknown entry to determinate", async () => {
    const stream = controlledStream();
    const { fetchImpl } = fakeFetch([
      () => responseOf({ body: stream.body, headers: { "content-length": "80" } }),
    ]);
    const loader = new AssetLoader([], { fetch: fetchImpl });
    const snapshots: AssetProgress[] = [];

    const loading = loader.load(
      [{ url: "/blob.bin", type: "texture" }],
      recorder(snapshots),
    );

    await flush();
    const advertised = snapshots.at(-1);
    expect(advertised?.determinate).toBe(true);
    expect(advertised?.totalBytes).toBe(80);
    expect(advertised?.fraction).toBe(0);

    stream.push(new Uint8Array(20));
    await flush();
    const at20 = snapshots.at(-1);
    expect(at20?.determinate).toBe(true);
    expect(at20?.fraction).toBeCloseTo(0.25, 10);

    stream.push(new Uint8Array(60));
    stream.close();
    await loading;
    expect(snapshots.at(-1)?.done).toBe(true);
    expect(snapshots.at(-1)?.fraction).toBe(1);
  });

  test("[FR-9.7] an empty manifest completes immediately with no fetch", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const loader = new AssetLoader([], { fetch: fetchImpl });
    const snapshots: AssetProgress[] = [];

    const result = await loader.load([], recorder(snapshots));

    expect(calls).toHaveLength(0);
    expect(result.assets).toHaveLength(0);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ done: true, fraction: 1 });
  });
});

// ---------------------------------------------------------------------------
// Manifest validation, lazy groups, budget (FR-9.6) and the 5 MB cap (NR-6.1)
// ---------------------------------------------------------------------------

describe("asset manifest", () => {
  test("[FR-9.6] lazy groups fetch only their own assets", async () => {
    const { fetchImpl, calls } = fakeFetch([jsonResponse({ ok: true })]);
    const loader = new AssetLoader(
      [
        { url: "/ui.json", type: "json", group: "ui" },
        { url: "/level2.json", type: "json", group: "level2" },
      ],
      { fetch: fetchImpl },
    );

    expect(loader.groups()).toEqual(["ui", "level2"]);

    const result = await loader.loadGroup("level2");
    expect(calls).toEqual(["/level2.json"]);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.entry.url).toBe("/level2.json");
    expect(result.assets[0]?.data).toEqual({ ok: true });

    await expect(loader.loadGroup("missing")).rejects.toMatchObject({
      code: "unknownGroup",
    });
    expect(calls).toEqual(["/level2.json"]);
  });

  test("[FR-9.6] malformed manifests are rejected before any fetch", async () => {
    expect(() => new AssetLoader([{ url: "", type: "json" }])).toThrow(
      AssetLoadError,
    );

    const { fetchImpl, calls } = fakeFetch([]);
    const loader = new AssetLoader([], { fetch: fetchImpl });

    await expect(
      loader.load([
        { url: "/x", type: "blob" as unknown as AssetType },
        { url: "/y", type: "text", bytes: -1 },
      ]),
    ).rejects.toMatchObject({ code: "invalidManifest" });
    expect(calls).toHaveLength(0);

    expect(validateAssetEntries([{ url: "/ok", type: "json" }])).toEqual([]);
    expect(validateAssetEntries("nope")).toHaveLength(1);
    expect(validateAssetEntries([{ url: "/ok", type: "nope" }])).toHaveLength(1);
    expect(ASSET_TYPES).toContain("texture");
  });

  test("[FR-9.6, NR-6.1] an initial manifest over 5 MB is rejected before fetching", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const loader = new AssetLoader([], { fetch: fetchImpl });

    await expect(
      loader.load([
        {
          url: "/huge.bin",
          type: "texture",
          bytes: INITIAL_DOWNLOAD_LIMIT_BYTES + 1,
        },
      ]),
    ).rejects.toMatchObject({ code: "budgetExceeded" });
    expect(calls).toHaveLength(0);
  });

  test("[FR-9.6, NR-6.1] streamed bytes over the cap abort the download", async () => {
    const stream = controlledStream();
    const { fetchImpl } = fakeFetch([
      () => responseOf({ body: stream.body }),
    ]);
    const loader = new AssetLoader([], { fetch: fetchImpl, maxInitialBytes: 64 });
    const loading = loader.load([{ url: "/stream.bin", type: "texture" }]);

    await flush();
    stream.push(new Uint8Array(50));
    await flush();
    stream.push(new Uint8Array(20));

    await expect(loading).rejects.toMatchObject({ code: "budgetExceeded" });
  });

  test("[NR-6.1] the runtime cap matches the host hard budget", () => {
    const budgets = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../../tools/size-budget/budgets.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as { targets: { host: { hard: number } } };

    expect(INITIAL_DOWNLOAD_LIMIT_BYTES).toBe(5 * 1024 * 1024);
    expect(INITIAL_DOWNLOAD_LIMIT_BYTES).toBe(budgets.targets.host.hard);
  });
});

// ---------------------------------------------------------------------------
// Decode formats and cancellation
// ---------------------------------------------------------------------------

describe("asset decoding", () => {
  test("[FR-9.6] JSON, text, audio and texture keep their game-facing shapes", async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4]);
    const textureBytes = new Uint8Array([9, 8, 7]);
    const { fetchImpl, calls } = fakeFetch([
      jsonResponse({ level: 2 }),
      textResponse("hello"),
      () => responseOf({ buffer: audioBytes.buffer }),
      () => responseOf({ buffer: textureBytes.buffer }),
    ]);
    const loader = new AssetLoader([], { fetch: fetchImpl });

    const result = await loader.load([
      { url: "/level.json", type: "json" },
      { url: "/notes.txt", type: "text" },
      { url: "/hit.webm", type: "audio" },
      { url: "/atlas.ktx2", type: "texture" },
    ]);

    expect(calls).toHaveLength(4);
    expect(result.assets[0]?.data).toEqual({ level: 2 });
    expect(result.assets[1]?.data).toBe("hello");
    expect(result.assets[2]?.data).toBeInstanceOf(Blob);
    expect((result.assets[2]?.data as Blob).type).toBe("audio/webm");
    expect(result.assets[3]?.data).toEqual(textureBytes);
  });

  test("[FR-9.6] an image decode failure is reported as a decode error", async () => {
    const { fetchImpl } = fakeFetch([
      () => responseOf({ buffer: new ArrayBuffer(4) }),
    ]);
    const loader = new AssetLoader([], {
      fetch: fetchImpl,
      decodeImage: () => {
        throw new Error("bad image");
      },
    });

    await expect(
      loader.load([{ url: "/broken.png", type: "image" }]),
    ).rejects.toMatchObject({ code: "decode" });
  });

  test("[FR-9.6] a non-OK response is a network error naming the URL", async () => {
    const { fetchImpl } = fakeFetch([
      () => responseOf({ ok: false, status: 404 }),
    ]);
    const loader = new AssetLoader([], { fetch: fetchImpl });

    await expect(
      loader.load([{ url: "/missing.json", type: "json" }]),
    ).rejects.toMatchObject({ code: "network", url: "/missing.json" });
  });

  test("abort() rejects an in-flight load with code aborted", async () => {
    const stream = controlledStream();
    const { fetchImpl } = fakeFetch([
      () => responseOf({ body: stream.body }),
    ]);
    const loader = new AssetLoader([], { fetch: fetchImpl });
    const loading = loader.load([
      { url: "/slow.bin", type: "texture", bytes: 100 },
    ]);

    await flush();
    loader.abort();
    stream.push(new Uint8Array(1));

    await expect(loading).rejects.toMatchObject({ code: "aborted" });
  });
});

// ---------------------------------------------------------------------------
// Progress bar state machine (FR-9.7)
// ---------------------------------------------------------------------------

function progressOf(
  overrides: Partial<AssetProgress> = {},
): AssetProgress {
  return {
    loadedBytes: 40,
    totalBytes: 100,
    determinate: true,
    fraction: 0.4,
    loadedCount: 0,
    totalCount: 1,
    currentUrl: "/cube.bin",
    done: false,
    ...overrides,
  };
}

class FakeElement {
  className = "";
  textContent = "";
  innerHTML = "";
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const parent = this.parent;
    if (parent === null) {
      return;
    }
    const index = parent.children.indexOf(this);
    if (index >= 0) {
      parent.children.splice(index, 1);
    }
    this.parent = null;
  }
}

function fakeDocument(): Document {
  return {
    createElement: () => new FakeElement(),
  } as unknown as Document;
}

describe("progress bar", () => {
  test("[FR-9.7] the bar reports a percentage only when bytes are known", () => {
    expect(describeProgress(progressOf())).toMatchObject({
      mode: "determinate",
      percent: 40,
      label: "Loading… 40%",
    });

    expect(
      describeProgress(
        progressOf({
          determinate: false,
          fraction: null,
          totalBytes: 0,
          loadedBytes: 9,
        }),
      ),
    ).toMatchObject({ mode: "indeterminate", percent: null });

    expect(
      describeProgress(progressOf({ fraction: 1, loadedBytes: 100 })),
    ).toMatchObject({
      mode: "determinate",
      percent: 100,
      label: "Finalizing…",
    });

    expect(
      describeProgress(
        progressOf({ fraction: 1, loadedBytes: 100, done: true }),
      ),
    ).toMatchObject({ mode: "complete", percent: 100, label: "Ready" });
  });

  test("[FR-9.7] the DOM bar exposes ARIA state and drops the value when indeterminate", () => {
    const bar = new ProgressBar(fakeDocument());
    const root = bar.element as unknown as FakeElement;
    expect(root.attributes.get("role")).toBe("progressbar");
    expect(root.attributes.get("aria-valuemin")).toBe("0");
    expect(root.attributes.get("aria-valuemax")).toBe("100");

    const track = root.children[0];
    const fill = track?.children[0];
    const label = root.children[1];
    expect(fill).toBeDefined();

    bar.update(progressOf());
    expect(fill?.style["width"]).toBe("40%");
    expect(root.dataset["mode"]).toBe("determinate");
    expect(root.attributes.get("aria-valuenow")).toBe("40");
    expect(root.attributes.get("aria-valuetext")).toContain("40%");
    expect(label?.textContent).toBe("Loading… 40%");

    bar.update(progressOf({ determinate: false, fraction: null }));
    expect(fill?.style["width"]).toBe("100%");
    expect(root.dataset["mode"]).toBe("indeterminate");
    expect(root.attributes.has("aria-valuenow")).toBe(false);
    expect(root.attributes.get("aria-valuetext")).toContain("total size unknown");

    bar.update(progressOf({ fraction: 1, loadedBytes: 100, done: true }));
    expect(root.dataset["mode"]).toBe("complete");
    expect(root.attributes.get("aria-valuenow")).toBe("100");
    expect(label?.textContent).toBe("Ready");

    bar.dispose();
    expect(root.parent).toBeNull();
  });
});

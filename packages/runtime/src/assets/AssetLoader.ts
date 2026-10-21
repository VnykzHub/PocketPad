/**
 * Asset loader with byte-accurate progress (D3-RT-02, FR-9.6/9.7, NR-6.1).
 *
 * Contract frozen in `docs/todos/phase-1-dev/D3-runtime-v0.md`:
 * `load(entries, onProgress)` reports **bytes fetched over bytes declared**.
 * There is no timer-based or count-based fake:
 *
 * - a manifest `bytes` value is the declared size;
 * - otherwise a `Content-Length` header promotes the entry to a known size;
 * - otherwise the entry stays unknown, `determinate` is false and `fraction`
 *   is `null`, so `ProgressBar` renders an indeterminate bar (FR-9.7);
 * - bytes are counted from the response stream as chunks arrive;
 * - `done` only becomes true after every asset has decoded, so a full bar can
 *   never be mistaken for "ready" (the bar says "Finalizing…" until then).
 *
 * The initial manifest is capped at 5 MB (FR-9.6, NR-6.1): a declared total
 * over the cap is rejected before any request, and actual streamed bytes over
 * the cap abort the load. Lazy groups (`loadGroup`) let a game fetch the rest
 * per scene; only the requested group's URLs are fetched.
 *
 * Format hooks mirror SPEC §9.3: JSON/text decode inline, images use
 * `createImageBitmap` when available, audio stays a `Blob` for `AudioBus`
 * (D3-RT-05) to decode, and textures stay bytes for the future KTX2 hook.
 * glTF/Draco is intentionally absent (P6).
 *
 * This is a load-time path, not the frame loop: it may allocate per asset.
 */

export type AssetType = "image" | "audio" | "json" | "texture" | "text";

export const ASSET_TYPES: readonly AssetType[] = [
  "image",
  "audio",
  "json",
  "texture",
  "text",
];

/** SPEC §11 host hard cap: initial download ≤ 5 MB gz (FR-9.6, NR-6.1). */
export const INITIAL_DOWNLOAD_LIMIT_BYTES = 5 * 1024 * 1024;

export interface AssetEntry {
  readonly url: string;
  readonly type: AssetType;
  /** Declared size in bytes when the manifest knows it; omitted = unknown. */
  readonly bytes?: number;
  /** Lazy group name; `loadGroup` fetches only matching entries. */
  readonly group?: string;
}

export interface AssetProgress {
  /** Bytes actually read from response bodies so far. */
  readonly loadedBytes: number;
  /** Sum of currently known sizes (declared or Content-Length). */
  readonly totalBytes: number;
  /** False when at least one entry's total size is still unknown. */
  readonly determinate: boolean;
  /** `loadedBytes / totalBytes` clamped to [0,1], or null if indeterminate. */
  readonly fraction: number | null;
  /** Entries fully fetched and decoded. */
  readonly loadedCount: number;
  readonly totalCount: number;
  /** URL currently being fetched, or null between entries / when done. */
  readonly currentUrl: string | null;
  /** True only after every entry fetched *and* decoded. */
  readonly done: boolean;
}

export interface LoadedAsset {
  readonly entry: AssetEntry;
  readonly bytes: number;
  /** Decoded JSON, image, audio Blob, texture bytes or text. */
  readonly data: unknown;
}

export interface LoadResult {
  readonly assets: readonly LoadedAsset[];
  readonly loadedBytes: number;
  readonly totalBytes: number;
  readonly determinate: boolean;
}

export type AssetErrorCode =
  | "invalidManifest"
  | "budgetExceeded"
  | "network"
  | "decode"
  | "aborted"
  | "unknownGroup";

export class AssetLoadError extends Error {
  readonly code: AssetErrorCode;
  readonly url: string | null;

  constructor(code: AssetErrorCode, message: string, url: string | null = null) {
    super(message);
    this.name = "AssetLoadError";
    this.code = code;
    this.url = url;
  }
}

/** The subset of `Response` the loader relies on; easy to fake in tests. */
export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<ResponseLike>;

export interface AssetLoaderDeps {
  readonly fetch?: FetchLike;
  readonly decodeImage?: (
    blob: Blob,
    entry: AssetEntry,
  ) => unknown | Promise<unknown>;
  readonly decodeAudio?: (
    blob: Blob,
    entry: AssetEntry,
  ) => unknown | Promise<unknown>;
  readonly decodeTexture?: (
    bytes: Uint8Array,
    entry: AssetEntry,
  ) => unknown | Promise<unknown>;
  /** Defaults to 5 MB; applies to every `load`/`loadGroup` call. */
  readonly maxInitialBytes?: number;
  /** External cancellation; `AssetLoader.abort()` also works. */
  readonly signal?: AbortSignal;
}

const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init) as unknown as Promise<ResponseLike>;

/**
 * Validates an untrusted asset list, returning every problem in one pass.
 * Empty means valid. Entries are not copied or mutated.
 */
export function validateAssetEntries(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ["assets: must be an array"];
  }
  const errors: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`assets[${index}]: must be an object`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const url = record["url"];
    if (typeof url !== "string" || url.trim().length === 0) {
      errors.push(`assets[${index}].url: must be a non-empty string`);
    }
    const type = record["type"];
    if (
      typeof type !== "string" ||
      !ASSET_TYPES.includes(type as AssetType)
    ) {
      errors.push(
        `assets[${index}].type: must be one of ${ASSET_TYPES.join(", ")}`,
      );
    }
    const bytes = record["bytes"];
    if (
      bytes !== undefined &&
      (typeof bytes !== "number" ||
        !Number.isFinite(bytes) ||
        !Number.isInteger(bytes) ||
        bytes < 0)
    ) {
      errors.push(
        `assets[${index}].bytes: must be a non-negative integer when present`,
      );
    }
    const group = record["group"];
    if (
      group !== undefined &&
      (typeof group !== "string" || group.trim().length === 0)
    ) {
      errors.push(
        `assets[${index}].group: must be a non-empty string when present`,
      );
    }
  }
  return errors;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contentLengthOf(response: ResponseLike): number | null {
  let header: string | null;
  try {
    header = response.headers.get("content-length");
  } catch {
    return null;
  }
  if (header === null) {
    return null;
  }
  const value = Number(header);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function mimeFor(url: string, kind: "image" | "audio"): string {
  const lower = url.toLowerCase();
  if (kind === "image") {
    if (lower.endsWith(".png")) {
      return "image/png";
    }
    if (lower.endsWith(".webp")) {
      return "image/webp";
    }
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    return "application/octet-stream";
  }
  if (lower.endsWith(".webm")) {
    return "audio/webm";
  }
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) {
    return "audio/ogg";
  }
  if (
    lower.endsWith(".m4a") ||
    lower.endsWith(".aac") ||
    lower.endsWith(".mp4")
  ) {
    return "audio/mp4";
  }
  if (lower.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  return "application/octet-stream";
}

export class AssetLoader {
  private readonly entries: readonly AssetEntry[];
  private readonly deps: AssetLoaderDeps;
  private readonly fetchImpl: FetchLike;
  private readonly maxInitialBytes: number;
  private activeController: AbortController | null = null;
  private aborted = false;

  constructor(entries: readonly AssetEntry[] = [], deps: AssetLoaderDeps = {}) {
    const errors = validateAssetEntries(entries);
    if (errors.length > 0) {
      throw new AssetLoadError("invalidManifest", errors.join("; "));
    }
    const max = deps.maxInitialBytes;
    if (max !== undefined && (!Number.isFinite(max) || max <= 0)) {
      throw new RangeError("AssetLoader maxInitialBytes must be positive.");
    }
    this.entries = entries.slice();
    this.deps = deps;
    this.fetchImpl = deps.fetch ?? defaultFetch;
    this.maxInitialBytes = max ?? INITIAL_DOWNLOAD_LIMIT_BYTES;
  }

  /** Group names declared by the manifest, in first-seen order. */
  groups(): string[] {
    const names: string[] = [];
    for (const entry of this.entries) {
      const group = entry.group;
      if (group !== undefined && !names.includes(group)) {
        names.push(group);
      }
    }
    return names;
  }

  /**
   * Fetches and decodes `entries` (defaults to the constructor manifest).
   * `onProgress` receives a fresh snapshot on start, on every streamed chunk,
   * after every decode and once with `done: true` at the end.
   */
  async load(
    entries: readonly AssetEntry[] = this.entries,
    onProgress?: (progress: AssetProgress) => void,
  ): Promise<LoadResult> {
    const errors = validateAssetEntries(entries);
    if (errors.length > 0) {
      throw new AssetLoadError("invalidManifest", errors.join("; "));
    }
    const list = entries.slice();
    const count = list.length;

    if (count === 0) {
      onProgress?.({
        loadedBytes: 0,
        totalBytes: 0,
        determinate: true,
        fraction: 1,
        loadedCount: 0,
        totalCount: 0,
        currentUrl: null,
        done: true,
      });
      return { assets: [], loadedBytes: 0, totalBytes: 0, determinate: true };
    }

    const declaredBytes = declaredTotal(list);
    if (declaredBytes > this.maxInitialBytes) {
      throw new AssetLoadError(
        "budgetExceeded",
        `Declared assets total ${declaredBytes} bytes, over the ` +
          `${this.maxInitialBytes}-byte initial-download cap.`,
      );
    }

    this.aborted = false;
    const controller = new AbortController();
    this.activeController = controller;
    const signal = controller.signal;
    const external = this.deps.signal;
    const onExternalAbort = (): void => {
      this.aborted = true;
      controller.abort();
    };
    if (external !== undefined) {
      if (external.aborted) {
        onExternalAbort();
      } else {
        external.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const totals: Array<number | null> = new Array<number | null>(count).fill(
      null,
    );
    let knownTotalBytes = 0;
    for (let index = 0; index < count; index += 1) {
      const entry = list[index];
      const declared = entry?.bytes;
      if (declared !== undefined && declared > 0) {
        totals[index] = declared;
        knownTotalBytes += declared;
      }
    }

    let totalLoadedBytes = 0;
    let decodedCount = 0;
    let currentUrl: string | null = null;

    const emit = (): void => {
      if (onProgress === undefined) {
        return;
      }
      let determinate = true;
      for (let index = 0; index < count; index += 1) {
        if (totals[index] === null || totals[index] === undefined) {
          determinate = false;
          break;
        }
      }
      const fraction =
        determinate && knownTotalBytes > 0
          ? Math.min(1, totalLoadedBytes / knownTotalBytes)
          : determinate
            ? 1
            : null;
      onProgress({
        loadedBytes: totalLoadedBytes,
        totalBytes: knownTotalBytes,
        determinate,
        fraction,
        loadedCount: decodedCount,
        totalCount: count,
        currentUrl,
        done: false,
      });
    };

    emit();

    try {
      const assets: LoadedAsset[] = [];
      for (let index = 0; index < count; index += 1) {
        this.throwIfAborted(controller, currentUrl);
        const entry = list[index];
        if (entry === undefined) {
          continue;
        }
        currentUrl = entry.url;

        let response: ResponseLike;
        try {
          response = await this.fetchImpl(entry.url, { signal });
        } catch (error) {
          if (this.aborted || signal.aborted) {
            throw this.abortError(entry.url);
          }
          throw new AssetLoadError(
            "network",
            `Failed to fetch ${entry.url}: ${messageOf(error)}`,
            entry.url,
          );
        }

        if (!response.ok) {
          throw new AssetLoadError(
            "network",
            `Fetch ${entry.url} failed with HTTP ${response.status}.`,
            entry.url,
          );
        }

        if (totals[index] === null || totals[index] === undefined) {
          const headerBytes = contentLengthOf(response);
          if (headerBytes !== null) {
            totals[index] = headerBytes;
            knownTotalBytes += headerBytes;
          }
        }
        emit();

        let entryBytes = 0;
        const bytes = await this.readBody(
          response,
          controller,
          entry.url,
          (chunkBytes) => {
            entryBytes += chunkBytes;
            totalLoadedBytes += chunkBytes;
            if (totalLoadedBytes > this.maxInitialBytes) {
              throw new AssetLoadError(
                "budgetExceeded",
                `Downloaded more than the ${this.maxInitialBytes}-byte ` +
                  "initial-download cap.",
                entry.url,
              );
            }
            emit();
          },
        );

        let data: unknown;
        try {
          data = await this.decode(entry, bytes);
        } catch (error) {
          if (this.aborted || signal.aborted) {
            throw this.abortError(entry.url);
          }
          if (error instanceof AssetLoadError) {
            throw error;
          }
          throw new AssetLoadError(
            "decode",
            `Failed to decode ${entry.url}: ${messageOf(error)}`,
            entry.url,
          );
        }

        assets.push({ entry, bytes: entryBytes, data });
        decodedCount += 1;
        currentUrl = null;
        emit();
      }

      let determinate = true;
      for (let index = 0; index < count; index += 1) {
        if (totals[index] === null || totals[index] === undefined) {
          determinate = false;
          break;
        }
      }

      if (onProgress !== undefined) {
        onProgress({
          loadedBytes: totalLoadedBytes,
          totalBytes: knownTotalBytes,
          determinate,
          fraction: determinate ? 1 : null,
          loadedCount: decodedCount,
          totalCount: count,
          currentUrl: null,
          done: true,
        });
      }

      return {
        assets,
        loadedBytes: totalLoadedBytes,
        totalBytes: knownTotalBytes,
        determinate,
      };
    } finally {
      if (external !== undefined) {
        external.removeEventListener("abort", onExternalAbort);
      }
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }
  }

  /**
   * Loads only entries whose `group` equals `name` (FR-9.6 lazy loading).
   * Throws `unknownGroup` for a typo instead of silently loading nothing.
   */
  async loadGroup(
    name: string,
    onProgress?: (progress: AssetProgress) => void,
  ): Promise<LoadResult> {
    const selected: AssetEntry[] = [];
    for (const entry of this.entries) {
      if (entry.group === name) {
        selected.push(entry);
      }
    }
    if (selected.length === 0) {
      throw new AssetLoadError(
        "unknownGroup",
        `No assets are declared in group "${name}".`,
      );
    }
    return this.load(selected, onProgress);
  }

  /** Cancels the in-flight load, if any; the pending promise rejects. */
  abort(): void {
    this.aborted = true;
    const controller = this.activeController;
    if (controller !== null) {
      controller.abort();
    }
  }

  private abortError(url: string | null): AssetLoadError {
    return new AssetLoadError(
      "aborted",
      url === null ? "Asset load aborted." : `Asset load aborted at ${url}.`,
      url,
    );
  }

  private throwIfAborted(
    controller: AbortController,
    url: string | null,
  ): void {
    if (this.aborted || controller.signal.aborted) {
      throw this.abortError(url);
    }
  }

  private async readBody(
    response: ResponseLike,
    controller: AbortController,
    url: string,
    onChunk: (chunkBytes: number) => void,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const body = response.body;
    if (body === null) {
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      onChunk(bytes.byteLength);
      return bytes;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        this.throwIfAborted(controller, url);
        const result = await reader.read();
        if (result.done) {
          break;
        }
        const value = result.value;
        if (value !== undefined) {
          chunks.push(value);
          total += value.byteLength;
          onChunk(value.byteLength);
        }
      }
    } catch (error) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be errored; the original failure wins.
      }
      if (this.aborted || controller.signal.aborted) {
        throw this.abortError(url);
      }
      if (error instanceof AssetLoadError) {
        throw error;
      }
      throw new AssetLoadError(
        "network",
        `Stream failed for ${url}: ${messageOf(error)}`,
        url,
      );
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private async decode(
    entry: AssetEntry,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<unknown> {
    switch (entry.type) {
      case "json": {
        let text: string;
        try {
          text = new TextDecoder().decode(bytes);
        } catch (error) {
          throw new AssetLoadError(
            "decode",
            `Invalid text in ${entry.url}: ${messageOf(error)}`,
            entry.url,
          );
        }
        try {
          return JSON.parse(text);
        } catch (error) {
          throw new AssetLoadError(
            "decode",
            `Invalid JSON in ${entry.url}: ${messageOf(error)}`,
            entry.url,
          );
        }
      }
      case "text":
        return new TextDecoder().decode(bytes);
      case "image": {
        const blob = new Blob([bytes], { type: mimeFor(entry.url, "image") });
        if (this.deps.decodeImage !== undefined) {
          return await this.deps.decodeImage(blob, entry);
        }
        if (typeof createImageBitmap === "function") {
          return await createImageBitmap(blob);
        }
        return blob;
      }
      case "audio": {
        // AudioBus (D3-RT-05) owns decoding so the loader never creates an
        // AudioContext before the start-screen gesture (FR-9.11).
        const blob = new Blob([bytes], { type: mimeFor(entry.url, "audio") });
        if (this.deps.decodeAudio !== undefined) {
          return await this.deps.decodeAudio(blob, entry);
        }
        return blob;
      }
      case "texture": {
        if (this.deps.decodeTexture !== undefined) {
          return await this.deps.decodeTexture(bytes, entry);
        }
        return bytes;
      }
      default:
        return bytes;
    }
  }
}

function declaredTotal(entries: readonly AssetEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    const bytes = entry.bytes;
    if (bytes !== undefined && bytes > 0) {
      total += bytes;
    }
  }
  return total;
}

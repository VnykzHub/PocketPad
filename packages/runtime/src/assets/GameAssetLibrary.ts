/**
 * Runtime `AssetLibrary` for a game's spec-23 `assets.json` (stream B).
 *
 * The manifest arrives already validated by `validateAssetManifest` (SDK).
 * This library re-checks the budget before fetching anything, then loads the
 * eager group with byte-accurate progress and serves lazy groups by id.
 *
 * Rules this file owns:
 * - Every response body must match the declared `bytes` exactly; a short or
 *   long read fails the asset instead of silently continuing.
 * - Only paths declared in `assets.json` are fetched, resolved inside the game
 *   folder. There is no fallback to `Game-assets/` or a remote URL.
 * - Audio bytes stay encoded until `AudioBus.unlock()` produced a context.
 *   `registerAudio` is the only decode entry point and refuses while locked.
 * - `dispose()` silences in-flight loads; it never throws.
 */
import { ASSET_BOOT_HARD_CAP_BYTES } from "@lanpad/sdk";
import type {
  AssetBudgetLimits,
  AssetDeclaration,
  AssetFailure,
  AssetHandle,
  AssetKind,
  AssetLibrary,
  AssetProgress,
  AssetState,
  GameAssetsManifest,
} from "@lanpad/sdk";
import type {
  GameAudioRegistration,
  GameAudioRegistrationFailure,
  GameAudioSink,
} from "../audio/GameAudioAssets.js";
import type { FetchLike, ResponseLike } from "./AssetLoader.js";

export type GameAssetErrorCode =
  | "E_ASSET_UNKNOWN"
  | "E_ASSET_NOT_READY"
  | "E_ASSET_NETWORK"
  | "E_ASSET_BYTE_MISMATCH"
  | "E_ASSET_DECODE"
  | "E_ASSET_LOCKED"
  | "E_ASSET_BUDGET"
  | "E_ASSET_PATH"
  | "E_ASSET_SCHEMA"
  | "E_ASSET_DISPOSED";

/** Thrown by `loadEager`, `loadGroup`, `load` and `registerAudio`. */
export class GameAssetError extends Error {
  readonly code: GameAssetErrorCode;
  readonly assetId: string | null;
  readonly retryable: boolean;

  constructor(
    code: GameAssetErrorCode,
    message: string,
    options: {
      readonly assetId?: string;
      readonly retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "GameAssetError";
    this.code = code;
    this.assetId = options.assetId ?? null;
    this.retryable = options.retryable ?? false;
  }
}

/** Per-kind decoder seam; audio is intentionally absent (gesture rule). */
export type GameAssetDecoder = (
  bytes: Uint8Array,
  asset: AssetDeclaration,
) => unknown | Promise<unknown>;

export interface GameAssetDecodeHooks {
  readonly mesh?: GameAssetDecoder;
  readonly texture?: GameAssetDecoder;
  readonly material?: GameAssetDecoder;
  readonly font?: GameAssetDecoder;
  readonly json?: GameAssetDecoder;
  readonly scene?: GameAssetDecoder;
  readonly animation?: GameAssetDecoder;
}

export interface GameAssetLibraryOptions {
  readonly manifest: GameAssetsManifest;
  /** Directory URL of the game folder; must end with "/". */
  readonly baseUrl: string;
  /** `manifest.assetBudget` from the game manifest. */
  readonly budget: AssetBudgetLimits;
  readonly fetch?: FetchLike;
  readonly decode?: GameAssetDecodeHooks;
  /** Defaults to `ASSET_BOOT_HARD_CAP_BYTES` (5 MiB). */
  readonly bootCapBytes?: number;
  readonly signal?: AbortSignal;
}

/** Outcome of loading one group. `loadEager` rejects on the first failure. */
export interface GameAssetGroupResult {
  readonly handles: readonly AssetHandle[];
  readonly failures: readonly AssetFailure[];
  /** Bytes transferred for this batch (cached assets count their size). */
  readonly loadedBytes: number;
  readonly declaredBytes: number;
}

interface AssetRecord {
  readonly declaration: AssetDeclaration;
  state: AssetState;
  value: unknown;
  failure: AssetFailure | null;
  /** Encoded size on disk; `loadedBytes` reports this, not decoded size. */
  sourceBytes: number;
  audioDecoded: boolean;
  pending: Promise<void> | null;
}

interface MutableProgress {
  fetched: number;
  declared: number;
  determinate: boolean;
  state: AssetProgress["state"];
  loadedCount: number;
  totalCount: number;
  currentId: string | null;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function concatChunks(
  chunks: readonly Uint8Array[],
  total: number,
): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

class GameAssetHandle<T> implements AssetHandle<T> {
  readonly id: string;
  readonly kind: AssetKind;
  private readonly record: AssetRecord;
  private refs = 1;

  constructor(record: AssetRecord) {
    this.record = record;
    this.id = record.declaration.id;
    this.kind = record.declaration.kind;
  }

  get state(): AssetState {
    return this.record.state;
  }

  get value(): T {
    if (this.record.state !== "ready") {
      throw new GameAssetError(
        "E_ASSET_NOT_READY",
        `Asset "${this.id}" is ${this.record.state}, not ready.`,
        { assetId: this.id },
      );
    }
    return this.record.value as T;
  }

  retain(): AssetHandle<T> {
    this.refs += 1;
    return this;
  }

  release(): void {
    if (this.refs > 0) this.refs -= 1;
  }

  get failed(): AssetFailure | null {
    return this.record.failure;
  }
}

export class GameAssetLibrary implements AssetLibrary {
  private readonly manifest: GameAssetsManifest;
  private readonly budget: AssetBudgetLimits;
  private readonly fetchImpl: FetchLike;
  private readonly decodeHooks: GameAssetDecodeHooks;
  private readonly bootCapBytes: number;
  private readonly baseUrl: string;
  private readonly signal: AbortSignal | null;
  private readonly groupModes = new Map<string, "eager" | "lazy">();
  private readonly records = new Map<string, AssetRecord>();
  private readonly progressListeners = new Set<
    (progress: AssetProgress) => void
  >();
  private readonly registeredAudio = new Set<string>();
  private readonly batchIds = new Set<string>();
  private readonly batchSettled = new Set<string>();
  private readonly progressObject: MutableProgress = {
    fetched: 0,
    declared: 0,
    determinate: false,
    state: "idle",
    loadedCount: 0,
    totalCount: 0,
    currentId: null,
  };
  private batchFailed = false;
  private audioSink: GameAudioSink | null = null;
  private disposed = false;

  constructor(options: GameAssetLibraryOptions) {
    this.manifest = options.manifest;
    this.budget = options.budget;
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.decodeHooks = options.decode ?? {};
    this.bootCapBytes = options.bootCapBytes ?? ASSET_BOOT_HARD_CAP_BYTES;
    this.signal = options.signal ?? null;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);

    for (const group of options.manifest.groups) {
      this.groupModes.set(group.id, group.mode);
    }
    for (const declaration of options.manifest.assets) {
      if (!this.groupModes.has(declaration.group)) {
        throw new GameAssetError(
          "E_ASSET_SCHEMA",
          `Asset "${declaration.id}" names unknown group "${declaration.group}".`,
          { assetId: declaration.id },
        );
      }
      this.records.set(declaration.id, {
        declaration,
        state: "queued",
        value: undefined,
        failure: null,
        sourceBytes: 0,
        audioDecoded: false,
        pending: null,
      });
    }
    this.assertBudgets();
  }

  get loadedBytes(): number {
    let total = 0;
    for (const record of this.records.values()) {
      if (record.state === "ready") total += record.sourceBytes;
    }
    return total;
  }

  get budgetBytes(): number {
    return this.budget.totalBytes;
  }

  /** Stable object mutated in place, matching the engine library contract. */
  get progress(): AssetProgress {
    return this.progressObject;
  }

  async load<T = unknown>(id: string): Promise<AssetHandle<T>> {
    this.assertNotDisposed();
    const handle = await this.loadInternal(id);
    return handle as AssetHandle<T>;
  }

  get<T = unknown>(id: string): AssetHandle<T> | undefined {
    const record = this.records.get(id);
    if (record === undefined || record.state !== "ready") return undefined;
    return new GameAssetHandle<T>(record);
  }

  /**
   * Loads every asset in an eager group, sequentially, in declaration order.
   * Rejects on the first failure with a `GameAssetError` carrying the same
   * code as the failed handle. No lazy asset is requested here.
   */
  async loadEager(
    onProgress?: (progress: AssetProgress) => void,
  ): Promise<GameAssetGroupResult> {
    this.assertNotDisposed();
    const ids = this.assetIdsInEagerGroups();
    const detach = onProgress === undefined ? null : this.onProgress(onProgress);
    try {
      this.beginBatch(ids);
      const handles: AssetHandle[] = [];
      for (const id of ids) {
        const handle = await this.loadInternal(id);
        if (handle.state === "failed" && handle.failed !== null) {
          this.failBatch();
          throw new GameAssetError(
            handle.failed.code as GameAssetErrorCode,
            handle.failed.message,
            { assetId: id, retryable: handle.failed.retryable },
          );
        }
        handles.push(handle);
      }
      return this.groupResult(handles);
    } finally {
      detach?.();
    }
  }

  /**
   * Loads one named group by id. Unlike `loadEager` it collects failures so a
   * caller can show per-asset placeholders, but the progress state still ends
   * `failed` if any asset failed.
   */
  async loadGroup(
    group: string,
    onProgress?: (progress: AssetProgress) => void,
  ): Promise<GameAssetGroupResult> {
    this.assertNotDisposed();
    if (!this.groupModes.has(group)) {
      throw new GameAssetError(
        "E_ASSET_UNKNOWN",
        `Group "${group}" is not declared in assets.json.`,
      );
    }
    const ids = this.assetIds(group);
    const detach = onProgress === undefined ? null : this.onProgress(onProgress);
    try {
      this.beginBatch(ids);
      const handles: AssetHandle[] = [];
      for (const id of ids) {
        handles.push(await this.loadInternal(id));
      }
      return this.groupResult(handles);
    } finally {
      detach?.();
    }
  }

  onProgress(listener: (progress: AssetProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  /** Asset ids in declaration order; a group filter is optional. */
  assetIds(group?: string): readonly string[] {
    const ids: string[] = [];
    for (const declaration of this.manifest.assets) {
      if (group === undefined || declaration.group === group) {
        ids.push(declaration.id);
      }
    }
    return ids;
  }

  /**
   * Decodes loaded audio assets and registers them on the bus under their
   * asset id, in declaration order. Must run after the start gesture unlocked
   * the bus; throws `E_ASSET_LOCKED` otherwise. A host with no Web Audio at all
   * (`available === false`) returns `skipped: true` and the game still starts.
   * Decode errors are returned per asset, never thrown.
   */
  async registerAudio(sink: GameAudioSink): Promise<GameAudioRegistration> {
    this.assertNotDisposed();
    if (sink.available === false) {
      return { registered: [], failures: [], skipped: true };
    }
    if (!sink.unlocked) {
      throw new GameAssetError(
        "E_ASSET_LOCKED",
        "Audio is locked; call AudioBus.unlock() from the start gesture before registering game audio.",
        { retryable: true },
      );
    }

    this.audioSink = sink;
    const registered: string[] = [];
    const failures: GameAudioRegistrationFailure[] = [];

    for (const declaration of this.manifest.assets) {
      if (declaration.kind !== "audio") continue;
      const record = this.records.get(declaration.id);
      if (record === undefined || record.state !== "ready") continue;

      if (record.audioDecoded) {
        if (!this.registeredAudio.has(declaration.id)) {
          this.registerDecodedAudio(
            sink,
            declaration.id,
            record.value as AudioBuffer,
          );
          registered.push(declaration.id);
        }
        continue;
      }
      if (!(record.value instanceof Uint8Array)) continue;

      try {
        const buffer = await sink.decodeAudio(
          toExactArrayBuffer(record.value),
        );
        record.value = buffer;
        record.audioDecoded = true;
        this.registerDecodedAudio(sink, declaration.id, buffer);
        registered.push(declaration.id);
      } catch (error) {
        failures.push({
          id: declaration.id,
          code: "E_ASSET_DECODE",
          message: `Asset "${declaration.id}" failed to decode: ${messageOf(error)}`,
        });
      }
    }

    return { registered, failures, skipped: false };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.records.values()) {
      record.state = "disposed";
      record.value = undefined;
      record.pending = null;
    }
    const progress = this.progressObject;
    progress.state = "idle";
    progress.currentId = null;
    this.progressListeners.clear();
    this.registeredAudio.clear();
    this.audioSink = null;
  }

  // -------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------

  private async loadInternal(id: string): Promise<AssetHandle> {
    const record = this.records.get(id);
    if (record === undefined) {
      throw new GameAssetError(
        "E_ASSET_UNKNOWN",
        `Asset "${id}" is not declared in assets.json.`,
        { assetId: id },
      );
    }

    if (!this.batchIds.has(id)) {
      if (this.progressObject.state === "loading") {
        this.joinBatch(id);
      } else {
        this.beginBatch([id]);
      }
    }

    if (record.state === "ready") {
      // A cached asset still counts toward the batch total so progress ends
      // exactly at `declared` instead of stalling short of it.
      this.recordFetched(id, record.sourceBytes);
      this.completeBatchItem(id, false);
      return new GameAssetHandle(record);
    }
    if (record.state === "loading" && record.pending !== null) {
      await record.pending;
      return new GameAssetHandle(record);
    }
    if (record.state === "failed") {
      this.completeBatchItem(id, true);
      return new GameAssetHandle(record);
    }

    record.state = "loading";
    record.failure = null;
    const progress = this.progressObject;
    progress.state = "loading";
    progress.currentId = id;
    this.emitProgress();

    const pending = this.fetchAndDecode(record);
    record.pending = pending;
    try {
      await pending;
    } finally {
      if (record.pending === pending) record.pending = null;
    }
    return new GameAssetHandle(record);
  }

  private async fetchAndDecode(record: AssetRecord): Promise<void> {
    const id = record.declaration.id;
    try {
      const bytes = await this.fetchAsset(record);
      if (this.disposed) {
        record.state = "disposed";
        return;
      }
      record.sourceBytes = bytes.byteLength;
      record.value = await this.decodeAsset(record, bytes);
      if (this.disposed) {
        record.state = "disposed";
        return;
      }
      record.state = "ready";
      record.failure = null;
      this.completeBatchItem(id, false);
    } catch (error) {
      if (this.disposed) {
        record.state = "disposed";
        return;
      }
      record.state = "failed";
      record.failure = toFailure(id, error);
      this.completeBatchItem(id, true);
    }
  }

  private async fetchAsset(record: AssetRecord): Promise<Uint8Array> {
    const declaration = record.declaration;
    const url = this.resolveUrl(declaration.path);
    let response: ResponseLike;
    try {
      response =
        this.signal === null
          ? await this.fetchImpl(url)
          : await this.fetchImpl(url, { signal: this.signal });
    } catch (error) {
      throw new GameAssetError(
        "E_ASSET_NETWORK",
        `Fetching "${declaration.path}" failed: ${messageOf(error)}`,
        { assetId: declaration.id, retryable: true },
      );
    }
    if (!response.ok) {
      throw new GameAssetError(
        "E_ASSET_NETWORK",
        `Fetching "${declaration.path}" failed with HTTP ${response.status}.`,
        {
          assetId: declaration.id,
          retryable: response.status >= 500,
        },
      );
    }

    const bytes = await this.readResponse(declaration, response);
    if (bytes.byteLength !== declaration.bytes) {
      throw new GameAssetError(
        "E_ASSET_BYTE_MISMATCH",
        `Asset "${declaration.id}" declares ${declaration.bytes} bytes but "${declaration.path}" has ${bytes.byteLength}.`,
        { assetId: declaration.id },
      );
    }
    return bytes;
  }

  private async readResponse(
    declaration: AssetDeclaration,
    response: ResponseLike,
  ): Promise<Uint8Array> {
    const id = declaration.id;
    if (response.body === null) {
      let buffer: ArrayBuffer;
      try {
        buffer = await response.arrayBuffer();
      } catch (error) {
        throw new GameAssetError(
          "E_ASSET_NETWORK",
          `Reading "${declaration.path}" failed: ${messageOf(error)}`,
          { assetId: id, retryable: true },
        );
      }
      const bytes = new Uint8Array(buffer);
      this.recordFetched(id, bytes.byteLength);
      if (bytes.byteLength > declaration.bytes) {
        throw new GameAssetError(
          "E_ASSET_BYTE_MISMATCH",
          `Asset "${id}" declares ${declaration.bytes} bytes but the response is larger.`,
          { assetId: id },
        );
      }
      return bytes;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value;
        if (chunk === undefined || chunk.byteLength === 0) continue;
        total += chunk.byteLength;
        this.recordFetched(id, chunk.byteLength);
        if (total > declaration.bytes) {
          await reader.cancel().catch(() => undefined);
          throw new GameAssetError(
            "E_ASSET_BYTE_MISMATCH",
            `Asset "${id}" declares ${declaration.bytes} bytes but the response is larger.`,
            { assetId: id },
          );
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof GameAssetError) throw error;
      throw new GameAssetError(
        "E_ASSET_NETWORK",
        `Reading "${declaration.path}" failed: ${messageOf(error)}`,
        { assetId: id, retryable: true },
      );
    } finally {
      reader.releaseLock();
    }
    return concatChunks(chunks, total);
  }

  private async decodeAsset(
    record: AssetRecord,
    bytes: Uint8Array,
  ): Promise<unknown> {
    const declaration = record.declaration;
    if (declaration.kind === "audio") {
      const sink = this.audioSink;
      if (sink === null || !sink.unlocked) return bytes;
      try {
        const buffer = await sink.decodeAudio(toExactArrayBuffer(bytes));
        record.audioDecoded = true;
        this.registerDecodedAudio(sink, declaration.id, buffer);
        return buffer;
      } catch (error) {
        throw new GameAssetError(
          "E_ASSET_DECODE",
          `Asset "${declaration.id}" failed to decode: ${messageOf(error)}`,
          { assetId: declaration.id },
        );
      }
    }

    const decoder = this.decoderFor(declaration.kind);
    try {
      if (decoder !== undefined) return await decoder(bytes, declaration);
      if (declaration.kind === "json") {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      }
      return bytes;
    } catch (error) {
      if (error instanceof GameAssetError) throw error;
      throw new GameAssetError(
        "E_ASSET_DECODE",
        `Asset "${declaration.id}" failed to decode: ${messageOf(error)}`,
        { assetId: declaration.id },
      );
    }
  }

  private decoderFor(kind: AssetKind): GameAssetDecoder | undefined {
    switch (kind) {
      case "mesh":
        return this.decodeHooks.mesh;
      case "texture":
        return this.decodeHooks.texture;
      case "material":
        return this.decodeHooks.material;
      case "font":
        return this.decodeHooks.font;
      case "json":
        return this.decodeHooks.json;
      case "scene":
        return this.decodeHooks.scene;
      case "animation":
        return this.decodeHooks.animation;
      case "audio":
        return undefined;
    }
  }

  private registerDecodedAudio(
    sink: GameAudioSink,
    id: string,
    buffer: AudioBuffer,
  ): void {
    sink.registerSfx(id, buffer);
    sink.registerMusic(id, buffer);
    this.registeredAudio.add(id);
  }

  // -------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------

  private beginBatch(ids: readonly string[]): void {
    this.batchIds.clear();
    this.batchSettled.clear();
    this.batchFailed = false;
    const progress = this.progressObject;
    progress.fetched = 0;
    progress.declared = 0;
    progress.determinate = false;
    progress.state = "idle";
    progress.loadedCount = 0;
    progress.totalCount = 0;
    progress.currentId = null;
    for (const id of ids) this.joinBatch(id);
    if (progress.totalCount === 0) {
      progress.state = "ready";
      this.emitProgress();
    }
  }

  private joinBatch(id: string): void {
    if (this.batchIds.has(id)) return;
    const record = this.records.get(id);
    if (record === undefined) return;
    this.batchIds.add(id);
    const progress = this.progressObject;
    progress.totalCount = this.batchIds.size;
    progress.declared += record.declaration.bytes;
    progress.determinate = true;
    progress.state = "loading";
    progress.currentId = id;
    this.emitProgress();
  }

  private recordFetched(id: string, bytes: number): void {
    const progress = this.progressObject;
    progress.fetched += bytes;
    progress.currentId = id;
    this.emitProgress();
  }

  private completeBatchItem(id: string, failed: boolean): void {
    if (!this.batchIds.has(id) || this.batchSettled.has(id)) return;
    this.batchSettled.add(id);
    const progress = this.progressObject;
    progress.loadedCount += 1;
    if (failed) this.batchFailed = true;
    if (progress.loadedCount >= progress.totalCount) {
      progress.state = this.batchFailed ? "failed" : "ready";
      progress.currentId = null;
    } else {
      progress.state = "loading";
    }
    this.emitProgress();
  }

  private failBatch(): void {
    this.batchFailed = true;
    const progress = this.progressObject;
    progress.state = "failed";
    progress.currentId = null;
    this.emitProgress();
  }

  private emitProgress(): void {
    if (this.progressListeners.size === 0) return;
    for (const listener of this.progressListeners) {
      try {
        listener(this.progressObject);
      } catch {
        // A UI listener must never break loading or another listener.
      }
    }
  }

  private groupResult(handles: readonly AssetHandle[]): GameAssetGroupResult {
    const failures: AssetFailure[] = [];
    for (const handle of handles) {
      if (handle.state === "failed" && handle.failed !== null) {
        failures.push(handle.failed);
      }
    }
    const progress = this.progressObject;
    return {
      handles,
      failures,
      loadedBytes: progress.fetched,
      declaredBytes: progress.declared,
    };
  }

  // -------------------------------------------------------------------
  // Validation and helpers
  // -------------------------------------------------------------------

  private assertBudgets(): void {
    let eagerBytes = 0;
    let totalBytes = 0;
    for (const record of this.records.values()) {
      const declaration = record.declaration;
      totalBytes += declaration.bytes;
      if (this.groupModes.get(declaration.group) === "eager") {
        eagerBytes += declaration.bytes;
      }
    }
    if (eagerBytes > this.bootCapBytes) {
      throw new GameAssetError(
        "E_ASSET_BUDGET",
        `Eager assets total ${eagerBytes} bytes, over the ${this.bootCapBytes} byte boot cap.`,
      );
    }
    if (eagerBytes > this.budget.initialBytes) {
      throw new GameAssetError(
        "E_ASSET_BUDGET",
        `Eager assets total ${eagerBytes} bytes, over initialBytes ${this.budget.initialBytes}.`,
      );
    }
    if (totalBytes > this.budget.totalBytes) {
      throw new GameAssetError(
        "E_ASSET_BUDGET",
        `Assets total ${totalBytes} bytes, over totalBytes ${this.budget.totalBytes}.`,
      );
    }
  }

  private assetIdsInEagerGroups(): readonly string[] {
    const ids: string[] = [];
    for (const declaration of this.manifest.assets) {
      if (this.groupModes.get(declaration.group) === "eager") {
        ids.push(declaration.id);
      }
    }
    return ids;
  }

  private resolveUrl(path: string): string {
    let base: URL;
    let resolved: URL;
    try {
      base = new URL(this.baseUrl);
      resolved = new URL(path, base);
    } catch {
      throw new GameAssetError(
        "E_ASSET_PATH",
        `Asset path "${path}" is not a valid relative URL.`,
      );
    }
    if (
      resolved.origin !== base.origin ||
      !resolved.pathname.startsWith(base.pathname)
    ) {
      throw new GameAssetError(
        "E_ASSET_PATH",
        `Asset path "${path}" resolves outside the game folder.`,
      );
    }
    return resolved.href;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new GameAssetError(
        "E_ASSET_DISPOSED",
        "The game asset library has been disposed.",
      );
    }
  }
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new GameAssetError(
      "E_ASSET_PATH",
      `Asset base URL "${raw}" is not absolute.`,
    );
  }
  if (!url.pathname.endsWith("/")) {
    throw new GameAssetError(
      "E_ASSET_PATH",
      `Asset base URL "${raw}" must be a directory URL ending in "/".`,
    );
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

function toFailure(id: string, error: unknown): AssetFailure {
  if (error instanceof GameAssetError) {
    return {
      id,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    id,
    code: "E_ASSET_DECODE",
    message: messageOf(error),
    retryable: false,
  };
}

/**
 * `AssetLibrary` implementation (06 §3, §5.2–§5.9).
 *
 * One record per manifest id. Concurrent loads share one fetch and one decode;
 * every caller owns one reference to the same handle. Budget reservations
 * happen before a fetch or decode and are all-or-nothing. Progress is a stable
 * object mutated in place and coalesced to at most ~60 events per second.
 */

import type {
  AssetCapability,
  AssetContainer,
  AssetFailure,
  AssetGroupResult,
  AssetHandle,
  AssetLibrary,
  AssetLibraryOptions,
  AssetLoadOptions,
  AssetManifest,
  AssetManifestEntry,
  AssetProgress,
  AssetReloadEvent,
  FontAssetData,
  TextureData,
  WorkerLike,
} from "./contracts/assets.js";
import { AssetBudgetLedger, MetadataLedger } from "./budget.js";
import {
  decodeAsset,
  decodedBytesOf,
  isMetadataKind,
  type DecodeOutcome,
} from "./codec/dispatch.js";
import { readImageDimensions } from "./codec/image.js";
import { planKtx2 } from "./codec/ktx2.js";
import { readMaterialTextureReferences } from "./codec/material.js";
import { shouldStreamAudio, streamAudio } from "./codec/audio.js";
import { AssetEngineError, assetError, toAssetFailure } from "./errors.js";
import { fetchAssetBytes, fetchManifestText } from "./fetch.js";
import {
  createBorrowedHandle,
  createHandle,
  createRecord,
  markDisposed,
  markFailed,
  markLoading,
  markReady,
  type AssetRecord,
  type HandleOwner,
} from "./handle.js";
import { verifyFnv1a32 } from "./hash.js";
import { containerForUrl, validateAssetManifest } from "./manifest.js";
import {
  manifestBaseUrl,
  normalizeBaseUrl,
  resolveAssetUrl,
  resolveManifestUrl,
} from "./url.js";
import { selectVariant, type SelectedAssetSource } from "./variants.js";
import {
  createModuleWorkerFactory,
  DecodePool,
  type DecodePriority,
} from "./worker/pool.js";
import {
  decodeResultError,
  decodeResultFromOutcome,
  type DecodeWorkerRequest,
  type DecodeWorkerResponse,
} from "./worker/protocol.js";

const DEFAULT_TEXTURE_BUDGET_BYTES = 134_217_728;
const DEFAULT_DECODED_BUDGET_BYTES = 100_663_296;
const DEFAULT_MAX_TOTAL_BYTES = 268_435_456;
const DEFAULT_MAX_CONCURRENT_FETCHES = 6;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const GPU_ALIGNMENT = 256;
const PROGRESS_FRAME_MS = 16;

interface MutableProgress {
  fetched: number;
  declared: number;
  determinate: boolean;
  state: AssetProgress["state"];
  loadedCount: number;
  totalCount: number;
  currentId: string | null;
}

interface EntryState {
  readonly entry: AssetManifestEntry;
  record: AssetRecord;
  pending: PendingLoad | null;
  /** Source bytes of a live json/material value. */
  metadataBytes: number;
}

interface PendingLoad {
  readonly id: string;
  promise: Promise<AssetHandle<unknown>>;
  readonly controller: AbortController;
  waiters: number;
  settled: boolean;
  aborted: boolean;
}

interface FetchWaiter {
  grant(): void;
}

/** Limits concurrent fetches; boot loads bypass the queue (06 §5.3). */
class FetchLimiter {
  private active = 0;
  private readonly queue: FetchWaiter[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : DEFAULT_MAX_CONCURRENT_FETCHES;
  }

  acquire(boot: boolean, id: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(
        assetError("E_ASSET_ABORTED", `${id}: load aborted`, id),
      );
    }
    if (boot || this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let waiting = true;
      const onAbort = (): void => {
        if (!waiting) return;
        waiting = false;
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(assetError("E_ASSET_ABORTED", `${id}: load aborted`, id));
      };
      const waiter: FetchWaiter = {
        grant: () => {
          if (!waiting) return;
          waiting = false;
          signal.removeEventListener("abort", onAbort);
          this.active += 1;
          resolve();
        },
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next !== undefined) next.grant();
  }
}

function align256(value: number): number {
  return Math.ceil(value / GPU_ALIGNMENT) * GPU_ALIGNMENT;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function defaultWorkerCount(): number {
  const navigatorLike = (
    globalThis as { navigator?: { hardwareConcurrency?: number } }
  ).navigator;
  const hardware = navigatorLike?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, hardware - 1));
}

class AssetLibraryImpl implements AssetLibrary, HandleOwner {
  private readonly options: AssetLibraryOptions;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly quality: "low" | "medium" | "high";
  private readonly capabilities: ReadonlySet<AssetCapability>;
  private readonly fetchTimeoutMs: number;
  private readonly verifyHashes: boolean;
  private readonly now: () => number;
  private readonly ledger: AssetBudgetLedger;
  private readonly metadataLedger = new MetadataLedger();
  private readonly limiter: FetchLimiter;
  private readonly pool: DecodePool;
  private readonly entries = new Map<string, EntryState>();

  private readonly progressObject: MutableProgress = {
    fetched: 0,
    declared: 0,
    determinate: false,
    state: "idle",
    loadedCount: 0,
    totalCount: 0,
    currentId: null,
  };
  private readonly batchDeclared = new Map<string, number>();
  private readonly batchSettled = new Set<string>();
  private batchFailed = false;
  private progressScheduled = false;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressAt = Number.NEGATIVE_INFINITY;

  private readonly progressListeners = new Set<(progress: AssetProgress) => void>();
  private readonly reloadListeners = new Set<(event: AssetReloadEvent) => void>();
  private readonly failureListeners = new Set<(failure: AssetFailure) => void>();

  private manifestDoc: AssetManifest | null = null;
  private disposed = false;
  private lifecycleEpoch = 0;

  constructor(options: AssetLibraryOptions) {
    this.options = options;
    this.fetchImpl =
      options.fetch ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        globalThis.fetch(input, init));
    this.baseUrl = this.resolveBaseUrl(options);
    this.quality = options.quality ?? "high";
    this.capabilities = options.capabilities ?? new Set<AssetCapability>();
    this.fetchTimeoutMs = positiveOr(
      options.fetchTimeoutMs,
      DEFAULT_FETCH_TIMEOUT_MS,
    );
    this.verifyHashes = options.verifyHashes ?? false;
    this.now = options.now ?? (() => Date.now());
    this.ledger = new AssetBudgetLedger(
      options.decodedBudgetBytes ?? DEFAULT_DECODED_BUDGET_BYTES,
      options.textureBudgetBytes ?? DEFAULT_TEXTURE_BUDGET_BYTES,
    );
    this.limiter = new FetchLimiter(
      options.maxConcurrentFetches ?? DEFAULT_MAX_CONCURRENT_FETCHES,
    );

    const workerFactory: (() => WorkerLike) | undefined =
      options.workerFactory ?? createModuleWorkerFactory();
    this.pool = new DecodePool({
      maxWorkers: options.maxDecodeWorkers ?? defaultWorkerCount(),
      ...(workerFactory !== undefined ? { workerFactory } : {}),
      timeoutMs: this.fetchTimeoutMs,
      fallback: (request) => this.mainThreadDecode(request),
      now: this.now,
    });
  }

  /** Fetches and validates the manifest; called by `createAssetLibrary`. */
  async initialize(): Promise<void> {
    const manifestUrl = resolveManifestUrl(this.options.manifestUrl);
    const text = await fetchManifestText({
      url: manifestUrl,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.fetchTimeoutMs,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw assetError("E_ASSET_FORMAT", "asset manifest is not valid JSON");
    }
    const validation = validateAssetManifest(parsed, {
      gameId: this.options.gameId,
      maxTotalBytes:
        this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      baseUrl: this.baseUrl,
    });
    if (!validation.ok || validation.manifest === null) {
      const issue = validation.issues[0];
      throw assetError(
        issue?.code ?? "E_ASSET_FORMAT",
        issue === undefined
          ? "asset manifest is invalid"
          : `asset manifest ${issue.path}: ${issue.message}`,
      );
    }
    this.manifestDoc = validation.manifest;
    for (const entry of validation.manifest.assets) {
      this.entries.set(entry.id, {
        entry,
        record: createRecord(entry.id, entry.kind, entry.initial === true),
        pending: null,
        metadataBytes: 0,
      });
    }
  }

  private resolveBaseUrl(options: AssetLibraryOptions): string {
    try {
      return normalizeBaseUrl(
        options.baseUrl ?? manifestBaseUrl(options.manifestUrl),
      );
    } catch (error) {
      if (error instanceof AssetEngineError) throw error;
      throw assetError("E_ASSET_FORMAT", "asset base url is invalid");
    }
  }

  // -------------------------------------------------------------------
  // HandleOwner
  // -------------------------------------------------------------------

  touch(record: AssetRecord): void {
    record.lastUsed = this.now();
  }

  onRefcountZero(record: AssetRecord): void {
    if (record.state !== "failed") return;
    const state = this.entries.get(record.id);
    if (state === undefined || state.record !== record) return;
    markDisposed(record);
    state.record = createRecord(record.id, record.kind, record.pinned);
    state.metadataBytes = 0;
  }

  // -------------------------------------------------------------------
  // Library surface
  // -------------------------------------------------------------------

  get manifest(): AssetManifest {
    if (this.manifestDoc === null) {
      throw assetError("E_ASSET_FORMAT", "asset library is not initialized");
    }
    return this.manifestDoc;
  }

  get loadedBytes(): number {
    return this.ledger.decodedBytes;
  }

  get budgetBytes(): number {
    return this.ledger.decodedBudgetBytes;
  }

  get textureBytes(): number {
    return this.ledger.textureBytes;
  }

  get textureBudgetBytes(): number {
    return this.ledger.textureBudgetBytes;
  }

  get metadataBytes(): number {
    return this.metadataLedger.bytes;
  }

  get inFlight(): number {
    let count = 0;
    for (const state of this.entries.values()) {
      if (state.pending !== null) count += 1;
    }
    return count;
  }

  get failures(): readonly AssetFailure[] {
    const failures: AssetFailure[] = [];
    for (const state of this.entries.values()) {
      if (state.record.state === "failed" && state.record.failed !== null) {
        failures.push(state.record.failed);
      }
    }
    return failures;
  }

  get degraded(): boolean {
    return this.pool.degraded;
  }

  /** Stable object: mutated in place, never replaced (06 §5.9). */
  get progress(): AssetProgress {
    return this.progressObject;
  }

  async load<T>(
    id: string,
    options?: AssetLoadOptions,
  ): Promise<AssetHandle<T>> {
    if (this.progressObject.state !== "loading") this.beginBatch();
    return this.loadInternal<T>(id, options);
  }

  get<T>(id: string): AssetHandle<T> | undefined {
    const state = this.entries.get(id);
    if (state === undefined || state.record.state !== "ready") {
      return undefined;
    }
    return createBorrowedHandle<T>(state.record, this);
  }

  async loadGroup(
    group: string,
    options?: AssetLoadOptions,
  ): Promise<AssetGroupResult> {
    this.beginBatch();
    const selected: AssetManifestEntry[] = [];
    for (const state of this.entries.values()) {
      if (state.entry.group === group) selected.push(state.entry);
    }
    return this.loadSelected(selected, options);
  }

  async loadInitial(options?: AssetLoadOptions): Promise<AssetGroupResult> {
    this.beginBatch();
    const selected: AssetManifestEntry[] = [];
    for (const state of this.entries.values()) {
      if (state.entry.initial === true) selected.push(state.entry);
    }
    return this.loadSelected(selected, {
      priority: "boot",
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(options?.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    });
  }

  onProgress(listener: (progress: AssetProgress) => void): () => void {
    this.progressListeners.add(listener);
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  onReload(listener: (event: AssetReloadEvent) => void): () => void {
    this.reloadListeners.add(listener);
    return () => {
      this.reloadListeners.delete(listener);
    };
  }

  onFailure(listener: (failure: AssetFailure) => void): () => void {
    this.failureListeners.add(listener);
    return () => {
      this.failureListeners.delete(listener);
    };
  }

  trim(maxBytes: number = this.budgetBytes): number {
    const target =
      Number.isFinite(maxBytes) && maxBytes >= 0
        ? maxBytes
        : this.budgetBytes;
    const candidates: EntryState[] = [];
    for (const state of this.entries.values()) {
      if (state.record.state === "ready" && state.record.refcount === 0) {
        candidates.push(state);
      }
    }
    candidates.sort((left, right) => {
      const pinRank = Number(left.record.pinned) - Number(right.record.pinned);
      if (pinRank !== 0) return pinRank;
      return left.record.lastUsed - right.record.lastUsed;
    });

    let freed = 0;
    for (const state of candidates) {
      if (this.ledger.decodedBytes + this.ledger.textureBytes <= target) {
        break;
      }
      freed += this.evict(state);
    }
    return freed;
  }

  resetProgress(): void {
    this.beginBatch();
    this.emitProgress();
  }

  releaseAll(): void {
    this.lifecycleEpoch += 1;
    for (const state of this.entries.values()) {
      if (state.pending !== null) {
        state.pending.aborted = true;
        state.pending.controller.abort();
        state.pending = null;
      }
      markDisposed(state.record);
      state.metadataBytes = 0;
    }
    this.ledger.reset();
    this.metadataLedger.reset();
    this.beginBatch();
    this.emitProgress();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifecycleEpoch += 1;
    if (this.progressTimer !== null) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    this.progressScheduled = false;
    for (const state of this.entries.values()) {
      if (state.pending !== null) {
        state.pending.aborted = true;
        state.pending.controller.abort();
        state.pending = null;
      }
      markDisposed(state.record);
      state.metadataBytes = 0;
    }
    this.ledger.reset();
    this.metadataLedger.reset();
    try {
      this.pool.dispose();
    } catch {
      // dispose() never throws by contract.
    }
    this.progressListeners.clear();
    this.reloadListeners.clear();
    this.failureListeners.clear();
    this.beginBatch();
  }

  // -------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------

  private beginBatch(): void {
    this.batchDeclared.clear();
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
  }

  private joinBatch(id: string): void {
    if (this.batchDeclared.has(id)) return;
    const state = this.entries.get(id);
    if (state === undefined) return;
    this.batchDeclared.set(id, this.declaredBytesFor(state.entry));
    const progress = this.progressObject;
    if (progress.state !== "loading") progress.state = "loading";
    progress.currentId = id;
    this.recomputeProgress();
    this.emitProgress();
  }

  private completeBatchItem(id: string, failed: boolean): void {
    if (!this.batchDeclared.has(id) || this.batchSettled.has(id)) return;
    this.batchSettled.add(id);
    const progress = this.progressObject;
    progress.loadedCount += 1;
    if (failed) this.batchFailed = true;
    if (progress.loadedCount >= this.batchDeclared.size) {
      progress.state = this.batchFailed ? "failed" : "ready";
    }
    this.emitProgress();
  }

  private recomputeProgress(): void {
    let declared = 0;
    let uncounted = false;
    for (const bytes of this.batchDeclared.values()) {
      declared += bytes;
      if (bytes <= 0) uncounted = true;
    }
    const progress = this.progressObject;
    progress.declared = declared;
    progress.totalCount = this.batchDeclared.size;
    progress.determinate = this.batchDeclared.size > 0 && !uncounted;
  }

  private declaredBytesFor(entry: AssetManifestEntry): number {
    try {
      if (
        entry.kind === "audio" &&
        shouldStreamAudio(entry.bytes, entry.durationSeconds, entry.streaming)
      ) {
        return 0;
      }
      return selectVariant(entry, this.capabilities, this.quality).bytes;
    } catch {
      return entry.bytes;
    }
  }

  private recordFetched(count: number, id: string): void {
    const progress = this.progressObject;
    progress.fetched += count;
    progress.currentId = id;
    this.emitProgress();
  }

  private emitProgress(): void {
    if (this.disposed || this.progressScheduled) return;
    if (this.progressListeners.size === 0) return;
    this.progressScheduled = true;
    const delay = PROGRESS_FRAME_MS - (this.now() - this.lastProgressAt);
    if (delay <= 0) {
      queueMicrotask(() => this.flushProgress());
    } else {
      this.progressTimer = setTimeout(() => this.flushProgress(), delay);
    }
  }

  private flushProgress(): void {
    this.progressScheduled = false;
    this.progressTimer = null;
    if (this.disposed) return;
    this.lastProgressAt = this.now();
    const snapshot = this.progressObject;
    for (const listener of this.progressListeners) {
      try {
        listener(snapshot);
      } catch {
        // A listener must never break loading or another listener.
      }
    }
  }

  private notifyFailure(failure: AssetFailure): void {
    for (const listener of this.failureListeners) {
      try {
        listener(failure);
      } catch {
        // Listener failures are isolated.
      }
    }
  }

  // -------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------

  private async loadInternal<T>(
    id: string,
    options?: AssetLoadOptions,
  ): Promise<AssetHandle<T>> {
    const state = this.entries.get(id);
    if (state === undefined) {
      throw assetError(
        "E_ASSET_UNKNOWN",
        "asset id is not present in the manifest",
      );
    }
    if (this.disposed) {
      throw assetError("E_ASSET_ABORTED", `${id}: library is disposed`, id);
    }
    if (options?.signal?.aborted === true) {
      throw assetError("E_ASSET_ABORTED", `${id}: load aborted`, id);
    }

    this.joinBatch(id);

    if (state.pending !== null) {
      return this.awaitPending<T>(state.pending, options?.signal);
    }

    let record = state.record;
    if (
      record.state === "disposed" ||
      (record.state === "failed" && record.refcount === 0)
    ) {
      record = createRecord(record.id, record.kind, record.pinned);
      state.record = record;
    }
    if (record.state === "ready") {
      this.touch(record);
      this.completeBatchItem(id, false);
      return createHandle<T>(record, this, 1);
    }
    if (record.state === "failed") {
      this.completeBatchItem(id, true);
      return createHandle<T>(record, this, 1);
    }

    const pending: PendingLoad = {
      id,
      promise: Promise.resolve(createHandle<unknown>(record, this, 0)),
      controller: new AbortController(),
      waiters: 0,
      settled: false,
      aborted: false,
    };
    state.pending = pending;
    const priority: DecodePriority = options?.priority ?? "background";
    const timeoutMs = positiveOr(options?.timeoutMs, this.fetchTimeoutMs);
    pending.promise = this.runLoad(state, pending, priority, timeoutMs).then(
      (handle) => {
        pending.settled = true;
        if (state.pending === pending) state.pending = null;
        if (pending.aborted && pending.waiters === 0) {
          this.evict(state);
          markDisposed(state.record);
        }
        return handle;
      },
      (error: unknown) => {
        pending.settled = true;
        if (state.pending === pending) state.pending = null;
        throw error;
      },
    );
    return this.awaitPending<T>(pending, options?.signal);
  }

  private awaitPending<T>(
    pending: PendingLoad,
    signal: AbortSignal | undefined,
  ): Promise<AssetHandle<T>> {
    pending.waiters += 1;
    return new Promise<AssetHandle<T>>((resolve, reject) => {
      let done = false;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        pending.waiters -= 1;
        if (pending.waiters === 0) {
          pending.aborted = true;
          if (!pending.settled) pending.controller.abort();
        }
        reject(
          assetError("E_ASSET_ABORTED", `${pending.id}: load aborted`, pending.id),
        );
      };
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      pending.promise.then(
        (handle) => {
          if (done) return;
          done = true;
          signal?.removeEventListener("abort", onAbort);
          pending.waiters -= 1;
          try {
            handle.retain();
          } catch (error) {
            reject(error);
            return;
          }
          resolve(handle as unknown as AssetHandle<T>);
        },
        (error: unknown) => {
          if (done) return;
          done = true;
          signal?.removeEventListener("abort", onAbort);
          pending.waiters -= 1;
          reject(error);
        },
      );
    });
  }

  private async loadDependency(
    id: string,
    priority: DecodePriority,
    handles: AssetHandle<unknown>[],
    signal: AbortSignal,
  ): Promise<void> {
    const handle = await this.loadInternal(id, { priority, signal });
    handles.push(handle);
    if (handle.failed !== null) {
      throw assetError(handle.failed.code, handle.failed.message, id);
    }
  }

  private async runLoad(
    state: EntryState,
    pending: PendingLoad,
    priority: DecodePriority,
    timeoutMs: number,
  ): Promise<AssetHandle<unknown>> {
    const entry = state.entry;
    const record = state.record;
    const id = entry.id;
    const epoch = this.lifecycleEpoch;
    markLoading(record);
    this.progressObject.currentId = id;
    this.emitProgress();

    const dependencyHandles: AssetHandle<unknown>[] = [];
    let reservedDecoded = 0;
    let reservedTexture = 0;
    let metadataAdded = 0;

    const releaseReservations = (): void => {
      if (reservedDecoded > 0 || reservedTexture > 0) {
        this.ledger.release({
          id,
          decodedBytes: reservedDecoded,
          textureGpuBytes: reservedTexture,
        });
      }
      reservedDecoded = 0;
      reservedTexture = 0;
    };
    const adjustReservation = (
      decodedBytes: number,
      textureGpuBytes: number,
    ): void => {
      if (
        reservedDecoded === decodedBytes &&
        reservedTexture === textureGpuBytes
      ) {
        return;
      }
      releaseReservations();
      this.ledger.reserve({ id, decodedBytes, textureGpuBytes });
      reservedDecoded = decodedBytes;
      reservedTexture = textureGpuBytes;
    };

    try {
      const selected = selectVariant(
        entry,
        this.capabilities,
        this.quality,
      );
      const url = resolveAssetUrl(selected.url, this.baseUrl);

      if (
        entry.kind === "audio" &&
        shouldStreamAudio(
          selected.bytes,
          entry.durationSeconds,
          entry.streaming,
        )
      ) {
        const value = streamAudio({
          id,
          url,
          ...(selected.container !== undefined
            ? { container: selected.container }
            : {}),
          ...(selected.mimeType !== undefined
            ? { mimeType: selected.mimeType }
            : {}),
          ...(entry.durationSeconds !== undefined
            ? { durationSeconds: entry.durationSeconds }
            : {}),
        });
        if (
          pending.controller.signal.aborted ||
          epoch !== this.lifecycleEpoch
        ) {
          throw assetError("E_ASSET_ABORTED", `${id}: load aborted`, id);
        }
        markReady(record, value, 0, 0, this.now());
        this.completeBatchItem(id, false);
        return createHandle(record, this, 0);
      }

      for (const dependencyId of entry.dependencies ?? []) {
        await this.loadDependency(
          dependencyId,
          priority,
          dependencyHandles,
          pending.controller.signal,
        );
      }

      if (!isMetadataKind(entry.kind)) {
        this.ledger.reserve({
          id,
          decodedBytes: selected.bytes,
          textureGpuBytes: 0,
        });
        reservedDecoded = selected.bytes;
      }

      await this.limiter.acquire(
        priority === "boot",
        id,
        pending.controller.signal,
      );
      let bytes: ArrayBuffer;
      try {
        bytes = await fetchAssetBytes({
          id,
          url,
          bytes: selected.bytes,
          fetchImpl: this.fetchImpl,
          signal: pending.controller.signal,
          timeoutMs,
          kind: entry.kind,
          onBytes: (count) => {
            this.recordFetched(count, id);
          },
          ...(selected.container !== undefined
            ? { container: selected.container }
            : {}),
        });
      } finally {
        this.limiter.release();
      }
      const sourceByteLength = bytes.byteLength;

      if (this.verifyHashes && selected.hash !== undefined) {
        if (!verifyFnv1a32(bytes, selected.hash)) {
          throw assetError(
            "E_ASSET_HASH",
            `${id}: content hash does not match the manifest`,
            id,
          );
        }
      }

      if (entry.kind === "texture") {
        const container = selected.container ?? containerForUrl(url);
        const plan = this.planTexture(id, container, bytes);
        adjustReservation(plan.decodedBytes, plan.gpuBytes);
      }

      if (entry.kind === "material") {
        const references = readMaterialTextureReferences(id, bytes);
        const loaded = new Set<string>(entry.dependencies ?? []);
        for (const reference of references) {
          if (loaded.has(reference)) continue;
          loaded.add(reference);
          await this.loadDependency(
            reference,
            priority,
            dependencyHandles,
            pending.controller.signal,
          );
        }
      }

      const outcome = await this.decode(
        entry,
        selected,
        url,
        bytes,
        priority,
      );

      if (
        pending.controller.signal.aborted ||
        epoch !== this.lifecycleEpoch
      ) {
        throw assetError("E_ASSET_ABORTED", `${id}: load aborted`, id);
      }

      let actualDecoded = decodedBytesOf(entry.kind, outcome.value);
      if (
        entry.kind === "font" &&
        (outcome.value as FontAssetData).kind === "atlas"
      ) {
        actualDecoded = sourceByteLength;
      }
      const actualTexture =
        entry.kind === "texture"
          ? (outcome.value as TextureData).gpuBytes
          : 0;
      adjustReservation(actualDecoded, actualTexture);

      if (entry.kind === "json" || entry.kind === "material") {
        state.metadataBytes = sourceByteLength;
        this.metadataLedger.add(sourceByteLength);
        metadataAdded = sourceByteLength;
      }

      markReady(
        record,
        outcome.value,
        actualDecoded,
        actualTexture,
        this.now(),
      );
      this.completeBatchItem(id, false);
      return createHandle(record, this, 0);
    } catch (error) {
      releaseReservations();
      if (metadataAdded > 0) {
        this.metadataLedger.remove(metadataAdded);
        state.metadataBytes = 0;
      }
      if (
        pending.controller.signal.aborted ||
        epoch !== this.lifecycleEpoch
      ) {
        markDisposed(record);
        this.completeBatchItem(id, true);
        throw assetError("E_ASSET_ABORTED", `${id}: load aborted`, id);
      }
      const failure = toAssetFailure(id, error);
      markFailed(record, failure);
      this.completeBatchItem(id, true);
      this.notifyFailure(failure);
      return createHandle(record, this, 0);
    } finally {
      for (const handle of dependencyHandles) handle.release();
      dependencyHandles.length = 0;
    }
  }

  private planTexture(
    id: string,
    container: AssetContainer | undefined,
    bytes: ArrayBuffer,
  ): { readonly decodedBytes: number; readonly gpuBytes: number } {
    if (container === "ktx2") {
      const plan = planKtx2(id, bytes, this.capabilities);
      return { decodedBytes: plan.decodedBytes, gpuBytes: plan.gpuBytes };
    }
    if (container === "webp" || container === "png") {
      const dimensions = readImageDimensions(id, container, bytes);
      const decoded = dimensions.width * dimensions.height * 4;
      return { decodedBytes: decoded, gpuBytes: align256(decoded) };
    }
    throw assetError(
      "E_ASSET_FORMAT",
      `${id}: texture has no supported container`,
      id,
    );
  }

  private async decode(
    entry: AssetManifestEntry,
    selected: SelectedAssetSource,
    url: string,
    bytes: ArrayBuffer,
    priority: DecodePriority,
  ): Promise<DecodeOutcome> {
    if (entry.kind === "material" || entry.kind === "json") {
      return decodeAsset({
        id: entry.id,
        kind: entry.kind,
        url,
        bytes,
        lookupKind: (assetId) => this.entries.get(assetId)?.entry.kind,
      });
    }

    const request: Omit<DecodeWorkerRequest, "jobId"> = {
      id: entry.id,
      kind: entry.kind,
      url,
      bytes,
      ...(selected.container !== undefined
        ? { container: selected.container }
        : {}),
      ...(selected.mimeType !== undefined
        ? { mimeType: selected.mimeType }
        : {}),
      ...(selected.format !== undefined ? { format: selected.format } : {}),
      capabilities: [...this.capabilities],
    };
    const result = await this.pool.decode(request, priority);
    if (!result.ok || result.value === undefined) {
      throw decodeResultError(result, entry.id);
    }
    // Duration is manifest metadata, not decoded from the audio container.
    if (entry.kind === "audio" && entry.durationSeconds !== undefined) {
      const value = result.value as { durationSeconds?: number };
      if (value.durationSeconds === undefined) {
        value.durationSeconds = entry.durationSeconds;
      }
    }
    return { value: result.value };
  }

  private async mainThreadDecode(
    request: DecodeWorkerRequest,
  ): Promise<DecodeWorkerResponse> {
    const outcome = await decodeAsset({
      id: request.id,
      kind: request.kind,
      url: request.url,
      bytes: request.bytes,
      ...(request.container !== undefined
        ? { container: request.container }
        : {}),
      ...(request.mimeType !== undefined ? { mimeType: request.mimeType } : {}),
      ...(request.format !== undefined ? { format: request.format } : {}),
      ...(request.capabilities !== undefined
        ? { capabilities: new Set(request.capabilities) }
        : {}),
      lookupKind: (assetId) => this.entries.get(assetId)?.entry.kind,
    });
    return decodeResultFromOutcome(request.jobId, outcome);
  }

  // -------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------

  private async loadSelected(
    selected: readonly AssetManifestEntry[],
    options?: AssetLoadOptions,
  ): Promise<AssetGroupResult> {
    const memo = new Map<string, Promise<AssetHandle<unknown>>>();
    const selectedIds = new Set<string>();
    for (const entry of selected) selectedIds.add(entry.id);
    const priority: DecodePriority = options?.priority ?? "background";
    const signal = options?.signal;
    const timeoutMs = options?.timeoutMs;

    const ensure = (id: string): Promise<AssetHandle<unknown>> => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      const promise = (async () => {
        const state = this.entries.get(id);
        if (state === undefined) {
          throw assetError(
            "E_ASSET_UNKNOWN",
            "asset id is not present in the manifest",
          );
        }
        const dependencies = state.entry.dependencies ?? [];
        if (dependencies.length > 0) {
          // Dependencies load first; a dependency failure is reported on the
          // dependent member by that member's own load, not by rejecting here.
          await Promise.allSettled(
            dependencies.map((dependency) => ensure(dependency)),
          );
        }
        return this.loadInternal(id, {
          priority,
          ...(signal !== undefined ? { signal } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
      })();
      memo.set(id, promise);
      return promise;
    };

    const handles: AssetHandle<unknown>[] = [];
    const failures: AssetFailure[] = [];
    const settled = await Promise.allSettled(
      selected.map((entry) => ensure(entry.id)),
    );
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      const entry = selected[index];
      if (result === undefined || entry === undefined) continue;
      if (result.status === "fulfilled") {
        handles.push(result.value);
        if (result.value.failed !== null) {
          failures.push(result.value.failed);
        }
      } else {
        failures.push(toAssetFailure(entry.id, result.reason));
      }
    }

    for (const [id, promise] of memo) {
      if (selectedIds.has(id)) continue;
      void promise
        .then((handle) => {
          handle.release();
        })
        .catch(() => {
          // A dependency failure is already surfaced through its dependents.
        });
    }

    return { handles, failures };
  }

  private evict(state: EntryState): number {
    const record = state.record;
    if (record.state !== "ready") return 0;
    const freed = record.bytes + record.textureGpuBytes;
    this.ledger.release({
      id: record.id,
      decodedBytes: record.bytes,
      textureGpuBytes: record.textureGpuBytes,
    });
    if (state.metadataBytes > 0) {
      this.metadataLedger.remove(state.metadataBytes);
      state.metadataBytes = 0;
    }
    markDisposed(record);
    return freed;
  }
}

/**
 * Fetches and validates the manifest, then builds the library (06 §3.4).
 * No asset fetch and no worker exists until the first `load`.
 */
export async function createAssetLibrary(
  options: AssetLibraryOptions,
): Promise<AssetLibrary> {
  const library = new AssetLibraryImpl(options);
  await library.initialize();
  return library;
}

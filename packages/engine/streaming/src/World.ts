/**
 * `WorldStreamer` facade, tick orchestration and event emitter
 * (spec 12 §3.3, §5.1, `src/World.ts`).
 *
 * The streamer owns handles, bytes and lifecycle callbacks; it never owns game
 * objects, never parses GLB/KTX2 itself (section parsers are injected through
 * `buildPayload`), and never touches the DOM, `fetch` or a worker. Browser I/O
 * arrives through `CellSource`, delivery through `StreamSink`.
 *
 * Tick order (12 §5.5): re-plan on cadence or focus movement, cancel loads and
 * evict cells beyond the unload distance, apply pressure evictions, apply
 * decoded payloads in ascending `(cx, cy)` at the tick boundary (deactivate
 * before activate), then start new loads within the per-tick and concurrency
 * caps. Deferred applies stay `ready` and are retried next tick.
 *
 * Interpretation recorded for the owning wave: a LOD swap re-activates the
 * cell (`onCellDeactivate` then `onCellActivate`) because `StreamSink` has no
 * way to hand new render content through `onCellLodChange`. `onCellLodChange`
 * is therefore not called; the activate callback is authoritative.
 *
 * Decode completion happens off the tick, inside the fetch promise. It only
 * mutates the residency record and appends to the ready list; every sink call
 * happens inside `update`.
 */

import type {
  CellContent,
  CellKey,
  CellRenderPayload,
  CellSource,
  CellState,
  StreamDiagnostics,
  StreamEvent,
  StreamSink,
  StreamStats,
  StreamView,
  WorldCell,
  WorldConfig,
  WorldStreamer,
} from "./contracts/world.js";
import { STREAMING_DEFAULTS, STREAMING_LIMITS } from "./contracts/world.js";
import { CellGrid, compareCellKeys } from "./Grid.js";
import type { WorldIndex } from "./WorldIndex.js";
import { CellCacheStore } from "./Cache.js";
import type { DecodeCellContext, DecodedCell, GzipDecoder } from "./Decode.js";
import { decodeCell } from "./Decode.js";
import { clampLodBias, shouldUnload, type Lod } from "./Lod.js";
import {
  MemoryLedger,
  selectPressureEvictions,
  type EvictionCandidate,
  type PressureStage,
} from "./Memory.js";
import { PriorityPlanner, type PriorityCandidate } from "./Priority.js";
import {
  ResidencyTable,
  MAX_LOAD_ATTEMPTS,
  payloadId,
  publicCellState,
  type PayloadMeta,
  type PayloadRecord,
  type ResidencyState,
} from "./Residency.js";
import { StreamEventBus, errorCodeOf, streamingError } from "./StreamEvents.js";
import { StreamStatsRecorder, type EvictionReason } from "./Stats.js";
import { WorldStateStore } from "./StateStore.js";

/** Decoded payload content plus the bytes it will be billed for. */
export interface PayloadContent {
  readonly render: CellRenderPayload;
  readonly collisionBytes: ArrayBuffer | null;
  readonly navBytes: ArrayBuffer | null;
  readonly audioEmitters: readonly unknown[];
  readonly entities: readonly unknown[];
  readonly geometryBytes: number;
  readonly textureBytes: number;
  readonly cpuBytes: number;
}

/**
 * Section parser injection point. The default builder treats section bytes as
 * opaque: mesh bytes are geometry, texture bytes are texture, everything else
 * is CPU. Specs 06/07/09/11 replace it with real parsers.
 */
export type PayloadBuilder = (decoded: DecodedCell, meta: PayloadMeta) => PayloadContent;

export interface WorldStreamerOptions {
  /** Injected gzip decoder; the streamer never touches the DOM. */
  readonly decodeGzip: GzipDecoder;
  readonly buildPayload?: PayloadBuilder;
  /** Optional owner-parser dispatch, forwarded to `decodeCell`. */
  readonly onSection?: DecodeCellContext["onSection"];
  readonly simRadiusMeters?: number;
  readonly lodBias?: number;
  /** Debug clock for `streamerTickMsP95` and apply time slicing. */
  readonly now?: () => number;
}

/** Default section accounting; see `PayloadBuilder`. */
export function defaultPayloadBuilder(
  decoded: DecodedCell,
  meta: PayloadMeta,
): PayloadContent {
  let geometryBytes = 0;
  let textureBytes = 0;
  let cpuBytes = 0;
  let collisionBytes: ArrayBuffer | null = null;
  let navBytes: ArrayBuffer | null = null;
  for (const section of decoded.sections) {
    const bytes = section.bytes.byteLength;
    if (section.type === 1) {
      geometryBytes += bytes;
    } else if (section.type === 2) {
      textureBytes += bytes;
    } else {
      cpuBytes += bytes;
      if (meta.kind === "sim" && section.type === 3) {
        collisionBytes = toArrayBuffer(section.bytes);
      } else if (meta.kind === "sim" && section.type === 4) {
        navBytes = toArrayBuffer(section.bytes);
      }
    }
  }
  return {
    render: {
      meshHandles: [],
      instanceTransforms: new Float32Array(0),
      instanceMeshIndex: new Uint16Array(0),
      batchMaterialIds: [],
    },
    collisionBytes,
    navBytes,
    audioEmitters: [],
    entities: [],
    geometryBytes,
    textureBytes,
    cpuBytes,
  };
}

interface MutableWorldCell {
  readonly id: { readonly cx: number; readonly cy: number };
  readonly key: CellKey;
  lod: Lod;
  state: CellState;
  bytes: number;
}

interface ActivatedCell {
  readonly key: CellKey;
  readonly cx: number;
  readonly cy: number;
  lod: Lod;
  visual: PayloadRecord;
  sim: PayloadRecord | null;
  readonly view: MutableWorldCell;
}

interface ReadyPair {
  visual: PayloadRecord | null;
  sim: PayloadRecord | null;
}

/** Creates the streamer; the class itself is not part of the public surface. */
export function createWorldStreamer(
  index: WorldIndex,
  source: CellSource,
  sink: StreamSink,
  options: WorldStreamerOptions,
): WorldStreamer {
  return new Streamer(index, source, sink, options);
}

class Streamer implements WorldStreamer {
  readonly config: WorldConfig;
  readonly stateStore: WorldStateStore;

  private readonly index: WorldIndex;
  private readonly grid: CellGrid;
  private source: CellSource | null;
  private sink: StreamSink | null;
  private readonly options: WorldStreamerOptions;
  private readonly buildPayload: PayloadBuilder;
  private readonly planner: PriorityPlanner;
  private readonly residency: ResidencyTable;
  private readonly ledger: MemoryLedger;
  private readonly statsRecorder = new StreamStatsRecorder();
  private readonly events = new StreamEventBus();
  private readonly cache: CellCacheStore | null;

  private readonly activated = new Map<CellKey, ActivatedCell>();
  private readonly views = new Map<CellKey, MutableWorldCell>();
  private readonly pinned = new Set<CellKey>();
  private readonly contents = new Map<string, PayloadContent>();
  private readonly blocked = new Set<string>();
  private readonly ready: PayloadRecord[] = [];
  private readonly readyState = new Map<CellKey, ReadyPair>();
  private readonly residentSnapshot: WorldCell[] = [];
  private readonly desiredVisual = new Map<CellKey, Lod>();
  private readonly desiredSim = new Set<CellKey>();
  private readonly currentLods = new Map<CellKey, Lod>();
  private readonly readyKeys: CellKey[] = [];
  private readonly diagnosticsRecord: {
    budgetBreaches: number;
    simBudgetBreaches: number;
    pinBudgetBreaches: number;
    lastBudgetCode: string | null;
  } = {
    budgetBreaches: 0,
    simBudgetBreaches: 0,
    pinBudgetBreaches: 0,
    lastBudgetCode: null,
  };

  private planCache: readonly PriorityCandidate[] = [];
  private lastDecisionTick = Number.NEGATIVE_INFINITY;
  private lastTick = Number.NEGATIVE_INFINITY;
  private lastPressureStage: PressureStage = 0;
  private recoveryTicks = 0;
  private overBudgetTicks = 0;
  private simResidentBytes = 0;
  private needsReplan = true;
  private stopped = false;
  private disposed = false;
  private readonly prevFocusX: number[] = [];
  private readonly prevFocusZ: number[] = [];

  private readonly evictionCandidates: EvictionCandidate[] = [];
  private readonly evictionScratch: {
    key: CellKey;
    cx: number;
    cy: number;
    lod: Lod;
    distanceMeters: number;
    pinned: boolean;
    guarded: boolean;
    inSimRing: boolean;
  }[] = [];

  constructor(
    index: WorldIndex,
    source: CellSource,
    sink: StreamSink,
    options: WorldStreamerOptions,
  ) {
    if (typeof options.decodeGzip !== "function") {
      throw streamingError("E_STREAM_STATE", "decodeGzip must be supplied by the runtime");
    }
    this.index = index;
    this.config = index.config;
    this.grid = index.grid;
    this.source = source;
    this.sink = sink;
    this.options = options;
    this.buildPayload = options.buildPayload ?? defaultPayloadBuilder;
    this.planner = new PriorityPlanner(index, {
      simRadiusMeters: options.simRadiusMeters ?? STREAMING_DEFAULTS.simRadiusMeters,
      lodBias: options.lodBias ?? 0,
    });
    this.residency = new ResidencyTable({
      maxConcurrentLoads: this.config.budgets.maxConcurrentLoads,
      maxLoadsStartedPerTick: this.config.budgets.maxLoadsStartedPerTick,
    });
    this.ledger = new MemoryLedger(this.config.budgets.residentBytes);
    this.stateStore = new WorldStateStore(this.config);
    this.cache =
      source.cache !== undefined &&
      this.config.budgets.cacheEnabled &&
      this.config.budgets.cacheBytes > 0
        ? new CellCacheStore(source.cache, {
            worldId: this.config.worldId,
            budgetBytes: this.config.budgets.cacheBytes,
            enabled: true,
          })
        : null;
    if (this.cache !== null) {
      // Boot trim; CacheStorage failures are swallowed inside the store.
      void this.cache.trim();
    }
  }

  // ---------------------------------------------------------------- public

  update(tick: number, view: StreamView): void {
    if (this.disposed) {
      throw streamingError("E_STREAM_DISPOSED", "streamer has been disposed");
    }
    if (this.stopped) return;
    if (!Number.isFinite(tick) || tick < 0) {
      throw streamingError("E_STREAM_STATE", "tick must be finite and >= 0");
    }
    if (tick < this.lastTick) {
      throw streamingError(
        "E_STREAM_STATE",
        `tick ${tick} is older than the last update ${this.lastTick}`,
      );
    }
    this.lastTick = tick;
    this.residency.beginTick();
    const startedAt = this.options.now?.();

    if (this.shouldReplan(tick, view)) {
      this.replan(tick, view);
    }
    this.admitDemand(tick);
    this.evictOutOfRange(view);
    this.handlePressure(view);
    this.applyReady();
    this.startLoads(tick);
    if (tick > 0 && tick % 600 === 0 && this.cache !== null) {
      void this.cache.trim();
    }
    this.refreshViews();
    this.refreshStats();
    if (startedAt !== undefined && this.options.now !== undefined) {
      this.statsRecorder.recordTick(this.options.now() - startedAt);
    }
  }

  getCell(key: CellKey): WorldCell | undefined {
    return this.views.get(key);
  }

  cellAt(x: number, z: number): WorldCell | undefined {
    const coord = this.grid.cellAtWorld(x, z);
    if (coord === undefined) return undefined;
    return this.views.get(`${coord.cx},${coord.cy}` as CellKey);
  }

  get resident(): readonly WorldCell[] {
    return this.residentSnapshot;
  }

  pin(key: CellKey): boolean {
    if (this.disposed || !this.index.has(key)) return false;
    if (this.pinned.has(key)) return true;
    if (this.pinned.size >= STREAMING_LIMITS.maxPinnedCells) return false;
    this.pinned.add(key);
    return true;
  }

  unpin(key: CellKey): void {
    this.pinned.delete(key);
  }

  setLodBias(bias: number): void {
    if (this.disposed) {
      throw streamingError("E_STREAM_DISPOSED", "streamer has been disposed");
    }
    this.planner.setLodBias(clampLodBias(bias));
    this.needsReplan = true;
  }

  setSimRadius(meters: number): void {
    if (this.disposed) {
      throw streamingError("E_STREAM_DISPOSED", "streamer has been disposed");
    }
    this.planner.setSimRadius(meters);
    this.needsReplan = true;
  }

  get stats(): StreamStats {
    return this.statsRecorder.stats;
  }

  on(type: StreamEvent["type"], listener: (event: StreamEvent) => void): () => void {
    return this.events.on(type, listener);
  }

  stop(): void {
    if (this.stopped || this.disposed) return;
    this.stopped = true;
    const keys = [...this.activated.keys()].sort(compareCellKeys);
    for (const key of keys) {
      this.deactivate(key, "stop");
    }
    for (const record of this.residency.all()) {
      if (
        record.state === "queued" ||
        record.state === "loading" ||
        record.state === "decoding" ||
        record.state === "ready"
      ) {
        this.cancelRecord(record);
      }
    }
    this.residency.clear();
    this.contents.clear();
    this.ready.length = 0;
    this.views.clear();
    this.residentSnapshot.length = 0;
    this.ledger.reset();
    this.simResidentBytes = 0;
    // Publish the empty gauges: ER-12-07 reads the ledger through `stats`
    // after `stop()`, and `update` is a no-op once stopped.
    this.refreshStats();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.source = null;
    this.sink = null;
    this.events.clear();
    this.stateStore.dispose();
  }

  get diagnostics(): StreamDiagnostics {
    const debug = this.statsRecorder.debug;
    this.diagnosticsRecord.budgetBreaches = debug.budgetBreaches;
    this.diagnosticsRecord.simBudgetBreaches = debug.simBudgetBreaches;
    this.diagnosticsRecord.pinBudgetBreaches = debug.pinBudgetBreaches;
    this.diagnosticsRecord.lastBudgetCode = debug.lastBudgetCode;
    return this.diagnosticsRecord;
  }

  // ----------------------------------------------------------- tick stages

  private shouldReplan(tick: number, view: StreamView): boolean {
    if (this.needsReplan) return true;
    if (tick - this.lastDecisionTick >= this.config.budgets.decisionIntervalTicks) {
      return true;
    }
    if (this.prevFocusX.length !== view.focus.length) return true;
    for (let index = 0; index < view.focus.length; index += 1) {
      const focus = view.focus[index];
      if (focus === undefined) continue;
      const dx = focus.position.x - (this.prevFocusX[index] ?? 0);
      const dz = focus.position.z - (this.prevFocusZ[index] ?? 0);
      if (Math.hypot(dx, dz) > 8) return true;
    }
    return false;
  }

  private replan(tick: number, view: StreamView): void {
    this.currentLods.clear();
    for (const [key, cell] of this.activated) {
      this.currentLods.set(key, cell.lod);
    }
    this.planCache = this.planner.plan(view, this.currentLods);
    this.desiredVisual.clear();
    this.desiredSim.clear();
    this.lastDecisionTick = tick;
    this.needsReplan = false;
    this.prevFocusX.length = view.focus.length;
    this.prevFocusZ.length = view.focus.length;
    for (let index = 0; index < view.focus.length; index += 1) {
      const focus = view.focus[index];
      this.prevFocusX[index] = focus?.position.x ?? 0;
      this.prevFocusZ[index] = focus?.position.z ?? 0;
    }
    this.statsRecorder.recordDecision(this.planCache.length);
  }

  /** Ensures records for demanded payloads and cancels obsolete pending LODs. */
  private admitDemand(tick: number): void {
    const candidates = this.planCache;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      const entry = this.index.entry(candidate.key);
      if (entry === undefined) continue;
      if (candidate.kind === "visual") {
        if (candidate.lod === null) continue;
        const payload = this.index.visualPayload(candidate.key, candidate.lod);
        if (payload === undefined) continue;
        this.desiredVisual.set(candidate.key, payload.lod);
        const record = this.residency.ensure({
          key: candidate.key,
          cx: candidate.cx,
          cy: candidate.cy,
          kind: "visual",
          lod: payload.lod,
          url: payload.url,
          expectedBytes: payload.bytes,
          contentHash: entry.contentHash,
        });
        this.admitRecord(record, candidate, tick);
      } else {
        const payload = this.index.simPayload(candidate.key);
        if (payload === undefined) continue;
        this.desiredSim.add(candidate.key);
        const record = this.residency.ensure({
          key: candidate.key,
          cx: candidate.cx,
          cy: candidate.cy,
          kind: "sim",
          lod: null,
          url: payload.url,
          expectedBytes: payload.bytes,
          contentHash: entry.contentHash,
        });
        this.admitRecord(record, candidate, tick);
      }
    }

    for (const record of this.residency.all()) {
      if (record.kind !== "visual") continue;
      if (
        record.state !== "queued" &&
        record.state !== "loading" &&
        record.state !== "decoding" &&
        record.state !== "ready"
      ) {
        continue;
      }
      const desired = this.desiredVisual.get(record.key);
      if (desired !== undefined && desired !== record.lod) {
        this.cancelRecord(record);
      }
    }
  }

  private admitRecord(
    record: PayloadRecord,
    candidate: PriorityCandidate,
    tick: number,
  ): void {
    const id = payloadId(record.kind, record.key, record.lod);
    if (this.blocked.has(id)) return;
    if (record.state === "failed") {
      if (record.retryAtTick === Number.POSITIVE_INFINITY) {
        if (candidate.priorityClass !== 0) return;
        this.residency.resetForReentry(record);
      } else {
        if (tick < record.retryAtTick) return;
        this.residency.readyRetry(record, tick);
      }
    }
    if (record.state === "unloaded") {
      this.residency.admit(record, tick, candidate.priorityClass, candidate.score);
      return;
    }
    if (record.state === "queued") {
      // Refresh demand metadata; `admit` is idempotent while queued.
      this.residency.admit(record, tick, candidate.priorityClass, candidate.score);
    }
  }

  private startLoads(tick: number): void {
    const candidates = this.planCache;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (candidate === undefined) continue;
      if (candidate.kind === "visual") {
        const resolvedLod = this.desiredVisual.get(candidate.key);
        if (resolvedLod === undefined) continue;
        this.startRecord(
          this.residency.get(payloadId("visual", candidate.key, resolvedLod)),
          tick,
        );
      } else {
        this.startRecord(this.residency.get(payloadId("sim", candidate.key)), tick);
      }
    }
    for (const record of this.residency.all()) {
      if (record.state === "queued") this.startRecord(record, tick);
    }
  }

  private startRecord(record: PayloadRecord | undefined, tick: number): void {
    if (record === undefined || record.state !== "queued") return;
    const source = this.source;
    if (source === null) return;
    const controller = new AbortController();
    if (!this.residency.tryStart(record, tick, controller)) return;
    this.statsRecorder.recordLoadStarted();
    void this.load(record, controller.signal, source);
  }

  private async load(
    record: PayloadRecord,
    signal: AbortSignal,
    source: CellSource,
  ): Promise<void> {
    try {
      const bytes = await this.fetchBytes(record, signal, source);
      if (signal.aborted || this.stopped || this.disposed || record.state !== "loading") {
        return;
      }
      if (bytes.byteLength !== record.expectedBytes) {
        throw streamingError(
          "E_CELL_SIZE",
          `${record.url} returned ${bytes.byteLength} bytes; the manifest declares ${record.expectedBytes}`,
        );
      }
      this.residency.markReceived(record);
      const entry = this.index.entry(record.key);
      if (entry === undefined) {
        throw streamingError("E_WORLD_ENTRY", `cell ${record.key} is not in the index`);
      }
      const decoded = await decodeCell(bytes, {
        cellSizeMeters: this.grid.cellSizeMeters,
        expectedCx: record.cx,
        expectedCy: record.cy,
        bounds: this.grid.boundsOf(record.cx, record.cy),
        decodeGzip: this.options.decodeGzip,
        ...(record.kind === "sim"
          ? { expectedHasCollision: entry.hasCollision, expectedHasNav: entry.hasNav }
          : {}),
        ...(this.options.onSection !== undefined
          ? { onSection: this.options.onSection }
          : {}),
      });
      // `markReceived` moved the record to `decoding`, but control-flow
      // narrowing still sees the pre-await `loading`; widen before comparing.
      if (
        signal.aborted ||
        this.stopped ||
        this.disposed ||
        (record.state as ResidencyState) !== "decoding"
      ) {
        return;
      }
      const content = this.buildPayload(decoded, record);
      const id = payloadId(record.kind, record.key, record.lod);
      this.contents.set(id, content);
      this.residency.markReady(record, this.lastTick);
      this.statsRecorder.recordLoadCompleted();
      this.ready.push(record);
    } catch (error) {
      if (this.stopped || this.disposed) return;
      if (record.state !== "loading" && record.state !== "decoding") return;
      if (signal.aborted) {
        this.residency.cancelPending(record);
        this.statsRecorder.recordLoadCancelled();
        return;
      }
      const code = errorCodeOf(error);
      this.residency.markFailed(record, code, this.lastTick);
      this.statsRecorder.recordLoadFailed();
      if (record.attempts >= MAX_LOAD_ATTEMPTS) {
        this.events.emit({
          type: "cellFailed",
          key: record.key,
          attempts: record.attempts,
          code,
        });
      }
    }
  }

  private async fetchBytes(
    record: PayloadRecord,
    signal: AbortSignal,
    source: CellSource,
  ): Promise<ArrayBuffer> {
    const name = cacheNameOf(record.url);
    if (this.cache !== null && name !== null) {
      const cached = await this.cache.get(record.contentHash, name, this.lastTick);
      if (cached !== undefined) return cached;
    }
    const bytes = await source.fetchCell(record.url, record.expectedBytes, signal);
    if (this.cache !== null && name !== null) {
      await this.cache.put(record.contentHash, name, bytes, this.lastTick);
    }
    return bytes;
  }

  /** Distance and guard evictions, plus cancellation of pending far loads. */
  private evictOutOfRange(view: StreamView): void {
    for (const [key, cell] of this.activated) {
      if (this.pinned.has(key)) continue;
      const distance = this.nearestFocusDistance(view, cell.cx, cell.cy);
      if (distance <= STREAMING_DEFAULTS.playerGuardMeters) continue;
      if (
        shouldUnload(
          distance,
          this.config.lodBands,
          this.planner.lodBias,
          this.grid.cellSizeMeters,
        )
      ) {
        this.deactivate(key, "distance");
      }
    }
    for (const record of this.residency.all()) {
      if (
        record.state !== "queued" &&
        record.state !== "loading" &&
        record.state !== "decoding" &&
        record.state !== "ready"
      ) {
        continue;
      }
      if (this.pinned.has(record.key)) continue;
      const distance = this.nearestFocusDistance(view, record.cx, record.cy);
      if (distance <= STREAMING_DEFAULTS.playerGuardMeters) continue;
      if (
        shouldUnload(
          distance,
          this.config.lodBands,
          this.planner.lodBias,
          this.grid.cellSizeMeters,
        )
      ) {
        this.cancelRecord(record);
      }
    }
  }

  private handlePressure(view: StreamView): void {
    const stage = this.ledger.pressureStage;
    if (stage > 0 && stage > this.lastPressureStage) {
      const bytesNeeded = Math.max(0, this.ledger.residentBytes - this.ledger.budgetBytes);
      this.events.emit({
        type: "pressure",
        stage: stage as 1 | 2 | 3,
        residentBytes: this.ledger.residentBytes,
      });
      this.sink?.onPressure(stage as 1 | 2 | 3, bytesNeeded);
      if (this.planner.lodBias < 3) {
        this.planner.setLodBias(this.planner.lodBias + 1);
        this.needsReplan = true;
      }
    }
    this.lastPressureStage = stage;

    if (stage > 0) {
      this.overBudgetTicks += 1;
      this.evictForPressure(view);
      this.checkPinBudget();
      this.checkSimBudget();
      if (this.overBudgetTicks > 3) {
        this.statsRecorder.recordBudgetBreach("E_STREAM_BUDGET");
      }
    } else {
      this.overBudgetTicks = 0;
    }

    if (this.ledger.recovered) {
      this.recoveryTicks += 1;
      if (this.recoveryTicks >= 600 && this.planner.lodBias > 0) {
        this.planner.setLodBias(this.planner.lodBias - 1);
        this.recoveryTicks = 0;
        this.needsReplan = true;
      }
    } else {
      this.recoveryTicks = 0;
    }
  }

  private evictForPressure(view: StreamView): void {
    this.evictionCandidates.length = 0;
    let cursor = 0;
    for (const [key, cell] of this.activated) {
      let scratch = this.evictionScratch[cursor];
      if (scratch === undefined) {
        scratch = {
          key,
          cx: cell.cx,
          cy: cell.cy,
          lod: cell.lod,
          distanceMeters: 0,
          pinned: false,
          guarded: false,
          inSimRing: false,
        };
        this.evictionScratch[cursor] = scratch;
      }
      const distance = this.nearestFocusDistance(view, cell.cx, cell.cy);
      scratch.key = key;
      scratch.cx = cell.cx;
      scratch.cy = cell.cy;
      scratch.lod = cell.lod;
      scratch.distanceMeters = distance;
      scratch.pinned = this.pinned.has(key);
      scratch.guarded = distance <= STREAMING_DEFAULTS.playerGuardMeters;
      scratch.inSimRing = this.desiredSim.has(key);
      this.evictionCandidates.push(scratch);
      cursor += 1;
    }
    const victims = selectPressureEvictions(this.evictionCandidates);
    for (const victim of victims) {
      if (this.ledger.pressureStage === 0) break;
      this.deactivate(victim.key, "pressure");
    }
  }

  private checkPinBudget(): void {
    let pinnedBytes = 0;
    for (const key of this.pinned) {
      const cell = this.activated.get(key);
      if (cell === undefined) continue;
      pinnedBytes +=
        this.billOf(cell.visual) + (cell.sim !== null ? this.billOf(cell.sim) : 0);
    }
    if (pinnedBytes > this.ledger.budgetBytes) {
      this.statsRecorder.recordBudgetBreach("E_STREAM_PIN_BUDGET");
      this.sink?.onPressure(3, pinnedBytes - this.ledger.budgetBytes);
    }
  }

  private checkSimBudget(): void {
    if (this.simResidentBytes > this.ledger.budgetBytes) {
      this.statsRecorder.recordBudgetBreach("E_STREAM_SIM_BUDGET");
    }
  }

  // ------------------------------------------------------------- apply path

  private applyReady(): void {
    if (this.ready.length === 0) return;
    for (const pair of this.readyState.values()) {
      pair.visual = null;
      pair.sim = null;
    }
    this.readyKeys.length = 0;
    for (const record of this.ready) {
      if (record.state !== "ready") continue;
      let pair = this.readyState.get(record.key);
      if (pair === undefined) {
        pair = { visual: null, sim: null };
        this.readyState.set(record.key, pair);
      }
      if (record.kind === "visual") pair.visual = record;
      else pair.sim = record;
    }
    for (const [key, pair] of this.readyState) {
      if (pair.visual !== null) this.readyKeys.push(key);
    }
    this.readyKeys.sort(compareCellKeys);
    const startedAt = this.options.now?.();
    for (const key of this.readyKeys) {
      if (startedAt !== undefined && this.options.now !== undefined) {
        if (this.options.now() - startedAt > this.config.budgets.streamerTickMs) break;
      }
      const pair = this.readyState.get(key);
      if (pair === undefined || pair.visual === null) continue;
      this.tryActivate(key, pair.visual, pair.sim);
    }
    this.pruneReady();
  }

  private tryActivate(
    key: CellKey,
    visual: PayloadRecord,
    simReady: PayloadRecord | null,
  ): void {
    const desiredLod = this.desiredVisual.get(key);
    if (desiredLod !== undefined && visual.lod !== desiredLod) return;
    // A visual record always carries a target LOD; the guard narrows the type.
    const visualLod = visual.lod;
    if (visualLod === null) return;

    const entry = this.index.entry(key);
    if (entry === undefined) return;
    const requiresSim = entry.simUrl !== "" && this.desiredSim.has(key);
    const simLookup = this.residency.get(payloadId("sim", key));
    let simRecord: PayloadRecord | null = null;
    if (requiresSim) {
      if (simLookup === undefined) return;
      const parked =
        simLookup.state === "failed" &&
        simLookup.retryAtTick === Number.POSITIVE_INFINITY;
      if (simLookup.state !== "ready" && simLookup.state !== "resident" && !parked) {
        return;
      }
      simRecord = parked ? null : simLookup;
    }
    if (simReady !== null && simReady !== simRecord) {
      // A ready sim record that the plan no longer requires is released.
      this.cancelRecord(simReady);
    }

    const existing = this.activated.get(key);
    if (
      existing !== undefined &&
      existing.lod === visual.lod &&
      existing.visual === visual &&
      existing.sim === simRecord
    ) {
      return;
    }

    const visualContent = this.contents.get(payloadId("visual", key, visualLod));
    if (visualContent === undefined) return;
    let simContent: PayloadContent | null = null;
    if (simRecord !== null) {
      simContent = this.contents.get(payloadId("sim", key)) ?? null;
      if (simContent === null) return;
    } else if (existing !== undefined && existing.sim !== null) {
      simContent = this.contents.get(payloadId("sim", key)) ?? null;
    }

    // ER-12-03: never admit a payload that would take the ledger over budget,
    // and never exceed the resident-cell cap. A cell that does not fit stays
    // ready; pressure or eviction frees room on a later tick. This check uses
    // the decoded byte counts, so shared-buffer dedupe can only make it more
    // conservative, never over budget.
    if (
      existing === undefined &&
      this.activated.size >= this.config.budgets.maxResidentCells
    ) {
      return;
    }
    const prospectiveBytes =
      contentBytes(visualContent) +
      (simContent !== null ? contentBytes(simContent) : 0);
    const currentBytes =
      existing !== undefined
        ? this.billOf(existing.visual) +
          (existing.sim !== null ? this.billOf(existing.sim) : 0)
        : 0;
    if (this.ledger.wouldExceed(Math.max(0, prospectiveBytes - currentBytes))) {
      return;
    }

    if (existing !== undefined) {
      // Release only the outgoing visual payload; the sim payload stays
      // resident across a LOD swap.
      this.releasePayload(existing.visual);
      try {
        this.sink?.onCellDeactivate(key);
      } catch {
        // A throwing deactivate is a sink bug; streaming must continue.
      }
    }

    this.residency.markResident(visual);
    this.chargePayload(visual, visualContent);
    if (simRecord !== null && simContent !== null && simRecord.state === "ready") {
      this.residency.markResident(simRecord);
      this.chargePayload(simRecord, simContent);
    }

    let view = this.views.get(key);
    if (view === undefined) {
      view = {
        id: { cx: visual.cx, cy: visual.cy },
        key,
        lod: visualLod,
        state: "resident",
        bytes: 0,
      };
      this.views.set(key, view);
    }
    view.lod = visualLod;
    view.state = "resident";
    view.bytes = this.billOf(visual) + (simRecord !== null ? this.billOf(simRecord) : 0);

    const content: CellContent = {
      key,
      lod: visualLod,
      render: visualContent.render,
      collisionBytes: simContent?.collisionBytes ?? null,
      navBytes: simContent?.navBytes ?? null,
      audioEmitters: simContent?.audioEmitters ?? [],
      entities: simContent?.entities ?? [],
    };

    try {
      this.sink?.onCellActivate(view, content);
    } catch {
      this.releasePayload(visual);
      if (simRecord !== null && simRecord.state === "resident") {
        this.releasePayload(simRecord);
      }
      this.blocked.add(payloadId("visual", key, visualLod));
      this.statsRecorder.recordApplyFailure();
      this.statsRecorder.recordLoadFailed();
      this.events.emit({
        type: "cellFailed",
        key,
        attempts: visual.attempts,
        code: "E_CELL_APPLY",
      });
      return;
    }

    if (existing !== undefined && existing.lod !== visualLod) {
      this.statsRecorder.recordLodChange(existing.lod, visualLod);
    }
    this.activated.set(key, {
      key,
      cx: visual.cx,
      cy: visual.cy,
      lod: visualLod,
      visual,
      sim: simRecord,
      view,
    });
    this.events.emit({
      type: "cellLoaded",
      key,
      lod: visualLod,
      bytes: visual.expectedBytes + (simRecord?.expectedBytes ?? 0),
    });
  }

  private pruneReady(): void {
    for (let index = this.ready.length - 1; index >= 0; index -= 1) {
      const record = this.ready[index];
      if (record === undefined || record.state !== "ready") {
        this.ready.splice(index, 1);
      }
    }
  }

  // ------------------------------------------------------- release helpers

  private deactivate(key: CellKey, reason: EvictionReason): void {
    const cell = this.activated.get(key);
    if (cell === undefined) return;
    try {
      this.sink?.onCellDeactivate(key);
    } catch {
      // A throwing deactivate is a sink bug; streaming must continue.
    }
    this.releasePayload(cell.visual);
    if (cell.sim !== null) this.releasePayload(cell.sim);
    this.activated.delete(key);
    const view = this.views.get(key);
    if (view !== undefined) {
      view.state = "unloaded";
      view.bytes = 0;
    }
    this.statsRecorder.recordEviction(reason);
    this.events.emit({ type: "cellEvicted", key, reason });
  }

  /** Cancels a payload that is not part of an activated cell. */
  private cancelRecord(record: PayloadRecord): void {
    const id = payloadId(record.kind, record.key, record.lod);
    if (record.state === "ready") {
      this.contents.delete(id);
      this.residency.beginEvict(record);
      this.residency.release(record);
      this.statsRecorder.recordLoadCancelled();
      return;
    }
    if (
      record.state === "queued" ||
      record.state === "loading" ||
      record.state === "decoding"
    ) {
      this.residency.cancelPending(record);
      this.contents.delete(id);
      this.statsRecorder.recordLoadCancelled();
    }
  }

  /** Releases a ready/resident payload and its ledger entry. */
  private releasePayload(record: PayloadRecord): void {
    const id = payloadId(record.kind, record.key, record.lod);
    if (this.ledger.has(id)) {
      const bill = this.ledger.billFor(id);
      this.ledger.remove(id);
      if (record.kind === "sim" && bill !== undefined) {
        this.simResidentBytes = Math.max(0, this.simResidentBytes - bill.totalBytes);
      }
    }
    if (record.state === "ready" || record.state === "resident") {
      this.contents.delete(id);
      this.residency.beginEvict(record);
      this.residency.release(record);
      return;
    }
    if (
      record.state === "queued" ||
      record.state === "loading" ||
      record.state === "decoding"
    ) {
      this.residency.cancelPending(record);
      this.contents.delete(id);
    }
  }

  private chargePayload(record: PayloadRecord, content: PayloadContent): void {
    const id = payloadId(record.kind, record.key, record.lod);
    this.ledger.add({
      key: id,
      geometryBytes: content.geometryBytes,
      textureBytes: content.textureBytes,
      cpuBytes: content.cpuBytes,
    });
    if (record.kind === "sim") {
      this.simResidentBytes +=
        content.geometryBytes + content.textureBytes + content.cpuBytes;
    }
  }

  private billOf(record: PayloadRecord): number {
    return this.ledger.billFor(payloadId(record.kind, record.key, record.lod))?.totalBytes ?? 0;
  }

  // ----------------------------------------------------------- projections

  private refreshViews(): void {
    for (const record of this.residency.all()) {
      let view = this.views.get(record.key);
      if (view === undefined) {
        view = {
          id: { cx: record.cx, cy: record.cy },
          key: record.key,
          lod: record.lod ?? 0,
          state: "unloaded",
          bytes: 0,
        };
        this.views.set(record.key, view);
      }
      const projected = publicCellState(record.state);
      if (projected === "loading") {
        view.state = "loading";
      } else if (projected === "evicting") {
        view.state = "evicting";
      }
    }
    for (const [key, cell] of this.activated) {
      const view = cell.view;
      view.lod = cell.lod;
      view.state = "resident";
      view.bytes = this.billOf(cell.visual) + (cell.sim !== null ? this.billOf(cell.sim) : 0);
      this.views.set(key, view);
    }
    for (const [key, view] of this.views) {
      if (!this.activated.has(key) && view.state === "unloaded") {
        this.views.delete(key);
      }
    }
    this.residentSnapshot.length = 0;
    for (const entry of this.index.cells) {
      const view = this.views.get(entry.key);
      if (view !== undefined && this.activated.has(entry.key)) {
        this.residentSnapshot.push(view);
      }
    }
  }

  private refreshStats(): void {
    this.statsRecorder.setResidency(
      this.activated.size,
      this.residency.countIn(["loading", "decoding"]),
      this.residency.countIn(["queued"]),
      this.residency.countIn(["failed"]),
    );
    this.statsRecorder.setMemory(this.ledger.snapshot(), this.ledger.pressureStage);
  }

  private nearestFocusDistance(view: StreamView, cx: number, cy: number): number {
    let nearest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < view.focus.length; index += 1) {
      const focus = view.focus[index];
      if (focus === undefined) continue;
      const distance = this.grid.distanceToCellXZ(focus.position.x, focus.position.z, cx, cy);
      if (distance < nearest) nearest = distance;
    }
    if (nearest === Number.POSITIVE_INFINITY) {
      return this.grid.distanceToCellXZ(view.cameraPosition.x, view.cameraPosition.z, cx, cy);
    }
    return nearest;
  }
}

/** Decoded bytes a payload will charge to the ledger. */
function contentBytes(content: PayloadContent): number {
  return content.geometryBytes + content.textureBytes + content.cpuBytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {  return bytes.slice().buffer as ArrayBuffer;
}

const CACHE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Last path segment of a cell URL, or null when it is not cache-name safe. */
function cacheNameOf(url: string): string | null {
  const path = new URL(url).pathname;
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  return CACHE_NAME_PATTERN.test(name) && !name.includes("..") ? name : null;
}

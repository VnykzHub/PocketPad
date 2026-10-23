/**
 * In-memory world, `.cell` payloads, source and sink for the ER-12 tests.
 *
 * Nothing here touches the network or the filesystem at test time: fixtures
 * are built deterministically from the same constants as
 * `test/fixtures/build-world.mjs`, and the streamer receives a `CellSource`
 * that resolves synchronously (plus microtasks). Real-network and real-
 * CacheStorage behaviour is out of scope for a Node unit test (ER-12-12/13/14
 * stay PENDING; 12 §8 forbids asserting them here).
 */

import { gzipSync, gunzipSync } from "node:zlib";
import { expect } from "vitest";
import { fnv1a32 } from "@lanpad/engine-core";
import type {
  CellCache,
  CellContent,
  CellKey,
  CellSource,
  StreamSink,
  StreamView,
  WorldCell,
  WorldConfig,
  WorldStreamer,
} from "../../src/index.js";
import { WorldIndex, isStreamingError, validateWorldConfig } from "../../src/index.js";

export const TEST_MANIFEST_URL = "http://localhost/worlds/test/world.json";
export const DEFAULT_CELL_SIZE = 64;

export function gzipBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(bytes));
}

/** The injected decoder for Node tests; the runtime supplies its own. */
export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(gunzipSync(bytes));
}

export function contentHashOf(key: string): string {
  return `fnv1a32:${fnv1a32(new TextEncoder().encode(key)).toString(16).padStart(8, "0")}`;
}

export interface CellSpec {
  readonly cx: number;
  readonly cy: number;
  readonly kind: 0 | 1;
  /** Visual LOD; ignored for sim payloads (0xFF is written). */
  readonly lod?: 0 | 1 | 2 | 3;
  readonly meshBytes?: number;
  readonly textureBytes?: number;
  readonly collisionBytes?: number;
  readonly navBytes?: number;
  readonly gzipSections?: boolean;
  readonly cellSizeMeters?: number;
  readonly originX?: number;
  readonly originZ?: number;
}

interface BuiltSection {
  readonly type: number;
  readonly uncompressed: Uint8Array;
  readonly stored: Uint8Array;
  readonly gzip: boolean;
}

const CELL_MAGIC = 0x4c43_5050;
const HEADER_BYTES = 64;
const SECTION_BYTES = 24;

/** Builds one valid `.cell` container; the mirror of `Decode.ts`. */
export function buildCellBytes(spec: CellSpec): Uint8Array {
  const cellSize = spec.cellSizeMeters ?? DEFAULT_CELL_SIZE;
  const originX = spec.originX ?? 0;
  const originZ = spec.originZ ?? 0;
  const sections: BuiltSection[] = [];
  const push = (type: number, size: number): void => {
    if (size <= 0) return;
    const uncompressed = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) {
      uncompressed[index] = (type * 31 + index * 7 + spec.cx * 3 + spec.cy * 5) & 0xff;
    }
    const gzip = spec.gzipSections === true;
    sections.push({
      type,
      uncompressed,
      stored: gzip ? gzipBytes(uncompressed) : uncompressed.slice(),
      gzip,
    });
  };
  if (spec.kind === 0) {
    push(1, spec.meshBytes ?? 32);
    push(2, spec.textureBytes ?? 16);
  } else {
    push(3, spec.collisionBytes ?? 24);
    push(4, spec.navBytes ?? 12);
  }

  const tableEnd = HEADER_BYTES + SECTION_BYTES * sections.length;
  let total = tableEnd;
  const offsets: number[] = [];
  for (const section of sections) {
    total += (4 - (total % 4)) % 4;
    offsets.push(total);
    total += section.stored.length;
  }

  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, CELL_MAGIC, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, HEADER_BYTES, true);
  const uncompressedBytes = sections.reduce((sum, section) => sum + section.uncompressed.length, 0);
  const concatenated = new Uint8Array(uncompressedBytes);
  let cursor = 0;
  for (const section of sections) {
    concatenated.set(section.uncompressed, cursor);
    cursor += section.uncompressed.length;
  }
  view.setUint32(8, fnv1a32(concatenated), true);
  view.setInt32(12, spec.cx, true);
  view.setInt32(16, spec.cy, true);
  view.setUint16(20, cellSize * 100, true);
  view.setUint8(22, spec.kind);
  view.setUint8(23, spec.kind === 0 ? (spec.lod ?? 0) : 0xff);
  view.setUint32(24, uncompressedBytes, true);
  view.setUint32(28, sections.length, true);
  view.setFloat32(32, originX + spec.cx * cellSize, true);
  view.setFloat32(36, 0, true);
  view.setFloat32(40, originZ + spec.cy * cellSize, true);
  view.setFloat32(44, originX + (spec.cx + 1) * cellSize, true);
  view.setFloat32(48, 8, true);
  view.setFloat32(52, originZ + (spec.cy + 1) * cellSize, true);
  let flags = 0;
  if (spec.kind === 1) {
    flags = 0x1 | 0x2;
  }
  view.setUint32(56, flags, true);
  view.setUint32(60, 0, true);
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index] as BuiltSection;
    const base = HEADER_BYTES + index * SECTION_BYTES;
    view.setUint16(base, section.type, true);
    view.setUint16(base + 2, section.gzip ? 1 : 0, true);
    view.setUint32(base + 4, offsets[index] as number, true);
    view.setUint32(base + 8, section.stored.length, true);
    view.setUint32(base + 12, section.uncompressed.length, true);
    view.setUint16(base + 16, 1, true);
    view.setUint16(base + 18, 0, true);
    view.setUint32(base + 20, fnv1a32(section.uncompressed), true);
    bytes.set(section.stored, offsets[index] as number);
  }
  return bytes;
}

export interface TestWorldOptions {
  /** Grid side length; cells are `0..size-1` on both axes. */
  readonly size?: number;
  readonly cellSizeMeters?: number;
  readonly gzipSections?: boolean;
  readonly originX?: number;
  readonly originZ?: number;
  readonly budgets?: Partial<WorldConfig["budgets"]>;
  /** Adds a simulation payload to every cell (default true). */
  readonly withSim?: boolean;
}

export interface TestWorld {
  readonly config: WorldConfig;
  readonly index: WorldIndex;
  readonly payloads: ReadonlyMap<string, ArrayBuffer>;
  readonly keys: readonly CellKey[];
}

/** Builds a validated small world plus the exact payloads it declares. */
export function createTestWorld(options: TestWorldOptions = {}): TestWorld {
  const size = options.size ?? 3;
  const cellSize = options.cellSizeMeters ?? DEFAULT_CELL_SIZE;
  const originX = options.originX ?? 0;
  const originZ = options.originZ ?? 0;
  const withSim = options.withSim ?? true;
  const payloads = new Map<string, ArrayBuffer>();
  const cells: unknown[] = [];
  const keys: CellKey[] = [];

  for (let cx = 0; cx < size; cx += 1) {
    for (let cy = 0; cy < size; cy += 1) {
      const key = `${cx},${cy}`;
      keys.push(key as CellKey);
      const prefix = `cells/${cx}_${cy}`;
      const visualUrls: string[] = [];
      const visualBytes: number[] = [];
      for (let lod = 0; lod < 4; lod += 1) {
        const url = `${prefix}_l${lod}.cell`;
        const bytes = buildCellBytes({
          cx,
          cy,
          kind: 0,
          lod: lod as 0 | 1 | 2 | 3,
          meshBytes: 32,
          textureBytes: 16,
          cellSizeMeters: cellSize,
          originX,
          originZ,
          ...(options.gzipSections === true ? { gzipSections: true } : {}),
        });
        visualUrls.push(url);
        visualBytes.push(bytes.byteLength);
        payloads.set(resolve(url), bytes.slice().buffer);
      }
      let simUrl = "";
      let simBytes = 0;
      if (withSim) {
        simUrl = `${prefix}_sim.cell`;
        const sim = buildCellBytes({
          cx,
          cy,
          kind: 1,
          cellSizeMeters: cellSize,
          originX,
          originZ,
          ...(options.gzipSections === true ? { gzipSections: true } : {}),
        });
        simBytes = sim.byteLength;
        payloads.set(resolve(simUrl), sim.slice().buffer);
      }
      cells.push({
        key,
        cx,
        cy,
        visualUrls,
        simUrl,
        visualBytes,
        simBytes,
        contentHash: contentHashOf(key),
        hasCollision: withSim,
        hasNav: withSim,
      });
    }
  }

  const raw = {
    formatVersion: 1,
    worldId: "test-world",
    seed: 0x5eed1234,
    cellSizeMeters: cellSize,
    origin: { x: originX, y: 0, z: originZ },
    grid: { minX: 0, minY: 0, maxX: size - 1, maxY: size - 1 },
    lodBands: [
      { lod: 0, maxDistanceMeters: 96, hysteresisMeters: 8 },
      { lod: 1, maxDistanceMeters: 160, hysteresisMeters: 12 },
      { lod: 2, maxDistanceMeters: 256, hysteresisMeters: 16 },
      { lod: 3, maxDistanceMeters: 384, hysteresisMeters: 24 },
    ],
    budgets: {
      residentBytes: 64 * 1024 * 1024,
      textureBytes: 32 * 1024 * 1024,
      geometryBytes: 16 * 1024 * 1024,
      cpuBytes: 4 * 1024 * 1024,
      maxResidentCells: 256,
      maxConcurrentLoads: 4,
      maxLoadsStartedPerTick: 1,
      decisionIntervalTicks: 6,
      streamerTickMs: 2,
      maxTaskMs: 8,
      cacheBytes: 16 * 1024 * 1024,
      cacheEnabled: true,
      ...options.budgets,
    },
    cells,
  };
  const config = validateWorldConfig(raw, TEST_MANIFEST_URL);
  const index = new WorldIndex(config, TEST_MANIFEST_URL);
  return { config, index, payloads, keys };
}

function resolve(relative: string): string {
  return new URL(relative, TEST_MANIFEST_URL).href;
}

export interface FetchRecord {
  readonly url: string;
  readonly tick: number;
  readonly aborted: boolean;
}

/**
 * Deterministic in-memory source. `fetchCell` resolves after `latencyMs`
 * (0 by default) and honors the abort signal; `clone()` gives each run its
 * own counters.
 */
export class MemorySource implements CellSource {
  readonly payloads: Map<string, ArrayBuffer>;
  readonly fetches: FetchRecord[] = [];
  latencyMs = 0;
  failUrls = new Set<string>();
  readonly cache?: CellCache;

  constructor(payloads: ReadonlyMap<string, ArrayBuffer>, cache?: CellCache) {
    this.payloads = new Map(payloads);
    if (cache !== undefined) this.cache = cache;
  }

  get fetchCount(): number {
    return this.fetches.length;
  }

  async fetchCell(url: string, expectedBytes: number, signal: AbortSignal): Promise<ArrayBuffer> {
    this.fetches.push({ url, tick: this.fetches.length, aborted: signal.aborted });
    if (this.latencyMs > 0) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, this.latencyMs));
    } else {
      await Promise.resolve();
    }
    if (signal.aborted) {
      throw new Error("fetch aborted");
    }
    if (this.failUrls.has(url)) {
      throw new Error(`fixture failure for ${url}`);
    }
    const bytes = this.payloads.get(url);
    if (bytes === undefined) throw new Error(`no fixture payload for ${url}`);
    if (bytes.byteLength !== expectedBytes) {
      throw new Error(`fixture mismatch: ${url} is ${bytes.byteLength}, expected ${expectedBytes}`);
    }
    return bytes.slice(0);
  }
}

export interface ActivationRecord {
  readonly key: CellKey;
  readonly lod: 0 | 1 | 2 | 3;
  readonly content: CellContent;
}

/** Recording sink; assertions read these arrays. */
export class RecordingSink implements StreamSink {
  readonly activations: ActivationRecord[] = [];
  readonly deactivations: CellKey[] = [];
  readonly lodChanges: { key: CellKey; lod: 0 | 1 | 2 | 3 }[] = [];
  readonly pressures: { stage: 1 | 2 | 3; bytesNeeded: number }[] = [];
  throwOnActivate = false;

  onCellActivate(cell: WorldCell, content: CellContent): void {
    if (this.throwOnActivate) throw new Error("sink rejected the cell");
    this.activations.push({ key: cell.key, lod: cell.lod, content });
  }

  onCellDeactivate(key: CellKey): void {
    this.deactivations.push(key);
  }

  onCellLodChange(key: CellKey, lod: 0 | 1 | 2 | 3): void {
    this.lodChanges.push({ key, lod });
  }

  onPressure(stage: 1 | 2 | 3, bytesNeeded: number): void {
    this.pressures.push({ stage, bytesNeeded });
  }

  activeKeys(): CellKey[] {
    return this.activations.map((activation) => activation.key);
  }
}

/** A view with one focus at `(x, z)`, looking down +X. */
export function makeView(x: number, z: number): StreamView {
  return {
    focus: [{ position: { x, y: 0, z } }],
    cameraPosition: { x, y: 0, z },
    cameraForward: { x: 1, y: 0, z: 0 },
    cameraHalfFovRad: 0.6,
  };
}

/** A view with focus and camera separated, for camera-penalty tests. */
export function makeViewFacing(
  x: number,
  z: number,
  cameraX: number,
  cameraZ: number,
): StreamView {
  return {
    focus: [{ position: { x, y: 0, z } }],
    cameraPosition: { x: cameraX, y: 0, z: cameraZ },
    cameraForward: { x: 1, y: 0, z: 0 },
    cameraHalfFovRad: 0.6,
  };
}

/** Lets every pending microtask and timer-less continuation finish. */
export async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolveTurn) => setImmediate(resolveTurn));
  }
}

/** Real-timer wait for source-latency tests; never used to await the streamer. */
export async function delay(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Asserts that `fn` rejects with a `StreamingError` carrying exactly `code`. */
export async function expectCode(
  fn: () => Promise<unknown> | unknown,
  code: string,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a rejection with ${code}`).toBeDefined();
  expect(isStreamingError(caught), `expected a StreamingError, got ${String(caught)}`).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
}

/**
 * Runs `count` streamer ticks with microtask pumping between them. `view`
 * may change per tick, which is how drive and teleport scenarios are built.
 */
export async function runTicks(
  streamer: WorldStreamer,
  count: number,
  view: StreamView | ((tick: number) => StreamView),
  startTick = 0,
): Promise<number> {
  let tick = startTick;
  for (let index = 0; index < count; index += 1) {
    const frame = typeof view === "function" ? view(tick) : view;
    streamer.update(tick, frame);
    await settle(4);
    tick += 1;
  }
  return tick;
}

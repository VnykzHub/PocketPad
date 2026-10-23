/**
 * `world.json` parsing, manifest index, URL resolution and the boot-budget
 * check (spec 12 §4.1, §5.1, `src/Index.ts`).
 *
 * Windows note: the spec's file list names this module `src/Index.ts` and the
 * package barrel `src/index.ts`. Those two names are the same file on a
 * case-insensitive filesystem, so this module is stored as
 * `src/WorldIndex.ts`; the barrel keeps the conventional `index.ts` name that
 * `package.json` expects.
 *
 * Parsing is strict and fail-closed: an unknown `formatVersion`, a
 * non-canonical key, a duplicate cell, a hole, a bad URL, a missing LOD3 or a
 * grid over 16,384 cells is rejected with a named code (ER-12-01). No fetch
 * happens here; URLs are validated and resolved to absolute same-origin URLs
 * before any source sees them.
 *
 * Known spec contradiction, reported rather than papered over: 12 §4.1 says a
 * hole is legal only if the game declares water/void "via the flags bit in
 * §4.2", but a missing cell has no `.cell` payload to read and
 * `CellIndexEntry` carries no water field. This validator therefore rejects
 * every hole with `E_WORLD_HOLE` until the manifest gains an explicit flag.
 */

import type {
  CellIndexEntry,
  CellKey,
  LodBand,
  StreamingBudgets,
  WorldConfig,
} from "./contracts/world.js";
import { STREAMING_LIMITS } from "./contracts/world.js";
import {
  CellGrid,
  compareCellCoords,
  formatCellKey,
  isI32,
  tryParseCellKey,
} from "./Grid.js";
import { validateLodBands } from "./Lod.js";
import { streamingError } from "./StreamEvents.js";

export const WORLD_FORMAT_VERSION = 1;
/** 12 §4.1: the manifest is <= 512 KiB gzip. */
export const MAX_MANIFEST_GZIP_BYTES = 512 * 1024;
/** SPEC FR-9.6: game + manifest + first ring <= 5 MB gzip. */
export const MAX_BOOT_SET_GZIP_BYTES = 5 * 1024 * 1024;
/** 12 §4.6 bake limits, enforced defensively at runtime. */
export const VISUAL_LOD_BYTE_LIMITS = [
  1.5 * 1024 * 1024,
  512 * 1024,
  128 * 1024,
  32 * 1024,
] as const;
export const SIM_PAYLOAD_BYTE_LIMIT = 64 * 1024;

export const WORLD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const CONTENT_HASH_PATTERN = /^fnv1a32:[0-9a-f]{8}$/;
const MAX_CELL_URL_CHARS = 512;
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;
const ENCODED_DOT = /%2e/i;
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c|00)/i;
const FALLBACK_ORIGIN = "http://localhost";

type ManifestCode =
  | "E_WORLD_FORMAT"
  | "E_WORLD_GRID"
  | "E_WORLD_ENTRY"
  | "E_WORLD_BUDGET"
  | "E_WORLD_LOD_BANDS";

/** Parses and validates manifest text; `manifestUrl` anchors every cell URL. */
export function parseWorldManifest(text: string, manifestUrl: string): WorldConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw streamingError("E_WORLD_FORMAT", "world.json is not valid JSON");
  }
  return validateWorldConfig(raw, manifestUrl);
}

/** Validates an already-parsed manifest object (used by tooling and tests). */
export function validateWorldConfig(raw: unknown, manifestUrl: string): WorldConfig {
  // Parsed for API symmetry and future diagnostics; URLs never appear in
  // error messages, so validation does not read it today.
  void manifestUrl;
  const root = asRecord(raw, "E_WORLD_FORMAT", "world.json");
  const formatVersion = root["formatVersion"];
  if (formatVersion !== WORLD_FORMAT_VERSION) {
    throw streamingError(
      "E_WORLD_FORMAT",
      `unsupported world formatVersion: ${String(formatVersion)}`,
    );
  }

  const worldId = root["worldId"];
  if (typeof worldId !== "string" || !WORLD_ID_PATTERN.test(worldId)) {
    throw streamingError("E_WORLD_ID", "worldId must match ^[a-z0-9][a-z0-9_-]{0,63}$");
  }

  const seed = asInt(root["seed"], "E_WORLD_SEED", "seed", 0, 0xffff_ffff);
  const cellSizeMeters = asInt(
    root["cellSizeMeters"],
    "E_WORLD_CELL_SIZE",
    "cellSizeMeters",
    STREAMING_LIMITS.minCellSizeMeters,
    STREAMING_LIMITS.maxCellSizeMeters,
  );

  const originRecord = asRecord(root["origin"], "E_WORLD_FORMAT", "origin");
  const origin = {
    x: asFinite(originRecord["x"], "E_WORLD_FORMAT", "origin.x"),
    y: asFinite(originRecord["y"], "E_WORLD_FORMAT", "origin.y"),
    z: asFinite(originRecord["z"], "E_WORLD_FORMAT", "origin.z"),
  };

  const gridRecord = asRecord(root["grid"], "E_WORLD_GRID", "grid");
  const grid = {
    minX: asInt(gridRecord["minX"], "E_WORLD_GRID", "grid.minX", -2_147_483_648, 2_147_483_647),
    minY: asInt(gridRecord["minY"], "E_WORLD_GRID", "grid.minY", -2_147_483_648, 2_147_483_647),
    maxX: asInt(gridRecord["maxX"], "E_WORLD_GRID", "grid.maxX", -2_147_483_648, 2_147_483_647),
    maxY: asInt(gridRecord["maxY"], "E_WORLD_GRID", "grid.maxY", -2_147_483_648, 2_147_483_647),
  };
  // CellGrid enforces min <= max, the cell-size range and the 16,384-cell cap.
  const gridTransform = new CellGrid({ origin, cellSizeMeters, grid });

  const lodBands = parseLodBands(root["lodBands"]);
  validateLodBands(lodBands);

  const budgets = parseBudgets(root["budgets"]);
  const cells = parseCells(root["cells"], gridTransform);

  return {
    formatVersion: 1,
    worldId,
    seed,
    cellSizeMeters,
    origin,
    grid,
    lodBands,
    budgets,
    cells,
  };
}

function parseLodBands(raw: unknown): LodBand[] {
  const list = asArray(raw, "E_WORLD_LOD_BANDS", "lodBands");
  const bands: LodBand[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const record = asRecord(list[index], "E_WORLD_LOD_BANDS", `lodBands[${index}]`);
    const lod = asInt(record["lod"], "E_WORLD_LOD_BANDS", `lodBands[${index}].lod`, 0, 3);
    bands.push({
      lod: lod as 0 | 1 | 2 | 3,
      maxDistanceMeters: asFinite(
        record["maxDistanceMeters"],
        "E_WORLD_LOD_BANDS",
        `lodBands[${index}].maxDistanceMeters`,
      ),
      hysteresisMeters: asFinite(
        record["hysteresisMeters"],
        "E_WORLD_LOD_BANDS",
        `lodBands[${index}].hysteresisMeters`,
      ),
    });
  }
  return bands;
}

/**
 * The manifest's `budgets` block is required; every field is explicit so a
 * missing value cannot silently become an engine default (12 §4.1 example).
 */
function parseBudgets(raw: unknown): StreamingBudgets {
  const record = asRecord(raw, "E_WORLD_BUDGET", "budgets");
  const residentBytes = asInt(
    record["residentBytes"],
    "E_WORLD_BUDGET",
    "budgets.residentBytes",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const textureBytes = asInt(
    record["textureBytes"],
    "E_WORLD_BUDGET",
    "budgets.textureBytes",
    0,
    residentBytes,
  );
  const geometryBytes = asInt(
    record["geometryBytes"],
    "E_WORLD_BUDGET",
    "budgets.geometryBytes",
    0,
    residentBytes,
  );
  const cpuBytes = asInt(
    record["cpuBytes"],
    "E_WORLD_BUDGET",
    "budgets.cpuBytes",
    0,
    residentBytes,
  );
  if (textureBytes + geometryBytes + cpuBytes > residentBytes) {
    throw streamingError(
      "E_WORLD_BUDGET",
      "textureBytes + geometryBytes + cpuBytes must not exceed residentBytes",
    );
  }
  return {
    residentBytes,
    textureBytes,
    geometryBytes,
    cpuBytes,
    maxResidentCells: asInt(
      record["maxResidentCells"],
      "E_WORLD_BUDGET",
      "budgets.maxResidentCells",
      1,
      STREAMING_LIMITS.maxResidentCells,
    ),
    maxConcurrentLoads: asInt(
      record["maxConcurrentLoads"],
      "E_WORLD_BUDGET",
      "budgets.maxConcurrentLoads",
      1,
      STREAMING_LIMITS.maxConcurrentLoads,
    ),
    maxLoadsStartedPerTick: asInt(
      record["maxLoadsStartedPerTick"],
      "E_WORLD_BUDGET",
      "budgets.maxLoadsStartedPerTick",
      1,
      STREAMING_LIMITS.maxLoadsStartedPerTick,
    ),
    decisionIntervalTicks: asInt(
      record["decisionIntervalTicks"],
      "E_WORLD_BUDGET",
      "budgets.decisionIntervalTicks",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    streamerTickMs: asPositive(record["streamerTickMs"], "budgets.streamerTickMs"),
    maxTaskMs: asPositive(record["maxTaskMs"], "budgets.maxTaskMs"),
    cacheBytes: asInt(
      record["cacheBytes"],
      "E_WORLD_BUDGET",
      "budgets.cacheBytes",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    cacheEnabled: asBoolean(record["cacheEnabled"], "E_WORLD_BUDGET", "budgets.cacheEnabled"),
  };
}

function parseCells(raw: unknown, grid: CellGrid): readonly CellIndexEntry[] {
  const list = asArray(raw, "E_WORLD_ENTRY", "cells");
  if (list.length > STREAMING_LIMITS.maxCells) {
    throw streamingError(
      "E_WORLD_GRID",
      `world declares ${list.length} cells; the cap is ${STREAMING_LIMITS.maxCells}`,
    );
  }
  const byKey = new Map<CellKey, CellIndexEntry>();
  for (let index = 0; index < list.length; index += 1) {
    const entry = parseCellEntry(list[index], index);
    if (!grid.contains(entry.cx, entry.cy)) {
      throw streamingError(
        "E_WORLD_KEY",
        `cell ${entry.key} lies outside the configured grid`,
      );
    }
    if (byKey.has(entry.key)) {
      throw streamingError("E_WORLD_DUPLICATE", `duplicate cell key: ${entry.key}`);
    }
    byKey.set(entry.key, entry);
  }

  // Every cell in the rectangle needs exactly one entry (12 §4.1). Holes are
  // rejected outright; see the module comment for the missing water flag.
  grid.forEachCell((cx, cy) => {
    const key = formatCellKey(cx, cy);
    if (!byKey.has(key)) {
      throw streamingError("E_WORLD_HOLE", `grid cell ${key} has no index entry`);
    }
  });

  return [...byKey.values()].sort(compareCellCoords);
}

function parseCellEntry(raw: unknown, index: number): CellIndexEntry {
  const what = `cells[${index}]`;
  const record = asRecord(raw, "E_WORLD_ENTRY", what);
  const keyRaw = record["key"];
  if (typeof keyRaw !== "string") {
    throw streamingError("E_WORLD_KEY", `${what}.key must be a string`);
  }
  const coord = tryParseCellKey(keyRaw);
  if (coord === undefined) {
    throw streamingError("E_WORLD_KEY", `${what}.key is not canonical: ${keyRaw}`);
  }
  const cx = asInt(record["cx"], "E_WORLD_KEY", `${what}.cx`, -2_147_483_648, 2_147_483_647);
  const cy = asInt(record["cy"], "E_WORLD_KEY", `${what}.cy`, -2_147_483_648, 2_147_483_647);
  if (!isI32(cx) || cx !== coord.cx || cy !== coord.cy) {
    throw streamingError(
      "E_WORLD_KEY",
      `${what}.cx/.cy do not match the canonical key ${keyRaw}`,
    );
  }
  const key = formatCellKey(cx, cy);

  const visualUrls = asStringTuple4(record["visualUrls"], `${what}.visualUrls`);
  const visualBytes = asByteTuple4(record["visualBytes"], `${what}.visualBytes`);
  for (let lod = 0; lod < 4; lod += 1) {
    const url = visualUrls[lod] as string;
    const bytes = visualBytes[lod] as number;
    if (url === "") {
      if (bytes !== 0) {
        throw streamingError(
          "E_WORLD_ENTRY",
          `${what}.visualUrls[${lod}] is empty but visualBytes[${lod}] is ${bytes}`,
        );
      }
    } else {
      const reason = validateRelativeCellUrl(url);
      if (reason !== null) {
        throw streamingError(
          "E_WORLD_URL",
          `${what}.visualUrls[${lod}] is invalid (${reason})`,
        );
      }
    }
    if (bytes > (VISUAL_LOD_BYTE_LIMITS[lod] as number)) {
      throw streamingError(
        "E_CELL_SIZE",
        `${what}.visualBytes[${lod}] exceeds the LOD${lod} bake limit`,
      );
    }
  }
  if (visualUrls[3] === "" || visualBytes[3] === 0) {
    throw streamingError("E_WORLD_LOD3", `${what} does not author LOD3`);
  }

  const hasCollision = asBoolean(record["hasCollision"], "E_WORLD_ENTRY", `${what}.hasCollision`);
  const hasNav = asBoolean(record["hasNav"], "E_WORLD_ENTRY", `${what}.hasNav`);
  const simUrl = record["simUrl"];
  if (typeof simUrl !== "string") {
    throw streamingError("E_WORLD_ENTRY", `${what}.simUrl must be a string`);
  }
  if (simUrl === "") {
    if (hasCollision || hasNav) {
      throw streamingError(
        "E_WORLD_ENTRY",
        `${what}.simUrl is empty but the cell declares collision or nav`,
      );
    }
  } else {
    const reason = validateRelativeCellUrl(simUrl);
    if (reason !== null) {
      throw streamingError("E_WORLD_URL", `${what}.simUrl is invalid (${reason})`);
    }
  }
  const simBytes = asInt(
    record["simBytes"],
    "E_WORLD_ENTRY",
    `${what}.simBytes`,
    0,
    SIM_PAYLOAD_BYTE_LIMIT,
  );
  if (simUrl !== "" && simBytes === 0) {
    throw streamingError("E_WORLD_ENTRY", `${what}.simBytes must be positive when simUrl is set`);
  }

  const compressedTotal =
    visualBytes[0] + visualBytes[1] + visualBytes[2] + visualBytes[3] + simBytes;
  if (compressedTotal > STREAMING_LIMITS.maxCellCompressedBytes) {
    throw streamingError(
      "E_CELL_SIZE",
      `${what} declares ${compressedTotal} bytes; the per-cell cap is ${STREAMING_LIMITS.maxCellCompressedBytes}`,
    );
  }

  const contentHash = record["contentHash"];
  if (typeof contentHash !== "string" || !CONTENT_HASH_PATTERN.test(contentHash)) {
    throw streamingError(
      "E_WORLD_ENTRY",
      `${what}.contentHash must match fnv1a32:[0-9a-f]{8}`,
    );
  }

  return {
    key,
    cx,
    cy,
    visualUrls,
    simUrl,
    visualBytes,
    simBytes,
    contentHash,
    hasCollision,
    hasNav,
  };
}

/**
 * Raw-string URL rules (12 §4.1): relative, same-origin, no scheme, no `..`,
 * no query/fragment, no backslash or control bytes. Returns a reason or null.
 */
export function validateRelativeCellUrl(raw: string): string | null {
  if (raw.length === 0) return "url is empty";
  if (raw.length > MAX_CELL_URL_CHARS) {
    return `url exceeds ${MAX_CELL_URL_CHARS} characters`;
  }
  if (raw.includes("\\")) return "url contains a backslash";
  if (raw.includes("?")) return "url contains a query string";
  if (raw.includes("#")) return "url contains a fragment";
  if (raw.includes("//")) return "url contains a double slash";
  if (ENCODED_DOT.test(raw)) return "url contains a percent-encoded dot";
  if (ENCODED_PATH_SEPARATOR.test(raw)) return "url contains an encoded separator";
  if (raw.startsWith("/")) return "url is absolute, not relative";
  if (SCHEME_PREFIX.test(raw)) return "url contains a scheme or host";
  if (CONTROL_CHAR.test(raw)) return "url contains a control character";
  for (const segment of raw.split("/")) {
    if (segment.length === 0) return "url contains an empty segment";
    if (segment === "." || segment === "..") return "url contains a dot segment";
  }
  return null;
}

/**
 * Resolves a validated cell URL against the manifest URL, enforcing the
 * manifest-directory containment and same-origin rules after normalisation.
 */
export function resolveCellUrl(raw: string, manifestUrl: string): string {
  const reason = validateRelativeCellUrl(raw);
  if (reason !== null) {
    throw streamingError("E_WORLD_URL", `invalid cell url (${reason})`);
  }
  const base = new URL(manifestUrl, FALLBACK_ORIGIN);
  if (base.username !== "" || base.password !== "") {
    throw streamingError("E_WORLD_URL", "manifest url contains credentials");
  }
  const resolved = new URL(raw, base);
  if (resolved.origin !== base.origin || resolved.protocol !== base.protocol) {
    throw streamingError("E_WORLD_URL", "cell url is cross-origin");
  }
  const slash = base.pathname.lastIndexOf("/");
  const baseDirectory = base.pathname.slice(0, slash + 1);
  if (!resolved.pathname.startsWith(baseDirectory)) {
    throw streamingError("E_WORLD_URL", "cell url escapes the manifest directory");
  }
  return resolved.href;
}

export interface VisualPayloadRef {
  readonly lod: 0 | 1 | 2 | 3;
  readonly url: string;
  readonly bytes: number;
}

export interface SimPayloadRef {
  readonly url: string;
  readonly bytes: number;
}

/**
 * The runtime manifest index. Entries are held in canonical key order; the
 * flat grid array gives O(1) lookup by cell index (12 §5.10).
 */
export class WorldIndex {
  readonly config: WorldConfig;
  readonly grid: CellGrid;
  /** Canonical order: ascending `(cx, cy)`. */
  readonly cells: readonly CellIndexEntry[];
  readonly manifestUrl: string;
  private readonly byKey = new Map<CellKey, CellIndexEntry>();
  private readonly byGridIndex: (CellIndexEntry | undefined)[];

  constructor(config: WorldConfig, manifestUrl: string) {
    this.config = config;
    this.manifestUrl = manifestUrl;
    this.grid = new CellGrid(config);
    this.cells = [...config.cells].sort(compareCellCoords);
    const slots = new Array<CellIndexEntry | undefined>(this.grid.cellCount);
    for (const entry of this.cells) {
      this.byKey.set(entry.key, entry);
      const index = this.grid.indexOf(entry.cx, entry.cy);
      if (index >= 0) slots[index] = entry;
    }
    this.byGridIndex = slots;
  }

  get cellCount(): number {
    return this.cells.length;
  }

  has(key: CellKey): boolean {
    return this.byKey.has(key);
  }

  entry(key: CellKey): CellIndexEntry | undefined {
    return this.byKey.get(key);
  }

  entryAt(cx: number, cy: number): CellIndexEntry | undefined {
    const index = this.grid.indexOf(cx, cy);
    return index < 0 ? undefined : this.byGridIndex[index];
  }

  entryByGridIndex(index: number): CellIndexEntry | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.byGridIndex.length) {
      return undefined;
    }
    return this.byGridIndex[index];
  }

  keyAt(index: number): CellKey | undefined {
    return this.entryByGridIndex(index)?.key;
  }

  /**
   * URL and byte count for a requested visual LOD. An unauthored LOD
   * substitutes the next coarser authored one and does not fetch it
   * separately (12 §4.1). LOD3 is always authored, so this always resolves
   * for an indexed cell.
   */
  visualPayload(key: CellKey, requestedLod: 0 | 1 | 2 | 3): VisualPayloadRef | undefined {
    const entry = this.byKey.get(key);
    if (entry === undefined) return undefined;
    for (let lod = requestedLod; lod < 4; lod += 1) {
      const url = entry.visualUrls[lod];
      const bytes = entry.visualBytes[lod];
      if (url !== undefined && url !== "" && bytes !== undefined) {
        return {
          lod: lod as 0 | 1 | 2 | 3,
          url: resolveCellUrl(url, this.manifestUrl),
          bytes,
        };
      }
    }
    return undefined;
  }

  simPayload(key: CellKey): SimPayloadRef | undefined {
    const entry = this.byKey.get(key);
    if (entry === undefined || entry.simUrl === "") return undefined;
    return {
      url: resolveCellUrl(entry.simUrl, this.manifestUrl),
      bytes: entry.simBytes,
    };
  }
}

export interface BootBudgetInput {
  /** Measured gzip size of `world.json`. */
  readonly manifestGzipBytes: number;
  /** Measured gzip size of the boot game bundle. */
  readonly gameGzipBytes?: number;
  /** Measured gzip size of the first LOD0 ring payloads. */
  readonly firstRingGzipBytes: number;
}

export interface BootBudgetResult {
  readonly ok: boolean;
  readonly code: "E_WORLD_BUDGET" | null;
  readonly manifestGzipBytes: number;
  readonly bootSetGzipBytes: number;
  readonly manifestLimitBytes: number;
  readonly bootSetLimitBytes: number;
}

/**
 * Boot-budget gate (12 §5.8, SPEC FR-9.6). Inputs are measured gzip sizes
 * supplied by the caller; this function never estimates a compressed size.
 */
export function checkBootBudget(input: BootBudgetInput): BootBudgetResult {
  const manifestGzipBytes = requireMeasured(input.manifestGzipBytes, "manifestGzipBytes");
  const gameGzipBytes = requireMeasured(input.gameGzipBytes ?? 0, "gameGzipBytes");
  const firstRingGzipBytes = requireMeasured(input.firstRingGzipBytes, "firstRingGzipBytes");
  const bootSetGzipBytes = manifestGzipBytes + gameGzipBytes + firstRingGzipBytes;
  const overManifest = manifestGzipBytes > MAX_MANIFEST_GZIP_BYTES;
  const overBoot = bootSetGzipBytes > MAX_BOOT_SET_GZIP_BYTES;
  return {
    ok: !overManifest && !overBoot,
    code: overManifest || overBoot ? "E_WORLD_BUDGET" : null,
    manifestGzipBytes,
    bootSetGzipBytes,
    manifestLimitBytes: MAX_MANIFEST_GZIP_BYTES,
    bootSetLimitBytes: MAX_BOOT_SET_GZIP_BYTES,
  };
}

/** Throws `E_WORLD_BUDGET` when the measured boot set is over budget. */
export function assertBootBudget(input: BootBudgetInput): BootBudgetResult {
  const result = checkBootBudget(input);
  if (!result.ok) {
    throw streamingError(
      "E_WORLD_BUDGET",
      `boot set is ${result.bootSetGzipBytes} bytes gzip; limits are ` +
        `${result.manifestLimitBytes} (manifest) and ${result.bootSetLimitBytes} (boot set)`,
    );
  }
  return result;
}

function requireMeasured(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw streamingError("E_WORLD_BUDGET", `${what} must be a measured non-negative number`);
  }
  return value;
}

function asRecord(value: unknown, code: ManifestCode, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw streamingError(code, `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(
  value: unknown,
  code: "E_WORLD_ENTRY" | "E_WORLD_LOD_BANDS",
  what: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw streamingError(code, `${what} must be an array`);
  }
  return value;
}

function asInt(
  value: unknown,
  code:
    | "E_WORLD_SEED"
    | "E_WORLD_CELL_SIZE"
    | "E_WORLD_GRID"
    | "E_WORLD_KEY"
    | "E_WORLD_ENTRY"
    | "E_WORLD_BUDGET"
    | "E_WORLD_LOD_BANDS",
  what: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw streamingError(code, `${what} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function asFinite(
  value: unknown,
  code: "E_WORLD_FORMAT" | "E_WORLD_LOD_BANDS",
  what: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw streamingError(code, `${what} must be a finite number`);
  }
  return value;
}

function asPositive(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw streamingError("E_WORLD_BUDGET", `${what} must be positive and finite`);
  }
  return value;
}

function asBoolean(
  value: unknown,
  code: "E_WORLD_ENTRY" | "E_WORLD_BUDGET",
  what: string,
): boolean {
  if (typeof value !== "boolean") {
    throw streamingError(code, `${what} must be a boolean`);
  }
  return value;
}

function asStringTuple4(value: unknown, what: string): [string, string, string, string] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw streamingError("E_WORLD_ENTRY", `${what} must contain exactly four strings`);
  }
  const out: [string, string, string, string] = ["", "", "", ""];
  for (let index = 0; index < 4; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      throw streamingError("E_WORLD_ENTRY", `${what}[${index}] must be a string`);
    }
    out[index] = item;
  }
  return out;
}

function asByteTuple4(value: unknown, what: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw streamingError("E_WORLD_ENTRY", `${what} must contain exactly four byte counts`);
  }
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let index = 0; index < 4; index += 1) {
    out[index] = asInt(
      value[index],
      "E_WORLD_ENTRY",
      `${what}[${index}]`,
      0,
      STREAMING_LIMITS.maxCellCompressedBytes,
    );
  }
  return out;
}

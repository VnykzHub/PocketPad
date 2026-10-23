/**
 * `.cell` container validation, section decoding and owner dispatch
 * (spec 12 §4.2, `src/Decode.ts`).
 *
 * This module constructs no `Worker` and never touches `DecompressionStream`:
 * the gzip decoder is injected so the package stays browser-free and testable
 * in Node. Owner parsers (specs 06/07/09/11) are injected as `onSection`;
 * a handler rejection fails the whole cell with `E_CELL_SECTION`, and a
 * partially validated cell is never returned.
 *
 * Validated here: header magic/version/size, cx/cy against the manifest,
 * cell size, kind/lod legality, reserved words, AABB against the manifest
 * bounds (+-0.01 m), section count, table bounds/alignment/overlap, section
 * type vs payload kind, per-section gzip and length, per-section hash, the
 * file-level hash, and the bake-time uncompressed limits. The LOD0/LOD1+
 * batch caps are a property of the mesh section and belong to the spec 06
 * handler, which can reject with `E_CELL_SECTION`.
 */

import { fnv1a32 } from "@lanpad/engine-core";
import type { CellKey } from "./contracts/world.js";
import { CELL_FORMAT_VERSION, STREAMING_LIMITS } from "./contracts/world.js";
import { SIM_PAYLOAD_BYTE_LIMIT, VISUAL_LOD_BYTE_LIMITS } from "./WorldIndex.js";
import { errorMessageOf, streamingError } from "./StreamEvents.js";

export const CELL_CONTAINER_MAGIC = 0x4c43_5050;
export const CELL_HEADER_BYTES = 64;
export const CELL_SECTION_ENTRY_BYTES = 24;
export const CELL_MAX_SECTIONS = 64;
export const CELL_AABB_TOLERANCE_METERS = 0.01;

export const SECTION_TYPE_MESH = 1;
export const SECTION_TYPE_TEXTURE = 2;
export const SECTION_TYPE_COLLISION = 3;
export const SECTION_TYPE_NAVMESH = 4;
export const SECTION_TYPE_SPAWN = 5;
export const SECTION_TYPE_AUDIO = 6;
export const SECTION_TYPE_METADATA = 7;
export const SECTION_TYPE_GAME_MIN = 8;
export const SECTION_TYPE_GAME_MAX = 32767;

export const SECTION_FLAG_GZIP = 0x1;

export const CELL_FLAG_HAS_COLLISION = 0x1;
export const CELL_FLAG_HAS_NAV = 0x2;
export const CELL_FLAG_HAS_AUDIO = 0x4;
export const CELL_FLAG_HAS_SPAWN = 0x8;
export const CELL_FLAG_WATER_VOID = 0x10;
export const CELL_FLAG_GENERATED = 0x20;
const CELL_KNOWN_FLAGS =
  CELL_FLAG_HAS_COLLISION |
  CELL_FLAG_HAS_NAV |
  CELL_FLAG_HAS_AUDIO |
  CELL_FLAG_HAS_SPAWN |
  CELL_FLAG_WATER_VOID |
  CELL_FLAG_GENERATED;

/** Injected gzip decoder; the runtime supplies `DecompressionStream`. */
export type GzipDecoder = (bytes: Uint8Array) => Promise<Uint8Array>;

export interface CellAabb {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface CellContainerHeader {
  readonly contentHash: number;
  readonly cx: number;
  readonly cy: number;
  readonly cellSizeCm: number;
  readonly kind: 0 | 1;
  /** 0..3 for visual, 0xFF for simulation. */
  readonly lod: number;
  readonly uncompressedBytes: number;
  readonly sectionCount: number;
  readonly aabb: CellAabb;
  readonly flags: number;
}

export interface DecodedSection {
  readonly type: number;
  readonly flags: number;
  readonly sectionVersion: number;
  /** Uncompressed bytes; owned by the caller after decode. */
  readonly bytes: Uint8Array;
  readonly hash: number;
}

export interface DecodedCell {
  readonly header: CellContainerHeader;
  readonly sections: readonly DecodedSection[];
}

export interface DecodeCellContext {
  readonly cellSizeMeters: number;
  readonly expectedCx: number;
  readonly expectedCy: number;
  /** Manifest cell bounds; XZ must match the container AABB within 0.01 m. */
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
  readonly decodeGzip: GzipDecoder;
  /** Optional cross-checks against the manifest entry's flags. */
  readonly expectedHasCollision?: boolean;
  readonly expectedHasNav?: boolean;
  /** Owner parser dispatch, called in section-table order after validation. */
  readonly onSection?: (
    section: DecodedSection,
    header: CellContainerHeader,
  ) => void | Promise<void>;
}

interface RawSection {
  readonly type: number;
  readonly flags: number;
  readonly offset: number;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly sectionVersion: number;
  readonly hash: number;
}

/** Decodes and validates one `.cell` file; never returns a partial result. */
export async function decodeCell(
  bytes: ArrayBuffer,
  context: DecodeCellContext,
): Promise<DecodedCell> {
  if (!(bytes instanceof ArrayBuffer)) {
    throw streamingError("E_CELL_FORMAT", ".cell payload must be an ArrayBuffer");
  }
  if (bytes.byteLength > STREAMING_LIMITS.maxCellCompressedBytes) {
    throw streamingError("E_CELL_SIZE", ".cell file exceeds maxCellCompressedBytes");
  }
  if (bytes.byteLength < CELL_HEADER_BYTES) {
    throw streamingError("E_CELL_FORMAT", ".cell file is shorter than its header");
  }
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== CELL_CONTAINER_MAGIC) {
    throw streamingError("E_CELL_FORMAT", ".cell magic mismatch");
  }
  if (view.getUint16(4, true) !== CELL_FORMAT_VERSION) {
    throw streamingError("E_CELL_FORMAT", "unsupported .cell formatVersion");
  }
  if (view.getUint16(6, true) !== CELL_HEADER_BYTES) {
    throw streamingError("E_CELL_FORMAT", ".cell headerBytes must be 64");
  }
  const contentHash = view.getUint32(8, true);
  const cx = view.getInt32(12, true);
  const cy = view.getInt32(16, true);
  if (cx !== context.expectedCx || cy !== context.expectedCy) {
    throw streamingError(
      "E_CELL_FORMAT",
      `.cell coordinates (${cx},${cy}) do not match the manifest`,
    );
  }
  const expectedCellSizeCm = context.cellSizeMeters * 100;
  const cellSizeCm = view.getUint16(20, true);
  if (cellSizeCm < 1_600 || cellSizeCm > 51_200 || cellSizeCm !== expectedCellSizeCm) {
    throw streamingError("E_CELL_FORMAT", ".cell cellSizeCm does not match the world");
  }
  const kindByte = view.getUint8(22);
  const lodByte = view.getUint8(23);
  if (kindByte !== 0 && kindByte !== 1) {
    throw streamingError("E_CELL_KIND", `.cell kind ${kindByte} is not 0 or 1`);
  }
  const kind = kindByte as 0 | 1;
  if (kind === 0) {
    if (lodByte > 3) {
      throw streamingError("E_CELL_KIND", `.cell visual lod ${lodByte} is not 0..3`);
    }
  } else if (lodByte !== 0xff) {
    throw streamingError("E_CELL_KIND", ".cell simulation lod must be 0xFF");
  }
  const uncompressedBytes = view.getUint32(24, true);
  const sectionCount = view.getUint32(28, true);
  if (sectionCount > CELL_MAX_SECTIONS) {
    throw streamingError(
      "E_CELL_SECTION",
      `.cell declares ${sectionCount} sections; cap is 64`,
    );
  }
  const aabb: CellAabb = {
    minX: requireFinite(view.getFloat32(32, true), "aabb.minX"),
    minY: requireFinite(view.getFloat32(36, true), "aabb.minY"),
    minZ: requireFinite(view.getFloat32(40, true), "aabb.minZ"),
    maxX: requireFinite(view.getFloat32(44, true), "aabb.maxX"),
    maxY: requireFinite(view.getFloat32(48, true), "aabb.maxY"),
    maxZ: requireFinite(view.getFloat32(52, true), "aabb.maxZ"),
  };
  assertAabbWithin(aabb, context.bounds);
  const flags = view.getUint32(56, true);
  if ((flags & ~CELL_KNOWN_FLAGS) !== 0) {
    throw streamingError("E_CELL_FORMAT", ".cell has unknown header flag bits");
  }
  if (view.getUint32(60, true) !== 0) {
    throw streamingError("E_CELL_FORMAT", ".cell reserved header word must be zero");
  }
  if (context.expectedHasCollision !== undefined) {
    const hasCollision = (flags & CELL_FLAG_HAS_COLLISION) !== 0;
    if (hasCollision !== context.expectedHasCollision) {
      throw streamingError(
        "E_CELL_KIND",
        ".cell collision flag disagrees with the manifest",
      );
    }
  }
  if (context.expectedHasNav !== undefined) {
    const hasNav = (flags & CELL_FLAG_HAS_NAV) !== 0;
    if (hasNav !== context.expectedHasNav) {
      throw streamingError("E_CELL_KIND", ".cell nav flag disagrees with the manifest");
    }
  }

  const byteLimit =
    kind === 0 ? (VISUAL_LOD_BYTE_LIMITS[lodByte] ?? 0) : SIM_PAYLOAD_BYTE_LIMIT;
  if (uncompressedBytes > byteLimit) {
    throw streamingError(
      "E_CELL_SIZE",
      `.cell declares ${uncompressedBytes} uncompressed bytes; the limit is ${byteLimit}`,
    );
  }

  const tableEnd = CELL_HEADER_BYTES + CELL_SECTION_ENTRY_BYTES * sectionCount;
  if (tableEnd > bytes.byteLength) {
    throw streamingError("E_CELL_SECTION", ".cell section table runs past the file");
  }

  const rawSections: RawSection[] = [];
  let declaredUncompressed = 0;
  for (let index = 0; index < sectionCount; index += 1) {
    const base = CELL_HEADER_BYTES + index * CELL_SECTION_ENTRY_BYTES;
    const type = view.getUint16(base, true);
    const sectionFlags = view.getUint16(base + 2, true);
    const offset = view.getUint32(base + 4, true);
    const compressedBytes = view.getUint32(base + 8, true);
    const sectionUncompressed = view.getUint32(base + 12, true);
    const sectionVersion = view.getUint16(base + 16, true);
    const reserved = view.getUint16(base + 18, true);
    const hash = view.getUint32(base + 20, true);

    if (type === 0 || type > SECTION_TYPE_GAME_MAX) {
      throw streamingError(
        "E_CELL_SECTION",
        `.cell section type ${type} is not decodable`,
      );
    }
    if ((sectionFlags & ~SECTION_FLAG_GZIP) !== 0) {
      throw streamingError(
        "E_CELL_SECTION",
        `.cell section ${index} has unknown flag bits`,
      );
    }
    if (reserved !== 0) {
      throw streamingError(
        "E_CELL_SECTION",
        `.cell section ${index} reserved word must be zero`,
      );
    }
    if (offset % 4 !== 0) {
      throw streamingError(
        "E_CELL_SECTION",
        `.cell section ${index} offset is not 4-aligned`,
      );
    }
    if (offset < tableEnd || offset + compressedBytes > bytes.byteLength) {
      throw streamingError(
        "E_CELL_SECTION",
        `.cell section ${index} lies outside the file`,
      );
    }
    if (kind === 0 && (type === SECTION_TYPE_COLLISION || type === SECTION_TYPE_NAVMESH)) {
      throw streamingError(
        "E_CELL_KIND",
        `.cell visual payload has a simulation section ${type}`,
      );
    }
    if (kind === 1 && (type === SECTION_TYPE_MESH || type === SECTION_TYPE_TEXTURE)) {
      throw streamingError(
        "E_CELL_KIND",
        `.cell simulation payload has a visual section ${type}`,
      );
    }
    declaredUncompressed += sectionUncompressed;
    rawSections.push({
      type,
      flags: sectionFlags,
      offset,
      compressedBytes,
      uncompressedBytes: sectionUncompressed,
      sectionVersion,
      hash,
    });
  }
  if (declaredUncompressed !== uncompressedBytes) {
    throw streamingError(
      "E_CELL_FORMAT",
      `.cell uncompressedBytes ${uncompressedBytes} does not match the section sum ${declaredUncompressed}`,
    );
  }

  // Ranges must not overlap; sorting by offset gives the check in O(n log n).
  const ranges = rawSections
    .filter((section) => section.compressedBytes > 0)
    .map((section) => ({
      start: section.offset,
      end: section.offset + section.compressedBytes,
    }))
    .sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous === undefined || current === undefined) continue;
    if (current.start < previous.end) {
      throw streamingError("E_CELL_SECTION", ".cell sections overlap");
    }
  }

  const decoded: DecodedSection[] = [];
  const concatenated = new Uint8Array(uncompressedBytes);
  let concatenatedCursor = 0;
  for (const raw of rawSections) {
    const compressed = new Uint8Array(bytes, raw.offset, raw.compressedBytes);
    let sectionBytes: Uint8Array;
    if ((raw.flags & SECTION_FLAG_GZIP) !== 0) {
      try {
        sectionBytes = await context.decodeGzip(compressed);
      } catch (error) {
        throw streamingError(
          "E_STREAM_DECOMPRESS",
          `.cell section ${raw.type} failed to gunzip: ${errorMessageOf(error)}`,
        );
      }
      if (sectionBytes.length !== raw.uncompressedBytes) {
        throw streamingError(
          "E_STREAM_DECOMPRESS",
          `.cell section ${raw.type} decoded to ${sectionBytes.length} bytes, expected ${raw.uncompressedBytes}`,
        );
      }
    } else {
      if (raw.compressedBytes !== raw.uncompressedBytes) {
        throw streamingError(
          "E_CELL_SIZE",
          `.cell section ${raw.type} is not gzip but its sizes differ`,
        );
      }
      sectionBytes = compressed.slice();
    }
    if (fnv1a32(sectionBytes) !== raw.hash) {
      throw streamingError("E_CELL_HASH", `.cell section ${raw.type} hash mismatch`);
    }
    concatenated.set(sectionBytes, concatenatedCursor);
    concatenatedCursor += sectionBytes.length;
    decoded.push({
      type: raw.type,
      flags: raw.flags,
      sectionVersion: raw.sectionVersion,
      bytes: sectionBytes,
      hash: raw.hash,
    });
  }
  if (concatenatedCursor !== uncompressedBytes) {
    throw streamingError("E_CELL_FORMAT", ".cell uncompressed sizes do not add up");
  }
  if (fnv1a32(concatenated) !== contentHash) {
    throw streamingError("E_CELL_HASH", ".cell file content hash mismatch");
  }

  const header: CellContainerHeader = {
    contentHash,
    cx,
    cy,
    cellSizeCm,
    kind,
    lod: lodByte,
    uncompressedBytes,
    sectionCount,
    aabb,
    flags,
  };

  if (context.onSection !== undefined) {
    for (const section of decoded) {
      try {
        await context.onSection(section, header);
      } catch (error) {
        throw streamingError(
          "E_CELL_SECTION",
          `.cell section type ${section.type} was rejected: ${errorMessageOf(error)}`,
        );
      }
    }
  }

  return { header, sections: decoded };
}

/**
 * The manifest `contentHash` from 12 §4.1:
 * `fnv1a32(UTF8(key) || 0x00 || h0 || h1 || h2 || h3 || hs)`, each hash as
 * four little-endian bytes. An unauthored LOD passes 0.
 */
export function compositeContentHash(
  key: CellKey,
  visualHashes: readonly [number, number, number, number],
  simHash: number,
): string {
  const keyBytes = new TextEncoder().encode(key);
  const target = new Uint8Array(keyBytes.length + 1 + 5 * 4);
  target.set(keyBytes, 0);
  target[keyBytes.length] = 0;
  const view = new DataView(target.buffer);
  let cursor = keyBytes.length + 1;
  for (const hash of visualHashes) {
    view.setUint32(cursor, requireU32(hash), true);
    cursor += 4;
  }
  view.setUint32(cursor, requireU32(simHash), true);
  return `fnv1a32:${fnv1a32(target).toString(16).padStart(8, "0")}`;
}

function assertAabbWithin(
  aabb: CellAabb,
  bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  },
): void {
  if (
    Math.abs(aabb.minX - bounds.minX) > CELL_AABB_TOLERANCE_METERS ||
    Math.abs(aabb.maxX - bounds.maxX) > CELL_AABB_TOLERANCE_METERS ||
    Math.abs(aabb.minZ - bounds.minZ) > CELL_AABB_TOLERANCE_METERS ||
    Math.abs(aabb.maxZ - bounds.maxZ) > CELL_AABB_TOLERANCE_METERS
  ) {
    throw streamingError(
      "E_CELL_FORMAT",
      ".cell AABB does not match the manifest cell bounds",
    );
  }
  if (aabb.minX > aabb.maxX || aabb.minY > aabb.maxY || aabb.minZ > aabb.maxZ) {
    throw streamingError("E_CELL_FORMAT", ".cell AABB is inverted");
  }
}

function requireFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw streamingError("E_CELL_FORMAT", `${what} must be finite`);
  }
  return value;
}

function requireU32(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw streamingError("E_CELL_HASH", "content hash components must be u32 integers");
  }
  return value;
}

#!/usr/bin/env node
/**
 * Deterministic fixture builder for spec 12 acceptance (ER-12-01/02/03/06/07/08/11).
 *
 * Run from the package root:
 *
 *     node test/fixtures/build-world.mjs
 *
 * The output is checked in; CI compares against it instead of regenerating
 * silently (12 §8). Every byte is derived from the constants below, so two
 * runs on any machine produce identical files.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = here;

// ---------------------------------------------------------------- helpers

/** FNV-1a 32-bit, matching `fnv1a32` in @lanpad/engine-core. */
function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function hashOfKey(key) {
  const bytes = new TextEncoder().encode(key);
  return `fnv1a32:${fnv1a32(bytes).toString(16).padStart(8, "0")}`;
}

function writeJson(name, value) {
  const path = join(fixtures, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function writeBytes(name, bytes) {
  const path = join(fixtures, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

const DEFAULT_LOD_BANDS = [
  { lod: 0, maxDistanceMeters: 96, hysteresisMeters: 8 },
  { lod: 1, maxDistanceMeters: 160, hysteresisMeters: 12 },
  { lod: 2, maxDistanceMeters: 256, hysteresisMeters: 16 },
  { lod: 3, maxDistanceMeters: 384, hysteresisMeters: 24 },
];

const DEFAULT_BUDGETS = {
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
};

function cellEntry(cx, cy, overrides = {}) {
  const prefix = `cells/${cx}_${cy}`;
  return {
    key: `${cx},${cy}`,
    cx,
    cy,
    visualUrls: [
      `${prefix}_l0.cell`,
      `${prefix}_l1.cell`,
      `${prefix}_l2.cell`,
      `${prefix}_l3.cell`,
    ],
    simUrl: `${prefix}_sim.cell`,
    visualBytes: [512, 384, 256, 128],
    simBytes: 256,
    contentHash: hashOfKey(`${cx},${cy}`),
    hasCollision: true,
    hasNav: true,
    ...overrides,
  };
}

function world({ worldId, grid, cells, lodBands = DEFAULT_LOD_BANDS, budgets = DEFAULT_BUDGETS }) {
  return {
    formatVersion: 1,
    worldId,
    seed: 0x5eed1234,
    cellSizeMeters: 64,
    origin: { x: 0, y: 0, z: 0 },
    grid,
    lodBands,
    budgets,
    cells,
  };
}

// ------------------------------------------------- 64x64 manifest (ER-12-01)

const SIZE = 64;
const cells64 = [];
for (let cx = 0; cx < SIZE; cx += 1) {
  for (let cy = 0; cy < SIZE; cy += 1) {
    cells64.push(cellEntry(cx, cy));
  }
}
const world64 = world({
  worldId: "fixture-city-64",
  grid: { minX: 0, minY: 0, maxX: SIZE - 1, maxY: SIZE - 1 },
  cells: cells64,
});
writeJson("world-64x64.world.json", world64);

// ------------------------------------------------------ invalid manifests

const oneCell = [cellEntry(0, 0)];
const singleGrid = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

writeJson(
  "invalid/bad-key-plus.world.json",
  world({ worldId: "bad-key-plus", grid: singleGrid, cells: [cellEntry(0, 0, { key: "+0,0" })] }),
);
writeJson(
  "invalid/bad-key-leading-zero.world.json",
  world({
    worldId: "bad-key-leading-zero",
    grid: singleGrid,
    cells: [cellEntry(0, 0, { key: "00,0" })],
  }),
);
writeJson(
  "invalid/bad-key-negative-zero.world.json",
  world({
    worldId: "bad-key-negative-zero",
    grid: singleGrid,
    cells: [cellEntry(0, 0, { key: "-0,0" })],
  }),
);
writeJson(
  "invalid/duplicate.world.json",
  world({ worldId: "duplicate", grid: singleGrid, cells: [...oneCell, ...oneCell] }),
);
writeJson(
  "invalid/hole.world.json",
  world({
    worldId: "hole",
    grid: { minX: 0, minY: 0, maxX: 1, maxY: 0 },
    cells: oneCell,
  }),
);
writeJson(
  "invalid/url-dotdot.world.json",
  world({
    worldId: "url-dotdot",
    grid: singleGrid,
    cells: [
      cellEntry(0, 0, {
        visualUrls: ["../escape_l0.cell", "0_0_l1.cell", "0_0_l2.cell", "0_0_l3.cell"],
      }),
    ],
  }),
);
writeJson(
  "invalid/url-scheme.world.json",
  world({
    worldId: "url-scheme",
    grid: singleGrid,
    cells: [
      cellEntry(0, 0, {
        visualUrls: [
          "https://evil.example/0_0_l0.cell",
          "0_0_l1.cell",
          "0_0_l2.cell",
          "0_0_l3.cell",
        ],
      }),
    ],
  }),
);
writeJson(
  "invalid/missing-lod3.world.json",
  world({
    worldId: "missing-lod3",
    grid: singleGrid,
    cells: [
      cellEntry(0, 0, {
        visualUrls: ["0_0_l0.cell", "0_0_l1.cell", "0_0_l2.cell", ""],
        visualBytes: [512, 384, 256, 0],
      }),
    ],
  }),
);
writeJson(
  "invalid/grid-too-large.world.json",
  world({
    worldId: "grid-too-large",
    grid: { minX: 0, minY: 0, maxX: 128, maxY: 129 },
    cells: oneCell,
  }),
);

// ------------------------------------------------------- drive fixtures

writeJson("drive-path-4_8km.json", {
  name: "drive-path-4_8km",
  ticks: 7200,
  warmupTicks: 600,
  tickHz: 60,
  speedMps: 40,
  start: { x: 100, y: 0, z: 100 },
  heading: { x: 1, y: 0, z: 0 },
  cameraHalfFovRad: 0.6,
});

writeJson("source-latency.json", {
  name: "source-latency",
  p50Ms: 40,
  p95Ms: 120,
  seed: 123456789,
});

writeJson("pressure-run.json", {
  name: "pressure-run",
  ticks: 10000,
  demandMultiplier: 5,
  focusStepMeters: 16,
  start: { x: 0, y: 0, z: 0 },
});

writeJson("lod-oscillation.json", {
  name: "lod-oscillation",
  ticks: 600,
  amplitudeMeters: 2,
  boundariesMeters: [96, 160, 256],
  cellSizeMeters: 64,
});

const players = [
  { x: 120, z: 120 },
  { x: -120, z: 120 },
  { x: 120, z: -120 },
  { x: -120, z: -120 },
  { x: 900, z: 0 },
  { x: -900, z: 0 },
  { x: 0, z: 900 },
  { x: 0, z: -900 },
];
writeJson("focus-8p.json", {
  name: "focus-8p",
  players,
  camera: { x: 0, y: 0, z: 0, forwardX: 1, forwardZ: 0 },
  distantRadiusMeters: 400,
});

writeJson("focus-jumps-100.json", {
  name: "focus-jumps-100",
  ticks: 600,
  jumps: 100,
  stepMeters: 512,
  start: { x: 0, y: 0, z: 0 },
});

// --------------------------------------------------- invalid .cell files

const CELL_MAGIC = 0x4c43_5050;
const CELL_HEADER = 64;
const SECTION_ENTRY = 24;

function buildCell({
  cx = 0,
  cy = 0,
  cellSizeCm = 6400,
  kind = 0,
  lod = 0,
  sections,
  magic = CELL_MAGIC,
  version = 1,
  headerBytes = CELL_HEADER,
  contentHash,
  aabb = { minX: 0, minY: 0, minZ: 0, maxX: 64, maxY: 8, maxZ: 64 },
  flags = 0,
  sectionOffsetAdjust = 0,
}) {
  const tableEnd = headerBytes + SECTION_ENTRY * sections.length;
  const padded = tableEnd + ((4 - (tableEnd % 4)) % 4);
  let total = padded;
  const offsets = [];
  for (const section of sections) {
    total += (4 - (total % 4)) % 4;
    offsets.push(total + sectionOffsetAdjust);
    total += section.bytes.length;
  }
  // A deliberately misaligned fixture shifts its payloads past the aligned
  // end; allocate the extra bytes so the write itself stays in bounds.
  total += Math.max(0, sectionOffsetAdjust);
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, magic, true);
  view.setUint16(4, version, true);
  view.setUint16(6, headerBytes, true);
  const uncompressed = sections.reduce((sum, section) => sum + section.bytes.length, 0);
  const concatenated = new Uint8Array(uncompressed);
  let cursor = 0;
  for (const section of sections) {
    concatenated.set(section.bytes, cursor);
    cursor += section.bytes.length;
  }
  view.setUint32(8, contentHash ?? fnv1a32(concatenated), true);
  view.setInt32(12, cx, true);
  view.setInt32(16, cy, true);
  view.setUint16(20, cellSizeCm, true);
  view.setUint8(22, kind);
  view.setUint8(23, lod);
  view.setUint32(24, uncompressed, true);
  view.setUint32(28, sections.length, true);
  view.setFloat32(32, aabb.minX, true);
  view.setFloat32(36, aabb.minY, true);
  view.setFloat32(40, aabb.minZ, true);
  view.setFloat32(44, aabb.maxX, true);
  view.setFloat32(48, aabb.maxY, true);
  view.setFloat32(52, aabb.maxZ, true);
  view.setUint32(56, flags, true);
  view.setUint32(60, 0, true);
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    const base = headerBytes + index * SECTION_ENTRY;
    view.setUint16(base, section.type, true);
    view.setUint16(base + 2, 0, true);
    view.setUint32(base + 4, offsets[index], true);
    view.setUint32(base + 8, section.bytes.length, true);
    view.setUint32(base + 12, section.bytes.length, true);
    view.setUint16(base + 16, 1, true);
    view.setUint16(base + 18, 0, true);
    view.setUint32(base + 20, fnv1a32(section.bytes), true);
    bytes.set(section.bytes, offsets[index]);
  }
  return bytes;
}

const mesh = new Uint8Array(16);
for (let i = 0; i < mesh.length; i += 1) mesh[i] = i + 1;

writeBytes(
  "invalid/bad-magic.cell",
  buildCell({ magic: 0x4c43_5051, sections: [{ type: 1, bytes: mesh }] }),
);
writeBytes("invalid/bad-version.cell", buildCell({ version: 2, sections: [{ type: 1, bytes: mesh }] }));
writeBytes(
  "invalid/bad-alignment.cell",
  buildCell({
    sectionOffsetAdjust: 1,
    sections: [
      { type: 1, bytes: mesh },
      { type: 2, bytes: new Uint8Array([9, 9, 9, 9]) },
    ],
  }),
);
writeBytes(
  "invalid/bad-overlap.cell",
  (() => {
    // The second section's declared offset points into the first section's
    // range; each section hash still matches its own bytes.
    const bytes = buildCell({
      sections: [
        { type: 1, bytes: mesh },
        { type: 2, bytes: new Uint8Array([7, 7, 7, 7]) },
      ],
    });
    const view = new DataView(bytes.buffer);
    const second = CELL_HEADER + SECTION_ENTRY;
    view.setUint32(second + 4, CELL_HEADER + SECTION_ENTRY * 2, true);
    return bytes;
  })(),
);
writeBytes(
  "invalid/bad-hash.cell",
  buildCell({ contentHash: 0xdead_beef, sections: [{ type: 1, bytes: mesh }] }),
);
writeBytes(
  "invalid/bad-size.cell",
  (() => {
    const bytes = buildCell({ sections: [{ type: 1, bytes: mesh }] });
    const view = new DataView(bytes.buffer);
    view.setUint32(24, 2 * 1024 * 1024, true);
    return bytes;
  })(),
);
writeBytes("invalid/bad-kind.cell", buildCell({ kind: 2, sections: [{ type: 1, bytes: mesh }] }));
writeBytes(
  "invalid/bad-lod.cell",
  buildCell({ kind: 1, lod: 0, sections: [{ type: 3, bytes: mesh }], flags: 0x1 }),
);

writeBytes("golden/cell-0-0-lod0.cell", buildCell({ sections: [{ type: 1, bytes: mesh }] }));
writeBytes(
  "golden/cell-0-0-sim.cell",
  buildCell({ kind: 1, lod: 0xff, sections: [{ type: 3, bytes: mesh }], flags: 0x1 }),
);

// ------------------------------------------------------ state-hash golden

// ER-12-09 hashes are produced by the CSTR codec and checked in by
// `test/unit/stateStore.test.ts`; re-running this script must not wipe them.
// The fixture is compared against the codec, never regenerated at test time.
let previousHashes = {};
try {
  previousHashes = JSON.parse(readFileSync(join(fixtures, "golden/state-hash.json"), "utf8"));
} catch {
  previousHashes = {};
}
const goldenState = {
  note: "FNV-1a 32 over the CSTR payload of the ER-12-09 deterministic fixture; checked in, never regenerated at test time",
  formatVersion: 1,
  seed: 0x5eed1234,
  cells: 4096,
  sparseHash: previousHashes.sparseHash ?? null,
  sparseHashHex: previousHashes.sparseHashHex ?? null,
  denseHash: previousHashes.denseHash ?? null,
  denseHashHex: previousHashes.denseHashHex ?? null,
  recipe: previousHashes.recipe ?? null,
};
writeJson("golden/state-hash.json", goldenState);

console.log(
  `wrote world-64x64.world.json (${cells64.length} cells), 9 invalid manifests, ` +
    `8 invalid .cell files, 2 golden .cell files, 7 scenario fixtures`,
);

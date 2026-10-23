/**
 * Regenerates the spec-23 fixture game used by the runtime asset/audio tests.
 *
 * Run from the repo root:
 *   node packages/runtime/test/assets/fixtures/generate-fixtures.mjs
 *
 * The GLB is built by hand (a minimal triangle) so it has no toolchain
 * dependency. The OGG is a 0.25 s 440 Hz sine encoded with ffmpeg/libvorbis;
 * set FFMPEG to override the executable path. Every declared byte count is
 * computed from the files written here, so `assets.json` cannot drift.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const gameDir = join(root, "fixture-game");
const filesDir = join(gameDir, "files");
mkdirSync(filesDir, { recursive: true });

const glbPath = join(filesDir, "triangle.glb");
const oggPath = join(filesDir, "hit.ogg");
const jsonPath = join(filesDir, "arena.json");

function buildTriangleGlb() {
  const json = {
    asset: { version: "2.0", generator: "pocketpad-fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0 }, indices: 1, mode: 4 },
        ],
      },
    ],
    buffers: [{ byteLength: 42 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      {
        bufferView: 1,
        componentType: 5123,
        count: 3,
        type: "SCALAR",
      },
    ],
  };

  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);

  const bin = Buffer.alloc(44);
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  Buffer.from(
    positions.buffer,
    positions.byteOffset,
    positions.byteLength,
  ).copy(bin, 0);
  bin.writeUInt16LE(0, 36);
  bin.writeUInt16LE(1, 38);
  bin.writeUInt16LE(2, 40);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // "BIN\0"

  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, bin]);
}

function encodeOgg() {
  const candidates = [
    process.env["FFMPEG"],
    "C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
    "ffmpeg",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const ffmpeg of candidates) {
    const result = spawnSync(
      ffmpeg,
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.25",
        "-c:a",
        "libvorbis",
        "-q:a",
        "2",
        oggPath,
      ],
      { stdio: "inherit" },
    );
    if (result.status === 0) return;
  }
  throw new Error("ffmpeg with libvorbis is required to generate hit.ogg");
}

writeFileSync(glbPath, buildTriangleGlb());
encodeOgg();
// No trailing newline: this file is byte-checked against assets.json, and a
// CRLF checkout would otherwise grow it by one byte.
writeFileSync(jsonPath, '{"name":"arena","columns":3}');

const triangleBytes = statSync(glbPath).size;
const hitBytes = statSync(oggPath).size;
const arenaBytes = statSync(jsonPath).size;

writeFileSync(
  join(gameDir, "LICENSES.csv"),
  [
    "file,source,author,licence,date,attribution",
    "triangle.glb,synthetic,fixture generator,CC0,2026-10-23,Minimal test triangle",
    "hit.ogg,ffmpeg sine,fixture generator,CC0,2026-10-23,0.25 s 440 Hz test tone",
    "arena.json,synthetic,fixture generator,CC0,2026-10-23,Test JSON payload",
    "",
  ].join("\n"),
);

const assets = {
  schemaVersion: 1,
  groups: [
    { id: "boot", mode: "eager" },
    { id: "arena", mode: "lazy" },
  ],
  assets: [
    {
      id: "triangle",
      path: "files/triangle.glb",
      kind: "mesh",
      bytes: triangleBytes,
      group: "boot",
      ledger: "triangle.glb",
    },
    {
      id: "hit",
      path: "files/hit.ogg",
      kind: "audio",
      bytes: hitBytes,
      group: "boot",
      ledger: "hit.ogg",
    },
    {
      id: "music",
      path: "files/hit.ogg",
      kind: "audio",
      bytes: hitBytes,
      group: "boot",
      ledger: "hit.ogg",
    },
    {
      id: "arena-data",
      path: "files/arena.json",
      kind: "json",
      bytes: arenaBytes,
      group: "arena",
      ledger: "arena.json",
    },
    {
      id: "arena-music",
      path: "files/hit.ogg",
      kind: "audio",
      bytes: hitBytes,
      group: "arena",
      ledger: "hit.ogg",
    },
  ],
};
writeFileSync(
  join(gameDir, "assets.json"),
  `${JSON.stringify(assets, null, 2)}\n`,
);

writeFileSync(
  join(gameDir, "layout.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      id: "fixture-v1",
      orientation: "any",
      background: "#101820",
      controls: [
        {
          id: "action",
          type: "button",
          label: "Hit",
          shape: "circle",
          x: "50%",
          y: "80%",
          r: "12%",
          bit: 0,
        },
      ],
    },
    null,
    2,
  )}\n`,
);

const manifest = {
  schemaVersion: 1,
  name: "Fixture Game",
  description: "Runtime asset and audio fixture for spec 23.",
  entry: "game.js",
  layouts: ["layout.json"],
  assetBudget: { initialBytes: 65536, totalBytes: 131072 },
  minPlayers: 1,
  maxPlayers: 2,
  needsGyro: false,
};
writeFileSync(
  join(gameDir, "game.manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

writeFileSync(
  join(gameDir, "game.js"),
  [
    "export default function createFixtureGame(manifest) {",
    "  return {",
    "    manifest,",
    "    init() {},",
    "    simulate() {},",
    "    render() {},",
    "    dispose() {},",
    "  };",
    "}",
    "",
  ].join("\n"),
);

console.log(
  `fixture game written: triangle.glb ${triangleBytes} B, hit.ogg ${hitBytes} B, arena.json ${arenaBytes} B`,
);

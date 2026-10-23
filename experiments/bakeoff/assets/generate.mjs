#!/usr/bin/env node
/**
 * Generates the shared bake-off assets.
 *
 * Ground, building, facade and layout are generated in-repo. The character and
 * vehicle are derived from the CC0 packs in Game-assets/ (see LICENSES.csv):
 *   ped.glb  Quaternius Universal Animation Library, trimmed to Walk_Loop
 *   car.glb  Kenney Car Kit sedan, wheels renamed wheel-fl/fr/rl/rr
 *
 * Outputs:
 *   ground.glb    192 x 192 m plane at y = 0
 *   building.glb  8 x 8 x 1 m box, base at y = 0, facade texture embedded
 *   car.glb       body + four wheel nodes named wheel-fl/fr/rl/rr
 *   ped.glb       65-joint skinned mesh with an in-place "walk" clip
 *   facade.png    256 x 256 generated facade texture
 *   layout.json   14 buildings, 50 pedestrians, car, camera path
 *   LICENSES.csv  one row per shipped file
 *   MANIFEST.json byte sizes, SHA-256 and verification results
 *
 * Run: npm install && npm run generate
 *      (from experiments/bakeoff/assets; requires ../../../Game-assets)
 *
 * @gltf-transform/core derives and re-reads the packed assets;
 * @gltf-transform/functions prunes the 42 unused animation clips from the UAL
 * source so the checked-in pedestrian stays under the 5 MiB asset budget.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { NodeIO } from "@gltf-transform/core";
import { prune } from "@gltf-transform/functions";

const ASSET_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(ASSET_DIR, "..", "..", "..");
const UAL_SOURCE = path.join(
  REPO_ROOT,
  "Game-assets",
  "Universal Animation Library[Standard]",
  "Unreal-Godot",
  "UAL1_Standard.glb",
);
const KENNEY_CAR_SOURCE = path.join(
  REPO_ROOT,
  "Game-assets",
  "kenney_car-kit",
  "Models",
  "GLB format",
  "sedan.glb",
);
const UAL_SOURCE_LABEL =
  "Game-assets/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb";
const KENNEY_CAR_SOURCE_LABEL =
  "Game-assets/kenney_car-kit/Models/GLB format/sedan.glb (+ Textures/colormap.png)";
const GENERATOR = "PocketPad bake-off generator (generate.mjs)";
const DATE = "2026-10-23";
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const TRIANGLES = 4;
const REPEAT = 10497;
const LINEAR = 9729;
const LINEAR_MIPMAP_LINEAR = 9987;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function round2(value) {
  return Math.round(value * 100) / 100;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function floatBuffer(values) {
  return Buffer.from(new Float32Array(values).buffer);
}

function u16Buffer(values) {
  return Buffer.from(new Uint16Array(values).buffer);
}

function u8Buffer(values) {
  return Buffer.from(new Uint8Array(values).buffer);
}

function minMax(vectors, stride = 3) {
  const minimum = new Array(stride).fill(Infinity);
  const maximum = new Array(stride).fill(-Infinity);
  for (let i = 0; i < vectors.length; i += stride) {
    for (let c = 0; c < stride; c += 1) {
      minimum[c] = Math.min(minimum[c], vectors[i + c]);
      maximum[c] = Math.max(maximum[c], vectors[i + c]);
    }
  }
  return { min: minimum, max: maximum };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// PNG writer + reader (zlib + CRC, no external image library)
// ---------------------------------------------------------------------------

let crcTable = null;

function crc32(buffer) {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "latin1");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePngRgb(width, height, rgb) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodeAndCheckPng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(
    bytes.subarray(0, 8),
    signature,
    "facade.png does not start with the PNG signature",
  );
  let offset = 8;
  let header = null;
  const idat = [];
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    assert(dataEnd + 4 <= bytes.length, `facade.png has a truncated ${type} chunk`);
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    const actualCrc = crc32(bytes.subarray(offset + 4, dataEnd));
    assert.equal(actualCrc, expectedCrc, `facade.png ${type} CRC mismatch`);
    if (type === "IHDR") {
      header = {
        width: bytes.readUInt32BE(dataStart),
        height: bytes.readUInt32BE(dataStart + 4),
        bitDepth: bytes[dataStart + 8],
        colorType: bytes[dataStart + 9],
        interlace: bytes[dataStart + 12],
      };
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      ended = true;
      break;
    }
    offset = dataEnd + 4;
  }
  assert(header !== null, "facade.png has no IHDR chunk");
  assert(ended, "facade.png has no IEND chunk");
  assert.equal(header.width, 256, "facade.png width must be 256");
  assert.equal(header.height, 256, "facade.png height must be 256");
  assert.equal(header.bitDepth, 8, "facade.png must be 8-bit");
  assert.equal(header.colorType, 2, "facade.png must be RGB colour type 2");
  assert.equal(header.interlace, 0, "facade.png must be non-interlaced");
  const raw = inflateSync(Buffer.concat(idat));
  const expected = (256 * 3 + 1) * 256;
  assert.equal(raw.length, expected, "facade.png inflates to the wrong byte count");
  return {
    width: header.width,
    height: header.height,
    colorType: header.colorType,
    bitDepth: header.bitDepth,
    chunksValidated: true,
    inflatedBytes: raw.length,
  };
}

function buildFacadePixels() {
  const width = 256;
  const height = 256;
  const rgb = Buffer.alloc(width * height * 3);
  const random = mulberry32(0x5eed_1234);
  const windowColumns = [22, 100, 178];
  const windowRows = [14, 78, 142, 206];
  const windowWidth = 56;
  const windowHeight = 36;
  const lit = windowRows.map(() => windowColumns.map(() => random() < 0.58));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const noise = Math.floor(random() * 9) - 4;
      let r = 198 + noise;
      let g = 190 + noise;
      let b = 174 + noise;
      // Horizontal floor bands.
      if (y % 64 < 3) {
        r = 152;
        g = 146;
        b = 134;
      }
      // Vertical pilaster highlight.
      if (x % 64 < 2) {
        r = 176;
        g = 169;
        b = 155;
      }
      for (let row = 0; row < windowRows.length; row += 1) {
        for (let col = 0; col < windowColumns.length; col += 1) {
          const wx = windowColumns[col];
          const wy = windowRows[row];
          if (
            x >= wx &&
            x < wx + windowWidth &&
            y >= wy &&
            y < wy + windowHeight
          ) {
            const border =
              x < wx + 4 ||
              x >= wx + windowWidth - 4 ||
              y < wy + 4 ||
              y >= wy + windowHeight - 4;
            if (border) {
              r = 74;
              g = 72;
              b = 68;
            } else {
              const glassGradient = Math.floor(((y - wy) / windowHeight) * 18);
              if (lit[row][col]) {
                r = 205 - glassGradient;
                g = 184 - glassGradient;
                b = 126 - glassGradient;
              } else {
                r = 40 + glassGradient;
                g = 55 + glassGradient;
                b = 68 + glassGradient;
              }
            }
          }
        }
      }
      const offset = (y * width + x) * 3;
      rgb[offset] = Math.max(0, Math.min(255, r));
      rgb[offset + 1] = Math.max(0, Math.min(255, g));
      rgb[offset + 2] = Math.max(0, Math.min(255, b));
    }
  }
  return { rgb, width, height };
}

// ---------------------------------------------------------------------------
// GLB writer
// ---------------------------------------------------------------------------

class GlbBuilder {
  constructor() {
    this.json = {
      asset: { version: "2.0", generator: GENERATOR },
      scene: 0,
      scenes: [{ nodes: [] }],
      nodes: [],
      meshes: [],
      materials: [],
      accessors: [],
      bufferViews: [],
      buffers: [{ byteLength: 0 }],
    };
    this.parts = [];
    this.byteLength = 0;
  }

  addBufferView(buffer, target = null) {
    const padding = (4 - (this.byteLength % 4)) % 4;
    if (padding > 0) {
      this.parts.push(Buffer.alloc(padding));
      this.byteLength += padding;
    }
    const view = {
      buffer: 0,
      byteOffset: this.byteLength,
      byteLength: buffer.length,
    };
    if (target !== null) {
      view.target = target;
    }
    this.json.bufferViews.push(view);
    this.parts.push(buffer);
    this.byteLength += buffer.length;
    return this.json.bufferViews.length - 1;
  }

  accessor(
    buffer,
    { componentType, count, type, min, max, target = null, normalized = false },
  ) {
    const bufferView = this.addBufferView(buffer, target);
    const accessor = { bufferView, componentType, count, type };
    if (min !== undefined) {
      accessor.min = min;
    }
    if (max !== undefined) {
      accessor.max = max;
    }
    if (normalized) {
      accessor.normalized = true;
    }
    this.json.accessors.push(accessor);
    return this.json.accessors.length - 1;
  }

  addFloat(values, { count, type, min, max, target = ARRAY_BUFFER }) {
    return this.accessor(floatBuffer(values), {
      componentType: FLOAT,
      count,
      type,
      min,
      max,
      target,
    });
  }

  addU16(values, target = ELEMENT_ARRAY_BUFFER) {
    return this.accessor(u16Buffer(values), {
      componentType: UNSIGNED_SHORT,
      count: values.length,
      type: "SCALAR",
      target,
    });
  }

  addU8Vec4(values, target = ARRAY_BUFFER) {
    return this.accessor(u8Buffer(values), {
      componentType: UNSIGNED_BYTE,
      count: values.length / 4,
      type: "VEC4",
      target,
    });
  }

  addImage(pngBytes) {
    const bufferView = this.addBufferView(pngBytes);
    if (!Array.isArray(this.json.images)) {
      this.json.images = [];
    }
    this.json.images.push({
      name: "facade",
      mimeType: "image/png",
      bufferView,
    });
    return this.json.images.length - 1;
  }

  addTexture() {
    if (!Array.isArray(this.json.samplers)) {
      this.json.samplers = [];
    }
    this.json.samplers.push({
      magFilter: LINEAR,
      minFilter: LINEAR_MIPMAP_LINEAR,
      wrapS: REPEAT,
      wrapT: REPEAT,
    });
    if (!Array.isArray(this.json.textures)) {
      this.json.textures = [];
    }
    this.json.textures.push({
      name: "facade",
      sampler: 0,
      source: 0,
    });
    return 0;
  }

  finish() {
    this.json.buffers[0].byteLength = this.byteLength;
    const binPadding = (4 - (this.byteLength % 4)) % 4;
    let bin = Buffer.concat(this.parts);
    if (binPadding > 0) {
      bin = Buffer.concat([bin, Buffer.alloc(binPadding)]);
    }
    let jsonBytes = Buffer.from(JSON.stringify(this.json), "utf8");
    const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
    if (jsonPadding > 0) {
      jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPadding, 0x20)]);
    }
    const totalLength = 12 + 8 + jsonBytes.length + 8 + bin.length;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(GLB_MAGIC, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(totalLength, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonBytes.length, 0);
    jsonHeader.writeUInt32LE(CHUNK_JSON, 4);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(bin.length, 0);
    binHeader.writeUInt32LE(CHUNK_BIN, 4);
    return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, bin]);
  }
}

function boxFaces(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return [
    { normal: [0, 1, 0], corners: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]] },
    { normal: [0, -1, 0], corners: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
    { normal: [1, 0, 0], corners: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]] },
    { normal: [-1, 0, 0], corners: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    { normal: [0, 0, 1], corners: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { normal: [0, 0, -1], corners: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
  ];
}

function appendBox(positions, normals, uvs, indices, min, max) {
  const faceUvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const face of boxFaces(min, max)) {
    const base = positions.length / 3;
    for (let corner = 0; corner < 4; corner += 1) {
      positions.push(...face.corners[corner]);
      normals.push(...face.normal);
      uvs.push(...faceUvs[corner]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

// ---------------------------------------------------------------------------
// Asset builders
// ---------------------------------------------------------------------------

function buildGround() {
  const builder = new GlbBuilder();
  const positions = [
    -96, 0, -96,
    96, 0, -96,
    96, 0, 96,
    -96, 0, 96,
  ];
  const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
  const indices = [0, 2, 1, 0, 3, 2];
  const positionAccessor = builder.addFloat(positions, {
    count: 4,
    type: "VEC3",
    min: [-96, 0, -96],
    max: [96, 0, 96],
  });
  const normalAccessor = builder.addFloat(normals, { count: 4, type: "VEC3" });
  const uvAccessor = builder.addFloat(uvs, { count: 4, type: "VEC2" });
  const indexAccessor = builder.addU16(indices);
  builder.json.materials.push({
    name: "ground",
    pbrMetallicRoughness: {
      baseColorFactor: [0.29, 0.33, 0.3, 1],
      metallicFactor: 0,
      roughnessFactor: 1,
    },
    doubleSided: true,
  });
  builder.json.meshes.push({
    name: "ground",
    primitives: [
      {
        attributes: {
          POSITION: positionAccessor,
          NORMAL: normalAccessor,
          TEXCOORD_0: uvAccessor,
        },
        indices: indexAccessor,
        material: 0,
        mode: TRIANGLES,
      },
    ],
  });
  builder.json.nodes.push({ name: "ground", mesh: 0 });
  builder.json.scenes[0].nodes = [0];
  return builder.finish();
}

function buildBuilding(pngBytes) {
  const builder = new GlbBuilder();
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  appendBox(positions, normals, uvs, indices, [-4, 0, -4], [4, 1, 4]);
  const bounds = minMax(positions);
  const positionAccessor = builder.addFloat(positions, {
    count: positions.length / 3,
    type: "VEC3",
    min: bounds.min,
    max: bounds.max,
  });
  const normalAccessor = builder.addFloat(normals, {
    count: normals.length / 3,
    type: "VEC3",
  });
  const uvAccessor = builder.addFloat(uvs, {
    count: uvs.length / 2,
    type: "VEC2",
  });
  const indexAccessor = builder.addU16(indices);
  builder.addImage(pngBytes);
  builder.addTexture();
  builder.json.materials.push({
    name: "facade",
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: { index: 0 },
      metallicFactor: 0,
      roughnessFactor: 0.85,
    },
  });
  builder.json.meshes.push({
    name: "building",
    primitives: [
      {
        attributes: {
          POSITION: positionAccessor,
          NORMAL: normalAccessor,
          TEXCOORD_0: uvAccessor,
        },
        indices: indexAccessor,
        material: 0,
        mode: TRIANGLES,
      },
    ],
  });
  builder.json.nodes.push({ name: "building", mesh: 0 });
  builder.json.scenes[0].nodes = [0];
  return builder.finish();
}

async function buildCarFromKenney() {
  const io = new NodeIO();
  // The Kenney sedan declares KHR_texture_transform with only texCoord: 0.
  // That is the glTF default, so ignoring the extension changes nothing.
  const document = await io.read(KENNEY_CAR_SOURCE);
  const root = document.getRoot();
  const scene = root.getDefaultScene();
  const parts = [...scene.listChildren()];
  assert.equal(parts.length, 5, "Kenney sedan should have five root parts");

  // One wrapper node for position/yaw. The 180 deg turn is baked into each
  // part, not the wrapper, so layout yaw = 0 still means local forward -Z.
  const car = document.createNode("car");
  scene.addChild(car);
  const names = {
    "wheel-front-right": "wheel-fr",
    "wheel-front-left": "wheel-fl",
    "wheel-back-left": "wheel-rl",
    "wheel-back-right": "wheel-rr",
    body: "body",
  };
  for (const part of parts) {
    const sourceName = part.getName();
    assert(names[sourceName], `unexpected Kenney car node "${sourceName}"`);
    part.setName(names[sourceName]);
    assert.deepEqual(
      part.getRotation(),
      [0, 0, 0, 1],
      `unexpected rotation on Kenney car part "${sourceName}"`,
    );
    const [x, y, z] = part.getTranslation();
    // Negate x/z for the turn; drop 0.5 m so layout y = 0.5 grounds the wheels.
    part.setTranslation([-x, y - 0.5, -z]);
    part.setRotation([0, 1, 0, 0]);
    car.addChild(part);
  }
  return Buffer.from(await io.writeBinary(document));
}

async function buildPedFromUal() {
  const io = new NodeIO();
  const document = await io.read(UAL_SOURCE);
  const root = document.getRoot();
  const walk = root
    .listAnimations()
    .find((animation) => animation.getName() === "Walk_Loop");
  assert(walk, "UAL source is missing the Walk_Loop clip");
  assert.equal(root.listSkins().length, 1, "UAL source should have one skin");
  walk.setName("walk");

  // Keep only the accessors the walk clip, meshes and skin need. Disposing the
  // other 42 clips' accessors is what takes the asset from 7.6 MB to ~0.6 MB.
  const keep = new Set();
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      for (const semantic of primitive.listSemantics()) {
        keep.add(primitive.getAttribute(semantic));
      }
      if (primitive.getIndices()) keep.add(primitive.getIndices());
    }
  }
  for (const skin of root.listSkins()) {
    if (skin.getInverseBindMatrices()) keep.add(skin.getInverseBindMatrices());
  }
  for (const sampler of walk.listSamplers()) {
    keep.add(sampler.getInput());
    keep.add(sampler.getOutput());
  }
  const drop = new Set();
  for (const animation of root.listAnimations()) {
    if (animation === walk) continue;
    for (const sampler of animation.listSamplers()) {
      drop.add(sampler.getInput());
      drop.add(sampler.getOutput());
    }
    animation.dispose();
  }
  for (const accessor of drop) {
    if (!keep.has(accessor) && !accessor.isDisposed()) accessor.dispose();
  }
  await document.transform(prune());
  return Buffer.from(await io.writeBinary(document));
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function buildLayout() {
  const columns = [11, 25, 39, 53];
  const dropped = new Set(["39,53", "53,53"]);
  const heights = [12, 16, 20, 24, 28, 22, 18, 15, 13, 17, 21, 25, 19, 27];
  const buildings = [];
  for (const z of columns) {
    for (const x of columns) {
      if (dropped.has(`${x},${z}`)) {
        continue;
      }
      buildings.push({
        cell: "1,1",
        x,
        z,
        height: heights[buildings.length],
      });
    }
  }
  const random = mulberry32(0xb00c_1e01);
  const pedestrianCells = [
    { cell: "0,2", count: 17 },
    { cell: "1,2", count: 17 },
    { cell: "2,2", count: 16 },
  ];
  const pedestrians = [];
  let pedestrianIndex = 0;
  for (const group of pedestrianCells) {
    for (let i = 0; i < group.count; i += 1) {
      const column = i % 5;
      const row = Math.floor(i / 5);
      pedestrians.push({
        cell: group.cell,
        x: round2(9 + column * 10 + (random() - 0.5) * 3),
        z: round2(10 + row * 12 + (random() - 0.5) * 3),
        waypoint: pedestrianIndex % 4,
      });
      pedestrianIndex += 1;
    }
  }
  return {
    cellSizeMeters: 64,
    origin: { x: -96, y: 0, z: -96 },
    buildings,
    pedestrians,
    car: { x: 0, y: 0.5, z: 32, yaw: 0 },
    cameraPath: [
      { x: 0, z: 32 },
      { x: 0, z: 0 },
      { x: 0, z: -32 },
      { x: 0, z: -64 },
      { x: 64, z: -64 },
      { x: 64, z: 0 },
      { x: 64, z: 64 },
      { x: 0, z: 64 },
      { x: -64, z: 64 },
      { x: -64, z: 0 },
      { x: -64, z: -64 },
      { x: 0, z: -64 },
      { x: 0, z: -32 },
      { x: 0, z: 0 },
      { x: 0, z: 32 },
    ],
    runSeconds: 60,
  };
}

function verifyLayout(layout) {
  assert.deepEqual(
    Object.keys(layout).sort(),
    [
      "buildings",
      "cameraPath",
      "car",
      "cellSizeMeters",
      "origin",
      "pedestrians",
      "runSeconds",
    ],
  );
  assert.equal(layout.cellSizeMeters, 64);
  assert.deepEqual(Object.keys(layout.origin).sort(), ["x", "y", "z"]);
  assert.deepEqual(layout.origin, { x: -96, y: 0, z: -96 });
  assert.equal(layout.runSeconds, 60);

  assert.equal(layout.buildings.length, 14, "layout needs exactly 14 buildings");
  for (const building of layout.buildings) {
    assert.deepEqual(Object.keys(building).sort(), ["cell", "height", "x", "z"]);
    assert.equal(building.cell, "1,1", "every building belongs to the centre cell");
    assert(Number.isInteger(building.height));
    assert(building.height >= 12 && building.height <= 28);
    assert(building.x >= 0 && building.x <= 64 && building.z >= 0 && building.z <= 64);
  }
  for (let i = 0; i < layout.buildings.length; i += 1) {
    for (let j = i + 1; j < layout.buildings.length; j += 1) {
      const a = layout.buildings[i];
      const b = layout.buildings[j];
      const separated = Math.abs(a.x - b.x) >= 8 || Math.abs(a.z - b.z) >= 8;
      assert(separated, `buildings ${i} and ${j} overlap`);
    }
  }

  assert.equal(layout.pedestrians.length, 50, "layout needs exactly 50 pedestrians");
  const southCells = new Set(["0,2", "1,2", "2,2"]);
  for (const pedestrian of layout.pedestrians) {
    assert.deepEqual(
      Object.keys(pedestrian).sort(),
      ["cell", "waypoint", "x", "z"],
    );
    assert(southCells.has(pedestrian.cell), `pedestrian in ${pedestrian.cell} is not in a south cell`);
    assert(pedestrian.x >= 0 && pedestrian.x <= 64);
    assert(pedestrian.z >= 0 && pedestrian.z <= 64);
    assert(Number.isInteger(pedestrian.waypoint));
    assert(pedestrian.waypoint >= 0 && pedestrian.waypoint <= 3);
  }

  assert.deepEqual(Object.keys(layout.car).sort(), ["x", "y", "yaw", "z"]);
  assert.deepEqual(layout.car, { x: 0, y: 0.5, z: 32, yaw: 0 });

  assert(Array.isArray(layout.cameraPath) && layout.cameraPath.length >= 2);
  for (const point of layout.cameraPath) {
    assert.deepEqual(Object.keys(point).sort(), ["x", "z"]);
  }
  const xs = layout.cameraPath.map((point) => point.x);
  const zs = layout.cameraPath.map((point) => point.z);
  assert(Math.max(...xs) - Math.min(...xs) >= 128, "camera path must cross the 3x3 grid in x");
  assert(Math.max(...zs) - Math.min(...zs) >= 128, "camera path must cross the 3x3 grid in z");

  return {
    topLevelFields: Object.keys(layout).sort(),
    buildings: layout.buildings.length,
    buildingCells: [...new Set(layout.buildings.map((building) => building.cell))],
    pedestrians: layout.pedestrians.length,
    pedestrianCells: [...new Set(layout.pedestrians.map((pedestrian) => pedestrian.cell))].sort(),
    car: layout.car,
    cameraPathPoints: layout.cameraPath.length,
    cameraPathSpanX: [Math.min(...xs), Math.max(...xs)],
    cameraPathSpanZ: [Math.min(...zs), Math.max(...zs)],
    runSeconds: layout.runSeconds,
  };
}

// ---------------------------------------------------------------------------
// GLB parsing and verification
// ---------------------------------------------------------------------------

function parseGlb(bytes, label) {
  assert(bytes.length >= 20, `${label} is too small to be a GLB`);
  assert.equal(bytes.readUInt32LE(0), GLB_MAGIC, `${label} has the wrong GLB magic`);
  assert.equal(bytes.readUInt32LE(4), 2, `${label} is not glTF 2.0`);
  assert.equal(bytes.readUInt32LE(8), bytes.length, `${label} header length does not match`);
  let offset = 12;
  const chunks = [];
  while (offset < bytes.length) {
    assert(offset + 8 <= bytes.length, `${label} has a truncated chunk header`);
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    assert(end <= bytes.length, `${label} has a truncated chunk`);
    assert.equal(length % 4, 0, `${label} chunk is not 4-byte aligned`);
    chunks.push({ type, bytes: bytes.subarray(start, end) });
    offset = end;
  }
  assert(chunks.length === 2, `${label} must have exactly two chunks`);
  assert.equal(chunks[0].type, CHUNK_JSON, `${label} first chunk is not JSON`);
  assert.equal(chunks[1].type, CHUNK_BIN, `${label} second chunk is not BIN`);
  const text = chunks[0].bytes.toString("utf8").trimEnd();
  const json = JSON.parse(text);
  assert.equal(json.asset?.version, "2.0", `${label} JSON asset version is not 2.0`);
  assert(json.buffers?.[0]?.byteLength <= chunks[1].bytes.length);
  return { json, bin: chunks[1].bytes };
}

async function verifyGlbs(pngBytes) {
  const io = new NodeIO();
  const checks = {};
  const parsed = {};

  for (const file of ["ground.glb", "building.glb", "car.glb", "ped.glb"]) {
    const bytes = await readFile(path.join(ASSET_DIR, file));
    const glb = parseGlb(bytes, file);
    assert(
      (glb.json.buffers ?? []).every((buffer) => !buffer.uri),
      `${file} must embed its buffer, not reference an external file`,
    );
    assert(
      (glb.json.images ?? []).every((image) => image.bufferView !== undefined),
      `${file} must embed its images, not reference an external file`,
    );
    await io.read(path.join(ASSET_DIR, file));
    parsed[file] = {
      jsonNodes: glb.json.nodes.length,
      jsonMeshes: glb.json.meshes.length,
      accessors: glb.json.accessors.length,
      bufferViews: glb.json.bufferViews.length,
    };
    checks[file] = { parsed: true, documentRead: true };
  }

  {
    const document = await io.read(path.join(ASSET_DIR, "ground.glb"));
    const root = document.getRoot();
    const primitive = root.listMeshes()[0].listPrimitives()[0];
    const position = primitive.getAttribute("POSITION");
    assert(position !== null);
    assert.equal(position.getCount(), 4);
    assert(primitive.getAttribute("NORMAL") !== null);
    assert(primitive.getAttribute("TEXCOORD_0") !== null);
    assert.equal(primitive.getMode(), TRIANGLES);
    assert.equal(root.listNodes().length, 1);
    checks["ground.glb"].positionVertices = position.getCount();
    checks["ground.glb"].hasUvs = true;
    checks["ground.glb"].hasNormals = true;
  }

  {
    const document = await io.read(path.join(ASSET_DIR, "building.glb"));
    const root = document.getRoot();
    const primitive = root.listMeshes()[0].listPrimitives()[0];
    assert(primitive.getAttribute("TEXCOORD_0") !== null);
    assert(root.listNodes().length === 1, "building.glb must contain exactly one node");
    assert.equal(root.listTextures().length, 1);
    const texture = root.listTextures()[0];
    assert(texture.getImage() !== null, "building.glb facade texture is not embedded");
    assert.equal(Buffer.from(texture.getImage()).length, pngBytes.length);
    const material = primitive.getMaterial();
    assert(material !== null);
    assert(material.getBaseColorTexture() !== null);
    checks["building.glb"].nodes = 1;
    checks["building.glb"].hasUvs = true;
    checks["building.glb"].embeddedTextureBytes = texture.getImage().length;
  }

  {
    const document = await io.read(path.join(ASSET_DIR, "car.glb"));
    const root = document.getRoot();
    const names = root.listNodes().map((node) => node.getName());
    for (const wheel of ["wheel-fl", "wheel-fr", "wheel-rl", "wheel-rr"]) {
      assert(names.includes(wheel), `car.glb is missing node ${wheel}`);
    }
    assert(names.includes("car"));
    assert(names.includes("body"));
    assert.equal(root.listNodes().length, 6, "car.glb needs car + body + 4 wheels");
    assert.equal(root.listMeshes().length, 5, "car.glb must keep the Kenney parts separate");
    assert.equal(root.listTextures().length, 1, "car.glb is missing the Kenney colormap");
    const texture = root.listTextures()[0];
    assert(texture.getImage() !== null, "car.glb colormap is not embedded");
    const car = root.listNodes().find((node) => node.getName() === "car");
    assert.equal(car.listChildren().length, 5);
    assert.deepEqual(car.getTranslation(), [0, 0, 0]);
    assert.deepEqual(car.getRotation(), [0, 0, 0, 1]);
    for (const wheel of ["wheel-fl", "wheel-fr", "wheel-rl", "wheel-rr"]) {
      const node = root.listNodes().find((item) => item.getName() === wheel);
      assert.deepEqual(node.getRotation(), [0, 1, 0, 0], `${wheel} is not facing -Z`);
      assert(
        Math.abs(node.getTranslation()[1] + 0.2) < 1e-6,
        `${wheel} is not grounded for layout y = 0.5`,
      );
    }
    checks["car.glb"].wheelNodes = ["wheel-fl", "wheel-fr", "wheel-rl", "wheel-rr"];
    checks["car.glb"].meshes = 5;
    checks["car.glb"].embeddedTextureBytes = texture.getImage().length;
    checks["car.glb"].rootRotation = "identity; parts baked to local forward -Z";
  }

  {
    const document = await io.read(path.join(ASSET_DIR, "ped.glb"));
    const root = document.getRoot();
    const skins = root.listSkins();
    assert.equal(skins.length, 1, "ped.glb must have one skin");
    assert.equal(
      skins[0].listJoints().length,
      65,
      "ped.glb must keep the UAL 65-joint skeleton",
    );
    const primitives = root.listMeshes()[0].listPrimitives();
    assert.equal(primitives.length, 2, "ped.glb needs both UAL primitives");
    let vertices = 0;
    for (const primitive of primitives) {
      const position = primitive.getAttribute("POSITION");
      const joints = primitive.getAttribute("JOINTS_0");
      const weights = primitive.getAttribute("WEIGHTS_0");
      assert(position !== null);
      assert(joints !== null, "ped.glb is missing JOINTS_0");
      assert(weights !== null, "ped.glb is missing WEIGHTS_0");
      assert.equal(joints.getCount(), position.getCount());
      assert.equal(weights.getCount(), position.getCount());
      const jointData = joints.getArray();
      const weightData = weights.getArray();
      for (let vertex = 0; vertex < position.getCount(); vertex += 1) {
        let sum = 0;
        for (let component = 0; component < 4; component += 1) {
          const offset = vertex * 4 + component;
          assert(jointData[offset] < 65, "ped.glb joint index is out of range");
          sum += weightData[offset];
        }
        assert(
          Math.abs(sum - 1) < 1e-4,
          `ped.glb weights for vertex ${vertex} do not sum to 1`,
        );
      }
      vertices += position.getCount();
    }
    const animations = root.listAnimations();
    assert.equal(animations.length, 1, "ped.glb must have one animation");
    assert.equal(animations[0].getName(), "walk");
    let duration = 0;
    for (const sampler of animations[0].listSamplers()) {
      const input = sampler.getInput();
      assert(input !== null);
      for (const time of input.getArray()) {
        duration = Math.max(duration, time);
      }
    }
    assert(
      Math.abs(duration - 4 / 3) < 1e-3,
      `walk clip duration is ${duration}, expected 1.333 s from Walk_Loop`,
    );
    let rootTranslation = null;
    for (const channel of animations[0].listChannels()) {
      if (
        channel.getTargetNode()?.getName() === "root" &&
        channel.getTargetPath() === "translation"
      ) {
        rootTranslation = channel.getSampler().getOutput().getArray();
      }
    }
    assert(rootTranslation !== null, "walk clip has no root translation channel");
    for (const value of rootTranslation) {
      assert(Math.abs(value) < 1e-6, "walk clip must be in place (root motion)");
    }
    checks["ped.glb"].skinJoints = skins[0].listJoints().length;
    checks["ped.glb"].vertices = vertices;
    checks["ped.glb"].primitives = primitives.length;
    checks["ped.glb"].animation = animations[0].getName();
    checks["ped.glb"].sourceClip = "Walk_Loop";
    checks["ped.glb"].durationSeconds = duration;
    checks["ped.glb"].rootMotion = "none (in place)";
  }

  return { checks, parsed };
}

// ---------------------------------------------------------------------------
// Manifest and licences
// ---------------------------------------------------------------------------

const LICENSE_FILES = [
  "ground.glb",
  "building.glb",
  "car.glb",
  "ped.glb",
  "facade.png",
  "layout.json",
  "LICENSES.csv",
  "MANIFEST.json",
];

function licenceCsv() {
  const lines = ["file,source,author,licence,date,attribution"];
  for (const file of LICENSE_FILES) {
    if (file === "ped.glb") {
      lines.push(
        `${file},${UAL_SOURCE_LABEL},Quaternius,CC0 1.0,${DATE},none required`,
      );
    } else if (file === "car.glb") {
      lines.push(
        `${file},${KENNEY_CAR_SOURCE_LABEL},Kenney,CC0 1.0,${DATE},none required`,
      );
    } else {
      lines.push(
        `${file},generated in-repo,PocketPad,CC0 1.0,${DATE},none required`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function fileRecord(name) {
  const bytes = await readFile(path.join(ASSET_DIR, name));
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(ASSET_DIR, { recursive: true });

  const facade = buildFacadePixels();
  const pngBytes = encodePngRgb(facade.width, facade.height, facade.rgb);
  const pngCheck = decodeAndCheckPng(pngBytes);
  await writeFile(path.join(ASSET_DIR, "facade.png"), pngBytes);

  const ground = buildGround();
  const building = buildBuilding(pngBytes);
  const car = await buildCarFromKenney();
  const ped = await buildPedFromUal();
  await writeFile(path.join(ASSET_DIR, "ground.glb"), ground);
  await writeFile(path.join(ASSET_DIR, "building.glb"), building);
  await writeFile(path.join(ASSET_DIR, "car.glb"), car);
  await writeFile(path.join(ASSET_DIR, "ped.glb"), ped);

  const layout = buildLayout();
  const layoutCheck = verifyLayout(layout);
  await writeFile(
    path.join(ASSET_DIR, "layout.json"),
    `${JSON.stringify(layout, null, 2)}\n`,
    "utf8",
  );

  await writeFile(path.join(ASSET_DIR, "LICENSES.csv"), licenceCsv(), "utf8");

  const glbVerification = await verifyGlbs(pngBytes);

  const files = {};
  for (const name of [
    "ground.glb",
    "building.glb",
    "car.glb",
    "ped.glb",
    "facade.png",
    "layout.json",
    "LICENSES.csv",
  ]) {
    files[name] = await fileRecord(name);
  }
  const totalBytes = Object.values(files).reduce(
    (sum, record) => sum + record.bytes,
    0,
  );

  const manifest = {
    schema: "pocketpad-bakeoff-assets/v1",
    date: DATE,
    generator: "experiments/bakeoff/assets/generate.mjs",
    units: "metres",
    coordinateSystem: "right-handed, +Y up, glTF convention",
    files,
    verification: {
      png: pngCheck,
      layout: layoutCheck,
      gltf: glbVerification.parsed,
      checks: glbVerification.checks,
      gltfTransform:
        "@gltf-transform/core 4.5.1; @gltf-transform/functions 4.5.1",
    },
    provenance: {
      pedestrian: {
        source: UAL_SOURCE_LABEL,
        author: "Quaternius",
        licence: "CC0 1.0",
        change:
          "kept only Walk_Loop and renamed it walk; removed the other 42 clips",
      },
      car: {
        source: KENNEY_CAR_SOURCE_LABEL,
        author: "Kenney",
        licence: "CC0 1.0",
        change:
          "wheel nodes renamed wheel-fl/fr/rl/rr; 180 deg turn baked into each part; parts shifted -0.5 m; colormap embedded",
      },
      other:
        "ground.glb, building.glb, facade.png and layout.json are generated in-repo",
    },
    conventions: {
      building:
        "mesh is 8 x 8 x 1 m with its base at y = 0; set node.scale.y = layout height",
      car: "Kenney sedan: root origin is the chassis centre at layout y = 0.5; local forward is -Z; wheel axles are local X; wheel bottoms touch y = 0; nodes wheel-fl/fr/rl/rr",
      pedestrian:
        "Quaternius UAL mannequin: 1.83 m tall, 65 joints, 8546 vertices over 2 primitives; in-place walk clip (source Walk_Loop) loops every 1.333 s",
      layout:
        "building and pedestrian x/z are cell-local; car and cameraPath are world-space metres",
      facade: "building.glb embeds facade.png as its base-colour texture",
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(ASSET_DIR, "MANIFEST.json"), manifestBytes);

  const totalWithManifest = totalBytes + manifestBytes.length;
  if (totalWithManifest > 5 * 1024 * 1024) {
    throw new Error(`generated assets are ${totalWithManifest} bytes, over the 5 MiB budget`);
  }

  process.stdout.write("PocketPad bake-off assets generated\n");
  for (const [name, record] of Object.entries(files)) {
    process.stdout.write(
      `  ${name.padEnd(16)} ${String(record.bytes).padStart(7)} B  sha256 ${record.sha256}\n`,
    );
  }
  process.stdout.write(`  MANIFEST.json    ${String(manifestBytes.length).padStart(7)} B\n`);
  process.stdout.write(
    `  total            ${String(totalWithManifest).padStart(7)} B (limit ${5 * 1024 * 1024})\n`,
  );
  process.stdout.write(
    `Verified: 4 GLBs parse with @gltf-transform/core; ped.glb ${glbVerification.checks["ped.glb"].skinJoints} joints, ${glbVerification.checks["ped.glb"].vertices} vertices, animation=walk/${glbVerification.checks["ped.glb"].durationSeconds}s; car.glb wheel-fl/fr/rl/rr; facade.png 256x256 CRC checked; layout has ${layoutCheck.buildings} buildings and ${layoutCheck.pedestrians} pedestrians.\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`assets/generate.mjs failed: ${error.stack ?? error}\n`);
  process.exitCode = 1;
});

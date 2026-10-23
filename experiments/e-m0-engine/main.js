/**
 * M0 engine demo: one textured cube or the 5,000-instance fixture through the
 * real built renderer packages.
 *
 * The page does not draw with a private WebGL/WebGPU path. It imports the
 * built `@lanpad/engine-renderer-webgpu` / `-webgl2` dist entries from the
 * repo, creates the device with the public factory, builds a real mesh,
 * material and sRGB texture, renders a deterministic scene and hashes a
 * top-down RGBA readback of the canvas. Benchmark mode records wall-clock
 * requestAnimationFrame intervals after the golden capture.
 *
 * One directional light is part of the M0 shader in both backends; there is
 * no public light-creation call in the built packages. That is reported, not
 * simulated.
 */
import {
  mat4Create,
  mat4Identity,
  mat4LookAt,
  mat4Multiply,
  mat4PerspectiveWebGL2,
  mat4PerspectiveWebGPU,
} from "@lanpad/engine-core";
import { forceWebGpuDeviceLost } from "@lanpad/engine-renderer-webgpu/dev";

const SCHEMA = "m0-engine-demo/v2";
const VALID_BACKENDS = new Set(["auto", "webgpu", "webgl2"]);
const CAPTURE_WARMUP_FRAMES = 30;
const CAPTURE_FRAME = 60;
const BENCH_WARMUP_FRAMES = 120;
const BENCH_MEASURED_FRAMES = 600;
const CASE_NAMES = new Set(["resize", "contextloss", "assets"]);
const CONTEXT_LOSS_WARMUP_FRAMES = 10;
const CONTEXT_LOSS_TIMEOUT_MS = 20_000;
const RESIZE_SEQUENCE = [
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
  { width: 640, height: 360 },
  { width: 1024, height: 576 },
  { width: 1280, height: 720 },
  { width: 1152, height: 648 },
  { width: 720, height: 405 },
  { width: 640, height: 360 },
  { width: 960, height: 540 },
  { width: 640, height: 360 },
];
const ASSET_CASE = {
  manifestUrl: "/experiments/e-m0-engine/asset-fixtures/manifest.json",
  assetId: "fixtures/five-mb",
  url: "/experiments/e-m0-engine/asset-fixtures/fixtures/five-mb.woff2",
  expectedBytes: 5 * 1024 * 1024,
  gameId: "m0-assets-case",
};
const GRID_SPACING = 1.5;
const GRID_COLUMNS = 50;
const GRID_SPEC_INSTANCES = 5000;
const TEXTURE_SIZE = 4;
const TEXTURE_FORMAT = "rgba8unorm-srgb";
const TWO_PI = Math.PI * 2;
const SCENES = {
  cube: {
    key: "cube",
    id: "m0-textured-cube-v1",
    title: "Textured cube",
    defaultInstances: 1,
    defaultWidth: 640,
    defaultHeight: 360,
  },
  scene5000: {
    key: "scene5000",
    id: "m0-scene5000-v1",
    title: "5,000 instanced cubes",
    defaultInstances: GRID_SPEC_INSTANCES,
    defaultWidth: 1920,
    defaultHeight: 1080,
  },
};

const statusEl = document.getElementById("status");
const headingEl = document.querySelector("h1");
const backendButtons = Array.from(document.querySelectorAll("button[data-backend]"));
const query = new URLSearchParams(window.location.search);
const requestedRaw = query.get("backend");
const requestedBackend =
  requestedRaw === null || requestedRaw === ""
    ? "auto"
    : requestedRaw.toLowerCase();
const startedAt = performance.now();
let canvas = document.getElementById("view");

function usageError(message) {
  const error = new Error(message);
  error.stage = "query";
  error.code = "E_USAGE";
  return error;
}

function parseInteger(raw, name, min, max) {
  if (!/^\d+$/.test(raw)) {
    throw usageError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw usageError(`${name} must be an integer from ${min} to ${max}, got ${raw}`);
  }
  return value;
}

function parseSize(raw, fallbackWidth, fallbackHeight) {
  if (raw === null || raw === "") {
    return { width: fallbackWidth, height: fallbackHeight, raw: null };
  }
  const match = /^(\d{1,5})x(\d{1,5})$/i.exec(raw);
  if (match === null) {
    throw usageError(`size must look like 1920x1080, got ${JSON.stringify(raw)}`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 64 || height < 64 || width > 8192 || height > 8192) {
    throw usageError(`size must be 64x64 to 8192x8192, got ${raw}`);
  }
  return { width, height, raw };
}

function parseRequest() {
  const sceneRaw = query.get("scene");
  const sceneKey =
    sceneRaw === null || sceneRaw === "" ? "cube" : sceneRaw.toLowerCase();
  const scene = SCENES[sceneKey];
  if (scene === undefined) {
    throw usageError(
      `unknown scene ${JSON.stringify(sceneRaw)}; expected cube or scene5000`,
    );
  }
  const size = parseSize(
    query.get("size"),
    scene.defaultWidth,
    scene.defaultHeight,
  );
  const instancesRaw = query.get("instances");
  const instances =
    instancesRaw === null || instancesRaw === ""
      ? scene.defaultInstances
      : parseInteger(instancesRaw, "instances", 1, 16384);
  if (scene.key === "cube" && instances !== 1) {
    throw usageError("cube renders exactly one instance");
  }
  const benchRaw = query.get("bench");
  const bench = benchRaw === "1";
  if (benchRaw !== null && benchRaw !== "" && benchRaw !== "0" && benchRaw !== "1") {
    throw usageError(`bench must be 0 or 1, got ${JSON.stringify(benchRaw)}`);
  }
  const caseRaw = query.get("case");
  const caseName =
    caseRaw === null || caseRaw === "" ? null : caseRaw.toLowerCase();
  if (caseName !== null && !CASE_NAMES.has(caseName)) {
    throw usageError(
      `unknown case ${JSON.stringify(caseRaw)}; expected resize, contextloss or assets`,
    );
  }
  if (caseName !== null && bench) {
    throw usageError(`bench=1 cannot be combined with case=${caseName}`);
  }
  return {
    sceneKey: scene.key,
    scene,
    instances,
    width: size.width,
    height: size.height,
    sizeRaw: size.raw,
    bench,
    case: caseName,
  };
}

let request = null;
let requestError = null;
try {
  request = parseRequest();
} catch (error) {
  requestError = error;
  request = {
    sceneKey: "cube",
    scene: SCENES.cube,
    instances: 1,
    width: SCENES.cube.defaultWidth,
    height: SCENES.cube.defaultHeight,
    sizeRaw: null,
    bench: false,
    case: null,
  };
}

if (headingEl !== null) {
  headingEl.textContent = request.scene.title;
}
document.title = `PocketPad M0 engine — ${request.scene.title}`;

window.__M0_DONE__ = false;
window.__M0__ = {
  schema: SCHEMA,
  ok: false,
  stage: "starting",
  scene: request.scene.id,
  sceneKey: request.sceneKey,
  requestedBackend,
  instances: request.instances,
  case: request.case,
  size: {
    cssWidth: request.width,
    cssHeight: request.height,
    dpr: window.devicePixelRatio,
    width: 0,
    height: 0,
  },
  bench: request.bench,
  pending: true,
};

function setStatus(lines) {
  if (statusEl === null) {
    return;
  }
  statusEl.textContent = lines.filter(Boolean).join("\n");
}

function markSelected(backend) {
  for (const button of backendButtons) {
    const selected = button.dataset.backend === backend;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
}

function serializeError(error) {
  if (error === null || typeof error !== "object") {
    return { name: "Error", code: null, message: String(error) };
  }
  const message =
    typeof error.message === "string" && error.message.length > 0
      ? error.message
      : String(error);
  const cause =
    error.cause !== null &&
    typeof error.cause === "object" &&
    typeof error.cause.message === "string"
      ? error.cause.message
      : null;
  return {
    name: typeof error.name === "string" ? error.name : "Error",
    code: typeof error.code === "string" ? error.code : null,
    message: cause !== null && cause !== message ? `${message} (cause: ${cause})` : message,
  };
}

function nextFrame() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function replaceCanvas(previous) {
  if (previous === null) {
    throw new Error("canvas #view is missing from the document");
  }
  const next = previous.cloneNode(false);
  previous.replaceWith(next);
  return document.getElementById("view");
}

function applyStageSize(source, width, height) {
  source.style.width = `${width}px`;
  source.style.height = `${height}px`;
  document.body.classList.toggle(
    "wide-stage",
    width > 960 || height > 540,
  );
}

function readSurface(source) {
  const cssWidth =
    typeof source.clientWidth === "number" && source.clientWidth > 0
      ? source.clientWidth
      : request.width;
  const cssHeight =
    typeof source.clientHeight === "number" && source.clientHeight > 0
      ? source.clientHeight
      : request.height;
  const dpr =
    typeof window.devicePixelRatio === "number" && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  return {
    kind: "canvas",
    native: source,
    cssWidth,
    cssHeight,
    dpr,
  };
}

const FACES = [
  { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

const UVS = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
];

/** One interleaved static-pbr-v1 cube: position(3), normal(3), uv(2). */
function createCubeGeometry(halfExtent) {
  const vertices = new Float32Array(FACES.length * 4 * 8);
  const indices = new Uint16Array(FACES.length * 6);
  let vertexIndex = 0;
  let indexOffset = 0;

  for (let faceIndex = 0; faceIndex < FACES.length; faceIndex += 1) {
    const face = FACES[faceIndex];
    for (let corner = 0; corner < 4; corner += 1) {
      const su = CORNERS[corner][0];
      const sv = CORNERS[corner][1];
      const offset = vertexIndex * 8;
      vertices[offset] =
        face.normal[0] * halfExtent +
        face.u[0] * su * halfExtent +
        face.v[0] * sv * halfExtent;
      vertices[offset + 1] =
        face.normal[1] * halfExtent +
        face.u[1] * su * halfExtent +
        face.v[1] * sv * halfExtent;
      vertices[offset + 2] =
        face.normal[2] * halfExtent +
        face.u[2] * su * halfExtent +
        face.v[2] * sv * halfExtent;
      vertices[offset + 3] = face.normal[0];
      vertices[offset + 4] = face.normal[1];
      vertices[offset + 5] = face.normal[2];
      vertices[offset + 6] = UVS[corner][0];
      vertices[offset + 7] = UVS[corner][1];
      vertexIndex += 1;
    }

    const base = faceIndex * 4;
    indices[indexOffset] = base;
    indices[indexOffset + 1] = base + 1;
    indices[indexOffset + 2] = base + 2;
    indices[indexOffset + 3] = base;
    indices[indexOffset + 4] = base + 2;
    indices[indexOffset + 5] = base + 3;
    indexOffset += 6;
  }

  return {
    vertices,
    indices,
    triangles: FACES.length * 2,
    radius: Math.sqrt(3) * halfExtent,
  };
}

/** Four-by-four checker, uploaded as sRGB bytes. */
function createCheckerBytes() {
  const bytes = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const light = (x < TEXTURE_SIZE / 2) !== (y < TEXTURE_SIZE / 2);
      const offset = (y * TEXTURE_SIZE + x) * 4;
      bytes[offset] = light ? 236 : 96;
      bytes[offset + 1] = light ? 226 : 58;
      bytes[offset + 2] = light ? 200 : 34;
      bytes[offset + 3] = 255;
    }
  }
  return bytes;
}

function createScene(device, backendName, sceneKey) {
  const isGrid = sceneKey === "scene5000";
  const geometry = createCubeGeometry(isGrid ? 0.5 : 0.55);
  const layout = isGrid ? "instanced-transform-v1" : "static-pbr-v1";
  const mesh = device.createMesh({
    label: isGrid ? "m0-unit-cube-mesh" : "m0-cube-mesh",
    layout,
    vertices: [geometry.vertices],
    indices: {
      data: geometry.indices,
      format: "uint16",
    },
    bounds: {
      center: { x: 0, y: 0, z: 0 },
      radius: geometry.radius,
    },
  });

  // The M0 validators disagree on data-backed texture usage:
  //   WebGPU requires `copy-dst` when bytes are supplied;
  //   WebGL2 M0 rejects every usage except `sample`.
  // Use each backend's accepted descriptor and report the mismatch.
  const textureUsage = backendName === "webgpu" ? ["sample", "copy-dst"] : ["sample"];
  const texture = device.createTexture({
    label: isGrid ? "m0-grid-checker-texture" : "m0-checker-texture",
    width: TEXTURE_SIZE,
    height: TEXTURE_SIZE,
    format: TEXTURE_FORMAT,
    usage: textureUsage,
    data: [
      {
        mipLevel: 0,
        layer: 0,
        bytes: createCheckerBytes(),
        bytesPerRow: TEXTURE_SIZE * 4,
      },
    ],
    sampler: {
      label: "m0-checker-sampler",
      magFilter: "nearest",
      minFilter: "nearest",
      mipmapFilter: "nearest",
      addressU: "clamp-to-edge",
      addressV: "clamp-to-edge",
    },
  });

  const material = device.createMaterial({
    label: isGrid ? "m0-grid-material" : "m0-cube-material",
    baseColorFactor: [1, 1, 1, 1],
    metallic: 0,
    roughness: 0.62,
    emissiveFactor: [0, 0, 0],
    baseColorTexture: texture,
    alphaMode: "opaque",
  });

  return {
    mesh,
    material,
    texture,
    textureUsage,
    triangles: geometry.triangles,
    instanced: isGrid,
  };
}

function createCameraMatrices(backendName, source, sceneKey) {
  const aspect =
    (source.clientWidth > 0 ? source.clientWidth : request.width) /
    (source.clientHeight > 0 ? source.clientHeight : request.height);
  const projection = mat4Create();
  if (sceneKey === "scene5000") {
    if (backendName === "webgpu") {
      mat4PerspectiveWebGPU(projection, Math.PI / 3, aspect, 0.1, 500);
    } else {
      mat4PerspectiveWebGL2(projection, Math.PI / 3, aspect, 0.1, 500);
    }
    const view = mat4LookAt(
      mat4Create(),
      { x: 0, y: 70, z: 140 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
    );
    return {
      viewProjection: mat4Multiply(mat4Create(), projection, view),
      model: mat4Identity(mat4Create()),
    };
  }
  if (backendName === "webgpu") {
    mat4PerspectiveWebGPU(projection, Math.PI / 4, aspect, 0.1, 100);
  } else {
    mat4PerspectiveWebGL2(projection, Math.PI / 4, aspect, 0.1, 100);
  }
  // The M0 directional light is fixed at (-0.45, -0.8, -0.35) and points from
  // the surface towards the light. Viewing from that side shows diffuse-lit
  // faces; viewing from (+x,+y,+z) leaves every visible face ambient-only.
  const view = mat4LookAt(
    mat4Create(),
    { x: -1.15, y: -0.95, z: -2.2 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
  );
  return {
    viewProjection: mat4Multiply(mat4Create(), projection, view),
    model: mat4Identity(mat4Create()),
  };
}

/**
 * Deterministic instanced transforms. The full fixture is a 50x100 grid on
 * the XZ plane, 1.5 m apart, centred on the origin, y=0.5, with
 * rotationY = (i * 0.37) mod 2pi. A smaller count keeps the same column count
 * and rows centred on the origin so fallback runs are still comparable.
 */
function createInstanceTransforms(count) {
  const transforms = new Float32Array(count * 16);
  const columns = Math.min(GRID_COLUMNS, count);
  const rows = Math.ceil(count / columns);
  const offsetX = ((columns - 1) * GRID_SPACING) / 2;
  const offsetZ = ((rows - 1) * GRID_SPACING) / 2;
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const angle = (index * 0.37) % TWO_PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const offset = index * 16;
    transforms[offset] = cos;
    transforms[offset + 1] = 0;
    transforms[offset + 2] = -sin;
    transforms[offset + 3] = 0;
    transforms[offset + 4] = 0;
    transforms[offset + 5] = 1;
    transforms[offset + 6] = 0;
    transforms[offset + 7] = 0;
    transforms[offset + 8] = sin;
    transforms[offset + 9] = 0;
    transforms[offset + 10] = cos;
    transforms[offset + 11] = 0;
    transforms[offset + 12] = column * GRID_SPACING - offsetX;
    transforms[offset + 13] = 0.5;
    transforms[offset + 14] = row * GRID_SPACING - offsetZ;
    transforms[offset + 15] = 1;
  }
  return transforms;
}

function renderFrame(device, camera, scene, transforms, instanceCount) {
  const frame = device.beginFrame();
  if (
    frame === null ||
    typeof frame !== "object" ||
    frame.valid !== true
  ) {
    throw new Error("beginFrame() did not return a valid RenderFrame");
  }
  frame.setCamera(camera.viewProjection);
  if (scene.instanced) {
    frame.drawInstanced(scene.mesh, scene.material, transforms, instanceCount);
  } else {
    frame.draw(scene.mesh, scene.material, camera.model);
  }
  device.endFrame();
}

/** Top-down RGBA readback with an FNV-1a 32-bit hash, gpu-rig style. */
function captureCanvas(source) {
  const width = source.width;
  const height = source.height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("canvas has no backing pixels to read");
  }
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const context = scratch.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  if (context === null) {
    throw new Error("2D capture context is unavailable");
  }
  context.drawImage(source, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;

  let hash = 0x811c9dc5;
  let nonClearPixels = 0;
  let brightPixels = 0;
  const colors = new Set();
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index];
    const g = pixels[index + 1];
    const b = pixels[index + 2];
    const a = pixels[index + 3];
    hash ^= r;
    hash = Math.imul(hash, 0x01000193);
    hash ^= g;
    hash = Math.imul(hash, 0x01000193);
    hash ^= b;
    hash = Math.imul(hash, 0x01000193);
    hash ^= a;
    hash = Math.imul(hash, 0x01000193);

    if (Math.abs(r - 11) + Math.abs(g - 15) + Math.abs(b - 20) > 12) {
      nonClearPixels += 1;
    }
    if (r + g + b > 120) {
      brightPixels += 1;
    }
    colors.add((r << 16) | (g << 8) | b);
  }

  return {
    width,
    height,
    hash: (hash >>> 0).toString(16).padStart(8, "0"),
    nonClearPixels,
    brightPixels,
    distinctColors: colors.size,
  };
}

/**
 * PNG snapshot of the same pixels `captureCanvas` hashed. Used by the WebGPU
 * loss case to preserve the recovered frame before the terminal second loss
 * clears the presented canvas.
 */
function captureCanvasPngDataUrl(source) {
  const scratch = document.createElement("canvas");
  scratch.width = source.width;
  scratch.height = source.height;
  const context = scratch.getContext("2d", { alpha: false });
  if (context === null) {
    throw new Error("2D PNG capture context is unavailable");
  }
  context.drawImage(source, 0, 0, scratch.width, scratch.height);
  return scratch.toDataURL("image/png");
}

function readBrowserInfo() {
  const userAgent = navigator.userAgent;
  const match = /(?:HeadlessChrome|Chrome|Chromium)\/(\d+(?:\.\d+)+)/.exec(
    userAgent,
  );
  return {
    name: match === null ? "unknown" : "Chrome",
    version: match === null ? null : match[1],
    userAgent,
  };
}

async function computeBuildHash() {
  if (
    typeof crypto === "undefined" ||
    crypto.subtle === undefined ||
    typeof crypto.subtle.digest !== "function"
  ) {
    const error = new Error("crypto.subtle is unavailable, so no build hash can be recorded");
    error.stage = "build-hash";
    error.code = "E_BUILD_HASH";
    throw error;
  }
  const loaded = performance
    .getEntriesByType("resource")
    .map((entry) => {
      try {
        return new URL(entry.name).pathname;
      } catch {
        return null;
      }
    })
    .filter(
      (pathname) =>
        typeof pathname === "string" &&
        pathname.startsWith("/packages/engine/") &&
        pathname.endsWith(".js"),
    );
  const modules = Array.from(new Set(loaded)).sort();
  if (modules.length === 0) {
    const error = new Error("no engine modules were visible in resource timing");
    error.stage = "build-hash";
    error.code = "E_BUILD_HASH";
    throw error;
  }
  const encoder = new TextEncoder();
  let bytes = 0;
  const sources = await Promise.all(
    modules.map(async (pathname) => {
      const response = await fetch(pathname, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`GET ${pathname} returned HTTP ${response.status}`);
      }
      const body = new Uint8Array(await response.arrayBuffer());
      bytes += body.byteLength;
      return { pathname, body };
    }),
  );
  const chunks = [];
  for (const source of sources) {
    chunks.push(
      encoder.encode(source.pathname),
      new Uint8Array([0]),
      source.body,
      new Uint8Array([0]),
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await new Blob(chunks).arrayBuffer(),
  );
  const hash = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return {
    hash,
    algorithm: "sha256",
    fileCount: modules.length,
    bytes,
    modules,
  };
}

function copyStats(stats) {
  const finite = (value) => (Number.isFinite(value) ? value : 0);
  return {
    drawCalls: finite(stats.drawCalls),
    triangles: finite(stats.triangles),
    instances: finite(stats.instances),
    culledInstances: finite(stats.culledInstances),
    pipelineSwitches: finite(stats.pipelineSwitches),
    bindGroupSwitches: finite(stats.bindGroupSwitches),
    textureBytes: finite(stats.textureBytes),
    bufferBytes: finite(stats.bufferBytes),
    uploadBytes: finite(stats.uploadBytes),
    uploadCalls: finite(stats.uploadCalls),
    gpuErrors: finite(stats.gpuErrors),
    droppedDraws: finite(stats.droppedDraws),
    gpuFrameMs: Number.isFinite(stats.gpuFrameMs) ? stats.gpuFrameMs : null,
    cpuFrameMs: finite(stats.cpuFrameMs),
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return null;
  }
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Render the fixture on rAF. The golden capture happens at frame 60 after 30
 * warm-up frames. Benchmark mode then spends 120 more warm-up frames and
 * records exactly 600 intervals. No capture, fetch or hash work happens in the
 * measured loop.
 */
function renderFixture(device, camera, scene, transforms, instanceCount, bench) {
  const totalFrames = bench
    ? CAPTURE_FRAME + BENCH_WARMUP_FRAMES + BENCH_MEASURED_FRAMES
    : CAPTURE_FRAME;
  const intervals = new Float64Array(BENCH_MEASURED_FRAMES);
  let captured = null;
  let capturedFrame = 0;
  let measured = 0;
  let previousTimestamp = null;
  let referenceStats = null;
  let statsConsistent = true;

  return new Promise((resolve, reject) => {
    let frame = 0;
    const onFrame = (timestamp) => {
      try {
        frame += 1;
        const interval =
          previousTimestamp === null ? null : timestamp - previousTimestamp;
        previousTimestamp = timestamp;
        renderFrame(device, camera, scene, transforms, instanceCount);

        if (frame === CAPTURE_FRAME) {
          captured = captureCanvas(canvas);
          capturedFrame = frame;
          const minContentPixels = Math.max(
            1000,
            Math.round(captured.width * captured.height * 0.01),
          );
          if (
            captured.distinctColors < 2 ||
            captured.nonClearPixels < minContentPixels
          ) {
            const blank = new Error(
              `canvas readback is blank: distinctColors=${captured.distinctColors}, ` +
                `nonClearPixels=${captured.nonClearPixels}/${captured.width * captured.height}, ` +
                `brightPixels=${captured.brightPixels}, hash=${captured.hash}`,
            );
            blank.stage = "capture";
            blank.code = "E_BLANK_CANVAS";
            blank.details = { capture: captured };
            throw blank;
          }
        }

        if (bench && frame > CAPTURE_FRAME + BENCH_WARMUP_FRAMES) {
          intervals[measured] = interval;
          measured += 1;
          const stats = copyStats(device.stats);
          if (referenceStats === null) {
            referenceStats = stats;
          } else if (
            stats.drawCalls !== referenceStats.drawCalls ||
            stats.triangles !== referenceStats.triangles ||
            stats.instances !== referenceStats.instances ||
            stats.droppedDraws !== referenceStats.droppedDraws
          ) {
            statsConsistent = false;
          }
        }

        if (frame >= totalFrames) {
          if (captured === null) {
            const error = new Error("golden capture frame was never reached");
            error.stage = "capture";
            error.code = "E_CAPTURE_MISSING";
            throw error;
          }
          resolve({
            capture: captured,
            capturedFrame,
            intervals,
            measured,
            statsConsistent,
            finalStats: copyStats(device.stats),
            framesRendered: frame,
          });
          return;
        }
        window.requestAnimationFrame(onFrame);
      } catch (error) {
        reject(error);
      }
    };
    window.requestAnimationFrame(onFrame);
  });
}

function buildBenchmark(rendered) {
  const sorted = Array.from(rendered.intervals.subarray(0, rendered.measured)).sort(
    (left, right) => left - right,
  );
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const max = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  const min = sorted.length > 0 ? sorted[0] : null;
  const targetMs = 14;
  const hardMs = 20;
  const status =
    p95 === null
      ? "no-samples"
      : p95 <= targetMs
        ? "target-met"
        : p95 <= hardMs
          ? "over-target-under-hard"
          : "hard-fail";
  return {
    enabled: true,
    method: "wall-clock requestAnimationFrame callback timestamp intervals",
    warmupFrames: BENCH_WARMUP_FRAMES,
    measuredFrames: BENCH_MEASURED_FRAMES,
    frameIntervalsMs: {
      count: sorted.length,
      min: min === null ? null : roundMs(min),
      p50: p50 === null ? null : roundMs(p50),
      p95: p95 === null ? null : roundMs(p95),
      max: max === null ? null : roundMs(max),
      percentileMethod: "nearest-rank",
    },
    budget: {
      targetMs,
      hardMs,
      targetMet: p95 !== null && p95 <= targetMs,
      hardFail: p95 !== null && p95 > hardMs,
      status,
    },
    statsConsistent: rendered.statsConsistent,
  };
}

function caseFailure(stage, code, message, details = null) {
  const error = new Error(message);
  error.stage = stage;
  error.code = code;
  if (details !== null) {
    error.details = details;
  }
  return error;
}

function decorateCaseError(error, stage, code) {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  if (typeof wrapped.stage !== "string") {
    wrapped.stage = stage;
  }
  if (typeof wrapped.code !== "string") {
    wrapped.code = code;
  }
  return wrapped;
}

function readDeviceSize(device) {
  const size = device.size;
  if (size === null || typeof size !== "object") {
    return null;
  }
  return {
    width: Number.isFinite(size.width) ? size.width : null,
    height: Number.isFinite(size.height) ? size.height : null,
  };
}

function snapshotSurface(device) {
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const dpr =
    typeof window.devicePixelRatio === "number" && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  const deviceSize = readDeviceSize(device);
  const expectedWidth = Math.max(1, Math.round(cssWidth * dpr));
  const expectedHeight = Math.max(1, Math.round(cssHeight * dpr));
  return {
    cssWidth,
    cssHeight,
    dpr,
    backingWidth: canvas.width,
    backingHeight: canvas.height,
    deviceSize,
    deviceSizeMatchesCss:
      deviceSize !== null &&
      deviceSize.width === cssWidth &&
      deviceSize.height === cssHeight,
    backingMatchesDpr:
      canvas.width === expectedWidth && canvas.height === expectedHeight,
    expectedBackingWidth: expectedWidth,
    expectedBackingHeight: expectedHeight,
  };
}

function captureHasContent(capture) {
  const minimum = Math.max(
    1000,
    Math.round(capture.width * capture.height * 0.01),
  );
  return capture.nonClearPixels >= minimum && capture.distinctColors >= 2;
}

function runResizeCase(device, camera, scene, transforms, instanceCount) {
  const dpr =
    typeof window.devicePixelRatio === "number" && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  const initial = snapshotSurface(device);
  renderFrame(device, camera, scene, transforms, instanceCount);
  const preFrame = {
    validFrame: true,
    stats: copyStats(device.stats),
  };
  const preCapture = captureCanvas(canvas);
  const changes = [];

  // Ten CSS-size changes in one task, before the next beginFrame(). WebGPU
  // marks its swapchain dirty and may configure only once at the next frame;
  // WebGL2 updates backing synchronously. Both are measured, not assumed.
  for (let index = 0; index < RESIZE_SEQUENCE.length; index += 1) {
    const target = RESIZE_SEQUENCE[index];
    applyStageSize(canvas, target.width, target.height);
    device.resize(target.width, target.height, dpr);
    changes.push({
      index: index + 1,
      cssRequestedWidth: target.width,
      cssRequestedHeight: target.height,
      canvasClientWidth: canvas.clientWidth,
      canvasClientHeight: canvas.clientHeight,
      deviceSize: readDeviceSize(device),
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      dpr: window.devicePixelRatio,
    });
  }

  return new Promise((resolve, reject) => {
    window.requestAnimationFrame(() => {
      try {
        renderFrame(device, camera, scene, transforms, instanceCount);
        const afterFrame = snapshotSurface(device);
        const stats = copyStats(device.stats);
        const capture = captureCanvas(canvas);
        const contentPresent = captureHasContent(capture);
        const deviceSizeCssOnEveryCall = changes.every(
          (change) =>
            change.deviceSize !== null &&
            change.deviceSize.width === change.canvasClientWidth &&
            change.deviceSize.height === change.canvasClientHeight,
        );
        let previousWidth = initial.cssWidth;
        let previousHeight = initial.cssHeight;
        const tenCssSizeChanges =
          changes.length === RESIZE_SEQUENCE.length &&
          changes.every((change) => {
            const changed =
              change.canvasClientWidth !== previousWidth ||
              change.canvasClientHeight !== previousHeight;
            previousWidth = change.canvasClientWidth;
            previousHeight = change.canvasClientHeight;
            return changed;
          });
        const pass = {
          tenResizeCalls: changes.length === 10,
          tenCssSizeChanges,
          deviceSizeCssOnEveryCall,
          backingFollowsDprAfterFrame: afterFrame.backingMatchesDpr,
          deviceSizeMatchesCssAfterFrame: afterFrame.deviceSizeMatchesCss,
          validFrameAfterResize: true,
          gpuErrorsZero: stats.gpuErrors === 0,
          contentPresent,
        };
        pass.all =
          pass.tenResizeCalls &&
          pass.tenCssSizeChanges &&
          pass.deviceSizeCssOnEveryCall &&
          pass.backingFollowsDprAfterFrame &&
          pass.deviceSizeMatchesCssAfterFrame &&
          pass.validFrameAfterResize &&
          pass.gpuErrorsZero &&
          pass.contentPresent;
        resolve({
          dpr,
          sequence: RESIZE_SEQUENCE.map((target) => ({
            width: target.width,
            height: target.height,
          })),
          resizeCalls: changes.length,
          frames: {
            total: 2,
            preResizeFrame: 1,
            postResizeFrame: 2,
          },
          initial,
          preFrame,
          preCapture,
          changes,
          afterFrame: {
            ...afterFrame,
            validFrame: true,
            stats,
          },
          capture,
          contentPresent,
          coalescing: {
            counterExposed: false,
            configureCalls: null,
            resizeCallsObserved: changes.length,
            reason:
              "The built renderer contract exposes no swapchain/configure counter. Ten resize() calls ran in one task; the page will not invent a configure count.",
          },
          pass,
        });
      } catch (error) {
        reject(decorateCaseError(error, "resize", "E_RESIZE_CASE"));
      }
    });
  });
}

function runContextLossCase(device, camera, scene, transforms, instanceCount) {
  const gl = canvas.getContext("webgl2");
  if (gl === null) {
    throw caseFailure(
      "context-loss",
      "E_CONTEXT_LOSS",
      "the canvas has no WebGL2 context to lose",
    );
  }
  const extension = gl.getExtension("WEBGL_lose_context");
  if (
    extension === null ||
    typeof extension.loseContext !== "function" ||
    typeof extension.restoreContext !== "function"
  ) {
    throw caseFailure(
      "context-loss",
      "E_UNSUPPORTED_FEATURE",
      "WEBGL_lose_context is unavailable; context loss cannot be triggered through the public page",
    );
  }

  const state = {
    frame: 0,
    phase: "warmup",
    preCapture: null,
    postCapture: null,
    firstValidAfterRestore: null,
    firstContentAfterRestore: null,
    invalidFramesWhileLost: 0,
    invalidFramesAfterRestore: 0,
    blankFramesAfterRestore: 0,
    lostEventFrame: null,
    restoredEventFrame: null,
    loseCallFrame: null,
    restoreCallFrame: null,
    epochBefore: device.contextEpoch,
    epochAfterLoss: null,
    epochAfterRestore: null,
    lostAfterLoss: null,
    lostAfterRestore: null,
    firstContentAtMs: null,
    timing: {
      loseCallAtMs: null,
      lostAtMs: null,
      restoreCallAtMs: null,
      restoredAtMs: null,
      firstContentAtMs: null,
    },
    uncaughtErrors: 0,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let cleanup = () => {};
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onLost = () => {
      if (state.lostEventFrame !== null) return;
      state.lostEventFrame = state.frame;
      state.timing.lostAtMs = performance.now();
      state.epochAfterLoss = device.contextEpoch;
      state.lostAfterLoss = device.lost === true;
      window.requestAnimationFrame(() => {
        if (settled) return;
        state.restoreCallFrame = state.frame;
        state.timing.restoreCallAtMs = performance.now();
        try {
          extension.restoreContext();
        } catch (error) {
          fail(decorateCaseError(error, "context-loss", "E_CONTEXT_LOSS"));
        }
      });
    };
    const onRestored = () => {
      if (state.restoredEventFrame !== null) return;
      state.restoredEventFrame = state.frame;
      state.timing.restoredAtMs = performance.now();
      state.epochAfterRestore = device.contextEpoch;
      state.lostAfterRestore = device.lost === true;
    };
    const onError = () => {
      state.uncaughtErrors += 1;
    };
    const onRejection = () => {
      state.uncaughtErrors += 1;
    };

    cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    timer = setTimeout(() => {
      fail(
        caseFailure(
          "context-loss",
          "E_CONTEXT_LOSS_TIMEOUT",
          `context loss/restore did not recover to content within ${CONTEXT_LOSS_TIMEOUT_MS} ms`,
          {
            frames: state.frame,
            lostEventFrame: state.lostEventFrame,
            restoredEventFrame: state.restoredEventFrame,
            invalidFramesAfterRestore: state.invalidFramesAfterRestore,
            blankFramesAfterRestore: state.blankFramesAfterRestore,
            epochBefore: state.epochBefore,
            epochAfterLoss: state.epochAfterLoss,
            epochAfterRestore: state.epochAfterRestore,
            lost: device.lost,
            gpuErrors: device.stats.gpuErrors,
          },
        ),
      );
    }, CONTEXT_LOSS_TIMEOUT_MS);

    const step = () => {
      if (settled) return;
      try {
        state.frame += 1;
        if (state.phase === "warmup") {
          renderFrame(device, camera, scene, transforms, instanceCount);
          if (state.frame >= CONTEXT_LOSS_WARMUP_FRAMES) {
            state.preCapture = captureCanvas(canvas);
            if (!captureHasContent(state.preCapture)) {
              throw caseFailure(
                "context-loss",
                "E_BLANK_CANVAS",
                "the pre-loss frame is blank, so post-restore content cannot be compared",
                { preCapture: state.preCapture },
              );
            }
            state.phase = "lost";
            state.loseCallFrame = state.frame;
            state.timing.loseCallAtMs = performance.now();
            extension.loseContext();
          }
        } else if (state.phase === "lost") {
          const frame = device.beginFrame();
          const valid = frame !== null && typeof frame === "object" && frame.valid === true;
          device.endFrame();
          if (!valid) {
            state.invalidFramesWhileLost += 1;
          }
          if (state.restoredEventFrame !== null) {
            state.phase = "post";
          }
        } else if (state.phase === "post") {
          const frame = device.beginFrame();
          if (frame === null || typeof frame !== "object" || frame.valid !== true) {
            device.endFrame();
            state.invalidFramesAfterRestore += 1;
            if (state.frame - state.restoredEventFrame > 120) {
              throw caseFailure(
                "context-loss",
                "E_CONTEXT_LOSS",
                "no valid frame was produced within 120 frames of the restored event",
                {
                  restoredEventFrame: state.restoredEventFrame,
                  frame: state.frame,
                  invalidFramesAfterRestore: state.invalidFramesAfterRestore,
                  lost: device.lost,
                  gpuErrors: device.stats.gpuErrors,
                },
              );
            }
          } else {
            if (state.firstValidAfterRestore === null) {
              state.firstValidAfterRestore = state.frame;
            }
            frame.setCamera(camera.viewProjection);
            if (scene.instanced) {
              frame.drawInstanced(
                scene.mesh,
                scene.material,
                transforms,
                instanceCount,
              );
            } else {
              frame.draw(scene.mesh, scene.material, camera.model);
            }
            device.endFrame();
            const capture = captureCanvas(canvas);
            if (captureHasContent(capture)) {
              state.postCapture = capture;
              state.firstContentAfterRestore = state.frame;
              state.timing.firstContentAtMs = performance.now();
              state.firstContentAtMs = state.timing.firstContentAtMs;
              const finalStats = copyStats(device.stats);
              const afterFrame = snapshotSurface(device);
              const recoveryToContent =
                state.firstContentAfterRestore - state.lostEventFrame;
              const framesFromRestoreToContent =
                state.firstContentAfterRestore - state.restoredEventFrame;
              const recoveryElapsedMs =
                state.timing.firstContentAtMs - state.timing.lostAtMs;
              const hashMatchesPreLoss =
                state.preCapture !== null &&
                capture.hash === state.preCapture.hash;
              const pass = {
                extensionAvailable: true,
                lossEventObserved: true,
                restoreEventObserved: true,
                epochIncremented:
                  state.epochAfterLoss !== null &&
                  state.epochAfterLoss > state.epochBefore &&
                  state.epochAfterRestore === state.epochAfterLoss,
                lostFlagSetAfterLoss: state.lostAfterLoss === true,
                lostFlagClearedAfterRestore: state.lostAfterRestore === false,
                firstFrameAfterRestoreHasContent:
                  state.blankFramesAfterRestore === 0,
                hashMatchesPreLoss,
                recoveryWithin60Frames:
                  recoveryToContent >= 0 && recoveryToContent <= 60,
                recoveryWithin1Second:
                  Number.isFinite(recoveryElapsedMs) &&
                  recoveryElapsedMs <= 1000,
                noUncaughtErrors: state.uncaughtErrors === 0,
                gpuErrorsZero: finalStats.gpuErrors === 0,
              };
              pass.all =
                pass.extensionAvailable &&
                pass.lossEventObserved &&
                pass.restoreEventObserved &&
                pass.epochIncremented &&
                pass.lostFlagSetAfterLoss &&
                pass.lostFlagClearedAfterRestore &&
                pass.firstFrameAfterRestoreHasContent &&
                pass.hashMatchesPreLoss &&
                pass.recoveryWithin60Frames &&
                pass.recoveryWithin1Second &&
                pass.noUncaughtErrors &&
                pass.gpuErrorsZero;
              finish({
                extension: "WEBGL_lose_context",
                extensionAvailable: true,
                warmupFrames: CONTEXT_LOSS_WARMUP_FRAMES,
                events: { lost: true, restored: true },
                epoch: {
                  before: state.epochBefore,
                  afterLoss: state.epochAfterLoss,
                  afterRestore: state.epochAfterRestore,
                  incremented: pass.epochIncremented,
                },
                lost: {
                  afterLoss: state.lostAfterLoss,
                  afterRestore: state.lostAfterRestore,
                },
                frames: {
                  total: state.frame,
                  loseCallFrame: state.loseCallFrame,
                  lostEventFrame: state.lostEventFrame,
                  restoreCallFrame: state.restoreCallFrame,
                  restoredEventFrame: state.restoredEventFrame,
                  firstValidAfterRestore: state.firstValidAfterRestore,
                  firstContentAfterRestore: state.firstContentAfterRestore,
                  recoveryToContent,
                  framesFromRestoreToContent,
                  invalidFramesWhileLost: state.invalidFramesWhileLost,
                  invalidFramesAfterRestore: state.invalidFramesAfterRestore,
                  blankFramesAfterRestore: state.blankFramesAfterRestore,
                },
                timing: {
                  ...state.timing,
                  recoveryElapsedMs,
                  timingBasis:
                    "performance.now() around real events; frame counts are the primary evidence",
                },
                preCapture: state.preCapture,
                postCapture: state.postCapture,
                hashMatchesPreLoss,
                uncaughtErrors: state.uncaughtErrors,
                finalStats,
                afterFrame: {
                  ...afterFrame,
                  validFrame: true,
                },
                pass,
              });
              return;
            }
            state.blankFramesAfterRestore += 1;
            if (state.frame - state.restoredEventFrame > 120) {
              throw caseFailure(
                "context-loss",
                "E_CONTEXT_LOSS",
                "frames are valid after restore but none has scene content within 120 frames",
                {
                  restoredEventFrame: state.restoredEventFrame,
                  frame: state.frame,
                  blankFramesAfterRestore: state.blankFramesAfterRestore,
                  lastCapture: capture,
                  lost: device.lost,
                  gpuErrors: device.stats.gpuErrors,
                },
              );
            }
          }
        }
        window.requestAnimationFrame(step);
      } catch (error) {
        fail(decorateCaseError(error, "context-loss", "E_CONTEXT_LOSS"));
      }
    };
    window.requestAnimationFrame(step);
  });
}

function readHandleIdentity(handle) {
  return {
    index:
      handle !== null && typeof handle === "object" && Number.isInteger(handle.index)
        ? handle.index
        : null,
    generation:
      handle !== null &&
      typeof handle === "object" &&
      Number.isInteger(handle.generation)
        ? handle.generation
        : null,
  };
}

function snapshotSceneHandles(scene) {
  return {
    mesh: readHandleIdentity(scene.mesh),
    material: readHandleIdentity(scene.material),
    texture: readHandleIdentity(scene.texture),
  };
}

function sceneHandlesUnchanged(before, after) {
  return ["mesh", "material", "texture"].every(
    (kind) =>
      before[kind].index !== null &&
      before[kind].index === after[kind].index &&
      before[kind].generation !== null &&
      before[kind].generation === after[kind].generation,
  );
}

/**
 * Real WebGPU device loss through the dev-only hook. The hook destroys the
 * host GPUDevice; Chrome's `device.lost` promise drives the engine's normal
 * loss/restore path. No loss event is synthesized by the page.
 */
async function runWebGpuContextLossCase(
  device,
  camera,
  scene,
  transforms,
  instanceCount,
) {
  if (typeof forceWebGpuDeviceLost !== "function") {
    throw caseFailure(
      "context-loss",
      "E_UNSUPPORTED_FEATURE",
      "the dev-only forceWebGpuDeviceLost hook did not load from @lanpad/engine-renderer-webgpu/dev",
    );
  }
  if (device.deviceState !== "running") {
    throw caseFailure(
      "context-loss",
      "E_DEVICE_LOST",
      `the WebGPU device is ${JSON.stringify(device.deviceState)}, not running, before the forced loss`,
    );
  }

  const handlesBefore = snapshotSceneHandles(scene);
  const state = {
    frame: 0,
    events: { lost: 0, restored: 0 },
    lossEvents: [],
    preCapture: null,
    preLossSurface: null,
    postCapture: null,
    postPngDataUrl: null,
    lostEventFrame: null,
    restoredEventFrame: null,
    secondLostEventFrame: null,
    loseCallFrame: null,
    restoreCallFrame: null,
    secondLoseCallFrame: null,
    firstValidAfterRestore: null,
    firstContentAfterRestore: null,
    invalidFramesWhileLost: 0,
    invalidFramesAfterRestore: 0,
    blankFramesAfterRestore: 0,
    beginFrameValidAfterLoss: null,
    beginFrameValidAfterSecondLoss: null,
    deviceState: {
      before: device.deviceState,
      afterLoss: null,
      afterRestore: null,
      afterSecondLoss: null,
      afterSecondRefusal: null,
    },
    timing: {
      loseCallAtMs: null,
      lostAtMs: null,
      restoreCallAtMs: null,
      restoredAtMs: null,
      firstContentAtMs: null,
      secondLoseCallAtMs: null,
      secondLostAtMs: null,
      secondRestoreCallAtMs: null,
      secondRestoreRefusedAtMs: null,
    },
    restoreResult: null,
    uncaughtErrors: 0,
  };

  let firstLostResolve = () => {};
  let firstRestoredResolve = () => {};
  let secondLostResolve = () => {};
  const firstLost = new Promise((resolve) => {
    firstLostResolve = resolve;
  });
  const firstRestored = new Promise((resolve) => {
    firstRestoredResolve = resolve;
  });
  const secondLost = new Promise((resolve) => {
    secondLostResolve = resolve;
  });

  const onLost = (info) => {
    state.events.lost += 1;
    const event = {
      count: state.events.lost,
      reason:
        info !== null &&
        typeof info === "object" &&
        typeof info.reason === "string"
          ? info.reason
          : null,
      message:
        info !== null &&
        typeof info === "object" &&
        typeof info.message === "string"
          ? info.message
          : null,
      frame: state.frame,
      atMs: performance.now(),
      deviceState: device.deviceState,
    };
    state.lossEvents.push(event);
    if (state.events.lost === 1) {
      state.lostEventFrame = state.frame;
      state.timing.lostAtMs = event.atMs;
      state.deviceState.afterLoss = device.deviceState;
      firstLostResolve(event);
    } else if (state.events.lost === 2) {
      state.secondLostEventFrame = state.frame;
      state.timing.secondLostAtMs = event.atMs;
      state.deviceState.afterSecondLoss = device.deviceState;
      secondLostResolve(event);
    }
  };
  const onRestored = () => {
    state.events.restored += 1;
    state.restoredEventFrame = state.frame;
    state.timing.restoredAtMs = performance.now();
    state.deviceState.afterRestore = device.deviceState;
    firstRestoredResolve({
      count: state.events.restored,
      frame: state.frame,
      atMs: state.timing.restoredAtMs,
      deviceState: device.deviceState,
    });
  };
  const onError = () => {
    state.uncaughtErrors += 1;
  };
  const onRejection = () => {
    state.uncaughtErrors += 1;
  };

  const unsubscribeLost = device.onDeviceLost(onLost);
  const unsubscribeRestored = device.onRestored(onRestored);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  const deadline = performance.now() + CONTEXT_LOSS_TIMEOUT_MS;
  const withDeadline = (promise, label) => {
    const remainingMs = Math.max(1, deadline - performance.now());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          caseFailure(
            "context-loss",
            "E_CONTEXT_LOSS_TIMEOUT",
            `${label} did not settle within the ${CONTEXT_LOSS_TIMEOUT_MS} ms case budget`,
            {
              frame: state.frame,
              deviceState: device.deviceState,
              events: { ...state.events },
              lostEventFrame: state.lostEventFrame,
              restoredEventFrame: state.restoredEventFrame,
            },
          ),
        );
      }, remainingMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  };

  try {
    for (let warmup = 0; warmup < CONTEXT_LOSS_WARMUP_FRAMES; warmup += 1) {
      await nextFrame();
      state.frame += 1;
      renderFrame(device, camera, scene, transforms, instanceCount);
    }
    state.preCapture = captureCanvas(canvas);
    state.preLossSurface = snapshotSurface(device);
    if (!captureHasContent(state.preCapture)) {
      throw caseFailure(
        "context-loss",
        "E_BLANK_CANVAS",
        "the pre-loss WebGPU frame is blank, so post-restore content cannot be compared",
        { preCapture: state.preCapture },
      );
    }

    state.loseCallFrame = state.frame;
    state.timing.loseCallAtMs = performance.now();
    const triggered = forceWebGpuDeviceLost(device);
    if (triggered !== true) {
      throw caseFailure(
        "context-loss",
        "E_DEVICE_LOST",
        "forceWebGpuDeviceLost() refused while the device was running",
        { deviceState: device.deviceState, result: triggered },
      );
    }
    await withDeadline(firstLost, "the first onDeviceLost event");
    state.deviceState.afterLoss = device.deviceState;

    const lostFrame = device.beginFrame();
    state.beginFrameValidAfterLoss =
      lostFrame !== null && typeof lostFrame === "object"
        ? lostFrame.valid === true
        : null;
    device.endFrame();
    if (state.beginFrameValidAfterLoss === false) {
      state.invalidFramesWhileLost = 1;
    }
    if (state.deviceState.afterLoss !== "lost") {
      throw caseFailure(
        "context-loss",
        "E_DEVICE_LOST",
        `deviceState after the real lost event is ${JSON.stringify(state.deviceState.afterLoss)}, expected "lost"`,
        { events: { ...state.events }, lossEvents: state.lossEvents },
      );
    }
    if (state.beginFrameValidAfterLoss !== false) {
      throw caseFailure(
        "context-loss",
        "E_DEVICE_LOST",
        "beginFrame() stayed valid while the device was lost",
        { beginFrameValidAfterLoss: state.beginFrameValidAfterLoss },
      );
    }

    state.restoreCallFrame = state.frame;
    state.timing.restoreCallAtMs = performance.now();
    const restoreResult = await withDeadline(device.restore(), "restore()");
    state.restoreResult = {
      ok: restoreResult?.ok === true,
      reason:
        typeof restoreResult?.reason === "string" ? restoreResult.reason : null,
      restoredHandles: Number.isFinite(restoreResult?.restoredHandles)
        ? restoreResult.restoredHandles
        : null,
      staleHandles: Number.isFinite(restoreResult?.staleHandles)
        ? restoreResult.staleHandles
        : null,
    };
    if (state.restoreResult.ok !== true) {
      throw caseFailure(
        "context-loss",
        "E_DEVICE_LOST",
        `restore() did not recover: ${JSON.stringify(state.restoreResult)}`,
        { deviceState: device.deviceState },
      );
    }
    await withDeadline(firstRestored, "the onRestored event");
    state.deviceState.afterRestore = device.deviceState;
    if (state.deviceState.afterRestore !== "running") {
      throw caseFailure(
        "context-loss",
        "E_DEVICE_LOST",
        `deviceState after onRestored is ${JSON.stringify(state.deviceState.afterRestore)}, expected "running"`,
        { restoreResult: state.restoreResult },
      );
    }
    const handlesAfterRestore = snapshotSceneHandles(scene);

    for (let postFrame = 0; postFrame < 120; postFrame += 1) {
      await nextFrame();
      state.frame += 1;
      const frame = device.beginFrame();
      const valid =
        frame !== null && typeof frame === "object" && frame.valid === true;
      if (!valid) {
        device.endFrame();
        state.invalidFramesAfterRestore += 1;
        continue;
      }
      if (state.firstValidAfterRestore === null) {
        state.firstValidAfterRestore = state.frame;
      }
      frame.setCamera(camera.viewProjection);
      if (scene.instanced) {
        frame.drawInstanced(
          scene.mesh,
          scene.material,
          transforms,
          instanceCount,
        );
      } else {
        frame.draw(scene.mesh, scene.material, camera.model);
      }
      device.endFrame();
      const capture = captureCanvas(canvas);
      if (captureHasContent(capture)) {
        state.postCapture = capture;
        state.postPngDataUrl = captureCanvasPngDataUrl(canvas);
        state.firstContentAfterRestore = state.frame;
        state.timing.firstContentAtMs = performance.now();
        break;
      }
      state.blankFramesAfterRestore += 1;
    }
    if (state.postCapture === null) {
      throw caseFailure(
        "context-loss",
        "E_BLANK_CANVAS",
        "no post-restore WebGPU frame produced scene content within 120 frames",
        {
          restoredEventFrame: state.restoredEventFrame,
          frame: state.frame,
          invalidFramesAfterRestore: state.invalidFramesAfterRestore,
          blankFramesAfterRestore: state.blankFramesAfterRestore,
          deviceState: device.deviceState,
          restoreResult: state.restoreResult,
        },
      );
    }

    const hashMatchesPreLoss =
      state.preCapture !== null &&
      state.preCapture.hash === state.postCapture.hash;
    const recoveryToContent =
      state.firstContentAfterRestore - state.lostEventFrame;
    const framesFromRestoreToContent =
      state.firstContentAfterRestore - state.restoredEventFrame;
    const recoveryElapsedMs =
      state.timing.firstContentAtMs - state.timing.lostAtMs;
    const finalStats = copyStats(device.stats);
    const afterFrame = snapshotSurface(device);
    const handlesUnchanged = sceneHandlesUnchanged(
      handlesBefore,
      handlesAfterRestore,
    );

    state.secondLoseCallFrame = state.frame;
    state.timing.secondLoseCallAtMs = performance.now();
    const secondLoss = {
      triggered: forceWebGpuDeviceLost(device) === true,
      eventObserved: false,
      event: null,
      stateAfterLoss: null,
      beginFrameValid: null,
      restoreAttempts: 0,
      restoreRefused: false,
      error: null,
      restoreResult: null,
      stateAfterRefusal: null,
    };
    if (!secondLoss.triggered) {
      throw caseFailure(
        "context-loss",
        "E_DEVICE_LOST",
        "forceWebGpuDeviceLost() refused after a successful restore",
        { deviceState: device.deviceState },
      );
    }
    secondLoss.event = await withDeadline(
      secondLost,
      "the second onDeviceLost event",
    );
    secondLoss.eventObserved = true;
    secondLoss.stateAfterLoss = device.deviceState;

    const secondFrame = device.beginFrame();
    secondLoss.beginFrameValid =
      secondFrame !== null && typeof secondFrame === "object"
        ? secondFrame.valid === true
        : null;
    device.endFrame();
    state.beginFrameValidAfterSecondLoss = secondLoss.beginFrameValid;

    secondLoss.restoreAttempts = 1;
    state.timing.secondRestoreCallAtMs = performance.now();
    try {
      secondLoss.restoreResult = await withDeadline(
        device.restore(),
        "the second restore()",
      );
    } catch (error) {
      secondLoss.error = serializeError(error);
    }
    state.timing.secondRestoreRefusedAtMs = performance.now();
    secondLoss.restoreRefused =
      secondLoss.error !== null &&
      secondLoss.error.code === "E_DEVICE_LOST";
    secondLoss.stateAfterRefusal = device.deviceState;
    state.deviceState.afterSecondRefusal = secondLoss.stateAfterRefusal;
    const terminalStats = copyStats(device.stats);

    if (secondLoss.stateAfterLoss !== "failed") {
      throw caseFailure(
        "context-loss",
        "E_DEVICE_LOST",
        `deviceState after the second loss is ${JSON.stringify(secondLoss.stateAfterLoss)}, expected "failed"`,
        { secondLoss },
      );
    }
    if (secondLoss.beginFrameValid !== false) {
      throw caseFailure(
        "context-loss",
        "E_DEVICE_LOST",
        "beginFrame() stayed valid while the terminal device was failed",
        { beginFrameValid: secondLoss.beginFrameValid },
      );
    }
    if (!secondLoss.restoreRefused || secondLoss.restoreResult !== null) {
      throw caseFailure(
        "context-loss",
        "E_DEVICE_LOST",
        "restore() did not refuse after the second loss with E_DEVICE_LOST",
        { secondLoss },
      );
    }
    if (secondLoss.stateAfterRefusal !== "failed") {
      throw caseFailure(
        "context-loss",
        "E_DEVICE_LOST",
        `deviceState after the refused restore is ${JSON.stringify(secondLoss.stateAfterRefusal)}, expected "failed"`,
        { secondLoss },
      );
    }

    const pass = {
      hookAvailable: true,
      hookTriggered: true,
      lossEventObserved: state.events.lost === 2,
      deviceLostStateObserved: state.deviceState.afterLoss === "lost",
      invalidFrameWhileLost: state.beginFrameValidAfterLoss === false,
      restoreResultOk: state.restoreResult.ok === true,
      restoreEventObserved: state.events.restored === 1,
      runningAfterRestore: state.deviceState.afterRestore === "running",
      handlesUnchanged,
      postRestoreContent: captureHasContent(state.postCapture),
      hashMatchesPreLoss,
      recoveryWithin60Frames:
        Number.isInteger(recoveryToContent) &&
        recoveryToContent >= 0 &&
        recoveryToContent <= 60,
      recoveryWithin2Seconds:
        Number.isFinite(recoveryElapsedMs) && recoveryElapsedMs <= 2000,
      blackFramesAtMostOne: state.blankFramesAfterRestore <= 1,
      secondHookTriggered: secondLoss.triggered,
      secondLossEventObserved: secondLoss.eventObserved,
      secondLossTerminal: secondLoss.stateAfterLoss === "failed",
      secondLossInvalidFrame: secondLoss.beginFrameValid === false,
      restoreRefused: secondLoss.restoreRefused,
      restoreAttemptsExactlyOne: secondLoss.restoreAttempts === 1,
      failedStateStable: secondLoss.stateAfterRefusal === "failed",
      gpuErrorsMatchLosses: terminalStats.gpuErrors === state.events.lost,
      noUncaughtErrors: state.uncaughtErrors === 0,
    };
    pass.all = Object.values(pass).every((value) => value === true);

    return {
      mechanism: "forceWebGpuDeviceLost",
      hookAvailable: true,
      hook: "@lanpad/engine-renderer-webgpu/dev#forceWebGpuDeviceLost",
      hookKind:
        "dev-only hook destroys the real GPUDevice; the device.lost promise drives the engine loss path",
      warmupFrames: CONTEXT_LOSS_WARMUP_FRAMES,
      events: {
        lost: state.events.lost === 2,
        restored: state.events.restored === 1,
        secondLost: state.events.lost === 2,
        counts: { ...state.events },
        lossEvents: state.lossEvents,
      },
      epoch: null,
      epochNote:
        "WebGPU has no contextEpoch; deviceState is the public lifecycle observable for this backend.",
      deviceState: state.deviceState,
      beginFrameValidAfterLoss: state.beginFrameValidAfterLoss,
      beginFrameValidAfterSecondLoss: state.beginFrameValidAfterSecondLoss,
      handles: {
        before: handlesBefore,
        afterRestore: handlesAfterRestore,
        unchanged: handlesUnchanged,
        reusedForPostFrame: state.postCapture !== null,
      },
      restoreResult: state.restoreResult,
      frames: {
        total: state.frame,
        loseCallFrame: state.loseCallFrame,
        lostEventFrame: state.lostEventFrame,
        restoreCallFrame: state.restoreCallFrame,
        restoredEventFrame: state.restoredEventFrame,
        secondLoseCallFrame: state.secondLoseCallFrame,
        secondLostEventFrame: state.secondLostEventFrame,
        firstValidAfterRestore: state.firstValidAfterRestore,
        firstContentAfterRestore: state.firstContentAfterRestore,
        recoveryToContent,
        framesFromRestoreToContent,
        invalidFramesWhileLost: state.invalidFramesWhileLost,
        invalidFramesAfterRestore: state.invalidFramesAfterRestore,
        blankFramesAfterRestore: state.blankFramesAfterRestore,
      },
      timing: {
        ...state.timing,
        recoveryElapsedMs,
        firstLossToRestoredEventMs:
          state.timing.restoredAtMs - state.timing.lostAtMs,
        restoreCallToRestoredEventMs:
          state.timing.restoredAtMs - state.timing.restoreCallAtMs,
        secondLossToRefusalMs:
          state.timing.secondRestoreRefusedAtMs -
          state.timing.secondLostAtMs,
        timingBasis:
          "performance.now() around the real device.lost/onRestored events; frame counts are the primary evidence",
      },
      preCapture: state.preCapture,
      preLossSurface: state.preLossSurface,
      postCapture: state.postCapture,
      sizeNote:
        "device.size is 0x0 before and after restore because this page calls init(surface) but never resize() outside the resize case; the swapchain and canvas backing still use the surface CSS metrics. This is not a restore regression.",
      recoveredFramePng: {
        dataUrl: state.postPngDataUrl,
        width: state.postCapture.width,
        height: state.postCapture.height,
        frame: state.firstContentAfterRestore,
        capturedAfterRestore: true,
        capturedBeforeSecondLoss: true,
        note:
          "2D canvas snapshot of the real WebGPU canvas after the first restore and before the terminal second loss, so the recovered frame survives in the artifact.",
      },
      hashMatchesPreLoss,
      unobserved: {
        noAssetRefetch: null,
        noGameRestart: null,
        reason:
          "This page loads no network assets for the case and runs no game/runtime loop, so asset refetch and game restart cannot be observed; both stay PENDING rather than claimed true.",
      },
      secondLoss: {
        ...secondLoss,
        gpuErrorsAtTerminal: terminalStats.gpuErrors,
        note:
          "The terminal failed state ends the run; restore() was called once and refused, not retried.",
      },
      firstLossStats: finalStats,
      terminalStats,
      finalStats,
      afterFrame: { ...afterFrame, validFrame: true, stats: finalStats },
      uncaughtErrors: state.uncaughtErrors,
      pass,
    };
  } finally {
    unsubscribeLost();
    unsubscribeRestored();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  }
}

function createLongTaskRecorder() {
  const recorder = {
    supported: false,
    observedCount: 0,
    maxDurationMs: null,
    totalDurationMs: 0,
    within8Ms: null,
    entries: [],
    note: null,
  };
  if (
    typeof PerformanceObserver !== "function" ||
    !Array.isArray(PerformanceObserver.supportedEntryTypes) ||
    !PerformanceObserver.supportedEntryTypes.includes("longtask")
  ) {
    recorder.note =
      "PerformanceObserver longtask entries are not supported by this browser; max task duration is null.";
    return { recorder, record: () => {}, stop: () => {} };
  }
  recorder.supported = true;
  recorder.note =
    "Long-task entries are only emitted for main-thread tasks longer than 50 ms; this measurement can neither prove nor refute an 8 ms bound.";
  let observer = null;
  const recordEntries = (entries) => {
    for (const entry of entries) {
      recorder.observedCount += 1;
      recorder.totalDurationMs += entry.duration;
      if (
        recorder.maxDurationMs === null ||
        entry.duration > recorder.maxDurationMs
      ) {
        recorder.maxDurationMs = entry.duration;
      }
      if (recorder.entries.length < 20) {
        recorder.entries.push({
          name: entry.name,
          startTime: entry.startTime,
          duration: entry.duration,
        });
      }
    }
  };
  try {
    observer = new PerformanceObserver((list) => recordEntries(list.getEntries()));
    observer.observe({ type: "longtask" });
  } catch (error) {
    recorder.supported = false;
    recorder.note = `longtask observation failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    if (observer !== null) {
      observer.disconnect();
      observer = null;
    }
  }
  return {
    recorder,
    record: recordEntries,
    stop: () => {
      if (observer === null) return;
      try {
        recordEntries(observer.takeRecords());
      } catch {
        // takeRecords is best-effort; observed entries are already kept.
      }
      observer.disconnect();
      observer = null;
    },
  };
}

async function runAssetsCase() {
  const module = await import("@lanpad/engine-assets");
  const recorderHandle = createLongTaskRecorder();
  const startedAt = performance.now();
  let library = null;
  let handle = null;
  let libraryInitMs = null;
  let assetLoadMs = null;
  let loadError = null;
  try {
    const initStartedAt = performance.now();
    library = await module.createAssetLibrary({
      gameId: ASSET_CASE.gameId,
      manifestUrl: ASSET_CASE.manifestUrl,
      maxDecodeWorkers: 1,
      verifyHashes: false,
    });
    libraryInitMs = performance.now() - initStartedAt;

    const loadStartedAt = performance.now();
    try {
      handle = await library.load(ASSET_CASE.assetId, { priority: "boot" });
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    } finally {
      assetLoadMs = performance.now() - loadStartedAt;
    }

    await nextFrame();
    await nextFrame();
    recorderHandle.stop();
    const endedAt = performance.now();

    let valueKind = null;
    let valueBytes = null;
    if (handle !== null && handle.state === "ready") {
      const value = handle.value;
      valueKind =
        value !== null &&
        typeof value === "object" &&
        typeof value.kind === "string"
          ? value.kind
          : null;
      valueBytes =
        value !== null &&
        typeof value === "object" &&
        value.bytes !== null &&
        typeof value.bytes === "object" &&
        Number.isFinite(value.bytes.byteLength)
          ? value.bytes.byteLength
          : null;
    }
    const failure =
      handle !== null &&
      handle.failed !== null &&
      typeof handle.failed === "object"
        ? {
            id: handle.failed.id,
            code: handle.failed.code,
            message: handle.failed.message,
            retryable: handle.failed.retryable,
          }
        : null;
    const progress = library.progress;
    const longTask = recorderHandle.recorder;
    const longTaskConsistent = longTask.supported
      ? longTask.observedCount === 0
        ? longTask.maxDurationMs === null
        : Number.isFinite(longTask.maxDurationMs) &&
          longTask.maxDurationMs >= 0
      : longTask.observedCount === 0 && longTask.maxDurationMs === null;
    const load = {
      state: handle?.state ?? null,
      failed: failure,
      loadError,
      handleBytes: Number.isFinite(handle?.bytes) ? handle.bytes : null,
      valueKind,
      valueBytes,
      loadedBytes: library.loadedBytes,
      budgetBytes: library.budgetBytes,
      progressFetched: progress.fetched,
      progressDeclared: progress.declared,
      progressState: progress.state,
      progressLoadedCount: progress.loadedCount,
      progressTotalCount: progress.totalCount,
      degraded: library.degraded,
      failures: Array.from(library.failures),
      inFlight: library.inFlight,
      libraryInitMs,
      assetLoadMs,
      elapsedMs: endedAt - startedAt,
    };
    const resourceTiming = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.endsWith("/fixtures/five-mb.woff2"))
      .map((entry) => ({
        name: entry.name,
        duration: entry.duration,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
        responseEnd: entry.responseEnd,
      }));

    const pass = {
      libraryCreated: true,
      loadSucceeded:
        handle !== null && handle.state === "ready" && handle.failed === null,
      loadedBytesExact:
        handle?.bytes === ASSET_CASE.expectedBytes &&
        library.loadedBytes === ASSET_CASE.expectedBytes &&
        progress.fetched === ASSET_CASE.expectedBytes,
      woff2Decoded:
        valueKind === "woff2" &&
        valueBytes === ASSET_CASE.expectedBytes &&
        handle?.bytes === ASSET_CASE.expectedBytes,
      longTaskConsistent,
      within8MsClaimed: false,
    };
    pass.all =
      pass.libraryCreated &&
      pass.loadSucceeded &&
      pass.loadedBytesExact &&
      pass.woff2Decoded &&
      pass.longTaskConsistent;

    const caseResult = {
      fixture: {
        manifestUrl: ASSET_CASE.manifestUrl,
        assetId: ASSET_CASE.assetId,
        expectedBytes: ASSET_CASE.expectedBytes,
        expectedContentType: "font/woff2",
        synthetic: true,
        note: "Generated by run.mjs: a 5 MiB WOFF2 whose header is accepted by the built font decoder; payload bytes are synthetic.",
      },
      longTask,
      load,
      resourceTiming,
      pass,
    };
    if (pass.all !== true) {
      throw caseFailure(
        "assets",
        "E_ASSET_CASE",
        `asset case failed its checks (state=${String(load.state)}, loadedBytes=${load.loadedBytes}, valueBytes=${String(valueBytes)})`,
        { caseResult },
      );
    }

    const build = await computeBuildHash();
    const browser = readBrowserInfo();
    if (browser.version === null) {
      throw caseFailure(
        "build-hash",
        "E_BROWSER_VERSION",
        `could not determine a Chrome version from ${JSON.stringify(browser.userAgent)}`,
      );
    }
    return {
      schema: SCHEMA,
      ok: true,
      stage: "done",
      case: "assets",
      scene: request.scene.id,
      sceneKey: request.sceneKey,
      requestedBackend,
      backend: null,
      fallbackReason: null,
      adapter: null,
      features: [],
      browser,
      buildHash: build.hash,
      build: {
        algorithm: build.algorithm,
        fileCount: build.fileCount,
        bytes: build.bytes,
        modules: build.modules,
      },
      size: null,
      framesRendered: 0,
      drawCalls: null,
      triangles: null,
      instances: null,
      textureBytes: null,
      gpuErrors: null,
      hash: null,
      benchmark: null,
      stats: null,
      caseResult,
      notes: [
        "The 5 MiB file is a runner-generated synthetic WOFF2 loaded through the real @lanpad/engine-assets library and font decoder.",
        "Long-task entries are emitted only for tasks longer than 50 ms; within8Ms is null and no sub-8 ms claim is made.",
        "No renderer frame is produced in the asset case; draw/triangle/texture statistics are null.",
      ],
    };
  } catch (error) {
    recorderHandle.stop();
    throw decorateCaseError(error, "assets", "E_ASSET_CASE");
  } finally {
    if (handle !== null && typeof handle.release === "function") {
      try {
        handle.release();
      } catch {
        // Best-effort release; the case result is already captured.
      }
    }
    if (library !== null && typeof library.dispose === "function") {
      try {
        library.dispose();
      } catch {
        // Best-effort teardown.
      }
    }
  }
}

function caseStatusLines(result) {
  const caseResult = result.caseResult;
  if (result.case === "resize") {
    return [
      `resize   ${caseResult.resizeCalls} calls in one task, DPR ${caseResult.dpr}, final ${caseResult.afterFrame.cssWidth}x${caseResult.afterFrame.cssHeight} CSS -> ${caseResult.afterFrame.backingWidth}x${caseResult.afterFrame.backingHeight} backing`,
      `checks   deviceSize=CSS ${caseResult.pass.deviceSizeCssOnEveryCall}, backing=DPR ${caseResult.pass.backingFollowsDprAfterFrame}, gpuErrors=${caseResult.afterFrame.stats.gpuErrors}, content=${caseResult.contentPresent}`,
      `coalesce counter exposed=false, configureCalls=null (not invented)`,
    ];
  }
  if (result.case === "contextloss") {
    if (caseResult.mechanism === "forceWebGpuDeviceLost") {
      const states = caseResult.deviceState;
      const second = caseResult.secondLoss;
      return [
        `loss     hook frame ${caseResult.frames.loseCallFrame}, lost event frame ${caseResult.frames.lostEventFrame}, restored event frame ${caseResult.frames.restoredEventFrame}, state ${states.before} -> ${states.afterLoss} -> ${states.afterRestore}`,
        `recover  content frame ${caseResult.frames.firstContentAfterRestore} (${caseResult.frames.recoveryToContent} frames after loss, ${caseResult.frames.framesFromRestoreToContent} after restore), ${caseResult.timing.recoveryElapsedMs} ms, hashMatch=${caseResult.hashMatchesPreLoss}, handlesUnchanged=${caseResult.handles.unchanged}`,
        `terminal second loss state=${second.stateAfterLoss}, beginFrameValid=${second.beginFrameValid}, restoreAttempts=${second.restoreAttempts}, refused=${second.restoreRefused} (${second.error?.code ?? "no error"}), stable=${second.stateAfterRefusal}, gpuErrors=${second.gpuErrorsAtTerminal}`,
      ];
    }
    return [
      `loss     lose call frame ${caseResult.frames.loseCallFrame}, lost event frame ${caseResult.frames.lostEventFrame}, restored event frame ${caseResult.frames.restoredEventFrame}`,
      `recover  content frame ${caseResult.frames.firstContentAfterRestore} (${caseResult.frames.recoveryToContent} frames after loss, ${caseResult.frames.framesFromRestoreToContent} after restore), ${caseResult.timing.recoveryElapsedMs} ms`,
      `epoch    ${caseResult.epoch.before} -> ${caseResult.epoch.afterLoss} (lost=${caseResult.lost.afterLoss}, restored lost=${caseResult.lost.afterRestore}), hashMatch=${caseResult.hashMatchesPreLoss}, uncaught=${caseResult.uncaughtErrors}, gpuErrors=${caseResult.finalStats.gpuErrors}`,
    ];
  }
  if (result.case === "assets") {
    const longTask = caseResult.longTask;
    return [
      `asset    ${caseResult.load.state}, ${caseResult.load.loadedBytes} loaded bytes, WOFF2 ${String(caseResult.load.valueBytes)} bytes`,
      `longtask supported=${longTask.supported}, observed=${longTask.observedCount}, max=${longTask.maxDurationMs === null ? "null" : `${longTask.maxDurationMs} ms`}, within8Ms=null`,
      `budget   ${caseResult.load.loadedBytes}/${caseResult.load.budgetBytes} bytes, degraded=${caseResult.load.degraded}, init=${caseResult.load.libraryInitMs} ms, load=${caseResult.load.assetLoadMs} ms`,
    ];
  }
  return [];
}

async function attemptCaseBackend(name) {
  let stage = "device";
  let device = null;
  try {
    setStatus([
      `Starting ${name} for case ${request.case}…`,
      "Creating the real device, scene and case-specific measurement.",
    ]);

    canvas = replaceCanvas(canvas);
    applyStageSize(canvas, request.width, request.height);
    await nextFrame();
    const surface = readSurface(canvas);

    let created;
    if (name === "webgpu") {
      const module = await import("/packages/engine/renderer-webgpu/dist/index.js");
      created = await module.createWebGpuDevice({
        powerPreference: "high-performance",
      });
      device = created.device;
      stage = "init";
      await device.init(surface);
    } else {
      const module = await import("/packages/engine/renderer-webgl2/dist/index.js");
      created = await module.createWebGL2Device({
        canvas,
        antialias: false,
        desynchronized: false,
        powerPreference: "high-performance",
      });
      device = created.device;
    }

    stage = "scene";
    const scene = createScene(device, name, request.sceneKey);
    const camera = createCameraMatrices(name, canvas, request.sceneKey);
    const transforms =
      request.sceneKey === "scene5000"
        ? createInstanceTransforms(request.instances)
        : null;

    stage = request.case;
    const caseResult =
      request.case === "resize"
        ? await runResizeCase(
            device,
            camera,
            scene,
            transforms,
            request.instances,
          )
        : name === "webgpu"
          ? await runWebGpuContextLossCase(
              device,
              camera,
              scene,
              transforms,
              request.instances,
            )
          : await runContextLossCase(
              device,
              camera,
              scene,
              transforms,
              request.instances,
            );

    stage = "build-hash";
    const build = await computeBuildHash();
    const browser = readBrowserInfo();
    if (browser.version === null) {
      throw caseFailure(
        "build-hash",
        "E_BROWSER_VERSION",
        `could not determine a Chrome version from ${JSON.stringify(browser.userAgent)}`,
      );
    }

    const finalStats =
      request.case === "resize"
        ? caseResult.afterFrame.stats
        : caseResult.finalStats;
    const finalSurface = caseResult.afterFrame;
    const capture =
      request.case === "resize" ? caseResult.capture : caseResult.postCapture;
    return {
      schema: SCHEMA,
      ok: true,
      stage: "done",
      case: request.case,
      scene: request.scene.id,
      sceneKey: request.sceneKey,
      requestedBackend,
      backend: name,
      fallbackReason: null,
      adapter: typeof created.adapterInfo === "string" ? created.adapterInfo : null,
      features:
        created.capabilities !== null &&
        typeof created.capabilities === "object" &&
        created.capabilities.features !== undefined
          ? Array.from(created.capabilities.features)
          : [],
      browser,
      buildHash: build.hash,
      build: {
        algorithm: build.algorithm,
        fileCount: build.fileCount,
        bytes: build.bytes,
        modules: build.modules,
      },
      fixture: {
        name: request.scene.id,
        specInstances: request.sceneKey === "scene5000" ? GRID_SPEC_INSTANCES : 1,
        instances: request.instances,
        cssWidth: finalSurface.cssWidth,
        cssHeight: finalSurface.cssHeight,
        captureWarmupFrames: 0,
        captureFrame:
          request.case === "resize"
            ? caseResult.frames?.total ?? 2
            : caseResult.frames.firstContentAfterRestore,
        conformant: false,
      },
      size: {
        cssWidth: finalSurface.cssWidth,
        cssHeight: finalSurface.cssHeight,
        dpr: finalSurface.dpr,
        width: finalSurface.backingWidth,
        height: finalSurface.backingHeight,
      },
      texture: {
        created: true,
        label:
          request.sceneKey === "scene5000"
            ? "m0-grid-checker-texture"
            : "m0-checker-texture",
        width: TEXTURE_SIZE,
        height: TEXTURE_SIZE,
        format: TEXTURE_FORMAT,
        usage: scene.textureUsage,
        bytes: TEXTURE_SIZE * TEXTURE_SIZE * 4,
      },
      light: {
        kind: "built-in-directional",
        configurable: false,
      },
      framesRendered:
        request.case === "resize" ? 2 : caseResult.frames.total,
      drawCalls: finalStats.drawCalls,
      triangles: finalStats.triangles,
      instances: finalStats.instances,
      textureBytes: finalStats.textureBytes,
      gpuErrors: finalStats.gpuErrors,
      hash: capture.hash,
      nonClearPixels: capture.nonClearPixels,
      brightPixels: capture.brightPixels,
      distinctColors: capture.distinctColors,
      capture: {
        method: "canvas-2d-drawImage+getImageData",
        width: capture.width,
        height: capture.height,
        frame:
          request.case === "resize"
            ? 2
            : caseResult.frames.firstContentAfterRestore,
        warmupFrames: 0,
      },
      benchmark: null,
      stats: finalStats,
      caseResult,
      notes: [
        "The directional light is fixed inside the M0 shader; the built public API has no light object.",
        name === "webgpu"
          ? "Texture usage is sample+copy-dst because the WebGPU validator requires copy-dst for supplied bytes."
          : "Texture usage is sample only because the WebGL2 M0 validator rejects copy-dst.",
        "Build hash is SHA-256 over the engine JS modules the page actually loaded, sorted by path.",
        request.case === "resize"
          ? "Ten resize() calls ran in one task. No public configure counter exists, so coalescing is reported as not measurable."
          : request.case === "contextloss" && name === "webgpu"
            ? "The real GPUDevice was destroyed through the dev-only forceWebGpuDeviceLost hook; the device.lost promise drove loss and restore. The second loss is terminal, restore() was called once and refused, and the run ended. Frame counts, not fabricated milliseconds, are the primary evidence."
            : "Context loss was triggered through WEBGL_lose_context; frame counts, not fabricated milliseconds, are the primary evidence.",
      ],
    };
  } catch (error) {
    if (device !== null && typeof device.dispose === "function") {
      try {
        device.dispose();
      } catch {
        // Best-effort teardown; the original failure is what matters.
      }
    }
    const info = serializeError(error);
    const wrapped = new Error(info.message);
    wrapped.name = info.name;
    if (info.code !== null) {
      wrapped.code = info.code;
    }
    wrapped.stage = typeof error?.stage === "string" ? error.stage : stage;
    wrapped.backend = name;
    wrapped.cause = error;
    if (error?.details !== undefined) {
      wrapped.details = error.details;
    }
    throw wrapped;
  }
}

async function attemptBackend(name) {
  let stage = "device";
  let device = null;
  try {
    setStatus([
      `Starting ${name}…`,
      `Scene ${request.scene.id}, ${request.instances} instance(s), ${request.width}x${request.height}, bench=${request.bench ? "on" : "off"}.`,
      "Creating device, mesh, material, texture, camera and the deterministic render loop.",
    ]);

    canvas = replaceCanvas(canvas);
    applyStageSize(canvas, request.width, request.height);
    await nextFrame();
    const surface = readSurface(canvas);

    let created;
    if (name === "webgpu") {
      const module = await import("/packages/engine/renderer-webgpu/dist/index.js");
      created = await module.createWebGpuDevice({
        powerPreference: "high-performance",
      });
      device = created.device;
      stage = "init";
      await device.init(surface);
    } else {
      const module = await import("/packages/engine/renderer-webgl2/dist/index.js");
      created = await module.createWebGL2Device({
        canvas,
        antialias: false,
        // The engine defaults to desynchronized:true. In headless Chrome that
        // low-latency path produced a stale, blue-only readback; a normal
        // swapchain is what the demo needs to verify pixels.
        desynchronized: false,
        powerPreference: "high-performance",
      });
      device = created.device;
    }

    stage = "scene";
    const scene = createScene(device, name, request.sceneKey);
    const camera = createCameraMatrices(name, canvas, request.sceneKey);
    const transforms =
      request.sceneKey === "scene5000"
        ? createInstanceTransforms(request.instances)
        : null;

    stage = "render";
    const rendered = await renderFixture(
      device,
      camera,
      scene,
      transforms,
      request.instances,
      request.bench,
    );

    stage = "build-hash";
    const build = await computeBuildHash();
    const browser = readBrowserInfo();
    if (browser.version === null) {
      const versionError = new Error(
        `could not determine a Chrome version from ${JSON.stringify(browser.userAgent)}`,
      );
      versionError.stage = "build-hash";
      versionError.code = "E_BROWSER_VERSION";
      throw versionError;
    }

    const capture = rendered.capture;
    const finalStats = rendered.finalStats;
    const benchmark = request.bench ? buildBenchmark(rendered) : null;
    // A.1 fixes the cube fixture at 640x360 and one instance; A.2 fixes
    // scene5000 at 5000 instances and 1920x1080. Any other size/count is a
    // labelled lab fallback, never target evidence.
    const fixtureConformant =
      request.sceneKey === "scene5000"
        ? request.instances === GRID_SPEC_INSTANCES &&
          surface.cssWidth === 1920 &&
          surface.cssHeight === 1080
        : request.instances === 1 &&
          surface.cssWidth === 640 &&
          surface.cssHeight === 360;
    if (benchmark !== null) {
      Object.assign(benchmark, {
        drawCalls: finalStats.drawCalls,
        triangles: finalStats.triangles,
        instances: finalStats.instances,
        textureBytes: finalStats.textureBytes,
        gpuErrors: finalStats.gpuErrors,
        adapter:
          typeof created.adapterInfo === "string" ? created.adapterInfo : null,
        browser,
        buildHash: build.hash,
        size: {
          cssWidth: surface.cssWidth,
          cssHeight: surface.cssHeight,
          dpr: surface.dpr,
          width: canvas.width,
          height: canvas.height,
        },
        stats: finalStats,
      });
    }

    return {
      schema: SCHEMA,
      ok: true,
      stage: "done",
      scene: request.scene.id,
      sceneKey: request.sceneKey,
      requestedBackend,
      backend: name,
      fallbackReason: null,
      adapter: typeof created.adapterInfo === "string" ? created.adapterInfo : null,
      features:
        created.capabilities !== null &&
        typeof created.capabilities === "object" &&
        created.capabilities.features !== undefined
          ? Array.from(created.capabilities.features)
          : [],
      browser,
      buildHash: build.hash,
      build: {
        algorithm: build.algorithm,
        fileCount: build.fileCount,
        bytes: build.bytes,
        modules: build.modules,
      },
      fixture: {
        name: request.scene.id,
        specInstances: request.sceneKey === "scene5000" ? GRID_SPEC_INSTANCES : 1,
        instances: request.instances,
        cssWidth: surface.cssWidth,
        cssHeight: surface.cssHeight,
        captureWarmupFrames: CAPTURE_WARMUP_FRAMES,
        captureFrame: CAPTURE_FRAME,
        conformant: fixtureConformant,
      },
      size: {
        cssWidth: surface.cssWidth,
        cssHeight: surface.cssHeight,
        dpr: surface.dpr,
        width: canvas.width,
        height: canvas.height,
      },
      texture: {
        created: true,
        label:
          request.sceneKey === "scene5000"
            ? "m0-grid-checker-texture"
            : "m0-checker-texture",
        width: TEXTURE_SIZE,
        height: TEXTURE_SIZE,
        format: TEXTURE_FORMAT,
        usage: scene.textureUsage,
        bytes: TEXTURE_SIZE * TEXTURE_SIZE * 4,
      },
      light: {
        kind: "built-in-directional",
        configurable: false,
      },
      framesRendered: rendered.framesRendered,
      drawCalls: finalStats.drawCalls,
      triangles: finalStats.triangles,
      instances: finalStats.instances,
      textureBytes: finalStats.textureBytes,
      gpuErrors: finalStats.gpuErrors,
      hash: capture.hash,
      nonClearPixels: capture.nonClearPixels,
      brightPixels: capture.brightPixels,
      distinctColors: capture.distinctColors,
      capture: {
        method: "canvas-2d-drawImage+getImageData",
        width: capture.width,
        height: capture.height,
        frame: rendered.capturedFrame,
        warmupFrames: CAPTURE_WARMUP_FRAMES,
      },
      benchmark,
      stats: finalStats,
      notes: [
        "The directional light is fixed inside the M0 shader; the built public API has no light object.",
        name === "webgpu"
          ? "Texture usage is sample+copy-dst because the WebGPU validator requires copy-dst for supplied bytes."
          : "Texture usage is sample only because the WebGL2 M0 validator rejects copy-dst.",
        "Build hash is SHA-256 over the engine JS modules the page actually loaded, sorted by path.",
        request.sceneKey === "scene5000" && !fixtureConformant
          ? "FALLBACK: this run is not the 5,000-instance 1920x1080 fixture; it must not be reported as ER-04-02/ER-05-03 evidence."
          : null,
      ].filter((note) => note !== null),
    };
  } catch (error) {
    if (device !== null && typeof device.dispose === "function") {
      try {
        device.dispose();
      } catch {
        // Best-effort teardown; the original failure is what matters.
      }
    }
    const info = serializeError(error);
    const wrapped = new Error(info.message);
    wrapped.name = info.name;
    if (info.code !== null) {
      wrapped.code = info.code;
    }
    wrapped.stage = typeof error?.stage === "string" ? error.stage : stage;
    wrapped.backend = name;
    wrapped.cause = error;
    if (error?.details !== undefined) {
      wrapped.details = error.details;
    }
    throw wrapped;
  }
}

function finishSuccess(result) {
  document.body.classList.remove("failed");
  document.body.classList.add("passed");
  markSelected(result.backend);
  window.__M0__ = result;
  window.__M0_DONE__ = true;
  if (typeof result.case === "string") {
    setStatus([
      `PASS  case ${result.case}${result.backend === null ? "" : ` (${result.backend})`}`,
      ...caseStatusLines(result),
      `elapsed  ${result.elapsedMs} ms`,
    ]);
    return;
  }
  const benchLines =
    result.benchmark === null
      ? []
      : [
          `frames   p50 ${result.benchmark.frameIntervalsMs.p50} ms, p95 ${result.benchmark.frameIntervalsMs.p95} ms, max ${result.benchmark.frameIntervalsMs.max} ms (${result.benchmark.frameIntervalsMs.count} measured, ${result.benchmark.budget.status})`,
        ];
  setStatus([
    `PASS  ${result.backend}`,
    `scene    ${result.scene}, ${result.instances} instance(s), ${result.size.cssWidth}x${result.size.cssHeight} CSS, DPR ${result.size.dpr}`,
    `adapter  ${result.adapter ?? "unknown"}`,
    `browser  ${result.browser.version}`,
    `build    ${result.buildHash}`,
    `hash     ${result.hash} (frame ${result.capture.frame})`,
    `pixels   ${result.capture.width}x${result.capture.height}, content=${result.nonClearPixels}, colors=${result.distinctColors}`,
    `draw     ${result.drawCalls} call(s), ${result.triangles} triangle(s), ${result.instances} instance(s)`,
    `texture  ${result.texture.width}x${result.texture.height} ${result.texture.format} usage=${result.texture.usage.join("+")} (stats textureBytes=${result.textureBytes})`,
    `gpuErrors ${result.gpuErrors}`,
    ...benchLines,
    `elapsed  ${result.elapsedMs} ms`,
  ]);
}

function finishFailure(error, attempts) {
  const info = serializeError(error);
  document.body.classList.remove("passed");
  document.body.classList.add("failed");
  const result = {
    schema: SCHEMA,
    ok: false,
    stage: typeof error?.stage === "string" ? error.stage : "boot",
    scene: request.scene.id,
    sceneKey: request.sceneKey,
    requestedBackend,
    instances: request.instances,
    case: request.case,
    bench: request.bench,
    backend: typeof error?.backend === "string" ? error.backend : null,
    blocked: error?.blocked === true,
    blocker: error?.blocker ?? null,
    error: info,
    missingCall:
      info.code === "E_UNSUPPORTED_FEATURE" ||
      /not implemented|unsupported/i.test(info.message)
        ? info.message
        : null,
    attempts,
    details: error?.details ?? null,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
  window.__M0__ = result;
  window.__M0_DONE__ = true;
  setStatus([
    `FAIL  ${result.backend ?? requestedBackend} at ${result.stage}`,
    `${info.code === null ? "" : `[${info.code}] `}${info.message}`,
    result.blocked ? "BLOCKED — no frame is claimed as a pass." : null,
    result.missingCall === null ? null : `blocked call: ${result.missingCall}`,
    ...attempts.map(
      (attempt) =>
        `attempt ${attempt.backend}: ${attempt.stage}: ${
          attempt.error.code === null ? "" : `[${attempt.error.code}] `
        }${attempt.error.message}`,
    ),
    "No frame was published as a pass.",
  ]);
}

async function run() {
  markSelected(requestedBackend);

  if (requestError !== null) {
    finishFailure(requestError, []);
    return;
  }
  if (!VALID_BACKENDS.has(requestedBackend)) {
    const error = new Error(
      `unknown backend ${JSON.stringify(requestedRaw)}; expected auto, webgpu or webgl2`,
    );
    error.stage = "query";
    error.code = "E_USAGE";
    finishFailure(error, []);
    return;
  }

  if (request.case === "assets") {
    if (requestedBackend === "webgpu" || requestedBackend === "webgl2") {
      setStatus([
        `Asset case does not create a renderer; ignoring backend=${requestedBackend}.`,
      ]);
    }
    try {
      const result = await runAssetsCase();
      result.elapsedMs = Math.round(performance.now() - startedAt);
      result.fallbackReason = null;
      finishSuccess(result);
    } catch (error) {
      const wrapped = decorateCaseError(error, "assets", "E_ASSET_CASE");
      const info = serializeError(wrapped);
      const failure = new Error(info.message);
      failure.name = info.name;
      if (info.code !== null) {
        failure.code = info.code;
      }
      failure.stage = wrapped.stage;
      failure.backend = null;
      failure.cause = wrapped;
      if (wrapped.details !== undefined) {
        failure.details = wrapped.details;
      }
      finishFailure(failure, []);
    }
    return;
  }

  const order =
    requestedBackend === "auto" ? ["webgpu", "webgl2"] : [requestedBackend];
  const attempts = [];
  const attempt = request.case === null ? attemptBackend : attemptCaseBackend;

  for (const name of order) {
    try {
      const result = await attempt(name);
      result.elapsedMs = Math.round(performance.now() - startedAt);
      result.fallbackReason =
        requestedBackend === "auto" && attempts.length > 0
          ? attempts
              .map(
                (attempt) =>
                  `${attempt.backend} failed at ${attempt.stage}: ${attempt.error.message}`,
              )
              .join(" | ")
          : null;
      finishSuccess(result);
      return;
    } catch (error) {
      const info = serializeError(error);
      attempts.push({
        backend: name,
        stage: typeof error?.stage === "string" ? error.stage : "unknown",
        error: info,
      });
      if (requestedBackend !== "auto") {
        finishFailure(error, attempts);
        return;
      }
    }
  }

  const failure = new Error(
    `no backend produced a frame: ${attempts
      .map((attempt) => `${attempt.backend} ${attempt.error.message}`)
      .join("; ")}`,
  );
  failure.stage = "backend-selection";
  failure.code = "E_BACKEND_SELECTION";
  failure.backend =
    attempts.length > 0 ? attempts[attempts.length - 1].backend : null;
  finishFailure(failure, attempts);
}

for (const button of backendButtons) {
  button.addEventListener("click", () => {
    const target = button.dataset.backend ?? "auto";
    const url = new URL(window.location.href);
    if (target === "auto") {
      url.searchParams.delete("backend");
    } else {
      url.searchParams.set("backend", target);
    }
    window.location.assign(url.toString());
  });
}

run().catch((error) => {
  finishFailure(error, []);
});

/* Generated from bench.ts by experiments/e03/build.mjs. Do not edit directly. */
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { ProbeError, errorMessage } from "../shared/probe.js";
import { createReport, formatReport } from "../shared/report.js";
import {
  DrawCallCounter,
  E3_ATLAS_CELLS,
  E3_ATLAS_SIZE,
  E3_PASS_FPS,
  E3_RESULT_SCHEMA_VERSION,
  E3_RESOLUTIONS,
  E3_SAMPLING_PLAN,
  FrameSampler,
  MESH_BYTES_PER_VERTEX,
  MESH_QUAD_COLUMNS,
  MESH_QUAD_ROWS,
  MESH_TRIANGLE_COUNT,
  MESH_VERTEX_COUNT,
  SCENES,
  buildRunPlan,
  createRunResult,
  evaluatePassCriterion,
  formatRunRow
} from "./stats.js";
const QUAD_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 aOffset;
layout(location = 2) in vec2 aSize;
layout(location = 3) in vec2 aCell;
uniform vec2 uViewport;
out vec2 vUv;
void main() {
  vec2 pixel = aOffset + (aCorner - 0.5) * aSize;
  vec2 clip = (pixel / uViewport) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  // Half-texel inset keeps linear filtering inside one atlas cell.
  vec2 inset = vec2(0.00390625);
  vUv = (aCell + inset + aCorner * (1.0 - 2.0 * inset)) / 16.0;
}
`;
const QUAD_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uAtlas;
out vec4 outColor;
void main() {
  outColor = texture(uAtlas, vUv);
}
`;
const MESH_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vNormal = aNormal;
  vWorld = aPosition;
  gl_Position = vec4(aPosition.xy, aPosition.z * 0.5, 1.0);
}
`;
const MESH_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec3 vNormal;
in vec3 vWorld;
out vec4 outColor;
void main() {
  vec3 light = normalize(vec3(0.35, 0.6, 0.8));
  float shade = max(dot(normalize(vNormal), light), 0.0);
  float pattern = 0.5 + 0.5 * sin(vWorld.x * 9.0) * cos(vWorld.y * 7.0);
  vec3 base = vec3(0.25 + 0.35 * pattern, 0.35 + 0.25 * pattern, 0.6);
  outColor = vec4(base * (0.35 + 0.65 * shade), 1.0);
}
`;
const QUAD_CORNERS = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const INSTANCE_FLOATS = 6;
function buildInstanceData(count, width, height) {
  const data = new Float32Array(count * INSTANCE_FLOATS);
  const aspect = width / height;
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count) * aspect)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const base = index * INSTANCE_FLOATS;
    data[base] = (column + 0.5) * cellWidth;
    data[base + 1] = (row + 0.5) * cellHeight;
    data[base + 2] = cellWidth;
    data[base + 3] = cellHeight;
    data[base + 4] = index % E3_ATLAS_CELLS;
    data[base + 5] = Math.floor(index / E3_ATLAS_CELLS) % E3_ATLAS_CELLS;
  }
  return data;
}
function compileShader(gl, type, source) {
  var _a;
  const shader = gl.createShader(type);
  if (shader === null) throw new ProbeError("gl.createShader returned null");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const log = (_a = gl.getShaderInfoLog(shader)) != null ? _a : "(no info log)";
    gl.deleteShader(shader);
    throw new ProbeError(`Shader compile failed: ${log}`);
  }
  return shader;
}
function createProgram(gl, vertexSource, fragmentSource) {
  var _a;
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (program === null) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new ProbeError("gl.createProgram returned null");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.detachShader(program, vertex);
  gl.detachShader(program, fragment);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
    const log = (_a = gl.getProgramInfoLog(program)) != null ? _a : "(no info log)";
    gl.deleteProgram(program);
    throw new ProbeError(`Program link failed: ${log}`);
  }
  return program;
}
class WebGLBenchRenderer {
  constructor(canvas) {
    __publicField(this, "canvas");
    __publicField(this, "gl");
    __publicField(this, "maxTextureSize");
    __publicField(this, "gpuVendor");
    __publicField(this, "gpuRenderer");
    __publicField(this, "timerQueryAvailable");
    __publicField(this, "contextAttributes");
    __publicField(this, "contextLost", false);
    __publicField(this, "quadProgram");
    __publicField(this, "quadVao");
    __publicField(this, "quadCornerBuffer");
    __publicField(this, "instanceBuffer");
    __publicField(this, "quadViewportLocation");
    __publicField(this, "quadAtlasLocation");
    __publicField(this, "meshProgram");
    __publicField(this, "atlasTexture");
    __publicField(this, "timerExtension");
    __publicField(this, "pendingQueries", []);
    __publicField(this, "activeQuery", null);
    __publicField(this, "meshVao", null);
    __publicField(this, "meshVertexBuffer", null);
    __publicField(this, "meshNormalBuffer", null);
    __publicField(this, "meshIndexBuffer", null);
    __publicField(this, "meshIndexCount", 0);
    __publicField(this, "meshBuilt", false);
    __publicField(this, "instanceCount", 0);
    __publicField(this, "viewportWidth", 0);
    __publicField(this, "viewportHeight", 0);
    this.canvas = canvas;
    let context = null;
    try {
      context = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: true,
        stencil: false,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false
      });
    } catch (error) {
      throw new ProbeError(`WebGL2 context creation threw: ${errorMessage(error)}`);
    }
    if (context === null) {
      throw new ProbeError(
        'WebGL2 context creation failed: getContext("webgl2") returned null'
      );
    }
    const gl = context;
    this.gl = gl;
    this.contextAttributes = gl.getContextAttributes();
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.maxTextureSize = typeof maxTextureSize === "number" ? maxTextureSize : 0;
    let vendor = null;
    let renderer = null;
    try {
      const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
      if (debugInfo !== null) {
        const vendorValue = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        const rendererValue = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        if (typeof vendorValue === "string") vendor = vendorValue;
        if (typeof rendererValue === "string") renderer = rendererValue;
      }
    } catch {
      vendor = null;
      renderer = null;
    }
    this.gpuVendor = vendor;
    this.gpuRenderer = renderer;
    let timerExtension = null;
    try {
      timerExtension = gl.getExtension(
        "EXT_disjoint_timer_query_webgl2"
      );
    } catch {
      timerExtension = null;
    }
    this.timerExtension = timerExtension;
    this.timerQueryAvailable = timerExtension !== null;
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.contextLost = true;
    });
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.04, 0.05, 0.08, 1);
    this.quadProgram = createProgram(gl, QUAD_VERTEX_SHADER, QUAD_FRAGMENT_SHADER);
    this.quadViewportLocation = gl.getUniformLocation(this.quadProgram, "uViewport");
    this.quadAtlasLocation = gl.getUniformLocation(this.quadProgram, "uAtlas");
    const cornerBuffer = gl.createBuffer();
    const instanceBuffer = gl.createBuffer();
    const quadVao = gl.createVertexArray();
    if (cornerBuffer === null || instanceBuffer === null || quadVao === null) {
      throw new ProbeError("WebGL2 buffer or vertex-array creation returned null");
    }
    this.quadCornerBuffer = cornerBuffer;
    this.instanceBuffer = instanceBuffer;
    this.quadVao = quadVao;
    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_CORNERS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, INSTANCE_FLOATS * 4, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, INSTANCE_FLOATS * 4, 2 * 4);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, INSTANCE_FLOATS * 4, 4 * 4);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    this.meshProgram = createProgram(gl, MESH_VERTEX_SHADER, MESH_FRAGMENT_SHADER);
    this.atlasTexture = this.createAtlasTexture();
  }
  createAtlasTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (texture === null) throw new ProbeError("gl.createTexture returned null");
    const size = E3_ATLAS_SIZE;
    const cellPixels = size / E3_ATLAS_CELLS;
    const pixels = new Uint8Array(size * size * 4);
    for (let cellY = 0; cellY < E3_ATLAS_CELLS; cellY += 1) {
      for (let cellX = 0; cellX < E3_ATLAS_CELLS; cellX += 1) {
        const red = (cellX * 37 + cellY * 17) % 256;
        const green = (cellX * 13 + cellY * 53 + 64) % 256;
        const blue = (cellX * 71 + cellY * 7 + 128) % 256;
        for (let y = 0; y < cellPixels; y += 1) {
          const pixelY = cellY * cellPixels + y;
          let offset = (pixelY * size + cellX * cellPixels) * 4;
          for (let x = 0; x < cellPixels; x += 1) {
            const checker = ((x >> 4 ^ y >> 4) & 1) === 0 ? 255 : 160;
            pixels[offset] = red * checker >> 8;
            pixels[offset + 1] = green * checker >> 8;
            pixels[offset + 2] = blue * checker >> 8;
            pixels[offset + 3] = 255;
            offset += 4;
          }
        }
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      size,
      size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels
    );
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return texture;
  }
  ensureMesh() {
    if (this.meshBuilt) return;
    const gl = this.gl;
    const columns = MESH_QUAD_COLUMNS;
    const rows = MESH_QUAD_ROWS;
    const positions = new Float32Array(MESH_VERTEX_COUNT * 3);
    const normals = new Float32Array(MESH_VERTEX_COUNT * 3);
    const indices = new Uint32Array(MESH_TRIANGLE_COUNT * 3);
    for (let row = 0; row <= rows; row += 1) {
      for (let column = 0; column <= columns; column += 1) {
        const index = row * (columns + 1) + column;
        const x = -1 + 2 * column / columns;
        const y = -1 + 2 * row / rows;
        const z = 0.06 * Math.sin(x * 3) * Math.cos(y * 2.5);
        positions[index * 3] = x;
        positions[index * 3 + 1] = y;
        positions[index * 3 + 2] = z;
        const dzdx = 0.06 * 3 * Math.cos(x * 3) * Math.cos(y * 2.5);
        const dzdy = -0.06 * 2.5 * Math.sin(x * 3) * Math.sin(y * 2.5);
        const length = Math.hypot(dzdx, dzdy, 1);
        normals[index * 3] = -dzdx / length;
        normals[index * 3 + 1] = -dzdy / length;
        normals[index * 3 + 2] = 1 / length;
      }
    }
    let cursor = 0;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const a = row * (columns + 1) + column;
        const b = a + 1;
        const d = a + columns + 1;
        const e = d + 1;
        indices[cursor] = a;
        indices[cursor + 1] = b;
        indices[cursor + 2] = d;
        indices[cursor + 3] = b;
        indices[cursor + 4] = e;
        indices[cursor + 5] = d;
        cursor += 6;
      }
    }
    const positionBuffer = gl.createBuffer();
    const normalBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (positionBuffer === null || normalBuffer === null || indexBuffer === null || vao === null) {
      throw new ProbeError("WebGL2 static-mesh buffer creation returned null");
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, MESH_BYTES_PER_VERTEX, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, MESH_BYTES_PER_VERTEX, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.meshVao = vao;
    this.meshVertexBuffer = positionBuffer;
    this.meshNormalBuffer = normalBuffer;
    this.meshIndexBuffer = indexBuffer;
    this.meshIndexCount = indices.length;
    this.meshBuilt = true;
  }
  /** Uploads per-run instance data and resizes the drawing buffer (DPR 1). */
  prepareScene(scene, width, height) {
    if (this.contextLost) throw new ProbeError("WebGL2 context is lost");
    const gl = this.gl;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.viewportWidth = width;
    this.viewportHeight = height;
    gl.viewport(0, 0, width, height);
    if (scene.kind === "instanced-quads") {
      const data = buildInstanceData(scene.instances, width, height);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.instanceCount = scene.instances;
    } else {
      this.ensureMesh();
    }
  }
  /** Draws one frame and returns the number of draw calls issued. */
  renderScene(scene) {
    if (this.contextLost) throw new ProbeError("WebGL2 context is lost");
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (scene.kind === "instanced-quads") {
      gl.useProgram(this.quadProgram);
      gl.bindVertexArray(this.quadVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
      gl.uniform1i(this.quadAtlasLocation, 0);
      gl.uniform2f(this.quadViewportLocation, this.viewportWidth, this.viewportHeight);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.instanceCount);
    } else {
      gl.useProgram(this.meshProgram);
      gl.bindVertexArray(this.meshVao);
      gl.drawElements(gl.TRIANGLES, this.meshIndexCount, gl.UNSIGNED_INT, 0);
    }
    return scene.drawCallsPerFrame;
  }
  beginGpuQuery() {
    if (this.timerExtension === null || this.activeQuery !== null) return;
    if (this.pendingQueries.length >= 16) return;
    const query = this.gl.createQuery();
    if (query === null) return;
    this.gl.beginQuery(this.timerExtension.TIME_ELAPSED_EXT, query);
    this.activeQuery = query;
  }
  endGpuQuery() {
    var _a, _b;
    if (this.activeQuery === null) return;
    this.gl.endQuery((_b = (_a = this.timerExtension) == null ? void 0 : _a.TIME_ELAPSED_EXT) != null ? _b : 0);
    this.pendingQueries.push(this.activeQuery);
    this.activeQuery = null;
  }
  /** Returns completed GPU times in milliseconds; unavailable queries stay queued. */
  pollGpuTimes() {
    const gl = this.gl;
    const times = [];
    if (this.timerExtension === null) return times;
    let disjoint = false;
    try {
      disjoint = gl.getParameter(this.timerExtension.GPU_DISJOINT_EXT) === true;
    } catch {
      disjoint = true;
    }
    if (disjoint) {
      for (const query of this.pendingQueries) gl.deleteQuery(query);
      this.pendingQueries = [];
      if (this.activeQuery !== null) {
        gl.endQuery(this.timerExtension.TIME_ELAPSED_EXT);
        gl.deleteQuery(this.activeQuery);
        this.activeQuery = null;
      }
      return times;
    }
    const stillPending = [];
    for (const query of this.pendingQueries) {
      let available = false;
      try {
        available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) === true;
      } catch {
        available = false;
      }
      if (!available) {
        stillPending.push(query);
        continue;
      }
      try {
        const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT);
        if (typeof nanoseconds === "number" && Number.isFinite(nanoseconds)) {
          times.push(nanoseconds / 1e6);
        }
      } catch {
      }
      gl.deleteQuery(query);
    }
    this.pendingQueries = stillPending;
    return times;
  }
  get info() {
    return {
      maxTextureSize: this.maxTextureSize,
      gpuVendor: this.gpuVendor,
      gpuRenderer: this.gpuRenderer,
      timerQueryAvailable: this.timerQueryAvailable,
      contextAttributes: this.contextAttributes,
      contextLost: this.contextLost
    };
  }
  dispose() {
    const gl = this.gl;
    for (const query of this.pendingQueries) gl.deleteQuery(query);
    this.pendingQueries = [];
    if (this.activeQuery !== null) {
      gl.deleteQuery(this.activeQuery);
      this.activeQuery = null;
    }
    gl.deleteProgram(this.quadProgram);
    gl.deleteProgram(this.meshProgram);
    gl.deleteBuffer(this.quadCornerBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteTexture(this.atlasTexture);
    gl.deleteVertexArray(this.quadVao);
    if (this.meshVao !== null) gl.deleteVertexArray(this.meshVao);
    if (this.meshVertexBuffer !== null) gl.deleteBuffer(this.meshVertexBuffer);
    if (this.meshNormalBuffer !== null) gl.deleteBuffer(this.meshNormalBuffer);
    if (this.meshIndexBuffer !== null) gl.deleteBuffer(this.meshIndexBuffer);
  }
}
const TABLE_HEADERS = [
  "Scene",
  "Resolution",
  "Frames",
  "Mean ms",
  "p50 ms",
  "p95 ms",
  "FPS",
  "Draw calls/frame",
  "Draw calls/s",
  "Visible instances",
  "GPU ms p50/p95",
  "GPU mem MB",
  "Status"
];
function requireElement(root, id) {
  const element = root.getElementById(id);
  return element === null ? null : element;
}
function benchElementsFromDocument(root = document) {
  const runButton = requireElement(root, "run");
  const stopButton = requireElement(root, "stop");
  const copyButton = requireElement(root, "copy");
  const statusHost = requireElement(root, "status");
  const gpuHost = requireElement(root, "gpu");
  const tableHost = requireElement(root, "results");
  const jsonHost = requireElement(root, "json");
  const canvas = requireElement(root, "canvas");
  if (runButton === null || stopButton === null || copyButton === null || statusHost === null || gpuHost === null || tableHost === null || jsonHost === null || canvas === null) {
    return null;
  }
  return {
    runButton,
    stopButton,
    copyButton,
    statusHost,
    gpuHost,
    tableHost,
    jsonHost,
    canvas
  };
}
function documentHasFocus() {
  return typeof document.hasFocus === "function" ? document.hasFocus() : false;
}
async function copyText(text) {
  try {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : void 0;
    if (clipboard !== void 0 && typeof clipboard.writeText === "function") {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.className = "copy-buffer";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}
function yieldToPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}
function describePhase(phase, samples) {
  switch (phase) {
    case "warmup":
      return "warming up (2 s, discarded)";
    case "discard":
      return "discarding the first 30 frames";
    case "measure":
      return `measuring (${samples} frames kept)`;
    case "done":
      return "measured";
    case "stopped":
      return "stopped";
  }
}
function mountBenchPage(elements, options = {}) {
  var _a;
  const clock = (_a = options.now) != null ? _a : (() => /* @__PURE__ */ new Date());
  const plannedRuns = buildRunPlan();
  let rowRefs = [];
  let latestJson = null;
  let running = false;
  let stopRequested = false;
  function setStatus(message) {
    elements.statusHost.textContent = message;
  }
  function renderTable() {
    elements.tableHost.textContent = "";
    const head = elements.tableHost.createTHead();
    const headerRow = head.insertRow();
    for (const heading of TABLE_HEADERS) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = heading;
      headerRow.appendChild(cell);
    }
    const body = elements.tableHost.createTBody();
    rowRefs = plannedRuns.map((planned) => {
      const row = body.insertRow();
      const cells = [];
      for (let index = 0; index < TABLE_HEADERS.length; index += 1) {
        const cell = row.insertCell();
        cell.textContent = index === 0 ? planned.scene.id : index === 1 ? planned.resolution.label : "-";
        cells.push(cell);
      }
      const statusCell = cells[TABLE_HEADERS.length - 1];
      if (statusCell !== void 0) statusCell.textContent = "pending";
      return { row, cells };
    });
  }
  function updateRow(index, result) {
    var _a2, _b;
    const refs = rowRefs[index];
    if (refs === void 0) return;
    const values = formatRunRow(result);
    for (let cellIndex = 0; cellIndex < values.length; cellIndex += 1) {
      const cell = refs.cells[cellIndex];
      if (cell !== void 0) cell.textContent = (_a2 = values[cellIndex]) != null ? _a2 : "";
    }
    const statusCell = refs.cells[values.length - 1];
    if (statusCell !== void 0) {
      statusCell.className = result.status === "ok" ? "status-pass" : result.status === "pending" || result.status === "running" ? "" : "status-fail";
    }
    refs.row.title = (_b = result.note) != null ? _b : "";
  }
  function renderFailureTable(message) {
    elements.tableHost.textContent = "";
    const head = elements.tableHost.createTHead();
    const headerRow = head.insertRow();
    for (const heading of ["Check", "Status", "Detail"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = heading;
      headerRow.appendChild(cell);
    }
    const body = elements.tableHost.createTBody();
    const row = body.insertRow();
    const check = row.insertCell();
    check.textContent = "WebGL2 setup";
    const status = row.insertCell();
    status.textContent = "FAIL";
    status.className = "status-fail";
    const detail = row.insertCell();
    detail.textContent = message;
  }
  function describeGpu(info) {
    var _a2;
    const gpu = (_a2 = info.gpuRenderer) != null ? _a2 : "unknown GPU";
    const vendor = info.gpuVendor === null ? "" : ` (${info.gpuVendor})`;
    return `WebGL2: yes | max texture: ${info.maxTextureSize} px | GPU: ${gpu}${vendor} | GPU timer query: ${info.timerQueryAvailable ? "yes" : "no"} | canvas: ${elements.canvas.width}x${elements.canvas.height}, DPR 1`;
  }
  function buildMetadata(info, results, failure) {
    var _a2, _b, _c, _d, _e, _f;
    const passCriterion = evaluatePassCriterion(
      results.map((result) => ({
        sceneId: result.sceneId,
        width: result.width,
        height: result.height,
        fps: result.fps
      }))
    );
    const metadata = {
      resultSchemaVersion: E3_RESULT_SCHEMA_VERSION,
      webgl2: info !== null,
      maxTextureSize: (_a2 = info == null ? void 0 : info.maxTextureSize) != null ? _a2 : null,
      gpuVendor: (_b = info == null ? void 0 : info.gpuVendor) != null ? _b : null,
      gpuRenderer: (_c = info == null ? void 0 : info.gpuRenderer) != null ? _c : null,
      gpuTimerQueryAvailable: (_d = info == null ? void 0 : info.timerQueryAvailable) != null ? _d : false,
      contextLost: (_e = info == null ? void 0 : info.contextLost) != null ? _e : false,
      contextAttributes: (_f = info == null ? void 0 : info.contextAttributes) != null ? _f : null,
      samplingPlan: E3_SAMPLING_PLAN,
      scenes: SCENES,
      resolutions: E3_RESOLUTIONS,
      passCriterion,
      frameTimeSource: "requestAnimationFrame wall-clock at DPR 1; GPU timer query is supplemental when available",
      tab: {
        visibilityState: typeof document === "undefined" ? "unknown" : document.visibilityState,
        hasFocus: documentHasFocus()
      },
      rafThrottleSuspected: typeof document !== "undefined" && document.visibilityState !== "visible" || results.some((result) => result.longFrames > 0),
      screen: typeof screen === "undefined" ? null : {
        width: screen.width,
        height: screen.height,
        devicePixelRatio: typeof devicePixelRatio === "number" ? devicePixelRatio : null
      },
      userAgent: typeof navigator === "undefined" ? null : navigator.userAgent
    };
    if (failure !== void 0) metadata.failure = failure;
    return metadata;
  }
  function buildReport(info, results, failure) {
    var _a2;
    const metadata = buildMetadata(info, results, failure);
    const passCriterion = metadata.passCriterion;
    const checks = [
      {
        id: "pass-criterion",
        label: `Pass criterion: >= ${E3_PASS_FPS} fps at 720p with 1k+ instances`,
        status: passCriterion.evaluated && passCriterion.pass ? "pass" : "fail",
        durationMs: 0,
        value: passCriterion,
        error: passCriterion.pass ? null : passCriterion.reason
      }
    ];
    for (const result of results) {
      checks.push({
        id: `${result.sceneId}@${result.resolutionLabel}`,
        label: `${result.sceneLabel} @ ${result.width}x${result.height}`,
        status: result.status === "ok" ? "pass" : "fail",
        durationMs: 0,
        value: result,
        error: result.status === "ok" ? null : (_a2 = result.note) != null ? _a2 : result.status
      });
    }
    return createReport("E3", "TV render benchmark", checks, clock().toISOString(), metadata);
  }
  function publishReport(report) {
    latestJson = formatReport(report).json;
    elements.jsonHost.textContent = latestJson;
  }
  function skippedResult(planned, info, note) {
    var _a2;
    return createRunResult({
      plan: planned,
      status: "skipped",
      summary: null,
      gpuTimes: [],
      gpuTimerAvailable: (_a2 = info == null ? void 0 : info.timerQueryAvailable) != null ? _a2 : false,
      note
    });
  }
  function measureRun(activeRenderer, planned, index, total) {
    return new Promise((resolve) => {
      const sampler = new FrameSampler(E3_SAMPLING_PLAN);
      const counter = new DrawCallCounter();
      const gpuTimes = [];
      let lastStatusUpdate = 0;
      try {
        activeRenderer.prepareScene(
          planned.scene,
          planned.resolution.width,
          planned.resolution.height
        );
      } catch (error) {
        resolve({
          plan: planned,
          status: "error",
          summary: null,
          gpuTimes,
          gpuTimerAvailable: activeRenderer.timerQueryAvailable,
          note: errorMessage(error)
        });
        return;
      }
      const finish = (status, note) => {
        const summary = sampler.getSummary();
        const throttled = summary !== null && summary.longFrames > 0 ? `${summary.longFrames} frame(s) over 100 ms; keep the tab focused and fullscreen.` : null;
        const combined = note === null ? throttled : throttled === null ? note : `${note} ${throttled}`;
        resolve({
          plan: planned,
          status,
          summary,
          gpuTimes,
          gpuTimerAvailable: activeRenderer.timerQueryAvailable,
          note: combined
        });
      };
      const step = (timestamp) => {
        if (stopRequested) sampler.stop();
        if (!activeRenderer.contextLost) {
          try {
            activeRenderer.beginGpuQuery();
            counter.beginFrame();
            const drawCalls = activeRenderer.renderScene(planned.scene);
            counter.record(drawCalls);
            const frameDrawCalls = counter.endFrame();
            activeRenderer.endGpuQuery();
            sampler.push(timestamp, frameDrawCalls, planned.scene.visibleInstances);
          } catch (error) {
            finish("error", errorMessage(error));
            return;
          }
        }
        const polled = activeRenderer.pollGpuTimes();
        for (const value of polled) gpuTimes.push(value);
        if (activeRenderer.contextLost) {
          finish("context-lost", "WebGL2 context lost during the run.");
          return;
        }
        if (sampler.isFinished) {
          finish(
            sampler.currentPhase === "stopped" ? "aborted" : "ok",
            sampler.currentPhase === "stopped" ? "Stopped by the operator." : null
          );
          return;
        }
        if (timestamp - lastStatusUpdate >= 250) {
          lastStatusUpdate = timestamp;
          setStatus(
            `Run ${index + 1}/${total}: ${planned.scene.label} @ ${planned.resolution.width}x${planned.resolution.height} - ${describePhase(
              sampler.currentPhase,
              sampler.sampleCount
            )}`
          );
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  async function run() {
    var _a2;
    if (running) return;
    running = true;
    stopRequested = false;
    elements.runButton.disabled = true;
    elements.stopButton.disabled = false;
    elements.copyButton.disabled = true;
    elements.jsonHost.textContent = "Not run.";
    setStatus("Creating WebGL2 context...");
    let results = plannedRuns.map(
      (planned) => createRunResult({
        plan: planned,
        status: "pending",
        summary: null,
        gpuTimes: [],
        gpuTimerAvailable: false,
        note: "Not run yet."
      })
    );
    renderTable();
    await yieldToPaint();
    let activeRenderer = null;
    try {
      activeRenderer = new WebGLBenchRenderer(elements.canvas);
    } catch (error) {
      const message = errorMessage(error);
      renderFailureTable(message);
      elements.gpuHost.textContent = `WebGL2: no | ${message}`;
      publishReport(buildReport(null, results, message));
      setStatus(`WebGL2 setup failed: ${message}`);
      elements.runButton.disabled = false;
      elements.stopButton.disabled = true;
      elements.copyButton.disabled = false;
      running = false;
      return;
    }
    elements.gpuHost.textContent = describeGpu(activeRenderer.info);
    setStatus("WebGL2 ready. Starting warm-up...");
    try {
      for (let index = 0; index < plannedRuns.length; index += 1) {
        const planned = plannedRuns[index];
        if (planned === void 0) continue;
        if (stopRequested) {
          const skipped = skippedResult(planned, activeRenderer.info, "Skipped after Stop.");
          results[index] = skipped;
          updateRow(index, skipped);
          continue;
        }
        const current = results[index];
        if (current !== void 0) {
          updateRow(index, {
            ...current,
            status: "running",
            note: "Running..."
          });
        }
        setStatus(
          `Run ${index + 1}/${plannedRuns.length}: ${planned.scene.label} @ ${planned.resolution.width}x${planned.resolution.height} - preparing...`
        );
        await yieldToPaint();
        const measurement = await measureRun(activeRenderer, planned, index, plannedRuns.length);
        const result = createRunResult(measurement);
        results[index] = result;
        updateRow(index, result);
        publishReport(buildReport(activeRenderer.info, results));
        if (measurement.status === "error" || measurement.status === "context-lost") {
          stopRequested = true;
          setStatus(`Stopped after run ${index + 1}: ${(_a2 = result.note) != null ? _a2 : result.status}`);
        }
      }
      const passCriterion = evaluatePassCriterion(
        results.map((result) => ({
          sceneId: result.sceneId,
          width: result.width,
          height: result.height,
          fps: result.fps
        }))
      );
      publishReport(buildReport(activeRenderer.info, results));
      if (stopRequested) {
        setStatus(`Stopped. ${passCriterion.reason}`);
      } else if (passCriterion.pass) {
        setStatus(`Finished. PASS: ${passCriterion.reason} Copy the JSON into docs/RESULTS.md.`);
      } else {
        setStatus(`Finished. FAIL: ${passCriterion.reason} Copy the JSON into docs/RESULTS.md.`);
      }
    } finally {
      activeRenderer.dispose();
      running = false;
      elements.runButton.disabled = false;
      elements.stopButton.disabled = true;
      elements.copyButton.disabled = latestJson === null;
    }
  }
  function stop() {
    if (!running) return;
    stopRequested = true;
    setStatus("Stop requested; finishing the current frame...");
  }
  async function copyJson() {
    if (latestJson === null) {
      setStatus("Run the benchmark before copying JSON.");
      return;
    }
    const copied = await copyText(latestJson);
    setStatus(
      copied ? "JSON copied to the clipboard." : "Copy failed; select the JSON block and copy it manually."
    );
  }
  elements.runButton.addEventListener("click", () => {
    void run();
  });
  elements.stopButton.addEventListener("click", () => {
    stop();
  });
  elements.copyButton.addEventListener("click", () => {
    void copyJson();
  });
  elements.stopButton.disabled = true;
  elements.copyButton.disabled = true;
  return { run, stop, copyJson };
}
if (typeof document !== "undefined") {
  const autoMount = () => {
    const elements = benchElementsFromDocument();
    if (elements !== null) mountBenchPage(elements);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoMount, { once: true });
  } else {
    autoMount();
  }
}
export {
  WebGLBenchRenderer,
  benchElementsFromDocument,
  mountBenchPage
};

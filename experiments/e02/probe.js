/* Generated from probe.ts by experiments/e02/build.mjs. Do not edit directly. */
import { createReport, formatReport } from "../shared/report.js";
import {
  BENCHMARK_FRAME_COUNT,
  BYTES_PER_MB,
  JS_BLOCK_BYTES,
  SAFE_LIMIT_BYTES,
  SLOWDOWN_FACTOR,
  SLOW_STEPS_TO_STOP,
  TEXTURES_PER_STEP,
  TEXTURE_BYTES,
  TEXTURE_SIZE,
  budget70PercentMb,
  bytesToMb,
  evaluateStep,
  recordFailedStep,
  summarizeFrameTimes,
  totalStableBytes
} from "./stop-conditions.js";
const STORAGE_KEY = "lanpad.experiments.e2.last-stable.v1";
function requiredElement(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`E2 markup is missing #${id}`);
  }
  return element;
}
const runButton = requiredElement("run");
const stopButton = requiredElement("stop");
const copyButton = requiredElement("copy");
const safeModeInput = requiredElement("safe-mode");
const statusHost = requiredElement("status");
const logHost = requiredElement("log");
const resultsTable = requiredElement("results");
const stepsTable = requiredElement("steps");
const jsonHost = requiredElement("json");
const previousHost = requiredElement("previous");
const glHost = requiredElement("gl-host");
let running = false;
let stopRequested = false;
let latestJson = "";
let retainedBlocks = [];
let retainedTextures = [];
function errorMessage(error) {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  return String(error);
}
function formatMb(bytes) {
  return (bytes / BYTES_PER_MB).toFixed(1);
}
function setStatus(message) {
  statusHost.textContent = message;
}
function log(line) {
  const current = logHost.textContent;
  logHost.textContent = current === null || current.length === 0 ? line : `${current}
${line}`;
}
function readStoredProgress() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const record = value;
    if (record.version !== 1 || typeof record.inProgress !== "boolean" || typeof record.stableJsMb !== "number" || typeof record.stableTextureMb !== "number" || typeof record.updatedAt !== "string") {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}
function saveProgress(input) {
  const record = {
    version: 1,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...input
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
  }
}
function measureFrames(count) {
  return new Promise((resolve) => {
    const samples = [];
    let previous = performance.now();
    const onFrame = (now) => {
      samples.push(now - previous);
      previous = now;
      if (samples.length >= count || stopRequested) {
        resolve(samples);
        return;
      }
      requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
  });
}
function renderTable(table, rows) {
  table.textContent = "";
  const head = table.createTHead();
  const headerRow = head.insertRow();
  for (const heading of ["Check", "Status", "Detail", "Time (ms)"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = heading;
    headerRow.appendChild(cell);
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tableRow = body.insertRow();
    const labelCell = tableRow.insertCell();
    labelCell.textContent = row.label;
    if (row.id.length > 0) labelCell.title = row.id;
    const statusCell = tableRow.insertCell();
    statusCell.textContent = row.status.toUpperCase();
    statusCell.className = `status-${row.status}`;
    const detailCell = tableRow.insertCell();
    detailCell.textContent = row.detail;
    const timeCell = tableRow.insertCell();
    timeCell.textContent = row.durationMs === null ? "" : row.durationMs.toFixed(1);
  }
}
function renderSteps(steps) {
  stepsTable.textContent = "";
  const head = stepsTable.createTHead();
  const headerRow = head.insertRow();
  for (const heading of [
    "Phase",
    "Step",
    "Allocated (MB)",
    "p50 (ms)",
    "p95 (ms)",
    "Slow",
    "Outcome"
  ]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = heading;
    headerRow.appendChild(cell);
  }
  const body = stepsTable.createTBody();
  for (const step of steps) {
    const tableRow = body.insertRow();
    const values = [
      step.phase,
      String(step.step),
      step.allocatedMb.toFixed(1),
      step.frameP50Ms === null ? "" : step.frameP50Ms.toFixed(2),
      step.frameP95Ms === null ? "" : step.frameP95Ms.toFixed(2),
      step.slow ? "yes" : "no",
      step.outcome
    ];
    for (const value of values) {
      const cell = tableRow.insertCell();
      cell.textContent = value;
    }
    tableRow.title = step.detail;
  }
}
async function copyJson() {
  if (latestJson.length === 0) {
    setStatus("Run the probe before copying JSON.");
    return;
  }
  let copied = false;
  try {
    await navigator.clipboard.writeText(latestJson);
    copied = true;
  } catch {
    copied = false;
  }
  if (!copied) {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = latestJson;
      textarea.setAttribute("readonly", "");
      textarea.className = "copy-buffer";
      document.body.appendChild(textarea);
      textarea.select();
      copied = document.execCommand("copy");
      document.body.removeChild(textarea);
    } catch {
      copied = false;
    }
  }
  setStatus(
    copied ? "JSON copied to the clipboard." : "Copy failed; select the JSON block and copy it manually."
  );
}
function requestStop() {
  if (!running) return;
  stopRequested = true;
  stopButton.disabled = true;
  setStatus("Stop requested. Finishing the current step; the partial step is not counted.");
  log("[stop] stop requested by the operator");
}
const VERTEX_SHADER_SOURCE = [
  "#version 300 es",
  "in vec2 aPos;",
  "out vec2 vUv;",
  "void main() {",
  "  vUv = aPos * 0.5 + 0.5;",
  "  gl_Position = vec4(aPos, 0.0, 1.0);",
  "}"
].join("\n");
const FRAGMENT_SHADER_SOURCE = [
  "#version 300 es",
  "precision mediump float;",
  "uniform sampler2D uTex;",
  "in vec2 vUv;",
  "out vec4 outColor;",
  "void main() {",
  "  outColor = texture(uTex, vUv);",
  "}"
].join("\n");
function compileShader(gl, type, source) {
  var _a;
  const shader = gl.createShader(type);
  if (shader === null) {
    throw new Error("gl.createShader() returned null");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = (_a = gl.getShaderInfoLog(shader)) != null ? _a : "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${info}`);
  }
  return shader;
}
function buildProgram(gl) {
  var _a;
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
  const program = gl.createProgram();
  if (program === null) {
    throw new Error("gl.createProgram() returned null");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = (_a = gl.getProgramInfoLog(program)) != null ? _a : "unknown link error";
    throw new Error(`shader link failed: ${info}`);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return program;
}
function classifyGlError(gl) {
  if (gl.isContextLost()) {
    return { error: "webgl-context-lost", detail: "the WebGL context is lost" };
  }
  const code = gl.getError();
  if (code === gl.NO_ERROR) return null;
  if (code === gl.OUT_OF_MEMORY) {
    return { error: "webgl-out-of-memory", detail: "gl.getError() returned OUT_OF_MEMORY" };
  }
  if (code === gl.CONTEXT_LOST_WEBGL) {
    return {
      error: "webgl-context-lost",
      detail: "gl.getError() returned CONTEXT_LOST_WEBGL"
    };
  }
  return { error: "webgl-error", detail: `gl.getError() returned 0x${code.toString(16)}` };
}
function createTextureProbe(canvas, textures) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance"
  });
  if (gl === null) {
    throw new Error('getContext("webgl2") returned null');
  }
  let contextLost = false;
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    contextLost = true;
  });
  if (gl.isContextLost()) {
    throw new Error("the WebGL2 context is already lost; reload the page to retry");
  }
  const program = buildProgram(gl);
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  if (vao === null || buffer === null) {
    throw new Error("WebGL vertex-array or buffer creation failed");
  }
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );
  const positionLocation = gl.getAttribLocation(program, "aPos");
  if (positionLocation < 0) {
    throw new Error("the aPos attribute is missing from the shader");
  }
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
  const samplerLocation = gl.getUniformLocation(program, "uTex");
  if (samplerLocation === null) {
    throw new Error("the uTex uniform is missing from the shader");
  }
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  let setupError = gl.getError();
  while (setupError !== gl.NO_ERROR) {
    setupError = gl.getError();
  }
  return {
    allocateStep() {
      let allocatedBytes = 0;
      if (contextLost || gl.isContextLost()) {
        return {
          allocatedBytes,
          attemptedBytes: 0,
          error: "webgl-context-lost",
          detail: "the context was already lost before this step"
        };
      }
      for (let index = 0; index < TEXTURES_PER_STEP; index += 1) {
        const texture = gl.createTexture();
        if (texture === null) {
          return {
            allocatedBytes,
            attemptedBytes: allocatedBytes + TEXTURE_BYTES,
            error: "webgl-error",
            detail: "gl.createTexture() returned null"
          };
        }
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA8,
          TEXTURE_SIZE,
          TEXTURE_SIZE,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null
        );
        allocatedBytes += TEXTURE_BYTES;
        textures.push(texture);
        const allocationError = classifyGlError(gl);
        if (allocationError !== null) {
          return {
            allocatedBytes,
            attemptedBytes: allocatedBytes,
            error: allocationError.error,
            detail: allocationError.detail
          };
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(samplerLocation, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.flush();
        const drawError = classifyGlError(gl);
        if (drawError !== null) {
          return {
            allocatedBytes,
            attemptedBytes: allocatedBytes,
            error: drawError.error,
            detail: drawError.detail
          };
        }
      }
      return {
        allocatedBytes,
        attemptedBytes: allocatedBytes,
        error: null,
        detail: `${TEXTURES_PER_STEP} new textures allocated and drawn`
      };
    }
  };
}
async function runProbe() {
  var _a, _b;
  if (running) return;
  running = true;
  stopRequested = false;
  retainedBlocks = [];
  retainedTextures = [];
  latestJson = "";
  runButton.disabled = true;
  stopButton.disabled = false;
  copyButton.disabled = true;
  resultsTable.textContent = "";
  stepsTable.textContent = "";
  jsonHost.textContent = "Not run.";
  logHost.textContent = "";
  const safeMode = safeModeInput.checked;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const steps = [];
  let baseline = null;
  let baselineDetail = "";
  let jsStableBytes = 0;
  let jsStop = "not-run";
  let jsDetail = "";
  let textureStableBytes = 0;
  let textureStop = "not-run";
  let textureDetail = "";
  let textureSetupError = null;
  saveProgress({
    inProgress: true,
    phase: "js-heap",
    step: 0,
    stableJsMb: 0,
    stableTextureMb: 0,
    baselineFrameMs: 0,
    safeMode,
    stopReason: null
  });
  setStatus("Starting E2. Keep this tab visible.");
  log(`E2 memory ceiling probe started ${startedAt}.`);
  log(
    safeMode ? "Safe mode is ON: each phase stops at 512 MB." : "Safe mode is OFF: phases run until a stop condition."
  );
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  canvas.className = "texture-canvas";
  canvas.setAttribute("aria-label", "E2 texture probe viewport");
  glHost.replaceChildren(canvas);
  let textureProbe = null;
  try {
    textureProbe = createTextureProbe(canvas, retainedTextures);
  } catch (error) {
    textureSetupError = errorMessage(error);
    log(`Texture phase unavailable: ${textureSetupError}`);
  }
  try {
    setStatus(`Measuring the baseline over ${BENCHMARK_FRAME_COUNT} frames...`);
    const baselineSamples = await measureFrames(BENCHMARK_FRAME_COUNT);
    if (stopRequested) {
      baselineDetail = "Stopped by user during the baseline.";
      log(`[baseline] ${baselineDetail}`);
    } else if (baselineSamples.length < 2) {
      baselineDetail = "The rAF baseline collected fewer than two frames; keep the tab visible and retry.";
      log(`[baseline] ${baselineDetail}`);
    } else {
      baseline = summarizeFrameTimes(baselineSamples);
      log(
        `[baseline] p50 ${baseline.p50Ms.toFixed(2)} ms, p95 ${baseline.p95Ms.toFixed(2)} ms, mean ${baseline.meanMs.toFixed(2)} ms over ${baseline.sampleCount} frames.`
      );
    }
    if (baseline !== null && !stopRequested) {
      const baselineMs = baseline.p50Ms;
      const blocks = [];
      retainedBlocks = blocks;
      let allocatedBytes = 0;
      let previousStableBytes = 0;
      let consecutiveSlow = 0;
      let stepNumber = 0;
      while (!stopRequested) {
        stepNumber += 1;
        setStatus(
          `JS heap step ${stepNumber}: allocating ${formatMb(JS_BLOCK_BYTES)} MB...`
        );
        try {
          const block = new Uint8Array(JS_BLOCK_BYTES);
          block.fill(stepNumber & 255);
          blocks.push(block);
          allocatedBytes += JS_BLOCK_BYTES;
        } catch (error) {
          const snapshot = recordFailedStep(
            "allocation-throw",
            previousStableBytes,
            allocatedBytes + JS_BLOCK_BYTES
          );
          jsStop = snapshot.stopReason;
          jsStableBytes = snapshot.stableBytes;
          jsDetail = `Allocation threw at ${formatMb(snapshot.attemptedBytes)} MB: ${errorMessage(error)}`;
          steps.push({
            phase: "js-heap",
            step: stepNumber,
            allocatedMb: bytesToMb(snapshot.attemptedBytes),
            baselineFrameMs: baselineMs,
            frameP50Ms: null,
            frameP95Ms: null,
            slow: false,
            consecutiveSlowSteps: consecutiveSlow,
            stableMb: bytesToMb(snapshot.stableBytes),
            outcome: snapshot.stopReason,
            detail: jsDetail
          });
          log(`[js-heap] step ${stepNumber}: ${jsDetail}`);
          break;
        }
        const samples = await measureFrames(BENCHMARK_FRAME_COUNT);
        if (stopRequested) {
          jsStop = "user-stop";
          jsStableBytes = previousStableBytes;
          jsDetail = `Stopped by user after allocating ${formatMb(allocatedBytes)} MB; the partial step is not counted.`;
          steps.push({
            phase: "js-heap",
            step: stepNumber,
            allocatedMb: bytesToMb(allocatedBytes),
            baselineFrameMs: baselineMs,
            frameP50Ms: null,
            frameP95Ms: null,
            slow: false,
            consecutiveSlowSteps: consecutiveSlow,
            stableMb: bytesToMb(previousStableBytes),
            outcome: "stopped",
            detail: jsDetail
          });
          log(`[js-heap] step ${stepNumber}: ${jsDetail}`);
          break;
        }
        const decision = evaluateStep({
          frameSamplesMs: samples,
          baselineFrameMs: baselineMs,
          allocatedBytes,
          previousStableBytes,
          consecutiveSlowSteps: consecutiveSlow,
          safeMode
        });
        previousStableBytes = decision.stableBytes;
        consecutiveSlow = decision.consecutiveSlowSteps;
        steps.push({
          phase: "js-heap",
          step: stepNumber,
          allocatedMb: bytesToMb(allocatedBytes),
          baselineFrameMs: baselineMs,
          frameP50Ms: decision.frame.p50Ms,
          frameP95Ms: decision.frame.p95Ms,
          slow: decision.slow,
          consecutiveSlowSteps: decision.consecutiveSlowSteps,
          stableMb: bytesToMb(decision.stableBytes),
          outcome: (_a = decision.stopReason) != null ? _a : "ok",
          detail: decision.slow ? `p95 ${decision.frame.p95Ms.toFixed(1)} ms exceeded ${SLOWDOWN_FACTOR}x the ${baselineMs.toFixed(1)} ms baseline` : "stable"
        });
        log(
          `[js-heap] step ${stepNumber}: ${formatMb(allocatedBytes)} MB; p50 ${decision.frame.p50Ms.toFixed(1)} ms; p95 ${decision.frame.p95Ms.toFixed(1)} ms; ${decision.slow ? "SLOW" : "stable"}`
        );
        saveProgress({
          inProgress: true,
          phase: "js-heap",
          step: stepNumber,
          stableJsMb: bytesToMb(decision.stableBytes),
          stableTextureMb: 0,
          baselineFrameMs: baselineMs,
          safeMode,
          stopReason: decision.stopReason
        });
        if (decision.stopReason !== null) {
          jsStop = decision.stopReason;
          jsStableBytes = decision.stableBytes;
          jsDetail = decision.stopReason === "frame-slowdown" ? `p95 exceeded ${SLOWDOWN_FACTOR}x baseline for ${SLOW_STEPS_TO_STOP} consecutive steps; last stable ${formatMb(decision.stableBytes)} MB` : `Safe mode stopped at ${formatMb(allocatedBytes)} MB`;
          log(`[js-heap] stop: ${decision.stopReason} (${jsDetail})`);
          break;
        }
      }
      if (jsStop === "not-run") {
        jsStop = stopRequested ? "user-stop" : "allocation-throw";
        jsStableBytes = previousStableBytes;
        jsDetail = stopRequested ? "Stopped by user before the first JS heap step." : "JS heap phase ended without a stop condition.";
      }
    }
    if (baseline !== null && !stopRequested && textureProbe !== null) {
      const probe = textureProbe;
      const baselineMs = baseline.p50Ms;
      let allocatedBytes = 0;
      let previousStableBytes = 0;
      let consecutiveSlow = 0;
      let stepNumber = 0;
      while (!stopRequested) {
        stepNumber += 1;
        setStatus(
          `Texture step ${stepNumber}: allocating ${TEXTURES_PER_STEP} x ${TEXTURE_SIZE}x${TEXTURE_SIZE} RGBA textures...`
        );
        const allocation = probe.allocateStep();
        if (allocation.error !== null) {
          const snapshot = recordFailedStep(
            allocation.error,
            previousStableBytes,
            allocatedBytes + allocation.attemptedBytes
          );
          textureStop = snapshot.stopReason;
          textureStableBytes = snapshot.stableBytes;
          textureDetail = `${allocation.detail} at ${formatMb(snapshot.attemptedBytes)} MB; last stable ${formatMb(snapshot.stableBytes)} MB`;
          steps.push({
            phase: "texture",
            step: stepNumber,
            allocatedMb: bytesToMb(snapshot.attemptedBytes),
            baselineFrameMs: baselineMs,
            frameP50Ms: null,
            frameP95Ms: null,
            slow: false,
            consecutiveSlowSteps: consecutiveSlow,
            stableMb: bytesToMb(snapshot.stableBytes),
            outcome: snapshot.stopReason,
            detail: textureDetail
          });
          log(`[texture] step ${stepNumber}: ${textureDetail}`);
          break;
        }
        allocatedBytes += allocation.allocatedBytes;
        const samples = await measureFrames(BENCHMARK_FRAME_COUNT);
        if (stopRequested) {
          textureStop = "user-stop";
          textureStableBytes = previousStableBytes;
          textureDetail = `Stopped by user after allocating ${formatMb(allocatedBytes)} MB of textures; the partial step is not counted.`;
          steps.push({
            phase: "texture",
            step: stepNumber,
            allocatedMb: bytesToMb(allocatedBytes),
            baselineFrameMs: baselineMs,
            frameP50Ms: null,
            frameP95Ms: null,
            slow: false,
            consecutiveSlowSteps: consecutiveSlow,
            stableMb: bytesToMb(previousStableBytes),
            outcome: "stopped",
            detail: textureDetail
          });
          log(`[texture] step ${stepNumber}: ${textureDetail}`);
          break;
        }
        const decision = evaluateStep({
          frameSamplesMs: samples,
          baselineFrameMs: baselineMs,
          allocatedBytes,
          previousStableBytes,
          consecutiveSlowSteps: consecutiveSlow,
          safeMode
        });
        previousStableBytes = decision.stableBytes;
        consecutiveSlow = decision.consecutiveSlowSteps;
        steps.push({
          phase: "texture",
          step: stepNumber,
          allocatedMb: bytesToMb(allocatedBytes),
          baselineFrameMs: baselineMs,
          frameP50Ms: decision.frame.p50Ms,
          frameP95Ms: decision.frame.p95Ms,
          slow: decision.slow,
          consecutiveSlowSteps: decision.consecutiveSlowSteps,
          stableMb: bytesToMb(decision.stableBytes),
          outcome: (_b = decision.stopReason) != null ? _b : "ok",
          detail: decision.slow ? `p95 ${decision.frame.p95Ms.toFixed(1)} ms exceeded ${SLOWDOWN_FACTOR}x the ${baselineMs.toFixed(1)} ms baseline` : "stable"
        });
        log(
          `[texture] step ${stepNumber}: ${formatMb(allocatedBytes)} MB; p50 ${decision.frame.p50Ms.toFixed(1)} ms; p95 ${decision.frame.p95Ms.toFixed(1)} ms; ${decision.slow ? "SLOW" : "stable"}`
        );
        saveProgress({
          inProgress: true,
          phase: "texture",
          step: stepNumber,
          stableJsMb: bytesToMb(jsStableBytes),
          stableTextureMb: bytesToMb(decision.stableBytes),
          baselineFrameMs: baselineMs,
          safeMode,
          stopReason: decision.stopReason
        });
        if (decision.stopReason !== null) {
          textureStop = decision.stopReason;
          textureStableBytes = decision.stableBytes;
          textureDetail = decision.stopReason === "frame-slowdown" ? `p95 exceeded ${SLOWDOWN_FACTOR}x baseline for ${SLOW_STEPS_TO_STOP} consecutive steps; last stable ${formatMb(decision.stableBytes)} MB` : `Safe mode stopped at ${formatMb(allocatedBytes)} MB of textures`;
          log(`[texture] stop: ${decision.stopReason} (${textureDetail})`);
          break;
        }
      }
      if (textureStop === "not-run") {
        textureStop = stopRequested ? "user-stop" : "webgl-error";
        textureStableBytes = previousStableBytes;
        textureDetail = stopRequested ? "Stopped by user before the first texture step." : "Texture phase ended without a stop condition.";
      }
    } else if (stopRequested) {
      textureStop = "user-stop";
      textureDetail = "Skipped because the run was stopped during the JS heap phase.";
    } else if (textureProbe === null) {
      textureStop = "not-run";
      textureDetail = textureSetupError != null ? textureSetupError : "WebGL2 unavailable";
    } else if (baseline === null) {
      textureDetail = "Skipped because the frame baseline was not measured.";
    }
    if (baseline === null && baselineDetail.length === 0) {
      baselineDetail = "Baseline not measured.";
    }
    const totalBytes = totalStableBytes(jsStableBytes, textureStableBytes);
    const jsRan = jsStop !== "not-run";
    const textureRan = textureStop !== "not-run";
    const failureMode = `${jsRan ? `js-heap ${jsStop}` : "js-heap not run"}; ${textureRan ? `texture ${textureStop}` : "texture not run"}`;
    const hostBudgetMb = budget70PercentMb(bytesToMb(jsStableBytes));
    const textureBudgetMb = budget70PercentMb(bytesToMb(textureStableBytes));
    const checks = [
      {
        id: "e2-baseline-frame",
        label: "Baseline frame time",
        status: baseline === null ? "fail" : "pass",
        durationMs: 0,
        value: baseline === null ? null : `${baseline.p50Ms.toFixed(2)} ms p50 / ${baseline.p95Ms.toFixed(2)} ms p95 (${baseline.sampleCount} frames)`,
        error: baseline === null ? baselineDetail : null
      },
      {
        id: "e2-stable-js",
        label: "Last stable JS heap (MB)",
        status: jsRan ? "pass" : "fail",
        durationMs: 0,
        value: jsRan ? bytesToMb(jsStableBytes) : null,
        error: jsRan ? null : jsDetail.length > 0 ? jsDetail : "JS heap phase not run"
      },
      {
        id: "e2-stable-texture",
        label: "Last stable texture memory (MB)",
        status: textureRan ? "pass" : "fail",
        durationMs: 0,
        value: textureRan ? bytesToMb(textureStableBytes) : null,
        error: textureRan ? null : textureDetail.length > 0 ? textureDetail : "Texture phase not run"
      },
      {
        id: "e2-estimated-total",
        label: "Estimated total stable memory (MB)",
        status: jsRan || textureRan ? "pass" : "fail",
        durationMs: 0,
        value: bytesToMb(totalBytes),
        error: jsRan || textureRan ? null : "No phase produced a stable step"
      },
      {
        id: "e2-failure-mode",
        label: "Failure mode",
        status: "pass",
        durationMs: 0,
        value: failureMode,
        error: null
      },
      {
        id: "e2-steps",
        label: "Recorded steps",
        status: "pass",
        durationMs: 0,
        value: steps.length,
        error: null
      },
      {
        id: "e2-budget-host",
        label: "Suggested host memory budget (70% of stable JS, MB)",
        status: jsRan ? "pass" : "fail",
        durationMs: 0,
        value: jsRan ? hostBudgetMb : null,
        error: jsRan ? null : "No stable JS heap measurement"
      },
      {
        id: "e2-budget-texture",
        label: "Suggested texture budget (70% of stable texture, MB)",
        status: textureRan ? "pass" : "fail",
        durationMs: 0,
        value: textureRan ? textureBudgetMb : null,
        error: textureRan ? null : "No stable texture measurement"
      }
    ];
    const metadata = {
      safeMode,
      safeModePerPhaseLimitMb: safeMode ? bytesToMb(SAFE_LIMIT_BYTES) : null,
      benchmarkFramesPerStep: BENCHMARK_FRAME_COUNT,
      jsBlockMb: bytesToMb(JS_BLOCK_BYTES),
      textureSize: TEXTURE_SIZE,
      texturesPerStep: TEXTURES_PER_STEP,
      baselineFrameMsP50: baseline === null ? null : baseline.p50Ms,
      baselineFrameMsP95: baseline === null ? null : baseline.p95Ms,
      stableJsMb: bytesToMb(jsStableBytes),
      stableTextureMb: bytesToMb(textureStableBytes),
      estimatedTotalMb: bytesToMb(totalBytes),
      failureMode,
      jsStopReason: jsStop,
      jsDetail,
      textureStopReason: textureStop,
      textureDetail,
      suggestedHostBudgetMb: hostBudgetMb,
      suggestedTextureBudgetMb: textureBudgetMb,
      previousRun: previousProgress
    };
    const report = createReport("E2", "Memory ceiling", checks, startedAt, metadata);
    const formatted = formatReport(report);
    const json = JSON.stringify({ ...report, steps }, null, 2);
    latestJson = json;
    renderTable(resultsTable, formatted.rows);
    renderSteps(steps);
    jsonHost.textContent = json;
    copyButton.disabled = false;
    const summary = `Finished. Stable JS ${formatMb(jsStableBytes)} MB; stable texture ${formatMb(textureStableBytes)} MB; total ${formatMb(totalBytes)} MB. Failure mode: ${failureMode}.`;
    setStatus(`${summary} Copy the JSON into docs/RESULTS.md, then close this tab.`);
    log(summary);
    saveProgress({
      inProgress: false,
      phase: "done",
      step: steps.length,
      stableJsMb: bytesToMb(jsStableBytes),
      stableTextureMb: bytesToMb(textureStableBytes),
      baselineFrameMs: baseline === null ? 0 : baseline.p50Ms,
      safeMode,
      stopReason: failureMode
    });
  } catch (error) {
    const message = errorMessage(error);
    log(`E2 probe aborted: ${message}`);
    setStatus(`E2 probe aborted: ${message}. No JSON result was produced.`);
  } finally {
    running = false;
    stopRequested = false;
    runButton.disabled = false;
    stopButton.disabled = true;
  }
}
const previousProgress = readStoredProgress();
if (previousProgress !== null) {
  previousHost.textContent = previousProgress.inProgress ? `The previous run did not finish (the page was reloaded or crashed). It recorded a last stable JS heap of ${previousProgress.stableJsMb.toFixed(1)} MB and texture memory of ${previousProgress.stableTextureMb.toFixed(1)} MB at ${previousProgress.updatedAt}.` : `The previous run finished at ${previousProgress.updatedAt}: stable JS ${previousProgress.stableJsMb.toFixed(1)} MB, stable texture ${previousProgress.stableTextureMb.toFixed(1)} MB.`;
}
stopButton.disabled = true;
runButton.addEventListener("click", () => {
  void runProbe();
});
stopButton.addEventListener("click", () => {
  requestStop();
});
copyButton.addEventListener("click", () => {
  void copyJson();
});

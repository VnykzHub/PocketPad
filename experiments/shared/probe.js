/* Generated from probe.ts by experiments/shared/build.mjs. Do not edit directly. */
import { createReport, formatReport } from "./report.js";
class ProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProbeError";
  }
}
function errorMessage(error) {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  if (typeof error === "string") return error;
  return String(error);
}
function defaultNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
async function runChecks(checks, options = {}) {
  var _a;
  const now = (_a = options.now) != null ? _a : defaultNow;
  const results = [];
  for (const check of checks) {
    const startedAt = now();
    try {
      const value = await check.run();
      results.push({
        id: check.id,
        label: check.label,
        status: value === false ? "fail" : "pass",
        durationMs: now() - startedAt,
        value,
        error: value === false ? "check returned false" : null
      });
    } catch (error) {
      results.push({
        id: check.id,
        label: check.label,
        status: "fail",
        durationMs: now() - startedAt,
        value: null,
        error: errorMessage(error)
      });
    }
  }
  return results;
}
function detectWebGL2(canvas) {
  var _a;
  let context;
  try {
    context = canvas.getContext("webgl2");
  } catch (error) {
    throw new ProbeError(`WebGL2 context creation threw: ${errorMessage(error)}`);
  }
  if (context === null || context === void 0) {
    throw new ProbeError('WebGL2 context creation failed: getContext("webgl2") returned null');
  }
  const gl = context;
  let maxTextureSize = null;
  try {
    const value = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (typeof value === "number") maxTextureSize = value;
  } catch {
    maxTextureSize = null;
  }
  let extensions = [];
  try {
    extensions = (_a = gl.getSupportedExtensions()) != null ? _a : [];
  } catch {
    extensions = [];
  }
  let contextAttributes = null;
  try {
    contextAttributes = gl.getContextAttributes();
  } catch {
    contextAttributes = null;
  }
  return { supported: true, maxTextureSize, extensions, contextAttributes };
}
function detectWebSocket(scope) {
  return typeof scope.WebSocket === "function";
}
function detectBinaryWebSocket(scope) {
  if (typeof scope.WebSocket !== "function") return false;
  const ctor = scope.WebSocket;
  return ctor.prototype !== void 0 && "binaryType" in ctor.prototype;
}
function detectWebRTC(scope) {
  return typeof scope.RTCPeerConnection === "function";
}
function detectWakeLock(nav) {
  return nav.wakeLock !== void 0 && nav.wakeLock !== null;
}
function detectDeviceMemory(nav) {
  return typeof nav.deviceMemory === "number" && Number.isFinite(nav.deviceMemory) ? nav.deviceMemory : null;
}
function detectHardwareConcurrency(nav) {
  return typeof nav.hardwareConcurrency === "number" && Number.isFinite(nav.hardwareConcurrency) ? nav.hardwareConcurrency : null;
}
function detectAudioContext(scope) {
  return typeof scope.AudioContext === "function" || typeof scope.webkitAudioContext === "function";
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
function mountProbePage(config) {
  var _a;
  const { elements } = config;
  const clock = (_a = config.now) != null ? _a : (() => /* @__PURE__ */ new Date());
  let latest = null;
  let running = false;
  function setStatus(message) {
    if (elements.statusHost !== void 0) {
      elements.statusHost.textContent = message;
    }
  }
  async function run() {
    if (running) return;
    running = true;
    elements.runButton.disabled = true;
    elements.copyButton.disabled = true;
    setStatus("Running checks...");
    try {
      const checks = await runChecks(
        config.checks,
        config.performanceNow === void 0 ? {} : { now: config.performanceNow }
      );
      latest = createReport(config.experiment, config.title, checks, clock().toISOString());
      const formatted = formatReport(latest);
      renderTable(elements.tableHost, formatted.rows);
      elements.jsonHost.textContent = formatted.json;
      const passed = checks.filter((check) => check.status === "pass").length;
      setStatus(
        `Finished: ${passed}/${checks.length} checks passed. Copy the JSON into docs/RESULTS.md.`
      );
      elements.copyButton.disabled = false;
    } catch (error) {
      setStatus(`Probe failed before results were produced: ${errorMessage(error)}`);
    } finally {
      running = false;
      elements.runButton.disabled = false;
    }
  }
  async function copyJson() {
    if (latest === null) {
      setStatus("Run the probe before copying JSON.");
      return;
    }
    const copied = await copyText(formatReport(latest).json);
    setStatus(
      copied ? "JSON copied to the clipboard." : "Copy failed; select the JSON block and copy it manually."
    );
  }
  elements.runButton.addEventListener("click", () => {
    void run();
  });
  elements.copyButton.addEventListener("click", () => {
    void copyJson();
  });
  return { run, copyJson };
}
export {
  ProbeError,
  detectAudioContext,
  detectBinaryWebSocket,
  detectDeviceMemory,
  detectHardwareConcurrency,
  detectWakeLock,
  detectWebGL2,
  detectWebRTC,
  detectWebSocket,
  errorMessage,
  mountProbePage,
  runChecks
};

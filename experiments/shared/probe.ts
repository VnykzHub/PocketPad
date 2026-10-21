/**
 * Shared probe page plumbing for `experiments/` (D1-EXP-01).
 *
 * Two jobs:
 * 1. Run a list of checks in order, catching each failure so one broken check
 *    never hides the rest of the results.
 * 2. Wire the standard page pattern: a Run button that is the only trigger, a
 *    results table, a JSON block and a Copy JSON button.
 *
 * Feature detection lives here too. Every detector receives the object it
 * inspects (window, navigator or a canvas), so tests can pass fakes and the
 * code never decides a capability from the user-agent string (FR-12.1).
 */

import { createReport, formatReport } from "./report.js";
import type { ProbeCheckReport, ProbeReport, ReportRow } from "./report.js";

export interface ProbeCheck {
  id: string;
  label: string;
  /** Return any value on success; throw (or return false) to mark a failure. */
  run: () => unknown | Promise<unknown>;
}

export interface RunChecksOptions {
  /** Injected clock in milliseconds; defaults to `performance.now()`. */
  now?: () => number;
}

export interface CanvasLike {
  getContext(contextId: string, options?: WebGLContextAttributes): unknown;
}

export interface WebGL2Info {
  supported: boolean;
  maxTextureSize: number | null;
  extensions: string[];
  contextAttributes: WebGLContextAttributes | null;
}

export interface WebSocketScope {
  WebSocket?: unknown;
}

export interface WebRTCScope {
  RTCPeerConnection?: unknown;
}

export interface WakeLockScope {
  wakeLock?: unknown;
}

export interface DeviceMemoryScope {
  deviceMemory?: unknown;
}

export interface HardwareConcurrencyScope {
  hardwareConcurrency?: unknown;
}

export interface AudioScope {
  AudioContext?: unknown;
  webkitAudioContext?: unknown;
}

/** Error type used by probe helpers so the table can show a friendly message. */
export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  if (typeof error === "string") return error;
  return String(error);
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Runs checks sequentially and records duration plus a readable error. A
 * thrown error or a literal `false` is a failure; every other return value is
 * a pass. Checks never run unless the caller invokes this function.
 */
export async function runChecks(
  checks: readonly ProbeCheck[],
  options: RunChecksOptions = {},
): Promise<ProbeCheckReport[]> {
  const now = options.now ?? defaultNow;
  const results: ProbeCheckReport[] = [];

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
        error: value === false ? "check returned false" : null,
      });
    } catch (error) {
      results.push({
        id: check.id,
        label: check.label,
        status: "fail",
        durationMs: now() - startedAt,
        value: null,
        error: errorMessage(error),
      });
    }
  }

  return results;
}

/**
 * Acquires a WebGL2 context and reads its limits. Throws a `ProbeError` when
 * context creation throws or returns null, so the standard failure display
 * shows the exact reason. No user-agent checks are involved.
 */
export function detectWebGL2(canvas: CanvasLike): WebGL2Info {
  let context: unknown;
  try {
    context = canvas.getContext("webgl2");
  } catch (error) {
    throw new ProbeError(`WebGL2 context creation threw: ${errorMessage(error)}`);
  }

  if (context === null || context === undefined) {
    throw new ProbeError('WebGL2 context creation failed: getContext("webgl2") returned null');
  }

  const gl = context as WebGL2RenderingContext;
  let maxTextureSize: number | null = null;
  try {
    const value = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (typeof value === "number") maxTextureSize = value;
  } catch {
    maxTextureSize = null;
  }

  let extensions: string[] = [];
  try {
    extensions = gl.getSupportedExtensions() ?? [];
  } catch {
    extensions = [];
  }

  let contextAttributes: WebGLContextAttributes | null = null;
  try {
    contextAttributes = gl.getContextAttributes();
  } catch {
    contextAttributes = null;
  }

  return { supported: true, maxTextureSize, extensions, contextAttributes };
}

export function detectWebSocket(scope: WebSocketScope): boolean {
  return typeof scope.WebSocket === "function";
}

/**
 * Presence check only. A real binary round-trip is the E1 pass criterion; this
 * detector answers whether the browser exposes the binary-type property that
 * the round-trip needs.
 */
export function detectBinaryWebSocket(scope: WebSocketScope): boolean {
  if (typeof scope.WebSocket !== "function") return false;
  const ctor = scope.WebSocket as { prototype?: { binaryType?: unknown } };
  return ctor.prototype !== undefined && "binaryType" in ctor.prototype;
}

export function detectWebRTC(scope: WebRTCScope): boolean {
  return typeof scope.RTCPeerConnection === "function";
}

export function detectWakeLock(nav: WakeLockScope): boolean {
  return nav.wakeLock !== undefined && nav.wakeLock !== null;
}

export function detectDeviceMemory(nav: DeviceMemoryScope): number | null {
  return typeof nav.deviceMemory === "number" && Number.isFinite(nav.deviceMemory)
    ? nav.deviceMemory
    : null;
}

export function detectHardwareConcurrency(nav: HardwareConcurrencyScope): number | null {
  return typeof nav.hardwareConcurrency === "number" && Number.isFinite(nav.hardwareConcurrency)
    ? nav.hardwareConcurrency
    : null;
}

export function detectAudioContext(scope: AudioScope): boolean {
  return (
    typeof scope.AudioContext === "function" || typeof scope.webkitAudioContext === "function"
  );
}

export interface ProbePageElements {
  runButton: HTMLButtonElement;
  copyButton: HTMLButtonElement;
  tableHost: HTMLTableElement;
  jsonHost: HTMLElement;
  statusHost?: HTMLElement;
}

export interface ProbePageConfig {
  experiment: string;
  title: string;
  checks: readonly ProbeCheck[];
  elements: ProbePageElements;
  /** Injected date for deterministic tests; defaults to `new Date()`. */
  now?: () => Date;
  /** Injected monotonic clock for deterministic tests; defaults to `performance.now`. */
  performanceNow?: () => number;
}

export interface ProbePageController {
  run: () => Promise<void>;
  copyJson: () => Promise<void>;
}

function renderTable(table: HTMLTableElement, rows: readonly ReportRow[]): void {
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

async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clipboard !== undefined && typeof clipboard.writeText === "function") {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard API needs a secure context; fall through to the local copy.
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

/**
 * Wires the standard probe page. The checks run only from the Run button's
 * click handler; mounting the page never starts them. Copy JSON works without
 * devtools and never touches the network.
 */
export function mountProbePage(config: ProbePageConfig): ProbePageController {
  const { elements } = config;
  const clock = config.now ?? (() => new Date());
  let latest: ProbeReport | null = null;
  let running = false;

  function setStatus(message: string): void {
    if (elements.statusHost !== undefined) {
      elements.statusHost.textContent = message;
    }
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    elements.runButton.disabled = true;
    elements.copyButton.disabled = true;
    setStatus("Running checks...");

    try {
      const checks = await runChecks(
        config.checks,
        config.performanceNow === undefined ? {} : { now: config.performanceNow },
      );
      latest = createReport(config.experiment, config.title, checks, clock().toISOString());
      const formatted = formatReport(latest);
      renderTable(elements.tableHost, formatted.rows);
      elements.jsonHost.textContent = formatted.json;
      const passed = checks.filter((check) => check.status === "pass").length;
      setStatus(
        `Finished: ${passed}/${checks.length} checks passed. Copy the JSON into docs/RESULTS.md.`,
      );
      elements.copyButton.disabled = false;
    } catch (error) {
      setStatus(`Probe failed before results were produced: ${errorMessage(error)}`);
    } finally {
      running = false;
      elements.runButton.disabled = false;
    }
  }

  async function copyJson(): Promise<void> {
    if (latest === null) {
      setStatus("Run the probe before copying JSON.");
      return;
    }
    const copied = await copyText(formatReport(latest).json);
    setStatus(
      copied ? "JSON copied to the clipboard." : "Copy failed; select the JSON block and copy it manually.",
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

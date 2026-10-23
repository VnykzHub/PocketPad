#!/usr/bin/env node
/**
 * M0 engine demo runner.
 *
 * Serves the repository root on 127.0.0.1:0, launches headless Chrome with a
 * throwaway profile, opens experiments/e-m0-engine/index.html with the
 * requested backend, waits (by polling, never a fixed sleep) for
 * window.__M0_DONE__, captures the canvas as PNG, writes the JSON result and
 * compares the page's FNV-1a readback hash with golden.json.
 *
 * Exit 0 only when a frame was produced and matched golden.json, or was
 * recorded with --update-golden. A missing golden is a failure, not a pass.
 *
 * The page uses an inline import map, so this server rewrites that one tag
 * with a per-process nonce and sends a nonce-based CSP. No inline script
 * other than the import map is allowed.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import WebSocket from "ws";

const EXPERIMENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(EXPERIMENT_DIR, "..", "..");
const GOLDEN_PATH = path.join(EXPERIMENT_DIR, "golden.json");
const ARTIFACTS_DIR = path.join(EXPERIMENT_DIR, "artifacts");
const PAGE_PATH = "/experiments/e-m0-engine/index.html";
const PAGE_SCHEMA = "m0-engine-demo/v2";
const CAPTURE_WARMUP_FRAMES = 30;
const CAPTURE_FRAME = 60;
const BENCH_WARMUP_FRAMES = 120;
const BENCH_MEASURED_FRAMES = 600;
const BENCH_FRAME_TARGET_MS = 14;
const BENCH_FRAME_HARD_MS = 20;
const PARITY_CHANNEL_DELTA = 8;
const PARITY_MAX_PERCENT = 2;
// 04 §A.2 (corrected 2026-10-23): the total includes the 1080p depth attachment,
// so the ceiling is 12 MiB, of which content textures stay ≤ 1 MiB.
const SPEC_TEXTURE_BYTES = 12 * 1024 * 1024;
const HARD_TEXTURE_BYTES = 128 * 1024 * 1024;
const MIN_CONTENT_FRACTION = 0.01;
const MIN_CONTENT_PIXELS = 1000;
const DEFAULT_TIMEOUT_MS = 90_000;
const STARTUP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;
const BASE_VIEWPORT_WIDTH = 900;
const BASE_VIEWPORT_HEIGHT = 700;
const CASES = new Set(["resize", "contextloss", "assets"]);
const RESIZE_FINAL_WIDTH = 640;
const RESIZE_FINAL_HEIGHT = 360;
const RESIZE_MAX_WIDTH = 1280;
const RESIZE_MAX_HEIGHT = 720;
const RESIZE_DPR = 2;
const ASSET_CASE_PREFIX = "/experiments/e-m0-engine/asset-fixtures";
const ASSET_CASE_BYTES = 5 * 1024 * 1024;
const ASSET_CASE_MANIFEST = `${ASSET_CASE_PREFIX}/manifest.json`;
const ASSET_CASE_ASSET = `${ASSET_CASE_PREFIX}/fixtures/five-mb.woff2`;
const SCENES = {
  cube: {
    scene: "m0-textured-cube-v1",
    defaultInstances: 1,
    defaultWidth: 640,
    defaultHeight: 360,
    specInstances: 1,
    specWidth: 640,
    specHeight: 360,
  },
  scene5000: {
    scene: "m0-scene5000-v1",
    defaultInstances: 5000,
    defaultWidth: 1920,
    defaultHeight: 1080,
    specInstances: 5000,
    specWidth: 1920,
    specHeight: 1080,
  },
};
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

const USAGE = `PocketPad M0 engine demo

Usage: node experiments/e-m0-engine/run.mjs [options]

Options:
  --backend auto|webgpu|webgl2  Backend to exercise (default: auto)
  --scene cube|scene5000        Fixture to render (default: cube)
  --instances <n>               Instance count (cube: 1; scene5000: 1..16384)
  --size <width>x<height>       CSS canvas size (cube: 640x360;
                                scene5000: 1920x1080 by default)
  --bench                       Record 120 warm-up + 600 measured rAF intervals
  --case resize|contextloss|assets
                                Run one browser edge case instead of a fixture
                                (resize: DPR 2, ten CSS changes in one frame;
                                contextloss: WebGL2 WEBGL_lose_context or
                                WebGPU real device loss via the dev hook;
                                assets: 5 MiB synthetic WOFF2 long-task probe)
  --chrome <path>               Chrome/Chromium binary (default: CHROME_PATH or common paths)
  --timeout <ms>                Startup plus render budget (default: 90000)
  --out <json>                  Also write the result JSON to this file
  --screenshot <png>            Write the canvas screenshot to this file
  --update-golden               Record this run's hash in golden.json
  --help                        Show this text

The fixture default is the A.1 textured cube. The M0 acceptance fixture is:
  --scene scene5000 --instances 5000 --size 1920x1080 --bench
A smaller scene5000 count and/or size is allowed as an explicitly labelled
fallback, but it is not ER-04-02/ER-05-03 evidence.

Exit code 0 means a real frame was produced and matched golden.json, or was
recorded with --update-golden. A missing golden.json is a failure, not a pass.
A page that is missing, still running, blank or failed is never a pass.

Case mode does not read or write golden.json and does not run the cross-backend
pixel diff. --case contextloss requires --backend webgl2 (WEBGL_lose_context)
or --backend webgpu (real GPUDevice loss through the dev hook, then a terminal
second loss). --case assets saves artifacts/assets/assets.json and no PNG.`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error !== null &&
    typeof error === "object" &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
}

function readOptionValue(argv, index, flag) {
  const value = argv[index];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("--")
  ) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

function parseCount(raw, flag, min, max) {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}, got ${raw}`);
  }
  return value;
}

function parseSize(raw) {
  const match = /^(\d{1,5})x(\d{1,5})$/i.exec(raw);
  if (match === null) {
    throw new Error(`--size must look like 1920x1080, got ${JSON.stringify(raw)}`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 64 || height < 64 || width > 8192 || height > 8192) {
    throw new Error(`--size must be 64x64 to 8192x8192, got ${raw}`);
  }
  return { width, height };
}

function parseOptions(argv) {
  const options = {
    backend: "auto",
    scene: "cube",
    instances: null,
    size: null,
    bench: false,
    case: null,
    chrome: process.env.CHROME_PATH ?? null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    out: null,
    screenshot: null,
    updateGolden: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--backend":
        options.backend = readOptionValue(argv, index + 1, argument).toLowerCase();
        index += 1;
        break;
      case "--scene":
        options.scene = readOptionValue(argv, index + 1, argument).toLowerCase();
        index += 1;
        break;
      case "--instances":
        options.instances = parseCount(
          readOptionValue(argv, index + 1, argument),
          "--instances",
          1,
          16384,
        );
        index += 1;
        break;
      case "--size":
        options.size = parseSize(readOptionValue(argv, index + 1, argument));
        index += 1;
        break;
      case "--bench":
        options.bench = true;
        break;
      case "--case":
        options.case = readOptionValue(argv, index + 1, argument).toLowerCase();
        index += 1;
        break;
      case "--chrome":
        options.chrome = readOptionValue(argv, index + 1, argument);
        index += 1;
        break;
      case "--timeout": {
        const raw = readOptionValue(argv, index + 1, argument);
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 1000) {
          throw new Error(`--timeout must be an integer >= 1000, got ${raw}`);
        }
        options.timeoutMs = value;
        index += 1;
        break;
      }
      case "--out":
        options.out = readOptionValue(argv, index + 1, argument);
        index += 1;
        break;
      case "--screenshot":
        options.screenshot = readOptionValue(argv, index + 1, argument);
        index += 1;
        break;
      case "--update-golden":
        options.updateGolden = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${JSON.stringify(argument)}`);
    }
  }
  if (!["auto", "webgpu", "webgl2"].includes(options.backend)) {
    throw new Error(
      `--backend must be auto, webgpu or webgl2, got ${JSON.stringify(options.backend)}`,
    );
  }
  if (options.case !== null) {
    if (!CASES.has(options.case)) {
      throw new Error(
        `--case must be resize, contextloss or assets, got ${JSON.stringify(options.case)}`,
      );
    }
    if (options.bench) {
      throw new Error("--case cannot be combined with --bench");
    }
    if (options.updateGolden) {
      throw new Error("--case does not read or write golden.json; drop --update-golden");
    }
    if (
      options.case === "contextloss" &&
      !["webgl2", "webgpu"].includes(options.backend)
    ) {
      throw new Error(
        "--case contextloss requires --backend webgl2 or webgpu",
      );
    }
  }
  options.dpr = options.case === "resize" ? RESIZE_DPR : 1;
  const scene = SCENES[options.scene];
  if (scene === undefined) {
    throw new Error(
      `--scene must be cube or scene5000, got ${JSON.stringify(options.scene)}`,
    );
  }
  const instances = options.instances ?? scene.defaultInstances;
  if (options.scene === "cube" && instances !== 1) {
    throw new Error("--scene cube renders exactly one instance");
  }
  const size =
    options.size ?? { width: scene.defaultWidth, height: scene.defaultHeight };
  options.fixture = {
    sceneKey: options.scene,
    scene: scene.scene,
    instances,
    width: size.width,
    height: size.height,
    specInstances: scene.specInstances,
    specWidth: scene.specWidth,
    specHeight: scene.specHeight,
    specConformant:
      instances === scene.specInstances &&
      size.width === scene.specWidth &&
      size.height === scene.specHeight,
  };
  return options;
}

function resolveChrome(explicit) {
  const candidates = [];
  if (typeof explicit === "string" && explicit.length > 0) {
    candidates.push(explicit);
  }
  if (
    typeof process.env.CHROME_PATH === "string" &&
    process.env.CHROME_PATH.length > 0
  ) {
    candidates.push(process.env.CHROME_PATH);
  }
  if (process.platform === "win32") {
    for (const root of [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ]) {
      if (typeof root === "string" && root.length > 0) {
        candidates.push(
          path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        );
        candidates.push(
          path.join(root, "Chromium", "Application", "chrome.exe"),
        );
      }
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    );
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `no Chrome/Chromium binary found. Tried:\n${candidates
      .map((candidate) => `  - ${candidate}`)
      .join("\n")}\nPass --chrome <path> or set CHROME_PATH.`,
  );
}

function contentTypeFor(filePath) {
  return (
    CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ??
    "application/octet-stream"
  );
}

/**
 * A synthetic but structurally valid WOFF2: signature, flavor, total length
 * and one table entry, followed by filler. The built font decoder validates
 * those header fields and the exact response length; it does not decompress
 * the table. This gives the asset layer a real 5 MiB same-origin fetch without
 * inventing a generic binary asset kind that the engine does not have.
 */
function buildAssetCaseBytes() {
  const bytes = Buffer.alloc(ASSET_CASE_BYTES);
  bytes.writeUInt32BE(0x774f4632, 0); // "wOF2"
  bytes.writeUInt32BE(0x00010000, 4); // flavor: TrueType outlines
  bytes.writeUInt32BE(ASSET_CASE_BYTES, 8); // declared file length
  bytes.writeUInt16BE(1, 12); // numTables
  bytes.fill(0x5a, 48);
  return bytes;
}

function buildAssetCaseManifest() {
  return {
    formatVersion: 1,
    id: "m0-assets-case",
    budget: {
      initialBytes: 1,
      totalBytes: ASSET_CASE_BYTES,
    },
    assets: [
      {
        id: "fixtures/five-mb",
        kind: "font",
        url: "fixtures/five-mb.woff2",
        bytes: ASSET_CASE_BYTES,
      },
    ],
  };
}

function sendGeneratedAssetCase(url, request, response) {
  if (url.pathname !== ASSET_CASE_MANIFEST && url.pathname !== ASSET_CASE_ASSET) {
    return false;
  }
  const body =
    url.pathname === ASSET_CASE_MANIFEST
      ? Buffer.from(JSON.stringify(buildAssetCaseManifest()), "utf8")
      : buildAssetCaseBytes();
  const headers = {
    "Content-Type":
      url.pathname === ASSET_CASE_MANIFEST
        ? "application/json; charset=utf-8"
        : "font/woff2",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  response.writeHead(200, headers);
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

async function startStaticServer(options) {
  const nonce = randomBytes(18).toString("base64");
  const csp = [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");

  const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("method not allowed");
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(302, { Location: PAGE_PATH });
        response.end();
        return;
      }
      if (
        options?.case === "assets" &&
        sendGeneratedAssetCase(url, request, response)
      ) {
        return;
      }
      let relative;
      try {
        relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      } catch {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("bad request");
        return;
      }
      if (
        relative.length === 0 ||
        relative
          .split("/")
          .some((segment) => segment.length === 0 || segment.startsWith("."))
      ) {
        response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("forbidden");
        return;
      }
      const filePath = path.resolve(REPO_ROOT, relative);
      if (
        filePath !== REPO_ROOT &&
        !filePath.startsWith(REPO_ROOT + path.sep)
      ) {
        response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("forbidden");
        return;
      }
      const extension = path.extname(filePath).toLowerCase();
      let body = await readFile(filePath);
      const headers = {
        "Content-Type": contentTypeFor(filePath),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      };
      if (extension === ".html") {
        headers["Content-Security-Policy"] = csp;
        const text = body.toString("utf8");
        const marker = '<script type="importmap">';
        if (!text.includes(marker)) {
          throw new Error("index.html has no import map tag to nonce");
        }
        body = Buffer.from(
          text.replace(marker, `<script type="importmap" nonce="${nonce}">`),
          "utf8",
        );
      }
      response.writeHead(200, headers);
      if (request.method === "HEAD") {
        response.end();
      } else {
        response.end(body);
      }
    } catch (error) {
      const status =
        error && (error.code === "ENOENT" || error.code === "EISDIR") ? 404 : 500;
      if (!response.headersSent) {
        response.writeHead(status, {
          "Content-Type": "text/plain; charset=utf-8",
        });
      }
      response.end(status === 404 ? "not found" : "server error");
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("static server did not bind to a TCP port");
  }
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function closeStaticServer(handle) {
  if (!handle) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    handle.server.close(() => resolve());
    if (typeof handle.server.closeAllConnections === "function") {
      handle.server.closeAllConnections();
    }
  });
}

function viewportFor(fixture, caseName = null) {
  if (caseName === "resize") {
    // The viewport must fit the largest intermediate size (1280x720), not just
    // the final 800x450, or CSS layout would clamp the canvas mid-sequence.
    return {
      width: Math.max(BASE_VIEWPORT_WIDTH, RESIZE_MAX_WIDTH + 64),
      height: Math.max(BASE_VIEWPORT_HEIGHT, RESIZE_MAX_HEIGHT + 260),
    };
  }
  return {
    width: Math.max(BASE_VIEWPORT_WIDTH, Math.min(8192, fixture.width + 64)),
    height: Math.max(BASE_VIEWPORT_HEIGHT, Math.min(8192, fixture.height + 260)),
  };
}

async function launchChrome(chromePath, profileDir, viewport) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-component-update",
    "--disable-sync",
    "--disable-extensions",
    "--disable-default-apps",
    "--no-proxy-server",
    "--mute-audio",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--force-device-scale-factor=1",
    "--enable-unsafe-webgpu",
    `--window-size=${viewport.width},${viewport.height}`,
    "about:blank",
  ];
  const child = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  const state = { stderr: "" };
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      state.stderr = (state.stderr + chunk).slice(-4096);
    });
  }
  child.on("error", (error) => {
    state.stderr = `${state.stderr}\nchrome: ${errorText(error)}`.slice(-4096);
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return { child, state };
}

function chromeDiagnostics(state) {
  const text = state && state.stderr ? state.stderr.trim() : "";
  return text ? `\nChrome stderr:\n${text}` : "";
}

async function waitForDevToolsPort(profileDir, deadline, child, state) {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Chrome exited with code ${child.exitCode} before opening a DevTools port.${chromeDiagnostics(state)}`,
      );
    }
    try {
      const text = await readFile(portFile, "utf8");
      const port = Number.parseInt(text.split(/\r?\n/)[0], 10);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        return port;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        lastError = error;
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  const suffix = lastError ? ` Last error: ${errorText(lastError)}` : "";
  throw new Error(
    `Chrome did not write DevToolsActivePort within the startup timeout.${suffix}${chromeDiagnostics(state)}`,
  );
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

async function readBrowserVersion(port) {
  try {
    const info = await fetchJson(`http://127.0.0.1:${port}/json/version`);
    return typeof info.Browser === "string" ? info.Browser : null;
  } catch {
    return null;
  }
}

async function waitForPageTarget(port, deadline, child, state) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Chrome exited with code ${child.exitCode} before exposing a page target.${chromeDiagnostics(state)}`,
      );
    }
    try {
      const targets = await fetchJson(endpoint);
      const page = targets.find(
        (target) =>
          target &&
          target.type === "page" &&
          typeof target.webSocketDebuggerUrl === "string",
      );
      if (page) {
        return page;
      }
      lastError = new Error("no page target in /json/list yet");
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  const suffix = lastError ? ` Last error: ${errorText(lastError)}` : "";
  throw new Error(
    `Chrome exposed no CDP page target within the startup timeout.${suffix}${chromeDiagnostics(state)}`,
  );
}

class CdpConnection {
  static open(webSocketUrl, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`timed out opening CDP WebSocket after ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Set();
    this.closed = false;
    this.closeError = null;
    socket.on("message", (data) => this.onMessage(data));
    socket.on("close", () => this.onClose());
    socket.on("error", (error) => this.onClose(error));
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      return;
    }
    if (message.id === undefined) {
      for (const handler of this.eventHandlers) {
        try {
          handler(message);
        } catch {
          // Diagnostics must never break the run.
        }
      }
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(
        new Error(
          `${entry.method} failed: ${message.error.message ?? "unknown CDP error"}`,
        ),
      );
    } else {
      entry.resolve(message.result ?? {});
    }
  }

  onClose(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error ?? new Error("CDP connection closed");
    for (const entry of this.pending.values()) {
      entry.reject(this.closeError);
    }
    this.pending.clear();
    this.eventHandlers.clear();
  }

  send(method, params = {}) {
    if (this.closed) {
      return Promise.reject(
        this.closeError ?? new Error("CDP connection closed"),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // A socket that is already gone needs no further teardown.
    }
    this.onClose();
  }
}

function attachDiagnostics(cdp) {
  const messages = [];
  const push = (kind, text) => {
    if (typeof text !== "string" || text.length === 0) {
      return;
    }
    messages.push(`${kind}: ${text}`);
    if (messages.length > 40) {
      messages.shift();
    }
  };
  cdp.onEvent((message) => {
    if (message.method === "Runtime.consoleAPICalled") {
      const args = Array.isArray(message.params?.args)
        ? message.params.args
        : [];
      push(
        message.params?.type ?? "console",
        args
          .map((arg) => {
            if (arg === null || typeof arg !== "object") {
              return String(arg);
            }
            if (typeof arg.value === "string") return arg.value;
            if (arg.value !== undefined) return JSON.stringify(arg.value);
            return typeof arg.description === "string"
              ? arg.description
              : arg.type ?? "value";
          })
          .join(" "),
      );
    } else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      push(
        "exception",
        details?.exception?.description ?? details?.text ?? "unknown exception",
      );
    } else if (message.method === "Log.entryAdded") {
      const entry = message.params?.entry;
      if (entry && (entry.level === "error" || entry.level === "warning")) {
        push(
          `log-${entry.level}`,
          `${entry.source ?? ""} ${entry.text ?? ""}`.trim(),
        );
      }
    }
  });
  return messages;
}

/**
 * Pulls the exact engine blocker out of Chrome's rendering log. A WebGPU draw
 * can increment the device's draw-call counter while the command buffer is
 * invalid, so the page's pixel check and this log are both required evidence.
 */
function extractGpuBlocker(diagnostics) {
  const relevant = diagnostics.filter((line) =>
    /Invalid BindGroup|Binding size \(|textureView not set|Invalid CommandBuffer|CreateBindGroup|CreateBuffer|validation error/i.test(
      line,
    ),
  );
  return relevant.length > 0 ? relevant.slice(0, 8) : null;
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    const text =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text ??
      "evaluation failed";
    throw new Error(text);
  }
  return response.result ? response.result.value : undefined;
}

async function waitForDemo(cdp, deadline) {
  let lastState = null;
  while (Date.now() < deadline) {
    if (cdp.closed) {
      const reason = cdp.closeError ? ` (${errorText(cdp.closeError)})` : "";
      throw new Error(
        `CDP connection closed before window.__M0_DONE__ was set${reason}`,
      );
    }
    try {
      const state = await evaluate(
        cdp,
        `({
          href: location.href,
          ready: document.readyState,
          done: window.__M0_DONE__ === true,
          result: window.__M0__ ?? null,
          status: document.querySelector("#status") ? document.querySelector("#status").textContent : null
        })`,
      );
      if (state !== null && typeof state === "object") {
        lastState = state;
        if (state.done === true && state.result !== null) {
          return state;
        }
      }
    } catch (error) {
      lastState = { error: errorText(error) };
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out waiting for window.__M0_DONE__; last page state: ${JSON.stringify(lastState)}`,
  );
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
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
}

async function captureCanvasScreenshot(cdp, rect) {
  const x = Math.max(0, Math.floor(Number(rect.x) || 0));
  const y = Math.max(0, Math.floor(Number(rect.y) || 0));
  const width = Math.max(1, Math.round(Number(rect.width) || 0));
  const height = Math.max(1, Math.round(Number(rect.height) || 0));
  const result = await withTimeout(
    cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x, y, width, height, scale: 1 },
    }),
    15_000,
    "Page.captureScreenshot",
  );
  if (!result || typeof result.data !== "string") {
    throw new Error("Page.captureScreenshot returned no PNG data");
  }
  const bytes = Buffer.from(result.data, "base64");
  if (bytes.length < 1000) {
    throw new Error(`screenshot is suspiciously small (${bytes.length} bytes)`);
  }
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("screenshot bytes are not a PNG");
  }
  return { bytes, width, height, clip: { x, y, width, height } };
}

/**
 * Minimal PNG decoder for Chromium screenshots: 8-bit, non-interlaced,
 * greyscale / RGB / greyscale+alpha / RGBA. It deliberately supports only what
 * Chrome emits so the parity check needs no dependency. CRC is not checked.
 */
function decodePng(bytes, label) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error(`${label} is not a PNG`);
  }
  let offset = 8;
  let header = null;
  const idat = [];
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff) {
      throw new Error(`${label} has an oversized PNG chunk`);
    }
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) {
      throw new Error(`${label} has a truncated ${type} chunk`);
    }
    if (type === "IHDR") {
      if (length !== 13) {
        throw new Error(`${label} has an invalid IHDR length`);
      }
      header = {
        width: bytes.readUInt32BE(start),
        height: bytes.readUInt32BE(start + 4),
        bitDepth: bytes[start + 8],
        colorType: bytes[start + 9],
        compression: bytes[start + 10],
        filter: bytes[start + 11],
        interlace: bytes[start + 12],
      };
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(start, end));
    } else if (type === "IEND") {
      ended = true;
      break;
    }
    offset = end + 4;
  }
  if (header === null) {
    throw new Error(`${label} has no IHDR chunk`);
  }
  if (!ended) {
    throw new Error(`${label} has no IEND chunk`);
  }
  if (header.width <= 0 || header.height <= 0) {
    throw new Error(`${label} has invalid dimensions ${header.width}x${header.height}`);
  }
  if (header.bitDepth !== 8) {
    throw new Error(`${label} uses unsupported bit depth ${header.bitDepth}`);
  }
  if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new Error(
      `${label} uses unsupported compression/filter/interlace ${header.compression}/${header.filter}/${header.interlace}`,
    );
  }
  const channelsByColorType = new Map([
    [0, 1],
    [2, 3],
    [4, 2],
    [6, 4],
  ]);
  const channels = channelsByColorType.get(header.colorType);
  if (channels === undefined) {
    throw new Error(`${label} uses unsupported PNG color type ${header.colorType}`);
  }
  if (idat.length === 0) {
    throw new Error(`${label} has no IDAT data`);
  }
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (error) {
    throw new Error(`${label} IDAT did not inflate: ${errorText(error)}`);
  }
  const stride = header.width * channels;
  const expected = (stride + 1) * header.height;
  if (raw.length < expected) {
    throw new Error(
      `${label} has ${raw.length} inflated bytes, expected at least ${expected}`,
    );
  }

  const pixels = Buffer.alloc(header.width * header.height * 4);
  let previous = Buffer.alloc(stride);
  let position = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[position];
    position += 1;
    const line = Buffer.from(raw.subarray(position, position + stride));
    position += stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? line[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      let predictor = 0;
      if (filter === 1) {
        predictor = left;
      } else if (filter === 2) {
        predictor = up;
      } else if (filter === 3) {
        predictor = Math.floor((left + up) / 2);
      } else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`${label} uses unsupported PNG filter ${filter}`);
      }
      line[index] = (line[index] + predictor) & 0xff;
    }
    for (let x = 0; x < header.width; x += 1) {
      const source = x * channels;
      const target = (y * header.width + x) * 4;
      if (header.colorType === 0 || header.colorType === 4) {
        const grey = line[source];
        pixels[target] = grey;
        pixels[target + 1] = grey;
        pixels[target + 2] = grey;
        pixels[target + 3] =
          header.colorType === 4 ? line[source + 1] : 255;
      } else {
        pixels[target] = line[source];
        pixels[target + 1] = line[source + 1];
        pixels[target + 2] = line[source + 2];
        pixels[target + 3] =
          header.colorType === 6 ? line[source + 3] : 255;
      }
    }
    previous = line;
  }
  return {
    width: header.width,
    height: header.height,
    colorType: header.colorType,
    bitDepth: header.bitDepth,
    channels,
    pixels,
  };
}

function artifactStem(fixture) {
  if (
    fixture.sceneKey === "cube" &&
    fixture.instances === 1 &&
    fixture.width === 640 &&
    fixture.height === 360
  ) {
    return null;
  }
  return `${fixture.sceneKey}-${fixture.instances}-${fixture.width}x${fixture.height}`;
}

function defaultArtifactBase(fixture, backend, caseName = null) {
  if (caseName !== null) {
    const directory = path.join(ARTIFACTS_DIR, caseName);
    return {
      directory,
      json: path.join(directory, `${backend}.json`),
      png: path.join(directory, `${backend}.png`),
    };
  }
  const stem = artifactStem(fixture);
  const directory = stem === null ? ARTIFACTS_DIR : path.join(ARTIFACTS_DIR, stem);
  return {
    directory,
    json: path.join(directory, `${backend}.json`),
    png: path.join(directory, `${backend}.png`),
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new Error(`could not read ${filePath}: ${errorText(error)}`);
  }
}

async function collectEngineJsFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectEngineJsFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * A repository-wide engine build hash. Unlike the page's per-backend hash
 * (which covers only the modules that backend loaded, and therefore differs by
 * design), this covers every JS file under packages/engine in dist folders and
 * is the same identity for both backends in one checkout.
 */
async function computeEngineBuildHash() {
  const root = path.join(REPO_ROOT, "packages", "engine");
  const files = (await collectEngineJsFiles(root)).sort((left, right) =>
    left.localeCompare(right),
  );
  if (files.length === 0) {
    throw new Error(`no engine JS files found under ${root}`);
  }
  const digest = createHash("sha256");
  let bytes = 0;
  for (const filePath of files) {
    const body = await readFile(filePath);
    const relative = path
      .relative(REPO_ROOT, filePath)
      .split(path.sep)
      .join("/");
    digest.update(relative, "utf8");
    digest.update("\0");
    digest.update(body);
    digest.update("\0");
    bytes += body.byteLength;
  }
  return {
    hash: digest.digest("hex"),
    algorithm: "sha256",
    fileCount: files.length,
    bytes,
    root: "packages/engine",
  };
}

function decodedImageMatchesFixture(image, fixture, dpr) {
  return (
    image.width === Math.round(fixture.width * dpr) &&
    image.height === Math.round(fixture.height * dpr)
  );
}

function pixelDiff(current, counterpart) {
  if (current.width !== counterpart.width || current.height !== counterpart.height) {
    return {
      width: current.width,
      height: current.height,
      counterpartWidth: counterpart.width,
      counterpartHeight: counterpart.height,
      totalPixels: 0,
      differentPixels: 0,
      differentPercent: null,
      maxChannelDelta: null,
      withinBudget: false,
      dimensionMismatch: true,
    };
  }
  const totalPixels = current.width * current.height;
  let differentPixels = 0;
  let maxChannelDelta = 0;
  for (let pixel = 0; pixel < totalPixels; pixel += 1) {
    const offset = pixel * 4;
    let different = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        current.pixels[offset + channel] - counterpart.pixels[offset + channel],
      );
      if (delta > maxChannelDelta) {
        maxChannelDelta = delta;
      }
      if (delta > PARITY_CHANNEL_DELTA) {
        different = true;
      }
    }
    if (different) {
      differentPixels += 1;
    }
  }
  const differentPercent = (differentPixels / totalPixels) * 100;
  return {
    width: current.width,
    height: current.height,
    counterpartWidth: counterpart.width,
    counterpartHeight: counterpart.height,
    totalPixels,
    differentPixels,
    differentPercent: Math.round(differentPercent * 1e6) / 1e6,
    maxChannelDelta,
    withinBudget: differentPercent <= PARITY_MAX_PERCENT,
    dimensionMismatch: false,
  };
}

async function computeCrossBackendDiff({
  result,
  fixture,
  screenshot,
  screenshotImage,
  engineBuildHash,
}) {
  const otherBackend = result.backend === "webgpu" ? "webgl2" : "webgpu";
  const counterpartPaths = defaultArtifactBase(fixture, otherBackend);
  const base = {
    status: "not-available",
    currentBackend: result.backend,
    counterpartBackend: otherBackend,
    currentPng: screenshot === null ? null : screenshot.path ?? null,
    counterpartPng: counterpartPaths.png,
    currentHash: result.hash,
    counterpartHash: null,
    hashesCompared: false,
    thresholdChannelDelta: PARITY_CHANNEL_DELTA,
    maxDifferentPercent: PARITY_MAX_PERCENT,
    totalPixels: null,
    differentPixels: null,
    differentPercent: null,
    maxChannelDelta: null,
    withinBudget: null,
    engineBuildHash: engineBuildHash ?? null,
    counterpartEngineBuildHash: null,
    pageBuildHash: result.buildHash ?? null,
    counterpartPageBuildHash: null,
    buildHashMatch: null,
    note: "Per-backend pixel hashes and per-backend loaded-module hashes are recorded separately and are never compared across backends. Only the repository-wide engine build identity and the rendered pixels are compared.",
    detail: null,
  };
  if (screenshot === null || screenshotImage === null) {
    return { ...base, status: "no-current-capture", detail: "the current run has no decodable canvas PNG" };
  }
  const counterpartSummary = await readJsonIfExists(counterpartPaths.json);
  let counterpartBytes;
  try {
    counterpartBytes = await readFile(counterpartPaths.png);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ...base,
        status: "not-available",
        detail: `no ${otherBackend} screenshot for this fixture; run --backend ${otherBackend} for the same scene, instance count and size`,
      };
    }
    throw new Error(`could not read ${counterpartPaths.png}: ${errorText(error)}`);
  }
  if (
    counterpartSummary === null ||
    counterpartSummary.ok !== true ||
    counterpartSummary.page === null ||
    typeof counterpartSummary.page !== "object"
  ) {
    return {
      ...base,
      status: "invalid-counterpart",
      detail: `${counterpartPaths.json} is missing or does not describe a successful run`,
    };
  }
  const counterpartPage = counterpartSummary.page;
  if (
    counterpartPage.scene !== fixture.scene ||
    counterpartPage.instances !== fixture.instances ||
    counterpartPage.size?.cssWidth !== fixture.width ||
    counterpartPage.size?.cssHeight !== fixture.height
  ) {
    return {
      ...base,
      status: "stale-counterpart",
      counterpartHash:
        typeof counterpartPage.hash === "string" ? counterpartPage.hash : null,
      detail: `${counterpartPaths.json} describes ${JSON.stringify(counterpartPage.scene)} / ${counterpartPage.instances} / ${counterpartPage.size?.cssWidth}x${counterpartPage.size?.cssHeight}, not this fixture`,
    };
  }
  const counterpartImage = decodePng(
    counterpartBytes,
    `${otherBackend} artifact`,
  );
  const currentBuild =
    typeof engineBuildHash === "string" ? engineBuildHash : null;
  const counterpartBuild =
    typeof counterpartSummary.engineBuild?.hash === "string"
      ? counterpartSummary.engineBuild.hash
      : null;
  const buildHashMatch =
    currentBuild !== null && counterpartBuild !== null
      ? currentBuild === counterpartBuild
      : null;
  const diff = pixelDiff(screenshotImage, counterpartImage);
  const status = diff.dimensionMismatch
    ? "size-mismatch"
    : buildHashMatch === false
      ? "build-mismatch"
      : "compared";
  return {
    ...base,
    ...diff,
    status,
    counterpartHash:
      typeof counterpartPage.hash === "string" ? counterpartPage.hash : null,
    currentPng: screenshot.path ?? base.currentPng,
    currentWidth: screenshotImage.width,
    currentHeight: screenshotImage.height,
    counterpartWidth: counterpartImage.width,
    counterpartHeight: counterpartImage.height,
    engineBuildHash: currentBuild,
    counterpartEngineBuildHash: counterpartBuild,
    pageBuildHash:
      typeof result.buildHash === "string" ? result.buildHash : null,
    counterpartPageBuildHash:
      typeof counterpartPage.buildHash === "string"
        ? counterpartPage.buildHash
        : null,
    buildHashMatch,
    detail: diff.dimensionMismatch
      ? `screenshot sizes differ: ${screenshotImage.width}x${screenshotImage.height} vs ${counterpartImage.width}x${counterpartImage.height}`
      : buildHashMatch === false
        ? "the two screenshots came from different repository engine builds; parity is reported but not applied"
        : null,
  };
}


function isNonNegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateCaseScreenshot(result, screenshotImage) {
  if (screenshotImage === null) {
    return ["no decoded canvas screenshot was captured for this case"];
  }
  const size = result.size;
  if (size === null || typeof size !== "object") {
    return [`case result has no final size object`];
  }
  const matchesBacking =
    screenshotImage.width === size.width && screenshotImage.height === size.height;
  const matchesCss =
    screenshotImage.width === size.cssWidth &&
    screenshotImage.height === size.cssHeight;
  if (!matchesBacking && !matchesCss) {
    return [
      `case screenshot is ${screenshotImage.width}x${screenshotImage.height}, expected backing ${size.width}x${size.height} or CSS ${size.cssWidth}x${size.cssHeight}`,
    ];
  }
  return [];
}

function validateCaseResult(result, options, fixture, screenshotImage) {
  const problems = [];
  if (result === null || typeof result !== "object") {
    return ["page published no window.__M0__ result object"];
  }
  if (result.schema !== PAGE_SCHEMA) {
    problems.push(
      `page schema is ${JSON.stringify(result.schema)}, expected ${PAGE_SCHEMA}`,
    );
  }
  if (result.case !== options.case) {
    problems.push(
      `page case is ${JSON.stringify(result.case)}, expected ${options.case}`,
    );
  }
  if (result.requestedBackend !== options.backend) {
    problems.push(
      `page requestedBackend is ${JSON.stringify(result.requestedBackend)}, expected ${options.backend}`,
    );
  }

  if (result.ok !== true) {
    const code = result.error?.code ? `[${result.error.code}] ` : "";
    return [
      `page reported failure at ${result.stage}: ${code}${
        result.error?.message ?? "unknown error"
      }`,
    ];
  }
  if (
    typeof result.buildHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.buildHash)
  ) {
    problems.push(
      `buildHash is not a SHA-256 hex string: ${JSON.stringify(result.buildHash)}`,
    );
  }
  if (!(result.build?.fileCount >= 1) || !(result.build?.bytes > 0)) {
    problems.push("build hash did not cover any engine module bytes");
  }
  if (
    typeof result.browser?.name !== "string" ||
    result.browser.name.length === 0 ||
    typeof result.browser?.version !== "string" ||
    result.browser.version.length === 0
  ) {
    problems.push("browser name/version is missing");
  }

  if (options.case === "resize") {
    const c = result.caseResult;
    if (c === null || typeof c !== "object") {
      problems.push("resize case has no caseResult");
    } else {
      if (
        !["webgpu", "webgl2"].includes(result.backend) ||
        (options.backend !== "auto" && result.backend !== options.backend)
      ) {
        problems.push(
          `resize backend is ${JSON.stringify(result.backend)}, expected ${options.backend}`,
        );
      }
      if (c.resizeCalls !== 10) {
        problems.push(
          `resizeCalls is ${JSON.stringify(c.resizeCalls)}, expected 10`,
        );
      }
      if (c.dpr !== RESIZE_DPR) {
        problems.push(`resize DPR is ${JSON.stringify(c.dpr)}, expected ${RESIZE_DPR}`);
      }
      if (!Array.isArray(c.sequence) || c.sequence.length !== 10) {
        problems.push("resize sequence is not ten entries");
      }
      if (!Array.isArray(c.changes) || c.changes.length !== 10) {
        problems.push(
          `resize recorded ${JSON.stringify(c.changes?.length)} changes, expected 10`,
        );
      } else {
        for (let index = 0; index < c.changes.length; index += 1) {
          const change = c.changes[index];
          const expected = c.sequence?.[index];
          if (
            expected !== undefined &&
            (change.cssRequestedWidth !== expected.width ||
              change.cssRequestedHeight !== expected.height)
          ) {
            problems.push(
              `resize change ${index + 1} requested ${change.cssRequestedWidth}x${change.cssRequestedHeight}, expected ${expected.width}x${expected.height}`,
            );
          }
          if (
            change.canvasClientWidth !== change.cssRequestedWidth ||
            change.canvasClientHeight !== change.cssRequestedHeight
          ) {
            problems.push(
              `resize change ${index + 1} CSS layout is ${change.canvasClientWidth}x${change.canvasClientHeight}, expected ${change.cssRequestedWidth}x${change.cssRequestedHeight}`,
            );
          }
          if (
            change.deviceSize === null ||
            change.deviceSize.width !== change.canvasClientWidth ||
            change.deviceSize.height !== change.canvasClientHeight
          ) {
            problems.push(
              `resize change ${index + 1} device.size is ${JSON.stringify(change.deviceSize)}, expected CSS ${change.canvasClientWidth}x${change.canvasClientHeight}`,
            );
          }
          if (change.dpr !== RESIZE_DPR) {
            problems.push(
              `resize change ${index + 1} DPR is ${JSON.stringify(change.dpr)}, expected ${RESIZE_DPR}`,
            );
          }
        }
      }
      const after = c.afterFrame;
      if (after?.validFrame !== true) {
        problems.push("resize did not produce a valid frame after the changes");
      }
      if (
        after?.cssWidth !== RESIZE_FINAL_WIDTH ||
        after?.cssHeight !== RESIZE_FINAL_HEIGHT
      ) {
        problems.push(
          `resize final CSS size is ${after?.cssWidth}x${after?.cssHeight}, expected ${RESIZE_FINAL_WIDTH}x${RESIZE_FINAL_HEIGHT}`,
        );
      }
      if (after?.deviceSizeMatchesCss !== true) {
        problems.push(
          `resize final device.size ${JSON.stringify(after?.deviceSize)} does not match CSS ${after?.cssWidth}x${after?.cssHeight}`,
        );
      }
      if (after?.backingMatchesDpr !== true) {
        problems.push(
          `resize final backing is ${after?.backingWidth}x${after?.backingHeight}, expected ${RESIZE_FINAL_WIDTH * RESIZE_DPR}x${RESIZE_FINAL_HEIGHT * RESIZE_DPR}`,
        );
      }
      if (
        after?.backingWidth !== RESIZE_FINAL_WIDTH * RESIZE_DPR ||
        after?.backingHeight !== RESIZE_FINAL_HEIGHT * RESIZE_DPR
      ) {
        problems.push(
          `resize final backing is ${after?.backingWidth}x${after?.backingHeight}, expected ${RESIZE_FINAL_WIDTH * RESIZE_DPR}x${RESIZE_FINAL_HEIGHT * RESIZE_DPR}`,
        );
      }
      if (after?.stats?.gpuErrors !== 0) {
        problems.push(
          `resize gpuErrors is ${JSON.stringify(after?.stats?.gpuErrors)}, expected 0`,
        );
      }
      const pixels = Math.max(1, (after?.backingWidth ?? 0) * (after?.backingHeight ?? 0));
      const minimum = Math.max(MIN_CONTENT_PIXELS, Math.round(pixels * MIN_CONTENT_FRACTION));
      if (!(c.capture?.nonClearPixels >= minimum) || !(c.capture?.distinctColors >= 2)) {
        problems.push(
          `resize capture is blank: nonClearPixels=${JSON.stringify(c.capture?.nonClearPixels)} (min ${minimum}), distinctColors=${JSON.stringify(c.capture?.distinctColors)}`,
        );
      }
      if (c.coalescing?.counterExposed !== false || c.coalescing?.configureCalls !== null) {
        problems.push(
          "resize coalescing claim is invalid: the built renderer exposes no configure counter, so counterExposed must be false and configureCalls null",
        );
      }
      if (c.pass?.tenCssSizeChanges !== true) {
        problems.push(
          "resize case did not prove ten consecutive CSS-size changes from the initial surface",
        );
      }
      if (c.pass?.all !== true) {
        problems.push("resize case pass.all is not true");
      }
      problems.push(...validateCaseScreenshot(result, screenshotImage));
    }
  } else if (options.case === "contextloss") {
    const c = result.caseResult;
    if (c === null || typeof c !== "object") {
      problems.push("contextloss case has no caseResult");
    } else {
      if (result.backend === "webgl2") {
        if (
          c.extension !== "WEBGL_lose_context" ||
          c.extensionAvailable !== true
        ) {
          problems.push(
            "contextloss did not use an available WEBGL_lose_context",
          );
        }
        if (c.events?.lost !== true || c.events?.restored !== true) {
          problems.push(
            `contextloss events are ${JSON.stringify(c.events)}, expected lost and restored`,
          );
        }
        if (
          c.epoch?.incremented !== true ||
          !(c.epoch.afterLoss > c.epoch.before) ||
          c.epoch.afterRestore !== c.epoch.afterLoss
        ) {
          problems.push(
            `contextEpoch did not increment exactly across loss/restore: ${JSON.stringify(c.epoch)}`,
          );
        }
        if (c.lost?.afterLoss !== true) {
          problems.push("device.lost was not true after the lost event");
        }
        if (c.lost?.afterRestore !== false) {
          problems.push("device.lost was not cleared after the restored event");
        }
        if (c.finalStats?.gpuErrors !== 0) {
          problems.push(
            `contextloss gpuErrors is ${JSON.stringify(c.finalStats?.gpuErrors)}, expected 0`,
          );
        }
      } else if (result.backend === "webgpu") {
        if (
          c.mechanism !== "forceWebGpuDeviceLost" ||
          c.hookAvailable !== true
        ) {
          problems.push(
            `contextloss did not use the dev forceWebGpuDeviceLost hook: ${JSON.stringify({ mechanism: c.mechanism, hookAvailable: c.hookAvailable })}`,
          );
        }
        if (
          c.events?.lost !== true ||
          c.events?.restored !== true ||
          c.events?.secondLost !== true
        ) {
          problems.push(
            `WebGPU loss events are ${JSON.stringify(c.events)}, expected lost, restored and secondLost`,
          );
        }
        if (
          c.events?.counts?.lost !== 2 ||
          c.events?.counts?.restored !== 1
        ) {
          problems.push(
            `WebGPU loss event counts are ${JSON.stringify(c.events?.counts)}, expected lost=2 restored=1`,
          );
        }
        if (
          c.deviceState?.before !== "running" ||
          c.deviceState?.afterLoss !== "lost" ||
          c.deviceState?.afterRestore !== "running" ||
          c.deviceState?.afterSecondLoss !== "failed" ||
          c.deviceState?.afterSecondRefusal !== "failed"
        ) {
          problems.push(
            `WebGPU deviceState transitions are ${JSON.stringify(c.deviceState)}, expected running -> lost -> running -> failed`,
          );
        }
        if (c.beginFrameValidAfterLoss !== false) {
          problems.push(
            `WebGPU beginFrame().valid after loss is ${JSON.stringify(c.beginFrameValidAfterLoss)}, expected false`,
          );
        }
        if (c.beginFrameValidAfterSecondLoss !== false) {
          problems.push(
            `WebGPU beginFrame().valid after the second loss is ${JSON.stringify(c.beginFrameValidAfterSecondLoss)}, expected false`,
          );
        }
        if (
          c.restoreResult?.ok !== true ||
          c.restoreResult?.staleHandles !== 0
        ) {
          problems.push(
            `WebGPU restore() did not recover cleanly: ${JSON.stringify(c.restoreResult)}`,
          );
        }
        if (
          c.handles?.unchanged !== true ||
          c.handles?.reusedForPostFrame !== true
        ) {
          problems.push(
            `WebGPU scene handles did not stay valid across restore: ${JSON.stringify(c.handles)}`,
          );
        }
        if (c.terminalStats?.gpuErrors !== 2) {
          problems.push(
            `WebGPU terminal gpuErrors is ${JSON.stringify(c.terminalStats?.gpuErrors)}, expected 2 (one per real loss)`,
          );
        }
        const second = c.secondLoss;
        if (
          second?.triggered !== true ||
          second?.eventObserved !== true ||
          second?.stateAfterLoss !== "failed" ||
          second?.beginFrameValid !== false ||
          second?.restoreAttempts !== 1 ||
          second?.restoreRefused !== true ||
          second?.stateAfterRefusal !== "failed" ||
          second?.restoreResult !== null
        ) {
          problems.push(
            `WebGPU second-loss outcome is not terminal: ${JSON.stringify(second)}`,
          );
        }
        if (second?.error?.code !== "E_DEVICE_LOST") {
          problems.push(
            `WebGPU second restore error is ${JSON.stringify(second?.error)}, expected E_DEVICE_LOST`,
          );
        }
        if (
          c.unobserved?.noAssetRefetch !== null ||
          c.unobserved?.noGameRestart !== null
        ) {
          problems.push(
            `WebGPU contextloss claimed unobservable properties instead of PENDING: ${JSON.stringify(c.unobserved)}`,
          );
        }
        const recoveredPng = c.recoveredFramePng;
        if (
          typeof recoveredPng?.dataUrl !== "string" ||
          !recoveredPng.dataUrl.startsWith("data:image/png;base64,") ||
          recoveredPng.width !== c.postCapture?.width ||
          recoveredPng.height !== c.postCapture?.height ||
          recoveredPng.capturedBeforeSecondLoss !== true
        ) {
          problems.push(
            `WebGPU contextloss did not preserve the recovered frame as a PNG before the second loss: ${JSON.stringify({ width: recoveredPng?.width, height: recoveredPng?.height, capturedBeforeSecondLoss: recoveredPng?.capturedBeforeSecondLoss, hasDataUrl: typeof recoveredPng?.dataUrl === "string" })}`,
          );
        }
      } else {
        problems.push(
          `contextloss backend is ${JSON.stringify(result.backend)}, expected webgl2 or webgpu`,
        );
      }

      if (
        !Number.isInteger(c.frames?.recoveryToContent) ||
        c.frames.recoveryToContent < 0 ||
        c.frames.recoveryToContent > 60
      ) {
        problems.push(
          `contextloss recovery took ${JSON.stringify(c.frames?.recoveryToContent)} frames after loss, expected 0..60`,
        );
      }
      if (
        !Number.isInteger(c.frames?.framesFromRestoreToContent) ||
        c.frames.framesFromRestoreToContent < 0 ||
        c.frames.framesFromRestoreToContent > 60
      ) {
        problems.push(
          `contextloss recovery took ${JSON.stringify(c.frames?.framesFromRestoreToContent)} frames after restore, expected 0..60`,
        );
      }
      const maxBlankFrames = result.backend === "webgpu" ? 1 : 0;
      const blankFrames = c.frames?.blankFramesAfterRestore;
      if (
        !Number.isInteger(blankFrames) ||
        blankFrames < 0 ||
        blankFrames > maxBlankFrames
      ) {
        problems.push(
          `contextloss published ${JSON.stringify(blankFrames)} blank frame(s) after restore, allowed 0..${maxBlankFrames}`,
        );
      }
      if (c.hashMatchesPreLoss !== true) {
        problems.push(
          `contextloss post-restore hash ${JSON.stringify(c.postCapture?.hash)} does not match pre-loss ${JSON.stringify(c.preCapture?.hash)}`,
        );
      }
      if (c.uncaughtErrors !== 0) {
        problems.push(
          `contextloss observed ${JSON.stringify(c.uncaughtErrors)} uncaught error(s)`,
        );
      }
      const maxRecoveryMs = result.backend === "webgpu" ? 2000 : 1000;
      if (
        !isNonNegativeFinite(c.timing?.recoveryElapsedMs) ||
        c.timing.recoveryElapsedMs > maxRecoveryMs
      ) {
        problems.push(
          `contextloss recovery time is ${JSON.stringify(c.timing?.recoveryElapsedMs)} ms, expected 0..${maxRecoveryMs}`,
        );
      }
      if (c.afterFrame?.backingMatchesDpr !== true) {
        problems.push(
          "contextloss canvas backing does not follow DPR after restore",
        );
      }
      const pixels = Math.max(
        1,
        (c.postCapture?.width ?? 0) * (c.postCapture?.height ?? 0),
      );
      const minimum = Math.max(
        MIN_CONTENT_PIXELS,
        Math.round(pixels * MIN_CONTENT_FRACTION),
      );
      if (
        !(c.postCapture?.nonClearPixels >= minimum) ||
        !(c.postCapture?.distinctColors >= 2)
      ) {
        problems.push(
          `contextloss post-restore capture is blank: nonClearPixels=${JSON.stringify(c.postCapture?.nonClearPixels)} (min ${minimum}), distinctColors=${JSON.stringify(c.postCapture?.distinctColors)}`,
        );
      }
      if (c.pass?.all !== true) {
        problems.push("contextloss case pass.all is not true");
      }
      problems.push(...validateCaseScreenshot(result, screenshotImage));
    }
  } else if (options.case === "assets") {
    const c = result.caseResult;
    if (result.backend !== null) {
      problems.push(
        `assets case backend is ${JSON.stringify(result.backend)}, expected null`,
      );
    }
    if (result.size !== null) {
      problems.push("assets case unexpectedly reports a render size");
    }
    if (c === null || typeof c !== "object") {
      problems.push("assets case has no caseResult");
    } else {
      if (c.fixture?.expectedBytes !== ASSET_CASE_BYTES) {
        problems.push(
          `assets fixture bytes is ${JSON.stringify(c.fixture?.expectedBytes)}, expected ${ASSET_CASE_BYTES}`,
        );
      }
      if (c.load?.state !== "ready" || c.load?.failed !== null) {
        problems.push(
          `asset load state is ${JSON.stringify(c.load?.state)} (failure ${JSON.stringify(c.load?.failed)})`,
        );
      }
      if (c.load?.handleBytes !== ASSET_CASE_BYTES) {
        problems.push(
          `asset handle bytes is ${JSON.stringify(c.load?.handleBytes)}, expected ${ASSET_CASE_BYTES}`,
        );
      }
      if (c.load?.loadedBytes !== ASSET_CASE_BYTES) {
        problems.push(
          `library loadedBytes is ${JSON.stringify(c.load?.loadedBytes)}, expected ${ASSET_CASE_BYTES}`,
        );
      }
      if (c.load?.progressFetched !== ASSET_CASE_BYTES) {
        problems.push(
          `progress.fetched is ${JSON.stringify(c.load?.progressFetched)}, expected ${ASSET_CASE_BYTES}`,
        );
      }
      if (
        c.load?.valueKind !== "woff2" ||
        c.load?.valueBytes !== ASSET_CASE_BYTES
      ) {
        problems.push(
          `decoded value is ${JSON.stringify(c.load?.valueKind)}/${JSON.stringify(c.load?.valueBytes)}, expected woff2/${ASSET_CASE_BYTES}`,
        );
      }
      if (
        !isNonNegativeFinite(c.load?.libraryInitMs) ||
        !isNonNegativeFinite(c.load?.assetLoadMs)
      ) {
        problems.push("asset case did not record finite init/load durations");
      }
      if (typeof c.longTask?.supported !== "boolean") {
        problems.push("asset case longTask.supported is not a boolean");
      }
      if (c.longTask?.within8Ms !== null) {
        problems.push(
          "asset case claims an 8 ms bound; the longtask API cannot support that claim",
        );
      }
      if (c.longTask?.supported === true) {
        if (c.longTask.observedCount === 0) {
          if (c.longTask.maxDurationMs !== null) {
            problems.push(
              "asset case reports a max long-task duration with zero observed entries",
            );
          }
        } else if (!isNonNegativeFinite(c.longTask.maxDurationMs)) {
          problems.push(
            `asset case max long-task duration is ${JSON.stringify(c.longTask.maxDurationMs)} with ${JSON.stringify(c.longTask.observedCount)} entries`,
          );
        }
      } else if (
        c.longTask.observedCount !== 0 ||
        c.longTask.maxDurationMs !== null ||
        typeof c.longTask.note !== "string" ||
        c.longTask.note.length === 0
      ) {
        problems.push(
          "unsupported longtask observation must report zero entries, null max and an explanatory note",
        );
      }
      if (!Array.isArray(c.resourceTiming)) {
        problems.push("asset case has no resourceTiming array");
      } else if (
        !c.resourceTiming.some(
          (entry) => typeof entry.name === "string" && entry.name.endsWith("/fixtures/five-mb.woff2"),
        )
      ) {
        problems.push("asset case has no resource-timing entry for the 5 MiB fixture");
      }
      if (c.pass?.all !== true) {
        problems.push("assets case pass.all is not true");
      }
    }
  } else {
    problems.push(`unknown case ${JSON.stringify(options.case)}`);
  }

  return problems;
}

function validateResult(result, options, fixture, screenshot, screenshotImage) {
  const requestedBackend = options.backend;
  const problems = [];
  if (result === null || typeof result !== "object") {
    return ["page published no window.__M0__ result object"];
  }
  if (result.ok !== true) {
    const code = result.error?.code ? `[${result.error.code}] ` : "";
    return [
      `page reported failure at ${result.stage}: ${code}${
        result.error?.message ?? "unknown error"
      }`,
    ];
  }
  if (result.schema !== PAGE_SCHEMA) {
    problems.push(
      `page schema is ${JSON.stringify(result.schema)}, expected ${PAGE_SCHEMA}`,
    );
  }
  if (!["webgpu", "webgl2"].includes(result.backend)) {
    problems.push(`page backend is invalid: ${JSON.stringify(result.backend)}`);
  }
  if (requestedBackend !== "auto" && result.backend !== requestedBackend) {
    problems.push(
      `requested backend ${requestedBackend} but the page used ${result.backend}`,
    );
  }
  if (result.requestedBackend !== requestedBackend) {
    problems.push(
      `page requestedBackend is ${JSON.stringify(result.requestedBackend)}, expected ${requestedBackend}`,
    );
  }
  if (result.scene !== fixture.scene) {
    problems.push(
      `scene mismatch: ${JSON.stringify(result.scene)}, expected ${fixture.scene}`,
    );
  }
  if (result.sceneKey !== fixture.sceneKey) {
    problems.push(
      `sceneKey mismatch: ${JSON.stringify(result.sceneKey)}, expected ${fixture.sceneKey}`,
    );
  }
  if (result.instances !== fixture.instances) {
    problems.push(
      `instances is ${JSON.stringify(result.instances)}, expected ${fixture.instances}`,
    );
  }
  if (result.fixture?.conformant !== fixture.specConformant) {
    problems.push(
      `page fixture conformant is ${JSON.stringify(result.fixture?.conformant)}, expected ${fixture.specConformant}`,
    );
  }
  const expectedBackingWidth = Math.round(fixture.width * 1);
  const expectedBackingHeight = Math.round(fixture.height * 1);
  if (
    result.size === null ||
    typeof result.size !== "object" ||
    result.size.cssWidth !== fixture.width ||
    result.size.cssHeight !== fixture.height
  ) {
    problems.push(
      `canvas CSS size is ${result.size?.cssWidth}x${result.size?.cssHeight}, expected ${fixture.width}x${fixture.height}`,
    );
  }
  if (result.size?.dpr !== 1) {
    problems.push(`DPR is ${JSON.stringify(result.size?.dpr)}, expected 1 (runner forces it)`);
  }
  if (result.size?.width !== expectedBackingWidth) {
    problems.push(
      `backing width is ${JSON.stringify(result.size?.width)}, expected ${expectedBackingWidth}`,
    );
  }
  if (result.size?.height !== expectedBackingHeight) {
    problems.push(
      `backing height is ${JSON.stringify(result.size?.height)}, expected ${expectedBackingHeight}`,
    );
  }
  if (typeof result.hash !== "string" || !/^[0-9a-f]{8}$/.test(result.hash)) {
    problems.push(
      `hash is not an FNV-1a 32-bit hex string: ${JSON.stringify(result.hash)}`,
    );
  }
  if (result.capture?.frame !== CAPTURE_FRAME) {
    problems.push(
      `golden capture was frame ${JSON.stringify(result.capture?.frame)}, expected ${CAPTURE_FRAME}`,
    );
  }
  if (result.capture?.warmupFrames !== CAPTURE_WARMUP_FRAMES) {
    problems.push(
      `golden capture warmup was ${JSON.stringify(result.capture?.warmupFrames)}, expected ${CAPTURE_WARMUP_FRAMES}`,
    );
  }
  if (
    result.capture?.width !== expectedBackingWidth ||
    result.capture?.height !== expectedBackingHeight
  ) {
    problems.push(
      `capture size is ${result.capture?.width}x${result.capture?.height}, expected ${expectedBackingWidth}x${expectedBackingHeight}`,
    );
  }
  const expectedFrames = options.bench
    ? CAPTURE_FRAME + BENCH_WARMUP_FRAMES + BENCH_MEASURED_FRAMES
    : CAPTURE_FRAME;
  if (result.framesRendered !== expectedFrames) {
    problems.push(
      `framesRendered is ${JSON.stringify(result.framesRendered)}, expected ${expectedFrames}`,
    );
  }
  if (result.drawCalls !== 1) {
    problems.push(`drawCalls is ${JSON.stringify(result.drawCalls)}, expected 1`);
  }
  const expectedTriangles = fixture.instances * 12;
  if (result.triangles !== expectedTriangles) {
    problems.push(
      `triangles is ${JSON.stringify(result.triangles)}, expected ${expectedTriangles}`,
    );
  }
  if (
    typeof result.textureBytes !== "number" ||
    !Number.isFinite(result.textureBytes) ||
    result.textureBytes < 0
  ) {
    problems.push(
      `textureBytes is not a finite non-negative number: ${JSON.stringify(result.textureBytes)}`,
    );
  } else if (result.textureBytes > HARD_TEXTURE_BYTES) {
    problems.push(
      `textureBytes ${result.textureBytes} exceeds the 128 MiB hard budget (${HARD_TEXTURE_BYTES})`,
    );
  }
  if (result.gpuErrors !== 0) {
    problems.push(`gpuErrors is ${JSON.stringify(result.gpuErrors)}, expected 0`);
  }
  if (typeof result.adapter !== "string" || result.adapter.length === 0) {
    problems.push("adapter is missing");
  }
  if (
    typeof result.browser?.name !== "string" ||
    result.browser.name.length === 0 ||
    typeof result.browser?.version !== "string" ||
    result.browser.version.length === 0
  ) {
    problems.push("browser name/version is missing");
  }
  if (
    typeof result.buildHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.buildHash)
  ) {
    problems.push(
      `buildHash is not a SHA-256 hex string: ${JSON.stringify(result.buildHash)}`,
    );
  }
  if (!(result.build?.fileCount >= 1) || !(result.build?.bytes > 0)) {
    problems.push("build hash did not cover any engine module bytes");
  }
  // Brightness is not a valid blank test: the M0 light can leave a real scene
  // dark. Content coverage plus more than one flat colour is the robust signal.
  const backingWidth = Number.isFinite(result.size?.width)
    ? result.size.width
    : 0;
  const backingHeight = Number.isFinite(result.size?.height)
    ? result.size.height
    : 0;
  const pixelCount = Math.max(1, backingWidth * backingHeight);
  const minContentPixels = Math.max(
    MIN_CONTENT_PIXELS,
    Math.round(pixelCount * MIN_CONTENT_FRACTION),
  );
  if (!(result.nonClearPixels >= minContentPixels)) {
    problems.push(
      `nonClearPixels is ${result.nonClearPixels}, expected at least ${minContentPixels} of ${pixelCount} (blank or unreadable canvas)`,
    );
  }
  if (!(result.distinctColors >= 2)) {
    problems.push(
      `distinctColors is ${result.distinctColors}, expected at least 2 (flat canvas)`,
    );
  }
  if (result.texture?.created !== true) {
    problems.push("the page did not report a created base-colour texture");
  }
  if (result.light?.kind !== "built-in-directional") {
    problems.push(
      `unexpected light report: ${JSON.stringify(result.light?.kind)}`,
    );
  }

  if (options.bench) {
    const benchmark = result.benchmark;
    if (benchmark === null || typeof benchmark !== "object") {
      problems.push("benchmark mode requested but the page reported no benchmark");
    } else {
      if (benchmark.enabled !== true) {
        problems.push("benchmark is not marked enabled");
      }
      if (benchmark.warmupFrames !== BENCH_WARMUP_FRAMES) {
        problems.push(
          `benchmark warmupFrames is ${JSON.stringify(benchmark.warmupFrames)}, expected ${BENCH_WARMUP_FRAMES}`,
        );
      }
      if (benchmark.measuredFrames !== BENCH_MEASURED_FRAMES) {
        problems.push(
          `benchmark measuredFrames is ${JSON.stringify(benchmark.measuredFrames)}, expected ${BENCH_MEASURED_FRAMES}`,
        );
      }
      const intervals = benchmark.frameIntervalsMs;
      if (intervals === null || typeof intervals !== "object") {
        problems.push("benchmark has no frameIntervalsMs object");
      } else {
        if (intervals.count !== BENCH_MEASURED_FRAMES) {
          problems.push(
            `benchmark interval count is ${JSON.stringify(intervals.count)}, expected ${BENCH_MEASURED_FRAMES}`,
          );
        }
        for (const key of ["min", "p50", "p95", "max"]) {
          if (
            typeof intervals[key] !== "number" ||
            !Number.isFinite(intervals[key]) ||
            intervals[key] < 0
          ) {
            problems.push(
              `benchmark ${key} is not a finite non-negative number: ${JSON.stringify(intervals[key])}`,
            );
          }
        }
        if (
          Number.isFinite(intervals.min) &&
          Number.isFinite(intervals.p50) &&
          Number.isFinite(intervals.p95) &&
          Number.isFinite(intervals.max) &&
          !(
            intervals.min <= intervals.p50 &&
            intervals.p50 <= intervals.p95 &&
            intervals.p95 <= intervals.max
          )
        ) {
          problems.push(
            `benchmark percentiles are not ordered: min=${intervals.min}, p50=${intervals.p50}, p95=${intervals.p95}, max=${intervals.max}`,
          );
        }
        const expectedStatus =
          intervals.p95 <= BENCH_FRAME_TARGET_MS
            ? "target-met"
            : intervals.p95 <= BENCH_FRAME_HARD_MS
              ? "over-target-under-hard"
              : "hard-fail";
        if (benchmark.budget?.status !== expectedStatus) {
          problems.push(
            `benchmark budget status is ${JSON.stringify(benchmark.budget?.status)}, expected ${expectedStatus}`,
          );
        }
        if (
          benchmark.budget?.targetMs !== BENCH_FRAME_TARGET_MS ||
          benchmark.budget?.hardMs !== BENCH_FRAME_HARD_MS
        ) {
          problems.push("benchmark budget target/hard values are not 14/20 ms");
        }
      }
      if (benchmark.statsConsistent !== true) {
        problems.push("benchmark per-frame draw/triangle/instance stats were inconsistent");
      }
      const mirrored = [
        ["drawCalls", result.drawCalls],
        ["triangles", result.triangles],
        ["instances", result.instances],
        ["textureBytes", result.textureBytes],
        ["gpuErrors", result.gpuErrors],
        ["adapter", result.adapter],
        ["buildHash", result.buildHash],
      ];
      for (const [key, expected] of mirrored) {
        if (benchmark[key] !== expected) {
          problems.push(
            `benchmark ${key} is ${JSON.stringify(benchmark[key])}, expected ${JSON.stringify(expected)}`,
          );
        }
      }
      if (
        benchmark.browser?.name !== result.browser?.name ||
        benchmark.browser?.version !== result.browser?.version
      ) {
        problems.push("benchmark browser does not match the page browser");
      }
      if (
        benchmark.size?.cssWidth !== fixture.width ||
        benchmark.size?.cssHeight !== fixture.height ||
        benchmark.size?.dpr !== 1 ||
        benchmark.size?.width !== expectedBackingWidth ||
        benchmark.size?.height !== expectedBackingHeight
      ) {
        problems.push("benchmark size/DPR does not match the fixture");
      }
      if (benchmark.stats?.gpuErrors !== 0) {
        problems.push("benchmark stats report GPU errors");
      }
    }
  } else if (result.benchmark !== null) {
    problems.push("page reported benchmark data without --bench");
  }

  if (screenshot === null) {
    problems.push("no canvas screenshot was captured");
  } else {
    if (
      screenshot.width !== expectedBackingWidth ||
      screenshot.height !== expectedBackingHeight
    ) {
      problems.push(
        `screenshot clip is ${screenshot.width}x${screenshot.height}, expected ${expectedBackingWidth}x${expectedBackingHeight}`,
      );
    }
    if (
      screenshotImage === null ||
      screenshotImage.width !== expectedBackingWidth ||
      screenshotImage.height !== expectedBackingHeight
    ) {
      problems.push(
        `screenshot PNG is ${screenshotImage?.width}x${screenshotImage?.height}, expected ${expectedBackingWidth}x${expectedBackingHeight}`,
      );
    }
  }
  return problems;
}

async function readGolden() {
  let text;
  try {
    text = await readFile(GOLDEN_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new Error(`could not read ${GOLDEN_PATH}: ${errorText(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${GOLDEN_PATH} is not valid JSON: ${errorText(error)}`);
  }
}

function goldenFixtureKey(fixture) {
  return `${fixture.scene}|${fixture.instances}|${fixture.width}x${fixture.height}`;
}

function goldenFromExisting(existing) {
  if (
    existing !== null &&
    typeof existing === "object" &&
    existing.version === 2 &&
    existing.fixtures !== null &&
    typeof existing.fixtures === "object"
  ) {
    return { version: 2, fixtures: { ...existing.fixtures } };
  }
  const fixtures = {};
  // Migrate the real v1 cube goldens into v2 without inventing any hash. The
  // v1 entry format was per-backend and already referenced this one fixture.
  if (
    existing !== null &&
    typeof existing === "object" &&
    existing.version === 1 &&
    existing.scene === SCENES.cube.scene &&
    existing.width === SCENES.cube.specWidth &&
    existing.height === SCENES.cube.specHeight &&
    existing.backends !== null &&
    typeof existing.backends === "object"
  ) {
    const migratedFixture = {
      scene: SCENES.cube.scene,
      sceneKey: "cube",
      instances: 1,
      width: existing.width,
      height: existing.height,
      specConformant: true,
      backends: { ...existing.backends },
    };
    fixtures[
      goldenFixtureKey({
        scene: SCENES.cube.scene,
        instances: 1,
        width: existing.width,
        height: existing.height,
      })
    ] = migratedFixture;
  }
  return { version: 2, fixtures };
}

function compareGolden(golden, result, fixture) {
  if (golden === null) {
    return {
      status: "missing",
      expectedHash: null,
      keys: null,
      detail: `no golden.json at ${GOLDEN_PATH}; run once per backend with --update-golden`,
    };
  }
  if (golden.version !== 2) {
    return {
      status: "stale",
      expectedHash: null,
      keys: null,
      detail: `golden.json is version ${JSON.stringify(golden.version)}, expected 2; record this fixture with --update-golden`,
    };
  }
  const fixtures =
    golden.fixtures !== null && typeof golden.fixtures === "object"
      ? golden.fixtures
      : null;
  if (fixtures === null) {
    return {
      status: "stale",
      expectedHash: null,
      keys: null,
      detail: "golden.json has no fixtures object",
    };
  }
  const key = goldenFixtureKey(fixture);
  const entry = fixtures[key];
  if (entry === null || typeof entry !== "object") {
    return {
      status: "missing-fixture",
      expectedHash: null,
      keys: Object.keys(fixtures),
      detail: `golden.json has no fixture ${key}; record it with --update-golden`,
    };
  }
  if (
    entry.scene !== fixture.scene ||
    entry.instances !== fixture.instances ||
    entry.width !== fixture.width ||
    entry.height !== fixture.height
  ) {
    return {
      status: "stale",
      expectedHash: null,
      keys: Object.keys(fixtures),
      detail: `golden fixture ${key} describes ${JSON.stringify(entry.scene)} / ${entry.instances} / ${entry.width}x${entry.height}`,
    };
  }
  const backendEntry =
    entry.backends !== null && typeof entry.backends === "object"
      ? entry.backends[result.backend]
      : null;
  if (backendEntry === null || typeof backendEntry !== "object" || typeof backendEntry.hash !== "string") {
    return {
      status: "missing-backend",
      expectedHash: null,
      keys: Object.keys(fixtures),
      detail: `golden.json has no ${result.backend} hash for ${key}; record it with --backend ${result.backend} --update-golden`,
    };
  }
  if (backendEntry.hash === result.hash) {
    return {
      status: "matched",
      expectedHash: backendEntry.hash,
      keys: Object.keys(fixtures),
      detail: null,
    };
  }
  return {
    status: "mismatch",
    expectedHash: backendEntry.hash,
    keys: Object.keys(fixtures),
    detail: `hash ${result.hash} does not match golden ${backendEntry.hash} for ${result.backend} / ${key}`,
  };
}

async function writeGolden(existing, result, fixture, chromeVersion, engineBuildHash) {
  const golden = goldenFromExisting(existing);
  const key = goldenFixtureKey(fixture);
  const existingEntry =
    golden.fixtures[key] !== null && typeof golden.fixtures[key] === "object"
      ? golden.fixtures[key]
      : null;
  const backends =
    existingEntry?.backends !== null &&
    typeof existingEntry?.backends === "object"
      ? { ...existingEntry.backends }
      : {};
  backends[result.backend] = {
    hash: result.hash,
    nonClearPixels: result.nonClearPixels,
    brightPixels: result.brightPixels,
    distinctColors: result.distinctColors,
    drawCalls: result.drawCalls,
    triangles: result.triangles,
    instances: result.instances,
    textureBytes: result.textureBytes,
    gpuErrors: result.gpuErrors,
    adapter: result.adapter ?? null,
    chrome: chromeVersion,
    browser: result.browser ?? null,
    dpr: result.size?.dpr ?? null,
    buildHash: result.buildHash ?? null,
    engineBuildHash: engineBuildHash ?? null,
    captureFrame: result.capture?.frame ?? null,
    benchmark:
      result.benchmark === null
        ? null
        : {
            p50: result.benchmark.frameIntervalsMs?.p50 ?? null,
            p95: result.benchmark.frameIntervalsMs?.p95 ?? null,
            max: result.benchmark.frameIntervalsMs?.max ?? null,
            count: result.benchmark.frameIntervalsMs?.count ?? null,
            warmupFrames: result.benchmark.warmupFrames ?? null,
            measuredFrames: result.benchmark.measuredFrames ?? null,
            status: result.benchmark.budget?.status ?? null,
          },
    recordedAt: new Date().toISOString(),
  };
  golden.fixtures[key] = {
    scene: fixture.scene,
    sceneKey: fixture.sceneKey,
    instances: fixture.instances,
    width: fixture.width,
    height: fixture.height,
    specConformant: fixture.specConformant,
    backends,
  };
  await writeFile(
    GOLDEN_PATH,
    `${JSON.stringify(golden, null, 2)}\n`,
    "utf8",
  );
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      child.off("exit", finish);
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
  });
}

async function stopChrome(handle) {
  if (!handle) {
    return;
  }
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill();
  await waitForExit(child, 3000);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32" && typeof child.pid === "number") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGKILL");
    }
    await waitForExit(child, 2000);
  }
}

async function removeProfile(profileDir) {
  try {
    await rm(profileDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch {
    // A locked temp profile is not worth failing the run over.
  }
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`m0-engine: ${errorText(error)}\n\n${USAGE}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const fixture = options.fixture;
  const viewport = viewportFor(fixture, options.case);
  const startedAt = Date.now();
  let profileDir = null;
  let serverHandle = null;
  let chromeHandle = null;
  let cdp = null;
  let chromeVersion = null;
  let engineBuild = null;
  let diagnostics = [];
  let demoUrl = null;
  let pageState = null;
  let pageResult = null;
  let screenshot = null;
  let screenshotImage = null;
  let screenshotCaptureError = null;
  let screenshotDecodeError = null;
  let terminalScreenshot = null;
  let terminalScreenshotImage = null;
  let terminalScreenshotError = null;
  let recoveredScreenshot = null;
  let recoveredScreenshotImage = null;
  let recoveredScreenshotError = null;
  let functionalFailure = null;
  let parityFailure = null;
  let crossBackendDiff = null;
  let goldenStatus = options.case === null ? "skipped" : "not-applicable";
  let expectedHash = null;
  let goldenUpdated = false;

  try {
    const chromePath = resolveChrome(options.chrome);
    engineBuild = await computeEngineBuildHash();
    profileDir = await mkdtemp(path.join(os.tmpdir(), "pocketpad-m0-engine-"));
    serverHandle = await startStaticServer(options);
    chromeHandle = await launchChrome(chromePath, profileDir, viewport);

    const deadline = startedAt + options.timeoutMs;
    const startupDeadline = Math.min(
      deadline,
      Date.now() + STARTUP_TIMEOUT_MS,
    );
    const port = await waitForDevToolsPort(
      profileDir,
      startupDeadline,
      chromeHandle.child,
      chromeHandle.state,
    );
    chromeVersion = await readBrowserVersion(port);
    const target = await waitForPageTarget(
      port,
      Math.min(deadline, Date.now() + STARTUP_TIMEOUT_MS),
      chromeHandle.child,
      chromeHandle.state,
    );
    cdp = await CdpConnection.open(
      target.webSocketDebuggerUrl,
      Math.max(1000, deadline - Date.now()),
    );
    diagnostics = attachDiagnostics(cdp);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: options.dpr,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });

    const params = new URLSearchParams({
      backend: options.backend,
      scene: fixture.sceneKey,
      instances: String(fixture.instances),
      size: `${fixture.width}x${fixture.height}`,
    });
    if (options.bench) {
      params.set("bench", "1");
    }
    if (options.case !== null) {
      params.set("case", options.case);
    }
    demoUrl = `${serverHandle.origin}${PAGE_PATH}?${params.toString()}`;
    const navigation = await cdp.send("Page.navigate", { url: demoUrl });
    if (navigation.errorText) {
      throw new Error(`could not open ${demoUrl}: ${navigation.errorText}`);
    }

    try {
      pageState = await waitForDemo(cdp, deadline);
      pageResult = pageState.result;
    } catch (error) {
      functionalFailure = errorText(error);
      try {
        pageState = await evaluate(
          cdp,
          `({
            href: location.href,
            ready: document.readyState,
            done: window.__M0_DONE__ === true,
            result: window.__M0__ ?? null,
            status: document.querySelector("#status") ? document.querySelector("#status").textContent : null
          })`,
        );
        pageResult = pageState?.result ?? null;
      } catch {
        // Keep the original wait failure; the partial page state is optional.
      }
    }

    const shouldCaptureScreenshot =
      options.case !== "assets" && pageResult?.blocked !== true;
    if (shouldCaptureScreenshot) {
      try {
        const rect = await evaluate(
          cdp,
          `(() => {
            const canvas = document.querySelector("#view");
            if (!canvas) return null;
            const bounds = canvas.getBoundingClientRect();
            return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
          })()`,
        );
        if (!rect) {
          throw new Error("canvas #view was not found");
        }
        screenshot = await captureCanvasScreenshot(cdp, rect);
        try {
          screenshotImage = decodePng(screenshot.bytes, "canvas screenshot");
        } catch (error) {
          screenshotDecodeError = errorText(error);
        }
      } catch (error) {
        screenshotCaptureError = errorText(error);
      }
    }

    // The terminal second loss leaves the compositor canvas black. The page
    // preserved the real recovered frame as a PNG before that loss; use it as
    // the primary artifact and keep the terminal CDP screenshot separately.
    if (options.case === "contextloss" && pageResult?.backend === "webgpu") {
      const recoveredPng = pageResult?.caseResult?.recoveredFramePng;
      const prefix = "data:image/png;base64,";
      try {
        if (
          typeof recoveredPng?.dataUrl !== "string" ||
          !recoveredPng.dataUrl.startsWith(prefix)
        ) {
          throw new Error(
            "page did not publish a recoveredFramePng data URL",
          );
        }
        const bytes = Buffer.from(
          recoveredPng.dataUrl.slice(prefix.length),
          "base64",
        );
        if (bytes.length < 1000) {
          throw new Error(
            `recovered frame PNG is suspiciously small (${bytes.length} bytes)`,
          );
        }
        if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
          throw new Error("recovered frame bytes are not a PNG");
        }
        const image = decodePng(bytes, "recovered frame PNG");
        if (
          image.width !== recoveredPng.width ||
          image.height !== recoveredPng.height
        ) {
          throw new Error(
            `recovered frame PNG is ${image.width}x${image.height}, page reported ${recoveredPng.width}x${recoveredPng.height}`,
          );
        }
        terminalScreenshot = screenshot;
        terminalScreenshotImage = screenshotImage;
        terminalScreenshotError =
          screenshotCaptureError ?? screenshotDecodeError;
        recoveredScreenshot = {
          bytes,
          width: image.width,
          height: image.height,
        };
        recoveredScreenshotImage = image;
        screenshot = recoveredScreenshot;
        screenshotImage = recoveredScreenshotImage;
        screenshotCaptureError = null;
        screenshotDecodeError = null;
      } catch (error) {
        recoveredScreenshotError = errorText(error);
      }
    }

    if (functionalFailure === null) {
      const problems =
        options.case === null
          ? validateResult(
              pageResult,
              options,
              fixture,
              screenshot,
              screenshotImage,
            )
          : validateCaseResult(pageResult, options, fixture, screenshotImage);
      if (screenshotDecodeError !== null) {
        problems.push(`screenshot PNG decode failed: ${screenshotDecodeError}`);
      }
      if (screenshotCaptureError !== null) {
        problems.push(`canvas screenshot failed: ${screenshotCaptureError}`);
      }
      if (recoveredScreenshotError !== null) {
        problems.push(
          `recovered frame PNG failed: ${recoveredScreenshotError}`,
        );
      }
      if (problems.length > 0) {
        functionalFailure = problems.join("; ");
      }
    }

    if (functionalFailure === null && options.case === null) {
      if (options.updateGolden) {
        await writeGolden(
          await readGolden(),
          pageResult,
          fixture,
          chromeVersion,
          engineBuild?.hash ?? null,
        );
        goldenStatus = "updated";
        goldenUpdated = true;
        expectedHash = pageResult.hash;
      } else {
        const comparison = compareGolden(await readGolden(), pageResult, fixture);
        goldenStatus = comparison.status;
        expectedHash = comparison.expectedHash;
        if (comparison.status !== "matched") {
          functionalFailure = comparison.detail;
        }
      }
    }

    if (
      options.case === null &&
      pageResult?.ok === true &&
      screenshot !== null &&
      screenshotImage !== null
    ) {
      try {
        screenshot.path = options.screenshot
          ? path.resolve(options.screenshot)
          : defaultArtifactBase(fixture, pageResult.backend).png;
        crossBackendDiff = await computeCrossBackendDiff({
          result: pageResult,
          fixture,
          screenshot,
          screenshotImage,
          engineBuildHash: engineBuild?.hash ?? null,
        });
        if (
          functionalFailure === null &&
          (crossBackendDiff.status === "size-mismatch" ||
            (crossBackendDiff.status === "compared" &&
              crossBackendDiff.withinBudget === false))
        ) {
          parityFailure =
            crossBackendDiff.status === "size-mismatch"
              ? crossBackendDiff.detail
              : `cross-backend pixel diff ${crossBackendDiff.differentPercent}% of pixels exceed ${PARITY_CHANNEL_DELTA}/255 in a channel; allowed ${PARITY_MAX_PERCENT}%`;
        }
      } catch (error) {
        const detail = errorText(error);
        crossBackendDiff = {
          status: "error",
          currentBackend: pageResult.backend,
          counterpartBackend:
            pageResult.backend === "webgpu" ? "webgl2" : "webgpu",
          currentHash: pageResult.hash,
          counterpartHash: null,
          hashesCompared: false,
          thresholdChannelDelta: PARITY_CHANNEL_DELTA,
          maxDifferentPercent: PARITY_MAX_PERCENT,
          withinBudget: null,
          detail,
        };
        if (functionalFailure === null) {
          parityFailure = `cross-backend pixel diff could not run: ${detail}`;
        }
      }
    }
  } catch (error) {
    functionalFailure = functionalFailure ?? errorText(error);
  } finally {
    if (cdp) {
      cdp.close();
    }
    await stopChrome(chromeHandle);
    if (serverHandle) {
      await closeStaticServer(serverHandle);
    }
    if (profileDir) {
      await removeProfile(profileDir);
    }
  }

  const backendKey =
    pageResult !== null && typeof pageResult.backend === "string"
      ? pageResult.backend
      : options.case === "assets"
        ? "assets"
        : options.backend;
  const artifactBase = defaultArtifactBase(fixture, backendKey, options.case);
  const jsonPath = options.out
    ? path.resolve(options.out)
    : artifactBase.json;
  const screenshotPath = options.screenshot
    ? path.resolve(options.screenshot)
    : artifactBase.png;

  const recoveredIsPrimary = recoveredScreenshot !== null;
  let screenshotInfo = {
    path: null,
    bytes: 0,
    sha256: null,
    width: screenshotImage?.width ?? screenshot?.width ?? null,
    height: screenshotImage?.height ?? screenshot?.height ?? null,
    png: screenshotImage
      ? {
          width: screenshotImage.width,
          height: screenshotImage.height,
          colorType: screenshotImage.colorType,
          bitDepth: screenshotImage.bitDepth,
        }
      : null,
    source: recoveredIsPrimary
      ? "page 2D canvas PNG of the recovered WebGPU frame before the second loss"
      : "CDP Page.captureScreenshot of the canvas",
    capturedBeforeSecondLoss: recoveredIsPrimary ? true : null,
    captureError: screenshotCaptureError,
    decodeError: screenshotDecodeError,
    error: screenshotCaptureError ?? screenshotDecodeError,
  };
  if (screenshot !== null) {
    try {
      await mkdir(path.dirname(screenshotPath), { recursive: true });
      await writeFile(screenshotPath, screenshot.bytes);
      screenshotInfo = {
        ...screenshotInfo,
        path: screenshotPath,
        bytes: screenshot.bytes.length,
        sha256: createHash("sha256").update(screenshot.bytes).digest("hex"),
      };
    } catch (error) {
      functionalFailure =
        functionalFailure ?? `could not write screenshot: ${errorText(error)}`;
    }
  }

  let terminalScreenshotInfo = null;
  if (terminalScreenshot !== null) {
    const terminalPath = path.join(
      path.dirname(screenshotPath),
      `${backendKey}-terminal.png`,
    );
    terminalScreenshotInfo = {
      path: null,
      bytes: 0,
      sha256: null,
      width:
        terminalScreenshotImage?.width ?? terminalScreenshot.width ?? null,
      height:
        terminalScreenshotImage?.height ?? terminalScreenshot.height ?? null,
      png: terminalScreenshotImage
        ? {
            width: terminalScreenshotImage.width,
            height: terminalScreenshotImage.height,
            colorType: terminalScreenshotImage.colorType,
            bitDepth: terminalScreenshotImage.bitDepth,
          }
        : null,
      source: "CDP Page.captureScreenshot after the terminal second loss",
      capturedBeforeSecondLoss: false,
      captureError: terminalScreenshotError,
      note:
        "The device is terminal after the second loss; this screenshot is supplementary and is not used as recovery evidence.",
    };
    try {
      await mkdir(path.dirname(terminalPath), { recursive: true });
      await writeFile(terminalPath, terminalScreenshot.bytes);
      terminalScreenshotInfo = {
        ...terminalScreenshotInfo,
        path: terminalPath,
        bytes: terminalScreenshot.bytes.length,
        sha256: createHash("sha256")
          .update(terminalScreenshot.bytes)
          .digest("hex"),
      };
    } catch (error) {
      terminalScreenshotInfo = {
        ...terminalScreenshotInfo,
        error: `could not write terminal screenshot: ${errorText(error)}`,
      };
    }
  }

  const blocked = pageResult?.blocked === true;
  const blockedFailure = blocked
    ? `blocked: ${pageResult.blocker?.reason ?? pageResult.error?.message ?? "no reason reported"}`
    : null;
  const finalFailure = functionalFailure ?? parityFailure ?? blockedFailure;
  const benchmark = pageResult?.benchmark ?? null;
  const p95 =
    typeof benchmark?.frameIntervalsMs?.p95 === "number" &&
    Number.isFinite(benchmark.frameIntervalsMs.p95)
      ? benchmark.frameIntervalsMs.p95
      : null;
  const acceptance =
    options.case === null
      ? {
          specConformant: fixture.specConformant,
          functionalPass: functionalFailure === null,
          goldenPass: goldenStatus === "matched" || goldenStatus === "updated",
          crossBackendParityPass:
            crossBackendDiff === null
              ? null
              : crossBackendDiff.status === "compared"
                ? crossBackendDiff.withinBudget
                : crossBackendDiff.status === "build-mismatch" ||
                    crossBackendDiff.status === "not-available" ||
                    crossBackendDiff.status === "no-current-capture"
                  ? null
                  : false,
          benchmarkTargetMet:
            options.bench ? (p95 === null ? null : p95 <= BENCH_FRAME_TARGET_MS) : null,
          benchmarkHardMet:
            options.bench ? (p95 === null ? null : p95 <= BENCH_FRAME_HARD_MS) : null,
          textureBytesWithinSpecExpected:
            typeof pageResult?.textureBytes === "number"
              ? pageResult.textureBytes <= SPEC_TEXTURE_BYTES
              : null,
          gpuErrorsZero:
            typeof pageResult?.gpuErrors === "number"
              ? pageResult.gpuErrors === 0
              : null,
        }
      : {
          case: options.case,
          specConformant: false,
          functionalPass: blocked === false && functionalFailure === null,
          casePass: blocked === false && functionalFailure === null,
          blocked,
          goldenPass: null,
          crossBackendParityPass: null,
          benchmarkTargetMet: null,
          benchmarkHardMet: null,
          textureBytesWithinSpecExpected: null,
          gpuErrorsZero:
            typeof pageResult?.gpuErrors === "number"
              ? pageResult.gpuErrors === 0
              : null,
        };

  const summary = {
    ok: finalFailure === null,
    scene: fixture.scene,
    fixture: {
      sceneKey: fixture.sceneKey,
      instances: fixture.instances,
      width: fixture.width,
      height: fixture.height,
      specInstances: fixture.specInstances,
      specWidth: fixture.specWidth,
      specHeight: fixture.specHeight,
      specConformant: fixture.specConformant,
    },
    requestedBackend: options.backend,
    backend: pageResult?.backend ?? null,
    case: options.case,
    dpr: options.dpr,
    blocked,
    bench: options.bench,
    engineBuild,
    chrome: chromeVersion,
    url: demoUrl,
    durationMs: Date.now() - startedAt,
    pageStatusText: pageState?.status ?? null,
    page: pageResult,
    caseResult: pageResult?.caseResult ?? null,
    benchmark,
    screenshot: screenshotInfo,
    terminalScreenshot: terminalScreenshotInfo,
    crossBackendDiff,
    acceptance,
    golden: {
      path: GOLDEN_PATH,
      fixtureKey: goldenFixtureKey(fixture),
      status: goldenStatus,
      expectedHash,
      updated: goldenUpdated,
    },
    diagnostics: diagnostics.slice(-20),
    blocker: pageResult?.blocker ?? extractGpuBlocker(diagnostics),
    functionalError: functionalFailure,
    parityError: parityFailure,
    error: finalFailure,
  };

  try {
    await mkdir(path.dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  } catch (error) {
    process.stderr.write(
      `m0-engine: could not write ${jsonPath}: ${errorText(error)}\n`,
    );
    return 1;
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return finalFailure === null ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`m0-engine: ${errorText(error)}\n`);
    process.exitCode = 1;
  },
);

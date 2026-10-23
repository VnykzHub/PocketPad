#!/usr/bin/env node
/**
 * PocketPad engine bake-off runner.
 *
 * Serves the repository root on 127.0.0.1, launches headless Chrome with a
 * throwaway profile at 1920x1080 DPR 1, navigates to each contender page,
 * waits for window.__BAKEOFF__.ready, warms up, then samples 60 s of frame
 * intervals with an independent requestAnimationFrame probe. Each contender
 * is run three times, serially, on a fresh Chrome profile.
 *
 * Missing contenders are recorded as "not-run" with the exact reason. This
 * script never fabricates a measurement.
 *
 * Usage:
 *   node run.mjs                          # all three contenders, 3 runs each
 *   node run.mjs --only custom --runs 1   # one contender, one run
 *   node run.mjs --serve-only             # static server for manual checks
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(RUNNER_DIR, "..", "..", "..");

const CONTENDERS = [
  {
    id: "playcanvas",
    label: "PlayCanvas 2.23.3",
    dir: "experiments/bakeoff/playcanvas",
  },
  {
    id: "babylon",
    label: "Babylon.js 9.32.0",
    dir: "experiments/bakeoff/babylon",
  },
  {
    id: "custom",
    label: "Custom (current engine packages)",
    dir: "experiments/bakeoff/custom",
  },
  {
    id: "selftest",
    label: "Runner self-test (not a contender)",
    dir: "experiments/bakeoff/runner/selftest",
    internal: true,
  },
];

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".cjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".glb", "model/gltf-binary"],
  [".gltf", "model/gltf+json"],
  [".bin", "application/octet-stream"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ktx2", "image/ktx2"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".wasm", "application/wasm"],
  [".map", "application/json; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
]);

const BUILD_DIRS = ["dist", "build", "www"];
const CODE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".wasm",
  ".json",
]);
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"]);
const SOURCE_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".vite",
  "dist",
  "build",
  "www",
  "coverage",
]);

const WebSocketImpl = globalThis.WebSocket ?? (await import("ws")).default;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function errorText(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function contentTypeFor(filePath) {
  return (
    CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ??
    "application/octet-stream"
  );
}

function parseArgs(argv) {
  const options = {
    only: null,
    runs: 3,
    warmupSeconds: 5,
    measuredSeconds: 60,
    readyTimeoutSeconds: 45,
    chromePath: null,
    port: 0,
    out: path.join(RUNNER_DIR, "results.json"),
    serveOnly: false,
    headed: false,
    keepProfiles: false,
    capped: false,
    viewport: { width: 1920, height: 1080 },
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} needs a value`);
      }
      return argv[index];
    };
    switch (arg) {
      case "--only":
        options.only = nextValue()
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        break;
      case "--runs":
        options.runs = Number.parseInt(nextValue(), 10);
        break;
      case "--warmup":
        options.warmupSeconds = Number.parseFloat(nextValue());
        break;
      case "--seconds":
        options.measuredSeconds = Number.parseFloat(nextValue());
        break;
      case "--ready-timeout":
        options.readyTimeoutSeconds = Number.parseFloat(nextValue());
        break;
      case "--chrome":
        options.chromePath = nextValue();
        break;
      case "--port":
        options.port = Number.parseInt(nextValue(), 10);
        break;
      case "--out":
        options.out = path.resolve(process.cwd(), nextValue());
        break;
      case "--serve-only":
        options.serveOnly = true;
        break;
      case "--headed":
        options.headed = true;
        break;
      case "--keep-profiles":
        options.keepProfiles = true;
        break;
      case "--capped":
        options.capped = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) {
    throw new Error("--runs must be an integer from 1 to 10");
  }
  if (!(options.warmupSeconds >= 0 && options.warmupSeconds <= 120)) {
    throw new Error("--warmup must be 0 to 120 seconds");
  }
  if (!(options.measuredSeconds >= 1 && options.measuredSeconds <= 600)) {
    throw new Error("--seconds must be 1 to 600");
  }
  if (
    !Number.isFinite(options.readyTimeoutSeconds) ||
    options.readyTimeoutSeconds < 1 ||
    options.readyTimeoutSeconds > 300
  ) {
    throw new Error("--ready-timeout must be 1 to 300 seconds");
  }
  const known = new Set(CONTENDERS.map((contender) => contender.id));
  if (options.only) {
    for (const id of options.only) {
      if (!known.has(id)) {
        throw new Error(
          `--only has unknown contender "${id}"; valid ids: ${[...known].join(", ")}`,
        );
      }
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      "PocketPad bake-off runner",
      "",
      "  node run.mjs [options]",
      "",
      "  --only <ids>          comma-separated contender ids (default: playcanvas,babylon,custom)",
      "  --runs <n>            runs per contender (default: 3)",
      "  --warmup <seconds>    warm-up before sampling (default: 5)",
      "  --seconds <seconds>   measured window per run (default: 60)",
      "  --ready-timeout <s>   wait for __BAKEOFF__.ready (default: 45)",
      "  --chrome <path>       Chrome/Chromium binary (default: auto-detect)",
      "  --port <n>            static server port (default: ephemeral)",
      "  --out <file>          results JSON path (default: runner/results.json)",
      "  --serve-only          only run the static server; print URLs and wait",
      "  --headed              show the Chrome window",
      "  --keep-profiles       keep throwaway Chrome profiles for debugging",
      "  --capped              sample at the display cadence instead of uncapped",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Static server: repository root + contender dist fallback
// ---------------------------------------------------------------------------

function baseHeaders() {
  return {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

function sendText(response, status, text) {
  const body = Buffer.from(`${text}\n`, "utf8");
  response.writeHead(status, {
    ...baseHeaders(),
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": String(body.length),
  });
  response.end(body);
}

function contenderParts(segments) {
  if (
    segments[0] !== "experiments" ||
    segments[1] !== "bakeoff" ||
    segments.length < 3
  ) {
    return null;
  }
  return {
    id: segments[2],
    rest: segments.slice(3),
  };
}

async function resolveRequest(pathname, activeContenderId) {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { status: 400 };
  }
  if (pathname === "/favicon.ico") {
    return { status: 204 };
  }
  const literal = path.join(REPO_ROOT, ...segments);
  const contender = contenderParts(segments);
  const isDirectoryRequest = pathname.endsWith("/");
  const candidates = [];
  if (isDirectoryRequest) {
    if (contender) {
      for (const build of BUILD_DIRS) {
        candidates.push(
          path.join(
            REPO_ROOT,
            "experiments",
            "bakeoff",
            contender.id,
            build,
            ...contender.rest,
            "index.html",
          ),
        );
      }
    }
    candidates.push(path.join(literal, "index.html"));
  } else {
    candidates.push(literal);
    try {
      const info = await stat(literal);
      if (info.isDirectory()) {
        return { redirect: `${pathname}/` };
      }
    } catch {
      // Missing paths fall through to the dist fallback below.
    }
    if (
      contender &&
      contender.rest.length > 0 &&
      !BUILD_DIRS.includes(contender.rest[0])
    ) {
      for (const build of BUILD_DIRS) {
        candidates.push(
          path.join(
            REPO_ROOT,
            "experiments",
            "bakeoff",
            contender.id,
            build,
            ...contender.rest,
          ),
        );
      }
    }
  }
  // Vite's default base emits absolute URLs such as /assets/index-abc.js.
  // During a measured run, attribute those missing paths to the contender
  // that is currently loaded, so a build with the default base still works.
  if (activeContenderId) {
    for (const build of BUILD_DIRS) {
      candidates.push(
        path.join(
          REPO_ROOT,
          "experiments",
          "bakeoff",
          activeContenderId,
          build,
          ...segments,
        ),
      );
    }
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        return { file: candidate };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return {
    status: 404,
    tried: candidates.map((candidate) =>
      path.relative(REPO_ROOT, candidate).split(path.sep).join("/"),
    ),
  };
}

function startServer(port) {
  let activeContenderId = null;
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "method not allowed");
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://127.0.0.1").pathname,
      );
    } catch {
      sendText(response, 400, "bad request");
      return;
    }
    if (pathname.includes("\0")) {
      sendText(response, 400, "bad request");
      return;
    }
    resolveRequest(pathname, activeContenderId)
      .then(async (resolved) => {
        if (resolved.redirect) {
          response.writeHead(301, {
            ...baseHeaders(),
            Location: resolved.redirect,
          });
          response.end();
          return;
        }
        if (resolved.status === 204) {
          response.writeHead(204, baseHeaders());
          response.end();
          return;
        }
        if (!resolved.file) {
          sendText(
            response,
            404,
            [
              `not found: ${pathname}`,
              ...(resolved.tried ?? []).map((entry) => `tried: ${entry}`),
            ].join("\n"),
          );
          return;
        }
        const bytes = await readFile(resolved.file);
        response.writeHead(200, {
          ...baseHeaders(),
          "Content-Type": contentTypeFor(resolved.file),
          "Content-Length": String(bytes.length),
        });
        response.end(request.method === "HEAD" ? undefined : bytes);
      })
      .catch((error) => {
        sendText(response, 500, `runner error: ${errorText(error)}`);
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        port: address.port,
        setActive(id) {
          activeContenderId = id;
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Chrome launch and CDP
// ---------------------------------------------------------------------------

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

async function launchChrome(chromePath, profileDir, options) {
  const args = [
    ...(options.headed ? [] : ["--headless=new"]),
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
    ...(options.capped
      ? []
      : ["--disable-frame-rate-limit", "--disable-gpu-vsync"]),
    `--window-size=${options.viewport.width},${options.viewport.height}`,
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

async function terminateChrome(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.kill();
  } catch {
    // Fall through to taskkill below.
  }
  const finished = await Promise.race([
    exited.then(() => true),
    delay(3000).then(() => false),
  ]);
  if (!finished && child.exitCode === null) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      // The process is already gone.
    }
    await Promise.race([exited, delay(3000)]);
  }
}

async function waitForDevToolsPort(profileDir, child, state, timeoutMs) {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Chrome exited with code ${child.exitCode} before opening DevTools.${chromeDiagnostics(state)}`,
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
        throw error;
      }
    }
    await delay(100);
  }
  throw new Error(
    `Chrome did not open a DevTools port within ${timeoutMs} ms.${chromeDiagnostics(state)}`,
  );
}

function chromeDiagnostics(state) {
  const text = state && state.stderr ? state.stderr.trim() : "";
  return text ? `\nChrome stderr:\n${text}` : "";
}

function openSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const handlers = { message: [], close: [], error: [] };
    const emit = (event, value) => {
      for (const handler of handlers[event]) {
        try {
          handler(value);
        } catch {
          // Diagnostics must never break the run.
        }
      }
    };
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      reject(new Error(`timed out opening CDP WebSocket after ${timeoutMs} ms`));
    }, timeoutMs);
    const onOpen = () => {
      clearTimeout(timer);
      resolve({
        send(text) {
          socket.send(text);
        },
        close() {
          try {
            socket.close();
          } catch {
            // Already closed.
          }
        },
        on(event, handler) {
          handlers[event].push(handler);
        },
      });
    };
    if (typeof socket.addEventListener === "function") {
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", (event) => {
        emit(
          "message",
          typeof event.data === "string" ? event.data : String(event.data),
        );
      });
      socket.addEventListener("close", () => emit("close"));
      socket.addEventListener("error", (event) => emit("error", event));
    } else {
      socket.on("open", onOpen);
      socket.on("message", (data) => emit("message", data.toString("utf8")));
      socket.on("close", () => emit("close"));
      socket.on("error", (event) => emit("error", event));
    }
  });
}

async function connectCdp(webSocketUrl, timeoutMs) {
  const socket = await openSocket(webSocketUrl, timeoutMs);
  return new CdpConnection(socket);
}

class CdpConnection {
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
      message = JSON.parse(data);
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
    this.socket.close();
    this.onClose();
  }
}

function attachDiagnostics(cdp, log) {
  const push = (kind, text) => {
    if (typeof text !== "string" || text.length === 0) {
      return;
    }
    log.push(`${kind}: ${text}`.slice(0, 500));
    if (log.length > 50) {
      log.shift();
    }
  };
  cdp.onEvent((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params?.exceptionDetails;
      push(
        "exception",
        details?.exception?.description ?? details?.text ?? "unknown exception",
      );
    } else if (message.method === "Runtime.consoleAPICalled") {
      if (message.params?.type !== "error") {
        return;
      }
      const args = Array.isArray(message.params.args)
        ? message.params.args
        : [];
      push(
        "console.error",
        args
          .map((arg) => {
            if (arg === null || typeof arg !== "object") {
              return String(arg);
            }
            if (typeof arg.value === "string") return arg.value;
            if (arg.value !== undefined) return JSON.stringify(arg.value);
            return typeof arg.description === "string"
              ? arg.description
              : (arg.type ?? "value");
          })
          .join(" "),
      );
    } else if (message.method === "Log.entryAdded") {
      const entry = message.params?.entry;
      if (entry && entry.level === "error") {
        push(
          "log.error",
          `${entry.source ?? "log"}: ${entry.url ? `${entry.url} ` : ""}${entry.text ?? ""}`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Page probes
// ---------------------------------------------------------------------------

const SNAPSHOT_EXPRESSION = `(() => {
  const b = window.__BAKEOFF__;
  if (!b || typeof b !== "object") return null;
  const summarize = (values) => {
    if (!Array.isArray(values)) return null;
    const clean = values.filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (clean.length === 0) return { count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, meanMs: null };
    clean.sort((a, c) => a - c);
    const nearest = (p) => clean[Math.min(clean.length - 1, Math.max(0, Math.ceil(p * clean.length) - 1))];
    let sum = 0;
    for (const value of clean) sum += value;
    const round = (value) => Math.round(value * 1000) / 1000;
    return {
      count: clean.length,
      p50Ms: round(nearest(0.5)),
      p95Ms: round(nearest(0.95)),
      p99Ms: round(nearest(0.99)),
      maxMs: round(clean[clean.length - 1]),
      meanMs: round(sum / clean.length)
    };
  };
  const errors = Array.isArray(b.errors)
    ? b.errors.slice(0, 50).map((entry) => {
        if (typeof entry === "string") return entry;
        try { return JSON.stringify(entry); } catch { return String(entry); }
      })
    : [];
  const known = new Set(["ready", "backend", "frameTimesMs", "drawCalls", "triangles", "instances", "firstFrameMs", "activations", "deactivations", "errors"]);
  return {
    ready: b.ready === true,
    backend: typeof b.backend === "string" ? b.backend : "unknown",
    backendValid: b.backend === "webgpu" || b.backend === "webgl2" || b.backend === "unknown",
    drawCalls: Number.isFinite(b.drawCalls) ? b.drawCalls : null,
    triangles: Number.isFinite(b.triangles) ? b.triangles : null,
    instances: Number.isFinite(b.instances) ? b.instances : null,
    firstFrameMs: Number.isFinite(b.firstFrameMs) ? b.firstFrameMs : null,
    activations: Number.isFinite(b.activations) ? b.activations : null,
    deactivations: Number.isFinite(b.deactivations) ? b.deactivations : null,
    errors,
    pageFrames: summarize(b.frameTimesMs),
    extraKeys: Object.keys(b).filter((key) => !known.has(key)),
    visibilityState: document.visibilityState
  };
})()`;

const GPU_EXPRESSION = `(() => {
  const make = (kind) => {
    try { return document.createElement("canvas").getContext(kind); }
    catch { return null; }
  };
  const gl2 = make("webgl2");
  const gl = gl2 || make("webgl");
  const ext = gl ? gl.getExtension("WEBGL_debug_renderer_info") : null;
  return {
    userAgent: navigator.userAgent,
    webgpu: typeof navigator.gpu !== "undefined",
    webgl2: Boolean(gl2),
    webglRenderer: gl
      ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      : null,
    webglVendor: gl
      ? (ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR))
      : null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb: navigator.deviceMemory ?? null,
    crossOriginIsolated: self.crossOriginIsolated === true,
    visibilityState: document.visibilityState
  };
})()`;

function evaluate(cdp, expression) {
  return cdp
    .send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    })
    .then((result) => result.result ?? null);
}

async function waitForReady(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await evaluate(
      cdp,
      "Boolean(window.__BAKEOFF__ && window.__BAKEOFF__.ready === true)",
    ).catch(() => null);
    if (result && result.value === true) {
      return true;
    }
    await delay(250);
  }
  return false;
}

function summarizeFrames(values) {
  const clean = values.filter(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  if (clean.length === 0) {
    return {
      count: 0,
      wallMs: null,
      observedFps: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
      meanMs: null,
      frameTimesMs: [],
    };
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const nearest = (p) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  let sum = 0;
  for (const value of clean) {
    sum += value;
  }
  return {
    count: clean.length,
    wallMs: round3(sum),
    observedFps: sum > 0 ? round3(clean.length / (sum / 1000)) : null,
    p50Ms: round3(nearest(0.5)),
    p95Ms: round3(nearest(0.95)),
    p99Ms: round3(nearest(0.99)),
    maxMs: round3(sorted[sorted.length - 1]),
    meanMs: round3(sum / clean.length),
    frameTimesMs: clean.map((value) => round2(value)),
  };
}

async function captureScreenshot(cdp, contenderId, runNumber, options) {
  try {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    if (typeof data !== "string" || data.length === 0) {
      return null;
    }
    const directory = path.join(path.dirname(options.out), "screenshots");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${contenderId}-run${runNumber}.png`);
    await writeFile(file, Buffer.from(data, "base64"));
    return path
      .relative(path.dirname(options.out), file)
      .split(path.sep)
      .join("/");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Source accounting and cold boot gzip
// ---------------------------------------------------------------------------

async function walkFiles(directory, skipDirs) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) {
        continue;
      }
      files.push(...(await walkFiles(entryPath, skipDirs)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function countSourceLines(directory) {
  const files = await walkFiles(directory, SOURCE_SKIP_DIRS);
  const records = [];
  let totalLines = 0;
  let nonBlankLines = 0;
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      continue;
    }
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const nonBlank = lines.filter((line) => line.trim().length > 0).length;
    totalLines += lines.length;
    nonBlankLines += nonBlank;
    records.push({
      path: path.relative(directory, file).split(path.sep).join("/"),
      lines: lines.length,
      nonBlank,
    });
  }
  records.sort((a, b) => a.path.localeCompare(b.path));
  return { totalLines, nonBlankLines, files: records };
}

async function computeColdBootGzip(contenderDir) {
  for (const build of BUILD_DIRS) {
    const buildDir = path.join(contenderDir, build);
    if (!existsSync(path.join(buildDir, "index.html"))) {
      continue;
    }
    const files = await walkFiles(buildDir, new Set());
    const records = [];
    let totalGzipBytes = 0;
    let codeGzipBytes = 0;
    for (const file of files) {
      if (file.endsWith(".map")) {
        continue;
      }
      let bytes;
      try {
        bytes = await readFile(file);
      } catch {
        continue;
      }
      const gzipBytes = gzipSync(bytes, { level: 9 }).length;
      const relative = path
        .relative(contenderDir, file)
        .split(path.sep)
        .join("/");
      records.push({ path: relative, bytes: bytes.length, gzipBytes });
      totalGzipBytes += gzipBytes;
      if (CODE_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        codeGzipBytes += gzipBytes;
      }
    }
    records.sort((a, b) => a.path.localeCompare(b.path));
    return {
      status: "measured",
      buildDir: path.relative(REPO_ROOT, buildDir).split(path.sep).join("/"),
      method:
        "zlib gzipSync level 9, per file, summed; source maps excluded; not a single concatenated stream",
      totalGzipBytes,
      codeGzipBytes,
      fileCount: records.length,
      files: records,
    };
  }
  return {
    status: "PENDING",
    reason: `no production build found (expected ${path
      .relative(REPO_ROOT, contenderDir)
      .split(path.sep)
      .join("/")}/dist/index.html)`,
  };
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

function emptyRun(runNumber) {
  return {
    run: runNumber,
    status: "error",
    reason: null,
    backend: null,
    chromeVersion: null,
    gpu: null,
    readyAfterMs: null,
    measuredWallMs: null,
    firstFrameMs: null,
    frames: null,
    pageFrames: null,
    drawCalls: null,
    triangles: null,
    instances: null,
    activations: null,
    deactivations: null,
    pageErrors: [],
    runnerErrors: [],
    heapSamples: [],
    screenshot: null,
    startedAt: null,
    finishedAt: null,
  };
}

async function runOnce(contender, pageInfo, runNumber, options, serverBase) {
  const run = emptyRun(runNumber);
  run.startedAt = new Date().toISOString();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "pocketpad-bakeoff-"));
  let child = null;
  let cdp = null;
  let chromeState = { stderr: "" };
  try {
    const chromePath = options.chromePath ?? resolveChrome(null);
    const launched = await launchChrome(chromePath, profileDir, options);
    child = launched.child;
    chromeState = launched.state;
    const port = await waitForDevToolsPort(profileDir, child, chromeState, 30000);
    const version = await fetchJson(
      `http://127.0.0.1:${port}/json/version`,
    ).catch(() => null);
    run.chromeVersion = version?.Browser ?? null;
    const targets = await fetchJson(
      `http://127.0.0.1:${port}/json/list`,
    ).catch(() => null);
    const target = Array.isArray(targets)
      ? targets.find(
          (entry) =>
            entry &&
            entry.type === "page" &&
            typeof entry.webSocketDebuggerUrl === "string",
        )
      : null;
    if (!target) {
      throw new Error(
        "Chrome did not expose a page target to the DevTools protocol",
      );
    }
    cdp = await connectCdp(target.webSocketDebuggerUrl, 10000);
    attachDiagnostics(cdp, run.runnerErrors);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: options.viewport.width,
      height: options.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const navigatedAt = Date.now();
    await cdp.send("Page.navigate", { url: `${serverBase}${pageInfo.url}` });
    const ready = await waitForReady(cdp, options.readyTimeoutSeconds * 1000);
    run.readyAfterMs = Date.now() - navigatedAt;
    const gpuResult = await evaluate(cdp, GPU_EXPRESSION).catch(() => null);
    run.gpu = gpuResult?.value ?? null;
    if (!ready) {
      const snapshot = await evaluate(cdp, SNAPSHOT_EXPRESSION).catch(() => null);
      if (snapshot?.value) {
        run.backend = snapshot.value.backend;
        run.pageErrors = snapshot.value.errors ?? [];
      }
      run.reason = `window.__BAKEOFF__.ready stayed false for ${options.readyTimeoutSeconds} s`;
      run.screenshot = await captureScreenshot(
        cdp,
        contender.id,
        runNumber,
        options,
      );
      if (chromeState.stderr.trim().length > 0) {
        run.runnerErrors.push(`chrome stderr: ${chromeState.stderr.trim()}`);
      }
      return run;
    }

    await delay(options.warmupSeconds * 1000);
    await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const durationMs = ${Math.round(options.measuredSeconds * 1000)};
        const state = { done: false, frames: [], startedAt: performance.now(), endedAt: 0 };
        window.__BAKEOFF_RUNNER__ = state;
        let last = 0;
        function tick(now) {
          if (last !== 0) state.frames.push(now - last);
          last = now;
          if (now - state.startedAt >= durationMs) {
            state.done = true;
            state.endedAt = now;
            return;
          }
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
        return true;
      })()`,
      returnByValue: true,
    });

    const sampleStart = Date.now();
    let samplerDone = false;
    const samplerDeadline =
      sampleStart + (options.measuredSeconds * 2 + 15) * 1000;
    while (Date.now() < samplerDeadline) {
      await delay(1000);
      const heap = await cdp.send("Runtime.getHeapUsage").catch(() => null);
      if (heap && Number.isFinite(heap.usedSize)) {
        run.heapSamples.push({
          atMs: Date.now() - sampleStart,
          usedBytes: Math.round(heap.usedSize),
          totalBytes: Math.round(heap.totalSize ?? 0),
        });
      }
      const state = await evaluate(
        cdp,
        "Boolean(window.__BAKEOFF_RUNNER__ && window.__BAKEOFF_RUNNER__.done)",
      ).catch(() => null);
      if (state?.value === true) {
        samplerDone = true;
        break;
      }
    }
    run.measuredWallMs = Date.now() - sampleStart;
    const framesResult = await evaluate(
      cdp,
      "(window.__BAKEOFF_RUNNER__ && window.__BAKEOFF_RUNNER__.frames) || []",
    ).catch(() => null);
    const rawFrames = Array.isArray(framesResult?.value)
      ? framesResult.value
      : [];
    run.frames = summarizeFrames(rawFrames);
    if (!samplerDone) {
      run.runnerErrors.push(
        `sampler did not finish within ${options.measuredSeconds * 2 + 15} s`,
      );
    }

    const snapshot = await evaluate(cdp, SNAPSHOT_EXPRESSION).catch(() => null);
    if (snapshot?.value) {
      const value = snapshot.value;
      run.backend = value.backend;
      run.firstFrameMs = value.firstFrameMs;
      run.drawCalls = value.drawCalls;
      run.triangles = value.triangles;
      run.instances = value.instances;
      run.activations = value.activations;
      run.deactivations = value.deactivations;
      run.pageErrors = value.errors ?? [];
      run.pageFrames = value.pageFrames;
      if (value.backendValid === false) {
        run.runnerErrors.push(
          `page reported an invalid backend: ${JSON.stringify(value.backend)}`,
        );
      }
      if (Array.isArray(value.extraKeys) && value.extraKeys.length > 0) {
        run.runnerErrors.push(
          `page set non-contract __BAKEOFF__ keys: ${value.extraKeys.join(", ")}`,
        );
      }
    } else {
      run.runnerErrors.push(
        "window.__BAKEOFF__ disappeared before the final snapshot",
      );
    }

    run.screenshot = await captureScreenshot(
      cdp,
      contender.id,
      runNumber,
      options,
    );
    if (run.frames && run.frames.count > 0) {
      run.status = "measured";
    } else {
      run.status = "error";
      run.reason = "the rAF sampler captured no frame intervals";
    }
    return run;
  } catch (error) {
    run.status = "error";
    run.reason = errorText(error);
    return run;
  } finally {
    run.finishedAt = new Date().toISOString();
    if (cdp) {
      cdp.close();
    }
    await terminateChrome(child);
    if (!options.keepProfiles) {
      await rm(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 250,
      }).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Contender orchestration
// ---------------------------------------------------------------------------

async function findPage(contender) {
  const contenderDir = path.join(REPO_ROOT, contender.dir);
  const candidates = [
    ...BUILD_DIRS.map((build) => path.join(build, "index.html")),
    "index.html",
  ];
  for (const relative of candidates) {
    const file = path.join(contenderDir, relative);
    if (existsSync(file)) {
      return {
        source: `${contender.dir.split(path.sep).join("/")}/${relative
          .split(path.sep)
          .join("/")}`,
        url: `/${contender.dir.split(path.sep).join("/")}/`,
      };
    }
  }
  return null;
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return round3(sorted[middle]);
  }
  return round3((sorted[middle - 1] + sorted[middle]) / 2);
}

function aggregateRuns(runs) {
  const measured = runs.filter(
    (run) =>
      run.status === "measured" &&
      run.frames &&
      typeof run.frames.p95Ms === "number",
  );
  if (measured.length === 0) {
    return null;
  }
  const p95 = measured.map((run) => run.frames.p95Ms);
  const p50 = measured.map((run) => run.frames.p50Ms);
  return {
    measuredRuns: measured.length,
    p50Ms: { min: Math.min(...p50), median: median(p50), max: Math.max(...p50) },
    p95Ms: { min: Math.min(...p95), median: median(p95), max: Math.max(...p95) },
    maxFrameMs: Math.max(...measured.map((run) => run.frames.maxMs)),
    observedFps: median(
      measured
        .map((run) => run.frames.observedFps)
        .filter((value) => typeof value === "number"),
    ),
  };
}

async function runContender(contender, options, serverBase, setActive) {
  setActive(contender.id);
  const contenderDir = path.join(REPO_ROOT, contender.dir);
  const record = {
    id: contender.id,
    label: contender.label,
    internal: contender.internal === true,
    dir: contender.dir,
    page: null,
    status: "not-run",
    reason: null,
    sourceLines: await countSourceLines(contenderDir).catch(() => null),
    coldBootGzip: await computeColdBootGzip(contenderDir).catch((error) => ({
      status: "PENDING",
      reason: errorText(error),
    })),
    runs: [],
    aggregate: null,
  };
  const pageInfo = await findPage(contender);
  if (!pageInfo) {
    record.reason = `no page at ${contender.dir}/dist/index.html, ${contender.dir}/build/index.html, ${contender.dir}/www/index.html or ${contender.dir}/index.html`;
    return record;
  }
  record.page = {
    url: pageInfo.url,
    source: pageInfo.source,
  };
  for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
    process.stdout.write(
      `  ${contender.id} run ${runNumber}/${options.runs} ...\n`,
    );
    const run = await runOnce(
      contender,
      pageInfo,
      runNumber,
      options,
      serverBase,
    );
    record.runs.push(run);
    process.stdout.write(
      `  ${contender.id} run ${runNumber}: ${run.status}` +
        (run.frames?.p95Ms !== undefined && run.frames?.p95Ms !== null
          ? ` p95 ${run.frames.p95Ms} ms, p50 ${run.frames.p50Ms} ms, ${run.frames.count} frames`
          : "") +
        (run.reason ? ` (${run.reason})` : "") +
        "\n",
    );
  }
  const measured = record.runs.filter((run) => run.status === "measured");
  record.status =
    measured.length === record.runs.length
      ? "measured"
      : measured.length === 0
        ? "error"
        : "partial";
  record.aggregate = aggregateRuns(record.runs);
  return record;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "n/a";
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB gz`;
}

function printSummary(contenders) {
  process.stdout.write("\nSummary\n");
  for (const contender of contenders) {
    if (contender.status === "not-run") {
      process.stdout.write(
        `  ${contender.id.padEnd(12)} not-run     ${contender.reason}\n`,
      );
      continue;
    }
    const p95 = contender.aggregate?.p95Ms;
    const boot =
      contender.coldBootGzip?.status === "measured"
        ? formatBytes(contender.coldBootGzip.totalGzipBytes)
        : "boot PENDING";
    process.stdout.write(
      `  ${contender.id.padEnd(12)} ${contender.status.padEnd(10)} ` +
        `${contender.runs.filter((run) => run.status === "measured").length}/${contender.runs.length} runs  ` +
        `p95 ${p95 ? `${p95.min}/${p95.median}/${p95.max} ms` : "n/a"}  ${boot}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  const selected = CONTENDERS.filter((contender) =>
    options.only
      ? options.only.includes(contender.id)
      : contender.internal !== true,
  );
  if (selected.length === 0) {
    throw new Error("no contenders selected");
  }
  const { server, port, setActive } = await startServer(options.port);
  const serverBase = `http://127.0.0.1:${port}`;
  process.stdout.write(`Serving ${REPO_ROOT}\n  base ${serverBase}\n`);

  if (options.serveOnly) {
    const pageLines = await Promise.all(
      CONTENDERS.map(async (contender) => {
        const page = await findPage(contender);
        return page
          ? `  ${contender.id.padEnd(12)}  ${serverBase}${page.url}  (${page.source})`
          : `  ${contender.id.padEnd(12)}  no page`;
      }),
    );
    process.stdout.write(
      [
        `  results page  ${serverBase}/experiments/bakeoff/runner/index.html`,
        `  assets        ${serverBase}/experiments/bakeoff/assets/layout.json`,
        ...pageLines,
        "Press Ctrl+C to stop.",
        "",
      ].join("\n"),
    );
    return null;
  }

  const chromePath = resolveChrome(options.chromePath);
  options.chromePath = chromePath;
  process.stdout.write(
    `  chrome ${chromePath}\n  ${options.runs} run(s) per contender, ${options.warmupSeconds} s warm-up, ${options.measuredSeconds} s sampled, ${options.viewport.width}x${options.viewport.height} DPR 1\n\n`,
  );

  const contenderRecords = [];
  for (const contender of selected) {
    process.stdout.write(`${contender.label}\n`);
    contenderRecords.push(
      await runContender(contender, options, serverBase, setActive),
    );
  }

  const results = {
    schema: "pocketpad-bakeoff-results/v1",
    generatedAt: new Date().toISOString(),
    protocol: {
      viewport: options.viewport,
      deviceScaleFactor: 1,
      warmupSeconds: options.warmupSeconds,
      measuredSeconds: options.measuredSeconds,
      readyTimeoutSeconds: options.readyTimeoutSeconds,
      runsPerContender: options.runs,
      frameSource:
        "independent requestAnimationFrame probe injected by the runner after warm-up",
      framePacing: options.capped ? "display-paced" : "uncapped",
      percentileMethod: "nearest-rank over sampled frame intervals",
      heapSource: "Runtime.getHeapUsage once per second",
      coldBootMethod:
        "zlib gzip level 9, per file, summed over the production build; source maps excluded",
      pageUrlPattern: "/experiments/bakeoff/<contender>/",
      notes: [
        "Frame intervals are compositor requestAnimationFrame deltas, not GPU timestamp queries.",
        "By default the runner launches Chrome with --disable-frame-rate-limit and --disable-gpu-vsync, so each interval is render work rather than the display cadence. A display-paced run (--capped) on this machine has an 8.33 ms floor at 119 Hz and hides sub-floor differences between engines.",
        "Page-reported frameTimesMs is recorded separately and is not merged with the runner series.",
        "No software-renderer numbers: the WebGL renderer string is recorded per run and must be checked against SwiftShader.",
        "Shared assets are real CC0 models: ped.glb has a 65-joint skin and an in-place walk clip, car.glb has an embedded Kenney colormap. A contender that cannot parse skins/animations is measured as-is; the assets are not simplified to hide it.",
      ],
    },
    environment: {
      node: process.version,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? null,
      cpuCount: os.cpus().length,
      memoryBytes: os.totalmem(),
      chromePath,
    },
    contenders: contenderRecords,
  };

  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(
    options.out,
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8",
  );

  printSummary(contenderRecords);
  process.stdout.write(`\nResults written to ${options.out}\n`);
  process.stdout.write(
    `Open ${serverBase}/experiments/bakeoff/runner/index.html while --serve-only is running, or serve the folder yourself.\n`,
  );

  const hasError = contenderRecords.some(
    (contender) => contender.status === "error" || contender.status === "partial",
  );
  server.close();
  return hasError ? 1 : 0;
}

main()
  .then((code) => {
    if (code !== null) {
      process.exitCode = code;
    }
  })
  .catch((error) => {
    process.stderr.write(`runner failed: ${error.stack ?? error}\n`);
    process.exitCode = 1;
  });

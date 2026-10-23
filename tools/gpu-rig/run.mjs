#!/usr/bin/env node
/**
 * PocketPad GPU rig runner.
 *
 * Launches headless Chrome with a throwaway profile, opens the rig page over a
 * loopback static server, waits (by polling, never a fixed sleep) for
 * window.__GPU_RIG__, and compares the FNV-1a hash with golden.json.
 *
 * Exit 0 only when a hash was produced and matched, or was recorded with
 * --update-golden. Every other outcome exits 1 and prints JSON with `error`.
 * A missing golden is a failure, not a pass.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const RIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(RIG_DIR, "golden.json");
const SCENE = "lit-triangle-v1";
const WIDTH = 256;
const HEIGHT = 256;
const DEFAULT_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;
const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
]);

const USAGE = `PocketPad GPU rig

Usage: node tools/gpu-rig/run.mjs [options]

Options:
  --backend auto|webgpu|webgl2  Backend to exercise (default: auto)
  --chrome <path>               Chrome/Chromium binary (default: CHROME_PATH or common paths)
  --timeout <ms>                Startup plus readback budget (default: 30000)
  --out <json>                  Also write the result JSON to this file
  --update-golden               Record this run's hash in golden.json
  --help                        Show this text

Exit code 0 means a hash was produced and matched golden.json, or was recorded
with --update-golden. A missing golden.json is a failure, not a pass.`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error) {
  if (error instanceof Error) {
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

function parseOptions(argv) {
  const options = {
    backend: "auto",
    chrome: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    out: null,
    updateGolden: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      options.help = true;
      continue;
    }
    if (flag === "--update-golden") {
      options.updateGolden = true;
      continue;
    }
    if (flag === "--backend") {
      options.backend = readOptionValue(argv, index + 1, flag);
      index += 1;
      continue;
    }
    if (flag === "--chrome") {
      options.chrome = readOptionValue(argv, index + 1, flag);
      index += 1;
      continue;
    }
    if (flag === "--timeout") {
      options.timeoutMs = readOptionValue(argv, index + 1, flag);
      index += 1;
      continue;
    }
    if (flag === "--out") {
      options.out = readOptionValue(argv, index + 1, flag);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${flag}`);
  }
  if (!["auto", "webgpu", "webgl2"].includes(options.backend)) {
    throw new Error(
      `--backend must be auto, webgpu or webgl2 (got ${options.backend})`,
    );
  }
  const timeoutMs = Number(options.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `--timeout must be a positive number of milliseconds (got ${options.timeoutMs})`,
    );
  }
  options.timeoutMs = Math.floor(timeoutMs);
  return options;
}

function commonChromeCandidates() {
  if (process.platform === "win32") {
    const bases = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA,
    ].filter((base) => typeof base === "string" && base.length > 0);
    const candidates = [];
    for (const base of bases) {
      candidates.push(
        path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
      );
      candidates.push(
        path.join(base, "Chromium", "Application", "chrome.exe"),
      );
    }
    return candidates;
  }
  if (process.platform === "darwin") {
    const home = os.homedir();
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.join(
        home,
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
      path.join(home, "Applications/Chromium.app/Contents/MacOS/Chromium"),
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/opt/google/chrome/chrome",
  ];
}

function resolveChrome(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`--chrome path does not exist: ${explicitPath}`);
    }
    return explicitPath;
  }
  const fromEnvironment = process.env.CHROME_PATH;
  if (fromEnvironment) {
    if (!existsSync(fromEnvironment)) {
      throw new Error(`CHROME_PATH does not exist: ${fromEnvironment}`);
    }
    return fromEnvironment;
  }
  const candidates = commonChromeCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `no Chrome/Chromium binary found. Tried:\n${candidates
      .map((candidate) => `  - ${candidate}`)
      .join("\n")}\nInstall Chrome or pass --chrome <path> / set CHROME_PATH.`,
  );
}

function contentTypeFor(filePath) {
  return (
    CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ??
    "application/octet-stream"
  );
}

async function startStaticServer() {
  const server = createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("method not allowed");
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const relative =
        url.pathname === "/"
          ? "index.html"
          : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const filePath = path.resolve(RIG_DIR, relative);
      if (filePath !== RIG_DIR && !filePath.startsWith(RIG_DIR + path.sep)) {
        response.writeHead(403, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("forbidden");
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentTypeFor(filePath),
        "Content-Security-Policy": "script-src 'self'; style-src 'self'",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch (error) {
      const status = error && error.code === "ENOENT" ? 404 : 500;
      response.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
      });
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
  return new Promise((resolve) => {
    handle.server.close(() => resolve());
    if (typeof handle.server.closeAllConnections === "function") {
      handle.server.closeAllConnections();
    }
  });
}

async function launchChrome(chromePath, profileDir) {
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
    "--enable-unsafe-webgpu",
    "--window-size=512,512",
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
    // The version is diagnostics only; never fail a run over it.
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
        reject(
          new Error(`timed out opening CDP WebSocket after ${timeoutMs} ms`),
        );
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
    this.closed = false;
    this.closeError = null;
    socket.on("message", (data) => this.onMessage(data));
    socket.on("close", () => this.onClose());
    socket.on("error", (error) => this.onClose(error));
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : data.toString());
    } catch {
      // Ignore frames that are not JSON; CDP responses always are.
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

async function waitForRig(cdp, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    if (cdp.closed) {
      const reason = cdp.closeError ? ` (${errorText(cdp.closeError)})` : "";
      throw new Error(
        `CDP connection closed before window.__GPU_RIG__ was set${reason}`,
      );
    }
    try {
      const response = await cdp.send("Runtime.evaluate", {
        expression:
          "({ done: window.__GPU_RIG_DONE__ === true || window.__GPU_RIG__ != null, rig: window.__GPU_RIG__ ?? null })",
        returnByValue: true,
      });
      if (!response.exceptionDetails) {
        const value = response.result ? response.result.value : null;
        if (value && value.done && value.rig) {
          return value.rig;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  }
  const suffix = lastError ? ` Last CDP error: ${errorText(lastError)}` : "";
  throw new Error(`timed out waiting for window.__GPU_RIG__${suffix}`);
}

async function navigateAndRead(cdp, url, deadline) {
  await cdp.send("Page.enable");
  const navigation = await cdp.send("Page.navigate", { url });
  if (navigation.errorText) {
    throw new Error(`could not open ${url}: ${navigation.errorText}`);
  }
  return waitForRig(cdp, deadline);
}

function adapterLabel(rig) {
  const info = rig.backendInfo;
  if (!info || typeof info !== "object") {
    return null;
  }
  const label =
    info.description || info.renderer || info.device || info.vendor || null;
  return typeof label === "string" && label.length > 0 ? label : null;
}

function validateRig(rig, requestedBackend) {
  if (typeof rig.backend !== "string" || rig.backend.length === 0) {
    throw new Error("rig did not report a backend");
  }
  if (requestedBackend !== "auto" && rig.backend !== requestedBackend) {
    throw new Error(
      `requested backend ${requestedBackend} but the page used ${rig.backend}`,
    );
  }
  if (typeof rig.error === "string" && rig.error.length > 0) {
    throw new Error(`rig reported error: ${rig.error}`);
  }
  if (typeof rig.hash !== "string" || !/^[0-9a-f]{8}$/.test(rig.hash)) {
    throw new Error(
      `rig hash is not an FNV-1a 32-bit hex string: ${JSON.stringify(rig.hash)}`,
    );
  }
  if (rig.width !== WIDTH || rig.height !== HEIGHT) {
    throw new Error(
      `rig size mismatch: ${rig.width}x${rig.height}, expected ${WIDTH}x${HEIGHT}`,
    );
  }
  if (typeof rig.drawCalls !== "number") {
    throw new Error("rig did not report drawCalls");
  }
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

function compareGolden(golden, backend, hash) {
  if (!golden) {
    return {
      status: "missing",
      expectedHash: null,
      detail: `no golden.json at ${GOLDEN_PATH}; run with --update-golden after checking the rendered output`,
    };
  }
  if (
    golden.scene !== SCENE ||
    golden.width !== WIDTH ||
    golden.height !== HEIGHT
  ) {
    return {
      status: "stale",
      expectedHash: null,
      detail: `golden.json describes ${JSON.stringify(golden.scene)} at ${golden.width}x${golden.height}, expected ${SCENE} at ${WIDTH}x${HEIGHT}`,
    };
  }
  const entry =
    golden.backends && typeof golden.backends === "object"
      ? golden.backends[backend]
      : null;
  if (!entry || typeof entry.hash !== "string") {
    return {
      status: "missing-backend",
      expectedHash: null,
      detail: `golden.json has no hash for backend ${backend}; record one with --backend ${backend} --update-golden`,
    };
  }
  if (entry.hash === hash) {
    return { status: "matched", expectedHash: entry.hash, detail: null };
  }
  return {
    status: "mismatch",
    expectedHash: entry.hash,
    detail: `hash ${hash} does not match golden ${entry.hash} for backend ${backend}`,
  };
}

async function writeGolden(existing, rig, chromeVersion) {
  const backends =
    existing && existing.backends && typeof existing.backends === "object"
      ? { ...existing.backends }
      : {};
  backends[rig.backend] = {
    hash: rig.hash,
    adapter: adapterLabel(rig),
    chrome: chromeVersion,
    drawCalls: rig.drawCalls,
    recordedAt: new Date().toISOString(),
  };
  const golden = {
    version: 1,
    scene: SCENE,
    width: WIDTH,
    height: HEIGHT,
    backends,
  };
  await writeFile(GOLDEN_PATH, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
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
    child.kill("SIGKILL");
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
    // A locked profile in the OS temp directory is not worth failing over.
  }
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`gpu-rig: ${errorText(error)}\n\n${USAGE}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const startedAt = Date.now();
  let chromePath = null;
  let chromeVersion = null;
  let rig = null;
  let failure = null;
  let goldenStatus = "skipped";
  let expectedHash = null;
  let updatedGolden = false;

  let profileDir = null;
  let staticServer = null;
  let chromeHandle = null;
  let cdp = null;

  try {
    chromePath = resolveChrome(options.chrome);
    profileDir = await mkdtemp(path.join(os.tmpdir(), "lanpad-gpu-rig-"));
    staticServer = await startStaticServer();
    chromeHandle = await launchChrome(chromePath, profileDir);
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
    const page = await waitForPageTarget(
      port,
      Math.min(deadline, Date.now() + STARTUP_TIMEOUT_MS),
      chromeHandle.child,
      chromeHandle.state,
    );
    cdp = await CdpConnection.open(
      page.webSocketDebuggerUrl,
      Math.max(1000, deadline - Date.now()),
    );
    const rigUrl = `${staticServer.origin}/index.html?backend=${encodeURIComponent(options.backend)}`;
    rig = await navigateAndRead(cdp, rigUrl, deadline);
    validateRig(rig, options.backend);

    if (options.updateGolden) {
      await writeGolden(await readGolden(), rig, chromeVersion);
      updatedGolden = true;
      goldenStatus = "updated";
      expectedHash = rig.hash;
    } else {
      const comparison = compareGolden(
        await readGolden(),
        rig.backend,
        rig.hash,
      );
      expectedHash = comparison.expectedHash;
      goldenStatus = comparison.status;
      if (comparison.status !== "matched") {
        throw new Error(comparison.detail);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (cdp) {
      cdp.close();
    }
    await stopChrome(chromeHandle);
    if (staticServer) {
      await closeStaticServer(staticServer);
    }
    if (profileDir) {
      await removeProfile(profileDir);
    }
  }

  const result = {
    ok: failure === null,
    scene: SCENE,
    requestedBackend: options.backend,
    backend: rig ? rig.backend : null,
    hash: rig ? rig.hash : null,
    expectedHash,
    goldenStatus,
    goldenPath: GOLDEN_PATH,
    updatedGolden,
    drawCalls: rig ? rig.drawCalls : null,
    width: rig ? rig.width : null,
    height: rig ? rig.height : null,
    stable: rig ? rig.stable === true : null,
    fallbackReason: rig ? (rig.fallbackReason ?? null) : null,
    adapter: rig ? adapterLabel(rig) : null,
    chrome: chromePath,
    chromeVersion,
    durationMs: Date.now() - startedAt,
    error: failure ? errorText(failure) : null,
  };

  let exitCode = failure === null ? 0 : 1;
  if (options.out) {
    try {
      await writeFile(
        path.resolve(options.out),
        `${JSON.stringify(result, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      result.ok = false;
      result.error = `could not write --out ${options.out}: ${errorText(error)}`;
      exitCode = 1;
    }
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (exitCode !== 0) {
    process.stderr.write(`gpu-rig: ${result.error}\n`);
  }
  return exitCode;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    const detail =
      error instanceof Error && error.stack ? error.stack : errorText(error);
    process.stderr.write(`gpu-rig: unexpected failure: ${detail}\n`);
    process.exitCode = 1;
  });

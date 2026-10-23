#!/usr/bin/env node
/**
 * GameWorld3D browser evidence runner (spec 22, stream A).
 *
 * Starts the experiment's Vite dev server, drives headless Chrome over CDP,
 * loads the page on WebGPU and on forced WebGL2, waits for the world + clip to
 * be ready, samples real rAF intervals, and captures a screenshot for each
 * backend. Numbers in results.json are read from the page, never synthesised.
 *
 *   node experiments/babylon-world/run-world.mjs
 *
 * Chrome is discovered as in experiments/babylon-host/run-host.mjs; override
 * with CHROME_PATH. The Vite port defaults to 5199 (POCKETPAD_WORLD_PORT).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const RUN_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(RUN_DIR, "../..");
const PORT = Number(process.env.POCKETPAD_WORLD_PORT ?? 5199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 720 };
const WARMUP_MS = 1200;
const SAMPLE_MS = Number(process.env.POCKETPAD_WORLD_SAMPLE_MS ?? 2000);
const READY_TIMEOUT_MS = 90000;
const CDP_TIMEOUT_MS = 20000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.platform === "win32") {
    for (const root of [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ]) {
      if (!root) continue;
      candidates.push(
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      );
      candidates.push(
        path.join(root, "Chromium", "Application", "chrome.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
    );
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error("no Chrome/Chromium binary found; set CHROME_PATH");
}

async function launchChrome(profileDir) {
  const child = spawn(
    resolveChrome(),
    [
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
      "--autoplay-policy=no-user-gesture-required",
      "--disable-frame-rate-limit",
      "--disable-gpu-vsync",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return { child, getStderr: () => stderr };
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.kill();
  } catch {
    // taskkill below
  }
  const finished = await Promise.race([exited.then(() => true), delay(3000)]);
  if (!finished && child.exitCode === null && process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await Promise.race([exited, delay(3000)]);
  }
}

async function startVite() {
  const viteBin = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) throw new Error(`vite not found at ${viteBin}`);
  const child = spawn(
    process.execPath,
    [
      viteBin,
      "--config",
      path.join(RUN_DIR, "vite.config.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(PORT),
      "--strictPort",
    ],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let log = "";
  const append = (chunk) => {
    log = (log + chunk).slice(-8192);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited early (${child.exitCode}).\n${log}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/`);
      if (response.ok) return { child, getLog: () => log };
    } catch {
      // not listening yet
    }
    await delay(150);
  }
  await terminate(child);
  throw new Error(`Vite did not start on ${BASE_URL}.\n${log}`);
}

async function waitForPort(profileDir, launched, timeoutMs = 30000) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launched.child.exitCode !== null) {
      throw new Error(`Chrome exited early.\n${launched.getStderr()}`);
    }
    try {
      const port = Number.parseInt(
        (await readFile(file, "utf8")).split(/\r?\n/)[0],
        10,
      );
      if (Number.isInteger(port) && port > 0) return port;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(100);
  }
  throw new Error(`Chrome DevTools port timeout.\n${launched.getStderr()}`);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Set();
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (message.id === undefined) {
        for (const handler of this.events) handler(message);
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      } else {
        entry.resolve(message.result ?? {});
      }
    });
  }

  onEvent(handler) {
    this.events.add(handler);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${CDP_TIMEOUT_MS} ms`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        method,
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("CDP socket timeout")), 10000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(new Cdp(socket));
    });
    socket.once("error", reject);
  });
}

async function pageTarget(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((target) => target.type === "page");
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await delay(100);
  }
  throw new Error("no page target appeared");
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "page evaluation failed",
    );
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(cdp, expression)) return;
    } catch {
      // Page may be mid-navigation.
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function sampleFrames(cdp, durationMs) {
  await evaluate(
    cdp,
    `(() => {
      window.__WORLD_RUN__ = { samples: [], stop: false };
      let last = performance.now();
      const tick = (now) => {
        window.__WORLD_RUN__.samples.push(now - last);
        last = now;
        if (!window.__WORLD_RUN__.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    })()`,
  );
  await delay(durationMs);
  return evaluate(
    cdp,
    `(() => {
      window.__WORLD_RUN__.stop = true;
      const clean = window.__WORLD_RUN__.samples.filter(
        (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
      );
      clean.sort((a, b) => a - b);
      if (clean.length === 0) return { count: 0 };
      const nearest = (p) =>
        clean[Math.min(clean.length - 1, Math.max(0, Math.ceil(p * clean.length) - 1))];
      const round = (value) => Math.round(value * 1000) / 1000;
      return {
        count: clean.length,
        p50Ms: round(nearest(0.5)),
        p95Ms: round(nearest(0.95)),
        maxMs: round(clean[clean.length - 1]),
        meanMs: round(clean.reduce((sum, value) => sum + value, 0) / clean.length),
      };
    })()`,
  );
}

async function capturePage(cdp, name) {
  try {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(data, "base64");
    const file = path.join(RUN_DIR, name);
    await writeFile(file, bytes);
    return { file, bytes: bytes.length };
  } catch (error) {
    return { file: null, bytes: 0, error: String(error) };
  }
}

/** WebGL2 canvases can be read directly; avoids intermittent CDP hangs. */
async function captureCanvas(cdp, name) {
  try {
    const dataUrl = await evaluate(
      cdp,
      `(() => {
        const canvas = document.querySelector("canvas.world-canvas");
        return canvas === null ? null : canvas.toDataURL("image/png");
      })()`,
    );
    if (
      typeof dataUrl !== "string" ||
      !dataUrl.startsWith("data:image/png;base64,")
    ) {
      return capturePage(cdp, name);
    }
    const bytes = Buffer.from(dataUrl.split(",", 2)[1], "base64");
    const file = path.join(RUN_DIR, name);
    await writeFile(file, bytes);
    return { file, bytes: bytes.length };
  } catch (error) {
    return { file: null, bytes: 0, error: String(error) };
  }
}

async function runCase(cdp, definition) {
  console.log(`[case] ${definition.label} start ${definition.url}`);
  const errors = [];
  cdp.onEvent((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(
        message.params?.exceptionDetails?.exception?.description ??
          message.params?.exceptionDetails?.text ??
          "exception",
      );
    } else if (
      message.method === "Runtime.consoleAPICalled" &&
      message.params?.type === "error"
    ) {
      errors.push(
        message.params.args
          ?.map((arg) => arg.value ?? arg.description ?? arg.type ?? "")
          .join(" ") ?? "console.error",
      );
    }
  });

  await cdp.send("Page.navigate", { url: definition.url });
  try {
    await waitFor(
      cdp,
      `Boolean(window.__WORLD__ && (window.__WORLD__.ready === true || window.__WORLD__.error))`,
      READY_TIMEOUT_MS,
      `${definition.label} world`,
    );
  } catch (error) {
    const state = await evaluate(cdp, "window.__WORLD__ ?? null").catch(
      (evalError) => ({ evalError: String(evalError) }),
    );
    const screenshot = await capturePage(cdp, `${definition.label}-timeout.png`);
    return {
      label: definition.label,
      url: definition.url,
      state,
      samples: null,
      screenshot,
      errors,
      error: String(error),
    };
  }

  const stateAtReady = await evaluate(cdp, "window.__WORLD__");
  if (stateAtReady?.error) {
    const screenshot = await capturePage(cdp, `${definition.label}-error.png`);
    return {
      label: definition.label,
      url: definition.url,
      state: stateAtReady,
      samples: null,
      screenshot,
      errors,
    };
  }

  await delay(WARMUP_MS);
  const samples = await sampleFrames(cdp, SAMPLE_MS);
  const state = await evaluate(cdp, "window.__WORLD__");
  const screenshot =
    definition.capture === "canvas"
      ? await captureCanvas(cdp, `${definition.label}.png`)
      : await capturePage(cdp, `${definition.label}.png`);
  console.log(
    `[case] ${definition.label} done backend=${state?.backend} mode=${state?.instanceMode} ` +
      `instances=${state?.instanceCount} clip=${state?.clip?.name ?? "-"} ` +
      `samples=${samples.count} p95=${samples.p95Ms ?? "-"}ms bytes=${screenshot.bytes}`,
  );
  return {
    label: definition.label,
    url: definition.url,
    state,
    samples,
    screenshot,
    errors,
  };
}

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  const vite = await startVite();
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "pocketpad-world-"));
  const launched = await launchChrome(profileDir);
  const results = {
    generatedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    node: process.version,
    baseUrl: BASE_URL,
    chrome: null,
    cases: [],
  };
  try {
    const port = await waitForPort(profileDir, launched);
    const cdp = await openSocket(await pageTarget(port));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    results.chrome = await cdp.send("Browser.getVersion").catch(() => null);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    results.cases.push(
      await runCase(cdp, {
        label: "world-webgpu",
        url: `${BASE_URL}/?backend=webgpu`,
        sampleMs: SAMPLE_MS,
        capture: "page",
      }),
    );
    results.cases.push(
      await runCase(cdp, {
        label: "world-webgl2",
        url: `${BASE_URL}/?backend=webgl2`,
        sampleMs: SAMPLE_MS,
        capture: "canvas",
      }),
    );
  } finally {
    await writeFile(
      path.join(RUN_DIR, "results.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
    await terminate(launched.child);
    await terminate(vite.child);
    await rm(profileDir, { recursive: true, force: true });
  }

  for (const entry of results.cases) {
    const state = entry.state ?? {};
    console.log(
      `${entry.label}: backend=${state.backend ?? "-"} ` +
        `post=${state.capabilities?.post ?? "-"} ` +
        `mode=${state.instanceMode ?? "-"} instances=${state.instanceCount ?? "-"} ` +
        `thin=${state.thinInstances ?? "-"} clip=${state.clip?.name ?? "-"} ` +
        `clipStarted=${state.clip?.started ?? "-"} ` +
        `followError=${state.follow?.error ?? "-"} ` +
        `p95=${entry.samples?.p95Ms ?? "-"}ms ` +
        `screenshot=${entry.screenshot?.bytes ?? "-"}B ` +
        `errors=${entry.errors.length}${entry.error ? " (case error)" : ""}`,
    );
  }
  if (vite.getLog().trim().length > 0) {
    console.log(`--- vite log (tail) ---\n${vite.getLog()}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

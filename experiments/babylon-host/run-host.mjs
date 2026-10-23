#!/usr/bin/env node
/**
 * Host-on-Babylon smoke + measurement runner (B1, spec 21 ER-21-02…04).
 *
 * Launches headless Chrome against the running dev server, opens
 * /games/engine-cube/?debug=1, presses Start, waits for the overlay to report a
 * backend and at least one draw call, records 60 s of uncapped rAF intervals,
 * and captures a screenshot. Then repeats on ?babylon-backend=webgl2 for the
 * fallback screenshot.
 *
 * The dev server must already be running (node packages/dev-server/dist/main.js).
 * This script never fabricates a measurement: every number is read from the
 * page or derived from captured samples.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const RUN_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.POCKETPAD_HOST_URL ?? "http://localhost:8080";
const VIEWPORT = { width: 1920, height: 1080 };
const WARMUP_MS = 5000;
const SAMPLE_MS = Number(process.env["POCKETPAD_SAMPLE_MS"] ?? 60000);
const CDP_TIMEOUT_MS = 15000;

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

async function terminateChrome(child) {
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

async function waitForPort(profileDir, launched, timeoutMs = 30000) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (launched.child.exitCode !== null) {
      throw new Error(`Chrome exited early.\n${launched.getStderr()}`);
    }
    try {
      const port = Number.parseInt((await readFile(file, "utf8")).split(/\r?\n/)[0], 10);
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
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result ?? {});
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
      window.__HOST_RUN__ = { samples: [], stop: false };
      let last = performance.now();
      const tick = (now) => {
        window.__HOST_RUN__.samples.push(now - last);
        last = now;
        if (!window.__HOST_RUN__.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    })()`,
  );
  await delay(durationMs);
  return evaluate(
    cdp,
    `(() => {
      window.__HOST_RUN__.stop = true;
      const clean = window.__HOST_RUN__.samples.filter(
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

function readHostState() {
  const field = (name) =>
    document.querySelector(`[data-field="${name}"]`)?.textContent?.trim() ?? null;
  const canvas = document.querySelector("canvas.lanpad-canvas");
  return {
    backend: field("backend"),
    drawCalls: Number(field("drawCalls") ?? ""),
    frameP95: field("frameP95"),
    canvasSize: field("canvasSize"),
    canvas: canvas === null ? null : { width: canvas.width, height: canvas.height },
  };
}

async function capture(cdp, name) {
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
async function captureCanvasViaPage(cdp, name) {
  try {
    const dataUrl = await evaluate(
      cdp,
      `(() => {
        const canvas = document.querySelector("canvas.lanpad-canvas");
        if (!canvas) return null;
        return canvas.toDataURL("image/png");
      })()`,
    );
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) {
      return capture(cdp, name);
    }
    const bytes = Buffer.from(dataUrl.split(",", 2)[1], "base64");
    const file = path.join(RUN_DIR, name);
    await writeFile(file, bytes);
    return { file, bytes: bytes.length };
  } catch (error) {
    return { file: null, bytes: 0, error: String(error) };
  }
}

async function runCase(cdp, { label, url, sampleMs }) {
  console.log(`[case] ${label} start ${url}`);
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

  try {
    await cdp.send("Page.navigate", { url });
    await waitFor(
      cdp,
      `document.readyState === "complete" && document.querySelector(".lanpad-start__button") !== null`,
      30000,
      `${label} start screen`,
    );
    const button = await evaluate(
      cdp,
      `(() => {
        const element = document.querySelector(".lanpad-start__button");
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`,
    );
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: button.x,
      y: button.y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: button.x,
      y: button.y,
      button: "left",
      clickCount: 1,
    });
    await waitFor(
      cdp,
      `(() => {
        const field = document.querySelector('[data-field="backend"]');
        const draws = document.querySelector('[data-field="drawCalls"]');
        return Boolean(field && field.textContent.trim() && draws && Number(draws.textContent) > 0);
      })()`,
      30000,
      `${label} first frames`,
    );
  } catch (error) {
    const debug = await evaluate(
      cdp,
      `(() => ({
        url: location.href,
        text: document.body.innerText.slice(0, 1200),
        startScreen: document.querySelector(".lanpad-start") !== null,
        backendField: document.querySelector('[data-field="backend"]')?.textContent ?? null,
        drawsField: document.querySelector('[data-field="drawCalls"]')?.textContent ?? null,
        canvases: [...document.querySelectorAll("canvas")].map((canvas) => ({
          className: canvas.className,
          width: canvas.width,
          height: canvas.height,
          hidden: canvas.hidden,
        })),
      }))()`,
    ).catch((evalError) => ({ evalError: String(evalError) }));
    await capture(cdp, `${label}-fail.png`).catch(() => null);
    throw new Error(
      `${error.message}\n${JSON.stringify({ debug, errors }, null, 2)}`,
    );
  }
  await delay(WARMUP_MS);
  const host = await evaluate(cdp, `(${readHostState.toString()})()`);
  const gpu = await evaluate(
    cdp,
    `(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const ext = gl?.getExtension("WEBGL_debug_renderer_info");
      return {
        userAgent: navigator.userAgent,
        webgpu: typeof navigator.gpu !== "undefined",
        webgl2: Boolean(gl),
        renderer: gl
          ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
          : null,
        crossOriginIsolated: self.crossOriginIsolated === true,
      };
    })()`,
  );
  const samples = sampleMs > 0 ? await sampleFrames(cdp, sampleMs) : null;
  const screenshot = label.includes("webgl2")
    ? await captureCanvasViaPage(cdp, `${label}.png`)
    : await capture(cdp, `${label}.png`);
  console.log(`[case] ${label} done backend=${host.backend} draws=${host.drawCalls}`);
  return { label, url, host, gpu, samples, screenshot, errors };
}

async function runContextLossCase(cdp) {
  console.log("[case] cube-webgl2-loss start");
  const errors = [];
  cdp.onEvent((message) => {
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(
        message.params?.exceptionDetails?.exception?.description ??
          message.params?.exceptionDetails?.text ??
          "exception",
      );
    }
  });
  const url = `${BASE_URL}/games/engine-cube/?debug=1&babylon-backend=webgl2`;
  await cdp.send("Page.navigate", { url });
  await waitFor(
    cdp,
    `document.readyState === "complete" && document.querySelector(".lanpad-start__button") !== null`,
    30000,
    "context-loss start screen",
  );
  const button = await evaluate(
    cdp,
    `(() => {
      const element = document.querySelector(".lanpad-start__button");
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`,
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: button.x,
      y: button.y,
      button: "left",
      clickCount: 1,
    });
  }
  await waitFor(
    cdp,
    `(() => {
      const draws = document.querySelector('[data-field="drawCalls"]');
      return Boolean(draws && Number(draws.textContent) > 0);
    })()`,
    30000,
    "context-loss first frames",
  );
  await delay(1000);
  const setup = await evaluate(
    cdp,
    `(() => {
      const canvas = document.querySelector("canvas.lanpad-canvas");
      if (!canvas) return { ok: false, reason: "no-canvas" };
      const gl = canvas.getContext("webgl2");
      if (!gl) return { ok: false, reason: "no-webgl2" };
      const ext = gl.getExtension("WEBGL_lose_context");
      if (!ext) return { ok: false, reason: "no-lose-extension" };
      window.__BABYLON_LOSS__ = { lost: false, restored: false, ext };
      canvas.addEventListener("webglcontextlost", () => {
        window.__BABYLON_LOSS__.lost = true;
      }, { once: true });
      canvas.addEventListener("webglcontextrestored", () => {
        window.__BABYLON_LOSS__.restored = true;
      }, { once: true });
      ext.loseContext();
      return { ok: true };
    })()`,
  );
  await delay(2000);
  const afterLoss = await evaluate(
    cdp,
    `(() => {
      const field = (name) => document.querySelector('[data-field="' + name + '"]')?.textContent?.trim() ?? null;
      return {
        lost: window.__BABYLON_LOSS__?.lost === true,
        restored: window.__BABYLON_LOSS__?.restored === true,
        backend: field("backend"),
        draws: Number(field("drawCalls") ?? ""),
      };
    })()`,
  ).catch((error) => ({ error: String(error) }));
  await evaluate(
    cdp,
    `(() => {
      try { window.__BABYLON_LOSS__?.ext?.restoreContext(); } catch {}
      return true;
    })()`,
  ).catch(() => null);
  await delay(2500);
  const afterRestore = await evaluate(
    cdp,
    `(() => {
      const field = (name) => document.querySelector('[data-field="' + name + '"]')?.textContent?.trim() ?? null;
      return {
        lost: window.__BABYLON_LOSS__?.lost === true,
        restored: window.__BABYLON_LOSS__?.restored === true,
        backend: field("backend"),
        draws: Number(field("drawCalls") ?? ""),
      };
    })()`,
  ).catch((error) => ({ error: String(error) }));
  const screenshot = await captureCanvasViaPage(cdp, "cube-webgl2-loss.png");
  return { label: "cube-webgl2-loss", url, setup, afterLoss, afterRestore, screenshot, errors };
}

async function main() {
  await mkdir(RUN_DIR, { recursive: true });
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "pocketpad-babylon-"));
  const launched = await launchChrome(profileDir);
  const results = { generatedAt: new Date().toISOString(), viewport: VIEWPORT, cases: [] };
  try {
    const port = await waitForPort(profileDir, launched);
    const cdp = await openSocket(await pageTarget(port));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // The host fits a 16:9 canvas under 104px of chrome plus a 16px margin.
    // A 1200px-tall viewport therefore yields an exact 1920×1080 canvas.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width + 16,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });

    results.cases.push(
      await runCase(cdp, {
        label: "cube-webgpu",
        url: `${BASE_URL}/games/engine-cube/?debug=1`,
        sampleMs: SAMPLE_MS,
      }),
    );
    results.cases.push(
      await runCase(cdp, {
        label: "cube-webgl2",
        url: `${BASE_URL}/games/engine-cube/?debug=1&babylon-backend=webgl2`,
        sampleMs: 0,
      }),
    );
    results.contextLoss = await runContextLossCase(cdp);
  } finally {
    await writeFile(
      path.join(RUN_DIR, "results.json"),
      `${JSON.stringify(results, null, 2)}\n`,
    );
    await terminateChrome(launched.child);
    await rm(profileDir, { recursive: true, force: true });
  }
  for (const entry of results.cases) {
    console.log(
      `${entry.label}: backend=${entry.host.backend} draws=${entry.host.drawCalls} ` +
        `canvas=${entry.host.canvasSize} samples=${entry.samples?.count ?? 0} ` +
        `p95=${entry.samples?.p95Ms ?? "-"}ms screenshot=${entry.screenshot.bytes}B ` +
        `errors=${entry.errors.length}`,
    );
  }
  if (results.contextLoss) {
    console.log(`context-loss: ${JSON.stringify(results.contextLoss.afterRestore)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

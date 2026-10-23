/**
 * Measurement runner for the Havok vs Rapier spike.
 *
 * Builds the page, serves dist/ behind the production isolation headers, and
 * drives one headless Chrome instance per (engine, resolution) over CDP. Each
 * run publishes its full report on `window.__SPIKE__`; this script merges the
 * runs with exact package bytes into results.json and writes a screenshot.
 *
 * Headless Chrome on this machine renders through ANGLE/D3D11 on the machine's
 * GPU (see `environment.renderer` in the report). The numbers are behaviour and
 * relative-cost evidence on one desktop GPU, not target-hardware acceptance.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { measureSizes } from "./size.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = join(root, "dist");
const screenshots = join(root, "screenshots");
const TIMEOUT_MS = 240_000;

const RUNS = [
  { engine: "havok", width: 1920, height: 1080 },
  { engine: "rapier", width: 1920, height: 1080 },
  { engine: "havok", width: 1280, height: 720 },
  { engine: "rapier", width: 1280, height: 720 },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const rawPath = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
      const relative = rawPath === "/" ? "index.html" : rawPath.slice(1);
      const filePath = normalize(join(dist, relative));
      if (!filePath.startsWith(dist + sep) && filePath !== dist) {
        response.writeHead(403, ISOLATION_HEADERS).end("forbidden");
        return;
      }
      const data = await readFile(filePath);
      response.writeHead(200, {
        ...ISOLATION_HEADERS,
        "Content-Type":
          MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": data.length,
        "Cache-Control": "no-store",
      });
      response.end(data);
    } catch {
      response.writeHead(404, ISOLATION_HEADERS).end("not found");
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function waitForFile(path, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolveFile, rejectFile) => {
    const tick = () => {
      if (existsSync(path)) {
        resolveFile();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        rejectFile(new Error(`timeout waiting for ${path}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", rejectOpen, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolveSend, rejectSend } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          rejectSend(new Error(`${message.error.message} (${message.error.code})`));
        } else {
          resolveSend(message.result);
        }
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolveSend, rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

const SNAPSHOT_EXPRESSION = `(() => {
  const spike = window.__SPIKE__;
  if (!spike || !spike.done) return null;
  return JSON.stringify(spike);
})()`;

async function runOne(chrome, pageUrl, engine, width, height) {
  const profile = await mkdtemp(join(tmpdir(), "pp-physics-chrome-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-sync",
      `--window-size=${width},${height}`,
      "--force-device-scale-factor=1",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let cdp = null;
  const consoleErrors = [];
  const startedAt = Date.now();
  try {
    const portFile = join(profile, "DevToolsActivePort");
    await waitForFile(portFile, 20_000);
    const [debugPort] = (await readFile(portFile, "utf8")).split("\n");
    const response = await fetch(
      `http://127.0.0.1:${debugPort}/json/new?about:blank`,
      { method: "PUT" },
    );
    const target = await response.json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    cdp.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        consoleErrors.push(
          `${details.text}: ${details.exception?.description ?? ""}`,
        );
      }
      if (
        message.method === "Runtime.consoleAPICalled" &&
        message.params.type === "error"
      ) {
        consoleErrors.push(
          message.params.args
            .map((argument) => argument.value ?? argument.description ?? "")
            .join(" "),
        );
      }
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Log.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: pageUrl });

    let spike = null;
    while (Date.now() - startedAt < TIMEOUT_MS) {
      const result = await cdp.send("Runtime.evaluate", {
        expression: SNAPSHOT_EXPRESSION,
        returnByValue: true,
      });
      const value = result.result?.value;
      if (value) {
        spike = JSON.parse(value);
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    if (!spike) {
      throw new Error(`window.__SPIKE__.done never became true for ${engine}`);
    }

    await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    let screenshot = null;
    let screenshotError = null;
    try {
      // Page.captureScreenshot intermittently fails with -32000 on a busy
      // WebGL tab. The canvas is created with preserveDrawingBuffer, so a
      // direct canvas read is a reliable second path and still shows the
      // rendered scene.
      let shot = null;
      let lastError = null;
      for (let attempt = 0; attempt < 3 && !shot; attempt += 1) {
        try {
          shot = await cdp.send("Page.captureScreenshot", { format: "png" });
        } catch (error) {
          lastError = error;
          await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        }
      }
      let data = shot?.data ?? null;
      if (!data) {
        const canvasShot = await cdp.send("Runtime.evaluate", {
          expression:
            "document.getElementById('stage').toDataURL('image/png').split(',')[1]",
          returnByValue: true,
        });
        data = canvasShot.result?.value ?? null;
      }
      if (!data) throw lastError ?? new Error("screenshot failed");
      screenshot = join("screenshots", `${engine}-${width}x${height}.png`);
      await writeFile(join(root, screenshot), Buffer.from(data, "base64"));
    } catch (error) {
      // A lost screenshot must not discard a completed measurement.
      screenshotError = String(error?.message ?? error);
    }

    return {
      engine,
      width,
      height,
      elapsedMs: Date.now() - startedAt,
      url: pageUrl,
      screenshot,
      screenshotError,
      consoleErrors: consoleErrors.slice(0, 20),
      spike,
    };
  } finally {
    cdp?.close();
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      child.kill("SIGKILL");
    }
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

function selectRuns() {
  const argument = (prefix) =>
    process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  const onlyEngine = argument("--engine=");
  const onlySize = argument("--size=");
  return {
    filtered: Boolean(onlyEngine || onlySize),
    runs: RUNS.filter(
      (run) =>
        (!onlyEngine || run.engine === onlyEngine) &&
        (!onlySize || `${run.width}x${run.height}` === onlySize),
    ),
  };
}

function valueAt(value, fallback = "PENDING") {
  return value === null || value === undefined ? fallback : value;
}

function printSummary(runs) {
  console.log("\n[result] engine  resolution   wasm ms  first world ms  physics p95 ms  frame p95 ms  fps  0-50 km/h s");
  for (const run of runs) {
    const spike = run.spike ?? {};
    const boot = spike.boot ?? {};
    const benchmark = spike.benchmark ?? {};
    const physics = benchmark.physics ?? {};
    const frames = benchmark.frames ?? {};
    const car = spike.scenarios?.carAcceleration ?? {};
    console.log(
      `  ${run.engine.padEnd(7)} ${`${run.width}x${run.height}`.padEnd(12)} ` +
        `${String(valueAt(boot.wasmInitMs)).padStart(7)}  ` +
        `${String(valueAt(boot.firstWorldMs)).padStart(14)}  ` +
        `${String(valueAt(physics.p95)).padStart(15)}  ` +
        `${String(valueAt(frames.stepPlusRenderMs?.p95)).padStart(12)}  ` +
        `${String(valueAt(frames.fpsFromInterval)).padStart(5)}  ` +
        `${String(valueAt(car.timeTo50KmhSeconds)).padEnd(10)}`,
    );
    if (run.error) console.log(`    ERROR: ${run.error}`);
  }
}

async function main() {
  const skipBuild = process.argv.includes("--no-build");
  if (!skipBuild) {
    console.log("[run] building dist/ ...");
    await build({
      root,
      configFile: join(root, "vite.config.js"),
      logLevel: "warn",
    });
  }
  if (!existsSync(join(dist, "index.html"))) {
    throw new Error("dist/index.html not found; run without --no-build");
  }
  await mkdir(screenshots, { recursive: true });

  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome/Edge not found; set CHROME_PATH");

  const server = await startServer();
  const port = server.address().port;
  console.log(`[run] serving ${dist} at http://127.0.0.1:${port}`);
  console.log(`[run] chrome: ${chrome}`);

  const selection = selectRuns();
  if (selection.runs.length === 0) {
    throw new Error("no runs match the --engine/--size filters");
  }

  const runs = [];
  try {
    for (const spec of selection.runs) {
      const probe = process.argv.includes("--probe") ? "&probe=1" : "";
      const pageUrl = `http://127.0.0.1:${port}/index.html?engine=${spec.engine}${probe}`;
      console.log(
        `[run] ${spec.engine} ${spec.width}x${spec.height} ...`,
      );
      try {
        const record = await runOne(
          chrome,
          pageUrl,
          spec.engine,
          spec.width,
          spec.height,
        );
        if (record.spike?.error) record.error = record.spike.error;
        runs.push(record);
        console.log(
          `[run] ${spec.engine} ${spec.width}x${spec.height} done in ${record.elapsedMs} ms`,
        );
      } catch (error) {
        runs.push({
          engine: spec.engine,
          width: spec.width,
          height: spec.height,
          error: String(error?.stack ?? error),
          spike: null,
        });
        console.error(`[run] ${spec.engine} ${spec.width}x${spec.height} FAILED`);
        console.error(String(error?.stack ?? error));
      }
    }
  } finally {
    server.close();
  }

  const size = await measureSizes();
  await writeFile(
    join(root, "size-report.json"),
    `${JSON.stringify(size, null, 2)}\n`,
  );
  const results = {
    generatedAt: new Date().toISOString(),
    headless: true,
    note: "Headless Chrome through ANGLE/D3D11 on the desktop GPU named in each run's environment.renderer. Behaviour and relative-cost evidence on one desktop GPU; not target-hardware acceptance. 1080p/720p frame numbers include one unchanging showcase scene with 501 draw calls, not a game.",
    runs,
    size,
  };
  const resultsPath = join(
    root,
    selection.filtered ? "results-partial.json" : "results.json",
  );
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);

  printSummary(runs);
  console.log(`\n[run] wrote ${resultsPath}`);
  if (runs.some((run) => run.error)) process.exitCode = 1;
  if (!size.permissive) {
    console.error("[licence] STOP: at least one declared licence is not permissive");
    process.exitCode = 1;
  }
}

await main();

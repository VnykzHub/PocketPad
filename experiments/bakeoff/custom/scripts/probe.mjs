/**
 * Minimal Chrome/CDP probe for the custom contender.
 *
 * The bake-off runner screenshots at the end of the measured window, by which
 * time the scripted car has left the city block. This tool exists to look at
 * the page at a chosen moment (default 1.5 s after load) and to dump the debug
 * global, so a capability is only claimed after it was seen working.
 *
 *   node scripts/probe.mjs --url http://127.0.0.1:4173/experiments/bakeoff/custom/ \
 *     --screenshot probe.png --wait 1500
 *
 * Reads `window.__BAKEOFF__`, `window.__BAKEOFF_STATUS__` and
 * `window.__BAKEOFF_DEBUG__`; writes a screenshot and prints the dump. No
 * third-party dependency: Node's global WebSocket and fetch.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

function parseArgs(argv) {
  const options = {
    url: "http://127.0.0.1:4173/experiments/bakeoff/custom/",
    wait: 1500,
    screenshot: join(packageRoot, "probe.png"),
    chrome: process.env.CHROME_PATH ?? null,
    width: 1920,
    height: 1080,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[index];
    };
    if (flag === "--url") options.url = value();
    else if (flag === "--wait") options.wait = Number(value());
    else if (flag === "--screenshot") options.screenshot = resolve(value());
    else if (flag === "--chrome") options.chrome = value();
    else if (flag === "--width") options.width = Number(value());
    else if (flag === "--height") options.height = Number(value());
    else throw new Error(`unknown flag ${flag}`);
  }
  return options;
}

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function findChrome(explicit) {
  if (explicit !== null) {
    if (!existsSync(explicit)) throw new Error(`chrome not found at ${explicit}`);
    return explicit;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome not found; pass --chrome <path>");
}

function launchChrome(chromePath, profileDir, options) {
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      `--window-size=${options.width},${options.height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = new Promise((resolveEndpoint, rejectEndpoint) => {
    let buffered = "";
    const timer = setTimeout(() => {
      rejectEndpoint(new Error("Chrome did not print a DevTools endpoint in 20 s"));
    }, 20000);
    child.stderr.on("data", (chunk) => {
      buffered += chunk.toString();
      const match = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match !== null) {
        clearTimeout(timer);
        resolveEndpoint(match[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rejectEndpoint(new Error(`Chrome exited early with code ${code}`));
    });
  });
  return { child, endpoint };
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (entry === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      const listener = this.events.get(message.method);
      if (listener !== undefined) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolveEvent) => {
      this.events.set(method, (params) => {
        this.events.delete(method);
        resolveEvent(params);
      });
    });
  }
}

async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP socket failed")), {
      once: true,
    });
  });
  return new Cdp(socket);
}

const options = parseArgs(process.argv.slice(2));
const chromePath = findChrome(options.chrome);
const profileDir = mkdtempSync(join(tmpdir(), "pocketpad-probe-"));
const { child, endpoint } = launchChrome(chromePath, profileDir, options);
let exitCode = 0;

try {
  const browserWs = await endpoint;
  const port = new URL(browserWs).port;
  const targets = await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json();
  const page = targets.find((target) => target.type === "page");
  if (page === undefined) throw new Error("no page target");

  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: options.url });
  await loaded;
  await new Promise((resolveWait) => setTimeout(resolveWait, options.wait));

  const probe = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      href: location.href,
      crossOriginIsolated: crossOriginIsolated,
      booted: window.__BAKEOFF_BOOTED__ === true,
      status: window.__BAKEOFF_STATUS__,
      metrics: window.__BAKEOFF__,
      debug: window.__BAKEOFF_DEBUG__ ?? null
    })`,
    returnByValue: true,
    awaitPromise: false,
  });
  const parsed = JSON.parse(probe.result.value);
  // The frame-time array is summarised; the full list belongs to the runner.
  if (parsed.metrics !== null && Array.isArray(parsed.metrics.frameTimesMs)) {
    const times = parsed.metrics.frameTimesMs;
    const sorted = [...times].sort((a, b) => a - b);
    const at = (q) =>
      sorted.length === 0
        ? null
        : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    parsed.metrics.frameTimesMs = {
      count: times.length,
      p50: at(0.5),
      p95: at(0.95),
      max: sorted.length === 0 ? null : sorted[sorted.length - 1],
    };
  }

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(options.screenshot), { recursive: true });
  writeFileSync(options.screenshot, Buffer.from(shot.data, "base64"));

  console.log(JSON.stringify({ screenshot: options.screenshot, probe: parsed }, null, 2));
  cdp.socket.close();
} catch (error) {
  console.error(`probe failed: ${error instanceof Error ? error.stack : String(error)}`);
  exitCode = 1;
} finally {
  child.kill();
  await new Promise((resolveExit) => {
    child.once("exit", resolveExit);
    setTimeout(resolveExit, 3000);
  });
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // A locked profile directory is harmless; the OS temp cleaner handles it.
  }
}

process.exit(exitCode);

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
};
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const file = normalize(join(ROOT, pathname));
    if (!file.startsWith(ROOT)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    const body = await readFile(file);
    response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end("not found");
  }
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
const PAGE_URL = `http://127.0.0.1:${port}/experiments/e-m0-engine/srgb-probe.html`;
const profile = await mkdtemp(join(tmpdir(), "pocketpad-srgb-probe-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu-sandbox",
    "--enable-unsafe-webgpu",
    "--force-color-profile=srgb",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    PAGE_URL,
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function devtoolsPort() {
  const portFile = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const text = await readFile(portFile, "utf8");
      const [port] = text.split(/\r?\n/);
      if (port) return Number(port);
    } catch {
      // Chrome has not written the port file yet.
    }
    await sleep(50);
  }
  throw new Error("Chrome did not expose a DevTools port");
}

async function pageTarget(port) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    const page = targets.find((target) => target.type === "page" && target.url === PAGE_URL);
    if (page) return page;
    await sleep(50);
  }
  throw new Error("probe page target not found");
}

let socket;
try {
  const port = await devtoolsPort();
  const target = await pageTarget(port);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  let done = false;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const result = await send("Runtime.evaluate", {
      expression: "window.__PROBE_DONE__ === true",
      returnByValue: true,
    });
    if (result.result.value === true) {
      done = true;
      break;
    }
    await sleep(50);
  }
  if (!done) throw new Error("probe did not finish");
  const result = await send("Runtime.evaluate", {
    expression: "document.getElementById('out').textContent",
    returnByValue: true,
  });
  console.log(result.result.value);
} catch (error) {
  console.error("probe failed:", error.message);
  console.error(stderr.slice(-4000));
  process.exitCode = 1;
} finally {
  socket?.close();
  chrome.kill();
  await sleep(500);
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

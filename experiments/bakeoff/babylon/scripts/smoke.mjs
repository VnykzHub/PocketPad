// Headless smoke test: serve dist/ with the production isolation headers,
// drive Chrome over CDP at 1920x1080, wait for window.__BAKEOFF__ to finish
// its short sample run, then print the measured contract fields and save a
// screenshot. This is a smoke test, not the official measurement.

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');
// Mirror the runner's URL layout: the page lives under /experiments/bakeoff/
// babylon/ and fetches ../assets/, which resolves to /experiments/bakeoff/
// assets/. That keeps Vite's own /assets/* chunks separate from shared assets.
const sharedAssets = resolve(here, '..', '..', 'assets');
const pagePrefix = '/experiments/bakeoff/babylon/';
const sharedPrefix = '/experiments/bakeoff/assets/';
const forcedBackend = process.env.BAKEOFF_FORCE_BACKEND ?? '';
const smokePng = resolve(here, '..', forcedBackend === 'webgl2' ? 'smoke-webgl2.png' : 'smoke.png');
const initialPng = resolve(here, '..', forcedBackend === 'webgl2' ? 'smoke-webgl2-initial.png' : 'smoke-initial.png');
const pedsPng = resolve(here, '..', forcedBackend === 'webgl2' ? 'smoke-webgl2-peds.png' : 'smoke-peds.png');
const WIDTH = 1920;
const HEIGHT = 1080;
const RUN_SECONDS = 6;
const WARMUP_SECONDS = 2;
const TIMEOUT_MS = 180_000;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.ktx2': 'image/ktx2',
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function startServer() {
  const server = createServer(async (request, response) => {
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    try {
      const rawPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let baseDir;
      let relative;
      if (rawPath.startsWith(sharedPrefix)) {
        baseDir = sharedAssets;
        relative = rawPath.slice(sharedPrefix.length);
      } else if (rawPath.startsWith(pagePrefix)) {
        baseDir = dist;
        relative = rawPath.slice(pagePrefix.length) || 'index.html';
      } else if (rawPath === '/') {
        baseDir = dist;
        relative = 'index.html';
      } else {
        response.writeHead(404, headers).end('not found');
        return;
      }
      const filePath = normalize(join(baseDir, relative));
      if (!filePath.startsWith(baseDir + sep) && filePath !== baseDir) {
        response.writeHead(403, headers).end('forbidden');
        return;
      }
      const data = await readFile(filePath);
      response.writeHead(200, {
        ...headers,
        'Content-Type': mime[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      response.end(data);
    } catch {
      response.writeHead(404, headers).end('not found');
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => resolveServer(server));
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
    this.events = [];
    this.socket = null;
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', rejectOpen, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolveSend, rejectSend } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) rejectSend(new Error(`${message.error.message} (${message.error.code})`));
        else resolveSend(message.result);
      } else if (message.method) {
        this.events.push(message);
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

const PERCENTILES = `(() => {
  const m = window.__BAKEOFF_EXTRA__;
  if (!m) return null;
  const samples = m.frameTimesMs.slice().sort((a, b) => a - b);
  const at = (p) => samples.length ? samples[Math.min(samples.length - 1, Math.max(0, Math.ceil((p / 100) * samples.length) - 1))] : null;
  return JSON.stringify({
    ready: m.ready,
    measurementComplete: m.measurementComplete,
    backend: m.backend,
    backendInfo: m.backendInfo,
    softwareRenderer: m.softwareRenderer,
    crossOriginIsolated: m.crossOriginIsolated,
    firstFrameMs: m.firstFrameMs,
    sampleCount: m.sampleCount,
    p50: at(50), p95: at(95), p99: at(99),
    min: samples[0] ?? null, max: samples[samples.length - 1] ?? null,
    drawCalls: m.drawCalls, triangles: m.triangles, instances: m.instances,
    activations: m.activations, deactivations: m.deactivations,
    audio: m.audio, assetSource: m.assetSource, assets: m.assets,
    buildings: m.buildings, pedestrians: m.pedestrians,
    animatedPeds: m.animatedPeds, pedestrianControllers: m.pedestrianControllers,
    wheelNodes: m.wheelNodes, carPhysics: m.carPhysics, shadows: m.shadows,
    physics: m.physics, activePeds: m.activePeds, peakActivePeds: m.peakActivePeds,
    errors: m.errors,
  });
})()`;

async function main() {
  if (!existsSync(join(dist, 'index.html'))) {
    throw new Error('dist/index.html not found; run npm run build first');
  }
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome/Edge not found; set CHROME_PATH');

  const server = await startServer();
  const port = server.address().port;
  const pageUrl =
    `http://127.0.0.1:${port}${pagePrefix}index.html?runSeconds=${RUN_SECONDS}&warmupSeconds=${WARMUP_SECONDS}` +
    (forcedBackend ? `&backend=${encodeURIComponent(forcedBackend)}` : '');
  const profile = await mkdtemp(join(tmpdir(), 'pp-bakeoff-chrome-'));
  console.log(`[smoke] serving ${dist} at http://127.0.0.1:${port}`);
  console.log(`[smoke] chrome: ${chrome}`);

  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-sync',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--force-device-scale-factor=1',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp = null;
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    await waitForFile(portFile, 20_000);
    const [debugPort] = (await readFile(portFile, 'utf8')).split('\n');
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' });
    const target = await response.json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();

    const consoleErrors = [];
    cdp.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description ?? ''));
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: pageUrl });

    const startedAt = Date.now();
    let snapshot = null;
    let initialCaptured = false;
    while (Date.now() - startedAt < TIMEOUT_MS) {
      const result = await cdp.send('Runtime.evaluate', { expression: PERCENTILES, returnByValue: true });
      const value = result.result?.value;
      if (value) {
        snapshot = JSON.parse(value);
        if (snapshot.ready && !initialCaptured) {
          // Capture the start-of-run view while the camera still faces the
          // centre-cell buildings and the south-cell pedestrians.
          await new Promise((resolveWait) => setTimeout(resolveWait, 600));
          const initialShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
          await writeFile(initialPng, Buffer.from(initialShot.data, 'base64'));
          initialCaptured = true;
        }
        if (snapshot.measurementComplete) break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    if (!snapshot) throw new Error('window.__BAKEOFF__ never appeared');
    snapshot.elapsedMs = Date.now() - startedAt;
    snapshot.consoleErrors = consoleErrors.slice(0, 20);
    snapshot.url = pageUrl;

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(smokePng, Buffer.from(shot.data, 'base64'));

    // Hold the camera over the south cells for a pedestrian close-up. This is
    // after the measured window, so it does not affect the numbers above.
    await cdp.send('Runtime.evaluate', { expression: 'window.__BAKEOFF_VIEW_PEDS__?.()' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    const pedShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(pedsPng, Buffer.from(pedShot.data, 'base64'));

    console.log(JSON.stringify(snapshot, null, 2));
    console.log(
      `[smoke] screenshots: ${smokePng}${initialCaptured ? `, ${initialPng}` : ''}, ${pedsPng}`,
    );
    if (!snapshot.measurementComplete) {
      console.error('[smoke] measurement did not complete before timeout');
      process.exitCode = 2;
    }
  } finally {
    cdp?.close();
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
    server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

await main();

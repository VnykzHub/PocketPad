// Verifies the forced-WebGL2 fallback in a real browser. It expects the
// bake-off static server to be running (runner: node run.mjs --serve-only),
// launches headless Chrome against ?backend=webgl2, waits for the contract's
// ready marker, then prints the recorded state and saves a screenshot.
//
// Usage: node scripts/check-webgl2.mjs [baseUrl] [chromePath]
// Defaults: http://127.0.0.1:47999, the Windows Chrome install path.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.argv[2] ?? 'http://127.0.0.1:47999';
const CHROME = process.argv[3] ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE_URL = `${BASE_URL}/experiments/bakeoff/playcanvas/?backend=webgl2`;
const OUT_PNG = path.join(HERE, '..', 'smoke', 'webgl2-fallback.png');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectCdp(url, onEvent) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const pending = new Map();
        let nextId = 0;
        socket.addEventListener('open', () => resolve({
            send(method, params = {}) {
                return new Promise((resolveMessage, rejectMessage) => {
                    const id = ++nextId;
                    pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
                    socket.send(JSON.stringify({ id, method, params }));
                });
            },
            close() {
                socket.close();
            }
        }));
        socket.addEventListener('error', () => reject(new Error('CDP socket failed')));
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            const waiter = pending.get(message.id);
            if (!waiter) {
                if (onEvent) {
                    onEvent(message);
                }
                return;
            }
            pending.delete(message.id);
            if (message.error) {
                waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
            } else {
                waiter.resolve(message.result);
            }
        });
    });
}

async function devtoolsPort(profileDir, child, timeoutMs) {
    const portFile = path.join(profileDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`Chrome exited early with code ${child.exitCode}`);
        }
        try {
            const text = await readFile(portFile, 'utf8');
            const port = Number.parseInt(text.split(/\r?\n/)[0], 10);
            if (Number.isInteger(port) && port > 0) {
                return port;
            }
        } catch {
            // The port file appears once Chrome is ready.
        }
        await delay(100);
    }
    throw new Error('Chrome did not expose a DevTools port');
}

async function pageSocketUrl(port) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            const targets = await response.json();
            const page = targets.find((target) =>
                target.type === 'page' && target.url.includes('/experiments/bakeoff/playcanvas/'));
            if (page && page.webSocketDebuggerUrl) {
                return page.webSocketDebuggerUrl;
            }
        } catch {
            // Chrome may still be starting.
        }
        await delay(200);
    }
    throw new Error('no PlayCanvas page target appeared');
}

async function evaluate(cdp, expression) {
    const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
    });
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? 'page evaluation failed');
    }
    return result.result.value;
}

// Reads pixels inside a rAF callback, after PlayCanvas has rendered the frame,
// and snapshots the canvas before the compositor clears the drawing buffer.
const PIXEL_PROBE = `(() => new Promise((resolve) => {
    const canvas = document.getElementById('app');
    const gl = canvas.getContext('webgl2');
    requestAnimationFrame(() => requestAnimationFrame(() => {
        const out = { samples: [], glError: null, png: null };
        try {
            const pixel = new Uint8Array(4);
            const points = [
                [canvas.width >> 1, canvas.height >> 1],
                [canvas.width >> 1, 80],
                [canvas.width >> 1, canvas.height - 80],
                [80, canvas.height >> 1]
            ];
            for (const [x, y] of points) {
                gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                out.samples.push({ x, y, rgba: Array.from(pixel) });
            }
            out.glError = gl.getError();
            out.png = canvas.toDataURL('image/png');
        } catch (error) {
            out.error = String(error);
        }
        resolve(JSON.stringify(out));
    }));
}))()`;

const SNAPSHOT = `(() => {
    const contract = window.__BAKEOFF__;
    if (!contract) return null;
    let renderer = null;
    try {
        const canvas = document.getElementById('app');
        const gl = canvas && canvas.getContext('webgl2');
        const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
        renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
    } catch (error) {
        renderer = String(error);
    }
    return JSON.stringify({
        ready: contract.ready,
        backend: contract.backend,
        errors: contract.errors,
        drawCalls: contract.drawCalls,
        triangles: contract.triangles,
        instances: contract.instances,
        activations: contract.activations,
        deactivations: contract.deactivations,
        firstFrameMs: contract.firstFrameMs,
        hud: (document.getElementById('hud') || {}).textContent || null,
        canvas: (() => {
            const canvas = document.getElementById('app');
            return canvas ? [canvas.width, canvas.height] : null;
        })(),
        crossOriginIsolated: window.crossOriginIsolated,
        webglRenderer: renderer,
        userAgent: navigator.userAgent
    });
})()`;

async function main() {
    if (!existsSync(CHROME)) {
        throw new Error(`Chrome not found at ${CHROME}`);
    }
    const profileDir = await mkdtemp(path.join(os.tmpdir(), 'pocketpad-pc-webgl2-'));
    const child = spawn(CHROME, [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--mute-audio',
        '--hide-scrollbars',
        '--force-color-profile=srgb',
        '--force-device-scale-factor=1',
        '--enable-unsafe-webgpu',
        '--window-size=1920,1080',
        PAGE_URL
    ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });

    let cdp = null;
    const events = [];
    try {
        const port = await devtoolsPort(profileDir, child, 20000);
        cdp = await connectCdp(await pageSocketUrl(port), (message) => {
            if (message.method === 'Runtime.consoleAPICalled') {
                events.push({
                    source: 'console',
                    level: message.params.type,
                    text: (message.params.args || [])
                        .map((arg) => arg.value ?? arg.description ?? '')
                        .join(' ')
                });
            } else if (message.method === 'Runtime.exceptionThrown') {
                events.push({
                    source: 'exception',
                    level: 'error',
                    text: message.params.exceptionDetails.text
                });
            } else if (message.method === 'Log.entryAdded') {
                events.push({
                    source: message.params.entry.source,
                    level: message.params.entry.level,
                    text: message.params.entry.text
                });
            }
        });
        await cdp.send('Runtime.enable');
        await cdp.send('Log.enable');
        await cdp.send('Page.enable');

        const deadline = Date.now() + 30000;
        let snapshot = null;
        while (Date.now() < deadline) {
            const raw = await evaluate(cdp, SNAPSHOT);
            if (raw) {
                snapshot = JSON.parse(raw);
                if (snapshot.ready) {
                    break;
                }
            }
            await delay(250);
        }
        if (!snapshot || !snapshot.ready) {
            throw new Error(`page never became ready; last state: ${JSON.stringify(snapshot)}`);
        }
        await delay(700);

        const finalRaw = await evaluate(cdp, SNAPSHOT);
        const final = JSON.parse(finalRaw);
        const probeRaw = await evaluate(cdp, PIXEL_PROBE);
        const probe = JSON.parse(probeRaw);
        if (typeof probe.png === 'string' && probe.png.startsWith('data:image/png;base64,')) {
            const canvasPng = path.join(HERE, '..', 'smoke', 'webgl2-canvas.png');
            await writeFile(canvasPng, Buffer.from(probe.png.slice(22), 'base64'));
            probe.canvasScreenshot = path.relative(path.join(HERE, '..', '..', '..', '..'), canvasPng)
                .split(path.sep).join('/');
        }
        delete probe.png;
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        await mkdir(path.dirname(OUT_PNG), { recursive: true });
        await writeFile(OUT_PNG, Buffer.from(shot.data, 'base64'));

        const ok = final.backend === 'webgl2' && final.errors.length === 0;
        console.log(JSON.stringify({
            ok,
            pageUrl: PAGE_URL,
            screenshot: path.relative(path.join(HERE, '..', '..', '..', '..'), OUT_PNG)
                .split(path.sep).join('/'),
            state: final,
            pixelProbe: probe,
            consoleEvents: events
        }, null, 2));
        if (!ok) {
            process.exitCode = 1;
        }
    } finally {
        if (cdp) {
            cdp.close();
        }
        child.kill();
        await delay(500);
        if (child.exitCode === null) {
            spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore'
            });
        }
        await rm(profileDir, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(`WebGL2 fallback check failed: ${error.message}`);
    process.exitCode = 1;
});

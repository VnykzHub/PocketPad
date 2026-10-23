/**
 * Local static server for the custom contender.
 *
 * Mirrors the bake-off runner's URL convention: the repository root is the
 * server root, the page lives at `/experiments/bakeoff/custom/`, and missing
 * files under that prefix retry inside `dist/`. Every response carries
 * COOP/COEP/CORP so the page is cross-origin isolated.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const contenderRoot = resolve(fileURLToPath(new URL("./", import.meta.url)));
const pagePrefix = "/experiments/bakeoff/custom/";
const port = Number(process.env.PORT ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
  ".webp": "image/webp",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

function safeJoin(root, pathname) {
  const clean = normalize(pathname).replace(/^([/\\])+/, "");
  const full = resolve(root, clean);
  return full.startsWith(root) ? full : null;
}

function resolveRequest(pathname) {
  if (pathname === "/" || pathname === "/experiments/bakeoff/custom") {
    return join(contenderRoot, "dist", "index.html");
  }
  if (pathname === pagePrefix || pathname === `${pagePrefix}index.html`) {
    return join(contenderRoot, "dist", "index.html");
  }
  if (pathname.startsWith(pagePrefix)) {
    const rest = pathname.slice(pagePrefix.length);
    for (const candidate of [
      join(contenderRoot, "dist", rest),
      join(contenderRoot, rest),
    ]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }
  return safeJoin(repoRoot, pathname);
}

const server = createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400, isolation).end("bad request");
    return;
  }
  const file = resolveRequest(pathname);
  if (file === null || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, isolation).end(`not found: ${pathname}`);
    return;
  }
  response.writeHead(200, {
    ...isolation,
    "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`custom contender: http://127.0.0.1:${port}${pagePrefix}`);
  console.log(`shared assets:   http://127.0.0.1:${port}/experiments/bakeoff/assets/`);
});

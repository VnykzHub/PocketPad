/**
 * Controller build served through the real dev server (D0 controller review).
 *
 * The controller is mounted at `/c/`, so its document must reference
 * `/c/assets/...` and must carry no inline `<style>`: the dev CSP is
 * `style-src 'self'`. This suite builds the controller the same way
 * `npm run build --workspace @lanpad/controller` does, then boots the default
 * dev server and fetches every script/stylesheet URL from the served shell.
 *
 * Building here (rather than assuming a prior build) keeps the suite valid
 * under `npm run check`, which runs tests before the workspace builds.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Logger } from "@lanpad/broker";
import { createDevServer, defaultConfig, type DevServer } from "../src/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const controllerDist = join(repoRoot, "packages/controller/dist");

const silentLogger: Logger = { info() {} };

let app: DevServer | null = null;
let base = "";

interface BuiltAssetRef {
  url: string;
  kind: "script" | "stylesheet";
}

/** Reads an attribute value from a single opening tag. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return match?.[1] ?? null;
}

/** Script `src` and stylesheet `href` URLs, in document order. */
function extractAssetRefs(html: string): BuiltAssetRef[] {
  const refs: BuiltAssetRef[] = [];

  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attribute(match[0], "src");
    if (src !== null) {
      refs.push({ url: src, kind: "script" });
    }
  }

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    const href = attribute(tag, "href");
    if (href !== null && rel.includes("stylesheet")) {
      refs.push({ url: href, kind: "stylesheet" });
    }
  }

  return refs;
}

function expectViteAssetUrl(ref: BuiltAssetRef): void {
  // Vite `base: "/c/"` + default `assetsDir: "assets"`.
  expect(ref.url, `${ref.kind} URL`).toMatch(/^\/c\/assets\/[\w-]+\.(js|css)$/);
  const expectedExtension = ref.kind === "script" ? ".js" : ".css";
  expect(ref.url.endsWith(expectedExtension), `${ref.kind} extension`).toBe(true);
}

beforeAll(async () => {
  execSync("npm run build --workspace @lanpad/controller", {
    cwd: repoRoot,
    stdio: "pipe",
    timeout: 120_000,
  });

  const config = defaultConfig(repoRoot);
  config.host = "127.0.0.1";
  config.port = 0;
  config.allowedOrigins = [];
  app = createDevServer(config, { logger: silentLogger });
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
}, 180_000);

afterAll(async () => {
  if (app !== null) {
    await app.close();
    app = null;
  }
});

describe("built controller served at /c/", () => {
  test("[FR-9.12] build output hashes CSS and keeps the tsc output", () => {
    // `emptyOutDir: false`: Vite must not delete the package API emit.
    for (const file of ["index.js", "index.d.ts", "route.js", "net/controllerClient.js"]) {
      expect(existsSync(join(controllerDist, file)), file).toBe(true);
    }

    const html = readFileSync(join(controllerDist, "index.html"), "utf8");
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toContain("/src/main.ts");

    const refs = extractAssetRefs(html);
    const scripts = refs.filter((ref) => ref.kind === "script");
    const styles = refs.filter((ref) => ref.kind === "stylesheet");
    expect(scripts).toHaveLength(1);
    expect(styles.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expectViteAssetUrl(ref);
    }

    // The stylesheet link points at a file Vite actually emitted.
    for (const ref of styles) {
      const fileName = ref.url.slice("/c/assets/".length);
      expect(existsSync(join(controllerDist, "assets", fileName)), fileName).toBe(true);
    }
  });

  test("[FR-9.12] /c/ABCD serves the built shell with no inline style", async () => {
    const response = await fetch(`${base}/c/ABCD`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const html = await response.text();
    expect(html).not.toMatch(/<style\b/i);
    const refs = extractAssetRefs(html);
    expect(refs.length).toBeGreaterThan(0);
  });

  test("[FR-9.12] every script and stylesheet URL resolves with 200 and the right type", async () => {
    const page = await fetch(`${base}/c/ABCD`);
    const refs = extractAssetRefs(await page.text());
    const scripts = refs.filter((ref) => ref.kind === "script");
    const styles = refs.filter((ref) => ref.kind === "stylesheet");
    expect(scripts.length).toBeGreaterThan(0);
    expect(styles.length).toBeGreaterThan(0);

    for (const ref of refs) {
      expectViteAssetUrl(ref);
      const response = await fetch(`${base}${ref.url}`);
      expect(response.status, `${ref.kind} ${ref.url}`).toBe(200);

      const contentType = response.headers.get("content-type") ?? "";
      if (ref.kind === "script") {
        expect(contentType, `${ref.url} content type`).toMatch(/javascript/);
      } else {
        expect(contentType, `${ref.url} content type`).toContain("text/css");
      }

      const body = await response.arrayBuffer();
      expect(body.byteLength, `${ref.url} body`).toBeGreaterThan(0);
    }
  });
});

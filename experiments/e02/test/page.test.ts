import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relativeToThisFile: string): string {
  return readFileSync(new URL(relativeToThisFile, import.meta.url), "utf8");
}

const indexHtml = read("../index.html");
const probeTs = read("../probe.ts");
const probeJs = read("../probe.js");
const stopConditionsTs = read("../stop-conditions.ts");
const stopConditionsJs = read("../stop-conditions.js");

describe("[E2] memory ceiling page", () => {
  it("[E2] the page warns before a run and starts only from the Run button", () => {
    expect(indexHtml).toContain(
      "This test allocates memory until the browser slows or crashes. Close other tabs. It may reload the page.",
    );

    for (const id of [
      "run",
      "stop",
      "safe-mode",
      "copy",
      "status",
      "log",
      "results",
      "steps",
      "json",
      "previous",
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
    }

    expect(indexHtml).toContain('type="module"');
    expect(indexHtml).toContain('src="./probe.js"');
    // Only the external module may run: no inline script can auto-start a run.
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    // The module calls runProbe exactly once, from the Run click handler.
    expect(probeTs.match(/void runProbe\(\)/g)).toHaveLength(1);
    expect(probeTs).toContain('runButton.addEventListener("click"');
  });

  it("[E2] the page allocates in 32 MB blocks, touches every page and allocates textures", () => {
    expect(probeTs).toContain("new Uint8Array(JS_BLOCK_BYTES)");
    expect(probeTs).toContain("block.fill(");
    expect(probeTs).toContain("measureFrames(BENCHMARK_FRAME_COUNT)");
    expect(probeTs).toContain("TEXTURE_SIZE");
    expect(probeTs).toContain("gl.RGBA8");
    expect(probeTs).toContain('"webglcontextlost"');
    expect(probeTs).toContain("safeMode");
    expect(probeTs).toContain("stopRequested");
  });
});

describe("[SR-7] memory results stay on the device", () => {
  const files: ReadonlyArray<readonly [string, string]> = [
    ["index.html", indexHtml],
    ["probe.ts", probeTs],
    ["probe.js", probeJs],
    ["stop-conditions.ts", stopConditionsTs],
    ["stop-conditions.js", stopConditionsJs],
  ];

  it("[SR-7] the memory probe makes no network requests", () => {
    const networkPatterns = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bsendBeacon\b/,
      /\bnew\s+WebSocket\b/,
      /\bEventSource\b/,
    ];

    for (const [name, text] of files) {
      for (const pattern of networkPatterns) {
        expect(text, `${name} matches ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("[SR-7] the probe loads no external origin and writes no cookie", () => {
    for (const [name, text] of files) {
      expect(text, `${name} loads an external href`).not.toMatch(
        /(?:href|src)\s*=\s*["']https?:\/\//i,
      );
      expect(text, `${name} loads an external CSS URL`).not.toMatch(
        /url\(\s*["']?https?:\/\//i,
      );
      expect(text, `${name} writes a cookie`).not.toMatch(/document\.cookie/);
    }
  });

  it("[SR-7] crash recovery uses session storage only", () => {
    expect(probeTs).toContain("sessionStorage");
    expect(probeTs).not.toContain("localStorage");
    expect(probeTs).not.toContain("indexedDB");
  });
});

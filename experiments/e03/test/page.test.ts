// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { benchElementsFromDocument, mountBenchPage } from "../bench.ts";

function read(relativeToThisFile: string): string {
  return readFileSync(new URL(relativeToThisFile, import.meta.url), "utf8");
}

const indexHtml = read("../index.html");
const benchCss = read("../bench.css");
const benchTs = read("../bench.ts");
const benchJs = read("../bench.js");
const statsTs = read("../stats.ts");
const statsJs = read("../stats.js");

function buildPage(): void {
  document.body.innerHTML = `
    <button id="run" type="button">Run benchmark</button>
    <button id="stop" type="button" disabled>Stop</button>
    <button id="copy" type="button" disabled>Copy JSON</button>
    <p id="status">Not run.</p>
    <p id="gpu">WebGL2: not checked.</p>
    <canvas id="canvas" width="1280" height="720"></canvas>
    <table id="results"></table>
    <pre id="json">Not run.</pre>
  `;
}

describe("[E3] benchmark page", () => {
  it("[E3] exposes the standard Run, Stop, table, canvas and copyable JSON pattern", () => {
    expect(indexHtml).toContain("<h1>E3 - TV render benchmark</h1>");
    expect(indexHtml).toContain('id="run"');
    expect(indexHtml).toContain('id="stop"');
    expect(indexHtml).toContain('id="copy"');
    expect(indexHtml).toContain('id="results"');
    expect(indexHtml).toContain('id="canvas"');
    expect(indexHtml).toContain('id="json"');
    expect(indexHtml).toContain('type="module"');
    expect(indexHtml).toContain('src="./bench.js"');

    // One external module script and no inline script or style blocks.
    const scripts = indexHtml.match(/<script\b/gi) ?? [];
    expect(scripts).toHaveLength(1);
    expect(indexHtml).not.toMatch(/<style\b/i);
  });

  it("[E3] never auto-runs: mounting attaches listeners without creating a WebGL context", () => {
    buildPage();
    const elements = benchElementsFromDocument(document);
    expect(elements).not.toBeNull();
    if (elements === null) return;

    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    try {
      mountBenchPage(elements);

      expect(getContext).not.toHaveBeenCalled();
      expect(elements.tableHost.rows).toHaveLength(0);
      expect(elements.copyButton.disabled).toBe(true);
      expect(elements.stopButton.disabled).toBe(true);
      expect(elements.jsonHost.textContent).toBe("Not run.");
    } finally {
      getContext.mockRestore();
    }
  });

  it("[E3] the page module is loaded only after the DOM exists", () => {
    expect(benchTs).toContain("document.readyState === \"loading\"");
    expect(benchTs).toContain("mountBenchPage");
    expect(benchJs).toContain("mountBenchPage");
  });
});

describe("[SR-7] E3 probe stays local", () => {
  const codeFiles: ReadonlyArray<readonly [string, string]> = [
    ["e03/index.html", indexHtml],
    ["e03/bench.css", benchCss],
    ["e03/bench.ts", benchTs],
    ["e03/bench.js", benchJs],
    ["e03/stats.ts", statsTs],
    ["e03/stats.js", statsJs],
  ];

  it("[SR-7] probe pages make no network requests except the dev server", () => {
    const networkPatterns = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bsendBeacon\b/,
      /\bnew\s+WebSocket\b/,
      /\bEventSource\b/,
    ];

    for (const [name, text] of codeFiles) {
      for (const pattern of networkPatterns) {
        expect(text, `${name} matches ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("[SR-7] probe pages load no external origin or tracker", () => {
    for (const [name, text] of codeFiles) {
      expect(text, `${name} loads an external href`).not.toMatch(
        /(?:href|src)\s*=\s*["']https?:\/\//i,
      );
      expect(text, `${name} loads an external CSS URL`).not.toMatch(
        /url\(\s*["']?https?:\/\//i,
      );
    }
  });
});

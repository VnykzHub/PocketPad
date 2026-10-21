import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relativeToThisFile: string): string {
  return readFileSync(new URL(relativeToThisFile, import.meta.url), "utf8");
}

const indexHtml = read("../../index.html");
const fixtureHtml = read("../fixtures/webgl2-failure/index.html");
const fixtureJs = read("../fixtures/webgl2-failure/fixture.js");

describe("[E1] experiments index", () => {
  it("[E1] experiments index links every planned probe", () => {
    const planned = [
      ["E1", "./e01/"],
      ["E2", "./e02/"],
      ["E3", "./e03/"],
      ["E14", "./e14/"],
    ] as const;

    for (const [id, href] of planned) {
      const item = new RegExp(
        `<li data-experiment="${id}">([\\s\\S]*?)</li>`,
      ).exec(indexHtml);
      expect(item, `missing list item for ${id}`).not.toBeNull();
      const block = item?.[1] ?? "";
      expect(block).toContain(`href="${href}"`);
      expect(block).toMatch(/<p class="description">[\s\S]+?<\/p>/);
    }

    // The index is static: it cannot run a probe by accident.
    expect(indexHtml).not.toMatch(/<script\b/i);
  });

  it("[E1] fixture page provides the standard title, Run, table and Copy JSON pattern", () => {
    expect(fixtureHtml).toContain("<h1>WebGL2 failure display fixture</h1>");
    expect(fixtureHtml).toContain('id="run"');
    expect(fixtureHtml).toContain('id="copy"');
    expect(fixtureHtml).toContain('id="results"');
    expect(fixtureHtml).toContain('id="json"');
    expect(fixtureHtml).toContain('type="module"');
    expect(fixtureHtml).toContain('src="./fixture.js"');
  });

  it("[E1] fixture intentionally throws a WebGL2 context error through the shared runner", () => {
    expect(fixtureJs).toContain("detectWebGL2");
    expect(fixtureJs).toContain("Intentional WebGL2 context failure");
    expect(fixtureJs).toContain("mountProbePage");
  });
});

describe("[SR-7] probe pages stay local", () => {
  const codeFiles: ReadonlyArray<readonly [string, string]> = [
    ["index.html", indexHtml],
    ["fixture/index.html", fixtureHtml],
    ["fixture/fixture.js", fixtureJs],
    ["report.ts", read("../report.ts")],
    ["report.js", read("../report.js")],
    ["probe.ts", read("../probe.ts")],
    ["probe.js", read("../probe.js")],
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

/**
 * D5-SEC-01 hostile-payload suite (SR-13, SR-7, FR-7.9).
 *
 * jsdom executes this suite. Every payload is injected through the same
 * entry points production uses (safeRender helpers, the panel/text/choice
 * renderers) and must either render as inert text or be rejected before it
 * reaches the DOM. The final test greps controller and runtime source so the
 * banned HTML-string APIs cannot return.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChoiceControl, JsonValue, PanelControl, TextControl } from "@lanpad/sdk";
import { InputStore } from "../src/input/InputStore.js";
import type { ControlContext, ControlRenderer } from "../src/controls/control.js";
import { createChoiceControl } from "../src/controls/choice.js";
import { createPanelControl, type PanelRenderer } from "../src/controls/panel.js";
import { createTextControl } from "../src/controls/text.js";
import {
  appendSafeImage,
  applySafeColor,
  safeColor,
  setSafeText,
} from "../src/render/safeRender.js";

const SURFACE = { width: 800, height: 400 };

const HOSTILE_PAYLOADS = [
  "<img src=x onerror=alert(1)>",
  '"><script>alert(1)</script>',
  "<script>alert(document.cookie)</script>",
  "javascript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  "expression(alert(1))",
  "#fff; background: url(//evil.example/x)",
] as const;

class RecordingSink {
  readonly events: Array<{ name: string; data: JsonValue }> = [];

  enqueue(name: string, data: JsonValue): void {
    this.events.push({ name, data });
  }
}

function freshContext(events?: RecordingSink): ControlContext {
  return {
    input: new InputStore(),
    surfaceSize: SURFACE,
    ...(events === undefined ? {} : { events }),
  };
}

function part(renderer: ControlRenderer, name: string): HTMLElement {
  const element = renderer.element.querySelector<HTMLElement>(`[data-part="${name}"]`);
  if (element === null) {
    throw new Error(`renderer ${renderer.id} has no [data-part="${name}"]`);
  }
  return element;
}

function panelRenderer(): PanelRenderer {
  const control: PanelControl = {
    type: "panel",
    id: "panel",
    x: "50%",
    y: "50%",
    w: "80%",
    h: "60%",
  };
  return createPanelControl(control, freshContext());
}

function expectNoMarkup(container: ParentNode): void {
  expect(container.querySelector("script, iframe, object, embed")).toBeNull();
}

describe("[SR-13] safeRender text boundaries", () => {
  it("[SR-13] hostile payloads are assigned as inert text", () => {
    for (const payload of HOSTILE_PAYLOADS) {
      const host = document.createElement("div");
      expect(setSafeText(host, payload, 1_000), payload).toBe(payload);
      expect(host.textContent, payload).toBe(payload);
      expect(host.children, payload).toHaveLength(0);
      expect(host.querySelector("img, script, iframe"), payload).toBeNull();
    }
  });

  it("[SR-13] strips control characters, truncates oversized text and rejects non-strings", () => {
    const host = document.createElement("div");

    expect(setSafeText(host, "a\u0000b\u0007c\u007fd", 100)).toBe("abcd");
    expect(host.textContent).toBe("abcd");

    expect(setSafeText(host, "x".repeat(10_000), 64)).toHaveLength(64);
    expect(host.textContent).toHaveLength(64);

    expect(setSafeText(host, 42, 100)).toBe("");
    expect(setSafeText(host, undefined, 100)).toBe("");
    expect(host.textContent).toBe("");
  });
});

describe("[SR-13] safeRender image allowlist", () => {
  it("[SR-13] rejects javascript, remote, blob, protocol-relative and HTML data URLs", () => {
    const host = document.createElement("div");
    const rejected = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "https://evil.example/x.png",
      "http://evil.example/x.png",
      "//evil.example/x.png",
      "blob:http://evil.example/x",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pjwvc2NyaXB0Pjwvc3ZnPg==",
      `data:image/png;base64,${"A".repeat(2_048)}`,
      "",
    ];

    for (const src of rejected) {
      expect(appendSafeImage(host, src), src).toBeNull();
    }
    expect(host.children).toHaveLength(0);
  });

  it("[SR-13] accepts same-origin paths and bounded base64 PNG/JPEG/WebP data URIs", () => {
    const host = document.createElement("div");
    const image = appendSafeImage(host, "assets/pic.png", "<b>alt</b>", "cover");

    expect(image).not.toBeNull();
    expect(host.querySelector("img")).toBe(image);
    expect(image?.getAttribute("src")).toBe("assets/pic.png");
    // Alt text is inert data, controls stripped, never markup.
    expect(image?.alt).toBe("<b>alt</b>");
    expect(image?.style.objectFit).toBe("cover");

    const dataImage = appendSafeImage(host, "data:image/png;base64,iVBORw0KGgo=");
    expect(dataImage?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");

    // A hostile `fit` value is ignored, not copied into style.
    const fitIgnored = appendSafeImage(host, "assets/pic.png", "pic", "url(javascript:alert(1))");
    expect(fitIgnored?.style.objectFit).toBe("");
  });
});

describe("[SR-13] colour validation", () => {
  it("[SR-13] accepts only #rgb and #rrggbb and falls back safely", () => {
    expect(safeColor("#abc")).toBe("#abc");
    expect(safeColor("#AABBCC")).toBe("#AABBCC");

    for (const hostile of [
      "expression(alert(1))",
      "javascript:alert(1)",
      "red",
      "rgb(0, 0, 0)",
      "#ffff",
      "#fff; background: url(//evil.example/x)",
      "url(//evil.example/x)",
      "var(--accent)",
    ]) {
      expect(safeColor(hostile, "#000"), hostile).toBe("#000");
    }

    // An invalid fallback still cannot reach CSS.
    expect(safeColor("expression(alert(1))", "url(evil)")).toBe("#ffffff");
  });

  it("[SR-13] applySafeColor never writes an unvalidated string to style", () => {
    const host = document.createElement("div");
    applySafeColor(host, "color", "expression(alert(1))", "#123456");

    expect(host.style.color).not.toBe("");
    expect(host.style.color.toLowerCase()).not.toContain("expression");
    expect(host.getAttribute("style") ?? "").not.toContain("url(");
  });
});

describe("[SR-13] panel renderer hostile content", () => {
  it("[SR-13] renders hostile text and list items as inert text", () => {
    const renderer = panelRenderer();
    try {
      renderer.setContent({
        kind: "text",
        title: "<b>Title</b>",
        text: '<img src=x onerror=alert(1)>',
      });

      expectNoMarkup(renderer.element);
      expect(renderer.element.querySelector("img, b")).toBeNull();
      expect(part(renderer, "panel-title").textContent).toBe("<b>Title</b>");
      expect(part(renderer, "panel-text").textContent).toBe('<img src=x onerror=alert(1)>');

      renderer.setContent({
        kind: "blocks",
        blocks: [
          { type: "heading", text: "<h1>Heading</h1>" },
          { type: "paragraph", text: "<script>alert(1)</script>" },
          { type: "list", items: ["<em>one</em>", '"><script>alert(2)</script>'] },
        ],
      });

      expectNoMarkup(renderer.element);
      expect(renderer.element.querySelector("h1, em")).toBeNull();
      const items = renderer.element.querySelectorAll('[data-part="block-list"] li');
      expect(items).toHaveLength(2);
      expect(items[0]?.textContent).toBe("<em>one</em>");
      expect(items[1]?.textContent).toBe('"><script>alert(2)</script>');
    } finally {
      renderer.dispose();
    }
  });

  it("[SR-13] rejects hostile image sources and oversized content before render", () => {
    const renderer = panelRenderer();
    try {
      for (const src of [
        "javascript:alert(1)",
        "https://evil.example/x.png",
        "//evil.example/x.png",
        "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
        "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      ]) {
        renderer.setContent({ kind: "image", src });
        expect(renderer.element.querySelector("img"), src).toBeNull();
        expect(part(renderer, "placeholder").textContent).toBe("Panel content unavailable");
        expect(renderer.element.dataset["invalidPanel"]).toBe("true");
      }

      renderer.setContent({ kind: "text", text: "x".repeat(5_000) });
      expect(part(renderer, "placeholder").textContent).toBe("Panel content unavailable");
      expect(renderer.element.querySelector('[data-part="panel-text"]')).toBeNull();

      renderer.setContent({ kind: "image", src: "data:image/png;base64,iVBORw0KGgo=" });
      expect(renderer.element.querySelector("img")).not.toBeNull();
    } finally {
      renderer.dispose();
    }
  });

  it("[SR-7] panel content is never persisted, logged or fetched", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const renderer = panelRenderer();
    try {
      renderer.setContent({
        kind: "text",
        title: "Secret",
        text: '<img src=x onerror=alert(1)>',
      });
      renderer.setContent({ kind: "image", src: "javascript:alert(1)" });

      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      renderer.dispose();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});

describe("[SR-13] choice renderer hostile labels", () => {
  it("[SR-13] option labels are inert text, never markup", () => {
    const control: ChoiceControl = {
      type: "choice",
      id: "pick",
      x: "50%",
      y: "50%",
      w: "80%",
      h: "50%",
      event: "pick",
      options: [
        { value: "a", label: "<b>Alpha</b>" },
        { value: "b", label: '<img src=x onerror=alert(1)>' },
        { value: "c", label: '"><script>alert(2)</script>' },
      ],
    };
    const renderer = createChoiceControl(control, freshContext());
    try {
      expectNoMarkup(renderer.element);
      expect(renderer.element.querySelector("b, img")).toBeNull();
      const rows = renderer.element.querySelectorAll('[data-part="option"]');
      expect(rows).toHaveLength(3);
      expect(rows[0]?.textContent).toBe("<b>Alpha</b>");
      expect(rows[1]?.textContent).toBe('<img src=x onerror=alert(1)>');
      expect(rows[2]?.textContent).toBe('"><script>alert(2)</script>');
    } finally {
      renderer.dispose();
    }
  });
});

describe("[SR-13] text renderer hostile input", () => {
  it("[SR-13] submitted text is sent as inert data and never parsed as markup", () => {
    const sink = new RecordingSink();
    const control: TextControl = {
      type: "text",
      id: "answer",
      x: "50%",
      y: "80%",
      w: "80%",
      h: "12%",
      event: "answer",
      maxLen: 200,
    };
    const renderer = createTextControl(control, freshContext(sink));
    try {
      const input = renderer.element.querySelector("input");
      if (input === null) {
        throw new Error("text renderer is missing its input");
      }
      const payload = '<img src=x onerror=alert(1)>';
      input.value = payload;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(sink.events).toEqual([{ name: "answer", data: { value: payload } }]);
      expect(renderer.element.querySelector("img, script")).toBeNull();
      expect(part(renderer, "send").textContent).toBe("Send");
    } finally {
      renderer.dispose();
    }
  });
});

const BANNED_SOURCE_APIS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "innerHTML", pattern: /\.innerHTML\b/ },
  { label: "outerHTML", pattern: /\.outerHTML\b/ },
  { label: "insertAdjacentHTML", pattern: /\.insertAdjacentHTML\b/ },
  { label: "document.write", pattern: /document\.write(?:ln)?\s*\(/ },
  { label: "srcdoc", pattern: /\bsrcdoc\b/ },
  { label: "eval", pattern: /\beval\s*\(/ },
  { label: "new Function", pattern: /\bnew\s+Function\s*\(/ },
  { label: "dynamic script creation", pattern: /createElement\s*\(\s*["'`]script["'`]\s*\)/ },
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".html"]);

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

/** Locates `packages/controller` from the Vitest working directory. */
function findControllerRoot(): string {
  const workingDirectory = process.cwd();
  const candidates = [
    workingDirectory,
    join(workingDirectory, "packages", "controller"),
    join(workingDirectory, "..", "controller"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "src", "controls", "panel.ts"))) {
      return candidate;
    }
  }
  throw new Error(`cannot locate packages/controller from ${workingDirectory}`);
}

describe("[SR-13] source hygiene", () => {
  it("[SR-13] controller and runtime source never use HTML-string or eval APIs", () => {
    const controllerRoot = findControllerRoot();
    const repositoryRoot = join(controllerRoot, "..", "..");
    const sourceRoots = [
      join(controllerRoot, "src"),
      join(controllerRoot, "..", "runtime", "src"),
    ];

    const offences: string[] = [];
    for (const sourceRoot of sourceRoots) {
      for (const file of sourceFiles(sourceRoot)) {
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          for (const banned of BANNED_SOURCE_APIS) {
            if (banned.pattern.test(line)) {
              offences.push(
                `${relative(repositoryRoot, file)}:${index + 1} uses ${banned.label}`,
              );
            }
          }
        }
      }
    }

    expect(offences).toEqual([]);
  });
});

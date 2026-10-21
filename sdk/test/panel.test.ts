import { describe, expect, test } from "vitest";
import {
  MAX_PANEL_CONTENT_BYTES,
  validatePanelContent,
} from "../src/panel";

/**
 * D5-SDK-01 panel content coverage: the three panel kinds, every block type,
 * all size limits, control-character rejection and the SR-13 image-source
 * boundary. Panel content is data-only; there is no HTML kind or HTML field
 * path to exercise.
 */

type UnknownRecord = Record<string, unknown>;

const IMAGE_SRC_ERROR =
  "must be a same-origin relative path or a data:image/(png|jpeg|webp);base64 URI";

function expectErrors(value: unknown): string[] {
  const result = validatePanelContent(value);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

function textPanel(text: string, extra: UnknownRecord = {}): UnknownRecord {
  return { kind: "text", text, ...extra };
}

function blocksPanel(blocks: unknown[]): UnknownRecord {
  return { kind: "blocks", blocks };
}

function imagePanel(src: string, extra: UnknownRecord = {}): UnknownRecord {
  return { kind: "image", src, ...extra };
}

/**
 * Builds block panel content whose JSON serialization is exactly `bytes`
 * UTF-8 bytes. Each paragraph is at most 1000 characters, so eight blocks
 * provide enough safe padding for the 3584-byte boundary.
 */
function panelOfByteSize(bytes: number): UnknownRecord {
  const blocks: Array<{ type: "paragraph"; text: string }> = Array.from(
    { length: 8 },
    () => ({ type: "paragraph", text: "" }),
  );
  const panel = blocksPanel(blocks);
  const base = Buffer.byteLength(JSON.stringify(panel), "utf8");
  if (bytes < base) {
    throw new Error(`requested size ${bytes} is below the ${base}-byte base panel`);
  }

  let remaining = bytes - base;
  for (const block of blocks) {
    if (remaining === 0) {
      break;
    }
    const chunk = Math.min(1_000, remaining);
    block.text = "x".repeat(chunk);
    remaining -= chunk;
  }
  if (remaining > 0) {
    throw new Error(`panelOfByteSize(${bytes}) exceeds the fixture capacity`);
  }

  expect(Buffer.byteLength(JSON.stringify(panel), "utf8")).toBe(bytes);
  return panel;
}

describe("validatePanelContent (D5-SDK-01)", () => {
  test("[FR-8.1] accepts text, blocks and image panel content", () => {
    const text = textPanel("The secret word is LANTERN.", { title: "Your role" });
    const blocks = blocksPanel([
      { type: "heading", text: "Manual" },
      { type: "paragraph", text: "Page one of the bomb manual." },
      { type: "list", items: ["Red wire", "Blue wire"] },
      { type: "image", src: "assets/manual/page-1.png", alt: "Wiring diagram" },
    ]);
    const image = imagePanel("assets/roles/spy.webp", {
      alt: "Your role card",
      fit: "cover",
    });

    for (const [label, panel] of [
      ["text", text],
      ["blocks", blocks],
      ["image", image],
    ] as const) {
      const result = validatePanelContent(panel);
      expect(result.ok, label).toBe(true);
      if (result.ok) {
        expect(result.content).toBe(panel as never);
      }
    }
  });

  test("[FR-8.1] accepts every block type with optional fields", () => {
    const panel = blocksPanel([
      { type: "heading", text: "Heading" },
      { type: "paragraph", text: "Paragraph" },
      { type: "list", items: [] },
      { type: "image", src: "/shared/card.jpg", alt: "Card" },
      { type: "image", src: "data:image/png;base64,iVBORw0KGgo=" },
    ]);

    expect(validatePanelContent(panel).ok).toBe(true);
    expect(validatePanelContent(textPanel("body")).ok).toBe(true);
    expect(
      validatePanelContent(imagePanel("data:image/webp;base64,UklGRg==", { fit: "contain" })).ok,
    ).toBe(true);
  });

  test("[FR-8.4] rejects unknown kinds and block types", () => {
    const cases: Array<[string, unknown, string]> = [
      ["a null root", null, "panel: must be an object"],
      ["an array root", [], "panel: must be an object"],
      ["a string root", "text", "panel: must be an object"],
      ["a missing kind", {}, "kind: required"],
      ["a non-string kind", { kind: 7 }, "kind: must be a string"],
      [
        "an HTML kind",
        { kind: "html", html: "<script>alert(1)</script>" },
        'kind: must be one of "text", "blocks", "image"',
      ],
      [
        "an HTML block type",
        blocksPanel([{ type: "html", html: "<img src=x onerror=alert(1)>" }]),
        'blocks[0].type: must be one of "heading", "paragraph", "list", "image"',
      ],
      ["an unknown block type", blocksPanel([{ type: "video" }]), "blocks[0].type: must be one of"],
      ["a missing block type", blocksPanel([{}]), "blocks[0].type: required"],
      ["a non-object block", blocksPanel([null]), "blocks[0]: must be an object"],
      ["a missing blocks array", { kind: "blocks" }, "blocks: required"],
      ["a non-array blocks field", { kind: "blocks", blocks: "x" }, "blocks: must be an array"],
      ["a missing image src", { kind: "image" }, "src: required"],
      ["a non-string image src", imagePanel(7 as unknown as string), "src: must be a string"],
      [
        "an invalid image fit",
        imagePanel("assets/card.png", { fit: "stretch" }),
        'fit: must be one of "contain", "cover"',
      ],
      [
        "a non-string image alt",
        imagePanel("assets/card.png", { alt: 7 }),
        "alt: must be a string",
      ],
    ];

    for (const [label, panel, expected] of cases) {
      expect(expectErrors(panel).some((error) => error.includes(expected)), label).toBe(true);
    }
  });

  test("[SR-13] rejects hostile panel image URLs", () => {
    const hostile = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "https://evil.example/x.png",
      "http://evil.example/x.png",
      "//evil.example/x.png",
      "\\\\evil.example\\x.png",
      "blob:http://evil.example/x",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pjwvc2NyaXB0Pjwvc3ZnPg==",
      "data:image/png;base64,",
      "data:image/png;base64,abc",
      "data:image/png;base64,@@@@",
      "data:image/png;charset=utf-8;base64,iVBORw0KGgo=",
      "assets/evil\u0000.png",
      "assets/evil x.png",
      "assets\\evil.png",
      "assets/<evil>.png",
      'assets/"evil".png',
      "file:///etc/passwd",
      "ftp://evil.example/x.png",
    ];

    for (const src of hostile) {
      const panelErrors = expectErrors(imagePanel(src));
      expect(panelErrors, src).toEqual([`src: ${IMAGE_SRC_ERROR}`]);

      const blockErrors = expectErrors(blocksPanel([{ type: "image", src }]));
      expect(blockErrors, src).toEqual([`blocks[0].src: ${IMAGE_SRC_ERROR}`]);
    }
  });

  test("[SR-13] accepts only same-origin paths and base64 PNG/JPEG/WebP data URIs", () => {
    const allowed = [
      "assets/panel.png",
      "./img/x.webp",
      "/shared/a.jpg",
      "../a.png",
      "a.png?v=2#fragment",
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      "DATA:IMAGE/WEBP;BASE64,UklGRg==",
    ];

    for (const src of allowed) {
      expect(validatePanelContent(imagePanel(src)).ok, src).toBe(true);
    }

    expect(validatePanelContent(imagePanel("a".repeat(2_048))).ok).toBe(true);
    expect(expectErrors(imagePanel("a".repeat(2_049)))).toEqual([`src: ${IMAGE_SRC_ERROR}`]);
  });

  test("[SR-13] panel text is inert data and there is no HTML kind", () => {
    const payloads = [
      "<img src=x onerror=alert(1)>",
      '"><script>alert(1)</script>',
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
    ];

    for (const payload of payloads) {
      const panel = textPanel(payload, { html: "<script>alert(1)</script>" });
      const result = validatePanelContent(panel);
      expect(result.ok, payload).toBe(true);
      if (result.ok && result.content.kind === "text") {
        // The payload stays a string. Renderers must use textContent; there is
        // no HTML element/kind in the schema that could interpret it.
        expect(result.content.text).toBe(payload);
      }
    }

    const withHtmlExtra = validatePanelContent({
      kind: "text",
      text: "<b>ok</b>",
      innerHTML: "<script>",
    });
    expect(withHtmlExtra.ok).toBe(true);
    expect(expectErrors({ kind: "html", html: "<b>ok</b>" })).toEqual([
      'kind: must be one of "text", "blocks", "image"',
    ]);
  });

  test("[SR-13] rejects control characters but keeps tab, line feed and carriage return", () => {
    const message =
      "text: must not contain control characters other than tab, line feed and carriage return";

    for (const control of ["\u0000", "\u0007", "\u000b", "\u001f", "\u007f", "\u009b"]) {
      expect(expectErrors(textPanel(`a${control}b`)), JSON.stringify(control)).toEqual([message]);
    }

    expect(validatePanelContent(textPanel("line one\nline two\ttabbed\r")).ok).toBe(true);
    expect(expectErrors(textPanel("ok", { title: "bad\u0007title" }))).toEqual([
      "title: must not contain control characters other than tab, line feed and carriage return",
    ]);
    expect(
      expectErrors(blocksPanel([{ type: "paragraph", text: "bad\u009b" }])),
    ).toEqual([
      "blocks[0].text: must not contain control characters other than tab, line feed and carriage return",
    ]);
    expect(expectErrors(blocksPanel([{ type: "list", items: ["ok", "bad\u0007"] }]))).toEqual([
      "blocks[0].items[1]: must not contain control characters other than tab, line feed and carriage return",
    ]);
  });

  test("[FR-8.4] enforces every panel content limit", () => {
    const cases: Array<[string, UnknownRecord, string]> = [
      ["title at 80", textPanel("x", { title: "t".repeat(80) }), ""],
      [
        "title over 80",
        textPanel("x", { title: "t".repeat(81) }),
        "title: must be at most 80 characters (got 81)",
      ],
      ["text at 1000", textPanel("x".repeat(1_000)), ""],
      [
        "text over 1000",
        textPanel("x".repeat(1_001)),
        "text: must be at most 1000 characters (got 1001)",
      ],
      [
        "20 blocks",
        blocksPanel(Array.from({ length: 20 }, () => ({ type: "paragraph", text: "x" }))),
        "",
      ],
      [
        "21 blocks",
        blocksPanel(Array.from({ length: 21 }, () => ({ type: "paragraph", text: "x" }))),
        "blocks: must contain at most 20 entries (got 21)",
      ],
      [
        "12 list items",
        blocksPanel([{ type: "list", items: Array.from({ length: 12 }, () => "x") }]),
        "",
      ],
      [
        "13 list items",
        blocksPanel([{ type: "list", items: Array.from({ length: 13 }, () => "x") }]),
        "blocks[0].items: must contain at most 12 entries (got 13)",
      ],
      [
        "120-character list item",
        blocksPanel([{ type: "list", items: ["x".repeat(120)] }]),
        "",
      ],
      [
        "121-character list item",
        blocksPanel([{ type: "list", items: ["x".repeat(121)] }]),
        "blocks[0].items[0]: must be at most 120 characters (got 121)",
      ],
      ["alt at 120", imagePanel("a.png", { alt: "a".repeat(120) }), ""],
      [
        "alt over 120",
        imagePanel("a.png", { alt: "a".repeat(121) }),
        "alt: must be at most 120 characters (got 121)",
      ],
    ];

    for (const [label, panel, expected] of cases) {
      const result = validatePanelContent(panel);
      if (expected === "") {
        expect(result.ok, label).toBe(true);
      } else {
        expect(result.ok, label).toBe(false);
        if (!result.ok) {
          expect(result.errors, label).toContain(expected);
        }
      }
    }
  });

  test("[FR-8.4] enforces the serialized panel byte budget", () => {
    expect(validatePanelContent(panelOfByteSize(MAX_PANEL_CONTENT_BYTES)).ok).toBe(true);

    const over = validatePanelContent(panelOfByteSize(MAX_PANEL_CONTENT_BYTES + 1));
    expect(over).toEqual({
      ok: false,
      errors: [
        `panel: serialized size ${MAX_PANEL_CONTENT_BYTES + 1} bytes exceeds the ${MAX_PANEL_CONTENT_BYTES}-byte limit`,
      ],
    });

    expect(validatePanelContent({ kind: "text", text: "x", extra: 1n })).toEqual({
      ok: false,
      errors: ["panel: must be JSON-serializable"],
    });
  });

  test("[FR-8.4] reports every error in one pass", () => {
    const errors = expectErrors(
      blocksPanel([
        { type: "paragraph", text: "x".repeat(1_001) },
        { type: "list", items: ["ok", 42] },
        { type: "image", src: "javascript:alert(1)", alt: 7 },
        { type: "html" },
      ]),
    );

    for (const prefix of [
      "blocks[0].text:",
      "blocks[1].items[1]:",
      "blocks[2].src:",
      "blocks[2].alt:",
      "blocks[3].type:",
    ]) {
      expect(errors.some((error) => error.startsWith(prefix)), prefix).toBe(true);
    }
  });

  test("[FR-8.4] error strings are stable and field-addressed", () => {
    expect(expectErrors({})).toEqual(["kind: required"]);
    expect(expectErrors({ kind: "html" })).toEqual([
      'kind: must be one of "text", "blocks", "image"',
    ]);
    expect(expectErrors({ kind: "text" })).toEqual(["text: required"]);
    expect(expectErrors({ kind: "text", text: 7 })).toEqual(["text: must be a string"]);
    expect(expectErrors({ kind: "blocks", blocks: [{ type: "list" }] })).toEqual([
      "blocks[0].items: required",
    ]);
    expect(expectErrors(imagePanel("javascript:alert(1)"))).toEqual([`src: ${IMAGE_SRC_ERROR}`]);
  });

  test("[FR-8.3] panel validation is DOM-free and does not mutate its input", () => {
    const panel = blocksPanel([
      { type: "heading", text: "Heading" },
      { type: "image", src: "assets/x.png" },
    ]);
    const snapshot = JSON.stringify(panel);

    const throwOnDomAccess = (): never => {
      throw new Error("SDK panel validator must not access the DOM");
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      get: throwOnDomAccess,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      get: throwOnDomAccess,
    });

    try {
      const result = validatePanelContent(panel);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.content).toBe(panel as never);
      }
      expect(JSON.stringify(panel)).toBe(snapshot);
    } finally {
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "window");
    }
  });
});

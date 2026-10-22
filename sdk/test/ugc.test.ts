import { describe, expect, test } from "vitest";
import {
  MAX_PLAYER_NAME_CHARS,
  isAllowedColor,
  isAllowedImageSrc,
  isValidEventName,
  normalizeStrokePoint,
  sanitizePlayerName,
  sanitizeText,
} from "../src/ugc";

/**
 * D5-SDK-01 UGC helper coverage: control-character stripping, code-point
 * truncation, image-source allowlisting, the shared event-name pattern and
 * normalized stroke points (SR-13, FR-8.1).
 */

describe("sanitizeText (D5-SDK-01)", () => {
  test("[SR-13] strips C0/C1 controls and keeps tab, line feed and carriage return", () => {
    for (let code = 0; code <= 0x1f; code += 1) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) {
        continue;
      }
      expect(
        sanitizeText(`a${String.fromCharCode(code)}b`, 10),
        `U+${code.toString(16).padStart(4, "0")}`,
      ).toBe("ab");
    }
    for (const code of [0x7f, 0x80, 0x9b, 0x9f]) {
      expect(sanitizeText(`a${String.fromCharCode(code)}b`, 10)).toBe("ab");
    }

    expect(sanitizeText("line1\nline2\ttabbed\r", 100)).toBe("line1\nline2\ttabbed\r");
    expect(sanitizeText("<img src=x onerror=alert(1)>", 100)).toBe(
      "<img src=x onerror=alert(1)>",
    );
    expect(sanitizeText(42, 100)).toBe("");
    expect(sanitizeText(undefined, 100)).toBe("");
    expect(sanitizeText({ toString: () => "no" }, 100)).toBe("");
  });

  test("[SR-13] truncates by Unicode code point after stripping controls", () => {
    expect(sanitizeText("abcdef", 3)).toBe("abc");
    expect(sanitizeText("😀😀😀", 2)).toBe("😀😀");
    expect(sanitizeText("\u0007ab", 2)).toBe("ab");
    expect(sanitizeText("abc", 2.9)).toBe("ab");
    expect(sanitizeText("abc", 0)).toBe("");
    expect(sanitizeText("abc", -1)).toBe("");
    expect(sanitizeText("abc", Number.NaN)).toBe("");
    expect(sanitizeText("abc", Number.POSITIVE_INFINITY)).toBe("");
    expect(sanitizeText("abc", 1_000)).toBe("abc");
  });

  test("[SR-13] hostile markup and URL payloads stay plain text", () => {
    const payloads = [
      '<img src=x onerror=alert(1)>',
      '"><script>alert(1)</script>',
      "<script>alert(document.cookie)</script>",
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      "expression(alert(1))",
      "#fff; background: url(//evil.example/x)",
    ];

    for (const payload of payloads) {
      expect(sanitizeText(payload, 1_000), payload).toBe(payload);
    }

    // Oversized input is truncated, never returned whole.
    expect(sanitizeText("a".repeat(10_000), 64)).toHaveLength(64);
    // Embedded controls are removed wherever they appear.
    expect(sanitizeText("<\u0000script\u0007>", 100)).toBe("<script>");
  });
});

describe("isAllowedImageSrc (D5-SDK-01)", () => {
  test("[SR-13] accepts same-origin paths and base64 PNG/JPEG/WebP data URIs", () => {
    const allowed = [
      "assets/panel.png",
      "./img/x.webp",
      "/shared/a.jpg",
      "../a.png",
      "a.png?v=2#fragment",
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      "data:image/webp;base64,UklGRg==",
      "DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=",
      "a".repeat(2_048),
    ];

    for (const src of allowed) {
      expect(isAllowedImageSrc(src), src).toBe(true);
    }
  });

  test("[SR-13] rejects schemes, protocol-relative URLs, SVG/HTML data and malformed base64", () => {
    const rejected = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "https://evil.example/x.png",
      "http://evil.example/x.png",
      "//evil.example/x.png",
      "\\\\evil.example\\x.png",
      "blob:http://evil.example/x",
      "file:///etc/passwd",
      "ftp://evil.example/x.png",
      "data:text/html;base64,PHNjcmlwdD4=",
      "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pjwvc2NyaXB0Pjwvc3ZnPg==",
      "data:image/gif;base64,R0lGODlh",
      "data:image/png;base64,",
      "data:image/png;base64,a",
      "data:image/png;base64,====",
      "data:image/png;base64,AAAA==",
      "data:image/png;charset=utf-8;base64,iVBORw0KGgo=",
      " assets/a.png",
      "assets/a.png ",
      "assets/a b.png",
      "assets/a\u0000.png",
      "assets/a\tb.png",
      "assets\\a.png",
      'assets/"a".png',
      "assets/<a>.png",
      "",
      "a".repeat(2_049),
    ];

    for (const src of rejected) {
      expect(isAllowedImageSrc(src), JSON.stringify(src)).toBe(false);
    }
  });
});

describe("isValidEventName (D5-SDK-01)", () => {
  test("[SR-13] enforces ^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$", () => {
    for (const name of ["answer", "vote.round_1", "a-b", "A1", "x.y-z_0", "a".repeat(64)]) {
      expect(isValidEventName(name), name).toBe(true);
    }

    for (const name of [
      "",
      "1answer",
      "answer!",
      "a b",
      "a/b",
      "answer:round1",
      "<script>",
      " answer",
      "answer\n",
      "café",
      "a".repeat(65),
      7,
      null,
      undefined,
    ]) {
      expect(isValidEventName(name), String(name)).toBe(false);
    }
  });
});

describe("normalizeStrokePoint (D5-SDK-01)", () => {
  test("[FR-8.1] clamps stroke points into normalized 0..1 space", () => {
    expect(normalizeStrokePoint(0.5, 0.25, 123)).toEqual({ x: 0.5, y: 0.25, t: 123 });
    expect(normalizeStrokePoint(-1, 2, -5)).toEqual({ x: 0, y: 1, t: 0 });
    expect(
      normalizeStrokePoint(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN),
    ).toEqual({ x: 0, y: 0, t: 0 });
    expect(
      normalizeStrokePoint(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, 0),
    ).toEqual({ x: 0, y: 0, t: 0 });

    const first = normalizeStrokePoint(0.2, 0.3, 4);
    const second = normalizeStrokePoint(0.2, 0.3, 4);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe("isAllowedColor (D5-SEC-01)", () => {
  test("[SR-13] accepts only #rgb and #rrggbb hex colours", () => {
    for (const color of ["#fff", "#FFF", "#000", "#a1b2c3", "#AABBCC"]) {
      expect(isAllowedColor(color), color).toBe(true);
    }

    for (const value of [
      "#ff",
      "#ffff",
      "#fffff",
      "#fffffff",
      "#ggg",
      "fff",
      "red",
      "rgb(0, 0, 0)",
      "rgba(0, 0, 0, 0.5)",
      "var(--accent)",
      "expression(alert(1))",
      "url(javascript:alert(1))",
      "#fff; background: url(//evil.example/x)",
      "#fff\n",
      " #fff",
      "#fff ",
      7,
      null,
      undefined,
      {},
      ["#fff"],
    ]) {
      expect(isAllowedColor(value), String(value)).toBe(false);
    }
  });
});

describe("sanitizePlayerName (D5-SEC-01)", () => {
  test("[SR-13] is plain text, control-free and at most 24 characters", () => {
    expect(MAX_PLAYER_NAME_CHARS).toBe(24);
    expect(sanitizePlayerName("Alice")).toBe("Alice");
    expect(sanitizePlayerName("  Alice  ")).toBe("Alice");
    expect(sanitizePlayerName("a\u0000b\u0007c\u007fd")).toBe("abcd");
    expect(sanitizePlayerName("<b>Alice</b>")).toBe("<b>Alice</b>");
    expect(sanitizePlayerName("x".repeat(100))).toHaveLength(MAX_PLAYER_NAME_CHARS);
    expect(sanitizePlayerName("😀".repeat(30))).toBe("😀".repeat(MAX_PLAYER_NAME_CHARS));
    expect(sanitizePlayerName(42)).toBe("");
    expect(sanitizePlayerName(undefined)).toBe("");
  });
});

describe("UGC helper purity", () => {
  test("[SR-13] helpers are DOM-free and return plain values", () => {
    const throwOnDomAccess = (): never => {
      throw new Error("SDK UGC helpers must not access the DOM");
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
      expect(sanitizeText("<b>plain</b>", 100)).toBe("<b>plain</b>");
      expect(isAllowedImageSrc("assets/card.png")).toBe(true);
      expect(isAllowedColor("#abc")).toBe(true);
      expect(sanitizePlayerName("  Alice  ")).toBe("Alice");
      expect(isValidEventName("answer")).toBe(true);
      expect(normalizeStrokePoint(0.5, 0.5, 1)).toEqual({ x: 0.5, y: 0.5, t: 1 });
    } finally {
      Reflect.deleteProperty(globalThis, "document");
      Reflect.deleteProperty(globalThis, "window");
    }
  });
});

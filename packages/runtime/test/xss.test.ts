/**
 * D5-SEC-01 runtime hostile-payload suite (SR-13, SR-7, FR-7.9).
 *
 * `safeData` is the game-side reader for opaque controller events. The tests
 * feed the same payloads used by the controller suite and assert that they
 * become inert text, are rejected, or are bounded before a handler sees them.
 */
import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@lanpad/sdk";
import {
  MAX_EVENT_PAYLOAD_DEPTH,
  isSafeEventName,
  isSafeEventPayload,
  readEventColor,
  readEventRecord,
  readEventText,
  readEventValue,
} from "../src/game/safeData.js";

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

function nested(depth: number): JsonValue {
  let value: JsonValue = "leaf";
  for (let index = 0; index < depth; index += 1) {
    value = { next: value };
  }
  return value;
}

describe("[SR-13] event text readers", () => {
  it("[SR-13] hostile payload strings are returned as inert text", () => {
    for (const payload of HOSTILE_PAYLOADS) {
      expect(readEventValue({ value: payload }), payload).toBe(payload);
      expect(readEventText({ text: payload }, "text"), payload).toBe(payload);
    }
  });

  it("[SR-13] strips control characters and truncates oversized text", () => {
    expect(readEventValue({ value: "a\u0000b\u0007c\u007fd" })).toBe("abcd");
    expect(readEventValue({ value: "x".repeat(10_000) }, 64)).toHaveLength(64);
    expect(readEventValue({ value: 42 })).toBe("");
    expect(readEventValue({ value: null })).toBe("");
    expect(readEventValue(["not", "a", "record"])).toBe("");
    expect(readEventValue(null)).toBe("");
    expect(readEventText({ value: "x" }, "missing")).toBe("");
  });

  it("[FR-7.9] event bodies stay opaque data; readers never parse markup", () => {
    const payload = '{"__proto__":{"admin":true},"html":"<b>x</b>"}';
    expect(readEventValue({ value: payload })).toBe(payload);
    expect(readEventRecord({ value: "x" })).toEqual({ value: "x" });
    expect(readEventRecord([1, 2, 3])).toBeNull();
    expect(readEventRecord(null)).toBeNull();
    expect(readEventRecord("text")).toBeNull();
  });
});

describe("[SR-13] event colour reader", () => {
  it("[SR-13] accepts only #rgb and #rrggbb, never arbitrary CSS", () => {
    expect(readEventColor({ color: "#abc" }, "color")).toBe("#abc");
    expect(readEventColor({ color: "#AABBCC" }, "color")).toBe("#AABBCC");

    for (const hostile of [
      "expression(alert(1))",
      "javascript:alert(1)",
      "rgb(0, 0, 0)",
      "#ffff",
      "#fff; background: url(//evil.example/x)",
      "url(//evil.example/x)",
    ]) {
      expect(readEventColor({ color: hostile }, "color", "#000"), hostile).toBe("#000");
    }

    expect(readEventColor({}, "color")).toBe("#ffffff");
    expect(readEventColor({ color: "red" }, "color", "url(evil)")).toBe("#ffffff");
    expect(readEventColor(null, "color", "#123456")).toBe("#123456");
  });
});

describe("[SR-13] event name validation", () => {
  it("[SR-13] enforces ^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$", () => {
    for (const name of ["answer", "vote.round_1", "a-b", "A1", "x.y-z_0", "a".repeat(64)]) {
      expect(isSafeEventName(name), name).toBe(true);
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
      expect(isSafeEventName(name), String(name)).toBe(false);
    }
  });
});

describe("[SR-13] event payload shape", () => {
  it("[SR-13] accepts JSON primitives, arrays and bounded objects", () => {
    for (const value of [
      null,
      true,
      42,
      "text",
      [1, "two", false, null],
      { value: "hello", nested: { ok: true, count: 2 } },
    ]) {
      expect(isSafeEventPayload(value), JSON.stringify(value)).toBe(true);
    }
  });

  it("[SR-13] rejects non-JSON values and non-finite numbers", () => {
    const values: unknown[] = [
      undefined,
      () => 1,
      Symbol("x"),
      10n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      [1, Number.NaN],
      { value: undefined },
      { value: () => 1 },
    ];

    for (const value of values) {
      expect(isSafeEventPayload(value as JsonValue), String(value)).toBe(false);
    }
  });

  it("[SR-13] bounds nesting depth and survives cycles", () => {
    expect(isSafeEventPayload(nested(MAX_EVENT_PAYLOAD_DEPTH))).toBe(true);
    expect(isSafeEventPayload(nested(MAX_EVENT_PAYLOAD_DEPTH + 1))).toBe(false);

    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(isSafeEventPayload(cyclic as unknown as JsonValue)).toBe(false);
  });
});

describe("[SR-7] readers do not persist or transmit UGC", () => {
  it("[SR-7] reading a hostile event touches no storage and no network", () => {
    const setItem = vi.fn();
    const getItem = vi.fn();
    const removeItem = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("localStorage", { setItem, getItem, removeItem });
    vi.stubGlobal("fetch", fetchMock);

    try {
      expect(readEventValue({ value: "<img src=x onerror=alert(1)>" })).toBe(
        "<img src=x onerror=alert(1)>",
      );
      expect(readEventColor({ color: "#abc" }, "color")).toBe("#abc");
      expect(setItem).not.toHaveBeenCalled();
      expect(getItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

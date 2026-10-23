/**
 * Word pack and guess normalization (GAME-DG-DATA-01, GAME-DG-HOST-04).
 *
 * The pack is shipped JSON, not code: it carries its own license and language
 * and every word is canonical lowercase. Normalization is exact (trim,
 * lowercase, collapse spaces, fold accents), never fuzzy.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { DG_CONFIG } from "../src/config.js";
import { loadShippedWordPack, normalizeWord, parseWordPack } from "../src/words.js";

const PACKAGE_ROOT = new URL("../", import.meta.url);

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, PACKAGE_ROOT), "utf8"));
}

const BASE_PACK = {
  id: "test-words",
  type: "word-list",
  license: "CC0-1.0",
  items: ["apple"],
  meta: { category: "family", language: "en" },
};

describe("word pack", () => {
  test("[GAME-DG-DATA-01] the shipped pack is CC0, family-safe and large enough for a match", () => {
    const raw = readJson("packs/words-family-v1.json") as Record<string, unknown>;
    const pack = loadShippedWordPack();

    expect(raw["license"]).toBe("CC0-1.0");
    expect(pack.id).toBe("words-family-v1");
    expect(pack.type).toBe("word-list");
    expect(pack.license).toBe("CC0-1.0");
    expect(pack.meta).toEqual({ category: "family", language: "en" });
    expect(pack.items.length).toBeGreaterThanOrEqual(50);
    expect(pack.items.length).toBeGreaterThan(DG_CONFIG.rounds);

    const seen = new Set<string>();
    for (const word of pack.items) {
      expect(seen.has(word)).toBe(false);
      seen.add(word);
      expect(word).toBe(normalizeWord(word));
      expect(word).toBe(word.trim());
      expect(word.length).toBeLessThanOrEqual(40);
    }
  });

  const invalid: Array<[string, unknown, RegExp]> = [
    ["a non-object root", [], /root must be an object/],
    ["a blank id", { ...BASE_PACK, id: "  " }, /"id"/],
    ["the wrong pack type", { ...BASE_PACK, type: "sentence-list" }, /word-list/],
    ["a non-CC0 license", { ...BASE_PACK, license: "CC-BY-4.0" }, /license/],
    ["an empty item list", { ...BASE_PACK, items: [] }, /non-empty/],
    ["a non-string item", { ...BASE_PACK, items: [42] }, /must be a string/],
    ["a duplicate word", { ...BASE_PACK, items: ["apple", "apple"] }, /duplicate/],
    ["an uppercase word", { ...BASE_PACK, items: ["Apple"] }, /canonical/],
    ["a double space", { ...BASE_PACK, items: ["ice  cream"] }, /canonical/],
    ["punctuation", { ...BASE_PACK, items: ["hello!"] }, /unsupported/],
    ["an over-long word", { ...BASE_PACK, items: ["a".repeat(41)] }, /longer/],
    ["missing metadata", { ...BASE_PACK, meta: null }, /"meta"/],
  ];

  for (const [label, value, pattern] of invalid) {
    test(`[GAME-DG-DATA-01] the parser rejects ${label}`, () => {
      expect(() => parseWordPack(value)).toThrow(pattern);
    });
  }

  test("[GAME-DG-HOST-04] a valid custom pack parses without touching the shipped one", () => {
    const pack = parseWordPack({ ...BASE_PACK, items: ["apple", "fire truck", "roller-coaster"] });
    expect(pack.items).toEqual(["apple", "fire truck", "roller-coaster"]);
    expect(pack.license).toBe("CC0-1.0");
  });
});

describe("guess normalization", () => {
  test("[GAME-DG-HOST-04][GAME-DG-TEST-03] trim, case and whitespace collapse are exact", () => {
    expect(normalizeWord("  ICE   CREAM  ")).toBe("ice cream");
    expect(normalizeWord("APPLE")).toBe("apple");
    expect(normalizeWord("\t HOT\n AIR ")).toBe("hot air");
    expect(normalizeWord("roller-coaster")).toBe("roller-coaster");
    expect(normalizeWord("chef's hat")).toBe("chef's hat");
    expect(normalizeWord("   ")).toBe("");
  });

  test("[GAME-DG-HOST-04][GAME-DG-TEST-03] accents fold but different words never match", () => {
    expect(normalizeWord("CAFÉ")).toBe("cafe");
    expect(normalizeWord("café")).toBe("cafe");
    expect(normalizeWord("naïve")).toBe("naive");
    expect(normalizeWord("apple")).not.toBe(normalizeWord("apples"));
    expect(normalizeWord("apple")).not.toBe(normalizeWord("appl"));
    expect(normalizeWord("́")).toBe("");
  });

  test("[GAME-DG-HOST-04] the match word list is long enough for three distinct rounds", () => {
    const pack = loadShippedWordPack();
    expect(pack.items.length).toBeGreaterThanOrEqual(DG_CONFIG.rounds * 4);
  });
});

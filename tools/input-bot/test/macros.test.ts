import { describe, expect, test } from "vitest";
import { MacroError, parseMacros, toI16 } from "../src/macros";

function expectMacroError(document: unknown, path: string): MacroError {
  try {
    parseMacros(document);
  } catch (error) {
    expect(error).toBeInstanceOf(MacroError);
    const macroError = error as MacroError;
    expect(macroError.path).toBe(path);
    return macroError;
  }
  throw new Error("expected a MacroError");
}

describe("macro validation (D0-TOOL-01)", () => {
  test("[FR-7.4] axis macro clamps to i16", () => {
    const actions = parseMacros([
      { atMs: 200, type: "axis", lx: 40000, ly: -40000, rx: 12.6, ry: -12.6 },
    ]);

    expect(actions).toEqual([
      { atMs: 200, type: "axis", lx: 32767, ly: -32768, rx: 13, ry: -13 },
    ]);
    expect(toI16(99999)).toBe(32767);
    expect(toI16(-99999)).toBe(-32768);
  });

  test("press and release keep their button names and deduplicate", () => {
    const actions = parseMacros([
      { atMs: 0, type: "press", buttons: ["A", "B", "A"] },
      { atMs: 80, type: "release", buttons: ["A"] },
    ]);

    expect(actions).toEqual([
      { atMs: 0, type: "press", buttons: ["A", "B"] },
      { atMs: 80, type: "release", buttons: ["A"] },
    ]);
  });

  test("actions are sorted by time with stable document order", () => {
    const actions = parseMacros([
      { atMs: 50, type: "press", buttons: ["A"] },
      { atMs: 0, type: "axis", lx: 1 },
      { atMs: 50, type: "release", buttons: ["A"] },
    ]);

    expect(actions.map((action) => `${action.type}@${action.atMs}`)).toEqual([
      "axis@0",
      "press@50",
      "release@50",
    ]);
  });

  test("a non-array document fails at the root", () => {
    expectMacroError({ atMs: 0 }, "macro");
  });

  test("a non-object action fails at its index", () => {
    expectMacroError(["press"], "macro[0]");
  });

  test("atMs must be a finite non-negative number", () => {
    expectMacroError([{ type: "press", buttons: ["A"] }], "macro[0].atMs");
    expectMacroError([{ atMs: -1, type: "press", buttons: ["A"] }], "macro[0].atMs");
    expectMacroError([{ atMs: "0", type: "press", buttons: ["A"] }], "macro[0].atMs");
  });

  test("an unknown button names the exact element", () => {
    const error = expectMacroError(
      [{ atMs: 0, type: "press", buttons: ["A", "Z"] }],
      "macro[0].buttons[1]",
    );
    expect(error.message).toContain("unknown button");
  });

  test("buttons must be a non-empty array", () => {
    expectMacroError([{ atMs: 0, type: "press", buttons: [] }], "macro[0].buttons");
    expectMacroError([{ atMs: 0, type: "press", buttons: "A" }], "macro[0].buttons");
  });

  test("an axis action needs at least one axis field", () => {
    expectMacroError([{ atMs: 0, type: "axis" }], "macro[0]");
  });

  test("axis fields must be finite numbers", () => {
    expectMacroError([{ atMs: 0, type: "axis", lx: "1" }], "macro[0].lx");
  });

  test("unknown types and fields are rejected", () => {
    expectMacroError([{ atMs: 0, type: "hold", buttons: ["A"] }], "macro[0].type");
    expectMacroError([{ atMs: 0, type: "press", buttons: ["A"], extra: true }], "macro[0].extra");
  });
});

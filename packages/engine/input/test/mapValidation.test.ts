/**
 * ER-10-13 — action-map and overlay validation.
 *
 * Every fixture in `test/fixtures/action-map-invalid` must fail with
 * `E_INPUT_FORMAT` at the JSON path recorded in the fixture README. Unknown
 * fields are ignored, and generated garbage never throws anything else.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  InputFormatError,
  parseActionMapJson,
  parseBindingOverlayJson,
} from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(relative: string): string {
  return readFileSync(join(FIXTURES, relative), "utf8");
}

function formatError(run: () => unknown): InputFormatError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InputFormatError);
  return caught as InputFormatError;
}

/** Fixture file -> expected JSON path (test/fixtures/README.md). */
const INVALID_MAPS: ReadonlyArray<readonly [string, string]> = [
  ["format-version-2.json", "formatVersion"],
  ["duplicate-action.json", "actions[1].name"],
  ["bad-name.json", "actions[0].name"],
  ["unknown-kind.json", "actions[0].kind"],
  ["bad-deadzone.json", "actions[0].deadzone"],
  ["bad-threshold.json", "actions[0].threshold"],
  ["bad-hysteresis.json", "actions[0].hysteresis"],
  ["yup-on-button.json", "actions[0].yUp"],
  ["output-two-members.json", "actions[0].output"],
  ["output-kind-mismatch.json", "actions[0].output"],
  ["empty-bindings.json", "actions[0].bindings"],
  ["too-many-bindings.json", "actions[0].bindings"],
  ["unknown-device.json", "actions[0].bindings[0].device"],
  ["unknown-channel.json", "actions[0].bindings[0].channel"],
  ["gamepad-button-and-axis.json", "actions[0].bindings[0]"],
  ["pointer-button-and-axis.json", "actions[0].bindings[0]"],
  ["bad-scale.json", "actions[0].bindings[0].scale"],
  ["bad-bit.json", "actions[0].bindings[0].bit"],
  ["bad-slot.json", "actions[0].bindings[0].slot"],
  ["bad-pad.json", "actions[0].bindings[0].pad"],
  ["lt-vector-no-component.json", "actions[0].bindings[0].component"],
];

describe("action map validation", () => {
  test("[ER-10-13] the valid fixture loads with every source kind and output", () => {
    const document = parseActionMapJson(fixture("action-map-valid.json"));
    expect(document.formatVersion).toBe(1);
    expect(document.actions).toHaveLength(11);
    const move = document.actions.find((action) => action.name === "move");
    expect(move?.bindings).toHaveLength(12);
    expect(document.actions.find((action) => action.name === "turn")?.kind).toBe("axis");
  });

  test("[ER-10-13] unknown root, action, binding and output fields are ignored", () => {
    const document = parseActionMapJson(
      fixture("action-map-valid-unknown-fields.json"),
    );
    expect(document.actions.length).toBeGreaterThan(0);
    expect(document.actions[0]?.name).toBeTypeOf("string");
  });

  for (const [file, expectedPath] of INVALID_MAPS) {
    test(`[ER-10-13] ${file} fails E_INPUT_FORMAT at ${expectedPath}`, () => {
      const error = formatError(() =>
        parseActionMapJson(fixture(`action-map-invalid/${file}`)),
      );
      expect(error.code).toBe("E_INPUT_FORMAT");
      expect(error.path).toBe(expectedPath);
    });
  }

  test("[ER-10-13] a valid overlay parses and preserves null restoration", () => {
    const document = parseBindingOverlayJson(
      JSON.stringify({
        formatVersion: 1,
        bindings: {
          primary: [{ device: "keyboard", code: "KeyF" }],
          move: null,
        },
      }),
    );
    expect(document.formatVersion).toBe(1);
    expect(document.bindings.primary?.[0]).toEqual({
      device: "keyboard",
      code: "KeyF",
    });
    expect(document.bindings.move).toBeNull();
  });

  test("[ER-10-13] an invalid overlay fails at its JSON path", () => {
    const error = formatError(() =>
      parseBindingOverlayJson(
        JSON.stringify({
          formatVersion: 1,
          bindings: { primary: [{ device: "keyboard", code: 7 }] },
        }),
      ),
    );
    expect(error.path).toBe("bindings.primary[0].code");
  });

  test("[ER-10-13] an overlay with a bad version fails at formatVersion", () => {
    const error = formatError(() =>
      parseBindingOverlayJson(
        JSON.stringify({ formatVersion: 2, bindings: {} }),
      ),
    );
    expect(error.path).toBe("formatVersion");
  });

  test(
    "[ER-10-13] 10,000 generated maps load or fail only with E_INPUT_FORMAT",
    () => {
      fc.assert(
        fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => {
          const text = JSON.stringify(value);
          try {
            parseActionMapJson(text);
            return true;
          } catch (error) {
            return (
              error instanceof InputFormatError &&
              error.code === "E_INPUT_FORMAT" &&
              error.path.length > 0
            );
          }
        }),
        { numRuns: 10_000 },
      );
    },
    30_000,
  );
});

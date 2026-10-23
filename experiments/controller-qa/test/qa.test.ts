/**
 * Controller QA probe tests (stream E).
 *
 * The page is static, but its data and its geometry are not allowed to drift:
 * `layouts.json` must mirror the canonical controller fixtures, the probe's
 * box math must match the real renderer (`measureControl`), and the checker
 * must actually fail an undersized control.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { measureControl } from "../../../packages/controller/src/controls/control.js";
import type { LayoutDocument } from "@lanpad/sdk";
import {
  MIN_TOUCH_TARGET_PX,
  PHONE_SIZES,
  evaluateLayouts,
  measureBox,
} from "../qa.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const QA_ROOT = join(HERE, "..");
const REPO_ROOT = join(QA_ROOT, "..", "..");
const CANONICAL_DIR = join(REPO_ROOT, "packages", "controller", "layouts");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const layouts = readJson<LayoutDocument[]>(join(QA_ROOT, "layouts.json"));
const canonical = readdirSync(CANONICAL_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => readJson<LayoutDocument>(join(CANONICAL_DIR, name)));

describe("[FR-8.4] controller QA probe data", () => {
  it("[FR-8.4] layouts.json mirrors every canonical controller fixture", () => {
    expect(layouts.length).toBeGreaterThanOrEqual(8);
    expect(layouts.map((layout) => layout.id)).toEqual(canonical.map((layout) => layout.id));
    expect(layouts).toEqual(canonical);
  });

  it("[FR-8.4] every fixture is checked in both phone frames", () => {
    const result = evaluateLayouts(layouts, PHONE_SIZES);
    for (const layout of layouts) {
      for (const size of PHONE_SIZES) {
        const rows = result.rows.filter(
          (row) => row.layout === layout.id && row.orientation === size.orientation,
        );
        expect(rows.length, `${layout.id} ${size.orientation}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("[AR-5] 44 px target checks", () => {
  it("[AR-5] every interactive target clears 44 px without clamping", () => {
    const result = evaluateLayouts(layouts, PHONE_SIZES);

    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks).toBeGreaterThan(0);
    for (const row of result.rows) {
      const where = `${row.layout} ${row.id} ${row.orientation}`;
      expect(row.width, where).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(row.height, where).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(row.undersized, where).toBe(false);
    }
  });

  it("[AR-5] the probe box math matches the controller renderer", () => {
    for (const layout of layouts) {
      for (const size of PHONE_SIZES) {
        for (const control of layout.controls) {
          const probe = measureBox(control, size);
          const real = measureControl(control, size);
          const where = `${layout.id} ${control.id} ${size.orientation}`;
          expect(probe.width, where).toBeCloseTo(real.width, 6);
          expect(probe.height, where).toBeCloseTo(real.height, 6);
          expect(probe.left, where).toBeCloseTo(real.left, 6);
          expect(probe.top, where).toBeCloseTo(real.top, 6);
          expect(probe.undersized, where).toBe(real.undersized);
        }
      }
    }
  });

  it("[AR-5] fails an undersized control instead of silently clamping", () => {
    const tiny = [
      {
        schemaVersion: 1,
        id: "qa-tiny-v1",
        orientation: "portrait",
        controls: [
          {
            type: "button",
            id: "tiny",
            label: "Tiny",
            shape: "rounded",
            x: "50%",
            y: "50%",
            r: "5%",
            bit: 0,
          },
        ],
      },
    ] as unknown as LayoutDocument[];

    const result = evaluateLayouts(tiny, [PHONE_SIZES[0]!]);
    expect(result.ok).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.undersized).toBe(true);
    expect(result.failures).toHaveLength(1);
  });
});

describe("[SR-7] probe page hygiene", () => {
  it("[SR-7] uses external assets only and runs only on demand", () => {
    const html = readFileSync(join(QA_ROOT, "index.html"), "utf8");
    const script = readFileSync(join(QA_ROOT, "qa.js"), "utf8");

    expect(html).toContain('<script type="module" src="./qa.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="./qa.css">');
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);

    for (const text of [html, script]) {
      expect(text).not.toMatch(/https?:\/\//);
      // "No analytics" in the page copy is fine; an analytics endpoint is not.
      expect(text).not.toMatch(/google-analytics|googletagmanager|plausible\.io|segment\.(io|com)/i);
    }

    // The only fetch is inside the Run handler path; mount attaches listeners.
    expect(script).toContain('runButton.addEventListener("click"');
    expect(script).toContain('if (typeof document !== "undefined"');
  });
});

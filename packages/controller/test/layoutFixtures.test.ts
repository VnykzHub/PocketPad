/**
 * Controller layout recipes (stream E): every checked-in fixture must pass the
 * same validator the host and controller run, keep a touch fallback for gyro,
 * clear the 44 px target on portrait and landscape phones, and the launcher
 * remote must render with the frozen bits from a phone surface.
 *
 * These files are deliberately fixtures, not game layouts. A game copies one
 * into its own folder and owns its changes; see `packages/controller/layouts/
 * README.md`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateLayout, type LayoutDocument } from "@lanpad/sdk";
import {
  measureControl,
  type ControlContext,
  type SurfaceSize,
} from "../src/controls/control.js";
import { createControls } from "../src/controls/registry.js";
import { InputStore } from "../src/input/InputStore.js";
import {
  LAUNCHER_REMOTE_BITS,
  LAUNCHER_REMOTE_LAYOUT,
  LAUNCHER_REMOTE_LAYOUT_ID,
} from "../src/layout/launcherRemote.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT_DIR = join(PACKAGE_ROOT, "layouts");
const FIXTURES = readdirSync(LAYOUT_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();

const PHONES: readonly SurfaceSize[] = [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
];

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(LAYOUT_DIR, name), "utf8")) as unknown;
}

function validated(name: string): LayoutDocument {
  const result = validateLayout(readFixture(name));
  if (!result.ok) {
    throw new Error(`${name}: ${result.errors.join("; ")}`);
  }
  return result.layout;
}

describe("[FR-8.4] controller layout fixtures", () => {
  it("[FR-8.4] every recipe passes the layout validator", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(8);
    for (const name of FIXTURES) {
      const result = validateLayout(readFixture(name));
      if (!result.ok) {
        throw new Error(`${name}: ${result.errors.join("; ")}`);
      }
      expect(result.layout.controls.length).toBeGreaterThan(0);
      expect(result.layout.id.length).toBeLessThanOrEqual(64);
    }
  });

  it("[FR-8.4] the launcher JSON mirrors the typed export exactly", () => {
    expect(readFixture("launcher-remote-v1.json")).toEqual(LAUNCHER_REMOTE_LAYOUT);
    expect(LAUNCHER_REMOTE_LAYOUT.id).toBe(LAUNCHER_REMOTE_LAYOUT_ID);
  });

  it("[FR-8.10] every gyro recipe ships a stick or d-pad fallback", () => {
    let gyroRecipes = 0;
    for (const name of FIXTURES) {
      const layout = validated(name);
      const hasGyro = layout.controls.some((control) => control.type === "gyro");
      if (!hasGyro) {
        continue;
      }
      gyroRecipes += 1;
      const hasFallback = layout.controls.some(
        (control) => control.type === "stick" || control.type === "dpad",
      );
      expect(hasFallback, `${name} needs a non-gyro fallback`).toBe(true);
    }
    expect(gyroRecipes).toBeGreaterThanOrEqual(2);
  });

  it("[AR-5] interactive targets clear 44 px without clamping", () => {
    for (const name of FIXTURES) {
      const layout = validated(name);
      for (const surface of PHONES) {
        for (const control of layout.controls) {
          if (control.type === "panel") {
            continue;
          }
          const box = measureControl(control, surface);
          const where = `${name} ${control.id} at ${surface.width}x${surface.height}`;
          expect(box.undersized, where).toBe(false);
          expect(box.width, where).toBeGreaterThanOrEqual(44);
          expect(box.height, where).toBeGreaterThanOrEqual(44);
        }
      }
    }
  });
});

describe("[FR-8.1][FR-8.2] launcher remote rendering", () => {
  it("[FR-8.1] renders status, d-pad, Back and Select on a phone surface", () => {
    const surface = document.createElement("div");
    const ctx: ControlContext = {
      input: new InputStore(),
      surfaceSize: { width: 390, height: 844 },
    };
    const renderers = createControls(LAUNCHER_REMOTE_LAYOUT.controls, ctx);
    for (const renderer of renderers) {
      surface.append(renderer.element);
    }

    expect(renderers.map((renderer) => renderer.id)).toEqual([
      "status",
      "nav",
      "back",
      "select",
    ]);
    expect(surface.querySelector('[data-control-id="nav"]')?.getAttribute("data-control-type"))
      .toBe("dpad");
    expect(surface.querySelector('[data-control-id="back"]')?.getAttribute("data-control-type"))
      .toBe("button");
    expect(surface.querySelector('[data-control-id="select"]')?.getAttribute("data-control-type"))
      .toBe("button");

    for (const renderer of renderers) {
      if (renderer.id === "status") {
        continue;
      }
      expect(Number.parseFloat(renderer.element.style.width)).toBeGreaterThanOrEqual(44);
      expect(Number.parseFloat(renderer.element.style.height)).toBeGreaterThanOrEqual(44);
    }

    for (const renderer of renderers) {
      renderer.dispose();
    }
  });

  it("[FR-8.1] Select and Back use the frozen launcher bits", () => {
    const input = new InputStore();
    const ctx: ControlContext = {
      input,
      surfaceSize: { width: 390, height: 844 },
    };
    const renderers = createControls(LAUNCHER_REMOTE_LAYOUT.controls, ctx);
    const select = renderers.find((renderer) => renderer.id === "select");
    const back = renderers.find((renderer) => renderer.id === "back");
    const nav = LAUNCHER_REMOTE_LAYOUT.controls.find((control) => control.id === "nav");

    expect(select).toBeDefined();
    expect(back).toBeDefined();
    expect(LAUNCHER_REMOTE_BITS).toEqual({
      select: 0,
      back: 1,
      up: 8,
      down: 9,
      left: 10,
      right: 11,
    });
    expect(nav?.type).toBe("dpad");
    if (nav?.type === "dpad") {
      expect(nav.bits).toEqual({
        up: LAUNCHER_REMOTE_BITS.up,
        down: LAUNCHER_REMOTE_BITS.down,
        left: LAUNCHER_REMOTE_BITS.left,
        right: LAUNCHER_REMOTE_BITS.right,
      });
    }

    const touch = {
      identifier: 1,
      controlId: "select",
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
    };
    select?.onTouchStart(touch);
    expect(input.snapshot(0).buttons & (1 << LAUNCHER_REMOTE_BITS.select)).not.toBe(0);
    select?.onTouchEnd(touch);
    expect(input.snapshot(0).buttons & (1 << LAUNCHER_REMOTE_BITS.select)).toBe(0);
  });
});

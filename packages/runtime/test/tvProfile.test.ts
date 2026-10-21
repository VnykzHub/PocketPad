import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  DRAW_CALL_BUDGET,
  FRAME_FLOOR_FPS,
  FRAME_HARD_FAIL_MS,
  FRAME_INTERVAL_30HZ_MS,
  FRAME_INTERVAL_60HZ_MS,
  FRAME_TARGET_FPS,
  HIGHEST_TESTED_HEIGHT,
  HIGHEST_TESTED_WIDTH,
  MAX_NON_TV_DPR,
  MIN_RENDER_HEIGHT,
  MIN_RENDER_WIDTH,
  RENDER_SCALE_FLOOR_PERCENT,
  TEXTURE_MEMORY_BUDGET_CONFIDENCE,
  TEXTURE_MEMORY_BUDGET_MB,
  TV_DPR,
  TV_MAX_RENDER_HEIGHT,
  frameBudgetViolations,
} from "../src/profile/budgets.js";
import { applyResolutionScale } from "../src/profile/resolutionController.js";
import {
  clampDpr,
  parseTvOverride,
  readViewportEnvironment,
  resolveTvProfile,
  classifyDisplayClass,
  type ViewportEnvironment,
  type WindowLike,
} from "../src/profile/tvProfile.js";

/**
 * D3-RT-07: TV profile and frame-pacing defaults.
 *
 * The repository docs are read directly so a change to `docs/BUDGETS.md`
 * without a matching runtime constant fails here instead of drifting. These
 * are desktop-provisional values; no test asserts a TV measurement because no
 * TV was measured (D1 exit remains open).
 */
const budgetsDoc = readFileSync(
  fileURLToPath(new URL("../../../docs/BUDGETS.md", import.meta.url)),
  "utf8",
);

const desktopEnv: ViewportEnvironment = {
  width: 2560,
  height: 1440,
  devicePixelRatio: 1,
  modality: { finePointer: true, coarsePointer: false, hover: true },
};

const tvEnv: ViewportEnvironment = {
  width: 1920,
  height: 1080,
  devicePixelRatio: 1,
  modality: { finePointer: false, coarsePointer: false, hover: false },
};

const phoneEnv: ViewportEnvironment = {
  width: 390,
  height: 844,
  devicePixelRatio: 3,
  modality: { finePointer: false, coarsePointer: true, hover: false },
};

class RecordingRenderer {
  readonly calls: Array<{ cssWidth: number; cssHeight: number; dpr: number }> = [];

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.calls.push({ cssWidth, cssHeight, dpr });
  }
}

describe("[FR-9.4] display profile", () => {
  test("[FR-9.4] TV profile uses DPR 1 and caps the backing store at 1080p", () => {
    const profile = resolveTvProfile(tvEnv);

    expect(profile.mode).toBe("tv");
    expect(profile.dpr).toBe(TV_DPR);
    expect(profile.dpr).toBe(1);
    expect(profile.maxRenderHeight).toBe(TV_MAX_RENDER_HEIGHT);
    expect(profile.maxRenderHeight).toBe(1080);
    expect(profile.cssUpscale).toBe(true);
    expect(profile.reason).toBe("large-viewport-no-fine-pointer");

    // The CSS size is passed through untouched; only the density changes, so
    // the browser upscales the backing store (FR-9.4).
    const renderer = new RecordingRenderer();
    applyResolutionScale(renderer, 1920, 1080, profile.dpr, 1);
    expect(renderer.calls).toEqual([{ cssWidth: 1920, cssHeight: 1080, dpr: 1 }]);
  });

  test("[FR-9.4] TV detection uses viewport and input modality, not the user agent", () => {
    expect(classifyDisplayClass(tvEnv)).toEqual({
      mode: "tv",
      reason: "large-viewport-no-fine-pointer",
    });
    expect(classifyDisplayClass(desktopEnv)).toEqual({
      mode: "desktop",
      reason: "fine-pointer",
    });
    expect(classifyDisplayClass(phoneEnv)).toEqual({
      mode: "phone",
      reason: "small-viewport",
    });

    // A large screen with a mouse stays desktop even if its UA string mentions
    // a TV. No UA is read; an extra property cannot influence the result.
    const uaHinted = {
      ...desktopEnv,
      userAgent: "Mozilla/5.0 (Linux; Android 11; SmartTV)",
    } as ViewportEnvironment & { userAgent: string };
    expect(classifyDisplayClass(uaHinted).mode).toBe("desktop");
    expect(resolveTvProfile(uaHinted).mode).toBe("desktop");
  });

  test("[FR-9.4] phones and desktops cap DPR at 2", () => {
    expect(resolveTvProfile(phoneEnv).dpr).toBe(2);
    expect(resolveTvProfile({ ...desktopEnv, devicePixelRatio: 3 }).dpr).toBe(2);
    expect(clampDpr(1.5)).toBe(1.5);
    expect(clampDpr(0.75)).toBe(1);
    expect(clampDpr(Number.NaN)).toBe(1);
    expect(resolveTvProfile(phoneEnv).maxRenderHeight).toBe(0);
  });

  test("[FR-9.4] ?tv=1 forces the TV profile and ?tv=0 forces it off", () => {
    expect(parseTvOverride("?tv=1")).toBe(true);
    expect(parseTvOverride("tv=true")).toBe(true);
    expect(parseTvOverride("?debug=1&tv=ON")).toBe(true);
    expect(parseTvOverride("?tv=0")).toBe(false);
    expect(parseTvOverride("?tv=maybe")).toBeNull();
    expect(parseTvOverride("?debug=1")).toBeNull();
    expect(parseTvOverride(undefined)).toBeNull();

    const forcedTv = resolveTvProfile(desktopEnv, "?tv=1");
    expect(forcedTv.mode).toBe("tv");
    expect(forcedTv.dpr).toBe(1);
    expect(forcedTv.reason).toBe("forced-tv");

    const forcedOff = resolveTvProfile(
      { ...tvEnv, devicePixelRatio: 2 },
      "?tv=0",
    );
    expect(forcedOff.mode).toBe("desktop");
    expect(forcedOff.dpr).toBe(2);
    expect(forcedOff.maxRenderHeight).toBe(0);
    expect(forcedOff.reason).toBe("forced-non-tv");
  });

  test("[FR-9.4] the display profile targets 60 fps with a 30 fps floor", () => {
    for (const env of [tvEnv, desktopEnv, phoneEnv]) {
      const profile = resolveTvProfile(env);
      expect(profile.targetFps).toBe(FRAME_TARGET_FPS);
      expect(profile.targetFps).toBe(60);
      expect(profile.floorFps).toBe(FRAME_FLOOR_FPS);
      expect(profile.floorFps).toBe(30);
      expect(profile.targetFrameMs).toBe(FRAME_INTERVAL_60HZ_MS);
      expect(profile.targetFrameMs).toBe(16.7);
      expect(profile.floorFrameMs).toBe(FRAME_INTERVAL_30HZ_MS);
      expect(profile.floorFrameMs).toBe(33.3);
    }
  });

  test("[FR-9.4] readViewportEnvironment reads media queries and keeps a safe fallback", () => {
    const win: WindowLike = {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 1,
      matchMedia: () => ({ matches: false }),
    };
    const env = readViewportEnvironment(win);
    expect(env).toEqual({
      width: 1920,
      height: 1080,
      devicePixelRatio: 1,
      modality: { finePointer: false, coarsePointer: false, hover: false },
    });
    expect(resolveTvProfile(env).mode).toBe("tv");

    // Without matchMedia the fine-pointer fallback is true, so an unknown
    // environment keeps the desktop profile rather than silently using DPR 1.
    const noMedia: WindowLike = {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 1,
    };
    expect(readViewportEnvironment(noMedia).modality.finePointer).toBe(true);
    expect(resolveTvProfile(readViewportEnvironment(noMedia)).mode).toBe("desktop");
  });
});

describe("[PR-9.1] draw calls", () => {
  test("[PR-9.1] the draw-call budget is 120 and over-budget frames are reported", () => {
    expect(DRAW_CALL_BUDGET).toBe(120);
    expect(
      frameBudgetViolations({ drawCalls: 120, textureMemoryMB: 0 }),
    ).toEqual([]);
    expect(
      frameBudgetViolations({ drawCalls: 121, textureMemoryMB: 0 }),
    ).toEqual(["draw-calls"]);
    expect(
      frameBudgetViolations({ drawCalls: Number.NaN, textureMemoryMB: 0 }),
    ).toEqual([]);
    expect(
      frameBudgetViolations({ drawCalls: -5, textureMemoryMB: 0 }),
    ).toEqual([]);
  });
});

describe("[PR-9.2] texture memory", () => {
  test("[PR-9.2] texture memory over the provisional 128 MB budget is flagged", () => {
    expect(TEXTURE_MEMORY_BUDGET_MB).toBe(128);
    expect(TEXTURE_MEMORY_BUDGET_CONFIDENCE).toBe("provisional");
    expect(
      frameBudgetViolations({ drawCalls: 0, textureMemoryMB: 128 }),
    ).toEqual([]);
    expect(
      frameBudgetViolations({ drawCalls: 0, textureMemoryMB: 128.1 }),
    ).toEqual(["texture-memory"]);
    expect(
      frameBudgetViolations({ drawCalls: 200, textureMemoryMB: 256 }),
    ).toEqual(["draw-calls", "texture-memory"]);
  });

  test("[PR-9.2] runtime budgets match docs/BUDGETS.md and keep TV rows pending", () => {
    // The values in budgets.ts are the runtime projection of these rows.
    expect(MIN_RENDER_WIDTH).toBe(1280);
    expect(MIN_RENDER_HEIGHT).toBe(720);
    expect(HIGHEST_TESTED_WIDTH).toBe(1920);
    expect(HIGHEST_TESTED_HEIGHT).toBe(1080);
    expect(TV_MAX_RENDER_HEIGHT).toBe(1080);
    expect(FRAME_INTERVAL_60HZ_MS).toBe(16.7);
    expect(FRAME_INTERVAL_30HZ_MS).toBe(33.3);
    expect(FRAME_HARD_FAIL_MS).toBe(20);
    expect(RENDER_SCALE_FLOOR_PERCENT).toBe(60);
    expect(TEXTURE_MEMORY_BUDGET_MB).toBe(128);
    expect(MAX_NON_TV_DPR).toBe(2);

    // Drift guard: if the budget file moves to another number, these strings
    // disappear and this test fails until budgets.ts is updated with it.
    expect(budgetsDoc).toContain("1280x720");
    expect(budgetsDoc).toContain("1920x1080");
    expect(budgetsDoc).toContain("16.7 ms");
    expect(budgetsDoc).toContain("33.3 ms");
    expect(budgetsDoc).toContain("60%");
    expect(budgetsDoc).toContain("128 MB");
    expect(budgetsDoc).toContain("no TV was measured");
    expect(budgetsDoc).toContain("Frame and resolution budgets");
  });
});

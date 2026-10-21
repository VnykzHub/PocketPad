/**
 * Runtime projection of `docs/BUDGETS.md` for the TV profile, dynamic
 * resolution and frame pacing (D3-RT-07).
 *
 * `docs/BUDGETS.md` is the single source for memory, texture and frame
 * numbers. A browser bundle cannot read Markdown at runtime, so this module is
 * the generated-code equivalent: every value below is transcribed with the
 * row it came from and its confidence. `test/tvProfile.test.ts` re-reads
 * `docs/BUDGETS.md` and fails when these numbers drift from it.
 *
 * Provenance: E1/E3 ran on desktop Chrome 155 only; no TV was measured. The
 * values described as "measured-desktop" are NOT TV measurements and the TV
 * rows in `docs/BUDGETS.md` remain pending. Do not add a device model or a
 * TV-specific ceiling here; budgets describe a device class.
 */

/** Display cadence classes from `docs/BUDGETS.md` "Frame and resolution". */
export const FRAME_TARGET_FPS = 60;
export const FRAME_FLOOR_FPS = 30;
/** Frame interval of the 60 Hz class; spec target 14 ms, hard fail 20 ms. */
export const FRAME_INTERVAL_60HZ_MS = 16.7;
/** Frame interval of the 30 Hz panel class (spec-fixed, conditional). */
export const FRAME_INTERVAL_30HZ_MS = 33.3;
/** SPEC §11 host frame-time p95 target. */
export const FRAME_P95_TARGET_MS = 14;
/** SPEC §11 host frame-time hard fail; also the FR-9.5 slow-frame threshold. */
export const FRAME_HARD_FAIL_MS = 20;

/**
 * FR-9.5: more than 20 ms for 30 consecutive frames drops render scale by
 * 10%. The threshold reuses the documented hard fail rather than inventing a
 * second frame budget.
 */
export const SLOW_FRAME_MS = FRAME_HARD_FAIL_MS;
export const SLOW_FRAME_COUNT = 30;
/**
 * D3-RT-07 recovery: under 12 ms for 120 consecutive frames raises scale by
 * 5%. 12 ms is below the 14 ms p95 target so recovery only happens when the
 * frame has real headroom; the long window is the hysteresis.
 */
export const FAST_FRAME_MS = 12;
export const FAST_FRAME_COUNT = 120;
export const SCALE_DROP_STEP_PERCENT = 10;
export const SCALE_RISE_STEP_PERCENT = 5;
/** `docs/BUDGETS.md`: render-scale floor 60% (provisional, unchanged by D1). */
export const RENDER_SCALE_FLOOR_PERCENT = 60;
export const RENDER_SCALE_CEILING_PERCENT = 100;

/** FR-9.4 TV profile: DPR 1, backing store at 1080p or lower, CSS upscale. */
export const TV_DPR = 1;
/** FR-9.4/D3-RT-07: phones and desktops may use up to DPR 2. */
export const MAX_NON_TV_DPR = 2;
/** `docs/BUDGETS.md`: 1080p is the highest resolution tested (desktop). */
export const TV_MAX_RENDER_HEIGHT = 1080;
/** `docs/BUDGETS.md`: 1280x720 is the minimum render resolution (desktop). */
export const MIN_RENDER_WIDTH = 1280;
export const MIN_RENDER_HEIGHT = 720;
/** `docs/BUDGETS.md`: highest resolution actually tested, desktop only. */
export const HIGHEST_TESTED_WIDTH = 1920;
export const HIGHEST_TESTED_HEIGHT = 1080;

/** SPEC §9.5 PR-9.1. */
export const DRAW_CALL_BUDGET = 120;
/**
 * SPEC §9.5 PR-9.2 / `docs/BUDGETS.md`: provisional 128 MB. E2 ran in safe
 * mode only, so this is not a measured TV ceiling and must not be enforced in
 * CI. The overlay reports against it; the Gate replaces it after a TV E2 run.
 */
export const TEXTURE_MEMORY_BUDGET_MB = 128;
export const TEXTURE_MEMORY_BUDGET_CONFIDENCE = "provisional" as const;

/** A frame's cost counters, as reported by the renderer and loader. */
export interface FrameBudgetSample {
  readonly drawCalls: number;
  readonly textureMemoryMB: number;
}

export type FrameBudgetViolation = "draw-calls" | "texture-memory";

/**
 * PR-9.1 / PR-9.2 check shared by the debug overlay and the acceptance tests.
 * Zero is valid; negative or non-finite counters are treated as zero so a
 * broken instrumentation cannot fabricate a violation.
 */
export function frameBudgetViolations(
  sample: FrameBudgetSample,
): FrameBudgetViolation[] {
  const violations: FrameBudgetViolation[] = [];
  const drawCalls = Number.isFinite(sample.drawCalls)
    ? Math.max(0, sample.drawCalls)
    : 0;
  const textureMB = Number.isFinite(sample.textureMemoryMB)
    ? Math.max(0, sample.textureMemoryMB)
    : 0;
  if (drawCalls > DRAW_CALL_BUDGET) {
    violations.push("draw-calls");
  }
  if (textureMB > TEXTURE_MEMORY_BUDGET_MB) {
    violations.push("texture-memory");
  }
  return violations;
}

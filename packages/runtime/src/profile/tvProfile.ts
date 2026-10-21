/**
 * TV / desktop / phone display profile (D3-RT-07, FR-9.4).
 *
 * The profile decides two things before the first frame:
 *
 * 1. **DPR** — the TV profile forces DPR 1 and caps the backing store at
 *    1080p while CSS keeps the full viewport, so the browser upscales
 *    (FR-9.4). Phones and desktops may use DPR up to 2.
 * 2. **Frame pacing defaults** — 60 fps target, 30 fps floor, from
 *    `docs/BUDGETS.md`.
 *
 * Detection uses only viewport size and input modality (pointer/hover media
 * queries). It never reads `navigator.userAgent`: FR-12.1 forbids UA sniffing
 * for capability, and a UA string cannot describe the panel that is actually
 * attached. The heuristic is deliberately conservative:
 *
 * - a large viewport (>= 1280x720 CSS) with no fine pointer is TV-like;
 * - any fine pointer (mouse/trackpad) keeps the desktop profile even on a
 *   large screen, so a PC driving a TV over HDMI is not forced to DPR 1;
 * - a small coarse-pointer viewport is the phone profile;
 * - everything else is the desktop profile.
 *
 * A TV with a mouse, or a TV whose media queries lie, can be forced with the
 * `?tv=1` query parameter (and turned off with `?tv=0`). That override exists
 * for tests and manual acceptance, not for production routing.
 *
 * No TV was measured (D1); this profile is derived from the provisional
 * desktop budgets and must not be described as a TV measurement.
 */
import {
  FRAME_FLOOR_FPS,
  FRAME_INTERVAL_30HZ_MS,
  FRAME_INTERVAL_60HZ_MS,
  FRAME_TARGET_FPS,
  MAX_NON_TV_DPR,
  MIN_RENDER_HEIGHT,
  MIN_RENDER_WIDTH,
  TV_DPR,
  TV_MAX_RENDER_HEIGHT,
} from "./budgets.js";

export type DisplayClass = "tv" | "desktop" | "phone";

export type TvProfileReason =
  | "large-viewport-no-fine-pointer"
  | "fine-pointer"
  | "small-viewport"
  | "forced-tv"
  | "forced-non-tv";

/** Input modality read from `matchMedia`, injected for deterministic tests. */
export interface InputModality {
  /** `(any-pointer: fine)` — a mouse, trackpad or pen is available. */
  readonly finePointer: boolean;
  /** `(any-pointer: coarse)` — a touch screen or remote pointer. */
  readonly coarsePointer: boolean;
  /** `(any-hover: hover)` — the primary input can hover. */
  readonly hover: boolean;
}

/** Everything the profile needs from a window, with no direct DOM access. */
export interface ViewportEnvironment {
  /** Viewport width in CSS pixels (`window.innerWidth`). */
  readonly width: number;
  /** Viewport height in CSS pixels (`window.innerHeight`). */
  readonly height: number;
  readonly devicePixelRatio: number;
  readonly modality: InputModality;
}

export interface TvProfile {
  readonly mode: DisplayClass;
  /** Effective device pixel ratio; 1 on the TV profile (FR-9.4). */
  readonly dpr: number;
  /** Backing-store height cap; 0 means no cap. 1080 on the TV profile. */
  readonly maxRenderHeight: number;
  /** True when CSS upscales a lower-resolution backing store (FR-9.4). */
  readonly cssUpscale: boolean;
  readonly reason: TvProfileReason;
  /** Default frame-pacing budget from `docs/BUDGETS.md`. */
  readonly targetFps: number;
  readonly floorFps: number;
  readonly targetFrameMs: number;
  readonly floorFrameMs: number;
}

/** Minimal `matchMedia` surface; the real `MediaQueryList` satisfies it. */
export interface MediaQueryListLike {
  readonly matches: boolean;
}

/** Minimal `window` surface used by `readViewportEnvironment`. */
export interface WindowLike {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  matchMedia?: (query: string) => MediaQueryListLike;
}

const TV_OVERRIDE_VALUES = new Set(["1", "true", "yes", "on"]);
const NON_TV_OVERRIDE_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Parses `?tv=1` / `?tv=0` from a location search string.
 * Returns `null` when the parameter is absent or not a recognised value.
 */
export function parseTvOverride(search: string | undefined): boolean | null {
  if (search === undefined || search.length === 0) {
    return null;
  }
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const value = new URLSearchParams(raw).get("tv");
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (TV_OVERRIDE_VALUES.has(normalized)) {
    return true;
  }
  if (NON_TV_OVERRIDE_VALUES.has(normalized)) {
    return false;
  }
  return null;
}

function isPositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * Viewport + modality classification, without the override. Exposed for tests
 * and the debug overlay so the reason for a profile is inspectable.
 */
export function classifyDisplayClass(env: ViewportEnvironment): {
  readonly mode: DisplayClass;
  readonly reason: TvProfileReason;
} {
  const width = isPositive(env.width) ? env.width : 0;
  const height = isPositive(env.height) ? env.height : 0;
  const large = width >= MIN_RENDER_WIDTH && height >= MIN_RENDER_HEIGHT;

  if (large && !env.modality.finePointer) {
    return { mode: "tv", reason: "large-viewport-no-fine-pointer" };
  }
  if (large) {
    return { mode: "desktop", reason: "fine-pointer" };
  }
  if (env.modality.coarsePointer && !env.modality.finePointer) {
    return { mode: "phone", reason: "small-viewport" };
  }
  return { mode: "desktop", reason: "small-viewport" };
}

/** Clamps the device DPR to the documented non-TV range of 1..2 (FR-9.4). */
export function clampDpr(devicePixelRatio: number): number {
  const dpr = isPositive(devicePixelRatio) ? devicePixelRatio : 1;
  return Math.min(Math.max(dpr, 1), MAX_NON_TV_DPR);
}

/**
 * Builds the display profile. Pass `window.location.search` to honour the
 * `?tv=1` / `?tv=0` override; omit it in tests.
 */
export function resolveTvProfile(
  env: ViewportEnvironment,
  search?: string,
): TvProfile {
  const detected = classifyDisplayClass(env);
  const override = parseTvOverride(search);

  let mode: DisplayClass;
  let reason: TvProfileReason;
  if (override === true) {
    mode = "tv";
    reason = "forced-tv";
  } else if (override === false) {
    mode = detected.mode === "tv" ? "desktop" : detected.mode;
    reason = "forced-non-tv";
  } else {
    mode = detected.mode;
    reason = detected.reason;
  }

  const tv = mode === "tv";
  return {
    mode,
    dpr: tv ? TV_DPR : clampDpr(env.devicePixelRatio),
    maxRenderHeight: tv ? TV_MAX_RENDER_HEIGHT : 0,
    cssUpscale: tv,
    reason,
    targetFps: FRAME_TARGET_FPS,
    floorFps: FRAME_FLOOR_FPS,
    targetFrameMs: FRAME_INTERVAL_60HZ_MS,
    floorFrameMs: FRAME_INTERVAL_30HZ_MS,
  };
}

function readMatches(
  win: WindowLike,
  query: string,
  fallback: boolean,
): boolean {
  if (win.matchMedia === undefined) {
    return fallback;
  }
  try {
    return win.matchMedia(query).matches;
  } catch {
    return fallback;
  }
}

/**
 * Reads the viewport and input modality from a window-like object.
 *
 * When `matchMedia` is unavailable (not the case for any supported browser)
 * the fine-pointer query falls back to `true`, so an unknown environment keeps
 * the desktop profile instead of silently dropping a device to DPR 1. Pass the
 * real `window` from the host; tests pass a literal.
 */
export function readViewportEnvironment(win: WindowLike): ViewportEnvironment {
  return {
    width: win.innerWidth,
    height: win.innerHeight,
    devicePixelRatio: win.devicePixelRatio,
    modality: {
      finePointer: readMatches(win, "(any-pointer: fine)", true),
      coarsePointer: readMatches(win, "(any-pointer: coarse)", false),
      hover: readMatches(win, "(any-hover: hover)", false),
    },
  };
}

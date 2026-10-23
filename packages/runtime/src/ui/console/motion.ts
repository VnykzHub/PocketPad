/**
 * Motion tiers for the console shell (DESIGN.md console-shell tier, D3).
 *
 * The tier is resolved once, from an explicit low-tier classification or a
 * `prefers-reduced-motion` read. The shell never installs a `matchMedia`
 * change listener: a page reload or system setting change re-resolves it, and
 * the launcher owns no long-lived media listener it would have to free.
 */
import type { MotionTier } from "./types.js";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export interface MotionPreferences {
  readonly prefersReducedMotion?: boolean;
  readonly lowTier?: boolean;
}

/** Reduced wins over full whenever either signal is set. */
export function resolveMotionTier(
  preferences: MotionPreferences = {},
): MotionTier {
  return preferences.prefersReducedMotion === true || preferences.lowTier === true
    ? "reduced"
    : "full";
}

/**
 * Reads the user's reduced-motion preference. Guarded for Node tests and for
 * TV browsers without `matchMedia`; absence means full tier.
 */
export function readPrefersReducedMotion(doc: Document): boolean {
  try {
    const view = doc.defaultView;
    if (view === null || typeof view.matchMedia !== "function") return false;
    return view.matchMedia(REDUCED_MOTION_QUERY).matches === true;
  } catch {
    return false;
  }
}

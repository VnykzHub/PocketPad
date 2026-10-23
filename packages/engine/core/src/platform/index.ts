/**
 * `@lanpad/engine-core` platform subtree barrel (00 D11, spec 01 §3.4).
 *
 * This is the only subtree allowed browser globals. Everything here is a seam:
 * a browser adapter or a deterministic double. Simulation modules must import
 * from this barrel, never from `globalThis` directly.
 */
export { createBrowserScheduler, ManualScheduler } from "./frameScheduler.js";
export { detectPlatformProfile, readPlatformGlobals } from "./deviceProfile.js";
export type {
  MediaQueryListLike,
  PlatformGlobals,
  PlatformNavigatorLike,
  PlatformProfile,
} from "./deviceProfile.js";

/**
 * Platform capability profile (00 D11; spec 01 §3.2).
 *
 * Capability detection only: every field is derived from an observable API,
 * never from `navigator.userAgent` (FR-12.1). The browser globals are passed
 * in as a structural object so tests can supply a literal and so this module
 * compiles without assuming a particular DOM surface; `readPlatformGlobals`
 * is the one function that touches `globalThis`.
 *
 * A zero `hardwareConcurrency` or `deviceMemoryGb` means "not reported", not
 * "zero cores". `deviceMemoryGb` is the browser's capped estimate.
 */

/** Minimal navigator surface; every field is optional and unknown-typed. */
export interface PlatformNavigatorLike {
  readonly gpu?: unknown;
  readonly getGamepads?: unknown;
  readonly vibrate?: unknown;
  readonly hardwareConcurrency?: number;
  readonly deviceMemory?: number;
  readonly maxTouchPoints?: number;
}

/** The subset of `MediaQueryList` this module reads. */
export interface MediaQueryListLike {
  readonly matches: boolean;
}

/** All browser globals the profile reads; pass a literal in tests. */
export interface PlatformGlobals {
  readonly isSecureContext?: boolean;
  readonly navigator?: PlatformNavigatorLike;
  readonly Worker?: unknown;
  readonly SharedArrayBuffer?: unknown;
  readonly OffscreenCanvas?: unknown;
  readonly DeviceMotionEvent?: unknown;
  readonly matchMedia?: (query: string) => MediaQueryListLike;
}

export interface PlatformProfile {
  readonly secureContext: boolean;
  /** `navigator.gpu` exists; the WebGPU backend still has to request a device. */
  readonly webgpu: boolean;
  readonly workers: boolean;
  readonly sharedArrayBuffer: boolean;
  readonly offscreenCanvas: boolean;
  readonly gamepad: boolean;
  /** `maxTouchPoints > 0`. */
  readonly touch: boolean;
  readonly maxTouchPoints: number;
  readonly vibration: boolean;
  readonly deviceMotion: boolean;
  readonly matchMedia: boolean;
  readonly finePointer: boolean;
  readonly coarsePointer: boolean;
  readonly hover: boolean;
  /** Logical cores, or 0 when unreported. */
  readonly hardwareConcurrency: number;
  /** Browser-reported device memory in GB, or 0 when unreported. */
  readonly deviceMemoryGb: number;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isFunction(value: unknown): boolean {
  return typeof value === "function";
}

function positiveIntegerOrZero(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function positiveNumberOrZero(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

function readMatches(globals: PlatformGlobals, query: string): boolean {
  if (globals.matchMedia === undefined) {
    return false;
  }
  try {
    return globals.matchMedia(query).matches === true;
  } catch {
    return false;
  }
}

/**
 * Reads the real environment. This is the browser seam: no other module in
 * `engine-core` may touch `globalThis` for capabilities.
 */
export function readPlatformGlobals(): PlatformGlobals {
  return globalThis as unknown as PlatformGlobals;
}

/** Builds the profile from injected globals; performs no UA parsing. */
export function detectPlatformProfile(
  globals: PlatformGlobals = readPlatformGlobals(),
): PlatformProfile {
  const navigator = globals.navigator;
  const maxTouchPoints = positiveIntegerOrZero(navigator?.maxTouchPoints);
  const hasMatchMedia = isFunction(globals.matchMedia);

  return {
    secureContext: globals.isSecureContext === true,
    webgpu: isPresent(navigator?.gpu),
    workers: isFunction(globals.Worker),
    sharedArrayBuffer: isFunction(globals.SharedArrayBuffer),
    offscreenCanvas: isFunction(globals.OffscreenCanvas),
    gamepad: isFunction(navigator?.getGamepads),
    touch: maxTouchPoints > 0,
    maxTouchPoints,
    vibration: isFunction(navigator?.vibrate),
    deviceMotion: isFunction(globals.DeviceMotionEvent),
    matchMedia: hasMatchMedia,
    finePointer: hasMatchMedia && readMatches(globals, "(any-pointer: fine)"),
    coarsePointer: hasMatchMedia && readMatches(globals, "(any-pointer: coarse)"),
    hover: hasMatchMedia && readMatches(globals, "(any-hover: hover)"),
    hardwareConcurrency: positiveIntegerOrZero(navigator?.hardwareConcurrency),
    deviceMemoryGb: positiveNumberOrZero(navigator?.deviceMemory),
  };
}

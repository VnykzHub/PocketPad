/**
 * Motion permission feature detection (D6-CTRL-01; FR-8.10, E7).
 *
 * `DeviceMotionEvent.requestPermission` exists only on some iOS browsers, and
 * motion events are only delivered in a secure context. This module answers
 * three questions without touching globals at import time:
 *
 *   1. Can this environment deliver `devicemotion` at all?
 *   2. Does it need an explicit permission gesture?
 *   3. Did that request succeed?
 *
 * It deliberately avoids user-agent sniffing. The environment is either passed
 * in by tests or read lazily from `globalThis` by the gyro runtime.
 */

/** Result of an explicit motion permission request. */
export type MotionPermissionState = "granted" | "denied";

/**
 * Why motion is or is not available.
 * - `supported`: events flow without a prompt (Android/desktop browsers).
 * - `permission-required`: `DeviceMotionEvent.requestPermission` exists.
 * - `unsupported`: no `DeviceMotionEvent` constructor in a secure context.
 * - `insecure-context`: the page is not served over HTTPS/localhost.
 */
export type MotionSupport =
  | "supported"
  | "permission-required"
  | "unsupported"
  | "insecure-context";

/** The minimum environment facts permission logic needs. */
export interface MotionEnvironment {
  readonly isSecureContext: boolean;
  readonly hasDeviceMotionEvent: boolean;
  /**
   * Present only when the browser exposes a static
   * `DeviceMotionEvent.requestPermission`. Returns the browser's answer; only
   * the exact string "granted" counts as granted.
   */
  readonly requestPermission?: (() => Promise<unknown>) | undefined;
}

/** Structural subset of `globalThis` used for lazy feature detection. */
export interface MotionEnvironmentScope {
  readonly isSecureContext?: boolean | undefined;
  readonly DeviceMotionEvent?: unknown;
}

/**
 * Pure feature-detection decision. Secure context wins: even a browser with a
 * `DeviceMotionEvent` constructor cannot deliver events over plain HTTP.
 */
export function resolveMotionSupport(environment: MotionEnvironment): MotionSupport {
  if (!environment.isSecureContext) {
    return "insecure-context";
  }
  if (!environment.hasDeviceMotionEvent) {
    return "unsupported";
  }
  if (environment.requestPermission !== undefined) {
    return "permission-required";
  }
  return "supported";
}

/**
 * Requests motion permission when one is needed.
 *
 * - Unsupported/insecure environments resolve `denied` without calling out.
 * - Environments that need no prompt resolve `granted`.
 * - A thrown request or any answer other than "granted" resolves `denied`, so
 *   the caller always has a safe fallback (FR-8.10).
 */
export async function requestMotionPermission(
  environment: MotionEnvironment,
): Promise<MotionPermissionState> {
  const support = resolveMotionSupport(environment);
  if (support === "insecure-context" || support === "unsupported") {
    return "denied";
  }
  if (support === "supported") {
    return "granted";
  }

  const request = environment.requestPermission;
  if (request === undefined) {
    return "granted";
  }

  try {
    const answer = await request();
    return answer === "granted" ? "granted" : "denied";
  } catch {
    // A rejected permission prompt is indistinguishable from denial for the
    // user experience; both fall back to touch controls.
    return "denied";
  }
}

/**
 * Reads feature flags from `scope` (defaults to `globalThis`) on demand.
 *
 * `isSecureContext` must be literally true: an older browser that omits it
 * cannot be assumed to be secure. The returned `requestPermission` wrapper
 * preserves the static-method `this` binding some implementations require.
 */
export function readMotionEnvironment(
  scope?: MotionEnvironmentScope | null,
): MotionEnvironment {
  const target = scope ?? (globalThis as MotionEnvironmentScope);
  const constructorValue = target.DeviceMotionEvent;
  const hasDeviceMotionEvent = typeof constructorValue === "function";
  const base: MotionEnvironment = {
    isSecureContext: target.isSecureContext === true,
    hasDeviceMotionEvent,
  };

  const candidate =
    hasDeviceMotionEvent && constructorValue !== null
      ? (constructorValue as { requestPermission?: unknown }).requestPermission
      : undefined;

  if (typeof candidate !== "function") {
    return base;
  }

  return {
    ...base,
    requestPermission: () =>
      (candidate as () => Promise<unknown>).call(constructorValue),
  };
}

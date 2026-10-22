/**
 * Screen-relative rotation-rate remap (D6-CTRL-02; FR-7.5, E7).
 *
 * `DeviceMotionEvent.rotationRate` is expressed in device axes. Games consume
 * screen-relative rates, so the controller rotates beta/gamma by the current
 * `screen.orientation.angle` before filtering. This module is the single
 * platform-specific mapping: if E7 finds a browser with a different sign
 * convention, the table here changes and no game does.
 *
 * The formula is frozen from the D6 plan:
 *
 *   x =  cos(a) * gamma + sin(a) * beta
 *   y = -sin(a) * gamma + cos(a) * beta
 *   z =  alpha
 *
 * The goal in landscape is that tilting the phone's top edge away from the
 * player produces a positive forward (`y`) rate. E7 verifies the signs on real
 * hardware; the math below stays free of UA sniffing.
 */

/** Raw `rotationRate` triple, in degrees/second, as the browser reports it. */
export interface RotationRate {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
}

/** Remapped rate in screen-relative axes, in degrees/second. */
export interface RemappedRate {
  x: number;
  y: number;
  z: number;
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Wraps any finite angle into [0, 360); non-finite input becomes 0. */
export function normalizeScreenAngle(angleDeg: number): number {
  if (!Number.isFinite(angleDeg)) {
    return 0;
  }
  const wrapped = angleDeg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Rotates a raw `rotationRate` into screen axes.
 *
 * Null/undefined rotation rates and null components become 0; this function
 * never throws. `MotionSource` separately marks a null `rotationRate` as an
 * inactive sample.
 */
export function remapRotationRate(
  rate: RotationRate | null | undefined,
  screenAngleDeg: number,
): RemappedRate {
  if (rate === null || rate === undefined) {
    return { x: 0, y: 0, z: 0 };
  }

  const alpha = finiteOrZero(rate.alpha);
  const beta = finiteOrZero(rate.beta);
  const gamma = finiteOrZero(rate.gamma);
  const radians = (normalizeScreenAngle(screenAngleDeg) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return {
    x: cos * gamma + sin * beta,
    y: -sin * gamma + cos * beta,
    z: alpha,
  };
}

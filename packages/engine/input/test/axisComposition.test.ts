/**
 * ER-10-01 — action composition on the keyboard trace.
 *
 * The trace exercises the default map the way the placement test describes:
 * W held for three ticks, released, opposite keys together, a Space tap. The
 * property suites check the merge rules directly against a plain oracle:
 * vector2 sums components then normalizes above 1, axis sums then clamps,
 * button takes the maximum of scaled sources.
 */

import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  createActionReading,
  createInputRouter,
  createResolvedActionState,
  resolveAction,
} from "../src/index.js";
import type {
  ActionState,
  ActionReading,
  InputAction,
  InputActionKind,
  InputFrame,
} from "../src/index.js";

function stateOf(frame: InputFrame, name: string): ActionState {
  const state = frame.action(name);
  if (state === undefined) throw new Error(`unknown action ${name}`);
  return state;
}

interface ReadOptions {
  readonly x?: number;
  readonly y?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
  readonly digital?: boolean;
}

function toReading(options: ReadOptions): ActionReading {
  const reading = createActionReading();
  if (options.x !== undefined) {
    reading.hasX = true;
    reading.x = options.x;
    reading.scaleX = options.scaleX ?? 1;
  }
  if (options.y !== undefined) {
    reading.hasY = true;
    reading.y = options.y;
    reading.scaleY = options.scaleY ?? 1;
  }
  reading.digital = options.digital === true;
  return reading;
}

function resolveReadings(
  kind: InputActionKind,
  readings: readonly ActionReading[],
  options: { yUp?: boolean; threshold?: number; hysteresis?: number } = {},
): ActionState {
  const engaged = new Uint8Array(readings.length);
  const out = createResolvedActionState();
  resolveAction(
    kind,
    options.threshold ?? 0.5,
    options.hysteresis ?? 0.1,
    options.yUp === true,
    readings,
    engaged,
    false,
    out,
  );
  return out;
}

function vectorOracle(
  readings: readonly ActionReading[],
  yUp: boolean,
): { x: number; y: number; value: number } {
  let sx = 0;
  let sy = 0;
  for (const reading of readings) {
    if (reading.hasX) sx += reading.x * reading.scaleX;
    if (reading.hasY) sy += reading.y * reading.scaleY;
  }
  if (!Number.isFinite(sx)) sx = 0;
  if (!Number.isFinite(sy)) sy = 0;
  const length = Math.hypot(sx, sy);
  if (length > 1) {
    sx /= length;
    sy /= length;
  }
  return { x: sx, y: yUp ? -sy : sy, value: length > 1 ? 1 : length };
}

function axisOracle(readings: readonly ActionReading[]): {
  x: number;
  value: number;
} {
  let sum = 0;
  for (const reading of readings) {
    if (reading.hasX) sum += reading.x * reading.scaleX;
    if (reading.hasY) sum += reading.y * reading.scaleY;
  }
  const x = Number.isFinite(sum) ? Math.max(-1, Math.min(1, sum)) : 0;
  return { x, value: Math.abs(x) };
}

function buttonOracle(readings: readonly ActionReading[]): number {
  let merged = 0;
  for (const reading of readings) {
    if (reading.hasX) {
      const candidate = reading.x * reading.scaleX;
      if (candidate > merged) merged = candidate;
    }
    if (reading.hasY) {
      const candidate = reading.y * reading.scaleY;
      if (candidate > merged) merged = candidate;
    }
  }
  if (!Number.isFinite(merged)) return 0;
  return Math.max(0, Math.min(1, merged));
}

describe("keyboard composition", () => {
  test("[ER-10-01] the kb-move-v1 trace matches every tick", () => {
    const router = createInputRouter();

    // W held on ticks 0..2.
    router.setKeyboardKey("KeyW", true);
    const t0 = stateOf(router.poll(0), "move");
    expect(t0.x).toBe(0);
    expect(t0.y).toBe(1);
    expect(t0.value).toBe(1);
    expect(t0.pressed).toBe(true);
    expect(t0.edges).toBe(3);

    const t1 = stateOf(router.poll(1), "move");
    expect(t1.pressed).toBe(true);
    expect(t1.edges).toBe(0);
    const t2 = stateOf(router.poll(2), "move");
    expect(t2.pressed).toBe(true);
    expect(t2.x).toBe(0);
    expect(t2.y).toBe(1);

    // Released.
    router.setKeyboardKey("KeyW", false);
    const t3 = stateOf(router.poll(3), "move");
    expect(t3.value).toBe(0);
    expect(t3.pressed).toBe(false);
    expect(t3.releaseEdges).toBe(3);

    // A alone moves left; A+D together cancel.
    router.setKeyboardKey("KeyA", true);
    const t4 = stateOf(router.poll(4), "move");
    expect(t4.x).toBe(-1);
    // yUp can store negative zero when the summed y is zero.
    expect(t4.y).toBeCloseTo(0, 12);
    expect(t4.value).toBe(1);

    router.setKeyboardKey("KeyD", true);
    const t5 = stateOf(router.poll(5), "move");
    expect(t5.x).toBeCloseTo(0, 12);
    expect(t5.y).toBeCloseTo(0, 12);
    expect(t5.value).toBe(0);
    expect(t5.pressed).toBe(false);

    // Release both and tap Space in the same tick.
    router.setKeyboardKey("KeyA", false);
    router.setKeyboardKey("KeyD", false);
    router.setKeyboardKey("Space", true);
    router.setKeyboardKey("Space", false);
    const t6 = stateOf(router.poll(6), "primary");
    expect(t6.pressed).toBe(false);
    expect(t6.value).toBe(0);
    expect(t6.edges).toBe(3);
    expect(t6.releaseEdges).toBe(3);

    const t7 = stateOf(router.poll(7), "primary");
    expect(t7.edges).toBe(0);
    expect(t7.releaseEdges).toBe(0);
  });

  test("[ER-10-01] orthogonal directions normalize to a unit diagonal", () => {
    const router = createInputRouter();
    router.setKeyboardKey("KeyW", true);
    router.setKeyboardKey("KeyD", true);

    const move = stateOf(router.poll(0), "move");
    expect(move.x).toBeCloseTo(Math.SQRT1_2, 12);
    // yUp: W's scale -1 is stored as +1 before the sticky y flip.
    expect(move.y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(move.value).toBeCloseTo(1, 12);
    expect(move.pressed).toBe(true);
  });

  test("[ER-10-01] opposite directions cancel before normalization", () => {
    const router = createInputRouter();
    router.setKeyboardKey("KeyW", true);
    router.setKeyboardKey("KeyS", true);
    const vertical = stateOf(router.poll(0), "move");
    expect(vertical.x).toBe(0);
    expect(vertical.y).toBeCloseTo(0, 12);
    expect(vertical.value).toBe(0);
    expect(vertical.pressed).toBe(false);

    router.setKeyboardKey("KeyW", false);
    router.setKeyboardKey("KeyS", false);
    router.setKeyboardKey("KeyA", true);
    router.setKeyboardKey("KeyD", true);
    const horizontal = stateOf(router.poll(1), "move");
    expect(horizontal.x).toBeCloseTo(0, 12);
    expect(horizontal.y).toBeCloseTo(0, 12);
    expect(horizontal.value).toBe(0);
  });

  test("[ER-10-01] button sources merge by max, not by sum", () => {
    const actions: InputAction[] = [
      {
        name: "power",
        kind: "button",
        bindings: [
          { device: "keyboard", code: "Space", scale: 0.5 },
          { device: "keyboard", code: "Enter", scale: 0.7 },
        ],
      },
    ];
    const router = createInputRouter({ actions });
    router.setKeyboardKey("Space", true);
    router.setKeyboardKey("Enter", true);

    const power = stateOf(router.poll(0), "power");
    expect(power.value).toBeCloseTo(0.7, 12);
    expect(power.pressed).toBe(true);
  });

  test("[ER-10-01] axis sources sum before the clamp", () => {
    const actions: InputAction[] = [
      {
        name: "turn",
        kind: "axis",
        bindings: [
          { device: "keyboard", code: "KeyA", scale: -1 },
          { device: "keyboard", code: "KeyD", scale: 1 },
        ],
      },
    ];
    const router = createInputRouter({ actions });
    router.setKeyboardKey("KeyD", true);
    expect(stateOf(router.poll(0), "turn").x).toBe(1);
    router.setKeyboardKey("KeyA", true);
    expect(stateOf(router.poll(1), "turn").x).toBe(0);
    router.setKeyboardKey("KeyD", false);
    expect(stateOf(router.poll(2), "turn").x).toBe(-1);
  });
});

const componentGen = fc.record({
  hasX: fc.boolean(),
  hasY: fc.boolean(),
  x: fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
  y: fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
  scaleX: fc.double({ min: -4, max: 4, noNaN: true, noDefaultInfinity: true }),
  scaleY: fc.double({ min: -4, max: 4, noNaN: true, noDefaultInfinity: true }),
});

const thresholdGen = fc.double({ min: 0.01, max: 1, noNaN: true });
const hysteresisGen = fc.double({ min: 0, max: 0.5, noNaN: true });

function buildReadings(
  specs: readonly {
    hasX: boolean;
    hasY: boolean;
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
  }[],
): ActionReading[] {
  const readings: ActionReading[] = [];
  for (const spec of specs) {
    readings.push(
      toReading({
        ...(spec.hasX ? { x: spec.x, scaleX: spec.scaleX } : {}),
        ...(spec.hasY ? { y: spec.y, scaleY: spec.scaleY } : {}),
      }),
    );
  }
  return readings;
}

describe("composition properties", () => {
  test(
    "[ER-10-01] 10,000 vector2 merges match the sum-then-normalize oracle",
    () => {
      fc.assert(
        fc.property(
          fc.array(componentGen, { maxLength: 8 }),
          fc.boolean(),
          thresholdGen,
          hysteresisGen,
          (specs, yUp, threshold, hysteresis) => {
            const readings = buildReadings(specs);
            const out = resolveReadings("vector2", readings, {
              yUp,
              threshold,
              hysteresis,
            });
            const expected = vectorOracle(readings, yUp);
            expect(Math.abs(out.x - expected.x)).toBeLessThanOrEqual(1e-12);
            expect(Math.abs(out.y - expected.y)).toBeLessThanOrEqual(1e-12);
            expect(Math.abs(out.value - expected.value)).toBeLessThanOrEqual(1e-12);
            expect(out.pressed).toBe(expected.value >= threshold);
            expect(out.released).toBe(expected.value <= threshold - hysteresis);
          },
        ),
        { numRuns: 10_000 },
      );
    },
    30_000,
  );

  test(
    "[ER-10-01] 10,000 axis merges match the sum-and-clamp oracle",
    () => {
      fc.assert(
        fc.property(
          fc.array(componentGen, { maxLength: 8 }),
          thresholdGen,
          hysteresisGen,
          (specs, threshold, hysteresis) => {
            const readings = buildReadings(specs);
            const out = resolveReadings("axis", readings, {
              threshold,
              hysteresis,
            });
            const expected = axisOracle(readings);
            expect(Math.abs(out.x - expected.x)).toBeLessThanOrEqual(1e-12);
            expect(out.y).toBe(0);
            expect(Math.abs(out.value - expected.value)).toBeLessThanOrEqual(1e-12);
            expect(out.pressed).toBe(expected.value >= threshold);
            expect(out.released).toBe(expected.value <= threshold - hysteresis);
          },
        ),
        { numRuns: 10_000 },
      );
    },
    30_000,
  );

  test(
    "[ER-10-01] 10,000 button merges match the max-of-scaled-sources oracle",
    () => {
      fc.assert(
        fc.property(
          fc.array(componentGen, { maxLength: 8 }),
          thresholdGen,
          hysteresisGen,
          (specs, threshold, hysteresis) => {
            const readings = buildReadings(specs);
            const out = resolveReadings("button", readings, {
              threshold,
              hysteresis,
            });
            const expected = buttonOracle(readings);
            expect(Math.abs(out.value - expected)).toBeLessThanOrEqual(1e-12);
            expect(out.x).toBeCloseTo(expected, 12);
            expect(out.y).toBe(0);
            const pressed = expected >= threshold;
            expect(out.pressed).toBe(pressed);
            expect(out.released).toBe(!pressed);
          },
        ),
        { numRuns: 10_000 },
      );
    },
    30_000,
  );
});

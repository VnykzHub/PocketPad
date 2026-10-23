/**
 * ER-10-05 — deadzone math and the pure action resolver.
 *
 * Every `deadzone-cases.json` fixture case is applied to one binding and
 * resolved through the real `resolveAction`, then compared field-by-field.
 * Property suites cover finiteness, bounds, continuity, monotonicity, sign
 * symmetry and exact pass-through at deadzone 0.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  applyRadialDeadzone,
  createActionReading,
  createResolvedActionState,
  resolveAction,
  scalarDeadzone,
} from "../src/index.js";
import type { InputActionKind } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

interface FixtureCase {
  readonly id: string;
  readonly kind: "radial" | "scalar" | "digital" | "button-analog";
  readonly deadzone: number;
  readonly threshold: number;
  readonly hysteresis: number;
  readonly yUp: boolean;
  readonly previous: { readonly pressed: boolean; readonly engaged: boolean };
  readonly raw: {
    readonly x?: number;
    readonly y?: number;
    readonly value?: number;
    readonly level?: number;
  };
  readonly pending?: { readonly press: boolean; readonly release: boolean };
  readonly expect: {
    readonly x: number;
    readonly y: number;
    readonly value: number;
    readonly pressed: boolean;
    readonly engaged: boolean;
    readonly edges: number;
    readonly released: boolean;
    readonly releaseEdges: number;
  };
}

interface FixtureFile {
  readonly tolerance: number;
  readonly cases: readonly FixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(join(FIXTURES, "deadzone-cases.json"), "utf8"),
) as FixtureFile;

describe("deadzone fixtures", () => {
  for (const item of fixture.cases) {
    test(`[ER-10-05] ${item.id} matches the expected action state`, () => {
      const reading = createActionReading();
      reading.digital = item.kind === "digital";
      reading.pendingPress = item.pending?.press === true;
      reading.pendingRelease = item.pending?.release === true;

      let kind: InputActionKind;
      if (item.kind === "radial") {
        kind = "vector2";
        const pair = applyRadialDeadzone(
          item.raw.x ?? 0,
          item.raw.y ?? 0,
          item.deadzone,
        );
        reading.hasX = true;
        reading.x = pair.x;
        reading.hasY = true;
        reading.y = pair.y;
      } else {
        const raw =
          item.kind === "digital"
            ? (item.raw.level ?? 0)
            : (item.raw.value ?? item.raw.level ?? 0);
        reading.hasX = true;
        reading.x = scalarDeadzone(raw, item.deadzone);
        kind = item.kind === "scalar" ? "axis" : "button";
      }

      const previousEngaged = new Uint8Array([item.previous.engaged ? 1 : 0]);
      const out = createResolvedActionState();
      resolveAction(
        kind,
        item.threshold,
        item.hysteresis,
        item.yUp,
        [reading],
        previousEngaged,
        item.previous.pressed,
        out,
      );

      const epsilon = fixture.tolerance;
      expect(Math.abs(out.x - item.expect.x)).toBeLessThanOrEqual(epsilon);
      expect(Math.abs(out.y - item.expect.y)).toBeLessThanOrEqual(epsilon);
      expect(Math.abs(out.value - item.expect.value)).toBeLessThanOrEqual(epsilon);
      expect(out.pressed).toBe(item.expect.pressed);
      expect(out.released).toBe(item.expect.released);
      expect(out.edges).toBe(item.expect.edges);
      expect(out.releaseEdges).toBe(item.expect.releaseEdges);
      expect(previousEngaged[0] === 1).toBe(item.expect.engaged);
    });
  }
});

// Source levels are normalized to -1..1 before the deadzone (10 §5.8.2).
const finite = fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true });
const deadzone = fc.double({ min: 0, max: 0.9, noNaN: true });

describe("deadzone properties", () => {
  test(
    "[ER-10-05] 10,000 radial inputs stay finite, bounded and exact at deadzone 0",
    () => {
      // The deadzone is defined for normalized inputs (10 §5.8.2); sample the
      // unit disk so magnitude never exceeds 1 before rounding.
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
          deadzone,
          (magnitude, angle, dz) => {
            const x = Math.cos(angle) * magnitude;
            const y = Math.sin(angle) * magnitude;
            const out = applyRadialDeadzone(x, y, dz);
            expect(Number.isFinite(out.x)).toBe(true);
            expect(Number.isFinite(out.y)).toBe(true);
            // A normalized input maps inside the unit circle; allow FP
            // rounding on the angle reconstruction.
            expect(Math.hypot(out.x, out.y)).toBeLessThanOrEqual(1.001);
            if (dz === 0) {
              expect(out.x).toBe(x);
              expect(out.y).toBe(y);
            }
          },
        ),
        { numRuns: 10_000 },
      );
    },
    30_000,
  );

  test(
    "[ER-10-05] 10,000 radial magnitudes are monotonic along a fixed direction",
    () => {
      fc.assert(
        fc.property(
          fc.double({ min: -1, max: 1, noNaN: true }),
          fc.double({ min: -1, max: 1, noNaN: true }),
          fc.double({ min: 0, max: 0.85, noNaN: true }),
          fc.double({ min: 0, max: 0.3, noNaN: true }),
          fc.double({ min: 0, max: 0.3, noNaN: true }),
          (x, y, dz, first, second) => {
            const length = Math.hypot(x, y);
            fc.pre(length > 0.05);
            const near = dz + 0.01 + first;
            const far = near + 0.001 + second;
            const a = applyRadialDeadzone(
              (x / length) * near,
              (y / length) * near,
              dz,
            );
            const b = applyRadialDeadzone(
              (x / length) * far,
              (y / length) * far,
              dz,
            );
            expect(Math.hypot(a.x, a.y)).toBeLessThanOrEqual(
              Math.hypot(b.x, b.y) + 1e-12,
            );
          },
        ),
        { numRuns: 10_000 },
      );
    },
    30_000,
  );

  test(
    "[ER-10-05] 10,000 radial inputs are continuous at the deadzone boundary",
    () => {
      fc.assert(
        fc.property(
          fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
          fc.double({ min: 0.0001, max: 0.85, noNaN: true }),
          (angle, dz) => {
            const inside = dz - 1e-6;
            const outside = dz + 1e-6;
            const zero = applyRadialDeadzone(
              Math.cos(angle) * inside,
              Math.sin(angle) * inside,
              dz,
            );
            const edge = applyRadialDeadzone(
              Math.cos(angle) * outside,
              Math.sin(angle) * outside,
              dz,
            );
            expect(Math.hypot(zero.x, zero.y)).toBe(0);
            expect(Math.hypot(edge.x, edge.y)).toBeLessThan(2e-5);
          },
        ),
        { numRuns: 10_000 },
      );
    },
    30_000,
  );

  test(
    "[ER-10-05] deadzone never amplifies a near-full scalar",
    () => {
      // fast-check seed 458580302 counterexample: the raw formula rounded one
      // ulp above the input. Clamping keeps the non-amplification invariant.
      const value = 0.9999999999999997;
      const dz = 0.16872901594872886;
      const out = scalarDeadzone(value, dz);
      expect(Math.abs(out)).toBeLessThanOrEqual(Math.abs(value));
      expect(scalarDeadzone(-value, dz)).toBe(-out);
    },
    30_000,
  );

  test(
    "[ER-10-05] 10,000 scalar inputs are odd, bounded and exact at deadzone 0",
    () => {
      fc.assert(
        fc.property(finite, deadzone, (value, dz) => {
          const out = scalarDeadzone(value, dz);
          const mirrored = scalarDeadzone(-value, dz);
          expect(Number.isFinite(out)).toBe(true);
          expect(Math.abs(out)).toBeLessThanOrEqual(1);
          expect(Math.abs(out + mirrored)).toBeLessThanOrEqual(1e-12);
          expect(Math.abs(out)).toBeLessThanOrEqual(Math.abs(value));
          if (dz === 0) {
            expect(out === value || (out === 0 && value === 0)).toBe(true);
          }
        }),
        { numRuns: 10_000 },
      );
    },
    30_000,
  );
});

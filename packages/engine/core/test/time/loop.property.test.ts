/**
 * Accumulator property tests (01 §7, ER-01-05).
 *
 * Every frame delta, including NaN, infinities, negative values and 1e9, must
 * produce an integer step count in `[0, maxCatchUpSteps]`, a non-decreasing
 * tick and an alpha in `[0, 1)`. Failures throw a plain Error instead of using
 * `expect` inside the property: 10,000 cases with dozens of expectations each
 * would dominate the test runtime.
 */
import fc from "fast-check";
import { expect, test } from "vitest";
import { DT_SECONDS, LoopClock } from "../../src/time/index.js";

const MAX_STEPS = 5;
const MAX_ACCUMULATED = MAX_STEPS * DT_SECONDS;
const FLOAT_SLACK = 1e-9;

const FRAME_DELTAS = fc.oneof(
  fc.double({ min: -1e9, max: 1e9 }),
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e9,
    -1e9,
    0,
  ),
);

test("[ER-01-05] arbitrary frame deltas yield 0-5 integer steps and alpha in [0,1)", () => {
  fc.assert(
    fc.property(
      fc.array(FRAME_DELTAS, { minLength: 1, maxLength: 64 }),
      (deltas) => {
        const clock = new LoopClock(DT_SECONDS, MAX_STEPS);
        clock.reset(0);

        let nowMs = 0;
        let previousTick = clock.tick;

        for (const delta of deltas) {
          nowMs += Number.isFinite(delta) ? delta : 0;
          const timestamp = Number.isFinite(delta) ? nowMs : delta;
          const steps = clock.beginFrame(timestamp);

          if (!Number.isInteger(steps) || steps < 0 || steps > MAX_STEPS) {
            throw new Error(
              `beginFrame(${String(timestamp)}) returned ${String(steps)}`,
            );
          }

          for (let step = 0; step < steps; step += 1) {
            clock.consumeStep();
          }

          if (clock.tick !== previousTick + steps) {
            throw new Error(
              `tick ${String(clock.tick)} !== ${String(previousTick)} + ${String(steps)}`,
            );
          }
          previousTick = clock.tick;

          const alpha = clock.alpha(false);
          if (!(alpha >= 0 && alpha < 1)) {
            throw new Error(`alpha ${String(alpha)} is outside [0, 1)`);
          }

          const accumulated = clock.accumulatorSeconds;
          if (
            !(accumulated >= 0) ||
            accumulated > MAX_ACCUMULATED + FLOAT_SLACK
          ) {
            throw new Error(
              `accumulator ${String(accumulated)} exceeds the clamp`,
            );
          }
        }
      },
    ),
    { numRuns: 10_000 },
  );
});

test("[ER-01-05] the first beginFrame only establishes a baseline", () => {
  const clock = new LoopClock(DT_SECONDS, MAX_STEPS);

  expect(clock.beginFrame(1000)).toBe(0);
  expect(clock.tick).toBe(0);
  expect(clock.alpha(false)).toBe(0);

  expect(clock.beginFrame(1017)).toBe(1);
  expect(clock.tick).toBe(0);
  clock.consumeStep();
  expect(clock.tick).toBe(1);
});

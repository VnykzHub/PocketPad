/**
 * Golden trace replay tests (D2-QA-01, SPEC §16).
 *
 * Every JSON file in `test/fixtures/traces/` is data: packets in, mapper polls
 * out. The auto-discovery test proves the whole recorded set still replays,
 * so a new game trace is exercised as soon as it is dropped in the directory.
 * The narrower tests below name the trace that pins each D2 requirement.
 *
 * Traces record behaviour, not timing. G2's latency measurement stays in D3's
 * E5 harness; here a trace only proves that the mapper adds no poll interval
 * to a press that was sent between two host ticks.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  loadTraceFixtures,
  replayTrace,
  type TraceFixture,
} from "./helpers/traceRunner";

const TRACES_DIRECTORY = fileURLToPath(
  new URL("./fixtures/traces/", import.meta.url),
);

const fixtures: TraceFixture[] = loadTraceFixtures(TRACES_DIRECTORY);
const fixturesByName = new Map(
  fixtures.map((fixture) => [fixture.name, fixture]),
);

function replay(name: string): void {
  const fixture = fixturesByName.get(name);
  if (fixture === undefined) {
    throw new Error(`Missing trace fixture "${name}" in ${TRACES_DIRECTORY}.`);
  }
  replayTrace(fixture);
}

describe("golden traces (§16)", () => {
  test("[G2] every recorded golden trace replays through the D2-RT-01 mapper", () => {
    // D2-QA-01 requires at least these five cases; later stages may add more.
    for (const required of [
      "sub-tick-tap",
      "two-presses-one-tick",
      "press-and-hold",
      "stale-packet",
      "eight-slots",
    ]) {
      expect(fixturesByName.has(required), `required trace ${required}`).toBe(
        true,
      );
    }
    expect(fixtures.length).toBeGreaterThanOrEqual(5);

    for (const fixture of fixtures) {
      replayTrace(fixture);
    }
  });

  test("[FR-7.3] sub-tick taps reach the next poll as edges with level zero", () => {
    replay("sub-tick-tap");
    replay("tap-while-holding");
  });

  test("[FR-7.12] edges OR-accumulate across every packet in one host tick", () => {
    replay("two-presses-one-tick");
    replay("tap-while-holding");
  });

  test("[FR-7.11] stale level packets neither override a newer press nor clear a hold", () => {
    replay("stale-packet");
    replay("stale-release");
  });

  test("[FR-7.4] a configurable host deadzone cuts 7% and passes 20%", () => {
    replay("analog-deadzone");
  });

  test("[G2] a tap sent between host ticks is visible at the very first poll, not one poll later", () => {
    // The fixture expects edges 1 on host tick 1 and edges 0 on tick 2. The
    // edge therefore crosses the controller-to-host path inside one 16.67 ms
    // host frame; the mapper contributes no extra tick of delay.
    replay("sub-tick-tap");
  });
});

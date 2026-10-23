/**
 * Beat Tap song clock and note runtime (GAME-BT-HOST-02/03; G2, E11).
 *
 * The clock is audio-driven and pause-accumulating; the runtime owns note
 * consumption and expiration. Together they define when a press can still be
 * judged, independent of the adapter and the renderer.
 */
import { describe, expect, test } from "vitest";
import type { ChartItem } from "../src/chart.js";
import { createSongClock } from "../src/clock.js";
import { JUDGE_WINDOWS } from "../src/config.js";
import { createSongRuntime } from "../src/song.js";

function chart(notes: readonly { timeMs: number; lane: number }[], durationMs = 4000): ChartItem {
  return {
    id: "test-chart",
    title: "Test Chart",
    audio: "test/silent",
    bpm: 120,
    offsetMs: 0,
    durationMs,
    notes,
  };
}

describe("Beat Tap song clock", () => {
  test("[G2] time is derived from the audio timestamp and clamps at zero", () => {
    const clock = createSongClock();
    expect(clock.started).toBe(false);
    expect(clock.timeMs(10_000)).toBe(0);

    clock.start(1000, 0);
    expect(clock.started).toBe(true);
    expect(clock.timeMs(1000)).toBe(0);
    expect(clock.timeMs(1500)).toBe(500);
    expect(clock.timeMs(900)).toBe(0);
  });

  test("[G2] the chart offset shifts the timeline and non-finite starts are ignored", () => {
    const clock = createSongClock();
    clock.start(1000, 200);
    expect(clock.timeMs(1500)).toBe(300);

    clock.reset();
    clock.start(Number.NaN, 0);
    expect(clock.started).toBe(false);
  });

  test("[G2] pause freezes time and resume skips the frozen interval", () => {
    const clock = createSongClock();
    clock.start(0, 0);

    clock.pause(1000);
    expect(clock.paused).toBe(true);
    expect(clock.timeMs(5000)).toBe(1000);
    clock.pause(1500); // idempotent

    clock.resume(3000);
    expect(clock.paused).toBe(false);
    expect(clock.timeMs(3000)).toBe(1000);
    expect(clock.timeMs(3500)).toBe(1500);
    clock.resume(4000); // idempotent

    clock.pause(4000);
    clock.resume(5000);
    expect(clock.timeMs(7000)).toBe(4000);
  });

  test("[G2] reset clears the start, offset and pause accumulation", () => {
    const clock = createSongClock();
    clock.start(1000, 200);
    clock.pause(2000);
    clock.reset();
    expect(clock.started).toBe(false);
    expect(clock.paused).toBe(false);
    expect(clock.timeMs(10_000)).toBe(0);
  });
});

describe("Beat Tap note runtime", () => {
  test("[G2] a press outside ±140 ms does not consume the note", () => {
    const missed: number[] = [];
    const song = createSongRuntime(
      chart([{ timeMs: 1000, lane: 0 }]),
      JUDGE_WINDOWS,
      (lane) => missed.push(lane),
    );

    expect(song.hit(0, 859)).toBeNull(); // 141 ms early
    expect(song.hit(0, 1141)).toBeNull(); // 141 ms late
    expect(song.judgedCount).toBe(0);

    expect(song.hit(0, 1000)).toBe("perfect");
    expect(song.judgedCount).toBe(1);
    expect(song.hit(0, 1000)).toBeNull(); // already consumed
    expect(song.advance(5000)).toBe(0);
    expect(missed).toEqual([]);
  });

  test("[G2] the miss deadline is inclusive and expires one millisecond later", () => {
    const missed: number[] = [];
    const song = createSongRuntime(
      chart([{ timeMs: 1000, lane: 0 }]),
      JUDGE_WINDOWS,
      (lane) => missed.push(lane),
    );

    expect(song.advance(1140)).toBe(0);
    expect(song.judged[0]).toBe(0);
    expect(song.advance(1141)).toBe(1);
    expect(song.judged[0]).toBe(1);
    expect(missed).toEqual([0]);
    expect(song.hit(0, 1000)).toBeNull();
  });

  test("[G2] lanes are independent and finish force-misses every remaining note once", () => {
    const missed: number[] = [];
    const song = createSongRuntime(
      chart([
        { timeMs: 1000, lane: 0 },
        { timeMs: 2000, lane: 1 },
        { timeMs: 3000, lane: 2 },
      ]),
      JUDGE_WINDOWS,
      (lane) => missed.push(lane),
    );

    expect(song.noteCount).toBe(3);
    expect(song.hit(1, 2000)).toBe("perfect");
    expect(song.hit(0, 2000)).toBeNull(); // lane 0's note is 1000 ms away
    expect(song.advance(2500)).toBe(1); // only lane 0 expires
    expect(missed).toEqual([0]);

    expect(song.finish()).toBe(1); // lane 2 remains
    expect(song.judgedCount).toBe(3);
    expect(song.advance(9999)).toBe(0);
    expect(missed).toEqual([0, 2]);
  });

  test("[G2] reset re-arms every note for a replay", () => {
    const song = createSongRuntime(
      chart([{ timeMs: 1000, lane: 0 }]),
      JUDGE_WINDOWS,
      () => undefined,
    );
    expect(song.hit(0, 1000)).toBe("perfect");
    expect(song.judgedCount).toBe(1);
    song.reset();
    expect(song.judgedCount).toBe(0);
    expect(song.judged[0]).toBe(0);
    expect(song.hit(0, 1000)).toBe("perfect");
  });

  test("[G2] malformed lanes and timestamps are ignored, never thrown", () => {
    const song = createSongRuntime(
      chart([{ timeMs: 1000, lane: 0 }]),
      JUDGE_WINDOWS,
      () => undefined,
    );
    expect(song.hit(-1, 1000)).toBeNull();
    expect(song.hit(4, 1000)).toBeNull();
    expect(song.hit(0, Number.NaN)).toBeNull();
    expect(song.advance(Number.NaN)).toBe(0);
  });
});

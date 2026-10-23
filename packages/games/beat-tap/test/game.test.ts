/**
 * Beat Tap host adapter (GAME-BT-HOST-01..06; E9, E11, G5, G8, FR-8.2, PR-9.1,
 * PR-9.3).
 *
 * The adapter is driven through the same `GameContext` the runtime provides,
 * with an audio clock the test advances. Every press is timed relative to the
 * song clock, so the assertions describe real player timing rather than tick
 * counts.
 */
import { describe, expect, test } from "vitest";
import {
  createMemoryCalibrationStorage,
  loadCalibrationOffset,
  saveCalibrationOffset,
} from "../src/calibration.js";
import {
  CALIBRATE_BIT,
  CALIBRATE_LAYOUT_ID,
  CALIBRATION_STORAGE_KEY,
  DPAD_LAYOUT_ID,
  DUO_LAYOUT_ID,
  LANES_LAYOUT_ID,
  SOLO_LAYOUT_ID,
} from "../src/config.js";
import {
  createHarness,
  createTestPack,
  startSong,
  TEST_MANIFEST,
} from "./harness.js";

function manifestWith(overrides: Partial<typeof TEST_MANIFEST>) {
  return { ...TEST_MANIFEST, ...overrides };
}

/** A note that stays far away from the short tests that never reach it. */
const FAR_NOTE = { timeMs: 3900, lane: 0 } as const;

describe("Beat Tap layouts", () => {
  test("[E11] each slot receives one layout and unchanged layouts are not resent", () => {
    const solo = createHarness({ pack: createTestPack([FAR_NOTE]) });
    startSong(solo, [1]);
    expect(solo.layouts).toEqual([{ slot: 1, layoutId: LANES_LAYOUT_ID }]);
    expect(solo.game.laneOwners).toEqual([1, 1, 1, 1]);

    solo.step([1]);
    solo.step([1]);
    expect(solo.layouts).toHaveLength(1);

    const duo = createHarness({ pack: createTestPack([FAR_NOTE]) });
    startSong(duo, [1, 2]);
    expect(duo.layouts).toEqual([
      { slot: 1, layoutId: DUO_LAYOUT_ID },
      { slot: 2, layoutId: DUO_LAYOUT_ID },
    ]);
    expect(duo.game.laneOwners).toEqual([1, 1, 2, 2]);
  });

  test("[E11] the single-player d-pad option selects the d-pad document", () => {
    const harness = createHarness({
      pack: createTestPack([FAR_NOTE]),
      singlePlayerLayout: "dpad",
    });
    startSong(harness, [1]);
    expect(harness.layouts).toEqual([{ slot: 1, layoutId: DPAD_LAYOUT_ID }]);
  });

  test("[FR-8.2] CAL hot-swaps one phone to the calibration layout and back", () => {
    const harness = createHarness({
      pack: createTestPack([FAR_NOTE]),
      manifest: manifestWith({ minPlayers: 3 }),
    });
    harness.step([1, 2]);
    expect(harness.game.phase).toBe("lobby");
    expect(harness.layouts).toEqual([
      { slot: 1, layoutId: DUO_LAYOUT_ID },
      { slot: 2, layoutId: DUO_LAYOUT_ID },
    ]);

    harness.step([1, 2], { 1: 1 << CALIBRATE_BIT });
    expect(harness.game.phase).toBe("calibrating");
    expect(harness.layouts).toContainEqual({
      slot: 1,
      layoutId: CALIBRATE_LAYOUT_ID,
    });
    expect(harness.layouts).toContainEqual({ slot: 2, layoutId: DUO_LAYOUT_ID });

    harness.step([1, 2], { 1: 1 << CALIBRATE_BIT });
    expect(harness.game.phase).toBe("lobby");
    expect(harness.layouts[harness.layouts.length - 1]).toEqual({
      slot: 1,
      layoutId: DUO_LAYOUT_ID,
    });
  });
});

describe("Beat Tap judging and scoring", () => {
  test("[E11] a perfectly timed press scores 300 once and consumes its note", () => {
    const harness = createHarness({
      pack: createTestPack([{ timeMs: 1000, lane: 0 }]),
    });
    startSong(harness, [1]);

    harness.pressAtSongTime(1000, [1], { 1: 1 });
    expect(harness.game.playerStats[0]?.perfect).toBe(1);
    expect(harness.game.playerStats[0]?.combo).toBe(1);
    expect(harness.game.scoreboard.get(1)).toBe(300);

    harness.step([1], { 1: 1 });
    expect(harness.game.playerStats[0]?.perfect).toBe(1);
    expect(harness.game.scoreboard.get(1)).toBe(300);
  });

  test("[E11] combo extends on hits and resets on a graded miss, keeping the max", () => {
    const harness = createHarness({
      pack: createTestPack([
        { timeMs: 1000, lane: 0 },
        { timeMs: 2000, lane: 1 },
      ]),
    });
    startSong(harness, [1]);

    harness.pressAtSongTime(1000, [1], { 1: 1 });
    expect(harness.game.playerStats[0]?.combo).toBe(1);
    expect(harness.game.playerStats[0]?.maxCombo).toBe(1);

    // 116 ms late: inside the graded-miss window, so the note is consumed and
    // the combo breaks without erasing the best combo.
    harness.pressAtSongTime(2120, [1], { 1: 2 });
    expect(harness.game.playerStats[0]).toMatchObject({
      perfect: 1,
      miss: 1,
      combo: 0,
      maxCombo: 1,
    });
    expect(harness.game.scoreboard.get(1)).toBe(300);
  });

  test("[PR-9.3] a stored calibration offset shifts the judged window", () => {
    const late = createHarness({
      pack: createTestPack([{ timeMs: 1000, lane: 0 }]),
    });
    startSong(late, [1]);
    late.pressAtSongTime(1120, [1], { 1: 1 });
    expect(late.game.playerStats[0]?.miss).toBe(1);
    expect(late.game.scoreboard.get(1)).toBe(0);

    const storage = createMemoryCalibrationStorage();
    saveCalibrationOffset(storage, 100);
    const shifted = createHarness({
      pack: createTestPack([{ timeMs: 1000, lane: 0 }]),
      storage,
    });
    startSong(shifted, [1]);
    expect(shifted.game.calibrationOffsetMs).toBe(100);
    shifted.pressAtSongTime(1120, [1], { 1: 1 });
    expect(shifted.game.playerStats[0]?.perfect).toBe(1);
    expect(shifted.game.scoreboard.get(1)).toBe(300);
  });

  test("[PR-9.3] tap-to-beat calibration saves an offset and reset clears it", () => {
    const storage = createMemoryCalibrationStorage();
    const harness = createHarness({
      pack: createTestPack([FAR_NOTE]),
      manifest: manifestWith({ minPlayers: 2 }),
      storage,
    });
    harness.step([1]);
    expect(harness.game.startCalibration(1)).toBe(true);
    expect(harness.game.phase).toBe("calibrating");

    // The metronome starts at the calibration tick; the first tap lands at
    // tick 65 (~66.7 ms after the first 1000 ms beat) and repeats every beat.
    for (let index = 0; index < 63; index += 1) {
      harness.step([1]);
    }
    harness.step([1], { 1: 1 });
    for (let tap = 1; tap < 8; tap += 1) {
      for (let index = 0; index < 29; index += 1) {
        harness.step([1]);
      }
      harness.step([1], { 1: 1 });
    }

    expect(harness.game.calibrationOffsetMs).toBe(67);
    expect(harness.game.phase).toBe("lobby");
    expect(storage.read(CALIBRATION_STORAGE_KEY)).toBe(
      '{"version":1,"offsetMs":67}',
    );
    expect(loadCalibrationOffset(storage)).toBe(67);

    harness.game.resetCalibration();
    expect(harness.game.calibrationOffsetMs).toBe(0);
    expect(storage.read(CALIBRATION_STORAGE_KEY)).toBeNull();
  });

  test("[E9] the controller send time corrects press latency; without it the press misses", () => {
    const corrected = createHarness({
      pack: createTestPack([{ timeMs: 1000, lane: 0 }]),
      serverNow: () => 10_000,
    });
    startSong(corrected, [1]);
    corrected.pressAtSongTime(1120, [1], { 1: 1 }, 9_900);
    expect(corrected.game.playerStats[0]?.perfect).toBe(1);
    expect(corrected.game.scoreboard.get(1)).toBe(300);

    const uncorrected = createHarness({
      pack: createTestPack([{ timeMs: 1000, lane: 0 }]),
    });
    startSong(uncorrected, [1]);
    uncorrected.pressAtSongTime(1120, [1], { 1: 1 });
    expect(uncorrected.game.playerStats[0]?.miss).toBe(1);
  });
});

describe("Beat Tap pause and roster independence", () => {
  test("[E11] pause freezes the song and judging; resume lets the note expire", () => {
    const harness = createHarness({
      pack: createTestPack([{ timeMs: 1000, lane: 0 }]),
    });
    startSong(harness, [1]);
    harness.stepUntil(() => harness.game.songTimeMs >= 900, [1]);

    harness.game.pause();
    expect(harness.game.phase).toBe("paused");
    const frozenMs = harness.game.songTimeMs;
    for (let index = 0; index < 60; index += 1) {
      harness.step([1]);
    }
    expect(harness.game.songTimeMs).toBe(frozenMs);
    expect(harness.game.playerStats[0]?.miss).toBe(0);

    harness.game.resume();
    expect(harness.game.phase).toBe("playing");
    harness.stepUntil(
      () => (harness.game.playerStats[0]?.miss ?? 0) > 0,
      [1],
      60,
    );
    expect(harness.game.playerStats[0]?.miss).toBe(1);
    expect(harness.game.scoreboard.get(1)).toBe(0);
  });

  test("[E11] four players own one lane each and only the owning lane scores", () => {
    const harness = createHarness({
      pack: createTestPack([{ timeMs: 500, lane: 1 }]),
    });
    startSong(harness, [1, 2, 3, 4]);
    expect(harness.game.laneOwners).toEqual([1, 2, 3, 4]);
    expect(harness.layouts).toEqual([
      { slot: 1, layoutId: SOLO_LAYOUT_ID },
      { slot: 2, layoutId: SOLO_LAYOUT_ID },
      { slot: 3, layoutId: SOLO_LAYOUT_ID },
      { slot: 4, layoutId: SOLO_LAYOUT_ID },
    ]);

    harness.pressAtSongTime(500, [1, 2, 3, 4], { 1: 1, 2: 1 });
    expect(harness.game.scoreboard.get(1)).toBe(0);
    expect(harness.game.playerStats[0]?.perfect).toBe(0);
    expect(harness.game.scoreboard.get(2)).toBe(300);
    expect(harness.game.playerStats[1]?.perfect).toBe(1);
    expect(harness.game.scoreboard.get(3)).toBe(0);
    expect(harness.game.scoreboard.get(4)).toBe(0);

    harness.step([1, 2, 3, 4], { 2: 1 });
    expect(harness.game.scoreboard.get(2)).toBe(300);
  });

  test("[E11] a disconnected player's lanes auto-miss and reconnect resumes a paused song", () => {
    const harness = createHarness({
      pack: createTestPack([
        { timeMs: 500, lane: 2 },
        { timeMs: 500, lane: 3 },
      ]),
    });
    startSong(harness, [1, 2]);
    expect(harness.game.laneOwners).toEqual([1, 1, 2, 2]);

    harness.stepUntil(
      () => (harness.game.playerStats[1]?.miss ?? 0) >= 2,
      [1],
      100,
    );
    expect(harness.game.playerStats[1]?.miss).toBe(2);
    expect(harness.game.scoreboard.get(2)).toBe(0);
    expect(harness.clearedLayouts).toContain(2);

    harness.step([]);
    expect(harness.game.isPaused).toBe(true);
    const frozenMs = harness.game.songTimeMs;
    for (let index = 0; index < 30; index += 1) {
      harness.step([]);
    }
    expect(harness.game.songTimeMs).toBe(frozenMs);

    harness.step([1]);
    expect(harness.game.isPaused).toBe(false);
    expect(harness.game.phase).toBe("playing");
  });
});

describe("Beat Tap results and lifecycle", () => {
  test("[G5] results name the winner, show the score line and a tap rematches", () => {
    const harness = createHarness({
      pack: createTestPack([{ timeMs: 300, lane: 0 }], 800),
    });
    startSong(harness, [1]);
    harness.pressAtSongTime(300, [1], { 1: 1 });
    expect(harness.game.scoreboard.get(1)).toBe(300);

    harness.stepUntil(() => harness.game.phase === "results", [1], 100);
    const results = harness.game.lastResults;
    expect(results?.title).toBe("RESULTS");
    expect(results?.winnerLine).toBe("P1 WINS");
    expect(results?.playerLines).toEqual(["P1  300  x1  100%"]);
    expect(results?.hintLine).toBe("Tap a lane to play again");

    harness.render(0);
    expect(harness.surface.texts).toContain("RESULTS");
    expect(harness.surface.texts).toContain("P1 WINS");
    expect(harness.surface.texts).toContain("P1  300  x1  100%");
    expect(harness.surface.texts).toContain("Tap a lane to play again");

    harness.step([1], { 1: 1 });
    expect(harness.game.phase).toBe("countdown");
    expect(harness.game.scoreboard.get(1)).toBe(0);
    expect(harness.game.playerStats[0]?.perfect).toBe(0);

    harness.step([1]);
    expect(harness.game.phase).toBe("playing");
  });

  test("[G8] an invalid chart pack fails init loudly", () => {
    expect(() => createHarness({ pack: { type: "chart" } })).toThrow(
      /Beat Tap chart pack is invalid/,
    );
  });

  test("[E11] dispose is idempotent and leaves the game inert", () => {
    const harness = createHarness({ pack: createTestPack([FAR_NOTE]) });
    startSong(harness, [1]);

    harness.game.dispose();
    harness.game.dispose();
    expect(harness.game.chart).toBeNull();
    expect(harness.game.phase).toBe("lobby");

    expect(() => {
      harness.step([1], { 1: 1 });
      harness.game.render(0);
      harness.game.pause();
      harness.game.resume();
      expect(harness.game.startCalibration(1)).toBe(false);
      harness.game.resetCalibration();
      harness.game.onEvent?.(1, "rematch", null);
    }).not.toThrow();
    expect(harness.game.scoreboard.get(1)).toBe(0);
    expect(harness.surface.texts).toHaveLength(0);
  });
});

describe("Beat Tap presentation seam", () => {
  test("[PR-9.1] the lobby and playing HUD draw through flat feature-detected calls", () => {
    const harness = createHarness({
      pack: createTestPack([{ timeMs: 500, lane: 0 }], 800),
    });
    harness.render(0);
    expect(harness.surface.texts).toContain("BEAT TAP");
    expect(harness.surface.texts).toContain("Waiting for players");
    expect(harness.surface.texts).toContain("Tap CAL on your phone to calibrate");
    expect(harness.surface.texts).toContain("CAL 0 ms");

    startSong(harness, [1]);
    harness.render(0.5);
    expect(harness.surface.texts).toContain("Test Chart");
    expect(harness.surface.texts).toContain("P1  0  x0");

    harness.pressAtSongTime(500, [1], { 1: 1 });
    harness.render(0);
    expect(harness.surface.texts).toContain("PERFECT");
    expect(harness.surface.texts).toContain("P1  300  x1");
  });

  test("[PR-9.1] a renderer without flat calls draws nothing and never throws", () => {
    const harness = createHarness({
      pack: createTestPack([FAR_NOTE]),
      flat: false,
    });
    expect(() => {
      harness.render(0);
      startSong(harness, [1]);
      harness.render(0.25);
    }).not.toThrow();
    expect(harness.surface.texts).toHaveLength(0);
  });
});

/**
 * Beat Tap tap-to-beat calibration (GAME-BT-HOST-04; PR-9.3).
 *
 * Calibration is pure arithmetic plus a storage seam: a metronome session
 * records tap deltas against the nearest 500 ms beat, the median becomes the
 * offset, and the offset is clamped to half a beat. Storage is optional and
 * every failure path reads as 0 ms so a blocked localStorage never blocks play.
 */
import { describe, expect, test } from "vitest";
import {
  calibrationBeatPhase,
  clampCalibrationOffset,
  clearCalibrationOffset,
  computeCalibrationOffset,
  createBrowserCalibrationStorage,
  createCalibrationSession,
  createMemoryCalibrationStorage,
  loadCalibrationOffset,
  sampleCalibrationTap,
  saveCalibrationOffset,
} from "../src/calibration.js";
import { BEAT_TAP_CONFIG, CALIBRATION_STORAGE_KEY } from "../src/config.js";

describe("Beat Tap calibration offset", () => {
  test("[PR-9.3] the median ignores one wild tap and rounds to whole milliseconds", () => {
    expect(computeCalibrationOffset([30, 10, 20])).toBe(20);
    expect(computeCalibrationOffset([10, 20, 30, 100])).toBe(25);
    expect(computeCalibrationOffset([])).toBe(0);

    const max = BEAT_TAP_CONFIG.calibrationMaxOffsetMs;
    expect(computeCalibrationOffset([300, 310, 320])).toBe(max);
    expect(computeCalibrationOffset([-300, -310, -320])).toBe(-max);
  });

  test("[PR-9.3] offsets are rounded and clamped to the accepted range", () => {
    expect(clampCalibrationOffset(12.6)).toBe(13);
    expect(clampCalibrationOffset(-12.6)).toBe(-13);
    expect(clampCalibrationOffset(9999)).toBe(200);
    expect(clampCalibrationOffset(-9999)).toBe(-200);
    expect(clampCalibrationOffset(Number.NaN)).toBe(0);
    expect(clampCalibrationOffset(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("[PR-9.3] lead-in taps are ignored and the eighth sample completes the session", () => {
    const session = createCalibrationSession(1000);
    expect(session.requiredTaps).toBe(BEAT_TAP_CONFIG.calibrationTaps);

    expect(sampleCalibrationTap(session, 1500)).toBeNull(); // during lead-in
    expect(session.taps).toBe(0);

    expect(sampleCalibrationTap(session, 2100)).toBeNull();
    expect(session.taps).toBe(1);

    let completed: number | null = null;
    for (let index = 1; index < session.requiredTaps; index += 1) {
      completed = sampleCalibrationTap(session, 2100 + index * 500);
      if (index < session.requiredTaps - 1) {
        expect(completed).toBeNull();
      }
    }
    expect(completed).toBe(100);
    expect(session.taps).toBe(8);
  });

  test("[PR-9.3] each tap is measured against the nearest beat", () => {
    const session = createCalibrationSession(0);
    expect(sampleCalibrationTap(session, 1490)).toBeNull(); // 10 ms before 1500
    expect(sampleCalibrationTap(session, 1760)).toBeNull(); // 240 ms before 2000
    expect(session.deltas).toEqual([-10, -240]);
  });

  test("[PR-9.3] the metronome phase is silent during lead-in and cycles every beat", () => {
    const session = createCalibrationSession(0);
    expect(calibrationBeatPhase(session, 500)).toBe(0); // lead-in
    expect(calibrationBeatPhase(session, 1000)).toBe(0);
    expect(calibrationBeatPhase(session, 1250)).toBe(0.5);
    expect(calibrationBeatPhase(session, 1750)).toBe(0.5);
  });
});

describe("Beat Tap calibration storage", () => {
  test("[PR-9.3] an offset round-trips as versioned JSON under the host key", () => {
    const storage = createMemoryCalibrationStorage();
    expect(loadCalibrationOffset(storage)).toBe(0);

    saveCalibrationOffset(storage, 67);
    expect(storage.read(CALIBRATION_STORAGE_KEY)).toBe('{"version":1,"offsetMs":67}');
    expect(loadCalibrationOffset(storage)).toBe(67);

    saveCalibrationOffset(storage, 9999);
    expect(loadCalibrationOffset(storage)).toBe(200);

    clearCalibrationOffset(storage);
    expect(storage.read(CALIBRATION_STORAGE_KEY)).toBeNull();
    expect(loadCalibrationOffset(storage)).toBe(0);
  });

  test("[PR-9.3] malformed or out-of-range stored data reads as zero", () => {
    const storage = createMemoryCalibrationStorage();

    storage.write(CALIBRATION_STORAGE_KEY, "{not json");
    expect(loadCalibrationOffset(storage)).toBe(0);

    storage.write(CALIBRATION_STORAGE_KEY, JSON.stringify({ version: 1, offsetMs: "60" }));
    expect(loadCalibrationOffset(storage)).toBe(0);

    storage.write(CALIBRATION_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadCalibrationOffset(storage)).toBe(0);

    storage.write(CALIBRATION_STORAGE_KEY, JSON.stringify({ offsetMs: Number.NaN }));
    expect(loadCalibrationOffset(storage)).toBe(0);

    storage.write(CALIBRATION_STORAGE_KEY, JSON.stringify({ offsetMs: -9999 }));
    expect(loadCalibrationOffset(storage)).toBe(-200);
  });

  test("[PR-9.3] browser storage falls back to memory when localStorage is blocked", () => {
    // In Node there is no localStorage at all; the seam must still work.
    const storage = createBrowserCalibrationStorage();
    saveCalibrationOffset(storage, -42);
    expect(loadCalibrationOffset(storage)).toBe(-42);

    clearCalibrationOffset(storage);
    expect(loadCalibrationOffset(storage)).toBe(0);
  });
});

/**
 * Tap-to-beat calibration (GAME-BT-HOST-04; FR-9.2, PR-9.3).
 *
 * The host plays a metronome and the player taps the calibrate button on each
 * beat. The median tap lateness becomes the calibration offset, clamped to half
 * a beat. Judging subtracts this offset, so a device whose audio reaches the
 * player 60 ms late and who taps on what they hear scores at delta 0.
 *
 * Storage is per host, not per account: one JSON value under
 * `pocketpad.beat-tap.calibration.v1`. Every browser access is feature-detected
 * and wrapped: private mode, blocked storage and sandboxed frames all fall back
 * to an in-memory store rather than failing the game. Nothing here touches the
 * DOM or the network.
 */
import { BEAT_TAP_CONFIG, CALIBRATION_STORAGE_KEY, isFiniteNumber } from "./config.js";

/** Minimal storage seam; tests inject an in-memory implementation. */
export interface CalibrationStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory store; used by tests and as the fallback when storage is blocked. */
export function createMemoryCalibrationStorage(): CalibrationStorage {
  const values = new Map<string, string>();
  return {
    read(key) {
      return values.get(key) ?? null;
    },
    write(key, value) {
      values.set(key, value);
    },
    remove(key) {
      values.delete(key);
    },
  };
}

function getBrowserStorage(): StorageLike | null {
  try {
    // Access itself may throw in a sandboxed frame; keep it inside the try.
    const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

/**
 * Browser localStorage when it exists and answers a probe, else an in-memory
 * store. The probe catches quota/security errors that only appear on access.
 */
export function createBrowserCalibrationStorage(): CalibrationStorage {
  const storage = getBrowserStorage();
  if (storage === null) {
    return createMemoryCalibrationStorage();
  }
  try {
    const probe = "pocketpad.beat-tap.probe";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
  } catch {
    return createMemoryCalibrationStorage();
  }
  return {
    read(key) {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    write(key, value) {
      try {
        storage.setItem(key, value);
      } catch {
        // Quota or blocked storage: calibration still applies this session.
      }
    },
    remove(key) {
      try {
        storage.removeItem(key);
      } catch {
        // Ignore; there is nothing else to clear.
      }
    },
  };
}

/** Clamps and rounds an offset to the accepted ±max range. */
export function clampCalibrationOffset(offsetMs: number): number {
  if (!isFiniteNumber(offsetMs)) {
    return 0;
  }
  const rounded = Math.round(offsetMs);
  const max = BEAT_TAP_CONFIG.calibrationMaxOffsetMs;
  if (rounded > max) {
    return max;
  }
  if (rounded < -max) {
    return -max;
  }
  return rounded;
}

/**
 * Reads the stored offset; malformed, missing or out-of-range data reads as 0.
 * A corrupt value never blocks play.
 */
export function loadCalibrationOffset(storage: CalibrationStorage): number {
  const raw = storage.read(CALIBRATION_STORAGE_KEY);
  if (raw === null) {
    return 0;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return 0;
    }
    const offsetMs = (parsed as { offsetMs?: unknown }).offsetMs;
    if (!isFiniteNumber(offsetMs)) {
      return 0;
    }
    return clampCalibrationOffset(offsetMs);
  } catch {
    return 0;
  }
}

/** Persists a clamped offset; the caller keeps the same value in memory. */
export function saveCalibrationOffset(
  storage: CalibrationStorage,
  offsetMs: number,
): void {
  const value = clampCalibrationOffset(offsetMs);
  storage.write(
    CALIBRATION_STORAGE_KEY,
    JSON.stringify({ version: 1, offsetMs: value }),
  );
}

/** Removes the stored offset (the game resets to 0 in the same change). */
export function clearCalibrationOffset(storage: CalibrationStorage): void {
  storage.remove(CALIBRATION_STORAGE_KEY);
}

/**
 * Metronome session. `deltas` is the live record owned by the session;
 * `sampleCalibrationTap` appends to it and never replaces it, so callers can
 * read it without copying.
 */
export interface CalibrationSession {
  /** Audio-clock timestamp the lead-in started at. */
  readonly startAudioMs: number;
  readonly taps: number;
  readonly deltas: number[];
  readonly requiredTaps: number;
}

export function createCalibrationSession(startAudioMs: number): CalibrationSession {
  const deltas: number[] = [];
  return {
    startAudioMs: isFiniteNumber(startAudioMs) ? startAudioMs : 0,
    get taps() {
      return deltas.length;
    },
    deltas,
    requiredTaps: BEAT_TAP_CONFIG.calibrationTaps,
  };
}

/**
 * Median of tap deltas. Even counts average the two middle values; the result
 * is clamped. The copy/sort happens once, when calibration completes.
 */
export function computeCalibrationOffset(deltas: readonly number[]): number {
  const count = deltas.length;
  if (count === 0) {
    return 0;
  }
  const sorted = deltas.slice().sort((a, b) => a - b);
  const middle = Math.floor(count / 2);
  let median: number;
  if (count % 2 === 0) {
    const low = sorted[middle - 1];
    const high = sorted[middle];
    median = low === undefined || high === undefined ? 0 : (low + high) / 2;
  } else {
    median = sorted[middle] ?? 0;
  }
  return clampCalibrationOffset(median);
}

/**
 * Records one tap. Returns the final offset once the session has enough taps,
 * otherwise null. Taps during the one-second lead-in are ignored, so a player
 * who taps along before the metronome starts is not penalised.
 */
export function sampleCalibrationTap(
  session: CalibrationSession,
  audioNowMs: number,
): number | null {
  if (!isFiniteNumber(audioNowMs)) {
    return null;
  }
  const relativeMs =
    audioNowMs - session.startAudioMs - BEAT_TAP_CONFIG.calibrationWarmupMs;
  if (relativeMs < 0) {
    return null;
  }
  const beatMs = BEAT_TAP_CONFIG.calibrationBeatMs;
  const beatIndex = Math.round(relativeMs / beatMs);
  const nearestBeatMs =
    session.startAudioMs + BEAT_TAP_CONFIG.calibrationWarmupMs + beatIndex * beatMs;
  const deltaMs = audioNowMs - nearestBeatMs;
  session.deltas.push(deltaMs);
  if (session.taps < session.requiredTaps) {
    return null;
  }
  return computeCalibrationOffset(session.deltas);
}

/**
 * Metronome phase 0..1 for the host pulse; 0 during the lead-in. Render uses
 * this to pulse the calibration circle without allocating.
 */
export function calibrationBeatPhase(session: CalibrationSession, audioNowMs: number): number {
  const relativeMs =
    audioNowMs - session.startAudioMs - BEAT_TAP_CONFIG.calibrationWarmupMs;
  if (relativeMs < 0) {
    return 0;
  }
  const beatMs = BEAT_TAP_CONFIG.calibrationBeatMs;
  return (relativeMs % beatMs) / beatMs;
}

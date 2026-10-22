/**
 * E6 — display lag flash sequence (D3-EXP-01, FR-7.13).
 *
 * Display lag is the time from the browser presenting a frame to the panel
 * emitting light. Software cannot see it: only a photodiode or a 240 fps
 * camera filming the phone and the screen together can. This module provides
 *
 *   1. a deterministic flash sequence (white for N frames, black for M) with a
 *      visible frame counter, so a camera has clean edges to count, and
 *   2. the arithmetic for turning counted camera frames into milliseconds.
 *
 * The software part records the requestAnimationFrame cadence only. The
 * camera numbers (Game Mode on and off) are PENDING until someone films a TV;
 * TV probing is deferred. Display lag is always reported apart from E5's
 * input-to-canvas number and is never subtracted from or added to it.
 */

export const E6_SCHEMA_VERSION = 1;
export const E6_DEFAULT_FLASHES = 30;
export const E6_ON_FRAMES = 6;
export const E6_OFF_FRAMES = 24;

export interface FlashDeps {
  /** requestAnimationFrame; the callback receives the frame timestamp. */
  requestFrame: (callback: (timestampMs: number) => void) => void;
  /** Turns the flash on/off and shows the running frame number. */
  render: (lit: boolean, frame: number) => void;
}

export interface FlashSequenceResult {
  flashes: number;
  framesRendered: number;
  /** rAF timestamp of each flash's first white frame. */
  onsetMs: number[];
  frameIntervalP50Ms: number | null;
  frameIntervalP95Ms: number | null;
  /** 1000 / median frame interval; the panel refresh the browser reports. */
  refreshHzEstimate: number | null;
}

export interface CameraLagSummary {
  count: number;
  cameraFps: number;
  p50Ms: number;
  p95Ms: number;
  /** One camera frame; the measurement cannot be finer than this. */
  resolutionMs: number;
}

export interface E6Result {
  schema: number;
  software: FlashSequenceResult;
  displayLag: {
    gameModeOn: CameraLagSummary | "PENDING";
    gameModeOff: CameraLagSummary | "PENDING";
    method: string;
  };
  separateFromE5: true;
  userAdvice: string;
  tv: string;
}

function percentile(values: readonly number[], percent: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.ceil((percent / 100) * sorted.length);
  const value = sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
  return value === undefined ? null : value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Whether frame `index` (0-based) of the sequence is white. */
export function isLitFrame(index: number, onFrames = E6_ON_FRAMES, offFrames = E6_OFF_FRAMES): boolean {
  return index >= 0 && index % (onFrames + offFrames) < onFrames;
}

/** Runs the flash sequence on animation frames and records its cadence. */
export function runFlashSequence(
  deps: FlashDeps,
  flashes = E6_DEFAULT_FLASHES,
  onFrames = E6_ON_FRAMES,
  offFrames = E6_OFF_FRAMES,
): Promise<FlashSequenceResult> {
  const totalFrames = flashes * (onFrames + offFrames);
  const timestamps: number[] = [];
  const onsetMs: number[] = [];
  return new Promise((resolve) => {
    const step = (timestampMs: number): void => {
      const frame = timestamps.length;
      timestamps.push(timestampMs);
      if (frame >= totalFrames) {
        deps.render(false, frame);
        const intervals: number[] = [];
        for (let index = 1; index < timestamps.length; index += 1) {
          intervals.push((timestamps[index] ?? 0) - (timestamps[index - 1] ?? 0));
        }
        const p50 = percentile(intervals, 50);
        const p95 = percentile(intervals, 95);
        resolve({
          flashes,
          framesRendered: totalFrames,
          onsetMs,
          frameIntervalP50Ms: p50 === null ? null : round2(p50),
          frameIntervalP95Ms: p95 === null ? null : round2(p95),
          refreshHzEstimate: p50 === null || p50 <= 0 ? null : round2(1000 / p50),
        });
        return;
      }
      const lit = isLitFrame(frame, onFrames, offFrames);
      if (lit && !isLitFrame(frame - 1, onFrames, offFrames)) onsetMs.push(timestampMs);
      deps.render(lit, frame);
      deps.requestFrame(step);
    };
    deps.requestFrame(step);
  });
}

/**
 * Converts counted camera frames (reference-display white -> TV white, one
 * entry per flash) into milliseconds at the camera's frame rate.
 */
export function summarizeCameraFrames(frameCounts: readonly number[], cameraFps: number): CameraLagSummary {
  if (!(cameraFps > 0)) throw new RangeError("cameraFps must be > 0");
  if (frameCounts.length === 0) throw new RangeError("need at least one counted flash");
  const frameMs = 1000 / cameraFps;
  const values = frameCounts.map((frames) => {
    if (!Number.isFinite(frames) || frames < 0) throw new RangeError("frame counts must be >= 0");
    return frames * frameMs;
  });
  return {
    count: values.length,
    cameraFps,
    p50Ms: round2(percentile(values, 50) ?? 0),
    p95Ms: round2(percentile(values, 95) ?? 0),
    resolutionMs: round2(frameMs),
  };
}

export function createE6Result(
  software: FlashSequenceResult,
  camera: { gameModeOn?: CameraLagSummary; gameModeOff?: CameraLagSummary } = {},
): E6Result {
  return {
    schema: E6_SCHEMA_VERSION,
    software,
    displayLag: {
      gameModeOn: camera.gameModeOn ?? "PENDING",
      gameModeOff: camera.gameModeOff ?? "PENDING",
      method:
        "Mirror this page to a reference display and the TV; film both at 240 fps (or use a photodiode) and count frames between the two white onsets. The reference display's own lag is a known bias to record.",
    },
    separateFromE5: true,
    userAdvice: "Turn on the TV's Game Mode (or PC mode) for the lowest display lag.",
    tv: "PENDING - TV probing deferred; no TV or camera measurement has been made",
  };
}

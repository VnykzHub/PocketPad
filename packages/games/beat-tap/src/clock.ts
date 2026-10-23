/**
 * Song clock (GAME-BT-HOST-02, GAME-BT-HOST-04; FR-7.3).
 *
 * The song timeline is driven only by the host audio clock (`ctx.audio.now()`),
 * never by wall time: audio and notes must stay locked when the tab stalls.
 * Pausing accumulates the frozen interval so resuming does not jump the song
 * forward. The chart's own `offsetMs` is subtracted from the timeline, matching
 * a per-chart calibration.
 *
 * `timeMs` is clamped at 0 so a negative chart offset cannot run the song
 * backwards before it starts.
 */

export interface SongClock {
  /** True once `start` has been called and `reset` has not. */
  readonly started: boolean;
  /** True while paused. */
  readonly paused: boolean;
  /** Starts a song at audio-clock `startAudioMs` with a chart offset. */
  start(startAudioMs: number, offsetMs: number): void;
  /** Freezes the timeline at the current audio time; idempotent. */
  pause(audioNowMs: number): void;
  /** Resumes, skipping the frozen interval; idempotent. */
  resume(audioNowMs: number): void;
  /** Clears all state for a new round. */
  reset(): void;
  /** Song time in milliseconds at an audio-clock timestamp, >= 0. */
  timeMs(audioNowMs: number): number;
  /** The audio-clock timestamp the song started at, for tests and debug. */
  readonly startAudioMs: number;
}

export function createSongClock(): SongClock {
  let started = false;
  let startAudioMs = 0;
  let offsetMs = 0;
  let pausedAtMs: number | null = null;
  let pausedTotalMs = 0;

  const clock: SongClock = {
    get started() {
      return started;
    },
    get paused() {
      return pausedAtMs !== null;
    },
    get startAudioMs() {
      return startAudioMs;
    },
    start(nextStartAudioMs, nextOffsetMs) {
      if (!Number.isFinite(nextStartAudioMs) || !Number.isFinite(nextOffsetMs)) {
        return;
      }
      started = true;
      startAudioMs = nextStartAudioMs;
      offsetMs = nextOffsetMs;
      pausedAtMs = null;
      pausedTotalMs = 0;
    },
    pause(audioNowMs) {
      if (!started || pausedAtMs !== null || !Number.isFinite(audioNowMs)) {
        return;
      }
      pausedAtMs = audioNowMs;
    },
    resume(audioNowMs) {
      if (pausedAtMs === null || !Number.isFinite(audioNowMs)) {
        return;
      }
      const frozen = audioNowMs - pausedAtMs;
      if (frozen > 0) {
        pausedTotalMs += frozen;
      }
      pausedAtMs = null;
    },
    reset() {
      started = false;
      startAudioMs = 0;
      offsetMs = 0;
      pausedAtMs = null;
      pausedTotalMs = 0;
    },
    timeMs(audioNowMs) {
      if (!started || !Number.isFinite(audioNowMs)) {
        return 0;
      }
      const effectiveNow = pausedAtMs ?? audioNowMs;
      const elapsed = effectiveNow - startAudioMs - pausedTotalMs - offsetMs;
      return elapsed > 0 ? elapsed : 0;
    },
  };

  return clock;
}

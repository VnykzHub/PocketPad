/**
 * Per-song note runtime (GAME-BT-HOST-03; E11).
 *
 * The runtime owns which notes are still hittable and which have expired. It
 * keeps a cursor per lane so misses are found in O(expired notes) rather than
 * rescanning the chart each tick, and a `Uint8Array` of judged flags so hits
 * never need to allocate.
 *
 * Judging order per tick is fixed: the game applies presses first, then
 * advances misses. A press carries the player's send time, so a packet that
 * arrives a few milliseconds after the note's miss deadline must still be
 * judged against the time the player actually pressed. A note exactly at
 * `time + missMs` is still hittable; one millisecond later it expires.
 * `finish` force-misses everything left when the song ends, so every note is
 * accounted for on the results screen.
 */
import type { ChartItem, ChartNote } from "./chart.js";
import type { JudgeWindows } from "./config.js";
import { judgeDelta, type Judgment } from "./judge.js";

/** Called once for every note the runtime expires or force-misses. */
export type MissHandler = (lane: number) => void;

export interface SongRuntime {
  readonly noteCount: number;
  /** 1 = judged (hit or missed), 0 = still live; for rendering. */
  readonly judged: Uint8Array;
  readonly judgedCount: number;
  /** Re-arms every note for a replay of the same chart. */
  reset(): void;
  /** Expires notes past their miss deadline; returns the newly missed count. */
  advance(songTimeMs: number): number;
  /**
   * Grades a press on `lane` at a song timestamp. Returns the grade and
   * consumes the earliest live note in the window, or null when the press does
   * not land on any live note.
   */
  hit(lane: number, pressSongTimeMs: number): Judgment | null;
  /** Force-misses every remaining note; returns the count. */
  finish(): number;
}

export function createSongRuntime(
  chart: ChartItem,
  windows: JudgeWindows,
  onMiss: MissHandler,
): SongRuntime {
  const notes: readonly ChartNote[] = chart.notes;
  const noteCount = notes.length;

  // Lane -> global note indexes, in time order. Built once per chart.
  const laneNotes: number[][] = [[], [], [], []];
  for (let index = 0; index < noteCount; index += 1) {
    const note = notes[index];
    if (note === undefined) {
      continue;
    }
    const lane = laneNotes[note.lane];
    if (lane !== undefined) {
      lane.push(index);
    }
  }

  const laneCursor: number[] = [0, 0, 0, 0];
  const judged = new Uint8Array(noteCount);
  let judgedCount = 0;

  function missLane(lane: number, songTimeMs: number): number {
    const indexes = laneNotes[lane];
    if (indexes === undefined) {
      return 0;
    }
    let cursor = laneCursor[lane] ?? 0;
    let missed = 0;
    while (cursor < indexes.length) {
      const globalIndex = indexes[cursor];
      if (globalIndex === undefined) {
        break;
      }
      const note = notes[globalIndex];
      if (note === undefined) {
        cursor += 1;
        continue;
      }
      if (judged[globalIndex] === 1) {
        cursor += 1;
        continue;
      }
      if (songTimeMs <= note.timeMs + windows.missMs) {
        break;
      }
      judged[globalIndex] = 1;
      judgedCount += 1;
      missed += 1;
      onMiss(lane);
      cursor += 1;
    }
    laneCursor[lane] = cursor;
    return missed;
  }

  const runtime: SongRuntime = {
    get noteCount() {
      return noteCount;
    },
    get judged() {
      return judged;
    },
    get judgedCount() {
      return judgedCount;
    },
    reset() {
      judged.fill(0);
      laneCursor[0] = 0;
      laneCursor[1] = 0;
      laneCursor[2] = 0;
      laneCursor[3] = 0;
      judgedCount = 0;
    },
    advance(songTimeMsNow) {
      if (!Number.isFinite(songTimeMsNow)) {
        return 0;
      }
      let missed = 0;
      for (let lane = 0; lane < 4; lane += 1) {
        missed += missLane(lane, songTimeMsNow);
      }
      return missed;
    },
    hit(lane, pressSongTimeMs) {
      if (!Number.isInteger(lane) || lane < 0 || lane >= 4) {
        return null;
      }
      if (!Number.isFinite(pressSongTimeMs)) {
        return null;
      }
      const indexes = laneNotes[lane];
      if (indexes === undefined) {
        return null;
      }
      let cursor = laneCursor[lane] ?? 0;
      while (cursor < indexes.length) {
        const globalIndex = indexes[cursor];
        if (globalIndex === undefined) {
          break;
        }
        const note = notes[globalIndex];
        if (note === undefined) {
          cursor += 1;
          continue;
        }
        if (note.timeMs > pressSongTimeMs + windows.missMs) {
          break;
        }
        if (judged[globalIndex] === 0) {
          const judgment = judgeDelta(pressSongTimeMs - note.timeMs, windows);
          if (judgment !== null) {
            judged[globalIndex] = 1;
            judgedCount += 1;
            return judgment;
          }
        }
        cursor += 1;
      }
      return null;
    },
    finish() {
      let missed = 0;
      for (let lane = 0; lane < 4; lane += 1) {
        const indexes = laneNotes[lane];
        if (indexes === undefined) {
          continue;
        }
        let cursor = laneCursor[lane] ?? 0;
        while (cursor < indexes.length) {
          const globalIndex = indexes[cursor];
          cursor += 1;
          if (globalIndex === undefined || judged[globalIndex] === 1) {
            continue;
          }
          judged[globalIndex] = 1;
          judgedCount += 1;
          missed += 1;
          onMiss(lane);
        }
        laneCursor[lane] = cursor;
      }
      return missed;
    },
  };

  return runtime;
}

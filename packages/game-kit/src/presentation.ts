/**
 * Countdown and results presentation (spec 24 §2.7).
 *
 * Host HUD helpers only: no rendering, no DOM, no clock. `resultsRows`
 * reuses one array and eight row objects, so a host may call it every frame.
 */
import { playerColor, playerLabel, playerShape, type PlayerShape } from "./identity.js";
import { MAX_SLOT, isSlot } from "./slots.js";

export type CountdownLabel = "3" | "2" | "1" | "GO";

/**
 * Whole seconds remaining, clamped to the three countdown steps. Zero or
 * negative (and non-finite) means the countdown is over: `"GO"`.
 */
export function countdownLabel(remainingMs: number): CountdownLabel {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return "GO";
  }
  const step = Math.ceil(remainingMs / 1000);
  if (step >= 3) {
    return "3";
  }
  return step === 2 ? "2" : "1";
}

export interface ResultsRow {
  readonly slot: number;
  readonly score: number;
  readonly label: string;
  readonly color: string;
  readonly shape: PlayerShape;
  readonly winner: boolean;
}

interface MutableResultsRow {
  slot: number;
  score: number;
  label: string;
  color: string;
  shape: PlayerShape;
  winner: boolean;
}

interface ScoredSlot {
  slot: number;
  score: number;
}

function makeScoredSlots(): ScoredSlot[] {
  const slots: ScoredSlot[] = [];
  for (let index = 0; index < MAX_SLOT; index += 1) {
    slots.push({ slot: 0, score: 0 });
  }
  return slots;
}

function makeRows(): MutableResultsRow[] {
  const rows: MutableResultsRow[] = [];
  for (let index = 0; index < MAX_SLOT; index += 1) {
    rows.push({
      slot: 0,
      score: 0,
      label: "",
      color: "",
      shape: "circle",
      winner: false,
    });
  }
  return rows;
}

/** Module-level reuse: `resultsRows` is a per-frame HUD call. */
const scoredSlots = makeScoredSlots();
/** Row objects are never truncated, so their identity survives every call. */
const rowPool = makeRows();
/** Reused result view; its length tracks the latest row count. */
const rows: MutableResultsRow[] = [];

/** True when `a` should sort after `b`: score desc, then slot asc. */
function comesAfter(a: ScoredSlot, b: ScoredSlot): boolean {
  if (a.score !== b.score) {
    return a.score < b.score;
  }
  return a.slot > b.slot;
}

type ScoreEntry = { readonly slot: number; readonly score: number };

/** Score source: `Match.scores` or `Scoreboard.ranked`. */
export type ScoreSource =
  | ReadonlyMap<number, number>
  | readonly ScoreEntry[];

function isScoreEntries(source: ScoreSource): source is readonly ScoreEntry[] {
  return Array.isArray(source);
}

/**
 * Ranked results rows for the host HUD, sorted by score descending then slot
 * ascending. Entries with an invalid slot or non-finite score are skipped.
 * The array and its row objects are reused; copy anything retained.
 */
export function resultsRows(
  scores: ScoreSource,
  winnerSlot: number | null = null,
): readonly ResultsRow[] {
  let count = 0;
  if (isScoreEntries(scores)) {
    for (let index = 0; index < scores.length && count < MAX_SLOT; index += 1) {
      const scored = scores[index];
      if (scored === undefined || !isSlot(scored.slot) || !Number.isFinite(scored.score)) {
        continue;
      }
      const entry = scoredSlots[count];
      if (entry === undefined) {
        break;
      }
      entry.slot = scored.slot;
      entry.score = scored.score;
      count += 1;
    }
  } else {
    for (const [slot, score] of scores) {
      if (count >= MAX_SLOT) {
        break;
      }
      if (!isSlot(slot) || !Number.isFinite(score)) {
        continue;
      }
      const entry = scoredSlots[count];
      if (entry === undefined) {
        break;
      }
      entry.slot = slot;
      entry.score = score;
      count += 1;
    }
  }

  // Insertion sort over the filled prefix; count is at most 8.
  for (let index = 1; index < count; index += 1) {
    const current = scoredSlots[index];
    if (current === undefined) {
      break;
    }
    let position = index - 1;
    while (position >= 0) {
      const previous = scoredSlots[position];
      if (previous === undefined || !comesAfter(previous, current)) {
        break;
      }
      scoredSlots[position + 1] = previous;
      position -= 1;
    }
    scoredSlots[position + 1] = current;
  }

  const winner = winnerSlot !== null && isSlot(winnerSlot) ? winnerSlot : null;
  for (let index = 0; index < count; index += 1) {
    const entry = scoredSlots[index];
    const row = rowPool[index];
    if (entry === undefined || row === undefined) {
      break;
    }
    row.slot = entry.slot;
    row.score = entry.score;
    row.label = playerLabel(entry.slot);
    row.color = playerColor(entry.slot);
    row.shape = playerShape(entry.slot);
    row.winner = entry.slot === winner;
    rows[index] = row;
  }
  rows.length = count;
  return rows;
}

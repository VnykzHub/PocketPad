/**
 * Scoreboard (spec 24 §2.2; ER-24-02).
 *
 * Ordering is deterministic: score descending, then slot ascending, so ties
 * never depend on insertion order. `ranked` reuses one internal array and one
 * entry object per slot; read it immediately rather than retaining it.
 */
import { requireFinite, requireSlot } from "./slots.js";

export interface ScoreEntry {
  readonly slot: number;
  readonly score: number;
}

export interface Scoreboard {
  set(slot: number, score: number): void;
  add(slot: number, delta: number): void;
  get(slot: number): number;
  /** Sorted by score desc, then slot asc; reuses the internal array. */
  readonly ranked: readonly ScoreEntry[];
  reset(): void;
}

interface MutableEntry {
  slot: number;
  score: number;
}

function compareEntries(a: MutableEntry, b: MutableEntry): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  return a.slot - b.slot;
}

/** Creates an empty scoreboard for slots 1..8. */
export function createScoreboard(): Scoreboard {
  const bySlot = new Map<number, MutableEntry>();
  const ranked: MutableEntry[] = [];

  const entryFor = (slot: number): MutableEntry => {
    const existing = bySlot.get(slot);
    if (existing !== undefined) {
      return existing;
    }
    const entry: MutableEntry = { slot, score: 0 };
    bySlot.set(slot, entry);
    ranked.push(entry);
    return entry;
  };

  return {
    set(slot, score) {
      requireSlot(slot);
      requireFinite(score, "score");
      entryFor(slot).score = score < 0 ? 0 : score;
    },
    add(slot, delta) {
      requireSlot(slot);
      requireFinite(delta, "delta");
      const entry = entryFor(slot);
      const next = entry.score + delta;
      entry.score = next < 0 ? 0 : next;
    },
    get(slot) {
      requireSlot(slot);
      return bySlot.get(slot)?.score ?? 0;
    },
    get ranked() {
      ranked.sort(compareEntries);
      return ranked;
    },
    reset() {
      bySlot.clear();
      ranked.length = 0;
    },
  };
}

/**
 * Voice-stealing policy (spec 09 §5.4) — pure and allocation-free.
 *
 * Selection order:
 *   1. a free voice (lowest free index);
 *   2. otherwise the lowest `priority`;
 *   3. ties go to the oldest `startedAt`;
 *   4. remaining ties go to the lowest index;
 *   5. never evict a voice with a **higher** priority than the request.
 *
 * If every voice is active and higher priority, `-1` is returned: the caller
 * drops the request and increments `stats.droppedPlays`.
 *
 * Parallel arrays rather than objects keep `playSfx`/`play` free of a
 * per-call candidate list (09 §5.11). `active` uses `1` for playing or
 * stealing and `0` for free; `count` lets the caller bound the scan.
 */
export function selectVoiceIndex(
  active: Uint8Array,
  priorities: Uint8Array,
  startedAt: Float64Array,
  count: number,
  requestPriority: number,
): number {
  const limit = Math.min(count, active.length, priorities.length, startedAt.length);
  for (let index = 0; index < limit; index += 1) {
    if (active[index] !== 1) return index;
  }

  let candidate = -1;
  for (let index = 0; index < limit; index += 1) {
    if (candidate === -1) {
      candidate = index;
      continue;
    }
    const priority = priorities[index] ?? 0;
    const bestPriority = priorities[candidate] ?? 0;
    if (priority < bestPriority) {
      candidate = index;
      continue;
    }
    if (priority === bestPriority) {
      const started = startedAt[index] ?? 0;
      const bestStarted = startedAt[candidate] ?? 0;
      // Strictly older wins; equal age keeps the lower index already held.
      if (started < bestStarted) candidate = index;
    }
  }

  if (candidate === -1) return -1;
  if ((priorities[candidate] ?? 0) > requestPriority) return -1;
  return candidate;
}

/** Read-only view used by tests and diagnostics; never used on the hot path. */
export interface VoiceCandidate {
  readonly index: number;
  readonly active: boolean;
  readonly priority: number;
  readonly startedAt: number;
}

/** Convenience wrapper over `selectVoiceIndex` for tests and debug tools. */
export function selectVoice(
  candidates: readonly VoiceCandidate[],
  requestPriority: number,
): number {
  const count = candidates.length;
  const active = new Uint8Array(count);
  const priorities = new Uint8Array(count);
  const startedAt = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    active[index] = candidate.active ? 1 : 0;
    priorities[index] = candidate.priority;
    startedAt[index] = candidate.startedAt;
  }
  return selectVoiceIndex(active, priorities, startedAt, count, requestPriority);
}

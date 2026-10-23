/**
 * Voice-stealing properties — ER-09-04.
 *
 * The example suite pins the documented order; these tests restate the policy
 * independently (free → lowest priority → oldest → lowest index, never a
 * higher priority) and compare it against `selectVoice` over arbitrary pools.
 * The last property checks the accounting identity the counters promise:
 * every play is either active, stolen, or dropped.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { EngineAudioSystem } from "../src/AudioSystem.js";
import { selectVoice, type VoiceCandidate } from "../src/voice/VoiceStealing.js";
import { createFakeFactory, fakeBuffer } from "./support/fakeAudio.js";

interface PoolVoice {
  readonly active: boolean;
  readonly priority: number;
  readonly startedAt: number;
}

const POOL = fc.array(
  fc.record({
    active: fc.boolean(),
    priority: fc.integer({ min: 0, max: 255 }),
    startedAt: fc.integer({ min: 0, max: 1000 }),
  }),
  { maxLength: 32 },
);
const REQUEST = fc.integer({ min: 0, max: 255 });

function toCandidates(pool: readonly PoolVoice[]): VoiceCandidate[] {
  return pool.map((voice, index) => ({
    index,
    active: voice.active,
    priority: voice.priority,
    startedAt: voice.startedAt,
  }));
}

/** The policy restated independently of `VoiceStealing.ts`. */
function expectedIndex(pool: readonly PoolVoice[], request: number): number {
  const free = pool.findIndex((voice) => !voice.active);
  if (free >= 0) return free;
  if (pool.length === 0) return -1;

  let best = 0;
  for (let index = 1; index < pool.length; index += 1) {
    const candidate = pool[index];
    const leader = pool[best];
    if (candidate === undefined || leader === undefined) continue;
    if (candidate.priority < leader.priority) {
      best = index;
    } else if (
      candidate.priority === leader.priority &&
      candidate.startedAt < leader.startedAt
    ) {
      best = index;
    }
  }
  const chosen = pool[best];
  if (chosen === undefined) return -1;
  return chosen.priority > request ? -1 : best;
}

describe("voice-stealing policy properties", () => {
  test("[ER-09-04] any pool selects exactly the documented voice", () => {
    fc.assert(
      fc.property(POOL, REQUEST, (pool, request) => {
        expect(selectVoice(toCandidates(pool), request)).toBe(
          expectedIndex(pool, request),
        );
      }),
      { numRuns: 300 },
    );
  });

  test("[ER-09-04] a free voice always wins, at its lowest index", () => {
    fc.assert(
      fc.property(
        POOL.filter((pool) => pool.some((voice) => !voice.active)),
        REQUEST,
        (pool, request) => {
          const free = pool.findIndex((voice) => !voice.active);
          expect(selectVoice(toCandidates(pool), request)).toBe(free);
        },
      ),
      { numRuns: 200 },
    );
  });

  test("[ER-09-04] −1 means every voice is active and strictly higher priority", () => {
    fc.assert(
      fc.property(POOL, REQUEST, (pool, request) => {
        const selected = selectVoice(toCandidates(pool), request);
        if (selected !== -1) return;
        for (const voice of pool) {
          expect(voice.active).toBe(true);
          expect(voice.priority).toBeGreaterThan(request);
        }
      }),
      { numRuns: 300 },
    );
  });

  test("[ER-09-04] a selected active voice is never higher priority than the request", () => {
    fc.assert(
      fc.property(POOL, REQUEST, (pool, request) => {
        const selected = selectVoice(toCandidates(pool), request);
        if (selected < 0) return;
        if (pool.some((voice) => !voice.active)) return;
        const chosen = pool[selected];
        expect(chosen).toBeDefined();
        if (chosen === undefined) return;
        expect(chosen.active).toBe(true);
        expect(chosen.priority).toBeLessThanOrEqual(request);
      }),
      { numRuns: 300 },
    );
  });

  test("[ER-09-04] the same pool selects the same voice every time", () => {
    fc.assert(
      fc.property(POOL, REQUEST, (pool, request) => {
        const first = selectVoice(toCandidates(pool), request);
        const second = selectVoice(toCandidates(pool), request);
        expect(second).toBe(first);
      }),
      { numRuns: 200 },
    );
  });

  test("[ER-09-04] every play is active, stolen or dropped", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.integer({ min: 0, max: 255 }), {
          minLength: 1,
          maxLength: 64,
        }),
        async (sfxVoices, priorities) => {
          const fake = createFakeFactory({ currentTime: 10 });
          const system = new EngineAudioSystem({
            createContext: fake.factory,
            sfxVoices,
          });
          await system.unlock();
          system.registerBuffer("shot", fakeBuffer(480, 1));

          for (const priority of priorities) {
            const handle = system.createSource({ assetId: "shot", priority });
            system.play(handle);
          }

          const stats = system.stats;
          expect(stats.activeVoices).toBeLessThanOrEqual(sfxVoices);
          expect(stats.activeVoices + stats.steals + stats.droppedPlays).toBe(
            priorities.length,
          );
          system.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });
});

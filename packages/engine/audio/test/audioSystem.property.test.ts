/**
 * Public-API robustness — ER-09-14.
 *
 * A 10,000-call deterministic sequence (seeded LCG) drives every public entry
 * point while crossing `locked → unlocked → suspended → disposed`, then keeps
 * calling into the disposed system. After every call the run asserts the
 * invariants the contract promises: a known state, finite non-negative stats,
 * bounded voices and decode budget, counters that never go backwards, a
 * master volume in 0..1, a clock that is exactly 0 while locked or
 * unavailable, and `unavailable` as a terminal state.
 *
 * These tests prove "no throw and no inconsistent state" on the fake graph.
 * They do not measure heap growth (ER-09-11) or any browser behaviour.
 */

import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { EngineAudioSystem } from "../src/AudioSystem.js";
import type { AudioBusName, AudioHandle } from "../src/contracts/audio.js";
import {
  FakeMediaElement,
  createFakeFactory,
  fakeBuffer,
} from "./support/fakeAudio.js";
import type { FakeFactory } from "./support/fakeAudio.js";

const CALLS = 10_000;
const BUDGET = 1 << 20;
const POOL_SIZE = 4;

const BUSES: readonly AudioBusName[] = ["music", "sfx", "ambient", "voice", "ui"];
const MALFORMED: readonly AudioHandle[] = [
  { index: -1, generation: 0 },
  { index: 1.5, generation: 0 },
  { index: Number.NaN, generation: 1 },
  { index: 9999, generation: 3 },
];

const OP_NAMES = [
  "unlock",
  "suspend",
  "resume",
  "playSfx",
  "playSfx-missing",
  "playSfx-options",
  "createSource",
  "play",
  "stop",
  "setSourcePosition",
  "destroySource",
  "playMusic",
  "stopMusic",
  "tuneRadio",
  "stopRadio",
  "registerBuffer",
  "releaseBuffer",
  "streams",
  "update",
  "mixer",
  "listener",
] as const;

interface Rig {
  readonly system: EngineAudioSystem;
  readonly fake: FakeFactory;
  readonly media: FakeMediaElement[];
  readonly handles: AudioHandle[];
  bufferSerial: number;
}

function createRig(factoryFails: boolean): Rig {
  const fake = createFakeFactory({ currentTime: 10 });
  const media: FakeMediaElement[] = [];
  const system = new EngineAudioSystem({
    createContext: factoryFails
      ? () => {
          throw new Error("Web Audio blocked");
        }
      : fake.factory,
    createMediaElement: () => {
      const element = new FakeMediaElement();
      media.push(element);
      return element;
    },
    decodeBudgetBytes: BUDGET,
    sfxVoices: POOL_SIZE,
    spatialVoices: POOL_SIZE,
  });
  system.registerRadioStation({
    id: "station",
    tracks: ["stream-a"],
    loop: true,
  });
  system.registerStream("stream-a", "audio/stream-a.opus");
  return { system, fake, media, handles: [], bufferSerial: 0 };
}

/** uint32 LCG; the same seed always produces the same call sequence. */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function unit(rng: () => number): number {
  return rng() / 0x1_0000_0000;
}

function pick<T>(rng: () => number, values: readonly T[]): T | undefined {
  return values[rng() % values.length];
}

function someHandle(rng: () => number, rig: Rig): AudioHandle {
  const stored = rig.handles[rng() % Math.max(1, rig.handles.length)];
  if (rng() % 16 === 0) {
    return pick(rng, MALFORMED) ?? MALFORMED[0] ?? stored ?? { index: -1, generation: 0 };
  }
  return stored ?? pick(rng, MALFORMED) ?? { index: -1, generation: 0 };
}

async function applyOp(op: number, rng: () => number, rig: Rig): Promise<void> {
  const { system } = rig;
  switch (op) {
    case 0:
      await system.unlock();
      return;
    case 1:
      await system.suspend();
      return;
    case 2:
      await system.resume();
      return;
    case 3:
      system.playSfx("shot");
      return;
    case 4:
      system.playSfx("missing");
      return;
    case 5: {
      const bus = pick(rng, BUSES) ?? "sfx";
      system.playSfx("shot", {
        bus,
        volume: unit(rng),
        rate: 0.25 + unit(rng) * 3.75,
      });
      return;
    }
    case 6: {
      const handle = system.createSource({
        assetId: rng() % 5 === 0 ? "missing" : "shot",
        positional: rng() % 3 === 0,
        loop: rng() % 4 === 0,
        volume: unit(rng),
        rate: 0.25 + unit(rng) * 3.75,
        priority: rng() % 256,
      });
      rig.handles.push(handle);
      while (rig.handles.length > 32) {
        const oldest = rig.handles.shift();
        if (oldest !== undefined) system.destroySource(oldest);
      }
      return;
    }
    case 7: {
      const handle = someHandle(rng, rig);
      if (rng() % 5 === 0) system.play(handle, { at: (rng() % 200) / 10 });
      else system.play(handle);
      return;
    }
    case 8:
      system.stop(someHandle(rng, rig), (rng() % 3000) / 10);
      return;
    case 9:
      system.setSourcePosition(
        someHandle(rng, rig),
        unit(rng) * 40 - 20,
        unit(rng) * 40 - 20,
        unit(rng) * 40 - 20,
      );
      return;
    case 10:
      system.destroySource(someHandle(rng, rig));
      return;
    case 11:
      system.playMusic("theme", {
        fadeMs: rng() % 3000,
        volume: unit(rng),
        loop: rng() % 2 === 0,
      });
      return;
    case 12:
      system.stopMusic(rng() % 3000);
      return;
    case 13:
      system.tuneRadio(rng() % 4 === 0 ? "missing" : "station");
      return;
    case 14:
      system.stopRadio(rng() % 3000);
      return;
    case 15: {
      const id = rng() % 3 === 0 ? `shot-${rig.bufferSerial++ % 128}` : "shot";
      system.registerBuffer(id, fakeBuffer(4800, 1));
      return;
    }
    case 16:
      system.releaseBuffer(rng() % 3 === 0 ? `shot-${rng() % 128}` : "shot");
      return;
    case 17:
      if (rng() % 2 === 0) system.registerStream("stream-b", "audio/stream-b.opus");
      else system.releaseStream("stream-b");
      return;
    case 18:
      rig.fake.last()?.advance(unit(rng) * 0.5);
      system.update(unit(rng) * 0.05);
      return;
    case 19: {
      const volume = rng() % 4 === 0 ? Number.NaN : unit(rng);
      const roll = rng() % 3;
      if (roll === 0) system.mixer.setMasterVolume(volume);
      else if (roll === 1) {
        system.mixer.setBusVolume(pick(rng, BUSES) ?? "sfx", volume, rng() % 500);
      } else if (rng() % 2 === 0) {
        system.mixer.setBusMuted(pick(rng, BUSES) ?? "sfx", rng() % 2 === 0);
      } else {
        system.mixer.setMuted(rng() % 2 === 0);
      }
      return;
    }
    case 20:
      system.listener.setPosition(
        unit(rng) * 20 - 10,
        unit(rng) * 20 - 10,
        unit(rng) * 20 - 10,
      );
      if (rng() % 4 === 0) system.listener.setOrientation(0, 0, -1, 0, 1, 0);
      return;
    default:
      return;
  }
}

interface Snapshot {
  readonly state: "locked" | "unlocked" | "unavailable";
  readonly steals: number;
  readonly droppedPlays: number;
  readonly interruptions: number;
}

function verify(
  system: EngineAudioSystem,
  previous: Snapshot,
  call: number,
  op: string,
): Snapshot {
  const fail = (message: string): never => {
    throw new Error(`invariant failed at call ${call} (${op}): ${message}`);
  };

  const state = system.state;
  if (state !== "locked" && state !== "unlocked" && state !== "unavailable") {
    fail(`unknown state ${String(state)}`);
  }
  const stats = system.stats;
  const numbers: ReadonlyArray<readonly [string, number]> = [
    ["activeVoices", stats.activeVoices],
    ["sfxVoices", stats.sfxVoices],
    ["spatialVoices", stats.spatialVoices],
    ["droppedPlays", stats.droppedPlays],
    ["decodedBytes", stats.decodedBytes],
    ["interruptions", stats.interruptions],
    ["steals", stats.steals],
    ["streamCount", system.streamCount],
    ["radioMisses", system.radioMisses],
    ["masterVolume", system.mixer.masterVolume],
    ["clock", system.clock.now],
  ];
  for (const [name, value] of numbers) {
    if (!Number.isFinite(value) || value < 0) fail(`${name} is ${value}`);
    if (!Number.isInteger(value) && name !== "masterVolume" && name !== "clock") {
      fail(`${name} is not an integer: ${value}`);
    }
  }
  if (stats.activeVoices > stats.sfxVoices + stats.spatialVoices) {
    fail(`activeVoices ${stats.activeVoices} exceeds the pools`);
  }
  if (stats.decodedBytes > BUDGET) fail(`decodedBytes ${stats.decodedBytes} over budget`);
  if (stats.steals < previous.steals) fail("steals went backwards");
  if (stats.droppedPlays < previous.droppedPlays) fail("droppedPlays went backwards");
  if (stats.interruptions < previous.interruptions) fail("interruptions went backwards");
  if (system.mixer.masterVolume > 1) fail("masterVolume above 1");
  if (state !== "unlocked" && system.clock.now !== 0) {
    fail(`clock is ${system.clock.now} while ${state}`);
  }
  if (previous.state === "unavailable" && state !== "unavailable") {
    fail("unavailable is terminal");
  }
  if (state === "unavailable" && stats.activeVoices !== 0) {
    fail(`activeVoices ${stats.activeVoices} while unavailable`);
  }
  if (state === "unavailable" && stats.streaming) fail("streaming while unavailable");

  return {
    state,
    steals: stats.steals,
    droppedPlays: stats.droppedPlays,
    interruptions: stats.interruptions,
  };
}

interface Coverage {
  locked: boolean;
  unlocked: boolean;
  suspended: boolean;
  unavailable: boolean;
}

interface SequenceResult {
  readonly coverage: Coverage;
  readonly calls: number;
  readonly closeCalls: number;
}

async function runSequence(
  seed: number,
  calls: number,
  factoryFails: boolean,
): Promise<SequenceResult> {
  const rig = createRig(factoryFails);
  const rng = createRng(seed);
  const coverage: Coverage = {
    locked: rig.system.state === "locked",
    unlocked: false,
    suspended: false,
    unavailable: rig.system.state === "unavailable",
  };
  let snapshot: Snapshot = {
    state: rig.system.state,
    steals: 0,
    droppedPlays: 0,
    interruptions: 0,
  };
  const disposeAt = Math.floor(calls * 0.8);

  for (let index = 0; index < calls; index += 1) {
    if (index === disposeAt) {
      rig.system.dispose();
      snapshot = verify(rig.system, snapshot, index, "dispose-milestone");
    } else {
      const op = index < 3 ? index : rng() % OP_NAMES.length;
      const name = OP_NAMES[op] ?? "unknown";
      try {
        await applyOp(op, rng, rig);
      } catch (error) {
        throw new Error(`call ${index} (${name}) threw: ${String(error)}`);
      }
      snapshot = verify(rig.system, snapshot, index, name);
    }

    if (snapshot.state === "locked") coverage.locked = true;
    if (snapshot.state === "unlocked") coverage.unlocked = true;
    if (snapshot.state === "unavailable") coverage.unavailable = true;
    if (rig.system.suspended) coverage.suspended = true;
  }

  // The second dispose is the documented no-op.
  rig.system.dispose();
  verify(rig.system, snapshot, calls, "dispose-again");
  return {
    coverage,
    calls,
    closeCalls: rig.fake.last()?.closeCalls.length ?? 0,
  };
}

describe("public API robustness", () => {
  test("[ER-09-14] 10,000 public calls across every state throw nothing and keep invariants", async () => {
    const result = await runSequence(0x5eed_1234, CALLS, false);

    expect(result.calls).toBe(CALLS);
    expect(result.coverage).toEqual({
      locked: true,
      unlocked: true,
      suspended: true,
      unavailable: true,
    });
    expect(result.closeCalls).toBe(1);
  });

  test("[ER-09-14] arbitrary seeds and a blocked factory keep the same invariants", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 0xffff_fffe }),
        fc.boolean(),
        async (seed, factoryFails) => {
          const result = await runSequence(seed, 250, factoryFails);
          expect(result.calls).toBe(250);
        },
      ),
      { numRuns: 20 },
    );
  });

  test("[ER-09-14] dispose twice is a no-op and the system is terminal", async () => {
    const rig = createRig(false);
    await rig.system.unlock();
    rig.system.playSfx("shot");
    rig.system.dispose();
    const context = rig.fake.last();

    expect(context?.closeCalls).toHaveLength(1);
    expect(rig.system.state).toBe("unavailable");

    expect(() => rig.system.dispose()).not.toThrow();
    expect(context?.closeCalls).toHaveLength(1);
    await expect(rig.system.unlock()).resolves.toBeUndefined();
    expect(rig.system.state).toBe("unavailable");
    expect(rig.system.stats.activeVoices).toBe(0);
    expect(rig.system.stats.decodedBytes).toBe(0);
    expect(rig.system.stats.streaming).toBe(false);
  });
});

/**
 * Voice-stealing policy — ER-09-04.
 *
 * Order: a free voice, then the lowest priority, then the oldest, then the
 * lowest index. A request never evicts a higher-priority voice; when every
 * voice is higher priority it is dropped and counted.
 *
 * The acceptance table in ER-09-04 also expects 64 equal-priority `playSfx`
 * calls into a pool of 8 to produce `droppedPlays = 56`. That conflicts with
 * §5.4, which permits stealing an equal-priority voice; the system follows
 * §5.4 (`steals = 56`, `droppedPlays = 0`) and the conflict is recorded in
 * `test/fixtures/README.md` and the final report.
 */

import { describe, expect, test } from "vitest";
import { EngineAudioSystem } from "../src/AudioSystem.js";
import { selectVoice, type VoiceCandidate } from "../src/voice/VoiceStealing.js";
import { createFakeFactory, fakeBuffer } from "./support/fakeAudio.js";

function candidate(
  index: number,
  active: boolean,
  priority: number,
  startedAt: number,
): VoiceCandidate {
  return { index, active, priority, startedAt };
}

describe("voice-stealing policy", () => {
  test("[ER-09-04] a free voice wins over every active voice", () => {
    const voices = [
      candidate(0, true, 128, 1),
      candidate(1, true, 128, 2),
      candidate(2, false, 0, 0),
    ];
    expect(selectVoice(voices, 128)).toBe(2);
  });

  test("[ER-09-04] the lowest priority is stolen first", () => {
    const voices = [candidate(0, true, 128, 10), candidate(1, true, 64, 5)];
    expect(selectVoice(voices, 128)).toBe(1);
  });

  test("[ER-09-04] a priority tie steals the oldest", () => {
    const voices = [candidate(0, true, 128, 2), candidate(1, true, 128, 1)];
    expect(selectVoice(voices, 128)).toBe(1);
  });

  test("[ER-09-04] an age tie steals the lowest index", () => {
    const voices = [candidate(0, true, 128, 1), candidate(1, true, 128, 1)];
    expect(selectVoice(voices, 128)).toBe(0);
  });

  test("[ER-09-04] a higher-priority voice is never stolen", () => {
    const voices = [candidate(0, true, 200, 1), candidate(1, true, 220, 2)];
    expect(selectVoice(voices, 128)).toBe(-1);
  });

  test("[ER-09-04] an equal-priority voice may be stolen", () => {
    const voices = [candidate(0, true, 128, 2), candidate(1, true, 128, 1)];
    expect(selectVoice(voices, 128)).toBe(1);
  });

  test("[ER-09-04] 64 equal-priority plays into 8 voices keep 8 audible and steal 56", async () => {
    const fake = createFakeFactory({ currentTime: 10 });
    const system = new EngineAudioSystem({ createContext: fake.factory });
    await system.unlock();
    system.registerBuffer("shot", fakeBuffer(480, 1));

    for (let index = 0; index < 64; index += 1) system.playSfx("shot");

    expect(system.stats.activeVoices).toBe(8);
    expect(system.stats.steals).toBe(56);
    // §5.4 permits the equal-priority steal, so nothing is dropped here.
    expect(system.stats.droppedPlays).toBe(0);
    system.dispose();
  });

  test("[ER-09-04] a higher-priority pool drops the request instead of stealing", async () => {
    const fake = createFakeFactory({ currentTime: 10 });
    const system = new EngineAudioSystem({
      createContext: fake.factory,
      sfxVoices: 2,
    });
    await system.unlock();
    system.registerBuffer("alarm", fakeBuffer(480, 1));

    const first = system.createSource({ assetId: "alarm", priority: 200 });
    const second = system.createSource({ assetId: "alarm", priority: 220 });
    system.play(first);
    system.play(second);
    expect(system.stats.activeVoices).toBe(2);

    const low = system.createSource({ assetId: "alarm", priority: 100 });
    system.play(low);
    expect(system.stats.droppedPlays).toBe(1);
    expect(system.stats.steals).toBe(0);
    expect(system.stats.activeVoices).toBe(2);
    system.dispose();
  });

  test("[ER-09-04] a stolen voice ramps from 0 over 5 ms", async () => {
    const fake = createFakeFactory({ currentTime: 10 });
    const system = new EngineAudioSystem({
      createContext: fake.factory,
      sfxVoices: 1,
    });
    await system.unlock();
    system.registerBuffer("shot", fakeBuffer(480, 1));
    system.playSfx("shot", { volume: 0.5 });
    system.playSfx("shot", { volume: 0.5 });

    const context = fake.last();
    expect(context).toBeDefined();
    if (context === undefined) return;
    // Gain order: master, five buses, then voice 0.
    const voiceGain = context.createdGains[6];
    expect(voiceGain).toBeDefined();
    if (voiceGain === undefined) return;
    const lastRamp = voiceGain.gain.ofType("ramp").at(-1);
    const lastSet = voiceGain.gain.ofType("set").at(-1);
    expect(voiceGain.gain.writes.length).toBeGreaterThan(0);
    expect(lastSet?.value).toBe(0);
    expect(lastRamp?.value).toBeCloseTo(0.5, 6);
    expect(lastRamp?.time).toBeCloseTo(10.01, 6);
    system.dispose();
  });

  test("[ER-09-04] stealing is bounded by the pool size", async () => {
    const fake = createFakeFactory({ currentTime: 4 });
    const system = new EngineAudioSystem({
      createContext: fake.factory,
      sfxVoices: 3,
    });
    await system.unlock();
    system.registerBuffer("shot", fakeBuffer(480, 1));
    for (let index = 0; index < 10; index += 1) system.playSfx("shot");

    expect(system.stats.activeVoices).toBeLessThanOrEqual(3);
    expect(system.stats.steals).toBe(7);
    system.dispose();
  });
});

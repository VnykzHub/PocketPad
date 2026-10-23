/**
 * M0 `AudioBus` migration parity — ER-09-10.
 *
 * A behaviour-for-behaviour port of `packages/runtime/test/audioBus.test.ts`
 * (FR-9.11, C8, E11) onto the DOM-free seams. Every original assertion is
 * preserved; only the fake wiring changed (`HostAudioContext` structural fakes,
 * no cast to a DOM `AudioContext`). The additions are the frozen rules the
 * parity suite did not cover: concurrent unlocks still construct one context,
 * a `BlobLike` decode input, and the non-finite volume clamp.
 *
 * This is unit evidence for the migration, not a browser result. The second
 * half of ER-09-10 (both reference games unlock from the start-screen gesture)
 * needs the runtime start-screen integration and stays PENDING here.
 */

import { describe, expect, test } from "vitest";
import { AudioBus } from "../src/AudioBus.js";
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioLatencyHint,
} from "../src/contracts/audio.js";
import { DEFAULT_SFX_VOICES } from "../src/version.js";
import { FakeContext, fakeBuffer } from "./support/fakeAudio.js";

interface BusHarness {
  readonly bus: AudioBus;
  readonly contexts: FakeContext[];
  readonly hints: AudioLatencyHint[];
}

function makeBus(
  options: {
    latencyHint?: AudioLatencyHint;
    masterVolume?: number;
    sfxVoices?: number;
  } = {},
): BusHarness {
  const contexts: FakeContext[] = [];
  const hints: AudioLatencyHint[] = [];
  const bus = new AudioBus({
    ...options,
    createContext: (latencyHint) => {
      hints.push(latencyHint);
      const context = new FakeContext();
      contexts.push(context);
      return context as unknown as AudioContextLike;
    },
  });
  return { bus, contexts, hints };
}

function audioBuffer(): AudioBufferLike {
  return fakeBuffer(48000, 1);
}

function contextOf(harness: BusHarness): FakeContext {
  const context = harness.contexts[0];
  if (context === undefined) throw new Error("no context was constructed");
  return context;
}

describe("audio unlock", () => {
  test("[ER-09-10] no AudioContext exists and nothing plays before unlock", () => {
    const { bus, contexts } = makeBus();
    bus.registerSfx("hit", audioBuffer());
    bus.registerMusic("theme", audioBuffer());

    expect(bus.state).toBe("locked");
    expect(bus.unlocked).toBe(false);
    expect(bus.available).toBe(true);
    expect(bus.now()).toBe(0);

    // A game that triggers sound from init must stay silent.
    bus.playSfx("hit");
    bus.playMusic("theme");

    expect(contexts).toHaveLength(0);
    expect(bus.state).toBe("locked");
  });

  test("[ER-09-10] unlock creates exactly one context and resumes it from the gesture", async () => {
    const harness = makeBus();
    const { bus } = harness;

    await bus.unlock();

    expect(harness.contexts).toHaveLength(1);
    const context = contextOf(harness);
    expect(harness.hints).toEqual(["interactive"]);
    expect(bus.latencyHint).toBe("interactive");
    expect(context.resumeCalls).toHaveLength(1);
    expect(context.state).toBe("running");
    expect(bus.state).toBe("unlocked");
    expect(bus.unlocked).toBe(true);
    expect(bus.now()).toBe(context.currentTime);

    // A second gesture reuses the same context and does not resume twice.
    await bus.unlock();
    expect(harness.contexts).toHaveLength(1);
    expect(context.resumeCalls).toHaveLength(1);
  });

  test("[ER-09-10] ten concurrent unlocks construct exactly one context", async () => {
    const harness = makeBus();
    const { bus } = harness;

    await Promise.all(Array.from({ length: 10 }, () => bus.unlock()));

    expect(harness.contexts).toHaveLength(1);
    expect(contextOf(harness).resumeCalls).toHaveLength(1);
    expect(bus.state).toBe("unlocked");
  });

  test("[ER-09-10] the latency hint is passed to the context factory", async () => {
    const harness = makeBus({ latencyHint: "balanced" });
    await harness.bus.unlock();
    expect(harness.hints).toEqual(["balanced"]);
    expect(harness.bus.latencyHint).toBe("balanced");
  });

  test("[ER-09-10] a blocked or missing Web Audio becomes a silent fallback", async () => {
    let attempts = 0;
    const bus = new AudioBus({
      createContext: () => {
        attempts += 1;
        throw new Error("AudioContext blocked");
      },
    });

    await expect(bus.unlock()).resolves.toBeUndefined();

    expect(attempts).toBe(1);
    expect(bus.state).toBe("unavailable");
    expect(bus.unlocked).toBe(false);
    expect(bus.available).toBe(false);
    expect(bus.now()).toBe(0);
    // Playback and decoding never throw into game code.
    expect(() => bus.playSfx("hit")).not.toThrow();
    expect(() => bus.playMusic("theme")).not.toThrow();
    await expect(bus.decodeAudio(new ArrayBuffer(4))).rejects.toThrow(/locked/i);
  });

  test("[ER-09-10] decoding audio requires the unlock gesture", async () => {
    const harness = makeBus();
    const { bus } = harness;
    await expect(bus.decodeAudio(new ArrayBuffer(8))).rejects.toThrow(/locked/i);
    expect(harness.contexts).toHaveLength(0);

    await bus.unlock();
    const context = contextOf(harness);

    const decoded = await bus.decodeAudio(new ArrayBuffer(8));
    expect(decoded.length).toBe(1);
    expect(context.decodedByteArrays).toHaveLength(1);

    // A BlobLike seam (a browser `Blob`) takes the arrayBuffer() path.
    const blob = {
      arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(8)),
    };
    const fromBlob = await bus.decodeAudio(blob);
    expect(fromBlob.duration).toBeGreaterThan(0);
    expect(context.decodedByteArrays).toHaveLength(2);
  });
});

describe("audio mixer", () => {
  test("[ER-09-10] the master gain sits between every voice and the destination", async () => {
    const harness = makeBus();
    harness.bus.setMasterVolume(0.25);
    await harness.bus.unlock();

    const context = contextOf(harness);
    const master = context.createdGains[0];
    expect(master).toBeDefined();
    if (master === undefined) return;
    expect(master.connections[0]).toBe(context.destination);
    expect(master.gain.value).toBe(0.25);
    expect(harness.bus.masterVolume).toBe(0.25);

    // Every other gain (music and SFX voices) routes through master.
    for (const gain of context.createdGains.slice(1)) {
      expect(gain.connections[0]).toBe(master);
    }

    harness.bus.setMasterVolume(2);
    expect(harness.bus.masterVolume).toBe(1);
    expect(master.gain.value).toBe(1);
    harness.bus.setMasterVolume(-3);
    expect(harness.bus.masterVolume).toBe(0);
  });

  test("[ER-09-10] a non-finite master volume clamps to silence, not to the default", async () => {
    const harness = makeBus({ masterVolume: Number.NaN });
    expect(harness.bus.masterVolume).toBe(0);
    await harness.bus.unlock();
    expect(contextOf(harness).createdGains[0]?.gain.value).toBe(0);

    harness.bus.setMasterVolume(Number.POSITIVE_INFINITY);
    expect(harness.bus.masterVolume).toBe(0);
  });

  test("[ER-09-10] pause suspends output, blocks playback and resume restores it", async () => {
    const harness = makeBus();
    const { bus } = harness;
    const hit = audioBuffer();
    bus.registerSfx("hit", hit);
    await bus.unlock();
    const context = contextOf(harness);
    const resumeCallsAfterUnlock = context.resumeCalls.length;

    bus.pause();
    expect(bus.paused).toBe(true);
    expect(context.suspendCalls).toHaveLength(1);
    expect(context.state).toBe("suspended");

    bus.playSfx("hit");
    expect(context.createdSources).toHaveLength(0);

    await bus.resume();
    expect(bus.paused).toBe(false);
    expect(context.resumeCalls).toHaveLength(resumeCallsAfterUnlock + 1);
    expect(context.state).toBe("running");

    bus.playSfx("hit");
    expect(context.createdSources).toHaveLength(1);
  });

  test("[ER-09-10] SFX voices are pooled and reused round-robin", async () => {
    const harness = makeBus({ sfxVoices: 2 });
    const { bus } = harness;
    const hit = audioBuffer();
    bus.registerSfx("hit", hit);
    await bus.unlock();
    const context = contextOf(harness);
    // master + music + two voices.
    expect(context.createdGains).toHaveLength(4);
    const gainsAfterUnlock = context.createdGains.length;
    const voices = context.createdGains.slice(2);

    bus.playSfx("hit", { volume: 0.5, rate: 2 });
    const first = context.createdSources[0];
    expect(first?.buffer).toBe(hit);
    expect(first?.playbackRate.value).toBe(2);
    expect(voices[0]?.gain.value).toBe(0.5);
    expect(first?.connections[0]).toBe(voices[0]);

    bus.playSfx("hit");
    expect(context.createdSources).toHaveLength(2);
    expect(context.createdSources[1]?.connections[0]).toBe(voices[1]);

    // Third trigger wraps to voice 0 and stops its still-playing sample.
    bus.playSfx("hit");
    expect(first?.stopCalls).toHaveLength(1);
    expect(context.createdSources[2]?.connections[0]).toBe(voices[0]);
    expect(context.createdGains).toHaveLength(gainsAfterUnlock);
  });

  test("[ER-09-10] unknown SFX ids are ignored instead of crashing the host", async () => {
    const harness = makeBus();
    await harness.bus.unlock();
    const context = contextOf(harness);

    harness.bus.playSfx("missing");
    expect(context.createdSources).toHaveLength(0);
  });

  test("[ER-09-10] the default voice count is the frozen eight", () => {
    expect(DEFAULT_SFX_VOICES).toBe(8);
  });
});

describe("music", () => {
  test("[ER-09-10] playMusic fades in on the audio clock and loops by default", async () => {
    const harness = makeBus();
    const { bus } = harness;
    const theme = audioBuffer();
    bus.registerMusic("theme", theme);
    await bus.unlock();
    const context = contextOf(harness);
    const musicGain = context.createdGains[1];

    context.currentTime = 1;
    bus.playMusic("theme", { fadeMs: 200, volume: 0.8 });

    const source = context.createdSources[0];
    expect(source?.buffer).toBe(theme);
    expect(source?.loop).toBe(true);
    expect(source?.startCalls).toHaveLength(1);
    expect(source?.connections[0]).toBe(musicGain);
    expect(musicGain?.gain.writes).toEqual([
      { type: "cancel", value: 0, time: 1 },
      { type: "set", value: 0, time: 1 },
      { type: "ramp", value: 0.8, time: 1.2 },
    ]);
  });

  test("[ER-09-10] stopMusic fades without a click and schedules the source stop", async () => {
    const harness = makeBus();
    const { bus } = harness;
    bus.registerMusic("theme", audioBuffer());
    await bus.unlock();
    const context = contextOf(harness);
    const musicGain = context.createdGains[1];

    bus.playMusic("theme", { volume: 0.8 });
    const source = context.createdSources[0];

    context.currentTime = 2;
    bus.stopMusic(500);

    expect(musicGain?.gain.writes.at(-2)).toEqual({
      type: "set",
      value: 0.8,
      time: 2,
    });
    expect(musicGain?.gain.writes.at(-1)).toEqual({
      type: "ramp",
      value: 0,
      time: 2.5,
    });
    expect(source?.stopCalls).toEqual([2.5]);

    // A second stop is a no-op once the active track was consumed.
    bus.stopMusic(500);
    expect(source?.stopCalls).toHaveLength(1);
  });

  test("[ER-09-10] stopMusic with no fade stops immediately", async () => {
    const harness = makeBus();
    const { bus } = harness;
    bus.registerMusic("theme", audioBuffer());
    await bus.unlock();
    const context = contextOf(harness);

    bus.playMusic("theme");
    const source = context.createdSources[0];
    context.currentTime = 3;
    bus.stopMusic();

    expect(source?.stopCalls).toEqual([3]);
  });

  test("[ER-09-10] playing a new track stops the previous one", async () => {
    const harness = makeBus();
    const { bus } = harness;
    bus.registerMusic("a", audioBuffer());
    bus.registerMusic("b", audioBuffer());
    await bus.unlock();
    const context = contextOf(harness);

    bus.playMusic("a");
    const first = context.createdSources[0];
    bus.playMusic("b");

    expect(first?.stopCalls).toHaveLength(1);
    expect(context.createdSources).toHaveLength(2);
  });

  test("[ER-09-10] music and SFX are silent before unlock and while paused", async () => {
    const harness = makeBus();
    const { bus } = harness;
    bus.registerMusic("theme", audioBuffer());
    bus.playMusic("theme");
    expect(harness.contexts).toHaveLength(0);

    await bus.unlock();
    const context = contextOf(harness);
    bus.pause();
    bus.playMusic("theme");
    expect(context.createdSources).toHaveLength(0);
  });
});

describe("audio clock", () => {
  test("[C8] now() is the AudioContext clock so rhythm games can schedule beats", async () => {
    const harness = makeBus();
    const { bus } = harness;
    expect(bus.now()).toBe(0);

    await bus.unlock();
    const context = contextOf(harness);
    context.currentTime = 42.125;

    expect(bus.now()).toBe(42.125);
    // A beat scheduled against the audio clock, not performance.now().
    expect(bus.now() + 0.5).toBe(42.625);
  });

  test("[E11] output latency is readable from the audio clock after unlock", async () => {
    const harness = makeBus();
    const { bus } = harness;
    expect(bus.baseLatency).toBe(0);
    expect(bus.outputLatency).toBe(0);

    await bus.unlock();
    const context = contextOf(harness);
    context.currentTime = 12.5;
    (context as { baseLatency: number }).baseLatency = 0.01;
    (context as { outputLatency: number }).outputLatency = 0.032;

    expect(bus.now()).toBe(12.5);
    expect(bus.baseLatency).toBeCloseTo(0.01, 10);
    expect(bus.outputLatency).toBeCloseTo(0.032, 10);
  });

  test("[E11] outputLatency falls back to baseLatency when the browser omits it", async () => {
    const harness = makeBus();
    await harness.bus.unlock();
    const context = contextOf(harness);
    (context as { baseLatency: number }).baseLatency = 0.015;
    delete (context as unknown as { outputLatency?: number }).outputLatency;

    expect(harness.bus.outputLatency).toBeCloseTo(0.015, 10);
  });
});

describe("dispose", () => {
  test("[ER-09-10] dispose stops music and closes the context", async () => {
    const harness = makeBus();
    const { bus } = harness;
    bus.registerMusic("theme", audioBuffer());
    bus.registerSfx("hit", audioBuffer());
    await bus.unlock();
    const context = contextOf(harness);

    bus.playMusic("theme");
    const source = context.createdSources[0];
    bus.dispose();

    expect(source?.stopCalls).toHaveLength(1);
    expect(context.closeCalls).toHaveLength(1);
    expect(bus.state).toBe("unavailable");
    expect(bus.unlocked).toBe(false);
    expect(() => bus.playMusic("theme")).not.toThrow();
  });
});

/**
 * `AudioSystem` behaviour on a fake graph — spec 09 §3.5, §5.2–§5.9.
 *
 * Unit evidence only: the fake records scheduled writes and node edges. The
 * offline-render rows (ER-09-02/03/05), the browser rows (ER-09-08/13), the
 * latency row (ER-09-07) and the heap row (ER-09-11) stay PENDING and are not
 * claimed here.
 */

import { describe, expect, test } from "vitest";
import { EngineAudioSystem } from "../src/AudioSystem.js";
import type {
  AudioMixConfig,
  AudioSystemOptions,
} from "../src/contracts/audio.js";
import {
  FakeMediaElement,
  createFakeFactory,
  fakeBuffer,
} from "./support/fakeAudio.js";
import type { FakeContext, FakeContextOptions } from "./support/fakeAudio.js";

const MASTER = 0;
const MUSIC_BUS = 1;
const SFX_BUS = 2;
const AMBIENT_BUS = 3;
const UI_BUS = 5;
const FIRST_VOICE_GAIN = 6;

function fullMix(overrides: Partial<AudioMixConfig> = {}): AudioMixConfig {
  return {
    formatVersion: 1,
    masterVolume: 1,
    buses: { music: 1, sfx: 1, ambient: 1, voice: 1, ui: 1 },
    sfxVoices: 8,
    spatialVoices: 16,
    defaults: {
      distanceModel: "inverse",
      panningModel: "equalpower",
      refDistance: 1,
      maxDistance: 100,
      rolloff: 1,
    },
    ...overrides,
  } as AudioMixConfig;
}

interface Rig {
  readonly system: EngineAudioSystem;
  readonly context: FakeContext;
  readonly fake: ReturnType<typeof createFakeFactory>;
}

async function unlockRig(
  contextOptions: FakeContextOptions = { currentTime: 10 },
  systemOptions: Omit<AudioSystemOptions, "createContext"> = {},
): Promise<Rig> {
  const fake = createFakeFactory(contextOptions);
  const system = new EngineAudioSystem({ createContext: fake.factory, ...systemOptions });
  await system.unlock();
  const context = fake.last();
  if (context === undefined) throw new Error("unlock did not construct a context");
  return { system, context, fake };
}

function sourceOf(
  context: { createdSources: unknown[] },
  index = -1,
): {
  startCalls: number[];
  stopCalls: number[];
  loop: boolean;
  playbackRate: { writes: Array<{ type: string; value: number; time: number }> };
  fireEnded(): void;
} | undefined {
  return (
    context.createdSources as Array<{
      startCalls: number[];
      stopCalls: number[];
      loop: boolean;
      playbackRate: { writes: Array<{ type: string; value: number; time: number }> };
      fireEnded(): void;
    }>
  ).at(index);
}

describe("construction and options", () => {
  test("[09 §5.2] defaults are the frozen values and no context exists yet", () => {
    const system = new EngineAudioSystem();
    expect(system.state).toBe("locked");
    expect(system.stats.sfxVoices).toBe(8);
    expect(system.stats.spatialVoices).toBe(16);
    expect(system.stats.decodedBytes).toBe(0);
    expect(system.stats.streaming).toBe(false);
    expect(system.stats.interruptions).toBe(0);
    expect(system.mixer.masterVolume).toBe(1);
    expect(system.clock.now).toBe(0);
    system.dispose();
  });

  test("[09 §5.2] mix values are clamped and explicit options win", async () => {
    const fromMix = new EngineAudioSystem({
      mix: fullMix({ masterVolume: 2, sfxVoices: 100, spatialVoices: 0 }),
    });
    expect(fromMix.mixer.masterVolume).toBe(1);
    expect(fromMix.stats.sfxVoices).toBe(32);
    expect(fromMix.stats.spatialVoices).toBe(1);
    fromMix.dispose();

    const forced = new EngineAudioSystem({
      mix: fullMix(),
      masterVolume: 0.5,
      sfxVoices: 4,
    });
    expect(forced.mixer.masterVolume).toBe(0.5);
    expect(forced.stats.sfxVoices).toBe(4);
    forced.dispose();

    const { system, context } = await unlockRig({ currentTime: 10 }, { masterVolume: 0.25 });
    expect(context.createdGains[MASTER]?.gain.value).toBe(0.25);
    system.dispose();
  });
});

describe("bus graph and mixer", () => {
  test("[09 §5.3] master and five buses exist once, in order", async () => {
    const { system, context } = await unlockRig();
    // master + 5 buses + 8 SFX voices + 16 spatial voices + 2 decks
    expect(context.createdGains).toHaveLength(6 + 8 + 16 + 2);
    const master = context.createdGains[MASTER];
    expect(master).toBeDefined();
    if (master === undefined) return;
    expect(master.connections).toEqual([context.destination]);
    for (let index = MUSIC_BUS; index <= UI_BUS; index += 1) {
      expect(context.createdGains[index]?.connections).toEqual([master]);
      expect(context.createdGains[index]?.gain.value).toBe(1);
    }
    system.dispose();
  });

  test("[09 §5.3] playSfx routes the voice into the requested bus", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("shot", fakeBuffer(480, 1));

    system.playSfx("shot", { bus: "ui" });
    const uiVoice = context.createdGains[FIRST_VOICE_GAIN];
    expect(uiVoice?.connections).toEqual([context.createdGains[UI_BUS]]);

    system.playSfx("shot", { bus: "ambient" });
    const ambientVoice = context.createdGains[FIRST_VOICE_GAIN + 1];
    expect(ambientVoice?.connections).toEqual([context.createdGains[AMBIENT_BUS]]);
    system.dispose();
  });

  test("[09 §5.3] the mixer stores levels before unlock, applies at unlock, and mutes independently", async () => {
    const fake = createFakeFactory({ currentTime: 10 });
    const system = new EngineAudioSystem({
      createContext: fake.factory,
      masterVolume: 0.5,
    });
    system.mixer.setBusVolume("music", 0.3);
    system.mixer.setBusMuted("sfx", true);
    expect(system.mixer.getBusVolume("music")).toBe(0.3);

    await system.unlock();
    const context = fake.last();
    if (context === undefined) return;
    expect(context.createdGains[MASTER]?.gain.value).toBe(0.5);
    expect(context.createdGains[MUSIC_BUS]?.gain.value).toBe(0.3);
    expect(context.createdGains[SFX_BUS]?.gain.value).toBe(0);
    expect(system.mixer.busMuted("sfx")).toBe(true);

    system.mixer.setMuted(true);
    expect(context.createdGains[MASTER]?.gain.value).toBe(0);
    expect(system.mixer.muted).toBe(true);
    system.mixer.setMuted(false);
    expect(context.createdGains[MASTER]?.gain.value).toBe(0.5);
    system.dispose();
  });
});

describe("one-shot scheduling", () => {
  test("[09 §5.7] playSfx starts 5 ms ahead with the requested volume and rate", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("shot", fakeBuffer(480, 1));
    system.playSfx("shot", { volume: 0.5, rate: 2 });

    const source = sourceOf(context);
    expect(source?.startCalls).toEqual([10.005]);
    expect(source?.loop).toBe(false);
    expect(source?.playbackRate.writes.at(-1)).toEqual({
      type: "set",
      value: 2,
      time: 10.005,
    });
    const gain = context.createdGains[FIRST_VOICE_GAIN];
    expect(gain?.gain.writes.at(-1)).toEqual({ type: "set", value: 0.5, time: 10.005 });
    system.dispose();
  });

  test("[09 §5.7] an explicit `at` is clamped into [now + 5 ms, now + 10 s]", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("shot", fakeBuffer(480, 1));
    const handle = system.createSource({ assetId: "shot" });

    system.play(handle, { at: 30 });
    expect(sourceOf(context)?.startCalls).toEqual([20]);

    system.play(handle, { at: 10 });
    expect(sourceOf(context)?.startCalls).toEqual([10.005]);
    system.dispose();
  });

  test("[09 §5.7] update never starts a source", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("shot", fakeBuffer(480, 1));
    system.update(0.016);
    system.update(0.016);
    expect(context.createdSources).toHaveLength(0);
    system.dispose();
  });

  test("[09 §5.7] a missing buffer is a silent no-op", async () => {
    const { system, context } = await unlockRig();
    system.playSfx("missing");
    const handle = system.createSource({ assetId: "missing" });
    system.play(handle);
    expect(context.createdSources).toHaveLength(0);
    expect(system.stats.activeVoices).toBe(0);
    expect(system.stats.droppedPlays).toBe(0);
    system.dispose();
  });
});

describe("positional playback", () => {
  test("[ER-09-02] the native panner receives the source position", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("shot", fakeBuffer(480, 1));
    const handle = system.createSource({
      assetId: "shot",
      positional: true,
      volume: 0.5,
      priority: 200,
    });
    system.setSourcePosition(handle, 2, 0, 0);
    system.play(handle);

    expect(context.createdPanners).toHaveLength(16);
    const panner = context.createdPanners[0];
    expect(panner?.positionX.writes.at(-1)?.value).toBe(2);
    expect(panner?.panningModel).toBe("equalpower");
    // A native panner owns attenuation, so the voice gain stays at volume.
    const gain = context.createdGains[6 + 8];
    expect(gain?.gain.ofType("set").at(-1)?.value).toBe(0.5);
    system.dispose();
  });

  test("[ER-09-03] the stereo fallback applies distance gain and equal-power pan", async () => {
    const { system, context } = await unlockRig({ currentTime: 10, hasPanner: false });
    system.registerBuffer("shot", fakeBuffer(480, 1));
    const handle = system.createSource({
      assetId: "shot",
      positional: true,
      volume: 0.5,
      priority: 200,
    });
    system.setSourcePosition(handle, 5, 0, 0);
    system.play(handle);

    expect(context.createdPanners).toHaveLength(0);
    expect(context.createdStereoPanners).toHaveLength(16);
    const gain = context.createdGains[6 + 8];
    // 0.5 volume × inverse attenuation at 5 m (ref 1, rolloff 1) = 0.5 × 0.2.
    expect(gain?.gain.ofType("set").at(-1)?.value).toBeCloseTo(0.1, 6);
    expect(context.createdStereoPanners[0]?.pan.writes.at(-1)?.value).toBeCloseTo(1, 6);
    system.dispose();
  });

  test("[ER-09-03] without any panner only attenuation applies", async () => {
    const { system, context } = await unlockRig({
      currentTime: 10,
      hasPanner: false,
      hasStereoPanner: false,
    });
    system.registerBuffer("shot", fakeBuffer(480, 1));
    const handle = system.createSource({
      assetId: "shot",
      positional: true,
      volume: 0.5,
      priority: 200,
    });
    system.setSourcePosition(handle, 5, 0, 0);
    system.play(handle);

    expect(context.createdStereoPanners).toHaveLength(0);
    const gain = context.createdGains[6 + 8];
    expect(gain?.gain.ofType("set").at(-1)?.value).toBeCloseTo(0.1, 6);
    system.dispose();
  });

  test("[ER-09-03] moving a fallback voice re-applies attenuation immediately", async () => {
    const { system, context } = await unlockRig({ currentTime: 10, hasPanner: false });
    system.registerBuffer("shot", fakeBuffer(480, 1));
    const handle = system.createSource({
      assetId: "shot",
      positional: true,
      volume: 0.5,
      priority: 200,
    });
    system.setSourcePosition(handle, 5, 0, 0);
    system.play(handle);

    system.setSourcePosition(handle, 20, 0, 0);
    const gain = context.createdGains[6 + 8];
    // 0.5 × distanceGain(inverse, 20 m) = 0.5 × 0.05.
    expect(gain?.gain.ofType("target").at(-1)?.value).toBeCloseTo(0.025, 6);
    system.dispose();
  });
});

describe("music and radio", () => {
  test("[ER-09-05] a faded music start anchors at now + 20 ms and ramps", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("theme", fakeBuffer(4800, 1));
    system.playMusic("theme", { fadeMs: 500 });

    expect(sourceOf(context)?.startCalls).toEqual([10.02]);
    const deckA = context.createdGains.at(-2);
    expect(deckA?.gain.ofType("set").at(-1)).toEqual({
      type: "set",
      value: 0,
      time: 10.02,
    });
    const ramp = deckA?.gain.ofType("ramp").at(-1);
    expect(ramp?.value).toBe(1);
    expect(ramp?.time).toBeCloseTo(10.52, 6);
    expect(system.musicPlaying).toBe(true);
    system.dispose();
  });

  test("[ER-09-05] unfaded music starts at the current clock", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("theme", fakeBuffer(4800, 1));
    system.playMusic("theme");

    expect(sourceOf(context)?.startCalls).toEqual([10]);
    expect(context.createdGains.at(-2)?.gain.writes.at(-1)).toEqual({
      type: "set",
      value: 1,
      time: 10,
    });
    system.dispose();
  });

  test("[ER-09-05] stopMusic fades to silence and clears the track", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("theme", fakeBuffer(4800, 1));
    system.playMusic("theme");

    context.advance(1);
    system.stopMusic(500);
    expect(system.musicPlaying).toBe(false);
    expect(sourceOf(context)?.stopCalls.at(-1)).toBeCloseTo(11.5, 6);
    const ramp = context.createdGains.at(-2)?.gain.ofType("ramp").at(-1);
    expect(ramp?.value).toBe(0);
    expect(ramp?.time).toBeCloseTo(11.5, 6);

    context.advance(0.5);
    system.update(0);
    expect(system.musicPlaying).toBe(false);
    system.dispose();
  });

  test("[ER-09-05] replacing a fading track uses the idle deck", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("a", fakeBuffer(4800, 1));
    system.registerBuffer("b", fakeBuffer(4800, 1));
    system.playMusic("a");
    system.playMusic("b", { fadeMs: 500 });

    expect(context.createdSources).toHaveLength(2);
    const deckB = context.createdGains.at(-1);
    const ramp = deckB?.gain.ofType("ramp").at(-1);
    expect(ramp?.value).toBe(1);
    expect(ramp?.time).toBeCloseTo(10.52, 6);
    system.dispose();
  });

  test("[ER-09-05] the default radio crossfade is equal-power over 1.5 s", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("track-a", fakeBuffer(4800, 1));
    system.registerBuffer("track-b", fakeBuffer(4800, 1));
    system.registerRadioStation({
      id: "vice-fm",
      tracks: ["track-a", "track-b"],
      loop: true,
    });
    system.tuneRadio("vice-fm");

    expect(system.radioStationId).toBe("vice-fm");
    const deckA = context.createdGains.at(-2);
    const curve = deckA?.gain.ofType("curve").at(-1);
    expect(curve?.time).toBe(10);
    expect(curve?.values).toHaveLength(64);
    expect(curve?.values?.[0]).toBeCloseTo(0, 6);
    expect(curve?.values?.at(-1)).toBeCloseTo(1, 6);
    system.dispose();
  });

  test("[ER-09-05] radio advances when the track ends and loops the station", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("track-a", fakeBuffer(4800, 1));
    system.registerBuffer("track-b", fakeBuffer(4800, 1));
    system.registerRadioStation({
      id: "vice-fm",
      tracks: ["track-a", "track-b"],
      loop: true,
    });
    system.tuneRadio("vice-fm");
    expect(context.createdSources).toHaveLength(1);

    sourceOf(context)?.fireEnded();
    system.update(0);
    expect(context.createdSources).toHaveLength(2);
    expect(system.radioStationId).toBe("vice-fm");
    system.dispose();
  });

  test("[ER-09-05] a non-looping one-track station stops at the end", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("track-a", fakeBuffer(4800, 1));
    system.registerRadioStation({
      id: "vice-fm",
      tracks: ["track-a"],
      loop: false,
    });
    system.tuneRadio("vice-fm");

    sourceOf(context)?.fireEnded();
    system.update(0);
    expect(system.radioStationId).toBeNull();
    system.dispose();
  });

  test("[09 §4.3] an unknown station is a counted no-op", async () => {
    const { system, context } = await unlockRig();
    system.tuneRadio("missing");
    expect(system.radioMisses).toBe(1);
    expect(system.radioStationId).toBeNull();
    expect(context.createdSources).toHaveLength(0);
    system.dispose();
  });

  test("[09 §5.6] a streamed station routes a media element and prefetches the next track", async () => {
    const elements: FakeMediaElement[] = [];
    const { system, context } = await unlockRig(
      { currentTime: 10 },
      {
        createMediaElement: () => {
          const element = new FakeMediaElement();
          elements.push(element);
          return element;
        },
      },
    );
    system.registerStream("stream-a", "audio/radio/a.opus");
    system.registerStream("stream-b", "audio/radio/b.opus");
    system.registerRadioStation({
      id: "vice-fm",
      tracks: ["stream-a", "stream-b"],
      loop: true,
    });
    system.tuneRadio("vice-fm");

    expect(elements).toHaveLength(1);
    expect(elements[0]?.src).toBe("audio/radio/a.opus");
    expect(elements[0]?.playCalls).toBe(1);
    expect(elements[0]?.muted).toBe(false);
    expect(context.createdMediaElementSources).toHaveLength(1);
    expect(system.stats.streaming).toBe(true);

    system.update(0.016);
    expect(elements).toHaveLength(2);
    expect(elements[1]?.src).toBe("audio/radio/b.opus");
    expect(elements[1]?.muted).toBe(true);
    expect(elements[1]?.playCalls).toBe(0);
    system.dispose();
  });

  test("[09 §5.6] without media routing the element carries the level", async () => {
    const elements: FakeMediaElement[] = [];
    const { system } = await unlockRig(
      { currentTime: 10, routesMediaElement: false },
      {
        createMediaElement: () => {
          const element = new FakeMediaElement();
          elements.push(element);
          return element;
        },
      },
    );
    system.registerStream("song", "audio/song.opus");
    system.playMusic("song", { volume: 0.4 });

    expect(elements[0]?.volume).toBeCloseTo(0.4, 6);
    expect(elements[0]?.playCalls).toBe(1);
    system.dispose();
  });

  test("[ER-09-05] music and radio are mutually exclusive", async () => {
    const { system } = await unlockRig();
    system.registerBuffer("theme", fakeBuffer(4800, 1));
    system.registerBuffer("track-a", fakeBuffer(4800, 1));
    system.registerRadioStation({ id: "vice-fm", tracks: ["track-a"], loop: true });

    system.playMusic("theme");
    system.tuneRadio("vice-fm");
    expect(system.musicPlaying).toBe(false);
    expect(system.radioStationId).toBe("vice-fm");

    system.playMusic("theme");
    expect(system.radioStationId).toBeNull();
    expect(system.musicPlaying).toBe(true);
    system.dispose();
  });
});

describe("suspend, interruption and dispose", () => {
  test("[ER-09-08] explicit suspend preserves the track and the clock", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("theme", fakeBuffer(4800, 1));
    system.playMusic("theme");
    context.advance(1);

    await system.suspend();
    expect(system.suspended).toBe(true);
    expect(system.stats.interruptions).toBe(0);
    expect(context.suspendCalls).toHaveLength(1);
    expect(context.createdSources).toHaveLength(1);
    expect(system.clock.now).toBe(11);

    await system.resume();
    expect(system.suspended).toBe(false);
    expect(system.musicPlaying).toBe(true);
    expect(system.clock.now).toBe(11);
    expect(context.createdSources).toHaveLength(1);
    system.dispose();
  });

  test("[ER-09-08] a context interruption is counted and clears on resume", async () => {
    const { system, context } = await unlockRig();
    expect(system.stats.interruptions).toBe(0);

    context.transition("interrupted");
    expect(system.stats.interruptions).toBe(1);
    expect(system.suspended).toBe(true);

    context.transition("running");
    expect(system.suspended).toBe(false);
    expect(system.stats.interruptions).toBe(1);
    system.dispose();
  });

  test("[ER-09-14] dispose is idempotent and clears every registry", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("shot", fakeBuffer(480, 1));
    system.registerStream("song", "audio/song.opus");
    system.playSfx("shot");
    expect(system.stats.activeVoices).toBe(1);

    system.dispose();
    expect(system.state).toBe("unavailable");
    expect(context.closeCalls).toHaveLength(1);
    expect(system.stats.activeVoices).toBe(0);
    expect(system.stats.decodedBytes).toBe(0);
    expect(system.streamCount).toBe(0);
    expect(system.stats.streaming).toBe(false);

    expect(() => system.dispose()).not.toThrow();
    expect(context.closeCalls).toHaveLength(1);
    expect(() => system.playSfx("shot")).not.toThrow();
  });
});

describe("handles and voice lifetime", () => {
  test("[09 §3.5] a destroyed handle is stale even when its index is reused", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("shot", fakeBuffer(480, 1));

    const first = system.createSource({ assetId: "shot" });
    system.destroySource(first);
    system.play(first);
    system.setSourcePosition(first, 1, 2, 3);
    expect(context.createdSources).toHaveLength(0);

    const second = system.createSource({ assetId: "shot" });
    expect(second.index).toBe(first.index);
    expect(second.generation).not.toBe(first.generation);
    system.play(second);
    expect(context.createdSources).toHaveLength(1);
    system.dispose();
  });

  test("[09 §3.5] malformed handles are ignored", async () => {
    const { system } = await unlockRig();
    const malformed = [
      { index: -1, generation: 0 },
      { index: Number.NaN, generation: 0 },
      { index: 1.5, generation: 0 },
      { index: 9999, generation: 1 },
    ];
    for (const handle of malformed) {
      expect(() => {
        system.play(handle);
        system.stop(handle);
        system.setSourcePosition(handle, 0, 0, 0);
        system.destroySource(handle);
      }).not.toThrow();
    }
    system.dispose();
  });

  test("[09 §5.4] a faded stop holds the voice until its free time", async () => {
    const { system, context } = await unlockRig();
    system.registerBuffer("shot", fakeBuffer(480, 1));
    const handle = system.createSource({ assetId: "shot", volume: 0.5 });
    system.play(handle);
    expect(system.stats.activeVoices).toBe(1);

    context.advance(1);
    system.stop(handle, 500);
    expect(system.stats.activeVoices).toBe(1);
    expect(sourceOf(context)?.stopCalls.at(-1)).toBeCloseTo(11.5, 6);
    const ramp = context.createdGains[FIRST_VOICE_GAIN]?.gain.ofType("ramp").at(-1);
    expect(ramp?.value).toBe(0);
    expect(ramp?.time).toBeCloseTo(11.5, 6);

    context.advance(0.5);
    system.update(0.016);
    expect(system.stats.activeVoices).toBe(0);
    system.dispose();
  });
});

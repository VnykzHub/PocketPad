import { describe, expect, test } from "vitest";
import {
  AudioBus,
  DEFAULT_SFX_VOICES,
  type AudioLatencyHint,
} from "../src/audio/AudioBus.js";

// ---------------------------------------------------------------------------
// Fakes: the runtime test project runs in Node, so Web Audio is hand-rolled at
// the documented AudioContext surface. Every fake is cast at the constructor
// boundary; the code under test only calls createGain, createBufferSource,
// resume, suspend, close, decodeAudioData and currentTime.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-unused-vars */

interface FakeParamEvent {
  readonly type: "setValueAtTime" | "linearRampToValueAtTime" | "cancelScheduledValues";
  readonly value: number;
  readonly time: number;
}

class FakeAudioParam {
  value = 1;
  readonly events: FakeParamEvent[] = [];

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: "setValueAtTime", value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: "linearRampToValueAtTime", value, time });
  }

  cancelScheduledValues(time: number): void {
    this.events.push({ type: "cancelScheduledValues", value: 0, time });
  }
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();
  readonly connectedTo: unknown[] = [];

  connect(target: unknown): void {
    this.connectedTo.push(target);
  }

  disconnect(): void {}
}

class FakeBufferSource {
  buffer: AudioBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeAudioParam();
  readonly connectedTo: unknown[] = [];
  startAt: number | null = null;
  stopAt: number | null = null;
  stopCalls = 0;

  private readonly context: FakeAudioContext;

  constructor(context: FakeAudioContext) {
    this.context = context;
  }

  connect(target: unknown): void {
    this.connectedTo.push(target);
  }

  start(when?: number): void {
    this.startAt = when ?? this.context.currentTime;
  }

  stop(when?: number): void {
    this.stopCalls += 1;
    this.stopAt = when ?? this.context.currentTime;
  }
}

class FakeAudioContext {
  currentTime = 0;
  state: "suspended" | "running" | "closed" = "suspended";
  baseLatency = 0.01;
  outputLatency = 0.02;
  readonly destination = { kind: "destination" };
  readonly gains: FakeGainNode[] = [];
  readonly sources: FakeBufferSource[] = [];
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;
  decodeCalls = 0;
  decoded: AudioBuffer | null = null;

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }

  createBufferSource(): FakeBufferSource {
    const source = new FakeBufferSource(this);
    this.sources.push(source);
    return source;
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = "running";
  }

  async suspend(): Promise<void> {
    this.suspendCalls += 1;
    this.state = "suspended";
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.state = "closed";
  }

  async decodeAudioData(_bytes: ArrayBuffer): Promise<AudioBuffer> {
    this.decodeCalls += 1;
    return this.decoded ?? ({} as AudioBuffer);
  }
}

interface BusHarness {
  readonly bus: AudioBus;
  readonly contexts: FakeAudioContext[];
  readonly hints: AudioLatencyHint[];
}

function makeBus(
  options: {
    latencyHint?: AudioLatencyHint;
    masterVolume?: number;
    sfxVoices?: number;
  } = {},
): BusHarness {
  const contexts: FakeAudioContext[] = [];
  const hints: AudioLatencyHint[] = [];
  const bus = new AudioBus({
    ...options,
    createContext: (latencyHint) => {
      hints.push(latencyHint);
      const context = new FakeAudioContext();
      contexts.push(context);
      return context as unknown as AudioContext;
    },
  });
  return { bus, contexts, hints };
}

function audioBuffer(): AudioBuffer {
  return { duration: 1 } as AudioBuffer;
}

// ---------------------------------------------------------------------------
// No autoplay before the gesture (FR-9.11)
// ---------------------------------------------------------------------------

describe("audio unlock", () => {
  test("[FR-9.11] no AudioContext exists and nothing plays before unlock", () => {
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

  test("[FR-9.11] unlock creates exactly one context and resumes it from the gesture", async () => {
    const { bus, contexts, hints } = makeBus();

    await bus.unlock();

    expect(contexts).toHaveLength(1);
    const context = contexts[0] as FakeAudioContext;
    expect(hints).toEqual(["interactive"]); // default latencyHint
    expect(bus.latencyHint).toBe("interactive");
    expect(context.resumeCalls).toBe(1);
    expect(context.state).toBe("running");
    expect(bus.state).toBe("unlocked");
    expect(bus.unlocked).toBe(true);
    expect(bus.now()).toBe(context.currentTime);

    // A second gesture reuses the same context and does not resume twice.
    await bus.unlock();
    expect(contexts).toHaveLength(1);
    expect(context.resumeCalls).toBe(1);
  });

  test("[FR-9.11] the latency hint is passed to the context factory", async () => {
    const { bus, hints } = makeBus({ latencyHint: "balanced" });
    await bus.unlock();
    expect(hints).toEqual(["balanced"]);
    expect(bus.latencyHint).toBe("balanced");
  });

  test("[FR-9.11] a blocked or missing Web Audio becomes a silent fallback", async () => {
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

  test("[FR-9.11] decoding audio requires the unlock gesture", async () => {
    const { bus, contexts } = makeBus();
    await expect(bus.decodeAudio(new ArrayBuffer(8))).rejects.toThrow(/locked/i);
    expect(contexts).toHaveLength(0);

    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;
    const decoded = audioBuffer();
    context.decoded = decoded;

    await expect(bus.decodeAudio(new ArrayBuffer(8))).resolves.toBe(decoded);
    expect(context.decodeCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Master gain, pause/resume and voice pooling
// ---------------------------------------------------------------------------

describe("audio mixer", () => {
  test("[FR-9.11] the master gain sits between every voice and the destination", async () => {
    const { bus, contexts } = makeBus();
    bus.setMasterVolume(0.25);
    await bus.unlock();

    const context = contexts[0] as FakeAudioContext;
    const master = context.gains[0] as FakeGainNode;
    expect(master.connectedTo[0]).toBe(context.destination);
    expect(master.gain.value).toBe(0.25);
    expect(bus.masterVolume).toBe(0.25);

    // Every other gain (music and SFX voices) routes through master.
    for (const gain of context.gains.slice(1)) {
      expect(gain.connectedTo[0]).toBe(master);
    }

    bus.setMasterVolume(2);
    expect(bus.masterVolume).toBe(1);
    expect(master.gain.value).toBe(1);
    bus.setMasterVolume(-3);
    expect(bus.masterVolume).toBe(0);
  });

  test("[FR-9.11] pause suspends output, blocks playback and resume restores it", async () => {
    const { bus, contexts } = makeBus();
    const hit = audioBuffer();
    bus.registerSfx("hit", hit);
    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;
    const resumeCallsAfterUnlock = context.resumeCalls;

    bus.pause();
    expect(bus.paused).toBe(true);
    expect(context.suspendCalls).toBe(1);
    expect(context.state).toBe("suspended");

    bus.playSfx("hit");
    expect(context.sources).toHaveLength(0);

    await bus.resume();
    expect(bus.paused).toBe(false);
    expect(context.resumeCalls).toBe(resumeCallsAfterUnlock + 1);
    expect(context.state).toBe("running");

    bus.playSfx("hit");
    expect(context.sources).toHaveLength(1);
  });

  test("SFX voices are pooled and reused round-robin", async () => {
    const { bus, contexts } = makeBus({ sfxVoices: 2 });
    const hit = audioBuffer();
    bus.registerSfx("hit", hit);
    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;
    // master + music + two voices.
    expect(context.gains).toHaveLength(4);
    const gainsAfterUnlock = context.gains.length;
    const voices = context.gains.slice(2) as FakeGainNode[];

    bus.playSfx("hit", { volume: 0.5, rate: 2 });
    const first = context.sources[0] as FakeBufferSource;
    expect(first.buffer).toBe(hit);
    expect(first.playbackRate.value).toBe(2);
    expect(voices[0]?.gain.value).toBe(0.5);
    expect(first.connectedTo[0]).toBe(voices[0]);

    bus.playSfx("hit");
    expect(context.sources).toHaveLength(2);
    expect((context.sources[1] as FakeBufferSource).connectedTo[0]).toBe(
      voices[1],
    );

    // Third trigger wraps to voice 0 and stops its still-playing sample.
    bus.playSfx("hit");
    expect(first.stopCalls).toBe(1);
    expect((context.sources[2] as FakeBufferSource).connectedTo[0]).toBe(
      voices[0],
    );
    expect(context.gains).toHaveLength(gainsAfterUnlock);
  });

  test("unknown SFX ids are ignored instead of crashing the host", async () => {
    const { bus, contexts } = makeBus();
    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;

    bus.playSfx("missing");
    expect(context.sources).toHaveLength(0);
  });

  test("the default voice count is documented and non-zero", () => {
    expect(DEFAULT_SFX_VOICES).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Music with gain fades on the audio clock (C8)
// ---------------------------------------------------------------------------

describe("music", () => {
  test("playMusic fades in on the audio clock and loops by default", async () => {
    const { bus, contexts } = makeBus();
    const theme = audioBuffer();
    bus.registerMusic("theme", theme);
    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;
    const musicGain = context.gains[1] as FakeGainNode;

    context.currentTime = 1;
    bus.playMusic("theme", { fadeMs: 200, volume: 0.8 });

    const source = context.sources[0] as FakeBufferSource;
    expect(source.buffer).toBe(theme);
    expect(source.loop).toBe(true);
    expect(source.startAt).toBe(1);
    expect(source.connectedTo[0]).toBe(musicGain);
    expect(musicGain.gain.events).toEqual([
      { type: "cancelScheduledValues", value: 0, time: 1 },
      { type: "setValueAtTime", value: 0, time: 1 },
      { type: "linearRampToValueAtTime", value: 0.8, time: 1.2 },
    ]);
  });

  test("stopMusic fades without a click and schedules the source stop", async () => {
    const { bus, contexts } = makeBus();
    bus.registerMusic("theme", audioBuffer());
    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;
    const musicGain = context.gains[1] as FakeGainNode;

    bus.playMusic("theme", { volume: 0.8 });
    const source = context.sources[0] as FakeBufferSource;

    context.currentTime = 2;
    bus.stopMusic(500);

    expect(musicGain.gain.events.at(-2)).toEqual({
      type: "setValueAtTime",
      value: 0.8,
      time: 2,
    });
    expect(musicGain.gain.events.at(-1)).toEqual({
      type: "linearRampToValueAtTime",
      value: 0,
      time: 2.5,
    });
    expect(source.stopCalls).toBe(1);
    expect(source.stopAt).toBe(2.5);

    // A second stop is a no-op once the active track was consumed.
    bus.stopMusic(500);
    expect(source.stopCalls).toBe(1);
  });

  test("stopMusic with no fade stops immediately", async () => {
    const { bus, contexts } = makeBus();
    bus.registerMusic("theme", audioBuffer());
    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;

    bus.playMusic("theme");
    const source = context.sources[0] as FakeBufferSource;
    context.currentTime = 3;
    bus.stopMusic();

    expect(source.stopAt).toBe(3);
  });

  test("playing a new track stops the previous one", async () => {
    const { bus, contexts } = makeBus();
    bus.registerMusic("a", audioBuffer());
    bus.registerMusic("b", audioBuffer());
    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;

    bus.playMusic("a");
    const first = context.sources[0] as FakeBufferSource;
    bus.playMusic("b");

    expect(first.stopCalls).toBe(1);
    expect(context.sources).toHaveLength(2);
  });

  test("music and SFX are silent before unlock and while paused", async () => {
    const { bus, contexts } = makeBus();
    bus.registerMusic("theme", audioBuffer());
    bus.playMusic("theme");
    expect(contexts).toHaveLength(0);

    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;
    bus.pause();
    bus.playMusic("theme");
    expect(context.sources).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Audio clock and latency (C8, E11)
// ---------------------------------------------------------------------------

describe("audio clock", () => {
  test("[C8] now() is the AudioContext clock so rhythm games can schedule beats", async () => {
    const { bus, contexts } = makeBus();
    expect(bus.now()).toBe(0);

    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;
    context.currentTime = 42.125;

    expect(bus.now()).toBe(42.125);
    // A beat scheduled against the audio clock, not performance.now().
    expect(bus.now() + 0.5).toBe(42.625);
  });

  test("[E11] output latency is readable from the audio clock after unlock", async () => {
    const { bus, contexts } = makeBus();
    expect(bus.baseLatency).toBe(0);
    expect(bus.outputLatency).toBe(0);

    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;
    context.currentTime = 12.5;
    context.baseLatency = 0.01;
    context.outputLatency = 0.032;

    expect(bus.now()).toBe(12.5);
    expect(bus.baseLatency).toBeCloseTo(0.01, 10);
    expect(bus.outputLatency).toBeCloseTo(0.032, 10);
  });

  test("[E11] outputLatency falls back to baseLatency when the browser omits it", async () => {
    const { bus, contexts } = makeBus();
    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;
    context.baseLatency = 0.015;
    delete (context as unknown as { outputLatency?: number }).outputLatency;

    expect(bus.outputLatency).toBeCloseTo(0.015, 10);
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe("dispose", () => {
  test("dispose stops music and closes the context", async () => {
    const { bus, contexts } = makeBus();
    bus.registerMusic("theme", audioBuffer());
    bus.registerSfx("hit", audioBuffer());
    await bus.unlock();
    const context = contexts[0] as FakeAudioContext;

    bus.playMusic("theme");
    const source = context.sources[0] as FakeBufferSource;
    bus.dispose();

    expect(source.stopCalls).toBe(1);
    expect(context.closeCalls).toBe(1);
    expect(bus.state).toBe("unavailable");
    expect(bus.unlocked).toBe(false);
    expect(() => bus.playMusic("theme")).not.toThrow();
  });
});

/* eslint-enable @typescript-eslint/no-unused-vars */

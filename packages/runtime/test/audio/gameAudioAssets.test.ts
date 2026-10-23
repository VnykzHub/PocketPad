import { describe, expect, test } from "vitest";
import { AudioBus } from "../../src/audio/AudioBus.js";
import type { GameAudioSink } from "../../src/audio/GameAudioAssets.js";
import { createGameAssetLibrary } from "../../src/assets/gameAssets.js";
import { createFixtureFetch, fixtureAssets } from "../assets/fixtureGame.js";

/**
 * Records decode order and registrations without Web Audio. The runtime test
 * project runs in Node, so every AudioBuffer here is a synthetic marker; the
 * real-browser decode path is not measured by this suite.
 */
class RecordingSink implements GameAudioSink {
  unlocked: boolean;
  readonly available?: boolean;
  readonly decoded: ArrayBuffer[] = [];
  readonly sfx = new Map<string, AudioBuffer>();
  readonly music = new Map<string, AudioBuffer>();
  private readonly failAt: number | null;
  private attempts = 0;

  constructor(
    options: {
      unlocked?: boolean;
      available?: boolean;
      failAt?: number;
    } = {},
  ) {
    this.unlocked = options.unlocked ?? false;
    this.failAt = options.failAt ?? null;
    if (options.available !== undefined) this.available = options.available;
  }

  async decodeAudio(data: Blob | ArrayBuffer): Promise<AudioBuffer> {
    const bytes =
      data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    const attempt = this.attempts++;
    if (this.failAt === attempt) throw new Error("fixture decode failure");
    this.decoded.push(bytes);
    return { duration: 0.25, decodeIndex: attempt } as unknown as AudioBuffer;
  }

  registerSfx(id: string, buffer: AudioBuffer): void {
    this.sfx.set(id, buffer);
  }

  registerMusic(id: string, buffer: AudioBuffer): void {
    this.music.set(id, buffer);
  }
}

class FakeParam {
  value = 1;
  setValueAtTime(value: number): void {
    this.value = value;
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
  cancelScheduledValues(): void {}
}

class FakeGain {
  readonly gain = new FakeParam();
  connect(): void {}
  disconnect(): void {}
}

interface FakeSource {
  buffer: AudioBuffer | null;
  loop: boolean;
  readonly playbackRate: FakeParam;
  connect(): void;
  start(): void;
  stop(): void;
}

class FakeAudioContext {
  currentTime = 0;
  state: "suspended" | "running" | "closed" = "suspended";
  baseLatency = 0.01;
  outputLatency = 0.02;
  readonly destination = {};
  readonly decoded: AudioBuffer[] = [];
  readonly sources: FakeSource[] = [];

  createGain(): FakeGain {
    return new FakeGain();
  }

  createBufferSource(): FakeSource {
    const source: FakeSource = {
      buffer: null,
      loop: false,
      playbackRate: new FakeParam(),
      connect() {},
      start() {},
      stop() {},
    };
    this.sources.push(source);
    return source;
  }

  async resume(): Promise<void> {
    this.state = "running";
  }

  async suspend(): Promise<void> {
    this.state = "suspended";
  }

  async close(): Promise<void> {
    this.state = "closed";
  }

  async decodeAudioData(): Promise<AudioBuffer> {
    const buffer = {
      duration: 0.25,
      decodeIndex: this.decoded.length,
    } as unknown as AudioBuffer;
    this.decoded.push(buffer);
    return buffer;
  }
}

function makeLibrary() {
  const fixture = createFixtureFetch();
  const library = createGameAssetLibrary(fixtureAssets(), {
    fetch: fixture.fetch,
  });
  return { library, urls: fixture.urls };
}

describe("audio registration and the gesture rule", () => {
  test("[FR-9.11] registration before the start gesture throws and never decodes", async () => {
    const { library } = makeLibrary();
    await library.loadEager();
    const sink = new RecordingSink();

    await expect(library.registerAudio(sink)).rejects.toMatchObject({
      code: "E_ASSET_LOCKED",
    });
    expect(sink.decoded).toHaveLength(0);
    expect(sink.sfx.size).toBe(0);
    expect(sink.music.size).toBe(0);
  });

  test("[FR-9.11] registration after unlock decodes boot audio in declaration order into both maps", async () => {
    const { library } = makeLibrary();
    await library.loadEager();
    const sink = new RecordingSink({ unlocked: true });

    const result = await library.registerAudio(sink);
    expect(result.skipped).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.registered).toEqual(["hit", "music"]);
    expect(sink.decoded).toHaveLength(2);
    expect([...sink.sfx.keys()]).toEqual(["hit", "music"]);
    expect([...sink.music.keys()]).toEqual(["hit", "music"]);
    expect(sink.sfx.get("hit")).toBe(sink.music.get("hit"));

    const again = await library.registerAudio(sink);
    expect(again.registered).toEqual([]);
    expect(sink.decoded).toHaveLength(2);
  });

  test("[FR-9.11] a host without Web Audio skips registration and stays startable", async () => {
    const { library } = makeLibrary();
    await library.loadEager();
    const sink = new RecordingSink({ available: false });

    const result = await library.registerAudio(sink);
    expect(result).toEqual({
      registered: [],
      failures: [],
      skipped: true,
    });
    expect(sink.decoded).toHaveLength(0);
  });

  test("[FR-9.11] a decode failure is reported per asset without throwing", async () => {
    const { library } = makeLibrary();
    await library.loadEager();
    const sink = new RecordingSink({ unlocked: true, failAt: 0 });

    const result = await library.registerAudio(sink);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      id: "hit",
      code: "E_ASSET_DECODE",
    });
    expect(result.registered).toEqual(["music"]);
    expect([...sink.sfx.keys()]).toEqual(["music"]);
  });

  test("[FR-9.6] a lazy audio asset decodes and registers when loaded after unlock", async () => {
    const { library, urls } = makeLibrary();
    await library.loadEager();
    const sink = new RecordingSink({ unlocked: true });
    await library.registerAudio(sink);

    const handle = await library.load("arena-music");
    expect(handle.state).toBe("ready");
    expect(handle.value).not.toBeInstanceOf(Uint8Array);
    expect(urls.filter((url) => url.endsWith("hit.ogg"))).toHaveLength(3);
    expect(sink.decoded).toHaveLength(3);
    expect([...sink.sfx.keys()]).toEqual(["hit", "music", "arena-music"]);
  });
});

describe("AudioBus integration", () => {
  test("[FR-9.11] playSfx and playMusic resolve by asset id after registration", async () => {
    const { library } = makeLibrary();
    await library.loadEager();

    const context = new FakeAudioContext();
    const bus = new AudioBus({
      createContext: () => context as unknown as AudioContext,
    });
    expect(bus.unlocked).toBe(false);
    await bus.unlock();
    expect(bus.unlocked).toBe(true);

    const result = await library.registerAudio(bus);
    expect(result.registered).toEqual(["hit", "music"]);
    expect(context.decoded).toHaveLength(2);

    bus.playSfx("hit");
    bus.playMusic("music");

    expect(context.sources).toHaveLength(2);
    expect(context.sources[0]?.buffer).toBe(context.decoded[0]);
    expect(context.sources[1]?.buffer).toBe(context.decoded[1]);
    expect(context.sources[1]?.loop).toBe(true);

    // A lazy id that was never loaded stays a silent no-op.
    bus.playSfx("arena-music");
    expect(context.sources).toHaveLength(2);
  });
});

/**
 * Decoded-buffer budget — ER-09-12.
 *
 * A decoded buffer costs `length * numberOfChannels * 4` bytes. Exceeding
 * `decodeBudgetBytes` fails only the new registration (`E_AUDIO_BUDGET`) and
 * keeps the previous buffer; streamed audio is not counted. A zero budget
 * disables decoding.
 */

import { describe, expect, test } from "vitest";
import { EngineAudioSystem } from "../src/AudioSystem.js";
import { DecodedBufferRegistry, bufferByteSize } from "../src/decode/decodeAudio.js";
import { createFakeFactory, fakeBuffer } from "./support/fakeAudio.js";

describe("decoded-buffer budget", () => {
  test("[ER-09-12] bytes are length × channels × 4", () => {
    expect(bufferByteSize(fakeBuffer(48000, 2))).toBe(384000);
    expect(bufferByteSize(fakeBuffer(100, 1))).toBe(400);
    expect(bufferByteSize({ duration: 0, sampleRate: 48000, length: -1, numberOfChannels: 1 })).toBe(0);
    expect(bufferByteSize({ duration: 0, sampleRate: 48000, length: Number.NaN, numberOfChannels: 1 })).toBe(0);
  });

  test("[ER-09-12] an over-budget registration keeps the previous buffer", () => {
    const registry = new DecodedBufferRegistry(1000);
    expect(registry.register("a", fakeBuffer(100, 1))).toBe("ok");
    expect(registry.register("b", fakeBuffer(100, 1))).toBe("ok");
    expect(registry.bytes).toBe(800);

    expect(registry.register("c", fakeBuffer(100, 1))).toBe("budget");
    expect(registry.bytes).toBe(800);
    expect(registry.has("c")).toBe(false);
    expect(registry.get("a")).toBeDefined();
    expect(registry.get("b")).toBeDefined();
  });

  test("[ER-09-12] replacing an id charges only the difference", () => {
    const registry = new DecodedBufferRegistry(1000);
    expect(registry.register("a", fakeBuffer(100, 1))).toBe("ok");
    expect(registry.register("a", fakeBuffer(150, 1))).toBe("ok");
    expect(registry.bytes).toBe(600);
    expect(registry.release("a")).toBe(true);
    expect(registry.bytes).toBe(0);
    expect(registry.release("a")).toBe(false);
  });

  test("[ER-09-12] a zero budget disables decoding, not the registry", () => {
    const registry = new DecodedBufferRegistry(0);
    expect(registry.register("a", fakeBuffer(1, 1))).toBe("disabled");
    expect(registry.bytes).toBe(0);
    expect(registry.register("empty", fakeBuffer(0, 1))).toBe("ok");
    expect(registry.bytes).toBe(0);
  });

  test("[ER-09-12] the system counts rejected registrations and streamed audio separately", async () => {
    const fake = createFakeFactory();
    const system = new EngineAudioSystem({
      createContext: fake.factory,
      decodeBudgetBytes: 1000,
    });
    await system.unlock();

    system.registerBuffer("a", fakeBuffer(100, 1));
    expect(system.stats.decodedBytes).toBe(400);
    system.registerBuffer("b", fakeBuffer(100, 1));
    expect(system.stats.decodedBytes).toBe(800);
    system.registerBuffer("c", fakeBuffer(100, 1));
    expect(system.stats.decodedBytes).toBe(800);
    expect(system.budgetFailures).toBe(1);

    system.registerStream("radio-track", "audio/radio/loop.opus");
    expect(system.streamCount).toBe(1);
    expect(system.stats.decodedBytes).toBe(800);

    system.releaseBuffer("a");
    expect(system.stats.decodedBytes).toBe(400);
    system.dispose();
  });

  test("[ER-09-12] the default budget is 32 MiB", () => {
    const system = new EngineAudioSystem({
      createContext: () => {
        throw new Error("not used");
      },
    });
    // 32 MiB / (4 bytes per sample) = 8,388,608 mono samples.
    system.registerBuffer("big", fakeBuffer(8388608, 1));
    expect(system.stats.decodedBytes).toBe(33554432);
    system.registerBuffer("over", fakeBuffer(1, 1));
    expect(system.stats.decodedBytes).toBe(33554432);
    expect(system.budgetFailures).toBe(1);
    system.dispose();
  });
});

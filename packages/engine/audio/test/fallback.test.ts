/**
 * Unavailable Web Audio — ER-09-09.
 *
 * A missing or throwing factory, or a graph that fails to build, leaves the
 * system `unavailable`. Every public call then stays a silent no-op and
 * `unlock()`/`suspend()`/`resume()` resolve instead of rejecting, so a game
 * loop cannot fail because audio hardware is absent.
 */

import { describe, expect, test } from "vitest";
import { AudioBus } from "../src/AudioBus.js";
import { EngineAudioSystem } from "../src/AudioSystem.js";
import { FakeContext, fakeBuffer } from "./support/fakeAudio.js";

describe("unavailable audio", () => {
  test("[ER-09-09] a throwing factory yields unavailable and silent no-ops", async () => {
    const system = new EngineAudioSystem({
      createContext: () => {
        throw new Error("AudioContext unavailable");
      },
    });

    await expect(system.unlock()).resolves.toBeUndefined();
    expect(system.state).toBe("unavailable");
    expect(system.available).toBe(false);
    expect(system.deviceFailures).toBe(1);

    system.registerBuffer("boom", fakeBuffer(480, 1));
    expect(() => {
      system.playSfx("boom");
      system.playMusic("boom");
      system.registerRadioStation({ id: "radio-one", tracks: ["boom"], loop: false });
      system.tuneRadio("radio-one");
      system.stopMusic(500);
      system.stopRadio(500);
      const handle = system.createSource({ assetId: "boom", positional: true });
      system.setSourcePosition(handle, 1, 2, 3);
      system.play(handle);
      system.stop(handle);
      system.destroySource(handle);
      system.update(0.016);
    }).not.toThrow();

    expect(system.stats.activeVoices).toBe(0);
    expect(system.stats.droppedPlays).toBe(0);
    await expect(system.suspend()).resolves.toBeUndefined();
    await expect(system.resume()).resolves.toBeUndefined();
    await expect(system.unlock()).resolves.toBeUndefined();
    system.dispose();
  });

  test("[ER-09-09] no Web Audio in the environment becomes unavailable after unlock", async () => {
    const system = new EngineAudioSystem();
    expect(system.state).toBe("locked");
    await expect(system.unlock()).resolves.toBeUndefined();
    expect(system.state).toBe("unavailable");
    expect(() => system.playSfx("missing")).not.toThrow();
    system.dispose();
    expect(system.state).toBe("unavailable");
  });

  test("[ER-09-09] a graph that fails to build closes the context and stays silent", async () => {
    const context = new FakeContext();
    context.createGain = () => {
      throw new Error("createGain failed");
    };
    const system = new EngineAudioSystem({ createContext: () => context });

    await expect(system.unlock()).resolves.toBeUndefined();
    expect(system.state).toBe("unavailable");
    expect(system.deviceFailures).toBe(1);
    expect(context.closeCalls).toHaveLength(1);
    expect(() => system.playSfx("anything")).not.toThrow();
    system.dispose();
  });

  test("[ER-09-09] AudioBus without a factory is unavailable and never rejects unlock", async () => {
    const bus = new AudioBus();
    expect(bus.state).toBe("unavailable");
    expect(bus.available).toBe(false);
    await expect(bus.unlock()).resolves.toBeUndefined();
    expect(() => bus.playSfx("missing")).not.toThrow();
    expect(() => bus.playMusic("missing")).not.toThrow();
    expect(bus.now()).toBe(0);
    bus.dispose();
  });

  test("[ER-09-09] AudioBus decode still rejects while locked (frozen M0 contract)", async () => {
    const bus = new AudioBus();
    // The frozen `AudioBus` contract says `decodeAudio` rejects while locked;
    // this is the one deliberate exception to ER-09-09's no-rejection rule.
    await expect(bus.decodeAudio(new ArrayBuffer(8))).rejects.toThrow(
      "AudioBus is locked",
    );
    bus.dispose();
  });
});

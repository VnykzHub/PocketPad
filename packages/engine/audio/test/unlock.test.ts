/**
 * Unlock state machine — ER-09-01 and FR-9.11.
 *
 * The constructor records the factory; `unlock()` is the only construction
 * site, is idempotent, and stays single-context across concurrent and
 * repeated gestures. A refused gesture keeps the one context for the next
 * gesture instead of constructing another.
 */

import { describe, expect, test } from "vitest";
import { EngineAudioSystem } from "../src/AudioSystem.js";
import { createFakeFactory } from "./support/fakeAudio.js";

describe("audio unlock state machine", () => {
  test("[ER-09-01] no AudioContext exists before unlock", () => {
    const fake = createFakeFactory();
    const system = new EngineAudioSystem({ createContext: fake.factory });

    system.playSfx("boom");
    system.playMusic("theme");
    system.registerRadioStation({ id: "radio-one", tracks: ["theme"], loop: true });
    system.tuneRadio("radio-one");
    system.update(0.016);

    expect(fake.calls).toBe(0);
    expect(system.state).toBe("locked");
    expect(system.unlocked).toBe(false);
    expect(system.clock.now).toBe(0);
    expect(system.stats.activeVoices).toBe(0);
    system.dispose();
  });

  test("[ER-09-01] ten concurrent unlocks construct exactly one context", async () => {
    const fake = createFakeFactory();
    const system = new EngineAudioSystem({ createContext: fake.factory });

    const unlocks = [];
    for (let index = 0; index < 10; index += 1) unlocks.push(system.unlock());
    await Promise.all(unlocks);
    await system.unlock();
    await system.unlock();

    expect(fake.calls).toBe(1);
    expect(system.state).toBe("unlocked");
    expect(system.suspended).toBe(false);
    expect(system.available).toBe(true);
    system.dispose();
  });

  test("[ER-09-01] a refused resume keeps the single context for the next gesture", async () => {
    const fake = createFakeFactory({ resume: "reject" });
    const system = new EngineAudioSystem({ createContext: fake.factory });

    await expect(system.unlock()).resolves.toBeUndefined();
    expect(fake.calls).toBe(1);
    expect(system.state).toBe("locked");

    // The next gesture is allowed to run: the context must be reused, not
    // constructed a second time.
    const context = fake.last();
    expect(context).toBeDefined();
    if (context !== undefined) context.state = "running";
    await system.unlock();

    expect(fake.calls).toBe(1);
    expect(system.state).toBe("unlocked");
    system.dispose();
  });

  test("[ER-09-01] unlock resolves after dispose without constructing a context", async () => {
    const fake = createFakeFactory();
    const system = new EngineAudioSystem({ createContext: fake.factory });
    system.dispose();
    await expect(system.unlock()).resolves.toBeUndefined();
    expect(fake.calls).toBe(0);
    expect(system.state).toBe("unavailable");
  });
});

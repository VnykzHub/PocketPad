/**
 * D3-RT-04: input reader, event queue, seeded RNG and the game context.
 */
import { describe, expect, test } from "vitest";
import { InputMapper } from "../src/input/InputMapper.js";
import {
  CapabilityUnavailableError,
  createDebugCounters,
  createGameContext,
  createRng,
} from "../src/game/GameContext.js";
import { GameEventQueue, SnapshotInputReader } from "../src/game/InputReader.js";
import { packet, RecordingRenderer, silentAudio } from "./helpers/gameFakes.js";

const MANIFEST = {
  name: "Probe",
  entry: "index.js",
  layouts: ["layouts/a.json"],
  assetBudget: { initialBytes: 1, totalBytes: 1 },
  minPlayers: 1,
  maxPlayers: 8,
  needsGyro: false,
};

function buildContext() {
  const queue = new GameEventQueue(4);
  const reader = new SnapshotInputReader(queue);
  const ctx = createGameContext({
    manifest: MANIFEST,
    input: reader,
    renderer: new RecordingRenderer(),
    audio: silentAudio(),
    serverNow: () => 42,
    seed: 7,
  });
  return { queue, reader, ctx };
}

describe("D3-RT-04 input reader and context", () => {
  test("[FR-7.11] player snapshot reflects the latest mapped state", () => {
    const mapper = new InputMapper();
    const { reader } = buildContext();
    mapper.apply(3, packet({ lx: 32767, buttons: 1 }), 0);
    reader.update(mapper.pollAll(1));

    expect(reader.player(3)?.lx).toBe(1);
    expect(reader.player(3)?.buttons).toBe(1);
    expect(reader.player(0)).toBeUndefined();
    expect(reader.player(9)).toBeUndefined();
    expect(reader.poll()).toBe(reader.snapshot);
  });

  test("[FR-7.12] events and edges are drained exactly once per tick", () => {
    const mapper = new InputMapper();
    const { queue, reader } = buildContext();

    mapper.apply(1, packet({ edges: 1, buttons: 1 }), 0);
    queue.push(1, "vote", { choice: 2 });
    reader.update(mapper.pollAll(1));
    const first = queue.drain();
    expect(reader.player(1)?.edges).toBe(1);
    expect(reader.events()).toBe(first);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ slot: 1, name: "vote", data: { choice: 2 } });

    reader.update(mapper.pollAll(2));
    expect(reader.player(1)?.edges).toBe(0);
    expect(queue.drain()).toHaveLength(0);
    expect(reader.events()).toHaveLength(0);
  });

  test("[FR-7.12] a full event queue drops the oldest and counts it", () => {
    const queue = new GameEventQueue(2);
    queue.push(1, "a", 1);
    queue.push(1, "b", 2);
    queue.push(1, "c", 3);
    expect(queue.dropped).toBe(1);
    const names = queue.drain().map((event) => event.name);
    expect(names).toEqual(["b", "c"]);
  });

  test("[PR-9.3] the reader reuses the mapper snapshot and drained view", () => {
    const mapper = new InputMapper();
    const { queue, reader } = buildContext();
    reader.update(mapper.pollAll(1));
    const snapshot = reader.snapshot;
    const view = queue.drain();
    reader.update(mapper.pollAll(2));
    expect(reader.snapshot).toBe(snapshot);
    expect(queue.drain()).toBe(view);
  });

  test("[G8] the seeded RNG is deterministic per seed", () => {
    const a = createRng(123);
    const b = createRng(123);
    const c = createRng(124);
    const seqA = [a.next(), a.next(), a.next()];
    expect([b.next(), b.next(), b.next()]).toEqual(seqA);
    expect(c.next()).not.toBe(seqA[0]);
    for (let i = 0; i < 200; i += 1) {
      const value = a.int(1, 6);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  test("[FR-7.17] GameContext exposes input and events, never sockets", () => {
    const { ctx } = buildContext();
    const keys = Object.keys(ctx);
    for (const forbidden of ["socket", "ws", "fetch", "client", "hostClient", "send"]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys.sort()).toEqual(
      [
        "audio",
        "debug",
        "events",
        "haptics",
        "input",
        "layouts",
        "manifest",
        "panels",
        "renderer",
        "rng",
        "serverNow",
      ].sort(),
    );
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.serverNow()).toBe(42);
    expect(ctx.rng.seed).toBe(7);
  });

  test("[G8] capability stubs fail loudly until D5/D6", () => {
    const { ctx } = buildContext();
    expect(() => ctx.panels.show(1, null)).toThrow(CapabilityUnavailableError);
    expect(() => ctx.panels.set(1, null)).toThrow(CapabilityUnavailableError);
    expect(() => ctx.panels.clear(1)).toThrow(CapabilityUnavailableError);
    expect(() => ctx.layouts.set(1, "x")).toThrow(/D5/);
    expect(() => ctx.layouts.clear(1)).toThrow(/D5/);
    expect(() => ctx.haptics.pulse(1, [10])).toThrow(/D6/);
    expect(() => ctx.events.on("vote", () => undefined)).toThrow(/D5/);
  });

  test("[FR-12.2] debug counters record only when ?debug=1", () => {
    const on = createDebugCounters(true);
    const off = createDebugCounters(false);
    on.setCounter("entities", 3);
    off.setCounter("entities", 3);
    expect(on.counters.get("entities")).toBe(3);
    expect(off.counters.size).toBe(0);
  });
});

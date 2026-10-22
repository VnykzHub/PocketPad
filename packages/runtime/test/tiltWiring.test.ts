/**
 * D6-RT-01 wiring: `GameHost` integrates one tilt angle per slot and hands the
 * pooled angles to the game before `simulate`, alongside the raw gyro and the
 * motion flags (FR-7.5, FR-7.6, FR-7.17; D6 contract 5).
 *
 * The loop is driven by `FakeFrames`, so the test exercises the real
 * `FixedLoop` + `InputMapper` + `GameHost` path without timers or sockets.
 */
import { describe, expect, test } from "vitest";
import type { Game, GameContext, GameInputSnapshot } from "@lanpad/sdk";
import { GameHost } from "../src/game/GameHost.js";
import { InputMapper } from "../src/input/InputMapper.js";
import { TILT_MAX_ANGLE_DEG } from "../src/input/TiltIntegrator.js";
import {
  FakeFrames,
  RecordingRenderer,
  packet,
  silentAudio,
} from "./helpers/gameFakes.js";

const MANIFEST = {
  name: "TiltProbe",
  entry: "index.js",
  layouts: ["layouts/a.json"],
  assetBudget: { initialBytes: 1, totalBytes: 1 },
  minPlayers: 1,
  maxPlayers: 8,
  needsGyro: true,
};

/** One `simulate` observation, copied out of the pooled snapshot. */
interface TiltSample {
  readonly hasTilt: boolean;
  readonly gyroActive: boolean;
  readonly gyroRecentered: boolean;
  readonly angleX: number;
  readonly angleY: number;
  readonly available: boolean;
  readonly playerKeys: readonly string[];
}

interface Probe {
  readonly game: Game;
  readonly samples: TiltSample[];
  readonly context: { keys: string[]; frozen: boolean };
}

function createProbe(): Probe {
  const samples: TiltSample[] = [];
  const context = { keys: [] as string[], frozen: false };
  const game: Game = {
    manifest: MANIFEST,
    init(ctx: GameContext): void {
      context.keys = Object.keys(ctx);
      context.frozen = Object.isFrozen(ctx);
    },
    simulate(_dt: number, input: GameInputSnapshot): void {
      const player = input.players[0];
      if (player === undefined) return;
      const tilt = player.tilt;
      samples.push({
        hasTilt: tilt !== undefined,
        gyroActive: player.gyroActive,
        gyroRecentered: player.gyroRecentered,
        angleX: tilt?.angleX ?? Number.NaN,
        angleY: tilt?.angleY ?? Number.NaN,
        available: tilt?.available ?? false,
        playerKeys: Object.keys(player),
      });
    },
    render(): void {},
    dispose(): void {},
  };
  return { game, samples, context };
}

async function createHost(probe: Probe): Promise<{
  frames: FakeFrames;
  mapper: InputMapper;
  host: GameHost;
}> {
  const frames = new FakeFrames();
  const mapper = new InputMapper();
  const host = new GameHost({
    game: probe.game,
    renderer: new RecordingRenderer(),
    audio: silentAudio(),
    mapper,
    now: frames.now,
    raf: frames.raf,
    cancel: frames.cancel,
  });
  await host.start();
  return { frames, mapper, host };
}

/**
 * Steps frames until the game has run at least `count` simulate ticks. A frame
 * may run zero or two ticks because of the accumulator, so the count is what
 * matters, not the frame count.
 */
function runTicks(frames: FakeFrames, probe: Probe, count: number): void {
  let stepped = 0;
  const maxSteps = count * 3 + 30;
  while (probe.samples.length < count && stepped < maxSteps) {
    frames.step(1000 / 60);
    stepped += 1;
  }
  expect(probe.samples.length).toBeGreaterThanOrEqual(count);
}

describe("D6-RT-01 host tilt wiring", () => {
  test("[FR-7.5] constant 100 dps for 0.1 s yields about 10 degrees", async () => {
    const probe = createProbe();
    const { frames, mapper } = await createHost(probe);

    // 1000 wire units = 100 dps after InputMapper's /10 conversion.
    mapper.apply(1, packet({ tick: 1, gx: 1000, flags: 0x01 }), 0);
    runTicks(frames, probe, 6);

    const sixth = probe.samples[5];
    expect(sixth).toBeDefined();
    expect(sixth?.hasTilt).toBe(true);
    expect(sixth?.available).toBe(true);
    expect(sixth?.angleX).toBeCloseTo(10, 5);
    expect(sixth?.angleY).toBeCloseTo(0, 6);
  });

  test("[FR-7.6] recenter resets the integrated angle on the next tick", async () => {
    const probe = createProbe();
    const { frames, mapper } = await createHost(probe);

    mapper.apply(1, packet({ tick: 1, gx: 1000, flags: 0x01 }), 0);
    runTicks(frames, probe, 10);
    const before = probe.samples[probe.samples.length - 1];
    expect(before?.angleX).toBeGreaterThan(10);

    // Flag bit 1 = recentered; gx 0 isolates the reset from the new rate.
    mapper.apply(1, packet({ tick: 2, gx: 0, flags: 0x03 }), 0);
    const next = probe.samples.length;
    runTicks(frames, probe, next + 1);

    const after = probe.samples[next];
    expect(after?.gyroRecentered).toBe(true);
    expect(after?.angleX).toBeCloseTo(0, 6);
    expect(after?.angleY).toBeCloseTo(0, 6);
  });

  test("[FR-7.6] inactive motion decays the angle and reports unavailable", async () => {
    const probe = createProbe();
    const { frames, mapper } = await createHost(probe);

    mapper.apply(1, packet({ tick: 1, gx: 1200, flags: 0x01 }), 0);
    runTicks(frames, probe, 6);
    const held = probe.samples[5]?.angleX ?? 0;
    expect(held).toBeCloseTo(12, 5);

    // Motion inactive: flag bit 0 clears.
    mapper.apply(1, packet({ tick: 2, gx: 1200, flags: 0x00 }), 0);
    const next = probe.samples.length;
    runTicks(frames, probe, next + 1);
    const after = probe.samples[next];
    expect(after?.available).toBe(false);
    expect(after?.angleX).toBeCloseTo(held - 20 / 60, 5);

    runTicks(frames, probe, probe.samples.length + 60);
    const last = probe.samples[probe.samples.length - 1];
    expect(last?.angleX).toBe(0);
    expect(last?.angleY).toBe(0);
    expect(last?.available).toBe(false);
  });

  test("[FR-7.5] integrated tilt is clamped to ±30 degrees", async () => {
    const probe = createProbe();
    const { frames, mapper } = await createHost(probe);

    // 3000 wire units = 300 dps; 30 ticks would integrate 150° unclamped.
    mapper.apply(1, packet({ tick: 1, gx: 3000, gy: -3000, flags: 0x01 }), 0);
    runTicks(frames, probe, 30);

    const sample = probe.samples[29];
    expect(sample?.angleX).toBe(TILT_MAX_ANGLE_DEG);
    expect(sample?.angleY).toBe(-TILT_MAX_ANGLE_DEG);
  });

  test("[FR-7.6][FR-7.17] a game reads tilt and gyro flags from simulate", async () => {
    const probe = createProbe();
    const { frames, mapper } = await createHost(probe);

    mapper.apply(1, packet({ tick: 1, gx: 600, gy: -300, flags: 0x01 }), 0);
    runTicks(frames, probe, 3);

    const sample = probe.samples[2];
    expect(sample?.gyroActive).toBe(true);
    expect(sample?.gyroRecentered).toBe(false);
    expect(sample?.hasTilt).toBe(true);
    expect(sample?.available).toBe(true);
    expect(sample?.angleX).toBeCloseTo(3, 5);
    expect(sample?.angleY).toBeCloseTo(-1.5, 5);
  });

  test("[FR-7.17] the context exposes input, never a socket", async () => {
    const probe = createProbe();
    const { frames, mapper } = await createHost(probe);

    expect(probe.context.frozen).toBe(true);
    for (const forbidden of ["socket", "ws", "fetch", "client", "hostClient", "send"]) {
      expect(probe.context.keys).not.toContain(forbidden);
    }

    mapper.apply(1, packet({ tick: 1, gx: 600, flags: 0x01 }), 0);
    runTicks(frames, probe, 1);
    const sample = probe.samples[0];
    expect(sample?.playerKeys).not.toContain("socket");
    expect(sample?.playerKeys).not.toContain("packet");
    expect(sample?.playerKeys).toContain("tilt");
  });
});

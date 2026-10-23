/**
 * Engine Cube adapter tests (GAME-EC-01).
 *
 * The game is the first consumer of the engine 3D path: its manifest asks for
 * `renderer: "babylon"`, and its render loop may only use the SDK 3D surface.
 * These tests lock the shipped manifest and layout, the lifecycle, the draw
 * call count and the allocation-free steady state.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type {
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameManifest,
  GameRenderer3D,
  LayoutDocument,
  Vec3,
} from "@lanpad/sdk";
import { validateLayout, validateManifest } from "@lanpad/sdk";
import { createEngineCubeGame, EC_LAYOUT_ID } from "../src/game.js";

function readJson(relativePath: string): unknown {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as unknown;
}

const manifestResult = validateManifest(readJson("../game.manifest.json"));
if (!manifestResult.ok) {
  throw new Error(
    `Shipped manifest is invalid: ${manifestResult.errors.join("; ")}`,
  );
}
const manifest: GameManifest = manifestResult.manifest;

interface DrawCall {
  readonly position: Vec3;
  readonly size: number;
  readonly color: string;
  readonly rotationY: number;
}

interface CameraCall {
  readonly position: Vec3;
  readonly target: Vec3;
}

interface RecordingRenderer {
  readonly renderer: GameRenderer3D;
  readonly calls: DrawCall[];
  readonly cameras: CameraCall[];
  readonly frames: { began: number; ended: number };
}

function createRenderer(): RecordingRenderer {
  const calls: DrawCall[] = [];
  const cameras: CameraCall[] = [];
  const frames = { began: 0, ended: 0 };
  const renderer: GameRenderer3D = {
    backend: "webgpu",
    drawCalls: 0,
    textureMemoryMB: 0,
    setCamera(position: Vec3, target: Vec3): void {
      cameras.push({ position, target });
    },
    beginFrame(): void {
      frames.began += 1;
    },
    endFrame(): void {
      frames.ended += 1;
    },
    drawCube(
      position: Vec3,
      size: number,
      color: string,
      rotationY: number,
    ): void {
      calls.push({ position, size, color, rotationY });
    },
  };
  return { renderer, calls, cameras, frames };
}

interface FakeContext {
  readonly ctx: GameContext;
  readonly layouts: Array<{ slot: number; layoutId: string }>;
  readonly clearedLayouts: number[];
  readonly counters: Map<string, number>;
}

function createContext(renderer: GameRenderer3D): FakeContext {
  const layouts: Array<{ slot: number; layoutId: string }> = [];
  const clearedLayouts: number[] = [];
  const counters = new Map<string, number>();
  const snapshot: GameInputSnapshot = { tick: 0, players: [] };
  const ctx: GameContext = {
    manifest,
    input: {
      snapshot,
      poll: () => snapshot,
      player: () => undefined,
      events: () => [],
    },
    renderer,
    audio: {
      playSfx: () => undefined,
      playMusic: () => undefined,
      stopMusic: () => undefined,
      now: () => 0,
      unlocked: true,
      latencyHint: "interactive",
    },
    rng: {
      seed: 7,
      next: () => 0.5,
      int: (min) => min,
    },
    debug: {
      enabled: false,
      setCounter: (name, value) => {
        counters.set(name, value);
      },
    },
    panels: {
      set: () => undefined,
      show: () => undefined,
      clear: () => undefined,
    },
    layouts: {
      set: (slot: number | "all", layout: LayoutDocument | string): void => {
        if (typeof slot === "number" && typeof layout === "string") {
          layouts.push({ slot, layoutId: layout });
        }
      },
      clear: (target: number | "all"): void => {
        if (typeof target === "number") {
          clearedLayouts.push(target);
        }
      },
    },
    haptics: { pulse: () => undefined },
    events: {
      on: () => () => undefined,
      onAny: () => () => undefined,
    },
    serverNow: () => 1000,
  };
  return { ctx, layouts, clearedLayouts, counters };
}

function player(
  slot: number,
  overrides: Partial<GameControllerState> = {},
): GameControllerState {
  return {
    slot,
    connected: true,
    buttons: 0,
    edges: 0,
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    gyro: { x: 0, y: 0, z: 0 },
    gyroActive: false,
    gyroRecentered: false,
    triggers: { lt: 0, rt: 0 },
    tick: 0,
    ...overrides,
  };
}

interface Harness {
  readonly renderer: RecordingRenderer;
  readonly fake: FakeContext;
  readonly game: ReturnType<typeof createEngineCubeGame>;
  step(players: readonly GameControllerState[], dtSeconds?: number): void;
  render(alpha?: number): void;
}

function createHarness(): Harness {
  const renderer = createRenderer();
  const fake = createContext(renderer.renderer);
  const game = createEngineCubeGame(manifest);
  game.init(fake.ctx);
  return {
    renderer,
    fake,
    game,
    step(players, dtSeconds = 1 / 60): void {
      game.simulate(dtSeconds, { tick: 0, players });
    },
    render(alpha = 0.5): void {
      game.render(alpha);
    },
  };
}

describe("Engine Cube manifest and layout", () => {
  test("[FR-10.3] the shipped manifest validates and declares the Babylon renderer", () => {
    expect(manifestResult.ok).toBe(true);
    expect(manifest.name).toBe("Engine Cube");
    expect(manifest.renderer).toBe("babylon");
    expect(manifest.minPlayers).toBe(1);
    expect(manifest.maxPlayers).toBe(2);
    expect(manifest.needsGyro).toBe(false);
    expect(manifest.layouts).toEqual([`layouts/${EC_LAYOUT_ID}.json`]);

    const game = createEngineCubeGame(manifest);
    expect(game.manifest).toBe(manifest);
    expect(typeof game.init).toBe("function");
    expect(typeof game.simulate).toBe("function");
    expect(typeof game.render).toBe("function");
    expect(typeof game.dispose).toBe("function");
    game.dispose();
  });

  test("[FR-8.1] ec-default-v1 validates and binds orbit plus boost", () => {
    const result = validateLayout(readJson(`../layouts/${EC_LAYOUT_ID}.json`));
    expect(result.ok, result.ok ? "" : result.errors.join("\n")).toBe(true);
    if (!result.ok) return;
    expect(result.layout.id).toBe(EC_LAYOUT_ID);
    expect(result.layout.orientation).toBe("landscape");
    expect(result.layout.controls).toHaveLength(2);
    const stick = result.layout.controls[0];
    const button = result.layout.controls[1];
    expect(stick).toMatchObject({ type: "stick", id: "orbit", axis: "left" });
    expect(button).toMatchObject({ type: "button", id: "boost", bit: 0 });
  });
});

describe("Engine Cube lifecycle and drawing", () => {
  test("[ER-04-17] a frame draws three cubes through the 3D renderer", () => {
    const harness = createHarness();
    harness.step([player(1)]);
    harness.render();

    expect(harness.fake.layouts).toEqual([
      { slot: 1, layoutId: EC_LAYOUT_ID },
    ]);
    expect(harness.renderer.cameras).toHaveLength(1);
    expect(harness.renderer.frames).toEqual({ began: 1, ended: 1 });
    expect(harness.renderer.calls).toHaveLength(3);
    expect(harness.renderer.calls.map((call) => call.color)).toEqual([
      "#6ee7ff",
      "#ffd166",
      "#ff6b9d",
    ]);
    expect(harness.renderer.calls.map((call) => call.size)).toEqual([
      1.4, 0.7, 0.55,
    ]);
    expect(harness.fake.counters.get("players")).toBe(1);
  });

  test("[ER-04-17] the layout is requested once per connection edge", () => {
    const harness = createHarness();
    harness.step([player(1)]);
    harness.step([player(1)]);
    expect(harness.fake.layouts).toHaveLength(1);

    harness.step([player(1, { connected: false })]);
    expect(harness.fake.clearedLayouts).toEqual([1]);
    harness.step([player(1)]);
    expect(harness.fake.layouts).toHaveLength(2);
  });

  test("[ER-04-08] steady-state rendering reuses camera and position objects", () => {
    const harness = createHarness();
    harness.step([player(1)]);
    harness.render();
    harness.render();

    expect(harness.renderer.cameras).toHaveLength(2);
    expect(harness.renderer.cameras[1]?.position).toBe(
      harness.renderer.cameras[0]?.position,
    );
    expect(harness.renderer.cameras[1]?.target).toBe(
      harness.renderer.cameras[0]?.target,
    );
    for (let index = 0; index < 3; index += 1) {
      expect(harness.renderer.calls[3 + index]?.position).toBe(
        harness.renderer.calls[index]?.position,
      );
    }
  });

  test("[ER-04-17] the left stick orbits the camera and boost accelerates the spin", () => {
    const idle = createHarness();
    idle.step([player(1)]);
    idle.render();
    const idleX = idle.renderer.cameras[0]?.position.x ?? 0;

    const moving = createHarness();
    for (let tick = 0; tick < 120; tick += 1) {
      moving.step([player(1, { lx: 1 })]);
    }
    moving.render();
    const orbitX = moving.renderer.cameras[0]?.position.x ?? 0;
    expect(orbitX).toBeGreaterThan(idleX);

    for (let tick = 0; tick < 60; tick += 1) {
      idle.step([player(1)]);
      moving.step([player(1, { lx: 1, buttons: 1 })]);
    }
    idle.render();
    moving.render();
    const idleSpin = Math.abs(idle.renderer.calls.at(-3)?.rotationY ?? 0);
    const boostSpin = Math.abs(moving.renderer.calls.at(-3)?.rotationY ?? 0);
    expect(boostSpin).not.toBe(idleSpin);
  });

  test("[ER-04-17] dispose is idempotent and silences simulate and render", () => {
    const harness = createHarness();
    harness.step([player(1)]);
    harness.render();
    const callsAfterFirstFrame = harness.renderer.calls.length;

    harness.game.dispose();
    harness.game.dispose();
    expect(() => harness.step([player(1)])).not.toThrow();
    expect(() => harness.render()).not.toThrow();
    expect(harness.renderer.calls).toHaveLength(callsAfterFirstFrame);
    expect(harness.renderer.frames.began).toBe(1);
  });

  test("[FR-7.17] the adapter has no socket, protocol, broker or fetch import", () => {
    const source = readFileSync(
      new URL("../src/game.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /@lanpad\/(?:protocol|broker|dev-server|controller|relay|engine-core|engine-renderer)/,
    );
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bWebSocket\b/);
  });
});

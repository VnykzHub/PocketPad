/**
 * Sumo Bumpers adapter tests (GAME-SB-*).
 *
 * These drive the exact `GameModule` the host loads, through the pure SDK
 * fakes, with a fake flat-2D surface that records every draw call. The fixed
 * tick is always 1/60 s; overrides shorten the countdown, results dwell, shrink
 * window and disconnect grace so each scenario is deterministic and fast.
 *
 * Every title carries a `GAME-SB-*` id from `docs/todos/games/sumo-bumpers.md`.
 * There is no game-plan id for `dispose()` idempotence; that test is tagged
 * with GAME-SB-TEST-05 (no leaks) and the gap is reported, per the brief.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type {
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameManifest,
  GameRenderer3D,
  JsonValue,
  LayoutDocument,
} from "@lanpad/sdk";
import { validateLayout, validateManifest } from "@lanpad/sdk";
import { arenaRadiusAt, isFullyOutside } from "../src/arena.js";
import {
  resolveSumoConfig,
  SUMO_CONFIG,
  type SumoConfigOptions,
} from "../src/config.js";
import {
  createSumoGame,
  SUMO_DASH_LAYOUT_ID,
  SUMO_STICK_LAYOUT_ID,
  type SumoBumper,
  type SumoGame,
  type SumoGameOptions,
} from "../src/game.js";
import { SumoHud } from "../src/hud.js";
import {
  createContact,
  resolveCircleCircle,
  type CircleBody,
} from "../src/physics.js";
import {
  drawSumo,
  resolveRenderer2D,
  type Renderer2DLike,
  type SumoBumperView,
  type SumoRenderState,
} from "../src/render.js";

const STEP_SECONDS = 1 / 60;

// ---------------------------------------------------------------------------
// Shipped manifest and layouts
// ---------------------------------------------------------------------------

const manifestPath = new URL("../game.manifest.json", import.meta.url);
const manifestResult = validateManifest(
  JSON.parse(readFileSync(manifestPath, "utf8")),
);
if (!manifestResult.ok) {
  throw new Error(
    `Shipped manifest is invalid: ${manifestResult.errors.join("; ")}`,
  );
}
const manifest: GameManifest = manifestResult.manifest;

const layouts: LayoutDocument[] = manifest.layouts.map((relative) => {
  const path = new URL(`../${relative}`, import.meta.url);
  const result = validateLayout(JSON.parse(readFileSync(path, "utf8")));
  if (!result.ok) {
    throw new Error(
      `Layout ${relative} is invalid: ${result.errors.join("; ")}`,
    );
  }
  return result.layout;
});

function requireLayout(id: string): LayoutDocument {
  const layout = layouts.find((candidate) => candidate.id === id);
  if (layout === undefined) throw new Error(`layout ${id} is missing`);
  return layout;
}

// ---------------------------------------------------------------------------
// Fake context with recording panels/layouts/haptics and a flat 2D surface
// ---------------------------------------------------------------------------

interface RecordedCircle {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly color: string;
}

interface RecordedText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
}

interface RecordingSurface extends Renderer2DLike {
  readonly circles: RecordedCircle[];
  readonly texts: RecordedText[];
  readonly counts: { begin: number; end: number };
}

function createSurface(size?: {
  readonly width: number;
  readonly height: number;
}): RecordingSurface {
  const circles: RecordedCircle[] = [];
  const texts: RecordedText[] = [];
  const counts = { begin: 0, end: 0 };
  return {
    circles,
    texts,
    counts,
    beginFrame() {
      counts.begin += 1;
    },
    endFrame() {
      counts.end += 1;
    },
    clear() {
      // The background clears every frame; not needed by assertions.
    },
    rect() {
      // Sumo Bumpers currently draws no rectangles.
    },
    circle(x, y, r, color) {
      circles.push({ x, y, r, color });
    },
    text(text, x, y, textSize, color) {
      texts.push({ text, x, y, size: textSize, color });
    },
    ...(size === undefined ? {} : { size }),
  };
}

interface HapticCall {
  readonly target: number | "all";
  readonly pattern: readonly number[];
}

interface Capture {
  readonly ctx: GameContext;
  readonly surface: RecordingSurface;
  readonly layouts: Array<{ slot: number; layoutId: string }>;
  readonly clearedLayouts: number[];
  readonly panels: Map<number, JsonValue>;
  readonly clearedPanels: number[];
  readonly haptics: HapticCall[];
  readonly counters: Map<string, number>;
}

function createCapture(
  gameManifest: GameManifest,
  surface: RecordingSurface,
): Capture {
  const layoutsApplied: Array<{ slot: number; layoutId: string }> = [];
  const clearedLayouts: number[] = [];
  const panels = new Map<number, JsonValue>();
  const clearedPanels: number[] = [];
  const haptics: HapticCall[] = [];
  const counters = new Map<string, number>();
  const snapshot: GameInputSnapshot = { tick: 0, players: [] };

  const renderer: GameRenderer3D = {
    backend: "canvas2d",
    drawCalls: 0,
    textureMemoryMB: 0,
    setCamera() {
      // Sumo Bumpers never moves a 3D camera.
    },
    drawCube() {
      // Sumo Bumpers never draws 3D geometry.
    },
    ...surface,
  };

  const ctx: GameContext = {
    manifest: gameManifest,
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
      set: (slot: number, content: JsonValue) => {
        panels.set(slot, content);
      },
      show: (slot: number, content: JsonValue) => {
        panels.set(slot, content);
      },
      clear: (slot: number) => {
        panels.delete(slot);
        clearedPanels.push(slot);
      },
    },
    layouts: {
      set: (target: number | "all", layout: LayoutDocument | string) => {
        if (typeof target === "number" && typeof layout === "string") {
          layoutsApplied.push({ slot: target, layoutId: layout });
        }
      },
      clear: (target: number | "all") => {
        if (typeof target === "number") clearedLayouts.push(target);
      },
    },
    haptics: {
      pulse: (target: number | "all", pattern: ReadonlyArray<number>) => {
        haptics.push({ target, pattern: [...pattern] });
      },
    },
    events: {
      on: () => () => undefined,
      onAny: () => () => undefined,
    },
    serverNow: () => 0,
  };

  return {
    ctx,
    surface,
    layouts: layoutsApplied,
    clearedLayouts,
    panels,
    clearedPanels,
    haptics,
    counters,
  };
}

function panelText(value: JsonValue | undefined): string {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return "";
  }
  const text = value["text"];
  return typeof text === "string" ? text : "";
}

// ---------------------------------------------------------------------------
// Harness and small helpers
// ---------------------------------------------------------------------------

interface HarnessOptions {
  readonly config?: SumoConfigOptions;
  readonly autoStart?: boolean;
  readonly surfaceSize?: { readonly width: number; readonly height: number };
}

interface Harness {
  readonly game: SumoGame;
  readonly capture: Capture;
  step(players: readonly GameControllerState[], dtSeconds?: number): void;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const surface = createSurface(options.surfaceSize);
  const capture = createCapture(manifest, surface);
  const gameOptions: SumoGameOptions = {
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.autoStart === undefined ? {} : { autoStart: options.autoStart }),
  };
  const game = createSumoGame(manifest, gameOptions);
  game.init(capture.ctx);
  return {
    game,
    capture,
    step(players, dtSeconds = STEP_SECONDS) {
      game.simulate(dtSeconds, { tick: 0, players });
    },
  };
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

function requireBumper(game: SumoGame, slot: number): SumoBumper {
  const bumper = game.bumper(slot);
  if (bumper === null) throw new Error(`slot ${slot} has no live bumper`);
  return bumper;
}

function allPlayers(count: number): GameControllerState[] {
  const list: GameControllerState[] = [];
  for (let slot = 1; slot <= count; slot += 1) list.push(player(slot));
  return list;
}

/** Two steps: the first starts the countdown, the second enters playing. */
function startPlaying(
  harness: Harness,
  players: readonly GameControllerState[],
): void {
  harness.step(players);
  harness.step(players);
}

// ---------------------------------------------------------------------------
// Manifest and layouts
// ---------------------------------------------------------------------------

describe("manifest and layouts", () => {
  test("[GAME-SB-DATA-01] the shipped manifest validates with launcher presentation", () => {
    expect(manifestResult.ok).toBe(true);
    expect(manifest.name).toBe("Sumo Bumpers");
    expect(manifest.minPlayers).toBe(2);
    expect(manifest.maxPlayers).toBe(8);
    expect(manifest.needsGyro).toBe(false);
    expect(manifest.renderer).toBe("canvas2d");
    expect(manifest.layouts).toEqual([
      `layouts/${SUMO_STICK_LAYOUT_ID}.json`,
      `layouts/${SUMO_DASH_LAYOUT_ID}.json`,
    ]);
    expect(manifest.presentation).toEqual({
      tagline: "Shove everyone off the shrinking floor.",
      accent: "#ff6b6b",
      categories: ["party", "arena", "action"],
      inputBadges: ["stick", "buttons", "haptics"],
    });
    expect(manifest.assetBudget).toEqual({
      initialBytes: 524288,
      totalBytes: 2097152,
    });
  });

  test("[GAME-SB-CTRL-01] sb-stick-v1 is one validated floating left stick", () => {
    const layout = requireLayout(SUMO_STICK_LAYOUT_ID);
    expect(layout.orientation).toBe("any");
    expect(layout.controls).toHaveLength(1);
    const stick = layout.controls.find((control) => control.type === "stick");
    expect(stick).toBeDefined();
    if (stick === undefined) return;
    expect(stick.id).toBe("move");
    expect(stick.axis).toBe("left");
    expect(stick.mode).toBe("floating");
    expect(stick.size).toBe("46%");
    expect(stick.deadzone).toBe(0.08);
  });

  test("[GAME-SB-CTRL-03] sb-stick-dash-v1 puts dash on bit 0 with a haptic pattern", () => {
    const layout = requireLayout(SUMO_DASH_LAYOUT_ID);
    expect(layout.controls).toHaveLength(3);
    const dash = layout.controls.find((control) => control.type === "button");
    expect(dash).toBeDefined();
    if (dash === undefined) return;
    expect(dash.id).toBe("dash");
    expect(dash.bit).toBe(0);
    expect(dash.haptic).toEqual([25]);
    expect(dash.shape).toBe("circle");
    const status = layout.controls.find((control) => control.type === "panel");
    expect(status).toBeDefined();
    if (status === undefined) return;
    expect(status.id).toBe("status");
    expect(
      layout.controls.some((control) => control.type === "stick"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config and geometry
// ---------------------------------------------------------------------------

describe("config and geometry", () => {
  test("[GAME-SB-DATA-01] shipped tuning matches the plan and overrides are validated", () => {
    expect(SUMO_CONFIG.arenaStartR).toBe(0.48);
    expect(SUMO_CONFIG.arenaEndR).toBe(0.18);
    expect(SUMO_CONFIG.shrinkDurationMs).toBe(60_000);
    expect(SUMO_CONFIG.playerRadius).toBe(0.035);
    expect(SUMO_CONFIG.accel).toBe(42);
    expect(SUMO_CONFIG.friction).toBe(3.2);
    expect(SUMO_CONFIG.restitution).toBe(0.65);
    expect(SUMO_CONFIG.massScale).toBe(1);
    expect(SUMO_CONFIG.roundsToWin).toBe(3);

    expect(resolveSumoConfig({ countdownMs: 0 }).countdownMs).toBe(0);
    expect(() => resolveSumoConfig({ countdownMs: 1.5 })).toThrow(RangeError);
    expect(() => resolveSumoConfig({ resultsMs: -1 })).toThrow(RangeError);
    expect(() => resolveSumoConfig({ roundsToWin: 0 })).toThrow(RangeError);
    expect(() => resolveSumoConfig({ arenaStartR: 0.6 })).toThrow(RangeError);
    expect(() => resolveSumoConfig({ arenaEndR: 0.48 })).toThrow(RangeError);
    expect(() => resolveSumoConfig({ playerRadius: 0.09 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Physics primitives (GAME-SB-TEST-01)
// ---------------------------------------------------------------------------

function circleBody(
  x: number,
  y: number,
  vx: number,
  vy: number,
  mass = 1,
  radius = 0.05,
): CircleBody {
  return { x, y, vx, vy, radius, mass, active: true };
}

describe("circle physics", () => {
  test("[GAME-SB-TEST-01] equal-mass head-on collision exchanges momentum", () => {
    const a = circleBody(-0.045, 0, 1, 0);
    const b = circleBody(0.045, 0, -1, 0);
    const contact = resolveCircleCircle(a, b, createContact(), 0.65);
    expect(contact.hit).toBe(true);
    expect(contact.impact).toBeCloseTo(2, 6);
    expect(contact.nx).toBeCloseTo(1, 6);
    expect(a.vx).toBeCloseTo(-0.65, 6);
    expect(b.vx).toBeCloseTo(0.65, 6);
    expect(a.vx + b.vx).toBeCloseTo(0, 6);
    expect(a.x).toBeLessThan(0);
    expect(b.x).toBeGreaterThan(0);
  });

  test("[GAME-SB-TEST-01] a heavy bumper pushes a light one forward", () => {
    const heavy = circleBody(-0.045, 0, 1, 0, 3);
    const light = circleBody(0.045, 0, 0, 0, 1);
    resolveCircleCircle(heavy, light, createContact(), 0.65);
    expect(heavy.vx).toBeCloseTo(0.5875, 6);
    expect(light.vx).toBeCloseTo(1.2375, 6);
    expect(light.vx).toBeGreaterThan(heavy.vx);
    expect(heavy.vx).toBeGreaterThan(0);
    expect(3 * heavy.vx + light.vx).toBeCloseTo(3, 6);
  });

  test("[GAME-SB-TEST-01] overlap correction separates bodies without adding energy", () => {
    const a = circleBody(0, 0, 0, 0);
    const b = circleBody(0.06, 0, 0, 0);
    const contact = resolveCircleCircle(a, b, createContact(), 0.65);
    expect(contact.hit).toBe(true);
    expect(contact.impact).toBe(0);
    expect(a.vx).toBe(0);
    expect(b.vx).toBe(0);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(0.1, 9);
    expect(a.x).toBeLessThan(0);
    expect(b.x).toBeGreaterThan(0.06);
  });

  test("[GAME-SB-TEST-01] a bumper is eliminated only when fully outside the floor", () => {
    expect(isFullyOutside(0.214_999, 0, 0.035, 0.18)).toBe(false);
    expect(isFullyOutside(0.215, 0, 0.035, 0.18)).toBe(true);
    expect(isFullyOutside(0, 0.3, 0.035, 0.18)).toBe(true);
    // Half over the edge is still in play.
    expect(isFullyOutside(0.18, 0, 0.035, 0.18)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shrink schedule and last standing (GAME-SB-TEST-02)
// ---------------------------------------------------------------------------

describe("shrinking floor", () => {
  test("[GAME-SB-TEST-02] the shrink schedule is monotonic and clamped", () => {
    expect(arenaRadiusAt(SUMO_CONFIG, 0)).toBe(0.48);
    expect(arenaRadiusAt(SUMO_CONFIG, -1)).toBe(0.48);
    expect(arenaRadiusAt(SUMO_CONFIG, Number.NaN)).toBe(0.48);
    expect(arenaRadiusAt(SUMO_CONFIG, 30_000)).toBeCloseTo(0.33, 9);

    let previous = Number.POSITIVE_INFINITY;
    for (let ms = 0; ms <= 61_000; ms += 500) {
      const radius = arenaRadiusAt(SUMO_CONFIG, ms);
      expect(radius).toBeLessThanOrEqual(previous);
      expect(radius).toBeGreaterThanOrEqual(SUMO_CONFIG.arenaEndR - 1e-12);
      previous = radius;
    }
    expect(arenaRadiusAt(SUMO_CONFIG, 60_000)).toBeCloseTo(0.18, 9);
    expect(arenaRadiusAt(SUMO_CONFIG, 120_000)).toBe(0.18);
  });

  test("[GAME-SB-TEST-02] the shrinking floor eliminates static bumpers and crowns the survivor", () => {
    const harness = createHarness({
      config: { countdownMs: 0, shrinkDurationMs: 1_000, resultsMs: 0 },
    });
    const p1 = player(1);
    const p2 = player(2);
    startPlaying(harness, [p1, p2]);
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.activeBumperCount).toBe(2);
    const startRadius = harness.game.arenaRadius;

    // Steer P1 toward the centre for 300 ms, then let it coast.
    for (let tick = 0; tick < 18; tick += 1) {
      harness.step([player(1, { ly: 1 }), p2]);
    }
    let guard = 0;
    while (harness.game.phase === "playing" && guard < 400) {
      harness.step([p1, p2]);
      guard += 1;
    }

    expect(harness.game.phase).toBe("results");
    expect(harness.game.lastRoundWinner).toBe(1);
    expect(harness.game.bumper(2)).toBeNull();
    expect(harness.game.wonRounds[0]).toBe(1);
    expect(harness.game.arenaRadius).toBeLessThan(startRadius);
  });

  test("[GAME-SB-TEST-02] a simultaneous wipe-out is a draw and the next round starts", () => {
    const harness = createHarness({
      config: { countdownMs: 0, shrinkDurationMs: 400, resultsMs: 0 },
    });
    const players = [player(1), player(2)];
    startPlaying(harness, players);

    let guard = 0;
    while (harness.game.phase === "playing" && guard < 400) {
      harness.step(players);
      guard += 1;
    }
    expect(harness.game.phase).toBe("results");
    expect(harness.game.lastRoundWinner).toBeNull();
    expect(harness.game.activeBumperCount).toBe(0);
    expect(harness.game.poolActive).toBe(0);
    expect(harness.game.wonRounds).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    harness.step(players);
    expect(harness.game.phase).toBe("countdown");
    harness.step(players);
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.round).toBe(2);
    expect(harness.game.activeBumperCount).toBe(2);
    expect(harness.game.bumper(1)).not.toBeNull();
  });

  test("[GAME-SB-TEST-03] eight players spawn without overlaps and steer independently", () => {
    const harness = createHarness({
      config: { countdownMs: 0, shrinkDurationMs: 60_000 },
    });
    const players = allPlayers(8);
    startPlaying(harness, players);
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.activeBumperCount).toBe(8);
    expect(harness.game.poolActive).toBe(8);

    const starts: Array<{ x: number; y: number }> = [];
    for (let slot = 1; slot <= 8; slot += 1) {
      const bumper = requireBumper(harness.game, slot);
      starts.push({ x: bumper.x, y: bumper.y });
    }
    for (let first = 0; first < starts.length; first += 1) {
      for (let second = first + 1; second < starts.length; second += 1) {
        const a = starts[first];
        const b = starts[second];
        if (a === undefined || b === undefined) continue;
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeGreaterThan(
          SUMO_CONFIG.playerRadius * 2,
        );
      }
    }

    const idle = players.slice(1);
    for (let tick = 0; tick < 20; tick += 1) {
      harness.step([player(1, { lx: 1 }), ...idle]);
    }
    const moved = requireBumper(harness.game, 1);
    const origin = starts[0];
    if (origin === undefined) throw new Error("missing spawn");
    expect(moved.x).toBeGreaterThan(origin.x + 0.01);
    for (let slot = 2; slot <= 8; slot += 1) {
      const bumper = requireBumper(harness.game, slot);
      const start = starts[slot - 1];
      if (start === undefined) throw new Error("missing spawn");
      expect(bumper.x).toBeCloseTo(start.x, 9);
      expect(bumper.y).toBeCloseTo(start.y, 9);
    }
  });
});

// ---------------------------------------------------------------------------
// Round flow and match reset (GAME-SB-HOST-01/05)
// ---------------------------------------------------------------------------

describe("round flow", () => {
  test("[GAME-SB-HOST-01] the decisive round is scored and the match returns to the lobby", () => {
    const harness = createHarness({
      config: {
        countdownMs: 0,
        shrinkDurationMs: 300,
        resultsMs: 0,
        roundsToWin: 1,
      },
      autoStart: false,
    });
    const p1 = player(1);
    const p2 = player(2);
    harness.step([p1, p2]);
    expect(harness.game.phase).toBe("lobby");

    harness.game.onEvent?.(1, "start", null);
    expect(harness.game.phase).toBe("countdown");
    harness.step([p1, p2]);
    expect(harness.game.phase).toBe("playing");

    let guard = 0;
    while (harness.game.phase === "playing" && guard < 300) {
      harness.step([player(1, { ly: 1 }), p2]);
      guard += 1;
    }
    expect(harness.game.phase).toBe("results");
    expect(harness.game.matchWinnerSlot).toBe(1);
    expect(harness.game.wonRounds[0]).toBe(1);

    harness.step([p1, p2]);
    expect(harness.game.phase).toBe("lobby");
    expect(harness.game.matchWinnerSlot).toBeNull();
    expect(harness.game.wonRounds).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(harness.game.activeBumperCount).toBe(0);
  });

  test("[GAME-SB-HOST-05] a fresh game starts in the lobby with zero scores", () => {
    const played = createHarness({
      config: { countdownMs: 0, shrinkDurationMs: 60_000 },
      autoStart: false,
    });
    played.step([player(1), player(2)]);
    played.game.onEvent?.(1, "start", null);
    played.step([player(1), player(2)]);
    played.step([player(1), player(2)]);
    expect(played.game.phase).toBe("playing");

    // A host refresh constructs a new game: no scores, no bodies, lobby phase.
    const refreshed = createHarness({ autoStart: false });
    expect(refreshed.game.phase).toBe("lobby");
    expect(refreshed.game.round).toBe(0);
    expect(refreshed.game.roundsPlayed).toBe(0);
    expect(refreshed.game.activeBumperCount).toBe(0);
    expect(refreshed.game.matchWinnerSlot).toBeNull();
    expect(refreshed.game.wonRounds).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Connection edges, disconnect grace and reconnect (GAME-SB-HOST-04)
// ---------------------------------------------------------------------------

describe("disconnect and reconnect", () => {
  test("[GAME-SB-CTRL-01] the dash layout is applied on connect, cleared on drop and re-applied", () => {
    const harness = createHarness({ config: { countdownMs: 0 } });
    const p1 = player(1);
    const p2 = player(2);
    harness.step([p1, p2]);
    expect(harness.capture.layouts).toEqual([
      { slot: 1, layoutId: SUMO_DASH_LAYOUT_ID },
      { slot: 2, layoutId: SUMO_DASH_LAYOUT_ID },
    ]);

    harness.step([p1]);
    expect(harness.capture.clearedLayouts).toContain(2);
    harness.step([p1, p2]);
    expect(
      harness.capture.layouts.filter((entry) => entry.slot === 2),
    ).toHaveLength(2);
  });

  test("[GAME-SB-HOST-04] a disconnected body survives its grace, then leaves the round", () => {
    const harness = createHarness({
      config: {
        countdownMs: 0,
        shrinkDurationMs: 60_000,
        resultsMs: 1_000,
        disconnectRemovalMs: 100,
      },
    });
    const p1 = player(1);
    const p2 = player(2);
    const p3 = player(3);
    startPlaying(harness, [p1, p2, p3]);
    expect(harness.game.activeBumperCount).toBe(3);

    harness.step([p1, p2]);
    const dropped = requireBumper(harness.game, 3);
    expect(dropped.connected).toBe(false);
    expect(harness.game.activeBumperCount).toBe(3);

    let guard = 0;
    while (harness.game.bumper(3) !== null && guard < 30) {
      harness.step([p1, p2]);
      guard += 1;
    }
    expect(harness.game.bumper(3)).toBeNull();
    expect(harness.game.activeBumperCount).toBe(2);
    expect(harness.game.poolActive).toBe(2);
    expect(harness.game.phase).toBe("playing");
    expect(harness.capture.clearedLayouts).toContain(3);
    expect(harness.capture.clearedPanels).toContain(3);
  });

  test("[GAME-SB-HOST-04] reconnecting inside the grace keeps the same body", () => {
    const harness = createHarness({
      config: {
        countdownMs: 0,
        shrinkDurationMs: 60_000,
        disconnectRemovalMs: 200,
      },
    });
    const p1 = player(1);
    const p2 = player(2);
    const p3 = player(3);
    startPlaying(harness, [p1, p2, p3]);

    harness.step([p1, p2]);
    harness.step([p1, p3]);
    expect(harness.game.bumper(3)).not.toBeNull();

    harness.step([p1, p2, p3]);
    const resumed = requireBumper(harness.game, 3);
    expect(resumed.connected).toBe(true);
    expect(resumed.disconnectedAtMs).toBe(-1);
    expect(harness.game.activeBumperCount).toBe(3);
  });

  test("[GAME-SB-HOST-04] rejoining before the next round respawns the bumper", () => {
    const harness = createHarness({
      config: {
        countdownMs: 0,
        shrinkDurationMs: 60_000,
        resultsMs: 0,
        disconnectRemovalMs: 100,
      },
    });
    const p1 = player(1);
    const p2 = player(2);
    const p3 = player(3);
    startPlaying(harness, [p1, p2, p3]);

    harness.step([p1, p2]);
    let guard = 0;
    while (harness.game.bumper(3) !== null && guard < 30) {
      harness.step([p1, p2]);
      guard += 1;
    }
    expect(harness.game.bumper(3)).toBeNull();

    // Reconnect mid-round: spectating until the round ends.
    harness.step([p1, p2, p3]);
    expect(harness.game.bumper(3)).toBeNull();
    expect(panelText(harness.capture.panels.get(3))).toContain("Eliminated");

    // Drive P1 off the top edge; P2 is the last body standing.
    guard = 0;
    while (harness.game.phase === "playing" && guard < 400) {
      harness.step([player(1, { ly: -1 }), p2, p3]);
      guard += 1;
    }
    expect(harness.game.phase).toBe("results");
    expect(harness.game.lastRoundWinner).toBe(2);

    harness.step([p1, p2, p3]);
    expect(harness.game.phase).toBe("countdown");
    harness.step([p1, p2, p3]);
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.round).toBe(2);
    expect(harness.game.activeBumperCount).toBe(3);
    expect(harness.game.bumper(3)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Controller feedback: eliminated panel, dash and haptics (GAME-SB-CTRL-02/03)
// ---------------------------------------------------------------------------

describe("controller feedback", () => {
  test("[GAME-SB-CTRL-02] an eliminated player sees the spectating panel", () => {
    const harness = createHarness({
      config: { countdownMs: 0, shrinkDurationMs: 60_000 },
    });
    const p1 = player(1);
    const p2 = player(2);
    // Slot 3 spawns at 150 degrees; drive it radially outward.
    const angle = -Math.PI / 2 + (2 / 3) * Math.PI * 2;
    const outward = player(3, {
      lx: Math.cos(angle),
      ly: Math.sin(angle),
    });

    startPlaying(harness, [p1, p2, outward]);
    let guard = 0;
    while (harness.game.bumper(3) !== null && guard < 400) {
      harness.step([p1, p2, outward]);
      guard += 1;
    }

    expect(harness.game.bumper(3)).toBeNull();
    expect(harness.game.phase).toBe("playing");
    expect(harness.game.activeBumperCount).toBe(2);
    expect(panelText(harness.capture.panels.get(3))).toBe(
      "Eliminated — spectating",
    );
  });

  test("[GAME-SB-CTRL-03] the dash uses the edge bit, the stick direction and an 800 ms cooldown", () => {
    const harness = createHarness({
      config: { countdownMs: 0, shrinkDurationMs: 60_000 },
    });
    const p2 = player(2);
    startPlaying(harness, [player(1), p2]);

    for (let tick = 0; tick < 5; tick += 1) {
      harness.step([player(1, { ly: 1 }), p2]);
    }
    const before = requireBumper(harness.game, 1);
    const vyBefore = before.vy;

    harness.step([player(1, { edges: 1 }), p2]);
    const dashing = requireBumper(harness.game, 1);
    expect(dashing.vy - vyBefore).toBeGreaterThan(0.5);
    expect(dashing.dashReadyAtMs).toBeGreaterThan(0);
    expect(dashing.dashUntilMs).toBeGreaterThan(0);

    const vyAfterDash = dashing.vy;
    harness.step([player(1, { edges: 1 }), p2]);
    // Capture the value, not the pooled body: later ticks mutate the same object.
    const vyCoolingDown = requireBumper(harness.game, 1).vy;
    expect(vyCoolingDown).toBeLessThan(vyAfterDash);
    expect(vyAfterDash - vyCoolingDown).toBeLessThan(0.1);

    // A held button without a fresh edge never dashes.
    harness.step([player(1, { buttons: 1 }), p2]);
    expect(requireBumper(harness.game, 1).vy).toBeLessThan(vyCoolingDown);
  });

  test("[GAME-SB-CTRL-03] bumper hits pulse haptics on both slots", () => {
    const harness = createHarness({
      config: { countdownMs: 0, shrinkDurationMs: 60_000 },
    });
    startPlaying(harness, [player(1), player(2)]);

    let guard = 0;
    while (harness.capture.haptics.length === 0 && guard < 300) {
      harness.step([player(1, { ly: 1 }), player(2, { ly: -1 })]);
      guard += 1;
    }

    expect(harness.capture.haptics.length).toBeGreaterThan(0);
    expect(harness.capture.haptics.some((call) => call.target === 1)).toBe(true);
    expect(harness.capture.haptics.some((call) => call.target === 2)).toBe(true);
    expect(harness.capture.haptics[0]?.pattern).toEqual([40]);
  });
});

// ---------------------------------------------------------------------------
// Presentation (GAME-SB-HOST-03, GAME-SB-DATA-02)
// ---------------------------------------------------------------------------

describe("presentation", () => {
  test("[GAME-SB-HOST-03] render draws the lobby, countdown, playing and results overlays", () => {
    const harness = createHarness({
      config: { countdownMs: 3_000, shrinkDurationMs: 60_000 },
    });
    const surface = harness.capture.surface;
    const p1 = player(1);
    const p2 = player(2);

    harness.game.render(0.5);
    expect(surface.counts.begin).toBe(1);
    expect(surface.counts.end).toBe(1);
    expect(surface.texts.some((entry) => entry.text === "SUMO BUMPERS")).toBe(
      true,
    );
    expect(
      surface.texts.some((entry) => entry.text.includes("Waiting for players")),
    ).toBe(true);

    harness.step([p1, p2]);
    const countdownStart = surface.texts.length;
    harness.game.render(0);
    const countdownTexts = surface.texts.slice(countdownStart);
    expect(countdownTexts.some((entry) => entry.text === "3")).toBe(true);
    expect(countdownTexts.some((entry) => entry.text === "ROUND 1")).toBe(true);

    let guard = 0;
    while (harness.game.phase !== "playing" && guard < 220) {
      harness.step([p1, p2]);
      guard += 1;
    }
    expect(harness.game.phase).toBe("playing");
    const playingStart = surface.texts.length;
    harness.game.render(0);
    const playingTexts = surface.texts.slice(playingStart);
    expect(playingTexts.some((entry) => entry.text === "ROUND 1")).toBe(true);
    expect(playingTexts.some((entry) => entry.text === "ALIVE 2")).toBe(true);
    expect(playingTexts.some((entry) => entry.text === "P1")).toBe(true);

    const drawHarness = createHarness({
      config: { countdownMs: 0, shrinkDurationMs: 300 },
    });
    const drawPlayers = [player(1), player(2)];
    startPlaying(drawHarness, drawPlayers);
    let drawGuard = 0;
    while (drawHarness.game.phase === "playing" && drawGuard < 300) {
      drawHarness.step(drawPlayers);
      drawGuard += 1;
    }
    expect(drawHarness.game.phase).toBe("results");
    const resultsStart = drawHarness.capture.surface.texts.length;
    drawHarness.game.render(0);
    const resultsTexts = drawHarness.capture.surface.texts.slice(resultsStart);
    expect(resultsTexts.some((entry) => entry.text === "DRAW")).toBe(true);
    expect(
      resultsTexts.some(
        (entry) => entry.text === "Next round starts automatically",
      ),
    ).toBe(true);
  });

  test("[GAME-SB-HOST-03] a backend without the flat 2D calls draws nothing", () => {
    const bare: GameRenderer3D = {
      backend: "canvas2d",
      beginFrame() {
        // No flat surface.
      },
      endFrame() {
        // No flat surface.
      },
      drawCalls: 0,
      textureMemoryMB: 0,
      setCamera() {
        // Unused by Sumo Bumpers.
      },
      drawCube() {
        // Unused by Sumo Bumpers.
      },
    };
    expect(resolveRenderer2D(bare)).toBeNull();
  });

  test("[GAME-SB-DATA-02] arena coordinates scale with the short viewport side", () => {
    const hud = new SumoHud(2, 8, 3);
    const bumpers: SumoBumperView[] = [];
    for (let slot = 1; slot <= 8; slot += 1) {
      bumpers.push({
        slot,
        x: 0,
        y: 0,
        radius: 0,
        active: false,
        connected: false,
        dashing: false,
      });
    }
    bumpers[0] = {
      slot: 1,
      x: 0.1,
      y: 0,
      radius: 0.035,
      active: true,
      connected: true,
      dashing: false,
    };
    const state: SumoRenderState = {
      phase: "playing",
      round: 1,
      arenaRadius: 0.48,
      arenaStartR: 0.48,
      maxPlayers: 8,
      activeCount: 1,
      connectedMask: 1 << 1,
      countdownMs: 0,
      hud,
      bumpers,
      wins: [0, 0, 0, 0, 0, 0, 0, 0],
      resultsRows: [],
      resultsCount: 0,
      roundWinnerSlot: null,
      matchWinnerSlot: null,
    };

    const wide = createSurface({ width: 1200, height: 720 });
    drawSumo(wide, state, 0.5);
    const narrow = createSurface({ width: 720, height: 1200 });
    drawSumo(narrow, state, 0.5);

    const bumperRadius = 0.035 * 720;
    const wideBumper = wide.circles.find(
      (circle) => Math.abs(circle.r - bumperRadius) < 1e-9,
    );
    const narrowBumper = narrow.circles.find(
      (circle) => Math.abs(circle.r - bumperRadius) < 1e-9,
    );
    expect(wideBumper).toBeDefined();
    expect(narrowBumper).toBeDefined();
    if (wideBumper === undefined || narrowBumper === undefined) return;

    // Same normalized offset from the centre on both aspect ratios.
    expect((wideBumper.x - 1200 / 2) / 720).toBeCloseTo(0.1, 9);
    expect((wideBumper.y - 720 / 2) / 720).toBeCloseTo(0, 9);
    expect((narrowBumper.x - 720 / 2) / 720).toBeCloseTo(0.1, 9);
    expect((narrowBumper.y - 1200 / 2) / 720).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle and soak (GAME-SB-TEST-05)
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  test("[GAME-SB-TEST-05] dispose is idempotent and later calls are no-ops", () => {
    const harness = createHarness({ config: { countdownMs: 0 } });
    const players = [player(1), player(2)];
    startPlaying(harness, players);
    harness.game.render(0.5);
    const framesBefore = harness.capture.surface.counts.begin;

    expect(() => {
      harness.game.dispose();
      harness.game.dispose();
    }).not.toThrow();
    expect(harness.game.poolActive).toBe(0);
    expect(harness.game.activeBumperCount).toBe(0);

    expect(() => {
      harness.game.simulate(STEP_SECONDS, { tick: 0, players });
      harness.game.render(0.5);
      harness.game.onEvent?.(1, "start", null);
    }).not.toThrow();
    expect(harness.capture.surface.counts.begin).toBe(framesBefore);
  });

  test("[GAME-SB-TEST-05] an eight-bot ten-minute run stays finite and pool-leak-free", () => {
    const harness = createHarness({ config: { countdownMs: 0 } });
    const game = harness.game;
    const list: GameControllerState[] = [];
    const TICKS = 36_000;

    for (let tick = 0; tick < TICKS; tick += 1) {
      list.length = 0;
      const seconds = tick / 60;
      for (let slot = 1; slot <= 8; slot += 1) {
        list.push(
          player(slot, {
            lx: Math.cos(seconds * 0.7 + slot),
            ly: Math.sin(seconds * 1.1 + slot * 0.5),
          }),
        );
      }
      harness.step(list);

      if (tick % 600 === 0) {
        expect(game.poolActive).toBe(game.activeBumperCount);
        for (let slot = 1; slot <= 8; slot += 1) {
          const bumper = game.bumper(slot);
          if (bumper === null) continue;
          expect(Number.isFinite(bumper.x)).toBe(true);
          expect(Number.isFinite(bumper.y)).toBe(true);
          expect(Number.isFinite(bumper.vx)).toBe(true);
          expect(Number.isFinite(bumper.vy)).toBe(true);
        }
      }
    }

    expect(game.poolIgnoredReleases).toBe(0);
    expect(game.roundsPlayed).toBeGreaterThan(0);
  }, 30_000);
});

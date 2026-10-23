/**
 * Headless Bomb Defusal harness (FR-7.17, FR-8.2, SR-13).
 *
 * Every test drives the real `Game` through `simulate` with a recording
 * `GameContext`. Panels, layouts, haptics and controller events are captured
 * per slot, so privacy assertions can inspect exactly what each phone saw and
 * what the TV renderer was asked to draw. No DOM, GPU or socket is involved.
 */
import { readFileSync } from "node:fs";
import {
  validateManifest,
  type GameContext,
  type GameControllerState,
  type GameDebug,
  type GameEvent,
  type GameEvents,
  type GameHaptics,
  type GameLayouts,
  type GameManifest,
  type GamePanels,
  type GameRenderer3D,
  type GameRng,
  type JsonValue,
  type LayoutDocument,
} from "@lanpad/sdk";
import {
  createFakeContext,
  createFakeInput,
  createFakePlayer,
  type FakeInput,
} from "@lanpad/sdk/testing";
import {
  createBombDefusalGame,
  type BombDefusalGame,
  type BombDefusalGameOptions,
} from "../src/game.js";
import type { Renderer2DLike } from "../src/render.js";

export { createFakePlayer };

/** Fixed tick; 50 ms keeps hold-duration arithmetic exact for every target. */
export const STEP_MS = 50;
export const STEP_SECONDS = STEP_MS / 1000;

/** Reads and validates the shipped manifest the same way the host does. */
export function loadManifest(): GameManifest {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../game.manifest.json", import.meta.url), "utf8"),
  );
  const result = validateManifest(raw);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  return result.manifest;
}

/** Deterministic mulberry32; matches the SDK RNG contract. */
export function createSeededRng(seed: number): GameRng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    int(min: number, max: number): number {
      return min + Math.floor(next() * (max - min + 1));
    },
  };
}

/** One panel payload addressed to one slot. */
export interface RecordedPanel {
  readonly slot: number;
  readonly content: JsonValue | null;
}

export interface PanelRecorder extends GamePanels {
  readonly records: RecordedPanel[];
  /** Latest content for a slot, or undefined when it never received one. */
  last(slot: number): JsonValue | null | undefined;
}

export function createPanelRecorder(): PanelRecorder {
  const records: RecordedPanel[] = [];
  const record = (slot: number, content: JsonValue | null): void => {
    records.push({ slot, content });
  };
  return {
    get records(): RecordedPanel[] {
      return records;
    },
    set(slot, content): void {
      record(slot, content);
    },
    show(slot, content): void {
      record(slot, content);
    },
    clear(slot): void {
      record(slot, null);
    },
    last(slot: number): JsonValue | null | undefined {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const entry = records[index];
        if (entry !== undefined && entry.slot === slot) return entry.content;
      }
      return undefined;
    },
  };
}

/** Flattens panel JSON to text so a test can assert on what a phone shows. */
export function panelText(content: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      parts.push(value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
    } else if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        visit(value[index]);
      }
    } else if (value !== null && typeof value === "object") {
      const record = value as Readonly<Record<string, unknown>>;
      for (const key of Object.keys(record)) {
        visit(record[key]);
      }
    }
  };
  visit(content);
  return parts.join("\n");
}

export interface LayoutSetRecord {
  readonly target: number | "all";
  readonly layout: LayoutDocument | string;
}

export interface LayoutRecorder extends GameLayouts {
  readonly sets: LayoutSetRecord[];
  readonly clears: Array<number | "all">;
  /** Last layout id requested for one slot, or undefined. */
  lastFor(slot: number): LayoutDocument | string | undefined;
}

export function createLayoutRecorder(): LayoutRecorder {
  const sets: LayoutSetRecord[] = [];
  const clears: Array<number | "all"> = [];
  return {
    get sets(): LayoutSetRecord[] {
      return sets;
    },
    get clears(): Array<number | "all"> {
      return clears;
    },
    set(target, layout): void {
      sets.push({ target, layout });
    },
    clear(target): void {
      clears.push(target);
    },
    lastFor(slot: number): LayoutDocument | string | undefined {
      for (let index = sets.length - 1; index >= 0; index -= 1) {
        const entry = sets[index];
        if (entry !== undefined && entry.target === slot) return entry.layout;
      }
      return undefined;
    },
  };
}

export interface PulseRecord {
  readonly target: number | "all";
  readonly pattern: readonly number[];
}

export interface HapticsRecorder extends GameHaptics {
  readonly pulses: PulseRecord[];
}

export function createHapticsRecorder(): HapticsRecorder {
  const pulses: PulseRecord[] = [];
  return {
    get pulses(): PulseRecord[] {
      return pulses;
    },
    pulse(target, pattern): void {
      pulses.push({ target, pattern: Array.from(pattern) });
    },
  };
}

export interface DebugRecorder extends GameDebug {
  readonly counters: Map<string, number>;
}

export function createDebugRecorder(): DebugRecorder {
  const counters = new Map<string, number>();
  return {
    enabled: false,
    get counters(): Map<string, number> {
      return counters;
    },
    setCounter(name, value): void {
      counters.set(name, value);
    },
  };
}

export interface FlatRenderer extends GameRenderer3D, Renderer2DLike {
  /** Every string the TV was asked to draw, in call order. */
  readonly texts: string[];
  readonly frameCount: number;
  readonly size: { readonly width: number; readonly height: number };
}

/** A 1280x720 Canvas2D-like surface; no pixels are produced. */
export function createFlatRenderer(): FlatRenderer {
  const texts: string[] = [];
  let frameCount = 0;
  return {
    backend: "canvas2d",
    drawCalls: 0,
    textureMemoryMB: 0,
    size: { width: 1280, height: 720 },
    get texts(): string[] {
      return texts;
    },
    get frameCount(): number {
      return frameCount;
    },
    beginFrame(): void {
      frameCount += 1;
    },
    endFrame(): void {},
    clear(): void {},
    rect(): void {},
    circle(): void {},
    text(value: string): void {
      texts.push(value);
    },
    setCamera(): void {},
    drawCube(): void {},
  };
}

export interface EventBus extends GameEvents {
  /** Delivers one controller event synchronously, as the host router does. */
  emit(slot: number, name: string, data: JsonValue): void;
  /** Live subscriptions; dispose must drive this back to zero. */
  readonly subscriptionCount: number;
}

export function createEventBus(): EventBus {
  const named = new Map<string, Set<(event: GameEvent) => void>>();
  const anyListeners = new Set<(event: GameEvent) => void>();
  let subscriptions = 0;
  return {
    get subscriptionCount(): number {
      return subscriptions;
    },
    on(name, handler): () => void {
      let handlers = named.get(name);
      if (handlers === undefined) {
        handlers = new Set();
        named.set(name, handlers);
      }
      handlers.add(handler);
      subscriptions += 1;
      const listener = handlers;
      return (): void => {
        if (listener.delete(handler)) subscriptions -= 1;
      };
    },
    onAny(handler): () => void {
      anyListeners.add(handler);
      subscriptions += 1;
      return (): void => {
        if (anyListeners.delete(handler)) subscriptions -= 1;
      };
    },
    emit(slot, name, data): void {
      const event: GameEvent = { slot, name, data };
      const handlers = named.get(name);
      if (handlers !== undefined) {
        for (const handler of handlers) handler(event);
      }
      for (const handler of anyListeners) handler(event);
    },
  };
}

export interface Harness {
  readonly manifest: GameManifest;
  readonly game: BombDefusalGame;
  readonly ctx: GameContext;
  readonly input: FakeInput;
  readonly bus: EventBus;
  readonly panels: PanelRecorder;
  readonly layouts: LayoutRecorder;
  readonly haptics: HapticsRecorder;
  readonly debug: DebugRecorder;
  readonly renderer: FlatRenderer;
  /** Advances whole fixed ticks; default one 50 ms step. */
  tick(count?: number): void;
  /** Ticks until `phase === "playing"`, failing loudly if the match stalls. */
  advanceToPlaying(): void;
  setPlayers(players: readonly GameControllerState[]): void;
  emitChoice(slot: number, value: string): void;
  emitText(slot: number, value: string): void;
}

export interface HarnessOptions {
  readonly players?: readonly GameControllerState[];
  readonly game?: BombDefusalGameOptions;
  readonly manifest?: GameManifest;
  readonly rngSeed?: number;
}

/**
 * Builds the real game against a recording context. Round-tuning defaults keep
 * each test short (no countdown, a long timer, a short grace window).
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const manifest = options.manifest ?? loadManifest();
  const players =
    options.players ?? [createFakePlayer(1), createFakePlayer(2)];
  const input = createFakeInput(players);
  const bus = createEventBus();
  const panels = createPanelRecorder();
  const layouts = createLayoutRecorder();
  const haptics = createHapticsRecorder();
  const debug = createDebugRecorder();
  const renderer = createFlatRenderer();
  const rng = createSeededRng(options.rngSeed ?? 1);

  const ctx = createFakeContext({
    manifest,
    input,
    events: bus,
    panels,
    layouts,
    haptics,
    debug,
    renderer,
    rng,
  });

  const game = createBombDefusalGame(manifest, {
    countdownMs: 0,
    timerMs: 60_000,
    defuserGraceMs: 1_000,
    ...(options.game ?? {}),
  });
  game.init(ctx);

  return {
    manifest,
    game,
    ctx,
    input,
    bus,
    panels,
    layouts,
    haptics,
    debug,
    renderer,
    tick(count = 1): void {
      for (let index = 0; index < count; index += 1) {
        game.simulate(STEP_SECONDS, input.snapshot);
      }
    },
    advanceToPlaying(): void {
      for (let guard = 0; guard < 200 && game.phase !== "playing"; guard += 1) {
        game.simulate(STEP_SECONDS, input.snapshot);
      }
      if (game.phase !== "playing") {
        throw new Error(`game did not reach playing (phase ${game.phase})`);
      }
    },
    setPlayers(next): void {
      input.setPlayers(next);
    },
    emitChoice(slot, value): void {
      bus.emit(slot, "kit.choice", { value });
    },
    emitText(slot, value): void {
      bus.emit(slot, "kit.text", { value });
    },
  };
}

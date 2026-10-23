/**
 * Bomb Defusal TV presentation (GAME-BD-HOST-01; FR-9.4, PR-9.3, PR-9.5).
 *
 * Only shared bomb state is drawn: serial, batteries, indicators, the wire
 * colours, the button colour and the four keypad letters. Manual rules,
 * target hold times and the keypad code never enter this module, so a viewer
 * of the TV cannot read a private page.
 *
 * `GameRenderer3D` does not declare the flat 2D surface yet, so this module
 * feature-detects the same calls `Canvas2DRenderer` implements (`clear`,
 * `rect`, `circle`, `text`) and draws nothing on a 3D-only backend. Drawing is
 * in the 1280x720 design space and letterboxes onto the real surface with one
 * scale plus one centred offset, exactly like Coin Run.
 *
 * `BombRenderCache` rebuilds a string only when its numeric source changes;
 * `drawBomb` itself allocates nothing, and its loops are plain `for` loops
 * (PR-9.3, PR-9.5).
 */
import type { GameRenderer3D } from "@lanpad/sdk";
import {
  buttonHoldTarget,
  formatTimer,
  type Bomb,
  type ButtonColor,
  type WireColor,
} from "./bomb.js";
import { BOMB_CONFIG, type RoundCause } from "./config.js";

/** CSS size a backend may report; absent on test doubles (HP-04). */
export interface RendererSize {
  readonly width: number;
  readonly height: number;
}

/** The flat 2D calls a Canvas2D backend exposes. */
export interface Renderer2DLike {
  beginFrame(alpha: number): void;
  endFrame(): void;
  clear(color: string): void;
  rect(x: number, y: number, w: number, h: number, color: string): void;
  circle(x: number, y: number, r: number, color: string): void;
  text(
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    align?: "left" | "center" | "right",
  ): void;
  readonly size?: RendererSize;
}

export function resolveRenderer2D(renderer: GameRenderer3D): Renderer2DLike | null {
  const candidate = renderer as unknown as Partial<Renderer2DLike>;
  if (
    typeof candidate.beginFrame === "function" &&
    typeof candidate.endFrame === "function" &&
    typeof candidate.clear === "function" &&
    typeof candidate.rect === "function" &&
    typeof candidate.circle === "function" &&
    typeof candidate.text === "function"
  ) {
    return candidate as Renderer2DLike;
  }
  return null;
}

export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 720;

/** Coarse phase; mirrors the adapter's match phase. */
export type RenderPhase = "lobby" | "countdown" | "playing" | "results";

/** Pooled per-frame view the adapter owns and refills (no allocation). */
export interface BombRenderState {
  phase: RenderPhase;
  countdownMs: number;
  timerMs: number;
  strikes: number;
  strikesAllowed: number;
  defuserSlot: number;
  connectedCount: number;
  minPlayers: number;
  bomb: Bomb | null;
  solved: number;
  cause: RoundCause | null;
  resultTimeMs: number;
  /** Milliseconds left before the round is lost; negative when inactive. */
  defuserGraceMs: number;
  buttonDown: boolean;
  heldMs: number;
}

const BACKGROUND = "#000000";
const SURFACE = "#111111";
const BORDER_COLOR = "#1a1a1a";
const RAISED = "#2a2a2a";
const TEXT = "#ffffff";
const MUTED = "#b4b4b4";
const ACCENT = "#e5484d";
const SOLVED = "#c6f24e";
const ON_ACCENT = "#000000";

const WIRE_HEX: Readonly<Record<WireColor, string>> = {
  red: "#e5484d",
  blue: "#4cb3f0",
  yellow: "#f5c542",
  white: "#f2f2f2",
  black: "#555555",
  green: "#4fd1a1",
};

const BUTTON_HEX: Readonly<Record<ButtonColor, string>> = {
  blue: "#4cb3f0",
  yellow: "#f5c542",
  red: "#e5484d",
  white: "#f2f2f2",
};

const STATIC_TITLE = "BOMB DEFUSAL";
const STATIC_SUBTITLE = "READ THE MANUAL. CUT THE RIGHT WIRE.";
const STATIC_LOBBY_LINE = "Phones join as controllers. The TV shows the bomb.";
const STATIC_LOBBY_HINT = "One phone becomes the defuser; every other phone holds the manual.";
const STATIC_GRACE_PREFIX = "DEFUSER SIGNAL LOST ";
const STATIC_PRESS = "PRESS & HOLD";
const STATIC_RELEASE = "RELEASE";
const STATIC_SOLVED = "SOLVED";
const STATIC_MODULES_SOLVED = "ALL MODULES CLEARED";
const STATIC_GET_READY = "GET READY";
const STATIC_MANUAL_HINT = "MANUAL READERS: PREV / NEXT";
const STATIC_REMATCH = "Press any button for a new bomb";

interface ResultCopy {
  readonly title: string;
  readonly subtitle: string;
}

const RESULT_COPY: Readonly<Record<RoundCause, ResultCopy>> = {
  defused: { title: "BOMB DEFUSED", subtitle: "Every module is clear." },
  strikes: { title: "BOMB EXPLODED", subtitle: "Three strikes." },
  timeout: { title: "BOMB EXPLODED", subtitle: "The timer reached zero." },
  "defuser-lost": { title: "BOMB EXPLODED", subtitle: "The defuser did not return in time." },
};

/** One cached numeric -> string value. */
class CachedNumber {
  private value = Number.NaN;
  private cached = "";

  get(value: number, build: (value: number) => string): string {
    if (value !== this.value) {
      this.value = value;
      this.cached = build(value);
    }
    return this.cached;
  }
}

/** Two cached numbers -> one string (strikes, solved, connected). */
class CachedPair {
  private first = Number.NaN;
  private second = Number.NaN;
  private cached = "";

  get(first: number, second: number, build: (a: number, b: number) => string): string {
    if (first !== this.first || second !== this.second) {
      this.first = first;
      this.second = second;
      this.cached = build(first, second);
    }
    return this.cached;
  }
}

/**
 * Per-game string cache. Cache slots are allocated once in the constructor;
 * `get` returns the same string object until the source value changes.
 */
export class BombRenderCache {
  private readonly timeCache = new CachedNumber();
  private readonly countdownCache = new CachedNumber();
  private readonly waitingCache = new CachedPair();
  private readonly strikesCache = new CachedPair();
  private readonly solvedCache = new CachedPair();
  private readonly connectedCache = new CachedNumber();
  private readonly graceCache = new CachedNumber();
  private readonly resultTimeCache = new CachedNumber();
  private readonly resultStrikesCache = new CachedPair();
  private readonly defuserLabels: string[] = [];
  private lastBomb: Bomb | null = null;
  private serialLine = "";
  private batteriesLine = "";
  private indicatorsLine = "";

  constructor(maxSlots: number = 8) {
    const slots = Number.isInteger(maxSlots) && maxSlots > 0 ? maxSlots : 8;
    this.defuserLabels.push("NO DEFUSER YET");
    for (let slot = 1; slot <= slots; slot += 1) {
      this.defuserLabels.push(`DEFUSER P${slot}`);
    }
  }

  /** `TIME mm:ss`; rebuilds only when the displayed second changes. */
  time(remainingMs: number): string {
    const displayed =
      Number.isFinite(remainingMs) && remainingMs > 0
        ? Math.floor(remainingMs / 1000)
        : 0;
    return this.timeCache.get(displayed, (seconds) => `TIME ${formatTimer(seconds * 1000)}`);
  }

  countdown(remainingMs: number): string {
    const seconds = Math.max(1, Math.ceil((Number.isFinite(remainingMs) ? remainingMs : 0) / 1000));
    return this.countdownCache.get(seconds, (value) => String(value));
  }

  waiting(connected: number, minPlayers: number): string {
    return this.waitingCache.get(
      connected,
      minPlayers,
      (players, required) => `WAITING FOR PLAYERS ${players}/${required}`,
    );
  }

  strikes(strikes: number, allowed: number): string {
    return this.strikesCache.get(strikes, allowed, (used, total) => `STRIKES ${used}/${total}`);
  }

  solved(solved: number, total: number): string {
    return this.solvedCache.get(solved, total, (cleared, modules) => `SOLVED ${cleared}/${modules}`);
  }

  connected(count: number): string {
    return this.connectedCache.get(
      count,
      (players) => `${players} PHONE${players === 1 ? "" : "S"} CONNECTED`,
    );
  }

  grace(remainingMs: number): string {
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    return this.graceCache.get(seconds, (value) => `${STATIC_GRACE_PREFIX}${value}s`);
  }

  defuser(slot: number): string {
    return this.defuserLabels[slot] ?? this.defuserLabels[0] ?? "NO DEFUSER YET";
  }

  resultTime(remainingMs: number): string {
    const displayed =
      Number.isFinite(remainingMs) && remainingMs > 0
        ? Math.floor(remainingMs / 1000)
        : 0;
    return this.resultTimeCache.get(
      displayed,
      (seconds) => `TIME LEFT ${formatTimer(seconds * 1000)}`,
    );
  }

  resultStrikes(strikes: number, allowed: number): string {
    return this.resultStrikesCache.get(
      strikes,
      allowed,
      (used, total) => `STRIKES ${used}/${total}`,
    );
  }

  /** Rebuilds the three serial lines only when the round's bomb changes. */
  syncBomb(bomb: Bomb | null): void {
    if (bomb === this.lastBomb) return;
    this.lastBomb = bomb;
    if (bomb === null) {
      this.serialLine = "";
      this.batteriesLine = "";
      this.indicatorsLine = "";
      return;
    }
    this.serialLine = `SERIAL ${bomb.serial}`;
    this.batteriesLine = `BATTERIES ${bomb.batteries}`;
    this.indicatorsLine = `INDICATORS ${bomb.indicators.join(" / ")}`;
  }

  get serial(): string {
    return this.serialLine;
  }

  get batteries(): string {
    return this.batteriesLine;
  }

  get indicators(): string {
    return this.indicatorsLine;
  }
}

/** Resolves the design space into surface pixels (letterboxed, centred). */
interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

function readTransform(surface: Renderer2DLike): Transform {
  const size = surface.size;
  if (size === undefined) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const width = size.width;
  const height = size.height;
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return { scale: 1, offsetX: 0, offsetY: 0 };
  }
  const fitX = width / DESIGN_WIDTH;
  const fitY = height / DESIGN_HEIGHT;
  const scale = fitX < fitY ? fitX : fitY;
  return {
    scale,
    offsetX: (width - DESIGN_WIDTH * scale) / 2,
    offsetY: (height - DESIGN_HEIGHT * scale) / 2,
  };
}

function drawLobby(
  surface: Renderer2DLike,
  state: BombRenderState,
  cache: BombRenderCache,
  transform: Transform,
): void {
  const s = transform.scale;
  const ox = transform.offsetX;
  const oy = transform.offsetY;
  surface.rect(ox + 240 * s, oy + 200 * s, 800 * s, 320 * s, RAISED);
  surface.rect(ox + 244 * s, oy + 204 * s, 792 * s, 312 * s, SURFACE);
  surface.text(
    cache.waiting(state.connectedCount, state.minPlayers),
    ox + 640 * s,
    oy + 330 * s,
    40 * s,
    TEXT,
    "center",
  );
  surface.text(STATIC_LOBBY_LINE, ox + 640 * s, oy + 386 * s, 20 * s, MUTED, "center");
  surface.text(STATIC_LOBBY_HINT, ox + 640 * s, oy + 424 * s, 18 * s, MUTED, "center");
  surface.text(
    cache.connected(state.connectedCount),
    ox + 640 * s,
    oy + 470 * s,
    16 * s,
    ACCENT,
    "center",
  );
}

function drawModuleCard(
  surface: Renderer2DLike,
  x: number,
  y: number,
  heading: string,
  solved: boolean,
  transform: Transform,
): void {
  const s = transform.scale;
  const ox = transform.offsetX;
  const oy = transform.offsetY;
  surface.rect(ox + x * s, oy + y * s, 336 * s, 250 * s, BORDER_COLOR);
  surface.rect(ox + (x + 2) * s, oy + (y + 2) * s, 332 * s, 246 * s, SURFACE);
  surface.text(
    heading,
    ox + (x + 20) * s,
    oy + (y + 36) * s,
    20 * s,
    solved ? SOLVED : TEXT,
  );
}

function drawWires(
  surface: Renderer2DLike,
  bomb: Bomb,
  x: number,
  y: number,
  transform: Transform,
): void {
  const s = transform.scale;
  const ox = transform.offsetX;
  const oy = transform.offsetY;
  const wires = bomb.wires.wires;
  for (let index = 0; index < wires.length; index += 1) {
    const color = wires[index];
    if (color === undefined) continue;
    const top = y + 70 + index * 28;
    surface.rect(ox + (x + 20) * s, oy + top * s, 64 * s, 12 * s, WIRE_HEX[color]);
    surface.text(
      color.toUpperCase(),
      ox + (x + 98) * s,
      oy + (top + 12) * s,
      15 * s,
      TEXT,
    );
  }
  if (bomb.wires.solved) {
    surface.text(STATIC_SOLVED, ox + (x + 316) * s, oy + (y + 36) * s, 14 * s, SOLVED, "right");
  }
}

function drawButtonModule(
  surface: Renderer2DLike,
  state: BombRenderState,
  bomb: Bomb,
  x: number,
  y: number,
  transform: Transform,
): void {
  const s = transform.scale;
  const ox = transform.offsetX;
  const oy = transform.offsetY;
  const centerX = x + 168;
  const centerY = y + 120;
  surface.circle(ox + centerX * s, oy + centerY * s, 46 * s, BUTTON_HEX[bomb.button.color]);
  surface.text(
    bomb.button.color.toUpperCase(),
    ox + centerX * s,
    oy + (centerY + 78) * s,
    18 * s,
    TEXT,
    "center",
  );

  const target = buttonHoldTarget(bomb.button.color);
  const progressTarget = target > 0 ? target : 500;
  const progress =
    state.buttonDown && !bomb.button.solved
      ? Math.min(1, Math.max(0, state.heldMs / progressTarget))
      : 0;
  surface.rect(ox + (x + 48) * s, oy + (y + 208) * s, 240 * s, 8 * s, RAISED);
  if (progress > 0) {
    surface.rect(ox + (x + 48) * s, oy + (y + 208) * s, 240 * progress * s, 8 * s, SOLVED);
  }

  let label = STATIC_PRESS;
  let labelColor = MUTED;
  if (bomb.button.solved) {
    label = STATIC_SOLVED;
    labelColor = SOLVED;
  } else if (state.buttonDown) {
    label = STATIC_RELEASE;
    labelColor = ACCENT;
  }
  surface.text(label, ox + centerX * s, oy + (y + 240) * s, 16 * s, labelColor, "center");
}

function drawKeypad(
  surface: Renderer2DLike,
  bomb: Bomb,
  x: number,
  y: number,
  transform: Transform,
): void {
  const s = transform.scale;
  const ox = transform.offsetX;
  const oy = transform.offsetY;
  const symbols = bomb.keypad.symbols;
  for (let index = 0; index < symbols.length; index += 1) {
    const symbol = symbols[index];
    if (symbol === undefined) continue;
    const left = x + 28 + index * 72;
    surface.rect(ox + left * s, oy + (y + 88) * s, 56 * s, 68 * s, RAISED);
    surface.text(
      symbol,
      ox + (left + 28) * s,
      oy + (y + 132) * s,
      32 * s,
      TEXT,
      "center",
    );
  }
  if (bomb.keypad.solved) {
    surface.text(STATIC_SOLVED, ox + (x + 168) * s, oy + (y + 210) * s, 18 * s, SOLVED, "center");
  }
}

/**
 * Draws one frame. `state` and `cache` are owned by the adapter and reused;
 * this function allocates only when a cached string's source value changes
 * (at most once per displayed second).
 */
export function drawBomb(
  surface: Renderer2DLike,
  state: BombRenderState,
  cache: BombRenderCache,
  alpha: number,
): void {
  const transform = readTransform(surface);
  const s = transform.scale;
  const ox = transform.offsetX;
  const oy = transform.offsetY;

  surface.beginFrame(alpha);
  surface.clear(BACKGROUND);

  surface.text(STATIC_TITLE, ox + 40 * s, oy + 54 * s, 38 * s, TEXT);
  surface.text(STATIC_SUBTITLE, ox + 40 * s, oy + 82 * s, 15 * s, MUTED);
  surface.text(
    cache.time(state.timerMs),
    ox + 1240 * s,
    oy + 58 * s,
    46 * s,
    state.phase === "playing" ? ACCENT : TEXT,
    "right",
  );

  surface.text(
    cache.strikes(state.strikes, state.strikesAllowed),
    ox + 40 * s,
    oy + 122 * s,
    17 * s,
    MUTED,
  );
  for (let index = 0; index < state.strikesAllowed; index += 1) {
    const used = index < state.strikes;
    surface.circle(ox + (240 + index * 26) * s, oy + 116 * s, 9 * s, used ? ACCENT : RAISED);
  }
  surface.text(
    cache.solved(state.solved, BOMB_CONFIG.moduleCount),
    ox + 340 * s,
    oy + 122 * s,
    17 * s,
    state.solved >= BOMB_CONFIG.moduleCount ? SOLVED : MUTED,
  );

  if (state.phase === "lobby" || state.bomb === null) {
    drawLobby(surface, state, cache, transform);
    surface.endFrame();
    return;
  }

  const bomb = state.bomb;
  cache.syncBomb(bomb);

  surface.rect(ox + 40 * s, oy + 140 * s, 1200 * s, 440 * s, RAISED);
  surface.rect(ox + 42 * s, oy + 142 * s, 1196 * s, 436 * s, SURFACE);

  surface.text(cache.serial, ox + 72 * s, oy + 184 * s, 22 * s, TEXT);
  surface.text(cache.batteries, ox + 72 * s, oy + 212 * s, 15 * s, MUTED);
  surface.text(cache.indicators, ox + 72 * s, oy + 234 * s, 15 * s, MUTED);

  drawModuleCard(surface, 72, 280, "WIRES", bomb.wires.solved, transform);
  drawModuleCard(surface, 472, 280, "BUTTON", bomb.button.solved, transform);
  drawModuleCard(surface, 872, 280, "KEYPAD", bomb.keypad.solved, transform);

  drawWires(surface, bomb, 72, 280, transform);
  drawButtonModule(surface, state, bomb, 472, 280, transform);
  drawKeypad(surface, bomb, 872, 280, transform);

  surface.text(cache.defuser(state.defuserSlot), ox + 40 * s, oy + 626 * s, 22 * s, ACCENT);
  surface.text(cache.connected(state.connectedCount), ox + 40 * s, oy + 654 * s, 15 * s, MUTED);
  surface.text(STATIC_MANUAL_HINT, ox + 1240 * s, oy + 654 * s, 15 * s, MUTED, "right");

  if (state.defuserGraceMs >= 0 && state.phase === "playing") {
    surface.rect(ox + 420 * s, oy + 560 * s, 440 * s, 40 * s, ACCENT);
    surface.text(
      cache.grace(state.defuserGraceMs),
      ox + 640 * s,
      oy + 588 * s,
      22 * s,
      ON_ACCENT,
      "center",
    );
  }

  if (state.phase === "countdown") {
    surface.rect(ox + 40 * s, oy + 140 * s, 1200 * s, 440 * s, BACKGROUND);
    surface.text(
      cache.countdown(state.countdownMs),
      ox + 640 * s,
      oy + 380 * s,
      150 * s,
      ACCENT,
      "center",
    );
    surface.text(STATIC_GET_READY, ox + 640 * s, oy + 430 * s, 24 * s, TEXT, "center");
  }

  if (state.phase === "results") {
    const copy = state.cause === null ? RESULT_COPY.timeout : RESULT_COPY[state.cause];
    const titleColor = state.cause === "defused" ? SOLVED : ACCENT;
    surface.rect(ox + 240 * s, oy + 190 * s, 800 * s, 320 * s, RAISED);
    surface.rect(ox + 244 * s, oy + 194 * s, 792 * s, 312 * s, SURFACE);
    surface.text(copy.title, ox + 640 * s, oy + 300 * s, 46 * s, titleColor, "center");
    surface.text(copy.subtitle, ox + 640 * s, oy + 346 * s, 20 * s, TEXT, "center");
    surface.text(
      cache.resultTime(state.resultTimeMs),
      ox + 640 * s,
      oy + 392 * s,
      18 * s,
      MUTED,
      "center",
    );
    surface.text(
      cache.resultStrikes(state.strikes, state.strikesAllowed),
      ox + 640 * s,
      oy + 420 * s,
      18 * s,
      MUTED,
      "center",
    );
    surface.text(STATIC_REMATCH, ox + 640 * s, oy + 462 * s, 18 * s, ACCENT, "center");
    if (state.solved >= BOMB_CONFIG.moduleCount) {
      surface.text(STATIC_MODULES_SOLVED, ox + 640 * s, oy + 240 * s, 16 * s, SOLVED, "center");
    }
  }

  surface.endFrame();
}

/**
 * Coin Run 2D presentation (GAME-PF-05; FR-9.4, PR-9.1, PR-9.3, PR-9.5).
 *
 * The game never touches a canvas. `GameRenderer3D` does not declare the flat
 * 2D surface yet, so this module feature-detects the same flat calls the
 * Canvas2D backend implements (`clear`, `rect`, `circle`, `text`) and draws
 * nothing when the active backend has no 2D surface (the WebGL2 path).
 *
 * Everything is drawn in a world-unit space scaled by `PIXELS_PER_UNIT`
 * (720 design pixels / 18 world units) inside the 1280x720 design space of
 * HP-04. The surface's actual CSS size is feature-detected each frame; one
 * uniform scale plus a centred offset maps that design space onto the surface,
 * so a 1052x592 canvas letterboxes instead of clipping. A surface that does
 * not report a size (a test double or a 3D-only backend) draws 1:1 in design
 * pixels. The camera supplies the horizontal origin; vertical scrolling does
 * not exist. Draw loops use plain `for` statements, cull with
 * `isHorizontallyVisible` and allocate no objects.
 */
import type { GameRenderer3D } from "@lanpad/sdk";
import {
  CAMERA_VIEW_HEIGHT,
  isHorizontallyVisible,
  cameraLeft,
  type CameraState,
} from "./camera.js";
import type { ResultsContent, HudCache } from "./hud.js";
import type { World } from "./world.js";

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
  /** Actual CSS size; the game scales and letterboxes its design space to it. */
  readonly size?: RendererSize;
}

/**
 * Returns the flat drawing surface when the active backend provides one.
 * `Canvas2DRenderer` implements it; `WebGL2Renderer` does not yet.
 */
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

/** Design-space height; the view is exactly the level height. */
export const DESIGN_HEIGHT = 720;
/** World units -> design pixels at the 16:9 profile. */
export const PIXELS_PER_UNIT = DESIGN_HEIGHT / CAMERA_VIEW_HEIGHT;

/** Round-flow phase rendered by the overlay (mirrors the adapter's union). */
export type RenderPhase = "lobby" | "countdown" | "playing" | "results";

/** Everything `drawCoinRun` reads; owned and reused by the game. */
export interface CoinRunRenderState {
  readonly world: World;
  readonly camera: CameraState;
  readonly hud: HudCache;
  readonly phase: RenderPhase;
  readonly elapsedMs: number;
  readonly countdownMs: number;
  readonly results: ResultsContent | null;
  /** One bit per connected slot (bit N = slot N). */
  readonly connectedMask: number;
  /** Per-slot coin contributions indexed by slot - 1. */
  readonly scores: ReadonlyArray<number>;
}

/*
 * Colours are the DESIGN.md `true-black-flat` tokens. The ground stays true
 * black and lime is reserved for the coin, checkpoints and countdown, so the
 * game is the brightest thing on the stage.
 */
const BACKGROUND = "#000000"; // --ground
const SKY_BAND = "#111111"; // --surface
const HORIZON = "#1a1a1a"; // --border
const PLATFORM = "#2a2a2a"; // --raised
const PLATFORM_TOP = "#444444"; // --control
const COIN = "#c6f24e"; // --accent
const COIN_EDGE = "#161616"; // --rule
const CHECKPOINT_OFF = "#444444"; // --control
const CHECKPOINT_ON = "#c6f24e"; // --accent
const GOAL = "#e5484d"; // --negative
const GOAL_POLE = "#b4b4b4"; // --muted
const FOREGROUND = "#ffffff"; // --text
const MUTED = "#b4b4b4"; // --muted
const ACCENT = "#c6f24e"; // --accent
const PLAYER_PATTERN = "#000000"; // --ground
/** DESIGN.md player identity hues 1-4. */
const PLAYER_COLORS = ["#4cb3f0", "#ff9f45", "#c58cff", "#4fd1a1"] as const;

/** Top-left of the HUD block, in design pixels. */
const HUD_X = 24;
const HUD_TOP = 48;

function playerColor(slot: number): string {
  return PLAYER_COLORS[(slot - 1) % PLAYER_COLORS.length] ?? FOREGROUND;
}

/**
 * Draws one frame.
 *
 * Draw order: parallax bands, platforms, checkpoints, coins, goal, players,
 * labels, HUD, phase overlay. `alpha` is forwarded to `beginFrame`; the
 * simulation is fixed-step, so no interpolation state is kept in Minimal.
 *
 * Every coordinate below is design-space; the `scale`/`offsetX`/`offsetY`
 * derivation is the only place the real surface size enters. The letterbox
 * bars stay BACKGROUND because `clear` fills the whole surface.
 */
export function drawCoinRun(
  surface: Renderer2DLike,
  state: CoinRunRenderState,
  alpha: number,
): void {
  const camera = state.camera;
  const world = state.world;
  const designWidth = camera.viewWidth * PIXELS_PER_UNIT;
  const designHeight = DESIGN_HEIGHT;

  const surfaceSize = surface.size;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  if (surfaceSize !== undefined) {
    const surfaceWidth = surfaceSize.width;
    const surfaceHeight = surfaceSize.height;
    if (
      Number.isFinite(surfaceWidth) &&
      surfaceWidth > 0 &&
      Number.isFinite(surfaceHeight) &&
      surfaceHeight > 0
    ) {
      const fitX = surfaceWidth / designWidth;
      const fitY = surfaceHeight / designHeight;
      scale = fitX < fitY ? fitX : fitY;
      offsetX = (surfaceWidth - designWidth * scale) / 2;
      offsetY = (surfaceHeight - designHeight * scale) / 2;
    }
  }
  /** World unit -> surface pixels under that one design-space transform. */
  const unit = PIXELS_PER_UNIT * scale;
  const left = cameraLeft(camera);

  surface.beginFrame(alpha);
  surface.clear(BACKGROUND);

  // Two solid parallax bands; no texture or asset is loaded.
  surface.rect(
    offsetX,
    offsetY + designHeight * 0.45 * scale,
    designWidth * scale,
    designHeight * 0.35 * scale,
    SKY_BAND,
  );
  surface.rect(
    offsetX,
    offsetY + designHeight * 0.8 * scale,
    designWidth * scale,
    designHeight * 0.2 * scale,
    HORIZON,
  );

  const platforms = world.platforms;
  for (let index = 0; index < platforms.length; index += 1) {
    const platform = platforms[index];
    if (platform === undefined) continue;
    if (!isHorizontallyVisible(camera, platform.x + platform.w / 2, platform.w / 2)) {
      continue;
    }
    const x = offsetX + (platform.x - left) * unit;
    const y = offsetY + platform.y * unit;
    surface.rect(x, y, platform.w * unit, platform.h * unit, PLATFORM);
    surface.rect(
      x,
      y,
      platform.w * unit,
      Math.max(2 * scale, 0.12 * unit),
      PLATFORM_TOP,
    );
  }

  const checkpoints = world.checkpoints;
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint === undefined) continue;
    if (!isHorizontallyVisible(camera, checkpoint.x, 1)) continue;
    const color = checkpoint.activated ? CHECKPOINT_ON : CHECKPOINT_OFF;
    const x = offsetX + (checkpoint.x - left) * unit;
    const y = offsetY + checkpoint.y * unit;
    surface.rect(x - 2 * scale, y - 1.5 * unit, 4 * scale, 1.5 * unit, color);
    surface.circle(x, y - 1.7 * unit, 0.22 * unit, color);
  }

  const coins = world.coins;
  for (let index = 0; index < coins.length; index += 1) {
    const coin = coins[index];
    if (coin === undefined || coin.collected) continue;
    if (!isHorizontallyVisible(camera, coin.x, 0.5)) continue;
    const x = offsetX + (coin.x - left) * unit;
    const y = offsetY + coin.y * unit;
    surface.circle(x, y, 0.35 * unit, COIN_EDGE);
    surface.circle(x, y, 0.28 * unit, COIN);
  }

  const goal = world.goal;
  if (isHorizontallyVisible(camera, goal.x + goal.w / 2, goal.w / 2)) {
    const x = offsetX + (goal.x - left) * unit;
    const y = offsetY + goal.y * unit;
    surface.rect(x + 0.15 * unit, y, 4 * scale, goal.h * unit, GOAL_POLE);
    surface.rect(x + 0.15 * unit, y, goal.w * unit, goal.h * 0.55 * unit, GOAL);
  }

  const players = world.players;
  for (let index = 0; index < players.length; index += 1) {
    const player = players[index];
    if (player === undefined || !player.body.active) continue;
    // The world keeps one body per manifest slot; only connected slots are
    // drawn, so a solo player never sees three idle bodies at spawn.
    if ((state.connectedMask & (1 << player.slot)) === 0) continue;
    if (!isHorizontallyVisible(camera, player.body.x, player.body.radius)) continue;
    drawPlayer(
      surface,
      state,
      offsetX + (player.body.x - left) * unit,
      offsetY + player.body.y * unit,
      player.body.radius * unit,
      player.slot,
      scale,
    );
  }

  drawHud(surface, state, designWidth, scale, offsetX, offsetY);
  drawOverlay(surface, state, designWidth, designHeight, scale, offsetX, offsetY);

  surface.endFrame();
}

/** Draws one player; `x`, `y` and `radius` are already surface pixels. */
function drawPlayer(
  surface: Renderer2DLike,
  state: CoinRunRenderState,
  x: number,
  y: number,
  radius: number,
  slot: number,
  scale: number,
): void {
  surface.circle(x, y, radius, playerColor(slot));
  // Inner dot is the non-colour pattern; every slot keeps its label too.
  surface.circle(x, y, radius * 0.34, PLAYER_PATTERN);
  surface.text(
    state.hud.label(slot),
    x,
    y - radius - 8 * scale,
    22 * scale,
    FOREGROUND,
    "center",
  );
}

function drawHud(
  surface: Renderer2DLike,
  state: CoinRunRenderState,
  designWidth: number,
  scale: number,
  offsetX: number,
  offsetY: number,
): void {
  const world = state.world;
  surface.text(
    state.hud.coins(world.coinsCollected, world.coins.length),
    offsetX + HUD_X * scale,
    offsetY + HUD_TOP * scale,
    30 * scale,
    FOREGROUND,
    "left",
  );
  surface.text(
    state.hud.time(state.elapsedMs),
    offsetX + (designWidth - HUD_X) * scale,
    offsetY + HUD_TOP * scale,
    30 * scale,
    FOREGROUND,
    "right",
  );

  const players = world.players;
  let row = 0;
  for (let index = 0; index < players.length; index += 1) {
    const slot = index + 1;
    if ((state.connectedMask & (1 << slot)) === 0) continue;
    const score = state.scores[index] ?? 0;
    surface.text(
      state.hud.playerLine(slot, score),
      offsetX + HUD_X * scale,
      offsetY + (HUD_TOP + 34 + row * 30) * scale,
      24 * scale,
      MUTED,
      "left",
    );
    row += 1;
  }
}

function drawOverlay(
  surface: Renderer2DLike,
  state: CoinRunRenderState,
  designWidth: number,
  designHeight: number,
  scale: number,
  offsetX: number,
  offsetY: number,
): void {
  const center = offsetX + (designWidth * scale) / 2;
  switch (state.phase) {
    case "lobby":
      surface.text(
        "COIN RUN",
        center,
        offsetY + (designHeight / 2 - 90) * scale,
        64 * scale,
        FOREGROUND,
        "center",
      );
      surface.text(
        "Waiting for players",
        center,
        offsetY + (designHeight / 2) * scale,
        40 * scale,
        MUTED,
        "center",
      );
      surface.text(
        "Connect a phone to start",
        center,
        offsetY + (designHeight / 2 + 54) * scale,
        26 * scale,
        MUTED,
        "center",
      );
      break;
    case "countdown": {
      const seconds = Math.max(0, Math.ceil(state.countdownMs / 1000));
      surface.text(
        "Get ready",
        center,
        offsetY + (designHeight / 2 - 110) * scale,
        40 * scale,
        MUTED,
        "center",
      );
      surface.text(
        String(seconds),
        center,
        offsetY + (designHeight / 2 + 70) * scale,
        140 * scale,
        ACCENT,
        "center",
      );
      break;
    }
    case "results": {
      const results = state.results;
      if (results === null) break;
      surface.text(
        results.title,
        center,
        offsetY + 150 * scale,
        56 * scale,
        FOREGROUND,
        "center",
      );
      surface.text(
        results.coinLine,
        center,
        offsetY + 224 * scale,
        36 * scale,
        ACCENT,
        "center",
      );
      surface.text(
        results.timeLine,
        center,
        offsetY + 274 * scale,
        30 * scale,
        MUTED,
        "center",
      );
      let row = 0;
      for (let index = 0; index < results.playerLines.length; index += 1) {
        const line = results.playerLines[index];
        if (line === undefined) continue;
        surface.text(
          line,
          center,
          offsetY + (340 + row * 34) * scale,
          28 * scale,
          FOREGROUND,
          "center",
        );
        row += 1;
      }
      surface.text(
        results.rematchLine,
        center,
        offsetY + (designHeight - 120) * scale,
        30 * scale,
        ACCENT,
        "center",
      );
      surface.text(
        results.backLine,
        center,
        offsetY + (designHeight - 74) * scale,
        24 * scale,
        MUTED,
        "center",
      );
      break;
    }
    case "playing":
    default:
      break;
  }
}

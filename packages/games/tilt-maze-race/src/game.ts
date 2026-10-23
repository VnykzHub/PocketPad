/**
 * Tilt Maze Race host adapter (GAME-TM-HOST-01..05; GAME-TM-CTRL-01..04;
 * D3-SDK-01, ER-24-01, FR-9.1).
 *
 * This is the module the host discovers as `packages/games/<slug>/src/game.ts`:
 * a default `(manifest) => Game` factory. It consumes `GameContext` plus the
 * input snapshot only. The kit owns the match lifecycle, scoreboard, identity
 * and results rows; this adapter owns the maze world, tilt/stick acceleration,
 * layout/panel publication and phase wiring.
 *
 * Round flow:
 *
 *   lobby -> countdown -> playing -> results -> (rematch) countdown/lobby
 *
 * A match starts when `minPlayers` connected slots are present. The roster is
 * frozen at countdown start and every roster ball is placed on its own start.
 * During play the first ball to reach the exit ends the round; the world keeps
 * the slot-ordered finish list for tie-breaking and results. Placement points
 * (8/7/... for finishers, 0 for DNF) feed `resultsRows`.
 *
 * Rematch input has no dedicated button because the Minimal layouts are gyro +
 * stick + status only. Any controller edge or a named `rematch` event asks for
 * another race; so does a fresh stick deflection after a release. A player who
 * keeps holding the stick through the results screen therefore cannot skip it
 * accidentally.
 *
 * Results fall back to the lobby when fewer than `minPlayers` remain, so a room
 * can never wait on an absent player.
 */
import {
  createMatch,
  createScoreboard,
  resultsRows,
  type Match,
  type MatchPhase,
  type ResultsRow,
  type Scoreboard,
} from "@lanpad/game-kit";
import type {
  Game,
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameManifest,
  JsonValue,
} from "@lanpad/sdk";
import {
  SLOT_COUNT,
  TILT_MAZE_LAYOUT_ID,
  TILT_MAZE_REMATCH_EVENT,
  TILT_MAZE_STICK_LAYOUT_ID,
  resolveConfig,
  type TiltMazeConfig,
} from "./config.js";
import { createHud, HUD_TITLE, type TiltMazeHud } from "./hud.js";
import { parseMaze, type Maze } from "./maze.js";
import {
  drawTiltMazeRace,
  resolveRenderer2D,
  type Renderer2DLike,
  type TiltMazeRenderState,
} from "./render.js";
import {
  createAcceleration,
  resolveAcceleration,
  type Acceleration,
} from "./tilt.js";
import { TiltMazeWorld } from "./world.js";
import shippedMazeData from "./maze-classic-v1.json";

/** Optional factory arguments for tests and per-scene tuning. */
export interface TiltMazeGameOptions {
  /** Overrides `config.countdownMs`; 0 starts play on the next tick. */
  readonly countdownMs?: number;
  /** Round wins needed to decide the match; default 1 (single race). */
  readonly roundsToWin?: number;
  /** Config overrides; defaults are the GAME-TM-DATA-02 contract. */
  readonly config?: Partial<TiltMazeConfig>;
  /** Maze document; defaults to the shipped `maze-classic-v1.json`. */
  readonly maze?: unknown;
  /** Use the stick-only layout instead of the gyro-first layout. */
  readonly stickOnly?: boolean;
}

/** The adapter's observable state, used by tests and a debug overlay. */
export interface TiltMazeGame extends Game {
  /** The running maze world after `init`, null before init and after dispose. */
  readonly world: TiltMazeWorld | null;
  readonly phase: MatchPhase;
  /** Completed rounds; 0 during the first countdown. */
  readonly round: number;
  /** Slot that reached the exit first last round, null before results. */
  readonly roundWinnerSlot: number | null;
  /** Slot that reached the match target, null while the match is live. */
  readonly matchWinnerSlot: number | null;
  /** One bit per connected slot (bit N = slot N). */
  readonly connectedMask: number;
  /** Slots whose layout has been requested, in request order. */
  readonly laidOutSlots: readonly number[];
  /** Placement points indexed by slot - 1 (results ranking key). */
  readonly scores: readonly number[];
  /** Ranked rows for the results overlay; empty outside the results phase. */
  readonly results: readonly ResultsRow[];
  /** Slots in finish order for the current/last round; reused by the world. */
  readonly finishOrder: readonly number[];
  readonly minPlayers: number;
  readonly maxPlayers: number;
}

type MutableRenderState = {
  -readonly [K in keyof TiltMazeRenderState]: TiltMazeRenderState[K];
};

const EMPTY_RESULTS: readonly ResultsRow[] = [];
const EMPTY_FINISH_ORDER: readonly number[] = [];

/** Stick magnitude that counts as a deliberate rematch push. */
const REMATCH_STICK_SQ = 0.25;

function isConnectedSlot(player: GameControllerState, maxPlayers: number): boolean {
  return (
    player.connected &&
    Number.isInteger(player.slot) &&
    player.slot >= 1 &&
    player.slot <= maxPlayers
  );
}

function phaseCode(phase: MatchPhase): number {
  return phase === "lobby" ? 0 : phase === "countdown" ? 1 : phase === "playing" ? 2 : 3;
}

/** Parses a maze document, throwing a content-author-facing message on failure. */
function loadMaze(raw: unknown): Maze {
  const validation = parseMaze(raw);
  if (!validation.ok) {
    throw new Error(
      `Tilt Maze Race: invalid maze data:\n- ${validation.errors.join("\n- ")}`,
    );
  }
  return validation.maze;
}

/**
 * Creates the Tilt Maze Race game. The default export matches the frozen
 * `GameModule` shape; the optional second argument exists for tests.
 */
export function createTiltMazeGame(
  manifest: GameManifest,
  options: TiltMazeGameOptions = {},
): TiltMazeGame {
  const config = resolveConfig(options.config);
  const maze = loadMaze(options.maze ?? shippedMazeData);
  const layoutId = options.stickOnly === true ? TILT_MAZE_STICK_LAYOUT_ID : TILT_MAZE_LAYOUT_ID;
  const countdownMs = options.countdownMs ?? config.countdownMs;
  const roundsToWin = options.roundsToWin ?? 1;
  const minPlayers = Math.min(
    SLOT_COUNT,
    Math.max(2, Number.isInteger(manifest.minPlayers) ? manifest.minPlayers : 2),
  );
  const maxPlayers = Math.min(
    SLOT_COUNT,
    Math.max(minPlayers, Number.isInteger(manifest.maxPlayers) ? manifest.maxPlayers : SLOT_COUNT),
  );

  let ctx: GameContext | null = null;
  let world: TiltMazeWorld | null = null;
  let hud: TiltMazeHud | null = null;
  let match: Match | null = null;
  let scoreboard: Scoreboard | null = null;
  let surface: Renderer2DLike | null = null;
  let renderState: MutableRenderState | null = null;
  let disposed = false;

  let clockMs = 0;
  let connectedMask = 0;
  let connectedCount = 0;
  let layoutActiveMask = 0;
  let rosterMask = 0;
  let lastPhase: MatchPhase = "lobby";
  let roundWinner: number | null = null;
  let resultsView: readonly ResultsRow[] = EMPTY_RESULTS;
  let rematchRequested = false;
  let resultsStickMask = 0;

  /** Reused roster feed; pre-sized so `push` never reallocates. */
  const connectedSlots: number[] = [];
  for (let index = 0; index < maxPlayers; index += 1) {
    connectedSlots.push(0);
  }
  connectedSlots.length = 0;

  /** Last panel text pushed per connected slot. */
  const panelSent: string[] = new Array<string>(SLOT_COUNT).fill("");
  /** Last scoreboard value per slot, indexed by slot - 1. */
  const scoreValues: number[] = new Array<number>(SLOT_COUNT).fill(0);
  const laidOutSlots: number[] = [];
  /** One reused acceleration buffer for all slots in one tick. */
  const acceleration: Acceleration = createAcceleration();

  function applyLayout(slot: number): void {
    const host = ctx;
    if (host === null) return;
    laidOutSlots.push(slot);
    try {
      host.layouts.set(slot, layoutId);
    } catch {
      // A layout stub or older host must never break the race.
    }
  }

  function clearLayout(slot: number): void {
    const host = ctx;
    if (host === null) return;
    try {
      host.layouts.clear(slot);
    } catch {
      // The protocol has no layout-clear frame; a stale phone layout is benign.
    }
  }

  /**
   * Reads presence, result-screen rematch intent and layout ownership for this
   * tick. Only connected slots feed the kit match; disconnected slots are
   * cleared once.
   */
  function observePlayers(input: GameInputSnapshot, phase: MatchPhase): void {
    connectedMask = 0;
    connectedCount = 0;
    connectedSlots.length = 0;

    const players = input.players;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      const bit = 1 << player.slot;
      if ((connectedMask & bit) !== 0) continue;
      connectedMask |= bit;
      connectedCount += 1;
      connectedSlots.push(player.slot);

      // Track held sticks in every phase. A player who keeps holding the stick
      // through the results screen must not skip it: only a fresh push after a
      // release (or any button edge) asks for another race. Because the mask is
      // maintained while racing, the first results tick already knows the stick
      // was held before the race ended.
      const stickActive =
        player.lx * player.lx + player.ly * player.ly > REMATCH_STICK_SQ;
      if (phase === "results") {
        if (player.edges !== 0) {
          rematchRequested = true;
        } else if (stickActive && (resultsStickMask & bit) === 0) {
          rematchRequested = true;
        }
      }
      if (stickActive) resultsStickMask |= bit;
      else resultsStickMask &= ~bit;
    }

    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      const bit = 1 << slot;
      if ((connectedMask & bit) !== 0) {
        if ((layoutActiveMask & bit) === 0) {
          layoutActiveMask |= bit;
          panelSent[slot - 1] = "";
          applyLayout(slot);
        }
      } else if ((layoutActiveMask & bit) !== 0) {
        layoutActiveMask &= ~bit;
        panelSent[slot - 1] = "";
        resultsStickMask &= ~bit;
        clearLayout(slot);
        try {
          ctx?.panels.clear(slot);
        } catch {
          // Panel support is optional on older hosts.
        }
      }
    }
  }

  /** Mirrors the connected mask onto roster balls, letting absent balls coast. */
  function syncWorldConnections(): void {
    const gameWorld = world;
    if (gameWorld === null) return;
    for (let slot = 1; slot <= gameWorld.balls.length; slot += 1) {
      if (!gameWorld.participates(slot)) continue;
      gameWorld.setConnected(slot, (connectedMask & (1 << slot)) !== 0);
    }
  }

  /** Turns each holding player's tilt/stick into acceleration for this tick. */
  function applyPlayerInput(input: GameInputSnapshot): void {
    const gameWorld = world;
    if (gameWorld === null) return;
    const players = input.players;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      if (!gameWorld.participates(player.slot)) continue;
      resolveAcceleration(player, config, acceleration);
      gameWorld.setAcceleration(player.slot, acceleration.ax, acceleration.ay);
    }
  }

  function syncScores(): void {
    const board = scoreboard;
    if (board === null) return;
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      scoreValues[slot - 1] = board.get(slot);
    }
  }

  /** Placement points: 8 for first, down to 1, zero for a DNF. */
  function syncFinishScores(): void {
    const board = scoreboard;
    const gameWorld = world;
    if (board === null || gameWorld === null) return;
    board.reset();
    for (let slot = 1; slot <= gameWorld.balls.length; slot += 1) {
      if (!gameWorld.participates(slot)) continue;
      const ball = gameWorld.ball(slot);
      const finished = ball !== undefined && ball.finished && ball.finishRank > 0;
      board.set(slot, finished && ball !== undefined ? SLOT_COUNT - ball.finishRank + 1 : 0);
    }
    syncScores();
  }

  /**
   * Runs the world-side effect of one match phase change. Balls are placed at
   * countdown start so the TV shows the course and each start immediately.
   */
  function handlePhaseChange(next: MatchPhase): void {
    const gameWorld = world;
    const board = scoreboard;
    if (gameWorld === null || board === null) {
      lastPhase = next;
      return;
    }

    if (next === "countdown") {
      rosterMask = connectedMask;
      roundWinner = null;
      resultsStickMask = 0;
      board.reset();
      syncScores();
      gameWorld.startRace(rosterMask);
    } else if (next === "results") {
      syncFinishScores();
      resultsView = resultsRows(board.ranked, roundWinner);
    } else if (next === "lobby") {
      gameWorld.reset();
      roundWinner = null;
      rosterMask = 0;
      resultsStickMask = 0;
      board.reset();
      syncScores();
      resultsView = EMPTY_RESULTS;
    }
    lastPhase = next;
  }

  function updateHud(): void {
    const gameWorld = world;
    const cache = hud;
    const currentMatch = match;
    if (gameWorld === null || cache === null || currentMatch === null) return;
    const displayRound =
      currentMatch.phase === "countdown" ? currentMatch.round + 1 : currentMatch.round;
    cache.update(
      gameWorld,
      currentMatch.phase,
      displayRound,
      currentMatch.countdownRemainingMs,
      connectedMask,
      currentMatch.winnerSlot,
      roundWinner,
    );
  }

  /** Pushes private panel text, but only when the cached string changed. */
  function publishPanels(): void {
    const host = ctx;
    const cache = hud;
    if (host === null || cache === null) return;
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      const index = slot - 1;
      if ((connectedMask & (1 << slot)) !== 0) {
        const text = cache.panelTexts[index] ?? "";
        if (text === panelSent[index]) continue;
        panelSent[index] = text;
        try {
          host.panels.set(slot, { kind: "text", title: HUD_TITLE, text });
        } catch {
          // Panel support is optional on older hosts.
        }
      } else if (panelSent[index] !== "") {
        panelSent[index] = "";
        try {
          host.panels.clear(slot);
        } catch {
          // Panel support is optional on older hosts.
        }
      }
    }
  }

  function updateDebug(host: GameContext, currentMatch: Match): void {
    const gameWorld = world;
    host.debug.setCounter("tm.phase", phaseCode(currentMatch.phase));
    host.debug.setCounter("tm.balls", gameWorld?.participantCount ?? 0);
    host.debug.setCounter("tm.steps", gameWorld?.stepCount ?? 0);
    host.debug.setCounter("tm.finishes", gameWorld?.finishOrder.length ?? 0);
    host.debug.setCounter("tm.connected", connectedCount);
  }

  const game: TiltMazeGame = {
    manifest,

    init(host: GameContext): void {
      disposed = false;
      ctx = host;

      const worldInstance = new TiltMazeWorld(maze, config);
      const hudInstance = createHud();
      const board = createScoreboard();
      const matchInstance = createMatch({
        minPlayers,
        maxPlayers,
        countdownMs,
        roundsToWin,
      });

      world = worldInstance;
      hud = hudInstance;
      scoreboard = board;
      match = matchInstance;
      surface = resolveRenderer2D(host.renderer);

      clockMs = 0;
      connectedMask = 0;
      connectedCount = 0;
      layoutActiveMask = 0;
      rosterMask = 0;
      lastPhase = "lobby";
      roundWinner = null;
      rematchRequested = false;
      resultsStickMask = 0;
      connectedSlots.length = 0;
      panelSent.fill("");
      scoreValues.fill(0);
      laidOutSlots.length = 0;

      resultsView = EMPTY_RESULTS;
      renderState = {
        world: worldInstance,
        hud: hudInstance,
        phase: "lobby",
        countdownRemainingMs: 0,
        matchWinner: null,
      };
    },

    simulate(dt: number, input: GameInputSnapshot): void {
      const host = ctx;
      const gameWorld = world;
      const currentMatch = match;
      if (
        disposed ||
        host === null ||
        gameWorld === null ||
        currentMatch === null ||
        scoreboard === null ||
        hud === null
      ) {
        return;
      }

      const stepMs = Number.isFinite(dt) && dt > 0 ? dt * 1000 : 0;
      clockMs += stepMs;

      observePlayers(input, currentMatch.phase);

      currentMatch.update(clockMs, connectedSlots);
      if (currentMatch.phase === "lobby") {
        currentMatch.start(clockMs);
      }

      let phase = currentMatch.phase;
      if (phase !== lastPhase) {
        handlePhaseChange(phase);
      }

      if (phase === "playing") {
        syncWorldConnections();
        applyPlayerInput(input);
        gameWorld.step(stepMs / 1000);
        if (gameWorld.finishOrder.length > 0) {
          roundWinner = gameWorld.finishOrder[0] ?? null;
          currentMatch.finishRound(roundWinner);
          phase = currentMatch.phase;
          handlePhaseChange(phase);
        }
      }

      if (phase === "results") {
        if (connectedCount < minPlayers) {
          // Nobody left to ask for a rematch: fall back to the lobby.
          currentMatch.reset();
          phase = currentMatch.phase;
          handlePhaseChange(phase);
          rematchRequested = false;
        } else if (rematchRequested) {
          currentMatch.nextRound(clockMs);
          phase = currentMatch.phase;
          handlePhaseChange(phase);
        }
      }
      rematchRequested = false;

      syncWorldConnections();
      updateHud();
      publishPanels();
      syncScores();

      if (renderState !== null) {
        renderState.phase = currentMatch.phase;
        renderState.countdownRemainingMs = currentMatch.countdownRemainingMs;
        renderState.matchWinner = currentMatch.winnerSlot;
      }
      updateDebug(host, currentMatch);
    },

    render(alpha: number): void {
      if (disposed || renderState === null || surface === null) return;
      drawTiltMazeRace(surface, renderState, alpha);
    },

    onEvent(slot: number, name: string, data: JsonValue): void {
      void slot;
      void data;
      if (disposed) return;
      if (name === TILT_MAZE_REMATCH_EVENT) {
        rematchRequested = true;
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      world = null;
      hud = null;
      match = null;
      scoreboard = null;
      surface = null;
      renderState = null;
      ctx = null;
      connectedMask = 0;
      connectedCount = 0;
      layoutActiveMask = 0;
      rosterMask = 0;
      rematchRequested = false;
      resultsStickMask = 0;
      connectedSlots.length = 0;
      resultsView = EMPTY_RESULTS;
    },

    get world(): TiltMazeWorld | null {
      return world;
    },

    get phase(): MatchPhase {
      return match?.phase ?? "lobby";
    },

    get round(): number {
      return match?.round ?? 0;
    },

    get roundWinnerSlot(): number | null {
      return roundWinner;
    },

    get matchWinnerSlot(): number | null {
      return match?.winnerSlot ?? null;
    },

    get connectedMask(): number {
      return connectedMask;
    },

    get laidOutSlots(): readonly number[] {
      return laidOutSlots;
    },

    get scores(): readonly number[] {
      return scoreValues;
    },

    get results(): readonly ResultsRow[] {
      return resultsView;
    },

    get finishOrder(): readonly number[] {
      return world?.finishOrder ?? EMPTY_FINISH_ORDER;
    },

    get minPlayers(): number {
      return minPlayers;
    },

    get maxPlayers(): number {
      return maxPlayers;
    },
  };

  return game;
}

/** Frozen `GameModule` shape consumed by the host loader. */
export default createTiltMazeGame;

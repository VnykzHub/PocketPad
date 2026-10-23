/**
 * Snake Royale host adapter (GAME-SR-HOST-01..05; D3-SDK-01, FR-9.1).
 *
 * This is the module `loadGame` imports from `game.manifest.json`: a default
 * `(manifest) => Game` factory. It consumes `GameContext` plus the input
 * snapshot only. The kit owns the match lifecycle, the scoreboard, player
 * identity, the food object pool and results presentation; this adapter owns
 * the grid world, layout/panel publication and phase wiring.
 *
 * Round flow:
 *
 *   lobby -> countdown -> playing -> results -> (rematch) countdown
 *
 * A match starts when `minPlayers` connected slots are present. During the
 * countdown the roster is frozen from the connected mask and every roster
 * snake is spawned on the spaced ring; a disconnect during the countdown is
 * handled by the kit, which returns the match to the lobby. During play a
 * disconnected snake keeps its direction until the 5 s grace expires
 * (GAME-SR-HOST-05); reconnecting inside the window resumes control.
 *
 * Results accept any d-pad edge or a named `rematch` event. If fewer than
 * `minPlayers` remain connected, the results screen resets to the lobby on its
 * own, so a room can never be stuck waiting on an absent player.
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
  ACTION_EDGE_MASK,
  SNAKE_DPAD_LAYOUT_ID,
  SNAKE_ROYALE_CONFIG,
  readEdgeDirection,
} from "./config.js";
import { HUD_TITLE, HudCache } from "./hud.js";
import {
  drawSnakeRoyale,
  resolveRenderer2D,
  type Renderer2DLike,
  type SnakeRoyaleRenderState,
} from "./render.js";
import { SnakeWorld, type SnakeWorldOptions } from "./world.js";

/** Countdown length before the first round and after a rematch. */
export const SNAKE_ROYALE_COUNTDOWN_MS = SNAKE_ROYALE_CONFIG.countdownMs;

const SLOT_COUNT = SNAKE_ROYALE_CONFIG.maxPlayers;
const EMPTY_RESULTS: readonly ResultsRow[] = [];

/** Optional factory arguments for tests and per-scene tuning. */
export interface SnakeRoyaleGameOptions {
  /** Overrides `SNAKE_ROYALE_COUNTDOWN_MS`; 0 starts play immediately. */
  readonly countdownMs?: number;
  /** Round wins needed to decide the match; default 1 (single round). */
  readonly roundsToWin?: number;
  /** Grid/timing overrides; defaults are the GAME-SR-DATA-01 contract. */
  readonly world?: SnakeWorldOptions;
}

/** The adapter's observable state, used by tests and a debug overlay. */
export interface SnakeRoyaleGame extends Game {
  /** The running grid world after `init`, null before init and after dispose. */
  readonly world: SnakeWorld | null;
  readonly phase: MatchPhase;
  /** Completed rounds; 0 during the first countdown. */
  readonly round: number;
  /** Slot that survived the last round, null for a draw or before results. */
  readonly roundWinnerSlot: number | null;
  /** Slot that reached the match target, null while the match is live. */
  readonly matchWinnerSlot: number | null;
  /** One bit per connected slot (bit N = slot N). */
  readonly connectedMask: number;
  /** Slots whose layout has been requested, in request order. */
  readonly laidOutSlots: readonly number[];
  /** Per-slot round length indexed by slot - 1 (the results ranking key). */
  readonly scores: readonly number[];
  /** Ranked rows for the results overlay; empty outside the results phase. */
  readonly results: readonly ResultsRow[];
  readonly minPlayers: number;
  readonly maxPlayers: number;
}

type MutableRenderState = {
  -readonly [K in keyof SnakeRoyaleRenderState]: SnakeRoyaleRenderState[K];
};

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

/**
 * Creates the Snake Royale game. The default export is the frozen
 * `GameModule` shape; the optional second argument exists for tests.
 */
export function createSnakeRoyaleGame(
  manifest: GameManifest,
  options: SnakeRoyaleGameOptions = {},
): SnakeRoyaleGame {
  const minPlayers = Math.min(
    SLOT_COUNT,
    Math.max(2, Number.isInteger(manifest.minPlayers) ? manifest.minPlayers : 2),
  );
  const maxPlayers = Math.min(
    SLOT_COUNT,
    Math.max(minPlayers, Number.isInteger(manifest.maxPlayers) ? manifest.maxPlayers : SLOT_COUNT),
  );
  const countdownMs = options.countdownMs ?? SNAKE_ROYALE_CONFIG.countdownMs;
  const roundsToWin = options.roundsToWin ?? 1;
  const worldOptions: SnakeWorldOptions = options.world ?? {};

  let ctx: GameContext | null = null;
  let world: SnakeWorld | null = null;
  let hud: HudCache | null = null;
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

  /** Reused roster feed; pre-sized so `push` never reallocates. */
  const connectedSlots: number[] = [];
  for (let index = 0; index < maxPlayers; index += 1) {
    connectedSlots.push(0);
  }
  connectedSlots.length = 0;

  /** Press edges per slot for this tick (index 0 unused). */
  const edgeBySlot = new Int32Array(SLOT_COUNT + 1);
  /** Last panel text pushed per connected slot. */
  const panelSent: string[] = new Array<string>(SLOT_COUNT).fill("");
  /** Last scoreboard value per slot, indexed by slot - 1. */
  const scoreValues: number[] = new Array<number>(SLOT_COUNT).fill(0);
  const laidOutSlots: number[] = [];

  function applyLayout(slot: number): void {
    const host = ctx;
    if (host === null) return;
    laidOutSlots.push(slot);
    try {
      host.layouts.set(slot, SNAKE_DPAD_LAYOUT_ID);
    } catch {
      // A layout stub or older host must never break the match.
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
   * Reads presence, one-press edges and layout ownership for this tick. Only
   * connected slots feed the kit match; disconnected slots are cleared once.
   */
  function observePlayers(input: GameInputSnapshot, phase: MatchPhase): void {
    connectedMask = 0;
    connectedCount = 0;
    connectedSlots.length = 0;
    edgeBySlot.fill(0);

    const players = input.players;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      const bit = 1 << player.slot;
      if ((connectedMask & bit) !== 0) continue;
      connectedMask |= bit;
      connectedCount += 1;
      connectedSlots.push(player.slot);
      edgeBySlot[player.slot] = player.edges;
    }

    const gameWorld = world;
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      const bit = 1 << slot;
      if ((connectedMask & bit) !== 0) {
        if ((layoutActiveMask & bit) === 0) {
          layoutActiveMask |= bit;
          panelSent[slot - 1] = "";
          applyLayout(slot);
        }
        if (phase === "playing" && gameWorld !== null && gameWorld.participates(slot)) {
          const direction = readEdgeDirection(edgeBySlot[slot] ?? 0);
          if (direction !== null) gameWorld.queueTurn(slot, direction);
        }
        if (phase === "results" && ((edgeBySlot[slot] ?? 0) & ACTION_EDGE_MASK) !== 0) {
          rematchRequested = true;
        }
      } else if ((layoutActiveMask & bit) !== 0) {
        layoutActiveMask &= ~bit;
        panelSent[slot - 1] = "";
        clearLayout(slot);
        try {
          ctx?.panels.clear(slot);
        } catch {
          // Panel support is optional on older hosts.
        }
      }
    }
  }

  /** Mirrors the connected mask onto roster snakes, starting their grace clock. */
  function syncWorldConnections(): void {
    const gameWorld = world;
    if (gameWorld === null) return;
    for (let slot = 1; slot <= gameWorld.snakes.length; slot += 1) {
      if (!gameWorld.participates(slot)) continue;
      gameWorld.setConnected(slot, (connectedMask & (1 << slot)) !== 0);
    }
  }

  function syncScores(): void {
    const board = scoreboard;
    if (board === null) return;
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      scoreValues[slot - 1] = board.get(slot);
    }
  }

  /** Publishes every roster snake's current length as its round score. */
  function syncScoreboardLengths(): void {
    const board = scoreboard;
    const gameWorld = world;
    if (board === null || gameWorld === null) return;
    for (let slot = 1; slot <= gameWorld.snakes.length; slot += 1) {
      if (!gameWorld.participates(slot)) continue;
      const snake = gameWorld.snakes[slot - 1];
      if (snake !== undefined) board.set(slot, snake.length);
    }
    syncScores();
  }

  /**
   * Runs the world-side effect of one match phase change. Roster spawns at
   * countdown start, so the phone panels can show GET READY immediately and
   * the board is already populated when play begins.
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
      board.reset();
      gameWorld.startRound(rosterMask);
      syncScoreboardLengths();
    } else if (next === "results") {
      syncScoreboardLengths();
      resultsView = resultsRows(board.ranked, roundWinner);
    } else if (next === "lobby") {
      gameWorld.reset();
      roundWinner = null;
      rosterMask = 0;
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
      connectedCount,
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
    host.debug.setCounter("snake.phase", phaseCode(currentMatch.phase));
    host.debug.setCounter("snake.alive", gameWorld?.aliveCount ?? 0);
    host.debug.setCounter("snake.steps", gameWorld?.stepCount ?? 0);
    host.debug.setCounter("snake.food", gameWorld?.activeFoodCount ?? 0);
    host.debug.setCounter("snake.connected", connectedCount);
  }

  const game: SnakeRoyaleGame = {
    manifest,

    init(host: GameContext): void {
      disposed = false;
      ctx = host;

      const worldInstance = new SnakeWorld(
        (min, max) => host.rng.int(min, max),
        worldOptions,
      );
      const hudInstance = new HudCache(maxPlayers);
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
      connectedSlots.length = 0;
      edgeBySlot.fill(0);
      panelSent.fill("");
      scoreValues.fill(0);
      laidOutSlots.length = 0;

      resultsView = resultsRows(board.ranked, null);
      renderState = {
        world: worldInstance,
        hud: hudInstance,
        phase: "lobby",
        countdownRemainingMs: 0,
        matchWinner: null,
        results: resultsView,
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
        gameWorld.update(stepMs);
        syncScoreboardLengths();
        if (gameWorld.aliveCount <= 1) {
          roundWinner = gameWorld.winnerSlot();
          currentMatch.finishRound(roundWinner);
          phase = currentMatch.phase;
          handlePhaseChange(phase);
        }
      }

      if (phase === "results") {
        if (connectedCount < minPlayers) {
          // Nobody left to press rematch: fall back to the lobby.
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
        renderState.results = resultsView;
      }
      updateDebug(host, currentMatch);
    },

    render(alpha: number): void {
      if (disposed || renderState === null || surface === null) return;
      drawSnakeRoyale(surface, renderState, alpha);
    },

    onEvent(slot: number, name: string, data: JsonValue): void {
      void slot;
      void data;
      if (disposed) return;
      if (name === "rematch") {
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
      connectedSlots.length = 0;
      resultsView = EMPTY_RESULTS;
    },

    get world(): SnakeWorld | null {
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

    get minPlayers(): number {
      return minPlayers;
    },

    get maxPlayers(): number {
      return maxPlayers;
    },
  };

  return game;
}

/** Frozen `GameModule` shape consumed by `loadGame`. */
export default createSnakeRoyaleGame;

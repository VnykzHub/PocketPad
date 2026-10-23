/**
 * Draw and Guess host adapter (GAME-DG-HOST-01..06; D3-SDK-01, FR-9.1).
 *
 * This is the module the runtime imports for `game.manifest.json`: a default
 * `(manifest) => Game` factory. It consumes `GameContext` plus the input
 * snapshot and nothing else. The kit owns the match lifecycle, the match
 * scoreboard, player identity, the word pack shuffle, the private-panel
 * helpers and the results rows; this adapter owns:
 *
 * - drawer rotation over the frozen roster (`roster[round % roster.length]`),
 * - the secret word's private panel and the results reveal,
 * - guess normalization, the first-correct rule and the per-round guess cap,
 * - host-side stroke grouping (sanitized/clamped in `strokes.ts`),
 * - the 20 s drawer-reconnect pause and the round skip,
 * - role layout hot-swaps for only the slots whose role changed,
 * - the 3-round match and the rematch request.
 *
 * Flow per round:
 *
 *   countdown (drawer sees the word, phone layouts applied)
 *     -> playing (canvas events from the drawer, text events from guessers)
 *     -> results (word revealed; intermediate rounds auto-advance)
 *     -> countdown ... ; after round 3 -> final results -> rematch
 *
 * Privacy: the word is pushed only to the drawer's private panel and is
 * rendered on TV only once `revealWord` is set at results. Guesses are never
 * echoed to a panel or the TV and never persisted (SR-13).
 *
 * All inputs go through the kit's `onCanvas`/`onText`/`onChoice` helpers,
 * which subscribe to named events. The runtime dispatches those before the
 * tick's `simulate`; this adapter does not implement `onEvent` so an event is
 * never handled twice.
 */
import {
  createMatch,
  createPack,
  createScoreboard,
  onCanvas,
  onChoice,
  onText,
  playerLabel,
  resultsRows,
  type Match,
  type MatchPhase,
  type Pack,
  type ResultsRow,
  type Scoreboard,
} from "@lanpad/game-kit";
import {
  sanitizeText,
  type Game,
  type GameContext,
  type GameControllerState,
  type GameInputSnapshot,
  type GameManifest,
  type JsonValue,
} from "@lanpad/sdk";
import {
  DG_CONFIG,
  DG_DEFAULT_SEED,
  DG_DRAWER_LAYOUT_ID,
  DG_GUESSER_LAYOUT_ID,
  DG_RESULTS_LAYOUT_ID,
} from "./config.js";
import {
  drawDrawAndGuess,
  resolveRenderer2D,
  type DrawGuessRenderState,
  type Renderer2DLike,
} from "./render.js";
import { StrokeStore } from "./strokes.js";
import { loadShippedWordPack, normalizeWord, type WordPack } from "./words.js";

const SLOT_COUNT = DG_CONFIG.maxPlayers;
const EMPTY_RESULTS: readonly ResultsRow[] = [];
const EMPTY_LINES: readonly string[] = [];
/** Sentinel for "no cache yet"; any real signature differs. */
const UNSENT = Number.MIN_SAFE_INTEGER;

/** Parsed once at module load; a broken pack fails fast, not mid-match. */
const SHIPPED_PACK: WordPack = loadShippedWordPack();

/** Optional factory arguments for tests and per-scene tuning. */
export interface DrawAndGuessGameOptions {
  /** Overrides the countdown length; 0 starts play on the next tick. */
  readonly countdownMs?: number;
  /** Overrides the intermediate-results hold; 0 advances on the next tick. */
  readonly resultsHoldMs?: number;
  /** Overrides the drawer-disconnect grace; tests use a short value. */
  readonly reconnectPauseMs?: number;
  /** Test-only word source; production always uses the shipped pack. */
  readonly words?: readonly string[];
  /** Overrides the host rng seed for a reproducible shuffle. */
  readonly seed?: number;
}

/** The adapter's observable state, used by tests and a debug overlay. */
export interface DrawAndGuessGame extends Game {
  readonly phase: MatchPhase;
  /** Round being shown or played, 1..3; 0 in the lobby. */
  readonly roundNumber: number;
  readonly rounds: number;
  /** Slot drawing this round, 0 before the first round. */
  readonly drawerSlot: number;
  /** Secret word for the current round; empty in the lobby. */
  readonly currentWord: string;
  /** One bit per connected slot (bit N = slot N). */
  readonly connectedMask: number;
  /** Slots frozen at match start, ascending. */
  readonly roster: readonly number[];
  /** Points per slot indexed by slot - 1. */
  readonly scores: readonly number[];
  /** Ranked rows during results; empty otherwise. */
  readonly results: readonly ResultsRow[];
  /** Slot that solved the round first, null if unresolved. */
  readonly firstCorrectSlot: number | null;
  /** True once round 3 has ended; the next action is a rematch. */
  readonly finalResults: boolean;
  readonly strokeCount: number;
  readonly strokePointCount: number;
  /** Distinct accepted guesses this round (all players). */
  readonly guessCount: number;
  /** Milliseconds left in the drawer-disconnect pause; 0 when not paused. */
  readonly drawerPauseRemainingMs: number;
  /** Slots whose layout has been requested, in request order. */
  readonly laidOutSlots: readonly number[];
  readonly minPlayers: number;
  readonly maxPlayers: number;
}

type MutableRenderState = {
  -readonly [K in keyof DrawGuessRenderState]: DrawGuessRenderState[K];
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

function durationMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Resolves the test word override or the shipped pack's items. */
function selectWords(override: readonly string[] | undefined): readonly string[] {
  if (override === undefined || override.length === 0) return SHIPPED_PACK.items;
  const cleaned: string[] = [];
  for (let index = 0; index < override.length; index += 1) {
    const word = override[index];
    if (typeof word === "string" && word.length > 0) cleaned.push(word);
  }
  return cleaned.length > 0 ? cleaned : SHIPPED_PACK.items;
}

/**
 * Creates the Draw and Guess game. The default export is the frozen
 * `GameModule` shape; the optional second argument exists for tests.
 */
export function createDrawAndGuessGame(
  manifest: GameManifest,
  options: DrawAndGuessGameOptions = {},
): DrawAndGuessGame {
  const minPlayers = Math.min(
    SLOT_COUNT,
    Math.max(2, Number.isInteger(manifest.minPlayers) ? manifest.minPlayers : 2),
  );
  const maxPlayers = Math.min(
    SLOT_COUNT,
    Math.max(minPlayers, Number.isInteger(manifest.maxPlayers) ? manifest.maxPlayers : SLOT_COUNT),
  );
  const rounds = DG_CONFIG.rounds;
  const countdownMs = durationMs(options.countdownMs, DG_CONFIG.countdownMs);
  const resultsHoldMs = durationMs(options.resultsHoldMs, DG_CONFIG.resultsHoldMs);
  const reconnectPauseMs = durationMs(options.reconnectPauseMs, DG_CONFIG.reconnectPauseMs);
  const wordSource = selectWords(options.words);

  let ctx: GameContext | null = null;
  let match: Match | null = null;
  let scoreboard: Scoreboard | null = null;
  let pack: Pack<string> | null = null;
  let strokes: StrokeStore | null = null;
  let surface: Renderer2DLike | null = null;
  let renderState: MutableRenderState | null = null;
  let disposed = false;

  let unsubCanvas: (() => void) | null = null;
  let unsubText: (() => void) | null = null;
  let unsubChoice: (() => void) | null = null;

  let clockMs = 0;
  let connectedMask = 0;
  let connectedCount = 0;
  let layoutActiveMask = 0;
  let lastPhase: MatchPhase = "lobby";

  let roundsPlayed = 0;
  let roundNumber = 0;
  let drawerSlot = 0;
  let currentWord = "";
  let currentWordNormalized = "";
  let guessesThisRound = 0;
  let firstCorrectSlot: number | null = null;
  let lastRoundMessage = "";

  let drawerAway = false;
  let drawerPauseMs = 0;

  let resultsElapsedMs = 0;
  let finalResults = false;
  let winnerSlot: number | null = null;
  let resultsView: readonly ResultsRow[] = EMPTY_RESULTS;
  let resultPanelText = "";
  let advanceRequested = false;
  let rematchRequested = false;

  let lastHudKey = UNSENT;

  /** Reused connected-slot feed handed to `Match.update`. */
  const connectedSlots: number[] = [];
  /** Slots frozen at match start, ascending; owned by this adapter. */
  const rosterSlots: number[] = [];
  /** One normalized-guess set per slot, cleared each round. */
  const guessedBySlot: Set<string>[] = [];
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    guessedBySlot.push(new Set<string>());
  }
  /** Last layout id requested per slot; "" means no request yet. */
  const layoutBySlot: string[] = new Array<string>(SLOT_COUNT).fill("");
  /** Last panel signature per slot; UNSENT forces a publish. */
  const panelSignature: number[] = new Array<number>(SLOT_COUNT).fill(UNSENT);
  /** Points per slot for the test/debug view, indexed by slot - 1. */
  const scoreValues: number[] = new Array<number>(SLOT_COUNT).fill(0);
  /** Ranked score lines for the results frame; rebuilt at results entry. */
  const resultLines: string[] = [];
  const laidOutSlots: number[] = [];

  function releaseSubscriptions(): void {
    if (unsubCanvas !== null) {
      unsubCanvas();
      unsubCanvas = null;
    }
    if (unsubText !== null) {
      unsubText();
      unsubText = null;
    }
    if (unsubChoice !== null) {
      unsubChoice();
      unsubChoice = null;
    }
  }

  function isConnected(slot: number): boolean {
    return slot >= 1 && slot <= maxPlayers && (connectedMask & (1 << slot)) !== 0;
  }

  function isRosterSlot(slot: number): boolean {
    for (let index = 0; index < rosterSlots.length; index += 1) {
      if (rosterSlots[index] === slot) return true;
    }
    return false;
  }

  function rosterConnected(): boolean {
    for (let index = 0; index < rosterSlots.length; index += 1) {
      const slot = rosterSlots[index];
      if (slot === undefined || (connectedMask & (1 << slot)) === 0) return false;
    }
    return true;
  }

  function pauseSeconds(): number {
    if (!drawerAway || reconnectPauseMs <= 0) return 0;
    return Math.max(0, Math.ceil((reconnectPauseMs - drawerPauseMs) / 1000));
  }

  function clearSlotHostState(slot: number): void {
    const host = ctx;
    if (host === null) return;
    try {
      host.layouts.clear(slot);
    } catch {
      // The protocol has no layout-clear frame; a stale phone layout is benign.
    }
    try {
      host.panels.clear(slot);
    } catch {
      // Panel support is optional on older hosts.
    }
  }

  /**
   * Reads presence for this tick and maintains layout/panel caches. Only
   * connected slots feed the kit match; leaving a slot clears its host state
   * exactly once.
   */
  function observePlayers(input: GameInputSnapshot): void {
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
    }

    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      const bit = 1 << slot;
      const index = slot - 1;
      if ((connectedMask & bit) !== 0) {
        if ((layoutActiveMask & bit) === 0) {
          layoutActiveMask |= bit;
          layoutBySlot[index] = "";
          panelSignature[index] = UNSENT;
        }
      } else if ((layoutActiveMask & bit) !== 0) {
        layoutActiveMask &= ~bit;
        layoutBySlot[index] = "";
        panelSignature[index] = UNSENT;
        clearSlotHostState(slot);
      }
    }
  }

  function desiredLayoutFor(slot: number, phase: MatchPhase): string {
    if (phase === "results" && finalResults) return DG_RESULTS_LAYOUT_ID;
    if (phase === "lobby") return DG_GUESSER_LAYOUT_ID;
    return slot === drawerSlot ? DG_DRAWER_LAYOUT_ID : DG_GUESSER_LAYOUT_ID;
  }

  /** Requests a layout only when the slot's desired id changed. */
  function publishLayouts(phase: MatchPhase): void {
    const host = ctx;
    if (host === null) return;
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if (!isConnected(slot)) continue;
      const index = slot - 1;
      const desired = desiredLayoutFor(slot, phase);
      if (layoutBySlot[index] === desired) continue;
      layoutBySlot[index] = desired;
      laidOutSlots.push(slot);
      try {
        host.layouts.set(slot, desired);
      } catch {
        // A layout stub or older host must never break the match.
      }
    }
  }

  /** Changes only when the corresponding panel copy changes. */
  function panelSignatureFor(slot: number, phase: MatchPhase): number {
    let key =
      phaseCode(phase) |
      ((roundNumber & 0xff) << 4) |
      ((drawerSlot & 0xf) << 12);
    if (phase === "lobby") key |= (connectedCount & 0xf) << 16;
    if (phase === "results") key |= (finalResults ? 1 : 0) << 16;
    if (phase === "playing" && slot !== drawerSlot) {
      key |= 1 << 16;
      if (drawerAway) {
        key |= 1 << 17;
        key |= (pauseSeconds() & 0x3f) << 18;
      }
    }
    if (isRosterSlot(slot)) key |= 1 << 24;
    return key;
  }

  function panelTitleFor(slot: number, phase: MatchPhase): string {
    if (phase === "lobby") return "Draw and Guess";
    if (phase === "results") return finalResults ? "Final results" : "Round over";
    if (!isRosterSlot(slot)) return "Draw and Guess";
    if (phase === "countdown") return slot === drawerSlot ? "Your word" : "Get ready";
    if (slot === drawerSlot) return "Your word";
    return drawerAway ? "Drawer away" : "Guess the drawing";
  }

  function panelTextFor(slot: number, phase: MatchPhase): string {
    if (phase === "lobby") {
      return `Waiting for players (${connectedCount}/${minPlayers}).\n\nDraw it. Guess it.`;
    }
    if (phase === "results") return resultPanelText;
    if (!isRosterSlot(slot)) {
      return "You joined mid-match.\nYou'll play in the next match.";
    }
    if (phase === "countdown") {
      if (slot === drawerSlot) {
        return `Round ${roundNumber} of ${rounds}\nYour word: ${currentWord}\n\nGet ready to draw!`;
      }
      return `Round ${roundNumber} of ${rounds}\n${playerLabel(drawerSlot)} draws next.\nGet your guesses ready.`;
    }
    if (slot === drawerSlot) {
      return `Round ${roundNumber} of ${rounds}\nYour word: ${currentWord}\n\nDraw it on the canvas below.`;
    }
    if (drawerAway) {
      return `${playerLabel(drawerSlot)} is reconnecting.\n${pauseSeconds()} s left.\nGet ready to guess.`;
    }
    return `Round ${roundNumber} of ${rounds}\n${playerLabel(drawerSlot)} is drawing.\n\nType your guess below.`;
  }

  /** Pushes private panel text, but only when the copy changed. */
  function publishPanels(phase: MatchPhase): void {
    const host = ctx;
    if (host === null) return;
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if (!isConnected(slot)) continue;
      const index = slot - 1;
      const signature = panelSignatureFor(slot, phase);
      if (panelSignature[index] === signature) continue;
      panelSignature[index] = signature;
      const title = panelTitleFor(slot, phase);
      const text = panelTextFor(slot, phase);
      try {
        host.panels.set(slot, { kind: "text", title, text });
      } catch {
        // Panel support is optional on older hosts.
      }
    }
  }

  function syncScores(): void {
    const board = scoreboard;
    if (board === null) return;
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      scoreValues[slot - 1] = board.get(slot);
    }
  }

  function finishRoundSafely(winner: number | null): void {
    const current = match;
    if (current === null || current.phase !== "playing") return;
    try {
      current.finishRound(winner);
    } catch {
      // The phase guard above makes this unreachable; never break the loop.
    }
  }

  /** Roster, drawer and word for the upcoming round. */
  function prepareRound(current: Match): void {
    roundsPlayed = current.round;
    roundNumber = roundsPlayed + 1;
    rosterSlots.length = 0;
    const scores = current.scores;
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if (scores.has(slot)) rosterSlots.push(slot);
    }
    if (rosterSlots.length === 0) {
      for (let index = 0; index < connectedSlots.length; index += 1) {
        const slot = connectedSlots[index];
        if (slot !== undefined) rosterSlots.push(slot);
      }
      rosterSlots.sort((a, b) => a - b);
    }

    drawerSlot =
      rosterSlots.length > 0
        ? (rosterSlots[roundsPlayed % rosterSlots.length] ?? 0)
        : 0;
    currentWord = pack?.draw() ?? "";
    currentWordNormalized = normalizeWord(currentWord);

    const board = scoreboard;
    if (board !== null) {
      for (let index = 0; index < rosterSlots.length; index += 1) {
        const slot = rosterSlots[index];
        if (slot !== undefined) board.set(slot, board.get(slot));
      }
    }

    guessesThisRound = 0;
    firstCorrectSlot = null;
    lastRoundMessage = "";
    drawerAway = false;
    drawerPauseMs = 0;
    advanceRequested = false;
    rematchRequested = false;
    finalResults = false;
    winnerSlot = null;
    resultsView = EMPTY_RESULTS;
    resultLines.length = 0;
    resultPanelText = "";
    for (let index = 0; index < guessedBySlot.length; index += 1) {
      guessedBySlot[index]?.clear();
    }
    strokes?.reset();
    lastHudKey = UNSENT;
  }

  /** Clears round state and returns every connected phone to the lobby view. */
  function resetForLobby(): void {
    roundsPlayed = 0;
    roundNumber = 0;
    drawerSlot = 0;
    currentWord = "";
    currentWordNormalized = "";
    guessesThisRound = 0;
    firstCorrectSlot = null;
    lastRoundMessage = "";
    drawerAway = false;
    drawerPauseMs = 0;
    resultsElapsedMs = 0;
    finalResults = false;
    winnerSlot = null;
    resultsView = EMPTY_RESULTS;
    resultLines.length = 0;
    resultPanelText = "";
    advanceRequested = false;
    rematchRequested = false;
    rosterSlots.length = 0;
    for (let index = 0; index < guessedBySlot.length; index += 1) {
      guessedBySlot[index]?.clear();
    }
    strokes?.reset();
    scoreboard?.reset();
    scoreValues.fill(0);
    layoutBySlot.fill("");
    panelSignature.fill(UNSENT);
    lastHudKey = UNSENT;
  }

  function computeWinner(): number | null {
    const board = scoreboard;
    if (board === null) return null;
    const ranked = board.ranked;
    const top = ranked[0];
    if (top === undefined || top.score <= 0) return null;
    const second = ranked[1];
    if (second !== undefined && second.score === top.score) return null;
    return top.slot;
  }

  function enterResults(current: Match): void {
    roundsPlayed = current.round;
    finalResults = roundsPlayed >= rounds;
    resultsElapsedMs = 0;
    advanceRequested = false;
    rematchRequested = false;
    drawerAway = false;
    drawerPauseMs = 0;
    winnerSlot = finalResults ? computeWinner() : null;

    const board = scoreboard;
    resultsView = board !== null ? resultsRows(board.ranked, winnerSlot) : EMPTY_RESULTS;
    resultLines.length = 0;
    for (let index = 0; index < resultsView.length; index += 1) {
      const row = resultsView[index];
      if (row !== undefined) resultLines.push(`${row.label}: ${row.score}`);
    }
    const scoreBlock = resultLines.join("\n");
    const outcome = lastRoundMessage.length > 0 ? lastRoundMessage : "Round over.";
    const headline =
      winnerSlot !== null ? `${playerLabel(winnerSlot)} wins!` : "It's a tie.";

    resultPanelText = finalResults
      ? `Final standings\n\nThe last word was "${currentWord}".\n\n${scoreBlock}\n\n${headline}\nTap Play again on your phone to start a new match.`
      : `Round ${roundNumber} of ${rounds}\nThe word was "${currentWord}".\n${outcome}\n\n${scoreBlock}\n\nNext round starts in a moment...`;
    lastHudKey = UNSENT;
  }

  function syncPhase(): void {
    const current = match;
    if (current === null) return;
    const phase = current.phase;
    if (phase === lastPhase) return;
    lastPhase = phase;
    if (phase === "countdown") prepareRound(current);
    else if (phase === "results") enterResults(current);
    else if (phase === "lobby") resetForLobby();
    // "playing" needs no entry work; the countdown prepared everything.
  }

  function updatePlaying(stepMs: number): void {
    const current = match;
    if (current === null || current.phase !== "playing") return;

    if (drawerSlot < 1) {
      lastRoundMessage = "No drawer was available, so the round was skipped.";
      finishRoundSafely(null);
      return;
    }

    if (!isConnected(drawerSlot)) {
      if (!drawerAway) {
        drawerAway = true;
        drawerPauseMs = 0;
      }
      drawerPauseMs += stepMs;
      if (drawerPauseMs >= reconnectPauseMs) {
        lastRoundMessage = "The drawer left, so the round was skipped.";
        finishRoundSafely(null);
      }
      return;
    }

    if (drawerAway) {
      drawerAway = false;
      drawerPauseMs = 0;
    }
    if (connectedCount < minPlayers) {
      lastRoundMessage = "Not enough players, so the round was skipped.";
      finishRoundSafely(null);
    }
  }

  function updateResults(stepMs: number): void {
    const current = match;
    if (current === null || current.phase !== "results") return;
    resultsElapsedMs += stepMs;

    if (connectedCount < minPlayers || !rosterConnected()) {
      advanceRequested = false;
      rematchRequested = false;
      current.reset();
      return;
    }

    if (!finalResults) {
      if (advanceRequested || resultsElapsedMs >= resultsHoldMs) {
        advanceRequested = false;
        current.nextRound(clockMs);
      }
      return;
    }

    if (rematchRequested) {
      rematchRequested = false;
      pack?.reset();
      scoreboard?.reset();
      current.reset();
    }
  }

  function handleGuess(slot: number, raw: string): void {
    const current = match;
    if (disposed || current === null) return;
    const guess = normalizeWord(sanitizeText(raw, DG_CONFIG.guessMaxLen));
    if (guess.length === 0) return;
    if (!isConnected(slot) || !isRosterSlot(slot)) return;

    if (current.phase === "results") {
      // Any roster member's text submission skips the intermediate hold.
      if (!finalResults) advanceRequested = true;
      return;
    }
    if (current.phase !== "playing") return;
    if (slot === drawerSlot || firstCorrectSlot !== null) return;
    if (guessesThisRound >= DG_CONFIG.maxGuessesPerRound) return;

    const seen = guessedBySlot[slot - 1];
    if (seen === undefined || seen.has(guess)) return;
    seen.add(guess);
    guessesThisRound += 1;

    if (guess === currentWordNormalized) {
      firstCorrectSlot = slot;
      scoreboard?.add(slot, DG_CONFIG.guesserScore);
      if (drawerSlot >= 1) scoreboard?.add(drawerSlot, DG_CONFIG.drawerScore);
      lastRoundMessage = `${playerLabel(slot)} guessed it!`;
      finishRoundSafely(null);
      return;
    }

    if (guessesThisRound >= DG_CONFIG.maxGuessesPerRound) {
      lastRoundMessage = "Nobody guessed it.";
      finishRoundSafely(null);
    }
  }

  function handleCanvas(slot: number, data: JsonValue): void {
    const current = match;
    if (disposed || current === null || current.phase !== "playing") return;
    if (slot !== drawerSlot || !isConnected(slot)) return;
    strokes?.add(data);
  }

  function handleChoice(slot: number, optionId: string): void {
    const current = match;
    if (disposed || current === null || current.phase !== "results") return;
    if (!finalResults || optionId !== "rematch" || !isConnected(slot)) return;
    rematchRequested = true;
  }

  function updateDebug(host: GameContext, current: Match): void {
    host.debug.setCounter("dg.phase", phaseCode(current.phase));
    host.debug.setCounter("dg.round", roundNumber);
    host.debug.setCounter("dg.drawer", drawerSlot);
    host.debug.setCounter("dg.connected", connectedCount);
    host.debug.setCounter("dg.strokes", strokes?.count ?? 0);
    host.debug.setCounter("dg.points", strokes?.pointCount ?? 0);
    host.debug.setCounter("dg.guesses", guessesThisRound);
    host.debug.setCounter("dg.paused", drawerAway ? 1 : 0);
  }

  function hudKey(phase: MatchPhase): number {
    let key =
      phaseCode(phase) |
      ((roundNumber & 0x7) << 3) |
      ((drawerSlot & 0xf) << 6) |
      ((connectedCount & 0xf) << 10);
    if (finalResults) key |= 1 << 14;
    if (winnerSlot !== null) key |= (winnerSlot & 0xf) << 15;
    if (drawerAway) key |= 1 << 19;
    key |= (pauseSeconds() & 0x3f) << 20;
    return key;
  }

  /** Rebuilds cached TV strings only when the displayed state changed. */
  function updateHud(phase: MatchPhase): void {
    const state = renderState;
    if (state === null) return;
    const key = hudKey(phase);
    if (key === lastHudKey) return;
    lastHudKey = key;

    const drawerLabel = drawerSlot >= 1 ? playerLabel(drawerSlot) : "";
    if (phase === "lobby") {
      state.turnLine = "Draw it. Guess it.";
      state.status = `Waiting for players (${connectedCount}/${minPlayers})`;
    } else if (phase === "countdown") {
      state.turnLine = `Round ${roundNumber} of ${rounds} — ${drawerLabel} draws`;
      state.status = "Getting ready...";
    } else if (phase === "playing") {
      state.turnLine = `Round ${roundNumber} of ${rounds} — ${drawerLabel} draws`;
      state.status = drawerAway
        ? `${drawerLabel} is reconnecting — ${pauseSeconds()} s`
        : `${drawerLabel} is drawing — guess on your phone`;
    } else {
      state.turnLine = finalResults
        ? "Final results"
        : `Round ${roundNumber} of ${rounds} — result`;
      if (finalResults) {
        state.status =
          winnerSlot !== null
            ? `${playerLabel(winnerSlot)} wins the match!`
            : "The match ends in a tie.";
      } else {
        state.status = `${lastRoundMessage.length > 0 ? lastRoundMessage : "Round over."} Next round shortly.`;
      }
    }

    state.word = currentWord;
    state.revealWord = phase === "results" && currentWord.length > 0;
    state.resultsHeadline =
      phase === "results" ? (finalResults ? "Final standings" : "Round over") : "";
    state.scoreLines = phase === "results" ? resultLines : EMPTY_LINES;
  }

  function updateRenderState(current: Match): void {
    const state = renderState;
    if (state === null) return;
    state.phase = current.phase;
    state.countdownRemainingMs = current.countdownRemainingMs;
    state.roundNumber = roundNumber;
    state.rounds = rounds;
    state.drawerSlot = drawerSlot;
    updateHud(current.phase);
  }

  const game: DrawAndGuessGame = {
    manifest,

    init(host: GameContext): void {
      releaseSubscriptions();
      disposed = false;
      ctx = host;
      surface = resolveRenderer2D(host.renderer);

      match = createMatch({
        minPlayers,
        maxPlayers,
        countdownMs,
        // Never let the kit declare a match winner: this game decides after
        // exactly `rounds` rounds from its own accumulating scoreboard.
        roundsToWin: rounds + 1,
      });
      scoreboard = createScoreboard();
      strokes = new StrokeStore();
      const seed =
        options.seed !== undefined && Number.isFinite(options.seed)
          ? Math.floor(options.seed)
          : Number.isFinite(host.rng.seed)
            ? Math.floor(host.rng.seed)
            : DG_DEFAULT_SEED;
      pack = createPack(wordSource, { seed });

      clockMs = 0;
      connectedMask = 0;
      connectedCount = 0;
      layoutActiveMask = 0;
      lastPhase = "lobby";
      connectedSlots.length = 0;
      guessedBySlot.forEach((set) => set.clear());
      layoutBySlot.fill("");
      panelSignature.fill(UNSENT);
      scoreValues.fill(0);
      resultLines.length = 0;
      laidOutSlots.length = 0;
      renderState = {
        strokes,
        phase: "lobby",
        roundNumber: 0,
        rounds,
        drawerSlot: 0,
        countdownRemainingMs: 0,
        status: "",
        turnLine: "",
        word: "",
        revealWord: false,
        scoreLines: EMPTY_LINES,
        resultsHeadline: "",
      };
      resetForLobby();

      unsubCanvas = onCanvas(host, handleCanvas);
      unsubText = onText(host, handleGuess);
      unsubChoice = onChoice(host, handleChoice);
    },

    simulate(dt: number, input: GameInputSnapshot): void {
      const host = ctx;
      const current = match;
      if (disposed || host === null || current === null) return;

      const stepMs = Number.isFinite(dt) && dt > 0 ? dt * 1000 : 0;
      clockMs += stepMs;

      observePlayers(input);
      current.update(clockMs, connectedSlots);

      // A roster shrink during the countdown returns the kit to the lobby.
      // Clear round state before a possible immediate restart, so a new
      // countdown never inherits the aborted round's word, drawer or ink.
      if (current.phase === "lobby" && lastPhase !== "lobby") {
        lastPhase = "lobby";
        resetForLobby();
      }
      if (current.phase === "lobby" && connectedCount >= minPlayers) {
        current.start(clockMs);
      }

      syncPhase();
      if (current.phase === "playing") {
        updatePlaying(stepMs);
        syncPhase();
      }
      if (current.phase === "results") {
        updateResults(stepMs);
        syncPhase();
      }

      publishLayouts(current.phase);
      publishPanels(current.phase);
      syncScores();
      updateRenderState(current);
      updateDebug(host, current);
    },

    render(alpha: number): void {
      if (disposed || renderState === null || surface === null) return;
      drawDrawAndGuess(surface, renderState, alpha);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      releaseSubscriptions();
      match?.reset();
      match = null;
      scoreboard = null;
      pack = null;
      strokes = null;
      surface = null;
      renderState = null;
      ctx = null;
      connectedMask = 0;
      connectedCount = 0;
      layoutActiveMask = 0;
      lastPhase = "lobby";
      roundsPlayed = 0;
      roundNumber = 0;
      drawerSlot = 0;
      currentWord = "";
      currentWordNormalized = "";
      guessesThisRound = 0;
      firstCorrectSlot = null;
      lastRoundMessage = "";
      drawerAway = false;
      drawerPauseMs = 0;
      resultsElapsedMs = 0;
      finalResults = false;
      winnerSlot = null;
      resultsView = EMPTY_RESULTS;
      resultPanelText = "";
      advanceRequested = false;
      rematchRequested = false;
      lastHudKey = UNSENT;
      connectedSlots.length = 0;
      rosterSlots.length = 0;
      guessedBySlot.forEach((set) => set.clear());
      layoutBySlot.fill("");
      panelSignature.fill(UNSENT);
      scoreValues.fill(0);
      resultLines.length = 0;
      laidOutSlots.length = 0;
    },

    get phase(): MatchPhase {
      return match?.phase ?? "lobby";
    },

    get roundNumber(): number {
      return roundNumber;
    },

    get rounds(): number {
      return rounds;
    },

    get drawerSlot(): number {
      return drawerSlot;
    },

    get currentWord(): string {
      return currentWord;
    },

    get connectedMask(): number {
      return connectedMask;
    },

    get roster(): readonly number[] {
      return rosterSlots;
    },

    get scores(): readonly number[] {
      return scoreValues;
    },

    get results(): readonly ResultsRow[] {
      return resultsView;
    },

    get firstCorrectSlot(): number | null {
      return firstCorrectSlot;
    },

    get finalResults(): boolean {
      return finalResults;
    },

    get strokeCount(): number {
      return strokes?.count ?? 0;
    },

    get strokePointCount(): number {
      return strokes?.pointCount ?? 0;
    },

    get guessCount(): number {
      return guessesThisRound;
    },

    get drawerPauseRemainingMs(): number {
      if (!drawerAway) return 0;
      return Math.max(0, reconnectPauseMs - drawerPauseMs);
    },

    get laidOutSlots(): readonly number[] {
      return laidOutSlots;
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
export default createDrawAndGuessGame;

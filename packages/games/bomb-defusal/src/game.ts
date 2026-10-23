/**
 * Bomb Defusal host adapter (GAME-BD-HOST-01..06; FR-9.1, FR-8.2).
 *
 * This is the module `loadGame` imports from `game.manifest.json`: a default
 * `(manifest) => Game` factory. It consumes `GameContext` only (FR-7.17):
 * presence comes from `GameControllerState.connected`, roles and paging from
 * the layouts, and all private text goes through `ctx.panels`.
 *
 * One round:
 *
 *   lobby -> countdown -> playing -> results -> countdown (new bomb)
 *
 * The lowest connected slot is the defuser and gets the tool layout; every
 * other phone gets the manual layout. The bomb is generated at the start of
 * the countdown so the manual is readable before the timer starts. A wrong
 * wire, a wrong hold or a wrong four-digit code adds a strike; three strikes,
 * the timer reaching zero, or the defuser leaving for the grace window ends
 * the round. The match state machine from `@lanpad/game-kit` owns the phase
 * and countdown; co-op rounds finish as draws because no individual winner is
 * tracked. Any button (or kit event) after the results lockout starts the next
 * round.
 *
 * Private data path: `manualPanelContent` and `defuserStatusContent` are sent
 * with `ctx.panels.set(slot, ...)` to exactly one phone. The TV renderer only
 * receives the public bomb facts, and the host never receives a panel echo.
 *
 * The adapter owns every mutable object; `simulate` and `render` reuse the
 * connection buffer, role arrays and the pooled render state.
 */
import type {
  Game,
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameManifest,
  JsonValue,
  PanelContent,
} from "@lanpad/sdk";
import {
  createMatch,
  onChoice,
  onText,
  type MatchPhase,
} from "@lanpad/game-kit";
import {
  MANUAL_PAGE_COUNT,
  WIRE_COLORS,
  allModulesSolved,
  applyButtonAction,
  applyKeypadAction,
  applyWireAction,
  formatTimer,
  generateBomb,
  manualPanelContent,
  solvedCount,
  type ActionOutcome,
  type Bomb,
  type WireColor,
} from "./bomb.js";
import { BOMB_CONFIG, type RoundCause } from "./config.js";
import {
  BombRenderCache,
  drawBomb,
  resolveRenderer2D,
  type BombRenderState,
  type Renderer2DLike,
} from "./render.js";

/** Layout document ids shipped in `layouts/` (GAME-BD-CTRL-01/02). */
export const BD_DEFUSER_LAYOUT_ID = "bd-defuser-v1";
export const BD_MANUAL_LAYOUT_ID = "bd-manual-v1";

/** Layout bookkeeping codes; 0 means no layout has been requested. */
const LAYOUT_NONE = 0;
const LAYOUT_DEFUSER = 1;
const LAYOUT_MANUAL = 2;

/** Sentinel for "this slot has never received panel content". */
const PANEL_UNSENT = -2147483648;
/** Marker bit keeps status signatures above every manual page index. */
const STATUS_SIGNATURE = 0x20000000;
const SECONDS_MASK = 0x1ff;

const STRIKE_PATTERN: readonly number[] = [120, 60, 120];
const SOLVED_PATTERN: readonly number[] = [50, 40, 50];
const DEFUSED_PATTERN: readonly number[] = [60, 40, 60, 40, 160];
const LOST_PATTERN: readonly number[] = [400, 100, 400];

const PHASE_CODE: Readonly<Record<MatchPhase, number>> = {
  lobby: 0,
  countdown: 1,
  playing: 2,
  results: 3,
};

/** Optional factory arguments for tests and per-scene tuning. */
export interface BombDefusalGameOptions {
  /** Overrides `BOMB_CONFIG.countdownMs`; 0 starts play on the next tick. */
  readonly countdownMs?: number;
  /** Overrides `BOMB_CONFIG.timerMs`. */
  readonly timerMs?: number;
  /** Overrides `BOMB_CONFIG.defuserGraceMs`; 0 loses the round on the next tick. */
  readonly defuserGraceMs?: number;
  /** Caps the manifest's `maxPlayers`; never raises it above 8. */
  readonly maxPlayers?: number;
}

/** The adapter's observable state, used by tests and the debug overlay. */
export interface BombDefusalGame extends Game {
  /** The current bomb after the countdown starts, null in the lobby. */
  readonly bomb: Bomb | null;
  readonly phase: MatchPhase;
  /** Slot holding the tool layout; 0 before the first round. */
  readonly defuserSlot: number;
  readonly timerRemainingMs: number;
  readonly strikes: number;
  readonly roundCause: RoundCause | null;
  /** Timer value frozen when the round ended. */
  readonly resultTimeMs: number;
  /** Milliseconds left in the defuser reconnect grace; negative when inactive. */
  readonly graceRemainingMs: number;
  /** One bit per connected slot (bit N = slot N). */
  readonly connectedMask: number;
  readonly connectedCount: number;
  /** Manual page per slot, indexed by slot - 1. */
  readonly manualPages: Int32Array;
  /** Slots whose layout has been requested, in request order. */
  readonly laidOutSlots: ReadonlyArray<number>;
  readonly layoutErrors: number;
  readonly panelErrors: number;
}

type MutableRenderState = {
  -readonly [K in keyof BombRenderState]: BombRenderState[K];
};

function optionMs(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.round(value));
}

function clampMaxPlayers(manifest: GameManifest, override: number | undefined): number {
  const requested =
    override === undefined || !Number.isFinite(override)
      ? BOMB_CONFIG.maxPlayers
      : Math.floor(override);
  const capped = Math.min(manifest.maxPlayers, BOMB_CONFIG.maxPlayers, requested);
  return Math.max(1, capped);
}

/** A slot participates while its controller is connected (FR-8.2). */
function isConnectedSlot(player: GameControllerState, maxPlayers: number): boolean {
  return (
    player.connected &&
    Number.isInteger(player.slot) &&
    player.slot >= 1 &&
    player.slot <= maxPlayers
  );
}

function isWireColor(value: string): value is WireColor {
  for (let index = 0; index < WIRE_COLORS.length; index += 1) {
    if (WIRE_COLORS[index] === value) return true;
  }
  return false;
}

/**
 * Creates the Bomb Defusal `Game`. The default export is the frozen
 * `GameModule` shape; the optional second argument exists for tests only.
 */
export function createBombDefusalGame(
  manifest: GameManifest,
  options: BombDefusalGameOptions = {},
): BombDefusalGame {
  const maxPlayers = clampMaxPlayers(manifest, options.maxPlayers);
  const minPlayers = Math.max(1, Math.min(manifest.minPlayers, maxPlayers));
  const countdownMs = optionMs(options.countdownMs, BOMB_CONFIG.countdownMs, 0);
  const timerMs = optionMs(options.timerMs, BOMB_CONFIG.timerMs, 1);
  const defuserGraceMs = optionMs(
    options.defuserGraceMs,
    BOMB_CONFIG.defuserGraceMs,
    0,
  );

  const match = createMatch({ minPlayers, maxPlayers, countdownMs });

  let ctx: GameContext | null = null;
  let surface: Renderer2DLike | null = null;
  let renderCache: BombRenderCache | null = null;
  let renderState: MutableRenderState | null = null;
  let unsubChoice: (() => void) | null = null;
  let unsubText: (() => void) | null = null;
  let disposed = true;
  let lastMatchPhase: MatchPhase = "lobby";
  let clockMs = 0;

  let bomb: Bomb | null = null;
  let defuserSlot = 0;
  let timerRemainingMs = 0;
  let strikes = 0;
  let roundCause: RoundCause | null = null;
  let resultTimeMs = 0;
  let resultsElapsedMs = 0;
  let restartRequested = false;
  let buttonDown = false;
  let buttonHeldMs = 0;
  let graceRemainingMs = -1;
  let connectedMask = 0;
  let connectedCount = 0;
  let seenMask = 0;
  let layoutErrors = 0;
  let panelErrors = 0;

  /** Reused roster buffer; its length is the valid prefix (no per-tick alloc). */
  const connectedSlots: number[] = [];
  const manualPage = new Int32Array(maxPlayers);
  const layoutApplied = new Int32Array(maxPlayers);
  const panelSignature = new Int32Array(maxPlayers);
  panelSignature.fill(PANEL_UNSENT);
  const laidOutSlots: number[] = [];

  function pulse(target: number | "all", pattern: readonly number[]): void {
    const haptics = ctx?.haptics;
    if (haptics === undefined) return;
    try {
      haptics.pulse(target, pattern);
    } catch {
      // Haptics are optional; a throwing stub must never stop the round.
    }
  }

  function roleForSlot(slot: number): number {
    return bomb !== null && slot === defuserSlot ? LAYOUT_DEFUSER : LAYOUT_MANUAL;
  }

  function applyRoleLayout(slot: number): void {
    const role = roleForSlot(slot);
    const index = slot - 1;
    if ((layoutApplied[index] ?? LAYOUT_NONE) === role) return;
    layoutApplied[index] = role;
    const layouts = ctx?.layouts;
    if (layouts === undefined) return;
    try {
      layouts.set(
        slot,
        role === LAYOUT_DEFUSER ? BD_DEFUSER_LAYOUT_ID : BD_MANUAL_LAYOUT_ID,
      );
      laidOutSlots.push(slot);
    } catch {
      layoutErrors += 1;
    }
  }

  function onSlotConnected(slot: number): void {
    layoutApplied[slot - 1] = LAYOUT_NONE;
    panelSignature[slot - 1] = PANEL_UNSENT;
    applyRoleLayout(slot);
  }

  function onSlotDisconnected(slot: number): void {
    layoutApplied[slot - 1] = LAYOUT_NONE;
    panelSignature[slot - 1] = PANEL_UNSENT;
    if (slot === defuserSlot) {
      buttonDown = false;
      buttonHeldMs = 0;
    }
    try {
      ctx?.layouts.clear(slot);
    } catch {
      layoutErrors += 1;
    }
  }

  /**
   * Tracks connection edges from this tick's snapshot. Layouts are requested
   * once per connection and cleared once per disconnect (FR-8.2, FR-5.4).
   */
  function observePlayers(input: GameInputSnapshot): void {
    const players = input.players;
    let presentMask = 0;
    let presentCount = 0;
    let count = 0;

    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      const bit = 1 << player.slot;
      if ((presentMask & bit) !== 0) continue;
      presentMask |= bit;
      presentCount += 1;
      connectedSlots[count] = player.slot;
      count += 1;
      if ((seenMask & bit) === 0) {
        seenMask |= bit;
        onSlotConnected(player.slot);
      }
    }
    connectedSlots.length = count;

    let gone = seenMask & ~presentMask;
    while (gone !== 0) {
      const bit = gone & -gone;
      gone &= gone - 1;
      const slot = 31 - Math.clz32(bit);
      seenMask &= ~bit;
      onSlotDisconnected(slot);
    }

    connectedMask = presentMask;
    connectedCount = presentCount;
  }

  function lowestConnectedSlot(): number {
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if ((connectedMask & (1 << slot)) !== 0) return slot;
    }
    return 0;
  }

  function waitingContent(): PanelContent {
    return {
      kind: "blocks",
      blocks: [
        { type: "heading", text: "BOMB DEFUSAL" },
        {
          type: "paragraph",
          text:
            `Waiting for ${minPlayers} players. One phone defuses the bomb; ` +
            "every other phone holds the manual.",
        },
      ],
    };
  }

  function defuserStatusContent(current: Bomb): PanelContent {
    const graceSeconds =
      graceRemainingMs >= 0 ? Math.ceil(graceRemainingMs / 1000) : 0;
    const items = [
      `Time ${formatTimer(timerRemainingMs)}`,
      `Strikes ${strikes} / ${BOMB_CONFIG.strikesAllowed}`,
      `Modules ${solvedCount(current)} / ${BOMB_CONFIG.moduleCount}`,
      `Serial ${current.serial}`,
      `Batteries ${current.batteries} - ${current.indicators.join(" / ")}`,
    ];
    return {
      kind: "blocks",
      blocks: [
        { type: "heading", text: "DEFUSER TOOL" },
        { type: "list", items },
        {
          type: "paragraph",
          text:
            graceSeconds > 0
              ? `Signal lost: ${graceSeconds} s to return.`
              : "Readers hold the manual. Ask them for the next rule.",
        },
      ],
    };
  }

  /**
   * Numeric content signatures keep the panel API quiet until something the
   * phone would display changes. The role/marker bits make a manual page and
   * a status panel impossible to confuse.
   */
  function panelSignatureFor(slot: number): number {
    if (bomb === null) return 0;
    if (slot === defuserSlot) {
      const seconds = Math.floor(timerRemainingMs / 1000) & SECONDS_MASK;
      const solved = solvedCount(bomb) & 3;
      const grace =
        (graceRemainingMs >= 0 ? Math.ceil(graceRemainingMs / 1000) : 0) & 31;
      return (
        STATUS_SIGNATURE |
        seconds |
        ((strikes & 3) << 9) |
        (solved << 11) |
        (grace << 13)
      );
    }
    return manualPage[slot - 1] ?? 0;
  }

  function contentForSlot(slot: number): PanelContent {
    const current = bomb;
    if (current === null) return waitingContent();
    if (slot === defuserSlot) return defuserStatusContent(current);
    return manualPanelContent(current, manualPage[slot - 1] ?? 0);
  }

  /** Sends only changed panels, and only to the phone they belong to. */
  function updatePanels(): void {
    const context = ctx;
    if (context === null) return;
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if ((connectedMask & (1 << slot)) === 0) continue;
      const index = slot - 1;
      const signature = panelSignatureFor(slot);
      if ((panelSignature[index] ?? PANEL_UNSENT) === signature) continue;
      // Set before the call: a throwing host must not retry every tick.
      panelSignature[index] = signature;
      try {
        context.panels.set(slot, contentForSlot(slot) as unknown as JsonValue);
      } catch {
        panelErrors += 1;
      }
    }
  }

  function enterResults(cause: RoundCause): void {
    if (match.phase !== "playing") return;
    roundCause = cause;
    resultTimeMs = timerRemainingMs;
    resultsElapsedMs = 0;
    restartRequested = false;
    buttonDown = false;
    buttonHeldMs = 0;
    graceRemainingMs = -1;
    match.finishRound(null);
    pulse("all", cause === "defused" ? DEFUSED_PATTERN : LOST_PATTERN);
  }

  function registerStrike(): void {
    if (match.phase !== "playing") return;
    strikes += 1;
    pulse("all", STRIKE_PATTERN);
    if (strikes >= BOMB_CONFIG.strikesAllowed) {
      enterResults("strikes");
    }
  }

  function resolveOutcome(outcome: ActionOutcome): void {
    if (outcome === "solved") {
      if (defuserSlot > 0) pulse(defuserSlot, SOLVED_PATTERN);
      if (bomb !== null && allModulesSolved(bomb)) {
        enterResults("defused");
      }
    } else if (outcome === "strike") {
      registerStrike();
    }
  }

  function applyButton(heldMs: number): void {
    const current = bomb;
    if (current === null || match.phase !== "playing") return;
    resolveOutcome(applyButtonAction(current, heldMs));
  }

  /**
   * Measures a held button locally. A press and release inside one tick still
   * arrives as an edge with level 0, and counts as a tap (FR-7.3).
   */
  function handleDefuserButton(player: GameControllerState, stepMs: number): void {
    const bit = 1 << BOMB_CONFIG.buttonBit;
    const isDown = (player.buttons & bit) !== 0;
    const pressed = (player.edges & bit) !== 0;

    if (bomb === null || bomb.button.solved) {
      if (buttonDown && !isDown) {
        buttonDown = false;
        buttonHeldMs = 0;
      }
      return;
    }

    if (pressed && isDown) {
      if (!buttonDown) {
        buttonDown = true;
        buttonHeldMs = 0;
      }
    } else if (pressed) {
      buttonDown = false;
      buttonHeldMs = 0;
      applyButton(0);
    } else if (buttonDown && !isDown) {
      const held = buttonHeldMs;
      buttonDown = false;
      buttonHeldMs = 0;
      applyButton(held);
    }

    if (buttonDown && isDown) {
      buttonHeldMs += stepMs;
    }
  }

  function setPage(index: number, page: number): void {
    if (bomb === null) return;
    const clamped =
      page < 0 ? 0 : page >= MANUAL_PAGE_COUNT ? MANUAL_PAGE_COUNT - 1 : page;
    manualPage[index] = clamped;
  }

  function handleReaderPaging(player: GameControllerState): void {
    const prev = 1 << BOMB_CONFIG.prevBit;
    const next = 1 << BOMB_CONFIG.nextBit;
    const index = player.slot - 1;
    if ((player.edges & prev) !== 0) {
      setPage(index, (manualPage[index] ?? 0) - 1);
    }
    if ((player.edges & next) !== 0) {
      setPage(index, (manualPage[index] ?? 0) + 1);
    }
  }

  function updateManualPaging(input: GameInputSnapshot): void {
    if (bomb === null) return;
    const players = input.players;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      if (player.slot === defuserSlot) continue;
      handleReaderPaging(player);
    }
  }

  function updatePlaying(stepMs: number, input: GameInputSnapshot): void {
    if (bomb === null) return;

    if (defuserSlot > 0 && (connectedMask & (1 << defuserSlot)) === 0) {
      if (graceRemainingMs < 0) {
        graceRemainingMs = defuserGraceMs;
      }
      graceRemainingMs -= stepMs;
      if (graceRemainingMs <= 0) {
        graceRemainingMs = 0;
        enterResults("defuser-lost");
        return;
      }
    } else if (graceRemainingMs >= 0) {
      graceRemainingMs = -1;
    }

    timerRemainingMs -= stepMs;
    if (timerRemainingMs <= 0) {
      timerRemainingMs = 0;
      enterResults("timeout");
      return;
    }

    const players = input.players;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      if (player.slot !== defuserSlot) continue;
      handleDefuserButton(player, stepMs);
      if (match.phase !== "playing") return;
    }
  }

  function updateResults(stepMs: number, input: GameInputSnapshot): void {
    resultsElapsedMs += stepMs;
    if (resultsElapsedMs < BOMB_CONFIG.resultsLockoutMs) {
      restartRequested = false;
      return;
    }

    let pressed = restartRequested;
    restartRequested = false;
    if (!pressed) {
      const players = input.players;
      for (let index = 0; index < players.length; index += 1) {
        const player = players[index];
        if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
        if (player.edges !== 0) {
          pressed = true;
          break;
        }
      }
    }
    if (pressed) {
      match.nextRound(clockMs);
    }
  }

  function prepareRound(): void {
    const context = ctx;
    if (context === null) return;
    bomb = generateBomb(context.rng);
    defuserSlot = lowestConnectedSlot();
    timerRemainingMs = timerMs;
    strikes = 0;
    roundCause = null;
    resultTimeMs = 0;
    resultsElapsedMs = 0;
    restartRequested = false;
    buttonDown = false;
    buttonHeldMs = 0;
    graceRemainingMs = -1;
    manualPage.fill(0);
    panelSignature.fill(PANEL_UNSENT);
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if ((connectedMask & (1 << slot)) === 0) continue;
      applyRoleLayout(slot);
    }
  }

  function resetToLobby(): void {
    bomb = null;
    defuserSlot = 0;
    timerRemainingMs = 0;
    strikes = 0;
    roundCause = null;
    resultTimeMs = 0;
    resultsElapsedMs = 0;
    restartRequested = false;
    buttonDown = false;
    buttonHeldMs = 0;
    graceRemainingMs = -1;
    manualPage.fill(0);
    panelSignature.fill(PANEL_UNSENT);
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if ((connectedMask & (1 << slot)) === 0) continue;
      applyRoleLayout(slot);
    }
  }

  function startPlaying(): void {
    buttonDown = false;
    buttonHeldMs = 0;
    graceRemainingMs = -1;
  }

  function syncPhase(): void {
    const phase = match.phase;
    if (phase === lastMatchPhase) return;
    lastMatchPhase = phase;
    if (phase === "countdown") {
      prepareRound();
    } else if (phase === "lobby") {
      resetToLobby();
    } else if (phase === "playing") {
      startPlaying();
    } else {
      resultsElapsedMs = 0;
      buttonDown = false;
      buttonHeldMs = 0;
    }
  }

  function requestRestart(): void {
    if (match.phase !== "results") return;
    if (resultsElapsedMs < BOMB_CONFIG.resultsLockoutMs) return;
    restartRequested = true;
  }

  function handleChoice(slot: number, optionId: string): void {
    if (disposed) return;
    if (match.phase === "results") {
      requestRestart();
      return;
    }
    if (match.phase !== "playing" || bomb === null || slot !== defuserSlot) return;
    if (!isWireColor(optionId)) return;
    resolveOutcome(applyWireAction(bomb, optionId));
  }

  function handleText(slot: number, text: string): void {
    if (disposed) return;
    if (match.phase === "results") {
      requestRestart();
      return;
    }
    if (match.phase !== "playing" || bomb === null || slot !== defuserSlot) return;
    resolveOutcome(applyKeypadAction(bomb, text));
  }

  function updateDebug(): void {
    if (ctx === null) return;
    ctx.debug.setCounter("players", connectedCount);
    ctx.debug.setCounter("phase", PHASE_CODE[match.phase]);
    ctx.debug.setCounter("strikes", strikes);
    ctx.debug.setCounter("modules", bomb === null ? 0 : solvedCount(bomb));
    ctx.debug.setCounter("timerSec", Math.ceil(timerRemainingMs / 1000));
    ctx.debug.setCounter("layoutErrors", layoutErrors);
    ctx.debug.setCounter("panelErrors", panelErrors);
  }

  const game: BombDefusalGame = {
    manifest,

    get bomb(): Bomb | null {
      return bomb;
    },
    get phase(): MatchPhase {
      return match.phase;
    },
    get defuserSlot(): number {
      return defuserSlot;
    },
    get timerRemainingMs(): number {
      return timerRemainingMs;
    },
    get strikes(): number {
      return strikes;
    },
    get roundCause(): RoundCause | null {
      return roundCause;
    },
    get resultTimeMs(): number {
      return resultTimeMs;
    },
    get graceRemainingMs(): number {
      return graceRemainingMs;
    },
    get connectedMask(): number {
      return connectedMask;
    },
    get connectedCount(): number {
      return connectedCount;
    },
    get manualPages(): Int32Array {
      return manualPage;
    },
    get laidOutSlots(): ReadonlyArray<number> {
      return laidOutSlots;
    },
    get layoutErrors(): number {
      return layoutErrors;
    },
    get panelErrors(): number {
      return panelErrors;
    },

    init(context: GameContext): void {
      if (unsubChoice !== null) {
        unsubChoice();
        unsubChoice = null;
      }
      if (unsubText !== null) {
        unsubText();
        unsubText = null;
      }

      ctx = context;
      surface = resolveRenderer2D(context.renderer);
      renderCache = new BombRenderCache(maxPlayers);
      renderState = {
        phase: "lobby",
        countdownMs: 0,
        timerMs: 0,
        strikes: 0,
        strikesAllowed: BOMB_CONFIG.strikesAllowed,
        defuserSlot: 0,
        connectedCount: 0,
        minPlayers,
        bomb: null,
        solved: 0,
        cause: null,
        resultTimeMs: 0,
        defuserGraceMs: -1,
        buttonDown: false,
        heldMs: 0,
      };

      disposed = false;
      clockMs = 0;
      lastMatchPhase = "lobby";
      bomb = null;
      defuserSlot = 0;
      timerRemainingMs = 0;
      strikes = 0;
      roundCause = null;
      resultTimeMs = 0;
      resultsElapsedMs = 0;
      restartRequested = false;
      buttonDown = false;
      buttonHeldMs = 0;
      graceRemainingMs = -1;
      connectedMask = 0;
      connectedCount = 0;
      seenMask = 0;
      layoutErrors = 0;
      panelErrors = 0;
      connectedSlots.length = 0;
      manualPage.fill(0);
      layoutApplied.fill(0);
      panelSignature.fill(PANEL_UNSENT);
      laidOutSlots.length = 0;
      match.reset();

      unsubChoice = onChoice(context, handleChoice);
      unsubText = onText(context, handleText);
    },

    simulate(dt: number, input: GameInputSnapshot): void {
      if (disposed || ctx === null) return;
      const stepMs = Number.isFinite(dt) && dt > 0 ? dt * 1000 : 0;
      clockMs += stepMs;

      observePlayers(input);
      match.update(clockMs, connectedSlots);
      if (match.phase === "lobby" && connectedCount >= minPlayers) {
        match.start(clockMs);
      }
      syncPhase();

      if (
        bomb !== null &&
        (match.phase === "countdown" || match.phase === "playing")
      ) {
        updateManualPaging(input);
      }
      if (match.phase === "playing") {
        updatePlaying(stepMs, input);
      }
      if (match.phase === "results") {
        updateResults(stepMs, input);
      }
      syncPhase();
      updatePanels();
      updateDebug();
    },

    render(alpha: number): void {
      const state = renderState;
      const view = surface;
      const cache = renderCache;
      if (disposed || state === null || view === null || cache === null) return;

      const blend = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
      state.phase = match.phase;
      state.countdownMs = match.countdownRemainingMs;
      state.timerMs = timerRemainingMs;
      state.strikes = strikes;
      state.strikesAllowed = BOMB_CONFIG.strikesAllowed;
      state.defuserSlot = defuserSlot;
      state.connectedCount = connectedCount;
      state.minPlayers = minPlayers;
      state.bomb = bomb;
      state.solved = bomb === null ? 0 : solvedCount(bomb);
      state.cause = roundCause;
      state.resultTimeMs = resultTimeMs;
      state.defuserGraceMs = graceRemainingMs;
      state.buttonDown = buttonDown;
      state.heldMs = buttonHeldMs;
      cache.syncBomb(bomb);
      drawBomb(view, state, cache, blend);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (unsubChoice !== null) {
        unsubChoice();
        unsubChoice = null;
      }
      if (unsubText !== null) {
        unsubText();
        unsubText = null;
      }
      match.reset();
      bomb = null;
      defuserSlot = 0;
      timerRemainingMs = 0;
      strikes = 0;
      roundCause = null;
      resultTimeMs = 0;
      resultsElapsedMs = 0;
      restartRequested = false;
      buttonDown = false;
      buttonHeldMs = 0;
      graceRemainingMs = -1;
      connectedMask = 0;
      connectedCount = 0;
      seenMask = 0;
      connectedSlots.length = 0;
      laidOutSlots.length = 0;
      manualPage.fill(0);
      layoutApplied.fill(0);
      panelSignature.fill(PANEL_UNSENT);
      lastMatchPhase = "lobby";
      ctx = null;
      surface = null;
      renderCache = null;
      renderState = null;
    },
  };

  return game;
}

/** Frozen `GameModule` shape consumed by `loadGame`. */
export default createBombDefusalGame;

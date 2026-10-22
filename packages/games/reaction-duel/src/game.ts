/**
 * Reaction Duel host adapter (GAME-RD-HOST-01..05; D7-SDK-01, A12).
 *
 * This is the module `loadGame` imports from `game.manifest.json`: a default
 * `(manifest) => Game` factory. It consumes `GameContext` only (FR-7.17): the
 * rules model reads the mapped `GameInputSnapshot`, layouts go through
 * `ctx.layouts`, results are decided from the synced `ControllerState.tick`,
 * and drawing goes through `ctx.renderer`.
 *
 * The game is a thin driver around the pure `ReactionDuelModel`:
 *
 *   init -> simulate(dt, snapshot) -> render(alpha) -> dispose
 *
 * `simulate` observes which slots are connected (`ControllerState.connected`),
 * applies the four-button layout when a slot connects, clears it when the slot
 * disconnects, feeds press edges and synced timestamps into the model, and
 * starts the match once the manifest minimum of players is present. A slot
 * that disconnects is removed from the model and its layout is cleared; a
 * later packet reconnects it with its score preserved (FR-5.4). During
 * `matchResult` any four-button press edge from a connected slot starts a
 * rematch (GAME-RD-HOST-04).
 *
 * Rendering uses the flat 2D calls that the host's Canvas2D backend exposes
 * (`clear`, `rect`, `circle`, `text`). The SDK's `GameRenderer3D` type does
 * not include them yet, so the adapter feature-detects and simply draws
 * nothing on a renderer without a 2D surface. The host must launch this game
 * with the Canvas2D backend until the SDK exposes the 2D surface (handoff).
 */
import type {
  Game,
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameManifest,
  GameRenderer3D,
  JsonValue,
} from "@lanpad/sdk";
import type { ReactionDuelConfig } from "./model.js";
import {
  ReactionDuelModel,
  type RoundSummary,
} from "./model.js";

/** Layout document id shipped with the game (`layouts/rd-four-button-v1.json`). */
export const REACTION_DUEL_LAYOUT_ID = "rd-four-button-v1";

/** A/B/X/Y labels for button bits 0..3 (A12). */
export const TARGET_LABELS = ["A", "B", "X", "Y"] as const;

/** Distinct shapes so the signal is not colour-only (A12, FR-8.3). */
export const TARGET_SYMBOLS = ["▲", "●", "✕", "■"] as const;

/*
 * DESIGN.md `true-black-flat` tokens; the canvas stays true black and lime is
 * reserved for the live target, so the game is the brightest thing on stage.
 */
const BACKGROUND = "#000000"; // --ground
const FOREGROUND = "#ffffff"; // --text
const MUTED = "#b4b4b4"; // --muted
const ACCENT = "#c6f24e"; // --accent
const WIN = "#c6f24e"; // --positive

/** Design-space coordinates; scaled to the real CSS surface each frame. */
const VIEW_WIDTH = 1280;
const VIEW_HEIGHT = 720;

/** Maximum slots the platform exposes (SPEC §7). */
const MAX_SLOTS = 8;

/** A/B/X/Y button bits (A12); rematch accepts any of them. */
const BUTTON_MASK = 0x0f;

/** CSS size a backend may report; absent on test doubles (HP-04). */
export interface RendererSize {
  readonly width: number;
  readonly height: number;
}

interface Renderer2DLike {
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

/** Optional factory arguments for tests and per-scene tuning. */
export interface ReactionDuelGameOptions {
  /** Overrides for the shipped rules; player counts always come from the manifest. */
  readonly config?: Partial<ReactionDuelConfig>;
  /** Overrides `ctx.rng.seed`; same seed + same inputs = same match. */
  readonly seed?: number;
}

/** The adapter's observable state, used by tests and the debug overlay. */
export interface ReactionDuelGame extends Game {
  /** The running model after `init`, null before init and after dispose. */
  readonly model: ReactionDuelModel | null;
  /** Decision of the most recently finished round (synced stamps inside). */
  readonly lastResult: RoundSummary | null;
  /** Slots whose layout has been requested, in request order. */
  readonly laidOutSlots: ReadonlyArray<number>;
}

function isValidSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 1 && slot <= MAX_SLOTS;
}

/**
 * A slot is present while its controller is connected (FR-8.2). The flag is
 * set by the first packet even when its tick and state are still zero, so a
 * fresh phone gets its layout before clock sync; this is not an input
 * heuristic.
 */
function isPresent(player: GameControllerState): boolean {
  return player.connected;
}

function formatDecision(round: RoundSummary): string {
  const decision = round.decision;
  if (decision.kind === "winner") {
    const elapsed = Math.max(0, Math.round(decision.tick - round.signalAt));
    return `P${decision.slot} wins the round - ${elapsed} ms`;
  }
  switch (decision.reason) {
    case "tie":
      return "Tie - replay round";
    case "no-tap":
      return "No press - replay round";
    case "all-invalid":
      return "False start or miss - replay round";
    default:
      return "Replay round";
  }
}

/**
 * Creates the Reaction Duel `Game`. The default export is the frozen
 * `GameModule` shape; the optional second argument exists for tests only.
 */
export function createReactionDuelGame(
  manifest: GameManifest,
  options: ReactionDuelGameOptions = {},
): ReactionDuelGame {
  let ctx: GameContext | null = null;
  let model: ReactionDuelModel | null = null;
  let surface: Renderer2DLike | null = null;
  let disposed = false;
  let simNowMs = 0;
  let layoutErrorCount = 0;
  /** Uniform design-space -> surface transform, refreshed once per frame. */
  let viewScale = 1;
  let viewOffsetX = 0;
  let viewOffsetY = 0;

  const laidOutSlots: number[] = [];
  /** One bit per present slot (bit N = slot N); no per-tick allocation. */
  let seenMask = 0;

  /** Reused per-tick records; `activeInputs.length` carries the count. */
  const inputRecords: ReactionInputRecord[] = [];
  const activeInputs: ReactionInputRecord[] = [];
  for (let index = 0; index < MAX_SLOTS; index += 1) {
    inputRecords.push({ slot: 0, buttons: 0, edges: 0, tick: 0 });
  }

  /**
   * The model's only clock. Prefer the host's synced server time so stamps
   * are in the same domain as `ControllerState.tick`; before the host joins a
   * room fall back to accumulated simulation time so the countdown still runs.
   */
  function readClock(): number {
    const server = ctx?.serverNow() ?? null;
    return server !== null && Number.isFinite(server) ? server : simNowMs;
  }

  function applyLayout(slot: number): void {
    laidOutSlots.push(slot);
    const layouts = ctx?.layouts;
    if (layouts === undefined) return;
    try {
      layouts.set(slot, REACTION_DUEL_LAYOUT_ID);
    } catch {
      // D5's layout API may not be wired yet; never break the match for it.
      layoutErrorCount += 1;
    }
  }

  function clearLayout(slot: number): void {
    const layouts = ctx?.layouts;
    if (layouts === undefined) return;
    try {
      layouts.clear(slot);
    } catch {
      // As with `set`, a missing layout API must never break the match.
      layoutErrorCount += 1;
    }
  }

  /**
   * Registers a slot that just connected. `addPlayer` adds a fresh slot in the
   * lobby or reconnects a disconnected record at any time without resetting
   * its score (FR-5.4). `seenMask` guarantees one call per connection edge.
   */
  function addConnectedPlayer(slot: number): void {
    model?.addPlayer(slot);
  }

  /**
   * Detects connections and disconnections from this tick's snapshot. Slots
   * are tracked as bits so the per-tick path allocates nothing; a disconnect
   * clears the slot's host layout so a later `set` for the same id is not
   * treated as a duplicate (FR-8.2) and marks the record disconnected so a
   * later packet reconnects it exactly once (FR-5.4).
   */
  function observePlayers(input: GameInputSnapshot): void {
    const players = input.players;
    let presentMask = 0;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined) continue;
      const slot = player.slot;
      if (!isValidSlot(slot) || !isPresent(player)) continue;
      const bit = 1 << slot;
      presentMask |= bit;
      if ((seenMask & bit) !== 0) continue;
      seenMask |= bit;
      applyLayout(slot);
      addConnectedPlayer(slot);
    }

    let gone = seenMask & ~presentMask;
    while (gone !== 0) {
      const bit = gone & -gone;
      gone &= gone - 1;
      const slot = 31 - Math.clz32(bit);
      seenMask &= ~bit;
      clearLayout(slot);
      model?.removePlayer(slot);
    }
  }

  /** True when any connected slot carries an A/B/X/Y press edge this tick. */
  function hasRematchPress(input: GameInputSnapshot): boolean {
    const players = input.players;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isValidSlot(player.slot)) continue;
      if (isPresent(player) && (player.edges & BUTTON_MASK) !== 0) {
        return true;
      }
    }
    return false;
  }

  function fillInputs(input: GameInputSnapshot): readonly ReactionInputRecord[] {
    activeInputs.length = 0;
    const players = input.players;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isValidSlot(player.slot)) continue;
      if (activeInputs.length >= MAX_SLOTS) break;
      const record = inputRecords[activeInputs.length];
      if (record === undefined) break;
      record.slot = player.slot;
      record.buttons = player.buttons;
      record.edges = player.edges;
      record.tick = player.tick;
      activeInputs.push(record);
    }
    return activeInputs;
  }

  /**
   * Paints a string in the 1280x720 design space. Every text call goes
   * through here so prompts, scoreboard and results share one transform.
   */
  function paintText(
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    align: "left" | "center" | "right" = "left",
  ): void {
    surface?.text(
      text,
      viewOffsetX + x * viewScale,
      viewOffsetY + y * viewScale,
      size * viewScale,
      color,
      align,
    );
  }

  function paintCenter(
    text: string,
    y: number,
    size: number,
    color: string,
  ): void {
    paintText(text, VIEW_WIDTH / 2, y, size, color, "center");
  }

  function paintScores(): void {
    const current = model;
    if (current === null || surface === null) return;
    const players = current.getPlayers();
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined) continue;
      const color = current.matchWinnerSlot === player.slot ? WIN : FOREGROUND;
      paintText(
        `P${player.slot}  ${player.score}`,
        80 + index * 150,
        VIEW_HEIGHT - 64,
        32,
        player.connected ? color : MUTED,
        "left",
      );
    }
  }

  function paintPhase(now: number): void {
    const current = model;
    if (current === null || surface === null) return;

    paintCenter("REACTION DUEL", 96, 44, MUTED);
    paintCenter(`Round ${current.roundNumber} - first to 3`, 140, 26, MUTED);

    switch (current.phase) {
      case "lobby": {
        paintCenter("Waiting for players", VIEW_HEIGHT / 2 - 20, 56, FOREGROUND);
        paintCenter(
          `${current.playerCount} of ${manifest.minPlayers} needed`,
          VIEW_HEIGHT / 2 + 44,
          30,
          MUTED,
        );
        break;
      }
      case "countdown": {
        const endsAt = current.phaseEndsAt;
        const seconds =
          endsAt === null ? 0 : Math.max(0, Math.ceil((endsAt - now) / 1000));
        paintCenter("Get ready", VIEW_HEIGHT / 2 - 80, 44, MUTED);
        paintCenter(String(seconds), VIEW_HEIGHT / 2 + 60, 160, ACCENT);
        break;
      }
      case "waiting": {
        paintCenter("Wait…", VIEW_HEIGHT / 2, 120, FOREGROUND);
        paintCenter("Press the matching button", VIEW_HEIGHT / 2 + 96, 32, MUTED);
        break;
      }
      case "signal": {
        const target = current.targetBit;
        if (target === null) break;
        const symbol = TARGET_SYMBOLS[target] ?? "?";
        const label = TARGET_LABELS[target] ?? "?";
        paintCenter(symbol, VIEW_HEIGHT / 2 - 40, 180, ACCENT);
        paintCenter(label, VIEW_HEIGHT / 2 + 120, 96, ACCENT);
        paintCenter("Press now", VIEW_HEIGHT / 2 + 200, 30, FOREGROUND);
        break;
      }
      case "roundResult":
      case "matchResult": {
        const last = current.lastRound;
        if (last !== null) {
          paintCenter(formatDecision(last), VIEW_HEIGHT / 2 - 20, 54, FOREGROUND);
        }
        if (current.phase === "matchResult") {
          paintCenter(
            `P${current.matchWinnerSlot ?? "?"} wins the match!`,
            VIEW_HEIGHT / 2 + 60,
            48,
            WIN,
          );
          paintCenter("Press any button to rematch", VIEW_HEIGHT / 2 + 128, 28, MUTED);
        }
        break;
      }
      default:
        break;
    }
  }

  function updateDebug(): void {
    const current = model;
    if (current === null || ctx === null) return;
    ctx.debug.setCounter("players", current.playerCount);
    ctx.debug.setCounter("round", current.roundNumber);
    ctx.debug.setCounter("target", current.targetBit ?? -1);
    ctx.debug.setCounter("layoutErrors", layoutErrorCount);
  }

  const game: ReactionDuelGame = {
    manifest,
    get model(): ReactionDuelModel | null {
      return model;
    },
    get lastResult(): RoundSummary | null {
      return model?.lastRound ?? null;
    },
    get laidOutSlots(): ReadonlyArray<number> {
      return laidOutSlots;
    },

    init(context: GameContext): void {
      ctx = context;
      surface = resolveRenderer2D(context.renderer);
      simNowMs = 0;
      seenMask = 0;
      laidOutSlots.length = 0;
      layoutErrorCount = 0;
      const config: Partial<ReactionDuelConfig> = {
        ...options.config,
        minPlayers: manifest.minPlayers,
        maxPlayers: manifest.maxPlayers,
      };
      model = new ReactionDuelModel({
        seed: options.seed ?? context.rng.seed,
        clock: readClock,
        config,
      });
      updateDebug();
    },

    simulate(dt: number, input: GameInputSnapshot): void {
      if (disposed || model === null) return;
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      simNowMs += step * 1000;

      // Capture the phase before `update`: the tick that decides the match
      // carries the winning edge and must not also trigger the rematch.
      const resultsOpen = model.phase === "matchResult";
      observePlayers(input);
      model.update(fillInputs(input));
      if (resultsOpen && hasRematchPress(input)) {
        model.rematch();
      }
      if (model.phase === "lobby") {
        model.startMatch();
      }
      updateDebug();
    },

    render(alpha: number): void {
      if (disposed || model === null || surface === null) return;
      const blend = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;

      // One uniform scale for the whole frame: the design space is centred and
      // letterboxed inside the real CSS surface instead of stretching (HP-04).
      const surfaceSize = surface.size;
      viewScale = 1;
      viewOffsetX = 0;
      viewOffsetY = 0;
      if (surfaceSize !== undefined) {
        const width = surfaceSize.width;
        const height = surfaceSize.height;
        if (
          Number.isFinite(width) &&
          width > 0 &&
          Number.isFinite(height) &&
          height > 0
        ) {
          const fitX = width / VIEW_WIDTH;
          const fitY = height / VIEW_HEIGHT;
          viewScale = fitX < fitY ? fitX : fitY;
          viewOffsetX = (width - VIEW_WIDTH * viewScale) / 2;
          viewOffsetY = (height - VIEW_HEIGHT * viewScale) / 2;
        }
      }

      surface.beginFrame(blend);
      surface.clear(BACKGROUND);
      paintPhase(readClock());
      paintScores();
      surface.endFrame();
    },

    onEvent(slot: number, name: string, data: JsonValue): void {
      void slot;
      void data;
      if (disposed || model === null) return;
      if (name === "rematch" && model.phase === "matchResult") {
        model.rematch();
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      model = null;
      ctx = null;
      surface = null;
      seenMask = 0;
      activeInputs.length = 0;
      viewScale = 1;
      viewOffsetX = 0;
      viewOffsetY = 0;
    },
  };

  return game;
}

/** Frozen `GameModule` shape consumed by `loadGame`. */
export default createReactionDuelGame;

/** Model input record; structurally identical to the model's `ReactionInput`. */
interface ReactionInputRecord {
  slot: number;
  buttons: number;
  edges: number;
  tick: number;
}

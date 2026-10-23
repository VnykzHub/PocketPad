/**
 * Sumo Bumpers host adapter (GAME-SB-HOST-01..05, CTRL-02/03).
 *
 * This is the module `loadGame` imports from `game.manifest.json`: a default
 * `(manifest) => Game` factory. It consumes `GameContext` only and uses
 * `@lanpad/game-kit` for the match state machine, the round scoreboard, player
 * identity strings and the bumper pool. Nothing here knows about the broker,
 * the controller or the renderer backend.
 *
 * Round flow comes from `createMatch`:
 *
 *   lobby -> countdown -> playing -> results -> countdown -> ...
 *                                    \-> lobby when a slot reaches 3 round wins
 *
 * `simulate` advances an internal fixed-step clock (it never reads wall time),
 * so a paused host freezes the match instead of skipping the countdown. In the
 * lobby the match auto-starts once `minPlayers` controllers are connected;
 * `onEvent(slot, "start")` also starts it (the plan's host confirmation).
 *
 * Playing: bumpers are acquired from the pool on the first playing tick, each
 * connected stick accelerates its bumper, button bit 0 dashes, the floor
 * shrinks linearly and a bumper whose whole circle is outside the floor is
 * eliminated. When one body remains it wins the round; a simultaneous wipe-out
 * is a draw. A disconnected body keeps its momentum for
 * `disconnectRemovalMs`, then leaves the round; a controller that reconnects
 * inside that grace resumes its body, one that reconnects later spectates
 * until the next round. Nothing is persisted: a host refresh builds a fresh
 * `SumoGame` in the lobby with zero wins (GAME-SB-HOST-05).
 *
 * Every per-tick structure is allocated in `init` and refilled in place:
 * fixed slot arrays, one pooled bumper per slot, one reused contact and one
 * reused input feed. `simulate` and `render` allocate no objects after the
 * first round has warmed the pool.
 */
import type {
  Game,
  GameContext,
  GameControllerState,
  GameInputSnapshot,
  GameManifest,
  JsonValue,
} from "@lanpad/sdk";
import {
  createMatch,
  createPool,
  createScoreboard,
  resultsRows,
  type Match,
  type MatchPhase,
  type Pool,
  type Scoreboard,
} from "@lanpad/game-kit";
import {
  arenaRadiusAt,
  isFullyOutside,
  spawnPoint,
  type ArenaPoint,
} from "./arena.js";
import {
  resolveSumoConfig,
  SUMO_CONFIG,
  type SumoConfig,
  type SumoConfigOptions,
} from "./config.js";
import { SUMO_ELIMINATED_PANEL, SumoHud } from "./hud.js";
import {
  createContact,
  resolveCircleCircle,
  type CircleBody,
} from "./physics.js";
import {
  drawSumo,
  resolveRenderer2D,
  type Renderer2DLike,
  type SumoBumperView,
  type SumoRenderState,
  type SumoResultsRowView,
} from "./render.js";

/** Layout applied to every controller (GAME-SB-CTRL-01/03, dash layout). */
export const SUMO_DASH_LAYOUT_ID = "sb-stick-dash-v1";
/** Stick-only layout from the plan; shipped but not applied by default. */
export const SUMO_STICK_LAYOUT_ID = "sb-stick-v1";

/** Button bit the dash button occupies in both shipped layouts. */
const DASH_BUTTON_BIT = 0;
/** Any A/B/X/Y-style edge advances the results screen; layouts expose bit 0. */
const ADVANCE_BUTTON_MASK = 0x0f;
/** One short pulse per hit; a duration array, never stored or logged. */
const HIT_HAPTIC: readonly number[] = [40];
/** Milliseconds a bumper renders with its dash glow. */
const DASH_TRAIL_MS = 150;
/** Stick magnitude below which input counts as centred. */
const DEADZONE = 0.08;
/** Pool capacity is the plan's maximum; larger manifests are clamped. */
const MAX_SLOTS = 8;
const NEVER = -1_000_000_000;

const PHASE_CODE: Record<MatchPhase, number> = {
  lobby: 0,
  countdown: 1,
  playing: 2,
  results: 3,
};

const READY_PANEL: JsonValue = {
  kind: "text",
  title: "Sumo Bumpers",
  text: "Round starts soon.",
};
const PLAYING_PANEL: JsonValue = {
  kind: "text",
  title: "Sumo Bumpers",
  text: "Stick to move. Dash to shove.",
};
const ELIMINATED_PANEL: JsonValue = {
  kind: "text",
  title: "Out",
  text: SUMO_ELIMINATED_PANEL,
};

/** One live bumper; pooled, never shared between slots. */
export interface SumoBumper extends CircleBody {
  /** 1-based controller slot this body belongs to. */
  slot: number;
  /** False while the controller is disconnected but inside its grace. */
  connected: boolean;
  /** Tick time the disconnect was seen, or -1 while connected. */
  disconnectedAtMs: number;
  /** Earliest tick time the next dash is allowed. */
  dashReadyAtMs: number;
  /** Tick time the dash glow ends; only used for presentation. */
  dashUntilMs: number;
  /** Last haptic pulse time, rate-limited per bumper. */
  lastHapticAtMs: number;
  /** Last non-centred stick direction, used when dashing from rest. */
  lastInputX: number;
  lastInputY: number;
}

/** The adapter's observable state, used by tests and the debug overlay. */
export interface SumoGame extends Game {
  readonly phase: MatchPhase;
  /** Current match round; 0 before the first round. */
  readonly round: number;
  /** Current floor radius, normalized to the short viewport side. */
  readonly arenaRadius: number;
  /** Bumpers still on the floor (including disconnect grace). */
  readonly activeBumperCount: number;
  /** One bit per connected slot (bit N = slot N). */
  readonly connectedMask: number;
  /** Winner of the most recent round, or null for a draw. */
  readonly lastRoundWinner: number | null;
  /** Slot that reached `roundsToWin`, or null while the match is live. */
  readonly matchWinnerSlot: number | null;
  /** Rounds started since this game was created (soak/telemetry counter). */
  readonly roundsPlayed: number;
  /** Round wins indexed slot - 1. */
  readonly wonRounds: ReadonlyArray<number>;
  /** Bumpers currently checked out of the pool. */
  readonly poolActive: number;
  /** Foreign or double pool releases; must stay 0 for a healthy run. */
  readonly poolIgnoredReleases: number;
  /** Live bumper for a slot, or null when it is out or never spawned. */
  bumper(slot: number): SumoBumper | null;
}

/** Factory overrides for tests and per-scene tuning. */
export interface SumoGameOptions {
  readonly config?: SumoConfigOptions;
  /** Auto-start when the lobby has `minPlayers` controllers; default true. */
  readonly autoStart?: boolean;
}

function isConnectedSlot(player: GameControllerState, maxPlayers: number): boolean {
  return (
    player.connected &&
    Number.isInteger(player.slot) &&
    player.slot >= 1 &&
    player.slot <= maxPlayers
  );
}

/** Clamps a stick axis to -1..1; non-finite values read as centred. */
function axis(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

/** Reads the phase without control-flow narrowing at the call site. */
function readPhase(target: Match): MatchPhase {
  return target.phase;
}

function createBumper(): SumoBumper {
  const bumper: SumoBumper = {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 0,
    mass: 1,
    active: false,
    slot: 0,
    connected: false,
    disconnectedAtMs: -1,
    dashReadyAtMs: 0,
    dashUntilMs: 0,
    lastHapticAtMs: NEVER,
    lastInputX: 0,
    lastInputY: 0,
  };
  return bumper;
}

function resetBumper(bumper: SumoBumper): void {
  bumper.x = 0;
  bumper.y = 0;
  bumper.vx = 0;
  bumper.vy = 0;
  bumper.radius = 0;
  bumper.mass = 1;
  bumper.active = false;
  bumper.slot = 0;
  bumper.connected = false;
  bumper.disconnectedAtMs = -1;
  bumper.dashReadyAtMs = 0;
  bumper.dashUntilMs = 0;
  bumper.lastHapticAtMs = NEVER;
  bumper.lastInputX = 0;
  bumper.lastInputY = 0;
}

/**
 * Creates the Sumo Bumpers `Game`. The default export is the frozen
 * `GameModule` shape; the optional second argument exists for tests only.
 */
export function createSumoGame(
  manifest: GameManifest,
  options: SumoGameOptions = {},
): SumoGame {
  const config: SumoConfig = resolveSumoConfig(options.config);
  const autoStart = options.autoStart !== false;

  let ctx: GameContext | null = null;
  let match: Match | null = null;
  let pool: Pool<SumoBumper> | null = null;
  let scoreboard: Scoreboard | null = null;
  let hud: SumoHud | null = null;
  let surface: Renderer2DLike | null = null;
  let renderState: SumoRenderState | null = null;
  let disposed = false;

  let maxPlayers = SUMO_CONFIG.maxPlayers;
  // `Match` does not expose the lobby threshold, so the game retains a copy.
  let lobbyMinPlayers = 2;
  let bySlot: (SumoBumper | null)[] = [];
  let bumperViews: SumoBumperView[] = [];
  let resultsViews: SumoResultsRowView[] = [];
  let wins: number[] = [];

  // Private panels are prebuilt per slot and win count so a phase change only
  // swaps a reference; no JSON object is created on a tick path.
  let resultPanels: JsonValue[][] = [];
  let championPanels: JsonValue[] = [];

  let simTimeMs = 0;
  let roundElapsedMs = 0;
  let arenaRadius = config.arenaStartR;
  let roundStarterCount = 0;
  let activeCount = 0;
  let connectedMask = 0;
  let connectedCount = 0;
  let seenMask = 0;
  let rosterMask = 0;
  let roundWinnerSlot: number | null = null;
  let matchWinnerSlot: number | null = null;
  let lastRoundWinner: number | null = null;
  let resultsAtMs = 0;
  let resultsCount = 0;
  let roundsPlayed = 0;
  let layoutErrors = 0;
  let panelErrors = 0;
  let hapticErrors = 0;
  let poolExhaustions = 0;

  const feed: number[] = [];
  const spawnOut: ArenaPoint = { x: 0, y: 0 };
  const contact = createContact();
  const impactThreshold = config.hitImpactThreshold / config.unitsPerView;

  function bumperAt(slot: number): SumoBumper | null {
    const bumper = bySlot[slot - 1];
    return bumper ?? null;
  }

  function applyLayout(slot: number): void {
    const current = ctx;
    if (current === null) return;
    try {
      current.layouts.set(slot, SUMO_DASH_LAYOUT_ID);
    } catch {
      layoutErrors += 1;
    }
  }

  function clearLayout(slot: number): void {
    const current = ctx;
    if (current === null) return;
    try {
      current.layouts.clear(slot);
    } catch {
      layoutErrors += 1;
    }
  }

  function setPanel(slot: number, content: JsonValue | null): void {
    const current = ctx;
    if (current === null) return;
    try {
      if (content === null) {
        current.panels.clear(slot);
      } else {
        current.panels.set(slot, content);
      }
    } catch {
      panelErrors += 1;
    }
  }

  /** The panel a slot should see in the current phase (reconnect-safe). */
  function panelForSlot(slot: number): JsonValue {
    const current = match;
    if (current !== null && current.phase === "playing") {
      return bumperAt(slot) === null ? ELIMINATED_PANEL : PLAYING_PANEL;
    }
    if (current !== null && current.phase === "results") {
      if (matchWinnerSlot === slot) {
        const champion = championPanels[slot - 1];
        if (champion !== undefined) return champion;
      }
      return resultPanelFor(slot, wins[slot - 1] ?? 0);
    }
    return READY_PANEL;
  }

  /** Pulses one bumper's haptic, rate-limited; a missing API is not fatal. */
  function pulseBumper(bumper: SumoBumper): void {
    if (simTimeMs - bumper.lastHapticAtMs < config.hitHapticCooldownMs) return;
    bumper.lastHapticAtMs = simTimeMs;
    const current = ctx;
    if (current === null) return;
    try {
      current.haptics.pulse(bumper.slot, HIT_HAPTIC);
    } catch {
      hapticErrors += 1;
    }
  }

  /**
   * Tracks connection edges. A new connection applies the layout once and a
   * disconnect clears it once, so a flapping controller does not spam the
   * host. A live bumper keeps playing during its grace window (HOST-04).
   */
  function observePlayers(input: GameInputSnapshot): void {
    const players = input.players;
    let presentMask = 0;
    let presentCount = 0;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      const bit = 1 << player.slot;
      if ((presentMask & bit) !== 0) continue;
      presentMask |= bit;
      presentCount += 1;
      if ((seenMask & bit) === 0) {
        seenMask |= bit;
        applyLayout(player.slot);
        // A reconnect can land mid-round (spectating) or between rounds, so
        // re-send the panel that matches the phase instead of leaving the
        // controller blank after its disconnect cleared it.
        setPanel(player.slot, panelForSlot(player.slot));
      }
      const bumper = bumperAt(player.slot);
      if (bumper !== null) {
        bumper.connected = true;
        bumper.disconnectedAtMs = -1;
      }
    }

    let gone = seenMask & ~presentMask;
    while (gone !== 0) {
      const bit = gone & -gone;
      gone &= gone - 1;
      const slot = 31 - Math.clz32(bit);
      seenMask &= ~bit;
      clearLayout(slot);
      const bumper = bumperAt(slot);
      if (bumper !== null) {
        bumper.connected = false;
        bumper.disconnectedAtMs = simTimeMs;
      }
      setPanel(slot, null);
    }

    connectedMask = presentMask;
    connectedCount = presentCount;
  }

  /** Copies connected slots into a reused array for `Match.update`. */
  function updateMatchFeed(): void {
    feed.length = 0;
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if ((connectedMask & (1 << slot)) !== 0) feed.push(slot);
    }
  }

  function clearBumpers(): void {
    const bumperPool = pool;
    for (let index = 0; index < bySlot.length; index += 1) {
      const bumper = bySlot[index];
      if (bumper === undefined || bumper === null) continue;
      bySlot[index] = null;
      if (bumperPool !== null) bumperPool.release(bumper);
      else bumper.active = false;
    }
    activeCount = 0;
  }

  function removeBumper(bumper: SumoBumper): void {
    const slot = bumper.slot;
    if (slot >= 1 && slot <= maxPlayers && bySlot[slot - 1] === bumper) {
      bySlot[slot - 1] = null;
    }
    const bumperPool = pool;
    if (bumperPool !== null) bumperPool.release(bumper);
    else bumper.active = false;
  }

  function resultPanelFor(slot: number, slotWins: number): JsonValue {
    const row = resultPanels[slot - 1];
    if (row === undefined || row.length === 0) return READY_PANEL;
    const index = Math.max(0, Math.min(row.length - 1, slotWins | 0));
    return row[index] ?? READY_PANEL;
  }

  /** Pushes ready panels to connected controllers entering a countdown. */
  function showReadyPanels(): void {
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if ((connectedMask & (1 << slot)) === 0) continue;
      setPanel(slot, READY_PANEL);
    }
  }

  /** Resets everything that belongs to one match, then shows the countdown. */
  function startMatch(): void {
    rosterMask = connectedMask;
    for (let index = 0; index < wins.length; index += 1) wins[index] = 0;
    const board = scoreboard;
    if (board !== null) {
      board.reset();
      for (let slot = 1; slot <= maxPlayers; slot += 1) {
        if ((rosterMask & (1 << slot)) !== 0) board.set(slot, 0);
      }
    }
    resultsCount = 0;
    roundWinnerSlot = null;
    matchWinnerSlot = null;
    onEnterCountdown();
  }

  /** Called whenever the match enters a countdown (start or next round). */
  function onEnterCountdown(): void {
    clearBumpers();
    roundElapsedMs = 0;
    arenaRadius = config.arenaStartR;
    resultsCount = 0;
    roundWinnerSlot = null;
    matchWinnerSlot = null;
    showReadyPanels();
  }

  /** Countdown collapsed because a roster slot left (match resets to lobby). */
  function onRosterReset(): void {
    clearBumpers();
    roundElapsedMs = 0;
    arenaRadius = config.arenaStartR;
    resultsCount = 0;
    roundWinnerSlot = null;
    matchWinnerSlot = null;
    rosterMask = 0;
    for (let index = 0; index < wins.length; index += 1) wins[index] = 0;
    scoreboard?.reset();
    showReadyPanels();
  }

  /** Spawns one pooled bumper per connected roster slot (HOST-01/TEST-03). */
  function beginRound(): void {
    clearBumpers();
    roundElapsedMs = 0;
    arenaRadius = config.arenaStartR;
    resultsCount = 0;
    roundWinnerSlot = null;
    matchWinnerSlot = null;

    let spawnCount = 0;
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if ((rosterMask & (1 << slot)) !== 0) spawnCount += 1;
    }
    roundStarterCount = spawnCount;

    const bumperPool = pool;
    if (bumperPool === null) return;
    const spawnRadius = config.arenaStartR * config.spawnRingScale;
    let index = 0;
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if ((rosterMask & (1 << slot)) === 0) continue;
      let bumper: SumoBumper | null = null;
      try {
        bumper = bumperPool.acquire();
      } catch {
        poolExhaustions += 1;
        break;
      }
      if (bumper === null) break;
      bumper.slot = slot;
      bumper.radius = config.playerRadius;
      bumper.mass = config.massScale;
      bumper.active = true;
      bumper.connected = (connectedMask & (1 << slot)) !== 0;
      bumper.disconnectedAtMs = bumper.connected ? -1 : simTimeMs;
      bumper.dashReadyAtMs = 0;
      bumper.dashUntilMs = 0;
      bumper.lastHapticAtMs = NEVER;
      bumper.lastInputX = 0;
      bumper.lastInputY = 0;
      bumper.vx = 0;
      bumper.vy = 0;
      spawnPoint(index, spawnCount, spawnRadius, spawnOut);
      bumper.x = spawnOut.x;
      bumper.y = spawnOut.y;
      bySlot[slot - 1] = bumper;
      setPanel(slot, PLAYING_PANEL);
      index += 1;
    }
    activeCount = index;
    roundsPlayed += 1;
  }

  /** Copies the kit's reused ranked rows into retained, per-game rows. */
  function buildResultsRows(): void {
    const board = scoreboard;
    if (board === null) {
      resultsCount = 0;
      return;
    }
    const rows = resultsRows(board.ranked, matchWinnerSlot);
    const count = Math.min(rows.length, resultsViews.length);
    for (let index = 0; index < count; index += 1) {
      const source = rows[index];
      const target = resultsViews[index];
      if (source === undefined || target === undefined) break;
      target.slot = source.slot;
      target.wins = source.score;
      target.label = source.label;
      target.color = source.color;
      target.winner = source.winner;
    }
    resultsCount = count;
  }

  /** Updates private panels for the results phase (round or match). */
  function applyResultsPanels(): void {
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      if ((connectedMask & (1 << slot)) === 0) continue;
      setPanel(slot, panelForSlot(slot));
    }
  }

  /** Ends the round, records the win and opens the results screen (HOST-01). */
  function finishRoundNow(winner: number | null): void {
    const current = match;
    if (current === null || current.phase !== "playing") return;
    roundWinnerSlot = winner;
    lastRoundWinner = winner;
    if (winner !== null) {
      const index = winner - 1;
      const nextWins = (wins[index] ?? 0) + 1;
      wins[index] = nextWins;
      scoreboard?.set(winner, nextWins);
    }
    try {
      current.finishRound(winner);
    } catch {
      return;
    }
    matchWinnerSlot = current.winnerSlot;
    resultsAtMs = simTimeMs;
    buildResultsRows();
    applyResultsPanels();
  }

  /** Applies stick acceleration and the dash edge for every live bumper. */
  function applySteering(input: GameInputSnapshot, dt: number): void {
    const players = input.players;
    const acceleration = config.accel / config.unitsPerView;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      const bumper = bumperAt(player.slot);
      if (bumper === null) continue;
      bumper.connected = true;
      bumper.disconnectedAtMs = -1;

      const lx = axis(player.lx);
      const ly = axis(player.ly);
      const magnitude = Math.sqrt(lx * lx + ly * ly);
      bumper.vx += lx * acceleration * dt;
      bumper.vy += ly * acceleration * dt;
      if (magnitude > DEADZONE) {
        bumper.lastInputX = lx;
        bumper.lastInputY = ly;
      }

      if ((player.edges & (1 << DASH_BUTTON_BIT)) === 0) continue;
      if (simTimeMs < bumper.dashReadyAtMs) continue;

      let dirX = lx;
      let dirY = ly;
      let dirLength = magnitude;
      if (dirLength <= DEADZONE) {
        dirX = bumper.lastInputX;
        dirY = bumper.lastInputY;
        dirLength = Math.sqrt(dirX * dirX + dirY * dirY);
      }
      if (dirLength <= DEADZONE) {
        // No stick history: shove outward from the centre, a last resort that
        // keeps the dash button meaningful for a player standing still.
        const distance = Math.sqrt(bumper.x * bumper.x + bumper.y * bumper.y);
        if (distance <= 0) {
          dirX = 1;
          dirY = 0;
          dirLength = 1;
        } else {
          dirX = bumper.x / distance;
          dirY = bumper.y / distance;
          dirLength = 1;
        }
      }
      dirX /= dirLength;
      dirY /= dirLength;
      const impulse = config.dashImpulse / config.unitsPerView;
      bumper.vx += dirX * impulse;
      bumper.vy += dirY * impulse;
      bumper.dashReadyAtMs = simTimeMs + config.dashCooldownMs;
      bumper.dashUntilMs = simTimeMs + DASH_TRAIL_MS;
    }
  }

  /** Velocity damping plus one integration step for every pooled bumper. */
  function integrateBodies(dt: number): void {
    const damp = 1 / (1 + config.friction * dt);
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      const body = bumperAt(slot);
      if (body === null) continue;
      body.vx *= damp;
      body.vy *= damp;
      body.x += body.vx * dt;
      body.y += body.vy * dt;
    }
  }

  /** One pass over the at-most-28 pairs; reuses a single contact record. */
  function resolveCollisions(): void {
    for (let first = 1; first <= maxPlayers; first += 1) {
      const a = bumperAt(first);
      if (a === null) continue;
      for (let second = first + 1; second <= maxPlayers; second += 1) {
        const b = bumperAt(second);
        if (b === null) continue;
        resolveCircleCircle(a, b, contact, config.restitution);
        if (!contact.hit || contact.impact < impactThreshold) continue;
        pulseBumper(a);
        pulseBumper(b);
      }
    }
  }

  /** Releases bodies whose controller stayed away past the grace window. */
  function removeExpiredDisconnects(): void {
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      const bumper = bumperAt(slot);
      if (bumper === null || bumper.connected || bumper.disconnectedAtMs < 0) {
        continue;
      }
      if (simTimeMs - bumper.disconnectedAtMs >= config.disconnectRemovalMs) {
        removeBumper(bumper);
      }
    }
  }

  /** Eliminates fully-outside bodies and ends a round with last standing. */
  function updateEliminations(): void {
    let alive = 0;
    let survivor = 0;
    for (let slot = 1; slot <= maxPlayers; slot += 1) {
      const bumper = bumperAt(slot);
      if (bumper === null) continue;
      const finite = Number.isFinite(bumper.x) && Number.isFinite(bumper.y);
      if (!finite || isFullyOutside(bumper.x, bumper.y, bumper.radius, arenaRadius)) {
        removeBumper(bumper);
        setPanel(slot, ELIMINATED_PANEL);
        continue;
      }
      alive += 1;
      survivor = slot;
    }
    activeCount = alive;
    if (alive <= 1 && roundStarterCount >= 2) {
      finishRoundNow(alive === 1 ? survivor : null);
    }
  }

  function stepPlaying(dt: number, stepMs: number, input: GameInputSnapshot): void {
    roundElapsedMs += stepMs;
    arenaRadius = arenaRadiusAt(config, roundElapsedMs);
    applySteering(input, dt);
    integrateBodies(dt);
    resolveCollisions();
    removeExpiredDisconnects();
    updateEliminations();
  }

  /** True when any connected controller pressed an action edge. */
  function hasAdvanceEdge(input: GameInputSnapshot): boolean {
    const players = input.players;
    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (player === undefined || !isConnectedSlot(player, maxPlayers)) continue;
      if ((player.edges & ADVANCE_BUTTON_MASK) !== 0) return true;
    }
    return false;
  }

  /** Leaves results: next round countdown, or the lobby after a decided match. */
  function advanceResults(): void {
    const current = match;
    if (current === null || current.phase !== "results") return;
    try {
      current.nextRound(simTimeMs);
    } catch {
      return;
    }
    // Read the phase through a helper: TypeScript narrowed the getter to
    // "results" before the mutating call and cannot see that nextRound()
    // changed it, so a direct comparison would look unreachable.
    if (readPhase(current) === "lobby") {
      // The match was decided. Scores are cleared; a new match can start.
      resultsCount = 0;
      roundWinnerSlot = null;
      matchWinnerSlot = null;
      rosterMask = 0;
      clearBumpers();
      roundElapsedMs = 0;
      arenaRadius = config.arenaStartR;
      for (let index = 0; index < wins.length; index += 1) wins[index] = 0;
      scoreboard?.reset();
      showReadyPanels();
    } else {
      onEnterCountdown();
    }
  }

  /** Handles the two transitions `Match.update` performs on its own. */
  function onPhaseChanged(before: MatchPhase, after: MatchPhase): void {
    if (after === "playing" && before !== "playing") {
      beginRound();
    } else if (after === "lobby" && before === "countdown") {
      onRosterReset();
    }
  }

  function updateDebug(): void {
    const current = ctx;
    if (current === null) return;
    current.debug.setCounter("players", connectedCount);
    current.debug.setCounter("phase", PHASE_CODE[match?.phase ?? "lobby"]);
    current.debug.setCounter("bumpers", activeCount);
    current.debug.setCounter("round", match?.round ?? 0);
    current.debug.setCounter("layoutErrors", layoutErrors);
    current.debug.setCounter("panelErrors", panelErrors);
    current.debug.setCounter("hapticErrors", hapticErrors);
    current.debug.setCounter("poolExhaustions", poolExhaustions);
  }

  function displayRound(): number {
    const current = match;
    if (current === null) return 0;
    return current.phase === "countdown" ? current.round + 1 : current.round;
  }

  /** Refills the retained render state without allocating. */
  function fillRenderState(state: SumoRenderState): void {
    const current = match;
    state.phase = current?.phase ?? "lobby";
    state.round = displayRound();
    state.arenaRadius = arenaRadius;
    state.arenaStartR = config.arenaStartR;
    state.activeCount = activeCount;
    state.connectedMask = connectedMask;
    state.countdownMs = current?.countdownRemainingMs ?? 0;
    state.resultsCount = resultsCount;
    state.roundWinnerSlot = roundWinnerSlot;
    state.matchWinnerSlot = matchWinnerSlot;
    for (let index = 0; index < bumperViews.length; index += 1) {
      const view = bumperViews[index];
      const bumper = bySlot[index];
      if (view === undefined) continue;
      if (bumper === undefined || bumper === null) {
        view.active = false;
        continue;
      }
      view.slot = bumper.slot;
      view.x = bumper.x;
      view.y = bumper.y;
      view.radius = bumper.radius;
      view.connected = bumper.connected;
      view.dashing = bumper.dashUntilMs > simTimeMs;
      view.active = true;
    }
  }

  const game: SumoGame = {
    manifest,

    get phase(): MatchPhase {
      return match?.phase ?? "lobby";
    },
    get round(): number {
      return match?.round ?? 0;
    },
    get arenaRadius(): number {
      return arenaRadius;
    },
    get activeBumperCount(): number {
      return activeCount;
    },
    get connectedMask(): number {
      return connectedMask;
    },
    get lastRoundWinner(): number | null {
      return lastRoundWinner;
    },
    get matchWinnerSlot(): number | null {
      return matchWinnerSlot;
    },
    get roundsPlayed(): number {
      return roundsPlayed;
    },
    get wonRounds(): ReadonlyArray<number> {
      return wins;
    },
    get poolActive(): number {
      return pool?.active ?? 0;
    },
    get poolIgnoredReleases(): number {
      return pool?.ignoredReleases ?? 0;
    },
    bumper(slot: number): SumoBumper | null {
      return bumperAt(slot);
    },

    init(context: GameContext): void {
      ctx = context;
      disposed = false;
      maxPlayers = Math.max(
        2,
        Math.min(MAX_SLOTS, context.manifest.maxPlayers, config.maxPlayers),
      );
      const minPlayers = Math.max(
        2,
        Math.min(MAX_SLOTS, context.manifest.minPlayers),
      );
      lobbyMinPlayers = minPlayers;
      match = createMatch({
        minPlayers,
        maxPlayers,
        countdownMs: config.countdownMs,
        roundsToWin: config.roundsToWin,
      });
      pool = createPool(createBumper, resetBumper, maxPlayers);
      scoreboard = createScoreboard();
      const cache = new SumoHud(minPlayers, maxPlayers, config.roundsToWin);
      hud = cache;
      surface = resolveRenderer2D(context.renderer);

      bySlot = new Array<SumoBumper | null>(maxPlayers).fill(null);
      wins = new Array<number>(maxPlayers).fill(0);
      bumperViews = [];
      resultsViews = [];
      resultPanels = [];
      championPanels = [];
      for (let index = 0; index < maxPlayers; index += 1) {
        const slot = index + 1;
        bumperViews.push({
          slot,
          x: 0,
          y: 0,
          radius: 0,
          active: false,
          connected: false,
          dashing: false,
        });
        resultsViews.push({
          slot,
          wins: 0,
          label: cache.label(slot),
          color: "#ffffff",
          winner: false,
        });
        const perWins: JsonValue[] = [];
        for (let slotWins = 0; slotWins <= config.roundsToWin; slotWins += 1) {
          perWins.push({
            kind: "text",
            title: "Round over",
            text: cache.panelLine(slot, slotWins),
          });
        }
        resultPanels.push(perWins);
        championPanels.push({
          kind: "text",
          title: "Match over",
          text: cache.matchWinnerLine(slot),
        });
      }

      simTimeMs = 0;
      roundElapsedMs = 0;
      arenaRadius = config.arenaStartR;
      roundStarterCount = 0;
      activeCount = 0;
      connectedMask = 0;
      connectedCount = 0;
      seenMask = 0;
      rosterMask = 0;
      roundWinnerSlot = null;
      matchWinnerSlot = null;
      lastRoundWinner = null;
      resultsAtMs = 0;
      resultsCount = 0;
      roundsPlayed = 0;
      layoutErrors = 0;
      panelErrors = 0;
      hapticErrors = 0;
      poolExhaustions = 0;
      feed.length = 0;

      renderState = {
        phase: "lobby",
        round: 0,
        arenaRadius: config.arenaStartR,
        arenaStartR: config.arenaStartR,
        maxPlayers,
        activeCount: 0,
        connectedMask: 0,
        countdownMs: 0,
        hud: cache,
        bumpers: bumperViews,
        wins,
        resultsRows: resultsViews,
        resultsCount: 0,
        roundWinnerSlot: null,
        matchWinnerSlot: null,
      };
    },

    simulate(dt: number, input: GameInputSnapshot): void {
      const current = match;
      if (disposed || current === null || hud === null) return;
      const stepSec = Number.isFinite(dt) && dt > 0 ? dt : 0;
      const stepMs = stepSec * 1000;
      simTimeMs += stepMs;

      observePlayers(input);
      updateMatchFeed();
      const before = current.phase;
      current.update(simTimeMs, feed);
      if (current.phase !== before) onPhaseChanged(before, current.phase);

      if (current.phase === "lobby") {
        if (
          autoStart &&
          connectedCount >= lobbyMinPlayers &&
          current.start(simTimeMs)
        ) {
          startMatch();
        }
      } else if (current.phase === "playing") {
        stepPlaying(stepSec, stepMs, input);
      } else if (current.phase === "results") {
        if (
          simTimeMs - resultsAtMs >= config.resultsMs ||
          hasAdvanceEdge(input)
        ) {
          advanceResults();
        }
      }
      updateDebug();
    },

    render(alpha: number): void {
      const state = renderState;
      const drawSurface = surface;
      if (disposed || state === null || drawSurface === null) return;
      const blend = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
      fillRenderState(state);
      drawSumo(drawSurface, state, blend);
    },

    onEvent(slot: number, name: string, data: JsonValue): void {
      void slot;
      void data;
      const current = match;
      if (disposed || current === null) return;
      if (name === "start" && current.phase === "lobby") {
        if (current.start(simTimeMs)) startMatch();
        updateDebug();
      } else if (
        (name === "rematch" || name === "continue") &&
        current.phase === "results"
      ) {
        advanceResults();
        updateDebug();
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearBumpers();
      pool = null;
      bySlot = [];
      wins = [];
      bumperViews = [];
      resultsViews = [];
      resultPanels = [];
      championPanels = [];
      match = null;
      scoreboard = null;
      hud = null;
      surface = null;
      renderState = null;
      ctx = null;
      connectedMask = 0;
      connectedCount = 0;
      seenMask = 0;
      rosterMask = 0;
      roundStarterCount = 0;
      resultsCount = 0;
      feed.length = 0;
    },
  };

  return game;
}

/** Frozen `GameModule` shape consumed by `loadGame`. */
export default createSumoGame;

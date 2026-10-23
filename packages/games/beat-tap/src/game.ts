/**
 * Beat Tap host adapter (GAME-BT-HOST-01..06; D3-SDK-01, A12).
 *
 * This is the module `loadGame` imports from `game.manifest.json`: a default
 * `(manifest) => Game` factory. It consumes `GameContext` only (FR-7.17).
 *
 * Round flow:
 *
 *   lobby -> countdown -> playing -> results -> (rematch) countdown
 *
 * One song per round. The roster is frozen when the countdown starts; a phone
 * connecting later watches until the next round. A player joining during the
 * countdown restarts it so the couch can assemble. Disconnecting during play
 * never ends the round: the absent player's notes become misses, and if every
 * roster player is gone the song pauses until one reconnects.
 *
 * Judging uses the host audio clock only (GAME-BT-HOST-01). A press is
 * corrected by the player's controller transit time (bounded) and the host
 * calibration offset before it reaches `song.hit`. The chart's own `offsetMs`
 * is folded into the clock. Two phones with different latency are therefore
 * judged against the song, not against the host render frame.
 *
 * The adapter owns all mutable state and reuses every object and array per
 * tick. `simulate` and `render` allocate nothing; HUD strings are cached in
 * `hud.ts` and results strings are built once when the song ends.
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
  countdownLabel,
  createMatch,
  createScoreboard,
  type Match,
  type Scoreboard,
} from "@lanpad/game-kit";
import {
  BEAT_TAP_CONFIG,
  CALIBRATE_BIT,
  CALIBRATE_LAYOUT_ID,
  JUDGE_WINDOWS,
  MAX_PLAYERS,
  laneBitForIndex,
  laneSlotsForKind,
  lanePartition,
  layoutIdForCount,
  layoutKindForId,
  type SinglePlayerLayout,
} from "./config.js";
import { firstChart, chartById, validateChartPack, type ChartItem } from "./chart.js";
import { createSongClock } from "./clock.js";
import {
  calibrationBeatPhase,
  clearCalibrationOffset,
  createBrowserCalibrationStorage,
  createCalibrationSession,
  loadCalibrationOffset,
  sampleCalibrationTap,
  saveCalibrationOffset,
  type CalibrationSession,
  type CalibrationStorage,
} from "./calibration.js";
import { BeatTapHud, buildResults, type BeatTapResults } from "./hud.js";
import { applyJudgment, createPlayerStats, resetPlayerStats, type PlayerStats } from "./judge.js";
import {
  drawBeatTap,
  resolveRenderer2D,
  type BeatTapPhase,
  type BeatTapRenderState,
  type CalibrationView,
  type Renderer2DLike,
} from "./render.js";
import { createSongRuntime, type SongRuntime } from "./song.js";
import chartPackData from "../packs/charts-demo-v1.json";

/** Layout id of the calibration document shipped in `layouts/`. */
export { CALIBRATE_LAYOUT_ID } from "./config.js";

/** Optional factory arguments for tests and per-host tuning. */
export interface BeatTapGameOptions {
  /** Untrusted chart pack override; defaults to the shipped demo pack. */
  readonly chartPack?: unknown;
  /** Selects one chart from the pack; defaults to the first. */
  readonly chartId?: string;
  /** Overrides the countdown; 0 starts play on the next tick. */
  readonly countdownMs?: number;
  /** Single-player layout family; buttons by default. */
  readonly singlePlayerLayout?: SinglePlayerLayout;
  /** Calibration storage seam; defaults to guarded localStorage. */
  readonly calibrationStorage?: CalibrationStorage;
  /** Suppresses the beat pulse and calibration animation (GAME-BT-HOST-05). */
  readonly reducedMotion?: boolean;
}

/** The adapter's observable state, used by tests and the debug counters. */
export interface BeatTapGame extends Game {
  readonly phase: BeatTapPhase;
  readonly chart: ChartItem | null;
  /** Song position in milliseconds; frozen while paused. */
  readonly songTimeMs: number;
  readonly calibrationOffsetMs: number;
  /** Frozen roster for the current song, ascending. */
  readonly rosterSlots: readonly number[];
  /** Slot owning each lane, index 0..3; 0 when unowned. */
  readonly laneOwners: readonly number[];
  readonly lastResults: BeatTapResults | null;
  readonly scoreboard: Scoreboard;
  /** Per-slot stats indexed by slot - 1. */
  readonly playerStats: readonly PlayerStats[];
  readonly isPaused: boolean;
  /** Freezes the song clock and judging; ignored outside playing. */
  pause(): void;
  resume(): void;
  /** Starts tap-to-beat calibration for one connected slot. */
  startCalibration(slot?: number): boolean;
  /** Clears the stored offset and returns to 0 ms. */
  resetCalibration(): void;
}

type MutableRenderState = {
  -readonly [K in keyof BeatTapRenderState]: BeatTapRenderState[K];
};
type MutableCalibrationView = {
  -readonly [K in keyof CalibrationView]: CalibrationView[K];
};

const EMPTY_NOTES: readonly ChartItem["notes"][number][] = [];
const EMPTY_JUDGED = new Uint8Array(0);
const PHASE_CODES: Record<BeatTapPhase, number> = {
  lobby: 0,
  calibrating: 1,
  countdown: 2,
  playing: 3,
  paused: 4,
  results: 5,
};

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function slotBit(slot: number): number {
  return 1 << (slot - 1);
}

/**
 * Creates the Beat Tap `Game`. The default export is the frozen `GameModule`
 * shape; the optional second argument exists for tests.
 */
export function createBeatTapGame(
  manifest: GameManifest,
  options: BeatTapGameOptions = {},
): BeatTapGame {
  const maxPlayers = Math.max(1, Math.min(manifest.maxPlayers, MAX_PLAYERS));
  const minPlayers = Math.max(1, Math.min(manifest.minPlayers, maxPlayers));
  const countdownMs =
    options.countdownMs !== undefined && isFiniteNonNegative(options.countdownMs)
      ? Math.floor(options.countdownMs)
      : BEAT_TAP_CONFIG.countdownMs;
  const singlePlayerLayout: SinglePlayerLayout = options.singlePlayerLayout ?? "lanes";
  const reducedMotion = options.reducedMotion ?? false;
  const calibrationStorage =
    options.calibrationStorage ?? createBrowserCalibrationStorage();

  let ctx: GameContext | null = null;
  let surface: Renderer2DLike | null = null;
  let hud: BeatTapHud | null = null;
  let match: Match | null = null;
  let scoreboard: Scoreboard = createScoreboard();
  let chart: ChartItem | null = null;
  let song: SongRuntime | null = null;
  let calibration: CalibrationSession | null = null;
  let calibrationSlot = 0;
  let calibrationView: MutableCalibrationView | null = null;
  let renderState: MutableRenderState | null = null;
  let disposed = false;

  const songClock = createSongClock();
  let offsetMs = 0;
  let chartTitle = "";
  let beatMs = 500;
  let hostNowMs = 0;
  let songTimeMs = 0;
  let lastAudioNowMs = 0;
  let paused = false;
  let pausedByDisconnect = false;
  let connectedMask = 0;
  let connectedCount = 0;
  let layoutErrorCount = 0;
  let judgmentLine = "";
  let judgmentRemainingMs = 0;
  let messageLine = "";
  let messageRemainingMs = 0;
  let lastHitSlot = 0;
  let results: BeatTapResults | null = null;

  const connectedSlots: number[] = [];
  const matchSlots: number[] = [];
  const rosterSlots: number[] = [];
  const layoutIds: string[] = ["", "", "", "", "", "", "", ""];
  const laneOwners: number[] = [0, 0, 0, 0];
  const scoreLines: string[] = ["", "", "", ""];
  const stats: PlayerStats[] = [];
  for (let index = 0; index < 8; index += 1) {
    stats.push(createPlayerStats());
  }

  function currentPhase(): BeatTapPhase {
    if (calibration !== null) {
      return "calibrating";
    }
    if (paused) {
      return "paused";
    }
    return match?.phase ?? "lobby";
  }

  /**
   * One audio-clock read per tick. `ctx.audio.now()` is the master clock
   * (GAME-BT-HOST-01); wall time is never consulted.
   */
  function audioNowMs(): number {
    if (ctx === null) {
      return lastAudioNowMs;
    }
    const value = ctx.audio.now() * 1000;
    if (Number.isFinite(value) && value >= 0) {
      lastAudioNowMs = value;
    }
    return lastAudioNowMs;
  }

  function setMessage(text: string, durationMs: number): void {
    messageLine = text;
    messageRemainingMs = durationMs;
  }

  function isConnectedSlot(slot: number): boolean {
    return (
      Number.isInteger(slot) &&
      slot >= 1 &&
      slot <= 8 &&
      (connectedMask & slotBit(slot)) !== 0
    );
  }

  function isMatchSlot(slot: number): boolean {
    for (let index = 0; index < matchSlots.length; index += 1) {
      if (matchSlots[index] === slot) {
        return true;
      }
    }
    return false;
  }

  function isRosterSlot(slot: number): boolean {
    for (let index = 0; index < rosterSlots.length; index += 1) {
      if (rosterSlots[index] === slot) {
        return true;
      }
    }
    return false;
  }

  function findPlayer(
    input: GameInputSnapshot,
    slot: number,
  ): GameControllerState | undefined {
    for (let index = 0; index < input.players.length; index += 1) {
      const player = input.players[index];
      if (player !== undefined && player.slot === slot) {
        return player;
      }
    }
    return undefined;
  }

  function clearLaneOwners(): void {
    laneOwners[0] = 0;
    laneOwners[1] = 0;
    laneOwners[2] = 0;
    laneOwners[3] = 0;
  }

  function computeLaneOwners(): void {
    clearLaneOwners();
    const parts = lanePartition(rosterSlots.length);
    for (let rank = 0; rank < rosterSlots.length; rank += 1) {
      const slot = rosterSlots[rank];
      const lanes = parts[rank];
      if (slot === undefined || lanes === undefined) {
        continue;
      }
      for (let index = 0; index < lanes.length; index += 1) {
        const lane = lanes[index];
        if (lane !== undefined) {
          laneOwners[lane] = slot;
        }
      }
    }
  }

  function resetRoundState(): void {
    song?.reset();
    scoreboard.reset();
    for (let index = 0; index < stats.length; index += 1) {
      const entry = stats[index];
      if (entry !== undefined) {
        resetPlayerStats(entry);
      }
    }
    songClock.reset();
    songTimeMs = 0;
    paused = false;
    pausedByDisconnect = false;
    lastHitSlot = 0;
    judgmentLine = "";
    judgmentRemainingMs = 0;
    results = null;
    hud?.reset();
  }

  /** Removes calibration state; the stored offset is untouched. */
  function cancelCalibration(announce: boolean): void {
    if (calibration === null) {
      return;
    }
    calibration = null;
    calibrationSlot = 0;
    if (announce) {
      setMessage("Calibration cancelled", BEAT_TAP_CONFIG.calibrationMessageMs);
    }
  }

  function startCalibration(slot?: number): boolean {
    if (disposed || ctx === null || match === null || calibration !== null) {
      return false;
    }
    if (match.phase === "playing") {
      return false;
    }
    let target = slot ?? 0;
    if (target === 0) {
      for (let index = 0; index < connectedSlots.length; index += 1) {
        const candidate = connectedSlots[index];
        if (candidate !== undefined) {
          target = candidate;
          break;
        }
      }
    }
    if (!isConnectedSlot(target)) {
      return false;
    }
    if (match.phase === "countdown") {
      // Calibration must not run while the countdown is ticking: return to the
      // lobby, calibrate, then let the lobby restart a fresh countdown.
      match.reset();
      rosterSlots.length = 0;
      clearLaneOwners();
      resetRoundState();
    }
    calibration = createCalibrationSession(audioNowMs());
    calibrationSlot = target;
    judgmentLine = "";
    judgmentRemainingMs = 0;
    messageLine = "";
    messageRemainingMs = 0;
    refreshLayouts();
    return true;
  }

  function resetCalibration(): void {
    if (disposed) {
      return;
    }
    cancelCalibration(false);
    offsetMs = 0;
    clearCalibrationOffset(calibrationStorage);
    setMessage("Calibration reset", BEAT_TAP_CONFIG.calibrationMessageMs);
  }

  /**
   * Layout for a slot right now. During playing only the frozen roster gets a
   * lane layout; a late phone stays a spectator with no controls. Calibration
   * temporarily replaces the calibrating slot's document.
   */
  function desiredLayoutId(slot: number): string | null {
    if (ctx === null || match === null || !isConnectedSlot(slot)) {
      return null;
    }
    if (calibration !== null && slot === calibrationSlot) {
      return CALIBRATE_LAYOUT_ID;
    }
    if (match.phase === "lobby") {
      return isMatchSlot(slot)
        ? layoutIdForCount(matchSlots.length, singlePlayerLayout)
        : null;
    }
    return isRosterSlot(slot)
      ? layoutIdForCount(rosterSlots.length, singlePlayerLayout)
      : null;
  }

  function applyLayout(slot: number, layoutId: string | null): void {
    const index = slot - 1;
    if (index < 0 || index >= 8) {
      return;
    }
    const current = layoutIds[index] ?? "";
    if (layoutId === null) {
      if (current === "") {
        return;
      }
      layoutIds[index] = "";
      try {
        ctx?.layouts.clear(slot);
      } catch {
        layoutErrorCount += 1;
      }
      return;
    }
    if (current === layoutId) {
      return;
    }
    layoutIds[index] = layoutId;
    try {
      ctx?.layouts.set(slot, layoutId);
    } catch {
      layoutIds[index] = "";
      layoutErrorCount += 1;
    }
  }

  /** Idempotent: layouts already matching are not re-sent to the phone. */
  function refreshLayouts(): void {
    if (ctx === null || match === null) {
      return;
    }
    for (let slot = 1; slot <= 8; slot += 1) {
      applyLayout(slot, desiredLayoutId(slot));
    }
  }

  function onMatchStarted(): void {
    rosterSlots.length = 0;
    for (let index = 0; index < matchSlots.length; index += 1) {
      const slot = matchSlots[index];
      if (slot !== undefined) {
        rosterSlots.push(slot);
      }
    }
    rosterSlots.sort((a, b) => a - b);
    computeLaneOwners();
    resetRoundState();
    messageLine = "";
    messageRemainingMs = 0;
    refreshLayouts();
  }

  function onMatchResetToLobby(): void {
    rosterSlots.length = 0;
    clearLaneOwners();
    resetRoundState();
  }

  function beginSong(nowAudioMs: number): void {
    if (ctx === null || chart === null || song === null) {
      return;
    }
    resetRoundState();
    songTimeMs = 0;
    songClock.start(nowAudioMs, chart.offsetMs);
    messageLine = "";
    messageRemainingMs = 0;
    refreshLayouts();
    try {
      ctx.audio.playMusic(chart.audio, { loop: false });
    } catch {
      // A missing cue is silent by contract (FR-9.11); never break the round.
    }
  }

  function pickWinner(): number | null {
    let winner: number | null = null;
    let bestScore = 0;
    let bestCombo = -1;
    for (let index = 0; index < rosterSlots.length; index += 1) {
      const slot = rosterSlots[index];
      if (slot === undefined) {
        continue;
      }
      const score = scoreboard.get(slot);
      if (score <= 0) {
        continue;
      }
      const entry = stats[slot - 1];
      const maxCombo = entry?.maxCombo ?? 0;
      if (score > bestScore || (score === bestScore && maxCombo > bestCombo)) {
        winner = slot;
        bestScore = score;
        bestCombo = maxCombo;
      }
    }
    return winner;
  }

  function endSong(): void {
    if (ctx === null || match === null || chart === null) {
      return;
    }
    song?.finish();
    songTimeMs = chart.durationMs;
    paused = false;
    pausedByDisconnect = false;
    try {
      ctx.audio.stopMusic(0);
    } catch {
      // Nothing to stop on a silent host.
    }
    const winner = pickWinner();
    match.finishRound(null);
    results = hud === null ? null : buildResults(scoreboard, stats, rosterSlots, winner);
  }

  function applyHit(slot: number, judgment: "perfect" | "good" | "miss"): void {
    const entry = stats[slot - 1];
    if (entry === undefined) {
      return;
    }
    const points = applyJudgment(entry, judgment);
    if (points > 0) {
      scoreboard.add(slot, points);
    }
    lastHitSlot = slot;
    judgmentLine =
      judgment === "perfect" ? "PERFECT" : judgment === "good" ? "GOOD" : "MISS";
    judgmentRemainingMs = BEAT_TAP_CONFIG.judgmentMessageMs;
  }

  function onMissLane(lane: number): void {
    const slot = laneOwners[lane] ?? 0;
    if (slot <= 0) {
      return;
    }
    const entry = stats[slot - 1];
    if (entry === undefined) {
      return;
    }
    applyJudgment(entry, "miss");
    lastHitSlot = slot;
    judgmentLine = "MISS";
    judgmentRemainingMs = BEAT_TAP_CONFIG.judgmentMessageMs;
  }

  /** Rebuilds presence arrays in place; never allocates. */
  function scanInput(input: GameInputSnapshot): void {
    connectedSlots.length = 0;
    matchSlots.length = 0;
    connectedMask = 0;
    connectedCount = 0;
    for (let index = 0; index < input.players.length; index += 1) {
      const player = input.players[index];
      if (player === undefined || !player.connected) {
        continue;
      }
      const slot = player.slot;
      if (!Number.isInteger(slot) || slot < 1 || slot > 8) {
        continue;
      }
      const bit = slotBit(slot);
      if ((connectedMask & bit) !== 0) {
        continue;
      }
      connectedMask |= bit;
      connectedCount += 1;
      connectedSlots.push(slot);
      if (matchSlots.length < maxPlayers) {
        matchSlots.push(slot);
      }
    }
  }

  function handleConnectionEdges(previousMask: number): void {
    const changed = previousMask ^ connectedMask;
    if (changed === 0 || match === null) {
      return;
    }
    let joinedDuringCountdown = false;
    for (let slot = 1; slot <= 8; slot += 1) {
      const bit = slotBit(slot);
      if ((changed & bit) === 0) {
        continue;
      }
      const connectedNow = (connectedMask & bit) !== 0;
      if (!connectedNow) {
        if (calibrationSlot === slot) {
          cancelCalibration(false);
        }
        continue;
      }
      if (match.phase === "countdown" && calibration === null && isMatchSlot(slot)) {
        joinedDuringCountdown = true;
      }
    }
    if (joinedDuringCountdown) {
      // A phone joined before the song: restart the countdown for the full
      // couch instead of making the newcomer watch the whole song.
      match.reset();
      rosterSlots.length = 0;
      clearLaneOwners();
      resetRoundState();
    }
  }

  /**
   * Audio timestamp of the player's press: the packet's controller `tick` is
   * on the server clock, so the bounded transit is subtracted before judging
   * (GAME-BT-HOST-03, E9). Missing or implausible values fall back to now.
   */
  function pressAudioMs(player: GameControllerState, nowAudioMs: number): number {
    if (ctx === null) {
      return nowAudioMs;
    }
    const serverNow = ctx.serverNow();
    if (
      serverNow === null ||
      !Number.isFinite(serverNow) ||
      !Number.isFinite(player.tick) ||
      player.tick <= 0
    ) {
      return nowAudioMs;
    }
    const transitMs = serverNow - player.tick;
    if (transitMs <= 0 || transitMs > BEAT_TAP_CONFIG.maxTransitMs) {
      return nowAudioMs;
    }
    return nowAudioMs - transitMs;
  }

  function processCalibratePress(input: GameInputSnapshot): boolean {
    if (match === null || match.phase === "playing") {
      return false;
    }
    for (let index = 0; index < input.players.length; index += 1) {
      const player = input.players[index];
      if (player === undefined || !player.connected) {
        continue;
      }
      if ((player.edges & (1 << CALIBRATE_BIT)) === 0) {
        continue;
      }
      if (startCalibration(player.slot)) {
        return true;
      }
    }
    return false;
  }

  function processCalibration(input: GameInputSnapshot, nowAudioMs: number): void {
    if (calibration === null) {
      return;
    }
    if (!isConnectedSlot(calibrationSlot)) {
      cancelCalibration(false);
      return;
    }
    const player = findPlayer(input, calibrationSlot);
    if (player === undefined || !player.connected) {
      return;
    }
    if ((player.edges & (1 << CALIBRATE_BIT)) !== 0) {
      cancelCalibration(true);
      return;
    }
    if ((player.edges & 1) === 0) {
      return;
    }
    const completed = sampleCalibrationTap(
      calibration,
      pressAudioMs(player, nowAudioMs),
    );
    if (completed === null) {
      return;
    }
    offsetMs = completed;
    saveCalibrationOffset(calibrationStorage, offsetMs);
    calibration = null;
    calibrationSlot = 0;
    setMessage("Calibration saved", BEAT_TAP_CONFIG.calibrationMessageMs);
  }

  function processPlayingInput(input: GameInputSnapshot, nowAudioMs: number): void {
    if (song === null || rosterSlots.length === 0) {
      return;
    }
    const parts = lanePartition(rosterSlots.length);
    for (let index = 0; index < input.players.length; index += 1) {
      const player = input.players[index];
      if (player === undefined || !player.connected) {
        continue;
      }
      let rank = -1;
      for (let rosterIndex = 0; rosterIndex < rosterSlots.length; rosterIndex += 1) {
        if (rosterSlots[rosterIndex] === player.slot) {
          rank = rosterIndex;
          break;
        }
      }
      if (rank < 0) {
        continue;
      }
      const kind = layoutKindForId(layoutIds[player.slot - 1] ?? "");
      const partition = parts[rank];
      if (kind === null || partition === undefined) {
        continue;
      }
      const laneCount = Math.min(partition.length, laneSlotsForKind(kind));
      const pressSongMs = songClock.timeMs(pressAudioMs(player, nowAudioMs));
      for (let laneIndex = 0; laneIndex < laneCount; laneIndex += 1) {
        const bit = laneBitForIndex(kind, laneIndex);
        if (bit < 0 || (player.edges & (1 << bit)) === 0) {
          continue;
        }
        const lane = partition[laneIndex];
        if (lane === undefined) {
          continue;
        }
        const judgment = song.hit(lane, pressSongMs - offsetMs);
        if (judgment !== null) {
          applyHit(player.slot, judgment);
        }
      }
    }
  }

  function processRematchPress(input: GameInputSnapshot): boolean {
    if (match === null || match.phase !== "results") {
      return false;
    }
    for (let index = 0; index < input.players.length; index += 1) {
      const player = input.players[index];
      if (player === undefined || !player.connected || !isRosterSlot(player.slot)) {
        continue;
      }
      const kind = layoutKindForId(layoutIds[player.slot - 1] ?? "");
      if (kind === null) {
        continue;
      }
      const laneCount = laneSlotsForKind(kind);
      for (let laneIndex = 0; laneIndex < laneCount; laneIndex += 1) {
        const bit = laneBitForIndex(kind, laneIndex);
        if (bit >= 0 && (player.edges & (1 << bit)) !== 0) {
          return true;
        }
      }
    }
    return false;
  }

  function rematch(): void {
    if (ctx === null || match === null || match.phase !== "results" || calibration !== null) {
      return;
    }
    // A draw never sets a match winner, so this returns to the countdown; if a
    // later mode ends the match, `onMatchStarted` refreshes the roster anyway.
    match.nextRound(hostNowMs);
    resetRoundState();
    refreshLayouts();
  }

  function countRosterConnected(): number {
    let count = 0;
    for (let index = 0; index < rosterSlots.length; index += 1) {
      const slot = rosterSlots[index];
      if (slot !== undefined && (connectedMask & slotBit(slot)) !== 0) {
        count += 1;
      }
    }
    return count;
  }

  function updateDebug(): void {
    if (ctx === null) {
      return;
    }
    ctx.debug.setCounter("beatTap.phase", PHASE_CODES[currentPhase()]);
    ctx.debug.setCounter("beatTap.songMs", Math.round(songTimeMs));
    ctx.debug.setCounter("beatTap.judged", song?.judgedCount ?? 0);
    ctx.debug.setCounter("beatTap.notes", song?.noteCount ?? 0);
    ctx.debug.setCounter("beatTap.players", connectedCount);
    ctx.debug.setCounter("beatTap.offsetMs", offsetMs);
    ctx.debug.setCounter("beatTap.layoutErrors", layoutErrorCount);
  }

  function createRenderState(): MutableRenderState {
    return {
      phase: "lobby",
      chartTitle: "",
      songTimeMs: 0,
      durationMs: 0,
      beatMs,
      approachMs: BEAT_TAP_CONFIG.approachMs,
      missMs: BEAT_TAP_CONFIG.missMs,
      laneOwner: laneOwners,
      roster: rosterSlots,
      notes: EMPTY_NOTES,
      judged: EMPTY_JUDGED,
      scoreLines,
      comboLine: "",
      countdownLabel: "",
      judgmentLine: "",
      calibration: null,
      results: null,
      messageLine: "",
      offsetLine: "",
      reducedMotion,
    };
  }

  const game: BeatTapGame = {
    manifest,

    init(context: GameContext): void {
      if (disposed || ctx !== null) {
        return;
      }
      ctx = context;
      surface = resolveRenderer2D(context.renderer);
      hud = new BeatTapHud();
      scoreboard = createScoreboard();
      calibrationView = {
        taps: 0,
        required: BEAT_TAP_CONFIG.calibrationTaps,
        pulse: 0,
        offsetLine: "",
        line: "",
      };
      renderState = createRenderState();
      const validation = validateChartPack(options.chartPack ?? chartPackData);
      if (!validation.ok) {
        throw new Error(
          `Beat Tap chart pack is invalid: ${validation.errors.join("; ")}`,
        );
      }
      const selected =
        options.chartId === undefined
          ? firstChart(validation.pack)
          : chartById(validation.pack, options.chartId);
      if (selected === null) {
        throw new Error(`Beat Tap chart "${options.chartId ?? ""}" is not in the pack.`);
      }
      chart = selected;
      chartTitle = selected.title;
      beatMs = 60000 / selected.bpm;
      song = createSongRuntime(selected, JUDGE_WINDOWS, onMissLane);
      match = createMatch({ minPlayers, maxPlayers, countdownMs });
      offsetMs = loadCalibrationOffset(calibrationStorage);
      hostNowMs = 0;
      connectedMask = 0;
      connectedCount = 0;
      updateDebug();
    },

    get phase(): BeatTapPhase {
      return currentPhase();
    },
    get chart(): ChartItem | null {
      return chart;
    },
    get songTimeMs(): number {
      return songTimeMs;
    },
    get calibrationOffsetMs(): number {
      return offsetMs;
    },
    get rosterSlots(): readonly number[] {
      return rosterSlots;
    },
    get laneOwners(): readonly number[] {
      return laneOwners;
    },
    get lastResults(): BeatTapResults | null {
      return results;
    },
    get scoreboard(): Scoreboard {
      return scoreboard;
    },
    get playerStats(): readonly PlayerStats[] {
      return stats;
    },
    get isPaused(): boolean {
      return paused;
    },

    pause(): void {
      if (disposed || match?.phase !== "playing" || paused) {
        return;
      }
      paused = true;
      pausedByDisconnect = false;
      songClock.pause(audioNowMs());
    },

    resume(): void {
      if (disposed || !paused) {
        return;
      }
      paused = false;
      pausedByDisconnect = false;
      songClock.resume(audioNowMs());
    },

    startCalibration,

    resetCalibration,

    simulate(dt: number, input: GameInputSnapshot): void {
      if (
        disposed ||
        ctx === null ||
        match === null ||
        chart === null ||
        song === null
      ) {
        return;
      }
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      hostNowMs += step * 1000;
      const nowAudio = audioNowMs();

      if (judgmentRemainingMs > 0) {
        judgmentRemainingMs -= step * 1000;
        if (judgmentRemainingMs <= 0) {
          judgmentRemainingMs = 0;
          judgmentLine = "";
        }
      }
      if (messageRemainingMs > 0) {
        messageRemainingMs -= step * 1000;
        if (messageRemainingMs <= 0) {
          messageRemainingMs = 0;
          messageLine = "";
        }
      }

      const previousMask = connectedMask;
      scanInput(input);
      handleConnectionEdges(previousMask);

      if (calibration !== null) {
        processCalibration(input, nowAudio);
      } else {
        processCalibratePress(input);
      }

      const phaseBefore = match.phase;
      match.update(hostNowMs, matchSlots);

      if (phaseBefore !== "lobby" && match.phase === "lobby") {
        onMatchResetToLobby();
      }
      if (
        match.phase === "lobby" &&
        calibration === null &&
        matchSlots.length >= minPlayers
      ) {
        if (match.start(hostNowMs)) {
          onMatchStarted();
        }
      }
      if (phaseBefore === "countdown" && match.phase === "playing") {
        beginSong(nowAudio);
      }

      if (match.phase === "playing" && calibration === null) {
        const rosterConnected = countRosterConnected();
        if (rosterConnected === 0) {
          if (!paused) {
            paused = true;
            pausedByDisconnect = true;
            songClock.pause(nowAudio);
          }
        } else if (paused && pausedByDisconnect) {
          paused = false;
          pausedByDisconnect = false;
          songClock.resume(nowAudio);
        }

        songTimeMs = songClock.timeMs(nowAudio);
        if (!paused) {
          // Presses are judged before misses expire: a packet that arrives a
          // few milliseconds late still carries the player's send time.
          processPlayingInput(input, nowAudio);
          song.advance(songTimeMs);
          if (match.phase === "playing" && songTimeMs >= chart.durationMs) {
            endSong();
          }
        }
      } else if (match.phase === "results" && calibration === null) {
        if (processRematchPress(input)) {
          rematch();
        }
      }

      refreshLayouts();
      updateDebug();
    },

    render(alpha: number): void {
      const state = renderState;
      const view = calibrationView;
      if (
        disposed ||
        state === null ||
        surface === null ||
        hud === null ||
        view === null
      ) {
        return;
      }
      const blend = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0;
      const lines = scoreLines;
      for (let rank = 0; rank < rosterSlots.length && rank < lines.length; rank += 1) {
        const slot = rosterSlots[rank];
        if (slot === undefined) {
          continue;
        }
        const entry = stats[slot - 1];
        lines[rank] = hud.lineFor(slot, scoreboard.get(slot), entry?.combo ?? 0);
      }
      state.phase = currentPhase();
      state.chartTitle = chartTitle;
      state.songTimeMs = songTimeMs;
      state.durationMs = chart?.durationMs ?? 0;
      state.beatMs = beatMs;
      state.notes = chart?.notes ?? EMPTY_NOTES;
      state.judged = song?.judged ?? EMPTY_JUDGED;
      state.scoreLines = lines;
      state.comboLine =
        match?.phase === "playing" && lastHitSlot > 0
          ? hud.comboLine(lastHitSlot, stats[lastHitSlot - 1]?.combo ?? 0)
          : "";
      state.countdownLabel =
        match?.phase === "countdown"
          ? countdownLabel(match.countdownRemainingMs)
          : "";
      state.judgmentLine = judgmentRemainingMs > 0 ? judgmentLine : "";
      state.results = results;
      state.messageLine = messageRemainingMs > 0 ? messageLine : "";
      state.offsetLine = hud.offsetLine(offsetMs);
      if (calibration !== null) {
        view.taps = calibration.taps;
        view.required = calibration.requiredTaps;
        view.pulse = calibrationBeatPhase(calibration, lastAudioNowMs);
        view.offsetLine = hud.offsetLine(offsetMs);
        view.line = hud.calibrationLine(calibration.taps, calibration.requiredTaps);
        state.calibration = view;
      } else {
        state.calibration = null;
      }
      drawBeatTap(surface, state, blend);
    },

    onEvent(slot: number, name: string, data: JsonValue): void {
      void data;
      if (disposed) {
        return;
      }
      if (name === "rematch") {
        rematch();
        return;
      }
      if (name === "bt.calibrate") {
        startCalibration(slot);
        return;
      }
      if (name === "bt.resetCalibration") {
        resetCalibration();
      }
    },

    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      ctx = null;
      surface = null;
      hud = null;
      match = null;
      song = null;
      chart = null;
      calibration = null;
      calibrationView = null;
      renderState = null;
      rosterSlots.length = 0;
      connectedSlots.length = 0;
      matchSlots.length = 0;
      connectedMask = 0;
      connectedCount = 0;
      paused = false;
      pausedByDisconnect = false;
      results = null;
      clearLaneOwners();
    },
  };

  return game;
}

/** Frozen `GameModule` shape consumed by `loadGame`. */
export default createBeatTapGame;

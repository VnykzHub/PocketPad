/**
 * Host page shell (D0-RT-01, D3-RT-04, W2 host flow).
 *
 * The page owns two routes (PAGE-PLANS §1):
 *
 *   `/`                  HP-03 launcher once a room exists (HP-02 hero stays
 *                         next to it); never silently loads the cube demo.
 *   `/games/<slug>/`     HP-04 stage: start screen, then the game canvas with
 *                         a 48px room/player bar. Back/Escape opens HP-04b.
 *
 * Everything below the pure route helpers is wiring for one live page:
 *
 * 1. Room (D0, kept): `POST /api/rooms`, show the RoomPanel hero, `await
 *    connect()`, `await hostJoin()`, then route `playerJoined/Left` and binary
 *    `InputFwd` frames. Every `InputFwd` goes into the single `InputMapper`.
 * 2. Runtime (D3/D7): the selected bundled game is fetched through the same
 *    manifest path as any game, `loadGame` validates it, and the start screen
 *    unlocks audio before the `GameHost` starts its fixed loop.
 * 3. Host flow (W2): launcher, stage chrome, leave confirmation, results
 *    overlay, HP-06 reconnect banner and HP-07 notices.
 *
 * Games only ever receive the `GameContext`; the `HostClient` stays here
 * (FR-7.17).
 *
 * Secrets: `hostToken` is kept in host memory and `sessionStorage` only. The
 * room token is handed to the RoomPanel solely to draw the join QR and is
 * never written to text, attributes or logs (FR-5.1, SR-9). The lobby hero is
 * the only place the code and PIN are rendered; the stage bar shows the room
 * code only while the lobby is hidden.
 */
import type { ServerToClientMessage, SlotStats } from "@lanpad/protocol";
import { resolveServerOrigin, type GameHaptics } from "@lanpad/sdk";
import { AssetLoader, type AssetEntry } from "./assets/AssetLoader.js";
import { AudioBus } from "./audio/AudioBus.js";
import { InputTable } from "./debug/inputTable.js";
import { DebugOverlay, isDebugEnabled, type OverlaySlotStats } from "./debug/Overlay.js";
import { createBundledGames } from "./demo/bundledGames.js";
import { createDebugCounters, installRuntimeCapabilities } from "./game/GameContext.js";
import { gameSlugFromPath } from "./game/gameRoute.js";
import { EventRouter } from "./game/EventRouter.js";
import { HapticApi } from "./game/HapticApi.js";
import { LayoutApi } from "./game/LayoutApi.js";
import { registerManifestLayouts } from "./game/manifestLayouts.js";
import { PanelApi } from "./game/PanelApi.js";
import { attachVisibilityPause, GameHost } from "./game/GameHost.js";
import { assertAssetBudget, loadGame, type LoadedGame } from "./game/loadGame.js";
import { InputMapper } from "./input/InputMapper.js";
import type { FrameStats } from "./loop/types.js";
import {
  HostClient,
  shouldCreateRoomOnKey,
  storeHostToken,
  type HostPhase,
  type HostPlayerEvent,
  type RoomCredentials,
} from "./net/hostClient.js";
import {
  HostReconnect,
  type HostRecoveryState,
  type HostSession,
} from "./net/hostReconnect.js";
import {
  applyResolutionScale,
  attachContextLossRecovery,
  ContextLossRecovery,
  readViewportEnvironment,
  ResolutionController,
  resolveTvProfile,
} from "./profile/index.js";
import {
  initRenderer,
  RendererUnavailableError,
  type Renderer3D,
  type RendererBackend,
  type RendererFallbackNotice,
} from "./render/Renderer.js";
import { Launcher, type LauncherGame } from "./ui/Launcher.js";
import { LeaveConfirm } from "./ui/LeaveConfirm.js";
import { Notice, type NoticeOptions } from "./ui/Notice.js";
import {
  ResultsOverlay,
  type ResultsData,
} from "./ui/ResultsOverlay.js";
import { SlotRoster, type SlotRosterEntry, type SlotRosterState } from "./ui/SlotRoster.js";
import { RoomPanel } from "./ui/RoomPanel.js";
import { StartScreen } from "./ui/StartScreen.js";
import "./style.css";

/** Only the fields the host needs after creation. */
interface HostRoom {
  code: string;
  hostToken: string;
}

/** HP-06 banner copy: the game stays paused while the socket recovers. */
export const RECONNECT_BANNER_TEXT =
  "Reconnecting to the room… The game is paused.";

/** HP-07 actions; the design allows Reload and Create a new room. */
export const RELOAD_LABEL = "Reload";
export const CREATE_ROOM_LABEL = "Create a new room";
export const BACK_TO_GAMES_LABEL = "Back to games";

/** HP-07 headings kept from the existing host-shell paths. */
export const GAME_STOPPED_TITLE = "The game stopped";
export const GAME_NOT_FOUND_TITLE = "Game not found";
export const ROOM_ENDED_TITLE = "Room ended";

/** Temporary transport for HP-05 until a game-facing results API exists. */
export const RESULTS_EVENT = "lanpad:results";

/** The cube demo has no downloadable assets; real games list theirs here. */
const GAME_ASSETS: readonly AssetEntry[] = [];
const SLOT_COUNT = 8;
const EMPTY_ROOM_CODE = "----";

/** A host route decision; `/` is the launcher, never a silent game load. */
export type HostRoute =
  | { readonly kind: "launcher" }
  | { readonly kind: "game"; readonly slug: string };

/** `/games/<slug>/` (trailing slash is the canonical form). */
export function gamePathFor(slug: string): string {
  return `/games/${slug}/`;
}

/** HP-03/HP-04 route selection for a pathname. */
export function resolveHostRoute(pathname: string): HostRoute {
  const slug = gameSlugFromPath(pathname);
  return slug === null ? { kind: "launcher" } : { kind: "game", slug };
}

/** Stage/launcher player count; never a negative or fractional number. */
export function playerCountLabel(count: number): string {
  const players = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return `${players} ${players === 1 ? "player" : "players"}`;
}

/** HP-08 state mapping for a broker player event. */
export function slotRosterStateFor(event: HostPlayerEvent): SlotRosterState {
  switch (event) {
    case "joined":
    case "resumed":
      return "connected";
    case "suspended":
      return "reconnecting";
    case "left":
      return "open";
    default:
      return "open";
  }
}

/** Remote Back keys: Escape, browser Back, Tizen/LG/webOS back codes. */
export function isBackKey(key: string, keyCode = 0): boolean {
  return (
    key === "Escape" ||
    key === "Esc" ||
    key === "Backspace" ||
    key === "BrowserBack" ||
    key === "GoBack" ||
    keyCode === 27 ||
    keyCode === 461 ||
    keyCode === 10009
  );
}

/** Runtime guard for the HP-05 payload; the overlay never invents values. */
export function isResultsData(value: unknown): value is ResultsData {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["title"] !== "string" || typeof record["rematch"] !== "boolean") {
    return false;
  }
  const rows = record["rows"];
  if (!Array.isArray(rows)) return false;
  return rows.every((row: unknown) => {
    if (typeof row !== "object" || row === null) return false;
    const entry = row as Record<string, unknown>;
    return (
      typeof entry["slot"] === "number" &&
      typeof entry["label"] === "string" &&
      typeof entry["value"] === "string"
    );
  });
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Host shell is missing #${id}.`);
  }
  return found;
}

/**
 * Mounts the live host page. Exported for tests, which import the pure route
 * helpers above without building a DOM; the guard at the bottom of the module
 * calls it only when the real `#app` shell is present.
 */
export function bootstrapHost(): void {
  const connectionEl = element("connection");
  const hintEl = element("room-hint");
  const slotsEl = element("slots");
  const gameRoot = element("game-root");
  const appEl = element("app");
  const topBar = appEl.querySelector(".top-bar");

  // Host fullscreen is a gesture action. The same control exists on the
  // controller; TV browsers that lack the API simply hide it.
  const fullscreenButton = document.getElementById("fullscreen-toggle");
  if (fullscreenButton instanceof HTMLButtonElement) {
    if (typeof document.documentElement.requestFullscreen !== "function") {
      fullscreenButton.hidden = true;
    } else {
      const renderFullscreen = (): void => {
        fullscreenButton.textContent =
          document.fullscreenElement === null
            ? "Full screen"
            : "Exit full screen";
      };
      fullscreenButton.addEventListener("click", () => {
        if (document.fullscreenElement === null) {
          void document.documentElement
            .requestFullscreen()
            .catch(() => undefined);
        } else {
          void document.exitFullscreen().catch(() => undefined);
        }
      });
      document.addEventListener("fullscreenchange", renderFullscreen);
      renderFullscreen();
    }
  }

  const debug = isDebugEnabled(window.location.search);
  const debugCounters = createDebugCounters(debug);

  // HP-08: the roster is the visible player list; the raw D0 table is debug
  // only and lives in its own container inside the roster section.
  const roster = new SlotRoster(document);
  roster.mount(slotsEl);
  const debugTableMount = document.createElement("div");
  debugTableMount.className = "roster__debug";
  const table = new InputTable(debugTableMount, { showTick: debug });
  if (debug) {
    // Fixed to the viewport: the roster is hidden during play, and the raw
    // input table is exactly what a "no response" report needs to see.
    debugTableMount.classList.add("debug-input");
    document.body.append(debugTableMount);
  }

  const client = new HostClient();
  const bundledGames = createBundledGames(document.baseURI);
  const mapper = new InputMapper();
  const roomPanel = new RoomPanel(element("room-panel"), {
    onNewRoom: () => void createRoom(),
  });

  // D5/D6 capabilities. They are installed before `GameHost` builds the game
  // context, and the injected senders are the only place games can reach the
  // socket (FR-7.17).
  const layouts = new LayoutApi({ sender: client });
  const panels = new PanelApi({ sender: client });
  const haptics = new HapticApi({ send: (frame) => client.sendBinary(frame) });
  /** Last pulse a game requested, for the debug overlay (D6-RT-01; FR-8.11). */
  let lastHaptic: { target: number; steps: number; atMs: number } | null = null;
  const gameHaptics: GameHaptics = {
    pulse(target, pattern) {
      haptics.pulse(target, pattern);
      lastHaptic = {
        target: target === "all" ? 0 : target,
        steps: pattern.length,
        atMs: performance.now(),
      };
    },
  };
  const eventRouter = new EventRouter();
  installRuntimeCapabilities({ layouts, panels, haptics: gameHaptics, events: eventRouter });

  let phase: HostPhase = "idle";
  let room: HostRoom | null = null;
  /** Latest 1 Hz server slot stats; the overlay prefers these for RTT/jitter. */
  let serverStats: SlotStats[] = [];
  /** HP-08 presence per slot, fed by the broker's player events. */
  const slotStates: SlotRosterState[] = [];
  for (let slot = 0; slot <= SLOT_COUNT; slot += 1) slotStates.push("open");

  // Runtime state (D3/D7).
  const audio = new AudioBus();
  const profile = resolveTvProfile(readViewportEnvironment(window), window.location.search);
  const resolution = new ResolutionController();
  const overlayMount = document.createElement("div");
  document.body.append(overlayMount);
  const overlay = new DebugOverlay({ mount: overlayMount, enabled: debug });

  let startScreen: StartScreen | null = null;
  let gameHost: GameHost | null = null;
  let renderer: Renderer3D | null = null;
  let backend: RendererBackend | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let detachContextLoss: (() => void) | null = null;
  /** Set when the host socket drops; cleared on the next hostJoined. */
  let networkLost = false;
  /** True from the start gesture until the stage is left. */
  let stageActive = false;
  let launcher: Launcher | null = null;
  let currentSlug: string | null = null;
  let activeNotice: Notice | null = null;
  /** Bumped by teardown so an in-flight game load cannot mount into a new route. */
  let gameGeneration = 0;

  // HP-03/HP-04 chrome. Class names are owned by `src/style.css`.
  const stageBar = document.createElement("div");
  stageBar.className = "lanpad-stage-bar";
  stageBar.hidden = true;
  const stageRoomEl = document.createElement("span");
  stageRoomEl.className = "lanpad-stage-bar__room";
  const stagePlayersEl = document.createElement("span");
  stagePlayersEl.className = "lanpad-stage-bar__players";
  stageBar.append(stageRoomEl, stagePlayersEl);

  // HP-06: sits above the canvas, so it never covers the game's HUD.
  const reconnectBanner = document.createElement("div");
  reconnectBanner.className = "lanpad-reconnect";
  reconnectBanner.setAttribute("role", "status");
  reconnectBanner.setAttribute("aria-live", "polite");
  reconnectBanner.textContent = RECONNECT_BANNER_TEXT;
  reconnectBanner.hidden = true;

  if (topBar !== null) {
    topBar.after(stageBar, reconnectBanner);
  } else {
    appEl.prepend(reconnectBanner, stageBar);
  }

  // HP-05/HP-04b overlays mount on the body so leaving a game cannot remove
  // them with the stage tree.
  const resultsOverlay = new ResultsOverlay(document);
  const leaveConfirm = new LeaveConfirm(document);

  // -------------------------------------------------------------------------
  // Shared UI state
  // -------------------------------------------------------------------------

  function setConnection(text: string, tone: "pending" | "ok" | "bad"): void {
    connectionEl.textContent = text;
    connectionEl.dataset["state"] = tone;
    // CSS cannot rely on :has() on older TV browsers; mirror the tone here.
    appEl.classList.toggle("connection-bad", tone === "bad");
  }

  /** Mirrors stage ownership onto the host so CSS never needs :has(). */
  function setStageActive(value: boolean): void {
    stageActive = value;
    appEl.classList.toggle("stage-active", value);
  }

  function connectedCount(): number {
    let count = 0;
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      if (slotStates[slot] === "connected") count += 1;
    }
    return count;
  }

  function rosterEntries(): SlotRosterEntry[] {
    const entries: SlotRosterEntry[] = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      entries.push({ slot, state: slotStates[slot] ?? "open" });
    }
    return entries;
  }

  function updateStageBar(): void {
    stageRoomEl.textContent = room?.code ?? EMPTY_ROOM_CODE;
    stagePlayersEl.textContent = playerCountLabel(connectedCount());
  }

  /**
   * HP-03 acceptance: connected counts update without a re-render flicker.
   * `Launcher` has no update method, so the shell edits only the documented
   * count span on each card instead of rebuilding the shelf and losing focus.
   */
  function syncLauncherCounts(): void {
    if (launcher === null) return;
    const count = connectedCount();
    const cards = launcher.element.querySelectorAll<HTMLElement>(
      ".lanpad-launcher__card",
    );
    for (const card of cards) {
      const existing = card.querySelector<HTMLElement>(
        ".lanpad-launcher__card-connected",
      );
      if (count > 0) {
        const label = existing ?? document.createElement("span");
        if (existing === null) {
          label.className = "lanpad-launcher__card-connected";
          card.append(label);
        }
        label.textContent = `${count} connected`;
      } else if (existing !== null) {
        existing.remove();
      }
    }
  }

  function refreshRoster(): void {
    roster.update(rosterEntries());
    updateStageBar();
    syncLauncherCounts();
  }

  function setSlotState(slot: number, state: SlotRosterState): void {
    if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) return;
    slotStates[slot] = state;
    refreshRoster();
  }

  function resetSlots(): void {
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      slotStates[slot] = "open";
    }
    refreshRoster();
  }

  function showReconnectBanner(visible: boolean): void {
    reconnectBanner.hidden = !visible;
  }

  function renderTable(): void {
    table.render(performance.now());
  }

  /** Single place that decides whether the game simulates (FR-9.2). */
  function syncPause(): void {
    const host = gameHost;
    if (host === null) return;
    // HP-04b/HP-05 are modal: the game beneath them stays paused even when
    // the tab is visible or the socket recovers.
    if (
      document.hidden ||
      networkLost ||
      leaveConfirm.isOpen ||
      resultsOverlay.isVisible
    ) {
      host.pause();
    } else {
      host.resume();
    }
  }

  // -------------------------------------------------------------------------
  // HP-07 notices
  // -------------------------------------------------------------------------

  function clearNotice(): void {
    activeNotice?.destroy();
    activeNotice = null;
  }

  function showNoticePanel(options: NoticeOptions): Notice {
    clearNotice();
    const notice = new Notice(document, options);
    // Existing host notices sat above the canvas; keep that order.
    gameRoot.insertBefore(notice.element, gameRoot.firstChild);
    notice.focusAction();
    activeNotice = notice;
    return notice;
  }

  function reloadPage(): void {
    window.location.reload();
  }

  function showRendererNotice(notice: RendererFallbackNotice, fatal: boolean): void {
    showNoticePanel({
      title: notice.title,
      message: notice.message,
      hints: notice.hints,
      actionLabel: RELOAD_LABEL,
      onAction: reloadPage,
      tone: fatal ? "error" : "notice",
    });
  }

  /** Fatal runtime error: stop the game and offer a reload (D3-SDK-01 risk). */
  function showError(error: unknown): void {
    const text = error instanceof Error ? error.message : "Unknown error.";
    teardownGame();
    showNoticePanel({
      title: GAME_STOPPED_TITLE,
      message: text,
      actionLabel: RELOAD_LABEL,
      onAction: reloadPage,
      tone: "error",
    });
  }

  // -------------------------------------------------------------------------
  // Host session recovery + capability helpers (D4-HOST-02)
  // -------------------------------------------------------------------------

  /** Clears room-scoped game/UI state; leaves phase and socket handling alone. */
  function clearRoomState(): void {
    layouts.clearAll();
    panels.clearAll();
    serverStats = [];
    mapper.reset();
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      table.setPlayerLeft(slot);
    }
    room = null;
    resetSlots();
    renderTable();
    roomPanel.setRoom(null);
  }

  /** Per-tab storage can throw (private mode); recovery then keeps memory only. */
  function sessionStorageOrNull(): Storage | null {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  }

  const recovery = new HostReconnect({
    client,
    storage: sessionStorageOrNull(),
    onStateChange: handleRecoveryState,
    onResumed: handleHostResumed,
    onLost: handleHostLost,
  });

  function handleRecoveryState(state: HostRecoveryState): void {
    switch (state) {
      case "reconnecting":
        roomPanel.setHostStatus("reconnecting");
        setConnection("Reconnecting…", "pending");
        showReconnectBanner(true);
        break;
      case "connected":
        roomPanel.setHostStatus("connected");
        showReconnectBanner(false);
        break;
      case "lost":
        roomPanel.setHostStatus("lost");
        showReconnectBanner(false);
        break;
      default:
        break;
    }
  }

  function handleHostResumed(session: HostSession): void {
    room = { code: session.code, hostToken: session.hostToken };
    networkLost = false;
    phase = "ready";
    syncPause();
    roomPanel.setHostJoined(true);
    setConnection("Connected", "ok");
    hintEl.textContent = "Room resumed.";
    showReconnectBanner(false);
    updateStageBar();
    layouts.resendAll();
    panels.resendAll();
    maybeShowLauncher();
  }

  function handleHostLost(): void {
    clearRoomState();
    networkLost = true;
    phase = "idle";
    syncPause();
    roomPanel.setHostStatus("lost");
    setConnection("Room lost — starting a new room…", "bad");
    hintEl.textContent = "Room lost. Creating a new room…";
    showReconnectBanner(false);
    // Same recovery contract as D4: a lost room starts a fresh one.
    void createRoom();
  }

  // -------------------------------------------------------------------------
  // Launcher + stage routing (HP-03/HP-04)
  // -------------------------------------------------------------------------

  function launcherEntries(): ReadonlyArray<LauncherGame> {
    return bundledGames.games.map((entry) => ({
      ...entry,
      connected: connectedCount(),
    }));
  }

  function destroyLauncher(): void {
    launcher?.destroy();
    launcher = null;
  }

  function maybeShowLauncher(): void {
    if (room === null) return;
    if (resolveHostRoute(window.location.pathname).kind !== "launcher") return;
    if (launcher !== null) return;
    launcher = new Launcher(document, {
      games: launcherEntries(),
      onLaunch: navigateToGame,
    });
    launcher.mount(gameRoot);
    // The launcher is the host route: keep remote focus on the shelf.
    launcher.focus();
  }

  function navigateToGame(slug: string): void {
    const path = gamePathFor(slug);
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    clearNotice();
    destroyLauncher();
    // The launcher activation is the user gesture: unlock audio, request
    // fullscreen, and start the selected game directly. The direct
    // /games/<slug>/ route keeps the explicit start screen.
    void audio.unlock();
    if (
      document.fullscreenElement === null &&
      typeof document.documentElement.requestFullscreen === "function"
    ) {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
    void openGame(slug, { autoStart: true });
  }

  /** Rebuilds the `/` route without touching the live room (Phones stay). */
  function returnToLauncher(pushHistory = true): void {
    if (pushHistory && window.location.pathname !== "/") {
      window.history.pushState({}, "", "/");
    }
    clearNotice();
    leaveConfirm.close();
    resultsOverlay.hide();
    teardownGame();
    currentSlug = null;
    maybeShowLauncher();
    launcher?.focus();
  }

  /** Room-ended paths: replace the route so a reload cannot reopen the stage. */
  function resetRouteToLauncher(): void {
    if (window.location.pathname !== "/") {
      window.history.replaceState({}, "", "/");
    }
    leaveConfirm.close();
    resultsOverlay.hide();
    teardownGame();
    currentSlug = null;
    destroyLauncher();
  }

  function openLeaveConfirm(): void {
    if (!stageActive || leaveConfirm.isOpen) return;
    gameHost?.pause();
    leaveConfirm.open(
      () => {
        // Keep playing: syncPause only resumes when the tab/socket allow it.
        syncPause();
      },
      () => {
        returnToLauncher();
      },
    );
  }

  /** HP-05 callback. No GameContext method exists yet, so the event seam feeds it. */
  function showGameResults(data: ResultsData): void {
    if (!stageActive) return;
    gameHost?.pause();
    resultsOverlay.show(data, {
      onRematch: () => {
        const slug = currentSlug;
        if (slug !== null) void openGame(slug, { autoStart: true });
      },
      onBack: () => {
        returnToLauncher();
      },
    });
  }

  // -------------------------------------------------------------------------
  // Room + host socket (D0 shell, D3 input routing)
  // -------------------------------------------------------------------------

  client.onClose((info) => {
    if (recovery.session !== null && recovery.state !== "lost" && phase === "ready") {
      // D4-HOST-02: the broker keeps the slots reserved for 30 s; retry with
      // 250 ms → 4 s backoff instead of dropping the room immediately.
      recovery.handleClose();
      networkLost = true;
      syncPause();
      roomPanel.setHostStatus("reconnecting");
      setConnection("Reconnecting…", "pending");
      hintEl.textContent = "Waiting for the room connection to recover…";
      showReconnectBanner(true);
      return;
    }
    phase = "failed";
    networkLost = true;
    syncPause();
    roomPanel.setHostJoined(false);
    showReconnectBanner(false);
    const code = info.code;
    setConnection(
      code === undefined || code === 1000 ? "Disconnected" : `Disconnected (${code})`,
      "bad",
    );
    hintEl.textContent = "Press Enter to start a new room.";
  });

  client.onError(() => {
    if (recovery.state === "reconnecting") {
      return;
    }
    setConnection("Connection error", "bad");
  });

  client.onMessage((message: ServerToClientMessage) => {
    switch (message.t) {
      case "hostJoined":
        phase = "ready";
        networkLost = false;
        syncPause();
        roomPanel.setHostJoined(true);
        setConnection("Connected", "ok");
        hintEl.textContent = "";
        showReconnectBanner(false);
        break;
      case "joinError":
        if (recovery.state === "reconnecting") {
          hintEl.textContent = "Reconnecting to the room…";
        } else {
          phase = "failed";
          setConnection(`Host join failed: ${message.reason}`, "bad");
          hintEl.textContent = "Press Enter to start a new room.";
        }
        break;
      case "playerJoined":
        layouts.handleJoined(message.slot);
        panels.handleJoined(message.slot);
        table.setPlayerJoined(message.slot);
        setSlotState(message.slot, slotRosterStateFor("joined"));
        renderTable();
        break;
      case "playerLeft":
        mapper.reset(message.slot);
        layouts.handleLeft(message.slot);
        panels.handleLeft(message.slot);
        table.setPlayerLeft(message.slot);
        setSlotState(message.slot, slotRosterStateFor("left"));
        renderTable();
        break;
      case "playerSuspended":
        // The reserved slot keeps its layout; only live input is dropped.
        mapper.reset(message.slot);
        setSlotState(message.slot, slotRosterStateFor("suspended"));
        renderTable();
        break;
      case "playerResumed":
        // Broker reservation returned: resend the host's layout and panel.
        mapper.reset(message.slot);
        table.setPlayerJoined(message.slot);
        setSlotState(message.slot, slotRosterStateFor("resumed"));
        renderTable();
        layouts.handleResumed(message.slot);
        panels.handleResumed(message.slot);
        break;
      case "event":
        eventRouter.receive(message.slot, message.name, message.data);
        break;
      case "layoutAck":
        layouts.handleAck(message.slot, message.layoutId);
        break;
      case "stats":
        serverStats = message.slots;
        break;
      case "kick":
        recovery.forget();
        clearRoomState();
        networkLost = true;
        phase = "failed";
        syncPause();
        roomPanel.setHostJoined(false);
        setConnection(`Removed from the room: ${message.reason}`, "bad");
        hintEl.textContent = "Press Enter to start a new room.";
        showReconnectBanner(false);
        resetRouteToLauncher();
        showNoticePanel({
          title: ROOM_ENDED_TITLE,
          message: `Removed from the room: ${message.reason}`,
          hints: ["Press Enter to start a new room."],
          actionLabel: CREATE_ROOM_LABEL,
          onAction: () => {
            clearNotice();
            void createRoom();
          },
          tone: "error",
        });
        break;
      default:
        break;
    }
  });

  client.onInput((slot, state) => {
    const receivedAt = performance.now();
    mapper.apply(slot, state, receivedAt);
    table.setInput(slot, state, receivedAt);
    renderTable();
  });

  async function createRoom(): Promise<void> {
    if (phase === "creating") {
      return;
    }
    phase = "creating";
    // A new room replaces any pending recovery timer/session.
    recovery.forget();
    destroyLauncher();
    setConnection("Creating room…", "pending");
    showReconnectBanner(false);

    let origin: string;
    let credentials: RoomCredentials;
    try {
      origin = resolveServerOrigin();
      credentials = await client.createRoom(origin);
    } catch {
      phase = "failed";
      setConnection("Could not create a room", "bad");
      hintEl.textContent = "Press Enter to retry.";
      return;
    }

    const current: HostRoom = { code: credentials.code, hostToken: credentials.hostToken };
    // Never leak the previous room's private panels/layouts into a new room.
    clearRoomState();
    clearNotice();
    room = current;
    roomPanel.setRoom({
      code: credentials.code,
      pin: credentials.pin,
      roomToken: credentials.roomToken,
    });
    roomPanel.setHostJoined(false);
    updateStageBar();
    // The lobby hero is the only place the code/PIN are rendered (HP-02).
    maybeShowLauncher();

    try {
      storeHostToken(window.sessionStorage, credentials.code, credentials.hostToken);
    } catch {
      // Per-tab storage can be unavailable (private mode); the token stays in memory.
    }

    setConnection("Connecting…", "pending");
    try {
      // HostReconnect owns connect + hostJoin, stores the resumable session and
      // reports the recovery state used by the status line.
      await recovery.join(current);
    } catch {
      recovery.forget();
      // joinError / close handlers usually explain the failure already.
      phase = "failed";
      setConnection("Host join failed", "bad");
      hintEl.textContent = "Press Enter to start a new room.";
    }
  }

  // -------------------------------------------------------------------------
  // Runtime boot (D3/D7)
  // -------------------------------------------------------------------------

  function applySize(): void {
    if (renderer === null || canvas === null) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    applyResolutionScale(renderer, width, height, profile.dpr, resolution.scale);
  }

  function onFrameStats(stats: FrameStats): void {
    overlay.recordFrame(stats);
    if (resolution.sample(stats.frameMs)) {
      applySize();
    }
  }

  /** Stops the current game but keeps the room, roster and socket (HP-04). */
  function teardownGame(): void {
    gameGeneration += 1;
    setStageActive(false);
    leaveConfirm.close();
    resultsOverlay.hide();
    gameHost?.dispose();
    gameHost = null;
    startScreen?.destroy();
    startScreen = null;
    detachContextLoss?.();
    detachContextLoss = null;
    window.removeEventListener("resize", applySize);
    renderer?.dispose();
    renderer = null;
    backend = null;
    canvas?.remove();
    canvas = null;
    stageBar.hidden = true;
    // The HP-06 banner belongs to the room, not the stage: a reconnecting
    // host keeps it while moving between the launcher and a game.
  }

  async function startGame(): Promise<void> {
    const host = gameHost;
    if (host === null || canvas === null) return;
    startScreen?.destroy();
    startScreen = null;
    setStageActive(true);
    destroyLauncher();
    canvas.hidden = false;
    stageBar.hidden = false;
    updateStageBar();
    applySize();
    try {
      await host.start();
    } catch (error) {
      showError(error);
      return;
    }
    syncPause();
  }

  interface OpenGameOptions {
    /** Rematch: reload and start without a second start-screen gesture. */
    readonly autoStart?: boolean;
  }

  async function openGame(slug: string, options: OpenGameOptions = {}): Promise<void> {
    const entry = bundledGames.games.find((game) => game.slug === slug) ?? null;
    teardownGame();
    if (entry === null) {
      currentSlug = null;
      showNoticePanel({
        title: GAME_NOT_FOUND_TITLE,
        message: `Unknown game "${slug}" at /games/${slug}/.`,
        actionLabel: BACK_TO_GAMES_LABEL,
        onAction: () => returnToLauncher(),
        tone: "error",
      });
      return;
    }

    const generation = gameGeneration;
    currentSlug = slug;
    clearNotice();

    const surface = document.createElement("canvas");
    surface.className = "lanpad-canvas";
    surface.hidden = true;
    gameRoot.append(surface);
    canvas = surface;

    let active: Renderer3D;
    try {
      // Every bundled game draws through the 2D game API (D7); the renderer
      // still provides the shared resize/frame contract.
      const selection = await initRenderer(surface, "canvas2d", {
        maxRenderHeight: profile.maxRenderHeight,
      });
      if (generation !== gameGeneration) {
        selection.renderer.dispose();
        return;
      }
      active = selection.renderer;
      renderer = active;
      backend = selection.backend;
      if (selection.fallbackNotice !== null) {
        showRendererNotice(selection.fallbackNotice, false);
      }
    } catch (error) {
      if (generation !== gameGeneration) return;
      surface.remove();
      canvas = null;
      if (error instanceof RendererUnavailableError) {
        showRendererNotice(error.notice, true);
      } else {
        showError(error);
      }
      return;
    }

    const contextRecovery = new ContextLossRecovery({
      controller: resolution,
      onRestored: applySize,
    });
    detachContextLoss = attachContextLossRecovery(surface, contextRecovery);
    window.addEventListener("resize", applySize);

    let loaded: LoadedGame;
    try {
      loaded = await loadGame(entry.manifestUrl, {
        importModule: bundledGames.importModule,
      });
      if (generation !== gameGeneration) return;
      assertAssetBudget(loaded.manifest, GAME_ASSETS);
      // D5/D7 seam: games call `ctx.layouts.set(slot, "<layout id>")`, and the
      // host registers the manifest's layout files before the game starts.
      await registerManifestLayouts(layouts, loaded);
      if (generation !== gameGeneration) return;
    } catch (error) {
      if (generation !== gameGeneration) return;
      showError(error);
      return;
    }

    const host = new GameHost({
      game: loaded.game,
      renderer: active,
      audio,
      mapper,
      now: () => performance.now(),
      raf: (cb) => window.requestAnimationFrame(cb),
      cancel: (id) => window.cancelAnimationFrame(id),
      serverNow: () => client.serverNow(),
      debug: debugCounters,
      onFrameStats,
      onError: showError,
    });
    gameHost = host;
    // Events forwarded by the server enter the game's own `onEvent` queue.
    eventRouter.setSink({
      push: (slot, name, data) => {
        host.pushEvent(slot, name, data);
      },
    });
    // Named `ctx.events.on` handlers run at the start of each simulate tick,
    // before GameHost drains its queue for `game.onEvent` (D5-RT-01).
    host.input.setTickHook(() => {
      eventRouter.dispatch();
    });

    if (options.autoStart !== true) {
      const screen = new StartScreen(document, {
        audio,
        title: loaded.manifest.name,
        onStart: () => void startGame(),
      });
      startScreen = screen;
      gameRoot.prepend(screen.element);
      screen.focus();
    }

    try {
      await new AssetLoader().load(GAME_ASSETS, (progress) => {
        startScreen?.updateProgress(progress);
      });
    } catch (error) {
      showError(error);
      return;
    }

    if (generation !== gameGeneration) return;
    if (options.autoStart === true) {
      await startGame();
    }
  }

  /**
   * D4-HOST-02 boot: resume this tab's room before creating a new one. A
   * terminal token failure (expired/badHostToken) has already cleared the
   * stored session, so the shell starts fresh instead of retrying a dead room.
   */
  async function bootHost(): Promise<void> {
    const result = await recovery.resumeStored();
    if (result === "none") {
      await createRoom();
      return;
    }
    if (result === "terminal") {
      hintEl.textContent = "The previous room ended. Starting a new room.";
      await createRoom();
      return;
    }

    const session = recovery.session;
    if (session === null) {
      await createRoom();
      return;
    }

    room = { code: session.code, hostToken: session.hostToken };
    phase = "ready";
    networkLost = result !== "resumed";
    syncPause();
    // Only `{code, hostToken}` survives a reload, so there is no room token or
    // PIN for a fresh QR. Already-connected phones keep their 30 s reservation.
    roomPanel.setResumedRoom(session.code);
    updateStageBar();
    if (result === "recovering") {
      roomPanel.setHostStatus("reconnecting");
      setConnection("Reconnecting…", "pending");
      hintEl.textContent = "Waiting for the room connection to recover…";
      showReconnectBanner(true);
    } else {
      setConnection("Connected", "ok");
      hintEl.textContent = "Room resumed.";
      showReconnectBanner(false);
    }
    maybeShowLauncher();
  }

  async function bootRoute(): Promise<void> {
    const route = resolveHostRoute(window.location.pathname);
    if (route.kind === "game") {
      await openGame(route.slug);
      return;
    }
    // HP-03: the launcher needs a live room; bootHost calls maybeShowLauncher.
  }

  // -------------------------------------------------------------------------
  // Input, overlays and timers
  // -------------------------------------------------------------------------

  window.addEventListener("keydown", (event) => {
    overlay.handleKey(event.key);

    // A focused component (LeaveConfirm's Escape, for example) runs first and
    // marks the event handled; never treat that same key as a second action.
    if (event.defaultPrevented) return;

    if (isBackKey(event.key, event.keyCode)) {
      // LeaveConfirm handles Escape itself while it is open.
      if (leaveConfirm.isOpen) return;
      if (resultsOverlay.isVisible) {
        event.preventDefault();
        returnToLauncher();
        return;
      }
      if (stageActive) {
        event.preventDefault();
        openLeaveConfirm();
        return;
      }
      if (startScreen !== null) {
        // Backing out before the game starts needs no confirmation.
        event.preventDefault();
        returnToLauncher();
        return;
      }
    }

    // While a stage, overlay or start screen is up, Enter is not room creation.
    if (
      startScreen !== null ||
      stageActive ||
      leaveConfirm.isOpen ||
      resultsOverlay.isVisible ||
      !shouldCreateRoomOnKey(event.key, phase)
    ) {
      return;
    }
    event.preventDefault();
    void createRoom();
  });

  window.addEventListener("popstate", () => {
    const route = resolveHostRoute(window.location.pathname);
    if (route.kind === "game") {
      clearNotice();
      destroyLauncher();
      void openGame(route.slug);
      return;
    }
    returnToLauncher(false);
  });

  // D5/D7 results seam: the platform overlay is ready, but `GameContext` has
  // no frozen results method yet, so a game (or a test) reports through one
  // page event. The callback is the single mount path HP-05 needs.
  window.addEventListener(RESULTS_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isResultsData(detail)) return;
    showGameResults(detail);
  });

  attachVisibilityPause(document, {
    pause: () => {
      recovery.pauseForVisibility();
      syncPause();
    },
    resume: () => {
      recovery.resumeForVisibility();
      syncPause();
    },
  });
  // pagehide/pageshow cover tab/browser backgrounding where visibilitychange
  // may not fire; both paths send `hostPause` / `hostResume` (FR-9.2).
  window.addEventListener("pagehide", () => {
    recovery.pauseForVisibility();
    syncPause();
  });
  window.addEventListener("pageshow", () => {
    recovery.resumeForVisibility();
    syncPause();
  });

  function overlaySlots(): OverlaySlotStats[] {
    const bySlot = new Map<number, SlotStats>();
    for (const stats of serverStats) {
      bySlot.set(stats.slot, stats);
    }
    const slots: OverlaySlotStats[] = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      const stats = mapper.getStats(slot);
      const server = bySlot.get(slot);
      const state = mapper.getSlot(slot);
      const tilt = state?.tilt;
      slots.push({
        slot,
        lastInputAgeMs: stats.lastInputAgeMs,
        packetsPerSecond: stats.packetsPerSecond,
        drops: stats.drops,
        rttMs: server?.rttMs ?? null,
        jitterMs: server?.jitterMs ?? null,
        gyroActive: state?.gyroActive ?? false,
        ...(tilt === undefined ? {} : { tilt }),
      });
    }
    return slots;
  }

  /** D5/D6 counters for the D7 debug overlay (no-op unless ?debug=1). */
  function updateDebugCounters(): void {
    const events = eventRouter.counters;
    const layoutCounters = layouts.counters;
    const panelCounters = panels.counters;
    const hapticStats = haptics.stats;
    debugCounters.setCounter("events.received", events.received);
    debugCounters.setCounter("events.dropped", events.dropped);
    debugCounters.setCounter("layouts.pendingAcks", layoutCounters.pendingAcks);
    debugCounters.setCounter("layouts.staleAcks", layoutCounters.staleAcks);
    debugCounters.setCounter("panels.storedBytes", panelCounters.storedBytes);
    debugCounters.setCounter("haptics.sent", hapticStats.sent);
    debugCounters.setCounter("haptics.dropped", hapticStats.dropped);
  }

  /** 4 Hz: debug table ages and, only when visible, the overlay paint. */
  function tick4Hz(): void {
    renderTable();
    updateDebugCounters();
    if (!overlay.visible) return;
    overlay.update({
      backend,
      drawCalls: renderer?.drawCalls ?? 0,
      textureMemoryMB: renderer?.textureMemoryMB ?? 0,
      jsHeapMB: null,
      visibleInstances: null,
      resolution:
        canvas === null
          ? null
          : { scale: resolution.scale, dpr: profile.dpr, width: canvas.width, height: canvas.height },
      entities: null,
      gyroSmoothing: null,
      lastHaptic:
        lastHaptic === null
          ? null
          : {
              target: lastHaptic.target,
              steps: lastHaptic.steps,
              ageMs: Math.max(0, performance.now() - lastHaptic.atMs),
            },
      slots: overlaySlots(),
    });
  }

  // Refresh the age column and the overlay at 4 Hz.
  window.setInterval(tick4Hz, 250);

  // Boot both paths in parallel: the room either resumes or is created
  // immediately (D0 acceptance), while the route loads (AR-4).
  void bootHost();
  void bootRoute();
}

// Importing this module in tests must not touch the DOM; the real page always
// has `#app`. Mirrors the controller shell's bootstrap guard.
if (typeof document !== "undefined" && document.getElementById("app") !== null) {
  bootstrapHost();
}

/**
 * Host page composition root (D0-RT-01, D3-RT-04, W2 host flow).
 *
 * The page owns two routes (PAGE-PLANS §1):
 *
 *   `/`                  HP-03 launcher once a room exists (HP-02 hero stays
 *                         next to it); never silently loads the cube demo.
 *   `/games/<slug>/`     HP-04 stage: start screen, then the game canvas with
 *                         a 48px room/player bar. Back/Escape opens HP-04b.
 *
 * This module only wires the focused collaborators in `src/host/`:
 *
 * 1. Room (D0): `room.ts` creates the room, runs `HostReconnect`, and owns the
 *    broker message switch and `InputFwd` routing into the single mapper.
 * 2. Runtime (D3/D7): `stage.ts` loads the bundled game through the same
 *    manifest path as any game, unlocks audio on the start gesture, and runs
 *    the `GameHost` fixed loop.
 * 3. Host flow (W2): `chrome.ts`, `launcher.ts`, `modals.ts`, `navigation.ts`,
 *    `notices.ts` and `events.ts` supply the launcher, stage chrome, leave
 *    confirmation, results overlay, HP-06 reconnect banner and HP-07 notices.
 *
 * Games only ever receive the `GameContext`; the `HostClient` stays here and in
 * `room.ts` (FR-7.17). A few callbacks are late-bound because the modules
 * reference each other (overlay reads stage stats, stage reports errors through
 * notices, navigation opens games and closes modals). None of them runs before
 * the room boots at the end of this function.
 */
import { toLoadProgress } from "../assets/gameAssets.js";
import { isDebugEnabled } from "../debug/Overlay.js";
import { createBundledGames } from "../demo/bundledGames.js";
import { createDebugCounters } from "../game/GameContext.js";
import { InputMapper } from "../input/InputMapper.js";
import { HostClient } from "../net/hostClient.js";
import { RoomPanel } from "../ui/RoomPanel.js";
import { renderJoinQr } from "../ui/QrCode.js";
import { createHostCapabilities } from "./capabilities.js";
import { createChrome, setupFullscreenToggle } from "./chrome.js";
import { element } from "./dom.js";
import { installHostEvents } from "./events.js";
import { createLauncher, type HostLauncher } from "./launcher.js";
import { createLauncherLayoutSync } from "./launcherLayout.js";
import { createModals, type HostModals } from "./modals.js";
import { createNavigation, type HostNavigation } from "./navigation.js";
import { createNotices } from "./notices.js";
import { createOverlay, type OverlayRuntimeStats } from "./overlay.js";
import { createPauseSync } from "./pause.js";
import { createRoomController, type RoomController } from "./room.js";
import { createRoster } from "./roster.js";
import { createStage, type HostStage } from "./stage.js";

/**
 * Mounts the live host page. `main.ts` calls it only when the real `#app`
 * shell is present, so importing the entry in tests never touches the DOM.
 */
export function bootstrapHost(): void {
  const connectionEl = element(document, "connection");
  const hintEl = element(document, "room-hint");
  const slotsEl = element(document, "slots");
  const gameRoot = element(document, "game-root");
  const appEl = element(document, "app");
  const topBar = appEl.querySelector(".top-bar");

  // Host fullscreen is a gesture action. The same control exists on the
  // controller; TV browsers that lack the API simply hide it.
  setupFullscreenToggle(document);

  const debug = isDebugEnabled(window.location.search);
  const debugCounters = createDebugCounters(debug);

  const client = new HostClient();
  const bundledGames = createBundledGames(document.baseURI);
  const mapper = new InputMapper();

  // Late-bound handles for the circular collaborations described above. They
  // stay null until the module that owns them is built further down; no
  // callback below runs before `bootHost()` starts the room.
  let stage: HostStage | null = null;
  let launcher: HostLauncher | null = null;
  let modals: HostModals | null = null;
  let navigation: HostNavigation | null = null;
  let roomController: RoomController | null = null;

  /** The overlay's explicit "nothing initialised yet" snapshot. */
  const EMPTY_RUNTIME: OverlayRuntimeStats = {
    backend: null,
    drawCalls: 0,
    textureMemoryMB: 0,
    resolution: null,
  };

  // HP-03/HP-04 chrome. Class names are owned by `src/style.css`.
  const chrome = createChrome(document, appEl, connectionEl, topBar);
  chrome.mount();

  // HP-08: the roster is the visible player list; the raw D0 table is debug
  // only and lives in its own container inside the roster section.
  const roster = createRoster({
    doc: document,
    slotsEl,
    stageRoomEl: chrome.stageRoomEl,
    stagePlayersEl: chrome.stagePlayersEl,
    debug,
    getRoomCode: () => roomController?.getRoomCode() ?? null,
    onCountsChanged: () => launcher?.syncCounts(),
  });

  const roomPanel = new RoomPanel(element(document, "room-panel"), {
    onNewRoom: () => void roomController?.createRoom(),
  });

  // D5/D6 capabilities. They are installed before `GameHost` builds the game
  // context, and the injected senders are the only place games can reach the
  // socket (FR-7.17).
  const capabilities = createHostCapabilities(client);

  // Spec 25 §2.7: phones drive the console home with the launcher layout.
  // It is broadcast only while the console is on screen and no game owns the
  // phones; every getter is late-bound to the collaborator assigned below.
  const launcherLayout = createLauncherLayoutSync({
    layouts: capabilities.layouts,
    isRoomReady: () =>
      roomController?.getPhase() === "ready" && client.state === "connected",
    isLauncherShown: () => {
      const shell = launcher?.shell ?? null;
      return shell !== null && shell.phase !== "loading";
    },
    isGameRunning: () => stage?.isStageActive() ?? false,
  });

  const notices = createNotices({
    doc: document,
    gameRoot,
    teardownGame: () => stage?.teardownGame(),
  });

  const syncPause = createPauseSync({
    doc: document,
    isNetworkLost: () => roomController?.isNetworkLost() ?? false,
    isModalOpen: () => modals?.isOpen() ?? false,
    pauseGame: () => stage?.pauseGame(),
    resumeGame: () => stage?.resumeGame(),
  });

  const overlay = createOverlay({
    doc: document,
    enabled: debug,
    debugCounters,
    capabilities,
    mapper,
    getServerStats: () => roomController?.getServerStats() ?? [],
    getRuntime: () => stage?.getDisplayStats() ?? EMPTY_RUNTIME,
    renderTable: roster.renderTable,
  });

  // HP-05/HP-04b overlays mount on the body so leaving a game cannot remove
  // them with the stage tree.
  modals = createModals({
    doc: document,
    isStageActive: () => stage?.isStageActive() ?? false,
    getCurrentSlug: () => stage?.getCurrentSlug() ?? null,
    pauseGame: () => stage?.pauseGame(),
    syncPause,
    openGame: (slug, options) => stage?.openGame(slug, options) ?? Promise.resolve(),
    returnToLauncher: () => navigation?.returnToLauncher(),
  });

  launcher = createLauncher({
    doc: document,
    gameRoot,
    games: bundledGames.games,
    connectedCount: roster.connectedCount,
    isRoomReady: () => (roomController?.getRoomCode() ?? null) !== null,
    getPathname: () => window.location.pathname,
    onLaunch: (slug) => navigation?.navigateToGame(slug),
    // Spec 25 additive wiring. Each getter is late-bound because the room and
    // the stage boot after the launcher is constructed.
    presentationFor: (slug) =>
      bundledGames.games.find((game) => game.slug === slug)?.presentation,
    roomCode: () => roomController?.getRoomCode() ?? null,
    roomPin: () => roomController?.getRoomPin() ?? null,
    joinUrl: () => roomController?.getJoinUrl() ?? null,
    renderQr: renderJoinQr,
    unlockAudio: () => stage?.unlockAudio() ?? Promise.resolve(),
    players: () => roster.playerInputs(),
    connection: () => roomController?.getConnection(),
    onCancelLaunch: () => navigation?.returnToLauncher(),
  });

  stage = createStage({
    doc: document,
    window,
    gameRoot,
    games: bundledGames,
    mapper,
    client,
    debugCounters,
    layouts: capabilities.layouts,
    eventRouter: capabilities.events,
    chrome,
    roster,
    notices,
    overlay,
    syncPause,
    hideLauncher: () => launcher?.destroy(),
    closeOverlays: () => modals?.closeAll(),
    onBackToGames: () => navigation?.returnToLauncher(),
    // Spec 25 §2.4: the console loading screen mirrors eager asset bytes.
    onAssetProgress: (progress) =>
      launcher?.setLoadingProgress(toLoadProgress(progress)),
  });

  navigation = createNavigation({
    window,
    doc: document,
    notices,
    launcher,
    stage,
    modals,
    onLauncherShown: () => launcherLayout.sync(),
  });

  roomController = createRoomController({
    window,
    client,
    mapper,
    layouts: capabilities.layouts,
    panels: capabilities.panels,
    events: capabilities.events,
    roster,
    chrome,
    roomPanel,
    hintEl,
    notices,
    syncPause,
    maybeShowLauncher: () => {
      launcher?.maybeShow();
      launcher?.syncCounts();
    },
    destroyLauncher: () => launcher?.destroy(),
    resetRouteToLauncher: () => navigation?.resetRouteToLauncher(),
    syncLauncher: () => {
      launcher?.syncCounts();
      launcherLayout.sync();
    },
    handleRemote: (button) => launcher?.handleRemote(button) ?? false,
  });

  // Spec 25: the console shell owns no frame loop. The host polls gamepads
  // once per frame while the launcher exists; `pollGamepad` emits its own
  // actions through the shell, so nothing is forwarded twice.
  if (typeof window.requestAnimationFrame === "function") {
    const pumpLauncherInput = (): void => {
      launcher?.pollGamepad();
      window.requestAnimationFrame(pumpLauncherInput);
    };
    window.requestAnimationFrame(pumpLauncherInput);
  }

  installHostEvents({
    window,
    doc: document,
    overlay,
    // Every handle above is assigned by now; the room is the last to boot.
    modals,
    stage,
    navigation,
    getPhase: () => roomController?.getPhase() ?? "idle",
    createRoom: () => void roomController?.createRoom(),
    pauseRecoveryForVisibility: () => roomController?.pauseForVisibility(),
    resumeRecoveryForVisibility: () => roomController?.resumeForVisibility(),
    syncPause,
  });

  // Refresh the age column and the overlay at 4 Hz.
  overlay.start();

  // Boot both paths in parallel: the room either resumes or is created
  // immediately (D0 acceptance), while the route loads (AR-4).
  void roomController.bootHost();
  void navigation.bootRoute();
}

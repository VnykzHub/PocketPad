/**
 * Host page shell (D0-RT-01) + runtime integration (D3-RT-04).
 *
 * Two independent boot paths share this page:
 *
 * 1. Room (D0, kept): `POST /api/rooms`, show code + PIN (and the D4
 *    RoomPanel QR), `await connect()`, `await hostJoin()`, then route
 *    `playerJoined/Left` and binary `InputFwd` frames. Every `InputFwd` goes
 *    into the single `InputMapper`; the debug table mirrors it.
 * 2. Runtime (D3): TV profile → renderer (WebGL2, Canvas2D fallback) →
 *    `loadGame(manifest)` (the cube demo, through the same manifest path as a
 *    real game) → start screen with asset progress → Enter unlocks audio and
 *    starts the `GameHost`, whose `FixedLoop` polls the mapper once per tick.
 *    `?debug=1` mounts the overlay; frame stats feed dynamic resolution;
 *    `visibilitychange` (and a lost host socket) pause the game.
 *
 * Games only ever receive the `GameContext`; the `HostClient` stays here
 * (FR-7.17).
 *
 * Secrets: `hostToken` is kept in host memory and `sessionStorage` only. The
 * room token is handed to the RoomPanel solely to draw the join QR and is
 * never written to text, attributes or logs (FR-5.1, SR-9).
 */
import type { ServerToClientMessage, SlotStats } from "@lanpad/protocol";
import { resolveServerOrigin, type GameHaptics } from "@lanpad/sdk";
import { AssetLoader, type AssetEntry } from "./assets/AssetLoader.js";
import { AudioBus } from "./audio/AudioBus.js";
import { InputTable } from "./debug/inputTable.js";
import { DebugOverlay, isDebugEnabled, type OverlaySlotStats } from "./debug/Overlay.js";
import { createBundledGames, CUBE_DEMO_MANIFEST_PATH } from "./demo/bundledGames.js";
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
import { RoomPanel } from "./ui/RoomPanel.js";
import { StartScreen } from "./ui/StartScreen.js";
import "./style.css";

/** Only the fields the host needs after creation. */
interface HostRoom {
  code: string;
  hostToken: string;
}

/** The cube demo has no downloadable assets; real games list theirs here. */
const GAME_ASSETS: readonly AssetEntry[] = [];
const SLOT_COUNT = 8;

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`Host shell is missing #${id}.`);
  }
  return found;
}

const connectionEl = element("connection");
const codeEl = element("room-code");
const pinEl = element("room-pin");
const hintEl = element("room-hint");
const slotsEl = element("slots");
const gameRoot = element("game-root");

const debug = isDebugEnabled(window.location.search);
const debugCounters = createDebugCounters(debug);
const table = new InputTable(slotsEl, { showTick: debug });
const client = new HostClient();

/**
 * Direct game route (D7): `/games/<slug>/` launches that bundled game; the
 * root path keeps the D3 cube demo. The dev server serves the host page at
 * both paths, so the route is pure client-side selection.
 */
const gameSlug = gameSlugFromPath(window.location.pathname);
const bundledGames = createBundledGames(document.baseURI);
const mapper = new InputMapper();
const roomPanel = new RoomPanel(element("room-panel"), {
  onNewRoom: () => void createRoom(),
});

// D5/D6 capabilities. They are installed before `GameHost` builds the game
// context, and the injected senders are the only place games can reach the
// socket (FR-7.17). `GameHost` is frozen in this wave, so the module-level
// registry in GameContext.ts is the seam.
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
let roomPin: string | null = null;
/** Latest 1 Hz server slot stats; the overlay prefers these for RTT/jitter. */
let serverStats: SlotStats[] = [];

// ---------------------------------------------------------------------------
// Runtime state (D3)
// ---------------------------------------------------------------------------

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
/** Set when the host socket drops; cleared on the next hostJoined. */
let networkLost = false;

function setConnection(text: string, tone: "pending" | "ok" | "bad"): void {
  connectionEl.textContent = text;
  connectionEl.dataset["state"] = tone;
}

function renderTable(): void {
  table.render(performance.now());
}

/** Single place that decides whether the game simulates (FR-9.2). */
function syncPause(): void {
  const host = gameHost;
  if (host === null) return;
  if (document.hidden || networkLost) {
    host.pause();
  } else {
    host.resume();
  }
}

// ---------------------------------------------------------------------------
// Host session recovery + capability helpers (D4-HOST-02)
// ---------------------------------------------------------------------------

/** Clears room-scoped game/UI state; leaves phase and socket handling alone. */
function clearRoomState(): void {
  layouts.clearAll();
  panels.clearAll();
  serverStats = [];
  mapper.reset();
  for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
    table.setPlayerLeft(slot);
  }
  renderTable();
  room = null;
  roomPin = null;
  roomPanel.setRoom(null);
  codeEl.textContent = "----";
  pinEl.textContent = "PIN ----";
  startScreen?.setRoom(null, null);
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
      break;
    case "connected":
      roomPanel.setHostStatus("connected");
      break;
    case "lost":
      roomPanel.setHostStatus("lost");
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
  setConnection(`Connected — room ${session.code}`, "ok");
  hintEl.textContent = "Room resumed.";
  layouts.resendAll();
  panels.resendAll();
}

function handleHostLost(): void {
  clearRoomState();
  networkLost = true;
  phase = "idle";
  syncPause();
  roomPanel.setHostStatus("lost");
  setConnection("Room lost — starting a new room…", "bad");
  hintEl.textContent = "Room lost. Creating a new room…";
  void createRoom();
}

// ---------------------------------------------------------------------------
// Room + host socket (D0 shell, D3 input routing)
// ---------------------------------------------------------------------------

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
    return;
  }
  phase = "failed";
  networkLost = true;
  syncPause();
  roomPanel.setHostJoined(false);
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
      setConnection(`Connected — room ${message.code}`, "ok");
      hintEl.textContent = "";
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
      renderTable();
      break;
    case "playerLeft":
      mapper.reset(message.slot);
      layouts.handleLeft(message.slot);
      panels.handleLeft(message.slot);
      table.setPlayerLeft(message.slot);
      renderTable();
      break;
    case "playerSuspended":
      // The reserved slot keeps its layout; only live input is dropped.
      mapper.reset(message.slot);
      renderTable();
      break;
    case "playerResumed":
      // Broker reservation returned: resend the host's layout and panel.
      mapper.reset(message.slot);
      table.setPlayerJoined(message.slot);
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
  setConnection("Creating room…", "pending");

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
  room = current;
  roomPin = credentials.pin;
  codeEl.textContent = credentials.code;
  pinEl.textContent = `PIN ${credentials.pin}`;
  hintEl.textContent = "";
  roomPanel.setRoom({
    code: credentials.code,
    pin: credentials.pin,
    roomToken: credentials.roomToken,
  });
  roomPanel.setHostJoined(false);
  startScreen?.setRoom(credentials.code, credentials.pin);

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

window.addEventListener("keydown", (event) => {
  overlay.handleKey(event.key);
  // While the start screen is up, Enter belongs to it (FR-9.11).
  if (startScreen !== null || !shouldCreateRoomOnKey(event.key, phase)) {
    return;
  }
  event.preventDefault();
  void createRoom();
});

// ---------------------------------------------------------------------------
// Runtime boot (D3)
// ---------------------------------------------------------------------------

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

function showPanel(className: string, title: string, lines: readonly string[]): HTMLElement {
  const panel = document.createElement("section");
  panel.className = className;
  panel.setAttribute("role", "alert");
  const heading = document.createElement("h2");
  heading.textContent = title;
  panel.append(heading);
  for (const line of lines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    panel.append(paragraph);
  }
  gameRoot.prepend(panel);
  return panel;
}

function showNotice(notice: RendererFallbackNotice): void {
  showPanel("lanpad-notice", notice.title, [notice.message, ...notice.hints]);
}

/** Fatal runtime error: stop the game and offer a reload (D3-SDK-01 risk). */
function showError(error: unknown): void {
  gameHost?.dispose();
  startScreen?.destroy();
  startScreen = null;
  const text = error instanceof Error ? error.message : "Unknown error.";
  const panel = showPanel("lanpad-error", "The game stopped", [text]);
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "Reload";
  reload.addEventListener("click", () => window.location.reload());
  panel.append(reload);
  reload.focus();
}

async function startGame(): Promise<void> {
  const host = gameHost;
  if (host === null || canvas === null) return;
  startScreen?.destroy();
  startScreen = null;
  canvas.hidden = false;
  applySize();
  try {
    await host.start();
  } catch (error) {
    showError(error);
    return;
  }
  syncPause();
}

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

async function bootRuntime(): Promise<void> {
  const surface = document.createElement("canvas");
  surface.className = "lanpad-canvas";
  surface.hidden = true;
  gameRoot.append(surface);
  canvas = surface;

  const gameEntry =
    gameSlug === null
      ? null
      : bundledGames.games.find((entry) => entry.slug === gameSlug) ?? null;
  if (gameSlug !== null && gameEntry === null) {
    surface.remove();
    canvas = null;
    showError(new Error(`Unknown game "${gameSlug}" at /games/${gameSlug}/.`));
    return;
  }

  let active: Renderer3D;
  try {
    // Reaction Duel and the D7 2D game API need Canvas2D; the cube demo keeps
    // the WebGL2 path (with its existing Canvas2D fallback).
    const selection = await initRenderer(surface, gameEntry === null ? "webgl2" : "canvas2d", {
      maxRenderHeight: profile.maxRenderHeight,
    });
    active = selection.renderer;
    renderer = active;
    backend = selection.backend;
    if (selection.fallbackNotice !== null) showNotice(selection.fallbackNotice);
  } catch (error) {
    surface.remove();
    canvas = null;
    if (error instanceof RendererUnavailableError) {
      showNotice(error.notice);
    } else {
      showError(error);
    }
    return;
  }

  const contextRecovery = new ContextLossRecovery({
    controller: resolution,
    onRestored: applySize,
  });
  attachContextLossRecovery(surface, contextRecovery);
  window.addEventListener("resize", applySize);

  let loaded: LoadedGame;
  try {
    const manifestUrl = gameEntry?.manifestUrl ?? CUBE_DEMO_MANIFEST_PATH;
    loaded = await loadGame(manifestUrl, { importModule: bundledGames.importModule });
    assertAssetBudget(loaded.manifest, GAME_ASSETS);
    // D5/D7 seam: games call `ctx.layouts.set(slot, "<layout id>")`, and the
    // host registers the manifest's layout files before the game starts.
    await registerManifestLayouts(layouts, loaded);
  } catch (error) {
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

  const screen = new StartScreen(document, {
    audio,
    title: loaded.manifest.name,
    onStart: () => void startGame(),
  });
  startScreen = screen;
  if (room !== null) screen.setRoom(room.code, roomPin);
  gameRoot.prepend(screen.element);
  screen.focus();

  try {
    await new AssetLoader().load(GAME_ASSETS, (progress) => screen.updateProgress(progress));
  } catch (error) {
    showError(error);
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
  roomPin = null;
  phase = "ready";
  networkLost = result !== "resumed";
  syncPause();
  codeEl.textContent = session.code;
  pinEl.textContent = "PIN ----";
  // Only `{code, hostToken}` survives a reload, so there is no room token or
  // PIN for a fresh QR. Already-connected phones keep their 30 s reservation.
  roomPanel.setResumedRoom(session.code);
  startScreen?.setRoom(session.code, null);
  if (result === "recovering") {
    roomPanel.setHostStatus("reconnecting");
    setConnection("Reconnecting…", "pending");
    hintEl.textContent = "Waiting for the room connection to recover…";
  } else {
    setConnection(`Connected — room ${session.code}`, "ok");
    hintEl.textContent = "Room resumed.";
  }
}

// Refresh the age column and the overlay at 4 Hz.
window.setInterval(tick4Hz, 250);

// Boot both paths in parallel: the room either resumes or is created
// immediately (D0 acceptance), while the runtime loads; Enter on the start
// screen begins the game (AR-4).
void bootHost();
void bootRuntime();

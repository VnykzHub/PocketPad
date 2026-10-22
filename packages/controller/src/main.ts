/**
 * Controller page shell (D0-CTRL-01, D2-CTRL-04, D4-CTRL-01/02).
 *
 * Wires the join flow, the connection pill and the D2 layout mount to the
 * network client. When a layout arrives, the full-screen play surface replaces
 * the join/test shell; the D0 Test button remains the fallback when the room
 * has no layout yet. The client is the only socket owner and the only sender;
 * controls never touch the socket.
 *
 * D4 bootstrap (`client.start`): the URL fragment is cleared before any
 * network call, then a stored session, the QR room token and finally the
 * manual code + PIN form are tried in that order (FR-5.1, FR-5.4–5.6). The
 * client owns reconnect, suspend-on-hidden and the Wake Lock (FR-7.14/7.15,
 * FR-8.8); this shell only renders its state. No token or PIN is ever written
 * to the DOM or a log.
 */
import type { LayoutDocument } from "@lanpad/sdk";
import {
  ControllerClient,
  createMemoryStorage,
  type ControllerState,
} from "./net/controllerClient.js";
import type { JoinFlowState } from "./join/joinFlow.js";
import { createSessionStore, type StorageLike } from "./join/sessionStore.js";
import { ConnectionPill } from "./ui/ConnectionPill.js";
import { HapticPlayer } from "./haptics/HapticPlayer.js";
import { HapticsToggle } from "./haptics/toggle.js";
import { normalizeRoomCode, parseControllerPath } from "./route.js";
import { DebugOverlay, SCRIPT_SAMPLE_CAPACITY } from "./debug/overlay.js";
import { ViewportTracker } from "./layout/viewport.js";
import "./styles.css";

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Controller shell is missing #${id}`);
  }
  return element as T;
}

const connectionPill = requireElement<HTMLSpanElement>("connection");
const hapticsButton = requireElement<HTMLButtonElement>("haptics-toggle");
const joinForm = requireElement<HTMLFormElement>("join-form");
const codeInput = requireElement<HTMLInputElement>("code");
const pinInput = requireElement<HTMLInputElement>("pin");
const joinError = requireElement<HTMLParagraphElement>("join-error");
const joinButton = requireElement<HTMLButtonElement>("join-button");
const controllerPanel = requireElement<HTMLElement>("controller");
const slotLabel = requireElement<HTMLParagraphElement>("slot-label");
const testButton = requireElement<HTMLButtonElement>("test-button");
const playSurface = requireElement<HTMLElement>("play-surface");
const debugOverlay = requireElement<HTMLElement>("debug-overlay");

/** Reading `window.sessionStorage` itself can throw in private mode. */
function browserStorage(name: "sessionStorage" | "localStorage"): StorageLike | null {
  try {
    return window[name];
  } catch {
    return null;
  }
}

function showJoinError(message: string | null): void {
  if (message === null) {
    joinError.textContent = "";
    joinError.hidden = true;
    return;
  }
  joinError.textContent = message;
  joinError.hidden = false;
}

const search = new URLSearchParams(window.location.search);
const layoutDebug = search.get("layout") === "debug";

// D2-PERF-01: the overlay is opt-in only. `?debug=1` matches the host's
// FR-12.2 flag; without it the HUD never becomes visible.
const debugEnabled = search.get("debug") === "1";
const overlay = new DebugOverlay({
  mount: debugOverlay,
  enabled: debugEnabled,
  capacity: SCRIPT_SAMPLE_CAPACITY,
});

// D5-CTRL-03: the page owns the visual-viewport tracker; text controls use it
// to stay above the on-screen keyboard (visualViewport with innerHeight
// fallback).
const viewport = new ViewportTracker(window);

const client = new ControllerClient({
  surface: playSurface,
  // performance.now() is monotonic, which ClockSync's min-RTT filter expects.
  now: () => performance.now(),
  debugOutline: layoutDebug,
  viewport,
  // FR-5.1: the join flow strips the fragment through the real history.
  history: window.history,
  // FR-5.4: sessionStorage per tab, mirrored to localStorage for a browser
  // restart. Private mode falls back to a tab-lifetime store.
  sessionStore: createSessionStore({
    sessionStorage: browserStorage("sessionStorage") ?? createMemoryStorage(),
    localStorage: browserStorage("localStorage"),
  }),
});

const pill = new ConnectionPill(connectionPill);

// D6-CTRL-04: one player per page. The toggle is per viewer and persisted as
// "on"/"off"; patterns themselves are never stored or logged (FR-8.12, SR-12).
const hapticsToggle = new HapticsToggle();
const hapticPlayer = new HapticPlayer();
hapticsToggle.bindPlayer(hapticPlayer);
hapticsToggle.bindButton(hapticsButton, { updateLabel: true });
client.onHaptic((durations) => {
  hapticPlayer.handleDurations(durations);
});

/** Layout currently mounted by the client; null while the room has none. */
let currentLayout: LayoutDocument | null = null;
let lockoutTimer: number | null = null;

/** Re-renders once a rate-limit lockout ends so the Join button re-enables. */
function scheduleLockoutRender(): void {
  const remaining = client.retryAfterMs;
  if (remaining <= 0 || lockoutTimer !== null) {
    return;
  }
  lockoutTimer = window.setTimeout(() => {
    lockoutTimer = null;
    render(client.currentState);
  }, remaining);
}

function render(state: ControllerState): void {
  pill.connectionModel.setPhase(state.status, state.slot);
  pill.connectionModel.setHostStatus(state.status === "connected" ? state.host : null);

  // While reconnecting the slot is still reserved: keep the controls up so a
  // press during the gap is latched and delivered after the rejoin (FR-5.4).
  const live = state.status === "connected" || state.status === "reconnecting";
  const playing = live && currentLayout !== null;
  document.body.classList.toggle("playing", playing);
  playSurface.hidden = !playing;

  if (live) {
    joinForm.hidden = true;
    controllerPanel.hidden = playing;
    slotLabel.textContent = state.slot === null ? "Connected" : `Player ${state.slot}`;
    testButton.disabled = false;
    joinButton.disabled = false;
    showJoinError(null);
    return;
  }

  controllerPanel.hidden = true;
  joinForm.hidden = false;
  testButton.disabled = true;
  joinButton.disabled = state.status === "connecting" || client.retryAfterMs > 0;
  scheduleLockoutRender();

  if (state.status === "connecting") {
    showJoinError(null);
    return;
  }

  showJoinError(state.error);
  if (state.error !== null) {
    pinInput.focus();
    pinInput.select();
  }
}

/** Keeps the form's code field in step with the flow (never the token). */
function handleJoinState(state: JoinFlowState): void {
  if ((state.status === "manual" || state.status === "error") && state.code !== null) {
    if (codeInput.value === "") {
      codeInput.value = state.code;
    }
  }
}

client.onState(render);
client.onJoinState(handleJoinState);
client.onLayout((layout) => {
  currentLayout = layout;
  render(client.currentState);
});

const routeCode = parseControllerPath(window.location.pathname).code;
if (routeCode !== null) {
  codeInput.value = routeCode;
  pinInput.focus();
} else {
  codeInput.focus();
}

// FR-5.1/5.4: clears the fragment, then session → room token → manual form.
client.start({
  pathname: window.location.pathname,
  hash: window.location.hash,
  search: window.location.search,
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const code = normalizeRoomCode(codeInput.value);
  if (code === null) {
    showJoinError("Enter the 4-character room code shown on the TV.");
    codeInput.focus();
    return;
  }

  const pin = pinInput.value.trim();
  // FR-5.3: after "Room is full" a QR player can retry without a PIN; the
  // flow re-runs session → room token precedence.
  const joinState = client.joinState;
  if (pin === "" && joinState.status === "error" && joinState.kind === "roomFull") {
    showJoinError(null);
    client.retryJoin();
    return;
  }
  if (!/^\d{4}$/.test(pin)) {
    showJoinError("Enter the 4-digit PIN shown on the TV.");
    pinInput.focus();
    return;
  }

  codeInput.value = code;
  showJoinError(null);
  joinButton.disabled = true;
  client.connect(code, pin);
});

let activePointerId: number | null = null;

testButton.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }
  if (activePointerId !== null) {
    return;
  }
  activePointerId = event.pointerId;
  // Capture keeps pointerup on this element even if the finger slides off.
  try {
    testButton.setPointerCapture(event.pointerId);
  } catch {
    // Older browsers may reject capture; the window-level release still fires.
  }
  event.preventDefault();
  client.press();
});

function endPress(event: PointerEvent): void {
  if (activePointerId === null || event.pointerId !== activePointerId) {
    return;
  }
  activePointerId = null;
  client.release();
}

window.addEventListener("pointerup", endPress);
window.addEventListener("pointercancel", endPress);

// Keyboard operability for the same Test button (pointer is not the only path).
testButton.addEventListener("keydown", (event) => {
  if (event.key !== " " && event.key !== "Enter") {
    return;
  }
  if (event.repeat) {
    return;
  }
  event.preventDefault();
  client.press();
});

testButton.addEventListener("keyup", (event) => {
  if (event.key !== " " && event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  client.release();
});

// --- Debug overlay (D2-PERF-01) --------------------------------------------
// Enabled only by `?debug=1`; triple-tap top-left then toggles it. The overlay
// is pointer-transparent, so it never steals a touch from a control.

let cornerTapCount = 0;
let lastCornerTapAt = 0;

window.addEventListener(
  "pointerdown",
  (event) => {
    if (!overlay.enabled) {
      return;
    }
    if (event.clientX > 64 || event.clientY > 64) {
      cornerTapCount = 0;
      return;
    }
    const now = performance.now();
    cornerTapCount = now - lastCornerTapAt <= 600 ? cornerTapCount + 1 : 1;
    lastCornerTapAt = now;
    if (cornerTapCount >= 3) {
      cornerTapCount = 0;
      overlay.toggle();
    }
  },
  { capture: true, passive: true },
);

if (overlay.enabled) {
  // Window capture → bubble spans the hit-test and every control handler, so
  // the p50/p95 includes the work a touch actually costs (FR-8.3).
  overlay.observeTouchTiming(window);
  window.setInterval(() => {
    overlay.update(client.stats);
  }, 500);
}

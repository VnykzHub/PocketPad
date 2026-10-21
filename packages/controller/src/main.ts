/**
 * Controller page shell (D0-CTRL-01, D2-CTRL-04).
 *
 * Wires URL routing, the join form, the connection pill and the D2 layout mount
 * to the network client. When a layout arrives, the full-screen play surface
 * replaces the join/test shell; the D0 Test button remains the fallback when the
 * room has no layout yet. The client is the only socket owner and the only
 * sender; controls never touch the socket.
 */
import type { LayoutDocument } from "@lanpad/sdk";
import {
  ControllerClient,
  connectionPillLabel,
  type ControllerState,
} from "./net/controllerClient.js";
import { clearUrlFragment, normalizeRoomCode, parseControllerRoute } from "./route.js";
import { DebugOverlay, SCRIPT_SAMPLE_CAPACITY } from "./debug/overlay.js";
import "./styles.css";

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Controller shell is missing #${id}`);
  }
  return element as T;
}

const connectionPill = requireElement<HTMLSpanElement>("connection");
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

/**
 * Read the route and drop the fragment before anything touches the network
 * (FR-5.1). D2 parses the token but does not use it; D4 adds token join.
 */
const route = parseControllerRoute(window.location.pathname, window.location.hash);
clearUrlFragment(window.history, window.location.pathname, window.location.search);

function showJoinError(message: string | null): void {
  if (message === null) {
    joinError.textContent = "";
    joinError.hidden = true;
    return;
  }
  joinError.textContent = message;
  joinError.hidden = false;
}

const layoutDebug =
  new URLSearchParams(window.location.search).get("layout") === "debug";

// D2-PERF-01: the overlay is opt-in only. `?debug=1` matches the host's
// FR-12.2 flag; without it the HUD never becomes visible.
const debugEnabled =
  new URLSearchParams(window.location.search).get("debug") === "1";
const overlay = new DebugOverlay({
  mount: debugOverlay,
  enabled: debugEnabled,
  capacity: SCRIPT_SAMPLE_CAPACITY,
});

const client = new ControllerClient({
  surface: playSurface,
  // performance.now() is monotonic, which ClockSync's min-RTT filter expects.
  now: () => performance.now(),
  debugOutline: layoutDebug,
});

/** Layout currently mounted by the client; null while the room has none. */
let currentLayout: LayoutDocument | null = null;

function render(state: ControllerState): void {
  connectionPill.textContent = connectionPillLabel(state);
  connectionPill.dataset["state"] = state.status;

  const playing = state.status === "connected" && currentLayout !== null;
  document.body.classList.toggle("playing", playing);
  playSurface.hidden = !playing;

  if (state.status === "connected") {
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
  joinButton.disabled = state.status === "connecting";

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

client.onState(render);
client.onLayout((layout) => {
  currentLayout = layout;
  render(client.currentState);
});

if (route.code !== null) {
  codeInput.value = route.code;
  pinInput.focus();
} else {
  codeInput.focus();
}

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const code = normalizeRoomCode(codeInput.value);
  if (code === null) {
    showJoinError("Enter the 4-character room code shown on the TV.");
    codeInput.focus();
    return;
  }

  const pin = pinInput.value.trim();
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

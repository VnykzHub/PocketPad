/**
 * Controller page shell (D0-CTRL-01, D2-CTRL-04, D4-CTRL-01/02, W3).
 *
 * Wires the join flow, the connection pill and the D2 layout mount to the
 * network client. The shell renders one of the five visible states from
 * PAGE-PLANS §5:
 *
 *   CP-01/02/03  join form, connecting, error/lockout
 *   CP-04        connected with no layout (waiting)
 *   CP-05        playing (layout mounted in the full-bleed surface)
 *   CP-06        reconnecting banner over the playing surface
 *   CP-19        a landscape layout while the phone is in portrait
 *
 * D4 bootstrap (`client.start`): the URL fragment is cleared before any
 * network call, then a stored session, the QR room token and finally the
 * manual code + PIN form are tried in that order (FR-5.1, FR-5.4–5.6). The
 * client owns reconnect, suspend-on-hidden and the Wake Lock (FR-7.14/7.15,
 * FR-8.8); this shell only renders its state. No token is ever written to the
 * DOM or a log. The PIN shown on the waiting page is the one the player typed
 * on this phone (CP-04); it stays in memory for this page only and is cleared
 * when the connection ends.
 *
 * The shell keeps the existing `ControllerClient` behaviour, including the
 * latched press path during a reconnect: `test-button` is debug-only
 * (`?debug=1`, CP-04) and the layout controls mounted by the client stay live
 * while the banner is up (CP-06).
 *
 * Orientation: the play surface is passed to the client unchanged. The shell
 * shows CP-19 and hides the surface while a landscape layout meets a portrait
 * viewport; rotation re-renders in place, and the touch engine's own resize /
 * orientation listeners rebuild the mounted layout without a reload (CP-19).
 */
import type { LayoutDocument } from "@lanpad/sdk";
import {
  ControllerClient,
  createMemoryStorage,
  joinStateCode,
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

/** CP-06 banner copy; the pill says the same thing for screen readers. */
export const RECONNECT_BANNER_TEXT = "Reconnecting…";

/** CP-04 state line while the room has no layout yet. */
export const WAITING_CONNECTED_TEXT = "Connected. Waiting for the game to start.";

/** CP-04 state line while the socket is being reclaimed. */
export const WAITING_RECONNECTING_TEXT = "Waiting for the game to start.";

/** CP-03 lockout countdown cadence. */
export const LOCKOUT_TICK_MS = 1000;

/** CP-01 local validation copy (the server copy lives in `JoinFlow`). */
export const INVALID_CODE_TEXT = "Enter the 4-character room code shown on the TV.";
export const INVALID_PIN_TEXT = "Enter the 4-digit PIN shown on the TV.";

/** Visible states of the controller page (PAGE-PLANS §5). */
export type ShellScreen = "join" | "waiting" | "playing" | "orientation";

/** What the shell needs from the network client; `ControllerClient` satisfies it. */
export interface ControllerShellClient {
  readonly currentState: ControllerState;
  readonly joinState: JoinFlowState;
  readonly retryAfterMs: number;
  onState(listener: (state: ControllerState) => void): () => void;
  onLayout(listener: (layout: LayoutDocument | null) => void): () => void;
  onJoinState(listener: (state: JoinFlowState) => void): () => void;
  connect(code: string, pin: string): void;
  retryJoin(): JoinFlowState;
  /** D0 debug Test button; absent outside `?debug=1`. */
  press?(buttonMask?: number): void;
  release?(): void;
}

/** Elements the page shell owns or receives from `index.html`. */
export interface ControllerShellElements {
  app: HTMLElement;
  pill: ConnectionPill;
  joinForm: HTMLFormElement;
  codeInput: HTMLInputElement;
  pinInput: HTMLInputElement;
  joinError: HTMLParagraphElement;
  joinButton: HTMLButtonElement;
  controllerPanel: HTMLElement;
  slotLabel: HTMLElement;
  /** `null` once the normal waiting page has dropped the debug control. */
  testButton: HTMLButtonElement | null;
  playSurface: HTMLElement;
  orientation: HTMLElement;
}

export interface ControllerShellOptions {
  client: ControllerShellClient;
  elements: ControllerShellElements;
  /** `?debug=1`: keeps the Test button and the debug overlay affordances. */
  debug: boolean;
}

/** True when the visible viewport is taller than it is wide (CP-19). */
export function isPortraitViewport(width: number, height: number): boolean {
  return height > width;
}

/** CP-19 only applies to a landscape layout on a portrait phone. */
export function layoutNeedsRotation(
  layout: LayoutDocument | null,
  portrait: boolean,
): boolean {
  return layout !== null && layout.orientation === "landscape" && portrait;
}

/**
 * The one mapping from connection state + layout + orientation to a screen.
 * A socket that is down always returns to CP-01/03, even if a stale layout is
 * still cached, so a lost host can never leave dead controls on screen.
 */
export function resolveShellScreen(
  state: ControllerState,
  layout: LayoutDocument | null,
  portrait: boolean,
): ShellScreen {
  const live = state.status === "connected" || state.status === "reconnecting";
  if (!live) {
    return "join";
  }
  if (layout === null) {
    return "waiting";
  }
  return layoutNeedsRotation(layout, portrait) ? "orientation" : "playing";
}

/** CP-04 room line: "Room B26A · PIN 1596" (PIN only when this phone has it). */
export function formatRoomLine(code: string | null, pin: string | null): string | null {
  if (code === null) {
    return null;
  }
  return pin === null ? `Room ${code}` : `Room ${code} · PIN ${pin}`;
}

/** CP-02/CP-03 Join button label; the countdown is whole seconds, rounded up. */
export function joinButtonLabel(state: ControllerState, retryAfterMs: number): string {
  if (state.status === "connecting") {
    return "Joining…";
  }
  const seconds = Math.ceil(retryAfterMs / 1000);
  return seconds > 0 ? `Try again in ${seconds}s` : "Join";
}

/**
 * The visible state machine and DOM binding for the controller page.
 *
 * It never touches the socket: the client is injected, and every DOM write
 * here is `textContent` or an attribute/class toggle. Constructed once by the
 * page bootstrap; tests construct it against a fake client and a jsdom fixture.
 */
export class ControllerShell {
  private readonly client: ControllerShellClient;
  private readonly elements: ControllerShellElements;
  private readonly debug: boolean;

  private readonly roomLine: HTMLParagraphElement;
  private readonly waitingState: HTMLElement;
  private readonly banner: HTMLElement;

  private readonly unsubscribers: Array<() => void> = [];
  private currentLayout: LayoutDocument | null = null;
  private manualCode: string | null = null;
  private manualPin: string | null = null;
  private lastError: string | null = null;
  private lockoutTimer: number | null = null;
  private testButton: HTMLButtonElement | null = null;
  private activePointerId: number | null = null;

  constructor(options: ControllerShellOptions) {
    this.client = options.client;
    this.elements = options.elements;
    this.debug = options.debug;

    this.waitingState = this.resolveWaitingState();
    this.roomLine = this.createRoomLine();
    this.banner = this.createBanner();

    // CP-04: the D0 Test button is debug-only. `remove()` is deliberate: a
    // fresh phone must never see a Test control, not merely a hidden one.
    if (this.debug) {
      this.testButton =
        this.elements.testButton ?? createDebugTestButton(this.elements.controllerPanel);
      this.bindTestButton(this.testButton);
    } else {
      this.elements.testButton?.remove();
    }

    this.elements.joinForm.addEventListener("submit", this.handleSubmit);
    this.elements.codeInput.addEventListener("input", this.handleCodeInput);
    this.elements.pinInput.addEventListener("input", this.handlePinInput);
    window.addEventListener("resize", this.handleViewportChange);
    window.addEventListener("orientationchange", this.handleViewportChange);

    this.unsubscribers.push(
      this.client.onLayout((layout) => {
        this.currentLayout = layout;
        this.render(this.client.currentState);
      }),
      this.client.onState((state) => {
        this.render(state);
      }),
      this.client.onJoinState((state) => {
        this.handleJoinState(state);
      }),
    );
  }

  /** Current screen, exposed for diagnostics and tests. */
  get screen(): ShellScreen {
    return resolveShellScreen(
      this.client.currentState,
      this.currentLayout,
      isPortraitViewport(window.innerWidth, window.innerHeight),
    );
  }

  /** Removes every DOM listener, timer and client subscription. */
  destroy(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.unsubscribers.length = 0;
    this.stopLockoutTimer();
    this.elements.joinForm.removeEventListener("submit", this.handleSubmit);
    this.elements.codeInput.removeEventListener("input", this.handleCodeInput);
    this.elements.pinInput.removeEventListener("input", this.handlePinInput);
    window.removeEventListener("resize", this.handleViewportChange);
    window.removeEventListener("orientationchange", this.handleViewportChange);
    window.removeEventListener("pointerup", this.handleTestPointerEnd);
    window.removeEventListener("pointercancel", this.handleTestPointerEnd);
    if (this.testButton !== null) {
      this.testButton.removeEventListener("pointerdown", this.handleTestPointerDown);
      this.testButton.removeEventListener("keydown", this.handleTestKeyDown);
      this.testButton.removeEventListener("keyup", this.handleTestKeyUp);
    }
  }

  private resolveWaitingState(): HTMLElement {
    const existing =
      this.elements.controllerPanel.querySelector<HTMLElement>(".waiting-state");
    if (existing !== null) {
      return existing;
    }
    const element = document.createElement("p");
    element.className = "waiting-state";
    this.elements.controllerPanel.append(element);
    return element;
  }

  private createRoomLine(): HTMLParagraphElement {
    const line = document.createElement("p");
    line.id = "room-line";
    line.className = "room-line";
    line.hidden = true;
    this.elements.controllerPanel.append(line);
    return line;
  }

  private createBanner(): HTMLElement {
    const banner = document.createElement("div");
    banner.id = "reconnect-banner";
    banner.className = "reconnect-banner";
    banner.hidden = true;
    // The status pill already announces the state; the banner is the visual
    // reinforcement CP-06 asks for, not a second live region.
    banner.setAttribute("aria-hidden", "true");

    const dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.textContent = RECONNECT_BANNER_TEXT;
    banner.append(dot, label);
    this.elements.app.append(banner);
    return banner;
  }

  private render(state: ControllerState): void {
    const portrait = isPortraitViewport(window.innerWidth, window.innerHeight);
    const screen = resolveShellScreen(state, this.currentLayout, portrait);
    const live = state.status === "connected" || state.status === "reconnecting";

    this.elements.pill.connectionModel.setPhase(state.status, state.slot);
    this.elements.pill.connectionModel.setHostStatus(
      state.status === "connected" ? state.host : null,
    );

    // CP-05: the play surface owns the viewport while a layout is mounted;
    // CP-19 keeps the surface hidden but the top bar (and its pill) visible.
    document.body.classList.toggle(
      "playing",
      screen === "playing" || screen === "orientation",
    );
    this.elements.joinForm.hidden = screen !== "join";
    this.elements.controllerPanel.hidden = screen !== "waiting";
    this.elements.playSurface.hidden = screen !== "playing";
    this.elements.orientation.hidden = screen !== "orientation";

    // CP-06: the banner appears only for a dropped socket. Host presence is
    // already the pill's job ("Waiting for TV" / "TV paused"), so there is
    // never a second message for a paused host.
    this.banner.hidden = state.status !== "reconnecting";

    if (this.testButton !== null) {
      this.testButton.disabled = !live;
    }

    if (screen !== "join") {
      this.showFormError(null);
      this.lastError = null;
      this.stopLockoutTimer();
      this.elements.slotLabel.textContent =
        state.slot === null ? "Connected" : `Player ${state.slot}`;
      this.waitingState.textContent =
        state.status === "reconnecting"
          ? WAITING_RECONNECTING_TEXT
          : WAITING_CONNECTED_TEXT;
      this.renderRoomLine();
      return;
    }

    // CP-01/02/03: the join form owns the page.
    this.roomLine.hidden = true;
    this.roomLine.textContent = "";
    this.waitingState.textContent = "";
    if (state.status === "disconnected") {
      this.manualPin = null;
    }

    const retryAfterMs = this.client.retryAfterMs;
    const connecting = state.status === "connecting";
    this.elements.joinButton.textContent = joinButtonLabel(state, retryAfterMs);
    this.elements.joinButton.disabled = connecting || retryAfterMs > 0;
    // CP-02: fields stay readable but are not editable while joining.
    this.elements.codeInput.readOnly = connecting;
    this.elements.pinInput.readOnly = connecting;
    this.syncLockoutTimer(retryAfterMs);

    if (connecting) {
      this.showFormError(null);
      this.lastError = null;
      return;
    }

    const message = state.error;
    this.showFormError(message);
    const errorChanged = message !== this.lastError;
    this.lastError = message;
    // CP-03: focus the PIN exactly once per new error, never on every
    // lockout tick (which would keep stealing the selection).
    if (message !== null && errorChanged) {
      this.elements.pinInput.focus();
      this.elements.pinInput.select();
    }
  }

  private renderRoomLine(): void {
    const code = joinStateCode(this.client.joinState) ?? this.manualCode;
    const line = formatRoomLine(code, this.manualPin);
    this.roomLine.textContent = line ?? "";
    this.roomLine.hidden = line === null;
  }

  private handleJoinState(state: JoinFlowState): void {
    if (
      (state.status === "manual" || state.status === "error") &&
      state.code !== null &&
      this.elements.codeInput.value === ""
    ) {
      this.elements.codeInput.value = state.code;
    }
  }

  private showFormError(message: string | null): void {
    if (message === null) {
      this.elements.joinError.textContent = "";
      this.elements.joinError.hidden = true;
      return;
    }
    this.elements.joinError.textContent = message;
    this.elements.joinError.hidden = false;
  }

  /** Keeps the CP-03 countdown ticking once per second until it reaches zero. */
  private syncLockoutTimer(retryAfterMs: number): void {
    if (retryAfterMs <= 0) {
      this.stopLockoutTimer();
      return;
    }
    if (this.lockoutTimer !== null) {
      return;
    }
    this.lockoutTimer = window.setInterval(() => {
      if (this.client.retryAfterMs <= 0) {
        this.stopLockoutTimer();
      }
      this.render(this.client.currentState);
    }, LOCKOUT_TICK_MS);
  }

  private stopLockoutTimer(): void {
    if (this.lockoutTimer === null) {
      return;
    }
    window.clearInterval(this.lockoutTimer);
    this.lockoutTimer = null;
  }

  private readonly handleViewportChange = (): void => {
    this.render(this.client.currentState);
  };

  private readonly handleCodeInput = (): void => {
    const upper = this.elements.codeInput.value.toUpperCase();
    if (upper !== this.elements.codeInput.value) {
      this.elements.codeInput.value = upper;
    }
    // CP-01: a complete, valid code moves focus to the PIN and never submits.
    if (
      normalizeRoomCode(upper) !== null &&
      document.activeElement === this.elements.codeInput
    ) {
      this.elements.pinInput.focus();
    }
  };

  private readonly handlePinInput = (): void => {
    const digits = this.elements.pinInput.value.replace(/\D/g, "").slice(0, 4);
    if (digits !== this.elements.pinInput.value) {
      this.elements.pinInput.value = digits;
    }
    // Deliberately no auto-submit: a four-digit PIN waits for the Join tap.
  };

  private readonly handleSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (this.client.retryAfterMs > 0) {
      return;
    }

    const code = normalizeRoomCode(this.elements.codeInput.value);
    if (code === null) {
      this.showFormError(INVALID_CODE_TEXT);
      this.lastError = null;
      this.elements.codeInput.focus();
      return;
    }

    const pin = this.elements.pinInput.value.trim();
    // FR-5.3: after "Room is full" a QR player can retry without a PIN.
    const joinState = this.client.joinState;
    if (pin === "" && joinState.status === "error" && joinState.kind === "roomFull") {
      this.manualCode = code;
      this.showFormError(null);
      this.client.retryJoin();
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      this.showFormError(INVALID_PIN_TEXT);
      this.lastError = null;
      this.elements.pinInput.focus();
      return;
    }

    this.elements.codeInput.value = code;
    this.manualCode = code;
    this.manualPin = pin;
    this.showFormError(null);
    this.lastError = null;
    this.elements.joinButton.disabled = true;
    this.client.connect(code, pin);
  };

  private bindTestButton(button: HTMLButtonElement): void {
    button.addEventListener("pointerdown", this.handleTestPointerDown);
    button.addEventListener("keydown", this.handleTestKeyDown);
    button.addEventListener("keyup", this.handleTestKeyUp);
    window.addEventListener("pointerup", this.handleTestPointerEnd);
    window.addEventListener("pointercancel", this.handleTestPointerEnd);
  }

  private readonly handleTestPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    if (this.activePointerId !== null || this.testButton === null) {
      return;
    }
    this.activePointerId = event.pointerId;
    // Capture keeps pointerup on this element even if the finger slides off.
    try {
      this.testButton.setPointerCapture(event.pointerId);
    } catch {
      // Older browsers may reject capture; the window-level release still fires.
    }
    event.preventDefault();
    this.client.press?.();
  };

  private readonly handleTestPointerEnd = (event: PointerEvent): void => {
    if (this.activePointerId === null || event.pointerId !== this.activePointerId) {
      return;
    }
    this.activePointerId = null;
    this.client.release?.();
  };

  private readonly handleTestKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== " " && event.key !== "Enter") {
      return;
    }
    if (event.repeat) {
      return;
    }
    event.preventDefault();
    this.client.press?.();
  };

  private readonly handleTestKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== " " && event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    this.client.release?.();
  };
}

function createDebugTestButton(parent: HTMLElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = "test-button";
  button.type = "button";
  button.className = "test-button";
  button.textContent = "Test";
  button.disabled = true;
  parent.append(button);
  return button;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Controller shell is missing #${id}`);
  }
  return element as T;
}

/** Reading `window.sessionStorage` itself can throw in private mode. */
function browserStorage(name: "sessionStorage" | "localStorage"): StorageLike | null {
  try {
    return window[name];
  } catch {
    return null;
  }
}

function bootstrap(): void {
  const search = new URLSearchParams(window.location.search);
  const layoutDebug = search.get("layout") === "debug";
  // D2-PERF-01: the overlay is opt-in only. `?debug=1` matches the host's
  // FR-12.2 flag; without it the HUD never becomes visible and the waiting
  // page never offers the D0 Test button.
  const debugEnabled = search.get("debug") === "1";

  const connectionPillElement = requireElement<HTMLSpanElement>("connection");
  const hapticsButton = requireElement<HTMLButtonElement>("haptics-toggle");
  const app = requireElement<HTMLElement>("app");
  const joinForm = requireElement<HTMLFormElement>("join-form");
  const codeInput = requireElement<HTMLInputElement>("code");
  const pinInput = requireElement<HTMLInputElement>("pin");
  const joinError = requireElement<HTMLParagraphElement>("join-error");
  const joinButton = requireElement<HTMLButtonElement>("join-button");
  const controllerPanel = requireElement<HTMLElement>("controller");
  const slotLabel = requireElement<HTMLParagraphElement>("slot-label");
  const playSurface = requireElement<HTMLElement>("play-surface");
  const orientation = requireElement<HTMLElement>("orientation");
  const debugOverlay = requireElement<HTMLElement>("debug-overlay");
  const testButton = document.getElementById("test-button") as HTMLButtonElement | null;

  const overlay = new DebugOverlay({
    mount: debugOverlay,
    enabled: debugEnabled,
    capacity: SCRIPT_SAMPLE_CAPACITY,
  });

  // D5-CTRL-03: the page owns the visual-viewport tracker; text controls use
  // it to stay above the on-screen keyboard (visualViewport with innerHeight
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

  const pill = new ConnectionPill(connectionPillElement);

  new ControllerShell({
    client,
    debug: debugEnabled,
    elements: {
      app,
      pill,
      joinForm,
      codeInput,
      pinInput,
      joinError,
      joinButton,
      controllerPanel,
      slotLabel,
      testButton,
      playSurface,
      orientation,
    },
  });

  // D6-CTRL-04: one player per page. The toggle is per viewer and persisted as
  // "on"/"off"; patterns themselves are never stored or logged (FR-8.12, SR-12).
  const hapticsToggle = new HapticsToggle();
  const hapticPlayer = new HapticPlayer();
  hapticsToggle.bindPlayer(hapticPlayer);
  hapticsToggle.bindButton(hapticsButton, { updateLabel: true });
  client.onHaptic((durations) => {
    hapticPlayer.handleDurations(durations);
  });

  // Fullscreen is a gesture action; hidden where the API is unavailable
  // (iPhone Safari exposes it only on iPad). The label follows the state.
  const fullscreenButton = document.getElementById("fullscreen-toggle");
  if (fullscreenButton instanceof HTMLButtonElement) {
    if (typeof document.documentElement.requestFullscreen !== "function") {
      fullscreenButton.hidden = true;
    } else {
      const renderFullscreen = (): void => {
        fullscreenButton.textContent =
          document.fullscreenElement === null ? "Full" : "Exit full";
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

  // --- Debug overlay (D2-PERF-01) ------------------------------------------
  // Enabled only by `?debug=1`; triple-tap top-left then toggles it. The
  // overlay is pointer-transparent, so it never steals a touch from a control.

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
}

// The module is also imported by the controller flow tests, which build their
// own fixture and never want a network client; bootstrap only when the real
// page shell is present.
if (typeof document !== "undefined" && document.getElementById("app") !== null) {
  bootstrap();
}

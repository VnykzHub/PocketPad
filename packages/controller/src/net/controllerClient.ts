/**
 * Controller network client and layout mount (D0-CTRL-01, D2-CTRL-04,
 * D4-CTRL-01/02 integration).
 *
 * Owns the only socket in the controller. Every join request is produced by
 * `JoinFlow`: session first, then the QR room token, then the manual code+PIN
 * form (FR-5.4–5.6). The flow also clears the URL fragment before the first
 * network call (FR-5.1). The client only transports the messages it is handed.
 *
 * D4 adds:
 * - `ReconnectController` for a dropped socket (250 ms → 4 s backoff, session
 *   rejoin, 7 s silence watchdog; FR-5.4, FR-7.14, FR-7.15);
 * - `SuspendController` + Wake Lock for hidden/visible transitions (FR-8.8);
 * - `hostStatus` handling so the pill can show "Waiting for TV" / "TV paused"
 *   (A9, FR-7.16).
 *
 * Layout handling is unchanged from D2:
 * - A layout arrives in `joined.layout`, or in the first `setLayout` addressed
 *   to this slot (or `all`). It is validated on the controller with the same
 *   `validateLayout` the host uses (FR-8.4).
 * - Only `button`, `dpad` and `stick` render in D2 (FR-8.1); other valid types
 *   are skipped until D5 registers their renderers.
 * - There is no layout hot-swap in D2 (FR-8.2 is D5-CTRL-02): once a layout is
 *   mounted, later `setLayout` messages are ignored until the socket closes.
 *
 * The socket remains the only network owner; controls never send. Tokens and
 * PINs are never placed in state that the page, logs or the DOM can read.
 */
import {
  BUTTON_BITS,
  MSG,
  PROTOCOL_VERSION,
  decodePong,
  encodeInput,
  encodePing,
  parseJsonMessage,
  stringifyJsonMessage,
} from "@lanpad/protocol";
import type {
  ClientToServerMessage,
  HostStatusState,
  InputState,
  JoinErrorReason,
  JsonControlMessage,
} from "@lanpad/protocol";
import {
  resolveServerOrigin,
  toWebSocketUrl,
  validateLayout,
  type Control,
  type LayoutDocument,
} from "@lanpad/sdk";
import {
  controlHitRect,
  type ControlContext,
  type ControlRenderer,
  type RenderedControl,
  type SurfaceSize,
} from "../controls/control.js";
import { createControl } from "../controls/registry.js";
import { InputStore } from "../input/InputStore.js";
import { SendLoop } from "../input/sendLoop.js";
import { CLOCK_PING_INTERVAL_MS, ClockSync } from "./clockSync.js";
import {
  JOIN_FLOW_MESSAGES,
  createJoinFlow,
  type JoinFlow,
  type JoinFlowState,
  type JoinLocation,
  type JoinRequest,
  type JoinTransport,
} from "../join/joinFlow.js";
import { createSessionStore, type SessionStore } from "../join/sessionStore.js";
import type { ReplaceStateHistory } from "../route.js";
import {
  createReconnectController,
  type ReconnectController,
  type ReconnectState,
  type ReconnectStopReason,
  type ReconnectTimers,
} from "./reconnect.js";
import {
  createSuspendController,
  type SessionLostReason,
  type SuspendController,
  type SuspendWakeLock,
  type VisibilitySource,
} from "../lifecycle/suspend.js";
import { WakeLockManager } from "../lifecycle/wakeLock.js";
import { TouchEngine } from "../touch/touchEngine.js";
import type { TouchEngineEvent } from "../touch/touchEngine.js";

export { IDLE_SEND_INTERVAL_MS } from "../input/sendLoop.js";

const A_BUTTON_MASK = 1 << BUTTON_BITS.A;
const BUTTON_MASK = 0xffff;

/** Connection pill states. The pill never shows a token or PIN. */
export type ControllerStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface ControllerState {
  status: ControllerStatus;
  /** Slot assigned by the server; null until `joined` arrives. */
  slot: number | null;
  /** Readable join/connection error for the form; null when there is none. */
  error: string | null;
  /** Last `hostStatus` seen while connected (A9); null when unknown. */
  host: HostStatusState | null;
}

/** Human-readable text for every join refusal (FR-5.6 retry path). */
export const JOIN_ERROR_TEXT: Readonly<Record<JoinErrorReason, string>> = {
  roomFull: "That room is full.",
  badToken: "That invite link is no longer valid. Enter the room code and PIN.",
  badPin: "Wrong PIN. Check the PIN shown on the TV and try again.",
  expired: "That room has expired. Ask the host for a new code.",
  rateLimited: "Too many attempts. Wait a moment and try again.",
  badCode: "No room with that code. Check the code on the TV.",
  badHostToken: "The host session is not valid.",
  badVersion: "This controller is out of date. Reload the page.",
};

/** Pill label used by the page shell (the D4 pill is in `ui/ConnectionPill`). */
export function connectionPillLabel(state: ControllerState): string {
  switch (state.status) {
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "connected":
      if (state.host === "lost") {
        return "Waiting for TV";
      }
      if (state.host === "paused") {
        return "TV paused";
      }
      return state.slot === null ? "Connected" : `Connected (P${state.slot})`;
    case "disconnected":
      return "Disconnected";
  }
}

/** Reads the room code back out of a join-flow state, without any secret. */
export function joinStateCode(state: JoinFlowState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "manual":
    case "joining":
    case "joined":
    case "error":
      return state.code;
  }
}

/** The user-facing flow message, if any; never contains a token or PIN. */
function joinStateNotice(state: JoinFlowState): string | null {
  if (state.status === "manual") {
    return state.notice;
  }
  if (state.status === "error") {
    return state.message;
  }
  return null;
}

const noopHistory: ReplaceStateHistory = {
  replaceState: () => {},
};

const defaultReconnectTimers: ReconnectTimers = {
  setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

/**
 * The socket surface the client needs. Tests provide a fake; the browser uses
 * `BrowserSocket`, which isolates DOM event types from the client logic.
 */
export interface ControllerSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

/** Injectable interval surface (Ping cadence) for deterministic tests. */
export interface ControllerTimers {
  setInterval(handler: () => void, timeoutMs: number): number;
  clearInterval(handle: number): void;
}

/** Injectable single-shot timers for the send policy. */
export interface ControllerSendTimers {
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(handle: number): void;
}

/** Control types that have a D2 renderer; D5 registers the rest. */
function isD2Renderable(control: Control): control is RenderedControl {
  return control.type === "button" || control.type === "dpad" || control.type === "stick";
}

export interface ControllerClientOptions {
  /** Explicit server origin; defaults to `resolveServerOrigin()` (same-origin). */
  origin?: string;
  createSocket?: (url: string) => ControllerSocket;
  now?: () => number;
  timers?: ControllerTimers;
  sendTimers?: ControllerSendTimers;
  /**
   * Kept for D0 API compatibility. The D2 send policy owns the 100 ms idle
   * cadence (FR-7.1); this option no longer changes it.
   */
  idleIntervalMs?: number;
  /** Optional full-screen play surface; when present, layouts render into it. */
  surface?: HTMLElement;
  /** Surface geometry override for tests (device pixels are read otherwise). */
  surfaceSize?: SurfaceSize | (() => SurfaceSize);
  /** Draw a dashed outline around each control (`?layout=debug`, FR-8.4). */
  debugOutline?: boolean;
  /**
   * Per-room session storage (FR-5.4). Defaults to a memory-less store, which
   * makes every rejoin fall back to the manual form; the browser entry passes
   * the real `sessionStorage`/`localStorage` pair.
   */
  sessionStore?: SessionStore;
  /** History used to strip the URL fragment before the first join (FR-5.1). */
  history?: ReplaceStateHistory;
  /** Page visibility source for suspend/resume (FR-8.8); null disables it. */
  visibility?: VisibilitySource | null;
  /** Screen Wake Lock surface; defaults to a feature-detected manager. */
  wakeLock?: SuspendWakeLock;
  /** Backoff timers for `ReconnectController` (injected in tests). */
  reconnectTimers?: ReconnectTimers;
  /** Jitter source for reconnect backoff in [0, 1); injected in tests. */
  random?: () => number;
}

/** Debug counters exposed to the page overlay (D2-CTRL-04 step 6). */
export interface ControllerClientStats {
  packetsSent: number;
  edgePackets: number;
  /** Milliseconds since the last successful Input send; Infinity before one. */
  lastSendAgeMs: number;
  rttMs: number;
  offsetMs: number;
  clockSamples: number;
  pingsSent: number;
  activeTouches: number;
  droppedTouches: number;
  /** Duration of the most recent control dispatch, in ms. */
  scriptMs: number;
  layoutId: string | null;
  /** connect() → first Input packet; null until that packet is sent. */
  joinToFirstInputMs: number | null;
}

const defaultTimers: ControllerTimers = {
  setInterval: (handler, timeoutMs) => globalThis.setInterval(handler, timeoutMs),
  clearInterval: (handle) => globalThis.clearInterval(handle),
};

const defaultSendTimers: ControllerSendTimers = {
  setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

/** Wraps the DOM WebSocket so the client only sees its own small interface. */
class BrowserSocket implements ControllerSocket {
  private readonly socket: WebSocket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    // Pongs are binary and must reach the client as ArrayBuffer, not Blob.
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => {
      this.onopen?.();
    };
    this.socket.onmessage = (event: MessageEvent) => {
      this.onmessage?.({ data: event.data });
    };
    this.socket.onclose = (event: CloseEvent) => {
      this.onclose?.({ code: event.code, reason: event.reason });
    };
    this.socket.onerror = () => {
      this.onerror?.();
    };
  }

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.socket.send(data);
      return;
    }
    // Protocol frames are always ArrayBuffer-backed `new Uint8Array(...)`.
    // The DOM lib types `send` as requiring an ArrayBuffer view and rejects
    // the wider `Uint8Array<ArrayBufferLike>` generic.
    this.socket.send(data as Uint8Array<ArrayBuffer>);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

function nowMilliseconds(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Normalises a socket payload to bytes; null for text, Blob or unknown data. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

export interface ControllerLayoutViewOptions {
  /** Surface geometry override; a function is re-read on every relayout. */
  surfaceSize?: SurfaceSize | (() => SurfaceSize);
  /** Dashed control bounds for `?layout=debug` (D2-CTRL-02 step 6). */
  debugOutline?: boolean;
  /** Called after each touch dispatch with its synchronous duration. */
  onScriptTime?: (ms: number) => void;
}

/**
 * Mounts one validated layout into a play surface (D2-CTRL-04).
 *
 * The view owns the D2 touch engine and the control renderers; it never talks
 * to the socket. It is deliberately single-layout: `setLayout` accepts the
 * first layout only, because hot-swap is D5-CTRL-02 (FR-8.2). A surface resize
 * rebuilds the renderers with the new geometry (FR-8.3).
 */
export class ControllerLayoutView {
  private readonly surface: HTMLElement;
  private readonly input: InputStore;
  private readonly sizeSource: SurfaceSize | (() => SurfaceSize) | undefined;
  private readonly debugOutline: boolean;
  private readonly onScriptTime: ((ms: number) => void) | undefined;

  private engine: TouchEngine | null = null;
  private renderers: Array<{ control: RenderedControl; renderer: ControlRenderer }> = [];
  private renderersById = new Map<string, ControlRenderer>();
  private currentLayout: LayoutDocument | null = null;
  private size: SurfaceSize = { width: 0, height: 0 };

  constructor(
    surface: HTMLElement,
    input: InputStore,
    options: ControllerLayoutViewOptions = {},
  ) {
    this.surface = surface;
    this.input = input;
    this.sizeSource = options.surfaceSize;
    this.debugOutline = options.debugOutline ?? false;
    this.onScriptTime = options.onScriptTime;
  }

  /** Active touch bindings, for the debug overlay. */
  get activeTouches(): number {
    return this.engine?.activeBindings.length ?? 0;
  }

  /** Touches rejected beyond the 10-touch cap (FR-8.6). */
  get droppedTouches(): number {
    return this.engine?.droppedTouches ?? 0;
  }

  /**
   * Mounts the first layout. Returns false when a layout is already mounted
   * (D2 has no hot-swap, FR-8.2). The layout must have passed `validateLayout`;
   * the client validates before calling.
   */
  setLayout(layout: LayoutDocument): boolean {
    if (this.currentLayout !== null) {
      return false;
    }
    this.currentLayout = layout;
    this.build();
    return true;
  }

  /** Removes the renderers and the touch engine, leaving the surface empty. */
  clear(): void {
    this.disposeRenderers();
    this.engine?.dispose();
    this.engine = null;
    this.currentLayout = null;
    this.size = { width: 0, height: 0 };
    this.surface.style.background = "";
  }

  /** Rebuilds the control DOM for the current layout and surface size. */
  private build(): void {
    const layout = this.currentLayout;
    if (layout === null) {
      return;
    }

    this.disposeRenderers();
    this.size = this.resolveSize();

    const ctx: ControlContext = {
      input: this.input,
      surfaceSize: this.size,
    };
    if (this.debugOutline) {
      ctx.debug = { outline: true };
    }

    for (const control of layout.controls) {
      if (!isD2Renderable(control)) {
        // Structurally valid, but its renderer arrives in D5 (FR-8.1).
        continue;
      }
      const renderer = createControl(control, ctx);
      this.surface.append(renderer.element);
      this.renderers.push({ control, renderer });
      this.renderersById.set(control.id, renderer);
    }

    this.surface.style.background = layout.background ?? "";
    this.ensureEngine();
    this.engine?.setControls(
      this.renderers.map(({ control }) => controlHitRect(control, this.size)),
    );
  }

  private ensureEngine(): void {
    if (this.engine !== null) {
      return;
    }
    const engine = new TouchEngine(this.surface, {
      onLayoutChange: () => {
        this.handleSurfaceChange();
      },
    });
    engine.onTouch = this.handleTouch;
    this.engine = engine;
  }

  private readonly handleTouch = (event: TouchEngineEvent): void => {
    const renderer = this.renderersById.get(event.controlId);
    if (renderer === undefined) {
      return;
    }
    const startedAt = nowMilliseconds();
    switch (event.type) {
      case "start":
        renderer.onTouchStart(event.binding);
        break;
      case "move":
        renderer.onTouchMove(event.binding);
        break;
      case "end":
        renderer.onTouchEnd(event.binding);
        break;
      case "cancel":
        renderer.onTouchCancel(event.binding);
        break;
    }
    this.onScriptTime?.(nowMilliseconds() - startedAt);
  };

  /** Rebuilds after a resize/orientation change (FR-8.3). */
  private handleSurfaceChange(): void {
    if (this.currentLayout === null) {
      return;
    }
    const next = this.resolveSize();
    if (next.width === this.size.width && next.height === this.size.height) {
      return;
    }
    this.build();
  }

  private resolveSize(): SurfaceSize {
    const source = this.sizeSource;
    if (typeof source === "function") {
      return source();
    }
    if (source !== undefined) {
      return { width: source.width, height: source.height };
    }
    const rect = this.surface.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return { width: rect.width, height: rect.height };
    }
    if (typeof window !== "undefined") {
      return { width: window.innerWidth, height: window.innerHeight };
    }
    return { width: 0, height: 0 };
  }

  private disposeRenderers(): void {
    for (const { renderer } of this.renderers) {
      try {
        renderer.dispose();
      } catch {
        // Keep tearing down the rest even if one renderer fails.
      }
    }
    this.renderers = [];
    this.renderersById.clear();
  }
}

/**
 * Controller client: join, send policy, clock sync, layout mount.
 *
 * The socket remains the only network owner; controls write to `InputStore`
 * and `SendLoop` serialises that store onto the wire (layer invariant: controls
 * never send packets).
 */
export class ControllerClient {
  /** Level/edge store shared by the Test button and the layout controls. */
  readonly input: InputStore;
  /** Server-clock estimator shared with the debug overlay (FR-7.10). */
  readonly clock: ClockSync;

  private readonly explicitOrigin: string | undefined;
  private readonly createSocket: (url: string) => ControllerSocket;
  private readonly now: () => number;
  private readonly timers: ControllerTimers;
  private readonly sendTimers: ControllerSendTimers;
  private readonly reconnectTimers: ReconnectTimers;
  private readonly random: () => number;
  private readonly store: SessionStore;
  private readonly history: ReplaceStateHistory;
  private readonly visibility: VisibilitySource | null | undefined;
  private readonly wakeLock: SuspendWakeLock;
  private readonly sendLoop: SendLoop;
  private readonly layoutView: ControllerLayoutView | null;
  private readonly joinFlow: JoinFlow;

  private readonly listeners = new Set<(state: ControllerState) => void>();
  private readonly layoutListeners = new Set<(layout: LayoutDocument | null) => void>();
  private readonly joinListeners = new Set<(state: JoinFlowState) => void>();
  private state: ControllerState = {
    status: "disconnected",
    slot: null,
    error: null,
    host: null,
  };

  private socket: ControllerSocket | null = null;
  private socketOpen = false;
  private socketGeneration = 0;
  private joined = false;
  private suspended = false;
  private pressMask = 0;

  /** Join message produced by the flow, sent as soon as the socket opens. */
  private pendingJoin: JoinRequest | null = null;
  private roomCode: string | null = null;
  private reconnect: ReconnectController | null = null;
  private suspend: SuspendController | null = null;
  /** Last `joinError` reason, used to word the terminal reconnect message. */
  private lastJoinErrorReason: JoinErrorReason | null = null;

  private pingHandle: number | null = null;
  private pingsSentCount = 0;

  private currentLayout: LayoutDocument | null = null;
  private currentLayoutError: string | null = null;
  private lastScriptMs = 0;

  private connectStartedAtMs: number | null = null;
  private joinToFirstInputMs: number | null = null;

  constructor(options: ControllerClientOptions = {}) {
    this.explicitOrigin = options.origin;
    this.createSocket = options.createSocket ?? ((url) => new BrowserSocket(url));
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? defaultTimers;
    this.sendTimers = options.sendTimers ?? defaultSendTimers;
    this.reconnectTimers = options.reconnectTimers ?? defaultReconnectTimers;
    this.random = options.random ?? Math.random;
    this.store = options.sessionStore ?? createSessionStore();
    this.history = options.history ?? noopHistory;
    this.visibility = options.visibility;
    this.wakeLock = options.wakeLock ?? new WakeLockManager();
    this.input = new InputStore();
    this.clock = new ClockSync();

    this.sendLoop = new SendLoop({
      store: this.input,
      clock: this.clock,
      send: (state) => {
        this.sendInput(state);
      },
      now: this.now,
      setTimer: (fn, ms) => this.sendTimers.setTimeout(fn, ms),
      clearTimer: (id) => this.sendTimers.clearTimeout(id),
    });
    this.input.onChange = () => {
      this.sendLoop.notifyChange();
    };

    const transport: JoinTransport = {
      send: (message) => {
        this.sendJoinMessage(message);
      },
    };
    this.joinFlow = createJoinFlow({
      store: this.store,
      transport,
      history: this.history,
      now: this.now,
    });

    if (options.surface !== undefined) {
      const viewOptions: ControllerLayoutViewOptions = {
        onScriptTime: (ms) => {
          this.lastScriptMs = ms;
        },
      };
      if (options.surfaceSize !== undefined) {
        viewOptions.surfaceSize = options.surfaceSize;
      }
      if (options.debugOutline !== undefined) {
        viewOptions.debugOutline = options.debugOutline;
      }
      this.layoutView = new ControllerLayoutView(
        options.surface,
        this.input,
        viewOptions,
      );
    } else {
      this.layoutView = null;
    }
  }

  get currentState(): ControllerState {
    return this.state;
  }

  /** Current join-flow state (manual form errors, lockout, via…). */
  get joinState(): JoinFlowState {
    return this.joinFlow.state;
  }

  /** Remaining rate-limit lockout in ms; 0 when submit is allowed. */
  get retryAfterMs(): number {
    return this.joinFlow.retryAfterMs;
  }

  /** The mounted layout, or null while none has arrived. */
  get layout(): LayoutDocument | null {
    return this.currentLayout;
  }

  /** Validation error for the most recent rejected layout, or null. */
  get layoutError(): string | null {
    return this.currentLayoutError;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  /** Debug counters for the page overlay. */
  get stats(): ControllerClientStats {
    return {
      packetsSent: this.sendLoop.packetsSent,
      edgePackets: this.sendLoop.edgePackets,
      lastSendAgeMs: this.sendLoop.lastSendAgeMs,
      rttMs: this.clock.rttMs,
      offsetMs: this.clock.offsetMs,
      clockSamples: this.clock.samples,
      pingsSent: this.pingsSentCount,
      activeTouches: this.layoutView?.activeTouches ?? 0,
      droppedTouches: this.layoutView?.droppedTouches ?? 0,
      scriptMs: this.lastScriptMs,
      layoutId: this.currentLayout?.id ?? null,
      joinToFirstInputMs: this.joinToFirstInputMs,
    };
  }

  /** Subscribes to connection state changes; the listener runs immediately. */
  onState(listener: (state: ControllerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Subscribes to layout arrival/removal; the listener runs immediately. */
  onLayout(listener: (layout: LayoutDocument | null) => void): () => void {
    this.layoutListeners.add(listener);
    listener(this.currentLayout);
    return () => {
      this.layoutListeners.delete(listener);
    };
  }

  /** Subscribes to join-flow changes; the listener runs immediately. */
  onJoinState(listener: (state: JoinFlowState) => void): () => void {
    this.joinListeners.add(listener);
    listener(this.joinFlow.state);
    return () => {
      this.joinListeners.delete(listener);
    };
  }

  /**
   * D4 bootstrap (FR-5.1, FR-5.4): parse `/c/<code>` and the fragment, clear
   * the fragment before any network call, then try a stored session, the room
   * token and finally the manual form, in that order.
   */
  start(location: JoinLocation): JoinFlowState {
    if (this.connectStartedAtMs === null) {
      this.connectStartedAtMs = this.now();
    }
    this.reconnect?.stop("left");
    this.reconnect = null;
    this.teardownConnection();
    this.destroySuspend();
    this.releaseWakeLock();
    const state = this.joinFlow.start(location);
    this.afterFlowChange(state);
    return state;
  }

  /** Sends a manual code + PIN join through the flow (FR-5.6). */
  submitManual(code: string, pin: string): JoinFlowState {
    if (this.connectStartedAtMs === null) {
      this.connectStartedAtMs = this.now();
    }
    const state = this.joinFlow.submitManual({ code, pin });
    this.afterFlowChange(state);
    return state;
  }

  /** Retries after `roomFull` or a finished rate-limit lockout (FR-5.3). */
  retryJoin(): JoinFlowState {
    const state = this.joinFlow.retry();
    this.afterFlowChange(state);
    return state;
  }

  /**
   * D0-compatible manual join. The request still goes through `JoinFlow`, so
   * validation, storage and the rate-limit lockout behave identically to the
   * D4 form. Replaces any previous connection and clears the mounted layout.
   */
  connect(code: string, pin: string): void {
    this.connectStartedAtMs = this.now();
    this.joinToFirstInputMs = null;
    this.reconnect?.stop("left");
    this.reconnect = null;
    this.teardownConnection();
    this.destroySuspend();
    this.releaseWakeLock();
    const state = this.joinFlow.submitManual({ code, pin });
    this.afterFlowChange(state);
    if (state.status !== "joining") {
      this.setState({ status: "disconnected", slot: null, error: null, host: null });
    }
  }

  /**
   * Explicit leave: sends `leave` when possible, frees the slot immediately,
   * drops the stored session and never reconnects (FR-5.4).
   */
  disconnect(): void {
    if (this.joined && this.socket !== null && this.socketOpen) {
      try {
        this.socket.send(stringifyJsonMessage({ t: "leave" }));
      } catch {
        // The socket may already be gone; leaving is still the intent.
      }
    }
    this.joinFlow.leave();
    this.notifyJoinState();
    this.reconnect?.stop("left");
    this.teardownConnection();
    this.destroySuspend();
    this.releaseWakeLock();
    this.roomCode = null;
    this.setState({ status: "disconnected", slot: null, error: null, host: null });
  }

  /**
   * D0 Test-button press. Maps the mask onto `InputStore` bits; the send policy
   * decides the packet timing (FR-7.1). Presses made while the socket is down
   * stay latched so a short reconnect can still deliver them (FR-5.4).
   */
  press(buttonMask: number = A_BUTTON_MASK): void {
    const mask = buttonMask & BUTTON_MASK;
    if (mask === 0 || this.pressMask !== 0) {
      return;
    }
    this.pressMask = mask;
    for (let bit = 0; bit < 16; bit += 1) {
      if ((mask & (1 << bit)) !== 0) {
        this.input.setButton(bit, true);
      }
    }
  }

  /** D0 Test-button release: clears the level; releases never latch edges. */
  release(): void {
    if (this.pressMask === 0) {
      return;
    }
    const mask = this.pressMask;
    this.pressMask = 0;
    for (let bit = 0; bit < 16; bit += 1) {
      if ((mask & (1 << bit)) !== 0) {
        this.input.setButton(bit, false);
      }
    }
  }

  /**
   * Encodes and sends one Input frame. Throws when the socket is not joined so
   * `SendLoop` holds the level and edges for the next attempt (FR-7.3).
   */
  sendInput(state: InputState): void {
    if (!this.joined || this.socket === null) {
      throw new Error("Controller is not joined");
    }
    this.socket.send(encodeInput(state));
  }

  /**
   * Sends an already-encoded controller frame (Ping in D2; haptics are D6).
   * Returns false instead of throwing when the socket is not joined; a Ping is
   * fire-and-forget. Input frames go through `sendInput` so edges are held on
   * failure.
   */
  sendBinary(frame: Uint8Array): boolean {
    if (!this.joined || this.socket === null) {
      return false;
    }
    try {
      this.socket.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  /** Sends one clock-sync Ping (SPEC §7.3). */
  sendPing(clientTimeMs: number = this.now()): void {
    if (!this.joined) {
      return;
    }
    if (this.sendBinary(encodePing(clientTimeMs))) {
      this.pingsSentCount += 1;
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      const bytes = toBytes(data);
      if (bytes !== null) {
        // Any server frame proves the socket is alive (FR-7.14).
        this.reconnect?.onServerActivity();
        this.handleBinary(bytes);
      }
      return;
    }
    let message: JsonControlMessage;
    try {
      message = parseJsonMessage(data);
    } catch {
      return;
    }
    this.reconnect?.onServerActivity();
    switch (message.t) {
      case "joined":
        this.handleJoined(message);
        return;
      case "joinError":
        this.handleJoinError(message.reason);
        return;
      case "kick":
        this.handleKick(message.reason);
        return;
      case "hostStatus":
        this.handleHostStatus(message.state);
        return;
      case "setLayout":
        this.handleSetLayout(message.slot, message.layout);
        return;
      default:
        return;
    }
  }

  /** Pong is the only D2 server→controller binary; others arrive in D5/D6. */
  private handleBinary(frame: Uint8Array): void {
    if (frame.byteLength === 0 || frame[0] !== MSG.Pong) {
      return;
    }
    try {
      const { clientTimeMs, serverTimeMs } = decodePong(frame);
      this.clock.onPong(clientTimeMs, serverTimeMs, this.now());
    } catch {
      // A malformed Pong is ignored; the socket stays open.
    }
  }

  /**
   * Handles both the first join and a session rejoin after a drop or suspend.
   * Input levels and edges are deliberately kept across a reconnect, so a held
   * button survives the gap and the stale state is corrected by the snapshot
   * sent through the policy (FR-5.4, FR-7.3). An explicit leave or kick clears
   * the input instead.
   */
  private handleJoined(message: Extract<JsonControlMessage, { t: "joined" }>): void {
    this.joined = true;
    this.suspended = false;
    this.socketOpen = true;
    this.pendingJoin = null;

    // The flow persists the session and moves to `joined`; it is also what
    // makes the next bootstrap try the session before the room token.
    const flowState = this.joinFlow.handleMessage(message);
    this.notifyJoinState();
    if (flowState.status === "joined") {
      this.roomCode = flowState.code;
    }

    // Keep a mounted layout across a rejoin; D2 has no hot-swap (FR-8.2).
    if (message.layout !== undefined && this.currentLayout === null) {
      this.applyLayout(message.layout);
    }

    this.ensureReconnectController()?.onConnected(message.slot);
    this.ensureSuspendController();
    this.requestWakeLock();

    // Start the policy and emit the current snapshot through it, so the host
    // sees the slot alive and the packet obeys the same 4 ms spacing rule as
    // every later send (D2-CTRL-04).
    this.sendLoop.start();
    this.sendInitialInput();
    this.startPing();
    this.setState({ status: "connected", slot: message.slot, error: null, host: this.state.host });
  }

  /**
   * D2 accepts a layout only as the first one for the connection. Later
   * `setLayout` messages are dropped; hot-swap is D5-CTRL-02 (FR-8.2).
   */
  private handleSetLayout(slot: number | "all", layout: unknown): void {
    if (!this.joined || this.currentLayout !== null) {
      return;
    }
    if (slot !== "all" && slot !== this.state.slot) {
      return;
    }
    this.applyLayout(layout);
  }

  /** Validates and mounts a layout; returns false and records the error. */
  private applyLayout(value: unknown): boolean {
    const result = validateLayout(value);
    if (!result.ok) {
      this.currentLayoutError = result.errors.join("; ");
      return false;
    }
    this.currentLayout = result.layout;
    this.currentLayoutError = null;
    this.layoutView?.setLayout(result.layout);
    this.notifyLayout();
    return true;
  }

  private clearLayout(): void {
    const hadLayout = this.currentLayout !== null || this.currentLayoutError !== null;
    this.currentLayout = null;
    this.currentLayoutError = null;
    this.layoutView?.clear();
    if (hadLayout) {
      this.notifyLayout();
    }
  }

  private notifyLayout(): void {
    for (const listener of this.layoutListeners) {
      listener(this.currentLayout);
    }
  }

  /**
   * Emits the first Input packet through the send policy, so the initial packet
   * shares the same 4 ms spacing rule as every later one. `notifyChange()` sends
   * synchronously when no packet has been sent yet; the empty state is the
   * snapshot of the store at join time (FR-7.1, D2-CTRL-04).
   */
  private sendInitialInput(): void {
    if (!this.joined || this.socket === null) {
      return;
    }
    const before = this.sendLoop.packetsSent;
    this.sendLoop.notifyChange();
    if (
      this.sendLoop.packetsSent > before &&
      this.joinToFirstInputMs === null &&
      this.connectStartedAtMs !== null
    ) {
      this.joinToFirstInputMs = Math.max(0, this.now() - this.connectStartedAtMs);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.sendPing();
    this.pingHandle = this.timers.setInterval(() => {
      this.sendPing();
    }, CLOCK_PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingHandle !== null) {
      this.timers.clearInterval(this.pingHandle);
      this.pingHandle = null;
    }
  }

  /** Pushes a flow transition into the visible connection state. */
  private afterFlowChange(state: JoinFlowState): void {
    const code = joinStateCode(state);
    if (code !== null) {
      this.roomCode = code;
    }
    switch (state.status) {
      case "idle":
        this.setState({ status: "disconnected", slot: null, error: null, host: null });
        return;
      case "joining":
        this.setState({ status: "connecting", slot: null, error: null, host: null });
        return;
      case "joined":
        return;
      case "error":
        this.setState({ status: "disconnected", slot: null, error: state.message, host: null });
        return;
      case "manual":
        this.setState({
          status: "disconnected",
          slot: null,
          error: joinStateNotice(state),
          host: null,
        });
        return;
    }
  }

  private notifyJoinState(): void {
    const state = this.joinFlow.state;
    for (const listener of this.joinListeners) {
      listener(state);
    }
  }

  /**
   * Transport hook for `JoinFlow`. The flow can produce a join while a socket
   * is still opening (pending) or while an unbound socket is open (a session →
   * token fallback after `joinError`); both are supported.
   */
  private sendJoinMessage(message: JoinRequest): void {
    const socket = this.socket;
    if (socket !== null) {
      if (!this.socketOpen) {
        this.pendingJoin = message;
        return;
      }
      try {
        socket.send(stringifyJsonMessage(message));
      } catch (error) {
        this.closeSocketQuietly();
        throw error;
      }
      return;
    }
    this.openSocket(message);
  }

  /** Opens a fresh socket and sends `join` as soon as it opens. */
  private openSocket(join: JoinRequest): void {
    this.closeSocketQuietly();
    let socket: ControllerSocket;
    try {
      socket = this.createSocket(toWebSocketUrl(resolveServerOrigin(this.explicitOrigin)));
    } catch (error) {
      this.pendingJoin = null;
      throw error;
    }

    this.socket = socket;
    this.socketOpen = false;
    this.pendingJoin = join;
    const generation = ++this.socketGeneration;

    socket.onopen = () => {
      if (generation !== this.socketGeneration) {
        return;
      }
      this.socketOpen = true;
      const pending = this.pendingJoin;
      this.pendingJoin = null;
      if (pending === null) {
        return;
      }
      try {
        socket.send(stringifyJsonMessage(pending));
      } catch {
        this.handleSocketFailure();
      }
    };

    socket.onmessage = (event) => {
      if (generation !== this.socketGeneration) {
        return;
      }
      this.handleMessage(event.data);
    };

    socket.onclose = () => {
      if (generation !== this.socketGeneration) {
        return;
      }
      this.handleSocketClosed();
    };

    // A browser `error` is always followed by `close`; let that path report it.
    socket.onerror = () => {};
  }

  /** Detaches handlers and closes the socket without triggering a retry. */
  private closeSocketQuietly(): void {
    this.socketGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    this.pendingJoin = null;
    if (socket === null) {
      return;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000, "client disconnect");
    } catch {
      // The socket may already be closed.
    }
  }

  /** A join could not be written on a socket that just opened. */
  private handleSocketFailure(): void {
    const phase = this.reconnect?.state.phase;
    this.closeSocketQuietly();
    if (phase === "connecting") {
      this.reconnect?.onAttemptFailed();
      if (this.state.status !== "disconnected") {
        this.setState({ status: "reconnecting", slot: this.state.slot, error: null, host: null });
      }
      return;
    }
    this.handleSocketClosed();
  }

  /**
   * The server closed the socket (or the send failed). A joined controller
   * keeps its slot on the server for 30 s, so the reconnect machine reclaims
   * it with a session join (FR-5.4, FR-7.14). Everything else falls back to
   * the editable form.
   */
  private handleSocketClosed(): void {
    this.socketGeneration += 1;
    this.socket = null;
    this.socketOpen = false;
    this.pendingJoin = null;
    this.stopPing();
    this.sendLoop.stop();
    const wasJoined = this.joined;
    this.joined = false;

    if (this.suspended) {
      // Hidden: the reservation is running; the visible transition decides
      // whether a same-socket rejoin or a reconnect is needed (FR-8.8).
      this.setState({ status: "reconnecting", slot: this.state.slot, error: null, host: null });
      return;
    }

    if (this.reconnect !== null && this.reconnect.state.phase !== "stopped") {
      this.reconnect.onDisconnected();
      const phase = this.reconnect.state.phase;
      if (phase === "waiting" || phase === "connecting") {
        // Keep the layout and the input; only the socket is gone.
        this.setState({ status: "reconnecting", slot: this.state.slot, error: null, host: null });
        return;
      }
    }

    if (wasJoined) {
      this.destroySuspend();
      this.releaseWakeLock();
      this.resetInput();
      this.clearLayout();
      this.roomCode = null;
    }
    this.setState({
      status: "disconnected",
      slot: null,
      error: wasJoined
        ? "Connection lost."
        : "Could not connect to the game server. Check the connection and try again.",
      host: null,
    });
  }

  /**
   * A visibility or socket failure handed control back to the reconnect
   * layer. Reuses the existing machine when it is still live; a fresh one is
   * seeded as `connected` so the first drop schedules the 250 ms attempt.
   */
  private restartReconnect(): void {
    if (this.suspended) {
      return;
    }
    this.stopPing();
    this.sendLoop.stop();
    this.joined = false;

    const reconnect = this.ensureReconnectController();
    if (reconnect === null) {
      this.teardownConnection();
      this.destroySuspend();
      this.releaseWakeLock();
      this.setState({ status: "disconnected", slot: null, error: "Connection lost.", host: null });
      return;
    }

    if (reconnect.state.phase === "idle") {
      reconnect.onConnected(this.state.slot ?? 0);
    }
    reconnect.onDisconnected();
    const phase = reconnect.state.phase;
    if (phase === "waiting" || phase === "connecting") {
      this.setState({ status: "reconnecting", slot: this.state.slot, error: null, host: null });
    }
  }

  private ensureReconnectController(): ReconnectController | null {
    if (this.roomCode === null) {
      return null;
    }
    if (this.reconnect !== null && this.reconnect.state.phase !== "stopped") {
      return this.reconnect;
    }

    const code = this.roomCode;
    const controller = createReconnectController({
      store: this.store,
      code,
      timers: this.reconnectTimers,
      random: this.random,
      onJoin: (message) => {
        this.openRejoinSocket(message);
      },
      onStaleSocket: () => {
        this.handleStaleSocket();
      },
      onState: (state) => {
        this.handleReconnectState(state);
      },
      onStop: (reason) => {
        this.handleReconnectStop(reason);
      },
    });
    this.reconnect = controller;
    return controller;
  }

  /** Opens the retry socket; a throw makes the machine schedule the next try. */
  private openRejoinSocket(message: JoinRequest): void {
    this.closeSocketQuietly();
    this.openSocket(message);
  }

  /** The 7 s silence watchdog fired: discard the blackholed socket (FR-7.14). */
  private handleStaleSocket(): void {
    this.stopPing();
    this.sendLoop.stop();
    this.joined = false;
    this.closeSocketQuietly();
  }

  private handleReconnectState(state: ReconnectState): void {
    if (state.phase !== "waiting" && state.phase !== "connecting") {
      return;
    }
    if (this.state.status === "reconnecting") {
      return;
    }
    this.setState({
      status: "reconnecting",
      slot: state.slot ?? this.state.slot,
      error: null,
      host: null,
    });
  }

  private handleReconnectStop(reason: ReconnectStopReason): void {
    switch (reason) {
      case "left":
      case "kicked":
        // The explicit path owns the teardown and the visible message.
        return;
      case "expired":
      case "noSession":
        // FR-5.5: the reservation is gone; fall back to the room token (held
        // in the flow) or the manual form instead of spinning on the session.
        this.abandonSession(JOIN_FLOW_MESSAGES.expired);
        return;
      case "rejected":
        this.rejectJoin(this.lastJoinErrorReason ?? "expired");
        return;
    }
  }

  /** The stored session cannot be reclaimed; re-run join precedence. */
  private abandonSession(error: string | null): void {
    const code = this.roomCode;
    if (code !== null) {
      this.store.clear(code);
    }
    this.reconnect = null;
    this.teardownConnection();
    this.destroySuspend();
    this.releaseWakeLock();

    const flowState = this.joinFlow.retry();
    this.afterFlowChange(flowState);
    if (error !== null && flowState.status === "manual" && flowState.notice === null) {
      this.setState({ status: "disconnected", slot: null, error, host: null });
    }
  }

  /** Terminal join refusal: back to the form with the reason (FR-5.6). */
  private rejectJoin(reason: JoinErrorReason): void {
    this.reconnect = null;
    this.teardownConnection();
    this.destroySuspend();
    this.releaseWakeLock();
    this.joinFlow.leave();
    this.notifyJoinState();
    this.roomCode = null;
    this.setState({
      status: "disconnected",
      slot: null,
      error: JOIN_FLOW_MESSAGES[reason],
      host: null,
    });
  }

  /** The server refused a rejoin made by `SuspendController` itself. */
  private handleRejoinedSessionRefused(reason: JoinErrorReason): void {
    if (reason === "expired") {
      this.abandonSession(JOIN_FLOW_MESSAGES.expired);
      return;
    }
    this.rejectJoin(reason);
  }

  private handleJoinError(reason: JoinErrorReason): void {
    this.lastJoinErrorReason = reason;

    const phase = this.reconnect?.state.phase;
    if (phase === "connecting" || phase === "waiting") {
      // The flow is still `joined` from before the drop and ignores errors;
      // the reconnect machine owns this refusal.
      this.reconnect?.onJoinRejected(reason);
      return;
    }

    if (!this.joined && this.joinFlow.state.status === "joined") {
      this.handleRejoinedSessionRefused(reason);
      return;
    }

    const flowState = this.joinFlow.handleMessage({ t: "joinError", reason });
    this.notifyJoinState();
    this.afterFlowChange(flowState);
  }

  private handleKick(reason: string): void {
    const flowState = this.joinFlow.handleMessage({ t: "kick", reason });
    this.notifyJoinState();
    this.reconnect?.stop("kicked");
    this.reconnect = null;
    this.teardownConnection();
    this.destroySuspend();
    this.releaseWakeLock();
    this.roomCode = null;
    this.setState({
      status: "disconnected",
      slot: null,
      error: joinStateNotice(flowState) ?? "The host removed this controller.",
      host: null,
    });
  }

  /** A9: the pill mirrors `Waiting for TV` / `TV paused` while connected. */
  private handleHostStatus(host: HostStatusState): void {
    if (this.state.status !== "connected" || this.state.host === host) {
      return;
    }
    this.setState({ ...this.state, host });
  }

  /**
   * Hidden: the server holds the slot for 30 s (SuspendController sends the
   * `suspend` itself). Stop local traffic and the watchdog; the visible
   * transition rejoins by session or restarts reconnect (FR-8.8).
   */
  private handleSuspend(): void {
    this.suspended = true;
    this.joined = false;
    this.stopPing();
    this.sendLoop.stop();
    this.reconnect?.stop("left");
    this.reconnect = null;
  }

  /** Visible: the rejoin `joined` will restart the policy; this is the guard. */
  private resumeFromSuspend(): void {
    this.suspended = false;
    if (!this.joined || this.socket === null || !this.socketOpen) {
      return;
    }
    this.sendLoop.start();
    this.startPing();
  }

  /** The 30 s reservation is gone (or the store lost the session). */
  private handleSessionLost(_reason: SessionLostReason): void {
    this.abandonSession(JOIN_FLOW_MESSAGES.expired);
  }

  private ensureSuspendController(): void {
    if (this.suspend !== null || this.roomCode === null || this.visibility === null) {
      return;
    }
    const code = this.roomCode;
    this.suspend = createSuspendController({
      socket: {
        isOpen: () => this.socket !== null && this.socketOpen,
        send: (message) => {
          const socket = this.socket;
          if (socket === null || !this.socketOpen) {
            throw new Error("Controller socket is not open");
          }
          socket.send(stringifyJsonMessage(message));
        },
      },
      store: this.store,
      code,
      wakeLock: this.wakeLock,
      visibility: this.visibility,
      now: this.now,
      onHide: () => {
        this.handleSuspend();
      },
      onShow: () => {
        this.resumeFromSuspend();
      },
      onReconnect: () => {
        this.restartReconnect();
      },
      onSessionLost: (reason) => {
        this.handleSessionLost(reason);
      },
    });
    this.suspend.attach();
  }

  private destroySuspend(): void {
    const suspend = this.suspend;
    this.suspend = null;
    if (suspend === null) {
      return;
    }
    suspend.destroy();
  }

  private requestWakeLock(): void {
    try {
      const pending = this.wakeLock.request();
      void Promise.resolve(pending).catch(() => {
        // A refused Wake Lock must never affect input (AR-3).
      });
    } catch {
      // Best effort only.
    }
  }

  private releaseWakeLock(): void {
    try {
      const pending = this.wakeLock.release();
      void Promise.resolve(pending).catch(() => {
        // Best effort only.
      });
    } catch {
      // Best effort only.
    }
  }

  /** Full reset for an explicit leave, a kick or a terminal refusal. */
  private teardownConnection(): void {
    this.stopPing();
    this.sendLoop.stop();
    this.closeSocketQuietly();
    this.joined = false;
    this.suspended = false;
    this.lastJoinErrorReason = null;
    this.resetInput();
    this.clearLayout();
    this.lastScriptMs = 0;
  }

  /** Clears every level, edge and the D0 Test-button latch. */
  private resetInput(): void {
    this.pressMask = 0;
    for (let bit = 0; bit < 16; bit += 1) {
      this.input.setButton(bit, false);
    }
    this.input.setAxis("lx", 0);
    this.input.setAxis("ly", 0);
    this.input.setAxis("rx", 0);
    this.input.setAxis("ry", 0);
    this.input.setTrigger("lt", 0);
    this.input.setTrigger("rt", 0);
    this.input.setGyro(0, 0, 0);
    this.input.setFlags(0);
    this.input.clearEdges();
  }

  private setState(next: ControllerState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

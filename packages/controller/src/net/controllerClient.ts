/**
 * Controller network client and layout mount (D0-CTRL-01, D2-CTRL-04).
 *
 * Owns the only socket in the controller. It joins with `v/code/pin`, drives
 * `InputStore` → `SendLoop` → `sendInput` (FR-7.1, FR-7.3), answers Pongs into
 * `ClockSync` (FR-7.10) and receives the layout that D2 renders.
 *
 * Layout handling in D2:
 * - A layout arrives in `joined.layout`, or in the first `setLayout` addressed
 *   to this slot (or `all`). It is validated on the controller with the same
 *   `validateLayout` the host uses (FR-8.4).
 * - Only `button`, `dpad` and `stick` render in D2 (FR-8.1); other valid types
 *   are skipped until D5 registers their renderers.
 * - There is no layout hot-swap in D2 (FR-8.2 is D5-CTRL-02): once a layout is
 *   mounted, later `setLayout` messages are ignored until the socket closes.
 *
 * Connection handling in D2 has no reconnect loop (D4-CTRL-02); it only
 * preserves the D0 behavior: code+PIN join, the Connecting / Connected (Pn) /
 * Disconnected pill, immediate press/release, and the 10 Hz idle keepalive.
 * Closing the socket stops the send loop, the Ping cadence and the touch
 * engine, so no timers or listeners leak between connections.
 *
 * The socket remains the only network owner; controls never send.
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
import { TouchEngine } from "../touch/touchEngine.js";
import type { TouchEngineEvent } from "../touch/touchEngine.js";

export { IDLE_SEND_INTERVAL_MS } from "../input/sendLoop.js";

const A_BUTTON_MASK = 1 << BUTTON_BITS.A;
const BUTTON_MASK = 0xffff;

/** Connection pill states. The pill never shows a token or PIN. */
export type ControllerStatus = "connecting" | "connected" | "disconnected";

export interface ControllerState {
  status: ControllerStatus;
  /** Slot assigned by the server; null until `joined` arrives. */
  slot: number | null;
  /** Readable join/connection error for the form; null when there is none. */
  error: string | null;
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

/** Pill label used by the page shell. */
export function connectionPillLabel(state: ControllerState): string {
  switch (state.status) {
    case "connecting":
      return "Connecting";
    case "connected":
      return state.slot === null ? "Connected" : `Connected (P${state.slot})`;
    case "disconnected":
      return "Disconnected";
  }
}

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
  private readonly sendLoop: SendLoop;
  private readonly layoutView: ControllerLayoutView | null;

  private readonly listeners = new Set<(state: ControllerState) => void>();
  private readonly layoutListeners = new Set<(layout: LayoutDocument | null) => void>();
  private state: ControllerState = { status: "disconnected", slot: null, error: null };

  private socket: ControllerSocket | null = null;
  private socketGeneration = 0;
  private joined = false;
  private pressMask = 0;

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

  /**
   * Opens the same-origin WebSocket and sends `join {v, code, pin}` on open.
   * Replaces any previous connection and clears the mounted layout.
   */
  connect(code: string, pin: string): void {
    this.teardown();
    this.connectStartedAtMs = this.now();
    this.joinToFirstInputMs = null;
    this.setState({ status: "connecting", slot: null, error: null });

    let socket: ControllerSocket;
    try {
      socket = this.createSocket(toWebSocketUrl(resolveServerOrigin(this.explicitOrigin)));
    } catch {
      this.setState({
        status: "disconnected",
        slot: null,
        error: "Cannot reach the game server.",
      });
      return;
    }

    this.socket = socket;
    const generation = ++this.socketGeneration;

    socket.onopen = () => {
      if (generation !== this.socketGeneration) {
        return;
      }
      const join: ClientToServerMessage = { t: "join", v: PROTOCOL_VERSION, code, pin };
      try {
        socket.send(stringifyJsonMessage(join));
      } catch {
        this.fail("Could not send the join request.");
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
      const wasConnected = this.state.status === "connected";
      const previousError = this.state.error;
      this.teardown();
      this.setState({
        status: "disconnected",
        slot: null,
        error:
          previousError ?? (wasConnected ? "Connection lost." : "Could not connect to the room."),
      });
    };

    // A browser `error` is always followed by `close`; let that path report it.
    socket.onerror = () => {};
  }

  /** Closes the socket, stops every timer and clears the input state. */
  disconnect(): void {
    this.teardown();
    this.setState({ status: "disconnected", slot: null, error: null });
  }

  /**
   * D0 Test-button press. Maps the mask onto `InputStore` bits; the send policy
   * decides the packet timing (FR-7.1). Ignored before `joined`.
   */
  press(buttonMask: number = A_BUTTON_MASK): void {
    if (!this.joined) {
      return;
    }
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
    if (!this.joined || this.pressMask === 0) {
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
    switch (message.t) {
      case "joined":
        this.handleJoined(message);
        return;
      case "joinError":
        this.fail(JOIN_ERROR_TEXT[message.reason]);
        return;
      case "kick":
        this.fail("The host removed this controller.");
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

  private handleJoined(message: Extract<JsonControlMessage, { t: "joined" }>): void {
    this.joined = true;
    this.pressMask = 0;
    if (message.layout !== undefined) {
      this.applyLayout(message.layout);
    }

    // Start the policy and emit the initial empty packet through it, so the
    // host sees the slot alive and the packet obeys the same 4 ms spacing rule
    // as every later send (D2-CTRL-04).
    this.sendLoop.start();
    this.sendInitialInput();
    this.startPing();
    this.setState({ status: "connected", slot: message.slot, error: null });
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

  private fail(message: string): void {
    this.teardown();
    this.setState({ status: "disconnected", slot: null, error: message });
  }

  /** Detaches handlers, stops every timer and clears per-connection state. */
  private teardown(): void {
    this.stopPing();
    this.sendLoop.stop();

    const mask = this.pressMask;
    this.pressMask = 0;
    for (let bit = 0; bit < 16; bit += 1) {
      if ((mask & (1 << bit)) !== 0) {
        this.input.setButton(bit, false);
      }
    }
    this.input.clearEdges();
    this.clearLayout();
    this.lastScriptMs = 0;

    this.socketGeneration += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
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
    this.joined = false;
  }

  private setState(next: ControllerState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }
}

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
 * D5 layout handling (FR-8.1, FR-8.2; D5-CTRL-01/02):
 * - A layout arrives in `joined.layout` or a `setLayout` addressed to this
 *   slot (or `all`). It is validated on the controller with the same
 *   `validateLayout` the host uses (FR-8.4).
 * - Every valid layout swaps in place: all eleven v1 control types render
 *   through the registry, active touches are cancelled, old controls are
 *   disposed, the new DOM is built in a fragment and mounted once, and a
 *   `layoutAck {layoutId}` is sent. The socket, session, input store and send
 *   loop are untouched, so no reload or reconnect happens.
 * - A rejected layout keeps the previous layout and updates
 *   `currentLayoutError`; it is never acked. A same-id layout is idempotent.
 * - Private `panel` content is applied by control id and survives a swap when
 *   the new layout keeps a panel with that id.
 * - A session reconnect keeps the mounted layout; a leave, kick or terminal
 *   join error clears it.
 *
 * Control events go through one `EventQueue` (D5-CTRL-05) over the same
 * socket; controls never send directly.
 *
 * The socket remains the only network owner; controls never send. Tokens and
 * PINs are never placed in state that the page, logs or the DOM can read.
 */
import {
  BUTTON_BITS,
  MSG,
  decodeHaptic,
  decodePong,
  encodeInput,
  encodePing,
  parseJsonMessage,
  stringifyJsonMessage,
} from "@lanpad/protocol";
import type {
  HostStatusState,
  InputState,
  JoinErrorReason,
  JsonControlMessage,
} from "@lanpad/protocol";
import {
  resolveServerOrigin,
  toWebSocketUrl,
  validateLayout,
  validatePanelContent,
  type Control,
  type LayoutDocument,
  type PanelContent,
} from "@lanpad/sdk";
import {
  controlHitRect,
  type ControlContext,
  type ControlRenderer,
  type SurfaceSize,
} from "../controls/control.js";
import type { ControlEventSink } from "../controls/eventSink.js";
import type { GyroControlRuntime } from "../controls/gyro.js";
import { isPanelRenderer } from "../controls/panel.js";
import { createControl } from "../controls/registry.js";
import { EventQueue, type EventQueueStats } from "../events/EventQueue.js";
import {
  MOTION_STRIP_ID,
  createMotionStatusStrip,
  motionStripHitRect,
} from "../layout/motionStrip.js";
import type { ViewportTracker } from "../layout/viewport.js";
import { InputStore } from "../input/InputStore.js";
import { SendLoop } from "../input/sendLoop.js";
import type { HitRect } from "../touch/hitTest.js";
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
import {
  createSessionStore,
  type SessionStore,
  type StorageLike,
} from "../join/sessionStore.js";
import { connectionPillText } from "../ui/ConnectionPill.js";
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

/**
 * Human-readable text for every join refusal (FR-5.6 retry path). Kept as the
 * D0 export name; the single source of the wording is `JoinFlow`.
 */
export const JOIN_ERROR_TEXT: Readonly<Record<JoinErrorReason, string>> = JOIN_FLOW_MESSAGES;

/** Shown when the server ends the room because the TV never came back (FR-7.16). */
export const HOST_LOST_KICK_TEXT = "The TV disconnected and the room ended. Ask for a new code.";

/** Pill label for a client state; the mapping lives in `ui/ConnectionPill` (A9). */
export function connectionPillLabel(state: ControllerState): string {
  return connectionPillText({ phase: state.status, slot: state.slot, host: state.host });
}

/**
 * Tab-lifetime Web Storage stand-in. Used when the browser storages are
 * unavailable (private mode) so an in-tab reconnect can still reclaim the slot
 * by session (FR-5.4); it does not survive a reload.
 */
export function createMemoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
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
  setTimeout: (handler, timeoutMs) =>
    globalThis.setTimeout(handler, timeoutMs) as unknown as number,
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
   * Per-room session storage (FR-5.4). Defaults to an in-memory store, so a
   * reconnect inside this tab still uses the session; the browser entry
   * passes the real `sessionStorage`/`localStorage` pair for reloads.
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
  /**
   * Visible-viewport tracker (D5-CTRL-03). Text controls use it to stay above
   * the on-screen keyboard; the page shell owns and disposes it.
   */
  viewport?: ViewportTracker | null;
  /**
   * Motion runtime for a sensors-only layout's status strip (D6-CTRL-03).
   * Optional; the browser uses the default `MotionSource`, tests inject fakes.
   */
  motionRuntime?: GyroControlRuntime;
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
  /** Queued control events waiting to send (D5-CTRL-05). */
  eventPending: number;
  /** Control events dropped for size/rate/overflow/staleness. */
  eventDropped: number;
  /** Milliseconds since the last control event reached the socket. */
  eventLastSendAgeMs: number | null;
  /** Duration of the most recent accepted layout swap, in ms; null before one. */
  swapMs: number | null;
}

// Handles are opaque to the client; the browser returns numbers, Node returns
// Timeout objects. The cast keeps the public timer surface browser-typed.
const asTimerHandle = (handle: unknown): number => handle as number;

const defaultTimers: ControllerTimers = {
  setInterval: (handler, timeoutMs) =>
    asTimerHandle(globalThis.setInterval(handler, timeoutMs)),
  clearInterval: (handle) => globalThis.clearInterval(handle),
};

const defaultSendTimers: ControllerSendTimers = {
  setTimeout: (handler, timeoutMs) =>
    asTimerHandle(globalThis.setTimeout(handler, timeoutMs)),
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
  /** Event sink for choice/text/canvas controls (D5-CTRL-05). */
  events?: ControlEventSink;
  /** Visible-viewport tracker passed to text controls (D5-CTRL-03). */
  viewport?: ViewportTracker;
  /** Motion runtime for the sensors-only status strip (D6-CTRL-03). */
  motionRuntime?: GyroControlRuntime;
}

/**
 * Picks an id for the synthetic strip renderer that a layout control cannot
 * already own (layout ids are arbitrary 1..32-character strings).
 */
function uniqueMotionStripId(used: ReadonlyMap<string, ControlRenderer>): string {
  if (!used.has(MOTION_STRIP_ID)) {
    return MOTION_STRIP_ID;
  }
  let suffix = 2;
  let candidate = `${MOTION_STRIP_ID}-${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${MOTION_STRIP_ID}-${suffix}`;
  }
  return candidate;
}

/**
 * Layout host: mounts one validated layout and hot-swaps it in place
 * (D2-CTRL-04, D5-CTRL-02; FR-8.2, FR-8.3).
 *
 * The view owns the touch engine, the control renderers and the last private
 * panel content by control id; it never talks to the socket. A swap cancels
 * active touches, disposes the old renderers, builds the new DOM in a
 * DocumentFragment and mounts it with one `replaceChildren`, then re-caches
 * the hit rects. A surface resize rebuilds with the new geometry.
 */
export class ControllerLayoutView {
  private readonly surface: HTMLElement;
  private readonly input: InputStore;
  private readonly sizeSource: SurfaceSize | (() => SurfaceSize) | undefined;
  private readonly debugOutline: boolean;
  private readonly onScriptTime: ((ms: number) => void) | undefined;
  private readonly events: ControlEventSink | undefined;
  private readonly viewport: ViewportTracker | undefined;
  private readonly motionRuntime: GyroControlRuntime | undefined;

  private engine: TouchEngine | null = null;
  private renderers: Array<{
    control: Control | null;
    renderer: ControlRenderer;
    rect: HitRect;
  }> = [];
  private renderersById = new Map<string, ControlRenderer>();
  private currentLayout: LayoutDocument | null = null;
  private size: SurfaceSize = { width: 0, height: 0 };
  /** Last panel content per control id, preserved across swaps (FR-8.2). */
  private panelContentById = new Map<string, PanelContent | null>();
  /** Slot-wide panel content seen before a panel control existed. */
  private pendingPanelContent: PanelContent | null | undefined = undefined;

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
    this.events = options.events;
    this.viewport = options.viewport;
    this.motionRuntime = options.motionRuntime;
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
   * Mounts a validated layout, swapping the current one in place. Returns
   * false for a same-id layout, which is idempotent and leaves the DOM alone
   * (D5-CTRL-02). The client validates before calling.
   */
  setLayout(layout: LayoutDocument): boolean {
    if (this.currentLayout !== null && this.currentLayout.id === layout.id) {
      return false;
    }
    // Release held touches before their renderers can be disposed (FR-7.12).
    this.engine?.cancelTouches();
    this.currentLayout = layout;
    this.build();
    return true;
  }

  /**
   * Applies private `panel` content to every panel in the current layout and
   * remembers it by control id so a same-id panel survives a swap
   * (D5-CTRL-02). `null` clears. Invalid content is ignored: a malformed
   * panel message can neither inject markup nor blank a good panel.
   */
  setPanelContent(content: unknown): boolean {
    if (content === null) {
      this.pendingPanelContent = null;
      this.panelContentById.clear();
      this.applyPanelContentToRenderers(null, false);
      return true;
    }
    const result = validatePanelContent(content);
    if (!result.ok) {
      return false;
    }
    this.pendingPanelContent = result.content;
    this.applyPanelContentToRenderers(result.content, true);
    return true;
  }

  /** Removes the renderers and the touch engine, leaving the surface empty. */
  clear(): void {
    this.engine?.cancelTouches();
    this.disposeRenderers();
    this.engine?.dispose();
    this.engine = null;
    this.currentLayout = null;
    this.size = { width: 0, height: 0 };
    this.panelContentById.clear();
    this.pendingPanelContent = undefined;
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
    if (this.events !== undefined) {
      ctx.events = this.events;
    }
    if (this.viewport !== undefined) {
      ctx.viewport = this.viewport;
    }

    const fragment = document.createDocumentFragment();
    const renderers: Array<{
      control: Control | null;
      renderer: ControlRenderer;
      rect: HitRect;
    }> = [];
    const byId = new Map<string, ControlRenderer>();
    const sensors = layout.sensors;
    const hasGyroControl = layout.controls.some((control) => control.type === "gyro");
    for (const control of layout.controls) {
      // FR-8.5: layout-level values are defaults for the gyro control; the
      // control's own smoothing/sensitivity win (D6-RT/CTRL contract).
      let effective = control;
      if (sensors !== undefined && control.type === "gyro") {
        const merged = { ...control };
        if (merged.smoothing === undefined && sensors.smoothing !== undefined) {
          merged.smoothing = sensors.smoothing;
        }
        if (merged.sensitivity === undefined && sensors.sensitivity !== undefined) {
          merged.sensitivity = sensors.sensitivity;
        }
        effective = merged;
      }
      const renderer = createControl(effective, ctx);
      fragment.append(renderer.element);
      renderers.push({
        control: effective,
        renderer,
        rect: controlHitRect(effective, this.size),
      });
      byId.set(effective.id, renderer);
    }

    // D6-CTRL-03: a layout may declare `sensors.gyro` without a visible gyro
    // control. Mount the compact status strip so the sensor is reachable and
    // its fallback states stay visible, without duplicating the gyro pill.
    if (sensors?.gyro !== undefined && !hasGyroControl) {
      const stripId = uniqueMotionStripId(byId);
      const stripOptions: {
        id: string;
        runtime?: GyroControlRuntime;
        smoothing?: number;
        sensitivity?: number;
      } = { id: stripId };
      if (this.motionRuntime !== undefined) {
        stripOptions.runtime = this.motionRuntime;
      }
      if (sensors.smoothing !== undefined) {
        stripOptions.smoothing = sensors.smoothing;
      }
      if (sensors.sensitivity !== undefined) {
        stripOptions.sensitivity = sensors.sensitivity;
      }
      const strip = createMotionStatusStrip(ctx, stripOptions);
      fragment.append(strip.element);
      renderers.push({
        control: null,
        renderer: strip,
        rect: motionStripHitRect(this.size, stripId),
      });
      byId.set(stripId, strip);
    }

    // One mount operation: never leave a frame where some new controls are
    // attached while old ones are still in the document (FR-8.2 step 3).
    this.surface.replaceChildren(fragment);
    this.renderers = renderers;
    this.renderersById = byId;
    this.surface.style.background = layout.background ?? "";
    this.ensureEngine();
    this.engine?.setControls(this.renderers.map(({ rect }) => rect));
    this.restorePanelContent();
  }

  private applyPanelContentToRenderers(
    content: PanelContent | null,
    remember: boolean,
  ): void {
    for (const { control, renderer } of this.renderers) {
      if (control === null || !isPanelRenderer(renderer)) {
        continue;
      }
      renderer.setContent(content);
      if (remember) {
        this.panelContentById.set(control.id, content);
      } else {
        this.panelContentById.delete(control.id);
      }
    }
  }

  private restorePanelContent(): void {
    for (const { control, renderer } of this.renderers) {
      if (control === null || !isPanelRenderer(renderer)) {
        continue;
      }
      if (this.panelContentById.has(control.id)) {
        renderer.setContent(this.panelContentById.get(control.id) ?? null);
        continue;
      }
      if (this.pendingPanelContent !== undefined) {
        renderer.setContent(this.pendingPanelContent);
        this.panelContentById.set(control.id, this.pendingPanelContent);
      }
    }
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
  private readonly eventQueue: EventQueue;
  private readonly layoutView: ControllerLayoutView | null;
  private readonly joinFlow: JoinFlow;

  private readonly listeners = new Set<(state: ControllerState) => void>();
  private readonly layoutListeners = new Set<(layout: LayoutDocument | null) => void>();
  private readonly joinListeners = new Set<(state: JoinFlowState) => void>();
  private readonly hapticListeners = new Set<(durations: readonly number[]) => void>();
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
  private lastSwapMs: number | null = null;

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
    this.store =
      options.sessionStore ?? createSessionStore({ sessionStorage: createMemoryStorage() });
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

    // One event path for every control (D5-CTRL-05): controls hand validated
    // events to this queue, which stamps the joined slot and sends over the
    // same socket. No control ever sends directly.
    this.eventQueue = new EventQueue({
      transport: {
        isOpen: () => this.joined && this.socketOpen && this.socket !== null,
        send: (frame) => {
          const socket = this.socket;
          if (socket === null || !this.socketOpen) {
            return false;
          }
          try {
            socket.send(frame);
            return true;
          } catch {
            return false;
          }
        },
      },
      getSlot: () => (this.joined ? this.state.slot : null),
      now: this.now,
      timers: {
        set: (callback, delayMs) => this.sendTimers.setTimeout(callback, delayMs),
        clear: (handle) => {
          this.sendTimers.clearTimeout(handle as number);
        },
      },
    });

    if (options.surface !== undefined) {
      const viewOptions: ControllerLayoutViewOptions = {
        events: this.eventQueue,
        onScriptTime: (ms) => {
          this.lastScriptMs = ms;
        },
      };
      if (options.viewport !== undefined && options.viewport !== null) {
        viewOptions.viewport = options.viewport;
      }
      if (options.surfaceSize !== undefined) {
        viewOptions.surfaceSize = options.surfaceSize;
      }
      if (options.debugOutline !== undefined) {
        viewOptions.debugOutline = options.debugOutline;
      }
      if (options.motionRuntime !== undefined) {
        viewOptions.motionRuntime = options.motionRuntime;
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
    const events = this.eventQueue.stats();
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
      eventPending: events.pending,
      eventDropped: Object.values(events.dropped).reduce((total, count) => total + count, 0),
      eventLastSendAgeMs: events.lastSendAge,
      swapMs: this.lastSwapMs,
    };
  }

  /** Event queue counters, for diagnostics above the generic `stats`. */
  get eventStats(): EventQueueStats {
    return this.eventQueue.stats();
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
   * Subscribes to Haptic frames (D6; FR-8.11). The decoded pattern is handed
   * to the page's `HapticPlayer`, which owns coalescing and the global toggle.
   * Patterns are never stored or logged (SR-12).
   */
  onHaptic(listener: (durations: readonly number[]) => void): () => void {
    this.hapticListeners.add(listener);
    return () => {
      this.hapticListeners.delete(listener);
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
      case "panel":
        this.handlePanel(message.slot, message.content);
        return;
      default:
        return;
    }
  }

  /**
   * Server→controller binary frames: Pong drives clock sync (A3) and Haptic
   * carries one host pulse (D6; FR-8.11). Unknown frames are ignored so a
   * future message type cannot close the socket.
   */
  private handleBinary(frame: Uint8Array): void {
    if (frame.byteLength === 0) {
      return;
    }
    if (frame[0] === MSG.Pong) {
      try {
        const { clientTimeMs, serverTimeMs } = decodePong(frame);
        this.clock.onPong(clientTimeMs, serverTimeMs, this.now());
      } catch {
        // A malformed Pong is ignored; the socket stays open.
      }
      return;
    }
    if (frame[0] === MSG.Haptic) {
      let durations: number[];
      try {
        durations = decodeHaptic(frame);
      } catch {
        // A malformed Haptic frame is dropped locally, never forwarded.
        return;
      }
      for (const listener of this.hapticListeners) {
        try {
          listener(durations);
        } catch {
          // A faulty listener must not break the socket or other listeners.
        }
      }
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

    // A layout in `joined` is authoritative for this connection. A same-id
    // replay after a reconnect is idempotent; a changed layout hot-swaps in
    // place without touching the session or the send loop (FR-8.2).
    if (message.layout !== undefined) {
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
    // Flush control events buffered while the socket was down, in order
    // (D5-CTRL-05; FR-7.15).
    this.eventQueue.drain();
  }

  /**
   * Hot-swap (D5-CTRL-02; FR-8.2): every `setLayout` addressed to this slot
   * or `all` validates and mounts, repeatedly. Messages for other slots are
   * ignored; an invalid layout keeps the current one and is never acked.
   */
  private handleSetLayout(slot: number | "all", layout: unknown): void {
    if (!this.joined) {
      return;
    }
    if (slot !== "all" && slot !== this.state.slot) {
      return;
    }
    this.applyLayout(layout);
  }

  /**
   * Validates and mounts a layout; returns false and records the error
   * without touching the mounted layout. A successful swap is acked with
   * `layoutAck` (D5-CTRL-02).
   */
  private applyLayout(value: unknown): boolean {
    const result = validateLayout(value);
    if (!result.ok) {
      this.currentLayoutError = result.errors.join("; ");
      return false;
    }

    if (this.currentLayout !== null && this.currentLayout.id === result.layout.id) {
      // Idempotent replay: no rebuild and no DOM work. Ack again so a host
      // that missed the original ack after a reconnect can settle.
      this.currentLayoutError = null;
      this.ackLayout(result.layout.id);
      return true;
    }

    const startedAt = nowMilliseconds();
    this.currentLayout = result.layout;
    this.currentLayoutError = null;
    this.layoutView?.setLayout(result.layout);
    this.lastSwapMs = nowMilliseconds() - startedAt;
    this.notifyLayout();
    this.ackLayout(result.layout.id);
    return true;
  }

  /**
   * Acknowledges one successfully mounted layout over the current socket
   * (FR-8.2). It is sent synchronously, well inside the 100 ms budget. A
   * failed send is harmless: the host replays on join and a same-id replay is
   * idempotent.
   */
  private ackLayout(layoutId: string): void {
    if (!this.joined || this.socket === null || !this.socketOpen) {
      return;
    }
    try {
      this.socket.send(stringifyJsonMessage({ t: "layoutAck", layoutId }));
    } catch {
      // The socket may have gone away between `joined` and this frame.
    }
  }

  /**
   * Private panel content for this slot (D5-CTRL-01; FR-8.1, SR-13). Routing
   * is checked again here even though the broker already addresses one peer.
   */
  private handlePanel(slot: number, content: unknown): void {
    if (!this.joined || slot !== this.state.slot) {
      return;
    }
    this.layoutView?.setPanelContent(content);
  }

  private clearLayout(): void {
    const hadLayout = this.currentLayout !== null || this.currentLayoutError !== null;
    this.currentLayout = null;
    this.currentLayoutError = null;
    this.lastSwapMs = null;
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
      this.eventQueue.clear();
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
   * The page became visible but its socket died while hidden (FR-8.8). Hands
   * control to the reconnect layer. `SuspendController` calls this before
   * `onShow`, so the suspended flag is cleared here rather than relied on.
   * Reuses the existing machine when it is still live; a fresh one is seeded
   * as `connected` so the drop schedules the 250 ms attempt.
   */
  private restartReconnect(): void {
    this.suspended = false;
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
      error:
        reason === "hostLost"
          ? HOST_LOST_KICK_TEXT
          : joinStateNotice(flowState) ?? "The host removed this controller.",
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

  /**
   * Visible again but the slot cannot be reclaimed by session. `expired` (the
   * page was hidden past the 30 s reservation) tells the player why; `missing`
   * (no stored session, e.g. storage was cleared) silently re-runs the join
   * precedence: room token if held, otherwise the manual form (FR-5.5).
   */
  private handleSessionLost(reason: SessionLostReason): void {
    this.abandonSession(reason === "expired" ? JOIN_FLOW_MESSAGES.expired : null);
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
    this.eventQueue.clear();
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

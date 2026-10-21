/**
 * Controller debug overlay (D2-PERF-01; FR-8.3, NR-6.3, PR-11.1).
 *
 * Hidden by default. The page enables it only with `?debug=1` (the same flag
 * convention the host uses for FR-12.2); triple-tap top-left then toggles
 * visibility without touching the play surface (SPEC §8.5). It shows:
 *
 * - send rate (packets/s) and time since the last Input packet;
 * - scripting time p50/p95 measured around synchronous touch dispatch, from a
 *   fixed 120-sample ring;
 * - active and dropped touches, RTT, clock offset and the mounted layout id.
 *
 * The ring and the packet-rate bookkeeping are preallocated, so recording a
 * sample or updating the counters allocates nothing. `update()` only writes DOM
 * text while the overlay is visible. There are no dependencies and no timers:
 * the page owns the update interval, which keeps this module testable and easy
 * to tree-shake out of a production build.
 */

/** Fixed ring size for script-time samples (D2-PERF-01). */
export const SCRIPT_SAMPLE_CAPACITY = 120;

const TOUCH_EVENT_TYPES = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;

/** Snapshot shape the overlay renders; structurally satisfied by client stats. */
export interface DebugOverlayStats {
  /** Input packets sent since the client was created. */
  packetsSent: number;
  /** Milliseconds since the last send; Infinity before the first packet. */
  lastSendAgeMs: number;
  /** Clock-sync RTT; Infinity before the first Pong. */
  rttMs: number;
  /** Clock offset from the minimum-RTT sample. */
  offsetMs: number;
  /** Duration of the most recent synchronous touch dispatch, in ms. */
  scriptMs: number;
  activeTouches: number;
  droppedTouches: number;
  layoutId: string | null;
}

export interface ScriptPercentiles {
  /** Number of samples in the ring, 0..capacity. */
  samples: number;
  /** Nearest-rank median, in ms; 0 when the ring is empty. */
  p50: number;
  /** Nearest-rank 95th percentile, in ms; 0 when the ring is empty. */
  p95: number;
}

export interface DebugOverlayOptions {
  /** Existing `#debug-overlay` element; its children are replaced. */
  mount: HTMLElement;
  /** `?debug=1`; the overlay can never become visible when false. */
  enabled?: boolean;
  /** Ring capacity; clamped to 1..10000, default 120. */
  capacity?: number;
  /** Millisecond clock override for tests. */
  now?: () => number;
}

interface OverlayFields {
  pps: HTMLElement;
  age: HTMLElement;
  scriptP50: HTMLElement;
  scriptP95: HTMLElement;
  touches: HTMLElement;
  rtt: HTMLElement;
  offset: HTMLElement;
  layout: HTMLElement;
}

/**
 * Fixed-capacity ring of script durations with allocation-free percentiles.
 *
 * `record` writes one slot and never grows; `percentiles` copies into a second
 * preallocated buffer, pads the tail with Infinity and sorts it in place. The
 * logical sample order is irrelevant to a percentile.
 */
class SampleRing {
  private readonly values: Float64Array;
  private readonly scratch: Float64Array;
  private cursor = 0;
  private size = 0;

  constructor(capacity: number) {
    const requested = Number.isFinite(capacity) ? Math.floor(capacity) : SCRIPT_SAMPLE_CAPACITY;
    const safe = Math.min(10000, Math.max(1, requested));
    this.values = new Float64Array(safe);
    this.scratch = new Float64Array(safe);
  }

  get count(): number {
    return this.size;
  }

  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      return;
    }
    this.values[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % this.values.length;
    if (this.size < this.values.length) {
      this.size += 1;
    }
  }

  reset(): void {
    this.cursor = 0;
    this.size = 0;
  }

  percentiles(): ScriptPercentiles {
    const samples = this.size;
    if (samples === 0) {
      return { samples: 0, p50: 0, p95: 0 };
    }

    for (let index = 0; index < samples; index += 1) {
      this.scratch[index] = this.values[index] ?? 0;
    }
    for (let index = samples; index < this.scratch.length; index += 1) {
      this.scratch[index] = Number.POSITIVE_INFINITY;
    }
    this.scratch.sort();

    // Nearest rank: ceil(p * n) - 1, clamped to the valid range.
    const rank = (fraction: number): number => {
      const index = Math.min(samples - 1, Math.max(0, Math.ceil(fraction * samples) - 1));
      return this.scratch[index] ?? 0;
    };

    return { samples, p50: rank(0.5), p95: rank(0.95) };
  }
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function formatMs(value: number, digits: number): string {
  return Number.isFinite(value) ? `${value.toFixed(digits)} ms` : "—";
}

/**
 * Creates a `<dl>` of live fields inside `mount`. Rows are built once; updates
 * only assign `textContent`, so no per-update element construction happens.
 */
function buildFields(mount: HTMLElement): OverlayFields {
  const list = document.createElement("dl");
  const row = (label: string, initial: string): HTMLElement => {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const value = document.createElement("dd");
    value.textContent = initial;
    wrapper.append(term, value);
    list.append(wrapper);
    return value;
  };

  const fields: OverlayFields = {
    pps: row("Packets/s", "0"),
    age: row("Last send", "—"),
    scriptP50: row("Script p50", "—"),
    scriptP95: row("Script p95", "—"),
    touches: row("Touches", "0"),
    rtt: row("RTT", "—"),
    offset: row("Offset", "—"),
    layout: row("Layout", "none"),
  };

  mount.replaceChildren(list);
  return fields;
}

/**
 * Controller-side debugging HUD (D2-PERF-01).
 *
 * Usage:
 * ```ts
 * const overlay = new DebugOverlay({ mount, enabled: debugEnabled });
 * setInterval(() => overlay.update(client.stats), 500);
 * overlay.toggle(); // triple-tap, only when enabled
 * ```
 */
export class DebugOverlay {
  /** True only when the `?debug=1` flag enabled the HUD. */
  readonly enabled: boolean;

  private readonly mount: HTMLElement;
  private readonly ring: SampleRing;
  private readonly fields: OverlayFields;
  private readonly now: () => number;

  private lastPacketsSent: number | null = null;
  private lastSampleAtMs: number;
  private lastRecordedScriptMs = 0;
  private lastRecordedPackets = -1;
  private touchTimingTarget: Window | null = null;
  private touchStartedAtMs: number | null = null;

  /** Window capture start; runs before the surface hit-test and handlers. */
  private readonly handleTouchCapture = (): void => {
    this.touchStartedAtMs = this.now();
  };

  /** Window bubble end; runs after every surface listener returns. */
  private readonly handleTouchBubble = (): void => {
    if (this.touchStartedAtMs === null) {
      return;
    }
    this.recordScriptTime(this.now() - this.touchStartedAtMs);
    this.touchStartedAtMs = null;
  };

  constructor(options: DebugOverlayOptions) {
    this.mount = options.mount;
    this.enabled = options.enabled ?? false;
    this.now = options.now ?? defaultNow;
    this.ring = new SampleRing(options.capacity ?? SCRIPT_SAMPLE_CAPACITY);
    this.fields = buildFields(options.mount);
    this.lastSampleAtMs = this.now();
    this.mount.hidden = !this.enabled;
  }

  /** The host element the HUD renders into (inspection and tests). */
  get root(): HTMLElement {
    return this.mount;
  }

  /** Visible only when enabled and not hidden by the triple-tap toggle. */
  get visible(): boolean {
    return this.enabled && !this.mount.hidden;
  }

  /** Number of script-time samples currently in the ring. */
  get sampleCount(): number {
    return this.ring.count;
  }

  /** Adds one synchronous touch-dispatch duration (ms). Non-finite values are ignored. */
  recordScriptTime(ms: number): void {
    this.ring.record(ms);
  }

  /**
   * Measures each touch event end to end: window capture (before the surface
   * hit-test) to window bubble (after every control handler returned). This
   * includes layout hit-test time, which the client's last-dispatch counter
   * does not. Only active when the overlay is enabled; calling twice is a
   * no-op. `dispose()` removes the listeners.
   */
  observeTouchTiming(target: Window): void {
    if (!this.enabled || this.touchTimingTarget !== null) {
      return;
    }
    this.touchTimingTarget = target;
    for (const type of TOUCH_EVENT_TYPES) {
      target.addEventListener(type, this.handleTouchCapture, { capture: true, passive: true });
      target.addEventListener(type, this.handleTouchBubble, { passive: true });
    }
  }

  /** Current nearest-rank percentiles over the ring. Allocation-free. */
  percentiles(): ScriptPercentiles {
    return this.ring.percentiles();
  }

  /** Clears the ring (for a new layout or after a reconnect). */
  resetSamples(): void {
    this.ring.reset();
    this.lastRecordedScriptMs = 0;
    this.lastRecordedPackets = -1;
  }

  /**
   * Updates every field from one stats snapshot. Safe to call while hidden:
   * counters stay current, DOM text is only written when visible.
   */
  update(stats: DebugOverlayStats): void {
    const now = this.now();

    let packetsPerSecond: string | null = null;
    if (this.lastPacketsSent !== null) {
      const elapsedMs = Math.max(1, now - this.lastSampleAtMs);
      const delta = Math.max(0, stats.packetsSent - this.lastPacketsSent);
      packetsPerSecond = String(Math.round((delta * 1000) / elapsedMs));
    }
    this.lastPacketsSent = stats.packetsSent;
    this.lastSampleAtMs = now;

    // The client exposes only the most recent dispatch duration. Record a
    // sample when it is fresh: either the duration changed or a new packet
    // was sent since the previous update (an idle repeat is not new evidence).
    if (
      this.touchTimingTarget === null &&
      stats.scriptMs > 0 &&
      (stats.scriptMs !== this.lastRecordedScriptMs || stats.packetsSent !== this.lastRecordedPackets)
    ) {
      this.ring.record(stats.scriptMs);
      this.lastRecordedScriptMs = stats.scriptMs;
      this.lastRecordedPackets = stats.packetsSent;
    }

    if (!this.visible) {
      return;
    }

    if (packetsPerSecond !== null) {
      this.fields.pps.textContent = packetsPerSecond;
    }
    const script = this.ring.percentiles();
    this.fields.age.textContent = formatMs(stats.lastSendAgeMs, 0);
    this.fields.scriptP50.textContent = script.samples === 0 ? "—" : formatMs(script.p50, 2);
    this.fields.scriptP95.textContent = script.samples === 0 ? "—" : formatMs(script.p95, 2);
    this.fields.touches.textContent =
      stats.droppedTouches > 0
        ? `${stats.activeTouches} (${stats.droppedTouches} dropped)`
        : String(stats.activeTouches);
    this.fields.rtt.textContent = formatMs(stats.rttMs, 1);
    this.fields.offset.textContent = Number.isFinite(stats.rttMs)
      ? `${stats.offsetMs >= 0 ? "+" : ""}${stats.offsetMs.toFixed(1)} ms`
      : "—";
    this.fields.layout.textContent = stats.layoutId ?? "none";
  }

  /** Triple-tap handler. A disabled overlay can never be shown. */
  toggle(): boolean {
    if (!this.enabled) {
      return false;
    }
    this.mount.hidden = !this.mount.hidden;
    return !this.mount.hidden;
  }

  /** Shows the overlay when `?debug=1` is present; no-op otherwise. */
  show(): void {
    if (this.enabled) {
      this.mount.hidden = false;
    }
  }

  /** Hides the overlay; the flag remains the only way to enable it again. */
  hide(): void {
    this.mount.hidden = true;
  }

  /** Removes listeners and generated rows and hides the mount. */
  dispose(): void {
    const target = this.touchTimingTarget;
    if (target !== null) {
      for (const type of TOUCH_EVENT_TYPES) {
        target.removeEventListener(type, this.handleTouchCapture, true);
        target.removeEventListener(type, this.handleTouchBubble, false);
      }
      this.touchTimingTarget = null;
    }
    this.mount.replaceChildren();
    this.mount.hidden = true;
  }
}

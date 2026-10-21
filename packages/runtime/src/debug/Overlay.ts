/**
 * Host debug overlay (D3-RT-06; FR-12.2, FR-8.5, PR-9.4, PR-9.8, SR-9).
 *
 * Hidden by default. The host enables it only when the URL says `?debug=1`
 * (`isDebugEnabled`), which is the same opt-in convention the controller HUD
 * uses; a TV never shows debug clutter by accident. `D` hides or re-shows the
 * panel once enabled.
 *
 * Fields (names are kept stable for screenshots and Gate evidence):
 *
 * - backend, FPS, frame ms mean/p50/p95 over the last 120 frames, sim ticks/s;
 * - draw calls, texture MB, JS heap MB when the browser exposes
 *   `performance.memory`, visible instance count;
 * - canvas backing size, dynamic-resolution scale, DPR;
 * - pooled entity counts (PR-9.4) and the active layout's gyro smoothing alpha
 *   (FR-8.5) so both are inspectable without a debugger;
 * - per slot: last input age, packets/s, RTT, jitter and drops. RTT/jitter are
 *   placeholders (`—`) until D4 supplies server stats.
 *
 * Performance contract:
 *
 * - `recordFrame` is the per-frame path. While the overlay is hidden it
 *   returns before doing any work; while visible it only writes numbers into
 *   the preallocated ring, so it allocates nothing (PR-9.3, PR-9.8).
 * - `update` is the only DOM path. It is throttled to 4 Hz by an injected
 *   clock, writes `textContent` on fixed nodes built in the constructor, and
 *   never builds elements during a paint.
 * - Rendering uses an external stylesheet imported here (`overlay.css`), not
 *   inline styles, so the dev CSP's `style-src 'self'` keeps working.
 *
 * The overlay receives only display data (`OverlaySnapshot`). It never reads
 * storage, the URL beyond the debug flag, or any token, so SR-9 holds by
 * construction.
 *
 * Integration (the host shell owns this wiring; this module has no timer):
 *
 * ```ts
 * const mount = document.createElement("div");
 * document.body.append(mount);
 * const overlay = new DebugOverlay({
 *   mount,
 *   enabled: isDebugEnabled(search), // the host reads location.search
 * });
 * window.addEventListener("keydown", (event) => overlay.handleKey(event.key));
 * // loop: onFrameStats: (stats) => overlay.recordFrame(stats)
 * // 4 Hz: overlay.update({ backend, drawCalls, textureMemoryMB, ... });
 * ```
 */
import type { FrameStats } from "../loop/types.js";
import type { RendererBackend } from "../render/Renderer.js";
import "./overlay.css";

/** Paints per second while visible. More often wastes TV DOM work. */
export const OVERLAY_UPDATE_HZ = 4;
/** Minimum spacing between DOM paints, in milliseconds. */
export const OVERLAY_UPDATE_INTERVAL_MS = 1000 / OVERLAY_UPDATE_HZ;
/** Frame samples retained for the mean/p50/p95 window (D3-RT-06). */
export const FRAME_SAMPLE_CAPACITY = 120;
/** Case-insensitive key that hides or re-shows an enabled overlay. */
export const OVERLAY_TOGGLE_KEY = "d";

const MAX_SAMPLE_CAPACITY = 10_000;
const BYTES_PER_MB = 1024 * 1024;
const SLOT_COUNT = 8;
const EMPTY_VALUE = "—";

/**
 * True only for `?debug=1`. Any other value (including `?debug=0`, `?debug`,
 * or `?debug=true`) leaves the overlay disabled, so the query flag remains
 * the single explicit enable path.
 */
export function isDebugEnabled(search: string): boolean {
  return new URLSearchParams(search).get("debug") === "1";
}

/** Per-slot diagnostics as displayed; RTT/jitter are null until D4. */
export interface OverlaySlotStats {
  /** Slot number, 1..8. */
  readonly slot: number;
  /** Milliseconds since the last InputFwd, or -1 before any input. */
  readonly lastInputAgeMs: number;
  /** Input packets received in the last second. */
  readonly packetsPerSecond: number;
  /** Dropped or invalid input packets for this slot. */
  readonly drops: number;
  /** Round-trip time from server stats, or null until D4. */
  readonly rttMs: number | null;
  /** Jitter from server stats, or null until D4. */
  readonly jitterMs: number | null;
}

/** Canvas and dynamic-resolution state supplied by the host (D3-RT-07). */
export interface OverlayResolutionStats {
  /** Dynamic-resolution scale, 1 = 100%. */
  readonly scale: number;
  /** Device pixel ratio applied by the host profile. */
  readonly dpr: number;
  /** Backing-store width in pixels. */
  readonly width: number;
  /** Backing-store height in pixels. */
  readonly height: number;
}

/** Spawned-entity pool counts (PR-9.4). */
export interface OverlayEntityStats {
  /** Entities currently simulating/rendering. */
  readonly active: number;
  /** Objects retained by the pool, active plus free. */
  readonly pooled: number;
  /** Total spawns since load, or null when the game does not count them. */
  readonly spawned: number | null;
}

/**
 * One display snapshot, assembled by the host at 4 Hz. All "unavailable"
 * values are explicit `null` so the overlay can never show a stale number as
 * if it were live.
 */
export interface OverlaySnapshot {
  /** Selected renderer backend, or null before the renderer is initialised. */
  readonly backend: RendererBackend | null;
  readonly drawCalls: number;
  readonly textureMemoryMB: number;
  /** Explicit heap value; `null` falls back to `readJsHeapMB()`. */
  readonly jsHeapMB: number | null;
  readonly visibleInstances: number | null;
  readonly resolution: OverlayResolutionStats | null;
  readonly entities: OverlayEntityStats | null;
  /** Active layout's gyro smoothing alpha (FR-8.5), or null when unset. */
  readonly gyroSmoothing: number | null;
  /** Per-slot stats, 0..8 entries; missing slots display `—`. */
  readonly slots: ReadonlyArray<OverlaySlotStats>;
}

export interface DebugOverlayOptions {
  /** Host element to fill; the overlay owns its children and `hidden`. */
  readonly mount: HTMLElement;
  /** `?debug=1`; the overlay can never become visible when false. */
  readonly enabled: boolean;
  /** Monotonic millisecond clock; injectable for deterministic tests. */
  readonly now?: () => number;
  /** Frame ring capacity, clamped to 1..10000. Default 120. */
  readonly capacity?: number;
  /** Paint interval, default 250 ms (4 Hz). */
  readonly updateIntervalMs?: number;
}

/** Minimal `performance.memory` surface (Chrome; absent elsewhere). */
export interface PerformanceMemoryLike {
  readonly memory?: { readonly usedJSHeapSize?: number } | undefined;
}

/**
 * Used JS heap in MB when the browser exposes it, else null. Chromium (the TV
 * and desktop target) provides `performance.memory`; Firefox/Safari do not,
 * and the overlay shows `—`.
 */
export function readJsHeapMB(
  performanceLike: PerformanceMemoryLike | undefined = typeof performance ===
  "undefined"
    ? undefined
    : (performance as unknown as PerformanceMemoryLike),
): number | null {
  const used = performanceLike?.memory?.usedJSHeapSize;
  if (typeof used !== "number" || !Number.isFinite(used) || used <= 0) {
    return null;
  }
  return used / BYTES_PER_MB;
}

/**
 * Fixed-capacity frame-time window with allocation-free statistics.
 *
 * `record` writes one slot and never grows; `compute` copies the retained
 * values into a second preallocated buffer, pads the tail with Infinity for
 * the in-place sort and fills the mean/p50/p95 fields. Percentiles are
 * nearest-rank (`ceil(p * n) - 1`), which needs no interpolation allocations.
 */
export class FrameTimeRing {
  private readonly values: Float64Array;
  private readonly scratch: Float64Array;
  private cursor = 0;
  private size = 0;
  private meanValue = 0;
  private p50Value = 0;
  private p95Value = 0;

  constructor(capacity: number = FRAME_SAMPLE_CAPACITY) {
    const requested = Number.isFinite(capacity)
      ? Math.floor(capacity)
      : FRAME_SAMPLE_CAPACITY;
    const safe = Math.min(
      MAX_SAMPLE_CAPACITY,
      Math.max(1, requested),
    );
    this.values = new Float64Array(safe);
    this.scratch = new Float64Array(safe);
  }

  get capacity(): number {
    return this.values.length;
  }

  /** Samples currently retained, 0..capacity. */
  get count(): number {
    return this.size;
  }

  /** Mean over the retained window; 0 before the first `compute`. */
  get mean(): number {
    return this.meanValue;
  }

  /** Nearest-rank median; 0 before the first `compute`. */
  get p50(): number {
    return this.p50Value;
  }

  /** Nearest-rank 95th percentile; 0 before the first `compute`. */
  get p95(): number {
    return this.p95Value;
  }

  /** Adds one frame time. Non-finite and negative values are ignored. */
  record(frameMs: number): void {
    if (!Number.isFinite(frameMs) || frameMs < 0) {
      return;
    }
    this.values[this.cursor] = frameMs;
    this.cursor = (this.cursor + 1) % this.values.length;
    if (this.size < this.values.length) {
      this.size += 1;
    }
  }

  reset(): void {
    this.cursor = 0;
    this.size = 0;
    this.meanValue = 0;
    this.p50Value = 0;
    this.p95Value = 0;
  }

  /** Recomputes mean/p50/p95 over the window; allocates nothing. */
  compute(): void {
    const samples = this.size;
    if (samples === 0) {
      this.meanValue = 0;
      this.p50Value = 0;
      this.p95Value = 0;
      return;
    }

    const scratch = this.scratch;
    let total = 0;
    for (let index = 0; index < samples; index += 1) {
      const value = this.values[index] ?? 0;
      total += value;
      scratch[index] = value;
    }
    for (let index = samples; index < scratch.length; index += 1) {
      scratch[index] = Number.POSITIVE_INFINITY;
    }
    scratch.sort();

    this.meanValue = total / samples;
    this.p50Value = nearestRank(scratch, samples, 0.5);
    this.p95Value = nearestRank(scratch, samples, 0.95);
  }
}

function nearestRank(
  sorted: Float64Array,
  samples: number,
  fraction: number,
): number {
  const index = Math.min(
    samples - 1,
    Math.max(0, Math.ceil(fraction * samples) - 1),
  );
  return sorted[index] ?? 0;
}

interface OverlayFields {
  backend: HTMLElement;
  fps: HTMLElement;
  frameMean: HTMLElement;
  frameP50: HTMLElement;
  frameP95: HTMLElement;
  frameSamples: HTMLElement;
  simTicksPerSecond: HTMLElement;
  drawCalls: HTMLElement;
  textureMB: HTMLElement;
  jsHeapMB: HTMLElement;
  visibleInstances: HTMLElement;
  canvasSize: HTMLElement;
  renderScale: HTMLElement;
  dpr: HTMLElement;
  entities: HTMLElement;
  gyroSmoothing: HTMLElement;
  slots: HTMLElement[];
}

/**
 * Builds the fixed node tree once. Values are `<dd data-field="...">` nodes so
 * tests, screenshots and later D4 work can address stable field names.
 */
function buildFields(mount: HTMLElement): OverlayFields {
  const documentRef = mount.ownerDocument;
  const values = documentRef.createElement("dl");
  values.className = "debug-overlay__values";

  const addRow = (label: string, field: string): HTMLElement => {
    const row = documentRef.createElement("div");
    row.className = "debug-overlay__row";
    const term = documentRef.createElement("dt");
    term.textContent = label;
    const value = documentRef.createElement("dd");
    value.dataset["field"] = field;
    value.textContent = EMPTY_VALUE;
    row.append(term, value);
    values.append(row);
    return value;
  };

  const fields: OverlayFields = {
    backend: addRow("Backend", "backend"),
    fps: addRow("FPS", "fps"),
    frameMean: addRow("Frame mean", "frameMean"),
    frameP50: addRow("Frame p50", "frameP50"),
    frameP95: addRow("Frame p95", "frameP95"),
    frameSamples: addRow("Frame samples", "frameSamples"),
    simTicksPerSecond: addRow("Sim ticks/s", "simTicksPerSecond"),
    drawCalls: addRow("Draw calls", "drawCalls"),
    textureMB: addRow("Texture MB", "textureMB"),
    jsHeapMB: addRow("JS heap MB", "jsHeapMB"),
    visibleInstances: addRow("Visible instances", "visibleInstances"),
    canvasSize: addRow("Canvas", "canvasSize"),
    renderScale: addRow("Render scale", "renderScale"),
    dpr: addRow("DPR", "dpr"),
    entities: addRow("Entities", "entities"),
    gyroSmoothing: addRow("Gyro smoothing", "gyroSmoothing"),
    slots: [],
  };

  const slotValues = documentRef.createElement("dl");
  slotValues.className = "debug-overlay__slots";
  for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
    const row = documentRef.createElement("div");
    row.className = "debug-overlay__row";
    const term = documentRef.createElement("dt");
    term.textContent = `P${slot}`;
    const value = documentRef.createElement("dd");
    value.dataset["field"] = `slot-${slot}`;
    value.textContent = EMPTY_VALUE;
    row.append(term, value);
    slotValues.append(row);
    fields.slots.push(value);
  }

  mount.classList.add("debug-overlay");
  mount.replaceChildren(values, slotValues);
  return fields;
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatMs(value: number | null, digits: number): string {
  return value === null ? EMPTY_VALUE : `${value.toFixed(digits)} ms`;
}

function formatMB(value: number | null, digits: number): string {
  return value === null ? EMPTY_VALUE : `${value.toFixed(digits)} MB`;
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : EMPTY_VALUE;
}

function formatOptionalMs(value: number | null, digits: number): string {
  const finite = finiteOrNull(value);
  return finite === null ? EMPTY_VALUE : `${finite.toFixed(digits)} ms`;
}

function formatSlot(stats: OverlaySlotStats): string {
  const age =
    Number.isFinite(stats.lastInputAgeMs) && stats.lastInputAgeMs >= 0
      ? `${Math.round(stats.lastInputAgeMs)} ms`
      : EMPTY_VALUE;
  const packets = `${formatCount(stats.packetsPerSecond)} pkt/s`;
  const rtt = formatOptionalMs(stats.rttMs, 1);
  const jitter = formatOptionalMs(stats.jitterMs, 1);
  const drops = `${formatCount(stats.drops)} drops`;
  return `age ${age} · ${packets} · rtt ${rtt} · jitter ${jitter} · ${drops}`;
}

function formatDpr(dpr: number): string {
  if (!Number.isFinite(dpr)) {
    return EMPTY_VALUE;
  }
  return Number.isInteger(dpr) ? String(dpr) : dpr.toFixed(2);
}

/**
 * Host debug HUD (D3-RT-06). One instance per host page.
 *
 * Call `recordFrame` from the loop's `onFrameStats` every frame and `update`
 * from a ~4 Hz timer (or whenever it is convenient; `update` self-throttles
 * on the injected clock).
 */
export class DebugOverlay {
  /** True only when `?debug=1` enabled the HUD. */
  readonly enabled: boolean;

  private readonly mount: HTMLElement;
  private readonly now: () => number;
  private readonly ring: FrameTimeRing;
  private readonly fields: OverlayFields;
  private readonly updateIntervalMs: number;

  private lastPaintAtMs: number;
  private framesSinceUpdate = 0;
  private simTicksSinceUpdate = 0;
  private paints = 0;

  constructor(options: DebugOverlayOptions) {
    this.mount = options.mount;
    this.enabled = options.enabled;
    this.now = options.now ?? defaultNow;
    this.ring = new FrameTimeRing(options.capacity ?? FRAME_SAMPLE_CAPACITY);
    const interval = options.updateIntervalMs ?? OVERLAY_UPDATE_INTERVAL_MS;
    this.updateIntervalMs =
      Number.isFinite(interval) && interval > 0
        ? interval
        : OVERLAY_UPDATE_INTERVAL_MS;

    this.fields = buildFields(this.mount);
    this.mount.hidden = !this.enabled;
    // The first paint waits for one interval, so the FPS/tick window is
    // measured over real elapsed time instead of a zero-length window.
    this.lastPaintAtMs = this.now();
  }

  /** The host element the HUD renders into (inspection and tests). */
  get root(): HTMLElement {
    return this.mount;
  }

  /** Visible only when enabled and not hidden by the `D` toggle. */
  get visible(): boolean {
    return this.enabled && !this.mount.hidden;
  }

  /** Number of frame samples currently retained. */
  get sampleCount(): number {
    return this.ring.count;
  }

  /** Ring capacity, shown in the "Frame samples" field. */
  get frameCapacity(): number {
    return this.ring.capacity;
  }

  /** DOM paints performed; stays 0 while hidden (test evidence). */
  get updateCount(): number {
    return this.paints;
  }

  /**
   * Per-frame path. Hidden -> return immediately (no ring write, no clock
   * read, no DOM). Visible -> write numbers into the fixed ring only.
   * `stats` is the loop's reused object; no field is retained by reference.
   */
  recordFrame(stats: FrameStats): void {
    if (!this.visible) {
      return;
    }
    const frameMs = stats.frameMs;
    if (!Number.isFinite(frameMs) || frameMs < 0) {
      return;
    }
    this.ring.record(frameMs);
    this.framesSinceUpdate += 1;
    const ticks = stats.simTicks;
    if (Number.isFinite(ticks) && ticks > 0) {
      this.simTicksSinceUpdate += ticks;
    }
  }

  /**
   * Paints the HUD if visible and at least one update interval has elapsed.
   * Hidden or throttled calls do no work at all: they do not read the
   * snapshot, the clock beyond the throttle check, or the DOM.
   */
  update(snapshot: OverlaySnapshot): void {
    if (!this.visible) {
      return;
    }
    const now = this.now();
    const elapsedMs = now - this.lastPaintAtMs;
    if (elapsedMs >= 0 && elapsedMs < this.updateIntervalMs) {
      return;
    }

    const windowMs = Math.max(1, elapsedMs);
    const frames = this.framesSinceUpdate;
    const fps = (frames * 1000) / windowMs;
    const simTicksPerSecond = (this.simTicksSinceUpdate * 1000) / windowMs;
    this.framesSinceUpdate = 0;
    this.simTicksSinceUpdate = 0;
    this.lastPaintAtMs = now;
    this.paints += 1;
    this.ring.compute();

    const fields = this.fields;
    this.setText(fields.backend, snapshot.backend ?? EMPTY_VALUE);

    this.setText(fields.fps, frames > 0 ? formatCount(fps) : "0");
    this.setText(
      fields.frameMean,
      this.ring.count === 0
        ? EMPTY_VALUE
        : formatMs(finiteOrNull(this.ring.mean), 2),
    );
    this.setText(
      fields.frameP50,
      this.ring.count === 0
        ? EMPTY_VALUE
        : formatMs(finiteOrNull(this.ring.p50), 2),
    );
    this.setText(
      fields.frameP95,
      this.ring.count === 0
        ? EMPTY_VALUE
        : formatMs(finiteOrNull(this.ring.p95), 2),
    );
    this.setText(
      fields.frameSamples,
      `${this.ring.count}/${this.ring.capacity}`,
    );
    this.setText(fields.simTicksPerSecond, formatCount(simTicksPerSecond));

    this.setText(fields.drawCalls, formatCount(snapshot.drawCalls));
    this.setText(
      fields.textureMB,
      formatMB(finiteOrNull(snapshot.textureMemoryMB), 2),
    );
    this.setText(
      fields.jsHeapMB,
      formatMB(finiteOrNull(snapshot.jsHeapMB ?? readJsHeapMB()), 1),
    );
    this.setText(
      fields.visibleInstances,
      snapshot.visibleInstances === null
        ? EMPTY_VALUE
        : formatCount(snapshot.visibleInstances),
    );

    const resolution = snapshot.resolution;
    if (resolution === null) {
      this.setText(fields.canvasSize, EMPTY_VALUE);
      this.setText(fields.renderScale, EMPTY_VALUE);
      this.setText(fields.dpr, EMPTY_VALUE);
    } else {
      this.setText(
        fields.canvasSize,
        `${formatCount(resolution.width)}×${formatCount(resolution.height)}`,
      );
      this.setText(
        fields.renderScale,
        Number.isFinite(resolution.scale)
          ? `${Math.round(resolution.scale * 100)}%`
          : EMPTY_VALUE,
      );
      this.setText(fields.dpr, formatDpr(resolution.dpr));
    }

    const entities = snapshot.entities;
    if (entities === null) {
      this.setText(fields.entities, EMPTY_VALUE);
    } else {
      const spawned = finiteOrNull(entities.spawned);
      const suffix =
        spawned === null ? "" : ` · ${formatCount(spawned)} spawned`;
      this.setText(
        fields.entities,
        `${formatCount(entities.active)} active · ` +
          `${formatCount(entities.pooled)} pooled${suffix}`,
      );
    }

    const smoothing = finiteOrNull(snapshot.gyroSmoothing);
    this.setText(
      fields.gyroSmoothing,
      smoothing === null ? EMPTY_VALUE : String(smoothing),
    );

    const slots = snapshot.slots;
    for (let index = 0; index < fields.slots.length; index += 1) {
      const element = fields.slots[index];
      if (element === undefined) {
        continue;
      }
      const stats = findSlot(slots, index + 1);
      this.setText(element, stats === null ? EMPTY_VALUE : formatSlot(stats));
    }
  }

  /** `D` from the host's keydown handler; returns true when it toggled. */
  handleKey(key: string): boolean {
    if (!this.enabled || key.length !== 1) {
      return false;
    }
    if (key.toLowerCase() !== OVERLAY_TOGGLE_KEY) {
      return false;
    }
    this.toggle();
    return true;
  }

  /**
   * Flips visibility when enabled. Showing resets the sample window so stale
   * pre-hide numbers are never presented as current.
   */
  toggle(): boolean {
    if (!this.enabled) {
      return false;
    }
    this.mount.hidden = !this.mount.hidden;
    if (!this.mount.hidden) {
      this.resetWindow();
    }
    return !this.mount.hidden;
  }

  /** Shows the overlay when the `?debug=1` flag enabled it; no-op otherwise. */
  show(): void {
    if (!this.enabled || !this.mount.hidden) {
      return;
    }
    this.mount.hidden = false;
    this.resetWindow();
  }

  /** Hides the overlay; the flag remains the only way to enable it again. */
  hide(): void {
    this.mount.hidden = true;
  }

  /** Removes generated nodes and hides the mount; safe to call twice. */
  dispose(): void {
    this.mount.replaceChildren();
    this.mount.classList.remove("debug-overlay");
    this.mount.hidden = true;
    this.ring.reset();
  }

  private resetWindow(): void {
    this.ring.reset();
    this.framesSinceUpdate = 0;
    this.simTicksSinceUpdate = 0;
    this.lastPaintAtMs = this.now();
    for (const element of this.fields.slots) {
      this.setText(element, EMPTY_VALUE);
    }
    const fields = this.fields;
    for (const element of [
      fields.backend,
      fields.fps,
      fields.frameMean,
      fields.frameP50,
      fields.frameP95,
      fields.frameSamples,
      fields.simTicksPerSecond,
      fields.drawCalls,
      fields.textureMB,
      fields.jsHeapMB,
      fields.visibleInstances,
      fields.canvasSize,
      fields.renderScale,
      fields.dpr,
      fields.entities,
      fields.gyroSmoothing,
    ]) {
      this.setText(element, EMPTY_VALUE);
    }
  }

  private setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) {
      element.textContent = text;
    }
  }
}

function findSlot(
  slots: ReadonlyArray<OverlaySlotStats>,
  slot: number,
): OverlaySlotStats | null {
  for (let index = 0; index < slots.length; index += 1) {
    const candidate = slots[index];
    if (candidate !== undefined && candidate.slot === slot) {
      return candidate;
    }
  }
  return null;
}

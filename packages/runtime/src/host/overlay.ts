/**
 * D3-RT-06 debug overlay wiring and the 4 Hz host diagnostics tick.
 *
 * The overlay module itself owns the DOM; this module owns the host-side
 * snapshot: server slot stats, input-mapper ages, haptic trace, renderer
 * counters and the canvas backing size. It also refreshes the raw input table
 * and the D5/D6 debug counters on the same 4 Hz timer the shell has always
 * used. Nothing here runs while `?debug=1` is absent except the cheap table
 * and counter refreshes.
 */
import type { SlotStats } from "@lanpad/protocol";
import { DebugOverlay, type OverlaySlotStats } from "../debug/Overlay.js";
import type { GameDebugCounters } from "../game/GameContext.js";
import type { InputMapper } from "../input/InputMapper.js";
import type { FrameStats } from "../loop/types.js";
import type { RendererBackend } from "../render/Renderer.js";
import type { HostCapabilities } from "./capabilities.js";

const SLOT_COUNT = 8;
const UPDATE_INTERVAL_MS = 250;

/** Runtime numbers the 4 Hz overlay paint reads from the stage. */
export interface OverlayRuntimeStats {
  readonly backend: RendererBackend | null;
  readonly drawCalls: number;
  readonly textureMemoryMB: number;
  readonly resolution: {
    readonly scale: number;
    readonly dpr: number;
    readonly width: number;
    readonly height: number;
  } | null;
}

export interface OverlayDeps {
  readonly doc: Document;
  readonly enabled: boolean;
  readonly debugCounters: GameDebugCounters;
  readonly capabilities: HostCapabilities;
  readonly mapper: InputMapper;
  readonly getServerStats: () => ReadonlyArray<SlotStats>;
  readonly getRuntime: () => OverlayRuntimeStats;
  /** Refreshes the debug input table's age column. */
  readonly renderTable: () => void;
}

export interface HostOverlay {
  recordFrame(stats: FrameStats): void;
  handleKey(key: string): void;
  /** One 4 Hz pass: table ages, D5/D6 counters, then the overlay paint. */
  tick(): void;
  /** Starts the shell's 4 Hz interval. Safe to call once. */
  start(): void;
}

export function createOverlay(deps: OverlayDeps): HostOverlay {
  const mount = deps.doc.createElement("div");
  deps.doc.body.append(mount);
  const overlay = new DebugOverlay({ mount, enabled: deps.enabled });

  function overlaySlots(): OverlaySlotStats[] {
    const bySlot = new Map<number, SlotStats>();
    for (const stats of deps.getServerStats()) {
      bySlot.set(stats.slot, stats);
    }
    const slots: OverlaySlotStats[] = [];
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
      const stats = deps.mapper.getStats(slot);
      const server = bySlot.get(slot);
      const state = deps.mapper.getSlot(slot);
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
    const events = deps.capabilities.events.counters;
    const layoutCounters = deps.capabilities.layouts.counters;
    const panelCounters = deps.capabilities.panels.counters;
    const hapticStats = deps.capabilities.haptics.stats;
    deps.debugCounters.setCounter("events.received", events.received);
    deps.debugCounters.setCounter("events.dropped", events.dropped);
    deps.debugCounters.setCounter("layouts.pendingAcks", layoutCounters.pendingAcks);
    deps.debugCounters.setCounter("layouts.staleAcks", layoutCounters.staleAcks);
    deps.debugCounters.setCounter("panels.storedBytes", panelCounters.storedBytes);
    deps.debugCounters.setCounter("haptics.sent", hapticStats.sent);
    deps.debugCounters.setCounter("haptics.dropped", hapticStats.dropped);
  }

  function tick(): void {
    deps.renderTable();
    updateDebugCounters();
    if (!overlay.visible) return;

    const runtime = deps.getRuntime();
    const haptic = deps.capabilities.getLastHaptic();
    overlay.update({
      backend: runtime.backend,
      drawCalls: runtime.drawCalls,
      textureMemoryMB: runtime.textureMemoryMB,
      jsHeapMB: null,
      visibleInstances: null,
      resolution: runtime.resolution,
      entities: null,
      gyroSmoothing: null,
      lastHaptic:
        haptic === null
          ? null
          : {
              target: haptic.target,
              steps: haptic.steps,
              ageMs: Math.max(0, performance.now() - haptic.atMs),
            },
      slots: overlaySlots(),
    });
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    recordFrame(stats) {
      overlay.recordFrame(stats);
    },

    handleKey(key) {
      overlay.handleKey(key);
    },

    tick,

    start() {
      if (timer !== null) return;
      timer = setInterval(tick, UPDATE_INTERVAL_MS);
    },
  };
}

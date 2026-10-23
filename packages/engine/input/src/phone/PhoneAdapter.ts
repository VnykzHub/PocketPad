/**
 * Phone bridge (10 §5.3).
 *
 * The runtime decodes protocol bytes and calls this adapter with normalized
 * samples. No protocol type, codec or byte layout is imported here.
 *
 * Tick handling is wrap-safe: levels apply when the packet is not older than
 * the last applied packet (`(new - old) >>> 0 < 0x80000000`, equal applies);
 * button edges are OR-accumulated regardless, because a press that occurred
 * before a newer packet must not be lost. Disconnect zeroes levels and edges
 * without synthesizing releases. The controller deadzone (8%) lives on the
 * phone and is never re-applied here.
 */

import type {
  ControllerView,
  PhoneInputAdapter,
  PhoneInputSample,
} from "../contracts/input.js";
import type { MutableControllerView } from "../InputFrame.js";
import { createControllerView } from "../InputFrame.js";

interface PhoneSlot {
  connected: boolean;
  hasTick: boolean;
  lastTick: number;
  pendingEdges: number;
  receivedAtMs: number;
  view: MutableControllerView;
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export class PhoneAdapterImpl implements PhoneInputAdapter {
  readonly slots: number;
  readonly views: MutableControllerView[] = [];
  readonly connected: Uint8Array;
  /** Set on connect/disconnect so the router can recompute assignment. */
  topologyDirty = false;
  invalidSamples = 0;

  private readonly state: PhoneSlot[] = [];

  constructor(slots: number) {
    this.slots = slots;
    this.connected = new Uint8Array(slots);
    for (let slot = 0; slot < slots; slot += 1) {
      const view = createControllerView(slot);
      view.slot = slot;
      this.views.push(view);
      this.state.push({
        connected: false,
        hasTick: false,
        lastTick: 0,
        pendingEdges: 0,
        receivedAtMs: 0,
        view,
      });
    }
  }

  private slotState(slot: number): PhoneSlot | undefined {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.slots) return undefined;
    return this.state[slot];
  }

  view(slot: number): MutableControllerView | undefined {
    return this.slotState(slot)?.view;
  }

  isConnected(slot: number): boolean {
    const state = this.slotState(slot);
    return state !== undefined && state.connected;
  }

  applyPhoneSample(slot: number, sample: PhoneInputSample, receivedAtMs: number): void {
    const state = this.slotState(slot);
    if (state === undefined || !Number.isInteger(sample.tick)) {
      this.invalidSamples += 1;
      return;
    }
    if (!sample.connected) {
      this.setPhoneConnected(slot, false);
      return;
    }
    const view = state.view;

    if (!state.connected) {
      state.connected = true;
      state.hasTick = false;
      state.pendingEdges = 0;
      view.connected = true;
      this.connected[slot] = 1;
      this.topologyDirty = true;
    }

    state.receivedAtMs = Number.isFinite(receivedAtMs) ? receivedAtMs : state.receivedAtMs;

    const diff = (sample.tick - state.lastTick) >>> 0;
    const applyLevels = !state.hasTick || diff < 0x80000000;

    // Edges always OR, including edges carried by a stale packet.
    state.pendingEdges |= sample.edges & 0xffff;

    if (applyLevels) {
      state.hasTick = true;
      state.lastTick = sample.tick;
      view.tick = sample.tick >>> 0;
      view.buttons = sample.buttons & 0xffff;
      view.lx = clampSigned(sample.lx);
      view.ly = clampSigned(sample.ly);
      view.rx = clampSigned(sample.rx);
      view.ry = clampSigned(sample.ry);
      view.gyro.x = Number.isFinite(sample.gyro.x) ? sample.gyro.x : 0;
      view.gyro.y = Number.isFinite(sample.gyro.y) ? sample.gyro.y : 0;
      view.gyro.z = Number.isFinite(sample.gyro.z) ? sample.gyro.z : 0;
      view.gyroActive = sample.gyroActive === true;
      view.gyroRecentered = sample.gyroRecentered === true;
      view.triggers.lt = clamp01(sample.triggers.lt);
      view.triggers.rt = clamp01(sample.triggers.rt);
    }
  }

  setPhoneConnected(slot: number, connected: boolean): void {
    const state = this.slotState(slot);
    if (state === undefined) return;
    if (state.connected === connected) return;
    state.connected = connected;
    this.connected[slot] = connected ? 1 : 0;
    this.topologyDirty = true;
    state.hasTick = false;
    state.pendingEdges = 0;
    const view = state.view;
    view.connected = connected;
    view.buttons = 0;
    view.edges = 0;
    view.lx = 0;
    view.ly = 0;
    view.rx = 0;
    view.ry = 0;
    view.gyro.x = 0;
    view.gyro.y = 0;
    view.gyro.z = 0;
    view.gyroActive = false;
    view.gyroRecentered = false;
    view.triggers.lt = 0;
    view.triggers.rt = 0;
    view.tick = 0;
    delete view.tilt;
  }

  setTilt(slot: number, tilt: ControllerView["tilt"]): void {
    const state = this.slotState(slot);
    if (state === undefined) return;
    const view = state.view;
    if (tilt === undefined) {
      delete view.tilt;
      return;
    }
    const existing =
      view.tilt !== undefined
        ? view.tilt
        : { angleX: 0, angleY: 0, available: false };
    existing.angleX = Number.isFinite(tilt.angleX) ? tilt.angleX : 0;
    existing.angleY = Number.isFinite(tilt.angleY) ? tilt.angleY : 0;
    existing.available = tilt.available === true;
    view.tilt = existing;
  }

  /** True when the pending press mask has `bit` set; used by action reads. */
  pendingPress(slot: number, bit: number): boolean {
    const state = this.slotState(slot);
    if (state === undefined || bit < 0 || bit > 15) return false;
    return ((state.pendingEdges >>> bit) & 1) === 1;
  }

  /** Publishes accumulated press edges into the pooled controller views. */
  publishEdges(): void {
    for (const state of this.state) {
      state.view.edges = state.pendingEdges;
      state.pendingEdges = 0;
    }
  }

  /** Fills `out` with connected slots ascending; no allocation. */
  connectedSlots(out: number[]): number[] {
    out.length = 0;
    for (let slot = 0; slot < this.slots; slot += 1) {
      if (this.connected[slot] === 1) out.push(slot);
    }
    return out;
  }

  /** Keeps connected phones but clears level/edge state for a fresh match. */
  reset(): void {
    for (const state of this.state) {
      state.hasTick = false;
      state.pendingEdges = 0;
      const view = state.view;
      view.buttons = 0;
      view.edges = 0;
      view.lx = 0;
      view.ly = 0;
      view.rx = 0;
      view.ry = 0;
      view.triggers.lt = 0;
      view.triggers.rt = 0;
      view.tick = 0;
      view.gyroActive = false;
      view.gyroRecentered = false;
    }
    this.topologyDirty = true;
  }
}

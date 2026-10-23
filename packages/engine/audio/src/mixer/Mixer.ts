/**
 * Mixer (spec 09 §3.4, §5.3).
 *
 * Stores the master and per-bus levels even before unlock, and applies them
 * to the graph once `AudioSystem` attaches one. Mute is separate from level:
 * `getBusVolume` returns the stored level, and a muted bus applies 0.
 * Explicit ramps use `linearRampToValueAtTime`; no per-frame allocation.
 */

import type { AudioBusName, AudioMixer } from "../contracts/audio.js";
import type { HostAudioParam } from "../host/types.js";
import { busIndex } from "./BusGraph.js";

export interface MixerGainHost {
  readonly gain: HostAudioParam;
}

export interface MixerHost {
  now(): number;
  masterGainNode(): MixerGainHost | null;
  busGainNode(index: number): MixerGainHost | null;
  /** True while the system mutes the master as a suspend fallback (09 §5.9). */
  masterMutedByHost(): boolean;
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function applyGain(
  param: HostAudioParam,
  target: number,
  now: number,
  rampMs: number,
): void {
  param.cancelScheduledValues(now);
  if (rampMs > 0) {
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + rampMs / 1000);
  } else {
    param.setValueAtTime(target, now);
  }
}

export class Mixer implements AudioMixer {
  private readonly host: MixerHost;
  private readonly busLevels: number[];
  private readonly busMutedFlags: boolean[];
  private masterValue: number;
  private mutedFlag = false;

  constructor(
    host: MixerHost,
    masterVolume: number,
    busVolumes: readonly number[],
  ) {
    this.host = host;
    this.masterValue = clamp01(masterVolume, 1);
    this.busLevels = [];
    this.busMutedFlags = [];
    for (let index = 0; index < busVolumes.length; index += 1) {
      this.busLevels.push(clamp01(busVolumes[index] ?? 1, 1));
      this.busMutedFlags.push(false);
    }
  }

  get masterVolume(): number {
    return this.masterValue;
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  setMasterVolume(volume: number, rampMs = 0): void {
    this.masterValue = clamp01(volume, this.masterValue);
    this.applyMaster(rampMs);
  }

  setBusVolume(bus: AudioBusName, volume: number, rampMs = 0): void {
    const index = busIndex(bus);
    if (index < 0) return;
    this.busLevels[index] = clamp01(volume, this.busLevels[index] ?? 1);
    this.applyBus(index, rampMs);
  }

  getBusVolume(bus: AudioBusName): number {
    const index = busIndex(bus);
    if (index < 0) return 0;
    return this.busLevels[index] ?? 0;
  }

  setBusMuted(bus: AudioBusName, muted: boolean): void {
    const index = busIndex(bus);
    if (index < 0) return;
    this.busMutedFlags[index] = muted;
    this.applyBus(index, 0);
  }

  setMuted(muted: boolean): void {
    this.mutedFlag = muted;
    this.applyMaster(0);
  }

  /** Internal: whether a bus is muted, for tests and diagnostics. */
  busMuted(bus: AudioBusName): boolean {
    const index = busIndex(bus);
    return index >= 0 && (this.busMutedFlags[index] ?? false);
  }

  /** Applied by `AudioSystem` when the context and graph exist. */
  applyAll(): void {
    this.applyMaster(0);
    for (let index = 0; index < this.busLevels.length; index += 1) {
      this.applyBus(index, 0);
    }
  }

  /** Re-apply the master only (suspend fallback / resume). */
  reapplyMaster(rampMs = 0): void {
    this.applyMaster(rampMs);
  }

  private applyMaster(rampMs: number): void {
    const node = this.host.masterGainNode();
    if (node === null) return;
    const effectiveMuted = this.mutedFlag || this.host.masterMutedByHost();
    applyGain(node.gain, effectiveMuted ? 0 : this.masterValue, this.host.now(), rampMs);
  }

  private applyBus(index: number, rampMs: number): void {
    const node = this.host.busGainNode(index);
    if (node === null) return;
    const muted = this.busMutedFlags[index] ?? false;
    applyGain(node.gain, muted ? 0 : (this.busLevels[index] ?? 1), this.host.now(), rampMs);
  }
}

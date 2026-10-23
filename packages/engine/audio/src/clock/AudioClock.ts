/**
 * Audio clock (spec 09 §3.2, §5.7).
 *
 * `now` is `AudioContext.currentTime` and is exactly 0 while locked or
 * unavailable. It advances only while the context is running, is monotonic
 * within a session, and is the only time source for music, rhythm and fades
 * (SPEC C8). `performance.now()` is a diagnostic bridge only: it is never
 * used inside `simulate` or to drive scheduling.
 */

import type { AudioClock } from "../contracts/audio.js";
import type { HostAudioContext } from "../host/types.js";

export interface AudioClockHost {
  context(): HostAudioContext | null;
  unlocked(): boolean;
}

function defaultPerformanceNow(): number {
  const perf = (globalThis as unknown as { performance?: { now?: () => number } })
    .performance;
  if (perf !== undefined && typeof perf.now === "function") {
    return perf.now();
  }
  return Date.now();
}

export class EngineAudioClock implements AudioClock {
  private readonly host: AudioClockHost;
  private readonly performanceNow: () => number;
  private lastNow = 0;

  constructor(host: AudioClockHost, performanceNow?: () => number) {
    this.host = host;
    this.performanceNow = performanceNow ?? defaultPerformanceNow;
  }

  /** `AudioContext.currentTime`, clamped monotonic; 0 before unlock. */
  get now(): number {
    const context = this.host.context();
    if (context === null || !this.host.unlocked()) return 0;
    const current = context.currentTime;
    if (!Number.isFinite(current) || current < 0) return this.lastNow;
    if (current < this.lastNow) return this.lastNow;
    this.lastNow = current;
    return current;
  }

  get running(): boolean {
    const context = this.host.context();
    return (
      context !== null && this.host.unlocked() && context.state === "running"
    );
  }

  get baseLatency(): number {
    const context = this.readContext();
    if (context === null) return 0;
    const value = context.baseLatency;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : 0;
  }

  /** `outputLatency`, else `baseLatency`, else 0. */
  get outputLatency(): number {
    const context = this.readContext();
    if (context === null) return 0;
    const value = context.outputLatency;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
    return this.baseLatency;
  }

  /** Context time for a `performance.now()` timestamp, clamped to [0, now]. */
  performanceToAudio(perfMs: number): number {
    const now = this.now;
    if (!Number.isFinite(perfMs)) return now;
    const value = now - (this.performanceNow() - perfMs) / 1000;
    if (value < 0) return 0;
    if (value > now) return now;
    return value;
  }

  /** `performance.now()` estimate for a context time, clamped to now. */
  audioToPerformance(audioSeconds: number): number {
    const now = this.now;
    const target =
      !Number.isFinite(audioSeconds) || audioSeconds < 0
        ? 0
        : audioSeconds > now
          ? now
          : audioSeconds;
    return this.performanceNow() - (now - target) * 1000;
  }

  private readContext(): HostAudioContext | null {
    if (!this.host.unlocked()) return null;
    return this.host.context();
  }
}

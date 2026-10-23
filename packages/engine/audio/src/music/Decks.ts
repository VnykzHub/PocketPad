/**
 * Two music decks (spec 09 §5.6).
 *
 * Deck A and deck B each own a gain into the music bus, plus either a
 * per-play `AudioBufferSourceNode` (decoded tracks) or one media element and
 * its `MediaElementAudioSourceNode` (streams). Two decks make crossfades and
 * gapless station changes possible without a second context.
 *
 * When `MediaElementAudioSourceNode` is unavailable the element plays
 * directly and `element.volume` carries the level (09 §5.9); ramps and the
 * master/bus mute may not apply in that mode, as documented.
 *
 * Buffer tracks and stream tracks never run together on one deck.
 */

import type { AudioBufferLike, AudioMediaElementLike } from "../contracts/audio.js";
import type {
  HostAudioContext,
  HostBufferSourceNode,
  HostGainNode,
  HostMediaElementSourceNode,
} from "../host/types.js";

export interface BufferTrack {
  readonly kind: "buffer";
  readonly buffer: AudioBufferLike;
}

export interface StreamTrack {
  readonly kind: "stream";
  readonly url: string;
}

export type ResolvedTrack = BufferTrack | StreamTrack;

/** Points in the equal-power curves; constant so a tune allocates one array. */
export const CROSSFADE_CURVE_POINTS = 64;

export class Deck {
  readonly id: "a" | "b";
  gain: HostGainNode | null = null;
  bufferSource: HostBufferSourceNode | null = null;
  element: AudioMediaElementLike | null = null;
  elementSource: HostMediaElementSourceNode | null = null;
  assetId: string | null = null;
  volume = 1;
  loop = false;
  /** Context time at which the deck should be silenced, 0 when unscheduled. */
  stopAt = 0;
  /** URL already loaded into `element` by `DeckPair.preload`, else null. */
  prefetchedUrl: string | null = null;
  private endedFlag = false;
  private readonly handleBufferEnded: () => void;

  constructor(id: "a" | "b") {
    this.id = id;
    this.handleBufferEnded = () => {
      this.bufferSource = null;
      this.endedFlag = true;
    };
  }

  /** A buffer source is live, a scheduled fade is still running, or an element is playing. */
  isPlaying(): boolean {
    if (this.stopAt > 0) return true;
    if (this.bufferSource !== null) return true;
    const element = this.element;
    return element !== null && !element.paused && !element.ended;
  }

  /** The current track finished (buffer `onended` or the element's `ended`). */
  isEnded(): boolean {
    if (this.endedFlag) return true;
    const element = this.element;
    return element !== null && element.ended;
  }

  /** Element-backed playback present (drives `stats.streaming`). */
  get isStreaming(): boolean {
    return this.element !== null;
  }

  /** Direct-element fallback: no MediaElementAudioSourceNode in the graph. */
  get isDirect(): boolean {
    return this.element !== null && this.elementSource === null;
  }

  resetEnded(): void {
    this.endedFlag = false;
  }

  markEnded(): void {
    this.endedFlag = true;
  }

  /** Bind this deck's preallocated `onended` to a buffer source. */
  bindEnded(source: HostBufferSourceNode): void {
    source.onended = this.handleBufferEnded;
  }
}

function clampCurveValue(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Fill `out` with `sin(t·π/2)` scaled by `peak` (equal-power fade-in). */
export function fillFadeInCurve(out: Float32Array, peak: number): void {
  const last = out.length - 1;
  for (let index = 0; index <= last; index += 1) {
    const t = last === 0 ? 1 : index / last;
    out[index] = clampCurveValue(peak * Math.sin((t * Math.PI) / 2));
  }
}

/** Fill `out` with `cos(t·π/2)` scaled by `peak` (equal-power fade-out). */
export function fillFadeOutCurve(out: Float32Array, peak: number): void {
  const last = out.length - 1;
  for (let index = 0; index <= last; index += 1) {
    const t = last === 0 ? 1 : index / last;
    out[index] = clampCurveValue(peak * Math.cos((t * Math.PI) / 2));
  }
}

export class DeckPair {
  readonly a = new Deck("a");
  readonly b = new Deck("b");

  private readonly createMediaElement: (() => AudioMediaElementLike) | null;
  private readonly onStreamFailure: () => void;
  private host: HostAudioContext | null = null;
  private mediaRouted = true;

  constructor(
    createMediaElement: (() => AudioMediaElementLike) | null,
    onStreamFailure: () => void,
  ) {
    this.createMediaElement = createMediaElement;
    this.onStreamFailure = onStreamFailure;
  }

  get attached(): boolean {
    return this.host !== null;
  }

  /** True when media elements can be routed into the graph. */
  get canRouteStreams(): boolean {
    const host = this.host;
    return (
      this.createMediaElement !== null &&
      this.mediaRouted &&
      host !== null &&
      host.createMediaElementSource !== undefined
    );
  }

  attach(host: HostAudioContext, busGain: HostGainNode): void {
    this.host = host;
    this.a.gain = host.createGain();
    this.a.gain.gain.value = 0;
    this.a.gain.connect(busGain);
    this.b.gain = host.createGain();
    this.b.gain.gain.value = 0;
    this.b.gain.connect(busGain);
  }

  /** A deck that is not currently sounding; A wins ties. */
  idle(): Deck {
    return this.a.isPlaying() ? this.b : this.a;
  }

  /**
   * Load the next station track into the idle deck, muted and paused, so a
   * transition does not wait for a network round trip (09 §5.6).
   */
  preload(url: string): boolean {
    const factory = this.createMediaElement;
    const host = this.host;
    if (factory === null || host === null) return false;
    if (!this.mediaRouted || host.createMediaElementSource === undefined) {
      return false;
    }
    const deck = this.idle();
    if (deck.element !== null && deck.prefetchedUrl === url) return true;
    const element = factory();
    element.src = url;
    element.preload = "auto";
    element.muted = true;
    element.volume = 0;
    deck.element = element;
    deck.elementSource = null;
    deck.prefetchedUrl = url;
    return true;
  }

  /** The sounding deck, or null. */
  active(): Deck | null {
    if (this.a.isPlaying()) return this.a;
    if (this.b.isPlaying()) return this.b;
    return null;
  }

  anyPlaying(): boolean {
    return this.a.isPlaying() || this.b.isPlaying();
  }

  anyStreaming(): boolean {
    return (
      (this.a.isStreaming && this.a.isPlaying()) ||
      (this.b.isStreaming && this.b.isPlaying())
    );
  }

  /**
   * Start a track on `deck`.
   *
   * `fadeMs` of 0 sets the level at `when`; otherwise the deck ramps from 0 to
   * `volume` across `[when, when + fadeMs]`. `equalPower` selects the equal-power
   * sin curve (radio); plain music uses a linear ramp (09 §3.4, §5.6).
   */
  start(
    deck: Deck,
    track: ResolvedTrack,
    when: number,
    volume: number,
    loop: boolean,
    fadeMs: number,
    equalPower: boolean,
  ): boolean {
    const host = this.host;
    const gain = deck.gain;
    if (host === null || gain === null) return false;

    this.stopDeckSources(deck);
    deck.assetId = null;
    deck.stopAt = 0;
    deck.resetEnded();

    const fade = fadeMs > 0 ? fadeMs / 1000 : 0;
    const level = volume < 0 ? 0 : volume > 1 ? 1 : volume;

    if (track.kind === "buffer") {
      const source = host.createBufferSource();
      source.buffer = track.buffer;
      source.loop = loop;
      deck.bindEnded(source);
      source.connect(gain);
      deck.bufferSource = source;
      deck.element = null;
      deck.elementSource = null;
      deck.loop = loop;
      deck.volume = level;

      const param = gain.gain;
      param.cancelScheduledValues(when);
      if (fade > 0) {
        param.setValueAtTime(0, when);
        if (equalPower && param.setValueCurveAtTime !== undefined) {
          const curve = new Float32Array(CROSSFADE_CURVE_POINTS);
          fillFadeInCurve(curve, level);
          param.setValueCurveAtTime(curve, when, fade);
        } else {
          param.linearRampToValueAtTime(level, when + fade);
        }
      } else {
        param.setValueAtTime(level, when);
      }
      try {
        source.start(when);
      } catch {
        deck.bufferSource = null;
        return false;
      }
      return true;
    }

    let element = deck.element;
    const factory = this.createMediaElement;
    if (element === null || deck.prefetchedUrl !== track.url) {
      if (factory === null) {
        this.onStreamFailure();
        return false;
      }
      const created = factory();
      created.src = track.url;
      created.preload = "auto";
      deck.element = created;
      deck.elementSource = null;
      element = created;
    }
    if (element === null) return false;
    element.muted = false;
    deck.prefetchedUrl = null;

    let routed = false;
    if (this.mediaRouted && host.createMediaElementSource !== undefined) {
      try {
        const node = host.createMediaElementSource(element);
        node.connect(gain);
        deck.elementSource = node;
        routed = true;
      } catch {
        this.mediaRouted = false;
      }
    }
    if (!routed) this.mediaRouted = false;

    element.volume = routed ? 1 : level;

    const param = gain.gain;
    param.cancelScheduledValues(when);
    if (!routed) {
      // No graph routing: the element carries the level and cannot be ramped
      // on the audio clock. Hold the deck gain open (09 §5.9).
      param.setValueAtTime(1, when);
    } else if (fade > 0) {
      param.setValueAtTime(0, when);
      if (equalPower && param.setValueCurveAtTime !== undefined) {
        const curve = new Float32Array(CROSSFADE_CURVE_POINTS);
        fillFadeInCurve(curve, level);
        param.setValueCurveAtTime(curve, when, fade);
      } else {
        param.linearRampToValueAtTime(level, when + fade);
      }
    } else {
      param.setValueAtTime(level, when);
    }

    deck.bufferSource = null;
    deck.loop = loop;
    deck.volume = level;

    const attempt = element.play();
    if (attempt !== undefined && typeof attempt.catch === "function") {
      attempt.catch(() => {
        this.onStreamFailure();
        deck.markEnded();
      });
    }
    return true;
  }

  /**
   * Ramp a deck to silence and schedule its stop. Returns the context time at
   * which it is silent.
   */
  fadeOut(deck: Deck, now: number, fadeMs: number, equalPower: boolean): number {
    const gain = deck.gain;
    const fade = fadeMs > 0 ? fadeMs / 1000 : 0;
    const end = now + fade;

    if (gain !== null) {
      const param = gain.gain;
      param.cancelScheduledValues(now);
      if (fade > 0) {
        const from = param.value;
        param.setValueAtTime(from, now);
        if (equalPower && param.setValueCurveAtTime !== undefined) {
          const curve = new Float32Array(CROSSFADE_CURVE_POINTS);
          fillFadeOutCurve(curve, from);
          param.setValueCurveAtTime(curve, now, fade);
        } else {
          param.linearRampToValueAtTime(0, end);
        }
      } else {
        param.setValueAtTime(0, now);
      }
    }

    if (deck.bufferSource !== null) {
      try {
        deck.bufferSource.stop(end);
      } catch {
        // The source already ended.
      }
      deck.bufferSource = null;
    }
    deck.assetId = null;
    deck.stopAt = fade > 0 ? end : 0;
    if (fade === 0) this.hardStop(deck);
    return end;
  }

  /** Pause element decks whose scheduled stop has elapsed (allocation-free). */
  update(now: number): void {
    if (this.a.stopAt > 0 && now >= this.a.stopAt) {
      this.a.stopAt = 0;
      this.hardStop(this.a);
    }
    if (this.b.stopAt > 0 && now >= this.b.stopAt) {
      this.b.stopAt = 0;
      this.hardStop(this.b);
    }
  }

  stopNow(deck: Deck): void {
    this.stopDeckSources(deck);
    if (deck.gain !== null) {
      deck.gain.gain.cancelScheduledValues(0);
      deck.gain.gain.setValueAtTime(0, 0);
    }
    this.hardStop(deck);
  }

  dispose(): void {
    this.stopDeckSources(this.a);
    this.stopDeckSources(this.b);
    this.host = null;
    this.a.gain = null;
    this.b.gain = null;
  }

  private hardStop(deck: Deck): void {
    const element = deck.element;
    if (element !== null) {
      try {
        element.pause();
      } catch {
        // The element already stopped.
      }
    }
    deck.element = null;
    deck.elementSource = null;
    deck.prefetchedUrl = null;
    deck.assetId = null;
    deck.stopAt = 0;
    deck.markEnded();
  }

  private stopDeckSources(deck: Deck): void {
    const source = deck.bufferSource;
    if (source !== null) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // The source already ended.
      }
      deck.bufferSource = null;
    }
    const element = deck.element;
    if (element !== null) {
      try {
        element.pause();
      } catch {
        // The element already stopped.
      }
    }
  }
}

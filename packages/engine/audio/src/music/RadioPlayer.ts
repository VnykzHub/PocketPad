/**
 * Radio playlist and two-deck crossfade (spec 09 §5.6).
 *
 * `tuneRadio` starts the station's current track on the idle deck and
 * crossfades equal-power over `fadeMs` (default 1500 ms, fixture
 * `radio-default-crossfade`: 10 → 11.5). Track advance happens on `ended`,
 * polled from `update` because the frozen media-element seam has no event
 * target; the idle deck preloads the next stream so a station transition does
 * not wait on the network. An unknown station id is a counted no-op, never a
 * throw (09 §4.3).
 */

import type { RadioOptions, RadioStation } from "../contracts/audio.js";
import { clampMs } from "../schedule.js";
import {
  AUDIO_DEFAULT_RADIO_CROSSFADE_MS,
  AUDIO_MAX_RADIO_CROSSFADE_MS,
} from "../version.js";
import type { Deck, DeckPair } from "./Decks.js";
import type { TrackResolver } from "./MusicPlayer.js";

export class RadioPlayer {
  private readonly stations = new Map<string, RadioStation>();
  private readonly decks: DeckPair;
  private readonly resolve: TrackResolver;
  private readonly now: () => number;
  private readonly onFailure: () => void;
  private current: RadioStation | null = null;
  private activeDeck: Deck | null = null;
  private trackIndex = 0;
  private loop = true;
  private misses = 0;
  private prefetched: string | null = null;

  constructor(
    decks: DeckPair,
    resolve: TrackResolver,
    now: () => number,
    onFailure: () => void,
  ) {
    this.decks = decks;
    this.resolve = resolve;
    this.now = now;
    this.onFailure = onFailure;
  }

  get stationId(): string | null {
    return this.current === null ? null : this.current.id;
  }

  /** Tunes that named an unknown station or arrived before unlock. */
  get unknownTunings(): number {
    return this.misses;
  }

  get stationCount(): number {
    return this.stations.size;
  }

  get trackNumber(): number {
    return this.trackIndex;
  }

  register(station: RadioStation): void {
    this.stations.set(station.id, station);
  }

  /** Returns false for an unknown id (counted) or an unattached deck pair. */
  tune(stationId: string, opts?: RadioOptions): boolean {
    const station = this.stations.get(stationId);
    if (station === undefined || !this.decks.attached) {
      this.misses += 1;
      return false;
    }
    const fadeMs = clampMs(
      opts?.fadeMs,
      AUDIO_DEFAULT_RADIO_CROSSFADE_MS,
      AUDIO_MAX_RADIO_CROSSFADE_MS,
    );
    this.current = station;
    this.trackIndex = 0;
    this.loop = opts?.loop ?? station.loop;
    this.prefetched = null;
    return this.startTrack(fadeMs);
  }

  /**
   * Called once per tick: advances a finished track and preloads the next.
   * Allocation-free; starts no source.
   */
  update(): void {
    const station = this.current;
    if (station === null) return;
    const deck = this.activeDeck;
    if (deck !== null && deck.isEnded()) {
      this.advance();
      return;
    }
    this.prefetch();
  }

  stop(fadeMs = 0): void {
    const deck = this.activeDeck;
    this.current = null;
    this.activeDeck = null;
    this.prefetched = null;
    if (deck === null) return;
    this.decks.fadeOut(
      deck,
      this.now(),
      clampMs(fadeMs, 0, AUDIO_MAX_RADIO_CROSSFADE_MS),
      true,
    );
  }

  stopNow(): void {
    this.stop(0);
  }

  clear(): void {
    this.stations.clear();
    this.current = null;
    this.activeDeck = null;
    this.prefetched = null;
    this.trackIndex = 0;
  }

  dispose(): void {
    this.current = null;
    this.activeDeck = null;
    this.prefetched = null;
  }

  private advance(): void {
    const station = this.current;
    if (station === null) return;
    const count = station.tracks.length;
    if (count === 0) {
      this.stop(0);
      return;
    }
    const next = this.trackIndex + 1;
    if (next >= count && !this.loop) {
      this.stop(0);
      return;
    }
    this.trackIndex = next % count;
    this.startTrack(0);
  }

  private startTrack(fadeMs: number): boolean {
    const station = this.current;
    if (station === null) return false;
    const assetId = station.tracks[this.trackIndex];
    if (assetId === undefined) {
      this.onFailure();
      this.stop(0);
      return false;
    }
    const track = this.resolve(assetId);
    if (track === null) {
      this.onFailure();
      this.stop(0);
      return false;
    }

    const now = this.now();
    const old = this.decks.active();
    if (old !== null) this.decks.fadeOut(old, now, fadeMs, true);

    const deck = this.decks.idle();
    if (!this.decks.start(deck, track, now, 1, this.loop, fadeMs, true)) {
      this.activeDeck = null;
      return false;
    }
    this.activeDeck = deck;
    this.prefetched = null;
    return true;
  }

  private prefetch(): void {
    const station = this.current;
    if (station === null) return;
    const count = station.tracks.length;
    if (count < 2) return;
    const nextIndex = (this.trackIndex + 1) % count;
    const assetId = station.tracks[nextIndex];
    if (assetId === undefined || assetId === this.prefetched) return;
    const track = this.resolve(assetId);
    if (track === null || track.kind !== "stream") return;
    if (this.decks.preload(track.url)) this.prefetched = assetId;
  }
}

/**
 * Music deck A/B driver (spec 09 §5.6).
 *
 * `playMusic` replaces the current track: the old deck fades out, the idle
 * deck starts the new track, and both ramps are scheduled on the audio clock
 * (never `setTimeout`). A faded start anchors at `now + 0.02 s` so the linear
 * ramp has a stable origin (09 §5.7, fixtures `music-faded-start-anchor` and
 * `music-unfaded-start`). No per-call allocation beyond the deck's own nodes.
 */

import type { MusicOptions } from "../contracts/audio.js";
import { clamp01, clampMs, oneShotStartTime } from "../schedule.js";
import {
  AUDIO_MAX_MUSIC_FADE_MS,
  AUDIO_MUSIC_FADE_ANCHOR_SECONDS,
} from "../version.js";
import type { DeckPair, ResolvedTrack } from "./Decks.js";

/** Resolve an asset id to decoded bytes or a same-origin stream URL. */
export type TrackResolver = (assetId: string) => ResolvedTrack | null;

export class MusicPlayer {
  private readonly decks: DeckPair;
  private readonly resolve: TrackResolver;
  private readonly now: () => number;
  private readonly onFailure: () => void;
  private current: string | null = null;

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

  get playing(): boolean {
    return this.current !== null && this.decks.anyPlaying();
  }

  get assetId(): string | null {
    return this.current;
  }

  play(assetId: string, opts?: MusicOptions): void {
    if (!this.decks.attached) return;
    const track = this.resolve(assetId);
    if (track === null) {
      this.onFailure();
      return;
    }

    const now = this.now();
    const fadeMs = clampMs(opts?.fadeMs, 0, AUDIO_MAX_MUSIC_FADE_MS);
    const volume = clamp01(opts?.volume, 1);
    const loop = opts?.loop ?? true;
    const requestedAt = opts?.startAt;
    const when =
      requestedAt !== undefined && Number.isFinite(requestedAt)
        ? oneShotStartTime(now, requestedAt)
        : fadeMs > 0
          ? now + AUDIO_MUSIC_FADE_ANCHOR_SECONDS
          : now;

    const old = this.decks.active();
    if (old !== null) this.decks.fadeOut(old, now, fadeMs, false);

    const deck = this.decks.idle();
    if (!this.decks.start(deck, track, when, volume, loop, fadeMs, false)) {
      return;
    }
    this.current = assetId;
  }

  /** Fade the current track out; `fadeMs` 0 is an immediate stop. */
  stop(fadeMs = 0): void {
    const deck = this.decks.active();
    this.current = null;
    if (deck === null) return;
    this.decks.fadeOut(
      deck,
      this.now(),
      clampMs(fadeMs, 0, AUDIO_MAX_MUSIC_FADE_MS),
      false,
    );
  }

  stopNow(): void {
    this.stop(0);
  }

  dispose(): void {
    this.current = null;
  }
}

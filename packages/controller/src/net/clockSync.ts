/**
 * Controller clock synchronisation (D2-CTRL-03; FR-7.10, A3, SPEC §7.3).
 *
 * The server echoes the controller's `clientTimeMs` in every Pong. From one
 * round trip the controller derives
 *
 *   rtt    = receivedAt - clientTime
 *   offset = serverTime - (clientTime + rtt / 2)
 *
 * Network jitter skews the offset, so the best estimate is the sample with the
 * smallest RTT: a short round trip is the least ambiguous one. Samples live in
 * a 30 s window and samples whose RTT exceeds twice the window minimum are
 * discarded (SPEC §7.3). When the best sample ages out, the offset falls back
 * to the next retained sample. If the whole window empties after a successful
 * sync, the last offset is held over (clock drift over seconds is negligible);
 * `serverNow()` only reports 0 before the first accepted sample, so a synced
 * tick never regresses to zero.
 *
 * All timestamps must come from one monotonic clock (`performance.now()` in
 * the browser): `clientTimeMs` is the value the controller put in the Ping,
 * and `receivedAtMs` is the same clock read when the Pong arrived. D2-CTRL-04
 * wires the Ping/Pong path. `serverNow()` stamps the Input `tick` (A3).
 */

/** Samples older than this are dropped (SPEC §7.3). */
export const CLOCK_SAMPLE_WINDOW_MS = 30_000;

/** Samples with an RTT above this multiple of the window minimum are discarded. */
export const MAX_RTT_MULTIPLIER = 2;

/** Ping cadence from the controller (SPEC §7.3). Exposed for D2-CTRL-04. */
export const CLOCK_PING_INTERVAL_MS = 5_000;

/** One accepted Pong round trip. */
interface ClockSample {
  rttMs: number;
  offsetMs: number;
  receivedAtMs: number;
}

export class ClockSync {
  private readonly sampleList: ClockSample[] = [];
  private currentOffsetMs = 0;
  private currentRttMs = Number.POSITIVE_INFINITY;
  private hasEstimate = false;

  /** Current server-minus-client offset estimate in milliseconds. */
  get offsetMs(): number {
    return this.currentOffsetMs;
  }

  /** RTT of the sample selected for the offset; `Infinity` before any sample. */
  get rttMs(): number {
    return this.currentRttMs;
  }

  /** Number of samples retained in the 30 s window. */
  get samples(): number {
    return this.sampleList.length;
  }

  /**
   * Feeds one Pong. Invalid samples (non-finite fields or a receive time
   * earlier than the echoed send time, which means mismatched clocks) are
   * ignored rather than allowed to poison the offset.
   */
  onPong(clientTimeMs: number, serverTimeMs: number, receivedAtMs: number): void {
    if (
      !Number.isFinite(clientTimeMs) ||
      !Number.isFinite(serverTimeMs) ||
      !Number.isFinite(receivedAtMs)
    ) {
      return;
    }
    const rttMs = receivedAtMs - clientTimeMs;
    if (rttMs < 0) {
      return;
    }

    this.sampleList.push({
      rttMs,
      offsetMs: serverTimeMs - (clientTimeMs + rttMs / 2),
      receivedAtMs,
    });
    this.prune(receivedAtMs);
    this.selectBest();
  }

  /**
   * Best estimate of server time for a client-clock reading (A3). Returns 0
   * until at least one Pong has been accepted, so an early packet carries tick
   * 0 rather than a fake timestamp. After the first sync the last offset is
   * held over if the window empties.
   *
   * Ages the sample window as a side effect: the estimate never uses a sample
   * older than 30 s, even if no new Pong has arrived.
   */
  serverNow(clientNowMs: number): number {
    if (!Number.isFinite(clientNowMs)) {
      return 0;
    }
    this.prune(clientNowMs);
    this.selectBest();
    if (!this.hasEstimate) {
      return 0;
    }
    return clientNowMs + this.currentOffsetMs;
  }

  /** Drops samples older than the window relative to `nowMs`. */
  private prune(nowMs: number): void {
    const cutoff = nowMs - CLOCK_SAMPLE_WINDOW_MS;
    let kept = 0;
    for (let index = 0; index < this.sampleList.length; index += 1) {
      const sample = this.sampleList[index];
      if (sample !== undefined && sample.receivedAtMs >= cutoff) {
        this.sampleList[kept] = sample;
        kept += 1;
      }
    }
    this.sampleList.length = kept;
  }

  /**
   * Picks the minimum-RTT sample as the offset. First finds the window
   * minimum, then drops samples slower than `MAX_RTT_MULTIPLIER` times it, so
   * one asymmetric spike cannot remain the reference once a clean sample
   * exists.
   */
  private selectBest(): void {
    if (this.sampleList.length === 0) {
      // Keep the last offset (holdover); rtt is unknown without a sample.
      this.currentRttMs = Number.POSITIVE_INFINITY;
      return;
    }

    let minimumRtt = Number.POSITIVE_INFINITY;
    for (const sample of this.sampleList) {
      if (sample.rttMs < minimumRtt) {
        minimumRtt = sample.rttMs;
      }
    }

    const limit = minimumRtt * MAX_RTT_MULTIPLIER;
    let kept = 0;
    for (let index = 0; index < this.sampleList.length; index += 1) {
      const sample = this.sampleList[index];
      if (sample !== undefined && sample.rttMs <= limit) {
        this.sampleList[kept] = sample;
        kept += 1;
      }
    }
    this.sampleList.length = kept;

    let best: ClockSample | undefined = this.sampleList[0];
    for (const sample of this.sampleList) {
      if (sample.rttMs < (best?.rttMs ?? Number.POSITIVE_INFINITY)) {
        best = sample;
      }
    }
    if (best !== undefined) {
      this.currentOffsetMs = best.offsetMs;
      this.currentRttMs = best.rttMs;
      this.hasEstimate = true;
    }
  }
}

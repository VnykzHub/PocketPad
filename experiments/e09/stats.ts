/**
 * E4 / E9 / E15 / G1 statistics for the D4-EXP-01 probe page.
 *
 * Everything in this file is pure: no DOM, no sockets, no clocks. The page and
 * `probe.ts` collect raw timestamps; these helpers turn them into the numbers
 * recorded in `docs/RESULTS.md`, so the Node tests can pin every formula.
 *
 * Clock conventions used by the callers:
 * - "monotonic" values come from `performance.now()` (ms since navigation).
 * - "client clock" values are `performance.timeOrigin + performance.now()`, a
 *   Date-compatible millisecond clock with sub-ms resolution.
 * - "server" values are the dev server's `Date.now()` truncated to u32 by the
 *   Pong frame (amendment A3), so they are integer milliseconds.
 */

/** E4 pass threshold: RTT p95 under 8 ms on 5 GHz (SPEC §20 E4). */
export const E4_P95_LIMIT_MS = 8;
/** E9 pass threshold: timestamp error under 5 ms (SPEC §20 E9). */
export const E9_ERROR_LIMIT_MS = 5;
/** E15 pass threshold: recovery under 1 s (SPEC §20 E15). */
export const E15_RECOVERY_LIMIT_MS = 1000;
/** E15/FR-5.4 controller reservation window. */
export const RESERVATION_MS = 30_000;
/** G1 pass threshold: scan-to-playable median under 5 s. */
export const G1_PASS_MS = 5000;
/** G1 hard-fail threshold. */
export const G1_HARD_FAIL_MS = 10_000;
/**
 * The server stamps Pong with integer `Date.now()`, which floors. The true
 * server instant is uniformly spread over [serverMs, serverMs + 1), so the
 * unbiased estimate adds half a millisecond.
 */
export const SERVER_TIME_QUANTIZATION_MS = 0.5;

const U32 = 0x1_0000_0000;
const HALF_U32 = 0x8000_0000;

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Linear-interpolated percentile (the "type 7" definition used by numpy and
 * spreadsheets). `p` is 0..100. Returns null for an empty input.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile ${p} is outside 0..100`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (rank - lower);
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * Jitter as the mean absolute difference between consecutive RTT samples, in
 * arrival order. This is the unsmoothed form of the broker's per-slot EWMA of
 * |rtt - previousRtt|, so a single number is comparable across runs.
 */
export function meanAbsoluteDelta(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  let sum = 0;
  for (let index = 1; index < values.length; index += 1) {
    sum += Math.abs((values[index] as number) - (values[index - 1] as number));
  }
  return sum / (values.length - 1);
}

function maybeRound(value: number | null): number | null {
  return value === null ? null : round(value);
}

/* ------------------------------------------------------------------ */
/* E4 — RTT, jitter, loss                                              */
/* ------------------------------------------------------------------ */

export interface RttSeries {
  /** Pings sent on this socket. */
  sent: number;
  /** RTT of every Pong received, in arrival order. */
  rttMs: readonly number[];
}

export interface RttSummary {
  sockets: number;
  sent: number;
  received: number;
  lost: number;
  lossPct: number;
  minMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
  /** Mean |Δrtt| within each socket, pooled over sockets by pair count. */
  jitterMs: number | null;
  /** Loss per socket, so one bad socket among eight is visible (G4). */
  perSocketLost: number[];
}

/**
 * Summarises one or more ping series. Jitter is computed inside each socket
 * (consecutive samples on different sockets are not a meaningful pair) and
 * pooled by pair count; percentiles pool every sample.
 */
export function summarizeRtt(series: readonly RttSeries[]): RttSummary {
  const all: number[] = [];
  let sent = 0;
  let jitterSum = 0;
  let jitterPairs = 0;
  const perSocketLost: number[] = [];
  for (const socket of series) {
    if (socket.rttMs.length > socket.sent) {
      throw new RangeError(`received ${socket.rttMs.length} Pongs for ${socket.sent} Pings`);
    }
    sent += socket.sent;
    all.push(...socket.rttMs);
    perSocketLost.push(socket.sent - socket.rttMs.length);
    const jitter = meanAbsoluteDelta(socket.rttMs);
    if (jitter !== null) {
      jitterSum += jitter * (socket.rttMs.length - 1);
      jitterPairs += socket.rttMs.length - 1;
    }
  }
  const lost = sent - all.length;
  return {
    sockets: series.length,
    sent,
    received: all.length,
    lost,
    lossPct: sent === 0 ? 0 : round((lost / sent) * 100),
    minMs: maybeRound(all.length === 0 ? null : Math.min(...all)),
    p50Ms: maybeRound(percentile(all, 50)),
    p95Ms: maybeRound(percentile(all, 95)),
    maxMs: maybeRound(all.length === 0 ? null : Math.max(...all)),
    meanMs: maybeRound(mean(all)),
    jitterMs: jitterPairs === 0 ? null : round(jitterSum / jitterPairs),
    perSocketLost,
  };
}

/** E4 verdict on RTT p95 with no loss; only meaningful for a phone↔TV 5 GHz run. */
export function e4Passes(summary: RttSummary): boolean {
  return summary.p95Ms !== null && summary.p95Ms < E4_P95_LIMIT_MS && summary.lost === 0;
}

/* ------------------------------------------------------------------ */
/* E9 — clock offset estimation and fairness                           */
/* ------------------------------------------------------------------ */

/**
 * Expands a u32 millisecond timestamp to the full value closest to
 * `reference` (also in ms). Handles the ~49.7-day wrap in both directions.
 */
export function unwrapU32(value: number, reference: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= U32) {
    throw new RangeError(`${value} is not a u32`);
  }
  const base = Math.floor(reference);
  const referenceU32 = ((base % U32) + U32) % U32;
  let delta = value - referenceU32;
  if (delta >= HALF_U32) delta -= U32;
  if (delta < -HALF_U32) delta += U32;
  return base + delta;
}

export interface ClockSample {
  /** Client clock when the Ping was sent. */
  sentClientMs: number;
  /** Client clock when the Pong arrived. */
  receivedClientMs: number;
  /** Server `Date.now()` from the Pong, already unwrapped from u32. */
  serverMs: number;
  /**
   * Optional ground truth: `Date.now() + 0.5 - clientClock` read in the page at
   * receive time. Only valid when the browser and server share one OS clock.
   */
  truthOffsetMs?: number;
}

export interface ClockEstimate {
  samples: number;
  /** Estimated `serverClock - clientClock`. */
  offsetMs: number;
  minRttMs: number;
  /** Worst-case error from unknown path asymmetry: half the best RTT. */
  errorBoundMs: number;
  /** Standard deviation of the per-sample offsets (noise, not bias). */
  offsetStdDevMs: number;
  /** offsetMs minus mean ground truth; null unless every sample has truth. */
  errorVsTruthMs: number | null;
}

/** NTP-style offset of one exchange, assuming symmetric one-way delays. */
export function sampleOffset(sample: ClockSample): number {
  const midpoint = (sample.sentClientMs + sample.receivedClientMs) / 2;
  return sample.serverMs + SERVER_TIME_QUANTIZATION_MS - midpoint;
}

/**
 * Estimates the offset from a burst of Ping/Pong exchanges. Uses the median
 * offset of the fastest quarter of exchanges (at least one): low-RTT samples
 * have the tightest asymmetry bound, and the median rejects a single outlier.
 */
export function estimateOffset(samples: readonly ClockSample[]): ClockEstimate {
  if (samples.length === 0) throw new RangeError("no clock samples");
  const enriched = samples.map((sample) => ({
    rtt: sample.receivedClientMs - sample.sentClientMs,
    offset: sampleOffset(sample),
    truth: sample.truthOffsetMs,
  }));
  enriched.sort((a, b) => a.rtt - b.rtt);
  const fastest = enriched.slice(0, Math.max(1, Math.floor(enriched.length / 4)));
  const offsetMs = percentile(
    fastest.map((entry) => entry.offset),
    50,
  ) as number;
  const minRttMs = (enriched[0] as { rtt: number }).rtt;
  const offsets = enriched.map((entry) => entry.offset);
  const average = mean(offsets) as number;
  const variance = mean(offsets.map((offset) => (offset - average) ** 2)) as number;
  const truths = enriched
    .map((entry) => entry.truth)
    .filter((truth): truth is number => truth !== undefined);
  const truthMean = mean(truths);
  return {
    samples: samples.length,
    offsetMs: round(offsetMs),
    minRttMs: round(minRttMs),
    errorBoundMs: round(minRttMs / 2),
    offsetStdDevMs: round(Math.sqrt(variance)),
    errorVsTruthMs:
      truthMean === null || truths.length !== samples.length ? null : round(offsetMs - truthMean),
  };
}

export interface FairnessRound {
  a: ClockEstimate;
  b: ClockEstimate;
}

export interface FairnessSummary {
  rounds: number;
  /**
   * |offsetA - offsetB| per round: the difference between the two players'
   * implied server-time press stamps for a truly simultaneous press.
   */
  pairErrorP50Ms: number | null;
  pairErrorP95Ms: number | null;
  pairErrorMaxMs: number | null;
  /** p95 of |estimate - truth| over both sockets; null without truth. */
  absErrorVsTruthP95Ms: number | null;
  /** Largest half-RTT asymmetry bound seen. */
  worstErrorBoundMs: number | null;
  passes: boolean;
}

/**
 * E9 pass rule: the pairwise press-time error p95 is under 5 ms, and, when
 * same-clock ground truth exists, the absolute error p95 is too.
 */
export function summarizeFairness(rounds: readonly FairnessRound[]): FairnessSummary {
  const pairErrors = rounds.map((entry) => Math.abs(entry.a.offsetMs - entry.b.offsetMs));
  const truthErrors: number[] = [];
  let truthComplete = rounds.length > 0;
  let worstBound: number | null = null;
  for (const entry of rounds) {
    for (const estimate of [entry.a, entry.b]) {
      if (estimate.errorVsTruthMs === null) truthComplete = false;
      else truthErrors.push(Math.abs(estimate.errorVsTruthMs));
      worstBound =
        worstBound === null ? estimate.errorBoundMs : Math.max(worstBound, estimate.errorBoundMs);
    }
  }
  const pairP95 = percentile(pairErrors, 95);
  const truthP95 = truthComplete ? percentile(truthErrors, 95) : null;
  return {
    rounds: rounds.length,
    pairErrorP50Ms: maybeRound(percentile(pairErrors, 50)),
    pairErrorP95Ms: maybeRound(pairP95),
    pairErrorMaxMs: maybeRound(pairErrors.length === 0 ? null : Math.max(...pairErrors)),
    absErrorVsTruthP95Ms: maybeRound(truthP95),
    worstErrorBoundMs: worstBound,
    passes:
      pairP95 !== null &&
      pairP95 < E9_ERROR_LIMIT_MS &&
      (truthP95 === null || truthP95 < E9_ERROR_LIMIT_MS),
  };
}

/* ------------------------------------------------------------------ */
/* E15 — lifecycle episodes and slot recovery                          */
/* ------------------------------------------------------------------ */

export type LifecycleEventType =
  | "hidden"
  | "visible"
  | "pagehide"
  | "pageshow"
  | "freeze"
  | "resume";

export interface LifecycleEvent {
  type: LifecycleEventType;
  /** Monotonic ms. */
  atMs: number;
  /** `persisted` flag of pagehide/pageshow (back/forward cache). */
  persisted?: boolean;
}

export interface RecoveryAttempt {
  /** Monotonic ms when the page became visible and started rejoining. */
  startedAtMs: number;
  /** Monotonic ms when `joined` arrived; null on failure. */
  joinedAtMs: number | null;
  path: "same-socket" | "new-socket";
  expectedSlot: number;
  slot: number | null;
  error: string | null;
}

export interface LifecycleEpisode {
  hiddenAtMs: number;
  visibleAtMs: number;
  hiddenMs: number;
  /** True when pagehide fired inside the episode (bfcache or unload path). */
  pageHidden: boolean;
  recoveryMs: number | null;
  path: RecoveryAttempt["path"] | null;
  sameSlot: boolean;
  error: string | null;
  passes: boolean;
}

export interface LifecycleSummary {
  events: number;
  episodes: LifecycleEpisode[];
  recoveryP50Ms: number | null;
  recoveryMaxMs: number | null;
  passes: boolean;
}

/**
 * Pairs each hidden→visible transition with the first recovery attempt that
 * started at or after the visible event. An episode passes when the slot came
 * back unchanged in under 1 s and the page was hidden for less than the 30 s
 * reservation (beyond 30 s the slot is legitimately released, FR-5.5).
 */
export function summarizeLifecycle(
  events: readonly LifecycleEvent[],
  recoveries: readonly RecoveryAttempt[],
): LifecycleSummary {
  const episodes: LifecycleEpisode[] = [];
  let hiddenAt: number | null = null;
  let pageHidden = false;
  for (const event of events) {
    if (event.type === "hidden" && hiddenAt === null) {
      hiddenAt = event.atMs;
      pageHidden = false;
    } else if (event.type === "pagehide" && hiddenAt !== null) {
      pageHidden = true;
    } else if (event.type === "visible" && hiddenAt !== null) {
      const visibleAt = event.atMs;
      const recovery = recoveries.find((attempt) => attempt.startedAtMs >= visibleAt) ?? null;
      const hiddenMs = visibleAt - hiddenAt;
      const recoveryMs =
        recovery === null || recovery.joinedAtMs === null ? null : recovery.joinedAtMs - visibleAt;
      const sameSlot = recovery !== null && recovery.slot === recovery.expectedSlot;
      episodes.push({
        hiddenAtMs: round(hiddenAt, 1),
        visibleAtMs: round(visibleAt, 1),
        hiddenMs: round(hiddenMs, 1),
        pageHidden,
        recoveryMs: recoveryMs === null ? null : round(recoveryMs, 1),
        path: recovery === null ? null : recovery.path,
        sameSlot,
        error: recovery === null ? "no rejoin attempt recorded" : recovery.error,
        passes:
          recoveryMs !== null &&
          recoveryMs < E15_RECOVERY_LIMIT_MS &&
          sameSlot &&
          hiddenMs < RESERVATION_MS,
      });
      hiddenAt = null;
    }
  }
  const recoveryTimes = episodes
    .map((episode) => episode.recoveryMs)
    .filter((value): value is number => value !== null);
  const p50 = percentile(recoveryTimes, 50);
  return {
    events: events.length,
    episodes,
    recoveryP50Ms: p50 === null ? null : round(p50, 1),
    recoveryMaxMs: recoveryTimes.length === 0 ? null : Math.max(...recoveryTimes),
    passes: episodes.length > 0 && episodes.every((episode) => episode.passes),
  };
}

/* ------------------------------------------------------------------ */
/* G1 — page load to joined                                            */
/* ------------------------------------------------------------------ */

export interface G1Marks {
  /** Navigation-timing `loadEventEnd` (monotonic ms), or DOMContentLoaded if load is not done. */
  pageReadyMs: number;
  /** Run button click. */
  runClickMs: number;
  /** Room available (created, or external code supplied). */
  roomReadyMs: number;
  /** Controller socket open. */
  socketOpenMs: number;
  /** `join` sent. */
  joinSentMs: number;
  /** `joined` received. */
  joinedMs: number;
}

export type G1Verdict = "pass" | "fail" | "hard-fail";

export interface G1Summary {
  /** Navigation start → joined, including the human's wait before Run. */
  pageLoadToJoinedMs: number;
  /** Time spent waiting for the human to press Run (excluded from the verdict). */
  humanWaitMs: number;
  runToJoinedMs: number;
  joinRoundTripMs: number;
  /** What an auto-joining controller would take: page ready + Run→joined. */
  machineMs: number;
  verdict: G1Verdict;
}

export function classifyG1(ms: number): G1Verdict {
  if (ms >= G1_HARD_FAIL_MS) return "hard-fail";
  return ms < G1_PASS_MS ? "pass" : "fail";
}

/**
 * Splits the in-page G1 timeline. The verdict uses `machineMs`, which removes
 * the human delay before Run; it is still a lower bound on scan-to-playable
 * because QR decoding and the OS opening the URL happen before navigation.
 */
export function summarizeG1(marks: G1Marks): G1Summary {
  const sequence = [
    marks.runClickMs,
    marks.roomReadyMs,
    marks.socketOpenMs,
    marks.joinSentMs,
    marks.joinedMs,
  ];
  for (let index = 1; index < sequence.length; index += 1) {
    if ((sequence[index] as number) < (sequence[index - 1] as number)) {
      throw new RangeError("G1 marks are out of order");
    }
  }
  const runToJoined = marks.joinedMs - marks.runClickMs;
  const machine = marks.pageReadyMs + runToJoined;
  return {
    pageLoadToJoinedMs: round(marks.joinedMs, 1),
    humanWaitMs: round(Math.max(0, marks.runClickMs - marks.pageReadyMs), 1),
    runToJoinedMs: round(runToJoined, 1),
    joinRoundTripMs: round(marks.joinedMs - marks.joinSentMs, 1),
    machineMs: round(machine, 1),
    verdict: classifyG1(machine),
  };
}

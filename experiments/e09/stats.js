/* Generated from stats.ts by experiments/e09/build.mjs. Do not edit directly. */
const E4_P95_LIMIT_MS = 8;
const E9_ERROR_LIMIT_MS = 5;
const E15_RECOVERY_LIMIT_MS = 1e3;
const RESERVATION_MS = 3e4;
const G1_PASS_MS = 5e3;
const G1_HARD_FAIL_MS = 1e4;
const SERVER_TIME_QUANTIZATION_MS = 0.5;
const U32 = 4294967296;
const HALF_U32 = 2147483648;
function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function percentile(values, p) {
  if (values.length === 0) return null;
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile ${p} is outside 0..100`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p / 100 * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const low = sorted[lower];
  const high = sorted[upper];
  return low + (high - low) * (rank - lower);
}
function mean(values) {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}
function meanAbsoluteDelta(values) {
  if (values.length < 2) return null;
  let sum = 0;
  for (let index = 1; index < values.length; index += 1) {
    sum += Math.abs(values[index] - values[index - 1]);
  }
  return sum / (values.length - 1);
}
function maybeRound(value) {
  return value === null ? null : round(value);
}
function summarizeRtt(series) {
  const all = [];
  let sent = 0;
  let jitterSum = 0;
  let jitterPairs = 0;
  const perSocketLost = [];
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
    lossPct: sent === 0 ? 0 : round(lost / sent * 100),
    minMs: maybeRound(all.length === 0 ? null : Math.min(...all)),
    p50Ms: maybeRound(percentile(all, 50)),
    p95Ms: maybeRound(percentile(all, 95)),
    maxMs: maybeRound(all.length === 0 ? null : Math.max(...all)),
    meanMs: maybeRound(mean(all)),
    jitterMs: jitterPairs === 0 ? null : round(jitterSum / jitterPairs),
    perSocketLost
  };
}
function e4Passes(summary) {
  return summary.p95Ms !== null && summary.p95Ms < E4_P95_LIMIT_MS && summary.lost === 0;
}
function unwrapU32(value, reference) {
  if (!Number.isInteger(value) || value < 0 || value >= U32) {
    throw new RangeError(`${value} is not a u32`);
  }
  const base = Math.floor(reference);
  const referenceU32 = (base % U32 + U32) % U32;
  let delta = value - referenceU32;
  if (delta >= HALF_U32) delta -= U32;
  if (delta < -HALF_U32) delta += U32;
  return base + delta;
}
function sampleOffset(sample) {
  const midpoint = (sample.sentClientMs + sample.receivedClientMs) / 2;
  return sample.serverMs + SERVER_TIME_QUANTIZATION_MS - midpoint;
}
function estimateOffset(samples) {
  if (samples.length === 0) throw new RangeError("no clock samples");
  const enriched = samples.map((sample) => ({
    rtt: sample.receivedClientMs - sample.sentClientMs,
    offset: sampleOffset(sample),
    truth: sample.truthOffsetMs
  }));
  enriched.sort((a, b) => a.rtt - b.rtt);
  const fastest = enriched.slice(0, Math.max(1, Math.floor(enriched.length / 4)));
  const offsetMs = percentile(
    fastest.map((entry) => entry.offset),
    50
  );
  const minRttMs = enriched[0].rtt;
  const offsets = enriched.map((entry) => entry.offset);
  const average = mean(offsets);
  const variance = mean(offsets.map((offset) => (offset - average) ** 2));
  const truths = enriched.map((entry) => entry.truth).filter((truth) => truth !== void 0);
  const truthMean = mean(truths);
  return {
    samples: samples.length,
    offsetMs: round(offsetMs),
    minRttMs: round(minRttMs),
    errorBoundMs: round(minRttMs / 2),
    offsetStdDevMs: round(Math.sqrt(variance)),
    errorVsTruthMs: truthMean === null || truths.length !== samples.length ? null : round(offsetMs - truthMean)
  };
}
function summarizeFairness(rounds) {
  const pairErrors = rounds.map((entry) => Math.abs(entry.a.offsetMs - entry.b.offsetMs));
  const truthErrors = [];
  let truthComplete = rounds.length > 0;
  let worstBound = null;
  for (const entry of rounds) {
    for (const estimate of [entry.a, entry.b]) {
      if (estimate.errorVsTruthMs === null) truthComplete = false;
      else truthErrors.push(Math.abs(estimate.errorVsTruthMs));
      worstBound = worstBound === null ? estimate.errorBoundMs : Math.max(worstBound, estimate.errorBoundMs);
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
    passes: pairP95 !== null && pairP95 < E9_ERROR_LIMIT_MS && (truthP95 === null || truthP95 < E9_ERROR_LIMIT_MS)
  };
}
function summarizeLifecycle(events, recoveries) {
  var _a;
  const episodes = [];
  let hiddenAt = null;
  let pageHidden = false;
  for (const event of events) {
    if (event.type === "hidden" && hiddenAt === null) {
      hiddenAt = event.atMs;
      pageHidden = false;
    } else if (event.type === "pagehide" && hiddenAt !== null) {
      pageHidden = true;
    } else if (event.type === "visible" && hiddenAt !== null) {
      const visibleAt = event.atMs;
      const recovery = (_a = recoveries.find((attempt) => attempt.startedAtMs >= visibleAt)) != null ? _a : null;
      const hiddenMs = visibleAt - hiddenAt;
      const recoveryMs = recovery === null || recovery.joinedAtMs === null ? null : recovery.joinedAtMs - visibleAt;
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
        passes: recoveryMs !== null && recoveryMs < E15_RECOVERY_LIMIT_MS && sameSlot && hiddenMs < RESERVATION_MS
      });
      hiddenAt = null;
    }
  }
  const recoveryTimes = episodes.map((episode) => episode.recoveryMs).filter((value) => value !== null);
  const p50 = percentile(recoveryTimes, 50);
  return {
    events: events.length,
    episodes,
    recoveryP50Ms: p50 === null ? null : round(p50, 1),
    recoveryMaxMs: recoveryTimes.length === 0 ? null : Math.max(...recoveryTimes),
    passes: episodes.length > 0 && episodes.every((episode) => episode.passes)
  };
}
function classifyG1(ms) {
  if (ms >= G1_HARD_FAIL_MS) return "hard-fail";
  return ms < G1_PASS_MS ? "pass" : "fail";
}
function summarizeG1(marks) {
  const sequence = [
    marks.runClickMs,
    marks.roomReadyMs,
    marks.socketOpenMs,
    marks.joinSentMs,
    marks.joinedMs
  ];
  for (let index = 1; index < sequence.length; index += 1) {
    if (sequence[index] < sequence[index - 1]) {
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
    verdict: classifyG1(machine)
  };
}
export {
  E15_RECOVERY_LIMIT_MS,
  E4_P95_LIMIT_MS,
  E9_ERROR_LIMIT_MS,
  G1_HARD_FAIL_MS,
  G1_PASS_MS,
  RESERVATION_MS,
  SERVER_TIME_QUANTIZATION_MS,
  classifyG1,
  e4Passes,
  estimateOffset,
  mean,
  meanAbsoluteDelta,
  percentile,
  round,
  sampleOffset,
  summarizeFairness,
  summarizeG1,
  summarizeLifecycle,
  summarizeRtt,
  unwrapU32
};

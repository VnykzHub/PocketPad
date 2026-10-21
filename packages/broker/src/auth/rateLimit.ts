/**
 * Join rate limiting (D4-SRV-01, SR-5).
 *
 * Five failed attempts inside a sliding 60 s window lock an IP out for 60 s.
 * Each further lockout without a successful join doubles the duration up to a
 * five-minute cap. A successful join clears both the window and the
 * escalation level. Time is injected so tests and P5 load runs never wait on a
 * real clock.
 *
 * The limiter is generic on purpose: P3 reuses it (with different options) for
 * room creation and event limits. It never logs and never stores credentials.
 */
export interface JoinRateLimiter {
  check(ip: string, nowMs: number): { allowed: true } | { allowed: false; retryAfterMs: number };
  recordFailure(ip: string, nowMs: number): void;
  recordSuccess(ip: string, nowMs: number): void;
}

export interface JoinRateLimiterOptions {
  /** Failed attempts inside the window before a lockout starts. */
  maxAttempts?: number;
  /** Sliding window length in milliseconds. */
  windowMs?: number;
  /** First lockout duration in milliseconds. */
  lockoutMs?: number;
  /** Cap for the doubled lockout durations in milliseconds. */
  maxLockoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_LOCKOUT_MS = 60_000;
const DEFAULT_MAX_LOCKOUT_MS = 5 * 60_000;

interface IpState {
  /** Failure timestamps inside the window, oldest first. */
  failures: number[];
  /** Epoch ms until which attempts are refused; 0 when not locked out. */
  lockedUntil: number;
  /** Number of lockouts served since the last successful join. */
  lockoutLevel: number;
}

/**
 * Normalizes an address for keying (SR-5).
 *
 * Node reports IPv4 clients as `::ffff:1.2.3.4`; the same client must share a
 * lockout with its plain IPv4 spelling. IPv6 hex is case-insensitive, so the
 * key is lowercased. Proxy headers are resolved by the adapter, not here.
 */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
}

export function createJoinRateLimiter(options: JoinRateLimiterOptions = {}): JoinRateLimiter {
  const maxAttempts = requirePositiveInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "maxAttempts",
  );
  const windowMs = requirePositive(options.windowMs ?? DEFAULT_WINDOW_MS, "windowMs");
  const lockoutMs = requirePositive(options.lockoutMs ?? DEFAULT_LOCKOUT_MS, "lockoutMs");
  const maxLockoutMs = requirePositive(
    options.maxLockoutMs ?? DEFAULT_MAX_LOCKOUT_MS,
    "maxLockoutMs",
  );

  const states = new Map<string, IpState>();

  function stateFor(ip: string): IpState {
    const key = normalizeIp(ip);
    let state = states.get(key);
    if (state === undefined) {
      state = { failures: [], lockedUntil: 0, lockoutLevel: 0 };
      states.set(key, state);
    }
    return state;
  }

  function pruneFailures(state: IpState, nowMs: number): void {
    const cutoff = nowMs - windowMs;
    let drop = 0;
    while (drop < state.failures.length && (state.failures[drop] ?? 0) <= cutoff) {
      drop += 1;
    }
    if (drop > 0) {
      state.failures.splice(0, drop);
    }
  }

  return {
    check(ip, nowMs) {
      const state = states.get(normalizeIp(ip));
      if (state === undefined) {
        return { allowed: true };
      }
      if (state.lockedUntil > nowMs) {
        return { allowed: false, retryAfterMs: Math.ceil(state.lockedUntil - nowMs) };
      }
      if (state.lockedUntil !== 0) {
        // Lockout served: start a fresh window. The escalation level survives
        // until a successful join, so repeated brute force doubles the next one.
        state.lockedUntil = 0;
        state.failures.length = 0;
      }
      pruneFailures(state, nowMs);
      return { allowed: true };
    },

    recordFailure(ip, nowMs) {
      const state = stateFor(ip);
      if (state.lockedUntil > nowMs) {
        // Attempts refused by the limiter never reach credential comparison;
        // recording one anyway must not extend the lockout.
        return;
      }
      if (state.lockedUntil !== 0) {
        state.lockedUntil = 0;
        state.failures.length = 0;
      }
      pruneFailures(state, nowMs);
      state.failures.push(nowMs);
      if (state.failures.length >= maxAttempts) {
        state.lockedUntil = nowMs + Math.min(lockoutMs * 2 ** state.lockoutLevel, maxLockoutMs);
        state.lockoutLevel += 1;
        state.failures.length = 0;
      }
    },

    recordSuccess(ip, nowMs) {
      // `nowMs` is part of the frozen interface for callers that expire state
      // by time; a success deletes the entry outright.
      void nowMs;
      states.delete(normalizeIp(ip));
    },
  };
}

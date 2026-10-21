/**
 * Join rate limiting (D4-SRV-01, SR-5).
 *
 * Every test drives an injected clock; no real time passes.
 */
import { describe, expect, test } from "vitest";
import { createJoinRateLimiter, normalizeIp } from "../src/auth/rateLimit.js";

const IP = "203.0.113.7";

describe("createJoinRateLimiter", () => {
  test("[SR-5] five failures in 60 s lock out the sixth attempt for 60 s", () => {
    const limiter = createJoinRateLimiter();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(limiter.check(IP, attempt)).toEqual({ allowed: true });
      limiter.recordFailure(IP, attempt);
    }

    // The fifth failure starts the lockout, so the sixth attempt is refused.
    expect(limiter.check(IP, 5)).toEqual({ allowed: false, retryAfterMs: 59_999 });
    expect(limiter.check(IP, 60_003)).toEqual({ allowed: false, retryAfterMs: 1 });
    expect(limiter.check(IP, 60_004)).toEqual({ allowed: true });
  });

  test("[SR-5] repeated lockouts double up to a five minute cap", () => {
    const limiter = createJoinRateLimiter();
    const durations: number[] = [];
    let now = 0;

    for (let round = 0; round < 5; round += 1) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(limiter.check(IP, now + attempt)).toEqual({ allowed: true });
        limiter.recordFailure(IP, now + attempt);
      }

      const fifthFailureAt = now + 4;
      const verdict = limiter.check(IP, fifthFailureAt + 1);
      if (verdict.allowed) {
        throw new Error("expected the sixth attempt to be locked out");
      }
      // +1 because the check happened 1 ms after the lockout started.
      durations.push(verdict.retryAfterMs + 1);
      now = fifthFailureAt + 1 + verdict.retryAfterMs;
    }

    expect(durations).toEqual([60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  test("[SR-5] a successful join resets the window and the escalation level", () => {
    const limiter = createJoinRateLimiter();

    // Four failures followed by a success never produce a lockout.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailure(IP, attempt);
    }
    limiter.recordSuccess(IP, 4);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(limiter.check(IP, 10 + attempt)).toEqual({ allowed: true });
      limiter.recordFailure(IP, 10 + attempt);
    }
    expect(limiter.check(IP, 20)).toEqual({ allowed: true });

    // Clear the partial window before proving the post-lockout reset.
    limiter.recordSuccess(IP, 20);

    // After one real lockout, a success drops the next lockout back to 60 s.
    const now = 21;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure(IP, now + attempt);
    }
    expect(limiter.check(IP, now + 5)).toEqual({ allowed: false, retryAfterMs: 59_999 });

    const expiry = now + 4 + 60_000;
    expect(limiter.check(IP, expiry)).toEqual({ allowed: true });
    limiter.recordSuccess(IP, expiry);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure(IP, expiry + 1 + attempt);
    }
    expect(limiter.check(IP, expiry + 6)).toEqual({ allowed: false, retryAfterMs: 59_999 });
  });

  test("[SR-5] failures older than the sliding window do not count", () => {
    const limiter = createJoinRateLimiter();

    for (const at of [0, 15_000, 30_000, 45_000, 61_000]) {
      expect(limiter.check(IP, at)).toEqual({ allowed: true });
      limiter.recordFailure(IP, at);
    }

    // At 61 s the failure at t=0 is outside the 60 s window: only four remain.
    expect(limiter.check(IP, 61_001)).toEqual({ allowed: true });
  });

  test("[SR-5] attempts refused by a lockout do not extend it", () => {
    const limiter = createJoinRateLimiter();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure(IP, attempt);
    }
    expect(limiter.check(IP, 5)).toEqual({ allowed: false, retryAfterMs: 59_999 });

    // A caller that records blocked attempts anyway must not push the expiry.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.recordFailure(IP, 100 + attempt);
    }
    expect(limiter.check(IP, 60_004)).toEqual({ allowed: true });
  });

  test("[SR-5] IPv4-mapped IPv6 addresses share the lockout with plain IPv4", () => {
    const limiter = createJoinRateLimiter();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure("::ffff:203.0.113.7", attempt);
    }

    expect(limiter.check(IP, 5)).toEqual({ allowed: false, retryAfterMs: 59_999 });
    expect(limiter.check("198.51.100.4", 5)).toEqual({ allowed: true });
    expect(normalizeIp("::FFFF:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeIp(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  test("[SR-5] limits are configurable so P3 can reuse the limiter", () => {
    const limiter = createJoinRateLimiter({
      maxAttempts: 2,
      windowMs: 1_000,
      lockoutMs: 5_000,
      maxLockoutMs: 10_000,
    });

    limiter.recordFailure("192.0.2.9", 0);
    expect(limiter.check("192.0.2.9", 1)).toEqual({ allowed: true });
    limiter.recordFailure("192.0.2.9", 2);
    expect(limiter.check("192.0.2.9", 3)).toEqual({ allowed: false, retryAfterMs: 4_999 });
  });

  test("[SR-5] invalid limits fail at construction instead of misbehaving later", () => {
    expect(() => createJoinRateLimiter({ maxAttempts: 0 })).toThrow(RangeError);
    expect(() => createJoinRateLimiter({ maxAttempts: 2.5 })).toThrow(RangeError);
    expect(() => createJoinRateLimiter({ windowMs: 0 })).toThrow(RangeError);
    expect(() => createJoinRateLimiter({ lockoutMs: Number.NaN })).toThrow(RangeError);
  });
});

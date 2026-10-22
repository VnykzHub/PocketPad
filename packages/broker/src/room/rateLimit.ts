/**
 * Generic token bucket shared by the D5 event channel and D6 haptics
 * (D5-SRV-01, D6-SRV-01).
 *
 * Time is injected by the caller so tests and load runs never sleep. The bucket
 * starts full: a burst of `burst` requests is allowed immediately, then tokens
 * refill continuously at `ratePerSecond`. A negative or stalled clock never
 * refills, so a backwards clock cannot manufacture capacity.
 */
export interface TokenBucketOptions {
  /** Sustained tokens per second. */
  ratePerSecond: number;
  /** Bucket capacity: the largest instantaneous burst. */
  burst: number;
}

function requirePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive number`);
  }
  return value;
}

/** Floating-point slack so an exactly-refilled token is never lost to rounding. */
const TOKEN_EPSILON = 1e-9;

export class TokenBucket {
  private readonly ratePerMs: number;
  private readonly capacity: number;
  private tokens: number;
  private lastRefillAt: number;

  constructor(options: TokenBucketOptions, nowMs: number) {
    this.ratePerMs = requirePositive(options.ratePerSecond, "ratePerSecond") / 1000;
    this.capacity = requirePositive(options.burst, "burst");
    this.tokens = this.capacity;
    this.lastRefillAt = nowMs;
  }

  /** Consumes one token when available at `nowMs`. */
  take(nowMs: number): boolean {
    this.refill(nowMs);
    if (this.tokens + TOKEN_EPSILON < 1) {
      return false;
    }
    this.tokens = Math.max(0, this.tokens - 1);
    return true;
  }

  /** Fractional tokens available at `nowMs`; diagnostics and tests only. */
  available(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }

  private refill(nowMs: number): void {
    if (nowMs <= this.lastRefillAt) {
      return;
    }
    const elapsedMs = nowMs - this.lastRefillAt;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.ratePerMs);
    this.lastRefillAt = nowMs;
  }
}

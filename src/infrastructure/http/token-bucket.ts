import type { Clock } from '../../domain/ports.js';
import { systemClock } from '../../shared/clock.js';
import { sleep as defaultSleep } from '../../shared/sleep.js';

export interface TokenBucketOptions {
  /** Maximum burst size. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
  clock?: Clock;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Token-bucket rate limiter with reservation semantics: `acquire()` takes a token immediately
 * (the balance may go negative) and then waits for the debt to be repaid. This makes waiting
 * callers strictly FIFO without a queue data structure, and gives exact spacing between calls.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly clock: Clock;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: TokenBucketOptions) {
    if (options.capacity < 1) throw new RangeError('capacity must be >= 1');
    if (options.refillPerSecond <= 0) throw new RangeError('refillPerSecond must be > 0');
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = options.capacity;
    this.lastRefill = this.clock.now();
  }

  /** Current balance (may be negative while callers are waiting). */
  get available(): number {
    this.refill();
    return this.tokens;
  }

  /** Non-blocking: takes a token if one is available right now. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    this.refill();
    this.tokens -= 1;
    if (this.tokens >= 0) return;

    const waitMs = Math.ceil((-this.tokens / this.options.refillPerSecond) * 1000);
    try {
      await this.sleep(waitMs, signal);
    } catch (err) {
      this.tokens += 1; // give the reservation back
      throw err;
    }
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(
      this.options.capacity,
      this.tokens + (elapsed / 1000) * this.options.refillPerSecond,
    );
    this.lastRefill = now;
  }
}

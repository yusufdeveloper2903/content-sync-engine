import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../../src/infrastructure/http/token-bucket.js';
import { ManualClock } from '../../src/shared/clock.js';

function setup(capacity: number, refillPerSecond: number) {
  const clock = new ManualClock(0);
  const sleeps: number[] = [];
  const bucket = new TokenBucket({
    capacity,
    refillPerSecond,
    clock,
    // Fake sleep: record the requested wait and "pass" that much time.
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { clock, sleeps, bucket };
}

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then rejects tryAcquire', () => {
    const { bucket } = setup(3, 1);
    expect([bucket.tryAcquire(), bucket.tryAcquire(), bucket.tryAcquire()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(bucket.tryAcquire()).toBe(false);
  });

  it('refills at the configured rate and never exceeds capacity', () => {
    const { bucket, clock } = setup(2, 4); // 1 token / 250ms
    bucket.tryAcquire();
    bucket.tryAcquire();
    clock.advance(249);
    expect(bucket.tryAcquire()).toBe(false);
    clock.advance(1);
    expect(bucket.tryAcquire()).toBe(true);

    clock.advance(60_000);
    expect(bucket.available).toBe(2);
  });

  it('acquire() does not wait while tokens are available', async () => {
    const { bucket, sleeps } = setup(2, 1);
    await bucket.acquire();
    await bucket.acquire();
    expect(sleeps).toEqual([]);
  });

  it('acquire() reserves tokens so concurrent waiters are spaced FIFO', async () => {
    const { bucket, sleeps } = setup(1, 10); // 100ms per token
    await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire(), bucket.acquire()]);
    expect(sleeps).toEqual([100, 200, 300]);
  });

  it('refunds the reservation when the wait is aborted', async () => {
    const clock = new ManualClock(0);
    const bucket = new TokenBucket({
      capacity: 1,
      refillPerSecond: 1,
      clock,
      sleep: () => Promise.reject(new Error('aborted')),
    });
    await bucket.acquire();
    await expect(bucket.acquire()).rejects.toThrow('aborted');
    expect(bucket.available).toBe(0);
  });

  it('validates its configuration', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow(RangeError);
  });
});

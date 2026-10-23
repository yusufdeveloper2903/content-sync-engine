import { describe, expect, it } from 'vitest';
import { backoffDelay } from '../../src/shared/backoff.js';

describe('backoffDelay', () => {
  it('grows exponentially and is capped', () => {
    const opts = { baseMs: 100, maxMs: 1_000 };
    expect([1, 2, 3, 4, 5, 10].map((a) => backoffDelay(a, opts))).toEqual([
      100, 200, 400, 800, 1_000, 1_000,
    ]);
  });

  it('applies equal jitter within [exp/2, exp]', () => {
    const opts = { baseMs: 100, maxMs: 10_000, jitter: 'equal' as const };
    expect(backoffDelay(3, { ...opts, random: () => 0 })).toBe(200);
    expect(backoffDelay(3, { ...opts, random: () => 1 })).toBe(400);
    for (let i = 0; i < 100; i++) {
      const d = backoffDelay(4, opts);
      expect(d).toBeGreaterThanOrEqual(400);
      expect(d).toBeLessThanOrEqual(800);
    }
  });
});

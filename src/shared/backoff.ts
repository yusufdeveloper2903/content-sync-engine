export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /**
   * 'equal' jitter picks uniformly from [exp/2, exp]. It keeps a guaranteed minimum wait while
   * spreading out retries of many jobs that failed together (e.g. during an upstream outage),
   * so they don't stampede the moment it recovers.
   */
  jitter?: 'none' | 'equal';
  random?: () => number;
}

/** Exponential backoff delay for the given 1-based attempt number: base * 2^(attempt-1), capped. */
export function backoffDelay(attempt: number, options: BackoffOptions): number {
  const exp = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt - 1));
  if (options.jitter === 'equal') {
    const random = options.random ?? Math.random;
    return Math.round(exp / 2 + (random() * exp) / 2);
  }
  return exp;
}

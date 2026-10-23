import { UpstreamError } from '../../domain/errors.js';
import type { Logger } from '../../shared/logger.js';
import { backoffDelay } from '../../shared/backoff.js';
import { sleep as defaultSleep, errorMessage } from '../../shared/sleep.js';
import type { TokenBucket } from './token-bucket.js';

export interface HttpClientOptions {
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  limiter?: TokenBucket;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  logger?: Logger;
  userAgent?: string;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Small outbound HTTP client: per-attempt timeout, bounded retries with exponential backoff
 * (honouring Retry-After), and a shared token bucket so the whole process stays under the
 * upstream's rate limit no matter how many workers run concurrently.
 */
export class HttpClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  async getJson(url: string, signal?: AbortSignal): Promise<unknown> {
    const { maxRetries, timeoutMs } = this.options;
    let lastError: UpstreamError | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      signal?.throwIfAborted();
      await this.options.limiter?.acquire(signal);

      const attemptSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);

      let retryAfterMs: number | undefined;
      try {
        const res = await this.fetchImpl(url, {
          signal: attemptSignal,
          headers: {
            accept: 'application/json',
            'user-agent': this.options.userAgent ?? 'content-sync-engine/1.0',
          },
        });
        if (res.ok) return await res.json();

        await res.body?.cancel();
        const retryable = RETRYABLE_STATUS.has(res.status);
        lastError = new UpstreamError(`GET ${url} -> HTTP ${res.status}`, retryable, res.status);
        if (!retryable) throw lastError;
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      } catch (err) {
        if (signal?.aborted) throw err; // caller cancelled: don't retry
        if (err instanceof UpstreamError && !err.retryable) throw err;
        if (!(err instanceof UpstreamError)) {
          const timedOut = err instanceof Error && err.name === 'TimeoutError';
          lastError = new UpstreamError(
            timedOut
              ? `GET ${url} timed out after ${timeoutMs}ms`
              : `GET ${url} failed: ${errorMessage(err)}`,
            true,
            undefined,
            { cause: err },
          );
        }
      }

      if (attempt <= maxRetries) {
        const delay = Math.min(
          this.options.retryMaxMs ?? 10_000,
          retryAfterMs ??
            backoffDelay(attempt, {
              baseMs: this.options.retryBaseMs ?? 250,
              maxMs: this.options.retryMaxMs ?? 10_000,
              jitter: 'equal',
            }),
        );
        this.options.logger?.warn(
          { url, attempt, delayMs: delay, err: lastError?.message },
          'upstream request failed, retrying',
        );
        await this.sleep(delay, signal);
      }
    }
    throw lastError ?? new UpstreamError(`GET ${url} failed`, true);
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  IdempotencyKeyReuseError,
  NotFoundError,
  PermanentJobError,
  UpstreamError,
  ValidationError,
} from '../../domain/errors.js';
import type { Job, JobStatus, NewJob } from '../../domain/job.js';
import type { Clock, JobListFilter, JobRepository, Page } from '../../domain/ports.js';
import { backoffDelay } from '../../shared/backoff.js';
import { errorMessage } from '../../shared/sleep.js';
import { stableStringify } from '../../shared/stable-json.js';

export interface JobQueueOptions {
  defaultMaxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

export interface EnqueueResult {
  job: Job;
  /** false when an existing job was returned because of a matching idempotency key. */
  created: boolean;
}

export type FailureOutcome =
  { outcome: 'retry'; runAt: number; delayMs: number } | { outcome: 'dead' } | { outcome: 'lost' };

/**
 * Application service owning job-queue semantics: idempotent enqueue, lease-based claiming,
 * retry with exponential backoff, and dead-lettering. Persistence is delegated to the
 * JobRepository port, so the rules here are storage-agnostic and unit-testable.
 */
export class JobQueue {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly repo: JobRepository,
    private readonly clock: Clock,
    private readonly options: JobQueueOptions,
  ) {}

  /** Subscribe to "new work available" notifications (used to wake idle workers). */
  onEnqueue(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enqueue(input: NewJob): EnqueueResult {
    const now = this.clock.now();
    const maxAttempts = input.maxAttempts ?? this.options.defaultMaxAttempts;
    if (maxAttempts < 1) throw new ValidationError('maxAttempts must be >= 1');

    const job = this.repo.insert({
      id: randomUUID(),
      type: input.type,
      payload: input.payload ?? {},
      priority: input.priority ?? 0,
      maxAttempts,
      runAt: input.runAt ?? now,
      idempotencyKey: input.idempotencyKey ?? null,
      now,
    });

    if (job) {
      this.notify();
      return { job, created: true };
    }

    // Insert was a no-op => idempotency key already used. Return the original job, but only
    // if the request is the same one; reusing a key for a different request is a client bug.
    const existing = input.idempotencyKey
      ? this.repo.findByIdempotencyKey(input.idempotencyKey)
      : null;
    if (!existing) throw new Error('Job insert affected no rows and no idempotent match found');
    if (
      existing.type !== input.type ||
      stableStringify(existing.payload) !== stableStringify(input.payload ?? {})
    ) {
      throw new IdempotencyKeyReuseError(
        `Idempotency key "${input.idempotencyKey}" was already used for a different request`,
      );
    }
    return { job: existing, created: false };
  }

  get(id: string): Job {
    const job = this.repo.findById(id);
    if (!job) throw new NotFoundError(`Job ${id} not found`);
    return job;
  }

  list(filter: JobListFilter): Page<Job> {
    return this.repo.list(filter);
  }

  stats(): Record<JobStatus, number> {
    return this.repo.countByStatus();
  }

  /** Manually re-queue a dead-lettered job with a fresh attempt budget. */
  retry(id: string): Job {
    const job = this.repo.requeue(id, this.clock.now());
    if (job) {
      this.notify();
      return job;
    }
    const existing = this.get(id);
    throw new ConflictError(`Only dead jobs can be retried; job ${id} is ${existing.status}`);
  }

  claim(workerId: string, leaseMs: number): Job | null {
    return this.repo.claimNext(workerId, this.clock.now(), leaseMs);
  }

  heartbeat(job: Job, workerId: string, leaseMs: number): boolean {
    const now = this.clock.now();
    return this.repo.extendLease(job.id, workerId, now + leaseMs, now);
  }

  /** Returns false if the lease was lost (another worker re-claimed the job); the result is discarded. */
  complete(job: Job, workerId: string, result: unknown): boolean {
    return this.repo.markSucceeded(job.id, workerId, result, this.clock.now());
  }

  fail(job: Job, workerId: string, error: unknown): FailureOutcome {
    const now = this.clock.now();
    const message = errorMessage(error);
    const permanent =
      error instanceof PermanentJobError ||
      error instanceof ValidationError ||
      (error instanceof UpstreamError && !error.retryable);

    if (permanent || job.attempts >= job.maxAttempts) {
      const reason = permanent ? message : `${message} (gave up after ${job.attempts} attempts)`;
      return this.repo.markDead(job.id, workerId, reason, now)
        ? { outcome: 'dead' }
        : { outcome: 'lost' };
    }

    const delayMs = backoffDelay(job.attempts, {
      baseMs: this.options.backoffBaseMs,
      maxMs: this.options.backoffMaxMs,
      jitter: 'equal',
      ...(this.options.random ? { random: this.options.random } : {}),
    });
    const runAt = now + delayMs;
    return this.repo.markForRetry(job.id, workerId, message, runAt, now)
      ? { outcome: 'retry', runAt, delayMs }
      : { outcome: 'lost' };
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../../src/application/queue/job-queue.js';
import {
  ConflictError,
  IdempotencyKeyReuseError,
  NotFoundError,
  PermanentJobError,
  UpstreamError,
} from '../../src/domain/errors.js';
import { SqliteJobRepository } from '../../src/infrastructure/db/repositories/sqlite-job-repository.js';
import { ManualClock } from '../../src/shared/clock.js';
import { createTestDb } from '../helpers/setup.js';

const LEASE = 1_000;

describe('JobQueue (SQLite-backed)', () => {
  let clock: ManualClock;
  let repo: SqliteJobRepository;
  let queue: JobQueue;

  beforeEach(() => {
    clock = new ManualClock();
    repo = new SqliteJobRepository(createTestDb());
    queue = new JobQueue(repo, clock, {
      defaultMaxAttempts: 3,
      backoffBaseMs: 100,
      backoffMaxMs: 1_000,
      random: () => 1, // jitter at upper bound => deterministic exponential delay
    });
  });

  describe('enqueue & claim', () => {
    it('claims the highest-priority due job first, FIFO within a priority', () => {
      const low = queue.enqueue({ type: 't', payload: { n: 1 }, priority: 0 }).job;
      clock.advance(1);
      const high = queue.enqueue({ type: 't', payload: { n: 2 }, priority: 10 }).job;
      clock.advance(1);
      const low2 = queue.enqueue({ type: 't', payload: { n: 3 }, priority: 0 }).job;

      expect(queue.claim('w', LEASE)?.id).toBe(high.id);
      expect(queue.claim('w', LEASE)?.id).toBe(low.id);
      expect(queue.claim('w', LEASE)?.id).toBe(low2.id);
      expect(queue.claim('w', LEASE)).toBeNull();
    });

    it('does not hand out jobs scheduled in the future', () => {
      queue.enqueue({ type: 't', payload: {}, runAt: clock.now() + 500 });
      expect(queue.claim('w', LEASE)).toBeNull();
      clock.advance(500);
      expect(queue.claim('w', LEASE)).not.toBeNull();
    });

    it('marks the claimed job running with a lease and increments attempts', () => {
      queue.enqueue({ type: 't', payload: {} });
      const job = queue.claim('worker-1', LEASE)!;
      expect(job).toMatchObject({
        status: 'running',
        attempts: 1,
        lockedBy: 'worker-1',
        lockedUntil: clock.now() + LEASE,
      });
      expect(queue.claim('worker-2', LEASE)).toBeNull();
    });

    it('notifies subscribers on enqueue', () => {
      let calls = 0;
      queue.onEnqueue(() => calls++);
      queue.enqueue({ type: 't', payload: {} });
      expect(calls).toBe(1);
    });
  });

  describe('idempotency keys', () => {
    it('returns the original job for a repeated key with the same request', () => {
      const first = queue.enqueue({ type: 't', payload: { a: 1, b: 2 }, idempotencyKey: 'k1' });
      const second = queue.enqueue({ type: 't', payload: { b: 2, a: 1 }, idempotencyKey: 'k1' });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.job.id).toBe(first.job.id);
      expect(queue.list({ limit: 10 }).data).toHaveLength(1);
    });

    it('rejects reuse of a key for a different request', () => {
      queue.enqueue({ type: 't', payload: { a: 1 }, idempotencyKey: 'k1' });
      expect(() => queue.enqueue({ type: 't', payload: { a: 2 }, idempotencyKey: 'k1' })).toThrow(
        IdempotencyKeyReuseError,
      );
    });

    it('still deduplicates after the original job has completed', () => {
      const { job } = queue.enqueue({ type: 't', payload: {}, idempotencyKey: 'k1' });
      const claimed = queue.claim('w', LEASE)!;
      queue.complete(claimed, 'w', { ok: true });
      const again = queue.enqueue({ type: 't', payload: {}, idempotencyKey: 'k1' });
      expect(again).toMatchObject({ created: false, job: { id: job.id, status: 'succeeded' } });
    });
  });

  describe('retries, backoff and dead-lettering', () => {
    it('re-queues a failed job with exponential backoff', () => {
      queue.enqueue({ type: 't', payload: {} });

      const a1 = queue.claim('w', LEASE)!;
      expect(queue.fail(a1, 'w', new Error('boom'))).toMatchObject({
        outcome: 'retry',
        delayMs: 100,
      });
      expect(queue.get(a1.id)).toMatchObject({
        status: 'queued',
        lastError: 'boom',
        lockedBy: null,
      });

      // Not claimable before the backoff elapses.
      clock.advance(99);
      expect(queue.claim('w', LEASE)).toBeNull();
      clock.advance(1);
      const a2 = queue.claim('w', LEASE)!;
      expect(a2.attempts).toBe(2);
      expect(queue.fail(a2, 'w', new Error('boom'))).toMatchObject({
        outcome: 'retry',
        delayMs: 200,
      });
    });

    it('caps the backoff at backoffMaxMs', () => {
      const q = new JobQueue(repo, clock, {
        defaultMaxAttempts: 10,
        backoffBaseMs: 400,
        backoffMaxMs: 1_000,
        random: () => 1,
      });
      q.enqueue({ type: 't', payload: {} });
      const delays: number[] = [];
      for (let i = 0; i < 4; i++) {
        const job = q.claim('w', LEASE)!;
        const r = q.fail(job, 'w', new Error('x'));
        if (r.outcome === 'retry') delays.push(r.delayMs);
        clock.advance(10_000);
      }
      expect(delays).toEqual([400, 800, 1_000, 1_000]);
    });

    it('dead-letters the job once maxAttempts is exhausted', () => {
      queue.enqueue({ type: 't', payload: {}, maxAttempts: 2 });
      queue.fail(queue.claim('w', LEASE)!, 'w', new Error('first'));
      clock.advance(10_000);
      const last = queue.claim('w', LEASE)!;
      expect(queue.fail(last, 'w', new Error('second'))).toEqual({ outcome: 'dead' });

      const dead = queue.get(last.id);
      expect(dead).toMatchObject({ status: 'dead', attempts: 2 });
      expect(dead.lastError).toContain('gave up after 2 attempts');
      expect(dead.finishedAt).toBe(clock.now());
      clock.advance(1_000_000);
      expect(queue.claim('w', LEASE)).toBeNull();
    });

    it.each([
      ['PermanentJobError', new PermanentJobError('bad payload')],
      ['non-retryable UpstreamError', new UpstreamError('404', false, 404)],
    ])('dead-letters immediately on %s', (_name, error) => {
      queue.enqueue({ type: 't', payload: {}, maxAttempts: 5 });
      const job = queue.claim('w', LEASE)!;
      expect(queue.fail(job, 'w', error)).toEqual({ outcome: 'dead' });
      expect(queue.get(job.id).attempts).toBe(1);
    });

    it('retries a retryable UpstreamError', () => {
      queue.enqueue({ type: 't', payload: {} });
      const job = queue.claim('w', LEASE)!;
      expect(queue.fail(job, 'w', new UpstreamError('503', true, 503)).outcome).toBe('retry');
    });
  });

  describe('lease expiry (crash recovery)', () => {
    it('re-claims a running job whose lease expired', () => {
      const { job } = queue.enqueue({ type: 't', payload: {} });
      queue.claim('crashed-worker', LEASE);

      clock.advance(LEASE); // lease boundary: still owned
      expect(queue.claim('w2', LEASE)).toBeNull();

      clock.advance(1);
      const reclaimed = queue.claim('w2', LEASE)!;
      expect(reclaimed).toMatchObject({ id: job.id, lockedBy: 'w2', attempts: 2 });
    });

    it('fences out the stale worker: its late completion is rejected', () => {
      queue.enqueue({ type: 't', payload: {} });
      const stale = queue.claim('w1', LEASE)!;
      clock.advance(LEASE + 1);
      const fresh = queue.claim('w2', LEASE)!;

      expect(queue.complete(stale, 'w1', 'late')).toBe(false);
      expect(queue.fail(stale, 'w1', new Error('late'))).toEqual({ outcome: 'lost' });
      expect(queue.heartbeat(stale, 'w1', LEASE)).toBe(false);

      expect(queue.complete(fresh, 'w2', 'ok')).toBe(true);
      expect(queue.get(fresh.id)).toMatchObject({ status: 'succeeded', result: 'ok' });
    });

    it('heartbeats extend the lease and prevent re-claim', () => {
      queue.enqueue({ type: 't', payload: {} });
      const job = queue.claim('w1', LEASE)!;
      clock.advance(800);
      expect(queue.heartbeat(job, 'w1', LEASE)).toBe(true);
      clock.advance(800); // 1600ms after claim, but only 800ms after heartbeat
      expect(queue.claim('w2', LEASE)).toBeNull();
    });

    it('dead-letters a job whose lease expired on its final attempt', () => {
      const { job } = queue.enqueue({ type: 't', payload: {}, maxAttempts: 1 });
      queue.claim('w1', LEASE);
      clock.advance(LEASE + 1);

      expect(queue.claim('w2', LEASE)).toBeNull();
      const dead = queue.get(job.id);
      expect(dead.status).toBe('dead');
      expect(dead.lastError).toMatch(/Lease expired on final attempt.*w1/);
    });
  });

  describe('manual retry', () => {
    it('re-queues a dead job with a fresh attempt budget', () => {
      queue.enqueue({ type: 't', payload: {}, maxAttempts: 1 });
      const job = queue.claim('w', LEASE)!;
      queue.fail(job, 'w', new Error('x'));

      const retried = queue.retry(job.id);
      expect(retried).toMatchObject({ status: 'queued', attempts: 0, finishedAt: null });
      expect(queue.claim('w', LEASE)?.id).toBe(job.id);
    });

    it('refuses to retry a job that is not dead', () => {
      const { job } = queue.enqueue({ type: 't', payload: {} });
      expect(() => queue.retry(job.id)).toThrow(ConflictError);
    });

    it('throws NotFound for unknown jobs', () => {
      expect(() => queue.retry('00000000-0000-4000-8000-000000000000')).toThrow(NotFoundError);
    });
  });

  describe('listing', () => {
    it('paginates newest-first with an opaque cursor and filters by status', () => {
      for (let i = 0; i < 5; i++) {
        queue.enqueue({ type: 't', payload: { i } });
        clock.advance(1);
      }
      queue.claim('w', LEASE);

      const p1 = queue.list({ limit: 2 });
      const p2 = queue.list({ limit: 2, cursor: p1.nextCursor! });
      const p3 = queue.list({ limit: 2, cursor: p2.nextCursor! });
      const ids = [...p1.data, ...p2.data, ...p3.data].map((j) => (j.payload as { i: number }).i);
      expect(ids).toEqual([4, 3, 2, 1, 0]);
      expect(p3.nextCursor).toBeNull();

      expect(queue.list({ limit: 10, status: 'running' }).data).toHaveLength(1);
      expect(queue.stats()).toEqual({ queued: 4, running: 1, succeeded: 0, dead: 0 });
    });
  });
});

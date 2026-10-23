import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue } from '../../src/application/queue/job-queue.js';
import { WorkerPool } from '../../src/application/queue/worker-pool.js';
import { SqliteJobRepository } from '../../src/infrastructure/db/repositories/sqlite-job-repository.js';
import { systemClock } from '../../src/shared/clock.js';
import { createTestDb, silentLogger, waitFor } from '../helpers/setup.js';

describe('WorkerPool', () => {
  let queue: JobQueue;
  let pool: WorkerPool;

  beforeEach(() => {
    queue = new JobQueue(new SqliteJobRepository(createTestDb()), systemClock, {
      defaultMaxAttempts: 3,
      backoffBaseMs: 1,
      backoffMaxMs: 5,
    });
    pool = new WorkerPool(
      queue,
      { concurrency: 2, pollIntervalMs: 5, leaseMs: 1_000 },
      silentLogger,
    );
  });

  it('runs a job and stores its result', async () => {
    pool.register('echo', (job) => Promise.resolve({ echoed: job.payload }));
    const { job } = queue.enqueue({ type: 'echo', payload: { hi: 1 } });
    await pool.runOnce();
    expect(queue.get(job.id)).toMatchObject({ status: 'succeeded', result: { echoed: { hi: 1 } } });
  });

  it('dead-letters jobs with no registered handler', async () => {
    const { job } = queue.enqueue({ type: 'unknown', payload: {} });
    await pool.runOnce();
    expect(queue.get(job.id)).toMatchObject({ status: 'dead', attempts: 1 });
  });

  it('retries failing jobs until they succeed', async () => {
    let calls = 0;
    pool.register('flaky', () => {
      calls++;
      return calls < 3 ? Promise.reject(new Error(`fail ${calls}`)) : Promise.resolve('ok');
    });
    const { job } = queue.enqueue({ type: 'flaky', payload: {} });
    pool.start();
    await waitFor(() => queue.get(job.id).status === 'succeeded');
    await pool.stop(1_000);
    expect(queue.get(job.id).attempts).toBe(3);
  });

  it('processes jobs concurrently up to the configured limit', async () => {
    let active = 0;
    let peak = 0;
    pool.register('slow', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
    });
    for (let i = 0; i < 6; i++) queue.enqueue({ type: 'slow', payload: { i } });
    pool.start();
    await waitFor(() => queue.stats().succeeded === 6);
    await pool.stop(1_000);
    expect(peak).toBe(2);
  });

  it('graceful stop waits for in-flight jobs to finish', async () => {
    let release!: () => void;
    pool.register('block', () => new Promise<void>((r) => (release = r)));
    const { job } = queue.enqueue({ type: 'block', payload: {} });
    pool.start();
    await waitFor(() => queue.get(job.id).status === 'running');

    const stopping = pool.stop(2_000);
    setTimeout(() => release(), 20);
    await expect(stopping).resolves.toEqual({ drained: true });
    expect(queue.get(job.id).status).toBe('succeeded');
  });

  it('aborts handlers that outlive the shutdown timeout', async () => {
    pool.register(
      'stuck',
      (_job, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason as Error));
        }),
    );
    const { job } = queue.enqueue({ type: 'stuck', payload: {} });
    pool.start();
    await waitFor(() => queue.get(job.id).status === 'running');

    await expect(pool.stop(30)).resolves.toEqual({ drained: false });
    expect(queue.get(job.id)).toMatchObject({
      status: 'queued',
      lastError: 'Worker shutting down',
    });
  });

  it('wakes idle workers immediately on enqueue', async () => {
    const slowPoll = new WorkerPool(
      queue,
      { concurrency: 1, pollIntervalMs: 60_000, leaseMs: 1_000 },
      silentLogger,
    );
    slowPoll.register('echo', () => Promise.resolve('ok'));
    slowPoll.start();
    await new Promise((r) => setTimeout(r, 20)); // let the worker go idle
    const { job } = queue.enqueue({ type: 'echo', payload: {} });
    await waitFor(() => queue.get(job.id).status === 'succeeded', { timeoutMs: 1_000 });
    await slowPoll.stop(1_000);
  });
});

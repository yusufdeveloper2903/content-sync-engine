import { describe, expect, it } from 'vitest';
import { JobQueue } from '../../src/application/queue/job-queue.js';
import { Scheduler } from '../../src/application/scheduler.js';
import { syncJob } from '../../src/application/sync/sync-job.js';
import { SqliteJobRepository } from '../../src/infrastructure/db/repositories/sqlite-job-repository.js';
import { ManualClock } from '../../src/shared/clock.js';
import { createTestDb, silentLogger } from '../helpers/setup.js';

describe('Scheduler', () => {
  it('enqueues at most one job per schedule slot, even across instances', () => {
    const clock = new ManualClock(60_000 * 100);
    const queue = new JobQueue(new SqliteJobRepository(createTestDb()), clock, {
      defaultMaxAttempts: 3,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    });
    const schedule = {
      name: 'inc',
      intervalMs: 60_000,
      job: () => syncJob({ mode: 'incremental' }),
    };
    const a = new Scheduler(queue, [schedule], clock, silentLogger);
    const b = new Scheduler(queue, [schedule], clock, silentLogger);

    expect(a.tick(schedule)?.created).toBe(true);
    expect(b.tick(schedule)?.created).toBe(false);
    clock.advance(30_000);
    expect(a.tick(schedule)?.created).toBe(false);
    clock.advance(30_000);
    expect(b.tick(schedule)?.created).toBe(true);

    expect(queue.list({ limit: 10 }).data).toHaveLength(2);
    expect(queue.list({ limit: 10 }).data[0]!.idempotencyKey).toBe('schedule:inc:101');
  });
});

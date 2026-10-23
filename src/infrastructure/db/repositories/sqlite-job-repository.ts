import type { Job, JobStatus } from '../../../domain/job.js';
import { JOB_STATUSES } from '../../../domain/job.js';
import type { InsertJobInput, JobListFilter, JobRepository, Page } from '../../../domain/ports.js';
import { decodeCursor, encodeCursor, isTimeIdCursor } from '../../../shared/cursor.js';
import type { Params, SqliteDatabase } from '../database.js';

interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: number;
  locked_by: string | null;
  locked_until: number | null;
  last_error: string | null;
  result: string | null;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  type: r.type,
  payload: JSON.parse(r.payload) as unknown,
  status: r.status,
  priority: r.priority,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  runAt: r.run_at,
  lockedBy: r.locked_by,
  lockedUntil: r.locked_until,
  lastError: r.last_error,
  result: r.result === null ? null : (JSON.parse(r.result) as unknown),
  idempotencyKey: r.idempotency_key,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(input: InsertJobInput): Job | null {
    const row = this.db.get<JobRow>(
      `INSERT INTO jobs (id, type, payload, status, priority, attempts, max_attempts, run_at,
                         idempotency_key, created_at, updated_at)
       VALUES ($id, $type, $payload, 'queued', $priority, 0, $maxAttempts, $runAt,
               $idempotencyKey, $now, $now)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      {
        id: input.id,
        type: input.type,
        payload: JSON.stringify(input.payload ?? {}),
        priority: input.priority,
        maxAttempts: input.maxAttempts,
        runAt: input.runAt,
        idempotencyKey: input.idempotencyKey,
        now: input.now,
      },
    );
    return row ? toJob(row) : null;
  }

  findById(id: string): Job | null {
    const row = this.db.get<JobRow>('SELECT * FROM jobs WHERE id = $id', { id });
    return row ? toJob(row) : null;
  }

  findByIdempotencyKey(key: string): Job | null {
    const row = this.db.get<JobRow>('SELECT * FROM jobs WHERE idempotency_key = $key', { key });
    return row ? toJob(row) : null;
  }

  claimNext(workerId: string, now: number, leaseMs: number): Job | null {
    return this.db.transaction(() => {
      // A lease that expired on the final attempt means the job crashed its worker every time
      // (or the process keeps dying mid-job). Don't hand it out again: dead-letter it.
      this.db.run(
        `UPDATE jobs
            SET status = 'dead',
                last_error = 'Lease expired on final attempt (last worker: ' || COALESCE(locked_by, '?') || ')',
                locked_by = NULL, locked_until = NULL,
                finished_at = $now, updated_at = $now
          WHERE status = 'running' AND locked_until < $now AND attempts >= max_attempts`,
        { now },
      );

      // Single UPDATE ... WHERE id = (SELECT ...) RETURNING statement: the row is selected and
      // locked in one step under the write lock, so two workers can never claim the same job.
      const row = this.db.get<JobRow>(
        `UPDATE jobs
            SET status = 'running',
                locked_by = $workerId,
                locked_until = $lockedUntil,
                attempts = attempts + 1,
                updated_at = $now
          WHERE id = (
                SELECT id FROM jobs
                 WHERE (status = 'queued' AND run_at <= $now)
                    OR (status = 'running' AND locked_until < $now)
                 ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
                 LIMIT 1)
        RETURNING *`,
        { workerId, lockedUntil: now + leaseMs, now },
      );
      return row ? toJob(row) : null;
    });
  }

  extendLease(id: string, workerId: string, lockedUntil: number, now: number): boolean {
    return (
      this.db.run(
        `UPDATE jobs SET locked_until = $lockedUntil, updated_at = $now
          WHERE id = $id AND status = 'running' AND locked_by = $workerId`,
        { id, workerId, lockedUntil, now },
      ).changes === 1
    );
  }

  markSucceeded(id: string, workerId: string, result: unknown, now: number): boolean {
    return (
      this.db.run(
        `UPDATE jobs
            SET status = 'succeeded', result = $result, last_error = NULL,
                locked_by = NULL, locked_until = NULL, finished_at = $now, updated_at = $now
          WHERE id = $id AND status = 'running' AND locked_by = $workerId`,
        { id, workerId, result: JSON.stringify(result ?? null), now },
      ).changes === 1
    );
  }

  markForRetry(id: string, workerId: string, error: string, runAt: number, now: number): boolean {
    return (
      this.db.run(
        `UPDATE jobs
            SET status = 'queued', run_at = $runAt, last_error = $error,
                locked_by = NULL, locked_until = NULL, updated_at = $now
          WHERE id = $id AND status = 'running' AND locked_by = $workerId`,
        { id, workerId, error, runAt, now },
      ).changes === 1
    );
  }

  markDead(id: string, workerId: string, error: string, now: number): boolean {
    return (
      this.db.run(
        `UPDATE jobs
            SET status = 'dead', last_error = $error,
                locked_by = NULL, locked_until = NULL, finished_at = $now, updated_at = $now
          WHERE id = $id AND status = 'running' AND locked_by = $workerId`,
        { id, workerId, error, now },
      ).changes === 1
    );
  }

  requeue(id: string, now: number): Job | null {
    const row = this.db.get<JobRow>(
      `UPDATE jobs
          SET status = 'queued', attempts = 0, run_at = $now, finished_at = NULL, updated_at = $now
        WHERE id = $id AND status = 'dead'
      RETURNING *`,
      { id, now },
    );
    return row ? toJob(row) : null;
  }

  list(filter: JobListFilter): Page<Job> {
    const where: string[] = [];
    const params: Params = { limit: filter.limit + 1 };
    if (filter.status) {
      where.push('status = $status');
      params.status = filter.status;
    }
    if (filter.type) {
      where.push('type = $type');
      params.type = filter.type;
    }
    if (filter.cursor) {
      const c = decodeCursor(filter.cursor, isTimeIdCursor);
      where.push('(created_at < $ct OR (created_at = $ct AND id < $cid))');
      params.ct = c.t;
      params.cid = c.id;
    }
    const rows = this.db.all<JobRow>(
      `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT $limit`,
      params,
    );
    const hasMore = rows.length > filter.limit;
    const data = rows.slice(0, filter.limit).map(toJob);
    const last = data.at(-1);
    return {
      data,
      nextCursor: hasMore && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null,
    };
  }

  countByStatus(): Record<JobStatus, number> {
    const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
    for (const r of this.db.all<{ status: JobStatus; n: number }>(
      'SELECT status, COUNT(*) AS n FROM jobs GROUP BY status',
    )) {
      counts[r.status] = r.n;
    }
    return counts;
  }
}

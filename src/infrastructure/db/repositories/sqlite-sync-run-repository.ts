import type { Resource, SyncMode, SyncRun, SyncRunStatus } from '../../../domain/content.js';
import type { Page, SyncRunListFilter, SyncRunRepository } from '../../../domain/ports.js';
import type { SyncCounts } from '../../../domain/content.js';
import { decodeCursor, encodeCursor, isIdCursor } from '../../../shared/cursor.js';
import type { Params, SqliteDatabase } from '../database.js';

interface SyncRunRow {
  id: number;
  job_id: string | null;
  resource: Resource;
  mode: SyncMode;
  status: SyncRunStatus;
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skipped: number;
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

const toSyncRun = (r: SyncRunRow): SyncRun => ({
  id: r.id,
  jobId: r.job_id,
  resource: r.resource,
  mode: r.mode,
  status: r.status,
  fetched: r.fetched,
  inserted: r.inserted,
  updated: r.updated,
  unchanged: r.unchanged,
  deleted: r.deleted,
  skipped: r.skipped,
  error: r.error,
  startedAt: new Date(r.started_at).toISOString(),
  finishedAt: r.finished_at === null ? null : new Date(r.finished_at).toISOString(),
  durationMs: r.finished_at === null ? null : r.finished_at - r.started_at,
});

export class SqliteSyncRunRepository implements SyncRunRepository {
  constructor(private readonly db: SqliteDatabase) {}

  start(input: { jobId: string | null; resource: Resource; mode: SyncMode; now: number }): number {
    const row = this.db.get<{ id: number }>(
      `INSERT INTO sync_runs (job_id, resource, mode, status, started_at)
       VALUES ($jobId, $resource, $mode, 'running', $now)
       RETURNING id`,
      input,
    );
    if (!row) throw new Error('Failed to insert sync run');
    return row.id;
  }

  finish(
    id: number,
    input: {
      status: 'succeeded' | 'failed';
      counts: SyncCounts;
      error: string | null;
      now: number;
    },
  ): void {
    this.db.run(
      `UPDATE sync_runs
          SET status = $status, fetched = $fetched, inserted = $inserted, updated = $updated,
              unchanged = $unchanged, deleted = $deleted, skipped = $skipped,
              error = $error, finished_at = $now
        WHERE id = $id`,
      { id, status: input.status, error: input.error, now: input.now, ...input.counts },
    );
  }

  findById(id: number): SyncRun | null {
    const row = this.db.get<SyncRunRow>('SELECT * FROM sync_runs WHERE id = $id', { id });
    return row ? toSyncRun(row) : null;
  }

  list(filter: SyncRunListFilter): Page<SyncRun> {
    const where: string[] = [];
    const params: Params = { limit: filter.limit + 1 };
    if (filter.jobId) {
      where.push('job_id = $jobId');
      params.jobId = filter.jobId;
    }
    if (filter.resource) {
      where.push('resource = $resource');
      params.resource = filter.resource;
    }
    if (filter.status) {
      where.push('status = $status');
      params.status = filter.status;
    }
    if (filter.cursor) {
      where.push('id < $beforeId');
      params.beforeId = decodeCursor(filter.cursor, isIdCursor).id;
    }
    const rows = this.db.all<SyncRunRow>(
      `SELECT * FROM sync_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY id DESC LIMIT $limit`,
      params,
    );
    const hasMore = rows.length > filter.limit;
    const data = rows.slice(0, filter.limit).map(toSyncRun);
    const last = data.at(-1);
    return { data, nextCursor: hasMore && last ? encodeCursor({ id: last.id }) : null };
  }
}

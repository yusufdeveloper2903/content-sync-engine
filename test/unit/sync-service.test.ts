import { beforeEach, describe, expect, it } from 'vitest';
import { SyncService } from '../../src/application/sync/sync-service.js';
import { UpstreamError } from '../../src/domain/errors.js';
import type { SqliteDatabase } from '../../src/infrastructure/db/database.js';
import { SqliteContentRepository } from '../../src/infrastructure/db/repositories/sqlite-content-repository.js';
import { SqliteSyncRunRepository } from '../../src/infrastructure/db/repositories/sqlite-sync-run-repository.js';
import { ManualClock } from '../../src/shared/clock.js';
import { FakeUpstream } from '../helpers/fake-upstream.js';
import { createTestDb, silentLogger } from '../helpers/setup.js';

describe('SyncService', () => {
  let db: SqliteDatabase;
  let upstream: FakeUpstream;
  let content: SqliteContentRepository;
  let runs: SqliteSyncRunRepository;
  let sync: SyncService;

  beforeEach(() => {
    db = createTestDb();
    const clock = new ManualClock();
    upstream = new FakeUpstream();
    content = new SqliteContentRepository(db, clock);
    runs = new SqliteSyncRunRepository(db);
    sync = new SyncService(upstream, content, runs, clock, silentLogger);
  });

  const count = (table: string) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n;

  it('full sync loads every resource in dependency order and audits each one', async () => {
    const summary = await sync.sync('full', ['todos', 'comments', 'posts', 'users']);

    expect(upstream.calls.map((c) => c.resource)).toEqual(['users', 'posts', 'comments', 'todos']);
    expect(summary.resources.posts).toMatchObject({ fetched: 4, inserted: 4, deleted: 0 });
    expect([count('users'), count('posts'), count('comments'), count('todos')]).toEqual([
      2, 4, 5, 5,
    ]);

    const audit = runs.list({ limit: 10 }).data;
    expect(audit).toHaveLength(4);
    expect(audit.every((r) => r.status === 'succeeded')).toBe(true);
  });

  it('a second full sync is a no-op write-wise', async () => {
    await sync.sync('full', ['users', 'posts']);
    const second = await sync.sync('full', ['users', 'posts']);
    expect(second.resources.posts).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });
  });

  it('full sync applies updates and prunes records deleted upstream', async () => {
    await sync.sync('full', ['users', 'posts']);
    upstream.data.posts = [
      { ...upstream.data.posts[0]!, title: 'changed' },
      ...upstream.data.posts.slice(1, 3),
    ];
    const summary = await sync.sync('full', ['posts']);
    expect(summary.resources.posts).toMatchObject({
      fetched: 3,
      updated: 1,
      unchanged: 2,
      deleted: 1,
    });
    expect(content.existingIds('posts')).toEqual(new Set([1, 2, 3]));
  });

  it('incremental sync only fetches above the high-water mark', async () => {
    await sync.sync('full', ['users', 'posts']);
    upstream.data.posts.push({ id: 5, userId: 2, title: 'new', body: 'fresh' });

    const summary = await sync.sync('incremental', ['posts']);
    expect(upstream.calls.at(-1)).toEqual({ resource: 'posts', minId: 5 });
    expect(summary.resources.posts).toMatchObject({ fetched: 1, inserted: 1, deleted: 0 });
  });

  it('skips orphans whose parent has not been synced', async () => {
    await sync.sync('full', ['users']);
    const summary = await sync.sync('full', ['comments']);
    expect(summary.resources.comments).toMatchObject({ fetched: 5, inserted: 0, skipped: 5 });
  });

  it('refuses to prune a table when upstream returns nothing on a full sync', async () => {
    await sync.sync('full', ['users', 'posts']);
    upstream.data.posts = [];
    const summary = await sync.sync('full', ['posts']);
    expect(summary.resources.posts).toMatchObject({ fetched: 0, deleted: 0 });
    expect(count('posts')).toBe(4);
  });

  it('records failed runs and rethrows', async () => {
    upstream.failWith(new UpstreamError('HTTP 503', true, 503));
    await expect(sync.sync('full', ['users'])).rejects.toThrow('HTTP 503');
    expect(runs.list({ limit: 1 }).data[0]).toMatchObject({
      status: 'failed',
      error: 'HTTP 503',
      resource: 'users',
    });
  });

  it('honours cancellation between resources', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('stop'));
    await expect(sync.sync('full', ['users'], { signal: ctl.signal })).rejects.toThrow('stop');
    expect(upstream.calls).toHaveLength(0);
  });
});

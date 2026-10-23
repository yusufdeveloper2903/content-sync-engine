import { beforeEach, describe, expect, it } from 'vitest';
import type { SqliteDatabase } from '../../src/infrastructure/db/database.js';
import { migrate } from '../../src/infrastructure/db/migrator.js';
import {
  SqliteContentQueryRepository,
  toFtsQuery,
} from '../../src/infrastructure/db/repositories/sqlite-content-query-repository.js';
import { SqliteContentRepository } from '../../src/infrastructure/db/repositories/sqlite-content-repository.js';
import { SqliteSyncRunRepository } from '../../src/infrastructure/db/repositories/sqlite-sync-run-repository.js';
import { ManualClock } from '../../src/shared/clock.js';
import { ValidationError } from '../../src/domain/errors.js';
import * as fx from '../helpers/fixtures.js';
import { createTestDb } from '../helpers/setup.js';

describe('SQLite repositories', () => {
  let db: SqliteDatabase;
  let clock: ManualClock;
  let content: SqliteContentRepository;
  let queries: SqliteContentQueryRepository;

  const seed = () => {
    content.upsert('users', fx.users);
    content.upsert('posts', fx.posts);
    content.upsert('comments', fx.comments);
    content.upsert('todos', fx.todos);
  };

  beforeEach(() => {
    db = createTestDb();
    clock = new ManualClock();
    content = new SqliteContentRepository(db, clock);
    queries = new SqliteContentQueryRepository(db);
  });

  describe('migrator', () => {
    it('is idempotent', () => {
      expect(migrate(db)).toBe(0);
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM schema_migrations')?.n).toBe(4);
    });

    it('detects edited migrations', () => {
      expect(() => migrate(db, undefined, [{ id: 1, name: 'renamed', up: '' }])).toThrow(
        /applied as/,
      );
    });
  });

  describe('ContentRepository', () => {
    it('classifies upserts as inserted / updated / unchanged via content hashes', () => {
      expect(content.upsert('users', fx.users)).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
      expect(content.upsert('users', fx.users)).toEqual({ inserted: 0, updated: 0, unchanged: 2 });

      const changed = [{ ...fx.users[0]!, name: 'Renamed' }, fx.users[1]!];
      expect(content.upsert('users', changed)).toEqual({ inserted: 0, updated: 1, unchanged: 1 });
      expect(db.get<{ name: string }>('SELECT name FROM users WHERE id = 1')?.name).toBe('Renamed');
    });

    it('deletes rows missing upstream and cascades to children', () => {
      seed();
      expect(content.deleteMissing('posts', [2, 3, 4])).toBe(1);
      expect(content.existingIds('posts')).toEqual(new Set([2, 3, 4]));
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM comments WHERE post_id = 1')?.n).toBe(
        0,
      );
    });

    it('rolls back the whole batch when a row violates a constraint', () => {
      content.upsert('users', fx.users);
      const bad = [fx.posts[0]!, { ...fx.posts[1]!, userId: 999 }];
      expect(() => content.upsert('posts', bad)).toThrow();
      expect(content.maxId('posts')).toBe(0);
    });

    it('reports max id', () => {
      expect(content.maxId('posts')).toBe(0);
      seed();
      expect(content.maxId('posts')).toBe(4);
    });
  });

  describe('ContentQueryRepository', () => {
    beforeEach(seed);

    it('paginates posts with a keyset cursor', () => {
      const p1 = queries.listPosts({ limit: 3 });
      expect(p1.data.map((p) => p.id)).toEqual([1, 2, 3]);
      const p2 = queries.listPosts({ limit: 3, cursor: p1.nextCursor! });
      expect(p2.data.map((p) => p.id)).toEqual([4]);
      expect(p2.nextCursor).toBeNull();
    });

    it('rejects malformed cursors', () => {
      expect(() => queries.listPosts({ limit: 3, cursor: 'garbage' })).toThrow(ValidationError);
    });

    it('filters by userId', () => {
      expect(queries.listPosts({ limit: 10, userId: 2 }).data.map((p) => p.id)).toEqual([4]);
    });

    it('full-text searches title and body with prefix matching', () => {
      expect(queries.listPosts({ limit: 10, search: 'occaecati' }).data.map((p) => p.id)).toEqual([
        3, 4,
      ]);
      expect(queries.listPosts({ limit: 10, search: 'molest' }).data.map((p) => p.id)).toEqual([3]);
      expect(
        queries.listPosts({ limit: 10, search: 'occaecati eum' }).data.map((p) => p.id),
      ).toEqual([4]);
      expect(queries.listPosts({ limit: 10, search: '"); DROP TABLE posts; --' }).data).toEqual([]);
    });

    it('keeps the FTS index in sync with updates and deletes', () => {
      content.upsert('posts', [{ ...fx.posts[0]!, title: 'brand new zeppelin' }]);
      expect(queries.listPosts({ limit: 10, search: 'zeppelin' }).data.map((p) => p.id)).toEqual([
        1,
      ]);
      expect(queries.listPosts({ limit: 10, search: 'facere' }).data).toEqual([]);
      content.deleteMissing('posts', [2, 3, 4]);
      expect(queries.listPosts({ limit: 10, search: 'zeppelin' }).data).toEqual([]);
    });

    it('loads a post with author and ordered comments', () => {
      const post = queries.getPostWithRelations(1)!;
      expect(post.author).toEqual({
        id: 1,
        name: 'Leanne Graham',
        username: 'Bret',
        email: 'leanne@example.com',
      });
      expect(post.comments.map((c) => c.id)).toEqual([1, 2, 3]);
      expect(queries.getPostWithRelations(3)!.comments).toEqual([]);
      expect(queries.getPostWithRelations(999)).toBeNull();
    });

    it('computes user stats in SQL', () => {
      expect(queries.getUserStats(1)).toEqual({
        userId: 1,
        name: 'Leanne Graham',
        posts: { total: 3, avgBodyLength: expect.any(Number) as number },
        comments: { receivedTotal: 4, avgPerPost: 1.33, uniqueCommenters: 3 },
        todos: { total: 4, completed: 3, completionRate: 0.75 },
        mostCommentedPost: { id: 1, title: 'sunt aut facere repellat', comments: 3 },
      });
      expect(queries.getUserStats(999)).toBeNull();
    });

    it('handles users without content', () => {
      content.upsert('users', [{ ...fx.users[1]!, id: 3 }]);
      expect(queries.getUserStats(3)).toMatchObject({
        posts: { total: 0, avgBodyLength: 0 },
        comments: { receivedTotal: 0, avgPerPost: 0 },
        todos: { total: 0, completionRate: 0 },
        mostCommentedPost: null,
      });
    });
  });

  describe('SyncRunRepository', () => {
    it('records and lists runs newest-first', () => {
      const runs = new SqliteSyncRunRepository(db);
      const a = runs.start({ jobId: null, resource: 'users', mode: 'full', now: 1_000 });
      const b = runs.start({ jobId: null, resource: 'posts', mode: 'full', now: 2_000 });
      runs.finish(a, {
        status: 'succeeded',
        counts: { fetched: 2, inserted: 2, updated: 0, unchanged: 0, deleted: 0, skipped: 0 },
        error: null,
        now: 1_500,
      });

      expect(runs.findById(a)).toMatchObject({ status: 'succeeded', fetched: 2, durationMs: 500 });
      expect(runs.list({ limit: 10 }).data.map((r) => r.id)).toEqual([b, a]);
      expect(runs.list({ limit: 10, status: 'running' }).data.map((r) => r.id)).toEqual([b]);
      const p1 = runs.list({ limit: 1 });
      expect(runs.list({ limit: 1, cursor: p1.nextCursor! }).data.map((r) => r.id)).toEqual([a]);
    });
  });
});

describe('toFtsQuery', () => {
  it('quotes tokens and strips FTS operators', () => {
    expect(toFtsQuery('Hello  world')).toBe('"hello"* "world"*');
    expect(toFtsQuery('a OR b* NEAR(c)')).toBe('"a"* "or"* "b"* "near"* "c"*');
    expect(toFtsQuery('  ***  ')).toBeNull();
  });
});

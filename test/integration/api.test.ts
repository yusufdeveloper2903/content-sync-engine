import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Container } from '../../src/composition-root.js';
import { UpstreamError } from '../../src/domain/errors.js';
import { FakeUpstream } from '../helpers/fake-upstream.js';
import { createTestContainer, waitFor } from '../helpers/setup.js';

interface JobBody {
  id: string;
  status: string;
  attempts: number;
  lastError: string | null;
  result: unknown;
}

describe('HTTP API', () => {
  let upstream: FakeUpstream;
  let c: Container;

  beforeEach(() => {
    upstream = new FakeUpstream();
    c = createTestContainer({ upstream });
  });

  afterEach(async () => {
    await c.workers.stop(1_000);
    c.db.close();
  });

  /** Enqueue a full sync over HTTP and drive it to completion deterministically. */
  async function syncAll(): Promise<JobBody> {
    const res = await request(c.app)
      .post('/jobs')
      .send({ type: 'sync', payload: { mode: 'full' } })
      .expect(202);
    const body = res.body as JobBody;
    await c.workers.runOnce();
    return body;
  }

  describe('ops', () => {
    it('GET /health is always ok', async () => {
      await request(c.app)
        .get('/health')
        .expect(200)
        .expect((r) => expect(r.body).toMatchObject({ status: 'ok' }));
    });

    it('GET /ready reflects workers and shutdown state', async () => {
      // Workers are enabled in config but not started yet -> not ready.
      await request(c.app).get('/ready').expect(503);
      c.workers.start();
      await request(c.app)
        .get('/ready')
        .expect(200)
        .expect((r) =>
          expect(r.body).toEqual({
            status: 'ready',
            checks: { database: 'ok', lifecycle: 'ok', workers: 'ok' },
          }),
        );
      c.lifecycle.shuttingDown = true;
      await request(c.app).get('/ready').expect(503);
    });

    it('serves the OpenAPI document and Swagger UI', async () => {
      const spec = await request(c.app).get('/openapi.json').expect(200);
      expect((spec.body as { openapi: string }).openapi).toBe('3.1.0');
      await request(c.app).get('/docs/').expect(200).expect('content-type', /html/);
    });

    it('propagates or generates X-Request-Id', async () => {
      const echoed = await request(c.app).get('/health').set('X-Request-Id', 'abc-123');
      expect(echoed.headers['x-request-id']).toBe('abc-123');
      const generated = await request(c.app).get('/health');
      expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('returns RFC 7807 for unknown routes', async () => {
      const res = await request(c.app)
        .get('/nope')
        .expect(404)
        .expect('content-type', /application\/problem\+json/);
      expect(res.body).toMatchObject({
        status: 404,
        title: 'Not Found',
        instance: '/nope',
        requestId: expect.any(String) as string,
      });
    });
  });

  describe('jobs', () => {
    it('enqueues a sync job and processes it end to end', async () => {
      const job = await syncAll();
      const res = await request(c.app).get(`/jobs/${job.id}`).expect(200);
      expect(res.body).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect((res.body as JobBody).result).toMatchObject({
        mode: 'full',
        resources: { posts: { inserted: 4 } },
      });
    });

    it('sets Location and applies payload defaults', async () => {
      const res = await request(c.app).post('/jobs').send({ type: 'sync' }).expect(202);
      expect(res.headers.location).toBe(`/jobs/${(res.body as JobBody).id}`);
      expect(res.body).toMatchObject({
        status: 'queued',
        payload: { mode: 'incremental', resources: ['users', 'posts', 'comments', 'todos'] },
      });
    });

    it('honours Idempotency-Key', async () => {
      const send = (payload: unknown) =>
        request(c.app)
          .post('/jobs')
          .set('Idempotency-Key', 'nightly-2026-10-23')
          .send({ type: 'sync', payload });

      const first = await send({ mode: 'full' }).expect(202);
      const replay = await send({ mode: 'full' }).expect(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect((replay.body as JobBody).id).toBe((first.body as JobBody).id);

      const conflict = await send({ mode: 'incremental' }).expect(422);
      expect(conflict.body).toMatchObject({
        status: 422,
        type: expect.stringContaining('idempotency-key-reused') as string,
      });
    });

    it.each([
      [{ type: 'nope' }],
      [{ type: 'sync', payload: { mode: 'sideways' } }],
      [{ type: 'sync', payload: { resources: [] } }],
      [{ type: 'sync', payload: { resources: ['planets'] } }],
      [{ type: 'sync', priority: 1000 }],
      [{ type: 'sync', extra: true }],
    ])('rejects invalid body %j with 400 problem details', async (body) => {
      const res = await request(c.app).post('/jobs').send(body).expect(400);
      expect(res.body).toMatchObject({ status: 400, title: 'Validation Failed' });
      expect((res.body as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
    });

    it('rejects malformed JSON with 400', async () => {
      const res = await request(c.app)
        .post('/jobs')
        .set('content-type', 'application/json')
        .send('{"type":')
        .expect(400);
      expect(res.body).toMatchObject({ title: 'Malformed JSON body' });
    });

    it('retries transient upstream failures, then dead-letters and supports manual retry', async () => {
      upstream.failWith(
        ...Array.from({ length: 3 }, () => new UpstreamError('HTTP 503', true, 503)),
      );
      const res = await request(c.app)
        .post('/jobs')
        .send({ type: 'sync', payload: { mode: 'full', resources: ['users'] }, maxAttempts: 2 })
        .expect(202);
      const id = (res.body as JobBody).id;

      c.workers.start();
      const dead = await waitFor(() => {
        const j = c.queue.get(id);
        return j.status === 'dead' ? j : null;
      });
      await c.workers.stop(1_000);
      expect(dead.attempts).toBe(2);
      expect(dead.lastError).toContain('HTTP 503');

      const failedRuns = await request(c.app)
        .get(`/sync-runs?jobId=${id}&status=failed`)
        .expect(200);
      expect((failedRuns.body as { data: unknown[] }).data).toHaveLength(2);

      // One more scripted failure, then upstream recovers.
      await request(c.app)
        .post(`/jobs/${id}/retry`)
        .expect(202)
        .expect((r) => expect(r.body).toMatchObject({ status: 'queued', attempts: 0 }));
      await c.workers.runOnce();
      await waitFor(() => c.queue.get(id).status === 'queued' || null);
      c.workers.start();
      await waitFor(() => c.queue.get(id).status === 'succeeded' || null);
    });

    it('POST /jobs/:id/retry returns 409 for non-dead jobs and 404 for unknown ones', async () => {
      const res = await request(c.app).post('/jobs').send({ type: 'sync' }).expect(202);
      await request(c.app)
        .post(`/jobs/${(res.body as JobBody).id}/retry`)
        .expect(409);
      await request(c.app).post('/jobs/7d4f8a52-3c1e-4b7a-9f0e-2a6b5c8d9e10/retry').expect(404);
      await request(c.app).post('/jobs/not-a-uuid/retry').expect(400);
    });

    it('lists jobs with filters and cursor pagination', async () => {
      for (let i = 0; i < 3; i++)
        await request(c.app).post('/jobs').send({ type: 'sync', priority: i }).expect(202);
      const p1 = await request(c.app).get('/jobs?limit=2').expect(200);
      const body1 = p1.body as { data: JobBody[]; page: { nextCursor: string } };
      expect(body1.data).toHaveLength(2);
      const p2 = await request(c.app)
        .get(`/jobs?limit=2&cursor=${body1.page.nextCursor}`)
        .expect(200);
      expect((p2.body as { data: JobBody[] }).data).toHaveLength(1);

      await request(c.app)
        .get('/jobs?status=succeeded')
        .expect(200)
        .expect((r) => expect((r.body as { data: unknown[] }).data).toEqual([]));
      await request(c.app).get('/jobs?status=bogus').expect(400);
      await request(c.app)
        .get('/jobs/stats')
        .expect(200)
        .expect((r) => expect(r.body).toMatchObject({ queued: 3 }));
    });
  });

  describe('content', () => {
    beforeEach(async () => {
      await syncAll();
    });

    it('GET /posts paginates with cursors', async () => {
      const p1 = await request(c.app).get('/posts?limit=3').expect(200);
      const b1 = p1.body as {
        data: { id: number }[];
        page: { nextCursor: string | null; limit: number };
      };
      expect(b1.data.map((p) => p.id)).toEqual([1, 2, 3]);
      expect(b1.page.limit).toBe(3);

      const p2 = await request(c.app)
        .get('/posts')
        .query({ limit: 3, cursor: b1.page.nextCursor })
        .expect(200);
      const b2 = p2.body as typeof b1;
      expect(b2.data.map((p) => p.id)).toEqual([4]);
      expect(b2.page.nextCursor).toBeNull();
    });

    it('GET /posts filters by userId and searches', async () => {
      const byUser = await request(c.app).get('/posts?userId=2').expect(200);
      expect((byUser.body as { data: { id: number }[] }).data.map((p) => p.id)).toEqual([4]);
      const search = await request(c.app).get('/posts').query({ q: 'occaecati' }).expect(200);
      expect((search.body as { data: { id: number }[] }).data.map((p) => p.id)).toEqual([3, 4]);
    });

    it.each(['limit=0', 'limit=101', 'limit=abc', 'userId=-1', 'cursor=%25%25', 'foo=bar'])(
      'GET /posts?%s -> 400',
      async (qs) => {
        await request(c.app)
          .get(`/posts?${qs}`)
          .expect(400)
          .expect('content-type', /problem\+json/);
      },
    );

    it('GET /posts/:id includes author and comments', async () => {
      const res = await request(c.app).get('/posts/1').expect(200);
      expect(res.body).toMatchObject({
        id: 1,
        author: { id: 1, username: 'Bret' },
        comments: [{ id: 1 }, { id: 2 }, { id: 3 }],
      });
      await request(c.app).get('/posts/999').expect(404);
      await request(c.app).get('/posts/abc').expect(400);
    });

    it('GET /users/:id/stats aggregates', async () => {
      const res = await request(c.app).get('/users/1/stats').expect(200);
      expect(res.body).toMatchObject({
        userId: 1,
        posts: { total: 3 },
        comments: { receivedTotal: 4 },
        todos: { total: 4, completed: 3, completionRate: 0.75 },
        mostCommentedPost: { id: 1, comments: 3 },
      });
      await request(c.app).get('/users/42/stats').expect(404);
    });

    it('GET /sync-runs exposes the audit trail', async () => {
      const res = await request(c.app).get('/sync-runs?resource=posts').expect(200);
      expect((res.body as { data: unknown[] }).data).toEqual([
        expect.objectContaining({
          resource: 'posts',
          mode: 'full',
          status: 'succeeded',
          inserted: 4,
        }),
      ]);
    });

    it('incremental sync picks up new upstream records', async () => {
      upstream.data.posts.push({ id: 5, userId: 2, title: 'fresh zeppelin', body: 'news' });
      await request(c.app)
        .post('/jobs')
        .send({ type: 'sync', payload: { mode: 'incremental', resources: ['posts'] } })
        .expect(202);
      await c.workers.runOnce();
      const res = await request(c.app).get('/posts?q=zeppelin').expect(200);
      expect((res.body as { data: { id: number }[] }).data.map((p) => p.id)).toEqual([5]);
    });
  });
});

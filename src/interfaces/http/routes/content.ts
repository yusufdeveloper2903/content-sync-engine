import { Router } from 'express';
import type { ContentQueries } from '../../../application/queries/content-queries.js';
import { IdParams, ListPostsQuery, ListSyncRunsQuery } from '../schemas.js';
import { parseInput } from '../validation.js';

export function contentRoutes(queries: ContentQueries): Router {
  const router = Router();

  router.get('/posts', (req, res) => {
    const q = parseInput(ListPostsQuery, req.query, 'query');
    const page = queries.listPosts({
      limit: q.limit,
      cursor: q.cursor,
      userId: q.userId,
      search: q.q,
    });
    res.json({ data: page.data, page: { limit: q.limit, nextCursor: page.nextCursor } });
  });

  router.get('/posts/:id', (req, res) => {
    const { id } = parseInput(IdParams, req.params, 'params');
    res.json(queries.getPost(id));
  });

  router.get('/users/:id/stats', (req, res) => {
    const { id } = parseInput(IdParams, req.params, 'params');
    res.json(queries.getUserStats(id));
  });

  router.get('/sync-runs', (req, res) => {
    const q = parseInput(ListSyncRunsQuery, req.query, 'query');
    const page = queries.listSyncRuns(q);
    res.json({ data: page.data, page: { limit: q.limit, nextCursor: page.nextCursor } });
  });

  return router;
}

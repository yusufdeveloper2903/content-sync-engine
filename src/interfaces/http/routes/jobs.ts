import { Router } from 'express';
import type { JobQueue } from '../../../application/queue/job-queue.js';
import type { Clock } from '../../../domain/ports.js';
import { toJobDto } from '../dto.js';
import { CreateJobBody, IdempotencyKeyHeader, JobIdParams, ListJobsQuery } from '../schemas.js';
import { parseInput } from '../validation.js';

export function jobRoutes(queue: JobQueue, clock: Clock): Router {
  const router = Router();

  router.post('/jobs', (req, res) => {
    const idempotencyKey = parseInput(IdempotencyKeyHeader, req.get('idempotency-key'), 'headers');
    const body = parseInput(CreateJobBody, req.body ?? {}, 'body');

    const { job, created } = queue.enqueue({
      type: body.type,
      payload: body.payload,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
      ...(body.delayMs !== undefined ? { runAt: clock.now() + body.delayMs } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    res.setHeader('Location', `/jobs/${job.id}`);
    if (!created) res.setHeader('Idempotent-Replayed', 'true');
    res.status(created ? 202 : 200).json(toJobDto(job));
  });

  router.get('/jobs', (req, res) => {
    const q = parseInput(ListJobsQuery, req.query, 'query');
    const page = queue.list(q);
    res.json({
      data: page.data.map(toJobDto),
      page: { limit: q.limit, nextCursor: page.nextCursor },
    });
  });

  router.get('/jobs/stats', (_req, res) => {
    res.json(queue.stats());
  });

  router.get('/jobs/:id', (req, res) => {
    const { id } = parseInput(JobIdParams, req.params, 'params');
    res.json(toJobDto(queue.get(id)));
  });

  router.post('/jobs/:id/retry', (req, res) => {
    const { id } = parseInput(JobIdParams, req.params, 'params');
    res.status(202).json(toJobDto(queue.retry(id)));
  });

  return router;
}

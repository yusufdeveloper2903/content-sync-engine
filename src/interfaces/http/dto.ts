import type { Job } from '../../domain/job.js';

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export const toJobDto = (job: Job) => ({
  id: job.id,
  type: job.type,
  status: job.status,
  payload: job.payload,
  priority: job.priority,
  attempts: job.attempts,
  maxAttempts: job.maxAttempts,
  idempotencyKey: job.idempotencyKey,
  runAt: iso(job.runAt),
  lockedBy: job.lockedBy,
  lockedUntil: iso(job.lockedUntil),
  lastError: job.lastError,
  result: job.result,
  createdAt: iso(job.createdAt),
  updatedAt: iso(job.updatedAt),
  finishedAt: iso(job.finishedAt),
});

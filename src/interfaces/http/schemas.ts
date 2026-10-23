import { z } from 'zod';
import { RESOURCES } from '../../domain/content.js';
import { JOB_STATUSES } from '../../domain/job.js';
import { SYNC_JOB_TYPE, SyncJobPayloadSchema } from '../../application/sync/sync-job.js';

const limit = z.coerce.number().int().min(1).max(100).default(20);
const cursor = z.string().min(1).max(512).optional();
export const positiveId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const IdParams = z.object({ id: positiveId });
export const JobIdParams = z.object({ id: z.uuid() });

export const ListPostsQuery = z
  .object({
    limit,
    cursor,
    userId: positiveId.optional(),
    q: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const ListJobsQuery = z
  .object({
    limit,
    cursor,
    status: z.enum(JOB_STATUSES).optional(),
    type: z.string().max(100).optional(),
  })
  .strict();

export const ListSyncRunsQuery = z
  .object({
    limit,
    cursor,
    jobId: z.uuid().optional(),
    resource: z.enum(RESOURCES).optional(),
    status: z.enum(['running', 'succeeded', 'failed']).optional(),
  })
  .strict();

const jobCommon = {
  priority: z.number().int().min(-100).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(25).optional(),
  delayMs: z.number().int().min(0).max(86_400_000).optional(),
};

/** Discriminated on `type` so new job types slot in without touching the route. */
export const CreateJobBody = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal(SYNC_JOB_TYPE),
      payload: SyncJobPayloadSchema.default({ mode: 'incremental', resources: [...RESOURCES] }),
      ...jobCommon,
    })
    .strict(),
]);

export const IdempotencyKeyHeader = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'must be printable ASCII')
  .optional();

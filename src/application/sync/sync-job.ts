import { z } from 'zod';
import { RESOURCES } from '../../domain/content.js';
import { PermanentJobError } from '../../domain/errors.js';
import type { NewJob } from '../../domain/job.js';
import type { JobHandler } from '../queue/worker-pool.js';
import type { SyncService } from './sync-service.js';

export const SYNC_JOB_TYPE = 'sync';

export const SyncJobPayloadSchema = z
  .object({
    mode: z.enum(['full', 'incremental']).default('incremental'),
    resources: z
      .array(z.enum(RESOURCES))
      .min(1)
      .default([...RESOURCES])
      .transform((r) => [...new Set(r)]),
  })
  .strict();

export type SyncJobPayload = z.infer<typeof SyncJobPayloadSchema>;

export function syncJob(
  payload: Partial<z.input<typeof SyncJobPayloadSchema>>,
  extra: Omit<NewJob, 'type' | 'payload'> = {},
): NewJob {
  return { type: SYNC_JOB_TYPE, payload: SyncJobPayloadSchema.parse(payload), ...extra };
}

export function createSyncJobHandler(sync: SyncService): JobHandler {
  return async (job, ctx) => {
    const parsed = SyncJobPayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      throw new PermanentJobError(`Invalid sync payload: ${parsed.error.issues[0]?.message ?? ''}`);
    }
    return sync.sync(parsed.data.mode, parsed.data.resources, {
      jobId: job.id,
      signal: ctx.signal,
      logger: ctx.logger,
    });
  };
}

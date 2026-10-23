export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * A durable unit of work.
 *
 * Lifecycle: queued -> running -> succeeded
 *                       |  ^
 *                       v  | (attempt failed, attempts < maxAttempts: back to queued with runAt in the future)
 *                     dead  (attempts exhausted, or non-retryable error)
 *
 * A running job whose lease (`lockedUntil`) expires is considered abandoned and is
 * re-claimed by any worker. `dead` jobs can be re-queued manually via retry().
 */
export interface Job<TPayload = unknown> {
  id: string;
  type: string;
  payload: TPayload;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAt: number;
  lockedBy: string | null;
  lockedUntil: number | null;
  lastError: string | null;
  result: unknown;
  idempotencyKey: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface NewJob {
  type: string;
  payload: unknown;
  priority?: number;
  maxAttempts?: number;
  runAt?: number;
  idempotencyKey?: string;
}

import type {
  PostWithRelations,
  Post,
  Resource,
  ResourceRecordMap,
  SyncCounts,
  SyncMode,
  SyncRun,
  SyncRunStatus,
  UserStats,
} from './content.js';
import type { Job, JobStatus } from './job.js';

/* ----------------------------------------------------------------------------
 * Driven ports (implemented in infrastructure/, consumed by application/).
 * -------------------------------------------------------------------------- */

export interface Clock {
  now(): number;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface InsertJobInput {
  id: string;
  type: string;
  payload: unknown;
  priority: number;
  maxAttempts: number;
  runAt: number;
  idempotencyKey: string | null;
  now: number;
}

export interface JobListFilter {
  status?: JobStatus | undefined;
  type?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface JobRepository {
  /** Inserts the job, or returns `null` if a job with the same idempotency key already exists. */
  insert(input: InsertJobInput): Job | null;
  findById(id: string): Job | null;
  findByIdempotencyKey(key: string): Job | null;
  /**
   * Atomically picks the highest-priority runnable job (queued and due, or running with an
   * expired lease), marks it running under `workerId` and increments `attempts`.
   * Jobs whose lease expired after their final attempt are moved to `dead` first.
   */
  claimNext(workerId: string, now: number, leaseMs: number): Job | null;
  /** Extends the lease; returns false if the worker no longer owns the job (fencing). */
  extendLease(id: string, workerId: string, lockedUntil: number, now: number): boolean;
  markSucceeded(id: string, workerId: string, result: unknown, now: number): boolean;
  markForRetry(id: string, workerId: string, error: string, runAt: number, now: number): boolean;
  markDead(id: string, workerId: string, error: string, now: number): boolean;
  /** Moves a dead job back to queued with a fresh attempt budget. */
  requeue(id: string, now: number): Job | null;
  list(filter: JobListFilter): Page<Job>;
  countByStatus(): Record<JobStatus, number>;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface ContentRepository {
  upsert<R extends Resource>(resource: R, records: ResourceRecordMap[R][]): UpsertResult;
  /** Deletes every row of `resource` whose id is not in `keepIds`. Returns the number deleted. */
  deleteMissing(resource: Resource, keepIds: readonly number[]): number;
  existingIds(resource: Resource): Set<number>;
  maxId(resource: Resource): number;
  /** Runs `fn` inside a single write transaction. */
  transaction<T>(fn: () => T): T;
}

export interface PostListFilter {
  limit: number;
  cursor?: string | undefined;
  userId?: number | undefined;
  search?: string | undefined;
}

export interface ContentQueryRepository {
  listPosts(filter: PostListFilter): Page<Post>;
  getPostWithRelations(id: number): PostWithRelations | null;
  getUserStats(userId: number): UserStats | null;
}

export interface SyncRunListFilter {
  limit: number;
  cursor?: string | undefined;
  jobId?: string | undefined;
  resource?: Resource | undefined;
  status?: SyncRunStatus | undefined;
}

export interface SyncRunRepository {
  start(input: { jobId: string | null; resource: Resource; mode: SyncMode; now: number }): number;
  finish(
    id: number,
    input: {
      status: Exclude<SyncRunStatus, 'running'>;
      counts: SyncCounts;
      error: string | null;
      now: number;
    },
  ): void;
  findById(id: number): SyncRun | null;
  list(filter: SyncRunListFilter): Page<SyncRun>;
}

export interface FetchOptions {
  /** Only fetch records with id >= this value (high-water-mark incremental sync). */
  minId?: number;
  signal?: AbortSignal;
}

/** Upstream data source (JSONPlaceholder in production, an in-memory fake in tests). */
export interface UpstreamSource {
  fetch<R extends Resource>(resource: R, options?: FetchOptions): Promise<ResourceRecordMap[R][]>;
}

export interface HealthCheck {
  ping(): boolean;
}

import {
  RESOURCE_DEPENDENCY_ORDER,
  RESOURCE_PARENT,
  type Resource,
  type ResourceRecordMap,
  type SyncCounts,
  type SyncMode,
} from '../../domain/content.js';
import type {
  Clock,
  ContentRepository,
  SyncRunRepository,
  UpstreamSource,
} from '../../domain/ports.js';
import type { Logger } from '../../shared/logger.js';
import { errorMessage } from '../../shared/sleep.js';

export interface SyncContext {
  jobId?: string | null;
  signal?: AbortSignal;
  logger?: Logger;
}

export interface SyncSummary {
  mode: SyncMode;
  resources: Partial<Record<Resource, SyncCounts & { runId: number }>>;
}

const parentKey = (resource: Resource, record: ResourceRecordMap[Resource]): number | null => {
  if (resource === 'posts' || resource === 'todos') return (record as { userId: number }).userId;
  if (resource === 'comments') return (record as { postId: number }).postId;
  return null;
};

/**
 * ETL use case: extract from the upstream source, transform/validate (in the adapter), load
 * with hash-based upserts. Every resource sync is recorded in `sync_runs` for auditing.
 *
 * - full:        fetch everything, upsert, and prune rows that disappeared upstream.
 * - incremental: high-water mark - fetch only ids above the current max id, upsert, no pruning.
 */
export class SyncService {
  constructor(
    private readonly upstream: UpstreamSource,
    private readonly content: ContentRepository,
    private readonly runs: SyncRunRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async sync(
    mode: SyncMode,
    resources: readonly Resource[],
    ctx: SyncContext = {},
  ): Promise<SyncSummary> {
    // Always process parents before children so foreign keys resolve.
    const ordered = RESOURCE_DEPENDENCY_ORDER.filter((r) => resources.includes(r));
    const summary: SyncSummary = { mode, resources: {} };
    for (const resource of ordered) {
      ctx.signal?.throwIfAborted();
      summary.resources[resource] = await this.syncResource(resource, mode, ctx);
    }
    return summary;
  }

  async syncResource(
    resource: Resource,
    mode: SyncMode,
    ctx: SyncContext = {},
  ): Promise<SyncCounts & { runId: number }> {
    const log = (ctx.logger ?? this.logger).child({ resource, mode });
    const runId = this.runs.start({
      jobId: ctx.jobId ?? null,
      resource,
      mode,
      now: this.clock.now(),
    });
    const counts: SyncCounts = {
      fetched: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      skipped: 0,
    };

    try {
      const minId = mode === 'incremental' ? this.content.maxId(resource) + 1 : undefined;
      const records = await this.upstream.fetch(resource, {
        ...(minId !== undefined ? { minId } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      counts.fetched = records.length;
      ctx.signal?.throwIfAborted();

      this.content.transaction(() => {
        // Drop orphans whose parent row is unknown locally instead of failing the whole batch
        // on a foreign-key violation (e.g. syncing comments before posts were ever synced).
        const parent = RESOURCE_PARENT[resource];
        let valid = records;
        if (parent) {
          const parentIds = this.content.existingIds(parent);
          valid = records.filter((r) => parentIds.has(parentKey(resource, r) ?? -1));
          counts.skipped = records.length - valid.length;
        }

        Object.assign(counts, this.content.upsert(resource, valid));

        if (mode === 'full') {
          if (records.length === 0 && this.content.maxId(resource) > 0) {
            // Safety valve: an empty upstream response is far more likely an upstream bug than
            // a genuine "everything was deleted". Never let it wipe the table.
            log.warn('upstream returned no records on full sync; skipping prune');
          } else {
            counts.deleted = this.content.deleteMissing(
              resource,
              records.map((r) => r.id),
            );
          }
        }
      });

      this.runs.finish(runId, { status: 'succeeded', counts, error: null, now: this.clock.now() });
      log.info({ runId, ...counts }, 'resource synced');
      return { ...counts, runId };
    } catch (err) {
      this.runs.finish(runId, {
        status: 'failed',
        counts,
        error: errorMessage(err),
        now: this.clock.now(),
      });
      throw err;
    }
  }
}

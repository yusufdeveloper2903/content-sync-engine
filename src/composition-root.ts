import type { Express } from 'express';
import { ContentQueries } from './application/queries/content-queries.js';
import { JobQueue } from './application/queue/job-queue.js';
import { WorkerPool } from './application/queue/worker-pool.js';
import { Scheduler } from './application/scheduler.js';
import { createSyncJobHandler, SYNC_JOB_TYPE, syncJob } from './application/sync/sync-job.js';
import { SyncService } from './application/sync/sync-service.js';
import type { AppConfig } from './config/env.js';
import type { Clock, UpstreamSource } from './domain/ports.js';
import { SqliteDatabase } from './infrastructure/db/database.js';
import { migrate } from './infrastructure/db/migrator.js';
import { SqliteContentQueryRepository } from './infrastructure/db/repositories/sqlite-content-query-repository.js';
import { SqliteContentRepository } from './infrastructure/db/repositories/sqlite-content-repository.js';
import { SqliteJobRepository } from './infrastructure/db/repositories/sqlite-job-repository.js';
import { SqliteSyncRunRepository } from './infrastructure/db/repositories/sqlite-sync-run-repository.js';
import { HttpClient } from './infrastructure/http/http-client.js';
import { JsonPlaceholderSource } from './infrastructure/http/jsonplaceholder-source.js';
import { TokenBucket } from './infrastructure/http/token-bucket.js';
import { createApp } from './interfaces/http/app.js';
import { systemClock } from './shared/clock.js';
import { createLogger, type Logger } from './shared/logger.js';

export interface ContainerOverrides {
  upstream?: UpstreamSource;
  clock?: Clock;
  logger?: Logger;
}

export interface Container {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  db: SqliteDatabase;
  queue: JobQueue;
  workers: WorkerPool;
  scheduler: Scheduler;
  sync: SyncService;
  queries: ContentQueries;
  app: Express;
  /** Flipped during shutdown so /ready starts failing before the listener closes. */
  lifecycle: { shuttingDown: boolean };
}

/**
 * Composition root: the only place that knows concrete implementations. Everything else
 * depends on ports, which is what lets tests swap the upstream, clock and database freely.
 */
export function buildContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  const logger = overrides.logger ?? createLogger(config.log);
  const clock = overrides.clock ?? systemClock;

  const db = new SqliteDatabase(config.db.path);
  migrate(db, logger);

  const jobRepo = new SqliteJobRepository(db);
  const contentRepo = new SqliteContentRepository(db, clock);
  const syncRunRepo = new SqliteSyncRunRepository(db);
  const queryRepo = new SqliteContentQueryRepository(db);

  const upstream =
    overrides.upstream ??
    new JsonPlaceholderSource(
      new HttpClient({
        timeoutMs: config.upstream.timeoutMs,
        maxRetries: config.upstream.maxRetries,
        limiter: new TokenBucket({
          capacity: config.upstream.rateLimitBurst,
          refillPerSecond: config.upstream.rateLimitRps,
        }),
        logger: logger.child({ component: 'http-client' }),
      }),
      config.upstream.baseUrl,
    );

  const queue = new JobQueue(jobRepo, clock, {
    defaultMaxAttempts: config.jobs.maxAttempts,
    backoffBaseMs: config.jobs.backoffBaseMs,
    backoffMaxMs: config.jobs.backoffMaxMs,
  });

  const sync = new SyncService(
    upstream,
    contentRepo,
    syncRunRepo,
    clock,
    logger.child({ component: 'sync' }),
  );

  const workers = new WorkerPool(
    queue,
    {
      concurrency: config.worker.concurrency,
      pollIntervalMs: config.worker.pollIntervalMs,
      leaseMs: config.worker.leaseMs,
    },
    logger.child({ component: 'worker' }),
  ).register(SYNC_JOB_TYPE, createSyncJobHandler(sync));

  const scheduler = new Scheduler(
    queue,
    [
      {
        name: 'incremental-sync',
        intervalMs: config.scheduler.incrementalIntervalMs,
        job: () => syncJob({ mode: 'incremental' }),
      },
      {
        name: 'full-sync',
        intervalMs: config.scheduler.fullIntervalMs,
        job: () => syncJob({ mode: 'full' }, { priority: -10 }),
      },
    ],
    clock,
    logger.child({ component: 'scheduler' }),
  );

  const queries = new ContentQueries(queryRepo, syncRunRepo);
  const lifecycle = { shuttingDown: false };

  const app = createApp({
    queries,
    queue,
    clock,
    logger,
    readinessChecks: [
      { name: 'database', check: () => db.ping() },
      { name: 'lifecycle', check: () => !lifecycle.shuttingDown },
      { name: 'workers', check: () => !config.worker.enabled || workers.isRunning },
    ],
  });

  return { config, logger, clock, db, queue, workers, scheduler, sync, queries, app, lifecycle };
}

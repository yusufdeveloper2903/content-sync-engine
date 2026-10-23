import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { ContentQueries } from '../../application/queries/content-queries.js';
import type { JobQueue } from '../../application/queue/job-queue.js';
import type { Clock } from '../../domain/ports.js';
import type { Logger } from '../../shared/logger.js';
import { docsRoutes } from './docs.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { REQUEST_ID_HEADER, requestId } from './middleware/request-id.js';
import { contentRoutes } from './routes/content.js';
import { healthRoutes, type ReadinessCheck } from './routes/health.js';
import { jobRoutes } from './routes/jobs.js';

export interface AppDeps {
  queries: ContentQueries;
  queue: JobQueue;
  clock: Clock;
  logger: Logger;
  readinessChecks: readonly ReadinessCheck[];
  enableDocs?: boolean;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (_req, res) => String(res.getHeader(REQUEST_ID_HEADER)),
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRoutes(deps.readinessChecks));
  if (deps.enableDocs ?? true) app.use(docsRoutes());
  app.use(contentRoutes(deps.queries));
  app.use(jobRoutes(deps.queue, deps.clock));

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}

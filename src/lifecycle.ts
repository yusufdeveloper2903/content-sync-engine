import type { Server } from 'node:http';
import type { Container } from './composition-root.js';

/**
 * Order matters:
 *  1. fail readiness so load balancers stop routing new traffic here,
 *  2. stop accepting connections and let in-flight requests finish,
 *  3. stop enqueuing scheduled work, drain running jobs (bounded by SHUTDOWN_TIMEOUT_MS),
 *  4. close the database last, once nothing can touch it.
 */
export async function gracefulShutdown(container: Container, server: Server): Promise<void> {
  const { lifecycle, scheduler, workers, db, config, logger } = container;
  lifecycle.shuttingDown = true;

  const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();

  scheduler.stop();
  const { drained } = await workers.stop(config.shutdownTimeoutMs);
  logger.info({ drained }, 'workers stopped');

  await Promise.race([httpClosed, new Promise((r) => setTimeout(r, 2_000).unref())]);
  server.closeAllConnections();
  db.close();
}

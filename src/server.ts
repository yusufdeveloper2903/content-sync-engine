import { buildContainer } from './composition-root.js';
import { loadConfig } from './config/env.js';
import { gracefulShutdown } from './lifecycle.js';

function main(): void {
  const config = loadConfig();
  const container = buildContainer(config);
  const { logger, workers, scheduler } = container;

  if (config.worker.enabled) workers.start();
  if (config.scheduler.enabled) scheduler.start();

  const server = container.app.listen(config.http.port, config.http.host, () => {
    logger.info({ host: config.http.host, port: config.http.port }, 'http server listening');
  });
  // Keep-alive sockets would otherwise hold server.close() open until they idle out.
  server.keepAliveTimeout = 5_000;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');

    const force = setTimeout(() => {
      logger.fatal('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs + 5_000);
    force.unref();

    gracefulShutdown(container, server)
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.fatal({ err }, 'shutdown failed');
        process.exit(1);
      });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
}

try {
  main();
} catch (err: unknown) {
  // Logger may not exist yet (e.g. invalid config), so fall back to stderr.
  process.stderr.write(
    `Fatal startup error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
}

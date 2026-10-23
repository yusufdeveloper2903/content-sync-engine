import { pino } from 'pino';
import { buildContainer, type Container } from '../../src/composition-root.js';
import { loadConfig } from '../../src/config/env.js';
import type { Clock, UpstreamSource } from '../../src/domain/ports.js';
import { SqliteDatabase } from '../../src/infrastructure/db/database.js';
import { migrate } from '../../src/infrastructure/db/migrator.js';

export const silentLogger = pino({ level: 'silent' });

export function createTestDb(): SqliteDatabase {
  const db = new SqliteDatabase(':memory:');
  migrate(db);
  return db;
}

export function createTestContainer(options: {
  upstream: UpstreamSource;
  clock?: Clock;
  env?: Record<string, string>;
}): Container {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    WORKER_POLL_INTERVAL_MS: '10',
    JOB_BACKOFF_BASE_MS: '10',
    JOB_BACKOFF_MAX_MS: '50',
    ...options.env,
  });
  return buildContainer(config, {
    upstream: options.upstream,
    logger: silentLogger,
    ...(options.clock ? { clock: options.clock } : {}),
  });
}

export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  { timeoutMs = 3000, intervalMs = 10 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

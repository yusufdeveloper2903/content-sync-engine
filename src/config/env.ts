import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3000, 0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: bool.default(false),

  DATABASE_PATH: z.string().min(1).default('./data/content-sync.db'),

  UPSTREAM_BASE_URL: z.url().default('https://jsonplaceholder.typicode.com'),
  UPSTREAM_TIMEOUT_MS: int(10_000, 1),
  UPSTREAM_MAX_RETRIES: int(3),
  UPSTREAM_RATE_LIMIT_RPS: z.coerce.number().positive().default(5),
  UPSTREAM_RATE_LIMIT_BURST: int(10, 1),

  WORKERS_ENABLED: bool.default(true),
  WORKER_CONCURRENCY: int(2, 1),
  WORKER_POLL_INTERVAL_MS: int(500, 10),
  JOB_LEASE_MS: int(30_000, 100),
  JOB_MAX_ATTEMPTS: int(5, 1),
  JOB_BACKOFF_BASE_MS: int(1_000, 1),
  JOB_BACKOFF_MAX_MS: int(60_000, 1),

  SCHEDULER_ENABLED: bool.default(true),
  INCREMENTAL_SYNC_INTERVAL_MS: int(5 * 60_000),
  FULL_SYNC_INTERVAL_MS: int(60 * 60_000),

  SHUTDOWN_TIMEOUT_MS: int(15_000, 1),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  http: { host: string; port: number };
  log: { level: Env['LOG_LEVEL']; pretty: boolean };
  db: { path: string };
  upstream: {
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
    rateLimitRps: number;
    rateLimitBurst: number;
  };
  worker: {
    enabled: boolean;
    concurrency: number;
    pollIntervalMs: number;
    leaseMs: number;
  };
  jobs: { maxAttempts: number; backoffBaseMs: number; backoffMaxMs: number };
  scheduler: { enabled: boolean; incrementalIntervalMs: number; fullIntervalMs: number };
  shutdownTimeoutMs: number;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    http: { host: e.HOST, port: e.PORT },
    log: { level: e.LOG_LEVEL, pretty: e.LOG_PRETTY },
    db: { path: e.DATABASE_PATH },
    upstream: {
      baseUrl: e.UPSTREAM_BASE_URL.replace(/\/+$/, ''),
      timeoutMs: e.UPSTREAM_TIMEOUT_MS,
      maxRetries: e.UPSTREAM_MAX_RETRIES,
      rateLimitRps: e.UPSTREAM_RATE_LIMIT_RPS,
      rateLimitBurst: e.UPSTREAM_RATE_LIMIT_BURST,
    },
    worker: {
      enabled: e.WORKERS_ENABLED,
      concurrency: e.WORKER_CONCURRENCY,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      leaseMs: e.JOB_LEASE_MS,
    },
    jobs: {
      maxAttempts: e.JOB_MAX_ATTEMPTS,
      backoffBaseMs: e.JOB_BACKOFF_BASE_MS,
      backoffMaxMs: e.JOB_BACKOFF_MAX_MS,
    },
    scheduler: {
      enabled: e.SCHEDULER_ENABLED,
      incrementalIntervalMs: e.INCREMENTAL_SYNC_INTERVAL_MS,
      fullIntervalMs: e.FULL_SYNC_INTERVAL_MS,
    },
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_MS,
  };
}

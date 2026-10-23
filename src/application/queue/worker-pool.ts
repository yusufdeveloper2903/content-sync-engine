import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { PermanentJobError } from '../../domain/errors.js';
import type { Job } from '../../domain/job.js';
import type { Logger } from '../../shared/logger.js';
import { errorMessage, sleep } from '../../shared/sleep.js';
import type { JobQueue } from './job-queue.js';

export interface JobContext {
  signal: AbortSignal;
  logger: Logger;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<unknown>;

export interface WorkerPoolOptions {
  concurrency: number;
  pollIntervalMs: number;
  leaseMs: number;
  /** How often a running job renews its lease. Defaults to leaseMs / 3. */
  heartbeatMs?: number;
  workerIdPrefix?: string;
}

/**
 * Runs `concurrency` independent polling loops against the durable queue. Each loop claims a
 * job under a time-limited lease, renews the lease while the handler runs, and records the
 * outcome. If the process dies, leases simply expire and another worker picks the jobs up.
 */
export class WorkerPool {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly inFlight = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  private readonly loops: Promise<void>[] = [];
  private readonly idleWaits = new Set<AbortController>();
  private running = false;
  private unsubscribe: (() => void) | undefined;
  private readonly prefix: string;

  constructor(
    private readonly queue: JobQueue,
    private readonly options: WorkerPoolOptions,
    private readonly logger: Logger,
  ) {
    this.prefix =
      options.workerIdPrefix ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  register(type: string, handler: JobHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  get activeJobs(): number {
    return this.inFlight.size;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.queue.onEnqueue(() => this.wakeAll());
    for (let i = 0; i < this.options.concurrency; i++) {
      this.loops.push(this.loop(`${this.prefix}:w${i}`));
    }
    this.logger.info({ concurrency: this.options.concurrency }, 'worker pool started');
  }

  /**
   * Stop claiming new jobs and wait for in-flight ones. After `timeoutMs` the remaining
   * handlers are aborted; their leases will expire and the jobs will be retried elsewhere.
   */
  async stop(timeoutMs: number): Promise<{ drained: boolean }> {
    if (!this.running) return { drained: true };
    this.running = false;
    this.unsubscribe?.();
    this.wakeAll();

    const pending = [...this.inFlight.values()];
    this.logger.info({ inFlight: pending.length }, 'worker pool stopping, draining in-flight jobs');

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([
      Promise.allSettled(this.loops).then(() => 'drained' as const),
      timedOut,
    ]);
    clearTimeout(timer);

    if (outcome === 'timeout') {
      this.logger.warn({ inFlight: this.inFlight.size }, 'drain timed out, aborting jobs');
      for (const { abort } of this.inFlight.values())
        abort.abort(new Error('Worker shutting down'));
      await Promise.allSettled(this.loops);
    }
    this.loops.length = 0;
    return { drained: outcome === 'drained' };
  }

  /** Claim and process at most one job. Exposed for deterministic tests. */
  async runOnce(workerId = `${this.prefix}:manual`): Promise<Job | null> {
    const job = this.queue.claim(workerId, this.options.leaseMs);
    if (!job) return null;
    const abort = new AbortController();
    const promise = this.execute(job, workerId, abort);
    this.inFlight.set(job.id, { promise, abort });
    try {
      await promise;
    } finally {
      this.inFlight.delete(job.id);
    }
    return job;
  }

  private async loop(workerId: string): Promise<void> {
    while (this.running) {
      let job: Job | null = null;
      try {
        job = await this.runOnce(workerId);
      } catch (err) {
        this.logger.error({ err, workerId }, 'worker loop error');
      }
      if (!job && this.running) await this.idle();
    }
  }

  private async execute(job: Job, workerId: string, abort: AbortController): Promise<void> {
    const log = this.logger.child({
      jobId: job.id,
      jobType: job.type,
      attempt: job.attempts,
      workerId,
    });
    const startedAt = Date.now();
    const handler = this.handlers.get(job.type);

    const heartbeatMs =
      this.options.heartbeatMs ?? Math.max(10, Math.floor(this.options.leaseMs / 3));
    const heartbeat = setInterval(() => {
      try {
        if (!this.queue.heartbeat(job, workerId, this.options.leaseMs)) {
          log.warn('lease lost, aborting handler');
          abort.abort(new Error('Lease lost'));
        }
      } catch (err) {
        log.error({ err }, 'heartbeat failed');
      }
    }, heartbeatMs);

    try {
      if (!handler) throw new PermanentJobError(`No handler registered for job type "${job.type}"`);
      log.info('job started');
      const result = await handler(job, { signal: abort.signal, logger: log });
      if (this.queue.complete(job, workerId, result)) {
        log.info({ durationMs: Date.now() - startedAt }, 'job succeeded');
      } else {
        log.warn('job finished but lease was lost; result discarded');
      }
    } catch (err) {
      const outcome = this.queue.fail(job, workerId, err);
      const meta = { durationMs: Date.now() - startedAt, err: errorMessage(err), ...outcome };
      if (outcome.outcome === 'dead') log.error(meta, 'job dead-lettered');
      else log.warn(meta, 'job failed');
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async idle(): Promise<void> {
    const ctl = new AbortController();
    this.idleWaits.add(ctl);
    try {
      await sleep(this.options.pollIntervalMs, ctl.signal);
    } catch {
      // woken up early
    } finally {
      this.idleWaits.delete(ctl);
    }
  }

  private wakeAll(): void {
    for (const ctl of this.idleWaits) ctl.abort();
  }
}

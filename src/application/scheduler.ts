import type { NewJob } from '../domain/job.js';
import type { Clock } from '../domain/ports.js';
import type { Logger } from '../shared/logger.js';
import type { JobQueue } from './queue/job-queue.js';

export interface Schedule {
  name: string;
  intervalMs: number;
  job: () => Omit<NewJob, 'idempotencyKey'>;
}

/**
 * Interval scheduler that enqueues jobs rather than running work itself.
 *
 * Each tick enqueues with the idempotency key `schedule:<name>:<time bucket>`, so if several
 * instances run the scheduler (or one restarts mid-interval) a given slot is enqueued once.
 */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly queue: JobQueue,
    private readonly schedules: readonly Schedule[],
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  start({ runImmediately = true } = {}): void {
    for (const s of this.schedules) {
      if (s.intervalMs <= 0) continue;
      if (runImmediately) this.tick(s);
      const timer = setInterval(() => this.tick(s), s.intervalMs);
      timer.unref();
      this.timers.push(timer);
    }
    this.logger.info(
      {
        schedules: this.schedules
          .filter((s) => s.intervalMs > 0)
          .map((s) => `${s.name}@${s.intervalMs}ms`),
      },
      'scheduler started',
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Enqueue the job for the current time slot. Public for tests. */
  tick(schedule: Schedule): { created: boolean; jobId: string } | null {
    const slot = Math.floor(this.clock.now() / schedule.intervalMs);
    try {
      const { job, created } = this.queue.enqueue({
        ...schedule.job(),
        idempotencyKey: `schedule:${schedule.name}:${slot}`,
      });
      if (created)
        this.logger.info({ schedule: schedule.name, jobId: job.id }, 'scheduled job enqueued');
      return { created, jobId: job.id };
    } catch (err) {
      this.logger.error({ err, schedule: schedule.name }, 'failed to enqueue scheduled job');
      return null;
    }
  }
}

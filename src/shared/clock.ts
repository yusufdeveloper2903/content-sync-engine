import type { Clock } from '../domain/ports.js';

export const systemClock: Clock = { now: () => Date.now() };

/** Manually-advanced clock for deterministic tests. */
export class ManualClock implements Clock {
  constructor(private current = 1_700_000_000_000) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

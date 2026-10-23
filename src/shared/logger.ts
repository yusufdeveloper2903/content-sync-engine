import { pino, type Logger, type LevelWithSilent } from 'pino';

export type { Logger };

export function createLogger(options: { level: LevelWithSilent; pretty?: boolean }): Logger {
  return pino({
    level: options.level,
    base: { service: 'content-sync-engine' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: true } } }
      : {}),
  });
}

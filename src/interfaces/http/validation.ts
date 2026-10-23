import type { z } from 'zod';
import { ValidationError } from '../../domain/errors.js';

/** Parses `data` with `schema`, converting Zod issues into a domain ValidationError (-> 400). */
export function parseInput<S extends z.ZodType>(
  schema: S,
  data: unknown,
  source: 'query' | 'params' | 'body' | 'headers',
): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new ValidationError(
    `Invalid request ${source}`,
    result.error.issues.map((i) => ({
      path: [source, ...i.path.map(String)].join('.'),
      message: i.message,
    })),
  );
}

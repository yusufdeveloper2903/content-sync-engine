import { ValidationError } from '../domain/errors.js';

/**
 * Opaque keyset-pagination cursors. Clients treat them as strings; internally they are
 * base64url-encoded JSON of the last row's sort key.
 */
export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, string | number>>(
  cursor: string,
  isValid: (v: Record<string, unknown>) => v is T,
): T {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      isValid(parsed as Record<string, unknown>)
    ) {
      return parsed as T;
    }
  } catch {
    // fall through
  }
  throw new ValidationError('Invalid cursor', [{ path: 'cursor', message: 'Malformed cursor' }]);
}

export const isIdCursor = (v: Record<string, unknown>): v is { id: number } =>
  Number.isInteger(v.id);

export const isTimeIdCursor = (v: Record<string, unknown>): v is { t: number; id: string } =>
  Number.isInteger(v.t) && typeof v.id === 'string';

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

export type Row = Record<string, SQLOutputValue>;
export type Params = Record<string, SQLInputValue>;

/**
 * Thin wrapper around node:sqlite's synchronous driver.
 *
 * - Applies production pragmas (WAL, foreign keys, busy timeout).
 * - Caches prepared statements.
 * - Provides re-entrant transactions: the outermost call uses BEGIN IMMEDIATE (takes the
 *   write lock up-front so two writers never deadlock on lock upgrade); nested calls use
 *   SAVEPOINTs so an inner failure can roll back without aborting the outer unit of work.
 */
export class SqliteDatabase {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private depth = 0;
  private closed = false;

  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
    }
  }

  prepare(sql: string): ReturnType<DatabaseSync['prepare']> {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  get<T>(sql: string, params: Params = {}): T | undefined {
    return this.prepare(sql).get(params) as T | undefined;
  }

  all<T>(sql: string, params: Params = {}): T[] {
    return this.prepare(sql).all(params) as T[];
  }

  run(sql: string, params: Params = {}): { changes: number } {
    const res = this.prepare(sql).run(params);
    return { changes: Number(res.changes) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    if (this.depth === 0) {
      this.raw.exec('BEGIN IMMEDIATE');
      this.depth++;
      try {
        const result = fn();
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      } finally {
        this.depth--;
      }
    }

    const name = `sp_${this.depth}`;
    this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      this.raw.exec(`RELEASE ${name}`);
      return result;
    } catch (err) {
      this.raw.exec(`ROLLBACK TO ${name}`);
      this.raw.exec(`RELEASE ${name}`);
      throw err;
    } finally {
      this.depth--;
    }
  }

  ping(): boolean {
    try {
      return this.get<{ ok: number }>('SELECT 1 AS ok')?.ok === 1;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.raw.close();
  }
}

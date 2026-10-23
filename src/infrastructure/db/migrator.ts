import type { Logger } from '../../shared/logger.js';
import type { SqliteDatabase } from './database.js';
import { migrations as defaultMigrations, type Migration } from './migrations.js';

/**
 * Minimal forward-only migration runner. Each migration runs in its own transaction and is
 * recorded in `schema_migrations`; a name mismatch for an already-applied id aborts startup,
 * which catches edited-after-apply migrations early.
 */
export function migrate(
  db: SqliteDatabase,
  logger?: Logger,
  migrations: readonly Migration[] = defaultMigrations,
): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  INTEGER NOT NULL
    )
  `);

  const applied = new Map(
    db
      .all<{ id: number; name: string }>('SELECT id, name FROM schema_migrations')
      .map((r) => [r.id, r.name]),
  );

  let count = 0;
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    const existing = applied.get(m.id);
    if (existing !== undefined) {
      if (existing !== m.name) {
        throw new Error(`Migration ${m.id} was applied as "${existing}" but is now "${m.name}"`);
      }
      continue;
    }
    db.transaction(() => {
      db.exec(m.up);
      db.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES ($id, $name, $at)', {
        id: m.id,
        name: m.name,
        at: Date.now(),
      });
    });
    logger?.info({ migration: m.id, name: m.name }, 'applied migration');
    count++;
  }
  return count;
}

import { createHash } from 'node:crypto';
import type { Resource, ResourceRecordMap } from '../../../domain/content.js';
import type { Clock, ContentRepository, UpsertResult } from '../../../domain/ports.js';
import type { Params, SqliteDatabase } from '../database.js';

interface TableMapping<R extends Resource> {
  table: R;
  columns: readonly string[];
  toRow(record: ResourceRecordMap[R]): Params;
}

type Mappings = { [R in Resource]: TableMapping<R> };

const MAPPINGS: Mappings = {
  users: {
    table: 'users',
    columns: ['id', 'name', 'username', 'email', 'phone', 'website', 'company_name', 'city'],
    toRow: (u) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      email: u.email,
      phone: u.phone,
      website: u.website,
      company_name: u.companyName,
      city: u.city,
    }),
  },
  posts: {
    table: 'posts',
    columns: ['id', 'user_id', 'title', 'body'],
    toRow: (p) => ({ id: p.id, user_id: p.userId, title: p.title, body: p.body }),
  },
  comments: {
    table: 'comments',
    columns: ['id', 'post_id', 'name', 'email', 'body'],
    toRow: (c) => ({ id: c.id, post_id: c.postId, name: c.name, email: c.email, body: c.body }),
  },
  todos: {
    table: 'todos',
    columns: ['id', 'user_id', 'title', 'completed'],
    toRow: (t) => ({ id: t.id, user_id: t.userId, title: t.title, completed: t.completed ? 1 : 0 }),
  },
};

function upsertSql(m: TableMapping<Resource>): string {
  const cols = [...m.columns, 'content_hash', 'synced_at'];
  const updates = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  return `INSERT INTO ${m.table} (${cols.join(', ')})
          VALUES (${cols.map((c) => `$${c}`).join(', ')})
          ON CONFLICT (id) DO UPDATE SET ${updates}`;
}

const hashRow = (row: Params): string =>
  createHash('sha1').update(JSON.stringify(row)).digest('hex');

/**
 * Write-side repository for synced content. Change detection is done with a per-row content
 * hash, so re-syncing identical upstream data performs no writes (and does not churn the FTS
 * index or `synced_at`).
 */
export class SqliteContentRepository implements ContentRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  upsert<R extends Resource>(resource: R, records: ResourceRecordMap[R][]): UpsertResult {
    const mapping = MAPPINGS[resource] as TableMapping<R>;
    const sql = upsertSql(mapping);
    const now = this.clock.now();

    return this.db.transaction(() => {
      const existing = new Map(
        this.db
          .all<{ id: number; content_hash: string }>(
            `SELECT id, content_hash FROM ${mapping.table}`,
          )
          .map((r) => [r.id, r.content_hash]),
      );
      const result: UpsertResult = { inserted: 0, updated: 0, unchanged: 0 };
      for (const record of records) {
        const row = mapping.toRow(record);
        const hash = hashRow(row);
        const prev = existing.get(record.id);
        if (prev === hash) {
          result.unchanged++;
          continue;
        }
        this.db.run(sql, { ...row, content_hash: hash, synced_at: now });
        if (prev === undefined) result.inserted++;
        else result.updated++;
        existing.set(record.id, hash);
      }
      return result;
    });
  }

  deleteMissing(resource: Resource, keepIds: readonly number[]): number {
    const { table } = MAPPINGS[resource];
    return this.db.run(`DELETE FROM ${table} WHERE id NOT IN (SELECT value FROM json_each($ids))`, {
      ids: JSON.stringify(keepIds),
    }).changes;
  }

  existingIds(resource: Resource): Set<number> {
    const { table } = MAPPINGS[resource];
    return new Set(this.db.all<{ id: number }>(`SELECT id FROM ${table}`).map((r) => r.id));
  }

  maxId(resource: Resource): number {
    const { table } = MAPPINGS[resource];
    return this.db.get<{ m: number | null }>(`SELECT MAX(id) AS m FROM ${table}`)?.m ?? 0;
  }
}

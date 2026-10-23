export interface Migration {
  id: number;
  name: string;
  up: string;
}

/**
 * Append-only list of schema migrations. Never edit an applied migration; add a new one.
 */
export const migrations: readonly Migration[] = [
  {
    id: 1,
    name: 'create_content_tables',
    up: `
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY,
        name          TEXT    NOT NULL,
        username      TEXT    NOT NULL,
        email         TEXT    NOT NULL,
        phone         TEXT,
        website       TEXT,
        company_name  TEXT,
        city          TEXT,
        content_hash  TEXT    NOT NULL,
        synced_at     INTEGER NOT NULL
      );

      CREATE TABLE posts (
        id            INTEGER PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title         TEXT    NOT NULL,
        body          TEXT    NOT NULL,
        content_hash  TEXT    NOT NULL,
        synced_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_posts_user_id ON posts(user_id, id);

      CREATE TABLE comments (
        id            INTEGER PRIMARY KEY,
        post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        name          TEXT    NOT NULL,
        email         TEXT    NOT NULL,
        body          TEXT    NOT NULL,
        content_hash  TEXT    NOT NULL,
        synced_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_comments_post_id ON comments(post_id, id);

      CREATE TABLE todos (
        id            INTEGER PRIMARY KEY,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title         TEXT    NOT NULL,
        completed     INTEGER NOT NULL CHECK (completed IN (0, 1)),
        content_hash  TEXT    NOT NULL,
        synced_at     INTEGER NOT NULL
      );
      CREATE INDEX idx_todos_user_id ON todos(user_id);
    `,
  },
  {
    id: 2,
    name: 'create_jobs',
    up: `
      CREATE TABLE jobs (
        id               TEXT    PRIMARY KEY,
        type             TEXT    NOT NULL,
        payload          TEXT    NOT NULL,
        status           TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
        priority         INTEGER NOT NULL DEFAULT 0,
        attempts         INTEGER NOT NULL DEFAULT 0,
        max_attempts     INTEGER NOT NULL,
        run_at           INTEGER NOT NULL,
        locked_by        TEXT,
        locked_until     INTEGER,
        last_error       TEXT,
        result           TEXT,
        idempotency_key  TEXT    UNIQUE,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        finished_at      INTEGER
      );
      -- Serves the claim query: runnable queued jobs by priority, then due time.
      CREATE INDEX idx_jobs_claim ON jobs(status, priority DESC, run_at, created_at);
      -- Serves lease-expiry scans of running jobs.
      CREATE INDEX idx_jobs_lease ON jobs(status, locked_until);
      CREATE INDEX idx_jobs_created ON jobs(created_at DESC, id DESC);
    `,
  },
  {
    id: 3,
    name: 'create_sync_runs',
    up: `
      CREATE TABLE sync_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id       TEXT    REFERENCES jobs(id) ON DELETE SET NULL,
        resource     TEXT    NOT NULL,
        mode         TEXT    NOT NULL CHECK (mode IN ('full', 'incremental')),
        status       TEXT    NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        fetched      INTEGER NOT NULL DEFAULT 0,
        inserted     INTEGER NOT NULL DEFAULT 0,
        updated      INTEGER NOT NULL DEFAULT 0,
        unchanged    INTEGER NOT NULL DEFAULT 0,
        deleted      INTEGER NOT NULL DEFAULT 0,
        skipped      INTEGER NOT NULL DEFAULT 0,
        error        TEXT,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER
      );
      CREATE INDEX idx_sync_runs_job ON sync_runs(job_id);
      CREATE INDEX idx_sync_runs_resource ON sync_runs(resource, id DESC);
    `,
  },
  {
    id: 4,
    name: 'create_posts_fts',
    up: `
      CREATE VIRTUAL TABLE posts_fts USING fts5(
        title, body,
        content = 'posts',
        content_rowid = 'id',
        tokenize = 'porter unicode61'
      );

      CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
        INSERT INTO posts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;
      CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
        INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
      END;
      CREATE TRIGGER posts_fts_au AFTER UPDATE OF title, body ON posts BEGIN
        INSERT INTO posts_fts(posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
        INSERT INTO posts_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;
    `,
  },
];

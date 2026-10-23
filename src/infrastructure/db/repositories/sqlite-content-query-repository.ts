import type { Comment, Post, PostWithRelations, UserStats } from '../../../domain/content.js';
import type { ContentQueryRepository, Page, PostListFilter } from '../../../domain/ports.js';
import { decodeCursor, encodeCursor, isIdCursor } from '../../../shared/cursor.js';
import type { Params, SqliteDatabase } from '../database.js';

interface PostRow {
  id: number;
  user_id: number;
  title: string;
  body: string;
}

const toPost = (r: PostRow): Post => ({
  id: r.id,
  userId: r.user_id,
  title: r.title,
  body: r.body,
});

/**
 * Turns free text into a safe FTS5 query: every token is quoted (so user input can never
 * inject FTS operators) and prefix-matched, and tokens are AND-ed together.
 */
export function toFtsQuery(search: string): string | null {
  const tokens = search
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 10);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(' ');
}

/** Read-side queries (kept separate from the write repository, CQRS-style). */
export class SqliteContentQueryRepository implements ContentQueryRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listPosts(filter: PostListFilter): Page<Post> {
    const where: string[] = [];
    const params: Params = { limit: filter.limit + 1 };

    if (filter.cursor) {
      where.push('p.id > $afterId');
      params.afterId = decodeCursor(filter.cursor, isIdCursor).id;
    }
    if (filter.userId !== undefined) {
      where.push('p.user_id = $userId');
      params.userId = filter.userId;
    }
    if (filter.search !== undefined) {
      const fts = toFtsQuery(filter.search);
      if (fts === null) return { data: [], nextCursor: null };
      where.push('p.id IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH $fts)');
      params.fts = fts;
    }

    // Keyset pagination on the primary key: stable under concurrent inserts and O(limit)
    // regardless of how deep the client pages (unlike OFFSET).
    const rows = this.db.all<PostRow>(
      `SELECT p.id, p.user_id, p.title, p.body
         FROM posts p
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY p.id ASC
        LIMIT $limit`,
      params,
    );
    const hasMore = rows.length > filter.limit;
    const data = rows.slice(0, filter.limit).map(toPost);
    const last = data.at(-1);
    return { data, nextCursor: hasMore && last ? encodeCursor({ id: last.id }) : null };
  }

  getPostWithRelations(id: number): PostWithRelations | null {
    // One round-trip: author via JOIN, comments aggregated into a JSON array by a correlated
    // subquery. No N+1 regardless of comment count.
    const row = this.db.get<PostRow & { author: string | null; comments: string }>(
      `SELECT p.id, p.user_id, p.title, p.body,
              CASE WHEN u.id IS NULL THEN NULL
                   ELSE json_object('id', u.id, 'name', u.name, 'username', u.username, 'email', u.email)
              END AS author,
              (SELECT json_group_array(json_object(
                        'id', c.id, 'postId', c.post_id, 'name', c.name, 'email', c.email, 'body', c.body)
                        ORDER BY c.id)
                 FROM comments c WHERE c.post_id = p.id) AS comments
         FROM posts p
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.id = $id`,
      { id },
    );
    if (!row) return null;
    return {
      ...toPost(row),
      author: row.author ? (JSON.parse(row.author) as PostWithRelations['author']) : null,
      comments: JSON.parse(row.comments) as Comment[],
    };
  }

  getUserStats(userId: number): UserStats | null {
    const row = this.db.get<{
      id: number;
      name: string;
      post_count: number;
      avg_body_length: number | null;
      comment_count: number;
      unique_commenters: number;
      todo_count: number;
      todo_completed: number;
      top_post_id: number | null;
      top_post_title: string | null;
      top_post_comments: number | null;
    }>(
      `WITH user_posts AS (
         SELECT id, title, body FROM posts WHERE user_id = $userId
       ),
       post_comments AS (
         SELECT up.id AS post_id, up.title, COUNT(c.id) AS n
           FROM user_posts up
           LEFT JOIN comments c ON c.post_id = up.id
          GROUP BY up.id
       ),
       top_post AS (
         SELECT post_id, title, n FROM post_comments ORDER BY n DESC, post_id ASC LIMIT 1
       )
       SELECT u.id, u.name,
              (SELECT COUNT(*) FROM user_posts)                                   AS post_count,
              (SELECT AVG(LENGTH(body)) FROM user_posts)                          AS avg_body_length,
              (SELECT COUNT(*) FROM comments WHERE post_id IN (SELECT id FROM user_posts)) AS comment_count,
              (SELECT COUNT(DISTINCT LOWER(email)) FROM comments
                WHERE post_id IN (SELECT id FROM user_posts))                     AS unique_commenters,
              (SELECT COUNT(*) FROM todos WHERE user_id = u.id)                    AS todo_count,
              (SELECT COUNT(*) FROM todos WHERE user_id = u.id AND completed = 1)  AS todo_completed,
              tp.post_id AS top_post_id, tp.title AS top_post_title, tp.n AS top_post_comments
         FROM users u
         LEFT JOIN top_post tp ON 1 = 1
        WHERE u.id = $userId`,
      { userId },
    );
    if (!row) return null;

    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      userId: row.id,
      name: row.name,
      posts: { total: row.post_count, avgBodyLength: round(row.avg_body_length ?? 0) },
      comments: {
        receivedTotal: row.comment_count,
        avgPerPost: row.post_count ? round(row.comment_count / row.post_count) : 0,
        uniqueCommenters: row.unique_commenters,
      },
      todos: {
        total: row.todo_count,
        completed: row.todo_completed,
        completionRate: row.todo_count ? round(row.todo_completed / row.todo_count) : 0,
      },
      mostCommentedPost:
        row.top_post_id !== null
          ? {
              id: row.top_post_id,
              title: row.top_post_title ?? '',
              comments: row.top_post_comments ?? 0,
            }
          : null,
    };
  }
}

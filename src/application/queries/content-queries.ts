import type { Post, PostWithRelations, UserStats, SyncRun } from '../../domain/content.js';
import { NotFoundError } from '../../domain/errors.js';
import type {
  ContentQueryRepository,
  Page,
  PostListFilter,
  SyncRunListFilter,
  SyncRunRepository,
} from '../../domain/ports.js';

/** Read-side use cases. Thin by design: the heavy lifting is in the SQL. */
export class ContentQueries {
  constructor(
    private readonly content: ContentQueryRepository,
    private readonly syncRuns: SyncRunRepository,
  ) {}

  listPosts(filter: PostListFilter): Page<Post> {
    return this.content.listPosts(filter);
  }

  getPost(id: number): PostWithRelations {
    const post = this.content.getPostWithRelations(id);
    if (!post) throw new NotFoundError(`Post ${id} not found`);
    return post;
  }

  getUserStats(userId: number): UserStats {
    const stats = this.content.getUserStats(userId);
    if (!stats) throw new NotFoundError(`User ${userId} not found`);
    return stats;
  }

  listSyncRuns(filter: SyncRunListFilter): Page<SyncRun> {
    return this.syncRuns.list(filter);
  }
}

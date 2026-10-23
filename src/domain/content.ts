export const RESOURCES = ['users', 'posts', 'comments', 'todos'] as const;
export type Resource = (typeof RESOURCES)[number];

/**
 * Parent-first order. Children reference parents through foreign keys, so a sync
 * that touches several resources must process them in this order.
 */
export const RESOURCE_DEPENDENCY_ORDER: readonly Resource[] = [
  'users',
  'posts',
  'comments',
  'todos',
];

export const RESOURCE_PARENT: Readonly<Record<Resource, Resource | null>> = {
  users: null,
  posts: 'users',
  comments: 'posts',
  todos: 'users',
};

export interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  phone: string | null;
  website: string | null;
  companyName: string | null;
  city: string | null;
}

export interface Post {
  id: number;
  userId: number;
  title: string;
  body: string;
}

export interface Comment {
  id: number;
  postId: number;
  name: string;
  email: string;
  body: string;
}

export interface Todo {
  id: number;
  userId: number;
  title: string;
  completed: boolean;
}

export interface ResourceRecordMap {
  users: User;
  posts: Post;
  comments: Comment;
  todos: Todo;
}

export type AnyRecord = ResourceRecordMap[Resource];

export interface PostWithRelations extends Post {
  author: Pick<User, 'id' | 'name' | 'username' | 'email'> | null;
  comments: Comment[];
}

export interface UserStats {
  userId: number;
  name: string;
  posts: { total: number; avgBodyLength: number };
  comments: { receivedTotal: number; avgPerPost: number; uniqueCommenters: number };
  todos: { total: number; completed: number; completionRate: number };
  mostCommentedPost: { id: number; title: string; comments: number } | null;
}

export type SyncMode = 'full' | 'incremental';

export type SyncRunStatus = 'running' | 'succeeded' | 'failed';

export interface SyncCounts {
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skipped: number;
}

export interface SyncRun extends SyncCounts {
  id: number;
  jobId: string | null;
  resource: Resource;
  mode: SyncMode;
  status: SyncRunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

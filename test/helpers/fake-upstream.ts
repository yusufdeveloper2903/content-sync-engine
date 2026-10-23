import type { Resource, ResourceRecordMap } from '../../src/domain/content.js';
import type { FetchOptions, UpstreamSource } from '../../src/domain/ports.js';
import * as fixtures from './fixtures.js';

type Data = { [R in Resource]: ResourceRecordMap[R][] };

/** In-memory upstream: no network in tests. Supports scripted failures and call recording. */
export class FakeUpstream implements UpstreamSource {
  data: Data;
  readonly calls: { resource: Resource; minId: number | undefined }[] = [];
  private failures: Error[] = [];

  constructor(data?: Partial<Data>) {
    this.data = {
      users: structuredClone(fixtures.users),
      posts: structuredClone(fixtures.posts),
      comments: structuredClone(fixtures.comments),
      todos: structuredClone(fixtures.todos),
      ...data,
    };
  }

  /** The next `fetch` calls throw these errors, in order. */
  failWith(...errors: Error[]): this {
    this.failures.push(...errors);
    return this;
  }

  fetch<R extends Resource>(
    resource: R,
    options: FetchOptions = {},
  ): Promise<ResourceRecordMap[R][]> {
    this.calls.push({ resource, minId: options.minId });
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);
    const rows = this.data[resource] as ResourceRecordMap[R][];
    const minId = options.minId;
    return Promise.resolve(
      structuredClone(minId === undefined ? rows : rows.filter((r) => r.id >= minId)),
    );
  }
}

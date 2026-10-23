import { z } from 'zod';
import type { Resource, ResourceRecordMap } from '../../domain/content.js';
import { UpstreamError } from '../../domain/errors.js';
import type { FetchOptions, UpstreamSource } from '../../domain/ports.js';
import type { HttpClient } from './http-client.js';

/*
 * Anti-corruption layer: upstream payloads are validated and mapped to domain records here,
 * so schema drift upstream fails loudly at the boundary instead of corrupting the database.
 */
const id = z.number().int().positive();

const schemas: { [R in Resource]: z.ZodType<ResourceRecordMap[R][]> } = {
  users: z.array(
    z
      .object({
        id,
        name: z.string(),
        username: z.string(),
        email: z.string(),
        phone: z.string().nullish(),
        website: z.string().nullish(),
        company: z.object({ name: z.string() }).partial().nullish(),
        address: z.object({ city: z.string() }).partial().nullish(),
      })
      .transform((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        email: u.email,
        phone: u.phone ?? null,
        website: u.website ?? null,
        companyName: u.company?.name ?? null,
        city: u.address?.city ?? null,
      })),
  ),
  posts: z.array(z.object({ id, userId: id, title: z.string(), body: z.string() })),
  comments: z.array(
    z.object({ id, postId: id, name: z.string(), email: z.string(), body: z.string() }),
  ),
  todos: z.array(z.object({ id, userId: id, title: z.string(), completed: z.boolean() })),
};

export class JsonPlaceholderSource implements UpstreamSource {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
  ) {}

  async fetch<R extends Resource>(
    resource: R,
    options: FetchOptions = {},
  ): Promise<ResourceRecordMap[R][]> {
    const url = new URL(`${this.baseUrl}/${resource}`);
    if (options.minId !== undefined) url.searchParams.set('id_gte', String(options.minId));
    url.searchParams.set('_sort', 'id');

    const body = await this.http.getJson(url.toString(), options.signal);
    const parsed = schemas[resource].safeParse(body);
    if (!parsed.success) {
      throw new UpstreamError(
        `Upstream ${resource} payload failed validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        false,
      );
    }
    return parsed.data;
  }
}

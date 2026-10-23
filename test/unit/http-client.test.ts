import { describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '../../src/domain/errors.js';
import { HttpClient } from '../../src/infrastructure/http/http-client.js';
import { JsonPlaceholderSource } from '../../src/infrastructure/http/jsonplaceholder-source.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function client(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {},
) {
  const sleeps: number[] = [];
  const http = new HttpClient({
    timeoutMs: 50,
    maxRetries: 2,
    retryBaseMs: 10,
    fetch: fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...extra,
  });
  return { http, sleeps };
}

describe('HttpClient', () => {
  it('retries retryable statuses and eventually succeeds', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json([{ ok: true }]));
    const { http, sleeps } = client(fetchMock);

    await expect(http.getJson('http://x/y')).resolves.toEqual([{ ok: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
  });

  it('gives up after maxRetries with a retryable UpstreamError', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(json({}, 502)));
    const { http } = client(fetchMock);
    const err = await http.getJson('http://x/y').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ retryable: true, status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable 4xx responses', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({}, 404));
    const { http } = client(fetchMock);
    await expect(http.getJson('http://x/y')).rejects.toMatchObject({
      retryable: false,
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After on 429', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(json([]));
    const { http, sleeps } = client(fetchMock, { retryMaxMs: 5_000 });
    await http.getJson('http://x/y');
    expect(sleeps).toEqual([2_000]);
  });

  it('times out slow requests and retries them', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
        }),
    );
    const { http } = client(fetchMock, { maxRetries: 1 });
    await expect(http.getJson('http://x/y')).rejects.toThrow(/timed out after 50ms/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('consults the rate limiter before every attempt', async () => {
    const acquire = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json([]));
    const { http } = client(fetchMock, { limiter: { acquire } as never });
    await http.getJson('http://x/y');
    expect(acquire).toHaveBeenCalledTimes(2);
  });
});

describe('JsonPlaceholderSource', () => {
  it('maps and validates upstream payloads, passing id_gte for incremental fetches', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json([
        {
          id: 7,
          name: 'N',
          username: 'u',
          email: 'e@x.io',
          phone: 'p',
          website: 'w',
          address: { city: 'C', street: 's' },
          company: { name: 'Co', bs: 'b' },
        },
      ]),
    );
    const { http } = client(fetchMock);
    const source = new JsonPlaceholderSource(http, 'https://api.test');

    const users = await source.fetch('users', { minId: 5 });
    expect(users).toEqual([
      {
        id: 7,
        name: 'N',
        username: 'u',
        email: 'e@x.io',
        phone: 'p',
        website: 'w',
        companyName: 'Co',
        city: 'C',
      },
    ]);
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.pathname).toBe('/users');
    expect(url.searchParams.get('id_gte')).toBe('5');
  });

  it('rejects payloads that fail schema validation as non-retryable', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json([{ id: 'nope' }]));
    const source = new JsonPlaceholderSource(client(fetchMock).http, 'https://api.test');
    await expect(source.fetch('posts')).rejects.toMatchObject({ retryable: false });
  });
});

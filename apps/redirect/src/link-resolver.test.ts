import { describe, expect, it, vi } from 'vitest';
import type { CachedTrackingLink } from '@affiliate/shared';
import {
  NEGATIVE_SENTINEL,
  NEGATIVE_TTL_SECONDS,
  POSITIVE_TTL_SECONDS,
  cacheKey,
  createLinkResolver,
  type RedisLike,
} from './link-resolver';

const LINK: CachedTrackingLink = {
  id: 'link-1',
  affiliateId: 'aff-1',
  campaignId: 'camp-1',
  destinationUrl: 'https://acme.example.com/pricing',
  cookieLifetimeDays: 30,
  isActive: true,
};

/** An in-memory stand-in for Redis, so the tests need no server. */
function fakeRedis(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const redis: RedisLike & { store: Map<string, string>; sets: unknown[][] } = {
    store,
    sets: [],
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value, mode, ttl) {
      redis.sets.push([key, value, mode, ttl]);
      store.set(key, value);
      return 'OK';
    },
  };
  return redis;
}

describe('createLinkResolver', () => {
  it('serves a cache hit without calling the API', async () => {
    const redis = fakeRedis({ [cacheKey('abc1234')]: JSON.stringify(LINK) });
    const fetchLink = vi.fn();

    const resolve = createLinkResolver({ redis, fetchLink });

    expect(await resolve('abc1234')).toEqual(LINK);
    expect(fetchLink).not.toHaveBeenCalled();
  });

  it('falls back to the API on a miss and repopulates the cache', async () => {
    // This is the regression the whole story exists for: before the resolver,
    // a miss redirected to the global fallback and the click was lost.
    const redis = fakeRedis();
    const fetchLink = vi.fn().mockResolvedValue(LINK);

    const resolve = createLinkResolver({ redis, fetchLink });

    expect(await resolve('abc1234')).toEqual(LINK);
    // The second argument is the correlation id, forwarded so that a slow
    // cache miss is one traceable story across the redirect and the API rather
    // than two log lines that happen to be close together. It is `undefined`
    // here because this test does not supply one.
    expect(fetchLink).toHaveBeenCalledWith('abc1234', undefined);
    expect(redis.sets).toEqual([
      [cacheKey('abc1234'), JSON.stringify(LINK), 'EX', POSITIVE_TTL_SECONDS],
    ]);
  });

  it('forwards the correlation id to the API on a miss', async () => {
    const redis = fakeRedis();
    const fetchLink = vi.fn().mockResolvedValue(LINK);

    const resolve = createLinkResolver({ redis, fetchLink });

    await resolve('abc1234', 'req-42');
    expect(fetchLink).toHaveBeenCalledWith('abc1234', 'req-42');
  });

  it('gives the degraded-path callback the correlation id', async () => {
    // "Link resolution degraded" is the line an on-call engineer reads first,
    // and it is useless if it cannot be tied to the click that produced it.
    const redis = fakeRedis();
    const boom = new Error('API unreachable');
    const fetchLink = vi.fn().mockRejectedValue(boom);
    const onError = vi.fn();

    const resolve = createLinkResolver({ redis, fetchLink, onError });

    expect(await resolve('abc1234', 'req-43')).toBeNull();
    expect(onError).toHaveBeenCalledWith(boom, 'abc1234', 'req-43');
  });

  it('negatively caches an unknown code', async () => {
    const redis = fakeRedis();
    const fetchLink = vi.fn().mockResolvedValue(null);

    const resolve = createLinkResolver({ redis, fetchLink });

    expect(await resolve('nosuch1')).toBeNull();
    expect(redis.sets).toEqual([
      [cacheKey('nosuch1'), NEGATIVE_SENTINEL, 'EX', NEGATIVE_TTL_SECONDS],
    ]);
  });

  it('does not call the API twice for a known-missing code', async () => {
    const redis = fakeRedis();
    const fetchLink = vi.fn().mockResolvedValue(null);
    const resolve = createLinkResolver({ redis, fetchLink });

    await resolve('nosuch1');
    await resolve('nosuch1');

    // Someone enumerating short codes gets one lookup per code per minute,
    // not one per request.
    expect(fetchLink).toHaveBeenCalledTimes(1);
  });

  it('returns null without caching when the API is unreachable', async () => {
    const redis = fakeRedis();
    const fetchLink = vi.fn().mockRejectedValue(new Error('timeout'));
    const onError = vi.fn();

    const resolve = createLinkResolver({ redis, fetchLink, onError });

    expect(await resolve('abc1234')).toBeNull();
    // Crucially, nothing was written: a blip must not become a minute of
    // wrong answers for a link that actually exists.
    expect(redis.sets).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });

  it('treats a corrupt cache entry as a miss and overwrites it', async () => {
    const redis = fakeRedis({ [cacheKey('abc1234')]: 'not json{' });
    const fetchLink = vi.fn().mockResolvedValue(LINK);
    const onError = vi.fn();

    const resolve = createLinkResolver({ redis, fetchLink, onError });

    expect(await resolve('abc1234')).toEqual(LINK);
    expect(redis.store.get(cacheKey('abc1234'))).toBe(JSON.stringify(LINK));
    expect(onError).toHaveBeenCalled();
  });

  it('survives Redis being down by going straight to the API', async () => {
    const redis = fakeRedis();
    redis.get = async () => {
      throw new Error('ECONNREFUSED');
    };
    const fetchLink = vi.fn().mockResolvedValue(LINK);
    const onError = vi.fn();

    const resolve = createLinkResolver({ redis, fetchLink, onError });

    expect(await resolve('abc1234')).toEqual(LINK);
    expect(onError).toHaveBeenCalled();
  });

  it('still resolves when the cache write fails', async () => {
    const redis = fakeRedis();
    redis.set = async () => {
      throw new Error('READONLY');
    };
    const fetchLink = vi.fn().mockResolvedValue(LINK);

    const resolve = createLinkResolver({ redis, fetchLink, onError: () => {} });

    // Failing to repopulate is survivable; the next click just misses again.
    expect(await resolve('abc1234')).toEqual(LINK);
  });

  it('passes an inactive link through so the caller can decide', async () => {
    // The resolver reports what the link *is*. Whether an inactive link means
    // "fallback" is a routing decision and belongs in the route handler.
    const inactive = { ...LINK, isActive: false };
    const redis = fakeRedis({ [cacheKey('abc1234')]: JSON.stringify(inactive) });

    const resolve = createLinkResolver({ redis, fetchLink: vi.fn() });

    expect(await resolve('abc1234')).toEqual(inactive);
  });
});

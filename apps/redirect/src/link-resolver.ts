import { REQUEST_ID_HEADER, type CachedTrackingLink } from '@affiliate/shared';

/**
 * Resolving a short code to its destination.
 *
 * The redirect service is deliberately database-free: it is the only part of
 * the system on the critical path of every click, and it must stay up while
 * the API is deploying or Postgres is struggling. So Redis remains the fast
 * path and the API is consulted only on a miss.
 *
 * Everything here is injected rather than imported so the behaviour can be
 * tested without a live Redis or a live API.
 */

/** The subset of ioredis this module needs. Keeps the tests honest. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

/**
 * Fetches a link from the authoritative source.
 * Resolves to `null` when the code definitively does not exist.
 * Throws when the source could not be reached or was too slow -- the caller
 * must be able to tell "no such link" from "I don't know".
 *
 * `requestId` is forwarded to the API so a slow cache miss reads as one
 * traceable story across two deployables, rather than as two unrelated log
 * lines that happen to be a few milliseconds apart.
 */
export type FetchLink = (
  shortCode: string,
  requestId?: string
) => Promise<CachedTrackingLink | null>;

export interface ResolverOptions {
  redis: RedisLike;
  fetchLink: FetchLink;
  onError?: (err: unknown, shortCode: string, requestId?: string) => void;
}

/**
 * A positive entry is refreshed on every miss, so this TTL is not what keeps
 * the cache correct -- explicit invalidation on write does that. It is a
 * backstop: if an invalidation is ever missed (a deploy mid-write, a Redis
 * failover), a stale entry ages out within a day instead of living forever.
 *
 * The value it replaced was 3600 with no rehydration, which meant a link
 * simply stopped working an hour after it was created.
 */
export const POSITIVE_TTL_SECONDS = 86_400;

/**
 * Unknown codes are remembered briefly so that someone walking the short-code
 * space turns into one API call per code per minute rather than one per
 * request.
 */
export const NEGATIVE_TTL_SECONDS = 60;

/**
 * Stored in place of the JSON payload to mean "we asked, it does not exist".
 * Not valid JSON, so it can never be confused with a real entry.
 */
export const NEGATIVE_SENTINEL = '__missing__';

export const cacheKey = (shortCode: string) => `link:${shortCode}`;

export function createLinkResolver(options: ResolverOptions) {
  const { redis, fetchLink, onError } = options;

  return async function resolveLink(
    shortCode: string,
    requestId?: string
  ): Promise<CachedTrackingLink | null> {
    let cached: string | null = null;
    try {
      cached = await redis.get(cacheKey(shortCode));
    } catch (err) {
      // Redis being down must not take the redirect service with it. Fall
      // through to the API rather than failing the request.
      onError?.(err, shortCode, requestId);
    }

    if (cached === NEGATIVE_SENTINEL) return null;

    if (cached) {
      try {
        return JSON.parse(cached) as CachedTrackingLink;
      } catch (err) {
        // A corrupt entry should not be permanent. Treat it as a miss and let
        // the fetch below overwrite it.
        onError?.(err, shortCode, requestId);
      }
    }

    let link: CachedTrackingLink | null;
    try {
      link = await fetchLink(shortCode, requestId);
    } catch (err) {
      // Could not reach the API, or it was too slow. We do not know whether
      // the link exists, so we must not cache anything -- caching a guess
      // would turn a blip into a minute of wrong answers.
      onError?.(err, shortCode, requestId);
      return null;
    }

    try {
      if (link === null) {
        await redis.set(
          cacheKey(shortCode),
          NEGATIVE_SENTINEL,
          'EX',
          NEGATIVE_TTL_SECONDS
        );
      } else {
        await redis.set(
          cacheKey(shortCode),
          JSON.stringify(link),
          'EX',
          POSITIVE_TTL_SECONDS
        );
      }
    } catch (err) {
      // Failing to repopulate is survivable: the next click just misses again.
      onError?.(err, shortCode, requestId);
    }

    return link;
  };
}

/**
 * Builds a `FetchLink` that calls the API's internal endpoint.
 *
 * The timeout is the important part. A shopper is waiting on this request, so
 * we would rather send them to the fallback than hold the connection open
 * while the API recovers.
 */
export function createApiFetchLink(config: {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}): FetchLink {
  return async function fetchLink(shortCode, requestId) {
    const res = await fetch(
      `${config.baseUrl}/internal/links/${encodeURIComponent(shortCode)}`,
      {
        headers: {
          'x-internal-token': config.token,
          // Already sanitised at the redirect's own edge, so it is safe to put
          // back on the wire; the API sanitises it again on the way in, since
          // it cannot know who called it.
          ...(requestId ? { [REQUEST_ID_HEADER]: requestId } : {}),
        },
        signal: AbortSignal.timeout(config.timeoutMs),
      }
    );

    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Internal link lookup failed: ${res.status}`);

    return (await res.json()) as CachedTrackingLink;
  };
}

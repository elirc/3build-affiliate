import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { build } from '../src/server';
import { redis } from '../src/config/redis';
import { env } from '../src/config/env';
import {
  bucketKey,
  consumeToken,
  TIERS,
  type TierPolicy,
} from '../src/lib/rate-limiter';
import { login, makeAdmin, makeAffiliate } from './factories';

/**
 * Per-caller rate limiting.
 *
 * Against the old code almost none of this passes: the limiter counted in
 * process memory, so two instances enforced twice the limit; it was global, so
 * one tenant could exhaust everybody's budget; and it was a fixed window, so
 * 200 requests at 11:59:59 and 200 more at 12:00:00 were "within the limit".
 *
 * ## A note on the clock, before anyone tightens these numbers
 *
 * The bucket refills against Redis's own clock, which no test can freeze. Every
 * assertion below is therefore either on a tier slow enough that no token can
 * appear while the test runs (the auth tier mints one per six seconds), or on a
 * policy defined here with a deliberately negligible refill. Re-running the
 * 200-request burst against the postback tier -- one token per 600ms -- over
 * HTTP would pass locally and fail on a loaded CI runner about as often as not.
 */

/**
 * 200 tokens that refill at one a minute.
 *
 * Same shape as the postback tier, with the clock taken out of the result. The
 * real tier's numbers are pinned separately, below.
 */
const FROZEN: TierPolicy = { perMinute: 1, burst: 200, scope: 'apiKey', failOpen: true };

const uniqueKey = (name: string) => bucketKey('postback', `${name}:${Math.random()}`);

describe('the token bucket in Redis', () => {
  it('matches the tiers the story specifies', () => {
    // Pinned, because every other assertion in this file uses a policy chosen
    // to be testable rather than the real one.
    expect(TIERS.postback).toMatchObject({ perMinute: 100, burst: 200, scope: 'apiKey' });
    expect(TIERS.authenticated).toMatchObject({ perMinute: 300, burst: 500, scope: 'user' });
    expect(TIERS.auth).toMatchObject({ perMinute: 10, burst: 15, scope: 'ip' });
    expect(TIERS.public).toMatchObject({ perMinute: 60, burst: 100, scope: 'ip' });

    // The one tier that does not admit the request when Redis is unreachable.
    expect(TIERS.auth.failOpen).toBe(false);
    expect(TIERS.postback.failOpen).toBe(true);
    expect(TIERS.authenticated.failOpen).toBe(true);
    expect(TIERS.public.failOpen).toBe(true);
  });

  it('allows exactly the burst and then rejects, with a usable Retry-After', async () => {
    const key = uniqueKey('burst');

    let allowed = 0;
    for (let i = 0; i < 200; i++) {
      const result = await consumeToken(key, FROZEN);
      if (result.allowed) allowed += 1;
    }
    expect(allowed).toBe(200);

    const rejected = await consumeToken(key, FROZEN);
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    // A minute per token, so the honest answer is 60 seconds -- less whatever
    // fraction the 200 round-trips above refilled, which is why this is a
    // range and not an equality.
    expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(55);
  });

  it('gives every key its own budget', async () => {
    const noisy = uniqueKey('noisy');
    const quiet = uniqueKey('quiet');

    for (let i = 0; i < 200; i++) await consumeToken(noisy, FROZEN);
    expect((await consumeToken(noisy, FROZEN)).allowed).toBe(false);

    // The whole point of scoping. One brand's runaway script must not spend
    // another brand's budget.
    const other = await consumeToken(quiet, FROZEN);
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(199);
  });

  it('lets exactly the burst through under concurrency, not one more', async () => {
    // The test the lost-update race fails and nothing else catches. Read the
    // bucket, refill it and decrement it from the application and 250
    // simultaneous requests all see a token and all take it. Only running the
    // three steps as one Redis script prevents that.
    const key = uniqueKey('concurrent');

    const results = await Promise.all(
      Array.from({ length: 250 }, () => consumeToken(key, FROZEN))
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(200);
    expect(results.filter((r) => !r.allowed)).toHaveLength(50);
  });

  it('shares one budget between two limiter instances', async () => {
    // Two connections stand in for two API processes. The old in-memory
    // limiter passed nothing like this: each instance had its own counter, so
    // the effective limit was the configured one multiplied by the replica
    // count.
    const second = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const key = uniqueKey('shared');

    try {
      for (let i = 0; i < 100; i++) await consumeToken(key, FROZEN, redis);
      for (let i = 0; i < 100; i++) await consumeToken(key, FROZEN, second);

      // 200 spent between them, so both are now out -- rather than each having
      // 100 left.
      expect((await consumeToken(key, FROZEN, redis)).allowed).toBe(false);
      expect((await consumeToken(key, FROZEN, second)).allowed).toBe(false);
    } finally {
      second.disconnect();
    }
  });

  it('reloads the script after the cache is flushed', async () => {
    const key = uniqueKey('noscript');
    expect((await consumeToken(key, FROZEN)).allowed).toBe(true);

    // What a Redis restart or a SCRIPT FLUSH does. EVALSHA now returns
    // NOSCRIPT, which is not an error: it is the signal to send the body
    // again. Without the fallback, every request after a Redis restart would
    // hit the fail-open path and the limiter would silently stop limiting.
    await redis.script('FLUSH');

    const after = await consumeToken(key, FROZEN);
    expect(after.allowed).toBe(true);
    // State survived, because SCRIPT FLUSH drops scripts and not keys.
    expect(after.remaining).toBe(198);
  });

  it('refills at the configured rate and stops at the capacity', async () => {
    // 6000/min is a token every 10ms, so a 250ms wait is far past a full
    // bucket -- deliberately, so that a slow machine cannot change the answer.
    const fast: TierPolicy = { perMinute: 6_000, burst: 5, scope: 'ip', failOpen: true };
    const key = uniqueKey('refill');

    for (let i = 0; i < 5; i++) await consumeToken(key, fast);
    expect((await consumeToken(key, fast)).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const after = await consumeToken(key, fast);
    expect(after.allowed).toBe(true);
    // Capped at the burst: 250ms of refill is 25 tokens, and a bucket that
    // accumulated all of them would let an idle integration wake up and fire
    // an unbounded volley.
    expect(after.remaining).toBe(4);
  });

  it('expires an idle bucket, but not before it could have refilled', async () => {
    const key = uniqueKey('ttl');
    await consumeToken(key, FROZEN);

    const ttlMs = await redis.pttl(key);
    // Two full refills of a 200-token bucket at one a minute. An expiry any
    // shorter would hand a throttled caller a full bucket for pausing.
    expect(ttlMs).toBeGreaterThan(200 * 60_000);
  });
});

describe('rate limiting over HTTP', () => {
  let app: FastifyInstance;
  let unlimited: FastifyInstance;

  beforeAll(async () => {
    app = await build();
    await app.ready();

    // The option roughly twenty other suites depend on. It is tested here
    // rather than assumed, because it is the one thing in this story that can
    // break every other file at once.
    unlimited = await build({ rateLimit: false });
    await unlimited.ready();
  });

  afterAll(async () => {
    await app.close();
    await unlimited.close();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A request that is rejected before any handler work; only the limiter counts it. */
  const attemptLogin = () =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });

  it('throttles credential attempts per IP after the burst', async () => {
    // The auth tier: 15 in a burst, then one every six seconds. Nobody types
    // their password sixteen times in a minute; a script does.
    for (let i = 0; i < 15; i++) {
      const res = await attemptLogin();
      expect(res.statusCode).not.toBe(429);
      expect(res.headers['x-ratelimit-limit']).toBe('15');
      expect(res.headers['x-ratelimit-remaining']).toBe(String(14 - i));
    }

    const blocked = await attemptLogin();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    // Six seconds to the next token, less however long the fifteen requests
    // above took. Rejecting without saying when to come back guarantees the
    // client hammers us, and a Retry-After of 0 is the same thing.
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(5);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(6);
    // Ninety seconds to refill all fifteen, which is the definition of Reset
    // this API uses: when the bucket is full, not when one token appears.
    expect(Number(blocked.headers['x-ratelimit-reset'])).toBeGreaterThanOrEqual(85);
    expect(Number(blocked.headers['x-ratelimit-reset'])).toBeLessThanOrEqual(90);
  });

  it('admits exactly the burst when the attempts arrive all at once', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, attemptLogin));
    const throttled = results.filter((r) => r.statusCode === 429);

    expect(results.length - throttled.length).toBe(15);
    expect(throttled).toHaveLength(25);
  });

  it('counts postbacks per API key, not per IP', async () => {
    // Both "brands" are 127.0.0.1 here, which is the point: a shared egress IP
    // must not merge two tenants' budgets. Every request is rejected by the
    // signature guard, and the limiter counted it before that -- an
    // unauthenticated flood is exactly what this budget is for.
    const spend = (keyId: string) =>
      app.inject({
        method: 'POST',
        url: '/api/conversions/some-campaign',
        headers: { 'content-type': 'application/json', 'x-affiliate-key': keyId },
        payload: {},
      });

    const first = await spend('ak_brand_one');
    const second = await spend('ak_brand_two');

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    expect(first.headers['x-ratelimit-limit']).toBe('200');
    // Each key is on its own bucket, so both report the same remaining.
    expect(first.headers['x-ratelimit-remaining']).toBe('199');
    expect(second.headers['x-ratelimit-remaining']).toBe('199');

    expect(await redis.exists(bucketKey('postback', 'key:ak_brand_one'))).toBe(1);
    expect(await redis.exists(bucketKey('postback', 'key:ak_brand_two'))).toBe(1);
  });

  it('counts authenticated traffic per user', async () => {
    const affiliate = await makeAffiliate();
    const auth = await login(app, affiliate.email);

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth.authHeader,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('500');
    expect(res.headers['x-ratelimit-remaining']).toBe('499');
    expect(await redis.exists(bucketKey('authenticated', `user:${affiliate.id}`))).toBe(1);
  });

  it('exempts admins, and leaves no bucket behind to prove it', async () => {
    const admin = await makeAdmin();
    const auth = await login(app, admin.email);

    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: auth.authHeader,
      });
      expect(res.statusCode).toBe(200);
      // No headers at all: the hook returns before it consumes anything.
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }

    expect(await redis.keys('ratelimit:authenticated:*')).toEqual([]);
  });

  it('serves normal traffic when Redis is down, and refuses logins', async () => {
    // The trade-off this story is really about. Fail open and a Redis outage
    // costs capacity protection; fail closed and it costs the API. The split
    // is by what the limit is *for*: on /login it is the brute-force control
    // itself, so losing it is worse than turning logins away for a few
    // minutes.
    const down = new Error('Connection is closed.');
    vi.spyOn(redis, 'evalsha').mockRejectedValue(down);
    vi.spyOn(redis, 'eval').mockRejectedValue(down);

    const normal = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: {} });
    expect(normal.statusCode).not.toBe(503);
    expect(normal.statusCode).not.toBe(429);

    const credential = await attemptLogin();
    expect(credential.statusCode).toBe(503);
    expect(credential.json()).toMatchObject({
      error: { code: 'RATE_LIMITER_UNAVAILABLE' },
    });
    // Not a 429: this caller is inside its budget, we simply cannot prove it.
    expect(credential.headers['retry-after']).toBe('1');
  });

  it('leaves /health alone so a probe cannot throttle itself out of rotation', async () => {
    for (let i = 0; i < 120; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it('keeps build({ rateLimit: false }) a complete bypass', async () => {
    // Twice the auth tier's burst. With the limiter registered, request 16
    // would be a 429 and every suite that builds this way would start failing
    // partway through for reasons unrelated to what it tests.
    for (let i = 0; i < 30; i++) {
      const res = await unlimited.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {},
      });
      expect(res.statusCode).not.toBe(429);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }

    expect(await redis.keys('ratelimit:*')).toEqual([]);
  });
});

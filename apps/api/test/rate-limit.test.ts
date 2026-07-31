import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { build } from '../src/server';
import { env } from '../src/config/env';
import { redis } from '../src/config/redis';
import { logger } from '../src/lib/logger';
import {
  RATE_LIMIT_TIERS,
  bucketKey,
  createRateLimiter,
  rateLimiter,
} from '../src/lib/rate-limiter';
import { login, makeAdmin, makeAffiliate } from './factories';

/**
 * Per-key rate limiting.
 *
 * Two things are being tested and they are worth keeping apart. The first is
 * arithmetic -- does the bucket allow exactly the number it says -- and the
 * unit tests in `@affiliate/analytics/token-bucket` already pin that down
 * against a fake clock. What only a real Redis can show is that the arithmetic
 * survives *concurrency* and *more than one process*, which is the entire
 * reason the maths lives in a Lua script instead of in TypeScript.
 *
 * The concurrency case is the important one. An implementation that reads the
 * bucket, decides, and writes it back passes every sequential test here and
 * fails the `Promise.all` one, because 250 requests all read the same 200
 * tokens. Nothing else in the suite catches that.
 */

/** Every route is under `/api`, and none of these need to reach a handler. */
const ANY_AUTHENTICATED_ROUTE = '/api/affiliate/links';

describe('rate limiting', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await build();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('the bucket itself', () => {
    const policy = RATE_LIMIT_TIERS.postback;

    it('allows the whole burst and rejects the one after it', async () => {
      const key = bucketKey('test', 'apiKey', 'burst');

      for (let i = 0; i < policy.burst; i += 1) {
        const decision = await rateLimiter.consume(key, policy);
        expect(decision.allowed).toBe(true);
      }

      const rejected = await rateLimiter.consume(key, policy);
      expect(rejected.allowed).toBe(false);
      expect(rejected.remaining).toBe(0);
      // 100 a minute is one every 600ms, rounded up to the next whole second.
      expect(rejected.retryAfterSeconds).toBe(1);
    });

    it('gives every key its own budget', async () => {
      const mine = bucketKey('test', 'apiKey', 'brand-a');
      const theirs = bucketKey('test', 'apiKey', 'brand-b');

      for (let i = 0; i < policy.burst; i += 1) {
        await rateLimiter.consume(mine, policy);
      }

      // The whole point of keying per credential. One brand's runaway
      // storefront must cost that brand and nobody else.
      expect((await rateLimiter.consume(mine, policy)).allowed).toBe(false);
      expect((await rateLimiter.consume(theirs, policy)).allowed).toBe(true);
    });

    it('allows exactly the burst out of 250 simultaneous requests', async () => {
      // The test the whole design exists for.
      //
      // Read-modify-write from the application passes every sequential case
      // above and fails this one: 250 requests read the same 200 tokens, all
      // decrement, and roughly all of them proceed. The number that gets
      // through is then a property of how fast the machine is, which is not a
      // rate limit.
      const key = bucketKey('test', 'apiKey', 'concurrent');

      const decisions = await Promise.all(
        Array.from({ length: 250 }, () => rateLimiter.consume(key, policy))
      );

      expect(decisions.filter((d) => d.allowed)).toHaveLength(policy.burst);
      expect(decisions.filter((d) => !d.allowed)).toHaveLength(250 - policy.burst);
    });

    it('shares one budget across two limiter instances', async () => {
      // Two connections standing in for two API instances. The old in-memory
      // limiter gave each of them its own counter, so running two of them
      // doubled every limit on the platform and nothing said so.
      const a = new Redis(env.REDIS_URL);
      const b = new Redis(env.REDIS_URL);

      try {
        const first = createRateLimiter(a);
        const second = createRateLimiter(b);
        const key = bucketKey('test', 'apiKey', 'two-instances');

        let allowed = 0;
        for (let i = 0; i < policy.burst; i += 1) {
          const limiter = i % 2 === 0 ? first : second;
          if ((await limiter.consume(key, policy)).allowed) allowed += 1;
        }

        expect(allowed).toBe(policy.burst);
        expect((await first.consume(key, policy)).allowed).toBe(false);
        expect((await second.consume(key, policy)).allowed).toBe(false);
      } finally {
        a.disconnect();
        b.disconnect();
      }
    });

    it('still works after Redis forgets the script', async () => {
      // EVALSHA is the fast path and it stops working on every Redis restart
      // or SCRIPT FLUSH. Without the NOSCRIPT fallback the limiter throws, and
      // because most tiers fail open, the symptom is a platform with no rate
      // limiting at all and no failed request to notice it by.
      const key = bucketKey('test', 'apiKey', 'noscript');
      await rateLimiter.consume(key, policy);

      await redis.script('FLUSH');

      const decision = await rateLimiter.consume(key, policy);
      expect(decision.allowed).toBe(true);
      // Re-cached by the fallback, so the next call takes the fast path again.
      expect((await rateLimiter.consume(key, policy)).allowed).toBe(true);
    });
  });

  describe('over HTTP', () => {
    const publicTier = RATE_LIMIT_TIERS.public;
    const authTier = RATE_LIMIT_TIERS.auth;

    it('reports headers that agree with the bucket on a success', async () => {
      const res = await app.inject({ method: 'GET', url: ANY_AUTHENTICATED_ROUTE });

      // Unauthenticated, so it is counted against its IP under the public
      // tier, and rejected by the route's own auth afterwards. The limiter
      // running first is deliberate: an unauthenticated flood should be
      // cheapest to refuse.
      expect(res.statusCode).toBe(401);
      expect(res.headers['x-ratelimit-limit']).toBe(String(publicTier.burst));
      expect(res.headers['x-ratelimit-remaining']).toBe(String(publicTier.burst - 1));
      // 60 a minute is one a second, and one token has just been spent.
      expect(res.headers['x-ratelimit-reset']).toBe('1');
    });

    it('rejects the request past the burst with a usable Retry-After', async () => {
      for (let i = 0; i < publicTier.burst; i += 1) {
        const res = await app.inject({ method: 'GET', url: ANY_AUTHENTICATED_ROUTE });
        expect(res.statusCode).toBe(401);
      }

      const rejected = await app.inject({
        method: 'GET',
        url: ANY_AUTHENTICATED_ROUTE,
      });

      expect(rejected.statusCode).toBe(429);
      expect(rejected.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
      expect(rejected.headers['retry-after']).toBe('1');
      expect(rejected.headers['x-ratelimit-remaining']).toBe('0');
      // An empty bucket refills to its 100-token ceiling at one a second.
      expect(rejected.headers['x-ratelimit-reset']).toBe('100');
    });

    it('holds credential endpoints to the brute-force tier', async () => {
      const attempt = () =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'nobody@example.com', password: 'Password123!' },
        });

      for (let i = 0; i < authTier.burst; i += 1) {
        expect((await attempt()).statusCode).toBe(401);
      }

      const rejected = await attempt();
      expect(rejected.statusCode).toBe(429);
      // Ten a minute is one every six seconds.
      expect(rejected.headers['retry-after']).toBe('6');
      expect(rejected.headers['x-ratelimit-limit']).toBe(String(authTier.burst));
    });

    it('counts authenticated traffic per user, not per address', async () => {
      // Two affiliates behind one address -- an office, a mobile carrier, a
      // NAT. Under an IP bucket one of them drains the other's budget and the
      // support ticket is unanswerable.
      //
      // `inject` gives every request the same 127.0.0.1, so two requests are
      // enough to tell the two keyings apart: shared, the second reads 498.
      const [one, two] = await Promise.all([makeAffiliate(), makeAffiliate()]);
      const [authOne, authTwo] = await Promise.all([
        login(app, one.email),
        login(app, two.email),
      ]);
      const tier = RATE_LIMIT_TIERS.authenticated;

      const first = await app.inject({
        method: 'GET',
        url: ANY_AUTHENTICATED_ROUTE,
        headers: authOne.authHeader,
      });
      const second = await app.inject({
        method: 'GET',
        url: ANY_AUTHENTICATED_ROUTE,
        headers: authTwo.authHeader,
      });

      expect(second.statusCode).toBe(200);
      for (const res of [first, second]) {
        expect(res.headers['x-ratelimit-limit']).toBe(String(tier.burst));
        expect(res.headers['x-ratelimit-remaining']).toBe(String(tier.burst - 1));
      }

      // And the unauthenticated bucket for that same address is a third one
      // again, on the public tier's much lower ceiling.
      const anonymous = await app.inject({
        method: 'GET',
        url: ANY_AUTHENTICATED_ROUTE,
      });
      expect(anonymous.headers['x-ratelimit-limit']).toBe(String(publicTier.burst));
    });

    it('exempts admins, and says so', async () => {
      const admin = await makeAdmin();
      const auth = await login(app, admin.email);
      const logged = vi.spyOn(logger, 'info');

      // The export route's own limit is ten a minute. An admin goes past it.
      for (let i = 0; i < 12; i += 1) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/brand/conversions/export',
          headers: auth.authHeader,
        });
        // 403 because an admin is not a brand -- the route's authorization is
        // untouched by the exemption. Not 429, which is the point.
        expect(res.statusCode).toBe(403);
      }

      // An exemption nobody can see is indistinguishable from a limiter that
      // does not work, and a stolen admin token is now an unlimited one.
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ userId: admin.id }),
        'Rate limit skipped for an admin'
      );
      logged.mockRestore();
    });

    it('never limits the health check', async () => {
      // Probes come from a load balancer, so they share one bucket. Throttling
      // them would take a healthy instance out of rotation.
      for (let i = 0; i < publicTier.burst + 10; i += 1) {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  describe('when Redis is unreachable', () => {
    let degraded: FastifyInstance;
    let dead: Redis;

    beforeAll(async () => {
      // Port 1 with the offline queue disabled: every command rejects at once
      // rather than buffering, which is what a limiter facing a dead Redis
      // actually experiences.
      dead = new Redis({
        host: '127.0.0.1',
        port: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
        retryStrategy: () => null,
      });
      dead.on('error', () => {
        // Expected, and an unhandled 'error' on an ioredis client throws.
      });

      degraded = await build({ rateLimit: { limiter: createRateLimiter(dead) } });
      await degraded.ready();
    });

    afterAll(async () => {
      await degraded.close();
      dead.disconnect();
    });

    it('keeps serving ordinary traffic', async () => {
      // Fail open. Redis being unreachable must not turn a dependency outage
      // into a total outage -- what is lost is a throughput guard, and the
      // requests still have to pass authentication and authorization.
      const res = await degraded.inject({
        method: 'GET',
        url: ANY_AUTHENTICATED_ROUTE,
      });

      expect(res.statusCode).toBe(401);
      // No headers, because there is no bucket to report. Inventing numbers
      // would tell a client it has budget nobody is counting.
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    });

    it('refuses credential endpoints', async () => {
      // Fail closed. Here the limit *is* the control: without it, password
      // guessing is unbounded, and that is worse than telling people to log in
      // again in a moment.
      const res = await degraded.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'nobody@example.com', password: 'Password123!' },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE' } });
      expect(res.headers['retry-after']).toBe('1');
    });
  });
});

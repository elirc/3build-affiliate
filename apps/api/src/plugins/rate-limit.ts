import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@affiliate/shared';
import { KEY_HEADER } from '../lib/postback-signature';
import { Errors } from '../lib/errors';
import { logger } from '../lib/logger';
import {
  RATE_LIMIT_TIERS,
  bucketKey,
  rateLimiter,
  type RateLimitPolicy,
  type RateLimitScope,
  type RateLimitTier,
  type RateLimiter,
} from '../lib/rate-limiter';

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Which limit applies to this route. A tier name for the common cases, an
     * explicit policy for a route that needs its own, `false` for a route that
     * must never be throttled. Absent picks a default from the request.
     */
    rateLimit?: RateLimitTier | RateLimitPolicy | false;
  }
}

export interface RateLimitOptions {
  /**
   * Injectable so a test can point the app at a Redis that is down and check
   * that normal routes still serve while auth routes stop. There is no other
   * honest way to exercise that path.
   */
  limiter?: RateLimiter;
}

interface Identity {
  userId?: string;
  role?: UserRole;
  apiKeyId?: string;
}

/**
 * Who is asking, for the purpose of choosing a bucket.
 *
 * The token is verified rather than decoded. Decoding would be cheaper, but
 * then anyone could put someone else's user id -- or `role: ADMIN` -- in an
 * unsigned token and either drain a stranger's budget or skip the limiter
 * entirely. Verification here is a signature check and nothing more; the
 * database work that `requireAuth` does is not repeated, and a token that is
 * signed but revoked still identifies the same person for counting purposes.
 */
function identify(app: FastifyInstance, req: FastifyRequest): Identity {
  const keyId = req.headers[KEY_HEADER];
  const apiKeyId = typeof keyId === 'string' ? keyId : undefined;

  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return { apiKeyId };

  try {
    const payload = app.jwt.verify<{ id?: string; role?: UserRole }>(header.slice(7));
    return { apiKeyId, userId: payload.id, role: payload.role };
  } catch {
    // Unreadable or expired. It buys no identity, so the request falls back to
    // its IP -- an attacker cannot get a softer limit by sending junk.
    return { apiKeyId };
  }
}

/**
 * The policy for a route that did not declare one.
 *
 * Defaulting to the public tier for everything would put every dashboard
 * request from one office behind a single 60/minute IP bucket. Defaulting to
 * the authenticated tier would let anyone opt into the generous limit by not
 * logging in. So the default follows the credential: a request that carries a
 * valid token is counted against its user, and one that does not is counted
 * against its address.
 */
function defaultPolicy(identity: Identity): [string, RateLimitPolicy] {
  return identity.userId
    ? ['authenticated', RATE_LIMIT_TIERS.authenticated]
    : ['public', RATE_LIMIT_TIERS.public];
}

function resolvePolicy(
  configured: RateLimitTier | RateLimitPolicy | undefined,
  req: FastifyRequest,
  identity: Identity
): [string, RateLimitPolicy] {
  if (configured === undefined) return defaultPolicy(identity);
  if (typeof configured === 'string') return [configured, RATE_LIMIT_TIERS[configured]];
  // An inline policy is named after the route pattern -- not the resolved url,
  // which would give every path parameter its own bucket -- so that a route
  // with its own tighter limit does not share the tier's bucket. Two policies
  // keyed on the same user would otherwise drain each other.
  return [`${req.method} ${req.routeOptions.url}`, configured];
}

/**
 * The identifier the bucket is keyed on.
 *
 * Every scope falls back to the IP when its identifier is missing, because the
 * alternative -- one shared bucket for everyone unidentified -- lets one
 * caller with no credentials lock out all the others.
 */
function subject(scope: RateLimitScope, identity: Identity, req: FastifyRequest): string {
  if (scope === 'apiKey' && identity.apiKeyId) return identity.apiKeyId;
  if (scope === 'user' && identity.userId) return identity.userId;
  return req.ip;
}

/**
 * Applies a shared token bucket to every request.
 *
 * ## Why `onRequest`
 *
 * The earliest hook in the lifecycle, before the body is parsed. Under the
 * traffic this exists to survive, parsing a megabyte of JSON only to reject
 * the request is the expensive half of the work done for nothing.
 *
 * ## Not `fastify-plugin`
 *
 * Hooks added inside a plugin are encapsulated to that scope, and the routes
 * live in child scopes created by `app.register(..., { prefix })`. Registering
 * on the parent before the routes means every child inherits them, with no
 * extra dependency. `registerIdempotency` works the same way and says the same
 * thing.
 */
export function registerRateLimit(app: FastifyInstance, options: RateLimitOptions = {}) {
  const limiter = options.limiter ?? rateLimiter;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // The opt-out is checked before anything else: a route that is never
    // limited should not pay for a signature verification to discover that.
    const configured = req.routeOptions.config?.rateLimit;
    if (configured === false) return;

    const identity = identify(app, req);

    if (identity.role === 'ADMIN') {
      // Support staff paging through every campaign on the platform looks
      // exactly like abuse, and an operator locked out mid-incident is worse
      // than an operator with no ceiling. Logged because an exemption nobody
      // can see is indistinguishable from a limiter that does not work, and
      // because a stolen admin token is now an unlimited one.
      logger.info(
        { userId: identity.userId, route: req.routeOptions.url },
        'Rate limit skipped for an admin'
      );
      return;
    }

    const [name, policy] = resolvePolicy(configured, req, identity);
    const key = bucketKey(name, policy.scope, subject(policy.scope, identity, req));

    let decision;
    try {
      decision = await limiter.consume(key, policy);
    } catch (err) {
      logger.error({ err, bucket: key }, 'Rate limiter unavailable');

      // The trade-off, made per policy rather than globally.
      //
      // For ordinary traffic, failing open is the right call: Redis being
      // unreachable would otherwise turn a dependency outage into a total
      // outage, and the thing being lost is a throughput guard. It is still a
      // security control being switched off by an infrastructure fault, which
      // is why it is logged at `error` and not swallowed.
      //
      // For auth endpoints the limit *is* the control. Losing it means
      // unlimited password guessing, and that is worse than telling people to
      // try logging in again shortly.
      if (policy.failOpen) return;

      reply.header('Retry-After', '1');
      throw Errors.unavailable('Rate limiting is unavailable; please retry');
    }

    reply.header('X-RateLimit-Limit', String(decision.limit));
    reply.header('X-RateLimit-Remaining', String(decision.remaining));
    reply.header('X-RateLimit-Reset', String(decision.resetSeconds));

    if (!decision.allowed) {
      // Without this a rejected client has nothing to do but retry at once,
      // and the limiter turns a burst into a sustained hammering.
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      throw Errors.rateLimited();
    }
  });
}

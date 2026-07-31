import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '@affiliate/shared';
import {
  bucketKey,
  consumeToken,
  TIERS,
  type RateLimitTier,
  type TierPolicy,
} from '../lib/rate-limiter';
import { KEY_HEADER } from '../lib/postback-signature';
import { AppError, Errors } from '../lib/errors';
import { logger } from '../lib/logger';

export interface RouteRateLimit {
  tier: RateLimitTier;
  /** Narrow a tier for one route. Widening it is what tiers are for. */
  perMinute?: number;
  burst?: number;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Which budget this route spends from. Absent means the plugin picks:
     * `authenticated` when the request carries a valid access token, `public`
     * otherwise. `false` opts the route out entirely.
     */
    rateLimit?: RouteRateLimit | false;
  }
}

/** What we could learn about the caller without touching the database. */
interface Caller {
  id: string;
  role: UserRole;
}

/**
 * Per-caller rate limiting.
 *
 * ```text
 *   postback      per API key   100/min  burst 200   fail open
 *   authenticated per user      300/min  burst 500   fail open
 *   auth          per IP         10/min  burst  15   fail CLOSED
 *   public        per IP         60/min  burst 100   fail open
 * ```
 *
 * ## Why `onRequest`
 *
 * The earliest hook that still knows which route was matched. Limiting after
 * `requireAuth` would mean an attacker's rejected request still costs two
 * database round-trips, so the throttle would protect nothing that is actually
 * scarce. It also means the caller is identified from the token's signature
 * alone, with no user lookup -- see `identify` for what that is and is not
 * worth.
 *
 * ## Why not `fastify-plugin`
 *
 * Same reason as `plugins/idempotency.ts`: hooks added inside an encapsulated
 * plugin do not reach the child scopes that `app.register(..., { prefix })`
 * creates. Registering on the parent before the routes means every child
 * inherits it.
 */
export function registerRateLimit(app: FastifyInstance) {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const routeConfig = req.routeOptions.config?.rateLimit;
    if (routeConfig === false) return;

    const caller = identify(app, req);

    if (caller?.role === 'ADMIN') {
      // Logged, not silent. An exemption from a security control that leaves
      // no trace is indistinguishable from the control not working, and the
      // first question after an incident is who was not being counted.
      logger.info(
        { userId: caller.id, method: req.method, url: req.url },
        'Rate limit exempted for admin'
      );
      return;
    }

    const { policy, tier, subject } = resolve(req, routeConfig, caller);
    const result = await consumeToken(bucketKey(tier, subject), policy);

    // On every response, not just the rejections. A client that can only find
    // out its budget by being refused has to be refused to find out.
    reply.header('X-RateLimit-Limit', String(result.limit));
    reply.header('X-RateLimit-Remaining', String(result.remaining));
    reply.header('X-RateLimit-Reset', String(result.resetSeconds));

    if (result.allowed) return;

    reply.header('Retry-After', String(result.retryAfterSeconds));

    if (result.degraded) {
      // Fail closed, and say which of the two it was. A 429 here would be a
      // lie -- this caller is inside its budget; we simply cannot prove it,
      // and on a credential endpoint that is not good enough.
      logger.error(
        { tier, subject, method: req.method, url: req.url },
        'Rejecting: the rate limiter is unavailable and this tier fails closed'
      );
      throw new AppError(
        503,
        'RATE_LIMITER_UNAVAILABLE',
        'Rate limiting is temporarily unavailable; please retry shortly'
      );
    }

    logger.warn(
      { tier, subject, method: req.method, url: req.url, retryAfterSeconds: result.retryAfterSeconds },
      'Rate limit exceeded'
    );
    throw Errors.rateLimited();
  });
}

/**
 * Picks the budget and the thing it is counted against.
 *
 * A route asking for a per-user budget but reached without a token has no
 * tenant to isolate, so it drops to the anonymous tier rather than handing an
 * unauthenticated caller a tenant-sized allowance keyed on its IP.
 */
function resolve(
  req: FastifyRequest,
  routeConfig: RouteRateLimit | undefined,
  caller: Caller | null
): { policy: TierPolicy; tier: RateLimitTier; subject: string } {
  let tier: RateLimitTier = routeConfig?.tier ?? (caller ? 'authenticated' : 'public');
  if (TIERS[tier].scope === 'user' && !caller) tier = 'public';

  const base = TIERS[tier];
  const policy: TierPolicy = {
    ...base,
    perMinute: routeConfig?.perMinute ?? base.perMinute,
    burst: routeConfig?.burst ?? base.burst,
  };

  return { policy, tier, subject: subjectFor(req, base.scope, caller) };
}

function subjectFor(
  req: FastifyRequest,
  scope: TierPolicy['scope'],
  caller: Caller | null
): string {
  if (scope === 'user' && caller) return `user:${caller.id}`;

  if (scope === 'apiKey') {
    const keyId = req.headers[KEY_HEADER];
    // Falling back to the IP rather than to a shared "unknown" bucket. One
    // bucket for every unsigned postback would let a single sender starve
    // every brand's genuine retries, which is the failure this tier exists to
    // prevent.
    if (typeof keyId === 'string' && keyId.length > 0) return `key:${keyId.slice(0, 128)}`;
  }

  return `ip:${req.ip}`;
}

interface AccessTokenClaims {
  id?: string;
  role?: UserRole;
}

/**
 * Reads the caller out of the access token's signature, with no database call.
 *
 * This is a *budgeting* decision, not an authorization one. `requireAuth` still
 * does the real check moments later -- token version, revoked family, user row
 * -- so a token that is signed but no longer valid gets counted under its own
 * id here and then rejected there. The only thing that buys such a token is its
 * own bucket, which is exactly what it should have.
 */
function identify(app: FastifyInstance, req: FastifyRequest): Caller | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;

  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;

  try {
    // `app.jwt.verify` rather than `req.jwtVerify`: the latter assigns the raw
    // payload to `req.user`, which is the property `requireAuth` fills with the
    // *database-checked* user. A route that forgot its guard would then see a
    // populated `req.user` and believe it.
    const claims = app.jwt.verify<AccessTokenClaims>(token);
    if (!claims.id || !claims.role) return null;
    return { id: claims.id, role: claims.role };
  } catch {
    // Expired, tampered with, or a refresh token presented as an access token.
    // Not our error to raise -- the caller is simply anonymous for counting,
    // and `requireAuth` will produce the 401 with the right message.
    return null;
  }
}

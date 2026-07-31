import type { FastifyInstance, FastifyRequest } from 'fastify';
import { loginSchema, refreshSchema, registerSchema } from '@affiliate/shared';
import { authService, type TokenContext } from '../services/auth.service';
import { requireAuth, type AuthedRequest } from '../lib/auth';

/**
 * Where a session was started from, recorded so a user can recognise their own
 * sessions in the list ("Chrome on Windows, yesterday") and spot one they do
 * not. The IP is hashed before storage -- it is there to tell sessions apart,
 * not to track anyone.
 */
function tokenContext(req: FastifyRequest): TokenContext {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

export async function authRoutes(app: FastifyInstance) {
  const svc = authService(app);

  /**
   * The two endpoints that accept a password.
   *
   * 10/min per IP with a burst of 15 is generous for someone mistyping their
   * password and hopeless for a script working through a word list. This is
   * also the only tier that fails *closed* when Redis is unreachable: on every
   * other route the limiter is a capacity guard and losing it costs headroom,
   * but here it is the brute-force control itself, and serving unlimited
   * guesses because a cache is down is not a trade to make quietly.
   */
  const credentialLimit = { config: { rateLimit: { tier: 'auth' } } } as const;

  app.post('/register', credentialLimit, async (req) => {
    const input = registerSchema.parse(req.body);
    return svc.register(input, tokenContext(req));
  });

  app.post('/login', credentialLimit, async (req) => {
    const input = loginSchema.parse(req.body);
    return svc.login(input, tokenContext(req));
  });

  /**
   * Deliberately *not* on the credential tier.
   *
   * A refresh token is a signed 256-bit value; nobody guesses one, and reuse
   * detection (BE-01) is the control that matters here. Failing closed would
   * mean a Redis outage logs every user out within one access-token lifetime
   * -- a large availability cost to defend against an attack the rate limit
   * was never what stopped.
   */
  app.post('/refresh', { config: { rateLimit: { tier: 'public' } } }, async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    // Returns a *new* refresh token every time. A client that keeps sending
    // the old one trips reuse detection and logs itself out -- correct
    // behaviour, and the easiest half of this feature to get wrong on the
    // client side.
    return svc.refresh(refreshToken, tokenContext(req));
  });

  app.post('/logout', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    await svc.logout(user.familyId);
    return { ok: true };
  });

  app.post('/logout-all', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    await svc.logoutAll(user.id);
    return { ok: true };
  });

  app.get('/sessions', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    return svc.listSessions(user.id, user.familyId);
  });

  app.post('/sessions/:id/revoke', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = (req as AuthedRequest).user;
    await svc.revokeSession(user.id, id);
    reply.code(204);
    return null;
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => {
    return (req as AuthedRequest).user;
  });
}

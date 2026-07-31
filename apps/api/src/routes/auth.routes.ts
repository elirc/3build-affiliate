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

  app.post('/register', async (req) => {
    const input = registerSchema.parse(req.body);
    return svc.register(input, tokenContext(req));
  });

  app.post('/login', async (req) => {
    const input = loginSchema.parse(req.body);
    return svc.login(input, tokenContext(req));
  });

  app.post('/refresh', async (req) => {
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

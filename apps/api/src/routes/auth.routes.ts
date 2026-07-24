import type { FastifyInstance } from 'fastify';
import { loginSchema, refreshSchema, registerSchema } from '@affiliate/shared';
import { authService } from '../services/auth.service';
import { requireAuth, type AuthedRequest } from '../lib/auth';

export async function authRoutes(app: FastifyInstance) {
  const svc = authService(app);

  app.post('/register', async (req) => {
    const input = registerSchema.parse(req.body);
    return svc.register(input);
  });

  app.post('/login', async (req) => {
    const input = loginSchema.parse(req.body);
    return svc.login(input);
  });

  app.post('/refresh', async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    return svc.refresh(refreshToken);
  });

  app.post('/logout', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    await svc.logout(user.id);
    return { ok: true };
  });

  app.get('/me', { preHandler: requireAuth }, async (req) => {
    return (req as AuthedRequest).user;
  });
}

import type { FastifyInstance } from 'fastify';
import {
  changeEmailSchema,
  changePasswordSchema,
  payoutSettingsSchema,
  updateProfileSchema,
} from '@affiliate/shared';
import { profileService } from '../services/profile.service';
import { requireAuth, requireRole, type AuthedRequest } from '../lib/auth';

export async function profileRoutes(app: FastifyInstance) {
  const svc = profileService();

  app.get('/me/profile', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    return svc.get(user.id);
  });

  app.patch('/me/profile', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    const input = updateProfileSchema.parse(req.body);
    return svc.update(user.id, user.role, input);
  });

  app.post('/me/password', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    const input = changePasswordSchema.parse(req.body);
    return svc.changePassword(user.id, input);
  });

  app.post('/me/email', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    const input = changeEmailSchema.parse(req.body);
    return svc.changeEmail(user.id, input);
  });

  // Only affiliates get paid, so only affiliates have payout details.
  app.put(
    '/me/payout-settings',
    { preHandler: [requireAuth, requireRole('AFFILIATE')] },
    async (req) => {
      const user = (req as AuthedRequest).user;
      const input = payoutSettingsSchema.parse(req.body);
      return svc.setPayoutSettings(user.id, input);
    }
  );
}

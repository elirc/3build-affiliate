import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NOTIFICATION_TYPES } from '@affiliate/shared';
import { notificationService } from '../services/notification.service';
import { requireAuth, type AuthedRequest } from '../lib/auth';
import { Errors } from '../lib/errors';

const markReadSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});

const preferenceSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  enabled: z.boolean(),
});

export async function notificationRoutes(app: FastifyInstance) {
  const svc = notificationService();

  app.get('/me/notifications', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    const { unreadOnly } = req.query as { unreadOnly?: string };
    const [items, unread] = await Promise.all([
      svc.listForUser(user.id, { unreadOnly: unreadOnly === 'true' }),
      svc.unreadCount(user.id),
    ]);
    return { items, unread };
  });

  app.post('/me/notifications/read', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    const { ids } = markReadSchema.parse(req.body);
    return svc.markRead(user.id, ids);
  });

  app.post('/me/notifications/read-all', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    return svc.markAllRead(user.id);
  });

  app.get('/me/notification-preferences', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    return svc.getPreferences(user.id);
  });

  app.put('/me/notification-preferences', { preHandler: requireAuth }, async (req) => {
    const user = (req as AuthedRequest).user;
    const { type, enabled } = preferenceSchema.parse(req.body);

    const result = await svc.setPreference(user.id, type, enabled);
    if (!result.ok) {
      // Refused rather than silently ignored: accepting this and then not
      // honouring it would leave someone believing they had opted out of
      // hearing that their payout failed.
      throw Errors.invalidRequest(
        'NOTIFICATION_MANDATORY',
        'This notification is about money moving and cannot be switched off.'
      );
    }
    return { ok: true };
  });
}

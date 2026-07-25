import type { Prisma, PrismaClient } from '@prisma/client';
import {
  isMandatoryNotification,
  type NotificationType,
} from '@affiliate/shared';
import { prisma } from '../config/prisma';
import { logger } from '../lib/logger';

/**
 * Notification delivery.
 *
 * Behind an interface with a console implementation. Adding an email vendor
 * for a feature that has no production traffic yet is cost without benefit;
 * the seam is what matters, and it means the worker's retry and idempotency
 * behaviour can be tested without a network at all.
 */
export interface NotificationDelivery {
  send(input: {
    id: string;
    userId: string;
    email: string;
    type: string;
    payload: unknown;
  }): Promise<void>;
}

export class ConsoleDelivery implements NotificationDelivery {
  async send(input: { id: string; email: string; type: string }) {
    logger.info(
      { notificationId: input.id, to: input.email, type: input.type },
      'Notification delivered (console driver)'
    );
  }
}

/** A transaction client, so callers can enqueue inside their own transaction. */
type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Writes a notification inside the caller's transaction.
 *
 * Taking `tx` rather than reaching for the global client is the entire point.
 * If the caller's transaction rolls back, this row goes with it -- there is no
 * window in which a notification exists for a state change that did not
 * happen, and no window in which a state change happened with no record that a
 * notification was owed.
 */
export async function enqueueNotification(
  tx: Tx,
  input: { userId: string; type: NotificationType; payload: Record<string, unknown> }
) {
  return tx.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      payload: input.payload as Prisma.InputJsonObject,
    },
  });
}

/** Retry backoff. Roughly 1m, 5m, 25m, 2h, 10h before giving up. */
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 60_000;

function nextAttemptDue(attempts: number, createdAt: Date): number {
  return createdAt.getTime() + BACKOFF_BASE_MS * Math.pow(5, attempts - 1);
}

export function notificationService(
  delivery: NotificationDelivery = new ConsoleDelivery()
) {
  return {
    async listForUser(userId: string, opts: { unreadOnly?: boolean } = {}) {
      return prisma.notification.findMany({
        where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    },

    async unreadCount(userId: string) {
      return prisma.notification.count({ where: { userId, readAt: null } });
    },

    async markRead(userId: string, ids: string[]) {
      // Scoped by userId as well as id: an id alone would let anyone mark
      // someone else's notifications read.
      const result = await prisma.notification.updateMany({
        where: { userId, id: { in: ids }, readAt: null },
        data: { readAt: new Date() },
      });
      return { marked: result.count };
    },

    async markAllRead(userId: string) {
      const result = await prisma.notification.updateMany({
        where: { userId, readAt: null },
        data: { readAt: new Date() },
      });
      return { marked: result.count };
    },

    async getPreferences(userId: string) {
      return prisma.notificationPreference.findMany({ where: { userId } });
    },

    /**
     * Mandatory types are refused rather than silently ignored. Accepting the
     * request and then not honouring it would leave someone believing they had
     * opted out of hearing that their payout failed.
     */
    async setPreference(userId: string, type: string, enabled: boolean) {
      if (!enabled && isMandatoryNotification(type)) {
        return { ok: false as const, reason: 'mandatory' as const };
      }

      await prisma.notificationPreference.upsert({
        where: { userId_type: { userId, type } },
        create: { userId, type, enabled },
        update: { enabled },
      });
      return { ok: true as const };
    },

    /**
     * Delivers one batch of pending notifications.
     *
     * Exported for the same reason the other workers' ticks are: a test runs
     * one pass and asserts, rather than starting an interval and hoping.
     */
    async deliverPending(now = new Date(), limit = 50) {
      const pending = await prisma.notification.findMany({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: limit,
        include: { user: { select: { email: true } } },
      });

      let sent = 0;
      let failed = 0;
      let skipped = 0;

      for (const n of pending) {
        // Backoff: a first attempt is due immediately, later ones wait.
        if (n.attempts > 0 && now.getTime() < nextAttemptDue(n.attempts, n.createdAt)) {
          continue;
        }

        // Preferences are checked at delivery, not at enqueue. Someone who
        // opts out after the event still should not receive it, and the row
        // stays as a record that it happened.
        if (!isMandatoryNotification(n.type)) {
          const pref = await prisma.notificationPreference.findUnique({
            where: { userId_type: { userId: n.userId, type: n.type } },
          });
          if (pref && !pref.enabled) {
            await prisma.notification.update({
              where: { id: n.id },
              data: { status: 'SENT', sentAt: now, lastError: 'Suppressed by preference' },
            });
            skipped += 1;
            continue;
          }
        }

        try {
          await delivery.send({
            id: n.id,
            userId: n.userId,
            email: n.user.email,
            type: n.type,
            payload: n.payload,
          });

          // Marked sent immediately after the send returns. A crash between
          // the two re-sends once on the next pass, which for a notification
          // is the right side to err on -- keyed on the id so a provider that
          // supports idempotency can suppress the duplicate.
          await prisma.notification.update({
            where: { id: n.id },
            data: { status: 'SENT', sentAt: new Date() },
          });
          sent += 1;
        } catch (err) {
          const attempts = n.attempts + 1;
          await prisma.notification.update({
            where: { id: n.id },
            data: {
              attempts,
              lastError: String(err),
              status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
            },
          });
          failed += 1;
        }
      }

      return { sent, failed, skipped };
    },
  };
}

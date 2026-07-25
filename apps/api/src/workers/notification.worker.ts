import { notificationService } from '../services/notification.service';
import { logger } from '../lib/logger';
import { beat } from '../lib/heartbeat';

export const WORKER_NAME = 'notification';
const TICK_MS = 10_000;

/**
 * Drains the notification outbox.
 *
 * A separate worker rather than sending inline, because delivery is slow and
 * fails for reasons that have nothing to do with the request that triggered
 * it. A payout must not fail because an email provider is down.
 */
export async function startNotificationWorker() {
  logger.info('Notification worker started');
  const svc = notificationService();

  const tick = async () => {
    try {
      const result = await svc.deliverPending();
      if (result.sent > 0 || result.failed > 0) {
        logger.info(result, 'Notifications processed');
      }
      await beat(WORKER_NAME, TICK_MS, { lastSent: result.sent });
    } catch (err) {
      logger.error({ err }, 'Notification delivery tick failed');
      await beat(WORKER_NAME, TICK_MS, { lastError: String(err) });
    }
  };

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'Notification worker tick threw'));
  }, TICK_MS);
}

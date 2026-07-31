import { notificationService } from '../services/notification.service';
import { logger } from '../lib/logger';
import { beat } from '../lib/heartbeat';
import { withLease } from '../lib/lease';

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
      // Under a lease: `deliverPending` claims a batch of rows and sends them.
      // Two instances doing that at once claim overlapping batches, and the
      // user gets every notification twice.
      //
      // The TTL is six ticks' worth. Delivery talks to a provider that can be
      // slow, and a job that outlives its lease is a job with no lock at all --
      // renewal covers the overrun, but the TTL should not be so tight that
      // renewal is the only thing standing between us and a split brain.
      const outcome = await withLease(WORKER_NAME, TICK_MS * 6, () => svc.deliverPending());

      if (!outcome.ran) {
        // Not an error: another instance is the leader this tick. Still a
        // beat, because this process is alive and doing the right thing.
        await beat(WORKER_NAME, TICK_MS, { skipped: 'lease held elsewhere' });
        return;
      }

      const result = outcome.value!;
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

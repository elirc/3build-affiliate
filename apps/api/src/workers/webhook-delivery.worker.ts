import { webhookService } from '../services/webhook.service';
import { logger } from '../lib/logger';
import { beat } from '../lib/heartbeat';
import { withLease } from '../lib/lease';

export const WORKER_NAME = 'webhook-delivery';
const TICK_MS = 5_000;

/**
 * Drains the outbound webhook queue.
 *
 * A worker rather than a POST inside the request that caused the event, for
 * the reason the notification worker exists: delivery is slow and fails for
 * reasons that have nothing to do with the request. A brand approving a
 * conversion must not wait five seconds because another brand's endpoint is
 * hanging, and must not see their approval fail because of it.
 */
export async function startWebhookDeliveryWorker() {
  logger.info('Webhook delivery worker started');
  const svc = webhookService();

  const tick = async () => {
    try {
      // Under a lease, like the notification worker and for the same reason:
      // this pass reads a set of rows and then acts on them, so two instances
      // claim overlapping batches and every subscriber gets each event twice.
      // Receivers are told to be idempotent, but "they will cope" is not a
      // reason to send it.
      //
      // The TTL allows for a pass in which every endpoint hangs: ten
      // concurrent slots working through fifty deliveries at five seconds each
      // is comfortably inside this, and renewal covers anything worse.
      const outcome = await withLease(WORKER_NAME, TICK_MS * 12, () => svc.deliverDue());

      if (!outcome.ran) {
        // Not an error: another instance is the leader this tick. Still a
        // beat, because this process is alive and doing the right thing.
        await beat(WORKER_NAME, TICK_MS, { skipped: 'lease held elsewhere' });
        return;
      }

      const result = outcome.value!;
      if (result.delivered > 0 || result.failed > 0) {
        logger.info(result, 'Webhook deliveries processed');
      }
      await beat(WORKER_NAME, TICK_MS, { lastDelivered: result.delivered });
    } catch (err) {
      logger.error({ err }, 'Webhook delivery tick failed');
      await beat(WORKER_NAME, TICK_MS, { lastError: String(err) });
    }
  };

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'Webhook delivery worker tick threw'));
  }, TICK_MS);
}

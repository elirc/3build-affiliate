import { prisma } from '../config/prisma';
import { logger } from '../lib/logger';

const TICK_MS = 60_000;
const BATCH = 200;

/**
 * Lock state machine:
 *   PENDING (conversion still in review by the brand)
 *     → LOCKED (conversion approved, but inside lockPeriodDays from occurredAt)
 *       → APPROVED (lock period elapsed, eligible for payout)
 *       → CLAWED_BACK (brand reversed the conversion — e.g. refund)
 *
 * We promote LOCKED → APPROVED in batches. CLAWED_BACK is handled inline
 * by the conversion-review service when a brand reverses an approval.
 *
 * If the conversion is still PENDING or REJECTED when the lock window
 * passes, we leave the commission alone; the brand still owes a decision.
 */
export async function startLockExpiryWorker() {
  logger.info('Lock-expiry worker started');

  const tick = async () => {
    try {
      const expired = await prisma.commission.findMany({
        where: { status: 'LOCKED', lockExpiresAt: { lte: new Date() } },
        take: BATCH,
        select: { id: true, conversionId: true },
      });
      if (expired.length === 0) return;

      const conversions = await prisma.conversion.findMany({
        where: { id: { in: expired.map((e) => e.conversionId) } },
        select: { id: true, status: true },
      });
      const approvedConvIds = new Set(
        conversions.filter((c) => c.status === 'APPROVED').map((c) => c.id)
      );

      const toApprove = expired
        .filter((e) => approvedConvIds.has(e.conversionId))
        .map((e) => e.id);

      if (toApprove.length === 0) return;

      const result = await prisma.commission.updateMany({
        where: { id: { in: toApprove } },
        data: { status: 'APPROVED', approvedAt: new Date() },
      });
      logger.info({ count: result.count }, 'Commissions promoted LOCKED → APPROVED');
    } catch (err) {
      logger.error({ err }, 'Lock-expiry tick failed');
    }
  };

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'Lock-expiry worker tick threw'));
  }, TICK_MS);

  // Run once at boot so a long-running dev session doesn't sit idle a minute
  tick().catch(() => {});
}

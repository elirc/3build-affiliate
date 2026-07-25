import { prisma } from '../config/prisma';
import { logger } from '../lib/logger';
import { beat } from '../lib/heartbeat';

export const WORKER_NAME = 'lock-expiry';
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
/**
 * One promotion pass.
 *
 * Takes `now` so a test can ask "what would happen 31 days from today?"
 * without touching the system clock or waiting. Defaults to the real clock in
 * production, where there is nothing to fake.
 */
export async function promoteExpiredLocks(
  now: Date = new Date()
): Promise<{ promoted: number }> {
  const expired = await prisma.commission.findMany({
    where: { status: 'LOCKED', lockExpiresAt: { lte: now } },
    take: BATCH,
    select: { id: true, conversionId: true },
  });
  if (expired.length === 0) return { promoted: 0 };

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

  if (toApprove.length === 0) return { promoted: 0 };

  const result = await prisma.commission.updateMany({
    where: { id: { in: toApprove } },
    data: { status: 'APPROVED', approvedAt: now },
  });
  return { promoted: result.count };
}

export async function startLockExpiryWorker() {
  logger.info('Lock-expiry worker started');

  const tick = async () => {
    try {
      const { promoted } = await promoteExpiredLocks();
      if (promoted > 0) {
        logger.info({ count: promoted }, 'Commissions promoted LOCKED → APPROVED');
      }
      await beat(WORKER_NAME, TICK_MS, { lastPromoted: promoted });
    } catch (err) {
      logger.error({ err }, 'Lock-expiry tick failed');
      await beat(WORKER_NAME, TICK_MS, { lastError: String(err) });
    }
  };

  setInterval(() => {
    tick().catch((err) => logger.error({ err }, 'Lock-expiry worker tick threw'));
  }, TICK_MS);

  // Run once at boot so a long-running dev session doesn't sit idle a minute
  tick().catch(() => {});
}

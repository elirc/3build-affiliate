import { prisma } from '../config/prisma';

const HIGH_RISK_THRESHOLD = 60;

interface ConversionContext {
  conversionId: string;
  affiliateId: string;
  campaignId: string;
  attributionCookieId?: string;
  clickTimestamps: number[];
  conversionTimestamp: number;
}

interface Signal {
  rule: string;
  score: number;
  detail: string;
}

/**
 * Pure rule-based fraud scoring (Phase-1 stand-in for an ML model).
 * Higher score = more suspicious. Each rule contributes 0–40.
 *
 * Rules:
 *  1. Click-to-convert latency < 5s → bot or stuffed cookie
 *  2. > 5 clicks from same IP hash in the attribution window → cookie stuffing
 *  3. Same attribution cookie has already triggered a conversion in the
 *     last 24h on this campaign → likely fraud or test traffic
 */
export function fraudService() {
  async function score(ctx: ConversionContext): Promise<{ total: number; signals: Signal[] }> {
    const signals: Signal[] = [];

    // Rule 1: click-to-convert latency
    if (ctx.clickTimestamps.length > 0) {
      const lastClick = Math.max(...ctx.clickTimestamps);
      const latencyMs = ctx.conversionTimestamp - lastClick;
      if (latencyMs < 5_000) {
        signals.push({
          rule: 'low_latency',
          score: 40,
          detail: `${latencyMs}ms between click and conversion`,
        });
      } else if (latencyMs < 60_000) {
        signals.push({
          rule: 'low_latency',
          score: 20,
          detail: `${(latencyMs / 1000).toFixed(0)}s between click and conversion`,
        });
      }
    }

    // Rule 2: IP repetition during the attribution window
    if (ctx.attributionCookieId) {
      const ipCounts = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT ce."ipHash")::bigint as count
        FROM "ClickEvent" ce
        JOIN "TrackingLink" tl ON tl.id = ce."trackingLinkId"
        WHERE tl."affiliateId" = ${ctx.affiliateId}
          AND tl."campaignId" = ${ctx.campaignId}
          AND ce."timestamp" >= NOW() - INTERVAL '24 hours'
      `;
      const uniqueIps = Number(ipCounts[0]?.count ?? 0);

      const clickCount = await prisma.clickEvent.count({
        where: {
          attributionCookieId: ctx.attributionCookieId,
          timestamp: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
        },
      });
      if (clickCount > 5 && uniqueIps <= 1) {
        signals.push({
          rule: 'cookie_ip_concentration',
          score: 30,
          detail: `${clickCount} clicks from ${uniqueIps} unique IP(s)`,
        });
      }
    }

    // Rule 3: duplicate conversion from same attribution cookie
    if (ctx.attributionCookieId) {
      const recent = await prisma.conversion.count({
        where: {
          campaignId: ctx.campaignId,
          createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
          clickEvent: { attributionCookieId: ctx.attributionCookieId },
          id: { not: ctx.conversionId },
        },
      });
      if (recent > 0) {
        signals.push({
          rule: 'duplicate_cookie',
          score: 30,
          detail: `Cookie already converted ${recent} time(s) today on this campaign`,
        });
      }
    }

    const total = Math.min(
      100,
      signals.reduce((s, x) => s + x.score, 0)
    );
    return { total, signals };
  }

  return {
    async evaluate(ctx: ConversionContext) {
      const { total, signals } = await score(ctx);
      if (signals.length === 0) return null;

      const review = await prisma.fraudReview.create({
        data: {
          conversionId: ctx.conversionId,
          riskScore: total,
          signals: signals as any,
          decision: total >= HIGH_RISK_THRESHOLD ? 'FLAGGED' : 'PENDING',
        },
      });
      return review;
    },

    HIGH_RISK_THRESHOLD,
  };
}
